'use strict';

const pkg = require('../package.json');
const { isSupabaseConfigured } = require('../src/dbRepository');
const { sendJson, handleCorsPreflight, isUpstashConfigured } = require('../src/apiHelpers');
const { DEFAULT_BUCKET } = require('../src/storageRepository');

const STARTED_AT_MS = Date.now();

module.exports = async function handler(req, res) {
  if (handleCorsPreflight(req, res)) return;

  if (req.method !== 'GET') {
    return sendJson(res, 405, { ok: false, error: 'Method Not Allowed. Use GET.' }, req);
  }

  const supabaseEnabled = isSupabaseConfigured();
  const upstashEnabled = isUpstashConfigured();

  return sendJson(
    res,
    200,
    {
      ok: true,
      service: pkg.name,
      version: pkg.version,
      timestamp: new Date().toISOString(),
      uptime_s: Math.floor((Date.now() - STARTED_AT_MS) / 1000),
      capabilities: {
        db_mode: supabaseEnabled ? 'supabase_acid_rpc' : 'local_ledger',
        redis_limiter: upstashEnabled ? 'upstash_redis' : 'in_memory',
        storage_mode: supabaseEnabled ? `supabase_storage:${DEFAULT_BUCKET}` : 'local-inline-ephemeral',
        admin_auth_enabled: Boolean(String(process.env.ADMIN_API_TOKEN || '').trim()),
        rbac_enabled: Boolean(String(process.env.RBAC_TOKENS_JSON || '').trim()),
      },
    },
    req
  );
};
