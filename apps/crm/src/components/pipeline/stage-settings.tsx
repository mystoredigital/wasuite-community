"use client";

import { useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import type { BoardStage } from "@/server/pipeline";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { STAGE_COLORS, STAGE_COLOR_KEYS } from "./stage-colors";

// Popover de ajustes de una etapa: renombrar, color y borrar. Cierra al click afuera.
export function StageSettings({
  stage,
  onClose,
  onUpdate,
  onDelete,
}: {
  stage: BoardStage;
  onClose: () => void;
  onUpdate: (patch: { name?: string; color?: string }) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(stage.name);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  function commitName() {
    const n = name.trim();
    if (n && n !== stage.name) onUpdate({ name: n });
  }

  const canDelete = stage.kind === "open";

  return (
    <div
      ref={ref}
      className="absolute right-0 top-8 z-20 w-60 animate-fade-in rounded-lg border border-border bg-bg-elevated p-3 shadow-lift"
    >
      <label className="mb-1 block text-[11px] text-fg-muted">Nombre</label>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commitName();
            onClose();
          }
        }}
      />

      <label className="mb-1.5 mt-3 block text-[11px] text-fg-muted">Color</label>
      <div className="flex flex-wrap gap-1.5">
        {STAGE_COLOR_KEYS.map((key) => (
          <button
            key={key}
            title={key}
            onClick={() => onUpdate({ color: key })}
            className={cn(
              "h-6 w-6 rounded-full ring-2 ring-offset-2 ring-offset-bg-elevated transition-transform hover:scale-110",
              STAGE_COLORS[key].dot,
              stage.color === key ? "ring-fg-muted" : "ring-transparent",
            )}
          />
        ))}
      </div>

      <div className="mt-3 border-t border-border-soft pt-2">
        <button
          onClick={() => {
            if (!canDelete) return;
            onDelete();
          }}
          disabled={!canDelete}
          title={canDelete ? undefined : "Las etapas Ganado/Perdido no se pueden borrar"}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors",
            canDelete
              ? "text-danger hover:bg-danger/12"
              : "cursor-not-allowed text-fg-subtle",
          )}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Borrar etapa
        </button>
        {stage.leads.length > 0 && canDelete && (
          <p className="px-2 pt-1 text-[10px] text-fg-subtle">
            Mueve sus {stage.leads.length} lead{stage.leads.length > 1 ? "s" : ""} antes de borrarla.
          </p>
        )}
      </div>
    </div>
  );
}
