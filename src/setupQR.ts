import { type App, Modal } from "obsidian";
import qrcode from "qrcode-generator";
import type { PortableSettings, SyncSettings } from "./types";

export const SETUP_ACTION = "simple-sync-setup";

function toBase64Url(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string {
    const padded = text.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

export function encodeSetup(settings: SyncSettings): string {
    const portable: PortableSettings = {
        url: settings.url,
        username: settings.username,
        password: settings.password,
        database: settings.database,
        ignore: settings.ignore,
    };
    return toBase64Url(JSON.stringify(portable));
}

export function decodeSetup(encoded: string): PortableSettings | null {
    try {
        const parsed = JSON.parse(fromBase64Url(encoded));
        if (typeof parsed?.url !== "string" || typeof parsed?.database !== "string") return null;
        return {
            url: parsed.url,
            username: parsed.username ?? "",
            password: parsed.password ?? "",
            database: parsed.database,
            ignore: parsed.ignore ?? "",
        };
    } catch {
        return null;
    }
}

export function setupUri(settings: SyncSettings): string {
    return `obsidian://${SETUP_ACTION}?config=${encodeSetup(settings)}`;
}

/**
 * Shows the setup URI as a QR code.
 *
 * No scanner is needed on the phone: the native camera recognises the
 * obsidian:// URL and hands it to Obsidian, where the protocol handler applies
 * it. That is why this is ~40 lines rather than a wizard.
 */
export class SetupQRModal extends Modal {
    constructor(
        app: App,
        private settings: SyncSettings,
    ) {
        super(app);
    }

    override onOpen(): void {
        const { contentEl } = this;
        contentEl.createEl("h3", { text: "Set up another device" });
        contentEl.createEl("p", {
            text: "Scan with the phone's camera app, then open the link in Obsidian. Initialize the new device in Pull mode.",
        });

        const uri = setupUri(this.settings);
        try {
            const qr = qrcode(0, "L");
            qr.addData(uri);
            qr.make();
            const holder = contentEl.createDiv();
            holder.style.background = "#fff";
            holder.style.padding = "12px";
            holder.style.display = "flex";
            holder.style.justifyContent = "center";
            holder.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
            const svg = holder.querySelector("svg");
            if (svg) {
                svg.setAttribute("width", "260");
                svg.setAttribute("height", "260");
            }
        } catch {
            contentEl.createEl("p", { text: "Could not render a QR code. Copy the link below instead." });
        }

        const warning = contentEl.createEl("p", {
            text: "This code contains the server password in plain form. Do not screenshot or display it publicly.",
        });
        warning.style.fontSize = "0.85em";
        warning.style.opacity = "0.75";

        const copy = contentEl.createEl("button", { text: "Copy setup link" });
        copy.onclick = () => {
            void navigator.clipboard.writeText(uri);
            copy.textContent = "Copied";
        };
    }

    override onClose(): void {
        this.contentEl.empty();
    }
}
