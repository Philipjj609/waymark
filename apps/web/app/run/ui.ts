import type { Command, RunView } from "@fle/run";

/** Sends one command. Resolves true when the rules accepted it (false: refused, busy or failed). */
export type Act = (command: Command) => Promise<boolean>;

export const pocketName = (view: RunView, id: string): string => {
  const p = view.pockets.find((x) => x.id === id);
  if (!p) return id;
  return p.kind === "YOU" ? "You" : p.label;
};
