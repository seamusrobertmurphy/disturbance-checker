// Scene discovery for Sentinel-1 radar against Microsoft's Planetary Computer,
// the STAC API in front of its radiometrically terrain corrected (RTC)
// Sentinel-1 cloud-optimised GeoTIFFs.
//
// This is the radar counterpart of search.ts. Earth Search, which serves the
// optical scenes, lists Sentinel-1 GRD too, but those assets sit in a
// requester-pays bucket that refuses an anonymous request, so a browser cannot
// read a byte of them. Planetary Computer's RTC product answers anonymous
// requests through a short-lived read token that the browser fetches itself,
// sends `access-control-allow-origin: *` on the catalogue, the token endpoint
// and the blob store, and honours range requests. Verified from a GitHub Pages
// origin on 2026-10-03.
//
// RTC is also the better product for this check. Earth Engine's GRD collection,
// which the notebook reads, is terrain corrected but not terrain flattened, so
// slope still moves backscatter on steep ground. RTC applies the radiometric
// terrain correction as well, so what is compared between two windows is
// closer to the canopy than to the hillside it stands on.

// Sentinel 1 Radiometrically Terrain Corrected (RTC), Microsoft Planetary Computer
// https://planetarycomputer.microsoft.com/dataset/sentinel-1-rtc
export const PLANETARY_COMPUTER_SEARCH_URL =
  "https://planetarycomputer.microsoft.com/api/stac/v1/search";
export const S1_STAC_COLLECTION = "sentinel-1-rtc";

/**
 * Where the anonymous read token comes from.
 *
 * The RTC blobs live in the storage account sentinel1euwestrtc, container
 * sentinel1-grd-rtc. A GET here, with no account and no key, returns a token
 * good for about an hour that is appended to each asset href as its query
 * string. Without it the blob store answers 409. Nothing about the token is
 * persisted: it is fetched when a run starts and forgotten when it ends.
 */
export const PLANETARY_COMPUTER_TOKEN_URL =
  "https://planetarycomputer.microsoft.com/api/sas/v1/token/sentinel1euwestrtc/sentinel1-grd-rtc";

export interface RadarScene {
  id: string;
  /** Acquisition instant, ISO 8601. */
  datetime: string;
  /** Calendar date in UTC. */
  date: string;
  /** Native CRS of the VH asset, a UTM zone. */
  epsg: number;
  /** Relative orbit number, which fixes the look direction and incidence angle. */
  orbit: number;
  /** "ascending" or "descending". */
  pass: string;
  /** sentinel-1a, sentinel-1b or sentinel-1c. */
  platform: string;
  /** Terrain-corrected gamma naught, VH, linear power, Float32, nodata -32768. */
  vhHref: string;
}

export interface RadarSearchParams {
  bbox: [number, number, number, number];
  start: string;
  end: string;
  signal?: AbortSignal;
}

interface StacFeature {
  id: string;
  properties: Record<string, unknown>;
  assets: Record<string, { href?: string }>;
}

interface StacResponse {
  features?: StacFeature[];
  links?: Array<{ rel?: string; href?: string; method?: string; body?: unknown }>;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 20;

function toRfc3339(value: string): string {
  return /\d{2}:\d{2}/.test(value) ? value : `${value}T00:00:00Z`;
}

/**
 * One catalogue entry, or null when it cannot serve this check.
 *
 * Only the interferometric wide swath mode with a VH channel is kept, which is
 * what the notebook filters Earth Engine's collection to. Every RTC scene over
 * land is IW and dual polarised, so in practice nothing is dropped here.
 */
function parseFeature(feature: StacFeature): RadarScene | null {
  const p = feature.properties;
  const epsg = Number(p["proj:epsg"]);
  const datetime = typeof p.datetime === "string" ? p.datetime : null;
  const orbit = Number(p["sat:relative_orbit"]);
  const polarisations = Array.isArray(p["sar:polarizations"])
    ? (p["sar:polarizations"] as unknown[])
    : [];
  const href = feature.assets?.vh?.href;
  if (!Number.isFinite(epsg) || !datetime || !Number.isFinite(orbit)) return null;
  if (p["sar:instrument_mode"] !== "IW" || !polarisations.includes("VH")) return null;
  if (!href || !href.startsWith("https://")) return null;
  return {
    id: feature.id,
    datetime,
    date: datetime.slice(0, 10),
    epsg,
    orbit,
    pass: typeof p["sat:orbit_state"] === "string" ? p["sat:orbit_state"] : "unknown",
    platform: typeof p.platform === "string" ? p.platform.toLowerCase() : "sentinel-1",
    vhHref: href,
  };
}

export async function searchRadarScenes(params: RadarSearchParams): Promise<RadarScene[]> {
  const collected: RadarScene[] = [];
  let request: { url: string; body: unknown } | null = {
    url: PLANETARY_COMPUTER_SEARCH_URL,
    body: {
      collections: [S1_STAC_COLLECTION],
      bbox: params.bbox,
      datetime: `${toRfc3339(params.start)}/${toRfc3339(params.end)}`,
      limit: PAGE_SIZE,
    },
  };

  for (let page = 0; page < MAX_PAGES && request; page += 1) {
    const response = await fetch(request.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request.body),
      signal: params.signal,
    });
    if (!response.ok) {
      throw new Error(
        `Planetary Computer returned ${response.status} ${response.statusText}. The catalogue may be briefly unavailable; try again in a moment.`,
      );
    }
    const payload = (await response.json()) as StacResponse;
    for (const feature of payload.features ?? []) {
      const scene = parseFeature(feature);
      if (scene) collected.push(scene);
    }
    // Pagination is a POST link carrying the next token in its own body.
    const next = payload.links?.find((link) => link.rel === "next");
    request = next?.href && next.body ? { url: next.href, body: next.body } : null;
  }

  const seen = new Set<string>();
  return collected
    .filter((scene) => (seen.has(scene.id) ? false : (seen.add(scene.id), true)))
    .sort((a, b) => a.datetime.localeCompare(b.datetime));
}

/** Fetch the anonymous read token for the RTC blobs. */
export async function radarReadToken(signal?: AbortSignal): Promise<string> {
  const response = await fetch(PLANETARY_COMPUTER_TOKEN_URL, { signal });
  if (!response.ok) {
    throw new Error(
      `Planetary Computer would not issue a read token (${response.status} ${response.statusText}). Try again in a moment.`,
    );
  }
  const payload = (await response.json()) as { token?: string };
  if (!payload.token) throw new Error("Planetary Computer returned no read token.");
  return payload.token;
}

/** The asset href with the read token appended as its query string. */
export function signHref(href: string, token: string): string {
  return `${href}${href.includes("?") ? "&" : "?"}${token}`;
}

/**
 * The relative orbits imaged in both windows, and each window cut to them.
 *
 * Backscatter depends on the look direction and the incidence angle, which a
 * relative orbit fixes, so a pixel is compared only with itself seen from the
 * same orbit. An orbit present in one window and absent from the other would
 * put a geometry change into the drop and have it read as canopy loss.
 */
export function sameOrbits(
  pre: RadarScene[],
  post: RadarScene[],
): { orbits: number[]; pre: RadarScene[]; post: RadarScene[] } {
  const inPost = new Set(post.map((scene) => scene.orbit));
  const orbits = [...new Set(pre.map((scene) => scene.orbit))]
    .filter((orbit) => inPost.has(orbit))
    .sort((a, b) => a - b);
  const keep = new Set(orbits);
  return {
    orbits,
    pre: pre.filter((scene) => keep.has(scene.orbit)),
    post: post.filter((scene) => keep.has(scene.orbit)),
  };
}

/**
 * The UTM zone that reaches the most scenes, the preferred zone breaking ties.
 *
 * RTC scenes are published on the UTM zone of their own centre, so a boundary
 * near a zone edge can have its scenes split across two zones. Only one grid
 * is read, and the scenes on the other zone are reported as dropped.
 */
export function bestRadarEpsg(scenes: RadarScene[], preferred: number): number | null {
  const counts = new Map<number, number>();
  for (const scene of scenes) counts.set(scene.epsg, (counts.get(scene.epsg) ?? 0) + 1);
  let winner: number | null = null;
  let best = -1;
  for (const [epsg, count] of counts) {
    if (count > best || (count === best && epsg === preferred)) {
      best = count;
      winner = epsg;
    }
  }
  return winner;
}
