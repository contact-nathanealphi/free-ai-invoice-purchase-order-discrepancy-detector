'use strict';

const { createRepository } = require('../src/dbRepository');
const { sendJson, handleCorsPreflight, parseJsonBody } = require('../src/apiHelpers');

module.exports = async function handler(req, res) {
  if (handleCorsPreflight(req, res)) return;

  if (req.method !== 'POST' && req.method !== 'PATCH') {
    return sendJson(res, 405, { ok: false, error: 'Method Not Allowed. Gunakan POST atau PATCH.' });
  }

  try {
    const body = await parseJsonBody(req);
    const repo = createRepository();

    if (req.method === 'POST') {
      const created = await repo.createPurchaseOrder(body);
      return sendJson(res, 201, { ok: true, purchase_order: created });
    }

    const updated = await repo.updateGoodsReceipt(body.po_number, body.items);
    return sendJson(res, 200, { ok: true, purchase_order: updated });
  } catch (err) {
    const status = err.message.includes('tidak ditemukan') ? 404 : 400;
    return sendJson(res, status, { ok: false, error: err.message });
  }
};
