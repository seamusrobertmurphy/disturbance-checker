// A small ArcGIS REST client, enough for the corroborating datasets.
//
// The USFS publishes its enterprise data warehouse as ordinary ArcGIS map
// services that answer anonymous requests and reflect the calling origin in
// `access-control-allow-origin`. No key, no token, no account, which is the
// only reason these can be part of this tool at all.
//
// Two request shapes carry everything. A statistics query aggregates on the
// server and returns a handful of rows, which is how a summary is produced
// without paging through thousands of polygons. A GeoJSON query returns the
// geometry itself, for drawing.

export interface ServiceLayer {
  id: number;
  name: string;
}

async function getJson(
  url: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  const query = new URLSearchParams(params);
  const response = await fetch(`${url}?${query}`, { signal });
  if (!response.ok) {
    throw new Error(
      `${url} returned ${response.status} ${response.statusText}.`,
    );
  }
  const payload = (await response.json()) as { error?: { message?: string } };
  // ArcGIS reports failures inside a 200 response, so the status code alone
  // is not evidence the query worked.
  if (payload && typeof payload === "object" && payload.error) {
    throw new Error(payload.error.message ?? "The service rejected the query.");
  }
  return payload;
}

/** The layers a map service exposes, in the order it lists them. */
export async function serviceLayers(
  serviceUrl: string,
  signal?: AbortSignal,
): Promise<ServiceLayer[]> {
  const payload = (await getJson(serviceUrl, { f: "json" }, signal)) as {
    layers?: Array<{ id: number; name: string }>;
  };
  return (payload.layers ?? []).map((layer) => ({
    id: layer.id,
    name: layer.name,
  }));
}

export interface Statistic {
  statisticType: "sum" | "count" | "min" | "max" | "avg";
  onStatisticField: string;
  outStatisticFieldName: string;
}

export interface StatsQuery {
  where?: string;
  /** Lon/lat bounds, [west, south, east, north]. */
  bbox: [number, number, number, number];
  groupBy: string[];
  statistics: Statistic[];
  signal?: AbortSignal;
}

/**
 * Aggregate on the server.
 *
 * The alternative is to fetch every intersecting record and total them here,
 * which the services will not allow anyway: the insect survey caps a response
 * at two thousand features, and a decade over a large ownership exceeds that
 * without warning. A truncated total that looks like a total is precisely the
 * kind of number that must not reach a finding.
 */
export async function queryStats(
  layerUrl: string,
  query: StatsQuery,
): Promise<Array<Record<string, unknown>>> {
  const payload = (await getJson(
    `${layerUrl}/query`,
    {
      where: query.where ?? "1=1",
      geometry: query.bbox.join(","),
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outStatistics: JSON.stringify(query.statistics),
      groupByFieldsForStatistics: query.groupBy.join(","),
      f: "json",
    },
    query.signal,
  )) as { features?: Array<{ attributes?: Record<string, unknown> }> };

  return (payload.features ?? []).map((feature) => feature.attributes ?? {});
}

export interface FeatureQuery {
  where?: string;
  bbox: [number, number, number, number];
  outFields?: string[];
  /** Server-side generalisation in degrees, to keep a browser draw cheap. */
  simplify?: number;
  limit?: number;
  signal?: AbortSignal;
}

/** Intersecting features as GeoJSON, ready to hand to MapLibre. */
export async function queryGeoJson(
  layerUrl: string,
  query: FeatureQuery,
): Promise<{ type: "FeatureCollection"; features: unknown[] }> {
  const params: Record<string, string> = {
    where: query.where ?? "1=1",
    geometry: query.bbox.join(","),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    outSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: (query.outFields ?? ["*"]).join(","),
    returnGeometry: "true",
    f: "geojson",
  };
  if (query.simplify) {
    params.maxAllowableOffset = String(query.simplify);
  }
  if (query.limit) {
    params.resultRecordCount = String(query.limit);
  }

  const payload = (await getJson(`${layerUrl}/query`, params, query.signal)) as {
    features?: unknown[];
  };
  return { type: "FeatureCollection", features: payload.features ?? [] };
}
