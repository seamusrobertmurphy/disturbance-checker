import {
  CLASS_LABELS,
  CLASS_PALETTE,
  DELTAS,
  DeltaId,
  PLACEHOLDER_EE_PROJECT,
} from "../defaults";
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
  buildGeometry,
  centroidLonLat,
  computeAoiAreaHa,
  runPeriod,
  utmCrsForLonLat,
} from "../ee/analysis";
import {
  connect,
  describeError,
  isSessionExpired,
  rememberProjectId,
  resolveOauthClientId,
  sessionRemainingMs,
} from "../ee/api";
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
  isPlaceholderProject,
} from "../state";
import { GeoLibreAppAPI } from "../types/geolibre";
import { button, clear, el, field, formatDuration, formatHectares, input } from "./dom";
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
    this.clockTimer = window.setInterval(() => {
      if (this.state.status !== "complete") return;
      if (isSessionExpired(Date.now())) {
        this.patch({ status: "stale" });
        return;
      }
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
      this.section("project", "1", "Earth Engine", this.summariseProject(), () =>
        this.renderProject(),
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
      this.section("findings", "7", "Findings", "", () => this.renderFindings()),
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

  private summariseProject(): string {
    if (isPlaceholderProject(this.state)) return "not set";
    return this.state.projectId;
  }

  private summariseAoi(): string {
    if (!this.state.aoi) return "not set";
    if (this.state.aoi.kind === "asset") return this.state.aoi.assetId;
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

  private renderProject(): HTMLElement {
    const body = el("div", "dc-stack");

    const projectInput = input("text", this.state.projectId, (value) => {
      this.patch({
        projectId: value.trim(),
        projectConfirmed:
          value.trim() !== "" && value.trim() !== PLACEHOLDER_EE_PROJECT,
      });
      if (value.trim() && value.trim() !== PLACEHOLDER_EE_PROJECT) {
        rememberProjectId(value.trim());
      }
    });
    projectInput.spellcheck = false;
    body.appendChild(
      field(
        "Cloud project ID",
        projectInput,
        "Earth Engine refuses every compute call without a billed Cloud project. Compute is metered against this project, not against your personal quota.",
      ),
    );

    if (isPlaceholderProject(this.state)) {
      body.appendChild(
        this.notice(
          "warning",
          "Replace the example project ID",
          `"${PLACEHOLDER_EE_PROJECT}" is the example from the SOP and is shown only to indicate the expected format. Enter the Cloud project your team has been granted access to before running a check.`,
        ),
      );
    }

    const status = el("div", "dc-status-line");
    status.appendChild(
      el(
        "span",
        `dc-dot ${this.state.signedIn ? "dc-dot-on" : "dc-dot-off"}`,
        "",
      ),
    );
    status.appendChild(
      el(
        "span",
        "dc-status-text",
        this.state.signedIn
          ? "Signed in to Earth Engine"
          : "Not signed in. Sign-in happens on the first run.",
      ),
    );
    body.appendChild(status);

    if (!resolveOauthClientId()) {
      body.appendChild(
        this.notice(
          "warning",
          "No OAuth client ID configured",
          "This build has no VITE_GEE_OAUTH_CLIENT_ID. Sign-in will fail until one is set at build time, or supplied with ?gee_client_id= in the URL.",
        ),
      );
    }

    return body;
  }

  // Section 2 ---------------------------------------------------------------

  private renderAoi(): HTMLElement {
    const body = el("div", "dc-stack");
    const aoi = this.state.aoi;

    const kindRow = el("div", "dc-row");
    const kinds: Array<[Aoi["kind"], string]> = [
      ["rectangle", "Bounds"],
      ["asset", "EE asset"],
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

    if (aoi?.kind === "asset") {
      body.appendChild(
        field(
          "Asset ID",
          input("text", aoi.assetId, (value) =>
            this.patch({
              aoi: { kind: "asset", assetId: value.trim() },
              aoiLabel: value.trim(),
            }),
          ),
          "A FeatureCollection asset, for example projects/your-project/assets/project_boundary. Its geometry() is used as the ROI.",
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
    } else if (kind === "asset") {
      this.patch({ aoi: { kind: "asset", assetId: "" }, aoiLabel: "" });
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
        "Filters scenes by CLOUDY_PIXEL_PERCENTAGE before the QA60 mask runs. Drop to 20 in the Pacific Northwest and coastal Alaska; raise above 30 only if composites show striping or NoData wedges.",
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
    const running =
      this.state.status === "running" || this.state.status === "connecting";
    const blocked = isPlaceholderProject(this.state) || !this.state.aoi;

    const label =
      this.state.status === "stale" ? "Re-run check" : "Run check";
    const runButton = button(running ? "Running..." : label, () => void this.run(), "primary");
    runButton.disabled = running || blocked;
    bar.appendChild(runButton);

    if (blocked && !running) {
      const reason = isPlaceholderProject(this.state)
        ? "Set your Cloud project ID first."
        : "Set an area of interest first.";
      bar.appendChild(el("span", "dc-runbar-hint", reason));
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
        el("p", "dc-hint", "No run yet. Set the project, area and period, then run the check."),
      );
      return body;
    }

    if (this.state.status === "stale") {
      body.appendChild(
        this.notice(
          "warning",
          "Session expired",
          "The Earth Engine access token has lapsed, so the map tiles from this run are no longer served. Every parameter is preserved. Re-run to regenerate the layers.",
        ),
      );
    } else if (this.state.status === "complete" && this.state.runStartedAt) {
      const remaining = sessionRemainingMs(Date.now());
      const clock = el("div", "dc-clock");
      clock.appendChild(
        el(
          "span",
          "dc-clock-text",
          `Run at ${new Date(this.state.runStartedAt).toLocaleTimeString()} · tiles valid for ${formatDuration(remaining)}`,
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
        `${result.preSceneCount} pre scenes · ${result.postSceneCount} post scenes · ${formatHectares(result.aoiAreaHa)} ha AOI · areas on ${result.utmCrs}`,
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

  private renderFindings(): HTMLElement {
    const body = el("div", "dc-stack");

    if (this.state.results.length === 0) {
      body.appendChild(
        el("p", "dc-hint", "The run manifest becomes available after a check completes."),
      );
      return body;
    }

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
        link.download = `disturbance-check-${new Date(this.state.runStartedAt ?? Date.now())
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
    if (isPlaceholderProject(this.state) || !this.state.aoi) return;

    this.patch({
      status: "connecting",
      error: null,
      progress: "Signing in to Earth Engine",
      acknowledged: false,
    });

    try {
      const ee = await connect(resolveOauthClientId(), this.state.projectId);
      this.patch({ signedIn: true, status: "running", progress: "Resolving area of interest" });

      const roi = buildGeometry(ee, this.state.aoi);
      const centroid = await centroidLonLat(roi);
      const utmCrs = utmCrsForLonLat(centroid.lon, centroid.lat);
      const aoiAreaHa = await computeAoiAreaHa(ee, roi, utmCrs);

      const results: PeriodResult[] = [];
      const analyses: State["analyses"] = {};
      const diagnostics: Diagnostic[] = [];

      for (const period of this.state.periods) {
        diagnostics.push(...checkPeriod(period));
        const result = await runPeriod(
          ee,
          roi,
          period,
          {
            aoi: this.state.aoi,
            periods: this.state.periods,
            maxCloud: this.state.maxCloud,
            breaks: this.state.breaks,
          },
          utmCrs,
          aoiAreaHa,
          (progress) => this.patch({ progress }),
        );
        results.push(result);

        diagnostics.push(
          ...checkSceneCounts(
            period.id,
            result.preSceneCount,
            result.postSceneCount,
          ),
        );

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
   * SOP Step 7 layer order. Layers are added bottom-up so that the classified
   * rasters finish on top, with the continuous deltas, single-date composites
   * and RGB pairs beneath them, hidden but available for the cross-check that
   * Appendix A.2 and A.3 depend on.
   */
  private syncLayers(results: PeriodResult[]): string[] {
    // Clear only the raster products of the previous run. Uploaded site data is
    // left alone, because it did not come from Earth Engine and does not expire.
    this.layers.removeByPrefix("tuvsud-dc-r-");

    const created: string[] = [];
    const add = (suffix: string, name: string, url: string, visible: boolean) => {
      this.layers.addRaster({ key: `r-${suffix}`, name, tileUrl: url, visible });
      created.push(`tuvsud-dc-r-${suffix}`);
    };

    for (const result of results) {
      const prefix = results.length > 1 ? `${result.periodId} ` : "";
      const slug = result.periodId.replace(/[^a-z0-9]/gi, "").toLowerCase();

      add(`${slug}-pre-rgb`, `${prefix}Pre RGB`, result.preRgbTileUrl, false);
      add(`${slug}-post-rgb`, `${prefix}Post RGB`, result.postRgbTileUrl, false);

      for (const id of ["dNDVI", "dNDMI", "dNBR"] as DeltaId[]) {
        add(
          `${slug}-${id.toLowerCase()}-cont`,
          `${prefix}${id} continuous`,
          result.deltas[id].tileUrlContinuous,
          false,
        );
      }
      // Classified rasters go on last so they finish on top, and visible, with
      // undisturbed pixels already masked out server-side so the composite and
      // basemap show through.
      for (const id of ["dNDVI", "dNDMI", "dNBR"] as DeltaId[]) {
        add(
          `${slug}-${id.toLowerCase()}-class`,
          `${prefix}${id} classified`,
          result.deltas[id].tileUrlClassified,
          true,
        );
      }
    }

    return created;
  }
}
