'use strict';

const { createRepository } = require('../src/dbRepository');
const { sendJson, handleCorsPreflight } = require('../src/apiHelpers');

module.exports = async function handler(req, res) {
  if (handleCorsPreflight(req, res)) return;
  if (req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: 'Method Not Allowed. Gunakan POST.' });
  }

  try {
    const repo = createRepository();
    const result = await repo.resetSandboxData();
    return sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err.message });
  }
};
