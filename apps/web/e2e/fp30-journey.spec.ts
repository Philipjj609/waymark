import { expect, test } from "@playwright/test";
import {
  advanceTo,
  captureCommands,
  cash,
  expectAllMoneyFictional,
  obligationRow,
  replayHeadHash,
  sendVia,
  serverSnapshot,
  startWorld,
  stateCell,
} from "./world";

/**
 * Journey 1 (#101): the FICTIONAL FP-30 month in a real browser. Pay a bill, defer one, receive
 * the salary, pay the overdue bill, read the explanation, reload, then prove that an independent
 * engine replay of exactly what the browser sent reproduces the server's head hash.
 *
 * All money here is fictional simulation money. Nothing in this journey touches PayPal; the
 * verified PayPal SANDBOX checkout is a separate journey (paypal-sandbox.spec.ts) added with D1b.
 */
test("fictional FP-30 month: pay, defer, salary, pay overdue, explanation, reload, replay", async ({
  page,
}) => {
  const sent = captureCommands(page);
  const worldId = await startWorld(page);
  const phone = obligationRow(page, /Phone provider/);
  const rent = obligationRow(page, /Landlord/);

  await expect(cash(page)).toHaveText("€800.00 (fictional)");

  // Day 8: the phone bill falls due and time stops until the player decides.
  await advanceTo(page, 8);
  await expect(stateCell(phone)).toHaveText("DUE");
  await expect(page.getByText("Decide on the due bill first.")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Advance to day/ })).toBeDisabled();

  // Pay it: cash moves, the bill is settled, and an explanation follows (deterministic fake tutor).
  const paid = await sendVia(page, phone.getByRole("button", { name: "Pay" }));
  expect(paid.result.status).toBe("ACCEPTED");
  await expect(cash(page)).toHaveText("€770.00 (fictional)");
  await expect(stateCell(phone)).toHaveText("SETTLED");
  await expect(page.getByRole("heading", { name: "What just happened" })).toBeVisible();
  await expect(page.getByText("TEST STAND-IN (not an AI model)")).toBeVisible();
  await expect(page.getByText("All amounts are fictional simulation money.")).toBeVisible();
  await expect(page.locator('[data-facts="deterministic"]')).toContainText(
    "From your world's records",
  );

  // Day 10: rent falls due. Defer it: it becomes OVERDUE and no money moves.
  await advanceTo(page, 10);
  await expect(stateCell(rent)).toHaveText("DUE");
  const deferred = await sendVia(page, rent.getByRole("button", { name: "Defer" }));
  expect(deferred.result.status).toBe("ACCEPTED");
  await expect(stateCell(rent)).toHaveText("OVERDUE");
  await expect(cash(page)).toHaveText("€770.00 (fictional)");
  await expect(page.getByRole("button", { name: /^Advance to day/ })).toBeEnabled();

  // Day 15: the net salary arrives; the overdue rent is still owed and can now be paid.
  await advanceTo(page, 15);
  await expect(cash(page)).toHaveText("€1670.00 (fictional)");
  await expect(stateCell(rent)).toHaveText("OVERDUE");
  const late = await sendVia(page, rent.getByRole("button", { name: "Pay" }));
  expect(late.result.status).toBe("ACCEPTED");
  await expect(cash(page)).toHaveText("€1120.00 (fictional)");
  await expect(stateCell(rent)).toHaveText("SETTLED");

  // The fictional path is labelled as such and never presented as a PayPal payment.
  await expectAllMoneyFictional(page);
  await expect(page.getByText(/paypal|sandbox/i)).toHaveCount(0);

  // Persistence: a reload restores the same world from the session (cookie) and the store.
  const before = await serverSnapshot(page, worldId);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Day 15", exact: true })).toBeVisible();
  await expect(cash(page)).toHaveText("€1120.00 (fictional)");
  await expect(page.getByText(`version ${before.version}`)).toBeVisible();

  // Determinism: replaying exactly what the browser sent reproduces the server's head hash.
  const after = await serverSnapshot(page, worldId);
  expect(after.stateHash).toBe(before.stateHash);
  expect(sent.map((c) => c.kind)).toEqual([
    "ADVANCE_TIME",
    "PAY_OBLIGATION",
    "ADVANCE_TIME",
    "DEFER_OBLIGATION",
    "ADVANCE_TIME",
    "PAY_OBLIGATION",
  ]);
  const replayed = replayHeadHash(worldId, sent);
  expect(replayed.headHash).toBe(after.stateHash);
  expect(replayed.version).toBe(after.version);
});
