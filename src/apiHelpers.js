'use strict';

const crypto = require('node:crypto');

/**
 * Shared helpers for Vercel Serverless Functions and local HTTP server.
 */

function resolveCorsOrigin(req) {
  const configured = String(process.env.ALLOWED_ORIGINS || '').trim();
  const requestOrigin = req && req.headers ? String(req.headers.origin || '').trim() : '';

  if (configured && configured !== '*') {
    const allowlist = configured
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (requestOrigin && allowlist.includes(requestOrigin)) {
      return requestOrigin;
    }
    return '';
  }

  if (!req) {
    return '*';
  }
  if (requestOrigin) {
    const host = String(req.headers?.host || '').trim();
    if (
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(requestOrigin) ||
      (host && (requestOrigin === `https://${host}` || requestOrigin === `http://${host}`))
    ) {
      return requestOrigin;
    }
    return configured === '*' ? '*' : '';
  }
  return '*';
}

function sendJson(res, statusCode, payload, req = null) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  const corsOrigin = resolveCorsOrigin(req);
  if (corsOrigin) {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    if (corsOrigin !== '*') {
      res.setHeader('Vary', 'Origin');
    }
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, x-admin-token, x-actor-id, x-actor-role, x-ai-provider, x-ai-model, x-ai-api-key'
  );
  res.end(JSON.stringify(payload));
}

function handleCorsPreflight(req, res) {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {}, req);
    return true;
  }
  return false;
}

const MAX_JSON_BODY_BYTES = 15 * 1024 * 1024;

async function parseJsonBody(req) {
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }
  if (typeof req.body === 'string' && req.body.trim()) {
    return JSON.parse(req.body);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let byteLength = 0;
    let aborted = false;

    req.on('data', (chunk) => {
      if (aborted) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      byteLength += buf.byteLength;
      if (byteLength > MAX_JSON_BODY_BYTES) {
        aborted = true;
        if (typeof req.destroy === 'function') {
          req.destroy();
        }
        const err = new Error('Payload melebihi batas 15MB.');
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(buf);
    });

    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        const err = new Error('Body JSON tidak valid.');
        err.statusCode = 400;
        reject(err);
      }
    });

    req.on('error', (err) => {
      if (!aborted) reject(err);
    });
  });
}

function getClientIp(req) {
  const vercelForwarded = req.headers?.['x-vercel-forwarded-for'];
  if (typeof vercelForwarded === 'string' && vercelForwarded.trim()) {
    return vercelForwarded.split(',')[0].trim();
  }
  const realIp = req.headers?.['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim();
  }
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    const parts = forwarded.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) {
      return parts[parts.length - 1];
    }
  }
  return req.socket?.remoteAddress || 'unknown';
}

function extractAdminToken(req) {
  const authHeader = String(req?.headers?.authorization || '').trim();
  if (/^bearer\s+/i.test(authHeader)) {
    return authHeader.replace(/^bearer\s+/i, '').trim();
  }
  return String(req?.headers?.['x-admin-token'] || '').trim();
}

const RBAC_ROLES = new Set(['AP_CLERK', 'FINANCE_MANAGER', 'CFO', 'AUDITOR']);
const FINANCE_MANAGER_LIMIT_IDR = 50_000_000;

function timingSafeMatch(expected, provided) {
  const expectedBuf = Buffer.from(String(expected || ''), 'utf8');
  const providedBuf = Buffer.from(String(provided || ''), 'utf8');
  if (expectedBuf.length === 0 || expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

function lookupRbacToken(providedToken) {
  const rawJson = String(process.env.RBAC_TOKENS_JSON || '').trim();
  if (!rawJson || !providedToken) {
    return null;
  }
  try {
    const tokenMap = JSON.parse(rawJson);
    if (!tokenMap || typeof tokenMap !== 'object') return null;
    for (const [tokenKey, identity] of Object.entries(tokenMap)) {
      if (timingSafeMatch(tokenKey, providedToken) && identity && typeof identity === 'object') {
        const role = String(identity.role || identity.actor_role || '').trim().toUpperCase();
        const actorId = String(identity.actor_id || identity.id || 'rbac-user').trim();
        if (RBAC_ROLES.has(role)) {
          return { actor_id: actorId, actor_role: role, authenticated_via: 'rbac_token' };
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

function resolveActorContext(req) {
  const providedToken = extractAdminToken(req);
  const rbacIdentity = lookupRbacToken(providedToken);
  if (rbacIdentity) {
    return rbacIdentity;
  }
  const rawRole = String(req?.headers?.['x-actor-role'] || '').trim().toUpperCase();
  const actorRole = RBAC_ROLES.has(rawRole) ? rawRole : 'FINANCE_MANAGER';
  const actorId = String(req?.headers?.['x-actor-id'] || '').trim() || 'system-admin';
  return {
    actor_id: actorId,
    actor_role: actorRole,
    authenticated_via: providedToken ? 'admin_token' : 'local_default',
  };
}

function isAdminRequest(req) {
  const provided = extractAdminToken(req);
  if (!provided) {
    return false;
  }
  if (lookupRbacToken(provided)) {
    return true;
  }
  const expected = String(process.env.ADMIN_API_TOKEN || '').trim();
  if (!expected) {
    return false;
  }
  return timingSafeMatch(expected, provided);
}

function requireAdminAuth(req, res, allowedRoles = ['FINANCE_MANAGER', 'CFO']) {
  const expected = String(process.env.ADMIN_API_TOKEN || '').trim();
  const hasRbacTokens = Boolean(String(process.env.RBAC_TOKENS_JSON || '').trim());
  if (expected || hasRbacTokens) {
    if (!isAdminRequest(req)) {
      sendJson(res, 401, { ok: false, error: 'Unauthorized: valid ADMIN_API_TOKEN or RBAC token required.' }, req);
      return false;
    }
    if (Array.isArray(allowedRoles) && allowedRoles.length > 0) {
      const actor = resolveActorContext(req);
      if (actor.authenticated_via === 'rbac_token' && !allowedRoles.includes(actor.actor_role)) {
        sendJson(
          res,
          403,
          { ok: false, error: `RBAC: Peran ${actor.actor_role} tidak memiliki izin untuk operasi admin ini.` },
          req
        );
        return false;
      }
    }
    return true;
  }

  if (process.env.VERCEL === '1' && process.env.ALLOW_UNAUTHENTICATED_ADMIN !== 'true') {
    sendJson(
      res,
      403,
      { ok: false, error: 'Admin endpoint disabled on public deployment without ADMIN_API_TOKEN.' },
      req
    );
    return false;
  }

  return true;
}

const rateLimitStore = new Map();
const RATE_LIMIT_MAX = 25;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

const demoQuotaStore = new Map();
const DEMO_DAILY_LIMIT = 2;
const DEMO_WINDOW_MS = 24 * 60 * 60 * 1000;

function pruneExpiredEntries(store, now) {
  if (store.size <= 500) return;
  for (const [k, v] of store.entries()) {
    if (!v || now > v.resetAt) {
      store.delete(k);
    }
  }
}

function checkDailyDemoQuota(ip, store = demoQuotaStore, limit = DEMO_DAILY_LIMIT) {
  const now = Date.now();
  pruneExpiredEntries(store, now);
  const entry = store.get(ip);
  if (!entry || now > entry.resetAt) {
    store.set(ip, { count: 1, resetAt: now + DEMO_WINDOW_MS });
    return { allowed: true, remaining: limit - 1, limit };
  }
  if (entry.count >= limit) {
    return { allowed: false, remaining: 0, limit, resetAt: entry.resetAt };
  }
  entry.count += 1;
  return { allowed: true, remaining: limit - entry.count, limit };
}

function checkRateLimit(ip) {
  const now = Date.now();
  pruneExpiredEntries(rateLimitStore, now);
  const entry = rateLimitStore.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 };
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }
  entry.count += 1;
  return { allowed: true, remaining: RATE_LIMIT_MAX - entry.count };
}

function isUpstashConfigured(options = {}) {
  const url = String(options.redisUrl ?? process.env.UPSTASH_REDIS_REST_URL ?? '').trim();
  const token = String(options.redisToken ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? '').trim();
  return Boolean(url && token);
}

async function incrementUpstashWindow({
  key,
  limit,
  windowSeconds,
  redisUrl = process.env.UPSTASH_REDIS_REST_URL,
  redisToken = process.env.UPSTASH_REDIS_REST_TOKEN,
  fetchImpl = globalThis.fetch,
}) {
  const baseUrl = String(redisUrl || '').replace(/\/+$/, '');
  const resp = await fetchImpl(`${baseUrl}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${redisToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([
      ['INCR', key],
      ['TTL', key],
    ]),
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined,
  });

  if (!resp.ok) {
    throw new Error(`Upstash Redis HTTP ${resp.status}`);
  }
  const results = await resp.json();
  const count = Number(results?.[0]?.result);
  const ttl = Number(results?.[1]?.result);
  if (!Number.isFinite(count)) {
    throw new Error('Upstash Redis returned non-numeric INCR result');
  }

  // Ensure expiration is attached on first increment or if key lacks TTL
  if (count === 1 || ttl < 0) {
    await fetchImpl(`${baseUrl}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${redisToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([['EXPIRE', key, windowSeconds]]),
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined,
    });
  }

  const allowed = count <= limit;
  return {
    allowed,
    remaining: Math.max(0, limit - count),
    limit,
    count,
    backend: 'upstash_redis',
  };
}

async function checkDailyDemoQuotaAsync(ip, options = {}) {
  const limit = Number(options.limit) || DEMO_DAILY_LIMIT;
  if (isUpstashConfigured(options)) {
    try {
      const dayKey = new Date().toISOString().slice(0, 10);
      return await incrementUpstashWindow({
        key: `exacta:demo_quota:${dayKey}:${ip}`,
        limit,
        windowSeconds: Math.floor(DEMO_WINDOW_MS / 1000),
        redisUrl: options.redisUrl,
        redisToken: options.redisToken,
        fetchImpl: options.fetchImpl,
      });
    } catch {
      // Fall back to in-memory limiter if Upstash is temporarily unreachable
    }
  }
  return {
    ...checkDailyDemoQuota(ip, options.store || demoQuotaStore, limit),
    backend: 'in_memory',
  };
}

async function checkRateLimitAsync(ip, options = {}) {
  const limit = Number(options.limit) || RATE_LIMIT_MAX;
  if (isUpstashConfigured(options)) {
    try {
      return await incrementUpstashWindow({
        key: `exacta:rate_limit:${ip}`,
        limit,
        windowSeconds: Math.floor(RATE_LIMIT_WINDOW_MS / 1000),
        redisUrl: options.redisUrl,
        redisToken: options.redisToken,
        fetchImpl: options.fetchImpl,
      });
    } catch {
      // Fall back to in-memory limiter if Upstash is temporarily unreachable
    }
  }
  return {
    ...checkRateLimit(ip),
    backend: 'in_memory',
  };
}

module.exports = {
  resolveCorsOrigin,
  sendJson,
  handleCorsPreflight,
  parseJsonBody,
  getClientIp,
  isAdminRequest,
  requireAdminAuth,
  resolveActorContext,
  RBAC_ROLES,
  FINANCE_MANAGER_LIMIT_IDR,
  isUpstashConfigured,
  checkRateLimit,
  checkRateLimitAsync,
  checkDailyDemoQuota,
  checkDailyDemoQuotaAsync,
  DEMO_DAILY_LIMIT,
};
