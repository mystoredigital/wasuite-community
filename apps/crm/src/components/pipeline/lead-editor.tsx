"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import type { BoardLead } from "@/server/pipeline";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { initials } from "@/lib/utils";

export function LeadEditor({
  lead,
  onClose,
  onSaved,
  onDeleted,
}: {
  lead: BoardLead;
  onClose: () => void;
  onSaved: (patch: { title: string | null; valueCents: number | null }) => void;
  onDeleted: () => void;
}) {
  const [title, setTitle] = useState(lead.title ?? "");
  // Editamos el monto en dólares; en la base va en centavos.
  const [value, setValue] = useState(
    lead.valueCents != null ? String(lead.valueCents / 100) : "",
  );
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function parseCents(): number | null {
    const t = value.trim().replace(",", ".");
    if (!t) return null;
    const n = Number(t);
    if (Number.isNaN(n) || n < 0) throw new Error("El monto no es válido.");
    return Math.round(n * 100);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    let valueCents: number | null;
    try {
      valueCents = parseCents();
    } catch (e) {
      return setErr((e as Error).message);
    }
    const patch = { title: title.trim() || null, valueCents };
    setSaving(true);
    const res = await fetch(`/api/leads/${lead.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    setSaving(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      return setErr(d.error ?? "No se pudo guardar.");
    }
    onSaved(patch);
  }

  async function remove() {
    if (!confirm(`¿Quitar a ${lead.contact.name} del pipeline?`)) return;
    setDeleting(true);
    const res = await fetch(`/api/leads/${lead.id}`, { method: "DELETE" });
    setDeleting(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      return setErr(d.error ?? "No se pudo eliminar.");
    }
    onDeleted();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={save}
        className="w-full max-w-md animate-fade-in rounded-lg border border-border bg-bg-panel p-6 shadow-lift"
      >
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-bg-elevated text-sm font-semibold text-fg-muted">
            {initials(lead.contact.name)}
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-fg">{lead.contact.name}</div>
            <div className="truncate text-xs text-fg-subtle">
              {[lead.contact.company, lead.contact.phone].filter(Boolean).join(" · ") || "Sin datos"}
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-fg-muted">Título del trato</label>
            <Input
              autoFocus
              placeholder="Ej: Tienda online, plan anual…"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-fg-muted">Monto (USD)</label>
            <Input
              inputMode="decimal"
              placeholder="0"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          {err && <p className="text-xs text-danger">{err}</p>}
        </div>

        <div className="mt-6 flex items-center justify-between">
          <Button type="button" variant="danger" size="sm" onClick={remove} disabled={deleting}>
            <Trash2 className="h-4 w-4" />
            {deleting ? "Quitando…" : "Quitar del pipeline"}
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Guardando…" : "Guardar"}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
