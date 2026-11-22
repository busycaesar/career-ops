import { moveCard } from "@/lib/board/move-card";
import { isColumnId } from "@/lib/board/columns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isValidIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (typeof body?.key !== "string" || !body.key || !isColumnId(body?.column)) {
    return Response.json({ error: "Send a card key and a valid column." }, { status: 400 });
  }
  if (body.index !== undefined && !isValidIndex(body.index)) {
    return Response.json({ error: "Send a non-negative integer index." }, { status: 400 });
  }
  const result = moveCard(body.key, body.column, body.index);
  if (!result.ok) return Response.json({ error: result.error }, { status: 409 });
  return Response.json(result);
}
