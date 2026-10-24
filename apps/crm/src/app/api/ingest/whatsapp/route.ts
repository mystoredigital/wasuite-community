import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ingestWhatsApp } from "@/server/ingest";

export const dynamic = "force-dynamic";

/**
 * Ingesta máquina-a-máquina: la llama el agente de WhatsApp, no un humano. Se
 * autentica con API key (header `x-api-key`), no con la cookie de sesión — por eso
 * el middleware exime esta ruta. Si INGEST_API_KEY no está configurada, la ingesta
 * queda deshabilitada (cerrada por defecto).
 */
const Body = z
  .object({
    waJid: z.string().nullish(),
    phone: z.string().nullish(),
    name: z.string().nullish(),
    message: z.string().nullish(),
    role: z.enum(["user", "assistant", "operator"]).nullish(),
    waMessageId: z.string().nullish(),
    ts: z.number().nullish(),
    media: z
      .object({
        url: z.string().nullish(),
        type: z.string().nullish(),
        transcription: z.string().nullish(),
      })
      .nullish(),
  })
  .refine((b) => b.waJid || b.phone, { message: "waJid o phone requerido" });

export async function POST(req: NextRequest) {
  const expected = process.env.INGEST_API_KEY;
  if (!expected) {
    return NextResponse.json(
      { error: "La ingesta no está configurada (falta INGEST_API_KEY)." },
      { status: 503 },
    );
  }
  if (req.headers.get("x-api-key") !== expected) {
    return NextResponse.json({ error: "no autorizado" }, { status: 401 });
  }

  let body;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "payload inválido" }, { status: 400 });
  }

  try {
    const result = await ingestWhatsApp(body);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
