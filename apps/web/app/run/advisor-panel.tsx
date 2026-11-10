"use client";

import type { PlayerCommand, RunView } from "@fle/run";
import { useEffect, useId, useRef, useState } from "react";
import type { SaveToken } from "../../lib/run-save";

export interface AdvisorPanelProps {
  readonly save: SaveToken;
  readonly view: RunView;
  /** Sends a command the player confirmed, through the same path as every other action. */
  readonly onCommand: (command: PlayerCommand) => Promise<void>;
}

type Mode = "ask" | "do";
const MAX_TEXT = 300;

/** What POST /api/run/advisor answers (lib/run-advisor.ts). Parsed defensively: it is a network body. */
type Answer =
  | { kind: "ask"; facts: string[]; answer: string; source: "model" | "stand-in" }
  | { kind: "proposal"; command: PlayerCommand; summary: string; source: "model" | "rules" }
  | { kind: "refusal"; message: string }
  | { kind: "unclear"; hint: string }
  | { kind: "error"; message: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

function readAnswer(json: unknown): Answer {
  const failed: Answer = { kind: "error", message: "The advisor sent back something unexpected." };
  if (!isObject(json)) return failed;
  if (isStrings(json.facts) && typeof json.answer === "string") {
    return {
      kind: "ask",
      facts: json.facts,
      answer: json.answer,
      source: json.source === "model" ? "model" : "stand-in",
    };
  }
  if (isObject(json.proposal) && typeof json.summary === "string") {
    return {
      kind: "proposal",
      command: json.proposal as unknown as PlayerCommand,
      summary: json.summary,
      source: json.source === "model" ? "model" : "rules",
    };
  }
  if (isObject(json.refusal) && typeof json.refusal.message === "string") {
    return { kind: "refusal", message: json.refusal.message };
  }
  if (json.unclear === true && typeof json.hint === "string") {
    return { kind: "unclear", hint: json.hint };
  }
  return failed;
}

async function callAdvisor(mode: Mode, text: string, save: SaveToken): Promise<Answer> {
  let res: Response;
  try {
    res = await fetch("/api/run/advisor", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode, text, save }),
    });
  } catch {
    return { kind: "error", message: "Could not reach the game. Check your connection." };
  }
  if (res.status === 429) {
    return { kind: "error", message: "That was a lot of questions. Wait a minute and try again." };
  }
  if (res.status === 403 || res.status === 409) {
    return {
      kind: "error",
      message: "We could not verify this saved run, so we cannot advise on it.",
    };
  }
  if (res.status === 404) {
    return { kind: "error", message: "The advisor is not switched on in this version of the app." };
  }
  if (res.status !== 200) {
    return { kind: "error", message: "The advisor could not answer just now. Try again." };
  }
  try {
    return readAnswer(await res.json());
  } catch {
    return { kind: "error", message: "The advisor sent back something unexpected." };
  }
}

const HELP: Record<Mode, { label: string; hint: string; examples: string }> = {
  ask: {
    label: "Ask about your money",
    hint: "Explanations only. Nothing you ask changes your run.",
    examples: "For example: Can I afford the course? Why is my cash lower than my profit?",
  },
  do: {
    label: "Say what you want to do",
    hint: "We turn your words into one action and show it to you first. Nothing happens until you confirm.",
    examples: "For example: borrow 200 from a friend. Pay the rent. Put 300 into the studio.",
  },
};

/** Ask about your money; typed requests become actions you confirm. All money here is fictional. */
export function AdvisorPanel({ save, view, onCommand }: AdvisorPanelProps) {
  const [mode, setMode] = useState<Mode>("ask");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [sending, setSending] = useState(false);
  const fieldId = useId();
  const hintId = useId();
  // A reply belongs to the day it was written for: once time moves on it may no longer be true.
  const askedDay = useRef(view.day);
  const latest = useRef(0);

  useEffect(() => {
    if (answer && askedDay.current !== view.day) setAnswer(null);
  }, [view.day, answer]);

  const help = HELP[mode];
  const clean = text.trim();

  async function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    if (busy || clean.length === 0) return;
    const ticket = ++latest.current;
    setBusy(true);
    setAnswer(null);
    askedDay.current = view.day;
    const result = await callAdvisor(mode, clean, save);
    // Ignore a slow reply if the player has moved on to another question or tab.
    if (ticket === latest.current) setAnswer(result);
    setBusy(false);
  }

  async function confirm(command: PlayerCommand) {
    if (sending) return;
    setSending(true);
    try {
      await onCommand(command);
    } finally {
      setSending(false);
      setAnswer(null);
      setText("");
    }
  }

  function pick(next: Mode) {
    latest.current += 1;
    setMode(next);
    setAnswer(null);
    setBusy(false);
  }

  return (
    <section className="run-panel advisor" aria-labelledby={`${fieldId}-h`} data-testid="advisor">
      <style>{ADVISOR_CSS}</style>
      <h2 id={`${fieldId}-h`} className="run-sr">
        Advisor
      </h2>
      <fieldset className="advisor-tabs">
        <legend className="run-sr">What would you like to do?</legend>
        {(["ask", "do"] as const).map((m) => (
          <button
            key={m}
            type="button"
            className="advisor-tab"
            aria-pressed={mode === m}
            data-testid={`advisor-tab-${m}`}
            onClick={() => pick(m)}
          >
            {m === "ask" ? "Ask" : "Do"}
          </button>
        ))}
      </fieldset>

      <form onSubmit={submit} className="advisor-form">
        <label htmlFor={fieldId} className="advisor-label">
          {help.label}
        </label>
        <p id={hintId} className="small muted advisor-hint">
          {help.hint} {help.examples}
        </p>
        <textarea
          id={fieldId}
          className="run-input advisor-input"
          rows={2}
          maxLength={MAX_TEXT}
          value={text}
          aria-describedby={hintId}
          data-testid="advisor-input"
          onChange={(e) => {
            setText(e.target.value);
            // Words changed, so any action built from the old words must not stay on offer.
            if (answer?.kind === "proposal") setAnswer(null);
          }}
        />
        <div className="advisor-row">
          <span className="small muted">
            {clean.length}/{MAX_TEXT}
          </span>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || clean.length === 0}
            data-testid="advisor-send"
          >
            {busy ? "Thinking..." : mode === "ask" ? "Ask" : "Show me the action"}
          </button>
        </div>
      </form>

      <div className="advisor-out" aria-live="polite" data-testid="advisor-out">
        {answer?.kind === "ask" ? <AskOut answer={answer} /> : null}
        {answer?.kind === "proposal" ? (
          <ProposalOut
            answer={answer}
            sending={sending}
            onConfirm={() => confirm(answer.command)}
            onCancel={() => setAnswer(null)}
          />
        ) : null}
        {answer?.kind === "refusal" ? (
          <p className="advisor-note" data-testid="advisor-refusal">
            <strong>The game would not allow that.</strong> {answer.message}
          </p>
        ) : null}
        {answer?.kind === "unclear" ? (
          <p className="advisor-note" data-testid="advisor-unclear">
            {answer.hint}
          </p>
        ) : null}
        {answer?.kind === "error" ? (
          <p className="advisor-note advisor-error" role="alert">
            {answer.message}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function AskOut({ answer }: { answer: Extract<Answer, { kind: "ask" }> }) {
  return (
    <div data-testid="advisor-ask-out">
      <h3 className="run-h-sub">What is true right now</h3>
      <p className="small muted advisor-hint">
        Every number is here, written by the game from your run.
      </p>
      <ul className="advisor-facts">
        {answer.facts.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      <h3 className="run-h-sub">
        {answer.source === "model"
          ? "Explanation (AI, may be imperfect)"
          : "Explanation (written by the game, not AI)"}
      </h3>
      <p className="advisor-prose">{answer.answer}</p>
    </div>
  );
}

function ProposalOut({
  answer,
  sending,
  onConfirm,
  onCancel,
}: {
  answer: Extract<Answer, { kind: "proposal" }>;
  sending: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  return (
    <fieldset className="advisor-confirm" data-testid="advisor-proposal">
      <legend>Check this before you confirm</legend>
      <p className="mt-0">{answer.summary}</p>
      <p className="small muted advisor-hint">
        {answer.source === "model"
          ? "Your words were read by AI, then checked by the game's rules."
          : "Your words were read by simple rules, then checked by the game's rules."}{" "}
        Nothing has changed yet.
      </p>
      <div className="advisor-row">
        <button
          type="button"
          className="btn btn-primary"
          disabled={sending}
          onClick={onConfirm}
          data-testid="advisor-confirm"
        >
          Confirm
        </button>
        <button type="button" className="btn" disabled={sending} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </fieldset>
  );
}

/** Scoped to .advisor; colours and spacing come from the Run's own variables. */
const ADVISOR_CSS = `
.advisor-tabs{border:0;padding:0;min-width:0;display:flex;gap:var(--space-2);margin-bottom:var(--space-3)}
.advisor-tab{flex:1;min-height:44px;padding:var(--space-2) var(--space-3);border:1px solid var(--color-control-border);border-radius:var(--radius-sm);background:transparent;color:var(--color-ink);font:inherit;cursor:pointer}
.advisor-tab[aria-pressed="true"]{background:var(--color-accent);border-color:var(--color-accent);color:var(--color-accent-ink);font-weight:650}
.advisor-tab:focus-visible,.advisor-input:focus-visible{outline:3px solid var(--color-focus);outline-offset:2px}
.advisor-label{display:block;font-weight:650;margin-bottom:var(--space-1)}
.advisor-hint{margin:0 0 var(--space-2)}
.advisor-input{display:block;width:100%;box-sizing:border-box;min-height:64px;resize:vertical;font:inherit}
.advisor-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--space-2);margin-top:var(--space-2)}
.advisor-out{margin-top:var(--space-3);min-width:0}
.advisor-facts{margin:0;padding-left:var(--space-4);display:grid;gap:var(--space-1)}
.advisor-prose{margin:0;font-family:var(--run-serif,inherit);line-height:1.5}
.advisor-note{margin:0;padding:var(--space-3);border:1px solid var(--color-line);border-radius:var(--radius-sm);background:var(--tone-other-bg);color:var(--tone-other-ink)}
.advisor-error{background:var(--tone-overdue-bg);color:var(--tone-overdue-ink)}
.advisor-confirm{margin:0;padding:var(--space-3);border:1px solid var(--color-accent);border-radius:var(--radius-sm);min-width:0}
.advisor-confirm legend{padding:0 var(--space-1);font-weight:650}
@media (max-width:480px){.advisor-row .btn{flex:1}}
`;
