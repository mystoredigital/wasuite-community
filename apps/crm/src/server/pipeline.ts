import { and, asc, eq, gt, gte, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";

/**
 * Lógica del pipeline (el kanban). Todo lo que reordena leads o etapas va dentro de
 * una transacción: mover una tarjeta toca varias filas (la que se mueve + las que se
 * corren para hacerle sitio), y sin transacción dos arrastres simultáneos dejarían
 * las posiciones inconsistentes.
 */

export type BoardLead = {
  id: string;
  title: string | null;
  valueCents: number | null;
  position: number;
  lastActivityAt: Date | null;
  contact: { id: string; name: string; phone: string | null; company: string | null };
};

export type BoardStage = {
  id: string;
  name: string;
  kind: "open" | "won" | "lost";
  color: string;
  position: number;
  leads: BoardLead[];
};

// Tablero completo: etapas ordenadas, cada una con sus leads ordenados.
export async function getBoard(): Promise<BoardStage[]> {
  const db = getDb();
  const stages = await db
    .select()
    .from(schema.pipelineStage)
    .orderBy(asc(schema.pipelineStage.position));

  const rows = await db
    .select({
      lead: schema.lead,
      contact: schema.contact,
    })
    .from(schema.lead)
    .innerJoin(schema.contact, eq(schema.lead.contactId, schema.contact.id))
    .orderBy(asc(schema.lead.position));

  const byStage = new Map<string, BoardLead[]>();
  for (const { lead, contact } of rows) {
    const arr = byStage.get(lead.stageId) ?? [];
    arr.push({
      id: lead.id,
      title: lead.title,
      valueCents: lead.valueCents,
      position: lead.position,
      lastActivityAt: lead.lastActivityAt,
      contact: {
        id: contact.id,
        name: contact.name,
        phone: contact.phone,
        company: contact.company,
      },
    });
    byStage.set(lead.stageId, arr);
  }

  return stages.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    color: s.color,
    position: s.position,
    leads: byStage.get(s.id) ?? [],
  }));
}

/**
 * Mueve un lead a una etapa y posición concretas. Corazón del drag & drop.
 *
 * Contrato: `toPosition` es el ÍNDICE FINAL del lead en la columna destino —
 * exactamente lo que el board envía tras su arrayMove. Con esa convención los
 * dos UPDATEs (compactar origen, hacer hueco en destino) dejan ambas columnas
 * compactas (0,1,2…) también cuando origen == destino, en ambas direcciones.
 * Verificado en pipeline.test.ts contra Postgres real.
 */
export async function moveLead(
  leadId: string,
  toStageId: string,
  toPosition: number,
): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(schema.lead)
      .where(eq(schema.lead.id, leadId));
    if (!current) throw new Error("lead no existe");

    const [stage] = await tx
      .select()
      .from(schema.pipelineStage)
      .where(eq(schema.pipelineStage.id, toStageId));
    if (!stage) throw new Error("etapa destino no existe");

    // Sacamos el lead de su columna actual: los que estaban debajo suben una posición.
    await tx
      .update(schema.lead)
      .set({ position: sql`${schema.lead.position} - 1` })
      .where(
        and(
          eq(schema.lead.stageId, current.stageId),
          gt(schema.lead.position, current.position),
        ),
      );

    // Hacemos hueco en la columna destino: los que están en toPosition o después bajan.
    await tx
      .update(schema.lead)
      .set({ position: sql`${schema.lead.position} + 1` })
      .where(
        and(
          eq(schema.lead.stageId, toStageId),
          gte(schema.lead.position, toPosition),
        ),
      );

    await tx
      .update(schema.lead)
      .set({
        stageId: toStageId,
        position: toPosition,
        lastActivityAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.lead.id, leadId));
  });
}

// Crea un lead para un contacto en la primera etapa (o en la indicada), al final.
export async function createLead(input: {
  contactId: string;
  stageId?: string;
  title?: string | null;
  valueCents?: number | null;
}): Promise<string> {
  const db = getDb();
  return db.transaction(async (tx) => {
    let stageId = input.stageId;
    if (!stageId) {
      const [first] = await tx
        .select({ id: schema.pipelineStage.id })
        .from(schema.pipelineStage)
        .orderBy(asc(schema.pipelineStage.position))
        .limit(1);
      if (!first) throw new Error("no hay etapas en el pipeline");
      stageId = first.id;
    }

    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.lead)
      .where(eq(schema.lead.stageId, stageId));

    const [row] = await tx
      .insert(schema.lead)
      .values({
        contactId: input.contactId,
        stageId,
        title: input.title ?? null,
        valueCents: input.valueCents ?? null,
        position: count,
        lastActivityAt: new Date(),
      })
      .returning({ id: schema.lead.id });
    return row.id;
  });
}

export async function updateLead(
  id: string,
  patch: { title?: string | null; valueCents?: number | null },
): Promise<void> {
  const db = getDb();
  await db
    .update(schema.lead)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.lead.id, id));
}

export async function deleteLead(id: string): Promise<void> {
  const db = getDb();
  await db.delete(schema.lead).where(eq(schema.lead.id, id));
}

/* ── Etapas ─────────────────────────────────────────────────────────────────── */

export async function listStages() {
  return getDb()
    .select()
    .from(schema.pipelineStage)
    .orderBy(asc(schema.pipelineStage.position));
}

export async function createStage(input: { name: string; color?: string }): Promise<string> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [{ max }] = await tx
      .select({ max: sql<number>`coalesce(max(${schema.pipelineStage.position}), -1)::int` })
      .from(schema.pipelineStage);
    const [row] = await tx
      .insert(schema.pipelineStage)
      .values({ name: input.name, color: input.color ?? "slate", position: max + 1 })
      .returning({ id: schema.pipelineStage.id });
    return row.id;
  });
}

export async function updateStage(
  id: string,
  patch: { name?: string; color?: string },
): Promise<void> {
  await getDb().update(schema.pipelineStage).set(patch).where(eq(schema.pipelineStage.id, id));
}

// Borra una etapa. Las anclas won/lost no se pueden borrar, y solo si está vacía.
export async function deleteStage(id: string): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    const [stage] = await tx
      .select()
      .from(schema.pipelineStage)
      .where(eq(schema.pipelineStage.id, id));
    if (!stage) throw new Error("etapa no existe");
    if (stage.kind !== "open") throw new Error("no se pueden borrar las etapas ganado/perdido");

    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.lead)
      .where(eq(schema.lead.stageId, id));
    if (count > 0) throw new Error("mueve o elimina los leads de la etapa antes de borrarla");

    await tx.delete(schema.pipelineStage).where(eq(schema.pipelineStage.id, id));
    // Reindexar posiciones para no dejar huecos.
    const rest = await tx
      .select()
      .from(schema.pipelineStage)
      .orderBy(asc(schema.pipelineStage.position));
    for (let i = 0; i < rest.length; i++) {
      if (rest[i].position !== i) {
        await tx
          .update(schema.pipelineStage)
          .set({ position: i })
          .where(eq(schema.pipelineStage.id, rest[i].id));
      }
    }
  });
}
