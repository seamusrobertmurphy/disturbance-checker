// Produces the two layouts GeoLibre accepts, from one build.
//
//   build/<id>/            plugin.json + dist/  -- the drop-in folder, copied
//                          into apps/geolibre-desktop/public/plugins/ or served
//                          as a manifest URL
//   build/<id>.zip         the same content with plugin.json at the ZIP ROOT,
//                          for Settings > Manage Plugins > Install from file
//
// The two differ in nesting: the folder is named after the plugin id, whereas
// the zip must have plugin.json at its root, not inside a directory.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "plugin.json"), "utf8"));
const buildDir = join(root, "build");
const target = join(buildDir, manifest.id);

if (!existsSync(join(root, "dist", "index.js"))) {
  console.error("dist/index.js is missing. Run `npm run build` first.");
  process.exit(1);
}

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

cpSync(join(root, "plugin.json"), join(target, "plugin.json"));
cpSync(join(root, "dist"), join(target, "dist"), { recursive: true });

console.log(`packaged ${manifest.id} v${manifest.version}`);
console.log(`  folder  build/${manifest.id}/`);

// zip(1) is present on macOS and on the GitHub runners. Its absence is not
// fatal: the drop-in folder above is enough for a bundled build.
try {
  execFileSync("zip", ["-r", "-q", join(buildDir, `${manifest.id}.zip`), "."], {
    cwd: target,
  });
  const size = statSync(join(buildDir, `${manifest.id}.zip`)).size;
  console.log(`  zip     build/${manifest.id}.zip (${(size / 1024).toFixed(0)} kB)`);
} catch {
  console.log("  zip     skipped, the zip command is unavailable");
}
