import type { LearningView } from "../view-types.js";
import type { World } from "../world.js";
import type { RunSystem } from "./types.js";

/** R6 (#118): predictions, questions, notes, month close, year review. Stub until R6 lands. */
export const learningSystem: RunSystem = {
  id: "learning",
};

/** The learning part of the view (R6 fills this; R7's view uses it). */
export function learningView(_w: World): LearningView {
  return { predictions: [], questions: [], notes: [], monthClose: null, yearReview: null };
}
