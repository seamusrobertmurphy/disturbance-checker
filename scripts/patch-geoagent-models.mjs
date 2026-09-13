// Moves GeoAgent's "use latest model" button from Claude Opus 4.8 to Opus 5.
//
// maplibre-gl-geoagent writes its latest Anthropic model into each provider's
// defaultModel, and the version GeoLibre v1.9.0 pins, 0.5.4, names
// claude-opus-4-8 and, on Bedrock, anthropic.claude-opus-4-8. Claude Opus 5 is
// the current Opus, with the id claude-opus-5.
//
// Two further edits come with it, because Opus 5 thinks by default where Opus
// 4.8 did not:
//
//   1. The context window table gains the current models. A model missing from
//      it still runs, but the agent then cannot size its conversation to the
//      window. Opus 5, Sonnet 5 and Fable 5.1 each take 1M tokens.
//
//   2. A thinking block is sent back when it has a signature, even with empty
//      text. Opus 5 returns thinking with empty text unless asked to summarise
//      it, and the bundled Anthropic formatter kept a block only when it had
//      both text and a signature, so every thinking block would be dropped
//      from the history of a tool call. Anthropic's guidance is to pass
//      thinking blocks back unchanged.
//
// Run in the GeoLibre checkout after npm ci and before the app is built. Exits
// nonzero when any edit does not find its text exactly once in the files that
// carry it, so a GeoAgent bump forces this file to be re-read.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "node_modules/maplibre-gl-geoagent/dist";

const edits = [
  {
    name: "Anthropic latest model",
    file: /^GeoAgentControl-.*\.(js|cjs)$/,
    find: 'defaultModel: "claude-opus-4-8"',
    replace: 'defaultModel: "claude-opus-5"',
  },
  {
    name: "Bedrock latest model",
    file: /^GeoAgentControl-.*\.(js|cjs)$/,
    find: 'defaultModel: "anthropic.claude-opus-4-8"',
    replace: 'defaultModel: "anthropic.claude-opus-5"',
  },
  {
    name: "context window table",
    file: /^GeoAgentControl-.*\.(js|cjs)$/,
    find: '"claude-sonnet-4-6": 1e6,',
    replace:
      '"claude-opus-5": 1e6,\n  "claude-sonnet-5": 1e6,\n  "claude-fable-5-1": 1e6,\n  "claude-opus-4-8": 1e6,\n  "claude-sonnet-4-6": 1e6,',
  },
  {
    name: "thinking block replay",
    file: /^anthropic-.*\.(js|cjs)$/,
    find: /if \(block\.text && block\.signature\) \{(\s*)return \{(\s*)type: "thinking",(\s*)thinking: block\.text,/,
    replace: 'if (block.signature) {$1return {$2type: "thinking",$3thinking: block.text ?? "",',
  },
];

const files = readdirSync(dir).filter((name) => !name.endsWith(".map"));
const patched = new Map();
let failed = false;

// Every edit is checked before any file is written, so a partial match leaves
// the package untouched.
for (const edit of edits) {
  const targets = files.filter((name) => edit.file.test(name));
  if (targets.length === 0) {
    console.error(`${edit.name}: no file in ${dir} matches ${edit.file}`);
    failed = true;
    continue;
  }
  for (const name of targets) {
    const source = patched.get(name) ?? readFileSync(join(dir, name), "utf8");
    const hits =
      typeof edit.find === "string"
        ? source.split(edit.find).length - 1
        : (source.match(new RegExp(edit.find.source, "g")) ?? []).length;
    if (hits !== 1) {
      console.error(
        `${edit.name}: expected the text once in ${name}, found ${hits}. ` +
          "maplibre-gl-geoagent has changed; re-read it before deploying.",
      );
      failed = true;
      continue;
    }
    patched.set(name, source.replace(edit.find, edit.replace));
    console.log(`${edit.name}: ${name}`);
  }
}

if (failed) process.exit(1);
for (const [name, source] of patched) writeFileSync(join(dir, name), source);
console.log(`Patched ${patched.size} GeoAgent files.`);
