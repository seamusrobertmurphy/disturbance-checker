import proj4 from "proj4";
import { ANALYSIS_SCALE } from "../defaults";

// The working grid.
//
// Earth Engine returned composites in EPSG:4326 and the SOP had to pass an
// explicit UTM projection to every area reduction to avoid measuring hectares
// on a degree grid. That whole class of error disappears here: Sentinel-2 COGs
// are already written on a UTM grid, so the tool computes on the pixels as
// stored. A pixel is exactly resolution squared, and an area is a pixel count
// times that constant. Nothing is reprojected before it is measured.
//
// Reprojection happens once, at the very end, and only to draw the result on a
// web map. Numbers never travel through it.

export const WGS84 = "EPSG:4326";

/**
 * Metres per pixel of the working grid.
 *
 * The SOP's own analysis scale, and the native resolution of B11, B12 and SCL.
 * Sampling the 10 m bands down to it loses nothing the reductions would have
 * kept, and quarters the memory.
 */
export const GRID_RESOLUTION = ANALYSIS_SCALE;

export interface TargetGrid {
  /** UTM zone of the working grid, e.g. 32610. */
  epsg: number;
  /** Easting of the west edge of the first column, metres. */
  originX: number;
  /** Northing of the north edge of the first row, metres. */
  originY: number;
  resolution: number;
  width: number;
  height: number;
}

export interface GridBlock {
  /** Column of the first pixel, relative to the parent grid. */
  x: number;
  /** Row of the first pixel, relative to the parent grid. */
  y: number;
  width: number;
  height: number;
  /** Bounding box in grid CRS metres, [minX, minY, maxX, maxY]. */
  bbox: [number, number, number, number];
}

function utmDefinition(epsg: number): string {
  const zone = epsg % 100;
  const south = Math.floor(epsg / 100) === 327;
  if (zone < 1 || zone > 60) {
    throw new Error(`EPSG:${epsg} is not a UTM zone code.`);
  }
  return `+proj=utm +zone=${zone}${south ? " +south" : ""} +datum=WGS84 +units=m +no_defs`;
}

/** Cache the proj4 converters: a run transforms a handful of points, but the
 * definition parse is not free and the AOI is transformed per block. */
const converters = new Map<number, proj4.Converter>();

function converter(epsg: number): proj4.Converter {
  let held = converters.get(epsg);
  if (!held) {
    held = proj4(WGS84, utmDefinition(epsg));
    converters.set(epsg, held);
  }
  return held;
}

export function lonLatToUtm(
  epsg: number,
  lon: number,
  lat: number,
): [number, number] {
  const [x, y] = converter(epsg).forward([lon, lat]);
  return [x, y];
}

export function utmToLonLat(
  epsg: number,
  x: number,
  y: number,
): [number, number] {
  const [lon, lat] = converter(epsg).inverse([x, y]);
  return [lon, lat];
}

/**
 * The UTM zone whose central meridian is nearest a longitude.
 *
 * Kept from the Earth Engine implementation, where it derived the projection
 * for every area reduction. Here it only picks a working grid when the AOI does
 * not sit cleanly inside one MGRS tile's zone.
 */
export function utmEpsgForLonLat(lon: number, lat: number): number {
  const zone = Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
  return (lat >= 0 ? 32600 : 32700) + zone;
}

/**
 * Build a grid covering a lon/lat bounding box.
 *
 * The origin is snapped to a whole multiple of the resolution so the grid lines
 * up with the Sentinel-2 pixel edges, whose own origins are multiples of 10 m.
 * Without the snap every read would land between source pixels and resample
 * where it could have sampled.
 */
export function gridForBounds(
  epsg: number,
  bounds: { west: number; south: number; east: number; north: number },
  resolution: number = GRID_RESOLUTION,
): TargetGrid {
  // Project all four corners, not two. A UTM grid is not axis-aligned with
  // lon/lat, so the east edge of the box is a curve and taking only the
  // south-west and north-east corners would clip the bulge.
  const corners: Array<[number, number]> = [
    lonLatToUtm(epsg, bounds.west, bounds.south),
    lonLatToUtm(epsg, bounds.east, bounds.south),
    lonLatToUtm(epsg, bounds.west, bounds.north),
    lonLatToUtm(epsg, bounds.east, bounds.north),
  ];
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);

  const minX = Math.floor(Math.min(...xs) / resolution) * resolution;
  const maxX = Math.ceil(Math.max(...xs) / resolution) * resolution;
  const minY = Math.floor(Math.min(...ys) / resolution) * resolution;
  const maxY = Math.ceil(Math.max(...ys) / resolution) * resolution;

  return {
    epsg,
    originX: minX,
    originY: maxY,
    resolution,
    width: Math.max(1, Math.round((maxX - minX) / resolution)),
    height: Math.max(1, Math.round((maxY - minY) / resolution)),
  };
}

export function gridPixelCount(grid: TargetGrid): number {
  return grid.width * grid.height;
}

/** Hectares covered by one pixel. Exact, because the grid is metric. */
export function pixelAreaHa(grid: TargetGrid): number {
  return (grid.resolution * grid.resolution) / 10000;
}

/** Grid extent in CRS metres, [minX, minY, maxX, maxY]. */
export function gridBbox(grid: TargetGrid): [number, number, number, number] {
  return [
    grid.originX,
    grid.originY - grid.height * grid.resolution,
    grid.originX + grid.width * grid.resolution,
    grid.originY,
  ];
}

/**
 * Split a grid into blocks.
 *
 * A run holds every band of every scene in memory at once to take a per-pixel
 * median, so peak memory is scenes times bands times block pixels. Blocking
 * makes that a constant the AOI cannot inflate: a 200,000 ha project costs the
 * same per block as a 200 ha one, it simply has more of them.
 */
export function blocksFor(grid: TargetGrid, blockSize: number): GridBlock[] {
  const blocks: GridBlock[] = [];
  for (let y = 0; y < grid.height; y += blockSize) {
    for (let x = 0; x < grid.width; x += blockSize) {
      const width = Math.min(blockSize, grid.width - x);
      const height = Math.min(blockSize, grid.height - y);
      const minX = grid.originX + x * grid.resolution;
      const maxY = grid.originY - y * grid.resolution;
      blocks.push({
        x,
        y,
        width,
        height,
        bbox: [
          minX,
          maxY - height * grid.resolution,
          minX + width * grid.resolution,
          maxY,
        ],
      });
    }
  }
  return blocks;
}

/** Lon/lat of a grid's corners, in the order MapLibre's image source wants:
 * top-left, top-right, bottom-right, bottom-left. */
export function gridCornersLonLat(
  grid: TargetGrid,
): [[number, number], [number, number], [number, number], [number, number]] {
  const [minX, minY, maxX, maxY] = gridBbox(grid);
  return [
    utmToLonLat(grid.epsg, minX, maxY),
    utmToLonLat(grid.epsg, maxX, maxY),
    utmToLonLat(grid.epsg, maxX, minY),
    utmToLonLat(grid.epsg, minX, minY),
  ];
}
