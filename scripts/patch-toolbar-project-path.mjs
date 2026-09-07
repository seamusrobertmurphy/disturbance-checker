// Replaces the project path in GeoLibre's top toolbar with a repository link.
//
// GeoLibre prints the project path at the right end of its toolbar, and on a
// GitHub Pages deploy that path is the deploy's own URL, so every screenshot
// of the tool carries the author's personal GitHub address across the top. The
// span is replaced by an anchor holding GitHub's mark, which says the same
// thing to anyone who wants the source and nothing to anyone who does not.
//
// Verified against apps/geolibre-desktop/src/components/layout/TopToolbar.tsx
// at GeoLibre v1.9.0, the tag the deploy pins, where the span reads:
//
//   {projectPath ? (
//     <span className="hidden truncate lg:inline" title={projectPath}>
//       {projectPath}
//     </span>
//   ) : null}
//
// Run in the GeoLibre checkout after the plugin is dropped in and before the
// app is built. Exits nonzero when the span is not found exactly once, so a
// GEOLIBRE_REF bump that moves this markup forces this file to be re-read
// rather than silently shipping the address again.

import { readFileSync, writeFileSync } from "node:fs";

const target =
  process.argv[2] ??
  "apps/geolibre-desktop/src/components/layout/TopToolbar.tsx";
const source = readFileSync(target, "utf8");

// Whitespace is loose so a formatter pass upstream does not break the match,
// but the attributes and the braced expressions are pinned.
const span =
  /\{projectPath \? \(\s*<span className="hidden truncate lg:inline" title=\{projectPath\}>\s*\{projectPath\}\s*<\/span>\s*\) : null\}/g;

const matches = [...source.matchAll(span)];
if (matches.length !== 1) {
  console.error(
    `Expected the project path span exactly once in ${target}, found ${matches.length}. ` +
      "GeoLibre's TopToolbar has changed; re-read it before deploying.",
  );
  process.exit(1);
}

// GitHub's own mark, inlined rather than imported, because the icon set the
// app depends on has dropped and restored brand glyphs between releases and a
// missing export fails the build rather than the patch.
const link = `<a
          className="hidden shrink-0 items-center text-muted-foreground transition-colors hover:text-foreground lg:flex"
          href="${process.env.REPOSITORY_URL ?? "https://github.com/seamusrobertmurphy/disturbance-checker"}"
          rel="noreferrer noopener"
          target="_blank"
          title="Source code"
        >
          <svg aria-hidden="true" fill="currentColor" height="14" viewBox="0 0 16 16" width="14">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
          </svg>
          <span className="sr-only">Source code</span>
        </a>`;

// The span was the only reader of the store value, and GeoLibre builds with
// `tsc -b`, so leaving the binding behind would fail the build under
// noUnusedLocals rather than ship an unused line.
const binding = /\n\s*const projectPath = useAppStore\(\(s\) => s\.projectPath\);/g;
const bindings = [...source.matchAll(binding)];
if (bindings.length !== 1) {
  console.error(
    `Expected the projectPath binding exactly once in ${target}, found ${bindings.length}. ` +
      "GeoLibre's TopToolbar has changed; re-read it before deploying.",
  );
  process.exit(1);
}

const patched = source.replace(span, link).replace(binding, "");
if (/projectPath/.test(patched)) {
  console.error(
    `${target} still mentions projectPath after patching. Re-read it before deploying.`,
  );
  process.exit(1);
}

writeFileSync(target, patched);
console.log(`Replaced the project path in ${target} with the repository link.`);
