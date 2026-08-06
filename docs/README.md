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

## Method and reference

3. [From QGIS to the browser](from-qgis.md) — what this tool replaces, what is
   deliberately identical, what changed and why, and what the QGIS script still
   does better. Illustrated with the original SOP screenshots.
4. [Methods reference](methods.md) — the full processing chain with every
   constant, and a table of where the SOP PDF, the QGIS script and the ArcGIS
   script disagree.

## For whoever sets it up

5. [Earth Engine setup](earth-engine-setup.md) — registering the OAuth client,
   the Cloud project and billing, granting colleagues access, and where the
   client ID goes.
6. [First run](first-run.md) — the three ways to reach a live run, what each
   stage looks like, and the failures most likely to appear.

## For maintainers

7. [Revision notes](revision-notes.md) — known gaps, why each matters, where a
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

Images work the same way. Reference one relatively, `![alt](images/foo.webp)`,
and the build inlines its bytes as a data URI so the bundle stays self-contained
under GeoLibre's content security policy, while the relative path keeps working
on GitHub. A reference to a file that does not exist fails the build rather than
shipping a broken image. Only images a guide actually uses are inlined, so
adding a file to `images/` costs nothing until it is referenced.

Source material for the figures lives alongside: the SOP `.docx` files, the
`Screenshots/` captures and the `Slides/` deck. Everything under `images/` is a
downscaled WebP derived from those.
