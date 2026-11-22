import { updateBoard, type BoardState } from "@/lib/board/board-store";
import { findCard, readBoardCards, type BoardCard } from "@/lib/board/board-cards";
import { startRun } from "@/lib/board/board-runner";
import { startEmployerLinkRun } from "@/lib/board/employer-link/start";
import { ACTION_COLUMN, isRunAction, type RunAction } from "@/lib/board/run-request";
import { columnById, type ColumnId } from "@/lib/board/columns";

export type MoveResult = { ok: true; started: boolean } | { ok: false; error: string };

/**
 * Reorder a card within its current column without triggering any column action.
 * `index` is the 0-based final position in the column (clamped to column bounds).
 */
export function reorderCard(key: string, column: ColumnId, index: number): MoveResult {
  const cards = readBoardCards();
  const card = cards.find((candidate) => candidate.key === key);
  if (!card) return { ok: false, error: "That job is no longer on the board. Refresh the page." };
  if (card.column !== column) return { ok: false, error: "That job moved to another column. Refresh the page." };

  const orderedKeys = insertAt(
    cards.filter((candidate) => candidate.column === column && candidate.key !== key).map((candidate) => candidate.key),
    key,
    index,
  );
  updateBoard((board) => {
    applyColumnOrder(board, column, orderedKeys, key);
  });
  return { ok: true, started: false };
}

/**
 * Move a card and, when the target column has an action the card still needs,
 * start it. A card that already has what the column produces (an evaluation,
 * a CV) just moves. Dropping in the same column only updates ordering and never
 * triggers a column action.
 */
export function moveCard(key: string, column: ColumnId, index?: number): MoveResult {
  const cards = readBoardCards();
  const card = cards.find((candidate) => candidate.key === key);
  if (!card) return { ok: false, error: "That job is no longer on the board. Refresh the page." };

  if (card.column === column) {
    if (index === undefined) return { ok: true, started: false };
    return reorderCard(key, column, index);
  }

  return executeColumnMove(card, column, cards, index);
}

/** Run a card's failed or interrupted action again, from the column that action belongs to. */
export function retryCard(key: string): MoveResult {
  const cards = readBoardCards();
  const card = cards.find((candidate) => candidate.key === key);
  const run = card?.run;
  // The employer-link lookup is also retried after it finished without finding the link.
  if (run?.action === "find-employer-link") return retryEmployerLink(key);
  if (!card || !run || run.state !== "error" || !isRunAction(run.action)) {
    return { ok: false, error: "There is no failed run on this job to retry." };
  }
  return executeColumnMove(card, ACTION_COLUMN[run.action], cards, undefined, /* preserveOrder */ true);
}

function executeColumnMove(
  card: BoardCard,
  column: ColumnId,
  cards: BoardCard[],
  index?: number,
  preserveOrder = false,
): MoveResult {
  if (card.run?.state === "running") return { ok: false, error: "Something is still running on this job. Wait for it to finish." };

  const run = plannedRun(card, column);
  if ("error" in run) return { ok: false, error: run.error };

  const key = card.key;
  if (preserveOrder && card.column === column) {
    updateBoard((board) => {
      board[key] = { ...board[key], column };
    });
  } else {
    const others = cards.filter((candidate) => candidate.column === column && candidate.key !== key).map((candidate) => candidate.key);
    const orderedKeys = insertAt(others, key, index ?? others.length);
    updateBoard((board) => {
      applyColumnOrder(board, column, orderedKeys, key);
    });
  }
  if (!run.action) return { ok: true, started: false };
  const { action } = run;
  const startedAt = new Date().toISOString();
  const pid = startRun({ key, action, input: run.input, card: { url: card.url, company: card.company } });
  // Marked running here, not only by the worker once it boots, so the page that
  // reloads right after the drop already shows the spinner and keeps polling.
  // Skipped when the worker has already written a newer run of its own.
  updateBoard((board) => {
    const entry = board[key];
    if (entry && (!entry.run || entry.run.startedAt < startedAt)) {
      entry.run = { action, state: "running", message: "Starting", startedAt, pid };
    }
  });
  return { ok: true, started: true };
}

function insertAt(keys: string[], key: string, index: number): string[] {
  const clamped = Math.max(0, Math.min(Math.trunc(index), keys.length));
  const next = [...keys];
  next.splice(clamped, 0, key);
  return next;
}

function applyColumnOrder(board: BoardState, column: ColumnId, orderedKeys: string[], movedKey: string): void {
  orderedKeys.forEach((cardKey, position) => {
    const existing = board[cardKey];
    // Never pull another card back if a concurrent write already moved it elsewhere.
    if (cardKey !== movedKey && existing && existing.column !== column) return;
    board[cardKey] = { ...existing, column, order: position };
  });
}

/** Look for a third-party job's employer link again (after a failure, or when it was not found). */
function retryEmployerLink(key: string): MoveResult {
  const card = findCard(key);
  if (!card) return { ok: false, error: "That job is no longer on the board. Refresh the page." };
  if (card.run?.state === "running") return { ok: false, error: "Something is still running on this job. Wait for it to finish." };
  if (!card.url) return { ok: false, error: "This job has no posting link to look up." };
  startEmployerLinkRun(key, card.url, card.company);
  return { ok: true, started: true };
}

type PlannedRun = { action: RunAction; input: string } | { action: null } | { error: string };

function plannedRun(card: BoardCard, column: ColumnId): PlannedRun {
  const action = columnById(column).action;
  const evaluated = card.trackerNumber !== "";
  switch (action) {
    case "none":
      return { action: null };
    case "evaluate":
      if (evaluated) return { action: null };
      if (!card.url) return { error: "This job has no posting link to evaluate." };
      return { action: "evaluate", input: card.url };
    case "generate-cv":
      if (card.hasPdf) return { action: null };
      // Evaluate is optional: an unevaluated card goes by its link, and the CV
      // step records it (CV-only report + tracker row) before tailoring.
      if (!evaluated) {
        if (!card.url) return { error: "This job has no posting link to build a CV for." };
        return { action: "generate-cv", input: card.url };
      }
      return { action: "generate-cv", input: card.trackerNumber };
    case "fill-application":
      if (!card.hasPdf) return { error: "Generate the CV first (drop it on Custom Resume)." };
      if (!card.url) return { error: "This job has no posting link to open." };
      return { action: "fill-application", input: card.trackerNumber };
    case "mark-applied":
      if (!evaluated) return { error: "Only evaluated jobs have a tracker row to mark as Applied." };
      if (card.trackerStatus.trim().toLowerCase() === "applied") return { action: null };
      return { action: "mark-applied", input: card.trackerNumber };
  }
}
