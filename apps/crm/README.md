# CRM · My Store Digital

CRM self-hosted para negocios que venden por WhatsApp. **Tus datos viven en tu
servidor, no en un tercero.** Pipeline kanban, contactos y leads — pensado para
soltarse de GoHighLevel y, más adelante, alimentarse solo desde el
agente de WhatsApp de la suite (`apps/agent`).

> Estado: base funcional (pipeline + contactos). En construcción.

## Stack

- **Next.js 15** (App Router) + **React 19** + **TypeScript**
- **Postgres** + **Drizzle ORM** — los datos son tuyos, en tu Postgres
- **Tailwind** + sistema de tokens (tema claro/oscuro)
- **dnd-kit** para el kanban con drag & drop
- Despliegue en **Dokploy** vía Docker (imagen `standalone`)

## Modelo de datos

Una instancia = un negocio. Tres entidades:

```
contact ──1:1── lead ──N:1── pipeline_stage
```

- **contact** — la persona (nombre, teléfono, email, empresa, notas). `source`
  deja rastro de dónde vino (`manual`, `whatsapp`, `seed`…).
- **pipeline_stage** — columnas del kanban. `kind`: `open` normales, `won`/`lost`
  anclas de cierre que no se pueden borrar.
- **lead** — un contacto dentro del pipeline, en una etapa. `position` ordena las
  tarjetas; `valueCents` es el monto del trato.

El movimiento de leads (`moveLead`) es **transaccional**: mover una tarjeta toca
varias filas y sin transacción dos arrastres simultáneos dejarían las posiciones
inconsistentes.

## Desarrollo local

Requiere Node ≥ 20 y Docker (para el Postgres local).

```bash
cp .env.example .env
npm install

# 1. Levanta Postgres
docker compose -f docker-compose.dev.yml up -d

# 2. Aplica el esquema y carga datos de ejemplo
npm run db:migrate
npm run db:seed

# 3. Arranca la app
npm run dev
```

Abre <http://localhost:3000> → te lleva al pipeline.

### Scripts

| Script | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo |
| `npm run build` | Build de producción (standalone) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:generate` | Genera una migración desde el esquema |
| `npm run db:migrate` | Aplica las migraciones pendientes |
| `npm run db:seed` | Pipeline inicial + datos de ejemplo |

## Estructura

```
src/
  app/
    pipeline/         # el kanban (página estrella)
    contacts/         # lista de contactos
    api/              # route handlers (pipeline, leads, contacts)
  components/
    pipeline/         # board (dnd), stage-column, lead-card
    contacts/         # contacts-client
    ui/               # button, input… sistema de diseño
    app-shell.tsx     # nav lateral
  server/
    pipeline.ts       # lógica del tablero + moveLead transaccional
    contacts.ts       # acceso a contactos
  lib/
    db/               # schema Drizzle, conexión, ids
    utils.ts
scripts/
  migrate.ts          # aplica migraciones (se corre en el deploy)
  seed.ts             # datos iniciales
drizzle/              # migraciones SQL generadas
```

## Despliegue (Dokploy)

`docker-compose.yml` levanta la app + Postgres. Traefik enruta la app por el
dominio. Las variables sensibles (`DATABASE_URL`, `POSTGRES_PASSWORD`) se inyectan
desde Dokploy, nunca van en git. El volumen de Postgres (`../files/pgdata`)
sobrevive a los redeploys.

Las migraciones se aplican con `npm run db:migrate` (correr antes de arrancar, o
como paso de deploy).

## Ingesta desde WhatsApp

El agente de WhatsApp crea leads solo: cuando entra un mensaje, llama a
`POST /api/ingest/whatsapp` con el teléfono y el nombre. El CRM hace upsert del
contacto (por teléfono, `source: whatsapp`) y le abre un lead en la primera etapa si
no tenía. Es idempotente: varios mensajes del mismo número no duplican nada.

Se autentica con API key (header `x-api-key` = `INGEST_API_KEY`), no con la cookie de
sesión, porque la llama una máquina. Vacía = ingesta cerrada. Ese endpoint está exento
del middleware de sesión; todo lo demás sigue protegido.

La integración vive en una instalación aparte del agente (la de producción sigue con
GHL). Ejemplo:

```bash
curl -X POST https://tu-crm/api/ingest/whatsapp \
  -H "x-api-key: $INGEST_API_KEY" -H "Content-Type: application/json" \
  -d '{"phone":"+593 99 111 2233","name":"Pedro","message":"Hola"}'
```

## Roadmap

- [x] Pipeline kanban con drag & drop
- [x] Contactos + alta + añadir al pipeline (vista tarjetas y lista)
- [x] Gestión de etapas desde la UI (crear, renombrar, color, borrar)
- [x] Editar lead (monto, título) desde la tarjeta
- [x] Autenticación (login con sesión firmada + middleware)
- [x] Ingesta desde el agente de WhatsApp (`POST /api/ingest/whatsapp`, API key)
- [ ] Reordenar etapas arrastrando columnas
- [ ] Actividad / timeline por contacto
