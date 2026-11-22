import { isGoogleConnected } from "@/lib/google/oauth";
import { readWorkspace } from "@/lib/google/workspace";
import { DriveWorkspacePicker } from "@/components/settings/drive-workspace-picker";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ google?: string }> }) {
  const { google } = await searchParams;
  const connected = isGoogleConnected();
  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <section className="mt-8 rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold">Google Drive</h2>
        <p className="mt-1 text-sm text-muted">Tailored CVs copy the format of your reference resume, with content from cv.md, and are saved in your career-ops Drive folder.</p>
        {google && google !== "connected" && <p className="mt-3 text-sm text-red-400">{google}</p>}
        <div className="mt-4 flex items-center gap-3">
          <span className={connected ? "text-sm text-emerald-400" : "text-sm text-amber-300"}>{connected ? "Connected" : "Not connected"}</span>
          <a href="/api/google/connect" className="rounded-full bg-brand px-4 py-2 text-sm font-medium text-zinc-950">
            {connected ? "Reconnect" : "Connect Google Drive"}
          </a>
        </div>
        {connected && <DriveWorkspacePicker initial={readWorkspace()} />}
      </section>
    </div>
  );
}
