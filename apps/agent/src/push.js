// Notificaciones push al navegador (Web Push).
//
// El agente es quien sabe que entró un mensaje, así que es quien envía. Las
// suscripciones las registra el CRM desde el navegador, y ambos comparten la
// misma base — por eso el agente puede leerlas sin pedirle nada al CRM.
//
// Sin VAPID configurado esto es un no-op silencioso: el agente sigue funcionando
// igual y solo se pierden los avisos.

import webpush from 'web-push';
import { db, isPgBackend } from './db.js';

let configurado = false;

export function pushConfigurado() {
  if (configurado) return true;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv || !isPgBackend()) return false;
  webpush.setVapidDetails(
    // El "subject" es un contacto del emisor, obligatorio en el estándar. Con un
    // mailto genérico basta; algunos servicios rechazan el envío si falta.
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    pub,
    priv,
  );
  configurado = true;
  return true;
}

/**
 * Envía una notificación a todos los navegadores suscritos.
 *
 * Nunca lanza: un fallo al avisar no puede tumbar el mensaje que lo provocó, que
 * es lo que de verdad importa. Los endpoints muertos se limpian solos — cuando un
 * usuario revoca el permiso o desinstala la PWA, su endpoint empieza a responder
 * 404/410 y hay que dejar de intentarlo o la tabla se llena de basura.
 *
 * @param {object} aviso
 * @param {string} aviso.titulo
 * @param {string} aviso.cuerpo
 * @param {string} [aviso.url]    a dónde lleva el clic
 * @param {string} [aviso.tag]    agrupa avisos del mismo chat en vez de apilarlos
 * @param {string} [aviso.exceptoUsuario] no avisar a quien provocó el evento
 */
export async function notificar({ titulo, cuerpo, url = '/inbox', tag, exceptoUsuario = null }) {
  if (!pushConfigurado()) return { enviados: 0, motivo: 'push no configurado' };

  const sql = db();
  let subs;
  try {
    subs = exceptoUsuario
      ? await sql`SELECT * FROM push_subscription WHERE username IS DISTINCT FROM ${exceptoUsuario}`
      : await sql`SELECT * FROM push_subscription`;
  } catch (e) {
    console.warn('[push] no se pudieron leer las suscripciones:', e.message);
    return { enviados: 0, motivo: e.message };
  }
  if (!subs.length) return { enviados: 0, motivo: 'sin suscripciones' };

  const payload = JSON.stringify({ titulo, cuerpo, url, tag });
  let enviados = 0;

  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
          { TTL: 3600 },
        );
        enviados++;
        if (s.failedAt) {
          await sql`UPDATE push_subscription SET failed_at = NULL WHERE id = ${s.id}`;
        }
      } catch (e) {
        const code = e.statusCode;
        if (code === 404 || code === 410) {
          // El navegador ya no existe para ese endpoint: no volverá.
          await sql`DELETE FROM push_subscription WHERE id = ${s.id}`.catch(() => {});
        } else if (s.failedAt) {
          // Segundo fallo seguido: se descarta en vez de reintentar para siempre.
          await sql`DELETE FROM push_subscription WHERE id = ${s.id}`.catch(() => {});
        } else {
          await sql`UPDATE push_subscription SET failed_at = now() WHERE id = ${s.id}`.catch(() => {});
        }
      }
    }),
  );

  return { enviados, total: subs.length };
}

// Recorta el texto del mensaje para que quepa en el aviso del sistema.
export function resumen(texto, max = 120) {
  const t = (texto || '').replace(/\s+/g, ' ').trim();
  if (!t) return '(sin texto)';
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
