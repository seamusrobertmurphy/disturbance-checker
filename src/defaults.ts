// Every constant here traces to a section of the TUV SUD SOP "Canopy Disturbance
// Checks for ACR IFM Verification". Changing a value changes what the tool will
// certify, so each carries its provenance.

export const S2_COLLECTION = "COPERNICUS/S2_SR_HARMONIZED";

// SOP Pre-2022 baseline: S2_SR carries a +1000 DN offset on post-Jan-2022 scenes
// that propagates a ~0.04 false dNDVI signal. HARMONIZED back-corrects it.
export const S2_SCALE_DIVISOR = 10000;

// SOP Step 4: QA60 cloud (bit 10) and cirrus (bit 11).
export const QA60_CLOUD_BIT = 10;
export const QA60_CIRRUS_BIT = 11;

// SOP Step 3 Cloud ceiling. 30 default; 20 in PNW/coastal AK; 40 only if median
// composites show striping or NoData wedges.
export const DEFAULT_MAX_CLOUD = 30;

// SOP Step 3 Temporal window. Jul-Sep for both pre and post. Sentinel-2 revisit
// is 5 days, so two months yields >= 8 cloud-filtered scenes per pixel.
export const DEFAULT_WINDOW_START_MONTH_DAY = "07-01";
export const DEFAULT_WINDOW_END_MONTH_DAY = "09-01";

// SOP Operational tips, Patchwork composites: the median normaliser is unstable
// below ~4 scenes.
export const MIN_STABLE_SCENE_COUNT = 4;

// SOP Step 4: JRC GSW occurrence band, applied at the delta stage so the RGB
// layers retain water for visual context. unmask(1) is critical, without it
// pixels outside the GSW footprint become NoData in every delta.
export const GSW_IMAGE = "JRC/GSW1_4/GlobalSurfaceWater";
export const GSW_OCCURRENCE_THRESHOLD = 50;

// SOP Step 6 histogram. fixedHistogram(-0.5, 0.8, 130) at scale 20 (Sentinel-2
// SWIR native resolution). maxPixels is raised from the SOP's 1e9 to 1e10
// because the SOP itself records that 1e9 truncates silently on large ROIs.
export const HISTOGRAM_MIN = -0.5;
export const HISTOGRAM_MAX = 0.8;
export const HISTOGRAM_STEPS = 130;
export const HISTOGRAM_SCALE = 20;
export const HISTOGRAM_MAX_PIXELS = 1e10;

export const AREA_SCALE = 20;
export const AREA_MAX_PIXELS = 1e10;

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
export const CLASS_PALETTE = ["#ffffb2", "#fd8d3c", "#bd0026"];
export const CLASS_LABELS = ["Low", "Moderate", "High"];

export const CONTINUOUS_PALETTE = [
  "#2b83ba",
  "#abdda4",
  "#ffffbf",
  "#fdae61",
  "#d7191c",
];

// SOP Step 2.1: Earth Engine refuses any compute call against the modern API
// without a bound Cloud project. This placeholder is shown on launch and must be
// replaced by the operator with their own project ID.
export const PLACEHOLDER_EE_PROJECT = "murphys-deforisk";

// GeoLibre's own public OAuth client, the same one its built-in Earth Engine
// panel signs in with (packages/plugins/src/plugins/earth-engine-auth.ts). When
// this plugin runs inside a GeoLibre deployment, the origin is already on that
// client's authorized list, so sign-in works with no Cloud console setup at all.
//
// Override it with VITE_GEE_OAUTH_CLIENT_ID at build time, or ?gee_client_id at
// runtime. A self-hosted deployment on your own domain needs its own client,
// because GeoLibre's does not authorize your origin.
export const FALLBACK_OAUTH_CLIENT_ID =
  "141292844612-gitmgm28jkmkujonfkrkvdaqjiqt6qkf.apps.googleusercontent.com";

// Only the Earth Engine scope is requested. The Cloud Storage scope
// (devstorage.full_control) that the Code Editor also asks for is a *restricted*
// scope: it makes the consent screen more alarming, and it would drag any future
// External verification into Google's restricted-scope review. Nothing here
// needs it, because compute, getMap and reduceRegion all run under the Earth
// Engine scope alone. Add it back only alongside export to Cloud Storage.
export const EE_SCOPES = ["https://www.googleapis.com/auth/earthengine"];
