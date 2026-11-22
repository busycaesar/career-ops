"use client";

import { useState, type KeyboardEvent } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import { cn } from "@/lib/cn";
import type { JobPreferences, WorkMode } from "@/lib/preferences";

type Feedback = { tone: "ok" | "bad"; text: string } | null;

const WORK_MODE_OPTIONS: { id: WorkMode; label: string }[] = [
  { id: "remote", label: "Remote" },
  { id: "hybrid", label: "Hybrid" },
  { id: "onsite", label: "On-site" },
];

export function JobPreferencesPanel({ initial }: { initial: JobPreferences }) {
  const [saved, setSaved] = useState<JobPreferences>(initial);
  const [draft, setDraft] = useState<JobPreferences>(initial);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  function toggleWorkMode(mode: WorkMode) {
    setFeedback(null);
    setDraft((current) => {
      const exists = current.workModes.includes(mode);
      const next = exists ? current.workModes.filter((m) => m !== mode) : [...current.workModes, mode];
      return { ...current, workModes: next };
    });
  }

  async function save() {
    if (saving || !dirty) return;
    setSaving(true);
    setFeedback(null);
    try {
      const response = await fetch("/api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const result = await response.json();
      if (!response.ok) {
        setFeedback({ tone: "bad", text: result.error ?? "Could not save preferences." });
        return;
      }
      setSaved(result.preferences);
      setDraft(result.preferences);
      const files = Array.isArray(result.syncedFiles) && result.syncedFiles.length ? ` (${result.syncedFiles.join(", ")})` : "";
      setFeedback({ tone: "ok", text: `Saved job preferences${files}.` });
    } catch (err) {
      setFeedback({ tone: "bad", text: `Could not reach the server: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-10 rounded-2xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="size-4 text-brand-text" />
          <h2 className="text-base font-semibold">Job preferences</h2>
        </div>
        <span className="text-xs text-faint">Synced with profile.yml, portals.yml &amp; _profile.md</span>
      </div>

      <div className="mt-5 space-y-6">
        {/* Roles & Title Filters */}
        <div className="space-y-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">Roles &amp; title keywords</h3>

          <TagField
            id="pref-target-roles"
            label="Primary target roles"
            hint="Used by Evaluate & CV tailoring (config/profile.yml)"
            values={draft.targetRoles}
            placeholder="e.g. AI Engineer — press Enter"
            onChange={(targetRoles) => {
              setFeedback(null);
              setDraft((current) => ({ ...current, targetRoles }));
            }}
          />

          <TagField
            id="pref-positive-titles"
            label="Include title keywords"
            hint="Portal scan matches any of these (portals.yml title_filter.positive)"
            values={draft.positiveTitles}
            placeholder="e.g. LLM Engineer, AI Software Engineer — press Enter"
            onChange={(positiveTitles) => {
              setFeedback(null);
              setDraft((current) => ({ ...current, positiveTitles }));
            }}
          />

          <TagField
            id="pref-negative-titles"
            label="Exclude title keywords"
            hint="Skip titles containing these; prefix word: for whole-word match (portals.yml title_filter.negative)"
            values={draft.negativeTitles}
            placeholder="e.g. Junior, word:Intern, PHP — press Enter"
            chipTone="muted"
            onChange={(negativeTitles) => {
              setFeedback(null);
              setDraft((current) => ({ ...current, negativeTitles }));
            }}
          />
        </div>

        {/* Location & Work Mode */}
        <div className="space-y-4 border-t border-border pt-5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">Location &amp; work mode</h3>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="pref-city" className="block text-xs text-muted">
                City
              </label>
              <input
                id="pref-city"
                type="text"
                value={draft.city}
                onChange={(event) => {
                  setFeedback(null);
                  setDraft((current) => ({ ...current, city: event.target.value }));
                }}
                placeholder="e.g. Toronto"
                className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-faint focus:border-brand focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="pref-country" className="block text-xs text-muted">
                Country
              </label>
              <input
                id="pref-country"
                type="text"
                value={draft.country}
                onChange={(event) => {
                  setFeedback(null);
                  setDraft((current) => ({ ...current, country: event.target.value }));
                }}
                placeholder="e.g. Canada"
                className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-faint focus:border-brand focus:outline-none"
              />
            </div>
          </div>

          <div>
            <span className="block text-xs text-muted">Work modes</span>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {WORK_MODE_OPTIONS.map((option) => {
                const active = draft.workModes.includes(option.id);
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => toggleWorkMode(option.id)}
                    aria-pressed={active}
                    className={cn(
                      "cursor-pointer rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                      active
                        ? "border-brand bg-brand-soft text-brand-text"
                        : "border-border bg-background text-muted hover:bg-surface-hover hover:text-foreground",
                    )}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>

          <TagField
            id="pref-allowed-locations"
            label="Allowed locations"
            hint="Cities, provinces, or regions accepted by portal scans (portals.yml location_filter.allow)"
            values={draft.allowedLocations}
            placeholder="e.g. Toronto, Waterloo, Canada, Remote — press Enter"
            onChange={(allowedLocations) => {
              setFeedback(null);
              setDraft((current) => ({ ...current, allowedLocations }));
            }}
          />

          <TagField
            id="pref-blocked-locations"
            label="Blocked locations"
            hint="Exclude false-positive places (portals.yml location_filter.block)"
            values={draft.blockedLocations}
            placeholder="e.g. Ontario, CA, Vancouver, WA — press Enter"
            chipTone="muted"
            onChange={(blockedLocations) => {
              setFeedback(null);
              setDraft((current) => ({ ...current, blockedLocations }));
            }}
          />

          <div className="space-y-3">
            <TagField
              id="pref-authorized-countries"
              label="Work-authorized countries"
              hint="Countries where you can work without sponsorship (config/profile.yml location.authorized_in)"
              values={draft.authorizedCountries}
              placeholder="e.g. Canada — press Enter"
              onChange={(authorizedCountries) => {
                setFeedback(null);
                setDraft((current) => ({ ...current, authorizedCountries }));
              }}
            />

            <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted hover:text-foreground">
              <input
                type="checkbox"
                checked={draft.needsSponsorship}
                onChange={(event) => {
                  setFeedback(null);
                  setDraft((current) => ({ ...current, needsSponsorship: event.target.checked }));
                }}
                className="size-3.5 rounded border-border accent-brand"
              />
              I need visa sponsorship outside my authorized countries
            </label>
          </div>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <div className="text-xs">
          {feedback ? (
            <span className={feedback.tone === "ok" ? "text-emerald-400" : "text-red-400"}>{feedback.text}</span>
          ) : dirty ? (
            <span className="text-amber-400">Unsaved changes</span>
          ) : (
            <span className="text-faint">All changes saved</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {dirty && (
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                setDraft(saved);
                setFeedback(null);
              }}
              className="cursor-pointer rounded-full border border-border px-3.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
            >
              Reset
            </button>
          )}
          <button
            type="button"
            disabled={saving || !dirty}
            onClick={() => void save()}
            className="cursor-pointer rounded-full bg-brand px-4 py-1.5 text-xs font-medium text-zinc-950 transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save preferences"}
          </button>
        </div>
      </div>
    </section>
  );
}

function TagField({
  id,
  label,
  hint,
  values,
  placeholder,
  chipTone = "default",
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  values: string[];
  placeholder: string;
  chipTone?: "default" | "muted";
  onChange: (next: string[]) => void;
}) {
  const [text, setText] = useState("");

  function commit(raw: string) {
    const parts = raw
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    const existing = new Set(values.map((v) => v.toLowerCase()));
    const added = parts.filter((part) => !existing.has(part.toLowerCase()));
    if (added.length > 0) onChange([...values, ...added]);
    setText("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      commit(text);
    } else if (event.key === "Backspace" && !text && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  }

  function remove(index: number) {
    onChange(values.filter((_, i) => i !== index));
  }

  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-foreground">
        {label}
      </label>
      <p className="mt-0.5 text-[11px] text-faint">{hint}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-background p-2 focus-within:border-brand">
        {values.map((item, index) => (
          <span
            key={`${item}-${index}`}
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs",
              chipTone === "muted"
                ? "border-border bg-surface text-muted"
                : "border-brand/40 bg-brand-soft text-foreground",
            )}
          >
            {item}
            <button
              type="button"
              onClick={() => remove(index)}
              aria-label={`Remove ${item}`}
              className="cursor-pointer rounded text-faint hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          id={id}
          type="text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            if (text.trim()) commit(text);
          }}
          placeholder={values.length === 0 ? placeholder : "Add…"}
          className="min-w-36 flex-1 bg-transparent px-1 py-0.5 text-xs text-foreground placeholder:text-faint focus:outline-none"
        />
      </div>
    </div>
  );
}
