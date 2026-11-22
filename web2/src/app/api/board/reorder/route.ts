import { reorderCard } from "@/lib/board/move-card";
import { isColumnId } from "@/lib/board/columns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isValidIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (typeof body?.key !== "string" || !body.key || !isColumnId(body?.column) || !isValidIndex(body?.index)) {
    return Response.json({ error: "Send a card key, a valid column, and a non-negative integer index." }, { status: 400 });
  }
  const result = reorderCard(body.key, body.column, body.index);
  if (!result.ok) return Response.json({ error: result.error }, { status: 409 });
  return Response.json(result);
}
