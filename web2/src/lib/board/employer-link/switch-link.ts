import fs from "node:fs";
import { canonicalJobKey } from "@/lib/core/url-key.mjs";
import { updateBoard } from "@/lib/board/board-store";
import { readBoardCards } from "@/lib/board/board-cards";
import { replaceInboxUrl } from "@/lib/board/posting-traces";
import { savedJdPath, writeSavedJd, type SavedJd } from "@/lib/board/saved-jd";
import type { EmployerLink } from "@/lib/board/employer-link/resolve";

/**
 * Makes the employer's link the card's link: the inbox line points at it, the
 * saved job description moves to it (keeping its text and recording the
 * third-party link as its source), and the board entry moves to its key.
 * Returns false, changing nothing, when that employer posting is already a
 * card of its own.
 */
export async function switchToEmployerLink(card: { key: string; url: string }, saved: SavedJd, link: EmployerLink, doneMessage: string): Promise<boolean> {
  const newKey = canonicalJobKey(link.url) || link.url;
  if (readBoardCards().some((other) => other.key === newKey)) return false;

  await replaceInboxUrl(card.key, link.url);
  writeSavedJd({ ...saved, url: link.url, sourceUrl: card.url, applyUrl: undefined });
  if (savedJdPath(card.url) !== savedJdPath(link.url)) fs.rmSync(savedJdPath(card.url), { force: true });

  const now = new Date().toISOString();
  updateBoard((board) => {
    const entry = board[card.key] ?? { column: "interested" as const };
    delete board[card.key];
    board[newKey] = {
      ...entry,
      employerLink: { status: "found", checkedAt: now, via: link.via, sourceUrl: card.url },
      run: entry.run && { ...entry.run, state: "done", message: doneMessage, finishedAt: now },
    };
  });
  return true;
}
