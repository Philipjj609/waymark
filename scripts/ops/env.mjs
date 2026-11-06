// Minimal .env reader for the setup checks (#5, #6). No dependency, no printing of values.
// Process env wins over .env, so CI or a host secret store can supply values instead.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function loadEnv() {
  const file = join(root, ".env");
  const out = {};
  if (existsSync(file)) {
    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      out[line.slice(0, eq).trim()] = line
        .slice(eq + 1)
        .trim()
        .replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  return { ...out, ...process.env, __hasEnvFile: existsSync(file) };
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
