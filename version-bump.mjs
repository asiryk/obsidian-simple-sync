// Run by `npm version <patch|minor|major>` to keep manifest.json and
// versions.json in step with package.json. The release workflow refuses to
// publish when the tag and manifest.json disagree, so this must not be skipped.
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
    throw new Error("npm_package_version is not set; run this via `npm version`");
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = targetVersion;
writeFileSync("manifest.json", `${JSON.stringify(manifest, null, 4)}\n`);

// versions.json maps each plugin version to the Obsidian version it needs, so
// older clients can still resolve an installable release.
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = manifest.minAppVersion;
writeFileSync("versions.json", `${JSON.stringify(versions, null, 4)}\n`);
