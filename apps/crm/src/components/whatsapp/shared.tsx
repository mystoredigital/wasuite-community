"use client";

/**
 * Piezas compartidas por las pestañas de la sección WhatsApp.
 *
 * Todo pasa por /api/agent/* — el proxy autenticado del CRM hacia el agente, con
 * allowlist de rutas. La UI nunca habla con el agente directamente: así hay un
 * solo login y un solo origen, en vez de mandar al operador a otro dominio.
 */

export async function agentApi(path: string, init?: RequestInit) {
  const r = await fetch(`/api/agent/${path}`, {
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    ...init,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as { error?: string }).error ?? `error ${r.status}`);
  return d;
}

export function Panel({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="mb-4 max-w-3xl rounded-lg border border-border bg-bg-panel">
      <header className="flex items-center justify-between border-b border-border-soft px-5 py-3">
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        {action}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

export function ErrorNote({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return <p className="mt-2 text-xs text-danger">⚠ {msg}</p>;
}
