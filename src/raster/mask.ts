import type { AssetKey } from "../stac/search";
import type { SceneBlock } from "./cog";
import { omniMask } from "./omni";

// Cloud, shadow and water masking.
//
// Two masks, and the choice between them is a real one. SCL is the Sen2Cor
// scene classification shipped in every L2A product: free, already being read,
// and a categorical guess made pixel by pixel, so it misses thin cloud edges,
// confuses bright bare ground with cloud, and over rugged terrain labels
// topographic shade as cast shadow. OmniCloudMask is a segmentation model run
// in the tab, which decides from shape and texture instead and separates cloud
// shadow from terrain shade; it costs a download and inference time. See
// omni.ts for what each was measured to do on the same cloudy overpass.
//
// Whichever is chosen, the composite is a median over surviving observations
// rather than a best-pixel pick: a best-pixel pick needs a continuous quality
// score to rank on, and neither of these produces one.

/** Sen2Cor scene classification classes, as written into SCL.tif. */
export enum SclClass {
  NoData = 0,
  Saturated = 1,
  CastShadow = 2,
  CloudShadow = 3,
  Vegetation = 4,
  NotVegetated = 5,
  Water = 6,
  Unclassified = 7,
  CloudMedium = 8,
  CloudHigh = 9,
  ThinCirrus = 10,
  Snow = 11,
}

export const SCL_LABELS: Record<number, string> = {
  0: "No data",
  1: "Saturated or defective",
  2: "Cast shadow",
  3: "Cloud shadow",
  4: "Vegetation",
  5: "Not vegetated",
  6: "Water",
  7: "Unclassified",
  8: "Cloud, medium probability",
  9: "Cloud, high probability",
  10: "Thin cirrus",
  11: "Snow or ice",
};

export interface MaskOptions {
  /**
   * Reject SCL class 2.
   *
   * Class 2 is cast shadow, which covers both cloud shadow the classifier
   * declined to call class 3 and ordinary topographic shade. On flat ground
   * rejecting it is free. In steep terrain it can remove most north-facing
   * slopes from every scene in the window, which is worse than the cloud it
   * avoids, so it is a switch and the run manifest records which way it was
   * set.
   */
  rejectCastShadow: boolean;
  /** Reject snow and ice, class 11. Relevant only to shoulder-season windows. */
  rejectSnow: boolean;
}

export const DEFAULT_MASK_OPTIONS: MaskOptions = {
  rejectCastShadow: true,
  rejectSnow: true,
};

/** The block's geometry, for a mask that reads shape rather than pixels. */
export interface BlockShape {
  width: number;
  height: number;
}

export interface CloudMask {
  id: string;
  label: string;
  /** Shown in the panel and written into the run manifest. */
  description: string;
  /** Assets the mask needs read for it, on top of the index bands. */
  requiredAssets: AssetKey[];
  /**
   * Fetch and start whatever the mask needs, once, before a run begins.
   *
   * Separate from `evaluate` so that a mask with a large download reports it
   * against the run's own progress line instead of stalling inside the first
   * block. Returns how the mask should be described in the run manifest, which
   * is not always its label: what a model actually ran on is decided here.
   */
  prepare?(
    report: (message: string, fraction?: number) => void,
    signal?: AbortSignal,
  ): Promise<string>;
  /**
   * Per-pixel keep flags for one scene over one block. 1 keeps the
   * observation, 0 discards it.
   */
  evaluate(
    block: SceneBlock,
    options: MaskOptions,
    shape: BlockShape,
  ): Promise<Uint8Array>;
  /**
   * Per-pixel water flags, 1 where the pixel is water.
   *
   * Earth Engine took this from JRC Global Surface Water, a multi-decadal
   * occurrence layer thresholded at 50 percent. That asset has no anonymous
   * COG equivalent, so water is now read per scene from SCL and combined
   * across the window by the caller. The two disagree on seasonal water: GSW
   * calls a pond that is present half the time water, a single scene calls it
   * water only if it was wet that day.
   */
  water(block: SceneBlock): Promise<Uint8Array>;
}

function rejectedClasses(options: MaskOptions): Set<number> {
  const rejected = new Set<number>([
    SclClass.NoData,
    SclClass.Saturated,
    SclClass.CloudShadow,
    SclClass.CloudMedium,
    SclClass.CloudHigh,
    SclClass.ThinCirrus,
  ]);
  if (options.rejectCastShadow) rejected.add(SclClass.CastShadow);
  if (options.rejectSnow) rejected.add(SclClass.Snow);
  return rejected;
}

/**
 * The SCL mask.
 *
 * Vegetation, not-vegetated, water and unclassified survive. Water survives on
 * purpose: it is masked later, at the delta stage, exactly as the SOP does, so
 * the RGB composite keeps its water for visual context.
 */
export const sclMask: CloudMask = {
  id: "scl",
  label: "Sen2Cor scene classification",
  description:
    "Rejects no-data, saturated, cloud shadow, medium and high probability cloud and thin cirrus, optionally cast shadow and snow. 20 m categorical layer, no confidence score.",
  requiredAssets: ["scl"],

  async evaluate(block: SceneBlock, options: MaskOptions): Promise<Uint8Array> {
    const scl = block.scl;
    const rejected = rejectedClasses(options);
    const keep = new Uint8Array(scl.length);
    for (let i = 0; i < scl.length; i += 1) {
      keep[i] = rejected.has(scl[i]) ? 0 : 1;
    }
    return keep;
  },

  async water(block: SceneBlock): Promise<Uint8Array> {
    const scl = block.scl;
    const water = new Uint8Array(scl.length);
    for (let i = 0; i < scl.length; i += 1) {
      water[i] = scl[i] === SclClass.Water ? 1 : 0;
    }
    return water;
  },
};

export const CLOUD_MASKS: Record<string, CloudMask> = {
  [sclMask.id]: sclMask,
  [omniMask.id]: omniMask,
};

/**
 * SCL by default, not the better mask.
 *
 * The model is better and costs 57 MB and roughly half a second of inference
 * per overpass per block. A first-time visitor opening the panel to try one
 * small area should not silently spend either. The panel offers the swap and
 * states what it costs; a run that wants it says so.
 */
export const DEFAULT_MASK_ID = sclMask.id;

/**
 * Combine per-scene water flags into one mask for the window.
 *
 * A pixel counts as water when the majority of its valid observations called it
 * water. Majority rather than any: a single misclassified scene should not
 * punch a hole through the delta, which is what `any` would do, and it should
 * not be ignored entirely, which is what `all` would do on a window where one
 * scene was cloudy over the lake.
 */
export function combineWater(
  waters: Uint8Array[],
  valid: Uint8Array[],
  length: number,
): Uint8Array {
  const wet = new Int32Array(length);
  const seen = new Int32Array(length);
  for (let s = 0; s < waters.length; s += 1) {
    const water = waters[s];
    const ok = valid[s];
    for (let i = 0; i < length; i += 1) {
      if (!ok[i]) continue;
      seen[i] += 1;
      wet[i] += water[i];
    }
  }
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = seen[i] > 0 && wet[i] * 2 > seen[i] ? 1 : 0;
  }
  return out;
}
