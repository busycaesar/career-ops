import fs from "node:fs";
import { updateBoard } from "@/lib/board/board-store";
import { findCard, type BoardCard } from "@/lib/board/board-cards";
import { removePostingTraces } from "@/lib/board/posting-traces";
import { readSavedJd, savedJdPath } from "@/lib/board/saved-jd";
import { canonicalJobKey } from "@/lib/core/url-key.mjs";
import { deleteTrackerRecord } from "@/lib/board/tracker-record-delete";

export type DeleteResult = { ok: true } | { ok: false; error: string };

/**
 * Delete a job from career-ops completely, so its link can be saved again from
 * Discover as a new job: its tracker row with report and CVs, its inbox line,
 * its scan-history rows, its saved job description and its board entry.
 */
export async function deleteCard(key: string): Promise<DeleteResult> {
  const card = findCard(key);
  if (!card) return { ok: false, error: "That job is no longer on the board. Refresh the page." };
  if (card.run?.state === "running") return { ok: false, error: "Something is still running on this job. Wait for it to finish." };

  try {
    await deleteJobFiles(card);
  } catch (err) {
    return { ok: false, error: deleteErrorMessage(err) };
  }
  updateBoard((board) => {
    delete board[key];
  });
  return { ok: true };
}

async function deleteJobFiles(card: BoardCard): Promise<void> {
  if (card.trackerNumber) await deleteTrackerRecord(card.trackerNumber);
  if (!card.url) return;
  // A card whose employer link replaced a third-party link also clears that link's traces.
  const sourceUrl = readSavedJd(card.url)?.sourceUrl ?? card.employerLink?.sourceUrl;
  await removePostingTraces(card.key);
  if (sourceUrl) await removePostingTraces(canonicalJobKey(sourceUrl) || sourceUrl);
  fs.rmSync(savedJdPath(card.url), { force: true });
}

function deleteErrorMessage(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  const code = (err as { code?: unknown } | null)?.code;
  if (name === "LockTimeoutError" || code === "LOCK_TIMEOUT") {
    return "Another career-ops step is writing the tracker or inbox right now (a scan, a merge or another tab). Try again in a moment.";
  }
  return err instanceof Error ? err.message : String(err);
}
