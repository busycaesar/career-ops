import type { BoardCard } from "@/lib/board/board-cards";
import type { ColumnId } from "@/lib/board/columns";

/**
 * The Application column has two sections:
 * - "ready" (Section A): forms career-ops filled (or is currently filling) so the
 *   user only reviews and clicks Apply/Submit.
 * - "manual" (Section B): forms that couldn't be filled automatically for any
 *   reason, asking the user to fill them by hand (not styled as an error).
 * Every other column is one list.
 */
export type ApplicationSection = "ready" | "manual";

export const APPLICATION_SECTIONS: { id: ApplicationSection; label: string; emptyHint: string }[] = [
  { id: "ready", label: "Ready to submit", emptyHint: "No auto-filled forms yet" },
  { id: "manual", label: "Fill it yourself", emptyHint: "Nothing to fill by hand" },
];

export function applicationSection(card: BoardCard): ApplicationSection {
  const run = card.run;
  const manual = run?.action === "fill-application" && run.state === "error";
  return manual ? "manual" : "ready";
}

/** A column's cards in display order: in Application, the ready section first, then the manual one. */
export function orderColumnCards(column: ColumnId, cards: BoardCard[]): BoardCard[] {
  if (column !== "application") return cards;
  return APPLICATION_SECTIONS.flatMap((section) => cards.filter((card) => applicationSection(card) === section.id));
}
