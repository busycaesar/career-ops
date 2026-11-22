import { updateBoard } from "@/lib/board/board-store";
import { findCard } from "@/lib/board/board-cards";
import { readSavedJd } from "@/lib/board/saved-jd";
import { isThirdPartyPosting } from "@/lib/board/third-party";
import { resolveEmployerLink, STEP_LABELS } from "@/lib/board/employer-link/resolve";
import { switchToEmployerLink } from "@/lib/board/employer-link/switch-link";

/**
 * The background step after a third-party job is saved: find the job on the
 * employer's own site and make that the card's link, or mark the card "Not
 * confirmed at employer". `report` shows progress on the card. Returns the
 * card's final message.
 */
export async function findEmployerLink(key: string, url: string, report: (label: string) => void): Promise<string> {
  if (!(await isThirdPartyPosting(url))) return ALREADY_EMPLOYER;
  const card = findCard(key);
  if (!card) throw new Error("That job is no longer on the board.");
  if (card.trackerNumber) throw new Error(ALREADY_EVALUATED);
  const saved = readSavedJd(url);
  if (!saved) throw new Error(NO_SAVED_DESCRIPTION);

  report(STEP_LABELS.start);
  let result;
  try {
    result = await resolveEmployerLink(saved, url, report);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Only surface as an error if both primary and backup models hit their limits.
    if (/both primary and backup ai models have hit their usage limits/i.test(msg)) throw err;
    markNotFound(key);
    return NOT_CONFIRMED;
  }
  if (result.status === "not-found") {
    markNotFound(key, result.reason);
    return result.reason ? `${NOT_CONFIRMED}: ${result.reason}` : NOT_CONFIRMED;
  }
  const { link } = result;
  const message = `Employer link found ${VIA_LABELS[link.via]}`;
  return (await switchToEmployerLink(card, saved, link, message)) ? message : ALREADY_ON_BOARD;
}

function markNotFound(key: string, reason?: string): void {
  updateBoard((board) => {
    const entry = board[key];
    if (entry) entry.employerLink = { status: "not-found", checkedAt: new Date().toISOString(), ...(reason ? { reason } : {}) };
  });
}

export const NOT_CONFIRMED = "Not confirmed at employer";
export const ALREADY_EVALUATED =
  "This job is already evaluated, so its tracker row keeps the third-party link; the employer link was not looked up. Open the posting and use the employer's Apply page.";
export const NO_SAVED_DESCRIPTION = "No saved job description for this link, so the company and role to look for are unknown.";
const ALREADY_EMPLOYER = "This link is already the employer's own posting.";
const ALREADY_ON_BOARD = "The employer's posting for this job is already on your board as its own card.";
const VIA_LABELS = {
  "apply-link": "(from the job site's Apply link)",
  "ats-board": "(on the company's job board)",
  "web-search": "(by searching the company's site)",
} as const;
