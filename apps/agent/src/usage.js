// Registro del consumo de la IA.
//
// ai.js es un módulo sin estado: no conoce el store ni la base. En vez de pasarle
// el driver por todas las firmas (generateReply, summarizeConversation, chatJson,
// y los dos puntos del Laboratorio), se le da un sumidero que alguien configura al
// arrancar. Sin sumidero configurado el registro es un no-op, así que el agente
// sigue funcionando igual sobre JSON o en un test.
//
// Se guardan TOKENS, no dinero: el precio depende del modelo y cambia con el
// tiempo, y una fila con un importe congelado envejece mal. El coste se calcula al
// leer, con la tarifa vigente.

let sink = null;

export function setUsageSink(fn) {
  sink = typeof fn === 'function' ? fn : null;
}

/**
 * Registra una llamada al modelo. Nunca lanza ni bloquea: si el registro del
 * consumo fallara y tumbara la respuesta, el remedio sería peor que la enfermedad.
 *
 * @param {object} p
 * @param {string} p.model  modelo tal como lo reporta el proveedor
 * @param {string} p.kind   chat · summary · lab · lab_judge
 * @param {object} p.usage  bloque `usage` de la respuesta de OpenRouter
 * @param {string} [p.waJid] chat que originó la llamada, si aplica
 */
export function recordUsage({ model, kind = 'chat', usage, waJid = null }) {
  if (!sink || !usage) return;
  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  if (!inputTokens && !outputTokens) return;
  try {
    const r = sink({ model, kind, inputTokens, outputTokens, waJid });
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch {
    // Ni un fallo al medir puede costar una respuesta al cliente.
  }
}
