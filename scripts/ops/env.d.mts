/** Types for env.mjs (used from apps/web/next.config.ts). */
export function envFilePath(): string | null;
export function parseEnvFile(text: string): Record<string, string>;
export function loadEnv(): Record<string, string | undefined> & { __hasEnvFile: boolean };
export function applyEnvFile(): string[];
export const unset: (v: string | undefined) => boolean;
export class CheckFailed extends Error {}
export function fail(msg: string): never;
export function runCheck(main: () => Promise<void>): Promise<void>;
