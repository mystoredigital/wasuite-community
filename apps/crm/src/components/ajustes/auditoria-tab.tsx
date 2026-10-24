"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { agentApi, Panel, ErrorNote } from "@/components/whatsapp/shared";

/**
 * Registro de acciones del operador: quién envió, quién cambió un modo, quién
 * emitió una clave. Es lo que permite responder "¿quién hizo esto?" cuando algo
 * sale raro, y estaba solo en el dashboard del agente.
 */

type Entry = {
  ts: number;
  type: string;
  actor?: string | null;
  target?: Record<string, unknown> | null;
  meta?: Record<string, unknown> | null;
};

// Traducción de los tipos que emite el agente; los que no estén se muestran crudos.
const TIPOS: Record<string, string> = {
  send: "Mensaje enviado",
  "send-media": "Adjunto enviado",
  "send-blocked": "Envío bloqueado",
  mode: "Cambio de modo",
  relink: "Re-vinculación",
  "key-create": "Clave emitida",
  "key-revoke": "Clave revocada",
  "number-add": "Línea añadida",
  "number-remove": "Línea eliminada",
  "group-toggle": "Grupo activado/desactivado",
  "webhook-create": "Webhook creado",
  "user-create": "Usuario creado",
};

function cuando(ts: number) {
  return new Date(ts).toLocaleString("es", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// El detalle es un objeto libre por tipo de evento: se resume en una línea en vez
// de volcar JSON crudo en la tabla.
function detalle(e: Entry) {
  const partes: string[] = [];
  for (const src of [e.target, e.meta]) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) {
      if (v === null || v === undefined || v === "") continue;
      partes.push(`${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
    }
  }
  return partes.join(" · ") || "—";
}

export function AuditoriaTab() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = (await agentApi("audit?limit=200")) as { entries: Entry[] };
      setEntries(d.entries ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Panel
      title="Últimas acciones"
      action={
        <Button variant="ghost" size="sm" onClick={load}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Actualizar
        </Button>
      }
    >
      {entries === null && <p className="text-sm text-fg-subtle">Cargando…</p>}
      {entries?.length === 0 && <p className="text-sm text-fg-muted">No hay actividad registrada.</p>}

      {!!entries?.length && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-soft text-left text-xs text-fg-subtle">
                <th className="py-2 pr-3 font-medium">Cuándo</th>
                <th className="py-2 pr-3 font-medium">Acción</th>
                <th className="py-2 pr-3 font-medium">Quién</th>
                <th className="py-2 font-medium">Detalle</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={`${e.ts}-${i}`} className="border-b border-border-soft/50">
                  <td className="whitespace-nowrap py-2 pr-3 tabular-nums text-fg-subtle">{cuando(e.ts)}</td>
                  <td className="py-2 pr-3 text-fg">{TIPOS[e.type] ?? e.type}</td>
                  <td className="py-2 pr-3 text-fg-muted">{e.actor ?? "—"}</td>
                  <td className="py-2 font-mono text-xs text-fg-subtle">{detalle(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ErrorNote msg={error} />
    </Panel>
  );
}
