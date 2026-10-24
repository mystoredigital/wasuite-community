import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { verifySession } from "./auth";

/**
 * El CRM verifica tokens EMITIDOS POR EL AGENTE (apps/agent/src/users.js). Este
 * helper replica byte a byte el algoritmo del agente: si alguien cambia un lado
 * sin el otro, estos tests revientan — que es exactamente lo que queremos.
 */
function signLikeAgent(
  payload: Record<string, unknown>,
  secret: string,
): string {
  const value = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(value).digest("hex").slice(0, 32);
  return `${value}.${sig}`;
}

const SECRET = "test-secret-para-vitest";

describe("verifySession (SSO con el agente)", () => {
  it("acepta un token firmado por el agente y devuelve el usuario", async () => {
    const token = signLikeAgent(
      { u: "admin", r: "admin", t: null, exp: Date.now() + 60_000 },
      SECRET,
    );
    const session = await verifySession(token, SECRET);
    expect(session).toEqual({ username: "admin", role: "admin", tenantId: null });
  });

  it("conserva el tenantId de un usuario cliente", async () => {
    const token = signLikeAgent(
      { u: "cliente1", r: "client", t: "loc_abc", exp: Date.now() + 60_000 },
      SECRET,
    );
    const session = await verifySession(token, SECRET);
    expect(session).toEqual({ username: "cliente1", role: "client", tenantId: "loc_abc" });
  });

  it("rechaza un token expirado", async () => {
    const token = signLikeAgent(
      { u: "admin", r: "admin", t: null, exp: Date.now() - 1000 },
      SECRET,
    );
    expect(await verifySession(token, SECRET)).toBeNull();
  });

  it("rechaza una firma manipulada", async () => {
    const token = signLikeAgent(
      { u: "admin", r: "admin", t: null, exp: Date.now() + 60_000 },
      SECRET,
    );
    const [value] = [token.slice(0, token.lastIndexOf("."))];
    const tampered = `${value}.${"0".repeat(32)}`;
    expect(await verifySession(tampered, SECRET)).toBeNull();
  });

  it("rechaza un payload alterado (privilege escalation)", async () => {
    const token = signLikeAgent(
      { u: "cliente1", r: "client", t: "loc_abc", exp: Date.now() + 60_000 },
      SECRET,
    );
    const sig = token.slice(token.lastIndexOf(".") + 1);
    const evil = Buffer.from(
      JSON.stringify({ u: "cliente1", r: "admin", t: null, exp: Date.now() + 60_000 }),
      "utf8",
    ).toString("base64url");
    expect(await verifySession(`${evil}.${sig}`, SECRET)).toBeNull();
  });

  it("rechaza un token firmado con otro secreto", async () => {
    const token = signLikeAgent(
      { u: "admin", r: "admin", t: null, exp: Date.now() + 60_000 },
      "otro-secreto",
    );
    expect(await verifySession(token, SECRET)).toBeNull();
  });

  it("rechaza basura y vacíos sin lanzar", async () => {
    expect(await verifySession(undefined, SECRET)).toBeNull();
    expect(await verifySession("", SECRET)).toBeNull();
    expect(await verifySession("sin-punto", SECRET)).toBeNull();
    expect(await verifySession("no-base64!.abc", SECRET)).toBeNull();
  });
});
