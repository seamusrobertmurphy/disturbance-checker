import type { AssetKey } from "../stac/search";
import type { SceneBlock } from "./cog";

// Cloud, shadow and water masking.
//
// This is the weakest part of the browser rebuild and the part most worth
// replacing, so it is an interface rather than a branch. Earth Engine offered
// Cloud Score+, a continuous per-pixel clarity score produced by a model
// Google runs over the whole archive. Nothing equivalent is published as a
// cloud-optimised GeoTIFF. The only quality layer reachable anonymously from a
// browser is SCL, the Sen2Cor scene classification, at 20 m.
//
// SCL is a categorical guess, not a probability. It misses thin cloud edges,
// it confuses bright bare ground with cloud, and over rugged terrain it labels
// topographic shade as cast shadow. The composite is therefore built from a
// median over surviving observations rather than a best-pixel pick, because a
// best-pixel pick needs a quality score to rank on and there is none.
//
// The obvious upgrade is a segmentation model run in the tab. Models such as
// OmniCloudMask need only red, green and NIR at 10 m, which are already being
// fetched, and export to ONNX for onnxruntime-web. `evaluate` is async and
// takes the whole scene block precisely so such a model can be dropped in
// behind this interface without any caller changing.

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

export interface CloudMask {
  id: string;
  label: string;
  /** Shown in the panel and written into the run manifest. */
  description: string;
  /** Assets the mask needs read for it, on top of the index bands. */
  requiredAssets: AssetKey[];
  /**
   * Per-pixel keep flags for one scene over one block. 1 keeps the
   * observation, 0 discards it.
   */
  evaluate(block: SceneBlock, options: MaskOptions): Promise<Uint8Array>;
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
};

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
