// fetch global de Node ≥20 — el import de node-fetch funcionaba solo porque
// googleapis lo arrastraba como dependencia transitiva (bomba de tiempo).
import { updateContactName } from './crm-state.js';

const CRM_URL = process.env.CRM_URL || '';
const CRM_API_TOKEN = process.env.CRM_API_TOKEN;
// Código de país (sin +) para generar variantes de búsqueda de teléfonos.
// Ecuador por defecto; para clientes de otro país: CRM_COUNTRY_CODE=57 (CO), 52 (MX)…
const CRM_COUNTRY_CODE = (process.env.CRM_COUNTRY_CODE || '593').replace(/^\+/, '');

if (CRM_URL && CRM_API_TOKEN) {
  console.log(`[CRM] Twenty-CRM habilitado - URL: ${CRM_URL}`);
}

/**
 * Execute a GraphQL query against Twenty-CRM
 */
async function query(gql, variables = {}) {
  if (!CRM_API_TOKEN) return null;

  try {
    const response = await fetch(`${CRM_URL}/graphql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CRM_API_TOKEN}`,
      },
      body: JSON.stringify({ query: gql, variables }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      console.error(`[CRM] GraphQL request failed: ${response.status}`);
      return null;
    }

    const data = await response.json();
    if (data.errors) {
      console.error('[CRM] GraphQL errors:', data.errors);
      return null;
    }

    return data.data;
  } catch (err) {
    console.error('[CRM] Query failed:', err.message);
    return null;
  }
}

// Códigos de marcación internacionales (ITU) para separar el código de país
// del número nacional por longest-prefix. WhatsApp entrega los números en
// E.164, pero pueden ser de CUALQUIER país (no solo el del tenant): un lead
// colombiano escribiéndole a un negocio ecuatoriano llega como +57...
const CALLING_CODES = new Set([
  '1', '7',
  '20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44',
  '45', '46', '47', '48', '49', '51', '52', '53', '54', '55', '56', '57', '58',
  '60', '61', '62', '63', '64', '65', '66', '81', '82', '84', '86', '90', '91',
  '92', '93', '94', '95', '98',
  '211', '212', '213', '216', '218', '220', '221', '222', '223', '224', '225',
  '226', '227', '228', '229', '230', '231', '232', '233', '234', '235', '236',
  '237', '238', '239', '240', '241', '242', '243', '244', '245', '246', '247',
  '248', '249', '250', '251', '252', '253', '254', '255', '256', '257', '258',
  '260', '261', '262', '263', '264', '265', '266', '267', '268', '269', '290',
  '291', '297', '298', '299',
  '350', '351', '352', '353', '354', '355', '356', '357', '358', '359', '370',
  '371', '372', '373', '374', '375', '376', '377', '378', '380', '381', '382',
  '383', '385', '386', '387', '389',
  '420', '421', '423',
  '500', '501', '502', '503', '504', '505', '506', '507', '508', '509', '590',
  '591', '592', '593', '594', '595', '596', '597', '598', '599',
  '670', '672', '673', '674', '675', '676', '677', '678', '679', '680', '681',
  '682', '683', '685', '686', '687', '688', '689', '690', '691', '692',
  '800', '808', '850', '852', '853', '855', '856', '870', '878', '880', '881',
  '882', '883', '886', '888',
  '960', '961', '962', '963', '964', '965', '966', '967', '968', '970', '971',
  '972', '973', '974', '975', '976', '977', '979', '992', '993', '994', '995',
  '996', '998',
]);

// Separa código de país y número nacional. CRM_COUNTRY_CODE actúa como pista
// prioritaria (resuelve ambigüedades tipo NANP); si no aplica, se prueba
// prefijo de 3, 2 y 1 dígitos contra la tabla ITU.
function splitCountryCode(digits) {
  if (CRM_COUNTRY_CODE && digits.startsWith(CRM_COUNTRY_CODE)) {
    return { cc: CRM_COUNTRY_CODE, national: digits.slice(CRM_COUNTRY_CODE.length) };
  }
  for (const len of [3, 2, 1]) {
    const prefix = digits.slice(0, len);
    if (CALLING_CODES.has(prefix)) return { cc: prefix, national: digits.slice(len) };
  }
  return { cc: '', national: digits };
}

// ¿El texto es en realidad un número de teléfono? (Baileys a veces entrega el
// jid en dígitos como "nombre" cuando el contacto no tiene pushName)
function looksLikePhone(s) {
  return /^\+?\d{6,}$/.test(String(s || '').replace(/[\s\-\(\)]/g, ''));
}

// Filtro de nombres entrantes (pushName / nombre del chat). Devuelve '' si no
// es un nombre humano usable. CRÍTICO: acá también se rechaza nuestra propia
// basura circulando de vuelta — sin esto, "WhatsApp 25626362" del nombre del
// chat volvía como "nombre real" y "mejoraba" placeholders con más basura.
function sanitizeIncomingName(s) {
  const name = String(s || '').trim();
  if (!name) return '';
  if (/^whatsapp/i.test(name)) return '';                          // nuestro placeholder
  if (/\d{6,}/.test(name.replace(/[\s\-\(\)\+]/g, ''))) return ''; // contiene un bloque tipo teléfono
  return name;
}

// ¿El nombre guardado en el CRM es un placeholder nuestro y no un nombre real?
// SOLO estos tres casos exactos; ante la duda se asume nombre real y no se
// toca — pisar el nombre que puso un humano es peor que dejar un placeholder.
function isPlaceholderName(firstName, lastName) {
  const first = (firstName || '').trim();
  const last = (lastName || '').trim();
  if (!first && !last) return true;                 // sin nombre en absoluto
  if (/^whatsapp$/i.test(first)) return true;       // "WhatsApp <sufijo>"
  if (looksLikePhone(`${first}${last}`)) return true; // puros dígitos
  return false;
}

// "Claudia Ramírez Builes" → { firstName: 'Claudia', lastName: 'Ramírez Builes' }
function splitFullName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') };
}

/**
 * Variantes de un teléfono para buscarlo en Twenty. Twenty normaliza a
 * número NACIONAL + calling code separado, pero entradas manuales pueden
 * estar en cualquier formato: probamos E.164 con +, sin +, nacional, y
 * nacional con 0 inicial (costumbre local ecuatoriana: 0984...).
 */
function getPhoneVariants(phone) {
  if (!phone) return [];

  const cleaned = phone.replace(/[\s\-\(\)]/g, '');
  const withPlus = cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
  const withoutPlus = cleaned.startsWith('+') ? cleaned.slice(1) : cleaned;
  const { national } = splitCountryCode(withoutPlus);

  const variants = [withPlus, withoutPlus];
  if (national && national !== withoutPlus) {
    variants.push(national, `0${national}`);
  }
  return [...new Set(variants)];
}

/**
 * Find a contact by phone number (tries multiple formats)
 */
export async function findContactByPhone(phoneNumber) {
  if (!CRM_API_TOKEN) return null;

  // Twenty puede tener el número guardado con +, sin +, o sin código de país
  // (depende de si lo creó la app o se tecleó a mano), así que probamos variantes.
  const variants = getPhoneVariants(phoneNumber);
  if (!variants.length) return null;

  // Try each variant with a simple query
  for (const variant of variants) {
    const gql = `
      query FindContact($phone: String!) {
        people(filter: {
          phones: {
            primaryPhoneNumber: { eq: $phone }
          }
        }) {
          edges {
            node {
              id
              name {
                firstName
                lastName
              }
              phones {
                primaryPhoneNumber
              }
              emails {
                primaryEmail
              }
              abrirChat {
                primaryLinkUrl
              }
            }
          }
        }
      }
    `;

    const result = await query(gql, { phone: variant });
    if (result?.people?.edges?.length > 0) {
      const node = result.people.edges[0].node;
      return {
        id: node.id,
        firstName: node.name?.firstName,
        lastName: node.name?.lastName,
        phone: node.phones?.primaryPhoneNumber,
        email: node.emails?.primaryEmail || '',
        chatLink: node.abrirChat?.primaryLinkUrl || '',
      };
    }
  }

  return null;
}

/**
 * Create a new contact in Twenty-CRM
 */
export async function createContact(data) {
  if (!CRM_API_TOKEN) return null;

  const {
    firstName,
    lastName,
    phoneNumber,
  } = data;

  const gql = `
    mutation CreateContact(
      $firstName: String!
      $lastName: String!
      $phoneNumber: String!
    ) {
      createPerson(
        data: {
          name: {
            firstName: $firstName
            lastName: $lastName
          }
          phones: {
            primaryPhoneNumber: $phoneNumber
          }
        }
      ) {
        id
        name {
          firstName
          lastName
        }
      }
    }
  `;

  const result = await query(gql, {
    firstName,
    lastName,
    phoneNumber,
  });

  if (result?.createPerson?.id) {
    console.log(`[CRM] ✅ Created contact: ${result.createPerson.name?.firstName} ${result.createPerson.name?.lastName}`);
    // Sync to local state
    updateContactName(phoneNumber, data.firstName, data.lastName);
    return result.createPerson;
  }
  return null;
}

/**
 * Escribe el link "Abrir chat" en la ficha del contacto en Twenty.
 * Apunta al dashboard con ?chat=<jid> (deep-link a esa conversación).
 */
export async function setChatLink(contactId, url) {
  if (!CRM_API_TOKEN || !contactId || !url) return null;

  const gql = `
    mutation SetChatLink($id: ID!, $url: String!) {
      updatePerson(id: $id, data: { abrirChat: { primaryLinkUrl: $url, primaryLinkLabel: "WhatsApp" } }) {
        id
        abrirChat { primaryLinkUrl }
      }
    }
  `;

  const result = await query(gql, { id: contactId, url });
  const saved = result?.updatePerson?.abrirChat?.primaryLinkUrl;
  if (saved) console.log(`[CRM] ✅ Link "Abrir chat" guardado`);
  return saved || null;
}

/**
 * Escribe el email de un contacto en Twenty.
 * Devuelve el email guardado, o null si falló.
 */
export async function setContactEmail(contactId, email) {
  if (!CRM_API_TOKEN || !contactId || !email) return null;

  const gql = `
    mutation SetEmail($id: ID!, $email: String!) {
      updatePerson(id: $id, data: { emails: { primaryEmail: $email } }) {
        id
        emails {
          primaryEmail
        }
      }
    }
  `;

  const result = await query(gql, { id: contactId, email });
  const saved = result?.updatePerson?.emails?.primaryEmail;
  if (saved) {
    console.log(`[CRM] ✅ Email guardado: ${saved}`);
    return saved;
  }
  return null;
}

/**
 * Guarda en el CRM un dato que salió de la conversación (por ahora, el email).
 *
 * Regla: NO pisa lo que ya haya en Twenty. Si un humano escribió un correo ahí,
 * ese gana — igual que con el nombre. Solo rellena campos vacíos.
 */
export async function enrichContact(phoneNumber, { email } = {}) {
  if (!CRM_API_TOKEN || !email) return null;

  const contact = await findContactByPhone(phoneNumber);
  if (!contact) {
    console.log(`[CRM] enrich: no existe contacto para ${phoneNumber} — se omite`);
    return null;
  }

  if (contact.email) {
    if (contact.email.toLowerCase() !== email.toLowerCase()) {
      console.log(`[CRM] enrich: ${phoneNumber} ya tiene email ${contact.email} en el CRM — no se pisa con ${email}`);
    }
    return contact;
  }

  const saved = await setContactEmail(contact.id, email);
  return saved ? { ...contact, email: saved } : contact;
}

/**
 * Update contact in Twenty-CRM
 */
export async function updateContact(contactId, updates) {
  if (!CRM_API_TOKEN) return null;

  const gql = `
    mutation UpdateContact($id: ID!, $firstName: String, $lastName: String) {
      updatePerson(
        id: $id
        data: {
          name: {
            firstName: $firstName
            lastName: $lastName
          }
        }
      ) {
        id
        name {
          firstName
          lastName
        }
      }
    }
  `;

  const result = await query(gql, {
    id: contactId,
    firstName: updates.firstName,
    lastName: updates.lastName,
  });

  if (result?.updatePerson?.id) {
    console.log(`[CRM] ✅ Updated contact: ${result.updatePerson.name?.firstName} ${result.updatePerson.name?.lastName}`);
    // Sync to local state if we have phone number
    if (updates.phoneNumber) {
      updateContactName(updates.phoneNumber, updates.firstName, updates.lastName);
    }
    return result.updatePerson;
  }
  return null;
}

/**
 * Get or create a contact, syncing phone + basic info
 */
export async function syncContact(phoneNumber, contactInfo = {}) {
  if (!CRM_API_TOKEN) return null;
  if (!phoneNumber) {
    console.warn('[CRM] ⚠️  syncContact called with empty phoneNumber');
    return null;
  }

  const variants = getPhoneVariants(phoneNumber);
  if (!variants.length) {
    console.warn(`[CRM] ⚠️  Could not parse phone: ${phoneNumber}`);
    return null;
  }

  console.log(`[CRM] Syncing contact: phone=${variants[0]}, info=${JSON.stringify(contactInfo)}`);

  // Filtrar el nombre entrante: dígitos, placeholders nuestros y nombres con
  // bloques de teléfono no cuentan como nombre real.
  const incomingName = sanitizeIncomingName(contactInfo.firstName);

  const existing = await findContactByPhone(phoneNumber);
  if (existing) {
    const crmName = [existing.firstName, existing.lastName].filter(Boolean).join(' ').trim();
    console.log(`[CRM] ℹ️  Contact found: ${crmName || '(sin nombre)'} (${existing.phone})`);

    // El CRM es la fuente de verdad del nombre... con UNA excepción: si lo que
    // hay guardado es nuestro placeholder ("WhatsApp 08860635") y ahora sí
    // conocemos el nombre real del contacto, lo mejoramos. Un nombre tecleado
    // a mano en Twenty jamás se pisa.
    if (incomingName && isPlaceholderName(existing.firstName, existing.lastName)) {
      const parts = splitFullName(incomingName);
      console.log(`[CRM] ⬆️  Mejorando placeholder → ${incomingName}`);
      const updated = await updateContact(existing.id, { ...parts, phoneNumber: existing.phone });
      if (updated) {
        return { ...existing, firstName: updated.name?.firstName, lastName: updated.name?.lastName };
      }
    }

    updateContactName(existing.phone, existing.firstName, existing.lastName);
    // Backfill del link "Abrir chat" en contactos que aún no lo tienen
    if (contactInfo.chatUrl && !existing.chatLink) {
      await setChatLink(existing.id, contactInfo.chatUrl).catch(() => {});
    }
    return existing;
  }

  console.log(`[CRM] ℹ️  Contact not found, creating new...`);
  // Se manda el E.164 completo con "+": Twenty lo valida y lo separa él mismo
  // en número nacional + calling code (mandar el número pelado sin "+" hace
  // que su validador lo rechace: "Provided phone number is invalid").
  const e164 = variants[0];
  // Con nombre real: "Claudia" + "Ramírez Builes". Sin nombre: placeholder
  // "WhatsApp <sufijo>" que se mejora solo cuando el contacto escriba.
  const parts = incomingName ? splitFullName(incomingName) : {};
  const firstName = parts.firstName || 'WhatsApp';
  const lastName = incomingName ? (parts.lastName || '') : (contactInfo.lastName || e164.slice(-8));

  const created = await createContact({
    firstName,
    lastName,
    phoneNumber: e164,
  });
  if (!created) return null;

  if (contactInfo.chatUrl) {
    await setChatLink(created.id, contactInfo.chatUrl).catch(() => {});
  }

  // Forma plana igual que findContactByPhone, para que quien llame no tenga que
  // distinguir entre "encontrado" y "recién creado".
  return {
    id: created.id,
    firstName: created.name?.firstName,
    lastName: created.name?.lastName,
    phone: e164,
  };
}

/**
 * Check if CRM is configured
 */
export function isConfigured() {
  return !!(CRM_URL && CRM_API_TOKEN);
}

/**
 * Get CRM connection status
 */
export async function getStatus() {
  if (!CRM_API_TOKEN) {
    return { configured: false, connected: false, message: 'CRM_API_TOKEN not set' };
  }

  try {
    const gql = `query { me { id firstName } }`;
    const result = await query(gql);

    if (result?.me?.id) {
      return {
        configured: true,
        connected: true,
        user: result.me.firstName,
      };
    }
  } catch (e) {
    // Fall through
  }

  return { configured: true, connected: false, message: 'Cannot reach CRM' };
}
