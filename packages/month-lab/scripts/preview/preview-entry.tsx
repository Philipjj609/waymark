import { createRoot } from "react-dom/client";
import { LabGame } from "../../../../apps/web/app/lab/lab-game";
import { type RunRequest, RunRequestSchema } from "../../src/actions.js";
import { readIntent } from "../../src/intent.js";
import { monthView, stressTest } from "../../src/view.js";

/**
 * A browser-only build of the real game for usability sessions (#110), so people can play without
 * anything being deployed. The same rules, engine and screen run in the page. There is no server,
 * so luck lives in the page: fine for watching people play, and never a substitute for the signed
 * cursor and rate limits of the real route.
 */
declare global {
  interface Window {
    __labLog?: (event: Record<string, unknown>) => void;
  }
}

const reply = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const logAction = (request: RunRequest, status: string, head: number) => {
  const last = request.actions.at(-1);
  window.__labLog?.({
    type: "step",
    head,
    status,
    actions: request.actions.length,
    last: last?.kind ?? null,
  });
};

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const path =
    typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
  if (path === "/api/lab") {
    const body = JSON.parse(String(init?.body));
    if (body.stress) {
      const run = RunRequestSchema.parse(body.run);
      return reply({ stress: stressTest(`preview:${run.runId}`, run.actions, 120) });
    }
    const request = RunRequestSchema.parse(body);
    const view = monthView({
      seed: `preview:${request.runId}`,
      actions: request.actions,
      ...(request.atDay !== undefined ? { atDay: request.atDay } : {}),
      ...(request.fromDay !== undefined ? { fromDay: request.fromDay } : {}),
      ...(request.pinMinor !== undefined ? { pinMinor: request.pinMinor } : {}),
      ...(request.transferMinor !== undefined ? { transferMinor: request.transferMinor } : {}),
      hindsight: request.hindsight === true,
    });
    logAction(request, view.status, view.head);
    return reply({ view, cursor: "preview" });
  }
  if (path === "/api/lab/intent") {
    const { text, day, invoices } = JSON.parse(String(init?.body));
    const result = await readIntent(text, { day, invoices }, null);
    window.__labLog?.({ type: "idea", understood: result.kind === "CARD", text });
    return reply({ result });
  }
  return realFetch(input, init);
};

const mount = document.getElementById("lab-root");
if (mount) createRoot(mount).render(<LabGame />);
