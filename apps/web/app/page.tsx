import { APP_NAME, SCENARIO_NAME } from "../lib/brand";
import { WorldShell } from "./world-shell";

export default function Page() {
  return (
    <main className="page">
      <header className="app-header">
        <h1 className="app-title">
          {APP_NAME}: {SCENARIO_NAME}
        </h1>
        <p className="app-subtitle">A fictional month. You decide; the world keeps the books.</p>
      </header>
      <p className="fiction-banner">
        <strong>All money in this world is FICTIONAL.</strong> Educational simulation, not financial
        advice.
      </p>
      <WorldShell />
    </main>
  );
}
