// The Sentinel-1 radar check: canopy loss as a drop in VH backscatter.
//
// Radar sees through cloud and darkness and is not hidden by snow, which
// matters on projects harvested in winter when the ground is frozen and the
// optical check has no clear look. The VH channel, sent vertically and
// received horizontally, comes back mostly from branches and stems, so it
// falls when a stand is cut.
//
// The method is the Radar canopy loss cell of
// TUVSUD_Anew_Claybelt_RP1_DisturbanceCheck_ArcGIS.ipynb, reproduced step for
// step: the median VH of every scene in each window, in decibels, only the
// relative orbits seen in both windows, a 25 m focal mean against speckle, the
// earlier window less the later so that a positive value is loss, less the
// median of that difference over the boundary so that a change affecting the
// whole scene (a colder or wetter winter, the switch from Sentinel-1A to
// Sentinel-1C in 2025) is not read as loss, and water removed. The breaks it
// is classified on were calibrated after that median was removed, so unlike
// the optical check the shift is always taken out and is reported rather than
// offered as a switch.
//
// Two departures from the notebook, both named in the run's warnings:
// the imagery is Planetary Computer's terrain-flattened RTC product rather
// than Earth Engine's GRD, and water is masked by a backscatter floor rather
// than the JRC surface water layer, which has no anonymous copy a browser can
// read on this grid.

import {
  Breaks,
  CLASS_PALETTES,
  DELTAS,
  DeltaId,
  Sensor,
} from "../defaults";
import { CogCache, readAssetBlock } from "../raster/cog";
import {
  blocksFor,
  gridForBounds,
  pixelAreaHa,
  utmEpsgForLonLat,
  type GridBlock,
  type TargetGrid,
} from "../raster/grid";
import { rasterizeAoi } from "../raster/rasterize";
import {
  ClassCounts,
  accumulateClassCounts,
  accumulateHistogram,
  classAreasHa,
  classifyDelta,
  emptyHistogram,
  type Normalisation,
} from "./deltas";
import {
  buildWarp,
  paintClassified,
  paintContinuous,
  toDataUrl,
  warpCoordinates,
} from "../render/paint";
import {
  RadarScene,
  bestRadarEpsg,
  radarReadToken,
  sameOrbits,
  searchRadarScenes,
  signHref,
} from "../stac/radar-search";
import type { Observation } from "../stac/search";
import {
  aoiBounds,
  type PaintedLayer,
  type Period,
  type PeriodResult,
  type RunParams,
} from "./run";

/** The radar delta, the only one this run produces. */
export const RADAR_DELTA: DeltaId = "dVH";

/** Radius of the focal mean that quiets speckle, in metres, as the notebook. */
export const RADAR_SMOOTH_M = 25;

/**
 * Below this VH, in decibels, a pixel is treated as water or smooth ground.
 *
 * The notebook removes water with the JRC Global Surface Water occurrence
 * layer. Open water scatters almost nothing back to a C-band radar, so its VH
 * sits far below any forest, and a floor at -22 dB in either window takes out
 * lakes, rivers and wet flats without a second download. Bare rock and
 * tarmac go with them, which is no loss to a canopy check.
 */
export const RADAR_WATER_FLOOR_DB = -22;

/** Below this many scenes a window's median rests on too few looks. */
export const MIN_RADAR_SCENES = 3;

/** How the Pre VH and Post VH backdrops are stretched, in decibels. */
const VH_VIS = { min: -25, max: -10 };

/** The RTC nodata value, and anything at or below zero power, both become NaN. */
const RTC_NODATA = -32768;

/** Block edge in pixels, the same as the optical run. */
const BLOCK_SIZE = 512;

/** How many scenes are read at once over one block. */
const SCENE_CONCURRENCY = 6;

/** Linear gamma naught to decibels; nodata and non-positive power become NaN. */
export function toDecibels(values: Float32Array): Float32Array {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    out[i] = v === RTC_NODATA || !(v > 0) ? Number.NaN : 10 * Math.log10(v);
  }
  return out;
}

/**
 * Per-pixel median across scenes, ignoring NaN.
 *
 * The median rather than the mean, as the notebook, because a single scene
 * with a wet snowfall or a melt event would otherwise pull every pixel of the
 * window with it.
 */
export function medianStack(stack: Float32Array[], length: number): Float32Array {
  const out = new Float32Array(length).fill(Number.NaN);
  const column = new Float64Array(stack.length);
  for (let i = 0; i < length; i += 1) {
    let n = 0;
    for (const layer of stack) {
      const v = layer[i];
      if (!Number.isNaN(v)) {
        column[n] = v;
        n += 1;
      }
    }
    if (n === 0) continue;
    const values = column.subarray(0, n).sort();
    out[i] = n % 2 ? values[(n - 1) / 2] : (values[n / 2 - 1] + values[n / 2]) / 2;
  }
  return out;
}

/**
 * Circular focal mean over the whole grid, NaN-aware.
 *
 * Applied to the full extent after every block has been read, so a block edge
 * carries no seam. The radius is the notebook's 25 m in pixels, never less
 * than the diagonal neighbour, so at 20 m it is the eight neighbours and the
 * centre, a 60 m square, the nearest this grid comes to a 25 m circle. A
 * pixel with no value stays empty rather than being filled from its
 * neighbours.
 */
export function focalMean(
  values: Float32Array,
  width: number,
  height: number,
  radiusPixels: number,
): Float32Array {
  const r = Math.max(1, Math.ceil(radiusPixels));
  const offsets: Array<[number, number]> = [];
  for (let dy = -r; dy <= r; dy += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      if (dx * dx + dy * dy <= radiusPixels * radiusPixels + 1e-9 || (dx === 0 && dy === 0)) {
        offsets.push([dx, dy]);
      }
    }
  }
  const out = new Float32Array(values.length).fill(Number.NaN);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let n = 0;
      for (const [dx, dy] of offsets) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
        const v = values[yy * width + xx];
        if (Number.isNaN(v)) continue;
        sum += v;
        n += 1;
      }
      if (n > 0 && !Number.isNaN(values[y * width + x])) out[y * width + x] = sum / n;
    }
  }
  return out;
}

/** Median of the finite values, or NaN when there are none. */
export function medianOf(values: Float32Array): number {
  const finite = Array.from(values).filter((v) => !Number.isNaN(v)).sort((a, b) => a - b);
  const n = finite.length;
  if (n === 0) return Number.NaN;
  return n % 2 ? finite[(n - 1) / 2] : (finite[n / 2 - 1] + finite[n / 2]) / 2;
}

function scatter(
  destination: Float32Array,
  source: Float32Array,
  block: GridBlock,
  grid: TargetGrid,
): void {
  for (let row = 0; row < block.height; row += 1) {
    const from = row * block.width;
    const to = (block.y + row) * grid.width + block.x;
    destination.set(source.subarray(from, from + block.width), to);
  }
}

async function pooled<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index]);
      }
    }),
  );
  return results;
}

/** A radar scene presented as the overpass the panel and manifest list. */
function asObservation(scene: RadarScene): Observation {
  return {
    datatake: scene.id,
    datetime: scene.datetime,
    date: scene.date,
    cloudCover: 0,
    scenes: [],
  };
}

/**
 * Read every scene of one window over one block and take the per-pixel median
 * of their VH in decibels.
 */
async function windowMedianBlock(
  cache: CogCache,
  scenes: RadarScene[],
  token: string,
  block: GridBlock,
  signal: AbortSignal | undefined,
): Promise<Float32Array> {
  const stack = await pooled(scenes, SCENE_CONCURRENCY, async (scene) =>
    toDecibels(
      await readAssetBlock(cache, signHref(scene.vhHref, token), block, {
        resampleMethod: "bilinear",
        signal,
      }),
    ),
  );
  return medianStack(stack, block.width * block.height);
}

export async function runRadarPeriod(
  period: Period,
  params: RunParams,
): Promise<PeriodResult> {
  const { signal } = params;
  const report = params.onProgress ?? (() => {});
  const bounds = aoiBounds(params.aoi);
  if (!bounds) {
    throw new Error(
      "The area of interest encloses no area. Draw a rectangle or load a boundary with at least one polygon.",
    );
  }
  const bbox: [number, number, number, number] = [
    bounds.west,
    bounds.south,
    bounds.east,
    bounds.north,
  ];

  report(`${period.id}: searching the radar catalogue`);
  const [preAll, postAll] = await Promise.all([
    searchRadarScenes({ bbox, start: period.preStart, end: period.preEnd, signal }),
    searchRadarScenes({ bbox, start: period.postStart, end: period.postEnd, signal }),
  ]);
  if (preAll.length === 0 || postAll.length === 0) {
    throw new Error(
      `${period.id}: Planetary Computer returned ${preAll.length} pre-period and ${postAll.length} post-period radar scenes. Widen the date window.`,
    );
  }

  const matched = sameOrbits(preAll, postAll);
  if (matched.orbits.length === 0) {
    throw new Error(
      `${period.id}: no relative orbit imaged the boundary in both windows (pre orbits ${[...new Set(preAll.map((s) => s.orbit))].join(", ")}, post orbits ${[...new Set(postAll.map((s) => s.orbit))].join(", ")}). Widen one window until an orbit appears in both.`,
    );
  }

  const centreLon = (bounds.west + bounds.east) / 2;
  const centreLat = (bounds.south + bounds.north) / 2;
  const natural = utmEpsgForLonLat(centreLon, centreLat);
  const epsg = bestRadarEpsg([...matched.pre, ...matched.post], natural) ?? natural;
  const grid = gridForBounds(epsg, bounds);
  const pre = matched.pre.filter((scene) => scene.epsg === epsg);
  const post = matched.post.filter((scene) => scene.epsg === epsg);
  const dropped =
    preAll.length + postAll.length - pre.length - post.length;

  const warnings: string[] = [];
  if (pre.length === 0 || post.length === 0) {
    throw new Error(
      `${period.id}: the matched radar scenes sit on another UTM zone than the working grid. Move or shrink the boundary away from the zone edge.`,
    );
  }
  const passes = [...new Set([...pre, ...post].map((scene) => scene.pass))].sort();
  warnings.push(
    `${period.id}: relative orbit${matched.orbits.length > 1 ? "s" : ""} ${matched.orbits.join(", ")} (${passes.join(", ")}), ${pre.length} radar scene${pre.length === 1 ? "" : "s"} ${period.preStart} to ${period.preEnd}, ${post.length} ${period.postStart} to ${period.postEnd}.`,
  );
  if (dropped > 0) {
    warnings.push(
      `${period.id}: ${dropped} radar scene${dropped === 1 ? "" : "s"} dropped, on an orbit seen in only one window or on another UTM zone.`,
    );
  }
  if (pre.length < MIN_RADAR_SCENES || post.length < MIN_RADAR_SCENES) {
    warnings.push(
      `${period.id}: a window holds fewer than ${MIN_RADAR_SCENES} radar scenes, so its median rests on few looks and speckle will survive the smoothing. Widen the window if the dates allow.`,
    );
  }
  warnings.push(
    `${period.id}: the imagery is Planetary Computer's terrain-flattened RTC product rather than the GRD the breaks were calibrated on, and water is masked where VH falls below ${RADAR_WATER_FLOOR_DB} dB in either window rather than from JRC Global Surface Water.`,
  );

  report(`${period.id}: fetching the read token`);
  const token = await radarReadToken(signal);

  const blocks = blocksFor(grid, BLOCK_SIZE);
  const cache = new CogCache(signal);
  const warp = buildWarp(grid);
  const pixelHa = pixelAreaHa(grid);
  const aoiMask =
    params.aoi.kind === "geojson" ? rasterizeAoi(params.aoi.geometry, grid) : null;
  if (params.aoi.kind === "geojson" && !aoiMask) {
    warnings.push(
      "The loaded boundary contained no polygon, so the whole bounding box was analysed. Hectare figures cover the box, not a parcel.",
    );
  }

  const total = grid.width * grid.height;
  const preDb = new Float32Array(total).fill(Number.NaN);
  const postDb = new Float32Array(total).fill(Number.NaN);

  for (let b = 0; b < blocks.length; b += 1) {
    const block = blocks[b];
    report(
      `${period.id}: block ${b + 1} of ${blocks.length}, reading ${pre.length + post.length} radar scenes`,
      b / blocks.length,
    );
    const [preMedian, postMedian] = await Promise.all([
      windowMedianBlock(cache, pre, token, block, signal),
      windowMedianBlock(cache, post, token, block, signal),
    ]);
    scatter(preDb, preMedian, block, grid);
    scatter(postDb, postMedian, block, grid);
  }
  cache.clear();

  report(`${period.id}: smoothing and classifying`, 0.9);
  const radius = Math.max(RADAR_SMOOTH_M / grid.resolution, Math.SQRT2);
  const preSmooth = focalMean(preDb, grid.width, grid.height, radius);
  const postSmooth = focalMean(postDb, grid.width, grid.height, radius);

  const drop = new Float32Array(total);
  let observedPixels = 0;
  for (let i = 0; i < total; i += 1) {
    const a = preSmooth[i];
    const c = postSmooth[i];
    const outside = aoiMask ? aoiMask[i] === 0 : false;
    const wet = a < RADAR_WATER_FLOOR_DB || c < RADAR_WATER_FLOOR_DB;
    if (outside || wet || Number.isNaN(a) || Number.isNaN(c)) {
      drop[i] = Number.NaN;
      continue;
    }
    drop[i] = a - c;
    observedPixels += 1;
  }

  // The median drop over the boundary, always removed, because the breaks
  // were set on ground that had this taken out.
  const shift = medianOf(drop);
  const shiftDb = Number.isNaN(shift) ? 0 : shift;
  for (let i = 0; i < total; i += 1) drop[i] -= shiftDb;

  const breaks: Breaks = params.breaks[RADAR_DELTA];
  const histogram = emptyHistogram(RADAR_DELTA);
  accumulateHistogram(histogram, drop);
  const classified = classifyDelta(drop, breaks);
  const counts: ClassCounts = [0, 0, 0];
  accumulateClassCounts(counts, classified);

  const layers: PaintedLayer[] = [];
  const coordinates = warpCoordinates(warp);
  const grey = ["#000000", "#ffffff"];
  layers.push({
    key: `${period.id}-pre-rgb`,
    name: "Pre VH",
    role: "rgb",
    dataUrl: toDataUrl(paintContinuous(preSmooth, grey, VH_VIS.min, VH_VIS.max, warp)),
    coordinates,
    visible: false,
  });
  layers.push({
    key: `${period.id}-post-rgb`,
    name: "Post VH",
    role: "rgb",
    dataUrl: toDataUrl(paintContinuous(postSmooth, grey, VH_VIS.min, VH_VIS.max, warp)),
    coordinates,
    visible: false,
  });
  const classifiedKey = `${period.id}-${RADAR_DELTA}-class`;
  layers.push({
    key: classifiedKey,
    name: `${RADAR_DELTA} classified`,
    role: "classified",
    dataUrl: toDataUrl(paintClassified(classified, CLASS_PALETTES[RADAR_DELTA], warp)),
    coordinates,
    visible: true,
  });

  const normalisation: Normalisation = {
    offset: shiftDb,
    stableShare: 1,
    applicable: true,
    refusal: null,
    method: "median",
  };

  return {
    periodId: period.id,
    sensor: "sentinel-1" as Sensor,
    preObservations: pre.map(asObservation),
    postObservations: post.map(asObservation),
    unreachable: [],
    deltas: {
      [RADAR_DELTA]: {
        id: RADAR_DELTA,
        histogram,
        areasHa: classAreasHa(counts, pixelHa),
        classifiedKey,
      },
    },
    layers,
    grid,
    normalisation: { [RADAR_DELTA]: normalisation },
    breaksUsed: { [RADAR_DELTA]: breaks },
    radar: {
      orbits: matched.orbits,
      passes,
      preScenes: pre.length,
      postScenes: post.length,
      dropped,
      shiftDb,
    },
    aoiAreaHa: observedPixels * pixelHa,
    observedPixels,
    thinPixels: 0,
    maskDescription: `${DELTAS[RADAR_DELTA].label}, water below ${RADAR_WATER_FLOOR_DB} dB masked, ${RADAR_SMOOTH_M} m focal mean`,
    atmosphere: null,
    warnings,
  };
}
