// Every constant here traces to a section of the TUV SUD SOP "Canopy Disturbance
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

export type DeltaId = "dNDVI" | "dNDMI" | "dNBR";

export interface Breaks {
  low: number;
  moderate: number;
  high: number;
}

export interface DeltaSpec {
  id: DeltaId;
  label: string;
  /** SOP Step 5 sign convention. */
  direction: "pre-minus-post" | "post-minus-pre";
  meaning: string;
  defaults: Breaks;
  /** Provenance for the default breaks, shown in the run manifest. */
  source: string;
}

// SOP Step 5 delta sign convention, and Step 6 default breaks. Overriding a
// break is allowed only when the histogram supports it, and the deviation must
// be documented. This tool records the justification in the run manifest.
export const DELTAS: Record<DeltaId, DeltaSpec> = {
  dNDVI: {
    id: "dNDVI",
    label: "dNDVI - canopy loss",
    direction: "pre-minus-post",
    meaning: "Positive values indicate canopy loss.",
    defaults: { low: 0.1, moderate: 0.2, high: 0.35 },
    source: "SOP Step 6 default breaks",
  },
  dNDMI: {
    id: "dNDMI",
    label: "dNDMI - moisture stress",
    direction: "pre-minus-post",
    meaning: "Positive values indicate moisture stress.",
    defaults: { low: 0.15, moderate: 0.3, high: 0.45 },
    source: "SOP Step 6 default breaks",
  },
  dNBR: {
    id: "dNBR",
    label: "dNBR - burn severity",
    direction: "post-minus-pre",
    meaning: "Positive values indicate burned area.",
    defaults: { low: 0.1, moderate: 0.27, high: 0.44 },
    source: "SOP Step 6 default breaks (MTBS / USFS PNW)",
  },
};

// SOP Step 7: 0 = undisturbed, 1 = Low, 2 = Moderate, 3 = High. Class 0 is
// masked so the underlying composite shows through for visual cross-check.
// Palettes match vis_dndvi / vis_dndmi / vis_dnbr in the production scripts, so
// a layer rendered here looks like the same layer rendered in QGIS. dNDMI is
// deliberately a different ramp from the other two.
export const CLASS_PALETTES: Record<DeltaId, string[]> = {
  dNDVI: ["#FFEDA0", "#FC4E2A", "#800026"],
  dNDMI: ["#FEB24C", "#FD8D3C", "#B10026"],
  dNBR: ["#FFEDA0", "#FC4E2A", "#800026"],
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
