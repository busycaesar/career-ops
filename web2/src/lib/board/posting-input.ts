import crypto from "node:crypto";
import { PASTED_REF_PREFIX } from "@/lib/board/pasted-ref";

/**
 * What the Discover box was given: one or more posting links (one per line) to
 * read, a link with the job text pasted under it, or the job text alone.
 */
export type PostingInput =
  | { kind: "link"; url: string }
  | { kind: "links"; urls: string[] }
  | { kind: "link-and-text"; url: string; text: string }
  | { kind: "text"; text: string }
  | { kind: "invalid"; error: string };

export function parsePostingInput(raw: unknown): PostingInput {
  if (typeof raw !== "string" || !raw.trim()) return { kind: "invalid", error: TOO_SHORT };
  const trimmed = raw.trim();
  const nonEmptyLines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (nonEmptyLines.length === 1 && isHttpUrl(nonEmptyLines[0])) {
    return { kind: "link", url: nonEmptyLines[0] };
  }
  if (nonEmptyLines.length > 1 && nonEmptyLines.every(isHttpUrl)) {
    return { kind: "links", urls: nonEmptyLines };
  }

  const [firstLine, ...rest] = trimmed.split(/\r?\n/);
  const leadingUrl = isHttpUrl(firstLine.trim()) ? firstLine.trim() : null;
  const text = (leadingUrl ? rest.join("\n") : trimmed).trim();
  if (text.length < MIN_PASTED_CHARS) return { kind: "invalid", error: TOO_SHORT };
  return leadingUrl ? { kind: "link-and-text", url: leadingUrl, text } : { kind: "text", text };
}

/** A stable reference for a job pasted without a link: the same text always gets the same one. */
export function pastedRefFor(text: string): string {
  const hash = crypto.createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex").slice(0, HASH_CHARS);
  return `${PASTED_REF_PREFIX}${hash}.md`;
}

/**
 * Role and company, only where the pasted text states them plainly: a
 * "Title:" / "Company:" line, or a "{role} at {company}" line near the top.
 * Anything else stays empty; a guessed employer would end up on a CV.
 */
export function roleAndCompanyFromText(text: string): { role: string; company: string } {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/[\u00a0\s]+/g, " ").trim())
    .filter(Boolean)
    .slice(0, HEADER_LINES);
  const labelled = (pattern: RegExp) => lines.map((line) => line.match(pattern)?.[1]?.trim()).find(Boolean) ?? "";
  let role = labelled(ROLE_LINE);
  let company = labelled(COMPANY_LINE);
  if (!role || !company) {
    const atLine = lines.map((line) => line.match(ROLE_AT_COMPANY)).find(Boolean);
    if (atLine) {
      role ||= atLine[1].trim();
      company ||= atLine[2].trim();
    }
  }
  return { role, company };
}

function isHttpUrl(value: string): boolean {
  if (/\s/.test(value)) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

const TOO_SHORT = "Paste one or more job links (one per line), or the full job description.";
// A real job description is thousands of characters; a title or a sentence is not one.
const MIN_PASTED_CHARS = 300;
const HASH_CHARS = 16;
const HEADER_LINES = 8;
const ROLE_LINE = /^(?:job\s+title|title|role|position)\s*[:\-–—]\s*(.{2,100})$/i;
const COMPANY_LINE = /^(?:company(?:\s+name)?|employer|organi[sz]ation)\s*[:\-–—]\s*(.{2,80})$/i;
// One short line, no sentence punctuation: "Senior Engineer at Acme Corp".
const ROLE_AT_COMPANY = /^([^.!?:]{2,80}?)\s+at\s+([^.!?:]{2,60})$/i;
