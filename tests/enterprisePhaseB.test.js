'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkDailyDemoQuotaAsync, checkRateLimitAsync } = require('../src/apiHelpers');
const { createRepository } = require('../src/dbRepository');
const { createStorageRepository } = require('../src/storageRepository');

test('Enterprise Phase B — Multi-Instance Serverless Scale', async (t) => {
  await t.test('1. Upstash Redis REST adapter enforces atomic INCR + EXPIRE and falls back cleanly', async () => {
    const counts = new Map();
    const calls = [];
    const mockFetch = async (url, init) => {
      const commands = JSON.parse(init.body);
      calls.push({ url, auth: init.headers.Authorization, commands });
      const results = commands.map(([cmd, key]) => {
        if (cmd === 'INCR') {
          const next = (counts.get(key) || 0) + 1;
          counts.set(key, next);
          return { result: next };
        }
        if (cmd === 'TTL') {
          return { result: counts.get(key) === 1 ? -1 : 86000 };
        }
        if (cmd === 'EXPIRE') {
          return { result: 1 };
        }
        return { result: null };
      });
      return {
        ok: true,
        status: 200,
        async json() {
          return results;
        },
      };
    };

    const opts = {
      redisUrl: 'https://fake-upstash.upstash.io',
      redisToken: 'upstash-test-token',
      limit: 2,
      fetchImpl: mockFetch,
    };

    const q1 = await checkDailyDemoQuotaAsync('203.0.113.10', opts);
    assert.equal(q1.allowed, true);
    assert.equal(q1.remaining, 1);
    assert.equal(q1.backend, 'upstash_redis');

    const q2 = await checkDailyDemoQuotaAsync('203.0.113.10', opts);
    assert.equal(q2.allowed, true);
    assert.equal(q2.remaining, 0);

    const q3 = await checkDailyDemoQuotaAsync('203.0.113.10', opts);
    assert.equal(q3.allowed, false);
    assert.equal(q3.remaining, 0);
    assert.equal(q3.backend, 'upstash_redis');

    // Verify EXPIRE was issued when count === 1
    assert.ok(calls.some((c) => c.commands[0][0] === 'EXPIRE'));
    assert.equal(calls[0].auth, 'Bearer upstash-test-token');

    // Verify fallback to in_memory when Upstash is unreachable or unset
    const fallbackRes = await checkRateLimitAsync('203.0.113.99', {
      redisUrl: 'https://fake-upstash.upstash.io',
      redisToken: 'upstash-test-token',
      fetchImpl: async () => ({ ok: false, status: 503 }),
    });
    assert.equal(fallbackRes.allowed, true);
    assert.equal(fallbackRes.backend, 'in_memory');
  });

  await t.test('2. recordAuditAndDeductPo calls Postgres ACID RPC on Supabase and falls back safely if unmigrated', async () => {
    const rpcCalls = [];
    const mockSupabaseRpc = {
      async rpc(fnName, params) {
        rpcCalls.push({ fnName, params });
        return {
          data: {
            audit_log: { ...params.p_log, id: 'rpc-saved-id' },
            po_updated: true,
            duplicate: false,
          },
          error: null,
        };
      },
    };

    const repoRpc = createRepository({ supabaseClient: mockSupabaseRpc });
    const rpcResult = await repoRpc.recordAuditAndDeductPo({
      logEntry: {
        id: 'rpc-saved-id',
        po_number: 'PO-2026-001',
        audit_status: 'APPROVED',
        file_hash: 'abc123',
      },
      billedLines: [{ item_name: 'Mesin Bor Industri Heavy Duty', qty: 3 }],
      actor: { actor_id: 'clerk@corp.id', actor_role: 'AP_CLERK' },
      ipAddress: '10.0.0.1',
    });

    assert.equal(rpcResult.mode, 'supabase_rpc');
    assert.equal(rpcResult.po_updated, true);
    assert.equal(rpcCalls.length, 1);
    assert.equal(rpcCalls[0].fnName, 'record_audit_and_deduct_po');
    assert.equal(rpcCalls[0].params.p_actor_id, 'clerk@corp.id');

    // Simulate unmigrated Supabase instance (PGRST202 missing RPC -> safe fallback)
    const insertedTables = [];
    const mockSupabaseFallback = {
      async rpc() {
        return { data: null, error: { code: 'PGRST202', message: 'Could not find function record_audit_and_deduct_po' } };
      },
      from(table) {
        return {
          insert(rows) {
            insertedTables.push(table);
            return {
              select() {
                return {
                  async single() {
                    return { data: rows[0], error: null };
                  },
                };
              },
            };
          },
        };
      },
    };

    const repoFallback = createRepository({ supabaseClient: mockSupabaseFallback });
    const fbResult = await repoFallback.recordAuditAndDeductPo({
      logEntry: {
        id: 'fb-log-id',
        po_number: 'PO-2026-001',
        audit_status: 'HOLD - PRICE VARIANCE',
        reasons: ['Variance'],
      },
      billedLines: [],
      actor: { actor_id: 'clerk@corp.id', actor_role: 'AP_CLERK' },
    });

    assert.equal(fbResult.mode, 'supabase_fallback');
    assert.deepEqual(insertedTables, ['audit_logs', 'audit_events']);
  });

  await t.test('3. Local ledger recordAuditAndDeductPo atomically deducts PO and blocks concurrent duplicate hash', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exacta-phaseb-'));
    const ledgerPath = path.join(tmpDir, 'ledger.json');
    try {
      const repo = createRepository({ forceLocal: true, ledgerPath });
      const first = await repo.recordAuditAndDeductPo({
        logEntry: {
          file_name: 'INV_A.pdf',
          file_hash: 'deadbeef001122334455',
          invoice_number: 'INV/PHASEB/001',
          po_number: 'PO-2026-001',
          vendor_name: 'PT Andalan Perkakas Nusantara',
          audit_status: 'APPROVED',
          grand_total: 6_660_000,
        },
        billedLines: [{ item_name: 'Mesin Bor Industri Heavy Duty', qty: 3 }],
        actor: { actor_id: 'clerk@corp.id', actor_role: 'AP_CLERK' },
      });
      assert.equal(first.mode, 'local_ledger');
      assert.equal(first.po_updated, true);
      assert.equal(first.duplicate, false);

      const pos = await repo.getPurchaseOrders();
      const po1 = pos.find((p) => p.po_number === 'PO-2026-001');
      assert.equal(po1.status, 'CLOSED');
      assert.equal(po1.items[0].remaining_qty, 0);

      // Re-submit same file_hash: must flip to HOLD - DUPLICATE without deducting again
      const second = await repo.recordAuditAndDeductPo({
        logEntry: {
          file_name: 'INV_A_COPY.pdf',
          file_hash: 'deadbeef001122334455',
          invoice_number: 'INV/PHASEB/001',
          po_number: 'PO-2026-001',
          vendor_name: 'PT Andalan Perkakas Nusantara',
          audit_status: 'APPROVED',
          grand_total: 6_660_000,
        },
        billedLines: [{ item_name: 'Mesin Bor Industri Heavy Duty', qty: 3 }],
        actor: { actor_id: 'clerk@corp.id', actor_role: 'AP_CLERK' },
      });
      assert.equal(second.duplicate, true);
      assert.equal(second.audit_log.audit_status, 'HOLD - DUPLICATE');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test('4. storageRepository uploads PDF & returns Signed URL on Supabase, falls back locally otherwise', async () => {
    const uploads = [];
    const mockStorageClient = {
      storage: {
        from(bucket) {
          return {
            async upload(storagePath, buffer, opts) {
              uploads.push({ bucket, storagePath, size: buffer.length, contentType: opts.contentType });
              return { data: { path: storagePath }, error: null };
            },
            async createSignedUrl(storagePath, ttl) {
              return {
                data: { signedUrl: `https://proj.supabase.co/storage/v1/object/sign/${bucket}/${storagePath}?ttl=${ttl}` },
                error: null,
              };
            },
          };
        },
      },
    };

    const cloudStorage = createStorageRepository({
      supabaseClient: mockStorageClient,
      bucket: 'invoice-pdfs',
      signedUrlTtlSeconds: 900,
    });
    const uploaded = await cloudStorage.uploadInvoiceDocument({
      base64Data: Buffer.from('%PDF-1.4 test').toString('base64'),
      fileName: 'INV #01 (PT Vendor).pdf',
      fileHash: '1234567890abcdef1234567890abcdef',
      mimeType: 'application/pdf',
    });

    assert.equal(uploaded.mode, 'supabase_storage');
    assert.equal(uploaded.bucket, 'invoice-pdfs');
    assert.match(uploaded.storage_path, /^invoices\/\d{4}-\d{2}\/1234567890abcdef_INV_01_PT_Vendor_.pdf$/);
    assert.match(uploaded.signed_url, /^https:\/\/proj\.supabase\.co\/storage\/v1\/object\/sign\//);
    assert.equal(uploaded.signed_url_expires_in, 900);
    assert.equal(uploads.length, 1);

    const localStorage = createStorageRepository({ forceLocal: true });
    const localResult = await localStorage.uploadInvoiceDocument({
      base64Data: Buffer.from('%PDF-1.4 test').toString('base64'),
      fileName: 'local.pdf',
      fileHash: 'abcdef1234567890',
    });
    assert.equal(localResult.mode, 'local-inline-ephemeral');
    assert.equal(localResult.storage_path, null);
    assert.equal(localResult.signed_url, null);
  });
});
