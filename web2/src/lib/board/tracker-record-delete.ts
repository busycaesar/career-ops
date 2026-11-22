import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { careerOpsRoot } from "@/lib/career-ops";
import { resolveCodeRoot } from "@/lib/core/code-root.mjs";
import { resolveTrackerPath, trackerLinkDirs } from "@/lib/core/tracker-files.mjs";
import { firstMarkdownLinkTarget } from "@/lib/posting-url.mjs";

/**
 * Deletes one tracker row and the files that belong to it: its report, its CV
 * files in output/ and a tracker-addition TSV not merged yet. Every file is
 * matched by the row's own report number and report name, never by company,
 * so another application at the same employer is never touched.
 * data/status-log.tsv is an append-only ledger and stays as it is.
 */
export async function deleteTrackerRecord(trackerNumber: string): Promise<void> {
  const root = careerOpsRoot();
  const report = await removeTrackerRow(trackerNumber);
  if (!report) return;
  for (const file of reportOwnedFiles(root, report)) fs.rmSync(file, { force: true });
}

type ReportRef = { file: string; number: string; name: string };

/** Removes the row under the core tracker lock and returns the report it linked. */
async function removeTrackerRow(trackerNumber: string): Promise<ReportRef | null> {
  const { openTrackerTransaction } = await trackerUtils();
  const transaction = await openTrackerTransaction(resolveTrackerPath(careerOpsRoot()));
  try {
    const lines = transaction.read().split("\n");
    const columns = tableColumns(lines);
    const rowIndex = lines.findIndex((line) => cellsOf(line)[columns.number] === trackerNumber);
    if (rowIndex === -1) throw new Error(`Tracker row #${trackerNumber} is no longer in data/applications.md. Refresh the page.`);
    const report = reportRef(cellsOf(lines[rowIndex])[columns.report] ?? "");
    lines.splice(rowIndex, 1);
    if (report && lines.some((line) => line.includes(`${report.number}-${report.name}.md`))) {
      throw new Error(`Another tracker row also links report ${report.number}, so it was not deleted. Fix data/applications.md by hand.`);
    }
    transaction.replace(lines.join("\n"));
    return report;
  } finally {
    transaction.close();
  }
}

function tableColumns(lines: string[]): { number: number; report: number } {
  const header = lines.find((line) => cellsOf(line)[0] === "#");
  const cells = header ? cellsOf(header) : [];
  const report = cells.findIndex((cell) => cell.toLowerCase() === "report");
  if (!header || report === -1) throw new Error("data/applications.md has no tracker table with # and Report columns.");
  return { number: 0, report };
}

function cellsOf(line: string): string[] {
  if (!line.trim().startsWith("|")) return [];
  return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

/** The report file a Report cell links, when it is a numbered file inside reports/. */
function reportRef(cell: string): ReportRef | null {
  const target = firstMarkdownLinkTarget(cell);
  if (!target) return null;
  const root = careerOpsRoot();
  const reportsDir = path.join(root, "reports");
  for (const dir of trackerLinkDirs(root)) {
    const file = path.resolve(dir, target);
    const match = path.basename(file).match(REPORT_FILE);
    if (match && path.dirname(file) === reportsDir) return { file, number: match[1], name: match[2] };
  }
  return null;
}

function reportOwnedFiles(root: string, report: ReportRef): string[] {
  const cvFile = new RegExp(`^cv-.+-${report.number}-${escapeRegExp(report.name)}(\\.overflow-\\d+)?\\.(pdf|html)$`);
  const additionFile = new RegExp(`^0*${Number(report.number)}-.*\\.tsv$`);
  return [
    report.file,
    ...filesIn(path.join(root, "output"), (name) => cvFile.test(name)),
    ...filesIn(path.join(root, "batch", "tracker-additions"), (name) => additionFile.test(name)).filter((file) =>
      fs.readFileSync(file, "utf8").includes(`${report.number}-${report.name}.md`),
    ),
  ];
}

function filesIn(dir: string, keep: (name: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && keep(entry.name))
    .map((entry) => path.join(dir, entry.name));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type TrackerTransaction = { read: () => string; replace: (content: string) => void; close: () => unknown };
type TrackerUtils = { openTrackerTransaction: (trackerPath: string) => Promise<TrackerTransaction> };

async function trackerUtils(): Promise<TrackerUtils> {
  const file = path.join(resolveCodeRoot(process.cwd(), process.env), "tracker-utils.mjs");
  const mod = (await import(/* webpackIgnore: true */ pathToFileURL(file).href)) as Partial<TrackerUtils>;
  if (typeof mod.openTrackerTransaction !== "function") throw new Error(`${file} has no openTrackerTransaction export.`);
  return mod as TrackerUtils;
}

const REPORT_FILE = /^(\d{3,})-(.+)\.md$/;
