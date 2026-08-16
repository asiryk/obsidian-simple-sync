import type { DataAdapter } from "obsidian";
import { DOC_PREFIX, type FileDoc } from "./types";

/**
 * Extensions Obsidian and its common plugins treat as text. Everything else is
 * stored as a CouchDB attachment.
 */
const TEXT_EXTENSIONS = new Set([
    "md",
    "txt",
    "json",
    "canvas",
    "base",
    "svg",
    "csv",
    "yaml",
    "yml",
    "html",
    "css",
    "js",
    "ts",
]);

const MIME_TYPES: Record<string, string> = {
    avif: "image/avif",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    pdf: "application/pdf",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    ogg: "audio/ogg",
    wav: "audio/wav",
    zip: "application/zip",
};

export function extensionOf(path: string): string {
    const base = path.slice(path.lastIndexOf("/") + 1);
    const dot = base.lastIndexOf(".");
    return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

export function isTextPath(path: string): boolean {
    return TEXT_EXTENSIONS.has(extensionOf(path));
}

export function mimeTypeOf(path: string): string {
    return MIME_TYPES[extensionOf(path)] ?? "application/octet-stream";
}

/**
 * CouchDB reserves ids beginning with "_", and a bare path could start with one.
 * A fixed prefix sidesteps every escaping edge case. Paths keep their exact case.
 */
export function pathToId(path: string): string {
    return DOC_PREFIX + path;
}

export function idToPath(id: string): string {
    return id.startsWith(DOC_PREFIX) ? id.slice(DOC_PREFIX.length) : id;
}

export function isFileId(id: string): boolean {
    return id.startsWith(DOC_PREFIX);
}

const encoder = new TextEncoder();

/** SHA-256 hex. Available on desktop and iOS Obsidian, so no dependency needed. */
export async function sha256(data: string | ArrayBuffer): Promise<string> {
    const bytes = typeof data === "string" ? encoder.encode(data) : new Uint8Array(data);
    const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

export async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
    if (typeof blob.arrayBuffer === "function") return await blob.arrayBuffer();
    return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(blob);
    });
}

export interface LocalFile {
    path: string;
    type: "text" | "bin";
    hash: string;
    mtime: number;
    ctime: number;
    size: number;
    text?: string;
    binary?: ArrayBuffer;
}

/** Reads a vault file and hashes it. Returns null if it vanished mid-read. */
export async function readLocalFile(adapter: DataAdapter, path: string): Promise<LocalFile | null> {
    try {
        const stat = await adapter.stat(path);
        if (!stat || stat.type !== "file") return null;
        if (isTextPath(path)) {
            const text = await adapter.read(path);
            return {
                path,
                type: "text",
                hash: await sha256(text),
                mtime: stat.mtime,
                ctime: stat.ctime,
                size: stat.size,
                text,
            };
        }
        const binary = await adapter.readBinary(path);
        return {
            path,
            type: "bin",
            hash: await sha256(binary),
            mtime: stat.mtime,
            ctime: stat.ctime,
            size: stat.size,
            binary,
        };
    } catch {
        return null;
    }
}

/** Hash of a file on disk, or null if absent. Used for the echo check. */
export async function hashOnDisk(adapter: DataAdapter, path: string): Promise<string | null> {
    const file = await readLocalFile(adapter, path);
    return file ? file.hash : null;
}

export function buildDoc(file: LocalFile, existing?: FileDoc): FileDoc {
    const doc: FileDoc = {
        _id: pathToId(file.path),
        path: file.path,
        type: file.type,
        ctime: file.ctime,
        mtime: file.mtime,
        size: file.size,
        hash: file.hash,
    };
    if (existing?._rev) doc._rev = existing._rev;
    if (file.type === "text") {
        doc.data = file.text ?? "";
    } else if (file.binary) {
        doc._attachments = {
            content: {
                content_type: mimeTypeOf(file.path),
                data: arrayBufferToBase64(file.binary),
            },
        };
    }
    return doc;
}

/**
 * Turns a document into a tombstone. The content hash is retained so a later
 * delete/edit race can be told apart from a plain delete.
 */
export function buildTombstone(existing: FileDoc, path: string): FileDoc {
    return {
        _id: existing._id ?? pathToId(path),
        _rev: existing._rev,
        path,
        type: existing.type ?? "text",
        ctime: existing.ctime ?? Date.now(),
        mtime: Date.now(),
        size: 0,
        hash: "",
        deleted: true,
        deletedHash: existing.hash,
    };
}
