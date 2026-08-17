import type { App } from "obsidian";
import { describe, expect, it } from "vitest";
import { readPassword, writePassword } from "../src/secrets";

/** Stands in for Obsidian's app.secretStorage, which the test stub has no runtime for. */
function appWithStorage(behaviour: "works" | "throws"): App {
    const secrets = new Map<string, string>();
    return {
        secretStorage: {
            getSecret: (id: string) => secrets.get(id) ?? null,
            setSecret: (id: string, secret: string) => {
                if (behaviour === "throws") throw new Error("Secure storage is not available.");
                secrets.set(id, secret);
            },
        },
    } as unknown as App;
}

describe("secrets", () => {
    it("round-trips the password through secret storage", () => {
        const app = appWithStorage("works");
        expect(readPassword(app)).toBeNull();

        expect(writePassword(app, "hunter2")).toBe(true);
        expect(readPassword(app)).toBe("hunter2");
    });

    it("reports failure when the platform has no secure backend", () => {
        const app = appWithStorage("throws");
        // False is what keeps the password in data.json instead of losing it.
        expect(writePassword(app, "hunter2")).toBe(false);
        expect(readPassword(app)).toBeNull();
    });
});
