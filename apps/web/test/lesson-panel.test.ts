/**
 * Owner, 7 Nov: users never see raw visualization identifiers (e.g. "[CashFlowTimeline]") until
 * #26 ships real renderers. The typed recipe stays in the lesson contract.
 */
import { type LessonResponse, LessonResponseSchema, VisualRecipeTypeSchema } from "@fle/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LessonPanel } from "../app/lesson-panel";
import { visualCaption } from "../lib/visual-caption";

function lessonWith(recipe: (typeof VisualRecipeTypeSchema.options)[number]): LessonResponse {
  return LessonResponseSchema.parse({
    schemaVersion: "learning.lesson.v1",
    lessonId: "les_panel_test",
    curriculumVersion: "seed.draft.v1",
    conceptIds: ["cpt_cash_balance"],
    blocks: [
      { type: "text", markdown: "You hold 770.00 EUR." },
      { type: "visual", recipe, data: { cashMinor: 77000 }, textEquivalent: "Cash 770.00 EUR." },
    ],
    sourceRefs: ["seed:cpt_cash_balance"],
    validation: { status: "VALIDATED", checks: ["schema"] },
    provenance: {
      generator: "MODEL",
      model: "TEST STAND-IN: fake (not an AI model)",
      promptVersion: null,
    },
  });
}

describe("lesson panel: visual fallback", () => {
  for (const recipe of VisualRecipeTypeSchema.options) {
    it(`${recipe}: shows a plain caption and the text equivalent, never the raw id`, () => {
      const html = renderToStaticMarkup(
        createElement(LessonPanel, { view: { status: "ready", lesson: lessonWith(recipe) } }),
      );
      expect(html).not.toContain(recipe);
      expect(html).toContain(visualCaption(recipe));
      expect(html).toContain("770.00 EUR");
    });
  }

  it("keeps the typed recipe in the lesson data (contract intact)", () => {
    expect(lessonWith("CashFlowTimeline").blocks[1]).toMatchObject({ recipe: "CashFlowTimeline" });
  });
});

describe("lesson panel: deterministic facts block (#88)", () => {
  const render = (checks: string[]) =>
    renderToStaticMarkup(
      createElement(LessonPanel, {
        view: {
          status: "ready",
          lesson: {
            ...lessonWith("CashFlowTimeline"),
            validation: { status: "VALIDATED", checks },
          },
        },
      }),
    );

  it("labels block 0 as coming from the world's records when the server marked it", () => {
    const html = render(["facts:deterministic", "schema"]);
    expect(html).toContain('data-facts="deterministic"');
    expect(html).toContain("From your world&#x27;s records");
  });

  it("never labels model text as records without the server's marker", () => {
    const html = render(["schema", "facts:deterministic"]);
    expect(html).not.toContain("data-facts");
    expect(html).not.toContain("world&#x27;s records");
  });
});
