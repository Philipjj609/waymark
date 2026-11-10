import { checkoutStart } from "../../../../../lib/checkout-http";
export const runtime = "nodejs";
export async function POST(req: Request, context: { params: Promise<{ worldId: string }> }) {
  return checkoutStart(req, (await context.params).worldId);
}
