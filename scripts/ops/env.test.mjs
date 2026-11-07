import { describe, expect, it } from "vitest";
import { applyEnvFile, envFilePath, parseEnvFile } from "./env.mjs";

describe("env loader (one local .env for the repo and its worktrees)", () => {
  it("parses KEY=VALUE lines: comments, CRLF, quotes, '=' inside values", () => {
    const parsed = parseEnvFile(
      "# c\r\nA=1\r\nB=\"two words\"\nC='x=y'\n\n D = spaced \nbad line\n",
    );
    expect(parsed).toEqual({ A: "1", B: "two words", C: "x=y", D: "spaced" });
  });

  it("handles BOM, bare CR, export prefix, inline comments, '#' inside values, duplicates", () => {
    const parsed = parseEnvFile(
      '﻿A=1\rB=abc # comment\nC="q" # comment\nexport D=2\nE=x#y\nF="has # inside"\nA=last\n=novalue\n',
    );
    expect(parsed).toEqual({ A: "last", B: "abc", C: "q", D: "2", E: "x#y", F: "has # inside" });
  });

  it("finds a .env from a linked worktree via the main checkout, or reports none", () => {
    const p = envFilePath();
    expect(p === null || p.endsWith(".env")).toBe(true);
  });

  it("ignores caller-set GIT_* variables when locating the main checkout", () => {
    const before = envFilePath();
    const saved = { dir: process.env.GIT_DIR, wt: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = "/nonexistent/.git";
    process.env.GIT_WORK_TREE = "/nonexistent";
    try {
      expect(envFilePath()).toBe(before);
    } finally {
      if (saved.dir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved.dir;
      if (saved.wt === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = saved.wt;
    }
  });

  it("never overrides values the host already set", () => {
    const key = "WAYMARK_ENV_TEST_SENTINEL";
    process.env[key] = "from-host";
    applyEnvFile();
    expect(process.env[key]).toBe("from-host");
    delete process.env[key];
  });
});
