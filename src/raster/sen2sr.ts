import {
  fetchWithProgress,
  loadOrt,
  modelBase,
  startSession,
  type OrtModule,
  type OrtSession,
} from "./onnx";

// SEN2SRLite, run in the tab.
//
// Takes the four Sentinel-2 bands recorded at 10 metres, blue B02, green B03,
// red B04 and near-infrared B08, and returns them at 2.5 metres. It is used for
// one thing only, a backdrop an operator looks at when they have zoomed into a
// flagged patch and want to see whether it is a cutblock, a road, a windthrow
// gap or a shadow. Nothing it produces reaches an index, a class area or a
// histogram, and nothing it produces is cited in a finding.
//
// Code MIT from ESAOpenSR/SEN2SR, weights from the Hugging Face repo
// tacofoundation/sen2sr, variant SEN2SRLite/NonReference_RGBN_x4, converted to
// ONNX by scripts/export-sen2sr-model.py. That script checks the conversion
// against the model ESA ships before keeping it, and the check is not a
// formality, because two operations had to be rewritten to convert at all.
//
// Why this model and not the flagship. LDSR-S2 is a latent diffusion model of
// 169 million parameters that runs a hundred sampling steps per patch and
// returns a different picture every time. Measured on an M1, one 128 pixel
// patch took 133.6 seconds and the checkpoint was 1.1 GB. SEN2SRLite is 572,336
// parameters, one forward pass, 236 KB as ONNX, and bitwise identical on rerun.
// notes/super-resolution.md carries the measurements and the reasoning.

/** Weights, beside the cloud models under the plugin's vendor directory. */
const MODEL = "sen2srlite-rgbn-x4";

/** The window the model was trained on. The graph's input shape is fixed. */
export const TILE = 128;

/** Pixels out for every pixel in. */
export const FACTOR = 4;

/**
 * Input pixels dropped from each edge of every tile.
 *
 * A convolutional network has no idea what lies beyond its input, so it invents
 * an edge, and abutting tiles that each invented their own leave a visible grid
 * of seams. Overlapping by twice this and keeping only the middle means every
 * output pixel came from a tile that could see 8 pixels, 80 metres, in every
 * direction around it. The edges of the whole image are the one place there is
 * nothing to see, so they are kept rather than left as a hole.
 */
const TRIM = 8;

/** Channel order the model expects: red, green, blue, near-infrared. */
export interface Rgbn {
  red: Float32Array;
  green: Float32Array;
  blue: Float32Array;
  nir: Float32Array;
}

export interface SharpImage {
  red: Float32Array;
  green: Float32Array;
  blue: Float32Array;
  /** 0 where no input pixel was observed, so the layer stays transparent. */
  valid: Uint8Array;
  width: number;
  height: number;
}

interface Runtime {
  ort: OrtModule;
  session: OrtSession;
  /** Which execution provider took the graph, for the run manifest. */
  provider: string;
}

let runtime: Promise<Runtime> | null = null;

async function loadRuntime(
  report: (message: string, fraction?: number) => void,
  signal?: AbortSignal,
): Promise<Runtime> {
  const ort = await loadOrt();
  const bytes = await fetchWithProgress(
    `${modelBase()}${MODEL}.onnx`,
    (loaded, total) => {
      const kb = (loaded / 1024).toFixed(0);
      const of = total ? ` of ${(total / 1024).toFixed(0)}` : "";
      report(`downloading the super-resolution model, ${kb}${of} KB`);
    },
    signal,
  );
  report("starting the super-resolution model");
  const started = await startSession(ort, bytes);
  return { ort, session: started.session, provider: started.provider };
}

/**
 * Load the model without running it, so a caller can report the provider.
 *
 * Separate from `superResolve` because the download and the session start are
 * the slow part of the first sharpen and the only part worth a progress line.
 */
export async function prepareSuperResolution(
  report: (message: string, fraction?: number) => void = () => {},
  signal?: AbortSignal,
): Promise<string> {
  if (!runtime) {
    runtime = loadRuntime(report, signal).catch((error) => {
      // A failed load must not poison every later attempt.
      runtime = null;
      throw error;
    });
  }
  return (await runtime).provider;
}

/**
 * Where the tiles start, so that the last one ends exactly on the edge.
 *
 * The stride is the trimmed width, and the final position is clamped back
 * inside the image rather than allowed to hang over it. That makes the last
 * overlap wider than the others, which costs nothing, and it means the model
 * never sees a tile padded with invented pixels along the right or bottom.
 */
function tileStarts(extent: number): number[] {
  if (extent <= TILE) return [0];
  const stride = TILE - 2 * TRIM;
  const starts: number[] = [];
  for (let at = 0; at + TILE < extent; at += stride) starts.push(at);
  starts.push(extent - TILE);
  return starts;
}

/**
 * Super-resolve a red, green, blue and near-infrared composite to 2.5 metres.
 *
 * `width` and `height` are the size of the input on a 10 metre grid, and the
 * result is four times each. Reflectance is expected in the 0 to 1 the
 * compositing already produces, with NaN where nothing was observed.
 *
 * The near-infrared band is needed even though it is never drawn. The model was
 * trained on all four together and asking it for three is asking a different
 * question from the one it can answer.
 */
export async function superResolve(
  input: Rgbn,
  width: number,
  height: number,
  report: (message: string, fraction?: number) => void = () => {},
  signal?: AbortSignal,
): Promise<SharpImage> {
  if (width < TILE || height < TILE) {
    throw new Error(
      `The model reads ${TILE} by ${TILE} pixel tiles, and this view is ${width} by ${height} on the 10 m grid. Zoom out a little.`,
    );
  }

  await prepareSuperResolution(report, signal);
  const ready = await runtime;
  if (!ready) throw new Error("The super-resolution model did not start.");
  const { ort, session } = ready;

  const outWidth = width * FACTOR;
  const outHeight = height * FACTOR;
  const out: SharpImage = {
    red: new Float32Array(outWidth * outHeight),
    green: new Float32Array(outWidth * outHeight),
    blue: new Float32Array(outWidth * outHeight),
    valid: new Uint8Array(outWidth * outHeight),
    width: outWidth,
    height: outHeight,
  };

  // The model has no no-data value, so NaN becomes zero on the way in and the
  // validity is carried separately. Zero is what the package's own example uses
  // and it is the only value the hard constraint leaves alone.
  const bands: Float32Array[] = [input.red, input.green, input.blue, input.nir];
  const tile = new Float32Array(4 * TILE * TILE);
  const plane = TILE * TILE;

  const xs = tileStarts(width);
  const ys = tileStarts(height);
  const total = xs.length * ys.length;
  let done = 0;

  for (const ty of ys) {
    for (const tx of xs) {
      signal?.throwIfAborted();
      report(
        `sharpening tile ${done + 1} of ${total}`,
        total === 0 ? 1 : done / total,
      );

      for (let c = 0; c < 4; c += 1) {
        const band = bands[c];
        const base = c * plane;
        for (let row = 0; row < TILE; row += 1) {
          const from = (ty + row) * width + tx;
          const to = base + row * TILE;
          for (let col = 0; col < TILE; col += 1) {
            const value = band[from + col];
            tile[to + col] = Number.isFinite(value) ? value : 0;
          }
        }
      }

      const tensor = new ort.Tensor("float32", tile, [1, 4, TILE, TILE]);
      const result = await session.run({ lr: tensor });
      const sr = Object.values(result)[0].data;

      // Keep only the middle of the tile, except along the outer edges of the
      // image, where there is no neighbouring tile to take those pixels from.
      const left = tx === 0 ? 0 : TRIM;
      const top = ty === 0 ? 0 : TRIM;
      const right = tx + TILE >= width ? TILE : TILE - TRIM;
      const bottom = ty + TILE >= height ? TILE : TILE - TRIM;

      const srPlane = TILE * FACTOR * TILE * FACTOR;
      for (let row = top; row < bottom; row += 1) {
        for (let col = left; col < right; col += 1) {
          // A source pixel that was never observed leaves its sixteen children
          // transparent, so a gap in the composite stays a visible gap rather
          // than becoming whatever the model painted over the zero.
          const observed = Number.isFinite(input.red[(ty + row) * width + tx + col]);
          if (!observed) continue;
          for (let sy = 0; sy < FACTOR; sy += 1) {
            const srRow = (row * FACTOR + sy) * TILE * FACTOR + col * FACTOR;
            const outRow =
              ((ty + row) * FACTOR + sy) * outWidth + (tx + col) * FACTOR;
            for (let sx = 0; sx < FACTOR; sx += 1) {
              const s = srRow + sx;
              const o = outRow + sx;
              out.red[o] = sr[s];
              out.green[o] = sr[srPlane + s];
              out.blue[o] = sr[2 * srPlane + s];
              out.valid[o] = 1;
            }
          }
        }
      }

      done += 1;
    }
  }

  report(`sharpened ${total} tiles`, 1);
  return out;
}

/** How many model passes a view of this size will cost, for a warning. */
export function tileCount(width: number, height: number): number {
  if (width < TILE || height < TILE) return 0;
  return tileStarts(width).length * tileStarts(height).length;
}
