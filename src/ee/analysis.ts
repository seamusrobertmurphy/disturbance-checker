import {
  AREA_MAX_PIXELS,
  AREA_SCALE,
  Breaks,
  CLASS_PALETTES,
  CLOUD_SCORE_BAND,
  CLOUD_SCORE_PLUS_COLLECTION,
  CONTINUOUS_MAX,
  CONTINUOUS_MIN,
  CONTINUOUS_PALETTE,
  CloudMethod,
  DELTAS,
  DeltaId,
  NDMI_VIS,
  NDVI_VIS,
  RGB_VIS,
  GSW_IMAGE,
  GSW_OCCURRENCE_THRESHOLD,
  HISTOGRAM_MAX,
  HISTOGRAM_MAX_PIXELS,
  HISTOGRAM_MIN,
  HISTOGRAM_SCALE,
  HISTOGRAM_STEPS,
  QA60_CIRRUS_BIT,
  QA60_CLOUD_BIT,
  S2_COLLECTION,
  S2_SCALE_DIVISOR,
} from "../defaults";
import { EarthEngineApi, evaluate, getTileUrl } from "./api";

export type Aoi =
  | { kind: "rectangle"; west: number; south: number; east: number; north: number }
  | { kind: "geojson"; geometry: unknown }
  | { kind: "asset"; assetId: string };

export interface Period {
  id: string;
  preStart: string;
  preEnd: string;
  postStart: string;
  postEnd: string;
}

export interface HistogramBin {
  start: number;
  count: number;
}

export interface DeltaResult {
  id: DeltaId;
  histogram: HistogramBin[];
  /** Hectares per class, index 0 = Low, 1 = Moderate, 2 = High. */
  areasHa: [number, number, number];
  tileUrlClassified: string;
  tileUrlContinuous: string;
}

export interface PeriodResult {
  periodId: string;
  preSceneCount: number;
  postSceneCount: number;
  deltas: Record<DeltaId, DeltaResult>;
  preRgbTileUrl: string;
  postRgbTileUrl: string;
  /** Single-date index layers, hidden by default but present for inspection. */
  indexTileUrls: {
    preNdvi: string;
    postNdvi: string;
    preNdmi: string;
    postNdmi: string;
  };
  utmCrs: string;
  aoiAreaHa: number;
}

export interface RunParams {
  aoi: Aoi;
  periods: Period[];
  maxCloud: number;
  cloudMethod: CloudMethod;
  clearThreshold: number;
  breaks: Record<DeltaId, Breaks>;
}

export function buildGeometry(ee: EarthEngineApi, aoi: Aoi): unknown {
  switch (aoi.kind) {
    case "rectangle":
      // SOP Step 3 warns that reversed coordinates yield an empty geometry
      // silently. Normalising here makes that impossible rather than merely
      // documented.
      return ee.Geometry.Rectangle([
        Math.min(aoi.west, aoi.east),
        Math.min(aoi.south, aoi.north),
        Math.max(aoi.west, aoi.east),
        Math.max(aoi.south, aoi.north),
      ]);
    case "geojson":
      return ee.Geometry(aoi.geometry);
    case "asset":
      return ee.FeatureCollection(aoi.assetId).geometry();
  }
}

/** SOP Step 4: QA60 cloud and cirrus bitmask. */
function maskClouds(ee: EarthEngineApi, image: unknown): unknown {
  const img = image as { select: (b: string) => any; updateMask: (m: unknown) => unknown };
  const qa = img.select("QA60");
  const cloudBit = 1 << QA60_CLOUD_BIT;
  const cirrusBit = 1 << QA60_CIRRUS_BIT;
  const mask = qa
    .bitwiseAnd(ee.Number(cloudBit))
    .eq(0)
    .and(qa.bitwiseAnd(ee.Number(cirrusBit)).eq(0));
  return img.updateMask(mask);
}

export interface Composite {
  image: any;
  collection: any;
}

export interface CompositeOptions {
  method: CloudMethod;
  /** Cloud Score+ per-pixel clarity floor. */
  clearThreshold: number;
  /** Scene-level ceiling, legacy QA60 path only. */
  maxCloud: number;
}

/**
 * Build the pre or post composite.
 *
 * The two methods are genuinely different reductions, not variations on one.
 *
 * Cloud Score+ links the `cs` quality band onto each scene, masks per pixel
 * below the clarity threshold, then takes a **qualityMosaic** on that band: for
 * every pixel it keeps the single clearest observation in the window. No
 * averaging happens, so there is no median normaliser to destabilise on thin
 * collections, and no scene-level cloud filter is needed because masking is
 * per pixel. This is what both production scripts run.
 *
 * QA60 masks on the cloud and cirrus bits, filters whole scenes by
 * CLOUDY_PIXEL_PERCENTAGE, then takes a **median**. Retained so a result
 * produced before the Cloud Score+ switch can be reproduced.
 */
export function buildComposite(
  ee: EarthEngineApi,
  roi: unknown,
  start: string,
  end: string,
  options: CompositeOptions,
): Composite {
  const base = ee
    .ImageCollection(S2_COLLECTION)
    .filterDate(start, end)
    .filterBounds(roi);

  if (options.method === "cloud-score-plus") {
    const csPlus = ee.ImageCollection(CLOUD_SCORE_PLUS_COLLECTION);
    const linked = base.linkCollection(csPlus, [CLOUD_SCORE_BAND]);
    const collection = linked.map((image: any) =>
      image.updateMask(
        image.select(CLOUD_SCORE_BAND).gte(options.clearThreshold),
      ),
    );
    const image = collection
      .qualityMosaic(CLOUD_SCORE_BAND)
      .divide(S2_SCALE_DIVISOR)
      .clip(roi);
    return { image, collection };
  }

  const collection = base
    .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", options.maxCloud))
    .map((image: unknown) => maskClouds(ee, image));

  const image = collection.median().divide(S2_SCALE_DIVISOR).clip(roi);

  return { image, collection };
}

/** SOP Step 5 index definitions. */
function indices(composite: any): { ndvi: any; ndmi: any; nbr: any } {
  return {
    ndvi: composite.normalizedDifference(["B8", "B4"]).rename("NDVI"),
    ndmi: composite.normalizedDifference(["B8", "B11"]).rename("NDMI"),
    nbr: composite.normalizedDifference(["B8A", "B12"]).rename("NBR"),
  };
}

/**
 * SOP Step 4: the water mask is applied at the delta stage, not the composite,
 * so the RGB layers retain water for visual context. unmask(1) keeps pixels
 * outside the GSW footprint valid.
 */
function waterMask(ee: EarthEngineApi): any {
  return ee
    .Image(GSW_IMAGE)
    .select("occurrence")
    .lt(GSW_OCCURRENCE_THRESHOLD)
    .unmask(1);
}

export function computeDeltas(
  ee: EarthEngineApi,
  pre: any,
  post: any,
): Record<DeltaId, any> {
  const preIdx = indices(pre);
  const postIdx = indices(post);
  const water = waterMask(ee);

  // SOP Step 5 sign convention. dNDVI and dNDMI are pre minus post so that a
  // positive value means loss; dNBR is post minus pre so that positive means
  // burned, matching MTBS and USFS R6.
  return {
    dNDVI: preIdx.ndvi.subtract(postIdx.ndvi).updateMask(water).rename("dNDVI"),
    dNDMI: preIdx.ndmi.subtract(postIdx.ndmi).updateMask(water).rename("dNDMI"),
    dNBR: postIdx.nbr.subtract(preIdx.nbr).updateMask(water).rename("dNBR"),
  };
}

/** SOP Step 7: 0 undisturbed, 1 Low, 2 Moderate, 3 High, as Int16. */
export function classifyDelta(
  ee: EarthEngineApi,
  delta: any,
  breaks: Breaks,
): any {
  return ee
    .Image(0)
    .where(delta.gte(breaks.low), 1)
    .where(delta.gte(breaks.moderate), 2)
    .where(delta.gte(breaks.high), 3)
    .toInt16()
    .rename("class")
    .updateMask(delta.mask());
}

export async function computeHistogram(
  ee: EarthEngineApi,
  delta: any,
  roi: unknown,
  bandName: string,
): Promise<HistogramBin[]> {
  const dictionary = delta.reduceRegion({
    reducer: ee.Reducer.fixedHistogram(
      HISTOGRAM_MIN,
      HISTOGRAM_MAX,
      HISTOGRAM_STEPS,
    ),
    geometry: roi,
    scale: HISTOGRAM_SCALE,
    maxPixels: HISTOGRAM_MAX_PIXELS,
  });

  const raw = await evaluate<Record<string, unknown>>(dictionary);
  const table = raw?.[bandName] as Array<[number, number]> | null | undefined;
  if (!Array.isArray(table)) return [];
  return table.map(([start, count]) => ({ start, count }));
}

/**
 * SOP Projection pitfalls: composites are returned in EPSG:4326, and anything
 * area-based must be computed on a metric grid. The UTM zone is derived from
 * the AOI centroid and passed to reduceRegion as the output projection.
 */
export function utmCrsForLonLat(lon: number, lat: number): string {
  const zone = Math.floor((lon + 180) / 6) + 1;
  const bounded = Math.min(60, Math.max(1, zone));
  const prefix = lat >= 0 ? 326 : 327;
  return `EPSG:${prefix}${String(bounded).padStart(2, "0")}`;
}

export async function centroidLonLat(
  roi: any,
): Promise<{ lon: number; lat: number }> {
  const coords = await evaluate<number[]>(roi.centroid(1).coordinates());
  return { lon: coords[0], lat: coords[1] };
}

export async function computeClassAreas(
  ee: EarthEngineApi,
  classified: any,
  roi: unknown,
  utmCrs: string,
): Promise<[number, number, number]> {
  const areaImage = ee.Image.pixelArea()
    .divide(10000)
    .addBands(classified);

  const grouped = areaImage.reduceRegion({
    reducer: ee.Reducer.sum().group({ groupField: 1, groupName: "class" }),
    geometry: roi,
    scale: AREA_SCALE,
    crs: utmCrs,
    maxPixels: AREA_MAX_PIXELS,
  });

  const raw = await evaluate<{ groups?: Array<{ class: number; sum: number }> }>(
    grouped,
  );
  const totals: [number, number, number] = [0, 0, 0];
  for (const group of raw?.groups ?? []) {
    if (group.class >= 1 && group.class <= 3) {
      totals[group.class - 1] = group.sum;
    }
  }
  return totals;
}

export async function computeAoiAreaHa(
  ee: EarthEngineApi,
  roi: any,
  utmCrs: string,
): Promise<number> {
  const dictionary = ee.Image.pixelArea().divide(10000).reduceRegion({
    reducer: ee.Reducer.sum(),
    geometry: roi,
    scale: AREA_SCALE,
    crs: utmCrs,
    maxPixels: AREA_MAX_PIXELS,
  });
  const raw = await evaluate<Record<string, number>>(dictionary);
  return Object.values(raw ?? {})[0] ?? 0;
}

export async function runPeriod(
  ee: EarthEngineApi,
  roi: any,
  period: Period,
  params: RunParams,
  utmCrs: string,
  aoiAreaHa: number,
  onProgress: (message: string) => void,
): Promise<PeriodResult> {
  onProgress(`${period.id}: building composites`);
  const compositeOptions = {
    method: params.cloudMethod,
    clearThreshold: params.clearThreshold,
    maxCloud: params.maxCloud,
  };
  const pre = buildComposite(
    ee,
    roi,
    period.preStart,
    period.preEnd,
    compositeOptions,
  );
  const post = buildComposite(
    ee,
    roi,
    period.postStart,
    period.postEnd,
    compositeOptions,
  );

  const [preSceneCount, postSceneCount] = await Promise.all([
    evaluate<number>(pre.collection.size()),
    evaluate<number>(post.collection.size()),
  ]);

  onProgress(`${period.id}: computing deltas`);
  const deltas = computeDeltas(ee, pre.image, post.image);

  const preIdx = {
    ndvi: pre.image.normalizedDifference(["B8", "B4"]).rename("NDVI"),
    ndmi: pre.image.normalizedDifference(["B8", "B11"]).rename("NDMI"),
  };
  const postIdx = {
    ndvi: post.image.normalizedDifference(["B8", "B4"]).rename("NDVI"),
    ndmi: post.image.normalizedDifference(["B8", "B11"]).rename("NDMI"),
  };

  const [
    preRgbTileUrl,
    postRgbTileUrl,
    preNdvi,
    postNdvi,
    preNdmi,
    postNdmi,
  ] = await Promise.all([
    getTileUrl(pre.image, RGB_VIS),
    getTileUrl(post.image, RGB_VIS),
    getTileUrl(preIdx.ndvi, NDVI_VIS),
    getTileUrl(postIdx.ndvi, NDVI_VIS),
    getTileUrl(preIdx.ndmi, NDMI_VIS),
    getTileUrl(postIdx.ndmi, NDMI_VIS),
  ]);

  const deltaResults = {} as Record<DeltaId, DeltaResult>;
  for (const id of Object.keys(DELTAS) as DeltaId[]) {
    onProgress(`${period.id}: ${id} histogram and classification`);
    const delta = deltas[id];
    const breaks = params.breaks[id];
    const classified = classifyDelta(ee, delta, breaks);
    // SOP Step 7: class 0 is masked so the underlying composite shows through.
    const shown = classified.updateMask(classified.gt(0));

    const [histogram, areasHa, tileUrlClassified, tileUrlContinuous] =
      await Promise.all([
        computeHistogram(ee, delta, roi, id),
        computeClassAreas(ee, classified, roi, utmCrs),
        getTileUrl(shown, {
          min: 1,
          max: 3,
          palette: CLASS_PALETTES[id],
        }),
        getTileUrl(delta, {
          min: CONTINUOUS_MIN,
          max: CONTINUOUS_MAX,
          palette: CONTINUOUS_PALETTE,
        }),
      ]);

    deltaResults[id] = {
      id,
      histogram,
      areasHa,
      tileUrlClassified,
      tileUrlContinuous,
    };
  }

  return {
    periodId: period.id,
    preSceneCount,
    postSceneCount,
    deltas: deltaResults,
    preRgbTileUrl,
    postRgbTileUrl,
    indexTileUrls: { preNdvi, postNdvi, preNdmi, postNdmi },
    utmCrs,
    aoiAreaHa,
  };
}
