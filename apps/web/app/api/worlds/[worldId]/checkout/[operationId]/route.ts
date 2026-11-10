import { checkoutAction, checkoutStatus } from "../../../../../../lib/checkout-http";
export const runtime = "nodejs";
type Context = { params: Promise<{ worldId: string; operationId: string }> };
export async function GET(req: Request, context: Context) {
  const { worldId, operationId } = await context.params;
  return checkoutStatus(req, worldId, operationId);
}
export async function POST(req: Request, context: Context) {
  const { worldId, operationId } = await context.params;
  return checkoutAction(req, worldId, operationId);
}
