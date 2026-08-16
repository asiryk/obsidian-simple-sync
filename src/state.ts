import type { AnyDB } from "./db";

const STATE_ID = "_local/simple-sync-state";

interface StateDoc {
    _id: string;
    _rev?: string;
    hashes: Record<string, string>;
    lastSeq: string | number;
}

/**
 * Per-device record of the content hash each file had when it was last in sync.
 *
 * This is what lets an incoming change tell "the local file is merely stale"
 * (overwrite it quietly) from "the local file diverged" (keep a conflict copy
 * first). Without it, every ordinary remote edit would spawn a conflict file.
 *
 * Stored in a _local/ document: those never replicate, which is exactly right
 * for state that describes one device's disk.
 */
export class SyncState {
    private hashes = new Map<string, string>();
    private rev: string | undefined;
    private saveTimer: ReturnType<typeof setTimeout> | null = null;
    private dirty = false;
    lastSeq: string | number = 0;

    constructor(private db: AnyDB) {}

    async load(): Promise<void> {
        try {
            const doc = (await this.db.get(STATE_ID)) as StateDoc;
            this.rev = doc._rev;
            this.lastSeq = doc.lastSeq ?? 0;
            this.hashes = new Map(Object.entries(doc.hashes ?? {}));
        } catch {
            this.hashes = new Map();
            this.lastSeq = 0;
        }
    }

    get(path: string): string | undefined {
        return this.hashes.get(path);
    }

    set(path: string, hash: string): void {
        if (this.hashes.get(path) === hash) return;
        this.hashes.set(path, hash);
        this.markDirty();
    }

    forget(path: string): void {
        if (this.hashes.delete(path)) this.markDirty();
    }

    setSeq(seq: string | number): void {
        this.lastSeq = seq;
        this.markDirty();
    }

    private markDirty(): void {
        this.dirty = true;
        if (this.saveTimer) return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            void this.save();
        }, 2000);
    }

    async save(): Promise<void> {
        if (!this.dirty) return;
        this.dirty = false;
        const doc: StateDoc = {
            _id: STATE_ID,
            hashes: Object.fromEntries(this.hashes),
            lastSeq: this.lastSeq,
        };
        if (this.rev) doc._rev = this.rev;
        try {
            const result = await this.db.put(doc);
            this.rev = result.rev;
        } catch (error: any) {
            if (error?.status === 409) {
                // Another write landed first; reload and let the next flush win.
                try {
                    const current = (await this.db.get(STATE_ID)) as StateDoc;
                    this.rev = current._rev;
                } catch {
                    this.rev = undefined;
                }
            }
            this.dirty = true;
        }
    }

    async flush(): Promise<void> {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        await this.save();
    }

    dispose(): void {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
    }
}
