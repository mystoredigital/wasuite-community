import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createStage, listStages } from "@/server/pipeline";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ stages: await listStages() });
}

const CreateStage = z.object({
  name: z.string().min(1),
  color: z.string().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const body = CreateStage.parse(await req.json());
    const id = await createStage(body);
    return NextResponse.json({ id });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
