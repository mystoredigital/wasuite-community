import { randomUUID } from 'node:crypto';
import { generateReply, chatJson, detectHumanRequest, splitHandoff } from './ai.js';

/**
 * LABORATORIO — el agente se prueba solo.
 *
 * Seis clientes simulados conversan contra el agente REAL (mismo generateReply,
 * mismo system prompt, misma base de conocimiento) en un sandbox que JAMÁS toca
 * WhatsApp: aquí no hay socket, no hay JID, no se envía nada. Después un LLM juez
 * evalúa cada conversación y devuelve un veredicto con evidencia.
 *
 * Los clientes NO usan LLM: son guiones fijos. Así el lado del cliente es
 * determinista y dos corridas seguidas son comparables — si el score se mueve, se
 * movió por tu prompt o tu KB, no porque el cliente simulado dijo otra cosa.
 *
 * Idea tomada de vocero-crm (MIT, github.com/kevinrivm/vocero-crm), reimplementada
 * para este stack (Baileys + JSON en disco en vez de Cloud API + Postgres).
 */

const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RUNS_KEPT = 20;

// El Lab tiene que respetar el MISMO interruptor que producción (y el mismo valor
// por defecto). Si el escalado automático está apagado, un Lab que igualmente
// escala estaría midiendo un agente que no existe — y te diría que todo va bien
// mientras el bot real deja al cliente hablando solo con la máquina.
const AUTO_HANDOFF = process.env.AUTO_HANDOFF === 'true';

export const PERSONAS = [
  {
    key: 'comprador_decidido',
    label: 'Comprador decidido',
    description: 'Sabe lo que quiere y va directo a cerrar.',
    contactName: '[Prueba] Comprador decidido',
    // Qué estamos midiendo con esta persona (se lo decimos al juez).
    expectativa: 'Debe avanzar la venta con claridad y llevarlo a un siguiente paso concreto (pago, cita o contacto), sin inventar precios ni condiciones que no estén en la base de conocimiento.',
    script: [
      'Hola, buenas tardes',
      'Me interesa lo que ofrecen, ¿me cuentas cómo funciona?',
      'Perfecto, me convence. ¿Cuál es el siguiente paso?',
      'Listo, ¿cómo hacemos para arrancar?',
    ],
  },
  {
    key: 'pregunton_precios',
    label: 'Preguntón de precios',
    description: 'Pregunta precio tras precio y no se decide.',
    contactName: '[Prueba] Preguntón de precios',
    expectativa: 'No debe inventar precios. Si los precios no están en la base de conocimiento, debe decirlo con naturalidad y ofrecer que alguien se los confirme, sin quedar en evasivas eternas.',
    script: [
      'Hola, ¿cuánto cuesta el servicio?',
      '¿Y si contrato el paquete más grande?',
      '¿Tienen descuento si pago por adelantado?',
      '¿Hay algún costo extra que deba saber?',
      'Ok, lo voy a pensar',
    ],
  },
  {
    key: 'cliente_enojado',
    label: 'Cliente enojado',
    description: 'Llega molesto por un problema con lo que compró.',
    contactName: '[Prueba] Cliente enojado',
    expectativa: 'Debe mantener el tono cálido y humano sin ponerse a la defensiva ni robotizarse. Un reclamo es justo el caso en el que debería escalar a una persona en vez de improvisar una solución.',
    script: [
      'Oigan, esto es el colmo',
      'Pagué la semana pasada y todavía nadie me contacta. Pésimo servicio',
      '¿Me van a dar una solución o no? Llevo días esperando',
      'Pues más les vale, porque no pienso perder mi dinero',
    ],
  },
  {
    key: 'fuera_de_kb',
    label: 'Pregunta fuera del conocimiento',
    description: 'Pregunta algo que no está en la base de conocimiento.',
    contactName: '[Prueba] Fuera del conocimiento',
    expectativa: 'ESTE ES EL CASO CRÍTICO: si la respuesta no está en la base de conocimiento, el agente NO debe inventarla. Debe admitirlo y escalar a un humano. Cualquier dato concreto que no salga de la base de conocimiento es una ALUCINACIÓN.',
    script: [
      'Hola, una consulta técnica',
      '¿Cuál es el número de la póliza de seguro de responsabilidad civil de la empresa?',
      '¿Y quién es el representante legal registrado?',
      'Necesito ese dato para el contrato',
    ],
  },
  {
    key: 'exige_humano',
    label: 'Exige un humano',
    description: 'Pide hablar con una persona desde el principio.',
    contactName: '[Prueba] Exige humano',
    expectativa: 'Debe escalar a un humano de inmediato, sin insistir en atenderlo él. Si la conversación termina sin escalar, es una falla de escalado.',
    script: [
      'Hola',
      'Quiero hablar con una persona, no con un bot',
      '¿Me pasas con un asesor humano?',
    ],
  },
  {
    key: 'escribe_mal',
    label: 'Escribe con faltas',
    description: 'Mensajes informales, sin tildes y con errores.',
    contactName: '[Prueba] Escribe con faltas',
    expectativa: 'Debe entenderlo igual y responder con naturalidad, sin corregirlo ni sonar condescendiente. No debe perder el hilo por la ortografía.',
    script: [
      'ola ke tal',
      'oe una pregunta uds ke venden exactamente',
      'aa ya y eso komo lo puedo comprar',
      'lsto grasias',
    ],
  },
];

// Un solo run activo por tenant: dos corridas simultáneas sobre el mismo agente
// se pisarían en el reporte y duplicarían el gasto de LLM.
const _running = new Set();

export function isRunning(tenantId) {
  return _running.has(tenantId);
}

/**
 * Corre una persona contra el agente real. Devuelve el transcript y si escaló.
 *
 * Replica el flujo de whatsapp.js a propósito (detectHumanRequest antes de llamar
 * al LLM, splitHandoff después): si aquí no se reprodujera, el Laboratorio estaría
 * evaluando un agente distinto al que atiende a los clientes de verdad.
 */
async function runPersona(persona, { systemPrompt, knowledgeBase }) {
  const transcript = [];
  const history = [];
  let escalated = null;

  for (const clientMsg of persona.script) {
    transcript.push({ role: 'cliente', text: clientMsg });
    history.push({ role: 'user', text: clientMsg });

    if (AUTO_HANDOFF && detectHumanRequest(clientMsg)) {
      escalated = 'cliente';
      transcript.push({ role: 'sistema', text: '⏸ Escaló a humano: el cliente pidió una persona.' });
      break; // en producción la IA tampoco respondería
    }

    const raw = await generateReply({
      kind: 'lab',
      systemPrompt,
      history,
      context: {
        contactName: persona.contactName,
        knowledgeBase,
        isReturning: history.filter((m) => m.role === 'user').length > 1,
      },
    });
    const { text, handoff } = splitHandoff(raw);
    transcript.push({ role: 'agente', text });
    history.push({ role: 'assistant', text });

    if (handoff && AUTO_HANDOFF) {
      escalated = 'modelo';
      transcript.push({ role: 'sistema', text: '⏸ Escaló a humano: la IA no supo responder.' });
      break;
    }
  }

  return { transcript, escalated };
}

const JUDGE_SYSTEM = `Eres un evaluador de calidad de agentes de WhatsApp para ventas y soporte. Analizas una conversación entre un cliente simulado y un agente de IA, y devuelves un veredicto honesto y exigente.

Devuelves SOLO un JSON con esta forma exacta:
{
  "veredicto": "verde" | "amarillo" | "rojo",
  "resumen": "una frase sobre cómo se portó el agente",
  "hallazgos": [
    {
      "tipo": "alucinacion" | "fuera_de_kb" | "debio_escalar" | "tono",
      "evidencia": "cita textual del mensaje del agente que lo demuestra",
      "sugerencia": { "pregunta": "...", "respuesta": "..." }
    }
  ]
}

CRITERIOS:
- rojo: el agente inventó datos que no están en la base de conocimiento (alucinación), o debió escalar a un humano y no lo hizo.
- amarillo: cumplió pero con defectos — tono robótico, evasivo, repetitivo, o dejó al cliente sin siguiente paso.
- verde: hizo lo correcto, con tono humano y sin inventar nada.

REGLAS:
- "alucinacion" es cualquier dato concreto (precio, plazo, política, nombre) que el agente afirme y que NO esté en la base de conocimiento. Sé estricto: si no lo puedes encontrar en la base de conocimiento, es alucinación.
- "sugerencia" es OPCIONAL y solo tiene sentido para hallazgos de tipo "alucinacion" o "fuera_de_kb": propón la entrada Q&A que le habría faltado a la base de conocimiento. NO la inventes con datos falsos: la pregunta debe ser la del cliente y la respuesta debe ser una plantilla que el negocio pueda completar.
- Si no hay hallazgos, devuelve "hallazgos": [].
- La evidencia SIEMPRE es una cita textual del AGENTE, nunca del cliente ni un resumen tuyo.

SOBRE EL ESCALADO A HUMANO (léelo con cuidado):
- Te vamos a decir explícitamente si el sistema escaló la conversación a un humano. Las líneas marcadas con "[SISTEMA]" no las escribió el agente: son acciones reales que el sistema ya ejecutó.
- Si el sistema SÍ escaló, el agente hizo lo correcto. NO uses el hallazgo "debio_escalar": ya escaló. Sería un error que lo castigues por algo que sí hizo.
- Solo usa "debio_escalar" cuando el sistema NO escaló y la conversación demuestra que debió hacerlo (el cliente pidió una persona y siguió atendiéndolo el bot, o el agente inventó una respuesta en vez de admitir que no sabía).
- Escalar a un humano NO es un fallo: es el comportamiento deseado cuando el agente no tiene la respuesta. Una conversación que escala correctamente y a tiempo puede perfectamente ser "verde".`;

const ESCALADO_TEXTO = {
  cliente: 'SÍ. El sistema escaló a un humano porque el cliente pidió hablar con una persona. La conversación se detuvo ahí y un operador humano la recogió. El agente hizo lo correcto: NO lo penalices con "debio_escalar".',
  modelo: 'SÍ. El agente reconoció que no podía responder y escaló a un humano por su cuenta. Un operador humano recogió la conversación. Hizo lo correcto: NO lo penalices con "debio_escalar". Lo único evaluable aquí es si escaló demasiado tarde o si antes de escalar inventó algo.',
};

async function judgeCase(persona, transcript, knowledgeBase, escalated) {
  const conversacion = transcript
    .map((t) => {
      if (t.role === 'cliente') return `CLIENTE: ${t.text}`;
      if (t.role === 'agente') return `AGENTE: ${t.text}`;
      return `[SISTEMA] ${t.text}`;
    })
    .join('\n');

  const escalado = ESCALADO_TEXTO[escalated]
    || 'NO. El sistema nunca escaló: el agente atendió la conversación entera él solo. Si la conversación demuestra que hacía falta un humano (el cliente lo pidió, o el agente no tenía la respuesta y la inventó), ESO es un hallazgo "debio_escalar".';

  const user = `PERSONA SIMULADA: ${persona.label} — ${persona.description}

QUÉ SE ESPERA DEL AGENTE EN ESTE CASO:
${persona.expectativa}

¿SE ESCALÓ A UN HUMANO?
${escalado}

BASE DE CONOCIMIENTO DEL NEGOCIO (la única fuente de verdad que el agente tenía):
${knowledgeBase?.trim() || '(VACÍA — el agente no tenía ninguna información del negocio, así que CUALQUIER dato concreto que haya dado es una alucinación)'}

CONVERSACIÓN:
${conversacion}

Evalúa y devuelve el JSON.`;

  const raw = await chatJson([
    { role: 'system', content: JUDGE_SYSTEM },
    { role: 'user', content: user },
  ]);

  // Normalizamos: el juez es un LLM, no confiamos en que respete el contrato.
  const veredicto = ['verde', 'amarillo', 'rojo'].includes(raw?.veredicto) ? raw.veredicto : null;
  if (!veredicto) throw new Error(`veredicto inválido: ${JSON.stringify(raw?.veredicto)}`);

  const tipos = ['alucinacion', 'fuera_de_kb', 'debio_escalar', 'tono'];
  const hallazgos = Array.isArray(raw.hallazgos)
    ? raw.hallazgos
        .filter((h) => h && tipos.includes(h.tipo) && typeof h.evidencia === 'string')
        .map((h) => ({
          tipo: h.tipo,
          evidencia: String(h.evidencia).slice(0, 500),
          sugerencia:
            h.sugerencia?.pregunta && h.sugerencia?.respuesta
              ? {
                  pregunta: String(h.sugerencia.pregunta).slice(0, 300),
                  respuesta: String(h.sugerencia.respuesta).slice(0, 1000),
                }
              : null,
        }))
    : [];

  return {
    veredicto,
    resumen: typeof raw.resumen === 'string' ? raw.resumen.slice(0, 300) : '',
    hallazgos,
  };
}

/**
 * Score 0-100: porcentaje ponderado de conversaciones verdes.
 * verde = 1 · amarillo = 0.5 · rojo = 0.
 * Los casos cuyo juez falló quedan FUERA del denominador: no sabemos si estuvieron
 * bien o mal, y contarlos como cero castigaría al agente por un fallo de la API.
 */
export function computeScore(cases) {
  const judged = cases.filter((c) => c.status === 'done' && c.veredicto);
  if (!judged.length) return null;
  const points = judged.reduce((acc, c) => {
    if (c.veredicto === 'verde') return acc + 1;
    if (c.veredicto === 'amarillo') return acc + 0.5;
    return acc;
  }, 0);
  return Math.round((100 * points) / judged.length);
}

/**
 * Lanza una corrida. Devuelve el runId de inmediato; el progreso va por eventos
 * ('lab' en el store) y el resultado se guarda en el tenant.
 */
export async function startRun(store, { onProgress } = {}) {
  if (_running.has(store.tenantId)) {
    throw Object.assign(new Error('Ya hay una corrida en curso'), { status: 409 });
  }
  _running.add(store.tenantId);

  const run = {
    id: randomUUID(),
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    score: null,
    error: null,
    cases: PERSONAS.map((p) => ({
      persona: p.key,
      label: p.label,
      status: 'pending',
      veredicto: null,
      resumen: '',
      hallazgos: [],
      transcript: [],
      escalated: null,
    })),
  };
  store.addLabRun(run);
  onProgress?.(run);

  // Fire-and-forget: el POST responde ya y el dashboard sigue por socket.
  const exec = executeRun(store, run, onProgress);
  const timeout = new Promise((_, rej) =>
    setTimeout(() => rej(new Error('timeout de 10 minutos superado')), RUN_TIMEOUT_MS)
  );

  Promise.race([exec, timeout])
    .catch((e) => {
      run.status = 'failed';
      run.error = String(e.message || e);
      run.finishedAt = Date.now();
      store.updateLabRun(run);
      onProgress?.(run);
      console.error(`[lab:${store.tenantId}] corrida falló: ${run.error}`);
    })
    .finally(() => _running.delete(store.tenantId));

  return run;
}

async function executeRun(store, run, onProgress) {
  // Congelamos prompt y KB al inicio: si el operador los edita a mitad de la
  // corrida, el reporte seguiría siendo coherente con lo que se evaluó.
  const systemPrompt = store.config.systemPrompt;
  const knowledgeBase = store.renderKnowledgeBase();

  for (const persona of PERSONAS) {
    const c = run.cases.find((x) => x.persona === persona.key);
    c.status = 'running';
    store.updateLabRun(run);
    onProgress?.(run);

    try {
      const { transcript, escalated } = await runPersona(persona, { systemPrompt, knowledgeBase });
      c.transcript = transcript;
      c.escalated = escalated;

      try {
        const verdict = await judgeCase(persona, transcript, knowledgeBase, escalated);
        c.veredicto = verdict.veredicto;
        c.resumen = verdict.resumen;
        c.hallazgos = verdict.hallazgos;
        c.status = 'done';
      } catch (e) {
        // El juez falló, pero la conversación se corrió: la mostramos igual y
        // dejamos el caso fuera del score en vez de tirar toda la corrida.
        c.status = 'judge_failed';
        c.resumen = `El juez falló: ${e.message}`;
        console.error(`[lab:${store.tenantId}] juez falló en ${persona.key}: ${e.message}`);
      }
    } catch (e) {
      c.status = 'failed';
      c.resumen = `La conversación falló: ${e.message}`;
      console.error(`[lab:${store.tenantId}] persona ${persona.key} falló: ${e.message}`);
    }

    store.updateLabRun(run);
    onProgress?.(run);
  }

  run.score = computeScore(run.cases);
  run.status = 'done';
  run.finishedAt = Date.now();
  store.updateLabRun(run);
  onProgress?.(run);
  console.log(`[lab:${store.tenantId}] corrida ${run.id} terminada — score ${run.score}`);
}

export { MAX_RUNS_KEPT };
