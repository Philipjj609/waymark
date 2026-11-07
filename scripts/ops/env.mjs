// Minimal .env reader shared by the setup checks (#5, #6), the model probe and the web app's
// config. No dependency, never prints values. Process env always wins over .env, so CI or a host
// secret store (Render) can supply values instead.
//
// Which .env: this checkout's root `.env` if present; otherwise, in a git worktree, the MAIN
// checkout's `.env` (found via `git rev-parse --git-common-dir`). So the owner keeps exactly one
// local secrets file and worktrees never need copies of it.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Path of the .env file that will be used, or null if none exists. Exported for diagnostics. */
export function envFilePath() {
  const own = join(root, ".env");
  if (existsSync(own)) return own;
  try {
    const common = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    const mainEnv = join(resolve(common, ".."), ".env");
    return existsSync(mainEnv) ? mainEnv : null;
  } catch {
    return null; // not a git checkout (e.g. a deployed build): process env only
  }
}

export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    out[line.slice(0, eq).trim()] = line
      .slice(eq + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2");
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
