"use client";

import { useState, type FormEvent } from "react";
import { StickyNote } from "lucide-react";

const MAX_NOTES_CHARS = 2000;

type Props = {
  notes: string;
  formOpen: boolean;
  onFormOpenChange: (open: boolean) => void;
  onSave: (notes: string) => Promise<boolean>;
};

/** The "Note" button for the card's action row. */
export function NoteButton({ hasNotes, onClick }: { hasNotes: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex cursor-pointer items-center gap-1 text-muted hover:text-foreground"
    >
      <StickyNote className="size-3" />
      {hasNotes ? "Edit note" : "Note"}
    </button>
  );
}

/** Shows the card's saved notes by default (click to edit) and renders the inline editor when open. */
export function NotePanel({ notes, formOpen, onFormOpenChange, onSave }: Props) {
  if (formOpen) {
    return (
      <NoteForm
        initialNotes={notes}
        onCancel={() => onFormOpenChange(false)}
        onSave={async (nextNotes) => {
          const ok = await onSave(nextNotes);
          if (ok) onFormOpenChange(false);
          return ok;
        }}
      />
    );
  }

  if (!notes) return null;

  return (
    <button
      type="button"
      onClick={() => onFormOpenChange(true)}
      title="Click to edit note"
      className="mt-2 block w-full cursor-pointer rounded-md border border-amber-500/25 bg-amber-500/[0.06] px-2 py-1.5 text-left text-xs leading-relaxed text-zinc-200 transition-colors hover:border-amber-500/45 hover:bg-amber-500/[0.1] whitespace-pre-wrap [overflow-wrap:anywhere]"
    >
      {notes}
    </button>
  );
}

function NoteForm({
  initialNotes,
  onCancel,
  onSave,
}: {
  initialNotes: string;
  onCancel: () => void;
  onSave: (notes: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState(initialNotes);
  const [saving, setSaving] = useState(false);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (saving) return;
    setSaving(true);
    await onSave(value);
    setSaving(false);
  }

  async function clearNote() {
    if (saving) return;
    setSaving(true);
    await onSave("");
    setSaving(false);
  }

  return (
    <form onSubmit={submit} className="mt-2 space-y-1.5 rounded-md border border-zinc-700 bg-background/60 p-2 text-xs">
      <textarea
        autoFocus
        rows={3}
        value={value}
        maxLength={MAX_NOTES_CHARS}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder="Add a note (recruiter name, salary, next step, follow-up…)"
        className="w-full resize-y rounded border border-zinc-700 bg-surface px-2 py-1.5 text-xs text-foreground placeholder:text-faint focus:border-brand focus:outline-none"
      />
      <div className="flex items-center justify-between gap-1.5 pt-0.5">
        {initialNotes ? (
          <button
            type="button"
            disabled={saving}
            onClick={() => void clearNote()}
            className="cursor-pointer rounded-md px-2 py-1 text-red-400/90 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-50"
          >
            Delete
          </button>
        ) : (
          <span className="text-[10px] text-faint">Ctrl+Enter to save</span>
        )}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onCancel}
            className="cursor-pointer rounded-md px-2 py-1 text-muted hover:bg-surface-hover hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="cursor-pointer rounded-md bg-brand px-2 py-1 font-medium text-zinc-950 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </form>
  );
}
