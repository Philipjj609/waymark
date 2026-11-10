import type { ReactNode } from "react";
import { APP_NAME, SCENARIO_NAME } from "../lib/brand";
import "./globals.css";

export const metadata = {
  title: `${APP_NAME}: ${SCENARIO_NAME}`,
  description: "Financial-education simulation. All money is fictional.",
};

export const viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
