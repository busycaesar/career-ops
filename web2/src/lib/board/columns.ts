/** Kanban columns, left to right. `action` is the work that runs when a card is dropped on the column. */
export type ColumnId = "interested" | "evaluate" | "custom-review" | "application" | "applied";
export type ColumnAction = "none" | "evaluate" | "generate-cv" | "fill-application" | "mark-applied";

export type Column = { id: ColumnId; label: string; action: ColumnAction; hint: string };

export const COLUMNS: Column[] = [
  { id: "interested", label: "Interested", action: "none", hint: "Saved links" },
  { id: "evaluate", label: "Evaluate", action: "evaluate", hint: "Drop here to evaluate" },
  { id: "custom-review", label: "Custom Resume", action: "generate-cv", hint: "Drop here to generate the CV" },
  { id: "application", label: "Application", action: "fill-application", hint: "Drop here to fill the form" },
  { id: "applied", label: "Applied", action: "mark-applied", hint: "Drop here once submitted" },
];

export function isColumnId(value: unknown): value is ColumnId {
  return COLUMNS.some((column) => column.id === value);
}

export function columnById(id: ColumnId): Column {
  const column = COLUMNS.find((candidate) => candidate.id === id);
  if (!column) throw new Error(`Unknown board column: ${id}`);
  return column;
}
