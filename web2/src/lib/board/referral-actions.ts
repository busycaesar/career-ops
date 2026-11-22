import { randomUUID } from "node:crypto";
import { updateBoard } from "@/lib/board/board-store";
import { findCard, type BoardCard } from "@/lib/board/board-cards";
import { saveReferralContact } from "@/lib/board/referral-contacts";
import { setTrackerStatus } from "@/lib/board/tracker-status";
import type { Referral, ReferralInput, ReferralStatus } from "@/lib/board/referrals";

export type ReferralResult = { ok: true; warning?: string } | { ok: false; error: string };

/**
 * Records a referral ask on the card, then the durable copies: the person in
 * data/contacts.tsv and a note on the tracker row (status unchanged). The card
 * is saved first; if a durable copy fails, the result says which one.
 */
export async function addReferral(key: string, input: ReferralInput): Promise<ReferralResult> {
  const card = findCard(key);
  if (!card) return { ok: false, error: JOB_GONE };
  const referral: Referral = { id: randomUUID(), ...input, askedAt: new Date().toISOString(), status: "asked" };
  updateBoard((board) => {
    const entry = (board[key] ??= { column: card.column });
    entry.referrals = [...(entry.referrals ?? []), referral];
  });
  return recordDurably(card, referral);
}

export async function setReferralStatus(key: string, id: string, status: ReferralStatus): Promise<ReferralResult> {
  const card = findCard(key);
  if (!card) return { ok: false, error: JOB_GONE };
  let changed: Referral | undefined;
  updateBoard((board) => {
    const referral = board[key]?.referrals?.find((candidate) => candidate.id === id);
    if (!referral) return;
    referral.status = status;
    changed = { ...referral };
  });
  if (!changed) return { ok: false, error: REFERRAL_GONE };
  return recordDurably(card, changed);
}

/** Takes the ask off the card only: the person stays in contacts.tsv, they are still part of the user's network. */
export function removeReferral(key: string, id: string): ReferralResult {
  let removed = false;
  updateBoard((board) => {
    const entry = board[key];
    const before = entry?.referrals?.length ?? 0;
    if (!entry?.referrals) return;
    entry.referrals = entry.referrals.filter((referral) => referral.id !== id);
    removed = entry.referrals.length < before;
  });
  return removed ? { ok: true } : { ok: false, error: REFERRAL_GONE };
}

async function recordDurably(card: BoardCard, referral: Referral): Promise<ReferralResult> {
  const failures: string[] = [];
  if (card.company) {
    await saveReferralContact({ name: referral.name, company: card.company, trackerNumber: card.trackerNumber, note: contactNote(card, referral) }).catch((err: unknown) =>
      failures.push(`contacts.tsv: ${errorText(err)}`),
    );
  } else {
    failures.push("contacts.tsv: the job's company is not known yet, so the person was not saved there");
  }
  if (card.trackerNumber && card.trackerStatus) {
    await setTrackerStatus(card.trackerNumber, card.trackerStatus, trackerNote(referral)).catch((err: unknown) => failures.push(`tracker note: ${errorText(err)}`));
  }
  return failures.length ? { ok: true, warning: `Saved on the card, but not everywhere: ${failures.join("; ")}.` } : { ok: true };
}

function trackerNote(referral: Referral): string {
  const date = referral.askedAt.slice(0, DATE_CHARS);
  if (referral.status === "referred") return `Referred by ${referral.name} (asked ${date})`;
  if (referral.status === "declined") return `Referral declined by ${referral.name} (asked ${date})`;
  return `Referral asked: ${referral.name} (${date})`;
}

function contactNote(card: BoardCard, referral: Referral): string {
  const role = card.role ? ` for ${card.role}` : "";
  const how = referral.how ? ` via ${referral.how}` : "";
  const outcome = referral.status === "asked" ? "Referral asked" : referral.status === "referred" ? "Referred" : "Referral declined";
  const note = referral.note ? `: ${referral.note}` : "";
  return `${outcome}${role} (${referral.askedAt.slice(0, DATE_CHARS)}${how})${note}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const DATE_CHARS = 10;
const JOB_GONE = "That job is no longer on the board. Refresh the page.";
const REFERRAL_GONE = "That referral is no longer on this card. Refresh the page.";
