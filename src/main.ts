import { Notice, Plugin } from "obsidian";
import { ChangeApplier } from "./applyChanges";
import { type AnyDB, checkConnection, openLocal, openRemote } from "./db";
import { IgnoreList } from "./ignore";
import {
    applyReconcile,
    describeReport,
    planReconcile,
    type SyncContext,
    unknownLocalFiles,
} from "./reconcile";
import {
    bulkChangeWarning,
    newSyncId,
    pullPreconditionFailure,
    readMeta,
    verifyIdentity,
    writeMeta,
} from "./safety";
import { SimpleSyncSettingTab } from "./settings";
import { decodeSetup, SETUP_ACTION } from "./setupQR";
import { SyncState } from "./state";
import { DEFAULT_SETTINGS, type InitMode, type SyncSettings } from "./types";
import { confirm } from "./ui";
import { listVaultFiles } from "./vaultIO";
import { VaultWatcher } from "./watchVault";

type Status = "off" | "setup" | "idle" | "syncing" | "error";

export default class SimpleSyncPlugin extends Plugin {
    override settings: SyncSettings = { ...DEFAULT_SETTINGS };
    private local: AnyDB | null = null;
    private remote: AnyDB | null = null;
    private replication: any = null;
    private watcher: VaultWatcher | null = null;
    private applier: ChangeApplier | null = null;
    private state: SyncState | null = null;
    private ignore = new IgnoreList(DEFAULT_SETTINGS.ignore);
    private statusBar: HTMLElement | null = null;
    private status: Status = "off";
    private up = 0;
    private down = 0;
    private cachedFileCount = 0;
    private watchdog: number | null = null;

    override async onload(): Promise<void> {
        await this.loadSettings();
        this.ignore = new IgnoreList(this.settings.ignore);
        this.statusBar = this.addStatusBarItem();
        this.addSettingTab(new SimpleSyncSettingTab(this.app, this));

        this.registerObsidianProtocolHandler(SETUP_ACTION, (params) => {
            void this.applySetupUri(params.config);
        });

        this.addCommand({
            id: "sync-now",
            name: "Sync now",
            callback: () => void this.syncNow(),
        });
        this.addCommand({
            id: "reconcile-dry-run",
            name: "Full reconcile (dry run)",
            callback: () => void this.reconcileInteractive(),
        });
        this.addCommand({
            id: "toggle-sync",
            name: "Toggle sync",
            callback: () => void this.toggleSync(),
        });
        this.addCommand({
            id: "show-setup-qr",
            name: "Show setup QR",
            callback: () => void this.showSetupQR(),
        });

        this.app.workspace.onLayoutReady(() => {
            void this.startIfReady();
        });

        // iOS suspends the app and silently kills the replication handler, so
        // retry:true alone is not enough. Re-check whenever we come back.
        this.registerDomEvent(document, "visibilitychange", () => {
            if (document.visibilityState === "visible") void this.ensureAlive();
        });
        this.registerDomEvent(window, "online", () => void this.ensureAlive());
        this.watchdog = window.setInterval(() => void this.ensureAlive(), 60000);
        this.registerInterval(this.watchdog);

        this.setStatus(this.settings.initialized ? "off" : "setup");
    }

    override async onunload(): Promise<void> {
        await this.teardown();
    }

    // ---------------------------------------------------------------- settings

    async loadSettings(): Promise<void> {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    reloadIgnore(): void {
        this.ignore = new IgnoreList(this.settings.ignore);
        if (this.context) this.context.ignore = this.ignore;
    }

    private context: SyncContext | null = null;

    private log = (message: string): void => {
        if (this.settings.debug) console.log(`[simple-sync] ${message}`);
    };

    private notifyError(message: string): void {
        console.error(`[simple-sync] ${message}`);
        new Notice(`Simple Sync: ${message}`, 10000);
    }

    // ------------------------------------------------------------------ status

    private setStatus(status: Status): void {
        this.status = status;
        this.renderStatus();
    }

    private renderStatus(): void {
        if (!this.statusBar) return;
        const labels: Record<Status, string> = {
            off: "sync off",
            setup: "sync setup",
            idle: "sync",
            syncing: "sync",
            error: "sync err",
        };
        let text = labels[this.status];
        if (this.status === "idle" || this.status === "syncing") {
            const parts: string[] = [];
            if (this.up > 0) parts.push(`↑${this.up}`);
            if (this.down > 0) parts.push(`↓${this.down}`);
            if (parts.length > 0) text = `sync ${parts.join(" ")}`;
        }
        this.statusBar.setText(text);
    }

    private noteActivity(direction: "up" | "down"): void {
        if (direction === "up") this.up++;
        else this.down++;
        this.renderStatus();
        window.setTimeout(() => {
            if (direction === "up") this.up = Math.max(0, this.up - 1);
            else this.down = Math.max(0, this.down - 1);
            this.renderStatus();
        }, 3000);
    }

    // ------------------------------------------------------------- lifecycle

    private buildContext(): SyncContext {
        if (!this.local) throw new Error("local database is not open");
        return { app: this.app, local: this.local, ignore: this.ignore, log: this.log };
    }

    private async openLocalDb(): Promise<void> {
        if (this.local) return;
        this.local = openLocal(this.app.vault.getName());
        this.state = new SyncState(this.local);
        await this.state.load();
        this.context = this.buildContext();
    }

    /** Starts sync only when the vault has joined and identity still checks out. */
    private async startIfReady(): Promise<void> {
        if (!this.settings.initialized || !this.settings.enabled) {
            this.setStatus(this.settings.initialized ? "off" : "setup");
            return;
        }
        try {
            await this.openLocalDb();
            this.remote = openRemote(this.settings);

            const verdict = await verifyIdentity(this.remote, this.settings);
            if (!verdict.ok) {
                this.setStatus("error");
                this.notifyError(verdict.reason);
                await this.stopSync();
                return;
            }

            this.cachedFileCount = (await listVaultFiles(this.app, this.ignore)).length;
            this.startPumps();
            this.startReplication();
            this.setStatus("idle");
        } catch (error: any) {
            this.setStatus("error");
            this.log(`start failed: ${error?.message ?? error}`);
        }
    }

    private startPumps(): void {
        const ctx = this.context;
        const state = this.state;
        if (!ctx || !state) return;

        if (!this.watcher) {
            this.watcher = new VaultWatcher(this, ctx, state, () => this.noteActivity("up"));
            this.watcher.start();
        }
        if (!this.applier) {
            this.applier = new ChangeApplier(
                ctx,
                state,
                {
                    onActivity: () => this.noteActivity("down"),
                    onBreakerTripped: (message) => {
                        this.setStatus("error");
                        this.notifyError(message);
                        void this.stopSync();
                    },
                },
                () => this.cachedFileCount,
            );
            this.applier.start();
        }
    }

    private startReplication(): void {
        if (this.replication || !this.local || !this.remote) return;
        this.replication = this.local
            .sync(this.remote, { live: true, retry: true })
            .on("change", () => {
                if (this.status !== "error") this.setStatus("syncing");
            })
            .on("paused", () => {
                if (this.status !== "error") this.setStatus("idle");
            })
            .on("active", () => {
                if (this.status !== "error") this.setStatus("syncing");
            })
            .on("denied", (error: any) => {
                this.log(`replication denied: ${JSON.stringify(error)}`);
            })
            .on("error", (error: any) => {
                this.setStatus("error");
                this.log(`replication error: ${error?.message ?? error}`);
            });
    }

    /** Restarts replication if the handler died while the app was suspended. */
    private async ensureAlive(): Promise<void> {
        if (!this.settings.initialized || !this.settings.enabled) return;
        if (this.status === "error") return;
        if (!this.local || !this.remote) {
            await this.startIfReady();
            return;
        }
        if (!this.replication) {
            this.startReplication();
            return;
        }
        try {
            await this.remote.info();
        } catch {
            this.log("remote unreachable; restarting replication");
            this.restartReplication();
        }
    }

    private restartReplication(): void {
        if (this.replication) {
            try {
                this.replication.cancel();
            } catch {
                // Already dead.
            }
            this.replication = null;
        }
        this.startReplication();
    }

    private async stopSync(): Promise<void> {
        if (this.replication) {
            try {
                this.replication.cancel();
            } catch {
                // Already dead.
            }
            this.replication = null;
        }
        this.applier?.stop();
        this.applier = null;
        this.watcher?.stop();
        this.watcher = null;
        await this.state?.flush();
        if (this.remote) {
            await this.remote.close().catch(() => {});
            this.remote = null;
        }
    }

    private async teardown(): Promise<void> {
        await this.stopSync();
        this.state?.dispose();
        await this.state?.flush();
        if (this.local) {
            await this.local.close().catch(() => {});
            this.local = null;
        }
        this.context = null;
        this.state = null;
    }

    async applyEnabledState(): Promise<void> {
        if (this.settings.enabled) {
            await this.startIfReady();
        } else {
            await this.stopSync();
            this.setStatus("off");
        }
    }

    private async toggleSync(): Promise<void> {
        this.settings.enabled = !this.settings.enabled;
        await this.saveSettings();
        await this.applyEnabledState();
    }

    // -------------------------------------------------------------- commands

    private async syncNow(): Promise<void> {
        if (!this.settings.initialized) {
            new Notice("Simple Sync: set up this vault first.");
            return;
        }
        await this.watcher?.flushAll();
        await this.ensureAlive();
        if (this.local && this.remote) {
            try {
                await this.local.replicate.to(this.remote);
                await this.local.replicate.from(this.remote);
            } catch (error: any) {
                this.log(`manual sync failed: ${error?.message ?? error}`);
            }
        }
    }

    private async showSetupQR(): Promise<void> {
        const { SetupQRModal } = await import("./setupQR");
        new SetupQRModal(this.app, this.settings).open();
    }

    private async applySetupUri(config: string | undefined): Promise<void> {
        if (!config) return;
        const portable = decodeSetup(config);
        if (!portable) {
            this.notifyError("That setup link could not be read.");
            return;
        }
        const proceed = await confirm(
            this.app,
            "Apply sync settings?",
            `Server:   ${portable.url}\nDatabase: ${portable.database}\nUser:     ${portable.username}`,
            "Apply",
            this.settings.initialized
                ? "This vault is already set up. Applying will reset its setup, and you will choose how it rejoins."
                : null,
        );
        if (!proceed) return;

        await this.stopSync();
        Object.assign(this.settings, portable);
        this.settings.initialized = false;
        this.settings.initMode = "";
        this.settings.syncId = "";
        await this.saveSettings();
        this.reloadIgnore();
        this.setStatus("setup");
        new Notice("Simple Sync: settings applied. Choose how this vault joins in the plugin settings.");
    }

    // ---------------------------------------------------------- initialization

    /**
     * Guard B and Guard C live here. Nothing syncs until this has run once, and
     * this never writes anything before the dry-run report has been accepted.
     */
    async initialize(mode: InitMode): Promise<void> {
        const check = await checkConnection(this.settings);
        if (!check.ok) {
            this.notifyError(check.message);
            return;
        }

        await this.openLocalDb();
        const remote = openRemote(this.settings);

        try {
            const meta = await readMeta(remote);

            if (mode === "push" && meta) {
                const overwrite = await confirm(
                    this.app,
                    "Database is already in use",
                    `This database is marked as belonging to "${meta.vaultName}", initialized ${meta.initializedAt.slice(0, 10)}.\n\n` +
                        "Push mode will make the server match this vault, replacing what is there.",
                    "Replace it",
                    "Another vault already syncs with this database. Continuing will disrupt it.",
                );
                if (!overwrite) return;
            }

            if (mode !== "push" && !meta) {
                this.notifyError(
                    "This database has no sync marker, so there is nothing to pull. Initialize the first device with Push.",
                );
                return;
            }

            // Pull the remote state locally so the plan is computed against real data.
            this.setStatus("syncing");
            await this.local?.replicate.from(remote);

            const ctx = this.buildContext();

            if (mode === "pull") {
                const unknown = await unknownLocalFiles(ctx);
                const failure = pullPreconditionFailure(unknown);
                if (failure) {
                    this.setStatus("setup");
                    this.notifyError(failure);
                    return;
                }
            }

            const report = await planReconcile(ctx, mode);
            const warning = bulkChangeWarning(report);
            const accepted = await confirm(
                this.app,
                "Review before syncing",
                describeReport(report, mode),
                "Apply",
                warning,
            );
            if (!accepted) {
                this.setStatus("setup");
                return;
            }

            await applyReconcile(ctx, mode, report, this.state as SyncState);

            const syncId = mode === "push" || !meta ? newSyncId() : meta.syncId;
            if (mode === "push" || !meta) {
                await writeMeta(this.local as AnyDB, this.app.vault.getName(), syncId);
            }
            await this.local?.replicate.to(remote);
            await this.local?.replicate.from(remote);

            this.settings.initialized = true;
            this.settings.initMode = mode;
            this.settings.initializedAt = new Date().toISOString();
            this.settings.syncId = syncId;
            this.settings.enabled = true;
            const info = await this.local?.info();
            this.state?.setSeq(info?.update_seq ?? 0);
            await this.state?.flush();
            await this.saveSettings();

            new Notice(
                `Simple Sync: initialized (${mode}). ` +
                    `${report.counts.upload} up, ${report.counts.download} down, ${report.counts.conflict} conflicts.`,
            );
            await this.startIfReady();
        } catch (error: any) {
            this.setStatus("error");
            this.notifyError(`Initialization failed: ${error?.message ?? error}`);
        } finally {
            await remote.close().catch(() => {});
        }
    }

    async resetInitialization(): Promise<void> {
        await this.stopSync();
        this.settings.initialized = false;
        this.settings.initMode = "";
        this.settings.syncId = "";
        await this.saveSettings();
        this.setStatus("setup");
    }

    private async reconcileInteractive(): Promise<void> {
        if (!this.settings.initialized) {
            new Notice("Simple Sync: set up this vault first.");
            return;
        }
        try {
            await this.openLocalDb();
            const ctx = this.buildContext();
            const report = await planReconcile(ctx, "merge");
            const warning = bulkChangeWarning(report);
            const accepted = await confirm(
                this.app,
                "Reconcile (dry run)",
                describeReport(report, "merge"),
                "Apply",
                warning,
            );
            if (!accepted) return;
            await applyReconcile(ctx, "merge", report, this.state as SyncState);
            await this.state?.flush();
            new Notice(
                `Simple Sync: reconciled. ${report.counts.upload} up, ` +
                    `${report.counts.download} down, ${report.counts.conflict} conflicts.`,
            );
        } catch (error: any) {
            this.notifyError(`Reconcile failed: ${error?.message ?? error}`);
        }
    }
}
