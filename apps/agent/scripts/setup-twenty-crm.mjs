#!/usr/bin/env node
/**
 * Aprovisiona una instancia de Twenty-CRM para el WhatsApp Agent.
 * Idempotente: se puede correr las veces que sea; solo crea lo que falta.
 *
 * Qué hace:
 *   1. Crea el campo LINKS "Abrir chat" (abrirChat) en el objeto person.
 *   2. Crea el webhook person.updated → <AGENT_URL>/webhooks/crm
 *      (para que al editar un contacto en Twenty, el nombre baje a WhatsApp).
 *   3. Sanity check del token (query people).
 *
 * Uso (desde la raíz del repo, con Node >= 18):
 *   CRM_URL=https://crm.cliente.com \
 *   CRM_API_TOKEN=eyJ... \
 *   AGENT_URL=https://wa.cliente.com \
 *   node scripts/setup-twenty-crm.mjs
 *
 * El token se crea en Twenty: Settings → APIs → + Create key.
 */

const CRM_URL = (process.env.CRM_URL || '').replace(/\/+$/, '');
const CRM_API_TOKEN = process.env.CRM_API_TOKEN;
const AGENT_URL = (process.env.AGENT_URL || '').replace(/\/+$/, '');

if (!CRM_URL || !CRM_API_TOKEN || !AGENT_URL) {
  console.error('Faltan variables. Necesito CRM_URL, CRM_API_TOKEN y AGENT_URL.');
  console.error('Ejemplo: CRM_URL=https://crm.cliente.com CRM_API_TOKEN=eyJ... AGENT_URL=https://wa.cliente.com node scripts/setup-twenty-crm.mjs');
  process.exit(1);
}

async function gql(endpoint, query, variables = {}) {
  const res = await fetch(`${CRM_URL}/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CRM_API_TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const out = await res.json();
  return { data: out.data, errors: out.errors };
}

// createOneField cambió de forma entre versiones de Twenty — probamos ambas.
async function createField(payload, label) {
  const attempts = [
    { typename: 'CreateOneFieldMetadataInput', input: { field: payload } },
    { typename: 'CreateFieldInput', input: payload },
  ];
  let lastErr;
  for (const { typename, input } of attempts) {
    const { data, errors } = await gql('metadata', `
      mutation($input: ${typename}!) { createOneField(input: $input) { id name } }
    `, { input });
    if (!errors) {
      console.log(`✅ campo ${label} creado (${data.createOneField.id})`);
      return true;
    }
    lastErr = errors;
  }
  console.error(`❌ campo ${label} falló:`, JSON.stringify(lastErr));
  return false;
}

// --- 1. Sanity check del token ---
{
  const { data, errors } = await gql('graphql', '{ people(first: 1) { edges { node { id } } } }');
  if (errors || !data?.people) {
    console.error('❌ El token no funciona contra', CRM_URL, '—', JSON.stringify(errors));
    process.exit(1);
  }
  console.log(`✅ Token válido contra ${CRM_URL}`);
}

// --- 2. Campo "Abrir chat" en person ---
{
  const { data, errors } = await gql('metadata', `
    { objects(paging: {first: 200}) { edges { node {
        id nameSingular
        fields(paging: {first: 200}) { edges { node { name } } }
    } } } }
  `);
  if (errors) { console.error('❌ No pude listar objetos:', JSON.stringify(errors)); process.exit(1); }

  const person = data.objects.edges.map((e) => e.node).find((o) => o.nameSingular === 'person');
  if (!person) { console.error('❌ No existe el objeto person'); process.exit(1); }

  const fieldNames = new Set(person.fields.edges.map((e) => e.node.name));
  if (fieldNames.has('abrirChat')) {
    console.log('✅ campo person.abrirChat ya existe');
  } else {
    await createField({
      type: 'LINKS', name: 'abrirChat', label: 'Abrir chat',
      objectMetadataId: person.id, icon: 'IconBrandWhatsapp',
    }, 'person.abrirChat');
  }
}

// --- 3. Webhook person.updated → agente ---
{
  const targetUrl = `${AGENT_URL}/webhooks/crm`;
  const { data, errors } = await gql('metadata', '{ webhooks { id targetUrl operations } }');
  if (errors) { console.error('❌ No pude listar webhooks:', JSON.stringify(errors)); process.exit(1); }

  const existing = (data.webhooks || []).find((w) => w.targetUrl === targetUrl);
  if (existing) {
    console.log(`✅ webhook ya existe → ${targetUrl} (${existing.operations.join(', ')})`);
  } else {
    const { data: created, errors: cErr } = await gql('metadata', `
      mutation($input: CreateWebhookInput!) { createWebhook(input: $input) { id targetUrl } }
    `, { input: {
      targetUrl,
      operations: ['person.updated'],
      description: 'WhatsApp Agent: baja el nombre editado en el CRM al chat',
    } });
    if (cErr) { console.error('❌ createWebhook falló:', JSON.stringify(cErr)); process.exit(1); }
    console.log(`✅ webhook creado → ${created.createWebhook.targetUrl}`);
  }
}

console.log('\nSETUP OK — recuerda en el .env del agente:');
console.log(`  CRM_URL=${CRM_URL}`);
console.log('  CRM_API_TOKEN=<el token>');
console.log('  CRM_COUNTRY_CODE=<código país sin +, ej. 593|57|52>');
console.log(`  PUBLIC_URL=${AGENT_URL}`);
