'use strict';

const DEFAULT_APPROVAL_THRESHOLDS = {
  IDR: 25_000_000,
  USD: 2_500,
};

/**
 * Normalizes vendor names for fuzzy/consistent matching across invoices and POs.
 */
function normalizeVendor(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\b(pt|cv|tbk|ltd|inc|llc|corp|co)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Normalizes invoice numbers by stripping separators and common revision suffixes for comparison.
 */
function normalizeInvoiceNumber(invNo) {
  return String(invNo || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * Computes Levenshtein edit distance between two strings.
 */
function levenshteinDistance(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;

  const prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  const curr = new Array(t.length + 1);

  for (let i = 1; i <= s.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= t.length; j += 1) prev[j] = curr[j];
  }
  return prev[t.length];
}

function parseDateSafe(val) {
  if (!val) return null;
  const str = String(val).trim();
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function diffDays(dateA, dateB) {
  if (!dateA || !dateB) return null;
  return Math.abs(dateA.getTime() - dateB.getTime()) / (1000 * 60 * 60 * 24);
}

function median(numbers) {
  if (!numbers.length) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function isRoundAmount(amount, currency) {
  const val = Number(amount || 0);
  if (val <= 0) return false;
  const cur = String(currency || 'IDR').toUpperCase();
  if (cur === 'USD') {
    return val >= 500 && val % 500 === 0;
  }
  return val >= 1_000_000 && val % 1_000_000 === 0;
}

function extractLogInvoiceInfo(log) {
  const ext = log?.extraction_data || {};
  return {
    invoice_number: log.invoice_number || ext.invoice_number || '',
    vendor_name: log.vendor_name || ext.vendor_name || '',
    currency: String(log.currency || ext.currency || 'IDR').toUpperCase(),
    grand_total: Number(log.grand_total ?? ext.grand_total ?? ext.total_amount ?? 0),
    invoice_date: ext.invoice_date || log.created_at || null,
    line_items: Array.isArray(ext.line_items) ? ext.line_items : [],
  };
}

/**
 * Runs 4 local deterministic forensic & fraud detectors (0 AI tokens).
 * @param {object} invoiceData - Extracted invoice JSON
 * @param {Array} auditLogs - Historical audit logs in workspace
 * @param {Array} purchaseOrders - Workspace POs (for po_date & historical price baseline)
 * @param {object} [matchedPo] - Matched PO object if already resolved
 * @param {object} [options] - Threshold overrides
 */
function runForensicAnalysis(
  invoiceData = {},
  auditLogs = [],
  purchaseOrders = [],
  matchedPo = null,
  options = {}
) {
  const signals = [];
  const vendorNorm = normalizeVendor(invoiceData.vendor_name);
  const currency = String(invoiceData.currency || 'IDR').toUpperCase();
  const currentTotal = Number(invoiceData.grand_total ?? invoiceData.total_amount ?? 0);
  const currentInvNo = String(invoiceData.invoice_number || '').trim();
  const currentDate = parseDateSafe(invoiceData.invoice_date) || new Date();

  const splitWindowDays = options.splitWindowDays || 7;
  const threshold =
    options.approvalThreshold ||
    DEFAULT_APPROVAL_THRESHOLDS[currency] ||
    DEFAULT_APPROVAL_THRESHOLDS.IDR;

  const sameVendorLogs = (auditLogs || [])
    .map((log) => ({ raw: log, info: extractLogInvoiceInfo(log) }))
    .filter(({ info }) => vendorNorm && normalizeVendor(info.vendor_name) === vendorNorm);

  // 1. Split-Invoicing Detector (Pecah Faktur)
  if (currentTotal > 0 && currentTotal < threshold && sameVendorLogs.length > 0) {
    const nearbyBelowThreshold = sameVendorLogs.filter(({ info }) => {
      if (info.currency !== currency) return false;
      if (info.grand_total <= 0 || info.grand_total >= threshold) return false;
      const logDate = parseDateSafe(info.invoice_date);
      const days = diffDays(currentDate, logDate);
      return days !== null && days <= splitWindowDays;
    });

    if (nearbyBelowThreshold.length >= 1) {
      const combined =
        currentTotal + nearbyBelowThreshold.reduce((acc, x) => acc + x.info.grand_total, 0);
      if (combined > threshold) {
        signals.push({
          code: 'FORENSIC_SPLIT_INVOICING',
          title: 'Split-Invoicing Pattern Detected',
          severity: 'HIGH',
          score_delta: 38,
          detail: `${nearbyBelowThreshold.length + 1} invoices from "${invoiceData.vendor_name}" within ${splitWindowDays} days are each below ${currency} ${threshold.toLocaleString('en-US')}, but their combined total (${currency} ${combined.toLocaleString('en-US')}) exceeds the approval threshold.`,
          related_invoices: nearbyBelowThreshold.map((x) => x.info.invoice_number).filter(Boolean),
        });
      }
    }
  }

  // 2. Vendor Price-Creep Memory (>3% above historical vendor/SKU median)
  const currentLines =
    Array.isArray(invoiceData.line_items) && invoiceData.line_items.length > 0
      ? invoiceData.line_items
      : invoiceData.item_name
        ? [{ item_name: invoiceData.item_name, unit_price: invoiceData.unit_price }]
        : [];

  if (vendorNorm && currentLines.length > 0) {
    const priceCreepFindings = [];
    for (const line of currentLines) {
      const curPrice = Number(line.unit_price || 0);
      const itemKey = String(line.sku || line.item_name || line.description || '')
        .trim()
        .toLowerCase();
      if (!curPrice || !itemKey) continue;

      const historicalPrices = [];
      for (const { info } of sameVendorLogs) {
        if (info.currency !== currency) continue;
        for (const hLine of info.line_items) {
          const hKey = String(hLine.sku || hLine.item_name || hLine.description || '')
            .trim()
            .toLowerCase();
          const hPrice = Number(hLine.unit_price || 0);
          if (hPrice > 0 && hKey && (hKey === itemKey || hKey.includes(itemKey) || itemKey.includes(hKey))) {
            historicalPrices.push(hPrice);
          }
        }
      }

      if (historicalPrices.length > 0) {
        const baseline = median(historicalPrices);
        const pctIncrease = ((curPrice - baseline) / baseline) * 100;
        if (pctIncrease > 3) {
          priceCreepFindings.push({
            item: line.item_name || line.sku || itemKey,
            baseline,
            current: curPrice,
            pct: Number(pctIncrease.toFixed(1)),
          });
        }
      }
    }

    if (priceCreepFindings.length > 0) {
      const worst = priceCreepFindings.sort((a, b) => b.pct - a.pct)[0];
      signals.push({
        code: 'FORENSIC_PRICE_CREEP',
        title: 'Vendor Price-Creep Anomaly',
        severity: worst.pct >= 10 ? 'HIGH' : 'MEDIUM',
        score_delta: worst.pct >= 10 ? 30 : 20,
        detail: `Unit price for "${worst.item}" (${currency} ${worst.current.toLocaleString('en-US')}) increased by +${worst.pct}% vs historical vendor median (${currency} ${worst.baseline.toLocaleString('en-US')}).`,
      });
    }
  }

  // 3. Fuzzy Duplicate Trap (Levenshtein <= 2 on normalized invoice #, same vendor, ±1% amount, ±14 days)
  const normCurInv = normalizeInvoiceNumber(currentInvNo);
  if (normCurInv && vendorNorm && currentTotal > 0) {
    const fuzzyMatches = sameVendorLogs.filter(({ info }) => {
      const normHistInv = normalizeInvoiceNumber(info.invoice_number);
      if (!normHistInv || normHistInv === normCurInv) return false;
      const dist = levenshteinDistance(normCurInv, normHistInv);
      if (dist > 2) return false;

      const amountDiffPct =
        info.grand_total > 0 ? Math.abs(currentTotal - info.grand_total) / info.grand_total : 1;
      if (amountDiffPct > 0.01) return false;

      const logDate = parseDateSafe(info.invoice_date);
      const days = diffDays(currentDate, logDate);
      return days === null || days <= 14;
    });

    if (fuzzyMatches.length > 0) {
      signals.push({
        code: 'FORENSIC_FUZZY_DUPLICATE',
        title: 'Fuzzy Duplicate Invoice Suspected',
        severity: 'HIGH',
        score_delta: 40,
        detail: `Invoice "${currentInvNo}" closely resembles prior invoice "${fuzzyMatches[0].info.invoice_number}" from the same vendor with nearly identical amount (±1%) within 14 days.`,
        related_invoices: fuzzyMatches.map((m) => m.info.invoice_number).filter(Boolean),
      });
    }
  }

  // 4. Chronology & Round-Number Anomalies
  const poObj =
    matchedPo ||
    (purchaseOrders || []).find(
      (p) =>
        String(p.po_number || '').trim().toUpperCase() ===
        String(invoiceData.po_number || '').trim().toUpperCase()
    );
  const invDateParsed = parseDateSafe(invoiceData.invoice_date);
  const poDateParsed = parseDateSafe(poObj?.po_date || poObj?.created_at);

  if (invDateParsed && poDateParsed && invDateParsed.getTime() < poDateParsed.getTime() - 86_400_000) {
    signals.push({
      code: 'FORENSIC_BACKDATED_INVOICE',
      title: 'After-the-Fact PO / Backdated Invoice',
      severity: 'HIGH',
      score_delta: 30,
      detail: `Invoice date (${invDateParsed.toISOString().slice(0, 10)}) precedes PO date (${poDateParsed.toISOString().slice(0, 10)}), indicating a possible after-the-fact PO.`,
    });
  }

  if (invDateParsed) {
    const day = invDateParsed.getUTCDay();
    if (day === 0 || day === 6) {
      signals.push({
        code: 'FORENSIC_WEEKEND_ISSUE',
        title: 'Weekend Invoice Issuance',
        severity: 'LOW',
        score_delta: 12,
        detail: `Invoice date (${invDateParsed.toISOString().slice(0, 10)}) falls on a weekend (${day === 0 ? 'Sunday' : 'Saturday'}).`,
      });
    }
  }

  if (isRoundAmount(currentTotal, currency)) {
    const priorRoundCount = sameVendorLogs.filter(({ info }) =>
      isRoundAmount(info.grand_total, info.currency)
    ).length;
    if (priorRoundCount >= 1) {
      signals.push({
        code: 'FORENSIC_ROUND_NUMBER_PATTERN',
        title: 'Repeated Round-Number Billing',
        severity: 'MEDIUM',
        score_delta: 20,
        detail: `Invoice total (${currency} ${currentTotal.toLocaleString('en-US')}) is an exact round figure, repeating ${priorRoundCount + 1}x for "${invoiceData.vendor_name}".`,
      });
    } else {
      signals.push({
        code: 'FORENSIC_ROUND_NUMBER_SINGLE',
        title: 'Exact Round-Number Amount',
        severity: 'LOW',
        score_delta: 10,
        detail: `Invoice total (${currency} ${currentTotal.toLocaleString('en-US')}) is an exact round figure.`,
      });
    }
  }

  const rawScore = signals.reduce((sum, s) => sum + (s.score_delta || 0), 0);
  const forensic_risk_score = Math.min(100, rawScore);
  const forensic_level =
    forensic_risk_score >= 50 ? 'HIGH_RISK' : forensic_risk_score >= 20 ? 'WATCH' : 'CLEAN';

  return {
    forensic_signals: signals,
    forensic_risk_score,
    forensic_level,
  };
}

module.exports = {
  DEFAULT_APPROVAL_THRESHOLDS,
  normalizeVendor,
  normalizeInvoiceNumber,
  levenshteinDistance,
  runForensicAnalysis,
};
