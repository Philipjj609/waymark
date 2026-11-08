import { notFound } from "next/navigation";
import { LabGame } from "./lab-game";
import "./lab.css";

/** Read the flag per request: a static render would freeze it at build time. */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "A month you can rehearse (spike)",
  description: "Fictional money. An experiment in planning a month and trying it again.",
};

/** SPIKE (#110). Off unless WAYMARK_LAB=1, and not linked from the app. */
export default function LabPage() {
  if (process.env.WAYMARK_LAB !== "1") notFound();
  return <LabGame />;
}
