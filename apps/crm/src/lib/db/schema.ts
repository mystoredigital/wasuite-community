import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { newId } from "./ids";

/**
 * Esquema del CRM. Una instancia = un negocio (single-tenant): tus datos viven en
 * TU Postgres, no en un tercero. Tres entidades y una relación:
 *
 *   contact ──1:1── lead ──N:1── pipeline_stage
 *
 * Un contacto es una persona. Un lead es esa persona dentro del pipeline de ventas,
 * viviendo en una etapa. El kanban mueve leads entre etapas y los reordena.
 */

/* ── Contactos ──────────────────────────────────────────────────────────────
 * La persona. `source` deja rastro de dónde vino (whatsapp, manual, import…) para
 * cuando el agente de WhatsApp empiece a alimentar el CRM.
 */
export const contact = pgTable(
  "contact",
  {
    id: text().primaryKey().$defaultFn(() => newId("contact")),
    name: text().notNull(),
    phone: text(),
    // Identificador de WhatsApp (JID). WhatsApp ya usa @lid, que oculta el teléfono,
    // así que el JID es la clave estable para contactos que llegan por WhatsApp.
    waJid: text(),
    email: text(),
    company: text(),
    notes: text(),
    source: text().notNull().default("manual"),
    archivedAt: timestamp(),
    createdAt: timestamp().notNull().defaultNow(),
    updatedAt: timestamp().notNull().defaultNow(),
  },
  (t) => [
    // Teléfono único cuando existe: evita contactos duplicados por el mismo número.
    uniqueIndex("contact_phone_uq").on(t.phone).where(sql`${t.phone} is not null`),
    // JID de WhatsApp único cuando existe: un contacto por chat de WhatsApp.
    uniqueIndex("contact_wajid_uq").on(t.waJid).where(sql`${t.waJid} is not null`),
    index("contact_name_idx").on(t.name),
  ],
);

/* ── Etapas del pipeline ────────────────────────────────────────────────────
 * Columnas del kanban. `kind`: 'open' son etapas normales; 'won'/'lost' son anclas
 * de cierre que no se pueden borrar (todo pipeline necesita un ganado y un perdido).
 */
export const pipelineStage = pgTable(
  "pipeline_stage",
  {
    id: text().primaryKey().$defaultFn(() => newId("stage")),
    name: text().notNull(),
    // Orden de la columna en el tablero. Fraccionable no hace falta: son pocas.
    position: integer().notNull(),
    kind: text({ enum: ["open", "won", "lost"] }).notNull().default("open"),
    // Color del acento de la columna (clave del token, ej. 'blue'). UI-only.
    color: text().notNull().default("slate"),
    createdAt: timestamp().notNull().defaultNow(),
  },
  (t) => [index("stage_position_idx").on(t.position)],
);

/* ── Leads ───────────────────────────────────────────────────────────────────
 * Un contacto dentro del pipeline. Único por contacto (un contacto = un lead vivo).
 * `position` ordena las tarjetas dentro de su columna. `value` es el monto del trato.
 */
export const lead = pgTable(
  "lead",
  {
    id: text().primaryKey().$defaultFn(() => newId("lead")),
    contactId: text()
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    stageId: text()
      .notNull()
      .references(() => pipelineStage.id),
    // Título opcional del trato (si falta, la UI muestra el nombre del contacto).
    title: text(),
    // Monto del trato en centavos, para no arrastrar floats. null = sin valorar.
    valueCents: integer(),
    position: integer().notNull().default(0),
    lastActivityAt: timestamp(),
    createdAt: timestamp().notNull().defaultNow(),
    updatedAt: timestamp().notNull().defaultNow(),
  },
  (t) => [
    // Un solo lead por contacto.
    uniqueIndex("lead_contact_uq").on(t.contactId),
    // El tablero pide leads por etapa, ordenados: este índice cubre esa query.
    index("lead_stage_position_idx").on(t.stageId, t.position),
  ],
);

/* ── Mensajes ────────────────────────────────────────────────────────────────
 * Historial de WhatsApp persistido en el CRM. El agente empuja cada mensaje
 * (entrante y saliente) por /api/ingest/whatsapp; si el agente se reinstala o
 * cae, el historial sobrevive aquí. `waMessageId` deduplica reintentos.
 */
export const message = pgTable(
  "message",
  {
    id: text().primaryKey().$defaultFn(() => newId("msg")),
    // Nullable desde que el agente escribe aquí directamente: los mensajes de
    // grupo no tienen contacto (los grupos no entran al CRM, ver wa_chat) pero sí
    // hay que persistirlos. El CRM filtra por contactId not null y no los ve.
    contactId: text().references(() => contact.id, { onDelete: "cascade" }),
    // JID del chat en el momento del mensaje (puede diferir del actual tras un merge).
    waJid: text(),
    // 'user' = el cliente escribe · 'assistant' = respondió la IA ·
    // 'operator' = respondió un humano desde el dashboard/CRM ·
    // 'system' = nota del propio sistema (un error de la IA, por ejemplo); el
    // inbox ya las pinta centradas y en gris.
    role: text({ enum: ["user", "assistant", "operator", "system"] }).notNull(),
    text: text(),
    // Adjunto (si lo hay): URL pública (R2), tipo (image/audio/video/document) y
    // transcripción cuando es nota de voz.
    mediaUrl: text(),
    mediaType: text(),
    transcription: text(),
    // Id del mensaje en WhatsApp — clave de deduplicación entre reintentos.
    waMessageId: text(),
    // Por qué línea del negocio entró o salió el mensaje (multi-número).
    numberId: text(),
    // De dónde salió: 'phone' (el operador escribió desde el celular), 'ghl', etc.
    source: text(),
    // Id del mensaje espejado en GoHighLevel. Se busca por él para resolver a qué
    // chat pertenece un evento de lectura que llega desde GHL.
    ghlMessageId: text(),
    // Metadata accesoria que no merece columna (ghlConversationId y demás).
    meta: jsonb(),
    ts: timestamp().notNull().defaultNow(),
    // null = sin leer (solo aplica a role 'user'; el resto nace leído).
    readAt: timestamp(),
    createdAt: timestamp().notNull().defaultNow(),
  },
  (t) => [
    // El inbox pide los mensajes de un contacto en orden: índice que cubre eso.
    index("message_contact_ts_idx").on(t.contactId, t.ts),
    // El agente lee por chat (incluidos grupos, que no tienen contactId).
    index("message_wajid_ts_idx").on(t.waJid, t.ts),
    // Dedup por id de WhatsApp cuando existe (reintentos del push del agente).
    uniqueIndex("message_wamsgid_uq").on(t.waMessageId).where(sql`${t.waMessageId} is not null`),
    // findConvByGhlMessageId(): resolver un evento de GHL a su mensaje.
    index("message_ghlmsgid_idx").on(t.ghlMessageId).where(sql`${t.ghlMessageId} is not null`),
    // Un mensaje cuelga de un contacto o de un chat; sin ninguno de los dos es
    // huérfano y no habría forma de mostrarlo en ningún lado.
    check("message_owner_ck", sql`${t.contactId} is not null or ${t.waJid} is not null`),
    // El enum de drizzle solo existe en TypeScript: no pone constraint en la base.
    // Por eso pasó desapercibido que el agente escribía 'system', un rol que la UI
    // ya pintaba pero que el esquema no declaraba. Con el CHECK la base lo dice.
    check("message_role_ck", sql`${t.role} in ('user','assistant','operator','system')`),
  ],
);

/* ── Estado del canal de WhatsApp ────────────────────────────────────────────
 * A partir de aquí vive lo que era `data/<tenant>/*.json` en el agente. wasuite
 * es single-tenant (una instalación = un negocio), así que no hay tenant_id: la
 * base de datos ES el tenant.
 */

/* Números de WhatsApp del negocio. Multi-número sigue vivo: un negocio puede
 * tener varias líneas (ventas, soporte) y cada chat recuerda por cuál entró.
 * La sesión de Baileys sigue en disco (`auth/<id>/`) — moverla a la base es un
 * paso aparte, con cifrado, y no bloquea nada de esto. */
export const waNumber = pgTable("wa_number", {
  // Slug corto elegido por el operador ('default', 'ventas'), no un id generado:
  // aparece en rutas y en el nombre del directorio de la sesión.
  id: text().primaryKey(),
  label: text().notNull(),
  isDefault: boolean().notNull().default(false),
  // Último estado conocido: disconnected · connecting · qr · connected. Es caché
  // para pintar la UI al arrancar; la verdad viva está en el socket de Baileys.
  connectionState: text().notNull().default("disconnected"),
  lastConnectedAt: timestamp(),
  createdAt: timestamp().notNull().defaultNow(),
});

/* Un chat de WhatsApp desde la óptica del bot. Existe para 1-a-1 y para grupos;
 * `contactId` solo lo tienen los 1-a-1, porque los grupos no entran al CRM
 * (whatsapp.js empuja al CRM solo cuando !isGroup). */
export const waChat = pgTable(
  "wa_chat",
  {
    waJid: text().primaryKey(),
    contactId: text().references(() => contact.id, { onDelete: "cascade" }),
    isGroup: boolean().notNull().default(false),
    // Nombre del grupo. Para 1-a-1 el nombre manda desde contact.name.
    groupName: text(),
    // Los grupos son opt-in: sin esto la bandeja se satura de chats grupales.
    enabled: boolean().notNull().default(false),
    // 'ai' = contesta el bot · 'human' = pausado, contesta una persona.
    mode: text({ enum: ["ai", "human"] }).notNull().default("ai"),
    handoffAt: timestamp(),
    // Por qué quedó en manos de un humano: operador · takeover · cliente ·
    // modelo · ghl · greylist. Sin esto el operador ve un chat pausado y no sabe
    // si lo pausó él, si el cliente pidió una persona o si la IA se rindió.
    handoffReason: text(),
    // Por qué número salió/entró el último mensaje: routing de la respuesta.
    numberId: text().references(() => waNumber.id, { onDelete: "set null" }),
    updatedAt: timestamp().notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("wa_chat_contact_uq").on(t.contactId).where(sql`${t.contactId} is not null`),
    index("wa_chat_updated_idx").on(t.updatedAt),
  ],
);

/* Configuración del agente. Fila única (`id` fijo en 'singleton'): single-tenant
 * significa que hay exactamente una. El CHECK lo hace explícito en la base en vez
 * de confiar en que el código nunca inserte una segunda. */
export const agentConfig = pgTable(
  "agent_config",
  {
    id: text().primaryKey().default("singleton"),
    systemPrompt: text().notNull().default(""),
    // Texto libre de la base de conocimiento: catálogo, horarios, políticas —
    // lo que no encaja como pregunta/respuesta.
    knowledgeBase: text().notNull().default(""),
    aiEnabled: boolean().notNull().default(true),
    updatedAt: timestamp().notNull().defaultNow(),
  },
  (t) => [check("agent_config_singleton_ck", sql`${t.id} = 'singleton'`)],
);

/* Base de conocimiento en pares pregunta/respuesta. Cada entrada tiene id propio
 * y eso no es cosmético: es lo que permite que el Laboratorio proponga la entrada
 * que falta y se añada con un click. `source` distingue manual de lab. */
export const agentKb = pgTable(
  "agent_kb",
  {
    id: text().primaryKey().$defaultFn(() => newId("kb")),
    question: text().notNull(),
    answer: text().notNull(),
    source: text({ enum: ["manual", "lab"] }).notNull().default("manual"),
    position: integer().notNull().default(0),
    createdAt: timestamp().notNull().defaultNow(),
    updatedAt: timestamp().notNull().defaultNow(),
  },
  (t) => [index("agent_kb_position_idx").on(t.position)],
);

/* Suscripciones a notificaciones push (Web Push).
 *
 * Una fila por navegador/dispositivo que aceptó recibir avisos. El `endpoint` lo
 * emite el servicio del navegador (FCM en Chrome, Mozilla autopush, APNs en
 * Safari) y es la clave: si el usuario revoca el permiso o desinstala la PWA, ese
 * endpoint empieza a responder 404/410 y hay que borrarlo — de ahí `failedAt`.
 *
 * Las claves p256dh y auth son las del cifrado extremo a extremo del payload:
 * el servicio de push transporta el mensaje pero no puede leerlo.
 */
export const pushSubscription = pgTable(
  "push_subscription",
  {
    id: text().primaryKey().$defaultFn(() => newId("push")),
    endpoint: text().notNull(),
    p256dh: text().notNull(),
    auth: text().notNull(),
    // Quién se suscribió: permite no avisar a un operador de su propio mensaje.
    username: text(),
    userAgent: text(),
    // Marca de la última entrega fallida; a la segunda se descarta la fila.
    failedAt: timestamp(),
    createdAt: timestamp().notNull().defaultNow(),
  },
  (t) => [uniqueIndex("push_endpoint_uq").on(t.endpoint)],
);

/* Consumo de la IA. Una fila por llamada al modelo: sin esto no hay forma de
 * saber cuánto cuesta atender a un cliente, ni de detectar que un prompt se fue
 * de madre. Se guardan tokens y no dinero porque el precio depende del modelo y
 * cambia; el cálculo se hace al leer, con la tarifa vigente.
 *
 * `kind` separa lo que responde a un cliente de lo que es maquinaria interna:
 *   chat      — respuesta al cliente por WhatsApp o el widget
 *   summary   — resumen de un hilo largo para no mandar 200 mensajes al modelo
 *   lab       — corridas del Laboratorio (cliente simulado)
 *   lab_judge — el juez del Laboratorio
 */
export const usageRecord = pgTable(
  "usage_record",
  {
    id: text().primaryKey().$defaultFn(() => newId("usage")),
    model: text().notNull(),
    kind: text({ enum: ["chat", "summary", "lab", "lab_judge"] }).notNull().default("chat"),
    inputTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    // Chat que lo originó, cuando lo hay: permite ver qué conversación consume.
    waJid: text(),
    ts: timestamp().notNull().defaultNow(),
  },
  (t) => [
    // El panel agrega por rango de fechas; el índice cubre esa lectura.
    index("usage_ts_idx").on(t.ts),
    index("usage_model_ts_idx").on(t.model, t.ts),
  ],
);

/* Corridas del Laboratorio. El detalle (conversaciones simuladas, hallazgos del
 * juez) se guarda como jsonb: es un documento que se lee entero y nunca se
 * consulta por dentro. El score sí es columna porque se grafica y se compara. */
export const agentLabRun = pgTable(
  "agent_lab_run",
  {
    id: text().primaryKey().$defaultFn(() => newId("lab")),
    score: integer(),
    verdict: text(),
    detail: jsonb().notNull(),
    createdAt: timestamp().notNull().defaultNow(),
  },
  (t) => [index("agent_lab_run_created_idx").on(t.createdAt)],
);

export type Contact = typeof contact.$inferSelect;
export type NewContact = typeof contact.$inferInsert;
export type PipelineStage = typeof pipelineStage.$inferSelect;
export type Lead = typeof lead.$inferSelect;
export type NewLead = typeof lead.$inferInsert;
export type Message = typeof message.$inferSelect;
export type NewMessage = typeof message.$inferInsert;

export type WaNumber = typeof waNumber.$inferSelect;
export type WaChat = typeof waChat.$inferSelect;
export type NewWaChat = typeof waChat.$inferInsert;
export type AgentConfig = typeof agentConfig.$inferSelect;
export type AgentKb = typeof agentKb.$inferSelect;
export type AgentLabRun = typeof agentLabRun.$inferSelect;
export type UsageRecord = typeof usageRecord.$inferSelect;
export type PushSubscription = typeof pushSubscription.$inferSelect;
