"use client";

import { type ReactNode, useEffect, useState } from "react";

/**
 * The "AI is working" state: a short line, and after two seconds the seconds so far, so a slow
 * model never looks like a frozen page. `live` makes it its own status region (the Run already
 * has a live region around the advisor, so it leaves this off).
 */
export function AiThinking({
  text = "Thinking…",
  live = false,
}: {
  text?: string;
  live?: boolean;
}) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = window.setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 500);
    return () => window.clearInterval(id);
  }, []);
  const content = (
    <>
      <span className="ai-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>{text}</span>
      {seconds >= 2 ? <span className="ai-thinking-sub">{seconds} s so far</span> : null}
    </>
  );
  return live ? (
    <p className="ai-thinking" role="status" data-testid="ai-thinking">
      {content}
    </p>
  ) : (
    <div className="ai-thinking" data-testid="ai-thinking">
      {content}
    </div>
  );
}

export type AiSource = "model" | "game" | "fallback";

/**
 * The shape every AI answer in Waymark has: the facts the game worked out come first, then the
 * AI's wording, labelled as such. `source` says who wrote the words and `checked` whether the
 * game's own check passed. The labels are given, never invented, so each caller keeps its own
 * provenance wording.
 */
export function AiBlock({
  facts,
  factsTitle = "Facts from your run",
  source,
  wordingLabel,
  checked = false,
  children,
  testId,
  wordingTestId,
  checkedTestId,
}: {
  facts: ReactNode;
  factsTitle?: string;
  source: AiSource;
  wordingLabel: string;
  checked?: boolean;
  children: ReactNode;
  testId?: string;
  wordingTestId?: string;
  checkedTestId?: string;
}) {
  return (
    <div className="ai-block" data-testid={testId}>
      <div className="ai-facts">
        <p className="ai-facts-title">{factsTitle}</p>
        {facts}
      </div>
      <div className="ai-words" data-source={source}>
        <p className="ai-label" data-testid={wordingTestId}>
          <span className="ai-mark" aria-hidden="true">
            {source === "model" ? "AI" : "·"}
          </span>
          {wordingLabel}
          {checked ? (
            <span className="ai-badge" data-testid={checkedTestId}>
              Checked
            </span>
          ) : null}
        </p>
        {children}
      </div>
    </div>
  );
}
