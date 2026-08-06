# From QGIS to the browser

What this tool replaces, what it keeps, and what it deliberately does not do.
Written for anyone who ran the disturbance check the old way and wants to know
what changed underneath.

## The short version

The analysis has not changed. It never ran on your machine in the first place.

Every composite, index, delta, histogram and classification in the QGIS workflow
executed on Google's servers. QGIS was an authentication shell, a code pane and
a tile viewer. Once you notice that, the browser version stops looking like a
rewrite and starts looking like the same script with a different front end.

What has gone is the apparatus needed to make a desktop GIS capable of doing
what a browser does natively.

## What the old workflow required

Steps 1 and 2 of the SOP, before any analysis begins.

![OSGeo4W Shell refusing the geemap install with an access denied error](images/step5-osgeo4w-denied.webp)

*The failure mode that cost the most support time. `pip install geemap` against
the QGIS-bundled Python, refused for want of an elevated shell. If pip resolved
to system Python instead, the plugin imported but `ee` was missing at runtime,
which produced a different and less obvious error later.*

Then three plugins, activated together and in the right order:

![QGIS Plugin Manager with the Earth Engine plugins installed, and the disturbance layer stack in the Layers panel](images/step1-plugin-manager.webp)

*Google Earth Engine, GEE Data Catalog and Geemap, all three active. The Layers
panel on the left is the stack the script produces, and it is the same stack the
browser tool builds today.*

Then binding a Cloud project in the plugin settings, an OAuth round trip through
the system browser, and a credentials cache that expired after roughly seven
days and had to be refreshed with `ee.Authenticate(force=True)`.

Only then could the script be pasted into the code pane and run:

![The geemap code panel with the disturbance script loaded and executed](images/step4-geemap-run.webp)

*Script on the right, Run Code dispatching to Earth Engine, layers appearing on
the left. Everything to the left of this point was setup.*

## What replaced it

| Old | New |
|---|---|
| Install Python packages into the QGIS Python | Nothing to install |
| Three QGIS plugins, activated in order | One plugin, one toggle |
| Bind the project in plugin settings | A field in the panel, or a URL parameter |
| OAuth through the system browser, cached 7 days | A sign-in button, one hour, re-run when it lapses |
| Paste a script and edit four constants | Form fields with validation |
| Read the histogram in a matplotlib window | Histogram in the panel with draggable breaks |
| Record thresholds by hand in a workbook | Run manifest, generated |
| Layer names typed into `m.addLayer` calls | Same stack, built automatically |

The four constants at the top of the script became the first three panel
sections. The class breaks in `classify_delta_*()` became section 4. The
`m.addLayer` block at the end became the layer sync.

## What is the same

Deliberately identical, so results are comparable across the two:

- `COPERNICUS/S2_SR_HARMONIZED`, divided by 10000, clipped to the ROI.
- Cloud Score+ with the `cs` band at 0.40, then `qualityMosaic`.
- NDVI on B8/B4, NDMI on B8/B11, NBR on B8A/B12.
- The JRC Global Surface Water mask at 50% occurrence, `unmask(1)`, applied at
  the delta stage.
- dNDVI and dNDMI as pre minus post; dNBR as post minus pre.
- `fixedHistogram(-0.5, 0.8, 130)` at scale 20.
- The class breaks, unchanged, including the different dNDMI ramp.
- The visualisation palettes and ranges, including the RGB gamma of 1.2.

Full detail in [methods.md](methods.md), including a table of the places where
the SOP PDF, the QGIS script and the ArcGIS script disagree with each other.

## What is different, and why

**Cloud Score+ is the default, not QA60.** Both production scripts switched to
it; the SOP PDF still documents QA60. The tool follows the scripts and keeps
QA60 selectable so an older result can be reproduced.

**Histogram `maxPixels` is 1e10, not 1e9.** At 1e9 a wide area silently returns
a truncated histogram, which looks plausible and is wrong. The higher limit
fails loudly instead.

**Bounds cannot be reversed.** The script's `ee.Geometry.Rectangle` accepts
reversed coordinates and returns an empty geometry with no error. The tool
normalises them.

**Thresholds are recorded.** Moving a break off its default requires a written
justification that lands in the manifest, rather than a note in a workbook that
may or may not be written.

**Nothing is exported.** Step 9 and 12 of the script queue GeoTIFF exports to
Drive. That is not implemented here, and it is the largest deliberate gap.

## What the old workflow still does better

**Export.** Batch export to Drive or Cloud Storage, at 10 m, outliving the
session. If you need archived rasters, run the script.

**Arbitrary analysis.** The code pane runs any Earth Engine expression. The
panel runs one analysis with parameters. For anything outside the SOP, the
script is the tool.

**Offline project state.** A QGIS project holds exported GeoTIFFs on disk and
opens without Earth Engine. Browser sessions hold live tiles that expire in
about an hour.

The two are complements. The browser tool is for screening quickly, repeatedly
and with an audit record. The script is for the archival deliverable.

## Where the original documents live

The SOP, both production scripts and the original screenshots are in this
repository under `docs/`:

- `TÜV SÜD SOP Disturbance Check-QGIS.docx` and the ArcGIS variant
- `Screenshots/` — the step-by-step setup captures
- `Slides/` — the geemap-for-QGIS introduction deck

The figures reproduced in this library are downscaled copies of the same images.
