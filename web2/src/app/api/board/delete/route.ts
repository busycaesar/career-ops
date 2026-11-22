import { deleteCard } from "@/lib/board/delete-card";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (typeof body?.key !== "string") return Response.json({ error: "Send a card key." }, { status: 400 });
  const result = await deleteCard(body.key);
  if (!result.ok) return Response.json({ error: result.error }, { status: 409 });
  return Response.json(result);
}
