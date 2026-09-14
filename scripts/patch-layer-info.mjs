// Adds a hover card and a right-click menu to the rows of GeoLibre's Layers panel.
//
// The card and menu live in scripts/host-patches/LayerInfo.tsx, which this script
// copies beside LayerPanel.tsx. Four edits then wire it in:
//
//   1. LayerPanel imports LayerInfoOverlay and layerInfoRowProps.
//   2. Each layer row takes the hover and right-click handlers, with its folder
//      name, the hidden-by-folder and rename hints, and the panel's own zoom,
//      show or hide, and metadata actions.
//   3. The layer name loses its "Double-click to rename" browser tooltip, which
//      would otherwise sit on top of the card. The card carries that hint.
//   4. One LayerInfoOverlay is rendered at the end of the panel.
//
// Verified against apps/geolibre-desktop/src/components/panels/LayerPanel.tsx
// at GeoLibre v1.9.0, the tag the deploy pins.
//
// Run in the GeoLibre checkout before the app is built. Every edit is checked
// before anything is written, and the script exits nonzero when any edit does
// not find its text exactly once, so a GEOLIBRE_REF bump that moves this markup
// forces this file to be re-read.

import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const target =
  process.argv[2] ??
  "apps/geolibre-desktop/src/components/panels/LayerPanel.tsx";
const component = join(dirname(fileURLToPath(import.meta.url)), "host-patches", "LayerInfo.tsx");

const edits = [
  {
    name: "import",
    find: /import \{ LayerPanelPlaceSearch \} from "\.\/LayerPanelPlaceSearch";\n/g,
    replace: (hit) =>
      `${hit}import { LayerInfoOverlay, layerInfoRowProps } from "./LayerInfo";\n`,
  },
  {
    name: "row handlers",
    find: /(\n(\s*)data-layer-name=\{layer\.name\}\n)/g,
    replace: (hit, _line, indent) =>
      `${hit}${indent}{...layerInfoRowProps(\n` +
      `${indent}  layer,\n` +
      `${indent}  group?.name,\n` +
      `${indent}  groupHidden\n` +
      `${indent}    ? [t("layers.hiddenByGroup"), t("layers.doubleClickToRename")]\n` +
      `${indent}    : [t("layers.doubleClickToRename")],\n` +
      `${indent}  {\n` +
      `${indent}    zoom: () => mapControllerRef.current?.fitLayer(layer),\n` +
      `${indent}    toggle: () => setLayerVisibility(layer.id, !layer.visible),\n` +
      `${indent}    metadata: () => setMetadataLayer(layer),\n` +
      `${indent}  },\n` +
      `${indent})}\n`,
  },
  {
    name: "name tooltip",
    find: /\n\s*title=\{\s*groupHidden\s*\?\s*`\$\{t\("layers\.hiddenByGroup"\)\} — \$\{t\("layers\.doubleClickToRename"\)\}`\s*:\s*t\("layers\.doubleClickToRename"\)\s*\}/g,
    replace: () => "",
  },
  {
    name: "overlay",
    find: /\n(\s*)<\/aside>(\s*\);\s*\}\s*)$/g,
    replace: (_hit, indent, tail) =>
      `\n${indent}  <LayerInfoOverlay />\n${indent}</aside>${tail}`,
  },
];

let source = readFileSync(target, "utf8");
let failed = false;
for (const edit of edits) {
  const hits = [...source.matchAll(edit.find)].length;
  if (hits !== 1) {
    console.error(
      `${edit.name}: expected the text once in ${target}, found ${hits}. ` +
        "GeoLibre's LayerPanel has changed; re-read it before deploying.",
    );
    failed = true;
    continue;
  }
  source = source.replace(edit.find, edit.replace);
}
if (failed) process.exit(1);

copyFileSync(component, join(dirname(target), "LayerInfo.tsx"));
writeFileSync(target, source);
console.log(`Added the layer hover card and right-click menu to ${target}`);
