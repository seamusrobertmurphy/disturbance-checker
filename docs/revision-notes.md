# Revision notes

This is a running list for the next round. Each entry describes what is
missing or could work better, why it matters and where the change would go, so
that an item can be picked up without reconstructing the context.

The list was rewritten for the browser build. The Earth Engine entries in the
previous version, covering quota fallbacks, token expiry and re-billing on
reclassification, were removed because the conditions behind them no longer
apply.

---

## Known gaps

### 1. The model mask is not the default, and is slow over large areas

This is largely done, with two edges remaining. OmniCloudMask now runs in the
tab behind the same `CloudMask` interface, on WebGPU where the browser has it,
and [methods.md](methods.md) describes what it was measured to do.

The model costs roughly half a second per overpass per block, so a rectangle of
several thousand square kilometres takes about an hour of inference and the
scene classification remains the practical choice there. The panel notes this,
although the run does not yet estimate the cost from the block and overpass
counts and offer the swap before starting. Each block is also normalised
independently, as the package's own patch normalisation does, whereas the
package overlaps its patches by 300 pixels and feathers the joins and blocks
here abut. No seams have appeared in a result so far, although they have not
yet been looked for systematically.

*Where:* `src/raster/omni.ts`, and `BLOCK_SIZE` in `src/analysis/run.ts`.

*Fix:* running the mask at 40 m would serve the speed case. Measured on the
same block, that is four times cheaper and changes the keep-or-discard decision
on 5.4 percent of pixels, mostly at cloud edges, so it is best offered as an
option rather than applied without notice.

### 2. Thresholds re-run the whole analysis

Moving a break and pressing Apply calls `run()` again, which re-downloads
imagery, rebuilds composites and recomputes deltas. Only the classification
depends on the thresholds.

The cost is lower than it was, since nothing is billed, although it remains a
network round trip for work whose inputs have not changed.

*Where:* `runPeriod` in `src/analysis/run.ts` discards the delta arrays after
painting.

*Fix:* keeping the full-extent delta arrays for the session and adding a
`reclassify(delta, breaks)` path that repaints and re-tallies without touching
the network would remove most of a run's wall clock time.

### 3. Area scale does not match the SOP export scale

Class areas are counted at 20 m, while SOP Step 9 exports at 10 m. On fragmented
disturbance the coarser grid under-counts edge pixels, so a hectare figure from
this tool will not exactly reproduce one measured from the exported GeoTIFF.

Twenty metres is the SOP's own analysis scale and the native resolution of B11,
B12 and SCL, which supports the choice, and the manifest now states it. The
quota argument that also supported it no longer applies.

*Where:* `ANALYSIS_SCALE` in `src/defaults.ts`.

*Fix:* the grid is resolution-agnostic, so 10 m is a one-line change costing
four times the memory and roughly four times the download, which makes it a
reasonable switch for small areas rather than a default.

### 4. An AOI crossing a UTM zone loses overpasses

The working grid is one UTM zone. Overpasses published only in the other zone
cannot be read onto it and are dropped, with a warning. Near a boundary this
costs nothing, because every overpass is published on both sides; far enough
across one, it costs real observations.

*Where:* `observationsOnGrid` in `src/stac/search.ts`.

*Fix:* the out-of-zone scenes could be warped into the working grid. The read
path already takes a bbox in the scene's CRS, so this is a per-block corner
transform and a resample rather than an architectural change.

### 5. No Landsat, so no pre-2015 baseline

Sentinel-2 begins in 2015 and coverage is thin before 2017. Landsat would extend
it, but the USGS bucket is requester-pays and needs AWS credentials, which would
undo the property that makes this tool usable without accounts.

*Where:* nothing to change today.

*Fix:* no option preserves credential-free access. A pre-2015 baseline, if
required, would sit better in a separate local pipeline than in this tool.

### 6. The single-thread decode is the bottleneck

Every COG tile is decoded on the main thread. geotiff.js ships a worker `Pool`
that would parallelise it.

*Where:* `src/raster/cog.ts`.

*Fix:* instantiating a `Pool` per run and passing it to `readRasters` would
address this. It is deferred only because a worker created from a blob URL
inside a plugin bundle needs testing against the host's content security
policy.

### 7. Water is per-scene, not multi-decadal

JRC Global Surface Water has no anonymous COG equivalent, so water comes from
SCL class 6 by majority across the window. Seasonal water is therefore treated
differently from the Earth Engine build.

*Where:* `combineWater` in `src/raster/mask.ts`.

*Fix:* a stable water layer would first need an open COG equivalent, and none
is obviously available.

### 8. The season charts show climate, not greenness

The charts under the reporting periods draw temperature, sunlight, rain and
snow from NASA POWER, on a grid about fifty kilometres across. They show
whether the season ran early or late, but not how green the canopy was inside
each window, which is what the delta depends on and, in a mixed deciduous stand,
what decides whether two composites are comparable.

*Where:* `src/reference/climate.ts` and `renderClimate` in
`src/panel/panel.ts`.

*Fix:* a greenness curve from the imagery itself would fill this gap. The mean
NDVI over the area of interest for every clear overpass in a year, drawn on the
same January to December axis, would put the phenology beside the climate that
drives it. The cost is reading every scene of the year over the area rather
than the two windows, which for a small project is a few hundred range reads and
for a large one adds to run times that are already long, so it would suit a
button rather than an automatic step, and only over the working grid.

---

## Findings from live runs

### 2026-08-13, rebuilt without Earth Engine

The tool was rebuilt to read Sentinel-2 L2A COGs from AWS Open Data through
Element 84's Earth Search, and every Google dependency was removed, so there is
no account, OAuth client, Cloud project, test-user list or billing. `src/ee/`
and `@google/earthengine` are deleted.

The rebuild was prompted by colleagues without Google addresses, who could not
be granted access. Licensing was the stronger reason, because Earth Engine's
free tier is noncommercial and paid verification work is not.

Three defects that would not have been visible in the output were found and
fixed during the rebuild.

**The radiometric offset.** Products from baseline 04.00 carry a +1000 DN
offset. A window spanning January 2022 would have produced roughly 0.04 of
spurious dNDVI, the same false signal the SOP's pre-2022 note describes.
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

A verification run over a known harvest area on Vancouver Island returned in 16
seconds from 11 overpasses, with the dNDVI histogram peaking near zero and 180
ha across the three severity classes over 4961 ha observed. The AOI rasteriser
was checked against analytic shapes, a diamond measuring 49.99 percent of its
box, a square with a square hole 75 percent.

### 2026-08-11, deployed to Pages

The site went live at
<https://seamusrobertmurphy.github.io/disturbance-checker/>, built by GitHub
Actions from `main` into a pinned GeoLibre checkout. That deployment path is
unchanged by the rebuild, and only the secret it used has been removed.

### Earlier, layer registration

GeoLibre's plugin API exposes no `removeLayer`, so every layer this plugin
creates is drawn directly on the MapLibre instance and registered through
`registerExternalNativeLayer`, which does have an unregister counterpart. That
is what lets a re-run replace its layers instead of stacking them.
