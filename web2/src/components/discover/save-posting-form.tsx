"use client";

import { useState, type FormEvent, type KeyboardEvent } from "react";

type Tone = "ok" | "warn" | "bad";
type FeedbackItem = { tone: Tone; text: string };
type Feedback = { tone: Tone; text: string; items?: FeedbackItem[] } | null;

type BatchItem = {
  url: string;
  status: "saved" | "duplicate" | "error";
  role?: string;
  company?: string;
  error?: string;
};

const TONE_CLASS: Record<Tone, string> = { ok: "text-emerald-400", warn: "text-amber-400", bad: "text-red-400" };

/**
 * One box for one or more jobs: one or more posting links (one per line, read
 * on save), a job description pasted with its link on the first line, or a job
 * description alone.
 */
export function SavePostingForm() {
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const links = extractLinkLines(input);
  const linkCount = links.length;

  async function save(event?: FormEvent) {
    event?.preventDefault();
    if (saving || !input.trim()) return;
    setSaving(true);
    setFeedback(null);
    try {
      const response = await fetch("/api/pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input }),
      });
      const result = await response.json();
      if (!response.ok) {
        setFeedback({ tone: "bad", text: result.error ?? "Could not save." });
      } else if (result.batch && Array.isArray(result.results)) {
        const items: BatchItem[] = result.results;
        setFeedback(formatBatchFeedback(items, result.savedCount ?? 0, result.duplicateCount ?? 0, result.failedCount ?? 0));
        const failedUrls = items.filter((item) => item.status === "error").map((item) => item.url);
        setInput(failedUrls.join("\n"));
      } else if (result.duplicate) {
        setFeedback({ tone: "warn", text: "Already in your pipeline (or seen before), so nothing was added." });
      } else {
        const label = [result.role, result.company].filter(Boolean).join(" at ");
        setFeedback({ tone: "ok", text: label ? `Saved ${label} to your pipeline, with its job description.` : "Saved to your pipeline, with its job description." });
        setInput("");
      }
    } catch (err) {
      setFeedback({ tone: "bad", text: `Could not reach the server: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setSaving(false);
    }
  }

  function submitOnModEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void save();
    }
  }

  const buttonLabel = saving
    ? linkCount > 1
      ? `Reading ${linkCount} job postings…`
      : linkCount === 1
        ? "Reading the job posting…"
        : "Saving…"
    : linkCount > 1
      ? `Save ${linkCount} links`
      : "Save to pipeline";

  return (
    <form onSubmit={save} className="mt-6">
      <label htmlFor="posting-input" className="block text-sm text-muted">
        Job posting
      </label>
      <div className="mt-2 rounded-2xl border border-border bg-surface p-3 focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/40">
        <textarea
          id="posting-input"
          name="posting-input"
          rows={4}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={submitOnModEnter}
          placeholder="Paste one or more job links (one per line), or a job description (optionally with its link on the first line)…"
          className="field-sizing-content max-h-96 min-h-24 w-full resize-none bg-transparent text-sm text-foreground placeholder:text-faint focus:outline-none"
        />
        <div className="mt-2 flex items-center justify-end gap-3">
          <span className="text-xs text-faint">Ctrl+Enter to save</span>
          <button
            type="submit"
            disabled={saving || !input.trim()}
            className="rounded-full bg-brand px-4 py-2 text-sm font-medium text-zinc-950 transition-opacity disabled:opacity-50"
          >
            {buttonLabel}
          </button>
        </div>
      </div>
      {feedback && (
        <div className="mt-3 text-sm">
          <p className={TONE_CLASS[feedback.tone]}>{feedback.text}</p>
          {feedback.items && feedback.items.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs">
              {feedback.items.map((item, idx) => (
                <li key={idx} className={`${TONE_CLASS[item.tone]} [overflow-wrap:anywhere]`}>
                  {item.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}

function formatBatchFeedback(items: BatchItem[], savedCount: number, duplicateCount: number, failedCount: number): NonNullable<Feedback> {
  const parts: string[] = [];
  if (savedCount > 0) parts.push(`Saved ${savedCount} of ${items.length} links`);
  if (duplicateCount > 0) parts.push(`${duplicateCount} already in pipeline`);
  if (failedCount > 0) parts.push(`${failedCount} could not be read (kept in the box)`);
  const tone: Tone = failedCount === 0 && savedCount > 0 ? "ok" : savedCount === 0 && duplicateCount === 0 ? "bad" : "warn";
  const detailItems: FeedbackItem[] = items.map((item) => {
    const label = [item.role, item.company].filter(Boolean).join(" at ");
    if (item.status === "saved") {
      return { tone: "ok", text: label ? `Saved ${label}` : `Saved ${item.url}` };
    }
    if (item.status === "duplicate") {
      return { tone: "warn", text: label ? `Already in pipeline: ${label}` : `Already in pipeline: ${item.url}` };
    }
    return { tone: "bad", text: `${item.url} — ${item.error ?? "Could not read posting."}` };
  });
  return { tone, text: `${parts.join(" · ")}.`, items: detailItems };
}

/** Non-empty lines when every line is an http(s) URL; empty array otherwise. */
function extractLinkLines(value: string): string[] {
  const lines = value
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];
  return lines.every((line) => /^https?:\/\/\S+$/i.test(line)) ? lines : [];
}
