import { GeoLibreAppAPI } from "../types/geolibre";

// Survey records under the cursor for the insect and disease survey layers.
//
// Those layers are pictures the Forest Service server draws, so the map holds
// no records to read. When the pointer rests on the map for a moment, or on a
// right click, this asks the same services for the records at that point, for
// the survey years switched on in the Layers panel, and shows them in a card
// beside the cursor. Resting shows a card that follows the pointer; a right
// click pins one until it is closed. Nothing is requested while every survey
// layer is switched off.

// USDA Forest Service Insect and Disease Survey, damage points (layer 0) and areas (layer 1)
// https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_InsectandDiseaseSurvey_01/MapServer
const IDS = "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_InsectandDiseaseSurvey_01/MapServer";
// Tree Canopy Assessment, tree mortality 0 to 5 years, derived from the aerial survey
// https://imagery.geoplatform.gov/iipp/rest/services/Ecosystems/USFS_EDW_TCA_TreeMortality_0_5/ImageServer
const TCA = "https://imagery.geoplatform.gov/iipp/rest/services/Ecosystems/USFS_EDW_TCA_TreeMortality_0_5/ImageServer";

const AREA_FIELDS = [
  "survey_year", "dca_common_name", "host", "damage_type", "percent_affected",
  "legacy_severity", "acres", "label", "notes",
];
const POINT_FIELDS = [
  "survey_year", "dca_common_name", "host", "damage_type",
  "number_of_trees_count_range", "tree_count", "label", "notes",
];

const HOVER_DELAY_MS = 350;
const AREA_TOLERANCE_PX = 3;
const POINT_TOLERANCE_PX = 8;
const MAX_RECORDS = 6;

interface Point2 { x: number; y: number }
interface LngLat { lng: number; lat: number }
interface MouseEvent2 {
  point: Point2;
  lngLat: LngLat;
  originalEvent?: { clientX: number; clientY: number };
}
type Handler = (event: MouseEvent2) => void;

interface SurveyMap {
  on(event: string, handler: Handler | (() => void)): void;
  off(event: string, handler: Handler | (() => void)): void;
  getStyle(): { layers?: Array<{ id: string }> } | undefined;
  getLayer(id: string): { minzoom?: number; maxzoom?: number } | undefined;
  getSource(id: string): { minzoom?: number } | undefined;
  getLayoutProperty(id: string, name: string): unknown;
  getPaintProperty(id: string, name: string): unknown;
  getZoom(): number;
  unproject(point: [number, number]): LngLat;
  getContainer(): HTMLElement;
}

/** Which survey layers are switched on and drawn at the current zoom. */
export function visibleSurvey(map: SurveyMap): { areaYears: number[]; pointYears: number[]; mortality: boolean } {
  const areaYears: number[] = [];
  const pointYears: number[] = [];
  let mortality = false;
  const zoom = map.getZoom();
  for (const { id } of map.getStyle()?.layers ?? []) {
    const match = /^layer-corroboration-(ids-points|ids|tca-mortality)(?:-(\d{4}))?-raster$/.exec(id);
    if (!match) continue;
    if (map.getLayoutProperty(id, "visibility") === "none") continue;
    const opacity = map.getPaintProperty(id, "raster-opacity");
    if (typeof opacity === "number" && opacity <= 0) continue;
    const sourceMin = map.getSource(`source-${id.slice("layer-".length, -"-raster".length)}`)?.minzoom ?? 0;
    const layer = map.getLayer(id);
    if (zoom < Math.max(sourceMin, layer?.minzoom ?? 0) || zoom >= (layer?.maxzoom ?? 24)) continue;
    if (match[1] === "tca-mortality") mortality = true;
    else (match[1] === "ids" ? areaYears : pointYears).push(Number(match[2]));
  }
  return { areaYears, pointYears, mortality };
}

type Record_ = Record<string, string | number | null>;

async function queryLayer(
  layer: 0 | 1, years: number[], fields: string[], box: [LngLat, LngLat], signal: AbortSignal,
): Promise<Record_[]> {
  if (years.length === 0) return [];
  const [a, b] = box;
  const params = new URLSearchParams({
    where: `survey_year IN (${years.join(",")})`,
    geometry: [Math.min(a.lng, b.lng), Math.min(a.lat, b.lat), Math.max(a.lng, b.lng), Math.max(a.lat, b.lat)].join(","),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: fields.join(","),
    orderByFields: "survey_year DESC",
    returnGeometry: "false",
    resultRecordCount: String(MAX_RECORDS + 1),
    f: "json",
  });
  const response = await fetch(`${IDS}/${layer}/query?${params}`, { signal });
  if (!response.ok) throw new Error(`the survey service answered HTTP ${response.status}`);
  const body = (await response.json()) as { features?: Array<{ attributes: Record_ }>; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? "the survey service returned an error");
  return (body.features ?? []).map((feature) => feature.attributes);
}

async function mortalityAt(at: LngLat, signal: AbortSignal): Promise<boolean> {
  const params = new URLSearchParams({
    geometry: JSON.stringify({ x: at.lng, y: at.lat, spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryPoint",
    returnGeometry: "false",
    returnCatalogItems: "false",
    f: "json",
  });
  const response = await fetch(`${TCA}/identify?${params}`, { signal });
  if (!response.ok) throw new Error(`the tree mortality service answered HTTP ${response.status}`);
  const body = (await response.json()) as { value?: string };
  return body.value !== undefined && body.value !== "NoData" && Number(body.value) > 0;
}

interface Found { areas: Record_[]; points: Record_[]; mortality: boolean }

async function lookUp(map: SurveyMap, event: MouseEvent2, signal: AbortSignal): Promise<Found | null> {
  const { areaYears, pointYears, mortality } = visibleSurvey(map);
  if (areaYears.length === 0 && pointYears.length === 0 && !mortality) return null;
  const around = (px: number): [LngLat, LngLat] => [
    map.unproject([event.point.x - px, event.point.y + px]),
    map.unproject([event.point.x + px, event.point.y - px]),
  ];
  const [areas, points, dead] = await Promise.all([
    queryLayer(1, areaYears, AREA_FIELDS, around(AREA_TOLERANCE_PX), signal),
    queryLayer(0, pointYears, POINT_FIELDS, around(POINT_TOLERANCE_PX), signal),
    mortality ? mortalityAt(event.lngLat, signal) : Promise.resolve(false),
  ]);
  return { areas, points, mortality: dead };
}

function text(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s : null;
}

function recordBlock(record: Record_, kind: "area" | "point"): HTMLElement {
  const block = document.createElement("div");
  block.className = "dc-survey-record";
  const title = document.createElement("div");
  title.className = "dc-survey-title";
  title.textContent = `${text(record.dca_common_name) ?? "Unknown damage agent"}, ${record.survey_year}`;
  const table = document.createElement("table");
  const row = (name: string, value: string | null) => {
    if (!value) return;
    const tr = table.insertRow();
    tr.insertCell().textContent = name;
    tr.insertCell().textContent = value;
  };
  row("Host", text(record.host));
  row("Damage", text(record.damage_type));
  if (kind === "area") {
    row("Affected", text(record.percent_affected) ?? text(record.legacy_severity));
    const acres = record.acres === null || record.acres === "" ? Number.NaN : Number(record.acres);
    row("Acres", Number.isFinite(acres) ? acres.toLocaleString("en-US", { maximumFractionDigits: 1 }) : null);
  } else {
    row("Trees", text(record.number_of_trees_count_range) ?? text(record.tree_count));
  }
  row("Label", text(record.label));
  row("Notes", text(record.notes));
  block.append(title, table);
  return block;
}

function fill(card: HTMLElement, found: Found): boolean {
  const parts: HTMLElement[] = [];
  const section = (heading: string, records: Record_[], kind: "area" | "point") => {
    if (records.length === 0) return;
    const h = document.createElement("div");
    h.className = "dc-survey-heading";
    h.textContent = heading;
    parts.push(h, ...records.slice(0, MAX_RECORDS).map((record) => recordBlock(record, kind)));
    if (records.length > MAX_RECORDS) {
      const more = document.createElement("div");
      more.className = "dc-survey-muted";
      more.textContent = `More than ${MAX_RECORDS} records overlap here; zoom in to separate them.`;
      parts.push(more);
    }
  };
  section("Insect and disease survey, damage areas", found.areas, "area");
  section("Insect and disease survey, damage points", found.points, "point");
  if (found.mortality) {
    const h = document.createElement("div");
    h.className = "dc-survey-heading";
    h.textContent = "Tree mortality 0 to 5 years (TCA)";
    const p = document.createElement("div");
    p.textContent = "Mortality mapped at this point.";
    parts.push(h, p);
  }
  card.replaceChildren(...parts);
  return parts.length > 0;
}

/** Wires the hover and right-click cards to the map. Returns the teardown. */
export function attachSurveyInfo(app: GeoLibreAppAPI): () => void {
  let map: SurveyMap | null = null;
  let timer: number | undefined;
  let hoverController: AbortController | null = null;
  let pinController: AbortController | null = null;

  const hover = document.createElement("div");
  hover.className = "dc-survey-card dc-survey-hover";
  hover.hidden = true;
  const pin = document.createElement("div");
  pin.className = "dc-survey-card dc-survey-pin";
  pin.hidden = true;
  const pinBody = document.createElement("div");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "dc-survey-close";
  close.textContent = "×";
  close.setAttribute("aria-label", "Close survey records");
  pin.append(close, pinBody);

  const place = (card: HTMLElement, x: number, y: number, side: "right" | "left") => {
    const box = map!.getContainer().getBoundingClientRect();
    card.style.left = "0px";
    card.style.top = "0px";
    const { width, height } = card.getBoundingClientRect();
    let left = side === "right" ? x + 14 : x - width - 14;
    if (left + width > box.width - 8) left = x - width - 14;
    if (left < 8) left = Math.min(x + 14, box.width - width - 8);
    const top = Math.max(8, Math.min(y + 14, box.height - height - 8));
    card.style.left = `${Math.max(8, left)}px`;
    card.style.top = `${top}px`;
  };

  const hideHover = () => {
    window.clearTimeout(timer);
    hoverController?.abort();
    hover.hidden = true;
  };
  const closePin = () => {
    pinController?.abort();
    pin.hidden = true;
  };

  const onMove: Handler = (event) => {
    hideHover();
    if (!map) return;
    timer = window.setTimeout(async () => {
      const controller = new AbortController();
      hoverController = controller;
      try {
        const found = await lookUp(map!, event, controller.signal);
        if (controller.signal.aborted || !found) return;
        if (fill(hover, found)) {
          hover.hidden = false;
          place(hover, event.point.x, event.point.y, "right");
        }
      } catch {
        // A slow or failed request while scanning is dropped; a right click reports it.
      }
    }, HOVER_DELAY_MS);
  };

  const onContextMenu: Handler = async (event) => {
    if (!map) return;
    hideHover();
    pinController?.abort();
    const controller = new AbortController();
    pinController = controller;
    const shown = visibleSurvey(map);
    if (!shown.areaYears.length && !shown.pointYears.length && !shown.mortality) {
      closePin();
      return;
    }
    pinBody.textContent = "Looking up survey records…";
    pin.hidden = false;
    // GeoLibre opens its own coordinate menu to the right of the cursor, so the pinned card goes left.
    place(pin, event.point.x, event.point.y, "left");
    try {
      const found = await lookUp(map, event, controller.signal);
      if (controller.signal.aborted) return;
      if (!found || !fill(pinBody, found)) {
        pinBody.textContent = "No survey record at this point for the survey layers switched on.";
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      pinBody.textContent = `The survey lookup failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    place(pin, event.point.x, event.point.y, "left");
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") closePin();
  };
  close.addEventListener("click", closePin);

  const attach = (target: SurveyMap) => {
    map = target;
    const container = target.getContainer();
    container.append(hover, pin);
    target.on("mousemove", onMove);
    target.on("mouseout", hideHover);
    target.on("movestart", hideHover);
    target.on("contextmenu", onContextMenu);
    target.on("click", closePin);
    document.addEventListener("keydown", onKey);
  };

  // The map may not exist yet when the plugin activates.
  const found = app.getMap?.() as SurveyMap | null | undefined;
  let poll: number | undefined;
  if (found) attach(found);
  else {
    poll = window.setInterval(() => {
      const later = app.getMap?.() as SurveyMap | null | undefined;
      if (later) {
        window.clearInterval(poll);
        attach(later);
      }
    }, 1000);
  }

  return () => {
    window.clearInterval(poll);
    hideHover();
    closePin();
    if (map) {
      map.off("mousemove", onMove);
      map.off("mouseout", hideHover);
      map.off("movestart", hideHover);
      map.off("contextmenu", onContextMenu);
      map.off("click", closePin);
    }
    document.removeEventListener("keydown", onKey);
    hover.remove();
    pin.remove();
  };
}
