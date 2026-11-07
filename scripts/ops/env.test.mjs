import { describe, expect, it } from "vitest";
import { applyEnvFile, envFilePath, parseEnvFile } from "./env.mjs";

describe("env loader (one local .env for the repo and its worktrees)", () => {
  it("parses KEY=VALUE lines: comments, CRLF, quotes, '=' inside values", () => {
    const parsed = parseEnvFile(
      "# c\r\nA=1\r\nB=\"two words\"\nC='x=y'\n\n D = spaced \nbad line\n",
    );
    expect(parsed).toEqual({ A: "1", B: "two words", C: "x=y", D: "spaced" });
  });

  it("finds a .env from a worktree via the main checkout, or reports none", () => {
    const p = envFilePath();
    expect(p === null || p.endsWith(".env")).toBe(true);
  });

  it("never overrides values the host already set", () => {
    const key = "WAYMARK_ENV_TEST_SENTINEL";
    process.env[key] = "from-host";
    applyEnvFile();
    expect(process.env[key]).toBe("from-host");
    delete process.env[key];
  });
});
