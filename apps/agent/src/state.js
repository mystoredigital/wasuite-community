import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

export const DATA_ROOT = path.resolve('./data');

/**
 * Escritura de JSON serializada por archivo y atómica.
 *
 * fs.writeFile NO es atómico ni está serializado: trunca y luego escribe. Dos
 * llamadas concurrentes al mismo archivo se entrelazan y dejan JSON corrupto.
 * Es alcanzable en producción: persistConversations() se dispara en CADA mensaje
 * entrante sin await, así que dos mensajes casi simultáneos pueden pisarse.
 *
 * Encolamos las escrituras por ruta y volcamos a un .tmp que luego renombramos:
 * rename(2) sí es atómico dentro del mismo sistema de archivos, así que el archivo
 * final nunca queda a medias, ni siquiera si el proceso muere a mitad de escritura.
 */
const _writeQueues = new Map();

function writeJsonAtomic(file, data) {
  const prev = _writeQueues.get(file) || Promise.resolve();
  const next = prev
    .catch(() => {}) // un fallo previo no debe romper la cadena
    .then(async () => {
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(data, null, 2));
      await fs.rename(tmp, file);
    });
  _writeQueues.set(file, next);
  next.catch(() => {}).finally(() => {
    if (_writeQueues.get(file) === next) _writeQueues.delete(file);
  });
  return next;
}

// Quita las claves undefined para que un merge con los valores por defecto no
// los pise con nada (el driver devuelve undefined en lo que no tiene fila).
function pruneUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

const DEFAULT_PROMPT = `Eres el agente de WhatsApp de ${process.env.BUSINESS_NAME || 'My Store Digital'}.

NEGOCIO: ${process.env.BUSINESS_DESCRIPTION || 'Agencia de automatización con IA.'}

TU ROL:
- Responder consultas con claridad, en español, tono cercano y profesional.
- Calificar al lead (qué necesita, presupuesto aproximado, urgencia).
- Si el cliente quiere reunirse, usa la herramienta list_availability para ver huecos libres y propone 2-3 opciones; luego usa book_appointment para confirmar.
- Si no sabes algo, dilo y ofrece que un humano lo conteste.

REGLAS:
- Mensajes cortos (máx 3-4 líneas), tipo chat de WhatsApp.
- No inventes precios. Si preguntan, indica que un humano confirmará el detalle.
- Zona horaria: ${process.env.TIMEZONE || 'America/Guayaquil'}.`;

export class TenantStore extends EventEmitter {
  // `driver` decide dónde vive el estado. null = JSON en disco, el camino de
  // siempre. Con un driver (ver state-pg.js) la lógica de negocio y los eventos
  // son exactamente los mismos: solo cambia el destino de las escrituras, que
  // además pasan a ser dirigidas en vez de volcar el archivo entero.
  constructor(tenantId, meta = {}, driver = null) {
    super();
    this.tenantId = tenantId;
    this.driver = driver;
    this.dir = path.join(DATA_ROOT, tenantId);
    this.authDir = path.join(this.dir, 'auth_baileys'); // legacy default
    this.convFile = path.join(this.dir, 'conversations.json');
    this.configFile = path.join(this.dir, 'config.json');
    this.metaFile = path.join(this.dir, 'meta.json');
    this.tokensFile = path.join(this.dir, 'tokens.json');
    this.contactsFile = path.join(this.dir, 'contacts.json');
    this.numbersFile = path.join(this.dir, 'numbers.json');
    this.numbersAuthRoot = path.join(this.dir, 'auth'); // para nuevos numberId
    this.phoneIndexFile = path.join(this.dir, 'phone-index.json');
    this.labFile = path.join(this.dir, 'lab-runs.json');

    this.conversations = new Map();
    // enabledGroups: lista explícita de JIDs @g.us que el operador habilitó.
    // Por defecto vacío → ningún grupo aparece (opt-in para evitar bandeja saturada).
    // kb: entradas Q&A estructuradas. knowledgeBase: bloque de texto libre (se
    // mantiene por compatibilidad y para datos que no son pregunta/respuesta).
    // Ambos se funden en renderKnowledgeBase() y se inyectan en el system prompt.
    this.config = { systemPrompt: DEFAULT_PROMPT, knowledgeBase: '', kb: [], aiEnabled: true, enabledGroups: [] };
    this.connection = { state: 'disconnected', qr: null }; // aggregate (default number) para retro-compat
    this.meta = { tenantId, kind: meta.kind || 'local', ...meta };
    this.ghl = null;
    this.jidByContactId = new Map();
    this.contactIdByJid = new Map();

    // Multi-número: cada entry es { id, label, authDir, connection: { state, qr } }
    this.numbers = new Map();
    // Routing outbound: jid → numberId del último mensaje recibido en/enviado por ese chat
    this.lastNumberByJid = new Map();
    // Dedup contactos: phone (E.164 con +) → JID canónico. Anti-duplicación cuando
    // el mismo contacto aparece bajo @lid (inbound) y @s.whatsapp.net (outbound del celular).
    this.phoneIndex = new Map();

    // Corridas del Laboratorio, de la más reciente a la más vieja.
    this.labRuns = [];
  }

  async load() {
    if (this.driver) return this.loadFromDriver();
    await fs.mkdir(this.dir, { recursive: true });
    try {
      const raw = await fs.readFile(this.convFile, 'utf8');
      let dirty = false;
      for (const [jid, conv] of Object.entries(JSON.parse(raw))) {
        if (conv?.name && jid.endsWith('@lid') && conv.name === jid.split('@')[0]) {
          delete conv.name;
          dirty = true;
        }
        // Backfill unread tracking en convs viejas: trata todo como leído al cargar
        // para no inundar WA con readMessages retroactivos.
        if (!('unreadCount' in conv)) { conv.unreadCount = 0; dirty = true; }
        if (Array.isArray(conv.messages)) {
          const lastTs = conv.messages[conv.messages.length - 1]?.ts || Date.now();
          for (const m of conv.messages) {
            if (m.role === 'user' && !('readAt' in m)) { m.readAt = lastTs; dirty = true; }
          }
        }
        this.conversations.set(jid, conv);
      }
      if (dirty) this.persistConversations().catch(() => {});
    } catch {}
    try {
      this.config = { ...this.config, ...JSON.parse(await fs.readFile(this.configFile, 'utf8')) };
    } catch {}
    try {
      this.meta = { ...this.meta, ...JSON.parse(await fs.readFile(this.metaFile, 'utf8')) };
    } catch {}
    try {
      this.ghl = JSON.parse(await fs.readFile(this.tokensFile, 'utf8'));
    } catch {}
    try {
      const map = JSON.parse(await fs.readFile(this.contactsFile, 'utf8'));
      for (const [contactId, jid] of Object.entries(map)) {
        this.jidByContactId.set(contactId, jid);
        this.contactIdByJid.set(jid, contactId);
      }
    } catch {}

    try {
      const raw = await fs.readFile(this.phoneIndexFile, 'utf8');
      for (const [phone, jid] of Object.entries(JSON.parse(raw))) {
        this.phoneIndex.set(phone, jid);
      }
    } catch {}

    try {
      const runs = JSON.parse(await fs.readFile(this.labFile, 'utf8'));
      if (Array.isArray(runs)) this.labRuns = runs;
    } catch {}
    // Una corrida marcada 'running' al cargar es una que murió con el proceso:
    // nadie la va a continuar. La marcamos interrumpida para no dejar el botón
    // del dashboard bloqueado para siempre.
    for (const r of this.labRuns) {
      if (r.status === 'running') {
        r.status = 'failed';
        r.error = 'la corrida se interrumpió al reiniciar el servidor';
        r.finishedAt = r.finishedAt || Date.now();
      }
    }

    // numbers.json: lista de números WhatsApp del tenant. Migración legacy:
    // si no existe pero hay `auth_baileys/` con creds, lo registramos como 'default'.
    try {
      const raw = await fs.readFile(this.numbersFile, 'utf8');
      const parsed = JSON.parse(raw);
      for (const n of (parsed.list || [])) {
        this.numbers.set(n.id, {
          id: n.id,
          label: n.label || n.id,
          authDir: path.isAbsolute(n.authDir) ? n.authDir : path.join(this.dir, n.authDir),
          authDirRel: n.authDir, // guardamos relativo para reserializar idéntico
          connection: { state: 'disconnected', qr: null },
        });
      }
      const lastByJid = parsed.lastNumberByJid || {};
      for (const [jid, nid] of Object.entries(lastByJid)) this.lastNumberByJid.set(jid, nid);
    } catch {
      if (fsSync.existsSync(this.authDir)) {
        // Tenant legacy con un único número → migrar automáticamente a 'default'
        this.numbers.set('default', {
          id: 'default', label: 'Principal',
          authDir: this.authDir, authDirRel: 'auth_baileys',
          connection: { state: 'disconnected', qr: null },
        });
        await this.persistNumbers().catch(() => {});
      }
    }
  }

  // Carga equivalente a load() pero desde el driver. El authDir sigue saliendo del
  // disco: la sesión de Baileys no está en la base todavía.
  async loadFromDriver() {
    await fs.mkdir(this.dir, { recursive: true });
    const s = await this.driver.load();

    this.conversations = s.conversations;
    this.config = { ...this.config, ...pruneUndefined(s.config) };
    this.phoneIndex = s.phoneIndex;
    this.jidByContactId = s.jidByContactId;
    for (const [contactId, jid] of this.jidByContactId) this.contactIdByJid.set(jid, contactId);
    this.labRuns = s.labRuns;
    this.ghl = s.ghl;
    this.lastNumberByJid = s.lastNumberByJid;

    for (const n of s.numbers) {
      const authDirRel = path.join('auth', n.id);
      this.numbers.set(n.id, {
        id: n.id,
        label: n.label,
        authDir: path.join(this.dir, authDirRel),
        authDirRel,
        connection: { state: 'disconnected', qr: null },
      });
    }

    // Misma regla que en el camino JSON: una corrida que quedó 'running' murió
    // con el proceso y nadie la va a continuar.
    for (const r of this.labRuns) {
      if (r.status === 'running') {
        r.status = 'failed';
        r.error = 'la corrida se interrumpió al reiniciar el servidor';
        r.finishedAt = r.finishedAt || Date.now();
      }
    }
  }

  async persistNumbers() {
    if (this.driver) {
      const defaultId = this.getDefaultNumberId();
      for (const n of this.numbers.values()) {
        await this.driver.saveNumber(n, { isDefault: n.id === defaultId });
      }
      return;
    }
    const list = Array.from(this.numbers.values()).map((n) => ({
      id: n.id, label: n.label, authDir: n.authDirRel,
    }));
    const data = {
      list,
      lastNumberByJid: Object.fromEntries(this.lastNumberByJid),
    };
    await writeJsonAtomic(this.numbersFile, data);
  }

  linkContact(contactId, jid) {
    if (!contactId || !jid) return;
    this.jidByContactId.set(contactId, jid);
    this.contactIdByJid.set(jid, contactId);
    // Con driver el vínculo ya vive en contact.wa_jid; no hay archivo que escribir.
    if (!this.driver) writeJsonAtomic(this.contactsFile, Object.fromEntries(this.jidByContactId)).catch(() => {});
  }

  // Devuelve el JID canónico (primero registrado) para un teléfono, o null si no se conoce.
  canonicalJidForPhone(phone) {
    if (!phone) return null;
    return this.phoneIndex.get(phone) || null;
  }

  // Búsqueda inversa: el teléfono conocido de un JID, o null. El índice guarda
  // phone→jid; es pequeño (un entry por contacto), el scan lineal no duele.
  // Lo usa el espejo al CRM: los JID @lid ocultan el número, pero si el contacto
  // ya escribió antes, su teléfono quedó registrado aquí.
  phoneForJid(jid) {
    if (!jid) return null;
    for (const [phone, j] of this.phoneIndex) {
      if (j === jid) return phone;
    }
    // JID clásico: el número viene en el propio identificador.
    const m = jid.match(/^(\d{7,15})@s\.whatsapp\.net$/);
    return m ? `+${m[1]}` : null;
  }

  // Registra un teléfono→jid. Si ya existe un canónico para ese phone y es distinto,
  // NO sobreescribe (preserva el primero visto). El operador puede combinar manualmente.
  registerPhone(jid, phone) {
    if (!phone || !jid) return;
    const existing = this.phoneIndex.get(phone);
    if (existing === jid) return;
    if (existing && existing !== jid) {
      console.warn(`[phoneIndex:${this.tenantId}] ${phone} ya mapeado a ${existing}, nuevo intento: ${jid} (ignorado — usa merge para deduplicar)`);
      return;
    }
    this.phoneIndex.set(phone, jid);
    if (this.driver) this.driver.registerPhone(jid, phone).catch(() => {});
    else writeJsonAtomic(this.phoneIndexFile, Object.fromEntries(this.phoneIndex)).catch(() => {});
  }

  // Combina dos conversaciones del mismo contacto. Une mensajes ordenados por ts,
  // mantiene el conv destino, elimina el origen. Redirige contactIdByJid y phoneIndex.
  // Pensado para limpiar duplicados que aparecen cuando WhatsApp da JIDs distintos
  // al mismo número (típico con @lid vs @s.whatsapp.net).
  async mergeConversations(fromJid, toJid) {
    if (!fromJid || !toJid) throw new Error('fromJid y toJid requeridos');
    if (fromJid === toJid) throw new Error('jids iguales — nada que combinar');
    const from = this.conversations.get(fromJid);
    const to = this.conversations.get(toJid);
    if (!from) throw new Error(`conv ${fromJid} no existe`);
    if (!to) throw new Error(`conv ${toJid} no existe`);
    if (from.isGroup !== to.isGroup) throw new Error('no se pueden combinar grupo + 1:1');

    const merged = [...to.messages, ...from.messages].sort((a, b) => (a.ts || 0) - (b.ts || 0));
    to.messages = merged.length > 200 ? merged.slice(-200) : merged;
    to.updatedAt = Date.now();
    // Adoptar nombre real si el destino tiene un fallback feo
    const toHasRealName = to.name && !/^\+?\d{6,}$/.test(to.name);
    const fromHasRealName = from.name && !/^\+?\d{6,}$/.test(from.name);
    if (!toHasRealName && fromHasRealName) to.name = from.name;
    // Si el origen estaba en modo humano, propagar (más conservador)
    if (from.mode === 'human') to.mode = 'human';

    // Redirigir contactIdByJid
    for (const [cid, j] of [...this.jidByContactId.entries()]) {
      if (j === fromJid) {
        this.jidByContactId.set(cid, toJid);
        this.contactIdByJid.delete(fromJid);
        this.contactIdByJid.set(toJid, cid);
      }
    }
    // Redirigir lastNumberByJid si el origen tiene asignación
    if (this.lastNumberByJid.has(fromJid) && !this.lastNumberByJid.has(toJid)) {
      this.lastNumberByJid.set(toJid, this.lastNumberByJid.get(fromJid));
    }
    this.lastNumberByJid.delete(fromJid);
    // Redirigir phoneIndex: cualquier phone que apunte a fromJid → toJid
    for (const [phone, j] of [...this.phoneIndex.entries()]) {
      if (j === fromJid) this.phoneIndex.set(phone, toJid);
    }

    this.conversations.delete(fromJid);

    if (this.driver) {
      // El driver lo resuelve en una transacción: mover mensajes, mudar el
      // teléfono y borrar el contacto de origen tiene que pasar entero o nada.
      await this.driver.mergeConversations(fromJid, toJid).catch(() => {});
      await this.driver.saveConversation(toJid, to, { numberId: this.lastNumberByJid.get(toJid) || null }).catch(() => {});
    } else {
      await this.persistConversations().catch(() => {});
      await writeJsonAtomic(this.contactsFile, Object.fromEntries(this.jidByContactId)).catch(() => {});
      await this.persistNumbers().catch(() => {});
      await writeJsonAtomic(this.phoneIndexFile, Object.fromEntries(this.phoneIndex)).catch(() => {});
    }

    this.emit('message', { tenantId: this.tenantId, jid: toJid, conversation: to });
    this.emit('conv:removed', { tenantId: this.tenantId, jid: fromJid, mergedInto: toJid });
    return to;
  }

  getJidByContactId(contactId) {
    return this.jidByContactId.get(contactId);
  }

  getContactIdByJid(jid) {
    return this.contactIdByJid.get(jid);
  }

  // Con driver no hay volcado global: cada mutación ya escribió su fila. Se
  // mantiene el método porque medio agente lo llama sin await.
  async persistConversations(jid = null) {
    if (this.driver) {
      if (!jid) return;
      const conv = this.conversations.get(jid);
      if (conv) await this.driver.saveConversation(jid, conv, { numberId: this.lastNumberByJid.get(jid) || null });
      return;
    }
    await writeJsonAtomic(this.convFile, Object.fromEntries(this.conversations));
  }
  async persistConfig() {
    if (this.driver) return this.driver.saveConfig(this.config);
    await writeJsonAtomic(this.configFile, this.config);
  }
  async persistMeta() {
    await writeJsonAtomic(this.metaFile, this.meta);
  }
  async persistTokens() {
    if (!this.ghl) return;
    await writeJsonAtomic(this.tokensFile, this.ghl);
  }

  getOrCreateConversation(jid, name) {
    if (!this.conversations.has(jid)) {
      const isGroup = jid.endsWith('@g.us');
      const fallback = jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0] : null;
      this.conversations.set(jid, {
        jid, name: name || fallback,
        isGroup,
        // Grupos arrancan en modo humano para evitar que la IA conteste a todo en
        // chats grupales. El operador puede flipear a IA per-grupo si quiere.
        mode: isGroup ? 'human' : 'ai',
        messages: [], updatedAt: Date.now(),
        unreadCount: 0,
      });
    } else if (name && name.trim()) {
      const conv = this.conversations.get(jid);
      const current = (conv.name || '').trim();
      // Upgradear nombre cuando el actual es placeholder (vacío o solo dígitos / +números)
      // y nos llega un pushName real. No tocamos si ya hay un nombre legible.
      const looksLikePhone = /^\+?\d{6,}$/.test(current);
      if (!current || looksLikePhone) {
        conv.name = name;
      }
    }
    return this.conversations.get(jid);
  }

  setGroupName(jid, groupName) {
    const conv = this.conversations.get(jid);
    if (!conv) return;
    if (conv.name !== groupName) {
      conv.name = groupName;
      this.persistConversations(jid).catch(() => {});
    }
  }

  // Renombra un chat 1:1 desde una fuente autoritativa (el CRM). A diferencia de
  // getOrCreateConversation, pisa el nombre aunque ya sea legible: si en el CRM
  // editaron el contacto, ese nombre gana sobre el pushName de WhatsApp.
  setContactName(jid, name) {
    const clean = (name || '').trim();
    if (!clean) return false;
    const conv = this.conversations.get(jid);
    if (!conv || conv.isGroup) return false;
    if (conv.name === clean) return false;
    conv.name = clean;
    this.persistConversations(jid).catch(() => {});
    this.emit('message', { tenantId: this.tenantId, jid, conversation: conv });
    return true;
  }

  addMessage(jid, msg, name) {
    const conv = this.getOrCreateConversation(jid, name);
    const stored = { ...msg, ts: msg.ts || Date.now() };
    conv.messages.push(stored);
    // El tope recorta solo la copia en memoria. Con driver el historial completo
    // queda en la base: el CRM lo necesita entero, y este límite existía para que
    // el JSON de conversaciones no creciera sin freno.
    if (conv.messages.length > 200) conv.messages = conv.messages.slice(-200);
    conv.updatedAt = Date.now();
    // Solo los mensajes entrantes del contacto cuentan como "no leídos".
    // Mensajes assistant/manual/system son del operador o del sistema → ya están "leídos".
    if (msg.role === 'user') conv.unreadCount = (conv.unreadCount || 0) + 1;
    if (this.driver) this.driver.appendMessage(jid, conv, stored).catch(() => {});
    else this.persistConversations().catch(() => {});
    this.emit('message', { tenantId: this.tenantId, jid, message: msg, conversation: conv });
    return conv;
  }

  // Marca como leídos todos los mensajes user pendientes en la conv. Devuelve
  // los que cambiaron (con sus claves originales en cached protos, si están)
  // para que el caller pueda propagar a WA + GHL.
  markConversationRead(jid) {
    const conv = this.conversations.get(jid);
    if (!conv) return null;
    const now = Date.now();
    const newlyRead = [];
    for (const m of conv.messages) {
      if (m.role === 'user' && !m.readAt) {
        m.readAt = now;
        newlyRead.push(m);
      }
    }
    const wasUnread = (conv.unreadCount || 0) > 0;
    conv.unreadCount = 0;
    if (newlyRead.length || wasUnread) {
      if (this.driver) this.driver.markRead(jid, now).catch(() => {});
      else this.persistConversations(jid).catch(() => {});
      this.emit('read', { tenantId: this.tenantId, jid, conversation: conv, count: newlyRead.length });
    }
    return { conv, newlyRead };
  }

  // Aplica un patch a un mensaje específico (busca por m.id). Usado para añadir
  // metadata después de creado, como el ghlMessageId que llega async tras pushear.
  updateMessageMeta(jid, localId, patch) {
    const conv = this.conversations.get(jid);
    if (!conv || !localId) return false;
    const m = conv.messages.find((mm) => mm.id === localId);
    if (!m) return false;
    Object.assign(m, patch);
    // ghlConversationId también lo memorizamos a nivel conv para acceso rápido
    // en markRead (no tener que escanear mensajes cada vez).
    if (patch.ghlConversationId && !conv.ghlConversationId) {
      conv.ghlConversationId = patch.ghlConversationId;
    }
    if (this.driver) this.driver.updateMessageMeta(jid, localId, patch).catch(() => {});
    else this.persistConversations(jid).catch(() => {});
    return true;
  }

  // Busca un mensaje por su ghlMessageId. Útil para la dirección GHL → app
  // cuando llega un evento de read y necesitamos resolver a qué jid pertenece.
  findConvByGhlMessageId(ghlMessageId) {
    if (!ghlMessageId) return null;
    for (const conv of this.conversations.values()) {
      const m = conv.messages.find((mm) => mm.ghlMessageId === ghlMessageId);
      if (m) return { conv, message: m };
    }
    return null;
  }

  // reason: por qué el chat quedó en manos de un humano. Sin esto el operador ve
  // un chat en modo HUMANO y no sabe si lo pausó él, si el cliente pidió una
  // persona o si la IA se declaró incompetente.
  //   operador · takeover · cliente · modelo · ghl · greylist
  setMode(jid, mode, reason = null) {
    const conv = this.getOrCreateConversation(jid);
    conv.mode = mode === 'human' ? 'human' : 'ai';
    if (conv.mode === 'human') {
      conv.handoffAt = Date.now();
      conv.handoffReason = reason || 'operador';
    } else {
      // Volver a IA cierra el handoff: el motivo viejo ya no describe el estado.
      delete conv.handoffAt;
      delete conv.handoffReason;
    }
    this.persistConversations(jid).catch(() => {});
    this.emit('mode', {
      tenantId: this.tenantId, jid, mode: conv.mode,
      handoffReason: conv.handoffReason || null,
      handoffAt: conv.handoffAt || null,
    });
    return conv;
  }

  setPrompt(prompt) {
    this.config.systemPrompt = prompt;
    this.persistConfig().catch(() => {});
    this.emit('config', { tenantId: this.tenantId, config: this.config });
  }

  setKnowledgeBase(kb) {
    this.config.knowledgeBase = typeof kb === 'string' ? kb : '';
    this.persistConfig().catch(() => {});
    this.emit('config', { tenantId: this.tenantId, config: this.config });
  }

  // ─── Base de conocimiento estructurada (Q&A) ────────────────────────────────
  // Un textarea gigante no se puede corregir con precisión: el Laboratorio necesita
  // poder decir "falta esta pregunta" y añadirla sola. Por eso las Q&A son entradas
  // con id propio, y el texto libre queda para lo que no es pregunta/respuesta.

  listKb() {
    return Array.isArray(this.config.kb) ? this.config.kb : [];
  }

  addKbEntry({ q, a, source = 'manual' }) {
    const question = (q || '').trim();
    const answer = (a || '').trim();
    if (!question || !answer) throw new Error('pregunta y respuesta requeridas');
    const entry = {
      id: randomUUID(),
      q: question,
      a: answer,
      source, // manual | lab — de dónde salió la entrada
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.config.kb = [...this.listKb(), entry];
    if (this.driver) this.driver.saveKbEntry(entry).catch(() => {});
    else this.persistConfig().catch(() => {});
    this.emit('config', { tenantId: this.tenantId, config: this.config });
    return entry;
  }

  updateKbEntry(id, { q, a }) {
    const entry = this.listKb().find((e) => e.id === id);
    if (!entry) throw new Error(`entrada ${id} no existe`);
    if (typeof q === 'string' && q.trim()) entry.q = q.trim();
    if (typeof a === 'string' && a.trim()) entry.a = a.trim();
    entry.updatedAt = Date.now();
    if (this.driver) this.driver.saveKbEntry(entry).catch(() => {});
    else this.persistConfig().catch(() => {});
    this.emit('config', { tenantId: this.tenantId, config: this.config });
    return entry;
  }

  deleteKbEntry(id) {
    const before = this.listKb().length;
    this.config.kb = this.listKb().filter((e) => e.id !== id);
    if (this.config.kb.length === before) return false;
    if (this.driver) this.driver.deleteKbEntry(id).catch(() => {});
    else this.persistConfig().catch(() => {});
    this.emit('config', { tenantId: this.tenantId, config: this.config });
    return true;
  }

  /**
   * Funde las Q&A y el texto libre en el bloque que ve el LLM.
   * Es la ÚNICA fuente de la base de conocimiento: si algo no sale de aquí, el
   * agente no lo sabe.
   */
  renderKnowledgeBase() {
    const parts = [];
    const entries = this.listKb();
    if (entries.length) {
      parts.push(entries.map((e) => `P: ${e.q}\nR: ${e.a}`).join('\n\n'));
    }
    const free = (this.config.knowledgeBase || '').trim();
    if (free) parts.push(free);
    return parts.join('\n\n');
  }

  // ─── Laboratorio ────────────────────────────────────────────────────────────

  persistLab() {
    return writeJsonAtomic(this.labFile, this.labRuns);
  }

  listLabRuns() {
    return this.labRuns;
  }

  getLabRun(id) {
    return this.labRuns.find((r) => r.id === id) || null;
  }

  addLabRun(run, maxKept = 20) {
    this.labRuns.unshift(run);
    if (this.labRuns.length > maxKept) this.labRuns = this.labRuns.slice(0, maxKept);
    if (this.driver) this.driver.saveLabRun(run).catch(() => {});
    else this.persistLab().catch(() => {});
    this.emit('lab', { tenantId: this.tenantId, run });
  }

  updateLabRun(run) {
    const i = this.labRuns.findIndex((r) => r.id === run.id);
    if (i === -1) return;
    this.labRuns[i] = run;
    if (this.driver) this.driver.saveLabRun(run).catch(() => {});
    else this.persistLab().catch(() => {});
    this.emit('lab', { tenantId: this.tenantId, run });
  }

  setAiEnabled(enabled) {
    this.config.aiEnabled = !!enabled;
    this.persistConfig().catch(() => {});
    this.emit('config', { tenantId: this.tenantId, config: this.config });
  }

  isGroupEnabled(jid) {
    return Array.isArray(this.config.enabledGroups) && this.config.enabledGroups.includes(jid);
  }

  setGroupEnabled(jid, enabled) {
    const current = Array.isArray(this.config.enabledGroups) ? this.config.enabledGroups : [];
    const set = new Set(current);
    if (enabled) set.add(jid); else set.delete(jid);
    this.config.enabledGroups = Array.from(set);
    if (this.driver) this.driver.setGroupEnabled(jid, enabled).catch(() => {});
    else this.persistConfig().catch(() => {});
    this.emit('config', { tenantId: this.tenantId, config: this.config });
  }

  // LEGACY: actualiza `this.connection` (aggregate) sin numberId. Se mantiene por
  // si algún path antiguo lo llama; preferir setNumberConnection.
  setConnection(state, qr = null) {
    this.connection = { state, qr };
    this.emit('connection', { tenantId: this.tenantId, connection: this.connection });
  }

  // Actualiza el estado de conexión de un número específico. Si es el número default
  // también espeja el resultado en `this.connection` (compat con dashboard legacy).
  setNumberConnection(numberId, state, qr = null) {
    const n = this.numbers.get(numberId);
    if (n) n.connection = { state, qr };
    const defaultId = this.getDefaultNumberId();
    if (numberId === defaultId) this.connection = { state, qr };
    if (this.driver) this.driver.setNumberConnection(numberId, state).catch(() => {});
    this.emit('connection', {
      tenantId: this.tenantId, numberId,
      connection: { state, qr },
      // aggregate para clientes legacy:
      aggregate: this.connection,
    });
  }

  getDefaultNumberId() {
    return this.numbers.size ? this.numbers.keys().next().value : null;
  }

  listNumbers() {
    return Array.from(this.numbers.values()).map((n) => ({
      id: n.id, label: n.label,
      connection: n.connection,
    }));
  }

  addNumber({ id, label }) {
    if (this.numbers.has(id)) throw new Error(`Número '${id}' ya existe`);
    const authDirRel = path.join('auth', id);
    const authDir = path.join(this.dir, authDirRel);
    const entry = {
      id, label: label || id, authDir, authDirRel,
      connection: { state: 'disconnected', qr: null },
    };
    this.numbers.set(id, entry);
    this.persistNumbers().catch(() => {});
    return entry;
  }

  async removeNumber(id) {
    const n = this.numbers.get(id);
    if (!n) return;
    this.numbers.delete(id);
    // Limpiar lastNumberByJid de entries que apuntan a este número
    for (const [jid, nid] of this.lastNumberByJid.entries()) {
      if (nid === id) this.lastNumberByJid.delete(jid);
    }
    await this.persistNumbers().catch(() => {});
    // Borrar el authDir si está dentro del tenant (defensive — no tocar absolutos extraños)
    if (n.authDir && n.authDir.startsWith(this.dir)) {
      await fs.rm(n.authDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  noteNumberForJid(jid, numberId) {
    if (!jid || !numberId) return;
    const current = this.lastNumberByJid.get(jid);
    if (current === numberId) return;
    this.lastNumberByJid.set(jid, numberId);
    if (this.driver) this.driver.noteNumberForJid(jid, numberId).catch(() => {});
    else this.persistNumbers().catch(() => {});
  }

  getNumberForJid(jid) {
    return this.lastNumberByJid.get(jid) || this.getDefaultNumberId();
  }

  setGhlTokens(tokens) {
    this.ghl = { ...(this.ghl || {}), ...tokens };
    this.persistTokens().catch(() => {});
  }

  snapshot() {
    return {
      tenantId: this.tenantId,
      meta: this.meta,
      conversations: Array.from(this.conversations.values()).sort((a, b) => b.updatedAt - a.updatedAt),
      config: this.config,
      connection: this.connection, // aggregate (default number) — retro-compat
      numbers: this.listNumbers(),
      ghl: this.ghl ? {
        locationId: this.ghl.locationId,
        companyId: this.ghl.companyId,
        hasToken: true,
        conversationProviderId: this.ghl.conversationProviderId || null,
      } : null,
    };
  }
}

// Migra layout legacy (data/auth_baileys, data/conversations.json) a data/_local/
export async function migrateLegacyIfNeeded() {
  const legacyAuth = path.join(DATA_ROOT, 'auth_baileys');
  const legacyConv = path.join(DATA_ROOT, 'conversations.json');
  const legacyConfig = path.join(DATA_ROOT, 'config.json');
  const localDir = path.join(DATA_ROOT, '_local');

  if (!fsSync.existsSync(legacyAuth) && !fsSync.existsSync(legacyConv)) return false;
  if (fsSync.existsSync(localDir)) return false;

  await fs.mkdir(localDir, { recursive: true });
  if (fsSync.existsSync(legacyAuth)) await fs.rename(legacyAuth, path.join(localDir, 'auth_baileys'));
  if (fsSync.existsSync(legacyConv)) await fs.rename(legacyConv, path.join(localDir, 'conversations.json'));
  if (fsSync.existsSync(legacyConfig)) await fs.rename(legacyConfig, path.join(localDir, 'config.json'));
  console.log('[migration] data/ legacy → data/_local/');
  return true;
}
