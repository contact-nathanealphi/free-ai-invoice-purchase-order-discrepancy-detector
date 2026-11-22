'use strict';

/**
 * Shared helpers for Vercel Serverless Functions and local HTTP server.
 */

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-ai-provider, x-ai-model, x-ai-api-key');
  res.end(JSON.stringify(payload));
}

function handleCorsPreflight(req, res) {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return true;
  }
  return false;
}

async function parseJsonBody(req) {
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }
  if (typeof req.body === 'string' && req.body.trim()) {
    return JSON.parse(req.body);
  }
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 15 * 1024 * 1024) {
        reject(new Error('Payload melebihi batas 15MB.'));
      }
    });
    req.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Body JSON tidak valid.'));
      }
    });
    req.on('error', reject);
  });
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

const rateLimitStore = new Map();
const RATE_LIMIT_MAX = 25;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

const demoQuotaStore = new Map();
const DEMO_DAILY_LIMIT = 2;
const DEMO_WINDOW_MS = 24 * 60 * 60 * 1000;

function checkDailyDemoQuota(ip, store = demoQuotaStore, limit = DEMO_DAILY_LIMIT) {
  const now = Date.now();
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

module.exports = {
  sendJson,
  handleCorsPreflight,
  parseJsonBody,
  getClientIp,
  checkRateLimit,
  checkDailyDemoQuota,
  DEMO_DAILY_LIMIT,
};
