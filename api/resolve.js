'use strict';

const { createRepository } = require('../src/dbRepository');
const { sendJson, handleCorsPreflight, parseJsonBody } = require('../src/apiHelpers');

module.exports = async function handler(req, res) {
  if (handleCorsPreflight(req, res)) return;
  if (req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: 'Method Not Allowed. Gunakan POST.' });
  }

  try {
    const body = await parseJsonBody(req);
    const { id, action, note } = body;

    if (!id || !action) {
      return sendJson(res, 400, {
        ok: false,
        error: 'Field id dan action (MANUAL APPROVED / REJECTED TO VENDOR) wajib diisi.',
      });
    }

    const repo = createRepository();
    const updated = await repo.resolveAuditLog(id, action, note || '');

    return sendJson(res, 200, {
      ok: true,
      audit_log: updated,
    });
  } catch (err) {
    const status = err.message.includes('tidak ditemukan') ? 404 : 400;
    return sendJson(res, status, { ok: false, error: err.message });
  }
};
