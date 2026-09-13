// Removes the GeoLibre logo from the left end of GeoLibre's top toolbar.
//
// The toolbar opens with a map icon and the word "GeoLibre". Neither is a link
// or a control, so the deploy drops both and the toolbar starts at the Project
// menu. GeoLibre's MIT licence notice is untouched.
//
// Verified against apps/geolibre-desktop/src/components/layout/TopToolbar.tsx
// at GeoLibre v1.9.0, the tag the deploy pins, where the logo reads:
//
//   <span className="mr-1 flex shrink-0 items-center gap-1.5 text-sm font-semibold text-primary md:mr-2">
//     <Map className="h-4 w-4" />
//     {showProjectInfo ? (
//       <span className="hidden sm:inline">{appTitle}</span>
//     ) : null}
//   </span>
//
// Run in the GeoLibre checkout after the plugin is dropped in and before the
// app is built. Exits nonzero when any piece is not found exactly once, so a
// GEOLIBRE_REF bump that moves this markup forces this file to be re-read
// rather than silently shipping the logo again.

import { readFileSync, writeFileSync } from "node:fs";

const target =
  process.argv[2] ??
  "apps/geolibre-desktop/src/components/layout/TopToolbar.tsx";
let source = readFileSync(target, "utf8");

// GeoLibre builds with `tsc -b` under noUnusedLocals, so the icon import, the
// title constant and the isTauri import, whose only readers were the logo, go
// with it or the build fails.
const pieces = [
  [
    "the logo span",
    /\n\s*<span className="mr-1 flex shrink-0 items-center gap-1\.5 text-sm font-semibold text-primary md:mr-2">\s*<Map className="h-4 w-4" \/>\s*\{showProjectInfo \? \(\s*<span className="hidden sm:inline">\{appTitle\}<\/span>\s*\) : null\}\s*<\/span>/g,
  ],
  ["the Map icon import", /\n\s*Map,(?=\n)/g],
  [
    "the appTitle constant",
    /\n\s*const appTitle = isTauri\(\) \? "GeoLibre Desktop" : "GeoLibre";/g,
  ],
  [
    "the isTauri import",
    /\nimport \{ isTauri \} from "\.\.\/\.\.\/lib\/tauri-io";/g,
  ],
];

for (const [name, pattern] of pieces) {
  const found = [...source.matchAll(pattern)].length;
  if (found !== 1) {
    console.error(
      `Expected ${name} exactly once in ${target}, found ${found}. ` +
        "GeoLibre's TopToolbar has changed; re-read it before deploying.",
    );
    process.exit(1);
  }
  source = source.replace(pattern, "");
}

for (const leftover of [/\bappTitle\b/, /\bisTauri\b/, /<Map\b/]) {
  if (leftover.test(source)) {
    console.error(
      `${target} still mentions ${leftover} after patching. Re-read it before deploying.`,
    );
    process.exit(1);
  }
}

writeFileSync(target, source);
console.log(`Removed the GeoLibre logo from ${target}.`);
