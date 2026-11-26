'use strict';

(function (global) {
  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function statusBadgeClass(status) {
    const s = String(status || '').toUpperCase();
    if (s === 'ACTIVE' || s === 'APPROVED' || s === 'MANUAL APPROVED') {
      return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    }
    if (s === 'PENDING_CFO_APPROVAL' || s === 'SUSPENDED' || s === 'HUMAN REVIEW') {
      return 'bg-amber-50 text-amber-700 border-amber-200';
    }
    return 'bg-rose-50 text-rose-700 border-rose-200';
  }

  async function loadVendorMaster() {
    const tbody = document.getElementById('vendorMasterTableBody');
    const errBox = document.getElementById('vendorMasterError');
    if (!tbody) return;
    if (errBox) errBox.classList.add('hidden');
    tbody.innerHTML = '<tr><td colspan="5" class="px-3 py-4 text-center text-zinc-400">Loading Vendor Master...</td></tr>';

    try {
      const resp = await fetch('/api/vendors');
      const data = await resp.json();
      if (!resp.ok || !data.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      const vendors = Array.isArray(data.vendors) ? data.vendors : [];
      if (vendors.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="px-3 py-4 text-center text-zinc-400">No registered vendors yet.</td></tr>';
        return;
      }
      tbody.innerHTML = vendors
        .map(
          (v) => `
          <tr class="hover:bg-zinc-50">
            <td class="px-3 py-2 font-mono text-[11px] text-zinc-600">${esc(v.vendor_code)}</td>
            <td class="px-3 py-2 font-medium text-zinc-900">${esc(v.vendor_name)}</td>
            <td class="px-3 py-2 font-mono text-[11px] text-zinc-700">${esc(v.bank_name)} · ${esc(v.bank_account_number)}</td>
            <td class="px-3 py-2 font-mono text-[11px] text-zinc-500">${esc(v.npwp || '-')}</td>
            <td class="px-3 py-2">
              <span class="inline-flex px-2 py-0.5 rounded border text-[10px] font-mono font-semibold ${statusBadgeClass(v.status)}">${esc(v.status || 'ACTIVE')}</span>
            </td>
          </tr>`
        )
        .join('');
    } catch (err) {
      tbody.innerHTML = '';
      if (errBox) {
        errBox.textContent = err.message;
        errBox.classList.remove('hidden');
      }
    }
  }

  async function loadAuditEvents() {
    const list = document.getElementById('auditEventsList');
    const errBox = document.getElementById('auditEventsError');
    if (!list) return;
    if (errBox) errBox.classList.add('hidden');
    list.innerHTML = '<div class="py-6 text-center text-zinc-400">Loading immutable audit trail...</div>';

    try {
      const resp = await fetch('/api/audit-events');
      const data = await resp.json();
      if (!resp.ok || !data.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      const events = Array.isArray(data.events) ? [...data.events].reverse() : [];
      if (events.length === 0) {
        list.innerHTML =
          '<div class="py-6 text-center text-zinc-400">No immutable audit_events recorded yet. Run or resolve an invoice in server mode to populate.</div>';
        return;
      }
      list.innerHTML = events
        .slice(0, 50)
        .map(
          (ev) => `
          <div class="p-3 rounded-lg border border-zinc-200 bg-white space-y-1">
            <div class="flex items-center justify-between gap-2">
              <span class="font-mono text-[11px] font-semibold text-zinc-900">${esc(ev.action)}</span>
              <span class="text-[10px] font-mono text-zinc-400">${esc(ev.created_at)}</span>
            </div>
            <div class="text-[11px] text-zinc-700 flex flex-wrap items-center gap-1.5">
              <span class="font-mono">${esc(ev.previous_status || 'NEW')}</span>
              <span>→</span>
              <span class="inline-flex px-1.5 py-0.5 rounded border text-[10px] font-mono font-semibold ${statusBadgeClass(ev.next_status)}">${esc(ev.next_status)}</span>
            </div>
            <div class="text-[11px] text-zinc-500">
              Actor: <span class="font-mono text-zinc-700">${esc(ev.actor_id)}</span> (${esc(ev.actor_role)})
              ${ev.reason ? `· ${esc(ev.reason)}` : ''}
            </div>
          </div>`
        )
        .join('');
    } catch (err) {
      list.innerHTML = '';
      if (errBox) {
        errBox.textContent = err.message;
        errBox.classList.remove('hidden');
      }
    }
  }

  function initEnterprisePanels() {
    const vendorModal = document.getElementById('vendorMasterModal');
    const vendorForm = document.getElementById('vendorMasterForm');
    const timelineModal = document.getElementById('auditEventsModal');

    ['openVendorMasterBtn', 'mobileOpenVendorMasterBtn'].forEach((id) => {
      const btn = document.getElementById(id);
      if (btn && vendorModal) {
        btn.addEventListener('click', () => {
          vendorModal.classList.remove('hidden');
          loadVendorMaster();
        });
      }
    });

    ['openAuditEventsBtn', 'mobileOpenAuditEventsBtn'].forEach((id) => {
      const btn = document.getElementById(id);
      if (btn && timelineModal) {
        btn.addEventListener('click', () => {
          timelineModal.classList.remove('hidden');
          loadAuditEvents();
        });
      }
    });

    if (vendorForm) {
      vendorForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = document.getElementById('vendorMasterError');
        if (errBox) errBox.classList.add('hidden');
        const payload = {
          vendor_name: document.getElementById('vmVendorName')?.value?.trim(),
          bank_name: document.getElementById('vmBankName')?.value?.trim(),
          bank_account_number: document.getElementById('vmBankAccount')?.value?.trim(),
          npwp: document.getElementById('vmNpwp')?.value?.trim(),
          status: document.getElementById('vmStatus')?.value || 'ACTIVE',
        };
        try {
          const resp = await fetch('/api/vendors', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const data = await resp.json();
          if (!resp.ok || !data.ok) throw new Error(data.error || `HTTP ${resp.status}`);
          vendorForm.reset();
          await loadVendorMaster();
        } catch (err) {
          if (errBox) {
            errBox.textContent = err.message;
            errBox.classList.remove('hidden');
          }
        }
      });
    }

    document.querySelectorAll('[data-close-enterprise-modal]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetId = btn.getAttribute('data-close-enterprise-modal');
        const modal = targetId ? document.getElementById(targetId) : null;
        if (modal) modal.classList.add('hidden');
      });
    });
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initEnterprisePanels);
    } else {
      initEnterprisePanels();
    }
  }

  global.ExactaEnterprisePanels = {
    loadVendorMaster,
    loadAuditEvents,
    initEnterprisePanels,
  };
})(typeof window !== 'undefined' ? window : globalThis);
