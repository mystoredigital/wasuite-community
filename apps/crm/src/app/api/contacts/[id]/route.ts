import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { archiveContact, getContact, updateContact } from "@/server/contacts";
import { proxyAgent } from "@/server/agent";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const contact = await getContact(id);
  if (!contact) return NextResponse.json({ error: "no existe" }, { status: 404 });
  return NextResponse.json({ contact });
}

const UpdateContact = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().nullish(),
  email: z.string().nullish(),
  company: z.string().nullish(),
  notes: z.string().nullish(),
});

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const patch = UpdateContact.parse(await req.json());
    const contact = await updateContact(id, patch);
    if (!contact) return NextResponse.json({ error: "no existe" }, { status: 404 });
    // Si cambió el nombre y el contacto tiene chat de WhatsApp, renombramos el
    // chat en el agente (best-effort, sin bloquear la respuesta): así el nombre
    // editado en el CRM se ve igual en el dashboard del agente.
    if (patch.name && contact.waJid) {
      proxyAgent("/api/conversations/rename", {
        method: "POST",
        body: JSON.stringify({ jid: contact.waJid, name: contact.name }),
      }).catch(() => {});
    }
    return NextResponse.json({ contact });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await archiveContact(id);
  return NextResponse.json({ ok: true });
}
