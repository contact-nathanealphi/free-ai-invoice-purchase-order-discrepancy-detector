'use strict';

(function (global) {
  function fmtMoney(amount, currency = 'IDR') {
    const num = Number(amount || 0);
    const code = String(currency || 'IDR').toUpperCase();
    return code === 'IDR'
      ? `Rp${Math.round(num).toLocaleString('id-ID')}`
      : `${code} ${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function buildDiscrepancyRows(log) {
    const ext = log.extraction_data || {};
    const po = log.po_snapshot;
    const aiItems = Array.isArray(ext.line_items) && ext.line_items.length
      ? ext.line_items
      : ext.item_name
        ? [{ item_name: ext.item_name, qty: ext.qty || 1, unit_price: ext.unit_price || 0 }]
        : [];
    const poItems = Array.isArray(po?.items) ? po.items : [];
    const currency = log.currency || ext.currency || 'IDR';

    return aiItems.map((line) => {
      const target = String(line.item_name || '').trim().toLowerCase();
      const matched = poItems.find((p) => {
        const pName = String(p.item_name || '').trim().toLowerCase();
        return pName === target || (pName && (target.includes(pName) || pName.includes(target)));
      });
      const invPrice = Number(line.unit_price || 0);
      const poPrice = matched ? Number(matched.unit_price || 0) : 0;
      const qty = Number(line.qty || 1);
      const diff = matched ? (invPrice - poPrice) * qty : invPrice * qty;
      return {
        item_name: line.item_name || '-',
        qty,
        po_qty: matched ? Number(matched.qty || 0) : 0,
        inv_price: invPrice,
        po_price: poPrice,
        diff,
        currency,
        status: matched ? (Math.abs(invPrice - poPrice) > 100 ? 'PRICE VARIANCE' : 'MATCH') : 'UNORDERED',
      };
    });
  }

  function generateDisputePack(log, options = {}) {
    const lang = options.lang === 'en' ? 'en' : 'id';
    const tone = ['friendly', 'firm', 'escalation'].includes(options.tone) ? options.tone : 'firm';

    const invNo = log.invoice_number || log.file_name || '-';
    const poNo = log.po_number || '-';
    const vendor = log.vendor_name || 'Vendor';
    const currency = log.currency || 'IDR';
    const total = Number(log.grand_total || 0);
    const reasons = Array.isArray(log.reasons) ? log.reasons : [];
    const forensicSignals = Array.isArray(log.forensic_signals) ? log.forensic_signals : [];
    const rows = buildDiscrepancyRows(log);
    const correctionAmount = rows.reduce((s, r) => s + (r.diff > 0 ? r.diff : 0), 0);

    const itemTableLines = rows.length
      ? rows
          .map(
            (r, idx) =>
              `${idx + 1}. ${r.item_name} | Qty: ${r.qty} (PO: ${r.po_qty}) | Inv: ${fmtMoney(r.inv_price, currency)} vs PO: ${fmtMoney(r.po_price, currency)} | [${r.status}]`
          )
          .join('\n')
      : '- (Detail baris item terlampir pada dokumen faktur)';

    const allFindings = [
      ...reasons,
      ...forensicSignals.map((f) => `[Forensic: ${f.title}] ${f.detail}`),
    ];
    const findingsText = allFindings.length ? allFindings.map((r) => `- ${r}`).join('\n') : `- Status: ${log.audit_status}`;

    let subject;
    let greeting;
    let closing;

    if (lang === 'en') {
      subject = `[Action Required] Invoice Discrepancy Notice — ${invNo} (PO ${poNo})`;
      greeting =
        tone === 'friendly'
          ? `Dear ${vendor} Finance Team,\n\nWe hope you are doing well. During our automated 3-Way Match audit for Invoice ${invNo} against PO ${poNo}, we noticed a few items that require clarification before payment release:`
          : tone === 'escalation'
            ? `URGENT ESCALATION — To Management & Billing Team of ${vendor},\n\nPayment for Invoice ${invNo} (${fmtMoney(total, currency)}) under PO ${poNo} has been formally HELD due to critical contract/forensic discrepancies:`
            : `Dear ${vendor} Billing Team,\n\nIn accordance with Purchase Order ${poNo}, we are placing Invoice ${invNo} (${fmtMoney(total, currency)}) on HOLD pending resolution of the following discrepancies:`;
      closing =
        tone === 'escalation'
          ? `Please provide an official Credit Note or revised invoice within 2 business days to avoid further payment delay.`
          : `Kindly review the breakdown above and issue a revised invoice or Debit/Credit Note so we can proceed with payment.\n\nBest regards,\nAccounts Payable Audit Team`;
    } else {
      subject = `[Perlu Koreksi] Klarifikasi Selisih Faktur ${invNo} (PO ${poNo})`;
      greeting =
        tone === 'friendly'
          ? `Halo Tim Finance ${vendor},\n\nTerima kasih atas pengiriman faktur ${invNo}. Saat verifikasi 3-Way Match terhadap PO ${poNo}, kami menemukan beberapa perbedaan yang perlu dikonfirmasi sebelum proses pembayaran:`
          : tone === 'escalation'
            ? `ESKALASI MANAJEMEN — Yth. Pimpinan & Tim Billing ${vendor},\n\nPembayaran atas Faktur ${invNo} (${fmtMoney(total, currency)}) pada PO ${poNo} kami TAHAN (HOLD) karena ditemukan penyimpangan kontrak/forensik yang signifikan:`
            : `Yth. Tim Billing ${vendor},\n\nBerdasarkan kontrak Purchase Order ${poNo}, pembayaran atas Faktur ${invNo} (${fmtMoney(total, currency)}) kami tahan sementara (HOLD) karena temuan audit berikut:`;
      closing =
        tone === 'escalation'
          ? `Mohon segera menerbitkan Faktur Revisi atau Credit Note resmi maksimal 2 hari kerja agar proses pembayaran tidak tertunda lebih lanjut.`
          : `Mohon bantuannya untuk meninjau rincian di atas dan mengirimkan Faktur Revisi / Nota Koreksi agar dapat segera kami proses.\n\nHormat kami,\nTim Accounts Payable`;
    }

    const emailBody = [
      greeting,
      '',
      lang === 'en' ? 'Audit Findings:' : 'Temuan Audit:',
      findingsText,
      '',
      lang === 'en' ? 'Line-Item Comparison:' : 'Rincian Perbandingan Item:',
      itemTableLines,
      '',
      `${lang === 'en' ? 'Estimated Adjustment / Correction' : 'Estimasi Nilai Koreksi'}: ${fmtMoney(correctionAmount, currency)}`,
      '',
      closing,
    ].join('\n');

    const whatsappText =
      lang === 'en'
        ? `Hi ${vendor} team, regarding Invoice *${invNo}* (PO *${poNo}* — ${fmtMoney(total, currency)}): our AP audit flagged a discrepancy (${reasons[0] || log.audit_status}). Estimated adjustment: *${fmtMoney(correctionAmount, currency)}*. Could you send a revised invoice/credit note? Thank you.`
        : `Halo tim ${vendor}, terkait Faktur *${invNo}* (PO *${poNo}* — ${fmtMoney(total, currency)}): hasil audit AP kami menemukan selisih (${reasons[0] || log.audit_status}). Estimasi koreksi: *${fmtMoney(correctionAmount, currency)}*. Mohon dibantu faktur revisi/nota koreksi ya. Terima kasih.`;

    const mailtoUrl = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(emailBody)}`;

    const debitNoteHtml = `
      <div style="font-family:Inter,sans-serif;max-width:720px;margin:24px auto;padding:28px;border:1px solid #d4d4d8;color:#18181b;">
        <div style="display:flex;justify-content:space-between;border-bottom:2px solid #18181b;padding-bottom:12px;margin-bottom:16px;">
          <div>
            <div style="font-size:18px;font-weight:700;">OFFICIAL DEBIT NOTE / ADJUSTMENT REQUEST</div>
            <div style="font-size:12px;color:#52525b;">Generated by AI Invoice &amp; Purchase Order Discrepancy Detector</div>
          </div>
          <div style="text-align:right;font-family:monospace;font-size:12px;">
            <div><strong>DN-${invNo}</strong></div>
            <div>Date: ${new Date().toISOString().slice(0, 10)}</div>
          </div>
        </div>
        <div style="font-size:13px;margin-bottom:16px;">
          <div><strong>Vendor:</strong> ${vendor}</div>
          <div><strong>Reference Invoice:</strong> ${invNo} | <strong>Reference PO:</strong> ${poNo}</div>
          <div><strong>Audit Status:</strong> ${log.audit_status}</div>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:16px;">
          <thead>
            <tr style="background:#f4f4f5;border-bottom:1px solid #d4d4d8;">
              <th style="text-align:left;padding:8px;">Item</th>
              <th style="text-align:right;padding:8px;">Qty</th>
              <th style="text-align:right;padding:8px;">Invoiced</th>
              <th style="text-align:right;padding:8px;">PO Rate</th>
              <th style="text-align:right;padding:8px;">Adjustment</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (r) => `<tr style="border-bottom:1px solid #e4e4e7;">
                  <td style="padding:8px;">${r.item_name}</td>
                  <td style="text-align:right;padding:8px;font-family:monospace;">${r.qty}</td>
                  <td style="text-align:right;padding:8px;font-family:monospace;">${fmtMoney(r.inv_price, currency)}</td>
                  <td style="text-align:right;padding:8px;font-family:monospace;">${fmtMoney(r.po_price, currency)}</td>
                  <td style="text-align:right;padding:8px;font-family:monospace;font-weight:600;">${fmtMoney(r.diff, currency)}</td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
        <div style="text-align:right;font-size:14px;font-weight:700;font-family:monospace;">
          Total Requested Adjustment: ${fmtMoney(correctionAmount, currency)}
        </div>
      </div>
    `;

    return {
      subject,
      emailBody,
      mailtoUrl,
      whatsappText,
      debitNoteHtml,
      correctionAmount,
      discrepancyItems: rows,
    };
  }

  const exported = { generateDisputePack, buildDiscrepancyRows };
  global.ExactaDispute = exported;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
})(typeof window !== 'undefined' ? window : globalThis);
