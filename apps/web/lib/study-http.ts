import { knowledgeMap, StudyActionSchema, type StudyLedger } from "@fle/learning";
import { rejectUnsafeWrite } from "./csrf";
import { errorResponse, guarded, json } from "./http";
import { clientIp, hit, LIMITS } from "./rate-limit";
import { readSession, startSession } from "./session";
import { StudyCapacity, StudyConflict, StudyInvalid, studyAction } from "./study-service";
import { studyStore } from "./study-store";
import { tutorProvider } from "./tutor";

const globalWrites = { name: "study-global", max: 300, windowMs: 60_000 };
const globalModels = { name: "study-model-global", max: 30, windowMs: 60_000 };
const sessionModels = { name: "study-model-session", max: 6, windowMs: 60_000 };
const ownerView = (owner: string, ledger: StudyLedger) => ({
  version: ledger.version,
  // Internal owner/learner ids and lease tokens never reach the browser.
  records: ledger.records.map((r) => ({
    id: r.id,
    conceptId: r.conceptId,
    kind: r.kind,
    createdAt: r.createdAt,
    payload: Object.fromEntries(
      Object.entries(r.payload)
        .filter(([k]) => !["request", "leaseToken", "leaseUntil"].includes(k))
        .map(([k, value]) => {
          if (k !== "score") return [k, value];
          const { evidence: _internalEvidence, ...score } = value as Record<string, unknown>;
          return [k, score];
        }),
    ),
    evidence: r.evidence.map(({ learnerId: _id, ...e }) => e),
  })),
  map: knowledgeMap(owner, ledger.records),
  persistence: (process.env.WORLD_STORE ?? "memory") === "postgres" ? "DURABLE" : "PROCESS_MEMORY",
});
export type PersonalStudyView = ReturnType<typeof ownerView>;

export async function studyGET(req: Request): Promise<Response> {
  return guarded(async () => {
    const session = readSession(req);
    if (!session) return json({ error: "session required" }, 401);
    return json(ownerView(session.hash, await studyStore().load(session.hash)));
  });
}

export async function studyPOST(req: Request): Promise<Response> {
  return guarded(async () => {
    const unsafe = rejectUnsafeWrite(req);
    if (unsafe) return unsafe;
    if (!hit(globalWrites, "all")) return errorResponse(429, "RATE_LIMITED", "try again shortly");
    // Bound actual streamed bytes, including chunked input. Never log the explanation/body.
    let raw = "";
    let size = 0;
    const reader = req.body?.getReader();
    const decoder = new TextDecoder();
    if (reader)
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > 12_000) {
          await reader.cancel();
          return errorResponse(413, "PAYLOAD_TOO_LARGE", "request too large");
        }
        raw += decoder.decode(next.value, { stream: true });
      }
    raw += decoder.decode();
    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      return errorResponse(400, "INVALID_REQUEST", "invalid JSON");
    }
    const parsed = StudyActionSchema.safeParse(input);
    if (!parsed.success) return errorResponse(400, "INVALID_REQUEST", "invalid learning action");
    let session = readSession(req);
    let cookie: Record<string, string> = {};
    if (parsed.data.action === "INIT" && !session) {
      const ip = clientIp(req);
      if (
        !hit({ name: "study-init-global", max: 30, windowMs: 60_000 }, "all") ||
        (ip && !hit(LIMITS.worldsPerIp, ip))
      )
        return errorResponse(429, "RATE_LIMITED", "too many new sessions");
      const started = startSession(req);
      session = started.session;
      cookie = { "set-cookie": started.setCookie };
    }
    if (!session) return json({ error: "session required" }, 401);
    if (!hit(LIMITS.commands, session.hash))
      return errorResponse(429, "RATE_LIMITED", "try again shortly");
    if (parsed.data.action === "INIT")
      return json(ownerView(session.hash, await studyStore().load(session.hash)), 200, cookie);
    if (
      parsed.data.action === "EXPLAIN" &&
      (!hit(sessionModels, session.hash) || !hit(globalModels, "all"))
    )
      return errorResponse(
        429,
        "RATE_LIMITED",
        "tutor budget reached; examples and notes remain available",
      );
    try {
      const ledger = await studyAction(studyStore(), session.hash, parsed.data, {
        provider: tutorProvider(),
      });
      return json(ownerView(session.hash, ledger));
    } catch (e) {
      if (e instanceof StudyConflict)
        return errorResponse(
          409,
          "STORE_CONFLICT",
          "another update is in progress; reload and retry",
          { "retry-after": "2" },
        );
      if (e instanceof StudyCapacity)
        return errorResponse(409, "STORE_CONFLICT", "pilot storage limit reached");
      if (e instanceof StudyInvalid)
        return errorResponse(400, "INVALID_REQUEST", "invalid lesson or response");
      throw e;
    }
  });
}
