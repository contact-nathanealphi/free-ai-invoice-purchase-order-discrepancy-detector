'use strict';

(function (global) {
  function toBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 1) {
      bin += String.fromCharCode(bytes[i]);
    }
    return btoa(bin);
  }

  function fromBase64(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  }

  async function deriveAesKey(password, saltBytes) {
    const subtle = global.crypto?.subtle;
    if (!subtle) throw new Error('Web Crypto API is unavailable in this browser.');
    const enc = new TextEncoder();
    const baseKey = await subtle.importKey(
      'raw',
      enc.encode(String(password || '')),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: saltBytes,
        iterations: 100000,
        hash: 'SHA-256',
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptWorkspaceVault(workspaceData, password) {
    if (!password || String(password).length < 4) {
      throw new Error('Vault password must be at least 4 characters.');
    }
    const salt = global.crypto.getRandomValues(new Uint8Array(16));
    const iv = global.crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveAesKey(password, salt);
    const plaintext = new TextEncoder().encode(JSON.stringify(workspaceData));
    const cipherBuf = await global.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

    return JSON.stringify(
      {
        format: 'AUDITVAULT_V1',
        kdf: 'PBKDF2-SHA256',
        cipher: 'AES-256-GCM',
        created_at: new Date().toISOString(),
        salt: toBase64(salt),
        iv: toBase64(iv),
        ciphertext: toBase64(new Uint8Array(cipherBuf)),
      },
      null,
      2
    );
  }

  async function decryptWorkspaceVault(vaultText, password) {
    const parsed = JSON.parse(vaultText);
    const validFormats = new Set(['AUDITVAULT_V1', 'EXACTA_VAULT_V1', 'PARIVEX_VAULT_V1']);
    if (!validFormats.has(parsed?.format)) {
      throw new Error('Invalid .auditvault encrypted vault file.');
    }
    const salt = fromBase64(parsed.salt);
    const iv = fromBase64(parsed.iv);
    const ciphertext = fromBase64(parsed.ciphertext);
    const key = await deriveAesKey(password, salt);
    try {
      const plainBuf = await global.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
      const text = new TextDecoder().decode(plainBuf);
      return JSON.parse(text);
    } catch {
      throw new Error('Incorrect vault password or corrupted .auditvault file.');
    }
  }

  async function sha256Hex(text) {
    const subtle = global.crypto?.subtle;
    if (!subtle) return '';
    const buf = await subtle.digest('SHA-256', new TextEncoder().encode(String(text || '')));
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  const exported = { encryptWorkspaceVault, decryptWorkspaceVault, sha256Hex };
  global.ExactaVault = exported;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
})(typeof window !== 'undefined' ? window : globalThis);
