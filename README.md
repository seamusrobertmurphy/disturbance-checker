# Disturbance Check

Sentinel-2 NDVI, NDMI and NBR pre-post delta screening for ACR IFM verification,
as a browser-based [GeoLibre](https://github.com/opengeos/GeoLibre) plugin.

This is a canopy change detection tool implemented as a panel. It produces
the same classified rasters and histograms as the QGIS and geemap workflow it
replaces, with no QGIS install, no Python environment and no plugin setup.

**It needs no account.** Imagery is read straight from the Copernicus Sentinel-2
L2A archive published as cloud-optimised GeoTIFFs on AWS Open Data, found
through Element 84's public Earth Search catalogue. Both answer anonymous
requests, so there is no sign-in, no Cloud project, no OAuth client, no
test-user list and no billing. Composites, indices, deltas, histograms and
classification are all computed in the browser tab.

Outputs complement, but do not replace, ground plots and developer monitoring
reports.

## Cheat sheet

Condensed from the SOP cheat sheet of 3 September 2026, covering the interactive
tool only. The full sheet is in [`docs/cheat-sheet.pdf`](docs/cheat-sheet.pdf).

**Before you start.** No Python environment, no plugin manager, no elevated
shell, no sign-in, no Cloud project and no billing. Any current browser serves,
including Edge on a managed Windows 11 machine at standard user permissions. A
restricted workstation must be able to reach the application host,
`earth-search.aws.element84.com` and `sentinel-cogs.s3.us-west-2.amazonaws.com`
for the catalogue and the pixels, `services3.arcgis.com` and `apps.fs.usda.gov`
for fire perimeters, the aerial detection survey and the activity record,
`lfps.usgs.gov` and `imagery.geoplatform.gov` for LANDFIRE and LCMS,
`power.larc.nasa.gov` for the climate series, `cwfis.cfs.nrcan.gc.ca` for
Canadian burned area, and `s3-us-west-2.amazonaws.com` with
`services.arcgisonline.com` for the dated imagery archive. No data-handling
exemption is needed, because uploaded site data is parsed in the browser and
never leaves the workstation.

| Section | What you do there |
|---|---|
| **1 Imagery** | Provenance, not a control. Scenes come from Element 84's Earth Search catalogue and are read out of the Sentinel-2 Level-2A cloud-optimised GeoTIFFs on AWS Open Data by range request at 20 m. The +1000 DN offset is removed per scene from the catalogue's `earthsearch:boa_offset_applied` flag rather than inferred from the date, so scenes either side of the January 2022 baseline are comparable. Choose the cloud mask here. |
| **Two cloud masks** | The Sen2Cor scene classification layer ships with every product and supplies snow, saturated and no-data either way, but alone it misses thin cloud edge and labels topographic shade as cast shadow. OmniCloudMask runs in the tab and decides from shape and texture. On a 61 per cent cloudy Blackfeet overpass of 27 August 2024 it called 11.4 per cent of the block cloud or shadow where the scene classification called it clear, against 0.75 per cent the other way. Either mask feeds a per-pixel median. Water is masked at the delta stage, in both windows if it is water in either. |
| **2 Area of interest** | Three routes, in order of reliability. Upload the project boundary under Site data, which sets the extent and draws the outline. Or type bounds in EPSG:4326, or use the current map view; reversed pairs are normalised, so a swapped east and west cannot silently return an empty geometry. Or paste GeoJSON. |
| **Buffer first** | There is no buffer control here, unlike the QGIS and ArcGIS scripts. Roughly 500 m earns its place, because a hard clip at the legal boundary cuts off the far half of a cut block straddling the line. Simplify at 10 m first, buffer on a bevel join, save separately, name it so it cannot be mistaken for the boundary. Every hectare figure is read off the unbuffered boundary: buffering a 4,712 ha parcel by 500 m returned 6,067 ha, an inflation of 29 per cent. Load the unbuffered boundary as an outline so a reader sees which ring a number came from. |
| **3 Reporting periods** | Four dates each, the start and end of the pre window and of the post window. Each window is a range a composite is built from, not one acquisition. Defaults are 1 August to 1 September; July to September is acceptable. Add reporting period chains a further pair, and all periods share one set of breaks, so differences between them are real rather than an artefact of settings. |
| **Confirm the season** | The panel draws daily air temperature, sunlight, rain over the previous four weeks and snow depth at the extent's centre from NASA POWER, each period year as a line over a grey ten-year mean. Three checks. **Same dates:** one shaded band, not two. A March pre window against an October post window differed by 11.5 °C and 270 mm of rain. **Same season:** lines on the mean, since a deciduous canopy at 1 April in a late year runs three weeks behind. **Same ground:** no snow in either window. The grid is about fifty kilometres across, so it is the season of the district. |
| **4 Class breaks** | dNDVI 0.10 / 0.20 / 0.35, dNDMI 0.15 / 0.30 / 0.45, dNBR 0.10 / 0.27 / 0.44, for Low, Moderate and High. Grey undisturbed and masked out, yellow Low to screen, orange Moderate to inspect, red High to draft a finding on. dNDVI and dNDMI come from SOP Step 6, dNBR from MTBS and USFS PNW. Ordering is enforced, and a value moved off its default marks that index adjusted and requires a written justification. Applying a moved break re-runs the whole check, so move all three before applying. |
| **5 Site data** | Project boundary, streamside management zones and plot points, as zipped shapefile, GeoJSON or KML. Never uploaded anywhere. Loading a boundary also sets the extent. Plot points are labelled with their identifier so a screenshot ties to an inventory record; the column is detected automatically, preferring `Plot ID` or `PLOT_NO` over `OBJECTID`, and should be checked. Zip the whole shapefile: without the `.prj` there is nothing to reproject from and a Montana project lands in the Gulf of Guinea. |
| **Run check** | A small extent finishes under a minute; a large one, or several periods, takes longer, because pixels are fetched and the cloud model run in the tab rather than on a server. Success is five layers per period, three classified rasters visible on top and the pre and post true-colour composites hidden beneath, each carrying its period prefix. |
| **6 Results** | Overpass counts per window, three histograms with draggable handles, and class areas in hectares on the project UTM zone at 20 m. Read the overpass counts first, because fewer than four clear looks per window makes the median unstable. Then read the histogram shape before touching a break: a long right tail with no gap is contamination, not disturbance, and a clear gap is where the Low break belongs. Quote the share of the extent as well as the hectares. Resolve every diagnostic before treating anything on screen as real. |
| **Cross-check** | dNDVI and dNDMI are pre minus post, positive meaning loss; dNBR is post minus pre, positive meaning burned. Read all three before drafting. dNDVI High with dNBR clean is harvest, blowdown or clearing, so read the edge geometry. dNDVI High with dNBR High is fire, to be confirmed against the perimeter record. dNDMI High alone is moisture stress, to be corroborated against the aerial detection survey. Right angles and linear edges point to harvest, road or right-of-way; curvilinear or amorphous edges to blowdown, decline or slide. |
| **7 Visual check** | A crossfade between the pre and post true-colour composites over fixed ground, with a blink control. Both are built from the masked observations the analysis used, not a single scene, so a clearing jumps between two dates and noise does not. Beneath it, a search of Esri's dated World Imagery archive for every distinct photograph of the site. Quote the capture date, never the release date: the photograph inside a release was frequently taken a year or more earlier, and citing one for the other is a factual error in a finding. |
| **8 Corroboration** | Never an input. Mapped fire from the interagency perimeter feed, MTBS and the Canadian National Burned Area Composite; the Forest Service aerial detection survey by year, agent, damage type and acreage, which is what lets a dNDMI signal be attributed rather than merely described; the management activity record; LANDFIRE and LCMS as overlays. An empty return is not proof, because the activity record covers National Forest System land only, so on private, state or tribal trust ownership a blank return is an absence of jurisdiction, not of harvest. |

There is no export. Screenshots plus the parameters saved with the project are
the screening deliverable; an archival GeoTIFF means the QGIS or ArcGIS script.

## Documentation

The [documentation library](docs/README.md) is the same set of guides that ships
inside the app, reachable from the **Disturbance Check** menu in the toolbar and
from the Help footer at the bottom of the tool panel.

Start with [Using the tool](docs/using-the-tool.md) if you are running a check,
[Data and access](docs/data-access.md) if you want to know where the imagery
comes from.

## The panel

Eight sections, in order:

1. **Imagery** — where the data comes from and which cloud mask is running.
2. **Area of interest** — typed bounds, pasted GeoJSON, or an uploaded project
   boundary.
3. **Reporting periods** — pre and post windows, one or many, plus the cloud
   ceiling, with the daily climate at the site drawn under them so the windows
   can be placed at matching points of the season.
4. **Severity thresholds** — the Low, Moderate and High cut points for each of
   the three differenced indices, editable before the first run.
5. **Site data** — project boundary, streamside management zones, and plot
   points, uploaded as zipped shapefile, GeoJSON or KML.
6. **Results** — overpass counts, histograms with draggable breaks, class areas.
7. **Visual check** — the run's own before-and-after true colour on the 20 m
   working grid, optionally sharpened to 2.5 m, beside Esri's dated
   high-resolution archive.
8. **Corroboration** — the same ground as four independent records: mapped
   fire, LCMS change, LANDFIRE disturbance agent, and the FACTS management
   record.

## How it works

The operator sets an area of interest and one or more reporting periods. The
panel then, per period:

1. Asks Earth Search which Sentinel-2 scenes cover the area in each window, and
   folds them into overpasses so a scene published in two UTM zones is not
   counted twice.
2. Reads only the pixels it needs, by HTTP range request, out of the
   cloud-optimised GeoTIFFs, correcting the +1000 DN baseline offset on any
   scene the catalogue reports still carrying it.
3. Masks cloud, shadow and snow, then reduces each window to a per-pixel
   median. The mask is the scene classification layer by default, or
   OmniCloudMask, a 57 MB model run in the tab, when a run asks for it.
4. Derives NDVI, NDMI and NBR, and the three deltas, masking water at the delta
   stage so the RGB layers keep water for context.
5. Accumulates a fixed histogram over every pixel and reads its shape.
6. Classifies each delta into Low, Moderate and High.
7. Counts per-class hectares on the native Sentinel-2 UTM grid, clipped to the
   boundary polygon rather than its bounding box.
8. Paints five layers per period, the pre and post true-colour composites and
   the three classified rasters, and adds them to GeoLibre with the classified
   rasters on top.

Nothing about the analysis is hidden in the tool. Every constant traces to a
section of the SOP in [`src/defaults.ts`](src/defaults.ts).

## Severity classes

Each differenced index is cut into four classes: undisturbed, Low, Moderate and
High. Undisturbed pixels are masked server-side, so the classified rasters
arrive with transparency already in them and only disturbed cells are drawn over
the site.

The thresholds ship as the SOP Step 6 defaults and are editable in the opening
panel, before the first run, so a colleague can set them for their own site
without waiting for a result. After a run they can also be dragged directly on
each histogram, against the distribution they are cutting. Either way, a value
moved off its default marks that index as adjusted and requires a written
justification, which is saved with the project. Ordering is enforced, so
Low can never cross Moderate.

## Site data

Project boundary, streamside management zones and plot points load from a zipped
shapefile, a GeoJSON file, or a KML. Files are parsed in the browser and are
never uploaded anywhere.

Plot points are labelled on the map with their identifier, so a screenshot of a
disturbance polygon can be tied to a plot without a separate legend. The
identifier column is detected automatically, preferring plot-specific names like
`Plot ID` or `PLOT_NO` over generic ones like `OBJECTID`, and the detected field
is always shown and always overridable. Loading a project boundary also sets it
as the area of interest, rather than making the operator supply the same extent
twice.

## Seeing the ground

Sentinel-2 at 10 metres tells you an index changed. It cannot tell you what
changed, because a road, a landing, a cutblock edge and a blowdown patch are all
the same handful of pixels. Section 7 answers that question two ways on one
screen.

The tool's own before-and-after true colour is built from the same masked
observations the indices were built from, on the 20 metre working grid, so it
shows the composite that actually produced the number. Either view can be
sharpened to 2.5 metres by SEN2SRLite, a 236 kB model run in the tab on WebGPU
where the browser offers it and WebAssembly where it does not. Sharpening is a
separate pass over the archive and never feeds the analysis; hectare counts keep
reading the 20 metre grid, so an invented pixel can change what a verifier sees
but not what the tool certifies.

Beside it sits Esri's World Imagery Wayback, the dated archive of that basemap,
frequently sub-metre and served anonymously. It replaces the Google Earth
historical timeline the SOP leans on, and it needs no account.

## Corroboration

Section 8 puts the same ground against four records built by other people from
other data, none of which is ever an input to the calculation.

Mapped fire comes from three registries with different jobs: MTBS, which assesses
severity from imagery a year or more after the event; the interagency perimeter
feed, which is same-season and covers the years MTBS has not reached; and the
Canadian National Burned Area Composite, which runs from 1972 and carries
projects north of the border. LCMS, the Forest Service Landscape Change
Monitoring System, classifies change annually across the conterminous United
States from the full Landsat and Sentinel-2 record by a method unlike this
tool's. LANDFIRE names the cause where LCMS only names the change, with Fire,
Clearcut, Harvest, Thinning, Mastication, Insects, Disease and Weather as
distinct classes. FACTS is different in kind from the other three, because it is
not a measurement of the canopy but the record of what was done, entered by the
people who did it, with a date and an acreage.

Agreement between an unrelated method and a threshold this tool set is worth
more than either alone. Disagreement is the finding.

## What it checks

The SOP's hard-won lessons are encoded as diagnostics rather than left to
memory:

- **Dormant-season windows.** A window outside July to September raises a
  warning, because senescence drives SWIR1 reflectance up before leaf-fall and
  produces a uniform false moisture-stress signal in dNDMI.
- **Mismatched pre and post windows.** Phenology drift between periods is the
  most common source of fake inter-period change.
- **Histogram shape.** A unimodal distribution with a long right tail and no gap
  is flagged as composite contamination, not disturbance. A bimodal
  distribution with a clear gap suggests where the Low break belongs.
- **Thin composites.** Fewer than four scenes per window is flagged, because the
  median normaliser is unstable below that.
- **Reversed coordinates.** Bounds are normalised, so a swapped east and west
  cannot silently produce an empty geometry.

Moving a class break off its default marks the delta as adjusted and requires a
written justification, which is saved with the project.

## Nothing expires

Earlier versions served map tiles against an access token that lapsed after an
hour, and the layers went with it. The layers are now images the tab painted, so
they last as long as the tab does.

Only parameters are saved into a project, never results, which means a saved
project is a description of a check rather than a snapshot of one. Re-running it
costs seconds and needs no credentials.

## Deployment

The published site is a GeoLibre web build with this plugin baked in, served
from GitHub Pages at
<https://seamusrobertmurphy.github.io/disturbance-checker/>. GeoLibre is not
vendored here; the deploy workflow checks it out at a pinned tag, drops in the
built plugin, builds, and publishes.

No secrets are required. Set Pages to build from GitHub Actions and push; see
[`docs/first-run.md`](docs/first-run.md).

Bump `GEOLIBRE_REF` in [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
to move to a newer GeoLibre.

## Development

```bash
npm install
npm run build     # typecheck, then bundle to dist/
npm test          # load the bundle and assert the plugin contract and SOP defaults
npm run package   # produce the drop-in layout under build/
```

To try it against a local GeoLibre checkout, run `npm run package`, then copy
`build/tuvsud-disturbance-check/` into
`apps/geolibre-desktop/public/plugins/` and restart the GeoLibre dev server.
Discovery happens at build and dev-server start, so a restart is required after
adding or updating the folder.

The plugin is one self-contained ES module because GeoLibre's external-plugin
loader executes the entry through a blob import and does not resolve relative
imports inside the bundle. Its three runtime dependencies are `geotiff` for
reading cloud-optimised GeoTIFFs, `proj4` for the UTM transforms and `shpjs`
for boundary imports, all MIT.

## Licence

MIT. See [LICENSE](LICENSE).
