import { Breaks } from "../defaults";
import { HistogramBin } from "../ee/analysis";
import { svgEl } from "./dom";

const WIDTH = 260;
const HEIGHT = 96;
const PAD_LEFT = 2;
const PAD_BOTTOM = 14;

export interface HistogramPlotOptions {
  bins: HistogramBin[];
  breaks: Breaks;
  defaults: Breaks;
  suggestedLow: number | null;
  onBreaksChange: (breaks: Breaks) => void;
}

type BreakKey = keyof Breaks;

/**
 * Renders the delta distribution with the three class breaks as draggable
 * handles. SOP Step 6 requires the histogram to be inspected before
 * classifying, so the breaks are manipulated against the distribution rather
 * than typed into a form in isolation.
 */
export function renderHistogramPlot(
  options: HistogramPlotOptions,
): SVGSVGElement {
  const { bins, defaults, suggestedLow } = options;
  let breaks = { ...options.breaks };

  const svg = svgEl("svg", {
    class: "dc-histogram",
    viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
    preserveAspectRatio: "none",
    role: "img",
  });

  const domainMin = bins.length ? bins[0].start : -0.5;
  const domainMax = bins.length ? bins[bins.length - 1].start : 0.8;
  const span = domainMax - domainMin || 1;
  const plotHeight = HEIGHT - PAD_BOTTOM;

  const toX = (value: number): number =>
    PAD_LEFT + ((value - domainMin) / span) * (WIDTH - PAD_LEFT * 2);
  const toValue = (x: number): number =>
    domainMin + ((x - PAD_LEFT) / (WIDTH - PAD_LEFT * 2)) * span;

  // Square-root scaling keeps the disturbance tail visible next to a noise bulk
  // that is typically two orders of magnitude taller.
  const maxCount = bins.reduce((max, bin) => Math.max(max, bin.count), 0);
  const scaleY = (count: number): number =>
    maxCount === 0 ? 0 : (Math.sqrt(count) / Math.sqrt(maxCount)) * plotHeight;

  const barWidth = bins.length
    ? Math.max(1, (WIDTH - PAD_LEFT * 2) / bins.length)
    : 1;

  for (const bin of bins) {
    const height = scaleY(bin.count);
    if (height <= 0) continue;
    svg.appendChild(
      svgEl("rect", {
        x: toX(bin.start),
        y: plotHeight - height,
        width: barWidth,
        height,
        class: "dc-histogram-bar",
      }),
    );
  }

  svg.appendChild(
    svgEl("line", {
      x1: PAD_LEFT,
      y1: plotHeight,
      x2: WIDTH - PAD_LEFT,
      y2: plotHeight,
      class: "dc-histogram-axis",
    }),
  );

  // Zero reference. A distribution not centred here is a systematic offset.
  svg.appendChild(
    svgEl("line", {
      x1: toX(0),
      y1: 0,
      x2: toX(0),
      y2: plotHeight,
      class: "dc-histogram-zero",
    }),
  );

  if (suggestedLow !== null) {
    svg.appendChild(
      svgEl("line", {
        x1: toX(suggestedLow),
        y1: 0,
        x2: toX(suggestedLow),
        y2: plotHeight,
        class: "dc-histogram-suggested",
      }),
    );
  }

  const handleKeys: BreakKey[] = ["low", "moderate", "high"];
  const lines = new Map<BreakKey, SVGLineElement>();
  const hits = new Map<BreakKey, SVGRectElement>();

  for (const key of handleKeys) {
    // The default position, drawn faintly, so a moved break is visibly a
    // deviation rather than an unremarkable value.
    svg.appendChild(
      svgEl("line", {
        x1: toX(defaults[key]),
        y1: 0,
        x2: toX(defaults[key]),
        y2: plotHeight,
        class: "dc-histogram-default",
      }),
    );

    const line = svgEl("line", {
      x1: toX(breaks[key]),
      y1: 0,
      x2: toX(breaks[key]),
      y2: plotHeight,
      class: `dc-histogram-break dc-histogram-break-${key}`,
    });
    svg.appendChild(line);
    lines.set(key, line);

    const hit = svgEl("rect", {
      x: toX(breaks[key]) - 5,
      y: 0,
      width: 10,
      height: plotHeight,
      class: "dc-histogram-handle",
      tabindex: 0,
      role: "slider",
      "aria-label": `${key} class break`,
      "aria-valuenow": breaks[key].toFixed(2),
    });
    svg.appendChild(hit);
    hits.set(key, hit);
  }

  const clampOrder = (key: BreakKey, value: number): number => {
    const bounded = Math.min(domainMax, Math.max(domainMin, value));
    const step = 0.005;
    if (key === "low") return Math.min(bounded, breaks.moderate - step);
    if (key === "moderate") {
      return Math.min(Math.max(bounded, breaks.low + step), breaks.high - step);
    }
    return Math.max(bounded, breaks.moderate + step);
  };

  const applyBreak = (key: BreakKey, value: number): void => {
    const next = Number(clampOrder(key, value).toFixed(3));
    if (next === breaks[key]) return;
    breaks = { ...breaks, [key]: next };
    const line = lines.get(key);
    const hit = hits.get(key);
    line?.setAttribute("x1", String(toX(next)));
    line?.setAttribute("x2", String(toX(next)));
    hit?.setAttribute("x", String(toX(next) - 5));
    hit?.setAttribute("aria-valuenow", next.toFixed(2));
    options.onBreaksChange({ ...breaks });
  };

  for (const key of handleKeys) {
    const hit = hits.get(key);
    if (!hit) continue;

    hit.addEventListener("pointerdown", (event: PointerEvent) => {
      event.preventDefault();
      hit.setPointerCapture(event.pointerId);
      const move = (moveEvent: PointerEvent) => {
        const rect = svg.getBoundingClientRect();
        const ratio = (moveEvent.clientX - rect.left) / rect.width;
        applyBreak(key, toValue(ratio * WIDTH));
      };
      const up = (upEvent: PointerEvent) => {
        hit.releasePointerCapture(upEvent.pointerId);
        hit.removeEventListener("pointermove", move);
        hit.removeEventListener("pointerup", up);
      };
      hit.addEventListener("pointermove", move);
      hit.addEventListener("pointerup", up);
    });

    hit.addEventListener("keydown", (event: KeyboardEvent) => {
      const step = event.shiftKey ? 0.05 : 0.01;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        applyBreak(key, breaks[key] - step);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        applyBreak(key, breaks[key] + step);
      }
    });
  }

  for (const tick of [-0.5, 0, 0.4, 0.8]) {
    if (tick < domainMin || tick > domainMax) continue;
    const label = svgEl("text", {
      x: toX(tick),
      y: HEIGHT - 3,
      class: "dc-histogram-tick",
      "text-anchor": tick === domainMin ? "start" : tick === domainMax ? "end" : "middle",
    });
    label.textContent = tick.toFixed(1);
    svg.appendChild(label);
  }

  return svg;
}
