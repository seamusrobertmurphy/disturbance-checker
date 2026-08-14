# First run

## Send them the link

```
https://seamusrobertmurphy.github.io/disturbance-checker/
```

That is the whole procedure for a colleague. No account, no install, no trust
prompt, no permission to be granted. The panel is already there when the page
loads. If you want to understand what is behind that, read
[data-access.md](data-access.md); nothing in it is needed to run a check.

## Run a check

1. **Section 2, area of interest.** Pan the map to a project area and press
   **Use current map view**, or load a boundary file. Keep the first area
   small, a few thousand hectares, so a mistake surfaces in seconds.
2. **Section 3, periods.** Leave the August to September defaults and set the
   pre and post years.
3. **Section 4, thresholds.** Leave the SOP breaks alone on a first run.
4. Press **Run check**.

A run over a few thousand hectares takes roughly fifteen seconds on a decent
connection. Almost all of that is downloading imagery, so it scales with the
number of overpasses in the two windows rather than with the size of the area.

## What to watch

The progress line under the Run button names the stage.

| Stage | Progress text | If it fails |
|-------|---------------|-------------|
| Search | `searching the catalogue` | Network, or a window with no scenes |
| Read and composite | `block 1 of N, reading M overpasses` | Network, or a blocked host |
| Draw | `drawing layers` | Browser memory on a very large area |

### Success looks like

Twelve layers per period in the Layer panel. Reading top down: three classified
rasters visible, three continuous deltas hidden, four single-date index layers
hidden, two RGB composites hidden. Over the basemap you should see coloured
cells only where disturbance was detected, with everything undisturbed
transparent.

Section 6 shows overpass counts, three histograms with draggable break handles,
and a class-area table in hectares. Section 7 has the manifest.

## Read the overpass count first

This matters more in this build than it did in the last one. The composite is a
per-pixel median over the observations that survive cloud masking, and a median
needs enough clear looks to be stable. The SOP puts that floor at four.

The panel reports how many overpasses each window kept, and raises a diagnostic
when either falls below four or when a meaningful share of pixels had fewer
clear looks than that. Treat those as blocking. Widen the window or raise the
cloud ceiling in section 3 and run again before reading anything into the map.

## Failures you may actually see

**"The imagery catalogue could not be reached."** The network, or a corporate
proxy. Two hosts have to be reachable over HTTPS:
`earth-search.aws.element84.com` and
`sentinel-cogs.s3.us-west-2.amazonaws.com`.

**"The catalogue returned 0 pre-period and N post-period scenes."** The window
is too narrow, the cloud ceiling too strict, or the years are wrong. Sentinel-2
starts in 2015 and coverage is thinner before 2017.

**"The catalogue is rate limiting this connection."** Wait a minute. Earth
Search is a free public service.

**An overpass warning about UTM zones.** The area straddles a zone boundary far
enough that some acquisitions were never tiled into the zone the run chose.
Splitting the area at the boundary and running each half is the honest fix.

**Hectares that look like the bounding box.** Only possible if a loaded boundary
contained no polygon, which raises its own warning. A rectangle AOI is its own
bounding box by definition.

## Deploying

The site is live at
<https://seamusrobertmurphy.github.io/disturbance-checker/>, rebuilt by GitHub
Actions on every push to `main`. Recreating it on a fork takes two steps:

1. **Settings → Pages**, set Source to **GitHub Actions**.
2. `git push -u origin main`.

No secrets are involved any more. The workflow builds the plugin, runs the
smoke test, checks out GeoLibre at the pinned `GEOLIBRE_REF`, drops the plugin
in, builds with `GEOLIBRE_APP_BASE=/disturbance-checker/`, and fails loudly if
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
server starts, so restart it after every `npm run package`.
