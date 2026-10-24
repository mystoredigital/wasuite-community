import { asc, sql } from "drizzle-orm";
import { getDb, schema } from "../src/lib/db/index";

/**
 * Seed: crea el pipeline inicial y unos datos de ejemplo para ver el tablero con
 * algo dentro. Idempotente en las etapas (no las duplica si ya existen).
 */
const db = getDb();

const STAGES = [
  { name: "Nuevo", color: "slate", kind: "open" as const },
  { name: "Contactado", color: "blue", kind: "open" as const },
  { name: "Propuesta", color: "violet", kind: "open" as const },
  { name: "Negociación", color: "amber", kind: "open" as const },
  { name: "Ganado", color: "emerald", kind: "won" as const },
  { name: "Perdido", color: "rose", kind: "lost" as const },
];

const existing = await db.select().from(schema.pipelineStage).orderBy(asc(schema.pipelineStage.position));

let stageIds: string[];
if (existing.length === 0) {
  const inserted = await db
    .insert(schema.pipelineStage)
    .values(STAGES.map((s, i) => ({ ...s, position: i })))
    .returning({ id: schema.pipelineStage.id });
  stageIds = inserted.map((r) => r.id);
  console.log(`[seed] ${stageIds.length} etapas creadas`);
} else {
  stageIds = existing.map((s) => s.id);
  console.log("[seed] las etapas ya existían, no se tocan");
}

// Contactos de ejemplo con un lead cada uno, repartidos por las primeras etapas.
const DEMO = [
  { name: "María González", phone: "+593 99 123 4567", company: "Boutique Aurora", title: "Tienda online", value: 120000 },
  { name: "Carlos Ramírez", phone: "+593 98 765 4321", company: "Ferretería El Tornillo", title: "Agente WhatsApp", value: 85000 },
  { name: "Ana Torres", phone: "+593 96 555 1212", company: "Café de la Loma", title: null, value: 45000 },
  { name: "Luis Andrade", phone: "+593 99 888 7766", company: "Distribuidora Andes", title: "CRM + automatización", value: 240000 },
];

const [{ count }] = await db
  .select({ count: sql<number>`count(*)::int` })
  .from(schema.lead);

if (count === 0) {
  for (let i = 0; i < DEMO.length; i++) {
    const d = DEMO[i];
    const [c] = await db
      .insert(schema.contact)
      .values({ name: d.name, phone: d.phone, company: d.company, source: "seed" })
      .returning({ id: schema.contact.id });
    await db.insert(schema.lead).values({
      contactId: c.id,
      stageId: stageIds[i % 4], // reparte en las 4 primeras etapas (open)
      title: d.title,
      valueCents: d.value,
      position: 0,
      lastActivityAt: new Date(),
    });
  }
  console.log(`[seed] ${DEMO.length} contactos + leads de ejemplo creados`);
} else {
  console.log("[seed] ya había leads, no se crean ejemplos");
}

process.exit(0);
