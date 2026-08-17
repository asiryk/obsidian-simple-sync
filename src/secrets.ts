import type { App } from "obsidian";

/** Must match Obsidian's id rule: lowercase alphanumeric and dashes, ≤64 chars. */
const SECRET_ID = "simple-sync-password";

/**
 * The server password lives in `app.secretStorage`, not in the plugin's
 * `data.json`. On desktop that is Electron's safeStorage, so the value is
 * encrypted with an OS keychain key; on mobile it is the platform keychain.
 * Both are per-vault, and the entry is visible under Obsidian's own settings.
 *
 * `manifest.json` requires 1.11.4 for exactly this API. What that does not
 * guarantee is a working backend underneath it — `setSecret` throws "Secure
 * storage is not available" on a platform without one, so a write has to be
 * treated as something that can fail rather than something that can be assumed.
 */

/** Returns null when there is nothing stored, so "" stays distinguishable. */
export function readPassword(app: App): string | null {
    try {
        return app.secretStorage.getSecret(SECRET_ID);
    } catch {
        return null;
    }
}

/**
 * Returns true once the password is safely in secret storage, which is the
 * caller's signal that it must be left out of `data.json`. A false return means
 * the platform has no secure backend, and the settings file is the only place
 * left to keep it.
 */
export function writePassword(app: App, password: string): boolean {
    try {
        app.secretStorage.setSecret(SECRET_ID, password);
        return true;
    } catch {
        return false;
    }
}
