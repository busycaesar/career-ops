import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { atomicWrite } from "@/lib/core/safe-write";
import { isColumnId, type ColumnId } from "@/lib/board/columns";
import type { Referral } from "@/lib/board/referrals";

/**
 * Where each card sits and what last ran on it, kept in the user's data folder
 * (data/web2-board.json) so it survives restarts and career-ops updates.
 * Keyed by the posting's canonical job key.
 */

export type RunState = "running" | "done" | "error";
export type CardRun = { action: string; state: RunState; message: string; startedAt: string; finishedAt?: string; pid?: number };
/** `dismissed`: set by the old ✕, which hid a card instead of deleting it. Those cards stay hidden; nothing sets it any more. */
export type BoardEntry = { column: ColumnId; order?: number; run?: CardRun; dismissed?: boolean; referrals?: Referral[]; notes?: string; employerLink?: EmployerLinkState };
/**
 * Whether a job saved from a third-party site (LinkedIn, Indeed, …) was found on
 * the employer's own site. `found`: the card's link is the employer's, and
 * `sourceUrl` is the third-party link it replaced. `not-found`: the card keeps
 * the third-party link and records why when known.
 */
export type EmployerLinkState = { status: "found" | "not-found"; checkedAt: string; via?: EmployerLinkVia; sourceUrl?: string; reason?: string };
export type EmployerLinkVia = "apply-link" | "ats-board" | "web-search";
export type BoardState = Record<string, BoardEntry>;

function boardFile(): string {
  return path.join(careerOpsRoot(), "data", "web2-board.json");
}

export function readBoard(): BoardState {
  let text: string;
  try {
    text = fs.readFileSync(boardFile(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${boardFile()} is not a JSON object; fix or delete it.`);
  }
  const board: BoardState = {};
  for (const [key, entry] of Object.entries(parsed as Record<string, BoardEntry>)) {
    if (entry && isColumnId(entry.column)) board[key] = entry;
  }
  return board;
}

/** Read, change and write the board in one step. Node runs this synchronously, so two requests cannot interleave. */
export function updateBoard(change: (board: BoardState) => void): BoardState {
  const board = readBoard();
  change(board);
  fs.mkdirSync(path.dirname(boardFile()), { recursive: true });
  atomicWrite(boardFile(), `${JSON.stringify(board, null, 2)}\n`);
  return board;
}
