import {
  Breaks,
  DELTAS,
  DeltaId,
  HISTOGRAM_MAX,
  HISTOGRAM_MIN,
  HISTOGRAM_STEPS,
} from "../defaults";
import type { CompositeBlock } from "../raster/composite";

// The SOP arithmetic, unchanged.
//
// Everything above this file was rebuilt because Earth Engine was doing it.
// Nothing in this file was: the index definitions, the sign conventions and the
// break points are the SOP's, and they are reproduced here exactly as they were
// expressed in ee calls. If a number changes between the old tool and the new
// one, the cause is upstream, in which observations survived masking and how
// they were reduced, never here.

/** Marks a classified pixel with no valid delta. */
export const CLASS_NODATA = 255;

export interface Indices {
  ndvi: Float32Array;
  ndmi: Float32Array;
  nbr: Float32Array;
}

function normalizedDifference(
  a: Float32Array,
  b: Float32Array,
): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i += 1) {
    const sum = a[i] + b[i];
    // NaN propagates from the composite wherever no observation survived, and
    // a zero sum would be a division by zero on a pixel that is black in both
    // bands. Both end as NaN, which every downstream step already treats as
    // absent.
    out[i] = sum === 0 ? Number.NaN : (a[i] - b[i]) / sum;
  }
  return out;
}

/**
 * SOP Step 5 index definitions.
 *
 * NDVI uses B8 and B4, NDMI uses B8 and B11, NBR uses B8A and B12. NBR taking
 * the narrow near-infrared B8A rather than B8 is deliberate and matches both
 * production scripts: B8A and B12 share a 20 m grid, so the ratio is formed
 * from two bands sampled the same way.
 */
export function indices(composite: CompositeBlock): Indices {
  const { bands } = composite;
  return {
    ndvi: normalizedDifference(bands.nir, bands.red),
    ndmi: normalizedDifference(bands.nir, bands.swir16),
    nbr: normalizedDifference(bands.nir08, bands.swir22),
  };
}

/**
 * SOP Step 5 sign convention.
 *
 * dNDVI and dNDMI are pre minus post, so a positive value is loss. dNBR is post
 * minus pre, so a positive value is burn, matching MTBS and USFS Region 6.
 *
 * SOP Step 4 puts the water mask here rather than on the composite, so the RGB
 * layers keep their water for visual context while no delta is ever computed
 * over it.
 */
export function computeDeltas(
  pre: CompositeBlock,
  post: CompositeBlock,
): Record<DeltaId, Float32Array> {
  const preIdx = indices(pre);
  const postIdx = indices(post);
  const length = pre.length;

  const dNDVI = new Float32Array(length);
  const dNDMI = new Float32Array(length);
  const dNBR = new Float32Array(length);

  for (let i = 0; i < length; i += 1) {
    // Water in either window masks the pixel in both. A pixel that was lake in
    // the pre window and mudflat in the post window is a water-level change,
    // not canopy loss, and the SOP excludes it.
    const wet = pre.water[i] === 1 || post.water[i] === 1;
    if (wet) {
      dNDVI[i] = Number.NaN;
      dNDMI[i] = Number.NaN;
      dNBR[i] = Number.NaN;
      continue;
    }
    dNDVI[i] = preIdx.ndvi[i] - postIdx.ndvi[i];
    dNDMI[i] = preIdx.ndmi[i] - postIdx.ndmi[i];
    dNBR[i] = postIdx.nbr[i] - preIdx.nbr[i];
  }

  return { dNDVI, dNDMI, dNBR };
}

/**
 * SOP Step 7 classification. 0 undisturbed, 1 Low, 2 Moderate, 3 High.
 *
 * The thresholds are applied in ascending order and the highest match wins,
 * reproducing the chained `where` calls of the Earth Engine implementation.
 */
export function classifyDelta(
  delta: Float32Array,
  breaks: Breaks,
): Uint8Array {
  const out = new Uint8Array(delta.length);
  for (let i = 0; i < delta.length; i += 1) {
    const value = delta[i];
    if (Number.isNaN(value)) {
      out[i] = CLASS_NODATA;
      continue;
    }
    if (value >= breaks.high) out[i] = 3;
    else if (value >= breaks.moderate) out[i] = 2;
    else if (value >= breaks.low) out[i] = 1;
    else out[i] = 0;
  }
  return out;
}

export interface HistogramBin {
  start: number;
  count: number;
}

/** Empty bins matching the SOP's fixedHistogram(-0.5, 0.8, 130). */
export function emptyHistogram(): HistogramBin[] {
  const width = (HISTOGRAM_MAX - HISTOGRAM_MIN) / HISTOGRAM_STEPS;
  return Array.from({ length: HISTOGRAM_STEPS }, (_, index) => ({
    start: HISTOGRAM_MIN + index * width,
    count: 0,
  }));
}

/**
 * Accumulate a block of delta values into a running histogram.
 *
 * Values outside the fixed range are dropped rather than piled into the end
 * bins, which is what Earth Engine's fixedHistogram does. The SOP reads the
 * shape of this curve to justify moving a break, so a spike at the edge that
 * was really an overflow would be actively misleading.
 */
export function accumulateHistogram(
  bins: HistogramBin[],
  delta: Float32Array,
): void {
  const width = (HISTOGRAM_MAX - HISTOGRAM_MIN) / HISTOGRAM_STEPS;
  for (let i = 0; i < delta.length; i += 1) {
    const value = delta[i];
    if (Number.isNaN(value)) continue;
    if (value < HISTOGRAM_MIN || value >= HISTOGRAM_MAX) continue;
    const index = Math.floor((value - HISTOGRAM_MIN) / width);
    if (index >= 0 && index < bins.length) bins[index].count += 1;
  }
}

/** Running pixel tallies per class, index 0 = Low, 1 = Moderate, 2 = High. */
export type ClassCounts = [number, number, number];

export function accumulateClassCounts(
  counts: ClassCounts,
  classified: Uint8Array,
): void {
  for (let i = 0; i < classified.length; i += 1) {
    const value = classified[i];
    if (value >= 1 && value <= 3) counts[value - 1] += 1;
  }
}

/**
 * Hectares per class.
 *
 * A multiplication, because the working grid is metric and every pixel is the
 * same size. Earth Engine needed ee.Image.pixelArea, an explicit UTM
 * projection and a maxPixels ceiling to answer this, and the SOP records that
 * the default ceiling truncated large ROIs silently. There is nothing left
 * here to truncate.
 */
export function classAreasHa(
  counts: ClassCounts,
  pixelHa: number,
): [number, number, number] {
  return [counts[0] * pixelHa, counts[1] * pixelHa, counts[2] * pixelHa];
}

/** Delta ids in the order the panel presents them. */
export const DELTA_IDS = Object.keys(DELTAS) as DeltaId[];
