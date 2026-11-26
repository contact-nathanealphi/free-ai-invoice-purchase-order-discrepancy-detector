'use strict';

const { createRepository } = require('../src/dbRepository');
const { sendJson, handleCorsPreflight } = require('../src/apiHelpers');

module.exports = async function handler(req, res) {
  if (handleCorsPreflight(req, res)) return;

  if (req.method !== 'GET') {
    return sendJson(res, 405, { ok: false, error: 'Method Not Allowed. Gunakan GET.' }, req);
  }

  try {
    const parsedUrl = new URL(req.url || '/api/audit-events', 'http://localhost');
    const auditLogId = parsedUrl.searchParams.get('audit_log_id') || null;
    const repo = createRepository();
    const events = await repo.getAuditEvents(auditLogId);
    return sendJson(res, 200, { ok: true, mode: repo.mode, events }, req);
  } catch (err) {
    return sendJson(res, err.statusCode || 500, { ok: false, error: err.message }, req);
  }
};
