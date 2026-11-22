import { greenhouseBoardFromHtml, readGreenhouseLabels, type GreenhouseJobRef, type GreenhouseLabels } from "@/lib/board/greenhouse-job";

/**
 * Employer careers pages that show an ATS job inside their own page, through a
 * query parameter (?ashby_jid=, ?gh_jid=). The parameter names the job but not
 * the ATS board; the board is in the page's own HTML (the embed script's URL),
 * so one plain fetch of the page turns the link into the ATS's own links.
 */

/**
 * The page where the job's application form itself is, for an embedded-ATS
 * link: Ashby's `/application` page, or the Greenhouse job page (its form is on
 * the job page). Null for any other link, or when the board can't be found.
 */
export async function embeddedApplicationUrl(url: string): Promise<string | null> {
  const ashbyJob = await resolveEmbeddedAtsUrl(url);
  if (ashbyJob) return `${ashbyJob}/application`;
  const greenhouseJob = await embeddedGreenhouseJob(url);
  return greenhouseJob ? `${GREENHOUSE_JOB_PAGE}/${greenhouseJob.board}/jobs/${greenhouseJob.id}` : null;
}

/** The job's own Ashby link for a careers page that shows it through ?ashby_jid=. */
export async function resolveEmbeddedAtsUrl(url: string): Promise<string | null> {
  const jobId = embeddedJobParam(url, "ashby_jid");
  if (!jobId || !ASHBY_JOB_ID.test(jobId)) return null;
  const html = await fetchPageHtml(url);
  const org = html?.match(ASHBY_BOARD_IN_HTML)?.[1];
  return org ? `https://jobs.ashbyhq.com/${org}/${jobId}` : null;
}

/** The Greenhouse job's exact labels for a careers page that shows it through ?gh_jid=. */
export async function embeddedGreenhouseLabels(url: string): Promise<GreenhouseLabels | null> {
  const job = await embeddedGreenhouseJob(url);
  return job ? readGreenhouseLabels(job) : null;
}

export function hasEmbeddedJobParam(url: string): boolean {
  return EMBEDDED_JOB_PARAMS.some((param) => embeddedJobParam(url, param) !== null);
}

export async function fetchPageHtml(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS), headers: { "User-Agent": PAGE_FETCH_USER_AGENT } });
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  }
}

async function embeddedGreenhouseJob(url: string): Promise<GreenhouseJobRef | null> {
  const id = embeddedJobParam(url, "gh_jid");
  if (!id) return null;
  const html = await fetchPageHtml(url);
  const board = html ? greenhouseBoardFromHtml(html) : null;
  return board ? { board, id } : null;
}

function embeddedJobParam(url: string, param: string): string | null {
  try {
    return new URL(url).searchParams.get(param);
  } catch {
    return null;
  }
}

const ASHBY_BOARD_IN_HTML = /jobs\.ashbyhq\.com\/([A-Za-z0-9._%-]+)/;
const ASHBY_JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMBEDDED_JOB_PARAMS = ["ashby_jid", "gh_jid"];
const GREENHOUSE_JOB_PAGE = "https://job-boards.greenhouse.io";
const PAGE_FETCH_TIMEOUT_MS = 15_000;
const PAGE_FETCH_USER_AGENT = "Mozilla/5.0 (career-ops web2)";
