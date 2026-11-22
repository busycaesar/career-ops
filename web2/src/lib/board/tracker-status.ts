import { spawn } from "node:child_process";
import { rootScript } from "@/lib/career-ops";
import { resolveCodeRoot } from "@/lib/core/code-root.mjs";

/** Set a tracker row's status through career-ops' own set-status.mjs (locked, validated, logged). */
export function setTrackerStatus(trackerNumber: string, status: string, note: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [rootScript("set-status"), trackerNumber, status, "--note", note], {
      cwd: resolveCodeRoot(process.cwd(), process.env),
      env: process.env,
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(`Tracker status set to ${status}`);
      else reject(new Error(`set-status.mjs exited with code ${code}: ${output.trim().slice(0, 300)}`));
    });
  });
}
