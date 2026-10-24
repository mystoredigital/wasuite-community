import { NextResponse } from "next/server";
import { eq, isNotNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { getAgentState, phoneFromJid } from "@/server/agent";

export const dynamic = "force-dynamic";

/**
 * Estado del inbox, ahora desde Postgres: el agente empuja cada mensaje por la
 * ingesta y aquí solo leemos la base. Ventajas sobre el proxy anterior:
 *   - El historial sobrevive aunque el agente caiga o se reinstale.
 *   - Sin límite de 200 mensajes por chat (traemos los últimos 100 por conversación,
 *     configurable abajo).
 * El agente solo aporta el estado de la conexión (QR/conectado) — y si no responde,
 * el inbox sigue funcionando con lo persistido.
 */

const MESSAGES_PER_CONVERSATION = 100;

type MsgRow = {
  id: string;
  contact_id: string;
  role: "user" | "assistant" | "operator";
  text: string | null;
  media_url: string | null;
  media_type: string | null;
  transcription: string | null;
  wa_message_id: string | null;
  ts_ms: number;
};

export async function GET() {
  const db = getDb();

  // Resumen por conversación: contacto + etapa del pipeline + no-leídos.
  const convRows = await db
    .select({
      contactId: schema.contact.id,
      name: schema.contact.name,
      phone: schema.contact.phone,
      waJid: schema.contact.waJid,
      stage: schema.pipelineStage.name,
      unread: sql<number>`count(*) filter (where ${schema.message.role} = 'user' and ${schema.message.readAt} is null)::int`,
      lastTsMs: sql<number>`(extract(epoch from max(${schema.message.ts})) * 1000)::double precision`,
    })
    .from(schema.contact)
    .innerJoin(schema.message, eq(schema.message.contactId, schema.contact.id))
    .leftJoin(schema.lead, eq(schema.lead.contactId, schema.contact.id))
    .leftJoin(schema.pipelineStage, eq(schema.pipelineStage.id, schema.lead.stageId))
    .where(isNotNull(schema.contact.waJid))
    .groupBy(schema.contact.id, schema.contact.name, schema.contact.phone, schema.contact.waJid, schema.pipelineStage.name);

  // Últimos N mensajes de cada conversación en una sola query (window function).
  const msgRows = (await db.execute(sql`
    select id, contact_id, role, text, media_url, media_type, transcription, wa_message_id,
           (extract(epoch from ts) * 1000)::double precision as ts_ms
    from (
      select m.*, row_number() over (partition by m.contact_id order by m.ts desc, m.created_at desc) as rn
      from message m
    ) sub
    where rn <= ${MESSAGES_PER_CONVERSATION}
    order by ts_ms asc
  `)) as unknown as MsgRow[];

  const msgsByContact = new Map<string, MsgRow[]>();
  for (const m of msgRows) {
    const list = msgsByContact.get(m.contact_id) ?? [];
    list.push(m);
    msgsByContact.set(m.contact_id, list);
  }

  const conversations = convRows
    .map((c) => ({
      jid: c.waJid!,
      name: c.name,
      isGroup: false,
      messages: (msgsByContact.get(c.contactId) ?? []).map((m) => ({
        id: m.wa_message_id ?? m.id,
        role: m.role,
        text: m.text ?? undefined,
        ts: m.ts_ms,
        attachment: m.media_url
          ? { url: m.media_url, type: m.media_type ?? undefined, transcription: m.transcription ?? undefined }
          : undefined,
      })),
      updatedAt: c.lastTsMs,
      unreadCount: c.unread,
      phone: c.phone ?? phoneFromJid(c.waJid!),
      crm: { contactId: c.contactId, stage: c.stage },
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  // Estado de conexión del agente (QR/conectado) — best-effort: si el agente no
  // responde, el inbox sigue sirviendo el historial persistido.
  let connection: { state?: string } | null = null;
  let agentError: string | null = null;
  try {
    const state = await getAgentState();
    connection = state.connection ?? null;
  } catch (e) {
    agentError = (e as Error).message;
  }

  return NextResponse.json({
    configured: true,
    connection,
    agentError,
    conversations,
  });
}
