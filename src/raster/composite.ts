import { S2_SCALE_DIVISOR } from "../defaults";
import {
  boaOffsetCorrection,
  type AssetKey,
  type Observation,
} from "../stac/search";
import { NODATA, type SceneBlock } from "./cog";
import type { CloudMask, MaskOptions } from "./mask";
import { combineWater } from "./mask";

// Reducing a stack of observations to one composite.
//
// Earth Engine ran qualityMosaic on the Cloud Score+ `cs` band, which keeps the
// single clearest observation per pixel and never averages. That needs a
// continuous quality score to rank on. SCL gives classes, not scores, so there
// is nothing to rank and the reduction falls back to a median over surviving
// observations, which is the SOP's own documented alternative and what the
// production scripts ran before the Cloud Score+ switch.
//
// The consequence is worth stating plainly, because it changes how the tool
// should be read. A median needs enough clear looks to be stable. The SOP puts
// that floor at four scenes, which was advisory under Cloud Score+ and is
// binding here. Every composite therefore carries its per-pixel count of
// surviving observations, so thin coverage is visible in the output rather
// than inferred from the scene list.

/**
 * The bands the indices are built from.
 *
 * NDVI needs red and nir, NDMI needs nir and swir16, NBR needs nir08 and
 * swir22. Nothing else in the SOP calculation reads a reflectance band, and an
 * observation counts as valid only if all five are present.
 */
export const INDEX_BANDS: AssetKey[] = [
  "red",
  "nir",
  "nir08",
  "swir16",
  "swir22",
];

/**
 * The extra bands the true-colour composite needs.
 *
 * Blue and green are read for a handful of the clearest observations rather
 * than for all of them. They contribute to no index, no delta, no class and no
 * area: their only consumer is the pair of RGB layers a verifier fades between
 * to confirm by eye what the numbers say. Reading them for sixteen overpasses
 * when three make a perfectly good picture is most of a fifth of a run's
 * network traffic spent on something nobody measures.
 */
export const RGB_EXTRA_BANDS: AssetKey[] = ["blue", "green"];

/** Every reflectance band the reader may be asked for. */
export const REFLECTANCE_BANDS: AssetKey[] = [
  ...INDEX_BANDS,
  ...RGB_EXTRA_BANDS,
];

/**
 * Observations whose blue and green are worth reading.
 *
 * Enough for a median to be stable against one bad look, and few enough that
 * the saving is real.
 */
export const RGB_OBSERVATION_COUNT = 3;

/** DN to reflectance, from the SOP defaults. */
export const SCALE_DIVISOR = S2_SCALE_DIVISOR;

export interface CompositeBlock {
  /** Scaled surface reflectance for the index bands, NaN where nothing
   * survived. */
  bands: Record<AssetKey, Float32Array>;
  /**
   * True colour, composited over the clearest few observations only.
   *
   * Held apart from `bands` so the difference in provenance is visible in the
   * type. All three channels come from the same subset, so the colour balance
   * is consistent; mixing a red median over sixteen looks with a blue median
   * over three would tint the picture.
   */
  rgb: { red: Float32Array; green: Float32Array; blue: Float32Array };
  /** Surviving observations per pixel. */
  counts: Uint16Array;
  /** 1 where the window's surviving observations mostly called the pixel water. */
  water: Uint8Array;
  /** Scenes that contributed at least one pixel to this block. */
  sceneCount: number;
  length: number;
}

/**
 * Median of the values held in `scratch[0..n)`.
 *
 * The even case averages the two central values, matching Earth Engine's
 * median reducer rather than taking a lower median. On a stack of four that
 * difference is not academic: it is the difference between a composite that
 * jumps when one scene is added and one that does not.
 */
function medianOf(scratch: Float32Array, n: number): number {
  if (n === 0) return Number.NaN;
  if (n === 1) return scratch[0];
  // Insertion sort. n is the number of clear looks at one pixel, typically
  // under twenty, where insertion sort beats anything with an allocation.
  for (let i = 1; i < n; i += 1) {
    const value = scratch[i];
    let j = i - 1;
    while (j >= 0 && scratch[j] > value) {
      scratch[j + 1] = scratch[j];
      j -= 1;
    }
    scratch[j + 1] = value;
  }
  const mid = n >> 1;
  return n % 2 === 1 ? scratch[mid] : (scratch[mid - 1] + scratch[mid]) / 2;
}

export interface CompositeInput {
  observations: Observation[];
  blocks: SceneBlock[];
  mask: CloudMask;
  maskOptions: MaskOptions;
  length: number;
  /** Indices into `observations` whose blocks carry blue and green. */
  rgbSubset: number[];
}

export async function buildComposite(
  input: CompositeInput,
): Promise<CompositeBlock> {
  const { observations, blocks, mask, maskOptions, length } = input;
  // Every tile of one overpass carries the same radiometry, so the correction
  // is read off whichever tile the observation was built from first.
  const offsets = observations.map((observation) =>
    boaOffsetCorrection(observation.scenes[0]),
  );

  const keeps: Uint8Array[] = [];
  const waters: Uint8Array[] = [];
  for (const block of blocks) {
    keeps.push(await mask.evaluate(block, maskOptions));
    waters.push(await mask.water(block));
  }

  // Validity is decided once per observation, not once per band.
  //
  // If each band chose its own surviving observations, NDVI could end up as a
  // red median over five looks divided into a NIR median over four, silently
  // comparing different days. Requiring every band a scene contributes to be
  // present keeps each composite a composite of whole observations.
  //
  // A zero DN is the no-data sentinel, not a dark pixel. Sen2Cor never writes
  // a genuine zero reflectance, so discarding it costs nothing and keeps
  // scene-edge fill out of the median.
  const valid: Uint8Array[] = [];
  const counts = new Uint16Array(length);
  for (let s = 0; s < blocks.length; s += 1) {
    const ok = new Uint8Array(length);
    const block = blocks[s];
    const keep = keeps[s];
    for (let i = 0; i < length; i += 1) {
      if (!keep[i]) continue;
      let complete = 1;
      for (const band of INDEX_BANDS) {
        if (block[band][i] === NODATA) {
          complete = 0;
          break;
        }
      }
      ok[i] = complete;
      counts[i] += complete;
    }
    valid.push(ok);
  }

  const scratch = new Float32Array(Math.max(1, blocks.length));

  const medianOver = (band: AssetKey, which: number[]): Float32Array => {
    const out = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      let n = 0;
      for (const s of which) {
        if (!valid[s][i]) continue;
        const value = blocks[s][band];
        if (!value) continue;
        scratch[n] = (value[i] - offsets[s]) / SCALE_DIVISOR;
        n += 1;
      }
      out[i] = medianOf(scratch, n);
    }
    return out;
  };

  const all = blocks.map((_, index) => index);
  const bands = {} as Record<AssetKey, Float32Array>;
  for (const band of INDEX_BANDS) {
    bands[band] = medianOver(band, all);
  }

  // The subset falls back to every observation that happens to carry the
  // bands, so a caller that reads blue and green for all of them still gets a
  // sensible picture rather than an empty one.
  const subset = input.rgbSubset.filter((index) => blocks[index]?.blue);
  const rgbFrom = subset.length > 0 ? subset : all.filter((i) => blocks[i]?.blue);

  return {
    bands,
    rgb: {
      red: medianOver("red", rgbFrom),
      green: medianOver("green", rgbFrom),
      blue: medianOver("blue", rgbFrom),
    },
    counts,
    water: combineWater(waters, valid, length),
    sceneCount: blocks.length,
    length,
  };
}
