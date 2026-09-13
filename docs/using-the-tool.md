# Using the tool

This guide follows a single disturbance check from opening the page to a
manifest ready to paste into a finding.

If nothing appears when the page opens, the cause is usually in setup rather
than use, and [first-run.md](first-run.md) covers it.

## Before you start

Two inputs are needed.

- The **project boundary**, as a zipped shapefile, GeoJSON or KML.
- The **reporting period dates** from the monitoring report.

Streamside management zones and plot points are optional, and they make
screenshots far easier to orient.

There is no account, no sign-in and no project ID, because the imagery is open
data read straight from a public archive. [data-access.md](data-access.md)
describes the arrangement in full.

## 1. Imagery

This section needs no settings. It states where the imagery comes from and how
cloud is removed, and it holds two switches worth knowing about.

**Reject cast shadow** is on by default. In steep terrain it can remove most
north-facing slopes from every scene in a window, which can cost more than the
cloud it avoids, so it is the first switch to try when a run in mountainous
country returns far fewer usable pixels than expected.

**Reject snow and ice** matters only when a window reaches into the shoulder
season.

## 2. Area of interest

There are three ways to set it, listed here in rough order of preference.

**Upload the project boundary.** This is the most reliable option. The boundary
becomes both the analysis extent and a drawn outline on the map, and the view
zooms to it.

**Use the current map view.** Pan and zoom to the site, then press the button.
It is fast for a quick look, although the extent is whatever the window happened
to show, which is hard to reproduce later.

**Typed bounds or pasted GeoJSON.** This suits cases where coordinates are the
only thing available. West and east values given in the wrong order are
corrected automatically.

Keeping the area to the project itself works best, because run time scales with
area as every pixel is downloaded, and a wide margin around the boundary adds
mostly noise.

A loaded boundary is measured as the polygon, not as its bounding box. A
rectangle is its own bounding box by definition, and for an L-shaped ownership
or a long riparian parcel the difference can be most of the number.

## 3. Reporting periods

Four dates are set here, the start and end of the **pre** window and the start
and end of the **post** window. Each window is a range from which a single
cloud-free composite image is built, not a single date.

The defaults are 1 July to 1 September, and they are worth keeping unless the
site gives a specific reason to move them. Two months of Sentinel-2 gives
roughly eight to eleven usable scenes per pixel, which is enough for a stable
median. July to September is also the growing season, and comparing a
growing-season image with a dormant-season one produces a large false signal
that closely resembles disturbance. The panel flags a window that strays outside
these months, or pre and post windows that cover different parts of the year.

The years follow the reporting period under verification, with pre at the start
and post at the end.

**Season at the site** draws under the dates once an area of interest is set.
It shows the daily climate at the centre of the area, read from NASA POWER,
with one line per reporting-period year over a grey ten-year mean and the pre
and post windows shaded. There are four small charts, one each for air
temperature, sunlight, rain over the previous four weeks and, where any fell,
snow depth. Hovering over a chart reads out the values on a date.

The charts address one question, whether the two composites were taken at the
same point of the season. Matching calendar dates is the first consideration,
and the shaded bands show at once when the pre and post windows sit on
different parts of the year. The second is whether the season ran on time in
both years. A coloured line above the grey mean in spring marks an early year,
in which leaf-out was further on than the date suggests, and a line below it
marks a late one. A window with snow on the ground in one year and bare ground
in the other is not a matched pair whatever the dates say. Where the years
disagree, moving the window a week or two until the two lines meet usually
resolves it before the run.

The table under the charts gives the mean temperature, sunlight, total rain and
snow days inside each window, pre against post, and the same numbers go into
the manifest in section 8 so that a finding can quote them. None of this is an
input to the analysis, and it serves as context for a decision the tool leaves
with the verifier. [Matching the season](season-matching.md) works through four
cases with screenshots, reasons and references.

**Maximum scene cloud cover** discards whole scenes that are cloudier than the
threshold before any per-pixel masking runs. The default of 30 suits most sites,
20 tends to work better in the Pacific Northwest and coastal Alaska, and raising
it is mainly useful when a run reports too few scenes.

**Add reporting period** checks several reporting periods at once. All periods
share one set of thresholds, so differences between them reflect the imagery
rather than different settings.

## 4. Severity thresholds

Each of the three indices is divided into four classes, undisturbed, Low,
Moderate and High, and the values shown are the lower bound of each class. A
pixel at or above the Low value is classed Low, at or above Moderate is classed
Moderate, and so on, while values below Low are treated as undisturbed and drawn
transparent.

The defaults follow the SOP and, for dNBR, the MTBS and USFS thresholds, which
makes them a well-supported starting point for a first run. Where site
conditions call for different cut points, the panel marks the index as adjusted
and asks for a short rationale, which is recorded in the manifest so that a
reviewer can follow the reasoning behind the change. A rationale that names the
site condition behind the change serves that reviewer best.

Thresholds can also be set by dragging them on the histograms after a run,
which has the advantage of showing the distribution being cut. See
[interpreting-results.md](interpreting-results.md).

## 5. Site data

The project boundary, streamside management zones and plot points are uploaded
here, as a zipped shapefile, GeoJSON or KML. Files are read inside the browser
and are not sent anywhere.

Plot points are labelled on the map with their plot identifier. The tool infers
which column holds it, preferring names like `Plot ID` or `PLOT_NO` over generic
ones like `OBJECTID`. The detected field is worth a quick check, since labelled
points make a screenshot much easier for a developer to act on.

## 6. Run

Press **Run check**.

A few thousand hectares takes roughly fifteen seconds. Almost all of that time
is spent downloading imagery, so it scales with the number of overpasses in the
two windows rather than with the area. The progress line names the stage.

When the run finishes, the Layer panel holds five layers per period. The three
classified rasters are visible and on top, and the before-and-after true-colour
composites sit beneath them, switched off, ready to turn on for context.

**The overpass count is the first thing to read.** The composite is a median
over the observations that survived cloud masking, and a median needs at least
four clear looks to be stable. Where the panel reports that a window kept fewer,
or that a share of pixels had fewer, widening the window or raising the cloud
ceiling and running again gives a sounder composite.

## 7. Read the result

This step calls for judgement, and it has [its own
guide](interpreting-results.md).

In brief, a warning raised by the panel is best resolved before anything on
screen is treated as real, because a warning usually points to misleading
imagery rather than to a disturbed site.

## 8. Findings

Section 7 holds the run manifest, which records every parameter, every
threshold, whether any deviated from the SOP default and why, the class areas in
hectares, and every diagnostic raised along with whether it was acknowledged.

The manifest can be copied or downloaded and kept with the finding. It records
how the number in the CAR was produced, and it is what allows someone else to
reproduce the check.

## Nothing expires

Earlier versions served map tiles against a sign-in that lapsed after an hour,
and the layers stopped drawing when it did. That arrangement has gone. The
layers are images this tab painted, and they stay until the tab is closed or the
check is run again.

If a parameter changes after a run, the panel notes it and offers a **Re-run
check**. The note refers to the panel and the map disagreeing, not to anything
expiring.
