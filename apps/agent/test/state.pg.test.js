// Los mismos contratos que state.tenantstore.test.js, pero contra Postgres.
//
// Las ASERCIONES son las de la caracterización: es el comportamiento que la
// migración tiene que preservar. Lo que cambia es el arranque — wasuite es
// single-tenant, así que aislar ya no es "otro tenant" sino limpiar las tablas
// entre tests.
//
// Se salta solo si no hay DATABASE_URL, igual que los tests del CRM: así el
// `npm test` de siempre sigue funcionando sin una base delante.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

if (!DB_URL) {
  test('driver Postgres (saltado: sin DATABASE_URL)', { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  process.env.STATE_BACKEND = 'postgres';

  // DATA_ROOT se fija al importar; el driver aún usa el disco para el authDir.
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'wasuite-pg-')));

  const { TenantStore } = await import('../src/state.js');
  const { PgDriver } = await import('../src/state-pg.js');
  const { db, closeDb } = await import('../src/db.js');

  const sql = db();

  async function freshStore() {
    // Orden por las FKs: message y wa_chat cuelgan de contact y wa_number.
    await sql`TRUNCATE message, wa_chat, lead, contact, wa_number, agent_kb, agent_config, agent_lab_run, usage_record CASCADE`;
    // El pipeline lo siembra el CRM al migrar; aquí se recrea la etapa mínima
    // para que ensureLead tenga dónde colocar el lead.
    await sql`TRUNCATE pipeline_stage CASCADE`;
    await sql`INSERT INTO pipeline_stage (id, name, position, kind) VALUES ('stage_test_nuevo', 'Nuevo', 0, 'open')`;
    const store = new TenantStore('_local', {}, new PgDriver('_local'));
    await store.load();
    current = store;
    return store;
  }

  // Releer con un store nuevo es lo que prueba que algo se persistió de verdad.
  async function reload() {
    const again = new TenantStore('_local', {}, new PgDriver('_local'));
    await again.load();
    return again;
  }

  // Las escrituras del driver se disparan sin await, igual que en el camino JSON.
  // drain() espera a que se vacíen de verdad: un sleep fijo falla en cuanto la
  // base responde más lento o el test mete muchos mensajes de golpe.
  let current = null;
  const flush = () => current.driver.drain();

  test.after(async () => { await closeDb(); });

  test('pg: conversaciones y config sobreviven una recarga', async () => {
    const store = await freshStore();
    const jid = '573001112233@s.whatsapp.net';
    store.addMessage(jid, { role: 'user', text: 'hola', id: 'WA1' }, 'Ana');
    store.setPrompt('eres un vendedor');
    await flush();

    const again = await reload();
    const conv = again.conversations.get(jid);
    assert.equal(conv.name, 'Ana');
    assert.equal(conv.messages.length, 1);
    assert.equal(conv.messages[0].text, 'hola');
    assert.equal(again.config.systemPrompt, 'eres un vendedor');
  });

  test('pg: el chat 1-a-1 crea el contacto que ve el CRM', async () => {
    const store = await freshStore();
    const jid = '573001112233@s.whatsapp.net';
    store.addMessage(jid, { role: 'user', text: 'hola', id: 'WA2' }, 'Ana');
    await flush();

    const rows = await sql`SELECT name, wa_jid, source FROM contact`;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'Ana');
    assert.equal(rows[0].waJid, jid);
    assert.equal(rows[0].source, 'whatsapp');
  });

  test('pg: los grupos se guardan sin contacto (no entran al CRM)', async () => {
    const store = await freshStore();
    const jid = '123456@g.us';
    store.getOrCreateConversation(jid);
    store.setGroupName(jid, 'Equipo ventas');
    store.addMessage(jid, { role: 'user', text: 'algo', id: 'WA3' });
    await flush();

    const [chat] = await sql`SELECT is_group, contact_id, group_name FROM wa_chat WHERE wa_jid = ${jid}`;
    assert.equal(chat.isGroup, true);
    assert.equal(chat.contactId, null, 'un grupo no crea contacto en el CRM');
    assert.equal(chat.groupName, 'Equipo ventas');

    const contacts = await sql`SELECT count(*)::int AS n FROM contact`;
    assert.equal(contacts[0].n, 0);
  });

  test('pg: solo los mensajes del contacto suman no leídos', async () => {
    const store = await freshStore();
    const jid = '573001112233@s.whatsapp.net';
    store.addMessage(jid, { role: 'user', text: 'uno', id: 'WA4' });
    store.addMessage(jid, { role: 'assistant', text: 'respuesta', id: 'WA5' });
    store.addMessage(jid, { role: 'user', text: 'dos', id: 'WA6' });
    assert.equal(store.conversations.get(jid).unreadCount, 2);
    await flush();

    store.markConversationRead(jid);
    await flush();

    const again = await reload();
    assert.equal(again.conversations.get(jid).unreadCount, 0);
    const pend = await sql`SELECT count(*)::int AS n FROM message WHERE role = 'user' AND read_at IS NULL`;
    assert.equal(pend[0].n, 0);
  });

  test('pg: setMode guarda el motivo del handoff y lo borra al volver a IA', async () => {
    const store = await freshStore();
    const jid = '573001112233@s.whatsapp.net';

    store.setMode(jid, 'human', 'cliente');
    await flush();
    let again = await reload();
    let conv = again.conversations.get(jid);
    assert.equal(conv.mode, 'human');
    assert.equal(conv.handoffReason, 'cliente');
    assert.ok(conv.handoffAt);

    store.setMode(jid, 'ai');
    await flush();
    again = await reload();
    conv = again.conversations.get(jid);
    assert.equal(conv.mode, 'ai');
    assert.equal(conv.handoffReason, undefined);
    assert.equal(conv.handoffAt, undefined);
  });

  test('pg: las entradas de la KB tienen id estable y se pueden editar y borrar', async () => {
    const store = await freshStore();
    const entry = store.addKbEntry({ q: 'horario?', a: 'de 8 a 5' });
    await flush();

    store.updateKbEntry(entry.id, { a: 'de 9 a 6' });
    await flush();

    let again = await reload();
    assert.equal(again.listKb().length, 1);
    assert.equal(again.listKb()[0].a, 'de 9 a 6');
    assert.equal(again.listKb()[0].id, entry.id, 'el id no cambia al editar');

    store.deleteKbEntry(entry.id);
    await flush();
    again = await reload();
    assert.equal(again.listKb().length, 0);
  });

  test('pg: el teléfono queda en el contacto, que es el índice', async () => {
    const store = await freshStore();
    const jid = '573001112233@s.whatsapp.net';
    store.addMessage(jid, { role: 'user', text: 'hola', id: 'WA7' }, 'Ana');
    await flush();

    store.registerPhone(jid, '+573001112233');
    await flush();

    const again = await reload();
    assert.equal(again.canonicalJidForPhone('+573001112233'), jid);
    const [c] = await sql`SELECT phone FROM contact WHERE wa_jid = ${jid}`;
    assert.equal(c.phone, '+573001112233');
  });

  test('pg: los números se registran y enrutan por JID', async () => {
    const store = await freshStore();
    store.addNumber({ id: 'default', label: 'Principal' });
    store.addNumber({ id: 'ventas', label: 'Ventas' });
    await store.persistNumbers();

    const jid = '573001112233@s.whatsapp.net';
    store.addMessage(jid, { role: 'user', text: 'hola', id: 'WA8' }, 'Ana');
    await flush();
    store.noteNumberForJid(jid, 'ventas');
    await flush();

    const again = await reload();
    assert.equal(again.listNumbers().length, 2);
    assert.equal(again.getDefaultNumberId(), 'default');
    assert.equal(again.getNumberForJid(jid), 'ventas');
  });

  test('pg: el historial completo sobrevive aunque la memoria se recorte a 200', async () => {
    const store = await freshStore();
    const jid = '573001112233@s.whatsapp.net';
    for (let i = 0; i < 220; i++) {
      store.addMessage(jid, { role: 'user', text: `m${i}`, id: `WAX${i}` }, 'Ana');
    }
    await flush();

    assert.equal(store.conversations.get(jid).messages.length, 200, 'en memoria se recorta');
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM message WHERE wa_jid = ${jid}`;
    assert.equal(n, 220, 'en la base queda el historial entero');
  });

  test('pg: reenviar el mismo mensaje de WhatsApp no lo duplica', async () => {
    const store = await freshStore();
    const jid = '573001112233@s.whatsapp.net';
    store.addMessage(jid, { role: 'user', text: 'hola', id: 'DUP1' }, 'Ana');
    await flush();
    store.addMessage(jid, { role: 'user', text: 'hola', id: 'DUP1' }, 'Ana');
    await flush();

    const [{ n }] = await sql`SELECT count(*)::int AS n FROM message WHERE wa_message_id = 'DUP1'`;
    assert.equal(n, 1);
  });

  test('pg: un contacto que escribe entra al pipeline', async () => {
    const store = await freshStore();
    const jid = '573001112233@s.whatsapp.net';
    store.addMessage(jid, { role: 'user', text: 'hola', id: 'LEAD1' }, 'Ana');
    await flush();

    const leads = await sql`
      SELECT l.id, l.stage_id, c.name
      FROM lead l JOIN contact c ON c.id = l.contact_id`;
    assert.equal(leads.length, 1, 'el mensaje entrante abre el lead');
    assert.equal(leads[0].name, 'Ana');
    assert.equal(leads[0].stageId, 'stage_test_nuevo', 'cae en la primera etapa');
  });

  test('pg: más mensajes del mismo contacto no abren un segundo lead', async () => {
    const store = await freshStore();
    const jid = '573001112233@s.whatsapp.net';
    store.addMessage(jid, { role: 'user', text: 'uno', id: 'LEAD2' }, 'Ana');
    await flush();
    store.addMessage(jid, { role: 'user', text: 'dos', id: 'LEAD3' }, 'Ana');
    await flush();

    const [{ n }] = await sql`SELECT count(*)::int AS n FROM lead`;
    assert.equal(n, 1);
  });

  test('pg: un grupo no abre lead (no es una persona del pipeline)', async () => {
    const store = await freshStore();
    const jid = '999888@g.us';
    store.addMessage(jid, { role: 'user', text: 'algo', id: 'LEAD4' });
    await flush();

    const [{ n }] = await sql`SELECT count(*)::int AS n FROM lead`;
    assert.equal(n, 0);
  });

  test('pg: combinar dos chats del mismo cliente deja una sola ficha', async () => {
    const store = await freshStore();
    const lid = '99887766@lid';
    const clasico = '573001112233@s.whatsapp.net';

    // El mismo humano entrando por @lid y saliendo por el JID clásico.
    store.addMessage(lid, { role: 'user', text: 'desde lid', id: 'M1', ts: 1000 }, 'Andres');
    store.addMessage(clasico, { role: 'user', text: 'desde clasico', id: 'M2', ts: 2000 }, 'Andres');
    await flush();
    store.registerPhone(lid, '+573001112233');
    await flush();

    let contactos = await sql`SELECT count(*)::int AS n FROM contact`;
    assert.equal(contactos[0].n, 2, 'arrancamos con la ficha duplicada');

    await store.mergeConversations(lid, clasico);

    contactos = await sql`SELECT id, phone FROM contact`;
    assert.equal(contactos.length, 1, 'queda una sola ficha');
    assert.equal(contactos[0].phone, '+573001112233', 'el teléfono se muda al superviviente');

    const msgs = await sql`SELECT text FROM message WHERE wa_jid = ${clasico} ORDER BY ts`;
    assert.deepEqual(msgs.map((m) => m.text), ['desde lid', 'desde clasico'], 'el historial queda unido y en orden');

    const chats = await sql`SELECT wa_jid FROM wa_chat`;
    assert.deepEqual(chats.map((c) => c.waJid), [clasico], 'el chat de origen desaparece');

    const [{ n }] = await sql`SELECT count(*)::int AS n FROM lead`;
    assert.equal(n, 1, 'un solo lead: lead_contact_uq no admite dos por contacto');
  });

  test('pg: cada llamada al modelo queda registrada con sus tokens', async () => {
    const store = await freshStore();
    const { setUsageSink, recordUsage } = await import('../src/usage.js');
    setUsageSink((row) => store.driver.saveUsage(row));

    // Forma real de la respuesta de OpenRouter.
    recordUsage({
      model: 'openai/gpt-4o-mini',
      kind: 'chat',
      usage: { prompt_tokens: 120, completion_tokens: 45 },
      waJid: '573001112233@s.whatsapp.net',
    });
    recordUsage({ model: 'openai/gpt-4o-mini', kind: 'summary', usage: { prompt_tokens: 900, completion_tokens: 60 } });
    await flush();

    const rows = await sql`SELECT model, kind, input_tokens, output_tokens, wa_jid FROM usage_record ORDER BY kind`;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].kind, 'chat');
    assert.equal(rows[0].inputTokens, 120);
    assert.equal(rows[0].outputTokens, 45);
    assert.equal(rows[0].waJid, '573001112233@s.whatsapp.net');
    assert.equal(rows[1].kind, 'summary');
    assert.equal(rows[1].waJid, null, 'un resumen no pertenece a un chat concreto');

    setUsageSink(null);
  });

  test('pg: una llamada sin datos de consumo no ensucia la tabla', async () => {
    const store = await freshStore();
    const { setUsageSink, recordUsage } = await import('../src/usage.js');
    setUsageSink((row) => store.driver.saveUsage(row));

    // Algunos proveedores no devuelven usage; no hay nada que registrar.
    recordUsage({ model: 'x', kind: 'chat', usage: undefined });
    recordUsage({ model: 'x', kind: 'chat', usage: { prompt_tokens: 0, completion_tokens: 0 } });
    await flush();

    const [{ n }] = await sql`SELECT count(*)::int AS n FROM usage_record`;
    assert.equal(n, 0);

    setUsageSink(null);
  });
}
