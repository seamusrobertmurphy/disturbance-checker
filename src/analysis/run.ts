import {
  Breaks,
  CLASS_PALETTES,
  CONTINUOUS_MAX,
  CONTINUOUS_MIN,
  CONTINUOUS_PALETTE,
  DeltaId,
  MIN_STABLE_SCENE_COUNT,
  NDMI_VIS,
  NDVI_VIS,
  RGB_VIS,
} from "../defaults";
import {
  REQUIRED_ASSETS,
  bestEpsgFor,
  observationsOnGrid,
  searchScenes,
  scenesNeedingOffsetCorrection,
  type Observation,
} from "../stac/search";
import {
  CogCache,
  readObservationsBlock,
  type SceneBlock,
} from "../raster/cog";
import { buildComposite, type CompositeBlock } from "../raster/composite";
import {
  CLOUD_MASKS,
  DEFAULT_MASK_ID,
  DEFAULT_MASK_OPTIONS,
  type MaskOptions,
} from "../raster/mask";
import {
  blocksFor,
  gridForBounds,
  pixelAreaHa,
  utmEpsgForLonLat,
  type TargetGrid,
} from "../raster/grid";
import { boundsOf, maskForBlock, rasterizeAoi } from "../raster/rasterize";
import {
  CLASS_NODATA,
  ClassCounts,
  DELTA_IDS,
  HistogramBin,
  accumulateClassCounts,
  accumulateHistogram,
  classAreasHa,
  classifyDelta,
  computeDeltas,
  emptyHistogram,
  indices,
} from "./deltas";
import {
  buildWarp,
  paintClassified,
  paintContinuous,
  paintRgb,
  toDataUrl,
  warpCoordinates,
} from "../render/paint";

// The run.
//
// One pass over the AOI in blocks. Each block reads its scenes, composites
// them, differences the indices, classifies, tallies, and paints itself into
// the output images. Nothing is held at full extent except the images, so the
// memory a run needs is set by the block size and the number of scenes, never
// by the size of the project.

export interface AoiBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * The area of interest.
 *
 * The Earth Engine implementation had a third kind, an asset id naming a
 * FeatureCollection already uploaded to Earth Engine. It has no meaning without
 * an Earth Engine account and is gone. A boundary now arrives as a file the
 * operator loads, which is how the SOP describes the step anyway.
 */
export type Aoi =
  | { kind: "rectangle"; west: number; south: number; east: number; north: number }
  | { kind: "geojson"; geometry: unknown };

export function aoiBounds(aoi: Aoi): AoiBounds | null {
  if (aoi.kind === "rectangle") {
    return {
      west: Math.min(aoi.west, aoi.east),
      south: Math.min(aoi.south, aoi.north),
      east: Math.max(aoi.west, aoi.east),
      north: Math.max(aoi.south, aoi.north),
    };
  }
  return boundsOf(aoi.geometry);
}

export interface Period {
  id: string;
  preStart: string;
  preEnd: string;
  postStart: string;
  postEnd: string;
}

export interface RunParams {
  aoi: Aoi;
  periods: Period[];
  maxCloud: number;
  maskId: string;
  maskOptions: MaskOptions;
  breaks: Record<DeltaId, Breaks>;
  signal?: AbortSignal;
  onProgress?: (message: string, fraction?: number) => void;
}

/** What a layer is, so the panel can stack them in the SOP's order. */
export type LayerRole = "rgb" | "index" | "continuous" | "classified";

export interface PaintedLayer {
  key: string;
  name: string;
  role: LayerRole;
  dataUrl: string;
  coordinates: [[number, number], [number, number], [number, number], [number, number]];
  visible: boolean;
}

export interface DeltaResult {
  id: DeltaId;
  histogram: HistogramBin[];
  areasHa: [number, number, number];
  classifiedKey: string;
  continuousKey: string;
}

export interface PeriodResult {
  periodId: string;
  preObservations: Observation[];
  postObservations: Observation[];
  /** Overpasses with no tile on the working grid, so genuinely unusable. */
  unreachable: Observation[];
  deltas: Record<DeltaId, DeltaResult>;
  layers: PaintedLayer[];
  grid: TargetGrid;
  aoiAreaHa: number;
  /** Pixels with at least one clear look in both windows. */
  observedPixels: number;
  /** Pixels whose thinner window fell below the SOP's stability floor. */
  thinPixels: number;
  warnings: string[];
}

/**
 * Block edge in pixels.
 *
 * 512 at 20 m is a 10 km square. Large enough that a typical project is one
 * block and pays for one set of COG headers, small enough that a stack of
 * twenty scenes over a very large AOI stays inside a few hundred megabytes.
 */
export const BLOCK_SIZE = 512;

function assetsFor(maskId: string) {
  const mask = CLOUD_MASKS[maskId] ?? CLOUD_MASKS[DEFAULT_MASK_ID];
  const wanted = new Set([...REQUIRED_ASSETS, ...mask.requiredAssets]);
  return { mask, assets: [...wanted] };
}

async function compositeForBlock(
  cache: CogCache,
  observations: Observation[],
  assets: ReturnType<typeof assetsFor>["assets"],
  block: ReturnType<typeof blocksFor>[number],
  mask: ReturnType<typeof assetsFor>["mask"],
  maskOptions: MaskOptions,
  signal?: AbortSignal,
): Promise<CompositeBlock> {
  const blocks: SceneBlock[] = await readObservationsBlock(
    cache,
    observations,
    assets,
    block,
    { signal },
  );
  return buildComposite({
    observations,
    blocks,
    mask,
    maskOptions,
    length: block.width * block.height,
  });
}

export async function runPeriod(
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

  report(`${period.id}: searching the catalogue`);
  const [preScenesAll, postScenesAll] = await Promise.all([
    searchScenes({
      bbox,
      start: period.preStart,
      end: period.preEnd,
      maxCloud: params.maxCloud,
      signal,
    }),
    searchScenes({
      bbox,
      start: period.postStart,
      end: period.postEnd,
      maxCloud: params.maxCloud,
      signal,
    }),
  ]);

  if (preScenesAll.length === 0 || postScenesAll.length === 0) {
    throw new Error(
      `${period.id}: the catalogue returned ${preScenesAll.length} pre-period and ${postScenesAll.length} post-period scenes. Widen the date window or raise the cloud ceiling.`,
    );
  }

  // The working grid is the UTM zone that reaches the most overpasses, with
  // the zone of the AOI centre preferred when zones tie, which they do
  // whenever an AOI sits near a boundary and every overpass is published on
  // both sides.
  const centreLon = (bbox[0] + bbox[2]) / 2;
  const centreLat = (bbox[1] + bbox[3]) / 2;
  const natural = utmEpsgForLonLat(centreLon, centreLat);
  const epsg =
    bestEpsgFor([...preScenesAll, ...postScenesAll], natural) ?? natural;
  const grid = gridForBounds(epsg, bounds);

  const pre = observationsOnGrid(preScenesAll, epsg);
  const post = observationsOnGrid(postScenesAll, epsg);
  const unreachable = [...pre.unreachable, ...post.unreachable];

  const warnings: string[] = [];
  if (unreachable.length > 0) {
    warnings.push(
      `${unreachable.length} overpass(es) exist for this area but have no tile on the working grid (EPSG:${epsg}), so they were not used. This happens when an AOI straddles a UTM zone boundary.`,
    );
  }
  const uncorrected = scenesNeedingOffsetCorrection([
    ...pre.observations.flatMap((observation) => observation.scenes),
    ...post.observations.flatMap((observation) => observation.scenes),
  ]);
  if (uncorrected.length > 0) {
    warnings.push(
      `${uncorrected.length} scene(s) still carried the +1000 DN baseline offset and were corrected before compositing.`,
    );
  }
  for (const [label, observations] of [
    ["pre", pre.observations],
    ["post", post.observations],
  ] as const) {
    if (observations.length < MIN_STABLE_SCENE_COUNT) {
      warnings.push(
        `The ${label} window kept only ${observations.length} overpass(es). The SOP puts the median's stability floor at ${MIN_STABLE_SCENE_COUNT}, and below it the composite can move with a single observation.`,
      );
    }
  }

  const { mask, assets } = assetsFor(params.maskId);
  const blocks = blocksFor(grid, BLOCK_SIZE);
  const cache = new CogCache(signal);
  const warp = buildWarp(grid);
  const pixelHa = pixelAreaHa(grid);

  // A rectangle AOI is its own bounding box, so it needs no clip. A loaded
  // boundary does, and without one every hectare reported would be a hectare
  // of the bounding box.
  const aoiMask =
    params.aoi.kind === "geojson"
      ? rasterizeAoi(params.aoi.geometry, grid)
      : null;
  if (params.aoi.kind === "geojson" && !aoiMask) {
    warnings.push(
      "The loaded boundary contained no polygon, so the whole bounding box was analysed. Hectare figures cover the box, not a parcel.",
    );
  }

  const histograms: Record<DeltaId, HistogramBin[]> = {
    dNDVI: emptyHistogram(),
    dNDMI: emptyHistogram(),
    dNBR: emptyHistogram(),
  };
  const counts: Record<DeltaId, ClassCounts> = {
    dNDVI: [0, 0, 0],
    dNDMI: [0, 0, 0],
    dNBR: [0, 0, 0],
  };

  // Full-extent result arrays. Only what the images and the tallies need.
  const total = grid.width * grid.height;
  const classified: Record<DeltaId, Uint8Array> = {
    dNDVI: new Uint8Array(total).fill(CLASS_NODATA),
    dNDMI: new Uint8Array(total).fill(CLASS_NODATA),
    dNBR: new Uint8Array(total).fill(CLASS_NODATA),
  };
  const continuous: Record<DeltaId, Float32Array> = {
    dNDVI: new Float32Array(total).fill(Number.NaN),
    dNDMI: new Float32Array(total).fill(Number.NaN),
    dNBR: new Float32Array(total).fill(Number.NaN),
  };
  const preRgb = allocateBands(total);
  const postRgb = allocateBands(total);
  const preNdvi = new Float32Array(total).fill(Number.NaN);
  const postNdvi = new Float32Array(total).fill(Number.NaN);
  const preNdmi = new Float32Array(total).fill(Number.NaN);
  const postNdmi = new Float32Array(total).fill(Number.NaN);

  let observedPixels = 0;
  let thinPixels = 0;

  for (let b = 0; b < blocks.length; b += 1) {
    const block = blocks[b];
    const fraction = b / blocks.length;
    report(
      `${period.id}: block ${b + 1} of ${blocks.length}, reading ${pre.observations.length + post.observations.length} overpasses`,
      fraction,
    );

    const [preComposite, postComposite] = await Promise.all([
      compositeForBlock(cache, pre.observations, assets, block, mask, params.maskOptions, signal),
      compositeForBlock(cache, post.observations, assets, block, mask, params.maskOptions, signal),
    ]);

    const deltas = computeDeltas(preComposite, postComposite);
    const preIdx = indices(preComposite);
    const postIdx = indices(postComposite);

    // Clip before anything is tallied, so the histogram, the class areas and
    // the observed-pixel count all describe the same polygon.
    const clip = maskForBlock(aoiMask, block, grid);
    if (clip) {
      for (const id of DELTA_IDS) {
        const delta = deltas[id];
        for (let i = 0; i < clip.length; i += 1) {
          if (!clip[i]) delta[i] = Number.NaN;
        }
      }
      for (let i = 0; i < clip.length; i += 1) {
        if (clip[i]) continue;
        preComposite.counts[i] = 0;
        postComposite.counts[i] = 0;
      }
    }

    for (const id of DELTA_IDS) {
      accumulateHistogram(histograms[id], deltas[id]);
      const blockClasses = classifyDelta(deltas[id], params.breaks[id]);
      accumulateClassCounts(counts[id], blockClasses);
      scatter(classified[id], blockClasses, block, grid);
      scatter(continuous[id], deltas[id], block, grid);
    }

    for (let i = 0; i < preComposite.length; i += 1) {
      const seen = Math.min(preComposite.counts[i], postComposite.counts[i]);
      if (seen > 0) observedPixels += 1;
      if (seen > 0 && seen < MIN_STABLE_SCENE_COUNT) thinPixels += 1;
    }

    scatter(preRgb.red, preComposite.bands.red, block, grid);
    scatter(preRgb.green, preComposite.bands.green, block, grid);
    scatter(preRgb.blue, preComposite.bands.blue, block, grid);
    scatter(postRgb.red, postComposite.bands.red, block, grid);
    scatter(postRgb.green, postComposite.bands.green, block, grid);
    scatter(postRgb.blue, postComposite.bands.blue, block, grid);
    scatter(preNdvi, preIdx.ndvi, block, grid);
    scatter(postNdvi, postIdx.ndvi, block, grid);
    scatter(preNdmi, preIdx.ndmi, block, grid);
    scatter(postNdmi, postIdx.ndmi, block, grid);
  }

  report(`${period.id}: drawing layers`, 0.95);
  const layers: PaintedLayer[] = [];
  const coordinates = warpCoordinates(warp);
  const push = (
    key: string,
    name: string,
    role: LayerRole,
    image: ReturnType<typeof paintRgb>,
    visible: boolean,
  ) => {
    layers.push({
      key,
      name,
      role,
      dataUrl: toDataUrl(image),
      coordinates,
      visible,
    });
  };

  push(
    `${period.id}-pre-rgb`,
    "Pre RGB",
    "rgb",
    paintRgb(preRgb.red, preRgb.green, preRgb.blue, RGB_VIS, warp),
    false,
  );
  push(
    `${period.id}-post-rgb`,
    "Post RGB",
    "rgb",
    paintRgb(postRgb.red, postRgb.green, postRgb.blue, RGB_VIS, warp),
    false,
  );
  push(
    `${period.id}-pre-ndvi`,
    "Pre NDVI",
    "index",
    paintContinuous(preNdvi, NDVI_VIS.palette, NDVI_VIS.min, NDVI_VIS.max, warp),
    false,
  );
  push(
    `${period.id}-post-ndvi`,
    "Post NDVI",
    "index",
    paintContinuous(postNdvi, NDVI_VIS.palette, NDVI_VIS.min, NDVI_VIS.max, warp),
    false,
  );
  push(
    `${period.id}-pre-ndmi`,
    "Pre NDMI",
    "index",
    paintContinuous(preNdmi, NDMI_VIS.palette, NDMI_VIS.min, NDMI_VIS.max, warp),
    false,
  );
  push(
    `${period.id}-post-ndmi`,
    "Post NDMI",
    "index",
    paintContinuous(postNdmi, NDMI_VIS.palette, NDMI_VIS.min, NDMI_VIS.max, warp),
    false,
  );

  const deltaResults = {} as Record<DeltaId, DeltaResult>;
  for (const id of DELTA_IDS) {
    const classifiedKey = `${period.id}-${id}-class`;
    const continuousKey = `${period.id}-${id}-cont`;
    push(
      continuousKey,
      `${id} continuous`,
      "continuous",
      paintContinuous(
        continuous[id],
        CONTINUOUS_PALETTE,
        CONTINUOUS_MIN,
        CONTINUOUS_MAX,
        warp,
      ),
      false,
    );
    push(
      classifiedKey,
      `${id} classified`,
      "classified",
      paintClassified(classified[id], CLASS_PALETTES[id], warp),
      true,
    );
    deltaResults[id] = {
      id,
      histogram: histograms[id],
      areasHa: classAreasHa(counts[id], pixelHa),
      classifiedKey,
      continuousKey,
    };
  }

  if (thinPixels > 0 && observedPixels > 0) {
    const share = (100 * thinPixels) / observedPixels;
    if (share >= 1) {
      warnings.push(
        `${share.toFixed(1)} percent of observed pixels had fewer than ${MIN_STABLE_SCENE_COUNT} clear looks in one of the two windows.`,
      );
    }
  }

  cache.clear();

  return {
    periodId: period.id,
    preObservations: pre.observations,
    postObservations: post.observations,
    unreachable,
    deltas: deltaResults,
    layers,
    grid,
    aoiAreaHa: observedPixels * pixelHa,
    observedPixels,
    thinPixels,
    warnings,
  };
}

function allocateBands(total: number) {
  return {
    red: new Float32Array(total).fill(Number.NaN),
    green: new Float32Array(total).fill(Number.NaN),
    blue: new Float32Array(total).fill(Number.NaN),
  };
}

/** Copy a block-shaped array into its place in a full-extent array. */
function scatter<T extends Uint8Array | Float32Array>(
  destination: T,
  source: T,
  block: { x: number; y: number; width: number; height: number },
  grid: TargetGrid,
): void {
  for (let row = 0; row < block.height; row += 1) {
    const from = row * block.width;
    const to = (block.y + row) * grid.width + block.x;
    destination.set(source.subarray(from, from + block.width) as never, to);
  }
}

export const DEFAULT_RUN_MASK_OPTIONS = DEFAULT_MASK_OPTIONS;
