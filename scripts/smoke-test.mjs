// Loads the built bundle the way GeoLibre's external-plugin loader does and
// asserts the plugin contract holds. The Earth Engine client touches `window`
// at module scope, so a minimal DOM is stubbed before the import.
//
// This does not exercise Earth Engine itself, which needs a browser, OAuth and
// a billed Cloud project. It catches the failures that would otherwise only
// appear after a deploy: a broken bundle, a missing export, a manifest that has
// drifted from the plugin object.

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const storage = () => {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
};

const styleSheets = [];
const stubElement = () => ({
  className: "",
  style: {},
  dataset: {},
  classList: { add() {}, remove() {} },
  appendChild() {},
  removeChild() {},
  setAttribute() {},
  addEventListener() {},
  querySelector: () => null,
});

const define = (name, value) =>
  Object.defineProperty(globalThis, name, {
    value,
    writable: true,
    configurable: true,
  });

globalThis.window = globalThis;
globalThis.self = globalThis;
// Node 22 defines `navigator` and `location` as getters on globalThis, so plain
// assignment throws.
define("location", new URL("https://example.invalid/?x=1"));
define("navigator", { userAgent: "node" });
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();
globalThis.document = {
  readyState: "complete",
  styleSheets,
  head: stubElement(),
  body: stubElement(),
  documentElement: stubElement(),
  createElement: () => stubElement(),
  createElementNS: () => stubElement(),
  getElementsByTagName: () => [],
  addEventListener() {},
};

const module = await import(join(root, "dist/index.js"));
const plugin = module.default;
const manifest = JSON.parse(readFileSync(join(root, "plugin.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

assert.ok(plugin, "the bundle has no default export");
assert.equal(typeof plugin.activate, "function", "activate is not a function");
assert.equal(typeof plugin.deactivate, "function", "deactivate is not a function");

// GeoLibre rejects a plugin whose exported identity disagrees with plugin.json.
assert.equal(plugin.id, manifest.id, "plugin id does not match plugin.json");
assert.equal(plugin.name, manifest.name, "plugin name does not match plugin.json");
assert.equal(plugin.version, manifest.version, "plugin version does not match plugin.json");
assert.equal(manifest.version, pkg.version, "plugin.json and package.json versions differ");

// Project state must round-trip, because it is the only thing that survives an
// expired session.
const state = plugin.getProjectState();
assert.equal(state.version, 1);
assert.equal(state.periods.length, 1, "expected one default reporting period");
// The production scripts set MAX_CLOUD = 10, and use it only on the legacy
// QA60 path; Cloud Score+ masks per pixel and needs no scene filter.
assert.equal(state.maxCloud, 10, "production scripts set MAX_CLOUD = 10");
assert.equal(
  state.cloudMethod,
  "cloud-score-plus",
  "Cloud Score+ is what both production scripts run; QA60 is the legacy path",
);
assert.equal(state.clearThreshold, 0.4, "CLEAR_THRESHOLD is 0.40 in both scripts");
// Both scripts composite August to September, narrower than the SOP PDF's
// July to September.
assert.ok(
  state.periods[0].preStart.endsWith("-08-01") &&
    state.periods[0].preEnd.endsWith("-09-01"),
  "default window should be August to September, matching the scripts",
);
assert.deepEqual(
  state.breaks.dNDMI,
  { low: 0.15, moderate: 0.3, high: 0.45 },
  "dNDMI defaults must match SOP Step 6",
);
assert.deepEqual(
  state.breaks.dNBR,
  { low: 0.1, moderate: 0.27, high: 0.44 },
  "dNBR defaults must match SOP Step 6 (MTBS / USFS PNW)",
);
assert.deepEqual(
  state.breaks.dNDVI,
  { low: 0.1, moderate: 0.2, high: 0.35 },
  "dNDVI defaults must match SOP Step 6",
);

// The placeholder project must survive into the default state, and must not be
// treated as confirmed.
assert.equal(state.projectId, "murphys-deforisk");

const restored = plugin.applyProjectState(
  {},
  { ...state, maxCloud: 20, projectId: "some-other-project" },
);
assert.equal(restored, true, "applyProjectState should report success");
assert.equal(plugin.getProjectState().maxCloud, 20, "state did not round-trip");

// Severity thresholds are operator-tunable, so they must survive a round trip.
const tuned = plugin.getProjectState();
tuned.breaks.dNDVI = { low: 0.18, moderate: 0.28, high: 0.5 };
plugin.applyProjectState({}, tuned);
assert.deepEqual(
  plugin.getProjectState().breaks.dNDVI,
  { low: 0.18, moderate: 0.28, high: 0.5 },
  "adjusted severity thresholds did not round-trip",
);

// Uploaded site data must persist, or a reopened project loses its orientation.
const withContext = plugin.getProjectState();
assert.deepEqual(
  Object.keys(withContext.context).sort(),
  ["boundary", "plots", "smz"],
  "project state must carry all three site data slots",
);
withContext.context.plots = {
  name: "plots.zip",
  featureCount: 2,
  fields: ["Plot ID", "Species"],
  labelField: "Plot ID",
  geometryKinds: ["Point"],
  bounds: [-123, 48, -122, 49],
  geojson: { type: "FeatureCollection", features: [] },
};
plugin.applyProjectState({}, withContext);
assert.equal(
  plugin.getProjectState().context.plots?.labelField,
  "Plot ID",
  "plot label field did not round-trip",
);

// The plot identifier heuristic decides whether screenshots carry plot numbers.
assert.equal(module.detectLabelField(["Plot ID", "Species"]), "Plot ID");
assert.equal(module.detectLabelField(["PLOT_NO", "AREA"]), "PLOT_NO");
assert.equal(module.detectLabelField(["plot"]), "plot");
assert.equal(module.detectLabelField(["OBJECTID", "SHAPE"]), "OBJECTID");
assert.equal(
  module.detectLabelField(["StandID", "PlotNumber"]),
  "PlotNumber",
  "a plot-specific field must outrank a generic identifier",
);
assert.equal(module.detectLabelField(["geometry", "area_ha"]), null);

// Documentation library ------------------------------------------------------

const guides = module.GUIDES;
assert.ok(Array.isArray(guides) && guides.length > 0, "no guides are registered");

const docsDir = join(root, "docs");
for (const guide of guides) {
  assert.ok(guide.title, `guide ${guide.id} has no title`);
  assert.ok(guide.summary, `guide ${guide.id} has no summary`);
  // Derived from the registry, so adding an audience does not break this.
  assert.ok(
    module.AUDIENCE_ORDER.includes(guide.audience),
    `guide ${guide.id} has audience "${guide.audience}", which is not in AUDIENCE_ORDER and so would never be listed`,
  );
  // Rendered, not raw: a markdown heading that survived as "#" would mean the
  // build-time transform silently did nothing.
  assert.ok(guide.html.length > 500, `guide ${guide.id} rendered suspiciously short`);
  assert.match(guide.html, /<h[12][^>]*>/, `guide ${guide.id} has no rendered headings`);
  assert.ok(
    existsSync(join(docsDir, `${guide.id}.md`)),
    `guide ${guide.id} has no matching file in docs/`,
  );
}

// Every guide in docs/ should be registered, or it is invisible in the app.
const registered = new Set(guides.map((guide) => guide.id));
for (const file of readdirSync(docsDir)) {
  // Skip README (the GitHub index, not an in-app guide) and dot-prefixed files.
  // macOS writes AppleDouble sidecars such as `._first-run.md` when the repo
  // lives on a non-HFS volume, and they are not documents.
  if (file.startsWith(".") || !file.endsWith(".md") || file === "README.md") continue;
  const id = file.replace(/\.md$/, "");
  assert.ok(
    registered.has(id),
    `docs/${file} exists but is not registered in src/help/registry.ts, so it cannot be reached in the app`,
  );
}

// Cross-document links must have been rewritten and must resolve, or a guide
// sends the reader to a dead end.
let crossLinks = 0;
for (const guide of guides) {
  assert.doesNotMatch(
    guide.html,
    /href="[^"]*\.md"/,
    `guide ${guide.id} still has an unrewritten .md link`,
  );
  for (const match of guide.html.matchAll(/href="#doc:([^"#]+)/g)) {
    crossLinks += 1;
    assert.ok(
      module.findGuide(match[1]),
      `guide ${guide.id} links to "${match[1]}", which is not a registered guide`,
    );
  }
}
assert.ok(crossLinks > 0, "no cross-document links were rewritten; the transform may be inert");

// A host with no panel surface must fail activation rather than activate blind.
assert.equal(
  plugin.activate({}),
  false,
  "activate should fail when the host offers no panel surface",
);

console.log("smoke test passed");
console.log(`  guides   ${guides.length}, ${crossLinks} cross-links resolved`);
console.log(`  bundle   ${(readFileSync(join(root, "dist/index.js")).length / 1024).toFixed(0)} kB`);
console.log(`  plugin   ${plugin.id} v${plugin.version}`);
