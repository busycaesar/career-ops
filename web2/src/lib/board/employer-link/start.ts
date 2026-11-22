import { updateBoard } from "@/lib/board/board-store";
import { startRun } from "@/lib/board/board-runner";
import { STEP_LABELS } from "@/lib/board/employer-link/resolve";

/**
 * Starts the employer-link lookup for a card in the background worker and
 * marks the card running right away, so it shows "Finding employer link…" as
 * soon as it appears. A card saved from Discover has no board entry yet, so
 * one is created in Interested.
 */
export function startEmployerLinkRun(key: string, url: string, company: string): void {
  const startedAt = new Date().toISOString();
  const pid = startRun({ key, action: "find-employer-link", input: url, card: { url, company } });
  updateBoard((board) => {
    const entry = board[key] ?? { column: "interested" };
    entry.run = { action: "find-employer-link", state: "running", message: STEP_LABELS.start, startedAt, pid };
    delete entry.employerLink;
    board[key] = entry;
  });
}
