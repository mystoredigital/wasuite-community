import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// Aplica las migraciones de ./drizzle. Se corre en el deploy antes de arrancar la app.
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL no está definida");
  process.exit(1);
}

const sql = postgres(url, { max: 1 });
const db = drizzle(sql);

await migrate(db, { migrationsFolder: "./drizzle" });
console.log("[migrate] migraciones aplicadas");
await sql.end();
