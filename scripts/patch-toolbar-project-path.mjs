// Removes the project path from GeoLibre's top toolbar.
//
// GeoLibre prints the project path at the right end of its toolbar, and on a
// GitHub Pages deploy that path is the deploy's own URL, so every screenshot of
// the tool carried an account name and a repository address across the top. The
// span is deleted outright. An earlier version replaced it with a link on
// GitHub's mark, which still spelled the account out in the href.
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

// Nothing replaces it. The toolbar simply ends after the theme control.
const link = "";

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
console.log(`Removed the project path from ${target}.`);
