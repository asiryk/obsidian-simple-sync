import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChangeApplier } from "../src/applyChanges";
import { IgnoreList } from "../src/ignore";
import { buildDoc, buildTombstone, pathToId, readLocalFile, sha256 } from "../src/mapping";
import { applyReconcile, planReconcile, type SyncContext } from "../src/reconcile";
import { SyncState } from "../src/state";
import type { FileDoc } from "../src/types";
import { FakeVault, memoryDb } from "./fakeVault";

let vault: FakeVault;
let db: any;
let ctx: SyncContext;
let state: SyncState;
let applier: ChangeApplier;
let breakerMessage: string | null;
let fileCount: number;

beforeEach(async () => {
    vault = new FakeVault();
    db = memoryDb();
    ctx = { app: vault.app, local: db, ignore: new IgnoreList(".obsidian/**"), log: () => {} };
    state = new SyncState(db);
    await state.load();
    breakerMessage = null;
    fileCount = 100;
    applier = new ChangeApplier(
        ctx,
        state,
        {
            onActivity: () => {},
            onBreakerTripped: (message) => {
                breakerMessage = message;
            },
        },
        () => fileCount
    );
});

afterEach(() => {
    applier.stop();
    state.dispose();
});

/** Waits for the live changes feed to settle on an expected condition. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("timed out waiting for the changes feed");
}

async function seedDocFromDisk(path: string): Promise<FileDoc> {
    const local = await readLocalFile(vault.adapter as any, path);
    if (!local) throw new Error(`missing ${path}`);
    const doc = buildDoc(local);
    const result = await db.put(doc);
    return { ...doc, _rev: result.rev };
}

/**
 * Mirrors what initialize() does: the feed resumes from the sequence reached by
 * reconcile, rather than replaying the database from the beginning.
 */
async function startFromNow(): Promise<void> {
    const info = await db.info();
    state.setSeq(info.update_seq);
    applier.start();
}

describe("applying incoming changes", () => {
    it("writes a new file into the vault", async () => {
        await startFromNow();
        await db.put({
            _id: pathToId("New.md"),
            path: "New.md",
            type: "text",
            ctime: 5,
            mtime: 5,
            size: 5,
            hash: await sha256("fresh"),
            data: "fresh",
        });
        await waitFor(() => vault.files.get("New.md")?.text === "fresh");
    });

    it("does nothing when the content already matches (the echo check)", async () => {
        vault.writeText("Note.md", "same");
        const doc = await seedDocFromDisk("Note.md");
        await startFromNow();

        // An echo of this device's own upload: same content, new revision.
        const before = vault.files.get("Note.md");
        await db.put({ ...doc, mtime: 4242 });
        await new Promise((resolve) => setTimeout(resolve, 150));

        expect(vault.files.get("Note.md")).toBe(before);
        expect([...vault.files.keys()].filter((p) => p.includes(".conflict-"))).toHaveLength(0);
    });

    it("overwrites a merely stale file without making a conflict copy", async () => {
        vault.writeText("Note.md", "v1");
        const doc = await seedDocFromDisk("Note.md");
        // The device knows v1 is what it last synced, so v2 is just an update.
        state.set("Note.md", await sha256("v1"));
        await startFromNow();

        await db.put({ ...doc, data: "v2", hash: await sha256("v2"), mtime: 9000 });
        await waitFor(() => vault.files.get("Note.md")?.text === "v2");

        const conflicts = [...vault.files.keys()].filter((p) => p.includes(".conflict-"));
        expect(conflicts).toHaveLength(0);
    });

    it("keeps a conflict copy when the local file diverged", async () => {
        vault.writeText("Note.md", "v1");
        const doc = await seedDocFromDisk("Note.md");
        await startFromNow();
        // Edited here and never uploaded: this content is in no revision, and no
        // synced hash was recorded for it either.
        vault.writeText("Note.md", "local only", 9000);
        state.forget("Note.md");

        await db.put({ ...doc, data: "remote", hash: await sha256("remote"), mtime: 9000 });
        await waitFor(() => vault.files.get("Note.md")?.text === "remote");

        const conflict = [...vault.files.keys()].find((p) => p.includes(".conflict-"));
        expect(conflict).toBeDefined();
        expect(vault.files.get(conflict as string)?.text).toBe("local only");
    });

    it("overwrites a stale file whose content is an earlier revision, with no state map", async () => {
        vault.writeText("Note.md", "v1");
        const doc = await seedDocFromDisk("Note.md");
        // A device that joined before the baseline was recorded, or whose local
        // database was rebuilt: the file is untouched, merely several edits behind.
        state.forget("Note.md");
        const before = (await db.info()).update_seq;

        const v2 = await db.put({ ...doc, data: "v2", hash: await sha256("v2"), mtime: 5000 });
        await db.put({ ...doc, _rev: v2.rev, data: "v3", hash: await sha256("v3"), mtime: 9000 });

        state.setSeq(before);
        applier.start();
        await waitFor(() => vault.files.get("Note.md")?.text === "v3");

        expect([...vault.files.keys()].filter((p) => p.includes(".conflict-"))).toHaveLength(0);
        expect(state.get("Note.md")).toBe(await sha256("v3"));
    });

    it("ignores documents whose path is on the ignore list", async () => {
        await startFromNow();
        await db.put({
            _id: pathToId(".obsidian/workspace.json"),
            path: ".obsidian/workspace.json",
            type: "text",
            ctime: 1,
            mtime: 1,
            size: 2,
            hash: await sha256("{}"),
            data: "{}",
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(vault.files.has(".obsidian/workspace.json")).toBe(false);
    });
});

describe("a device that joined through reconcile", () => {
    /**
     * The bug this guards: reconcile used to leave the state map empty, so the
     * first remote edit to any file the device already held looked like local
     * divergence and spawned a conflict copy nobody had edited.
     */
    it("takes a later remote edit without making a conflict copy", async () => {
        vault.writeText("Joined.md", "v1");
        const doc = await seedDocFromDisk("Joined.md");
        const report = await planReconcile(ctx, "merge");
        expect(report.actions.find((a) => a.path === "Joined.md")?.kind).toBe("skip");
        await applyReconcile(ctx, "merge", report, state);

        await startFromNow();
        await db.put({ ...doc, data: "v2", hash: await sha256("v2"), mtime: 9000 });
        await waitFor(() => vault.files.get("Joined.md")?.text === "v2");

        expect([...vault.files.keys()].filter((p) => p.includes(".conflict-"))).toHaveLength(0);
    });
});

describe("incoming deletes", () => {
    it("trashes a file whose content matches the tombstone", async () => {
        vault.writeText("Gone.md", "content");
        const doc = await seedDocFromDisk("Gone.md");
        await startFromNow();
        await db.put(buildTombstone(doc, "Gone.md"));
        await waitFor(() => vault.trashed.includes("Gone.md"));
        expect(vault.files.has("Gone.md")).toBe(false);
    });

    it("keeps a file that was edited after the remote delete", async () => {
        vault.writeText("Gone.md", "content");
        const doc = await seedDocFromDisk("Gone.md");
        await startFromNow();
        vault.writeText("Gone.md", "edited locally", 9000);
        await db.put(buildTombstone(doc, "Gone.md"));
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(vault.files.get("Gone.md")?.text).toBe("edited locally");
        expect(vault.trashed).toHaveLength(0);
    });
});

describe("guard D: bulk change circuit breaker", () => {
    it("stops sync when a burst of deletes arrives", async () => {
        fileCount = 100; // threshold is max(50, 20) = 50
        const docs: FileDoc[] = [];
        for (let i = 0; i < 60; i++) {
            const path = `Note${i}.md`;
            vault.writeText(path, `content ${i}`);
            docs.push(await seedDocFromDisk(path));
        }
        await startFromNow();
        for (const doc of docs) {
            await db.put(buildTombstone(doc, doc.path));
        }
        await waitFor(() => breakerMessage !== null, 4000);
        expect(breakerMessage).toContain("Sync stopped");
        // The breaker trips partway, so the vault is not emptied.
        expect(vault.trashed.length).toBeLessThan(60);
    });

    it("allows a small number of deletes through", async () => {
        fileCount = 100;
        const docs: FileDoc[] = [];
        for (let i = 0; i < 3; i++) {
            const path = `Note${i}.md`;
            vault.writeText(path, `content ${i}`);
            docs.push(await seedDocFromDisk(path));
        }
        await startFromNow();
        for (const doc of docs) {
            await db.put(buildTombstone(doc, doc.path));
        }
        await waitFor(() => vault.trashed.length === 3);
        expect(breakerMessage).toBeNull();
    });
});
