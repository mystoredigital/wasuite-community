import { listAvailability, bookAppointment, isConfigured as calendarConfigured } from './calendar.js';
import { recordUsage } from './usage.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Capa de comportamiento que se inyecta SIEMPRE, por encima del prompt que el
// operador configura por tenant. Define cómo "suena" el bot para que se porte
// como una persona real y no como un bot que saluda a toda hora.
const BEHAVIOR_LAYER = `ESTILO Y PERSONALIDAD (CRÍTICO — define cómo suenas):
- Escribes como una persona real del equipo, no como un bot. NUNCA digas que eres una IA, asistente virtual, bot o sistema automático. No firmes tus mensajes.
- Saluda SOLO en tu primer mensaje de la conversación. Si el hilo ya tiene mensajes anteriores, NO vuelvas a saludar ("Hola", "Buenas", "¿En qué te puedo ayudar?") — retoma la conversación con naturalidad, como quien sigue un chat que ya venía.
- Mensajes cortos y conversacionales, como un chat de WhatsApp real (1-3 líneas casi siempre). Nada de párrafos largos, listas con viñetas ni lenguaje corporativo.
- Espeja el tono del cliente: si escribe informal y de "tú", responde igual; si es formal, sé un poco más formal. Usa su nombre con naturalidad de vez en cuando, no en cada mensaje.
- No repitas lo que ya dijiste ni te vuelvas a presentar. Evita muletillas de bot ("¡Claro que sí!", "Estoy aquí para ayudarte", "Como asistente...", "¡Con gusto!").
- Una sola idea o pregunta por mensaje cuando se pueda. Directo, cálido y humano.
- Si no sabes algo, dilo con naturalidad y ofrece confirmarlo con el equipo; no inventes.`;

// Marcador que el LLM añade cuando decide que el caso debe pasar a un humano.
// Nunca llega al cliente: splitHandoff() lo arranca del texto antes de enviarlo.
export const HANDOFF_MARKER = '[[HANDOFF]]';

// Capa de escalado. Sin esto el bot dice "un humano te confirmará" y no escala a
// nadie: la conversación se queda en modo IA y el cliente esperando.
const ESCALATION_LAYER = `CUÁNDO PASAR A UN HUMANO:
- Si te preguntan algo que NO puedes responder con la base de conocimiento y el contexto que tienes (precios que no conoces, un reclamo, un caso raro), NO inventes ni prometas datos.
- Si el cliente pide explícitamente hablar con una persona, tampoco insistas en atenderlo tú.
- En esos casos: responde en una línea, con naturalidad, que un compañero del equipo lo atiende enseguida, y termina tu mensaje con la etiqueta exacta ${HANDOFF_MARKER}.
- La etiqueta es una señal interna para el equipo: el cliente NO la ve. Ponla solo cuando de verdad haga falta un humano, nunca "por si acaso".`;

// El cliente pidiendo un humano de forma explícita. Se evalúa sobre el mensaje
// ENTRANTE, antes de gastar una llamada al LLM: es determinista y no depende de
// que el modelo coopere con el marcador. Puede ampliarse con HANDOFF_KEYWORDS.
const HUMAN_REQUEST_RE =
  /\b(?:hablar|habla|comunicar(?:me)?|contactar|atienda|atiendan|pasa(?:me|rme)|transfier(?:e|an)|quiero|necesito|p[oó]ngame|con)\b[^.!?\n]{0,45}\b(?:human[oa]|persona(?:\s+real)?|asesor(?:a)?|agente\s+humano|ejecutiv[oa]|representante|encargad[oa]|supervisor(?:a)?|gerente|alguien\s+(?:real|del\s+equipo)|operador(?:a)?)\b/i;

const EXTRA_HANDOFF_KEYWORDS = (process.env.HANDOFF_KEYWORDS || '')
  .split(',')
  .map((k) => k.trim().toLowerCase())
  .filter(Boolean);

/**
 * ¿El cliente está pidiendo hablar con una persona?
 * Deliberadamente conservador: preferimos no escalar de más (molesta al operador)
 * a escalar de menos (el marcador del LLM cubre el resto de los casos).
 */
export function detectHumanRequest(text) {
  const t = (text || '').trim();
  if (!t) return false;
  if (HUMAN_REQUEST_RE.test(t)) return true;
  const lower = t.toLowerCase();
  return EXTRA_HANDOFF_KEYWORDS.some((k) => lower.includes(k));
}

/**
 * Separa el marcador de handoff de la respuesta del LLM.
 * Devuelve { text, handoff }. El texto sale siempre limpio, aunque el modelo
 * ponga el marcador a medias, en mayúsculas raras o con basura alrededor.
 */
export function splitHandoff(reply) {
  const raw = (reply || '').toString();
  const re = /\[\[\s*HANDOFF\s*\]\]/gi;
  const handoff = re.test(raw);
  if (!handoff) return { text: raw.trim(), handoff: false };
  const text = raw.replace(/\[\[\s*HANDOFF\s*\]\]/gi, '').replace(/\n{3,}/g, '\n\n').trim();
  return { text, handoff: true };
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_availability',
      description: 'Lista horarios disponibles en el calendario para una fecha dada. Úsalo cuando el cliente pide reunirse.',
      parameters: {
        type: 'object',
        properties: {
          dateISO: { type: 'string', description: 'Fecha en formato YYYY-MM-DD' },
          durationMinutes: { type: 'integer', description: 'Duración del slot en minutos. Default 60.', default: 60 },
        },
        required: ['dateISO'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'book_appointment',
      description: 'Reserva una cita en el calendario. Solo úsalo después de confirmar fecha/hora exacta con el cliente.',
      parameters: {
        type: 'object',
        properties: {
          startISO: { type: 'string', description: 'Inicio en ISO 8601 con timezone' },
          endISO: { type: 'string', description: 'Fin en ISO 8601 con timezone' },
          summary: { type: 'string', description: 'Título del evento' },
          description: { type: 'string', description: 'Descripción / agenda' },
          attendeeName: { type: 'string' },
          attendeePhone: { type: 'string' },
        },
        required: ['startISO', 'endISO', 'attendeeName'],
      },
    },
  },
];

async function executeTool(name, args) {
  if (!calendarConfigured()) {
    return { error: 'Calendar no configurado en el servidor.' };
  }
  if (name === 'list_availability') return await listAvailability(args);
  if (name === 'book_appointment') return await bookAppointment(args);
  return { error: `Tool desconocida: ${name}` };
}

// Llamada de bajo nivel a OpenRouter. Reutilizada por generateReply (con tools)
// y por summarizeConversation (sin tools). Devuelve el message del primer choice.
async function callOpenRouter(messages, { tools, model, timeoutMs = 45_000, jsonMode = false, kind = 'chat', waJid = null } = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY no definido');
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:3000',
      'X-Title': process.env.OPENROUTER_SITE_NAME || 'WhatsApp Agent',
    },
    body: JSON.stringify({
      model, messages, tools,
      tool_choice: tools ? 'auto' : undefined,
      response_format: jsonMode ? { type: 'json_object' } : undefined,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((e) => {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new Error(`OpenRouter timeout (${timeoutMs / 1000}s)`);
    throw e;
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const choice = data.choices?.[0];
  if (!choice) throw new Error('OpenRouter sin choices');
  // Aquí, y no en los callers, porque el tool-calling da varias vueltas por
  // respuesta y todas se pagan: contarlas fuera dejaría fuera las intermedias.
  recordUsage({ model, kind, usage: data.usage, waJid });
  return choice.message;
}

// Compone el system prompt final: el prompt del tenant + la capa de comportamiento
// + (opcional) la base de conocimiento + el bloque de contexto vivo de la conversación.
function composeSystemPrompt(tenantPrompt, context = {}) {
  const blocks = [tenantPrompt?.trim() || '', BEHAVIOR_LAYER, ESCALATION_LAYER];

  const kb = (context.knowledgeBase || '').trim();
  if (kb) {
    blocks.push(`BASE DE CONOCIMIENTO DEL NEGOCIO (usa esto como fuente de verdad; no inventes nada fuera de aquí):\n${kb}`);
  }

  const ctx = buildContextBlock(context);
  if (ctx) blocks.push(ctx);

  return blocks.filter(Boolean).join('\n\n');
}

function buildContextBlock(context = {}) {
  const lines = [];
  const { contactName, phone, ghlContact, summary, isReturning } = context;

  if (contactName) {
    lines.push(`Hablas con: ${contactName}${phone ? ` (${phone})` : ''}.`);
  } else if (phone) {
    lines.push(`Hablas con el número ${phone} (aún no tienes su nombre).`);
  }

  if (isReturning) {
    lines.push('Esta es una conversación EN CURSO: ya intercambiaron mensajes antes. NO saludes de nuevo, retoma el hilo.');
  } else {
    lines.push('Es el PRIMER mensaje de esta persona: puedes saludar una sola vez, de forma breve y natural.');
  }

  if (ghlContact) {
    const parts = [];
    if (Array.isArray(ghlContact.tags) && ghlContact.tags.length) parts.push(`Etiquetas: ${ghlContact.tags.join(', ')}`);
    if (ghlContact.companyName) parts.push(`Empresa: ${ghlContact.companyName}`);
    if (ghlContact.source) parts.push(`Origen: ${ghlContact.source}`);
    if (ghlContact.pipelineStage) parts.push(`Etapa: ${ghlContact.pipelineStage}`);
    if (Array.isArray(ghlContact.notes) && ghlContact.notes.length) {
      parts.push(`Notas internas: ${ghlContact.notes.join(' | ').slice(0, 400)}`);
    }
    if (parts.length) lines.push(`Lo que sabemos de este contacto en el CRM: ${parts.join('. ')}.`);
  }

  if (summary && summary.trim()) {
    lines.push(`Resumen de lo conversado antes (para que no pierdas el hilo): ${summary.trim()}`);
  }

  if (!lines.length) return '';
  return `CONTEXTO DE ESTA CONVERSACIÓN:\n- ${lines.join('\n- ')}`;
}

function toOpenAIMessages(systemPrompt, history) {
  const msgs = [{ role: 'system', content: systemPrompt }];
  for (const m of history) {
    if (m.role === 'user') {
      // Si el usuario citó un mensaje anterior, anteponemos el contexto para que
      // el LLM entienda a qué se refiere ("respondió a tu pregunta sobre X").
      let content = m.text || '';
      if (m.quoted?.text) {
        content = `(respondiendo a: "${m.quoted.text.slice(0, 240)}") ${content}`.trim();
      } else if (m.quoted?.mediaType) {
        content = `(respondiendo a un ${m.quoted.mediaType}) ${content}`.trim();
      }
      msgs.push({ role: 'user', content });
    } else if (m.role === 'assistant') {
      msgs.push({ role: 'assistant', content: m.text });
    }
  }
  return msgs;
}

// Genera un resumen breve (2-4 líneas) de un tramo de la conversación. Se usa para
// no mandar 200 mensajes crudos al LLM en hilos largos: resumimos lo viejo y dejamos
// los mensajes recientes verbatim. Devuelve '' si falla (el caller decide el fallback).
export async function summarizeConversation(history) {
  if (!Array.isArray(history) || !history.length) return '';
  const model = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
  const transcript = history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role === 'user' ? 'Cliente' : 'Nosotros'}: ${(m.text || '').slice(0, 300)}`)
    .join('\n');
  if (!transcript.trim()) return '';
  try {
    const msg = await callOpenRouter(
      [
        {
          role: 'system',
          content:
            'Resume en español, en 2-4 líneas y en tercera persona, lo esencial de esta conversación de ventas/soporte por WhatsApp: qué quiere el cliente, datos clave (nombre, presupuesto, fechas, decisiones) y en qué quedó. Solo el resumen, sin preámbulos.',
        },
        { role: 'user', content: transcript },
      ],
      { model, timeoutMs: 30_000, kind: 'summary' }
    );
    return (msg.content || '').trim();
  } catch (e) {
    console.warn(`[ai] summarize falló: ${e.message}`);
    return '';
  }
}

/**
 * Llamada al LLM que devuelve JSON. Reintenta si el modelo entrega algo que no
 * parsea (pasa incluso en json_object: fences de markdown, texto alrededor).
 * La usa el juez del Laboratorio, que necesita un veredicto estructurado.
 */
export async function chatJson(messages, { model, retries = 2, timeoutMs = 60_000, kind = 'lab_judge' } = {}) {
  const m = model
    || process.env.OPENROUTER_JUDGE_MODEL
    || process.env.OPENROUTER_MODEL
    || 'openai/gpt-4o-mini';

  let lastRaw = '';
  for (let i = 0; i <= retries; i++) {
    const msg = await callOpenRouter(messages, { model: m, jsonMode: true, timeoutMs, kind });
    lastRaw = (msg.content || '').trim();
    // Algunos modelos envuelven el JSON en ```json ... ``` pese a json_object.
    const cleaned = lastRaw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      // Último recurso: recortar al primer { … último }
      const a = cleaned.indexOf('{');
      const b = cleaned.lastIndexOf('}');
      if (a !== -1 && b > a) {
        try { return JSON.parse(cleaned.slice(a, b + 1)); } catch {}
      }
    }
  }
  throw new Error(`el modelo no devolvió JSON válido tras ${retries + 1} intentos — raw: ${lastRaw.slice(0, 200)}`);
}

export async function generateReply({ systemPrompt, history, context = {}, kind = 'chat', waJid = null }) {
  const model = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';

  const composedPrompt = composeSystemPrompt(systemPrompt, context);
  const messages = toOpenAIMessages(composedPrompt, history);
  // Recordatorio de fecha actual para el LLM
  messages.push({
    role: 'system',
    content: `Fecha y hora actual del servidor: ${new Date().toISOString()}. Timezone: ${process.env.TIMEZONE || 'America/Guayaquil'}.`,
  });

  const tools = calendarConfigured() ? TOOLS : undefined;

  for (let iter = 0; iter < 5; iter++) {
    const msg = await callOpenRouter(messages, { tools, model, kind, waJid });
    const toolCalls = msg.tool_calls || [];

    if (toolCalls.length === 0) {
      return (msg.content || '').trim();
    }

    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: toolCalls });
    for (const tc of toolCalls) {
      let args = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {}
      let result;
      try {
        result = await executeTool(tc.function.name, args);
      } catch (e) {
        result = { error: String(e.message || e) };
      }
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }
  }
  return 'Lo siento, no pude procesar tu solicitud. ¿Puedes reformularla?';
}
