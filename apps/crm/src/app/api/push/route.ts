import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { SESSION_COOKIE, verifySession } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Suscripciones a notificaciones push.
 *
 * El navegador negocia la suscripción con su propio servicio (FCM, autopush,
 * APNs) y aquí solo se guarda el resultado para que el agente pueda enviar.
 *
 * GET  → la clave pública VAPID, que el navegador necesita para suscribirse.
 * POST → guarda o actualiza una suscripción.
 * DELETE → la borra (el usuario desactivó los avisos en este dispositivo).
 */

async function usuarioActual() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const s = await verifySession(token, process.env.SESSION_SECRET ?? "");
  return s?.username ?? null;
}

export async function GET() {
  const clave = process.env.VAPID_PUBLIC_KEY ?? "";
  // Sin clave configurada la UI esconde el botón en vez de ofrecer algo que va a
  // fallar en cuanto lo pulsen.
  return NextResponse.json({ disponible: Boolean(clave), clave });
}

export async function POST(req: NextRequest) {
  const sub = (await req.json().catch(() => null)) as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  } | null;

  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
    return NextResponse.json({ error: "suscripción incompleta" }, { status: 400 });
  }

  const fila = {
    endpoint: sub.endpoint,
    p256dh: sub.keys.p256dh,
    auth: sub.keys.auth,
    username: await usuarioActual(),
    userAgent: req.headers.get("user-agent")?.slice(0, 300) ?? null,
  };

  // El navegador puede renovar la suscripción manteniendo el endpoint: se
  // actualiza en vez de duplicar, y se limpia failedAt por si venía marcada.
  await getDb()
    .insert(schema.pushSubscription)
    .values(fila)
    .onConflictDoUpdate({
      target: schema.pushSubscription.endpoint,
      set: { ...fila, failedAt: null },
    });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const { endpoint } = (await req.json().catch(() => ({}))) as { endpoint?: string };
  if (!endpoint) return NextResponse.json({ error: "endpoint requerido" }, { status: 400 });
  await getDb().delete(schema.pushSubscription).where(eq(schema.pushSubscription.endpoint, endpoint));
  return NextResponse.json({ ok: true });
}
