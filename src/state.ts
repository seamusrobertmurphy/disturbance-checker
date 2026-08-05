import {
  Breaks,
  DELTAS,
  DeltaId,
  DEFAULT_MAX_CLOUD,
  DEFAULT_WINDOW_END_MONTH_DAY,
  DEFAULT_WINDOW_START_MONTH_DAY,
  PLACEHOLDER_EE_PROJECT,
} from "./defaults";
import { Diagnostic, HistogramAnalysis } from "./diagnostics";
import { Aoi, Period, PeriodResult } from "./ee/analysis";

export type RunStatus =
  | "idle"
  | "connecting"
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
  projectId: string;
  /** The placeholder must be replaced before any Earth Engine call is made. */
  projectConfirmed: boolean;
  signedIn: boolean;

  aoi: Aoi | null;
  aoiLabel: string;
  periods: Period[];
  maxCloud: number;

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
    // SOP Step 2.1's example project is shown deliberately, so the operator sees
    // the shape of the value they must supply and cannot run against it.
    projectId: PLACEHOLDER_EE_PROJECT,
    projectConfirmed: false,
    signedIn: false,

    aoi: null,
    aoiLabel: "",
    periods: [defaultPeriod("RP1", thisYear - 2, thisYear - 1)],
    maxCloud: DEFAULT_MAX_CLOUD,

    context: { boundary: null, smz: null, plots: null },

    breaks: defaultBreaks(),
    justifications: { dNDVI: "", dNDMI: "", dNBR: "" },

    status: "idle",
    progress: "",
    error: null,

    runStartedAt: null,
    results: [],
    analyses: {},
    diagnostics: [],
    acknowledged: false,

    layerIds: [],
  };
}

/**
 * Whether the project still needs the operator's attention.
 *
 * This deliberately turns on explicit confirmation rather than on the value
 * differing from the placeholder. The prefilled example is a real project id,
 * so comparing strings would permanently block the person whose project it
 * actually is. Editing the field or pressing the confirm button sets
 * projectConfirmed, and so does supplying ?ee_project_id in the URL.
 */
export function isPlaceholderProject(state: State): boolean {
  return !state.projectConfirmed || state.projectId.trim() === "";
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

/** Only parameters are persisted. Tile URLs die with the access token. */
export interface PersistedState {
  version: 1;
  projectId: string;
  aoi: Aoi | null;
  aoiLabel: string;
  periods: Period[];
  maxCloud: number;
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
    projectId: state.projectId,
    aoi: state.aoi,
    aoiLabel: state.aoiLabel,
    periods: state.periods,
    maxCloud: state.maxCloud,
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
    projectId: persisted.projectId ?? state.projectId,
    // A restored project still requires the operator to confirm the Cloud
    // project, because billing follows whoever is signed in now.
    projectConfirmed: false,
    aoi: persisted.aoi ?? null,
    aoiLabel: persisted.aoiLabel ?? "",
    periods:
      Array.isArray(persisted.periods) && persisted.periods.length > 0
        ? persisted.periods
        : state.periods,
    maxCloud:
      typeof persisted.maxCloud === "number" ? persisted.maxCloud : state.maxCloud,
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
