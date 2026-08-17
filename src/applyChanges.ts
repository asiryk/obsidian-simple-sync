import { hashOnDisk, isFileId, isTextPath } from "./mapping";
import type { SyncContext } from "./reconcile";
import { BULK_CHANGE_FRACTION, BULK_CHANGE_MINIMUM } from "./safety";
import type { SyncState } from "./state";
import { type FileDoc, META_ID } from "./types";
import { fetchAttachment, trashFile, writeConflictCopy, writeDocToVault } from "./vaultIO";

/** Guard D, streaming half: destructive operations counted over a rolling window. */
const BREAKER_WINDOW_MS = 15000;

/**
 * How far back through a document's revisions to look for the content sitting on
 * disk. Bounded because it costs one read per revision, and a device more than a
 * few edits behind is better served by the conflict copy anyway.
 */
const ANCESTOR_SCAN_LIMIT = 10;

export interface ApplyHooks {
    onActivity: (direction: "down") => void;
    onBreakerTripped: (message: string) => void;
}

export class ChangeApplier {
    private feed: any = null;
    private destructiveTimes: number[] = [];
    private stopped = false;

    constructor(
        private ctx: SyncContext,
        private state: SyncState,
        private hooks: ApplyHooks,
        private vaultFileCount: () => number,
    ) {}

    start(): void {
        if (this.feed) return;
        this.stopped = false;
        this.feed = this.ctx.local
            .changes({
                live: true,
                since: this.state.lastSeq,
                include_docs: true,
                conflicts: true,
                return_docs: false,
            })
            .on("change", (change: any) => {
                void this.handle(change);
            })
            .on("error", (error: any) => {
                this.ctx.log(`changes feed error: ${error?.message ?? error}`);
            });
    }

    stop(): void {
        this.stopped = true;
        if (this.feed) {
            this.feed.cancel();
            this.feed = null;
        }
    }

    private async handle(change: any): Promise<void> {
        if (this.stopped) return;
        try {
            if (change.id === META_ID || !isFileId(change.id)) {
                this.state.setSeq(change.seq);
                return;
            }
            let doc = change.doc as FileDoc | undefined;
            if (!doc) {
                this.state.setSeq(change.seq);
                return;
            }
            if (this.ctx.ignore.matches(doc.path)) {
                this.state.setSeq(change.seq);
                return;
            }
            if (doc._conflicts && doc._conflicts.length > 0) {
                doc = await this.resolveConflicts(doc);
            }
            await this.applyDoc(doc);
            this.state.setSeq(change.seq);
        } catch (error: any) {
            this.ctx.log(`apply failed for ${change.id}: ${error?.message ?? error}`);
        }
    }

    /**
     * Picks the newest revision as the winner and preserves every loser as a
     * file beside it. No dialog: the conflict copy in the vault is the notice.
     */
    private async resolveConflicts(doc: FileDoc): Promise<FileDoc> {
        const revs = doc._conflicts ?? [];
        let winner = doc;
        const losers: FileDoc[] = [];
        for (const rev of revs) {
            try {
                const other = (await this.ctx.local.get(doc._id, { rev })) as FileDoc;
                if ((other.mtime ?? 0) > (winner.mtime ?? 0)) {
                    losers.push(winner);
                    winner = other;
                } else {
                    losers.push(other);
                }
            } catch {
                // Revision already compacted away; nothing to preserve.
            }
        }

        for (const loser of losers) {
            try {
                if (loser.deleted) continue;
                const content =
                    loser.type === "text" ? (loser.data ?? "") : await fetchAttachment(this.ctx.local, loser);
                const copy = await writeConflictCopy(this.ctx.app, loser.path, content);
                this.ctx.log(`conflict on ${loser.path}: kept losing version as ${copy}`);
            } catch (error: any) {
                this.ctx.log(`could not preserve conflict copy: ${error?.message ?? error}`);
            }
        }

        for (const rev of revs) {
            if (rev === winner._rev) continue;
            try {
                await this.ctx.local.remove(doc._id, rev);
            } catch {
                // Already gone.
            }
        }
        return winner;
    }

    private async applyDoc(doc: FileDoc): Promise<void> {
        const adapter = this.ctx.app.vault.adapter;
        const path = doc.path;
        const diskHash = await hashOnDisk(adapter, path);

        if (doc.deleted) {
            if (diskHash === null) {
                this.state.forget(path);
                return;
            }
            // Invariant 2: only remove the copy that was actually deleted. If the
            // file was edited after the remote delete, keep it and resurrect.
            if (doc.deletedHash && doc.deletedHash !== diskHash) {
                this.ctx.log(`kept ${path}: edited locally after it was deleted elsewhere`);
                return;
            }
            if (!this.allowDestructive()) return;
            await trashFile(this.ctx.app, path);
            this.state.forget(path);
            this.hooks.onActivity("down");
            return;
        }

        if (diskHash === doc.hash) {
            // Echo of our own upload, or already in sync.
            this.state.set(path, doc.hash);
            return;
        }

        if (diskHash !== null) {
            const known = this.state.get(path);
            if (known !== diskHash && !(await this.matchesEarlierRevision(doc, diskHash))) {
                // Invariant 4: the file on disk holds content we never synced, so
                // it is preserved rather than overwritten.
                if (!this.allowDestructive()) return;
                // Read as whatever the path itself implies, not what the incoming
                // document claims, since the local copy is what is being kept.
                const local = await readForConflict(adapter, path, isTextPath(path) ? "text" : "bin");
                if (local !== null) {
                    const copy = await writeConflictCopy(this.ctx.app, path, local);
                    this.ctx.log(`diverged: kept local ${path} as ${copy}`);
                }
            }
        }

        await writeDocToVault(this.ctx.app, this.ctx.local, doc);
        this.state.set(path, doc.hash);
        this.hooks.onActivity("down");
    }

    /**
     * Second opinion for invariant 4, used when the state map has no hash for a
     * path. Content equal to an earlier revision of the same document was synced
     * here at some point, so overwriting it loses nothing and no copy is needed.
     *
     * This covers the devices the state map cannot speak for: one that joined
     * before the map was recorded, or one whose local database was rebuilt.
     */
    private async matchesEarlierRevision(doc: FileDoc, diskHash: string): Promise<boolean> {
        let history: any;
        try {
            const options = doc._rev ? { rev: doc._rev, revs: true } : { revs: true };
            history = await this.ctx.local.get(doc._id, options as any);
        } catch {
            return false;
        }
        const start: number | undefined = history?._revisions?.start;
        const ids: string[] | undefined = history?._revisions?.ids;
        if (typeof start !== "number" || !ids) return false;

        // ids[0] is the revision we already compared, so start one back.
        const limit = Math.min(ids.length, ANCESTOR_SCAN_LIMIT + 1);
        for (let i = 1; i < limit; i++) {
            try {
                const older = (await this.ctx.local.get(doc._id, {
                    rev: `${start - i}-${ids[i]}`,
                })) as FileDoc;
                if (older.hash === diskHash) return true;
            } catch {
                // Compacted away. Everything older is gone too, so stop here.
                return false;
            }
        }
        return false;
    }

    /**
     * Guard D. A burst of destructive operations is far more likely to be a wiped
     * remote than a real intention, so trip and stop rather than replicate it.
     */
    private allowDestructive(): boolean {
        const now = Date.now();
        this.destructiveTimes = this.destructiveTimes.filter((t) => now - t < BREAKER_WINDOW_MS);
        this.destructiveTimes.push(now);
        const threshold = Math.max(BULK_CHANGE_MINIMUM, this.vaultFileCount() * BULK_CHANGE_FRACTION);
        if (this.destructiveTimes.length > threshold) {
            this.stop();
            this.hooks.onBreakerTripped(
                `Sync stopped: more than ${Math.floor(threshold)} files in this vault were about to be ` +
                    "deleted or overwritten at once. Check the server, then run a dry-run reconcile.",
            );
            return false;
        }
        return true;
    }
}

async function readForConflict(
    adapter: { read: (p: string) => Promise<string>; readBinary: (p: string) => Promise<ArrayBuffer> },
    path: string,
    type: "text" | "bin",
): Promise<string | ArrayBuffer | null> {
    try {
        return type === "text" ? await adapter.read(path) : await adapter.readBinary(path);
    } catch {
        return null;
    }
}
