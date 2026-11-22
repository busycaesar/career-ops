import { readJobPreferences, saveJobPreferences, validateJobPreferences } from "@/lib/preferences";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json({ preferences: readJobPreferences() });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Could not read preferences." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const validated = validateJobPreferences(body);
  if (!validated.ok) return Response.json({ error: validated.error }, { status: 400 });

  try {
    const { syncedFiles } = saveJobPreferences(validated.value);
    return Response.json({
      ok: true,
      syncedFiles,
      preferences: readJobPreferences(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not save preferences.";
    const status = /valid YAML|mapping/i.test(message) ? 409 : 500;
    return Response.json({ error: message }, { status });
  }
}
