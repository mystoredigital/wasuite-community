"use client";

import { useEffect, useState } from "react";
import {
  Plus,
  Search,
  Building2,
  Phone,
  Mail,
  KanbanSquare,
  Check,
  LayoutGrid,
  List,
  Pencil,
} from "lucide-react";
import type { Contact } from "@/lib/db/schema";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { cn, initials } from "@/lib/utils";

type ViewMode = "grid" | "list";

export function ContactsClient({
  initial,
  error,
}: {
  initial: Contact[];
  error: string | null;
}) {
  const [contacts, setContacts] = useState<Contact[]>(initial);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [addedToPipeline, setAddedToPipeline] = useState<Set<string>>(new Set());
  const [view, setView] = useState<ViewMode>("grid");

  // Recordar la vista elegida entre visitas (no molesta re-elegir cada vez).
  useEffect(() => {
    const saved = localStorage.getItem("contacts:view");
    if (saved === "grid" || saved === "list") setView(saved);
  }, []);
  function changeView(v: ViewMode) {
    setView(v);
    localStorage.setItem("contacts:view", v);
  }

  const filtered = contacts.filter((c) => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return [c.name, c.phone, c.email, c.company].some((v) => v?.toLowerCase().includes(q));
  });

  async function addToPipeline(contactId: string) {
    const res = await fetch("/api/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contactId }),
    });
    if (res.ok) {
      setAddedToPipeline((prev) => new Set(prev).add(contactId));
    } else {
      const d = await res.json().catch(() => ({}));
      alert(d.error ?? "No se pudo añadir al pipeline");
    }
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)] md:h-screen flex-col">
      <PageHeader
        title="Contactos"
        subtitle={`${contacts.length} ${contacts.length === 1 ? "contacto" : "contactos"}`}
        action={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            Nuevo contacto
          </Button>
        }
      />

      <div className="flex items-center justify-between gap-3 px-6">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
          <Input
            className="pl-9"
            placeholder="Buscar por nombre, teléfono, email…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="flex items-center rounded-md border border-border bg-bg-panel p-0.5">
          <button
            onClick={() => changeView("grid")}
            title="Tarjetas"
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-sm transition-colors",
              view === "grid" ? "bg-bg-elevated text-fg" : "text-fg-subtle hover:text-fg",
            )}
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
          <button
            onClick={() => changeView("list")}
            title="Lista"
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-sm transition-colors",
              view === "list" ? "bg-bg-elevated text-fg" : "text-fg-subtle hover:text-fg",
            )}
          >
            <List className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {error ? (
          <p className="text-sm text-danger">Error: {error}</p>
        ) : filtered.length === 0 ? (
          <p className="py-16 text-center text-sm text-fg-subtle">
            {contacts.length === 0 ? "Aún no hay contactos." : "Sin resultados."}
          </p>
        ) : view === "grid" ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((c) => (
              <ContactCard
                key={c.id}
                contact={c}
                added={addedToPipeline.has(c.id)}
                onAdd={() => addToPipeline(c.id)}
                onEdit={() => setEditing(c)}
              />
            ))}
          </div>
        ) : (
          <ContactsTable
            contacts={filtered}
            addedToPipeline={addedToPipeline}
            onAdd={addToPipeline}
            onEdit={setEditing}
          />
        )}
      </div>

      {creating && (
        <ContactDialog
          onClose={() => setCreating(false)}
          onSaved={(c) => {
            setContacts((prev) => [c, ...prev]);
            setCreating(false);
          }}
        />
      )}
      {editing && (
        <ContactDialog
          contact={editing}
          onClose={() => setEditing(null)}
          onSaved={(c) => {
            setContacts((prev) => prev.map((x) => (x.id === c.id ? c : x)));
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function ContactCard({
  contact,
  added,
  onAdd,
  onEdit,
}: {
  contact: Contact;
  added: boolean;
  onAdd: () => void;
  onEdit: () => void;
}) {
  return (
    <div className="group rounded-lg border border-border bg-bg-panel p-4 transition-colors hover:border-border-soft">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-elevated text-xs font-semibold text-fg-muted">
          {initials(contact.name)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-fg">{contact.name}</div>
          <div className="mt-1 space-y-0.5 text-xs text-fg-subtle">
            {contact.company && (
              <div className="flex items-center gap-1.5">
                <Building2 className="h-3 w-3" />
                <span className="truncate">{contact.company}</span>
              </div>
            )}
            {contact.phone && (
              <div className="flex items-center gap-1.5">
                <Phone className="h-3 w-3" />
                <span className="truncate">{contact.phone}</span>
              </div>
            )}
            {contact.email && (
              <div className="flex items-center gap-1.5">
                <Mail className="h-3 w-3" />
                <span className="truncate">{contact.email}</span>
              </div>
            )}
          </div>
        </div>
        <button
          onClick={onEdit}
          title="Editar contacto"
          className="rounded-md p-1.5 text-fg-subtle opacity-0 transition-all hover:bg-bg-elevated hover:text-fg group-hover:opacity-100"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      </div>

      <button
        onClick={onAdd}
        disabled={added}
        className={cn(
          "mt-3 flex w-full items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors",
          added
            ? "bg-success/12 text-success"
            : "bg-bg-elevated text-fg-muted hover:bg-border-soft hover:text-fg",
        )}
      >
        {added ? (
          <>
            <Check className="h-3.5 w-3.5" /> En el pipeline
          </>
        ) : (
          <>
            <KanbanSquare className="h-3.5 w-3.5" /> Añadir al pipeline
          </>
        )}
      </button>
    </div>
  );
}

function ContactsTable({
  contacts,
  addedToPipeline,
  onAdd,
  onEdit,
}: {
  contacts: Contact[];
  addedToPipeline: Set<string>;
  onAdd: (id: string) => void;
  onEdit: (c: Contact) => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-bg-subtle/60 text-left text-xs text-fg-subtle">
            <th className="px-4 py-2.5 font-medium">Nombre</th>
            <th className="hidden px-4 py-2.5 font-medium sm:table-cell">Empresa</th>
            <th className="hidden px-4 py-2.5 font-medium md:table-cell">Teléfono</th>
            <th className="hidden px-4 py-2.5 font-medium lg:table-cell">Email</th>
            <th className="px-4 py-2.5 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {contacts.map((c) => {
            const added = addedToPipeline.has(c.id);
            return (
              <tr
                key={c.id}
                className="border-b border-border-soft last:border-0 hover:bg-bg-panel/60"
              >
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bg-elevated text-[10px] font-semibold text-fg-muted">
                      {initials(c.name)}
                    </div>
                    <span className="font-medium text-fg">{c.name}</span>
                  </div>
                </td>
                <td className="hidden px-4 py-2.5 text-fg-muted sm:table-cell">
                  {c.company || <span className="text-fg-subtle">—</span>}
                </td>
                <td className="hidden px-4 py-2.5 text-fg-muted md:table-cell">
                  {c.phone || <span className="text-fg-subtle">—</span>}
                </td>
                <td className="hidden px-4 py-2.5 text-fg-muted lg:table-cell">
                  {c.email || <span className="text-fg-subtle">—</span>}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <button
                    onClick={() => onEdit(c)}
                    title="Editar contacto"
                    className="mr-1 inline-flex items-center rounded-md p-1.5 text-fg-subtle transition-colors hover:bg-bg-elevated hover:text-fg"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => onAdd(c.id)}
                    disabled={added}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                      added
                        ? "text-success"
                        : "bg-bg-elevated text-fg-muted hover:bg-border-soft hover:text-fg",
                    )}
                  >
                    {added ? (
                      <>
                        <Check className="h-3.5 w-3.5" /> En el pipeline
                      </>
                    ) : (
                      <>
                        <KanbanSquare className="h-3.5 w-3.5" /> Añadir
                      </>
                    )}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Crear (sin `contact`) o editar (con `contact`) en el mismo formulario.
function ContactDialog({
  contact,
  onClose,
  onSaved,
}: {
  contact?: Contact;
  onClose: () => void;
  onSaved: (c: Contact) => void;
}) {
  const [form, setForm] = useState({
    name: contact?.name ?? "",
    phone: contact?.phone ?? "",
    email: contact?.email ?? "",
    company: contact?.company ?? "",
    notes: contact?.notes ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return setErr("El nombre es obligatorio.");
    setSaving(true);
    setErr(null);
    const res = await fetch(contact ? `/api/contacts/${contact.id}` : "/api/contacts", {
      method: contact ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) return setErr(data.error ?? "No se pudo guardar el contacto.");
    onSaved(data.contact);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-full max-w-md animate-fade-in rounded-lg border border-border bg-bg-panel p-6 shadow-lift"
      >
        <h2 className="mb-4 text-base font-semibold text-fg">
          {contact ? "Editar contacto" : "Nuevo contacto"}
        </h2>
        <div className="space-y-3">
          <Input
            autoFocus
            placeholder="Nombre *"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              placeholder="Teléfono"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
            <Input
              placeholder="Empresa"
              value={form.company}
              onChange={(e) => setForm({ ...form, company: e.target.value })}
            />
          </div>
          <Input
            placeholder="Email"
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
          <Textarea
            rows={3}
            placeholder="Notas"
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
          />
          {err && <p className="text-xs text-danger">{err}</p>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Guardando…" : contact ? "Guardar cambios" : "Crear contacto"}
          </Button>
        </div>
      </form>
    </div>
  );
}
