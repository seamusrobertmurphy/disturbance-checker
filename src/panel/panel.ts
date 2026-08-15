import { CLASS_LABELS, CLASS_PALETTE, DELTAS, DeltaId } from "../defaults";
import {
  Diagnostic,
  analyseHistogram,
  checkPeriod,
  checkSceneCounts,
  collectDeltaDiagnostics,
} from "../diagnostics";
import {
  Aoi,
  Period,
  PeriodResult,
  aoiBounds,
  runPeriod,
} from "../analysis/run";
import { describeError } from "../errors";
import { CLOUD_MASKS } from "../raster/mask";
import { gridCornersLonLat } from "../raster/grid";
import {
  IDS_ATTRIBUTION,
  MTBS_ATTRIBUTION,
  coverageFor,
  fireEvidence,
  insectAndDisease,
  managementRecord,
  yearsCovered,
} from "../reference/corroborate";
import { FACTS_ATTRIBUTION } from "../reference/management";
import {
  LANDFIRE_ATTRIBUTION,
  loadCatalogue,
  overlayFor,
  regionFor,
  serviceFor,
} from "../reference/landfire";
import { NBAC_ATTRIBUTION, NIFC_ATTRIBUTION } from "../reference/fire";
import {
  LCMS_ATTRIBUTION,
  LCMS_PRODUCTS,
  exportOverlay,
  withinConus,
} from "../reference/lcms";
import {
  WAYBACK_ATTRIBUTION,
  bracketLooks,
  distinctLooks,
  loadReleases,
  type Look,
} from "../reference/wayback";
import { buildManifest } from "../manifest";
import { MapLayerManager } from "../map/layers";
import {
  ACCEPTED_EXTENSIONS,
  ImportedVector,
  importVectorFile,
  pickFile,
} from "../vector/import";
import {
  ContextRole,
  State,
  breaksDeviate,
  defaultBreaks,
  isDelivery,
  isReadyToRun,
} from "../state";
import { GeoLibreAppAPI } from "../types/geolibre";
import { button, clear, el, field, formatDuration, formatHectares, input, select } from "./dom";
import { renderHistogramPlot } from "./histogram-plot";

const OPEN_SECTIONS_KEY = "tuvsud.disturbance.openSections";

const CONTEXT_META: Record<
  ContextRole,
  { label: string; colour: string; hint: string }
> = {
  boundary: {
    label: "Project boundary",
    colour: "#00e5ff",
    hint: "Sets the area of interest as well as drawing the outline.",
  },
  smz: {
    label: "Streamside management zones",
    colour: "#4ade80",
    hint: "Drawn as a dashed overlay so disturbance inside an SMZ is obvious.",
  },
  plots: {
    label: "Plot points",
    colour: "#facc15",
    hint: "Each point is labelled with its plot identifier so screenshots can be oriented.",
  },
};

export class DisturbancePanel {
  private container: HTMLElement | null = null;
  private clockTimer: number | null = null;
  /** Held outside state because it is a cosmetic consequence of drawing a
   * layer, not a parameter of the run. */
  private landfireLegend: Array<{ label: string; swatch: string }> = [];
  private open: Set<string>;
  private readonly layers: MapLayerManager;

  constructor(
    private readonly app: GeoLibreAppAPI,
    private state: State,
    private readonly onStateChange: (state: State) => void,
    private readonly onOpenGuide: (guideId: string | null) => void = () => {},
  ) {
    this.open = new Set(this.loadOpenSections());
    this.layers = new MapLayerManager(app);
  }

  private loadOpenSections(): string[] {
    try {
      const raw = window.sessionStorage.getItem(OPEN_SECTIONS_KEY);
      if (raw) return JSON.parse(raw) as string[];
    } catch {
      // Fall through to the default.
    }
    return ["project", "aoi", "period"];
  }

  private saveOpenSections(): void {
    try {
      window.sessionStorage.setItem(
        OPEN_SECTIONS_KEY,
        JSON.stringify([...this.open]),
      );
    } catch {
      // Session storage is optional.
    }
  }

  getState(): State {
    return this.state;
  }

  setState(next: State): void {
    this.state = next;
    this.onStateChange(next);
    this.rerender();
  }

  private patch(patch: Partial<State>): void {
    this.setState({ ...this.state, ...patch });
  }

  mount(container: HTMLElement): void {
    this.container = container;
    container.classList.add("dc-root");
    this.rerender();
    this.startClock();
  }

  destroy(): void {
    this.stopClock();
    this.layers.removeAll();
    if (this.container) clear(this.container);
    this.container = null;
  }

  private startClock(): void {
    this.stopClock();
    // Results used to go stale when the Earth Engine access token expired,
    // because the map tiles died with it. Nothing expires now: the layers are
    // images this tab painted. The clock survives only to keep the elapsed
    // time on screen honest.
    this.clockTimer = window.setInterval(() => {
      if (this.state.status !== "complete") return;
      this.rerender();
    }, 30_000);
  }

  private stopClock(): void {
    if (this.clockTimer !== null) {
      window.clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
  }

  private rerender(): void {
    if (!this.container) return;
    clear(this.container);

    this.container.appendChild(this.renderIntro());
    this.container.appendChild(
      this.section("project", "1", "Imagery", this.summariseSource(), () =>
        this.renderSource(),
      ),
    );
    this.container.appendChild(
      this.section("aoi", "2", "Area of interest", this.summariseAoi(), () =>
        this.renderAoi(),
      ),
    );
    this.container.appendChild(
      this.section("period", "3", "Reporting periods", this.summarisePeriods(), () =>
        this.renderPeriods(),
      ),
    );
    this.container.appendChild(
      this.section(
        "thresholds",
        "4",
        "Severity thresholds",
        this.summariseThresholds(),
        () => this.renderThresholds(),
      ),
    );
    this.container.appendChild(
      this.section(
        "context",
        "5",
        "Site data",
        this.summariseContext(),
        () => this.renderContext(),
      ),
    );
    this.container.appendChild(this.renderRunBar());
    this.container.appendChild(
      this.section("results", "6", "Results", this.summariseResults(), () =>
        this.renderResults(),
      ),
    );
    this.container.appendChild(
      this.section(
        "visual",
        "7",
        "Visual check",
        this.summariseVisual(),
        () => this.renderVisual(),
      ),
    );
    this.container.appendChild(
      this.section(
        "corroborate",
        "8",
        "Corroboration",
        this.summariseCorroboration(),
        () => this.renderCorroboration(),
      ),
    );
    this.container.appendChild(
      this.section(
        "findings",
        "9",
        "Delivery and record",
        this.summariseDelivery(),
        () => this.renderFindings(),
      ),
    );
    this.container.appendChild(this.renderHelpFooter());
  }

  /**
   * The library is also reachable from the toolbar menu. This footer exists
   * because someone stuck mid-run will look at the panel in front of them
   * before they look at the banner.
   */
  private renderHelpFooter(): HTMLElement {
    const footer = el("div", "dc-help-footer");
    footer.appendChild(el("span", "dc-help-footer-label", "Guides"));

    const row = el("div", "dc-row");
    row.appendChild(
      button("Using the tool", () => this.onOpenGuide("using-the-tool")),
    );
    row.appendChild(
      button("Interpreting results", () =>
        this.onOpenGuide("interpreting-results"),
      ),
    );
    row.appendChild(button("All guides", () => this.onOpenGuide(null)));
    footer.appendChild(row);

    return footer;
  }

  private renderIntro(): HTMLElement {
    const intro = el("div", "dc-intro");
    intro.appendChild(
      el(
        "p",
        "dc-intro-text",
        "Sentinel-2 NDVI, NDMI and NBR pre-post delta screening. This is an independent screening layer that complements, but does not replace, ground plots and developer monitoring reports.",
      ),
    );
    return intro;
  }

  private section(
    id: string,
    number: string,
    title: string,
    summary: string,
    render: () => HTMLElement,
  ): HTMLElement {
    const wrapper = el("section", "dc-section");
    const header = el("button", "dc-section-header");
    header.type = "button";
    const isOpen = this.open.has(id);
    header.setAttribute("aria-expanded", String(isOpen));

    header.appendChild(el("span", "dc-section-caret", isOpen ? "▼" : "▶"));
    header.appendChild(el("span", "dc-section-number", number));
    header.appendChild(el("span", "dc-section-title", title));
    if (!isOpen && summary) {
      header.appendChild(el("span", "dc-section-summary", summary));
    }
    header.addEventListener("click", () => {
      if (this.open.has(id)) this.open.delete(id);
      else this.open.add(id);
      this.saveOpenSections();
      this.rerender();
    });

    wrapper.appendChild(header);
    if (isOpen) {
      const body = el("div", "dc-section-body");
      body.appendChild(render());
      wrapper.appendChild(body);
    }
    return wrapper;
  }

  private summariseSource(): string {
    const mask = CLOUD_MASKS[this.state.maskId];
    return mask ? `Sentinel-2 L2A, ${mask.label}` : "Sentinel-2 L2A";
  }

  private summariseAoi(): string {
    if (!this.state.aoi) return "not set";
    return this.state.aoiLabel || "set";
  }

  private summarisePeriods(): string {
    const count = this.state.periods.length;
    return count === 1 ? this.state.periods[0].id : `${count} periods`;
  }

  private summariseResults(): string {
    if (this.state.status === "complete") return "complete";
    if (this.state.status === "stale") return "session expired";
    if (this.state.status === "error") return "failed";
    return "";
  }

  private summariseThresholds(): string {
    const adjusted = (Object.keys(DELTAS) as DeltaId[]).filter((id) =>
      breaksDeviate(this.state, id),
    );
    if (adjusted.length === 0) return "SOP defaults";
    return `${adjusted.length} adjusted`;
  }

  private summariseContext(): string {
    const loaded = (Object.keys(CONTEXT_META) as ContextRole[]).filter(
      (role) => this.state.context[role],
    );
    if (loaded.length === 0) return "none loaded";
    return loaded.map((role) => CONTEXT_META[role].label.split(" ")[0]).join(", ");
  }

  // Section 4 ---------------------------------------------------------------

  private renderThresholds(): HTMLElement {
    const body = el("div", "dc-stack");

    body.appendChild(
      el(
        "p",
        "dc-hint",
        "Each differenced index is classified into four classes. Anything below the Low threshold is undisturbed and renders transparent, so only disturbed cells are drawn over the site.",
      ),
    );

    const legend = el("div", "dc-legend");
    const swatch = (colour: string, label: string) => {
      const item = el("div", "dc-legend-item");
      const chip = el("span", "dc-legend-chip");
      chip.style.background = colour;
      item.appendChild(chip);
      item.appendChild(el("span", "", label));
      return item;
    };
    legend.appendChild(swatch("transparent", "Undisturbed"));
    CLASS_LABELS.forEach((label, index) => {
      legend.appendChild(swatch(CLASS_PALETTE[index], label));
    });
    body.appendChild(legend);

    for (const id of Object.keys(DELTAS) as DeltaId[]) {
      const spec = DELTAS[id];
      const card = el("div", "dc-threshold");

      const head = el("div", "dc-threshold-head");
      head.appendChild(el("span", "dc-delta-name", spec.label));
      if (breaksDeviate(this.state, id)) {
        head.appendChild(el("span", "dc-badge", "adjusted"));
        head.appendChild(
          button("Reset", () => {
            this.patch({
              breaks: { ...this.state.breaks, [id]: { ...spec.defaults } },
            });
          }),
        );
      }
      card.appendChild(head);

      const grid = el("div", "dc-grid-3");
      const keys = [
        ["low", "Low"],
        ["moderate", "Moderate"],
        ["high", "High"],
      ] as const;
      for (const [key, label] of keys) {
        const control = input("number", String(this.state.breaks[id][key]), (value) => {
          const parsed = Number.parseFloat(value);
          if (!Number.isFinite(parsed)) return;
          this.setBreak(id, key, parsed);
        });
        control.step = "0.01";
        control.min = "-0.5";
        control.max = "0.8";
        grid.appendChild(
          field(`${label} ≥`, control, `default ${spec.defaults[key]}`),
        );
      }
      card.appendChild(grid);
      card.appendChild(el("p", "dc-hint", spec.meaning));
      body.appendChild(card);
    }

    body.appendChild(
      button("Reset all to SOP defaults", () =>
        this.patch({ breaks: defaultBreaks() }),
      ),
    );
    body.appendChild(
      el(
        "p",
        "dc-hint",
        "Thresholds can also be dragged directly on the histograms after a run. Any value moved off its default must carry a written justification, which is recorded in the run manifest.",
      ),
    );

    return body;
  }

  /** Keeps Low < Moderate < High, so the four classes stay well ordered. */
  private setBreak(
    id: DeltaId,
    key: "low" | "moderate" | "high",
    value: number,
  ): void {
    const current = { ...this.state.breaks[id] };
    const step = 0.005;
    current[key] = value;
    if (key === "low") current.low = Math.min(value, current.moderate - step);
    if (key === "moderate") {
      current.moderate = Math.min(
        Math.max(value, current.low + step),
        current.high - step,
      );
    }
    if (key === "high") current.high = Math.max(value, current.moderate + step);
    this.patch({ breaks: { ...this.state.breaks, [id]: current } });
  }

  // Section 5 ---------------------------------------------------------------

  private renderContext(): HTMLElement {
    const body = el("div", "dc-stack");

    body.appendChild(
      el(
        "p",
        "dc-hint",
        "Zipped shapefile, GeoJSON, or KML. Files are read in the browser and never uploaded anywhere.",
      ),
    );

    for (const role of Object.keys(CONTEXT_META) as ContextRole[]) {
      const meta = CONTEXT_META[role];
      const loaded = this.state.context[role];
      const card = el("div", "dc-context");

      const head = el("div", "dc-context-head");
      const swatch = el("span", "dc-legend-chip");
      swatch.style.background = meta.colour;
      head.appendChild(swatch);
      head.appendChild(el("span", "dc-context-label", meta.label));
      card.appendChild(head);

      if (loaded) {
        card.appendChild(
          el(
            "div",
            "dc-context-meta",
            `${loaded.name} · ${loaded.featureCount} feature${loaded.featureCount === 1 ? "" : "s"} · ${loaded.geometryKinds.join(", ") || "unknown geometry"}`,
          ),
        );

        if (role === "plots") {
          const select = el("select", "dc-input");
          const none = el("option", "", "no label");
          none.value = "";
          select.appendChild(none);
          for (const fieldName of loaded.fields) {
            const option = el("option", "", fieldName);
            option.value = fieldName;
            if (fieldName === loaded.labelField) option.selected = true;
            select.appendChild(option);
          }
          select.addEventListener("change", () => {
            const next = { ...loaded, labelField: select.value || null };
            this.patch({
              context: { ...this.state.context, plots: next },
            });
            this.drawContext("plots", next);
          });
          card.appendChild(
            field(
              "Label field",
              select,
              loaded.labelField
                ? `Detected "${loaded.labelField}". Change it if the plot identifier lives in another column.`
                : "No plot identifier was detected. Choose the column holding it.",
            ),
          );
          if (
            loaded.fields.length > 0 &&
            !loaded.geometryKinds.some((kind) => kind.includes("Point"))
          ) {
            card.appendChild(
              this.notice(
                "warning",
                "Plot data is not points",
                `The file contains ${loaded.geometryKinds.join(", ")}. Labels are drawn at each geometry, which may not be where you expect.`,
              ),
            );
          }
        }

        const actions = el("div", "dc-row");
        if (loaded.bounds) {
          actions.appendChild(
            button("Zoom to", () => this.app.fitBounds?.(loaded.bounds!)),
          );
        }
        actions.appendChild(button("Replace", () => void this.loadContext(role)));
        actions.appendChild(button("Remove", () => this.clearContext(role)));
        card.appendChild(actions);
      } else {
        card.appendChild(el("p", "dc-hint", meta.hint));
        card.appendChild(
          button(`Load ${meta.label.toLowerCase()}`, () =>
            void this.loadContext(role),
          ),
        );
      }

      body.appendChild(card);
    }

    return body;
  }

  private async loadContext(role: ContextRole): Promise<void> {
    const file = await pickFile(ACCEPTED_EXTENSIONS);
    if (!file) return;

    try {
      const imported: ImportedVector = await importVectorFile(file);
      const layer = {
        name: file.name,
        featureCount: imported.featureCount,
        fields: imported.fields,
        labelField: role === "plots" ? imported.suggestedLabelField : null,
        geometryKinds: imported.geometryKinds,
        bounds: imported.bounds,
        geojson: imported.geojson,
      };

      const patch: Partial<State> = {
        context: { ...this.state.context, [role]: layer },
        error: null,
      };

      // A project boundary is the natural area of interest, so loading one sets
      // the AOI rather than making the operator type the same extent twice.
      if (role === "boundary") {
        patch.aoi = { kind: "geojson", geometry: imported.geojson };
        patch.aoiLabel = file.name;
      }

      this.patch(patch);
      this.drawContext(role, layer);
      if (imported.bounds) this.app.fitBounds?.(imported.bounds);
    } catch (error) {
      this.patch({ error: describeError(error) });
    }
  }

  private clearContext(role: ContextRole): void {
    this.layers.remove(`tuvsud-dc-ctx-${role}`);
    const patch: Partial<State> = {
      context: { ...this.state.context, [role]: null },
    };
    if (role === "boundary" && this.state.aoi?.kind === "geojson") {
      patch.aoi = null;
      patch.aoiLabel = "";
    }
    this.patch(patch);
  }

  private drawContext(
    role: ContextRole,
    layer: { geojson: unknown; labelField: string | null; name: string },
  ): void {
    this.layers.addVector({
      key: `ctx-${role}`,
      name: CONTEXT_META[role].label,
      geojson: layer.geojson,
      role,
      labelField: role === "plots" ? layer.labelField : null,
      color: CONTEXT_META[role].colour,
    });
  }

  /** Redraw uploaded layers after a project restore. */
  restoreContext(): void {
    for (const role of Object.keys(CONTEXT_META) as ContextRole[]) {
      const layer = this.state.context[role];
      if (layer?.geojson) this.drawContext(role, layer);
    }
  }

  // Section 1 ---------------------------------------------------------------

  private renderSource(): HTMLElement {
    const body = el("div", "dc-stack");

    body.appendChild(
      this.notice(
        "info",
        "No account needed",
        "Imagery comes from the Copernicus Sentinel-2 L2A archive published as cloud-optimised GeoTIFFs on AWS Open Data, found through Element 84's public Earth Search catalogue. Both answer anonymous requests, so there is nothing to sign in to and nothing to be granted access to. Every pixel is read and reduced in this browser tab.",
      ),
    );

    const mask = CLOUD_MASKS[this.state.maskId];
    if (mask) {
      body.appendChild(
        field(
          "Cloud masking",
          select(
            Object.values(CLOUD_MASKS).map((option) => ({
              value: option.id,
              label: option.label,
            })),
            mask.id,
            (value) => {
              this.patch({
                maskId: value,
                status:
                  this.state.status === "complete" ? "stale" : this.state.status,
              });
            },
          ),
          mask.description,
        ),
      );
    }

    // Cast shadow is a scene-classification setting, so it is shown only when
    // that is what is running. The model has no such class: it was trained to
    // tell a cloud's shadow from a hillside in shade, which is the question
    // this switch exists to work around.
    if (this.state.maskId === "scl") {
      const castShadow = input(
        "checkbox",
        String(this.state.maskOptions.rejectCastShadow),
        () => {},
      );
      castShadow.checked = this.state.maskOptions.rejectCastShadow;
      castShadow.addEventListener("change", () => {
        this.patch({
          maskOptions: {
            ...this.state.maskOptions,
            rejectCastShadow: castShadow.checked,
          },
          status: this.state.status === "complete" ? "stale" : this.state.status,
        });
      });
      body.appendChild(
        field(
          "Reject cast shadow",
          castShadow,
          "Scene classification class 2 covers both cloud shadow the classifier declined to call class 3 and ordinary topographic shade. Rejecting it is right on flat ground. In steep terrain it can remove most north-facing slopes from every scene in the window, which costs more than the cloud it avoids.",
        ),
      );
    }

    const snow = input("checkbox", String(this.state.maskOptions.rejectSnow), () => {});
    snow.checked = this.state.maskOptions.rejectSnow;
    snow.addEventListener("change", () => {
      this.patch({
        maskOptions: { ...this.state.maskOptions, rejectSnow: snow.checked },
        status: this.state.status === "complete" ? "stale" : this.state.status,
      });
    });
    body.appendChild(
      field(
        "Reject snow and ice",
        snow,
        "Class 11. Relevant only where a window reaches into the shoulder season.",
      ),
    );

    body.appendChild(
      this.state.maskId === "scl"
        ? this.notice(
            "warning",
            "A better mask is available",
            "The scene classification is a per-pixel category, and what it lets through is thin cloud edges and cloud shadow, both of which read as canopy loss in a delta. On a 61 percent cloudy overpass of a Montana project it called 11.4 percent of a block clear where the segmentation model called it cloud or shadow, against 0.75 percent the other way. Switch the mask above where the result matters. It costs a 57 MB download once, and per overpass per block 0.26 seconds in a browser with WebGPU or 6.3 seconds without it.",
          )
        : this.notice(
            "info",
            "Model runs in this tab",
            "The weights download once, then stay in the browser cache. Use a browser with WebGPU: measured in Chrome 151, one block through both models takes 0.26 seconds on WebGPU and 6.3 seconds without it, and the run manifest records which one you got. Snow, saturated and no-data pixels still come from the scene classification, which is authoritative about all three.",
          ),
    );

    return body;
  }

  // Section 2 ---------------------------------------------------------------

  private renderAoi(): HTMLElement {
    const body = el("div", "dc-stack");
    const aoi = this.state.aoi;

    const kindRow = el("div", "dc-row");
    const kinds: Array<[Aoi["kind"], string]> = [
      ["rectangle", "Bounds"],
      ["geojson", "GeoJSON"],
    ];
    for (const [kind, label] of kinds) {
      const active = aoi?.kind === kind;
      kindRow.appendChild(
        button(
          label,
          () => this.setAoiKind(kind),
          active ? "primary" : "secondary",
        ),
      );
    }
    body.appendChild(kindRow);

    if (this.state.context.boundary) {
      body.appendChild(
        this.notice(
          "info",
          "Using the uploaded project boundary",
          `${this.state.context.boundary.name} is set as the area of interest. Load a different boundary under Site data to change it.`,
        ),
      );
    } else {
      body.appendChild(
        button("Upload project boundary", () => void this.loadContext("boundary")),
      );
    }

    if (!aoi || aoi.kind === "rectangle") {
      const bounds = aoi?.kind === "rectangle" ? aoi : null;
      body.appendChild(
        button("Use current map view", () => this.useMapBounds(), "secondary"),
      );
      const grid = el("div", "dc-grid-2");
      const setBound = (key: "west" | "south" | "east" | "north", value: string) => {
        const parsed = Number.parseFloat(value);
        if (!Number.isFinite(parsed)) return;
        const base: Aoi =
          this.state.aoi?.kind === "rectangle"
            ? this.state.aoi
            : { kind: "rectangle", west: 0, south: 0, east: 0, north: 0 };
        const next = { ...base, [key]: parsed } as Aoi;
        this.patch({ aoi: next, aoiLabel: this.describeBounds(next) });
      };
      for (const key of ["west", "south", "east", "north"] as const) {
        grid.appendChild(
          field(
            key[0].toUpperCase() + key.slice(1),
            input("number", bounds ? String(bounds[key]) : "", (value) =>
              setBound(key, value),
            ),
          ),
        );
      }
      body.appendChild(grid);
      body.appendChild(
        el(
          "p",
          "dc-hint",
          "Coordinates are EPSG:4326. Reversed pairs are normalised automatically, so a swapped east and west cannot silently produce an empty geometry.",
        ),
      );
    }

    if (aoi?.kind === "geojson") {
      const area = el("textarea", "dc-textarea");
      area.rows = 5;
      area.placeholder = '{"type":"Polygon","coordinates":[...]}';
      area.addEventListener("change", () => {
        try {
          const parsed = JSON.parse(area.value) as {
            type?: string;
            geometry?: unknown;
          };
          const geometry =
            parsed.type === "Feature" ? parsed.geometry : parsed;
          this.patch({
            aoi: { kind: "geojson", geometry },
            aoiLabel: "uploaded boundary",
            error: null,
          });
        } catch {
          this.patch({ error: "The pasted GeoJSON could not be parsed." });
        }
      });
      body.appendChild(field("Boundary geometry", area));
    }

    return body;
  }

  private describeBounds(aoi: Aoi): string {
    if (aoi.kind !== "rectangle") return "";
    return `${aoi.west.toFixed(2)}, ${aoi.south.toFixed(2)} to ${aoi.east.toFixed(2)}, ${aoi.north.toFixed(2)}`;
  }

  private setAoiKind(kind: Aoi["kind"]): void {
    if (kind === "rectangle") {
      this.patch({
        aoi: { kind: "rectangle", west: 0, south: 0, east: 0, north: 0 },
        aoiLabel: "",
      });
    } else {
      this.patch({ aoi: { kind: "geojson", geometry: null }, aoiLabel: "" });
    }
  }

  private useMapBounds(): void {
    const map = this.app.getMap?.() as
      | { getBounds?: () => { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number } }
      | null
      | undefined;
    const bounds = map?.getBounds?.();
    if (!bounds) {
      this.patch({ error: "The map view could not be read." });
      return;
    }
    const aoi: Aoi = {
      kind: "rectangle",
      west: Number(bounds.getWest().toFixed(5)),
      south: Number(bounds.getSouth().toFixed(5)),
      east: Number(bounds.getEast().toFixed(5)),
      north: Number(bounds.getNorth().toFixed(5)),
    };
    this.patch({ aoi, aoiLabel: this.describeBounds(aoi), error: null });
  }

  // Section 3 ---------------------------------------------------------------

  private renderPeriods(): HTMLElement {
    const body = el("div", "dc-stack");

    this.state.periods.forEach((period, index) => {
      const card = el("div", "dc-period");
      const head = el("div", "dc-period-head");
      const name = input("text", period.id, (value) =>
        this.updatePeriod(index, { id: value.trim() || period.id }),
      );
      name.className = "dc-input dc-input-inline";
      head.appendChild(name);
      if (this.state.periods.length > 1) {
        head.appendChild(button("Remove", () => this.removePeriod(index)));
      }
      card.appendChild(head);

      const grid = el("div", "dc-grid-2");
      grid.appendChild(
        field(
          "Pre start",
          input("date", period.preStart, (value) =>
            this.updatePeriod(index, { preStart: value }),
          ),
        ),
      );
      grid.appendChild(
        field(
          "Pre end",
          input("date", period.preEnd, (value) =>
            this.updatePeriod(index, { preEnd: value }),
          ),
        ),
      );
      grid.appendChild(
        field(
          "Post start",
          input("date", period.postStart, (value) =>
            this.updatePeriod(index, { postStart: value }),
          ),
        ),
      );
      grid.appendChild(
        field(
          "Post end",
          input("date", period.postEnd, (value) =>
            this.updatePeriod(index, { postEnd: value }),
          ),
        ),
      );
      card.appendChild(grid);

      for (const diagnostic of checkPeriod(period)) {
        card.appendChild(
          this.notice(diagnostic.severity, diagnostic.title, diagnostic.detail),
        );
      }
      body.appendChild(card);
    });

    body.appendChild(button("Add reporting period", () => this.addPeriod()));

    if (this.state.periods.length > 1) {
      body.appendChild(
        el(
          "p",
          "dc-hint",
          "One threshold set applies to every period, so inter-period change stays comparable.",
        ),
      );
    }

    body.appendChild(
      el(
        "p",
        "dc-hint",
        "Cloud handling lives in section 1 now, because the choice is no longer between two reductions. Every observation that survives masking goes into a per-pixel median.",
      ),
    );

    const cloud = el("input", "dc-range");
    cloud.type = "range";
    cloud.min = "5";
    cloud.max = "60";
    cloud.step = "5";
    cloud.value = String(this.state.maxCloud);
    cloud.addEventListener("input", () => {
      this.state.maxCloud = Number.parseInt(cloud.value, 10);
      const readout = this.container?.querySelector(".dc-cloud-readout");
      if (readout) readout.textContent = `${this.state.maxCloud} %`;
    });
    cloud.addEventListener("change", () =>
      this.patch({ maxCloud: Number.parseInt(cloud.value, 10) }),
    );

    const cloudRow = el("div", "dc-row dc-row-center");
    cloudRow.appendChild(cloud);
    cloudRow.appendChild(
      el("span", "dc-cloud-readout", `${this.state.maxCloud} %`),
    );
    body.appendChild(
      field(
        "Maximum scene cloud cover",
        cloudRow,
        "Discards scenes above this whole-scene cloud percentage before anything is downloaded. Masking is per pixel, so this is a speed control rather than a quality one: every scene kept is a set of range reads over the network. Raise it when a window is thin and the coverage warning fires, lower it when a run feels slow.",
      ),
    );

    return body;
  }

  private updatePeriod(index: number, patch: Partial<Period>): void {
    const periods = this.state.periods.map((period, i) =>
      i === index ? { ...period, ...patch } : period,
    );
    this.patch({ periods });
  }

  private addPeriod(): void {
    const last = this.state.periods[this.state.periods.length - 1];
    const nextNumber = this.state.periods.length + 1;
    const bump = (date: string): string => {
      const year = Number.parseInt(date.slice(0, 4), 10) + 1;
      return `${year}${date.slice(4)}`;
    };
    this.patch({
      periods: [
        ...this.state.periods,
        {
          id: `RP${nextNumber}`,
          preStart: last.postStart,
          preEnd: last.postEnd,
          postStart: bump(last.postStart),
          postEnd: bump(last.postEnd),
        },
      ],
    });
  }

  private removePeriod(index: number): void {
    this.patch({
      periods: this.state.periods.filter((_, i) => i !== index),
    });
  }

  // Run bar -----------------------------------------------------------------

  private renderRunBar(): HTMLElement {
    const bar = el("div", "dc-runbar");
    const running = this.state.status === "running";
    const blocked = !isReadyToRun(this.state);

    const label =
      this.state.status === "stale" ? "Re-run check" : "Run check";
    const runButton = button(running ? "Running..." : label, () => void this.run(), "primary");
    runButton.disabled = running || blocked;
    bar.appendChild(runButton);

    if (blocked && !running) {
      bar.appendChild(
        el("span", "dc-runbar-hint", "Set an area of interest first."),
      );
    }

    if (running && this.state.progress) {
      bar.appendChild(el("span", "dc-runbar-hint", this.state.progress));
    }

    if (this.state.error) {
      bar.appendChild(this.notice("warning", "Run failed", this.state.error));
    }

    return bar;
  }

  // Section 4 ---------------------------------------------------------------

  private renderResults(): HTMLElement {
    const body = el("div", "dc-stack");

    if (this.state.status === "idle") {
      body.appendChild(
        el("p", "dc-hint", "No run yet. Set the area and the period, then run the check."),
      );
      return body;
    }

    if (this.state.status === "stale") {
      body.appendChild(
        this.notice(
          "warning",
          "Settings changed since this run",
          "A parameter has moved since these layers were drawn, so what is on the map no longer matches what is in the panel. The layers themselves do not expire. Re-run to bring them back into agreement.",
        ),
      );
    } else if (this.state.status === "complete" && this.state.runStartedAt) {
      const elapsed = Date.now() - this.state.runStartedAt;
      const clock = el("div", "dc-clock");
      clock.appendChild(
        el(
          "span",
          "dc-clock-text",
          `Run at ${new Date(this.state.runStartedAt).toLocaleTimeString()} · ${formatDuration(elapsed)} ago`,
        ),
      );
      body.appendChild(clock);
    }

    const unacknowledged = this.state.diagnostics.filter(
      (diagnostic) => diagnostic.severity === "warning",
    );
    if (unacknowledged.length > 0 && !this.state.acknowledged) {
      const box = el("div", "dc-notice dc-notice-warning");
      box.appendChild(el("div", "dc-notice-title", "Review before issuing"));
      for (const diagnostic of unacknowledged) {
        const item = el("div", "dc-notice-item");
        item.appendChild(el("strong", "", diagnostic.title));
        item.appendChild(el("div", "dc-notice-detail", diagnostic.detail));
        item.appendChild(el("div", "dc-notice-source", diagnostic.source));
        box.appendChild(item);
      }
      box.appendChild(
        button("Acknowledge", () => this.patch({ acknowledged: true }), "primary"),
      );
      body.appendChild(box);
    }

    for (const result of this.state.results) {
      body.appendChild(this.renderPeriodResult(result));
    }

    return body;
  }

  private renderPeriodResult(result: PeriodResult): HTMLElement {
    const card = el("div", "dc-result");
    card.appendChild(el("div", "dc-result-title", result.periodId));
    card.appendChild(
      el(
        "div",
        "dc-result-meta",
        `${result.preObservations.length} pre overpasses · ${result.postObservations.length} post overpasses · ${formatHectares(result.aoiAreaHa)} ha observed · EPSG:${result.grid.epsg} at ${result.grid.resolution} m`,
      ),
    );

    for (const id of Object.keys(DELTAS) as DeltaId[]) {
      const delta = result.deltas[id];
      const analysis = this.state.analyses[result.periodId]?.[id];
      const block = el("div", "dc-delta");

      const head = el("div", "dc-delta-head");
      head.appendChild(el("span", "dc-delta-name", DELTAS[id].label));
      if (breaksDeviate(this.state, id)) {
        head.appendChild(el("span", "dc-badge", "adjusted"));
      }
      block.appendChild(head);

      block.appendChild(
        renderHistogramPlot({
          bins: delta.histogram,
          breaks: this.state.breaks[id],
          defaults: DELTAS[id].defaults,
          suggestedLow: analysis?.suggestedLow ?? null,
          onBreaksChange: (breaks) => {
            this.state.breaks = { ...this.state.breaks, [id]: breaks };
            this.onStateChange(this.state);
            this.refreshBreakReadout(id);
          },
        }),
      );

      const readout = el("div", "dc-breaks", "");
      readout.dataset.delta = id;
      block.appendChild(readout);

      const table = el("table", "dc-table");
      const header = el("tr");
      header.appendChild(el("th", "", ""));
      for (const label of CLASS_LABELS) header.appendChild(el("th", "", label));
      header.appendChild(el("th", "", "Total"));
      table.appendChild(header);

      const row = el("tr");
      row.appendChild(el("td", "", "ha"));
      let total = 0;
      delta.areasHa.forEach((value, index) => {
        total += value;
        const cell = el("td", "", formatHectares(value));
        cell.style.borderBottom = `2px solid ${CLASS_PALETTE[index]}`;
        row.appendChild(cell);
      });
      row.appendChild(el("td", "dc-table-total", formatHectares(total)));
      table.appendChild(row);

      if (result.aoiAreaHa > 0) {
        const share = el("tr");
        share.appendChild(el("td", "", "% AOI"));
        delta.areasHa.forEach((value) => {
          share.appendChild(
            el("td", "", ((value / result.aoiAreaHa) * 100).toFixed(2)),
          );
        });
        share.appendChild(
          el(
            "td",
            "dc-table-total",
            ((total / result.aoiAreaHa) * 100).toFixed(2),
          ),
        );
        table.appendChild(share);
      }
      block.appendChild(table);

      if (breaksDeviate(this.state, id)) {
        const justification = el("textarea", "dc-textarea");
        justification.rows = 2;
        justification.placeholder =
          "Required: why the histogram supports moving this break off the default.";
        justification.value = this.state.justifications[id] ?? "";
        justification.addEventListener("change", () => {
          this.state.justifications = {
            ...this.state.justifications,
            [id]: justification.value,
          };
          this.onStateChange(this.state);
        });
        block.appendChild(field("Deviation justification", justification));
      }

      card.appendChild(block);
    }

    const apply = button(
      "Apply thresholds to map",
      () => void this.run(),
      "secondary",
    );
    card.appendChild(apply);
    card.appendChild(
      el(
        "p",
        "dc-hint",
        "Moving a break changes the classification, which is computed by Earth Engine. Applying re-runs the classification step against the current thresholds.",
      ),
    );

    return card;
  }

  private refreshBreakReadout(id: DeltaId): void {
    const node = this.container?.querySelector(
      `.dc-breaks[data-delta="${id}"]`,
    );
    if (!node) return;
    const breaks = this.state.breaks[id];
    node.textContent = `Low ${breaks.low.toFixed(2)} · Moderate ${breaks.moderate.toFixed(2)} · High ${breaks.high.toFixed(2)}`;
  }

  // Section 5 ---------------------------------------------------------------

  // Section 7 ---------------------------------------------------------------

  private summariseVisual(): string {
    if (this.state.looksStatus === "loading") return "searching";
    if (this.state.looks.length === 0) return "";
    return `${this.state.looks.length} looks`;
  }

  /**
   * Two independent visual checks on the same screen.
   *
   * The first is the tool's own before-and-after true colour, at 10 m, built
   * from the same masked observations the indices were built from. It answers
   * whether the composite that produced the number looks like what the number
   * claims.
   *
   * The second is Esri's dated high-resolution archive, frequently sub-metre.
   * It answers what the ground actually is: a cutblock, a road, a landing, a
   * blowdown. Sentinel-2 cannot resolve that and never could.
   */
  private renderVisual(): HTMLElement {
    const body = el("div", "dc-stack");

    if (this.state.results.length === 0) {
      body.appendChild(
        el("p", "dc-hint", "Run a check first. Both comparisons need an area and a pair of dates."),
      );
      return body;
    }

    body.appendChild(el("div", "dc-subhead", "Before and after, 10 m"));

    const blend = el("input", "dc-range");
    blend.type = "range";
    blend.min = "0";
    blend.max = "100";
    blend.step = "1";
    blend.value = String(Math.round(this.state.rgbBlend * 100));
    blend.addEventListener("input", () => {
      this.applyBlend(Number.parseInt(blend.value, 10) / 100);
    });

    const blendRow = el("div", "dc-row dc-row-center");
    blendRow.appendChild(el("span", "dc-blend-end", "Pre"));
    blendRow.appendChild(blend);
    blendRow.appendChild(el("span", "dc-blend-end", "Post"));
    body.appendChild(
      field(
        "Crossfade",
        blendRow,
        "Drag to fade between the pre and post true-colour composites. Both are built from the masked observations the analysis used, not from a single scene, so what you see is what was measured.",
      ),
    );

    const blinkRow = el("div", "dc-row");
    blinkRow.appendChild(
      button("Blink", () => this.blink(), "secondary"),
    );
    blinkRow.appendChild(
      button("Hide both", () => this.stopBlend(), "secondary"),
    );
    body.appendChild(blinkRow);
    body.appendChild(
      el(
        "p",
        "dc-hint",
        "Blinking between two dates over fixed ground is how change is found by eye. A clearing jumps; noise does not.",
      ),
    );

    body.appendChild(el("div", "dc-subhead", "High-resolution archive"));

    if (this.state.looksStatus === "idle") {
      body.appendChild(
        button("Find available imagery", () => void this.findLooks(), "primary"),
      );
      body.appendChild(
        el(
          "p",
          "dc-hint",
          "Searches Esri's dated World Imagery archive for every distinct photograph of this site. Takes around twenty seconds, because it reads capture metadata release by release.",
        ),
      );
      return body;
    }

    if (this.state.looksStatus === "loading") {
      body.appendChild(el("p", "dc-hint", "Reading capture dates, around twenty seconds."));
      return body;
    }

    if (this.state.looksStatus === "error") {
      body.appendChild(
        this.notice(
          "warning",
          "The archive could not be read",
          this.state.looksError ??
            "The dated basemap is unavailable. The analysis is unaffected.",
        ),
      );
      body.appendChild(button("Try again", () => void this.findLooks(), "secondary"));
      return body;
    }

    if (this.state.looks.length === 0) {
      body.appendChild(
        this.notice(
          "warning",
          "No high-resolution imagery found here",
          "The archive holds no dated capture over this area. Outside the United States and Europe this is common in remote terrain.",
        ),
      );
      return body;
    }

    const period = this.state.periods[0];
    const bracket = period
      ? bracketLooks(this.state.looks, period.preEnd, period.postEnd)
      : { before: null, after: null, latest: null };

    // The trap this section exists to prevent. A release is a publication
    // event; a capture is a photograph. Consecutive releases usually carry the
    // identical picture, so a verifier stepping through release dates can
    // easily write down a date four years away from the imagery in front of
    // them.
    if (
      bracket.before &&
      bracket.after &&
      bracket.before.capture.captureDate === bracket.after.capture.captureDate
    ) {
      body.appendChild(
        this.notice(
          "warning",
          "No independent look inside the post window",
          `The newest capture at or before both window ends is the same photograph, from ${bracket.before.capture.captureDate}. High-resolution imagery cannot confirm or refute a change between these two dates here, and quoting it as if it could would misdate the evidence.`,
        ),
      );
    }

    for (const look of this.state.looks) {
      body.appendChild(this.renderLook(look, bracket));
    }

    body.appendChild(
      el(
        "p",
        "dc-hint",
        `Dates shown are capture dates read from the archive's own metadata at this location, not release dates. ${WAYBACK_ATTRIBUTION}.`,
      ),
    );

    return body;
  }

  private renderLook(
    look: Look,
    bracket: { before: Look | null; after: Look | null },
  ): HTMLElement {
    const row = el("div", "dc-look");
    const active = this.state.activeLook === look.capture.captureDate;

    const labels: string[] = [];
    if (bracket.before && bracket.before === look) labels.push("pre window");
    if (bracket.after && bracket.after === look) labels.push("post window");

    const head = el("div", "dc-look-head");
    head.appendChild(
      el("span", "dc-look-date", look.capture.captureDate ?? "undated"),
    );
    if (labels.length > 0) {
      head.appendChild(el("span", "dc-look-tag", labels.join(", ")));
    }
    row.appendChild(head);

    const parts = [
      look.capture.resolution ? `${look.capture.resolution} m` : null,
      look.capture.source,
      look.capture.provider,
      look.capture.accuracy ? `±${look.capture.accuracy} m` : null,
    ].filter(Boolean);
    row.appendChild(el("div", "dc-look-meta", parts.join(" · ")));

    row.appendChild(
      button(
        active ? "Hide" : "Show",
        () => this.toggleLook(look),
        active ? "primary" : "secondary",
      ),
    );
    return row;
  }

  private async findLooks(): Promise<void> {
    const bounds = this.state.results[0]?.grid;
    const aoi = this.state.aoi;
    if (!aoi) return;

    this.patch({ looksStatus: "loading", looksError: null });
    try {
      const centre = this.aoiCentre();
      if (!centre) throw new Error("The area of interest has no centre.");
      const releases = await loadReleases();
      const looks = await distinctLooks(releases, centre.lon, centre.lat);
      this.patch({ looks, looksStatus: "ready", looksError: null });
    } catch (error) {
      this.patch({
        looksStatus: "error",
        looksError: describeError(error),
      });
    }
    void bounds;
  }

  private aoiCentre(): { lon: number; lat: number } | null {
    const grid = this.state.results[0]?.grid;
    if (grid) {
      const corners = gridCornersLonLat(grid);
      const lon =
        corners.reduce((total, corner) => total + corner[0], 0) / corners.length;
      const lat =
        corners.reduce((total, corner) => total + corner[1], 0) / corners.length;
      return { lon, lat };
    }
    const aoi = this.state.aoi;
    if (aoi?.kind === "rectangle") {
      return {
        lon: (aoi.west + aoi.east) / 2,
        lat: (aoi.south + aoi.north) / 2,
      };
    }
    return null;
  }

  private toggleLook(look: Look): void {
    const key = "ref-wayback";
    if (this.state.activeLook === look.capture.captureDate) {
      this.layers.remove(`tuvsud-dc-${key}`);
      this.patch({ activeLook: null });
      return;
    }
    this.layers.addTiles({
      key,
      name: `Imagery ${look.capture.captureDate ?? look.release.releaseDate}`,
      tileUrl: look.release.tileUrl,
      attribution: WAYBACK_ATTRIBUTION,
      visible: true,
      maxzoom: 19,
      // Under every result layer: it is context for the analysis, not a
      // competitor to it.
      beforeId: this.lowestResultLayerId(),
    });
    this.patch({ activeLook: look.capture.captureDate });
  }

  /** The bottom-most layer this run created, so reference imagery slides
   * underneath the whole result stack rather than on top of the basemap. */
  private lowestResultLayerId(): string | undefined {
    const first = this.state.layerIds[0];
    return first ? `${first}-lyr` : undefined;
  }

  private applyBlend(value: number): void {
    const result = this.state.results[0];
    if (!result) return;
    const pre = `r-${this.layerKeyFor(result, "pre-rgb")}`;
    const post = `r-${this.layerKeyFor(result, "post-rgb")}`;
    this.layers.setVisible(pre, true);
    this.layers.setVisible(post, true);
    this.layers.setOpacity(pre, 1);
    // Fading the post layer over an opaque pre layer keeps the ground covered
    // at every position on the slider. Fading both leaves the basemap showing
    // through in the middle, which reads as haze and is exactly the artefact
    // the check is looking for.
    this.layers.setOpacity(post, value);
    this.state.rgbBlend = value;
    this.state.rgbBlendActive = true;
  }

  private stopBlend(): void {
    const result = this.state.results[0];
    if (!result) return;
    this.layers.setVisible(`r-${this.layerKeyFor(result, "pre-rgb")}`, false);
    this.layers.setVisible(`r-${this.layerKeyFor(result, "post-rgb")}`, false);
    this.patch({ rgbBlendActive: false });
  }

  private blink(): void {
    const steps = [0, 1, 0, 1, 0, 1];
    steps.forEach((value, index) => {
      window.setTimeout(() => this.applyBlend(value), index * 650);
    });
  }

  private layerKeyFor(result: PeriodResult, suffix: string): string {
    const layer = result.layers.find((entry) => entry.key.endsWith(suffix));
    return (layer?.key ?? "").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  }

  // Section 8 ---------------------------------------------------------------

  private summariseCorroboration(): string {
    const held = this.state.corroboration;
    if (this.state.corroborationStatus === "loading") return "searching";
    if (!held) return "";
    const parts: string[] = [];
    if (held.fires.records.length > 0) {
      parts.push(`${held.fires.records.length} fires`);
    }
    if (held.ids.groups.length > 0) {
      parts.push(`${Math.round(held.ids.totalAcres).toLocaleString()} ac damage`);
    }
    return parts.join(", ") || "nothing recorded";
  }

  /**
   * Independent records of what happened on the ground.
   *
   * The indices say a delta moved. These say whether an aerial observer
   * recorded beetle mortality over the same ground, or whether a mapped fire
   * burned through it. Neither is an input: no composite, delta, break or area
   * changes because of anything in this section. They exist so a finding can
   * cite a second, unrelated source with its own date and its own provenance.
   */
  private renderCorroboration(): HTMLElement {
    const body = el("div", "dc-stack");
    const bbox = this.aoiBbox();

    if (!bbox) {
      body.appendChild(
        el("p", "dc-hint", "Set an area of interest first."),
      );
      return body;
    }

    const coverage = coverageFor(bbox);
    if (coverage.none) {
      body.appendChild(
        this.notice(
          "info",
          "Outside every registry wired up here",
          "The fire and forest health registries this tool queries cover the United States and Canada. This area is outside both, so there is nothing to query. That is a gap in coverage, not an absence of disturbance, and a finding must not cite these datasets here.",
        ),
      );
      return body;
    }
    if (coverage.canada && !coverage.unitedStates) {
      body.appendChild(
        this.notice(
          "info",
          "Canadian coverage is fire only",
          "Mapped fire comes from the National Burned Area Composite, which runs from 1972. There is no Canadian equivalent of the United States aerial insect and disease survey wired up here, so an absence of insect damage below means it was not looked for.",
        ),
      );
    }

    if (this.state.corroborationStatus === "idle") {
      body.appendChild(
        button("Search the record", () => void this.fetchCorroboration(), "primary"),
      );
      body.appendChild(
        el(
          "p",
          "dc-hint",
          "Queries the Forest Service aerial insect and disease survey and the Monitoring Trends in Burn Severity assessment over this area, for every year the reporting windows span.",
        ),
      );
      return body;
    }

    if (this.state.corroborationStatus === "loading") {
      body.appendChild(el("p", "dc-hint", "Querying the federal record."));
      return body;
    }

    if (this.state.corroborationStatus === "error") {
      body.appendChild(
        this.notice(
          "warning",
          "The record could not be read",
          this.state.corroborationError ??
            "The service is unavailable. The analysis is unaffected.",
        ),
      );
      body.appendChild(
        button("Try again", () => void this.fetchCorroboration(), "secondary"),
      );
      return body;
    }

    const held = this.state.corroboration;
    if (!held) return body;

    body.appendChild(
      el(
        "div",
        "dc-subhead",
        `Mapped fire, ${held.years[0]} to ${held.years[held.years.length - 1]}`,
      ),
    );
    if (held.fires.records.length === 0) {
      body.appendChild(
        el(
          "p",
          "dc-hint",
          `No mapped fire intersects this area in these years, according to ${held.fires.sources.join(", ") || "any registry that answered"}.`,
        ),
      );
    } else {
      for (const fire of held.fires.records) {
        const row = el("div", "dc-look");
        const head = el("div", "dc-look-head");
        head.appendChild(el("span", "dc-look-date", fire.name));
        head.appendChild(el("span", "dc-look-tag", String(fire.year)));
        head.appendChild(el("span", "dc-look-tag", fire.source));
        row.appendChild(head);
        const parts = [
          `${formatHectares(fire.hectares)} ha`,
          fire.started ? `from ${fire.started}` : null,
          fire.ended ? `to ${fire.ended}` : null,
          fire.cause,
        ].filter(Boolean);
        row.appendChild(el("div", "dc-look-meta", parts.join(" · ")));
        body.appendChild(row);
      }
      body.appendChild(
        button("Show perimeters", () => this.showPerimeters(), "secondary"),
      );
      // The registries disagree by design: an operational perimeter drawn
      // during a fire is not a severity assessment mapped a year later. Saying
      // so prevents a verifier averaging two numbers that measure different
      // things.
      if (held.fires.sources.length > 1) {
        body.appendChild(
          el(
            "p",
            "dc-hint",
            `Answered by ${held.fires.sources.join(", ")}. The same fire may appear more than once with different areas: an operational perimeter mapped during the incident is not the same measurement as a severity assessment mapped a season later. Quote one, and say which.`,
          ),
        );
      }
    }
    if (held.fires.yearsUnassessed.length > 0) {
      body.appendChild(
        this.notice(
          "warning",
          "Some years are not yet assessed",
          `Burn severity is mapped from imagery a year or more after a fire, so ${held.fires.yearsUnassessed.join(", ")} ${held.fires.yearsUnassessed.length === 1 ? "is" : "are"} not published yet. Absence here is not evidence that nothing burned.`,
        ),
      );
    }

    const management = held.management;
    if (management) {
      body.appendChild(el("div", "dc-subhead", "Recorded management"));
      if (management.activities.length === 0) {
        body.appendChild(
          el(
            "p",
            "dc-hint",
            "No canopy-affecting activity is recorded over this area in these years. The activity tracking system covers National Forest System land only, so on private or state ownership this is an absence of jurisdiction rather than an absence of harvest.",
          ),
        );
      } else {
        const table = el("div", "dc-damage");
        for (const activity of management.activities.slice(0, 12)) {
          const row = el("div", "dc-damage-row");
          row.appendChild(
            el("span", "dc-damage-year", (activity.completed ?? "").slice(0, 4)),
          );
          row.appendChild(el("span", "dc-damage-agent", activity.activity));
          row.appendChild(el("span", "dc-damage-type", activity.completed ?? ""));
          row.appendChild(
            el(
              "span",
              "dc-damage-acres",
              `${Math.round(activity.acres).toLocaleString()} ac`,
            ),
          );
          table.appendChild(row);
        }
        body.appendChild(table);
        body.appendChild(
          el(
            "p",
            "dc-hint",
            `${Math.round(management.totalAcres).toLocaleString()} acres of recorded canopy-affecting activity. This is the record of what was done, entered by whoever did it, not a measurement of the canopy. A delta over a stand recorded as harvested is a reported treatment behaving as it should; the same delta with no record here is the finding.`,
          ),
        );
      }
      if (management.undated > 0) {
        body.appendChild(
          this.notice(
            "warning",
            "Activities with no completion date",
            `${management.undated} canopy-affecting record(s) over this area were entered without a completion date and could not be placed in a year. An activity entered but never closed out is a treatment of unknown status, not an absent one.`,
          ),
        );
      }
    }

    body.appendChild(el("div", "dc-subhead", "Insect and disease survey"));
    if (held.ids.groups.length === 0) {
      body.appendChild(
        el("p", "dc-hint", "No damage recorded over this area in these years."),
      );
    } else {
      const table = el("div", "dc-damage");
      for (const group of held.ids.groups.slice(0, 12)) {
        const row = el("div", "dc-damage-row");
        row.appendChild(el("span", "dc-damage-year", String(group.year)));
        row.appendChild(el("span", "dc-damage-agent", group.agent));
        row.appendChild(el("span", "dc-damage-type", group.damageType));
        row.appendChild(
          el("span", "dc-damage-acres", `${Math.round(group.acres).toLocaleString()} ac`),
        );
        table.appendChild(row);
      }
      body.appendChild(table);
      body.appendChild(
        el(
          "p",
          "dc-hint",
          "Acres are the survey's own figures. The polygons are sketch-mapped from an aircraft, so their areas are approximate by construction and are not recomputed here.",
        ),
      );
    }

    if (withinConus(bbox)) {
      body.appendChild(el("div", "dc-subhead", "Independent change model"));
      body.appendChild(
        el(
          "p",
          "dc-hint",
          "The Landscape Change Monitoring System classifies change annually across the conterminous states from the full Landsat and Sentinel-2 record, by a method unlike this tool's. Agreement is corroboration; disagreement is the finding.",
        ),
      );
      const row = el("div", "dc-row");
      for (const product of LCMS_PRODUCTS) {
        row.appendChild(
          button(
            product.label,
            () => void this.showLcms(product.id),
            "secondary",
          ),
        );
      }
      body.appendChild(row);
    }

    if (regionFor(bbox)) {
      body.appendChild(el("div", "dc-subhead", "Disturbance cause"));
      body.appendChild(
        el(
          "p",
          "dc-hint",
          "LANDFIRE names the agent rather than the rate: fire, clearcut, harvest, thinning, mastication, insects, disease, weather and development are separate classes. Where it and LCMS agree on a stand, two teams working from overlapping inputs reached the same answer. Where they disagree, that is what to chase.",
        ),
      );
      body.appendChild(
        button(
          "Show disturbance cause",
          () => void this.showLandfire(),
          "secondary",
        ),
      );
      const legend = this.landfireLegend;
      if (legend.length > 0) {
        const box = el("div", "dc-legend");
        for (const entry of legend) {
          const item = el("div", "dc-legend-item");
          const swatch = document.createElement("img");
          swatch.src = entry.swatch;
          swatch.className = "dc-legend-swatch";
          swatch.alt = "";
          item.appendChild(swatch);
          item.appendChild(el("span", "dc-legend-label", entry.label));
          box.appendChild(item);
        }
        body.appendChild(box);
      }
    }

    const attributions = [
      MTBS_ATTRIBUTION,
      management ? FACTS_ATTRIBUTION : null,
      regionFor(bbox) ? LANDFIRE_ATTRIBUTION : null,
      held.fires.sources.includes("NIFC") ? NIFC_ATTRIBUTION : null,
      held.fires.sources.includes("NBAC") ? NBAC_ATTRIBUTION : null,
      held.ids.covered ? IDS_ATTRIBUTION : null,
      withinConus(bbox) ? LCMS_ATTRIBUTION : null,
    ].filter(Boolean);
    body.appendChild(el("p", "dc-hint", `${attributions.join(". ")}.`));
    return body;
  }

  /**
   * Draw an LCMS product over the working grid.
   *
   * The year shown is the post window's, because that is the year the delta
   * attributes a change to and therefore the only year the two methods can be
   * compared on.
   */
  /**
   * Draw LANDFIRE's disturbance classes for the post window's year.
   *
   * The year is not negotiable here in the way it is for a basemap. LANDFIRE
   * publishes one raster per disturbance year, so showing any year but the one
   * the delta attributes its change to would be comparing different questions.
   */
  private async showLandfire(): Promise<void> {
    const result = this.state.results[0];
    const period = this.state.periods[0];
    const bbox = this.aoiBbox();
    const region = bbox ? regionFor(bbox) : null;
    if (!result || !period || !region) return;

    const year = Number(period.postEnd.slice(0, 4));
    try {
      const catalogue = await loadCatalogue();
      const service = serviceFor(catalogue, year, region);
      if (!service) {
        this.patch({
          error: `LANDFIRE has not published a ${year} disturbance product for this region yet. It lags the calendar by a year or more, and an absent product is not an absence of disturbance.`,
        });
        return;
      }
      const overlay = await overlayFor(result.grid, service);
      this.landfireLegend = overlay.legend;
      this.layers.addRaster({
        key: "ref-landfire",
        name: `LANDFIRE disturbance, ${service.year}`,
        dataUrl: overlay.url,
        coordinates: overlay.coordinates,
        visible: true,
        opacity: 0.8,
      });
      this.rerender();
    } catch (error) {
      this.patch({ error: describeError(error) });
    }
  }

  private async showLcms(productId: string): Promise<void> {
    const result = this.state.results[0];
    const period = this.state.periods[0];
    const product = LCMS_PRODUCTS.find((entry) => entry.id === productId);
    if (!result || !period || !product) return;

    const year = Number(period.postEnd.slice(0, 4));
    try {
      const overlay = await exportOverlay({ product, year, grid: result.grid });
      this.layers.addRaster({
        key: "ref-lcms",
        name: `LCMS ${product.label}, ${year}`,
        dataUrl: overlay.url,
        coordinates: overlay.coordinates,
        visible: true,
        opacity: 0.75,
      });
    } catch (error) {
      this.patch({ error: describeError(error) });
    }
  }

  private aoiBbox(): [number, number, number, number] | null {
    const aoi = this.state.aoi;
    if (!aoi) return null;
    const bounds = aoiBounds(aoi);
    if (!bounds) return null;
    return [bounds.west, bounds.south, bounds.east, bounds.north];
  }

  private async fetchCorroboration(): Promise<void> {
    const bbox = this.aoiBbox();
    if (!bbox) return;
    const years = yearsCovered(this.state.periods);

    this.patch({ corroborationStatus: "loading", corroborationError: null });
    try {
      const [ids, fires, management] = await Promise.all([
        insectAndDisease(bbox, years),
        fireEvidence(bbox, years),
        managementRecord(bbox, years),
      ]);
      this.patch({
        corroboration: { ids, fires, management, years, fetchedAt: Date.now() },
        corroborationStatus: "ready",
        corroborationError: null,
      });
    } catch (error) {
      this.patch({
        corroborationStatus: "error",
        corroborationError: describeError(error),
      });
    }
  }

  private showPerimeters(): void {
    const held = this.state.corroboration;
    if (!held || held.fires.perimeters.features.length === 0) return;
    this.layers.addVector({
      key: "ref-fire",
      name: "Mapped fire perimeters",
      geojson: held.fires.perimeters,
      role: "fire",
      labelField: null,
      color: "#d7301f",
    });
  }

  /**
   * Who the result is for.
   *
   * Three optional fields, and leaving them empty is a legitimate answer: a
   * screening run someone did for themselves is not a delivery and should not
   * be dressed as one. Filling them in puts the names in the record, which is
   * what lets a hectare figure be quoted against a registry figure and a moved
   * threshold be attributed to whoever moved it.
   */
  private summariseDelivery(): string {
    if (!isDelivery(this.state.delivery)) {
      return this.state.results.length > 0 ? "internal run, unattributed" : "";
    }
    const undocumented = (Object.keys(DELTAS) as DeltaId[]).filter(
      (id) => breaksDeviate(this.state, id) && !this.state.justifications[id]?.trim(),
    );
    const who = this.state.delivery.project.trim() || this.state.delivery.client.trim();
    return undocumented.length > 0 ? `${who}, not SOP-compliant` : who;
  }

  private renderDelivery(): HTMLElement {
    const body = el("div", "dc-stack");

    const line = (
      label: string,
      key: "project" | "client" | "analyst",
      placeholder: string,
      hint: string,
    ) => {
      const control = input("text", this.state.delivery[key], () => {});
      control.placeholder = placeholder;
      control.addEventListener("change", () => {
        this.patch({
          delivery: { ...this.state.delivery, [key]: control.value },
        });
      });
      body.appendChild(field(label, control, hint));
    };

    line(
      "Project",
      "project",
      "ILTF/NICC & Blackfeet Indian Nation Forest Carbon Project (ACR782), RP3",
      "Name and registry id as the monitoring report gives them, so the figures below can be quoted against the registry's own.",
    );
    line(
      "Prepared for",
      "client",
      "Indian Land Tenure Foundation (ILTF)",
      "Who receives the result.",
    );
    line("Analyst", "analyst", "TUV SUD Green Energy & Sustainability", "Who ran it.");

    return body;
  }

  /**
   * The one statement a reader of a delivery is entitled to before the numbers.
   *
   * SOP Step 6 allows a threshold to be moved off its default only where the
   * histogram supports it and the deviation is documented. A run that moved one
   * and documented nothing is not SOP-compliant, and saying so here is cheaper
   * than having it found later.
   */
  private renderCompliance(): HTMLElement | null {
    const undocumented = (Object.keys(DELTAS) as DeltaId[]).filter(
      (id) => breaksDeviate(this.state, id) && !this.state.justifications[id]?.trim(),
    );
    if (undocumented.length === 0) return null;

    return this.notice(
      "warning",
      "Not readable as SOP-compliant",
      `${undocumented.join(", ")} ${undocumented.length === 1 ? "uses a threshold" : "use thresholds"} moved off the SOP Step 6 default with no justification recorded. Write one sentence per layer from the histogram in section 4, or return the threshold to its default. Until then these figures cannot be presented as SOP-compliant.`,
    );
  }

  private renderFindings(): HTMLElement {
    const body = el("div", "dc-stack");

    body.appendChild(this.renderDelivery());

    if (this.state.results.length === 0) {
      body.appendChild(
        el("p", "dc-hint", "The run manifest becomes available after a check completes."),
      );
      return body;
    }

    const compliance = this.renderCompliance();
    if (compliance) body.appendChild(compliance);

    const manifest = buildManifest(
      this.state,
      new Date(this.state.runStartedAt ?? Date.now()),
    );

    const preview = el("pre", "dc-manifest", manifest);
    body.appendChild(preview);

    const row = el("div", "dc-row");
    row.appendChild(
      button(
        "Copy manifest",
        () => {
          void navigator.clipboard?.writeText(manifest);
        },
        "primary",
      ),
    );
    row.appendChild(
      button("Download as text", () => {
        const blob = new Blob([manifest], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const link = el("a");
        link.href = url;
        // Named for the project where there is one. A folder of files called
        // disturbance-check-2026-08-14-...txt is a folder nobody can read.
        const slug =
          this.state.delivery.project
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 60) || "disturbance-check";
        link.download = `${slug}-${new Date(this.state.runStartedAt ?? Date.now())
          .toISOString()
          .slice(0, 19)
          .replace(/[:T]/g, "-")}.txt`;
        link.click();
        URL.revokeObjectURL(url);
      }),
    );
    body.appendChild(row);

    return body;
  }

  private notice(
    severity: "info" | "warning",
    title: string,
    detail: string,
  ): HTMLElement {
    const box = el("div", `dc-notice dc-notice-${severity}`);
    box.appendChild(el("div", "dc-notice-title", title));
    box.appendChild(el("div", "dc-notice-detail", detail));
    return box;
  }

  // Run ---------------------------------------------------------------------

  async run(): Promise<void> {
    if (!isReadyToRun(this.state) || !this.state.aoi) return;

    this.patch({
      status: "running",
      error: null,
      progress: "Searching the catalogue",
      acknowledged: false,
    });

    try {
      const results: PeriodResult[] = [];
      const analyses: State["analyses"] = {};
      const diagnostics: Diagnostic[] = [];

      for (const period of this.state.periods) {
        diagnostics.push(...checkPeriod(period));
        const result = await runPeriod(period, {
          aoi: this.state.aoi,
          periods: this.state.periods,
          maxCloud: this.state.maxCloud,
          maskId: this.state.maskId,
          maskOptions: this.state.maskOptions,
          breaks: this.state.breaks,
          onProgress: (progress: string) => this.patch({ progress }),
        });
        results.push(result);

        diagnostics.push(
          ...checkSceneCounts(
            period.id,
            result.preObservations.length,
            result.postObservations.length,
          ),
        );
        // Warnings raised inside the run are findings about the data, not
        // about the parameters, so they join the diagnostics rather than
        // sitting in a separate list the operator has to remember to read.
        for (const warning of result.warnings) {
          diagnostics.push({
            severity: "warning",
            title: `${period.id} coverage`,
            detail: warning,
            source: "Run",
          });
        }

        const periodAnalyses = {} as Record<DeltaId, ReturnType<typeof analyseHistogram>>;
        for (const id of Object.keys(DELTAS) as DeltaId[]) {
          periodAnalyses[id] = analyseHistogram(
            result.deltas[id].histogram,
            this.state.breaks[id],
          );
        }
        analyses[period.id] = periodAnalyses;
        diagnostics.push(
          ...collectDeltaDiagnostics(periodAnalyses).map((diagnostic) => ({
            ...diagnostic,
            title: `${period.id} ${diagnostic.title}`,
          })),
        );
      }

      this.patch({ progress: "Adding layers" });
      const layerIds = this.syncLayers(results);

      this.patch({
        status: "complete",
        progress: "",
        results,
        analyses,
        diagnostics,
        layerIds,
        runStartedAt: Date.now(),
      });
      this.open.add("results");
      this.saveOpenSections();
      this.rerender();
      for (const id of Object.keys(DELTAS) as DeltaId[]) {
        this.refreshBreakReadout(id);
      }
    } catch (error) {
      this.patch({
        status: "error",
        progress: "",
        error: describeError(error),
      });
    }
  }

  /**
   * SOP Step 7 layer order.
   *
   * Layers are added bottom-up so the classified rasters finish on top, with
   * the continuous deltas, single-date indices and RGB pairs beneath them,
   * hidden but available for the cross-check Appendix A.2 and A.3 depend on.
   * The run emits them tagged by role; the order is imposed here so that
   * changing what a run produces cannot quietly reshuffle the map.
   */
  private syncLayers(results: PeriodResult[]): string[] {
    // Clear only the raster products of the previous run. Uploaded site data
    // is left alone, because it did not come from a run and does not expire.
    this.layers.removeByPrefix("tuvsud-dc-r-");

    const created: string[] = [];
    const order: Array<PeriodResult["layers"][number]["role"]> = [
      "rgb",
      "classified",
    ];

    for (const result of results) {
      const prefix = results.length > 1 ? `${result.periodId} ` : "";
      for (const role of order) {
        for (const layer of result.layers) {
          if (layer.role !== role) continue;
          const suffix = layer.key.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
          this.layers.addRaster({
            key: `r-${suffix}`,
            name: `${prefix}${layer.name}`,
            dataUrl: layer.dataUrl,
            coordinates: layer.coordinates,
            visible: layer.visible,
          });
          created.push(`tuvsud-dc-r-${suffix}`);
        }
      }
    }

    return created;
  }
}
