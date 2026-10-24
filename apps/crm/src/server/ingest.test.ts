import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";

/**
 * Integración de la ingesta (requiere DATABASE_URL — ver pipeline.test.ts).
 * Cubre el contrato con el agente: creación de contacto+lead, persistencia de
 * mensajes con dedup por waMessageId, y la semántica de no-leídos.
 */
const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("ingestWhatsApp (integración)", () => {
  let db: (typeof import("@/lib/db"))["getDb"] extends () => infer T ? T : never;
  let schema: (typeof import("@/lib/db"))["schema"];
  let ingestWhatsApp: (typeof import("./ingest"))["ingestWhatsApp"];

  const JID = "593999000111@s.whatsapp.net";
  const cleanupContacts: string[] = [];

  beforeAll(async () => {
    const dbmod = await import("@/lib/db");
    db = dbmod.getDb();
    schema = dbmod.schema;
    ingestWhatsApp = (await import("./ingest")).ingestWhatsApp;
    // La ingesta necesita al menos una etapa; el seed de producción la garantiza,
    // y el entorno local ya corrió las migraciones con seed.
  });

  afterAll(async () => {
    if (cleanupContacts.length) {
      await db.delete(schema.contact).where(inArray(schema.contact.id, cleanupContacts));
    }
  });

  it("mensaje entrante: crea contacto, lead y mensaje sin leer", async () => {
    const r = await ingestWhatsApp({
      waJid: JID,
      phone: "+593999000111",
      name: "Test Ingesta",
      message: "hola, quiero info",
      role: "user",
      waMessageId: "_test_msg_1",
    });
    cleanupContacts.push(r.contactId);

    expect(r.contactCreated).toBe(true);
    expect(r.leadCreated).toBe(true);
    expect(r.messageId).toBeTruthy();

    const msgs = await db.select().from(schema.message).where(eq(schema.message.contactId, r.contactId));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].readAt).toBeNull(); // entrante = sin leer
  });

  it("reintento con el mismo waMessageId no duplica el mensaje", async () => {
    const r = await ingestWhatsApp({
      waJid: JID,
      message: "hola, quiero info",
      role: "user",
      waMessageId: "_test_msg_1",
    });
    expect(r.contactCreated).toBe(false);
    expect(r.messageId).toBeNull(); // conflicto → no insertó

    const msgs = await db.select().from(schema.message).where(eq(schema.message.contactId, r.contactId));
    expect(msgs).toHaveLength(1);
  });

  it("respuesta de la IA: nace leída y no abre segundo lead", async () => {
    const r = await ingestWhatsApp({
      waJid: JID,
      message: "¡Claro! Te cuento…",
      role: "assistant",
      waMessageId: "_test_msg_2",
    });
    expect(r.leadCreated).toBe(false); // el contacto ya tenía lead

    const msgs = await db.select().from(schema.message).where(eq(schema.message.contactId, r.contactId));
    const ai = msgs.find((m) => m.waMessageId === "_test_msg_2")!;
    expect(ai.role).toBe("assistant");
    expect(ai.readAt).not.toBeNull(); // lo nuestro no cuenta como "sin leer"
  });

  it("mensaje con media persiste url, tipo y transcripción", async () => {
    const r = await ingestWhatsApp({
      waJid: JID,
      role: "user",
      waMessageId: "_test_msg_3",
      media: { url: "https://cdn.example.com/audio.ogg", type: "voice", transcription: "hola qué tal" },
    });
    const msgs = await db.select().from(schema.message).where(eq(schema.message.contactId, r.contactId));
    const m = msgs.find((x) => x.waMessageId === "_test_msg_3")!;
    expect(m.mediaUrl).toBe("https://cdn.example.com/audio.ogg");
    expect(m.mediaType).toBe("voice");
    expect(m.transcription).toBe("hola qué tal");
  });

  it("sin waJid ni phone → rechaza", async () => {
    await expect(ingestWhatsApp({ message: "x" })).rejects.toThrow(/waJid o phone/);
  });

  it("sin pushName: deriva el teléfono del JID clásico y lo usa de nombre", async () => {
    const r = await ingestWhatsApp({
      waJid: "593999000222@s.whatsapp.net",
      message: "hola",
      role: "user",
      waMessageId: "_test_nom_1",
    });
    cleanupContacts.push(r.contactId);
    const [c] = await db.select().from(schema.contact).where(eq(schema.contact.id, r.contactId));
    expect(c.phone).toBe("+593999000222"); // derivado del JID, no vino en el payload
    expect(c.name).toBe("+593999000222"); // mejor un número que "Contacto de WhatsApp"
  });

  it("cuando llega el pushName real, mejora el nombre placeholder", async () => {
    const r = await ingestWhatsApp({
      waJid: "593999000222@s.whatsapp.net",
      name: "María Pérez",
      message: "soy María",
      role: "user",
      waMessageId: "_test_nom_2",
    });
    const [c] = await db.select().from(schema.contact).where(eq(schema.contact.id, r.contactId));
    expect(c.name).toBe("María Pérez");
  });

  it("un nombre editado a mano NUNCA se pisa con pushName", async () => {
    const r = await ingestWhatsApp({ waJid: "593999000222@s.whatsapp.net", message: "x", role: "user", waMessageId: "_test_nom_3a" });
    await db.update(schema.contact).set({ name: "Cliente VIP (editado)" }).where(eq(schema.contact.id, r.contactId));
    await ingestWhatsApp({
      waJid: "593999000222@s.whatsapp.net",
      name: "OtroPushName",
      message: "y",
      role: "user",
      waMessageId: "_test_nom_3b",
    });
    const [c] = await db.select().from(schema.contact).where(eq(schema.contact.id, r.contactId));
    expect(c.name).toBe("Cliente VIP (editado)");
  });

  it("chat iniciado por el operador (saliente): el contacto nace con teléfono", async () => {
    // Regresión: escribirle primero a alguien creaba 'Contacto de WhatsApp' sin
    // teléfono, porque el push saliente no lo traía. Ahora el agente lo resuelve
    // del índice y el CRM lo persiste desde el primer mensaje.
    const r = await ingestWhatsApp({
      waJid: "593999000333@s.whatsapp.net",
      phone: "+593999000333",
      name: "593999000333", // el "nombre" del chat nuevo son los dígitos del JID
      message: "Hola, le escribo de la tienda",
      role: "operator",
      waMessageId: "_test_out_1",
    });
    cleanupContacts.push(r.contactId);
    const [c] = await db.select().from(schema.contact).where(eq(schema.contact.id, r.contactId));
    expect(c.phone).toBe("+593999000333");
    expect(c.name).toBe("+593999000333"); // teléfono formateado, no dígitos crudos
    const msgs = await db.select().from(schema.message).where(eq(schema.message.contactId, r.contactId));
    expect(msgs[0].role).toBe("operator"); // humano, no IA
    expect(msgs[0].readAt).not.toBeNull();
  });

  it("@lid sin nombre ni teléfono: nace con el genérico y se mejora después", async () => {
    const r1 = await ingestWhatsApp({
      waJid: "123456789012345@lid",
      message: "hola",
      role: "user",
      waMessageId: "_test_lid_1",
    });
    cleanupContacts.push(r1.contactId);
    let [c] = await db.select().from(schema.contact).where(eq(schema.contact.id, r1.contactId));
    expect(c.name).toBe("Contacto de WhatsApp"); // @lid oculta el teléfono
    expect(c.phone).toBeNull();

    await ingestWhatsApp({
      waJid: "123456789012345@lid",
      name: "Juan @lid",
      message: "sigo yo",
      role: "user",
      waMessageId: "_test_lid_2",
    });
    [c] = await db.select().from(schema.contact).where(eq(schema.contact.id, r1.contactId));
    expect(c.name).toBe("Juan @lid"); // el genérico SÍ es placeholder ahora
  });
});
