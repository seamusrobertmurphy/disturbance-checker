// Scene discovery against Element 84's Earth Search, the STAC API in front of
// the Sentinel-2 L2A cloud-optimised GeoTIFFs on AWS Open Data.
//
// This module replaces ee.ImageCollection(...).filterDate().filterBounds().
// Nothing here authenticates. Earth Search answers anonymous requests and sends
// `access-control-allow-origin: *`, so it is callable straight from a browser
// with no account, no token and no API key.
//
// The collection is deliberately `sentinel-2-l2a` and not the newer
// `sentinel-2-c1-l2a`. Collection 1 is intended to replace this one, but its
// assets sit in the `e84-earth-search-sentinel-data` bucket, which serves no
// CORS headers at all, so a browser cannot read a byte of it. The legacy
// collection's assets are on `sentinel-cogs`, which sends
// `access-control-allow-origin: *` and honours range requests. Migrating means
// either CORS appearing on the new bucket or standing up a proxy, and both
// change this constant and nothing else.

export const EARTH_SEARCH_URL = "https://earth-search.aws.element84.com/v1/search";

export const S2_STAC_COLLECTION = "sentinel-2-l2a";

/**
 * The Earth Search asset keys this tool reads, mapped to the Sentinel-2 band
 * names the SOP and both production scripts use.
 *
 * Native resolution is not uniform: red, green, blue and nir are 10 m, the rest
 * are 20 m. The reader resamples everything onto one grid, so callers never
 * see the difference.
 */
export const ASSET_BANDS = {
  blue: "B2",
  green: "B3",
  red: "B4",
  nir: "B8",
  nir08: "B8A",
  swir16: "B11",
  swir22: "B12",
  scl: "SCL",
} as const;

export type AssetKey = keyof typeof ASSET_BANDS;

/** Assets needed for the indices and the mask. `visual` is not used: the RGB
 * composite is built from the reflectance bands so it carries the same masking
 * and the same gamma the production scripts apply. */
export const REQUIRED_ASSETS: AssetKey[] = [
  "blue",
  "green",
  "red",
  "nir",
  "nir08",
  "swir16",
  "swir22",
  "scl",
];

export interface StacScene {
  id: string;
  /** Acquisition instant, ISO 8601. */
  datetime: string;
  /** Calendar date in UTC, used for deduplication. */
  date: string;
  /** Scene-level cloud percentage from eo:cloud_cover. */
  cloudCover: number;
  /** Native CRS of every asset in this scene, always a UTM zone. */
  epsg: number;
  /** MGRS tile, e.g. "10UDV". */
  tile: string;
  platform: string;
  /** Processing timestamp, used to break ties between duplicate products. */
  created: string;
  /** ESA processing baseline, e.g. "05.11". Numeric so it can be compared. */
  baseline: number;
  /**
   * The acquisition this product was cut from, with the baseline suffix
   * removed.
   *
   * MGRS tiles overlap, and near a UTM zone boundary a single overpass is
   * published twice, once per zone: `S2B_10UCA_20190802` and
   * `S2B_9UYR_20190802` are the same two seconds of sensing written onto two
   * grids. Both carry datatake `GS2B_20190802T191919_012566`. Treating them as
   * two observations would weight that overpass twice in the median and would
   * make an AOI near a zone edge look better observed than it is.
   */
  datatake: string;
  /**
   * Whether the +1000 DN radiometric offset has already been removed.
   *
   * This is the single most dangerous property in the catalogue for this tool.
   * From baseline 04.00, January 2022, ESA added a 1000 DN offset to every
   * L2A band. Compositing a pre-2022 window against a post-2022 window without
   * accounting for it shifts reflectance by 0.1 and manufactures roughly 0.04
   * of dNDVI out of nothing, which is the false signal the SOP's Pre-2022
   * baseline note warns about and the reason Earth Engine's HARMONIZED
   * collection exists.
   *
   * Element 84 removes the offset when it builds the COGs and records the fact
   * in `earthsearch:boa_offset_applied`. Trusting that flag rather than the
   * date is what makes this correct: the archive also holds reprocessed
   * baseline 05.00 products for 2018 to 2021 acquisitions, which carry the
   * offset despite being old scenes.
   */
  boaOffsetApplied: boolean;
  hrefs: Record<AssetKey, string>;
}

/** Baseline from which ESA applies the +1000 DN offset. */
export const BOA_OFFSET_BASELINE = 4;

/** The offset in DN, to be subtracted when it has not already been removed. */
export const BOA_OFFSET_DN = 1000;

/**
 * DN to subtract from every reflectance band of a scene before scaling.
 *
 * Zero for everything Element 84 has already corrected, which is the whole
 * archive at the time of writing. The non-zero branch exists because a flag
 * that is always true today is not a guarantee, and a silent 0.04 bias is
 * exactly the kind of error a verification tool must not be able to make.
 */
export function boaOffsetCorrection(scene: StacScene): number {
  if (scene.boaOffsetApplied) return 0;
  return scene.baseline >= BOA_OFFSET_BASELINE ? BOA_OFFSET_DN : 0;
}

export interface SearchParams {
  /** AOI bounds in lon/lat, [west, south, east, north]. */
  bbox: [number, number, number, number];
  /** Inclusive start, ISO date or datetime. */
  start: string;
  /** Exclusive end, ISO date or datetime. */
  end: string;
  /**
   * Scene-level cloud ceiling in percent.
   *
   * Under Cloud Score+ the production scripts define MAX_CLOUD but never apply
   * it, because per-pixel masking makes a scene filter unnecessary. Here it
   * survives for a different reason: every scene kept is a set of HTTP range
   * reads over the network, so discarding hopeless scenes up front is what
   * keeps a run to seconds rather than minutes. Set it to 100 to disable.
   */
  maxCloud: number;
  /** Hard ceiling on scenes returned, newest first once sorted. */
  limit?: number;
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
  numberMatched?: number;
}

const PAGE_SIZE = 100;
/** Guard against an unbounded crawl if a date window is opened far too wide. */
const MAX_PAGES = 20;

function toRfc3339(value: string): string {
  // Earth Search rejects a bare `2024-08-01/2024-09-01` interval, so dates are
  // widened to instants. A date-only string is treated as midnight UTC.
  return /\d{2}:\d{2}/.test(value) ? value : `${value}T00:00:00Z`;
}

function parseFeature(feature: StacFeature): StacScene | null {
  const props = feature.properties ?? {};
  const epsg = Number(props["proj:epsg"]);
  const datetime = String(props.datetime ?? "");
  if (!Number.isFinite(epsg) || !datetime) return null;

  const hrefs = {} as Record<AssetKey, string>;
  for (const key of REQUIRED_ASSETS) {
    const href = feature.assets?.[key]?.href;
    // An `s3://` href is on a requester-pays bucket and unreadable from a
    // browser. Only the https hrefs on sentinel-cogs are usable.
    if (!href || !href.startsWith("https://")) return null;
    hrefs[key] = href;
  }

  const grid = String(props["grid:code"] ?? "");
  return {
    id: feature.id,
    datetime,
    date: datetime.slice(0, 10),
    cloudCover: Number(props["eo:cloud_cover"] ?? 100),
    epsg,
    tile: grid.replace(/^MGRS-/, ""),
    platform: String(props.platform ?? ""),
    created: String(props.created ?? ""),
    baseline: Number.parseFloat(String(props["s2:processing_baseline"] ?? "0")),
    datatake: String(props["s2:datatake_id"] ?? feature.id).replace(
      /_N\d+\.\d+$/,
      "",
    ),
    boaOffsetApplied: props["earthsearch:boa_offset_applied"] === true,
    hrefs,
  };
}

/**
 * Drop duplicate products for the same tile and day.
 *
 * Every acquisition from 2018 to 2021 appears twice: once as the product ESA
 * originally released, on baseline 00.01 through 03.01, and once as the
 * Collection 1 reprocessing on baseline 05.00. Both are real products covering
 * the same ground at the same instant. Keeping both would weight that
 * observation twice in the median and mix two radiometric calibrations inside
 * a single composite.
 *
 * The reprocessed product wins. It is the one ESA considers current, its
 * calibration is consistent with everything acquired since, and it is the one
 * whose offset handling the catalogue reports explicitly.
 */
function deduplicate(scenes: StacScene[]): StacScene[] {
  const best = new Map<string, StacScene>();
  for (const scene of scenes) {
    const key = `${scene.tile}|${scene.date}|${scene.platform}`;
    const held = best.get(key);
    if (!held) {
      best.set(key, scene);
      continue;
    }
    const better =
      scene.baseline !== held.baseline
        ? scene.baseline > held.baseline
        : scene.created > held.created;
    if (better) best.set(key, scene);
  }
  return [...best.values()];
}

/**
 * Scenes whose radiometry cannot be trusted to sit on one scale.
 *
 * Empty in normal operation. If it is ever not empty the caller must say so
 * rather than composite anyway, because the resulting bias is invisible in the
 * output and looks exactly like real canopy loss.
 */
export function scenesNeedingOffsetCorrection(scenes: StacScene[]): StacScene[] {
  return scenes.filter((scene) => boaOffsetCorrection(scene) !== 0);
}

export async function searchScenes(params: SearchParams): Promise<StacScene[]> {
  const body: Record<string, unknown> = {
    collections: [S2_STAC_COLLECTION],
    bbox: params.bbox,
    datetime: `${toRfc3339(params.start)}/${toRfc3339(params.end)}`,
    limit: PAGE_SIZE,
  };
  if (params.maxCloud < 100) {
    body.query = { "eo:cloud_cover": { lt: params.maxCloud } };
  }

  const collected: StacScene[] = [];
  let request: { url: string; body: unknown } | null = {
    url: EARTH_SEARCH_URL,
    body,
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
        `Earth Search returned ${response.status} ${response.statusText}. The catalogue may be briefly unavailable; try again in a moment.`,
      );
    }
    const payload = (await response.json()) as StacResponse;
    for (const feature of payload.features ?? []) {
      const scene = parseFeature(feature);
      if (scene) collected.push(scene);
    }

    // Pagination is a POST link carrying the next token in its own body.
    const next = payload.links?.find((link) => link.rel === "next");
    request =
      next?.href && next.body
        ? { url: next.href, body: next.body }
        : null;
  }

  const scenes = deduplicate(collected).sort((a, b) =>
    a.datetime.localeCompare(b.datetime),
  );
  return params.limit ? scenes.slice(0, params.limit) : scenes;
}

/**
 * One overpass, as it will be composited.
 *
 * An observation gathers every MGRS tile of a single acquisition that is
 * written on the working grid. Usually that is one tile. It is more than one
 * when an AOI spans a tile boundary inside a zone, and the tiles are then
 * mosaicked at read time so the overpass still counts once.
 */
export interface Observation {
  datatake: string;
  datetime: string;
  date: string;
  /** Worst cloud cover among the contributing tiles. */
  cloudCover: number;
  scenes: StacScene[];
}

export interface ObservationSet {
  observations: Observation[];
  /**
   * Acquisitions that exist for this AOI but have no tile on the working grid.
   *
   * Only ever non-empty when an AOI genuinely straddles a UTM zone boundary
   * far enough that one side's overpasses were never tiled into the other's
   * zone. That is the one case where choosing a working grid actually costs
   * observations, and it is worth telling the operator about. The far more
   * common near-boundary case, where every overpass is published in both
   * zones, costs nothing and is silent.
   */
  unreachable: Observation[];
}

/**
 * Fold scenes into observations on a chosen grid.
 *
 * The zone filter happens inside the fold rather than before it. Filtering
 * first would count a discarded duplicate tile as a lost overpass, which is
 * what produced a warning that eleven scenes had been dropped on an AOI where
 * nothing had in fact been lost.
 */
export function observationsOnGrid(
  scenes: StacScene[],
  epsg: number,
): ObservationSet {
  const byDatatake = new Map<string, StacScene[]>();
  for (const scene of scenes) {
    const held = byDatatake.get(scene.datatake);
    if (held) held.push(scene);
    else byDatatake.set(scene.datatake, [scene]);
  }

  const observations: Observation[] = [];
  const unreachable: Observation[] = [];

  for (const [datatake, group] of byDatatake) {
    const onGrid = group.filter((scene) => scene.epsg === epsg);
    const chosen = onGrid.length > 0 ? onGrid : group;
    const observation: Observation = {
      datatake,
      datetime: chosen[0].datetime,
      date: chosen[0].date,
      cloudCover: Math.max(...chosen.map((scene) => scene.cloudCover)),
      scenes: chosen,
    };
    if (onGrid.length > 0) observations.push(observation);
    else unreachable.push(observation);
  }

  observations.sort((a, b) => a.datetime.localeCompare(b.datetime));
  return { observations, unreachable };
}

/**
 * Group scenes by native CRS.
 *
 * Every asset of a scene is written on that scene's UTM grid. An AOI sitting
 * inside one MGRS tile yields one group; one straddling a zone boundary yields
 * two, and the caller has to decide which grid to compute on.
 */
export function groupByEpsg(scenes: StacScene[]): Map<number, StacScene[]> {
  const groups = new Map<number, StacScene[]>();
  for (const scene of scenes) {
    const held = groups.get(scene.epsg);
    if (held) held.push(scene);
    else groups.set(scene.epsg, [scene]);
  }
  return groups;
}

/**
 * The working grid that reaches the most overpasses.
 *
 * Counting scenes would be the wrong measure. Near a zone boundary every
 * overpass is published in both zones, so scene counts tie and the choice
 * falls to whichever zone the map iterated first. Counting reachable
 * observations measures the thing that matters, and the preferred zone breaks
 * the tie, so an AOI comfortably inside zone 10 is never analysed on zone 9's
 * grid merely because the catalogue listed it first.
 */
export function bestEpsgFor(
  scenes: StacScene[],
  preferred: number,
): number | null {
  let winner: number | null = null;
  let best = -1;
  for (const epsg of groupByEpsg(scenes).keys()) {
    const reachable = observationsOnGrid(scenes, epsg).observations.length;
    if (reachable > best || (reachable === best && epsg === preferred)) {
      best = reachable;
      winner = epsg;
    }
  }
  return winner;
}
