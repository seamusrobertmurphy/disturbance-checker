import { STATE_PARCEL_SERVICES, StateParcelService } from "./states";

// Point query against the statewide parcel services.
//
// A click is sent to every state whose extent contains it, nearest state first,
// and the first service that returns a parcel answers. Extents overlap along
// borders, so a click near one is tried in both states. A service that answers
// with an ArcGIS error is tried once more after a pause, because North Dakota's
// returned "Unable to perform query" to identical requests that succeeded
// minutes later when tested on 2026-09-14.

export interface ParcelResult {
  service: StateParcelService;
  owner: string | null;
  parcelId: string | null;
  acres: string | null;
  address: string | null;
  county: string | null;
  properties: Record<string, unknown>;
  feature: { type: "Feature"; geometry: unknown; properties: Record<string, unknown> };
}

function servicesAt(lon: number, lat: number): StateParcelService[] {
  return STATE_PARCEL_SERVICES
    .filter(({ bbox: [w, s, e, n] }) => lon >= w && lon <= e && lat >= s && lat <= n)
    .sort((a, b) => centreDistance(a, lon, lat) - centreDistance(b, lon, lat));
}

function centreDistance(service: StateParcelService, lon: number, lat: number): number {
  const [w, s, e, n] = service.bbox;
  return Math.hypot((w + e) / 2 - lon, (s + n) / 2 - lat);
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
}

async function query(service: StateParcelService, lon: number, lat: number, signal: AbortSignal): Promise<ParcelResult | null> {
  const params = new URLSearchParams({
    geometry: `${lon},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "*",
    returnGeometry: "true",
    outSR: "4326",
    f: "geojson",
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`${service.url}/query?${params}`, { signal });
    if (!response.ok) throw new Error(`${service.state} answered HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) {
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        continue;
      }
      throw new Error(`${service.state}: ${body.error.message ?? "query failed"}`);
    }
    const feature = body.features?.[0];
    if (!feature) return null;
    const properties: Record<string, unknown> = feature.properties ?? {};
    const pick = (field: string | null) => (field ? text(properties[field]) : null);
    return {
      service,
      owner: pick(service.fields.owner),
      parcelId: pick(service.fields.parcelId),
      acres: pick(service.fields.acres),
      address: pick(service.fields.address),
      county: pick(service.fields.county),
      properties,
      feature: { type: "Feature", geometry: feature.geometry, properties },
    };
  }
  return null;
}

export async function lookUpParcel(
  lon: number,
  lat: number,
  signal: AbortSignal,
): Promise<{ result: ParcelResult | null; tried: string[]; errors: string[] }> {
  const tried: string[] = [];
  const errors: string[] = [];
  for (const service of servicesAt(lon, lat)) {
    tried.push(service.state);
    try {
      const result = await query(service, lon, lat, signal);
      if (result) return { result, tried, errors };
    } catch (error) {
      if (signal.aborted) throw error;
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { result: null, tried, errors };
}

export const COVERED_STATES = STATE_PARCEL_SERVICES.map((service) => service.state).sort();
export const OWNER_STATES = STATE_PARCEL_SERVICES.filter((service) => service.fields.owner)
  .map((service) => service.state)
  .sort();
