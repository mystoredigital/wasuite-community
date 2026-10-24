import { listContacts } from "@/server/contacts";
import { ContactsClient } from "@/components/contacts/contacts-client";
import type { Contact } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

export default async function ContactsPage() {
  let contacts: Contact[] = [];
  let error: string | null = null;
  try {
    contacts = await listContacts();
  } catch (e) {
    error = (e as Error).message;
  }

  return <ContactsClient initial={contacts} error={error} />;
}
