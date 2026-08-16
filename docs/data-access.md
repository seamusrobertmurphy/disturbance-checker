# Data and access

## Nothing to set up

Open the page and press Run. There is no account to create, no sign-in, no
Cloud project, no OAuth client, no test-user list and no billing. A colleague
who has never heard of Google Earth Engine, and who has no Google address of
any kind, can run a check within a minute of being sent the link.

This guide exists to explain where the imagery comes from and what has to be
reachable for a run to work. If a run succeeds, none of it needs reading.

## Where the imagery comes from

Two public services, both anonymous.

**Element 84's Earth Search**, at `https://earth-search.aws.element84.com/v1`,
is a STAC catalogue. The tool asks it which Sentinel-2 scenes cover the area of
interest inside a date window. It answers unauthenticated requests and sends
`access-control-allow-origin: *`, so a browser may call it directly.

**The Sentinel-2 L2A cloud-optimised GeoTIFFs**, in the `sentinel-cogs` bucket
on AWS Open Data. These hold the pixels. The bucket is public, is not
requester-pays, and answers HTTP range requests with CORS, so the browser can
read the few hundred kilobytes covering a project boundary out of a scene that
is 150 MB on disk.

The imagery is Copernicus Sentinel-2, processed to surface reflectance by ESA
and converted to COGs by Element 84. Copernicus data is free and open. Nothing
in the chain is licensed to an individual, so nothing has to be granted to
anyone.

## What has to be reachable

A run needs HTTPS to exactly two hosts:

```
earth-search.aws.element84.com
sentinel-cogs.s3.us-west-2.amazonaws.com
```

On a corporate network that inspects or filters outbound traffic, these are the
two to allow. If either is blocked the run fails at the first step with a
message naming them, rather than failing silently or producing a partial
composite.

## The collection, and why the older one

The tool reads `sentinel-2-l2a`, not the newer `sentinel-2-c1-l2a`.

Collection 1 is ESA's reprocessed baseline and is meant to replace the older
collection. Its assets, however, live in a bucket that serves no CORS headers
at all, so a browser cannot read a byte of it. The legacy collection's assets
are on `sentinel-cogs`, which does send them.

This is the one external dependency worth watching. If `sentinel-2-l2a` is
retired before CORS appears on the Collection 1 bucket, the tool needs either
that header to be enabled upstream or a small proxy of its own. The collection
name is a single constant in `src/stac/search.ts`, and nothing else changes.

## What is not available

**Landsat.** Earth Search indexes `landsat-c2-l2`, but its assets are `s3://`
URIs on the `usgs-landsat` bucket, which is requester-pays. Reading it needs AWS
credentials, so it cannot be part of a tool that requires none. Harmonised
Landsat and Sentinel products are out of reach for the same reason.

**Cloud Score+.** Google's per-pixel clarity score exists only inside Earth
Engine. There is no equivalent published as a COG. What this costs, and what
replaced it, is set out in [methods.md](methods.md) and is the single most
important difference between this build and the one it replaces.

**JRC Global Surface Water.** Also an Earth Engine asset. Water is now taken
from the scene classification's own water class, combined across the window.

## Radiometry

From processing baseline 04.00, in January 2022, ESA added a +1000 DN offset to
every L2A band. Compositing a pre-2022 window against a post-2022 one without
accounting for it shifts reflectance by 0.1 and manufactures roughly 0.04 of
dNDVI out of nothing. This is the false signal the SOP's pre-2022 note warns
about, and the reason Earth Engine's HARMONIZED collection exists.

Element 84 removes the offset when it builds the COGs and records that it has
done so, per scene, in `earthsearch:boa_offset_applied`. The tool reads that
flag and corrects any scene where it is absent. It deliberately does not decide
from the acquisition date: the archive also holds reprocessed baseline 05.00
products for 2018 to 2021 acquisitions, which carry the offset despite being
old scenes, and a date rule would get every one of them wrong.

If any scene ever needs correcting, the run says so in its warnings and the
manifest records it.

## Cost and rate limits

Nothing is metered. There is no quota to exhaust, no compute charge and no
billing account, because the compute happens in the browser tab rather than on
someone's server.

Both services are public goods offered without a service level agreement. If
Earth Search returns 429 the tool says it is being rate limited and to try
again shortly. Sustained heavy use by a whole team is worth being considerate
about, but ordinary verification work is far below anything that would matter.

## What a colleague needs

The URL. That is the entire list.
