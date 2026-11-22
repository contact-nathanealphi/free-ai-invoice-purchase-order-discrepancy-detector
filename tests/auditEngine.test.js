'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { auditInvoice } = require('../src/auditEngine');

const ROOT_DIR = path.resolve(__dirname, '..');
const MASTER_PO_CSV_PATH = path.join(ROOT_DIR, 'test_data', 'Master_PO.csv');
const EXPECTED_RESULTS_PATH = path.join(ROOT_DIR, 'test_data', 'expected_results.json');

/**
 * Parses Master_PO.csv into an array of PO objects without external libraries.
 */
function loadMasterPO() {
  const raw = fs.readFileSync(MASTER_PO_CSV_PATH, 'utf8').trim();
  const lines = raw.split(/\r?\n/);
  const headers = lines[0].split(',').map((h) => h.trim());

  return lines.slice(1).map((line) => {
    const values = line.split(',').map((v) => v.trim());
    const row = {};
    headers.forEach((header, idx) => {
      const val = values[idx];
      if (['qty', 'unit_price', 'expected_subtotal', 'expected_tax_11', 'expected_total'].includes(header)) {
        row[header] = Number(val);
      } else {
        row[header] = val;
      }
    });
    return row;
  });
}

function loadExpectedResults() {
  const raw = fs.readFileSync(EXPECTED_RESULTS_PATH, 'utf8');
  return JSON.parse(raw).results;
}

const masterPOList = loadMasterPO();
const expectedResults = loadExpectedResults();

function findExpected(fileName) {
  const entry = expectedResults.find((r) => r.file_name === fileName);
  assert.ok(entry, `Missing expected result fixture: ${fileName}`);
  return entry;
}

function findPO(poNumber) {
  const po = masterPOList.find((p) => p.po_number === poNumber);
  assert.ok(po, `Missing Master PO fixture: ${poNumber}`);
  return po;
}

describe('Deterministic AP Audit Engine (auditInvoice)', () => {
  it('1. Normal invoice matches Master PO -> APPROVED', () => {
    const fixture = findExpected('INV_01_normal_nusantara.pdf');
    const po = findPO(fixture.po_number);

    const result = auditInvoice(
      {
        invoice_number: fixture.invoice_number,
        po_number: fixture.po_number,
        vendor_name: fixture.vendor_name,
        qty: po.qty,
        unit_price: fixture.billed_unit_price,
        subtotal: fixture.billed_subtotal,
        tax: fixture.billed_tax_11,
        grand_total: fixture.billed_total,
        confidence_score: 0.98,
      },
      masterPOList,
      []
    );

    assert.equal(result.audit_status, fixture.expected_status);
    assert.equal(result.requires_human_review, false);
    assert.equal(result.variance, 0);
    assert.equal(result.invoiced_total, fixture.billed_total);
    assert.equal(result.po_total, po.expected_total);
    assert.equal(result.discrepancy_reason, null);
    assert.deepEqual(result.checked_rules, [
      'GATE_1_CONFIDENCE_THRESHOLD',
      'GATE_2_DUPLICATE_CHECK',
      'GATE_3_PO_VALIDATION',
      'GATE_4_DETERMINISTIC_MATH_TAX',
      'GATE_5_PO_MATCHING_VARIANCE',
    ]);
  });

  it('2. Rounding tolerance +Rp50 remains APPROVED', () => {
    const fixture = findExpected('INV_02_normal_teknologi.pdf');
    const po = findPO(fixture.po_number);

    const result = auditInvoice(
      {
        invoice_number: fixture.invoice_number,
        po_number: fixture.po_number,
        vendor_name: fixture.vendor_name,
        qty: po.qty,
        unit_price: fixture.billed_unit_price,
        subtotal: fixture.billed_subtotal,
        tax: fixture.billed_tax_11 + 50,
        grand_total: fixture.billed_total + 50,
        confidence_score: 0.95,
      },
      masterPOList,
      []
    );

    assert.equal(result.audit_status, 'APPROVED');
    assert.equal(result.requires_human_review, false);
    assert.equal(result.variance, 50);
  });

  it('3. Low confidence (< 0.85) stops at Gate 1 -> HUMAN REVIEW', () => {
    const fixture = findExpected('INV_10_low_confidence_kemasan.pdf');
    const po = findPO(fixture.po_number);

    const result = auditInvoice(
      {
        invoice_number: fixture.invoice_number,
        po_number: fixture.po_number,
        vendor_name: fixture.vendor_name,
        qty: po.qty,
        unit_price: fixture.billed_unit_price,
        tax: fixture.billed_tax_11,
        grand_total: fixture.billed_total,
        confidence_score: 0.72,
      },
      masterPOList,
      []
    );

    assert.equal(result.audit_status, fixture.expected_status);
    assert.equal(result.requires_human_review, true);
    assert.deepEqual(result.checked_rules, ['GATE_1_CONFIDENCE_THRESHOLD']);
    assert.match(result.discrepancy_reason, /0\.72/);
  });

  it('4. Duplicate billing (case-insensitive) stops at Gate 2 -> HOLD - DUPLICATE', () => {
    const fixture = findExpected('INV_09_duplicate_nusantara_copy.pdf');
    const po = findPO(fixture.po_number);

    const existingLogs = [
      {
        invoice_number: 'inv/nl/2026/001',
        vendor_name: 'pt nusantara logistik',
        audit_status: 'APPROVED',
      },
    ];

    const result = auditInvoice(
      {
        invoice_number: fixture.invoice_number,
        po_number: fixture.po_number,
        vendor_name: fixture.vendor_name,
        qty: po.qty,
        unit_price: fixture.billed_unit_price,
        tax: fixture.billed_tax_11,
        grand_total: fixture.billed_total,
        confidence_score: 0.99,
      },
      masterPOList,
      existingLogs
    );

    assert.equal(result.audit_status, fixture.expected_status);
    assert.equal(result.requires_human_review, true);
    assert.deepEqual(result.checked_rules, [
      'GATE_1_CONFIDENCE_THRESHOLD',
      'GATE_2_DUPLICATE_CHECK',
    ]);
  });

  it('5. Invalid / Closed PO stops at Gate 3 -> HOLD - INVALID PO', () => {
    const missingPOResult = auditInvoice(
      {
        invoice_number: 'INV/TEST/999',
        po_number: 'PO-9999-999',
        vendor_name: 'PT Tidak Terdaftar',
        qty: 1,
        unit_price: 1000000,
        tax: 110000,
        grand_total: 1110000,
        confidence_score: 0.96,
      },
      masterPOList,
      []
    );

    assert.equal(missingPOResult.audit_status, 'HOLD - INVALID PO');
    assert.equal(missingPOResult.requires_human_review, true);

    const closedPOList = masterPOList.map((po) =>
      po.po_number === 'PO-2026-001' ? { ...po, status: 'CLOSED' } : po
    );
    const closedPOResult = auditInvoice(
      {
        invoice_number: 'INV/NL/2026/002',
        po_number: 'PO-2026-001',
        vendor_name: 'PT Nusantara Logistik',
        qty: 4,
        unit_price: 4500000,
        tax: 1980000,
        grand_total: 19980000,
        confidence_score: 0.96,
      },
      closedPOList,
      []
    );

    assert.equal(closedPOResult.audit_status, 'HOLD - INVALID PO');
    assert.equal(closedPOResult.requires_human_review, true);
    assert.match(closedPOResult.discrepancy_reason, /CLOSED/);
  });

  it('6. Tax calculation error (+Rp500.000) stops at Gate 4 -> HOLD - TAX ERROR', () => {
    const fixture = findExpected('INV_08_tax_error_sentosa.pdf');
    const po = findPO(fixture.po_number);

    const result = auditInvoice(
      {
        invoice_number: fixture.invoice_number,
        po_number: fixture.po_number,
        vendor_name: fixture.vendor_name,
        qty: po.qty,
        unit_price: fixture.billed_unit_price,
        subtotal: fixture.billed_subtotal,
        tax: fixture.billed_tax_11,
        grand_total: fixture.billed_total,
        confidence_score: 0.94,
      },
      masterPOList,
      []
    );

    assert.equal(result.audit_status, fixture.expected_status);
    assert.equal(result.requires_human_review, true);
    assert.equal(result.variance, 500000);
    assert.deepEqual(result.checked_rules, [
      'GATE_1_CONFIDENCE_THRESHOLD',
      'GATE_2_DUPLICATE_CHECK',
      'GATE_3_PO_VALIDATION',
      'GATE_4_DETERMINISTIC_MATH_TAX',
    ]);
  });

  it('7. Unit price variance (+10%) stops at Gate 5 -> HOLD - PRICE VARIANCE', () => {
    const fixture = findExpected('INV_06_price_variance_prima.pdf');
    const po = findPO(fixture.po_number);

    const result = auditInvoice(
      {
        invoice_number: fixture.invoice_number,
        po_number: fixture.po_number,
        vendor_name: fixture.vendor_name,
        qty: po.qty,
        unit_price: fixture.billed_unit_price,
        subtotal: fixture.billed_subtotal,
        tax: fixture.billed_tax_11,
        grand_total: fixture.billed_total,
        confidence_score: 0.97,
      },
      masterPOList,
      []
    );

    assert.equal(result.audit_status, fixture.expected_status);
    assert.equal(result.requires_human_review, true);
    assert.equal(result.variance, fixture.billed_total - po.expected_total);
    assert.equal(result.invoiced_total, fixture.billed_total);
    assert.equal(result.po_total, po.expected_total);
  });

  it('8. Null or empty fields do not crash and return valid schema', () => {
    const nullResult = auditInvoice(null, null, null);
    assert.equal(nullResult.audit_status, 'HUMAN REVIEW');
    assert.equal(nullResult.requires_human_review, true);
    assert.equal(nullResult.invoice_number, null);
    assert.equal(nullResult.po_number, null);
    assert.equal(nullResult.vendor_name, null);

    const partialNumericNullResult = auditInvoice(
      {
        invoice_number: 'INV/NULL/001',
        po_number: 'PO-2026-001',
        vendor_name: 'PT Nusantara Logistik',
        qty: null,
        unit_price: '',
        grand_total: undefined,
        confidence_score: 0.95,
      },
      masterPOList,
      []
    );

    assert.equal(partialNumericNullResult.audit_status, 'HUMAN REVIEW');
    assert.equal(partialNumericNullResult.requires_human_review, true);
    assert.ok(Array.isArray(partialNumericNullResult.checked_rules));
  });
});
