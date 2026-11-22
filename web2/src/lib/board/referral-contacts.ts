import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { careerOpsRoot } from "@/lib/career-ops";
import { resolveCodeRoot } from "@/lib/core/code-root.mjs";
import { atomicWrite } from "@/lib/core/safe-write";

/**
 * Saves the person asked for a referral to data/contacts.tsv, career-ops'
 * phonebook (format: contacts.mjs header), so `contacto` finds them the next
 * time a job at the same company comes up. The row is keyed by name + company,
 * the key the vCard export uses: an existing row is updated in place, never
 * duplicated. Written under the core's per-file lock (pipeline-lock.mjs).
 */
export async function saveReferralContact(contact: ReferralContact): Promise<void> {
  const file = path.join(careerOpsRoot(), "data", "contacts.tsv");
  const [{ withPipelineLock }, { normalizeCompany }] = await Promise.all([coreModule<PipelineLock>("pipeline-lock.mjs"), coreModule<TrackerUtils>("tracker-utils.mjs")]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await withPipelineLock(
    file,
    () => {
      const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      const after = upsertRow(before, contact, normalizeCompany);
      if (after !== before) atomicWrite(file, after);
    },
    { timeoutMs: LOCK_TIMEOUT_MS, retryMs: LOCK_RETRY_MS },
  );
}

export type ReferralContact = { name: string; company: string; trackerNumber: string; note: string };

function upsertRow(text: string, contact: ReferralContact, normalizeCompany: (name: string) => string): string {
  const lines = text ? text.replace(/\r?\n$/, "").split(/\r?\n/) : [HEADER];
  const nameKey = contact.name.trim().toLowerCase();
  const companyKey = normalizeCompany(contact.company);
  // The last matching line is the current one: contacts.tsv is update-in-place, and the export keeps the last.
  let index = -1;
  lines.forEach((line, i) => {
    if (line.startsWith("#") || !line.trim()) return;
    const cells = line.split("\t");
    if (cells[0]?.trim().toLowerCase() === nameKey && normalizeCompany(cells[1] ?? "") === companyKey) index = i;
  });
  if (index === -1) {
    lines.push(rowFor(contact));
  } else {
    lines[index] = updatedRow(lines[index].split("\t"), contact);
  }
  return `${lines.join("\n")}\n`;
}

function rowFor(contact: ReferralContact): string {
  return [contact.name, contact.company, REFERRAL_TYPE, "", "", "", "", contact.trackerNumber || "-", contact.note].join("\t");
}

/** Keeps every channel the row already has; sets the type, links the tracker row and adds the note once. */
function updatedRow(cells: string[], contact: ReferralContact): string {
  const row = [...cells, ...Array(COLUMN_COUNT).fill("")].slice(0, Math.max(COLUMN_COUNT, cells.length));
  row[TYPE_COLUMN] = REFERRAL_TYPE;
  if (contact.trackerNumber && (!row[TRACKER_COLUMN] || row[TRACKER_COLUMN] === "-")) row[TRACKER_COLUMN] = contact.trackerNumber;
  if (!row[TRACKER_COLUMN]) row[TRACKER_COLUMN] = "-";
  const notes = row[NOTES_COLUMN].split("; ").filter(Boolean);
  if (!notes.includes(contact.note)) notes.push(contact.note);
  row[NOTES_COLUMN] = notes.join("; ");
  return row.join("\t");
}

type PipelineLock = { withPipelineLock: (file: string, fn: () => void, options: { timeoutMs: number; retryMs: number }) => Promise<void> };
type TrackerUtils = { normalizeCompany: (name: string) => string };

async function coreModule<T>(fileName: string): Promise<T> {
  const file = path.join(resolveCodeRoot(process.cwd(), process.env), fileName);
  return (await import(/* webpackIgnore: true */ pathToFileURL(file).href)) as T;
}

const HEADER = "# name\tcompany\ttype\ttitle\tphone\temail\tlinkedin\ttracker#\tnotes";
// contacto's type for a contact with a real relationship to the candidate (contacts.mjs header).
const REFERRAL_TYPE = "internal-referral";
const COLUMN_COUNT = 9;
const TYPE_COLUMN = 2;
const TRACKER_COLUMN = 7;
const NOTES_COLUMN = 8;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 100;
