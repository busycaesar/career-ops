import fs from "node:fs";
import { findCard } from "@/lib/board/board-cards";
import { resolveTailoredCv, uploadNameForCv } from "@/lib/apply/cv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The card's tailored CV PDF, shown inline so it opens in a browser tab. */
export async function GET(request: Request) {
  const key = new URL(request.url).searchParams.get("key");
  if (!key) return Response.json({ error: "Send a card key." }, { status: 400 });
  const card = findCard(key);
  if (!card) return Response.json({ error: "That job is no longer on the board." }, { status: 404 });
  if (!card.hasPdf || !card.trackerNumber) return Response.json({ error: "This job has no tailored CV yet." }, { status: 404 });

  const pdf = await resolveTailoredCv(card.company, card.trackerNumber);
  if (!pdf) return Response.json({ error: "The tracker says a CV exists, but its PDF was not found in output/." }, { status: 404 });
  return new Response(fs.readFileSync(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": inlineDisposition(uploadNameForCv({ application: card.trackerNumber, company: card.company, title: card.role })),
      "Cache-Control": "no-store",
    },
  });
}

/**
 * `inline` with the CV's outward name: a plain ASCII `filename` for older
 * browsers and an RFC 5987 `filename*` carrying the exact UTF-8 name.
 */
function inlineDisposition(fileName: string): string {
  const asciiFallback = fileName.replace(/[^\x20-\x7E]/g, "").replace(/["\\]/g, "");
  return `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
