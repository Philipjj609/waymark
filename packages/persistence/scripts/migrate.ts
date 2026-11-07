/**
 * Apply the embedded SQL migrations to DATABASE_URL and exit. Used as Render's preDeployCommand
 * (`pnpm db:migrate`), so schema changes land before the new version takes traffic; the web app
 * also migrates lazily on first use, and both paths are idempotent and advisory-locked.
 * Prints migration names only, never the connection string.
 */
import { connectPostgres, migrate } from "../src/index.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("db:migrate: DATABASE_URL is not set");
  process.exitCode = 1;
} else {
  const { db, pool } = connectPostgres(url);
  try {
    const applied = await migrate(db);
    console.log(
      applied.length
        ? `db:migrate: applied ${applied.join(", ")}`
        : "db:migrate: schema up to date",
    );
  } catch (e) {
    console.error(`db:migrate: failed (${(e as { code?: string }).code ?? (e as Error).name})`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
