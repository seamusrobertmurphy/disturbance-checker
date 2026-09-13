# Methods reference

This reference sets out the processing chain, every constant, and each place
where this build departs from the SOP or from the two production scripts. The
source of record for each constant is [`src/defaults.ts`](../src/defaults.ts),
and the pipeline is [`src/analysis/run.ts`](../src/analysis/run.ts).

## Where the work happens

Everything is computed in the browser tab.

The previous implementation built an Earth Engine expression graph and sent it
to Google, which composited, reduced and rendered tiles on its servers. This one
has no server. It asks a STAC catalogue which scenes exist, reads the pixels it
needs out of cloud-optimised GeoTIFFs with HTTP range requests, and does the
arithmetic in JavaScript.

That design has three consequences that apply throughout the steps below.

**No credentials.** Both the catalogue and the imagery answer anonymous
requests, which is the reason the tool needs no account.

**No sampling.** Earth Engine's reducers worked to a `maxPixels` ceiling and
truncated past it, which the SOP records happening silently at `1e9` on wide
areas. Here every pixel of the working grid is read and counted, so there is no
ceiling and nothing to truncate.

**Memory is bounded by blocks, not by area.** The grid is processed in 512 pixel
blocks, so a 200,000 ha project costs the same per block as a 200 ha one.

## 1. Scene discovery

Scenes are found with a POST to Earth Search, filtered by the AOI bounding box,
the date window and `eo:cloud_cover`, on collection `sentinel-2-l2a`. The
reasons for not using Collection 1 are in [data-access.md](data-access.md).

The scene-level cloud ceiling has a different role here. In the production
scripts `MAX_CLOUD = 10` had no effect on the active path, because Cloud Score+
masked per pixel and no scene filter ran. Here it is live as a **download**
filter, applied before any pixel is fetched, with a default of 30, and masking
is still per pixel. A ceiling of 10 would discard most of a Pacific Northwest
window and thin the median below the point where it is stable.

### Deduplication

Two collapses happen before anything is read, and both affect results.

**Reprocessed products.** Every acquisition from 2018 to 2021 appears twice, once
as ESA originally released it on baseline 00.01 to 03.01 and once as the
Collection 1 reprocessing on baseline 05.00. Keeping both would weight that
observation twice in the median and mix two radiometric calibrations in one
composite, so the higher baseline is kept.

**Tiles of one overpass.** MGRS tiles overlap, and near a UTM zone boundary a
single overpass is published twice, once per zone. `S2B_10UCA_20190802` and
`S2B_9UYR_20190802` are the same two seconds of sensing on two grids, and both
carry datatake `GS2B_20190802T191919_012566`. Scenes are therefore folded into
**observations** keyed by datatake. Where an AOI spans a tile boundary inside
one zone, the tiles of an observation are mosaicked at read time so the overpass
still counts once.

Everything downstream counts observations rather than scenes, which is also why
the panel refers to "overpasses".

## 2. Working grid

Sentinel-2 COGs are written on a UTM grid, so the tool computes on the pixels as
stored. The grid is the UTM zone that reaches the most observations, with the
zone of the AOI centre preferred on a tie, at 20 m, snapped to a whole multiple
of the resolution so reads sample rather than resample.

This avoids a class of error the SOP had to guard against. Earth Engine returned
composites in EPSG:4326, and every area reduction had to be given an explicit
UTM projection to avoid measuring hectares on a degree grid. Here a pixel is
exactly 20 by 20 m and an area is a pixel count times a constant. Reprojection
happens once, at the end, only to draw the result on the map, and no reported
number passes through it.

## 3. Radiometry

Reflectance is DN divided by 10000, after removing the +1000 DN baseline offset
from any scene where the catalogue reports it still present. The flag is read
per scene rather than inferred from the date, and the full reasoning is in
[data-access.md](data-access.md).

## 4. Cloud masking

Two masks are available. The choice is recorded in the run manifest, and it
affects results.

### Scene classification

SCL is the Sen2Cor scene classification shipped in every L2A product, at 20 m.
The classes rejected by default are no-data (0), saturated (1), cast shadow (2),
cloud shadow (3), cloud medium probability (8), cloud high probability (9), thin
cirrus (10) and snow (11). Vegetation (4), not-vegetated (5), water (6) and
unclassified (7) are kept.

Cast shadow and snow are switches, and the manifest records how they were set.
Class 2 covers both cloud shadow the classifier did not assign to class 3 and
ordinary topographic shade. Rejecting it has little cost on flat ground, but in
steep terrain it can remove most north-facing slopes from every scene in a
window, which can cost more than the cloud it avoids.

SCL is a categorical assignment made pixel by pixel. It tends to miss thin cloud
edges and to confuse bright bare ground with cloud.

### Segmentation model

[OmniCloudMask](https://github.com/DPIRD-DMA/OmniCloudMask) version 4 runs in
the browser tab, on WebGPU where the browser has it and on WebAssembly where it
does not. Two U-Nets, over `regnety_004` and `edgenext_small` encoders, take
red, green and B8A and write four classes, clear, thick cloud, thin cloud and
cloud shadow. Their logits are averaged before the class is taken, which is the
published method. The two models disagreed on 7.9 percent of pixels in the
measurement below, so either one alone would give a different mask.

The model decides from shape and texture rather than from per-pixel category,
which lets it separate a cloud's shadow from a hillside in shade. Snow,
saturated and no-data pixels still come from SCL, which is reliable for all
three and for which the model has no class.

The table compares the two masks on one 512 by 512 block at 20 m, cut from a
61.7 percent cloudy overpass of the Blackfeet ROI, scene
`S2B_12UUV_20240827_0_L2A`.

| | Share of block |
|---|---|
| SCL calls cloud or shadow | 64.62 percent |
| The model calls cloud or shadow | 75.26 percent |
| Model says cloud, SCL says clear | 11.39 percent |
| SCL says cloud, model says clear | 0.75 percent |

The disagreement runs mostly one way. What SCL lets through is thin edges and
shadow, and in a pre-post delta both read as canopy loss.

Both models are normalised the way the package normalises, per band and per
patch, by subtracting the mean and dividing by the standard deviation of the
pixels that are not no-data. An additive offset therefore cancels exactly, so
the +1000 DN baseline offset cannot move this mask whether or not it has been
corrected.

Code and weights are MIT. The ONNX files are committed under `vendor/` and are
produced by [`scripts/export-cloud-model.py`](../scripts/export-cloud-model.py),
which rejects any export whose logits differ from the source torch model by more
than 1e-3 or whose classes differ at all.

**What it costs.** The model needs 57 MB of weights and 24 MB of runtime,
fetched once on the first run that selects it and then cached by the browser,
plus inference time. The table gives the time for one 512 by 512 block through
both models, warm, measured in Chrome 151 against the deployed build.

| Provider | Per block, per overpass |
|---|---|
| WebGPU | 0.26 s |
| WebAssembly | 6.3 s |

The provider used is recorded in the run manifest. The size of the gap is why
the session is created asking for WebGPU alone and falls back only afterwards,
rather than passing the runtime a list and relying on it to prefer the faster
one. A list containing both was measured running at WebAssembly speed on a
machine where WebGPU worked when requested on its own.

A project-sized area is a block or two. A rectangle of several thousand square
kilometres is a hundred blocks or more, and at that size the scene
classification is the practical choice on any browser.

## 5. Compositing

Each composite is the per-pixel median over surviving observations.

A best-pixel pick needs a continuous quality score to rank observations on, and
neither mask here produces one, since both write classes. The reduction is
therefore a median, which is the SOP's own documented alternative and what the
production scripts ran before they moved to a best-pixel pick.

Two details matter for the result.

**Validity is decided per observation, not per band.** If each band chose its own
surviving observations, NDVI could be a red median over five looks divided into
a NIR median over four, comparing different days without any sign of it. An
observation counts only where every reflectance band it contributes is present.

**The even case averages the two central values,** matching Earth Engine's median
reducer rather than taking a lower median. On a stack of four that is the
difference between a composite that jumps when one scene is added and one that
does not.

Every composite carries its per-pixel count of surviving observations. The SOP's
floor of four scenes was advisory under Cloud Score+ and is **binding** here, and
the run raises a diagnostic when a window or a meaningful share of pixels falls
below it.

## 6. Indices

The indices follow SOP Step 5 unchanged.

| Index | Bands | Assets |
|---|---|---|
| NDVI | (B8 − B4) / (B8 + B4) | `nir`, `red` |
| NDMI | (B8 − B11) / (B8 + B11) | `nir`, `swir16` |
| NBR | (B8A − B12) / (B8A + B12) | `nir08`, `swir22` |

NBR takes the narrow near-infrared B8A rather than B8, matching both production
scripts. B8A and B12 share a 20 m grid, so the ratio is formed from two bands
sampled the same way.

## 7. Deltas and water

The sign convention follows SOP Step 5 unchanged. dNDVI and dNDMI are pre minus
post, so positive is loss, and dNBR is post minus pre, so positive is burn,
matching MTBS and USFS Region 6.

Water is masked at the delta stage rather than on the composite, as the SOP
does, so the RGB layers keep their water for visual context while no delta is
computed over it. A pixel counted as water in **either** window is masked in
both, because a lake in the pre window and a mudflat in the post window is a
water-level change rather than canopy loss.

The source has changed. Earth Engine used JRC Global Surface Water thresholded
at 50 percent occurrence, a multi-decadal layer with no anonymous COG
equivalent. Water is now SCL class 6, and a pixel counts as water when the
majority of its valid observations called it water. A majority rather than any
single call means one misclassified scene cannot open a hole through the delta,
and a majority rather than all calls means a window where one scene was cloudy
over the lake still masks it.

**The two sources can disagree on seasonal water.** GSW treats a pond that is
wet half the time as water, whereas a window of scenes treats it as water only
if it was wet on those days.

## 8. Classification

Classification follows SOP Step 7, with class 0 undisturbed, 1 Low, 2 Moderate
and 3 High, and thresholds applied in ascending order so the highest match
applies. Class 0 is drawn transparent so the composite underneath shows
through, which lets a verifier see that an absence of colour is an absence of
change rather than an absence of data.

The default breaks come from SOP Step 6.

| Delta | Low | Moderate | High | Source |
|---|---|---|---|---|
| dNDVI | 0.10 | 0.20 | 0.35 | SOP Step 6 |
| dNDMI | 0.15 | 0.30 | 0.45 | SOP Step 6 |
| dNBR | 0.10 | 0.27 | 0.44 | SOP Step 6, MTBS / USFS PNW |

Any change to these is recorded in the manifest with its justification.

## 9. Histogram

The histogram uses 130 fixed bins from −0.5 to 0.8, the SOP's
`fixedHistogram(-0.5, 0.8, 130)`.

Values outside the range are dropped rather than piled into the end bins, which
is what Earth Engine did. The SOP reads the shape of this curve to justify
moving a break, and an overflow spike at the edge could be mistaken for a real
feature of the distribution.

The `maxPixels` ceiling is removed rather than raised, and every pixel is
counted.

## 10. Areas

Each area is a pixel count times 0.04 ha. The grid is metric and every pixel is
the same size, so there is nothing to integrate and nothing to project.

Where the AOI is a loaded boundary rather than a rectangle, the polygon is burnt
onto the grid with an even-odd scanline fill over pixel centres, and the clip is
applied before anything is tallied so the histogram, the class areas and the
observed-pixel count all describe the same polygon. Even-odd filling is used
rather than non-zero winding so that an inholding or an excluded wetland keeps
its hole regardless of the order its rings were digitised in.

## 11. Season at the site

The pre-post delta measures disturbance only when the two composites were
taken at the same point of the seasonal cycle of leaf greenness and sunlight.
The SOP matches calendar dates for this, which assumes the season ran on time
in both years. The season charts under the reporting periods test that
assumption with data.

The data is NASA POWER daily surface climate at the centre of the area of
interest, in six parameters, mean, maximum and minimum air temperature at two
metres, corrected precipitation, all-sky shortwave irradiance at the surface,
and snow depth. The request covers the years the reporting periods touch and
the ten calendar years before the earliest of them, in one call. POWER's grid
is half a degree of latitude by five eighths of a degree of longitude, about
fifty kilometres, so the values describe the district rather than the plot.
Missing days, and the few days POWER runs behind the present, arrive as its
fill value and are treated as absent rather than as zero.

Temperature, sunlight and snow depth are drawn as a centred seven-day mean,
and rain as the total over the previous twenty-eight days, because greenness
follows the water that has arrived recently rather than the rain on the day.
A moving window with fewer than half its days present is left blank so a gap
in the record shows as a gap. Every year is placed on one January to December
axis by month and day, on a leap-year calendar so 1 March always lands on the
same slot, with the reporting-period years in colour over the mean of every
fetched year in grey. The pre and post windows are shaded by their month-day
span, so two windows on matching dates shade one band and mismatched windows
shade two.

For each period the mean temperature, mean sunlight, total rain and count of
snow-covered days inside the pre window and the post window are tabulated with
their difference, and written to the manifest. No threshold is applied to the
difference, because what counts as a large gap depends on the forest, and the
number is provided to be read against the curves and quoted in a finding
rather than to trigger a warning the tool cannot justify.

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
| Indices, signs, breaks | reference | reference | identical |

## Known weaknesses

1. **Neither mask produces a clarity score,** so the reduction is a median
   rather than a best-pixel pick, and the overpass counts are worth reading. On
   the scene classification specifically, thin cloud edges survive masking often
   enough to matter, and the segmentation model addresses that at the cost of a
   download and inference time.
2. **The median needs four clear looks.** Below that the composite can move with
   a single observation. The floor was advisory before and is binding now.
3. **Water is per-scene, not multi-decadal.** Seasonal water is treated
   differently from the Earth Engine build.
4. **An AOI straddling a UTM zone loses the overpasses never tiled into the
   chosen zone.** The run raises a warning, and splitting the area at the zone
   boundary avoids the loss.
5. **No Landsat, so no pre-2015 baseline.** Sentinel-2 starts in 2015 and
   coverage is thinner before 2017.
6. **The display warp is nearest-neighbour.** Areas are measured on the UTM grid
   and are unaffected, but a heavily zoomed screenshot shows resampling.

These are tracked with proposed fixes in [revision-notes.md](revision-notes.md).
