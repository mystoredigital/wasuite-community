import crypto from 'node:crypto';
import CryptoJS from 'crypto-js';

// GHL cifra el payload de SSO con AES (OpenSSL-compatible) usando el Shared Secret de la app.
// Formato típico: string base64 que crypto-js descifra con AES.decrypt(payload, sharedSecret).
export function decryptGhlPayload(encrypted, sharedSecret) {
  if (!encrypted) throw new Error('Payload vacío');
  if (!sharedSecret) throw new Error('GHL_SHARED_SECRET no configurado');
  const decrypted = CryptoJS.AES.decrypt(encrypted, sharedSecret);
  const text = decrypted.toString(CryptoJS.enc.Utf8);
  if (!text) throw new Error('Decryption fallida (shared secret incorrecto?)');
  return JSON.parse(text);
}

// Firma un valor para usarlo como cookie de sesión embed
export function signSession(value, secret) {
  const h = crypto.createHmac('sha256', secret).update(value).digest('hex').slice(0, 32);
  return `${value}.${h}`;
}

export function verifySession(signed, secret) {
  if (!signed || typeof signed !== 'string') return null;
  const idx = signed.lastIndexOf('.');
  if (idx < 0) return null;
  const value = signed.slice(0, idx);
  const sig = signed.slice(idx + 1);
  const expected = crypto.createHmac('sha256', secret).update(value).digest('hex').slice(0, 32);
  // tiempo-constante para evitar timing attacks
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return value;
}
