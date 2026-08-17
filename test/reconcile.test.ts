import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IgnoreList } from "../src/ignore";
import { buildDoc, buildTombstone, pathToId, readLocalFile, sha256 } from "../src/mapping";
import { applyReconcile, planReconcile, unknownLocalFiles, type SyncContext } from "../src/reconcile";
import { SyncState } from "../src/state";
import type { FileDoc, PlannedAction } from "../src/types";
import { bytes, FakeVault, memoryDb } from "./fakeVault";

let vault: FakeVault;
let db: any;
let ctx: SyncContext;
let state: SyncState;

beforeEach(async () => {
    vault = new FakeVault();
    db = memoryDb();
    ctx = {
        app: vault.app,
        local: db,
        ignore: new IgnoreList(".obsidian/**\n.git/**"),
        log: () => {},
    };
    state = new SyncState(db);
    await state.load();
});

afterEach(() => {
    state.dispose();
});

/** Puts a document into the database describing a file's current disk content. */
async function seedDocFromDisk(path: string): Promise<FileDoc> {
    const local = await readLocalFile(vault.adapter as any, path);
    if (!local) throw new Error(`missing ${path}`);
    const doc = buildDoc(local);
    const result = await db.put(doc);
    return { ...doc, _rev: result.rev };
}

function kindOf(actions: PlannedAction[], path: string): string | undefined {
    return actions.find((a) => a.path === path)?.kind;
}

describe("planReconcile in merge mode", () => {
    it("uploads a file the database has never seen", async () => {
        vault.writeText("Note.md", "hello");
        const report = await planReconcile(ctx, "merge");
        expect(kindOf(report.actions, "Note.md")).toBe("upload");
    });

    it("skips a file whose content already matches", async () => {
        vault.writeText("Note.md", "hello");
        await seedDocFromDisk("Note.md");
        const report = await planReconcile(ctx, "merge");
        expect(kindOf(report.actions, "Note.md")).toBe("skip");
    });

    it("downloads a file that exists only in the database", async () => {
        vault.writeText("Note.md", "hello");
        await seedDocFromDisk("Note.md");
        vault.files.delete("Note.md");
        const report = await planReconcile(ctx, "merge");
        expect(kindOf(report.actions, "Note.md")).toBe("download");
    });

    it("uploads when the local copy is newer", async () => {
        vault.writeText("Note.md", "old", 1000);
        await seedDocFromDisk("Note.md");
        vault.writeText("Note.md", "new", 5000);
        const report = await planReconcile(ctx, "merge");
        expect(kindOf(report.actions, "Note.md")).toBe("upload");
    });

    it("treats a newer remote as a conflict so the local copy survives", async () => {
        vault.writeText("Note.md", "local edit", 1000);
        const doc = await seedDocFromDisk("Note.md");
        await db.put({ ...doc, data: "remote edit", hash: await sha256("remote edit"), mtime: 9000 });
        const report = await planReconcile(ctx, "merge");
        expect(kindOf(report.actions, "Note.md")).toBe("conflict");
    });

    it("ignores paths matching the ignore list", async () => {
        vault.writeText(".obsidian/workspace.json", "{}");
        const report = await planReconcile(ctx, "merge");
        expect(report.actions).toHaveLength(0);
    });
});

describe("invariant 1: a file the database has never seen is never deleted", () => {
    it("uploads local-only files even when the database is full of foreign data", async () => {
        vault.writeText("Mine.md", "my note");
        for (let i = 0; i < 5; i++) {
            await db.put({
                _id: pathToId(`Junk${i}.md`),
                path: `Junk${i}.md`,
                type: "text",
                ctime: 1,
                mtime: 1,
                size: 4,
                hash: await sha256("junk"),
                data: "junk",
            });
        }
        const report = await planReconcile(ctx, "merge");
        expect(kindOf(report.actions, "Mine.md")).toBe("upload");
        expect(report.actions.some((a) => a.kind === "delete-local" && a.path === "Mine.md")).toBe(false);

        await applyReconcile(ctx, "merge", report, state);
        expect(vault.files.has("Mine.md")).toBe(true);
        expect(vault.trashed).toHaveLength(0);
    });

    it("never plans a delete for any local file absent from the database", async () => {
        vault.writeText("A.md", "a");
        vault.writeText("B.md", "b");
        const report = await planReconcile(ctx, "merge");
        const deletes = report.actions.filter((a) => a.kind === "delete-local");
        expect(deletes).toHaveLength(0);
    });
});

describe("invariant 2: deletes only apply to the copy that was deleted", () => {
    it("deletes locally when the content still matches the tombstone", async () => {
        vault.writeText("Gone.md", "content");
        const doc = await seedDocFromDisk("Gone.md");
        await db.put(buildTombstone(doc, "Gone.md"));

        const report = await planReconcile(ctx, "merge");
        expect(kindOf(report.actions, "Gone.md")).toBe("delete-local");

        await applyReconcile(ctx, "merge", report, state);
        expect(vault.trashed).toContain("Gone.md");
    });

    it("keeps and re-uploads a file edited after the remote delete", async () => {
        vault.writeText("Gone.md", "content");
        const doc = await seedDocFromDisk("Gone.md");
        await db.put(buildTombstone(doc, "Gone.md"));
        vault.writeText("Gone.md", "edited after the delete", 9000);

        const report = await planReconcile(ctx, "merge");
        expect(kindOf(report.actions, "Gone.md")).toBe("upload");

        await applyReconcile(ctx, "merge", report, state);
        expect(vault.files.has("Gone.md")).toBe(true);
        expect(vault.trashed).toHaveLength(0);
        const revived = (await db.get(pathToId("Gone.md"))) as FileDoc;
        expect(revived.deleted).toBeFalsy();
        expect(revived.data).toBe("edited after the delete");
    });
});

describe("push mode", () => {
    it("uploads everything and writes nothing into the vault", async () => {
        vault.writeText("A.md", "a");
        vault.writeText("B.md", "b");
        await db.put({
            _id: pathToId("Stale.md"),
            path: "Stale.md",
            type: "text",
            ctime: 1,
            mtime: 1,
            size: 1,
            hash: await sha256("stale"),
            data: "stale",
        });

        const report = await planReconcile(ctx, "push");
        expect(report.counts.download).toBe(0);
        expect(report.counts.conflict).toBe(0);

        const before = new Map(vault.files);
        await applyReconcile(ctx, "push", report, state);

        expect([...vault.files.keys()].sort()).toEqual([...before.keys()].sort());
        expect(vault.trashed).toHaveLength(0);
        const tombstone = (await db.get(pathToId("Stale.md"))) as FileDoc;
        expect(tombstone.deleted).toBe(true);
    });
});

describe("pull mode", () => {
    it("reports local files the database has never seen", async () => {
        vault.writeText("OnlyHere.md", "local");
        const unknown = await unknownLocalFiles(ctx);
        expect(unknown).toEqual(["OnlyHere.md"]);
    });

    it("keeps the local copy beside the remote one rather than overwriting", async () => {
        vault.writeText("Note.md", "local version", 9000);
        const doc = await seedDocFromDisk("Note.md");
        await db.put({ ...doc, data: "remote version", hash: await sha256("remote version"), mtime: 1 });

        const report = await planReconcile(ctx, "pull");
        expect(kindOf(report.actions, "Note.md")).toBe("conflict");

        await applyReconcile(ctx, "pull", report, state);
        expect(vault.files.get("Note.md")?.text).toBe("remote version");
        const conflictCopy = [...vault.files.keys()].find((p) => p.includes(".conflict-"));
        expect(conflictCopy).toBeDefined();
        expect(vault.files.get(conflictCopy as string)?.text).toBe("local version");
    });
});

describe("the baseline reconcile leaves behind", () => {
    it("records a hash for files it left untouched", async () => {
        vault.writeText("Same.md", "hello");
        await seedDocFromDisk("Same.md");

        const report = await planReconcile(ctx, "merge");
        expect(kindOf(report.actions, "Same.md")).toBe("skip");

        await applyReconcile(ctx, "merge", report, state);
        expect(state.get("Same.md")).toBe(await sha256("hello"));
    });

    it("records a hash for uploads, downloads and conflicts alike", async () => {
        vault.writeText("Uploaded.md", "mine");
        vault.writeText("Downloaded.md", "theirs");
        await seedDocFromDisk("Downloaded.md");
        vault.files.delete("Downloaded.md");
        vault.writeText("Fought.md", "local", 1000);
        const doc = await seedDocFromDisk("Fought.md");
        await db.put({ ...doc, data: "remote", hash: await sha256("remote"), mtime: 9000 });

        await applyReconcile(ctx, "merge", await planReconcile(ctx, "merge"), state);

        expect(state.get("Uploaded.md")).toBe(await sha256("mine"));
        expect(state.get("Downloaded.md")).toBe(await sha256("theirs"));
        expect(state.get("Fought.md")).toBe(await sha256("remote"));
    });

    it("forgets a path it removed from the vault", async () => {
        vault.writeText("Gone.md", "content");
        const doc = await seedDocFromDisk("Gone.md");
        state.set("Gone.md", doc.hash);
        await db.put(buildTombstone(doc, "Gone.md"));

        await applyReconcile(ctx, "merge", await planReconcile(ctx, "merge"), state);
        expect(state.get("Gone.md")).toBeUndefined();
    });
});

describe("binary files", () => {
    it("round-trips through an attachment", async () => {
        vault.writeBin("Assets/pic.avif", bytes(1, 2, 3, 4, 5));
        const uploadPlan = await planReconcile(ctx, "merge");
        await applyReconcile(ctx, "merge", uploadPlan, state);

        vault.files.delete("Assets/pic.avif");
        const downloadPlan = await planReconcile(ctx, "merge");
        expect(kindOf(downloadPlan.actions, "Assets/pic.avif")).toBe("download");

        await applyReconcile(ctx, "merge", downloadPlan, state);
        const restored = vault.files.get("Assets/pic.avif");
        expect(new Uint8Array(restored?.binary as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    });
});
