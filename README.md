# Disturbance Check

Sentinel-2 NDVI, NDMI and NBR pre-post delta screening for ACR IFM verification,
as a browser-based [GeoLibre](https://github.com/opengeos/GeoLibre) plugin.

This is the TÜV SÜD SOP *Canopy Disturbance Checks for ACR IFM Verification*
implemented as a panel. It produces the same classified rasters and histograms
as the QGIS and geemap workflow it replaces, with no QGIS install, no Python
environment, and no plugin setup. Composites, indices, deltas, histograms and
classification all run on Google's servers; the browser assembles the
computation and displays the result.

Outputs complement, but do not replace, ground plots and developer monitoring
reports.

## The panel

Seven sections, in order:

1. **Earth Engine** — the Cloud project compute bills to.
2. **Area of interest** — typed bounds, an Earth Engine asset, pasted GeoJSON,
   or an uploaded project boundary.
3. **Reporting periods** — pre and post windows, one or many, plus the cloud
   ceiling.
4. **Severity thresholds** — the Low, Moderate and High cut points for each of
   the three differenced indices, editable before the first run.
5. **Site data** — project boundary, streamside management zones, and plot
   points, uploaded as zipped shapefile, GeoJSON or KML.
6. **Results** — scene counts, histograms with draggable breaks, class areas.
7. **Findings** — the run manifest.

## How it works

The operator sets an area of interest and one or more reporting periods. The
panel then, per period:

1. Builds cloud-filtered median composites from `COPERNICUS/S2_SR_HARMONIZED`
   for the pre and post windows, masking QA60 cloud and cirrus bits.
2. Derives NDVI, NDMI and NBR, and the three deltas, applying the JRC Global
   Surface Water mask at the delta stage so the RGB layers keep water for
   context.
3. Reduces each delta to a fixed histogram and reads its shape.
4. Classifies each delta into Low, Moderate and High.
5. Adds six layers to GeoLibre, with the classified rasters on top and the
   continuous deltas and RGB composites beneath, hidden but available.
6. Computes per-class areas on the project UTM zone.
7. Assembles a run manifest recording every parameter, every threshold, and
   every diagnostic raised.

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

## Sessions are short by design

Earth Engine map tiles are served against an access token that expires in about
an hour. Rather than hide that, the panel shows the remaining session time. When
it lapses, layers are marked stale and a re-run regenerates them from the
recorded parameters in one click.

No tile URL is ever written into a saved project. Only parameters persist, which
means a saved project is a description of a check rather than a snapshot of one.

## Deployment

The published site is a GeoLibre web build with this plugin baked in, served
from GitHub Pages. GeoLibre is not vendored here; the deploy workflow checks it
out at a pinned tag, drops in the built plugin, builds, and publishes.

Before the first deploy you need a Cloud project and an OAuth client. See
[`docs/earth-engine-setup.md`](docs/earth-engine-setup.md), which covers
registering the client, granting colleagues access so their compute bills to
your project, and where the client ID goes.

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
imports inside the bundle. The Earth Engine client is bundled from its
`build/browser.js` browser build, which avoids the Node-only `googleapis`
dependency in the default entry point.

## Licence

MIT. See [LICENSE](LICENSE).
