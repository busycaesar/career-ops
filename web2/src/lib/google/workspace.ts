import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { atomicWrite } from "@/lib/core/safe-write";
import { googleAccessToken } from "@/lib/google/oauth";

/**
 * The one Drive folder web2 works in, and the master resume Doc inside it,
 * both picked by the user in Google's file picker (which is what grants
 * web2's drive.file permission access to them). Kept in
 * data/google-workspace.json.
 */

export type PickedFile = { id: string; name: string };
export type DriveWorkspace = { folder?: PickedFile; master?: PickedFile };

const FOLDER_TYPE = "application/vnd.google-apps.folder";
const DOC_TYPE = "application/vnd.google-apps.document";
const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function workspaceFile(): string {
  return path.join(careerOpsRoot(), "data", "google-workspace.json");
}

export function readWorkspace(): DriveWorkspace {
  try {
    return JSON.parse(fs.readFileSync(workspaceFile(), "utf8")) as DriveWorkspace;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

/** Record a picked folder or master Doc, after checking with Drive that it is what it claims to be. */
export async function saveWorkspacePick(kind: "folder" | "master", fileId: string): Promise<DriveWorkspace> {
  const file = await driveFile(fileId);
  const workspace = readWorkspace();
  if (kind === "folder") {
    if (file.mimeType !== FOLDER_TYPE) throw new Error(`"${file.name}" is not a folder.`);
    workspace.folder = { id: file.id, name: file.name };
    if (workspace.master && !(await isInFolder(workspace.master.id, file.id))) delete workspace.master;
  } else {
    if (!workspace.folder) throw new Error("Pick the workspace folder first.");
    if (!file.parents?.includes(workspace.folder.id)) throw new Error(`"${file.name}" is not inside the "${workspace.folder.name}" folder.`);
    if (file.mimeType === DOC_TYPE) workspace.master = { id: file.id, name: file.name };
    else if (file.mimeType === DOCX_TYPE) workspace.master = await convertToGoogleDoc(file, workspace.folder.id);
    else throw new Error(`"${file.name}" is not a Word file or a Google Doc.`);
  }
  atomicWrite(workspaceFile(), `${JSON.stringify(workspace, null, 2)}\n`);
  return workspace;
}

type DriveFileMeta = { id: string; name: string; mimeType: string; parents?: string[] };

async function driveFile(fileId: string): Promise<DriveFileMeta> {
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,parents`, {
    headers: { Authorization: `Bearer ${await googleAccessToken()}` },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Drive could not read that file: ${body.error?.message ?? `HTTP ${response.status}`}`);
  return body as DriveFileMeta;
}

/** A Google Doc copy of a picked Word file, in the same folder; the original is left untouched. */
async function convertToGoogleDoc(file: DriveFileMeta, folderId: string): Promise<PickedFile> {
  const name = `${file.name.replace(/\.docx$/i, "")} (Google Doc)`;
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/copy?fields=id,name`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await googleAccessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, parents: [folderId], mimeType: DOC_TYPE }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Could not convert "${file.name}" to a Google Doc: ${body.error?.message ?? `HTTP ${response.status}`}`);
  return { id: body.id, name: body.name };
}

async function isInFolder(fileId: string, folderId: string): Promise<boolean> {
  return (await driveFile(fileId)).parents?.includes(folderId) ?? false;
}
