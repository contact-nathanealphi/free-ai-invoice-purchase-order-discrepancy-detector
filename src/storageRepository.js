'use strict';

const { isSupabaseConfigured } = require('./dbRepository');

const DEFAULT_BUCKET = process.env.AUDIT_STORAGE_BUCKET || 'invoice-pdfs';
const DEFAULT_SIGNED_URL_TTL_SECONDS = Number(process.env.AUDIT_SIGNED_URL_TTL_SECONDS) || 900;

function sanitizeStorageFileName(fileName) {
  return String(fileName || 'invoice.pdf')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'invoice.pdf';
}

function getSupabaseStorageClient() {
  if (!isSupabaseConfigured()) return null;
  const { createClient } = require('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function createStorageRepository(options = {}) {
  const bucket = options.bucket || process.env.AUDIT_STORAGE_BUCKET || DEFAULT_BUCKET;
  const signedUrlTtlSeconds = Math.max(
    60,
    Number(options.signedUrlTtlSeconds) || DEFAULT_SIGNED_URL_TTL_SECONDS
  );
  const forceLocal = Boolean(options.forceLocal);
  const supabase = options.supabaseClient || (!forceLocal ? getSupabaseStorageClient() : null);

  async function uploadInvoiceDocument({
    base64Data = '',
    fileName = 'invoice.pdf',
    fileHash = '',
    mimeType = 'application/pdf',
  } = {}) {
    if (!base64Data) {
      return {
        mode: 'none',
        bucket: null,
        storage_path: null,
        signed_url: null,
        signed_url_expires_in: null,
      };
    }

    if (!supabase || !supabase.storage) {
      return {
        mode: 'local-inline-ephemeral',
        bucket: null,
        storage_path: null,
        signed_url: null,
        signed_url_expires_in: null,
      };
    }

    const cleanB64 = String(base64Data).replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(cleanB64, 'base64');
    const ym = new Date().toISOString().slice(0, 7);
    const hashPrefix = String(fileHash || Date.now().toString(16)).slice(0, 16);
    const storagePath = `invoices/${ym}/${hashPrefix}_${sanitizeStorageFileName(fileName)}`;

    const bucketApi = supabase.storage.from(bucket);
    const { error: uploadErr } = await bucketApi.upload(storagePath, buffer, {
      contentType: mimeType || 'application/pdf',
      upsert: true,
    });
    if (uploadErr) {
      throw new Error(`Supabase Storage upload error: ${uploadErr.message}`);
    }

    const { data: signedData, error: signErr } = await bucketApi.createSignedUrl(
      storagePath,
      signedUrlTtlSeconds
    );
    if (signErr) {
      throw new Error(`Supabase Storage signed URL error: ${signErr.message}`);
    }

    return {
      mode: 'supabase_storage',
      bucket,
      storage_path: storagePath,
      signed_url: signedData?.signedUrl || null,
      signed_url_expires_in: signedUrlTtlSeconds,
    };
  }

  return {
    mode: supabase ? 'supabase_storage' : 'local-inline-ephemeral',
    bucket,
    uploadInvoiceDocument,
  };
}

module.exports = {
  createStorageRepository,
  sanitizeStorageFileName,
  DEFAULT_BUCKET,
  DEFAULT_SIGNED_URL_TTL_SECONDS,
};
