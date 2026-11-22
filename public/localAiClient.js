'use strict';

(function (global) {
  const LOCAL_SYSTEM_PROMPT = [
    'You are an Enterprise Accounts Payable Invoice Extractor.',
    'Extract strictly valid JSON with keys:',
    'invoice_number (string), po_number (string), vendor_name (string), currency (string like "IDR" or "USD"),',
    'invoice_date (YYYY-MM-DD), due_date (YYYY-MM-DD), payment_terms (string),',
    'line_items (array of { item_name, qty, unit_price, line_total }),',
    'subtotal (number), ppn_amount (number), pph23_amount (number), grand_total (number),',
    'confidence_score (0.0-1.0), extraction_notes (string).',
    'Return ONLY raw JSON without markdown fences.',
  ].join(' ');

  function stripFences(raw) {
    return String(raw || '')
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
  }

  /**
   * Calls local Ollama / LM Studio OpenAI-compatible endpoint directly from the browser.
   */
  async function extractInvoiceWithLocalAi({
    baseUrl = 'http://localhost:11434/v1',
    model = 'qwen2.5:7b',
    rawText = '',
    fileBase64 = '',
    mimeType = 'application/pdf',
  }) {
    const cleanUrl = String(baseUrl || 'http://localhost:11434/v1').replace(/\/+$/, '');
    const endpoint = `${cleanUrl}/chat/completions`;
    const startedAt = Date.now();

    const isImage = String(mimeType || '').startsWith('image/');
    let userContent;
    if (rawText) {
      userContent = `Extract structured invoice JSON from this document text:\n\n${rawText}`;
    } else if (isImage && fileBase64) {
      const cleanB64 = String(fileBase64).replace(/^data:[^;]+;base64,/, '');
      userContent = [
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${cleanB64}` } },
        { type: 'text', text: 'Extract structured invoice JSON from this image.' },
      ];
    } else {
      throw new Error(
        'Local Offline AI mode supports Pasted Text or Image (JPG/PNG/WEBP) directly in browser. For PDF, paste its text or use a vision image.'
      );
    }

    let resp;
    try {
      resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: 'system', content: LOCAL_SYSTEM_PROMPT },
            { role: 'user', content: userContent },
          ],
        }),
      });
    } catch (err) {
      throw new Error(
        `Cannot reach local AI at ${cleanUrl}. Ensure Ollama/LM Studio is running and CORS is enabled (OLLAMA_ORIGINS="*"). (${err.message})`
      );
    }

    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(payload?.error?.message || `Local AI HTTP ${resp.status}`);
    }
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) throw new Error('Local AI returned empty response.');

    return {
      data: JSON.parse(stripFences(content)),
      model_used: `local:${model}`,
      latency_ms: Date.now() - startedAt,
    };
  }

  global.ExactaLocalAi = { extractInvoiceWithLocalAi };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { extractInvoiceWithLocalAi };
  }
})(typeof window !== 'undefined' ? window : globalThis);
