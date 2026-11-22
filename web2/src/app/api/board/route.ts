import { readBoardCards } from "@/lib/board/board-cards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ cards: readBoardCards() });
}
