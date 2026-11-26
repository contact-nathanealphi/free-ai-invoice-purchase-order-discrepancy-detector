'use strict';

const crypto = require('node:crypto');

const SENSITIVE_KEY_PATTERN = /(token|secret|password|api[_-]?key|authorization|service[_-]?role)/i;

function sanitizeFields(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEY_PATTERN.test(k)) {
      out[k] = '[REDACTED]';
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = sanitizeFields(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function getCorrelationId(req) {
  const existing = req?.headers?.['x-request-id'] || req?.headers?.['x-correlation-id'];
  if (typeof existing === 'string' && existing.trim()) {
    return existing.trim().slice(0, 64);
  }
  if (req && req._correlationId) {
    return req._correlationId;
  }
  const id = crypto.randomUUID();
  if (req && typeof req === 'object') {
    req._correlationId = id;
  }
  return id;
}

function formatLogEntry(level, event, fields = {}) {
  return JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...sanitizeFields(fields),
  });
}

function logInfo(event, fields = {}) {
  if (process.env.NODE_ENV === 'test' || process.env.SILENT_LOGS === '1') return;
  console.log(formatLogEntry('info', event, fields));
}

function logWarn(event, fields = {}) {
  if (process.env.NODE_ENV === 'test' || process.env.SILENT_LOGS === '1') return;
  console.warn(formatLogEntry('warn', event, fields));
}

function logError(event, fields = {}) {
  if (process.env.NODE_ENV === 'test' || process.env.SILENT_LOGS === '1') return;
  console.error(formatLogEntry('error', event, fields));
}

module.exports = {
  getCorrelationId,
  sanitizeFields,
  formatLogEntry,
  logInfo,
  logWarn,
  logError,
};
