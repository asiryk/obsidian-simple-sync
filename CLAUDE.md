# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

An Obsidian plugin that syncs a vault with CouchDB, written as a small replacement for Self-hosted LiveSync. `README.md` covers the user-facing side (server config, CORS, BRAT install, release flow); this file covers what you need to change the code safely.

## Commands

```
npm run check            # typecheck + lint + unit tests — run this before committing
npm test                 # unit tests only (excludes the live suite)
npm run typecheck        # tsc --noEmit
npm run format           # biome check --write src test
npm run dev              # watch build
npm run build            # production bundle into main.js (gitignored)
npm run deploy           # build, then copy main.js + manifest.json into the vault
```

One test file or one test:

```
npx vitest run test/reconcile.test.ts
npx vitest run -t "keeps a conflict copy"
```

`npm run deploy` targets `/Volumes/knowledge-base/.obsidian/plugins/simple-sync` unless `SIMPLE_SYNC_VAULT_PLUGIN_DIR` is set — that vault holds real notes, so point the variable at a test vault when iterating.

`npm run test:live` exercises real replication and is skipped unless `SYNC_TEST_URL`, `SYNC_TEST_USER` and `SYNC_TEST_PASS` are set. It destroys and recreates `SYNC_TEST_DB` (default `sync_test`) and refuses any database name containing "knowledge".

## Architecture

Three independent parts, wired together in `main.ts`:

1. **Transport** — `PouchDB.sync(local, remote, { live: true, retry: true })` between an IndexedDB replica and CouchDB. iOS silently kills the handler on suspend, so `ensureAlive()` re-checks on `visibilitychange`, `online`, and a 60 s interval.
2. **Vault → database** (`watchVault.ts`) — Obsidian file events, debounced 1.5 s, write one document per file.
3. **Database → vault** (`applyChanges.ts`) — a live `changes()` feed writes files back.

Parts 2 and 3 do not know about each other. Loop prevention is purely content-hash comparison: an incoming document whose hash already matches the disk is a no-op, and a disk file whose hash already matches its document is a no-op. **Do not add echo-suppression or "was this my own write" state** — it is not needed and the README calls it out as a bug source.

`mapping.ts` is the file↔document boundary: `f:`-prefixed ids, SHA-256 hashes, text in `data` and binaries in `_attachments` (no chunking), and the `TEXT_EXTENSIONS` set that decides which is which.

`reconcile.ts` is the batch counterpart to the two live pumps — a whole-vault diff used by initialization and the manual dry run. `planReconcile` decides and returns a report, `applyReconcile` executes it; keeping those separate is what makes guard C's dry run honest, so never fold a decision into the apply step.

### Invariants and guards

`README.md` states four invariants and four guards (A identity, B initial mode, C dry run, D circuit breaker). They are not documentation of intent — each is load-bearing code in `reconcile.ts`, `applyChanges.ts`, `vaultIO.ts` and `safety.ts`, marked with `Invariant N:` / `Guard X` comments, and each has tests. Changing behaviour near one means updating the README, the comment, and the test together.

The subtle one is invariant 4 (never overwrite unsynced content). It rests on `SyncState` (`state.ts`): a per-device map of the hash each file had when last in sync, kept in a `_local/` document so it never replicates. A missing entry means "this device cannot vouch for what is on disk", which is why anything establishing a baseline — reconcile especially — must record hashes into it. When the map cannot answer, `applyChanges.ts` falls back to scanning the document's earlier revisions: content equal to a revision this device once held cannot be lost by overwriting it.

Conflicts never open a dialog. The loser is written beside the winner as `<name>.conflict-<timestamp>.<ext>`; that file appearing in the vault is the entire notification mechanism. A spurious conflict copy is therefore a real bug, not cosmetic noise — it propagates to every device.

Guard C's dry-run modal is the plugin's only modal. Errors go through `Notice`; everything else goes to the status bar or the debug log.

### Secrets

`secrets.ts` keeps the server password in `app.secretStorage`, which is encrypted by the system keychain. `minAppVersion` is 1.11.4 solely because that is the release the API landed in — lower it and the plugin loses the password on older clients. Availability of the API is not availability of a backend: `setSecret` throws on a platform without one, and `writePassword` returning false is what makes `saveSettings` fall back to writing the password into `data.json`. Never let a failure there drop the password silently. The in-memory `settings.password` stays the working value that `db.ts` and the QR use, and `startIfReady` re-reads secret storage because it may still have been loading when `onload` ran.

### Build and environment constraints

The bundle runs in Obsidian on desktop **and iOS**. `crypto.subtle` and `TextEncoder` are available; Node APIs are not. PouchDB is assembled from `pouchdb-core` plus explicit adapters in `db.ts` (never the `pouchdb` meta-package) and needs `src/shim.mjs`, injected by esbuild, to survive its CommonJS assumptions. `obsidian`, `electron`, `@codemirror/*` and `@lezer/*` are externals.

`events` in `dependencies` looks unused and is not: `pouchdb-core`, `pouchdb-replication` and `pouchdb-utils` require it for `EventEmitter`, which is what makes the replication handle and the changes feed emit at all. `platform: "browser"` means esbuild does not polyfill Node builtins, so the bare `events` specifier has to resolve from `node_modules`. Removing it fails the build. Same category as `shim.mjs` — do not prune either on the evidence of a grep over `src/`.

`main.js` is a build artifact, gitignored, shipped only as a release asset. Releases are driven by `npm version` (`preversion.mjs` rejects an already-tagged version, `version-bump.mjs` syncs `manifest.json` and `versions.json`) plus `git push --follow-tags`; the workflow refuses to publish when the tag and manifest disagree. Anything about a release that can fail belongs in `preversion.mjs`, which runs before any file is rewritten.

## Conventions

Comments explain *why* a piece of code exists — the failure it prevents, the platform quirk it works around — and are written as prose in the existing voice. Do not add comments that restate the code.

Tests use an in-memory PouchDB (`memoryDb()`) and `FakeVault`, a stand-in for Obsidian's adapter. When fixing a bug, confirm the new test fails against the unfixed source before considering it done.

Biome enforces 4-space indent, 110-column lines, double quotes, and semicolons; run `npm run format` rather than hand-matching style.

This is a solo repo — commit directly to `main`, no feature branches.
