import { readApplications, readInbox, type Application } from "@/lib/career-ops";
import { canonicalJobKey } from "@/lib/core/url-key.mjs";
import { readTrackerUrl } from "@/lib/posting-url.mjs";
import { readBoard, type BoardState, type CardRun, type EmployerLinkState } from "@/lib/board/board-store";
import type { ColumnId } from "@/lib/board/columns";
import { isRunAlive } from "@/lib/board/board-runner";
import { readSavedJd } from "@/lib/board/saved-jd";
import { inferLabelsFromSavedJd } from "@/lib/board/posting-labels";
import { isPastedRef } from "@/lib/board/pasted-ref";
import type { Referral } from "@/lib/board/referrals";

export type BoardCard = {
  key: string;
  url: string;
  company: string;
  role: string;
  location: string;
  score: string;
  trackerNumber: string;
  trackerStatus: string;
  hasPdf: boolean;
  column: ColumnId;
  run?: CardRun;
  referrals: Referral[];
  notes: string;
  employerLink?: EmployerLinkState;
};

const APPLIED_STATUSES = new Set(["applied", "responded", "assessment", "interview", "offer", "hired", "rejected"]);

/** Every job on the board: pipeline.md links plus tracker rows, one card per posting. */
export function readBoardCards(): BoardCard[] {
  const applications = readApplications();
  const board = readBoard();
  const cards = new Map<string, BoardCard>();

  for (const app of applications) {
    const url = readTrackerUrl(app.url) ?? "";
    const key = postingKey(url) || `tracker-${app.n}`;
    cards.set(key, cardFromApplication(key, url, app, board));
  }
  for (const job of readInbox(applications)) {
    const key = postingKey(job.url);
    if (!key || cards.has(key)) continue;
    const posting = inboxPosting(job);
    cards.set(key, {
      key,
      url: job.url,
      ...posting,
      score: "",
      trackerNumber: "",
      trackerStatus: "",
      hasPdf: false,
      column: board[key]?.column ?? "interested",
      run: withLiveness(key, board),
      referrals: board[key]?.referrals ?? [],
      notes: board[key]?.notes ?? "",
      employerLink: board[key]?.employerLink,
    });
  }
  const visible = [...cards.values()].filter((card) => !board[card.key]?.dismissed);
  return sortCards(visible, board);
}

function validOrder(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Sort cards by persisted per-column `order`, keeping cards without an explicit
 * order after ordered ones in their stable default order.
 */
function sortCards(cards: BoardCard[], board: BoardState): BoardCard[] {
  const defaultIndex = new Map(cards.map((card, index) => [card.key, index]));
  return [...cards].sort((a, b) => {
    const orderA = validOrder(board[a.key]?.order);
    const orderB = validOrder(board[b.key]?.order);
    if (orderA !== undefined && orderB !== undefined && orderA !== orderB) return orderA - orderB;
    if (orderA !== undefined && orderB === undefined) return -1;
    if (orderA === undefined && orderB !== undefined) return 1;
    return (defaultIndex.get(a.key) ?? 0) - (defaultIndex.get(b.key) ?? 0);
  });
}

/**
 * The inbox line's role and company, else the ones read from the posting when
 * it was saved from Discover: a pasted link's inbox line carries neither.
 */
function inboxPosting(job: { url: string; role: string; company: string; location?: string }): { role: string; company: string; location: string } {
  const posting = { role: job.role, company: job.company, location: job.location ?? "" };
  if (posting.role && posting.company) return posting;
  const saved = readSavedJd(job.url);
  const inferred = saved ? inferLabelsFromSavedJd(saved) : { role: "", company: "", location: "" };
  return {
    role: posting.role || inferred.role || "",
    company: posting.company || inferred.company || "",
    location: posting.location || inferred.location || "",
  };
}

/**
 * One key per posting: the canonical job key for a link, or the reference
 * itself for a job saved from pasted text, which has no link to normalise.
 */
function postingKey(url: string): string {
  return canonicalJobKey(url) || (isPastedRef(url) ? url : "");
}

export function findCard(key: string): BoardCard | undefined {
  return readBoardCards().find((card) => card.key === key);
}

function cardFromApplication(key: string, url: string, app: Application, board: BoardState): BoardCard {
  const hasPdf = app.pdf.includes("✅");
  return {
    key,
    url,
    company: app.company,
    role: app.role,
    location: app.location,
    score: app.score,
    trackerNumber: app.n,
    trackerStatus: app.status,
    hasPdf,
    column: board[key]?.column ?? defaultColumn(app.status, hasPdf),
    run: withLiveness(key, board),
    referrals: board[key]?.referrals ?? [],
    notes: board[key]?.notes ?? "",
    employerLink: board[key]?.employerLink,
  };
}

function defaultColumn(status: string, hasPdf: boolean): ColumnId {
  if (APPLIED_STATUSES.has(status.trim().toLowerCase())) return "applied";
  return hasPdf ? "custom-review" : "evaluate";
}

/** A run the file says is still going, whose worker process is gone, was cut off (a crash or a reboot). */
function withLiveness(key: string, board: BoardState): CardRun | undefined {
  const run = board[key]?.run;
  if (run?.state === "running" && !isRunAlive(run.pid)) {
    return { ...run, state: "error", message: "Interrupted before it finished." };
  }
  return run;
}
