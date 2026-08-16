import type { App } from "obsidian";
import type { AnyDB } from "./db";
import type { IgnoreList } from "./ignore";
import { base64ToArrayBuffer, blobToArrayBuffer, extensionOf } from "./mapping";
import type { FileDoc } from "./types";

/** Recursive vault walk. Ignored folders are pruned rather than filtered later. */
export async function listVaultFiles(app: App, ignore: IgnoreList): Promise<string[]> {
    const adapter = app.vault.adapter;
    const found: string[] = [];
    const queue: string[] = [""];
    while (queue.length > 0) {
        const dir = queue.pop() as string;
        let listing: { files: string[]; folders: string[] };
        try {
            listing = await adapter.list(dir);
        } catch {
            continue;
        }
        for (const file of listing.files) {
            if (!ignore.matches(file)) found.push(file);
        }
        for (const folder of listing.folders) {
            if (!ignore.matches(folder)) queue.push(folder);
        }
    }
    return found;
}

export async function ensureParentFolder(app: App, path: string): Promise<void> {
    const slash = path.lastIndexOf("/");
    if (slash <= 0) return;
    const folder = path.slice(0, slash);
    if (await app.vault.adapter.exists(folder)) return;
    await app.vault.adapter.mkdir(folder);
}

/**
 * Writes a document's content to the vault, preserving its timestamps so the
 * mtime does not churn and re-trigger the watcher on every device.
 */
export async function writeDocToVault(app: App, db: AnyDB, doc: FileDoc): Promise<void> {
    const adapter = app.vault.adapter;
    await ensureParentFolder(app, doc.path);
    const options = { mtime: Math.floor(doc.mtime), ctime: Math.floor(doc.ctime) };
    if (doc.type === "text") {
        await adapter.write(doc.path, doc.data ?? "", options);
        return;
    }
    const buffer = await fetchAttachment(db, doc);
    await adapter.writeBinary(doc.path, buffer, options);
}

/** Attachments are stubs in the changes feed, so fetch the body on demand. */
export async function fetchAttachment(db: AnyDB, doc: FileDoc): Promise<ArrayBuffer> {
    const attachment = (await db.getAttachment(doc._id, "content")) as Blob | Buffer | string;
    if (typeof attachment === "string") return base64ToArrayBuffer(attachment);
    if (typeof Blob !== "undefined" && attachment instanceof Blob) {
        return await blobToArrayBuffer(attachment);
    }
    const view = attachment as unknown as Uint8Array;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

/**
 * Invariant 3: removal always goes through Obsidian's trash, never
 * adapter.remove, so a wrong delete is always recoverable.
 */
export async function trashFile(app: App, path: string): Promise<void> {
    const file = app.vault.getAbstractFileByPath(path);
    if (file) {
        await app.vault.trash(file, false);
        return;
    }
    // Not in the vault index (dotfiles, or a stale cache): fall back to the
    // adapter's local trash, which still keeps a copy in .trash.
    await app.vault.adapter.trashLocal(path);
}

export function conflictPathFor(path: string): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
    const extension = extensionOf(path);
    if (!extension) return `${path}.conflict-${stamp}`;
    const withoutExtension = path.slice(0, path.length - extension.length - 1);
    return `${withoutExtension}.conflict-${stamp}.${extension}`;
}

/**
 * Invariant 4: content that matches no known-synced state is preserved beside the
 * winner rather than overwritten. A file appearing in the vault is the entire
 * conflict notification mechanism.
 */
export async function writeConflictCopy(
    app: App,
    path: string,
    content: string | ArrayBuffer,
): Promise<string> {
    const target = conflictPathFor(path);
    await ensureParentFolder(app, target);
    if (typeof content === "string") {
        await app.vault.adapter.write(target, content);
    } else {
        await app.vault.adapter.writeBinary(target, content);
    }
    return target;
}
