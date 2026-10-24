# ── deps ────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# ── build ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── runtime ─────────────────────────────────────────────────────────────────
# Imagen mínima gracias a output:"standalone" — solo el server y sus deps reales.
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=build /app/public ./public
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
# Migraciones + script para aplicarlas al arrancar
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/node_modules/drizzle-orm ./node_modules/drizzle-orm
COPY --from=build /app/node_modules/postgres ./node_modules/postgres

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Aplica migraciones (+ etapas por defecto) y luego arranca el server.
CMD ["sh", "-c", "node scripts/migrate.mjs && node server.js"]
