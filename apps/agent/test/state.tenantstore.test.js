// Tests de caracterización de TenantStore.
//
// Fijan el comportamiento OBSERVABLE de la capa de estado tal como es hoy sobre
// JSON en disco. Son la especificación ejecutable de la migración a Postgres: la
// implementación nueva tiene que pasar este mismo archivo sin tocarlo. Por eso
// verifican contratos (qué queda guardado, qué se recarga, qué se emite) y no
// detalles internos como nombres de archivo.
//
// DATA_ROOT se resuelve contra process.cwd() al importar el módulo, así que el
// chdir a un temporal tiene que ir ANTES del import dinámico.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wasuite-state-'));
process.chdir(tmpRoot);

const { TenantStore } = await import('../src/state.js');

// Cada test usa su propio tenant para no compartir estado a través del disco.
let n = 0;
async function freshStore() {
  const store = new TenantStore(`t${++n}`);
  await store.load();
  return store;
}

// Releer desde disco es la única forma de comprobar que algo se persistió de
// verdad y no quedó solo en memoria.
async function reload(store) {
  const again = new TenantStore(store.tenantId);
  await again.load();
  return again;
}

// persistConversations/persistConfig se disparan sin await dentro de los métodos.
const flush = () => new Promise((r) => setTimeout(r, 50));

test('conversaciones y config sobreviven una recarga', async () => {
  const store = await freshStore();
  store.addMessage('573001112233@s.whatsapp.net', { role: 'user', text: 'hola' }, 'Ana');
  store.setPrompt('eres un vendedor');
  await flush();

  const again = await reload(store);
  const conv = again.conversations.get('573001112233@s.whatsapp.net');
  assert.equal(conv.name, 'Ana');
  assert.equal(conv.messages.length, 1);
  assert.equal(conv.messages[0].text, 'hola');
  assert.equal(again.config.systemPrompt, 'eres un vendedor');
});

test('los grupos arrancan en modo humano y los chats 1-a-1 en IA', async () => {
  const store = await freshStore();
  assert.equal(store.getOrCreateConversation('123@g.us').mode, 'human');
  assert.equal(store.getOrCreateConversation('573001112233@s.whatsapp.net').mode, 'ai');
});

test('solo los mensajes del contacto suman no leídos', async () => {
  const store = await freshStore();
  const jid = '573001112233@s.whatsapp.net';
  store.addMessage(jid, { role: 'user', text: 'uno' });
  store.addMessage(jid, { role: 'assistant', text: 'respuesta' });
  store.addMessage(jid, { role: 'user', text: 'dos' });
  assert.equal(store.conversations.get(jid).unreadCount, 2);

  const { newlyRead } = store.markConversationRead(jid);
  assert.equal(newlyRead.length, 2);
  assert.equal(store.conversations.get(jid).unreadCount, 0);
  assert.ok(store.conversations.get(jid).messages.every((m) => m.role !== 'user' || m.readAt));
});

test('setMode guarda el motivo del handoff y lo borra al volver a IA', async () => {
  const store = await freshStore();
  const jid = '573001112233@s.whatsapp.net';

  store.setMode(jid, 'human', 'cliente');
  let conv = store.conversations.get(jid);
  assert.equal(conv.mode, 'human');
  assert.equal(conv.handoffReason, 'cliente');
  assert.ok(conv.handoffAt);

  store.setMode(jid, 'ai');
  conv = store.conversations.get(jid);
  assert.equal(conv.mode, 'ai');
  assert.equal(conv.handoffReason, undefined);
  assert.equal(conv.handoffAt, undefined);
});

test('setMode sin motivo explícito lo atribuye al operador', async () => {
  const store = await freshStore();
  const jid = '573001112233@s.whatsapp.net';
  store.setMode(jid, 'human');
  assert.equal(store.conversations.get(jid).handoffReason, 'operador');
});

test('las entradas de la KB tienen id estable y se pueden editar y borrar', async () => {
  const store = await freshStore();
  const entry = store.addKbEntry({ q: 'horario?', a: 'de 8 a 5' });
  assert.ok(entry.id);

  store.updateKbEntry(entry.id, { a: 'de 9 a 6' });
  assert.equal(store.listKb()[0].a, 'de 9 a 6');
  assert.equal(store.listKb()[0].id, entry.id, 'el id no cambia al editar');

  await flush();
  const again = await reload(store);
  assert.equal(again.listKb()[0].a, 'de 9 a 6');

  assert.equal(store.deleteKbEntry(entry.id), true);
  assert.equal(store.deleteKbEntry(entry.id), false, 'borrar dos veces no revienta');
  assert.equal(store.listKb().length, 0);
});

test('la KB rechaza entradas incompletas', async () => {
  const store = await freshStore();
  assert.throws(() => store.addKbEntry({ q: '', a: 'algo' }));
  assert.throws(() => store.addKbEntry({ q: 'algo', a: '   ' }));
});

test('renderKnowledgeBase funde las Q&A con el texto libre', async () => {
  const store = await freshStore();
  store.addKbEntry({ q: 'envian a todo el pais?', a: 'si, a todo el pais' });
  store.setKnowledgeBase('Catalogo: camisas y pantalones.');

  const rendered = store.renderKnowledgeBase();
  assert.match(rendered, /envian a todo el pais/);
  assert.match(rendered, /si, a todo el pais/);
  assert.match(rendered, /Catalogo/);
});

test('registerPhone conserva el primer JID canónico', async () => {
  const store = await freshStore();
  store.registerPhone('573001112233@s.whatsapp.net', '+573001112233');
  store.registerPhone('99887766@lid', '+573001112233');
  assert.equal(store.canonicalJidForPhone('+573001112233'), '573001112233@s.whatsapp.net');
});

test('phoneForJid deduce el número de un JID clásico aunque no esté en el índice', async () => {
  const store = await freshStore();
  assert.equal(store.phoneForJid('573001112233@s.whatsapp.net'), '+573001112233');
  assert.equal(store.phoneForJid('99887766@lid'), null);

  store.registerPhone('99887766@lid', '+573009998877');
  assert.equal(store.phoneForJid('99887766@lid'), '+573009998877');
});

test('los números se registran, se listan y enrutan por JID', async () => {
  const store = await freshStore();
  store.addNumber({ id: 'default', label: 'Principal' });
  store.addNumber({ id: 'ventas', label: 'Ventas' });

  assert.equal(store.getDefaultNumberId(), 'default');
  assert.equal(store.listNumbers().length, 2);

  const jid = '573001112233@s.whatsapp.net';
  store.noteNumberForJid(jid, 'ventas');
  assert.equal(store.getNumberForJid(jid), 'ventas');
});

test('una conversación no crece sin límite', async () => {
  const store = await freshStore();
  const jid = '573001112233@s.whatsapp.net';
  for (let i = 0; i < 250; i++) store.addMessage(jid, { role: 'user', text: `m${i}` });

  const conv = store.conversations.get(jid);
  assert.equal(conv.messages.length, 200);
  assert.equal(conv.messages.at(-1).text, 'm249', 'se conservan los más recientes');
});

test('escrituras concurrentes no dejan el JSON corrupto', async () => {
  const store = await freshStore();
  const jid = '573001112233@s.whatsapp.net';
  // persistConversations() se dispara sin await en cada mensaje entrante: este es
  // justo el escenario que motivó writeJsonAtomic.
  for (let i = 0; i < 60; i++) store.addMessage(jid, { role: 'user', text: `x${i}` });
  await Promise.all([store.persistConversations(), store.persistConversations()]);
  await flush();

  const again = await reload(store);
  assert.equal(again.conversations.get(jid).messages.length, 60);
});
