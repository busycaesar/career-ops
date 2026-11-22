"use client";

import { useState } from "react";
import type { DriveWorkspace } from "@/lib/google/workspace";

const GAPI_SRC = "https://apis.google.com/js/api.js";
const MASTER_TYPES = "application/vnd.google-apps.document,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type PickerConfig = { accessToken: string; apiKey: string; appId: string };
type PickKind = "folder" | "master";

/* Google's picker is a global script; typed loosely because it ships no types. */
type GoogleGlobal = any;

export function DriveWorkspacePicker({ initial }: { initial: DriveWorkspace }) {
  const [workspace, setWorkspace] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  async function pick(kind: PickKind) {
    setError(null);
    try {
      const configResponse = await fetch("/api/google/picker-config", { cache: "no-store" });
      const config = (await configResponse.json()) as PickerConfig & { error?: string };
      if (!configResponse.ok) throw new Error(config.error);
      const google = await loadPicker();
      const fileId = await openPicker(google, config, kind, workspace.folder?.id);
      if (!fileId) return;
      const saveResponse = await fetch("/api/google/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, id: fileId }),
      });
      const saved = await saveResponse.json();
      if (!saveResponse.ok) throw new Error(saved.error);
      setWorkspace(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="mt-5 space-y-3 border-t border-border pt-4 text-sm">
      <PickRow label="Workspace folder" value={workspace.folder?.name} onPick={() => pick("folder")} />
      <PickRow label="Reference resume (format only)" value={workspace.master?.name} onPick={() => pick("master")} disabled={!workspace.folder} />
      {error && <p className="text-red-400">{error}</p>}
    </div>
  );
}

function PickRow({ label, value, onPick, disabled }: { label: string; value?: string; onPick: () => void; disabled?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <p className="text-muted">{label}</p>
        <p className={value ? "text-foreground" : "text-faint"}>{value ?? "Not picked"}</p>
      </div>
      <button
        type="button"
        onClick={onPick}
        disabled={disabled}
        className="rounded-md border border-border px-3 py-1.5 text-muted hover:bg-surface-hover hover:text-foreground disabled:opacity-40"
      >
        {value ? "Change" : "Pick"}
      </button>
    </div>
  );
}

function loadPicker(): Promise<GoogleGlobal> {
  return new Promise((resolve, reject) => {
    const ready = () => (window as GoogleGlobal).gapi.load("picker", { callback: () => resolve((window as GoogleGlobal).google), onerror: () => reject(new Error("Google's picker failed to load.")) });
    if ((window as GoogleGlobal).gapi) return ready();
    const script = document.createElement("script");
    script.src = GAPI_SRC;
    script.onload = ready;
    script.onerror = () => reject(new Error("Could not load Google's picker script."));
    document.body.appendChild(script);
  });
}

function openPicker(google: GoogleGlobal, config: PickerConfig, kind: PickKind, folderId?: string): Promise<string | null> {
  return new Promise((resolve) => {
    const { picker } = google;
    const view =
      kind === "folder"
        ? new picker.DocsView(picker.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes("application/vnd.google-apps.folder")
        : new picker.DocsView(picker.ViewId.DOCS).setMimeTypes(MASTER_TYPES).setParent(folderId ?? "root");
    new picker.PickerBuilder()
      .setTitle(kind === "folder" ? "Pick the career-ops folder" : "Pick the reference resume (format only)")
      .addView(view)
      .setOAuthToken(config.accessToken)
      .setDeveloperKey(config.apiKey)
      .setAppId(config.appId)
      .setCallback((data: GoogleGlobal) => {
        if (data.action === picker.Action.PICKED) resolve(data.docs[0].id);
        else if (data.action === picker.Action.CANCEL) resolve(null);
      })
      .build()
      .setVisible(true);
  });
}
