'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { extractInvoiceWithGemini } = require('../src/geminiExtractor');

const SAMPLE_PDF_PATH = path.resolve(
  __dirname,
  '..',
  'test_data',
  'invoices',
  'INV_01_normal_nusantara.pdf'
);

const SAMPLE_EXTRACTED_PAYLOAD = {
  invoice_number: 'INV/NL/2026/001',
  po_number: 'PO-2026-001',
  vendor_name: 'PT Nusantara Logistik',
  item_name: 'Jasa Pengiriman',
  qty: 4,
  unit_price: 4500000,
  subtotal: 18000000,
  tax_amount: 1980000,
  grand_total: 19980000,
  confidence_score: 0.98,
  extraction_notes: 'Dokumen terbaca jelas',
};

function makeSuccessResponse(data) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify(data) }],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 120,
          candidatesTokenCount: 60,
          totalTokenCount: 180,
        },
      };
    },
  };
}

function makeErrorResponse(status, message) {
  return {
    ok: false,
    status,
    async text() {
      return message;
    },
  };
}

describe('Gemini Extractor Resilience (Retry & Model Fallback)', () => {
  it('1. Retries automatically on HTTP 503 with exponential backoff and succeeds', async () => {
    const calledUrls = [];
    const sleepDelays = [];
    let attempt = 0;

    const mockFetch = async (url, init) => {
      calledUrls.push(url);
      assert.ok(init.signal instanceof AbortSignal);
      attempt += 1;
      if (attempt === 1) {
        return makeErrorResponse(503, 'Service Unavailable - High Demand');
      }
      return makeSuccessResponse(SAMPLE_EXTRACTED_PAYLOAD);
    };

    const result = await extractInvoiceWithGemini(SAMPLE_PDF_PATH, {
      apiKey: 'test-dummy-key',
      model: 'gemini-3.8-flash',
      fallbackModel: '',
      fetchImpl: mockFetch,
      sleepFn: async (ms) => {
        sleepDelays.push(ms);
      },
    });

    assert.equal(attempt, 2);
    assert.equal(sleepDelays.length, 1);
    assert.ok(sleepDelays[0] >= 2000 && sleepDelays[0] < 2500);
    assert.equal(result.model_used, 'gemini-3.8-flash');
    assert.equal(result.retry_count, 1);
    assert.equal(result.extractedInvoice.invoice_number, 'INV/NL/2026/001');
    assert.ok(calledUrls.every((u) => u.includes('gemini-3.8-flash')));
  });

  it('2. Falls back to GEMINI_FALLBACK_MODEL when primary model exhausts retries with 503/429', async () => {
    const calledUrls = [];
    const sleepDelays = [];

    const mockFetch = async (url) => {
      calledUrls.push(url);
      if (url.includes('gemini-3.8-flash:')) {
        return makeErrorResponse(429, 'Rate limit exceeded');
      }
      return makeSuccessResponse(SAMPLE_EXTRACTED_PAYLOAD);
    };

    const result = await extractInvoiceWithGemini(SAMPLE_PDF_PATH, {
      apiKey: 'test-dummy-key',
      model: 'gemini-3.8-flash',
      fallbackModel: 'gemini-3.8-flash-lite',
      fetchImpl: mockFetch,
      sleepFn: async (ms) => {
        sleepDelays.push(ms);
      },
    });

    assert.equal(calledUrls.length, 3);
    assert.equal(calledUrls.filter((u) => u.includes('gemini-3.8-flash:')).length, 2);
    assert.equal(calledUrls.filter((u) => u.includes('gemini-3.8-flash-lite:')).length, 1);
    assert.equal(sleepDelays.length, 1);
    assert.equal(result.model_used, 'gemini-3.8-flash-lite');
    assert.equal(result.retry_count, 2);
    assert.equal(result.extractedInvoice.po_number, 'PO-2026-001');
  });

  it('3. Treats TimeoutError as retryable and falls back to GEMINI_FALLBACK_MODEL', async () => {
    const calledUrls = [];
    const sleepDelays = [];

    const mockFetch = async (url) => {
      calledUrls.push(url);
      if (url.includes('gemini-3.8-flash:')) {
        const timeoutErr = new Error('The operation was aborted due to timeout');
        timeoutErr.name = 'TimeoutError';
        throw timeoutErr;
      }
      return makeSuccessResponse(SAMPLE_EXTRACTED_PAYLOAD);
    };

    const result = await extractInvoiceWithGemini(SAMPLE_PDF_PATH, {
      apiKey: 'test-dummy-key',
      model: 'gemini-3.8-flash',
      fallbackModel: 'gemini-3.8-flash-lite',
      fetchImpl: mockFetch,
      sleepFn: async (ms) => {
        sleepDelays.push(ms);
      },
    });

    assert.equal(calledUrls.filter((u) => u.includes('gemini-3.8-flash:')).length, 2);
    assert.equal(calledUrls.filter((u) => u.includes('gemini-3.8-flash-lite:')).length, 1);
    assert.equal(sleepDelays.length, 1);
    assert.equal(result.model_used, 'gemini-3.8-flash-lite');
    assert.equal(result.retry_count, 2);
  });
});
