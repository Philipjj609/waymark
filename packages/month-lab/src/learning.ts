import {
  type ConceptId,
  type LearnerId,
  LearningEvidenceSchema,
  type WorldId,
  type WorldVersion,
} from "@fle/contracts";
import {
  type ConceptStatus,
  conceptView,
  createLearnerState,
  interpretFact,
  type LearnerState,
  type Observation,
  recordObservation,
} from "@fle/learning";
import type { EngineRun } from "./run.js";
import type { ForesightSignature } from "./view-types.js";

/**
 * Connects a played month to the existing evidence model (#18, BRG-001) instead of scoring it
 * separately. The ledger events go through the same bridge as FP-30. Guesses and the transfer
 * question become ordinary `LearningEvidence` rows, recorded in the same learner state.
 *
 * Money is never evidence here (invariant 9): nothing reads the outcome of the month.
 */
const LEARNER = "lrn_month_lab" as LearnerId;
const WORLD = "wld_month_lab" as WorldId;
const cpt = (id: string) => id as ConceptId;

export const CONCEPT_LABELS: ReadonlyArray<{ readonly id: ConceptId; readonly label: string }> = [
  { id: cpt("cpt_cash_balance"), label: "Knowing what cash you really have" },
  { id: cpt("cpt_obligation"), label: "Keeping track of what you owe" },
  { id: cpt("cpt_receivable"), label: "Telling promised money from money" },
  { id: cpt("cpt_liquidity"), label: "Having cash on the day it is needed" },
  { id: cpt("cpt_opportunity_cost"), label: "Weighing what a choice gives up" },
];

/**
 * A draft of `ex_liquidity_gap_transfer` from the starter curriculum (#96), kept in step by id. It
 * is an unfamiliar situation on purpose. When #96 merges, replace this with the real exercise and
 * `scoreExercise`. Not editorially approved, and shown as a draft.
 */
export const TRANSFER = {
  sourceExerciseId: "ex_liquidity_gap_transfer",
  reviewStatus: "DRAFT",
  prompt:
    "A different person: Sam has €420 and buys a second-hand bike for €180 on day 1. A course fee of €210 is due on day 6, an insurance payment of €45 on day 12, and wages of €700 arrive on day 20. How much short is Sam when the insurance is due? Enter 0 if Sam can pay it in full.",
  answerMinor: 1_500,
  /** Says the bike and coming wages mean there is no problem (the wealth-as-cash misconception). */
  misconceptionMinor: 0,
  feedback:
    "After the bike and the course fee Sam holds €30, less than the €45 insurance, and the wages arrive too late to help.",
} as const;

export type TransferResult = "SUPPORTS" | "CONTRADICTS" | "INCONCLUSIVE";

export function scoreTransfer(answerMinor: number): TransferResult {
  if (answerMinor === TRANSFER.answerMinor) return "SUPPORTS";
  // Only an answer that names the misconception counts against: anything else may be a slip.
  return answerMinor === TRANSFER.misconceptionMinor ? "CONTRADICTS" : "INCONCLUSIVE";
}

export interface ConceptReading {
  readonly conceptId: string;
  readonly label: string;
  readonly status: ConceptStatus;
  readonly observations: number;
}

export interface GuessFact {
  readonly day: number;
  readonly signature: ForesightSignature;
  readonly reason: string;
}

/**
 * The learner observation shape keeps a closed set of kinds in packages/learning. A guess is not one
 * of them yet, and adding it belongs to that module's owner, so this cast is the one seam. It is
 * safe because the kind only decides whether a row counts as a shortfall.
 */
const asObservation = (o: Omit<Observation, "kind">): Observation =>
  ({ ...o, kind: "PREDICTION" }) as unknown as Observation;

function guessObservation(guess: GuessFact, index: number): Observation | null {
  const sourceRef = `prediction:${index}:day${guess.day}`;
  const row = (
    conceptId: ConceptId,
    outcome: TransferResult,
    basis: "observed" | "stated",
  ): Observation =>
    asObservation({
      sourceRef,
      rationaleGiven: true,
      packetId: `pkt_${sourceRef}`,
      evidence: [
        LearningEvidenceSchema.parse({
          learnerId: LEARNER,
          conceptId,
          basis,
          competence: "APPLICATION",
          outcome,
          confidence: null,
          sourceRef,
        }),
      ],
    });
  if (guess.signature === "MATCHED") return row(cpt("cpt_liquidity"), "SUPPORTS", "observed");
  if (guess.signature === "COUNTED_PROMISED_MONEY") {
    // The same gap can be a misunderstanding or a deliberate bet, so only the player's own account
    // can tell them apart.
    return guess.reason === "COUNTED_OWED"
      ? row(cpt("cpt_receivable"), "CONTRADICTS", "stated")
      : row(cpt("cpt_receivable"), "INCONCLUSIVE", "stated");
  }
  return row(cpt("cpt_liquidity"), "INCONCLUSIVE", "stated");
}

/**
 * Paying a bill with plenty of cash shows nothing, and the shared mapping table would credit it as
 * understanding. Until that table changes (a fix for its owner), such payments are left out here.
 */
function paymentWasRoutine(run: EngineRun, day: number): boolean {
  const cash = run.cashByDay.get(day) ?? 0;
  const soon = run.plan.bills
    .filter((b) => b.dueDay > day && b.dueDay <= day + 7 && b.revealDay <= day)
    .reduce((sum, b) => sum + b.amountMinor, 0);
  return cash >= soon;
}

export function learningReading(
  run: EngineRun,
  guesses: readonly GuessFact[],
  transferResult: TransferResult | null,
): readonly ConceptReading[] {
  const context = {
    learnerId: LEARNER,
    worldId: WORLD,
    worldVersion: run.state.version as WorldVersion,
  };
  let state: LearnerState = createLearnerState(LEARNER);
  for (const event of run.state.events) {
    const interpreted = interpretFact({ kind: "EVENT", event }, context);
    if (!interpreted) continue;
    if (
      interpreted.observation.kind === "ON_TIME_PAYMENT" &&
      paymentWasRoutine(run, event.worldDay)
    ) {
      continue;
    }
    state = recordObservation(state, interpreted.observation);
  }
  guesses.forEach((guess, i) => {
    const observation = guessObservation(guess, i);
    if (observation) state = recordObservation(state, observation);
  });
  if (transferResult) {
    const sourceRef = `transfer:${TRANSFER.sourceExerciseId}`;
    state = recordObservation(
      state,
      asObservation({
        sourceRef,
        rationaleGiven: false,
        packetId: `pkt_${sourceRef}`,
        evidence: [
          LearningEvidenceSchema.parse({
            learnerId: LEARNER,
            conceptId: cpt("cpt_liquidity"),
            basis: "observed",
            competence: "APPLICATION",
            outcome: transferResult,
            confidence: null,
            sourceRef,
          }),
        ],
      }),
    );
  }
  return CONCEPT_LABELS.map(({ id, label }) => {
    const view = conceptView(state, id);
    return {
      conceptId: id,
      label,
      status: view.status,
      observations: view.observationCount,
    };
  });
}
