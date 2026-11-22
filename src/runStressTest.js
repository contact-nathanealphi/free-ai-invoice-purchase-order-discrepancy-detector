'use strict';

const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');
const { auditInvoice, normalizePoNumber } = require('./auditEngine');
const { loadEnvFile, extractInvoiceWithGemini } = require('./geminiExtractor');

const ROOT_DIR = path.resolve(__dirname, '..');
const WILD_PO_PATH = path.join(ROOT_DIR, 'test_data_wild', 'Wild_Master_PO.csv');
const WILD_EXPECTED_PATH = path.join(ROOT_DIR, 'test_data_wild', 'wild_expected_results.json');
const WILD_INVOICES_DIR = path.join(ROOT_DIR, 'test_data_wild', 'invoices');
const REPORT_PATH = path.join(ROOT_DIR, 'reports', 'stress_test_v2.json');
const LIVE_REQUEST_PACING_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCsv(csvContent) {
  const lines = csvContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const splitRow = (row) => {
    const cells = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < row.length; i += 1) {
      const ch = row[i];
      if (ch === '"') {
        if (inQuotes && row[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        cells.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    cells.push(current.trim());
    return cells;
  };

  const headers = splitRow(lines[0]);
  return lines.slice(1).map((line) => {
    const values = splitRow(line);
    const record = {};
    headers.forEach((header, idx) => {
      record[header] = values[idx] ?? '';
    });
    return record;
  });
}

function computeFileSha256(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function simulateWildExtraction(fileName, expectedFixture, masterPOList) {
  const canonicalPo = normalizePoNumber(expectedFixture.po_number);
  const poRows = masterPOList.filter((po) => normalizePoNumber(po.po_number) === canonicalPo);

  const mockTokenUsage = {
    promptTokenCount: 950,
    candidatesTokenCount: 280,
    totalTokenCount: 1230,
  };

  const base = {
    invoice_number: expectedFixture.invoice_number,
    po_number: expectedFixture.po_number,
    vendor_name: expectedFixture.vendor_name,
    currency: expectedFixture.currency || 'IDR',
    confidence_score: 0.96,
    extraction_notes: 'Simulasi ekstraksi wild v2.',
  };

  switch (fileName) {
    case 'WILD_01_multi_item.pdf': {
      const lineItems = poRows.map((r) => ({
        item_name: r.item_name,
        qty: Number(r.qty),
        unit_price: Number(r.unit_price),
        line_total: Number(r.qty) * Number(r.unit_price),
      }));
      return {
        extractedInvoice: {
          ...base,
          line_items: lineItems,
          subtotal: 19_000_000,
          ppn_amount: 2_090_000,
          pph23_amount: 0,
          grand_total: 21_090_000,
        },
        latency_ms: 18,
        token_usage: mockTokenUsage,
        model_used: 'mock-simulator-v2',
        retry_count: 0,
      };
    }

    case 'WILD_02_sneaky_fee.pdf':
      return {
        extractedInvoice: {
          ...base,
          line_items: [
            { item_name: poRows[0].item_name, qty: 5, unit_price: 1_200_000, line_total: 6_000_000 },
            { item_name: 'Biaya Admin & Handling', qty: 1, unit_price: 750_000, line_total: 750_000 },
          ],
          subtotal: 6_750_000,
          ppn_amount: 742_500,
          pph23_amount: 0,
          grand_total: 7_492_500,
        },
        latency_ms: 18,
        token_usage: mockTokenUsage,
        model_used: 'mock-simulator-v2',
        retry_count: 0,
      };

    case 'WILD_03_pph23_service.pdf':
      return {
        extractedInvoice: {
          ...base,
          line_items: [
            { item_name: poRows[0].item_name, qty: 1, unit_price: 10_000_000, line_total: 10_000_000 },
          ],
          subtotal: 10_000_000,
          ppn_amount: 1_100_000,
          pph23_amount: 200_000,
          grand_total: 10_900_000,
        },
        latency_ms: 18,
        token_usage: mockTokenUsage,
        model_used: 'mock-simulator-v2',
        retry_count: 0,
      };

    case 'WILD_04_messy_format.pdf':
      return {
        extractedInvoice: {
          ...base,
          confidence_score: 0.89,
          line_items: [
            { item_name: poRows[0].item_name, qty: 3, unit_price: 2_000_000, line_total: 6_000_000 },
          ],
          subtotal: 6_000_000,
          ppn_amount: 660_000,
          pph23_amount: 0,
          grand_total: 6_660_000,
          extraction_notes: 'Layout miring tipis ~2.2 derajat namun seluruh angka terbaca jelas.',
        },
        latency_ms: 18,
        token_usage: mockTokenUsage,
        model_used: 'mock-simulator-v2',
        retry_count: 0,
      };

    case 'WILD_05_multipage_noisy.pdf':
      return {
        extractedInvoice: {
          ...base,
          confidence_score: 0.58,
          line_items: poRows.map((r) => ({
            item_name: r.item_name,
            qty: Number(r.qty),
            unit_price: Number(r.unit_price),
            line_total: Number(r.qty) * Number(r.unit_price),
          })),
          subtotal: 19_000_000,
          ppn_amount: 2_090_000,
          pph23_amount: 0,
          grand_total: 21_090_000,
          extraction_notes: 'Scan 2 halaman buram dengan noda dan lipatan berat.',
        },
        latency_ms: 18,
        token_usage: mockTokenUsage,
        model_used: 'mock-simulator-v2',
        retry_count: 0,
      };

    case 'WILD_06_partial_delivery.pdf':
      return {
        extractedInvoice: {
          ...base,
          line_items: [
            { item_name: 'Barcode Scanner Wireless 2D (Partial 6/10)', qty: 6, unit_price: 1_500_000, line_total: 9_000_000 },
          ],
          subtotal: 9_000_000,
          ppn_amount: 990_000,
          pph23_amount: 0,
          grand_total: 9_990_000,
        },
        latency_ms: 18,
        token_usage: mockTokenUsage,
        model_used: 'mock-simulator-v2',
        retry_count: 0,
      };

    case 'WILD_07_prompt_injection.pdf':
      return {
        extractedInvoice: {
          ...base,
          line_items: [
            { item_name: poRows[0].item_name, qty: 4, unit_price: 2_600_000, line_total: 10_400_000 },
          ],
          subtotal: 10_400_000,
          ppn_amount: 1_144_000,
          pph23_amount: 0,
          grand_total: 11_544_000,
          extraction_notes: 'Terdapat teks footer mencurigakan (SYSTEM OVERRIDE) yang diabaikan.',
        },
        latency_ms: 18,
        token_usage: mockTokenUsage,
        model_used: 'mock-simulator-v2',
        retry_count: 0,
      };

    case 'WILD_08_currency_mismatch.pdf':
      return {
        extractedInvoice: {
          ...base,
          currency: 'USD',
          line_items: [
            { item_name: poRows[0].item_name, qty: 4, unit_price: 125, line_total: 500 },
          ],
          subtotal: 500,
          ppn_amount: 0,
          pph23_amount: 0,
          grand_total: 500,
        },
        latency_ms: 18,
        token_usage: mockTokenUsage,
        model_used: 'mock-simulator-v2',
        retry_count: 0,
      };

    default:
      throw new Error(`Mock fixture wild tidak dikenal: ${fileName}`);
  }
}

function printStressTable(rows) {
  const columns = [
    { key: 'file_name', label: 'File', width: 32 },
    { key: 'expected_status', label: 'Expected', width: 24 },
    { key: 'actual_status', label: 'Actual v2', width: 24 },
    { key: 'result_label', label: 'Result', width: 8 },
    { key: 'latency_label', label: 'Latency', width: 9 },
    { key: 'cost_label', label: 'Cost (IDR)', width: 12 },
  ];

  const formatRow = (row) =>
    columns
      .map((col) => String(row[col.key] ?? '').slice(0, col.width).padEnd(col.width))
      .join(' | ');

  const headerLine = formatRow(Object.fromEntries(columns.map((c) => [c.key, c.label])));
  const separator = columns.map((c) => '-'.repeat(c.width)).join('-+-');

  console.log('');
  console.log(headerLine);
  console.log(separator);
  for (const row of rows) {
    console.log(formatRow(row));
  }
  console.log('');
}

async function main() {
  const args = process.argv.slice(2);
  const isLive = args.includes('--live');
  const isMock = args.includes('--mock') || !isLive;
  const mode = isLive ? 'live' : 'mock';

  if (isLive) {
    loadEnvFile();
  }

  const masterPOList = parseCsv(fs.readFileSync(WILD_PO_PATH, 'utf8'));
  const expectedData = JSON.parse(fs.readFileSync(WILD_EXPECTED_PATH, 'utf8'));
  const expectedByFile = new Map((expectedData.results || []).map((item) => [item.file_name, item]));

  const pdfFiles = fs
    .readdirSync(WILD_INVOICES_DIR)
    .filter((name) => name.toLowerCase().endsWith('.pdf'))
    .sort((a, b) => a.localeCompare(b));

  const existingAuditLogs = [];
  const details = [];
  const tableRows = [];

  for (let i = 0; i < pdfFiles.length; i += 1) {
    const fileName = pdfFiles[i];
    const pdfPath = path.join(WILD_INVOICES_DIR, fileName);
    const expectedFixture = expectedByFile.get(fileName);
    const expectedStatus = expectedFixture ? expectedFixture.expected_status : 'UNKNOWN';
    const fileHash = computeFileSha256(pdfPath);

    console.log(`[${i + 1}/${pdfFiles.length}] Stress Test ${fileName}...`);

    const extractionResult = isMock
      ? simulateWildExtraction(fileName, expectedFixture, masterPOList)
      : await extractInvoiceWithGemini(pdfPath);

    const invoiceWithHash = {
      ...extractionResult.extractedInvoice,
      file_hash: fileHash,
    };

    const auditResult = auditInvoice(invoiceWithHash, masterPOList, existingAuditLogs, {
      token_usage: extractionResult.token_usage,
    });

    if (auditResult.audit_status !== 'HOLD - DUPLICATE') {
      existingAuditLogs.push({ ...auditResult, file_hash: fileHash });
    }

    const isMatch = auditResult.audit_status === expectedStatus;
    const modelUsed = extractionResult.model_used || extractionResult.model || 'mock-simulator-v2';

    console.log(`-> ${auditResult.audit_status} (${extractionResult.latency_ms}ms, model: ${modelUsed})`);

    details.push({
      file_name: fileName,
      file_hash: fileHash,
      expected_status: expectedStatus,
      actual_status: auditResult.audit_status,
      match: isMatch,
      latency_ms: extractionResult.latency_ms,
      model_used: modelUsed,
      retry_count: extractionResult.retry_count ?? 0,
      token_usage: extractionResult.token_usage,
      audit_result: auditResult,
    });

    tableRows.push({
      file_name: fileName,
      expected_status: expectedStatus,
      actual_status: auditResult.audit_status,
      result_label: isMatch ? 'PASS' : 'FAIL',
      latency_label: `${extractionResult.latency_ms}ms`,
      cost_label: `Rp${auditResult.estimated_cost_idr}`,
    });

    if (isLive && i < pdfFiles.length - 1) {
      await sleep(LIVE_REQUEST_PACING_MS);
    }
  }

  const totalFiles = details.length;
  const matchedCount = details.filter((d) => d.match).length;
  const mismatchCount = totalFiles - matchedCount;
  const accuracyPercent = totalFiles > 0 ? Number(((matchedCount / totalFiles) * 100).toFixed(2)) : 0;
  const totalCostUsd = Number(
    details.reduce((sum, d) => sum + (d.audit_result.estimated_cost_usd || 0), 0).toFixed(6)
  );
  const totalCostIdr = Number(
    details.reduce((sum, d) => sum + (d.audit_result.estimated_cost_idr || 0), 0).toFixed(2)
  );

  const report = {
    engine_version: 'v2',
    mode,
    generated_at: new Date().toISOString(),
    total_files: totalFiles,
    matched_count: matchedCount,
    mismatch_count: mismatchCount,
    accuracy_percent: accuracyPercent,
    total_estimated_cost_usd: totalCostUsd,
    total_estimated_cost_idr: totalCostIdr,
    details,
  };

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  console.log(`=== Wild Stress Test v2 (${mode.toUpperCase()}) ===`);
  printStressTable(tableRows);
  console.log(
    `Ringkasan v2: ${matchedCount}/${totalFiles} PASS (${accuracyPercent}%), Mismatch: ${mismatchCount}, Est. Total Cost: $${totalCostUsd} (Rp${totalCostIdr})`
  );
  console.log(`Laporan disimpan ke: ${path.relative(ROOT_DIR, REPORT_PATH)}`);

  if (mismatchCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Stress test gagal:', err.message);
  process.exitCode = 1;
});
