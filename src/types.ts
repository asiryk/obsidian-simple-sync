export type InitMode = "push" | "pull" | "merge";

export interface SyncSettings {
    url: string;
    username: string;
    password: string;
    database: string;
    /** Newline-separated glob patterns. */
    ignore: string;
    /** Sync is only allowed once the vault has been deliberately initialized. */
    initialized: boolean;
    initMode: InitMode | "";
    initializedAt: string;
    /** Identifies the sync group. Must match the marker document on the server. */
    syncId: string;
    /** Local changes-feed checkpoint, so a restart does not replay everything. */
    lastSeq: string | number;
    enabled: boolean;
    debug: boolean;
}

export const DEFAULT_SETTINGS: SyncSettings = {
    url: "",
    username: "",
    password: "",
    database: "",
    ignore: [".git/**", ".obsidian/**", ".DS_Store", ".fseventsd/**", ".Trashes/**", ".trash/**"].join("\n"),
    initialized: false,
    initMode: "",
    initializedAt: "",
    syncId: "",
    lastSeq: 0,
    enabled: true,
    debug: false,
};

/** Settings that are safe and useful to move to another device via QR. */
export type PortableSettings = Pick<SyncSettings, "url" | "username" | "password" | "database" | "ignore">;

export const DOC_PREFIX = "f:";
export const META_ID = "meta:sync";

export interface FileDoc {
    _id: string;
    _rev?: string;
    path: string;
    type: "text" | "bin";
    ctime: number;
    mtime: number;
    size: number;
    /** SHA-256 of the content. The whole loop-prevention scheme rests on this. */
    hash: string;
    /** Present for type "text" only. Binaries live in _attachments. */
    data?: string;
    deleted?: boolean;
    /** Content hash at the moment of deletion, so a delete/edit race is detectable. */
    deletedHash?: string;
    _attachments?: Record<string, { content_type: string; data: any; stub?: boolean }>;
    _conflicts?: string[];
    _deleted?: boolean;
}

export interface MetaDoc {
    _id: string;
    _rev?: string;
    syncId: string;
    vaultName: string;
    initializedAt: string;
}

/** One intended change, produced by reconcile and rendered in the dry-run report. */
export interface PlannedAction {
    kind: "upload" | "download" | "delete-local" | "conflict" | "skip";
    path: string;
    reason: string;
}

export interface ReconcileReport {
    actions: PlannedAction[];
    counts: Record<PlannedAction["kind"], number>;
    vaultFileCount: number;
}
