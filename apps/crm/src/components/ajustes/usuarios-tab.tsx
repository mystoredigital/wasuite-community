"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, ShieldCheck, User as UserIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { agentApi, Panel, ErrorNote } from "@/components/whatsapp/shared";

/**
 * Usuarios de la suite. El agente es quien los guarda y valida (el CRM comparte
 * su cookie de sesión), así que esto es su gestión traída al CRM: antes había que
 * ir al dashboard del agente para dar de alta a alguien.
 *
 * Solo un admin ve estos endpoints; a un usuario 'cliente' el agente le responde
 * 403 y aquí se muestra tal cual.
 */

type User = { username: string; role: string; disabled?: boolean; tenantId?: string | null };

export function UsuariosTab() {
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("admin");

  const load = useCallback(async () => {
    try {
      const d = (await agentApi("users")) as { users: User[] };
      setUsers(d.users ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function crear() {
    if (!username.trim() || !password.trim()) return;
    try {
      await agentApi("users", {
        method: "POST",
        body: JSON.stringify({ username: username.trim(), password, role }),
      });
      setUsername("");
      setPassword("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function alternar(u: User) {
    const accion = u.disabled ? "enable" : "disable";
    // Desactivar en vez de borrar: el usuario sigue apareciendo en la auditoría y
    // se puede reactivar sin recrearlo.
    if (!u.disabled && !confirm(`¿Desactivar a "${u.username}"? No podrá entrar hasta reactivarlo.`)) return;
    try {
      await agentApi(`users/${encodeURIComponent(u.username)}/${accion}`, { method: "POST", body: "{}" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <Panel title="Usuarios">
        {users === null && <p className="text-sm text-fg-subtle">Cargando…</p>}
        <div className="space-y-2">
          {users?.map((u) => (
            <div
              key={u.username}
              className="flex items-center justify-between rounded-md border border-border-soft px-4 py-3"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                {u.role === "admin" ? (
                  <ShieldCheck className="h-4 w-4 shrink-0 text-accent" />
                ) : (
                  <UserIcon className="h-4 w-4 shrink-0 text-fg-subtle" />
                )}
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-fg">
                    {u.username}
                    {u.disabled && <span className="ml-2 text-xs text-fg-subtle">(desactivado)</span>}
                  </p>
                  <p className="text-xs text-fg-subtle">
                    {u.role === "admin" ? "Administrador" : "Cliente"}
                    {u.tenantId ? ` · ${u.tenantId}` : ""}
                  </p>
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => alternar(u)}>
                {u.disabled ? "Reactivar" : "Desactivar"}
              </Button>
            </div>
          ))}
        </div>
        <ErrorNote msg={error} />
      </Panel>

      <Panel title="Crear un usuario">
        <div className="space-y-3">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Usuario" />
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Contraseña"
          />
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-sm text-fg-muted">
              <input type="radio" checked={role === "admin"} onChange={() => setRole("admin")} />
              Administrador
            </label>
            <label className="flex items-center gap-1.5 text-sm text-fg-muted">
              <input type="radio" checked={role === "cliente"} onChange={() => setRole("cliente")} />
              Cliente
            </label>
          </div>
          <Button onClick={crear} disabled={!username.trim() || !password.trim()}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Crear
          </Button>
        </div>
      </Panel>
    </>
  );
}
