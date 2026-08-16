import { type App, PluginSettingTab, Setting } from "obsidian";
import { checkConnection } from "./db";
import type SimpleSyncPlugin from "./main";
import { SetupQRModal } from "./setupQR";
import type { InitMode } from "./types";

export class SimpleSyncSettingTab extends PluginSettingTab {
    constructor(
        app: App,
        private plugin: SimpleSyncPlugin,
    ) {
        super(app, plugin);
    }

    override display(): void {
        const { containerEl } = this;
        containerEl.empty();
        const settings = this.plugin.settings;

        new Setting(containerEl).setName("Server URL").addText((text) =>
            text
                .setPlaceholder("https://couchdb.example.net")
                .setValue(settings.url)
                .onChange(async (value) => {
                    settings.url = value.trim();
                    await this.plugin.saveSettings();
                }),
        );

        new Setting(containerEl).setName("Username").addText((text) =>
            text.setValue(settings.username).onChange(async (value) => {
                settings.username = value.trim();
                await this.plugin.saveSettings();
            }),
        );

        new Setting(containerEl).setName("Password").addText((text) => {
            text.inputEl.type = "password";
            text.setValue(settings.password).onChange(async (value) => {
                settings.password = value;
                await this.plugin.saveSettings();
            });
        });

        new Setting(containerEl).setName("Database").addText((text) =>
            text
                .setPlaceholder("knowledge_base")
                .setValue(settings.database)
                .onChange(async (value) => {
                    settings.database = value.trim();
                    await this.plugin.saveSettings();
                }),
        );

        new Setting(containerEl)
            .setName("Ignore")
            .setDesc("One glob per line.")
            .addTextArea((area) => {
                area.inputEl.rows = 7;
                area.inputEl.style.width = "100%";
                area.setValue(settings.ignore).onChange(async (value) => {
                    settings.ignore = value;
                    await this.plugin.saveSettings();
                    this.plugin.reloadIgnore();
                });
            });

        const status = containerEl.createEl("p");
        status.style.minHeight = "1.4em";
        status.style.fontSize = "0.9em";

        new Setting(containerEl)
            .addButton((button) =>
                button.setButtonText("Test connection").onClick(async () => {
                    status.setText("Checking...");
                    const result = await checkConnection(this.plugin.settings);
                    status.setText(result.message);
                    status.style.color = result.ok ? "var(--text-success)" : "var(--text-error)";
                }),
            )
            .addButton((button) =>
                button.setButtonText("Show setup QR").onClick(() => {
                    new SetupQRModal(this.app, this.plugin.settings).open();
                }),
            );

        containerEl.createEl("h4", { text: "Setup" });

        if (settings.initialized) {
            new Setting(containerEl)
                .setName(`Initialized ${settings.initializedAt.slice(0, 10)} as ${settings.initMode}`)
                .setDesc("Reset only if this vault should rejoin from scratch. It does not delete anything.")
                .addButton((button) =>
                    button
                        .setButtonText("Reset")
                        .setWarning()
                        .onClick(async () => {
                            await this.plugin.resetInitialization();
                            this.display();
                        }),
                );

            new Setting(containerEl).setName("Sync enabled").addToggle((toggle) =>
                toggle.setValue(settings.enabled).onChange(async (value) => {
                    settings.enabled = value;
                    await this.plugin.saveSettings();
                    await this.plugin.applyEnabledState();
                }),
            );
        } else {
            const explain = containerEl.createEl("p", {
                text:
                    "This vault has not joined yet, and nothing will sync until it does. " +
                    "Choose how it joins. Every option shows a dry-run report first.",
            });
            explain.style.fontSize = "0.9em";

            const modes: { mode: InitMode; label: string; desc: string }[] = [
                {
                    mode: "push",
                    label: "Push",
                    desc: "This vault is the source of truth. Uploads everything; writes nothing into the vault.",
                },
                {
                    mode: "pull",
                    label: "Pull",
                    desc: "The server is the source of truth. Refuses to run if this vault holds unknown files.",
                },
                {
                    mode: "merge",
                    label: "Merge",
                    desc: "Two-way. For a device that was already synced before.",
                },
            ];

            for (const { mode, label, desc } of modes) {
                new Setting(containerEl)
                    .setName(label)
                    .setDesc(desc)
                    .addButton((button) =>
                        button.setButtonText(`Initialize (${mode})`).onClick(async () => {
                            await this.plugin.initialize(mode);
                            this.display();
                        }),
                    );
            }
        }

        new Setting(containerEl)
            .setName("Debug logging")
            .setDesc("Writes detail to the developer console.")
            .addToggle((toggle) =>
                toggle.setValue(settings.debug).onChange(async (value) => {
                    settings.debug = value;
                    await this.plugin.saveSettings();
                }),
            );
    }
}
