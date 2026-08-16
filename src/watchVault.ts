import type { Plugin, TAbstractFile } from "obsidian";
import { buildDoc, buildTombstone, readLocalFile } from "./mapping";
import { getDoc, type SyncContext } from "./reconcile";
import type { SyncState } from "./state";

/** Obsidian fires "modify" on every autosave, so coalesce before touching the DB. */
const DEBOUNCE_MS = 1500;

export class VaultWatcher {
    private timers = new Map<string, ReturnType<typeof setTimeout>>();
    private running = false;

    constructor(
        private plugin: Plugin,
        private ctx: SyncContext,
        private state: SyncState,
        private onActivity: (direction: "up") => void,
    ) {}

    start(): void {
        if (this.running) return;
        this.running = true;
        const vault = this.plugin.app.vault;
        const touch = (file: TAbstractFile) => this.schedule(file.path);
        this.plugin.registerEvent(vault.on("create", touch));
        this.plugin.registerEvent(vault.on("modify", touch));
        this.plugin.registerEvent(vault.on("delete", touch));
        this.plugin.registerEvent(
            vault.on("rename", (file, oldPath) => {
                this.schedule(oldPath);
                this.schedule(file.path);
            }),
        );
    }

    stop(): void {
        this.running = false;
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
    }

    schedule(path: string): void {
        if (!this.running) return;
        if (this.ctx.ignore.matches(path)) return;
        const existing = this.timers.get(path);
        if (existing) clearTimeout(existing);
        this.timers.set(
            path,
            setTimeout(() => {
                this.timers.delete(path);
                void this.flush(path);
            }, DEBOUNCE_MS),
        );
    }

    /** Flushes one path immediately. Exposed for "Sync now" and for tests. */
    async flush(path: string): Promise<void> {
        try {
            const local = await readLocalFile(this.plugin.app.vault.adapter, path);
            const doc = await getDoc(this.ctx.local, path);

            if (!local) {
                // Gone from disk. Invariant 2 is written from this side too: the
                // tombstone records the hash so other devices can detect a race.
                if (doc && !doc.deleted) {
                    await this.ctx.local.put(buildTombstone(doc, path));
                    this.state.forget(path);
                    this.onActivity("up");
                }
                return;
            }

            // The echo check: this content is already what the database holds, so
            // it almost certainly came from applyChanges. Doing nothing here is
            // what stops the two pumps from looping.
            if (doc && !doc.deleted && doc.hash === local.hash) {
                this.state.set(path, local.hash);
                return;
            }

            await this.ctx.local.put(buildDoc(local, doc ?? undefined));
            this.state.set(path, local.hash);
            this.onActivity("up");
        } catch (error: any) {
            this.ctx.log(`upload failed for ${path}: ${error?.message ?? error}`);
        }
    }

    /** Flushes every pending debounce immediately. */
    async flushAll(): Promise<void> {
        const paths = [...this.timers.keys()];
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        for (const path of paths) await this.flush(path);
    }
}
