// Conexión a Postgres del agente.
//
// Es la MISMA base que usa el CRM: single-tenant, una instalación = un negocio,
// así que compartir la base es justamente el punto — los chats 1-a-1 son
// contact + message y el agente deja de espejarlos por HTTP.
//
// La conexión es perezosa: si STATE_BACKEND no es 'postgres' nunca se abre, y el
// agente sigue funcionando contra JSON en disco sin exigir una base de datos.

import postgres from 'postgres';

let sql = null;

export function isPgBackend() {
  return (process.env.STATE_BACKEND || 'json').toLowerCase() === 'postgres';
}

export function db() {
  if (sql) return sql;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('STATE_BACKEND=postgres requiere DATABASE_URL');
  sql = postgres(url, {
    max: Number(process.env.PG_POOL_MAX || 10),
    // El esquema es snake_case (drizzle lo genera así) y el agente escribe en
    // camelCase. Sin esto los INSERT apuntan a columnas que no existen.
    transform: postgres.camel,
    // El agente corre en el mismo compose que la base; sin SSL por defecto.
    ssl: process.env.PGSSL === 'true' ? 'require' : false,
    // Los timestamps del esquema son `timestamp without time zone` y se guardan
    // en UTC. Sin esto postgres-js los interpreta en la zona del proceso y los
    // mensajes aparecen desplazados unas horas en el inbox.
    types: {
      date: {
        to: 1114,
        from: [1082, 1114, 1184],
        serialize: (x) => (x instanceof Date ? x.toISOString() : x),
        parse: (x) => new Date(x + 'Z'),
      },
    },
  });
  return sql;
}

export async function closeDb() {
  if (!sql) return;
  await sql.end({ timeout: 5 });
  sql = null;
}
