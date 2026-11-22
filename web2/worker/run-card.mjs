/**
 * Background worker: runs one board card's action outside the web2 server.
 * Started by src/lib/board/board-runner.ts with the run request as argv[2].
 */
import { runCardAction } from "@/lib/board/card-actions";

const request = JSON.parse(process.argv[2] ?? "null");
if (!request?.key || !request?.action) {
  console.error(`run-card: expected a run request as the first argument, got ${process.argv[2]}`);
  process.exit(2);
}
console.log(`${new Date().toISOString()} run-card ${request.action} ${request.key} started (pid ${process.pid})`);
const outcomeState = await runCardAction(request);
console.log(`${new Date().toISOString()} run-card ${request.action} ${request.key} finished (${outcomeState})`);
// Apply sessions keep a browser open for the user to review and submit; only stay alive when the form was actually filled.
if (request.action !== "fill-application" || outcomeState !== "done") process.exit(0);
