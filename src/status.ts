import { setIcon } from "obsidian";

export type Status = "off" | "setup" | "idle" | "syncing" | "offline" | "error";

interface Presentation {
    /** Lucide id. Only names that survived lucide's rename wave are used here. */
    icon: string;
    label: string;
    tooltip: string;
}

const PRESENTATION: Record<Status, Presentation> = {
    off: { icon: "cloud-off", label: "sync off", tooltip: "Simple Sync: turned off" },
    setup: { icon: "settings", label: "sync setup", tooltip: "Simple Sync: this vault has not joined yet" },
    idle: { icon: "check-circle", label: "", tooltip: "Simple Sync: up to date" },
    syncing: { icon: "refresh-cw", label: "", tooltip: "Simple Sync: transferring" },
    offline: { icon: "cloud-off", label: "offline", tooltip: "Simple Sync: server unreachable, retrying" },
    error: {
        icon: "alert-circle",
        label: "sync error",
        tooltip: "Simple Sync: stopped, see the error notice",
    },
};

/** How long a transferred file keeps its arrow in the status bar. */
const ACTIVITY_MS = 3000;

/**
 * The status-bar item, and the plugin's whole notification surface apart from
 * error notices. Obsidian's own sync spins its icon while data moves, which is
 * the one piece of feedback worth copying: colour says which state sync is in,
 * the spin says something is happening right now. Everything is driven from
 * `styles.css` through the `data-status` attribute, so the states cannot drift
 * apart in JavaScript.
 */
export class StatusBar {
    private current: Status = "off";
    private up = 0;
    private down = 0;
    private timers: number[] = [];
    private iconEl: HTMLElement;
    private textEl: HTMLElement;

    constructor(private root: HTMLElement) {
        root.addClass("simple-sync-status");
        this.iconEl = root.createSpan({ cls: "simple-sync-status-icon" });
        this.textEl = root.createSpan({ cls: "simple-sync-status-text" });
        this.render();
    }

    get status(): Status {
        return this.current;
    }

    set(status: Status): void {
        if (status === this.current) return;
        this.current = status;
        this.render();
    }

    noteActivity(direction: "up" | "down"): void {
        if (direction === "up") this.up++;
        else this.down++;
        this.render();
        this.timers.push(
            window.setTimeout(() => {
                if (direction === "up") this.up = Math.max(0, this.up - 1);
                else this.down = Math.max(0, this.down - 1);
                this.render();
            }, ACTIVITY_MS),
        );
    }

    dispose(): void {
        for (const timer of this.timers) window.clearTimeout(timer);
        this.timers = [];
    }

    private render(): void {
        const { icon, label, tooltip } = PRESENTATION[this.current];
        setIcon(this.iconEl, icon);
        this.root.dataset.status = this.current;

        const counts: string[] = [];
        if (this.up > 0) counts.push(`↑${this.up}`);
        if (this.down > 0) counts.push(`↓${this.down}`);
        const text = counts.length > 0 ? counts.join(" ") : label;
        this.textEl.setText(text);
        this.textEl.toggleClass("is-empty", text === "");

        const detail = counts.length > 0 ? `${tooltip} (${counts.join(" ")})` : tooltip;
        this.root.setAttribute("aria-label", detail);
        this.root.setAttribute("title", detail);
    }
}
