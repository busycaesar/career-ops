import { KanbanBoard } from "@/components/board/kanban-board";

export default function PipelinePage() {
  return (
    <div className="px-8 py-10">
      <h1 className="text-2xl font-semibold">Pipeline</h1>
      <p className="mt-1 text-sm text-muted">Drag a job to a column. Evaluate, Custom Resume and Applied start their step when you drop a card on them.</p>
      <KanbanBoard />
    </div>
  );
}
