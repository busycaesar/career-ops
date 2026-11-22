import { cookies } from "next/headers";
import { exchangeCodeForToken } from "@/lib/google/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_COOKIE = "web2_google_state";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const jar = await cookies();
  const expected = jar.get(STATE_COOKIE)?.value;
  jar.delete(STATE_COOKIE);
  const back = new URL("/settings", url.origin);
  if (url.searchParams.get("error")) {
    back.searchParams.set("google", `Google sign-in was cancelled: ${url.searchParams.get("error")}`);
    return Response.redirect(back, 302);
  }
  if (!expected || url.searchParams.get("state") !== expected) {
    back.searchParams.set("google", "Sign-in check failed (the request did not come from this app). Try Connect again.");
    return Response.redirect(back, 302);
  }
  try {
    await exchangeCodeForToken(url.searchParams.get("code") ?? "");
    back.searchParams.set("google", "connected");
  } catch (err) {
    back.searchParams.set("google", (err as Error).message);
  }
  return Response.redirect(back, 302);
}
