# Using the tool

A walkthrough of a single disturbance check, from opening the page to having a
manifest you can paste into a finding. No GIS background is assumed beyond
knowing what a project boundary is.

If nothing appears when you open the page, or sign-in fails, that is a setup
problem rather than a usage one. See [first-run.md](first-run.md).

## Before you start

Have to hand:

- The **Cloud project ID** your team uses for Earth Engine. Ask whoever set the
  tool up. It is not your personal Google account.
- The **project boundary**, as a zipped shapefile, GeoJSON or KML.
- The **reporting period dates** from the monitoring report.

Optionally, streamside management zones and plot points, which make screenshots
far easier to orient.

## 1. Earth Engine

Type your Cloud project ID over the `murphys-deforisk` placeholder. That value
is the example from the SOP, shown so you can see the expected format, and the
Run button stays disabled until you replace it.

Compute bills to this project, not to you personally, but you sign in as
yourself. If sign-in fails with a permissions error, you have not been granted
access to the project yet.

## 2. Area of interest

Four ways to set it, in rough order of preference.

**Upload the project boundary.** The most reliable. The boundary becomes both
the analysis extent and a drawn outline on the map, and the view zooms to it.

**Use the current map view.** Pan and zoom to the site, then press the button.
Fast for a quick look, but the extent is whatever the window happened to show,
which is hard to reproduce later.

**Earth Engine asset.** If your boundary is already uploaded to Earth Engine,
paste the asset path. Its geometry is used directly.

**Typed bounds or pasted GeoJSON.** For when you have coordinates and nothing
else. West and east values in the wrong order are corrected automatically.

Keep the area to the project itself. Analysis cost and run time scale with it,
and a boundary padded with a wide margin mostly buys you noise.

## 3. Reporting periods

Four dates: the start and end of the **pre** window, and of the **post** window.
Each window is a range from which a single cloud-free composite image is built,
not a single date.

The defaults are 1 July to 1 September, and you should have a specific reason
before changing them. Two months of Sentinel-2 gives roughly eight to eleven
usable scenes per pixel, which is enough for a stable median. More importantly,
July to September is the growing season, and comparing a growing-season image to
a dormant-season one produces a large false signal that looks exactly like
disturbance. The panel warns you if a window strays outside these months, or if
your pre and post windows cover different parts of the year.

Set the years to match the reporting period under verification. Pre is the
start, post is the end.

**Maximum scene cloud cover** discards whole scenes that are cloudier than the
threshold before any per-pixel masking runs. Leave it at 30. Drop it to 20 in
the Pacific Northwest or coastal Alaska. Only raise it if the run comes back
reporting too few scenes.

To check several reporting periods at once, press **Add reporting period**. All
periods share one set of thresholds, so differences between them are real rather
than an artefact of different settings.

## 4. Severity thresholds

Each of the three indices is cut into four classes: undisturbed, Low, Moderate
and High. The numbers are the cut points. A pixel at or above the Low value is
Low, at or above Moderate is Moderate, and so on. Anything below Low is
undisturbed and is drawn transparent.

Leave these alone on your first run. The defaults come from the SOP and, for
dNBR, from the MTBS and USFS standard. They are the defensible starting point,
and departing from them without cause is the single easiest way to produce a
finding that will not survive review.

If you do change one, the panel marks that index as adjusted and asks you to
write why. That justification goes into the manifest. Writing "looked better" is
worse than leaving the default alone.

You can also drag the thresholds directly on the histograms after a run, which
is the better way to set them because you can see the distribution you are
cutting. See [interpreting-results.md](interpreting-results.md).

## 5. Site data

Upload the project boundary, streamside management zones and plot points here.
Zipped shapefile, GeoJSON or KML. Files are read inside your browser and are
never sent anywhere.

Plot points are labelled on the map with their plot identifier. The tool tries
to work out which column holds it, preferring names like `Plot ID` or `PLOT_NO`
over generic ones like `OBJECTID`. Check the detected field and change it if it
guessed wrong, because unlabelled points make a screenshot much harder for a
developer to act on.

## 6. Run

Press **Run check**. On the first run a Google sign-in window appears.

A small area takes well under a minute. A large one, or several reporting
periods, takes longer. The progress line names the stage it is working through.

When it finishes you get six layers per period in the Layer panel. The three
classified rasters are visible and on top; the continuous deltas and the
before-and-after true-colour composites are beneath them and switched off. Turn
those on when you need context.

## 7. Read the result

This is the part that needs judgement, and it has [its own
guide](interpreting-results.md).

The short version: if the panel raises a warning, resolve it before you treat
anything on screen as real. A warning usually means the imagery is
misleading rather than the site being disturbed.

## 8. Findings

Section 7 holds the run manifest: every parameter, every threshold, whether any
deviated from the SOP default and why, the class areas in hectares, and every
diagnostic raised along with whether you acknowledged it.

Copy it or download it, and keep it with the finding. It is the record of how
the number in your CAR was produced, and it is what makes the check
reproducible by someone else.

## Sessions expire

Earth Engine map tiles are served against a sign-in that lasts about an hour.
The panel shows the remaining time. When it runs out the layers stop drawing and
a **Re-run check** button appears. Your settings are all preserved, so re-running
regenerates the same layers.

This is normal and not a fault. Take your screenshots while the session is live.
