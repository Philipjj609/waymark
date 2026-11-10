import { notFound } from "next/navigation";
import { labEnabled } from "../../lib/lab-cursor";
import { LabGame } from "./lab-game";
import "./lab.css";

/** Read the flag per request: a static render would freeze it at build time. */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "A month you can rehearse (spike)",
  description: "Fictional money. An experiment in planning a month and trying it again.",
};

/** SPIKE (#110). Off unless enabled (see labEnabled), and not linked from the app. */
export default function LabPage() {
  if (!labEnabled()) notFound();
  return <LabGame />;
}
