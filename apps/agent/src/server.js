import express from 'express';
import cookieParser from 'cookie-parser';
import http from 'node:http';
import { Server as IOServer } from 'socket.io';
import path from 'node:path';
import fsp from 'node:fs/promises';
import swaggerUi from 'swagger-ui-express';
import { openapiSpec } from './openapi.js';
import { logAudit, listAudit, actorFrom } from './audit.js';
import { createKey, listKeys, revokeKey, verifyToken } from './apiKeys.js';
import {
  createUser, listUsers, verifyCredentials, setPassword, disableUser, enableUser,
  hasAnyUsers, generatePassword,
  signDashboardSession, verifyDashboardSession, DASHBOARD_SESSION_COOKIE,
} from './users.js';
import { createWebhook, listWebhooks, revokeWebhook, dispatch as dispatchWebhook, WEBHOOK_EVENTS } from './webhooks.js';
import { computeStats } from './stats.js';
import * as lab from './lab.js';
import { tenants } from './tenants.js';
import { buildAuthorizeUrl, exchangeCode, listLocations, getLocationToken } from './ghl/oauth.js';
import { saveAgencyTokens, getFreshAgencyToken } from './ghl/agencies.js';
import { phoneToJid } from './ghl/phone.js';
import { GHLClient } from './ghl/client.js';
import { decryptGhlPayload, signSession, verifySession } from './ghl/sso.js';
import { ghlWebhookGuard } from './ghl/webhook.js';
import { uploadBufferToR2, mimeToWa, isMediaConfigured, transcodeToOggOpus, computePttMetadata } from './media.js';
import { pushMessageToCrm, crmLocalConfigured } from './crmLocal.js';

// Decodifica un JWT GHL para inspeccionar scopes (sin verificación — solo para debug).
function decodeJwtPayload(jwt) {
  try {
    const part = jwt.split('.')[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  } catch { return null; }
}

// Provisiona un Custom Conversation Provider para un tenant recién conectado.
// Custom Providers son operación a nivel agencia en GHL — el location token, aunque
// declare conversations.write, no tiene permiso. Usamos el agency token (Company)
// cuando existe; con fallback al location token por si en algún flujo no hay agency.
// Idempotente: si ya tiene conversationProviderId no hace nada.
async function ensureConversationProvider(tenant) {
  if (tenant.ghl?.conversationProviderId) return tenant.ghl.conversationProviderId;
  if (!tenant.ghl?.accessToken) return null;

  // PUBLIC_URL es la URL pública del agente en esta instalación; sin default
  // hardcodeado — cada cliente define la suya.
  const publicBase = process.env.PUBLIC_URL || process.env.OPENROUTER_SITE_URL;
  if (!publicBase) {
    console.warn('[ghl] PUBLIC_URL no configurada — no se puede aprovisionar el conversation provider');
    return null;
  }
  const deliveryUrl = `${publicBase.replace(/\/+$/, '')}/webhooks/ghl/outbound`;
  const name = `${process.env.BUSINESS_NAME || 'WhatsApp Agent'} (${tenant.tenantId.slice(0, 8)})`;
  const body = { locationId: tenant.ghl.locationId, name, type: 'Custom', deliveryUrl };

  async function callWith(token, method, source, urlSuffix = '') {
    const resp = await fetch(`https://services.leadconnectorhq.com/conversations/providers${urlSuffix}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Version: '2021-07-28',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await resp.text();
    if (!resp.ok) {
      const claims = decodeJwtPayload(token);
      console.error(`[ghl:${tenant.tenantId}] ${method} providers ${source} ${resp.status}: ${text.slice(0, 300)}`);
      console.error(`[ghl:${tenant.tenantId}] token scopes (${source}): ${claims?.oauthMeta?.scopes || claims?.scope || '(no scope claim)'}`);
      throw new Error(`${method} ${resp.status}: ${text.slice(0, 200)}`);
    }
    return text ? JSON.parse(text) : {};
  }

  function pickProviderId(payload) {
    if (!payload) return null;
    if (payload.id || payload.providerId || payload._id) return payload.id || payload.providerId || payload._id;
    const list = payload.providers || payload.data || (Array.isArray(payload) ? payload : null);
    if (Array.isArray(list)) {
      // Preferir uno cuyo nombre coincida con esta app
      const ours = list.find((p) => /whatsapp|mystore/i.test(p?.name || ''));
      const pick = ours || list[0];
      return pick?.id || pick?.providerId || pick?._id || null;
    }
    return null;
  }

  // Estrategia A: listar providers existentes (GHL auto-registra el provider de la app
  // al instalarse en una sub-account). Probamos con agency token y luego location.
  const locationId = tenant.ghl.locationId;
  const tokensToTry = [];
  if (tenant.ghl.companyId) {
    try {
      const agency = await getFreshAgencyToken(tenant.ghl.companyId);
      tokensToTry.push({ token: agency.accessToken, source: 'agency' });
    } catch (e) {
      console.warn(`[ghl:${tenant.tenantId}] no se pudo obtener agency token:`, e.message);
    }
  }
  try {
    const client = new GHLClient(tenant);
    tokensToTry.push({ token: await client._ensureFreshToken(), source: 'location' });
  } catch (e) {
    console.warn(`[ghl:${tenant.tenantId}] no se pudo obtener location token:`, e.message);
  }

  for (const { token, source } of tokensToTry) {
    try {
      const list = await callWith(token, 'GET', source + '-list', `?locationId=${encodeURIComponent(locationId)}`);
      const providerId = pickProviderId(list);
      if (providerId) {
        tenant.setGhlTokens({ conversationProviderId: providerId });
        console.log(`[ghl:${tenant.tenantId}] provider existente encontrado (${source}): ${providerId}`);
        return providerId;
      }
      console.log(`[ghl:${tenant.tenantId}] GET providers (${source}) sin resultados utilizables:`, JSON.stringify(list).slice(0, 200));
    } catch (e) {
      console.warn(`[ghl:${tenant.tenantId}] GET providers ${source} falló:`, e.message);
    }
  }

  // Estrategia B: intentar crear (esperado que falle si la app no tiene scopes/feature
  // habilitado para esto, pero dejamos el intento por completitud y diagnóstico).
  for (const { token, source } of tokensToTry) {
    try {
      const provider = await callWith(token, 'POST', source);
      const providerId = pickProviderId(provider);
      if (providerId) {
        tenant.setGhlTokens({ conversationProviderId: providerId });
        console.log(`[ghl:${tenant.tenantId}] provider creado (${source}): ${providerId}`);
        return providerId;
      }
    } catch (e) {
      // Ya logueado dentro de callWith
    }
  }
  return null;
}

const EMBED_COOKIE = 'embed_session';
const SESSION_TTL = 60 * 60 * 12; // 12h

async function authMiddleware(req, res, next) {
  // Rutas siempre públicas (las requiere GHL o son endpoints de salud)
  if (
    req.path.startsWith('/oauth/') ||
    req.path.startsWith('/webhooks/') ||
    req.path === '/embed' ||
    req.path === '/embed.html' ||
    // Hub CRM+WhatsApp: cáscara con dos iframes; cada iframe exige su propio login
    req.path === '/hub' ||
    req.path === '/hub.html' ||
    req.path === '/api/embed/sso' ||
    req.path === '/api/health' ||
    req.path === '/api/version' ||
    req.path === '/api/docs' ||
    req.path === '/api/docs/' ||
    req.path.startsWith('/api/docs/') ||
    req.path === '/api/docs.json' ||
    // Login UI + endpoint: deben ser accesibles sin auth previa
    req.path === '/login' ||
    req.path === '/login.html' ||
    req.path === '/api/login' ||
    // Favicon/PWA assets: el navegador los pide antes de tener auth — bypass
    /^\/(favicon\.ico|favicon-\d+x\d+\.png|apple-touch-icon\.png|android-chrome-\d+x\d+\.png|site\.webmanifest)$/.test(req.path)
  ) return next();

  const header = req.headers.authorization || '';

  // 1) API key (Bearer). Una key válida fija req.apiKey = {id, label, tenantId}.
  // Si viene un Bearer pero falla, NO hacemos fallback a Basic — devolvemos 401
  // para que clientes mal configurados se enteren rápido.
  if (header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    const key = await verifyToken(token).catch(() => null);
    if (!key) return res.status(401).json({ error: 'API key inválida o revocada' });
    req.apiKey = key;
    return next();
  }

  // 2) Embed session cookie (válido y firmado)
  // Solo se valida si GHL_SHARED_SECRET existe: verificar con un fallback tipo
  // 'dev' equivaldría a aceptar cookies forjadas por cualquiera.
  const cookie = req.cookies?.[EMBED_COOKIE];
  if (cookie && process.env.GHL_SHARED_SECRET) {
    const locationId = verifySession(cookie, process.env.GHL_SHARED_SECRET);
    if (locationId) {
      req.embedLocationId = locationId;
      return next();
    }
  }

  // 3) Dashboard session cookie (login UI). Fija req.dashboardSession con
  // {username, role, tenantId}. Para role='client' el getTenant fuerza el
  // scope al tenantId — el cliente no ve ni puede tocar otros tenants.
  const dashCookie = req.cookies?.[DASHBOARD_SESSION_COOKIE];
  if (dashCookie) {
    const session = verifyDashboardSession(dashCookie);
    if (session) {
      req.dashboardSession = session;
      return next();
    }
  }

  // 4) Back-door perpetua via Basic auth con DASHBOARD_USER/PASS (env vars).
  // Siempre admin. Garantiza que el operador NUNCA queda afuera del sistema
  // aunque pierda el password de su user formal en data/users.json. Esto
  // requiere acceso al .env del VPS, así que no compromete seguridad real.
  const envUser = process.env.DASHBOARD_USER;
  const envPass = process.env.DASHBOARD_PASS;
  if (envUser && envPass) {
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const [u, p] = Buffer.from(encoded, 'base64').toString().split(':');
      if (u === envUser && p === envPass) {
        req.dashboardSession = { username: u, role: 'admin', tenantId: null, envFallback: true };
        return next();
      }
    }
  }

  // 5) Sin usuarios y sin DASHBOARD_USER: instalación a medio configurar.
  // ANTES dejábamos pasar (modo dev), pero eso significa que un despliegue mal
  // configurado queda 100% público — inaceptable en un producto. Fail-closed:
  // se niega el acceso con instrucciones de cómo completar la configuración.
  const noUsers = !(await hasAnyUsers());
  if (noUsers && !envUser) {
    const hint = 'Configura DASHBOARD_USER y DASHBOARD_PASS en el .env y reinicia el servicio.';
    if (req.path.startsWith('/api/')) {
      return res.status(503).json({ error: 'instalación sin credenciales configuradas', hint });
    }
    return res.status(503).send(pageShell('Configuración pendiente', `
      <h1>Falta configurar el acceso</h1>
      <p>Esta instalación aún no tiene credenciales de operador.</p>
      <p><code>${escapeHtml(hint)}</code></p>
    `));
  }

  // 6) Hay usuarios formales pero ninguno autenticado → redirigir a /login
  // (UI) o 401 JSON (API). Para clientes API mal configurados queremos
  // 401 explícito, no redirect.
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'no autenticado', loginUrl: '/login.html' });
  }
  return res.redirect(`/login.html?next=${encodeURIComponent(req.originalUrl || '/')}`);
}

function getTenant(req) {
  // Cuando viene una embed session, el tenant queda fijado por la cookie y no se puede sobrescribir
  if (req.embedLocationId) {
    const t = tenants.get(req.embedLocationId);
    if (!t) throw Object.assign(new Error(`Tenant ${req.embedLocationId} no existe`), { status: 404 });
    return t;
  }
  // Misma regla con API keys: el tenant lo fija la key, no la query
  if (req.apiKey?.tenantId) {
    const t = tenants.get(req.apiKey.tenantId);
    if (!t) throw Object.assign(new Error(`Tenant ${req.apiKey.tenantId} no existe`), { status: 404 });
    return t;
  }
  // Login session de cliente (role='client'): tenant forzado a su tenantId.
  // Si el cliente intenta pasar ?tenant=otro, lo ignoramos silenciosamente.
  if (req.dashboardSession?.role === 'client' && req.dashboardSession?.tenantId) {
    const t = tenants.get(req.dashboardSession.tenantId);
    if (!t) throw Object.assign(new Error(`Tenant ${req.dashboardSession.tenantId} no existe`), { status: 404 });
    return t;
  }
  const id = req.query.tenant || req.body?.tenant || '_local';
  const t = tenants.get(id);
  if (!t) throw Object.assign(new Error(`Tenant ${id} no existe`), { status: 404 });
  return t;
}

// True si el request es de un admin (login session con role=admin, o
// bootstrap legacy, o API key sin scope — los embed siempre son client-equiv).
function isAdmin(req) {
  if (req.dashboardSession?.role === 'admin') return true;
  return false;
}

// Guard para endpoints que requieren admin (gestión de usuarios, etc).
function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  return res.status(403).json({ error: 'requiere rol admin' });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Mini-parser de multipart/form-data. Solo soporta un archivo + campos planos —
// suficiente para /api/send-media. Evita añadir multer/busboy como dependencia.
function parseMultipart(buf, boundary) {
  const result = { fields: {}, files: {} };
  const boundaryBuf = Buffer.from(boundary);
  const endMarker = Buffer.from('--');
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);

  let pos = data.indexOf(boundaryBuf);
  if (pos === -1) return result;
  pos += boundaryBuf.length + 2; // skip CRLF after boundary

  while (pos < data.length) {
    const headerEnd = data.indexOf('\r\n\r\n', pos);
    if (headerEnd === -1) break;
    const headers = data.slice(pos, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;
    const nextBoundary = data.indexOf(boundaryBuf, bodyStart);
    if (nextBoundary === -1) break;
    const body = data.slice(bodyStart, nextBoundary - 2); // strip CRLF antes del boundary

    const disp = /content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i.exec(headers);
    const ctMatch = /content-type:\s*([^\r\n]+)/i.exec(headers);
    if (disp) {
      const name = disp[1];
      const filename = disp[2];
      if (filename) {
        result.files[name] = { filename, contentType: ctMatch?.[1]?.trim() || 'application/octet-stream', buffer: body };
      } else {
        result.fields[name] = body.toString('utf8');
      }
    }
    // Si después de este boundary viene '--' es el end marker → terminar
    const afterBoundary = nextBoundary + boundaryBuf.length;
    if (data.subarray(afterBoundary, afterBoundary + 2).equals(endMarker)) break;
    pos = afterBoundary + 2; // skip CRLF
  }
  return result;
}

function pageShell(title, body) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
body{font-family:-apple-system,system-ui,sans-serif;background:#0f1419;color:#e7e9ea;margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:40px 20px}
.box{background:#16202a;padding:32px;border-radius:12px;max-width:640px;width:100%;border:1px solid #2a3744}
.ok{color:#4caf50;font-size:48px;text-align:center}
h2{margin:8px 0 24px;text-align:center}
.row{display:flex;align-items:center;gap:12px;padding:12px;background:#1a2530;border-radius:8px;margin-bottom:8px}
.row .info{flex:1}
.row .name{font-weight:500}
.row .id{font-size:12px;color:#8899a6;font-family:ui-monospace,Menlo,monospace}
button{background:#1d9bf0;color:#fff;border:0;border-radius:6px;padding:8px 16px;cursor:pointer;font-size:13px}
button:hover{background:#1a8cd8}
button:disabled{opacity:0.4;cursor:not-allowed;background:#3a4d5e}
a{color:#1d9bf0}
.empty{text-align:center;color:#8899a6;padding:32px}
</style></head><body><div class="box">${body}</div></body></html>`;
}

function successPage({ tenantId, companyId }) {
  return pageShell('Instalación exitosa', `
<div class="ok">✓</div>
<h2>Conectado a GHL</h2>
<p>Location ID: <code>${escapeHtml(tenantId)}</code></p>
${companyId ? `<p>Agency: <code>${escapeHtml(companyId)}</code></p>` : ''}
<p>Próximo paso: abre el dashboard, selecciona este tenant y escanea el QR de WhatsApp.</p>
<p style="text-align:center;margin-top:24px"><a href="/?tenant=${encodeURIComponent(tenantId)}">Abrir dashboard →</a></p>`);
}

function selectLocationPage({ companyId, locations, connected }) {
  const rows = locations.length
    ? locations.map((l) => {
        const isConn = connected.has(l.id);
        const label = isConn ? 'Reconectar' : 'Conectar';
        const title = isConn ? 'Re-deriva el location token desde el agency token actual — útil tras actualizar scopes de la app' : '';
        return `<div class="row">
          <div class="info">
            <div class="name">${escapeHtml(l.name || '(sin nombre)')}${isConn ? ' <span style="color:#4caf50;font-size:11px">● conectada</span>' : ''}</div>
            <div class="id">${escapeHtml(l.id)}</div>
          </div>
          <form method="POST" action="/oauth/connect-location" style="margin:0">
            <input type="hidden" name="companyId" value="${escapeHtml(companyId)}">
            <input type="hidden" name="locationId" value="${escapeHtml(l.id)}">
            <button type="submit" title="${escapeHtml(title)}">${label}</button>
          </form>
        </div>`;
      }).join('')
    : '<div class="empty">No hay sub-accounts en esta agencia.</div>';
  return pageShell('Elige una sub-account', `
<h2>Elige la sub-account a conectar</h2>
<p style="text-align:center;color:#8899a6">Agency: <code>${escapeHtml(companyId)}</code> · ${locations.length} sub-account(s)</p>
${rows}
<p style="text-align:center;margin-top:24px"><a href="/oauth/install">← Volver al install</a></p>`);
}

const GHL_SCOPES = [
  'conversations.readonly',
  'conversations.write',
  'conversations/message.readonly',
  'conversations/message.write',
  'contacts.readonly',
  'contacts.write',
  'locations.readonly',
];

export function startServer(port = 3000) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json({
    limit: '1mb',
    // Capturamos el cuerpo raw para que ghlWebhookGuard pueda verificar firmas RSA.
    verify: (req, _res, buf) => { if (buf?.length) req.rawBody = buf; },
  }));
  app.use(express.urlencoded({ extended: true }));
  // Vista unificada: Twenty-CRM a pantalla completa + panel lateral de WhatsApp.
  // Va ANTES del static para ganarle también en /hub.html: el iframe apunta a
  // una URL distinta por instalación, así que se inyecta al vuelo en vez de
  // quedar hardcodeada en el HTML. Ojo, es la URL PÚBLICA del CRM — la que
  // resuelve el navegador — no el CRM_URL interno que usa la sync.
  app.get(['/hub', '/hub.html'], async (_req, res, next) => {
    try {
      const html = await fsp.readFile(path.resolve('./public/hub.html'), 'utf8');
      res.type('html')
        .setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.send(html.replaceAll('__CRM_PUBLIC_URL__', process.env.CRM_PUBLIC_URL || ''));
    } catch (err) { next(err); }
  });

  // Static ANTES de authMiddleware: los HTMLs y assets (css, js, imágenes,
  // favicons) deben servirse públicamente porque el navegador los pide para
  // renderizar login.html antes de tener sesión. Los HTMLs actúan como
  // shells vacíos — la protección de DATOS está en cada endpoint /api/*.
  app.use(express.static(path.resolve('./public'), {
    setHeaders: (res, p) => {
      // No cachear HTML — los assets sí (cache buster en el query string)
      if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    },
  }));
  app.use(authMiddleware);

  // Servir /embed sin extensión
  app.get('/embed', (_req, res) => res.sendFile(path.resolve('./public/embed.html')));

  // /login alias para /login.html (más natural en URL)
  app.get('/login', (_req, res) => res.sendFile(path.resolve('./public/login.html')));

  app.get('/api/health', (_req, res) => res.json({ ok: true, tenants: tenants.list().length }));

  // Diagnóstico: qué commit está corriendo + estado de deps clave. Util para
  // verificar que un deploy realmente trajo el código nuevo, vs estar
  // adivinando con el "Up X days" del docker.
  app.get('/api/version', async (_req, res) => {
    const out = {
      commit: process.env.GIT_COMMIT || 'unknown',
      builtAt: process.env.BUILD_AT || 'unknown',
      node: process.version,
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
    };
    try {
      await import('audio-decode');
      out.audioDecode = 'installed';
    } catch (e) {
      out.audioDecode = `missing: ${e.message.slice(0, 100)}`;
    }
    res.json(out);
  });

  // ---------- Sesiones del dashboard ----------
  // POST /api/login → recibe {username, password}, valida con users.js, emite cookie
  // firmada dashboard_session (12h). Cliente UI lo llama desde login.html.
  app.post('/api/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username y password requeridos' });

    // 1) DASHBOARD_USER/PASS del .env como admin perpetuo. Mismo back-door
    // que Basic auth, pero accesible via UI — así no requiere recordar que
    // hay dos caminos distintos para autenticarse.
    let user = null;
    if (process.env.DASHBOARD_USER && process.env.DASHBOARD_PASS
        && username === process.env.DASHBOARD_USER
        && password === process.env.DASHBOARD_PASS) {
      user = { username, role: 'admin', tenantId: null };
    } else {
      // 2) Usuarios formales de data/users.json
      user = await verifyCredentials(username, password);
    }
    if (!user) {
      // Pequeño delay para frenar brute-force (no perfecto, pero ayuda).
      await new Promise((r) => setTimeout(r, 300));
      return res.status(401).json({ error: 'credenciales inválidas' });
    }
    const cookie = signDashboardSession({
      username: user.username, role: user.role, tenantId: user.tenantId,
    });
    res.cookie(DASHBOARD_SESSION_COOKIE, cookie, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
      maxAge: 12 * 60 * 60 * 1000,
      path: '/',
      // COOKIE_DOMAIN (ej: .cliente.com) hace que la sesión valga para TODOS los
      // subdominios — el CRM y el agente comparten login. Sin definir = host-only.
      ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
    });
    res.json({ ok: true, user: { username: user.username, role: user.role, tenantId: user.tenantId } });
  });

  app.post('/api/logout', (req, res) => {
    res.clearCookie(DASHBOARD_SESSION_COOKIE, {
      path: '/',
      ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
    });
    res.json({ ok: true });
  });

  // Quién está logueado. UI lo llama al boot para saber si redirigir a login y
  // ajustar la vista (ocultar tenant selector si role=client, etc.).
  app.get('/api/me', (req, res) => {
    if (req.dashboardSession) {
      return res.json({
        username: req.dashboardSession.username,
        role: req.dashboardSession.role,
        tenantId: req.dashboardSession.tenantId,
        bootstrap: !!req.dashboardSession.bootstrap,
      });
    }
    if (req.embedLocationId) return res.json({ via: 'embed', tenantId: req.embedLocationId, role: 'client' });
    if (req.apiKey) return res.json({ via: 'api-key', tenantId: req.apiKey.tenantId, role: 'client', label: req.apiKey.label });
    return res.status(401).json({ error: 'no autenticado' });
  });

  // ---------- CRUD de usuarios (solo admin) ----------
  app.get('/api/users', requireAdmin, async (_req, res) => {
    try { res.json({ users: await listUsers() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/users', requireAdmin, async (req, res) => {
    try {
      const { username, role, tenantId } = req.body || {};
      let { password } = req.body || {};
      // Validar que el tenantId existe (evita typos del admin que dejarían al
      // cliente sin poder loguearse — getTenant tiraría 404 al iniciar)
      if (role === 'client' && tenantId && !tenants.get(tenantId)) {
        return res.status(400).json({ error: `tenant '${tenantId}' no existe` });
      }
      // Si no se pasó password, generamos uno y lo devolvemos UNA vez.
      const generated = !password;
      if (generated) password = generatePassword();
      const user = await createUser({ username, password, role, tenantId });
      res.status(201).json({
        user,
        // El password sólo se devuelve en la creación. El admin debe copiarlo y
        // pasarlo al cliente — no se puede recuperar después.
        password,
        generated,
      });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/users/:username/password', requireAdmin, async (req, res) => {
    try {
      let { password } = req.body || {};
      const generated = !password;
      if (generated) password = generatePassword();
      await setPassword(req.params.username, password);
      res.json({ ok: true, password, generated });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/users/:username/disable', requireAdmin, async (req, res) => {
    try { const ok = await disableUser(req.params.username); res.json({ ok }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/users/:username/enable', requireAdmin, async (req, res) => {
    try { const ok = await enableUser(req.params.username); res.json({ ok }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  // OpenAPI spec + Swagger UI — públicos, sin auth (no exponen datos del tenant)
  app.get('/api/docs.json', (_req, res) => res.json(openapiSpec));
  app.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(openapiSpec, {
      customSiteTitle: 'My Store · WhatsApp Agent API',
      swaggerOptions: { persistAuthorization: true },
    }),
  );

  app.get('/api/tenants', (req, res) => {
    const all = tenants.list();
    // Para clientes, solo devolvemos su tenant. Para admin (o backwards-compat
    // sin login), todos. Esto hace que el selector del UI muestre solo lo permitido.
    if (req.dashboardSession?.role === 'client' && req.dashboardSession?.tenantId) {
      return res.json({ tenants: all.filter((t) => t.tenantId === req.dashboardSession.tenantId) });
    }
    res.json({ tenants: all });
  });

  app.get('/api/state', (req, res) => {
    try {
      const t = getTenant(req);
      const snap = t.snapshot();
      snap.metrics = tenants.session(t.tenantId)?.getMetrics() || null;
      res.json(snap);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/config', requireAdmin, (req, res) => {
    try {
      const t = getTenant(req);
      const { systemPrompt } = req.body || {};
      if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) return res.status(400).json({ error: 'systemPrompt requerido' });
      t.setPrompt(systemPrompt);
      logAudit({ tenantId: t.tenantId, actor: actorFrom(req), type: 'config', meta: { promptLength: systemPrompt.length } });
      res.json({ ok: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // ─── Base de conocimiento ───────────────────────────────────────────────────
  // Q&A estructuradas + un bloque de texto libre. Es lo que el agente usa como
  // fuente de verdad; lo que no esté aquí, no lo sabe.

  app.get('/api/kb', (req, res) => {
    try {
      const t = getTenant(req);
      res.json({ entries: t.listKb(), freeText: t.config.knowledgeBase || '' });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/kb', requireAdmin, (req, res) => {
    try {
      const t = getTenant(req);
      const { id, q, a, source } = req.body || {};
      const entry = id ? t.updateKbEntry(id, { q, a }) : t.addKbEntry({ q, a, source });
      logAudit({
        tenantId: t.tenantId, actor: actorFrom(req),
        type: id ? 'kb-update' : 'kb-add', target: { id: entry.id }, meta: { q: entry.q.slice(0, 80) },
      });
      res.json({ ok: true, entry });
    } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
  });

  app.delete('/api/kb/:id', requireAdmin, (req, res) => {
    try {
      const t = getTenant(req);
      if (!t.deleteKbEntry(req.params.id)) return res.status(404).json({ error: 'entrada no existe' });
      logAudit({ tenantId: t.tenantId, actor: actorFrom(req), type: 'kb-delete', target: { id: req.params.id } });
      res.json({ ok: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/kb/text', requireAdmin, (req, res) => {
    try {
      const t = getTenant(req);
      const { text } = req.body || {};
      if (typeof text !== 'string') return res.status(400).json({ error: 'text requerido' });
      t.setKnowledgeBase(text);
      logAudit({ tenantId: t.tenantId, actor: actorFrom(req), type: 'kb-text', meta: { length: text.length } });
      res.json({ ok: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // ─── Laboratorio ────────────────────────────────────────────────────────────
  // Seis clientes simulados conversan contra el agente REAL en un sandbox que no
  // toca WhatsApp, y un LLM juez los evalúa. Sirve para medir el agente antes de
  // soltarlo con clientes de verdad, y para ver si un cambio de prompt/KB mejoró.

  app.post('/api/lab/run', requireAdmin, async (req, res) => {
    try {
      const t = getTenant(req);
      if (lab.isRunning(t.tenantId)) {
        return res.status(409).json({ error: 'Ya hay una corrida en curso' });
      }
      const run = await lab.startRun(t);
      logAudit({ tenantId: t.tenantId, actor: actorFrom(req), type: 'lab-run', target: { id: run.id } });
      res.json({ ok: true, run });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.get('/api/lab/runs', (req, res) => {
    try {
      const t = getTenant(req);
      // La lista va sin transcripts: son largos y el dashboard solo los pide al abrir un caso.
      const runs = t.listLabRuns().map((r) => ({
        ...r,
        cases: r.cases.map(({ transcript, ...c }) => ({ ...c, turns: transcript?.length || 0 })),
      }));
      res.json({ runs, running: lab.isRunning(t.tenantId), personas: lab.PERSONAS.map((p) => ({ key: p.key, label: p.label, description: p.description })) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.get('/api/lab/runs/:id', (req, res) => {
    try {
      const t = getTenant(req);
      const run = t.getLabRun(req.params.id);
      if (!run) return res.status(404).json({ error: 'corrida no existe' });
      res.json({ run });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // Aplica una sugerencia del juez a la base de conocimiento con un click.
  // Esto es lo que cierra el ciclo: el Lab detecta el hueco y lo tapa.
  app.post('/api/lab/apply', requireAdmin, (req, res) => {
    try {
      const t = getTenant(req);
      const { runId, persona, index } = req.body || {};
      const run = t.getLabRun(runId);
      if (!run) return res.status(404).json({ error: 'corrida no existe' });
      const c = run.cases.find((x) => x.persona === persona);
      const h = c?.hallazgos?.[index];
      if (!h?.sugerencia) return res.status(404).json({ error: 'ese hallazgo no trae sugerencia' });

      const entry = t.addKbEntry({ q: h.sugerencia.pregunta, a: h.sugerencia.respuesta, source: 'lab' });
      // Marcamos el hallazgo como aplicado para que el botón no se pueda pulsar dos veces.
      h.applied = true;
      t.updateLabRun(run);
      logAudit({ tenantId: t.tenantId, actor: actorFrom(req), type: 'lab-apply', target: { id: entry.id }, meta: { q: entry.q.slice(0, 80) } });
      res.json({ ok: true, entry });
    } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
  });

  // Renombrar un chat 1:1 desde una fuente autoritativa (el CRM de la suite).
  // Pisa el pushName aunque ya fuera legible: lo que el operador escribió gana.
  app.post('/api/conversations/rename', (req, res) => {
    try {
      const t = getTenant(req);
      const { jid, name } = req.body || {};
      if (!jid || !name || !String(name).trim()) return res.status(400).json({ error: 'jid y name requeridos' });
      const renamed = t.setContactName(jid, String(name));
      logAudit({ tenantId: t.tenantId, actor: actorFrom(req), type: 'conv-rename', target: { jid }, meta: { name: String(name).slice(0, 60) } });
      res.json({ ok: true, renamed });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/conversations/read', async (req, res) => {
    try {
      const t = getTenant(req);
      const { jid } = req.body || {};
      if (!jid) return res.status(400).json({ error: 'jid requerido' });
      const session = tenants.sessionForJid(t.tenantId, jid);
      if (!session) {
        // Sin sesión WA disponible (puede pasar si todos los números están desconectados)
        // — al menos marcamos como leído en local + GHL.
        const result = t.markConversationRead(jid);
        if (result && result.newlyRead.length && t.ghl?.accessToken) {
          const ghl = new GHLClient(t);
          Promise.allSettled(result.newlyRead.filter((m) => m.ghlMessageId)
            .map((m) => ghl.updateMessageStatus(m.ghlMessageId, 'read').catch(() => {})));
        }
        return res.json({ ok: true, read: result?.newlyRead?.length || 0, waSync: false });
      }
      const result = await session.markRead(jid);
      res.json({ ok: true, ...result, waSync: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/conversations/merge', async (req, res) => {
    try {
      const t = getTenant(req);
      const { fromJid, toJid } = req.body || {};
      if (!fromJid || !toJid) return res.status(400).json({ error: 'fromJid y toJid requeridos' });
      const conv = await t.mergeConversations(fromJid, toJid);
      logAudit({ tenantId: t.tenantId, actor: actorFrom(req), type: 'conv-merge', target: { fromJid, toJid } });
      res.json({ ok: true, conversation: conv });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/mode', (req, res) => {
    try {
      const t = getTenant(req);
      const { jid, mode } = req.body || {};
      if (!jid || !['ai', 'human'].includes(mode)) return res.status(400).json({ error: 'jid y mode requeridos' });
      logAudit({ tenantId: t.tenantId, actor: actorFrom(req), type: 'mode', target: { jid }, meta: { mode } });
      dispatchWebhook(t.tenantId, 'mode.changed', { jid, mode, reason: 'operador', actor: actorFrom(req) });
      res.json({ ok: true, conversation: t.setMode(jid, mode, 'operador') });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/ai-enabled', requireAdmin, (req, res) => {
    try {
      const t = getTenant(req);
      const { enabled } = req.body || {};
      if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) requerido' });
      t.setAiEnabled(enabled);
      logAudit({ tenantId: t.tenantId, actor: actorFrom(req), type: 'ai-enabled', meta: { enabled } });
      res.json({ ok: true, aiEnabled: t.config.aiEnabled });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // Lista todos los grupos en los que el número está, con estado enabled del operador.
  // Combina sock.groupFetchAllParticipating (live de WA) con grupos ya conocidos en
  // conversaciones locales (por si la query live no los devuelve).
  app.get('/api/groups', async (req, res) => {
    try {
      const t = getTenant(req);
      const session = tenants.session(t.tenantId);
      if (!session?.sock) return res.status(503).json({ error: 'Sesión WhatsApp no conectada' });
      const enabled = new Set(t.config.enabledGroups || []);
      const known = new Map();
      // Live: groups donde está el número actual
      try {
        const live = await session.sock.groupFetchAllParticipating();
        for (const [jid, md] of Object.entries(live || {})) {
          known.set(jid, {
            jid,
            name: md.subject || jid,
            participantCount: (md.participants || []).length,
            enabled: enabled.has(jid),
            hasMessages: t.conversations.has(jid),
          });
        }
      } catch (e) {
        console.warn(`[/api/groups] groupFetchAllParticipating falló: ${e.message}`);
      }
      // Conversaciones locales con jid @g.us que no aparecieron en live (grupos archivados/abandonados)
      for (const [jid, conv] of t.conversations) {
        if (!jid.endsWith('@g.us') || known.has(jid)) continue;
        known.set(jid, {
          jid,
          name: conv.name || jid,
          participantCount: null,
          enabled: enabled.has(jid),
          hasMessages: true,
          stale: true, // ya no está activo en WA
        });
      }
      const groups = Array.from(known.values()).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      res.json({ groups });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  app.post('/api/groups/toggle', requireAdmin, async (req, res) => {
    try {
      const t = getTenant(req);
      const { jid, enabled } = req.body || {};
      if (!jid || !jid.endsWith('@g.us')) return res.status(400).json({ error: 'jid de grupo requerido (@g.us)' });
      if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) requerido' });
      t.setGroupEnabled(jid, enabled);
      logAudit({ tenantId: t.tenantId, actor: actorFrom(req), type: 'group-toggle', target: { jid }, meta: { enabled } });

      // Al habilitar: crea conv placeholder con el nombre del grupo para que aparezca
      // en la sidebar inmediatamente, sin esperar al primer mensaje nuevo.
      if (enabled && !t.conversations.has(jid)) {
        const session = tenants.session(t.tenantId);
        let groupName = jid;
        try {
          if (session?.sock) {
            const md = await session.sock.groupMetadata(jid);
            groupName = md?.subject || jid;
          }
        } catch {}
        const conv = t.getOrCreateConversation(jid, groupName);
        t.emit('message', { tenantId: t.tenantId, jid, conversation: conv });
      }
      res.json({ ok: true, enabled, enabledGroups: t.config.enabledGroups });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // Provisiona (o re-provisiona si force=true) el Conversation Provider del tenant.
  // Útil para sub-accounts conectadas antes del fix multi-tenant.
  app.post('/api/ghl/provision-provider', requireAdmin, async (req, res) => {
    try {
      const t = getTenant(req);
      if (!t.ghl?.accessToken) return res.status(400).json({ error: 'Tenant sin GHL conectado' });
      if (req.body?.force) t.setGhlTokens({ conversationProviderId: null });
      const providerId = await ensureConversationProvider(t);
      if (!providerId) return res.status(500).json({ error: 'No se pudo crear (revisa logs del server)' });
      logAudit({ tenantId: t.tenantId, actor: actorFrom(req), type: 'provision-provider', meta: { providerId, force: !!req.body?.force } });
      res.json({ ok: true, conversationProviderId: providerId });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/relink', requireAdmin, async (req, res) => {
    try {
      const t = getTenant(req);
      const numberId = req.body?.numberId || req.query?.numberId;
      const session = tenants.session(t.tenantId, numberId);
      if (!session) return res.status(404).json({ error: 'session no existe' });
      session.relink().catch((e) => console.error(`[relink ${t.tenantId}/${session.numberId}]`, e.message));
      logAudit({ tenantId: t.tenantId, actor: actorFrom(req), type: 'relink', target: { numberId: session.numberId } });
      res.json({ ok: true, numberId: session.numberId });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // --- Multi-número ---
  app.get('/api/numbers', (req, res) => {
    try {
      const t = getTenant(req);
      // Enriquece cada número con metrics live de su sesión Baileys (uptime, lastActivity, contadores).
      // Si la sesión aún no existe (arranque) devuelve metrics=null.
      const numbers = t.listNumbers().map((n) => {
        const session = tenants.session(t.tenantId, n.id);
        return { ...n, metrics: session?.getMetrics() || null };
      });
      res.json({ numbers, defaultId: t.getDefaultNumberId() });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/numbers', requireAdmin, async (req, res) => {
    try {
      const t = getTenant(req);
      const { id, label } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id requerido (slug del número)' });
      const entry = await tenants.addNumber(t.tenantId, { id, label });
      logAudit({ tenantId: t.tenantId, actor: actorFrom(req), type: 'number-add', target: { numberId: entry.id }, meta: { label: entry.label } });
      res.json({ ok: true, number: { id: entry.id, label: entry.label, connection: entry.connection } });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.delete('/api/numbers/:id', requireAdmin, async (req, res) => {
    try {
      const t = getTenant(req);
      const id = req.params.id;
      if (!t.numbers.has(id)) return res.status(404).json({ error: 'número no existe' });
      await tenants.removeNumber(t.tenantId, id);
      logAudit({ tenantId: t.tenantId, actor: actorFrom(req), type: 'number-remove', target: { numberId: id } });
      res.json({ ok: true, removed: id });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/send', async (req, res) => {
    try {
      const t = getTenant(req);
      const { jid, text, numberId, quotedStanzaId, keepAi } = req.body || {};
      if (!jid || !text) return res.status(400).json({ error: 'jid y text requeridos' });
      const session = numberId
        ? tenants.session(t.tenantId, numberId)
        : tenants.sessionForJid(t.tenantId, jid);
      if (!session) return res.status(404).json({ error: 'sin sesión disponible para este chat' });
      await session.send(jid, text, { quotedStanzaId });
      logAudit({ tenantId: t.tenantId, actor: actorFrom(req), type: 'send', target: { jid, numberId: session.numberId }, meta: { length: text.length, quoted: !!quotedStanzaId } });

      // Takeover: si una PERSONA escribe desde el dashboard, la IA se calla en ese
      // chat. Sin esto el bot sigue contestando encima del operador.
      // Las API keys quedan fuera: una automatización que manda un mensaje no debe
      // apagarle la IA al chat. `keepAi: true` permite renunciar al takeover.
      const isHumanActor = !req.apiKey;
      let mode = t.getOrCreateConversation(jid).mode;
      if (isHumanActor && !keepAi && mode !== 'human') {
        t.setMode(jid, 'human', 'takeover');
        mode = 'human';
        dispatchWebhook(t.tenantId, 'mode.changed', { jid, mode: 'human', reason: 'takeover', actor: actorFrom(req) });
      }
      res.json({ ok: true, numberId: session.numberId, mode });
    } catch (e) {
      if (e.status === 429) {
        const retryS = Math.ceil((e.retryAfterMs || 1000) / 1000);
        const tid = req.embedLocationId || req.apiKey?.tenantId || req.query.tenant;
        logAudit({ tenantId: tid, actor: actorFrom(req), type: 'send-blocked', target: { jid: req.body?.jid }, meta: { reason: e.reason, retryAfterMs: e.retryAfterMs } });
        dispatchWebhook(tid, 'message.blocked', { jid: req.body?.jid, reason: e.reason, retryAfterMs: e.retryAfterMs, actor: actorFrom(req) });
        return res.status(429).set('Retry-After', String(retryS)).json({ error: e.message, reason: e.reason, retryAfterMs: e.retryAfterMs });
      }
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // Sube un archivo a R2 y lo envía via WhatsApp. Body: multipart/form-data con
  // 'file' (binario), 'jid' y opcional 'caption'. Tenant viene de query/cookie.
  // Usamos multipart raw parser local para evitar añadir dependencias (multer/busboy).
  app.post('/api/send-media', express.raw({ type: () => true, limit: '50mb' }), async (req, res) => {
    try {
      if (!isMediaConfigured()) return res.status(500).json({ error: 'R2 no configurado en el server' });
      const t = getTenant(req);
      const ct = req.headers['content-type'] || '';
      const boundaryMatch = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/);
      if (!boundaryMatch) return res.status(400).json({ error: 'Content-Type debe ser multipart/form-data' });
      const boundary = '--' + (boundaryMatch[1] || boundaryMatch[2]);
      const parts = parseMultipart(req.body, boundary);
      const jid = parts.fields.jid;
      const caption = parts.fields.caption || '';
      const file = parts.files.file;
      if (!jid || !file) return res.status(400).json({ error: 'jid y file requeridos' });

      // Flag ptt=true → el cliente quiere mandar nota de voz (burbuja redonda
      // reproducible). Transcodificamos a OGG/Opus si no viene ya en ese
      // formato — WhatsApp solo lo trata como PTT si el container es OGG.
      const wantsPtt = parts.fields.ptt === 'true' || parts.fields.ptt === '1';
      let mimetype = file.contentType || 'application/octet-stream';
      let buffer = file.buffer;
      let fileName = file.filename;
      if (wantsPtt) {
        const isOpusOgg = /^audio\/ogg/i.test(mimetype);
        if (!isOpusOgg) {
          try {
            const tc = await transcodeToOggOpus(file.buffer);
            buffer = tc.buffer;
            mimetype = tc.mimetype;
            fileName = (fileName || 'voice').replace(/\.[^.]+$/, '') + '.ogg';
          } catch (e) {
            console.error('[send-media] transcode falló, enviando original:', e.message);
            // Soft-fail: si ffmpeg no está o falla, mandamos el audio
            // original. Llegará como archivo en vez de PTT, pero llega.
          }
        }
      }

      const { ext } = mimeToWa(mimetype);
      const uploaded = await uploadBufferToR2(buffer, {
        contentType: mimetype,
        extension: fileName ? fileName.split('.').pop() : ext,
        prefix: `wa/${t.tenantId}/manual`,
      });

      const numberId = parts.fields.numberId;
      const quotedStanzaId = parts.fields.quotedStanzaId || null;
      // Duración (segundos) y waveform (64B 0-100) — ambos críticos para PTT.
      // Sin ellos WhatsApp invalida el media con "audio ya no disponible".
      // El frontend manda seconds del timer del MediaRecorder; nosotros además
      // calculamos waveform desde el PCM con ffmpeg (no confiamos en audio-decode).
      let seconds = Number(parts.fields.seconds) || undefined;
      let waveform = null;
      if (wantsPtt && buffer && buffer.length) {
        try {
          const meta = await computePttMetadata(buffer);
          waveform = meta.waveform;
          if (!seconds) seconds = meta.seconds;
        } catch (e) {
          console.error('[send-media] computePttMetadata falló:', e.message);
        }
      }
      const session = numberId
        ? tenants.session(t.tenantId, numberId)
        : tenants.sessionForJid(t.tenantId, jid);
      if (!session) return res.status(404).json({ error: 'sin sesión disponible para este chat' });
      await session.sendMedia(jid, { url: uploaded.url, mimetype, fileName, caption, ptt: wantsPtt, seconds, waveform }, { quotedStanzaId });
      logAudit({
        tenantId: t.tenantId, actor: actorFrom(req), type: 'send-media',
        target: { jid, numberId: session.numberId },
        meta: { mimetype, size: buffer.length, fileName, hasCaption: !!caption, ptt: wantsPtt, seconds, waveform: !!waveform },
      });
      res.json({ ok: true, url: uploaded.url, numberId: session.numberId, ptt: wantsPtt, seconds });
    } catch (e) {
      if (e.status === 429) {
        const retryS = Math.ceil((e.retryAfterMs || 1000) / 1000);
        const tid = req.embedLocationId || req.apiKey?.tenantId || req.query.tenant;
        logAudit({ tenantId: tid, actor: actorFrom(req), type: 'send-blocked', meta: { reason: e.reason, retryAfterMs: e.retryAfterMs, media: true } });
        dispatchWebhook(tid, 'message.blocked', { reason: e.reason, retryAfterMs: e.retryAfterMs, media: true, actor: actorFrom(req) });
        return res.status(429).set('Retry-After', String(retryS)).json({ error: e.message, reason: e.reason, retryAfterMs: e.retryAfterMs });
      }
      console.error('[send-media]', e);
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // Resumen agregado: tenants/sesiones conectadas, mensajes enviados y bloqueados
  // por ventana (hoy/semana/mes) y top conversaciones por actividad reciente.
  // Consumo de la IA. Solo con backend Postgres: es donde se registra.
  app.get('/api/usage', async (req, res) => {
    try {
      const t = getTenant(req);
      if (!t.driver?.usageSummary) {
        return res.json({ available: false, reason: 'el registro de consumo requiere STATE_BACKEND=postgres', rows: [] });
      }
      const days = Math.min(Number(req.query.days) || 30, 365);
      const since = new Date(Date.now() - days * 86400_000);
      const rows = await t.driver.usageSummary({ since });
      const totals = rows.reduce((a, r) => ({
        calls: a.calls + r.calls,
        inputTokens: a.inputTokens + r.inputTokens,
        outputTokens: a.outputTokens + r.outputTokens,
      }), { calls: 0, inputTokens: 0, outputTokens: 0 });
      res.json({ available: true, days, rows, totals });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.get('/api/stats', requireAdmin, async (req, res) => {
    try {
      const tenantId = req.query.tenant || req.embedLocationId || req.apiKey?.tenantId || null;
      const stats = await computeStats({ tenantId });
      res.json(stats);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Audit log: lista las últimas acciones del operador. Filtros opcionales por
  // query string: tenant (default: todos), type, since (epoch ms), limit (default 200, max 500).
  app.get('/api/audit', requireAdmin, async (req, res) => {
    try {
      const tenantId = req.query.tenant || req.embedLocationId || req.apiKey?.tenantId || null;
      const type = req.query.type || null;
      const since = req.query.since ? Number(req.query.since) : null;
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
      const entries = await listAudit({ tenantId, type, since, limit });
      res.json({ entries });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // --- API keys ---
  // CRUD blindado: una key no puede gestionar otras keys (evita lockout y privilege escalation).
  function rejectIfBearer(req, res) {
    if (req.apiKey) {
      res.status(403).json({ error: 'Las API keys no pueden gestionar API keys — usa Basic Auth o la sesión embed' });
      return true;
    }
    return false;
  }

  app.get('/api/keys', requireAdmin, async (req, res) => {
    if (rejectIfBearer(req, res)) return;
    try {
      const t = getTenant(req);
      const keys = await listKeys({ tenantId: t.tenantId });
      res.json({ keys });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/keys', requireAdmin, async (req, res) => {
    if (rejectIfBearer(req, res)) return;
    try {
      const t = getTenant(req);
      const { label } = req.body || {};
      if (!label || !label.trim()) return res.status(400).json({ error: 'label requerido' });
      const created = await createKey({ label, tenantId: t.tenantId });
      logAudit({ tenantId: t.tenantId, actor: actorFrom(req), type: 'key-create', target: { keyId: created.id }, meta: { label: created.label } });
      // OJO: token completo solo se devuelve aquí (la primera y única vez)
      res.json({ ok: true, key: created });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.delete('/api/keys/:id', requireAdmin, async (req, res) => {
    if (rejectIfBearer(req, res)) return;
    try {
      const t = getTenant(req);
      const ok = await revokeKey(req.params.id);
      if (!ok) return res.status(404).json({ error: 'key no existe' });
      logAudit({ tenantId: t.tenantId, actor: actorFrom(req), type: 'key-revoke', target: { keyId: req.params.id } });
      res.json({ ok: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // --- Webhooks salientes ---
  // Mismo blindaje que keys: una API key NO puede gestionar webhooks.
  app.get('/api/webhooks', requireAdmin, async (req, res) => {
    if (rejectIfBearer(req, res)) return;
    try {
      const t = getTenant(req);
      const webhooks = await listWebhooks({ tenantId: t.tenantId });
      res.json({ webhooks, supportedEvents: WEBHOOK_EVENTS });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/webhooks', requireAdmin, async (req, res) => {
    if (rejectIfBearer(req, res)) return;
    try {
      const t = getTenant(req);
      const { url, events } = req.body || {};
      const created = await createWebhook({ tenantId: t.tenantId, url, events });
      logAudit({ tenantId: t.tenantId, actor: actorFrom(req), type: 'webhook-create', target: { webhookId: created.id }, meta: { url: created.url, events: created.events } });
      // El secret se muestra UNA vez en la respuesta del create — la lista subsiguiente lo oculta.
      res.json({ ok: true, webhook: created });
    } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
  });

  app.delete('/api/webhooks/:id', requireAdmin, async (req, res) => {
    if (rejectIfBearer(req, res)) return;
    try {
      const t = getTenant(req);
      const ok = await revokeWebhook(req.params.id);
      if (!ok) return res.status(404).json({ error: 'webhook no existe' });
      logAudit({ tenantId: t.tenantId, actor: actorFrom(req), type: 'webhook-revoke', target: { webhookId: req.params.id } });
      res.json({ ok: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // --- GHL Embed SSO ---
  app.post('/api/embed/sso', async (req, res) => {
    try {
      const { encryptedData, locationId: locFromUrl, userId, userEmail } = req.body || {};
      let locationId, userInfo = {};

      if (encryptedData) {
        const data = decryptGhlPayload(encryptedData, process.env.GHL_SHARED_SECRET);
        locationId = data.activeLocation || data.locationId;
        userInfo = { userId: data.userId, role: data.role, email: data.email, source: 'postmessage' };
      } else if (locFromUrl) {
        // Soft SSO: GHL substituyó {{location.id}} en el URL del Custom Menu Link.
        // No viene firmado: cualquiera que conozca un locationId obtendría una sesión
        // con todos los chats de ese tenant. Por eso está cerrado salvo para los
        // tenants listados en GHL_SOFT_SSO_TENANTS (coma), como salida de emergencia
        // para quien no pueda usar el SSO cifrado.
        const permitidos = (process.env.GHL_SOFT_SSO_TENANTS || '').split(',').map((s) => s.trim()).filter(Boolean);
        if (!permitidos.includes(locFromUrl)) {
          console.warn(`[embed sso] soft SSO rechazado para location=${locFromUrl} (no está en GHL_SOFT_SSO_TENANTS)`);
          return res.status(403).json({ error: 'Acceso sin firma deshabilitado: abre el panel desde la app de GHL' });
        }
        locationId = locFromUrl;
        userInfo = { userId, email: userEmail, source: 'url' };
      } else {
        return res.status(400).json({ error: 'encryptedData o locationId requerido' });
      }

      if (!locationId) return res.status(400).json({ error: 'locationId no encontrado en payload' });
      const tenant = tenants.get(locationId);
      if (!tenant) return res.status(404).json({ error: `Tenant ${locationId} no existe (instalar app primero)` });

      const signed = signSession(locationId, process.env.GHL_SHARED_SECRET);
      res.cookie(EMBED_COOKIE, signed, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: SESSION_TTL * 1000,
      });
      res.json({ locationId, ...userInfo });
    } catch (e) {
      console.error('[embed sso]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // --- GHL OAuth ---
  app.get('/oauth/install', (_req, res) => {
    const clientId = process.env.GHL_CLIENT_ID;
    const redirectUri = process.env.GHL_REDIRECT_URI || `${process.env.OPENROUTER_SITE_URL || ''}/oauth/callback`;
    if (!clientId) return res.status(500).send('GHL_CLIENT_ID no configurado');
    res.redirect(buildAuthorizeUrl({ clientId, redirectUri, scopes: GHL_SCOPES }));
  });

  app.get('/oauth/callback', async (req, res) => {
    try {
      const { code, error, error_description } = req.query;
      if (error) return res.status(400).send(`GHL OAuth error: ${error} ${error_description || ''}`);
      if (!code) return res.status(400).send('Falta code en callback');

      const tokens = await exchangeCode({
        code: String(code),
        clientId: process.env.GHL_CLIENT_ID,
        clientSecret: process.env.GHL_CLIENT_SECRET,
        redirectUri: process.env.GHL_REDIRECT_URI || `${process.env.OPENROUTER_SITE_URL || ''}/oauth/callback`,
        userType: 'Location',
      });

      // Caso A: token de Location directo → crear tenant
      if (tokens.locationId) {
        const tenantId = tokens.locationId;
        let tenant = tenants.get(tenantId);
        if (!tenant) tenant = await tenants.create(tenantId, { kind: 'ghl', companyId: tokens.companyId });
        tenant.setGhlTokens(tokens);
        console.log(`[oauth] tenant ${tenantId} instalado (company=${tokens.companyId})`);
        return res.send(successPage({ tenantId, companyId: tokens.companyId }));
      }

      // Caso B: token de Company (instalación a nivel agencia) → guardar y mostrar selector
      if (tokens.companyId) {
        await saveAgencyTokens(tokens);
        console.log(`[oauth] agency ${tokens.companyId} conectada — redirigiendo a selector`);
        return res.redirect(`/oauth/select-location?companyId=${encodeURIComponent(tokens.companyId)}`);
      }

      return res.status(500).send(`Tokens sin locationId ni companyId. userType=${tokens.userType}`);
    } catch (e) {
      console.error('[oauth callback]', e);
      res.status(500).send(`Error: ${e.message}`);
    }
  });

  // GET selector de location (cuando se instaló a nivel agencia)
  app.get('/oauth/select-location', async (req, res) => {
    try {
      const companyId = String(req.query.companyId || '');
      if (!companyId) return res.status(400).send('Falta companyId');
      const agency = await getFreshAgencyToken(companyId);
      const data = await listLocations({ accessToken: agency.accessToken, companyId });
      const locs = data.locations || [];
      const connected = new Set(
        tenants.list().filter((t) => t.ghl && t.ghl.companyId === companyId).map((t) => t.tenantId)
      );
      res.send(selectLocationPage({ companyId, locations: locs, connected }));
    } catch (e) {
      console.error('[select-location]', e);
      res.status(500).send(`Error: ${e.message}`);
    }
  });

  // POST conectar una location → derivar location token + crear tenant
  app.post('/oauth/connect-location', async (req, res) => {
    try {
      const { companyId, locationId } = req.body || {};
      if (!companyId || !locationId) return res.status(400).send('companyId y locationId requeridos');
      const agency = await getFreshAgencyToken(companyId);
      const locTokens = await getLocationToken({
        accessToken: agency.accessToken,
        companyId,
        locationId,
      });
      locTokens.locationId = locTokens.locationId || locationId;
      locTokens.companyId = locTokens.companyId || companyId;

      let tenant = tenants.get(locationId);
      if (!tenant) tenant = await tenants.create(locationId, { kind: 'ghl', companyId });
      tenant.setGhlTokens(locTokens);
      console.log(`[oauth] tenant ${locationId} conectado desde agencia ${companyId}`);

      res.send(successPage({ tenantId: locationId, companyId }));
    } catch (e) {
      console.error('[connect-location]', e);
      res.status(500).send(`Error: ${e.message}`);
    }
  });

  // --- GHL webhooks ---
  // GHL valida la delivery URL con GET antes de aceptarla
  app.get('/webhooks/ghl/outbound', (_req, res) => {
    res.json({ ok: true, service: 'whatsapp-agent-mystore', endpoint: 'ghl-outbound' });
  });

  // Quita los prefijos de eco "👤 " (operador) o "🤖 " (IA) que NOSOTROS añadimos
  // al pushear a GHL. Si vienen de vuelta vía /webhooks/ghl/outbound es porque el
  // mensaje del thread se duplicó o el operador copió texto con el prefijo.
  // Sin esta limpieza el contacto vería "👤 hola" en WhatsApp y el dashboard
  // mostraría burbujas duplicadas con el icono.
  function stripGhlEchoPrefix(text) {
    if (!text || typeof text !== 'string') return text;
    return text.replace(/^(?:👤|🤖)\s+/, '');
  }

  // GHL no firma el outbound del Conversation Provider, así que cualquiera que conozca
  // un locationId podía mandar WhatsApp desde la línea del cliente (y hacernos bajar
  // cualquier URL como adjunto). Ahora el mensaje se confirma en la API de GHL con el
  // token del tenant: tiene que existir, ser de esa location, de ese contacto y
  // saliente. El texto y los adjuntos se toman de GHL, no del body.
  // GHL_OUTBOUND_VERIFY: enforce (default) | report (verifica y solo avisa) | off.
  async function confirmarOutboundEnGhl(tenant, { locationId, contactId, messageId }) {
    if (!messageId) return { ok: false, reason: 'sin messageId' };
    if (!tenant.ghl?.accessToken) return { ok: false, reason: 'tenant sin GHL' };
    const client = new GHLClient(tenant);
    let lastErr;
    for (const espera of [0, 1500, 4000]) {
      if (espera) await new Promise((r) => setTimeout(r, espera));
      try {
        const r = await client.api('GET', `/conversations/messages/${encodeURIComponent(messageId)}`);
        const m = r?.message || r;
        if (!m || m.locationId !== locationId) return { ok: false, reason: 'location no coincide' };
        if (contactId && m.contactId !== contactId) return { ok: false, reason: 'contacto no coincide' };
        if (m.direction && m.direction !== 'outbound') return { ok: false, reason: `dirección ${m.direction}` };
        return { ok: true, msg: m };
      } catch (e) {
        lastErr = e; // 404 justo al crearse, red, o token: se reintenta
      }
    }
    return { ok: false, reason: lastErr?.message?.slice(0, 160) || 'sin respuesta' };
  }

  app.post('/webhooks/ghl/outbound', async (req, res) => {
    // GHL → nosotros cuando el operador escribe en la UI de Conversations.
    // Payload típico: { type, locationId, contactId, messageId, message, phone, attachments, userId }
    const body = req.body || {};
    const { locationId, contactId, phone, messageId } = body;
    let { attachments } = body;
    let message = stripGhlEchoPrefix(body.message);
    let hasMedia = Array.isArray(attachments) && attachments.length > 0;
    // Sin teléfono en el log: es dato personal y los logs se conservan.
    console.log(`[webhook outbound] location=${locationId} contact=${contactId} msgId=${messageId} attachments=${hasMedia ? attachments.length : 0}`);

    res.json({ ok: true, queued: true });

    if (!locationId) return;
    if (!message && !hasMedia) return;
    const tenant = tenants.get(locationId);
    if (!tenant) return console.warn(`[webhook outbound] tenant ${locationId} no existe`);

    const modoVerif = (process.env.GHL_OUTBOUND_VERIFY || 'enforce').toLowerCase();
    if (modoVerif !== 'off') {
      const v = await confirmarOutboundEnGhl(tenant, { locationId, contactId, messageId });
      if (!v.ok) {
        console.warn(`[webhook outbound] NO confirmado en GHL (${v.reason}) location=${locationId} msgId=${messageId}${modoVerif === 'report' ? ' — modo report, se envía igual' : ' — descartado'}`);
        if (modoVerif !== 'report') return;
      } else {
        // Lo que se envía es lo que GHL tiene guardado, no lo que dijo el body.
        message = stripGhlEchoPrefix(v.msg.body ?? message);
        if (Array.isArray(v.msg.attachments)) attachments = v.msg.attachments;
        hasMedia = Array.isArray(attachments) && attachments.length > 0;
        if (!message && !hasMedia) return;
      }
    }

    // 1) intentar resolver JID via contactId (correcto incluso con LID)
    let jid = contactId ? tenant.getJidByContactId(contactId) : null;
    // 2) fallback: convertir phone → JID estándar (solo válido si no es LID)
    if (!jid && phone) jid = phoneToJid(phone);
    if (!jid) return console.warn(`[webhook outbound] no se pudo resolver jid: contactId=${contactId}`);

    // Routing multi-número: usa el número que último interactuó con este contacto.
    const session = tenants.sessionForJid(locationId, jid);
    if (!session) return console.warn(`[webhook outbound] session ${locationId} no existe`);

    // Guardia anti-loop: si nosotros pusheamos este mensaje a GHL via
    // /conversations/messages/outbound (operador-desde-celular o IA), el
    // messageId quedó marcado en _outboundSeen. Si GHL nos lo devuelve como
    // webhook (no debería, pero por si acaso), descartamos sin reenviar.
    if (messageId && session.isOutboundSeen(messageId)) {
      console.log(`[webhook outbound] msgId=${messageId} es eco de nuestro push outbound — skip`);
      return;
    }

    const isNewConv = !tenant.conversations.has(jid);
    console.log(`[webhook outbound] enviando vía número '${session.numberId}'${isNewConv ? ' (conv nueva para este jid)' : ''}`);

    session.markOutboundSent(messageId);

    // Retry con backoff exponencial. Cubre desconexiones cortas de Baileys + glitches transitorios.
    const delays = [1_000, 3_000, 9_000];
    let lastErr;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        if (hasMedia) {
          // Enviar cada attachment como media, con el texto como caption del primero
          for (let i = 0; i < attachments.length; i++) {
            const url = typeof attachments[i] === 'string' ? attachments[i] : attachments[i]?.url;
            if (!url) continue;
            await session.sendMedia(jid, {
              url,
              caption: i === 0 ? (message || undefined) : undefined,
            }, { skipGhlMirror: true });
          }
        } else {
          await session.send(jid, message, { skipGhlMirror: true });
        }
        if (tenant.getOrCreateConversation(jid).mode !== 'human') {
          tenant.setMode(jid, 'human', 'ghl');
          console.log(`[webhook outbound] modo humano activado para ${jid}`);
        }
        console.log(`[webhook outbound] enviado a ${jid}${attempt ? ` (tras ${attempt} reintento(s))` : ''}`);
        return;
      } catch (e) {
        lastErr = e;
        const next = delays[attempt];
        console.warn(`[webhook outbound] intento ${attempt + 1} falló: ${e.message}${next ? ` — reintento en ${next}ms` : ''}`);
        if (next) await new Promise((r) => setTimeout(r, next));
      }
    }
    console.error(`[webhook outbound] dropped tras ${delays.length + 1} intentos: ${lastErr?.message}`);
    // Grabamos el mensaje del operador localmente aunque falle la entrega, para que
    // el dashboard NO quede desincronizado vs GHL Conversations. Antes solo se
    // añadía un system bubble con el error — el contenido se "perdía" para la app.
    const firstAttachmentUrl = hasMedia
      ? (typeof attachments[0] === 'string' ? attachments[0] : attachments[0]?.url)
      : null;
    tenant.addMessage(jid, {
      role: 'assistant', manual: true, fromGhl: true, deliveryFailed: true,
      text: message || '',
      ...(firstAttachmentUrl ? { attachment: { url: firstAttachmentUrl, type: 'document' } } : {}),
    });
    tenant.addMessage(jid, {
      role: 'system',
      text: `⚠️ No entregado a WhatsApp tras ${delays.length + 1} intentos: ${lastErr?.message || 'desconocido'}`,
    });
  });

  // Todo /api/debug es solo para admin: devuelve webhooks y metadatos de todos los
  // tenants (nombres, teléfonos, correos). Antes bastaba la cookie de un embed 'client'.
  app.use('/api/debug', requireAdmin);

  // Debug: empuja un mensaje de prueba a GHL Conversations para diagnosticar
  app.post('/api/debug/ghl-inbound', async (req, res) => {
    try {
      const { tenant: tenantId = '_local', phone, message = 'test desde debug', type } = req.body || {};
      const tenant = tenants.get(tenantId);
      if (!tenant) return res.status(404).json({ error: `tenant ${tenantId} no existe` });
      if (!tenant.ghl) return res.status(400).json({ error: 'tenant sin GHL conectado' });
      if (!phone) return res.status(400).json({ error: 'phone requerido (E.164 con +)' });

      const client = new GHLClient(tenant);
      const contact = await client.findOrCreateContact({ phone, name: 'Debug' }).catch((e) => ({ _err: e.message }));
      if (contact?._err) return res.json({ step: 'findOrCreateContact', error: contact._err });

      const args = {
        contactId: contact.id,
        message,
        conversationProviderId: process.env.GHL_CONVERSATION_PROVIDER_ID,
        altId: `debug:${Date.now()}`,
        ...(type ? { type } : {}),
      };
      const resp = await client.sendInboundMessage(args).catch((e) => ({ _err: e.message }));

      res.json({ tried: { type: type || 'default', providerId: process.env.GHL_CONVERSATION_PROVIDER_ID }, contact: { id: contact.id, name: contact.firstName, phone: contact.phone }, ghlResponse: resp });
    } catch (e) {
      res.status(500).json({ error: e.message, stack: e.stack });
    }
  });

  // Ring buffer en memoria de los últimos webhooks GHL recibidos.
  // Expuesto vía GET /api/debug/ghl-webhooks para diagnosticar sin SSH.
  const _ghlWebhookLog = [];
  function recordGhlWebhook(entry) {
    _ghlWebhookLog.unshift({ ts: Date.now(), ...entry });
    if (_ghlWebhookLog.length > 50) _ghlWebhookLog.length = 50;
  }

  app.get('/api/debug/ghl-webhooks', (_req, res) => res.json({ events: _ghlWebhookLog }));

  // Inspector de metadata GHL por conv: muestra ghlConversationId, cuántos mensajes
  // tienen ghlMessageId, y el último msgId. Útil para confirmar que la captura
  // post-_pushInboundToGHL está funcionando antes de probar el markRead.
  app.get('/api/debug/conv-meta', (req, res) => {
    try {
      const t = getTenant(req);
      const jid = req.query.jid;
      if (!jid) {
        // Sin jid: lista todas las convs con metadata resumida
        const all = [];
        for (const c of t.conversations.values()) {
          const withId = c.messages.filter((m) => m.ghlMessageId).length;
          all.push({
            jid: c.jid, name: c.name, unreadCount: c.unreadCount || 0,
            ghlConversationId: c.ghlConversationId || null,
            messagesWithGhlId: withId,
            totalMessages: c.messages.length,
          });
        }
        return res.json({ convs: all });
      }
      const conv = t.conversations.get(jid);
      if (!conv) return res.status(404).json({ error: 'conv no existe' });
      res.json({
        jid: conv.jid, name: conv.name, unreadCount: conv.unreadCount || 0,
        ghlConversationId: conv.ghlConversationId || null,
        messages: conv.messages.slice(-20).map((m) => ({
          id: m.id, role: m.role, ts: m.ts, readAt: m.readAt,
          ghlMessageId: m.ghlMessageId || null,
          ghlConversationId: m.ghlConversationId || null,
          text: (m.text || '').slice(0, 50),
        })),
      });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // Dispara markRead manual con respuesta detallada — para probar sin abrir el chat.
  app.post('/api/debug/force-mark-read', async (req, res) => {
    try {
      const t = getTenant(req);
      const { jid } = req.body || {};
      if (!jid) return res.status(400).json({ error: 'jid requerido' });
      const session = tenants.sessionForJid(t.tenantId, jid);
      if (!session) return res.status(404).json({ error: 'sin sesión WA' });
      // Capturamos la respuesta del GHL markConversation también
      const conv = t.conversations.get(jid);
      const ghlConvId = conv?.ghlConversationId
        || conv?.messages?.findLast?.((m) => m.ghlConversationId)?.ghlConversationId;
      let ghlConvResp = { skipped: 'no ghlConversationId' };
      if (ghlConvId && t.ghl?.accessToken) {
        try {
          const ghl = new GHLClient(t);
          ghlConvResp = await ghl.markConversationAsRead(ghlConvId);
        } catch (e) {
          ghlConvResp = { error: e.message };
        }
      }
      const result = await session.markRead(jid);
      res.json({ ok: true, jid, ghlConvId, ghlConvResp, ...result });
    } catch (e) { res.status(e.status || 500).json({ error: e.message, stack: e.stack }); }
  });

  // GET validation: GHL puede validar el URL con GET antes de aceptarlo
  app.get('/webhooks/ghl', (_req, res) => res.json({ ok: true, service: 'whatsapp-agent-mystore', endpoint: 'ghl-events' }));

  // Webhook genérico de eventos (ContactCreate, OutboundMessage, etc.).
  // Guard de firma ACTIVO: con GHL_WEBHOOK_PUBLIC_KEY configurada se rechazan
  // webhooks sin firma RSA válida; sin la key, acepta con warning (instalaciones
  // que no usan GHL no se ven afectadas).
  app.post('/webhooks/ghl', ghlWebhookGuard, (req, res) => {
    const body = req.body || {};
    const type = body.type;
    const sigHeader = req.headers['x-wh-signature'] || null;
    const altSig = req.headers['x-ghl-signature'] || null;
    // Captura completa para inspección posterior — incluye headers para ver si
    // GHL está firmando o no, y qué nombres de campos usa en el payload real.
    recordGhlWebhook({
      type, body,
      hasSignature: !!sigHeader,
      hasAltSignature: !!altSig,
      userAgent: req.headers['user-agent'] || null,
      keys: Object.keys(body),
    });
    console.log(`[webhook ghl] type=${type} location=${body.locationId} sig=${sigHeader ? 'present' : 'MISSING'} keys=${Object.keys(body).join(',')}`);
    res.json({ ok: true });

    // Dirección inversa de read sync: cuando alguien marca un chat como leído en
    // GHL Conversations, queremos reflejarlo en la app y mandar doble-check azul
    // al contacto vía WA. Aceptamos varios nombres de evento por defensividad.
    if (type === 'ConversationUnreadUpdate' || type === 'ConversationRead' || type === 'MessageRead') {
      handleGhlReadUpdate(body).catch((e) => console.error('[webhook ghl read]', e.message));
    }
  });

  async function handleGhlReadUpdate(body) {
    const { locationId, contactId, conversationId } = body;
    // GHL puede mandar unreadCount como number o string. También puede haber un
    // unread (boolean) en algunas versiones.
    const unreadCount = body.unreadCount;
    const unreadFlag = body.unread;
    const isRead = (
      unreadCount === 0 || unreadCount === '0' ||
      unreadFlag === false || unreadFlag === 'false'
    );
    if (!locationId) return console.warn('[webhook ghl read] sin locationId');
    if (!isRead) {
      console.log(`[webhook ghl read] skip: unreadCount=${unreadCount} unread=${unreadFlag}`);
      return;
    }
    const tenant = tenants.get(locationId);
    if (!tenant) return console.warn(`[webhook ghl read] tenant ${locationId} no existe`);
    const jid = contactId ? tenant.getJidByContactId(contactId) : null;
    if (!jid) return console.warn(`[webhook ghl read] no se pudo resolver jid: contactId=${contactId} conversationId=${conversationId}`);
    const session = tenants.sessionForJid(locationId, jid);
    // skipGhl: no devolver la lectura a GHL (loop).
    let result;
    if (session) result = await session.markRead(jid, { skipGhl: true });
    else { tenant.markConversationRead(jid); result = { read: 'no-session' }; }
    console.log(`[webhook ghl read] sincronizado jid=${jid} (desde GHL) → ${JSON.stringify(result)}`);
  }

  // --- Twenty-CRM webhooks ---
  // Twenty avisa cuando se edita un contacto → renombramos el chat de WhatsApp.
  // Cuelga de /webhooks/ porque authMiddleware deja ese prefijo público (Twenty
  // no tiene cookie de dashboard). Si CRM_WEBHOOK_SECRET está definido se exige
  // en el header x-crm-secret; sin él el endpoint queda abierto en la LAN.
  // Twenty manda el payload como { eventName, record }; aceptamos también
  // { event, data } por si se mete un relay (n8n) en medio.
  app.post('/webhooks/crm', async (req, res) => {
    const expected = process.env.CRM_WEBHOOK_SECRET;
    if (expected && req.headers['x-crm-secret'] !== expected) {
      return res.status(401).json({ error: 'secret inválido' });
    }

    const body = req.body || {};
    const event = body.eventName || body.event || '';
    const record = body.record || body.data || {};
    const phone = record?.phones?.primaryPhoneNumber || record?.phone;
    const first = record?.name?.firstName ?? record?.firstName;
    const last = record?.name?.lastName ?? record?.lastName;

    console.log(`[webhook crm] event=${event} phone=${phone} name=${first} ${last}`);

    if (!phone) return res.json({ received: true, skipped: 'sin telefono' });

    const crmName = [first, last].filter(Boolean).join(' ').trim();
    if (!crmName) return res.json({ received: true, skipped: 'sin nombre' });

    const { updateContactName } = await import('./crm-state.js');
    updateContactName(phone, first, last);

    // El phoneIndex guarda el teléfono en formato E.164 (+593...), Twenty puede
    // guardarlo sin prefijo ni país. Probamos las variantes conocidas.
    const digits = String(phone).replace(/[^\d]/g, '');
    const candidates = [...new Set([
      phone,
      `+${digits}`,
      digits,
      `+593${digits}`,
      `593${digits}`,
    ])];

    const renamed = [];
    for (const t of tenants.list()) {
      const store = tenants.get(t.tenantId);
      if (!store?.canonicalJidForPhone) continue;
      for (const cand of candidates) {
        const jid = store.canonicalJidForPhone(cand);
        if (jid && store.setContactName(jid, crmName)) {
          console.log(`[webhook crm] chat ${jid} renombrado → ${crmName}`);
          renamed.push(jid);
          break;
        }
      }
    }

    res.json({ received: true, renamed });
  });

  // --- Socket.io ---
  const httpServer = http.createServer(app);
  // El socket emite el snapshot completo de un tenant (conversaciones, teléfonos,
  // adjuntos, config). Antes aceptaba cualquier conexión y cualquier 'subscribe':
  // bastaba conocer un locationId. Ahora:
  //   1. allowRequest: un navegador solo puede abrirlo desde el mismo dominio (o los
  //      de SOCKET_ALLOWED_ORIGINS). Importa porque la cookie de embed es
  //      SameSite=None: otra web podría abrir el socket con la cookie de la víctima.
  //   2. io.use: exige la misma credencial que la API HTTP.
  //   3. subscribe: el tenant se limita igual que getTenant().
  const origenesExtra = (process.env.SOCKET_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const io = new IOServer(httpServer, {
    allowRequest: (req, cb) => {
      const origin = req.headers.origin;
      if (!origin) return cb(null, true); // clientes no-navegador (API key)
      let ok = origenesExtra.includes(origin);
      try { ok = ok || new URL(origin).host === req.headers.host; } catch {}
      if (!ok) console.warn(`[socket] origen rechazado: ${origin}`);
      cb(null, ok);
    },
  });

  io.use(async (socket, next) => {
    const raw = socket.handshake.headers.cookie || '';
    const cookies = {};
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) {
        try { cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {}
      }
    }

    const dash = cookies[DASHBOARD_SESSION_COOKIE];
    if (dash) {
      const session = verifyDashboardSession(dash);
      if (session) { socket.data.session = session; return next(); }
    }

    const emb = cookies[EMBED_COOKIE];
    if (emb) {
      const value = verifySession(emb, process.env.GHL_SHARED_SECRET || 'dev');
      if (value) {
        const [locationId, scope] = String(value).split('|');
        // Un embed queda fijado a su sub-cuenta aunque sea 'admin' (igual que getTenant).
        socket.data.session = { role: 'client', tenantId: locationId, embedScope: scope === 'admin' ? 'admin' : 'client' };
        return next();
      }
    }

    const token = socket.handshake.auth?.token;
    if (token) {
      const key = await verifyToken(token).catch(() => null);
      if (key) {
        socket.data.session = key.tenantId ? { role: 'client', tenantId: key.tenantId } : { role: 'admin', apiKey: true };
        return next();
      }
    }

    // Misma puerta trasera que authMiddleware (Basic con DASHBOARD_USER/PASS).
    const [scheme, encoded] = String(socket.handshake.headers.authorization || '').split(' ');
    const envUser = process.env.DASHBOARD_USER, envPass = process.env.DASHBOARD_PASS;
    if (envUser && envPass && scheme === 'Basic' && encoded) {
      const [u, p] = Buffer.from(encoded, 'base64').toString().split(':');
      if (u === envUser && p === envPass) { socket.data.session = { role: 'admin', envFallback: true }; return next(); }
    }

    return next(new Error('no autenticado'));
  });

  // Tenants que una sesión de socket puede ver. null = todos (admin).
  function tenantsPermitidos(s) {
    if (s?.role === 'admin') return null;
    if (s?.tenantIds?.length) return s.tenantIds;
    return s?.tenantId ? [s.tenantId] : [];
  }

  io.on('connection', (socket) => {
    socket.on('subscribe', (tenantId) => {
      const permitidos = tenantsPermitidos(socket.data.session);
      if (permitidos && !permitidos.includes(tenantId)) {
        console.warn(`[socket] subscribe rechazado: ${socket.data.session?.username || 'embed/api'} → ${tenantId}`);
        return;
      }
      socket.join(`tenant:${tenantId}`);
      const t = tenants.get(tenantId);
      if (t) {
        const snap = t.snapshot();
        snap.metrics = tenants.session(tenantId)?.getMetrics() || null;
        socket.emit('state', snap);
      }
    });
  });

  // Espejo de SALIENTES al CRM de la suite. Los entrantes ('user') los empuja
  // whatsapp.js con teléfono resuelto y pushName; aquí capturamos lo que sale
  // (IA y operador) en un solo punto, venga del dashboard, del CRM o del flujo
  // automático. 'system' se filtra en pushMessageToCrm (avisos internos).
  if (crmLocalConfigured()) {
    tenants.on('message', (payload) => {
      const msg = payload?.message;
      if (!msg || msg.role === 'user' || payload.conversation?.isGroup) return;
      // Teléfono por búsqueda inversa en el índice del tenant (registerPhone corre
      // ANTES de addMessage en los flujos entrante y fromMe, así que ya está).
      // Sin esto, un chat iniciado por el operador llegaba al CRM sin teléfono y
      // el contacto nacía como el genérico "Contacto de WhatsApp".
      const store = tenants.get(payload.tenantId);
      pushMessageToCrm({
        waJid: payload.jid,
        phone: store?.phoneForJid?.(payload.jid) || null,
        name: payload.conversation?.name || null,
        text: msg.text,
        // Lo tecleado por el operador (desde el celular llega como assistant con
        // manual:true) debe verse como humano en el CRM, no como IA.
        role: msg.manual ? 'manual' : msg.role,
        waMessageId: msg.id || null,
        ts: msg.ts || null,
        ...(msg.attachment ? { attachment: msg.attachment } : {}),
      }).catch((e) => console.error(`[crm:${payload.tenantId}] push outbound`, e.message));
    });
  }

  for (const ev of ['message', 'mode', 'config', 'connection', 'metrics', 'conv:removed', 'read', 'lab']) {
    tenants.on(ev, (payload) => {
      io.to(`tenant:${payload.tenantId}`).emit(ev, payload);
    });
  }
  tenants.on('tenant:added', ({ tenantId }) => io.emit('tenant:added', { tenantId }));

  httpServer.listen(port, () => {
    console.log(`[server] http://localhost:${port}`);
  });
  return httpServer;
}
