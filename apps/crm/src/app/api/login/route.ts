import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { SESSION_COOKIE } from "@/lib/auth";

export const dynamic = "force-dynamic";

const Login = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const SESSION_MAX_AGE_S = 12 * 60 * 60; // 12h — mismo TTL que firma el agente

function cookieDomain(): string | undefined {
  // COOKIE_DOMAIN (ej: .cliente.com) hace que la sesión valga para el CRM y el
  // agente a la vez (subdominios del mismo dominio). Sin definir = host-only.
  return process.env.COOKIE_DOMAIN || undefined;
}

/**
 * Login único de la suite: el CRM NO tiene usuarios propios — delega las
 * credenciales al agente (que sí tiene usuarios con scrypt + roles) y re-emite
 * el MISMO token firmado como cookie propia. Como ambas apps comparten
 * SESSION_SECRET y nombre de cookie, un login aquí también abre el agente.
 */
export async function POST(req: NextRequest) {
  const agentUrl = process.env.AGENT_API_URL;
  if (!agentUrl || !process.env.SESSION_SECRET) {
    return NextResponse.json(
      { error: "La autenticación no está configurada (AGENT_API_URL / SESSION_SECRET)." },
      { status: 503 },
    );
  }

  let body;
  try {
    body = Login.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "faltan credenciales" }, { status: 400 });
  }

  let agentRes: Response;
  try {
    agentRes = await fetch(`${agentUrl.replace(/\/$/, "")}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: body.username, password: body.password }),
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    });
  } catch {
    return NextResponse.json(
      { error: "No se pudo contactar al servicio de WhatsApp para validar el login." },
      { status: 502 },
    );
  }

  if (!agentRes.ok) {
    const status = agentRes.status === 401 ? 401 : 502;
    const msg = status === 401 ? "Usuario o contraseña incorrectos." : "Error del servicio de autenticación.";
    return NextResponse.json({ error: msg }, { status });
  }

  // El agente responde con Set-Cookie: dashboard_session=<token>; ...
  // Extraemos el token y lo re-emitimos como cookie nuestra (dominio compartido).
  const setCookie = agentRes.headers.get("set-cookie") ?? "";
  const m = setCookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  if (!m) {
    return NextResponse.json({ error: "El servicio de autenticación no emitió sesión." }, { status: 502 });
  }
  const token = decodeURIComponent(m[1]);

  const data = (await agentRes.json().catch(() => ({}))) as { user?: unknown };
  const res = NextResponse.json({ ok: true, user: data.user ?? null });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_S,
    domain: cookieDomain(),
  });
  return res;
}

// Logout: borra la cookie (con el mismo dominio con que se emitió).
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0, domain: cookieDomain() });
  return res;
}
