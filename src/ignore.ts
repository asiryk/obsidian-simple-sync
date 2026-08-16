import { minimatch } from "minimatch";

export class IgnoreList {
    private patterns: string[] = [];

    constructor(raw: string) {
        this.patterns = raw
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0 && !line.startsWith("#"));
    }

    matches(path: string): boolean {
        const basename = path.slice(path.lastIndexOf("/") + 1);
        for (const pattern of this.patterns) {
            if (minimatch(path, pattern, { dot: true })) return true;

            // gitignore semantics: a pattern with no slash applies at any depth,
            // so "*.tmp" and ".DS_Store" mean what people expect them to mean.
            if (!pattern.includes("/") && minimatch(basename, pattern, { dot: true })) return true;

            // A bare directory name should exclude everything under it, so that
            // ".obsidian" behaves the way a user expects without "/**".
            if (!pattern.includes("*") && (path === pattern || path.startsWith(`${pattern}/`))) {
                return true;
            }
        }
        return false;
    }
}
