import { chromium } from "playwright-core";

/**
 * The job text of a public LinkedIn posting, read once in a fresh headless
 * browser. The evaluate agent runs headless with no browser, and the AGENTS.md
 * LinkedIn guard forbids reaching LinkedIn any other way, so the board makes
 * the one browser attempt the guard allows and hands the text to the agent.
 *
 * One navigation, one wait of at most 5 seconds, no reload or retry. Returns
 * null when no real job description is on the page (login wall, skeleton,
 * removed posting), so the caller can ask the user for the text instead.
 */
export async function readLinkedInJd(url: string): Promise<LinkedInJd | null> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(jobViewUrl(url), { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
    const description = page.locator(DESCRIPTION_SELECTOR).first();
    await description.waitFor({ state: "attached", timeout: DESCRIPTION_WAIT_MS }).catch(() => undefined);
    const text = (await description.innerText({ timeout: DESCRIPTION_WAIT_MS }).catch(() => "")).trim();
    if (text.length < MIN_JD_CHARS) return null;
    const title = (await page.title()).replace(LINKEDIN_TITLE_SUFFIX, "").trim();
    const dom = await page
      .evaluate(() => {
        const pick = (selector: string) => document.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() ?? "";
        // The guest view usually hides an off-site Apply link behind a sign-in
        // modal; when the page does carry it, it is one of these.
        const applyHref =
          document.querySelector<HTMLAnchorElement>('a[href*="externalApply"]')?.href ??
          document.querySelector("code#applyUrl")?.innerHTML.match(/https?:[^"<\s]+/)?.[0] ??
          "";
        return {
          role: pick(".top-card-layout__title, h1.topcard__title, h1"),
          company: pick(".topcard__org-name-link, .top-card-layout__second-subline a"),
          location: pick(".topcard__flavor--bullet"),
          applyHref,
        };
      })
      .catch(() => ({ role: "", company: "", location: "", applyHref: "" }));
    return { title, text, ...dom };
  } finally {
    await browser.close();
  }
}

/** True for a LinkedIn job posting link, the only kind read this way. */
export function isLinkedInJobUrl(url: string): boolean {
  try {
    const { hostname, pathname, searchParams } = new URL(url);
    const isLinkedIn = hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");
    return isLinkedIn && (pathname.startsWith("/jobs/view/") || searchParams.has("currentJobId"));
  } catch {
    return false;
  }
}

/**
 * A search-results link (?currentJobId=…) renders a job list, not the job, so
 * it is read through the posting's own /jobs/view/ page.
 */
function jobViewUrl(url: string): string {
  const jobId = new URL(url).searchParams.get("currentJobId");
  return jobId ? `https://www.linkedin.com/jobs/view/${encodeURIComponent(jobId)}/` : url;
}

export type LinkedInJd = { title: string; text: string; role?: string; company?: string; location?: string; applyHref?: string };

const DESCRIPTION_SELECTOR = ".show-more-less-html__markup, .description__text";
const LINKEDIN_TITLE_SUFFIX = /\s*\|\s*LinkedIn.*$/i;
const NAVIGATION_TIMEOUT_MS = 30_000;
const DESCRIPTION_WAIT_MS = 5_000;
// A real job description is thousands of characters; a login wall or a
// "this job is no longer available" panel is a few hundred at most.
const MIN_JD_CHARS = 300;
