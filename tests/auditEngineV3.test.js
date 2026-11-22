'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { auditInvoice } = require('../src/auditEngine');
const { createRepository, flattenPurchaseOrdersForAudit } = require('../src/dbRepository');
const { createLocalServer } = require('../src/localServer');

test('3-Way Match & Persistent Repository (v3)', async (t) => {
  await t.test('1. Single-item invoice exceeding grn_received_qty triggers HOLD - GRN MISMATCH', () => {
    const poList = [
      {
        po_number: 'PO-2026-005',
        vendor_name: 'PT Sentra Komponen Elektronik',
        po_type: 'GOODS',
        currency: 'IDR',
        item_name: 'Barcode Scanner Wireless 2D',
        qty: 10,
        unit_price: 1500000,
        grn_received_qty: 6,
        status: 'OPEN',
      },
    ];
    const invoice = {
      invoice_number: 'INV/SKE/2026/099',
      po_number: 'PO-2026-005',
      vendor_name: 'PT Sentra Komponen Elektronik',
      currency: 'IDR',
      item_name: 'Barcode Scanner Wireless 2D',
      qty: 8,
      unit_price: 1500000,
      ppn_amount: 1320000,
      grand_total: 13320000,
      confidence_score: 0.98,
    };

    const result = auditInvoice(invoice, poList, []);
    assert.equal(result.audit_status, 'HOLD - GRN MISMATCH');
    assert.equal(result.requires_human_review, true);
    assert.ok(result.checked_rules.includes('GATE_5B_3WAY_GRN_MATCH'));
  });

  await t.test('2. Multi-item invoice exceeding grn_received_qty on one item triggers HOLD - GRN MISMATCH', () => {
    const poList = [
      {
        po_number: 'PO-2026-004',
        vendor_name: 'PT Graha Suplai Kantor',
        po_type: 'GOODS',
        currency: 'IDR',
        item_name: 'Kertas A4 80gsm (Box 5 Rim)',
        qty: 20,
        unit_price: 250000,
        grn_received_qty: 10,
        status: 'OPEN',
      },
      {
        po_number: 'PO-2026-004',
        vendor_name: 'PT Graha Suplai Kantor',
        po_type: 'GOODS',
        currency: 'IDR',
        item_name: 'Toner LaserJet Black Original',
        qty: 4,
        unit_price: 1250000,
        grn_received_qty: 4,
        status: 'OPEN',
      },
    ];
    const invoice = {
      invoice_number: 'INV/GSK/2026/100',
      po_number: 'PO-2026-004',
      vendor_name: 'PT Graha Suplai Kantor',
      currency: 'IDR',
      line_items: [
        { item_name: 'Kertas A4 80gsm (Box 5 Rim)', qty: 15, unit_price: 250000, line_total: 3750000 },
        { item_name: 'Toner LaserJet Black Original', qty: 4, unit_price: 1250000, line_total: 5000000 },
      ],
      ppn_amount: 962500,
      grand_total: 9712500,
      confidence_score: 0.99,
    };

    const result = auditInvoice(invoice, poList, []);
    assert.equal(result.audit_status, 'HOLD - GRN MISMATCH');
    assert.equal(result.requires_human_review, true);
  });

  await t.test('3. dbRepository local fallback CRUD, PO balance update, resolve, and resetSandboxData', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-repo-test-'));
    const ledgerPath = path.join(tmpDir, 'ledger.json');
    const repo = createRepository({ ledgerPath, forceLocal: true });

    const initialPOs = await repo.getPurchaseOrders();
    assert.ok(initialPOs.length >= 8);
    const flat = flattenPurchaseOrdersForAudit(initialPOs);
    assert.ok(flat.some((r) => r.po_number === 'PO-2026-005' && r.grn_received_qty === 6));

    const inserted = await repo.insertAuditLog({
      file_name: 'test.pdf',
      invoice_number: 'INV/TEST/001',
      po_number: 'PO-2026-005',
      vendor_name: 'PT Sentra Komponen Elektronik',
      grand_total: 9990000,
      audit_status: 'HUMAN REVIEW',
      reasons: ['Test reason'],
    });
    assert.ok(inserted.id);

    const resolved = await repo.resolveAuditLog(inserted.id, 'MANUAL APPROVED', 'OK verified');
    assert.equal(resolved.audit_status, 'MANUAL APPROVED');
    assert.equal(resolved.reviewer_note, 'OK verified');

    const updatedPo = await repo.updatePurchaseOrderBalances('PO-2026-005', [
      { item_name: 'Barcode Scanner Wireless 2D', qty: 6 },
    ]);
    assert.equal(updatedPo.items[0].remaining_qty, 4);

    const resetRes = await repo.resetSandboxData();
    assert.equal(resetRes.audit_logs_count, 3);
    const logsAfterReset = await repo.getAuditLogs();
    assert.equal(logsAfterReset.length, 3);

    const posAfterReset = await repo.getPurchaseOrders();
    const po5AfterReset = posAfterReset.find((p) => p.po_number === 'PO-2026-005');
    assert.equal(po5AfterReset.items[0].remaining_qty, 10);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await t.test('4. Local server serves public/index.html and /api/dashboard & /api/reset', async () => {
    const server = createLocalServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const htmlRes = await fetch(`${baseUrl}/`);
      assert.equal(htmlRes.status, 200);
      const html = await htmlRes.text();
      assert.ok(html.includes('AI Invoice &amp; Purchase Order Discrepancy Detector') || html.includes('AI Invoice & Purchase Order Discrepancy Detector'));
      assert.ok(html.includes('/playground.html'));
      assert.equal(html.includes('presetsDropdownBtn'), false);

      const pgRes = await fetch(`${baseUrl}/playground.html`);
      assert.equal(pgRes.status, 200);
      const pgHtml = await pgRes.text();
      assert.ok(pgHtml.includes('Audit Sandbox &amp; Sample Studio'));
      assert.ok(pgHtml.includes('jspdf'));

      const pgJsRes = await fetch(`${baseUrl}/playground.js`);
      assert.equal(pgJsRes.status, 200);

      const dashRes = await fetch(`${baseUrl}/api/dashboard`);
      assert.equal(dashRes.status, 200);
      const dashJson = await dashRes.json();
      assert.equal(dashJson.ok, true);
      assert.ok(Array.isArray(dashJson.purchase_orders));
      assert.ok(Array.isArray(dashJson.audit_logs));

      const resetRes = await fetch(`${baseUrl}/api/reset`, { method: 'POST' });
      assert.equal(resetRes.status, 200);
      const resetJson = await resetRes.json();
      assert.equal(resetJson.ok, true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await t.test('5. dbRepository createPurchaseOrder and updateGoodsReceipt work in local mode', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-pos-test-'));
    const ledgerPath = path.join(tmpDir, 'ledger.json');
    const repo = createRepository({ ledgerPath, forceLocal: true });

    const created = await repo.createPurchaseOrder({
      po_number: 'PO-2026-999',
      vendor_name: 'PT Uji Coba Mandiri',
      po_type: 'GOODS',
      currency: 'IDR',
      items: [{ item_name: 'Server Rack 42U', qty: 2, unit_price: 5000000, grn_received_qty: 1 }],
    });
    assert.equal(created.po_number, 'PO-2026-999');
    assert.equal(created.items[0].grn_received_qty, 1);

    const updated = await repo.updateGoodsReceipt('PO-2026-999', [
      { item_name: 'Server Rack 42U', grn_received_qty: 2 },
    ]);
    assert.equal(updated.items[0].grn_received_qty, 2);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await t.test('6. /api/pos POST and PATCH create PO and update GRN over HTTP', async () => {
    const server = createLocalServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await fetch(`${baseUrl}/api/reset`, { method: 'POST' });

      const postRes = await fetch(`${baseUrl}/api/pos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          po_number: 'PO-2026-888',
          vendor_name: 'CV HTTP Test',
          po_type: 'SERVICE',
          currency: 'IDR',
          items: [{ item_name: 'Jasa Audit', qty: 1, unit_price: 10000000 }],
        }),
      });
      assert.equal(postRes.status, 201);
      const postJson = await postRes.json();
      assert.equal(postJson.ok, true);
      assert.equal(postJson.purchase_order.po_number, 'PO-2026-888');

      const patchRes = await fetch(`${baseUrl}/api/pos`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          po_number: 'PO-2026-888',
          items: [{ item_name: 'Jasa Audit', grn_received_qty: 1 }],
        }),
      });
      assert.equal(patchRes.status, 200);
      const patchJson = await patchRes.json();
      assert.equal(patchJson.ok, true);
      assert.equal(patchJson.purchase_order.items[0].grn_received_qty, 1);

      await fetch(`${baseUrl}/api/reset`, { method: 'POST' });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
