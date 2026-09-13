# Data and access

## Nothing to set up

A check runs from the page without an account, sign-in, Cloud project, OAuth
client, test-user list or billing, so colleagues without a Google Earth Engine
account or a Google address can run one within a minute of receiving the link.

This guide describes where the imagery comes from and which services need to be
reachable for a run to complete, and it is mainly useful when a run fails.

## Where the imagery comes from

The imagery comes from two public services, both anonymous.

**Element 84's Earth Search**, at `https://earth-search.aws.element84.com/v1`,
is a STAC catalogue. The tool asks it which Sentinel-2 scenes cover the area of
interest inside a date window. It answers unauthenticated requests and sends
`access-control-allow-origin: *`, so a browser may call it directly.

**The Sentinel-2 L2A cloud-optimised GeoTIFFs**, in the `sentinel-cogs` bucket
on AWS Open Data, hold the pixels. The bucket is public, is not requester-pays,
and answers HTTP range requests with CORS, so the browser can read the few
hundred kilobytes covering a project boundary out of a scene that is 150 MB on
disk.

The imagery is Copernicus Sentinel-2, processed to surface reflectance by ESA
and converted to COGs by Element 84. Copernicus data is free and open, and
because nothing in the chain is licensed to an individual, no access has to be
granted to anyone.

**NASA POWER**, at `https://power.larc.nasa.gov`, supplies the daily climate
drawn under the reporting periods. It is the agency's surface climate service,
built on the MERRA-2 reanalysis, on a grid half a degree of latitude by five
eighths of a degree of longitude, from 1981 to a few days ago. It answers
anonymous requests with `access-control-allow-origin: *` and needs no key. One
request of a few hundred kilobytes fetches every year a check touches and the
ten before them. It provides context for placing the windows rather than an
input to the analysis, so a run completes without it.

Two other climate services were considered and set aside. Open-Meteo has a finer
grid and the same anonymous access, but its free tier is for non-commercial
use, which is the reason Earth Engine was dropped. Daymet is finer still over
North America, but its single-pixel service sends no CORS header, so a browser
cannot read it.

## What has to be reachable

A run needs HTTPS access to the first two hosts below, and the season charts use
the third.

```
earth-search.aws.element84.com
sentinel-cogs.s3.us-west-2.amazonaws.com
power.larc.nasa.gov
```

On a corporate network that inspects or filters outbound traffic, the first two
are the ones to allow. If either is blocked, the run stops at the first step with
a message naming them rather than failing silently or producing a partial
composite.

## The collection, and why the older one

The tool reads `sentinel-2-l2a` rather than the newer `sentinel-2-c1-l2a`.

Collection 1 is ESA's reprocessed baseline and is intended to replace the older
collection. Its assets, however, live in a bucket that serves no CORS headers,
so a browser cannot read them, whereas the legacy collection's assets are on
`sentinel-cogs`, which does send them.

This is the one external dependency worth monitoring. If `sentinel-2-l2a` is
retired before CORS appears on the Collection 1 bucket, the tool will need
either that header to be enabled upstream or a small proxy of its own. The
collection name is a single constant in `src/stac/search.ts`, and nothing else
would change.

## What is not available

**Landsat.** Earth Search indexes `landsat-c2-l2`, but its assets are `s3://`
URIs on the `usgs-landsat` bucket, which is requester-pays. Reading it requires
AWS credentials, which places it outside a tool designed to need none, and
Harmonised Landsat and Sentinel products are out of reach for the same reason.

**Cloud Score+.** Google's per-pixel clarity score exists only inside Earth
Engine, and nothing equivalent is published as a COG. Cloud is removed here
either from the scene classification or by a segmentation model run in the tab,
whose weights are MIT and are served from this deployment rather than fetched
from anyone. See [methods.md](methods.md).

**JRC Global Surface Water.** This is also an Earth Engine asset. Water is taken
instead from the scene classification's own water class, combined across the
window.

## Radiometry

From processing baseline 04.00, in January 2022, ESA added a +1000 DN offset to
every L2A band. Compositing a pre-2022 window against a post-2022 one without
accounting for it shifts reflectance by 0.1 and produces roughly 0.04 of dNDVI
that does not reflect any change on the ground. This is the false signal the
SOP's pre-2022 note describes, and the reason Earth Engine's HARMONIZED
collection exists.

Element 84 removes the offset when it builds the COGs and records that it has
done so, per scene, in `earthsearch:boa_offset_applied`. The tool reads that
flag and corrects any scene where it is absent. It does not decide from the
acquisition date, because the archive also holds reprocessed baseline 05.00
products for 2018 to 2021 acquisitions, which carry the offset despite being
older scenes, and a date rule would misclassify every one of them.

If any scene needs correcting, the run reports it in its warnings and the
manifest records it.

## Cost and rate limits

Nothing is metered. There is no quota, compute charge or billing account,
because the computation happens in the browser tab rather than on a server.

Both services are public goods offered without a service level agreement. If
Earth Search returns 429, the tool reports that it is being rate limited and
suggests trying again shortly. Sustained heavy use by a whole team calls for
some consideration, although ordinary verification work sits well below any
level that would matter.

## What a colleague needs

A colleague needs only the URL.
