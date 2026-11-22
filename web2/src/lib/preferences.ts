import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import * as yaml from "js-yaml";
import { careerOpsRoot, portalsConfigPath } from "@/lib/career-ops";
import { getProfilePath } from "@/lib/core/profile-path.mjs";
import { atomicWriteWithBackup } from "@/lib/core/safe-write";

export type WorkMode = "remote" | "hybrid" | "onsite";

export type JobPreferences = {
  targetRoles: string[];
  positiveTitles: string[];
  negativeTitles: string[];
  city: string;
  country: string;
  workModes: WorkMode[];
  allowedLocations: string[];
  blockedLocations: string[];
  authorizedCountries: string[];
  needsSponsorship: boolean;
};

const ALL_WORK_MODES: readonly WorkMode[] = ["remote", "hybrid", "onsite"];

/**
 * Read job preferences from career-ops's canonical user-layer files:
 * - config/profile.yml (target_roles.primary, location.*, compensation.location_flexibility)
 * - portals.yml (title_filter.positive/negative, location_filter.allow/block/workplace_policy)
 * - modes/_profile.md (## Your Location Policy fallback for work modes)
 */
export function readJobPreferences(root = careerOpsRoot()): JobPreferences {
  const profile = readYamlMapping(getProfilePath(root));
  const portals = readYamlMapping(portalsConfigPath(root));
  const profileMd = readOptionalFile(path.join(root, "modes", "_profile.md"));

  const targetRolesSection = asMapping(profile.target_roles);
  const locationSection = asMapping(profile.location);
  const compSection = asMapping(profile.compensation);
  const titleFilter = asMapping(portals.title_filter);
  const locationFilter = asMapping(portals.location_filter);
  const workplacePolicy = asMapping(locationFilter.workplace_policy);

  const targetRoles = stringArray(targetRolesSection.primary);
  const positiveTitles = stringArray(titleFilter.positive);
  const negativeTitles = stringArray(titleFilter.negative);
  const city = asString(locationSection.city);
  const country = asString(locationSection.country);
  const allowedLocations = stringArray(locationFilter.allow);
  const blockedLocations = stringArray(locationFilter.block);
  const authorizedCountries = stringArray(locationSection.authorized_in);
  const needsSponsorship = locationSection.needs_sponsorship === true;
  const workModes = inferWorkModes({
    flexibility: asString(compSection.location_flexibility),
    allowedLocations,
    workplacePolicy,
    profileMd,
  });

  return {
    targetRoles,
    positiveTitles,
    negativeTitles,
    city,
    country,
    workModes,
    allowedLocations,
    blockedLocations,
    authorizedCountries,
    needsSponsorship,
  };
}

export function validateJobPreferences(raw: unknown): { ok: true; value: JobPreferences } | { ok: false; error: string } {
  if (!isMapping(raw)) return { ok: false, error: "Invalid preferences payload." };
  const targetRoles = cleanList(raw.targetRoles, 20, 100);
  const positiveTitles = cleanList(raw.positiveTitles, 60, 120);
  const negativeTitles = cleanList(raw.negativeTitles, 120, 120);
  const allowedLocations = cleanList(raw.allowedLocations, 80, 100);
  const blockedLocations = cleanList(raw.blockedLocations, 80, 100);
  const authorizedCountries = cleanList(raw.authorizedCountries, 30, 80);
  const city = cleanScalar(raw.city, 80);
  const country = cleanScalar(raw.country, 80);
  const workModes = cleanWorkModes(raw.workModes);
  const needsSponsorship = raw.needsSponsorship === true;

  if (targetRoles.length === 0 && positiveTitles.length === 0) {
    return { ok: false, error: "Add at least one target role or include title keyword." };
  }
  if (workModes.length === 0) {
    return { ok: false, error: "Select at least one work mode (Remote, Hybrid, or On-site)." };
  }

  return {
    ok: true,
    value: {
      targetRoles,
      positiveTitles,
      negativeTitles,
      city,
      country,
      workModes,
      allowedLocations,
      blockedLocations,
      authorizedCountries,
      needsSponsorship,
    },
  };
}

/**
 * Sync preferences back to config/profile.yml, portals.yml, and modes/_profile.md
 * using comment-preserving text edits and atomic writes with backups.
 */
export function saveJobPreferences(prefs: JobPreferences, root = careerOpsRoot()): { syncedFiles: string[] } {
  const syncedFiles: string[] = [];

  saveProfilePreferences(getProfilePath(root), prefs);
  syncedFiles.push("config/profile.yml");

  const portalsPath = portalsConfigPath(root);
  if (fs.existsSync(portalsPath)) {
    savePortalsPreferences(portalsPath, prefs);
    syncedFiles.push("portals.yml");
  }

  const profileMdPath = path.join(root, "modes", "_profile.md");
  if (fs.existsSync(profileMdPath)) {
    saveLocationPolicyInProfileMd(profileMdPath, prefs);
    syncedFiles.push("modes/_profile.md");
  }

  return { syncedFiles };
}

function saveProfilePreferences(file: string, prefs: JobPreferences): void {
  const source = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const parsed = source.trim() ? yaml.load(source) : {};
  if (!isMapping(parsed)) {
    throw new Error("config/profile.yml is not a valid YAML mapping — refusing to overwrite it.");
  }

  const flexibility = formatWorkModes(prefs.workModes);
  const visaStatus = buildVisaStatus(prefs.authorizedCountries, prefs.needsSponsorship);

  const patch: Record<string, Record<string, YamlValue>> = {
    target_roles: {
      primary: prefs.targetRoles,
    },
    compensation: {
      location_flexibility: flexibility,
    },
    location: {
      country: prefs.country,
      city: prefs.city,
      authorized_in: prefs.authorizedCountries,
      needs_sponsorship: prefs.needsSponsorship,
      ...(visaStatus ? { visa_status: visaStatus } : {}),
    },
  };

  const merged = deepMerge(parsed, patch);
  const edited = source ? patchYamlSections(source, patch, merged) : null;
  const output = edited ?? yaml.dump(merged, { lineWidth: 100, noRefs: true });
  atomicWriteWithBackup(file, output);
}

function savePortalsPreferences(file: string, prefs: JobPreferences): void {
  const source = fs.readFileSync(file, "utf8");
  const parsed = yaml.load(source);
  if (!isMapping(parsed)) {
    throw new Error("portals.yml is not a valid YAML mapping — refusing to overwrite it.");
  }

  const wantsRemote = prefs.workModes.includes("remote");
  const allowed = syncRemoteKeyword(prefs.allowedLocations, wantsRemote);

  const patch: Record<string, Record<string, YamlValue>> = {
    title_filter: {
      positive: prefs.positiveTitles,
      negative: prefs.negativeTitles,
    },
    location_filter: {
      allow: allowed,
      block: prefs.blockedLocations,
    },
  };

  const merged = deepMerge(parsed, patch);
  const edited = patchYamlSections(source, patch, merged);
  const output = edited ?? yaml.dump(merged, { lineWidth: 100, noRefs: true });
  atomicWriteWithBackup(file, output);
}

/**
 * Update ONLY the `## Your Location Policy` section inside modes/_profile.md so
 * evaluations use the same city/country, work modes, and authorization policy.
 */
function saveLocationPolicyInProfileMd(file: string, prefs: JobPreferences): void {
  const source = fs.readFileSync(file, "utf8");
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);

  const headingIdx = lines.findIndex((line) => /^##\s+Your Location Policy\s*$/i.test(line.trim()));
  if (headingIdx === -1) return;

  let endIdx = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }

  const basePlace = [prefs.city, prefs.country].filter(Boolean).join(", ");
  const authSummary = buildVisaStatus(prefs.authorizedCountries, prefs.needsSponsorship);
  const countryLabel = prefs.authorizedCountries.length > 0 ? prefs.authorizedCountries.join(" / ") : prefs.country || "your authorized countries";
  const wantsRemote = prefs.workModes.includes("remote");
  const wantsHybrid = prefs.workModes.includes("hybrid");
  const wantsOnsite = prefs.workModes.includes("onsite");

  const officeModes = [wantsOnsite && "Office", wantsHybrid && "hybrid"].filter(Boolean).join(" or ");
  const policyLines = [
    lines[headingIdx],
    "",
    [basePlace && `Based in ${basePlace}.`, authSummary && `${authSummary}.`, `Preferred work modes: ${formatWorkModes(prefs.workModes)}.`]
      .filter(Boolean)
      .join(" "),
    "",
    "**In forms:**",
    "- Answer location and work-authorization questions from config/profile.yml.",
    "",
    "**In evaluations (scoring):**",
    officeModes
      ? `- ${officeModes} in ${countryLabel}: in scope.`
      : `- On-site and hybrid roles: out of scope (remote only).`,
    wantsRemote
      ? `- Remote that can be done from ${countryLabel}: in scope.`
      : `- Remote-only roles outside preferred work modes: lower priority.`,
    `- A role that cannot be done from ${countryLabel}: score the remote dimension **1.0**.`,
    `- Remote with no stated country: treat eligibility as unconfirmed and flag it. Never assume ${countryLabel} is allowed.`,
  ];

  // Preserve trailing blank line before the next section if there is one.
  if (endIdx < lines.length) policyLines.push("");

  lines.splice(headingIdx, endIdx - headingIdx, ...policyLines);
  const next = lines.join(eol);
  if (next !== source) atomicWriteWithBackup(file, next);
}

function inferWorkModes(opts: {
  flexibility: string;
  allowedLocations: string[];
  workplacePolicy: Record<string, unknown>;
  profileMd: string;
}): WorkMode[] {
  const flex = opts.flexibility.toLowerCase();
  if (flex) {
    const found: WorkMode[] = [];
    if (/\bremote\b/.test(flex)) found.push("remote");
    if (/\bhybrid\b/.test(flex)) found.push("hybrid");
    if (/\b(?:on[- ]?site|office|in[- ]?person)\b/.test(flex)) found.push("onsite");
    if (found.length > 0) return found;
  }

  const found: WorkMode[] = [];
  const hasRemote =
    opts.allowedLocations.some((loc) => /\bremote\b/i.test(loc)) ||
    stringArray(opts.workplacePolicy.remote_countries).length > 0;
  const hasOnsite =
    stringArray(opts.workplacePolicy.onsite_countries).length > 0 ||
    stringArray(opts.workplacePolicy.onsite_locations).length > 0 ||
    /office or hybrid.*in scope/i.test(opts.profileMd);
  const hasHybrid = hasOnsite || /\bhybrid.*in scope/i.test(opts.profileMd);

  if (hasRemote) found.push("remote");
  if (hasHybrid) found.push("hybrid");
  if (hasOnsite) found.push("onsite");
  return found.length > 0 ? found : ["remote", "hybrid", "onsite"];
}

function formatWorkModes(modes: WorkMode[]): string {
  const labels: Record<WorkMode, string> = { remote: "Remote", hybrid: "Hybrid", onsite: "On-site" };
  return ALL_WORK_MODES.filter((m) => modes.includes(m)).map((m) => labels[m]).join(", ");
}

function buildVisaStatus(authorizedCountries: string[], needsSponsorship: boolean): string {
  if (authorizedCountries.length === 0) {
    return needsSponsorship ? "Requires visa sponsorship" : "";
  }
  const list = authorizedCountries.join(", ");
  return needsSponsorship
    ? `Authorized to work in ${list}; sponsorship needed outside ${list}`
    : `Authorized to work in ${list}; no sponsorship needed`;
}

function syncRemoteKeyword(locations: string[], wantsRemote: boolean): string[] {
  const withoutRemote = locations.filter((loc) => loc.toLowerCase() !== "remote");
  if (!wantsRemote) return withoutRemote;
  return locations.some((loc) => loc.toLowerCase() === "remote") ? locations : [...locations, "Remote"];
}

// ── Comment-preserving YAML section patcher ──────────────────────────────────

type YamlValue = string | number | boolean | string[];

function patchYamlSections(
  source: string,
  patch: Record<string, Record<string, YamlValue>>,
  expected: Record<string, unknown>,
): string | null {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);

  for (const [section, values] of Object.entries(patch)) {
    if (!applySectionLines(lines, section, values)) return null;
  }

  const text = lines.join(eol);
  try {
    return isDeepStrictEqual(yaml.load(text), expected) ? text : null;
  } catch {
    return null;
  }
}

function applySectionLines(lines: string[], section: string, values: Record<string, YamlValue>): boolean {
  const headers = lines.flatMap((line, i) => (line.startsWith(`${section}:`) ? [i] : []));
  if (headers.length > 1) return false;
  let start: number;
  let end: number;

  if (headers.length === 0) {
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    if (lines.length > 0) lines.push("");
    start = lines.length;
    lines.push(`${section}:`);
    end = lines.length;
  } else {
    start = headers[0];
    if (!/^\s*(#.*)?$/.test(lines[start].slice(section.length + 1))) return false;
    end = start + 1;
    while (end < lines.length && (isBlankOrComment(lines[end]) || /^\s/.test(lines[end]))) end++;
    while (end > start + 1 && (lines[end - 1].trim() === "" || /^#/.test(lines[end - 1]))) end--;
  }

  const firstChild = lines.slice(start + 1, end).find((line) => !isBlankOrComment(line));
  const indent = firstChild ? indentOf(firstChild) : "  ";

  for (const [key, value] of Object.entries(values)) {
    let at = -1;
    for (let i = start + 1; i < end && at === -1; i++) {
      if (lines[i].startsWith(`${indent}${key}:`)) at = i;
    }

    if (Array.isArray(value)) {
      const quoted = value.map((item) => JSON.stringify(item));
      if (at === -1) {
        const block = quoted.length
          ? [`${indent}${key}:`, ...quoted.map((item) => `${indent}  - ${item}`)]
          : [`${indent}${key}: []`];
        let insert = start + 1;
        for (let i = start + 1; i < end; i++) if (/^\s+\S/.test(lines[i])) insert = i + 1;
        lines.splice(insert, 0, ...block);
        end += block.length;
      } else {
        const rest = lines[at].slice(indent.length + key.length + 1);
        const comment = trailingComment(rest);
        const rawVal = rest.slice(0, rest.length - comment.length).trim();
        if (rawVal === "") {
          const { last, kept, itemIndent } = scanBlockList(lines, at, end, indent);
          const next = quoted.length
            ? [`${indent}${key}:${comment}`, ...kept, ...quoted.map((item) => `${itemIndent}- ${item}`)]
            : [`${indent}${key}: []${comment}`, ...kept];
          lines.splice(at, last - at + 1, ...next);
          end += next.length - (last - at + 1);
        } else if (/^\[.*\]$/.test(rawVal)) {
          lines[at] = `${indent}${key}: [${quoted.join(", ")}]${comment}`;
        } else {
          return false;
        }
      }
    } else if (at !== -1) {
      const rest = lines[at].slice(indent.length + key.length + 1);
      const comment = trailingComment(rest);
      lines[at] = `${indent}${key}: ${formatScalar(value)}${comment}`;
    } else {
      let insert = start + 1;
      for (let i = start + 1; i < end; i++) if (/^\s+\S/.test(lines[i])) insert = i + 1;
      lines.splice(insert, 0, `${indent}${key}: ${formatScalar(value)}`);
      end += 1;
    }
  }

  return true;
}

function scanBlockList(lines: string[], at: number, end: number, indent: string) {
  let last = at;
  let dash = -1;
  for (let i = at + 1; i < end; i++) {
    if (isBlankOrComment(lines[i])) continue;
    const width = indentOf(lines[i]).length;
    if (/^\s*- /.test(lines[i]) && width >= indent.length) {
      last = i;
      if (dash === -1) dash = width;
    } else if (dash !== -1 && width > dash) {
      last = i;
    } else {
      break;
    }
  }
  const firstItem = lines.slice(at + 1, last + 1).find((line) => /^\s*- /.test(line));
  const itemIndent = firstItem ? indentOf(firstItem) : `${indent}  `;
  const kept = lines.slice(at + 1, last + 1).filter((line) => line.trim().startsWith("#"));
  return { last, kept, itemIndent };
}

function trailingComment(value: string): string {
  const flow = /^\s*[[{]/.test(value);
  let quote = "";
  let closedAt = -1;
  let scalarStart = true;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    const prev = i === 0 ? " " : value[i - 1];
    if (quote) {
      if (quote === '"' && c === "\\") i++;
      else if (c === quote && quote === "'" && value[i + 1] === "'") i++;
      else if (c === quote) [quote, closedAt] = ["", i];
    } else if (/\s/.test(c)) {
      continue;
    } else if ((c === '"' || c === "'") && scalarStart) {
      quote = c;
      scalarStart = false;
    } else if (c !== "#" || !/\s/.test(prev)) {
      const mappingColon = c === ":" && (closedAt === i - 1 || /^$|[\s,[\]{}]/.test(value[i + 1] ?? ""));
      scalarStart = flow && (/[[{,]/.test(c) || mappingColon);
    } else {
      let start = i;
      while (start > 0 && /\s/.test(value[start - 1])) start--;
      return value.slice(start);
    }
  }
  return "";
}

function formatScalar(value: Exclude<YamlValue, string[]>): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function indentOf(line: string): string {
  return /^[ ]*/.exec(line)?.[0] ?? "";
}

function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

function deepMerge(dst: Record<string, unknown>, src: Record<string, Record<string, YamlValue>>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...dst };
  for (const [section, values] of Object.entries(src)) {
    const existing = isMapping(out[section]) ? { ...(out[section] as Record<string, unknown>) } : {};
    for (const [k, v] of Object.entries(values)) {
      existing[k] = Array.isArray(v) ? [...v] : v;
    }
    out[section] = existing;
  }
  return out;
}

function readYamlMapping(file: string): Record<string, unknown> {
  try {
    const parsed = yaml.load(fs.readFileSync(file, "utf8"));
    return isMapping(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readOptionalFile(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function isMapping(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function asMapping(value: unknown): Record<string, unknown> {
  return isMapping(value) ? value : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "").trim()).filter(Boolean);
}

function cleanList(raw: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const cleaned = item.replace(/[\r\n\t]+/g, " ").trim().slice(0, maxLen);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= maxItems) break;
  }
  return out;
}

function cleanScalar(raw: unknown, maxLen: number): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\r\n\t]+/g, " ").trim().slice(0, maxLen);
}

function cleanWorkModes(raw: unknown): WorkMode[] {
  if (!Array.isArray(raw)) return [];
  const set = new Set<WorkMode>();
  for (const item of raw) {
    if (item === "remote" || item === "hybrid" || item === "onsite") set.add(item);
  }
  return ALL_WORK_MODES.filter((m) => set.has(m));
}
