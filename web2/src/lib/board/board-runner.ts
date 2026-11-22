import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import type { RunRequest } from "@/lib/board/run-request";

/**
 * Starts a card's action in its own detached process (worker/run-card.mjs),
 * in a separate process group, so stopping or restarting the web2 server
 * (Ctrl+C included) leaves it running. Returns the worker's pid, so the card
 * can show the run as started before the worker records its own progress.
 */

const WORKER_DIR = path.join(process.cwd(), "worker");

export function startRun(request: RunRequest): number | undefined {
  const logFile = path.join(careerOpsRoot(), ".career-ops-web", "web2-runs.log");
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const log = fs.openSync(logFile, "a");
  try {
    const child = spawn(
      process.execPath,
      ["--import", path.join(WORKER_DIR, "register-aliases.mjs"), path.join(WORKER_DIR, "run-card.mjs"), JSON.stringify(request)],
      { cwd: process.cwd(), env: process.env, detached: true, stdio: ["ignore", log, log], windowsHide: true },
    );
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(log);
  }
}

/** Whether the process that started a run is still alive. */
export function isRunAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
