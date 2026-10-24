import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * Conexión perezosa a Postgres. No conectamos al importar el módulo: `next build`
 * evalúa los módulos sin base de datos disponible, así que abrir el socket aquí
 * rompería la compilación. El cliente se crea en la primera query.
 *
 * En dev, Next recarga módulos en caliente; guardamos el cliente en globalThis para
 * no fugar una conexión nueva en cada recarga.
 */
const globalForDb = globalThis as unknown as {
  _pg?: ReturnType<typeof postgres>;
  _db?: ReturnType<typeof drizzle<typeof schema>>;
};

function client() {
  if (!globalForDb._pg) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL no está definida");
    globalForDb._pg = postgres(url, { max: 10 });
  }
  return globalForDb._pg;
}

export function getDb() {
  if (!globalForDb._db) {
    globalForDb._db = drizzle(client(), { schema, casing: "snake_case" });
  }
  return globalForDb._db;
}

export { schema };
