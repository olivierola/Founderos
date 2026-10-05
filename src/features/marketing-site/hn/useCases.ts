import type { Art } from "./HnKit";

/* ══ Use cases ═══════════════════════════════════════════════════════════════
   The reference's "Customer stories" slot. We have no customer who has agreed
   to be named, so these are WORKFLOWS: what an agent does in each, described
   as the product runs it. No company, no measured figure — the two lines under
   each title are mechanisms, not results. When real case studies exist they
   take this structure, with the customer's own numbers. */

export type UseCase = {
  slug: string;
  team: string;
  title: string;
  facts: { head: string; label: string }[];
  /** Where the reader goes to read more. */
  to: string;
  art: Art;
  agent: string;
  /** What the agent does, for the card visual. Sample steps, no figures. */
  steps: string[];
  waiting?: string;
};

export const USE_CASES: UseCase[] = [
  {
    slug: "reconciliation",
    team: "Finance",
    title: "Month-end reconciliation, line by line, with every correction approved",
    facts: [
      { head: "2 sources", label: "compared line by line, each gap listed with its reason" },
      { head: "0 writes", label: "to the ledger without your approval" },
    ],
    to: "/solutions/agents",
    art: "blue",
    agent: "Finance agent",
    steps: ["Read March invoices from the ledger", "Matched each line to its purchase order", "Listed 3 gaps, with the reason for each"],
    waiting: "Credit note drafted, waiting for approval",
  },
  {
    slug: "screening",
    team: "HR & Recruiting",
    title: "Every applicant screened against the same written criteria",
    facts: [
      { head: "Cited", label: "the criteria behind every screening note" },
      { head: "Human", label: "decision on every rejection, none automated" },
    ],
    to: "/solutions/governance",
    art: "violet",
    agent: "Recruiting agent",
    steps: ["Read each application against the criteria", "Wrote a screening note per candidate", "Cited the criterion behind each note"],
    waiting: "Shortlist ready, decisions stay with you",
  },
  {
    slug: "reporting",
    team: "Reporting",
    title: "The board report, written from your own figures, not assembled by hand",
    facts: [
      { head: "Sourced", label: "every figure links back to where it came from" },
      { head: "PDF", label: "export from what is on screen, ready to send" },
    ],
    to: "/solutions/foundation",
    art: "olive",
    agent: "Report writer",
    steps: ["Pulled the quarter's figures", "Compared them with the plan", "Wrote the narrative, sources cited"],
    waiting: "Draft ready for your review",
  },
  {
    slug: "onboarding",
    team: "Operations",
    title: "Supplier onboarding without the email chase",
    facts: [
      { head: "Requested", label: "documents asked for, checked and filed by the agent" },
      { head: "Flagged", label: "missing or expired pieces, before anyone signs" },
    ],
    to: "/solutions/foundation",
    art: "orange",
    agent: "Ops agent",
    steps: ["Requested the supplier's documents", "Checked each one for validity", "Filed them in the supplier record"],
    waiting: "1 certificate expired, flagged to you",
  },
  {
    slug: "audit",
    team: "Governance",
    title: "Answering the auditor's questions from one registry",
    facts: [
      { head: "1 registry", label: "of every agent, its risks, policies and controls" },
      { head: "Exportable", label: "call log, arguments, result, duration, run" },
    ],
    to: "/solutions/governance",
    art: "pink",
    agent: "Governance agent",
    steps: ["Listed every agent and its scope", "Matched each to its policies", "Exported the call log for the period"],
    waiting: "Pack ready for the auditor",
  },
];
