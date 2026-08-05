import { GeoLibreAppAPI } from "../types/geolibre";

// GeoLibreAppAPI exposes no removeLayer, so a layer created through
// addGeoJsonLayer or addTileLayer can never be taken away again. Because this
// tool re-runs repeatedly within a session, every layer it creates is drawn
// directly on the MapLibre instance and registered with
// registerExternalNativeLayer, which does have an unregister counterpart. That
// keeps the Layer panel in charge of visibility, opacity and ordering while
// leaving removal under the plugin's control.

interface MapLibreLike {
  addSource: (id: string, source: Record<string, unknown>) => void;
  removeSource: (id: string) => void;
  getSource: (id: string) => unknown;
  addLayer: (layer: Record<string, unknown>, beforeId?: string) => void;
  removeLayer: (id: string) => void;
  getLayer: (id: string) => unknown;
  isStyleLoaded?: () => boolean;
  once?: (event: string, handler: () => void) => void;
}

export type VectorRole = "boundary" | "smz" | "plots";

export interface ManagedLayer {
  id: string;
  sourceIds: string[];
  nativeLayerIds: string[];
}

const PREFIX = "tuvsud-dc";

export class MapLayerManager {
  private managed = new Map<string, ManagedLayer>();

  constructor(private readonly app: GeoLibreAppAPI) {}

  private map(): MapLibreLike | null {
    const map = this.app.getMap?.() as MapLibreLike | null | undefined;
    if (!map || typeof map.addSource !== "function") return null;
    return map;
  }

  private ready(map: MapLibreLike): boolean {
    return map.isStyleLoaded ? map.isStyleLoaded() : true;
  }

  /** Remove every layer this plugin created whose id starts with the prefix. */
  removeByPrefix(prefix: string): void {
    for (const id of [...this.managed.keys()]) {
      if (id.startsWith(prefix)) this.remove(id);
    }
  }

  removeAll(): void {
    for (const id of [...this.managed.keys()]) this.remove(id);
  }

  remove(id: string): void {
    const entry = this.managed.get(id);
    if (!entry) return;
    this.app.unregisterExternalNativeLayer?.(id);

    const map = this.map();
    if (map) {
      for (const layerId of entry.nativeLayerIds) {
        try {
          if (map.getLayer(layerId)) map.removeLayer(layerId);
        } catch {
          // The style may have been swapped underneath us.
        }
      }
      for (const sourceId of entry.sourceIds) {
        try {
          if (map.getSource(sourceId)) map.removeSource(sourceId);
        } catch {
          // Same.
        }
      }
    }
    this.managed.delete(id);
  }

  /**
   * Add an Earth Engine XYZ raster. Undisturbed pixels are already masked out
   * server-side, so the tiles carry transparency and the basemap shows through
   * wherever nothing was detected.
   */
  addRaster(options: {
    key: string;
    name: string;
    tileUrl: string;
    visible: boolean;
    opacity?: number;
  }): void {
    const map = this.map();
    if (!map) return;
    const id = `${PREFIX}-${options.key}`;
    this.remove(id);

    const sourceId = `${id}-src`;
    const layerId = `${id}-lyr`;

    const draw = () => {
      try {
        map.addSource(sourceId, {
          type: "raster",
          tiles: [options.tileUrl],
          tileSize: 256,
          attribution: "Google Earth Engine / Copernicus Sentinel-2",
        });
        map.addLayer({
          id: layerId,
          type: "raster",
          source: sourceId,
          layout: { visibility: options.visible ? "visible" : "none" },
          paint: { "raster-opacity": options.opacity ?? 1 },
        });
      } catch {
        return;
      }

      this.managed.set(id, {
        id,
        sourceIds: [sourceId],
        nativeLayerIds: [layerId],
      });
      this.app.registerExternalNativeLayer?.({
        id,
        name: options.name,
        type: "raster",
        nativeLayerIds: [layerId],
        sourceIds: [sourceId],
        opacity: options.opacity ?? 1,
        metadata: { sourceKind: "tuvsud-disturbance-check", ephemeral: true },
      });
    };

    if (this.ready(map)) draw();
    else map.once?.("styledata", draw);
  }

  /**
   * Add an uploaded context layer. Plot points carry a label drawn from the
   * detected identifier field, so any screenshot taken of a disturbance polygon
   * can be tied to a plot without a separate legend.
   */
  addVector(options: {
    key: string;
    name: string;
    geojson: unknown;
    role: VectorRole;
    labelField?: string | null;
    color: string;
  }): void {
    const map = this.map();
    if (!map) return;
    const id = `${PREFIX}-${options.key}`;
    this.remove(id);

    const sourceId = `${id}-src`;
    const nativeLayerIds: string[] = [];

    const draw = () => {
      try {
        map.addSource(sourceId, { type: "geojson", data: options.geojson });

        if (options.role === "plots") {
          const circleId = `${id}-circle`;
          map.addLayer({
            id: circleId,
            type: "circle",
            source: sourceId,
            paint: {
              "circle-radius": 5,
              "circle-color": options.color,
              "circle-stroke-color": "#ffffff",
              "circle-stroke-width": 1.5,
            },
          });
          nativeLayerIds.push(circleId);

          if (options.labelField) {
            const labelId = `${id}-label`;
            map.addLayer({
              id: labelId,
              type: "symbol",
              source: sourceId,
              layout: {
                "text-field": ["to-string", ["get", options.labelField]],
                "text-size": 12,
                "text-anchor": "top",
                "text-offset": [0, 0.7],
                // Plot identifiers must stay readable when points cluster, so
                // collision hiding is disabled deliberately.
                "text-allow-overlap": true,
                "text-ignore-placement": false,
              },
              paint: {
                "text-color": "#ffffff",
                "text-halo-color": "#000000",
                "text-halo-width": 1.6,
              },
            });
            nativeLayerIds.push(labelId);
          }
        } else {
          const fillId = `${id}-fill`;
          const lineId = `${id}-line`;
          map.addLayer({
            id: fillId,
            type: "fill",
            source: sourceId,
            paint: {
              "fill-color": options.color,
              "fill-opacity": options.role === "smz" ? 0.18 : 0.04,
            },
          });
          map.addLayer({
            id: lineId,
            type: "line",
            source: sourceId,
            paint: {
              "line-color": options.color,
              "line-width": options.role === "boundary" ? 2.5 : 1.5,
              "line-dasharray": options.role === "smz" ? [3, 2] : [1, 0],
            },
          });
          nativeLayerIds.push(fillId, lineId);
        }
      } catch {
        return;
      }

      this.managed.set(id, { id, sourceIds: [sourceId], nativeLayerIds });
      this.app.registerExternalNativeLayer?.({
        id,
        name: options.name,
        type: "geojson",
        nativeLayerIds,
        sourceIds: [sourceId],
        geojson: options.geojson,
        style: options.labelField
          ? {
              labels: {
                enabled: true,
                field: options.labelField,
                size: 12,
                color: "#ffffff",
                haloColor: "#000000",
                haloWidth: 1.6,
                allowOverlap: true,
                anchor: "top",
                offsetY: 0.7,
              },
            }
          : undefined,
        metadata: {
          sourceKind: "tuvsud-disturbance-check-context",
          role: options.role,
        },
      });
    };

    if (this.ready(map)) draw();
    else map.once?.("styledata", draw);
  }

  has(key: string): boolean {
    return this.managed.has(`${PREFIX}-${key}`);
  }
}

export const RASTER_PREFIX = `${PREFIX}-r-`;
export const rasterKey = (suffix: string): string => `r-${suffix}`;
