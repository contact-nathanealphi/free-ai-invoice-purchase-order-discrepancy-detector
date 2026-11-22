'use strict';

const { extractPdfToMarkdown } = require('../src/pdfMarkdownExtractor');
const {
  resolveProviderConfig,
  extractStructuredDocument,
  validateSupportedMimeType,
  SUPPORTED_IMAGE_MIMES,
} = require('../src/aiProviderAdapter');
const {
  sendJson,
  handleCorsPreflight,
  parseJsonBody,
  getClientIp,
  checkDailyDemoQuota,
} = require('../src/apiHelpers');

module.exports = async function handler(req, res) {
  if (handleCorsPreflight(req, res)) return;
  if (req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: 'Method Not Allowed. Use POST.' });
  }

  try {
    const body = await parseJsonBody(req);
    const rawText = String(body.rawText || '').trim();
    const rawFileBase64 = body.fileBase64 || body.pdfBase64 || '';

    if (!rawFileBase64 && !rawText) {
      return sendJson(res, 400, {
        ok: false,
        error: 'Please provide { fileName, fileBase64/pdfBase64 } or { rawText }.',
      });
    }

    let normalizedMime = 'application/pdf';
    if (rawFileBase64) {
      try {
        normalizedMime = validateSupportedMimeType(body.mimeType || 'application/pdf');
      } catch (mimeErr) {
        return sendJson(res, 400, { ok: false, error: mimeErr.message });
      }
    }

    const providerCfg = resolveProviderConfig(req.headers);
    if (!providerCfg.isByok) {
      const quota = checkDailyDemoQuota(getClientIp(req));
      if (!quota.allowed) {
        return sendJson(res, 429, {
          ok: false,
          code: 'DEMO_QUOTA_EXCEEDED',
          error: `Free server demo quota (${quota.limit} custom documents/day) reached. Add your own API key (BYOK) in AI Settings for unlimited private extractions.`,
        });
      }
    }

    let extractionMethod = 'raw_text';
    let markdownText = rawText;
    let cleanBase64 = '';
    let estimatedSavedPct = 90;

    if (rawFileBase64) {
      cleanBase64 = String(rawFileBase64).replace(/^data:[^;]+;base64,/, '');
      if (SUPPORTED_IMAGE_MIMES.has(normalizedMime)) {
        extractionMethod = 'multimodal_vision';
        markdownText = '';
        estimatedSavedPct = 0;
      } else {
        const hybridRead = await extractPdfToMarkdown({
          pdfBase64: cleanBase64,
          forceVision: Boolean(body.forceVision),
        });
        extractionMethod = hybridRead.extraction_method;
        markdownText = hybridRead.extracted_markdown;
        estimatedSavedPct = hybridRead.estimated_tokens_saved_pct;
      }
    }

    const aiResult = await extractStructuredDocument({
      provider: providerCfg.provider,
      model: providerCfg.model,
      apiKey: providerCfg.apiKey,
      extractionMethod,
      markdownText,
      pdfBase64: cleanBase64,
      mimeType: normalizedMime,
      documentType: 'purchase_order',
    });

    const raw = aiResult.data || {};
    const rawItems = Array.isArray(raw.line_items) ? raw.line_items : [];
    const items = rawItems.map((item) => {
      const qty = Number(item.qty_ordered ?? item.qty ?? 1) || 1;
      const unitPrice = Number(item.unit_price ?? 0) || 0;
      return {
        sku: item.sku || '',
        item_name: String(item.item_name || item.description || 'Unnamed Item').trim(),
        qty,
        unit_price: unitPrice,
        remaining_qty: qty,
        grn_received_qty: qty,
      };
    });

    const purchaseOrder = {
      po_number: String(raw.po_number || `PO-${Date.now().toString().slice(-6)}`).trim().toUpperCase(),
      vendor_name: String(raw.vendor_name || 'Unknown Vendor').trim(),
      po_type: String(raw.po_type || 'GOODS').toUpperCase() === 'SERVICE' ? 'SERVICE' : 'GOODS',
      currency: String(raw.currency || 'IDR').trim().toUpperCase(),
      items,
      subtotal: Number(raw.subtotal || 0),
      tax_amount: Number(raw.tax_amount || 0),
      total_amount: Number(raw.total_amount || 0),
      status: 'OPEN',
      created_at: new Date().toISOString(),
    };

    return sendJson(res, 200, {
      ok: true,
      purchase_order: purchaseOrder,
      extraction_method: extractionMethod,
      estimated_tokens_saved_pct: estimatedSavedPct,
      extracted_markdown: markdownText,
      model_used: aiResult.model_used,
      latency_ms: aiResult.latency_ms,
      cost_idr: aiResult.estimated_cost_idr,
    });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err.message });
  }
};
