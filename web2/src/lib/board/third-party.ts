import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveCodeRoot } from "@/lib/core/code-root.mjs";

/**
 * Whether a link points at a third-party job site (LinkedIn, Indeed, Glassdoor,
 * …) rather than the employer's own careers page or ATS. The core's aggregator
 * list (url-key.mjs isAggregatorUrl, shared with scan.mjs) decides first; the
 * supplement below adds job sites that list other companies' jobs but are not
 * on that list yet, matched on any of their country domains.
 */
export async function isThirdPartyPosting(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (isSupplementThirdParty(parsed)) return true;
  const { isAggregatorUrl } = await coreUrlKey();
  return isAggregatorUrl(url);
}

/** Synchronous check for a host that is certainly a job site, for links found on pages. */
export function isKnownJobSiteHost(hostname: string): boolean {
  return JOB_SITE_NAMES.has(registrableName(hostname));
}

/** "glassdoor" for www.glassdoor.co.uk, "jobbank" for www.jobbank.gc.ca. */
function registrableName(hostname: string): string {
  const labels = hostname.toLowerCase().replace(/\.$/, "").split(".");
  if (labels.length < 2) return labels[0] ?? "";
  const beforeTld = labels[labels.length - 2];
  return SECOND_LEVEL_SUFFIXES.has(beforeTld) && labels.length >= 3 ? labels[labels.length - 3] : beforeTld;
}

function isSupplementThirdParty(url: URL): boolean {
  if (isKnownJobSiteHost(url.hostname)) return true;
  // Jobgether lists partner companies' jobs on its own Lever board.
  const firstSegment = url.pathname.split("/").filter(Boolean)[0]?.toLowerCase() ?? "";
  return url.hostname.toLowerCase() === "jobs.lever.co" && LEVER_AGGREGATOR_BOARDS.has(firstSegment);
}

type CoreUrlKey = { isAggregatorUrl: (url: string) => boolean };

let coreUrlKeyModule: Promise<CoreUrlKey> | null = null;

function coreUrlKey(): Promise<CoreUrlKey> {
  if (!coreUrlKeyModule) {
    const file = path.join(resolveCodeRoot(process.cwd(), process.env), "url-key.mjs");
    coreUrlKeyModule = import(/* webpackIgnore: true */ pathToFileURL(file).href) as Promise<CoreUrlKey>;
  }
  return coreUrlKeyModule;
}

// Registrable names (any TLD) of sites that repost other employers' jobs.
const JOB_SITE_NAMES = new Set([
  "linkedin",
  "indeed",
  "glassdoor",
  "ziprecruiter",
  "wellfound",
  "jobgether",
  "builtin",
  "monster",
  "simplyhired",
  "workopolis",
  "eluta",
  "jobbank",
  "talent",
  "careerjet",
  "jooble",
  "adzuna",
  "dice",
]);
const LEVER_AGGREGATOR_BOARDS = new Set(["jobgether"]);
const SECOND_LEVEL_SUFFIXES = new Set(["co", "com", "gc", "org", "net", "ac"]);
