import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/auth";

/**
 * Puerta de entrada: sin sesión válida no se ve nada (ni páginas ni API), salvo el
 * propio login. La sesión es la MISMA cookie que emite el agente (SSO de la suite);
 * SESSION_SECRET debe ser idéntico en ambas apps.
 *
 * Fail-closed: si SESSION_SECRET no está configurado, se responde 503 en vez de
 * dejar pasar. Un despliegue a medio configurar NUNCA debe quedar público.
 */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // El endpoint de login siempre es accesible (si no, no podrías autenticarte).
  if (pathname.startsWith("/api/login")) return NextResponse.next();

  // La ingesta se autentica con API key dentro de la propia ruta, no con la cookie
  // de sesión: la llama el agente de WhatsApp (máquina), no el navegador.
  if (pathname.startsWith("/api/ingest")) return NextResponse.next();

  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    const msg = "SESSION_SECRET no está configurado en el servidor. Revisa el .env.";
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: msg }, { status: 503 });
    }
    return new NextResponse(msg, { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value, secret);

  if (pathname === "/login") {
    return session
      ? NextResponse.redirect(new URL("/pipeline", req.url))
      : NextResponse.next();
  }

  if (!session) {
    // API → 401 seco; páginas → redirección al login.
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "no autorizado" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", req.url));
  }

  // Portal del cliente: quien entra con rol 'client' ve su operación —bandeja,
  // pipeline, contactos— y nada de la configuración. El agente ya rechaza esas
  // rutas por su cuenta; esto evita además que la página llegue a pintarse y que
  // el usuario vea formularios que no le van a funcionar.
  if (session.role === "client" && esZonaDeAdmin(pathname)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "requiere rol admin" }, { status: 403 });
    }
    return NextResponse.redirect(new URL("/inbox", req.url));
  }

  return NextResponse.next();
}

// Configuración de la suite: fuera del alcance de un cliente. La sección WhatsApp
// entera es configuración del bot (prompt, conocimiento, laboratorio, líneas).
const RUTAS_ADMIN = ["/ajustes", "/whatsapp", "/api/agent/"];

function esZonaDeAdmin(pathname: string) {
  return RUTAS_ADMIN.some((r) => pathname === r || pathname.startsWith(r));
}

// Protege todo menos los assets que, por definición, tienen que ser públicos.
//
// Cualquier cosa que el navegador pida ANTES de haber iniciado sesión va aquí, o
// devuelve un 307 y falla en silencio:
//   brand/      el logo del propio login
//   manifest    lo lee el navegador al instalar la PWA
//   sw.js       el service worker se registra fuera de toda sesión; protegido,
//               las notificaciones no llegan a activarse nunca
//   icons/      los iconos de la pantalla de inicio
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|brand/|icons/|sw.js|manifest.webmanifest).*)",
  ],
};
