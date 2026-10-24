import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DATA_ROOT, TenantStore, migrateLegacyIfNeeded } from './state.js';
import { WhatsAppSession } from './whatsapp.js';
import { isPgBackend } from './db.js';
import { PgDriver } from './state-pg.js';
import { setUsageSink } from './usage.js';

// STATE_BACKEND=postgres mueve el estado del agente a la base que ya usa el CRM.
// Sin la variable todo sigue en data/<tenant>/*.json — el rollback es quitarla y
// reiniciar, sin tocar código ni volúmenes.
function makeStore(tenantId, meta = {}) {
  return new TenantStore(tenantId, meta, isPgBackend() ? new PgDriver(tenantId) : null);
}

class TenantRegistry extends EventEmitter {
  constructor() {
    super();
    this.tenants = new Map();
    // sessions: Map<tenantId, Map<numberId, WhatsAppSession>>
    this.sessions = new Map();
  }

  async bootstrap() {
    await fs.mkdir(DATA_ROOT, { recursive: true });

    // El consumo de la IA solo se puede registrar donde hay dónde escribirlo. Con
    // el backend JSON queda sin medir: montar un archivo más para esto no compensa
    // cuando el destino natural es una tabla.
    if (isPgBackend()) {
      const driver = new PgDriver('_usage');
      setUsageSink((row) => driver.saveUsage(row));
    }
    await migrateLegacyIfNeeded();

    // El tenant local se crea con create() y no con un mkdir suelto: create() es
    // quien registra el número 'default'. Con el mkdir el tenant arrancaba sin
    // números, y sin número no hay sesión de Baileys ni QR — una instalación
    // nueva quedaba sin forma de vincular WhatsApp desde la UI.
    if (!fsSync.existsSync(path.join(DATA_ROOT, '_local'))) {
      await this.create('_local');
    }

    const entries = await fs.readdir(DATA_ROOT, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === '_agencies') continue;
      await this.load(e.name);
    }

    const hasGhlTenant = Array.from(this.tenants.values()).some((t) => t.ghl?.accessToken);
    if (hasGhlTenant && !process.env.GHL_CONVERSATION_PROVIDER_ID) {
      console.warn('[bootstrap] ⚠️ Hay tenants con GHL conectado pero GHL_CONVERSATION_PROVIDER_ID no está configurado — el mirroring a GHL Conversations no funcionará');
    }
    if (hasGhlTenant && !process.env.GHL_WEBHOOK_PUBLIC_KEY) {
      console.warn('[bootstrap] ⚠️ GHL_WEBHOOK_PUBLIC_KEY no configurado — los webhooks de eventos (POST /webhooks/ghl) se aceptan sin firma');
    }
  }

  // Puente store → tenants → socket.io. Esta lista tiene que incluir TODO evento
  // que el dashboard escuche: lo que no esté aquí, el store lo emite al vacío.
  // 'read' y 'conv:removed' llevaban tiempo muertos por eso — el server sí los
  // reenviaba y el cliente sí los escuchaba, pero nunca llegaban hasta aquí.
  _wireEvents(store) {
    for (const ev of ['message', 'mode', 'config', 'connection', 'metrics', 'read', 'conv:removed', 'lab']) {
      store.on(ev, (payload) => this.emit(ev, payload));
    }
  }

  // Arranca todos los WhatsAppSession registrados en el TenantStore.numbers
  _startSessionsFor(store) {
    if (!this.sessions.has(store.tenantId)) this.sessions.set(store.tenantId, new Map());
    const map = this.sessions.get(store.tenantId);
    for (const n of store.numbers.values()) {
      if (map.has(n.id)) continue;
      const session = new WhatsAppSession(store, { numberId: n.id, label: n.label, authDir: n.authDir });
      map.set(n.id, session);
      session.start().catch((e) => console.error(`[tenant ${store.tenantId}/${n.id}] start fallo:`, e.message));
    }
  }

  async load(tenantId) {
    if (this.tenants.has(tenantId)) return this.tenants.get(tenantId);
    const store = makeStore(tenantId);
    await store.load();
    this.tenants.set(tenantId, store);
    this._wireEvents(store);
    this._startSessionsFor(store);
    this.emit('tenant:added', { tenantId, tenant: store });
    return store;
  }

  async create(tenantId, meta = {}) {
    if (this.tenants.has(tenantId)) return this.tenants.get(tenantId);
    const store = makeStore(tenantId, meta);
    await store.load();
    await store.persistMeta();
    this.tenants.set(tenantId, store);
    this._wireEvents(store);
    // Tenant nuevo sin números → crea 'default' automáticamente para mantener el
    // flujo clásico de "abrir tenant → escanear QR del número principal".
    if (store.numbers.size === 0) {
      store.addNumber({ id: 'default', label: 'Principal' });
    }
    this._startSessionsFor(store);
    this.emit('tenant:added', { tenantId, tenant: store });
    return store;
  }

  get(tenantId) {
    return this.tenants.get(tenantId);
  }

  // session(tenantId) → default number's session (retro-compat)
  // session(tenantId, numberId) → specific
  session(tenantId, numberId) {
    const map = this.sessions.get(tenantId);
    if (!map || map.size === 0) return null;
    if (!numberId) {
      const store = this.tenants.get(tenantId);
      const defaultId = store?.getDefaultNumberId();
      return defaultId ? map.get(defaultId) : map.values().next().value;
    }
    return map.get(numberId) || null;
  }

  // Sesión recomendada para enviar a un JID — usa lastNumberByJid si está registrado.
  sessionForJid(tenantId, jid) {
    const store = this.tenants.get(tenantId);
    if (!store) return null;
    const numberId = store.getNumberForJid(jid);
    return this.session(tenantId, numberId);
  }

  // Crea un nuevo número en el tenant y arranca su sesión Baileys.
  async addNumber(tenantId, { id, label }) {
    const store = this.tenants.get(tenantId);
    if (!store) throw new Error(`Tenant ${tenantId} no existe`);
    const safeId = String(id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 32);
    if (!safeId) throw new Error('id requerido (3-32 chars alfanum)');
    if (store.numbers.has(safeId)) throw new Error(`Número '${safeId}' ya existe`);
    const entry = store.addNumber({ id: safeId, label: label || safeId });
    if (!this.sessions.has(tenantId)) this.sessions.set(tenantId, new Map());
    const session = new WhatsAppSession(store, { numberId: entry.id, label: entry.label, authDir: entry.authDir });
    this.sessions.get(tenantId).set(entry.id, session);
    session.start().catch((e) => console.error(`[tenant ${tenantId}/${entry.id}] start fallo:`, e.message));
    return entry;
  }

  // Elimina un número: cierra sock, borra authDir, quita del store y de la sessions map.
  async removeNumber(tenantId, numberId) {
    const map = this.sessions.get(tenantId);
    const store = this.tenants.get(tenantId);
    const session = map?.get(numberId);
    if (session) {
      await session.stop().catch(() => {});
      map.delete(numberId);
    }
    if (store) await store.removeNumber(numberId);
  }

  list() {
    return Array.from(this.tenants.values()).map((t) => t.snapshot());
  }
}

export const tenants = new TenantRegistry();
