import type { App } from "obsidian";
import type { AnyDB } from "./db";
import type { IgnoreList } from "./ignore";
import { buildDoc, buildTombstone, isFileId, pathToId, readLocalFile } from "./mapping";
import type { FileDoc, InitMode, PlannedAction, ReconcileReport } from "./types";
import { listVaultFiles, trashFile, writeConflictCopy, writeDocToVault } from "./vaultIO";

export interface SyncContext {
    app: App;
    local: AnyDB;
    ignore: IgnoreList;
    log: (message: string) => void;
}

function emptyCounts(): ReconcileReport["counts"] {
    return { upload: 0, download: 0, "delete-local": 0, conflict: 0, skip: 0 };
}

async function loadDocs(local: AnyDB): Promise<Map<string, FileDoc>> {
    const result = await local.allDocs({ include_docs: true });
    const byPath = new Map<string, FileDoc>();
    for (const row of result.rows) {
        if (!isFileId(row.id) || !row.doc) continue;
        const doc = row.doc as FileDoc;
        byPath.set(doc.path, doc);
    }
    return byPath;
}

/** Vault files the database has never seen. Guard B uses this for pull mode. */
export async function unknownLocalFiles(ctx: SyncContext): Promise<string[]> {
    const [paths, docs] = await Promise.all([listVaultFiles(ctx.app, ctx.ignore), loadDocs(ctx.local)]);
    return paths.filter((path) => {
        const doc = docs.get(path);
        return !doc || doc.deleted;
    });
}

/**
 * Works out what a reconcile would do, without touching anything. Guard C shows
 * this before the first sync, and it is available on demand afterwards.
 */
export async function planReconcile(ctx: SyncContext, mode: InitMode): Promise<ReconcileReport> {
    const adapter = ctx.app.vault.adapter;
    const [paths, docs] = await Promise.all([listVaultFiles(ctx.app, ctx.ignore), loadDocs(ctx.local)]);
    const actions: PlannedAction[] = [];
    const seen = new Set<string>();

    for (const path of paths) {
        seen.add(path);
        const doc = docs.get(path);
        const local = await readLocalFile(adapter, path);
        if (!local) continue;

        if (mode === "push") {
            if (doc && !doc.deleted && doc.hash === local.hash) {
                actions.push({ kind: "skip", path, reason: "already identical" });
            } else {
                actions.push({ kind: "upload", path, reason: "push: local is authoritative" });
            }
            continue;
        }

        if (!doc) {
            // Invariant 1: a file the database has never seen is uploaded, never deleted.
            actions.push({ kind: "upload", path, reason: "not in database" });
            continue;
        }

        if (doc.deleted) {
            // Invariant 2: only delete when the local copy is the one that was deleted.
            if (doc.deletedHash && doc.deletedHash === local.hash) {
                actions.push({ kind: "delete-local", path, reason: "deleted on another device" });
            } else {
                actions.push({ kind: "upload", path, reason: "edited after remote delete" });
            }
            continue;
        }

        if (doc.hash === local.hash) {
            actions.push({ kind: "skip", path, reason: "identical" });
        } else if (mode === "pull") {
            actions.push({ kind: "conflict", path, reason: "pull: remote wins, local kept beside it" });
        } else if (local.mtime > doc.mtime) {
            actions.push({ kind: "upload", path, reason: "local is newer" });
        } else {
            actions.push({ kind: "conflict", path, reason: "remote is newer, local kept beside it" });
        }
    }

    for (const [path, doc] of docs) {
        if (seen.has(path)) continue;
        if (doc.deleted) continue;
        if (ctx.ignore.matches(path)) continue;
        if (mode === "push") {
            actions.push({ kind: "delete-local", path, reason: "push: removing from database" });
        } else {
            actions.push({ kind: "download", path, reason: "only in database" });
        }
    }

    const counts = emptyCounts();
    for (const action of actions) counts[action.kind]++;
    return { actions, counts, vaultFileCount: paths.length };
}

export function describeReport(report: ReconcileReport, mode: InitMode): string {
    const c = report.counts;
    const lines = [
        `Mode: ${mode}`,
        `Vault files: ${report.vaultFileCount}`,
        "",
        `Upload to server:      ${c.upload}`,
        `Write into vault:      ${c.download}`,
        `Conflicts (copy kept): ${c.conflict}`,
        `Remove from vault:     ${c["delete-local"]}`,
        `Unchanged:             ${c.skip}`,
    ];
    const notable = report.actions.filter((a) => a.kind !== "skip" && a.kind !== "upload").slice(0, 15);
    if (notable.length > 0) {
        lines.push("", "Changes to this vault:");
        for (const action of notable) lines.push(`  ${action.kind}: ${action.path}`);
        const total = c.download + c.conflict + c["delete-local"];
        if (total > notable.length) lines.push(`  ... and ${total - notable.length} more`);
    }
    return lines.join("\n");
}

/** Executes a plan. Content is re-read at this point, so it is always current. */
export async function applyReconcile(
    ctx: SyncContext,
    mode: InitMode,
    report: ReconcileReport,
): Promise<void> {
    const adapter = ctx.app.vault.adapter;

    for (const action of report.actions) {
        try {
            if (action.kind === "skip") continue;

            if (action.kind === "upload") {
                const local = await readLocalFile(adapter, action.path);
                if (!local) continue;
                const existing = await getDoc(ctx.local, action.path);
                await ctx.local.put(buildDoc(local, existing ?? undefined));
                continue;
            }

            if (action.kind === "download") {
                const doc = await getDoc(ctx.local, action.path);
                if (!doc || doc.deleted) continue;
                await writeDocToVault(ctx.app, ctx.local, doc);
                continue;
            }

            if (action.kind === "conflict") {
                const local = await readLocalFile(adapter, action.path);
                const doc = await getDoc(ctx.local, action.path);
                if (!doc || doc.deleted) continue;
                if (local) {
                    const copy = await writeConflictCopy(
                        ctx.app,
                        action.path,
                        local.type === "text" ? (local.text ?? "") : (local.binary as ArrayBuffer),
                    );
                    ctx.log(`conflict: kept local copy as ${copy}`);
                }
                await writeDocToVault(ctx.app, ctx.local, doc);
                continue;
            }

            if (action.kind === "delete-local") {
                if (mode === "push") {
                    const doc = await getDoc(ctx.local, action.path);
                    if (doc && !doc.deleted) {
                        await ctx.local.put(buildTombstone(doc, action.path));
                    }
                } else if (await adapter.exists(action.path)) {
                    await trashFile(ctx.app, action.path);
                }
            }
        } catch (error: any) {
            ctx.log(`reconcile failed for ${action.path}: ${error?.message ?? error}`);
        }
    }
}

export async function getDoc(local: AnyDB, path: string): Promise<FileDoc | null> {
    try {
        return (await local.get(pathToId(path))) as FileDoc;
    } catch (error: any) {
        if (error?.status === 404) return null;
        throw error;
    }
}
