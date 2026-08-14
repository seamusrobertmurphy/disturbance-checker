import {
  gridBbox,
  lonLatToUtm,
  utmToLonLat,
  type TargetGrid,
} from "../raster/grid";
import { CLASS_NODATA } from "../analysis/deltas";

// Turning result arrays into something a map can draw.
//
// Earth Engine returned an XYZ tile URL and its servers did the colouring. With
// no server there are no tiles, so each layer is painted once into an RGBA
// buffer and handed to MapLibre as an image source pinned to the AOI corners.
//
// The palettes, ranges and the gamma are lifted unchanged from the production
// scripts, so a layer drawn here looks like the same layer drawn in QGIS. That
// matters more than it sounds: a verifier compares this screen against the
// QGIS output, and a ramp that merely resembles the original invites an
// argument about whether the difference is in the colours or the data.

export interface Rgba {
  // Explicitly backed by an ArrayBuffer, not an ArrayBufferLike. ImageData
  // refuses a SharedArrayBuffer-backed view, and the default typing of
  // Uint8ClampedArray leaves that possibility open.
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

/**
 * Interpolate a palette the way Earth Engine's visualisation parameters do:
 * the stops are spread evenly across min to max and the colour is mixed
 * linearly between the two neighbouring stops.
 */
function rampColor(
  value: number,
  min: number,
  max: number,
  stops: Array<[number, number, number]>,
): [number, number, number] {
  if (!Number.isFinite(value)) return [0, 0, 0];
  const t = Math.min(1, Math.max(0, (value - min) / (max - min)));
  const scaled = t * (stops.length - 1);
  const lower = Math.min(stops.length - 1, Math.floor(scaled));
  const upper = Math.min(stops.length - 1, lower + 1);
  const f = scaled - lower;
  return [
    Math.round(stops[lower][0] + (stops[upper][0] - stops[lower][0]) * f),
    Math.round(stops[lower][1] + (stops[upper][1] - stops[lower][1]) * f),
    Math.round(stops[lower][2] + (stops[upper][2] - stops[lower][2]) * f),
  ];
}

/**
 * Mapping from a lon/lat display grid onto the working UTM grid.
 *
 * MapLibre's image source pins an image to four corner coordinates and warps
 * whatever is between them linearly. A UTM grid pinned that way is close but
 * not right: the meridian convergence rotates north by up to three degrees at
 * a zone edge, and the warp cannot represent the curvature that goes with it.
 *
 * So the result is resampled onto a genuine lon/lat grid before it is drawn.
 * The index is built once and reused by every layer, which is what makes a
 * per-pixel inverse projection affordable: one pass, not one per layer.
 */
export interface Warp {
  width: number;
  height: number;
  /** Display bounds in lon/lat, [west, south, east, north]. */
  bounds: [number, number, number, number];
  /** Source pixel index per display pixel, -1 where the display falls outside. */
  index: Int32Array;
}

export function buildWarp(grid: TargetGrid, maxDimension = 2048): Warp {
  const [minX, minY, maxX, maxY] = gridBbox(grid);
  const corners = [
    utmToLonLat(grid.epsg, minX, maxY),
    utmToLonLat(grid.epsg, maxX, maxY),
    utmToLonLat(grid.epsg, maxX, minY),
    utmToLonLat(grid.epsg, minX, minY),
  ];
  const lons = corners.map(([lon]) => lon);
  const lats = corners.map(([, lat]) => lat);
  const bounds: [number, number, number, number] = [
    Math.min(...lons),
    Math.min(...lats),
    Math.max(...lons),
    Math.max(...lats),
  ];

  // Keep the display grid near the working resolution, but never let a very
  // large AOI produce an image the browser will refuse to upload as a texture.
  const scale = Math.min(1, maxDimension / Math.max(grid.width, grid.height));
  const width = Math.max(1, Math.round(grid.width * scale));
  const height = Math.max(1, Math.round(grid.height * scale));

  const index = new Int32Array(width * height);
  const lonStep = (bounds[2] - bounds[0]) / width;
  const latStep = (bounds[3] - bounds[1]) / height;

  for (let row = 0; row < height; row += 1) {
    // Pixel centres, not edges.
    const lat = bounds[3] - (row + 0.5) * latStep;
    for (let col = 0; col < width; col += 1) {
      const lon = bounds[0] + (col + 0.5) * lonStep;
      const [x, y] = lonLatToGridXy(grid, lon, lat);
      index[row * width + col] =
        x >= 0 && y >= 0 && x < grid.width && y < grid.height
          ? y * grid.width + x
          : -1;
    }
  }

  return { width, height, bounds, index };
}

function lonLatToGridXy(
  grid: TargetGrid,
  lon: number,
  lat: number,
): [number, number] {
  const [easting, northing] = lonLatToUtm(grid.epsg, lon, lat);
  return [
    Math.floor((easting - grid.originX) / grid.resolution),
    Math.floor((grid.originY - northing) / grid.resolution),
  ];
}

function allocate(warp: Warp): Rgba {
  return {
    data: new Uint8ClampedArray(warp.width * warp.height * 4),
    width: warp.width,
    height: warp.height,
  };
}

/**
 * SOP Step 7: class 0 is drawn transparent so the composite underneath shows
 * through wherever nothing was detected, which is what lets a verifier see
 * that an absence of colour is an absence of change rather than an absence of
 * data.
 */
export function paintClassified(
  classified: Uint8Array,
  palette: string[],
  warp: Warp,
): Rgba {
  const stops = palette.map(hexToRgb);
  const out = allocate(warp);
  for (let i = 0; i < warp.index.length; i += 1) {
    const source = warp.index[i];
    if (source < 0) continue;
    const value = classified[source];
    if (value === CLASS_NODATA || value === 0) continue;
    const [r, g, b] = stops[Math.min(stops.length - 1, value - 1)];
    const o = i * 4;
    out.data[o] = r;
    out.data[o + 1] = g;
    out.data[o + 2] = b;
    out.data[o + 3] = 255;
  }
  return out;
}

export function paintContinuous(
  values: Float32Array,
  palette: string[],
  min: number,
  max: number,
  warp: Warp,
): Rgba {
  const stops = palette.map(hexToRgb);
  const out = allocate(warp);
  for (let i = 0; i < warp.index.length; i += 1) {
    const source = warp.index[i];
    if (source < 0) continue;
    const value = values[source];
    if (Number.isNaN(value)) continue;
    const [r, g, b] = rampColor(value, min, max, stops);
    const o = i * 4;
    out.data[o] = r;
    out.data[o + 1] = g;
    out.data[o + 2] = b;
    out.data[o + 3] = 255;
  }
  return out;
}

export interface RgbOptions {
  min: number;
  max: number;
  gamma: number;
}

/**
 * True-colour composite from the reflectance bands.
 *
 * Built from B4, B3 and B2 rather than the catalogue's ready-made `visual`
 * asset, because the visual asset is a single scene with its own stretch and
 * no cloud masking. This is the composite the analysis actually ran on, which
 * is the only thing worth showing beneath a disturbance layer.
 */
export function paintRgb(
  red: Float32Array,
  green: Float32Array,
  blue: Float32Array,
  options: RgbOptions,
  warp: Warp,
): Rgba {
  const out = allocate(warp);
  const span = options.max - options.min;
  const inverseGamma = 1 / options.gamma;
  for (let i = 0; i < warp.index.length; i += 1) {
    const source = warp.index[i];
    if (source < 0) continue;
    const r = red[source];
    const g = green[source];
    const b = blue[source];
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) continue;
    const o = i * 4;
    out.data[o] = stretch(r, options.min, span, inverseGamma);
    out.data[o + 1] = stretch(g, options.min, span, inverseGamma);
    out.data[o + 2] = stretch(b, options.min, span, inverseGamma);
    out.data[o + 3] = 255;
  }
  return out;
}

function stretch(
  value: number,
  min: number,
  span: number,
  inverseGamma: number,
): number {
  const t = Math.min(1, Math.max(0, (value - min) / span));
  return Math.round(Math.pow(t, inverseGamma) * 255);
}

/**
 * Encode an RGBA buffer as a data URL.
 *
 * A data URL rather than a blob URL so nothing has to be revoked when a layer
 * is replaced. Runs re-run often, and a leaked blob URL per run is a slow leak
 * in a tab that stays open all afternoon.
 */
export function toDataUrl(image: Rgba): string {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The browser refused a 2D canvas context.");
  context.putImageData(
    new ImageData(image.data, image.width, image.height),
    0,
    0,
  );
  return canvas.toDataURL("image/png");
}

/** Corner coordinates for a MapLibre image source, clockwise from top left. */
export function warpCoordinates(
  warp: Warp,
): [[number, number], [number, number], [number, number], [number, number]] {
  const [west, south, east, north] = warp.bounds;
  return [
    [west, north],
    [east, north],
    [east, south],
    [west, south],
  ];
}
