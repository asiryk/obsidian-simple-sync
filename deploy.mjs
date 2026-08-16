import { copyFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import process from "process";

// Where the built plugin is copied to. Override with SIMPLE_SYNC_VAULT_PLUGIN_DIR
// when working against a different vault, which is how you deploy to a test
// vault without editing this file:
//
//   SIMPLE_SYNC_VAULT_PLUGIN_DIR=~/path/to/vault/.obsidian/plugins/simple-sync npm run deploy
const { id } = JSON.parse(readFileSync("manifest.json", "utf8"));
const target = process.env.SIMPLE_SYNC_VAULT_PLUGIN_DIR || `/Volumes/knowledge-base/.obsidian/plugins/${id}`;

const required = ["main.js", "manifest.json"];
const optional = ["styles.css"];

const missing = required.filter((file) => !existsSync(file));
if (missing.length) {
    console.error(`missing build output: ${missing.join(", ")} - run 'npm run build' first`);
    process.exit(1);
}

mkdirSync(target, { recursive: true });

const copied = [...required, ...optional.filter((file) => existsSync(file))];
for (const file of copied) {
    copyFileSync(file, join(target, file));
}

console.log(`deployed ${copied.join(", ")} to ${target}`);
console.log("reload Obsidian, or toggle the plugin off and on, to pick up the new build");
