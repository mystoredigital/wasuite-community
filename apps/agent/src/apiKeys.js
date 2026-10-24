// API keys para acceso programático a la API REST (n8n, scripts, integraciones).
// Formato del token: wa_<keyId>_<secret>
//   keyId  = 8 chars hex random (público, identifica la key)
//   secret = 32 chars hex random (privado — solo se muestra al crear)
//
// Storage: data/api-keys.json — array plano con {id, hash, label, tenantId, createdAt, lastUsedAt, revokedAt}.
// El secret nunca se guarda en claro; solo su SHA-256.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_ROOT } from './state.js';

const KEYS_FILE = path.join(DATA_ROOT, 'api-keys.json');
const TOKEN_RE = /^wa_([a-f0-9]{8})_([a-f0-9]{32})$/;

let _cache = null;
let _writeQueue = Promise.resolve();

async function load() {
  if (_cache) return _cache;
  try {
    const buf = await fs.readFile(KEYS_FILE, 'utf8');
    _cache = JSON.parse(buf);
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[apiKeys] load falló:', e.message);
    _cache = [];
  }
  return _cache;
}

async function persist() {
  _writeQueue = _writeQueue.then(async () => {
    try {
      await fs.mkdir(DATA_ROOT, { recursive: true }).catch(() => {});
      await fs.writeFile(KEYS_FILE, JSON.stringify(_cache, null, 2), 'utf8');
    } catch (e) {
      console.warn('[apiKeys] persist falló:', e.message);
    }
  });
  return _writeQueue;
}

function hash(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

// Crea una key nueva. Devuelve { id, label, token } — el token completo SOLO se ve una vez.
export async function createKey({ label, tenantId }) {
  if (!label || !label.trim()) throw new Error('label requerido');
  if (!tenantId) throw new Error('tenantId requerido');
  await load();
  const id = crypto.randomBytes(4).toString('hex');
  const secret = crypto.randomBytes(16).toString('hex');
  const entry = {
    id,
    hash: hash(secret),
    label: label.trim(),
    tenantId,
    createdAt: Date.now(),
    lastUsedAt: null,
    revokedAt: null,
  };
  _cache.push(entry);
  await persist();
  return { id, label: entry.label, tenantId, token: `wa_${id}_${secret}`, createdAt: entry.createdAt };
}

// Lista las keys del tenant (sin exponer el hash).
export async function listKeys({ tenantId } = {}) {
  await load();
  return _cache
    .filter((k) => !tenantId || k.tenantId === tenantId)
    .map((k) => ({
      id: k.id,
      label: k.label,
      tenantId: k.tenantId,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      revokedAt: k.revokedAt,
    }));
}

// Revoca una key (no la borra — queda en el log para forense).
export async function revokeKey(id) {
  await load();
  const entry = _cache.find((k) => k.id === id);
  if (!entry) return false;
  if (entry.revokedAt) return true;
  entry.revokedAt = Date.now();
  await persist();
  return true;
}

// Verifica un Bearer token. Devuelve {id, label, tenantId} si válido + no revocado, null en otro caso.
// Side effect: actualiza lastUsedAt (best-effort, no bloquea).
export async function verifyToken(token) {
  if (!token) return null;
  const m = TOKEN_RE.exec(token);
  if (!m) return null;
  const [, id, secret] = m;
  await load();
  const entry = _cache.find((k) => k.id === id);
  if (!entry || entry.revokedAt) return null;
  if (entry.hash !== hash(secret)) return null;
  entry.lastUsedAt = Date.now();
  persist().catch(() => {});
  return { id: entry.id, label: entry.label, tenantId: entry.tenantId };
}
