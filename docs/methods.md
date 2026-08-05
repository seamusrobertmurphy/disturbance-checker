# Methods reference

The full processing chain, written for someone who needs to defend it, modify
it, or reproduce it outside this tool. It documents what the code does, why each
choice was made, and where this implementation diverges from the SOP PDF and
from the production QGIS and ArcGIS scripts.

Companion source files: [`src/defaults.ts`](../src/defaults.ts) for every
constant, [`src/ee/analysis.ts`](../src/ee/analysis.ts) for the Earth Engine
graph, [`src/diagnostics.ts`](../src/diagnostics.ts) for the histogram rules.

## 1. Where computation happens

Nothing is computed in the browser. The Earth Engine client assembles a JSON
description of a computation and holds it; work happens only when something
forces evaluation. There are exactly two such moments:

- `evaluate()` sends the graph and returns a value. Scene counts, histograms and
  class areas arrive this way.
- `getMap()` sends the graph and asks Google to serve it as tiles, returning an
  XYZ URL template.

That template is the handoff point. From there it is an ordinary raster layer
and the host map neither knows nor cares that it came from a satellite pipeline.

## 2. Collection and radiometry

```
COPERNICUS/S2_SR_HARMONIZED
```

HARMONIZED is mandatory, not a preference. Plain `S2_SR` carries a +1000 DN
offset on scenes processed after the January 2022 baseline change. Mixing
pre- and post-2022 scenes without harmonisation propagates a false dNDVI signal
of roughly 0.04 across the whole project area, which is a third of the way to
the Low threshold before anything real has happened.

Surface reflectance is scaled by dividing by 10000, applied after compositing so
the quality band used for mosaicking is not rescaled with it.

## 3. Cloud removal

Two methods are implemented. They are different reductions, not variants of one,
and they will not produce identical output.

### Cloud Score+ (default, matches production)

```js
const linked = s2.linkCollection(csPlus, ["cs"]);
const masked = linked.map(img => img.updateMask(img.select("cs").gte(0.40)));
const composite = masked.qualityMosaic("cs").divide(10000).clip(roi);
```

`GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED` supplies a per-pixel `cs` quality
score. `linkCollection` joins it onto matching Sentinel-2 scenes by time, so
each pixel carries its own clarity value rather than inheriting a scene-level
verdict.

Two consequences follow, and both matter:

**No scene-level cloud filter is needed.** Masking is per pixel, so a scene that
is 80% cloudy still contributes its clear 20%. This is why the production
scripts define `MAX_CLOUD` but never apply it on the active path. Discarding
whole scenes would throw away good pixels for no benefit.

**`qualityMosaic` is not an average.** For every pixel it selects the single
observation with the highest `cs` value in the window. The output is a mosaic of
best-available observations, not a central tendency. This means:

- There is no median normaliser, so the "median is unstable below about four
  scenes" concern from the SOP does not apply in the same way. One clear
  observation is enough for a valid pixel.
- Adjacent pixels may come from different dates. Within a two-month
  growing-season window that is usually immaterial, but it is a real seam risk
  if the window spans a phenological transition.
- Residual haze that Cloud Score+ scores above the threshold passes through
  unaveraged, where a median would have suppressed it.

`CLEAR_THRESHOLD` defaults to 0.40. Raising it to 0.50 or 0.65 is stricter and
keeps fewer pixels, at the cost of more gaps.

### QA60 with median (legacy)

```js
const masked = s2
  .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", maxCloud))
  .map(maskQA60);
const composite = masked.median().divide(10000).clip(roi);
```

Masks bits 10 (opaque cloud) and 11 (cirrus) of the QA60 band, discards scenes
above the cloud ceiling, then takes a per-pixel median.

This is what the SOP PDF documents and what the scripts used before the switch.
It is retained selectable so a result produced under the old method can be
reproduced exactly. Its weaknesses are the reason for the switch: QA60 is coarse,
it does not flag cloud shadow at all, and the median needs a healthy sample per
pixel or it produces patchwork artefacts.

**Neither method masks cloud shadow explicitly.** Cloud Score+ scores shadow
poorly and so removes much of it incidentally; QA60 does not address it. Shadow
depresses near-infrared and inflates dNDVI in exactly the way real canopy loss
does. This is a known limitation of both, not an implementation gap.

## 4. Spectral indices

All three are normalised differences, so all are bounded to [-1, 1] and are
insensitive to multiplicative illumination differences.

| Index | Formula | Bands | Resolution | Measures |
|---|---|---|---|---|
| NDVI | (B8 − B4) / (B8 + B4) | NIR, Red | 10 m | Vegetation vigour |
| NDMI | (B8 − B11) / (B8 + B11) | NIR, SWIR1 | 10 m, 20 m | Canopy water content |
| NBR | (B8A − B12) / (B8A + B12) | narrow NIR, SWIR2 | 20 m | Char and ash |

NBR deliberately uses B8A rather than B8. The narrow near-infrared band is
spectrally closer to SWIR2's acquisition geometry, which is the MTBS convention
and keeps values comparable with published burn-severity products.

NDMI mixes a 10 m and a 20 m band; Earth Engine resamples on demand. Reductions
are run at 20 m partly for this reason, so the analysis grid matches the coarsest
input rather than implying precision the SWIR bands do not have.

## 5. Water masking

```js
const water = ee.Image("JRC/GSW1_4/GlobalSurfaceWater")
  .select("occurrence").lt(50).unmask(1);
```

Applied **at the delta stage, not to the composite**. Water produces large
spurious spectral change unrelated to forest condition, so it is excluded from
the deltas, but the RGB composites keep water so the operator retains visual
context for orientation.

`unmask(1)` is essential. The Global Surface Water layer has no data outside its
footprint, which includes high latitudes and small islands. Without `unmask(1)`
every pixel outside that footprint becomes masked in every delta, and the tool
silently returns nothing over exactly the terrain most likely to be under
verification.

## 6. Differencing and sign convention

| Delta | Direction | Positive means |
|---|---|---|
| dNDVI | pre − post | Canopy loss |
| dNDMI | pre − post | Moisture loss or stress |
| dNBR | post − pre | Burned |

dNBR is inverted relative to the other two. This is not an inconsistency: it is
the MTBS and USFS convention, and preserving it keeps the thresholds comparable
with published burn-severity literature. All three are arranged so that positive
means the change of interest, which is what makes a single set of class-break
semantics work across all three.

## 7. Histogram

```js
delta.reduceRegion({
  reducer: ee.Reducer.fixedHistogram(-0.5, 0.8, 130),
  geometry: roi, scale: 20, maxPixels: 1e10,
});
```

130 bins across [-0.5, 0.8] gives a bin width of exactly 0.01, so bin edges fall
on the class breaks rather than straddling them.

`maxPixels` is raised from the scripts' `1e9` to `1e10`. At `1e9` a wide area
silently returns a truncated histogram rather than raising, which produces a
distribution that looks plausible and is wrong. The trade is that a very large
area may now hit the user memory limit and fail loudly instead.

### Reading the distribution

The shape is the evidence for or against the thresholds. Three cases,
implemented in `analyseHistogram`:

**Unimodal at zero, narrow tail.** Noise and phenology only. Defaults hold.

**Bimodal with a gap.** A separated population above the noise bulk. This is the
signature of real disturbance. The Low break belongs inside the gap, not on the
default. The tool locates the gap as a run of at least three consecutive bins
below 0.5% of peak count, with meaningful mass beyond, and marks the midpoint.

**Unimodal with a long right tail, no gap.** The composites are not comparable.
Causes are cloud shadow, seasonal mismatch, or bidirectional reflectance
effects. The tool flags this when more than 15% of valid pixels sit above the
Low break, or more than 2% above the High break.

That last case is the failure mode that produced a real finding: a first pass
flagged 38% of a project area as moisture-stressed, with a diffuse pattern
unrelated to stand age, aspect or known beetle pressure. Both composites had
been drawn from October to December windows, where senescence raises SWIR
reflectance before leaf-fall. Re-running with growing-season windows collapsed
the flagged area to 4%, co-located with reported beetle survey polygons. Raising
the thresholds until the map looked reasonable would have hidden the cause and
produced a defensible-looking but wrong number.

## 8. Classification

Four classes per delta: 0 undisturbed, 1 Low, 2 Moderate, 3 High, emitted as
Int16.

| Delta | Low | Moderate | High | Source |
|---|---|---|---|---|
| dNDVI | 0.10 | 0.20 | 0.35 | SOP Step 6 |
| dNDMI | 0.15 | 0.30 | 0.45 | SOP Step 6 |
| dNBR | 0.10 | 0.27 | 0.44 | MTBS / USFS PNW |

Class 0 is masked with `updateMask(class.gt(0))` before the tiles are requested,
so transparency is produced server-side. Nothing in the browser is compositing
or blending; the tiles arrive with alpha already in them.

Thresholds are editable before a run and draggable on the histogram after one.
Ordering is enforced so Low can never cross Moderate. Any value moved off its
default marks that index as adjusted and requires a written justification, which
is recorded in the run manifest.

## 9. Areas

```js
ee.Image.pixelArea().divide(10000).addBands(classified).reduceRegion({
  reducer: ee.Reducer.sum().group({ groupField: 1, groupName: "class" }),
  geometry: roi, scale: 20, crs: utmCrs, maxPixels: 1e10,
});
```

Composites are returned in EPSG:4326. Anything area-based must be computed on a
metric grid or it is biased, increasingly so with latitude. The UTM zone is
derived from the area centroid and passed as the reduction's output projection.

The grouped reducer assumes band 0 is area and band 1 is class, which holds
because `pixelArea()` is the base image and the classification is added after.

**Known discrepancy.** Areas are reduced at 20 m while the scripts export
GeoTIFFs at 10 m. On fragmented disturbance with a lot of edge, the coarser grid
under-counts. Treat the share-of-area percentage as the more robust figure for a
finding, and expect hectare totals to differ modestly from one measured off a
10 m export.

## 10. Parameter reference

| Constant | Value | Applies to |
|---|---|---|
| `S2_COLLECTION` | `COPERNICUS/S2_SR_HARMONIZED` | Both methods |
| `S2_SCALE_DIVISOR` | 10000 | Both |
| `CLOUD_SCORE_PLUS_COLLECTION` | `GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED` | Cloud Score+ |
| `CLOUD_SCORE_BAND` | `cs` | Cloud Score+ |
| `DEFAULT_CLEAR_THRESHOLD` | 0.40 | Cloud Score+ |
| `DEFAULT_MAX_CLOUD` | 10 | QA60 only |
| `QA60_CLOUD_BIT` / `QA60_CIRRUS_BIT` | 10 / 11 | QA60 only |
| Default window | 08-01 to 09-01 | Both |
| `GSW_OCCURRENCE_THRESHOLD` | 50 | Both |
| Histogram | `fixedHistogram(-0.5, 0.8, 130)` at scale 20 | Both |
| `HISTOGRAM_MAX_PIXELS` | 1e10 | Both |
| `AREA_SCALE` | 20 | Both |

## 11. Divergence from the SOP and the scripts

Three documents describe this analysis and they do not agree. Where they differ,
this tool follows the scripts, because the scripts are what actually runs.

| Item | SOP PDF | Production scripts | This tool |
|---|---|---|---|
| Cloud removal | QA60 bitmask | Cloud Score+, `cs` ≥ 0.40 | Cloud Score+, QA60 selectable |
| Compositing | Median | `qualityMosaic("cs")` | Follows the method chosen |
| Scene cloud filter | ≤ 30 | Defined as 10, unused on active path | QA60 path only |
| Window | July to September | August to September | August to September |
| Histogram `maxPixels` | 1e9 | 1e9 | 1e10 |
| Class breaks | As tabulated above | Identical | Identical, editable |
| Export | Step 9, 10 m to Drive | Present, `EXPORT = False` | Not implemented |

The QGIS and ArcGIS scripts agree with each other on method. They differ only in
default dates: the QGIS script composites August to September, the ArcGIS one
November to November, which is a dormant-season window and would trigger this
tool's seasonal warning.

## 12. Known limitations

1. **No cloud-shadow mask.** Neither method addresses shadow explicitly.
2. **Area scale mismatch.** 20 m reduction against 10 m export.
3. **`qualityMosaic` seams.** Adjacent pixels may come from different dates.
4. **Thresholds re-run everything.** Only classification depends on them, but
   changing one currently rebuilds composites and histograms too.
5. **No reprojection of uploaded vectors.** Shapefiles are assumed to be WGS84;
   the `.prj` is not read.
6. **Session expiry is inferred.** The one-hour token lifetime is assumed rather
   than observed, because the client does not expose the real expiry.

These are tracked with proposed fixes in [revision-notes.md](revision-notes.md).
