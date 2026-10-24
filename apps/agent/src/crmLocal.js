// Integración con el CRM de la suite (apps/crm). Cuando entra un mensaje de
// WhatsApp, el agente avisa al CRM para que cree/actualice el contacto y le abra
// un lead en el pipeline. Es el gemelo de la integración con GHL, pero apuntando
// al CRM propio de wasuite.
//
// Detrás de env vars: si CRM_INGEST_URL/CRM_INGEST_KEY no están, no hace nada
// (la integración queda apagada y el agente se comporta igual que antes).

const CRM_INGEST_URL = process.env.CRM_INGEST_URL;
const CRM_INGEST_KEY = process.env.CRM_INGEST_KEY;
const CRM_TIMEOUT_MS = Number(process.env.CRM_INGEST_TIMEOUT_MS ?? 10000);

export function crmLocalConfigured() {
  return !!(CRM_INGEST_URL && CRM_INGEST_KEY);
}

// Mapea el rol interno del agente al del CRM. 'manual' (operador desde el
// dashboard) → 'operator'. 'system' devuelve null: son avisos internos
// (“push GHL falló”, etc.) que no pertenecen al historial del cliente.
function mapRole(role) {
  if (role === 'user' || role === 'assistant') return role;
  if (role === 'manual') return 'operator';
  return null;
}

// Empuja un mensaje al CRM (entrante o saliente). Devuelve el JSON del CRM, o
// null si no está configurado o el rol no aplica. Lanza si el CRM responde con
// error (el caller decide qué hacer).
// Clave: waJid (el identificador de WhatsApp). Con @lid no hay teléfono, así que
// el waJid es lo único estable — por eso el CRM crea el contacto igual.
// El CRM además persiste el mensaje (deduplicado por waMessageId), así el
// historial sobrevive aunque el agente se reinstale.
export async function pushMessageToCrm({ waJid, phone, name, text, role, waMessageId, ts, attachment }) {
  if (!crmLocalConfigured()) return null;
  if (!waJid && !phone) return null;
  const crmRole = mapRole(role || 'user');
  if (!crmRole) return null;

  const res = await fetch(CRM_INGEST_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CRM_INGEST_KEY,
    },
    body: JSON.stringify({
      waJid: waJid || null,
      phone: phone || null,
      name: name || null,
      message: text || null,
      role: crmRole,
      waMessageId: waMessageId || null,
      ts: ts || null,
      media: attachment?.url
        ? { url: attachment.url, type: attachment.type || null, transcription: attachment.transcription || null }
        : null,
    }),
    signal: AbortSignal.timeout(CRM_TIMEOUT_MS),
  }).catch((e) => {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new Error(`CRM timeout (${CRM_TIMEOUT_MS / 1000}s)`);
    }
    throw e;
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`CRM ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}
