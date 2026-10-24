"use client";

import { useCallback, useEffect, useState } from "react";
import { Trash2, Plus, CheckCircle2, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { agentApi, Panel, ErrorNote } from "@/components/whatsapp/shared";

/**
 * Webhooks salientes: el agente avisa a un sistema externo cuando pasa algo
 * (llega un mensaje, un chat escala a humano…). Estaban solo en el dashboard del
 * agente, así que para engancharlo con n8n había que salir del CRM.
 */

type Webhook = { id: string; url: string; events: string[]; revokedAt?: number | null };

export function WebhooksTab() {
  const [hooks, setHooks] = useState<Webhook[] | null>(null);
  const [eventos, setEventos] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [secreto, setSecreto] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = (await agentApi("webhooks")) as { webhooks: Webhook[]; supportedEvents: string[] };
      // Igual que las claves: el agente conserva los revocados y este panel es de
      // los que están activos.
      setHooks((d.webhooks ?? []).filter((h) => !h.revokedAt));
      setEventos(d.supportedEvents ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function toggle(ev: string) {
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(ev)) next.delete(ev);
      else next.add(ev);
      return next;
    });
  }

  async function crear() {
    if (!url.trim() || sel.size === 0) return;
    try {
      const d = (await agentApi("webhooks", {
        method: "POST",
        body: JSON.stringify({ url: url.trim(), events: [...sel] }),
      })) as { webhook?: { secret?: string } };
      // El secreto con el que se firman los envíos solo viaja en la creación.
      setSecreto(d.webhook?.secret ?? null);
      setCopiado(false);
      setUrl("");
      setSel(new Set());
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function eliminar(id: string) {
    if (!confirm("¿Eliminar este webhook? Dejará de recibir eventos.")) return;
    try {
      await agentApi(`webhooks/${id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      {secreto && (
        <Panel title="Copia el secreto de firma">
          <p className="mb-3 text-sm text-fg-muted">
            Con él se verifican los envíos. Solo se muestra ahora.
          </p>
          <div className="flex gap-2">
            <code className="flex-1 overflow-x-auto rounded-md border border-border-soft bg-bg-subtle px-3 py-2 font-mono text-xs text-fg">
              {secreto}
            </code>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                navigator.clipboard
                  .writeText(secreto)
                  .then(() => setCopiado(true))
                  .catch(() => {});
              }}
            >
              {copiado ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
            </Button>
          </div>
          <Button className="mt-3" variant="ghost" size="sm" onClick={() => setSecreto(null)}>
            Ya lo guardé
          </Button>
        </Panel>
      )}

      <Panel title="Webhooks activos">
        {hooks === null && <p className="text-sm text-fg-subtle">Cargando…</p>}
        {hooks?.length === 0 && <p className="text-sm text-fg-muted">No hay ninguno configurado.</p>}
        <div className="space-y-2">
          {hooks?.map((h) => (
            <div
              key={h.id}
              className="flex items-center justify-between rounded-md border border-border-soft px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate font-mono text-xs text-fg">{h.url}</p>
                <p className="mt-0.5 text-xs text-fg-subtle">{h.events.join(" · ")}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => eliminar(h.id)}>
                <Trash2 className="h-3.5 w-3.5 text-danger" />
              </Button>
            </div>
          ))}
        </div>
        <ErrorNote msg={error} />
      </Panel>

      <Panel title="Añadir un webhook">
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://tu-sistema.com/hook"
          className="mb-3"
        />
        <p className="mb-2 text-xs text-fg-subtle">Eventos que lo disparan:</p>
        <div className="mb-3 flex flex-wrap gap-1.5">
          {eventos.map((ev) => (
            <button
              key={ev}
              type="button"
              onClick={() => toggle(ev)}
              className={
                sel.has(ev)
                  ? "rounded-md border border-accent bg-accent/10 px-2.5 py-1 text-xs text-fg"
                  : "rounded-md border border-border-soft px-2.5 py-1 text-xs text-fg-subtle hover:text-fg"
              }
            >
              {ev}
            </button>
          ))}
        </div>
        <Button onClick={crear} disabled={!url.trim() || sel.size === 0}>
          <Plus className="mr-1.5 h-3.5 w-3.5" /> Añadir
        </Button>
      </Panel>
    </>
  );
}
