'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { auditInvoice } = require('../src/auditEngine');
const { generateDisputePack } = require('../public/disputeGenerator');
const { generateAccountingCsv } = require('../public/accountingExporter');
const { extractStructuredDocument } = require('../src/aiProviderAdapter');
const { createLocalServer } = require('../src/localServer');

test('Security & Financial Hardening Regression Suite', async (t) => {
  await t.test('1. Blocks partial delivery over-billing (> remaining_qty) and cumulative GRN over-billing', () => {
    const partialPo = [
      {
        po_number: 'PO-2026-005',
        vendor_name: 'PT Sentra Komponen Elektronik',
        po_type: 'GOODS',
        currency: 'IDR',
        status: 'OPEN',
        item_name: 'Barcode Scanner Wireless 2D',
        qty: 10,
        remaining_qty: 4,
        grn_received_qty: 10,
        unit_price: 1_500_000,
      },
    ];

    const secondPartialOverPo = {
      invoice_number: 'INV/SKE/2026/052',
      po_number: 'PO-2026-005',
      vendor_name: 'PT Sentra Komponen Elektronik',
      currency: 'IDR',
      line_items: [
        { item_name: 'Barcode Scanner Wireless 2D', qty: 6, unit_price: 1_500_000, line_total: 9_000_000 },
      ],
      subtotal: 9_000_000,
      ppn_amount: 990_000,
      pph23_amount: 0,
      grand_total: 9_990_000,
      confidence_score: 0.98,
    };

    const resOverRem = auditInvoice(secondPartialOverPo, partialPo, []);
    assert.equal(resOverRem.audit_status, 'HOLD - PRICE VARIANCE');
    assert.equal(resOverRem.requires_human_review, true);
    assert.match(resOverRem.discrepancy_reason, /sisa PO 4/);

    // Also test cumulative GRN exceedance via prior approved logs (when remaining_qty isn't pre-subtracted)
    const grnLimitedPo = [
      {
        po_number: 'PO-2026-505',
        vendor_name: 'PT Sentra Komponen Elektronik',
        po_type: 'GOODS',
        currency: 'IDR',
        status: 'OPEN',
        item_name: 'Barcode Scanner Wireless 2D',
        qty: 10,
        grn_received_qty: 6,
        unit_price: 1_500_000,
      },
    ];
    const priorApprovedLogs = [
      {
        invoice_number: 'INV/SKE/2026/051',
        po_number: 'PO-2026-505',
        vendor_name: 'PT Sentra Komponen Elektronik',
        audit_status: 'APPROVED - PARTIAL',
        extraction_data: {
          line_items: [{ item_name: 'Barcode Scanner Wireless 2D', qty: 4, unit_price: 1_500_000 }],
        },
      },
    ];
    const secondOverGrn = {
      ...secondPartialOverPo,
      invoice_number: 'INV/SKE/2026/053',
      po_number: 'PO-2026-505',
      line_items: [
        { item_name: 'Barcode Scanner Wireless 2D', qty: 4, unit_price: 1_500_000, line_total: 6_000_000 },
      ],
      subtotal: 6_000_000,
      ppn_amount: 660_000,
      grand_total: 6_660_000,
    };
    const resOverGrn = auditInvoice(secondOverGrn, grnLimitedPo, priorApprovedLogs);
    assert.equal(resOverGrn.audit_status, 'HOLD - GRN MISMATCH');
    assert.match(resOverGrn.discrepancy_reason, /akumulasi qty tertagih 8/);
  });

  await t.test('2. Caps autoApproveCeiling at <=5% price variance and blocks over-qty', () => {
    const poRows = [
      {
        po_number: 'PO-2026-810',
        vendor_name: 'PT Logam Mulia',
        po_type: 'GOODS',
        currency: 'IDR',
        status: 'OPEN',
        item_name: 'Steel Plate',
        qty: 10,
        unit_price: 100_000,
      },
    ];

    // +20% markup under high ceiling MUST still fail
    const markup20Pct = {
      invoice_number: 'INV-CEIL-20',
      po_number: 'PO-2026-810',
      vendor_name: 'PT Logam Mulia',
      currency: 'IDR',
      line_items: [{ item_name: 'Steel Plate', qty: 10, unit_price: 120_000, line_total: 1_200_000 }],
      subtotal: 1_200_000,
      ppn_amount: 132_000,
      pph23_amount: 0,
      grand_total: 1_332_000,
      confidence_score: 0.98,
    };
    const blockedMarkup = auditInvoice(markup20Pct, poRows, [], {
      policyConfig: { autoApproveCeiling: 5_000_000 },
    });
    assert.equal(blockedMarkup.audit_status, 'HOLD - PRICE VARIANCE');

    // Over-qty under high ceiling MUST still fail
    const overQty = {
      invoice_number: 'INV-CEIL-QTY',
      po_number: 'PO-2026-810',
      vendor_name: 'PT Logam Mulia',
      currency: 'IDR',
      line_items: [{ item_name: 'Steel Plate', qty: 11, unit_price: 100_000, line_total: 1_100_000 }],
      subtotal: 1_100_000,
      ppn_amount: 121_000,
      pph23_amount: 0,
      grand_total: 1_221_000,
      confidence_score: 0.98,
    };
    const blockedOverQty = auditInvoice(overQty, poRows, [], {
      policyConfig: { autoApproveCeiling: 5_000_000 },
    });
    assert.equal(blockedOverQty.audit_status, 'HOLD - PRICE VARIANCE');

    // Minor <=5% (+3%) variance within ceiling IS approved and leaves policy_override_note
    const minorMarkup = {
      invoice_number: 'INV-CEIL-3',
      po_number: 'PO-2026-810',
      vendor_name: 'PT Logam Mulia',
      currency: 'IDR',
      line_items: [{ item_name: 'Steel Plate', qty: 10, unit_price: 103_000, line_total: 1_030_000 }],
      subtotal: 1_030_000,
      ppn_amount: 113_300,
      pph23_amount: 0,
      grand_total: 1_143_300,
      confidence_score: 0.98,
    };
    const allowedMinor = auditInvoice(minorMarkup, poRows, [], {
      policyConfig: { autoApproveCeiling: 5_000_000 },
    });
    assert.equal(allowedMinor.audit_status, 'APPROVED');
    assert.ok(allowedMinor.policy_override_note);
    assert.match(allowedMinor.policy_override_note, /policy ceiling/i);
  });

  await t.test('3. Token-boundary item matcher blocks short substring spoof while allowing valid partial suffix', () => {
    const serverPo = [
      {
        po_number: 'PO-2026-820',
        vendor_name: 'PT Infra Cloud',
        po_type: 'GOODS',
        currency: 'IDR',
        status: 'OPEN',
        item_name: 'Server',
        qty: 1,
        unit_price: 10_000_000,
      },
    ];
    const spoofedLine = {
      invoice_number: 'INV-SUBSTR-01',
      po_number: 'PO-2026-820',
      vendor_name: 'PT Infra Cloud',
      currency: 'IDR',
      line_items: [{ item_name: 'Server Maintenance Fee', qty: 1, unit_price: 10_000_000, line_total: 10_000_000 }],
      subtotal: 10_000_000,
      ppn_amount: 1_100_000,
      pph23_amount: 0,
      grand_total: 11_100_000,
      confidence_score: 0.98,
    };
    const spoofRes = auditInvoice(spoofedLine, serverPo, []);
    assert.equal(spoofRes.audit_status, 'HOLD - UNORDERED ITEM');

    const scannerPo = [
      {
        po_number: 'PO-2026-005',
        vendor_name: 'PT Sentra Komponen Elektronik',
        po_type: 'GOODS',
        currency: 'IDR',
        status: 'OPEN',
        item_name: 'Barcode Scanner Wireless 2D',
        qty: 10,
        unit_price: 1_500_000,
      },
    ];
    const partialInvoice = {
      invoice_number: 'INV/SKE/2026/051',
      po_number: 'PO-2026-005',
      vendor_name: 'PT Sentra Komponen Elektronik',
      currency: 'IDR',
      line_items: [
        { item_name: 'Barcode Scanner Wireless 2D (Partial 6/10)', qty: 6, unit_price: 1_500_000, line_total: 9_000_000 },
      ],
      subtotal: 9_000_000,
      ppn_amount: 990_000,
      pph23_amount: 0,
      grand_total: 9_990_000,
      confidence_score: 0.96,
    };
    const partialRes = auditInvoice(partialInvoice, scannerPo, []);
    assert.equal(partialRes.audit_status, 'APPROVED - PARTIAL');
  });

  await t.test('4. Gate 4 detects printed subtotal mismatch vs line_items sum', () => {
    const poRows = [
      {
        po_number: 'PO-2026-830',
        vendor_name: 'PT Akurat',
        po_type: 'GOODS',
        currency: 'IDR',
        status: 'OPEN',
        item_name: 'Switch Gigabit Managed 24-Port',
        qty: 2,
        unit_price: 1_000_000,
      },
    ];
    const tamperedSubtotalInv = {
      invoice_number: 'INV-SUB-BAD',
      po_number: 'PO-2026-830',
      vendor_name: 'PT Akurat',
      currency: 'IDR',
      line_items: [{ item_name: 'Switch Gigabit Managed 24-Port', qty: 2, unit_price: 1_000_000, line_total: 2_000_000 }],
      subtotal: 2_500_000, // Printed subtotal inflated despite line_items = 2.0M
      ppn_amount: 220_000,
      pph23_amount: 0,
      grand_total: 2_220_000,
      confidence_score: 0.99,
    };
    const res = auditInvoice(tamperedSubtotalInv, poRows, []);
    assert.equal(res.audit_status, 'HOLD - TAX ERROR');
  });

  await t.test('5. Escapes XSS payloads inside Debit Note HTML output', () => {
    const xssLog = {
      id: 'xss-1',
      invoice_number: 'INV"<script>alert(1)</script>',
      po_number: 'PO-XSS-1',
      vendor_name: '<img src=x onerror=alert("xss")>',
      currency: 'IDR',
      grand_total: 5_000_000,
      audit_status: 'HOLD - <b onclick=alert(1)>PRICE VARIANCE</b>',
      reasons: ['Unit price mismatch'],
      extraction_data: {
        line_items: [{ item_name: '<svg onload=alert(1)>', qty: 1, unit_price: 5_000_000 }],
      },
      po_snapshot: {
        items: [{ item_name: '<svg onload=alert(1)>', qty: 1, unit_price: 4_000_000 }],
      },
    };
    const pack = generateDisputePack(xssLog);
    assert.ok(!pack.debitNoteHtml.includes('<script>'));
    assert.ok(!pack.debitNoteHtml.includes('<img '));
    assert.ok(!pack.debitNoteHtml.includes('<svg '));
    assert.ok(pack.debitNoteHtml.includes('&lt;script&gt;'));
    assert.ok(pack.debitNoteHtml.includes('&lt;img src=x onerror=alert(&quot;xss&quot;)&gt;'));
  });

  await t.test('6. Neutralizes CSV Formula Injection while preserving numeric values', () => {
    const logs = [
      {
        id: 'csv-1',
        invoice_number: '=CMD|" /C calc"!A0',
        po_number: 'PO-2026-001',
        vendor_name: '@SUM(1+1)*cmd',
        currency: 'IDR',
        grand_total: 1_110_000,
        audit_status: 'APPROVED',
        created_at: '2026-11-24T00:00:00Z',
        extraction_data: {
          subtotal: 1_000_000,
          ppn_amount: 110_000,
          pph23_amount: 0,
          grand_total: 1_110_000,
        },
      },
    ];
    const { csv } = generateAccountingCsv(logs, 'accurate');
    assert.ok(csv.includes('"\'=CMD|'));
    assert.ok(csv.includes('"\'@SUM(1+1)*cmd"'));
    assert.ok(csv.includes('"1000000"'));
  });

  await t.test('7. Enforces ADMIN_API_TOKEN on admin endpoints while allowing GET /api/dashboard?seed=1', async () => {
    const prevAdminToken = process.env.ADMIN_API_TOKEN;
    process.env.ADMIN_API_TOKEN = 'test-secret-admin-token-123';
    const server = createLocalServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // Unauthenticated admin calls must return 401
      const unauthReset = await fetch(`${baseUrl}/api/reset`, { method: 'POST' });
      assert.equal(unauthReset.status, 401);

      const unauthPos = await fetch(`${baseUrl}/api/pos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ po_number: 'PO-FAKE', vendor_name: 'X', items: [] }),
      });
      assert.equal(unauthPos.status, 401);

      const unauthResolve = await fetch(`${baseUrl}/api/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: '1', action: 'MANUAL APPROVED' }),
      });
      assert.equal(unauthResolve.status, 401);

      // Read-only ?seed=1 remains accessible for browser sandbox reset
      const seedDash = await fetch(`${baseUrl}/api/dashboard?seed=1`);
      assert.equal(seedDash.status, 200);
      const seedJson = await seedDash.json();
      assert.equal(seedJson.mode, 'seed');
      assert.ok(Array.isArray(seedJson.purchase_orders) && seedJson.purchase_orders.length > 0);

      // Authorized call with Bearer token succeeds
      const authReset = await fetch(`${baseUrl}/api/reset`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-secret-admin-token-123' },
      });
      assert.equal(authReset.status, 200);
    } finally {
      if (prevAdminToken === undefined) delete process.env.ADMIN_API_TOKEN;
      else process.env.ADMIN_API_TOKEN = prevAdminToken;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await t.test('8. Server-managed /api/audit rejects client preExtractedInvoice and ignores untrusted policyConfig', async () => {
    const server = createLocalServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const spoofExtractRes = await fetch(`${baseUrl}/api/audit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preExtractedInvoice: {
            invoice_number: 'INV-FAKE',
            po_number: 'PO-2026-001',
            vendor_name: 'PT Andalan Perkakas Nusantara',
            grand_total: 1000,
            confidence_score: 0.99,
          },
        }),
      });
      assert.equal(spoofExtractRes.status, 400);

      // Even if client passes autoApproveCeiling = 999M without purchaseOrders, server uses strict policy
      const tamperPolicyRes = await fetch(`${baseUrl}/api/audit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sampleId: 'prompt_injection',
          policyConfig: { autoApproveCeiling: 999_999_999, priceTolerancePct: 25 },
        }),
      });
      assert.equal(tamperPolicyRes.status, 200);
      const tamperJson = await tamperPolicyRes.json();
      assert.equal(tamperJson.audit_result.audit_status, 'HOLD - PRICE VARIANCE');
    } finally {
      await fetch(`${baseUrl}/api/reset`, { method: 'POST' }).catch(() => {});
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await t.test('9. aiProviderAdapter sends Gemini key via header (not URL), attaches AbortSignal, retries 503 & falls back', async () => {
    let attempts = 0;
    const seenUrls = [];
    const seenHeaders = [];
    let sawAbortSignal = false;

    const mockFetch = async (url, init) => {
      attempts += 1;
      seenUrls.push(url);
      seenHeaders.push(init.headers);
      if (init.signal instanceof AbortSignal) sawAbortSignal = true;

      if (url.includes('gemini-3.8-flash')) {
        return {
          ok: false,
          status: 503,
          json: async () => ({ error: { message: 'Overloaded' } }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      invoice_number: 'INV-ADAPT-01',
                      po_number: 'PO-2026-001',
                      vendor_name: 'PT Ada',
                      currency: 'IDR',
                      grand_total: 1110000,
                      confidence_score: 0.95,
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
        }),
      };
    };

    const res = await extractStructuredDocument({
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      fallbackModel: 'gemini-2.5-flash',
      apiKey: 'secret-gemini-test-key',
      extractionMethod: 'raw_text',
      markdownText: 'Invoice INV-ADAPT-01 Total 1110000',
      fetchImpl: mockFetch,
      sleepFn: async () => {},
      maxAttempts: 2,
    });

    assert.equal(attempts, 3);
    assert.equal(sawAbortSignal, true);
    assert.ok(seenUrls.every((u) => !u.includes('key=')));
    assert.ok(seenHeaders.every((h) => h['x-goog-api-key'] === 'secret-gemini-test-key'));
    assert.equal(res.model_used, 'gemini-2.5-flash');
    assert.equal(res.retry_count, 2);
  });

  await t.test('10. workflows/invoice_po_audit_n8n.json uses v2 line_items schema and startsWith APPROVED router', () => {
    const wfPath = path.resolve(__dirname, '..', 'workflows', 'invoice_po_audit_n8n.json');
    const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8'));
    assert.ok(Array.isArray(wf.nodes) && wf.nodes.length >= 10);

    const httpNode = wf.nodes.find((n) => n.id === 'node-gemini-http');
    assert.ok(httpNode.parameters.jsonBody.includes('line_items'));
    assert.ok(httpNode.parameters.jsonBody.includes('Anti-Prompt Injection'));
    assert.ok(httpNode.parameters.jsonBody.includes('pph23_amount'));

    const codeNode = wf.nodes.find((n) => n.id === 'node-audit-code');
    assert.ok(codeNode.parameters.jsCode.includes('MAX_CEILING_VARIANCE_PCT'));
    assert.ok(codeNode.parameters.jsCode.includes('computePriorBilledQty'));

    const switchNode = wf.nodes.find((n) => n.id === 'node-switch-router');
    assert.equal(switchNode.parameters.rules.values[0].conditions.conditions[0].operator.operation, 'startsWith');
    assert.equal(switchNode.parameters.rules.values[0].conditions.conditions[0].rightValue, 'APPROVED');
  });
});
