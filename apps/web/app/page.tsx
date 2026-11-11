import Link from "next/link";
import { runEnabled } from "../lib/run-save";
import { ContinueCards } from "./ui/continue-cards";

/** The Run switch is read per request (see runEnabled), so the page cannot be prerendered. */
export const dynamic = "force-dynamic";

const WEEK = ["M", "T", "W", "T", "F", "S", "S"];

export default function Landing() {
  const run = runEnabled();
  return (
    <main id="main-content" className="home">
      <h1>Learn money by studying it, then by living it.</h1>
      <p className="home-lede" data-testid="what-is-waymark">
        Waymark teaches everyday money in two ways: short lessons with a tutor that listens to your
        reasoning, and a practice life you play one week at a time. Every euro in the game is made
        up, so you can make the mistakes here.
      </p>

      <ContinueCards runEnabled={run} />

      <section className="doors" aria-label="Choose how to start">
        <article className="door door-learn">
          <h2>
            <Link href="/learn">Learn the ideas</Link>
          </h2>
          <p>Cash, bills, invoices and liquidity, explained with numbers you can change.</p>
          <div className="door-art" aria-hidden="true">
            <span className="door-chip">Cash balance</span>
            <span className="door-chip">Obligation</span>
            <span className="door-chip">Liquidity</span>
          </div>
          <div className="door-actions">
            <Link className="btn-link btn-primary" href="/learn/lessons/cash-balance">
              Start the first lesson
            </Link>
            <Link className="btn-link" href="/learn/map">
              See the knowledge map
            </Link>
          </div>
        </article>

        <article className="door door-run">
          <h2>{run ? <Link href="/run">Live them in a Run</Link> : "Live them in a Run"}</h2>
          <p>
            Pay rent, run a small business, borrow, ask an advisor. Time moves one week at a time
            and you decide.
          </p>
          <ol className="mini-week" aria-hidden="true">
            {WEEK.map((d, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: a fixed decorative week
                key={i}
                {...(i < 2 ? { "data-gone": "" } : {})}
                {...(i === 2 ? { "data-today": "" } : {})}
              >
                {d}
              </li>
            ))}
          </ol>
          <div className="door-actions">
            {run ? (
              <>
                <Link className="btn-link btn-primary" href="/run?demo=1">
                  Try the 3-minute demo
                </Link>
                <Link className="btn-link" href="/run">
                  Start your own Run
                </Link>
              </>
            ) : (
              <p className="small muted">The Run is not switched on in this version.</p>
            )}
          </div>
        </article>
      </section>

      <section className="home-notes" aria-label="How money is shown">
        <div className="home-note">
          <h2>Game money is made up</h2>
          <p>
            Amounts in lessons and Runs are fictional and marked{" "}
            <span className="practice-tag">practice</span>. Nothing here is financial advice.
          </p>
        </div>
        <div className="home-note">
          <h2>PayPal payments are test money</h2>
          <p>
            Paying a bill inside a Run goes through PayPal Sandbox and is labelled{" "}
            <span className="sandbox-badge">PayPal Sandbox, test money</span>. No real money moves.
          </p>
        </div>
        <div className="home-note">
          <h2>The AI explains, the game decides</h2>
          <p>
            The tutor and advisor suggest and explain. The rules of the game check everything before
            it changes your run.
          </p>
        </div>
      </section>
    </main>
  );
}
