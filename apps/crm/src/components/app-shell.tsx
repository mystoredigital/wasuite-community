"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import Image from "next/image";
import { KanbanSquare, Users, LogOut, MessageSquare, Bot, Settings, Menu, X, Sun, Moon } from "lucide-react";
import { cn } from "@/lib/utils";

// `admin: true` marca lo que es configuración de la suite. Un usuario con rol
// 'client' entra a su operación (bandeja, pipeline, contactos) y no ve el resto.
const NAV = [
  { href: "/inbox", label: "Inbox", icon: MessageSquare },
  { href: "/pipeline", label: "Pipeline", icon: KanbanSquare },
  { href: "/contacts", label: "Contactos", icon: Users },
  { href: "/whatsapp", label: "WhatsApp", icon: Bot, admin: true },
  { href: "/ajustes", label: "Ajustes", icon: Settings, admin: true },
];

/**
 * Shell de la app.
 *
 * En escritorio el nav es una columna fija. En móvil NO puede serlo: 224px de
 * 390 son el 57% de la pantalla y no queda sitio para trabajar. Ahí se convierte
 * en un panel lateral que se abre desde una barra superior.
 */
export function AppShell({
  children,
  isAdmin = true,
}: {
  children: React.ReactNode;
  isAdmin?: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [abierto, setAbierto] = useState(false);
  // El tema lo aplica un script en <head> antes de pintar; aquí solo leemos
  // cuál quedó, para que el botón muestre el estado correcto.
  const [tema, setTema] = useState<"light" | "dark">("light");

  useEffect(() => {
    setTema(document.documentElement.classList.contains("dark") ? "dark" : "light");
  }, []);

  function cambiarTema() {
    const siguiente = tema === "dark" ? "light" : "dark";
    const raiz = document.documentElement;
    raiz.classList.remove("light", "dark");
    raiz.classList.add(siguiente);
    setTema(siguiente);
    try {
      localStorage.setItem("wasuite-tema", siguiente);
    } catch {
      // Navegador sin almacenamiento (ventana privada): el tema dura la sesión.
    }
  }

  // Navegar cierra el panel: si no, en móvil tapa justo la página que acabas de abrir.
  useEffect(() => {
    setAbierto(false);
  }, [pathname]);

  // Con el panel abierto el fondo no debe desplazarse detrás.
  useEffect(() => {
    document.body.style.overflow = abierto ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [abierto]);

  async function logout() {
    await fetch("/api/login", { method: "DELETE" });
    router.replace("/login");
    router.refresh();
  }

  const items = NAV.filter((n) => isAdmin || !n.admin);

  return (
    <div className="flex min-h-screen">
      {/* Barra superior, solo en móvil: es lo que da acceso al nav. */}
      <header className="fixed inset-x-0 top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-bg-subtle px-4 md:hidden">
        <button
          onClick={() => setAbierto(true)}
          aria-label="Abrir menú"
          className="-ml-1 rounded-md p-2 text-fg-muted transition-colors hover:bg-bg-panel hover:text-fg"
        >
          <Menu className="h-5 w-5" />
        </button>
        <Link href="/inbox" className="flex items-center gap-2">
          <Image src="/brand/isotipo-wa.svg" alt="" width={886} height={996} className="h-7 w-7" />
          <span className="text-sm font-semibold text-fg">Wa Suite</span>
        </Link>
      </header>

      {/* Velo del panel. Solo existe en móvil y con el panel abierto. */}
      {abierto && (
        <div
          onClick={() => setAbierto(false)}
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px] md:hidden"
          aria-hidden
        />
      )}

      <aside
        className={cn(
          "z-50 flex w-56 shrink-0 flex-col border-r border-border bg-bg-subtle",
          // Móvil: panel deslizante fuera de flujo.
          "fixed inset-y-0 left-0 transition-transform duration-200 ease-out",
          abierto ? "translate-x-0" : "-translate-x-full",
          // Escritorio: columna fija de siempre.
          "md:sticky md:top-0 md:h-screen md:translate-x-0",
        )}
      >
        <div className="flex items-center gap-2.5 px-5 py-5">
          <Image src="/brand/isotipo-wa.svg" alt="" width={886} height={996} className="h-8 w-8" />
          <div className="leading-tight">
            <div className="text-sm font-semibold text-fg">Wa Suite</div>
            <div className="text-[11px] text-fg-subtle">CRM + WhatsApp</div>
          </div>
          <button
            onClick={() => setAbierto(false)}
            aria-label="Cerrar menú"
            className="ml-auto rounded-md p-1.5 text-fg-subtle hover:bg-bg-panel hover:text-fg md:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav className="flex flex-1 flex-col gap-1 px-3 py-2">
          {items.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(href + "/");
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                  active
                    ? "bg-bg-elevated font-medium text-fg"
                    : "text-fg-muted hover:bg-bg-panel hover:text-fg",
                )}
              >
                <Icon className="h-[18px] w-[18px]" />
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-border-soft px-3 py-3">
          <button
            onClick={cambiarTema}
            className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-fg-muted transition-colors hover:bg-bg-panel hover:text-fg"
          >
            {tema === "dark" ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
            {tema === "dark" ? "Tema claro" : "Tema oscuro"}
          </button>
          <button
            onClick={logout}
            className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-fg-muted transition-colors hover:bg-bg-panel hover:text-fg"
          >
            <LogOut className="h-[18px] w-[18px]" />
            Cerrar sesión
          </button>
          <div className="px-3 pt-2 text-[11px] text-fg-subtle">Tus datos, tu servidor.</div>
        </div>
      </aside>

      {/* pt-14 en móvil deja hueco para la barra superior, que es fixed. */}
      <main className="min-w-0 flex-1 overflow-hidden pt-14 md:pt-0">{children}</main>
    </div>
  );
}
