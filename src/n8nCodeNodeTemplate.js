/**
 * AUTO-GENERATED FILE — DO NOT EDIT DIRECTLY.
 * Source of truth: src/auditEngine.js (run `npm run build:n8n` to regenerate).
 *
 * n8n Code Node Template v3 (Mode: Run Once for All Items)
 * Input items (`$input.all()`) may carry:
 *  - `extracted_invoice` (or flat invoice fields on `item.json`)
 *  - `master_po_list` (array of Master_PO rows)
 *  - `existing_audit_logs` (optional array, default `[]`)
 *  - `vendor_master` (optional array for Gate 6 Anti-BEC check, default `[]`)
 *  - `policy_config` (optional policy overrides)
 */
const CONFIDENCE_THRESHOLD = 0.85;
const PPN_RATE = 0.11;
const PPH23_RATE = 0.02;
const ROUNDING_TOLERANCE_IDR = 100;
const MAX_CEILING_VARIANCE_PCT = 5;

const DEFAULT_POLICY_CONFIG = {
  priceTolerancePct: 0,
  autoApproveCeiling: 0,
  mandatoryGrnThreshold: 0,
  splitThreshold: 25_000_000,
  splitWindowDays: 7,
  ppnRatePct: 11,
  pphRatePct: 2,
  fxUsdIdr: 16000,
  fxSgdIdr: 12000,
  itemAliases: [],
  forbiddenFeeKeywords: ['admin fee', 'handling charge', 'surcharge', 'misc fee', 'biaya tak terduga'],
};

function resolvePolicyConfig(rawPolicy) {
  const p = rawPolicy && typeof rawPolicy === 'object' ? rawPolicy : {};
  const keywords = Array.isArray(p.forbiddenFeeKeywords)
    ? p.forbiddenFeeKeywords.map((k) => String(k || '').trim().toLowerCase()).filter(Boolean)
    : typeof p.forbiddenFeeKeywords === 'string'
      ? p.forbiddenFeeKeywords.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean)
      : DEFAULT_POLICY_CONFIG.forbiddenFeeKeywords;

  const aliases = Array.isArray(p.itemAliases)
    ? p.itemAliases
        .filter((a) => a && a.invoice_item && a.po_item)
        .map((a) => ({
          invoice_item: normalizeItemName(a.invoice_item),
          po_item: normalizeItemName(a.po_item),
        }))
    : [];

  return {
    priceTolerancePct: Math.max(0, Math.min(25, Number(p.priceTolerancePct) || 0)),
    autoApproveCeiling: Math.max(0, Number(p.autoApproveCeiling) || 0),
    mandatoryGrnThreshold: Math.max(0, Number(p.mandatoryGrnThreshold) || 0),
    splitThreshold: Math.max(0, Number(p.splitThreshold) || DEFAULT_POLICY_CONFIG.splitThreshold),
    splitWindowDays: Math.max(1, Number(p.splitWindowDays) || DEFAULT_POLICY_CONFIG.splitWindowDays),
    ppnRatePct: p.ppnRatePct !== undefined && p.ppnRatePct !== '' ? Math.max(0, Number(p.ppnRatePct) || 0) : DEFAULT_POLICY_CONFIG.ppnRatePct,
    pphRatePct: p.pphRatePct !== undefined && p.pphRatePct !== '' ? Math.max(0, Number(p.pphRatePct) || 0) : DEFAULT_POLICY_CONFIG.pphRatePct,
    fxUsdIdr: Math.max(1, Number(p.fxUsdIdr) || DEFAULT_POLICY_CONFIG.fxUsdIdr),
    fxSgdIdr: Math.max(1, Number(p.fxSgdIdr) || DEFAULT_POLICY_CONFIG.fxSgdIdr),
    itemAliases: aliases,
    forbiddenFeeKeywords: keywords,
  };
}

function isWithinPriceTolerance(invoicedPrice, poPrice, priceTolerancePct) {
  const diff = Math.abs(invoicedPrice - poPrice);
  const allowed =
    priceTolerancePct > 0
      ? Math.max(ROUNDING_TOLERANCE_IDR, Math.abs(poPrice) * (priceTolerancePct / 100))
      : ROUNDING_TOLERANCE_IDR;
  return diff <= allowed;
}
const USD_TO_IDR_RATE = 16000;
const INPUT_COST_PER_MILLION_USD = 0.10;
const OUTPUT_COST_PER_MILLION_USD = 0.40;

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') {
    return NaN;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : NaN;
}

function toTrimmedString(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
}

function normalizePoNumber(poNumber) {
  return toTrimmedString(poNumber)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeCurrency(currency) {
  const code = toTrimmedString(currency).toUpperCase();
  if (!code || code === 'RP' || code === 'RUPIAH') {
    return 'IDR';
  }
  return code;
}

const OCR_DEGRADATION_PATTERN = /\b(blur|blurry|noise|noisy|stain|stained|fold|folded|unclear|buram|noda|lipatan|samar|bercak)\b/i;

function hasOcrDegradation(extractionNotes, rawPoNumber) {
  const notes = toTrimmedString(extractionNotes);
  if (notes && OCR_DEGRADATION_PATTERN.test(notes)) {
    return true;
  }
  const rawPo = toTrimmedString(rawPoNumber);
  if (!rawPo) {
    return false;
  }
  if (/[?*_~|]/.test(rawPo)) {
    return true;
  }
  return !/[A-Z]{2,}[-/\s]*\d{4}[-/\s]*\d{2,}/i.test(rawPo);
}

function normalizeItemName(name) {
  return toTrimmedString(name)
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeAccountNumber(acc) {
  return toTrimmedString(acc)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function normalizeTaxId(npwp) {
  return toTrimmedString(npwp).replace(/\D/g, '');
}

function findMatchingVendor(vendorName, vendorMasterList = []) {
  const target = normalizeItemName(vendorName);
  if (!target || !Array.isArray(vendorMasterList) || vendorMasterList.length === 0) {
    return null;
  }
  return (
    vendorMasterList.find((v) => v && normalizeItemName(v.vendor_name) === target) || null
  );
}

function formatIDR(amount) {
  const sign = amount < 0 ? '-' : '';
  return `${sign}Rp${Math.abs(Math.round(amount)).toLocaleString('id-ID')}`;
}

function calculateFinOpsCost(tokenUsage) {
  const usage = tokenUsage && typeof tokenUsage === 'object' ? tokenUsage : {};
  const promptTokens = toFiniteNumber(usage.promptTokenCount);
  const candidateTokens = toFiniteNumber(usage.candidatesTokenCount);
  const safePrompt = Number.isFinite(promptTokens) && promptTokens > 0 ? promptTokens : 0;
  const safeCandidates = Number.isFinite(candidateTokens) && candidateTokens > 0 ? candidateTokens : 0;

  const costUsd = Number(
    (
      (safePrompt * INPUT_COST_PER_MILLION_USD + safeCandidates * OUTPUT_COST_PER_MILLION_USD) /
      1_000_000
    ).toFixed(6)
  );
  const costIdr = Number((costUsd * USD_TO_IDR_RATE).toFixed(2));
  return {
    estimated_cost_usd: costUsd,
    estimated_cost_idr: costIdr,
  };
}

function buildAuditResult(payload) {
  return {
    invoice_number: payload.invoice_number,
    po_number: payload.po_number,
    vendor_name: payload.vendor_name,
    currency: payload.currency,
    invoiced_total: payload.invoiced_total,
    po_total: payload.po_total,
    variance: payload.variance,
    confidence_score: payload.confidence_score,
    audit_status: payload.audit_status,
    discrepancy_reason: payload.discrepancy_reason,
    policy_override_note: payload.policy_override_note || null,
    requires_human_review: payload.requires_human_review,
    checked_rules: payload.checked_rules,
    estimated_cost_usd: payload.estimated_cost_usd,
    estimated_cost_idr: payload.estimated_cost_idr,
  };
}

function tokenizeItemName(name) {
  return normalizeItemName(name)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function isSafeItemMatch(target, poName) {
  if (!target || !poName) return false;
  const shorterStr = target.length <= poName.length ? target : poName;
  if (shorterStr.length < 6) return false;

  const targetTokens = tokenizeItemName(target);
  const poTokens = tokenizeItemName(poName);
  if (!targetTokens.length || !poTokens.length) return false;

  const shorterTokens = targetTokens.length <= poTokens.length ? targetTokens : poTokens;
  const longerSet = new Set(targetTokens.length <= poTokens.length ? poTokens : targetTokens);
  if (!shorterTokens.every((t) => longerSet.has(t))) {
    return false;
  }

  const ratio = shorterTokens.length / Math.max(targetTokens.length, poTokens.length);
  if (ratio >= 0.6) {
    return true;
  }
  return poTokens.length >= 3 && target.startsWith(poName);
}

function findMatchingPoRow(lineItemName, poRows, itemAliases = []) {
  const target = normalizeItemName(lineItemName);
  if (!target) {
    return null;
  }

  const exact = poRows.find((row) => normalizeItemName(row.item_name) === target);
  if (exact) {
    return exact;
  }

  // Check learned Item & Vendor Alias Dictionary
  if (Array.isArray(itemAliases) && itemAliases.length > 0) {
    const aliasMatch = itemAliases.find((a) => a.invoice_item === target);
    if (aliasMatch) {
      const aliasedRow = poRows.find((row) => normalizeItemName(row.item_name) === aliasMatch.po_item);
      if (aliasedRow) return aliasedRow;
    }
  }

  // Allow safe token-bounded matches (e.g. minor suffix "(Partial 6/10)") without short-word false matches
  return (
    poRows.find((row) => isSafeItemMatch(target, normalizeItemName(row.item_name))) || null
  );
}

function computePriorBilledQty(canonicalPoNumber, poItemName, auditLogs, itemAliases) {
  if (!canonicalPoNumber || !Array.isArray(auditLogs) || auditLogs.length === 0) {
    return 0;
  }
  const approvedStatuses = new Set(['APPROVED', 'APPROVED - PARTIAL', 'MANUAL APPROVED']);
  const targetRow = [{ item_name: poItemName }];
  let totalPrior = 0;

  for (const log of auditLogs) {
    if (!log || normalizePoNumber(log.po_number) !== canonicalPoNumber) continue;
    const status = String(log.audit_status || '').trim().toUpperCase();
    if (!approvedStatuses.has(status)) continue;

    const ext = log.extraction_data && typeof log.extraction_data === 'object' ? log.extraction_data : {};
    const lines = Array.isArray(ext.line_items) && ext.line_items.length > 0
      ? ext.line_items
      : Number.isFinite(toFiniteNumber(ext.qty ?? log.qty))
        ? [{ item_name: ext.item_name || poItemName, qty: toFiniteNumber(ext.qty ?? log.qty) }]
        : [];

    for (const ln of lines) {
      const lnQty = toFiniteNumber(ln?.qty);
      if (!Number.isFinite(lnQty) || lnQty <= 0) continue;
      if (findMatchingPoRow(ln?.item_name || '', targetRow, itemAliases)) {
        totalPrior += lnQty;
      }
    }
  }
  return totalPrior;
}

function canAutoApproveCeiling({ policy, invoicedTotal, poTotal, hasOverQty, maxDeviationPct }) {
  if (!(policy.autoApproveCeiling > 0 && invoicedTotal > 0 && invoicedTotal <= policy.autoApproveCeiling)) {
    return false;
  }
  if (hasOverQty) {
    return false;
  }
  if (maxDeviationPct > MAX_CEILING_VARIANCE_PCT) {
    return false;
  }
  const allowedTotalDiff = Math.max(ROUNDING_TOLERANCE_IDR, Math.abs(poTotal) * (MAX_CEILING_VARIANCE_PCT / 100));
  return Math.abs(invoicedTotal - poTotal) <= allowedTotalDiff;
}

/**
 * Deterministic 5-Gate Corporate AP Audit Engine (v2, backward-compatible with v1).
 *
 * @param {object} extractedInvoice
 * @param {Array<object>} masterPOList
 * @param {Array<object>} [existingAuditLogs=[]]
 * @param {object} [options={}]
 * @returns {object}
 */
function auditInvoice(extractedInvoice, masterPOList = [], existingAuditLogs = [], options = {}) {
  const invoice = extractedInvoice && typeof extractedInvoice === 'object' ? extractedInvoice : {};
  const poList = Array.isArray(masterPOList) ? masterPOList : [];
  const auditLogs = Array.isArray(existingAuditLogs) ? existingAuditLogs : [];

  const invoiceNumber = toTrimmedString(invoice.invoice_number) || null;
  const rawPoNumber = toTrimmedString(invoice.po_number) || null;
  const canonicalPoNumber = rawPoNumber ? normalizePoNumber(rawPoNumber) : null;
  const vendorName = toTrimmedString(invoice.vendor_name) || null;
  const fileHash = toTrimmedString(invoice.file_hash).toLowerCase() || null;
  const hasExplicitCurrency = Boolean(toTrimmedString(invoice.currency));
  const invoicedCurrency = hasExplicitCurrency ? normalizeCurrency(invoice.currency) : null;

  const confidenceScore = toFiniteNumber(invoice.confidence_score);
  const invoicedTotal = toFiniteNumber(
    invoice.grand_total ?? invoice.billed_total ?? invoice.invoiced_total
  );
  const invoicedPpn = toFiniteNumber(
    invoice.ppn_amount ?? invoice.tax ?? invoice.tax_amount ?? invoice.billed_tax_11
  );
  const invoicedPph23Raw = toFiniteNumber(invoice.pph23_amount);
  const invoicedPph23 = Number.isFinite(invoicedPph23Raw) ? Math.abs(invoicedPph23Raw) : 0;

  const finOps = calculateFinOpsCost(options.token_usage ?? invoice.token_usage);
  const checkedRules = [];
  const policy = resolvePolicyConfig(options.policyConfig);
  const basePayload = {
    invoice_number: invoiceNumber,
    po_number: canonicalPoNumber || rawPoNumber,
    vendor_name: vendorName,
    currency: invoicedCurrency || 'IDR',
    invoiced_total: Number.isFinite(invoicedTotal) ? invoicedTotal : null,
    po_total: null,
    variance: null,
    confidence_score: Number.isFinite(confidenceScore) ? confidenceScore : null,
    checked_rules: checkedRules,
    ...finOps,
  };

  // Gate 1: Confidence Threshold
  checkedRules.push('GATE_1_CONFIDENCE_THRESHOLD');
  if (!Number.isFinite(confidenceScore) || confidenceScore < CONFIDENCE_THRESHOLD) {
    const scoreDisplay = Number.isFinite(confidenceScore) ? confidenceScore : 'null/invalid';
    return buildAuditResult({
      ...basePayload,
      audit_status: 'HUMAN REVIEW',
      discrepancy_reason: `Confidence score OCR (${scoreDisplay}) berada di bawah ambang batas ${CONFIDENCE_THRESHOLD}.`,
      requires_human_review: true,
    });
  }

  // Gate 2: Idempotency / Duplicate Check (SHA-256 file_hash + invoice_number & vendor_name)
  checkedRules.push('GATE_2_DUPLICATE_CHECK');
  if (fileHash) {
    const isHashDuplicate = auditLogs.some(
      (log) => log && toTrimmedString(log.file_hash).toLowerCase() === fileHash
    );
    if (isHashDuplicate) {
      return buildAuditResult({
        ...basePayload,
        audit_status: 'HOLD - DUPLICATE',
        discrepancy_reason: `Duplicate file terdeteksi berdasarkan SHA-256 hash (${fileHash.slice(0, 12)}...).`,
        requires_human_review: true,
      });
    }
  }

  if (invoiceNumber && vendorName) {
    const invKey = invoiceNumber.toLowerCase();
    const vendorKey = vendorName.toLowerCase();
    const isDuplicate = auditLogs.some(
      (log) =>
        log &&
        toTrimmedString(log.invoice_number).toLowerCase() === invKey &&
        toTrimmedString(log.vendor_name).toLowerCase() === vendorKey
    );

    if (isDuplicate) {
      return buildAuditResult({
        ...basePayload,
        audit_status: 'HOLD - DUPLICATE',
        discrepancy_reason: `Duplicate billing terdeteksi untuk invoice "${invoiceNumber}" dari vendor "${vendorName}".`,
        requires_human_review: true,
      });
    }
  }

  // Gate 3: PO Validation (supports canonical PO normalization & multi-item PO rows)
  checkedRules.push('GATE_3_PO_VALIDATION');
  const matchedPORows = canonicalPoNumber
    ? poList.filter((po) => po && normalizePoNumber(po.po_number) === canonicalPoNumber)
    : [];

  if (matchedPORows.length === 0) {
    if (hasOcrDegradation(invoice.extraction_notes, rawPoNumber)) {
      return buildAuditResult({
        ...basePayload,
        audit_status: 'HUMAN REVIEW',
        discrepancy_reason: `PO "${rawPoNumber || 'kosong'}" tidak ditemukan dan terindikasi degradasi OCR pada dokumen/nomor PO.`,
        requires_human_review: true,
      });
    }
    return buildAuditResult({
      ...basePayload,
      audit_status: 'HOLD - INVALID PO',
      discrepancy_reason: `PO "${rawPoNumber || 'kosong'}" tidak ditemukan di Master PO.`,
      requires_human_review: true,
    });
  }

  const closedRow = matchedPORows.find(
    (po) => toTrimmedString(po.status).toUpperCase() !== 'OPEN'
  );
  if (closedRow) {
    return buildAuditResult({
      ...basePayload,
      audit_status: 'HOLD - INVALID PO',
      discrepancy_reason: `PO "${canonicalPoNumber}" berstatus "${toTrimmedString(closedRow.status) || 'UNKNOWN'}", bukan OPEN.`,
      requires_human_review: true,
    });
  }

  const poType = toTrimmedString(matchedPORows[0].po_type).toUpperCase() || 'GOODS';
  const poCurrency = normalizeCurrency(matchedPORows[0].currency || 'IDR');

  let poTotal = 0;
  if (
    matchedPORows.length === 1 &&
    Number.isFinite(toFiniteNumber(matchedPORows[0].expected_total))
  ) {
    poTotal = toFiniteNumber(matchedPORows[0].expected_total);
  } else {
    let poSubtotal = 0;
    for (const row of matchedPORows) {
      const rQty = toFiniteNumber(row.qty);
      const rPrice = toFiniteNumber(row.unit_price);
      const rSub = Number.isFinite(toFiniteNumber(row.expected_subtotal))
        ? toFiniteNumber(row.expected_subtotal)
        : rQty * rPrice;
      poSubtotal += rSub;
    }
    const ppnRate = policy.ppnRatePct / 100;
    const pphRate = policy.pphRatePct / 100;
    const poPpn = Math.round(poSubtotal * ppnRate);
    const poPph23 = poType === 'SERVICE' ? Math.round(poSubtotal * pphRate) : 0;
    poTotal = poSubtotal + poPpn - poPph23;
  }

  basePayload.po_total = Number.isFinite(poTotal) ? poTotal : null;
  if (!hasExplicitCurrency) {
    basePayload.currency = poCurrency;
  }

  // Gate 3B: Currency Guard
  if (hasExplicitCurrency) {
    checkedRules.push('GATE_3B_CURRENCY_GUARD');
    if (invoicedCurrency !== poCurrency) {
      return buildAuditResult({
        ...basePayload,
        audit_status: 'HOLD - CURRENCY MISMATCH',
        discrepancy_reason: `Ketidaksesuaian mata uang: invoice ditagihkan dalam ${invoicedCurrency}, sedangkan PO "${canonicalPoNumber}" menggunakan ${poCurrency}.`,
        requires_human_review: true,
      });
    }
  }

  // Gate 6: Vendor Master Anti-BEC Bank Account & NPWP Fraud Guard (hard block; never auto-approved)
  const vendorMaster = Array.isArray(options.vendorMaster) ? options.vendorMaster : [];
  if (vendorMaster.length > 0) {
    checkedRules.push('GATE_6_VENDOR_BANK_GUARD');
    const lookupName = vendorName || toTrimmedString(matchedPORows[0].vendor_name);
    const matchedVendor = findMatchingVendor(lookupName, vendorMaster);
    if (matchedVendor) {
      const vendorStatus = toTrimmedString(matchedVendor.status).toUpperCase() || 'ACTIVE';
      if (vendorStatus !== 'ACTIVE') {
        return buildAuditResult({
          ...basePayload,
          audit_status: 'HOLD - VENDOR BLOCKED',
          discrepancy_reason: `Vendor "${matchedVendor.vendor_name}" berstatus "${vendorStatus}" di Vendor Master. Pembayaran diblokir.`,
          requires_human_review: true,
        });
      }

      const invoiceAccount = normalizeAccountNumber(invoice.bank_account_number);
      const registeredAccount = normalizeAccountNumber(matchedVendor.bank_account_number);
      if (invoiceAccount && registeredAccount && invoiceAccount !== registeredAccount) {
        const invBank = toTrimmedString(invoice.bank_name) || 'Unknown Bank';
        const regBank = toTrimmedString(matchedVendor.bank_name) || 'Registered Bank';
        return buildAuditResult({
          ...basePayload,
          audit_status: 'HOLD - BANK ACCOUNT MISMATCH',
          discrepancy_reason:
            `Anti-BEC Fraud Guard: rekening transfer pada faktur (${invBank} ${toTrimmedString(invoice.bank_account_number)}) ` +
            `tidak cocok dengan Vendor Master (${regBank} ${toTrimmedString(matchedVendor.bank_account_number)}).`,
          requires_human_review: true,
        });
      }

      const invoiceNpwp = normalizeTaxId(invoice.vendor_npwp);
      const registeredNpwp = normalizeTaxId(matchedVendor.npwp);
      if (invoiceNpwp && registeredNpwp && invoiceNpwp !== registeredNpwp) {
        return buildAuditResult({
          ...basePayload,
          audit_status: 'HUMAN REVIEW',
          discrepancy_reason:
            `NPWP vendor pada faktur (${toTrimmedString(invoice.vendor_npwp)}) berbeda dengan Vendor Master (${toTrimmedString(matchedVendor.npwp)}).`,
          requires_human_review: true,
        });
      }
    }
  }

  // Normalize line items (v2 line_items array OR v1 flat qty/unit_price)
  const hasLineItemsArray = Array.isArray(invoice.line_items) && invoice.line_items.length > 0;
  const hasExplicitSingleItemName = !hasLineItemsArray && Boolean(toTrimmedString(invoice.item_name));
  let normalizedLines = [];

  if (hasLineItemsArray) {
    for (const item of invoice.line_items) {
      const lQty = toFiniteNumber(item?.qty);
      const lPrice = toFiniteNumber(item?.unit_price);
      if (!Number.isFinite(lQty) || !Number.isFinite(lPrice)) {
        return buildAuditResult({
          ...basePayload,
          audit_status: 'HUMAN REVIEW',
          discrepancy_reason: 'Baris line_items memiliki qty atau unit_price yang kosong/tidak valid.',
          requires_human_review: true,
        });
      }
      if (lQty <= 0 || lPrice < 0) {
        return buildAuditResult({
          ...basePayload,
          audit_status: 'HOLD - PRICE VARIANCE',
          discrepancy_reason: `Baris "${toTrimmedString(item?.item_name) || 'item'}" memiliki qty (${lQty}) <= 0 atau unit_price (${lPrice}) negatif.`,
          requires_human_review: true,
        });
      }
      normalizedLines.push({
        item_name: toTrimmedString(item?.item_name),
        qty: lQty,
        unit_price: lPrice,
        line_total: Number.isFinite(toFiniteNumber(item?.line_total))
          ? toFiniteNumber(item.line_total)
          : lQty * lPrice,
      });
    }
    if (!Number.isFinite(invoicedTotal)) {
      return buildAuditResult({
        ...basePayload,
        audit_status: 'HUMAN REVIEW',
        discrepancy_reason: 'Field grand_total invoice kosong atau tidak valid.',
        requires_human_review: true,
      });
    }
    if (invoicedTotal < 0) {
      return buildAuditResult({
        ...basePayload,
        audit_status: 'HOLD - PRICE VARIANCE',
        discrepancy_reason: `Grand total invoice tidak boleh negatif (${formatIDR(invoicedTotal)}).`,
        requires_human_review: true,
      });
    }
  } else {
    const invoicedQty = toFiniteNumber(invoice.qty);
    const invoicedUnitPrice = toFiniteNumber(invoice.unit_price ?? invoice.billed_unit_price);
    if (!Number.isFinite(invoicedQty) || !Number.isFinite(invoicedUnitPrice) || !Number.isFinite(invoicedTotal)) {
      return buildAuditResult({
        ...basePayload,
        audit_status: 'HUMAN REVIEW',
        discrepancy_reason: 'Field numerik invoice (qty, unit_price, atau grand_total) kosong atau tidak valid.',
        requires_human_review: true,
      });
    }
    if (invoicedQty <= 0 || invoicedUnitPrice < 0 || invoicedTotal < 0) {
      return buildAuditResult({
        ...basePayload,
        audit_status: 'HOLD - PRICE VARIANCE',
        discrepancy_reason: `Field numerik invoice tidak valid: qty (${invoicedQty}) <= 0 atau nominal negatif.`,
        requires_human_review: true,
      });
    }
    normalizedLines = [
      {
        item_name: toTrimmedString(invoice.item_name) || toTrimmedString(matchedPORows[0].item_name),
        qty: invoicedQty,
        unit_price: invoicedUnitPrice,
        line_total: invoicedQty * invoicedUnitPrice,
      },
    ];
  }

  // Gate 4: Deterministic Multi-Tax Engine (Dynamic PPN% & PPh% for SERVICE + printed subtotal check)
  checkedRules.push('GATE_4_DETERMINISTIC_MATH_TAX');
  const ppnRate = policy.ppnRatePct / 100;
  const pphRate = policy.pphRatePct / 100;
  const expectedSubtotal = normalizedLines.reduce((sum, line) => sum + line.qty * line.unit_price, 0);
  const invoicedSubtotal = toFiniteNumber(invoice.subtotal);
  const expectedPpn = Math.round(expectedSubtotal * ppnRate);
  const expectedPph23 = poType === 'SERVICE' ? Math.round(expectedSubtotal * pphRate) : 0;
  const expectedTotal = expectedSubtotal + expectedPpn - expectedPph23;

  const subtotalDiff = Number.isFinite(invoicedSubtotal) ? invoicedSubtotal - expectedSubtotal : 0;
  const ppnDiff = Number.isFinite(invoicedPpn) ? invoicedPpn - expectedPpn : 0;
  const pph23Diff =
    poType === 'SERVICE' || Number.isFinite(invoicedPph23Raw)
      ? invoicedPph23 - expectedPph23
      : 0;
  const totalDiff = invoicedTotal - expectedTotal;

  if (
    (Number.isFinite(invoicedSubtotal) && Math.abs(subtotalDiff) > ROUNDING_TOLERANCE_IDR) ||
    (Number.isFinite(invoicedPpn) && Math.abs(ppnDiff) > ROUNDING_TOLERANCE_IDR) ||
    Math.abs(pph23Diff) > ROUNDING_TOLERANCE_IDR ||
    Math.abs(totalDiff) > ROUNDING_TOLERANCE_IDR
  ) {
    const nominalDiff =
      Math.abs(totalDiff) > ROUNDING_TOLERANCE_IDR
        ? totalDiff
        : Math.abs(subtotalDiff) > ROUNDING_TOLERANCE_IDR
          ? subtotalDiff
          : ppnDiff || pph23Diff;
    return buildAuditResult({
      ...basePayload,
      variance: nominalDiff,
      audit_status: 'HOLD - TAX ERROR',
      discrepancy_reason:
        `Kesalahan perhitungan subtotal/pajak/Grand Total (${poType}) sebesar ${formatIDR(nominalDiff)} ` +
        `(tertagih ${formatIDR(invoicedTotal)}, seharusnya ${formatIDR(expectedTotal)}; ` +
        `Subtotal seharusnya ${formatIDR(expectedSubtotal)}, PPN ${policy.ppnRatePct}% seharusnya ${formatIDR(expectedPpn)}, PPh 23 seharusnya ${formatIDR(expectedPph23)}).`,
      requires_human_review: true,
    });
  }

  // Gate 5: Multi-Item Line Matching, Forbidden Keywords, Unordered Item, 3-Way GRN Match & Partial Delivery
  checkedRules.push('GATE_5_PO_MATCHING_VARIANCE');
  const poVariance = invoicedTotal - poTotal;
  const unorderedItems = [];
  const forbiddenFeeItems = [];
  const mismatchReasons = [];
  const grnMismatchReasons = [];
  let isPartialDelivery = false;
  let hasOverQty = false;
  let maxDeviationPct = 0;
  let policyOverrideNote = null;

  // Policy: Forbidden Fee Keywords check across all lines
  for (const line of normalizedLines) {
    const lowerName = normalizeItemName(line.item_name);
    const matchedKw = policy.forbiddenFeeKeywords.find((kw) => kw && lowerName.includes(kw));
    if (matchedKw) {
      forbiddenFeeItems.push({ ...line, matchedKw });
    }
  }
  if (forbiddenFeeItems.length > 0) {
    const forbiddenTotal = forbiddenFeeItems.reduce((sum, i) => sum + i.line_total, 0);
    const names = forbiddenFeeItems.map((i) => `"${i.item_name}" [${i.matchedKw}]`).join(', ');
    return buildAuditResult({
      ...basePayload,
      variance: forbiddenTotal,
      audit_status: 'HOLD - UNORDERED ITEM',
      discrepancy_reason: `Biaya terlarang (Policy Blacklist) terdeteksi pada PO "${canonicalPoNumber}": ${names} (total ${formatIDR(forbiddenTotal)}).`,
      requires_human_review: true,
    });
  }

  // Policy: Mandatory GRN Threshold
  if (policy.mandatoryGrnThreshold > 0 && invoicedTotal >= policy.mandatoryGrnThreshold) {
    const hasAnyGrn = matchedPORows.some((row) => Number.isFinite(toFiniteNumber(row.grn_received_qty)));
    if (!hasAnyGrn) {
      checkedRules.push('GATE_5B_3WAY_GRN_MATCH');
      return buildAuditResult({
        ...basePayload,
        variance: poVariance,
        audit_status: 'HOLD - GRN MISMATCH',
        discrepancy_reason: `Mandatory 3-Way Match: tagihan ${formatIDR(invoicedTotal)} melebihi ambang kebijakan (${formatIDR(policy.mandatoryGrnThreshold)}), namun bukti GRN gudang belum tercatat.`,
        requires_human_review: true,
      });
    }
  }

  if (hasLineItemsArray || matchedPORows.length > 1) {
    const matchedPoKeys = new Set();
    const cumulativeQtyByPoKey = new Map();
    const poRowByKey = new Map();

    for (const line of normalizedLines) {
      const poRow = findMatchingPoRow(line.item_name, matchedPORows, policy.itemAliases);
      if (!poRow) {
        unorderedItems.push(line);
        continue;
      }

      const poKey = normalizeItemName(poRow.item_name);
      matchedPoKeys.add(poKey);
      poRowByKey.set(poKey, poRow);
      const nextCumulativeQty = (cumulativeQtyByPoKey.get(poKey) || 0) + line.qty;
      cumulativeQtyByPoKey.set(poKey, nextCumulativeQty);

      const poQty = toFiniteNumber(poRow.qty);
      const poUnitPrice = toFiniteNumber(poRow.unit_price);
      const grnQty = toFiniteNumber(poRow.grn_received_qty);
      const priorFromLogs = computePriorBilledQty(canonicalPoNumber, poRow.item_name, auditLogs, policy.itemAliases);
      const rawRemaining = toFiniteNumber(poRow.remaining_qty);
      const poCapacityLeft = Math.max(0, poQty - priorFromLogs);
      const effectiveRemaining = Number.isFinite(rawRemaining)
        ? Math.min(rawRemaining, poCapacityLeft)
        : poCapacityLeft;
      const alreadyBilled = Math.max(0, poQty - effectiveRemaining);

      if (!isWithinPriceTolerance(line.unit_price, poUnitPrice, policy.priceTolerancePct)) {
        const devPct = poUnitPrice > 0 ? (Math.abs(line.unit_price - poUnitPrice) / poUnitPrice) * 100 : 100;
        if (devPct > maxDeviationPct) maxDeviationPct = devPct;
        mismatchReasons.push(
          `${line.item_name}: harga satuan tertagih ${formatIDR(line.unit_price)} vs PO ${formatIDR(poUnitPrice)}`
        );
      }
      if (nextCumulativeQty > effectiveRemaining) {
        hasOverQty = true;
        mismatchReasons.push(
          effectiveRemaining < poQty
            ? `${line.item_name}: akumulasi qty tertagih ${nextCumulativeQty} melebihi sisa PO ${effectiveRemaining} (total PO ${poQty})`
            : `${line.item_name}: akumulasi qty tertagih ${nextCumulativeQty} melebihi PO ${poQty}`
        );
      } else if (Number.isFinite(grnQty) && (alreadyBilled + nextCumulativeQty) > grnQty) {
        grnMismatchReasons.push(
          alreadyBilled > 0
            ? `${line.item_name}: akumulasi qty tertagih ${alreadyBilled + nextCumulativeQty} melebihi GRN gudang ${grnQty}`
            : `${line.item_name}: akumulasi qty tertagih ${nextCumulativeQty} melebihi GRN gudang ${grnQty}`
        );
      }
    }

    for (const [poKey, totalBilledOnInv] of cumulativeQtyByPoKey.entries()) {
      const poRow = poRowByKey.get(poKey);
      const poQty = toFiniteNumber(poRow.qty);
      const priorFromLogs = computePriorBilledQty(canonicalPoNumber, poRow.item_name, auditLogs, policy.itemAliases);
      const rawRemaining = toFiniteNumber(poRow.remaining_qty);
      const poCapacityLeft = Math.max(0, poQty - priorFromLogs);
      const effectiveRemaining = Number.isFinite(rawRemaining)
        ? Math.min(rawRemaining, poCapacityLeft)
        : poCapacityLeft;
      const alreadyBilled = Math.max(0, poQty - effectiveRemaining);
      if (totalBilledOnInv < effectiveRemaining || (alreadyBilled + totalBilledOnInv) < poQty) {
        isPartialDelivery = true;
      }
    }

    if (unorderedItems.length > 0) {
      const unorderedTotal = unorderedItems.reduce((sum, i) => sum + i.line_total, 0);
      const names = unorderedItems.map((i) => `"${i.item_name}"`).join(', ');
      return buildAuditResult({
        ...basePayload,
        variance: unorderedTotal,
        audit_status: 'HOLD - UNORDERED ITEM',
        discrepancy_reason: `Ditemukan item/biaya di luar PO "${canonicalPoNumber}": ${names} (total ${formatIDR(unorderedTotal)}).`,
        requires_human_review: true,
      });
    }

    if (grnMismatchReasons.length > 0) {
      checkedRules.push('GATE_5B_3WAY_GRN_MATCH');
      return buildAuditResult({
        ...basePayload,
        variance: poVariance,
        audit_status: 'HOLD - GRN MISMATCH',
        discrepancy_reason: `3-Way Match gagal pada PO "${canonicalPoNumber}": ${grnMismatchReasons.join('; ')}.`,
        requires_human_review: true,
      });
    }

    if (matchedPoKeys.size < matchedPORows.length && mismatchReasons.length === 0) {
      isPartialDelivery = true;
    }

    if (mismatchReasons.length > 0) {
      if (canAutoApproveCeiling({ policy, invoicedTotal, poTotal, hasOverQty, maxDeviationPct })) {
        checkedRules.push('POLICY_AUTO_APPROVE_CEILING');
        policyOverrideNote = `Auto-approved under policy ceiling (<=${MAX_CEILING_VARIANCE_PCT}% variance): ${mismatchReasons.join('; ')}.`;
      } else {
        return buildAuditResult({
          ...basePayload,
          variance: poVariance,
          audit_status: 'HOLD - PRICE VARIANCE',
          discrepancy_reason: `Ketidaksesuaian terhadap PO "${canonicalPoNumber}": ${mismatchReasons.join('; ')}.`,
          requires_human_review: true,
        });
      }
    }
  } else {
    const poRow = matchedPORows[0];
    const poQty = toFiniteNumber(poRow.qty);
    const poUnitPrice = toFiniteNumber(poRow.unit_price);
    const grnQty = toFiniteNumber(poRow.grn_received_qty);
    const line = normalizedLines[0];

    if (hasExplicitSingleItemName && !findMatchingPoRow(line.item_name, matchedPORows, policy.itemAliases)) {
      return buildAuditResult({
        ...basePayload,
        variance: line.line_total,
        audit_status: 'HOLD - UNORDERED ITEM',
        discrepancy_reason: `Ditemukan item/biaya di luar PO "${canonicalPoNumber}": "${line.item_name}".`,
        requires_human_review: true,
      });
    }

    const priorFromLogs = computePriorBilledQty(canonicalPoNumber, poRow.item_name, auditLogs, policy.itemAliases);
    const rawRemaining = toFiniteNumber(poRow.remaining_qty);
    const poCapacityLeft = Math.max(0, poQty - priorFromLogs);
    const effectiveRemaining = Number.isFinite(rawRemaining)
      ? Math.min(rawRemaining, poCapacityLeft)
      : poCapacityLeft;
    const alreadyBilled = Math.max(0, poQty - effectiveRemaining);

    const isOverQty = line.qty > effectiveRemaining;
    const isUnderQty = line.qty < effectiveRemaining || (alreadyBilled + line.qty) < poQty;

    if (!isOverQty && Number.isFinite(grnQty) && (alreadyBilled + line.qty) > grnQty) {
      checkedRules.push('GATE_5B_3WAY_GRN_MATCH');
      return buildAuditResult({
        ...basePayload,
        variance: poVariance,
        audit_status: 'HOLD - GRN MISMATCH',
        discrepancy_reason:
          alreadyBilled > 0
            ? `3-Way Match gagal pada PO "${canonicalPoNumber}": akumulasi qty tertagih ${alreadyBilled + line.qty} melebihi GRN gudang ${grnQty}.`
            : `3-Way Match gagal pada PO "${canonicalPoNumber}": qty tertagih ${line.qty} melebihi GRN gudang ${grnQty}.`,
        requires_human_review: true,
      });
    }

    const hasUnitPriceMismatch = !isWithinPriceTolerance(
      line.unit_price,
      poUnitPrice,
      policy.priceTolerancePct
    );

    if (hasUnitPriceMismatch || isOverQty) {
      if (isOverQty) {
        hasOverQty = true;
        mismatchReasons.push(
          effectiveRemaining < poQty
            ? `qty tertagih ${line.qty} melebihi sisa PO ${effectiveRemaining} (total PO ${poQty})`
            : `qty tertagih ${line.qty} vs PO ${poQty}`
        );
      }
      if (hasUnitPriceMismatch) {
        const devPct = poUnitPrice > 0 ? (Math.abs(line.unit_price - poUnitPrice) / poUnitPrice) * 100 : 100;
        if (devPct > maxDeviationPct) maxDeviationPct = devPct;
        mismatchReasons.push(
          `harga satuan tertagih ${formatIDR(line.unit_price)} vs PO ${formatIDR(poUnitPrice)}`
        );
      }
      if (Math.abs(poVariance) > ROUNDING_TOLERANCE_IDR) {
        mismatchReasons.push(`selisih grand total ${formatIDR(poVariance)}`);
      }
      if (canAutoApproveCeiling({ policy, invoicedTotal, poTotal, hasOverQty, maxDeviationPct })) {
        checkedRules.push('POLICY_AUTO_APPROVE_CEILING');
        policyOverrideNote = `Auto-approved under policy ceiling (<=${MAX_CEILING_VARIANCE_PCT}% variance): ${mismatchReasons.join('; ')}.`;
      } else {
        return buildAuditResult({
          ...basePayload,
          variance: poVariance,
          audit_status: 'HOLD - PRICE VARIANCE',
          discrepancy_reason: `Ketidaksesuaian terhadap PO "${canonicalPoNumber}": ${mismatchReasons.join('; ')}.`,
          requires_human_review: true,
        });
      }
    }

    const allowedTotalVariance =
      policy.priceTolerancePct > 0
        ? Math.max(ROUNDING_TOLERANCE_IDR, Math.abs(poTotal) * (policy.priceTolerancePct / 100))
        : ROUNDING_TOLERANCE_IDR;

    if (isUnderQty) {
      isPartialDelivery = true;
    } else if (Math.abs(poVariance) > allowedTotalVariance) {
      const devPct = poTotal > 0 ? (Math.abs(poVariance) / poTotal) * 100 : 100;
      if (canAutoApproveCeiling({ policy, invoicedTotal, poTotal, hasOverQty: false, maxDeviationPct: devPct })) {
        checkedRules.push('POLICY_AUTO_APPROVE_CEILING');
        policyOverrideNote = `Auto-approved under policy ceiling (<=${MAX_CEILING_VARIANCE_PCT}% variance): selisih grand total ${formatIDR(poVariance)}.`;
      } else {
        return buildAuditResult({
          ...basePayload,
          variance: poVariance,
          audit_status: 'HOLD - PRICE VARIANCE',
          discrepancy_reason: `Ketidaksesuaian terhadap PO "${canonicalPoNumber}": selisih grand total ${formatIDR(poVariance)}.`,
          requires_human_review: true,
        });
      }
    }
  }

  return buildAuditResult({
    ...basePayload,
    variance: poVariance,
    audit_status: isPartialDelivery ? 'APPROVED - PARTIAL' : 'APPROVED',
    discrepancy_reason: null,
    policy_override_note: policyOverrideNote,
    requires_human_review: false,
  });
}

// --- n8n Execution Entrypoint ---
const items = $input.all();
return items.map((item) => {
  const payload = item.json || {};
  const extractedInvoice = payload.extracted_invoice || payload;
  const masterPOList = payload.master_po_list || [];
  const existingAuditLogs = payload.existing_audit_logs || [];
  const vendorMaster = payload.vendor_master || [];
  const policyConfig = payload.policy_config || {};
  return {
    json: auditInvoice(extractedInvoice, masterPOList, existingAuditLogs, {
      policyConfig,
      vendorMaster,
    }),
  };
});
