import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        alias: {
            // The real package is types-only and has no runtime entry point.
            obsidian: fileURLToPath(new URL("./test/obsidianStub.ts", import.meta.url)),
        },
    },
    test: {
        include: ["test/**/*.test.ts"],
        environment: "node",
    },
});
