'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadEnvFile } = require('./geminiExtractor');
const { normalizePoNumber } = require('./auditEngine');

loadEnvFile();

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_LOCAL_LEDGER_PATH =
  process.env.VERCEL === '1'
    ? path.join('/tmp', 'local_ledger.json')
    : path.join(PROJECT_ROOT, 'data', 'local_ledger.json');

const WILD_PO_CSV_PATH = path.join(PROJECT_ROOT, 'test_data_wild', 'Wild_Master_PO.csv');
const STANDARD_PO_CSV_PATH = path.join(PROJECT_ROOT, 'test_data', 'Master_PO.csv');

/**
 * Minimal CSV parser for Master_PO files (no quoted commas in seed data).
 * @param {string} csvPath
 * @returns {Array<object>}
 */
function parseSimpleCsv(csvPath) {
  if (!fs.existsSync(csvPath)) {
    return [];
  }
  const raw = fs.readFileSync(csvPath, 'utf8').trim();
  if (!raw) return [];
  const lines = raw.split(/\r?\n/);
  const headers = lines[0].split(',').map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(',');
    const row = {};
    for (let j = 0; j < headers.length; j += 1) {
      row[headers[j]] = (cols[j] ?? '').trim();
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Builds the default Purchase Order seed list from Wild_Master_PO.csv and Master_PO.csv.
 * Wild_Master_PO takes precedence on PO-2026-001..006 so multi-item, SERVICE PPh 23,
 * partial delivery (GRN=6/10 on PO-2026-005), and currency scenarios match cleanly.
 * @returns {Array<object>}
 */
function getDefaultSeedPurchaseOrders() {
  const poMap = new Map();

  const ingestRows = (rows) => {
    const filePoNumbers = new Set();
    for (const row of rows) {
      const poNum = row.po_number;
      if (!poNum) continue;
      // Skip if this PO was already seeded by an earlier file
      if (poMap.has(poNum) && !filePoNumbers.has(poNum)) {
        continue;
      }
      filePoNumbers.add(poNum);

      const qty = Number(row.qty) || 0;
      const unitPrice = Number(row.unit_price) || 0;
      // PO-2026-005 in Wild_Master_PO has 6 of 10 units received at warehouse (GRN)
      const grnReceivedQty = poNum === 'PO-2026-005' && row.po_type === 'GOODS' ? 6 : qty;

      if (!poMap.has(poNum)) {
        poMap.set(poNum, {
          po_number: poNum,
          vendor_name: row.vendor_name,
          po_type: (row.po_type || 'GOODS').toUpperCase(),
          currency: (row.currency || 'IDR').toUpperCase(),
          items: [],
          status: (row.status || 'OPEN').toUpperCase(),
          created_at: new Date().toISOString(),
        });
      }

      poMap.get(poNum).items.push({
        item_name: row.item_name,
        qty,
        unit_price: unitPrice,
        remaining_qty: qty,
        grn_received_qty: grnReceivedQty,
      });
    }
  };

  ingestRows(parseSimpleCsv(WILD_PO_CSV_PATH));
  ingestRows(parseSimpleCsv(STANDARD_PO_CSV_PATH));

  return Array.from(poMap.values()).sort((a, b) => a.po_number.localeCompare(b.po_number));
}

function readPdfBase64AndHash(relPath) {
  const fullPath = path.join(PROJECT_ROOT, relPath);
  if (!fs.existsSync(fullPath)) {
    return { base64: null, hash: crypto.createHash('sha256').update(relPath).digest('hex') };
  }
  const buf = fs.readFileSync(fullPath);
  return {
    base64: buf.toString('base64'),
    hash: crypto.createHash('sha256').update(buf).digest('hex'),
  };
}

/**
 * Returns 3 realistic pre-seeded audit logs so the dashboard KPIs and Split-Screen PDF viewer
 * work out-of-the-box on first load and after Reset Sandbox Ledger.
 * @returns {Array<object>}
 */
function getDefaultSeedAuditLogs() {
  const now = Date.now();
  const inv3 = readPdfBase64AndHash(path.join('test_data', 'invoices', 'INV_03_normal_kemasan.pdf'));
  const inv6 = readPdfBase64AndHash(path.join('test_data', 'invoices', 'INV_06_price_variance_prima.pdf'));
  const wild5 = readPdfBase64AndHash(path.join('test_data_wild', 'invoices', 'WILD_05_multipage_noisy.pdf'));

  return [
    {
      id: '11111111-1111-4111-8111-111111111101',
      created_at: new Date(now - 1800_000).toISOString(),
      file_name: 'INV_03_normal_kemasan.pdf',
      file_hash: inv3.hash,
      invoice_number: 'INV/SK/2026/088',
      po_number: 'PO-2026-003',
      vendor_name: 'PT Sumber Kemasan',
      currency: 'IDR',
      grand_total: 41070000,
      audit_status: 'APPROVED',
      reasons: [],
      extraction_data: {
        invoice_number: 'INV/SK/2026/088',
        po_number: 'PO-2026-003',
        vendor_name: 'PT Sumber Kemasan',
        currency: 'IDR',
        line_items: [
          {
            item_name: 'Kardus Corrugated Double Wall 60x40x40 cm',
            qty: 2000,
            unit_price: 18500,
            line_total: 37000000,
          },
        ],
        ppn_amount: 4070000,
        pph23_amount: 0,
        grand_total: 41070000,
        confidence_score: 0.99,
        _checked_rules: [
          'GATE_1_CONFIDENCE_THRESHOLD',
          'GATE_2_DUPLICATE_CHECK',
          'GATE_3_PO_VALIDATION',
          'GATE_3B_CURRENCY_GUARD',
          'GATE_4_DETERMINISTIC_MATH_TAX',
          'GATE_5_PO_MATCHING_VARIANCE',
        ],
        _pdf_base64: inv3.base64,
      },
      po_snapshot: {
        po_number: 'PO-2026-003',
        vendor_name: 'PT Sumber Kemasan',
        po_type: 'GOODS',
        currency: 'IDR',
        status: 'OPEN',
        items: [
          {
            item_name: 'Kardus Corrugated Double Wall 60x40x40 cm',
            qty: 2000,
            unit_price: 18500,
            remaining_qty: 2000,
            grn_received_qty: 2000,
          },
        ],
      },
      model_used: 'gemini-3.8-flash',
      latency_ms: 1180,
      cost_idr: 3.12,
      reviewer_action: null,
      reviewer_note: null,
    },
    {
      id: '11111111-1111-4111-8111-111111111102',
      created_at: new Date(now - 900_000).toISOString(),
      file_name: 'INV_06_price_variance_prima.pdf',
      file_hash: inv6.hash,
      invoice_number: 'INV/PKA/2026/032',
      po_number: 'PO-2026-006',
      vendor_name: 'CV Prima Kerta Abadi',
      currency: 'IDR',
      grand_total: 43956000,
      audit_status: 'HOLD - PRICE VARIANCE',
      reasons: [
        'Price variance on PO-2026-006: billed unit price Rp264.000 vs contracted PO Rp240.000 (+10%).',
      ],
      extraction_data: {
        invoice_number: 'INV/PKA/2026/032',
        po_number: 'PO-2026-006',
        vendor_name: 'CV Prima Kerta Abadi',
        currency: 'IDR',
        line_items: [
          {
            item_name: 'Kertas HVS A4 80gsm (Box isi 5 Rim)',
            qty: 150,
            unit_price: 264000,
            line_total: 39600000,
          },
        ],
        ppn_amount: 4356000,
        pph23_amount: 0,
        grand_total: 43956000,
        confidence_score: 0.97,
        _checked_rules: [
          'GATE_1_CONFIDENCE_THRESHOLD',
          'GATE_2_DUPLICATE_CHECK',
          'GATE_3_PO_VALIDATION',
          'GATE_3B_CURRENCY_GUARD',
          'GATE_4_DETERMINISTIC_MATH_TAX',
          'GATE_5_PO_MATCHING_VARIANCE',
        ],
        _pdf_base64: inv6.base64,
      },
      po_snapshot: {
        po_number: 'PO-2026-006',
        vendor_name: 'CV Prima Kerta Abadi',
        po_type: 'GOODS',
        currency: 'IDR',
        status: 'OPEN',
        items: [
          {
            item_name: 'Kertas HVS A4 80gsm (Box isi 5 Rim)',
            qty: 150,
            unit_price: 240000,
            remaining_qty: 150,
            grn_received_qty: 150,
          },
        ],
      },
      model_used: 'gemini-3.8-flash',
      latency_ms: 1245,
      cost_idr: 3.45,
      reviewer_action: null,
      reviewer_note: null,
    },
    {
      id: '11111111-1111-4111-8111-111111111103',
      created_at: new Date(now - 300_000).toISOString(),
      file_name: 'WILD_05_multipage_noisy.pdf',
      file_hash: wild5.hash,
      invoice_number: 'INV/GSK/2026/099',
      po_number: 'PO-2026-004',
      vendor_name: 'PT Graha Suplai Kantor',
      currency: 'IDR',
      grand_total: 21090000,
      audit_status: 'HUMAN REVIEW',
      reasons: [
        'OCR confidence score (0.72) is below threshold 0.85 due to noisy/blurry multi-page scan.',
      ],
      extraction_data: {
        invoice_number: 'INV/GSK/2026/099',
        po_number: 'PO-2026-004',
        vendor_name: 'PT Graha Suplai Kantor',
        currency: 'IDR',
        line_items: [
          { item_name: 'Kertas A4 80gsm (Box 5 Rim)', qty: 20, unit_price: 250000, line_total: 5000000 },
          { item_name: 'Toner LaserJet Black Original', qty: 4, unit_price: 1250000, line_total: 5000000 },
        ],
        ppn_amount: 2090000,
        pph23_amount: 0,
        grand_total: 21090000,
        confidence_score: 0.72,
        extraction_notes: 'Blurry scan with skew and low-contrast stamps on page 2.',
        _checked_rules: ['GATE_1_CONFIDENCE_THRESHOLD'],
        _pdf_base64: wild5.base64,
      },
      po_snapshot: {
        po_number: 'PO-2026-004',
        vendor_name: 'PT Graha Suplai Kantor',
        po_type: 'GOODS',
        currency: 'IDR',
        status: 'OPEN',
        items: [
          { item_name: 'Kertas A4 80gsm (Box 5 Rim)', qty: 20, unit_price: 250000, remaining_qty: 20, grn_received_qty: 20 },
          { item_name: 'Toner LaserJet Black Original', qty: 4, unit_price: 1250000, remaining_qty: 4, grn_received_qty: 4 },
        ],
      },
      model_used: 'gemini-3.8-flash',
      latency_ms: 1640,
      cost_idr: 4.88,
      reviewer_action: null,
      reviewer_note: null,
    },
  ];
}

/**
 * Flattens JSONB purchase_orders rows into flat item rows compatible with auditInvoice().
 * @param {Array<object>} purchaseOrders
 * @returns {Array<object>}
 */
function flattenPurchaseOrdersForAudit(purchaseOrders = []) {
  const flat = [];
  for (const po of purchaseOrders) {
    const items = Array.isArray(po.items) ? po.items : [];
    for (const item of items) {
      flat.push({
        po_number: po.po_number,
        vendor_name: po.vendor_name,
        po_type: po.po_type || 'GOODS',
        currency: po.currency || 'IDR',
        item_name: item.item_name,
        qty: item.qty,
        unit_price: item.unit_price,
        remaining_qty: item.remaining_qty,
        grn_received_qty: item.grn_received_qty,
        status: po.status || 'OPEN',
      });
    }
  }
  return flat;
}

function isSupabaseConfigured() {
  return Boolean(
    process.env.SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY &&
      !process.env.SUPABASE_URL.includes('your-project-ref')
  );
}

function getSupabaseClient() {
  if (!isSupabaseConfigured()) return null;
  const { createClient } = require('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function createRepository(options = {}) {
  const ledgerPath = options.ledgerPath || DEFAULT_LOCAL_LEDGER_PATH;
  const forceLocal = Boolean(options.forceLocal);
  const useSupabase = !forceLocal && isSupabaseConfigured();
  const supabase = useSupabase ? getSupabaseClient() : null;

  function readLocalLedger() {
    if (!fs.existsSync(ledgerPath)) {
      const initial = {
        purchase_orders: getDefaultSeedPurchaseOrders(),
        audit_logs: getDefaultSeedAuditLogs(),
      };
      writeLocalLedger(initial);
      return initial;
    }
    const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    if (!Array.isArray(parsed.purchase_orders) || parsed.purchase_orders.length === 0) {
      parsed.purchase_orders = getDefaultSeedPurchaseOrders();
    }
    if (!Array.isArray(parsed.audit_logs)) {
      parsed.audit_logs = [];
    }
    return parsed;
  }

  function writeLocalLedger(data) {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, JSON.stringify(data, null, 2), 'utf8');
  }

  async function getPurchaseOrders() {
    if (supabase) {
      const { data, error } = await supabase
        .from('purchase_orders')
        .select('*')
        .order('po_number', { ascending: true });
      if (error) throw new Error(`Supabase getPurchaseOrders error: ${error.message}`);
      return data || [];
    }
    return readLocalLedger().purchase_orders;
  }

  async function getAuditLogs() {
    if (supabase) {
      const { data, error } = await supabase
        .from('audit_logs')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw new Error(`Supabase getAuditLogs error: ${error.message}`);
      return data || [];
    }
    const logs = readLocalLedger().audit_logs;
    return [...logs].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  async function insertAuditLog(entry) {
    const record = {
      id: entry.id || crypto.randomUUID(),
      created_at: entry.created_at || new Date().toISOString(),
      file_name: entry.file_name || null,
      file_hash: entry.file_hash || null,
      invoice_number: entry.invoice_number || null,
      po_number: entry.po_number || null,
      vendor_name: entry.vendor_name || null,
      currency: entry.currency || 'IDR',
      grand_total: entry.grand_total ?? null,
      audit_status: entry.audit_status,
      reasons: Array.isArray(entry.reasons) ? entry.reasons : [],
      extraction_data: entry.extraction_data || null,
      po_snapshot: entry.po_snapshot || null,
      model_used: entry.model_used || null,
      latency_ms: entry.latency_ms ?? null,
      cost_idr: entry.cost_idr ?? 0,
      reviewer_action: entry.reviewer_action || null,
      reviewer_note: entry.reviewer_note || null,
    };

    if (supabase) {
      const { data, error } = await supabase
        .from('audit_logs')
        .insert([record])
        .select()
        .single();
      if (error) throw new Error(`Supabase insertAuditLog error: ${error.message}`);
      return data;
    }

    const ledger = readLocalLedger();
    ledger.audit_logs.unshift(record);
    writeLocalLedger(ledger);
    return record;
  }

  async function updatePurchaseOrderBalances(poNumber, billedLines = []) {
    const canonical = normalizePoNumber(poNumber);
    if (!canonical || !Array.isArray(billedLines) || billedLines.length === 0) {
      return null;
    }

    const orders = await getPurchaseOrders();
    const targetPo = orders.find((po) => normalizePoNumber(po.po_number) === canonical);
    if (!targetPo) return null;

    const updatedItems = (targetPo.items || []).map((item) => {
      const itemNameLower = String(item.item_name || '').trim().toLowerCase();
      const matchedLine = billedLines.find((line) => {
        const lineName = String(line.item_name || '').trim().toLowerCase();
        return (
          lineName === itemNameLower ||
          (itemNameLower && (lineName.includes(itemNameLower) || itemNameLower.includes(lineName)))
        );
      });
      if (!matchedLine && billedLines.length === 1 && (targetPo.items || []).length === 1) {
        const qtyBilled = Number(billedLines[0].qty) || 0;
        const currentRemaining = Number(item.remaining_qty ?? item.qty) || 0;
        return {
          ...item,
          remaining_qty: Math.max(0, currentRemaining - qtyBilled),
        };
      }
      if (!matchedLine) return item;
      const qtyBilled = Number(matchedLine.qty) || 0;
      const currentRemaining = Number(item.remaining_qty ?? item.qty) || 0;
      return {
        ...item,
        remaining_qty: Math.max(0, currentRemaining - qtyBilled),
      };
    });

    const allZero = updatedItems.every((i) => Number(i.remaining_qty) <= 0);
    const nextStatus = allZero ? 'CLOSED' : targetPo.status;

    if (supabase) {
      const { data, error } = await supabase
        .from('purchase_orders')
        .update({ items: updatedItems, status: nextStatus })
        .eq('po_number', targetPo.po_number)
        .select()
        .single();
      if (error) throw new Error(`Supabase updatePurchaseOrderBalances error: ${error.message}`);
      return data;
    }

    const ledger = readLocalLedger();
    const idx = ledger.purchase_orders.findIndex((po) => po.po_number === targetPo.po_number);
    if (idx !== -1) {
      ledger.purchase_orders[idx] = {
        ...ledger.purchase_orders[idx],
        items: updatedItems,
        status: nextStatus,
      };
      writeLocalLedger(ledger);
      return ledger.purchase_orders[idx];
    }
    return null;
  }

  async function resolveAuditLog(id, action, note = '') {
    if (!id) throw new Error('Audit log ID wajib diisi.');
    const normalizedAction = String(action || '').trim().toUpperCase();
    const allowed = new Set(['MANUAL APPROVED', 'REJECTED TO VENDOR']);
    if (!allowed.has(normalizedAction)) {
      throw new Error(`Aksi tidak valid: ${action}. Gunakan MANUAL APPROVED atau REJECTED TO VENDOR.`);
    }

    if (supabase) {
      const { data, error } = await supabase
        .from('audit_logs')
        .update({
          audit_status: normalizedAction,
          reviewer_action: normalizedAction,
          reviewer_note: note || null,
        })
        .eq('id', id)
        .select()
        .single();
      if (error) throw new Error(`Supabase resolveAuditLog error: ${error.message}`);
      return data;
    }

    const ledger = readLocalLedger();
    const idx = ledger.audit_logs.findIndex((log) => log.id === id);
    if (idx === -1) {
      throw new Error(`Audit log dengan ID "${id}" tidak ditemukan.`);
    }
    ledger.audit_logs[idx] = {
      ...ledger.audit_logs[idx],
      audit_status: normalizedAction,
      reviewer_action: normalizedAction,
      reviewer_note: note || null,
    };
    writeLocalLedger(ledger);
    return ledger.audit_logs[idx];
  }

  async function resetSandboxData() {
    const seedPOs = getDefaultSeedPurchaseOrders();
    const seedLogs = getDefaultSeedAuditLogs();

    if (supabase) {
      const { error: delLogsErr } = await supabase
        .from('audit_logs')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000');
      if (delLogsErr) throw new Error(`Supabase reset logs error: ${delLogsErr.message}`);

      const { error: upsertErr } = await supabase
        .from('purchase_orders')
        .upsert(seedPOs, { onConflict: 'po_number' });
      if (upsertErr) throw new Error(`Supabase reset POs error: ${upsertErr.message}`);

      const { error: insertLogsErr } = await supabase
        .from('audit_logs')
        .insert(seedLogs);
      if (insertLogsErr) throw new Error(`Supabase seed logs error: ${insertLogsErr.message}`);

      return { mode: 'supabase', purchase_orders_count: seedPOs.length, audit_logs_count: seedLogs.length };
    }

    writeLocalLedger({
      purchase_orders: seedPOs,
      audit_logs: seedLogs,
    });
    return { mode: 'local_ledger', purchase_orders_count: seedPOs.length, audit_logs_count: seedLogs.length };
  }

  async function createPurchaseOrder(poData) {
    const poNumber = String(poData?.po_number || '').trim().toUpperCase();
    const vendorName = String(poData?.vendor_name || '').trim();
    const poType = String(poData?.po_type || 'GOODS').trim().toUpperCase();
    const currency = String(poData?.currency || 'IDR').trim().toUpperCase();
    const rawItems = Array.isArray(poData?.items) ? poData.items : [];

    if (!poNumber || !vendorName || rawItems.length === 0) {
      throw new Error('po_number, vendor_name, dan minimal 1 item wajib diisi.');
    }
    if (poType !== 'GOODS' && poType !== 'SERVICE') {
      throw new Error('po_type harus GOODS atau SERVICE.');
    }

    const items = rawItems.map((item) => {
      const itemName = String(item?.item_name || '').trim();
      const qty = Number(item?.qty);
      const unitPrice = Number(item?.unit_price);
      const grnQty =
        item?.grn_received_qty !== undefined && item?.grn_received_qty !== ''
          ? Number(item.grn_received_qty)
          : qty;
      if (!itemName || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) {
        throw new Error(`Item PO tidak valid: "${itemName || 'kosong'}".`);
      }
      return {
        item_name: itemName,
        qty,
        unit_price: unitPrice,
        remaining_qty: qty,
        grn_received_qty: Number.isFinite(grnQty) && grnQty >= 0 ? grnQty : 0,
      };
    });

    const newPo = {
      po_number: poNumber,
      vendor_name: vendorName,
      po_type: poType,
      currency,
      items,
      status: 'OPEN',
      created_at: new Date().toISOString(),
    };

    if (supabase) {
      const { data: existing } = await supabase
        .from('purchase_orders')
        .select('po_number')
        .eq('po_number', poNumber)
        .maybeSingle();
      if (existing) {
        throw new Error(`Purchase Order "${poNumber}" sudah ada.`);
      }
      const { data, error } = await supabase
        .from('purchase_orders')
        .insert([newPo])
        .select()
        .single();
      if (error) throw new Error(`Supabase createPurchaseOrder error: ${error.message}`);
      return data;
    }

    const ledger = readLocalLedger();
    if (ledger.purchase_orders.some((p) => normalizePoNumber(p.po_number) === normalizePoNumber(poNumber))) {
      throw new Error(`Purchase Order "${poNumber}" sudah ada.`);
    }
    ledger.purchase_orders.push(newPo);
    writeLocalLedger(ledger);
    return newPo;
  }

  async function updateGoodsReceipt(poNumber, itemsGrn = []) {
    const canonical = normalizePoNumber(poNumber);
    if (!canonical || !Array.isArray(itemsGrn) || itemsGrn.length === 0) {
      throw new Error('po_number dan array items GRN wajib diisi.');
    }

    const orders = await getPurchaseOrders();
    const targetPo = orders.find((po) => normalizePoNumber(po.po_number) === canonical);
    if (!targetPo) {
      throw new Error(`Purchase Order "${poNumber}" tidak ditemukan.`);
    }

    const updatedItems = (targetPo.items || []).map((item) => {
      const itemKey = String(item.item_name || '').trim().toLowerCase();
      const match = itemsGrn.find(
        (g) => String(g?.item_name || '').trim().toLowerCase() === itemKey
      );
      if (!match) return item;
      const nextGrn = Number(match.grn_received_qty);
      if (!Number.isFinite(nextGrn) || nextGrn < 0) {
        throw new Error(`Nilai grn_received_qty untuk "${item.item_name}" tidak valid.`);
      }
      return {
        ...item,
        grn_received_qty: nextGrn,
      };
    });

    if (supabase) {
      const { data, error } = await supabase
        .from('purchase_orders')
        .update({ items: updatedItems })
        .eq('po_number', targetPo.po_number)
        .select()
        .single();
      if (error) throw new Error(`Supabase updateGoodsReceipt error: ${error.message}`);
      return data;
    }

    const ledger = readLocalLedger();
    const idx = ledger.purchase_orders.findIndex((po) => po.po_number === targetPo.po_number);
    ledger.purchase_orders[idx] = {
      ...ledger.purchase_orders[idx],
      items: updatedItems,
    };
    writeLocalLedger(ledger);
    return ledger.purchase_orders[idx];
  }

  return {
    mode: supabase ? 'supabase' : 'local_ledger',
    ledgerPath,
    getPurchaseOrders,
    getAuditLogs,
    insertAuditLog,
    updatePurchaseOrderBalances,
    resolveAuditLog,
    resetSandboxData,
    createPurchaseOrder,
    updateGoodsReceipt,
  };
}

module.exports = {
  createRepository,
  getDefaultSeedPurchaseOrders,
  flattenPurchaseOrdersForAudit,
  isSupabaseConfigured,
};
