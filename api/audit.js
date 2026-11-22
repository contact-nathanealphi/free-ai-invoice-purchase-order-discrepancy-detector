'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { auditInvoice, normalizePoNumber, resolvePolicyConfig } = require('../src/auditEngine');
const { runForensicAnalysis } = require('../src/forensicEngine');
const { extractPdfToMarkdown } = require('../src/pdfMarkdownExtractor');
const {
  resolveProviderConfig,
  extractStructuredDocument,
  validateSupportedMimeType,
  SUPPORTED_IMAGE_MIMES,
} = require('../src/aiProviderAdapter');
const { createRepository, flattenPurchaseOrdersForAudit } = require('../src/dbRepository');
const sampleCache = require('../src/sampleCache.json');
const {
  sendJson,
  handleCorsPreflight,
  parseJsonBody,
  getClientIp,
  checkDailyDemoQuota,
} = require('../src/apiHelpers');

const PROJECT_ROOT = path.resolve(__dirname, '..');

module.exports = async function handler(req, res) {
  if (handleCorsPreflight(req, res)) return;
  if (req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: 'Method Not Allowed. Use POST.' });
  }

  try {
    const body = await parseJsonBody(req);
    const repo = createRepository();

    // Stateless workspace support: prefer client-sent purchaseOrders/auditLogs if provided
    const hasClientWorkspace = Array.isArray(body.purchaseOrders);
    const [purchaseOrders, existingLogs] = hasClientWorkspace
      ? [body.purchaseOrders, Array.isArray(body.auditLogs) ? body.auditLogs : []]
      : await Promise.all([repo.getPurchaseOrders(), repo.getAuditLogs()]);

    let fileName = body.fileName || 'uploaded_invoice.pdf';
    let cleanBase64 = '';
    let normalizedMime = 'application/pdf';
    let extractedInvoice;
    let extractionMeta = {
      extraction_method: 'text_markdown',
      estimated_tokens_saved_pct: 0,
      extracted_markdown: '',
      model_used: 'sample-cache-0-token',
      latency_ms: 0,
      token_usage: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
      cost_idr: null,
    };

    if (body.preExtractedInvoice && typeof body.preExtractedInvoice === 'object') {
      // Local Offline AI (Ollama / LM Studio) extracted directly in browser
      extractedInvoice = { ...body.preExtractedInvoice };
      normalizedMime = body.mimeType || 'application/pdf';
      cleanBase64 = body.fileBase64
        ? String(body.fileBase64).replace(/^data:[^;]+;base64,/, '')
        : '';
      extractionMeta = {
        extraction_method: body.extractionMethod || 'local_offline_ai',
        estimated_tokens_saved_pct: 100,
        extracted_markdown: body.extractedMarkdown || '',
        model_used: body.modelUsed || 'local-ollama',
        latency_ms: Number(body.latencyMs || 0),
        token_usage: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        cost_idr: 0,
      };
    } else if (body.sampleId) {
      const cached = sampleCache[body.sampleId];
      if (!cached) {
        return sendJson(res, 400, {
          ok: false,
          error: `Sample scenario "${body.sampleId}" not found.`,
        });
      }
      fileName = cached.fileName;
      const sampleFullPath = path.join(PROJECT_ROOT, cached.filePath);
      if (fs.existsSync(sampleFullPath)) {
        cleanBase64 = fs.readFileSync(sampleFullPath).toString('base64');
      }
      extractedInvoice = { ...cached.extractedInvoice };
      extractionMeta = {
        extraction_method: cached.extraction_method,
        estimated_tokens_saved_pct: cached.estimated_tokens_saved_pct,
        extracted_markdown: cached.extracted_markdown || '',
        model_used: cached.model_used,
        latency_ms: cached.latency_ms,
        token_usage: cached.token_usage,
        cost_idr: 0,
      };
    } else {
      const rawText = String(body.rawText || '').trim();
      const rawFileBase64 = body.fileBase64 || body.pdfBase64 || '';

      if (!rawFileBase64 && !rawText) {
        return sendJson(res, 400, {
          ok: false,
          error: 'Please provide { fileName, fileBase64/pdfBase64 }, { rawText }, or { sampleId }.',
        });
      }

      if (rawFileBase64) {
        try {
          normalizedMime = validateSupportedMimeType(body.mimeType || 'application/pdf');
        } catch (mimeErr) {
          return sendJson(res, 400, { ok: false, error: mimeErr.message });
        }
      } else {
        normalizedMime = 'text/plain';
        fileName = body.fileName || `pasted_invoice_${Date.now()}.txt`;
      }

      const providerCfg = resolveProviderConfig(req.headers);
      if (!providerCfg.isByok) {
        const quota = checkDailyDemoQuota(getClientIp(req));
        if (!quota.allowed) {
          return sendJson(res, 429, {
            ok: false,
            code: 'DEMO_QUOTA_EXCEEDED',
            error: `Free server demo quota (${quota.limit} custom documents/day) reached. Add your own API key (BYOK) in AI Settings for unlimited private audits.`,
          });
        }
      }

      let extractionMethod = 'raw_text';
      let estimatedSavedPct = 90;
      let markdownText = rawText;

      if (rawFileBase64) {
        cleanBase64 = String(rawFileBase64).replace(/^data:[^;]+;base64,/, '');
        if (SUPPORTED_IMAGE_MIMES.has(normalizedMime)) {
          extractionMethod = 'multimodal_vision';
          estimatedSavedPct = 0;
          markdownText = '';
        } else {
          const hybridRead = await extractPdfToMarkdown({
            pdfBase64: cleanBase64,
            forceVision: Boolean(body.forceVision),
          });
          extractionMethod = hybridRead.extraction_method;
          estimatedSavedPct = hybridRead.estimated_tokens_saved_pct;
          markdownText = hybridRead.extracted_markdown;
        }
      }

      const aiResult = await extractStructuredDocument({
        provider: providerCfg.provider,
        model: providerCfg.model,
        apiKey: providerCfg.apiKey,
        extractionMethod,
        markdownText,
        pdfBase64: cleanBase64,
        mimeType: normalizedMime === 'text/plain' ? 'application/pdf' : normalizedMime,
        documentType: 'invoice',
      });

      extractedInvoice = aiResult.data;
      extractionMeta = {
        extraction_method: extractionMethod,
        estimated_tokens_saved_pct: estimatedSavedPct,
        extracted_markdown: markdownText,
        model_used: aiResult.model_used,
        latency_ms: aiResult.latency_ms,
        token_usage: aiResult.token_usage,
        cost_idr: aiResult.estimated_cost_idr,
      };
    }

    const hashInput = cleanBase64
      ? Buffer.from(cleanBase64, 'base64')
      : body.rawText
        ? Buffer.from(String(body.rawText), 'utf8')
        : Buffer.from(JSON.stringify(extractedInvoice));
    const fileHash = crypto.createHash('sha256').update(hashInput).digest('hex');
    extractedInvoice.file_hash = fileHash;

    const resolvedPolicy = resolvePolicyConfig({
      ...(body.policyConfig || {}),
      itemAliases: Array.isArray(body.itemAliases)
        ? body.itemAliases
        : body.policyConfig?.itemAliases || [],
    });
    const flatPOs = flattenPurchaseOrdersForAudit(purchaseOrders);
    const auditResult = auditInvoice(extractedInvoice, flatPOs, existingLogs, {
      token_usage: extractionMeta.token_usage,
      policyConfig: resolvedPolicy,
    });

    const canonicalPo = normalizePoNumber(auditResult.po_number);
    const matchedPo =
      purchaseOrders.find((po) => normalizePoNumber(po.po_number) === canonicalPo) || null;

    const forensic = runForensicAnalysis(extractedInvoice, existingLogs, purchaseOrders, matchedPo, {
      approvalThreshold: resolvedPolicy.splitThreshold,
      splitWindowDays: resolvedPolicy.splitWindowDays,
    });

    const costIdr = extractionMeta.cost_idr !== null ? extractionMeta.cost_idr : auditResult.estimated_cost_idr;

    const logPayload = {
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      file_name: fileName,
      file_hash: fileHash,
      mime_type: normalizedMime,
      invoice_number: auditResult.invoice_number,
      po_number: auditResult.po_number,
      vendor_name: auditResult.vendor_name,
      currency: auditResult.currency,
      grand_total: auditResult.invoiced_total,
      audit_status: auditResult.audit_status,
      reasons: auditResult.discrepancy_reason ? [auditResult.discrepancy_reason] : [],
      forensic_signals: forensic.forensic_signals,
      forensic_risk_score: forensic.forensic_risk_score,
      forensic_level: forensic.forensic_level,
      extraction_data: {
        ...extractedInvoice,
        _checked_rules: auditResult.checked_rules || [],
        _pdf_base64: cleanBase64,
        _mime_type: normalizedMime,
        _extraction_method: extractionMeta.extraction_method,
        _estimated_tokens_saved_pct: extractionMeta.estimated_tokens_saved_pct,
        _extracted_markdown: extractionMeta.extracted_markdown,
      },
      po_snapshot: matchedPo,
      policy_snapshot: resolvedPolicy,
      model_used: extractionMeta.model_used,
      latency_ms: extractionMeta.latency_ms,
      cost_idr: costIdr,
      reviewer_action: null,
      reviewer_note: null,
    };

    // Only persist to server repo when client is NOT managing its own stateless workspace
    const savedLog = hasClientWorkspace ? logPayload : await repo.insertAuditLog(logPayload);

    if (
      !hasClientWorkspace &&
      (auditResult.audit_status === 'APPROVED' || auditResult.audit_status === 'APPROVED - PARTIAL')
    ) {
      const billedLines =
        Array.isArray(extractedInvoice.line_items) && extractedInvoice.line_items.length > 0
          ? extractedInvoice.line_items
          : [
              {
                item_name: extractedInvoice.item_name || matchedPo?.items?.[0]?.item_name || '',
                qty: extractedInvoice.qty || 0,
              },
            ];
      await repo.updatePurchaseOrderBalances(auditResult.po_number, billedLines);
    }

    return sendJson(res, 200, {
      ok: true,
      audit_log: savedLog,
      audit_result: {
        ...auditResult,
        ...forensic,
      },
      forensic_signals: forensic.forensic_signals,
      forensic_risk_score: forensic.forensic_risk_score,
      forensic_level: forensic.forensic_level,
      pdf_base64: cleanBase64,
      mime_type: normalizedMime,
      extraction_method: extractionMeta.extraction_method,
      estimated_tokens_saved_pct: extractionMeta.estimated_tokens_saved_pct,
      extracted_markdown: extractionMeta.extracted_markdown,
    });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err.message });
  }
};
