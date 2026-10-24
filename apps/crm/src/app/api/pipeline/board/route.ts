import { NextResponse } from "next/server";
import { getBoard } from "@/server/pipeline";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const board = await getBoard();
    return NextResponse.json({ board });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
