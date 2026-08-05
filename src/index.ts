import "./style.css";
import { DisturbancePanel } from "./panel/panel";
import { clearSession } from "./ee/api";
import { State, createState, fromPersisted, toPersisted } from "./state";
import { GeoLibreAppAPI, GeoLibrePlugin } from "./types/geolibre";

const PANEL_ID = "tuvsud-disturbance-check";

let state: State = createState();
let panel: DisturbancePanel | null = null;
let unregister: (() => void) | null = null;

function createPanel(app: GeoLibreAppAPI): DisturbancePanel {
  return new DisturbancePanel(app, state, (next) => {
    state = next;
  });
}

const plugin: GeoLibrePlugin = {
  id: PANEL_ID,
  name: "Disturbance Check",
  version: "0.1.0",
  urlParameterNames: ["ee_project_id", "gee_client_id"],

  activate(app) {
    panel = createPanel(app);

    const registration = {
      id: PANEL_ID,
      title: "Disturbance Check",
      // Takes the Style panel slot so the Layer panel stays visible. The
      // cross-check in SOP Appendix A.2 and A.3 depends on being able to toggle
      // dNDVI against dNBR while the tool is open.
      dock: "replace-style" as const,
      render: (container: HTMLElement) => panel?.mount(container),
      destroy: () => panel?.destroy(),
    };

    if (app.registerRightPanel) {
      unregister = app.registerRightPanel(registration);
      app.openRightPanel?.(PANEL_ID);
      return true;
    }

    if (app.registerFloatingPanel) {
      unregister = app.registerFloatingPanel({
        id: PANEL_ID,
        title: registration.title,
        width: 380,
        height: 620,
        render: registration.render,
        destroy: registration.destroy,
      });
      app.openFloatingPanel?.(PANEL_ID);
      return true;
    }

    // Neither panel surface exists on this host build, so there is nowhere to
    // draw. Report failure rather than activating invisibly.
    panel = null;
    return false;
  },

  deactivate(app) {
    panel?.destroy();
    panel = null;
    clearSession();
    if (unregister) {
      unregister();
      unregister = null;
    } else {
      app.unregisterRightPanel?.(PANEL_ID);
    }
  },

  handleUrlParameters(_app, params) {
    const project = params.get("ee_project_id");
    if (project && project.trim()) {
      state = {
        ...state,
        projectId: project.trim(),
        projectConfirmed: true,
      };
      panel?.setState(state);
    }
  },

  getProjectState() {
    return toPersisted(panel?.getState() ?? state);
  },

  applyProjectState(_app, raw) {
    state = fromPersisted(state, raw);
    panel?.setState(state);
    // Uploaded site data is embedded in the project, so redraw it rather than
    // making the operator load the same files again.
    panel?.restoreContext();
    return true;
  },
};

export default plugin;
export { plugin };

// Exported for the smoke test. Detecting the plot identifier column wrongly
// means unlabelled points on every screenshot, so the heuristic is tested.
export { detectLabelField } from "./vector/import";
