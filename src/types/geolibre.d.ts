// Local declaration of the subset of GeoLibre's plugin API this tool uses.
//
// @geolibre/plugins is a private workspace package and is not published to npm,
// so an external plugin cannot import its types. Everything here mirrors
// packages/plugins/src/types.ts in the GeoLibre repository. Members the host may
// not implement are optional, matching the upstream interface, and every call
// site guards for absence.

export type GeoLibreRightPanelDock =
  | "left-of-layers"
  | "right-of-layers"
  | "left-of-style"
  | "right-of-style"
  | "replace-style"
  | "replace-layers";

export interface GeoLibreRightPanelRegistration {
  id: string;
  title: string;
  dock?: GeoLibreRightPanelDock;
  render: (container: HTMLElement) => void;
  destroy?: () => void;
}

export interface GeoLibreFloatingPanelRegistration {
  id: string;
  title: string;
  width?: number;
  height?: number;
  render: (container: HTMLElement) => void;
  destroy?: () => void;
}

export interface GeoLibreTileLayerOptions {
  tiles?: string[];
  type?: "xyz" | "wms" | "wmts" | "raster";
  url?: string;
  tileSize?: number;
  attribution?: string;
  bounds?: [number, number, number, number];
  minzoom?: number;
  maxzoom?: number;
  visible?: boolean;
  opacity?: number;
  metadata?: Record<string, unknown>;
}

export interface GeoLibreAppAPI {
  addGeoJsonLayer: (
    name: string,
    data: unknown,
    sourcePath?: string,
  ) => string;
  addTileLayer?: (
    name: string,
    url: string,
    options?: GeoLibreTileLayerOptions,
  ) => string;
  removeLayer?: (id: string) => void;
  updateLayer?: (id: string, patch: Record<string, unknown>) => void;
  setLayerVisibility?: (id: string, visible: boolean) => void;
  getMap?: () => unknown;
  registerRightPanel?: (
    panel: GeoLibreRightPanelRegistration,
  ) => () => void;
  unregisterRightPanel?: (id: string) => void;
  openRightPanel?: (id: string) => boolean;
  registerFloatingPanel?: (
    panel: GeoLibreFloatingPanelRegistration,
  ) => () => void;
  openFloatingPanel?: (id: string) => boolean;
}

export interface GeoLibrePlugin {
  id: string;
  name: string;
  version: string;
  activeByDefault?: boolean;
  urlParameterNames?: string[];
  activate: (app: GeoLibreAppAPI) => boolean | void | Promise<boolean | void>;
  deactivate: (app: GeoLibreAppAPI) => void;
  handleUrlParameters?: (
    app: GeoLibreAppAPI,
    params: URLSearchParams,
  ) => void | Promise<void>;
  getProjectState?: () => unknown;
  applyProjectState?: (app: GeoLibreAppAPI, state: unknown) => boolean | void;
}
