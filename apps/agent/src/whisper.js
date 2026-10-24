// Cliente para faster-whisper-server (sidecar) usando la API OpenAI-compatible
// POST /v1/audio/transcriptions. Sin dependencias — construimos el multipart manualmente.

const WHISPER_URL = (process.env.WHISPER_URL || '').replace(/\/$/, '');
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'Systran/faster-whisper-small';
const WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE || 'es';
const WHISPER_TIMEOUT_MS = Number(process.env.WHISPER_TIMEOUT_MS || 120_000);

export function isWhisperConfigured() {
  return !!WHISPER_URL;
}

function buildMultipart(boundary, fields, file) {
  const enc = (s) => Buffer.from(s, 'utf8');
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) continue;
    parts.push(enc(`--${boundary}\r\n`));
    parts.push(enc(`Content-Disposition: form-data; name="${k}"\r\n\r\n`));
    parts.push(enc(String(v)));
    parts.push(enc('\r\n'));
  }
  if (file) {
    parts.push(enc(`--${boundary}\r\n`));
    parts.push(enc(`Content-Disposition: form-data; name="${file.fieldName || 'file'}"; filename="${file.filename}"\r\n`));
    parts.push(enc(`Content-Type: ${file.contentType}\r\n\r\n`));
    parts.push(file.buffer);
    parts.push(enc('\r\n'));
  }
  parts.push(enc(`--${boundary}--\r\n`));
  return Buffer.concat(parts);
}

export async function transcribeAudio(buffer, { mimetype = 'audio/ogg', filename = 'audio.ogg', language = WHISPER_LANGUAGE } = {}) {
  if (!WHISPER_URL) throw new Error('WHISPER_URL no configurado');
  if (!buffer || !buffer.length) throw new Error('buffer vacío');

  const boundary = '----wa-mystore-' + Math.random().toString(36).slice(2);
  const body = buildMultipart(boundary, {
    model: WHISPER_MODEL,
    language,
    response_format: 'json',
  }, { filename, contentType: mimetype, buffer });

  const resp = await fetch(`${WHISPER_URL}/v1/audio/transcriptions`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
    signal: AbortSignal.timeout(WHISPER_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Whisper ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  return (data.text || '').trim();
}
