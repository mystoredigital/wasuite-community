import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  MEDIA_PATH_MAP,
} from 'baileys';
import { Boom } from '@hapi/boom';

// WORKAROUND audio "no disponible": el endpoint de subida /mms/audio rechaza
// (o sirve corrupto) el media para ciertas cuentas de WhatsApp — el receptor
// ve "Este audio ya no está disponible" al reproducir, aunque la duración y la
// onda lleguen. Comprobado empíricamente: /mms/image y /mms/document funcionan
// perfecto a la misma cuenta; solo /mms/audio falla. La ruta de SUBIDA y el
// TIPO de mensaje son independientes: subimos el audio cifrado por /mms/document
// (que sí sirve) y lo mandamos igual como audioMessage/PTT, así el receptor lo
// ve como burbuja de voz normal. Baileys lee MEDIA_PATH_MAP[mediaType] en el
// momento del upload, así que mutarlo acá basta. No afecta descargas (usan el
// directPath del mensaje recibido) ni otros tipos de media.
// Desactivable con AUDIO_UPLOAD_VIA_DOCUMENT=false por si una cuenta sí soporta
// /mms/audio y se prefiere el canal nativo.
if (process.env.AUDIO_UPLOAD_VIA_DOCUMENT !== 'false') {
  MEDIA_PATH_MAP.audio = MEDIA_PATH_MAP.document; // '/mms/document'
}
import pino from 'pino';
import qrcode from 'qrcode';
import fs from 'node:fs/promises';
import { generateReply, summarizeConversation, detectHumanRequest, splitHandoff } from './ai.js';
import { GHLClient } from './ghl/client.js';
import { resolvePhoneAndJid, jidToPhone } from './ghl/phone.js';
import { uploadBufferToR2, downloadUrlToBuffer, mimeToWa, isMediaConfigured } from './media.js';
import { transcribeAudio, isWhisperConfigured } from './whisper.js';
import { dispatch as dispatchWebhook } from './webhooks.js';
import { syncContact as syncContactToCRM, enrichContact as enrichContactInCRM, isConfigured as isCRMConfigured } from './crm.js';
import { pushMessageToCrm, crmLocalConfigured } from './crmLocal.js';
import { notificar, resumen } from './push.js';

const logger = pino({ level: 'warn' });

// Anti-ban / human-like behavior config (overridable via env)
const HUMAN_DELAY_MIN_MS = Number(process.env.HUMAN_DELAY_MIN_MS ?? 3000);
const HUMAN_DELAY_MAX_MS = Number(process.env.HUMAN_DELAY_MAX_MS ?? 12000);
const PER_CHAT_COOLDOWN_MS = Number(process.env.PER_CHAT_COOLDOWN_MS ?? 4000);
const GLOBAL_MAX_PER_MIN = Number(process.env.GLOBAL_MAX_PER_MIN ?? 20);
const QUIET_HOURS_START = Number(process.env.QUIET_HOURS_START ?? 23);
const QUIET_HOURS_END = Number(process.env.QUIET_HOURS_END ?? 7);
const QUIET_HOURS_TZ = process.env.TIMEZONE || 'America/Guayaquil';
const NEW_CONTACT_REQUIRES_HUMAN = (process.env.NEW_CONTACT_REQUIRES_HUMAN || 'false') === 'true';

// Interruptor del escalado automático. Arranca APAGADO a propósito: encenderlo
// cambia cómo se porta el bot de cara al cliente (al escalar, la IA deja de
// responder en ese chat), y con la base de conocimiento vacía el agente no puede
// responder casi nada y escalaría de más. Enciéndelo (AUTO_HANDOFF=true) cuando
// la KB esté cargada — el Laboratorio te dice si estás listo.
// Apagado, el bot se porta exactamente como antes. El toggle manual por chat y el
// takeover desde el dashboard funcionan igual en ambos casos.
const AUTO_HANDOFF = process.env.AUTO_HANDOFF === 'true';

// Acuse que se manda cuando el cliente pide un humano. Dejarlo vacío escala en
// silencio (el chat pasa a HUMANO pero no se le contesta nada al cliente).
const HANDOFF_ACK_TEXT = process.env.HANDOFF_ACK_TEXT
  ?? 'Claro, en un momento te atiende un compañero del equipo 👍';

// Cómo se cuenta el motivo del handoff en la notificación. Los códigos internos
// ('greylist', 'modelo') no le dicen nada a quien lee el aviso en el teléfono.
const MOTIVO_HANDOFF = {
  cliente: 'El cliente pidió hablar con una persona',
  modelo: 'La IA no supo responder',
  takeover: 'Un operador tomó el chat',
  greylist: 'Contacto nuevo sin atender por IA',
  operador: 'Pasado a humano manualmente',
  ghl: 'Respondieron desde el CRM',
};

const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 60_000;

// URL pública del dashboard — se usa para el link "Abrir chat" que la sync
// escribe en cada contacto de Twenty (deep-link ?chat=<jid>). Sin default: cada
// instalación define la suya en el .env.
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const chatDeepLink = (jid) => `${PUBLIC_URL}/?chat=${encodeURIComponent(jid)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function jitter(min, max) {
  return Math.floor(min + Math.random() * Math.max(0, max - min));
}

// Saca un correo del texto de un mensaje para enriquecer la ficha del CRM.
// A propósito es un regex y no una llamada a la IA: el email es un patrón duro,
// así no cuesta tokens, no se lo puede inventar, y funciona igual con la IA
// apagada o el chat en modo humano. El TLD no captura el punto final de la
// frase ("escríbeme a juan@acme.com." → juan@acme.com) porque el motor
// retrocede hasta que \.[A-Za-z]{2,} cuadra.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
function extractEmail(text) {
  const match = EMAIL_RE.exec(String(text || ''));
  return match ? match[0].toLowerCase() : null;
}

function isInQuietHours(now = new Date()) {
  if (QUIET_HOURS_START === QUIET_HOURS_END) return false;
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: QUIET_HOURS_TZ }).format(now)
  );
  return QUIET_HOURS_START < QUIET_HOURS_END
    ? hour >= QUIET_HOURS_START && hour < QUIET_HOURS_END
    : hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;
}

class RateLimiter {
  constructor() {
    this._lastByJid = new Map();
    this._window = [];
  }
  check(jid) {
    const now = Date.now();
    this._window = this._window.filter((t) => now - t < 60_000);
    const last = this._lastByJid.get(jid) || 0;
    const sinceLast = now - last;
    if (sinceLast < PER_CHAT_COOLDOWN_MS) {
      return { ok: false, reason: 'per-chat cooldown', retryAfterMs: PER_CHAT_COOLDOWN_MS - sinceLast };
    }
    if (this._window.length >= GLOBAL_MAX_PER_MIN) {
      const oldest = this._window[0];
      return { ok: false, reason: 'global rate limit', retryAfterMs: Math.max(1000, 60_000 - (now - oldest)) };
    }
    return { ok: true };
  }
  record(jid) {
    const now = Date.now();
    this._lastByJid.set(jid, now);
    this._window.push(now);
  }
  // Snapshot del estado actual del limiter para exponer en /api/state o /api/numbers.
  // No es exhaustivo (per-chat cooldown varia por jid) — solo agregado global util.
  snapshot() {
    const now = Date.now();
    const recent = this._window.filter((t) => now - t < 60_000);
    return {
      perChatCooldownMs: PER_CHAT_COOLDOWN_MS,
      globalMaxPerMin: GLOBAL_MAX_PER_MIN,
      windowCount: recent.length,
      windowRemaining: Math.max(0, GLOBAL_MAX_PER_MIN - recent.length),
    };
  }
}

// Desenvuelve wrappers comunes: ephemeralMessage, viewOnceMessage(V2),
// documentWithCaptionMessage, editedMessage. Recursivo para casos anidados.
function unwrapMessage(message) {
  if (!message) return message;
  const wrappers = [
    'ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension',
    'documentWithCaptionMessage', 'editedMessage', 'messageContextInfo',
  ];
  for (const w of wrappers) {
    if (message[w]?.message) return unwrapMessage(message[w].message);
  }
  return message;
}

function extractText(rawMessage) {
  const message = unwrapMessage(rawMessage);
  if (!message) return '';

  // 1) Texto plano y captions clásicos
  const classic =
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    '';
  if (classic) return classic;

  // 2) Mensajes con botones (bots viejos: "Tu código es 8432 [Verificar]")
  //    Concatenamos contentText + footerText cuando ambos existen.
  if (message.buttonsMessage) {
    const b = message.buttonsMessage;
    const parts = [b.contentText, b.footerText].filter(Boolean);
    if (parts.length) return parts.join('\n');
  }

  // 3) Listas con menú de opciones (bots con submenús)
  if (message.listMessage) {
    const l = message.listMessage;
    const parts = [l.description || l.title, l.footerText].filter(Boolean);
    if (parts.length) return parts.join('\n');
  }

  // 4) Plantillas (WhatsApp Business / templates pre-aprobados)
  if (message.templateMessage?.hydratedTemplate) {
    const t = message.templateMessage.hydratedTemplate;
    const body = t.hydratedContentText || t.hydratedTitleText || '';
    const footer = t.hydratedFooterText || '';
    const combined = [body, footer].filter(Boolean).join('\n');
    if (combined) return combined;
  }

  // 5) Interactive (WhatsApp Cloud API moderno: 2024+). Estructura nueva
  //    con body/header/footer tipados. Los bots de verificación nuevos
  //    suelen usar esto.
  if (message.interactiveMessage) {
    const i = message.interactiveMessage;
    const parts = [
      i.header?.title,
      i.body?.text,
      i.footer?.text,
    ].filter(Boolean);
    if (parts.length) return parts.join('\n');
  }

  // 6) Respuestas a botones / listas (cuando el contacto toca un botón).
  //    El bot recibe selectedDisplayText / selectedButtonId; el operador
  //    debería ver al menos el texto que el contacto eligió.
  if (message.buttonsResponseMessage?.selectedDisplayText) {
    return message.buttonsResponseMessage.selectedDisplayText;
  }
  if (message.templateButtonReplyMessage?.selectedDisplayText) {
    return message.templateButtonReplyMessage.selectedDisplayText;
  }
  if (message.listResponseMessage?.title) {
    const r = message.listResponseMessage;
    return [r.title, r.singleSelectReply?.selectedRowId].filter(Boolean).join(' · ');
  }

  return '';
}

// Detecta si el mensaje cita a otro (reply). Devuelve null si no hay quote.
// La info viene en <tipo>.contextInfo.quotedMessage para cada tipo de mensaje.
function extractQuotedInfo(rawMessage) {
  const m = unwrapMessage(rawMessage);
  if (!m) return null;
  const ctx =
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    m.audioMessage?.contextInfo ||
    m.documentMessage?.contextInfo ||
    m.stickerMessage?.contextInfo;
  if (!ctx?.quotedMessage) return null;
  const quotedText = extractText(ctx.quotedMessage);
  const quotedMedia = extractMediaInfo(ctx.quotedMessage);
  return {
    stanzaId: ctx.stanzaId || null,
    participant: ctx.participant || null, // jid del autor original
    text: quotedText || '',
    mediaType: quotedMedia?.type || null,
  };
}

// Detecta media en un message proto (manejando wrappers). Devuelve null si no hay.
function extractMediaInfo(rawMessage) {
  const message = unwrapMessage(rawMessage);
  if (!message) return null;
  if (message.imageMessage)
    return { type: 'image', mimetype: message.imageMessage.mimetype || 'image/jpeg' };
  if (message.videoMessage)
    return { type: 'video', mimetype: message.videoMessage.mimetype || 'video/mp4' };
  if (message.audioMessage)
    return {
      type: message.audioMessage.ptt ? 'voice' : 'audio',
      mimetype: message.audioMessage.mimetype || 'audio/ogg',
      ptt: !!message.audioMessage.ptt,
      seconds: message.audioMessage.seconds,
    };
  if (message.documentMessage)
    return {
      type: 'document',
      mimetype: message.documentMessage.mimetype || 'application/octet-stream',
      fileName: message.documentMessage.fileName,
    };
  if (message.stickerMessage)
    return { type: 'sticker', mimetype: message.stickerMessage.mimetype || 'image/webp' };
  return null;
}

export class WhatsAppSession {
  constructor(store, { numberId = 'default', label = 'Principal', authDir = null } = {}) {
    this.store = store;
    this.numberId = numberId;
    this.label = label;
    // authDir explícito (multi-número) — si no se pasa, fallback al legacy
    this.authDir = authDir || store.authDir;
    this.sock = null;
    this._reconnectTimer = null;
    this._reconnectAttempt = 0;
    this._outboundSeen = new Set();
    this._sentByUs = new Set();
    this._limiter = new RateLimiter();
    this._groupNameCache = new Map();
    // Cache de protos {key, message} indexado por stanzaId — Baileys necesita el
    // proto original para construir un quote (sendMessage({ quoted })). LRU bounded.
    this._msgCache = new Map();
    this._msgCacheMax = 300;
    // Cache de contexto de contacto GHL (tags/empresa/origen) por contactId.
    // Evita pegarle a la API de GHL en cada respuesta de la IA. TTL 5 min.
    this._ghlContactCache = new Map();
    this.metrics = {
      sent: 0,             // mensajes enviados por la IA (retro-compat — pintado como "IA" en el header)
      manual: 0,           // mensajes enviados manualmente desde el dashboard
      received: 0,         // mensajes recibidos (1:1 y grupos habilitados)
      skippedRateLimit: 0,
      skippedQuietHours: 0,
      skippedGreylist: 0,
      skippedAiDisabled: 0,
      handoffs: 0,         // veces que un chat pasó a humano automáticamente
      reconnects: 0,
      connectedAt: null,   // epoch ms del último connection.open (null si desconectado)
      lastActivityAt: null, // epoch ms del último mensaje enviado o recibido
    };
  }

  // Prefijo de logs para distinguir números dentro de un mismo tenant
  get _tag() {
    return `${this.store.tenantId}/${this.numberId}`;
  }

  getMetrics() {
    return { ...this.metrics, limiter: this._limiter?.snapshot() || null };
  }

  // Lanza un error con status=429 si la siguiente acción rebasaria el limiter.
  // Los handlers HTTP lo capturan y devuelven 429 + Retry-After.
  _enforceLimit(jid) {
    const check = this._limiter.check(jid);
    if (check.ok) return;
    const err = new Error(`rate limited: ${check.reason}`);
    err.status = 429;
    err.retryAfterMs = check.retryAfterMs || 1000;
    err.reason = check.reason;
    throw err;
  }

  _emitMetrics() {
    this.store.emit('metrics', { tenantId: this.store.tenantId, numberId: this.numberId, metrics: this.getMetrics() });
  }

  _bump(key) {
    if (!(key in this.metrics)) return;
    this.metrics[key]++;
    this._emitMetrics();
  }

  _setMetric(key, value) {
    if (!(key in this.metrics)) return;
    this.metrics[key] = value;
    this._emitMetrics();
  }

  _touchActivity() {
    this.metrics.lastActivityAt = Date.now();
    this._emitMetrics();
  }

  // Devuelve el nombre del grupo (subject). Cachea 1h. Retorna jid si la query falla.
  async _getGroupName(jid) {
    const cached = this._groupNameCache.get(jid);
    if (cached && Date.now() - cached.ts < 60 * 60_000) return cached.name;
    try {
      const md = await this.sock.groupMetadata(jid);
      const name = md?.subject || jid;
      this._groupNameCache.set(jid, { name, ts: Date.now() });
      return name;
    } catch (e) {
      console.warn(`[wa:${this.store.tenantId}] groupMetadata ${jid} falló:`, e.message);
      this._groupNameCache.set(jid, { name: jid, ts: Date.now() });
      return jid;
    }
  }

  _rememberSentByUs(messageId) {
    if (!messageId) return;
    this._sentByUs.add(messageId);
    setTimeout(() => this._sentByUs.delete(messageId), 5 * 60_000);
  }

  // Cachea un proto {key, message} para poder citarlo después. LRU FIFO.
  // Desenvolvemos wrappers (ephemeralMessage, viewOnceMessage, etc.) — Baileys
  // espera el inner cuando lo usamos como `quoted` en sendMessage.
  _cacheMsg(m) {
    if (!m?.key?.id || !m?.message) return;
    const inner = unwrapMessage(m.message);
    if (this._msgCache.has(m.key.id)) this._msgCache.delete(m.key.id); // re-insertar para refrescar orden
    this._msgCache.set(m.key.id, { key: m.key, message: inner });
    if (this._msgCache.size > this._msgCacheMax) {
      const oldest = this._msgCache.keys().next().value;
      this._msgCache.delete(oldest);
    }
  }

  // Construye metadata para guardar localmente y mostrar en dashboard. Prefiere el
  // proto cacheado; si no está, busca en la conv para que el dashboard siga viendo
  // la cita aunque WA no la renderice nativa (e.g. tras reinicio del server).
  _quotedMetaFor(jid, stanzaId) {
    if (!stanzaId) return null;
    const cached = this._msgCache.get(stanzaId);
    if (cached) {
      return {
        stanzaId,
        participant: cached.key?.participant || null,
        text: extractText(cached.message) || '',
        mediaType: extractMediaInfo(cached.message)?.type || null,
      };
    }
    const conv = this.store.conversations.get(jid);
    const m = conv?.messages.find((mm) => mm.id === stanzaId);
    if (m) {
      return {
        stanzaId,
        participant: m.senderJid || null,
        text: m.text || '',
        mediaType: m.attachment?.type || null,
      };
    }
    return null;
  }

  // Marca un messageId como "ya enviado por nosotros" para evitar loops cuando
  // GHL devuelve el outbound webhook de un mensaje que originamos.
  markOutboundSent(messageId) {
    if (!messageId) return;
    this._outboundSeen.add(messageId);
    setTimeout(() => this._outboundSeen.delete(messageId), 60_000);
  }
  isOutboundSeen(messageId) {
    return messageId ? this._outboundSeen.has(messageId) : false;
  }

  async start() {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ['Mac OS', 'Chrome', '120.0.0'],
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        const dataUrl = await qrcode.toDataURL(qr);
        this.store.setNumberConnection(this.numberId, 'qr', dataUrl);
      }
      if (connection === 'open') {
        this._reconnectAttempt = 0;
        this.store.setNumberConnection(this.numberId, 'connected');
        this._setMetric('connectedAt', Date.now());
        console.log(`[wa:${this._tag}] conectado`);
        dispatchWebhook(this.store.tenantId, 'connection.changed', { numberId: this.numberId, state: 'connected' });
      }
      if (connection === 'close') {
        const code = new Boom(lastDisconnect?.error).output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        this.store.setNumberConnection(this.numberId, loggedOut ? 'logged_out' : 'disconnected');
        this._setMetric('connectedAt', null);
        dispatchWebhook(this.store.tenantId, 'connection.changed', { numberId: this.numberId, state: loggedOut ? 'logged_out' : 'disconnected' });
        if (!loggedOut) {
          const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this._reconnectAttempt);
          this._reconnectAttempt = Math.min(this._reconnectAttempt + 1, 10);
          console.log(`[wa:${this._tag}] cerrado code=${code} reconnect en ${delay}ms`);
          clearTimeout(this._reconnectTimer);
          this._reconnectTimer = setTimeout(() => this.start().catch(console.error), delay);
          this._bump('reconnects');
        } else {
          console.log(`[wa:${this._tag}] cerrado code=${code} (loggedOut, no reconnect)`);
        }
      }
    });

    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      // 'notify': mensajes en tiempo real. 'append': historial reciente que
      // llega cuando Baileys reconecta tras un blip — sin esto perderíamos
      // todo lo que el contacto envió mientras el socket estaba caído (típico
      // caso: código de verificación llegó justo durante una desconexión).
      // 'prepend': sync inicial de mensajes viejos al primer login — eso sí
      // lo saltamos para no inundar la bandeja con histórico.
      if (type !== 'notify' && type !== 'append') return;
      for (const m of messages) {
        await this._handleIncoming(m).catch((e) =>
          console.error(`[wa:${this.store.tenantId}] handle`, e.message)
        );
      }
    });

    return this.sock;
  }

  async _handleIncoming(msg) {
    if (!msg.message) return;
    const jid = msg.key.remoteJid;
    if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return;
    const isGroup = jid.endsWith('@g.us');
    // Filtro opt-in: solo procesa grupos explícitamente habilitados por el operador.
    // Sin esto la bandeja se llena con todos los grupos donde está el número.
    if (isGroup && !this.store.isGroupEnabled(jid)) return;

    const text = extractText(msg.message);
    const earlyMediaCheck = extractMediaInfo(msg.message);
    if (!text.trim() && !earlyMediaCheck) return;

    // En grupos, el nombre de la conversación es el subject del grupo.
    if (isGroup) {
      const groupName = await this._getGroupName(jid);
      this.store.setGroupName(jid, groupName);
    }

    // Mensaje enviado desde otro dispositivo vinculado (p.ej. el celular del operador):
    // lo registramos como reply manual y forzamos modo humano para que la IA no siga respondiendo.
    if (msg.key.fromMe) {
      if (this._sentByUs.has(msg.key.id)) return; // echo de algo que enviamos nosotros

      // Procesar media adjunta si la hay (operador mandó imagen desde el celular)
      let fromMeAttachment = null;
      const fromMeMedia = extractMediaInfo(msg.message);
      if (fromMeMedia && isMediaConfigured()) {
        fromMeAttachment = await this._processIncomingMedia(msg, fromMeMedia).catch((e) => {
          console.error(`[media:${this.store.tenantId}] fromMe`, e.message);
          return null;
        });
      }

      const fromMeEffective = text.trim() || fromMeAttachment?.transcription || '';
      const fromMeQuoted = extractQuotedInfo(msg.message);
      const fromMeResolved = isGroup ? null : resolvePhoneAndJid(msg);
      // Anti-duplicación: si el teléfono ya tiene un JID canónico distinto (caso típico:
      // contacto entrante apareció antes como @lid), redirigimos al canónico para no
      // crear "Ana" + "573000000000" como conversaciones separadas.
      const fromMeCanonical = this.store.canonicalJidForPhone(fromMeResolved?.phone);
      const fromMeKey = (fromMeCanonical && fromMeCanonical !== jid) ? fromMeCanonical : jid;
      this._cacheMsg(msg);
      if (fromMeResolved?.phone) this.store.registerPhone(fromMeKey, fromMeResolved.phone);
      this.store.addMessage(fromMeKey, {
        role: 'assistant', manual: true, text: fromMeEffective, numberId: this.numberId,
        id: msg.key.id,
        ...(fromMeAttachment ? { attachment: fromMeAttachment } : {}),
        ...(fromMeQuoted ? { quoted: fromMeQuoted } : {}),
      });
      this.store.noteNumberForJid(fromMeKey, this.numberId);
      // Sync contact to CRM if configured
      if (isCRMConfigured() && fromMeResolved?.phone) {
        console.log(`[crm:${this.store.tenantId}] Attempting to sync (fromMe): phone=${fromMeResolved.phone}`);
        // Si el chat ya tiene nombre (pushName previo o agenda), se manda para
        // que el contacto no se cree como placeholder "WhatsApp <sufijo>".
        // crm.js descarta solo los que son puros dígitos.
        const knownName = this.store.getOrCreateConversation(fromMeKey)?.name;
        syncContactToCRM(fromMeResolved.phone, { firstName: knownName, chatUrl: chatDeepLink(fromMeKey) }).catch((e) =>
          console.warn(`[crm:${this.store.tenantId}] sync contact failed:`, e.message)
        );
      } else if (!fromMeResolved?.phone) {
        console.warn(`[crm:${this.store.tenantId}] ⚠️  Could not resolve phone from fromMe JID — CRM sync skipped`);
      }
      const current = this.store.getOrCreateConversation(fromMeKey);
      if (current.mode !== 'human') this.store.setMode(fromMeKey, 'human');

      // Mirror a GHL solo en 1:1 (grupos son local-only).
      if (!isGroup && fromMeResolved?.phone) {
        this._pushOperatorToGHL({
          jid: fromMeKey, phone: fromMeResolved.phone, text: fromMeEffective,
          attachments: fromMeAttachment ? [fromMeAttachment.url] : [],
          messageId: msg.key.id,
        }).catch((e) => console.error(`[ghl:${this.store.tenantId}] push fromMe`, e.message));
      }

      // El operador respondió desde el celular → ya leyó los pendientes en ese chat.
      // Limpiamos unreadCount local y propagamos read a GHL. skipWa: el celular ya
      // mandó el read receipt; reenviar desde aquí sería redundante.
      if (!isGroup) {
        this.markRead(fromMeKey, { skipWa: true }).catch((e) =>
          console.warn(`[wa:${this._tag}] auto-markRead tras fromMe: ${e.message}`)
        );
      }
      this._touchActivity();
      // Mensaje saliente originado en el celular (operador tecleó a mano, típico en
      // grupos). No pasó por send()/sendMedia(), así que disparamos el webhook aquí
      // — si no, las integraciones que escuchan message.sent nunca verían estos.
      dispatchWebhook(this.store.tenantId, 'message.sent', {
        jid: fromMeKey, numberId: this.numberId, text: fromMeEffective,
        source: 'phone', messageId: msg.key.id, isGroup,
        groupName: isGroup ? (this.store.conversations.get(jid)?.name || null) : null,
        ...(fromMeAttachment
          ? { mediaType: fromMeAttachment.type, mediaUrl: fromMeAttachment.url }
          : {}),
      });
      return;
    }

    // Resolver teléfono real (manejando LID mode) — null para grupos
    const resolved = isGroup ? null : resolvePhoneAndJid(msg);

    // Anti-duplicación 1:1: si ya tenemos un canónico para este teléfono y es distinto
    // del jid actual, redirigimos. Para grupos no aplica (cada grupo es su propio jid).
    const canonical = isGroup ? null : this.store.canonicalJidForPhone(resolved?.phone);
    const effectiveJid = (canonical && canonical !== jid) ? canonical : jid;

    // En grupos, name de la conv es el subject del grupo (ya seteado arriba),
    // y los mensajes individuales llevan senderName/senderJid del que escribió.
    const senderJid = isGroup ? msg.key.participant : null;
    const senderName = isGroup
      ? (msg.pushName || (senderJid ? senderJid.split('@')[0] : 'desconocido'))
      : null;
    const name = isGroup ? undefined : (msg.pushName || resolved?.phone || undefined);

    // Si hay media, descargarla y subirla a R2 antes de registrar el mensaje
    let attachment = null;
    const mediaInfo = extractMediaInfo(msg.message);
    if (mediaInfo && isMediaConfigured()) {
      attachment = await this._processIncomingMedia(msg, mediaInfo).catch((e) => {
        console.error(`[media:${this.store.tenantId}]`, e.message);
        this.store.addMessage(jid, { role: 'system', text: `⚠️ Falló descarga de media: ${e.message}` });
        return null;
      });
    } else if (!mediaInfo && !text.trim()) {
      // Diagnóstico: ningún tipo conocido — log con detalle para descubrir
      // wrappers nuevos (WhatsApp añade tipos cada par de meses). Incluimos
      // remitente y un sample del payload para que sea trivial diagnosticar.
      const inner = unwrapMessage(msg.message);
      const stub = msg.messageStubType ? ` stub=${msg.messageStubType}` : '';
      const sample = JSON.stringify(inner || {}).slice(0, 300);
      console.log(
        `[wa:${this.store.tenantId}] mensaje sin tipo conocido${stub} ` +
        `from=${msg.pushName || jid} raw=${Object.keys(msg.message || {})} ` +
        `unwrapped=${Object.keys(inner || {})} sample=${sample}`
      );
    }

    // Si no hay texto y tampoco se logró subir media → ignora (mensajes solo-sticker con upload fallido)
    if (!text.trim() && !attachment) return;

    // Texto efectivo: caption si existe, si no transcripción del audio. Es lo que ven la IA
    // y GHL en el cuerpo del mensaje; el audio queda como attachment al lado.
    const effectiveText = text.trim() || attachment?.transcription || '';

    // Detectar quote (reply a un mensaje anterior)
    const quoted = extractQuotedInfo(msg.message);

    // Cachear el proto para que el operador pueda citar este mensaje desde el dashboard
    this._cacheMsg(msg);

    if (!isGroup && resolved?.phone) this.store.registerPhone(effectiveJid, resolved.phone);
    const conv = this.store.addMessage(
      effectiveJid,
      {
        role: 'user',
        text: effectiveText,
        numberId: this.numberId,
        id: msg.key.id,
        ...(attachment ? { attachment } : {}),
        ...(isGroup ? { senderName, senderJid } : {}),
        ...(quoted ? { quoted } : {}),
      },
      name
    );
    this.store.noteNumberForJid(effectiveJid, this.numberId);

    // Aviso al operador. Solo si el chat lo atiende una persona: cuando responde
    // la IA no hay nada que hacer, y notificar cada mensaje que el bot ya contestó
    // vuelve la notificación ruido — y una notificación ruidosa se silencia.
    if (conv.mode === 'human' && !isGroup) {
      notificar({
        titulo: conv.name || 'Mensaje nuevo',
        cuerpo: resumen(effectiveText),
        url: '/inbox',
        tag: effectiveJid,
      }).catch(() => {});
    }

    // Sync contact to CRM if configured
    if (!isGroup) {
      if (!isCRMConfigured()) {
        console.log(`[crm] ℹ️  CRM not configured, skipping sync`);
      } else if (!resolved?.phone) {
        console.warn(`[crm:${this.store.tenantId}] ⚠️  Could not resolve phone from JID ${effectiveJid} — CRM sync skipped`);
      } else {
        console.log(`[crm:${this.store.tenantId}] Attempting to sync: phone=${resolved.phone}, name=${name || senderName}`);
        syncContactToCRM(resolved.phone, { firstName: name || senderName, chatUrl: chatDeepLink(effectiveJid) })
          .then(async (contact) => {
            // El nombre del CRM es el autoritativo: si allá lo editaron, se refleja
            // acá en el chat (el pushName de WhatsApp no lo pisa).
            if (!contact) return;
            const crmName = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim();
            if (crmName && this.store.setContactName(effectiveJid, crmName)) {
              console.log(`[crm:${this.store.tenantId}] chat ${effectiveJid} renombrado desde CRM → ${crmName}`);
            }

            // Si el cliente soltó un correo en el mensaje, lo guardamos en el CRM.
            // Va después del sync para que el contacto ya exista. enrichContact no
            // pisa un email que ya esté puesto en Twenty.
            const email = extractEmail(effectiveText);
            if (email) {
              console.log(`[crm:${this.store.tenantId}] email detectado en el mensaje: ${email}`);
              await enrichContactInCRM(resolved.phone, { email });
            }
          })
          .catch((e) =>
            console.warn(`[crm:${this.store.tenantId}] sync contact failed:`, e.message)
          );
      }
    }
    this._bump('received');
    this._touchActivity();
    dispatchWebhook(this.store.tenantId, 'message.received', {
      jid: effectiveJid, numberId: this.numberId,
      text: effectiveText, name,
      isGroup, senderName, senderJid,
      // En grupos: el subject, para que el receptor pueda nombrar la conversación.
      groupName: isGroup ? (conv?.name || null) : null,
      phone: resolved?.phone || null,
      hasAttachment: !!attachment,
      attachmentType: attachment?.type || null,
      // Sin la URL, el receptor sabía que había un adjunto pero no podía traerlo
      // (message.sent ya la mandaba; message.received no).
      mediaUrl: attachment?.url || null,
      mimetype: attachment?.mimetype || null,
      fileName: attachment?.fileName || null,
      // true si `text` es la transcripción de una nota de voz y no un texto del contacto.
      transcribed: !text.trim() && !!attachment?.transcription,
      messageId: msg.key.id,
    });

    // Mirror a GHL si el tenant está conectado Y tenemos teléfono real (NO grupos — local-only)
    if (!isGroup && resolved?.phone) {
      this._pushInboundToGHL({
        jid: effectiveJid, phone: resolved.phone, text: effectiveText, name, altId: msg.key.id,
        attachments: attachment ? [attachment.url] : [],
      }).catch((e) => {
        console.error(`[ghl:${this.store.tenantId}] push inbound`, e.message);
        this.store.addMessage(effectiveJid, { role: 'system', text: `⚠️ Push GHL falló: ${e.message}` });
      });
    } else if (!isGroup && this.store.ghl?.accessToken) {
      console.warn(`[wa:${this.store.tenantId}] jid sin teléfono resoluble: ${jid}`);
    }

    // Espejo al CRM de la suite (apps/crm). Independiente de GHL: si CRM_INGEST_URL
    // no está configurada, no hace nada. Usa el waJid como clave (funciona con @lid,
    // que oculta el teléfono), y pasa el teléfono si lo hay. Así el CRM crea el
    // contacto y le abre un lead aunque no tengamos número.
    if (!isGroup && crmLocalConfigured()) {
      pushMessageToCrm({
        waJid: effectiveJid,
        phone: resolved?.phone || null,
        name,
        text: effectiveText,
        role: 'user',
        waMessageId: msg.key.id,
        ...(attachment ? { attachment } : {}),
      }).catch((e) => console.error(`[crm:${this.store.tenantId}] push inbound`, e.message));
    }

    if (conv.mode !== 'ai') return;
    // Nunca en grupos, aunque alguien ponga el chat del grupo en modo IA: un bot
    // contestando en un grupo es mucho más visible (y vergonzoso) que en un 1:1.
    if (isGroup) return;

    // Si no hay texto efectivo (ni caption ni transcripción) → IA no procesa imágenes/docs
    // por ahora; deja que el operador conteste manualmente.
    if (!effectiveText) return;

    // Kill switch global: si el operador pausó la IA para todo el tenant, saltar
    // sin tocar el modo per-chat (cuando se reactive, el flujo vuelve a su estado).
    if (this.store.config.aiEnabled === false) {
      console.log(`[wa:${this.store.tenantId}] IA pausada globalmente, skip ${jid}`);
      this._bump('skippedAiDisabled');
      return;
    }

    // El cliente pide una persona: escalar por encima de greylist, quiet hours y
    // rate limit. Nada de lo que la IA responda aquí mejora la situación.
    if (AUTO_HANDOFF && detectHumanRequest(effectiveText)) {
      await this._handoff(effectiveJid, jid, 'cliente', { ack: true, phone: resolved?.phone || null });
      return;
    }

    // Greylist: primer mensaje de un contacto nuevo → operador humano lo atiende.
    if (NEW_CONTACT_REQUIRES_HUMAN) {
      const priorUserMsgs = conv.messages.filter((m) => m.role === 'user').length;
      if (priorUserMsgs <= 1) {
        // effectiveJid (canónico), no jid: con @lid crudo crearíamos una conversación
        // fantasma paralela a la real.
        this.store.setMode(effectiveJid, 'human', 'greylist');
        console.log(`[wa:${this.store.tenantId}] greylist: contacto nuevo ${effectiveJid} → modo humano`);
        this._bump('skippedGreylist');
        return;
      }
    }

    if (isInQuietHours()) {
      console.log(`[wa:${this.store.tenantId}] quiet hours: skip auto-reply para ${jid}`);
      this._bump('skippedQuietHours');
      return;
    }

    const limit = this._limiter.check(effectiveJid);
    if (!limit.ok) {
      console.warn(`[wa:${this.store.tenantId}] rate limit (${limit.reason}): skip ${effectiveJid}`);
      this._bump('skippedRateLimit');
      return;
    }

    try {
      const startedAt = Date.now();
      // Para sock.sendMessage usamos `jid` (el que Baileys recibió). Para storage y
      // GHL usamos `effectiveJid` (canónico) para mantener una sola conversación.
      await this.sock.sendPresenceUpdate('composing', jid);
      const { history, context } = await this._buildAiContext(conv, effectiveJid, resolved?.phone);
      const raw = await generateReply({
        waJid: jid,
        systemPrompt: this.store.config.systemPrompt,
        history,
        context,
      });
      // El LLM marca con [[HANDOFF]] los casos que no puede resolver. El marcador
      // se arranca SIEMPRE antes de enviar: el cliente jamás debe verlo.
      const { text: reply, handoff } = splitHandoff(raw);
      if (reply && reply.trim()) {
        const target = jitter(HUMAN_DELAY_MIN_MS, HUMAN_DELAY_MAX_MS);
        const elapsed = Date.now() - startedAt;
        if (elapsed < target) await sleep(target - elapsed);
        // Reservamos el slot antes de mandar — si Baileys falla, el rate limit
        // igual cuenta este intento (mas conservador contra ban del numero).
        this._limiter.record(effectiveJid);
        const sent = await this.sock.sendMessage(jid, { text: reply });
        this._rememberSentByUs(sent?.key?.id);
        this._cacheMsg(sent);
        this._bump('sent');
        this._touchActivity();
        this.store.addMessage(effectiveJid, { role: 'assistant', text: reply, numberId: this.numberId, id: sent?.key?.id });
        this.store.noteNumberForJid(effectiveJid, this.numberId);
        dispatchWebhook(this.store.tenantId, 'message.sent', {
          jid: effectiveJid, numberId: this.numberId, text: reply,
          source: 'ai', messageId: sent?.key?.id,
        });
        // Mirror la respuesta de IA a GHL como inbound del lado business
        if (resolved?.phone) {
          this._pushAIReplyToGHL({ jid: effectiveJid, phone: resolved.phone, text: reply, messageId: sent?.key?.id }).catch((e) => {
            console.error(`[ghl:${this.store.tenantId}] push reply`, e.message);
            this.store.addMessage(effectiveJid, { role: 'system', text: `⚠️ Push reply GHL falló: ${e.message}` });
          });
        }
      }
      // La IA se declaró incompetente. Ya le avisó al cliente en su propia
      // respuesta, así que escalamos sin mandar un acuse encima. Con AUTO_HANDOFF
      // apagado el marcador se arranca igual (nunca llega al cliente) pero el chat
      // se queda en IA, como antes.
      if (handoff && AUTO_HANDOFF) await this._handoff(effectiveJid, jid, 'modelo', { ack: false });
      await this.sock.sendPresenceUpdate('paused', jid);
    } catch (e) {
      console.error(`[ai:${this.store.tenantId}]`, e.message);
      this.store.addMessage(jid, { role: 'system', text: `Error IA: ${e.message}` });
    }
  }

  /**
   * Pasa un chat a manos de un humano, con el motivo, y opcionalmente le avisa al
   * cliente. Idempotente: si el chat ya estaba en humano no reescala ni re-avisa.
   *
   * canonicalJid = donde vive la conversación (efectivo/deduplicado).
   * sendJid      = el JID que Baileys aceptó para enviar (puede ser @lid).
   */
  async _handoff(canonicalJid, sendJid, reason, { ack = false, phone = null } = {}) {
    const conv = this.store.getOrCreateConversation(canonicalJid);
    if (conv.mode === 'human') return;

    this.store.setMode(canonicalJid, 'human', reason);
    this._bump('handoffs');
    console.log(`[wa:${this.store.tenantId}] handoff (${reason}): ${canonicalJid} → humano`);
    const titulo = `${conv.name || 'Un chat'} necesita a una persona`;
    const cuerpo = MOTIVO_HANDOFF[reason] || `Motivo: ${reason}`;
    dispatchWebhook(this.store.tenantId, 'handoff', {
      jid: canonicalJid, numberId: this.numberId, reason,
      phone: phone || null, name: conv.name || null, titulo, cuerpo,
    });
    notificar({ titulo, cuerpo, url: '/inbox', tag: canonicalJid }).catch(() => {});

    if (!ack || !HANDOFF_ACK_TEXT) return;
    // El acuse es un envío como cualquier otro: cuenta contra el rate limit (anti-ban).
    // Si no hay cupo, escalamos igual pero en silencio — el operador ya tiene el chat.
    if (!this._limiter.check(canonicalJid).ok) {
      console.warn(`[wa:${this.store.tenantId}] handoff sin acuse (rate limit): ${canonicalJid}`);
      return;
    }
    try {
      this._limiter.record(canonicalJid);
      const sent = await this.sock.sendMessage(sendJid, { text: HANDOFF_ACK_TEXT });
      this._rememberSentByUs(sent?.key?.id);
      this._cacheMsg(sent);
      this._bump('sent');
      this._touchActivity();
      this.store.addMessage(canonicalJid, {
        role: 'assistant', text: HANDOFF_ACK_TEXT, numberId: this.numberId, id: sent?.key?.id,
      });
      if (phone) {
        this._pushAIReplyToGHL({ jid: canonicalJid, phone, text: HANDOFF_ACK_TEXT, messageId: sent?.key?.id })
          .catch((e) => console.error(`[ghl:${this.store.tenantId}] push acuse handoff`, e.message));
      }
    } catch (e) {
      console.error(`[wa:${this.store.tenantId}] acuse de handoff falló: ${e.message}`);
    }
  }

  // ¿El string parece un teléfono (placeholder) y no un nombre real?
  static _looksLikePhone(s) {
    return !s || /^\+?\d{6,}$/.test(String(s).trim());
  }

  // Trae el contexto del contacto en GHL (tags, empresa, origen) con cache 5min.
  // Devuelve null si no hay GHL conectado, no hay contactId, o la query falla.
  async _ghlContactContext(jid) {
    if (!this.store.ghl?.accessToken) return null;
    const contactId = this.store.getContactIdByJid(jid);
    if (!contactId) return null;
    const cached = this._ghlContactCache.get(contactId);
    if (cached && Date.now() - cached.ts < 5 * 60_000) return cached.data;
    let data = null;
    try {
      data = await new GHLClient(this.store).getContactContext(contactId);
    } catch (e) {
      console.warn(`[ghl:${this._tag}] getContactContext ${contactId}: ${e.message}`);
    }
    this._ghlContactCache.set(contactId, { data, ts: Date.now() });
    return data;
  }

  // Prepara el historial que ve la IA + un resumen de lo viejo en hilos largos.
  // Hilos cortos: historial completo, sin resumen. Hilos largos: resumimos los
  // mensajes anteriores a la ventana reciente (cacheado en conv.summary) y pasamos
  // solo los recientes verbatim, para no mandar 200 mensajes crudos al LLM.
  async _historyAndSummary(conv) {
    const RECENT_WINDOW = 30;
    const REFRESH_EVERY = 15;
    const chat = conv.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
    if (chat.length <= RECENT_WINDOW + REFRESH_EVERY) {
      return { history: chat, summary: '' };
    }
    const older = chat.slice(0, chat.length - RECENT_WINDOW);
    const recent = chat.slice(chat.length - RECENT_WINDOW);
    // Regenerar el resumen solo si no existe o si crecieron >= REFRESH_EVERY mensajes
    // viejos desde la última vez (evita un LLM call extra en cada respuesta).
    if (!conv.summary || (older.length - (conv.summaryCount || 0)) >= REFRESH_EVERY) {
      const summary = await summarizeConversation(older);
      if (summary) {
        conv.summary = summary;
        conv.summaryCount = older.length;
        this.store.persistConversations().catch(() => {});
      }
    }
    return { history: recent, summary: conv.summary || '' };
  }

  // Reúne todo el contexto que la IA debe tener siempre: nombre, si es conversación
  // en curso, datos del CRM (GHL), base de conocimiento del tenant y resumen.
  async _buildAiContext(conv, jid, phone) {
    const rawName = (conv.name || '').trim();
    const contactName = WhatsAppSession._looksLikePhone(rawName) ? null : rawName;
    const userMsgs = conv.messages.filter((m) => m.role === 'user').length;
    const isReturning = userMsgs > 1 || conv.messages.some((m) => m.role === 'assistant');
    const ghlContact = await this._ghlContactContext(jid);
    const { history, summary } = await this._historyAndSummary(conv);
    return {
      history,
      context: {
        contactName,
        phone: phone || null,
        knowledgeBase: this.store.renderKnowledgeBase(),
        ghlContact,
        summary,
        isReturning,
      },
    };
  }

  // Descarga la media del mensaje Baileys y la sube a R2.
  // Para voice/audio además transcribe con Whisper. Devuelve attachment dict o lanza.
  async _processIncomingMedia(msg, info) {
    // downloadMediaMessage necesita el mensaje con la estructura {key, message: <inner>},
    // donde inner es el message ya desenvuelto.
    const unwrappedMsg = { key: msg.key, message: unwrapMessage(msg.message) };
    const buffer = await downloadMediaMessage(unwrappedMsg, 'buffer', {}, { logger });
    if (!buffer || !buffer.length) throw new Error('buffer vacío');
    const { ext, waType } = mimeToWa(info.mimetype);
    const uploaded = await uploadBufferToR2(buffer, {
      contentType: info.mimetype,
      extension: info.fileName ? info.fileName.split('.').pop() : ext,
      prefix: `wa/${this.store.tenantId}`,
    });
    console.log(`[media:${this.store.tenantId}] uploaded ${info.type} ${buffer.length}b → ${uploaded.url}`);

    const attachment = {
      url: uploaded.url,
      mimetype: info.mimetype,
      type: info.type || waType,
      ...(info.fileName ? { fileName: info.fileName } : {}),
      ...(info.ptt ? { ptt: true } : {}),
      ...(info.seconds ? { seconds: info.seconds } : {}),
    };

    // Transcribir si es voice/audio y Whisper está configurado
    if ((info.type === 'voice' || info.type === 'audio') && isWhisperConfigured()) {
      try {
        const startedAt = Date.now();
        const transcription = await transcribeAudio(buffer, { mimetype: info.mimetype });
        const ms = Date.now() - startedAt;
        if (transcription) {
          attachment.transcription = transcription;
          console.log(`[whisper:${this.store.tenantId}] transcrito ${ms}ms (${transcription.length}c): ${transcription.slice(0, 80)}${transcription.length > 80 ? '…' : ''}`);
        }
      } catch (e) {
        console.error(`[whisper:${this.store.tenantId}]`, e.message);
      }
    }

    return attachment;
  }

  async _pushInboundToGHL({ jid, phone, text, name, altId, attachments }) {
    if (!this.store.ghl?.accessToken) return;
    // Preferir el providerId per-tenant (creado en OAuth callback); fallback al env var
    // para no romper la sub-account original que usaba el providerId del Marketplace.
    const providerId = this.store.ghl.conversationProviderId || process.env.GHL_CONVERSATION_PROVIDER_ID;
    if (!providerId) return;

    const ghl = new GHLClient(this.store);
    const contact = await ghl.findOrCreateContact({ phone, name });
    const contactId = contact?.id;
    if (!contactId) {
      console.warn(`[ghl:${this.store.tenantId}] sin contactId para ${phone}`);
      return;
    }
    // Mapeo crítico: contactId → jid para enrutar outbound de GHL al JID correcto (especialmente con LID)
    this.store.linkContact(contactId, jid);

    const resp = await ghl.sendInboundMessage({
      contactId,
      message: text,
      conversationProviderId: providerId,
      altId: `wa:${altId}`,
      attachments,
    });
    // Capturamos el messageId que GHL devuelve para poder llamar
    // updateMessageStatus(read) más tarde y sincronizar el estado de lectura.
    const ghlMessageId = resp?.messageId || resp?.message?.id || resp?.id;
    const ghlConversationId = resp?.conversationId || resp?.message?.conversationId;
    if (ghlMessageId && altId) {
      this.store.updateMessageMeta(jid, altId, { ghlMessageId, ...(ghlConversationId ? { ghlConversationId } : {}) });
    }
    console.log(`[ghl:${this.store.tenantId}] inbound → contact ${contactId} (jid=${jid}) attachments=${(attachments || []).length} ghlMsg=${ghlMessageId || 'n/a'}`);
  }

  async _pushAIReplyToGHL({ jid, phone, text, messageId }) {
    return this._pushAssistantToGHL({ jid, phone, text, prefix: '🤖 ', messageId });
  }

  // Mensajes del operador originados FUERA de GHL (desde dashboard local o desde
  // el celular vinculado) — los mirroreamos a GHL para que el operador trabajando
  // en GHL Conversations vea el hilo completo.
  async _pushOperatorToGHL({ jid, phone, text, attachments, quotedText, messageId }) {
    return this._pushAssistantToGHL({ jid, phone, text, attachments, prefix: '👤 ', quotedText, messageId });
  }

  async _pushAssistantToGHL({ jid, phone, text, attachments, prefix = '', quotedText = '', messageId }) {
    if (!this.store.ghl?.accessToken) return;
    const providerId = this.store.ghl.conversationProviderId || process.env.GHL_CONVERSATION_PROVIDER_ID;
    if (!providerId) return;

    const ghl = new GHLClient(this.store);
    // Reutiliza el contactId mapeado si existe
    let contactId = this.store.getContactIdByJid(jid);
    if (!contactId && phone) {
      const contact = await ghl.findOrCreateContact({ phone });
      contactId = contact?.id;
      if (contactId) this.store.linkContact(contactId, jid);
    }
    if (!contactId) return;
    // Prepend quote prefix (GHL no soporta quotes nativos) — formato: ↪ "<text>"\n<msg>
    const quoteLine = quotedText ? `↪ "${quotedText.slice(0, 160)}"\n` : '';
    const body = (text || '').trim();
    const message = body ? `${quoteLine}${prefix}${body}` : `${quoteLine}${prefix}`.trim();
    // Mismo endpoint que para mensajes del cliente (/conversations/messages/inbound)
    // pero con direction='outbound' — así GHL lo registra como saliente nuestro,
    // sin disparar notificación de "nuevo mensaje" en LeadConnector mobile.
    const resp = await ghl.sendInboundMessage({
      contactId,
      message,
      conversationProviderId: providerId,
      attachments,
      direction: 'outbound',
      ...(messageId ? { altId: `wa-out:${messageId}` } : {}),
    });
    // Red de seguridad: si GHL eco-disparara el deliveryUrl del Custom
    // Provider con este msg, /webhooks/ghl/outbound lo descarta y no se
    // reenvía duplicado a WhatsApp.
    const ghlMessageId = resp?.messageId || resp?.message?.id || resp?.id;
    if (ghlMessageId) this.markOutboundSent(ghlMessageId);
  }

  async send(jid, text, opts = {}) {
    if (!this.sock) throw new Error('WhatsApp no conectado');
    if (!opts.skipRateLimit) {
      try { this._enforceLimit(jid); }
      catch (e) { this._bump('skippedRateLimit'); throw e; }
    }
    const quotedMeta = this._quotedMetaFor(jid, opts.quotedStanzaId);
    const quotedProto = opts.quotedStanzaId ? this._msgCache.get(opts.quotedStanzaId) : null;
    const payload = { text };
    if (quotedProto) payload.quoted = quotedProto;
    this._limiter.record(jid);
    const sent = await this.sock.sendMessage(jid, payload);
    this._rememberSentByUs(sent?.key?.id);
    this._cacheMsg(sent);
    this.store.addMessage(jid, {
      role: 'assistant', text, manual: true, numberId: this.numberId,
      id: sent?.key?.id,
      ...(quotedMeta ? { quoted: quotedMeta } : {}),
    });
    this.store.noteNumberForJid(jid, this.numberId);
    this._bump('manual');
    this._touchActivity();
    dispatchWebhook(this.store.tenantId, 'message.sent', {
      jid, numberId: this.numberId, text,
      source: 'manual', messageId: sent?.key?.id,
    });
    if (opts.skipGhlMirror) return;
    if (jid.endsWith('@g.us')) return; // grupos son local-only, no se mirorean a GHL
    // Mensaje originado fuera de GHL (dashboard) → mirroreamos para que aparezca en GHL Conversations
    const phone = jidToPhone(jid);
    if (phone) {
      this._pushOperatorToGHL({ jid, phone, text, quotedText: quotedMeta?.text || '', messageId: sent?.key?.id }).catch((e) =>
        console.error(`[ghl:${this._tag}] push manual`, e.message)
      );
    }
  }

  // Envía una media (imagen/video/audio/documento) a un JID. La URL puede ser de R2
  // (ya pública) o de GHL/externo — siempre se descarga a buffer y se envía como bytes
  // por Baileys para evitar problemas de CDN.
  async sendMedia(jid, { url, mimetype, fileName, caption, ptt, seconds, waveform }, opts = {}) {
    if (!this.sock) throw new Error('WhatsApp no conectado');
    if (!opts.skipRateLimit) {
      try { this._enforceLimit(jid); }
      catch (e) { this._bump('skippedRateLimit'); throw e; }
    }
    const { buffer, contentType } = await downloadUrlToBuffer(url);
    if (!buffer || buffer.length === 0) {
      throw new Error(`media vacía descargada de ${url}`);
    }
    const finalMime = mimetype || contentType;
    const { waType } = mimeToWa(finalMime);
    const base = { caption: caption || undefined };
    let payload;
    if (waType === 'image') payload = { ...base, image: buffer, mimetype: finalMime };
    else if (waType === 'video') payload = { ...base, video: buffer, mimetype: finalMime };
    else if (waType === 'audio') {
      // PTT: pasamos seconds Y waveform explícitamente. Si dejamos que Baileys
      // los calcule, depende de la dep opcional `audio-decode` que falla
      // silenciosamente en Docker/Alpine → waveform vacía → WhatsApp muestra
      // "Este audio ya no está disponible". Con ambos campos seteados, Baileys
      // los usa tal cual y no entra en ese path frágil.
      payload = {
        audio: buffer,
        mimetype: finalMime,
        ptt: !!ptt,
        ...(seconds ? { seconds } : {}),
        ...(waveform ? { waveform } : {}),
      };
    }
    else payload = { document: buffer, mimetype: finalMime, fileName: fileName || 'file' };
    console.log(`[wa:${this._tag}] sendMedia jid=${jid} type=${waType} mime=${finalMime} size=${buffer.length}B${ptt ? ' ptt=true' : ''}${seconds ? ` seconds=${seconds}` : ''}${waveform ? ` waveform=${waveform.length}B` : ''}`);
    const quotedMeta = this._quotedMetaFor(jid, opts.quotedStanzaId);
    const quotedProto = opts.quotedStanzaId ? this._msgCache.get(opts.quotedStanzaId) : null;
    if (quotedProto) payload.quoted = quotedProto;
    this._limiter.record(jid);
    const sent = await this.sock.sendMessage(jid, payload);
    this._rememberSentByUs(sent?.key?.id);
    this._cacheMsg(sent);
    this.store.addMessage(jid, {
      role: 'assistant', manual: true, numberId: this.numberId,
      text: caption || '',
      id: sent?.key?.id,
      attachment: { url, mimetype: finalMime, type: waType, ...(fileName ? { fileName } : {}), ...(ptt ? { ptt: true } : {}) },
      ...(quotedMeta ? { quoted: quotedMeta } : {}),
    });
    this.store.noteNumberForJid(jid, this.numberId);
    this._bump('manual');
    this._touchActivity();
    dispatchWebhook(this.store.tenantId, 'message.sent', {
      jid, numberId: this.numberId, text: caption || '',
      source: 'manual-media', messageId: sent?.key?.id,
      mediaType: waType, mediaUrl: url,
    });
    if (opts.skipGhlMirror) return;
    if (jid.endsWith('@g.us')) return; // grupos local-only
    const phone = jidToPhone(jid);
    if (phone) {
      this._pushOperatorToGHL({ jid, phone, text: caption || '', attachments: [url], quotedText: quotedMeta?.text || '', messageId: sent?.key?.id }).catch((e) =>
        console.error(`[ghl:${this._tag}] push manual media`, e.message)
      );
    }
  }

  // Cierra sock, borra creds Baileys y reinicia para forzar nuevo QR.
  // Necesario cuando se removió el dispositivo desde el celular (code=401 / loggedOut)
  // — el authDir conserva creds inválidas que Baileys no recupera solo.
  async relink() {
    clearTimeout(this._reconnectTimer);
    this._reconnectAttempt = 0;
    try { await this.sock?.logout(); } catch {}
    try { this.sock?.end(); } catch {}
    this.sock = null;
    await fs.rm(this.authDir, { recursive: true, force: true });
    this.store.setNumberConnection(this.numberId, 'disconnected');
    console.log(`[wa:${this._tag}] relink: authDir borrado, reiniciando…`);
    return this.start();
  }

  // Marca como leídos los mensajes pendientes de una conv y propaga a WA y GHL.
  // - WA: sock.readMessages(keys) → el contacto ve doble check azul.
  // - GHL: PUT /conversations/messages/{id}/status status=read → desaparece el
  //        "sin leer" en GHL Conversations.
  // opts.skipWa / opts.skipGhl: evita el ping de vuelta cuando la lectura
  // vino justo desde ese lado (no queremos bucles GHL ↔ app).
  async markRead(jid, opts = {}) {
    const result = this.store.markConversationRead(jid);
    if (!result) return { read: 0 };
    const { newlyRead } = result;
    if (!newlyRead.length) return { read: 0 };

    if (!opts.skipWa && this.sock) {
      // Limitamos a últimos 50 para no spamear si la conv es muy vieja
      const recent = newlyRead.slice(-50);
      let cachedHits = 0;
      const keys = recent.map((m) => {
        const cached = this._msgCache.get(m.id);
        if (cached?.key) { cachedHits++; return cached.key; }
        // Fallback si la key no está cacheada (e.g. reinicio del server entre
        // recibir el mensaje y marcarlo leído)
        return {
          remoteJid: jid,
          id: m.id,
          fromMe: false,
          ...(m.senderJid ? { participant: m.senderJid } : {}),
        };
      }).filter((k) => k.id);
      console.log(`[wa:${this._tag}] markRead jid=${jid} keys=${keys.length} cachedHits=${cachedHits}`);
      if (keys.length) {
        try {
          await this.sock.readMessages(keys);
          console.log(`[wa:${this._tag}] readMessages OK (${keys.length} keys)`);
        } catch (e) {
          console.warn(`[wa:${this._tag}] readMessages falló (${keys.length} keys): ${e.message}`);
        }
      }
    }

    if (!opts.skipGhl && this.store.ghl?.accessToken) {
      const withGhlId = newlyRead.filter((m) => m.ghlMessageId);
      const withoutGhlId = newlyRead.length - withGhlId.length;
      console.log(`[ghl:${this.store.tenantId}] markRead → GHL: ${withGhlId.length} con ghlMessageId, ${withoutGhlId} sin ghlMessageId (mensajes pre-deploy)`);
      const ghlClient = new GHLClient(this.store);

      // 1) Actualizar status de delivery de cada mensaje (read). Esto NO baja el
      //    badge de no-leídos en GHL — eso es contador a nivel conversación.
      Promise.allSettled(
        withGhlId.map((m) => ghlClient.updateMessageStatus(m.ghlMessageId, 'read')
          .then(() => console.log(`[ghl:${this.store.tenantId}] msg-status read OK ${m.ghlMessageId}`))
          .catch((e) => console.warn(`[ghl:${this.store.tenantId}] msg-status ${m.ghlMessageId}: ${e.message}`))
        )
      );

      // 2) Resetear unreadCount=0 de la conversación — esto SÍ limpia el badge
      //    en GHL Conversations UI. ghlConversationId se captura al primer
      //    pushInbound; si no está (mensajes pre-deploy), buscamos en mensajes.
      const conv = this.store.conversations.get(jid);
      const ghlConvId = conv?.ghlConversationId
        || conv?.messages?.findLast?.((m) => m.ghlConversationId)?.ghlConversationId
        || newlyRead.find((m) => m.ghlConversationId)?.ghlConversationId;
      if (ghlConvId) {
        ghlClient.markConversationAsRead(ghlConvId)
          .then((r) => console.log(`[ghl:${this.store.tenantId}] conv markRead OK ${ghlConvId} via=${r?.via}`))
          .catch((e) => console.warn(`[ghl:${this.store.tenantId}] conv markRead ${ghlConvId}: ${e.message}`));
      } else {
        console.warn(`[ghl:${this.store.tenantId}] sin ghlConversationId para ${jid} — no se puede limpiar badge`);
      }
    }

    return { read: newlyRead.length };
  }

  // Cierra el sock sin borrar creds. Útil al eliminar el número (lógica en registry).
  async stop() {
    clearTimeout(this._reconnectTimer);
    this._reconnectAttempt = 0;
    try { await this.sock?.logout(); } catch {}
    try { this.sock?.end(); } catch {}
    this.sock = null;
    this.store.setNumberConnection(this.numberId, 'disconnected');
  }
}
