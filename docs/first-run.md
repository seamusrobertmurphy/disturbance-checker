# First run

## Send them the link

```
https://seamusrobertmurphy.github.io/disturbance-checker/
```

The link is all a colleague needs. There is no account, no install, no trust
prompt and no permission to grant, and the panel is already there when the page
loads. [data-access.md](data-access.md) explains the arrangement behind this,
although none of it is needed to run a check.

## Run a check

1. **Section 2, area of interest.** Pan the map to a project area and press
   **Use current map view**, or load a boundary file. A small first area of a
   few thousand hectares shows any problem within seconds.
2. **Section 3, periods.** The August to September defaults suit a first run,
   with the pre and post years set to the reporting period.
3. **Section 4, thresholds.** The SOP breaks are the recommended starting
   point for a first run.
4. Press **Run check**.

A run over a few thousand hectares takes roughly fifteen seconds on a decent
connection. Almost all of that time is spent downloading imagery, so it scales
with the number of overpasses in the two windows rather than with the size of
the area.

## What to watch

The progress line under the Run button names the stage.

| Stage | Progress text | If it fails |
|-------|---------------|-------------|
| Search | `searching the catalogue` | Network, or a window with no scenes |
| Read and composite | `block 1 of N, reading M overpasses` | Network, or a blocked host |
| Draw | `drawing layers` | Browser memory on a very large area |

### Success looks like

A successful run leaves five layers per period in the Layer panel. From the top
down, three classified rasters are visible, with the pre and post true-colour
composites hidden beneath them. Over the basemap, coloured cells appear only
where disturbance was detected, and everything undisturbed is transparent.

Section 6 shows overpass counts, three histograms with draggable break handles,
and a class-area table in hectares. Section 7 holds the manifest.

## Read the overpass count first

The overpass count matters more in this build than it did in the last one. The
composite is a per-pixel median over the observations that survive cloud
masking, and a median needs enough clear looks to be stable, a floor the SOP
sets at four.

The panel reports how many overpasses each window kept, and raises a diagnostic
when either falls below four or when a meaningful share of pixels had fewer
clear looks than that. These diagnostics are best resolved before the map is
read, by widening the window or raising the cloud ceiling in section 3 and
running again.

## Failures you may actually see

**"The imagery catalogue could not be reached."** The cause is usually the
network or a corporate proxy. Two hosts need to be reachable over HTTPS,
`earth-search.aws.element84.com` and
`sentinel-cogs.s3.us-west-2.amazonaws.com`.

**"The catalogue returned 0 pre-period and N post-period scenes."** The window
is likely too narrow, the cloud ceiling too strict, or the years wrong.
Sentinel-2 starts in 2015 and coverage is thinner before 2017.

**"The catalogue is rate limiting this connection."** Earth Search is a free
public service, and waiting a minute before running again is usually enough.

**An overpass warning about UTM zones.** The area straddles a zone boundary far
enough that some acquisitions were never tiled into the zone the run chose.
Splitting the area at the boundary and running each half gives the most
reliable result.

**Hectares that look like the bounding box.** This happens only when a loaded
boundary contained no polygon, which raises its own warning. A rectangle AOI is
its own bounding box by definition.

## Deploying

The site is live at
<https://seamusrobertmurphy.github.io/disturbance-checker/>, rebuilt by GitHub
Actions on every push to `main`. Recreating it on a fork takes two steps.

1. **Settings → Pages**, set Source to **GitHub Actions**.
2. `git push -u origin main`.

The workflow uses no secrets. It builds the plugin, runs the smoke test, checks
out GeoLibre at the pinned `GEOLIBRE_REF`, drops the plugin in, builds with
`GEOLIBRE_APP_BASE=/disturbance-checker/`, and fails with an explicit error if
the plugin is missing from the output.

## Running it locally

```bash
cd /Volumes/PortableSSD/Github/GeoLibre
npm install                       # large; the monorepo has many workspaces

cd /Volumes/PortableSSD/Github/disturbance-checker
npm run package
cp -R build/tuvsud-disturbance-check \
  /Volumes/PortableSSD/Github/GeoLibre/apps/geolibre-desktop/public/plugins/

cd /Volumes/PortableSSD/Github/GeoLibre
npm run dev
```

Then open `http://localhost:5173/`. Plugin discovery happens when the dev
server starts, so the server needs a restart after every `npm run package`.
