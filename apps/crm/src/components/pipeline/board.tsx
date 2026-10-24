"use client";

import { useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import type { BoardLead, BoardStage } from "@/server/pipeline";
import { StageColumn } from "./stage-column";
import { LeadCard } from "./lead-card";
import { LeadEditor } from "./lead-editor";
import { AddStage } from "./add-stage";
import { STAGE_COLOR_KEYS } from "./stage-colors";

export function Board({ initial }: { initial: BoardStage[] }) {
  const [stages, setStages] = useState<BoardStage[]>(initial);
  const [activeLead, setActiveLead] = useState<BoardLead | null>(null);
  const [editing, setEditing] = useState<BoardLead | null>(null);

  const sensors = useSensors(
    // 6px de holgura: distinguir un click de un arrastre para no capturar clicks.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // ¿En qué columna vive un id? (el id puede ser de un lead o de la propia etapa).
  function containerOf(id: string): string | undefined {
    if (stages.some((s) => s.id === id)) return id;
    return stages.find((s) => s.leads.some((l) => l.id === id))?.id;
  }

  function onDragStart(e: DragStartEvent) {
    const lead = e.active.data.current?.lead as BoardLead | undefined;
    if (lead) setActiveLead(lead);
  }

  // Mientras se arrastra por encima de otra columna, movemos la tarjeta en el estado
  // local para que siga al cursor. La persistencia ocurre al soltar.
  function onDragOver(e: DragOverEvent) {
    const { active, over } = e;
    if (!over) return;
    const from = containerOf(String(active.id));
    const to = containerOf(String(over.id));
    if (!from || !to || from === to) return;

    setStages((prev) => {
      const fromStage = prev.find((s) => s.id === from)!;
      const toStage = prev.find((s) => s.id === to)!;
      const moving = fromStage.leads.find((l) => l.id === active.id);
      if (!moving) return prev;

      // Índice destino: encima de una tarjeta → su posición; sobre la columna → al final.
      const overIsLead = toStage.leads.some((l) => l.id === over.id);
      const insertAt = overIsLead
        ? toStage.leads.findIndex((l) => l.id === over.id)
        : toStage.leads.length;

      return prev.map((s) => {
        if (s.id === from) return { ...s, leads: s.leads.filter((l) => l.id !== active.id) };
        if (s.id === to) {
          const next = [...s.leads];
          next.splice(insertAt, 0, moving);
          return { ...s, leads: next };
        }
        return s;
      });
    });
  }

  async function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    setActiveLead(null);
    if (!over) return;

    const to = containerOf(String(over.id));
    if (!to) return;

    // Reordenar dentro de la columna destino si se soltó sobre otra tarjeta.
    let finalStages = stages;
    const toStage = stages.find((s) => s.id === to)!;
    const oldIndex = toStage.leads.findIndex((l) => l.id === active.id);
    const overIndex = toStage.leads.findIndex((l) => l.id === over.id);
    if (oldIndex !== -1 && overIndex !== -1 && oldIndex !== overIndex) {
      finalStages = stages.map((s) =>
        s.id === to ? { ...s, leads: arrayMove(s.leads, oldIndex, overIndex) } : s,
      );
      setStages(finalStages);
    }

    const position = finalStages
      .find((s) => s.id === to)!
      .leads.findIndex((l) => l.id === active.id);

    try {
      const res = await fetch(`/api/leads/${active.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stageId: to, position }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      // Si la persistencia falla, recargamos para no quedar desincronizados.
      window.location.reload();
    }
  }

  async function createStage(name: string) {
    // Color siguiente en la paleta, para que cada etapa nueva se distinga sola.
    const color = STAGE_COLOR_KEYS[stages.length % STAGE_COLOR_KEYS.length];
    const res = await fetch("/api/pipeline/stages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, color }),
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error ?? "No se pudo crear la etapa");
    setStages((prev) => [
      ...prev,
      {
        id: data.id,
        name,
        kind: "open",
        color,
        position: prev.length,
        leads: [],
      },
    ]);
  }

  async function updateStage(id: string, patch: { name?: string; color?: string }) {
    setStages((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    const res = await fetch(`/api/pipeline/stages/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) window.location.reload(); // revertir si falló
  }

  async function deleteStage(id: string) {
    const res = await fetch(`/api/pipeline/stages/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      return alert(d.error ?? "No se pudo borrar la etapa");
    }
    setStages((prev) => prev.filter((s) => s.id !== id));
  }

  return (
    <DndContext
      id="pipeline-board"
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
    >
      <div className="flex h-full gap-4 overflow-x-auto px-6 pb-6">
        {stages.map((stage) => (
          <StageColumn
            key={stage.id}
            stage={stage}
            onEditLead={setEditing}
            onUpdateStage={updateStage}
            onDeleteStage={deleteStage}
          />
        ))}
        <AddStage onCreate={createStage} />
      </div>

      <DragOverlay dropAnimation={null}>
        {activeLead ? <LeadCard lead={activeLead} overlay /> : null}
      </DragOverlay>

      {editing && (
        <LeadEditor
          lead={editing}
          onClose={() => setEditing(null)}
          onSaved={(patch) => {
            setStages((prev) =>
              prev.map((s) => ({
                ...s,
                leads: s.leads.map((l) => (l.id === editing.id ? { ...l, ...patch } : l)),
              })),
            );
            setEditing(null);
          }}
          onDeleted={() => {
            setStages((prev) =>
              prev.map((s) => ({ ...s, leads: s.leads.filter((l) => l.id !== editing.id) })),
            );
            setEditing(null);
          }}
        />
      )}
    </DndContext>
  );
}
