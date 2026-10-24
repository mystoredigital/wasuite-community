/**
 * Sesión única de la suite: el AGENTE es quien emite la cookie (POST /api/login
 * del agente, proxied por nuestro /api/login) y aquí solo la VERIFICAMOS. Mismo
 * nombre de cookie, mismo formato y mismo SESSION_SECRET en ambas apps — eso es
 * lo que hace que un solo login valga para el CRM y para el agente.
 *
 * Formato del token (definido en apps/agent/src/users.js):
 *   base64url(JSON{u, r, t, exp}) + "." + hex(HMAC-SHA256(payload))[0..32)
 *   - u: username · r: rol ('admin' | 'client') · t: tenantId · exp: epoch ms
 *
 * Usa Web Crypto (no `Buffer` ni `crypto` de Node) para poder ejecutarse en el
 * middleware de Next, que corre en el runtime edge.
 */

export const SESSION_COOKIE = "dashboard_session";

export type SessionUser = {
  username: string;
  role: "admin" | "client";
  tenantId: string | null;
};

const enc = new TextEncoder();
const dec = new TextDecoder();

function fromB64url(str: string): Uint8Array<ArrayBuffer> {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacHex(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(value)));
  let hex = "";
  for (const b of sig) hex += b.toString(16).padStart(2, "0");
  return hex;
}

// Comparación en tiempo constante (para strings de igual longitud).
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifySession(
  token: string | undefined,
  secret: string,
): Promise<SessionUser | null> {
  if (!token) return null;
  // El separador es el ÚLTIMO punto: el payload base64url nunca contiene '.',
  // pero cortamos igual que el agente para mantener el mismo contrato.
  const idx = token.lastIndexOf(".");
  if (idx < 0) return null;
  const value = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  try {
    const expected = (await hmacHex(value, secret)).slice(0, 32);
    if (!safeEqual(sig, expected)) return null;
    const payload = JSON.parse(dec.decode(fromB64url(value))) as {
      u: string; r: "admin" | "client"; t: string | null; exp: number;
    };
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return { username: payload.u, role: payload.r, tenantId: payload.t ?? null };
  } catch {
    return null;
  }
}
