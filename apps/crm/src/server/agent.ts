import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth";

/**
 * Cliente del agente de WhatsApp (Baileys). El CRM no habla WhatsApp directamente
 * — eso lo hace el agente, un servicio aparte siempre encendido. El CRM le pide las
 * conversaciones y le manda los mensajes por su API, server-side, para que la URL
 * del agente nunca llegue al navegador.
 *
 * Auth contra el agente (en orden):
 *  1. AGENT_API_KEY (Bearer) si está definida — útil para setups avanzados.
 *  2. La cookie de sesión del usuario logueado, reenviada tal cual: como CRM y
 *     agente comparten SESSION_SECRET (SSO de la suite), el agente la acepta y
 *     además aplica el scope de tenant del usuario. Cero config extra.
 *
 * En producción, AGENT_API_URL apunta al agente por la red interna de Docker
 * (http://agent:3000). En local, al agente de desarrollo.
 */
const AGENT_URL = process.env.AGENT_API_URL;
const AGENT_KEY = process.env.AGENT_API_KEY;

export function agentConfigured(): boolean {
  return !!AGENT_URL;
}

async function authHeaders(extra?: HeadersInit): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((extra as Record<string, string>) ?? {}),
  };
  if (AGENT_KEY) {
    headers.Authorization = `Bearer ${AGENT_KEY}`;
  } else {
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    if (token) headers.Cookie = `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
  }
  return headers;
}

async function agentFetch(path: string, init?: RequestInit) {
  if (!agentConfigured()) throw new Error("El agente de WhatsApp no está configurado.");
  const res = await fetch(`${AGENT_URL}${path}`, {
    ...init,
    headers: await authHeaders(init?.headers),
    signal: AbortSignal.timeout(15000),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`agente ${res.status}: ${body.slice(0, 200)}`);
  }
  return res;
}

/**
 * Proxy crudo hacia el agente para la sección WhatsApp del CRM: devuelve
 * status + body tal cual (sin lanzar), para que la UI muestre los errores del
 * agente ("Ya hay una corrida en curso", etc.) en vez de un 500 genérico.
 * `timeoutMs` alto para el Laboratorio, que corre conversaciones completas.
 */
export async function proxyAgent(
  path: string,
  init?: { method?: string; body?: string; timeoutMs?: number },
): Promise<{ status: number; body: unknown }> {
  if (!agentConfigured()) {
    return { status: 503, body: { error: "El agente de WhatsApp no está configurado." } };
  }
  try {
    const res = await fetch(`${AGENT_URL}${path}`, {
      method: init?.method ?? "GET",
      body: init?.body,
      headers: await authHeaders(),
      signal: AbortSignal.timeout(init?.timeoutMs ?? 15000),
      cache: "no-store",
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  } catch (e) {
    return { status: 502, body: { error: `No se pudo contactar al agente: ${(e as Error).message}` } };
  }
}

export type AgentAttachment = {
  type?: string; // image | audio | voice | video | document | ...
  url?: string; // URL pública (R2)
  mimetype?: string;
  transcription?: string;
};

export type AgentMessage = {
  role: "user" | "assistant" | "system" | "manual";
  text?: string;
  ts?: number;
  id?: string;
  attachment?: AgentAttachment;
};

export type AgentConversation = {
  jid: string;
  name?: string;
  isGroup?: boolean;
  mode?: "ai" | "human";
  messages: AgentMessage[];
  updatedAt: number;
  unreadCount?: number;
};

export type AgentState = {
  connection?: { state?: string; qr?: string | null };
  conversations: AgentConversation[];
};

// Estado del agente: conexión + conversaciones (ordenadas por reciente).
export async function getAgentState(): Promise<AgentState> {
  const res = await agentFetch("/api/state");
  const data = await res.json();
  return {
    connection: data.connection ?? null,
    conversations: Array.isArray(data.conversations) ? data.conversations : [],
  };
}

export async function sendAgentMessage(jid: string, text: string): Promise<void> {
  await agentFetch("/api/send", {
    method: "POST",
    body: JSON.stringify({ jid, text }),
  });
}

export async function markAgentRead(jid: string): Promise<void> {
  await agentFetch("/api/conversations/read", {
    method: "POST",
    body: JSON.stringify({ jid }),
  }).catch(() => {}); // marcar leído es best-effort
}

// Deriva el teléfono E.164 SOLO de un JID basado en teléfono ("593...@s.whatsapp.net").
// Los JID @lid ocultan el teléfono: su número NO es un teléfono, así que devolvemos null
// para no mostrar un "ID" que parezca teléfono.
export function phoneFromJid(jid: string): string | null {
  const m = jid.match(/^(\d{7,15})@s\.whatsapp\.net$/);
  return m ? `+${m[1]}` : null;
}
