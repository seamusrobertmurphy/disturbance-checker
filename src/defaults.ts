// Every constant here traces to a section of the SOP "Canopy Disturbance
// Checks for ACR IFM Verification". Changing a value changes what the tool will
// certify, so each carries its provenance.

/**
 * DN to reflectance.
 *
 * SOP Pre-2022 baseline: from processing baseline 04.00 the L2A products carry
 * a +1000 DN offset that propagates a false dNDVI of roughly 0.04 across a
 * window straddling January 2022. Earth Engine's HARMONIZED collection undid
 * it server-side. The catalogue this build reads reports per scene whether the
 * offset has been removed, and src/stac/search.ts acts on that report, so the
 * correction is made from evidence rather than from a date.
 */
export const S2_SCALE_DIVISOR = 10000;

/**
 * Scene-level cloud ceiling.
 *
 * Under Cloud Score+ the production scripts defined MAX_CLOUD and never
 * applied it, because per-pixel masking made a scene filter pointless. It
 * matters again for a different reason: every scene kept is downloaded, so
 * this is what keeps a run to seconds. Masking is still per pixel.
 */
export const DEFAULT_MAX_CLOUD = 30;

// Production scripts use August to September for both windows. The SOP PDF says
// July to September; the scripts are narrower and are what actually runs.
export const DEFAULT_WINDOW_START_MONTH_DAY = "08-01";
export const DEFAULT_WINDOW_END_MONTH_DAY = "09-01";

// SOP Operational tips, Patchwork composites: the median normaliser is unstable
// below ~4 scenes.
export const MIN_STABLE_SCENE_COUNT = 4;

// SOP Step 6 histogram: fixedHistogram(-0.5, 0.8, 130).
//
// The SOP's maxPixels ceiling is gone rather than raised. It existed because
// Earth Engine sampled a reduction and truncated silently past a limit, which
// the SOP itself records happening at 1e9 on large ROIs. This build reads every
// pixel of the working grid, so there is no sample to truncate.
export const HISTOGRAM_MIN = -0.5;
export const HISTOGRAM_MAX = 0.8;
export const HISTOGRAM_STEPS = 130;

/**
 * Working resolution, in metres.
 *
 * 20 m, the SOP's scale for both the histogram and the area reductions, and the
 * native resolution of B11, B12 and SCL. Water is no longer masked from JRC
 * Global Surface Water, which has no anonymous COG equivalent, but from the
 * scene classification's own water class, combined across the window.
 */
export const ANALYSIS_SCALE = 20;

/**
 * The two sensors a check can run on.
 *
 * Sentinel-2 is the SOP's optical check, three spectral indices from the
 * reflectance bands. Sentinel-1 is radar, which sees through cloud, darkness
 * and snow and so covers winter harvest on frozen ground that the optical check
 * misses. The method and its breaks come from the Radar canopy loss cell of
 * TUVSUD_Anew_Claybelt_RP1_DisturbanceCheck_ArcGIS.ipynb.
 */
export type Sensor = "sentinel-2" | "sentinel-1";

export type OpticalDeltaId = "dNDVI" | "dNDMI" | "dNBR";
export type DeltaId = OpticalDeltaId | "dVH";

export interface Breaks {
  low: number;
  moderate: number;
  high: number;
}

/** The fixed histogram a delta is binned on, and the step its breaks move in. */
export interface HistogramSpec {
  min: number;
  max: number;
  steps: number;
  step: number;
}

export interface DeltaSpec {
  id: DeltaId;
  label: string;
  /** Which sensor's run produces it. */
  sensor: Sensor;
  /** SOP Step 5 sign convention. */
  direction: "pre-minus-post" | "post-minus-pre";
  meaning: string;
  /** The unit the breaks are read in, for the panel and the manifest. */
  unit: string;
  defaults: Breaks;
  histogram: HistogramSpec;
  /** Provenance for the default breaks, shown in the run manifest. */
  source: string;
}

/** SOP Step 6 histogram for the three optical indices, fixedHistogram(-0.5, 0.8, 130). */
const INDEX_HISTOGRAM: HistogramSpec = {
  min: HISTOGRAM_MIN,
  max: HISTOGRAM_MAX,
  steps: HISTOGRAM_STEPS,
  step: 0.01,
};

/**
 * The radar drop in decibels. Clear-cut drops sit between 2 and 4 dB, so the
 * range runs to 10 dB and the bins are a tenth of a decibel, which resolves a
 * break to the precision the calibration quoted.
 */
const RADAR_HISTOGRAM: HistogramSpec = { min: -5, max: 10, steps: 150, step: 0.1 };

// SOP Step 5 delta sign convention, and Step 6 default breaks. Overriding a
// break is allowed only when the histogram supports it, and the deviation must
// be documented. This tool keeps the justification with the saved project.
export const DELTAS: Record<DeltaId, DeltaSpec> = {
  dNDVI: {
    id: "dNDVI",
    label: "dNDVI - canopy loss",
    sensor: "sentinel-2",
    direction: "pre-minus-post",
    meaning: "Positive values indicate canopy loss.",
    unit: "",
    defaults: { low: 0.1, moderate: 0.2, high: 0.35 },
    histogram: INDEX_HISTOGRAM,
    source: "SOP Step 6 default breaks",
  },
  dNDMI: {
    id: "dNDMI",
    label: "dNDMI - moisture stress",
    sensor: "sentinel-2",
    direction: "pre-minus-post",
    meaning: "Positive values indicate moisture stress.",
    unit: "",
    defaults: { low: 0.15, moderate: 0.3, high: 0.45 },
    histogram: INDEX_HISTOGRAM,
    source: "SOP Step 6 default breaks",
  },
  dNBR: {
    id: "dNBR",
    label: "dNBR - burn severity",
    sensor: "sentinel-2",
    direction: "post-minus-pre",
    meaning: "Positive values indicate burned area.",
    unit: "",
    defaults: { low: 0.1, moderate: 0.27, high: 0.44 },
    histogram: INDEX_HISTOGRAM,
    source: "SOP Step 6 default breaks (MTBS / USFS PNW)",
  },
  // The VH channel, sent vertically and received horizontally, comes back
  // mostly from branches and stems, so it falls when a stand is cut. The breaks
  // were set by hand as steps of the drop in decibels and tested near Cochrane,
  // Ontario, against the clearcuts in Ontario's forest management annual
  // reports for 1 April 2024 to 31 March 2025 (878 blocks, 8,455 ha): 1,491
  // points inside those clearcuts against 2,837 points more than 50 m from any
  // harvest reported since 2015. At 2.0 dB, 43.9 per cent of clearcut points and
  // 3.8 per cent of unharvested points reached Low; 1.5 dB would have flagged
  // 8.1 per cent of unharvested ground. Scripts/ESRI/TUVSUD_Calibration_
  // RadarBreaks_Cochrane.py in library-sop/sop-disturbances.
  dVH: {
    id: "dVH",
    label: "dVH - radar canopy loss",
    sensor: "sentinel-1",
    direction: "pre-minus-post",
    meaning: "Positive values indicate a drop in VH backscatter, in decibels.",
    unit: " dB",
    defaults: { low: 2, moderate: 2.5, high: 3.5 },
    histogram: RADAR_HISTOGRAM,
    source: "Cochrane, Ontario calibration against 2024 to 2025 annual report clearcuts",
  },
};

/** The deltas a run on this sensor produces, in the order the panel lists them. */
export function deltaIdsFor(sensor: Sensor): DeltaId[] {
  return (Object.keys(DELTAS) as DeltaId[]).filter((id) => DELTAS[id].sensor === sensor);
}

// SOP Step 7: 0 = undisturbed, 1 = Low, 2 = Moderate, 3 = High. Class 0 is
// masked so the underlying composite shows through for visual cross-check.
// Palettes match vis_dndvi / vis_dndmi / vis_dnbr in the production scripts, so
// a layer rendered here looks like the same layer rendered in QGIS. dNDMI is
// deliberately a different ramp from the other two.
export const CLASS_PALETTES: Record<DeltaId, string[]> = {
  dNDVI: ["#FFEDA0", "#FC4E2A", "#800026"],
  dNDMI: ["#FEB24C", "#FD8D3C", "#B10026"],
  dNBR: ["#FFEDA0", "#FC4E2A", "#800026"],
  // The notebook draws the radar classes with the dNDVI ramp.
  dVH: ["#FFEDA0", "#FC4E2A", "#800026"],
};
export const CLASS_PALETTE = CLASS_PALETTES.dNDVI;
export const CLASS_LABELS = ["Low", "Moderate", "High"];

// vis_delta in the production scripts.
export const CONTINUOUS_PALETTE = ["#1a9850", "#ffffbf", "#fc8d59", "#d73027"];
export const CONTINUOUS_MIN = -0.3;
export const CONTINUOUS_MAX = 0.5;

// vis_ndvi and vis_ndmi: the single-date index layers.
export const NDVI_VIS = {
  min: -0.2,
  max: 0.8,
  palette: ["#d73027", "#fc8d59", "#fee08b", "#d9ef8b", "#1a9850"],
};
export const NDMI_VIS = {
  min: -0.5,
  max: 0.5,
  palette: ["#d73027", "#fc8d59", "#ffffbf", "#91bfdb", "#4575b4"],
};

// vis_rgb: note the gamma, which the earlier implementation omitted.
export const RGB_VIS = {
  bands: ["B4", "B3", "B2"],
  min: 0.02,
  max: 0.25,
  gamma: 1.2,
};

// SOP Step 2.1 required a billed Cloud project and a signed-in Google account
// before any compute call would run. Neither exists in this build. The imagery
// and the catalogue are both open, so there is no account, no project, no
// OAuth client and no consent screen.
