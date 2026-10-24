# apps/agent — Agente de WhatsApp con IA

El motor de WhatsApp de **wasuite**. Node 20+ / Express / [Baileys](https://github.com/WhiskeySockets/Baileys)
(multi-device, vinculación por QR) + IA vía OpenRouter.

> La instalación, configuración y despliegue de la suite completa están en el
> [README raíz](../../README.md). Este documento describe solo este módulo.

## Qué hace

- **Bot con IA**: responde con el prompt del negocio + base de conocimiento
  (Q&A estructuradas y texto libre). Tool-calling de Google Calendar para agendar.
- **Handoff a humano**: detección determinista ("quiero hablar con una persona")
  + marcador `[[HANDOFF]]` de la IA. El chat pasa a modo humano y el bot calla.
- **Anti-ban**: delays con jitter humano, cooldown por chat, tope global por
  minuto, horas de silencio, proxy de salida por número.
- **Laboratorio**: 6 clientes simulados conversan contra el bot real en sandbox
  y un juez LLM lo puntúa 0–100 con sugerencias aplicables a la KB.
- **Multi-número**: varias líneas de WhatsApp por instalación, cada una con su QR.
- **Media**: imágenes/audio a Cloudflare R2 (opcional) y transcripción de notas
  de voz con Whisper (opcional).
- **Integraciones**: empuja mensajes y leads al CRM de la suite; espejo
  bidireccional opcional con GoHighLevel; sync opcional con Twenty-CRM.

## API

REST documentada con OpenAPI en `/api/docs` (Swagger UI). Auth: cookie de sesión
de la suite (SSO), API keys `wa_…` (Bearer), o Basic con `DASHBOARD_USER/PASS`.
El socket.io exige la misma autenticación y aplica scope por tenant.

## Datos

Estado en archivos JSON bajo `data/` (volumen `agent-data` en Docker): sesión de
Baileys, conversaciones, config del bot, KB, corridas del laboratorio. El
historial de mensajes se persiste además en el Postgres del CRM vía la ingesta.
