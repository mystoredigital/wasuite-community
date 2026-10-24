"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { Send, Wifi, WifiOff, MessageSquare, ExternalLink, Pencil, Check, X, ChevronLeft, Search } from "lucide-react";
import { avatarHue, cn, initials, timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type Attachment = { type?: string; url?: string; mimetype?: string; transcription?: string };
type Msg = { role: string; text?: string; ts?: number; id?: string; attachment?: Attachment };
type Conv = {
  jid: string;
  name?: string;
  isGroup?: boolean;
  mode?: "ai" | "human";
  messages: Msg[];
  updatedAt: number;
  unreadCount?: number;
  phone?: string | null;
  crm?: { contactId: string; stage: string | null } | null;
};

export function InboxClient({
  agentDashboard,
  demoMode = false,
}: {
  agentDashboard: string | null;
  demoMode?: boolean;
}) {
  const [configured, setConfigured] = useState(true);
  const [connection, setConnection] = useState<{ state?: string } | null>(null);
  const [convs, setConvs] = useState<Conv[]>([]);
  const [activeJid, setActiveJid] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Buscador de la lista. Filtra en el navegador sobre lo que ya está cargado:
  // no pide nada al servidor.
  const [filtro, setFiltro] = useState("");
  // Renombrar el contacto sin salir del inbox (el nombre vive en el CRM).
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Error de envío separado del estado: el polling cada 4s no debe borrarlo.
  const [sendError, setSendError] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/inbox/state", { cache: "no-store" });
      const d = await r.json();
      setConfigured(d.configured !== false);
      // Agente inalcanzable ≠ inbox roto: el historial vive en el CRM. Se muestra
      // el banner amarillo de desconexión, no un error rojo.
      setConnection(d.connection ?? (d.agentError ? { state: "unreachable" } : null));
      setError(d.error ?? null);
      setConvs(Array.isArray(d.conversations) ? d.conversations : []);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // Tiempo real: nos suscribimos al socket del agente (autenticado con la misma
  // cookie de sesión de la suite) y recargamos al recibir eventos. El interval de
  // 30s es la red de seguridad por si el socket se cae o el agente no está.
  useEffect(() => {
    load();
    const safetyNet = setInterval(load, 30_000);

    let socket: Socket | null = null;
    if (agentDashboard) {
      // Debounce: una ráfaga de eventos (mensaje + read + connection) = una recarga.
      let pending: ReturnType<typeof setTimeout> | null = null;
      const refresh = () => {
        if (pending) clearTimeout(pending);
        pending = setTimeout(load, 300);
      };
      socket = io(agentDashboard, { withCredentials: true });
      socket.on("connect", () => socket!.emit("subscribe", "_local"));
      for (const ev of ["message", "read", "connection", "conv:removed"]) {
        socket.on(ev, refresh);
      }
    }

    return () => {
      clearInterval(safetyNet);
      socket?.disconnect();
    };
  }, [load, agentDashboard]);

  const active = convs.find((c) => c.jid === activeJid) ?? null;

  // Auto-scroll al final del hilo cuando cambian los mensajes.
  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [active?.messages.length, activeJid]);

  async function saveRename() {
    const name = renameDraft.trim();
    const contactId = active?.crm?.contactId;
    setRenaming(false);
    if (!name || !contactId || name === active?.name) return;
    // Optimista: pintamos el nombre nuevo ya; load() confirma.
    setConvs((prev) => prev.map((c) => (c.jid === active!.jid ? { ...c, name } : c)));
    const r = await fetch(`/api/contacts/${contactId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!r.ok) setSendError("No se pudo renombrar el contacto.");
    load();
  }

  async function selectConv(jid: string) {
    setRenaming(false);
    setActiveJid(jid);
    const c = convs.find((x) => x.jid === jid);
    if (c?.unreadCount) {
      fetch("/api/inbox/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jid }),
      }).catch(() => {});
    }
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !activeJid) return;
    setSendError(null);
    setDraft("");
    // Optimista: pintamos el mensaje ya, y confirmamos con el próximo poll.
    setConvs((prev) =>
      prev.map((c) =>
        c.jid === activeJid
          ? { ...c, messages: [...c.messages, { role: "manual", text, ts: Date.now() }] }
          : c,
      ),
    );
    const r = await fetch("/api/inbox/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jid: activeJid, text }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      setSendError(d.error ?? "No se pudo enviar el mensaje.");
      setDraft(text); // devolvemos el texto para no perderlo
    }
    load();
  }

  if (!configured) {
    return (
      <EmptyState
        icon={<MessageSquare className="h-6 w-6" />}
        title="Inbox no configurado"
        detail="Falta conectar el agente de WhatsApp (AGENT_API_URL / AGENT_API_KEY)."
      />
    );
  }

  const disconnected = connection?.state && connection.state !== "connected";

  const busca = filtro.trim().toLowerCase();
  const visibles = busca
    ? convs.filter((c) =>
        `${c.name ?? ""} ${c.phone ?? ""}`.toLowerCase().includes(busca),
      )
    : convs;

  return (
    <div className="flex h-[calc(100vh-3.5rem)] md:h-screen flex-col">
      {disconnected && !demoMode && (
        <div className="flex items-center gap-2 border-b border-border bg-warning/10 px-6 py-2 text-xs text-warning">
          <WifiOff className="h-4 w-4" />
          WhatsApp no está conectado.
          {agentDashboard && (
            <a
              href={agentDashboard}
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-1 underline"
            >
              Escanear QR en el agente <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Lista de conversaciones */}
        <aside
          className={cn(
            "w-full shrink-0 flex-col border-r border-border md:flex md:w-80",
            active ? "hidden" : "flex",
          )}
        >
          <header className="flex items-center justify-between px-4 py-4">
            <h1 className="text-lg font-semibold text-fg">Inbox</h1>
            {/* En la demo no hay número vinculado: mostrar "desconectado" haría
                pensar que algo está roto cuando es cómo está montada. */}
            {!demoMode && (
              <span
                className={cn(
                  "inline-flex items-center gap-1 text-[11px]",
                  disconnected ? "text-warning" : "text-success",
                )}
              >
                {disconnected ? <WifiOff className="h-3 w-3" /> : <Wifi className="h-3 w-3" />}
                {disconnected ? "desconectado" : "conectado"}
              </span>
            )}
          </header>
          <div className="px-4 pb-3">
            <div className="flex items-center gap-2 rounded-md border border-border bg-bg-panel px-2.5 py-1.5 focus-within:border-accent/60">
              <Search className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
              <input
                id="inbox-buscar"
                value={filtro}
                onChange={(e) => setFiltro(e.target.value)}
                placeholder="Buscar conversaciones"
                className="w-full bg-transparent text-xs text-fg placeholder:text-fg-subtle focus-visible:outline-none"
              />
              {filtro && (
                <button
                  type="button"
                  onClick={() => setFiltro("")}
                  aria-label="Limpiar búsqueda"
                  className="shrink-0 text-fg-subtle hover:text-fg"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 px-4 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">
            WhatsApp
            <span className="ml-auto font-medium normal-case tracking-normal">{visibles.length}</span>
          </div>

          <div className="flex-1 overflow-y-auto">
            {visibles.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-fg-subtle">
                {busca ? "Ninguna conversación coincide." : "Sin conversaciones todavía."}
              </p>
            ) : (
              visibles.map((c) => {
                const last = c.messages[c.messages.length - 1];
                const etiqueta = c.name || c.phone || c.jid;
                const sinLeer = !!c.unreadCount;
                const matiz = avatarHue(etiqueta);
                return (
                  <button
                    key={c.jid}
                    onClick={() => selectConv(c.jid)}
                    className={cn(
                      "flex w-full items-start gap-3 border-b border-border-soft px-4 py-3 text-left transition-colors",
                      c.jid === activeJid ? "bg-bg-elevated" : "hover:bg-bg-panel",
                    )}
                  >
                    <div
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
                      style={{
                        backgroundColor: `hsl(${matiz} 42% var(--av-bg-l))`,
                        color: `hsl(${matiz} 48% var(--av-fg-l))`,
                      }}
                    >
                      {initials(etiqueta)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className={cn(
                            "truncate text-sm text-fg",
                            sinLeer ? "font-bold" : "font-medium",
                          )}
                        >
                          {etiqueta}
                        </span>
                        <span className="shrink-0 text-[10px] text-fg-subtle">
                          {last?.ts ? timeAgo(new Date(last.ts)) : ""}
                        </span>
                      </div>
                      <div className={cn("truncate text-xs", sinLeer ? "text-fg" : "text-fg-subtle")}>
                        {msgPreview(last)}
                      </div>
                      <div className="mt-1 flex items-center gap-1.5">
                        {c.crm?.stage && (
                          <span className="rounded-sm bg-accent-soft/15 px-1.5 py-0.5 text-[10px] text-accent">
                            {c.crm.stage}
                          </span>
                        )}
                        {!!c.unreadCount && (
                          <span className="rounded-full bg-accent-solid px-1.5 text-[10px] font-medium text-accent-solid-fg">
                            {c.unreadCount}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        {/* Hilo */}
        <section
          className={cn(
            "min-w-0 flex-1 flex-col md:flex",
            active ? "flex" : "hidden",
          )}
        >
          {!active ? (
            <div className="flex flex-1 items-center justify-center text-sm text-fg-subtle">
              Selecciona una conversación
            </div>
          ) : (
            <>
              <header className="flex items-center justify-between border-b border-border px-4 py-3 md:px-6">
                <button
                  onClick={() => setActiveJid(null)}
                  aria-label="Volver a la lista"
                  className="-ml-1 mr-1 shrink-0 rounded-md p-1.5 text-fg-muted hover:bg-bg-panel hover:text-fg md:hidden"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
                <div className="group min-w-0">
                  {renaming ? (
                    <form
                      className="flex items-center gap-1.5"
                      onSubmit={(e) => {
                        e.preventDefault();
                        saveRename();
                      }}
                    >
                      <input
                        autoFocus
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onKeyDown={(e) => e.key === "Escape" && setRenaming(false)}
                        className="h-7 rounded-md border border-border bg-bg-panel px-2 text-sm font-semibold text-fg focus-visible:border-accent/60 focus-visible:outline-none"
                      />
                      <button type="submit" title="Guardar" className="rounded-md p-1 text-success hover:bg-bg-elevated">
                        <Check className="h-4 w-4" />
                      </button>
                      <button type="button" title="Cancelar" onClick={() => setRenaming(false)} className="rounded-md p-1 text-fg-subtle hover:bg-bg-elevated">
                        <X className="h-4 w-4" />
                      </button>
                    </form>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <div className="truncate text-sm font-semibold text-fg">
                        {active.name || active.phone || active.jid}
                      </div>
                      {active.crm?.contactId && (
                        <button
                          title="Renombrar contacto"
                          onClick={() => {
                            setRenameDraft(active.name || "");
                            setRenaming(true);
                          }}
                          className="rounded-md p-1 text-fg-subtle opacity-0 transition-all hover:bg-bg-elevated hover:text-fg group-hover:opacity-100"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  )}
                  <div className="truncate text-xs text-fg-subtle">
                    {active.phone}
                    {active.crm?.stage && ` · ${active.crm.stage}`}
                  </div>
                </div>
                {active.crm?.contactId && (
                  <a
                    href="/pipeline"
                    className="rounded-md bg-bg-elevated px-2.5 py-1 text-xs text-fg-muted hover:text-fg"
                  >
                    Ver en pipeline
                  </a>
                )}
              </header>

              <div ref={threadRef} className="flex-1 space-y-2 overflow-y-auto p-6">
                {active.messages.map((m, i) => (
                  <MessageBubble key={m.id || i} msg={m} />
                ))}
              </div>

              <div className="border-t border-border">
                {sendError && (
                  <div className="flex items-center justify-between gap-2 bg-danger/10 px-4 py-1.5 text-xs text-danger">
                    <span>⚠ {sendError}</span>
                    <button onClick={() => setSendError(null)} className="text-danger/70 hover:text-danger">
                      ✕
                    </button>
                  </div>
                )}
                <form onSubmit={send} className="flex items-center gap-2 p-4">
                  <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="Escribe un mensaje…"
                    className="h-10 flex-1 rounded-md border border-border bg-bg-panel px-3 text-sm text-fg placeholder:text-fg-subtle focus-visible:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
                  />
                  <Button type="submit" size="icon" className="h-10 w-10" disabled={!draft.trim()}>
                    <Send className="h-4 w-4" />
                  </Button>
                </form>
              </div>
            </>
          )}
        </section>
      </div>
      {error && (
        <div className="border-t border-border bg-danger/10 px-6 py-1.5 text-xs text-danger">{error}</div>
      )}
    </div>
  );
}

// Vista previa del último mensaje en la lista: texto, o ícono si es adjunto.
function msgPreview(m?: Msg): string {
  if (!m) return "(sin mensajes)";
  if (m.text) return m.text;
  const t = m.attachment?.type;
  if (t === "image") return "📷 Imagen";
  if (t === "audio" || t === "voice") return "🎤 Audio";
  if (t === "video") return "🎬 Video";
  if (m.attachment) return "📎 Archivo";
  return "(sin mensajes)";
}

function MessageBubble({ msg }: { msg: Msg }) {
  if (msg.role === "system") {
    return (
      <div className="mx-auto max-w-md rounded-md bg-bg-subtle px-3 py-1 text-center text-[11px] text-fg-subtle">
        {msg.text}
      </div>
    );
  }
  const incoming = msg.role === "user";
  const isAi = msg.role === "assistant";
  return (
    <div className={cn("flex", incoming ? "justify-start" : "justify-end")}>
      <div
        className={cn(
          "max-w-[75%] rounded-lg px-3 py-2 text-sm leading-relaxed",
          incoming
            ? "bg-bg-elevated text-fg"
            : isAi
              ? "bg-accent-soft/15 text-fg"
              : "bg-accent-solid text-accent-solid-fg",
        )}
      >
        {isAi && <div className="mb-0.5 text-[10px] font-medium opacity-70">IA</div>}
        {msg.attachment?.url && <Attachment att={msg.attachment} />}
        {msg.text && <div className="whitespace-pre-wrap">{msg.text}</div>}
      </div>
    </div>
  );
}

function Attachment({ att }: { att: Attachment }) {
  const url = att.url!;
  const isImage = att.type === "image" || att.mimetype?.startsWith("image/");
  const isAudio = att.type === "audio" || att.type === "voice" || att.mimetype?.startsWith("audio/");
  const isVideo = att.type === "video" || att.mimetype?.startsWith("video/");

  if (isImage) {
    return (
      <a href={url} target="_blank" rel="noopener" className="block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt="imagen"
          className="mb-1 max-h-64 w-auto rounded-md object-cover"
          loading="lazy"
        />
      </a>
    );
  }
  if (isAudio) {
    return (
      <div className="mb-1">
        <audio controls src={url} className="h-9 max-w-[240px]" />
        {att.transcription && (
          <div className="mt-1 text-xs italic opacity-80">“{att.transcription}”</div>
        )}
      </div>
    );
  }
  if (isVideo) {
    return <video controls src={url} className="mb-1 max-h-64 rounded-md" />;
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener"
      className="mb-1 inline-flex items-center gap-1.5 rounded-md bg-black/20 px-2 py-1 text-xs underline"
    >
      📎 Archivo adjunto
    </a>
  );
}

function EmptyState({
  icon,
  title,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <div className="flex h-[calc(100vh-3.5rem)] md:h-screen items-center justify-center p-6">
      <div className="max-w-sm rounded-lg border border-border bg-bg-panel p-8 text-center">
        <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-bg-elevated text-fg-muted">
          {icon}
        </div>
        <h2 className="mb-1 text-sm font-semibold text-fg">{title}</h2>
        <p className="text-sm text-fg-subtle">{detail}</p>
      </div>
    </div>
  );
}
