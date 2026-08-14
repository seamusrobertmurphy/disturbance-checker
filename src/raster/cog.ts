import { fromUrl, type GeoTIFF } from "geotiff";
import type { GridBlock } from "./grid";
import type { AssetKey, Observation, StacScene } from "../stac/search";

// Reading pixels out of cloud-optimised GeoTIFFs on AWS Open Data.
//
// This is the module that replaces Earth Engine's server. There is no server
// now: the browser issues HTTP range requests against `sentinel-cogs`, which
// answers anonymously with `access-control-allow-origin: *`, and decodes the
// tiles it needs and nothing else. A 500 ha AOI pulls a few hundred kilobytes
// out of a 150 MB scene.
//
// Two properties of the COG layout do the work. Internal tiling means a small
// AOI touches few tiles, and internal overviews mean a large AOI can be served
// at reduced resolution without reading the full-resolution pixels. geotiff.js
// picks the coarsest overview that still beats the requested resolution, so the
// bytes fetched scale with the size of the answer rather than the size of the
// scene.

/** Value standing in for absent data.
 *
 * Sentinel-2 L2A COGs use 0 for no-data on the reflectance bands, and class 0
 * of SCL is NO_DATA, so one sentinel covers both. It also covers reads that
 * fall outside the scene footprint, which is what makes an AOI straddling two
 * MGRS tiles merge cleanly. */
export const NODATA = 0;

/**
 * Per-run handle cache.
 *
 * Opening a COG costs a round trip for the header and the tile index. A run
 * reads every asset of every scene once per block, so without this the header
 * traffic would dwarf the pixel traffic. Holding the handle also keeps
 * geotiff.js's own blocked-source cache alive, so byte ranges already fetched
 * for one block are reused by the next rather than requested again.
 */
export class CogCache {
  private readonly handles = new Map<string, Promise<GeoTIFF>>();

  constructor(private readonly signal?: AbortSignal) {}

  open(href: string): Promise<GeoTIFF> {
    let held = this.handles.get(href);
    if (!held) {
      held = fromUrl(href, {}, this.signal);
      this.handles.set(href, held);
    }
    return held;
  }

  clear(): void {
    this.handles.clear();
  }
}

export interface ReadOptions {
  /**
   * Resampling applied when the source resolution differs from the grid.
   *
   * Nearest throughout, deliberately. It is Earth Engine's own default, so a
   * result stays comparable with one produced by the previous implementation,
   * and it is the only defensible choice for SCL, whose values are class
   * numbers that must not be averaged into classes that do not exist.
   */
  resampleMethod?: "nearest" | "bilinear";
  signal?: AbortSignal;
}

/**
 * Read one asset of one scene into a block of the working grid.
 *
 * The block bbox is in the grid's CRS, and the grid's CRS is by construction
 * the scene's own UTM zone, so no reprojection happens here. Where an AOI
 * crosses a zone boundary the caller has already chosen one zone to work in and
 * the out-of-zone scenes are excluded, because silently warping reflectance
 * across a projection is not something a verification tool should do without
 * saying so.
 */
export async function readAssetBlock(
  cache: CogCache,
  href: string,
  block: GridBlock,
  options: ReadOptions = {},
): Promise<Float32Array> {
  const tiff = await cache.open(href);
  const result = await tiff.readRasters({
    bbox: block.bbox,
    width: block.width,
    height: block.height,
    interleave: false,
    fillValue: NODATA,
    resampleMethod: options.resampleMethod ?? "nearest",
    signal: options.signal,
  });

  const band = (result as unknown as ArrayLike<ArrayLike<number>>)[0];
  const out = new Float32Array(block.width * block.height);
  const count = Math.min(out.length, band.length);
  for (let i = 0; i < count; i += 1) out[i] = band[i];
  return out;
}

/** Every band of one scene over one block, keyed by asset. */
export type SceneBlock = Record<AssetKey, Float32Array>;

/**
 * Bound on simultaneous range requests.
 *
 * Browsers cap connections per host at six or so, and a run against a
 * twenty-scene window queues well over a hundred reads. Letting them all go at
 * once does not make them finish sooner, it only makes the progress reporting
 * useless and the abort path slow.
 */
export const READ_CONCURRENCY = 6;

async function pooled<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

/**
 * Read the requested assets of one scene over one block.
 *
 * SCL is read alongside the reflectance bands rather than first, because a
 * scene that is wholly cloudy over the AOI still has to be paid for in header
 * round trips, and the saving from an early bail is smaller than the cost of
 * serialising the reads to find out.
 */
export async function readSceneBlock(
  cache: CogCache,
  scene: StacScene,
  assets: AssetKey[],
  block: GridBlock,
  options: ReadOptions = {},
): Promise<SceneBlock> {
  const bands = await pooled(assets, READ_CONCURRENCY, (asset) =>
    readAssetBlock(cache, scene.hrefs[asset], block, options),
  );
  const out = {} as SceneBlock;
  assets.forEach((asset, index) => {
    out[asset] = bands[index];
  });
  return out;
}

/**
 * Read one observation over one block.
 *
 * An observation is usually a single tile, in which case this is a plain read.
 * Where an AOI spans a tile boundary it is several tiles of the same overpass,
 * and they are mosaicked here: the first tile with data at a pixel wins.
 *
 * First rather than last, and first rather than averaged, because the tiles
 * are cut from one continuous swath. In the overlap they hold the same
 * measurement resampled onto two grids, so there is nothing to choose between
 * them and nothing to gain by blending them.
 */
export async function readObservationBlock(
  cache: CogCache,
  observation: Observation,
  assets: AssetKey[],
  block: GridBlock,
  options: ReadOptions = {},
): Promise<SceneBlock> {
  if (observation.scenes.length === 1) {
    return readSceneBlock(cache, observation.scenes[0], assets, block, options);
  }

  const parts = await pooled(observation.scenes, 2, (scene) =>
    readSceneBlock(cache, scene, assets, block, options),
  );

  const merged = {} as SceneBlock;
  for (const asset of assets) {
    const out = new Float32Array(block.width * block.height);
    for (let i = 0; i < out.length; i += 1) {
      for (const part of parts) {
        const value = part[asset][i];
        if (value !== NODATA) {
          out[i] = value;
          break;
        }
      }
    }
    merged[asset] = out;
  }
  return merged;
}

/** Read many observations over one block, with a cap on in-flight requests. */
export async function readObservationsBlock(
  cache: CogCache,
  observations: Observation[],
  assets: AssetKey[],
  block: GridBlock,
  options: ReadOptions & { onScene?: (done: number, total: number) => void } = {},
): Promise<SceneBlock[]> {
  let done = 0;
  return pooled(
    observations,
    Math.max(1, Math.floor(READ_CONCURRENCY / 2)),
    async (observation) => {
      const result = await readObservationBlock(
        cache,
        observation,
        assets,
        block,
        options,
      );
      done += 1;
      options.onScene?.(done, observations.length);
      return result;
    },
  );
}
