import "./style.css";
import { HelpLibrary } from "./help/panel";
import { AUDIENCE_LABELS, AUDIENCE_ORDER, guidesFor } from "./help/registry";
import { DisturbancePanel } from "./panel/panel";
import { State, createState, fromPersisted, toPersisted } from "./state";
import {
  GeoLibreAppAPI,
  GeoLibrePlugin,
  GeoLibreToolbarMenuItem,
} from "./types/geolibre";

const PANEL_ID = "tuvsud-disturbance-check";
const HELP_PANEL_ID = "tuvsud-disturbance-check-help";
const TOOLBAR_MENU_ID = "tuvsud-disturbance-check-menu";

let state: State = createState();
let panel: DisturbancePanel | null = null;
let help: HelpLibrary | null = null;
const teardown: Array<() => void> = [];

function createPanel(app: GeoLibreAppAPI): DisturbancePanel {
  return new DisturbancePanel(
    app,
    state,
    (next) => {
      state = next;
    },
    (guideId) => openHelp(app, guideId),
  );
}

/** Both entry points into the library land in the same view. */
function openHelp(app: GeoLibreAppAPI, guideId: string | null): void {
  help?.open(guideId);
  app.openFloatingPanel?.(HELP_PANEL_ID);
}

/** One submenu per audience, so the menu stays readable as guides are added. */
function helpMenuItems(app: GeoLibreAppAPI): GeoLibreToolbarMenuItem[] {
  const items: GeoLibreToolbarMenuItem[] = [
    {
      id: "help-all",
      label: "All guides",
      onSelect: () => openHelp(app, null),
    },
    { type: "separator", id: "help-sep" },
  ];

  for (const audience of AUDIENCE_ORDER) {
    const guides = guidesFor(audience);
    if (guides.length === 0) continue;
    items.push({
      type: "submenu",
      id: `help-${audience}`,
      label: AUDIENCE_LABELS[audience],
      items: guides.map((guide) => ({
        id: `help-${guide.id}`,
        label: guide.title,
        onSelect: () => openHelp(app, guide.id),
      })),
    });
  }

  return items;
}

const plugin: GeoLibrePlugin = {
  id: PANEL_ID,
  name: "Disturbance Check",
  version: "0.6.0",
  // Neither a Cloud project nor an OAuth client is a parameter any more.
  // Nothing this plugin reads requires an account, so the only thing left
  // worth linking to is a guide page.
  urlParameterNames: ["dc_guide"],

  activate(app) {
    help = new HelpLibrary();
    panel = createPanel(app);

    const registration = {
      id: PANEL_ID,
      title: "Disturbance Check",
      // Takes the Style panel slot so the Layer panel stays visible. The
      // cross-check between dNDVI and dNBR depends on being able to toggle
      // layers while the tool is open.
      dock: "replace-style" as const,
      render: (container: HTMLElement) => panel?.mount(container),
      destroy: () => panel?.destroy(),
    };

    let mounted = false;
    if (app.registerRightPanel) {
      teardown.push(app.registerRightPanel(registration));
      app.openRightPanel?.(PANEL_ID);
      mounted = true;
    } else if (app.registerFloatingPanel) {
      teardown.push(
        app.registerFloatingPanel({
          id: PANEL_ID,
          title: registration.title,
          defaultWidth: 380,
          render: registration.render,
        }),
      );
      app.openFloatingPanel?.(PANEL_ID);
      mounted = true;
    }

    if (!mounted) {
      // Neither panel surface exists on this host build, so there is nowhere to
      // draw. Report failure rather than activating invisibly.
      panel = null;
      help = null;
      return false;
    }

    // The documentation library lives in its own floating card so a guide can
    // be read beside the tool rather than instead of it.
    if (app.registerFloatingPanel) {
      teardown.push(
        app.registerFloatingPanel({
          id: HELP_PANEL_ID,
          title: "Disturbance Check guides",
          defaultWidth: 460,
          render: (container: HTMLElement) => {
            help?.mount(container);
            return () => help?.destroy();
          },
        }),
      );
    }

    if (app.registerToolbarMenu) {
      teardown.push(
        app.registerToolbarMenu({
          id: TOOLBAR_MENU_ID,
          label: "Disturbance Check",
          items: [
            {
              id: "open-tool",
              label: "Open the tool",
              onSelect: () => {
                app.openRightPanel?.(PANEL_ID);
                app.openFloatingPanel?.(PANEL_ID);
              },
            },
            { type: "separator", id: "tool-sep" },
            ...helpMenuItems(app),
          ],
        }),
      );
    }

    return true;
  },

  deactivate(app) {
    panel?.destroy();
    help?.destroy();
    panel = null;
    help = null;

    while (teardown.length > 0) {
      const dispose = teardown.pop();
      try {
        dispose?.();
      } catch {
        // A host that has already torn the surface down is not an error here.
      }
    }
    app.unregisterRightPanel?.(PANEL_ID);
    app.unregisterFloatingPanel?.(HELP_PANEL_ID);
    app.unregisterToolbarMenu?.(TOOLBAR_MENU_ID);
  },

  handleUrlParameters(app, params) {
    // Lets a guide be linked directly, so a colleague can be sent straight to
    // the page that answers their question.
    const guide = params.get("dc_guide");
    if (guide && guide.trim()) openHelp(app, guide.trim());
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
export { GUIDES, findGuide, AUDIENCE_ORDER } from "./help/registry";
