"use client";

import type { PlayerCommand, RunView } from "@fle/run";
import type { SaveToken } from "../../lib/run-save";

export interface AdvisorPanelProps {
  readonly save: SaveToken;
  readonly view: RunView;
  /** Sends a command the player confirmed, through the same path as every other action. */
  readonly onCommand: (command: PlayerCommand) => Promise<void>;
}

/** Ask about your money; typed requests become actions you confirm. Stub: owned by the AI package. */
export function AdvisorPanel(_props: AdvisorPanelProps) {
  return null;
}
