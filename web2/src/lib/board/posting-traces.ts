import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { careerOpsRoot } from "@/lib/career-ops";
import { resolveCodeRoot } from "@/lib/core/code-root.mjs";
import { atomicWrite } from "@/lib/core/safe-write";
import { canonicalJobKey } from "@/lib/core/url-key.mjs";
import { jobUrlFromRest } from "@/lib/inbox-skip.mjs";
import { isPastedRef } from "@/lib/board/pasted-ref";

/**
 * Removes every trace of one posting from the inbox (data/pipeline.md) and the
 * scan history (data/scan-history.tsv), so the link counts as new again. Rows
 * are matched by the canonical job key, so every spelling of the same posting
 * goes (a LinkedIn search-results link and its /jobs/view/ link are one key).
 * Both files are rewritten under the core's pipeline lock, the one scan.mjs
 * takes for each of them.
 */
export async function removePostingTraces(jobKey: string): Promise<void> {
  const root = careerOpsRoot();
  await rewriteLocked(path.join(root, "data", "pipeline.md"), (text) => withoutInboxLines(text, jobKey));
  await rewriteLocked(path.join(root, "data", "scan-history.tsv"), (text) => withoutHistoryRows(text, jobKey));
}

/**
 * Points the posting's inbox line at another link (its employer's own posting),
 * keeping the rest of the line. Under the same pipeline lock as the removal.
 */
export async function replaceInboxUrl(jobKey: string, newUrl: string): Promise<void> {
  const file = path.join(careerOpsRoot(), "data", "pipeline.md");
  await rewriteLocked(file, (text) => withInboxUrl(text, jobKey, newUrl));
}

function withInboxUrl(text: string, jobKey: string, newUrl: string): string {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  return text
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(CHECKBOX_LINE);
      const oldUrl = match ? inboxLineTarget(match[1]) : null;
      return oldUrl && keyOf(oldUrl) === jobKey ? line.replace(oldUrl, newUrl) : line;
    })
    .join(newline);
}

function withoutInboxLines(text: string, jobKey: string): string {
  return keepLines(text, (line) => {
    const match = line.match(CHECKBOX_LINE);
    return !match || keyOf(inboxLineTarget(match[1])) !== jobKey;
  });
}

/** The line's posting link, or the reference of a job saved from pasted text. */
function inboxLineTarget(rest: string): string | null {
  const first = rest.split("|")[0].trim();
  return isPastedRef(first) ? first : jobUrlFromRest(rest);
}

function withoutHistoryRows(text: string, jobKey: string): string {
  const header = text.split(/\r?\n/, 1)[0] ?? "";
  const urlColumn = header.split("\t").indexOf("url");
  if (urlColumn === -1) throw new Error("data/scan-history.tsv has no url column, so its rows for this job cannot be found.");
  return keepLines(text, (line, index) => index === 0 || keyOf(line.split("\t")[urlColumn]) !== jobKey);
}

function keepLines(text: string, keep: (line: string, index: number) => boolean): string {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  return text
    .split(/\r?\n/)
    .filter((line, index) => line === "" || keep(line, index))
    .join(newline);
}

function keyOf(url: string | null | undefined): string {
  const trimmed = url?.trim();
  if (!trimmed) return "";
  return canonicalJobKey(trimmed) || trimmed;
}

async function rewriteLocked(file: string, change: (text: string) => string): Promise<void> {
  if (!fs.existsSync(file)) return;
  const { withPipelineLock } = await pipelineLock();
  await withPipelineLock(
    file,
    () => {
      const before = fs.readFileSync(file, "utf8");
      const after = change(before);
      if (after !== before) atomicWrite(file, after);
    },
    { timeoutMs: LOCK_TIMEOUT_MS, retryMs: LOCK_RETRY_MS },
  );
}

type PipelineLock = {
  withPipelineLock: (file: string, fn: () => void, options: { timeoutMs: number; retryMs: number }) => Promise<void>;
};

async function pipelineLock(): Promise<PipelineLock> {
  const file = path.join(resolveCodeRoot(process.cwd(), process.env), "pipeline-lock.mjs");
  const mod = (await import(/* webpackIgnore: true */ pathToFileURL(file).href)) as Partial<PipelineLock>;
  if (typeof mod.withPipelineLock !== "function") throw new Error(`${file} has no withPipelineLock export.`);
  return mod as PipelineLock;
}

const CHECKBOX_LINE = /^\s*-\s*\[[ xX!]\](.*)$/;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 50;
