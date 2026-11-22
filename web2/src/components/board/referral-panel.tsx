"use client";

import { useState, type FormEvent } from "react";
import { Check, Trash2, UserPlus, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { MAX_NAME_CHARS, MAX_NOTE_CHARS, REFERRAL_HOW, referralBadge, type Referral, type ReferralBadge, type ReferralStatus } from "@/lib/board/referrals";

type ReferralRequest = { action: "add"; name: string; how: string; note: string } | { action: "update"; id: string; status: ReferralStatus } | { action: "remove"; id: string };

type Props = {
  referrals: Referral[];
  formOpen: boolean;
  onFormOpenChange: (open: boolean) => void;
  onSend: (request: ReferralRequest) => Promise<boolean>;
};

/** The "Referral" button for the card's action row. */
export function ReferralButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex cursor-pointer items-center gap-1 text-muted hover:text-foreground">
      <UserPlus className="size-3" />
      Referral
    </button>
  );
}

/** The card's referral asks (all shown, newest first; click a badge to reveal actions) and the inline form to add one. */
export function ReferralPanel({ referrals, formOpen, onFormOpenChange, onSend }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const newestFirst = [...referrals].reverse();
  const now = new Date();

  return (
    <>
      {newestFirst.length > 0 && (
        <div className="mt-2 flex flex-col gap-1.5">
          {newestFirst.map((referral) => (
            <ReferralLine
              key={referral.id}
              referral={referral}
              badge={referralBadge(referral, now)}
              selected={selectedId === referral.id}
              onToggle={() => setSelectedId((current) => (current === referral.id ? null : referral.id))}
              onSend={async (request) => {
                const ok = await onSend(request);
                if (ok) setSelectedId(null);
                return ok;
              }}
            />
          ))}
        </div>
      )}
      {formOpen && <ReferralForm onCancel={() => onFormOpenChange(false)} onSend={onSend} onSaved={() => onFormOpenChange(false)} />}
    </>
  );
}

function ReferralLine({
  referral,
  badge,
  selected,
  onToggle,
  onSend,
}: {
  referral: Referral;
  badge: ReferralBadge;
  selected: boolean;
  onToggle: () => void;
  onSend: Props["onSend"];
}) {
  const open = referral.status === "asked";
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={selected}
        title={referral.note ? `${referral.note} (click for actions)` : "Click for actions"}
        className={cn(
          "cursor-pointer rounded-md border px-1.5 py-0.5 text-left transition-colors hover:brightness-110",
          BADGE_CLASS[badge.tone],
          selected && "ring-1 ring-brand/60",
        )}
      >
        {badge.text}
      </button>
      {selected && (
        <span className="inline-flex items-center gap-1">
          {open && (
            <>
              <IconButton label="Mark referred" onClick={() => onSend({ action: "update", id: referral.id, status: "referred" })} className="hover:text-emerald-400">
                <Check className="size-3" />
              </IconButton>
              <IconButton label="Mark declined" onClick={() => onSend({ action: "update", id: referral.id, status: "declined" })} className="hover:text-foreground">
                <X className="size-3" />
              </IconButton>
            </>
          )}
          <IconButton label="Remove from card" onClick={() => onSend({ action: "remove", id: referral.id })} className="hover:text-red-400">
            <Trash2 className="size-3" />
          </IconButton>
        </span>
      )}
    </div>
  );
}

function ReferralForm({ onCancel, onSend, onSaved }: { onCancel: () => void; onSend: Props["onSend"]; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [how, setHow] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    const saved = await onSend({ action: "add", name, how, note });
    setSaving(false);
    if (saved) onSaved();
  }

  return (
    <form onSubmit={submit} className="mt-2 space-y-1.5 rounded-md border border-border bg-background/40 p-2 text-xs">
      <input
        autoFocus
        required
        value={name}
        maxLength={MAX_NAME_CHARS}
        onChange={(event) => setName(event.target.value)}
        placeholder="Who did you ask?"
        className={FIELD_CLASS}
      />
      <select value={how} onChange={(event) => setHow(event.target.value)} className={cn(FIELD_CLASS, "cursor-pointer")}>
        <option value="">How? (optional)</option>
        {REFERRAL_HOW.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <input value={note} maxLength={MAX_NOTE_CHARS} onChange={(event) => setNote(event.target.value)} placeholder="Note (optional)" className={FIELD_CLASS} />
      <div className="flex justify-end gap-1.5 pt-0.5">
        <button type="button" onClick={onCancel} className="cursor-pointer rounded-md px-2 py-1 text-muted hover:bg-surface-hover hover:text-foreground">
          Cancel
        </button>
        <button type="submit" disabled={saving || !name.trim()} className="cursor-pointer rounded-md bg-brand px-2 py-1 font-medium text-zinc-950 disabled:cursor-not-allowed disabled:opacity-50">
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

function IconButton({ label, onClick, className, children }: { label: string; onClick: () => void; className: string; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className={cn("cursor-pointer rounded p-0.5 text-faint hover:bg-surface-hover", className)}>
      {children}
    </button>
  );
}

const BADGE_CLASS: Record<ReferralBadge["tone"], string> = {
  asked: "border-sky-500/40 text-sky-300",
  "follow-up": "border-amber-500/50 bg-amber-500/10 text-amber-300",
  referred: "border-emerald-500/40 text-emerald-400",
  declined: "border-border text-faint",
};

const FIELD_CLASS = "w-full rounded-md border border-border bg-surface px-2 py-1 text-foreground placeholder:text-faint focus:border-brand focus:outline-none";
