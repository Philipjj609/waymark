"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { SiteHeader, TabBar } from "./site-nav";

/**
 * The frame around every page. Pages bring their own <main>, so there is exactly one. The Run
 * draws its own skip link first (its keyboard order and tests depend on it), then the same
 * SiteHeader, and it owns the phone bottom bar, so on /run the shell adds nothing.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname() ?? "";
  if (path.startsWith("/run")) return <>{children}</>;
  return (
    <>
      {/* biome-ignore lint/a11y/useValidAnchor: focuses the page main (each route has its own) */}
      <a
        className="skip-link"
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          const main = document.querySelector("main");
          if (!main) return;
          main.setAttribute("tabindex", "-1");
          main.focus();
          main.scrollIntoView({ block: "start" });
        }}
      >
        Skip to the content
      </a>
      <SiteHeader checkoutLink={path !== "/today"} />
      <div className="shell-body">{children}</div>
      <TabBar />
    </>
  );
}
