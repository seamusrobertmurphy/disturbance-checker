# Methods reference

The processing chain, every constant, and every place this build departs from
the SOP or from the two production scripts. Source of record for each constant
is [`src/defaults.ts`](../src/defaults.ts); the pipeline is
[`src/analysis/run.ts`](../src/analysis/run.ts).

## Where the work happens

Everything is computed in the browser tab.

The previous implementation built an Earth Engine expression graph and sent it
to Google, which composited, reduced and rendered tiles on its servers. This one
has no server. It asks a STAC catalogue which scenes exist, reads the pixels it
needs out of cloud-optimised GeoTIFFs with HTTP range requests, and does the
arithmetic in JavaScript.

Three consequences run through everything below.

**No credentials.** Both the catalogue and the imagery answer anonymous
requests, which is the reason the tool needs no account.

**No sampling.** Earth Engine's reducers worked to a `maxPixels` ceiling and
truncated past it, which the SOP records happening silently at `1e9` on wide
areas. Here every pixel of the working grid is read and counted, so there is no
ceiling and nothing to truncate.

**Memory is bounded by blocks, not by area.** The grid is processed in 512 pixel
blocks, so a 200,000 ha project costs the same per block as a 200 ha one.

## 1. Scene discovery

A POST to Earth Search filtered by the AOI bounding box, the date window and
`eo:cloud_cover`. Collection `sentinel-2-l2a`; the reasons for not using
Collection 1 are in [data-access.md](data-access.md).

The scene-level cloud ceiling has changed meaning. In the production scripts
`MAX_CLOUD = 10` was dead on the active path, because Cloud Score+ masked per
pixel and no scene filter ever ran. Here it is live but it is a **download**
filter, applied before any pixel is fetched, and the default is 30. Masking is
still per pixel. A ceiling of 10 would discard most of a Pacific Northwest
window and thin the median past the point where it is stable.

### Deduplication

Two collapses happen before anything is read, and both change results.

**Reprocessed products.** Every acquisition from 2018 to 2021 appears twice: as
ESA originally released it, on baseline 00.01 to 03.01, and as the Collection 1
reprocessing on baseline 05.00. Keeping both would weight that observation twice
in the median and mix two radiometric calibrations in one composite. The higher
baseline wins.

**Tiles of one overpass.** MGRS tiles overlap, and near a UTM zone boundary a
single overpass is published twice, once per zone. `S2B_10UCA_20190802` and
`S2B_9UYR_20190802` are the same two seconds of sensing on two grids, and both
carry datatake `GS2B_20190802T191919_012566`. Scenes are therefore folded into
**observations** keyed by datatake. Where an AOI spans a tile boundary inside
one zone, the tiles of an observation are mosaicked at read time so the overpass
still counts once.

Everything downstream counts observations, not scenes. The panel says
"overpasses" for the same reason.

## 2. Working grid

Sentinel-2 COGs are written on a UTM grid, so the tool computes on the pixels as
stored. The grid is the UTM zone that reaches the most observations, with the
zone of the AOI centre preferred on a tie, at 20 m, snapped to a whole multiple
of the resolution so reads sample rather than resample.

This removes a whole class of error the SOP had to guard against. Earth Engine
returned composites in EPSG:4326 and every area reduction had to be passed an
explicit UTM projection or it would measure hectares on a degree grid. Here a
pixel is exactly 20 by 20 m and an area is a pixel count times a constant.
Reprojection happens once, at the end, only to draw the result on the map.
Numbers never travel through it.

## 3. Radiometry

DN divided by 10000, after removing the +1000 DN baseline offset from any scene
where the catalogue reports it still present. The flag is read per scene rather
than inferred from the date. Full reasoning in
[data-access.md](data-access.md).

## 4. Cloud masking

Two masks. The choice is recorded in the run manifest, and it changes results.

### Scene classification

SCL, the Sen2Cor scene classification shipped in every L2A product, at 20 m.
Rejected by default: no-data (0), saturated (1), cast shadow (2), cloud shadow
(3), cloud medium probability (8), cloud high probability (9), thin cirrus (10)
and snow (11). Vegetation (4), not-vegetated (5), water (6) and unclassified (7)
survive.

Cast shadow and snow are switches, and the manifest records how they were set.
Class 2 covers both cloud shadow the classifier declined to call class 3 and
ordinary topographic shade. Rejecting it is free on flat ground; in steep
terrain it can remove most north-facing slopes from every scene in a window,
which costs more than the cloud it avoids.

SCL is a categorical guess made pixel by pixel. It misses thin cloud edges and
confuses bright bare ground with cloud.

### Segmentation model

[OmniCloudMask](https://github.com/DPIRD-DMA/OmniCloudMask) version 4, run in
the browser tab on WebGPU where the browser has it and on WebAssembly where it
does not. Two U-Nets, over `regnety_004` and `edgenext_small` encoders, take
red, green and B8A and write four classes: clear, thick cloud, thin cloud and
cloud shadow. Their logits are averaged before the class is taken, which is the
published method; the two models disagreed on 7.9 percent of pixels in the
measurement below, so one alone is a different mask.

It decides from shape and texture rather than from per-pixel category, which is
how a person tells a cloud from a bright field, and how it separates a cloud's
shadow from a hillside in shade. Snow, saturated and no-data pixels still come
from SCL, which is authoritative about all three and for which the model has no
class.

Measured against SCL on one 512 by 512 block at 20 m, cut from a 61.7 percent
cloudy overpass of the Blackfeet ROI, scene `S2B_12UUV_20240827_0_L2A`:

| | Share of block |
|---|---|
| SCL calls cloud or shadow | 64.62 percent |
| The model calls cloud or shadow | 75.26 percent |
| Model says cloud, SCL says clear | 11.39 percent |
| SCL says cloud, model says clear | 0.75 percent |

The asymmetry is the finding. What SCL lets through is thin edges and shadow,
and in a pre-post delta both read as canopy loss.

Both models are normalised the way the package normalises: per band and per
patch, subtract the mean and divide by the standard deviation of the pixels that
are not no-data. An additive offset therefore cancels exactly, so the +1000 DN
baseline offset cannot move this mask whether or not it has been corrected.

Code and weights are MIT. The ONNX files are committed under `vendor/` and are
produced by [`scripts/export-cloud-model.py`](../scripts/export-cloud-model.py),
which refuses to keep an export whose logits differ from the torch model it came
from by more than 1e-3 or whose classes differ at all.

**What it costs.** 57 MB of weights and 24 MB of runtime, fetched once on the
first run that selects it and then cached by the browser, plus inference. On one
512 by 512 block through both models, warm, measured in Chrome 151 against the
deployed build:

| Provider | Per block, per overpass |
|---|---|
| WebGPU | 0.26 s |
| WebAssembly | 6.3 s |

Which one you get is recorded in the run manifest. The gap is why the session is
created asking for WebGPU alone and only then falling back, rather than handing
the runtime a list and trusting it to prefer the fast one: a list containing
both was measured running at WebAssembly speed on a machine where WebGPU worked
when asked for by itself.

A project-sized area is a block or two. A rectangle of several thousand square
kilometres is a hundred and more, and there the scene classification is the
practical choice whatever the browser.

## 5. Compositing

Per-pixel median over surviving observations.

A best-pixel pick needs a continuous quality score to rank observations on.
Neither mask here produces one: both write classes. So the reduction is a
median, which is the SOP's own documented alternative and what the production
scripts ran before they moved to a best-pixel pick.

Two details are load-bearing.

**Validity is decided per observation, not per band.** If each band chose its own
surviving observations, NDVI could be a red median over five looks divided into
a NIR median over four, silently comparing different days. An observation counts
only where every reflectance band it contributes is present.

**The even case averages the two central values,** matching Earth Engine's median
reducer rather than taking a lower median. On a stack of four that is the
difference between a composite that jumps when one scene is added and one that
does not.

Every composite carries its per-pixel count of surviving observations. The SOP's
floor of four scenes was advisory under Cloud Score+ and is **binding** here; the
run raises a diagnostic when a window or a meaningful share of pixels falls
below it.

## 6. Indices

SOP Step 5, unchanged:

| Index | Bands | Assets |
|---|---|---|
| NDVI | (B8 − B4) / (B8 + B4) | `nir`, `red` |
| NDMI | (B8 − B11) / (B8 + B11) | `nir`, `swir16` |
| NBR | (B8A − B12) / (B8A + B12) | `nir08`, `swir22` |

NBR takes the narrow near-infrared B8A rather than B8, matching both production
scripts. B8A and B12 share a 20 m grid, so the ratio is formed from two bands
sampled the same way.

## 7. Deltas and water

SOP Step 5 sign convention, unchanged. dNDVI and dNDMI are pre minus post, so
positive is loss. dNBR is post minus pre, so positive is burn, matching MTBS and
USFS Region 6.

Water is masked at the delta stage rather than on the composite, exactly as the
SOP does, so the RGB layers keep their water for visual context while no delta
is computed over it. A pixel counted as water in **either** window is masked in
both: a lake in the pre window and a mudflat in the post window is a water-level
change, not canopy loss.

The source has changed. Earth Engine used JRC Global Surface Water thresholded
at 50 percent occurrence, a multi-decadal layer with no anonymous COG
equivalent. Water is now SCL class 6, and a pixel counts as water when the
majority of its valid observations called it water. Majority rather than any, so
one misclassified scene cannot punch a hole through the delta; majority rather
than all, so a window where one scene was cloudy over the lake still masks it.

**The two disagree on seasonal water.** GSW calls a pond that is wet half the
time water. A window of scenes calls it water only if it was wet on those days.

## 8. Classification

SOP Step 7. Class 0 undisturbed, 1 Low, 2 Moderate, 3 High, thresholds applied
in ascending order with the highest match winning. Class 0 is drawn transparent
so the composite underneath shows through, which is what lets a verifier see
that an absence of colour is an absence of change rather than an absence of
data.

Default breaks, SOP Step 6:

| Delta | Low | Moderate | High | Source |
|---|---|---|---|---|
| dNDVI | 0.10 | 0.20 | 0.35 | SOP Step 6 |
| dNDMI | 0.15 | 0.30 | 0.45 | SOP Step 6 |
| dNBR | 0.10 | 0.27 | 0.44 | SOP Step 6, MTBS / USFS PNW |

Any deviation is recorded in the manifest with its justification.

## 9. Histogram

130 fixed bins from −0.5 to 0.8, the SOP's `fixedHistogram(-0.5, 0.8, 130)`.

Values outside the range are dropped rather than piled into the end bins, which
is what Earth Engine did. The SOP reads the shape of this curve to justify
moving a break, so a spike at the edge that was really an overflow would be
actively misleading.

The `maxPixels` ceiling is gone rather than raised. Every pixel is counted.

## 10. Areas

A pixel count times 0.04 ha. The grid is metric and every pixel is the same
size, so there is nothing to integrate and nothing to project.

Where the AOI is a loaded boundary rather than a rectangle, the polygon is burnt
onto the grid with an even-odd scanline fill over pixel centres, and the clip is
applied before anything is tallied so the histogram, the class areas and the
observed-pixel count all describe the same polygon. Even-odd rather than
non-zero winding, so an inholding or an excluded wetland leaves its hole empty
regardless of the order its rings were digitised in.

## Constants

| Constant | Value | Where |
|---|---|---|
| `S2_STAC_COLLECTION` | `sentinel-2-l2a` | Scene discovery |
| `S2_SCALE_DIVISOR` | 10000 | Radiometry |
| `BOA_OFFSET_DN` | 1000 | Radiometry |
| `DEFAULT_MAX_CLOUD` | 30 | Download filter |
| `ANALYSIS_SCALE` | 20 | Working grid |
| `BLOCK_SIZE` | 512 | Memory bound |
| `MIN_STABLE_SCENE_COUNT` | 4 | Stability floor |
| `HISTOGRAM_MIN` / `MAX` / `STEPS` | −0.5 / 0.8 / 130 | Histogram |
| `DEFAULT_WINDOW_START_MONTH_DAY` | `08-01` | Periods |
| `DEFAULT_WINDOW_END_MONTH_DAY` | `09-01` | Periods |

## Divergence

| Step | SOP PDF | Production scripts | This build |
|---|---|---|---|
| Platform | Earth Engine | Earth Engine | Browser, STAC and COGs |
| Credentials | Google account | Google account | None |
| Collection | `S2_SR_HARMONIZED` | `S2_SR_HARMONIZED` | `sentinel-2-l2a` on AWS |
| Landsat | not used | not used | not reachable anonymously |
| Cloud removal | QA60 bitmask | Cloud Score+, `cs` ≥ 0.40 | SCL classes, or OmniCloudMask |
| Compositing | Median | `qualityMosaic("cs")` | Median |
| Scene cloud filter | ≤ 30 | defined as 10, unused | 30, as a download filter |
| Water mask | JRC GSW ≥ 50 | JRC GSW ≥ 50 | SCL class 6, majority |
| Area projection | explicit UTM | explicit UTM | native UTM, no reprojection |
| Histogram ceiling | `1e9` | `1e9` | none, every pixel counted |
| AOI clip | ROI geometry | ROI geometry | rasterised polygon |
| Indices, signs, breaks | — | — | identical |

## Known weaknesses

1. **Neither mask produces a clarity score,** so the reduction is a median
   rather than a best-pixel pick, and the overpass counts are worth reading. On
   the scene classification specifically, thin cloud edges survive masking often
   enough to matter; the segmentation model is the answer to that, at the cost
   of a download and inference time.
2. **The median needs four clear looks.** Below that the composite can move with
   a single observation. Advisory before, binding now.
3. **Water is per-scene, not multi-decadal.** Seasonal water is treated
   differently from the Earth Engine build.
4. **An AOI straddling a UTM zone loses the overpasses never tiled into the
   chosen zone.** The run warns; splitting the area at the boundary is the
   honest fix.
5. **No Landsat, so no pre-2015 baseline.** Sentinel-2 starts in 2015 and
   coverage is thinner before 2017.
6. **The display warp is nearest-neighbour.** Areas are measured on the UTM grid
   and are unaffected, but a heavily zoomed screenshot shows resampling.

These are tracked with proposed fixes in [revision-notes.md](revision-notes.md).
