// Loads the built bundle the way GeoLibre's external-plugin loader does and
// asserts the plugin contract holds. The Earth Engine client touches `window`
// at module scope, so a minimal DOM is stubbed before the import.
//
// This does not exercise Earth Engine itself, which needs a browser, OAuth and
// a billed Cloud project. It catches the failures that would otherwise only
// appear after a deploy: a broken bundle, a missing export, a manifest that has
// drifted from the plugin object.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
assert.equal(state.maxCloud, 30, "SOP default cloud ceiling is 30");
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

// A host with no panel surface must fail activation rather than activate blind.
assert.equal(
  plugin.activate({}),
  false,
  "activate should fail when the host offers no panel surface",
);

console.log("smoke test passed");
console.log(`  bundle   ${(readFileSync(join(root, "dist/index.js")).length / 1024).toFixed(0)} kB`);
console.log(`  plugin   ${plugin.id} v${plugin.version}`);
