// pouchdb-adapter-indexeddb ships no types. It is only ever handed to
// PouchDB.plugin(), so an opaque declaration is enough.
declare module "pouchdb-adapter-indexeddb" {
    const plugin: PouchDB.Plugin;
    export default plugin;
}

declare module "pouchdb-adapter-memory" {
    const plugin: PouchDB.Plugin;
    export default plugin;
}
