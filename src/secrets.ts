import type { App } from "obsidian";

/** Ids must match Obsidian's rule: lowercase alphanumeric and dashes, ≤64 chars. */
export const USERNAME_SECRET = "simple-sync-username";
export const PASSWORD_SECRET = "simple-sync-password";

/**
 * The server credentials live in `app.secretStorage`, not in the plugin's
 * `data.json`. On desktop that is Electron's safeStorage, so the value is
 * encrypted with an OS keychain key; on mobile it is the platform keychain.
 * Both are per-vault, and the entries are visible under Obsidian's own settings.
 *
 * Username and password are separate entries rather than one JSON blob so that
 * what a person sees in that settings panel is a username and a password, which
 * is also what they can safely correct there.
 *
 * `manifest.json` requires 1.11.4 for exactly this API. What that does not
 * guarantee is a working backend underneath it — `setSecret` throws "Secure
 * storage is not available" on a platform without one, so a write has to be
 * treated as something that can fail rather than something that can be assumed.
 */

/** Returns null when there is nothing stored, so "" stays distinguishable. */
export function readSecret(app: App, id: string): string | null {
    try {
        return app.secretStorage.getSecret(id);
    } catch {
        return null;
    }
}

/**
 * Returns true once the value is safely in secret storage, which is the caller's
 * signal that it must be left out of `data.json`. A false return means the
 * platform has no secure backend, and the settings file is the only place left
 * to keep it.
 */
export function writeSecret(app: App, id: string, value: string): boolean {
    try {
        app.secretStorage.setSecret(id, value);
        return true;
    } catch {
        return false;
    }
}
