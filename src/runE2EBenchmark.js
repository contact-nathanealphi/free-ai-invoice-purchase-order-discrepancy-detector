'use strict';

const fs = require('fs');
const path = require('path');
const { auditInvoice } = require('./auditEngine');
const { loadEnvFile, extractInvoiceWithGemini } = require('./geminiExtractor');

const ROOT_DIR = path.resolve(__dirname, '..');
const MASTER_PO_PATH = path.join(ROOT_DIR, 'test_data', 'Master_PO.csv');
const EXPECTED_RESULTS_PATH = path.join(ROOT_DIR, 'test_data', 'expected_results.json');
const INVOICES_DIR = path.join(ROOT_DIR, 'test_data', 'invoices');
const REPORT_PATH = path.join(ROOT_DIR, 'reports', 'benchmark_summary.json');
const LIVE_REQUEST_PACING_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parses a simple RFC-4180 CSV file into an array of objects.
 * @param {string} csvContent
 * @returns {Array<object>}
 */
function parseCsv(csvContent) {
  const lines = csvContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return [];
  }

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

/**
 * Simulates local AI PDF extraction using Stage 1 fixtures for offline E2E verification.
 * @param {string} fileName
 * @param {object} expectedFixture
 * @param {Array<object>} masterPOList
 * @returns {{ extractedInvoice: object, latency_ms: number, token_usage: { promptTokenCount: number, candidatesTokenCount: number, totalTokenCount: number } }}
 */
function simulateExtraction(fileName, expectedFixture, masterPOList) {
  if (!expectedFixture) {
    throw new Error(`Fixture expected_results.json tidak ditemukan untuk file: ${fileName}`);
  }

  const matchedPO = masterPOList.find(
    (po) => String(po.po_number).trim().toLowerCase() === String(expectedFixture.po_number).trim().toLowerCase()
  );

  const isLowConfidence = expectedFixture.scenario === 'LOW_CONFIDENCE_SCAN';

  return {
    extractedInvoice: {
      invoice_number: expectedFixture.invoice_number,
      po_number: expectedFixture.po_number,
      vendor_name: expectedFixture.vendor_name,
      item_name: matchedPO ? matchedPO.item_name : 'Unknown Item',
      qty: matchedPO ? Number(matchedPO.qty) : 0,
      unit_price: Number(expectedFixture.billed_unit_price),
      subtotal: Number(expectedFixture.billed_subtotal),
      tax_amount: Number(expectedFixture.billed_tax_11),
      grand_total: Number(expectedFixture.billed_total),
      confidence_score: isLowConfidence ? 0.62 : 0.97,
      extraction_notes: isLowConfidence
        ? 'Simulasi scan miring, buram, dan noise berat pada area nominal.'
        : 'Simulasi ekstraksi dokumen terbaca jelas.',
    },
    latency_ms: 15,
    token_usage: {
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
    },
    model_used: 'mock-simulator',
    retry_count: 0,
  };
}

/**
 * Prints a formatted summary table to stdout.
 * @param {Array<object>} rows
 */
function printSummaryTable(rows) {
  const columns = [
    { key: 'file_name', label: 'Nama File', width: 35 },
    { key: 'expected_status', label: 'Expected Status', width: 22 },
    { key: 'actual_status', label: 'Actual Status', width: 22 },
    { key: 'match_label', label: 'Match?', width: 8 },
    { key: 'latency_label', label: 'Latency', width: 10 },
    { key: 'tokens_label', label: 'Tokens', width: 8 },
    { key: 'retries_label', label: 'Retries', width: 7 },
  ];

  const formatRow = (row) =>
    columns
      .map((col) => String(row[col.key] ?? '').slice(0, col.width).padEnd(col.width))
      .join(' | ');

  const headerLine = formatRow(
    Object.fromEntries(columns.map((col) => [col.key, col.label]))
  );
  const separator = columns.map((col) => '-'.repeat(col.width)).join('-+-');

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

  const masterPOList = parseCsv(fs.readFileSync(MASTER_PO_PATH, 'utf8'));
  const expectedData = JSON.parse(fs.readFileSync(EXPECTED_RESULTS_PATH, 'utf8'));
  const expectedByFile = new Map(
    (expectedData.results || []).map((item) => [item.file_name, item])
  );

  const pdfFiles = fs
    .readdirSync(INVOICES_DIR)
    .filter((name) => name.toLowerCase().endsWith('.pdf'))
    .sort((a, b) => a.localeCompare(b));

  const existingAuditLogs = [];
  const details = [];
  const tableRows = [];

  for (let i = 0; i < pdfFiles.length; i += 1) {
    const fileName = pdfFiles[i];
    const pdfPath = path.join(INVOICES_DIR, fileName);
    const expectedFixture = expectedByFile.get(fileName);
    const expectedStatus = expectedFixture ? expectedFixture.expected_status : 'UNKNOWN';

    console.log(`[${i + 1}/${pdfFiles.length}] Memproses ${fileName}...`);

    const extractionResult = isMock
      ? simulateExtraction(fileName, expectedFixture, masterPOList)
      : await extractInvoiceWithGemini(pdfPath);

    const auditResult = auditInvoice(
      extractionResult.extractedInvoice,
      masterPOList,
      existingAuditLogs
    );

    // Record processed invoice so subsequent duplicate bills are caught by Gate 2
    if (auditResult.audit_status !== 'HOLD - DUPLICATE') {
      existingAuditLogs.push(auditResult);
    }

    const isMatch = auditResult.audit_status === expectedStatus;
    const totalTokens = extractionResult.token_usage?.totalTokenCount || 0;
    const retryCount = extractionResult.retry_count ?? 0;
    const modelUsed = extractionResult.model_used || extractionResult.model || 'mock-simulator';

    console.log(`-> ${auditResult.audit_status} (${extractionResult.latency_ms}ms, model: ${modelUsed})`);

    details.push({
      file_name: fileName,
      expected_status: expectedStatus,
      actual_status: auditResult.audit_status,
      match: isMatch,
      latency_ms: extractionResult.latency_ms,
      model_used: modelUsed,
      retry_count: retryCount,
      token_usage: extractionResult.token_usage,
      audit_result: auditResult,
    });

    tableRows.push({
      file_name: fileName,
      expected_status: expectedStatus,
      actual_status: auditResult.audit_status,
      match_label: isMatch ? 'PASS' : 'FAIL',
      latency_label: `${extractionResult.latency_ms}ms`,
      tokens_label: String(totalTokens),
      retries_label: String(retryCount),
    });

    if (isLive && i < pdfFiles.length - 1) {
      await sleep(LIVE_REQUEST_PACING_MS);
    }
  }

  const totalFiles = details.length;
  const matchedCount = details.filter((d) => d.match).length;
  const mismatchCount = totalFiles - matchedCount;
  const accuracyPercent = totalFiles > 0 ? Number(((matchedCount / totalFiles) * 100).toFixed(2)) : 0;
  const avgLatencyMs =
    totalFiles > 0
      ? Number((details.reduce((sum, d) => sum + d.latency_ms, 0) / totalFiles).toFixed(2))
      : 0;
  const totalTokens = details.reduce(
    (sum, d) => sum + (d.token_usage?.totalTokenCount || 0),
    0
  );

  const summaryReport = {
    mode,
    generated_at: new Date().toISOString(),
    total_files: totalFiles,
    matched_count: matchedCount,
    mismatch_count: mismatchCount,
    accuracy_percent: accuracyPercent,
    average_latency_ms: avgLatencyMs,
    total_tokens: totalTokens,
    details,
  };

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(summaryReport, null, 2));

  console.log(`=== E2E Benchmark Runner (${mode.toUpperCase()}) ===`);
  printSummaryTable(tableRows);
  console.log(
    `Ringkasan: ${matchedCount}/${totalFiles} MATCH (${accuracyPercent}%), Mismatch: ${mismatchCount}, Rata-rata Latency: ${avgLatencyMs}ms, Total Tokens: ${totalTokens}`
  );
  console.log(`Laporan disimpan ke: ${path.relative(ROOT_DIR, REPORT_PATH)}`);

  if (mismatchCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Benchmark gagal dijalankan:', err.message);
  process.exitCode = 1;
});
