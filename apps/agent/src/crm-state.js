/**
 * Local sync state for CRM contacts
 * Tracks phone->name mappings updated from Twenty-CRM webhooks
 */

const contactNames = new Map(); // phone -> name

export function updateContactName(phone, firstName, lastName) {
  if (!phone) return;
  const name = [firstName, lastName].filter(Boolean).join(' ') || firstName || lastName;
  if (!name) return;
  contactNames.set(phone, name);
  console.log(`[crm-state] Updated local contact: ${phone} → ${name}`);
}

export function getContactName(phone) {
  return contactNames.get(phone) || null;
}

export function getAllContactNames() {
  return Object.fromEntries(contactNames);
}
