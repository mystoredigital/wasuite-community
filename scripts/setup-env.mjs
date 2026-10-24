#!/usr/bin/env node
// Prepara el .env de wasuite: copia .env.example → .env y rellena los secretos
// aleatorios (SESSION_SECRET, INGEST_API_KEY, POSTGRES_PASSWORD y, si está vacía,
// DASHBOARD_PASS). Idempotente: si ya existe un .env, NO lo toca — bórralo antes
// si de verdad quieres regenerarlo.
//
// Uso:  node scripts/setup-env.mjs

import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
const examplePath = join(root, '.env.example');

if (existsSync(envPath)) {
  console.error('Ya existe un .env — no lo sobrescribo. Bórralo si quieres regenerarlo.');
  process.exit(1);
}

const hex = (n) => randomBytes(n).toString('hex');
// Password legible para humanos (sin caracteres ambiguos), 16 chars.
const password = () => {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(16), (b) => alphabet[b % alphabet.length]).join('');
};

let env = readFileSync(examplePath, 'utf8');
const fill = (key, value) => {
  env = env.replace(new RegExp(`^${key}=$`, 'm'), `${key}=${value}`);
};

fill('SESSION_SECRET', hex(32));
fill('INGEST_API_KEY', hex(24));
fill('POSTGRES_PASSWORD', hex(16));
fill('DASHBOARD_PASS', password());

writeFileSync(envPath, env);

const grab = (key) => env.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1];
console.log('.env creado con secretos generados.');
console.log('');
console.log(`  Usuario:    ${grab('DASHBOARD_USER')}`);
console.log(`  Contraseña: ${grab('DASHBOARD_PASS')}`);
console.log('');
console.log('Guarda esa contraseña. Ahora edita el .env y completa:');
console.log('  - CRM_DOMAIN / WA_DOMAIN / COOKIE_DOMAIN (tu dominio)');
console.log('  - OPENROUTER_API_KEY (para que el bot responda)');
console.log('  - BUSINESS_NAME / BUSINESS_DESCRIPTION / TIMEZONE');
