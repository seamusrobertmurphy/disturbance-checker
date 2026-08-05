# Documentation library

Guides for the Disturbance Check tool. Everything here is also available inside
the app, under the **Help** menu in the toolbar and in the Help section at the
bottom of the tool panel.

## For colleagues running checks

1. [Using the tool](using-the-tool.md) — a walkthrough of a single disturbance
   check, from opening the page to a manifest you can paste into a finding.
2. [Interpreting results](interpreting-results.md) — what the layers mean, how
   to read the histogram before trusting the map, how to cross-check the three
   indices, and what to confirm before raising anything.

## For whoever sets it up

3. [Earth Engine setup](earth-engine-setup.md) — registering the OAuth client,
   the Cloud project and billing, granting colleagues access, and where the
   client ID goes.
4. [First run](first-run.md) — the three ways to reach a live run, what each
   stage looks like, and the failures most likely to appear.

## For maintainers

5. [Revision notes](revision-notes.md) — known gaps, why each matters, where a
   change would go, and findings from live runs.

## Adding a guide

Write the markdown in this folder, then add one entry to `GUIDES` in
`src/help/registry.ts`. The build renders it to HTML and it appears in the app
automatically. Give it an `audience` so it files itself under the right heading:
`operator`, `setup` or `maintainer`.

Cross-document links written the normal markdown way, such as
`[first run](first-run.md)`, are rewritten at build time so they switch guides
inside the app rather than navigating away. The same files stay readable on
GitHub.
