import { lonLatToUtm, type GridBlock, type TargetGrid } from "./grid";

// Burning the area of interest onto the working grid.
//
// Earth Engine clipped every image to the ROI geometry and reduced over it, so
// a project boundary imported from a shapefile measured the polygon and not its
// bounding box. That clip has to be reproduced here or every hectare figure
// would be inflated by whatever the bounding box adds, which for a long thin
// riparian parcel or an L-shaped ownership can be most of the number.
//
// The fill is an even-odd scanline over pixel centres. Even-odd rather than
// non-zero winding so that a polygon with holes, which is how an inholding or
// an excluded wetland arrives, leaves its holes empty regardless of the order
// the rings were digitised in.

type Ring = Array<[number, number]>;

interface Edge {
  /** Projected coordinates, ordered so y0 < y1. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function collectRings(geometry: unknown, rings: Ring[]): void {
  const node = geometry as {
    type?: string;
    coordinates?: unknown;
    geometries?: unknown[];
    features?: unknown[];
    geometry?: unknown;
  } | null;
  if (!node || typeof node !== "object") return;

  switch (node.type) {
    case "FeatureCollection":
      for (const feature of node.features ?? []) collectRings(feature, rings);
      return;
    case "Feature":
      collectRings(node.geometry, rings);
      return;
    case "GeometryCollection":
      for (const child of node.geometries ?? []) collectRings(child, rings);
      return;
    case "Polygon":
      for (const ring of (node.coordinates ?? []) as Ring[]) rings.push(ring);
      return;
    case "MultiPolygon":
      for (const polygon of (node.coordinates ?? []) as Ring[][]) {
        for (const ring of polygon) rings.push(ring);
      }
      return;
    default:
      // Points and lines enclose no area and are ignored rather than refused,
      // because a boundary file often carries stray survey markers alongside
      // the parcel itself.
      return;
  }
}

/**
 * Rasterise a GeoJSON area of interest onto a grid.
 *
 * Returns 1 inside the polygon and 0 outside, one byte per grid pixel. Null
 * when the geometry encloses no area, which the caller should treat as "use the
 * whole grid" rather than "measure nothing".
 */
export function rasterizeAoi(
  geometry: unknown,
  grid: TargetGrid,
): Uint8Array | null {
  const rings: Ring[] = [];
  collectRings(geometry, rings);
  if (rings.length === 0) return null;

  // Project once. A boundary of a few thousand vertices costs a few thousand
  // transforms here, against one per pixel if it were done inside the scan.
  const edges: Edge[] = [];
  for (const ring of rings) {
    const projected = ring
      .filter(
        (point) =>
          Array.isArray(point) &&
          Number.isFinite(point[0]) &&
          Number.isFinite(point[1]),
      )
      .map(([lon, lat]) => lonLatToUtm(grid.epsg, lon, lat));
    for (let i = 0; i < projected.length; i += 1) {
      const [ax, ay] = projected[i];
      const [bx, by] = projected[(i + 1) % projected.length];
      if (ay === by) continue; // Horizontal edges cross no scanline.
      edges.push(
        ay < by
          ? { x0: ax, y0: ay, x1: bx, y1: by }
          : { x0: bx, y0: by, x1: ax, y1: ay },
      );
    }
  }
  if (edges.length === 0) return null;

  const mask = new Uint8Array(grid.width * grid.height);
  const crossings: number[] = [];

  for (let row = 0; row < grid.height; row += 1) {
    // Northing of the pixel centre.
    const y = grid.originY - (row + 0.5) * grid.resolution;
    crossings.length = 0;
    for (const edge of edges) {
      // Half-open in y so a vertex lying exactly on the scanline is counted
      // once rather than twice, which would flip the parity and leave a
      // one-pixel gash across the polygon.
      if (y < edge.y0 || y >= edge.y1) continue;
      const t = (y - edge.y0) / (edge.y1 - edge.y0);
      crossings.push(edge.x0 + t * (edge.x1 - edge.x0));
    }
    if (crossings.length < 2) continue;
    crossings.sort((a, b) => a - b);

    const offset = row * grid.width;
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const startX = crossings[i];
      const endX = crossings[i + 1];
      // Pixel centres between the two crossings.
      let from = Math.ceil((startX - grid.originX) / grid.resolution - 0.5);
      let to = Math.floor((endX - grid.originX) / grid.resolution - 0.5);
      if (from < 0) from = 0;
      if (to >= grid.width) to = grid.width - 1;
      for (let column = from; column <= to; column += 1) {
        mask[offset + column] = 1;
      }
    }
  }

  return mask;
}

/** The slice of a full-grid mask covering one block. */
export function maskForBlock(
  mask: Uint8Array | null,
  block: GridBlock,
  grid: TargetGrid,
): Uint8Array | null {
  if (!mask) return null;
  const out = new Uint8Array(block.width * block.height);
  for (let row = 0; row < block.height; row += 1) {
    const from = (block.y + row) * grid.width + block.x;
    out.set(mask.subarray(from, from + block.width), row * block.width);
  }
  return out;
}

/** Bounding box of a GeoJSON geometry in lon/lat, or null if it has none. */
export function boundsOf(
  geometry: unknown,
): { west: number; south: number; east: number; north: number } | null {
  const rings: Ring[] = [];
  collectRings(geometry, rings);
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const ring of rings) {
    for (const point of ring) {
      if (!Array.isArray(point)) continue;
      const [lon, lat] = point;
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
  }
  return Number.isFinite(west) ? { west, south, east, north } : null;
}
