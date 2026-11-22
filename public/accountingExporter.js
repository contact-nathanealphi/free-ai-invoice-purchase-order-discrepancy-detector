'use strict';

(function (global) {
  const DEFAULT_FX_RATES = { USD: 16000, SGD: 12000 };

  function toIdr(amount, currency = 'IDR', fxRates = DEFAULT_FX_RATES) {
    const num = Number(amount || 0);
    const code = String(currency || 'IDR').toUpperCase();
    if (code === 'USD') return num * (Number(fxRates?.USD) || DEFAULT_FX_RATES.USD);
    if (code === 'SGD') return num * (Number(fxRates?.SGD) || DEFAULT_FX_RATES.SGD);
    return num;
  }

  function addDays(dateInput, days) {
    const d = dateInput ? new Date(dateInput) : new Date();
    if (Number.isNaN(d.getTime())) return null;
    const copy = new Date(d.getTime());
    copy.setUTCDate(copy.getUTCDate() + days);
    return copy;
  }

  /**
   * Parses payment terms like "2/10 Net 30", "1.5/15 Net 45", or "Net 30".
   */
  function calculateEarlyPaymentDiscount(log, referenceDate = new Date()) {
    const ext = log?.extraction_data || {};
    const terms = String(ext.payment_terms || log?.payment_terms || '').trim();
    const issueDate = new Date(ext.invoice_date || log?.created_at || referenceDate);
    const grandTotal = Number(log?.grand_total ?? ext.grand_total ?? 0);

    const match = terms.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+)\s*(?:,?\s*net\s*(\d+))?/i);
    if (!match || grandTotal <= 0 || Number.isNaN(issueDate.getTime())) {
      return {
        hasDiscount: false,
        paymentTerms: terms || 'Net 30',
        discountPct: 0,
        discountDays: 0,
        netDays: 30,
        discountDeadline: null,
        savingsAmount: 0,
        isActive: false,
      };
    }

    const discountPct = Number(match[1]);
    const discountDays = Number(match[2]);
    const netDays = match[3] ? Number(match[3]) : 30;
    const deadline = addDays(issueDate, discountDays);
    const refTime = new Date(referenceDate).getTime();
    const isActive = Boolean(deadline && refTime <= deadline.getTime());
    const savingsAmount = Math.round(grandTotal * (discountPct / 100));

    return {
      hasDiscount: true,
      paymentTerms: terms,
      discountPct,
      discountDays,
      netDays,
      discountDeadline: deadline ? deadline.toISOString().slice(0, 10) : null,
      savingsAmount,
      isActive,
    };
  }

  function extractFinancialBreakdown(log) {
    const ext = log.extraction_data || {};
    const currency = String(log.currency || ext.currency || 'IDR').toUpperCase();
    const subtotal = Number(ext.subtotal ?? 0);
    const ppn = Number(ext.ppn_amount ?? ext.tax_amount ?? 0);
    const pph23 = Number(ext.pph23_amount ?? 0);
    const grandTotal = Number(log.grand_total ?? ext.grand_total ?? 0);
    // Net Payable reflects cash outflow after PPh 23 withholding
    const netPayable = grandTotal > 0 ? grandTotal : Math.max(0, subtotal + ppn - pph23);
    const issueDate = String(ext.invoice_date || log.created_at || new Date().toISOString()).slice(0, 10);
    const dueDate =
      ext.due_date ||
      (addDays(issueDate, 30) ? addDays(issueDate, 30).toISOString().slice(0, 10) : issueDate);

    return {
      date: issueDate,
      dueDate,
      vendor: log.vendor_name || ext.vendor_name || 'Unknown Vendor',
      invoiceNo: log.invoice_number || ext.invoice_number || log.file_name || '-',
      poNo: log.po_number || ext.po_number || '-',
      currency,
      subtotal,
      ppn,
      pph23,
      netPayable,
      expenseAccount: log.po_snapshot?.po_type === 'SERVICE' ? '5200-Service Expense' : '5100-COGS / Inventory',
    };
  }

  function csvCell(val) {
    return `"${String(val ?? '').replace(/"/g, '""')}"`;
  }

  /**
   * Generates accounting/ERP or Batch Bank Transfer CSV for APPROVED invoices.
   */
  function generateAccountingCsv(auditLogs = [], preset = 'accurate') {
    const approved = (auditLogs || []).filter((log) => {
      const s = String(log.audit_status || '').toUpperCase();
      return s === 'APPROVED' || s === 'APPROVED - PARTIAL' || s === 'MANUAL APPROVED';
    });

    const rows = approved.map(extractFinancialBreakdown);
    let headers;
    let bodyRows;

    if (preset === 'bank_transfer') {
      headers = [
        'Beneficiary Vendor',
        'Invoice Number',
        'PO Number',
        'Currency',
        'Gross Total',
        'PPh 23 Withheld',
        'Net Payable Transfer',
        'Due Date',
        'Payment Reference',
      ];
      bodyRows = rows.map((r) => [
        r.vendor,
        r.invoiceNo,
        r.poNo,
        r.currency,
        r.subtotal + r.ppn,
        r.pph23,
        r.netPayable,
        r.dueDate,
        `PAY-${r.poNo}-${r.invoiceNo}`,
      ]);
    } else if (preset === 'jurnal') {
      headers = [
        '*Vendor',
        '*Transaction Date',
        '*Due Date',
        '*Invoice Number',
        'PO Reference',
        'Currency',
        '*Account',
        'Subtotal (DPP)',
        'PPN (11%)',
        'PPh 23',
        'Net Payable',
      ];
      bodyRows = rows.map((r) => [
        r.vendor,
        r.date,
        r.dueDate,
        r.invoiceNo,
        r.poNo,
        r.currency,
        r.expenseAccount,
        r.subtotal,
        r.ppn,
        r.pph23,
        r.netPayable,
      ]);
    } else if (preset === 'xero') {
      headers = [
        '*ContactName',
        '*InvoiceNumber',
        'Reference',
        '*InvoiceDate',
        '*DueDate',
        'Currency',
        '*Description',
        '*UnitAmount',
        'TaxAmount',
        'WithholdingPPh23',
        'Total',
        '*AccountCode',
      ];
      bodyRows = rows.map((r) => [
        r.vendor,
        r.invoiceNo,
        r.poNo,
        r.date,
        r.dueDate,
        r.currency,
        `PO ${r.poNo} Settlement`,
        r.subtotal,
        r.ppn,
        r.pph23,
        r.netPayable,
        r.expenseAccount.split('-')[0],
      ]);
    } else if (preset === 'quickbooks') {
      headers = [
        'Vendor',
        'Bill No',
        'PO No',
        'Bill Date',
        'Due Date',
        'Currency',
        'Category Account',
        'Subtotal',
        'Tax',
        'Withholding',
        'Net Amount',
      ];
      bodyRows = rows.map((r) => [
        r.vendor,
        r.invoiceNo,
        r.poNo,
        r.date,
        r.dueDate,
        r.currency,
        r.expenseAccount,
        r.subtotal,
        r.ppn,
        r.pph23,
        r.netPayable,
      ]);
    } else {
      // Default: Accurate Online
      headers = [
        'Tanggal',
        'Pemasok',
        'No. Faktur',
        'No. PO',
        'Mata Uang',
        'DPP / Subtotal',
        'PPN',
        'PPh 23',
        'Net Payable',
        'Jatuh Tempo',
        'Akun Beban',
      ];
      bodyRows = rows.map((r) => [
        r.date,
        r.vendor,
        r.invoiceNo,
        r.poNo,
        r.currency,
        r.subtotal,
        r.ppn,
        r.pph23,
        r.netPayable,
        r.dueDate,
        r.expenseAccount,
      ]);
    }

    return {
      count: rows.length,
      csv: [headers.map(csvCell).join(','), ...bodyRows.map((row) => row.map(csvCell).join(','))].join('\n'),
    };
  }

  /**
   * Computes Vendor Trust Score (0-100) Leaderboard from workspace audit logs.
   */
  function computeVendorTrustLeaderboard(auditLogs = []) {
    const map = new Map();
    for (const log of auditLogs || []) {
      const vendor = String(log.vendor_name || 'Unknown Vendor').trim();
      if (!map.has(vendor)) {
        map.set(vendor, {
          vendor_name: vendor,
          total_invoices: 0,
          clean_count: 0,
          hold_count: 0,
          forensic_hits: 0,
          blocked_value_idr: 0,
          total_risk_points: 0,
        });
      }
      const entry = map.get(vendor);
      entry.total_invoices += 1;

      const s = String(log.audit_status || '').toUpperCase();
      const isApproved = s === 'APPROVED' || s === 'APPROVED - PARTIAL' || s === 'MANUAL APPROVED';
      if (isApproved) {
        entry.clean_count += 1;
      } else if (s.startsWith('HOLD') || s === 'REJECTED TO VENDOR') {
        entry.hold_count += 1;
        entry.blocked_value_idr += Math.round(toIdr(log.grand_total, log.currency));
        entry.total_risk_points += 20;
      } else {
        entry.total_risk_points += 10;
      }

      const fSignals = Array.isArray(log.forensic_signals) ? log.forensic_signals : [];
      if (fSignals.length > 0) {
        entry.forensic_hits += fSignals.length;
        entry.total_risk_points += Math.min(35, Number(log.forensic_risk_score || 15));
      }
    }

    return Array.from(map.values())
      .map((v) => {
        const cleanRatio = v.total_invoices > 0 ? v.clean_count / v.total_invoices : 1;
        const avgPenalty = v.total_invoices > 0 ? v.total_risk_points / v.total_invoices : 0;
        const score = Math.max(0, Math.min(100, Math.round(cleanRatio * 100 - avgPenalty * 0.5)));
        return { ...v, trust_score: score };
      })
      .sort((a, b) => b.total_invoices - a.total_invoices || a.trust_score - b.trust_score);
  }

  /**
   * Computes AP Aging buckets & Early Payment Discount opportunities.
   */
  function computeApAgingAndCashflow(auditLogs = [], referenceDate = new Date(), fxRates = DEFAULT_FX_RATES) {
    const refMs = new Date(referenceDate).getTime();
    const buckets = { overdue: 0, days0to7: 0, days8to30: 0, days30plus: 0 };
    let totalPayableIdr = 0;
    let totalEarlyDiscountSavingsIdr = 0;
    const activeDiscounts = [];

    for (const log of auditLogs || []) {
      const s = String(log.audit_status || '').toUpperCase();
      if (s === 'REJECTED TO VENDOR') continue;
      if (String(log.payment_status || '').toUpperCase() === 'PAID') continue;

      const breakdown = extractFinancialBreakdown(log);
      const amountIdr = Math.round(toIdr(breakdown.netPayable, breakdown.currency, fxRates));
      totalPayableIdr += amountIdr;

      const dueMs = new Date(breakdown.dueDate).getTime();
      const daysUntilDue = Number.isNaN(dueMs)
        ? 15
        : Math.ceil((dueMs - refMs) / (1000 * 60 * 60 * 24));

      if (daysUntilDue < 0) buckets.overdue += amountIdr;
      else if (daysUntilDue <= 7) buckets.days0to7 += amountIdr;
      else if (daysUntilDue <= 30) buckets.days8to30 += amountIdr;
      else buckets.days30plus += amountIdr;

      const disc = calculateEarlyPaymentDiscount(log, referenceDate);
      if (disc.hasDiscount && disc.isActive) {
        const savingsIdr = Math.round(toIdr(disc.savingsAmount, breakdown.currency, fxRates));
        totalEarlyDiscountSavingsIdr += savingsIdr;
        activeDiscounts.push({
          log_id: log.id,
          invoice_number: breakdown.invoiceNo,
          vendor_name: breakdown.vendor,
          deadline: disc.discountDeadline,
          savings_idr: savingsIdr,
          terms: disc.paymentTerms,
        });
      }
    }

    return {
      buckets,
      totalPayableIdr,
      totalEarlyDiscountSavingsIdr,
      activeDiscounts,
    };
  }

  const exported = {
    calculateEarlyPaymentDiscount,
    extractFinancialBreakdown,
    generateAccountingCsv,
    computeVendorTrustLeaderboard,
    computeApAgingAndCashflow,
  };
  global.ExactaAccounting = exported;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
})(typeof window !== 'undefined' ? window : globalThis);
