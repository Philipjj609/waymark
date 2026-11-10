import Link from "next/link";
import type { ReactNode } from "react";
import "./learn.css";
export default function LearnLayout({ children }: { children: ReactNode }) {
  return (
    <main className="learn-shell">
      <header>
        <Link href="/learn" className="learn-brand">
          Waymark · Learn
        </Link>
        <nav aria-label="Learn navigation">
          <Link href="/learn/modules/foundations">Curriculum</Link>
          <Link href="/learn/map">Knowledge map</Link>
          <Link href="/learn/notes">My notes</Link>
        </nav>
      </header>
      {children}
    </main>
  );
}
