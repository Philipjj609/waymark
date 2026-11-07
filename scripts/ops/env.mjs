// Minimal .env reader shared by the setup checks (#5, #6), the model probe and the web app's
// config. No dependency, never prints values. Process env always wins over .env, so CI or a host
// secret store (Render) supplies values instead.
//
// Which .env (exactly one file, never merged):
//   1. this checkout's root `.env`, if it is a regular file; otherwise
//   2. ONLY when this checkout is a linked git worktree of the same repository: the main
//      checkout's root `.env`. Detected with `git rev-parse` (git-dir != git-common-dir, and the
//      worktree top level is this repo root), with caller-set GIT_* variables stripped so a
//      hostile or stray environment can't redirect the lookup.
//   A worktree that has its own `.env` uses only that file (keys are not merged with the main one).
//
// Parser (deliberately small, not full dotenv): `KEY=value` per line (LF, CRLF or CR), a leading
// BOM is ignored, an optional `export ` prefix is accepted, matching surrounding quotes are
// removed, and an unquoted value's trailing ` # comment` is dropped. Multi-line values are not
// supported. For duplicate keys the last one wins.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Same path on Windows and POSIX (case and separators), for comparisons only. */
const norm = (p) => resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

function git(args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
  );
  return execFileSync("git", args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/** Path of the .env file that will be used, or null if none exists. Exported for diagnostics. */
export function envFilePath() {
  const own = join(root, ".env");
  if (isFile(own)) return own;
  try {
    const [top, gitDir, common] = git([
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-dir",
      "--git-common-dir",
    ]).split(/\r?\n/);
    if (!top || !gitDir || !common) return null;
    // Only a linked worktree whose top level is this repo root (not a folder nested in some
    // other repository, not a plain checkout).
    if (norm(top) !== norm(root) || norm(gitDir) === norm(common)) return null;
    const mainEnv = join(resolve(common, ".."), ".env");
    return isFile(mainEnv) ? mainEnv : null;
  } catch {
    return null; // git missing, or not a git checkout (e.g. a deployed build): process env only
  }
}

export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trimStart();
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted = /^(['"])(.*)\1(\s+#.*)?$/.exec(value);
    if (quoted) value = quoted[2] ?? "";
    else value = value.replace(/\s+#.*$/, "");
    out[key] = value;
  }
  return out;
}

export function loadEnv() {
  const file = envFilePath();
  const fromFile = file ? parseEnvFile(readFileSync(file, "utf8")) : {};
  return { ...fromFile, ...process.env, __hasEnvFile: Boolean(file) };
}

/**
 * For servers (Next config): copy .env values into process.env WITHOUT overriding anything the
 * host already set. Returns the keys it filled (names only) for a one-line startup note.
 */
export function applyEnvFile() {
  const file = envFilePath();
  if (!file) return [];
  const filled = [];
  for (const [k, v] of Object.entries(parseEnvFile(readFileSync(file, "utf8")))) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
      filled.push(k);
    }
  }
  return filled;
}

/** True when a value is missing or still the .env.example placeholder. */
export const unset = (v) => !v || /^replace-with/.test(v);

/** Stops the check with exit code 1. Thrown, not process.exit(): exiting while a fetch handle is
 * closing crashes Node on Windows (libuv assertion), so the caller lets the process end naturally. */
export class CheckFailed extends Error {}
export function fail(msg) {
  throw new CheckFailed(msg);
}

/** Run a check: print ✗ and set exit code 1 on failure, never call process.exit. */
export async function runCheck(main) {
  try {
    await main();
  } catch (e) {
    console.error(`✗ ${e instanceof CheckFailed ? e.message : (e?.stack ?? e)}`);
    process.exitCode = 1;
  }
}
