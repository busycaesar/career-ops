/**
 * A Greenhouse job's own labels (title, employer name, location) from the
 * public job-board API. Employer careers pages that embed Greenhouse often
 * title their page generically ("Job Application - NetBrain") or not at all,
 * while the API names the job and the company exactly.
 */
export async function readGreenhouseLabels(job: GreenhouseJobRef): Promise<GreenhouseLabels | null> {
  try {
    const response = await fetch(`${GREENHOUSE_API}/${encodeURIComponent(job.board)}/jobs/${encodeURIComponent(job.id)}`, {
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { title?: unknown; company_name?: unknown; location?: { name?: unknown } };
    // "Toronto, ON | Hybrid": a pipe would split the inbox line's columns.
    const location = typeof body.location?.name === "string" ? body.location.name.replace(/\s*\|\s*/g, " · ").trim() : "";
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const company = typeof body.company_name === "string" ? body.company_name.trim() : "";
    if (!title && !company) return null;
    return { role: stripLocationSuffix(title, location), company, location };
  } catch {
    return null;
  }
}

/** The board and job id of a Greenhouse embed URL (`…/embed/job_app?for={board}&token={id}`). */
export function greenhouseJobFromEmbedUrl(url: string): GreenhouseJobRef | null {
  try {
    const { hostname, pathname, searchParams } = new URL(url);
    if (!hostname.endsWith("greenhouse.io") || !pathname.includes("/embed/")) return null;
    const board = searchParams.get("for");
    const id = searchParams.get("token");
    return board && id && JOB_ID.test(id) ? { board, id } : null;
  } catch {
    return null;
  }
}

/** The board a careers page's Greenhouse embed script names (`…?for={board}`), from the page's HTML. */
export function greenhouseBoardFromHtml(html: string): string | null {
  return html.match(BOARD_IN_HTML)?.[1] ?? null;
}

/**
 * Greenhouse titles often repeat the location ("AI Engineer (R&D) - Canada");
 * the trailing part is dropped only when the job's own location names it.
 */
export function stripLocationSuffix(title: string, location: string): string {
  const match = title.match(TRAILING_DASH_PART);
  if (!match || !location) return title;
  const suffix = match[1].toLowerCase();
  return location.toLowerCase().includes(suffix) ? title.slice(0, match.index).trim() : title;
}

export type GreenhouseJobRef = { board: string; id: string };
export type GreenhouseLabels = { role: string; company: string; location: string };

const GREENHOUSE_API = "https://boards-api.greenhouse.io/v1/boards";
const API_TIMEOUT_MS = 15_000;
const JOB_ID = /^\d{5,12}$/;
const BOARD_IN_HTML = /greenhouse\.io\/embed\/job_(?:board|app)(?:\/js)?\?(?:[^"'\s]*?&(?:amp;)?)?for=([A-Za-z0-9_-]+)/;
const TRAILING_DASH_PART = /\s+[-–—]\s+([^-–—]+)$/;
