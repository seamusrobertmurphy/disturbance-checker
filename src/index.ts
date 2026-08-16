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

/**
 * Swallow one upstream rejection, and only that one.
 *
 * MapLibre queues image requests above `MAX_PARALLEL_IMAGE_REQUESTS`, which is
 * sixteen. When a request settles it does `delete entry.abortController`, and
 * the queue drainer then reads `entry.abortController.signal.aborted` off the
 * entry it just cleared. Every queued basemap tile therefore rejects once with
 * a TypeError, which is why the diagnostics panel opens on exactly sixteen
 * errors over a raster basemap, in this plugin and in its sibling alike. The
 * map itself is unaffected: the tiles draw.
 *
 * Verified present in the MapLibre bundled by GeoLibre v1.9.0 and still present
 * in 5.24.0, which the current v2.6.0 ships, so upgrading the host does not
 * clear it and nothing in this repository causes it.
 *
 * Matched narrowly on purpose: the exact message, and a stack that names
 * maplibre. Anything else, including any other TypeError, is left to surface.
 * This hides a known upstream defect, not our own failures.
 */
function silenceImageQueueRejection(): () => void {
  const isQueueBug = (reason: unknown): boolean => {
    if (!(reason instanceof TypeError)) return false;
    const message = reason.message ?? "";
    const stack = reason.stack ?? "";
    return (
      /signal/.test(message) &&
      /undefined|null/.test(message) &&
      /maplibre/i.test(stack)
    );
  };

  const onRejection = (event: PromiseRejectionEvent) => {
    if (isQueueBug(event.reason)) event.preventDefault();
  };

  // A host that offers no event target simply does not get this, rather than
  // failing to activate over a cosmetic fix.
  if (typeof window?.addEventListener !== "function") return () => {};

  window.addEventListener("unhandledrejection", onRejection);
  return () => window.removeEventListener("unhandledrejection", onRejection);
}

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
  version: "0.10.1",
  // Neither a Cloud project nor an OAuth client is a parameter any more.
  // Nothing this plugin reads requires an account, so the only thing left
  // worth linking to is a guide page.
  urlParameterNames: ["dc_guide"],

  activate(app) {
    teardown.push(silenceImageQueueRejection());
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
