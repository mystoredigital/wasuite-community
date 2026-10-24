"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { agentApi, Panel, ErrorNote } from "./shared";

/**
 * Grupos de WhatsApp.
 *
 * Son opt-in a propósito: si todos los grupos entraran a la bandeja, un número
 * que esté en veinte chats grupales la deja inservible. Aquí se elige cuáles se
 * atienden. Los grupos, además, arrancan siempre en modo humano — la IA no
 * contesta sola en un chat con varias personas.
 */

type Group = { jid: string; name?: string | null; enabled?: boolean };

export function GruposTab() {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = (await agentApi("groups")) as { groups?: Group[] } | Group[];
      setGroups(Array.isArray(d) ? d : (d.groups ?? []));
      setError(null);
    } catch (e) {
      // El agente responde 503 si WhatsApp no está conectado: la lista de grupos
      // la da la sesión viva, no la base.
      setError((e as Error).message);
      setGroups([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function alternar(g: Group) {
    setBusy(g.jid);
    try {
      await agentApi("groups/toggle", {
        method: "POST",
        body: JSON.stringify({ jid: g.jid, enabled: !g.enabled }),
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel
      title="Grupos"
      action={
        <Button variant="ghost" size="sm" onClick={load}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Actualizar
        </Button>
      }
    >
      <p className="mb-4 text-sm text-fg-muted">
        Solo los grupos activados aparecen en la bandeja. Entran siempre en modo
        humano: la IA no responde sola en un chat con varias personas.
      </p>

      {groups === null && <p className="text-sm text-fg-subtle">Cargando…</p>}
      {groups?.length === 0 && !error && (
        <p className="text-sm text-fg-muted">Este número no está en ningún grupo.</p>
      )}

      <div className="space-y-2">
        {groups?.map((g) => (
          <div
            key={g.jid}
            className="flex items-center justify-between rounded-md border border-border-soft px-4 py-3"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <Users className="h-4 w-4 shrink-0 text-fg-subtle" />
              <div className="min-w-0">
                <p className="truncate text-sm text-fg">{g.name || g.jid}</p>
                <p className="truncate font-mono text-[11px] text-fg-subtle">{g.jid}</p>
              </div>
            </div>
            <Button variant="ghost" size="sm" disabled={busy === g.jid} onClick={() => alternar(g)}>
              {g.enabled ? "Quitar" : "Activar"}
            </Button>
          </div>
        ))}
      </div>
      <ErrorNote msg={error} />
    </Panel>
  );
}
