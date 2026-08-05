import {
  CLOUD_SCORE_BAND,
  CLOUD_SCORE_PLUS_COLLECTION,
  DELTAS,
  DeltaId,
  HISTOGRAM_MAX,
  HISTOGRAM_MAX_PIXELS,
  HISTOGRAM_MIN,
  HISTOGRAM_SCALE,
  HISTOGRAM_STEPS,
  S2_COLLECTION,
} from "./defaults";
import { formatHectares } from "./panel/dom";
import { State, breaksDeviate } from "./state";

function describeAoi(state: State): string {
  if (!state.aoi) return "not set";
  switch (state.aoi.kind) {
    case "rectangle":
      return `rectangle W ${state.aoi.west} S ${state.aoi.south} E ${state.aoi.east} N ${state.aoi.north} (EPSG:4326)`;
    case "asset":
      return `Earth Engine asset ${state.aoi.assetId}`;
    case "geojson":
      return state.aoiLabel || "uploaded boundary";
  }
}

/**
 * The run manifest is the reason this tool exists rather than a script. SOP
 * Step 6 requires any deviation from the default class breaks to be documented;
 * recording it here means the record cannot drift from the run that produced it.
 */
export function buildManifest(state: State, runAt: Date): string {
  const lines: string[] = [];

  lines.push("TUV SUD Canopy Disturbance Check");
  lines.push("Sentinel-2 NDVI / NDMI / NBR pre-post delta screening");
  lines.push("");
  lines.push(`Run at            ${runAt.toISOString()}`);
  lines.push(`Earth Engine project  ${state.projectId}`);
  lines.push(`Area of interest  ${describeAoi(state)}`);
  lines.push(`Collection        ${S2_COLLECTION}`);
  if (state.cloudMethod === "cloud-score-plus") {
    lines.push(
      `Cloud removal     Cloud Score+ (${CLOUD_SCORE_PLUS_COLLECTION}), band "${CLOUD_SCORE_BAND}" >= ${state.clearThreshold}, qualityMosaic`,
    );
  } else {
    lines.push(
      `Cloud removal     QA60 cloud+cirrus bitmask, CLOUDY_PIXEL_PERCENTAGE < ${state.maxCloud}, per-pixel median`,
    );
  }
  lines.push(
    `Histogram         fixedHistogram(${HISTOGRAM_MIN}, ${HISTOGRAM_MAX}, ${HISTOGRAM_STEPS}) at scale ${HISTOGRAM_SCALE}, maxPixels ${HISTOGRAM_MAX_PIXELS.toExponential()}`,
  );
  lines.push("");

  for (const result of state.results) {
    const period = state.periods.find((entry) => entry.id === result.periodId);
    lines.push(`--- ${result.periodId} ---`);
    if (period) {
      lines.push(`  Pre window    ${period.preStart} to ${period.preEnd}`);
      lines.push(`  Post window   ${period.postStart} to ${period.postEnd}`);
    }
    lines.push(
      `  Scenes        ${result.preSceneCount} pre, ${result.postSceneCount} post`,
    );
    lines.push(
      `  Area basis    ${result.utmCrs}, AOI ${formatHectares(result.aoiAreaHa)} ha`,
    );
    lines.push("");

    for (const id of Object.keys(DELTAS) as DeltaId[]) {
      const delta = result.deltas[id];
      const breaks = state.breaks[id];
      const deviated = breaksDeviate(state, id);
      const defaults = DELTAS[id].defaults;
      const analysis = state.analyses[result.periodId]?.[id];

      lines.push(`  ${id} (${DELTAS[id].direction})`);
      lines.push(
        `    Breaks      Low ${breaks.low}, Moderate ${breaks.moderate}, High ${breaks.high}`,
      );
      if (deviated) {
        lines.push(
          `    DEVIATION   defaults were Low ${defaults.low}, Moderate ${defaults.moderate}, High ${defaults.high}`,
        );
        lines.push(
          `    Justification ${state.justifications[id]?.trim() || "NOT PROVIDED"}`,
        );
      } else {
        lines.push(`    Breaks source ${DELTAS[id].source}`);
      }
      if (analysis) {
        lines.push(`    Histogram   ${analysis.shape}`);
        lines.push(
          `    Flagged     ${(analysis.flaggedFraction * 100).toFixed(2)}% of valid pixels at or above Low`,
        );
      }
      const [low, moderate, high] = delta.areasHa;
      lines.push(
        `    Areas (ha)  Low ${formatHectares(low)}, Moderate ${formatHectares(moderate)}, High ${formatHectares(high)}, total ${formatHectares(low + moderate + high)}`,
      );
      if (result.aoiAreaHa > 0) {
        lines.push(
          `    Share       ${(((low + moderate + high) / result.aoiAreaHa) * 100).toFixed(2)}% of AOI`,
        );
      }
      lines.push("");
    }
  }

  if (state.diagnostics.length > 0) {
    lines.push("--- Diagnostics raised ---");
    for (const diagnostic of state.diagnostics) {
      lines.push(`  [${diagnostic.severity}] ${diagnostic.title}`);
      lines.push(`    ${diagnostic.detail}`);
      lines.push(`    Source: ${diagnostic.source}`);
    }
    lines.push(
      `  Acknowledged by operator: ${state.acknowledged ? "yes" : "no"}`,
    );
    lines.push("");
  } else {
    lines.push("--- Diagnostics raised ---");
    lines.push("  None.");
    lines.push("");
  }

  lines.push(
    "Map tiles are served against a short-lived Earth Engine access token and are not archived by this tool. Re-run from these parameters to regenerate them.",
  );

  return lines.join("\n");
}
