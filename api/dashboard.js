'use strict';

const {
  createRepository,
  getDefaultSeedPurchaseOrders,
  getDefaultSeedAuditLogs,
} = require('../src/dbRepository');
const { sendJson, handleCorsPreflight, requireAdminAuth } = require('../src/apiHelpers');

const USD_FALLBACK_RATE = 16000;

function computeKpis(auditLogs = []) {
  const totalAudited = auditLogs.length;
  let discrepancyBlockedIdr = 0;
  let totalAiCostIdr = 0;
  let autoApprovedCount = 0;

  for (const log of auditLogs) {
    totalAiCostIdr += Number(log.cost_idr || 0);
    const status = String(log.audit_status || '').toUpperCase();

    if (status === 'APPROVED' || status === 'APPROVED - PARTIAL') {
      autoApprovedCount += 1;
    } else if (status.startsWith('HOLD') || status === 'REJECTED TO VENDOR') {
      const amount = Number(log.grand_total || 0);
      const isUsd = String(log.currency || 'IDR').toUpperCase() === 'USD';
      discrepancyBlockedIdr += isUsd ? amount * USD_FALLBACK_RATE : amount;
    }
  }

  const autoApprovalRate =
    totalAudited > 0 ? Number(((autoApprovedCount / totalAudited) * 100).toFixed(1)) : 0;

  return {
    total_audited: totalAudited,
    discrepancy_blocked_idr: Math.round(discrepancyBlockedIdr),
    total_ai_cost_idr: Number(totalAiCostIdr.toFixed(2)),
    auto_approval_rate: autoApprovalRate,
  };
}

module.exports = async function handler(req, res) {
  if (handleCorsPreflight(req, res)) return;
  if (req.method !== 'GET') {
    return sendJson(res, 405, { ok: false, error: 'Method Not Allowed. Gunakan GET.' }, req);
  }

  try {
    const parsedUrl = new URL(req.url || '/', 'http://localhost');
    const isSeedOnly = parsedUrl.searchParams.get('seed') === '1';

    if (isSeedOnly) {
      const seedPOs = getDefaultSeedPurchaseOrders();
      const seedLogs = getDefaultSeedAuditLogs();
      return sendJson(
        res,
        200,
        {
          ok: true,
          mode: 'seed',
          kpi: computeKpis(seedLogs),
          purchase_orders: seedPOs,
          audit_logs: seedLogs,
        },
        req
      );
    }

    if (process.env.ADMIN_API_TOKEN && !requireAdminAuth(req, res)) {
      return;
    }

    const repo = createRepository();
    if (process.env.VERCEL === '1' && repo.mode === 'supabase') {
      const seedPOs = getDefaultSeedPurchaseOrders();
      const seedLogs = getDefaultSeedAuditLogs();
      return sendJson(
        res,
        200,
        {
          ok: true,
          mode: 'seed',
          kpi: computeKpis(seedLogs),
          purchase_orders: seedPOs,
          audit_logs: seedLogs,
        },
        req
      );
    }

    const [purchaseOrders, auditLogs] = await Promise.all([
      repo.getPurchaseOrders(),
      repo.getAuditLogs(),
    ]);

    return sendJson(
      res,
      200,
      {
        ok: true,
        mode: repo.mode,
        kpi: computeKpis(auditLogs),
        purchase_orders: purchaseOrders,
        audit_logs: auditLogs,
      },
      req
    );
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err.message }, req);
  }
};
