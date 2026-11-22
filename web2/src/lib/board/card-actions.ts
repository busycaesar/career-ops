import { careerOpsRoot } from "@/lib/career-ops";
import { readRememberedCli } from "@/lib/remembered-cli.mjs";
import {
  bothModelsLimitedMessage,
  chooseCliWithFallback,
  clearCliCooldown,
  getFallbackCooldowns,
  isUsageLimitError,
  recordCliCooldown,
  resolveFallbackCli,
} from "@/lib/cli-fallback";
import { updateBoard, type RunState } from "@/lib/board/board-store";
import { setTrackerStatus } from "@/lib/board/tracker-status";
import { isLinkedInJobUrl } from "@/lib/board/linkedin-jd";
import { readPosting } from "@/lib/board/read-posting";
import { readSavedJd, savedJdPromptText, writeSavedJd, type SavedJd } from "@/lib/board/saved-jd";
import { isPastedRef } from "@/lib/board/pasted-ref";
import { adoptEvaluatedPastedCard } from "@/lib/board/pasted-card";
import { createUnevaluatedRecord } from "@/lib/board/unevaluated-record";
import { findEmployerLink } from "@/lib/board/employer-link/find-employer-link";
import type { RunAction, RunRequest } from "@/lib/board/run-request";
import { embeddedApplicationUrl } from "@/lib/board/embedded-ats";
import { POST as runAgent } from "@/app/api/run/route";
import { POST as openApplySession } from "@/app/api/apply/session/route";
import { POST as draftApplyAnswers } from "@/app/api/apply/prefill/route";
import { POST as fillApplyForm } from "@/app/api/apply/fill/route";
import { POST as closeApplySession } from "@/app/api/apply/close/route";

/**
 * The work behind each column, run by worker/run-card.mjs in its own process
 * so a restart of the web2 server does not cut it off. It calls the copied
 * web/ route handlers directly and saves progress and the outcome on the card.
 */

const DEFAULT_CLI = "claude";
const WORKER_ORIGIN = "http://web2.worker";
const AGENT_TAIL_CHARS = 400;
const TRACKER_NUMBER = /^\d+$/;
export const NO_SAVED_JD =
  "No saved job description for this posting, so a CV can't be built without an evaluation. Move it to Evaluate first, or re-add the link from Discover.";
export const PASTED_NO_APPLICATION =
  "This job was saved from pasted text, so there is no application page to open — add the job link.";
export const LINKEDIN_UNREADABLE =
  "LinkedIn didn't show the job text: the page showed no job description (a login wall, a removed posting, or a page that did not load). Copy the job description from LinkedIn and paste it on Discover (with the link on the first line).";

export async function runCardAction(request: RunRequest): Promise<RunState> {
  const { key, action } = request;
  saveRun(key, action, "running", "Started");
  try {
    const outcome = await runAction(request);
    saveRun(key, action, "done", outcome.message);
    if (outcome.trackerNumber && isPastedRef(key)) await adoptEvaluatedPastedCard(key, outcome.trackerNumber);
    return "done";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    saveRun(key, action, "error", message);
    return "error";
  }
}

/** What a finished step reports, and the tracker row an evaluation created. */
type RunOutcome = { message: string; trackerNumber?: string };

async function runAction({ key, action, input, card }: RunRequest): Promise<RunOutcome> {
  switch (action) {
    case "mark-applied":
      return { message: await setTrackerStatus(input, "Applied", "Marked applied from web2 board") };
    case "fill-application":
      return { message: await fillApplication(card, input, key) };
    case "evaluate":
      return streamAgentRun(action, input, key);
    case "generate-cv":
      return { message: await generateCv(input, key) };
    case "find-employer-link":
      return { message: await findEmployerLink(key, input, (label) => saveRun(key, action, "running", label)) };
  }
}

function saveRun(key: string, action: RunAction, state: RunState, message: string): void {
  updateBoard((board) => {
    const entry = board[key];
    if (!entry) return;
    const now = new Date().toISOString();
    const startedAt = entry.run?.state === "running" ? entry.run.startedAt : now;
    entry.run = { action, state, message, startedAt, pid: process.pid, ...(state === "running" ? {} : { finishedAt: now }) };
  });
}

function cliId(): string {
  return readRememberedCli(careerOpsRoot()) ?? DEFAULT_CLI;
}

function jsonRequest(route: string, body: unknown): Request {
  return new Request(new URL(route, WORKER_ORIGIN), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

type StreamEvent = Record<string, unknown> & { type?: string; t?: string };

async function runAgentOnce(opts: {
  action: "evaluate" | "generate-cv";
  kind: "evaluate" | "pdf";
  input: string;
  key: string;
  selectedCliId: string;
  model: string | null;
  jdFields: { jdText?: string; jdSource?: string };
}): Promise<RunOutcome> {
  const { action, kind, input, key, selectedCliId, model, jdFields } = opts;
  const response = await runAgent(
    jsonRequest("/api/run", {
      kind,
      input,
      cliId: selectedCliId,
      ...(model ? { model } : {}),
      ...jdFields,
    }),
  );
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `The run could not start (HTTP ${response.status}).`);
  }
  let outcome: StreamEvent | null = null;
  const errorMessages: string[] = [];
  let agentText = "";
  for await (const event of readEvents(response.body)) {
    if (event.type === "status" && typeof event.label === "string") saveRun(key, action, "running", event.label);
    if (event.type === "text" && typeof event.text === "string") agentText = (agentText + event.text).slice(-AGENT_TAIL_CHARS * 4);
    if (event.type === "error" && typeof event.msg === "string" && event.msg.trim()) {
      const msg = event.msg.trim();
      if (!errorMessages.includes(msg)) errorMessages.push(msg);
    }
    if (event.type === "done" || event.type === "error" || event.type === "gated") outcome = event;
  }
  if (!outcome) throw new Error(withAgentTail("The run ended without a result.", agentText));
  if (outcome.type === "error") {
    const primary = errorMessages.join(" — ") || String(outcome.msg ?? "The run failed.");
    throw new Error(withAgentTail(primary, agentText));
  }
  if (outcome.type === "gated") throw new Error(String(outcome.message ?? "The run stopped at a check and needs your decision."));
  const cost = action === "evaluate" || typeof outcome.costUsd !== "number" ? "" : ` ($${outcome.costUsd.toFixed(2)})`;
  const trackerNumber = typeof outcome.reportN === "number" ? String(outcome.reportN) : undefined;
  return { message: `${action === "evaluate" ? "Evaluated" : "CV generated"}${cost}`, trackerNumber };
}

async function streamAgentRun(action: "evaluate" | "generate-cv", input: string, key: string): Promise<RunOutcome> {
  const root = careerOpsRoot();
  const kind = action === "evaluate" ? "evaluate" : "pdf";
  const jd = action === "evaluate" ? await evaluationJd(input, key) : undefined;
  const jdFields = jd ? { jdText: savedJdPromptText(jd), jdSource: jd.source } : {};

  const primaryCli = cliId();
  const choice = chooseCliWithFallback(primaryCli, root);
  if (choice.allLimited && choice.allLimitedMessage) {
    throw new Error(choice.allLimitedMessage);
  }
  const selectedCliId = choice.resolved?.spec.id ?? primaryCli;
  const usingFallback = Boolean(choice.fallbackFrom && choice.resolved);

  try {
    const result = await runAgentOnce({
      action,
      kind,
      input,
      key,
      selectedCliId,
      model: choice.model,
      jdFields,
    });
    clearCliCooldown(selectedCliId, root);
    return result;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (!isUsageLimitError(errMsg)) throw err;

    const firstCooldown = recordCliCooldown(selectedCliId, errMsg, root);
    if (usingFallback) {
      const nextFallback = resolveFallbackCli(primaryCli, root);
      if (!nextFallback) {
        throw new Error(bothModelsLimitedMessage([choice.cooldown, firstCooldown]));
      }
      try {
        const retryResult = await runAgentOnce({
          action,
          kind,
          input,
          key,
          selectedCliId: nextFallback.spec.id,
          model: nextFallback.model,
          jdFields,
        });
        clearCliCooldown(nextFallback.spec.id, root);
        return retryResult;
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        if (isUsageLimitError(retryMsg)) {
          const secondCooldown = recordCliCooldown(nextFallback.spec.id, retryMsg, root);
          throw new Error(bothModelsLimitedMessage([choice.cooldown, firstCooldown, secondCooldown]));
        }
        throw retryErr;
      }
    }

    const fallback = resolveFallbackCli(selectedCliId, root);
    if (!fallback) {
      const backupCooldowns = getFallbackCooldowns(selectedCliId, root);
      if (backupCooldowns.length > 0) {
        throw new Error(bothModelsLimitedMessage([firstCooldown, ...backupCooldowns]));
      }
      throw err;
    }

    try {
      const retryResult = await runAgentOnce({
        action,
        kind,
        input,
        key,
        selectedCliId: fallback.spec.id,
        model: fallback.model,
        jdFields,
      });
      clearCliCooldown(fallback.spec.id, root);
      return retryResult;
    } catch (retryErr) {
      const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
      if (isUsageLimitError(retryMsg)) {
        const backupCooldown = recordCliCooldown(fallback.spec.id, retryMsg, root);
        throw new Error(bothModelsLimitedMessage([firstCooldown, backupCooldown]));
      }
      throw retryErr;
    }
  }
}

/**
 * The CV step. A card that skipped Evaluate arrives with its posting link
 * instead of a tracker number: it first gets a CV-only report (the saved job
 * description, no score) and tracker row, then the CV is built from those.
 */
async function generateCv(input: string, key: string): Promise<string> {
  if (TRACKER_NUMBER.test(input)) return (await streamAgentRun("generate-cv", input, key)).message;
  const jd = readSavedJd(input);
  if (!jd) throw new Error(NO_SAVED_JD);
  saveRun(key, "generate-cv", "running", "Recording the job without an evaluation");
  const trackerNumber = await createUnevaluatedRecord(jd);
  return (await streamAgentRun("generate-cv", trackerNumber, key)).message;
}

/**
 * The job text handed to Evaluate: the description saved when the link was
 * added. Older LinkedIn cards have none, and the agent may not read LinkedIn
 * itself, so those get the one browser read the LinkedIn guard allows (saved
 * for next time). Any other link without one is left to the agent to fetch.
 */
async function evaluationJd(url: string, key: string): Promise<SavedJd | undefined> {
  const saved = readSavedJd(url);
  if (saved) return saved;
  if (!isLinkedInJobUrl(url)) return undefined;
  saveRun(key, "evaluate", "running", "Reading the LinkedIn posting");
  const posting = await readPosting(url);
  if (!posting) throw new Error(LINKEDIN_UNREADABLE);
  const jd: SavedJd = { url, readAt: new Date().toISOString(), ...posting };
  writeSavedJd(jd);
  return jd;
}

/**
 * The route's failure message says what was missing, not why: the agent's own
 * last words do (a usage limit, a refusal, a question it stopped on). Appended
 * so the card can show it and the failure can be classified from it.
 */
function withAgentTail(message: string, agentText: string): string {
  const tail = agentText.replace(/\s+/g, " ").trim().slice(-AGENT_TAIL_CHARS);
  return tail ? `${message} The agent's last words: "${tail}"` : message;
}

type ApplySession = { id?: string; fields?: unknown[]; needsDrive?: boolean; unsupported?: unknown; message?: string; error?: string };

/**
 * Open the real application form, draft the answers from the CV, fill the
 * form and bring its window to the front. It never submits: the user checks
 * the filled form and clicks Submit themselves.
 */
async function fillApplication(card: RunRequest["card"], trackerNumber: string, key: string): Promise<string> {
  const action = "fill-application";
  if (isPastedRef(card.url)) throw new Error(PASTED_NO_APPLICATION);
  saveRun(key, action, "running", "Opening the application form…");
  // A careers page that embeds the ATS (?ashby_jid=, ?gh_jid=) shows the job
  // list to a browser; the form itself lives on the ATS's own page.
  const formUrl = (await embeddedApplicationUrl(card.url)) ?? card.url;
  const session = (await (await openApplySession(jsonRequest("/api/apply/session", { url: formUrl, cliId: cliId(), n: trackerNumber }))).json()) as ApplySession;
  if (session.error) throw new Error(`Could not open the form: ${session.error}`);
  if (session.unsupported) throw new Error(session.message ?? "This job's form can't be filled automatically.");
  if (!session.id) throw new Error("The form opened but no session came back.");
  const sessionId = session.id;
  try {
    if (session.needsDrive || !session.fields?.length) {
      throw new Error("Couldn't find the application form's fields on that page, so it can't be filled automatically.");
    }
    saveRun(key, action, "running", `Drafting answers for ${session.fields.length} fields…`);
    const { answers, toConfirm } = await draftAnswers(sessionId, card.company, trackerNumber, (label) =>
      saveRun(key, action, "running", label),
    );
    saveRun(key, action, "running", "Filling the form…");
    const fillBody = { sessionId, answers, fields: session.fields, handoff: true, company: card.company, application: trackerNumber };
    const filled = (await (await fillApplyForm(jsonRequest("/api/apply/fill", fillBody))).json()) as { error?: string; cvAttached?: boolean };
    if (filled.error) throw new Error(`Filling failed: ${filled.error}`);
    const cvNote = filled.cvAttached ? "CV attached" : "CV NOT attached, add it yourself";
    const confirmNote = toConfirm > 0 ? ` ${toConfirm} answer${toConfirm === 1 ? "" : "s"} flagged for you to double-check.` : "";
    return `Form filled (${cvNote}).${confirmNote} Review it in the browser window and submit it yourself.`;
  } catch (err) {
    await closeApplySession(jsonRequest("/api/apply/close", { sessionId })).catch(() => undefined);
    throw err;
  }
}

type DraftedAnswer = { value?: string; needs_confirmation?: boolean };
type DraftedAnswers = { answers: Record<string, string>; toConfirm: number };

/** The planner's answers as the plain text each field takes, plus how many it flagged for the user to confirm. */
async function draftAnswers(
  sessionId: string,
  company: string,
  trackerNumber: string,
  onStatus: (label: string) => void,
): Promise<DraftedAnswers> {
  const response = await draftApplyAnswers(jsonRequest("/api/apply/prefill", { sessionId, cliId: cliId(), company, application: trackerNumber }));
  if (!response.ok || !response.body) throw new Error(`Drafting answers could not start (HTTP ${response.status}).`);
  for await (const event of readEvents(response.body)) {
    if (event.t === "status" && typeof event.m === "string" && event.m.trim()) {
      onStatus(event.m.trim());
      continue;
    }
    if (event.t === "error") {
      const msg = String(event.m ?? "unknown error");
      const raw = typeof event.raw === "string" ? event.raw.replace(/\s+/g, " ").trim() : "";
      const detail = raw && !msg.includes(raw) ? `${msg} (${raw})` : msg;
      throw new Error(`Drafting answers failed: ${detail}`);
    }
    if (event.t !== "done") continue;
    const answers: Record<string, string> = {};
    let toConfirm = 0;
    for (const [fieldId, drafted] of Object.entries((event.answers ?? {}) as Record<string, DraftedAnswer>)) {
      answers[fieldId] = drafted?.value ?? "";
      if (drafted?.needs_confirmation) toConfirm += 1;
    }
    return { answers, toConfirm };
  }
  throw new Error("Drafting answers ended without a result.");
}

async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line) as StreamEvent;
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer) as StreamEvent;
}

