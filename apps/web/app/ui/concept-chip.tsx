"use client";

import Link from "next/link";
import { createContext, type ReactNode, useContext } from "react";

/** Concept id to where it lives in Learn. Built on the server (concept-links.ts), passed down once. */
export type ConceptLinks = Readonly<
  Record<string, { readonly label: string; readonly href: string; readonly hasLesson: boolean }>
>;

const Links = createContext<ConceptLinks>({});

export function ConceptLinksProvider({
  links,
  children,
}: {
  links: ConceptLinks;
  children: ReactNode;
}) {
  return <Links.Provider value={links}>{children}</Links.Provider>;
}

/** "cpt_cash_balance" -> "cash balance", for ids Learn does not know. */
const words = (id: string) => {
  const w = id.replace(/^cpt_/, "").replaceAll("_", " ");
  return w.charAt(0).toUpperCase() + w.slice(1);
};

/**
 * A concept as a small link: to its lesson when one exists, otherwise to the knowledge map.
 * Used by the Run to point at the idea behind what just happened.
 */
export function ConceptChip({ conceptId, label }: { conceptId: string; label?: string }) {
  const known = useContext(Links)[conceptId];
  const href = known?.href ?? "/learn/map";
  const text = label ?? known?.label ?? words(conceptId);
  const lesson = known?.hasLesson ?? false;
  return (
    <Link
      className="concept-chip"
      href={href}
      data-testid="concept-chip"
      title={lesson ? `Open the lesson: ${text}` : `See ${text} on the knowledge map`}
    >
      {text}
    </Link>
  );
}

/** A labelled row of chips; renders nothing for an empty list. */
export function ConceptRow({
  concepts,
  label = "Ideas behind this",
}: {
  concepts: readonly { conceptId: string; label?: string }[];
  label?: string;
}) {
  if (concepts.length === 0) return null;
  return (
    <p className="concept-row">
      {label ? <span className="concept-row-label">{label}</span> : null}
      {concepts.map((c) => (
        <ConceptChip
          key={c.conceptId}
          conceptId={c.conceptId}
          {...(c.label ? { label: c.label } : {})}
        />
      ))}
    </p>
  );
}
