import { conceptWords, euros } from "./format";

export interface ScenarioSummary {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly pressure: string;
  readonly cashMinor: number;
  readonly teaches: readonly string[];
}

/** Four starting points. Each says what you begin with and what makes it hard, not how to win. */
export function StartScreen({
  scenarios,
  canContinue,
  onStart,
  onContinue,
}: {
  scenarios: readonly ScenarioSummary[];
  canContinue: boolean;
  onStart: (scenarioId: string) => void;
  onContinue: () => void;
}) {
  return (
    <div data-testid="start-screen">
      <section className="run-panel run-intro" aria-labelledby="intro-h">
        <h2 id="intro-h" className="run-h run-h-big">
          Live a few years of money, in practice
        </h2>
        <p>
          Pick a starting point. Time moves in weeks. Bills arrive, chances turn up, and you decide
          what to do with your hours and your cash. Some things are luck. Nothing here is real
          money, and nothing you do here can cost you any.
        </p>
        {canContinue ? (
          <button
            type="button"
            className="btn btn-primary"
            data-testid="continue-run"
            onClick={onContinue}
          >
            Continue my run
          </button>
        ) : null}
      </section>

      <h2 className="run-h run-h-sub-lg">
        {canContinue ? "Or start a new one" : "Where do you start?"}
      </h2>
      <ul className="run-starts">
        {scenarios.map((s) => (
          <li key={s.id} className="run-card run-start" data-testid={`scenario-${s.id}`}>
            <h3 className="run-card-title">{s.title}</h3>
            <p className="mt-0">{s.summary}</p>
            <dl className="run-pairs run-pairs-stack">
              <div>
                <dt>You start with</dt>
                <dd className="figure">{euros(s.cashMinor)}</dd>
              </div>
              <div>
                <dt>What is hard</dt>
                <dd>{s.pressure}</dd>
              </div>
              <div>
                <dt>Ideas you will meet</dt>
                <dd>{s.teaches.map(conceptWords).join(", ")}</dd>
              </div>
            </dl>
            <button
              type="button"
              className="btn"
              data-testid={`start-${s.id}`}
              onClick={() => onStart(s.id)}
            >
              Start here
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
