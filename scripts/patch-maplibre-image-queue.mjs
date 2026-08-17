// Repairs the image request queue drainer in a built MapLibre bundle.
//
// MapLibre queues image requests above MAX_PARALLEL_IMAGE_REQUESTS, which is
// sixteen. When a request settles, doImageRequest does
// `delete itemInQueue.abortController`, and processQueue then reads
// `topItemInQueue.abortController.signal.aborted` off an entry that can
// already be cleared. Each such read throws a TypeError inside the async
// settle path, where nothing awaits it, so every queued basemap tile
// surfaces once as an unhandled promise rejection: the sixteen errors the
// diagnostics panel opens on. The tiles themselves draw.
//
// Verified against maplibre-gl 5.24.0, dist/maplibre-gl.js, the file the
// GeoLibre v1.9.0 build consumes through the package "main" entry. The
// deploy pins both versions, so the minified text is deterministic. The
// patch treats a cleared entry the way an aborted one is already treated:
// skip it without starting a request.
//
// Run after `npm ci` and before `npm run build` in the GeoLibre checkout.
// Exits nonzero when the drainer is not found exactly once, so a future
// GEOLIBRE_REF bump that changes MapLibre forces this file to be re-read
// against the new bundle instead of silently shipping unpatched.

import { readFileSync, writeFileSync } from "node:fs";

const target = process.argv[2] ?? "node_modules/maplibre-gl/dist/maplibre-gl.js";
const source = readFileSync(target, "utf8");

// Minified form of: const item = queue.shift(); item.abortController.signal.aborted ? ...
const drainer =
  /const ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.shift\(\);\1\.abortController\.signal\.aborted\?/g;

const matches = [...source.matchAll(drainer)];
if (matches.length !== 1) {
  console.error(
    `Expected the image queue drainer exactly once in ${target}, found ${matches.length}. ` +
      "MapLibre has changed; re-read its ImageRequest.processQueue before deploying.",
  );
  process.exit(1);
}

const patched = source.replace(
  drainer,
  (_, item, queue) =>
    `const ${item}=${queue}.shift();(!${item}.abortController||${item}.abortController.signal.aborted)?`,
);

writeFileSync(target, patched);
console.log(`Patched the image queue drainer in ${target}`);
