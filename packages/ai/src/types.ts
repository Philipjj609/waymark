/**
 * Provider-neutral tutor boundary (ADR-0007). A provider turns a prompt into RAW TEXT.
 * It never returns trusted data: everything it says goes through validate.ts.
 */
export interface TutorRequest {
  readonly stage: "generate" | "repair";
  readonly system: string;
  /** JSON string: { task, context, errors? }. Contains only the bounded context. */
  readonly user: string;
}

export interface TutorProvider {
  readonly id: string;
  /** Configured model id, or null for the fake. Never hard-coded in product code. */
  readonly modelId: string | null;
  /**
   * True for test implementations (the deterministic fake). Their lessons are labelled
   * "TEST STAND-IN" in provenance so no UI or reviewer can mistake them for real AI output.
   */
  readonly testStandIn: boolean;
  complete(request: TutorRequest, options: { readonly signal: AbortSignal }): Promise<string>;
}

export const PROMPT_VERSION = "tutor.prompt.v2" as const;
export const CURRICULUM_VERSION = "seed.draft.v1" as const;
