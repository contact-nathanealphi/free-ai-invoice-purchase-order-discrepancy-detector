'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const AUDIT_ENGINE_PATH = path.join(PROJECT_ROOT, 'src', 'auditEngine.js');
const PROMPT_PATH = path.join(PROJECT_ROOT, 'prompts', 'invoice_extraction_prompt.txt');
const SCHEMA_PATH = path.join(PROJECT_ROOT, 'src', 'invoiceSchema.json');
const TEMPLATE_OUT_PATH = path.join(PROJECT_ROOT, 'src', 'n8nCodeNodeTemplate.js');
const WORKFLOW_OUT_PATH = path.join(PROJECT_ROOT, 'workflows', 'invoice_po_audit_n8n.json');

function extractCoreEngineSource() {
  const raw = fs.readFileSync(AUDIT_ENGINE_PATH, 'utf8').replace(/\r\n/g, '\n');
  const withoutUseStrict = raw.replace(/^'use strict';\n+/, '');
  const exportIdx = withoutUseStrict.lastIndexOf('module.exports = {');
  if (exportIdx === -1) {
    throw new Error('Could not locate module.exports block in src/auditEngine.js');
  }
  return withoutUseStrict.slice(0, exportIdx).trim();
}

function buildTemplateSource(coreSource) {
  const header = [
    '/**',
    ' * AUTO-GENERATED FILE — DO NOT EDIT DIRECTLY.',
    ' * Source of truth: src/auditEngine.js (run `npm run build:n8n` to regenerate).',
    ' *',
    ' * n8n Code Node Template v3 (Mode: Run Once for All Items)',
    ' * Input items (`$input.all()`) may carry:',
    ' *  - `extracted_invoice` (or flat invoice fields on `item.json`)',
    ' *  - `master_po_list` (array of Master_PO rows)',
    ' *  - `existing_audit_logs` (optional array, default `[]`)',
    ' *  - `vendor_master` (optional array for Gate 6 Anti-BEC check, default `[]`)',
    ' *  - `policy_config` (optional policy overrides)',
    ' */',
    '',
  ].join('\n');

  const entrypoint = [
    '',
    '// --- n8n Execution Entrypoint ---',
    'const items = $input.all();',
    'return items.map((item) => {',
    '  const payload = item.json || {};',
    '  const extractedInvoice = payload.extracted_invoice || payload;',
    '  const masterPOList = payload.master_po_list || [];',
    '  const existingAuditLogs = payload.existing_audit_logs || [];',
    '  const vendorMaster = payload.vendor_master || [];',
    '  const policyConfig = payload.policy_config || {};',
    '  return {',
    '    json: auditInvoice(extractedInvoice, masterPOList, existingAuditLogs, {',
    '      policyConfig,',
    '      vendorMaster,',
    '    }),',
    '  };',
    '});',
    '',
  ].join('\n');

  return `${header}${coreSource}\n${entrypoint}`;
}

function buildWorkflowCodeNodeJs(coreSource) {
  const header = [
    '// AUTO-GENERATED from src/auditEngine.js via `npm run build:n8n`.',
    '',
  ].join('\n');

  const entrypoint = [
    '',
    'const geminiResponse = $(\'HTTP Request - Gemini Extraction\').first().json || {};',
    'const rawText = geminiResponse.candidates?.[0]?.content?.parts?.[0]?.text || \'{}\';',
    'let extractedInvoice = {};',
    'try {',
    '  extractedInvoice = typeof rawText === \'string\' ? JSON.parse(rawText) : rawText;',
    '} catch {',
    '  extractedInvoice = { confidence_score: 0, extraction_notes: \'Invalid JSON response from extractor\' };',
    '}',
    '',
    'const masterPOList = $(\'Read Master_PO\').all().map((item) => item.json).filter((row) => row && row.po_number);',
    'const existingAuditLogs = $(\'Read Invoice_Audit_Log\').all().map((item) => item.json).filter((row) => row && row.invoice_number);',
    'const usage = geminiResponse.usageMetadata || {};',
    'const auditResult = auditInvoice(extractedInvoice, masterPOList, existingAuditLogs, { token_usage: usage });',
    'return [{ json: { ...auditResult, audited_at: new Date().toISOString() } }];',
  ].join('\n');

  return `${header}${coreSource}\n${entrypoint}`;
}

function buildGeminiJsonBodyExpression() {
  const promptText = fs.readFileSync(PROMPT_PATH, 'utf8').replace(/\r\n/g, '\n').trim();
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const placeholder = '__N8N_PDF_BASE64_EXPR__';
  const bodyObj = {
    system_instruction: {
      parts: [{ text: promptText }],
    },
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: 'Ekstrak seluruh field faktur B2B dari dokumen PDF terlampir sesuai skema JSON v2 yang ditentukan.',
          },
          {
            inline_data: {
              mime_type: 'application/pdf',
              data: placeholder,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: schema,
    },
  };
  const serialized = JSON.stringify(bodyObj, null, 2).replace(
    `"${placeholder}"`,
    () => '$json.pdf_base64'
  );
  return `={{ JSON.stringify(${serialized}) }}`;
}

function buildWorkflowJson(coreSource) {
  const workflow = JSON.parse(fs.readFileSync(WORKFLOW_OUT_PATH, 'utf8'));
  const geminiNode = workflow.nodes.find((n) => n.id === 'node-gemini-http');
  const codeNode = workflow.nodes.find((n) => n.id === 'node-audit-code');

  if (!geminiNode || !codeNode) {
    throw new Error('Expected nodes node-gemini-http and node-audit-code in workflows/invoice_po_audit_n8n.json');
  }

  geminiNode.parameters.jsonBody = buildGeminiJsonBodyExpression();
  codeNode.parameters.jsCode = buildWorkflowCodeNodeJs(coreSource);
  return `${JSON.stringify(workflow, null, 2)}\n`;
}

function run({ check = false } = {}) {
  const coreSource = extractCoreEngineSource();
  const expectedTemplate = buildTemplateSource(coreSource);
  const expectedWorkflow = buildWorkflowJson(coreSource);

  if (check) {
    const currentTemplate = fs.existsSync(TEMPLATE_OUT_PATH)
      ? fs.readFileSync(TEMPLATE_OUT_PATH, 'utf8').replace(/\r\n/g, '\n')
      : '';
    const currentWorkflow = fs.existsSync(WORKFLOW_OUT_PATH)
      ? fs.readFileSync(WORKFLOW_OUT_PATH, 'utf8').replace(/\r\n/g, '\n')
      : '';

    const drifts = [];
    if (currentTemplate !== expectedTemplate) drifts.push('src/n8nCodeNodeTemplate.js');
    if (currentWorkflow !== expectedWorkflow) drifts.push('workflows/invoice_po_audit_n8n.json');

    if (drifts.length > 0) {
      throw new Error(
        `n8n artifacts out of sync with src/auditEngine.js: ${drifts.join(', ')}. Run "npm run build:n8n".`
      );
    }
    return { synced: true, drifts: [] };
  }

  fs.writeFileSync(TEMPLATE_OUT_PATH, expectedTemplate, 'utf8');
  fs.writeFileSync(WORKFLOW_OUT_PATH, expectedWorkflow, 'utf8');
  return { synced: true, drifts: [] };
}

if (require.main === module) {
  const isCheck = process.argv.includes('--check');
  try {
    run({ check: isCheck });
    console.log(
      isCheck
        ? 'OK: n8n template & workflow are in sync with src/auditEngine.js.'
        : 'Generated src/n8nCodeNodeTemplate.js and synced workflows/invoice_po_audit_n8n.json.'
    );
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { run };
