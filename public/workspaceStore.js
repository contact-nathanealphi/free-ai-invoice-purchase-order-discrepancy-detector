'use strict';

(function (global) {
  const LEGACY_WORKSPACE_KEY = 'exacta_workspace_v4';
  const LEGACY_BYOK_KEY = 'exacta_byok_v4';
  const DB_NAME = 'ExactaDB';
  const DB_VERSION = 2;
  const STORES = {
    PO: 'purchaseOrders',
    LOGS: 'auditLogs',
    BLOBS: 'fileBlobs',
    SETTINGS: 'settings',
    ALIASES: 'item_aliases',
  };
  const USD_FALLBACK_RATE = 16000;

  const DEFAULT_POLICY_CONFIG = {
    priceTolerancePct: 0,
    autoApproveCeiling: 0,
    mandatoryGrnThreshold: 0,
    splitThreshold: 25000000,
    splitWindowDays: 7,
    ppnRatePct: 11,
    pphRatePct: 2,
    fxUsdIdr: 16000,
    fxSgdIdr: 12000,
    forbiddenFeeKeywords: ['admin fee', 'handling charge', 'surcharge', 'misc fee', 'biaya tak terduga'],
  };

  let memoryCache = { purchaseOrders: [], auditLogs: [], itemAliases: [] };
  let byokCache = {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    apiKey: '',
    localBaseUrl: 'http://localhost:11434/v1',
    localModel: 'qwen2.5:7b',
  };
  let policyCache = { ...DEFAULT_POLICY_CONFIG };
  let dbPromise = null;

  function hasIndexedDb() {
    return typeof global.indexedDB !== 'undefined';
  }

  function openExactaDb() {
    if (!hasIndexedDb()) return Promise.resolve(null);
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      const req = global.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORES.PO)) {
          db.createObjectStore(STORES.PO, { keyPath: 'po_number' });
        }
        if (!db.objectStoreNames.contains(STORES.LOGS)) {
          db.createObjectStore(STORES.LOGS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORES.BLOBS)) {
          db.createObjectStore(STORES.BLOBS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORES.SETTINGS)) {
          db.createObjectStore(STORES.SETTINGS, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORES.ALIASES)) {
          db.createObjectStore(STORES.ALIASES, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB.'));
    }).catch(() => null);

    return dbPromise;
  }

  async function idbGetAll(storeName) {
    const db = await openExactaDb();
    if (!db) return [];
    return new Promise((resolve) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => resolve([]);
    });
  }

  async function idbGet(storeName, key) {
    const db = await openExactaDb();
    if (!db) return null;
    return new Promise((resolve) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }

  async function idbPut(storeName, value) {
    const db = await openExactaDb();
    if (!db) return false;
    return new Promise((resolve) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  }

  async function idbReplaceAll(storeName, items) {
    const db = await openExactaDb();
    if (!db) return false;
    return new Promise((resolve) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      store.clear();
      for (const item of items || []) {
        store.put(item);
      }
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  }

  function safeReadLegacyStorage(key, fallback) {
    try {
      const raw = global.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function normalizePo(poNumber) {
    return String(poNumber || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  async function fetchSeedFromServer() {
    const res = await fetch('/api/dashboard');
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'Failed to fetch initial seed data.');
    }
    return {
      purchaseOrders: Array.isArray(data.purchase_orders) ? data.purchase_orders : [],
      auditLogs: Array.isArray(data.audit_logs) ? data.audit_logs : [],
    };
  }

  async function persistWorkspaceToIdb(ws) {
    const logs = ws.auditLogs || [];
    const pos = ws.purchaseOrders || [];
    const aliases = ws.itemAliases || [];
    await Promise.all([
      idbReplaceAll(STORES.PO, pos),
      idbReplaceAll(STORES.LOGS, logs),
      idbReplaceAll(STORES.ALIASES, aliases),
    ]);
  }

  async function initWorkspace() {
    // Load BYOK & Policy settings from IndexedDB or migrate from legacy localStorage
    const [idbByok, idbPolicy] = await Promise.all([
      idbGet(STORES.SETTINGS, 'byok'),
      idbGet(STORES.SETTINGS, 'policy'),
    ]);
    if (idbByok?.value) {
      byokCache = { ...byokCache, ...idbByok.value };
    } else {
      const legacyByok = safeReadLegacyStorage(LEGACY_BYOK_KEY, null);
      if (legacyByok) {
        byokCache = { ...byokCache, ...legacyByok };
        await idbPut(STORES.SETTINGS, { key: 'byok', value: byokCache });
      }
    }
    if (idbPolicy?.value) {
      policyCache = { ...DEFAULT_POLICY_CONFIG, ...idbPolicy.value };
    }

    const [idbPos, idbLogs, idbAliases] = await Promise.all([
      idbGetAll(STORES.PO),
      idbGetAll(STORES.LOGS),
      idbGetAll(STORES.ALIASES),
    ]);

    if (idbPos.length > 0 || idbLogs.length > 0) {
      const sortedLogs = [...idbLogs].sort((a, b) =>
        String(b.created_at || '').localeCompare(String(a.created_at || ''))
      );
      memoryCache = { purchaseOrders: idbPos, auditLogs: sortedLogs, itemAliases: idbAliases };
      return memoryCache;
    }

    // Smooth auto-migration from v4.0 localStorage
    const legacyWs = safeReadLegacyStorage(LEGACY_WORKSPACE_KEY, null);
    if (
      legacyWs &&
      Array.isArray(legacyWs.purchaseOrders) &&
      legacyWs.purchaseOrders.length > 0
    ) {
      memoryCache = {
        purchaseOrders: legacyWs.purchaseOrders,
        auditLogs: Array.isArray(legacyWs.auditLogs) ? legacyWs.auditLogs : [],
        itemAliases: idbAliases,
      };
      await persistWorkspaceToIdb(memoryCache);
      return memoryCache;
    }

    // First-time visitor seed
    const seeded = await fetchSeedFromServer();
    memoryCache = { ...seeded, itemAliases: idbAliases };
    await persistWorkspaceToIdb(memoryCache);
    return memoryCache;
  }

  function getWorkspace() {
    return memoryCache;
  }

  async function saveWorkspace(ws) {
    memoryCache = {
      purchaseOrders: Array.isArray(ws.purchaseOrders) ? ws.purchaseOrders : [],
      auditLogs: Array.isArray(ws.auditLogs) ? ws.auditLogs : [],
      itemAliases: Array.isArray(ws.itemAliases) ? ws.itemAliases : (memoryCache.itemAliases || []),
    };
    await persistWorkspaceToIdb(memoryCache);
    return memoryCache;
  }

  async function saveFileBlob(id, mimeType, base64Data) {
    if (!id || !base64Data) return false;
    return idbPut(STORES.BLOBS, {
      id,
      mime_type: mimeType || 'application/pdf',
      base64: base64Data,
      saved_at: new Date().toISOString(),
    });
  }

  async function getFileBlob(id) {
    if (!id) return null;
    return idbGet(STORES.BLOBS, id);
  }

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
        const cur = String(log.currency || 'IDR').toUpperCase();
        const rate = cur === 'USD' ? (policyCache.fxUsdIdr || USD_FALLBACK_RATE) : cur === 'SGD' ? (policyCache.fxSgdIdr || 12000) : 1;
        discrepancyBlockedIdr += amount * rate;
      }
    }

    return {
      total_audited: totalAudited,
      discrepancy_blocked_idr: Math.round(discrepancyBlockedIdr),
      total_ai_cost_idr: Number(totalAiCostIdr.toFixed(2)),
      auto_approval_rate:
        totalAudited > 0 ? Number(((autoApprovedCount / totalAudited) * 100).toFixed(1)) : 0,
    };
  }

  async function addAuditLog(logEntry) {
    const ws = getWorkspace();
    const nextLogs = [logEntry, ...(ws.auditLogs || [])];
    let nextPOs = [...(ws.purchaseOrders || [])];

    const status = String(logEntry.audit_status || '').toUpperCase();
    if ((status === 'APPROVED' || status === 'APPROVED - PARTIAL') && logEntry.po_number) {
      const canonical = normalizePo(logEntry.po_number);
      const ext = logEntry.extraction_data || {};
      const billedLines =
        Array.isArray(ext.line_items) && ext.line_items.length > 0
          ? ext.line_items
          : [{ item_name: ext.item_name || '', qty: Number(ext.qty) || 0 }];

      nextPOs = nextPOs.map((po) => {
        if (normalizePo(po.po_number) !== canonical) return po;
        const updatedItems = (po.items || []).map((item) => {
          const itemNameLower = String(item.item_name || '').trim().toLowerCase();
          const matchedLine = billedLines.find((line) => {
            const lineName = String(line.item_name || '').trim().toLowerCase();
            return (
              lineName === itemNameLower ||
              (itemNameLower && (lineName.includes(itemNameLower) || itemNameLower.includes(lineName)))
            );
          });
          const qtyBilled = matchedLine
            ? Number(matchedLine.qty) || 0
            : billedLines.length === 1 && (po.items || []).length === 1
              ? Number(billedLines[0].qty) || 0
              : 0;
          if (!qtyBilled) return item;
          const currentRem = Number(item.remaining_qty ?? item.qty) || 0;
          return { ...item, remaining_qty: Math.max(0, currentRem - qtyBilled) };
        });
        const allZero = updatedItems.every((i) => Number(i.remaining_qty) <= 0);
        return { ...po, items: updatedItems, status: allZero ? 'CLOSED' : po.status };
      });
    }

    if (logEntry?.extraction_data?._pdf_base64) {
      await saveFileBlob(
        logEntry.id,
        logEntry.mime_type || logEntry.extraction_data._mime_type || 'application/pdf',
        logEntry.extraction_data._pdf_base64
      );
    }

    const updated = { purchaseOrders: nextPOs, auditLogs: nextLogs };
    await saveWorkspace(updated);
    return updated;
  }

  async function resolveAuditLog(id, action, note = '') {
    const ws = getWorkspace();
    const nextLogs = (ws.auditLogs || []).map((log) =>
      log.id === id
        ? { ...log, audit_status: action, reviewer_action: action, reviewer_note: note || null }
        : log
    );
    const updated = { ...ws, auditLogs: nextLogs };
    await saveWorkspace(updated);
    return updated;
  }

  async function createPurchaseOrder(poData, options = {}) {
    const ws = getWorkspace();
    const poNumber = String(poData.po_number || '').trim().toUpperCase();
    if (!poNumber || !poData.vendor_name || !Array.isArray(poData.items) || poData.items.length === 0) {
      throw new Error('PO Number, Vendor Name, and at least 1 line item are required.');
    }
    const existingIdx = (ws.purchaseOrders || []).findIndex(
      (p) => normalizePo(p.po_number) === normalizePo(poNumber)
    );
    if (existingIdx >= 0 && !options.overwrite) {
      throw new Error(`Purchase Order "${poNumber}" already exists in your local workspace.`);
    }
    const newPo = {
      po_number: poNumber,
      vendor_name: String(poData.vendor_name).trim(),
      po_type: String(poData.po_type || 'GOODS').toUpperCase() === 'SERVICE' ? 'SERVICE' : 'GOODS',
      currency: String(poData.currency || 'IDR').trim().toUpperCase(),
      po_date: poData.po_date || new Date().toISOString().slice(0, 10),
      items: poData.items.map((i) => {
        const qty = Number(i.qty) || 1;
        return {
          sku: i.sku || '',
          item_name: String(i.item_name || i.description || '').trim(),
          qty,
          unit_price: Number(i.unit_price) || 0,
          remaining_qty: qty,
          grn_received_qty:
            i.grn_received_qty !== undefined && i.grn_received_qty !== ''
              ? Number(i.grn_received_qty)
              : qty,
        };
      }),
      status: 'OPEN',
      created_at: new Date().toISOString(),
    };

    const nextPOs = [...(ws.purchaseOrders || [])];
    if (existingIdx >= 0) {
      nextPOs[existingIdx] = newPo;
    } else {
      nextPOs.unshift(newPo);
    }

    await saveWorkspace({ ...ws, purchaseOrders: nextPOs });
    return newPo;
  }

  async function bulkImportPurchaseOrders(poList = []) {
    const ws = getWorkspace();
    const existingMap = new Map(
      (ws.purchaseOrders || []).map((po) => [normalizePo(po.po_number), po])
    );
    let inserted = 0;
    let updated = 0;

    for (const poData of poList) {
      const poNumber = String(poData.po_number || '').trim().toUpperCase();
      if (!poNumber || !poData.vendor_name || !Array.isArray(poData.items) || !poData.items.length) {
        continue;
      }
      const key = normalizePo(poNumber);
      if (existingMap.has(key)) updated += 1;
      else inserted += 1;

      existingMap.set(key, {
        po_number: poNumber,
        vendor_name: String(poData.vendor_name).trim(),
        po_type: String(poData.po_type || 'GOODS').toUpperCase() === 'SERVICE' ? 'SERVICE' : 'GOODS',
        currency: String(poData.currency || 'IDR').trim().toUpperCase(),
        po_date: poData.po_date || new Date().toISOString().slice(0, 10),
        items: poData.items.map((i) => {
          const qty = Number(i.qty_ordered ?? i.qty) || 1;
          return {
            sku: i.sku || '',
            item_name: String(i.item_name || i.description || 'Unnamed Item').trim(),
            qty,
            unit_price: Number(i.unit_price) || 0,
            remaining_qty: qty,
            grn_received_qty:
              i.grn_received_qty !== undefined && i.grn_received_qty !== ''
                ? Number(i.grn_received_qty)
                : qty,
          };
        }),
        status: 'OPEN',
        created_at: new Date().toISOString(),
      });
    }

    const merged = Array.from(existingMap.values());
    await saveWorkspace({ ...ws, purchaseOrders: merged });
    return { inserted, updated, total: merged.length };
  }

  async function updateGoodsReceipt(poNumber, itemsGrn = []) {
    const ws = getWorkspace();
    const canonical = normalizePo(poNumber);
    const nextPOs = (ws.purchaseOrders || []).map((po) => {
      if (normalizePo(po.po_number) !== canonical) return po;
      const updatedItems = (po.items || []).map((item) => {
        const key = String(item.item_name || '').trim().toLowerCase();
        const match = itemsGrn.find((g) => String(g.item_name || '').trim().toLowerCase() === key);
        if (!match) return item;
        return { ...item, grn_received_qty: Number(match.grn_received_qty) || 0 };
      });
      return { ...po, items: updatedItems };
    });
    await saveWorkspace({ ...ws, purchaseOrders: nextPOs });
    return nextPOs.find((p) => normalizePo(p.po_number) === canonical);
  }

  async function resetToDefaultDemo() {
    await fetch('/api/reset', { method: 'POST' }).catch(() => {});
    const seeded = await fetchSeedFromServer();
    await saveWorkspace(seeded);
    return seeded;
  }

  function exportWorkspaceJson() {
    const ws = getWorkspace();
    const blob = new Blob([JSON.stringify(ws, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `invoice_po_workspace_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importWorkspaceJson(jsonString) {
    const parsed = JSON.parse(jsonString);
    if (!parsed || !Array.isArray(parsed.purchaseOrders) || !Array.isArray(parsed.auditLogs)) {
      throw new Error('Invalid workspace JSON format. Expected { purchaseOrders, auditLogs }.');
    }
    return saveWorkspace({
      purchaseOrders: parsed.purchaseOrders,
      auditLogs: parsed.auditLogs,
      itemAliases: Array.isArray(parsed.itemAliases) ? parsed.itemAliases : (memoryCache.itemAliases || []),
    });
  }

  async function markAuditLogPaid(logId, { paid_date, payment_ref = '' } = {}) {
    const ws = getWorkspace();
    let targetPoNumber = null;
    const nextLogs = (ws.auditLogs || []).map((log) => {
      if (log.id !== logId) return log;
      targetPoNumber = log.po_number;
      return {
        ...log,
        payment_status: 'PAID',
        paid_date: paid_date || new Date().toISOString().slice(0, 10),
        payment_ref: String(payment_ref || '').trim() || `PAID-${Date.now().toString().slice(-6)}`,
      };
    });

    const canonical = targetPoNumber ? normalizePo(targetPoNumber) : '';
    const nextPOs = (ws.purchaseOrders || []).map((po) =>
      canonical && normalizePo(po.po_number) === canonical ? { ...po, status: 'CLOSED' } : po
    );

    return saveWorkspace({ ...ws, purchaseOrders: nextPOs, auditLogs: nextLogs });
  }

  function getItemAliases() {
    return memoryCache.itemAliases || [];
  }

  async function addItemAlias({ invoice_item, po_item, po_number = '' }) {
    const inv = String(invoice_item || '').trim();
    const poIt = String(po_item || '').trim();
    if (!inv || !poIt) throw new Error('Both invoice_item and po_item are required.');
    const ws = getWorkspace();
    const existing = ws.itemAliases || [];
    const entry = {
      id: `${inv.toLowerCase()}__${poIt.toLowerCase()}`,
      invoice_item: inv,
      po_item: poIt,
      po_number: String(po_number || '').trim(),
      created_at: new Date().toISOString(),
    };
    const filtered = existing.filter((a) => a.id !== entry.id);
    const nextAliases = [entry, ...filtered];
    await saveWorkspace({ ...ws, itemAliases: nextAliases });
    return entry;
  }

  async function deleteItemAlias(id) {
    const ws = getWorkspace();
    const nextAliases = (ws.itemAliases || []).filter((a) => a.id !== id);
    await saveWorkspace({ ...ws, itemAliases: nextAliases });
    return nextAliases;
  }

  function getByokConfig() {
    return byokCache;
  }

  async function saveByokConfig(cfg) {
    const next = {
      provider: cfg.provider || 'gemini',
      model: cfg.model || 'gemini-2.5-flash',
      apiKey: String(cfg.apiKey || '').trim(),
      localBaseUrl: String(cfg.localBaseUrl || byokCache.localBaseUrl || 'http://localhost:11434/v1').trim(),
      localModel: String(cfg.localModel || byokCache.localModel || 'qwen2.5:7b').trim(),
    };
    byokCache = next;
    await idbPut(STORES.SETTINGS, { key: 'byok', value: next });
    return next;
  }

  async function clearByokConfig() {
    const next = {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      apiKey: '',
      localBaseUrl: 'http://localhost:11434/v1',
      localModel: 'qwen2.5:7b',
    };
    byokCache = next;
    await idbPut(STORES.SETTINGS, { key: 'byok', value: next });
    return next;
  }

  function getByokHeaders() {
    const cfg = getByokConfig();
    if (!cfg.apiKey || cfg.provider === 'local_ollama') return {};
    return {
      'x-ai-provider': cfg.provider,
      'x-ai-model': cfg.model,
      'x-ai-api-key': cfg.apiKey,
    };
  }

  function getPolicyConfig() {
    return policyCache;
  }

  async function savePolicyConfig(cfg = {}) {
    const keywords = Array.isArray(cfg.forbiddenFeeKeywords)
      ? cfg.forbiddenFeeKeywords.map((k) => String(k || '').trim().toLowerCase()).filter(Boolean)
      : typeof cfg.forbiddenFeeKeywords === 'string'
        ? cfg.forbiddenFeeKeywords.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean)
        : DEFAULT_POLICY_CONFIG.forbiddenFeeKeywords;

    const next = {
      priceTolerancePct: Math.max(0, Math.min(25, Number(cfg.priceTolerancePct) || 0)),
      autoApproveCeiling: Math.max(0, Number(cfg.autoApproveCeiling) || 0),
      mandatoryGrnThreshold: Math.max(0, Number(cfg.mandatoryGrnThreshold) || 0),
      splitThreshold: Math.max(0, Number(cfg.splitThreshold) || DEFAULT_POLICY_CONFIG.splitThreshold),
      splitWindowDays: Math.max(1, Number(cfg.splitWindowDays) || DEFAULT_POLICY_CONFIG.splitWindowDays),
      ppnRatePct: cfg.ppnRatePct !== undefined && cfg.ppnRatePct !== '' ? Math.max(0, Number(cfg.ppnRatePct) || 0) : DEFAULT_POLICY_CONFIG.ppnRatePct,
      pphRatePct: cfg.pphRatePct !== undefined && cfg.pphRatePct !== '' ? Math.max(0, Number(cfg.pphRatePct) || 0) : DEFAULT_POLICY_CONFIG.pphRatePct,
      fxUsdIdr: Math.max(1, Number(cfg.fxUsdIdr) || DEFAULT_POLICY_CONFIG.fxUsdIdr),
      fxSgdIdr: Math.max(1, Number(cfg.fxSgdIdr) || DEFAULT_POLICY_CONFIG.fxSgdIdr),
      forbiddenFeeKeywords: keywords,
    };
    policyCache = next;
    await idbPut(STORES.SETTINGS, { key: 'policy', value: next });
    return next;
  }

  async function resetPolicyConfig() {
    policyCache = { ...DEFAULT_POLICY_CONFIG };
    await idbPut(STORES.SETTINGS, { key: 'policy', value: policyCache });
    return policyCache;
  }

  /**
   * 0-Token Client-Side CSV Bulk PO Parser.
   * Supports comma/semicolon delimiters and quoted fields.
   */
  function splitCsvRow(line, delimiter = ',') {
    const cells = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === delimiter && !inQuotes) {
        cells.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    cells.push(current.trim());
    return cells;
  }

  function parsePurchaseOrdersCsv(csvText) {
    const lines = String(csvText || '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    if (lines.length < 2) {
      throw new Error('CSV must contain a header row and at least 1 data row.');
    }

    const headerLine = lines[0];
    const delimiter = headerLine.split(';').length > headerLine.split(',').length ? ';' : ',';
    const headers = splitCsvRow(headerLine, delimiter).map((h) =>
      h.toLowerCase().replace(/[^a-z0-9_]/g, '_')
    );

    const colIndex = (aliases) => {
      for (const a of aliases) {
        const idx = headers.indexOf(a);
        if (idx >= 0) return idx;
      }
      return -1;
    };

    const idxPo = colIndex(['po_number', 'po_no', 'no_po']);
    const idxVendor = colIndex(['vendor_name', 'vendor', 'supplier']);
    const idxCurrency = colIndex(['currency', 'curr']);
    const idxDate = colIndex(['po_date', 'date']);
    const idxType = colIndex(['po_type', 'type']);
    const idxSku = colIndex(['sku', 'item_code']);
    const idxDesc = colIndex(['description', 'item_name', 'item']);
    const idxQty = colIndex(['qty_ordered', 'qty', 'quantity']);
    const idxPrice = colIndex(['unit_price', 'price', 'harga']);
    const idxGrn = colIndex(['grn_received_qty', 'grn_qty']);

    if (idxPo < 0 || idxVendor < 0 || idxDesc < 0) {
      throw new Error('CSV missing required columns: po_number, vendor_name, description/item_name.');
    }

    const grouped = new Map();
    for (let r = 1; r < lines.length; r += 1) {
      const row = splitCsvRow(lines[r], delimiter);
      const poNumber = String(row[idxPo] || '').trim().toUpperCase();
      const vendorName = String(row[idxVendor] || '').trim();
      const desc = String(row[idxDesc] || '').trim();
      if (!poNumber || !vendorName || !desc) continue;

      const qty = idxQty >= 0 ? Number(String(row[idxQty] || '1').replace(/[^0-9.-]/g, '')) || 1 : 1;
      const unitPrice =
        idxPrice >= 0 ? Number(String(row[idxPrice] || '0').replace(/[^0-9.-]/g, '')) || 0 : 0;
      const grnQty =
        idxGrn >= 0 && row[idxGrn] !== ''
          ? Number(String(row[idxGrn]).replace(/[^0-9.-]/g, ''))
          : qty;

      if (!grouped.has(poNumber)) {
        grouped.set(poNumber, {
          po_number: poNumber,
          vendor_name: vendorName,
          currency: idxCurrency >= 0 && row[idxCurrency] ? row[idxCurrency].toUpperCase() : 'IDR',
          po_date: idxDate >= 0 && row[idxDate] ? row[idxDate] : new Date().toISOString().slice(0, 10),
          po_type:
            idxType >= 0 && String(row[idxType]).toUpperCase() === 'SERVICE' ? 'SERVICE' : 'GOODS',
          items: [],
        });
      }

      grouped.get(poNumber).items.push({
        sku: idxSku >= 0 ? row[idxSku] || '' : '',
        item_name: desc,
        description: desc,
        qty_ordered: qty,
        qty,
        unit_price: unitPrice,
        grn_received_qty: Number.isFinite(grnQty) ? grnQty : qty,
      });
    }

    return Array.from(grouped.values());
  }

  function generateSamplePoCsv() {
    return [
      'po_number,vendor_name,currency,po_date,po_type,sku,description,qty_ordered,unit_price',
      'PO-2026-901,PT Sinar Nusantara,IDR,2026-11-01,GOODS,SKU-901,Server Rack 42U,2,12500000',
      'PO-2026-901,PT Sinar Nusantara,IDR,2026-11-01,GOODS,SKU-902,UPS APC 3000VA,2,4500000',
      'PO-2026-902,CV Karya Digital,IDR,2026-11-05,SERVICE,SRV-01,Cloud Infrastructure Audit,1,15000000',
    ].join('\n');
  }

  const exported = {
    initWorkspace,
    getWorkspace,
    saveWorkspace,
    saveFileBlob,
    getFileBlob,
    computeKpis,
    addAuditLog,
    resolveAuditLog,
    createPurchaseOrder,
    bulkImportPurchaseOrders,
    updateGoodsReceipt,
    resetToDefaultDemo,
    exportWorkspaceJson,
    importWorkspaceJson,
    getByokConfig,
    saveByokConfig,
    clearByokConfig,
    getByokHeaders,
    DEFAULT_POLICY_CONFIG,
    getPolicyConfig,
    savePolicyConfig,
    resetPolicyConfig,
    markAuditLogPaid,
    getItemAliases,
    addItemAlias,
    deleteItemAlias,
    parsePurchaseOrdersCsv,
    generateSamplePoCsv,
  };

  global.ExactaStore = exported;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
})(typeof window !== 'undefined' ? window : globalThis);
