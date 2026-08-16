import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IgnoreList } from "../src/ignore";
import { buildDoc, buildTombstone, pathToId, readLocalFile, sha256 } from "../src/mapping";
import { applyReconcile, planReconcile, unknownLocalFiles, type SyncContext } from "../src/reconcile";
import { newSyncId, readMeta, verifyIdentity, writeMeta } from "../src/safety";
import { DEFAULT_SETTINGS, type FileDoc } from "../src/types";
import { bytes, FakeVault, httpDb, memoryDb } from "./fakeVault";

/**
 * Exercises the real replication path against a live CouchDB.
 *
 * Opt-in: set SYNC_TEST_URL, SYNC_TEST_USER, SYNC_TEST_PASS. It creates and drops
 * its own database (SYNC_TEST_DB, default "sync_test") and must never be pointed
 * at a database holding real notes.
 */
const url = process.env.SYNC_TEST_URL;
const user = process.env.SYNC_TEST_USER;
const pass = process.env.SYNC_TEST_PASS;
const dbName = process.env.SYNC_TEST_DB ?? "sync_test";
const enabled = Boolean(url && user && pass);

const remoteUrl = `${(url ?? "").replace(/\/+$/, "")}/${dbName}`;
const auth = { username: user ?? "", password: pass ?? "" };

function ctxFor(vault: FakeVault, db: any): SyncContext {
    return { app: vault.app, local: db, ignore: new IgnoreList(".obsidian/**"), log: () => {} };
}

describe.skipIf(!enabled)("live CouchDB replication", () => {
    let remote: any;

    beforeAll(async () => {
        if (dbName.includes("knowledge")) {
            throw new Error(`refusing to run against "${dbName}"`);
        }
        remote = httpDb(remoteUrl, auth);
        await remote.destroy().catch(() => {});
        remote = httpDb(remoteUrl, auth);
        await remote.info();
    }, 60000);

    afterAll(async () => {
        await remote?.destroy().catch(() => {});
    });

    it("reaches the server with the configured credentials", async () => {
        const info = await remote.info();
        expect(info.db_name).toBe(dbName);
    });

    it("carries a full vault from one device to another", async () => {
        // Device A: a vault with notes and a binary, initialized in push mode.
        const vaultA = new FakeVault("A");
        const dbA = memoryDb();
        vaultA.writeText("Journal/2026-08-16.md", "# Today\nnotes");
        vaultA.writeText("Reading List.md", "- a book");
        vaultA.writeBin("Assets/pic.avif", bytes(9, 8, 7, 6));
        const ctxA = ctxFor(vaultA, dbA);

        const planA = await planReconcile(ctxA, "push");
        expect(planA.counts.upload).toBe(3);
        expect(planA.counts.download).toBe(0);
        await applyReconcile(ctxA, "push", planA);

        const syncId = newSyncId();
        await writeMeta(dbA, "A", syncId);
        await dbA.replicate.to(remote);

        // Device B: an empty vault, initialized in pull mode.
        const vaultB = new FakeVault("B");
        const dbB = memoryDb();
        const ctxB = ctxFor(vaultB, dbB);
        await dbB.replicate.from(remote);

        expect(await unknownLocalFiles(ctxB)).toEqual([]);
        const verdict = await verifyIdentity(dbB, { ...DEFAULT_SETTINGS, syncId });
        expect(verdict.ok).toBe(true);

        const planB = await planReconcile(ctxB, "pull");
        expect(planB.counts.download).toBe(3);
        await applyReconcile(ctxB, "pull", planB);

        expect(vaultB.files.get("Journal/2026-08-16.md")?.text).toBe("# Today\nnotes");
        expect(vaultB.files.get("Reading List.md")?.text).toBe("- a book");
        expect(new Uint8Array(vaultB.files.get("Assets/pic.avif")?.binary as ArrayBuffer)).toEqual(
            new Uint8Array([9, 8, 7, 6])
        );
    }, 60000);

    it("propagates an edit and a delete back the other way", async () => {
        const vaultA = new FakeVault("A");
        const dbA = memoryDb();
        vaultA.writeText("Shared.md", "v1");
        vaultA.writeText("Doomed.md", "delete me");
        const ctxA = ctxFor(vaultA, dbA);
        await applyReconcile(ctxA, "push", await planReconcile(ctxA, "push"));
        await dbA.replicate.to(remote);

        const vaultB = new FakeVault("B");
        const dbB = memoryDb();
        const ctxB = ctxFor(vaultB, dbB);
        await dbB.replicate.from(remote);
        await applyReconcile(ctxB, "merge", await planReconcile(ctxB, "merge"));
        expect(vaultB.files.get("Shared.md")?.text).toBe("v1");

        // B edits one file and deletes another, then pushes.
        vaultB.writeText("Shared.md", "v2 from B", 9000);
        const edited = await readLocalFile(vaultB.adapter as any, "Shared.md");
        const existing = (await dbB.get(pathToId("Shared.md"))) as FileDoc;
        await dbB.put(buildDoc(edited as any, existing));

        const doomed = (await dbB.get(pathToId("Doomed.md"))) as FileDoc;
        await dbB.put(buildTombstone(doomed, "Doomed.md"));
        vaultB.files.delete("Doomed.md");
        await dbB.replicate.to(remote);

        // A pulls and converges.
        await dbA.replicate.from(remote);
        await applyReconcile(ctxA, "merge", await planReconcile(ctxA, "merge"));

        expect(vaultA.files.get("Shared.md")?.text).toBe("v2 from B");
        expect(vaultA.files.has("Doomed.md")).toBe(false);
        expect(vaultA.trashed).toContain("Doomed.md");
    }, 60000);

    it("stores a real binary as an attachment the server can serve back", async () => {
        const vault = new FakeVault("A");
        const db = memoryDb();
        const payload = new Uint8Array(4096).map((_, i) => i % 251);
        vault.writeBin("Assets/big.pdf", payload.buffer);
        const ctx = ctxFor(vault, db);
        await applyReconcile(ctx, "push", await planReconcile(ctx, "push"));
        await db.replicate.to(remote);

        const fresh = memoryDb();
        await fresh.replicate.from(remote);
        const doc = (await fresh.get(pathToId("Assets/big.pdf"), { attachments: true })) as FileDoc;
        expect(doc.type).toBe("bin");
        expect(doc.hash).toBe(await sha256(payload.buffer));
    }, 60000);

    it("keeps the marker document so guard A can identify the group later", async () => {
        const meta = await readMeta(remote);
        expect(meta).not.toBeNull();
        const foreign = await verifyIdentity(remote, { ...DEFAULT_SETTINGS, syncId: "not-the-one" });
        expect(foreign.ok).toBe(false);
    }, 60000);
});
