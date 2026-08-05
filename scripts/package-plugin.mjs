// Produces the drop-in bundle layout GeoLibre expects, ready to copy into
// apps/geolibre-desktop/public/plugins/<id>/ or to serve as a manifest URL:
//
//   build/tuvsud-disturbance-check/
//     plugin.json
//     dist/index.js
//     dist/style.css

import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "plugin.json"), "utf8"));
const target = join(root, "build", manifest.id);

rmSync(join(root, "build"), { recursive: true, force: true });
mkdirSync(target, { recursive: true });

cpSync(join(root, "plugin.json"), join(target, "plugin.json"));
cpSync(join(root, "dist"), join(target, "dist"), { recursive: true });

console.log(`packaged ${manifest.id} v${manifest.version} into build/${manifest.id}`);
