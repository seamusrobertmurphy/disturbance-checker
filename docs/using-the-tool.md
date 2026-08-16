# Using the tool

A walkthrough of a single disturbance check, from opening the page to having a
manifest you can paste into a finding. No GIS background is assumed beyond
knowing what a project boundary is.

If nothing appears when you open the page, that is a setup problem rather than a
usage one. See [first-run.md](first-run.md).

## Before you start

Have to hand:

- The **project boundary**, as a zipped shapefile, GeoJSON or KML.
- The **reporting period dates** from the monitoring report.

Optionally, streamside management zones and plot points, which make screenshots
far easier to orient.

There is no account, no sign-in and no project ID. The imagery is open data read
straight from a public archive. See [data-access.md](data-access.md) if you want
to know what that means.

## 1. Imagery

Nothing to set. The section states where the imagery comes from and how cloud is
being removed, and holds two switches worth knowing about.

**Reject cast shadow** is on by default. In steep terrain it can remove most
north-facing slopes from every scene in a window, which costs more than the
cloud it avoids. If a run comes back with far fewer usable pixels than expected
in mountainous country, this is the first thing to try turning off.

**Reject snow and ice** matters only when a window reaches into the shoulder
season.

## 2. Area of interest

Three ways to set it, in rough order of preference.

**Upload the project boundary.** The most reliable. The boundary becomes both
the analysis extent and a drawn outline on the map, and the view zooms to it.

**Use the current map view.** Pan and zoom to the site, then press the button.
Fast for a quick look, but the extent is whatever the window happened to show,
which is hard to reproduce later.

**Typed bounds or pasted GeoJSON.** For when you have coordinates and nothing
else. West and east values in the wrong order are corrected automatically.

Keep the area to the project itself. Run time scales with it, because every
pixel is downloaded, and a boundary padded with a wide margin mostly buys you
noise.

A loaded boundary is measured as the polygon, not as its bounding box. A
rectangle is its own bounding box by definition, which for an L-shaped ownership
or a long riparian parcel can be most of the number.

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

Press **Run check**.

A few thousand hectares takes roughly fifteen seconds. Almost all of that is
downloading imagery, so it scales with the number of overpasses in the two
windows rather than with the area. The progress line names the stage.

When it finishes you get twelve layers per period in the Layer panel. The three
classified rasters are visible and on top; the continuous deltas, the
single-date index layers and the before-and-after true-colour composites are
beneath them and switched off. Turn those on when you need context.

**Read the overpass count before anything else.** The composite is a median over
the observations that survived cloud masking, and a median needs at least four
clear looks to be stable. If the panel says a window kept fewer, or that a
share of pixels had fewer, widen the window or raise the cloud ceiling and run
again.

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

## Nothing expires

Earlier versions served map tiles against a sign-in that lapsed after an hour,
and the layers stopped drawing when it did. That is gone. The layers are images
this tab painted, and they stay until you close it or run again.

If you change a parameter after a run, the panel says so and offers a **Re-run
check**. That is a note about the panel and the map disagreeing, not about
anything expiring.
