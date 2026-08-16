import PouchDB from "pouchdb-core";
import HttpAdapter from "pouchdb-adapter-http";
import MemoryAdapter from "pouchdb-adapter-memory";
import MapReduce from "pouchdb-mapreduce";
import Replication from "pouchdb-replication";

PouchDB.plugin(MemoryAdapter).plugin(HttpAdapter).plugin(MapReduce).plugin(Replication);

/** Real CouchDB over HTTP, for the opt-in integration test. */
export function httpDb(url: string, auth: { username: string; password: string }): any {
    return new PouchDB(url, { adapter: "http", auth } as any);
}

let dbCounter = 0;
export function memoryDb(): any {
    return new PouchDB(`test-${dbCounter++}-${Math.random().toString(36).slice(2)}`, {
        adapter: "memory",
    });
}

interface Entry {
    text?: string;
    binary?: ArrayBuffer;
    mtime: number;
    ctime: number;
}

/**
 * In-memory stand-in for Obsidian's vault adapter, matching the parts the plugin
 * uses. Notably `list` returns full paths, as Obsidian's does.
 */
export class FakeVault {
    files = new Map<string, Entry>();
    trashed: string[] = [];
    private name: string;

    constructor(name = "test-vault") {
        this.name = name;
    }

    get app(): any {
        return {
            vault: {
                adapter: this.adapter,
                getName: () => this.name,
                getAbstractFileByPath: (path: string) =>
                    this.files.has(path) ? { path } : null,
                trash: async (file: { path: string }) => {
                    this.trashed.push(file.path);
                    this.files.delete(file.path);
                },
            },
        };
    }

    writeText(path: string, text: string, mtime = 1000, ctime = 1000): void {
        this.files.set(path, { text, mtime, ctime });
    }

    writeBin(path: string, binary: ArrayBuffer, mtime = 1000, ctime = 1000): void {
        this.files.set(path, { binary, mtime, ctime });
    }

    adapter = {
        exists: async (path: string) => this.files.has(path),
        stat: async (path: string) => {
            const entry = this.files.get(path);
            if (!entry) return null;
            const size = entry.text
                ? new TextEncoder().encode(entry.text).byteLength
                : (entry.binary?.byteLength ?? 0);
            return { type: "file" as const, size, mtime: entry.mtime, ctime: entry.ctime };
        },
        read: async (path: string) => {
            const entry = this.files.get(path);
            if (!entry || entry.text === undefined) throw new Error(`no such text file: ${path}`);
            return entry.text;
        },
        readBinary: async (path: string) => {
            const entry = this.files.get(path);
            if (!entry || !entry.binary) throw new Error(`no such binary file: ${path}`);
            return entry.binary;
        },
        write: async (path: string, data: string, options?: { mtime?: number; ctime?: number }) => {
            this.files.set(path, {
                text: data,
                mtime: options?.mtime ?? Date.now(),
                ctime: options?.ctime ?? Date.now(),
            });
        },
        writeBinary: async (
            path: string,
            data: ArrayBuffer,
            options?: { mtime?: number; ctime?: number }
        ) => {
            this.files.set(path, {
                binary: data,
                mtime: options?.mtime ?? Date.now(),
                ctime: options?.ctime ?? Date.now(),
            });
        },
        mkdir: async () => {},
        remove: async (path: string) => {
            this.files.delete(path);
        },
        trashLocal: async (path: string) => {
            this.trashed.push(path);
            this.files.delete(path);
        },
        list: async (dir: string) => {
            const prefix = dir === "" ? "" : `${dir}/`;
            const files: string[] = [];
            const folders = new Set<string>();
            for (const path of this.files.keys()) {
                if (!path.startsWith(prefix)) continue;
                const rest = path.slice(prefix.length);
                const slash = rest.indexOf("/");
                if (slash === -1) files.push(path);
                else folders.add(prefix + rest.slice(0, slash));
            }
            return { files, folders: [...folders] };
        },
    };
}

export function bytes(...values: number[]): ArrayBuffer {
    return new Uint8Array(values).buffer;
}
