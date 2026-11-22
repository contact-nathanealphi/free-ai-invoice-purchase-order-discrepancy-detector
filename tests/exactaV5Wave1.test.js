'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { runForensicAnalysis, levenshteinDistance } = require('../src/forensicEngine');
const {
  validateSupportedMimeType,
  extractStructuredDocument,
} = require('../src/aiProviderAdapter');
const { parsePurchaseOrdersCsv, generateSamplePoCsv } = require('../public/workspaceStore');
const { createLocalServer } = require('../src/localServer');

test('Exacta v5.0 Forensic: detects Split-Invoicing within 7 days exceeding Rp25M threshold', () => {
  const existingLogs = [
    {
      id: 'log-1',
      invoice_number: 'INV-SPLIT-01',
      vendor_name: 'PT Sumber Makmur',
      currency: 'IDR',
      grand_total: 18_000_000,
      created_at: '2026-11-18T10:00:00Z',
      extraction_data: { invoice_date: '2026-11-18', line_items: [] },
    },
  ];

  const currentInvoice = {
    invoice_number: 'INV-SPLIT-02',
    vendor_name: 'PT Sumber Makmur',
    currency: 'IDR',
    grand_total: 19_000_000,
    invoice_date: '2026-11-20',
    line_items: [],
  };

  const result = runForensicAnalysis(currentInvoice, existingLogs, []);
  const codes = result.forensic_signals.map((s) => s.code);
  assert.ok(codes.includes('FORENSIC_SPLIT_INVOICING'));
  assert.ok(result.forensic_risk_score >= 38);
});

test('Exacta v5.0 Forensic: detects Vendor Price-Creep > 3% above historical median', () => {
  const existingLogs = [
    {
      id: 'log-pc-1',
      invoice_number: 'INV-OLD-01',
      vendor_name: 'CV Kertas Prima',
      currency: 'IDR',
      grand_total: 10_000_000,
      extraction_data: {
        invoice_date: '2026-10-01',
        line_items: [{ sku: 'KRT-A4', item_name: 'Kertas A4 80gr', qty: 100, unit_price: 50_000 }],
      },
    },
  ];

  const currentInvoice = {
    invoice_number: 'INV-NEW-01',
    vendor_name: 'CV Kertas Prima',
    currency: 'IDR',
    grand_total: 5_550_000,
    invoice_date: '2026-11-20',
    line_items: [{ sku: 'KRT-A4', item_name: 'Kertas A4 80gr', qty: 100, unit_price: 55_000 }],
  };

  const result = runForensicAnalysis(currentInvoice, existingLogs, []);
  assert.ok(result.forensic_signals.some((s) => s.code === 'FORENSIC_PRICE_CREEP'));
});

test('Exacta v5.0 Forensic: detects Fuzzy Duplicate Trap (Levenshtein <= 2, ±1% total, ±14 days)', () => {
  assert.equal(levenshteinDistance('INV104', 'INV104A'), 1);

  const existingLogs = [
    {
      id: 'log-dup-1',
      invoice_number: 'INV-104',
      vendor_name: 'PT Logistik Jaya',
      currency: 'IDR',
      grand_total: 12_500_000,
      extraction_data: { invoice_date: '2026-11-10', line_items: [] },
    },
  ];

  const currentInvoice = {
    invoice_number: 'INV-104A',
    vendor_name: 'PT Logistik Jaya',
    currency: 'IDR',
    grand_total: 12_500_000,
    invoice_date: '2026-11-16',
    line_items: [],
  };

  const result = runForensicAnalysis(currentInvoice, existingLogs, []);
  assert.ok(result.forensic_signals.some((s) => s.code === 'FORENSIC_FUZZY_DUPLICATE'));
  assert.equal(result.forensic_level, 'WATCH');
});

test('Exacta v5.0 Forensic: detects Backdated Invoice, Weekend Issue & Repeated Round-Number', () => {
  const existingLogs = [
    {
      id: 'log-rnd-1',
      invoice_number: 'INV-RND-01',
      vendor_name: 'PT Konsultan Abadi',
      currency: 'IDR',
      grand_total: 10_000_000,
      extraction_data: { invoice_date: '2026-10-01', line_items: [] },
    },
  ];

  const poList = [
    {
      po_number: 'PO-2026-777',
      vendor_name: 'PT Konsultan Abadi',
      po_date: '2026-11-15',
      currency: 'IDR',
    },
  ];

  // 2026-11-08 is a Sunday and precedes PO date 2026-11-15, and 15,000,000 is round
  const currentInvoice = {
    invoice_number: 'INV-RND-02',
    po_number: 'PO-2026-777',
    vendor_name: 'PT Konsultan Abadi',
    currency: 'IDR',
    grand_total: 15_000_000,
    invoice_date: '2026-11-08',
    line_items: [],
  };

  const result = runForensicAnalysis(currentInvoice, existingLogs, poList, poList[0]);
  const codes = result.forensic_signals.map((s) => s.code);
  assert.ok(codes.includes('FORENSIC_BACKDATED_INVOICE'));
  assert.ok(codes.includes('FORENSIC_WEEKEND_ISSUE'));
  assert.ok(codes.includes('FORENSIC_ROUND_NUMBER_PATTERN'));
  assert.equal(result.forensic_level, 'HIGH_RISK');
});

test('Exacta v5.0 Multi-Format Intake: validates MIME types & supports raw_text + image/png', async () => {
  assert.equal(validateSupportedMimeType('image/jpeg'), 'image/jpeg');
  assert.equal(validateSupportedMimeType('image/png'), 'image/png');
  assert.equal(validateSupportedMimeType('image/webp'), 'image/webp');
  assert.equal(validateSupportedMimeType('application/pdf'), 'application/pdf');
  assert.throws(() => validateSupportedMimeType('text/html'), /Unsupported document MIME type/);

  let capturedBody = null;
  const mockFetch = async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    invoice_number: 'INV-WA-01',
                    po_number: 'PO-2026-001',
                    vendor_name: 'PT Kemasan Nusantara',
                    currency: 'IDR',
                    grand_total: 1110000,
                  }),
                },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 40, totalTokenCount: 160 },
      }),
    };
  };

  const rawTextRes = await extractStructuredDocument({
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    apiKey: 'fake-key',
    extractionMethod: 'raw_text',
    markdownText: 'Invoice INV-WA-01 PO-2026-001 Total Rp1.110.000',
    documentType: 'invoice',
    fetchImpl: mockFetch,
  });
  assert.equal(rawTextRes.data.invoice_number, 'INV-WA-01');
  assert.ok(capturedBody.contents[0].parts[0].text.includes('INV-WA-01'));

  const imgRes = await extractStructuredDocument({
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    apiKey: 'fake-key',
    extractionMethod: 'multimodal_vision',
    pdfBase64: 'ZmFrZS1pbWFnZQ==',
    mimeType: 'image/png',
    documentType: 'invoice',
    fetchImpl: mockFetch,
  });
  assert.equal(imgRes.data.invoice_number, 'INV-WA-01');
  assert.equal(capturedBody.contents[0].parts[0].inline_data.mime_type, 'image/png');
});

test('Exacta v5.0 CSV Bulk PO Parser: groups multi-item POs & supports semicolon delimiters', () => {
  const sampleCsv = generateSamplePoCsv();
  const parsed = parsePurchaseOrdersCsv(sampleCsv);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].po_number, 'PO-2026-901');
  assert.equal(parsed[0].items.length, 2);
  assert.equal(parsed[1].po_type, 'SERVICE');

  const semiCsv = [
    'po_number;vendor_name;currency;description;qty_ordered;unit_price',
    'PO-SEMI-01;PT Maju;USD;Cloud Node;3;450',
  ].join('\n');
  const parsedSemi = parsePurchaseOrdersCsv(semiCsv);
  assert.equal(parsedSemi.length, 1);
  assert.equal(parsedSemi[0].items[0].unit_price, 450);
});

test('Exacta v5.0 HTTP Audit Endpoint: attaches forensic fields & rejects unsupported MIME', async () => {
  const server = createLocalServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const sampleResp = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/audit',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
        }
      );
      req.on('error', reject);
      req.write(JSON.stringify({ sampleId: 'normal' }));
      req.end();
    });

    assert.equal(sampleResp.status, 200);
    assert.ok(Array.isArray(sampleResp.body.forensic_signals));
    assert.equal(typeof sampleResp.body.forensic_risk_score, 'number');
    assert.ok(['CLEAN', 'WATCH', 'HIGH_RISK'].includes(sampleResp.body.forensic_level));

    const badMimeResp = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/audit',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
        }
      );
      req.on('error', reject);
      req.write(JSON.stringify({ fileName: 'bad.html', fileBase64: 'PGh0bWw+', mimeType: 'text/html' }));
      req.end();
    });

    assert.equal(badMimeResp.status, 400);
    assert.match(badMimeResp.body.error, /Unsupported document MIME type/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
