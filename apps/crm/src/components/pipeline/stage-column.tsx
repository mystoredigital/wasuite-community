"use client";

import { useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { MoreHorizontal } from "lucide-react";
import type { BoardLead, BoardStage } from "@/server/pipeline";
import { cn, formatMoney } from "@/lib/utils";
import { stageColor } from "./stage-colors";
import { LeadCard } from "./lead-card";
import { StageSettings } from "./stage-settings";

export function StageColumn({
  stage,
  onEditLead,
  onUpdateStage,
  onDeleteStage,
}: {
  stage: BoardStage;
  onEditLead?: (lead: BoardLead) => void;
  onUpdateStage?: (id: string, patch: { name?: string; color?: string }) => void;
  onDeleteStage?: (id: string) => void;
}) {
  // La columna entera es zona de drop, para poder soltar en una etapa vacía.
  const { setNodeRef, isOver } = useDroppable({
    id: stage.id,
    data: { type: "stage", stageId: stage.id },
  });
  const [menuOpen, setMenuOpen] = useState(false);

  const color = stageColor(stage.color);
  const total = stage.leads.reduce((sum, l) => sum + (l.valueCents ?? 0), 0);
  const totalLabel = formatMoney(total);

  return (
    <div className="flex w-72 shrink-0 flex-col">
      <div className="group relative mb-2 flex items-center gap-2 px-1">
        <span className={cn("h-2 w-2 rounded-full", color.dot)} />
        <span className="text-sm font-medium text-fg">{stage.name}</span>
        <span className="rounded-full bg-bg-elevated px-1.5 text-[11px] text-fg-muted">
          {stage.leads.length}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {totalLabel && total > 0 && (
            <span className="text-[11px] text-fg-subtle">{totalLabel}</span>
          )}
          {onUpdateStage && (
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-sm text-fg-subtle opacity-0 transition-opacity hover:bg-bg-elevated hover:text-fg group-hover:opacity-100",
                menuOpen && "opacity-100",
              )}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          )}
        </div>
        {menuOpen && onUpdateStage && onDeleteStage && (
          <StageSettings
            stage={stage}
            onClose={() => setMenuOpen(false)}
            onUpdate={(patch) => onUpdateStage(stage.id, patch)}
            onDelete={() => {
              onDeleteStage(stage.id);
              setMenuOpen(false);
            }}
          />
        )}
      </div>

      <div
        ref={setNodeRef}
        className={cn(
          "flex flex-1 flex-col gap-2 rounded-lg border border-transparent bg-bg-subtle/60 p-2 transition-colors",
          isOver && "border-border bg-bg-subtle",
        )}
      >
        <SortableContext items={stage.leads.map((l) => l.id)} strategy={verticalListSortingStrategy}>
          {stage.leads.map((lead) => (
            <LeadCard key={lead.id} lead={lead} onEdit={onEditLead} />
          ))}
        </SortableContext>

        {stage.leads.length === 0 && (
          <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border-soft py-8 text-center text-xs text-fg-subtle">
            Arrastra un lead aquí
          </div>
        )}
      </div>
    </div>
  );
}
