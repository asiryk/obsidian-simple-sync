// npm "preversion" lifecycle script. It runs before package.json and the lock
// file are rewritten, so a failure here leaves nothing to clean up.
// It rejects a version that is already tagged.
import { execSync } from "node:child_process";
import process from "node:process";

try {
    // Tags the server has but this clone does not would otherwise only surface
    // at push time, after the commit and tag are already made.
    execSync("git fetch --tags", { stdio: "inherit" });

    const tagList = execSync("git tag").toString().trim().split("\n").filter(Boolean);

    const newVersion = process.env.npm_new_version;
    if (!newVersion) {
        throw new Error("npm_new_version is not set; run this through `npm version <patch|minor|major>`");
    }

    // .npmrc sets an empty tag prefix, so the tag is the bare version.
    if (tagList.includes(newVersion)) {
        throw new Error(`version ${newVersion} is already present`);
    }
} catch (e) {
    console.error("error during version bump:", e.message);
    process.exit(1);
}
