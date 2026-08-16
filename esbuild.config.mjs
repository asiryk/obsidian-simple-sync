import process from "node:process";
import esbuild from "esbuild";

const production = process.argv[2] === "production";

const context = await esbuild.context({
    entryPoints: ["src/main.ts"],
    bundle: true,
    outfile: "main.js",
    format: "cjs",
    target: "es2018",
    platform: "browser",
    logLevel: "info",
    sourcemap: production ? false : "inline",
    treeShaking: true,
    minify: production,
    // Provided by Obsidian at runtime; never bundle these.
    external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
    define: {
        "process.env.NODE_ENV": production ? '"production"' : '"development"',
    },
    // PouchDB's packages assume a CommonJS/Node-ish environment.
    inject: ["./src/shim.mjs"],
});

if (production) {
    await context.rebuild();
    process.exit(0);
} else {
    await context.watch();
}
