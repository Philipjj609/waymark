import type { Source } from "./types.js";

/**
 * External sources for the starter curriculum (#17). Bibliographic details and locators
 * were checked on 2026-11-07 (see the #17 PR for the verification log).
 *
 * Usage rules (G-10 and the publishers' terms):
 * - The EU/OECD and PISA frameworks are TAXONOMY_ONLY: they classify a fact into a
 *   competence area; they never supply wording.
 * - Every fact is written in our own words. Nothing is copied or adapted from any source.
 * - OpenStax titles are CC BY-NC-SA 4.0 and their pages forbid ingestion into generative
 *   AI without permission: cite them, but never put their text in tutor prompts or a
 *   retrieval corpus.
 * - IFRS texts are paywalled; paragraph numbers were checked against the New Zealand
 *   equivalents published free by the XRB (stated to be equivalent to the IASB texts).
 * - CFPB guidance is US-specific; cite it only for generic, non-legal points (bills
 *   have due dates; paying late can cost money). Never cite fee amounts or legal rules.
 */
export const EXTERNAL_SOURCES: readonly Source[] = [
  // ---- taxonomy (classification only)
  {
    sourceId: "src_eu_oecd_fcf_youth_2023",
    title: "Financial competence framework for children and youth in the European Union",
    publisher: "European Union / OECD (European Commission DG FISMA and OECD/INFE)",
    year: "2023",
    url: "https://finance.ec.europa.eu/publications/commission-and-oecd-infe-publish-joint-framework-children-and-youth_en",
    kind: "COMPETENCE_FRAMEWORK",
    usage: "TAXONOMY_ONLY",
    licence: "© European Union / OECD 2023; no open licence stated: classification only",
    checkedOn: "2026-11-07",
  },
  {
    sourceId: "src_eu_oecd_fcf_adults_2022",
    title: "Financial competence framework for adults in the European Union",
    publisher: "European Union / OECD (European Commission DG FISMA and OECD/INFE)",
    year: "2022",
    url: "https://finance.ec.europa.eu/publications/commission-and-oecd-infe-publish-joint-framework-adults-improve-individuals-financial-skills_en",
    kind: "COMPETENCE_FRAMEWORK",
    usage: "TAXONOMY_ONLY",
    licence: "© European Union / OECD 2022; no open licence stated: classification only",
    checkedOn: "2026-11-07",
  },
  {
    sourceId: "src_oecd_pisa_2022_fl",
    title: "PISA 2022 Assessment and Analytical Framework, ch. 3: Financial Literacy Framework",
    publisher: "OECD Publishing, Paris",
    year: "2023",
    url: "https://doi.org/10.1787/dfe0bf9c-en",
    kind: "COMPETENCE_FRAMEWORK",
    usage: "TAXONOMY_ONLY",
    licence: "CC BY-NC-SA 3.0 IGO: classification only",
    checkedOn: "2026-11-07",
  },
  // ---- definitions
  {
    sourceId: "src_iasb_conceptual_framework_2018",
    title: "Conceptual Framework for Financial Reporting",
    publisher: "International Accounting Standards Board (IFRS Foundation)",
    year: "2018",
    url: "https://www.ifrs.org/issued-standards/list-of-standards/conceptual-framework/",
    kind: "ACCOUNTING_STANDARD",
    usage: "DEFINITION_SUPPORT",
    licence:
      "IFRS Foundation copyright; paragraphs checked via the XRB NZ equivalent (xrb.govt.nz/dmsdocument/3123)",
    checkedOn: "2026-11-07",
  },
  {
    sourceId: "src_ias_7",
    title: "IAS 7 Statement of Cash Flows",
    publisher: "IASB (IFRS Foundation)",
    year: "1992 (as amended)",
    url: "https://www.ifrs.org/issued-standards/list-of-standards/ias-7-statement-of-cash-flows/",
    kind: "ACCOUNTING_STANDARD",
    usage: "DEFINITION_SUPPORT",
    licence:
      "IFRS Foundation copyright; paragraph checked via the XRB NZ IAS 7 (xrb.govt.nz/dmsdocument/5453)",
    checkedOn: "2026-11-07",
  },
  {
    sourceId: "src_openstax_accounting_v1",
    title: "Principles of Accounting, Volume 1: Financial Accounting",
    publisher: "OpenStax, Rice University (Franklin, Graybeal, Cooper)",
    year: "2019",
    url: "https://openstax.org/books/principles-financial-accounting/pages/1-introduction",
    kind: "OPEN_TEXTBOOK",
    usage: "DEFINITION_SUPPORT",
    licence: "CC BY-NC-SA 4.0; no generative-AI ingestion: cite only",
    checkedOn: "2026-11-07",
  },
  {
    sourceId: "src_openstax_economics_3e",
    title: "Principles of Economics 3e",
    publisher: "OpenStax, Rice University (Greenlaw, Shapiro, MacDonald)",
    year: "2022",
    url: "https://openstax.org/books/principles-economics-3e/pages/2-1-how-individuals-make-choices-based-on-their-budget-constraint",
    kind: "OPEN_TEXTBOOK",
    usage: "DEFINITION_SUPPORT",
    licence: "CC BY-NC-SA 4.0; no generative-AI ingestion: cite only",
    checkedOn: "2026-11-07",
  },
  {
    sourceId: "src_openstax_finance",
    title: "Principles of Finance",
    publisher: "OpenStax, Rice University (Dahlquist, Knight)",
    year: "2022",
    url: "https://openstax.org/books/principles-finance/pages/19-1-what-is-working-capital",
    kind: "OPEN_TEXTBOOK",
    usage: "DEFINITION_SUPPORT",
    licence: "CC BY-NC-SA 4.0; no generative-AI ingestion: cite only",
    checkedOn: "2026-11-07",
  },
  {
    sourceId: "src_cfpb_behind_on_bills",
    title: "Your Money, Your Goals: Behind on bills? Start with one step.",
    publisher: "Consumer Financial Protection Bureau (US)",
    year: "c. 2016",
    url: "https://files.consumerfinance.gov/f/documents/cfpb_ymyg_behind-on-bills_print.pdf",
    kind: "PUBLIC_GUIDANCE",
    usage: "DEFINITION_SUPPORT",
    licence: "US federal government work; generic points only, no US-specific rules",
    checkedOn: "2026-11-07",
  },
  {
    sourceId: "src_cfpb_emergency_fund",
    title: "An essential guide to building an emergency fund",
    publisher: "Consumer Financial Protection Bureau (US)",
    year: "2025",
    url: "https://www.consumerfinance.gov/an-essential-guide-to-building-an-emergency-fund/",
    kind: "PUBLIC_GUIDANCE",
    usage: "DEFINITION_SUPPORT",
    licence: "US federal government work; generic points only",
    checkedOn: "2026-11-07",
  },
  // ---- pedagogy (how the items are built, not what they teach)
  {
    sourceId: "src_treagust_1988",
    title:
      "Development and use of diagnostic tests to evaluate students' misconceptions in science",
    publisher: "Treagust, D. F.; International Journal of Science Education 10(2), 159–169",
    year: "1988",
    url: "https://doi.org/10.1080/0950069880100204",
    kind: "PEER_REVIEWED_RESEARCH",
    usage: "PEDAGOGY",
    licence: "Journal copyright: cite only",
    checkedOn: "2026-11-07",
  },
  {
    sourceId: "src_baron_hershey_1988",
    title: "Outcome bias in decision evaluation",
    publisher:
      "Baron, J. & Hershey, J. C.; Journal of Personality and Social Psychology 54(4), 569–579",
    year: "1988",
    url: "https://doi.org/10.1037/0022-3514.54.4.569",
    kind: "PEER_REVIEWED_RESEARCH",
    usage: "PEDAGOGY",
    licence: "Journal copyright: cite only",
    checkedOn: "2026-11-07",
  },
  {
    sourceId: "src_carpenter_2022",
    title: "The science of effective learning with spacing and retrieval practice",
    publisher: "Carpenter, S. K., Pan, S. C. & Butler, A. C.; Nature Reviews Psychology 1, 496–511",
    year: "2022",
    url: "https://doi.org/10.1038/s44159-022-00089-1",
    kind: "PEER_REVIEWED_RESEARCH",
    usage: "PEDAGOGY",
    licence: "Journal copyright: cite only",
    checkedOn: "2026-11-07",
  },
  {
    sourceId: "src_hattie_timperley_2007",
    title: "The power of feedback",
    publisher: "Hattie, J. & Timperley, H.; Review of Educational Research 77(1), 81–112",
    year: "2007",
    url: "https://doi.org/10.3102/003465430298487",
    kind: "PEER_REVIEWED_RESEARCH",
    usage: "PEDAGOGY",
    licence: "Journal copyright: cite only",
    checkedOn: "2026-11-07",
  },
];

/**
 * Locators verified for each source (2026-11-07). Authors must cite only these, so no
 * page or paragraph is ever invented. Keyed by sourceId.
 */
export const VERIFIED_LOCATORS: Readonly<Record<string, readonly string[]>> = {
  src_eu_oecd_fcf_youth_2023: [
    "§2.1.1 Content area 1: Money and transactions (pp. 9–10)",
    "§2.1.2 Content area 2: Planning and managing finances (p. 10)",
    "§2.1.3 Content area 3: Risk and reward (pp. 10–11)",
    "Content area 2, topic 2.2 Managing and planning income and expenditure, competence 84 (p. 30)",
  ],
  src_eu_oecd_fcf_adults_2022: [
    "Content area 1: Money and transactions (p. 8)",
    "Content area 2: Planning and managing finances, topics 2.1 Budgeting and 2.2 Managing income and expenditure (p. 9)",
    "Content area 3: Risk and reward, topic 3.3 Balancing risk and reward (pp. 9–10)",
    "Topic 1.3 Prices, purchases and payments: checking and keeping track of payments, competences 87–92 (p. 24)",
    "Topic 2.8 Debt and debt management: debt accrued from late payments, competences 342–345 (p. 47)",
  ],
  src_oecd_pisa_2022_fl: [
    "Ch. 3, Content: Money and transactions (p. 114)",
    "Ch. 3, Content: Planning and managing finances (p. 115)",
    "Ch. 3, Content: Risk and reward (p. 116)",
    "Ch. 3, Processes: Analyse financial information and situations; Evaluate financial issues (pp. 119–120)",
  ],
  src_iasb_conceptual_framework_2018: [
    "para 1.17 (accrual accounting: effects recorded when they occur, not when cash moves)",
    "paras 4.3–4.4 (asset; economic resource)",
    "para 4.6(a)(i) (a right to receive cash is an economic resource)",
    "para 4.26 (liability: present obligation to transfer an economic resource)",
  ],
  src_ias_7: ["para 6 (definitions of cash and cash equivalents)"],
  src_openstax_accounting_v1: [
    "§9.1 Accounting principles and assumptions regulating revenue recognition",
    "§9.1 Short-term revenue recognition examples (sale on account: receivable now, cash later)",
    "Ch. 9 Key Terms: accounts receivable; accrual accounting",
    "§2.3 Liquidity ratios: working capital and current ratio",
  ],
  src_openstax_economics_3e: [
    "§2.1 The concept of opportunity cost",
    "§2.1 Budget constraints (Work It Out: Understanding budget constraints)",
  ],
  src_openstax_finance: ["§19.1 The cash cycle (timing of inflows and outflows)"],
  src_cfpb_behind_on_bills: [
    "Tool: Bill calendar (list bills and when they are due)",
    "Tool: Prioritizing bills, 'Timing matters' box (consequences of paying late vary)",
  ],
  src_cfpb_emergency_fund: ["Opening sections: what an emergency fund is and why it helps"],
  src_treagust_1988: ["Abstract (two-tier diagnostic items: answer plus reason)"],
  src_baron_hershey_1988: ["Abstract (judging decisions by their outcomes)"],
  src_carpenter_2022: ["Retrieving information from memory; Combining spacing and retrieval"],
  src_hattie_timperley_2007: ["p. 91 feedback about the task; p. 102 summary of the model"],
  src_waymark_agents_invariants: [
    "§6 invariant 1 (integer money)",
    "§6 invariant 6 (only a server-verified COMPLETED capture settles)",
    "§6 invariant 7 (fictional vs sandbox money labelled)",
    "§6 invariant 8 (documents, obligations and cash movements are different things)",
    "§6 invariant 9 (learning evidence is not financial outcome)",
  ],
  src_waymark_adr_0002: [
    "§1 Core rule 5 (receivables and cash are never revenue; net worth vs profit)",
    "§1 Core rule 2 (double entry per entity)",
  ],
  src_waymark_adr_0003: ["Time stops on blocking decisions; DEFER_OBLIGATION recovery path (I-014)"],
  src_waymark_adr_0008: ["Capture verification before settlement; deferral moves DUE to OVERDUE"],
  src_waymark_engine: [
    "PAY_OBLIGATION handler",
    "DEFER_OBLIGATION handler (OVERDUE, no late fee in v1)",
    "PURCHASE_ASSET handler (INSUFFICIENT_FUNDS when cash is short)",
  ],
  src_waymark_fp30_fixture: ["fp30Config(): opening cash, phone and rent bills, net salary"],
};
