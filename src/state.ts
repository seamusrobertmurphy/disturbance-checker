import {
  Breaks,
  DELTAS,
  DeltaId,
  DEFAULT_MAX_CLOUD,
  DEFAULT_WINDOW_END_MONTH_DAY,
  DEFAULT_WINDOW_START_MONTH_DAY,
} from "./defaults";
import { Diagnostic, HistogramAnalysis } from "./diagnostics";
import { Aoi, Period, PeriodResult } from "./analysis/run";
import {
  DEFAULT_MASK_ID,
  DEFAULT_MASK_OPTIONS,
  type MaskOptions,
} from "./raster/mask";
import type { Look } from "./reference/wayback";
import type { FireEvidence, IdsSummary } from "./reference/corroborate";
import type { ManagementSummary } from "./reference/management";

export type RunStatus =
  | "idle"
  | "running"
  | "complete"
  | "stale"
  | "error";

export type ContextRole = "boundary" | "smz" | "plots";

export interface ContextLayer {
  /** Original file name, so the operator can see what they loaded. */
  name: string;
  featureCount: number;
  fields: string[];
  /** Field whose value is drawn next to each point. Only used for plots. */
  labelField: string | null;
  geometryKinds: string[];
  bounds: [number, number, number, number] | null;
  geojson: unknown;
}

export interface State {
  aoi: Aoi | null;
  aoiLabel: string;
  periods: Period[];
  maxCloud: number;
  /** Which cloud mask is in force. Only the SCL mask exists today. */
  maskId: string;
  maskOptions: MaskOptions;

  context: Record<ContextRole, ContextLayer | null>;

  breaks: Record<DeltaId, Breaks>;
  justifications: Record<DeltaId, string>;

  status: RunStatus;
  progress: string;
  error: string | null;

  runStartedAt: number | null;
  results: PeriodResult[];
  analyses: Record<string, Record<DeltaId, HistogramAnalysis>>;
  diagnostics: Diagnostic[];
  acknowledged: boolean;

  /** GeoLibre layer ids created by the last run, so a re-run can replace them. */
  layerIds: string[];

  /**
   * Distinct high-resolution looks found over the AOI, newest capture first.
   *
   * Not persisted and not populated automatically. Finding them costs about
   * thirty requests to a metadata service, which is not a price to pay on
   * every run for something a verifier reaches for only when the index maths
   * has already flagged something.
   */
  looks: Look[];
  looksStatus: "idle" | "loading" | "ready" | "error";
  looksError: string | null;
  /** Capture date of the look currently drawn, or null when none is. */
  activeLook: string | null;

  /**
   * Blend between the pre and post RGB composites, 0 pre, 1 post.
   *
   * A crossfade rather than a swipe. A swipe compares two halves of the
   * screen, which finds an edge; a crossfade held under the eye compares the
   * same ground at two dates, which is what finds a clearing. Blinking between
   * the ends is the oldest change-detection technique there is and it still
   * beats looking at two pictures side by side.
   */
  rgbBlend: number;
  rgbBlendActive: boolean;

  /**
   * Independent records of ground disturbance over the same area.
   *
   * Never an input to the analysis. Held separately from `results` for that
   * reason: nothing downstream of a composite may read them, and keeping them
   * out of the result object makes that structural rather than a convention.
   */
  corroboration: Corroboration | null;
  corroborationStatus: "idle" | "loading" | "ready" | "error";
  corroborationError: string | null;
}

export interface Corroboration {
  ids: IdsSummary;
  fires: FireEvidence;
  /** Recorded silvicultural activity, National Forest System land only. */
  management: ManagementSummary | null;
  years: number[];
  fetchedAt: number;
}

function defaultPeriod(id: string, preYear: number, postYear: number): Period {
  return {
    id,
    preStart: `${preYear}-${DEFAULT_WINDOW_START_MONTH_DAY}`,
    preEnd: `${preYear}-${DEFAULT_WINDOW_END_MONTH_DAY}`,
    postStart: `${postYear}-${DEFAULT_WINDOW_START_MONTH_DAY}`,
    postEnd: `${postYear}-${DEFAULT_WINDOW_END_MONTH_DAY}`,
  };
}

export function defaultBreaks(): Record<DeltaId, Breaks> {
  return {
    dNDVI: { ...DELTAS.dNDVI.defaults },
    dNDMI: { ...DELTAS.dNDMI.defaults },
    dNBR: { ...DELTAS.dNBR.defaults },
  };
}

export function createState(): State {
  const thisYear = new Date().getFullYear();
  return {
    aoi: null,
    aoiLabel: "",
    periods: [defaultPeriod("RP1", thisYear - 2, thisYear - 1)],
    maxCloud: DEFAULT_MAX_CLOUD,
    maskId: DEFAULT_MASK_ID,
    maskOptions: { ...DEFAULT_MASK_OPTIONS },

    context: { boundary: null, smz: null, plots: null },

    breaks: defaultBreaks(),
    justifications: { dNDVI: "", dNDMI: "", dNBR: "" },

    status: "idle",
    progress: "",
    error: null,

    looks: [],
    looksStatus: "idle",
    looksError: null,
    activeLook: null,
    rgbBlend: 1,
    rgbBlendActive: false,

    corroboration: null,
    corroborationStatus: "idle",
    corroborationError: null,

    runStartedAt: null,
    results: [],
    analyses: {},
    diagnostics: [],
    acknowledged: false,

    layerIds: [],
  };
}

/**
 * Whether the tool has everything it needs to run.
 *
 * The Earth Engine build could not run until the operator supplied a Cloud
 * project id and signed in. Neither exists now: the catalogue and the imagery
 * are both open, so an area of interest is the only prerequisite.
 */
export function isReadyToRun(state: State): boolean {
  return state.aoi !== null && state.periods.length > 0;
}

export function breaksDeviate(state: State, id: DeltaId): boolean {
  const current = state.breaks[id];
  const defaults = DELTAS[id].defaults;
  return (
    current.low !== defaults.low ||
    current.moderate !== defaults.moderate ||
    current.high !== defaults.high
  );
}

/**
 * Only parameters are persisted.
 *
 * Results are not, because a run now paints megabytes of PNG data URLs and
 * embedding those in a saved project would make the file unusable. Re-running
 * costs seconds and needs no credentials, so there is nothing to preserve.
 */
export interface PersistedState {
  version: 1;
  aoi: Aoi | null;
  aoiLabel: string;
  periods: Period[];
  maxCloud: number;
  maskId: string;
  maskOptions: MaskOptions;
  breaks: Record<DeltaId, Breaks>;
  justifications: Record<DeltaId, string>;
  context: Record<ContextRole, ContextLayer | null>;
}

/**
 * Uploaded geometry is embedded so a saved project reopens complete, but a
 * large boundary would bloat the project file past what is reasonable to keep
 * in a JSON document. Past the cap the metadata is kept and the geometry is
 * dropped, so the operator is told to re-add the file rather than silently
 * losing the layer.
 */
const MAX_EMBEDDED_GEOMETRY_BYTES = 2_000_000;

function persistContext(layer: ContextLayer | null): ContextLayer | null {
  if (!layer) return null;
  let size = 0;
  try {
    size = JSON.stringify(layer.geojson).length;
  } catch {
    size = Number.POSITIVE_INFINITY;
  }
  if (size > MAX_EMBEDDED_GEOMETRY_BYTES) {
    return { ...layer, geojson: null };
  }
  return layer;
}

export function toPersisted(state: State): PersistedState {
  return {
    version: 1,
    aoi: state.aoi,
    aoiLabel: state.aoiLabel,
    periods: state.periods,
    maxCloud: state.maxCloud,
    maskId: state.maskId,
    maskOptions: state.maskOptions,
    breaks: state.breaks,
    justifications: state.justifications,
    context: {
      boundary: persistContext(state.context.boundary),
      smz: persistContext(state.context.smz),
      plots: persistContext(state.context.plots),
    },
  };
}

export function fromPersisted(state: State, raw: unknown): State {
  if (!raw || typeof raw !== "object") return state;
  const persisted = raw as Partial<PersistedState>;
  if (persisted.version !== 1) return state;

  return {
    ...state,
    aoi: persisted.aoi ?? null,
    aoiLabel: persisted.aoiLabel ?? "",
    periods:
      Array.isArray(persisted.periods) && persisted.periods.length > 0
        ? persisted.periods
        : state.periods,
    maxCloud:
      typeof persisted.maxCloud === "number" ? persisted.maxCloud : state.maxCloud,
    maskId: persisted.maskId ?? state.maskId,
    maskOptions: { ...state.maskOptions, ...(persisted.maskOptions ?? {}) },
    breaks: persisted.breaks ?? state.breaks,
    justifications: persisted.justifications ?? state.justifications,
    context: {
      boundary: persisted.context?.boundary ?? null,
      smz: persisted.context?.smz ?? null,
      plots: persisted.context?.plots ?? null,
    },
    status: "idle",
    results: [],
    analyses: {},
    diagnostics: [],
    layerIds: [],
  };
}
