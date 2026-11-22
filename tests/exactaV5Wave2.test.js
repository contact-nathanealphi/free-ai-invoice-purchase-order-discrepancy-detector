'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { auditInvoice } = require('../src/auditEngine');
const { generateDisputePack } = require('../public/disputeGenerator');
const {
  calculateEarlyPaymentDiscount,
  generateAccountingCsv,
  computeVendorTrustLeaderboard,
  computeApAgingAndCashflow,
} = require('../public/accountingExporter');

test('Exacta v5.1 Policy Engine: priceTolerancePct, autoApproveCeiling, forbiddenFeeKeywords & mandatoryGrnThreshold', () => {
  const poData = [
    {
      po_number: 'PO-2026-800',
      vendor_name: 'PT Logam Mulia',
      po_type: 'GOODS',
      currency: 'IDR',
      status: 'OPEN',
      item_name: 'Steel Plate',
      qty: 10,
      unit_price: 100_000,
    },
  ];

  // 1) 2% price increase: blocked at default 0%, approved when priceTolerancePct = 3%
  const invPlus2Pct = {
    invoice_number: 'INV-TOL-01',
    po_number: 'PO-2026-800',
    vendor_name: 'PT Logam Mulia',
    currency: 'IDR',
    line_items: [{ item_name: 'Steel Plate', qty: 10, unit_price: 102_000, line_total: 1_020_000 }],
    subtotal: 1_020_000,
    ppn_amount: 112_200,
    pph23_amount: 0,
    grand_total: 1_132_200,
    confidence_score: 0.96,
  };

  const strictRes = auditInvoice(invPlus2Pct, poData, []);
  assert.equal(strictRes.audit_status, 'HOLD - PRICE VARIANCE');

  const tolerantRes = auditInvoice(invPlus2Pct, poData, [], {
    policyConfig: { priceTolerancePct: 3 },
  });
  assert.equal(tolerantRes.audit_status, 'APPROVED');

  // 2) Auto-approve ceiling: small invoice <= Rp1.5M auto-approved despite minor variance
  const ceilingRes = auditInvoice(invPlus2Pct, poData, [], {
    policyConfig: { autoApproveCeiling: 1_500_000 },
  });
  assert.equal(ceilingRes.audit_status, 'APPROVED');
  assert.ok(ceilingRes.checked_rules.includes('POLICY_AUTO_APPROVE_CEILING'));

  // 3) Forbidden fee keyword blacklist blocks even when item is present
  const invForbidden = {
    ...invPlus2Pct,
    invoice_number: 'INV-FEE-01',
    line_items: [
      { item_name: 'Steel Plate', qty: 10, unit_price: 100_000, line_total: 1_000_000 },
      { item_name: 'Admin Fee Express', qty: 1, unit_price: 50_000, line_total: 50_000 },
    ],
    subtotal: 1_050_000,
    ppn_amount: 115_500,
    grand_total: 1_165_500,
  };
  const forbiddenRes = auditInvoice(invForbidden, poData, [], {
    policyConfig: { forbiddenFeeKeywords: ['admin fee', 'surcharge'], autoApproveCeiling: 2_000_000 },
  });
  assert.equal(forbiddenRes.audit_status, 'HOLD - UNORDERED ITEM');
  assert.match(forbiddenRes.discrepancy_reason, /Policy Blacklist/);

  // 4) Mandatory GRN threshold blocks when grn_received_qty is missing
  const invClean = {
    invoice_number: 'INV-GRN-REQ',
    po_number: 'PO-2026-800',
    vendor_name: 'PT Logam Mulia',
    currency: 'IDR',
    line_items: [{ item_name: 'Steel Plate', qty: 10, unit_price: 100_000, line_total: 1_000_000 }],
    subtotal: 1_000_000,
    ppn_amount: 110_000,
    pph23_amount: 0,
    grand_total: 1_110_000,
    confidence_score: 0.98,
  };
  const grnRequiredRes = auditInvoice(invClean, poData, [], {
    policyConfig: { mandatoryGrnThreshold: 1_000_000 },
  });
  assert.equal(grnRequiredRes.audit_status, 'HOLD - GRN MISMATCH');
});

test('Exacta v5.1 Dispute Action Pack: generates Email ID/EN, WhatsApp & Debit Note HTML', () => {
  const sampleHoldLog = {
    id: 'log-disp-1',
    invoice_number: 'INV-2026-555',
    po_number: 'PO-2026-001',
    vendor_name: 'PT Prima Sukses',
    currency: 'IDR',
    grand_total: 12_210_000,
    audit_status: 'HOLD - PRICE VARIANCE',
    reasons: ['Unit price Rp1.100.000 exceeds PO Rp1.000.000'],
    extraction_data: {
      line_items: [{ item_name: 'Server Rack', qty: 10, unit_price: 1_100_000 }],
    },
    po_snapshot: {
      po_number: 'PO-2026-001',
      items: [{ item_name: 'Server Rack', qty: 10, unit_price: 1_000_000 }],
    },
  };

  const idFirm = generateDisputePack(sampleHoldLog, { lang: 'id', tone: 'firm' });
  assert.match(idFirm.subject, /INV-2026-555/);
  assert.match(idFirm.emailBody, /PO-2026-001/);
  assert.match(idFirm.whatsappText, /INV-2026-555/);
  assert.match(idFirm.debitNoteHtml, /OFFICIAL DEBIT NOTE/);
  assert.equal(idFirm.correctionAmount, 1_000_000);
  assert.ok(idFirm.mailtoUrl.startsWith('mailto:?subject='));

  const enEscalation = generateDisputePack(sampleHoldLog, { lang: 'en', tone: 'escalation' });
  assert.match(enEscalation.emailBody, /URGENT ESCALATION/);
});

test('Exacta v5.1 Accounting Exporter: supports Accurate, Jurnal, Xero, QuickBooks & Batch Bank Transfer', () => {
  const logs = [
    {
      id: 'l-1',
      invoice_number: 'INV-APP-01',
      po_number: 'PO-2026-002',
      vendor_name: 'CV Digital Karya',
      currency: 'IDR',
      grand_total: 10_900_000,
      audit_status: 'APPROVED',
      created_at: '2026-11-20T08:00:00Z',
      extraction_data: {
        invoice_date: '2026-11-20',
        due_date: '2026-12-20',
        subtotal: 10_000_000,
        ppn_amount: 1_100_000,
        pph23_amount: 200_000,
        grand_total: 10_900_000,
      },
      po_snapshot: { po_type: 'SERVICE' },
    },
    {
      id: 'l-2',
      invoice_number: 'INV-HOLD-99',
      po_number: 'PO-2026-003',
      vendor_name: 'PT Abadi',
      currency: 'IDR',
      grand_total: 5_000_000,
      audit_status: 'HOLD - PRICE VARIANCE',
    },
  ];

  for (const preset of ['accurate', 'jurnal', 'xero', 'quickbooks', 'bank_transfer']) {
    const res = generateAccountingCsv(logs, preset);
    assert.equal(res.count, 1); // Only APPROVED exported
    assert.match(res.csv, /INV-APP-01/);
    assert.ok(!res.csv.includes('INV-HOLD-99'));
    assert.match(res.csv, /10900000/); // Net Payable after PPh 23
  }
});

test('Exacta v5.1 CFO Insights: Early Payment Discount, Vendor Trust Score & AP Aging buckets', () => {
  const logs = [
    {
      id: 'cfo-1',
      invoice_number: 'INV-EARLY-01',
      vendor_name: 'PT Vendor Bagus',
      currency: 'IDR',
      grand_total: 10_000_000,
      audit_status: 'APPROVED',
      created_at: '2026-11-20T08:00:00Z',
      extraction_data: {
        invoice_date: '2026-11-20',
        due_date: '2026-11-25', // 0-7 days from 2026-11-22
        payment_terms: '2/10 Net 30',
        grand_total: 10_000_000,
      },
    },
    {
      id: 'cfo-2',
      invoice_number: 'INV-BAD-01',
      vendor_name: 'PT Vendor Nakal',
      currency: 'IDR',
      grand_total: 20_000_000,
      audit_status: 'HOLD - PRICE VARIANCE',
      forensic_signals: [{ code: 'FORENSIC_SPLIT_INVOICING' }],
      forensic_risk_score: 40,
      created_at: '2026-10-01T08:00:00Z',
      extraction_data: {
        invoice_date: '2026-10-01',
        due_date: '2026-11-01', // Overdue vs 2026-11-22
        grand_total: 20_000_000,
      },
    },
  ];

  const refDate = new Date('2026-11-22T00:00:00Z');
  const disc = calculateEarlyPaymentDiscount(logs[0], refDate);
  assert.equal(disc.hasDiscount, true);
  assert.equal(disc.isActive, true);
  assert.equal(disc.savingsAmount, 200_000);
  assert.equal(disc.discountDeadline, '2026-11-30');

  const leaderboard = computeVendorTrustLeaderboard(logs);
  assert.equal(leaderboard.length, 2);
  const goodVendor = leaderboard.find((v) => v.vendor_name === 'PT Vendor Bagus');
  const badVendor = leaderboard.find((v) => v.vendor_name === 'PT Vendor Nakal');
  assert.equal(goodVendor.trust_score, 100);
  assert.ok(badVendor.trust_score < 50);

  const aging = computeApAgingAndCashflow(logs, refDate);
  assert.equal(aging.buckets.overdue, 20_000_000);
  assert.equal(aging.buckets.days0to7, 10_000_000);
  assert.equal(aging.totalEarlyDiscountSavingsIdr, 200_000);
});
