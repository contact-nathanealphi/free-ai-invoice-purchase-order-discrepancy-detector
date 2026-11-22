'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { auditInvoice } = require('../src/auditEngine');
const ExactaStore = require('../public/workspaceStore');
const { computeApAgingAndCashflow } = require('../public/accountingExporter');

test('Exacta v5.2 Item Alias: unordered item becomes APPROVED when mapped via itemAliases', () => {
  const poRows = [
    {
      po_number: 'PO-2026-850',
      vendor_name: 'PT Kertas Jaya',
      po_type: 'GOODS',
      currency: 'IDR',
      status: 'OPEN',
      item_name: 'Kertas A4 80gr',
      qty: 10,
      unit_price: 50_000,
    },
  ];

  const invoice = {
    invoice_number: 'INV-ALIAS-01',
    po_number: 'PO-2026-850',
    vendor_name: 'PT Kertas Jaya',
    currency: 'IDR',
    line_items: [{ item_name: 'HVS Paper A4 80gsm', qty: 10, unit_price: 50_000, line_total: 500_000 }],
    subtotal: 500_000,
    ppn_amount: 55_000,
    pph23_amount: 0,
    grand_total: 555_000,
    confidence_score: 0.96,
  };

  const withoutAlias = auditInvoice(invoice, poRows, []);
  assert.equal(withoutAlias.audit_status, 'HOLD - UNORDERED ITEM');

  const withAlias = auditInvoice(invoice, poRows, [], {
    policyConfig: {
      itemAliases: [{ invoice_item: 'HVS Paper A4 80gsm', po_item: 'Kertas A4 80gr' }],
    },
  });
  assert.equal(withAlias.audit_status, 'APPROVED');
});

test('Exacta v5.2 Dynamic Tax & FX Rates: applies custom PPN 12%, PPh 4%, and dynamic FX rates', () => {
  const servicePo = [
    {
      po_number: 'PO-2026-860',
      vendor_name: 'CV Konsultan Pajak',
      po_type: 'SERVICE',
      currency: 'IDR',
      status: 'OPEN',
      item_name: 'Tax Advisory',
      qty: 1,
      unit_price: 10_000_000,
    },
  ];

  // Subtotal 10M, PPN 12% = 1.2M, PPh 4% = 400k => Grand Total = 10.8M
  const invoice12Pct = {
    invoice_number: 'INV-TAX12-01',
    po_number: 'PO-2026-860',
    vendor_name: 'CV Konsultan Pajak',
    currency: 'IDR',
    line_items: [{ item_name: 'Tax Advisory', qty: 1, unit_price: 10_000_000, line_total: 10_000_000 }],
    subtotal: 10_000_000,
    ppn_amount: 1_200_000,
    pph23_amount: 400_000,
    grand_total: 10_800_000,
    confidence_score: 0.98,
  };

  const defaultTaxRes = auditInvoice(invoice12Pct, servicePo, []);
  assert.equal(defaultTaxRes.audit_status, 'HOLD - TAX ERROR');

  const customTaxRes = auditInvoice(invoice12Pct, servicePo, [], {
    policyConfig: { ppnRatePct: 12, pphRatePct: 4 },
  });
  assert.equal(customTaxRes.audit_status, 'APPROVED');

  const fxLogs = [
    {
      id: 'fx-1',
      currency: 'USD',
      grand_total: 1000,
      audit_status: 'APPROVED',
      extraction_data: { due_date: '2026-12-10', grand_total: 1000 },
    },
  ];
  const aging = computeApAgingAndCashflow(fxLogs, new Date('2026-11-23T00:00:00Z'), {
    USD: 16500,
    SGD: 12500,
  });
  assert.equal(aging.totalPayableIdr, 16_500_000);
});

test('Exacta v5.2 Mark as Paid & Alias Store: closes PO and excludes paid bill from AP Aging', async () => {
  await ExactaStore.saveWorkspace({
    purchaseOrders: [
      {
        po_number: 'PO-2026-870',
        vendor_name: 'PT Lunas Mandiri',
        po_type: 'GOODS',
        currency: 'IDR',
        status: 'OPEN',
        items: [{ item_name: 'Router', qty: 2, unit_price: 1_000_000, remaining_qty: 0 }],
      },
    ],
    auditLogs: [
      {
        id: 'log-pay-1',
        invoice_number: 'INV-PAY-01',
        po_number: 'PO-2026-870',
        vendor_name: 'PT Lunas Mandiri',
        currency: 'IDR',
        grand_total: 2_220_000,
        audit_status: 'APPROVED',
        extraction_data: { due_date: '2026-11-30', grand_total: 2_220_000 },
      },
    ],
    itemAliases: [],
  });

  const beforeAging = computeApAgingAndCashflow(ExactaStore.getWorkspace().auditLogs, new Date('2026-11-23T00:00:00Z'));
  assert.equal(beforeAging.totalPayableIdr, 2_220_000);

  await ExactaStore.markAuditLogPaid('log-pay-1', {
    paid_date: '2026-11-23',
    payment_ref: 'TRF-BCA-001',
  });

  const wsAfter = ExactaStore.getWorkspace();
  assert.equal(wsAfter.auditLogs[0].payment_status, 'PAID');
  assert.equal(wsAfter.purchaseOrders[0].status, 'CLOSED');

  const afterAging = computeApAgingAndCashflow(wsAfter.auditLogs, new Date('2026-11-23T00:00:00Z'));
  assert.equal(afterAging.totalPayableIdr, 0);

  const alias = await ExactaStore.addItemAlias({
    invoice_item: 'Router Mikrotik',
    po_item: 'Router',
    po_number: 'PO-2026-870',
  });
  assert.equal(ExactaStore.getItemAliases().length, 1);
  await ExactaStore.deleteItemAlias(alias.id);
  assert.equal(ExactaStore.getItemAliases().length, 0);
});
