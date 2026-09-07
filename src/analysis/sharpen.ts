import { RGB_VIS } from "../defaults";
import { CogCache } from "../raster/cog";
import {
  blocksFor,
  gridForBounds,
  type TargetGrid,
} from "../raster/grid";
import type { MaskOptions } from "../raster/mask";
import {
  TILE,
  prepareSuperResolution,
  superResolve,
  tileCount,
  type Rgbn,
  type SharpImage,
} from "../raster/sen2sr";
import {
  buildWarp,
  paintRgb,
  toDataUrl,
  warpCoordinates,
  type Warp,
} from "../render/paint";
import type { Observation } from "../stac/search";
import { assetsFor, compositeForBlock } from "./run";

// A 2.5 metre true-colour backdrop over whatever the operator is looking at.
//
// This is a second, separate pass over the same imagery the run already used,
// and it exists because the run's own layers cannot answer the question it
// answers. The analysis works on a 20 metre grid, which is the SOP's scale and
// the native resolution of B11, B12 and SCL, so every layer it paints is 20
// metres however far the map is zoomed in. That is the right grid for counting
// hectares and the wrong one for deciding whether a High severity patch is a
// cutblock, a road, a windthrow gap or a shadow.
//
// Nothing here feeds a number. The indices, the classification, the histogram
// and the class areas are untouched, and this layer is not cited in a finding.
// It is a picture, and the run manifest does not mention it, deliberately. A
// manifest is built from the state a run was carried out with, and a backdrop
// asked for afterwards over a view the operator happened to be looking at is
// not part of that state and is not persisted with it.

/** Metres per pixel the model reads. Not the analysis scale, deliberately. */
const SOURCE_SCALE = 10;

/** Metres per pixel the model writes. */
export const SHARP_SCALE = 2.5;

/**
 * Widest output the browser is asked to hold as one texture.
 *
 * The result layers cap at 2048 because they cover a whole project and a
 * bigger image would buy nothing on screen. This one covers a view the operator
 * has already zoomed into, so the cap is raised to the next power of two that
 * every current desktop GPU accepts. At 2.5 metres that is 10.24 km across,
 * which is 10,486 hectares or 25,912 acres, painted one to one.
 */
const MAX_OUTPUT = 4096;

/** The same limit expressed on the grid the model reads. */
const MAX_SOURCE = MAX_OUTPUT / (SOURCE_SCALE / SHARP_SCALE);

/** Blocks of the fetch, matching the run's own. */
const BLOCK = 512;

export interface SharpenRequest {
  /** The map's current view, or any box the operator chose. */
  bounds: { west: number; south: number; east: number; north: number };
  /** The working grid of the run, for its UTM zone. Nothing else is taken. */
  grid: TargetGrid;
  /** One window's overpasses, as the run already selected them. */
  observations: Observation[];
  maskId: string;
  maskOptions: MaskOptions;
  onProgress?: (message: string, fraction: number) => void;
  signal?: AbortSignal;
}

export interface SharpenResult {
  dataUrl: string;
  coordinates: [
    [number, number],
    [number, number],
    [number, number],
    [number, number],
  ];
  /** Metres per pixel of what was actually painted, after any warp scaling. */
  paintedScale: number;
  tiles: number;
  provider: string;
  /** Pixels the model wrote, before the warp to lon/lat. */
  width: number;
  height: number;
}

/**
 * Whether a view is a sensible thing to sharpen, and why not when it is not.
 *
 * Asked before the work starts so the operator is told to zoom rather than left
 * watching a progress bar that was never going to finish usefully.
 */
export function sharpenability(
  bounds: SharpenRequest["bounds"],
  grid: TargetGrid,
): { ok: true; tiles: number } | { ok: false; reason: string } {
  const source = gridForBounds(grid.epsg, bounds, SOURCE_SCALE);
  if (source.width < TILE || source.height < TILE) {
    return {
      ok: false,
      reason: `The model reads ${TILE} by ${TILE} pixel tiles at ${SOURCE_SCALE} m, so a view has to be at least ${(TILE * SOURCE_SCALE) / 1000} km across. This one is ${((Math.min(source.width, source.height) * SOURCE_SCALE) / 1000).toFixed(2)} km. Zoom out a little.`,
    };
  }
  if (source.width > MAX_SOURCE || source.height > MAX_SOURCE) {
    const km = ((Math.max(source.width, source.height) * SOURCE_SCALE) / 1000).toFixed(1);
    return {
      ok: false,
      reason: `At ${SHARP_SCALE} m this view would be ${Math.max(source.width, source.height) * 4} pixels across, past the ${MAX_OUTPUT} the browser will hold as one texture. The view is ${km} km wide and the limit is ${(MAX_SOURCE * SOURCE_SCALE) / 1000} km. Zoom in.`,
    };
  }
  return { ok: true, tiles: tileCount(source.width, source.height) };
}

/**
 * Composite red, green, blue and near-infrared over one grid.
 *
 * The same machinery the run uses, pointed at a finer grid over a smaller area.
 * The mask runs again, because a cloud decision made on 20 metre pixels does
 * not transfer to 10 metre ones, and the three least cloudy overpasses are
 * chosen again for the same reason the run chooses them.
 */
async function compositeRgbn(
  grid: TargetGrid,
  request: SharpenRequest,
  report: (message: string, fraction: number) => void,
): Promise<Rgbn> {
  const { mask, assets } = assetsFor(request.maskId);
  if (mask.prepare) {
    await mask.prepare(
      (message) => report(message, 0),
      request.signal,
    );
  }

  const total = grid.width * grid.height;
  const out: Rgbn = {
    red: new Float32Array(total).fill(Number.NaN),
    green: new Float32Array(total).fill(Number.NaN),
    blue: new Float32Array(total).fill(Number.NaN),
    nir: new Float32Array(total).fill(Number.NaN),
  };

  const cache = new CogCache(request.signal);
  const blocks = blocksFor(grid, BLOCK);
  for (let b = 0; b < blocks.length; b += 1) {
    const block = blocks[b];
    report(
      `reading block ${b + 1} of ${blocks.length} at ${SOURCE_SCALE} m`,
      (0.6 * b) / blocks.length,
    );
    const composite = await compositeForBlock(
      cache,
      request.observations,
      assets,
      block,
      mask,
      request.maskOptions,
      request.signal,
    );
    scatter(out.red, composite.rgb.red, block, grid);
    scatter(out.green, composite.rgb.green, block, grid);
    scatter(out.blue, composite.rgb.blue, block, grid);
    scatter(out.nir, composite.bands.nir, block, grid);
  }
  cache.clear();
  return out;
}

function scatter(
  destination: Float32Array,
  source: Float32Array,
  block: { x: number; y: number; width: number; height: number },
  grid: TargetGrid,
): void {
  for (let row = 0; row < block.height; row += 1) {
    const from = row * block.width;
    destination.set(
      source.subarray(from, from + block.width),
      (block.y + row) * grid.width + block.x,
    );
  }
}

/**
 * Paint the sharpened bands, keeping the unobserved pixels transparent.
 *
 * `paintRgb` in render/paint.ts would do this, except that it reads no-data as
 * NaN and the model writes finite numbers everywhere. The validity mask the
 * model carried alongside its output is what decides transparency here.
 */
function paintSharp(image: SharpImage, warp: Warp) {
  const stretched: Float32Array[] = [image.red, image.green, image.blue].map(
    (band) => {
      const copy = new Float32Array(band.length);
      for (let i = 0; i < band.length; i += 1) {
        copy[i] = image.valid[i] ? band[i] : Number.NaN;
      }
      return copy;
    },
  );
  return paintRgb(stretched[0], stretched[1], stretched[2], RGB_VIS, warp);
}

/**
 * Build the backdrop.
 *
 * Reported in three parts, because they have very different costs and an
 * operator watching one bar should be able to tell reading from inference.
 * Measured on 2026-09-06 in Chrome on an M1, a 2,108 pixel view over eight
 * overpasses took 30.4 seconds, of which about 28 were reading imagery and 1.8
 * were the model, at 73.4 ms per tile once the graph was warm. Carried to a
 * full 4,096 pixel view that is roughly two minutes of reading and under ten
 * seconds of model.
 */
export async function sharpenView(
  request: SharpenRequest,
): Promise<SharpenResult> {
  const report = request.onProgress ?? (() => {});
  const check = sharpenability(request.bounds, request.grid);
  if (!check.ok) throw new Error(check.reason);

  const source = gridForBounds(request.grid.epsg, request.bounds, SOURCE_SCALE);
  const bands = await compositeRgbn(source, request, report);

  const provider = await prepareSuperResolution(
    (message) => report(message, 0.6),
    request.signal,
  );
  const sharp = await superResolve(
    bands,
    source.width,
    source.height,
    (message, fraction) => report(message, 0.6 + 0.35 * (fraction ?? 0)),
    request.signal,
  );

  // The model's output on the same ground, four times finer. Everything the
  // warp needs is the resolution and the origin, both of which divide exactly.
  const target: TargetGrid = {
    epsg: source.epsg,
    originX: source.originX,
    originY: source.originY,
    resolution: SHARP_SCALE,
    width: sharp.width,
    height: sharp.height,
  };

  report("drawing the sharpened backdrop", 0.97);
  const warp = buildWarp(target, MAX_OUTPUT);
  const painted = paintSharp(sharp, warp);

  const paintedScale =
    (target.width * SHARP_SCALE) / Math.max(1, warp.width);

  return {
    dataUrl: toDataUrl(painted),
    coordinates: warpCoordinates(warp),
    paintedScale,
    tiles: check.tiles,
    provider,
    width: sharp.width,
    height: sharp.height,
  };
}
