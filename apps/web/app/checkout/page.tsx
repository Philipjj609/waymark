import { CheckoutPanel } from "./checkout-panel";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return (
    <CheckoutPanel
      worldId={typeof params.worldId === "string" ? params.worldId : ""}
      obligationId={typeof params.obligationId === "string" ? params.obligationId : undefined}
    />
  );
}
