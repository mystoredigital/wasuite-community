// Generador de ids con prefijo, espejo de apps/crm/src/lib/db/ids.ts.
//
// Existe porque las claves de contact y message NO tienen DEFAULT en la base: las
// genera drizzle en la aplicación. El agente escribe con postgres-js crudo, así
// que tiene que generarlas igual o el INSERT falla por id nulo.
//
// El FORMATO es lo que tiene que coincidir (prefijo + 16 caracteres de este
// alfabeto), no el algoritmo: los ids que crea el agente y los que crea el CRM
// deben ser indistinguibles. Si cambias el alfabeto o la longitud aquí, cámbialo
// también allá.

import { randomBytes } from 'node:crypto';

// Sin caracteres ambiguos (I, l, O, U) para que un id se pueda leer y dictar.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZabcdefghijkmnpqrstvwxyz';
const LENGTH = 16;

const PREFIX = {
  contact: 'contact',
  msg: 'msg',
  lead: 'lead',
  usage: 'usage',
};

export function newId(kind) {
  const prefix = PREFIX[kind];
  if (!prefix) throw new Error(`prefijo de id desconocido: ${kind}`);
  const bytes = randomBytes(LENGTH);
  let out = '';
  for (let i = 0; i < LENGTH; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return `${prefix}_${out}`;
}
