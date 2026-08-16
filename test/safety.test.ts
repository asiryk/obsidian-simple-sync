import { describe, expect, it } from "vitest";
import { IgnoreList } from "../src/ignore";
import { conflictPathFor } from "../src/vaultIO";
import { buildDoc, buildTombstone, extensionOf, isTextPath, pathToId, idToPath, sha256 } from "../src/mapping";
import { bulkChangeWarning, newSyncId, pullPreconditionFailure, verifyIdentity, writeMeta } from "../src/safety";
import { decodeSetup, encodeSetup, setupUri } from "../src/setupQR";
import { DEFAULT_SETTINGS, type ReconcileReport, type SyncSettings } from "../src/types";
import { memoryDb } from "./fakeVault";

function report(counts: Partial<ReconcileReport["counts"]>, vaultFileCount: number): ReconcileReport {
    return {
        actions: [],
        counts: { upload: 0, download: 0, "delete-local": 0, conflict: 0, skip: 0, ...counts },
        vaultFileCount,
    };
}

describe("guard A: vault identity", () => {
    it("refuses a database with no marker", async () => {
        const db = memoryDb();
        const settings: SyncSettings = { ...DEFAULT_SETTINGS, syncId: "abc" };
        const verdict = await verifyIdentity(db, settings);
        expect(verdict.ok).toBe(false);
        if (!verdict.ok) expect(verdict.reason).toContain("no sync marker");
    });

    it("refuses a database belonging to a different sync group", async () => {
        const db = memoryDb();
        await writeMeta(db, "someone-elses-vault", "their-id");
        const settings: SyncSettings = { ...DEFAULT_SETTINGS, syncId: "my-id" };
        const verdict = await verifyIdentity(db, settings);
        expect(verdict.ok).toBe(false);
        if (!verdict.ok) expect(verdict.reason).toContain("someone-elses-vault");
    });

    it("accepts a matching marker", async () => {
        const db = memoryDb();
        const id = newSyncId();
        await writeMeta(db, "my-vault", id);
        const verdict = await verifyIdentity(db, { ...DEFAULT_SETTINGS, syncId: id });
        expect(verdict.ok).toBe(true);
    });

    it("rewrites the marker without a revision conflict", async () => {
        const db = memoryDb();
        await writeMeta(db, "v", "one");
        const second = await writeMeta(db, "v", "two");
        expect(second.syncId).toBe("two");
    });
});

describe("guard B: pull preconditions", () => {
    it("passes for an empty vault", () => {
        expect(pullPreconditionFailure([])).toBeNull();
    });

    it("refuses and names the offending files", () => {
        const message = pullPreconditionFailure(["A.md", "B.md"]);
        expect(message).toContain("A.md");
        expect(message).toContain("2 file(s)");
    });

    it("summarises rather than listing everything", () => {
        const files = Array.from({ length: 20 }, (_, i) => `F${i}.md`);
        expect(pullPreconditionFailure(files)).toContain("and 15 more");
    });
});

describe("guard D: bulk change warning", () => {
    it("stays quiet for a routine plan", () => {
        expect(bulkChangeWarning(report({ download: 3 }, 200))).toBeNull();
    });

    it("stays quiet when nothing destructive is planned", () => {
        expect(bulkChangeWarning(report({ upload: 5000 }, 5000))).toBeNull();
    });

    it("warns when most of the vault would be rewritten", () => {
        const warning = bulkChangeWarning(report({ "delete-local": 180 }, 200));
        expect(warning).toContain("180 of 200");
    });

    it("uses the absolute floor for small vaults", () => {
        // 20% of 10 is 2, but fewer than 50 files is never alarming.
        expect(bulkChangeWarning(report({ download: 9 }, 10))).toBeNull();
    });
});

describe("ignore list", () => {
    const ignore = new IgnoreList(".git/**\n.obsidian\n*.tmp\n# a comment\n\n.DS_Store");

    it("matches glob patterns", () => {
        expect(ignore.matches(".git/config")).toBe(true);
        expect(ignore.matches("notes/scratch.tmp")).toBe(true);
    });

    it("treats a bare folder name as the whole subtree", () => {
        expect(ignore.matches(".obsidian")).toBe(true);
        expect(ignore.matches(".obsidian/workspace.json")).toBe(true);
        expect(ignore.matches(".obsidian/plugins/x/main.js")).toBe(true);
    });

    it("matches dotfiles anywhere", () => {
        expect(ignore.matches(".DS_Store")).toBe(true);
    });

    it("leaves ordinary notes alone", () => {
        expect(ignore.matches("Journal/2026-08-16.md")).toBe(false);
        expect(ignore.matches("Assets/pic.avif")).toBe(false);
    });

    it("skips comments and blank lines", () => {
        expect(ignore.matches("a comment")).toBe(false);
    });
});

describe("path and document mapping", () => {
    it("prefixes ids so a leading underscore is never reserved", () => {
        expect(pathToId("_template.md")).toBe("f:_template.md");
        expect(idToPath(pathToId("_template.md"))).toBe("_template.md");
    });

    it("preserves case", () => {
        expect(idToPath(pathToId("Journal/Note.MD"))).toBe("Journal/Note.MD");
    });

    it("classifies text and binary extensions", () => {
        expect(isTextPath("a.md")).toBe(true);
        expect(isTextPath("a.canvas")).toBe(true);
        expect(isTextPath("a.avif")).toBe(false);
        expect(isTextPath("noextension")).toBe(false);
        expect(extensionOf(".DS_Store")).toBe("");
    });

    it("hashes deterministically and distinctly", async () => {
        expect(await sha256("hello")).toBe(await sha256("hello"));
        expect(await sha256("hello")).not.toBe(await sha256("hellp"));
    });

    it("keeps the deleted content hash on a tombstone", async () => {
        const doc = buildDoc({
            path: "A.md",
            type: "text",
            hash: await sha256("body"),
            mtime: 1,
            ctime: 1,
            size: 4,
            text: "body",
        });
        const tombstone = buildTombstone(doc, "A.md");
        expect(tombstone.deleted).toBe(true);
        expect(tombstone.deletedHash).toBe(doc.hash);
        expect(tombstone.data).toBeUndefined();
    });

    it("names conflict copies beside the original, keeping the extension", () => {
        const path = conflictPathFor("Journal/Note.md");
        expect(path.startsWith("Journal/Note.conflict-")).toBe(true);
        expect(path.endsWith(".md")).toBe(true);
    });
});

describe("setup link", () => {
    it("round-trips the portable settings", () => {
        const settings: SyncSettings = {
            ...DEFAULT_SETTINGS,
            url: "https://example.net",
            username: "admin",
            password: "p@ss/w+rd=",
            database: "knowledge_base",
        };
        const decoded = decodeSetup(encodeSetup(settings));
        expect(decoded).toEqual({
            url: "https://example.net",
            username: "admin",
            password: "p@ss/w+rd=",
            database: "knowledge_base",
            ignore: settings.ignore,
        });
    });

    it("produces a URL the phone's camera can hand to Obsidian", () => {
        const uri = setupUri({ ...DEFAULT_SETTINGS, url: "https://e.net", database: "d" });
        const prefix = "obsidian://simple-sync-setup?config=";
        expect(uri.startsWith(prefix)).toBe(true);
        // The payload must be base64url, or the camera hand-off mangles it.
        expect(uri.slice(prefix.length)).not.toMatch(/[+/=]/);
    });

    it("rejects rubbish rather than half-applying it", () => {
        expect(decodeSetup("not-base64!!")).toBeNull();
        expect(decodeSetup(btoa('{"nope":1}'))).toBeNull();
    });
});
