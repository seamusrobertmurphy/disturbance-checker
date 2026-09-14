import { MapLayerManager } from "../map/layers";
import { GeoLibreAppAPI } from "../types/geolibre";
import { COVERED_STATES, OWNER_STATES, lookUpParcel } from "./lookup";

// The parcel lookup card. While the switch is on, a click on the map asks the
// statewide parcel service for the parcel under it, shows the owner, parcel id,
// acreage, address and county the state publishes, and outlines the parcel on
// the map. Nothing is looked up while the switch is off, so ordinary clicks on
// the map keep doing what GeoLibre does with them.

interface ClickMap {
  on(event: "click", handler: (event: { lngLat: { lng: number; lat: number } }) => void): void;
  off(event: "click", handler: (event: { lngLat: { lng: number; lat: number } }) => void): void;
  getCanvas?(): HTMLElement;
}

export function renderParcelPanel(container: HTMLElement, app: GeoLibreAppAPI): () => void {
  const layers = new MapLayerManager(app);
  let controller: AbortController | null = null;

  const intro = document.createElement("p");
  intro.textContent =
    `Switch this on, then click the map to look up the parcel there. Statewide parcel services are published by ${COVERED_STATES.length} states: ${COVERED_STATES.join(", ")}. ` +
    `Owner names come from ${OWNER_STATES.length} of them (${OWNER_STATES.join(", ")}); the rest give a parcel id and, for some, an address or acreage.`;

  const label = document.createElement("label");
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  label.append(toggle, document.createTextNode(" Look up the parcel under each click"));

  const result = document.createElement("div");
  result.className = "dc-parcel-result";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "dc-button";
  clear.textContent = "Clear outline";
  clear.addEventListener("click", () => {
    layers.removeAll();
    result.replaceChildren();
  });

  const row = (table: HTMLTableElement, name: string, value: string | null) => {
    const tr = table.insertRow();
    tr.insertCell().textContent = name;
    tr.insertCell().textContent = value ?? "not published";
  };

  const onClick = async (event: { lngLat: { lng: number; lat: number } }) => {
    const { lng, lat } = event.lngLat;
    controller?.abort();
    controller = new AbortController();
    result.textContent = `Looking up ${lat.toFixed(5)}, ${lng.toFixed(5)}…`;
    try {
      const { result: parcel, tried, errors } = await lookUpParcel(lng, lat, controller.signal);
      result.replaceChildren();
      if (!parcel) {
        result.textContent = tried.length
          ? `No parcel returned at ${lat.toFixed(5)}, ${lng.toFixed(5)} by ${tried.join(", ")}.${errors.length ? ` ${errors.join("; ")}.` : ""}`
          : `No statewide parcel service covers ${lat.toFixed(5)}, ${lng.toFixed(5)}.`;
        return;
      }
      const heading = document.createElement("p");
      heading.textContent = `${parcel.service.name} (${parcel.service.state})`;
      const table = document.createElement("table");
      row(table, "Owner", parcel.service.fields.owner ? parcel.owner : "this state publishes no owner name");
      row(table, "Parcel id", parcel.parcelId);
      row(table, "Acres", parcel.acres);
      row(table, "Address", parcel.address);
      row(table, "County", parcel.county);
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "All fields";
      const all = document.createElement("table");
      for (const [key, value] of Object.entries(parcel.properties)) row(all, key, value === null ? null : String(value));
      details.append(summary, all);
      const source = document.createElement("p");
      source.textContent = `Source: ${parcel.service.url}${parcel.service.note ? `. ${parcel.service.note}` : ""}`;
      result.append(heading, table, details, source);
      layers.addVector({
        key: "parcel-lookup",
        name: `Parcel ${parcel.parcelId ?? ""} (${parcel.service.state})`.replace("  ", " "),
        geojson: { type: "FeatureCollection", features: [parcel.feature] },
        role: "boundary",
        color: "#ffd400",
      });
    } catch (error) {
      if (controller?.signal.aborted) return;
      result.textContent = `The lookup failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  const map = () => app.getMap?.() as ClickMap | null | undefined;
  toggle.addEventListener("change", () => {
    const target = map();
    if (!target) return;
    if (toggle.checked) {
      target.on("click", onClick);
      if (target.getCanvas) target.getCanvas().style.cursor = "crosshair";
    } else {
      target.off("click", onClick);
      if (target.getCanvas) target.getCanvas().style.cursor = "";
    }
  });

  container.classList.add("dc-parcels");
  container.append(intro, label, result, clear);
  return () => {
    map()?.off("click", onClick);
    const canvas = map()?.getCanvas?.();
    if (canvas) canvas.style.cursor = "";
    controller?.abort();
    container.replaceChildren();
  };
}
