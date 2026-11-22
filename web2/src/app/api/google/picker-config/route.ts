import { pickerConfig } from "@/lib/google/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(await pickerConfig());
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
