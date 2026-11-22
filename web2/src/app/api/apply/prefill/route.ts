import fs from "node:fs";
import path from "node:path";
import { cliSubstitutionNotice, cliUnavailableError } from "@/lib/clis";
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
import { careerOpsRoot, readMemory } from "@/lib/career-ops";
import { profileRef } from "@/lib/core/profile-path.mjs";
import { getSession } from "@/lib/apply/session";
import { resolveSessionCv } from "@/lib/apply/cv";
import { applyCvSource } from "@/lib/apply/cv-source.mjs";
import { buildAnswerPrompt } from "@/lib/apply/answer-prompt.mjs";
import { runPlanner } from "@/lib/apply/planner";
import { extractJsonObject } from "@/lib/extract-json-object.mjs";
import { readJsonObject } from "@/lib/json-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 320;

// AI pre-fill (STREAMING NDJSON). The user's BYO CLI (read-only PLANNER — no
// browser access) drafts an answer per field from cv.md / profile / the job's
// report. We stream a live diagnostic log of every step (spawn, heartbeats,
// exit code/signal, parse outcome) so a stuck/empty prefill is observable on the
// page AND written to <root>/.career-ops-web/apply-prefill.log for debugging.
export async function POST(req: Request) {
  const body = await readJsonObject<{ sessionId?: string; cliId?: string; company?: string; application?: string }>(req);
  if (!body) return Response.json({ error: "bad json" }, { status: 400 });
  const { sessionId, cliId: requestedCliId, company, application } = body;
  // Same two identifiers the fill route takes, validated the same way: they
  // reach a filesystem resolver, so a non-string is refused before it gets there.
  if (company !== undefined && typeof company !== "string") {
    return Response.json({ error: "company must be a string" }, { status: 400 });
  }
  if (application !== undefined && typeof application !== "string") {
    return Response.json({ error: "application must be a string" }, { status: 400 });
  }
  const t0 = Date.now();
  const encoder = new TextEncoder();
  const logPath = path.join(careerOpsRoot(), ".career-ops-web", "apply-prefill.log");
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
  } catch {
    /* ignore */
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          /* client gone */
        }
      };
      const log = (m: string) => {
        const el = Date.now() - t0;
        emit({ t: "log", m, el });
        try {
          fs.appendFileSync(logPath, `${new Date(t0 + el).toISOString()} [+${(el / 1000).toFixed(1)}s] ${m}\n`);
        } catch {
          /* ignore */
        }
      };
      // Idempotent, like the `closed` guard the sibling routes carry. fail() closes
      // the controller, and there is more than one path to it: a fencing refusal
      // reports through fail() and then resolves with an empty buffer, which the
      // empty-output branch below reports through fail() a second time. Closing an
      // already-closed controller throws "Invalid state", and that throw escapes
      // the async start() as an unhandled rejection — a worse failure than the one
      // being reported.
      let failed = false;
      const fail = (m: string, raw?: string) => {
        if (failed) return;
        failed = true;
        log(`ERROR: ${m}`);
        emit({ t: "error", m, raw });
        controller.close();
      };
      try {
        fs.appendFileSync(logPath, `\n===== prefill ${new Date(t0).toISOString()} session=${sessionId} cli=${requestedCliId} =====\n`);
      } catch {
        /* ignore */
      }

      const root = careerOpsRoot();
      const s = sessionId ? getSession(sessionId) : undefined;
      if (!s) return fail("apply session not found (it may have expired)");
      const choice = requestedCliId
        ? chooseCliWithFallback(requestedCliId, root)
        : { resolved: null, fallbackFrom: null, cooldown: null, model: null, allLimited: false, allLimitedMessage: null };
      if (choice.allLimited && choice.allLimitedMessage) return fail(choice.allLimitedMessage);
      if (!choice.resolved) return fail(cliUnavailableError(requestedCliId ?? "").error);
      let { spec, binPath } = choice.resolved;
      // The CLI actually running: the planner's fencing and argv are keyed on it.
      let cliId = spec.id;
      let model = choice.model;
      let usedFallback = choice.fallbackFrom ? fallbackDisplayName(spec, model) : undefined;
      const substitution = cliSubstitutionNotice(choice.resolved);
      if (substitution) log(substitution);
      if (usedFallback) {
        log(`Using backup model (${cliId}) while primary is in cooldown.`);
      }

      const mem = readMemory().trim();
      // Draft from the SAME tailored CV the fill route uploads to this form,
      // resolved through the one shared call so the answers and the resume
      // stapled to them cannot describe different documents.
      const cvPath = await resolveSessionCv({ company, application, title: s.title });
      const cvSource = cvPath ? applyCvSource(root, cvPath) : null;
      const prompt = buildAnswerPrompt({ title: s.title, fields: s.fields, memory: mem, cvSource, profile: profileRef(root) });

      log(`Form: "${s.title}" · ${s.fields.length} fields · prompt ${prompt.length} chars · memory ${mem.length} chars`);
      log(`CV source: ${cvSource ?? "none found — answers will come from cv.md"}`);
      log(`Planner: ${cliId} (${binPath})${model ? ` · model=${model}` : ""}`);
      let result = await runPlanner({
        cliId,
        spec,
        binPath,
        model,
        prompt,
        fieldCount: s.fields.length,
        cwd: root,
        t0,
        log,
      });

      // If the active CLI hit a usage/rate limit, record cooldown and silently switch to backup;
      // only report a limit error to the user if both primary and backup hit their limits.
      const firstLimitText = `${result.buf}\n${result.stderr}`.trim();
      const firstParsed = result.buf.trim() ? extractJsonObject(result.buf) : { obj: null, truncated: false };
      if (!result.refused && !firstParsed.obj && isUsageLimitError(firstLimitText)) {
        const firstCooldown = recordCliCooldown(cliId, firstLimitText, root);
        if (usedFallback) {
          return fail(bothModelsLimitedMessage([choice.cooldown, firstCooldown]), firstLimitText.slice(-300));
        }
        const fallback = resolveFallbackCli(cliId, root);
        if (!fallback) {
          const backupCooldowns = getFallbackCooldowns(cliId, root);
          if (backupCooldowns.length > 0) {
            return fail(bothModelsLimitedMessage([firstCooldown, ...backupCooldowns]), firstLimitText.slice(-300));
          }
        } else {
          spec = fallback.spec;
          binPath = fallback.binPath;
          cliId = spec.id;
          model = fallback.model;
          usedFallback = fallbackDisplayName(spec, model);
          log(`Primary hit limit; silently switching to backup planner: ${cliId} (${binPath})${model ? ` · model=${model}` : ""}`);
          result = await runPlanner({
            cliId,
            spec,
            binPath,
            model,
            prompt,
            fieldCount: s.fields.length,
            cwd: root,
            t0,
            log,
          });
          const secondLimitText = `${result.buf}\n${result.stderr}`.trim();
          const secondParsed = result.buf.trim() ? extractJsonObject(result.buf) : { obj: null, truncated: false };
          if (!result.refused && !secondParsed.obj && isUsageLimitError(secondLimitText)) {
            const backupCooldown = recordCliCooldown(cliId, secondLimitText, root);
            return fail(bothModelsLimitedMessage([firstCooldown, backupCooldown]), secondLimitText.slice(-300));
          }
        }
      }

      // Fencing refused to start the planner (#2507): runPlanner already logged
      // the reason; report it as THE error, before the empty-output branch below
      // turns it into an unrelated "produced no output".
      if (result.refused) return fail(result.refused);

      log(`Planner exited code=${result.code} signal=${result.signal} · ${result.buf.length} chars total`);
      log(`output head: ${result.buf.slice(0, 100).replace(/\s+/g, " ") || "(empty)"}`);
      log(`output tail: ${result.buf.slice(-100).replace(/\s+/g, " ") || "(empty)"}`);

      if (!result.buf.trim()) {
        if (result.signal) {
          return fail("planner was killed before producing any output (try again / smaller form)");
        }
        const errTail = result.stderr.replace(/\s+/g, " ").trim().slice(-300);
        if (result.code !== 0 && errTail) {
          return fail(`planner (${cliId}) exited with code ${result.code ?? "unknown"}: ${errTail}`, errTail);
        }
        return fail("planner produced no output (check the CLI works in this folder)");
      }

      const { obj, truncated } = extractJsonObject(result.buf);
      if (!obj) {
        if (result.signal) {
          return fail("planner was killed mid-answer (form too large/slow) — couldn't recover any fields", result.buf.slice(-300));
        }
        const outTail = result.buf.replace(/\s+/g, " ").trim().slice(-300);
        if (result.code !== 0) {
          const detail = outTail || result.stderr.replace(/\s+/g, " ").trim().slice(-300);
          return fail(
            detail ? `planner (${cliId}) exited with code ${result.code ?? "unknown"}: ${detail}` : `planner (${cliId}) exited with code ${result.code ?? "unknown"}`,
            detail,
          );
        }
        return fail("couldn't parse the planner's answer as JSON", outTail);
      }
      if (!usedFallback) clearCliCooldown(cliId, root);
      const count = Object.keys(obj).length;
      log(`Parsed ${count} answers${truncated ? " (RECOVERED from truncated output — some fields may be missing)" : ""}`);
      emit({ t: "done", answers: obj, truncated, count });
      controller.close();
    },
  });

  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
