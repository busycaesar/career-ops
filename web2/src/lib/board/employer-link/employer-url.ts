import { isThirdPartyPosting } from "@/lib/board/third-party";
import { pageNamesRole } from "@/lib/board/employer-link/job-match";

/**
 * The employer's link behind a job site's Apply link: the target a redirect
 * parameter carries, else wherever the link redirects to. Null when it ends on
 * another job site or does not answer.
 */
export async function employerUrlFromApplyLink(href: string): Promise<string | null> {
  const target = redirectTarget(href) ?? href;
  const landed = (await finalUrl(target)) ?? (target === href ? null : target);
  if (!landed || (await isThirdPartyPosting(landed))) return null;
  return withoutTracking(landed);
}

export type EmployerUrlVerification = { ok: true } | { ok: false; reason: string };

/**
 * Accept a link only if it is on an employer host, answers, and its page
 * names the role. The check reads the page's HTML; a job page rendered only in
 * the browser still carries the title in its <title> or meta tags.
 */
export async function verifyEmployerUrl(url: string, role: string): Promise<boolean> {
  return (await verifyEmployerUrlWithReason(url, role)).ok;
}

export async function verifyEmployerUrlWithReason(url: string, role: string): Promise<EmployerUrlVerification> {
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, reason: "Candidate link was not a valid web URL." };
  }
  const host = safeHost(url);
  if (await isThirdPartyPosting(url)) {
    return { ok: false, reason: `Only found on a third-party job site (${host}), not the employer's own site.` };
  }
  const fetched = await fetchHtml(url);
  if (!fetched.ok) {
    if (fetched.status === 404 || fetched.status === 410) {
      return { ok: false, reason: `Candidate link on ${host} returned HTTP ${fetched.status} (posting may be closed or moved).` };
    }
    if (fetched.status === 401 || fetched.status === 403 || fetched.status === 429) {
      return { ok: false, reason: `${host} blocked automated verification (HTTP ${fetched.status}).` };
    }
    if (fetched.status) {
      return { ok: false, reason: `Candidate link on ${host} returned HTTP ${fetched.status}.` };
    }
    return { ok: false, reason: `${host} did not respond during verification.` };
  }
  if (!pageNamesRole(fetched.html, role)) {
    return {
      ok: false,
      reason: `Found a page on ${host}, but its HTML didn't include the role title (may be JS-rendered or a different/closed role).`,
    };
  }
  return { ok: true };
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Drops click-tracking parameters, keeping the ones that identify the job (gh_jid, ashby_jid, jobId, …). */
export function withoutTracking(url: string): string {
  const parsed = new URL(url);
  for (const name of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAM.test(name)) parsed.searchParams.delete(name);
  }
  return parsed.href;
}

function redirectTarget(href: string): string | null {
  try {
    const { searchParams } = new URL(href);
    for (const name of REDIRECT_PARAMS) {
      const value = searchParams.get(name);
      if (value && /^https?:\/\//i.test(value)) return value;
    }
    return null;
  } catch {
    return null;
  }
}

async function finalUrl(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { "User-Agent": USER_AGENT } });
    await response.body?.cancel();
    return response.ok ? response.url : null;
  } catch {
    return null;
  }
}

async function fetchHtml(url: string): Promise<{ ok: true; html: string } | { ok: false; status?: number }> {
  try {
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { "User-Agent": USER_AGENT } });
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, status: response.status };
    }
    return { ok: true, html: await response.text() };
  } catch {
    return { ok: false };
  }
}

const REDIRECT_PARAMS = ["url", "dest", "redirect", "target", "u"];
const TRACKING_PARAM = /^(?:utm_.*|gh_src|lever-source|lever-origin|source|src|ref|refid|referrer|trk|trackingid|tracking_id|iis|iisn|codes|ccuid|fbclid|gclid|mc_.*)$/i;
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
