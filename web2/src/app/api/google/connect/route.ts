import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { googleConsentUrl } from "@/lib/google/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_COOKIE = "web2_google_state";

export async function GET() {
  const state = randomBytes(16).toString("hex");
  (await cookies()).set(STATE_COOKIE, state, { httpOnly: true, sameSite: "lax", path: "/api/google", maxAge: 600 });
  return Response.redirect(googleConsentUrl(state), 302);
}
