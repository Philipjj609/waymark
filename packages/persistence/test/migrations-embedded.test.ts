import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "../src/migrations.generated.js";

describe("embedded migrations", () => {
  it("match migrations/*.sql exactly (regenerate with scripts/embed-migrations.mjs)", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
    const onDisk = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((name) => ({
        name,
        sql: readFileSync(join(dir, name), "utf8").replace(/\r\n/g, "\n"),
      }));
    expect(MIGRATIONS).toEqual(onDisk);
  });
});
