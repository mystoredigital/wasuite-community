"use client";

import { useRef } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Building2, Phone } from "lucide-react";
import type { BoardLead } from "@/server/pipeline";
import { cn, formatMoney, initials } from "@/lib/utils";

export function LeadCard({
  lead,
  overlay = false,
  onEdit,
}: {
  lead: BoardLead;
  overlay?: boolean;
  onEdit?: (lead: BoardLead) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: lead.id,
    data: { type: "lead", lead },
  });

  const money = formatMoney(lead.valueCents);

  // Distinguir click (abrir editor) de arrastre (mover): guardamos dónde bajó el
  // puntero y solo tratamos como click si apenas se movió. dnd-kit ya no inicia el
  // drag hasta 6px, pero el click igual dispara — este guardia evita abrir el editor
  // al final de un arrastre corto.
  const down = useRef<{ x: number; y: number } | null>(null);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
      {...listeners}
      onPointerDown={(e) => {
        down.current = { x: e.clientX, y: e.clientY };
        listeners?.onPointerDown?.(e);
      }}
      onClick={(e) => {
        if (!onEdit || !down.current) return;
        const moved = Math.hypot(e.clientX - down.current.x, e.clientY - down.current.y);
        if (moved < 6) onEdit(lead);
      }}
      className={cn(
        "group cursor-pointer touch-none rounded-md border border-border bg-bg-panel p-3 shadow-card transition-shadow",
        "hover:border-border-soft hover:shadow-lift",
        isDragging && !overlay && "opacity-40",
        overlay && "rotate-2 cursor-grabbing shadow-lift",
      )}
    >
      <div className="flex items-start gap-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg-elevated text-[11px] font-semibold text-fg-muted">
          {initials(lead.contact.name)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-fg">
            {lead.title || lead.contact.name}
          </div>
          {lead.title && (
            <div className="truncate text-xs text-fg-subtle">{lead.contact.name}</div>
          )}
        </div>
        {money && (
          <span className="shrink-0 rounded-sm bg-success/12 px-1.5 py-0.5 text-[11px] font-medium text-success">
            {money}
          </span>
        )}
      </div>

      {(lead.contact.company || lead.contact.phone) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg-subtle">
          {lead.contact.company && (
            <span className="inline-flex items-center gap-1">
              <Building2 className="h-3 w-3" />
              {lead.contact.company}
            </span>
          )}
          {lead.contact.phone && (
            <span className="inline-flex items-center gap-1">
              <Phone className="h-3 w-3" />
              {lead.contact.phone}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
