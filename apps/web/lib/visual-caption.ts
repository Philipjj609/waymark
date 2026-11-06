import type { VisualRecipeType } from "@fle/contracts";

/**
 * Plain-language captions for visual recipes until real renderers exist (#26). The typed recipe
 * stays in the lesson contract; users never see the raw identifier. Every recipe type must have a
 * caption (enforced by the Record type), so a new recipe can't silently leak its id into the UI.
 */
const CAPTIONS: Record<VisualRecipeType, string> = {
  CashFlowTimeline: "Your cash over the coming days",
  InvoiceAnatomy: "How this invoice is built",
  CommitmentCalendar: "What you have committed to, and when",
  BalanceSplit: "Where your money sits",
  ProbabilityTree: "The possible outcomes",
  DecisionComparison: "Comparing your options",
  InterestAccumulation: "How interest adds up",
  BudgetAllocation: "How your budget is split",
  ProfitVsCashFlow: "Profit versus cash in hand",
  ContractTerms: "The key terms",
  BalanceSheetComparison: "What you own versus what you owe",
};

export function visualCaption(recipe: VisualRecipeType): string {
  return CAPTIONS[recipe];
}
