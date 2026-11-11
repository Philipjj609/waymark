import Link from "next/link";
import { runEnabled } from "../../lib/run-save";
import { CheckoutPanel } from "./checkout-panel";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const worldId = typeof params.worldId === "string" ? params.worldId : "";
  const obligationId = typeof params.obligationId === "string" ? params.obligationId : undefined;
  // A checkout pays one bill in one world. Opened bare (an old bookmark or link), there is nothing
  // to pay, so explain where payments start instead of showing a button that can never be used.
  if (!worldId || !obligationId) return <NoBill run={runEnabled()} />;
  return <CheckoutPanel worldId={worldId} obligationId={obligationId} />;
}

function NoBill({ run }: { run: boolean }) {
  return (
    <main id="main-content" style={{ maxWidth: 640, margin: "3rem auto", padding: "1.5rem" }}>
      <h1>PayPal Sandbox checkout</h1>
      <p>
        A Sandbox payment always pays a specific bill, so it starts from that bill inside a Run.
        Open a bill in your Run and choose to pay it with PayPal Sandbox.
      </p>
      <p className="small muted">
        PayPal Sandbox uses test money: no real money moves. The bills and cash in the game are
        fictional.
      </p>
      <p>
        {run ? (
          <Link className="btn-link btn-primary" href="/run">
            Go to Practise
          </Link>
        ) : (
          <Link className="btn-link btn-primary" href="/learn">
            Go to Learn
          </Link>
        )}
      </p>
    </main>
  );
}
