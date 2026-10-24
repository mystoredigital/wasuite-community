import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createLead } from "@/server/pipeline";

export const dynamic = "force-dynamic";

const CreateLead = z.object({
  contactId: z.string().min(1),
  stageId: z.string().optional(),
  title: z.string().nullish(),
  valueCents: z.number().int().nullish(),
});

export async function POST(req: NextRequest) {
  try {
    const body = CreateLead.parse(await req.json());
    const id = await createLead(body);
    return NextResponse.json({ id });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
