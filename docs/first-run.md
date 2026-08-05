# First live run

The Earth Engine side of this tool has never executed. Typecheck, bundling and
the smoke test all pass, but none of them touch Google's servers: they prove the
plugin loads and the constants are right, not that the composite builds or the
reducers return what the code expects. This document is the runbook for finding
out.

## Pick a path

| Path | Setup | Best for |
|------|-------|----------|
| **A. Hosted GeoLibre, install the zip** | ~15 min, no infrastructure | The very first run |
| **B. Local GeoLibre dev server** | A full monorepo install | Iterating on the panel |
| **C. Your GitHub Pages deploy** | Secrets, Pages, a push | Colleagues using it for real |

Start with A. It reaches a live Earth Engine call in the fewest steps, and
everything you learn transfers to C unchanged.

## Path A: hosted GeoLibre

### 1. Register the OAuth client

Follow [`earth-engine-setup.md`](earth-engine-setup.md), with one difference.
Because you are testing inside a GeoLibre deployment you do not own, the
authorized JavaScript origin is theirs, not yours:

```
https://geolibre.app
```

Add your own Pages origin at the same time so you never have to come back:

```
https://seamusrobertmurphy.github.io
http://localhost:5173
```

Google permits origins you do not control. Verification applies to the consent
screen, not to this list.

### 2. Build the zip

```bash
cd /Volumes/PortableSSD/Github/disturbance-checker
npm run package
```

This writes `build/tuvsud-disturbance-check.zip`, about 285 kB, with
`plugin.json` at the archive root, which is the layout the installer requires.

### 3. Open GeoLibre with your credentials in the URL

This build has no client ID compiled in, so supply both values as query
parameters:

```
https://geolibre.app/demo/?gee_client_id=YOUR_CLIENT_ID&ee_project_id=YOUR_PROJECT
```

`ee_project_id` pre-fills and confirms the project, replacing the
`murphys-deforisk` placeholder. Leave it off if you would rather type the
project into the panel and watch the placeholder guard work.

### 4. Install the plugin

**Settings → Manage Plugins → Settings → Install from file**, then choose the
zip. GeoLibre validates the manifest, unpacks the archive in the browser, stores
it in IndexedDB, and loads it immediately. There is no network fetch and no CORS
involved.

The **Disturbance Check** panel should take the Style panel slot on the right,
with the Layer panel still visible beside it.

### 5. Run a check

1. Confirm the Cloud project in section 1.
2. Section 2: pan the map to a project area and press **Use current map view**,
   or upload a boundary. Keep the first test area small, a few thousand
   hectares, so a failure surfaces in seconds rather than minutes.
3. Section 3: leave the July to September defaults, set the pre and post years.
4. Section 4: leave the SOP thresholds alone on the first run.
5. Press **Run check**. A Google sign-in popup appears on first use.

## What to watch, in order

The run proceeds through distinct stages, and each fails differently. The
progress line under the Run button names the stage it is in.

| Stage | Progress text | If it fails |
|-------|---------------|-------------|
| Sign-in | Signing in to Earth Engine | Origin or consent problem |
| Initialise | Signing in to Earth Engine | Project, billing or API problem |
| Geometry | Resolving area of interest | Bad AOI, or an asset you cannot read |
| Composites | `RP1: building composites` | Date or collection problem |
| Deltas | `RP1: computing deltas` | Band naming |
| Per index | `RP1: dNDVI histogram and classification` | Reducer or quota problem |
| Layers | Adding layers | MapLibre or registration problem |

### Success looks like

Six layers per period in the Layer panel. Reading top down: three classified
rasters visible, three continuous deltas hidden, two RGB composites hidden. Over
the basemap you should see coloured cells only where disturbance was detected,
with everything undisturbed transparent.

Section 6 shows scene counts, three histograms with draggable break handles, and
a class-area table in hectares on a UTM projection. Section 7 has the manifest.

### Known-plausible failures

These are the specific things most likely to break, and what each looks like.

**`redirect_uri_mismatch` or a popup that closes immediately.** The origin is not
authorized, or the popup was blocked. Sign-in is deliberately behind the Run
button because popups need a user gesture.

**`Earth Engine client library not initialized`, or 403 on every call.** No
billing account, the Earth Engine API is not enabled, or the signed-in user
lacks `serviceUsageConsumer` on the project.

**`ee.initialize` never calls back.** The client is invoked as
`ee.initialize(null, null, success, error, null, project)`, passing the Cloud
project as the sixth argument. If the installed client version orders these
differently the call will hang rather than throw. Symptom: the panel sits on
"Signing in to Earth Engine" forever. Fix is in `src/ee/api.ts`.

**Empty histograms with layers that still render.** The histogram is read from
`reduceRegion` keyed by band name, and each delta is renamed to `dNDVI`,
`dNDMI` or `dNBR` as the last operation before use. A rename that does not stick
returns an empty array, and `analyseHistogram` reports the empty shape.

**`User memory limit exceeded` on the histogram.** The SOP warns about this for
wide areas. The histogram runs at scale 20 with `maxPixels` 1e10. Shrink the
AOI, or add `bestEffort: true` in `computeHistogram`.

**Class areas all zero.** The grouped reducer assumes band 0 is area and band 1
is class, from `ee.Image.pixelArea().divide(10000).addBands(classified)`. If the
band order differs, `groupField: 1` reads the wrong band.

**Layers appear but the panel toggles do nothing.** Visibility for
externally-registered native layers is driven by `nativeLayerIds`. If the ids
registered do not match the ids actually on the map, the panel and the map
disagree.

**A re-run stacks layers instead of replacing them.** This was a real defect
before the layer manager existed. If it reappears, `removeByPrefix` is not
matching the keys used by `syncLayers`.

## Path B: local dev server

Better for iterating on the panel, at the cost of a full monorepo install.

```bash
cd /Volumes/PortableSSD/Github/GeoLibre
npm install                       # large; the monorepo has many workspaces

cd /Volumes/PortableSSD/Github/disturbance-checker
npm run package
cp -R build/tuvsud-disturbance-check \
  /Volumes/PortableSSD/Github/GeoLibre/apps/geolibre-desktop/public/plugins/

cd /Volumes/PortableSSD/Github/GeoLibre
npm run dev
```

Then open `http://localhost:5173/?gee_client_id=...&ee_project_id=...`.

Plugin discovery happens when the dev server starts, so restart it after every
`npm run package`. Copying the folder again is not enough on its own for a new
plugin id, though updating an existing one is picked up on reload.

## Path C: your Pages deploy

1. **Settings → Secrets and variables → Actions**, add `GEE_OAUTH_CLIENT_ID`.
2. **Settings → Pages**, set Source to **GitHub Actions**.
3. `git push -u origin main`.

The workflow builds the plugin, runs the smoke test, checks out GeoLibre at the
pinned `GEOLIBRE_REF`, drops the plugin in, builds with
`GEOLIBRE_APP_BASE=/disturbance-checker/`, and fails loudly if the plugin is
missing from the output. Colleagues then open the Pages URL and the panel is
already there, with no install step and no trust prompt.
