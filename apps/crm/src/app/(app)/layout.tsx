import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { SESSION_COOKIE, verifySession } from "@/lib/auth";

// Layout de la app autenticada: envuelve las páginas con el nav lateral.
//
// El rol se resuelve aquí, en el servidor, y no en el cliente: así el menú de
// un usuario 'client' nunca llega a incluir enlaces a la configuración. El
// middleware ya bloquea esas rutas — esto evita además ofrecer puertas que no
// se pueden abrir.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await verifySession(token, process.env.SESSION_SECRET ?? "");
  return <AppShell isAdmin={session?.role !== "client"}>{children}</AppShell>;
}
