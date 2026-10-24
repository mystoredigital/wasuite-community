// Tests de la sesión compartida de la suite (node --test). El formato de este
// token es el CONTRATO con el CRM (apps/crm/src/lib/auth.ts lo verifica): si
// cambias el algoritmo aquí sin tocar el CRM, esto debe recordártelo.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.SESSION_SECRET = 'secreto-de-test';

const { signDashboardSession, verifyDashboardSession } = await import('../src/users.js');

test('round-trip: firmar y verificar devuelve el mismo usuario', () => {
  const cookie = signDashboardSession({ username: 'admin', role: 'admin', tenantId: null });
  const session = verifyDashboardSession(cookie);
  assert.deepEqual(session, { username: 'admin', role: 'admin', tenantId: null });
});

test('el tenantId de un usuario client sobrevive el round-trip', () => {
  const cookie = signDashboardSession({ username: 'cliente', role: 'client', tenantId: 'loc_x' });
  assert.deepEqual(verifyDashboardSession(cookie), {
    username: 'cliente', role: 'client', tenantId: 'loc_x',
  });
});

test('token expirado se rechaza', () => {
  const cookie = signDashboardSession({ username: 'admin', role: 'admin', tenantId: null, ttlMs: -1000 });
  assert.equal(verifyDashboardSession(cookie), null);
});

test('firma manipulada se rechaza', () => {
  const cookie = signDashboardSession({ username: 'admin', role: 'admin', tenantId: null });
  const value = cookie.slice(0, cookie.lastIndexOf('.'));
  assert.equal(verifyDashboardSession(`${value}.${'0'.repeat(32)}`), null);
});

test('payload alterado (escalar rol) se rechaza', () => {
  const cookie = signDashboardSession({ username: 'user', role: 'client', tenantId: 'loc_x' });
  const sig = cookie.slice(cookie.lastIndexOf('.') + 1);
  const evil = Buffer.from(
    JSON.stringify({ u: 'user', r: 'admin', t: null, exp: Date.now() + 60000 }), 'utf8',
  ).toString('base64url');
  assert.equal(verifyDashboardSession(`${evil}.${sig}`), null);
});

test('basura no lanza, devuelve null', () => {
  assert.equal(verifyDashboardSession(null), null);
  assert.equal(verifyDashboardSession(''), null);
  assert.equal(verifyDashboardSession('sin-punto'), null);
  assert.equal(verifyDashboardSession('a.b'), null);
});
