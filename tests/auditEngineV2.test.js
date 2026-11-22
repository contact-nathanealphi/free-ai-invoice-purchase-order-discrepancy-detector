'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { auditInvoice, normalizePoNumber } = require('../src/auditEngine');

const WILD_MASTER_PO = [
  {
    po_number: 'PO-2026-001',
    vendor_name: 'PT Andalan Perkakas Nusantara',
    po_type: 'GOODS',
    currency: 'IDR',
    item_name: 'Mesin Bor Industri Heavy Duty',
    qty: 3,
    unit_price: 2_000_000,
    status: 'OPEN',
  },
  {
    po_number: 'PO-2026-002',
    vendor_name: 'CV Karya Mandiri Logistik',
    po_type: 'GOODS',
    currency: 'IDR',
    item_name: 'Pallet Plastik Industrial 120x100 cm',
    qty: 5,
    unit_price: 1_200_000,
    status: 'OPEN',
  },
  {
    po_number: 'PO-2026-003',
    vendor_name: 'PT Konsultan Digital Prima',
    po_type: 'SERVICE',
    currency: 'IDR',
    item_name: 'Jasa Audit Keamanan Sistem & Infrastruktur Cloud',
    qty: 1,
    unit_price: 10_000_000,
    status: 'OPEN',
  },
  {
    po_number: 'PO-2026-004',
    vendor_name: 'PT Graha Suplai Kantor',
    po_type: 'GOODS',
    currency: 'IDR',
    item_name: 'Kertas A4 80gsm (Box 5 Rim)',
    qty: 20,
    unit_price: 250_000,
    status: 'OPEN',
  },
  {
    po_number: 'PO-2026-004',
    vendor_name: 'PT Graha Suplai Kantor',
    po_type: 'GOODS',
    currency: 'IDR',
    item_name: 'Toner LaserJet Black Original',
    qty: 4,
    unit_price: 1_250_000,
    status: 'OPEN',
  },
  {
    po_number: 'PO-2026-005',
    vendor_name: 'PT Sentra Komponen Elektronik',
    po_type: 'GOODS',
    currency: 'IDR',
    item_name: 'Barcode Scanner Wireless 2D',
    qty: 10,
    unit_price: 1_500_000,
    status: 'OPEN',
  },
];

describe('Deterministic AP Audit Engine v2 (Enterprise Features)', () => {
  it('1. Canonical PO normalization matches "PO 2026 / 001" to "PO-2026-001" -> APPROVED', () => {
    assert.equal(normalizePoNumber('PO 2026 / 001'), 'PO-2026-001');
    const result = auditInvoice(
      {
        invoice_number: 'INV/APN/2026/044',
        po_number: 'PO 2026 / 001',
        vendor_name: 'PT Andalan Perkakas Nusantara',
        currency: 'IDR',
        line_items: [
          { item_name: 'Mesin Bor Industri Heavy Duty', qty: 3, unit_price: 2_000_000, line_total: 6_000_000 },
        ],
        subtotal: 6_000_000,
        ppn_amount: 660_000,
        pph23_amount: 0,
        grand_total: 6_660_000,
        confidence_score: 0.90,
      },
      WILD_MASTER_PO,
      [],
      { token_usage: { promptTokenCount: 1000, candidatesTokenCount: 250 } }
    );
    assert.equal(result.audit_status, 'APPROVED');
    assert.equal(result.po_number, 'PO-2026-001');
    assert.ok(result.estimated_cost_usd > 0);
    assert.ok(result.estimated_cost_idr > 0);
  });

  it('2. Multi-item invoice matches multi-row PO -> APPROVED', () => {
    const result = auditInvoice(
      {
        invoice_number: 'INV/GSK/2026/001',
        po_number: 'PO-2026-004',
        vendor_name: 'PT Graha Suplai Kantor',
        currency: 'IDR',
        line_items: [
          { item_name: 'Kertas A4 80gsm (Box 5 Rim)', qty: 20, unit_price: 250_000, line_total: 5_000_000 },
          { item_name: 'Toner LaserJet Black Original', qty: 4, unit_price: 1_250_000, line_total: 5_000_000 },
        ],
        subtotal: 10_000_000,
        ppn_amount: 1_100_000,
        pph23_amount: 0,
        grand_total: 11_100_000,
        confidence_score: 0.96,
      },
      WILD_MASTER_PO,
      []
    );
    assert.equal(result.audit_status, 'APPROVED');
    assert.equal(result.variance, 0);
  });

  it('3. Sneaky fee / unordered item triggers HOLD - UNORDERED ITEM', () => {
    const result = auditInvoice(
      {
        invoice_number: 'INV/KML/2026/012',
        po_number: 'PO-2026-002',
        vendor_name: 'CV Karya Mandiri Logistik',
        currency: 'IDR',
        line_items: [
          { item_name: 'Pallet Plastik Industrial 120x100 cm', qty: 5, unit_price: 1_200_000, line_total: 6_000_000 },
          { item_name: 'Biaya Admin & Handling', qty: 1, unit_price: 750_000, line_total: 750_000 },
        ],
        subtotal: 6_750_000,
        ppn_amount: 742_500,
        pph23_amount: 0,
        grand_total: 7_492_500,
        confidence_score: 0.96,
      },
      WILD_MASTER_PO,
      []
    );
    assert.equal(result.audit_status, 'HOLD - UNORDERED ITEM');
    assert.equal(result.requires_human_review, true);
  });

  it('4. SERVICE PO with PPN +11% and PPh 23 -2% -> APPROVED', () => {
    const result = auditInvoice(
      {
        invoice_number: 'INV/KDP/2026/077',
        po_number: 'PO-2026-003',
        vendor_name: 'PT Konsultan Digital Prima',
        currency: 'IDR',
        line_items: [
          { item_name: 'Jasa Audit Keamanan Sistem & Infrastruktur Cloud', qty: 1, unit_price: 10_000_000, line_total: 10_000_000 },
        ],
        subtotal: 10_000_000,
        ppn_amount: 1_100_000,
        pph23_amount: 200_000,
        grand_total: 10_900_000,
        confidence_score: 0.97,
      },
      WILD_MASTER_PO,
      []
    );
    assert.equal(result.audit_status, 'APPROVED');
    assert.equal(result.variance, 0);
  });

  it('5. Partial delivery (6 of 10 units at PO unit price) -> APPROVED - PARTIAL', () => {
    const result = auditInvoice(
      {
        invoice_number: 'INV/SKE/2026/051',
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
        confidence_score: 0.95,
      },
      WILD_MASTER_PO,
      []
    );
    assert.equal(result.audit_status, 'APPROVED - PARTIAL');
    assert.equal(result.requires_human_review, false);
  });

  it('6. Currency mismatch (USD invoice vs IDR PO) -> HOLD - CURRENCY MISMATCH', () => {
    const result = auditInvoice(
      {
        invoice_number: 'INV/APN/2026/999',
        po_number: 'PO-2026-001',
        vendor_name: 'PT Andalan Perkakas Nusantara',
        currency: 'USD',
        line_items: [
          { item_name: 'Mesin Bor Industri Heavy Duty', qty: 3, unit_price: 125, line_total: 375 },
        ],
        subtotal: 375,
        ppn_amount: 0,
        pph23_amount: 0,
        grand_total: 375,
        confidence_score: 0.96,
      },
      WILD_MASTER_PO,
      []
    );
    assert.equal(result.audit_status, 'HOLD - CURRENCY MISMATCH');
    assert.equal(result.requires_human_review, true);
  });

  it('7. SHA-256 file_hash duplicate check catches re-uploaded file with different invoice_number', () => {
    const result = auditInvoice(
      {
        invoice_number: 'INV/NEW/999',
        po_number: 'PO-2026-001',
        vendor_name: 'PT Andalan Perkakas Nusantara',
        file_hash: 'abc123def456',
        qty: 3,
        unit_price: 2_000_000,
        grand_total: 6_660_000,
        confidence_score: 0.96,
      },
      WILD_MASTER_PO,
      [{ invoice_number: 'INV/OLD/001', vendor_name: 'Other Vendor', file_hash: 'abc123def456' }]
    );
    assert.equal(result.audit_status, 'HOLD - DUPLICATE');
    assert.match(result.discrepancy_reason, /SHA-256/);
  });

  it('8. OCR Degradation Guard routes missing PO with noisy/blurry extraction_notes or corrupted PO to HUMAN REVIEW', () => {
    const noisyResult = auditInvoice(
      {
        invoice_number: 'INV/GSK/2024/056',
        po_number: 'PO-2024-004',
        vendor_name: 'PT Graha Suplai Kantor',
        currency: 'IDR',
        qty: 1,
        unit_price: 19_000_000,
        grand_total: 21_090_000,
        confidence_score: 0.85,
        extraction_notes: 'Terdapat noda scan dan lipatan kertas pada area nomor PO (blur).',
      },
      WILD_MASTER_PO,
      []
    );
    assert.equal(noisyResult.audit_status, 'HUMAN REVIEW');
    assert.equal(noisyResult.requires_human_review, true);

    const corruptedPoResult = auditInvoice(
      {
        invoice_number: 'INV/GSK/2026/099',
        po_number: 'PO-202?-004',
        vendor_name: 'PT Graha Suplai Kantor',
        currency: 'IDR',
        qty: 1,
        unit_price: 19_000_000,
        grand_total: 21_090_000,
        confidence_score: 0.90,
        extraction_notes: 'Dokumen terbaca',
      },
      WILD_MASTER_PO,
      []
    );
    assert.equal(corruptedPoResult.audit_status, 'HUMAN REVIEW');
    assert.equal(corruptedPoResult.requires_human_review, true);
  });
});
