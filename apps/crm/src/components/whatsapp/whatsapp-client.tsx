"use client";

import { useCallback, useEffect, useState } from "react";
import { QrCode, Bot, BookOpen, FlaskConical, RefreshCw, Trash2, Plus, CheckCircle2, Wifi, WifiOff, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/page-header";
import { GruposTab } from "./grupos-tab";

/**
 * Sección WhatsApp del CRM: la configuración del bot vive aquí, no en un
 * dashboard aparte. Todo pasa por /api/agent/* (proxy autenticado al agente).
 */

type Tab = "conexion" | "bot" | "conocimiento" | "laboratorio" | "grupos";

const TABS: Array<{ key: Tab; label: string; icon: typeof QrCode }> = [
  { key: "conexion", label: "Conexión", icon: QrCode },
  { key: "bot", label: "Bot", icon: Bot },
  { key: "conocimiento", label: "Conocimiento", icon: BookOpen },
  { key: "laboratorio", label: "Laboratorio", icon: FlaskConical },
  { key: "grupos", label: "Grupos", icon: Users },
];

export function WhatsAppClient() {
  const [tab, setTab] = useState<Tab>("conexion");

  return (
    <div className="flex h-[calc(100vh-3.5rem)] md:h-screen flex-col">
      <PageHeader title="WhatsApp" subtitle="Conexión, bot con IA y base de conocimiento" />
      <div className="flex gap-1 overflow-x-auto border-b border-border px-4 [scrollbar-width:none] md:px-6 [&::-webkit-scrollbar]:hidden">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              "flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition-colors",
              tab === key
                ? "border-accent font-medium text-fg"
                : "border-transparent text-fg-muted hover:text-fg",
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        {tab === "conexion" && <ConexionTab />}
        {tab === "bot" && <BotTab />}
        {tab === "conocimiento" && <ConocimientoTab />}
        {tab === "laboratorio" && <LaboratorioTab />}
        {tab === "grupos" && <GruposTab />}
      </div>
    </div>
  );
}

/* ── helpers ── */

async function api(path: string, init?: RequestInit) {
  const r = await fetch(`/api/agent/${path}`, {
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    ...init,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as { error?: string }).error ?? `error ${r.status}`);
  return d;
}

function Panel({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
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

function ErrorNote({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return <p className="mt-2 text-xs text-danger">⚠ {msg}</p>;
}

/* ── Conexión ── */

type NumberEntry = {
  id: string;
  label: string;
  connection?: { state?: string; qr?: string | null } | null;
};

const ESTADOS: Record<string, { texto: string; tono: string }> = {
  connected: { texto: "Conectado", tono: "text-success" },
  qr: { texto: "Esperando escaneo", tono: "text-warning" },
  connecting: { texto: "Conectando…", tono: "text-warning" },
  reconnecting: { texto: "Reconectando…", tono: "text-warning" },
  disconnected: { texto: "Desconectado", tono: "text-fg-subtle" },
};

/**
 * Conexión de WhatsApp. Trabaja sobre /api/numbers, la lista real de líneas del
 * negocio: antes esta pestaña leía `state.connection`, el agregado del número por
 * defecto, así que un negocio con dos líneas solo veía una y la segunda había que
 * vincularla desde el dashboard viejo del agente.
 */
function ConexionTab() {
  const [numbers, setNumbers] = useState<NumberEntry[] | null>(null);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nuevo, setNuevo] = useState("");
  const [creando, setCreando] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = (await api("numbers")) as { numbers: NumberEntry[]; defaultId: string | null };
      setNumbers(d.numbers ?? []);
      setDefaultId(d.defaultId ?? null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // El QR rota cada pocos segundos mientras no está vinculado: refrescar seguido.
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  async function crear() {
    const id = nuevo.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 32);
    if (!id) return;
    setCreando(true);
    try {
      await api("numbers", { method: "POST", body: JSON.stringify({ id, label: nuevo.trim() }) });
      setNuevo("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreando(false);
    }
  }

  async function eliminar(id: string) {
    // Desvincular borra la sesión de WhatsApp de esa línea: no tiene vuelta atrás
    // sin volver a escanear, así que se pregunta antes.
    if (!confirm(`¿Eliminar la línea "${id}"? Habrá que volver a escanear el QR para usarla.`)) return;
    try {
      await api(`numbers/${id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <Panel
        title="Líneas de WhatsApp"
        action={
          <Button variant="ghost" size="sm" onClick={load}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Actualizar
          </Button>
        }
      >
        {numbers === null && <p className="text-sm text-fg-subtle">Cargando…</p>}
        {numbers?.length === 0 && (
          <p className="text-sm text-fg-muted">
            No hay ninguna línea todavía. Crea una abajo y escanea su código QR.
          </p>
        )}

        <div className="space-y-4">
          {numbers?.map((n) => {
            const estado = ESTADOS[n.connection?.state ?? "disconnected"] ?? {
              texto: n.connection?.state ?? "sin datos",
              tono: "text-fg-subtle",
            };
            const conectado = n.connection?.state === "connected";
            return (
              <div key={n.id} className="rounded-md border border-border-soft p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      {conectado ? (
                        <Wifi className="h-4 w-4 shrink-0 text-success" />
                      ) : (
                        <WifiOff className="h-4 w-4 shrink-0 text-warning" />
                      )}
                      <span className="truncate text-sm font-medium text-fg">{n.label || n.id}</span>
                      {n.id === defaultId && (
                        <span className="rounded bg-bg-subtle px-1.5 py-0.5 text-[10px] text-fg-subtle">
                          principal
                        </span>
                      )}
                    </div>
                    <p className={cn("mt-0.5 text-xs", estado.tono)}>{estado.texto}</p>
                  </div>
                  <div className="flex shrink-0 gap-1 self-end sm:self-auto">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        // /api/relink ya acepta numberId: no hace falta una ruta por línea.
                        api("relink", { method: "POST", body: JSON.stringify({ numberId: n.id }) })
                          .then(load)
                          .catch((e) => setError(e.message))
                      }
                    >
                      <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Re-vincular
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => eliminar(n.id)}>
                      <Trash2 className="h-3.5 w-3.5 text-danger" />
                    </Button>
                  </div>
                </div>

                {!conectado && n.connection?.qr && (
                  <div className="mt-4">
                    <p className="mb-2 text-sm text-fg-muted">
                      Escanea con el WhatsApp de esta línea:{" "}
                      <span className="text-fg-subtle">Ajustes → Dispositivos vinculados → Vincular dispositivo</span>
                    </p>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={n.connection.qr} alt={`Código QR de ${n.label || n.id}`} className="h-56 w-56 rounded-md bg-white p-2" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <ErrorNote msg={error} />
      </Panel>

      <Panel title="Añadir una línea">
        <p className="mb-3 text-sm text-fg-muted">
          Una línea por número de WhatsApp del negocio (ventas, soporte…). Cada chat
          recuerda por cuál entró y responde por la misma.
        </p>
        <div className="flex gap-2">
          <Input
            value={nuevo}
            onChange={(e) => setNuevo(e.target.value)}
            placeholder="Nombre de la línea, ej. Ventas"
            onKeyDown={(e) => e.key === "Enter" && crear()}
          />
          <Button onClick={crear} disabled={creando || !nuevo.trim()}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Añadir
          </Button>
        </div>
      </Panel>
    </>
  );
}

/* ── Bot ── */

// Lo que BotTab necesita de /api/state. La conexión ya no se lee de aquí: vive en
// /api/numbers, que es la lista real de líneas (ver ConexionTab).
type AgentState = {
  config?: { aiEnabled?: boolean; systemPrompt?: string } | null;
};

function BotTab() {
  const [aiEnabled, setAiEnabled] = useState<boolean | null>(null);
  const [prompt, setPrompt] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api("state")
      .then((d) => {
        const s = d as AgentState;
        setAiEnabled(s.config?.aiEnabled !== false);
        setPrompt(s.config?.systemPrompt ?? "");
      })
      .catch((e) => setError(e.message));
  }, []);

  async function toggle() {
    const next = !(aiEnabled ?? true);
    setAiEnabled(next);
    try {
      await api("ai-enabled", { method: "POST", body: JSON.stringify({ enabled: next }) });
    } catch (e) {
      setAiEnabled(!next);
      setError((e as Error).message);
    }
  }

  async function savePrompt() {
    setError(null);
    try {
      await api("config", { method: "POST", body: JSON.stringify({ systemPrompt: prompt }) });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <Panel title="Inteligencia artificial">
        <label className="flex cursor-pointer items-center justify-between gap-4">
          <div>
            <div className="text-sm text-fg">Respuestas automáticas con IA</div>
            <div className="text-xs text-fg-subtle">
              Apágalo para pausar el bot en todos los chats (el toggle por chat sigue funcionando).
            </div>
          </div>
          <button
            onClick={toggle}
            disabled={aiEnabled === null}
            className={cn(
              "relative h-6 w-11 shrink-0 rounded-full transition-colors",
              aiEnabled ? "bg-accent-solid" : "bg-bg-elevated",
            )}
            aria-label="Alternar IA"
          >
            <span
              className={cn(
                "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all",
                aiEnabled ? "left-[22px]" : "left-0.5",
              )}
            />
          </button>
        </label>
      </Panel>

      <Panel
        title="Personalidad del bot (prompt)"
        action={
          <Button size="sm" onClick={savePrompt}>
            {saved ? <><CheckCircle2 className="mr-1.5 h-3.5 w-3.5" /> Guardado</> : "Guardar"}
          </Button>
        }
      >
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={12}
          placeholder="Eres el asistente de [negocio]…"
          className="w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-xs leading-relaxed text-fg placeholder:text-fg-subtle focus-visible:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
        />
        <ErrorNote msg={error} />
      </Panel>
    </>
  );
}

/* ── Conocimiento ── */

type KbEntry = { id: string; q: string; a: string; source?: string };

function ConocimientoTab() {
  const [entries, setEntries] = useState<KbEntry[]>([]);
  const [freeText, setFreeText] = useState("");
  const [q, setQ] = useState("");
  const [a, setA] = useState("");
  const [savedText, setSavedText] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = (await api("kb")) as { entries: KbEntry[]; freeText: string };
      setEntries(d.entries ?? []);
      setFreeText(d.freeText ?? "");
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!q.trim() || !a.trim()) return;
    try {
      await api("kb", { method: "POST", body: JSON.stringify({ q: q.trim(), a: a.trim() }) });
      setQ("");
      setA("");
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(id: string) {
    try {
      await api(`kb/${id}`, { method: "DELETE" });
      setEntries((prev) => prev.filter((x) => x.id !== id));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function saveText() {
    try {
      await api("kb/text", { method: "POST", body: JSON.stringify({ text: freeText }) });
      setSavedText(true);
      setTimeout(() => setSavedText(false), 2000);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <Panel title={`Preguntas y respuestas (${entries.length})`}>
        <form onSubmit={add} className="mb-4 space-y-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Pregunta (ej: ¿Cuál es el horario?)" />
          <div className="flex gap-2">
            <Input value={a} onChange={(e) => setA(e.target.value)} placeholder="Respuesta" />
            <Button type="submit" size="icon" disabled={!q.trim() || !a.trim()} aria-label="Agregar">
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </form>
        {entries.length === 0 ? (
          <p className="text-sm text-fg-subtle">
            Sin entradas todavía. Lo que no esté aquí, el bot no lo sabe.
          </p>
        ) : (
          <ul className="divide-y divide-border-soft">
            {entries.map((e) => (
              <li key={e.id} className="flex items-start justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-fg">{e.q}</div>
                  <div className="text-sm text-fg-muted">{e.a}</div>
                  {e.source === "lab" && (
                    <span className="mt-0.5 inline-block rounded-sm bg-accent-soft/15 px-1.5 py-0.5 text-[10px] text-accent">
                      del Laboratorio
                    </span>
                  )}
                </div>
                <button
                  onClick={() => remove(e.id)}
                  className="shrink-0 rounded-md p-1.5 text-fg-subtle transition-colors hover:bg-danger/10 hover:text-danger"
                  aria-label="Borrar entrada"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Texto libre (contexto adicional)"
        action={
          <Button size="sm" onClick={saveText}>
            {savedText ? <><CheckCircle2 className="mr-1.5 h-3.5 w-3.5" /> Guardado</> : "Guardar"}
          </Button>
        }
      >
        <textarea
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          rows={8}
          placeholder="Información del negocio en prosa: políticas, direcciones, promociones…"
          className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm leading-relaxed text-fg placeholder:text-fg-subtle focus-visible:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
        />
        <ErrorNote msg={error} />
      </Panel>
    </>
  );
}

/* ── Laboratorio ── */

type LabHallazgo = {
  tipo?: string;
  detalle?: string;
  applied?: boolean;
  sugerencia?: { pregunta: string; respuesta: string } | null;
};
type LabCase = {
  persona: string;
  label?: string;
  status?: string;
  veredicto?: string | null;
  resumen?: string;
  hallazgos?: LabHallazgo[];
};
type LabRun = {
  id: string;
  status: string;
  startedAt: number;
  score: number | null;
  error?: string | null;
  cases: LabCase[];
};

function LaboratorioTab() {
  const [runs, setRuns] = useState<LabRun[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = (await api("lab/runs")) as { runs: LabRun[]; running: boolean };
      setRuns(d.runs ?? []);
      setRunning(d.running ?? false);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Mientras hay una corrida en curso, refrescar para ver el resultado al terminar.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [running, load]);

  async function run() {
    setError(null);
    setRunning(true);
    try {
      await api("lab/run", { method: "POST", body: "{}" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      load();
    }
  }

  async function apply(runId: string, persona: string, index: number) {
    try {
      await api("lab/apply", { method: "POST", body: JSON.stringify({ runId, persona, index }) });
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const latest = runs[0] ?? null;

  return (
    <>
      <Panel
        title="Evaluación del bot"
        action={
          <Button size="sm" onClick={run} disabled={running}>
            <FlaskConical className="mr-1.5 h-3.5 w-3.5" />
            {running ? "Corriendo…" : "Correr laboratorio"}
          </Button>
        }
      >
        <p className="text-sm text-fg-muted">
          Seis clientes simulados conversan con tu bot y un juez IA lo califica de 0 a 100.
          Úsalo antes de activar el bot con clientes reales, y después de cada cambio de
          prompt o conocimiento. Recomendación: no salir a producción con menos de 80.
        </p>
        {running && (
          <p className="mt-3 animate-pulse text-sm text-accent">
            Corrida en curso — tarda unos minutos…
          </p>
        )}
        <ErrorNote msg={error} />
      </Panel>

      {latest && (
        <Panel title={`Última corrida — ${new Date(latest.startedAt).toLocaleString()}`}>
          <div className="mb-4 flex items-baseline gap-2">
            <span className={cn("text-3xl font-bold", scoreColor(latest.score))}>
              {latest.score ?? "…"}
            </span>
            <span className="text-sm text-fg-subtle">/ 100</span>
          </div>
          <ul className="space-y-3">
            {latest.cases.map((c) => (
              <li key={c.persona} className="rounded-md border border-border-soft p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-fg">{c.label ?? c.persona}</span>
                  <span className="text-xs text-fg-subtle">{c.veredicto ?? c.status}</span>
                </div>
                {c.resumen && <p className="mt-1 text-xs text-fg-muted">{c.resumen}</p>}
                {(c.hallazgos ?? []).map((h, i) =>
                  h.sugerencia ? (
                    <div key={i} className="mt-2 flex items-start justify-between gap-3 rounded-md bg-bg-subtle p-2.5">
                      <div className="min-w-0 text-xs">
                        {h.detalle && <div className="text-fg-muted">{h.detalle}</div>}
                        <div className="mt-1 text-fg">
                          <span className="font-medium">{h.sugerencia.pregunta}</span> → {h.sugerencia.respuesta}
                        </div>
                      </div>
                      {h.applied ? (
                        <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-success">
                          <CheckCircle2 className="h-3.5 w-3.5" /> Aplicado
                        </span>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={() => apply(latest.id, c.persona, i)}>
                          Añadir a KB
                        </Button>
                      )}
                    </div>
                  ) : null,
                )}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {runs.length > 1 && (
        <Panel title="Historial">
          <ul className="divide-y divide-border-soft">
            {runs.slice(1).map((r) => (
              <li key={r.id} className="flex items-center justify-between py-2 text-sm">
                <span className="text-fg-muted">{new Date(r.startedAt).toLocaleString()}</span>
                <span className={cn("font-semibold", scoreColor(r.score))}>{r.score ?? "—"}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}

function scoreColor(score: number | null): string {
  if (score === null) return "text-fg-subtle";
  if (score >= 80) return "text-success";
  if (score >= 60) return "text-warning";
  return "text-danger";
}
