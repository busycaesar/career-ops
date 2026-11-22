import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { resolveCodeRoot } from "@/lib/core/code-root.mjs";
import { localISODate } from "@/lib/followups";
import { reportSlug, trackerTsvLine } from "@/lib/report-persist.mjs";
import { inferLabelsFromSavedJd } from "@/lib/board/posting-labels";
import type { SavedJd } from "@/lib/board/saved-jd";

/**
 * Give a posting that skipped Evaluate the records the CV step works from: a
 * report holding only the saved job description (no score, no analysis) and a
 * tracker row with score N/A. The CV run, the PDF name, Open CV and the
 * application step all key on that report number, so this is what lets a card
 * go from Interested straight to Custom Resume. Returns the tracker number.
 */
export async function createUnevaluatedRecord(jd: SavedJd): Promise<string> {
  const inferred = inferLabelsFromSavedJd(jd);
  const company = (jd.company || inferred.company).trim();
  const role = (jd.role || inferred.role || jd.title).trim();
  if (!company || !role) throw new Error(UNKNOWN_COMPANY);

  const root = careerOpsRoot();
  const codeRoot = resolveCodeRoot(process.cwd(), process.env);
  const run = (script: string, args: string[] = []) => runScript(codeRoot, root, script, args);

  const reserved = await run("reserve-report-num.mjs");
  const num = reserved.stdout.trim();
  if (!reserved.ok || !/^\d{3,}$/.test(num)) {
    throw new Error(`Could not reserve a report number for the CV-only record: ${reserved.stderr || `got "${num}"`}.`);
  }
  try {
    const today = localISODate();
    const slug = reportSlug(company, null);
    const reportFile = `${num}-${slug}-${today}.md`;
    fs.writeFileSync(path.join(root, "reports", reportFile), unevaluatedReport({ jd, company, role, today }));
    const additions = path.join(root, "batch", "tracker-additions");
    fs.mkdirSync(additions, { recursive: true });
    fs.writeFileSync(
      path.join(additions, `${num}-${slug}.tsv`),
      trackerTsvLine({ num, today, company, role, score: NO_SCORE, reportFile, notes: TRACKER_NOTE, via: null, url: jd.url }),
    );
    const merged = await run("merge-tracker.mjs");
    if (!merged.ok) throw new Error(`The CV-only record was written but merge-tracker.mjs failed: ${merged.stderr || "non-zero exit"}.`);
  } finally {
    await run("reserve-report-num.mjs", ["--release", num]);
  }
  return String(Number(num));
}

export const UNKNOWN_COMPANY =
  "Couldn't tell the company or role from this posting, so a CV can't be built without an evaluation. Drop it on Evaluate first.";

function unevaluatedReport({ jd, company, role, today }: { jd: SavedJd; company: string; role: string; today: string }): string {
  return `# Evaluation: ${company} — ${role}

**Date:** ${today}
**URL:** ${jd.url}
**Score:** N/A (not evaluated)
**Decision:** Not evaluated — CV built without an evaluation (web2)
**Legitimacy:** Not checked
**PDF:** pending
**Verification:** unconfirmed (${jd.source === "pasted" ? "pasted by user" : "browser-read by platform"})

This posting was not evaluated: there is no fit score, analysis or legitimacy check. The job description below was ${jd.source === "pasted" ? "pasted by the user" : "read once when the link was saved"}, and is kept so the CV step can tailor the CV to it.

## Job Description (archived verbatim)

${jd.text.trim()}
`;
}

function runScript(codeRoot: string, dataRoot: string, script: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(codeRoot, script), ...args], { cwd: dataRoot, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (err) => resolve({ ok: false, stdout: "", stderr: `${script} failed to start: ${err.message}` }));
    child.on("close", (code) => resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

const NO_SCORE = "N/A";
const TRACKER_NOTE = "CV without evaluation (web2)";
