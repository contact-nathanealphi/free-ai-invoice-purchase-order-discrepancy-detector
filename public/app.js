'use strict';

const PROVIDER_MODELS = {
  gemini: [
    { id: 'gemini-2.5-flash', label: 'gemini-2.5-flash — Recommended Digital & Compact (Fast, Free/Low Quota)' },
    { id: 'gemini-3-flash-preview', label: 'gemini-3-flash-preview — Balanced Default (Fast & Accurate)' },
    { id: 'gemini-2.5-pro', label: 'gemini-2.5-pro — Blurry Scans & Complex Tables' },
  ],
  openai: [
    { id: 'gpt-4o-mini', label: 'gpt-4o-mini — Recommended Digital & Compact (Super Cost-Efficient)' },
    { id: 'gpt-4o', label: 'gpt-4o — Complex Scans & Multi-Page Tables' },
  ],
  anthropic: [
    { id: 'claude-3-5-haiku-latest', label: 'claude-3-5-haiku-latest — Recommended Digital & Compact (Fast)' },
    { id: 'claude-sonnet-4-0', label: 'claude-sonnet-4-0 — Deep Scan & Complex Reasoning' },
  ],
};

let activeLogId = null;
let activeGrnPoNumber = null;
let activePdfBlobUrl = null;
let activeLedgerFilter = 'all';
let ledgerSearchQuery = '';
let stagedIntakeFiles = [];
let pendingExtractedPo = null;
let pendingBulkCsvPos = [];
let selectedLogIds = new Set();
let ledgerSortBy = 'created_at';
let ledgerSortDir = 'desc';
let vaultModalHandler = null;
let activePaidLogId = null;

const ACCEPTED_MIME_BY_EXT = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

function inferMimeType(file) {
  if (file.type && Object.values(ACCEPTED_MIME_BY_EXT).includes(file.type.toLowerCase())) {
    return file.type.toLowerCase();
  }
  const ext = String(file.name || '').split('.').pop().toLowerCase();
  return ACCEPTED_MIME_BY_EXT[ext] || '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function forensicBadgeHtml(level, score) {
  const lv = String(level || 'CLEAN').toUpperCase();
  if (lv === 'HIGH_RISK') {
    return `<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold bg-rose-50 text-rose-700 border border-rose-200">RISK ${Number(score || 0)}</span>`;
  }
  if (lv === 'WATCH') {
    return `<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold bg-amber-50 text-amber-700 border border-amber-200">WATCH ${Number(score || 0)}</span>`;
  }
  return '';
}

function formatCurrency(amount, currency = 'IDR') {
  if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return '-';
  const num = Number(amount);
  const code = String(currency || 'IDR').toUpperCase();
  return code === 'IDR'
    ? `Rp${Math.round(num).toLocaleString('id-ID')}`
    : `${code} ${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

function showBanner(message, type = 'info') {
  const el = document.getElementById('statusBanner');
  const styles = {
    info: 'bg-white text-zinc-800 border-zinc-200',
    success: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    error: 'bg-rose-50 text-rose-800 border-rose-200',
  };
  el.className = `rounded-lg px-4 py-2.5 text-xs font-medium flex items-center justify-between border ${styles[type] || styles.info}`;
  el.innerHTML = `<span>${escapeHtml(message)}</span><button onclick="this.parentElement.classList.add('hidden')" class="ml-4 text-xs underline cursor-pointer">Dismiss</button>`;
  el.classList.remove('hidden');
}

function setAuditingState(isLoading, label = 'Processing...') {
  const spinner = document.getElementById('auditSpinner');
  document.getElementById('auditSpinnerText').textContent = label;
  spinner.classList.toggle('hidden', !isLoading);
}

function switchView(viewName) {
  const titles = {
    overview: 'Overview & Intake',
    ledger: 'Audit Ledger',
    pos: 'Purchase Orders & GRN',
    policies: 'Audit Policies',
    cfo: 'CFO & Vendor Insights',
    api: 'API & Webhooks',
  };
  document.getElementById('activeViewTitle').textContent = titles[viewName] || 'Overview & Intake';

  document.getElementById('viewOverview').classList.toggle('hidden', viewName !== 'overview');
  document.getElementById('viewLedger').classList.toggle('hidden', viewName !== 'overview' && viewName !== 'ledger');
  document.getElementById('viewPos').classList.toggle('hidden', viewName !== 'pos');
  document.getElementById('viewPolicies').classList.toggle('hidden', viewName !== 'policies');
  document.getElementById('viewCfo').classList.toggle('hidden', viewName !== 'cfo');
  document.getElementById('viewApi').classList.toggle('hidden', viewName !== 'api');

  if (viewName === 'policies') renderPolicyForm();
  if (viewName === 'cfo') renderCfoDashboard();

  document.querySelectorAll('.nav-item').forEach((btn) => {
    const isActive = btn.dataset.nav === viewName;
    btn.className = isActive
      ? 'nav-item w-full flex items-center justify-between px-3 py-2 rounded-lg bg-zinc-100 text-zinc-900 font-semibold cursor-pointer'
      : 'nav-item w-full flex items-center justify-between px-3 py-2 rounded-lg text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900 cursor-pointer';
  });
}

function renderByokBadge() {
  const cfg = window.ExactaStore.getByokConfig();
  const textEl = document.getElementById('aiModeText');
  const dotEl = document.getElementById('aiModeDot');
  if (cfg.provider === 'local_ollama') {
    textEl.textContent = `Local AI (${cfg.localModel || 'ollama'})`;
    dotEl.className = 'w-2 h-2 rounded-full bg-sky-500 shrink-0';
  } else if (cfg.apiKey) {
    textEl.textContent = `BYOK: ${cfg.provider.toUpperCase()} (${cfg.model})`;
    dotEl.className = 'w-2 h-2 rounded-full bg-emerald-500 shrink-0';
  } else {
    textEl.textContent = 'Server Demo (2/day)';
    dotEl.className = 'w-2 h-2 rounded-full bg-zinc-500 shrink-0';
  }
}

function renderAliasList() {
  const container = document.getElementById('aliasListContainer');
  if (!container) return;
  const aliases = window.ExactaStore.getItemAliases();
  if (!aliases.length) {
    container.innerHTML = '<div class="text-zinc-400 text-[11px]">No learned item aliases yet.</div>';
    return;
  }
  container.innerHTML = aliases
    .map(
      (a) => `<div class="flex items-center justify-between gap-2 px-3 py-1.5 rounded border border-zinc-200 bg-zinc-50">
        <div class="font-mono text-[11px] text-zinc-800 truncate">${escapeHtml(a.invoice_item)} <span class="text-zinc-400">→</span> <strong>${escapeHtml(a.po_item)}</strong> ${a.po_number ? `<span class="text-zinc-400">(${escapeHtml(a.po_number)})</span>` : ''}</div>
        <button type="button" data-del-alias="${escapeHtml(a.id)}" class="text-[11px] text-rose-600 hover:underline cursor-pointer shrink-0">Remove</button>
      </div>`
    )
    .join('');

  container.querySelectorAll('button[data-del-alias]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await window.ExactaStore.deleteItemAlias(btn.dataset.delAlias);
      renderAliasList();
      showBanner('Item alias removed.', 'info');
    });
  });
}

function renderPolicyForm() {
  const pol = window.ExactaStore.getPolicyConfig();
  document.getElementById('polPriceTol').value = pol.priceTolerancePct;
  document.getElementById('polAutoCeiling').value = pol.autoApproveCeiling;
  document.getElementById('polMandatoryGrn').value = pol.mandatoryGrnThreshold;
  document.getElementById('polSplitThreshold').value = pol.splitThreshold;
  document.getElementById('polSplitWindow').value = pol.splitWindowDays;
  document.getElementById('polPpnRate').value = pol.ppnRatePct ?? 11;
  document.getElementById('polPphRate').value = pol.pphRatePct ?? 2;
  document.getElementById('polFxUsd').value = pol.fxUsdIdr ?? 16000;
  document.getElementById('polFxSgd').value = pol.fxSgdIdr ?? 12000;
  document.getElementById('polForbiddenKeywords').value = (pol.forbiddenFeeKeywords || []).join(', ');
  renderAliasList();
}

function renderCfoDashboard() {
  const logs = window.ExactaStore.getWorkspace().auditLogs || [];
  const pol = window.ExactaStore.getPolicyConfig();
  const aging = window.ExactaAccounting.computeApAgingAndCashflow(logs, new Date(), {
    USD: pol.fxUsdIdr || 16000,
    SGD: pol.fxSgdIdr || 12000,
  });
  const leaderboard = window.ExactaAccounting.computeVendorTrustLeaderboard(logs);

  document.getElementById('cfoTotalPayable').textContent = formatCurrency(aging.totalPayableIdr, 'IDR');
  document.getElementById('cfoEarlySavingsTotal').textContent = formatCurrency(aging.totalEarlyDiscountSavingsIdr, 'IDR');

  const total = aging.totalPayableIdr || 1;
  const segments = [
    { key: 'overdue', label: 'Overdue', val: aging.buckets.overdue, bar: 'bg-rose-600', text: 'text-rose-700' },
    { key: 'days0to7', label: '0–7 Days', val: aging.buckets.days0to7, bar: 'bg-amber-500', text: 'text-amber-700' },
    { key: 'days8to30', label: '8–30 Days', val: aging.buckets.days8to30, bar: 'bg-zinc-700', text: 'text-zinc-800' },
    { key: 'days30plus', label: '30+ Days', val: aging.buckets.days30plus, bar: 'bg-zinc-400', text: 'text-zinc-600' },
  ];

  document.getElementById('cfoAgingBar').innerHTML = segments
    .map((s) => `<div class="${s.bar}" style="width:${Math.round((s.val / total) * 100)}%" title="${s.label}: ${formatCurrency(s.val, 'IDR')}"></div>`)
    .join('');

  document.getElementById('cfoAgingBuckets').innerHTML = segments
    .map(
      (s) => `<div class="rounded-lg border border-zinc-200 p-2.5 bg-zinc-50/50">
        <div class="text-[10px] uppercase tracking-wider text-zinc-500">${s.label}</div>
        <div class="font-mono font-semibold mt-1 ${s.text}">${formatCurrency(s.val, 'IDR')}</div>
      </div>`
    )
    .join('');

  document.getElementById('cfoEarlyDiscountList').innerHTML = aging.activeDiscounts.length
    ? aging.activeDiscounts
        .map(
          (d) => `<div class="flex items-center justify-between px-2.5 py-1.5 rounded border border-emerald-200 bg-emerald-50/60 text-[11px]">
            <span class="truncate font-medium text-emerald-900">${escapeHtml(d.invoice_number)} (${escapeHtml(d.terms)})</span>
            <span class="font-mono font-semibold text-emerald-700 shrink-0">Save ${formatCurrency(d.savings_idr, 'IDR')}</span>
          </div>`
        )
        .join('')
    : '<div class="text-[11px] text-zinc-400">No active early-payment discounts found.</div>';

  document.getElementById('cfoVendorLeaderboardBody').innerHTML = leaderboard.length
    ? leaderboard
        .map((v) => {
          const scoreCls =
            v.trust_score >= 80
              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
              : v.trust_score >= 50
                ? 'bg-amber-50 text-amber-700 border-amber-200'
                : 'bg-rose-50 text-rose-700 border-rose-200';
          return `<tr class="hover:bg-zinc-50">
            <td class="px-4 py-2.5 font-medium text-zinc-900">${escapeHtml(v.vendor_name)}</td>
            <td class="px-4 py-2.5 text-right font-mono">${v.total_invoices}</td>
            <td class="px-4 py-2.5 text-right font-mono">${v.clean_count} / ${v.hold_count}</td>
            <td class="px-4 py-2.5 text-right font-mono">${v.forensic_hits}</td>
            <td class="px-4 py-2.5 text-right font-mono text-rose-700">${formatCurrency(v.blocked_value_idr, 'IDR')}</td>
            <td class="px-4 py-2.5 text-right"><span class="px-2 py-0.5 rounded border font-mono font-semibold ${scoreCls}">${v.trust_score}/100</span></td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="6" class="px-4 py-6 text-center text-zinc-400">No vendor audit data yet.</td></tr>';
}

function renderWorkspace() {
  const ws = window.ExactaStore.getWorkspace();
  const kpi = window.ExactaStore.computeKpis(ws.auditLogs);
  const purchaseOrders = ws.purchaseOrders || [];
  const auditLogs = ws.auditLogs || [];

  renderByokBadge();

  document.getElementById('kpiTotalAudited').textContent = kpi.total_audited;
  document.getElementById('kpiBlockedIdr').textContent = formatCurrency(kpi.discrepancy_blocked_idr, 'IDR');
  document.getElementById('kpiAiCostIdr').textContent = `Rp${Number(kpi.total_ai_cost_idr || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  document.getElementById('kpiAutoRate').textContent = `${kpi.auto_approval_rate}%`;

  const needsReviewCount = auditLogs.filter((l) => {
    const s = String(l.audit_status || '').toUpperCase();
    return s.startsWith('HOLD') || s === 'HUMAN REVIEW';
  }).length;
  const reviewBadge = document.getElementById('reviewBadgeCount');
  reviewBadge.textContent = needsReviewCount;
  reviewBadge.classList.toggle('hidden', needsReviewCount === 0);

  document.getElementById('poCountBadge').textContent = purchaseOrders.length;

  renderAuditLogsTable(auditLogs);
  renderMasterPoTable(purchaseOrders);
  if (window.lucide) window.lucide.createIcons();
}

function getFilteredLogs(logs) {
  const q = ledgerSearchQuery.trim().toLowerCase();
  const filtered = logs.filter((log) => {
    const status = String(log.audit_status || '').toUpperCase();
    if (activeLedgerFilter === 'action_required' && !(status.startsWith('HOLD') || status === 'HUMAN REVIEW')) {
      return false;
    }
    if (activeLedgerFilter === 'approved' && !(status === 'APPROVED' || status === 'APPROVED - PARTIAL' || status === 'MANUAL APPROVED')) {
      return false;
    }
    if (q) {
      const hay = `${log.po_number || ''} ${log.invoice_number || ''} ${log.vendor_name || ''} ${log.file_name || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const dir = ledgerSortDir === 'asc' ? 1 : -1;
  return [...filtered].sort((a, b) => {
    if (ledgerSortBy === 'grand_total') {
      return (Number(a.grand_total || 0) - Number(b.grand_total || 0)) * dir;
    }
    if (ledgerSortBy === 'risk') {
      return (Number(a.forensic_risk_score || 0) - Number(b.forensic_risk_score || 0)) * dir;
    }
    return String(a.created_at || '').localeCompare(String(b.created_at || '')) * dir;
  });
}

function updateBulkSelectionBar() {
  const bar = document.getElementById('bulkActionsBar');
  const countEl = document.getElementById('bulkSelectedCount');
  countEl.textContent = `${selectedLogIds.size} selected`;
  bar.classList.toggle('hidden', selectedLogIds.size === 0);
}

function renderAuditLogsTable(logs) {
  const filtered = getFilteredLogs(logs);
  document.getElementById('logCountBadge').textContent = filtered.length;
  const tbody = document.getElementById('auditLogsBody');
  const selectAllEl = document.getElementById('ledgerSelectAllCheck');
  if (selectAllEl) {
    selectAllEl.checked = filtered.length > 0 && filtered.every((l) => selectedLogIds.has(l.id));
  }
  updateBulkSelectionBar();

  if (!filtered.length) {
    tbody.innerHTML = `<tr class="h-11"><td colspan="8" class="px-4 py-8 text-center text-zinc-400">No matching audit records found.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered
    .map((log) => {
      const timeStr = log.created_at ? new Date(log.created_at).toLocaleTimeString('en-US', { hour12: false }) : '-';
      const isChecked = selectedLogIds.has(log.id) ? 'checked' : '';
      const statusUpper = String(log.audit_status || '').toUpperCase();
      const isApproved = statusUpper === 'APPROVED' || statusUpper === 'APPROVED - PARTIAL' || statusUpper === 'MANUAL APPROVED';
      const isPaid = String(log.payment_status || '').toUpperCase() === 'PAID';
      const paidBadge = isPaid
        ? `<span title="Paid ${escapeHtml(log.paid_date || '')} (${escapeHtml(log.payment_ref || '')})" class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">PAID</span>`
        : isApproved
          ? `<button type="button" data-mark-paid="${escapeHtml(log.id)}" class="mark-paid-btn px-1.5 py-0.5 rounded text-[10px] font-medium border border-zinc-300 bg-white hover:bg-zinc-900 hover:text-white text-zinc-700 cursor-pointer">Mark Paid</button>`
          : '';
      return `
        <tr data-log-id="${escapeHtml(log.id)}" class="h-11 hover:bg-zinc-50 cursor-pointer transition">
          <td class="px-3 py-2 w-8"><input type="checkbox" data-check-log="${escapeHtml(log.id)}" ${isChecked} class="ledger-row-check rounded border-zinc-300 cursor-pointer" /></td>
          <td class="px-3 py-2 text-zinc-500 whitespace-nowrap font-mono text-[11px]">${escapeHtml(timeStr)}</td>
          <td class="px-3 py-2">
            <div class="font-medium text-zinc-900 font-mono text-[11px] whitespace-nowrap">${escapeHtml(log.invoice_number || '-')}</div>
            <div class="text-[11px] text-zinc-400 truncate max-w-[160px]">${escapeHtml(log.file_name || '-')}</div>
          </td>
          <td class="px-3 py-2 font-mono text-[11px] text-zinc-700 whitespace-nowrap">${escapeHtml(log.po_number || '-')}</td>
          <td class="px-3 py-2 text-zinc-700 truncate max-w-[150px]">${escapeHtml(log.vendor_name || '-')}</td>
          <td class="px-3 py-2 text-right font-mono font-medium text-zinc-900 whitespace-nowrap">${escapeHtml(formatCurrency(log.grand_total, log.currency))}</td>
          <td class="px-3 py-2 whitespace-nowrap">
            <div class="flex items-center gap-1.5">${statusBadgeHtml(log.audit_status)}${forensicBadgeHtml(log.forensic_level, log.forensic_risk_score)}${paidBadge}</div>
          </td>
          <td class="px-3 py-2 text-right font-mono text-[11px] text-zinc-500 whitespace-nowrap">
            ${log.latency_ms ? `${log.latency_ms}ms` : '-'} · Rp${Number(log.cost_idr || 0).toFixed(2)}
          </td>
        </tr>
      `;
    })
    .join('');

  tbody.querySelectorAll('.mark-paid-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openMarkPaidModal(btn.dataset.markPaid);
    });
  });

  tbody.querySelectorAll('.ledger-row-check').forEach((chk) => {
    chk.addEventListener('click', (e) => e.stopPropagation());
    chk.addEventListener('change', (e) => {
      const id = e.target.dataset.checkLog;
      if (e.target.checked) selectedLogIds.add(id);
      else selectedLogIds.delete(id);
      if (selectAllEl) {
        selectAllEl.checked = filtered.length > 0 && filtered.every((l) => selectedLogIds.has(l.id));
      }
      updateBulkSelectionBar();
    });
  });

  tbody.querySelectorAll('tr[data-log-id]').forEach((row) => {
    row.addEventListener('click', () => openDiffModal(row.dataset.logId));
  });
}

function renderMasterPoTable(orders) {
  const tbody = document.getElementById('masterPoBody');
  tbody.innerHTML = orders
    .map((po) => {
      const itemsHtml = (po.items || [])
        .map((i) => {
          const qty = Number(i.qty) || 1;
          const grn = Number(i.grn_received_qty ?? qty);
          const pct = Math.min(100, Math.round((grn / qty) * 100));
          return `
            <div class="space-y-1">
              <div class="flex items-center justify-between gap-2 text-[11px]">
                <span class="text-zinc-800 font-medium">${escapeHtml(i.item_name)}</span>
                <span class="font-mono text-zinc-500">GRN ${grn}/${qty} · Rem ${i.remaining_qty ?? qty} · ${formatCurrency(i.unit_price, po.currency)}</span>
              </div>
              <div class="w-full h-1.5 bg-zinc-100 rounded-full overflow-hidden">
                <div class="h-full bg-zinc-800 rounded-full" style="width:${pct}%"></div>
              </div>
            </div>
          `;
        })
        .join('');
      const badgeCls =
        String(po.status).toUpperCase() === 'OPEN'
          ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
          : 'bg-zinc-100 text-zinc-600 border-zinc-200';
      return `
        <tr class="hover:bg-zinc-50">
          <td class="px-4 py-3 font-mono font-semibold text-zinc-900 whitespace-nowrap align-top">${escapeHtml(po.po_number)}</td>
          <td class="px-4 py-3 text-zinc-700 align-top">${escapeHtml(po.vendor_name)}</td>
          <td class="px-4 py-3 font-mono text-[11px] text-zinc-600 align-top whitespace-nowrap">${escapeHtml(po.po_type)} / ${escapeHtml(po.currency)}</td>
          <td class="px-4 py-3 space-y-2 min-w-[280px]">${itemsHtml}</td>
          <td class="px-4 py-3 align-top"><span class="px-2 py-0.5 rounded-md text-[11px] font-medium border ${badgeCls}">${escapeHtml(po.status)}</span></td>
          <td class="px-4 py-3 text-right whitespace-nowrap align-top">
            <button data-grn-po="${escapeHtml(po.po_number)}" class="update-grn-btn px-2.5 py-1 rounded-lg text-[11px] font-medium bg-white hover:bg-zinc-100 text-zinc-800 border border-zinc-200 transition cursor-pointer">
              Update GRN
            </button>
          </td>
        </tr>
      `;
    })
    .join('');

  tbody.querySelectorAll('.update-grn-btn').forEach((btn) => {
    btn.addEventListener('click', () => openGrnModal(btn.dataset.grnPo));
  });
}

function renderSevenGates(log) {
  const statusUpper = String(log.audit_status || '').toUpperCase();
  const checked = new Set((log.extraction_data && log.extraction_data._checked_rules) || []);

  const gates = [
    { key: 'GATE_1_CONFIDENCE_THRESHOLD', label: '1. OCR Confidence', failMatch: statusUpper === 'HUMAN REVIEW' },
    { key: 'GATE_2_DUPLICATE_CHECK', label: '2. SHA-256 Deduplication', failMatch: statusUpper.includes('DUPLICATE') },
    { key: 'GATE_3_PO_VALIDATION', label: '3. PO Lookup & Status', failMatch: statusUpper.includes('INVALID PO') },
    { key: 'GATE_3B_CURRENCY_GUARD', label: '4. Currency Guard', failMatch: statusUpper.includes('CURRENCY') },
    { key: 'GATE_5_PO_MATCHING_VARIANCE', label: '5. Line-Item & Unordered', failMatch: statusUpper.includes('UNORDERED') || statusUpper.includes('PRICE') },
    { key: 'GATE_5B_3WAY_GRN_MATCH', label: '6. 3-Way Warehouse GRN', failMatch: statusUpper.includes('GRN') },
    { key: 'GATE_4_DETERMINISTIC_MATH_TAX', label: '7. Tax Engine PPN/PPh 23', failMatch: statusUpper.includes('TAX') },
  ];

  document.getElementById('modalGatesList').innerHTML = gates
    .map((g) => {
      let badge = '<span class="font-mono text-zinc-400">SKIP</span>';
      let borderCls = 'border-zinc-200 bg-white text-zinc-500';
      if (g.failMatch) {
        badge = '<span class="font-mono font-semibold text-rose-700">BLOCK</span>';
        borderCls = 'border-rose-200 bg-rose-50 text-rose-800';
      } else if (checked.has(g.key) || statusUpper.startsWith('APPROVED') || statusUpper === 'MANUAL APPROVED') {
        badge = '<span class="font-mono font-semibold text-emerald-700">PASS</span>';
        borderCls = 'border-zinc-200 bg-white text-zinc-800';
      }
      return `<div class="flex items-center justify-between px-2.5 py-1.5 rounded border ${borderCls}"><span>${escapeHtml(g.label)}</span>${badge}</div>`;
    })
    .join('');
}

function buildAuditReportMarkdown(log) {
  const ext = log.extraction_data || {};
  const po = log.po_snapshot;
  const reasons = Array.isArray(log.reasons) ? log.reasons : [];
  return [
    `# AI Invoice & Purchase Order Discrepancy Detector — Audit Report`,
    ``,
    `- **Audit Status:** ${log.audit_status}`,
    `- **Invoice Number:** ${log.invoice_number || '-'}`,
    `- **PO Number:** ${log.po_number || '-'}`,
    `- **Vendor:** ${log.vendor_name || '-'}`,
    `- **Grand Total:** ${formatCurrency(log.grand_total, log.currency)}`,
    `- **Model Used:** ${log.model_used || '-'} (${ext._extraction_method || 'text_markdown'})`,
    `- **SHA-256 Hash:** ${log.file_hash || '-'}`,
    `- **Timestamp:** ${log.created_at || '-'}`,
    ``,
    `## Findings`,
    reasons.length ? reasons.map((r) => `- ${r}`).join('\n') : '- No discrepancies detected.',
    log.reviewer_note ? `\n- **Supervisor Note:** ${log.reviewer_note}` : '',
    ``,
    `## Master PO Snapshot`,
    po
      ? (po.items || []).map((i) => `- ${i.item_name}: PO Qty ${i.qty} | GRN ${i.grn_received_qty ?? i.qty} | Unit ${formatCurrency(i.unit_price, po.currency)}`).join('\n')
      : '- No matching PO found.',
  ].join('\n');
}

function downloadTextFile(filename, content, mimeType = 'text/markdown;charset=utf-8;') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function openDiffModal(logId) {
  const ws = window.ExactaStore.getWorkspace();
  const filteredLogs = getFilteredLogs(ws.auditLogs || []);
  const log = (ws.auditLogs || []).find((l) => l.id === logId);
  if (!log) return;
  activeLogId = logId;

  const curIdx = filteredLogs.findIndex((l) => l.id === logId);
  const prevBtn = document.getElementById('modalPrevLogBtn');
  const nextBtn = document.getElementById('modalNextLogBtn');
  prevBtn.disabled = curIdx <= 0;
  nextBtn.disabled = curIdx < 0 || curIdx >= filteredLogs.length - 1;
  prevBtn.classList.toggle('opacity-40', prevBtn.disabled);
  nextBtn.classList.toggle('opacity-40', nextBtn.disabled);
  prevBtn.onclick = () => { if (curIdx > 0) openDiffModal(filteredLogs[curIdx - 1].id); };
  nextBtn.onclick = () => { if (curIdx >= 0 && curIdx < filteredLogs.length - 1) openDiffModal(filteredLogs[curIdx + 1].id); };

  const statusUpper = String(log.audit_status || '').toUpperCase();
  const ext = log.extraction_data || {};
  const po = log.po_snapshot;

  const hasCurrencyMismatch = statusUpper.includes('CURRENCY') || (po && ext.currency && po.currency && ext.currency.toUpperCase() !== po.currency.toUpperCase());
  const hasTaxMismatch = statusUpper.includes('TAX');
  const hasPriceMismatch = statusUpper.includes('PRICE') || statusUpper.includes('UNORDERED');
  const hasGrnMismatch = statusUpper.includes('GRN');

  document.getElementById('modalTitle').textContent = log.invoice_number || log.file_name || 'Invoice Audit Detail';
  document.getElementById('modalStatusBadge').innerHTML = statusBadgeHtml(log.audit_status);
  document.getElementById('modalMeta').textContent = `Model: ${log.model_used || '-'} · Latency: ${log.latency_ms ?? '-'}ms · Cost: Rp${Number(log.cost_idr || 0).toFixed(2)} · SHA-256: ${(log.file_hash || '').slice(0, 16)}...`;

  const tokenBadge = document.getElementById('modalTokenSavingsBadge');
  if ((ext._extraction_method === 'text_markdown' || ext._extraction_method === 'raw_text') && Number(ext._estimated_tokens_saved_pct) > 0) {
    const label = ext._extraction_method === 'raw_text' ? 'Raw Text' : 'Hybrid Markdown';
    tokenBadge.textContent = `${label} · ~${ext._estimated_tokens_saved_pct}% tokens saved`;
    tokenBadge.classList.remove('hidden');
  } else {
    tokenBadge.classList.add('hidden');
  }

  const hasMd = Boolean(ext._extracted_markdown);
  const copyMdBtn = document.getElementById('copyMdBtn');
  const dlMdBtn = document.getElementById('downloadMdBtn');
  copyMdBtn.classList.toggle('hidden', !hasMd);
  dlMdBtn.classList.toggle('hidden', !hasMd);
  copyMdBtn.onclick = async () => {
    await navigator.clipboard.writeText(ext._extracted_markdown);
    showBanner('Extracted Markdown copied to clipboard.', 'success');
  };
  dlMdBtn.onclick = () => {
    downloadTextFile(`${(log.file_name || 'document').replace(/\.pdf$/i, '')}.md`, ext._extracted_markdown);
  };

  document.getElementById('exportReportMdBtn').onclick = () => {
    const md = buildAuditReportMarkdown(log);
    downloadTextFile(`invoice_po_audit_report_${(log.invoice_number || log.id).replace(/[^a-zA-Z0-9_-]/g, '_')}.md`, md);
  };
  document.getElementById('downloadEvidencePackBtn').onclick = async () => {
    const policySnapshot = log.policy_snapshot || window.ExactaStore.getPolicyConfig();
    const evidenceCore = {
      generated_at: new Date().toISOString(),
      audit_log_id: log.id,
      document_sha256: log.file_hash,
      invoice_number: log.invoice_number,
      po_number: log.po_number,
      vendor_name: log.vendor_name,
      audit_status: log.audit_status,
      forensic_level: log.forensic_level || 'CLEAN',
      forensic_risk_score: log.forensic_risk_score || 0,
      forensic_signals: log.forensic_signals || [],
      checked_rules: ext._checked_rules || [],
      policy_applied: policySnapshot,
      reviewer_action: log.reviewer_action,
      reviewer_note: log.reviewer_note,
    };
    const fingerprint = await window.ExactaVault.sha256Hex(JSON.stringify(evidenceCore));
    const pack = {
      audit_evidence_pack_v1: true,
      tamper_evident_sha256_fingerprint: fingerprint,
      ...evidenceCore,
    };
    downloadTextFile(
      `invoice_po_evidence_${(log.invoice_number || log.id).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`,
      JSON.stringify(pack, null, 2),
      'application/json'
    );
    showBanner(`Tamper-Evident Evidence Pack downloaded (SHA-256: ${fingerprint.slice(0, 12)}...).`, 'success');
  };
  document.getElementById('printReportBtn').onclick = () => window.print();

  if (activePdfBlobUrl) {
    URL.revokeObjectURL(activePdfBlobUrl);
    activePdfBlobUrl = null;
  }
  const iframe = document.getElementById('pdfPreviewFrame');
  const imgFrame = document.getElementById('imagePreviewFrame');
  const textFrame = document.getElementById('textPreviewFrame');
  const emptyPdf = document.getElementById('pdfPreviewEmpty');
  iframe.classList.add('hidden');
  imgFrame.classList.add('hidden');
  textFrame.classList.add('hidden');
  emptyPdf.classList.add('hidden');

  const storedBlob = !ext._pdf_base64 ? await window.ExactaStore.getFileBlob(log.id) : null;
  const docBase64 = ext._pdf_base64 || storedBlob?.base64 || '';
  const mimeType = log.mime_type || ext._mime_type || storedBlob?.mime_type || 'application/pdf';

  if (docBase64 && mimeType.startsWith('image/')) {
    imgFrame.src = `data:${mimeType};base64,${docBase64}`;
    imgFrame.classList.remove('hidden');
  } else if (docBase64) {
    const byteChars = atob(docBase64);
    const byteNumbers = new Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i += 1) {
      byteNumbers[i] = byteChars.charCodeAt(i);
    }
    const blob = new Blob([new Uint8Array(byteNumbers)], { type: 'application/pdf' });
    activePdfBlobUrl = URL.createObjectURL(blob);
    iframe.src = activePdfBlobUrl;
    iframe.classList.remove('hidden');
  } else if (ext._extracted_markdown) {
    textFrame.textContent = ext._extracted_markdown;
    textFrame.classList.remove('hidden');
  } else {
    iframe.src = 'about:blank';
    emptyPdf.classList.remove('hidden');
  }

  const reasonBox = document.getElementById('modalReasonBox');
  const reasons = Array.isArray(log.reasons) ? log.reasons : [];
  if (reasons.length > 0 || log.reviewer_note) {
    reasonBox.className = 'rounded-lg p-3 text-xs border bg-rose-50 text-rose-800 border-rose-200 space-y-1';
    reasonBox.innerHTML = [
      ...reasons.map((r) => `<div><strong>Finding:</strong> ${escapeHtml(r)}</div>`),
      log.reviewer_note ? `<div><strong>Supervisor Note:</strong> ${escapeHtml(log.reviewer_note)}</div>` : '',
    ].join('');
    reasonBox.classList.remove('hidden');
  } else {
    reasonBox.classList.add('hidden');
  }

  renderSevenGates(log);

  // Forensic & Fraud Intelligence Panel
  const fLevel = String(log.forensic_level || 'CLEAN').toUpperCase();
  const fScore = Number(log.forensic_risk_score || 0);
  const fSignals = Array.isArray(log.forensic_signals) ? log.forensic_signals : [];
  const fBadge = document.getElementById('modalForensicBadge');
  const fList = document.getElementById('modalForensicSignals');
  fBadge.textContent = `${fLevel} · ${fScore}/100`;
  fBadge.className =
    fLevel === 'HIGH_RISK'
      ? 'px-2 py-0.5 rounded-md text-[10px] font-mono font-semibold border bg-rose-50 text-rose-700 border-rose-200'
      : fLevel === 'WATCH'
        ? 'px-2 py-0.5 rounded-md text-[10px] font-mono font-semibold border bg-amber-50 text-amber-700 border-amber-200'
        : 'px-2 py-0.5 rounded-md text-[10px] font-mono font-semibold border bg-emerald-50 text-emerald-700 border-emerald-200';
  fList.innerHTML = fSignals.length
    ? fSignals
        .map(
          (s) => `<div class="rounded border px-2.5 py-2 ${s.severity === 'HIGH' ? 'border-rose-200 bg-rose-50/60 text-rose-900' : 'border-amber-200 bg-amber-50/60 text-amber-900'}">
            <div class="font-semibold text-[11px]">${escapeHtml(s.title)} <span class="font-mono text-[10px] opacity-75">(${escapeHtml(s.severity)})</span></div>
            <div class="text-[11px] mt-0.5 opacity-90">${escapeHtml(s.detail)}</div>
          </div>`
        )
        .join('')
    : `<div class="text-[11px] text-zinc-500">No split-invoicing, price-creep, fuzzy duplicate, or chronology anomalies detected.</div>`;

  const hl = (cond) => (cond ? 'bg-rose-100 text-rose-800 px-1.5 py-0.5 rounded font-semibold' : '');

  // Unified Line-by-Line Variance Diff Table
  const diffRows = window.ExactaDispute.buildDiscrepancyRows(log);
  const diffBody = document.getElementById('modalDiffTableBody');
  diffBody.innerHTML = diffRows.length
    ? diffRows
        .map((r) => {
          const hasDiff = Math.abs(r.diff) > 100 || r.status !== 'MATCH';
          const rowCls = hasDiff ? 'bg-rose-50/50' : '';
          const deltaCls = r.diff > 100 ? 'text-rose-700 font-semibold' : 'text-emerald-700';
          return `<tr class="${rowCls}">
            <td class="px-3 py-1.5 text-zinc-900 font-sans">${escapeHtml(r.item_name)}</td>
            <td class="px-3 py-1.5 text-right text-zinc-600">${r.po_qty} × ${escapeHtml(formatCurrency(r.po_price, r.currency))}</td>
            <td class="px-3 py-1.5 text-right ${hasDiff ? 'text-rose-700 font-semibold' : 'text-zinc-900'}">${r.qty} × ${escapeHtml(formatCurrency(r.inv_price, r.currency))}</td>
            <td class="px-3 py-1.5 text-right ${deltaCls}">${r.diff > 0 ? '+' : ''}${escapeHtml(formatCurrency(r.diff, r.currency))}</td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="4" class="px-3 py-3 text-center text-zinc-400 font-sans">No line items extracted.</td></tr>';

  document.getElementById('modalAiDetails').innerHTML = `
    <div class="flex justify-between"><dt class="text-zinc-500">Invoice #</dt><dd class="font-mono font-medium">${escapeHtml(ext.invoice_number || '-')}</dd></div>
    <div class="flex justify-between"><dt class="text-zinc-500">PO #</dt><dd class="font-mono font-medium">${escapeHtml(ext.po_number || '-')}</dd></div>
    <div class="flex justify-between"><dt class="text-zinc-500">Vendor</dt><dd class="font-medium text-right">${escapeHtml(ext.vendor_name || '-')}</dd></div>
    <div class="flex justify-between"><dt class="text-zinc-500">Currency</dt><dd class="font-mono ${hl(hasCurrencyMismatch)}">${escapeHtml(ext.currency || 'IDR')}</dd></div>
    <div class="flex justify-between"><dt class="text-zinc-500">Grand Total</dt><dd class="font-mono font-semibold ${hl(hasPriceMismatch || hasTaxMismatch)}">${escapeHtml(formatCurrency(ext.grand_total, ext.currency))}</dd></div>
    <div class="flex justify-between"><dt class="text-zinc-500">PPN / PPh 23</dt><dd class="font-mono ${hl(hasTaxMismatch)}">${escapeHtml(formatCurrency(ext.ppn_amount ?? ext.tax_amount, ext.currency))} / ${escapeHtml(formatCurrency(ext.pph23_amount || 0, ext.currency))}</dd></div>
    <div class="flex justify-between"><dt class="text-zinc-500">Confidence</dt><dd class="font-mono">${ext.confidence_score ?? '-'}</dd></div>
  `;

  // Link Unordered Item as Alias bar
  const aliasBar = document.getElementById('modalAliasBar');
  const unorderedRows = diffRows.filter((r) => r.status === 'UNORDERED');
  if (unorderedRows.length > 0 && po?.items?.length > 0) {
    const invSel = document.getElementById('aliasInvoiceItemSelect');
    const poSel = document.getElementById('aliasPoItemSelect');
    invSel.innerHTML = unorderedRows.map((r) => `<option value="${escapeHtml(r.item_name)}">${escapeHtml(r.item_name)}</option>`).join('');
    poSel.innerHTML = po.items.map((i) => `<option value="${escapeHtml(i.item_name)}">${escapeHtml(i.item_name)}</option>`).join('');
    document.getElementById('linkItemAliasBtn').onclick = async () => {
      await window.ExactaStore.addItemAlias({
        invoice_item: invSel.value,
        po_item: poSel.value,
        po_number: po.po_number,
      });
      renderAliasList();
      showBanner(`Alias saved: "${invSel.value}" → "${poSel.value}". Future audits will match automatically.`, 'success');
    };
    aliasBar.classList.remove('hidden');
  } else {
    aliasBar.classList.add('hidden');
  }

  const aiItems = Array.isArray(ext.line_items) && ext.line_items.length
    ? ext.line_items
    : ext.item_name ? [{ item_name: ext.item_name, qty: ext.qty, unit_price: ext.unit_price }] : [];
  document.getElementById('modalAiItems').innerHTML = aiItems.length
    ? `<div class="text-[11px] font-semibold text-zinc-500 mb-1">Line Items</div>` +
      aiItems.map((i) => `<div class="text-[11px] border ${hasPriceMismatch || hasGrnMismatch ? 'border-rose-300 bg-rose-50/50' : 'border-zinc-200 bg-zinc-50'} rounded px-2 py-1 mb-1">${escapeHtml(i.item_name)} <span class="font-mono text-zinc-600">(${i.qty} × ${formatCurrency(i.unit_price, ext.currency)})</span></div>`).join('')
    : '';

  if (po) {
    document.getElementById('modalPoDetails').innerHTML = `
      <div class="flex justify-between"><dt class="text-zinc-500">PO #</dt><dd class="font-mono font-medium">${escapeHtml(po.po_number)}</dd></div>
      <div class="flex justify-between"><dt class="text-zinc-500">Vendor</dt><dd class="font-medium text-right">${escapeHtml(po.vendor_name)}</dd></div>
      <div class="flex justify-between"><dt class="text-zinc-500">Type / Currency</dt><dd class="font-mono ${hl(hasCurrencyMismatch)}">${escapeHtml(po.po_type)} / ${escapeHtml(po.currency)}</dd></div>
      <div class="flex justify-between"><dt class="text-zinc-500">PO Status</dt><dd class="font-mono font-semibold">${escapeHtml(po.status)}</dd></div>
    `;
    document.getElementById('modalPoItems').innerHTML =
      `<div class="text-[11px] font-semibold text-zinc-500 mb-1">PO &amp; GRN Items</div>` +
      (po.items || []).map((i) => `<div class="text-[11px] border ${hasGrnMismatch ? 'border-rose-300 bg-rose-50/50' : 'border-zinc-200 bg-zinc-50'} rounded px-2 py-1 mb-1">${escapeHtml(i.item_name)} <span class="font-mono text-zinc-600">(PO:${i.qty} | GRN:${i.grn_received_qty ?? i.qty} | ${formatCurrency(i.unit_price, po.currency)})</span></div>`).join('');
  } else {
    document.getElementById('modalPoDetails').innerHTML = `<div class="text-xs text-rose-600 font-semibold">No matching PO found in Master PO.</div>`;
    document.getElementById('modalPoItems').innerHTML = '';
  }

  // Early Payment Discount Radar in Modal
  const earlyBox = document.getElementById('modalEarlyDiscountBox');
  const earlyInfo = window.ExactaAccounting.calculateEarlyPaymentDiscount(log);
  if (earlyInfo.hasDiscount && earlyInfo.isActive) {
    earlyBox.innerHTML = `<strong>Early Payment Discount (${escapeHtml(earlyInfo.paymentTerms)}):</strong> Pay before <span class="font-mono font-semibold">${escapeHtml(earlyInfo.discountDeadline)}</span> to save <span class="font-mono font-semibold">${escapeHtml(formatCurrency(earlyInfo.savingsAmount, log.currency))}</span>.`;
    earlyBox.classList.remove('hidden');
  } else {
    earlyBox.classList.add('hidden');
  }

  // 1-Click Dispute Action Pack
  const disputePanel = document.getElementById('modalDisputePackPanel');
  const isDisputeEligible =
    statusUpper.startsWith('HOLD') ||
    statusUpper === 'REJECTED TO VENDOR' ||
    String(log.forensic_level || '').toUpperCase() === 'HIGH_RISK';
  if (isDisputeEligible) {
    disputePanel.classList.remove('hidden');
    let activeDisputeTab = 'email';
    const refreshDispute = () => {
      const lang = document.getElementById('disputeLangSelect').value;
      const tone = document.getElementById('disputeToneSelect').value;
      const pack = window.ExactaDispute.generateDisputePack(log, { lang, tone });
      const previewEl = document.getElementById('disputePreviewText');
      if (activeDisputeTab === 'wa') previewEl.value = pack.whatsappText;
      else if (activeDisputeTab === 'debit') previewEl.value = `DEBIT NOTE DN-${log.invoice_number || '-'}\nAdjustment: ${formatCurrency(pack.correctionAmount, log.currency)}\n\n${pack.emailBody}`;
      else previewEl.value = `Subject: ${pack.subject}\n\n${pack.emailBody}`;
      document.getElementById('mailtoDisputeLink').href = pack.mailtoUrl;
      document.getElementById('printDebitNoteBtn').onclick = () => {
        const w = window.open('', '_blank', 'width=800,height=700');
        if (w) {
          w.document.write(`<html><head><title>Debit Note</title></head><body>${pack.debitNoteHtml}<script>window.print();</script></body></html>`);
          w.document.close();
        }
      };
    };
    document.querySelectorAll('.dispute-tab-btn').forEach((btn) => {
      btn.onclick = () => {
        activeDisputeTab = btn.dataset.disputeTab;
        document.querySelectorAll('.dispute-tab-btn').forEach((b) => {
          b.className = b.dataset.disputeTab === activeDisputeTab
            ? 'dispute-tab-btn px-2.5 py-1 rounded bg-zinc-900 text-white font-medium cursor-pointer'
            : 'dispute-tab-btn px-2.5 py-1 rounded border border-zinc-200 bg-white text-zinc-700 font-medium cursor-pointer';
        });
        refreshDispute();
      };
    });
    document.getElementById('disputeLangSelect').onchange = refreshDispute;
    document.getElementById('disputeToneSelect').onchange = refreshDispute;
    document.getElementById('copyDisputeBtn').onclick = async () => {
      await navigator.clipboard.writeText(document.getElementById('disputePreviewText').value);
      showBanner('Dispute text copied to clipboard.', 'success');
    };
    refreshDispute();
  } else {
    disputePanel.classList.add('hidden');
  }

  document.getElementById('reviewerNoteInput').value = log.reviewer_note || '';
  document.getElementById('diffModal').classList.remove('hidden');
  if (window.lucide) window.lucide.createIcons();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`Failed to read file ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/**
 * Lightweight zero-dependency client-side ZIP extractor (STORE + DEFLATE via DecompressionStream).
 */
async function extractFilesFromZip(zipFile) {
  const buffer = await zipFile.arrayBuffer();
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder('utf-8');
  const extracted = [];

  // Find End of Central Directory (PK\x05\x06)
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('Invalid .zip archive (EOCD header not found).');

  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  let ptr = cdOffset;

  for (let idx = 0; idx < totalEntries && ptr + 46 <= bytes.length; idx += 1) {
    if (view.getUint32(ptr, true) !== 0x02014b50) break;
    const compressionMethod = view.getUint16(ptr + 10, true);
    const compressedSize = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localHeaderOffset = view.getUint32(ptr + 42, true);
    const fileName = decoder.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    ptr += 46 + nameLen + extraLen + commentLen;

    if (fileName.endsWith('/') || fileName.startsWith('__MACOSX')) continue;
    const ext = fileName.split('.').pop().toLowerCase();
    const mime = ACCEPTED_MIME_BY_EXT[ext];
    if (!mime) continue;

    if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) continue;
    const lhNameLen = view.getUint16(localHeaderOffset + 26, true);
    const lhExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + lhNameLen + lhExtraLen;
    const compressedSlice = bytes.subarray(dataStart, dataStart + compressedSize);

    let fileBytes;
    if (compressionMethod === 0) {
      fileBytes = compressedSlice;
    } else if (compressionMethod === 8 && typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([compressedSlice]).stream().pipeThrough(ds);
      fileBytes = new Uint8Array(await new Response(stream).arrayBuffer());
    } else {
      continue;
    }

    const cleanName = fileName.split('/').pop() || fileName;
    extracted.push(new File([fileBytes], cleanName, { type: mime }));
    if (extracted.length >= 50) break;
  }

  return extracted;
}

async function stageIntakeFilesList(fileList) {
  const incoming = Array.from(fileList || []);
  const expanded = [];

  for (const f of incoming) {
    if (f.name.toLowerCase().endsWith('.zip') || f.type === 'application/zip') {
      try {
        const zipEntries = await extractFilesFromZip(f);
        expanded.push(...zipEntries);
      } catch (err) {
        showBanner(`ZIP error (${f.name}): ${err.message}`, 'error');
      }
    } else if (inferMimeType(f)) {
      expanded.push(f);
    }
    if (expanded.length >= 50) break;
  }

  const files = expanded.slice(0, 50);
  if (!files.length) {
    showBanner('Please select valid PDF, JPG, PNG, WEBP, or .zip files.', 'error');
    return;
  }

  stagedIntakeFiles = files;
  const panel = document.getElementById('preFlightPanel');
  const countEl = document.getElementById('preFlightCount');
  const listEl = document.getElementById('preFlightList');
  countEl.textContent = files.length;

  listEl.innerHTML = files
    .map((f) => {
      const sizeMb = (f.size / (1024 * 1024)).toFixed(2);
      const mime = inferMimeType(f);
      const isOver4Mb = f.size > 4 * 1024 * 1024;
      const isImage = mime.startsWith('image/');
      const isHeavy = f.size > 1.5 * 1024 * 1024;
      const readiness = isOver4Mb
        ? '<span class="text-rose-700 font-semibold">Warning: &gt;4MB (Vercel limit)</span>'
        : isImage
          ? '<span class="text-sky-700">Photo/Image · Vision Mode</span>'
          : isHeavy
            ? '<span class="text-amber-700">Heavy PDF · Vision Recommended</span>'
            : '<span class="text-emerald-700">Digital PDF · Token-Saver (~80%)</span>';
      return `
        <div class="flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-lg bg-white border border-zinc-200 text-xs">
          <span class="font-medium text-zinc-900 truncate">${escapeHtml(f.name)}</span>
          <div class="flex items-center gap-3 font-mono text-[11px]">
            <span class="text-zinc-500">${sizeMb} MB</span>
            ${readiness}
          </div>
        </div>
      `;
    })
    .join('');
  panel.classList.remove('hidden');
}

async function postAuditWithRetry(payload, maxRetries = 2) {
  const byokCfg = window.ExactaStore.getByokConfig();
  const enrichedPayload = {
    ...payload,
    policyConfig: window.ExactaStore.getPolicyConfig(),
    itemAliases: window.ExactaStore.getItemAliases(),
  };

  if (byokCfg.provider === 'local_ollama' && !enrichedPayload.sampleId && !enrichedPayload.preExtractedInvoice) {
    const localRes = await window.ExactaLocalAi.extractInvoiceWithLocalAi({
      baseUrl: byokCfg.localBaseUrl,
      model: byokCfg.localModel,
      rawText: enrichedPayload.rawText || '',
      fileBase64: enrichedPayload.fileBase64 || enrichedPayload.pdfBase64 || '',
      mimeType: enrichedPayload.mimeType || 'application/pdf',
    });
    enrichedPayload.preExtractedInvoice = localRes.data;
    enrichedPayload.modelUsed = localRes.model_used;
    enrichedPayload.latencyMs = localRes.latency_ms;
    enrichedPayload.extractionMethod = 'local_offline_ai';
  }

  let attempt = 0;
  while (true) {
    const res = await fetch('/api/audit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...window.ExactaStore.getByokHeaders(),
      },
      body: JSON.stringify(enrichedPayload),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 429 && data.code === 'DEMO_QUOTA_EXCEEDED') {
      return { res, data };
    }
    if ((res.status === 429 || res.status === 503) && attempt < maxRetries) {
      attempt += 1;
      await sleep(1500 * attempt);
      continue;
    }
    return { res, data };
  }
}

async function runStagedBatchAudit() {
  if (!stagedIntakeFiles.length) return;
  const files = [...stagedIntakeFiles];
  const forceVision = document.getElementById('forceVisionCheck').checked;
  document.getElementById('preFlightPanel').classList.add('hidden');
  stagedIntakeFiles = [];

  const progressWrap = document.getElementById('batchProgressWrap');
  const progressLabel = document.getElementById('batchProgressLabel');
  const progressPct = document.getElementById('batchProgressPct');
  const progressBar = document.getElementById('batchProgressBar');
  progressWrap.classList.remove('hidden');

  const queueEl = document.getElementById('batchQueueList');
  queueEl.classList.remove('hidden');
  const queueState = files.map((f) => ({ name: f.name, status: 'Queued', cls: 'text-zinc-500' }));

  const renderQueue = (doneCount = 0) => {
    const pct = Math.round((doneCount / files.length) * 100);
    progressLabel.textContent = `${doneCount} / ${files.length} processed`;
    progressPct.textContent = `${pct}%`;
    progressBar.style.width = `${pct}%`;

    queueEl.innerHTML = queueState
      .map(
        (q) => `<div class="flex items-center justify-between px-3 py-1.5 rounded-lg bg-zinc-50 border border-zinc-200 text-xs">
          <span class="font-medium text-zinc-800 truncate">${escapeHtml(q.name)}</span>
          <span class="font-mono ${q.cls}">${escapeHtml(q.status)}</span>
        </div>`
      )
      .join('');
  };
  renderQueue(0);

  for (let i = 0; i < files.length; i += 1) {
    queueState[i].status = 'Auditing...';
    queueState[i].cls = 'text-zinc-900 font-semibold';
    renderQueue(i);
    setAuditingState(true, `Queue ${i + 1}/${files.length}: ${files[i].name}`);

    try {
      const fileBase64 = await readFileAsDataUrl(files[i]);
      const mimeType = inferMimeType(files[i]) || 'application/pdf';
      const ws = window.ExactaStore.getWorkspace();
      const { res, data } = await postAuditWithRetry({
        fileName: files[i].name,
        fileBase64,
        mimeType,
        forceVision,
        purchaseOrders: ws.purchaseOrders,
        auditLogs: ws.auditLogs,
      });

      if (res.status === 429 && data.code === 'DEMO_QUOTA_EXCEEDED') {
        openByokModal(data.error);
        queueState[i].status = 'Demo quota reached';
        queueState[i].cls = 'text-amber-700 font-semibold';
        renderQueue(i);
        break;
      }
      if (!res.ok || !data.ok) throw new Error(data.error || 'Failed');

      await window.ExactaStore.addAuditLog(data.audit_log);
      const savedPct = data.estimated_tokens_saved_pct ? ` (~${data.estimated_tokens_saved_pct}% saved)` : '';
      queueState[i].status = `${data.audit_log.audit_status}${savedPct}`;
      queueState[i].cls = String(data.audit_log.audit_status).startsWith('APPROVED')
        ? 'text-emerald-700 font-semibold'
        : 'text-rose-700 font-semibold';
    } catch (err) {
      queueState[i].status = `Error: ${err.message}`;
      queueState[i].cls = 'text-rose-700';
    }
    renderQueue(i + 1);
    if (i < files.length - 1) await sleep(600);
  }

  setAuditingState(false);
  renderWorkspace();
  showBanner(`Queue completed for ${files.length} document(s).`, 'success');
}

function openByokModal(quotaNotice = '') {
  const cfg = window.ExactaStore.getByokConfig();
  const noticeEl = document.getElementById('byokQuotaNotice');
  if (quotaNotice) {
    noticeEl.textContent = quotaNotice;
    noticeEl.classList.remove('hidden');
  } else {
    noticeEl.classList.add('hidden');
  }
  const provider = cfg.provider || 'gemini';
  document.getElementById('byokProviderSelect').value = provider;
  toggleByokProviderFields(provider);
  populateByokModels(provider === 'local_ollama' ? 'gemini' : provider, cfg.model);
  document.getElementById('byokKeyInput').value = cfg.apiKey || '';
  document.getElementById('localBaseUrlInput').value = cfg.localBaseUrl || 'http://localhost:11434/v1';
  document.getElementById('localModelInput').value = cfg.localModel || 'qwen2.5:7b';
  document.getElementById('byokModal').classList.remove('hidden');
}

function toggleByokProviderFields(provider) {
  const isLocal = provider === 'local_ollama';
  document.getElementById('cloudAiFields').classList.toggle('hidden', isLocal);
  document.getElementById('localAiFields').classList.toggle('hidden', !isLocal);
}

function populateByokModels(provider, selectedModel) {
  const models = PROVIDER_MODELS[provider] || PROVIDER_MODELS.gemini;
  const select = document.getElementById('byokModelSelect');
  select.innerHTML = models
    .map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label)}</option>`)
    .join('');
  if (selectedModel && models.some((m) => m.id === selectedModel)) {
    select.value = selectedModel;
  }
}

function addNewPoItemRow() {
  const container = document.getElementById('newPoItemsContainer');
  const row = document.createElement('div');
  row.className = 'grid grid-cols-12 gap-2 items-center po-item-row';
  row.innerHTML = `
    <input placeholder="Item Name" required class="col-span-5 rounded-lg border border-zinc-300 px-2.5 py-1.5 po-item-name" />
    <input type="number" min="1" placeholder="Qty" required class="col-span-2 rounded-lg border border-zinc-300 px-2 py-1.5 font-mono po-item-qty" />
    <input type="number" min="0" placeholder="Unit Price" required class="col-span-3 rounded-lg border border-zinc-300 px-2 py-1.5 font-mono po-item-price" />
    <input type="number" min="0" placeholder="GRN" class="col-span-2 rounded-lg border border-zinc-300 px-2 py-1.5 font-mono po-item-grn" />
  `;
  container.appendChild(row);
}

function openMarkPaidModal(logId) {
  const log = (window.ExactaStore.getWorkspace().auditLogs || []).find((l) => l.id === logId);
  if (!log) return;
  activePaidLogId = logId;
  document.getElementById('markPaidSubtitle').textContent = `${log.invoice_number || log.file_name} — ${formatCurrency(log.grand_total, log.currency)}`;
  document.getElementById('paidDateInput').value = new Date().toISOString().slice(0, 10);
  document.getElementById('paidRefInput').value = '';
  document.getElementById('markPaidModal').classList.remove('hidden');
}

function openGrnModal(poNumber) {
  const ws = window.ExactaStore.getWorkspace();
  const po = (ws.purchaseOrders || []).find((p) => p.po_number === poNumber);
  if (!po) return;
  activeGrnPoNumber = poNumber;
  document.getElementById('grnModalSubtitle').textContent = `${po.po_number} — ${po.vendor_name}`;
  document.getElementById('grnItemsList').innerHTML = (po.items || [])
    .map(
      (item) => `
      <div class="p-3 rounded-lg border border-zinc-200 bg-zinc-50 flex items-center justify-between gap-3">
        <div>
          <div class="font-medium text-zinc-900">${escapeHtml(item.item_name)}</div>
          <div class="text-[11px] text-zinc-500 font-mono">PO Qty: ${item.qty} · Rem: ${item.remaining_qty ?? item.qty}</div>
        </div>
        <div class="w-28">
          <label class="block text-[10px] font-semibold text-zinc-500 mb-0.5">GRN Received</label>
          <input type="number" min="0" data-item-name="${escapeHtml(item.item_name)}" value="${item.grn_received_qty ?? item.qty}" class="grn-qty-input w-full rounded-lg border border-zinc-300 px-2.5 py-1 font-mono bg-white" />
        </div>
      </div>
    `
    )
    .join('');
  document.getElementById('grnModal').classList.remove('hidden');
}

function exportAuditLogsCsv() {
  const logs = window.ExactaStore.getWorkspace().auditLogs || [];
  if (!logs.length) {
    showBanner('No audit logs available to export.', 'info');
    return;
  }
  const headers = ['id', 'created_at', 'file_name', 'invoice_number', 'po_number', 'vendor_name', 'currency', 'grand_total', 'audit_status', 'cost_idr', 'latency_ms'];
  const rows = logs.map((l) => headers.map((h) => `"${String(l[h] ?? '').replace(/"/g, '""')}"`).join(','));
  const csv = [headers.join(','), ...rows].join('\n');
  downloadTextFile(`exacta_audit_logs_${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv;charset=utf-8;');
}

document.addEventListener('DOMContentLoaded', async () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  try {
    await window.ExactaStore.initWorkspace();
    renderWorkspace();
    const params = new URLSearchParams(window.location.search);
    const deepLogId = params.get('logId');
    if (deepLogId) openDiffModal(deepLogId);
  } catch (err) {
    showBanner(err.message, 'error');
  }

  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.nav));
  });

  document.getElementById('dismissTransparencyBtn').addEventListener('click', () => {
    document.getElementById('transparencyBanner').classList.add('hidden');
  });

  document.querySelectorAll('.ledger-filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeLedgerFilter = btn.dataset.filter;
      document.querySelectorAll('.ledger-filter-btn').forEach((b) => {
        const isSel = b.dataset.filter === activeLedgerFilter;
        b.className = isSel
          ? 'ledger-filter-btn px-2.5 py-1 rounded-md text-[11px] font-medium bg-white text-zinc-900 shadow-2xs cursor-pointer'
          : 'ledger-filter-btn px-2.5 py-1 rounded-md text-[11px] font-medium text-zinc-600 hover:text-zinc-900 cursor-pointer';
      });
      renderAuditLogsTable(window.ExactaStore.getWorkspace().auditLogs);
    });
  });

  document.getElementById('ledgerSearchInput').addEventListener('input', (e) => {
    ledgerSearchQuery = e.target.value;
    renderAuditLogsTable(window.ExactaStore.getWorkspace().auditLogs);
  });

  // Intake Tabs & Multi-Format Controls
  const switchIntakeTab = (tab) => {
    document.querySelectorAll('.intake-tab-btn').forEach((btn) => {
      const active = btn.dataset.intakeTab === tab;
      btn.className = active
        ? 'intake-tab-btn px-3 py-1.5 rounded-md text-xs font-semibold bg-white text-zinc-900 shadow-2xs cursor-pointer'
        : 'intake-tab-btn px-3 py-1.5 rounded-md text-xs font-medium text-zinc-600 hover:text-zinc-900 cursor-pointer';
    });
    document.getElementById('intakePanelSingle').classList.toggle('hidden', tab !== 'single');
    document.getElementById('intakePanelCompare').classList.toggle('hidden', tab !== 'compare');
    document.getElementById('intakePanelBatch').classList.toggle('hidden', tab !== 'batch');
  };
  document.querySelectorAll('.intake-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchIntakeTab(btn.dataset.intakeTab));
  });

  document.getElementById('singleModeFileBtn').addEventListener('click', () => {
    document.getElementById('singleFileBox').classList.remove('hidden');
    document.getElementById('singleTextBox').classList.add('hidden');
    document.getElementById('singleModeFileBtn').className = 'px-2.5 py-1 rounded-md font-medium bg-white text-zinc-900 shadow-2xs cursor-pointer';
    document.getElementById('singleModeTextBtn').className = 'px-2.5 py-1 rounded-md font-medium text-zinc-600 hover:text-zinc-900 cursor-pointer';
  });
  document.getElementById('singleModeTextBtn').addEventListener('click', () => {
    document.getElementById('singleFileBox').classList.add('hidden');
    document.getElementById('singleTextBox').classList.remove('hidden');
    document.getElementById('singleModeTextBtn').className = 'px-2.5 py-1 rounded-md font-medium bg-white text-zinc-900 shadow-2xs cursor-pointer';
    document.getElementById('singleModeFileBtn').className = 'px-2.5 py-1 rounded-md font-medium text-zinc-600 hover:text-zinc-900 cursor-pointer';
  });

  document.getElementById('runRawTextAuditBtn').addEventListener('click', async () => {
    const rawText = document.getElementById('rawTextInvoiceInput').value.trim();
    if (!rawText) {
      showBanner('Please paste raw invoice text before running audit.', 'error');
      return;
    }
    const fileName = document.getElementById('rawTextFileName').value.trim() || `raw_invoice_${Date.now()}.txt`;
    setAuditingState(true, 'Auditing pasted text...');
    try {
      const ws = window.ExactaStore.getWorkspace();
      const { res, data } = await postAuditWithRetry({
        fileName,
        rawText,
        purchaseOrders: ws.purchaseOrders,
        auditLogs: ws.auditLogs,
      });
      if (res.status === 429 && data.code === 'DEMO_QUOTA_EXCEEDED') {
        openByokModal(data.error);
        return;
      }
      if (!res.ok || !data.ok) throw new Error(data.error || 'Raw text audit failed.');
      await window.ExactaStore.addAuditLog(data.audit_log);
      renderWorkspace();
      openDiffModal(data.audit_log.id);
      showBanner(`Text invoice audited (${data.audit_log.audit_status}).`, 'success');
    } catch (err) {
      showBanner(err.message, 'error');
    } finally {
      setAuditingState(false);
    }
  });

  // Quick 2-Doc Compare (Dual-Drop Ad-Hoc)
  document.getElementById('runAdHocCompareBtn').addEventListener('click', async () => {
    const poFile = document.getElementById('adHocPoFile').files[0];
    const poText = document.getElementById('adHocPoText').value.trim();
    const invFile = document.getElementById('adHocInvFile').files[0];
    const invText = document.getElementById('adHocInvText').value.trim();

    if ((!poFile && !poText) || (!invFile && !invText)) {
      showBanner('Provide both a Purchase Order (file or text) and a Vendor Invoice (file or text).', 'error');
      return;
    }

    setAuditingState(true, '1/2 Extracting PO...');
    try {
      const poPayload = poFile
        ? { fileName: poFile.name, fileBase64: await readFileAsDataUrl(poFile), mimeType: inferMimeType(poFile) }
        : { fileName: 'adhoc_po.txt', rawText: poText };

      const poRes = await fetch('/api/extract-po', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...window.ExactaStore.getByokHeaders() },
        body: JSON.stringify(poPayload),
      });
      const poData = await poRes.json();
      if (poRes.status === 429 && poData.code === 'DEMO_QUOTA_EXCEEDED') {
        openByokModal(poData.error);
        return;
      }
      if (!poRes.ok || !poData.ok) throw new Error(poData.error || 'Failed to extract PO.');

      const extractedPo = poData.purchase_order;
      if (document.getElementById('saveAdHocPoCheck').checked) {
        await window.ExactaStore.createPurchaseOrder(extractedPo, { overwrite: true });
      }

      setAuditingState(true, '2/2 Auditing Invoice vs PO...');
      const ws = window.ExactaStore.getWorkspace();
      const invPayload = invFile
        ? {
            fileName: invFile.name,
            fileBase64: await readFileAsDataUrl(invFile),
            mimeType: inferMimeType(invFile),
            purchaseOrders: [extractedPo, ...ws.purchaseOrders],
            auditLogs: ws.auditLogs,
          }
        : {
            fileName: 'adhoc_invoice.txt',
            rawText: invText,
            purchaseOrders: [extractedPo, ...ws.purchaseOrders],
            auditLogs: ws.auditLogs,
          };

      const { res: invRes, data: invData } = await postAuditWithRetry(invPayload);
      if (invRes.status === 429 && invData.code === 'DEMO_QUOTA_EXCEEDED') {
        openByokModal(invData.error);
        return;
      }
      if (!invRes.ok || !invData.ok) throw new Error(invData.error || 'Failed to audit invoice.');

      await window.ExactaStore.addAuditLog(invData.audit_log);
      renderWorkspace();
      openDiffModal(invData.audit_log.id);
      showBanner(`2-Doc Compare completed: ${invData.audit_log.audit_status}`, 'success');
    } catch (err) {
      showBanner(err.message, 'error');
    } finally {
      setAuditingState(false);
    }
  });

  // Staging & Pre-Flight (Single Dropzone + Batch .zip Dropzone)
  document.getElementById('pdfFileInput').addEventListener('change', (e) => {
    if (e.target.files.length) stageIntakeFilesList(e.target.files);
    e.target.value = '';
  });
  document.getElementById('batchZipInput').addEventListener('change', (e) => {
    if (e.target.files.length) stageIntakeFilesList(e.target.files);
    e.target.value = '';
  });

  const bindDropZone = (el) => {
    if (!el) return;
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('border-zinc-900', 'bg-zinc-50'); });
    el.addEventListener('dragleave', () => el.classList.remove('border-zinc-900', 'bg-zinc-50'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('border-zinc-900', 'bg-zinc-50');
      if (e.dataTransfer.files.length) stageIntakeFilesList(e.dataTransfer.files);
    });
  };
  bindDropZone(document.getElementById('dropZone'));
  bindDropZone(document.getElementById('zipDropZone'));

  document.getElementById('clearStagedBtn').addEventListener('click', () => {
    stagedIntakeFiles = [];
    document.getElementById('preFlightPanel').classList.add('hidden');
  });
  document.getElementById('runBatchAuditBtn').addEventListener('click', runStagedBatchAudit);

  // BYOK Modal
  document.getElementById('openByokBtn').addEventListener('click', () => openByokModal());
  document.getElementById('byokProviderSelect').addEventListener('change', (e) => {
    toggleByokProviderFields(e.target.value);
    if (e.target.value !== 'local_ollama') populateByokModels(e.target.value);
  });
  document.getElementById('byokForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await window.ExactaStore.saveByokConfig({
      provider: document.getElementById('byokProviderSelect').value,
      model: document.getElementById('byokModelSelect').value,
      apiKey: document.getElementById('byokKeyInput').value,
      localBaseUrl: document.getElementById('localBaseUrlInput').value,
      localModel: document.getElementById('localModelInput').value,
    });
    document.getElementById('byokModal').classList.add('hidden');
    renderByokBadge();
    showBanner('AI provider settings saved locally in browser.', 'success');
  });
  document.getElementById('clearByokBtn').addEventListener('click', async () => {
    await window.ExactaStore.clearByokConfig();
    document.getElementById('byokModal').classList.add('hidden');
    renderByokBadge();
    showBanner('Cleared private key. Using Server Demo mode.', 'info');
  });

  // Local Workspace Export / Import / Reset
  document.getElementById('exportWsBtn').addEventListener('click', () => window.ExactaStore.exportWorkspaceJson());
  document.getElementById('importWsInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      await window.ExactaStore.importWorkspaceJson(text);
      renderWorkspace();
      showBanner('Workspace imported successfully.', 'success');
    } catch (err) {
      showBanner(err.message, 'error');
    }
    e.target.value = '';
  });
  document.getElementById('resetWsBtn').addEventListener('click', async () => {
    await window.ExactaStore.resetToDefaultDemo();
    renderWorkspace();
    showBanner('Workspace reset to default demo seed.', 'info');
  });

  // Custom Vault Password Modal + Command Palette + Mobile Drawer Helpers
  function openVaultPasswordModal({ mode = 'lock', onSubmit }) {
    vaultModalHandler = onSubmit;
    const isLock = mode === 'lock';
    document.getElementById('vaultModalTitle').textContent = isLock ? 'Encrypt Workspace Vault (.auditvault)' : 'Unlock Encrypted Vault (.auditvault)';
    document.getElementById('vaultModalDesc').textContent = isLock
      ? 'Choose a password to encrypt all POs, Aliases, and Audit Logs using AES-256-GCM.'
      : 'Enter the password used to encrypt this .auditvault (or legacy .exacta/.parivex) file.';
    document.getElementById('vaultModalSubmitBtn').textContent = isLock ? 'Encrypt & Download' : 'Unlock Vault';
    document.getElementById('vaultStrengthWrap').classList.toggle('hidden', !isLock);
    document.getElementById('vaultModalError').classList.add('hidden');
    const input = document.getElementById('vaultPasswordInput');
    input.value = '';
    input.type = 'password';
    document.getElementById('toggleVaultPassBtn').textContent = 'Show';
    document.getElementById('vaultPasswordModal').classList.remove('hidden');
    input.focus();
  }

  document.getElementById('toggleVaultPassBtn').addEventListener('click', () => {
    const input = document.getElementById('vaultPasswordInput');
    const btn = document.getElementById('toggleVaultPassBtn');
    const isPass = input.type === 'password';
    input.type = isPass ? 'text' : 'password';
    btn.textContent = isPass ? 'Hide' : 'Show';
  });

  document.getElementById('vaultPasswordInput').addEventListener('input', (e) => {
    const val = e.target.value || '';
    const bar = document.getElementById('vaultStrengthBar');
    const label = document.getElementById('vaultStrengthLabel');
    let score = 0;
    if (val.length >= 6) score += 1;
    if (val.length >= 10) score += 1;
    if (/[A-Z]/.test(val) && /[0-9]/.test(val)) score += 1;
    if (/[^A-Za-z0-9]/.test(val)) score += 1;
    const widths = ['20%', '45%', '70%', '85%', '100%'];
    const labels = ['Too Short', 'Weak', 'Fair', 'Strong', 'Enterprise'];
    const colors = ['bg-rose-500', 'bg-rose-500', 'bg-amber-500', 'bg-emerald-500', 'bg-emerald-600'];
    bar.style.width = widths[score];
    bar.className = `h-full transition-all ${colors[score]}`;
    label.textContent = labels[score];
  });

  document.getElementById('vaultPasswordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!vaultModalHandler) return;
    const password = document.getElementById('vaultPasswordInput').value;
    const errEl = document.getElementById('vaultModalError');
    try {
      await vaultModalHandler(password);
      document.getElementById('vaultPasswordModal').classList.add('hidden');
      vaultModalHandler = null;
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });

  // AES-256-GCM Encrypted Vault (.exacta)
  document.getElementById('exportVaultBtn').addEventListener('click', () => {
    openVaultPasswordModal({
      mode: 'lock',
      onSubmit: async (password) => {
        const ws = window.ExactaStore.getWorkspace();
        const encrypted = await window.ExactaVault.encryptWorkspaceVault(ws, password);
        downloadTextFile(`audit_vault_${new Date().toISOString().slice(0, 10)}.auditvault`, encrypted, 'application/json');
        showBanner('AES-256 encrypted .auditvault exported.', 'success');
      },
    });
  });

  document.getElementById('importVaultInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    e.target.value = '';
    openVaultPasswordModal({
      mode: 'unlock',
      onSubmit: async (password) => {
        const decrypted = await window.ExactaVault.decryptWorkspaceVault(text, password);
        await window.ExactaStore.importWorkspaceJson(JSON.stringify(decrypted));
        renderWorkspace();
        showBanner('Encrypted .auditvault unlocked and restored!', 'success');
      },
    });
  });

  // Mobile Drawer & Grouped Header Actions
  const closeMobileNav = () => document.getElementById('mobileNavDrawer').classList.add('hidden');
  document.getElementById('mobileMenuBtn').addEventListener('click', () => document.getElementById('mobileNavDrawer').classList.remove('hidden'));
  document.getElementById('closeMobileNavBtn').addEventListener('click', closeMobileNav);
  document.getElementById('mobileNavBackdrop').addEventListener('click', closeMobileNav);
  document.querySelectorAll('.mobile-nav-item').forEach((btn) => {
    btn.addEventListener('click', closeMobileNav);
  });

  const mobileActionsMenu = document.getElementById('mobileActionsMenu');
  document.getElementById('mobileActionsBtn').addEventListener('click', () => mobileActionsMenu.classList.toggle('hidden'));
  document.getElementById('mobileExportCsvBtn').addEventListener('click', () => { mobileActionsMenu.classList.add('hidden'); exportAuditLogsCsv(); });
  document.getElementById('mobileUploadPoBtn').addEventListener('click', () => { mobileActionsMenu.classList.add('hidden'); document.getElementById('uploadPoPdfBtn').click(); });

  // Bulk Ledger Actions & Sorting
  document.getElementById('ledgerSelectAllCheck').addEventListener('change', (e) => {
    const filtered = getFilteredLogs(window.ExactaStore.getWorkspace().auditLogs || []);
    if (e.target.checked) filtered.forEach((l) => selectedLogIds.add(l.id));
    else filtered.forEach((l) => selectedLogIds.delete(l.id));
    renderAuditLogsTable(window.ExactaStore.getWorkspace().auditLogs || []);
  });

  document.getElementById('bulkApproveBtn').addEventListener('click', async () => {
    if (!selectedLogIds.size) return;
    for (const id of selectedLogIds) {
      await window.ExactaStore.resolveAuditLog(id, 'MANUAL APPROVED', 'Bulk approved from Audit Ledger');
    }
    const count = selectedLogIds.size;
    selectedLogIds.clear();
    renderWorkspace();
    showBanner(`${count} audit log(s) marked MANUAL APPROVED.`, 'success');
  });

  document.getElementById('bulkExportCsvBtn').addEventListener('click', () => {
    const logs = (window.ExactaStore.getWorkspace().auditLogs || []).filter((l) => selectedLogIds.has(l.id));
    if (!logs.length) return;
    const headers = ['id', 'created_at', 'file_name', 'invoice_number', 'po_number', 'vendor_name', 'currency', 'grand_total', 'audit_status'];
    const rows = logs.map((l) => headers.map((h) => `"${String(l[h] ?? '').replace(/"/g, '""')}"`).join(','));
    downloadTextFile(`invoice_po_selected_${new Date().toISOString().slice(0, 10)}.csv`, [headers.join(','), ...rows].join('\n'), 'text/csv;charset=utf-8;');
  });

  document.querySelectorAll('.ledger-sort-th').forEach((th) => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (ledgerSortBy === col) ledgerSortDir = ledgerSortDir === 'asc' ? 'desc' : 'asc';
      else { ledgerSortBy = col; ledgerSortDir = 'desc'; }
      renderAuditLogsTable(window.ExactaStore.getWorkspace().auditLogs || []);
    });
  });

  // Command Palette (Ctrl+K / Cmd+K) & Modal Arrow Navigation
  function renderCommandPalette(query = '') {
    const q = query.trim().toLowerCase();
    const ws = window.ExactaStore.getWorkspace();
    const items = [
      { label: 'Go to Overview & Intake', hint: 'Tab', run: () => switchView('overview') },
      { label: 'Go to Audit Ledger', hint: 'Tab', run: () => switchView('ledger') },
      { label: 'Go to Purchase Orders & GRN', hint: 'Tab', run: () => switchView('pos') },
      { label: 'Go to Audit Policies', hint: 'Tab', run: () => switchView('policies') },
      { label: 'Go to CFO & Vendor Insights', hint: 'Tab', run: () => switchView('cfo') },
      { label: 'Create New Purchase Order', hint: 'Action', run: () => document.getElementById('newPoBtn').click() },
      { label: 'Bulk Import PO CSV (0 Tokens)', hint: 'Action', run: () => { switchView('pos'); document.getElementById('openBulkCsvBtn').click(); } },
      { label: 'Export Accounting CSV', hint: 'Action', run: () => document.getElementById('exportAccountingBtn').click() },
      { label: 'Open Sample Studio', hint: 'Link', run: () => { window.location.href = '/playground.html'; } },
      ...(ws.auditLogs || []).slice(0, 15).map((l) => ({
        label: `Open Invoice ${l.invoice_number || l.file_name} (${l.audit_status})`,
        hint: l.po_number || 'Log',
        run: () => openDiffModal(l.id),
      })),
    ];

    const matched = q ? items.filter((i) => `${i.label} ${i.hint}`.toLowerCase().includes(q)) : items.slice(0, 10);
    const listEl = document.getElementById('cmdPaletteList');
    listEl.innerHTML = matched.length
      ? matched
          .map(
            (m, idx) => `<button type="button" data-cmd-idx="${idx}" class="w-full px-4 py-2.5 text-left flex items-center justify-between hover:bg-zinc-50 cursor-pointer">
              <span class="font-medium text-zinc-900 truncate">${escapeHtml(m.label)}</span>
              <span class="font-mono text-[10px] text-zinc-400 shrink-0 ml-2">${escapeHtml(m.hint)}</span>
            </button>`
          )
          .join('')
      : '<div class="px-4 py-6 text-center text-zinc-400">No matching commands or records.</div>';

    listEl.querySelectorAll('button[data-cmd-idx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.getElementById('commandPaletteModal').classList.add('hidden');
        matched[Number(btn.dataset.cmdIdx)].run();
      });
    });
  }

  function openCommandPalette() {
    const modal = document.getElementById('commandPaletteModal');
    const input = document.getElementById('cmdPaletteInput');
    input.value = '';
    renderCommandPalette('');
    modal.classList.remove('hidden');
    input.focus();
  }

  document.getElementById('openCmdPaletteBtn').addEventListener('click', openCommandPalette);
  document.getElementById('cmdPaletteInput').addEventListener('input', (e) => renderCommandPalette(e.target.value));
  document.getElementById('commandPaletteModal').addEventListener('click', (e) => {
    if (e.target.id === 'commandPaletteModal') e.target.classList.add('hidden');
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openCommandPalette();
    } else if (e.key === 'Escape') {
      document.getElementById('commandPaletteModal').classList.add('hidden');
      document.getElementById('vaultPasswordModal').classList.add('hidden');
    } else if (!document.getElementById('diffModal').classList.contains('hidden')) {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'ArrowLeft') document.getElementById('modalPrevLogBtn').click();
      if (e.key === 'ArrowRight') document.getElementById('modalNextLogBtn').click();
    }
  });

  // Accounting & Bank Transfer Export
  document.getElementById('exportAccountingBtn').addEventListener('click', () => {
    const preset = document.getElementById('accountingPresetSelect').value;
    const logs = window.ExactaStore.getWorkspace().auditLogs || [];
    const { count, csv } = window.ExactaAccounting.generateAccountingCsv(logs, preset);
    if (!count) {
      showBanner('No APPROVED invoices available for accounting export.', 'info');
      return;
    }
    downloadTextFile(`invoice_po_${preset}_${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv;charset=utf-8;');
    showBanner(`Exported ${count} approved invoice(s) for ${preset}.`, 'success');
  });

  // No-Code Audit Policy Engine
  document.getElementById('policyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await window.ExactaStore.savePolicyConfig({
      priceTolerancePct: document.getElementById('polPriceTol').value,
      autoApproveCeiling: document.getElementById('polAutoCeiling').value,
      mandatoryGrnThreshold: document.getElementById('polMandatoryGrn').value,
      splitThreshold: document.getElementById('polSplitThreshold').value,
      splitWindowDays: document.getElementById('polSplitWindow').value,
      ppnRatePct: document.getElementById('polPpnRate').value,
      pphRatePct: document.getElementById('polPphRate').value,
      fxUsdIdr: document.getElementById('polFxUsd').value,
      fxSgdIdr: document.getElementById('polFxSgd').value,
      forbiddenFeeKeywords: document.getElementById('polForbiddenKeywords').value,
    });
    renderWorkspace();
    showBanner('Audit policies saved to IndexedDB and active for next audits.', 'success');
  });

  document.getElementById('markPaidForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!activePaidLogId) return;
    await window.ExactaStore.markAuditLogPaid(activePaidLogId, {
      paid_date: document.getElementById('paidDateInput').value,
      payment_ref: document.getElementById('paidRefInput').value,
    });
    document.getElementById('markPaidModal').classList.add('hidden');
    activePaidLogId = null;
    renderWorkspace();
    showBanner('Invoice marked as PAID and linked PO closed.', 'success');
  });

  document.getElementById('resetPolicyBtn').addEventListener('click', async () => {
    await window.ExactaStore.resetPolicyConfig();
    renderPolicyForm();
    showBanner('Audit policies reset to strict defaults.', 'info');
  });

  // Bulk Import PO CSV (0 Token AI)
  document.getElementById('openBulkCsvBtn').addEventListener('click', () => {
    pendingBulkCsvPos = [];
    document.getElementById('bulkCsvPreviewWrap').classList.add('hidden');
    document.getElementById('bulkCsvModal').classList.remove('hidden');
  });
  document.getElementById('downloadSampleCsvBtn').addEventListener('click', () => {
    downloadTextFile('sample_po_template.csv', window.ExactaStore.generateSamplePoCsv(), 'text/csv;charset=utf-8;');
  });
  document.getElementById('bulkCsvFileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const csvText = await file.text();
      pendingBulkCsvPos = window.ExactaStore.parsePurchaseOrdersCsv(csvText);
      const totalItems = pendingBulkCsvPos.reduce((s, p) => s + p.items.length, 0);
      document.getElementById('bulkCsvSummary').textContent = `Parsed ${pendingBulkCsvPos.length} Purchase Order(s) with ${totalItems} line item(s) (0 AI tokens used).`;
      document.getElementById('bulkCsvPreviewBody').innerHTML = pendingBulkCsvPos
        .slice(0, 8)
        .map(
          (po) => `<tr>
            <td class="px-3 py-1.5 font-semibold text-zinc-900">${escapeHtml(po.po_number)}</td>
            <td class="px-3 py-1.5 text-zinc-700">${escapeHtml(po.vendor_name)}</td>
            <td class="px-3 py-1.5">${escapeHtml(po.currency)}</td>
            <td class="px-3 py-1.5">${escapeHtml(po.po_date)}</td>
            <td class="px-3 py-1.5">${po.items.length} item(s)</td>
          </tr>`
        )
        .join('');
      document.getElementById('bulkCsvPreviewWrap').classList.remove('hidden');
    } catch (err) {
      showBanner(err.message, 'error');
    }
    e.target.value = '';
  });
  document.getElementById('confirmBulkCsvBtn').addEventListener('click', async () => {
    if (!pendingBulkCsvPos.length) return;
    const stats = await window.ExactaStore.bulkImportPurchaseOrders(pendingBulkCsvPos);
    document.getElementById('bulkCsvModal').classList.add('hidden');
    renderWorkspace();
    showBanner(`Bulk CSV imported: ${stats.inserted} new PO(s), ${stats.updated} updated.`, 'success');
  });

  // Upload PO PDF
  const openUploadPo = () => {
    pendingExtractedPo = null;
    document.getElementById('poPdfFileNameLabel').textContent = 'Select a Purchase Order PDF file...';
    document.getElementById('poExtractPreview').classList.add('hidden');
    document.getElementById('uploadPoModal').classList.remove('hidden');
  };
  document.getElementById('uploadPoPdfBtn').addEventListener('click', openUploadPo);
  document.getElementById('uploadPoPdfInlineBtn').addEventListener('click', openUploadPo);

  document.getElementById('poPdfFileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    document.getElementById('poPdfFileNameLabel').textContent = file.name;
    document.getElementById('poExtractSpinner').classList.remove('hidden');
    document.getElementById('poExtractPreview').classList.add('hidden');
    try {
      const fileBase64 = await readFileAsDataUrl(file);
      const mimeType = inferMimeType(file) || 'application/pdf';
      const res = await fetch('/api/extract-po', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...window.ExactaStore.getByokHeaders(),
        },
        body: JSON.stringify({ fileName: file.name, fileBase64, mimeType }),
      });
      const data = await res.json();
      if (res.status === 429 && data.code === 'DEMO_QUOTA_EXCEEDED') {
        document.getElementById('uploadPoModal').classList.add('hidden');
        openByokModal(data.error);
        return;
      }
      if (!res.ok || !data.ok) throw new Error(data.error || 'PO extraction failed.');
      pendingExtractedPo = data.purchase_order;
      document.getElementById('poExtractPreviewBody').innerHTML = `
        <div>PO Number: <strong>${escapeHtml(pendingExtractedPo.po_number)}</strong></div>
        <div>Vendor: <strong>${escapeHtml(pendingExtractedPo.vendor_name)}</strong> (${escapeHtml(pendingExtractedPo.po_type)} / ${escapeHtml(pendingExtractedPo.currency)})</div>
        <div>Method: ${escapeHtml(data.extraction_method)} (~${data.estimated_tokens_saved_pct}% tokens saved)</div>
        <div class="mt-1">Items: ${(pendingExtractedPo.items || []).map((i) => `${escapeHtml(i.item_name)} (${i.qty} × ${formatCurrency(i.unit_price, pendingExtractedPo.currency)})`).join('; ')}</div>
      `;
      document.getElementById('poExtractPreview').classList.remove('hidden');
    } catch (err) {
      showBanner(err.message, 'error');
    } finally {
      document.getElementById('poExtractSpinner').classList.add('hidden');
      e.target.value = '';
    }
  });

  document.getElementById('confirmExtractedPoBtn').addEventListener('click', async () => {
    if (!pendingExtractedPo) return;
    try {
      await window.ExactaStore.createPurchaseOrder(pendingExtractedPo);
      document.getElementById('uploadPoModal').classList.add('hidden');
      renderWorkspace();
      showBanner(`PO ${pendingExtractedPo.po_number} saved to local workspace.`, 'success');
    } catch (err) {
      showBanner(err.message, 'error');
    }
  });

  // Modals
  document.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.getElementById(btn.dataset.closeModal).classList.add('hidden');
    });
  });

  document.getElementById('newPoBtn').addEventListener('click', () => {
    document.getElementById('newPoForm').reset();
    document.getElementById('newPoItemsContainer').innerHTML = '';
    addNewPoItemRow();
    document.getElementById('newPoModal').classList.remove('hidden');
  });
  document.getElementById('addPoItemRowBtn').addEventListener('click', addNewPoItemRow);

  document.getElementById('newPoForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const items = Array.from(document.querySelectorAll('.po-item-row')).map((row) => ({
      item_name: row.querySelector('.po-item-name').value.trim(),
      qty: Number(row.querySelector('.po-item-qty').value),
      unit_price: Number(row.querySelector('.po-item-price').value),
      grn_received_qty: row.querySelector('.po-item-grn').value !== ''
        ? Number(row.querySelector('.po-item-grn').value)
        : Number(row.querySelector('.po-item-qty').value),
    }));
    try {
      const created = await window.ExactaStore.createPurchaseOrder({
        po_number: document.getElementById('poNumInput').value.trim(),
        vendor_name: document.getElementById('poVendorInput').value.trim(),
        po_type: document.getElementById('poTypeInput').value,
        currency: document.getElementById('poCurrencyInput').value,
        items,
      });
      document.getElementById('newPoModal').classList.add('hidden');
      renderWorkspace();
      showBanner(`PO ${created.po_number} created in local workspace.`, 'success');
    } catch (err) {
      showBanner(err.message, 'error');
    }
  });

  document.getElementById('grnForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!activeGrnPoNumber) return;
    const items = Array.from(document.querySelectorAll('.grn-qty-input')).map((input) => ({
      item_name: input.dataset.itemName,
      grn_received_qty: Number(input.value),
    }));
    await window.ExactaStore.updateGoodsReceipt(activeGrnPoNumber, items);
    document.getElementById('grnModal').classList.add('hidden');
    renderWorkspace();
    showBanner(`Warehouse GRN for ${activeGrnPoNumber} updated.`, 'success');
  });

  document.getElementById('exportCsvBtn').addEventListener('click', exportAuditLogsCsv);
  document.getElementById('approveOverrideBtn').addEventListener('click', async () => {
    if (!activeLogId) return;
    const note = document.getElementById('reviewerNoteInput').value.trim();
    await window.ExactaStore.resolveAuditLog(activeLogId, 'MANUAL APPROVED', note);
    document.getElementById('diffModal').classList.add('hidden');
    renderWorkspace();
    showBanner('Audit status updated to MANUAL APPROVED.', 'success');
  });
  document.getElementById('rejectVendorBtn').addEventListener('click', async () => {
    if (!activeLogId) return;
    const note = document.getElementById('reviewerNoteInput').value.trim();
    await window.ExactaStore.resolveAuditLog(activeLogId, 'REJECTED TO VENDOR', note);
    document.getElementById('diffModal').classList.add('hidden');
    renderWorkspace();
    showBanner('Audit status updated to REJECTED TO VENDOR.', 'success');
  });
});
