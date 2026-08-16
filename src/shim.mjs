// PouchDB's packages are written for a CommonJS/Node-ish environment and
// reference `global` and `process` as free identifiers. esbuild's `inject`
// rewrites those references to these exports.

export const global = globalThis;

export const process = {
    env: {},
    nextTick: (fn, ...args) => {
        Promise.resolve().then(() => fn(...args));
    },
    browser: true,
    version: "",
    platform: "browser",
};
