import { RotateCcw } from "lucide-react";
import type { BoardCard } from "@/lib/board/board-cards";

/**
 * For a job saved from a third-party site whose posting was not found on the
 * employer's own site: a muted "Not confirmed at employer" badge and a way to
 * look again. Renders nothing otherwise.
 */
export function EmployerLinkBadge({ card, onRetry }: { card: BoardCard; onRetry: () => void }) {
  if (!isNotConfirmed(card)) return null;
  const reason = card.employerLink?.reason?.trim();
  return (
    <div className="mt-2 space-y-1 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className="rounded-md border border-border px-1.5 py-0.5 text-muted"
          title={reason || "This job's posting wasn't found on the company's own site, so the card keeps the job-site link."}
        >
          Not confirmed at employer
        </span>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex cursor-pointer items-center gap-1 text-muted hover:text-foreground"
        >
          <RotateCcw className="size-3" />
          Retry employer link
        </button>
      </div>
      {reason && <p className="text-[11px] leading-snug text-muted [overflow-wrap:anywhere]">{reason}</p>}
    </div>
  );
}

/**
 * Employer-link runs never show a red error on the card (except when both AI
 * models hit their limits): if the employer site couldn't be reached or
 * confirmed, the card stays as-is with the muted badge and a Retry button.
 */
export function showsRunLine(card: BoardCard): boolean {
  if (!card.run) return false;
  if (card.run.action === EMPLOYER_LINK_ACTION && !isBothModelsLimited(card.run.message)) return false;
  return true;
}

function isNotConfirmed(card: BoardCard): boolean {
  if (card.run?.state === "running") return false;
  if (card.employerLink?.status === "not-found") return true;
  return card.run?.action === EMPLOYER_LINK_ACTION && card.run.state === "error" && !isBothModelsLimited(card.run.message);
}

function isBothModelsLimited(message: string | undefined): boolean {
  return typeof message === "string" && /both primary and backup ai models have hit their usage limits/i.test(message);
}

const EMPLOYER_LINK_ACTION = "find-employer-link";
