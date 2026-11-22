'use strict';

const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const fs = require('fs');
const path = require('path');

const DEFAULT_MODEL = 'gemini-3.8-flash';
const DEFAULT_MAX_ATTEMPTS = 2;
const REQUEST_TIMEOUT_MS = 25000;
const BASE_BACKOFF_MS = [2000, 4000];
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const FALLBACK_TRIGGER_STATUS_CODES = new Set([429, 503]);

const DEFAULT_PROMPT_PATH = path.resolve(__dirname, '..', 'prompts', 'invoice_extraction_prompt.txt');
const DEFAULT_SCHEMA_PATH = path.resolve(__dirname, 'invoiceSchema.json');

/**
 * Lightweight .env loader without external dependencies.
 * Reads key=value pairs into process.env without overwriting existing env vars.
 * @param {string} [envPath]
 */
function loadEnvFile(envPath = path.resolve(__dirname, '..', '.env')) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeBackoffWithJitter(attemptIndex) {
  const baseMs = BASE_BACKOFF_MS[Math.min(attemptIndex, BASE_BACKOFF_MS.length - 1)];
  const jitterMs = Math.floor(Math.random() * 500);
  return baseMs + jitterMs;
}

/**
 * Calls Gemini REST API with exponential backoff + jitter on transient HTTP errors.
 * @returns {Promise<{ payload: object, latencyMs: number, retriesUsed: number }>}
 */
async function callModelWithRetry({
  model,
  apiKey,
  requestBody,
  maxAttempts,
  fetchImpl,
  sleepFn,
}) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let lastError = null;
  let lastStatus = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const startedAt = performance.now();
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      lastStatus = null;
      lastError = err instanceof Error ? err : new Error(String(err));
      lastError.isTimeout = isTimeout;
      if (!isTimeout || attempt === maxAttempts - 1) {
        lastError.retriesUsed = attempt;
        throw lastError;
      }
      const delayMs = computeBackoffWithJitter(attempt);
      await sleepFn(delayMs);
      continue;
    }
    const latencyMs = Math.round(performance.now() - startedAt);

    if (response.ok) {
      const payload = await response.json();
      return {
        payload,
        latencyMs,
        retriesUsed: attempt,
      };
    }

    lastStatus = response.status;
    const errorText = await response.text();
    lastError = new Error(`Gemini API HTTP ${response.status} (${model}): ${errorText.slice(0, 300)}`);
    lastError.status = response.status;
    lastError.isTimeout = false;

    const isRetryable = RETRYABLE_STATUS_CODES.has(response.status);
    if (!isRetryable || attempt === maxAttempts - 1) {
      lastError.retriesUsed = attempt;
      throw lastError;
    }

    const delayMs = computeBackoffWithJitter(attempt);
    await sleepFn(delayMs);
  }

  lastError.retriesUsed = maxAttempts - 1;
  lastError.status = lastStatus;
  throw lastError;
}

/**
 * Extracts structured invoice fields from a local PDF using the Gemini REST API
 * with automatic retry (exponential backoff + jitter) and optional model fallback.
 *
 * @param {string} pdfPath
 * @param {object} [options]
 * @param {string} [options.apiKey]
 * @param {string} [options.model]
 * @param {string} [options.fallbackModel]
 * @param {string} [options.promptPath]
 * @param {string} [options.schemaPath]
 * @param {number} [options.maxAttempts]
 * @param {Function} [options.fetchImpl]
 * @param {Function} [options.sleepFn]
 * @returns {Promise<{ extractedInvoice: object, latency_ms: number, token_usage: { promptTokenCount: number, candidatesTokenCount: number, totalTokenCount: number }, model: string, model_used: string, retry_count: number }>}
 */
async function extractInvoiceWithGemini(pdfPath, options = {}) {
  loadEnvFile();

  const apiKey = options.apiKey || process.env.GEMINI_API_KEY;
  const primaryModel = options.model || process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const fallbackModel = (options.fallbackModel ?? process.env.GEMINI_FALLBACK_MODEL ?? '').trim();
  const promptPath = options.promptPath || DEFAULT_PROMPT_PATH;
  const schemaPath = options.schemaPath || DEFAULT_SCHEMA_PATH;
  const maxAttempts = Number.isInteger(options.maxAttempts) && options.maxAttempts > 0
    ? options.maxAttempts
    : DEFAULT_MAX_ATTEMPTS;
  const fetchImpl = options.fetchImpl || fetch;
  const sleepFn = options.sleepFn || defaultSleep;

  if (!apiKey || apiKey === 'your_google_ai_studio_api_key_here') {
    throw new Error('GEMINI_API_KEY belum dikonfigurasi. Salin .env.example ke .env dan isi API key yang valid.');
  }

  if (!options.pdfBase64 && !fs.existsSync(pdfPath)) {
    throw new Error(`File PDF tidak ditemukan: ${pdfPath}`);
  }

  const systemPrompt = fs.readFileSync(promptPath, 'utf8').trim();
  const responseSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const pdfBase64 = options.pdfBase64
    ? String(options.pdfBase64).replace(/^data:application\/pdf;base64,/, '')
    : fs.readFileSync(pdfPath).toString('base64');

  const requestBody = {
    systemInstruction: {
      parts: [{ text: systemPrompt }],
    },
    contents: [
      {
        role: 'user',
        parts: [
          {
            inline_data: {
              mime_type: 'application/pdf',
              data: pdfBase64,
            },
          },
          {
            text: 'Ekstrak seluruh data faktur B2B dari dokumen PDF ini sesuai skema JSON dan aturan confidence_score.',
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema,
    },
  };

  let result;
  let modelUsed = primaryModel;
  let totalRetries = 0;

  try {
    result = await callModelWithRetry({
      model: primaryModel,
      apiKey,
      requestBody,
      maxAttempts,
      fetchImpl,
      sleepFn,
    });
    totalRetries = result.retriesUsed;
  } catch (primaryErr) {
    totalRetries = primaryErr.retriesUsed ?? 0;
    const shouldFallback =
      Boolean(fallbackModel) &&
      fallbackModel !== primaryModel &&
      (FALLBACK_TRIGGER_STATUS_CODES.has(primaryErr.status) || Boolean(primaryErr.isTimeout));

    if (!shouldFallback) {
      throw primaryErr;
    }

    const fallbackResult = await callModelWithRetry({
      model: fallbackModel,
      apiKey,
      requestBody,
      maxAttempts,
      fetchImpl,
      sleepFn,
    });
    result = fallbackResult;
    modelUsed = fallbackModel;
    totalRetries += 1 + fallbackResult.retriesUsed;
  }

  const rawJsonText = result.payload?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawJsonText) {
    throw new Error('Respons Gemini API tidak mengandung teks JSON pada candidates[0].content.parts[0].text.');
  }

  const extractedInvoice = JSON.parse(rawJsonText);
  const usage = result.payload.usageMetadata || {};

  return {
    extractedInvoice,
    latency_ms: result.latencyMs,
    token_usage: {
      promptTokenCount: Number(usage.promptTokenCount || 0),
      candidatesTokenCount: Number(usage.candidatesTokenCount || 0),
      totalTokenCount: Number(usage.totalTokenCount || 0),
    },
    model: modelUsed,
    model_used: modelUsed,
    retry_count: totalRetries,
  };
}

async function extractInvoiceFromPdf(input, options = {}) {
  if (typeof input === 'string') {
    return extractInvoiceWithGemini(input, options);
  }
  if (input && typeof input === 'object') {
    if (input.pdfPath) {
      return extractInvoiceWithGemini(input.pdfPath, options);
    }
    if (input.pdfBase64) {
      return extractInvoiceWithGemini('', { ...options, pdfBase64: input.pdfBase64 });
    }
  }
  throw new Error('Input extractInvoiceFromPdf harus berupa path file atau objek { pdfPath | pdfBase64 }.');
}

module.exports = {
  DEFAULT_MODEL,
  BASE_BACKOFF_MS,
  RETRYABLE_STATUS_CODES,
  loadEnvFile,
  extractInvoiceWithGemini,
  extractInvoiceFromPdf,
};
