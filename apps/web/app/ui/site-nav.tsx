"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** The three places of the product. "Map" lives under /learn but is its own destination. */
const DESTINATIONS = [
  {
    href: "/learn",
    label: "Learn",
    match: (p: string) => p.startsWith("/learn") && p !== "/learn/map",
  },
  { href: "/run", label: "Practise", match: (p: string) => p.startsWith("/run") },
  { href: "/learn/map", label: "Map", match: (p: string) => p === "/learn/map" },
] as const;

function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path d="M16 2.5 28 9v14L16 29.5 4 23V9z" fill="currentColor" opacity="0.14" />
      <path
        d="M9 22 14 10l4 8 5-10"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Top bar: name, the three destinations, and a quiet link to the PayPal checkout demo. */
/** `checkoutLink` is off on the fictional FP-30 screen, which must not mention PayPal at all. */
export function SiteHeader({
  compact = false,
  checkoutLink = true,
}: {
  compact?: boolean;
  checkoutLink?: boolean;
}) {
  const path = usePathname() ?? "";
  return (
    <header className="site-bar" data-compact={compact ? "" : undefined}>
      <div className="site-bar-in">
        <Link href="/" className="brand">
          <BrandMark />
          <span>Waymark</span>
        </Link>
        <nav className="site-nav" aria-label="Main">
          {DESTINATIONS.map((d) => (
            <Link key={d.href} href={d.href} aria-current={d.match(path) ? "page" : undefined}>
              {d.label}
            </Link>
          ))}
        </nav>
        {checkoutLink ? (
          <Link href="/checkout" className="site-aside">
            PayPal checkout demo
          </Link>
        ) : null}
      </div>
    </header>
  );
}

const ICONS: Record<string, ReactNode> = {
  Learn: (
    <path
      d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v15H5.5A1.5 1.5 0 0 0 4 20.5zM20 5.5A1.5 1.5 0 0 0 18.5 4H13v15h5.5a1.5 1.5 0 0 1 1.5 1.5z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
    />
  ),
  Practise: (
    <path
      d="M5 19c4 0 3-7 7-7s3-7 7-7M5 19h.01M19 5h.01"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
    />
  ),
  Map: (
    <path
      d="M4 6.5 9 4.5l6 2 5-2v13l-5 2-6-2-5 2zM9 4.5v13M15 6.5v13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
    />
  ),
};

/** Phone bottom bar with the same three destinations. Not used on /run, which owns its own. */
export function TabBar() {
  const path = usePathname() ?? "";
  return (
    <nav className="tabbar" aria-label="Quick tabs">
      {DESTINATIONS.map((d) => (
        <Link key={d.href} href={d.href} aria-current={d.match(path) ? "page" : undefined}>
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            {ICONS[d.label]}
          </svg>
          {d.label}
        </Link>
      ))}
    </nav>
  );
}
