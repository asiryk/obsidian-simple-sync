import HttpAdapter from "pouchdb-adapter-http";
import IndexeddbAdapter from "pouchdb-adapter-indexeddb";
import PouchDB from "pouchdb-core";
import MapReduce from "pouchdb-mapreduce";
import Replication from "pouchdb-replication";
import type { SyncSettings } from "./types";

PouchDB.plugin(IndexeddbAdapter).plugin(HttpAdapter).plugin(MapReduce).plugin(Replication);

export type AnyDB = PouchDB.Database<any>;

export function localDbName(vaultName: string): string {
    return `simple-sync-${vaultName}`;
}

export function openLocal(vaultName: string): AnyDB {
    return new PouchDB(localDbName(vaultName), { adapter: "indexeddb" });
}

export function openRemote(settings: SyncSettings): AnyDB {
    const base = settings.url.replace(/\/+$/, "");
    return new PouchDB(`${base}/${settings.database}`, {
        adapter: "http",
        auth: { username: settings.username, password: settings.password },
        skip_setup: true,
    } as any);
}

export interface ConnectionCheck {
    ok: boolean;
    message: string;
    docCount?: number;
}

/** Used by the "Test connection" button and before any initialization. */
export async function checkConnection(settings: SyncSettings): Promise<ConnectionCheck> {
    if (!settings.url || !settings.database) {
        return { ok: false, message: "Server URL and database are required." };
    }
    if (settings.url.startsWith("http://")) {
        // The user's server 301-redirects to https, and a redirect can drop the
        // Authorization header. Fail loudly rather than mysteriously.
        return { ok: false, message: "Use an https:// URL. http:// may lose the auth header on redirect." };
    }
    const remote = openRemote(settings);
    try {
        const info = await remote.info();
        return {
            ok: true,
            message: `Connected. ${info.doc_count} documents.`,
            docCount: info.doc_count,
        };
    } catch (error: any) {
        const status = error?.status ? ` (HTTP ${error.status})` : "";
        return { ok: false, message: `${error?.message ?? "Connection failed"}${status}` };
    } finally {
        await remote.close().catch(() => {});
    }
}

export { PouchDB };
