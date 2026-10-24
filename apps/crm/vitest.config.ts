import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    // Los tests de integración (pipeline, ingesta) necesitan DATABASE_URL apuntando
    // a un Postgres real (el de docker-compose.local.yml sirve); sin ella se saltan.
    include: ["src/**/*.test.ts"],
  },
});
