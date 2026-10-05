import * as chokidar from "chokidar";
import path from "path";
import type { Stats } from "fs";
import fs from "fs/promises";
import { DownloadWatchEvent } from "./download-resource";

/** One bounded watcher per renderer, also observing ancestors for directory recovery. */
export class DownloadDirectoryWatcher {
    private watcher?: chokidar.FSWatcher;
    private generation = 0;
    private debounceTimer?: ReturnType<typeof setTimeout>;
    private retryTimer?: ReturnType<typeof setTimeout>;

    async stop() {
        ++this.generation;
        clearTimeout(this.debounceTimer);
        clearTimeout(this.retryTimer);
        this.debounceTimer = undefined;
        this.retryTimer = undefined;
        const watcher = this.watcher;
        this.watcher = undefined;
        await watcher?.close();
    }

    async watch(directories: string[], notify: (event: DownloadWatchEvent) => void) {
        const stopping = this.stop();
        const generation = this.generation;
        await stopping;
        if (generation !== this.generation) return;
        const key = (filePath: string) => {
            const resolved = path.resolve(filePath);
            return process.platform === "win32" ? resolved.toLowerCase() : resolved;
        };
        const targets = new Set(directories.map(key));
        const ancestors = new Set<string>();
        const roots = new Set<string>();
        for (const directory of directories) {
            let current = path.resolve(directory);
            let nearest = path.dirname(current);
            while (true) {
                try {
                    if ((await fs.stat(nearest)).isDirectory()) break;
                } catch {
                    // Recover from deletion by observing the closest accessible ancestor.
                }
                const parent = path.dirname(nearest);
                if (parent === nearest) break;
                nearest = parent;
            }
            roots.add(nearest);
            while (true) {
                ancestors.add(key(current));
                const parent = path.dirname(current);
                if (parent === current) {
                    break;
                }
                current = parent;
            }
        }
        if (generation !== this.generation) return;
        if (!roots.size) return;
        const pending = new Set<string>();
        const deliver = (event: DownloadWatchEvent) => {
            if (generation !== this.generation) return;
            try {
                notify(event);
            } catch (error) {
                console.error("Download watcher observer failed", error);
            }
        };
        const watcher = chokidar.watch([...roots], {
            ignoreInitial: true, persistent: true, atomic: 200,
            ignored: (filePath: string, stat?: Stats) => !ancestors.has(key(filePath))
                && (!targets.has(key(path.dirname(filePath))) || stat?.isDirectory() === true),
        });
        this.watcher = watcher;
        watcher.on("all", (_event, filePath) => {
            if (generation !== this.generation) return;
            if (_event === "unlinkDir" && !this.retryTimer) {
                this.retryTimer = setTimeout(() => {
                    this.retryTimer = undefined;
                    if (generation === this.generation) void this.watch(directories, notify).catch(error => {
                        try {
                            notify({ paths: [], full: true, error: error.message });
                        } catch { /* Observer already gone. */ }
                    });
                }, 500);
            }
            pending.add(filePath);
            if (this.debounceTimer) return;
            this.debounceTimer = setTimeout(() => {
                this.debounceTimer = undefined;
                const paths = [...pending]; pending.clear(); deliver({ paths });
            }, 250);
        });
        watcher.on("ready", () => deliver({ paths: [], full: true }));
        watcher.on("error", error => {
            deliver({ paths: [], full: true, error: error.message });
            if (generation !== this.generation || this.retryTimer) return;
            this.retryTimer = setTimeout(() => {
                this.retryTimer = undefined;
                if (generation === this.generation) void this.watch(directories, notify);
            }, 5000);
        });
    }
}
