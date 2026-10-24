import { asc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";

/**
 * Ingesta desde el agente de WhatsApp. Cuando entra un mensaje, el agente llama al
 * CRM con el identificador de WhatsApp (waJid) y, si lo tiene, el teléfono y el nombre.
 *
 *   1. Se busca el contacto por waJid (clave estable, funciona con @lid que oculta el
 *      teléfono); si no, por teléfono. Si no existe, se crea.
 *   2. Si el contacto no tiene lead, se le abre uno en la primera etapa del pipeline.
 *   3. Se refresca la actividad del lead.
 *
 * Todo en una transacción: dos mensajes casi simultáneos del mismo contacto no deben
 * crear dos contactos ni dos leads.
 */

// Nombre por defecto cuando WhatsApp no entrega ni pushName ni teléfono.
const GENERIC_NAME = "Contacto de WhatsApp";

// ¿El nombre guardado es un placeholder (vacío, el default genérico, el teléfono,
// o solo dígitos)? Un placeholder SIEMPRE se puede mejorar con un nombre real.
function isPlaceholderName(name: string | null, phone: string | null): boolean {
  if (!name) return true;
  const n = name.trim();
  if (n === "" || n === GENERIC_NAME || (phone && n === phone)) return true;
  return /^\+?\d[\d\s-]{5,}$/.test(n);
}

// El teléfono viene implícito en los JID clásicos ("593…@s.whatsapp.net").
// Derivarlo evita contactos sin teléfono (y sin nombre legible) cuando WhatsApp
// no manda pushName. Los @lid ocultan el número: ahí no hay nada que derivar.
function phoneFromWaJid(waJid: string | null): string | null {
  const m = waJid?.match(/^(\d{7,15})@s\.whatsapp\.net$/);
  return m ? `+${m[1]}` : null;
}

export type IngestResult = {
  contactId: string;
  leadId: string;
  contactCreated: boolean;
  leadCreated: boolean;
  messageId: string | null;
};

export type IngestMessageInput = {
  waJid?: string | null;
  phone?: string | null;
  name?: string | null;
  message?: string | null;
  // 'user' (cliente) | 'assistant' (IA) | 'operator' (humano). Default 'user'.
  role?: "user" | "assistant" | "operator" | null;
  // Id del mensaje en WhatsApp — deduplica reintentos del push del agente.
  waMessageId?: string | null;
  // Epoch ms del mensaje (default: ahora).
  ts?: number | null;
  media?: { url?: string | null; type?: string | null; transcription?: string | null } | null;
};

export async function ingestWhatsApp(input: IngestMessageInput): Promise<IngestResult> {
  const waJid = input.waJid?.trim() || null;
  const phone = input.phone?.trim() || phoneFromWaJid(waJid);
  const name = input.name?.trim() || null;
  const role = input.role ?? "user";
  if (!waJid && !phone) throw new Error("waJid o phone requerido");

  const db = getDb();
  return db.transaction(async (tx) => {
    // 1. Contacto: buscar por waJid (preferente) y luego por teléfono.
    let contact: typeof schema.contact.$inferSelect | undefined;
    if (waJid) {
      [contact] = await tx.select().from(schema.contact).where(eq(schema.contact.waJid, waJid));
    }
    if (!contact && phone) {
      [contact] = await tx.select().from(schema.contact).where(eq(schema.contact.phone, phone));
    }

    let contactCreated = false;
    if (!contact) {
      // Si el "nombre" entrante es placeholder (dígitos sueltos del JID) y tenemos
      // teléfono, mejor mostrar el teléfono formateado — se ve como contacto, no
      // como identificador crudo.
      const realName = name && !isPlaceholderName(name, phone) ? name : null;
      [contact] = await tx
        .insert(schema.contact)
        .values({
          name: realName || phone || name || GENERIC_NAME,
          phone,
          waJid,
          source: "whatsapp",
        })
        .returning();
      contactCreated = true;
    } else {
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      // Completar datos que antes faltaban.
      if (waJid && !contact.waJid) patch.waJid = waJid;
      if (phone && !contact.phone) patch.phone = phone;
      // Mejorar el nombre SOLO si el guardado es placeholder (un nombre editado a
      // mano nunca se pisa) y el entrante aporta algo: un nombre real siempre; un
      // teléfono/dígitos solo cuando lo guardado es el genérico sin información.
      if (name && name !== contact.name && isPlaceholderName(contact.name, contact.phone)) {
        const incomingIsPlaceholder = isPlaceholderName(name, phone);
        if (!incomingIsPlaceholder || contact.name === GENERIC_NAME) patch.name = name;
      }
      if (contact.archivedAt) patch.archivedAt = null;
      await tx.update(schema.contact).set(patch).where(eq(schema.contact.id, contact.id));
    }

    // 2. Lead (crear si el contacto no tiene uno)
    let [lead] = await tx
      .select()
      .from(schema.lead)
      .where(eq(schema.lead.contactId, contact.id));

    let leadCreated = false;
    if (!lead) {
      const [firstStage] = await tx
        .select({ id: schema.pipelineStage.id })
        .from(schema.pipelineStage)
        .orderBy(asc(schema.pipelineStage.position))
        .limit(1);
      if (!firstStage) throw new Error("no hay etapas en el pipeline");

      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.lead)
        .where(eq(schema.lead.stageId, firstStage.id));

      [lead] = await tx
        .insert(schema.lead)
        .values({
          contactId: contact.id,
          stageId: firstStage.id,
          position: count,
          lastActivityAt: new Date(),
        })
        .returning();
      leadCreated = true;
    } else {
      await tx
        .update(schema.lead)
        .set({ lastActivityAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.lead.id, lead.id));
    }

    // 3. Persistir el mensaje (si trae contenido). El historial vive en el CRM:
    // si el agente se reinstala, las conversaciones sobreviven aquí.
    let messageId: string | null = null;
    const text = input.message?.trim() || null;
    const mediaUrl = input.media?.url?.trim() || null;
    if (text || mediaUrl) {
      const [msg] = await tx
        .insert(schema.message)
        .values({
          contactId: contact.id,
          waJid,
          role,
          text,
          mediaUrl,
          mediaType: input.media?.type?.trim() || null,
          transcription: input.media?.transcription?.trim() || null,
          waMessageId: input.waMessageId?.trim() || null,
          ts: input.ts ? new Date(input.ts) : new Date(),
          // Solo lo que escribe el cliente cuenta como "sin leer".
          readAt: role === "user" ? null : new Date(),
        })
        // Reintento del agente con el mismo waMessageId → no duplicar. El `where`
        // replica el predicado del índice único parcial message_wamsgid_uq.
        .onConflictDoNothing({
          target: schema.message.waMessageId,
          where: sql`${schema.message.waMessageId} is not null`,
        })
        .returning({ id: schema.message.id });
      messageId = msg?.id ?? null;
    }

    return {
      contactId: contact.id,
      leadId: lead.id,
      contactCreated,
      leadCreated,
      messageId,
    };
  });
}
