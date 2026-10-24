"use client";

import { useCallback, useEffect, useState } from "react";
import { Trash2, Plus, CheckCircle2, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { agentApi, Panel, ErrorNote } from "./shared";

/**
 * Claves de API del agente.
 *
 * Vivían solo en el dashboard del agente, en otro dominio y con otra estética:
 * desde el CRM no había ningún camino para emitir una, había que saber que ese
 * dashboard existía y navegarlo a mano.
 */

type ApiKey = {
  id: string;
  label: string;
  createdAt?: number;
  lastUsedAt?: number | null;
  revokedAt?: number | null;
};

function fecha(ms?: number | null) {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString("es", { day: "2-digit", month: "short", year: "numeric" });
}

export function ClavesTab() {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [creada, setCreada] = useState<string | null>(null);
  const [copiada, setCopiada] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = (await agentApi("keys")) as { keys: ApiKey[] };
      // El agente devuelve también las revocadas (conserva el registro). Este
      // panel es de claves que sirven: mostrar una revocada como activa haría
      // creer que sigue dando acceso.
      setKeys((d.keys ?? []).filter((k) => !k.revokedAt));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function crear() {
    if (!label.trim()) return;
    try {
      const d = (await agentApi("keys", {
        method: "POST",
        body: JSON.stringify({ label: label.trim() }),
      })) as { key?: { token?: string } };
      // El token completo solo se devuelve al crearla: después el agente guarda
      // únicamente su hash. Si el usuario no lo copia ahora, no hay forma de verlo.
      setCreada(d.key?.token ?? null);
      setCopiada(false);
      setLabel("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function revocar(id: string) {
    if (!confirm("¿Revocar esta clave? Lo que la esté usando dejará de funcionar.")) return;
    try {
      await agentApi(`keys/${id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      {creada && (
        <Panel title="Copia la clave ahora">
          <p className="mb-3 text-sm text-fg-muted">
            Es la única vez que se muestra: el servidor solo guarda su hash. Si la
            pierdes, revócala y emite otra.
          </p>
          <div className="flex gap-2">
            <code className="flex-1 overflow-x-auto rounded-md border border-border-soft bg-bg-subtle px-3 py-2 font-mono text-xs text-fg">
              {creada}
            </code>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                navigator.clipboard
                  .writeText(creada)
                  .then(() => setCopiada(true))
                  .catch(() => {});
              }}
            >
              {copiada ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
            </Button>
          </div>
          <Button className="mt-3" variant="ghost" size="sm" onClick={() => setCreada(null)}>
            Ya la guardé
          </Button>
        </Panel>
      )}

      <Panel title="Claves activas">
        {keys === null && <p className="text-sm text-fg-subtle">Cargando…</p>}
        {keys?.length === 0 && <p className="text-sm text-fg-muted">No hay ninguna clave emitida.</p>}
        <div className="space-y-2">
          {keys?.map((k) => (
            <div
              key={k.id}
              className="flex items-center justify-between rounded-md border border-border-soft px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-fg">{k.label}</p>
                <p className="text-xs text-fg-subtle">
                  Creada {fecha(k.createdAt)} · último uso {fecha(k.lastUsedAt)}
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => revocar(k.id)}>
                <Trash2 className="h-3.5 w-3.5 text-danger" />
              </Button>
            </div>
          ))}
        </div>
        <ErrorNote msg={error} />
      </Panel>

      <Panel title="Emitir una clave">
        <p className="mb-3 text-sm text-fg-muted">
          Para integrar el agente con otro sistema (n8n, tu web, un script). La clave
          hereda el alcance de este negocio.
        </p>
        <div className="flex gap-2">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Para qué es, ej. Automatización n8n"
            onKeyDown={(e) => e.key === "Enter" && crear()}
          />
          <Button onClick={crear} disabled={!label.trim()}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Emitir
          </Button>
        </div>
      </Panel>
    </>
  );
}
