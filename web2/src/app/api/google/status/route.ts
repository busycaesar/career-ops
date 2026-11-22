import { isGoogleConnected } from "@/lib/google/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ connected: isGoogleConnected() });
}
