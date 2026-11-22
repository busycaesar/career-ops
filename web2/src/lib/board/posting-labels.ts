import { roleAndCompanyFromText } from "@/lib/board/posting-input";
import type { SavedJd } from "@/lib/board/saved-jd";

export type PostingMeta = { role: string; company: string; location: string };

export type PostingLabelSources = {
  url?: string;
  title?: string;
  ogTitle?: string;
  ogSiteName?: string;
  h1?: string;
  jsonLdScripts?: string[];
  text?: string;
};

/**
 * Extract role, company, and location from a posting page's structured signals
 * (JSON-LD JobPosting, page title, og:site_name, heading, and description text).
 * Conservative by design: generic site headings ("Careers", "Jobs", ATS names)
 * are discarded rather than promoted into fake roles or employers.
 */
export function extractPostingLabels(sources: PostingLabelSources): PostingMeta {
  const fromJsonLd = parseJobPostingJsonLd(sources.jsonLdScripts ?? []);
  const ogSiteName = cleanCompanyCandidate(sources.ogSiteName ?? "");
  const fromTitle = splitBrowserTitle(sources.title ?? "", { url: sources.url, ogSiteName });
  const fromOgTitle = splitBrowserTitle(sources.ogTitle ?? "", { url: sources.url, ogSiteName });
  const fromText = sources.text ? roleAndCompanyFromText(sources.text) : { role: "", company: "" };
  const textCompany = sources.text ? companyFromText(sources.text, sources.url) : "";
  const h1Role = cleanRoleCandidate(sources.h1 ?? "");

  const company =
    fromJsonLd.company ||
    fromTitle.company ||
    fromOgTitle.company ||
    ogSiteName ||
    cleanCompanyCandidate(fromText.company) ||
    textCompany;

  const usableH1 = h1Role && !sameFolded(h1Role, company) ? h1Role : "";
  const role =
    fromJsonLd.role ||
    fromTitle.role ||
    fromOgTitle.role ||
    usableH1 ||
    cleanRoleCandidate(fromText.role);

  const location =
    fromJsonLd.location ||
    fromTitle.location ||
    fromOgTitle.location ||
    (sources.text ? locationFromText(sources.text) : "");

  return { role, company, location };
}

/**
 * Derive missing role, company, or location from an already-saved JD file
 * (for example, postings saved before browser metadata extraction existed).
 */
export function inferLabelsFromSavedJd(
  saved: Pick<SavedJd, "url" | "title" | "role" | "company" | "location" | "text">,
): PostingMeta {
  if (saved.role && saved.company && saved.location) {
    return { role: saved.role, company: saved.company, location: saved.location };
  }
  const inferred = extractPostingLabels({ url: saved.url, title: saved.title, text: saved.text });
  return {
    role: saved.role || inferred.role,
    company: saved.company || inferred.company,
    location: saved.location || inferred.location,
  };
}

/** Parse schema.org JobPosting JSON-LD blocks when a career page embeds them. */
export function parseJobPostingJsonLd(scripts: string[]): PostingMeta {
  for (const raw of scripts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const posting = findJobPostingNode(parsed);
    if (!posting) continue;
    const role = cleanRoleCandidate(stringField(posting.title));
    const org = posting.hiringOrganization;
    const rawCompany =
      typeof org === "string"
        ? org
        : org && typeof org === "object"
          ? stringField((org as Record<string, unknown>).name)
          : "";
    const company = cleanCompanyCandidate(rawCompany);
    const location = jsonLdLocation(posting);
    if (role || company || location) return { role, company, location };
  }
  return { role: "", company: "", location: "" };
}

/**
 * Parse a posting page's `<title>` into role, company, and optional location.
 * Handles common patterns:
 * - "Cloud, Automation & AI Engineer Consultant Job Details | Deloitte"
 * - "Deloitte | Cloud, Automation & AI Engineer Consultant"
 * - "Job Application for Senior Engineer at Acme"
 * - "Senior Engineer at Acme — Toronto, ON"
 * - "Acme hiring Senior Engineer in Toronto, ON"
 * - "Senior Engineer @ Acme"
 */
export function splitBrowserTitle(rawTitle: string, opts: { url?: string; ogSiteName?: string } = {}): PostingMeta {
  const title = normalizeSpace(decodeHtmlEntities(rawTitle));
  if (!title || GENERIC_ROLE_ONLY.test(title) || GENERIC_COMPANY_ONLY.test(title)) {
    return { role: "", company: "", location: "" };
  }

  const withoutAppPrefix = title.replace(APPLICATION_PREFIX, "").trim();

  const hiring = withoutAppPrefix.match(HIRING_TITLE);
  if (hiring) {
    const company = cleanCompanyCandidate(hiring[1]);
    const role = cleanRoleCandidate(hiring[2]);
    const location = cleanLocationCandidate(hiring[3] ?? "");
    if (role) return { role, company, location };
  }

  const atMatch = withoutAppPrefix.match(AT_TITLE);
  if (atMatch) {
    const role = cleanRoleCandidate(atMatch[1]);
    const company = cleanCompanyCandidate(atMatch[2]);
    const location = cleanLocationCandidate(atMatch[3] ?? "");
    if (role && company) return { role, company, location };
  }

  const atSymbol = withoutAppPrefix.match(AT_SYMBOL_TITLE);
  if (atSymbol) {
    const role = cleanRoleCandidate(atSymbol[1]);
    const company = cleanCompanyCandidate(atSymbol[2]);
    if (role && company) return { role, company, location: "" };
  }

  const strongParts = withoutAppPrefix.split(STRONG_TITLE_SEP).map((part) => part.trim()).filter(Boolean);
  if (strongParts.length >= 2) {
    const parsed = splitSeparatedTitle(strongParts, opts, true);
    if (parsed.role || parsed.company) return parsed;
  }

  // Only split on " - " when one side clearly identifies the employer (brand/site/Careers suffix),
  // so hyphenated job titles like "Senior Engineer - Backend" stay intact.
  const dashParts = withoutAppPrefix.split(DASH_TITLE_SEP).map((part) => part.trim()).filter(Boolean);
  if (dashParts.length >= 2) {
    const parsed = splitSeparatedTitle(dashParts, opts, false);
    if (parsed.company) return parsed;
  }

  return { role: cleanRoleCandidate(withoutAppPrefix), company: "", location: "" };
}

/** Extract a location from labeled header lines ("Primary Location:", "Location(s)\n...") near the top of the JD. */
export function locationFromText(text: string): string {
  const lines = text.split(/\r?\n/).slice(0, LOCATION_SCAN_LINES);
  for (let i = 0; i < lines.length; i++) {
    const line = normalizeSpace(lines[i]);
    if (!line) continue;
    const inline = line.match(LOCATION_LINE);
    if (inline) {
      const candidate = cleanLocationCandidate(inline[1]);
      if (candidate) return candidate;
    }
    if (LOCATION_HEADER_ONLY.test(line)) {
      const next = nextNonEmptyLine(lines, i + 1);
      const candidate = cleanLocationCandidate(next);
      if (candidate) return candidate;
    }
  }
  return "";
}

/**
 * Extract an employer name from explicit cues near the top of a JD when
 * structured metadata didn't supply one:
 * - A two-line "Company\nAcme Corp" header block (e.g. Siemens/SuccessFactors)
 * - An "About {Company}" section heading (preferring one matching the URL's
 *   hostname brand, so "About Ascend" wins over "About Alpine Investors").
 */
export function companyFromText(text: string, url?: string): string {
  const lines = text.split(/\r?\n/).slice(0, COMPANY_SCAN_LINES);
  const brand = hostnameBrand(url);

  for (let i = 0; i < lines.length; i++) {
    const line = normalizeSpace(lines[i]);
    if (!line) continue;
    if (COMPANY_HEADER_ONLY.test(line)) {
      const next = cleanCompanyCandidate(nextNonEmptyLine(lines, i + 1));
      if (next) return next;
    }
  }

  const aboutCandidates: string[] = [];
  for (const rawLine of lines) {
    const line = normalizeSpace(rawLine);
    const match = line.match(ABOUT_COMPANY_HEADING);
    if (!match) continue;
    const rawName = match[1].trim();
    if (GENERIC_ABOUT_SUBJECT.test(rawName)) continue;
    const candidate = cleanCompanyCandidate(rawName);
    if (!candidate) continue;
    if (brand && matchesBrand(candidate, brand)) return candidate;
    aboutCandidates.push(candidate);
  }
  return !brand ? (aboutCandidates[0] ?? "") : "";
}

function nextNonEmptyLine(lines: string[], startIndex: number): string {
  for (let i = startIndex; i < lines.length; i++) {
    const value = normalizeSpace(lines[i]);
    if (value) return value;
  }
  return "";
}

function splitSeparatedTitle(
  parts: string[],
  opts: { url?: string; ogSiteName?: string },
  allowDefaultTrailingCompany: boolean,
): PostingMeta {
  const brand = hostnameBrand(opts.url);
  const ogSite = opts.ogSiteName ? cleanCompanyCandidate(opts.ogSiteName) : "";

  let companyIdx = -1;
  let companyScore = 0;
  for (let i = 0; i < parts.length; i++) {
    const score = scoreCompanySegment(parts[i], brand, ogSite);
    if (score > companyScore || (score > 0 && score === companyScore && i === parts.length - 1)) {
      companyScore = score;
      companyIdx = i;
    }
  }

  if (companyIdx === -1 && allowDefaultTrailingCompany) {
    const lastIdx = parts.length - 1;
    const last = parts[lastIdx];
    const lastCompany = cleanCompanyCandidate(last);
    if (lastCompany && !NON_COMPANY_SEGMENT.test(lastCompany)) {
      companyIdx = lastIdx;
    }
  }

  const company = companyIdx >= 0 ? cleanCompanyCandidate(parts[companyIdx]) : "";
  const remaining = parts
    .filter((_, idx) => idx !== companyIdx)
    .map((part) => ({ raw: part, role: cleanRoleCandidate(part) }))
    .filter((entry) => entry.role && !sameFolded(entry.role, company));

  const roleEntry =
    remaining.find((entry) => ROLE_HINT_SUFFIX.test(entry.raw)) ??
    (companyIdx === 0 ? remaining[remaining.length - 1] : remaining[0]);

  return { role: roleEntry?.role ?? "", company, location: "" };
}

function scoreCompanySegment(segment: string, brand: string, ogSite: string): number {
  const cleaned = cleanCompanyCandidate(segment);
  if (!cleaned) return 0;
  if (ogSite && sameFolded(cleaned, ogSite)) return 4;
  if (brand && matchesBrand(cleaned, brand)) return 3;
  if (COMPANY_SITE_SUFFIX.test(segment) || COMPANY_SITE_PREFIX.test(segment)) return 2;
  return 0;
}

function findJobPostingNode(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJobPostingNode(item);
      if (found) return found;
    }
    return null;
  }
  const obj = value as Record<string, unknown>;
  const rawType = obj["@type"];
  const types = Array.isArray(rawType) ? rawType : [rawType];
  if (types.some((t) => typeof t === "string" && /(?:^|[/:])JobPosting$/i.test(t.trim()))) return obj;
  if (Array.isArray(obj["@graph"])) return findJobPostingNode(obj["@graph"]);
  return null;
}

function jsonLdLocation(posting: Record<string, unknown>): string {
  const locations = Array.isArray(posting.jobLocation)
    ? posting.jobLocation
    : posting.jobLocation
      ? [posting.jobLocation]
      : [];
  const formatted: string[] = [];
  for (const loc of locations) {
    if (!loc || typeof loc !== "object") continue;
    const place = loc as Record<string, unknown>;
    const address = place.address;
    let label = "";
    if (typeof address === "string") {
      label = cleanLocationCandidate(address);
    } else if (address && typeof address === "object") {
      const a = address as Record<string, unknown>;
      const country =
        typeof a.addressCountry === "string"
          ? a.addressCountry
          : a.addressCountry && typeof a.addressCountry === "object"
            ? stringField((a.addressCountry as Record<string, unknown>).name)
            : "";
      label = cleanLocationCandidate(
        [stringField(a.addressLocality), stringField(a.addressRegion), country].filter(Boolean).join(", "),
      );
    } else {
      label = cleanLocationCandidate(stringField(place.name));
    }
    if (label && !formatted.includes(label)) formatted.push(label);
    if (formatted.length >= 3) break;
  }
  if (formatted.length > 0) return formatted.join(" · ");
  if (typeof posting.jobLocationType === "string" && /telecommute/i.test(posting.jobLocationType)) return "Remote";
  return "";
}

function hostnameBrand(url?: string): string {
  if (!url) return "";
  try {
    const labels = new URL(url).hostname.toLowerCase().split(".").filter(Boolean);
    if (labels.length < 2) return "";
    // Strip common country/generic TLDs (e.g. .com, .ca, .co.uk, .com.au) and careers subdomains.
    let end = labels.length - 1;
    if (end >= 2 && SECOND_LEVEL_TLDS.has(labels[end - 1]) && labels[end].length === 2) end -= 1;
    const root = labels[end - 1] ?? "";
    if (KNOWN_ATS_BRANDS.has(root)) return "";
    return root;
  } catch {
    return "";
  }
}

function matchesBrand(candidate: string, brand: string): boolean {
  const foldedCandidate = foldAlnum(candidate);
  const foldedBrand = foldAlnum(brand);
  if (!foldedCandidate || !foldedBrand) return false;
  return foldedCandidate === foldedBrand || foldedCandidate.includes(foldedBrand) || (foldedCandidate.length >= 4 && foldedBrand.includes(foldedCandidate));
}

function cleanRoleCandidate(raw: string): string {
  const value = normalizeSpace(decodeHtmlEntities(raw))
    .replace(APPLICATION_PREFIX, "")
    .replace(ROLE_HINT_SUFFIX, "")
    .replace(TRAILING_PUNCT, "")
    .trim();
  if (value.length < 2 || value.length > 140) return "";
  if (GENERIC_PAGE_TITLE.test(value) || GENERIC_ROLE_ONLY.test(value) || GENERIC_ROLE_PHRASE.test(value)) return "";
  return value;
}

function cleanCompanyCandidate(raw: string): string {
  let value = normalizeSpace(decodeHtmlEntities(raw));
  for (let pass = 0; pass < 2; pass++) {
    value = value
      .replace(COMPANY_SITE_PREFIX, "")
      .replace(COMPANY_SITE_SUFFIX, "")
      .replace(TRAILING_PUNCT, "")
      .trim();
  }
  if (value.length < 2 || value.length > 80) return "";
  if (GENERIC_PAGE_TITLE.test(value) || GENERIC_COMPANY_ONLY.test(value) || KNOWN_ATS_DISPLAY_NAMES.test(value)) return "";
  return value;
}

function cleanLocationCandidate(raw: string): string {
  const value = normalizeSpace(decodeHtmlEntities(raw)).replace(TRAILING_PUNCT, "").trim();
  if (value.length < 2 || value.length > 120) return "";
  return value;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeSpace(value: string): string {
  return value.replace(/[\u00a0\s]+/g, " ").trim();
}

function foldAlnum(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sameFolded(a: string, b: string): boolean {
  const fa = foldAlnum(a);
  const fb = foldAlnum(b);
  return Boolean(fa && fb && fa === fb);
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ");
}

const APPLICATION_PREFIX = /^(?:job\s+application\s+for|apply\s+(?:now\s+)?for|job\s+details?\s*[:\-–—]|job\s+description\s*[:\-–—])\s+/i;
const ROLE_HINT_SUFFIX = /\s*(?:[-–—:|]\s*)?(?:job\s+details?|job\s+description|job\s+opening|job\s+posting|job\s+application|apply\s+now|apply)\s*$/i;
const COMPANY_SITE_PREFIX =
  /^(?:(?:open\s+)?(?:careers?|jobs?|talent|recruiting|hiring|work)\s*(?:marketplace|portal|hub|center|centre|board|site|page|opportunities|community)?\s*(?:at|with|@|[-–—:|])\s+)/i;
const COMPANY_SITE_SUFFIX =
  /\s*(?:[-–—:|]\s*|\s+)(?:careers?(?:\s+(?:marketplace|portal|hub|center|centre|site|page|opportunities))?|jobs?(?:\s+(?:board|portal|site|marketplace|center|centre))?|hiring|recruiting|talent(?:\s+(?:community|portal|hub|marketplace))?|opportunities)\s*$/i;
const TRAILING_PUNCT = /^[\s|\-–—:,]+|[\s|\-–—:,]+$/g;
const STRONG_TITLE_SEP = /\s+[|—–·]\s+/;
const DASH_TITLE_SEP = /\s+-\s+/;
const HIRING_TITLE = /^(.+?)\s+hiring\s+(.+?)(?:\s+in\s+(.+?))?$/i;
const AT_TITLE = /^(.+?)\s+at\s+([^|—–]+?)(?:\s+[—–]\s+(.+))?$/i;
const AT_SYMBOL_TITLE = /^(.+?)\s+@\s+([^|@]+)$/;
const GENERIC_PAGE_TITLE =
  /^\s*(?:(?:open\s+)?(?:careers?|jobs?|positions?|roles?|opportunities)|join\s+us|work\s+with\s+us|search\s+jobs|job\s+details?|job\s+description|job\s+application|job\s+search|careers?\s+marketplace|home)\s*(?:[|\-–—:].*)?$/i;
const GENERIC_ROLE_ONLY =
  /^(?:careers?|jobs?|search\s+jobs|job\s+details?|job\s+description|job\s+application|application|overview|about\s+us|apply(?:\s+now)?)$/i;
const GENERIC_COMPANY_ONLY =
  /^(?:careers?(?:\s+(?:marketplace|portal|hub|center|centre|site|page))?|jobs?(?:\s+(?:board|portal|site|marketplace))?|talent(?:\s+(?:portal|hub|marketplace|community))?|hiring|recruiting|job\s+application|application)$/i;
// Page names that are not a job: "Jobs at Acme", "Acme Careers", "Current openings", "Job Application".
const GENERIC_ROLE_PHRASE = /^(?:(?:jobs?|careers?|openings?|opportunities)\s+(?:at|with)\s+.+|.+\s+(?:careers?|jobs?)(?:\s+(?:site|page|portal))?|(?:current|open)\s+(?:openings?|positions?|roles?|jobs?)|(?:job\s+)?application(?:\s+form)?)$/i;
const KNOWN_ATS_DISPLAY_NAMES = /^(?:linkedin|indeed|glassdoor|workday|greenhouse|lever|ashby|icims|taleo|successfactors|smartrecruiters|workable|bamboohr|jobvite|ultipro|ukg|dayforce|brassring|phenom)$/i;
const KNOWN_ATS_BRANDS = new Set([
  "linkedin",
  "indeed",
  "glassdoor",
  "myworkdayjobs",
  "workday",
  "greenhouse",
  "lever",
  "ashbyhq",
  "icims",
  "taleo",
  "successfactors",
  "smartrecruiters",
  "workable",
  "bamboohr",
  "jobvite",
  "dayforcehcm",
  "eightfold",
  "ultipro",
  "breezy",
  "recruitee",
  "jazzhr",
  "rippling",
  "pinpointhq",
  "wellfound",
  "ycombinator",
  "workatastartup",
  "georgian",
]);
const NON_COMPANY_SEGMENT = /^(?:remote|hybrid|on[- ]?site|full[- ]?time|part[- ]?time|contract|permanent|internship|co[- ]?op|canada|united\s+states|usa|uk|europe|global)$/i;
const SECOND_LEVEL_TLDS = new Set(["co", "com", "org", "net", "gov", "edu", "ac"]);
const LOCATION_SCAN_LINES = 40;
const LOCATION_LINE = /^(?:primary\s+|work\s+|job\s+)?location(?:\(s\)|s)?\s*[:\-–—]\s*(.+)$/i;
const LOCATION_HEADER_ONLY = /^(?:primary\s+|work\s+|job\s+)?location(?:\(s\)|s)?\s*:?$/i;
const COMPANY_SCAN_LINES = 40;
const COMPANY_HEADER_ONLY = /^(?:company(?:\s+name)?|employer|hiring\s+organi[sz]ation)\s*:?$/i;
const ABOUT_COMPANY_HEADING = /^(?:About|ABOUT)\s+([A-Z][^\n.!?:]{1,50})$/;
const GENERIC_ABOUT_SUBJECT = /^(?:the|this|our|your|us|you|me|role|team|position|job|opportunity|company|department|organi[sz]ation|this\s+role)\b/i;
