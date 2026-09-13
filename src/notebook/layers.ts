import { GeoLibreAppAPI } from "../types/geolibre";

// Lets GeoLibre's notebook put Earth Engine layers on the main map.
//
// GeoLibre's own notebook bridge accepts only map commands with no tile layer
// among them, so a notebook could draw Earth Engine imagery inside its own
// output cells but never in the Layers panel. The plugin API does carry
// addTileLayer, which files a layer exactly as Add Data would. This exposes
// that one call on the page, where the notebook's Earth Engine listener
// (running in this window, beside the signed-in window.ee) can reach it.
//
// A layer added here belongs to the operator, not to this tool: it is removed
// from the Layers panel like any other, and nothing in a disturbance run reads
// it.
//
// Only Earth Engine tile URLs are accepted. The handle sits on window, so any
// script on the page could call it, and the narrowest useful door is one that
// opens onto Google's map tiles and nothing else.

export const NOTEBOOK_HANDLE = "__disturbanceCheckNotebook";

const EARTH_ENGINE_TILE_HOSTS = new Set([
  "earthengine.googleapis.com",
  "earthengine-highvolume.googleapis.com",
]);

export interface NotebookTileLayer {
  name: string;
  url: string;
  visible?: boolean;
  opacity?: number;
}

function checkedTileUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url.replace(/\{[xyz]\}/g, "0"));
  } catch {
    throw new Error(`Not a tile URL: ${url}`);
  }
  if (parsed.protocol !== "https:" || !EARTH_ENGINE_TILE_HOSTS.has(parsed.hostname)) {
    throw new Error(`Only Earth Engine tile URLs are accepted, not ${parsed.hostname}`);
  }
  if (!["{x}", "{y}", "{z}"].every((token) => url.includes(token))) {
    throw new Error("The tile URL must carry {x}, {y} and {z}");
  }
  return url;
}

export function exposeNotebookLayers(app: GeoLibreAppAPI): () => void {
  const addTileLayer = app.addTileLayer;
  if (!addTileLayer) return () => {};

  const handle = {
    addTileLayer(layer: NotebookTileLayer): string {
      const name = String(layer.name || "Earth Engine layer").slice(0, 200);
      const opacity =
        typeof layer.opacity === "number"
          ? Math.min(1, Math.max(0, layer.opacity))
          : undefined;
      return addTileLayer(name, checkedTileUrl(String(layer.url)), {
        attribution: "Google Earth Engine",
        visible: layer.visible !== false,
        opacity,
      });
    },
  };

  const scope = window as unknown as Record<string, unknown>;
  scope[NOTEBOOK_HANDLE] = handle;
  return () => {
    if (scope[NOTEBOOK_HANDLE] === handle) delete scope[NOTEBOOK_HANDLE];
  };
}
