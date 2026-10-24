import { and, desc, eq, ilike, isNull, or } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";

/**
 * Acceso a contactos. Un contacto puede existir sin lead (una persona que aún no
 * entró al pipeline); el lead se crea aparte desde el tablero.
 */

export async function listContacts(opts: { search?: string; includeArchived?: boolean } = {}) {
  const db = getDb();
  const filters = [];
  if (!opts.includeArchived) filters.push(isNull(schema.contact.archivedAt));
  if (opts.search?.trim()) {
    const q = `%${opts.search.trim()}%`;
    filters.push(
      or(
        ilike(schema.contact.name, q),
        ilike(schema.contact.phone, q),
        ilike(schema.contact.email, q),
        ilike(schema.contact.company, q),
      ),
    );
  }
  return db
    .select()
    .from(schema.contact)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(schema.contact.updatedAt));
}

export async function getContact(id: string) {
  const [row] = await getDb().select().from(schema.contact).where(eq(schema.contact.id, id));
  return row ?? null;
}

export async function createContact(input: {
  name: string;
  phone?: string | null;
  email?: string | null;
  company?: string | null;
  notes?: string | null;
  source?: string;
}) {
  const name = input.name.trim();
  if (!name) throw new Error("el nombre es obligatorio");
  const [row] = await getDb()
    .insert(schema.contact)
    .values({
      name,
      phone: input.phone?.trim() || null,
      email: input.email?.trim() || null,
      company: input.company?.trim() || null,
      notes: input.notes?.trim() || null,
      source: input.source ?? "manual",
    })
    .returning();
  return row;
}

export async function updateContact(
  id: string,
  patch: {
    name?: string;
    phone?: string | null;
    email?: string | null;
    company?: string | null;
    notes?: string | null;
  },
) {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name.trim();
  if (patch.phone !== undefined) set.phone = patch.phone?.trim() || null;
  if (patch.email !== undefined) set.email = patch.email?.trim() || null;
  if (patch.company !== undefined) set.company = patch.company?.trim() || null;
  if (patch.notes !== undefined) set.notes = patch.notes?.trim() || null;
  const [row] = await getDb()
    .update(schema.contact)
    .set(set)
    .where(eq(schema.contact.id, id))
    .returning();
  return row ?? null;
}

// Archivar en vez de borrar: preserva el historial. El lead cae por cascade solo al
// borrar de verdad; archivar solo lo oculta de la lista.
export async function archiveContact(id: string) {
  await getDb()
    .update(schema.contact)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.contact.id, id));
}
