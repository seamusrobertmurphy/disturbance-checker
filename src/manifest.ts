import {
  DELTAS,
  DeltaId,
  HISTOGRAM_MAX,
  HISTOGRAM_MIN,
  HISTOGRAM_STEPS,
} from "./defaults";
import { formatHectares } from "./panel/dom";
import { State, breaksDeviate } from "./state";
import { EARTH_SEARCH_URL, S2_STAC_COLLECTION } from "./stac/search";
import { CLOUD_MASKS } from "./raster/mask";
import { GRID_RESOLUTION } from "./raster/grid";

function describeAoi(state: State): string {
  if (!state.aoi) return "not set";
  switch (state.aoi.kind) {
    case "rectangle":
      return `rectangle W ${state.aoi.west} S ${state.aoi.south} E ${state.aoi.east} N ${state.aoi.north} (EPSG:4326)`;
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

  const mask = CLOUD_MASKS[state.maskId];

  lines.push(`Run at            ${runAt.toISOString()}`);
  lines.push(`Area of interest  ${describeAoi(state)}`);
  lines.push(`Catalogue         ${EARTH_SEARCH_URL}`);
  lines.push(`Collection        ${S2_STAC_COLLECTION} (Sentinel-2 L2A COGs on AWS Open Data)`);
  lines.push(`Radiometry        BOA offset removed where the catalogue reported it present`);
  // What the mask reported once it had started, in preference to its label. A
  // model that fell back from WebGPU to wasm ran the same weights, but the
  // record should say which, and only the run knows.
  const ran = state.results.find((result) => result.maskDescription);
  const castShadow =
    state.maskId === "scl"
      ? `, cast shadow ${state.maskOptions.rejectCastShadow ? "rejected" : "kept"}`
      : "";
  lines.push(
    `Cloud removal     ${ran?.maskDescription ?? mask?.label ?? state.maskId}${castShadow}, snow ${state.maskOptions.rejectSnow ? "rejected" : "kept"}`,
  );
  lines.push(
    `Scene filter      eo:cloud_cover < ${state.maxCloud} percent, applied before download`,
  );
  lines.push(`Reduction         per-pixel median over surviving observations`);
  lines.push(
    `Histogram         ${HISTOGRAM_STEPS} fixed bins from ${HISTOGRAM_MIN} to ${HISTOGRAM_MAX}, computed on every pixel`,
  );
  lines.push(
    `Working grid      native Sentinel-2 UTM, ${GRID_RESOLUTION} m, areas counted on that grid`,
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
      `  Overpasses    ${result.preObservations.length} pre, ${result.postObservations.length} post`,
    );
    lines.push(
      `  Pre dates     ${result.preObservations.map((o) => o.date).join(", ") || "none"}`,
    );
    lines.push(
      `  Post dates    ${result.postObservations.map((o) => o.date).join(", ") || "none"}`,
    );
    lines.push(
      `  Area basis    EPSG:${result.grid.epsg}, ${result.grid.resolution} m grid, observed ${formatHectares(result.aoiAreaHa)} ha`,
    );
    if (result.thinPixels > 0) {
      lines.push(
        `  Thin coverage ${result.thinPixels} pixel(s) had fewer clear looks than the stability floor`,
      );
    }
    for (const warning of result.warnings) {
      lines.push(`  WARNING       ${warning}`);
    }
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

  const corroboration = state.corroboration;
  if (corroboration) {
    lines.push("--- Corroborating record ---");
    lines.push(
      `  Queried       ${corroboration.years[0]} to ${corroboration.years[corroboration.years.length - 1]}, over the area of interest`,
    );
    lines.push(
      `  Fire registries ${corroboration.fires.sources.join(", ") || "none answered"}`,
    );
    if (corroboration.fires.records.length === 0) {
      lines.push("  Fire          no mapped fire intersects this area in these years");
    } else {
      for (const fire of corroboration.fires.records) {
        const window = [fire.started, fire.ended].filter(Boolean).join(" to ");
        lines.push(
          `  Fire          [${fire.source}] ${fire.name} (${fire.year}), ${formatHectares(fire.hectares)} ha${window ? `, ${window}` : ""}`,
        );
      }
      lines.push(
        "  Note          one fire may appear under more than one registry. An operational perimeter and a severity assessment measure different things and must not be averaged.",
      );
    }
    if (corroboration.fires.yearsUnassessed.length > 0) {
      lines.push(
        `  NOT ASSESSED  burn severity is not yet published for ${corroboration.fires.yearsUnassessed.join(", ")}; absence is not evidence`,
      );
    }
    if (corroboration.ids.groups.length === 0) {
      lines.push("  Insect/disease no damage recorded over this area in these years");
    } else {
      lines.push(
        `  Insect/disease ${Math.round(corroboration.ids.totalAcres).toLocaleString()} acres recorded across ${corroboration.ids.groups.length} agent-year groups`,
      );
      for (const group of corroboration.ids.groups.slice(0, 10)) {
        lines.push(
          `    ${group.year}  ${group.damageType}, ${group.agent}, ${Math.round(group.acres).toLocaleString()} acres`,
        );
      }
    }
    const management = corroboration.management;
    if (management) {
      if (management.activities.length === 0) {
        lines.push(
          "  Management    no canopy-affecting activity recorded; National Forest System land only, so absence may be jurisdictional",
        );
      } else {
        lines.push(
          `  Management    ${Math.round(management.totalAcres).toLocaleString()} acres of recorded canopy-affecting activity`,
        );
        for (const activity of management.activities.slice(0, 10)) {
          lines.push(
            `    ${activity.completed}  ${activity.activity}, ${Math.round(activity.acres).toLocaleString()} acres`,
          );
        }
      }
      if (management.undated > 0) {
        lines.push(
          `  UNDATED       ${management.undated} activity record(s) carry no completion date and could not be placed in a year`,
        );
      }
    }
    lines.push(
      "  Sources       MTBS (USGS/USFS); WFIGS (NIFC); NBAC (Canadian Forest Service); USFS Forest Health Protection IDS; USFS FACTS; LANDFIRE",
    );
    lines.push(
      "  Note          corroborating evidence only. No composite, delta, break or area in this report is derived from it.",
    );
    lines.push("");
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
    "Imagery is Copernicus Sentinel-2 L2A, processed by ESA, distributed as cloud-optimised GeoTIFFs by Element 84 on AWS Open Data. Every pixel was read and reduced in the browser; no account, credential or server-side compute was involved. Re-running from these parameters reproduces the result.",
  );

  return lines.join("\n");
}
