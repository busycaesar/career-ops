import type { EmployerLinkVia } from "@/lib/board/board-store";
import type { SavedJd } from "@/lib/board/saved-jd";
import { findOnAtsBoards } from "@/lib/board/employer-link/ats-boards";
import { employerUrlFromApplyLink, verifyEmployerUrlWithReason, withoutTracking } from "@/lib/board/employer-link/employer-url";
import { searchEmployerUrl } from "@/lib/board/employer-link/web-search";

/**
 * Finds a third-party job's posting on the employer's own site, cheapest
 * first: the job site's own off-site Apply link (captured when the job was
 * read), then the company's public ATS board, then a short read-only web
 * search. `onStep` reports each step so the card can show it.
 */
export async function resolveEmployerLink(saved: SavedJd, sourceUrl: string, onStep: (label: string) => void): Promise<ResolveEmployerLinkResult> {
  if (saved.applyUrl) {
    onStep(STEP_LABELS.applyLink);
    const url = await employerUrlFromApplyLink(saved.applyUrl);
    if (url) return { status: "found", link: { url, via: "apply-link" } };
  }
  const posting = { company: saved.company, role: saved.role, location: saved.location };
  if (!posting.company || !posting.role) {
    return { status: "not-found", reason: "Saved job description is missing the company name or role title." };
  }

  onStep(STEP_LABELS.atsBoard);
  const onBoard = await findOnAtsBoards(posting);
  if (onBoard) return { status: "found", link: { url: withoutTracking(onBoard), via: "ats-board" } };

  onStep(STEP_LABELS.webSearch);
  const found = await searchEmployerUrl({ ...posting, sourceUrl });
  if (found.status === "none") {
    return {
      status: "not-found",
      reason: found.reason ?? "No matching live posting was found on the company's careers site or public ATS boards.",
    };
  }
  const url = withoutTracking(found.url);
  const verification = await verifyEmployerUrlWithReason(url, posting.role);
  if (!verification.ok) {
    return { status: "not-found", reason: verification.reason };
  }
  return { status: "found", link: { url, via: "web-search" } };
}

export type EmployerLink = { url: string; via: EmployerLinkVia };
export type ResolveEmployerLinkResult = { status: "found"; link: EmployerLink } | { status: "not-found"; reason: string };

export const STEP_LABELS = {
  start: "Finding employer link…",
  applyLink: "Finding employer link: following the Apply link…",
  atsBoard: "Finding employer link: checking the company's job board…",
  webSearch: "Finding employer link: searching the company's site…",
};
