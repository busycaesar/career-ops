import { findCard } from "@/lib/board/board-cards";
import { updateBoard } from "@/lib/board/board-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_NOTES_CHARS = 2000;

/** Save or clear free-form notes on a board card. */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (typeof body?.key !== "string" || !body.key.trim()) {
    return Response.json({ error: "Send a card key." }, { status: 400 });
  }
  if (typeof body.notes !== "string") {
    return Response.json({ error: "Send notes as text." }, { status: 400 });
  }

  const key = body.key;
  const card = findCard(key);
  if (!card) {
    return Response.json({ error: "That job is no longer on the board. Refresh the page." }, { status: 409 });
  }

  const normalized = body.notes.replace(/\r\n/g, "\n").trim().slice(0, MAX_NOTES_CHARS);
  updateBoard((board) => {
    const entry = (board[key] ??= { column: card.column });
    if (normalized) entry.notes = normalized;
    else delete entry.notes;
  });

  return Response.json({ ok: true, notes: normalized });
}
