import { type App, Modal } from "obsidian";

/**
 * The plugin's only modal. Guard C uses it to show a dry-run report before the
 * first sync writes anything, which is the last line of defence against a vault
 * being pointed at the wrong database.
 */
export class ConfirmModal extends Modal {
    private resolved = false;

    constructor(
        app: App,
        private title: string,
        private body: string,
        private confirmLabel: string,
        private onDecision: (confirmed: boolean) => void,
        private warning?: string | null,
    ) {
        super(app);
    }

    override onOpen(): void {
        const { contentEl } = this;
        contentEl.createEl("h3", { text: this.title });

        if (this.warning) {
            const warn = contentEl.createDiv({ text: this.warning });
            warn.style.border = "1px solid var(--text-error)";
            warn.style.color = "var(--text-error)";
            warn.style.padding = "8px";
            warn.style.borderRadius = "4px";
            warn.style.marginBottom = "12px";
        }

        const pre = contentEl.createEl("pre", { text: this.body });
        pre.style.maxHeight = "45vh";
        pre.style.overflow = "auto";
        pre.style.fontSize = "0.85em";
        pre.style.whiteSpace = "pre-wrap";

        const buttons = contentEl.createDiv();
        buttons.style.display = "flex";
        buttons.style.gap = "8px";
        buttons.style.justifyContent = "flex-end";

        const cancel = buttons.createEl("button", { text: "Cancel" });
        cancel.onclick = () => this.finish(false);

        const confirm = buttons.createEl("button", { text: this.confirmLabel });
        confirm.classList.add("mod-cta");
        confirm.onclick = () => this.finish(true);
    }

    private finish(confirmed: boolean): void {
        if (this.resolved) return;
        this.resolved = true;
        this.onDecision(confirmed);
        this.close();
    }

    override onClose(): void {
        this.contentEl.empty();
        if (!this.resolved) {
            this.resolved = true;
            this.onDecision(false);
        }
    }
}

export function confirm(
    app: App,
    title: string,
    body: string,
    confirmLabel: string,
    warning?: string | null,
): Promise<boolean> {
    return new Promise((resolve) => {
        new ConfirmModal(app, title, body, confirmLabel, resolve, warning).open();
    });
}
