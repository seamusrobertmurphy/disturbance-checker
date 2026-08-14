# Disturbance Check

Sentinel-2 NDVI, NDMI and NBR pre-post delta screening for ACR IFM verification,
as a browser-based [GeoLibre](https://github.com/opengeos/GeoLibre) plugin.

This is the TÜV SÜD SOP *Canopy Disturbance Checks for ACR IFM Verification*
implemented as a panel. It produces the same classified rasters and histograms
as the QGIS and geemap workflow it replaces, with no QGIS install, no Python
environment and no plugin setup.

**It needs no account.** Imagery is read straight from the Copernicus Sentinel-2
L2A archive published as cloud-optimised GeoTIFFs on AWS Open Data, found
through Element 84's public Earth Search catalogue. Both answer anonymous
requests, so there is no sign-in, no Cloud project, no OAuth client, no
test-user list and no billing. Composites, indices, deltas, histograms and
classification are all computed in the browser tab.

Outputs complement, but do not replace, ground plots and developer monitoring
reports.

## Documentation

The [documentation library](docs/README.md) is the same set of guides that ships
inside the app, reachable from the **Disturbance Check** menu in the toolbar and
from the Help footer at the bottom of the tool panel.

Start with [Using the tool](docs/using-the-tool.md) if you are running a check,
[Data and access](docs/data-access.md) if you want to know where the imagery
comes from.

## The panel

Seven sections, in order:

1. **Imagery** — where the data comes from and how cloud is being removed.
2. **Area of interest** — typed bounds, pasted GeoJSON, or an uploaded project
   boundary.
3. **Reporting periods** — pre and post windows, one or many, plus the cloud
   ceiling.
4. **Severity thresholds** — the Low, Moderate and High cut points for each of
   the three differenced indices, editable before the first run.
5. **Site data** — project boundary, streamside management zones, and plot
   points, uploaded as zipped shapefile, GeoJSON or KML.
6. **Results** — overpass counts, histograms with draggable breaks, class areas.
7. **Findings** — the run manifest.

## How it works

The operator sets an area of interest and one or more reporting periods. The
panel then, per period:

1. Asks Earth Search which Sentinel-2 scenes cover the area in each window, and
   folds them into overpasses so a scene published in two UTM zones is not
   counted twice.
2. Reads only the pixels it needs, by HTTP range request, out of the
   cloud-optimised GeoTIFFs, correcting the +1000 DN baseline offset on any
   scene the catalogue reports still carrying it.
3. Masks cloud, shadow and snow on the scene classification layer, then reduces
   each window to a per-pixel median.
4. Derives NDVI, NDMI and NBR, and the three deltas, masking water at the delta
   stage so the RGB layers keep water for context.
5. Accumulates a fixed histogram over every pixel and reads its shape.
6. Classifies each delta into Low, Moderate and High.
7. Counts per-class hectares on the native Sentinel-2 UTM grid, clipped to the
   boundary polygon rather than its bounding box.
8. Paints twelve layers and adds them to GeoLibre, classified rasters on top.
9. Assembles a run manifest recording every parameter, every threshold and every
   diagnostic raised.

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
justification, which is recorded in the run manifest. Ordering is enforced, so
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

## What the panel checks for you

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
written justification, which is recorded in the run manifest.

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
