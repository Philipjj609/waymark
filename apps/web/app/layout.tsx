import type { ReactNode } from "react";

export const metadata = {
  title: "Waymark (provisional): FP-30",
  description: "Financial-education simulation. All money is fictional.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          maxWidth: 760,
          margin: "0 auto",
          padding: 16,
        }}
      >
        {children}
      </body>
    </html>
  );
}
