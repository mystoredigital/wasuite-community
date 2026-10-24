import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { sendAgentMessage } from "@/server/agent";

export const dynamic = "force-dynamic";

const Body = z.object({ jid: z.string().min(1), text: z.string().min(1) });

export async function POST(req: NextRequest) {
  try {
    const { jid, text } = Body.parse(await req.json());
    await sendAgentMessage(jid, text);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
