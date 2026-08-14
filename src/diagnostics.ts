import { Breaks, DeltaId, MIN_STABLE_SCENE_COUNT } from "./defaults";
import { HistogramBin } from "./analysis/deltas";
import { Period } from "./analysis/run";

export type HistogramShape =
  | "unimodal-narrow"
  | "bimodal-gap"
  | "unimodal-long-tail"
  | "empty";

export type Severity = "info" | "warning";

export interface Diagnostic {
  severity: Severity;
  title: string;
  detail: string;
  /** SOP section this rule encodes, shown in the run manifest. */
  source: string;
}

export interface HistogramAnalysis {
  shape: HistogramShape;
  /** Share of valid pixels at or above the Low break. */
  flaggedFraction: number;
  /** Present only for bimodal-gap: the centre of the gap, per SOP Step 6. */
  suggestedLow: number | null;
  diagnostics: Diagnostic[];
}

function totalCount(bins: HistogramBin[]): number {
  return bins.reduce((sum, bin) => sum + bin.count, 0);
}

function massAtOrAbove(bins: HistogramBin[], threshold: number): number {
  return bins
    .filter((bin) => bin.start >= threshold)
    .reduce((sum, bin) => sum + bin.count, 0);
}

/**
 * SOP Step 6 distribution diagnostics.
 *
 *   Unimodal at 0 with a narrow tail  -> noise or phenology, defaults hold.
 *   Bimodal with a gap above ~0.15    -> real signal, place Low in the gap.
 *   Long unimodal right tail, no gap  -> composite contamination.
 *
 * The third case is the one that produced the Appendix A.1 finding, where the
 * default 0.05 break sat on the shoulder of the noise bulk and reclassified
 * dormant-season phenology as disturbance across 38% of the project area.
 */
export function analyseHistogram(
  bins: HistogramBin[],
  breaks: Breaks,
): HistogramAnalysis {
  const total = totalCount(bins);
  if (total === 0 || bins.length === 0) {
    return {
      shape: "empty",
      flaggedFraction: 0,
      suggestedLow: null,
      diagnostics: [
        {
          severity: "warning",
          title: "Empty histogram",
          detail:
            "No valid pixels were returned. The AOI may fall outside the composite, or every scene may have been filtered out by the cloud ceiling.",
          source: "SOP Step 6",
        },
      ],
    };
  }

  const flaggedFraction = massAtOrAbove(bins, breaks.low) / total;

  let peakIndex = 0;
  for (let i = 1; i < bins.length; i += 1) {
    if (bins[i].count > bins[peakIndex].count) peakIndex = i;
  }
  const peakCount = bins[peakIndex].count;
  const peakStart = bins[peakIndex].start;

  // A gap is a run of near-empty bins to the right of the main bulk that still
  // has meaningful mass beyond it. Threshold is relative to the peak so it is
  // scale-free across AOI sizes.
  const gapCeiling = peakCount * 0.005;
  const minGapBins = 3;

  let gapStart = -1;
  let gapEnd = -1;
  let run = 0;
  for (let i = peakIndex + 1; i < bins.length; i += 1) {
    if (bins[i].count <= gapCeiling) {
      if (run === 0) gapStart = i;
      run += 1;
      gapEnd = i;
    } else if (run >= minGapBins) {
      break;
    } else {
      run = 0;
      gapStart = -1;
      gapEnd = -1;
    }
  }

  const hasGap = run >= minGapBins && gapStart > 0;
  const massBeyondGap = hasGap
    ? bins.slice(gapEnd + 1).reduce((sum, bin) => sum + bin.count, 0)
    : 0;
  const bimodal = hasGap && massBeyondGap / total > 0.0005;

  // Tail mass well beyond the High break. A narrow tail decays to nothing; a
  // contaminated composite keeps carrying weight to the end of the range.
  const farTailFraction = massAtOrAbove(bins, breaks.high) / total;

  const diagnostics: Diagnostic[] = [];
  let shape: HistogramShape;
  let suggestedLow: number | null = null;

  if (bimodal) {
    shape = "bimodal-gap";
    suggestedLow = (bins[gapStart].start + bins[gapEnd].start) / 2;
    diagnostics.push({
      severity: "info",
      title: "Bimodal distribution with a clear gap",
      detail: `A gap separates the noise bulk from a secondary population above ${bins[gapStart].start.toFixed(2)}. This is the signature of real disturbance. Place the Low break inside the gap rather than on the default.`,
      source: "SOP Step 6, distribution diagnostics",
    });
  } else if (farTailFraction > 0.02 || flaggedFraction > 0.15) {
    shape = "unimodal-long-tail";
    diagnostics.push({
      severity: "warning",
      title: "Unimodal with a long right tail and no gap",
      detail: `${(flaggedFraction * 100).toFixed(1)}% of valid pixels sit at or above the Low break with no separating gap. SOP Step 6 attributes this to composite contamination: cloud shadow, senescence, or BRDF. Audit the date windows before adjusting the class breaks.`,
      source: "SOP Step 6 and Appendix A.1",
    });
  } else {
    shape = "unimodal-narrow";
    diagnostics.push({
      severity: "info",
      title: "Unimodal at zero with a narrow tail",
      detail:
        "Noise and phenology only. The default breaks hold without adjustment.",
      source: "SOP Step 6, distribution diagnostics",
    });
  }

  if (peakStart > 0.1) {
    diagnostics.push({
      severity: "warning",
      title: "Distribution is not centred on zero",
      detail: `The modal bin sits at ${peakStart.toFixed(2)} rather than near zero, which indicates a systematic offset between the pre and post composites rather than localised change.`,
      source: "SOP Step 6",
    });
  }

  return { shape, flaggedFraction, suggestedLow, diagnostics };
}

const GROWING_SEASON_MONTHS = new Set([6, 7, 8, 9]);

function monthOf(date: string): number {
  const parsed = Number.parseInt(date.slice(5, 7), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * SOP Step 3 and Appendix A.1. Dormant-season composites corrupt dNDMI:
 * senescence drives SWIR1 reflectance up before leaf-fall, producing a uniform
 * false moisture-stress signal. Phenology drift between periods is the most
 * common source of fake inter-period change.
 */
export function checkPeriod(period: Period): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const months = [
    monthOf(period.preStart),
    monthOf(period.preEnd),
    monthOf(period.postStart),
    monthOf(period.postEnd),
  ];
  const outside = months.filter((month) => month && !GROWING_SEASON_MONTHS.has(month));

  if (outside.length > 0) {
    diagnostics.push({
      severity: "warning",
      title: `${period.id}: window falls outside the growing season`,
      detail:
        "Dormant-season composites corrupt dNDMI because senescence raises SWIR1 reflectance before leaf-fall, producing a uniform false moisture-stress signal. Use July to September for both pre and post.",
      source: "SOP Step 3 and Appendix A.1",
    });
  }

  const preMonths = [monthOf(period.preStart), monthOf(period.preEnd)];
  const postMonths = [monthOf(period.postStart), monthOf(period.postEnd)];
  if (
    preMonths[0] !== postMonths[0] ||
    preMonths[1] !== postMonths[1]
  ) {
    diagnostics.push({
      severity: "warning",
      title: `${period.id}: pre and post windows cover different months`,
      detail:
        "Phenology drift between mismatched windows is the most common source of fake change. Use the same calendar window for pre and post.",
      source: "SOP Step 8",
    });
  }

  return diagnostics;
}

/**
 * SOP Operational tips, Patchwork composites. Visible NoData wedges or
 * median-filter edge artefacts indicate fewer than four valid scenes per pixel.
 */
export function checkSceneCounts(
  periodId: string,
  preCount: number,
  postCount: number,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const [label, count] of [
    ["pre", preCount],
    ["post", postCount],
  ] as const) {
    if (count < MIN_STABLE_SCENE_COUNT) {
      diagnostics.push({
        severity: "warning",
        title: `${periodId}: only ${count} ${label} scene${count === 1 ? "" : "s"}`,
        detail:
          "The median normaliser is unstable below about four scenes. Loosen the cloud ceiling by 5 to 10 percentage points, or extend the window by 30 days.",
        source: "SOP Operational tips, Patchwork composites",
      });
    }
  }
  return diagnostics;
}

export function collectDeltaDiagnostics(
  analyses: Record<DeltaId, HistogramAnalysis>,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const [id, analysis] of Object.entries(analyses) as Array<
    [DeltaId, HistogramAnalysis]
  >) {
    for (const diagnostic of analysis.diagnostics) {
      out.push({ ...diagnostic, title: `${id}: ${diagnostic.title}` });
    }
  }
  return out;
}
