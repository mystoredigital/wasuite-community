import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { asc, eq, inArray } from "drizzle-orm";

/**
 * Integración contra Postgres real (el de docker-compose.local.yml sirve):
 *   DATABASE_URL=postgres://crm:...@localhost:5433/crm npm test
 * Sin DATABASE_URL, se salta. Crea sus propias etapas/contactos y los borra al final.
 *
 * Contrato de moveLead: `toPosition` es el ÍNDICE FINAL del lead en la columna
 * destino (lo que envía el board tras arrayMove). Las posiciones de cada columna
 * deben quedar compactas (0,1,2…) y en el orden esperado.
 */
const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("moveLead (integración)", () => {
  // Imports dinámicos: sin DATABASE_URL ni siquiera cargamos el módulo de DB.
  let db: (typeof import("@/lib/db"))["getDb"] extends () => infer T ? T : never;
  let schema: (typeof import("@/lib/db"))["schema"];
  let moveLead: (typeof import("./pipeline"))["moveLead"];

  const stageIds: string[] = [];
  const contactIds: string[] = [];
  const leads: string[] = []; // A, B, C, D en la etapa 1

  beforeAll(async () => {
    const dbmod = await import("@/lib/db");
    db = dbmod.getDb();
    schema = dbmod.schema;
    moveLead = (await import("./pipeline")).moveLead;

    for (const name of ["_test_etapa_1", "_test_etapa_2"]) {
      const [s] = await db
        .insert(schema.pipelineStage)
        .values({ name, position: 900 + stageIds.length })
        .returning();
      stageIds.push(s.id);
    }
    for (let i = 0; i < 4; i++) {
      const [c] = await db
        .insert(schema.contact)
        .values({ name: `_test_contacto_${i}`, source: "seed" })
        .returning();
      contactIds.push(c.id);
      const [l] = await db
        .insert(schema.lead)
        .values({ contactId: c.id, stageId: stageIds[0], position: i })
        .returning();
      leads.push(l.id);
    }
  });

  afterAll(async () => {
    // Borrar contactos (leads caen por cascade) y luego las etapas de prueba.
    if (contactIds.length) await db.delete(schema.contact).where(inArray(schema.contact.id, contactIds));
    if (stageIds.length) await db.delete(schema.pipelineStage).where(inArray(schema.pipelineStage.id, stageIds));
  });

  async function columnOrder(stageId: string): Promise<{ id: string; position: number }[]> {
    return db
      .select({ id: schema.lead.id, position: schema.lead.position })
      .from(schema.lead)
      .where(eq(schema.lead.stageId, stageId))
      .orderBy(asc(schema.lead.position));
  }

  it("mueve hacia abajo dentro de la misma columna sin off-by-one", async () => {
    // A B C D → mover B al índice final 2 → A C B D
    await moveLead(leads[1], stageIds[0], 2);
    const col = await columnOrder(stageIds[0]);
    expect(col.map((l) => l.id)).toEqual([leads[0], leads[2], leads[1], leads[3]]);
    expect(col.map((l) => l.position)).toEqual([0, 1, 2, 3]); // compacto, sin huecos
  });

  it("mueve hacia arriba dentro de la misma columna", async () => {
    // A C B D → mover D al índice 0 → D A C B
    await moveLead(leads[3], stageIds[0], 0);
    const col = await columnOrder(stageIds[0]);
    expect(col.map((l) => l.id)).toEqual([leads[3], leads[0], leads[2], leads[1]]);
    expect(col.map((l) => l.position)).toEqual([0, 1, 2, 3]);
  });

  it("mueve a otra columna compactando el origen y haciendo hueco en el destino", async () => {
    // Origen: D A C B → mover A a etapa 2 índice 0. Origen queda D C B compacto.
    await moveLead(leads[0], stageIds[1], 0);
    const src = await columnOrder(stageIds[0]);
    const dst = await columnOrder(stageIds[1]);
    expect(src.map((l) => l.id)).toEqual([leads[3], leads[2], leads[1]]);
    expect(src.map((l) => l.position)).toEqual([0, 1, 2]);
    expect(dst.map((l) => l.id)).toEqual([leads[0]]);
    expect(dst.map((l) => l.position)).toEqual([0]);
  });

  it("mueve al final de otra columna (índice = longitud)", async () => {
    // Mover C a etapa 2 al final (índice 1) → etapa 2: A C
    await moveLead(leads[2], stageIds[1], 1);
    const dst = await columnOrder(stageIds[1]);
    expect(dst.map((l) => l.id)).toEqual([leads[0], leads[2]]);
    expect(dst.map((l) => l.position)).toEqual([0, 1]);
  });

  it("rechaza lead o etapa inexistentes", async () => {
    await expect(moveLead("lead_no_existe", stageIds[0], 0)).rejects.toThrow(/lead no existe/);
    await expect(moveLead(leads[1], "stage_no_existe", 0)).rejects.toThrow(/etapa destino no existe/);
  });
});
