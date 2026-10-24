import { NextRequest, NextResponse } from "next/server";
import { proxyAgent } from "@/server/agent";

export const dynamic = "force-dynamic";

/**
 * Proxy autenticado hacia el agente de WhatsApp para la sección /whatsapp del
 * CRM. El middleware ya exige sesión para llegar aquí, y el proxy reenvía la
 * cookie — el agente aplica sus propios roles y scope de tenant.
 *
 * Allowlist explícita: solo los endpoints que la UI usa. Nada de reenviar
 * cualquier ruta a ciegas: /api/login y todo lo que no esté aquí queda fuera.
 */
const ALLOWED = [
  /^state$/,
  /^config$/,
  /^ai-enabled$/,
  /^kb$/,
  /^kb\/text$/,
  /^kb\/[\w.-]+$/,
  /^lab\/run$/,
  /^lab\/runs$/,
  /^lab\/runs\/[\w.-]+$/,
  /^lab\/apply$/,
  /^relink$/,
  /^numbers$/,
  /^numbers\/[\w.-]+$/,
  // Claves de API y consumo: dejaron de vivir solo en el dashboard del agente.
  // Sin esto no había ningún camino desde el CRM para emitir una clave.
  /^keys$/,
  /^keys\/[\w.-]+$/,
  /^usage$/,
  // Ajustes: webhooks, usuarios y auditoría. Vivían solo en el dashboard del
  // agente; el CRM es ahora la única puerta de entrada.
  /^webhooks$/,
  /^webhooks\/[\w.-]+$/,
  /^users$/,
  /^users\/[\w.@.-]+\/(password|disable|enable)$/,
  /^audit$/,
  /^stats$/,
  /^groups$/,
  /^groups\/toggle$/,
];

// El Laboratorio corre 6 conversaciones completas contra el LLM: minutos, no segundos.
const TIMEOUTS: Array<[RegExp, number]> = [[/^lab\/run$/, 5 * 60 * 1000]];

async function handle(req: NextRequest, params: Promise<{ path: string[] }>) {
  const segments = (await params).path ?? [];
  const path = segments.join("/");
  if (!ALLOWED.some((re) => re.test(path))) {
    return NextResponse.json({ error: "ruta no permitida" }, { status: 404 });
  }
  const timeoutMs = TIMEOUTS.find(([re]) => re.test(path))?.[1];
  const body = req.method === "POST" ? await req.text() : undefined;
  const result = await proxyAgent(`/api/${path}`, { method: req.method, body, timeoutMs });
  return NextResponse.json(result.body, { status: result.status });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return handle(req, ctx.params);
}
export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return handle(req, ctx.params);
}
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return handle(req, ctx.params);
}
