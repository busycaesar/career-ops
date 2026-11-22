import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as yaml from "js-yaml";
import { careerOpsRoot } from "@/lib/career-ops";
import { resolveCodeRoot } from "@/lib/core/code-root.mjs";
import { titleMatches } from "@/lib/board/employer-link/job-match";

/**
 * Looks for the job on the company's own public ATS board, through the same
 * provider modules scan.mjs uses (providers/*.mjs in the checkout), so the
 * boards are read the way the scanner reads them. The company's portals.yml
 * entry is tried first; then the common ATS boards under slugs made from the
 * company name. Only an exact title match is taken, and only when it is the
 * one job with that title (or the one in the posting's location).
 */
export async function findOnAtsBoards(posting: PostingIdentity): Promise<string | null> {
  if (!posting.company || !posting.role) return null;
  for (const entry of [...portalsEntries(posting.company), ...slugEntries(posting.company)]) {
    const url = await matchOnBoard(entry, posting);
    if (url) return url;
  }
  return null;
}

export type PostingIdentity = { company: string; role: string; location: string };

type BoardEntry = { name: string; careers_url: string; provider?: { id: string } | string; [key: string]: unknown };
type Job = { title: string; url: string; location?: string };
type Provider = { id: string; detect?: (entry: BoardEntry) => unknown; fetch: (entry: BoardEntry, ctx: unknown) => Promise<Job[]> };

async function matchOnBoard(entry: BoardEntry, posting: PostingIdentity): Promise<string | null> {
  const provider = await providerFor(entry);
  if (!provider) return null;
  let jobs: Job[];
  try {
    jobs = (await provider.fetch(entry, await httpContext())) ?? [];
  } catch {
    // A slug that is not a board answers 404: that board just isn't this company's.
    return null;
  }
  const sameTitle = jobs.filter((job) => job.url && titleMatches(job.title, posting.role));
  if (sameTitle.length === 1) return sameTitle[0].url;
  const inLocation = sameTitle.filter((job) => locationOverlaps(job.location ?? "", posting.location));
  return inLocation.length === 1 ? inLocation[0].url : null;
}

/** The user's own portals.yml entries for this company, matched by normalised name. */
function portalsEntries(company: string): BoardEntry[] {
  const file = path.join(careerOpsRoot(), "portals.yml");
  if (!fs.existsSync(file)) return [];
  const config = yaml.load(fs.readFileSync(file, "utf8")) as { tracked_companies?: BoardEntry[] } | null;
  const wanted = companyKey(company);
  return (config?.tracked_companies ?? []).filter((entry) => entry?.careers_url && companyKey(entry.name ?? "") === wanted);
}

/** One entry per common ATS, under each slug the company name suggests. */
function slugEntries(company: string): BoardEntry[] {
  return companySlugs(company).flatMap((slug) => ATS_BOARD_URLS.map((boardUrl) => ({ name: company, careers_url: boardUrl(slug) })));
}

function companySlugs(company: string): string[] {
  const words = companyKey(company).split(" ").filter(Boolean);
  if (!words.length) return [];
  // "Safe Software" runs its board as "safe": also try the name without trailing generic words.
  const core = [...words];
  while (core.length > 1 && GENERIC_NAME_WORDS.has(core[core.length - 1])) core.pop();
  return [...new Set([words.join(""), words.join("-"), core.join(""), core.join("-")])];
}

function companyKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((word) => word && !LEGAL_SUFFIXES.has(word))
    .join(" ");
}

function locationOverlaps(jobLocation: string, postingLocation: string): boolean {
  const jobWords = new Set(jobLocation.toLowerCase().match(/[a-z]{3,}/g) ?? []);
  return (postingLocation.toLowerCase().match(/[a-z]{3,}/g) ?? []).some((word) => jobWords.has(word));
}

let providersByFile: Map<string, Promise<Provider | null>> | null = null;
let allProviders: Promise<Map<string, Provider>> | null = null;

/** The provider a slug entry was built for, else the one the core registry picks for a portals.yml entry. */
async function providerFor(entry: BoardEntry): Promise<Provider | null> {
  const ownFile = ATS_PROVIDER_FILES.find((file) => entry.careers_url.includes(FILE_HOSTS[file]));
  if (ownFile && !entry.provider) return loadProviderFile(ownFile);
  const registry = await coreModule<{ resolveProvider: (entry: BoardEntry, providers: Map<string, Provider>) => { provider: Provider } | null }>(
    "providers/_registry.mjs",
  );
  return registry.resolveProvider(entry, await loadAllProviders())?.provider ?? null;
}

function loadProviderFile(file: string): Promise<Provider | null> {
  providersByFile ??= new Map();
  if (!providersByFile.has(file)) {
    providersByFile.set(
      file,
      coreModule<{ default?: Provider }>(`providers/${file}`).then((mod) => mod.default ?? null),
    );
  }
  return providersByFile.get(file)!;
}

function loadAllProviders(): Promise<Map<string, Provider>> {
  allProviders ??= coreModule<{ loadProviders: (dir: string) => Promise<Map<string, Provider>> }>("providers/_registry.mjs").then((registry) =>
    registry.loadProviders(path.join(codeRoot(), "providers")),
  );
  return allProviders;
}

async function httpContext(): Promise<unknown> {
  const http = await coreModule<{ makeHttpCtx: () => Record<string, unknown> }>("providers/_http.mjs");
  return { ...http.makeHttpCtx(), maxPages: MAX_BOARD_PAGES };
}

function coreModule<T>(relativePath: string): Promise<T> {
  return import(/* webpackIgnore: true */ pathToFileURL(path.join(codeRoot(), relativePath)).href) as Promise<T>;
}

function codeRoot(): string {
  return resolveCodeRoot(process.cwd(), process.env);
}

const ATS_BOARD_URLS: ((slug: string) => string)[] = [
  (slug) => `https://job-boards.greenhouse.io/${slug}`,
  (slug) => `https://jobs.lever.co/${slug}`,
  (slug) => `https://jobs.ashbyhq.com/${slug}`,
  (slug) => `https://apply.workable.com/${slug}/`,
  (slug) => `https://jobs.smartrecruiters.com/${slug}`,
  (slug) => `https://${slug}.recruitee.com/`,
];
const ATS_PROVIDER_FILES = ["greenhouse.mjs", "lever.mjs", "ashby.mjs", "workable.mjs", "smartrecruiters.mjs", "recruitee.mjs"];
const FILE_HOSTS: Record<string, string> = {
  "greenhouse.mjs": "greenhouse.io",
  "lever.mjs": "lever.co",
  "ashby.mjs": "ashbyhq.com",
  "workable.mjs": "workable.com",
  "smartrecruiters.mjs": "smartrecruiters.com",
  "recruitee.mjs": "recruitee.com",
};
const LEGAL_SUFFIXES = new Set(["inc", "llc", "ltd", "limited", "corp", "corporation", "co", "gmbh", "plc", "sa", "ag"]);
const GENERIC_NAME_WORDS = new Set(["software", "technologies", "technology", "tech", "labs", "systems", "solutions", "group", "holdings", "hq", "io", "ai", "inc"]);
const MAX_BOARD_PAGES = 5;
