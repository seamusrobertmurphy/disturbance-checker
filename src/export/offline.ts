import { Aoi, AoiBounds, aoiBounds } from "../analysis/run";
import { GeoLibreAppAPI } from "../types/geolibre";

// One HTML file that shows the project area with every layer that was switched
// on, readable with no connection and no account.
//
// The file carries its own data. Each raster layer is fetched once for the
// area as a single image, from the service's bounding box export where the
// layer has one and stitched from map tiles where it does not. Each vector
// layer is read from the map after it has been zoomed to the area, so the
// features are the ones the operator was looking at. The page draws the images
// stacked in Web Mercator, the vectors as SVG over them, and needs no library.
//
// It works from the map rather than from GeoLibre's layer store, which a
// plugin cannot read, so layer names come from the startup project for the
// corroboration layers and from the source id otherwise. A layer that fails to
// fetch is listed in the file as missing rather than dropped without a word.

const R = 20037508.342789244;
const IMAGE_WIDTH = 2048;
const MAX_TILES = 144;

interface StyleLayer {
  id: string;
  type: string;
  source?: string;
  "source-layer"?: string;
  layout?: Record<string, unknown>;
  paint?: Record<string, unknown>;
}

interface MapLike {
  getStyle(): { sources: Record<string, Record<string, unknown>>; layers: StyleLayer[] };
  getBounds(): { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number };
  fitBounds(bounds: [[number, number], [number, number]], options?: Record<string, unknown>): void;
  once(event: string, handler: () => void): void;
  querySourceFeatures(source: string, options?: { sourceLayer?: string }): Array<{
    geometry: { type: string; coordinates: unknown };
    properties: Record<string, unknown>;
  }>;
}

interface Box {
  minx: number;
  miny: number;
  maxx: number;
  maxy: number;
  width: number;
  height: number;
}

interface RasterEntry {
  kind: "raster";
  name: string;
  dataUrl: string;
  box: [number, number, number, number];
}

interface VectorEntry {
  kind: "vector";
  name: string;
  color: string;
  features: Array<{ geometry: { type: string; coordinates: unknown }; properties: Record<string, unknown> }>;
}

type Entry = RasterEntry | VectorEntry;

export interface OfflineProgress {
  (message: string): void;
}

function mercator(lon: number, lat: number): [number, number] {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  return [
    (lon * R) / 180,
    (Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360)) * R) / Math.PI,
  ];
}

function areaBox(bounds: AoiBounds): Box {
  const padX = (bounds.east - bounds.west) * 0.1;
  const padY = (bounds.north - bounds.south) * 0.1;
  const [minx, miny] = mercator(bounds.west - padX, bounds.south - padY);
  const [maxx, maxy] = mercator(bounds.east + padX, bounds.north + padY);
  const aspect = (maxy - miny) / (maxx - minx);
  const width = aspect > 1 ? Math.round(IMAGE_WIDTH / aspect) : IMAGE_WIDTH;
  const height = aspect > 1 ? IMAGE_WIDTH : Math.round(IMAGE_WIDTH * aspect);
  return { minx, miny, maxx, maxy, width: Math.max(width, 64), height: Math.max(height, 64) };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function fetchImage(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) throw new Error(`not an image (${blob.type || "unknown type"})`);
  return blobToDataUrl(blob);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("tile failed"));
    image.src = url;
  });
}

async function bboxRaster(template: string, box: Box): Promise<string> {
  const url = template
    .replace("{bbox-epsg-3857}", `${box.minx},${box.miny},${box.maxx},${box.maxy}`)
    .replace(/size=\d+,\d+/i, `size=${box.width},${box.height}`)
    .replace(/([?&])width=\d+/i, `$1width=${box.width}`)
    .replace(/([?&])height=\d+/i, `$1height=${box.height}`);
  return fetchImage(url);
}

async function stitchedRaster(template: string, box: Box, maxzoom: number): Promise<string> {
  const world = 2 * R;
  let zoom = Math.ceil(Math.log2((box.width * world) / (box.maxx - box.minx) / 256));
  zoom = Math.max(0, Math.min(zoom, maxzoom));
  const tileRange = (z: number) => {
    const n = 2 ** z;
    const tx = (x: number) => Math.floor(((x + R) / world) * n);
    const ty = (y: number) => Math.floor(((R - y) / world) * n);
    return { n, x0: tx(box.minx), x1: tx(box.maxx), y0: ty(box.maxy), y1: ty(box.miny) };
  };
  let range = tileRange(zoom);
  while (zoom > 0 && (range.x1 - range.x0 + 1) * (range.y1 - range.y0 + 1) > MAX_TILES) {
    zoom -= 1;
    range = tileRange(zoom);
  }
  const canvas = document.createElement("canvas");
  canvas.width = box.width;
  canvas.height = box.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no canvas");
  const tileSize = world / range.n;
  const scaleX = box.width / (box.maxx - box.minx);
  const scaleY = box.height / (box.maxy - box.miny);
  const jobs: Array<Promise<void>> = [];
  for (let x = range.x0; x <= range.x1; x++) {
    for (let y = range.y0; y <= range.y1; y++) {
      if (x < 0 || y < 0 || x >= range.n || y >= range.n) continue;
      const url = template.replace("{z}", String(zoom)).replace("{x}", String(x)).replace("{y}", String(y));
      jobs.push(
        loadImage(url)
          .then((image) => {
            const left = -R + x * tileSize;
            const top = R - y * tileSize;
            context.drawImage(
              image,
              (left - box.minx) * scaleX,
              (box.maxy - top) * scaleY,
              tileSize * scaleX,
              tileSize * scaleY,
            );
          })
          .catch(() => undefined),
      );
    }
  }
  await Promise.all(jobs);
  return canvas.toDataURL("image/png");
}

function waitForIdle(map: MapLike, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    map.once("idle", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function colourOf(layer: StyleLayer): string {
  const paint = layer.paint ?? {};
  for (const key of ["fill-color", "line-color", "circle-color"]) {
    if (typeof paint[key] === "string") return paint[key] as string;
  }
  return "#ffcc00";
}

async function layerNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const url = new URL("disturbance-check.geolibre.json", document.baseURI);
    const project = await (await fetch(url)).json();
    for (const layer of project.layers ?? []) names.set(String(layer.id), String(layer.name));
  } catch {
    // Names fall back to source ids.
  }
  names.set("esri-world-imagery", "Esri World Imagery");
  return names;
}

function nameFor(sourceId: string, names: Map<string, string>): string {
  const bare = sourceId.replace(/^source-/, "");
  return names.get(bare) ?? names.get(sourceId) ?? bare.replace(/^dcheck-/, "Disturbance Check ").replace(/-src$/, "");
}

export async function buildOfflineMap(
  app: GeoLibreAppAPI,
  aoi: Aoi | null,
  aoiLabel: string,
  progress: OfflineProgress,
): Promise<{ html: string; included: number; missing: string[] }> {
  const map = app.getMap?.() as MapLike | null | undefined;
  if (!map || typeof map.getStyle !== "function") throw new Error("The map is not ready.");

  const viewBounds = map.getBounds();
  const bounds: AoiBounds = (aoi && aoiBounds(aoi)) ?? {
    west: viewBounds.getWest(),
    south: viewBounds.getSouth(),
    east: viewBounds.getEast(),
    north: viewBounds.getNorth(),
  };
  const box = areaBox(bounds);
  const names = await layerNames();

  progress("Zooming to the area so vector features are read at full detail");
  map.fitBounds([[bounds.west, bounds.south], [bounds.east, bounds.north]], { animate: false, padding: 20 });
  await waitForIdle(map, 30000);

  const style = map.getStyle();
  const ordered: Array<{ sourceId: string; layers: StyleLayer[] }> = [];
  for (const layer of style.layers) {
    if (!layer.source || layer.type === "background") continue;
    if (layer.layout?.visibility === "none") continue;
    let group = ordered.find((entry) => entry.sourceId === layer.source);
    if (!group) {
      group = { sourceId: layer.source, layers: [] };
      ordered.push(group);
    }
    group.layers.push(layer);
  }

  const entries: Entry[] = [];
  const missing: string[] = [];
  let done = 0;
  for (const { sourceId, layers } of ordered) {
    const source = style.sources[sourceId] ?? {};
    const name = nameFor(sourceId, names);
    done += 1;
    progress(`${done} of ${ordered.length}: ${name}`);
    try {
      if (source.type === "raster" && Array.isArray(source.tiles) && typeof source.tiles[0] === "string") {
        const template = source.tiles[0] as string;
        const dataUrl = template.includes("{bbox-epsg-3857}")
          ? await bboxRaster(template, box)
          : await stitchedRaster(template, box, typeof source.maxzoom === "number" ? source.maxzoom : 19);
        entries.push({ kind: "raster", name, dataUrl, box: [box.minx, box.miny, box.maxx, box.maxy] });
      } else if (source.type === "image" && typeof source.url === "string" && Array.isArray(source.coordinates)) {
        const corners = source.coordinates as Array<[number, number]>;
        const xs = corners.map((c) => mercator(c[0], c[1])[0]);
        const ys = corners.map((c) => mercator(c[0], c[1])[1]);
        entries.push({
          kind: "raster",
          name,
          dataUrl: await fetchImage(source.url),
          box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
        });
      } else if (source.type === "vector" || source.type === "geojson") {
        const features: VectorEntry["features"] = [];
        const keys = new Set<string>();
        const sourceLayers = [...new Set(layers.map((layer) => layer["source-layer"]))];
        for (const sourceLayer of sourceLayers) {
          for (const feature of map.querySourceFeatures(sourceId, sourceLayer ? { sourceLayer } : undefined)) {
            const plain = { geometry: feature.geometry, properties: { ...feature.properties } };
            const key = JSON.stringify(plain.geometry);
            if (keys.has(key)) continue;
            keys.add(key);
            features.push(plain);
          }
        }
        if (features.length === 0) continue;
        entries.push({ kind: "vector", name, color: colourOf(layers[0]), features });
      } else {
        missing.push(`${name} (a ${String(source.type)} source this export cannot copy)`);
      }
    } catch (error) {
      missing.push(`${name} (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  if (aoi) {
    entries.push({
      kind: "vector",
      name: aoiLabel ? `Area of interest, ${aoiLabel}` : "Area of interest",
      color: "#00e5ff",
      features: [{
        geometry: aoi.kind === "geojson"
          ? (aoi.geometry as { type: string; coordinates: unknown })
          : {
              type: "Polygon",
              coordinates: [[[aoi.west, aoi.south], [aoi.east, aoi.south], [aoi.east, aoi.north], [aoi.west, aoi.north], [aoi.west, aoi.south]]],
            },
        properties: {},
      }],
    });
  }

  progress("Writing the file");
  return { html: renderHtml(entries, box, bounds, aoiLabel, missing), included: entries.length, missing };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function renderHtml(entries: Entry[], box: Box, bounds: AoiBounds, aoiLabel: string, missing: string[]): string {
  const project = (lon: number, lat: number): [number, number] => {
    const [mx, my] = mercator(lon, lat);
    return [
      +(((mx - box.minx) / (box.maxx - box.minx)) * box.width).toFixed(1),
      +(((box.maxy - my) / (box.maxy - box.miny)) * box.height).toFixed(1),
    ];
  };
  const ring = (coords: Array<[number, number]>) =>
    coords.map((c, i) => `${i === 0 ? "M" : "L"}${project(c[0], c[1]).join(",")}`).join("");
  const properties: Array<Record<string, unknown>> = [];

  const layerMarkup = entries.map((entry, index) => {
    if (entry.kind === "raster") {
      const [x0, y0, x1, y1] = entry.box;
      const left = ((x0 - box.minx) / (box.maxx - box.minx)) * 100;
      const top = ((box.maxy - y1) / (box.maxy - box.miny)) * 100;
      const width = ((x1 - x0) / (box.maxx - box.minx)) * 100;
      const height = ((y1 - y0) / (box.maxy - box.miny)) * 100;
      return `<img class="layer" data-layer="${index}" alt="" src="${entry.dataUrl}" style="left:${left}%;top:${top}%;width:${width}%;height:${height}%">`;
    }
    const shapes = entry.features.map((feature) => {
      const id = properties.push(feature.properties) - 1;
      const g = feature.geometry;
      const coords = g.coordinates as never;
      if (g.type === "Point") {
        const [x, y] = project((coords as number[])[0], (coords as number[])[1]);
        return `<circle data-p="${id}" cx="${x}" cy="${y}" r="4"/>`;
      }
      if (g.type === "MultiPoint") {
        return (coords as number[][]).map((c) => {
          const [x, y] = project(c[0], c[1]);
          return `<circle data-p="${id}" cx="${x}" cy="${y}" r="4"/>`;
        }).join("");
      }
      let d = "";
      if (g.type === "LineString") d = ring(coords);
      if (g.type === "MultiLineString") d = (coords as Array<Array<[number, number]>>).map(ring).join("");
      if (g.type === "Polygon") d = (coords as Array<Array<[number, number]>>).map((r) => `${ring(r)}Z`).join("");
      if (g.type === "MultiPolygon") {
        d = (coords as Array<Array<Array<[number, number]>>>).map((p) => p.map((r) => `${ring(r)}Z`).join("")).join("");
      }
      const filled = g.type === "Polygon" || g.type === "MultiPolygon";
      return d ? `<path data-p="${id}" d="${d}" class="${filled ? "area" : "line"}"/>` : "";
    }).join("");
    return `<svg class="layer" data-layer="${index}" viewBox="0 0 ${box.width} ${box.height}" style="color:${escapeHtml(entry.color)}">${shapes}</svg>`;
  }).join("\n");

  const list = entries.map((entry, index) =>
    `<label><input type="checkbox" checked data-toggle="${index}"> ${escapeHtml(entry.name)}${entry.kind === "vector" ? ` <span class="count">${entry.features.length.toLocaleString()}</span>` : ""}</label>`,
  ).reverse().join("\n");

  const title = aoiLabel ? `Disturbance Check, ${aoiLabel}` : "Disturbance Check, project area";
  const made = new Date().toISOString().slice(0, 10);
  const propertiesJson = JSON.stringify(properties).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
html,body{margin:0;height:100%;font:14px system-ui,sans-serif;background:#1b1f23;color:#e8e8e8}
#app{display:flex;height:100%}
#side{width:320px;overflow:auto;padding:12px 14px;background:#24292e;box-sizing:border-box}
#side h1{font-size:16px;margin:0 0 6px}
#side p{margin:4px 0 10px;color:#b0b8c0;font-size:12px}
#side label{display:block;padding:3px 0;font-size:13px}
.count{color:#8b949e;font-size:11px}
#view{flex:1;position:relative;overflow:hidden;cursor:grab;background:#11151a}
#stage{position:absolute;left:0;top:0;width:${box.width}px;height:${box.height}px;transform-origin:0 0}
.layer{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none}
svg.layer *{pointer-events:auto}
img.layer{image-rendering:auto}
svg.layer path.area{fill:currentColor;fill-opacity:.3;stroke:currentColor;stroke-width:1.5;vector-effect:non-scaling-stroke}
svg.layer path.line{fill:none;stroke:currentColor;stroke-width:1.5;vector-effect:non-scaling-stroke}
svg.layer circle{fill:currentColor;stroke:#000;stroke-width:.5;vector-effect:non-scaling-stroke}
#info{position:absolute;right:10px;top:10px;max-width:320px;max-height:60%;overflow:auto;background:rgba(36,41,46,.95);padding:8px 10px;border-radius:6px;font-size:12px;display:none}
#info table{border-collapse:collapse}#info td{padding:1px 6px 1px 0;vertical-align:top}
.missing{color:#f0a060}
</style>
</head>
<body>
<div id="app">
<div id="side">
<h1>${escapeHtml(title)}</h1>
<p>Made ${made} from the Disturbance Check map. Area ${bounds.west.toFixed(4)}, ${bounds.south.toFixed(4)} to ${bounds.east.toFixed(4)}, ${bounds.north.toFixed(4)} (WGS84), with a 10 per cent margin. Everything below is inside this file, so it opens with no connection. Drag to pan, scroll to zoom, click a shape for its attributes.</p>
${list}
${missing.length ? `<p class="missing">Not included:<br>${missing.map(escapeHtml).join("<br>")}</p>` : ""}
</div>
<div id="view"><div id="stage">
${layerMarkup}
</div><div id="info"></div></div>
</div>
<script>
(function(){
var props=${propertiesJson};
var view=document.getElementById('view'),stage=document.getElementById('stage'),info=document.getElementById('info');
var s=Math.min(view.clientWidth/${box.width},view.clientHeight/${box.height}),x=(view.clientWidth-${box.width}*s)/2,y=(view.clientHeight-${box.height}*s)/2;
function draw(){stage.style.transform='translate('+x+'px,'+y+'px) scale('+s+')';}
draw();
view.addEventListener('wheel',function(e){e.preventDefault();var r=view.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top,k=e.deltaY<0?1.2:1/1.2;x=mx-(mx-x)*k;y=my-(my-y)*k;s*=k;draw();},{passive:false});
var drag=null;
view.addEventListener('mousedown',function(e){drag={x:e.clientX-x,y:e.clientY-y,moved:false};view.style.cursor='grabbing';});
window.addEventListener('mousemove',function(e){if(!drag)return;drag.moved=true;x=e.clientX-drag.x;y=e.clientY-drag.y;draw();});
window.addEventListener('mouseup',function(e){view.style.cursor='grab';var d=drag;drag=null;if(d&&d.moved)return;var t=e.target;if(t&&t.getAttribute&&t.getAttribute('data-p')!==null){var p=props[+t.getAttribute('data-p')]||{},rows='';for(var k in p){rows+='<tr><td>'+String(k).replace(/</g,'&lt;')+'</td><td>'+String(p[k]).replace(/</g,'&lt;')+'</td></tr>';}info.innerHTML=rows?'<table>'+rows+'</table>':'No attributes';info.style.display='block';}else{info.style.display='none';}});
document.querySelectorAll('[data-toggle]').forEach(function(box){box.addEventListener('change',function(){var el=stage.querySelector('[data-layer="'+box.getAttribute('data-toggle')+'"]');if(el)el.style.display=box.checked?'':'none';});});
})();
</script>
</body>
</html>
`;
}
