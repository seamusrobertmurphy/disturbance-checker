# General

- 2026-08-17: disturbance-checker (this repo, 0.10.x) is the interactive screening tool; the sibling repo disturbance-check (0.2.x) is the delivered-layers viewer, kept its own in-plugin rejection silencer (ce93c2b), and is not to be modified from here. Both declare the identical plugin id `tuvsud-disturbance-check`, so only repo name, version and description tell them apart. Matters because the shared id invites mixing them up.

- 2026-08-17: The sixteen "Unhandled promise rejection" entries in the diagnostics panel are an upstream MapLibre defect, verified in maplibre-gl 5.24.0 `dist/maplibre-gl.js`: `processQueue` reads `abortController.signal.aborted` off queue entries that `doImageRequest` has already cleared with `delete itemInQueue.abortController`, so every basemap tile queued above the sixteen-request cap rejects once with a TypeError. The tiles still draw. Matters because the panel opens on them and they look like plugin failures.
- 2026-08-17: The fix runs at deploy time, not in the plugin. `scripts/patch-maplibre-image-queue.mjs` repairs the drainer inside the GeoLibre checkout after `npm ci` and before the GeoLibre build in `.github/workflows/deploy.yml`, and fails the build if the pinned MapLibre ever stops matching. Matters because plugin bytes stay identical to the approved state 3a7bfeb.
- 2026-08-17: An earlier in-plugin fix, an `unhandledrejection` silencer shipped as 0.10.1 (e4d2378), correlated with the plugin failing to activate in Safari and was reverted in 93d0654; cause never established. Matters because any future fix for these rejections should avoid touching plugin activation code.
- 2026-08-17: v0.12.0 restored the OmniCloudMask feature (commits 8a67ea7, 63107b7, db667a0, ee75b91) without the delivery section, which stays in the sibling viewer; section 9 is "Findings" again and state carries no Delivery. Versions 0.10.1 and 0.11.x are used and must not be reissued. Matters because a re-restore or comparison should diff against 7fbd8c8, not the raw feature commits.
- 2026-08-17: The single "circle_11_black could not be loaded" console warning comes from a GeoLibre host component requesting a sprite icon from the deploy's satellite basemap style, which ships no `sprite`. Not caused by this plugin, cosmetic, left unfixed.
- 2026-08-27: The two opengeos QGIS plugins from the old workflow each build their own private virtualenv and do not share packages: Earth Engine Data Catalogs uses `~/.qgis_gee_data_catalogs/venv` (`gee_data_catalogs/core/venv_manager.py:22`) and Geemap uses `~/.qgis_geemap/venv` (`qgis_geemap/core/venv_manager.py:21`), each inserted into `sys.path` only by its own plugin at load. Matters because installing dependencies in one plugin's Dependencies tab leaves the other plugin's Run Code panel raising `No module named 'ee'`, which is the support call we got on a Windows 11 work machine.
- 2026-08-27: The gee-community "Google Earth Engine" QGIS plugin ships its dependencies vendored in `ee_plugin/extlibs` (built by `.github/workflows/actions/setup-extlibs/action.yml` from `requirements.txt`, which pins `earthengine-api==1.7.24` for Python >=3.10) and puts that folder on sys.path in `ee_plugin/__init__.py:18`. Matters because installing it alone makes `import ee` work for every GEE plugin with no pip, no elevated OSGeo4W Shell and no IT ticket, which supersedes SOP section 1.1.
- 2026-09-03: The season charts under the reporting periods read NASA POWER (`power.larc.nasa.gov`, daily point API, community AG), chosen because it answers anonymous browser requests with `access-control-allow-origin: *`, needs no key, is current to about four days ago, and carries no non-commercial clause. Open-Meteo sends CORS but its terms are non-commercial, the same reason Earth Engine was dropped; Daymet's single-pixel service sends no CORS header at all. Matters because the next person to reach for a finer grid will find those two first.
- 2026-09-03: POWER's monthly endpoint returns a thirteenth key per year, `YYYY13`, which is the annual value, and its fill value is -999; the daily endpoint is used instead and the fill is mapped to null in `src/reference/climate.ts`. Matters because a monthly reader that iterates keys blindly gets a phantom month.
- 2026-09-03: Guide screenshots of the panel are made without GeoLibre, by loading `dist/index.js` into a one-file harness page that stubs `registerRightPanel` and calls `applyProjectState`, served locally and captured with `Google Chrome --headless=new --screenshot --virtual-time-budget=20000`, then cropped and saved as WebP into `docs/images/`. The harness lives in the session scratchpad, not the repository. Matters because the Chrome extension was not connected and the docs figures figS1 to figS4 were produced this way at 400 px wide.

## Super-resolution

2026-09-06: opensr-utils 2.0.0 (ESA OpenSR) was installed as an editable user install for MacPorts python3.12 from `/Volumes/PortableSSD/Github/opensr-utils`, CLI at `~/Library/Python/3.12/bin/opensr-run`. It matters that imports break when the portable SSD is unmounted.

2026-09-06: opensr-utils covers only the 10 m bands B02, B03, B04 and B08, so of the three SOP indices in `src/analysis/deltas.ts` it reaches NDVI alone; NDMI needs B11 and NBR needs B8A and B12, all 20 m and all untouched. It matters because super-resolution cannot improve two of the three findings the tool reports.

2026-09-06: LDSR-S2 is a diffusion model with `sampling_steps: 100` and `sampling_eta: 0.95` in `config_10m.yaml`, so two runs of the same area give different imagery. It matters because a non-reproducible evidence layer cannot be reconstructed from the run manifest, which rules it out as an analysis input for ACR verification.

2026-09-06: `opensr_utils/pipeline.py` line 169 accepts only `cpu` or `cuda`, so Apple MPS is refused and every run on this machine is CPU-bound. It matters when estimating run time for a full tile.

2026-09-06: `opensr_utils/data_utils/writing_utils.py` line 434 casts blended output to the raster's integer dtype, so float reflectance input between 0 and 1 rounds to an all-zero output; verified by running the same scene twice, float then uint16 DN. It matters because the failure is silent and the georeferencing looks correct.

2026-09-06: findings and run guidance recorded in `docs/super-resolution.md`, which is not imported by `src/help/registry.ts` and therefore does not ship in the app.

2026-09-06: measured on this machine, LDSR-S2 has 169.0 M parameters, a 1.1 GB checkpoint, and one 128 px patch takes 133.6 s on CPU, so a 500 ha boundary is about 9 minutes and a full 10980 px tile about 14 days. It matters because the package is written for multi-GPU machines and its README gives no sense of CPU cost.

2026-09-06: `opensr_model.load_pretrained` resolves the checkpoint against the current working directory, so the 1.1 GB file is re-downloaded in every new folder. It matters because it is silent and fills disks.

2026-09-06: `buildWarp` in `src/render/paint.ts` line 84 caps every painted layer at 2048 px on the long side, and `run.ts` line 341 uses that default. It matters because a 90,000 acre AOI at 2.5 m is 7,634 px and gets squashed to 9.3 m on screen, while the free 10 m read paints at 10.0 m, so super-resolution buys nothing visible at project scale.

2026-09-06: on this machine the two vendored cloud models ran a 512 block in 423 ms under ONNX Runtime CPU, against the 263 ms WebGPU and 6,301 ms WebAssembly recorded in `src/raster/omni.ts`. It matters as the only anchor for converting a native timing into a browser one, giving WebGPU about 1.6x faster than native CPU and WebAssembly about 15x slower.

2026-09-06: SEN2SRLite from `sen2sr` 0.8.5 is a 572,336 parameter SPAN convolutional network, one forward pass, bitwise deterministic on rerun, and it exported to a 236 KB ONNX file that matched the model ESA ships to 5.96e-07 on the interior of the reference patch, at 80 to 100 ms per 128 px patch under ONNX Runtime CPU. It matters because it removes the size, cost and reproducibility objections that ruled out LDSR-S2, which was 169 million parameters, 1.1 GB and 133.6 s per patch, verified by `scripts/export-sen2sr-model.py`.

2026-09-06: the SEN2SRLite `HardConstraint` uses `torch.fft` and antialiased bicubic, both of which the ONNX exporter refuses, but the stored low-pass mask is a Gaussian whose spatial kernel holds all its energy inside 31 by 31, and the antialiased bicubic x4 enlargement is exactly a 16 by 16 stride-4 transposed convolution. It matters because rewriting both as fixed convolutions made the whole composite exportable with no loss beyond float32 rounding.

2026-09-06: `torch.onnx.export` with `dynamo=True`, the default in torch 2.13, segfaults this interpreter with EXC_BAD_ACCESS at a null address inside `direct_copy_kernel` in `libtorch_cpu.dylib` during decomposition, on a 3.3 GB process so not memory pressure. It matters because `dynamo=False` exports the same model without complaint and every export here must pass it.

2026-09-06: `Reference_RSWIR_x2` sharpens B05, B06, B07, B8A, B11 and B12 from 20 m to 10 m in 12 ms per patch from a 201 KB ONNX file. It matters because B8A, B11 and B12 are exactly the bands NDMI and NBR need and LDSR-S2 could not touch, so it is the only route to moving `ANALYSIS_SCALE` off 20 m, and it needs B05, B06 and B07 added to `REQUIRED_ASSETS` in `src/stac/search.ts`.

2026-09-06: the tool's before-and-after true-colour layers are on the 20 m working grid, not 10 m, because `runPeriod` calls `gridForBounds(epsg, bounds)` with no resolution and the default is `ANALYSIS_SCALE`. It matters because the panel's own subhead claimed 10 m until this date, and a layer painted at 20 m cannot show more than 20 m however far the map is zoomed.

2026-09-06: ONNX Runtime Web accepts the SEN2SRLite graph on the WebAssembly backend and ran one 128 px tile in 243 ms in Node, so `ConvTranspose`, `DepthToSpace`, `Pad` and `ConstantOfShape` are all implemented despite appearing in neither cloud model. It matters because a missing kernel fails only at session creation in a browser, and `scripts/smoke-test.mjs` now runs this check on every build.

2026-09-06: `known-good-2026-09-06` tags f278ff8, the commit deployed before the super-resolution work, and it is pushed. It matters because `deploy.yml` publishes on any push to main, so that tag plus `git revert --no-edit -m 1 HEAD && git push` is the whole rollback.

2026-09-06: SEN2SRLite was rendered end to end in a real browser for the first time, headless Chrome 152 driving the built `sharpenView` over a 8.0 by 5.0 km view near Vanderhoof, BC (bounds -123.06 to -122.98, 53.820 to 53.865, EPSG:32610, 8 observations from 2024-07-01 to 2024-09-15, SCL mask). ONNX Runtime Web took the graph on the WebGPU provider, not the WebAssembly fallback, and returned a 2108 by 2008 PNG at 2.5 m that decoded into an `<img>`. It matters because until this run nothing had shown the layer painting at all, only that the graph loaded in Node.

2026-09-06: measured in that browser run, the model costs 73.4 ms per 128 px tile on WebGPU once warm and 4.77 s on the first pass including the 236 KB download and session start, while the whole `sharpenView` call took 30.4 s, so the two 512 blocks of COG reading were about 28 s of it and inference 1.8 s. It matters because the header comment on `sharpenView` in `src/analysis/sharpen.ts` estimates roughly a minute of reading for a full 4096 px view, and scaling this measurement puts that nearer two minutes; the under ten seconds it claims for the model is right.

2026-09-06: the tile stitching leaves no seam. Mean absolute row and column gradient at every trim boundary of that render sat within 1.2 standard deviations of the image median, and the one visible horizontal line was a 30 row luminance ramp from field to forest, not a step. It matters because the 8 pixel trim and the overlap it implies were untested until this render.

## Visualisation and atmosphere

2026-09-06: the QGIS and ArcGIS production scripts disagree on the true-colour stretch. `TUVSUD_DisturbanceCheck-QGIS.py` line 756 sets `vis_rgb` to min 0.02, max 0.25, gamma 1.2 and `TUVSUD_DisturbanceCheck-ArcGIS.py` line 936 sets `VIS_RGB` to min 0, max 0.3, gamma 1.2; `RGB_VIS` in `src/defaults.ts` copies the QGIS pair. It matters because the browser tool's fidelity claim is to one of two disagreeing SOPs and a future reviewer will find the other.

2026-09-06: the QGIS pair reads dark on conifer country. Measured over the Vanderhoof view, the 0.02 floor drove 26.7 per cent of red and 16.5 per cent of blue to pure black while the 0.25 ceiling was never approached, the 99th percentiles being 0.159 red, 0.139 green and 0.112 blue, and green clipped only 0.08 per cent, which is the green cast. It matters because the same pair still governs the before-and-after analysis layers, which were deliberately left on it.

2026-09-06: the super-resolution model does not change brightness. Mean reflectance either side of inference matched to four decimals, 0.0419 red, 0.0582 green, 0.0356 blue in and 0.0419, 0.0582, 0.0355 out, so the hard constraint holds in practice. It matters because it rules the model out whenever the backdrop looks wrong.

2026-09-06: Sentinel-2 L2A publishes no cirrus band, verified by querying earth-search for one item; band 10 appears only in `sentinel-2-l1c`, at 60 m, and L1C is top-of-atmosphere. The same L2A item does publish `aot`, `wvp`, `cloud`, `snow`, `nir09`, `coastal` and the three red edges, none of which the tool read before this date. It matters because a cirrus correction cannot be run on the data this tool reads without abandoning surface reflectance.

2026-09-06: AOT and WVP are outputs of Sen2Cor, not independent looks at the sky, and where a scene carries no dense dark vegetation the aerosol retrieval cannot run and Sen2Cor substitutes a constant, a default visibility of 40 km and an optical thickness near 0.2, with nothing in the delivered layer marking which pixels are measured. Validation against AERONET puts it near 9 per cent normalised error with R2 about 0.65 and underestimating most at high load. It matters because it is why `src/analysis/run.ts` reports them and warns only on the difference between windows rather than masking on either.

## Host app

2026-09-06: GeoLibre prints the store's `projectPath` at the right end of its toolbar, `apps/geolibre-desktop/src/components/layout/TopToolbar.tsx` line 1198 at tag v1.9.0, which on a Pages deploy is the deploy's own URL. `scripts/patch-toolbar-project-path.mjs` replaces it at deploy time with a link on GitHub's mark and removes the now-unused store binding, because GeoLibre builds with `tsc -b`. It matters because it is the second deploy-time patch of the host and both must be re-read on a `GEOLIBRE_REF` bump.

## Browser harness

2026-09-06: the way to exercise plugin code against real imagery in a real browser is a scratch entry file built by vite against `src/`, served with the vendor ONNX files and the onnxruntime-web wasm under a local server, driven by headless Chrome with `--enable-unsafe-webgpu --enable-features=Vulkan,WebGPU`, with the page POSTing its results back to that server. Two traps cost a cycle each: a directory request has no file extension so the server must send `text/html` for it or Chrome downloads the page instead of parsing it, and a `cross-origin-embedder-policy: require-corp` header blocks every cross-origin COG read. It matters because the Chrome extension is not connected on this machine and this is the only route to a real render.

2026-09-08: USGS blocks any request whose User-Agent carries the token `HeadlessChrome` at both `lfps.usgs.gov` and `edcintl.cr.usgs.gov`, returning HTTP 500 and a Barracuda page reading "Web Page Blocked! ... Attack ID: 20000051" with no `access-control-allow-origin`, so a page fetch reads it as `Failed to fetch`. Isolated by replaying Chrome's captured headers one at a time with curl: the UA alone triggers it and `Chrome/152` in place of `HeadlessChrome/152` passes. It matters because it produced a false LANDFIRE outage in the headless harness, and every headless run against a USGS host must pass `--user-agent` with an ordinary Chrome string.

2026-09-08: the panel itself is exercised by loading `dist/index.js` into a one-file page that stubs `registerRightPanel`, records `addSource` and `addLayer` on a fake map instead of drawing, calls `applyProjectState` with an AOI and periods, then clicks its way through and writes the transcript into a `<pre>` read back with `--dump-dom`. Sections render closed since 7899be6, so section 8 must be clicked before any corroboration button exists. It matters because the four corroboration faults fixed in 2108bcc were invisible to `tsc` and to the Node-level service probes, which all passed.

2026-09-08: GeoLibre's Earth Engine panel fails on the Pages deploy because
`packages/plugins/src/plugins/earth-engine-auth.ts` falls back to opengeos's own
client id, `141292844612-gitmgm28jkmkujonfkrkvdaqjiqt6qkf.apps.googleusercontent.com`,
which does not list `https://prototype-tools.github.io` as an authorized
JavaScript origin; the authorization request returns `redirect_uri_mismatch`
with "register the JavaScript origin in the Google Cloud Console". It matters
because the sign-in fails before any account is involved, so an Earth Engine
account cannot fix it. Setting `VITE_GEE_OAUTH_CLIENT_ID` on the GeoLibre build
step overrides it; the same variable read by the `maplibre-gl-earth-engine` npm
package does not, its env literal having been frozen at publish time, which is
visible as `BASE_URL "/"` in that chunk against `"/disturbance-checker/"` in
GeoLibre's own. The panel persists the project id but never the client id, and
reads `?ee_project_id=` ahead of the build-time value. Settings > Environment
Variables cannot supply the client id either: `getRuntimeEnvironment()` in
`packages/core/src/runtime-env.ts` overlays `window.__GEOLIBRE_RUNTIME_ENV__`
onto the build env, but the Earth Engine files call their own
`importMetaEnv()` and never that, so the build variable is the only route on
the web build. Earth Engine itself takes no API key; GeoLibre's only Google
key, `VITE_GOOGLE_MAPS_API_KEY`, is for Street View and Google Traffic.

## Deploy check

2026-09-10: a deploy is confirmed by fetching the published bundle at `<site>/plugins/<plugin id>/dist/index.js` with a `?v=<epoch>` query and searching it for the changed text, because Pages serves it with `cache-control: max-age=600` and a plain fetch a minute after run 34521081130 succeeded still returned the old `"Pre year"` bundle; `gh run list -c` also matched nothing on the short SHA `cf0cc73`, so filter by the full SHA or not at all. It matters because both traps make a good deploy look failed.
