import { Aoi } from "../analysis/run";
import { GeoLibreAppAPI } from "../types/geolibre";
import { buildOfflineMap } from "./offline";

// The card that builds the offline file. It reads the area of interest from
// the tool's state when one is set and the current map view when not, and it
// includes exactly the layers switched on at the moment the button is pressed.

export function renderOfflinePanel(
  container: HTMLElement,
  app: GeoLibreAppAPI,
  current: () => { aoi: Aoi | null; aoiLabel: string },
): () => void {
  container.classList.add("dc-offline");
  const intro = document.createElement("p");
  const button = document.createElement("button");
  const status = document.createElement("p");
  button.type = "button";
  button.className = "dc-button";
  button.textContent = "Build offline file";
  status.className = "dc-offline-status";

  const describe = () => {
    const { aoi, aoiLabel } = current();
    intro.textContent = aoi
      ? `Writes one HTML file of the area of interest${aoiLabel ? `, ${aoiLabel}` : ""}, with every layer that is switched on, that opens with no connection. Hide the folders you do not need first, because each layer switched on adds its image or features to the file.`
      : "No area of interest is set, so the file covers the current map view. It holds every layer that is switched on and opens with no connection. Hide the folders you do not need first, because each layer switched on adds to the file.";
  };
  describe();

  let running = false;
  button.addEventListener("click", async () => {
    if (running) return;
    running = true;
    button.disabled = true;
    describe();
    const { aoi, aoiLabel } = current();
    try {
      const result = await buildOfflineMap(app, aoi, aoiLabel, (message) => {
        status.textContent = message;
      });
      const blob = new Blob([result.html], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const slug = (aoiLabel || "project-area").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      link.href = url;
      link.download = `disturbance-check-${slug || "project-area"}-${new Date().toISOString().slice(0, 10)}.html`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      const megabytes = (blob.size / 1e6).toFixed(1);
      status.textContent =
        `Saved ${link.download}, ${megabytes} MB, ${result.included} layers.` +
        (result.missing.length ? ` Not included: ${result.missing.join("; ")}.` : "");
    } catch (error) {
      status.textContent = `The file could not be built: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      running = false;
      button.disabled = false;
    }
  });

  container.append(intro, button, status);
  return () => container.replaceChildren();
}
