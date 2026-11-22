import { addReferral, removeReferral, setReferralStatus } from "@/lib/board/referral-actions";
import { isReferralStatus, parseReferralInput } from "@/lib/board/referrals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Add, update (status) or remove a referral ask on one card. */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (typeof body?.key !== "string") return Response.json({ error: "Send a card key." }, { status: 400 });

  switch (body.action) {
    case "add": {
      const input = parseReferralInput(body);
      if ("error" in input) return Response.json({ error: input.error }, { status: 400 });
      return respond(await addReferral(body.key, input));
    }
    case "update": {
      if (typeof body.id !== "string") return Response.json({ error: "Send the referral id." }, { status: 400 });
      if (!isReferralStatus(body.status)) return Response.json({ error: "Status must be asked, referred or declined." }, { status: 400 });
      return respond(await setReferralStatus(body.key, body.id, body.status));
    }
    case "remove": {
      if (typeof body.id !== "string") return Response.json({ error: "Send the referral id." }, { status: 400 });
      return respond(removeReferral(body.key, body.id));
    }
    default:
      return Response.json({ error: "Action must be add, update or remove." }, { status: 400 });
  }
}

function respond(result: Awaited<ReturnType<typeof addReferral>>): Response {
  if (!result.ok) return Response.json({ error: result.error }, { status: 409 });
  return Response.json(result);
}
