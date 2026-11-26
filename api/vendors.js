'use strict';

const { createRepository } = require('../src/dbRepository');
const { sendJson, handleCorsPreflight, parseJsonBody, requireAdminAuth } = require('../src/apiHelpers');

module.exports = async function handler(req, res) {
  if (handleCorsPreflight(req, res)) return;

  if (req.method !== 'GET' && req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: 'Method Not Allowed. Gunakan GET atau POST.' }, req);
  }

  try {
    const repo = createRepository();

    if (req.method === 'GET') {
      const vendors = await repo.getVendors();
      return sendJson(res, 200, { ok: true, mode: repo.mode, vendors }, req);
    }

    if (!requireAdminAuth(req, res)) return;

    const body = await parseJsonBody(req);
    const saved = await repo.upsertVendor(body);
    return sendJson(res, 201, { ok: true, vendor: saved }, req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { ok: false, error: err.message }, req);
  }
};
