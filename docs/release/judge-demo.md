# Waymark judge demo

This guide targets the integrated release candidate `c48d23687d0951a1c41bf48a4415148da5c07f71`.

**Hosted release-candidate URL: pending deployment and end-to-end verification.** An existing older hosted build is not evidence that this candidate is deployed. The release owner adds the verified URL to the submission after the public-deployment gate. Repository publication is also a separate owner decision.

You can already run the candidate using the [README setup](../../README.md#run-locally-without-api-credentials). No API credentials or account are needed for the local fictional-money experience. The [final acceptance evidence](https://github.com/Philipjj609/waymark/issues/140#issuecomment-6796137800) records the separately tested real Sandbox journey and its persistence checks.

## Before starting

- Use a current Chromium-based browser, with cookies, JavaScript and local storage enabled. Chrome/Edge are suitable. Keep the same browser session to revisit your work.
- All gameplay money is fictional. PayPal Sandbox moves test money only. There are no Live payments or real bank connections.
- The curriculum is clearly marked DRAFT and awaits editorial approval. This is a prototype for education, not financial advice.
- The ordinary local setup uses a labelled deterministic tutor stand-in. A configured Nebius server shows the real provider's validated response or a labelled fallback. Do not present a fallback or stand-in as a successful AI call.
- Do not enter sensitive personal information, real card details or real financial credentials.

## A short Learn → Run → Learn walkthrough

The following is a suggested three-minute exploration, not a video-production script. The video owner can choose the final presentation.

| Approximate time | Action                                                                                                                                                                                                                   | What to look for                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00–0:45        | Open **Learn**, choose the foundations module, then **Cash balance**. Explain: “I think expected salary is cash already, but I am unsure when I can use it.” Choose another explanation style and explore the reasoning. | The tutor responds to uncertainty and asks a follow-up. You can disagree or clarify. Its interpretation does not establish mastery.                                              |
| 0:45–1:10        | Change the interactive numbers, try an exercise, save a short personal note, then open the knowledge map.                                                                                                                | Arithmetic and grading are deterministic. The map separates curriculum connections from evidence about you. Return to the lesson to see or edit the note.                        |
| 1:10–2:20        | Choose **Practise** and **Try the 3-minute demo** (or **Quick demo** on the start screen).                                                                                                                               | Side studio starts as “Demo run” with a short checklist: pay rent, open the studio, continue to month close and ask the advisor. Review cash, bills and consequences as you act. |
| 2:20–3:00        | Follow an available concept link to Learn, or choose **Learn** in the main navigation. Revisit the lesson, then choose **Practise** and continue the saved Run.                                                          | The experiences share concept identifiers while working independently. A simulated outcome is not a grade. The note and the Run remain distinct records.                         |

The checklist need not be completed within the suggested time. Available decisions and timing depend on the current Run state. The original `/today` FP-30 engine demonstration remains available, but it is not the current Run design.

## Optional PayPal Sandbox step

On a verified server configured for PostgreSQL and Sandbox checkout, pay the demo rent using **Pay with PayPal Sandbox (test money)**. The Run's published-test-card path needs **no buyer login, buyer password or card entry**. The merchant API credentials remain server-side and must not be disclosed to judges.

Wait for verification and open the payment receipt. The server settles only after it verifies a completed capture matching the immutable mapped amount. Approval, a return URL and a successful HTTP response are insufficient. If the outcome is pending or uncertain, keep the same Run and follow the displayed recovery/status guidance; uncertainty is not a confirmed failure.

Reload and continue the same Run: the receipt and demo payment tick should recover from server-authoritative records. A repeated payment request cannot settle the same bill twice. In the verified acceptance run, settlement also survived an actual application process restart and concurrent duplicates; judges need not restart the service or deliberately race requests.

If Sandbox checkout is not configured, the checklist says so and offers payment with fictional game cash. That is a valid local learning demo, but it is **not** proof of PayPal integration. Do not substitute a real PayPal account or real card. The separate `/checkout` page demonstrates the World checkout; any approval-flow instructions must be supplied by the verified release environment, without publishing credentials.

## Keyboard, small screens and text alternatives

- Use Tab and Shift+Tab to move through controls; Enter activates links and buttons. Native disclosure controls can be opened from the keyboard. Use the page's skip link to reach the main content.
- Text labels identify form fields and money types. You can use the graph's concept cards/links instead of relying on the SVG picture; timelines have text representations. Progress is expressed in words as well as visual marks.
- The Learn and Run regression suites exercise narrow-screen layouts. Browser zoom and a wider window may make dense account or history views easier to inspect. This does not claim a complete screen-reader audit or cross-browser certification.
- If visual access is impractical, use the written actions and expected results in this guide, the lesson's text/card representation and [acceptance evidence](https://github.com/Philipjj609/waymark/issues/140#issuecomment-6796137800). A local developer can run `pnpm demo` for a plain-text, deterministic trace of the original fictional World engine; it does not replace the Learn/Run UI or real Sandbox acceptance.

## Revisit and troubleshooting

**Known advisor limitation:** the Run advisor's current **Checked** badge reflects restricted-wording checks only. It does not certify the financial meaning of its advice. It can incorrectly interpret future affordability despite known incoming pay. Compare its prose with the game-generated cash, income and bill dates; treat a conclusion about future rent as tentative. [Issue #151](https://github.com/Philipjj609/waymark/issues/151) records a deterministic synthetic-provider reproduction and the proposed narrow label correction. This limitation does not alter the ledger or verified-payment settlement, and the approved video is preserved unchanged.

- Keep cookies and the signed browser Run pointer. There is no password or cross-device account recovery. A private window is a separate learner, not a way to resume the first session.
- PostgreSQL preserves data across application restarts; the credential-free memory demo does not. Do not mistake memory-mode data loss for the durable configuration's behavior.
- If the tutor falls back, the lesson remains usable. Report the provider label and visible error state, not notes or secrets.
- If Practise says Run is disabled, the operator must check `WAYMARK_RUN` and the production `RUN_SECRET`. If payment controls are unavailable, the operator checks the Sandbox flags, credentials and PostgreSQL configuration.
- `/api/health` confirms the app process responds; it does not verify the database, Nebius or PayPal. A verified release requires the separate deployed acceptance checks.

Judges should not change infrastructure, migrations, credentials, webhook registrations or payment settings. The operator's release checklist is separate from this learner-facing guide.

Latest operator evidence, video checksum, deployment procedure and remaining owner gates: [final release preflight](final-preflight.md). No new hosted success is implied by this document.
