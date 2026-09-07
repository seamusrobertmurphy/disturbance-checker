// The ONNX Runtime, shared by every model this tool runs in the tab.
//
// Extracted from omni.ts when a second model arrived. The two have nothing in
// common except how they are loaded, and that part is worth having once: which
// provider was asked for, in which order, and where the bytes came from are all
// decisions that must not drift between one model and the next, because the
// run manifest reports them as if they were a single fact about the run.

export interface OrtSession {
  run(
    feeds: Record<string, unknown>,
  ): Promise<Record<string, { data: Float32Array }>>;
}

export interface OrtModule {
  env: { wasm: { wasmPaths: string; numThreads: number } };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
  InferenceSession: {
    create(
      model: Uint8Array,
      options: { executionProviders: string[] },
    ): Promise<OrtSession>;
  };
}

/**
 * Where the runtime and the weights are served from.
 *
 * Resolved against the page rather than against this module, because the module
 * arrives as a blob URL: GeoLibre fetches the plugin and evaluates it through
 * `import(URL.createObjectURL(...))`, so `import.meta.url` here is a blob and
 * resolves to nothing. The plugin's own directory under the deployed app is a
 * fixed path, and the deploy workflow puts both the weights and the wasm there.
 */
let assetBase = "";

export function modelBase(): string {
  if (assetBase) return assetBase;
  const page = new URL("./", window.location.href);
  return new URL("plugins/tuvsud-disturbance-check/vendor/", page).href;
}

/** For the smoke test and for a dev server that serves these from elsewhere. */
export function setModelBase(base: string): void {
  assetBase = base;
}

let ortModule: Promise<OrtModule> | null = null;

/**
 * The runtime itself, loaded once and shared.
 *
 * Imported at runtime from the deployed path rather than bundled. The plugin is
 * built as one inlined ES module, so a bundled runtime would land in every load
 * of this app whether or not anyone asks for a model.
 */
export function loadOrt(): Promise<OrtModule> {
  if (ortModule) return ortModule;
  ortModule = (async () => {
    const base = modelBase();
    const ort = (await import(
      /* @vite-ignore */ `${base}ort.webgpu.min.mjs`
    )) as unknown as OrtModule;
    ort.env.wasm.wasmPaths = base;
    // GitHub Pages sends no cross-origin isolation headers, so SharedArrayBuffer
    // is unavailable and a threaded runtime cannot start. Saying so up front
    // avoids a worker that fails and a fallback that looks like a bug.
    ort.env.wasm.numThreads = 1;
    return ort;
  })().catch((error) => {
    // A failed load must not poison every later run: the next attempt should be
    // allowed to try again rather than replay this rejection.
    ortModule = null;
    throw error;
  });
  return ortModule;
}

/**
 * Fetch with a byte count.
 *
 * The cloud weights are 57 MB and the wasm another 26, once, on the first run
 * that asks for that mask. Without a progress line that is a minute of a panel
 * that looks hung, and the honest fix is to say what is happening rather than
 * to make the download smaller by shipping a model that is not the published
 * one.
 */
export async function fetchWithProgress(
  url: string,
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}.`);
  }
  const total = Number(response.headers.get("content-length") ?? 0);
  const reader = response.body?.getReader();
  if (!reader) {
    return new Uint8Array(await response.arrayBuffer());
  }

  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }

  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Ask for one provider at a time, WebGPU first.
 *
 * Passing `["webgpu", "wasm"]` and letting the runtime choose looks tidier and
 * is a trap: measured in Chrome 151 on the deployed build, a list containing
 * both ran at WebAssembly speed even where WebGPU worked when it was asked for
 * alone. The difference is not marginal. On one 512 block through both cloud
 * models, warm, WebGPU took 263 ms and WebAssembly 6,301 ms, so a fallback
 * taken silently is the difference between a run of minutes and a run of hours.
 *
 * Falling back is still right where WebGPU genuinely is not there. It is
 * reported rather than hidden, and the run manifest records which one ran.
 */
export async function startSession(
  ort: OrtModule,
  bytes: Uint8Array,
): Promise<{ session: OrtSession; provider: string }> {
  if ("gpu" in navigator) {
    try {
      return {
        session: await ort.InferenceSession.create(bytes, {
          executionProviders: ["webgpu"],
        }),
        provider: "webgpu",
      };
    } catch {
      // An adapter that exists but will not give a device, which happens on
      // software rasterisers and locked-down machines. WebAssembly still runs.
    }
  }
  return {
    session: await ort.InferenceSession.create(bytes, {
      executionProviders: ["wasm"],
    }),
    provider: "wasm",
  };
}
