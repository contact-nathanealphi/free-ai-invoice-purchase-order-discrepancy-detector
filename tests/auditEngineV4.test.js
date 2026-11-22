'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractPdfToMarkdown } = require('../src/pdfMarkdownExtractor');
const {
  CURATED_PROVIDERS,
  resolveProviderConfig,
  calculateProviderCost,
  extractStructuredDocument,
} = require('../src/aiProviderAdapter');
const { checkDailyDemoQuota } = require('../src/apiHelpers');
const { getDefaultSeedPurchaseOrders } = require('../src/dbRepository');
const { createLocalServer } = require('../src/localServer');
const sampleCache = require('../src/sampleCache.json');

test('Exacta v4.0 (Hybrid PDF-to-Markdown, 0-Token Sample Cache, 3-Provider BYOK)', async (t) => {
  await t.test('1. pdfMarkdownExtractor routes digital PDF to text_markdown and saves ~70-88% tokens', async () => {
    const sampleDigitalText = [
      'PT Graha Suplai Kantor',
      'INVOICE NO: INV/GSK/2026/001',
      'PO NO: PO-2026-004',
      '1. Kertas A4 80gsm (Box 5 Rim)    20    250.000    5.000.000',
      '2. Toner LaserJet Black Original    4    1.250.000    5.000.000',
      'Subtotal: 10.000.000 | PPN 11%: 1.100.000 | Grand Total: 11.100.000',
    ].join('\n');

    const res = await extractPdfToMarkdown({
      pdfBuffer: Buffer.alloc(60_000, 1),
      pdfParseImpl: async () => ({ text: sampleDigitalText, numpages: 1 }),
    });

    assert.equal(res.extraction_method, 'text_markdown');
    assert.ok(res.estimated_tokens_saved_pct >= 70 && res.estimated_tokens_saved_pct <= 88);
    assert.ok(res.extracted_markdown.includes('# Extracted PDF Document (1 page)'));
    assert.ok(res.extracted_markdown.includes(' | '));
  });

  await t.test('2. pdfMarkdownExtractor falls back to multimodal_vision on forceVision, empty scan, or parser error', async () => {
    const richText = 'Line 1\nLine 2\nLine 3\nLine 4\n' + 'A'.repeat(130);

    const forced = await extractPdfToMarkdown({
      pdfBuffer: Buffer.from('dummy-pdf'),
      forceVision: true,
      pdfParseImpl: async () => ({ text: richText, numpages: 1 }),
    });
    assert.equal(forced.extraction_method, 'multimodal_vision');
    assert.equal(forced.estimated_tokens_saved_pct, 0);

    const scanned = await extractPdfToMarkdown({
      pdfBuffer: Buffer.from('dummy-pdf'),
      pdfParseImpl: async () => ({ text: 'Scan', numpages: 2 }),
    });
    assert.equal(scanned.extraction_method, 'multimodal_vision');

    const errored = await extractPdfToMarkdown({
      pdfBuffer: Buffer.from('corrupted'),
      pdfParseImpl: async () => { throw new Error('Corrupted PDF'); },
    });
    assert.equal(errored.extraction_method, 'multimodal_vision');
  });

  await t.test('3. aiProviderAdapter exposes 3 curated providers, resolves BYOK headers, and extracts PO/Invoice JSON', async () => {
    assert.deepEqual(Object.keys(CURATED_PROVIDERS), ['gemini', 'openai', 'anthropic']);
    assert.ok(CURATED_PROVIDERS.gemini.models.some((m) => m.id === 'gemini-2.5-flash'));
    assert.ok(CURATED_PROVIDERS.openai.models.some((m) => m.id === 'gpt-4o-mini'));
    assert.ok(CURATED_PROVIDERS.anthropic.models.some((m) => m.id === 'claude-3-5-haiku-latest'));

    const cfg = resolveProviderConfig({
      'x-ai-provider': 'openai',
      'x-ai-model': 'gpt-4o-mini',
      'x-ai-api-key': 'sk-test-byok-key',
    });
    assert.equal(cfg.isByok, true);
    assert.equal(cfg.provider, 'openai');
    assert.equal(cfg.model, 'gpt-4o-mini');

    const cost = calculateProviderCost('gemini', 'gemini-2.5-flash', {
      promptTokenCount: 1000,
      candidatesTokenCount: 500,
    });
    assert.ok(cost.estimated_cost_usd > 0);
    assert.ok(cost.estimated_cost_idr > 0);

    // Mock OpenAI PO extraction
    const mockOpenAiFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                po_number: 'PO-2026-777',
                vendor_name: 'PT Mock Vendor',
                po_type: 'GOODS',
                currency: 'IDR',
                line_items: [{ sku: 'SKU-1', item_name: 'Laptop Pro', qty_ordered: 2, unit_price: 15000000, line_total: 30000000 }],
                subtotal: 30000000,
                tax_amount: 3300000,
                total_amount: 33300000,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 400, completion_tokens: 150, total_tokens: 550 },
      }),
    });

    const poRes = await extractStructuredDocument({
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test',
      extractionMethod: 'text_markdown',
      markdownText: '# PO-2026-777',
      documentType: 'purchase_order',
      fetchImpl: mockOpenAiFetch,
    });
    assert.equal(poRes.data.po_number, 'PO-2026-777');
    assert.equal(poRes.provider, 'openai');
    assert.equal(poRes.token_usage.totalTokenCount, 550);
  });

  await t.test('4. checkDailyDemoQuota enforces 2 custom uploads/day per IP', () => {
    const store = new Map();
    const ip = '203.0.113.10';
    assert.equal(checkDailyDemoQuota(ip, store, 2).allowed, true);
    assert.equal(checkDailyDemoQuota(ip, store, 2).allowed, true);
    const third = checkDailyDemoQuota(ip, store, 2);
    assert.equal(third.allowed, false);
    assert.equal(third.remaining, 0);
  });

  await t.test('5. All 8 sampleCache scenarios execute at 0 server tokens via stateless POST /api/audit', async () => {
    const server = createLocalServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    const seedPOs = getDefaultSeedPurchaseOrders();

    const expectedStatuses = {
      normal: 'APPROVED',
      sneaky_fee: 'HOLD - UNORDERED ITEM',
      pph23_service: 'APPROVED',
      partial_delivery: 'APPROVED - PARTIAL',
      prompt_injection: 'HOLD - PRICE VARIANCE',
      currency_mismatch: 'HOLD - CURRENCY MISMATCH',
      multipage_noisy: 'HUMAN REVIEW',
      tax_error: 'HOLD - TAX ERROR',
    };

    try {
      const wsRes = await fetch(`${baseUrl}/workspaceStore.js`);
      assert.equal(wsRes.status, 200);

      for (const [sampleId, expectedStatus] of Object.entries(expectedStatuses)) {
        assert.ok(sampleCache[sampleId], `Missing sampleCache entry: ${sampleId}`);
        const res = await fetch(`${baseUrl}/api/audit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sampleId,
            purchaseOrders: seedPOs,
            auditLogs: [],
          }),
        });
        assert.equal(res.status, 200);
        const json = await res.json();
        assert.equal(json.ok, true);
        assert.equal(json.audit_log.model_used, 'sample-cache-0-token');
        assert.equal(json.audit_log.cost_idr, 0);
        assert.equal(json.audit_log.audit_status, expectedStatus, `Mismatch for ${sampleId}`);
      }

      const badExtractPo = await fetch(`${baseUrl}/api/extract-po`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(badExtractPo.status, 400);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
