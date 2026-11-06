import { WorldIdSchema } from "@fle/contracts";
import { getWorld } from "@fle/server";
import { errorResponse, guarded, json, SERVICE_STATUS, worldNotFound } from "../../../../lib/http";
import { readSession } from "../../../../lib/session";
import { getStore } from "../../../../lib/store";

export const runtime = "nodejs";

/** Snapshot of one of the caller's worlds. No session, a bad id and another session's world all 404. */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ worldId: string }> },
): Promise<Response> {
  return guarded(async () => {
    const session = readSession(req);
    const worldId = WorldIdSchema.safeParse((await ctx.params).worldId);
    if (!session || !worldId.success) return worldNotFound();

    const r = await getWorld(getStore(), session.hash, worldId.data);
    if (!r.ok) return errorResponse(SERVICE_STATUS[r.error.code], r.error.code, r.error.message);
    return json({ snapshot: r.snapshot });
  });
}
