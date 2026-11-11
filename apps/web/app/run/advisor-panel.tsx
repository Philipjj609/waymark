"use client";

import type { PlayerCommand, RunView } from "@fle/run";
import { useEffect, useId, useRef, useState } from "react";
import type { SaveToken } from "../../lib/run-save";
import { AiBlock, AiThinking } from "../ui/ai-block";
import { ConceptRow } from "../ui/concept-chip";

export interface AdvisorPanelProps {
  readonly save: SaveToken;
  readonly view: RunView;
  /** Sends a command the player confirmed, through the same path as every other action. */
  readonly onCommand: (command: PlayerCommand) => Promise<void>;
}

type Mode = "ask" | "do";
const MAX_TEXT = 300;

/** Window events between the screens and this panel (kept here: the panel is client code). */
export const ASK_EVENT = "run:ask";
export const ASKED_EVENT = "run:asked";
/** The one-tap question; the server answers it with the single most useful next step. */
export const WHAT_NOW_QUESTION = "What should I do now?";

/** A question sent from a button elsewhere: its text if usable (1 to 300 characters), else null. */
export function askFromEvent(detail: unknown): string | null {
  if (typeof detail !== "object" || detail === null) return null;
  const text = (detail as { text?: unknown }).text;
  if (typeof text !== "string") return null;
  const clean = text
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > 0 && clean.length <= MAX_TEXT ? clean : null;
}

/** What POST /api/run/advisor answers (lib/run-advisor.ts). Parsed defensively: it is a network body. */
type Answer =
  | {
      kind: "ask";
      facts: string[];
      relevant: string[];
      lead: string | null;
      answer: string;
      source: "model" | "stand-in";
      checked: boolean;
      proposal: PlayerCommand | null;
      summary: string | null;
    }
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
    const model = json.source === "model";
    return {
      kind: "ask",
      facts: json.facts,
      relevant: isStrings(json.relevant) ? json.relevant : json.facts.slice(0, 5),
      lead: typeof json.lead === "string" && json.lead.length > 0 ? json.lead : null,
      answer: json.answer,
      source: model ? "model" : "stand-in",
      checked: model && json.checked === true,
      proposal: isObject(json.proposal) ? (json.proposal as unknown as PlayerCommand) : null,
      summary: typeof json.summary === "string" ? json.summary : null,
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

  async function run(asMode: Mode, question: string) {
    const ticket = ++latest.current;
    setBusy(true);
    setAnswer(null);
    askedDay.current = view.day;
    const result = await callAdvisor(asMode, question, save);
    // Ignore a slow reply if the player has moved on to another question or tab.
    if (ticket === latest.current) {
      setAnswer(result);
      // Entry points elsewhere on the page listen for this to know an answer is on screen.
      window.dispatchEvent(
        new CustomEvent(ASKED_EVENT, {
          detail: { text: question, mode: asMode, kind: result.kind },
        }),
      );
      setBusy(false);
    }
  }

  async function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    if (busy || clean.length === 0) return;
    await run(mode, clean);
  }

  // A question sent from a button elsewhere (event "run:ask", detail {text}) is filled in, asked,
  // and the panel brought into view. The latest closure lives in a ref so the listener binds once.
  const root = useRef<HTMLElement | null>(null);
  const asker = useRef<(question: string) => void>(() => {});
  asker.current = (question: string) => {
    setMode("ask");
    setText(question);
    root.current?.scrollIntoView({ block: "center" });
    root.current?.focus({ preventScroll: true });
    void run("ask", question);
  };
  useEffect(() => {
    const onAsk = (e: Event) => {
      const question = askFromEvent((e as CustomEvent).detail);
      if (question) asker.current(question);
    };
    window.addEventListener(ASK_EVENT, onAsk);
    return () => window.removeEventListener(ASK_EVENT, onAsk);
  }, []);

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
    <section
      ref={root}
      tabIndex={-1}
      className="run-panel advisor"
      aria-labelledby={`${fieldId}-h`}
      data-testid="advisor"
    >
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

      {mode === "ask" ? (
        <button
          type="button"
          className="btn advisor-now"
          disabled={busy}
          data-testid="advisor-now"
          onClick={() => asker.current(WHAT_NOW_QUESTION)}
        >
          {WHAT_NOW_QUESTION}
        </button>
      ) : null}

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
        {busy ? <AiThinking text="Thinking…" /> : null}
        {answer?.kind === "ask" ? (
          <AskOut
            answer={answer}
            concepts={view.learning.notes
              .slice(-3)
              .map((n) => ({ conceptId: n.conceptId, label: n.label }))}
            sending={sending}
            onConfirm={(command) => confirm(command)}
            onCancel={() => setAnswer(null)}
          />
        ) : null}
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

function AskOut({
  answer,
  concepts,
  sending,
  onConfirm,
  onCancel,
}: {
  answer: Extract<Answer, { kind: "ask" }>;
  /** Ideas this run has touched, as links into Learn. */
  concepts: readonly { conceptId: string; label: string }[];
  sending: boolean;
  onConfirm(command: PlayerCommand): void;
  onCancel(): void;
}) {
  const proposal = answer.proposal;
  return (
    <div data-testid="advisor-ask-out">
      {answer.lead ? (
        <p className="advisor-lead" data-testid="advisor-lead">
          {answer.lead}
        </p>
      ) : null}
      {proposal && answer.summary ? (
        <ProposalOut
          answer={{ kind: "proposal", command: proposal, summary: answer.summary, source: "rules" }}
          sending={sending}
          onConfirm={() => onConfirm(proposal)}
          onCancel={onCancel}
          advice
        />
      ) : null}
      <AiBlock
        factsTitle="Facts from your run, worked out by the game"
        source={answer.source === "model" ? "model" : "game"}
        wordingLabel={
          answer.source === "model"
            ? "Wording: AI, checked against the facts"
            : "Wording: written by the game"
        }
        checked={answer.checked}
        wordingTestId="advisor-wording"
        checkedTestId="advisor-checked"
        facts={
          <>
            <ul className="advisor-facts" data-testid="advisor-relevant">
              {answer.relevant.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
            <details className="advisor-all">
              <summary>All facts</summary>
              <ul className="advisor-facts">
                {answer.facts.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </details>
          </>
        }
      >
        <p className="advisor-prose ai-prose">{answer.answer}</p>
      </AiBlock>
      <ConceptRow concepts={concepts} label="Ideas your run has touched" />
    </div>
  );
}

function ProposalOut({
  answer,
  sending,
  onConfirm,
  onCancel,
  advice = false,
}: {
  answer: Extract<Answer, { kind: "proposal" }>;
  sending: boolean;
  onConfirm(): void;
  onCancel(): void;
  /** True for the "what should I do now" suggestion: no typed words were read. */
  advice?: boolean;
}) {
  return (
    <fieldset className="advisor-confirm" data-testid="advisor-proposal">
      <legend>Check this before you confirm</legend>
      <p className="mt-0">{answer.summary}</p>
      <p className="small muted advisor-hint">
        {advice
          ? "This suggestion comes from your run and is checked by the game's rules."
          : answer.source === "model"
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
          {advice ? "Do it" : "Confirm"}
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
.advisor-now{width:100%;margin-bottom:var(--space-3)}
.advisor-lead{margin:0 0 var(--space-3);font-weight:650;line-height:1.45}
.advisor-out .ai-block{margin-top:var(--space-3)}
.advisor-all{margin-top:var(--space-2)}
.advisor-all summary{cursor:pointer;min-height:44px;display:flex;align-items:center}
.advisor-all summary:focus-visible,.advisor-now:focus-visible,.advisor:focus-visible{outline:3px solid var(--color-focus);outline-offset:2px}
.advisor-note{margin:0;padding:var(--space-3);border:1px solid var(--color-line);border-radius:var(--radius-sm);background:var(--tone-other-bg);color:var(--tone-other-ink)}
.advisor-error{background:var(--tone-overdue-bg);color:var(--tone-overdue-ink)}
.advisor-confirm{margin:0;padding:var(--space-3);border:1px solid var(--color-accent);border-radius:var(--radius-sm);min-width:0}
.advisor-confirm legend{padding:0 var(--space-1);font-weight:650}
@media (max-width:480px){.advisor-row .btn{flex:1}}
`;
