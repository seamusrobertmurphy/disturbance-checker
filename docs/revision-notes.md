# Revision notes

Running list for the next round. Seeded with gaps known at the time of writing,
before the first live run. Add observations from live runs under Findings.

Each entry says what is wrong or missing, why it matters, and where the change
would go, so an item can be picked up without re-deriving the context.

---

## Known gaps, pre-live-run

### 1. Area scale does not match the SOP export scale

Class areas are reduced at scale 20, while SOP Step 9 exports at scale 10. On
fragmented disturbance the coarser grid under-counts edge pixels, so a hectare
figure quoted from this tool will not exactly reproduce one measured from the
exported GeoTIFF.

Scale 20 was chosen because it is the Sentinel-2 SWIR native resolution and
keeps the reduction inside quota on wide areas. The decision is defensible but
undocumented in the output.

*Where:* `AREA_SCALE` in `src/defaults.ts`, surfaced in the manifest.
*Options:* reduce at 10 and accept the quota risk, or state the scale in the
manifest and in the panel next to the table. The second is cheap and honest.

### 2. Histogram has no quota fallback

`computeHistogram` runs with `maxPixels: 1e10` and no `bestEffort`. On a large
AOI Earth Engine will reject the call rather than degrade, and the run fails at
the first index.

*Where:* `computeHistogram` in `src/ee/analysis.ts`.
*Fix:* catch the memory error, retry once with `bestEffort: true`, and mark the
histogram as sub-sampled so the manifest does not imply a full-coverage
distribution.

### 3. Thresholds re-run the whole analysis

Moving a break and pressing Apply calls `run()` again, which rebuilds
composites, recomputes deltas and re-reads all three histograms. Only the
classification actually depends on the thresholds.

This is slow and it re-bills compute for work whose inputs did not change.

*Where:* `runPeriod` in `src/ee/analysis.ts` returns tile URLs, not the images.
*Fix:* keep the delta images in memory for the session and add a
`reclassify(delta, breaks)` path that only re-runs `classifyDelta`, `getTileUrl`
and `computeClassAreas`. Roughly a third of the current cost.

### 4. Session expiry is inferred, not observed

The one-hour token lifetime is assumed and anchored on the moment
authentication succeeded, because the JS client does not expose the real expiry.
A token revoked early, or one Google issues with a different lifetime, leaves
the panel claiming a valid session over dead tiles.

*Where:* `TOKEN_LIFETIME_MS` in `src/ee/api.ts`.
*Fix:* listen for MapLibre source errors on the registered raster layers and
mark the session stale on the first 401 or 403, rather than trusting the clock
alone. The clock stays as the optimistic display.

### 5. No cloud-shadow masking

Only QA60 cloud and cirrus bits are masked, per the SOP. QA60 does not flag
cloud shadow, which depresses NIR and inflates dNDVI in exactly the way real
canopy loss does. The SOP's histogram diagnostic catches the aggregate effect,
but not individual false polygons.

*Where:* `maskClouds` in `src/ee/analysis.ts`.
*Options:* add an SCL-band shadow mask (classes 3 and 8 to 10), or Cloud Score+.
Either changes what the tool certifies, so it needs a decision rather than a
patch, and the SOP should be revised alongside it.

### 6. Plot labels are not deduplicated

`LabelStyle` in GeoLibre supports a `dedupe` mode for co-located points. The
plugin draws its own symbol layer with `text-allow-overlap: true`, so stacked
plots produce overlapping text.

Overlap was chosen deliberately so no plot identifier is ever hidden, which
matters for screenshots, but dense plot grids will look messy.

*Where:* `addVector` in `src/map/layers.ts`.
*Fix:* expose the choice in the panel rather than hard-coding it.

### 7. Uploaded geometry is assumed to be WGS84

Shapefiles carry a `.prj`. `shpjs` reads the projection but the plugin does not
check it, and MapLibre expects EPSG:4326. A boundary in a UTM or state-plane
projection will land in the wrong place, or off the map entirely.

*Where:* `importVectorFile` in `src/vector/import.ts`.
*Fix:* at minimum, sanity-check that coordinates fall inside plausible
longitude and latitude ranges and refuse the file with a clear message if not.
Reprojection is a larger job.

### 8. Multi-period runs are sequential

Periods run one after another, and within a period the three indices run in
sequence. Earth Engine parallelises server-side regardless, but the round trips
do not overlap, so a three-period run takes three times as long as it needs to.

*Where:* the loop in `DisturbancePanel.run`.
*Fix:* `Promise.all` over periods. Watch for quota, since concurrent reductions
compete for the same user memory budget.

### 9. Nothing is exported

Deferred deliberately from the first build. SOP Step 9 exports classified
GeoTIFFs at scale 10 for archiving. Without it, a run leaves no raster artefact,
only the manifest and whatever screenshots were taken.

*Where:* new module, plus a section in the panel.
*Note:* export tasks outlive the browser session, which sits awkwardly with a
tool designed around short live sessions. Worth deciding whether the archive
belongs here at all, or in a separate batch job.

### 10. The cross-check verdict is absent

Deferred at your request. The SOP's decision table (dNDVI High with dNBR clean
means harvest or clearing; both High means fire; dNDMI High alone means moisture
stress) is currently something the operator applies from memory. The class-area
table gives them the numbers to do it.

---

## Deployment record

### 2026-08-11  First deployment live

The Pages site is live at
<https://seamusrobertmurphy.github.io/disturbance-checker/>. Two setup steps
had never been done and both are now in place: GitHub Pages was enabled on the
repository (source: GitHub Actions), and the `GEE_OAUTH_CLIENT_ID` secret was
added, so the OAuth client ID is compiled into the deployed bundle and the
bare URL works without query parameters.

The client is a Web application client on the team Cloud project
(`924152150069-grabhic21lkllt0q2jc1kaptk4q1dmmo.apps.googleusercontent.com`,
recorded here because it ships in the public bundle anyway). Colleagues still
need a test-user entry and the two IAM roles per
[earth-engine-setup.md](earth-engine-setup.md).

Sign-in from the deployed site was confirmed working by the operator the same
day.

### 2026-08-11  ArcGIS script moved to tile layers

The ArcGIS Pro production script in the training library
(`sop-library/sop-disturbances/Scripts/`) was rewritten to add results as live
Earth Engine tile layers via `getMapId` and `addDataFromPath`, the same
mechanism this tool and the QGIS workflow use, after its `getDownloadURL`
front end failed with an opaque HTTP 400. Its download path remains as a
fallback and now surfaces Earth Engine's real error body. Stale-token 401s
trigger `ee.Authenticate(force=True)` automatically, per SOP section 2.2. The
ArcGIS SOP docx still describes the download-first behaviour; its Steps VII
and X need a matching revision.

---

## Findings from live runs

Add dated entries as runs happen. Suggested shape:

```
### YYYY-MM-DD  <site>, <reporting period>

Setup:      AOI size, windows, cloud ceiling, thresholds
Observed:   what happened, including timings and any error text verbatim
Expected:   what should have happened
Diagnosis:  cause, if known
Action:     new revision item, or a fix applied
```
