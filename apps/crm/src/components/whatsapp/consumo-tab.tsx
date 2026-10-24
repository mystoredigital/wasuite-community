"use client";

import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { agentApi, Panel, ErrorNote } from "./shared";

/**
 * Consumo de la IA.
 *
 * El agente registra una fila por llamada al modelo y agrega en SQL; aquí solo se
 * pinta. Se muestran TOKENS y no dinero a propósito: el precio depende del modelo
 * y cambia, así que un importe calculado aquí envejecería mal y daría una falsa
 * sensación de exactitud.
 */

type UsageRow = { model: string; kind: string; calls: number; inputTokens: number; outputTokens: number };
type UsageResp = {
  available: boolean;
  reason?: string;
  rows: UsageRow[];
  totals?: { calls: number; inputTokens: number; outputTokens: number };
};

// Separar el tráfico real de la maquinaria interna importa: una corrida del
// Laboratorio cuesta unas 30 llamadas y, mezclada, parecería uso de clientes.
const KINDS: Record<string, string> = {
  chat: "Respuestas a clientes",
  summary: "Resúmenes de hilos largos",
  lab: "Laboratorio",
  lab_judge: "Juez del Laboratorio",
};

const miles = (n: number) => n.toLocaleString("es");

export function ConsumoTab() {
  const [data, setData] = useState<UsageResp | null>(null);
  const [days, setDays] = useState(30);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData((await agentApi(`usage?days=${days}`)) as UsageResp);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [days]);

  useEffect(() => {
    load();
  }, [load]);

  if (data && !data.available) {
    return (
      <Panel title="Consumo de la IA">
        <p className="text-sm text-fg-muted">{data.reason ?? "No disponible."}</p>
      </Panel>
    );
  }

  const t = data?.totals;
  return (
    <Panel
      title={`Consumo de los últimos ${days} días`}
      action={
        <div className="flex gap-1">
          {[7, 30, 90].map((d) => (
            <Button
              key={d}
              variant="ghost"
              size="sm"
              onClick={() => setDays(d)}
              className={cn(days === d && "text-fg")}
            >
              {d}d
            </Button>
          ))}
        </div>
      }
    >
      {t && (
        <div className="mb-4 grid grid-cols-3 gap-3">
          <Metric label="Llamadas" value={miles(t.calls)} />
          <Metric label="Tokens de entrada" value={miles(t.inputTokens)} />
          <Metric label="Tokens de salida" value={miles(t.outputTokens)} />
        </div>
      )}

      {data?.rows.length === 0 && (
        <p className="text-sm text-fg-muted">Todavía no hay llamadas registradas en este periodo.</p>
      )}

      {!!data?.rows.length && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-soft text-left text-xs text-fg-subtle">
                <th className="py-2 pr-3 font-medium">Modelo</th>
                <th className="py-2 pr-3 font-medium">Para qué</th>
                <th className="py-2 pr-3 text-right font-medium">Llamadas</th>
                <th className="py-2 pr-3 text-right font-medium">Entrada</th>
                <th className="py-2 text-right font-medium">Salida</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={`${r.model}-${r.kind}`} className="border-b border-border-soft/50">
                  <td className="py-2 pr-3 font-mono text-xs text-fg">{r.model}</td>
                  <td className="py-2 pr-3 text-fg-muted">{KINDS[r.kind] ?? r.kind}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-fg-muted">{miles(r.calls)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-fg-muted">{miles(r.inputTokens)}</td>
                  <td className="py-2 text-right tabular-nums text-fg-muted">{miles(r.outputTokens)}</td>
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

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border-soft px-4 py-3">
      <p className="text-xs text-fg-subtle">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums text-fg">{value}</p>
    </div>
  );
}
