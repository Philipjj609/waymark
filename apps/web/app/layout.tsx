import type { ReactNode } from "react";
import { APP_NAME } from "../lib/brand";
import "./globals.css";
import "./ui/ui.css";
import { AppShell } from "./ui/app-shell";

export const metadata = {
  title: {
    default: `${APP_NAME}: learn money by studying it, then by living it`,
    template: `%s | ${APP_NAME}`,
  },
  description:
    "Financial education in two halves: lessons with an adaptive AI tutor, and a practice money life played week by week. All game money is fictional; payments use PayPal Sandbox test money.",
};

export const viewport = { width: "device-width", initialScale: 1 };

const FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,750&family=Instrument+Sans:wght@400;500;600;700&display=swap";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* Non-blocking: if the fonts cannot load, the system fonts in the tokens are used. */}
        <link rel="stylesheet" href={FONTS_HREF} />
      </head>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
