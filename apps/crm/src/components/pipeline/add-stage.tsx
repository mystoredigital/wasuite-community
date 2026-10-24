"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Input } from "@/components/ui/input";

// Columna al final del tablero para crear una etapa nueva. El botón se convierte en
// un input inline (más limpio que un prompt del navegador).
export function AddStage({ onCreate }: { onCreate: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");

  function commit() {
    const n = name.trim();
    if (n) onCreate(n);
    setName("");
    setEditing(false);
  }

  return (
    <div className="w-72 shrink-0">
      {editing ? (
        <Input
          autoFocus
          placeholder="Nombre de la etapa…"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setName("");
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
          onClick={() => setEditing(true)}
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-fg-subtle transition-colors hover:bg-bg-subtle hover:text-fg"
        >
          <Plus className="h-4 w-4" />
          Nueva etapa
        </button>
      )}
    </div>
  );
}
