import { customAlphabet } from "nanoid";

// IDs con prefijo legible (ej. "contact_V1StGXR8Z5"). El prefijo hace evidente de
// qué tabla es un id al leer logs o URLs, sin exponer enteros autoincrementales.
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZabcdefghijkmnpqrstvwxyz";
const nano = customAlphabet(alphabet, 16);

const PREFIX = {
  contact: "contact",
  stage: "stage",
  lead: "lead",
  msg: "msg",
  // Estado del agente de WhatsApp. wa_chat y wa_number no aparecen aquí: sus
  // claves son el JID y el slug del número, que ya son identificadores estables.
  kb: "kb",
  lab: "lab",
  usage: "usage",
  push: "push",
} as const;

export function newId(kind: keyof typeof PREFIX): string {
  return `${PREFIX[kind]}_${nano()}`;
}
