/**
 * Referrals asked for a job: who was asked, how, and where it stands. Pure, so
 * the card (client) and the API route (server) read one definition.
 */

export const REFERRAL_HOW = ["LinkedIn", "Email", "Text", "In person", "Other"] as const;
export type ReferralHow = (typeof REFERRAL_HOW)[number];
export type ReferralStatus = "asked" | "referred" | "declined";
export type Referral = { id: string; name: string; how?: ReferralHow; note?: string; askedAt: string; status: ReferralStatus };

export const MAX_NAME_CHARS = 80;
export const MAX_NOTE_CHARS = 300;
/** Days an unanswered ask waits before the card says to follow up. */
export const FOLLOW_UP_AFTER_DAYS = 5;

export type ReferralBadge = { tone: "asked" | "follow-up" | "referred" | "declined"; text: string };

/** What the card shows for one referral, as of `now`. */
export function referralBadge(referral: Referral, now: Date): ReferralBadge {
  if (referral.status === "referred") return { tone: "referred", text: `Referred ✓ · ${referral.name}` };
  if (referral.status === "declined") return { tone: "declined", text: `Declined · ${referral.name}` };
  const days = daysSince(referral.askedAt, now);
  if (days >= FOLLOW_UP_AFTER_DAYS) return { tone: "follow-up", text: `Follow up · ${referral.name} · ${days}d ago` };
  return { tone: "asked", text: `Referral asked · ${referral.name} · ${days === 0 ? "today" : `${days}d ago`}` };
}

export type ReferralInput = { name: string; how?: ReferralHow; note?: string };

/** The typed form fields, trimmed and checked, or the reason they cannot be saved. */
export function parseReferralInput(raw: { name?: unknown; how?: unknown; note?: unknown }): ReferralInput | { error: string } {
  const name = typeof raw.name === "string" ? singleLine(raw.name) : "";
  if (!name) return { error: "Enter the name of the person you asked." };
  if (name.length > MAX_NAME_CHARS) return { error: `Keep the name under ${MAX_NAME_CHARS} characters.` };
  const how = raw.how === undefined || raw.how === "" ? undefined : raw.how;
  if (how !== undefined && !REFERRAL_HOW.includes(how as ReferralHow)) return { error: `"How" must be one of: ${REFERRAL_HOW.join(", ")}.` };
  const note = typeof raw.note === "string" ? singleLine(raw.note) : "";
  if (note.length > MAX_NOTE_CHARS) return { error: `Keep the note under ${MAX_NOTE_CHARS} characters.` };
  return { name, ...(how ? { how: how as ReferralHow } : {}), ...(note ? { note } : {}) };
}

export function isReferralStatus(value: unknown): value is ReferralStatus {
  return value === "asked" || value === "referred" || value === "declined";
}

function daysSince(iso: string, now: Date): number {
  const elapsed = now.getTime() - new Date(iso).getTime();
  return Math.max(0, Math.floor(elapsed / MS_PER_DAY));
}

/** Tabs and line breaks would split a contacts.tsv row or a tracker note cell. */
function singleLine(value: string): string {
  return value.replace(/[\t\r\n|]+/g, " ").replace(/\s+/g, " ").trim();
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
