import type { ColumnId } from "@/lib/board/columns";

export type RunAction = "evaluate" | "generate-cv" | "fill-application" | "mark-applied" | "find-employer-link";
export type RunRequest = { key: string; action: RunAction; input: string; card: { url: string; company: string } };

/** The column each action belongs to, so a failed run can be retried from the right place. */
export const ACTION_COLUMN: Record<RunAction, ColumnId> = {
  evaluate: "evaluate",
  "generate-cv": "custom-review",
  "fill-application": "application",
  "mark-applied": "applied",
  // Runs in the background on a card that stays in Interested; retried by retryCard directly.
  "find-employer-link": "interested",
};

export function isRunAction(value: unknown): value is RunAction {
  return typeof value === "string" && value in ACTION_COLUMN;
}
