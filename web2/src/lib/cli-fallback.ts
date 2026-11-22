import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { resolveCli, resolveCliOrFallback, type CliResolution, type CliSpec } from "@/lib/clis";
import { USAGE_LIMIT_RE } from "@/lib/board/run-failure";

/**
 * Automatic CLI fallback when the primary CLI (typically Claude Code) hits a
 * usage / rate limit.
 *
 * - Detects Claude/CLI usage-limit errors using the same pattern the board
 *   failure classifier uses.
 * - Parses the reset time from messages like
 *   "You've hit your 5-hour limit · resets 3pm (America/Toronto)" and caches
 *   a cooldown in `<root>/.career-ops-web/cli-cooldown.json` so subsequent
 *   runs route straight to the Gemini fallback until the limit resets.
 * - Defaults to the first installed Gemini-capable CLI (`antigravity` / `agy`,
 *   then `gemini`). Overridable in `.env` or environment via:
 *     CAREER_OPS_FALLBACK_CLI=antigravity|gemini|none
 *     CAREER_OPS_FALLBACK_MODEL=<optional model name passed via --model>
 */

export { USAGE_LIMIT_RE };

const DEFAULT_FALLBACK_ORDER = ["antigravity", "gemini"] as const;
const DEFAULT_COOLDOWN_MS = 30 * 60_000;
const MIN_COOLDOWN_MS = 2 * 60_000;
const MAX_COOLDOWN_MS = 6 * 60 * 60_000;
const FALLBACK_CLI_LINE = /^\s*(?:export\s+)?CAREER_OPS_FALLBACK_CLI\s*=\s*(.*?)\s*$/;
const FALLBACK_MODEL_LINE = /^\s*(?:export\s+)?CAREER_OPS_FALLBACK_MODEL\s*=\s*(.*?)\s*$/;
const MODEL_FLAG_CLIS = new Set(["antigravity", "gemini", "claude", "codex", "opencode", "pi"]);
const SAFE_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DISABLED_VALUES = new Set(["none", "off", "false", "0", "disabled"]);

export type CooldownEntry = {
  limitedAt: string;
  resetAt: string;
  reason: string;
};

type CooldownMap = Record<string, CooldownEntry>;

export type FallbackConfig = {
  cli: string | null;
  disabled: boolean;
  model: string | null;
};

export type FallbackResolution = {
  spec: CliSpec;
  binPath: string;
  model: string | null;
};

export type CliChoice = {
  resolved: CliResolution | null;
  fallbackFrom: string | null;
  cooldown: CooldownEntry | null;
  model: string | null;
  allLimited: boolean;
  allLimitedMessage: string | null;
};

export function isUsageLimitError(text: string | null | undefined): boolean {
  return typeof text === "string" && USAGE_LIMIT_RE.test(text);
}

/**
 * Parse a reset timestamp from a CLI limit message (e.g.
 * "You've hit your 5-hour limit · resets 3pm (America/Toronto)").
 * Returns epoch ms, or null if no reset clock time is present.
 */
export function parseLimitResetAt(text: string, nowMs = Date.now()): number | null {
  if (!text) return null;
  const match = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text);
  if (!match) return null;

  let hour = Number.parseInt(match[1], 10);
  const minute = match[2] ? Number.parseInt(match[2], 10) : 0;
  const meridiem = match[3].toLowerCase();
  if (!Number.isFinite(hour) || hour < 1 || hour > 12 || !Number.isFinite(minute) || minute < 0 || minute > 59) {
    return null;
  }
  if (meridiem === "am") {
    hour = hour === 12 ? 0 : hour;
  } else {
    hour = hour === 12 ? 12 : hour + 12;
  }

  const candidate = new Date(nowMs);
  candidate.setSeconds(0, 0);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() <= nowMs + 60_000) {
    candidate.setDate(candidate.getDate() + 1);
  }
  const delta = candidate.getTime() - nowMs;
  if (delta < MIN_COOLDOWN_MS || delta > MAX_COOLDOWN_MS) {
    return nowMs + Math.min(Math.max(delta, MIN_COOLDOWN_MS), MAX_COOLDOWN_MS);
  }
  return candidate.getTime();
}

function cooldownFilePath(root: string): string {
  return path.join(root, ".career-ops-web", "cli-cooldown.json");
}

function readCooldownMap(root: string): CooldownMap {
  try {
    const raw = fs.readFileSync(cooldownFilePath(root), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as CooldownMap;
  } catch {
    return {};
  }
}

function writeCooldownMap(root: string, map: CooldownMap): void {
  const filePath = cooldownFilePath(root);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, filePath);
  } catch {
    // Non-fatal: cooldown persistence is an optimization, never a blocker.
  }
}

export function getActiveCooldown(cliId: string, root = careerOpsRoot(), nowMs = Date.now()): CooldownEntry | null {
  const map = readCooldownMap(root);
  const entry = map[cliId];
  if (!entry || typeof entry.resetAt !== "string") return null;
  const resetMs = Date.parse(entry.resetAt);
  if (!Number.isFinite(resetMs) || resetMs <= nowMs) return null;
  return entry;
}

export function recordCliCooldown(cliId: string, errorText: string, root = careerOpsRoot(), nowMs = Date.now()): CooldownEntry {
  const resetMs = parseLimitResetAt(errorText, nowMs) ?? nowMs + DEFAULT_COOLDOWN_MS;
  const entry: CooldownEntry = {
    limitedAt: new Date(nowMs).toISOString(),
    resetAt: new Date(resetMs).toISOString(),
    reason: errorText.replace(/\s+/g, " ").trim().slice(0, 300),
  };
  const map = readCooldownMap(root);
  map[cliId] = entry;
  writeCooldownMap(root, map);
  return entry;
}

export function clearCliCooldown(cliId: string, root = careerOpsRoot()): void {
  const map = readCooldownMap(root);
  if (!Object.hasOwn(map, cliId)) return;
  delete map[cliId];
  writeCooldownMap(root, map);
}

export function formatCooldownReset(entry: CooldownEntry, nowMs = Date.now()): string {
  const resetMs = Date.parse(entry.resetAt);
  if (!Number.isFinite(resetMs)) return "soon";
  const mins = Math.max(1, Math.round((resetMs - nowMs) / 60_000));
  try {
    const clock = new Date(resetMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return clock || `in ${mins}m`;
  } catch {
    return `in ${mins}m`;
  }
}

function unquote(raw: string): string {
  const quoted = /^(['"`])(.*?)\1/.exec(raw);
  return quoted ? quoted[2].trim() : raw.replace(/#.*$/, "").trim();
}

function readEnvValue(root: string, envKey: string, lineRe: RegExp, env: Record<string, string | undefined>): string | null {
  const fromEnv = env[envKey]?.trim();
  if (fromEnv) return fromEnv;
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, ".env"), "utf8");
  } catch {
    return null;
  }
  let value: string | null = null;
  for (const line of text.split("\n")) {
    const match = lineRe.exec(line);
    if (match) value = unquote(match[1]) || null;
  }
  return value;
}

export function readFallbackConfig(root = careerOpsRoot(), env: Record<string, string | undefined> = process.env): FallbackConfig {
  const rawCli = readEnvValue(root, "CAREER_OPS_FALLBACK_CLI", FALLBACK_CLI_LINE, env);
  const rawModel = readEnvValue(root, "CAREER_OPS_FALLBACK_MODEL", FALLBACK_MODEL_LINE, env);
  const normalizedCli = rawCli ? rawCli.toLowerCase() : null;
  const disabled = normalizedCli !== null && DISABLED_VALUES.has(normalizedCli);
  const model = rawModel && SAFE_MODEL_RE.test(rawModel) ? rawModel : null;
  return {
    cli: disabled ? null : normalizedCli,
    disabled,
    model,
  };
}

/**
 * Resolve an installed fallback CLI (Gemini via Antigravity CLI or Gemini CLI)
 * distinct from `failedCliId` that is NOT itself in an active usage-limit
 * cooldown. Returns null if disabled, none is installed, or every fallback is
 * also cooled down.
 */
export function resolveFallbackCli(
  failedCliId: string,
  root = careerOpsRoot(),
  env: Record<string, string | undefined> = process.env,
  nowMs = Date.now(),
): FallbackResolution | null {
  const cfg = readFallbackConfig(root, env);
  if (cfg.disabled) return null;

  const candidates = cfg.cli ? [cfg.cli] : [...DEFAULT_FALLBACK_ORDER];
  for (const candidate of candidates) {
    if (candidate === failedCliId) continue;
    if (getActiveCooldown(candidate, root, nowMs)) continue;
    const found = resolveCli(candidate);
    if (found) {
      return { spec: found.spec, binPath: found.binPath, model: cfg.model };
    }
  }
  return null;
}

/** Active cooldowns on installed fallback CLIs distinct from `primaryCliId`. */
export function getFallbackCooldowns(
  primaryCliId: string,
  root = careerOpsRoot(),
  env: Record<string, string | undefined> = process.env,
  nowMs = Date.now(),
): CooldownEntry[] {
  const cfg = readFallbackConfig(root, env);
  if (cfg.disabled) return [];
  const candidates = cfg.cli ? [cfg.cli] : [...DEFAULT_FALLBACK_ORDER];
  const entries: CooldownEntry[] = [];
  for (const candidate of candidates) {
    if (candidate === primaryCliId) continue;
    if (!resolveCli(candidate)) continue;
    const cd = getActiveCooldown(candidate, root, nowMs);
    if (cd) entries.push(cd);
  }
  return entries;
}

/** User-facing message shown ONLY when both primary and backup models hit their limits. */
export function bothModelsLimitedMessage(cooldowns: (CooldownEntry | null | undefined)[], nowMs = Date.now()): string {
  const valid = cooldowns.filter((c): c is CooldownEntry => Boolean(c && Number.isFinite(Date.parse(c.resetAt))));
  if (!valid.length) {
    return "Both primary and backup AI models have hit their usage limits. Wait until one resets, then retry.";
  }
  valid.sort((a, b) => Date.parse(a.resetAt) - Date.parse(b.resetAt));
  return `Both primary and backup AI models have hit their usage limits (next reset ${formatCooldownReset(valid[0], nowMs)}). Wait until one resets, then retry.`;
}

/**
 * Pick the CLI to start a run with. If the requested CLI is in an active
 * usage-limit cooldown and an available fallback CLI is installed, returns the
 * fallback immediately so we don't waste a doomed call on the rate-limited CLI.
 * When both primary and all installed backups are in cooldown, sets
 * `allLimited: true` so the caller can inform the user.
 */
export function chooseCliWithFallback(
  requestedCliId: string,
  root = careerOpsRoot(),
  env: Record<string, string | undefined> = process.env,
  nowMs = Date.now(),
): CliChoice {
  const requestedCooldown = getActiveCooldown(requestedCliId, root, nowMs);
  if (requestedCooldown) {
    const fallback = resolveFallbackCli(requestedCliId, root, env, nowMs);
    if (fallback) {
      return {
        resolved: { spec: fallback.spec, binPath: fallback.binPath, substitutedFrom: null },
        fallbackFrom: requestedCliId,
        cooldown: requestedCooldown,
        model: fallback.model,
        allLimited: false,
        allLimitedMessage: null,
      };
    }
    const backupCooldowns = getFallbackCooldowns(requestedCliId, root, env, nowMs);
    if (backupCooldowns.length > 0) {
      return {
        resolved: null,
        fallbackFrom: requestedCliId,
        cooldown: requestedCooldown,
        model: null,
        allLimited: true,
        allLimitedMessage: bothModelsLimitedMessage([requestedCooldown, ...backupCooldowns], nowMs),
      };
    }
  }
  const direct = resolveCliOrFallback(requestedCliId);
  if (!direct) {
    return { resolved: null, fallbackFrom: null, cooldown: null, model: null, allLimited: false, allLimitedMessage: null };
  }
  const activeId = direct.spec.id;
  if (activeId !== requestedCliId) {
    const activeCooldown = getActiveCooldown(activeId, root, nowMs);
    if (activeCooldown) {
      const fallback = resolveFallbackCli(activeId, root, env, nowMs);
      if (fallback) {
        return {
          resolved: { spec: fallback.spec, binPath: fallback.binPath, substitutedFrom: null },
          fallbackFrom: activeId,
          cooldown: activeCooldown,
          model: fallback.model,
          allLimited: false,
          allLimitedMessage: null,
        };
      }
      const backupCooldowns = getFallbackCooldowns(activeId, root, env, nowMs);
      if (backupCooldowns.length > 0) {
        return {
          resolved: null,
          fallbackFrom: activeId,
          cooldown: activeCooldown,
          model: null,
          allLimited: true,
          allLimitedMessage: bothModelsLimitedMessage([activeCooldown, ...backupCooldowns], nowMs),
        };
      }
    }
  }
  return { resolved: direct, fallbackFrom: null, cooldown: null, model: null, allLimited: false, allLimitedMessage: null };
}

/**
 * Append `--model <model>` for CLIs that accept it when a safe model name is provided.
 * Never mutates the input array.
 */
export function appendModelArg(cliId: string, args: string[], model: string | null | undefined): string[] {
  if (!model || !SAFE_MODEL_RE.test(model) || !MODEL_FLAG_CLIS.has(cliId)) return args;
  if (args.includes("--model")) return args;
  return [...args, "--model", model];
}

export type CliRunTuning = {
  model?: string | null;
  effort?: "low" | "medium" | "high" | null;
  disableSlashCommands?: boolean;
};

/**
 * Append safe, non-permission runtime flags (`--model`, `--effort`,
 * `--disable-slash-commands`) supported by the chosen CLI. Never mutates `args`.
 */
export function appendCliRunArgs(cliId: string, args: string[], tuning: CliRunTuning = {}): string[] {
  let next = appendModelArg(cliId, args, tuning.model);
  if (cliId === "antigravity") {
    if (tuning.disableSlashCommands && !next.includes("--disable-slash-commands")) {
      next = [...next, "--disable-slash-commands"];
    }
    if (tuning.effort && !next.includes("--effort")) {
      next = [...next, "--effort", tuning.effort];
    }
  }
  return next;
}

export function fallbackDisplayName(spec: CliSpec, model: string | null): string {
  const base = spec.id === "antigravity" ? "Gemini (Antigravity)" : spec.name;
  return model ? `${base} [${model}]` : base;
}
