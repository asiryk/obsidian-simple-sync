import type { App } from "obsidian";
import { describe, expect, it } from "vitest";
import { PASSWORD_SECRET, readSecret, USERNAME_SECRET, writeSecret } from "../src/secrets";

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
    it("round-trips a value through secret storage", () => {
        const app = appWithStorage("works");
        expect(readSecret(app, PASSWORD_SECRET)).toBeNull();

        expect(writeSecret(app, PASSWORD_SECRET, "hunter2")).toBe(true);
        expect(readSecret(app, PASSWORD_SECRET)).toBe("hunter2");
    });

    it("keeps username and password in separate entries", () => {
        const app = appWithStorage("works");
        writeSecret(app, USERNAME_SECRET, "admin");
        writeSecret(app, PASSWORD_SECRET, "hunter2");

        expect(readSecret(app, USERNAME_SECRET)).toBe("admin");
        expect(readSecret(app, PASSWORD_SECRET)).toBe("hunter2");
    });

    it("reports failure when the platform has no secure backend", () => {
        const app = appWithStorage("throws");
        // False is what keeps the credentials in data.json instead of losing them.
        expect(writeSecret(app, PASSWORD_SECRET, "hunter2")).toBe(false);
        expect(readSecret(app, PASSWORD_SECRET)).toBeNull();
    });
});
