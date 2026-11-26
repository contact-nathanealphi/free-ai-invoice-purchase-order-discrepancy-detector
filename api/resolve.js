'use strict';

const { createRepository } = require('../src/dbRepository');
const {
  sendJson,
  handleCorsPreflight,
  parseJsonBody,
  requireAdminAuth,
  resolveActorContext,
  getClientIp,
  FINANCE_MANAGER_LIMIT_IDR,
} = require('../src/apiHelpers');

function computeIdrEquivalent(amount, currency) {
  const num = Number(amount) || 0;
  const code = String(currency || 'IDR').trim().toUpperCase();
  if (code === 'USD') return num * 16000;
  if (code === 'SGD') return num * 12000;
  return num;
}

module.exports = async function handler(req, res) {
  if (handleCorsPreflight(req, res)) return;
  if (req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: 'Method Not Allowed. Gunakan POST.' }, req);
  }
  if (!requireAdminAuth(req, res, null)) return;

  try {
    const body = await parseJsonBody(req);
    const { id, action, note } = body;

    if (!id || !action) {
      return sendJson(
        res,
        400,
        { ok: false, error: 'Field id dan action (MANUAL APPROVED / REJECTED TO VENDOR) wajib diisi.' },
        req
      );
    }

    const actor = resolveActorContext(req);
    if (actor.actor_role === 'AUDITOR') {
      return sendJson(
        res,
        403,
        { ok: false, error: 'RBAC: Peran AUDITOR bersifat read-only dan tidak dapat menyetujui atau menolak faktur.' },
        req
      );
    }
    if (actor.actor_role === 'AP_CLERK') {
      return sendJson(
        res,
        403,
        { ok: false, error: 'RBAC: Peran AP_CLERK hanya dapat mengunggah faktur; persetujuan memerlukan FINANCE_MANAGER atau CFO.' },
        req
      );
    }

    const normalizedAction = String(action).trim().toUpperCase();
    const repo = createRepository();
    const existing = await repo.getAuditLogById(id);
    if (!existing) {
      return sendJson(res, 404, { ok: false, error: `Audit log dengan ID "${id}" tidak ditemukan.` }, req);
    }

    // Segregation of Duties (Maker-Checker): maker cannot approve their own uploaded invoice
    if (
      normalizedAction === 'MANUAL APPROVED' &&
      existing.created_by &&
      existing.created_by !== 'system-admin' &&
      existing.created_by.toLowerCase() === actor.actor_id.toLowerCase()
    ) {
      return sendJson(
        res,
        403,
        {
          ok: false,
          code: 'SOD_VIOLATION',
          error: `Segregation of Duties (SoD): Maker ("${actor.actor_id}") tidak boleh menyetujui faktur yang diunggah sendiri.`,
        },
        req
      );
    }

    // Multi-level approval: invoices > Rp50M require CFO final sign-off
    const amountIdr = computeIdrEquivalent(existing.grand_total, existing.currency);
    let targetAction = normalizedAction;
    let escalated = false;
    if (
      normalizedAction === 'MANUAL APPROVED' &&
      amountIdr > FINANCE_MANAGER_LIMIT_IDR &&
      actor.actor_role === 'FINANCE_MANAGER'
    ) {
      targetAction = 'PENDING_CFO_APPROVAL';
      escalated = true;
    }

    const updated = await repo.resolveAuditLog(id, targetAction, note || '', {
      actor_id: actor.actor_id,
      actor_role: actor.actor_role,
      ip_address: getClientIp(req),
      event_action: escalated ? 'ESCALATED_TO_CFO' : normalizedAction,
    });

    return sendJson(
      res,
      200,
      {
        ok: true,
        escalated,
        actor,
        audit_log: updated,
      },
      req
    );
  } catch (err) {
    const status = err.statusCode || (err.message.includes('tidak ditemukan') ? 404 : 400);
    return sendJson(res, status, { ok: false, error: err.message }, req);
  }
};
