import type { AnyDB } from "./db";
import { META_ID, type MetaDoc, type ReconcileReport, type SyncSettings } from "./types";

/**
 * Guard D thresholds. A reconcile or incoming batch that would destroy more than
 * this stops and asks, rather than faithfully replicating someone else's mistake.
 */
export const BULK_CHANGE_FRACTION = 0.2;
export const BULK_CHANGE_MINIMUM = 50;

export async function readMeta(db: AnyDB): Promise<MetaDoc | null> {
    try {
        return (await db.get(META_ID)) as MetaDoc;
    } catch (error: any) {
        if (error?.status === 404) return null;
        throw error;
    }
}

export async function writeMeta(db: AnyDB, vaultName: string, syncId: string): Promise<MetaDoc> {
    const existing = await readMeta(db);
    const doc: MetaDoc = {
        _id: META_ID,
        syncId,
        vaultName,
        initializedAt: new Date().toISOString(),
    };
    if (existing?._rev) doc._rev = existing._rev;
    const result = await db.put(doc);
    doc._rev = result.rev;
    return doc;
}

export function newSyncId(): string {
    return crypto.randomUUID();
}

export type IdentityVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Guard A. Once initialized, the marker on the server must still be the one this
 * vault joined. A mismatch means the plugin is pointed at a different database
 * (or the database was rebuilt elsewhere), which is exactly the situation where
 * blindly syncing would pollute the vault.
 */
export async function verifyIdentity(db: AnyDB, settings: SyncSettings): Promise<IdentityVerdict> {
    const meta = await readMeta(db);
    if (!meta) {
        return {
            ok: false,
            reason:
                "The database has no sync marker. It was cleared or replaced. " +
                "Reset this vault's setup and initialize again deliberately.",
        };
    }
    if (settings.syncId && meta.syncId !== settings.syncId) {
        return {
            ok: false,
            reason:
                `This database belongs to a different sync group (marked "${meta.vaultName}"). ` +
                "Sync is stopped so nothing is overwritten. Check the database name, " +
                "or reset this vault's setup if the change was intended.",
        };
    }
    return { ok: true };
}

/**
 * Guard D. Returns a warning string when the plan is destructive enough to
 * warrant a second look, or null when it is routine.
 */
export function bulkChangeWarning(report: ReconcileReport): string | null {
    const destructive = report.counts["delete-local"] + report.counts.download;
    if (destructive === 0) return null;
    const threshold = Math.max(BULK_CHANGE_MINIMUM, report.vaultFileCount * BULK_CHANGE_FRACTION);
    if (destructive <= threshold) return null;
    return (
        `This would delete or overwrite ${destructive} of ${report.vaultFileCount} files in this vault. ` +
        "That is unusually large. Continue only if you expect it."
    );
}

/**
 * Guard B, pull half. Pull mode assumes the remote is authoritative, so a vault
 * that already holds unknown files is a setup mistake, not a merge request.
 */
export function pullPreconditionFailure(unknownLocalFiles: string[]): string | null {
    if (unknownLocalFiles.length === 0) return null;
    const sample = unknownLocalFiles.slice(0, 5).join(", ");
    const more = unknownLocalFiles.length > 5 ? `, and ${unknownLocalFiles.length - 5} more` : "";
    return (
        `Pull mode expects an empty vault, but ${unknownLocalFiles.length} file(s) here are not in ` +
        `the database: ${sample}${more}. Empty the vault, or choose Merge if you really want to ` +
        "upload them."
    );
}
