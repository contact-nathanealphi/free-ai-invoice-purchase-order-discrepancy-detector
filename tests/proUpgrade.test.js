'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const healthHandler = require('../api/health');
const { getCorrelationId, sanitizeFields, formatLogEntry } = require('../src/logger');

function createMockRes() {
  const headers = {};
  let body = '';
  return {
    statusCode: 200,
    setHeader(k, v) {
      headers[String(k).toLowerCase()] = v;
    },
    getHeader(k) {
      return headers[String(k).toLowerCase()];
    },
    end(chunk = '') {
      body += chunk;
    },
    json() {
      return JSON.parse(body || '{}');
    },
  };
}

test('Pro-Class Upgrade — Health, Structured Logger, OpenAPI & Repo Standards', async (t) => {
  await t.test('1. GET /api/health returns service capabilities and X-Request-Id header', async () => {
    const res = createMockRes();
    await healthHandler({ method: 'GET', headers: { 'x-request-id': 'req-pro-001' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.getHeader('x-request-id'), 'req-pro-001');
    const payload = res.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.version, '6.0.0');
    assert.ok(payload.capabilities.db_mode);
    assert.ok(payload.capabilities.redis_limiter);
    assert.ok(payload.capabilities.storage_mode);
  });

  await t.test('2. Structured logger redacts sensitive keys and generates correlation IDs', () => {
    const req = { headers: {} };
    const id1 = getCorrelationId(req);
    const id2 = getCorrelationId(req);
    assert.equal(id1, id2);
    assert.ok(id1.length >= 16);

    const sanitized = sanitizeFields({
      api_key: 'AIzaSecret123',
      adminToken: 'top-secret',
      po_number: 'PO-2026-001',
      nested: { authorization: 'Bearer xyz' },
    });
    assert.equal(sanitized.api_key, '[REDACTED]');
    assert.equal(sanitized.adminToken, '[REDACTED]');
    assert.equal(sanitized.nested.authorization, '[REDACTED]');
    assert.equal(sanitized.po_number, 'PO-2026-001');

    const line = JSON.parse(formatLogEntry('info', 'audit_completed', { po_number: 'PO-1', secret: 'nope' }));
    assert.equal(line.level, 'info');
    assert.equal(line.secret, '[REDACTED]');
  });

  await t.test('3. Pro repo artifacts (LICENSE, SECURITY, CONTRIBUTING, CHANGELOG, OpenAPI, ARCHITECTURE) exist', () => {
    const root = path.resolve(__dirname, '..');
    const requiredFiles = [
      'LICENSE',
      'SECURITY.md',
      'CONTRIBUTING.md',
      'CHANGELOG.md',
      'docs/ARCHITECTURE.md',
      'docs/openapi.yaml',
      '.github/pull_request_template.md',
      'public/js/enterprisePanels.js',
    ];
    for (const rel of requiredFiles) {
      assert.equal(fs.existsSync(path.join(root, rel)), true, `Missing ${rel}`);
    }
    const openapi = fs.readFileSync(path.join(root, 'docs', 'openapi.yaml'), 'utf8');
    assert.match(openapi, /openapi:\s*3\.1\.0/);
    assert.match(openapi, /\/api\/health:/);
    assert.match(openapi, /\/api\/vendors:/);
    assert.match(openapi, /\/api\/audit-events:/);
  });
});
