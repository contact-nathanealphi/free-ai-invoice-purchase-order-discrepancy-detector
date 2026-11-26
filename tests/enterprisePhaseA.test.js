'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { auditInvoice } = require('../src/auditEngine');
const { createRepository, getDefaultSeedVendors } = require('../src/dbRepository');
const vendorsHandler = require('../api/vendors');
const auditHandler = require('../api/audit');
const resolveHandler = require('../api/resolve');
const auditEventsHandler = require('../api/audit-events');
const buildN8n = require('../scripts/buildN8n');

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

const SAMPLE_PO = [
  {
    po_number: 'PO-2026-001',
    vendor_name: 'PT Andalan Perkakas Nusantara',
    po_type: 'GOODS',
    currency: 'IDR',
    status: 'OPEN',
    item_name: 'Mesin Bor Industri Heavy Duty',
    qty: 3,
    remaining_qty: 3,
    grn_received_qty: 3,
    unit_price: 2_000_000,
  },
];

const SAMPLE_INVOICE_BASE = {
  invoice_number: 'INV/APN/2026/101',
  po_number: 'PO-2026-001',
  vendor_name: 'PT Andalan Perkakas Nusantara',
  currency: 'IDR',
  line_items: [
    { item_name: 'Mesin Bor Industri Heavy Duty', qty: 3, unit_price: 2_000_000, line_total: 6_000_000 },
  ],
  subtotal: 6_000_000,
  ppn_amount: 660_000,
  pph23_amount: 0,
  grand_total: 6_660_000,
  confidence_score: 0.99,
};

test('Enterprise Phase A1 — Vendor Master & Anti-BEC Bank Fraud Guard', async (t) => {
  const vendors = getDefaultSeedVendors();

  await t.test('1. Approves invoice when bank account (with formatting) and NPWP match Vendor Master', () => {
    const invoice = {
      ...SAMPLE_INVOICE_BASE,
      bank_name: 'Bank Mandiri',
      bank_account_number: '123-000-456-7890',
      vendor_npwp: '012345678011000',
    };
    const result = auditInvoice(invoice, SAMPLE_PO, [], { vendorMaster: vendors });
    assert.equal(result.audit_status, 'APPROVED');
    assert.equal(result.requires_human_review, false);
    assert.ok(result.checked_rules.includes('GATE_6_VENDOR_BANK_GUARD'));
  });

  await t.test('2. Hard-blocks BEC bank account mismatch even when price matches and autoApproveCeiling is high', () => {
    const invoice = {
      ...SAMPLE_INVOICE_BASE,
      bank_name: 'Bank BCA',
      bank_account_number: '9998887776',
    };
    const result = auditInvoice(invoice, SAMPLE_PO, [], {
      vendorMaster: vendors,
      policyConfig: { autoApproveCeiling: 50_000_000 },
    });
    assert.equal(result.audit_status, 'HOLD - BANK ACCOUNT MISMATCH');
    assert.equal(result.requires_human_review, true);
    assert.match(result.discrepancy_reason, /Anti-BEC Fraud Guard/);
    assert.match(result.discrepancy_reason, /9998887776/);
    assert.match(result.discrepancy_reason, /1230004567890/);
  });

  await t.test('3. Blocks SUSPENDED or BLOCKED vendor regardless of invoice accuracy', () => {
    const blockedVendors = vendors.map((v) =>
      v.vendor_code === 'VND-001' ? { ...v, status: 'BLOCKED' } : v
    );
    const result = auditInvoice(SAMPLE_INVOICE_BASE, SAMPLE_PO, [], { vendorMaster: blockedVendors });
    assert.equal(result.audit_status, 'HOLD - VENDOR BLOCKED');
    assert.equal(result.requires_human_review, true);
  });

  await t.test('4. Flags NPWP mismatch for HUMAN REVIEW when bank account matches', () => {
    const invoice = {
      ...SAMPLE_INVOICE_BASE,
      bank_name: 'Bank Mandiri',
      bank_account_number: '1230004567890',
      vendor_npwp: '99.999.999.9-011.000',
    };
    const result = auditInvoice(invoice, SAMPLE_PO, [], { vendorMaster: vendors });
    assert.equal(result.audit_status, 'HUMAN REVIEW');
    assert.equal(result.requires_human_review, true);
    assert.match(result.discrepancy_reason, /NPWP vendor/);
  });

  await t.test('5. Backward-compatible when invoice omits bank_account_number and vendor_npwp', () => {
    const result = auditInvoice(SAMPLE_INVOICE_BASE, SAMPLE_PO, [], { vendorMaster: vendors });
    assert.equal(result.audit_status, 'APPROVED');
  });

  await t.test('6. Local repository getVendors() and upsertVendor() persist safely', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exacta-vendor-test-'));
    const ledgerPath = path.join(tmpDir, 'ledger.json');
    try {
      const repo = createRepository({ forceLocal: true, ledgerPath });
      const initial = await repo.getVendors();
      assert.ok(initial.length >= 8);

      const created = await repo.upsertVendor({
        vendor_code: 'VND-999',
        vendor_name: 'PT Uji Coba Mandiri',
        npwp: '09.111.222.3-019.000',
        bank_name: 'BCA',
        bank_account_number: '7770001112',
      });
      assert.equal(created.vendor_code, 'VND-999');
      assert.equal(created.status, 'ACTIVE');

      const updated = await repo.upsertVendor({
        vendor_code: 'VND-999',
        vendor_name: 'PT Uji Coba Mandiri',
        bank_name: 'BCA',
        bank_account_number: '7770001112',
        status: 'SUSPENDED',
      });
      assert.equal(updated.status, 'SUSPENDED');

      const reloaded = await repo.getVendors();
      assert.equal(reloaded.find((v) => v.vendor_code === 'VND-999').status, 'SUSPENDED');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test('7. /api/vendors enforces admin auth on POST and /api/audit blocks BEC in stateless workspace', async () => {
    const prevToken = process.env.ADMIN_API_TOKEN;
    process.env.ADMIN_API_TOKEN = 'test-enterprise-secret';
    try {
      const getRes = createMockRes();
      await vendorsHandler({ method: 'GET', headers: {} }, getRes);
      assert.equal(getRes.statusCode, 200);
      assert.equal(getRes.json().ok, true);
      assert.ok(Array.isArray(getRes.json().vendors));

      const unauthRes = createMockRes();
      await vendorsHandler(
        {
          method: 'POST',
          headers: {},
          body: { vendor_name: 'PT Fake', bank_name: 'BCA', bank_account_number: '111' },
        },
        unauthRes
      );
      assert.equal(unauthRes.statusCode, 401);

      const auditRes = createMockRes();
      await auditHandler(
        {
          method: 'POST',
          headers: {},
          body: {
            purchaseOrders: [
              {
                po_number: 'PO-2026-001',
                vendor_name: 'PT Andalan Perkakas Nusantara',
                po_type: 'GOODS',
                currency: 'IDR',
                status: 'OPEN',
                items: [
                  {
                    item_name: 'Mesin Bor Industri Heavy Duty',
                    qty: 3,
                    unit_price: 2_000_000,
                    remaining_qty: 3,
                    grn_received_qty: 3,
                  },
                ],
              },
            ],
            auditLogs: [],
            vendorMaster: vendors,
            preExtractedInvoice: {
              ...SAMPLE_INVOICE_BASE,
              bank_name: 'Bank Penipu',
              bank_account_number: '00000011112222',
            },
          },
        },
        auditRes
      );
      assert.equal(auditRes.statusCode, 200);
      assert.equal(auditRes.json().audit_result.audit_status, 'HOLD - BANK ACCOUNT MISMATCH');
    } finally {
      if (prevToken === undefined) {
        delete process.env.ADMIN_API_TOKEN;
      } else {
        process.env.ADMIN_API_TOKEN = prevToken;
      }
    }
  });
});

test('Enterprise Phase A2 — Immutable audit_events Trail & Maker-Checker RBAC', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exacta-rbac-test-'));
  const ledgerPath = path.join(tmpDir, 'ledger.json');
  const prevLedger = process.env.LOCAL_LEDGER_PATH;
  const prevRbac = process.env.RBAC_TOKENS_JSON;
  const prevAdmin = process.env.ADMIN_API_TOKEN;

  process.env.LOCAL_LEDGER_PATH = ledgerPath;
  delete process.env.ADMIN_API_TOKEN;
  process.env.RBAC_TOKENS_JSON = JSON.stringify({
    'tok-clerk': { actor_id: 'budi.clerk@corp.id', role: 'AP_CLERK' },
    'tok-manager': { actor_id: 'siti.mgr@corp.id', role: 'FINANCE_MANAGER' },
    'tok-cfo': { actor_id: 'hendra.cfo@corp.id', role: 'CFO' },
    'tok-auditor': { actor_id: 'kap.auditor@ext.id', role: 'AUDITOR' },
  });

  try {
    const repo = createRepository({ forceLocal: true, ledgerPath });
    const highValueLog = await repo.insertAuditLog({
      file_name: 'INV_HIGH_VALUE.pdf',
      invoice_number: 'INV/HV/2026/001',
      po_number: 'PO-2026-001',
      vendor_name: 'PT Andalan Perkakas Nusantara',
      currency: 'IDR',
      grand_total: 75_000_000,
      audit_status: 'HOLD - PRICE VARIANCE',
      reasons: ['Selisih harga satuan +4%'],
      created_by: 'siti.mgr@corp.id',
    });
    await repo.appendAuditEvent({
      audit_log_id: highValueLog.id,
      actor_id: 'siti.mgr@corp.id',
      actor_role: 'FINANCE_MANAGER',
      action: 'CREATED',
      previous_status: null,
      next_status: 'HOLD - PRICE VARIANCE',
      reason: 'Initial automated audit',
      ip_address: '127.0.0.1',
    });

    await t.test('1. Blocks AUDITOR and AP_CLERK from approving or rejecting via /api/resolve', async () => {
      const auditorRes = createMockRes();
      await resolveHandler(
        {
          method: 'POST',
          headers: { authorization: 'Bearer tok-auditor' },
          body: { id: highValueLog.id, action: 'MANUAL APPROVED', note: 'Auditor try' },
        },
        auditorRes
      );
      assert.equal(auditorRes.statusCode, 403);

      const clerkRes = createMockRes();
      await resolveHandler(
        {
          method: 'POST',
          headers: { authorization: 'Bearer tok-clerk' },
          body: { id: highValueLog.id, action: 'MANUAL APPROVED', note: 'Clerk try' },
        },
        clerkRes
      );
      assert.equal(clerkRes.statusCode, 403);
    });

    await t.test('2. Enforces Segregation of Duties (Maker cannot self-approve)', async () => {
      const selfApproveRes = createMockRes();
      await resolveHandler(
        {
          method: 'POST',
          headers: { authorization: 'Bearer tok-manager' },
          body: { id: highValueLog.id, action: 'MANUAL APPROVED', note: 'Self-approval attempt' },
        },
        selfApproveRes
      );
      assert.equal(selfApproveRes.statusCode, 403);
      assert.equal(selfApproveRes.json().code, 'SOD_VIOLATION');
    });

    await t.test('3. Escalates > Rp50M invoice to PENDING_CFO_APPROVAL for FINANCE_MANAGER, then CFO approves', async () => {
      const clerkUploadedLog = await repo.insertAuditLog({
        file_name: 'INV_CAPEX_80M.pdf',
        invoice_number: 'INV/CPX/2026/002',
        po_number: 'PO-2026-001',
        vendor_name: 'PT Andalan Perkakas Nusantara',
        currency: 'IDR',
        grand_total: 80_000_000,
        audit_status: 'HOLD - PRICE VARIANCE',
        reasons: ['Capex variance'],
        created_by: 'budi.clerk@corp.id',
      });
      await repo.appendAuditEvent({
        audit_log_id: clerkUploadedLog.id,
        actor_id: 'budi.clerk@corp.id',
        actor_role: 'AP_CLERK',
        action: 'CREATED',
        previous_status: null,
        next_status: 'HOLD - PRICE VARIANCE',
        reason: 'Uploaded by AP Clerk',
      });

      const mgrRes = createMockRes();
      await resolveHandler(
        {
          method: 'POST',
          headers: { authorization: 'Bearer tok-manager' },
          body: { id: clerkUploadedLog.id, action: 'MANUAL APPROVED', note: 'Verified by FM, needs CFO' },
        },
        mgrRes
      );
      assert.equal(mgrRes.statusCode, 200);
      assert.equal(mgrRes.json().escalated, true);
      assert.equal(mgrRes.json().audit_log.audit_status, 'PENDING_CFO_APPROVAL');

      const cfoRes = createMockRes();
      await resolveHandler(
        {
          method: 'POST',
          headers: { authorization: 'Bearer tok-cfo' },
          body: { id: clerkUploadedLog.id, action: 'MANUAL APPROVED', note: 'Final CFO sign-off' },
        },
        cfoRes
      );
      assert.equal(cfoRes.statusCode, 200);
      assert.equal(cfoRes.json().escalated, false);
      assert.equal(cfoRes.json().audit_log.audit_status, 'MANUAL APPROVED');

      const eventsRes = createMockRes();
      await auditEventsHandler(
        { method: 'GET', url: `/api/audit-events?audit_log_id=${clerkUploadedLog.id}`, headers: {} },
        eventsRes
      );
      assert.equal(eventsRes.statusCode, 200);
      const events = eventsRes.json().events;
      assert.equal(events.length, 3);
      assert.deepEqual(
        events.map((e) => e.action),
        ['CREATED', 'ESCALATED_TO_CFO', 'MANUAL APPROVED']
      );
      assert.equal(events[1].previous_status, 'HOLD - PRICE VARIANCE');
      assert.equal(events[1].next_status, 'PENDING_CFO_APPROVAL');
      assert.equal(events[2].previous_status, 'PENDING_CFO_APPROVAL');
      assert.equal(events[2].next_status, 'MANUAL APPROVED');
      assert.equal(events[2].actor_role, 'CFO');
    });
  } finally {
    if (prevLedger === undefined) delete process.env.LOCAL_LEDGER_PATH;
    else process.env.LOCAL_LEDGER_PATH = prevLedger;
    if (prevRbac === undefined) delete process.env.RBAC_TOKENS_JSON;
    else process.env.RBAC_TOKENS_JSON = prevRbac;
    if (prevAdmin === undefined) delete process.env.ADMIN_API_TOKEN;
    else process.env.ADMIN_API_TOKEN = prevAdmin;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Enterprise Phase A3 — n8n Single Source of Truth & CI Gate', async (t) => {
  await t.test('1. buildN8n --check confirms zero drift between auditEngine.js and n8n artifacts', () => {
    const res = buildN8n.run({ check: true });
    assert.equal(res.synced, true);
    assert.deepEqual(res.drifts, []);
  });

  await t.test('2. Generated n8n template & workflow include Gate 6 Anti-BEC and valid Gemini schema', () => {
    const tpl = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'n8nCodeNodeTemplate.js'), 'utf8');
    assert.match(tpl, /GATE_6_VENDOR_BANK_GUARD/);
    assert.match(tpl, /HOLD - BANK ACCOUNT MISMATCH/);

    const wf = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', 'workflows', 'invoice_po_audit_n8n.json'), 'utf8')
    );
    const geminiNode = wf.nodes.find((n) => n.id === 'node-gemini-http');
    const codeNode = wf.nodes.find((n) => n.id === 'node-audit-code');
    assert.ok(geminiNode && codeNode);
    assert.match(geminiNode.parameters.jsonBody, /bank_account_number/);
    assert.match(geminiNode.parameters.jsonBody, /vendor_npwp/);
    assert.match(codeNode.parameters.jsCode, /GATE_6_VENDOR_BANK_GUARD/);
  });

  await t.test('3. GitHub Actions CI workflow exists with test, benchmark, and n8n drift check', () => {
    const ciPath = path.resolve(__dirname, '..', '.github', 'workflows', 'ci.yml');
    assert.equal(fs.existsSync(ciPath), true);
    const ciContent = fs.readFileSync(ciPath, 'utf8');
    assert.match(ciContent, /npm run build:n8n -- --check/);
    assert.match(ciContent, /node --test/);
    assert.match(ciContent, /npm run benchmark:mock/);
  });

  await t.test('4. Blocks split-line same-PO-item over-billing within one invoice and RBAC privilege escalation', async () => {
    const splitLineInv = {
      ...SAMPLE_INVOICE_BASE,
      line_items: [
        { item_name: 'Mesin Bor Industri Heavy Duty', qty: 2, unit_price: 2_000_000, line_total: 4_000_000 },
        { item_name: 'Mesin Bor Industri Heavy Duty', qty: 2, unit_price: 2_000_000, line_total: 4_000_000 },
      ],
      subtotal: 8_000_000,
      ppn_amount: 880_000,
      grand_total: 8_880_000,
    };
    const res = auditInvoice(splitLineInv, SAMPLE_PO, []);
    assert.equal(res.audit_status, 'HOLD - PRICE VARIANCE');
    assert.match(res.discrepancy_reason, /akumulasi qty tertagih 4 melebihi PO 3/);

    const prevRbac = process.env.RBAC_TOKENS_JSON;
    process.env.RBAC_TOKENS_JSON = JSON.stringify({
      'tok-auditor': { actor_id: 'auditor@kap.id', role: 'AUDITOR' },
    });
    try {
      const vendorRes = createMockRes();
      await vendorsHandler(
        {
          method: 'POST',
          headers: { authorization: 'Bearer tok-auditor' },
          body: { vendor_name: 'PT Blocked', bank_name: 'BCA', bank_account_number: '123' },
        },
        vendorRes
      );
      assert.equal(vendorRes.statusCode, 403);
    } finally {
      if (prevRbac === undefined) delete process.env.RBAC_TOKENS_JSON;
      else process.env.RBAC_TOKENS_JSON = prevRbac;
    }
  });
});
