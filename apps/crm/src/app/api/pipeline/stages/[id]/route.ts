import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteStage, updateStage } from "@/server/pipeline";

export const dynamic = "force-dynamic";

const UpdateStage = z.object({
  name: z.string().min(1).optional(),
  color: z.string().optional(),
});

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const patch = UpdateStage.parse(await req.json());
    await updateStage(id, patch);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    await deleteStage(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
