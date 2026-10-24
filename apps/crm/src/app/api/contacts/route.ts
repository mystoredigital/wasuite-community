import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createContact, listContacts } from "@/server/contacts";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const search = req.nextUrl.searchParams.get("q") ?? undefined;
  const contacts = await listContacts({ search });
  return NextResponse.json({ contacts });
}

const CreateContact = z.object({
  name: z.string().min(1),
  phone: z.string().nullish(),
  email: z.string().nullish(),
  company: z.string().nullish(),
  notes: z.string().nullish(),
});

export async function POST(req: NextRequest) {
  try {
    const body = CreateContact.parse(await req.json());
    const contact = await createContact(body);
    return NextResponse.json({ contact });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
