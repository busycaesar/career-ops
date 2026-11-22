import { readInbox } from "@/lib/career-ops";
import { savePostingToPipeline } from "@/lib/pipeline-writer";
import { canonicalJobKey } from "@/lib/core/url-key.mjs";
import { readPosting, unreadablePostingMessage, type PostingRead } from "@/lib/board/read-posting";
import { findJdBySourceUrl, readSavedJd, writeSavedJd, type SavedJd } from "@/lib/board/saved-jd";
import { isThirdPartyPosting } from "@/lib/board/third-party";
import { startEmployerLinkRun } from "@/lib/board/employer-link/start";
import { parsePostingInput, pastedRefFor, roleAndCompanyFromText } from "@/lib/board/posting-input";
import { withExtensionCors } from "@/lib/extension-cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CONCURRENT_READS = 3;

export type BatchPipelineItem = {
  url: string;
  status: "saved" | "duplicate" | "error";
  role?: string;
  company?: string;
  error?: string;
};

/**
 * Save one or more jobs to the inbox with their job descriptions, so cards
 * arrive in Interested with descriptions already saved. The Discover box takes
 * one or more posting links (one per line, read here), a link with the job text
 * pasted under it (for postings whose page hides the text, such as some LinkedIn
 * jobs), or the job text alone. A link whose description cannot be read is not
 * saved: the user is still on the page and can paste the text instead.
 */
export async function OPTIONS(request: Request) {
  return withExtensionCors(request, new Response(null, { status: 204 }));
}

export async function POST(request: Request) {
  const response = await handlePost(request);
  return withExtensionCors(request, response);
}

async function handlePost(request: Request): Promise<Response> {
  const body = await request.json().catch(() => null);
  const input = parsePostingInput(body?.input ?? body?.url);
  switch (input.kind) {
    case "invalid":
      return Response.json({ error: input.error }, { status: 400 });
    case "link": {
      if (findJdBySourceUrl(input.url)) return Response.json({ saved: false, duplicate: true });
      const posting = await readPosting(input.url);
      if (!posting) return Response.json({ error: unreadablePostingMessage(input.url) }, { status: 422 });
      return saveJobResponse({ url: input.url, readAt: now(), ...posting });
    }
    case "links":
      return saveLinksBatch(input.urls);
    case "link-and-text":
      if (findJdBySourceUrl(input.url)) return Response.json({ saved: false, duplicate: true });
      return saveJobResponse(pastedJd(input.url, input.text));
    case "text": {
      const ref = pastedRefFor(input.text);
      if (readInbox().some((job) => job.url === ref)) return Response.json({ saved: false, duplicate: true });
      return saveJobResponse(pastedJd(ref, input.text));
    }
  }
}

async function saveLinksBatch(urls: string[]): Promise<Response> {
  const seen = new Set<string>();
  const uniqueIndices: number[] = [];
  const results: (BatchPipelineItem | null)[] = urls.map((url, idx) => {
    const key = canonicalJobKey(url) || url;
    if (seen.has(key) || findJdBySourceUrl(url)) return { url, status: "duplicate" };
    seen.add(key);
    uniqueIndices.push(idx);
    return null;
  });

  // Read postings with bounded concurrency so multiple links finish quickly
  // without spawning too many browsers at once.
  const fetched = new Map<number, PostingRead | null>();
  await runWithConcurrency(uniqueIndices, MAX_CONCURRENT_READS, async (idx) => {
    fetched.set(idx, await readPosting(urls[idx]));
  });

  // Persist sequentially so pipeline.md writes never contend on the file lock.
  for (const idx of uniqueIndices) {
    const url = urls[idx];
    const posting = fetched.get(idx);
    if (!posting) {
      results[idx] = { url, status: "error", error: unreadablePostingMessage(url) };
      continue;
    }
    const saved = await persistJob({ url, readAt: now(), ...posting });
    if (saved.error) {
      results[idx] = { url, status: "error", error: saved.error };
    } else if (saved.duplicate) {
      results[idx] = { url, status: "duplicate", role: posting.role, company: posting.company };
    } else {
      results[idx] = { url, status: "saved", role: posting.role, company: posting.company };
    }
  }

  const finalResults = results.filter((item): item is BatchPipelineItem => item !== null);
  const savedCount = finalResults.filter((item) => item.status === "saved").length;
  const duplicateCount = finalResults.filter((item) => item.status === "duplicate").length;
  const failedCount = finalResults.filter((item) => item.status === "error").length;

  return Response.json({
    batch: true,
    results: finalResults,
    savedCount,
    duplicateCount,
    failedCount,
  });
}

async function persistJob(jd: SavedJd): Promise<{ saved: boolean; duplicate: boolean; error?: string }> {
  // Re-saving an employer link keeps the third-party link it replaced, so that link stays a duplicate.
  writeSavedJd({ ...jd, sourceUrl: jd.sourceUrl ?? readSavedJd(jd.url)?.sourceUrl });
  const result = await savePostingToPipeline(jd.url, { company: jd.company, role: jd.role, location: jd.location });
  if (result.saved && (await isThirdPartyPosting(jd.url))) startEmployerLinkRun(canonicalJobKey(jd.url) || jd.url, jd.url, jd.company);
  return result;
}

async function saveJobResponse(jd: SavedJd): Promise<Response> {
  const result = await persistJob(jd);
  if (result.error) return Response.json({ error: result.error }, { status: 500 });
  return Response.json({ ...result, role: jd.role, company: jd.company, savedJd: readSavedJd(jd.url) !== null });
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const current = items[cursor++];
      await worker(current);
    }
  });
  await Promise.all(workers);
}

function pastedJd(url: string, text: string): SavedJd {
  return { url, title: "", ...roleAndCompanyFromText(text), location: "", readAt: now(), source: "pasted", text };
}

function now(): string {
  return new Date().toISOString();
}
