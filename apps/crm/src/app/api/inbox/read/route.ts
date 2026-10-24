import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { markAgentRead } from "@/server/agent";

export const dynamic = "force-dynamic";

const Body = z.object({ jid: z.string().min(1) });

/**
 * Marcar conversación como leída: actualiza los mensajes en Postgres (la fuente
 * del inbox) y propaga al agente best-effort (el agente a su vez lo espeja a
 * WhatsApp/GHL con los ticks azules).
 */
export async function POST(req: NextRequest) {
  try {
    const { jid } = Body.parse(await req.json());

    const db = getDb();
    const [contact] = await db
      .select({ id: schema.contact.id })
      .from(schema.contact)
      .where(eq(schema.contact.waJid, jid));
    if (contact) {
      await db
        .update(schema.message)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(schema.message.contactId, contact.id),
            eq(schema.message.role, "user"),
            isNull(schema.message.readAt),
          ),
        );
    }

    await markAgentRead(jid); // best-effort: ya trae catch interno

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
