'use strict';

const SCENARIOS = [
  {
    id: 'normal',
    title: 'Normal Multi-Item',
    target: 'APPROVED',
    badgeCls: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    desc: '4-line invoice matching PO-2026-004 unit prices, quantities, and 11% PPN.',
  },
  {
    id: 'sneaky_fee',
    title: 'Sneaky Hidden Fee',
    target: 'HOLD - UNORDERED ITEM',
    badgeCls: 'bg-rose-50 text-rose-700 border-rose-200',
    desc: 'Vendor injects an uncontracted surcharge outside PO-2026-002.',
  },
  {
    id: 'pph23_service',
    title: 'PPh 23 Service',
    target: 'APPROVED',
    badgeCls: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    desc: 'SERVICE PO with +11% PPN and -2% PPh 23 withholding tax.',
  },
  {
    id: 'partial_delivery',
    title: 'Partial Delivery',
    target: 'APPROVED - PARTIAL',
    badgeCls: 'bg-sky-50 text-sky-700 border-sky-200',
    desc: 'Partial billing for 6 of 10 units matching warehouse GRN on PO-2026-005.',
  },
  {
    id: 'prompt_injection',
    title: 'Prompt Injection Attack',
    target: 'HOLD - PRICE VARIANCE',
    badgeCls: 'bg-rose-50 text-rose-700 border-rose-200',
    desc: 'PDF embeds adversarial override instructions to conceal a price markup.',
  },
  {
    id: 'currency_mismatch',
    title: 'Currency Mismatch',
    target: 'HOLD - CURRENCY MISMATCH',
    badgeCls: 'bg-rose-50 text-rose-700 border-rose-200',
    desc: 'Invoice billed in USD against an IDR-contracted PO-2026-006.',
  },
  {
    id: 'multipage_noisy',
    title: '2-Page Noisy Scan',
    target: 'HUMAN REVIEW',
    badgeCls: 'bg-amber-50 text-amber-700 border-amber-200',
    desc: 'Degraded multi-page scan triggers OCR confidence < 0.85 escalation.',
  },
  {
    id: 'tax_error',
    title: 'Tax Error +Rp500k',
    target: 'HOLD - TAX ERROR',
    badgeCls: 'bg-rose-50 text-rose-700 border-rose-200',
    desc: 'Deterministic tax check catches +Rp500,000 PPN overbilling.',
  },
];

let purchaseOrders = [];

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatCurrency(amount, currency = 'IDR') {
  if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return '-';
  const num = Number(amount);
  const code = String(currency || 'IDR').toUpperCase();
  return code === 'IDR'
    ? `Rp${Math.round(num).toLocaleString('id-ID')}`
    : `${code} ${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function statusBadgeHtml(status) {
  const s = String(status || '').toUpperCase();
  let cls = 'bg-zinc-100 text-zinc-700 border-zinc-200';
  if (s === 'APPROVED' || s === 'MANUAL APPROVED') cls = 'bg-emerald-50 text-emerald-700 border-emerald-200';
  else if (s === 'APPROVED - PARTIAL') cls = 'bg-sky-50 text-sky-700 border-sky-200';
  else if (s === 'HUMAN REVIEW') cls = 'bg-amber-50 text-amber-700 border-amber-200';
  else if (s.startsWith('HOLD') || s === 'REJECTED TO VENDOR') cls = 'bg-rose-50 text-rose-700 border-rose-200';
  return `<span class="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium border ${cls}">${escapeHtml(s)}</span>`;
}

function showBanner(msg, type = 'info') {
  const el = document.getElementById('pgBanner');
  const styles = {
    info: 'bg-white text-zinc-800 border-zinc-200',
    success: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    error: 'bg-rose-50 text-rose-800 border-rose-200',
  };
  el.className = `rounded-lg px-4 py-2.5 text-xs font-medium flex items-center justify-between border ${styles[type] || styles.info}`;
  el.innerHTML = `<span>${escapeHtml(msg)}</span><button onclick="this.parentElement.classList.add('hidden')" class="ml-4 text-xs underline cursor-pointer">Dismiss</button>`;
  el.classList.remove('hidden');
}

function renderScenarioCards() {
  const grid = document.getElementById('panelScenarios');
  grid.innerHTML = SCENARIOS.map(
    (s) => `
    <div class="bg-white rounded-lg border border-zinc-200 p-4 flex flex-col justify-between">
      <div>
        <div class="flex items-start justify-between gap-2 mb-1.5">
          <h3 class="text-xs font-semibold text-zinc-900">${escapeHtml(s.title)}</h3>
        </div>
        <span class="inline-block px-2 py-0.5 rounded-md text-[10px] font-mono font-medium border mb-2 ${s.badgeCls}">${escapeHtml(s.target)}</span>
        <p class="text-[11px] text-zinc-500 leading-relaxed">${escapeHtml(s.desc)}</p>
      </div>
      <button data-sample="${escapeHtml(s.id)}" class="run-scenario-btn mt-4 w-full py-1.5 rounded-lg text-xs font-medium bg-zinc-900 hover:bg-zinc-800 text-white transition cursor-pointer">
        Run Test
      </button>
    </div>
  `
  ).join('');

  grid.querySelectorAll('.run-scenario-btn').forEach((btn) => {
    btn.addEventListener('click', () => executeAudit({ sampleId: btn.dataset.sample }));
  });
}

function renderAuditResult(data) {
  const log = data.audit_log;
  const res = data.audit_result || {};
  const ext = log.extraction_data || {};
  const po = log.po_snapshot;

  document.getElementById('resStatusBadge').innerHTML = statusBadgeHtml(log.audit_status);
  document.getElementById('resFinOps').textContent = `Confidence: ${res.confidence_score ?? ext.confidence_score ?? '-'} · Latency: ${log.latency_ms ?? '-'}ms · Cost: Rp${Number(log.cost_idr || 0).toFixed(2)}`;
  document.getElementById('viewInCommandCenterLink').href = `/?logId=${encodeURIComponent(log.id)}`;

  const tokenBadge = document.getElementById('resTokenBadge');
  if (data.extraction_method === 'text_markdown' && Number(data.estimated_tokens_saved_pct) > 0) {
    tokenBadge.textContent = `Hybrid Markdown · ~${data.estimated_tokens_saved_pct}% tokens saved`;
    tokenBadge.classList.remove('hidden');
  } else {
    tokenBadge.classList.add('hidden');
  }

  const copyBtn = document.getElementById('pgCopyMdBtn');
  if (data.extracted_markdown) {
    copyBtn.classList.remove('hidden');
    copyBtn.onclick = async () => {
      await navigator.clipboard.writeText(data.extracted_markdown);
      showBanner('Extracted Markdown copied to clipboard.', 'success');
    };
  } else {
    copyBtn.classList.add('hidden');
  }

  const reasonBox = document.getElementById('resReasonBox');
  const reasons = Array.isArray(log.reasons) ? log.reasons : [];
  if (reasons.length > 0) {
    reasonBox.className = 'rounded-lg p-3 text-xs border bg-rose-50 text-rose-800 border-rose-200';
    reasonBox.innerHTML = reasons.map((r) => `<div><strong>Finding:</strong> ${escapeHtml(r)}</div>`).join('');
    reasonBox.classList.remove('hidden');
  } else {
    reasonBox.classList.add('hidden');
  }

  document.getElementById('resAiDetails').innerHTML = `
    <div class="flex justify-between"><dt class="text-zinc-500">Invoice #</dt><dd class="font-mono font-medium">${escapeHtml(ext.invoice_number || '-')}</dd></div>
    <div class="flex justify-between"><dt class="text-zinc-500">PO #</dt><dd class="font-mono font-medium">${escapeHtml(ext.po_number || '-')}</dd></div>
    <div class="flex justify-between"><dt class="text-zinc-500">Vendor</dt><dd>${escapeHtml(ext.vendor_name || '-')}</dd></div>
    <div class="flex justify-between"><dt class="text-zinc-500">Grand Total</dt><dd class="font-mono font-semibold">${escapeHtml(formatCurrency(ext.grand_total, ext.currency))}</dd></div>
  `;

  if (po) {
    document.getElementById('resPoDetails').innerHTML = `
      <div class="flex justify-between"><dt class="text-zinc-500">PO #</dt><dd class="font-mono font-medium">${escapeHtml(po.po_number)}</dd></div>
      <div class="flex justify-between"><dt class="text-zinc-500">Vendor</dt><dd>${escapeHtml(po.vendor_name)}</dd></div>
      <div class="flex justify-between"><dt class="text-zinc-500">Type / Currency</dt><dd class="font-mono">${escapeHtml(po.po_type)} / ${escapeHtml(po.currency)}</dd></div>
      <div class="flex justify-between"><dt class="text-zinc-500">Items</dt><dd class="font-mono text-right">${(po.items || []).map((i) => `${i.item_name} (PO:${i.qty}/GRN:${i.grn_received_qty ?? i.qty})`).join(', ')}</dd></div>
    `;
  } else {
    document.getElementById('resPoDetails').innerHTML = `<div class="text-rose-600 font-semibold">No matching PO found in Master PO.</div>`;
  }

  document.getElementById('resultPanel').classList.remove('hidden');
  document.getElementById('resultPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function executeAudit(payload) {
  const spinner = document.getElementById('pgSpinner');
  spinner.classList.remove('hidden');
  try {
    const ws = window.ExactaStore.getWorkspace();
    const res = await fetch('/api/audit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...window.ExactaStore.getByokHeaders(),
      },
      body: JSON.stringify({
        ...payload,
        purchaseOrders: ws.purchaseOrders,
        auditLogs: ws.auditLogs,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Audit failed.');
    await window.ExactaStore.addAuditLog(data.audit_log);
    renderAuditResult(data);
    showBanner(`Audit complete: ${data.audit_log.invoice_number || data.audit_log.file_name} → ${data.audit_log.audit_status}`, 'success');
  } catch (err) {
    showBanner(err.message, 'error');
  } finally {
    spinner.classList.add('hidden');
  }
}

function addBuilderItemRow(item = { item_name: '', qty: 1, unit_price: 0 }) {
  const container = document.getElementById('bItemsContainer');
  const row = document.createElement('div');
  row.className = 'grid grid-cols-12 gap-2 items-center b-item-row';
  row.innerHTML = `
    <input placeholder="Item Name" value="${escapeHtml(item.item_name)}" required class="col-span-6 rounded-lg border border-zinc-300 px-2.5 py-1.5 b-item-name" />
    <input type="number" min="1" placeholder="Qty" value="${item.qty}" required class="col-span-2 rounded-lg border border-zinc-300 px-2 py-1.5 font-mono b-item-qty" />
    <input type="number" min="0" placeholder="Unit Price" value="${item.unit_price}" required class="col-span-3 rounded-lg border border-zinc-300 px-2 py-1.5 font-mono b-item-price" />
    <button type="button" class="col-span-1 text-zinc-400 hover:text-rose-600 font-bold cursor-pointer remove-b-item">✕</button>
  `;
  row.querySelector('.remove-b-item').addEventListener('click', () => {
    row.remove();
    recalculateBuilderTotals();
  });
  row.querySelectorAll('input').forEach((inp) => inp.addEventListener('input', recalculateBuilderTotals));
  container.appendChild(row);
}

function recalculateBuilderTotals() {
  const poNum = document.getElementById('bPoSelect').value;
  const po = purchaseOrders.find((p) => p.po_number === poNum);
  const poType = po ? String(po.po_type).toUpperCase() : 'GOODS';

  let subtotal = 0;
  document.querySelectorAll('.b-item-row').forEach((row) => {
    const q = Number(row.querySelector('.b-item-qty').value) || 0;
    const p = Number(row.querySelector('.b-item-price').value) || 0;
    subtotal += q * p;
  });

  const ppn = Math.round(subtotal * 0.11);
  const pph23 = poType === 'SERVICE' ? Math.round(subtotal * 0.02) : 0;
  document.getElementById('bPpnInput').value = ppn;
  document.getElementById('bPph23Input').value = pph23;
  document.getElementById('bGrandTotalInput').value = subtotal + ppn - pph23;
}

function renderContractedPoReference(po) {
  const refBody = document.getElementById('contractedPoRefBody');
  if (!po) {
    refBody.textContent = 'Select a PO above to inspect contracted terms.';
    return;
  }
  const taxRule = String(po.po_type).toUpperCase() === 'SERVICE' ? 'SERVICE (PPN +11%, PPh 23 -2%)' : 'GOODS (PPN +11%)';
  const itemsList = (po.items || [])
    .map(
      (i) =>
        `<div class="flex flex-wrap justify-between gap-2 py-0.5 border-b border-zinc-200/70 last:border-0">
          <span>• ${escapeHtml(i.item_name)}</span>
          <span>Qty: ${i.qty} | GRN: ${i.grn_received_qty ?? i.qty} | Unit: ${formatCurrency(i.unit_price, po.currency)}</span>
        </div>`
    )
    .join('');

  refBody.innerHTML = `
    <div class="flex flex-wrap gap-4 mb-1.5 text-zinc-600">
      <span><strong>Tax Rule:</strong> ${escapeHtml(taxRule)}</span>
      <span><strong>Currency:</strong> ${escapeHtml(po.currency)}</span>
      <span><strong>Status:</strong> ${escapeHtml(po.status)}</span>
    </div>
    <div>${itemsList}</div>
  `;
}

function populateBuilderFromPo(poNumber) {
  const po = purchaseOrders.find((p) => p.po_number === poNumber);
  if (!po) return;
  document.getElementById('bVendorInput').value = po.vendor_name;
  document.getElementById('bCurrencySelect').value = po.currency || 'IDR';
  document.getElementById('bInvInput').value = `INV/PG/${po.po_number.replace(/[^0-9]/g, '') || '001'}/${Math.floor(100 + Math.random() * 900)}`;

  renderContractedPoReference(po);

  const container = document.getElementById('bItemsContainer');
  container.innerHTML = '';
  (po.items || []).forEach((i) => addBuilderItemRow({ item_name: i.item_name, qty: i.qty, unit_price: i.unit_price }));
  recalculateBuilderTotals();
}

function synthesizePdfBase64() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const poNum = document.getElementById('bPoSelect').value;
  const vendor = document.getElementById('bVendorInput').value.trim();
  const invNum = document.getElementById('bInvInput').value.trim();
  const currency = document.getElementById('bCurrencySelect').value;
  const ppn = Number(document.getElementById('bPpnInput').value) || 0;
  const pph23 = Number(document.getElementById('bPph23Input').value) || 0;
  const grandTotal = Number(document.getElementById('bGrandTotalInput').value) || 0;
  const note = document.getElementById('bNoteInput').value.trim();
  const isBlurry = document.getElementById('bBlurScanCheck').checked;

  if (isBlurry) {
    // Low-contrast gray text and visual scan noise streaks
    doc.setDrawColor(210, 210, 210);
    for (let i = 0; i < 45; i += 1) {
      doc.line(10 + (i * 4), 10, 20 + (i * 3.5), 280);
    }
    doc.setTextColor(155, 155, 155);
  } else {
    doc.setTextColor(24, 24, 27);
  }

  doc.setFontSize(16);
  doc.text('COMMERCIAL INVOICE', 14, 20);
  doc.setFontSize(10);
  doc.text(`Vendor: ${vendor}`, 14, 30);
  doc.text(`Invoice Number: ${invNum}`, 14, 36);
  doc.text(`PO Number: ${poNum}`, 14, 42);
  doc.text(`Currency: ${currency}`, 14, 48);

  let y = 60;
  doc.setFont(undefined, 'bold');
  doc.text('Line Items:', 14, y);
  doc.setFont(undefined, 'normal');
  y += 8;

  document.querySelectorAll('.b-item-row').forEach((row, idx) => {
    const name = row.querySelector('.b-item-name').value.trim();
    const qty = Number(row.querySelector('.b-item-qty').value) || 0;
    const price = Number(row.querySelector('.b-item-price').value) || 0;
    doc.text(`${idx + 1}. ${name} | Qty: ${qty} | Unit Price: ${currency} ${price.toLocaleString('en-US')} | Total: ${currency} ${(qty * price).toLocaleString('en-US')}`, 14, y);
    y += 7;
  });

  y += 6;
  doc.text(`PPN (11%): ${currency} ${ppn.toLocaleString('en-US')}`, 14, y);
  y += 6;
  if (pph23 > 0) {
    doc.text(`PPh 23 (-2%): -${currency} ${pph23.toLocaleString('en-US')}`, 14, y);
    y += 6;
  }
  doc.setFont(undefined, 'bold');
  doc.text(`Grand Total: ${currency} ${grandTotal.toLocaleString('en-US')}`, 14, y);
  doc.setFont(undefined, 'normal');

  if (note) {
    y += 14;
    doc.setFontSize(9);
    doc.text(`Note: ${note}`, 14, y, { maxWidth: 180 });
  }

  if (isBlurry) {
    doc.setFontSize(28);
    doc.setTextColor(200, 200, 200);
    doc.text('LOW CONTRAST / BLURRY SCAN', 25, 160, { angle: 25 });
  }

  return doc.output('datauristring');
}

async function initPlayground() {
  renderScenarioCards();
  try {
    const ws = await window.ExactaStore.initWorkspace();
    purchaseOrders = ws.purchaseOrders || [];
    const select = document.getElementById('bPoSelect');
    select.innerHTML = purchaseOrders
      .map((po) => `<option value="${escapeHtml(po.po_number)}">${escapeHtml(po.po_number)} — ${escapeHtml(po.vendor_name)} (${escapeHtml(po.po_type)})</option>`)
      .join('');
    if (purchaseOrders.length > 0) populateBuilderFromPo(purchaseOrders[0].po_number);
  } catch (err) {
    showBanner(`Failed to load POs: ${err.message}`, 'error');
  }
  if (window.lucide) window.lucide.createIcons();
}

document.addEventListener('DOMContentLoaded', () => {
  initPlayground();

  const tabScenarios = document.getElementById('tabScenariosBtn');
  const tabBuilder = document.getElementById('tabBuilderBtn');
  const panelScenarios = document.getElementById('panelScenarios');
  const panelBuilder = document.getElementById('panelBuilder');

  tabScenarios.addEventListener('click', () => {
    panelScenarios.classList.remove('hidden');
    panelBuilder.classList.add('hidden');
    tabScenarios.className = 'px-4 py-2.5 text-xs font-semibold border-b-2 border-zinc-900 text-zinc-900 cursor-pointer';
    tabBuilder.className = 'px-4 py-2.5 text-xs font-medium border-b-2 border-transparent text-zinc-500 hover:text-zinc-900 cursor-pointer';
  });

  tabBuilder.addEventListener('click', () => {
    panelBuilder.classList.remove('hidden');
    panelScenarios.classList.add('hidden');
    tabBuilder.className = 'px-4 py-2.5 text-xs font-semibold border-b-2 border-zinc-900 text-zinc-900 cursor-pointer';
    tabScenarios.className = 'px-4 py-2.5 text-xs font-medium border-b-2 border-transparent text-zinc-500 hover:text-zinc-900 cursor-pointer';
  });

  document.getElementById('bPoSelect').addEventListener('change', (e) => populateBuilderFromPo(e.target.value));
  document.getElementById('bAddItemBtn').addEventListener('click', () => addBuilderItemRow());
  document.getElementById('bAddFeeBtn').addEventListener('click', () => {
    addBuilderItemRow({ item_name: 'Biaya Admin & Handling Tambahan', qty: 1, unit_price: 750000 });
    recalculateBuilderTotals();
  });

  ['bPpnInput', 'bPph23Input'].forEach((id) => {
    document.getElementById(id).addEventListener('input', () => {
      let subtotal = 0;
      document.querySelectorAll('.b-item-row').forEach((row) => {
        subtotal += (Number(row.querySelector('.b-item-qty').value) || 0) * (Number(row.querySelector('.b-item-price').value) || 0);
      });
      const ppn = Number(document.getElementById('bPpnInput').value) || 0;
      const pph23 = Number(document.getElementById('bPph23Input').value) || 0;
      document.getElementById('bGrandTotalInput').value = subtotal + ppn - pph23;
    });
  });

  document.getElementById('builderForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!window.jspdf) {
      showBanner('jsPDF library is not loaded.', 'error');
      return;
    }
    const pdfBase64 = synthesizePdfBase64();
    const invNum = document.getElementById('bInvInput').value.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
    await executeAudit({ fileName: `${invNum || 'custom_dummy'}.pdf`, pdfBase64 });
  });

  document.getElementById('resetLedgerBtn').addEventListener('click', async () => {
    try {
      await window.ExactaStore.resetToDefaultDemo();
      document.getElementById('resultPanel').classList.add('hidden');
      showBanner('Sandbox ledger reset to initial 3 pre-seeded records.', 'info');
    } catch (err) {
      showBanner(err.message, 'error');
    }
  });
});
