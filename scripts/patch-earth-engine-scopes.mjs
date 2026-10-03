// Stops the Earth Engine sign-in asking for Google Drive.
//
// The Earth Engine browser client requests three scopes by default: earthengine,
// cloud-platform and drive. Drive is a *restricted* scope in Google's
// classification, the strictest tier, and an app that has not been through
// Google's verification review is refused outright when it asks for one. The
// refusal screen carries no "Advanced" link, so there is nothing for an
// operator to click past. Dropping to earthengine and cloud-platform leaves
// only sensitive scopes, which an unverified app may still request.
//
// Nothing in this deploy reads or writes Drive. GeoLibre's own source never
// mentions toDrive, and the Earth Engine panel's tabs are catalog, search,
// load, layers, inspector, code and auth. Only a script typed into the code tab
// could reach Export.image.toDrive, and if that is ever wanted the scope goes
// back in here.
//
// ee.data.authenticateViaOauth takes the scopes as its fourth argument and a
// suppressDefaultScopes flag as its sixth:
//
//   ee.data.authenticateViaOauth = function(clientId, success, opt_error,
//       opt_extraScopes, opt_onImmediateFailed, opt_suppressDefaultScopes)
//
// maplibre-gl-earth-engine calls it with neither, so the defaults apply. This
// passes both.
//
// Run in the GeoLibre checkout after npm ci and before the app is built, since
// it edits the dependency's shipped bundle rather than GeoLibre's own source.
// Exits nonzero when the call site is not found exactly once in the file that
// carries it, so a version bump that reshapes it forces this file to be re-read
// rather than silently shipping the Drive request again.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir =
  process.argv[2] ?? "node_modules/maplibre-gl-earth-engine/dist";

// Only the scopes Earth Engine itself needs to read the catalogue and compute
// against a Cloud project.
const scopes = [
  "https://www.googleapis.com/auth/earthengine",
  "https://www.googleapis.com/auth/cloud-platform",
];

const call =
  "authenticateViaOauth(oauthClientId, onSuccess, onFailure, void 0, onImmediateFailed)";
const replacement =
  `authenticateViaOauth(oauthClientId, onSuccess, onFailure, ${JSON.stringify(scopes)}, onImmediateFailed, true)`;

const files = readdirSync(dir).filter(
  (name) => /\.(js|mjs|cjs)$/.test(name) && !name.endsWith(".map"),
);

let patchedCount = 0;
for (const name of files) {
  const path = join(dir, name);
  const source = readFileSync(path, "utf8");
  const hits = source.split(call).length - 1;
  if (hits === 0) continue;
  if (hits !== 1) {
    console.error(
      `Expected the Earth Engine OAuth call at most once in ${path}, found ${hits}. ` +
        "maplibre-gl-earth-engine has changed; re-read it before deploying.",
    );
    process.exit(1);
  }
  writeFileSync(path, source.replace(call, replacement));
  console.log(`Dropped the Drive scope from ${path}.`);
  patchedCount += 1;
}

if (patchedCount === 0) {
  console.error(
    `Found the Earth Engine OAuth call in none of the ${files.length} bundles under ${dir}. ` +
      "maplibre-gl-earth-engine has changed; re-read it before deploying.",
  );
  process.exit(1);
}

// The Drive scope string stays in the file either way, as the unused constant
// GOOGLE_DRIVE_SCOPE_ that mergeAuthScopes_ no longer reaches, so its presence
// proves nothing. What is checked instead is that the suppressed call is the
// one now standing in every bundle that had the original.
for (const name of files) {
  const path = join(dir, name);
  const source = readFileSync(path, "utf8");
  if (source.includes(call)) {
    console.error(
      `${path} still carries the unpatched Earth Engine OAuth call. Re-read it before deploying.`,
    );
    process.exit(1);
  }
}

console.log(`Patched ${patchedCount} bundle(s) under ${dir}.`);
