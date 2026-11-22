import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveCodeRoot } from "@/lib/core/code-root.mjs";

/**
 * Saves one job posting link to data/pipeline.md through the core's own
 * writers in scan.mjs (appendToPipeline + appendToScanHistory), the same ones
 * web/ uses, so the line format, duplicate check and file lock stay in one
 * place. They run in a short-lived node process from the career-ops checkout.
 */

export type SaveResult = { saved: boolean; duplicate: boolean; error?: string };


/** Company, role and location for the inbox line; empty strings when unknown. */
export type PostingLabels = { company: string; role: string; location: string };

export function savePostingToPipeline(url: string, labels: PostingLabels): Promise<SaveResult> {
  const codeRoot = resolveCodeRoot(process.cwd(), process.env);
  const scanUrl = pathToFileURL(path.join(codeRoot, "scan.mjs")).href;
  const localTodayUrl = pathToFileURL(path.join(codeRoot, "lib", "local-today.mjs")).href;
  const script = `
import { readFileSync } from "node:fs";
import path from "node:path";
import { appendToPipeline, appendToScanHistory } from ${JSON.stringify(scanUrl)};
import { localToday } from ${JSON.stringify(localTodayUrl)};
import { getCareerOpsRoot } from ${JSON.stringify(new URL("path-resolver.mjs", scanUrl).href)};
const url = process.argv[1];
const labels = JSON.parse(process.argv[2]);
const pipelinePath = path.join(getCareerOpsRoot(), "data", "pipeline.md");
const read = () => { try { return readFileSync(pipelinePath, "utf8"); } catch (e) { if (e.code === "ENOENT") return ""; throw e; } };
const before = read();
const offer = { url, company: labels.company, title: labels.role, ...(labels.location ? { location: labels.location } : {}), source: "web2-discover" };
await appendToPipeline([offer]);
const saved = read() !== before;
if (saved) await appendToScanHistory([offer], localToday(), "added");
process.stdout.write(JSON.stringify({ saved, duplicate: !saved }));
`;

  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, url, JSON.stringify(labels)], {
      cwd: codeRoot,
      env: process.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (err) => resolve({ saved: false, duplicate: false, error: `Could not start the pipeline writer: ${err.message}` }));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve({ saved: false, duplicate: false, error: `Pipeline writer exited with code ${code}: ${stderr.trim() || "no error output"}` });
        return;
      }
      try {
        resolve(JSON.parse(stdout) as SaveResult);
      } catch {
        resolve({ saved: false, duplicate: false, error: `Pipeline writer returned unreadable output: ${stdout.slice(0, 200)}` });
      }
    });
  });
}
