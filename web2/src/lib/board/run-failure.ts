/**
 * Turns a failed run's message (free text from the agent or a route) into a
 * short headline and the next step the user can take. The full message stays
 * available as details. Each step has its own rules, checked in order; the
 * first match wins.
 */

export const USAGE_LIMIT_RE =
  /usage limit|rate limit|limit (was )?reached|limit will reset|hit your .*limit|\d+-hour limit|credit balance|out of (?:usage )?credits|quota exceeded/i;

/**
 * `manual`: nothing broke, the step just can't be done automatically and the
 * user does it by hand (shown as information, not as an error). `error`: the
 * step failed and may work on a retry.
 */
export type FailureSummary = { headline: string; next: string; retryHelps: boolean; kind: FailureKind };
export type FailureKind = "manual" | "error";

type Rule = { pattern: RegExp; summary: Omit<FailureSummary, "kind"> & { kind?: FailureKind } };

// Checked first for every step: nothing else matters until a limit resets.
const ACCOUNT_RULES: Rule[] = [
  {
    pattern: /both primary and backup ai models have hit their usage limits/i,
    summary: { headline: "Both AI models hit their usage limits", next: "Wait until one resets, then Retry.", retryHelps: true },
  },
  {
    pattern: USAGE_LIMIT_RE,
    summary: { headline: "Your AI usage limit was reached", next: "Wait until it resets, then Retry.", retryHelps: true },
  },
];

const READ_STEP_RULES: Rule[] = [
  {
    pattern: /No saved job description/i,
    summary: {
      headline: "This card has no saved job description",
      next: "Drop it on Evaluate first, or remove it with ✕ and save the link again from Discover.",
      retryHelps: false,
    },
  },
  {
    pattern: /Couldn'?t tell the company or role/i,
    summary: {
      headline: "The company or role isn't known for this job",
      next: "Drop it on Evaluate first; the CV can be built after that.",
      retryHelps: false,
    },
  },
  {
    pattern: /CV-only record/i,
    summary: {
      headline: "Couldn't record this job in the tracker",
      next: "Retry. If it fails again, share the details.",
      retryHelps: true,
    },
  },
  {
    pattern: /LinkedIn didn'?t show the job text/i,
    summary: {
      headline: "LinkedIn didn't show the job text",
      next: "Remove this card with ✕, then paste the job description on Discover with the link on its first line.",
      retryHelps: false,
    },
  },
  // Before "closed": "the page was down, which doesn't show the job is closed" is not a closed job.
  {
    pattern: /\bHTTP 5\d\d\b|could ?n[o']t (be )?read|could not be read|no job description|jd_unavailable|no browser|login wall|bot challenge/i,
    summary: {
      headline: "Couldn't read the job description",
      next: "Retry later. If it keeps failing, save the employer's own posting link on Discover, or remove this card.",
      retryHelps: true,
    },
  },
  {
    pattern: /\b(404|410)\b|appears closed|posting (is|was) (closed|removed)|has (been )?(closed|expired|filled)|\bexpired\b|no longer (accepting|available|open)/i,
    summary: { headline: "This posting is closed", next: "Remove this card with ✕.", retryHelps: false },
  },
  {
    pattern: /isn'?t disclosed|not disclosed|undisclosed|unnamed (partner|company|employer)|hidden employer|employer (is )?(hidden|unknown)|which agency/i,
    summary: {
      headline: "The employer isn't named (agency posting)",
      next: "Find this role on the employer's own careers page and save that link on Discover, or remove this card.",
      retryHelps: false,
    },
  },
  {
    pattern: /blacklist|deal-?breaker|needs your decision|stopped at a check/i,
    summary: { headline: "Stopped at a check that needs your decision", next: "Read the details, then Retry or remove this card.", retryHelps: true },
  },
];

const FILL_IT_YOURSELF = "Open the job's Apply page and fill it yourself, then drag the card to Applied.";

const APPLICATION_RULES: Rule[] = [
  {
    pattern: /saved from pasted text/i,
    summary: {
      headline: "No application page is known for this job",
      next: "It was saved from pasted text. Open the job's Apply page yourself, or save it again on Discover with the job link on the first line.",
      retryHelps: false,
      kind: "manual",
    },
  },
  {
    pattern: /careers listing|not a single application|listing page|job board page/i,
    summary: { headline: "The link opens a careers list, not this job's form", next: FILL_IT_YOURSELF, retryHelps: false, kind: "manual" },
  },
  {
    pattern: /cannot fill|can'?t be filled|unsupported|couldn'?t find the application form/i,
    summary: { headline: "This form can't be filled automatically", next: FILL_IT_YOURSELF, retryHelps: false, kind: "manual" },
  },
  {
    pattern: /sign ?in|log ?in|login required|create an account/i,
    summary: { headline: "The form needs you to sign in first", next: FILL_IT_YOURSELF, retryHelps: false, kind: "manual" },
  },
  {
    pattern: /has been closed|target page|browser.*closed|window.*closed/i,
    summary: {
      headline: "The form window closed before it was filled",
      next: "Try auto-fill again and leave the window open, or fill the form yourself and drag the card to Applied.",
      retryHelps: true,
      kind: "manual",
    },
  },
  {
    pattern: /./,
    summary: {
      headline: "Fill this form yourself",
      next: "Auto-fill couldn't complete this form. Open the job's Apply page and fill it yourself, or try auto-fill again.",
      retryHelps: true,
      kind: "manual",
    },
  },
];

const EMPLOYER_LINK_RULES: Rule[] = [
  {
    pattern: /already evaluated, so its tracker row keeps the third-party link/i,
    summary: {
      headline: "Already evaluated, so the employer link wasn't looked up",
      next: "Open the posting and use the employer's own Apply page when you apply.",
      retryHelps: false,
    },
  },
  {
    pattern: /Claude CLI isn't installed/i,
    summary: {
      headline: "Couldn't search the employer's site (Claude isn't installed)",
      next: "Open the posting and find the job on the company's careers page yourself.",
      retryHelps: false,
    },
  },
  {
    pattern: /No saved job description for this link/i,
    summary: {
      headline: "The company and role to look for are unknown",
      next: "Remove the card with ✕ and save the link again from Discover.",
      retryHelps: false,
    },
  },
  {
    pattern: /employer-link search ended without an answer|Could not start Claude for the employer-link search/i,
    summary: { headline: "The search for the employer's posting didn't finish", next: "Retry. If it fails again, open the posting and find the job on the company's site.", retryHelps: true },
  },
];

const RULES_BY_ACTION: Record<string, Rule[]> = {
  "find-employer-link": EMPLOYER_LINK_RULES,
  evaluate: READ_STEP_RULES,
  "generate-cv": READ_STEP_RULES,
  "fill-application": APPLICATION_RULES,
};

const FALLBACK: FailureSummary = { headline: "This step failed", next: "Retry. If it fails again, share the details.", retryHelps: true, kind: "error" };

export function summarizeFailure(action: string, message: string): FailureSummary {
  const rules = [...ACCOUNT_RULES, ...(RULES_BY_ACTION[action] ?? [])];
  const summary = rules.find((rule) => rule.pattern.test(message))?.summary;
  return summary ? { kind: "error", ...summary } : FALLBACK;
}
