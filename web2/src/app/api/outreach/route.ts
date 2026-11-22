import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { cliUnavailableError } from "@/lib/clis";
import {
  bothModelsLimitedMessage,
  chooseCliWithFallback,
  clearCliCooldown,
  fallbackDisplayName,
  getFallbackCooldowns,
  isUsageLimitError,
  recordCliCooldown,
  resolveFallbackCli,
} from "@/lib/cli-fallback";
import { profileRef } from "@/lib/core/profile-path.mjs";
import { readRememberedCli } from "@/lib/remembered-cli.mjs";
import { runPlanner } from "@/lib/apply/planner";
import { extractPostingLabels, inferLabelsFromSavedJd } from "@/lib/board/posting-labels";
import { parsePostingInput } from "@/lib/board/posting-input";
import { readPosting, unreadablePostingMessage } from "@/lib/board/read-posting";
import { readSavedJd } from "@/lib/board/saved-jd";
import { withExtensionCors } from "@/lib/extension-cors";
import { buildOutreachPrompt, cleanOutreachOutput } from "@/lib/outreach";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

const DEFAULT_CLI = "claude";
const MIN_POSTING_CHARS = 80;

export async function OPTIONS(request: Request) {
  return withExtensionCors(request, new Response(null, { status: 204 }));
}

export async function POST(request: Request) {
  const response = await handlePost(request);
  return withExtensionCors(request, response);
}

async function handlePost(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    url?: unknown;
    text?: unknown;
    input?: unknown;
    cliId?: unknown;
  } | null;
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Send a job link or posting text." }, { status: 400 });
  }

  let url = typeof body.url === "string" ? body.url.trim() : "";
  let text = typeof body.text === "string" ? body.text.trim() : "";

  if (!url && !text && typeof body.input === "string" && body.input.trim()) {
    const parsed = parsePostingInput(body.input);
    if (parsed.kind === "link") url = parsed.url;
    else if (parsed.kind === "links") url = parsed.urls[0];
    else if (parsed.kind === "link-and-text") {
      url = parsed.url;
      text = parsed.text;
    } else if (parsed.kind === "text") {
      text = parsed.text;
    } else {
      // Short hiring-manager posts (e.g. a LinkedIn feed post) can be under 300 chars.
      const trimmed = body.input.trim();
      if (trimmed.length >= MIN_POSTING_CHARS) text = trimmed;
      else return Response.json({ error: "Paste a job link or the posting text first." }, { status: 400 });
    }
  }

  const root = careerOpsRoot();
  const t0 = Date.now();
  const logPath = path.join(root, ".career-ops-web", "outreach.log");
  const log = (m: string) => {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      const el = ((Date.now() - t0) / 1000).toFixed(1);
      fs.appendFileSync(logPath, `${new Date().toISOString()} [+${el}s] ${m}\n`);
    } catch {
      /* non-fatal */
    }
  };
  log(`=== outreach request url=${url || "(none)"} text=${text.length} chars ===`);

  const context = await resolvePostingContext(url, text);
  if ("error" in context) {
    log(`context error: ${context.error}`);
    return Response.json({ error: context.error }, { status: 422 });
  }
  log(`context ready role="${context.role}" company="${context.company}" text=${context.text.length} chars`);

  const requestedCli =
    typeof body.cliId === "string" && body.cliId.trim()
      ? body.cliId.trim()
      : readRememberedCli(root) ?? DEFAULT_CLI;
  const choice = chooseCliWithFallback(requestedCli, root);
  if (choice.allLimited && choice.allLimitedMessage) {
    return Response.json({ error: choice.allLimitedMessage }, { status: 429 });
  }
  if (!choice.resolved) {
    return Response.json({ error: cliUnavailableError(requestedCli).error }, { status: 404 });
  }

  let activeSpec = choice.resolved.spec;
  let activeBin = choice.resolved.binPath;
  let activeModel = choice.model ?? (activeSpec.id === "claude" ? "haiku" : null);
  let usedFallback = choice.fallbackFrom ? fallbackDisplayName(activeSpec, activeModel) : undefined;

  const prompt = buildOutreachPrompt({
    root,
    profileRef: profileRef(root),
    url: context.url,
    role: context.role,
    company: context.company,
    postingText: context.text,
  });

  // Run in an empty temp cwd: all candidate files are already inlined in the
  // prompt, so skipping the repo root prevents CLIs from loading 80KB of
  // AGENTS.md / running startup checks and cuts drafting time dramatically.
  const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-outreach-"));
  log(`running cli=${activeSpec.id} model=${activeModel ?? "default"} fallback=${usedFallback ?? "none"} prompt=${prompt.length} chars`);

  let result;
  try {
    result = await runPlanner({
      cliId: activeSpec.id,
      spec: activeSpec,
      binPath: activeBin,
      model: activeModel,
      effort: "low",
      disableSlashCommands: true,
      timeoutMs: 60_000,
      prompt,
      fieldCount: 1,
      cwd: scratchCwd,
      t0,
      log,
    });

    const firstCombined = `${result.buf}\n${result.stderr}`.trim();
    const firstMessage = result.code === 0 ? cleanOutreachOutput(result.buf) : "";
    if (!result.refused && (!firstMessage || result.code !== 0) && isUsageLimitError(firstCombined)) {
      const firstCooldown = recordCliCooldown(activeSpec.id, firstCombined, root);
      if (usedFallback) {
        return Response.json({ error: bothModelsLimitedMessage([choice.cooldown, firstCooldown]) }, { status: 429 });
      }
      const fallback = resolveFallbackCli(activeSpec.id, root);
      if (!fallback) {
        const backupCooldowns = getFallbackCooldowns(activeSpec.id, root);
        if (backupCooldowns.length > 0) {
          return Response.json({ error: bothModelsLimitedMessage([firstCooldown, ...backupCooldowns]) }, { status: 429 });
        }
      } else {
        activeSpec = fallback.spec;
        activeBin = fallback.binPath;
        activeModel = fallback.model;
        usedFallback = fallbackDisplayName(activeSpec, activeModel);
        log(`Switching to fallback cli=${activeSpec.id}`);
        result = await runPlanner({
          cliId: activeSpec.id,
          spec: activeSpec,
          binPath: activeBin,
          model: activeModel,
          effort: "low",
          disableSlashCommands: true,
          timeoutMs: 60_000,
          prompt,
          fieldCount: 1,
          cwd: scratchCwd,
          t0,
          log,
        });
        const secondCombined = `${result.buf}\n${result.stderr}`.trim();
        const secondMessage = result.code === 0 ? cleanOutreachOutput(result.buf) : "";
        if (!result.refused && (!secondMessage || result.code !== 0) && isUsageLimitError(secondCombined)) {
          const backupCooldown = recordCliCooldown(activeSpec.id, secondCombined, root);
          return Response.json({ error: bothModelsLimitedMessage([firstCooldown, backupCooldown]) }, { status: 429 });
        }
      }
    }
  } finally {
    fs.rmSync(scratchCwd, { recursive: true, force: true });
  }

  log(`finished cli=${activeSpec.id} code=${result.code} signal=${result.signal} out=${result.buf.length} chars`);

  if (result.refused) return Response.json({ error: result.refused }, { status: 500 });

  if (result.signal) {
    return Response.json({ error: `Drafting timed out after 60s (${activeSpec.name}). Try again.` }, { status: 504 });
  }

  const outTail = result.buf.replace(/\s+/g, " ").trim().slice(-300);
  const errTail = result.stderr.replace(/\s+/g, " ").trim().slice(-300);
  if (result.code !== 0) {
    const detail = outTail || errTail || `exited with code ${result.code ?? "unknown"}`;
    return Response.json({ error: detail }, { status: 502 });
  }

  const message = cleanOutreachOutput(result.buf);
  if (!message) {
    return Response.json({ error: "The AI CLI returned an empty message. Try again." }, { status: 502 });
  }

  if (!usedFallback) clearCliCooldown(activeSpec.id, root);

  return Response.json({
    message,
    role: context.role,
    company: context.company,
    cli: activeSpec.id,
  });
}

async function resolvePostingContext(
  url: string,
  text: string,
): Promise<{ url: string; role: string; company: string; text: string } | { error: string }> {
  if (url) {
    const saved = readSavedJd(url);
    if (saved && saved.text.trim().length >= MIN_POSTING_CHARS) {
      const labels = inferLabelsFromSavedJd(saved);
      return { url: saved.url, role: labels.role, company: labels.company, text: saved.text };
    }
  }

  if (text.length >= MIN_POSTING_CHARS) {
    const labels = extractPostingLabels({ url, text });
    return { url, role: labels.role, company: labels.company, text };
  }

  if (url) {
    const posting = await readPosting(url);
    if (posting && posting.text.trim().length >= MIN_POSTING_CHARS) {
      return { url, role: posting.role, company: posting.company, text: posting.text };
    }
    return { error: unreadablePostingMessage(url) };
  }

  return { error: "Could not read a job posting from this page or input." };
}
