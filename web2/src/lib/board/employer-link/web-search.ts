import { careerOpsRoot } from "@/lib/career-ops";
import { type CliSpec } from "@/lib/clis";
import {
  appendCliRunArgs,
  bothModelsLimitedMessage,
  chooseCliWithFallback,
  clearCliCooldown,
  getFallbackCooldowns,
  isUsageLimitError,
  recordCliCooldown,
  resolveFallbackCli,
} from "@/lib/cli-fallback";
import { claudeCliArgs } from "@/lib/claude-invocation.mjs";
import { spawnHeadlessCli } from "@/lib/spawn-cli.mjs";
import { capabilitiesFor } from "@/lib/worker-capabilities.mjs";
import { employerSearchPrompt, parseEmployerUrlEnvelope, type EmployerSearchAnswer } from "@/lib/board/employer-link/search-prompt";

/**
 * One short, read-only run (web search / fetch, no write tools, no MCP
 * servers: the "research" worker kind) that looks for the job on the
 * employer's own site. Uses Claude Haiku by default and falls back to Gemini
 * (Antigravity / Gemini CLI) automatically when Claude's usage limit is reached.
 * Throws when the run itself fails, so the card shows why; returns
 * `{ status: "none", reason }` when the search found nothing.
 */
export async function searchEmployerUrl(posting: SearchInput): Promise<EmployerSearchAnswer> {
  const root = careerOpsRoot();
  const prompt = employerSearchPrompt(posting);
  const choice = chooseCliWithFallback(CLI_ID, root);
  if (choice.allLimited && choice.allLimitedMessage) throw new Error(choice.allLimitedMessage);
  if (!choice.resolved) throw new Error(CLAUDE_MISSING);

  let activeSpec = choice.resolved.spec;
  let activeBin = choice.resolved.binPath;
  let activeModel = choice.model;
  let usedFallback = Boolean(choice.fallbackFrom);

  let output = await runSearchOnce(activeSpec, activeBin, prompt, activeModel);
  let answer = parseEmployerUrlEnvelope(output.result);

  if (answer === null) {
    const combined = `${output.error}\n${output.result}`.trim();
    if (isUsageLimitError(combined)) {
      const firstCooldown = recordCliCooldown(activeSpec.id, combined, root);
      if (usedFallback) {
        throw new Error(bothModelsLimitedMessage([choice.cooldown, firstCooldown]));
      }
      const fallback = resolveFallbackCli(activeSpec.id, root);
      if (!fallback) {
        const backupCooldowns = getFallbackCooldowns(activeSpec.id, root);
        if (backupCooldowns.length > 0) {
          throw new Error(bothModelsLimitedMessage([firstCooldown, ...backupCooldowns]));
        }
      } else {
        activeSpec = fallback.spec;
        activeBin = fallback.binPath;
        activeModel = fallback.model;
        usedFallback = true;
        output = await runSearchOnce(activeSpec, activeBin, prompt, activeModel);
        answer = parseEmployerUrlEnvelope(output.result);
        if (answer === null) {
          const secondCombined = `${output.error}\n${output.result}`.trim();
          if (isUsageLimitError(secondCombined)) {
            const backupCooldown = recordCliCooldown(activeSpec.id, secondCombined, root);
            throw new Error(bothModelsLimitedMessage([firstCooldown, backupCooldown]));
          }
        }
      }
    }
  }

  if (answer === null) {
    throw new Error(`The employer-link search ended without an answer.${output.error ? ` ${output.error}` : ""} Its last words: "${tail(output.result)}"`);
  }
  clearCliCooldown(activeSpec.id, root);
  return answer;
}

export type SearchInput = { company: string; role: string; location: string; sourceUrl: string };

function runSearchOnce(
  spec: CliSpec,
  binPath: string,
  prompt: string,
  model: string | null,
): Promise<{ result: string; error: string }> {
  if (spec.id === "claude") {
    const args = [...claudeCliArgs({ kind: SEARCH_KIND, prompt }), "--model", SEARCH_MODEL];
    return runClaudeToCompletion(binPath, args);
  }
  const args = appendCliRunArgs(spec.id, spec.args(prompt), {
    model,
    disableSlashCommands: spec.id === "antigravity",
  });
  return runPlainToCompletion(spec.id, spec.name, binPath, args);
}

/** The run's final text (the stream's result event) and any error it reported. */
function runClaudeToCompletion(binPath: string, args: string[]): Promise<{ result: string; error: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnHeadlessCli(binPath, args, { cwd: careerOpsRoot(), env: process.env }, { cliId: CLI_ID, capabilities: capabilitiesFor(SEARCH_KIND) });
    let buffered = "";
    let result = "";
    let assistantText = "";
    let error = "";
    const timer = setTimeout(() => child.kill(), SEARCH_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const event = parseLine(line);
        if (event?.type === "result") {
          result = typeof event.result === "string" ? event.result : result;
          if (event.is_error) error = String(event.result ?? "The run reported an error.");
        }
        if (event?.type === "assistant") assistantText += textOf(event);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => (error = (error + chunk.toString()).slice(-ERROR_CHARS)));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not start Claude for the employer-link search: ${err.message}`));
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ result: result || assistantText, error: error.trim() });
    });
  });
}

function runPlainToCompletion(cliId: string, cliName: string, binPath: string, args: string[]): Promise<{ result: string; error: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnHeadlessCli(binPath, args, { cwd: careerOpsRoot(), env: process.env }, { cliId, capabilities: capabilitiesFor(SEARCH_KIND) });
    let stdout = "";
    let error = "";
    const timer = setTimeout(() => child.kill(), SEARCH_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      error = (error + chunk.toString()).slice(-ERROR_CHARS);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not start ${cliName} for the employer-link search: ${err.message}`));
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ result: stdout, error: error.trim() });
    });
  });
}

type StreamEvent = { type?: string; result?: unknown; is_error?: boolean; message?: { content?: { type?: string; text?: string }[] } };

function parseLine(line: string): StreamEvent | null {
  try {
    return JSON.parse(line) as StreamEvent;
  } catch {
    return null;
  }
}

function textOf(event: StreamEvent): string {
  return (event.message?.content ?? []).map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

function tail(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(-ERROR_CHARS);
}

const CLI_ID = "claude";
const SEARCH_KIND = "research";
const SEARCH_MODEL = "haiku";
const SEARCH_TIMEOUT_MS = 4 * 60_000;
const ERROR_CHARS = 300;
const CLAUDE_MISSING = "The Claude CLI isn't installed, so the employer's site couldn't be searched.";
