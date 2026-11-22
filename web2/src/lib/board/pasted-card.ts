import fs from "node:fs";
import { updateBoard } from "@/lib/board/board-store";
import { readBoardCards } from "@/lib/board/board-cards";
import { removePostingTraces } from "@/lib/board/posting-traces";
import { savedJdPath } from "@/lib/board/saved-jd";

/**
 * An evaluated job that was saved from pasted text gets a tracker row with no
 * posting link (the core accepts only http(s) links there), so the board shows
 * it under the row's own key. Hand the pasted card's column and run over to
 * that row and remove the pasted card's inbox line and saved text: the report
 * now archives the job description, so one card remains.
 */
export async function adoptEvaluatedPastedCard(pastedKey: string, trackerNumber: string): Promise<void> {
  const trackerKey = readBoardCards().find((card) => card.key !== pastedKey && Number(card.trackerNumber) === Number(trackerNumber))?.key;
  if (!trackerKey) throw new Error(`The evaluation was saved, but tracker row ${trackerNumber} was not found on the board. Refresh the page.`);
  updateBoard((board) => {
    const pasted = board[pastedKey];
    board[trackerKey] = {
      ...board[trackerKey],
      column: pasted?.column ?? "evaluate",
      ...(pasted?.order !== undefined ? { order: pasted.order } : {}),
      run: pasted?.run,
    };
    delete board[pastedKey];
  });
  await removePostingTraces(pastedKey);
  fs.rmSync(savedJdPath(pastedKey), { force: true });
}
