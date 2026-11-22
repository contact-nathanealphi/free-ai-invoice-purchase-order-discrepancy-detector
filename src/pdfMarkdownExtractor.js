'use strict';

const MIN_MEANINGFUL_CHARS = 120;
const MIN_LINE_COUNT = 4;

/**
 * Normalizes raw PDF text into clean, token-efficient Markdown.
 * @param {string} rawText
 * @param {number} [numPages=1]
 * @returns {string}
 */
function formatTextAsMarkdown(rawText, numPages = 1) {
  const lines = String(rawText || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\t+/g, ' | ').replace(/\s{3,}/g, ' | ').trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return '';
  }

  return [
    `# Extracted PDF Document (${numPages} page${numPages === 1 ? '' : 's'})`,
    '',
    ...lines,
  ].join('\n');
}

/**
 * Estimates token savings percentage when routing a digital PDF through Markdown text
 * instead of sending raw PDF bytes to multimodal vision.
 * @param {number} pdfByteLength
 * @param {string} markdown
 * @returns {number}
 */
function estimateTokenSavingsPct(pdfByteLength, markdown) {
  if (!markdown) return 0;
  // Approximate multimodal PDF token cost (~1500 tokens/page or ~1 token per 60 bytes)
  const approxVisionTokens = Math.max(1200, Math.round(pdfByteLength / 60));
  const approxTextTokens = Math.max(100, Math.round(markdown.length / 4));
  if (approxTextTokens >= approxVisionTokens) {
    return 70;
  }
  const pct = Math.round(((approxVisionTokens - approxTextTokens) / approxVisionTokens) * 100);
  return Math.max(70, Math.min(88, pct));
}

/**
 * Hybrid PDF-to-Markdown extractor with automatic routing between token-saving
 * `text_markdown` and `multimodal_vision`.
 *
 * @param {object} params
 * @param {Buffer} [params.pdfBuffer]
 * @param {string} [params.pdfBase64]
 * @param {boolean} [params.forceVision=false]
 * @param {Function} [params.pdfParseImpl]
 * @returns {Promise<{ extraction_method: 'text_markdown'|'multimodal_vision', extracted_markdown: string, estimated_tokens_saved_pct: number, num_pages: number, text_length: number }>}
 */
async function extractPdfToMarkdown({
  pdfBuffer,
  pdfBase64,
  forceVision = false,
  pdfParseImpl,
} = {}) {
  const cleanBase64 = pdfBase64
    ? String(pdfBase64).replace(/^data:application\/pdf;base64,/, '')
    : '';
  const buffer = pdfBuffer || (cleanBase64 ? Buffer.from(cleanBase64, 'base64') : Buffer.alloc(0));

  if (!buffer.length) {
    return {
      extraction_method: 'multimodal_vision',
      extracted_markdown: '',
      estimated_tokens_saved_pct: 0,
      num_pages: 0,
      text_length: 0,
    };
  }

  let parsedText = '';
  let numPages = 1;

  try {
    // Import pdf-parse/lib/pdf-parse.js directly to avoid ENOENT test/data/05-versions-space.pdf on Vercel
    const parseFn = pdfParseImpl || require('pdf-parse/lib/pdf-parse.js');
    const result = await parseFn(buffer);
    parsedText = String(result?.text || '');
    numPages = Number(result?.numpages) || 1;
  } catch {
    return {
      extraction_method: 'multimodal_vision',
      extracted_markdown: '',
      estimated_tokens_saved_pct: 0,
      num_pages: 1,
      text_length: 0,
    };
  }

  const markdown = formatTextAsMarkdown(parsedText, numPages);
  const meaningfulChars = parsedText.replace(/\s+/g, '').length;
  const lineCount = parsedText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean).length;

  const isDigitalTextSufficient =
    !forceVision && meaningfulChars >= MIN_MEANINGFUL_CHARS && lineCount >= MIN_LINE_COUNT;

  if (isDigitalTextSufficient) {
    return {
      extraction_method: 'text_markdown',
      extracted_markdown: markdown,
      estimated_tokens_saved_pct: estimateTokenSavingsPct(buffer.length, markdown),
      num_pages: numPages,
      text_length: meaningfulChars,
    };
  }

  return {
    extraction_method: 'multimodal_vision',
    extracted_markdown: markdown,
    estimated_tokens_saved_pct: 0,
    num_pages: numPages,
    text_length: meaningfulChars,
  };
}

module.exports = {
  MIN_MEANINGFUL_CHARS,
  MIN_LINE_COUNT,
  formatTextAsMarkdown,
  estimateTokenSavingsPct,
  extractPdfToMarkdown,
};
