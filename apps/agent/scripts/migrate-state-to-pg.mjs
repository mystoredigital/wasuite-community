#!/usr/bin/env node
// Migra el estado del agente de data/<tenant>/*.json a Postgres.
//
//   DATABASE_URL=postgres://... node scripts/migrate-state-to-pg.mjs [--dry-run]
//
// Es idempotente: se apoya en los mismos upserts que usa el driver en caliente,
// así que volver a correrlo no duplica nada. Los mensajes se deduplican por
// wa_message_id; los pocos que no traigan id de WhatsApp (mensajes viejos) sí se
// insertarían de nuevo, y por eso el script avisa cuántos hay antes de tocar nada.
//
// Correr con el agente PARADO. Si sigue vivo puede escribir en el JSON mientras
// se lee y dejar la copia a medias — y encima el estado seguiría partido en dos.
//
// Lo que NO migra (sigue en disco, y así se queda por ahora):
//   - la sesión de Baileys (auth/), que no hay que tocar: es lo que mantiene el
//     número vinculado.
//   - tokens.json de GoHighLevel.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DRY = process.argv.includes('--dry-run');
const DATA_ROOT = path.resolve('./data');

if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL');
  process.exit(1);
}

const { db, closeDb } = await import('../src/db.js');
const { PgDriver } = await import('../src/state-pg.js');

const sql = db();

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function main() {
  const entries = await fs.readdir(DATA_ROOT, { withFileTypes: true }).catch(() => []);
  const tenants = entries.filter((e) => e.isDirectory() && e.name !== '_agencies').map((e) => e.name);

  if (!tenants.length) {
    console.log('No hay tenants en data/ — nada que migrar.');
    return;
  }
  // wasuite es single-tenant. Si alguien llega aquí con varios directorios es un
  // resto de la época GHL: mezclarlos en una sola base fundiría negocios distintos.
  if (tenants.length > 1) {
    console.error(`Hay ${tenants.length} tenants (${tenants.join(', ')}) y la base es single-tenant.`);
    console.error('Migra uno por instalación, o consolida antes a mano. Abortando.');
    process.exit(1);
  }

  const tenantId = tenants[0];
  const dir = path.join(DATA_ROOT, tenantId);
  console.log(`Tenant: ${tenantId}${DRY ? '  (simulación, no escribe)' : ''}`);

  const conversations = await readJson(path.join(dir, 'conversations.json'), {});
  const config = await readJson(path.join(dir, 'config.json'), {});
  const numbers = await readJson(path.join(dir, 'numbers.json'), { list: [], lastNumberByJid: {} });
  const phoneIndex = await readJson(path.join(dir, 'phone-index.json'), {});
  const labRuns = await readJson(path.join(dir, 'lab-runs.json'), []);

  const convList = Object.entries(conversations);
  const totalMsgs = convList.reduce((n, [, c]) => n + (c.messages?.length || 0), 0);
  const sinId = convList.reduce((n, [, c]) => n + (c.messages || []).filter((m) => !m.id).length, 0);

  console.log(`  conversaciones : ${convList.length}`);
  console.log(`  mensajes       : ${totalMsgs}${sinId ? `  (${sinId} sin id de WhatsApp — no deduplicables)` : ''}`);
  console.log(`  números        : ${(numbers.list || []).length}`);
  console.log(`  KB (Q&A)       : ${(config.kb || []).length}`);
  console.log(`  teléfonos      : ${Object.keys(phoneIndex).length}`);
  console.log(`  corridas Lab   : ${Array.isArray(labRuns) ? labRuns.length : 0}`);

  if (DRY) {
    console.log('\nSimulación: no se escribió nada.');
    return;
  }

  const driver = new PgDriver(tenantId);
  const defaultId = (numbers.list || [])[0]?.id || null;

  for (const n of numbers.list || []) {
    driver.saveNumber({ id: n.id, label: n.label || n.id }, { isDefault: n.id === defaultId });
  }

  driver.saveConfig({
    systemPrompt: config.systemPrompt ?? '',
    knowledgeBase: config.knowledgeBase ?? '',
    aiEnabled: config.aiEnabled !== false,
  });

  for (const entry of config.kb || []) driver.saveKbEntry(entry);
  for (const run of Array.isArray(labRuns) ? labRuns : []) driver.saveLabRun(run);
  await driver.drain();

  // Índice inverso jid → teléfono, para rellenar contact.phone al crear el chat.
  const phoneByJid = new Map(Object.entries(phoneIndex).map(([phone, jid]) => [jid, phone]));

  let migradas = 0;
  let migrados = 0;
  for (const [jid, conv] of convList) {
    const numberId = numbers.lastNumberByJid?.[jid] || null;
    await driver.saveConversation(jid, conv, { phone: phoneByJid.get(jid) || null, numberId });
    for (const msg of conv.messages || []) {
      await driver.appendMessage(jid, conv, msg);
      migrados++;
    }
    if (conv.isGroup && (config.enabledGroups || []).includes(jid)) {
      await driver.setGroupEnabled(jid, true);
    }
    migradas++;
    if (migradas % 25 === 0) console.log(`  … ${migradas}/${convList.length} conversaciones`);
  }
  await driver.drain();

  const [{ contactos }] = await sql`SELECT count(*)::int AS contactos FROM contact`;
  const [{ mensajes }] = await sql`SELECT count(*)::int AS mensajes FROM message`;
  const [{ chats }] = await sql`SELECT count(*)::int AS chats FROM wa_chat`;

  console.log(`\nMigrado: ${migradas} conversaciones, ${migrados} mensajes.`);
  console.log(`En la base: ${chats} chats, ${contactos} contactos, ${mensajes} mensajes.`);
  console.log('\nAhora arranca el agente con STATE_BACKEND=postgres.');
  console.log('Los JSON quedan intactos: son el rollback si algo sale mal.');
}

try {
  await main();
} finally {
  await closeDb();
}
