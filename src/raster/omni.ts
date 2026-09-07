import type { AssetKey } from "../stac/search";
import { NODATA, type SceneBlock } from "./cog";
import {
  fetchWithProgress,
  loadOrt,
  modelBase,
  startSession,
  type OrtModule,
  type OrtSession,
} from "./onnx";
export { modelBase, setModelBase } from "./onnx";
import {
  SclClass,
  type BlockShape,
  type CloudMask,
  type MaskOptions,
} from "./mask";

// OmniCloudMask, run in the tab.
//
// SCL is a categorical guess made band by band. This is a segmentation model
// that looks at shape and texture, which is how a person tells a cloud from a
// bright field and a cloud shadow from a north-facing slope. Measured against
// SCL on a 61 percent cloudy overpass of the Blackfeet ROI on 2024-08-27, it
// called 11.4 percent of the block cloud or shadow where SCL called it clear,
// against 0.75 percent the other way. That asymmetry is the point: SCL's
// failure is letting thin edges and shadow through into the composite, where
// they read as canopy loss.
//
// Two U-Nets, `regnety_004` and `edgenext_small`, whose logits are averaged
// before the class is taken. That is the published method rather than a choice
// made here, and it earns its second download: on the same block the two models
// disagreed on 7.9 percent of pixels, so one alone is not the same mask.
//
// Code and weights are both MIT, from DPIRD-DMA/OmniCloudMask and the Hugging
// Face repo NickWright/OmniCloudMask, converted to ONNX by scripts/export-cloud
// -model.py. The conversion was checked against the torch model it came from:
// maximum absolute difference 2e-5 on the logits and identical classes on every
// pixel of a 512 by 512 patch.
//
// The one thing it does not do is water, which has no class here, so water is
// still read from SCL exactly as before.

/** Bands the model was trained on, in the order it expects them. */
const MODEL_BANDS: AssetKey[] = ["red", "green", "nir08"];

/**
 * Near-infrared is B8A, not B08.
 *
 * OmniCloudMask's own Sentinel-2 loader reads B04, B03 and B8A, and the model
 * was trained on that combination. Substituting B08, which the analysis already
 * reads and which would cost nothing extra, was measured on the same cloudy
 * block: it kept 2.1 percent of pixels the B8A mask discards while discarding
 * only 0.28 percent it keeps. The error runs the wrong way, letting cloud
 * through, so the extra band is read.
 */
const NIR = "nir08";

/** The encoder halves the grid five times, so both edges must divide by 32. */
const STRIDE = 32;

/** Classes the model writes. Only the first means keep. */
export const OmniClass = {
  Clear: 0,
  ThickCloud: 1,
  ThinCloud: 2,
  CloudShadow: 3,
} as const;

const MODELS = ["ocm-v4-regnety", "ocm-v4-edgenext"] as const;

interface Runtime {
  ort: OrtModule;
  sessions: OrtSession[];
  /** Which execution provider actually took the graph, for the run manifest. */
  provider: string;
}

let runtime: Promise<Runtime> | null = null;

async function loadRuntime(
  report: (message: string, fraction?: number) => void,
  signal?: AbortSignal,
): Promise<Runtime> {
  const base = modelBase();
  const ort = await loadOrt();

  const sessions: OrtSession[] = [];
  let provider = "wasm";
  for (let i = 0; i < MODELS.length; i += 1) {
    const name = MODELS[i];
    const bytes = await fetchWithProgress(
      `${base}${name}.onnx`,
      (loaded, total) => {
        const mb = (loaded / 1_048_576).toFixed(0);
        const of = total ? ` of ${(total / 1_048_576).toFixed(0)}` : "";
        report(`downloading the cloud model, ${mb}${of} MB (${i + 1} of ${MODELS.length})`);
      },
      signal,
    );
    report(`starting the cloud model (${i + 1} of ${MODELS.length})`);
    const started = await startSession(ort, bytes);
    sessions.push(started.session);
    provider = started.provider;
  }

  return { ort, sessions, provider };
}

function roundUp(value: number): number {
  return Math.max(STRIDE, Math.ceil(value / STRIDE) * STRIDE);
}

/**
 * The model's own normalisation, per band and per patch.
 *
 * Transcribed from `channel_norm` in the package: subtract the mean and divide
 * by the standard deviation of the pixels that are not no-data, and leave
 * no-data at zero. It is what makes one model work across sensors and
 * processing levels, and it has a property worth stating: an additive offset
 * cancels exactly, so the +1000 DN baseline offset cannot move this mask
 * whether or not it has been corrected yet.
 */
function normaliseInto(
  destination: Float32Array,
  band: Float32Array,
  shape: BlockShape,
  padded: { width: number; height: number },
  channel: number,
): void {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < band.length; i += 1) {
    if (band[i] === NODATA) continue;
    sum += band[i];
    count += 1;
  }
  if (count === 0) return;

  const mean = sum / count;
  let variance = 0;
  for (let i = 0; i < band.length; i += 1) {
    if (band[i] === NODATA) continue;
    const d = band[i] - mean;
    variance += d * d;
  }
  const deviation = Math.sqrt(variance / count) || 1;

  const plane = channel * padded.width * padded.height;
  for (let y = 0; y < shape.height; y += 1) {
    const from = y * shape.width;
    const to = plane + y * padded.width;
    for (let x = 0; x < shape.width; x += 1) {
      const value = band[from + x];
      destination[to + x] = value === NODATA ? 0 : (value - mean) / deviation;
    }
  }
}

export const omniMask: CloudMask = {
  id: "omnicloudmask",
  label: "OmniCloudMask segmentation model",
  description:
    "A cloud and cloud-shadow segmentation model run in the browser over red, green and B8A, ensembling two U-Nets. Separates cloud shadow from terrain shade by shape rather than by class lookup, and catches thin edges SCL misses. Snow, saturated and no-data pixels are still taken from SCL. Downloads 57 MB of weights the first time it runs.",
  requiredAssets: ["green", NIR, "scl"],

  async prepare(report, signal) {
    if (!runtime) {
      runtime = loadRuntime(report, signal).catch((error) => {
        // A failed load must not poison every later run: the next attempt
        // should be allowed to try again rather than replay this rejection.
        runtime = null;
        throw error;
      });
    }
    const ready = await runtime;
    return `${this.label}, ${ready.provider}`;
  },

  async evaluate(
    block: SceneBlock,
    options: MaskOptions,
    shape: BlockShape,
  ): Promise<Uint8Array> {
    const ready = await (runtime ?? (runtime = loadRuntime(() => {})));
    const { ort, sessions } = ready;

    const padded = {
      width: roundUp(shape.width),
      height: roundUp(shape.height),
    };
    const pixels = padded.width * padded.height;
    const input = new Float32Array(3 * pixels);
    MODEL_BANDS.forEach((band, channel) => {
      normaliseInto(input, block[band], shape, padded, channel);
    });

    const tensor = new ort.Tensor("float32", input, [
      1,
      3,
      padded.height,
      padded.width,
    ]);

    // Logits averaged, then the class taken, which is the order the package
    // uses. Averaging after the argmax would be a vote between two labels and
    // would throw away how sure each model was.
    let summed: Float32Array | null = null;
    for (const session of sessions) {
      const output = await session.run({ input: tensor });
      const logits = Object.values(output)[0].data;
      if (!summed) {
        summed = Float32Array.from(logits);
      } else {
        for (let i = 0; i < summed.length; i += 1) summed[i] += logits[i];
      }
    }
    if (!summed) throw new Error("The cloud model returned no output.");

    const scl = block.scl;
    const keep = new Uint8Array(shape.width * shape.height);
    for (let y = 0; y < shape.height; y += 1) {
      for (let x = 0; x < shape.width; x += 1) {
        const here = y * padded.width + x;
        let best = 0;
        let bestValue = summed[here];
        for (let c = 1; c < 4; c += 1) {
          const value = summed[c * pixels + here];
          if (value > bestValue) {
            bestValue = value;
            best = c;
          }
        }

        // The model decides cloud and shadow. SCL still decides the three
        // things it is authoritative about and the model has no class for:
        // absent data, a saturated detector, and snow, which the model calls
        // clear because it is clear, correctly, and which the SOP still wants
        // out of a summer composite.
        const index = y * shape.width + x;
        const class_ = scl[index];
        const rejectedBySensor =
          class_ === SclClass.NoData ||
          class_ === SclClass.Saturated ||
          (options.rejectSnow && class_ === SclClass.Snow);

        keep[index] = best === OmniClass.Clear && !rejectedBySensor ? 1 : 0;
      }
    }
    return keep;
  },

  water(block: SceneBlock): Promise<Uint8Array> {
    const scl = block.scl;
    const water = new Uint8Array(scl.length);
    for (let i = 0; i < scl.length; i += 1) {
      water[i] = scl[i] === SclClass.Water ? 1 : 0;
    }
    return Promise.resolve(water);
  },
};
