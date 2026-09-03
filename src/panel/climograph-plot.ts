import {
  MONTH_SLOTS,
  SLOTS_PER_YEAR,
  YearLine,
  formatMonthDay,
} from "../reference/climate";
import { svgEl } from "./dom";

const WIDTH = 260;
const HEIGHT = 74;
const PAD_LEFT = 24;
const PAD_RIGHT = 4;
const PAD_TOP = 10;
const PAD_BOTTOM = 12;

/** One colour per year, in the order the years are listed, readable on both themes. */
export const YEAR_COLOURS = [
  "#58a6ff",
  "#f78166",
  "#3fb950",
  "#d2a8ff",
  "#e3b341",
  "#ff7b72",
  "#79c0ff",
  "#7ee787",
];

export function yearColour(index: number): string {
  return YEAR_COLOURS[index % YEAR_COLOURS.length];
}

export interface ClimographPanelOptions {
  /** Short name drawn at the top left, and the unit after it. */
  title: string;
  unit: string;
  /** The reporting-period years, drawn in colour. */
  lines: YearLine[];
  /** The long-run mean, drawn grey underneath. */
  reference: Array<number | null>;
  /** Month-day spans to shade, on the slot axis. */
  spans: Array<{ label: string; from: number; to: number }>;
  /** Y axis floor. Rain, sun and snow start at zero; temperature floats. */
  floorAtZero: boolean;
  /** Decimal places for the hover readout. */
  digits: number;
}

const MONTH_LETTERS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];

/**
 * One metric on a January to December axis, every reporting-period year as
 * its own line over a grey long-run mean, with the composite windows shaded.
 *
 * The chart answers one question: do the pre and post windows sit at the same
 * point of the season, and did the season run early or late in either year.
 * Everything else is left off.
 */
export function renderClimographPanel(options: ClimographPanelOptions): SVGSVGElement {
  const { lines, reference, spans, floorAtZero } = options;

  const svg = svgEl("svg", {
    class: "dc-climograph",
    viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
    preserveAspectRatio: "none",
    role: "img",
    "aria-label": `${options.title}, ${options.unit}, by day of year`,
  });

  const plotWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  const consider = (value: number | null) => {
    if (value === null) return;
    if (value < min) min = value;
    if (value > max) max = value;
  };
  reference.forEach(consider);
  for (const line of lines) line.values.forEach(consider);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 1;
  }
  if (floorAtZero) min = Math.min(0, min);
  if (max - min < 1e-6) max = min + 1;
  // A little headroom so the top of a line is not clipped by the title.
  const span = (max - min) * 1.05;

  const toX = (slot: number): number => PAD_LEFT + (slot / (SLOTS_PER_YEAR - 1)) * plotWidth;
  const toY = (value: number): number =>
    PAD_TOP + plotHeight - ((value - min) / span) * plotHeight;

  // Windows first, so every line is drawn over them.
  for (const spanBand of spans) {
    const x1 = toX(Math.min(spanBand.from, spanBand.to));
    const x2 = toX(Math.max(spanBand.from, spanBand.to));
    svg.appendChild(
      svgEl("rect", {
        x: x1,
        y: PAD_TOP,
        width: Math.max(1, x2 - x1),
        height: plotHeight,
        class: "dc-climograph-window",
      }),
    );
  }

  // Axes.
  svg.appendChild(
    svgEl("line", {
      x1: PAD_LEFT,
      y1: PAD_TOP + plotHeight,
      x2: WIDTH - PAD_RIGHT,
      y2: PAD_TOP + plotHeight,
      class: "dc-climograph-axis",
    }),
  );
  if (min < 0 && max > 0) {
    svg.appendChild(
      svgEl("line", {
        x1: PAD_LEFT,
        y1: toY(0),
        x2: WIDTH - PAD_RIGHT,
        y2: toY(0),
        class: "dc-climograph-zero",
      }),
    );
  }
  for (let month = 0; month < 12; month += 1) {
    const x = toX(MONTH_SLOTS[month]);
    svg.appendChild(
      svgEl("line", {
        x1: x,
        y1: PAD_TOP + plotHeight,
        x2: x,
        y2: PAD_TOP + plotHeight + 2,
        class: "dc-climograph-axis",
      }),
    );
    const label = svgEl("text", {
      x: toX(MONTH_SLOTS[month] + 15),
      y: HEIGHT - 3,
      class: "dc-climograph-tick",
      "text-anchor": "middle",
    });
    label.textContent = MONTH_LETTERS[month];
    svg.appendChild(label);
  }

  const yLabel = (value: number, y: number, anchor: "hanging" | "auto") => {
    const label = svgEl("text", {
      x: PAD_LEFT - 3,
      y,
      class: "dc-climograph-tick",
      "text-anchor": "end",
      "dominant-baseline": anchor,
    });
    label.textContent = value.toFixed(options.digits > 0 && Math.abs(value) < 10 ? 1 : 0);
    svg.appendChild(label);
  };
  yLabel(max, PAD_TOP, "hanging");
  yLabel(min, PAD_TOP + plotHeight, "auto");

  const pathFor = (values: Array<number | null>): string => {
    let d = "";
    let pen = false;
    for (let slot = 0; slot < values.length; slot += 1) {
      const value = values[slot];
      if (value === null) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${toX(slot).toFixed(1)} ${toY(value).toFixed(1)} `;
      pen = true;
    }
    return d.trim();
  };

  svg.appendChild(
    svgEl("path", {
      d: pathFor(reference),
      class: "dc-climograph-reference",
      fill: "none",
    }),
  );
  lines.forEach((line, index) => {
    svg.appendChild(
      svgEl("path", {
        d: pathFor(line.values),
        class: "dc-climograph-line",
        stroke: yearColour(index),
        fill: "none",
      }),
    );
  });

  // Title.
  const title = svgEl("text", {
    x: PAD_LEFT,
    y: 7,
    class: "dc-climograph-title",
  });
  title.textContent = `${options.title}, ${options.unit}`;
  svg.appendChild(title);

  // Hover readout: the date and every line's value at the pointer.
  const cursor = svgEl("line", {
    x1: 0,
    y1: PAD_TOP,
    x2: 0,
    y2: PAD_TOP + plotHeight,
    class: "dc-climograph-cursor",
    visibility: "hidden",
  });
  svg.appendChild(cursor);
  const readout = svgEl("text", {
    x: WIDTH - PAD_RIGHT,
    y: 7,
    class: "dc-climograph-readout",
    "text-anchor": "end",
  });
  svg.appendChild(readout);

  svg.addEventListener("pointermove", (event: PointerEvent) => {
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return;
    const x = ((event.clientX - rect.left) / rect.width) * WIDTH;
    const slot = Math.round(((x - PAD_LEFT) / plotWidth) * (SLOTS_PER_YEAR - 1));
    if (slot < 0 || slot >= SLOTS_PER_YEAR) {
      cursor.setAttribute("visibility", "hidden");
      readout.textContent = "";
      return;
    }
    cursor.setAttribute("x1", String(toX(slot)));
    cursor.setAttribute("x2", String(toX(slot)));
    cursor.setAttribute("visibility", "visible");
    const parts = lines.map((line) => {
      const value = line.values[slot];
      return `${line.year} ${value === null ? "-" : value.toFixed(options.digits)}`;
    });
    const ref = reference[slot];
    parts.push(`mean ${ref === null ? "-" : ref.toFixed(options.digits)}`);
    readout.textContent = `${formatMonthDay(slot)}  ${parts.join("  ")}`;
  });
  svg.addEventListener("pointerleave", () => {
    cursor.setAttribute("visibility", "hidden");
    readout.textContent = "";
  });

  return svg;
}
