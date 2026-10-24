import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteLead, moveLead, updateLead } from "@/server/pipeline";

export const dynamic = "force-dynamic";

// PATCH sirve para dos cosas: mover el lead (stageId + position) o editar sus datos
// (title, valueCents). Se distinguen por qué campos vienen.
const PatchLead = z.object({
  stageId: z.string().optional(),
  position: z.number().int().min(0).optional(),
  title: z.string().nullish(),
  valueCents: z.number().int().nullish(),
});

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const body = PatchLead.parse(await req.json());

    if (body.stageId !== undefined && body.position !== undefined) {
      await moveLead(id, body.stageId, body.position);
    }
    if (body.title !== undefined || body.valueCents !== undefined) {
      await updateLead(id, { title: body.title, valueCents: body.valueCents });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    await deleteLead(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
