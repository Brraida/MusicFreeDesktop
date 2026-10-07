import * as Comlink from "comlink";
import * as chokidar from "chokidar";
import path from "path";
import { isSupportedLocalMediaFile } from "@/common/local-media";
import fs from "fs/promises";
import TaskQueue from "@/common/task-queue";
const metadataQueue = new TaskQueue();
import type { Stats } from "fs";
import debounce from "lodash.debounce";
import { parseLocalMusicItem } from "@/common/file-util";
import { setInternalData } from "@/common/media-util";

let watcher: chokidar.FSWatcher;

type LocalMusicItem = IMusic.IMusicItem & { $$localPath: string };
const addedMusicItems = new Map<string, LocalMusicItem>();
const removedFilePaths = new Set<string>();
const parsing = new Map<string, symbol>();
let watcherGeneration = 0;
const watchScopes = new Map<string, boolean>();
function isWatched(fp: string) {
    let allowed = true, length = -1;
    for (const [dir, enabled] of watchScopes) {
        const relative = path.relative(dir, fp);
        if (dir.length > length && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) {
            length = dir.length; allowed = enabled;
        }
    }
    return allowed;
}
let delivery = Promise.resolve();

let _onAdd: (musicItems: LocalMusicItem[]) => void | Promise<void>;
let _onRemove: (filePaths: string[]) => void | Promise<void>;

async function setupWatcher(initPaths?: string[]) {
    const generation = ++watcherGeneration;
    parsing.clear();
    watchScopes.clear();
    addedMusicItems.clear();
    removedFilePaths.clear();
    syncMusic.cancel();
    await watcher?.close();
    if (generation !== watcherGeneration) return;
    watcher = chokidar.watch(initPaths ?? [], {
        depth: 10,
        persistent: true,
        ignorePermissionErrors: true,
        alwaysStat: true,
    });
    const read = (fp: string, stats?: Stats) => {
        if (generation === watcherGeneration) void readMusic(fp, stats);
    };
    watcher.on("add", read);
    watcher.on("change", read);
    watcher.on("unlink", fp => {
        if (generation !== watcherGeneration) return;
        if (!isSupportedLocalMediaFile(fp) || !isWatched(fp)) return;
        parsing.delete(fp); // Invalidate a metadata read still in flight.
        addedMusicItems.delete(fp);
        removedFilePaths.add(fp);
        syncMusic();
    });
    watcher.on("error", error => console.error("Local music watcher failed", error));
}

async function readMusic(fp: string, stats?: Stats) {
    if (!isSupportedLocalMediaFile(fp) || !isWatched(fp)) return;
    const ticket = Symbol();
    const generation = watcherGeneration;
    parsing.set(fp, ticket);
    await metadataQueue.run(async () => {
        if (generation !== watcherGeneration || parsing.get(fp) !== ticket || !isWatched(fp)) return;
        try {
            const fileStats = stats ?? await fs.stat(fp);
            if (!fileStats.isFile()) return;
            const musicItem = await parseLocalMusicItem(fp) as LocalMusicItem;
            if (generation !== watcherGeneration || parsing.get(fp) !== ticket || !isWatched(fp)) return;
            musicItem.$$localPath = fp;
            setInternalData<IMusic.IMusicItemInternalData>(musicItem, "downloadData", {
                path: fp, quality: "standard",
            });
            removedFilePaths.delete(fp);
            addedMusicItems.set(fp, musicItem);
            syncMusic();
        } catch (error) {
            if (error.code !== "ENOENT") console.error("Local music metadata read failed", error);
        } finally {
            if (parsing.get(fp) === ticket) parsing.delete(fp);
        }
    });
}

function takeBatch<T>(values: Iterable<T>): T[] {
    const batch: T[] = [];
    for (const value of values) {
        batch.push(value);
        if (batch.length === 200) break;
    }
    return batch;
}

const syncMusic = debounce(() => {
    // Comlink callbacks are asynchronous. Keep batches ordered through DB commits.
    delivery = delivery.then(async () => {
        while (_onAdd && addedMusicItems.size) {
            const generation = watcherGeneration;
            const batch = takeBatch(addedMusicItems.values());
            for (const item of batch) addedMusicItems.delete(item.$$localPath);
            try {
                await _onAdd(batch);
            } catch (error) {
                for (const item of batch) {
                    if (generation === watcherGeneration && isWatched(item.$$localPath) && !addedMusicItems.has(item.$$localPath) && !removedFilePaths.has(item.$$localPath)) {
                        addedMusicItems.set(item.$$localPath, item);
                    }
                }
                throw error;
            }
        }
        while (_onRemove && removedFilePaths.size) {
            const generation = watcherGeneration;
            const batch = takeBatch(removedFilePaths);
            for (const fp of batch) removedFilePaths.delete(fp);
            try {
                await _onRemove(batch);
            } catch (error) {
                for (const fp of batch) if (generation === watcherGeneration && !addedMusicItems.has(fp)) removedFilePaths.add(fp);
                throw error;
            }
        }
    }).catch(error => {
        console.error("Local music batch save failed", error);
        syncMusic();
    });
}, 500, { leading: false, trailing: true });

async function changeWatchPath(addPaths?: string[], rmPaths?: string[]) {
    console.log(addPaths, rmPaths);
    try {
        if (addPaths?.length) {
            for (const dir of addPaths) {
                for (const scope of watchScopes.keys()) {
                    const relative = path.relative(dir, scope);
                    if (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) watchScopes.delete(scope);
                }
                watchScopes.set(dir, true);
            }
            watcher.add(addPaths);
        }
        if (rmPaths?.length) {
            await watcher.unwatch(rmPaths);
            for (const dir of rmPaths) watchScopes.set(dir, false);
            const removed = (fp: string) => rmPaths.some(dir => {
                const relative = path.relative(dir, fp);
                return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
            });
            for (const fp of parsing.keys()) if (removed(fp)) parsing.delete(fp);
            for (const fp of addedMusicItems.keys()) if (removed(fp)) addedMusicItems.delete(fp);
            /**
       * chokidar的bug: https://github.com/paulmillr/chokidar/issues/1027
       * unwatch之后重新watch不会触发文件更新
       */
            rmPaths.forEach((it) => {
                // @ts-ignore
                const watchedDirEntry = watcher._watched.get(it);
                if (watchedDirEntry) {
                    // 移除所有子节点的监听
                    watchedDirEntry._removeWatcher(
                        path.dirname(it),
                        path.basename(it),
                        true,
                    );
                }
                // watcher._watched.delete(it);
            });
        }
    // console.log("WATCH PATH CHANGED", addPaths, rmPaths, watcher);
    } catch (e) {
        console.error("Local music watch path update failed", e);
        throw e;
    }
}

async function onAdd(fn: (musicItems: IMusic.IMusicItem[]) => void) {
    _onAdd = fn;
    syncMusic();
}

async function onRemove(fn: (filePaths: string[]) => void) {
    _onRemove = fn;
    syncMusic();
}

Comlink.expose({
    setupWatcher,
    changeWatchPath,
    onAdd,
    onRemove,
});
