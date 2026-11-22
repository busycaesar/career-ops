import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { canonicalJobKey } from "@/lib/core/url-key.mjs";
import { isPastedRef, pastedRefFileStem } from "@/lib/board/pasted-ref";

/**
 * The job description of one saved posting, read once when the link is saved
 * from Discover and kept in the data root's jds/ folder (user layer). Evaluate
 * and the CV step read it from here instead of fetching the posting again.
 */
export type SavedJd = {
  url: string;
  /** The posting page's own title, as read (LinkedIn: "{role} at {company} — {location}"). */
  title: string;
  role: string;
  company: string;
  location: string;
  readAt: string;
  source: JdSource;
  text: string;
  /** Raw href of an off-site Apply link the third-party page showed, if any. */
  applyUrl?: string;
  /** The third-party link this job was first saved from, once its employer link replaced it. */
  sourceUrl?: string;
};

export type JdSource = "linkedin-browser" | "ats-api" | "browser" | "pasted";

export function writeSavedJd(jd: SavedJd): void {
  const file = savedJdPath(jd.url);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = [
    `# Job description: ${oneLine(jd.role) || "Unknown role"}`,
    "",
    `**URL:** ${oneLine(jd.url)}`,
    `**Page title:** ${oneLine(jd.title)}`,
    `**Company:** ${oneLine(jd.company)}`,
    `**Role:** ${oneLine(jd.role)}`,
    `**Location:** ${oneLine(jd.location)}`,
    `**Read:** ${oneLine(jd.readAt)}`,
    `**Source:** ${jd.source}`,
    ...(jd.applyUrl ? [`**Apply link:** ${oneLine(jd.applyUrl)}`] : []),
    ...(jd.sourceUrl ? [`**Source URL:** ${oneLine(jd.sourceUrl)}`] : []),
  ].join("\n");
  fs.writeFileSync(file, `${header}\n\n${BODY_MARKER}\n\n${jd.text.trim()}\n`);
}

/** The saved description for this posting, or null when none was saved. */
export function readSavedJd(url: string): SavedJd | null {
  let raw: string;
  try {
    raw = fs.readFileSync(savedJdPath(url), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const markerAt = raw.indexOf(`\n${BODY_MARKER}\n`);
  if (markerAt < 0) return null;
  const header = raw.slice(0, markerAt);
  const field = (label: string) => header.match(new RegExp(`^\\*\\*${label}:\\*\\* ?(.*)$`, "m"))?.[1].trim() ?? "";
  const source = field("Source");
  return {
    url: field("URL") || url,
    title: field("Page title"),
    role: field("Role"),
    company: field("Company"),
    location: field("Location"),
    readAt: field("Read"),
    source: isJdSource(source) ? source : "browser",
    text: raw.slice(markerAt + BODY_MARKER.length + 2).trim(),
    applyUrl: field("Apply link") || undefined,
    sourceUrl: field("Source URL") || undefined,
  };
}

/**
 * The saved job whose employer link replaced this third-party link, so saving
 * the third-party link again counts as a duplicate. Null when none did.
 */
export function findJdBySourceUrl(url: string): SavedJd | null {
  const key = canonicalJobKey(url) || url.trim();
  const dir = path.join(careerOpsRoot(), "jds");
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.startsWith("web2-") && name.endsWith(".md"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  for (const name of names) {
    const header = fs.readFileSync(path.join(dir, name), "utf8").split(`\n${BODY_MARKER}\n`, 1)[0];
    const sourceUrl = header.match(SOURCE_URL_LINE)?.[1].trim();
    if (!sourceUrl || (canonicalJobKey(sourceUrl) || sourceUrl) !== key) continue;
    const jobUrl = header.match(URL_LINE)?.[1].trim();
    return jobUrl ? readSavedJd(jobUrl) : null;
  }
  return null;
}

/** The text handed to an agent: role and company first, then the description. */
export function savedJdPromptText(jd: SavedJd): string {
  const heading = [jd.role, jd.company && `at ${jd.company}`, jd.location && `(${jd.location})`].filter(Boolean).join(" ");
  return heading ? `${heading}\n\n${jd.text}` : jd.text;
}

/**
 * One file per posting: the LinkedIn job id when there is one, else a short
 * hash of the canonical posting key, so two spellings of one link share it.
 * A job pasted without a link already names its file in its reference.
 */
export function savedJdPath(url: string): string {
  return path.join(careerOpsRoot(), "jds", `${savedJdName(url)}.md`);
}

function savedJdName(url: string): string {
  if (isPastedRef(url)) return pastedRefFileStem(url);
  const match = url.match(LINKEDIN_JOB_ID);
  const linkedInId = match?.[1] ?? match?.[2];
  if (linkedInId) return `web2-linkedin-${linkedInId}`;
  const key = canonicalJobKey(url) || url.trim();
  return `web2-posting-${crypto.createHash("sha256").update(key).digest("hex").slice(0, HASH_CHARS)}`;
}

function isJdSource(value: string): value is JdSource {
  return value === "linkedin-browser" || value === "ats-api" || value === "browser" || value === "pasted";
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const BODY_MARKER = "---";
const SOURCE_URL_LINE = /^\*\*Source URL:\*\* ?(.*)$/m;
const URL_LINE = /^\*\*URL:\*\* ?(.*)$/m;
const HASH_CHARS = 16;
const LINKEDIN_JOB_ID = /linkedin\.com\/jobs\/(?:view\/(?:[^/?#]*-)?(\d+)|.*[?&]currentJobId=(\d+))/i;
