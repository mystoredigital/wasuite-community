// Driver de persistencia sobre Postgres para TenantStore.
//
// Reemplaza los `data/<tenant>/*.json` por las tablas que ya usa el CRM. Los
// chats 1-a-1 SON contact + message: por eso el espejo por HTTP (CRM_INGEST_URL)
// deja de hacer falta — el agente y el CRM leen la misma verdad.
//
// TenantStore sigue llevando su estado en memoria y emitiendo los mismos eventos;
// este driver solo cambia de dónde se carga y a dónde se escribe. La interfaz es
// deliberadamente la misma que la del camino JSON para que los tests de
// caracterización valgan igual contra ambos.
//
// Lo que NO vive aquí todavía:
//   - la sesión de Baileys (`auth/<numberId>/`), que sigue en disco; moverla pide
//     cifrado en reposo y no bloquea nada de esto.
//   - los tokens de GoHighLevel (`tokens.json`), por lo mismo.

import { db } from './db.js';
import { newId } from './ids.js';

// El esquema guarda timestamps; el agente trabaja con epoch ms en memoria.
const toDate = (ms) => (ms == null ? null : new Date(Number(ms)));
const toMs = (d) => (d == null ? null : new Date(d).getTime());

const CONFIG_ID = 'singleton';

// Todo lo que escribe: se envuelve para poder drenarlo. Si añades un método de
// escritura al driver, súmalo aquí o quedará fuera del apagado limpio.
const WRITE_METHODS = [
  'saveConversation', 'ensureLead', 'appendMessage', 'mergeConversations', 'markRead', 'updateMessageMeta', 'deleteConversation',
  'saveConfig', 'setGroupEnabled', 'saveKbEntry', 'deleteKbEntry',
  'saveNumber', 'deleteNumber', 'setNumberConnection', 'noteNumberForJid',
  'registerPhone', 'saveLabRun', 'saveUsage',
];

export class PgDriver {
  constructor(tenantId) {
    // wasuite es single-tenant: la base ES el tenant. El id se conserva solo para
    // los eventos que ya viajan con él hacia el dashboard.
    this.tenantId = tenantId;
    this.sql = db();

    // TenantStore dispara las escrituras sin await (lo hace desde siempre: el
    // camino caliente no puede bloquear la respuesta al cliente). Con archivos eso
    // se resolvía con la cola de writeJsonAtomic; aquí llevamos la cuenta de las
    // que siguen en vuelo para poder esperarlas en un apagado limpio o en un test,
    // sin recurrir a sleeps que se rompen en cuanto la base está más lenta.
    this._inflight = new Set();
    for (const name of WRITE_METHODS) {
      const fn = this[name].bind(this);
      this[name] = (...args) => this._track(fn(...args));
    }
  }

  _track(promise) {
    const tracked = promise.finally(() => this._inflight.delete(tracked));
    this._inflight.add(tracked);
    return tracked;
  }

  // Espera a que no quede ninguna escritura pendiente. Vuelve a mirar porque una
  // escritura puede encadenar otra (appendMessage llama a saveConversation).
  async drain() {
    while (this._inflight.size) {
      await Promise.allSettled([...this._inflight]);
    }
  }

  /* ── Carga ───────────────────────────────────────────────────────────────── */

  async load() {
    const [chats, messages, config, kbRows, numbers, contacts, labRuns] = await Promise.all([
      this.sql`SELECT c.*, ct.name AS contact_name, ct.phone AS contact_phone, ct.id AS contact_pk
               FROM wa_chat c LEFT JOIN contact ct ON ct.id = c.contact_id`,
      this.sql`SELECT * FROM message ORDER BY ts ASC`,
      this.sql`SELECT * FROM agent_config WHERE id = ${CONFIG_ID}`,
      this.sql`SELECT * FROM agent_kb ORDER BY position ASC, created_at ASC`,
      this.sql`SELECT * FROM wa_number ORDER BY is_default DESC, created_at ASC`,
      this.sql`SELECT id, name, phone, wa_jid FROM contact WHERE wa_jid IS NOT NULL`,
      this.sql`SELECT * FROM agent_lab_run ORDER BY created_at DESC LIMIT 20`,
    ]);

    // Mensajes agrupados por chat, en orden.
    const byJid = new Map();
    for (const m of messages) {
      if (!m.waJid) continue;
      if (!byJid.has(m.waJid)) byJid.set(m.waJid, []);
      byJid.get(m.waJid).push(rowToMessage(m));
    }

    const conversations = new Map();
    for (const c of chats) {
      const msgs = byJid.get(c.waJid) || [];
      const conv = {
        jid: c.waJid,
        name: c.isGroup ? c.groupName : c.contactName,
        isGroup: c.isGroup,
        mode: c.mode,
        messages: msgs,
        updatedAt: toMs(c.updatedAt),
        unreadCount: msgs.filter((m) => m.role === 'user' && !m.readAt).length,
      };
      if (c.handoffAt) conv.handoffAt = toMs(c.handoffAt);
      if (c.handoffReason) conv.handoffReason = c.handoffReason;
      conversations.set(c.waJid, conv);
    }

    const enabledGroups = chats.filter((c) => c.isGroup && c.enabled).map((c) => c.waJid);
    const row = config[0];

    return {
      conversations,
      config: {
        systemPrompt: row?.systemPrompt ?? undefined,
        knowledgeBase: row?.knowledgeBase ?? '',
        aiEnabled: row ? row.aiEnabled : true,
        enabledGroups,
        kb: kbRows.map((k) => ({
          id: k.id,
          q: k.question,
          a: k.answer,
          source: k.source,
          createdAt: toMs(k.createdAt),
          updatedAt: toMs(k.updatedAt),
        })),
      },
      numbers: numbers.map((n) => ({
        id: n.id,
        label: n.label,
        connectionState: n.connectionState,
      })),
      lastNumberByJid: new Map(chats.filter((c) => c.numberId).map((c) => [c.waJid, c.numberId])),
      phoneIndex: new Map(contacts.filter((c) => c.phone).map((c) => [c.phone, c.waJid])),
      jidByContactId: new Map(contacts.map((c) => [c.id, c.waJid])),
      labRuns: labRuns.map((r) => r.detail),
      ghl: null,
    };
  }

  /* ── Conversaciones ──────────────────────────────────────────────────────── */

  // Alta/actualización del chat y, para 1-a-1, del contacto que lo respalda.
  // Devuelve el contactId para que el insert de mensajes pueda colgar de él.
  async saveConversation(jid, conv, { phone = null, numberId = null } = {}) {
    let contactId = null;

    if (!conv.isGroup) {
      // El contacto se identifica por JID (con @lid no hay teléfono), y el
      // teléfono se rellena cuando aparece. ON CONFLICT sobre wa_jid, que ya es
      // único en el esquema del CRM.
      const name = conv.name || jid.split('@')[0];
      const [c] = await this.sql`
        INSERT INTO contact ${this.sql({ id: newId('contact'), name, phone, waJid: jid, source: 'whatsapp' }, 'id', 'name', 'phone', 'waJid', 'source')}
        ON CONFLICT (wa_jid) WHERE wa_jid IS NOT NULL DO UPDATE
          SET name = EXCLUDED.name,
              phone = COALESCE(contact.phone, EXCLUDED.phone),
              updated_at = now()
        RETURNING id`;
      contactId = c.id;
      await this.ensureLead(contactId);
    }

    await this.sql`
      INSERT INTO wa_chat ${this.sql(
        {
          waJid: jid,
          contactId,
          isGroup: !!conv.isGroup,
          groupName: conv.isGroup ? conv.name || null : null,
          mode: conv.mode || 'ai',
          handoffAt: toDate(conv.handoffAt),
          handoffReason: conv.handoffReason || null,
          numberId,
          updatedAt: toDate(conv.updatedAt) || new Date(),
        },
        'waJid', 'contactId', 'isGroup', 'groupName', 'mode', 'handoffAt', 'handoffReason', 'numberId', 'updatedAt',
      )}
      ON CONFLICT (wa_jid) DO UPDATE
        SET contact_id     = COALESCE(EXCLUDED.contact_id, wa_chat.contact_id),
            group_name     = EXCLUDED.group_name,
            mode           = EXCLUDED.mode,
            handoff_at     = EXCLUDED.handoff_at,
            handoff_reason = EXCLUDED.handoff_reason,
            number_id      = COALESCE(EXCLUDED.number_id, wa_chat.number_id),
            updated_at     = EXCLUDED.updated_at`;

    return contactId;
  }

  // Todo contacto que escribe entra al pipeline. Lo hacía el espejo por HTTP
  // (apps/crm ingest); al escribir directo en la base hay que hacerlo aquí o el
  // tablero deja de recibir leads — que es media razón de ser del CRM.
  //
  // Un lead por contacto (lead_contact_uq). Si ya existe solo se refresca la
  // última actividad: no se mueve de etapa, porque el operador manda sobre eso.
  async ensureLead(contactId) {
    const [existing] = await this.sql`SELECT id FROM lead WHERE contact_id = ${contactId}`;
    if (existing) {
      await this.sql`UPDATE lead SET last_activity_at = now(), updated_at = now() WHERE id = ${existing.id}`;
      return existing.id;
    }

    const [stage] = await this.sql`SELECT id FROM pipeline_stage ORDER BY position ASC LIMIT 1`;
    if (!stage) return null; // sin pipeline sembrado no hay dónde ponerlo

    const [{ count }] = await this.sql`SELECT count(*)::int AS count FROM lead WHERE stage_id = ${stage.id}`;
    const [created] = await this.sql`
      INSERT INTO lead ${this.sql(
        { id: newId('lead'), contactId, stageId: stage.id, position: count, lastActivityAt: new Date() },
        'id', 'contactId', 'stageId', 'position', 'lastActivityAt',
      )}
      ON CONFLICT (contact_id) DO NOTHING
      RETURNING id`;
    return created?.id ?? null;
  }

  // Un solo INSERT por mensaje: es la diferencia grande con el JSON, que
  // reescribía el archivo entero de conversaciones en cada mensaje entrante.
  async appendMessage(jid, conv, msg) {
    const contactId = await this.saveConversation(jid, conv, { numberId: msg.numberId || null });
    const att = msg.attachment || {};
    await this.sql`
      INSERT INTO message ${this.sql(
        {
          id: newId('msg'),
          contactId,
          waJid: jid,
          role: msg.role === 'manual' ? 'operator' : msg.role,
          text: msg.text ?? null,
          mediaUrl: att.url ?? null,
          mediaType: att.type ?? null,
          transcription: att.transcription ?? null,
          waMessageId: msg.id ?? null,
          numberId: msg.numberId ?? null,
          source: msg.source ?? null,
          ghlMessageId: msg.ghlMessageId ?? null,
          meta: null,
          ts: toDate(msg.ts) || new Date(),
          readAt: toDate(msg.readAt),
        },
        'id', 'contactId', 'waJid', 'role', 'text', 'mediaUrl', 'mediaType', 'transcription',
        'waMessageId', 'numberId', 'source', 'ghlMessageId', 'meta', 'ts', 'readAt',
      )}
      ON CONFLICT (wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING`;
  }

  // markConversationRead() sella todos los pendientes de un chat de una vez.
  async markRead(jid, readAt) {
    await this.sql`
      UPDATE message SET read_at = ${toDate(readAt)}
      WHERE wa_jid = ${jid} AND role = 'user' AND read_at IS NULL`;
  }

  async updateMessageMeta(jid, waMessageId, patch) {
    const { ghlMessageId, ...rest } = patch || {};
    await this.sql`
      UPDATE message
      SET ghl_message_id = COALESCE(${ghlMessageId ?? null}, ghl_message_id),
          meta = COALESCE(meta, '{}'::jsonb) || ${this.sql.json(rest)}::jsonb
      WHERE wa_jid = ${jid} AND wa_message_id = ${waMessageId}`;
  }

  // Funde dos chats del mismo contacto en uno. Pasa cuando WhatsApp entrega el
  // mismo humano bajo dos JID distintos (@lid en entrante, @s.whatsapp.net en
  // saliente desde el celular) y quedan dos fichas del mismo cliente.
  //
  // En una transacción: los mensajes y el teléfono se mudan al destino y el
  // contacto y el chat de origen desaparecen. El lead del origen se descarta
  // (lead_contact_uq impide dos por contacto) y el del destino se conserva, que
  // es el que el operador ha estado moviendo por el tablero.
  async mergeConversations(fromJid, toJid) {
    await this.sql.begin(async (tx) => {
      const [fromChat] = await tx`SELECT contact_id FROM wa_chat WHERE wa_jid = ${fromJid}`;
      const [toChat] = await tx`SELECT contact_id FROM wa_chat WHERE wa_jid = ${toJid}`;
      if (!fromChat || !toChat) return;

      // Los mensajes pasan a colgar del contacto y del chat de destino.
      await tx`
        UPDATE message SET contact_id = ${toChat.contactId}, wa_jid = ${toJid}
        WHERE wa_jid = ${fromJid}`;

      if (fromChat.contactId && fromChat.contactId !== toChat.contactId) {
        // El teléfono es lo único que puede traer el origen y faltarle al destino;
        // contact_phone_uq no admite duplicados, así que hay que moverlo, no copiarlo.
        const [fromContact] = await tx`SELECT phone FROM contact WHERE id = ${fromChat.contactId}`;
        if (fromContact?.phone) {
          await tx`UPDATE contact SET phone = NULL WHERE id = ${fromChat.contactId}`;
          await tx`
            UPDATE contact SET phone = ${fromContact.phone}, updated_at = now()
            WHERE id = ${toChat.contactId} AND phone IS NULL`;
        }
        // Borra en cascada el lead y lo que colgara del contacto de origen.
        await tx`DELETE FROM contact WHERE id = ${fromChat.contactId}`;
      }

      await tx`DELETE FROM wa_chat WHERE wa_jid = ${fromJid}`;
    });
  }

  async deleteConversation(jid) {
    // Los mensajes cuelgan del chat por wa_jid; el contacto se conserva porque es
    // del CRM y puede tener un lead vivo.
    await this.sql`DELETE FROM message WHERE wa_jid = ${jid}`;
    await this.sql`DELETE FROM wa_chat WHERE wa_jid = ${jid}`;
  }

  /* ── Config y base de conocimiento ───────────────────────────────────────── */

  async saveConfig(config) {
    await this.sql`
      INSERT INTO agent_config ${this.sql(
        {
          id: CONFIG_ID,
          systemPrompt: config.systemPrompt ?? '',
          knowledgeBase: config.knowledgeBase ?? '',
          aiEnabled: config.aiEnabled !== false,
          updatedAt: new Date(),
        },
        'id', 'systemPrompt', 'knowledgeBase', 'aiEnabled', 'updatedAt',
      )}
      ON CONFLICT (id) DO UPDATE
        SET system_prompt  = EXCLUDED.system_prompt,
            knowledge_base = EXCLUDED.knowledge_base,
            ai_enabled     = EXCLUDED.ai_enabled,
            updated_at     = EXCLUDED.updated_at`;
  }

  // enabledGroups vive como una bandera por chat, no como lista en la config.
  async setGroupEnabled(jid, enabled) {
    await this.sql`UPDATE wa_chat SET enabled = ${!!enabled} WHERE wa_jid = ${jid}`;
  }

  async saveKbEntry(entry) {
    await this.sql`
      INSERT INTO agent_kb ${this.sql(
        {
          id: entry.id,
          question: entry.q,
          answer: entry.a,
          source: entry.source || 'manual',
          createdAt: toDate(entry.createdAt) || new Date(),
          updatedAt: toDate(entry.updatedAt) || new Date(),
        },
        'id', 'question', 'answer', 'source', 'createdAt', 'updatedAt',
      )}
      ON CONFLICT (id) DO UPDATE
        SET question = EXCLUDED.question,
            answer = EXCLUDED.answer,
            updated_at = EXCLUDED.updated_at`;
  }

  async deleteKbEntry(id) {
    await this.sql`DELETE FROM agent_kb WHERE id = ${id}`;
  }

  /* ── Números ─────────────────────────────────────────────────────────────── */

  async saveNumber(entry, { isDefault = false } = {}) {
    await this.sql`
      INSERT INTO wa_number ${this.sql(
        { id: entry.id, label: entry.label, isDefault },
        'id', 'label', 'isDefault',
      )}
      ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label`;
  }

  async deleteNumber(id) {
    await this.sql`DELETE FROM wa_number WHERE id = ${id}`;
  }

  async setNumberConnection(numberId, state) {
    await this.sql`
      UPDATE wa_number
      SET connection_state = ${state},
          last_connected_at = CASE WHEN ${state} = 'connected' THEN now() ELSE last_connected_at END
      WHERE id = ${numberId}`;
  }

  async noteNumberForJid(jid, numberId) {
    await this.sql`UPDATE wa_chat SET number_id = ${numberId} WHERE wa_jid = ${jid}`;
  }

  /* ── Índice de teléfonos ─────────────────────────────────────────────────── */

  // El índice phone→jid del JSON es, en Postgres, la propia fila del contacto.
  async registerPhone(jid, phone) {
    await this.sql`
      UPDATE contact SET phone = ${phone}, updated_at = now()
      WHERE wa_jid = ${jid} AND phone IS NULL`;
  }

  /* ── Consumo de la IA ────────────────────────────────────────────────────── */

  async saveUsage({ model, kind, inputTokens, outputTokens, waJid }) {
    await this.sql`
      INSERT INTO usage_record ${this.sql(
        { id: newId('usage'), model, kind, inputTokens, outputTokens, waJid: waJid ?? null },
        'id', 'model', 'kind', 'inputTokens', 'outputTokens', 'waJid',
      )}`;
  }

  // Agregado para el panel: por modelo y por tipo de llamada, en un rango.
  // Se agrega en SQL y no en JS porque la tabla crece una fila por llamada al
  // modelo y traérsela entera al proceso deja de ser viable enseguida.
  async usageSummary({ since = null } = {}) {
    const rows = await this.sql`
      SELECT model, kind,
             count(*)::int              AS calls,
             sum(input_tokens)::int     AS input_tokens,
             sum(output_tokens)::int    AS output_tokens
      FROM usage_record
      ${since ? this.sql`WHERE ts >= ${since}` : this.sql``}
      GROUP BY model, kind
      ORDER BY sum(input_tokens + output_tokens) DESC`;
    return rows.map((r) => ({
      model: r.model,
      kind: r.kind,
      calls: r.calls,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
    }));
  }

  /* ── Laboratorio ─────────────────────────────────────────────────────────── */

  async saveLabRun(run) {
    await this.sql`
      INSERT INTO agent_lab_run ${this.sql(
        {
          id: run.id,
          score: run.score ?? null,
          verdict: run.verdict ?? null,
          detail: this.sql.json(run),
          createdAt: toDate(run.startedAt) || new Date(),
        },
        'id', 'score', 'verdict', 'detail', 'createdAt',
      )}
      ON CONFLICT (id) DO UPDATE
        SET score = EXCLUDED.score,
            verdict = EXCLUDED.verdict,
            detail = EXCLUDED.detail`;
  }
}

function rowToMessage(m) {
  const msg = {
    role: m.role === 'operator' ? 'manual' : m.role,
    text: m.text ?? '',
    ts: toMs(m.ts),
  };
  if (m.waMessageId) msg.id = m.waMessageId;
  if (m.numberId) msg.numberId = m.numberId;
  if (m.source) msg.source = m.source;
  if (m.readAt) msg.readAt = toMs(m.readAt);
  if (m.ghlMessageId) msg.ghlMessageId = m.ghlMessageId;
  if (m.mediaUrl) {
    msg.attachment = {
      url: m.mediaUrl,
      type: m.mediaType || null,
      ...(m.transcription ? { transcription: m.transcription } : {}),
    };
  }
  if (m.meta && typeof m.meta === 'object') Object.assign(msg, m.meta);
  return msg;
}
