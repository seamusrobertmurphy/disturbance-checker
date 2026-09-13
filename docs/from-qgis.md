# From QGIS to the browser

This guide sets out what the tool replaces, what it keeps and what it leaves
out, for anyone who ran the disturbance check in QGIS and would like to see what
changed underneath.

## The short version

In the QGIS workflow the processing ran on Google's servers rather than on the
local machine. Every composite, index, delta, histogram and classification
executed in Earth Engine, and QGIS served as an authentication shell, a code
pane and a tile viewer.

In this tool the processing runs in the browser. It reads Sentinel-2 pixels
directly from a public archive and does the arithmetic locally.

The work has therefore moved twice, and it now sits closer to the analyst than
it did in the desktop GIS. The setup that existed to obtain and hold a Google
credential has gone with it.

## What the old workflow required

Steps 1 and 2 of the SOP covered setup before any analysis began.

![OSGeo4W Shell refusing the geemap install with an access denied error](images/step5-osgeo4w-denied.webp)

*The failure mode that took the most support time was `pip install geemap`
against the QGIS-bundled Python, refused without an elevated shell. Where pip
resolved to system Python instead, the plugin imported but `ee` was missing at
runtime, which produced a different and less obvious error later.*

Three plugins then had to be activated together and in the right order.

![QGIS Plugin Manager with the Earth Engine plugins installed, and the disturbance layer stack in the Layers panel](images/step1-plugin-manager.webp)

*Google Earth Engine, GEE Data Catalog and Geemap are all active here. The
Layers panel on the left holds the stack the script produces, which is the same
stack the browser tool builds today.*

The remaining setup was binding a Cloud project in the plugin settings, an OAuth
round trip through the system browser, and a credentials cache that expired
after roughly seven days and was refreshed with `ee.Authenticate(force=True)`.

After that the script could be pasted into the code pane and run.

![The geemap code panel with the disturbance script loaded and executed](images/step4-geemap-run.webp)

*The script is on the right, Run Code dispatches to Earth Engine, and the layers
appear on the left. Everything before this point was setup.*

## What replaced it

| Old | New |
|---|---|
| Install Python packages into the QGIS Python | Nothing to install |
| Three QGIS plugins, activated in order | One plugin, one toggle |
| Bind the project in plugin settings | Nothing to bind |
| OAuth through the system browser, cached 7 days | No account of any kind |
| Paste a script and edit four constants | Form fields with validation |
| Read the histogram in a matplotlib window | Histogram in the panel with draggable breaks |
| Record thresholds by hand in a workbook | Run manifest, generated |
| Layer names typed into `m.addLayer` calls | Same stack, built automatically |

The four constants at the top of the script became the first three panel
sections, the class breaks in `classify_delta_*()` became section 4, and the
`m.addLayer` block at the end became the layer sync.

## What is the same

The following are kept identical so that results are comparable across the two.

- Sentinel-2 L2A surface reflectance, divided by 10000, clipped to the ROI.
- NDVI on B8/B4, NDMI on B8/B11, NBR on B8A/B12.
- Water masked at the delta stage, not on the composite, so the RGB layers keep
  their water for context.
- dNDVI and dNDMI as pre minus post; dNBR as post minus pre.
- 130 fixed histogram bins from -0.5 to 0.8, at 20 m.
- The class breaks, unchanged, including the different dNDMI ramp.
- The visualisation palettes and ranges, including the RGB gamma of 1.2.

[methods.md](methods.md) gives the full detail, including a table of the places
where the SOP PDF, the QGIS script and the ArcGIS script disagree with each
other.

## What is different, and why

**Cloud masking works differently.** The scripts rank every pixel on Cloud
Score+ and keep the single clearest observation. That score is a Google product
available only inside Earth Engine. This build offers the Sen2Cor scene
classification, which is weaker, or a segmentation model run in the tab, which
catches thin edges and cloud shadow that the classification lets through. In
both cases there is no clarity score to rank on, so the reduction is a median,
which is the SOP's own documented alternative, and the SOP's floor of four clear
scenes becomes a binding requirement rather than advice. The overpass counts are
worth checking for that reason.

**Water comes from the scene classification, not JRC Global Surface Water.** GSW
is an Earth Engine asset with no open equivalent, and the two sources differ on
seasonal water.

**The histogram has no ceiling.** The scripts reduce to a `maxPixels` limit and
truncate past it, which the SOP records happening silently at 1e9 on wide areas.
Here every pixel is counted, so there is nothing to truncate and no limit to
raise.

**Areas are counted, not integrated.** The grid is the native Sentinel-2 UTM
grid, so a pixel is exactly 20 by 20 m and hectares are a multiplication. The
scripts passed an explicit projection to every area reduction to avoid measuring
on a degree grid.

**Bounds are normalised.** The script's `ee.Geometry.Rectangle` accepts reversed
coordinates and returns an empty geometry without an error, whereas the tool
puts them in the right order.

**Thresholds are recorded.** Moving a break off its default asks for a short
written rationale, which is kept in the manifest rather than in a separate
workbook note.

**Nothing is exported.** Steps 9 and 12 of the script queue GeoTIFF exports to
Drive. Export is not implemented here, and it is the largest gap between the
two.

## What the old workflow still does better

**Export.** The script supports batch export to Drive or Cloud Storage at 10 m,
and the exports outlive the session, so archived rasters are best produced with
the script.

**Cloud Score+.** The score is not reachable from a browser, and no other
source offers a continuous clarity score to rank observations on, which is why
the reduction here is a median rather than a best-pixel pick.

**Arbitrary analysis.** The code pane runs any Earth Engine expression, while
the panel runs one analysis with parameters, so work outside the SOP is better
suited to the script.

**Landsat and anything before 2015.** The USGS archive is requester-pays, so a
credential-free tool cannot read it.

The two approaches complement each other. The browser tool suits quick,
repeatable screening with an audit record and without an account, and the script
suits the archival deliverable and the cases where masking quality decides the
answer.

## The original documents

The SOP itself, both production scripts, the step-by-step setup captures and the
geemap-for-QGIS introduction deck are held outside this repository. Only the
figures are reproduced here, as downscaled WebP copies under `docs/images/`.
