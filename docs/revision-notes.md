# Revision notes

Running list for the next round. Each entry says what is wrong or missing, why
it matters, and where the change would go, so an item can be picked up without
re-deriving the context.

Rewritten for the browser build. The Earth Engine entries that filled the
previous version, quota fallbacks, token expiry, re-billing on reclassification,
are gone because the conditions that produced them are gone.

---

## Known gaps

### 1. Cloud masking is categorical

SCL is the only quality layer a browser can read anonymously, and it is a class
label rather than a probability. It misses thin cloud edges, confuses bright
bare ground with cloud, and forces the composite to be a median because there is
no score to rank observations on. This is the largest single difference from the
Earth Engine build and the reason the stability floor now binds.

*Where:* `src/raster/mask.ts`. The `CloudMask` interface is async and receives
the whole scene block precisely so this can be replaced without touching a
caller.

*Fix:* export a segmentation model such as OmniCloudMask to ONNX and run it with
`onnxruntime-web`, ideally on WebGPU with a WASM fallback. It needs red, green
and NIR at 10 m, which are already being fetched. Expected cost is model weights
in the tens of megabytes, which wants a cache and a first-run download notice.
This is the highest-value item on the list.

### 2. Thresholds re-run the whole analysis

Moving a break and pressing Apply calls `run()` again, which re-downloads
imagery, rebuilds composites and recomputes deltas. Only the classification
depends on the thresholds.

Cheaper than it was, since nothing is billed, but it is still a network round
trip for work whose inputs did not change.

*Where:* `runPeriod` in `src/analysis/run.ts` discards the delta arrays after
painting.

*Fix:* keep the full-extent delta arrays for the session and add a
`reclassify(delta, breaks)` path that repaints and re-tallies without touching
the network. Most of a run's wall clock disappears.

### 3. Area scale does not match the SOP export scale

Class areas are counted at 20 m, while SOP Step 9 exports at 10 m. On fragmented
disturbance the coarser grid under-counts edge pixels, so a hectare figure from
this tool will not exactly reproduce one measured from the exported GeoTIFF.

Twenty metres is the SOP's own analysis scale and the native resolution of B11,
B12 and SCL, so the choice is defensible, and the manifest now states it. The
quota argument that also supported it no longer applies.

*Where:* `ANALYSIS_SCALE` in `src/defaults.ts`.

*Fix:* the grid is resolution-agnostic, so 10 m is a one-line change costing
four times the memory and roughly four times the download. Worth offering as a
switch for small areas rather than as a default.

### 4. An AOI crossing a UTM zone loses overpasses

The working grid is one UTM zone. Overpasses published only in the other zone
cannot be read onto it and are dropped, with a warning. Near a boundary this
costs nothing, because every overpass is published on both sides; far enough
across one, it costs real observations.

*Where:* `observationsOnGrid` in `src/stac/search.ts`.

*Fix:* warp the out-of-zone scenes into the working grid. The read path already
takes a bbox in the scene's CRS, so this is a per-block corner transform and a
resample rather than an architectural change.

### 5. No Landsat, so no pre-2015 baseline

Sentinel-2 begins in 2015 and coverage is thin before 2017. Landsat would extend
it, but the USGS bucket is requester-pays and needs AWS credentials, which would
undo the property that makes this tool usable without accounts.

*Where:* nothing to change today.

*Fix:* none that preserves credential-free access. If a pre-2015 baseline is
ever required, it belongs in a separate local pipeline rather than in this tool.

### 6. The single-thread decode is the bottleneck

Every COG tile is decoded on the main thread. geotiff.js ships a worker `Pool`
that would parallelise it.

*Where:* `src/raster/cog.ts`.

*Fix:* instantiate a `Pool` per run and pass it to `readRasters`. Deferred only
because a worker created from a blob URL inside a plugin bundle needs testing
against the host's content security policy.

### 7. Water is per-scene, not multi-decadal

JRC Global Surface Water has no anonymous COG equivalent, so water comes from
SCL class 6 by majority across the window. Seasonal water is therefore treated
differently from the Earth Engine build.

*Where:* `combineWater` in `src/raster/mask.ts`.

*Fix:* if a stable water layer matters, an open COG equivalent would need
finding first. Not obviously available.

---

## Findings from live runs

### 2026-08-13, rebuilt without Earth Engine

The tool was rebuilt to read Sentinel-2 L2A COGs from AWS Open Data through
Element 84's Earth Search, and every Google dependency was removed: no account,
no OAuth client, no Cloud project, no test-user list, no billing. `src/ee/` and
`@google/earthengine` are deleted.

The trigger was that colleagues without Google addresses could not be granted
access. The stronger reason was licensing: Earth Engine's free tier is
noncommercial, and paid verification work is not.

Three defects were found and fixed during the rebuild that would have been
invisible in the output.

**The radiometric offset.** Products from baseline 04.00 carry a +1000 DN
offset. A window spanning January 2022 would have manufactured roughly 0.04 of
dNDVI from nothing, the exact false signal the SOP's pre-2022 note warns about.
The catalogue reports per scene whether the offset has been removed and the code
acts on that report, not on the acquisition date, because the archive also holds
reprocessed baseline 05.00 products for 2018 to 2021 acquisitions that carry it.

**Duplicate overpasses.** MGRS tiles overlap, so near a UTM zone boundary one
overpass is published twice. Compositing scenes naively weighted those
observations twice, and a first draft reported eleven scenes dropped on an area
where nothing had been lost. Scenes now fold into observations keyed by
datatake.

**Bounding box hectares.** Earth Engine clipped to the ROI geometry. Without
reproducing that, every hectare figure from a loaded boundary would have been a
hectare of its bounding box.

Verified: a run over a known harvest area on Vancouver Island returned in 16
seconds from 11 overpasses, with the dNDVI histogram peaking near zero and 180
ha across the three severity classes over 4961 ha observed. The AOI rasteriser
was checked against analytic shapes, a diamond measuring 49.99 percent of its
box, a square with a square hole 75 percent.

### 2026-08-11, deployed to Pages

The site went live at
<https://seamusrobertmurphy.github.io/disturbance-checker/>, built by GitHub
Actions from `main` into a pinned GeoLibre checkout. That deployment path is
unchanged by the rebuild; only the secret it used has been removed.

### Earlier, layer registration

GeoLibre's plugin API exposes no `removeLayer`, so every layer this plugin
creates is drawn directly on the MapLibre instance and registered through
`registerExternalNativeLayer`, which does have an unregister counterpart. That
is what lets a re-run replace its layers instead of stacking them.
