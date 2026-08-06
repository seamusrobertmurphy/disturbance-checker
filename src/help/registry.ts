import earthEngineSetup from "../../docs/earth-engine-setup.md";
import firstRun from "../../docs/first-run.md";
import fromQgis from "../../docs/from-qgis.md";
import interpretingResults from "../../docs/interpreting-results.md";
import methods from "../../docs/methods.md";
import revisionNotes from "../../docs/revision-notes.md";
import usingTheTool from "../../docs/using-the-tool.md";

// The documentation library. Guides are authored as markdown in docs/ so they
// stay readable on GitHub, and are rendered to HTML at build time by
// vite-plugins/markdown.ts, so nothing is parsed at runtime.
//
// To add a guide: write docs/<name>.md and add an entry here. Nothing else.

export type Audience = "operator" | "setup" | "reference" | "maintainer";

export interface Guide {
  /** Matches the markdown filename without its extension, so cross-links resolve. */
  id: string;
  title: string;
  summary: string;
  audience: Audience;
  html: string;
}

export const AUDIENCE_LABELS: Record<Audience, string> = {
  operator: "Running a check",
  setup: "Setting the tool up",
  reference: "Method and reference",
  maintainer: "Maintaining the tool",
};

export const AUDIENCE_ORDER: Audience[] = [
  "operator",
  "setup",
  "reference",
  "maintainer",
];

export const GUIDES: Guide[] = [
  {
    id: "using-the-tool",
    title: "Using the tool",
    summary:
      "A walkthrough of a single check, from opening the page to a manifest you can paste into a finding.",
    audience: "operator",
    html: usingTheTool,
  },
  {
    id: "interpreting-results",
    title: "Interpreting results",
    summary:
      "What the layers mean, reading the histogram before trusting the map, and what to confirm before raising anything.",
    audience: "operator",
    html: interpretingResults,
  },
  {
    id: "from-qgis",
    title: "From QGIS to the browser",
    summary:
      "What this tool replaces, what is deliberately identical, what changed and why, and what the QGIS script still does better.",
    audience: "reference",
    html: fromQgis,
  },
  {
    id: "methods",
    title: "Methods reference",
    summary:
      "The full processing chain: cloud removal, indices, differencing, histograms, classification and areas, with every constant and every divergence from the SOP and the production scripts.",
    audience: "reference",
    html: methods,
  },
  {
    id: "earth-engine-setup",
    title: "Earth Engine setup",
    summary:
      "The OAuth client, the Cloud project and billing, granting colleagues access, and where the client ID goes.",
    audience: "setup",
    html: earthEngineSetup,
  },
  {
    id: "first-run",
    title: "First run",
    summary:
      "Three ways to reach a live run, what each stage looks like, and the failures most likely to appear.",
    audience: "setup",
    html: firstRun,
  },
  {
    id: "revision-notes",
    title: "Revision notes",
    summary:
      "Known gaps, why each matters, where a change would go, and findings from live runs.",
    audience: "maintainer",
    html: revisionNotes,
  },
];

export function findGuide(id: string): Guide | null {
  return GUIDES.find((guide) => guide.id === id) ?? null;
}

export function guidesFor(audience: Audience): Guide[] {
  return GUIDES.filter((guide) => guide.audience === audience);
}
