"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { ExternalLink, FileText, RotateCcw, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { COLUMNS, type Column, type ColumnId } from "@/lib/board/columns";
import type { BoardCard } from "@/lib/board/board-cards";
import { summarizeFailure } from "@/lib/board/run-failure";
import { APPLICATION_SECTIONS, applicationSection, orderColumnCards } from "@/lib/board/application-sections";
import { isPastedRef } from "@/lib/board/pasted-ref";
import { ReferralButton, ReferralPanel } from "@/components/board/referral-panel";
import { NoteButton, NotePanel } from "@/components/board/note-panel";
import { EmployerLinkBadge, showsRunLine } from "@/components/board/employer-link-badge";

const POLL_MS = 4000;
const DRAG_TYPE = "text/x-board-card";

type DropTarget = { column: ColumnId; slot: number };

function reorderCardsLocally(cards: BoardCard[], key: string, targetColumn: ColumnId, targetIndex: number): BoardCard[] {
  const moving = cards.find((card) => card.key === key);
  if (!moving) return cards;
  const updated: BoardCard = moving.column === targetColumn ? moving : { ...moving, column: targetColumn };
  const remaining = cards.filter((card) => card.key !== key);
  const inTarget = orderColumnCards(targetColumn, remaining.filter((card) => card.column === targetColumn));
  const clamped = Math.max(0, Math.min(targetIndex, inTarget.length));
  const nextTarget = [...inTarget.slice(0, clamped), updated, ...inTarget.slice(clamped)];
  const otherColumns = remaining.filter((card) => card.column !== targetColumn);
  return [...otherColumns, ...nextTarget];
}

export function KanbanBoard() {
  const [cards, setCards] = useState<BoardCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/board", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `Could not load the board (HTTP ${response.status}).`);
    setCards(body.cards);
  }, []);

  useEffect(() => {
    load().catch((err: Error) => setError(err.message));
  }, [load]);

  const anyRunning = cards?.some((card) => card.run?.state === "running") ?? false;
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => load().catch((err: Error) => setError(err.message)), POLL_MS);
    return () => clearInterval(timer);
  }, [anyRunning, load]);

  // Smoothly auto-scroll the viewport (and any overflowing column) while dragging near top/bottom edges.
  useEffect(() => {
    if (!draggedKey) return;
    let pointerY: number | null = null;
    let pointerX: number | null = null;
    let rafId = 0;

    const EDGE_PX = 110;
    const MAX_SPEED = 22;

    const step = () => {
      if (pointerY !== null) {
        const vh = window.innerHeight;
        let dy = 0;
        if (pointerY < EDGE_PX) {
          dy = -Math.ceil(MAX_SPEED * ((EDGE_PX - pointerY) / EDGE_PX));
        } else if (pointerY > vh - EDGE_PX) {
          dy = Math.ceil(MAX_SPEED * ((pointerY - (vh - EDGE_PX)) / EDGE_PX));
        }
        if (dy !== 0) {
          window.scrollBy({ top: dy, behavior: "instant" });
          if (pointerX !== null) {
            const el = document.elementFromPoint(pointerX, pointerY);
            const colList = el?.closest<HTMLElement>("[data-column-scroll]");
            if (colList && colList.scrollHeight > colList.clientHeight) {
              colList.scrollTop += dy;
            }
          }
        }
      }
      rafId = window.requestAnimationFrame(step);
    };

    const onDragOver = (event: globalThis.DragEvent) => {
      if (event.clientY === 0 && event.clientX === 0) return;
      pointerY = event.clientY;
      pointerX = event.clientX;
    };

    const stop = () => {
      pointerY = null;
      pointerX = null;
    };

    window.addEventListener("dragover", onDragOver, true);
    window.addEventListener("dragend", stop, true);
    window.addEventListener("drop", stop, true);
    rafId = window.requestAnimationFrame(step);

    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener("dragover", onDragOver, true);
      window.removeEventListener("dragend", stop, true);
      window.removeEventListener("drop", stop, true);
    };
  }, [draggedKey]);

  async function post(route: string, body: unknown): Promise<boolean> {
    setError(null);
    setNotice(null);
    const response = await fetch(route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) setError(result.error ?? "That did not work.");
    else if (result.warning) setNotice(result.warning);
    await load().catch((err: Error) => setError(err.message));
    return response.ok;
  }

  function handleDragStart(key: string) {
    setDraggedKey(key);
  }

  function handleDragEnd() {
    setDraggedKey(null);
    setDropTarget(null);
  }

  function handleColumnDragOver(column: ColumnId, slot: number) {
    setDropTarget((current) => (current?.column === column && current.slot === slot ? current : { column, slot }));
  }

  function handleColumnDragLeave(column: ColumnId) {
    setDropTarget((current) => (current?.column === column ? null : current));
  }

  async function drop(event: DragEvent, column: ColumnId, slot: number) {
    event.preventDefault();
    const key = event.dataTransfer.getData(DRAG_TYPE) || draggedKey || "";
    setDropTarget(null);
    setDraggedKey(null);
    if (!key || !cards) return;
    const card = cards.find((candidate) => candidate.key === key);
    if (!card) return;

    const columnCards = orderColumnCards(column, cards.filter((candidate) => candidate.column === column));
    if (card.column === column) {
      const fromIndex = columnCards.findIndex((candidate) => candidate.key === key);
      if (fromIndex === -1) return;
      const targetIndex = fromIndex < slot ? slot - 1 : slot;
      if (targetIndex === fromIndex) return;
      setCards((current) => (current ? reorderCardsLocally(current, key, column, targetIndex) : current));
      await post("/api/board/reorder", { key, column, index: targetIndex });
      return;
    }

    const targetIndex = Math.max(0, Math.min(slot, columnCards.length));
    setCards((current) => (current ? reorderCardsLocally(current, key, column, targetIndex) : current));
    await post("/api/board/move", { key, column, index: targetIndex });
  }

  if (!cards) return <p className="mt-6 text-sm text-muted">{error ?? "Loading…"}</p>;

  const draggedCard = draggedKey ? cards.find((card) => card.key === draggedKey) ?? null : null;

  return (
    <>
      {error && <p className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">{error}</p>}
      {notice && <p className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-300">{notice}</p>}
      <div className="mt-6 grid grid-cols-5 gap-3">
        {COLUMNS.map((column) => {
          const columnCards = orderColumnCards(column.id, cards.filter((card) => card.column === column.id));
          const isTargetColumn = dropTarget?.column === column.id;
          const isCrossColumnTarget = isTargetColumn && draggedCard?.column !== column.id;
          let indicatorSlot: number | null = isTargetColumn ? dropTarget.slot : null;
          if (indicatorSlot !== null && draggedCard?.column === column.id) {
            const draggedIndex = columnCards.findIndex((card) => card.key === draggedCard.key);
            if (draggedIndex !== -1 && (indicatorSlot === draggedIndex || indicatorSlot === draggedIndex + 1)) {
              indicatorSlot = null;
            }
          }
          return (
            <BoardColumn
              key={column.id}
              column={column}
              cards={columnCards}
              draggedKey={draggedKey}
              highlighted={isCrossColumnTarget}
              reordering={isTargetColumn && !isCrossColumnTarget}
              indicatorSlot={indicatorSlot}
              onDragStartCard={handleDragStart}
              onDragEndCard={handleDragEnd}
              onColumnDragOver={(slot) => handleColumnDragOver(column.id, slot)}
              onColumnDragLeave={() => handleColumnDragLeave(column.id)}
              onDrop={(event, slot) => drop(event, column.id, slot)}
              onRetry={(key) => post("/api/board/retry", { key })}
              onDelete={(key) => post("/api/board/delete", { key })}
              onReferral={(key, request) => post("/api/board/referral", { key, ...request })}
              onNote={(key, notes) => post("/api/board/note", { key, notes })}
            />
          );
        })}
      </div>
    </>
  );
}

type ColumnProps = {
  column: Column;
  cards: BoardCard[];
  draggedKey: string | null;
  highlighted: boolean;
  reordering: boolean;
  indicatorSlot: number | null;
  onDragStartCard: (key: string) => void;
  onDragEndCard: () => void;
  onColumnDragOver: (slot: number) => void;
  onColumnDragLeave: () => void;
  onDrop: (event: DragEvent, slot: number) => void;
  onRetry: (key: string) => void;
  onDelete: (key: string) => void;
  onReferral: (key: string, request: Record<string, unknown>) => Promise<boolean>;
  onNote: (key: string, notes: string) => Promise<boolean>;
};

function slotForPointer(container: HTMLElement | null, clientY: number, cardCount: number): number {
  if (!container || cardCount === 0) return 0;
  const items = container.querySelectorAll<HTMLElement>("[data-card-index]");
  for (let i = 0; i < items.length; i++) {
    const rect = items[i].getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return i;
  }
  return cardCount;
}

function BoardColumn({
  column,
  cards,
  draggedKey,
  highlighted,
  reordering,
  indicatorSlot,
  onDragStartCard,
  onDragEndCard,
  onColumnDragOver,
  onColumnDragLeave,
  onDrop,
  onRetry,
  onDelete,
  onReferral,
  onNote,
}: ColumnProps) {
  const listRef = useRef<HTMLDivElement>(null);

  return (
    <section
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        onColumnDragOver(slotForPointer(listRef.current, event.clientY, cards.length));
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          onColumnDragLeave();
        }
      }}
      onDrop={(event) => {
        const slot = slotForPointer(listRef.current, event.clientY, cards.length);
        onDrop(event, slot);
      }}
      className={cn(
        "flex min-h-[70vh] flex-col rounded-xl border bg-surface/40 p-2 transition-colors",
        highlighted ? "border-brand bg-brand-soft" : reordering ? "border-brand/50" : "border-border",
      )}
    >
      <header className="px-2 pb-2 pt-1">
        <h2 className="flex items-center justify-between text-sm font-semibold">
          {column.label}
          <span className="text-xs font-normal text-faint">{cards.length}</span>
        </h2>
        <p className="text-[11px] text-faint">{column.hint}</p>
      </header>
      <div ref={listRef} data-column-scroll className="flex flex-1 flex-col gap-2.5 overflow-y-auto py-1.5">
        {column.id === "application" ? (
          <ApplicationSections
            cards={cards}
            draggedKey={draggedKey}
            indicatorSlot={indicatorSlot}
            onDragStartCard={onDragStartCard}
            onDragEndCard={onDragEndCard}
            onRetry={onRetry}
            onDelete={onDelete}
            onReferral={onReferral}
            onNote={onNote}
          />
        ) : (
          <>
            {cards.map((card, index) => (
              <div key={card.key} data-card-index={index} className="relative">
                {indicatorSlot === index && <DropIndicator position="before" />}
                <CardView
                  card={card}
                  isDragging={draggedKey === card.key}
                  onDragStart={() => onDragStartCard(card.key)}
                  onDragEnd={onDragEndCard}
                  onRetry={() => onRetry(card.key)}
                  onDelete={() => onDelete(card.key)}
                  onReferral={(request) => onReferral(card.key, request)}
                  onNote={(notes) => onNote(card.key, notes)}
                />
                {index === cards.length - 1 && indicatorSlot === cards.length && <DropIndicator position="after" />}
              </div>
            ))}
            {cards.length === 0 && indicatorSlot === 0 && <div className="h-0.5 rounded-full bg-brand" />}
          </>
        )}
      </div>
    </section>
  );
}

type ApplicationSectionsProps = {
  cards: BoardCard[];
  draggedKey: string | null;
  indicatorSlot: number | null;
  onDragStartCard: (key: string) => void;
  onDragEndCard: () => void;
  onRetry: (key: string) => void;
  onDelete: (key: string) => void;
  onReferral: (key: string, request: Record<string, unknown>) => Promise<boolean>;
  onNote: (key: string, notes: string) => Promise<boolean>;
};

/** Splits the Application column into Section A (ready to submit) and Section B (fill it yourself). */
function ApplicationSections({
  cards,
  draggedKey,
  indicatorSlot,
  onDragStartCard,
  onDragEndCard,
  onRetry,
  onDelete,
  onReferral,
  onNote,
}: ApplicationSectionsProps) {
  let offset = 0;
  return (
    <>
      {cards.length === 0 && indicatorSlot === 0 && <div className="h-0.5 rounded-full bg-brand" />}
      {APPLICATION_SECTIONS.map((section, sectionIdx) => {
        const sectionCards = cards.filter((card) => applicationSection(card) === section.id);
        const startOffset = offset;
        offset += sectionCards.length;
        return (
          <div key={section.id} className={cn("flex flex-col gap-2", sectionIdx > 0 && "mt-1 border-t border-border/70 pt-3")}>
            <h3 className="flex items-center justify-between px-1 text-[11px] font-medium uppercase tracking-wide text-faint">
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className={cn("inline-block size-1.5 rounded-full", section.id === "ready" ? "bg-emerald-400/80" : "bg-sky-400/80")}
                />
                {section.label}
              </span>
              <span className="font-normal normal-case">{sectionCards.length}</span>
            </h3>
            {sectionCards.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border/60 px-2.5 py-2 text-[11px] text-faint/70">{section.emptyHint}</p>
            ) : (
              sectionCards.map((card, localIdx) => {
                const index = startOffset + localIdx;
                return (
                  <div key={card.key} data-card-index={index} className="relative">
                    {indicatorSlot === index && <DropIndicator position="before" />}
                    <CardView
                      card={card}
                      isDragging={draggedKey === card.key}
                      onDragStart={() => onDragStartCard(card.key)}
                      onDragEnd={onDragEndCard}
                      onRetry={() => onRetry(card.key)}
                      onDelete={() => onDelete(card.key)}
                      onReferral={(request) => onReferral(card.key, request)}
                      onNote={(notes) => onNote(card.key, notes)}
                    />
                    {index === cards.length - 1 && indicatorSlot === cards.length && <DropIndicator position="after" />}
                  </div>
                );
              })
            )}
          </div>
        );
      })}
    </>
  );
}

function DropIndicator({ position }: { position: "before" | "after" }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute left-1 right-1 z-10 h-0.5 rounded-full bg-brand",
        position === "before" ? "-top-[5px]" : "-bottom-[5px]",
      )}
    />
  );
}

type CardProps = {
  card: BoardCard;
  isDragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onRetry: () => void;
  onDelete: () => void;
  onReferral: (request: Record<string, unknown>) => Promise<boolean>;
  onNote: (notes: string) => Promise<boolean>;
};

function CardView({ card, isDragging, onDragStart, onDragEnd, onRetry, onDelete, onReferral, onNote }: CardProps) {
  const [referralFormOpen, setReferralFormOpen] = useState(false);
  const [noteFormOpen, setNoteFormOpen] = useState(false);
  const running = card.run?.state === "running";
  const company = card.company || (card.url ? new URL(card.url).hostname : "Unknown company");
  return (
    <article
      draggable={!running && !referralFormOpen && !noteFormOpen}
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAG_TYPE, card.key);
        event.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={cn(
        "group relative rounded-lg border border-zinc-600/80 bg-[#1a1a1d] p-3 text-sm shadow-sm shadow-black/40 transition-[opacity,border-color,background-color]",
        running ? "cursor-wait opacity-80" : "cursor-grab active:cursor-grabbing hover:border-zinc-400/80 hover:bg-surface-hover",
        isDragging && "opacity-40",
      )}
    >
      {running ? (
        <span
          role="status"
          aria-label="Running"
          title={card.run?.message || "Running"}
          className="absolute right-2.5 top-2.5 flex size-2.5 items-center justify-center"
        >
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-amber-400/75" />
          <span className="relative inline-flex size-2 rounded-full bg-amber-400" />
        </span>
      ) : (
        <button
          type="button"
          onClick={onDelete}
          aria-label="Delete"
          title="Delete"
          className="absolute right-1.5 top-1.5 cursor-pointer rounded-md p-1 text-faint opacity-60 hover:bg-surface-hover hover:text-foreground hover:opacity-100 group-hover:opacity-100"
        >
          <X className="size-3.5" />
        </button>
      )}
      <p className="pr-5 font-medium leading-snug">{card.role || "Role not known yet"}</p>
      <p className="mt-0.5 truncate text-xs text-muted">{company}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {card.score && <span className="text-foreground">{card.score}</span>}
        {card.hasPdf && (
          <a
            href={`/api/board/cv?key=${encodeURIComponent(card.key)}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 px-1.5 py-0.5 text-emerald-400 hover:bg-emerald-500/10"
          >
            <FileText className="size-3" />
            Open CV
          </a>
        )}
        {card.url && !isPastedRef(card.url) && (
          <a href={card.url} target="_blank" rel="noreferrer" className="text-brand-text hover:underline">
            Posting
          </a>
        )}
        {!referralFormOpen && <ReferralButton onClick={() => setReferralFormOpen(true)} />}
        {!noteFormOpen && <NoteButton hasNotes={Boolean(card.notes)} onClick={() => setNoteFormOpen(true)} />}
      </div>
      <NotePanel notes={card.notes} formOpen={noteFormOpen} onFormOpenChange={setNoteFormOpen} onSave={onNote} />
      <ReferralPanel referrals={card.referrals} formOpen={referralFormOpen} onFormOpenChange={setReferralFormOpen} onSend={onReferral} />
      <EmployerLinkBadge card={card} onRetry={onRetry} />
      {card.run && showsRunLine(card) && <RunLine run={card.run} applyUrl={card.url && !isPastedRef(card.url) ? card.url : ""} onRetry={onRetry} />}
    </article>
  );
}

function RunLine({ run, applyUrl, onRetry }: { run: NonNullable<BoardCard["run"]>; applyUrl: string; onRetry: () => void }) {
  if (run.state === "running") return null;
  if (run.state === "done") {
    if (run.action === "evaluate" || run.action === "find-employer-link") return null;
    return <p className="mt-2 text-xs text-emerald-400 [overflow-wrap:anywhere]">{run.message}</p>;
  }
  const failure = summarizeFailure(run.action, run.message);
  const manual = run.action === "fill-application" || failure.kind === "manual";
  if (manual) {
    return (
      <div className="mt-2 rounded-md border border-border/80 bg-surface/60 p-2 text-xs">
        <p className="font-medium text-sky-300">{failure.headline}</p>
        <p className="mt-0.5 text-muted">{failure.next}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          {applyUrl && (
            <a href={applyUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-text hover:underline">
              <ExternalLink className="size-3" />
              Open application page
            </a>
          )}
          {failure.retryHelps && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex cursor-pointer items-center gap-1 text-muted hover:text-foreground"
            >
              <RotateCcw className="size-3" />
              Try auto-fill again
            </button>
          )}
        </div>
        <details className="mt-1 text-faint">
          <summary className="cursor-pointer select-none hover:text-muted">Why</summary>
          <p className="mt-1 text-muted [overflow-wrap:anywhere]">{run.message}</p>
        </details>
      </div>
    );
  }
  return (
    <div className="mt-2 text-xs">
      <p className="font-medium text-red-400">{failure.headline}</p>
      <p className="mt-0.5 text-foreground/90">
        <span className="text-muted">Next: </span>
        {failure.next}
      </p>
      <details className="mt-1 text-muted">
        <summary className="cursor-pointer select-none hover:text-foreground">Details</summary>
        <p className="mt-1 [overflow-wrap:anywhere]">{run.message}</p>
      </details>
      {failure.retryHelps && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1.5 flex cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted hover:bg-surface-hover hover:text-foreground"
        >
          <RotateCcw className="size-3" />
          Retry
        </button>
      )}
    </div>
  );
}
