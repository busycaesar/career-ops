import { spawn } from "node:child_process";
import path from "node:path";
import { chromium } from "playwright-core";
import { resolveCodeRoot } from "@/lib/core/code-root.mjs";
import { isLinkedInJobUrl, readLinkedInJd } from "@/lib/board/linkedin-jd";
import { extractPostingLabels, splitBrowserTitle } from "@/lib/board/posting-labels";
import { greenhouseJobFromEmbedUrl, readGreenhouseLabels, type GreenhouseLabels } from "@/lib/board/greenhouse-job";
import { embeddedGreenhouseLabels, fetchPageHtml, hasEmbeddedJobParam, resolveEmbeddedAtsUrl } from "@/lib/board/embedded-ats";
import type { JdSource } from "@/lib/board/saved-jd";
import { isKnownJobSiteHost, isThirdPartyPosting } from "@/lib/board/third-party";

/**
 * Read a posting's job description once, picking the method by link:
 * LinkedIn through its one allowed browser read, a known ATS through the
 * checkout's fetch-jd.mjs (its public API), anything else through one headless
 * browser read of the page. Null when no real description came back, so the
 * caller can tell the user instead of saving a link that cannot be evaluated.
 */
export async function readPosting(url: string): Promise<PostingRead | null> {
  if (isLinkedInJobUrl(url)) return readFromLinkedIn(url);
  const atsUrl = (await resolveEmbeddedAtsUrl(url)) ?? url;
  const fromAts = await readFromAtsApi(atsUrl);
  if (fromAts) return withLabels(fromAts, await embeddedGreenhouseLabels(url));
  // A careers page that names one job through an embed parameter, but whose
  // job could not be read, is the company's job list: saving it would hand the
  // evaluator a landing page instead of the job.
  if (hasEmbeddedJobParam(url)) return null;
  return readFromBrowser(url);
}

/** `applyUrl`: the raw href of an off-site Apply link the page showed, when it showed one (third-party pages only). */
export type PostingRead = { title: string; role: string; company: string; location: string; text: string; source: JdSource; applyUrl?: string };

/** The message shown under the Discover bar when nothing readable came back. */
export function unreadablePostingMessage(url: string): string {
  if (isLinkedInJobUrl(url)) {
    return "LinkedIn didn't show the job text, so the link was not saved. Copy the job description from LinkedIn and paste it here (with the link on the first line).";
  }
  return "Couldn't read a job description at that link (a login wall, an expired posting, or a page that didn't load), so it was not saved. Paste the job description here (with the link on the first line), or the employer's own posting link.";
}

/**
 * LinkedIn titles its job pages "{role} at {company} — {location}" or
 * "{company} hiring {role} in {location}". Anything else falls back to the
 * generic title splitter, leaving unknown fields empty rather than guessing.
 */
export function splitLinkedInTitle(title: string): { role: string; company: string; location: string } {
  const at = title.match(LINKEDIN_TITLE);
  if (at) return { role: at[1].trim(), company: at[2].trim(), location: (at[3] ?? "").trim() };
  const hiring = title.match(LINKEDIN_HIRING_TITLE);
  if (hiring) return { company: hiring[1].trim(), role: hiring[2].trim(), location: (hiring[3] ?? "").trim() };
  return splitBrowserTitle(title);
}

async function readFromLinkedIn(url: string): Promise<PostingRead | null> {
  const jd = await readLinkedInJd(url);
  if (!jd) return null;
  const fromTitle = splitLinkedInTitle(jd.title);
  return {
    title: jd.title,
    role: fromTitle.role || jd.role || "",
    company: fromTitle.company || jd.company || "",
    location: fromTitle.location || jd.location || "",
    text: jd.text,
    source: "linkedin-browser",
    applyUrl: jd.applyHref || undefined,
  };
}

/**
 * fetch-jd.mjs prints the role on its first line and, when the ATS gives one,
 * a "Location:" line; the company comes from the board's own path, or for
 * custom-domain ATS embeds (e.g. ?gh_jid=), from the JD text or page metadata.
 */
async function readFromAtsApi(url: string): Promise<PostingRead | null> {
  const stdout = await runFetchJd(url);
  if (!stdout || stdout.trim().length < MIN_JD_CHARS) return null;
  const text = stdout.trim();
  const role = text.split("\n", 1)[0].trim();
  const location = text.match(ATS_LOCATION_LINE)?.[1].trim() ?? "";
  let company = atsBoardCompany(url) || extractPostingLabels({ url, text }).company;
  if (!company) {
    const html = await fetchPageHtml(url);
    if (html) {
      const ogMatch = html.match(OG_SITE_NAME_IN_HTML);
      const ogSiteName = ogMatch?.[1] ?? ogMatch?.[2] ?? "";
      const pageTitle = html.match(TITLE_IN_HTML)?.[1] ?? "";
      company = extractPostingLabels({ url, title: pageTitle, ogSiteName }).company;
    }
  }
  return { title: role, role, company, location, text, source: "ats-api" };
}

async function readFromBrowser(url: string): Promise<PostingRead | null> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
    await page.waitForLoadState("networkidle", { timeout: SETTLE_WAIT_MS }).catch(() => undefined);
    const main = page.locator(MAIN_CONTENT_SELECTOR).first();
    const text = ((await main.count()) ? await main.innerText() : await page.locator("body").innerText()).trim();
    if (text.length < MIN_JD_CHARS) return null;
    const title = (await page.title()).trim();
    // A page titled only "Careers" or "Jobs" is a job list, not one job.
    if (GENERIC_LISTING_TITLE.test(title)) return null;
    const dom = await page
      .evaluate((mainSelector: string) => {
        const meta = (selector: string) => document.querySelector(selector)?.getAttribute("content")?.trim() ?? "";
        const h1Selector = mainSelector
          .split(",")
          .map((part) => `${part.trim()} h1`)
          .join(", ");
        const genericHeading = /^(?:careers?|jobs?|search\s+jobs|job\s+details?|job\s+description|job\s+application|application|overview|about\s+us|apply(?:\s+now)?)$/i;
        const headingText = (selector: string) =>
          Array.from(document.querySelectorAll(selector))
            .map((node) => node.textContent?.replace(/\s+/g, " ").trim() ?? "")
            .find((text) => text.length >= 2 && text.length <= 140 && !genericHeading.test(text)) ?? "";
        const h1 = headingText(h1Selector) || headingText("h1");
        const jsonLdScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
          .map((node) => node.textContent ?? "")
          .filter(Boolean);
        // A job site's "Apply on company site" link, for finding the employer's posting.
        const applyHrefs = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
          .filter((anchor) => /apply/i.test(anchor.textContent ?? "") || /apply/i.test(anchor.getAttribute("aria-label") ?? ""))
          .map((anchor) => anchor.href);
        return {
          ogTitle: meta('meta[property="og:title"]'),
          ogSiteName: meta('meta[property="og:site_name"]'),
          h1,
          jsonLdScripts,
          applyHrefs,
        };
      }, MAIN_CONTENT_SELECTOR)
      .catch(() => ({ ogTitle: "", ogSiteName: "", h1: "", jsonLdScripts: [] as string[], applyHrefs: [] as string[] }));
    const { applyHrefs, ...pageLabels } = dom;
    const pageGuess = extractPostingLabels({ url, title, text, ...pageLabels });
    const embed = page.frames().map((frame) => greenhouseJobFromEmbedUrl(frame.url())).find(Boolean);
    const labels = embed ? withLabels(pageGuess, await readGreenhouseLabels(embed)) : pageGuess;
    const applyUrl = (await isThirdPartyPosting(url)) ? offSiteApplyHref(applyHrefs, url) : undefined;
    return { title, ...labels, text, source: "browser", applyUrl };
  } catch {
    return null;
  } finally {
    await browser.close();
  }
}

/** The ATS's own labels win over ones guessed from page text; empty ATS fields keep the guess. */
function withLabels<T extends { role: string; company: string; location: string }>(read: T, ats: GreenhouseLabels | null): T {
  if (!ats) return read;
  return { ...read, role: ats.role || read.role, company: ats.company || read.company, location: ats.location || read.location };
}

/** The first Apply link that leaves the job site, or one that carries the target in a redirect parameter. */
function offSiteApplyHref(hrefs: string[], pageUrl: string): string | undefined {
  const pageHost = new URL(pageUrl).hostname;
  return hrefs.find((href) => {
    try {
      const { hostname, pathname, search } = new URL(href);
      return (
        (hostname !== pageHost && !isKnownJobSiteHost(hostname)) ||
        /[?&](?:url|dest|redirect|target)=https?/i.test(search) ||
        APPLY_REDIRECT_PATH.test(pathname)
      );
    } catch {
      return false;
    }
  });
}

function runFetchJd(url: string): Promise<string | null> {
  const codeRoot = resolveCodeRoot(process.cwd(), process.env);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(codeRoot, "fetch-jd.mjs"), url], { cwd: codeRoot, windowsHide: true });
    let stdout = "";
    const timer = setTimeout(() => child.kill(), FETCH_JD_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? stdout : null);
    });
  });
}

/** The company slug an ATS board puts in its path or subdomain, title-cased. */
function atsBoardCompany(url: string): string {
  try {
    const { hostname, pathname } = new URL(url);
    const host = hostname.toLowerCase();
    if (host.endsWith(".myworkdayjobs.com")) {
      return formatSlug(host.split(".")[0] ?? "");
    }
    if (!ATS_HOSTS.some((atsHost) => host === atsHost || host.endsWith(`.${atsHost}`))) return "";
    const slug = pathname.split("/").filter(Boolean)[0] ?? "";
    return formatSlug(slug);
  } catch {
    return "";
  }
}

function formatSlug(slug: string): string {
  return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()).trim();
}

const LINKEDIN_TITLE = /^(.+?)\s+at\s+(.+?)(?:\s+[—–]\s+(.+))?$/;
const LINKEDIN_HIRING_TITLE = /^(.+?)\s+hiring\s+(.+?)(?:\s+in\s+(.+))?$/i;
const ATS_HOSTS = ["ashbyhq.com", "greenhouse.io", "lever.co", "smartrecruiters.com", "workable.com"];
const ATS_LOCATION_LINE = /^Location:\s*(.+)$/m;
const OG_SITE_NAME_IN_HTML = /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i;
const TITLE_IN_HTML = /<title[^>]*>([^<]+)<\/title>/i;
// Job-site paths that redirect to the employer's application (Indeed's applystart, LinkedIn's externalApply).
const APPLY_REDIRECT_PATH = /\/(?:applystart|externalApply|rc\/clk)\b/i;
const GENERIC_LISTING_TITLE = /^\s*(?:(?:open\s+)?(?:careers?|jobs?|positions?|roles?|opportunities)|join\s+us|work\s+with\s+us)\s*(?:[|\-–—:].*)?$/i;
const MAIN_CONTENT_SELECTOR = "main, [role=main], article";
// A real job description is thousands of characters; a login wall or an
// expired-posting notice is a few hundred at most.
const MIN_JD_CHARS = 300;
const NAVIGATION_TIMEOUT_MS = 30_000;
const SETTLE_WAIT_MS = 5_000;
const FETCH_JD_TIMEOUT_MS = 20_000;
