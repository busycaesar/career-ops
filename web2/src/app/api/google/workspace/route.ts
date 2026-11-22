import { readWorkspace, saveWorkspacePick } from "@/lib/google/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(readWorkspace());
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if ((body?.kind !== "folder" && body?.kind !== "master") || typeof body?.id !== "string") {
    return Response.json({ error: "Send kind (folder or master) and the picked file id." }, { status: 400 });
  }
  try {
    return Response.json(await saveWorkspacePick(body.kind, body.id));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
