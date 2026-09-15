import { LANDFIRE_CODES } from "../reference/landfire-codes";
import { GeoLibreAppAPI } from "../types/geolibre";

// What the corroboration layers hold under the cursor.
//
// When the pointer rests on the map, or on a right click, every corroboration
// layer switched on and drawn at the current zoom reports what it holds at
// that point, in a card beside the cursor. Resting shows a card that follows
// the pointer; a right click pins one until it is closed.
//
// Two kinds of layer answer in two ways. The PMTiles layers the site publishes
// (carbon projects, WFIGS and interagency fire records, PAD-US, park
// boundaries, roads) are read straight from the map. The layers drawn by a
// federal image or map service (insect and disease survey, tree mortality,
// wildfire hazard, MTBS, LANDFIRE, BLM, PLSS, BIA) hold no records in the map,
// so the service is asked about the point, at the address the layer already
// draws from. Nothing is requested for a layer that is switched off.

const HOVER_DELAY_MS = 450;
const TOLERANCE_PX = 4;
const MAX_RECORDS = 6;

// USDA Forest Service Insect and Disease Survey, damage points (layer 0) and areas (layer 1)
// https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_InsectandDiseaseSurvey_01/MapServer
const IDS = "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_InsectandDiseaseSurvey_01/MapServer";
// MTBS burned area boundaries, all years (layer 63)
// https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MTBS_01/MapServer
const MTBS_BOUNDARIES = "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MTBS_01/MapServer";

interface LngLat { lng: number; lat: number }
interface MapMouse { point: { x: number; y: number }; lngLat: LngLat }
type Handler = (event: MapMouse) => void;
interface RenderedFeature { layer: { id: string }; properties: Record<string, unknown> }

interface InfoMap {
  on(event: string, handler: Handler | (() => void)): void;
  off(event: string, handler: Handler | (() => void)): void;
  getStyle(): { layers?: Array<{ id: string }> } | undefined;
  getLayer(id: string): { minzoom?: number; maxzoom?: number } | undefined;
  getSource(id: string): { minzoom?: number; tiles?: string[] } | undefined;
  getLayoutProperty(id: string, name: string): unknown;
  getPaintProperty(id: string, name: string): unknown;
  getZoom(): number;
  getBounds(): { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number };
  unproject(point: [number, number]): LngLat;
  queryRenderedFeatures(box: [[number, number], [number, number]], options?: { layers?: string[] }): RenderedFeature[];
  getContainer(): HTMLElement;
}

type Rows = Array<[string, string | null]>;
interface Entry { title: string; rows: Rows }
interface Section { heading: string; entries: Entry[] }

const str = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s && s !== "Null" && s !== "NoData" ? s : null;
};
const acres = (value: unknown): string | null => {
  const n = Number(str(value));
  return str(value) !== null && Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 1 }) : null;
};
const isoDate = (value: unknown): string | null => {
  const s = str(value);
  if (!s) return null;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`;
  return s;
};

// --- Layers switched on ---------------------------------------------------

interface ServiceLayer { key: string; tiles: string }

/** Raster corroboration layers switched on and drawn at this zoom, with the address each draws from. */
function visibleServiceLayers(map: InfoMap): ServiceLayer[] {
  const found: ServiceLayer[] = [];
  const zoom = map.getZoom();
  for (const { id } of map.getStyle()?.layers ?? []) {
    const match = /^layer-corroboration-(.+)-raster$/.exec(id);
    if (!match) continue;
    if (map.getLayoutProperty(id, "visibility") === "none") continue;
    const opacity = map.getPaintProperty(id, "raster-opacity");
    if (typeof opacity === "number" && opacity <= 0) continue;
    const source = map.getSource(`source-corroboration-${match[1]}`);
    const layer = map.getLayer(id);
    if (zoom < Math.max(source?.minzoom ?? 0, layer?.minzoom ?? 0) || zoom >= (layer?.maxzoom ?? 24)) continue;
    const tiles = source?.tiles?.[0];
    if (tiles) found.push({ key: match[1], tiles });
  }
  return found;
}

/** Style layer ids of the PMTiles corroboration layers switched on. */
function visibleTileLayerIds(map: InfoMap): string[] {
  return (map.getStyle()?.layers ?? [])
    .map(({ id }) => id)
    .filter((id) => /^corroboration-.+-(fill|line|circle)$/.test(id))
    .filter((id) => map.getLayoutProperty(id, "visibility") !== "none");
}

// --- Services -------------------------------------------------------------

const serviceBase = (tiles: string) => tiles.split(/\/(export|exportImage|tile)(\?|\/|$)/)[0];
const tileParam = (tiles: string, name: string) => new URL(tiles.replace(/\{[^}]+\}/g, "0")).searchParams.get(name);

async function getJson<T>(url: string, params: Record<string, string>, signal: AbortSignal): Promise<T> {
  const response = await fetch(`${url}?${new URLSearchParams({ ...params, f: "json" })}`, { signal });
  if (!response.ok) throw new Error(`${new URL(url).host} answered HTTP ${response.status}`);
  const body = (await response.json()) as T & { error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? `${new URL(url).host} returned an error`);
  return body;
}

interface Lookup { map: InfoMap; at: MapMouse; signal: AbortSignal }

function pointGeometry(at: LngLat): string {
  return JSON.stringify({ x: at.lng, y: at.lat, spatialReference: { wkid: 4326 } });
}

async function imagePixel(base: string, { at, signal }: Lookup): Promise<string | null> {
  const body = await getJson<{ value?: string }>(`${base}/identify`, {
    geometry: pointGeometry(at.lngLat),
    geometryType: "esriGeometryPoint",
    returnGeometry: "false",
    returnCatalogItems: "false",
  }, signal);
  return str(body.value);
}

interface IdentifyResult { layerId: number; layerName: string; value?: string; attributes: Record<string, string> }

async function mapIdentify(base: string, layers: string, { map, at, signal }: Lookup, layerDefs?: string): Promise<IdentifyResult[]> {
  const b = map.getBounds();
  const box = map.getContainer().getBoundingClientRect();
  const body = await getJson<{ results?: IdentifyResult[] }>(`${base}/identify`, {
    geometry: pointGeometry(at.lngLat),
    geometryType: "esriGeometryPoint",
    sr: "4326",
    layers: `visible:${layers}`,
    tolerance: String(TOLERANCE_PX),
    mapExtent: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(","),
    imageDisplay: `${Math.round(box.width)},${Math.round(box.height)},96`,
    returnGeometry: "false",
    ...(layerDefs ? { layerDefs } : {}),
  }, signal);
  return body.results ?? [];
}

async function surveyQuery(layer: 0 | 1, years: number[], fields: string[], { map, at, signal }: Lookup): Promise<Record<string, unknown>[]> {
  const px = layer === 0 ? 8 : 3;
  const a = map.unproject([at.point.x - px, at.point.y + px]);
  const b = map.unproject([at.point.x + px, at.point.y - px]);
  const body = await getJson<{ features?: Array<{ attributes: Record<string, unknown> }> }>(`${IDS}/${layer}/query`, {
    where: `survey_year IN (${years.join(",")})`,
    geometry: [a.lng, a.lat, b.lng, b.lat].join(","),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: fields.join(","),
    orderByFields: "survey_year DESC",
    returnGeometry: "false",
    resultRecordCount: String(MAX_RECORDS + 1),
  }, signal);
  return (body.features ?? []).map((feature) => feature.attributes);
}

const MTBS_CLASSES: Record<string, string> = {
  "1": "Unburned to low", "2": "Low", "3": "Moderate", "4": "High", "5": "Increased greenness",
};
// Wildfire Hazard Potential 2023, classified: https://doi.org/10.2737/RDS-2015-0047-4
const WHP_CLASSES: Record<string, string> = {
  "1": "Very low", "2": "Low", "3": "Moderate", "4": "High", "5": "Very high", "6": "Non-burnable", "7": "Water",
};
const LANDFIRE_KIND: Record<string, string> = { Dist: "final", LDist: "first look", PDist: "preliminary" };

/** One lookup per group of service layers; each returns a section or null. */
function serviceLookups(layers: ServiceLayer[], lookup: Lookup): Array<Promise<Section | null>> {
  const tasks: Array<Promise<Section | null>> = [];
  const byKey = (test: RegExp) => layers.filter((layer) => test.test(layer.key));

  const areaYears = byKey(/^ids-\d{4}$/).map((layer) => Number(layer.key.slice(4)));
  const pointYears = byKey(/^ids-points-\d{4}$/).map((layer) => Number(layer.key.slice(11)));
  const survey = async (layer: 0 | 1, years: number[]): Promise<Section | null> => {
    if (years.length === 0) return null;
    const fields = layer === 1
      ? ["survey_year", "dca_common_name", "host", "damage_type", "percent_affected", "legacy_severity", "acres", "label", "notes"]
      : ["survey_year", "dca_common_name", "host", "damage_type", "number_of_trees_count_range", "tree_count", "label", "notes"];
    const records = await surveyQuery(layer, years, fields, lookup);
    return {
      heading: `Insect and disease survey, damage ${layer === 1 ? "areas" : "points"}`,
      entries: records.map((r) => ({
        title: `${str(r.dca_common_name) ?? "Unknown damage agent"}, ${r.survey_year}`,
        rows: [
          ["Host", str(r.host)],
          ["Damage", str(r.damage_type)],
          ...(layer === 1
            ? [["Affected", str(r.percent_affected) ?? str(r.legacy_severity)], ["Acres", acres(r.acres)]] as Rows
            : [["Trees", str(r.number_of_trees_count_range) ?? str(r.tree_count)]] as Rows),
          ["Label", str(r.label)],
          ["Notes", str(r.notes)],
        ],
      })),
    };
  };
  tasks.push(survey(1, areaYears), survey(0, pointYears));

  const tca = byKey(/^tca-mortality$/)[0];
  if (tca) {
    tasks.push(imagePixel(serviceBase(tca.tiles), lookup).then((value) =>
      value && Number(value) > 0
        ? { heading: "Tree mortality 0 to 5 years (TCA)", entries: [{ title: "Mortality mapped here", rows: [] }] }
        : null));
  }

  const whp = byKey(/^whp-/)[0];
  if (whp) {
    tasks.push(imagePixel(serviceBase(whp.tiles), lookup).then((value) =>
      value && WHP_CLASSES[value]
        ? { heading: "Wildfire Hazard Potential 2023", entries: [{ title: WHP_CLASSES[value], rows: [] }] }
        : null));
  }

  const severityYears = byKey(/^mtbs-severity-\d{4}$/);
  const boundaries = byKey(/^mtbs-boundaries$/)[0];
  if (boundaries || severityYears.length) {
    // Severity lies only inside a burn boundary, so the boundary is found first
    // and severity is asked for that fire's year alone. Asking one service
    // for 41 years at once took over a minute.
    tasks.push((async () => {
      const fires = await mapIdentify(MTBS_BOUNDARIES, "63", lookup);
      if (fires.length === 0) return null;
      const entries: Entry[] = [];
      for (const fire of fires.slice(0, MAX_RECORDS)) {
        const a = fire.attributes;
        const year = str(a.YEAR);
        let severity: string | null = null;
        const shown = severityYears.find((layer) => layer.key === `mtbs-severity-${year}`);
        if (shown) {
          const results = await mapIdentify(serviceBase(shown.tiles), tileParam(shown.tiles, "layers")?.replace("show:", "") ?? "", lookup);
          const value = str(results[0]?.attributes["Classify.Pixel Value"] ?? results[0]?.attributes["Service Pixel Value"]);
          severity = value ? MTBS_CLASSES[value] ?? null : null;
        }
        entries.push({
          title: `${str(a.FIRE_NAME) ?? "Unnamed fire"}, ${year ?? "year not given"}`,
          rows: [
            ["Type", str(a.FIRE_TYPE)],
            ["Ignition", isoDate(a.IG_DATE)],
            ["Acres", acres(a.ACRES)],
            ["Burn severity here", severity ?? (shown ? "Not mapped at this pixel" : null)],
          ],
        });
      }
      return { heading: "MTBS burned areas", entries };
    })());
  }

  const landfire = byKey(/^landfire-/);
  if (landfire.length) {
    tasks.push((async () => {
      const values = await Promise.all(landfire.map(async (layer) => {
        const base = serviceBase(layer.tiles);
        const service = /\/(LF\d{4}_([A-Za-z]+)(\d{2})_CONUS)\/ImageServer$/.exec(base);
        const value = await imagePixel(base, lookup);
        const code = Number(value);
        if (!service || !value || !(code > 0) || !LANDFIRE_CODES[code]) return null;
        const [type, severity] = LANDFIRE_CODES[code];
        if (type === "Water" || type === "Background") return null;
        const year = (service[3] === "99" ? 1900 : 2000) + Number(service[3]);
        return {
          title: `${year}, ${LANDFIRE_KIND[service[2]] ?? service[2]}`,
          rows: [["Disturbance", type], ["Severity", severity], ["Code", String(code)]] as Rows,
          year,
        };
      }));
      const entries = values.filter((v): v is Entry & { year: number } => v !== null).sort((a, b) => b.year - a.year);
      return entries.length ? { heading: "LANDFIRE annual disturbance", entries } : null;
    })());
  }

  const sma = byKey(/^blm-sma$/)[0];
  if (sma) {
    tasks.push(mapIdentify(serviceBase(sma.tiles), "1", lookup).then((results) => {
      const a = results.find((r) => r.layerId === 1)?.attributes;
      return a ? { heading: "Surface management agency (BLM)", entries: [{ title: str(a.ADMIN_UNIT_NAME) ?? "Unnamed", rows: [["Unit", str(a.ADMIN_UNIT_TYPE)]] as Rows }] } : null;
    }));
  }

  const plss = byKey(/^blm-plss$/)[0];
  if (plss) {
    tasks.push(mapIdentify(serviceBase(plss.tiles), "1,2", lookup).then((results) => {
      const township = results.find((r) => r.layerName === "PLSS Township")?.attributes;
      const section = results.find((r) => r.layerName === "PLSS Section")?.attributes;
      if (!township && !section) return null;
      return {
        heading: "PLSS (BLM CadNSDI)",
        entries: [{
          title: str(township?.TWNSHPLAB) ?? "Township not returned",
          rows: [["Meridian", str(township?.PRINMER)], ["Section", str(section?.FRSTDIVNO) ?? str(section?.FRSTDIVLAB)]] as Rows,
        }],
      };
    }));
  }

  const bia = byKey(/^bia-lar$/)[0];
  if (bia) {
    tasks.push(mapIdentify(serviceBase(bia.tiles), "0", lookup).then((results) => {
      if (results.length === 0) return null;
      return {
        heading: "Tribal lands (BIA)",
        entries: results.slice(0, MAX_RECORDS).map((r) => ({
          title: str(r.value) ?? "Unnamed land area",
          rows: [["Region", str(r.attributes.Region)], ["Acres", acres(r.attributes["GIS Acres"])]] as Rows,
        })),
      };
    }));
  }

  return tasks;
}

// --- PMTiles layers read from the map --------------------------------------

const ROAD_CLASSES: Record<string, string> = { "1": "Highway", "2": "Primary road", "3": "Secondary road", "4": "Tertiary road" };

function tileSections(map: InfoMap, at: MapMouse): Section[] {
  const ids = visibleTileLayerIds(map);
  if (ids.length === 0) return [];
  const { x, y } = at.point;
  const features = map.queryRenderedFeatures([[x - TOLERANCE_PX, y - TOLERANCE_PX], [x + TOLERANCE_PX, y + TOLERANCE_PX]], { layers: ids });
  const sections = new Map<string, { heading: string; entries: Map<string, Entry> }>();
  for (const feature of features) {
    const key = /^corroboration-(.+)-[a-z]+-(fill|line|circle)$/.exec(feature.layer.id)?.[1];
    if (!key) continue;
    const p = feature.properties;
    let heading: string;
    let entry: Entry;
    if (key.startsWith("carbon-")) {
      heading = `Carbon projects, ${str(p.registry) ?? key.slice(7)}`;
      entry = {
        title: `${str(p.name) ?? "Unnamed project"} (${str(p.project_id) ?? "no id"})`,
        rows: [
          ["Type", str(p.type)], ["Methodology", str(p.methodology)], ["Developer", str(p.developer)],
          ["Crediting", str(p.start) && str(p.end) ? `${p.start} to ${p.end}` : null],
          ["Boundary", str(p.geometry_type) === "Point" ? "Location only" : str(p.boundary_source)],
        ],
      };
    } else if (/^(wfigs|nifc)-/.test(key)) {
      heading = key.startsWith("wfigs-perimeters") ? "WFIGS fire perimeters"
        : key.startsWith("wfigs-incidents") ? "WFIGS incident points" : "Interagency fire perimeter history";
      entry = {
        title: `${str(p.name) ?? "Unnamed incident"}${str(p.year) ? `, ${p.year}` : ""}`,
        rows: [
          ["Acres", acres(p.acres)], ["Discovered", str(p.discovered)], ["Cause", str(p.cause)],
          ["Type", str(p.type)], ["State", str(p.state)], ["Agency", str(p.agency)],
        ],
      };
    } else if (key.startsWith("padus-")) {
      heading = key === "padus-federal-fee" ? "PAD-US 4.1 federal fee lands" : "PAD-US 4.1 proclamation boundaries";
      entry = {
        title: str(p.name) ?? "Unnamed area",
        rows: [
          ["Manager", str(p.manager)], ["Owner", str(p.owner)], ["Designation", str(p.designation)],
          ["GAP status", str(p.gap_status)], ["Acres", acres(p.acres)], ["State", str(p.state)],
        ],
      };
    } else if (key.startsWith("nps-")) {
      heading = "National park boundaries (NPS)";
      entry = { title: str(p.name) ?? "Unnamed unit", rows: [["Type", str(p.type)], ["Code", str(p.code)], ["State", str(p.state)]] };
    } else if (key.startsWith("grip4-")) {
      heading = "Main roads (GRIP4)";
      entry = { title: ROAD_CLASSES[String(p.GP_RTP)] ?? "Road", rows: [] };
    } else {
      continue;
    }
    const section = sections.get(heading) ?? { heading, entries: new Map<string, Entry>() };
    // A feature split across tiles comes back once per tile.
    section.entries.set(entry.title, entry);
    sections.set(heading, section);
  }
  return [...sections.values()].map(({ heading, entries }) => ({ heading, entries: [...entries.values()] }));
}

// --- Card -----------------------------------------------------------------

function render(card: HTMLElement, sections: Section[]): void {
  const parts: HTMLElement[] = [];
  for (const section of sections) {
    const heading = document.createElement("div");
    heading.className = "dc-survey-heading";
    heading.textContent = section.heading;
    parts.push(heading);
    for (const entry of section.entries.slice(0, MAX_RECORDS)) {
      const block = document.createElement("div");
      block.className = "dc-survey-record";
      const title = document.createElement("div");
      title.className = "dc-survey-title";
      title.textContent = entry.title;
      block.append(title);
      const rows = entry.rows.filter(([, value]) => value);
      if (rows.length) {
        const table = document.createElement("table");
        for (const [name, value] of rows) {
          const tr = table.insertRow();
          tr.insertCell().textContent = name;
          tr.insertCell().textContent = value;
        }
        block.append(table);
      }
      parts.push(block);
    }
    if (section.entries.length > MAX_RECORDS) {
      const more = document.createElement("div");
      more.className = "dc-survey-muted";
      more.textContent = `More than ${MAX_RECORDS} records overlap here; zoom in to separate them.`;
      parts.push(more);
    }
  }
  card.replaceChildren(...parts);
}

interface Result { sections: Section[]; failures: string[]; layersOn: number }

async function lookUp(map: InfoMap, at: MapMouse, signal: AbortSignal): Promise<Result> {
  const lookup = { map, at, signal };
  const service = visibleServiceLayers(map);
  const tiles = visibleTileLayerIds(map);
  const settled = await Promise.allSettled(serviceLookups(service, lookup));
  const failures = settled
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
  const sections = [
    ...tileSections(map, at),
    ...settled.flatMap((r) => (r.status === "fulfilled" && r.value && r.value.entries.length ? [r.value] : [])),
  ];
  return { sections, failures, layersOn: service.length + new Set(tiles.map((id) => id.replace(/-[a-z]+-(fill|line|circle)$/, ""))).size };
}

/** Wires the hover and right-click cards to the map. Returns the teardown. */
export function attachLayerInfo(app: GeoLibreAppAPI): () => void {
  let map: InfoMap | null = null;
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
  close.setAttribute("aria-label", "Close layer information");
  pin.append(close, pinBody);

  const place = (card: HTMLElement, x: number, y: number, side: "right" | "left") => {
    const box = map!.getContainer().getBoundingClientRect();
    card.style.left = "0px";
    card.style.top = "0px";
    const { width, height } = card.getBoundingClientRect();
    let left = side === "right" ? x + 14 : x - width - 14;
    if (left + width > box.width - 8) left = x - width - 14;
    if (left < 8) left = Math.min(x + 14, box.width - width - 8);
    card.style.left = `${Math.max(8, left)}px`;
    card.style.top = `${Math.max(8, Math.min(y + 14, box.height - height - 8))}px`;
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
      const found = await lookUp(map!, event, controller.signal).catch(() => null);
      if (controller.signal.aborted || !found || found.layersOn === 0) return;
      if (found.sections.length) render(hover, found.sections);
      else hover.textContent = `Nothing recorded here in the ${found.layersOn} layers switched on.`;
      hover.hidden = false;
      place(hover, event.point.x, event.point.y, "right");
    }, HOVER_DELAY_MS);
  };

  const onContextMenu: Handler = async (event) => {
    if (!map) return;
    hideHover();
    pinController?.abort();
    const controller = new AbortController();
    pinController = controller;
    pinBody.textContent = "Looking up the layers switched on…";
    pin.hidden = false;
    // GeoLibre opens its own coordinate menu to the right of the cursor, so the pinned card goes left.
    place(pin, event.point.x, event.point.y, "left");
    const found = await lookUp(map, event, controller.signal);
    if (controller.signal.aborted) return;
    if (found.layersOn === 0) pinBody.textContent = "No corroboration layer is switched on.";
    else if (found.sections.length) render(pinBody, found.sections);
    else pinBody.textContent = `Nothing recorded here in the ${found.layersOn} layers switched on.`;
    if (found.failures.length) {
      const note = document.createElement("div");
      note.className = "dc-survey-muted";
      note.textContent = `Not answered: ${[...new Set(found.failures)].join("; ")}.`;
      pinBody.append(note);
    }
    place(pin, event.point.x, event.point.y, "left");
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") closePin();
  };
  close.addEventListener("click", closePin);

  const attach = (target: InfoMap) => {
    map = target;
    target.getContainer().append(hover, pin);
    target.on("mousemove", onMove);
    target.on("mouseout", hideHover);
    target.on("movestart", hideHover);
    target.on("contextmenu", onContextMenu);
    target.on("click", closePin);
    document.addEventListener("keydown", onKey);
  };

  // The map may not exist yet when the plugin activates.
  let poll: number | undefined;
  const ready = app.getMap?.() as InfoMap | null | undefined;
  if (ready) attach(ready);
  else {
    poll = window.setInterval(() => {
      const later = app.getMap?.() as InfoMap | null | undefined;
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
