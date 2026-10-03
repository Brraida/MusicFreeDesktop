import * as Comlink from "comlink";
import * as chokidar from "chokidar";
import path from "path";
import { isSupportedLocalMediaFile } from "@/common/local-media";
import fs from "fs/promises";
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
let delivery = Promise.resolve();

let _onAdd: (musicItems: LocalMusicItem[]) => void | Promise<void>;
let _onRemove: (filePaths: string[]) => void | Promise<void>;

async function setupWatcher(initPaths?: string[]) {
    ++watcherGeneration;
    parsing.clear();
    await watcher?.close();
    watcher = chokidar.watch(initPaths ?? [], {
        depth: 10,
        persistent: true,
        ignorePermissionErrors: true,
        alwaysStat: true,
    });
    watcher.on("add", readMusic);
    watcher.on("change", readMusic);
    watcher.on("unlink", fp => {
        if (!isSupportedLocalMediaFile(fp)) return;
        parsing.delete(fp); // Invalidate a metadata read still in flight.
        addedMusicItems.delete(fp);
        removedFilePaths.add(fp);
        syncMusic();
    });
    watcher.on("error", error => console.error("Local music watcher failed", error));
}

async function readMusic(fp: string, stats?: Stats) {
    if (!isSupportedLocalMediaFile(fp)) return;
    const ticket = Symbol();
    const generation = watcherGeneration;
    parsing.set(fp, ticket);
    try {
        const fileStats = stats ?? await fs.stat(fp);
        if (!fileStats.isFile()) return;
        const musicItem = await parseLocalMusicItem(fp) as LocalMusicItem;
        if (generation !== watcherGeneration || parsing.get(fp) !== ticket) return;
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
}

const syncMusic = debounce(() => {
    // Comlink callbacks are asynchronous. Keep batches ordered through DB commits.
    delivery = delivery.then(async () => {
        if (_onAdd && addedMusicItems.size) {
            const batch = [...addedMusicItems.values()];
            addedMusicItems.clear();
            try {
                await _onAdd(batch);
            } catch (error) {
                for (const item of batch) {
                    if (!addedMusicItems.has(item.$$localPath) && !removedFilePaths.has(item.$$localPath)) {
                        addedMusicItems.set(item.$$localPath, item);
                    }
                }
                throw error;
            }
        }
        if (_onRemove && removedFilePaths.size) {
            const batch = [...removedFilePaths];
            removedFilePaths.clear();
            try {
                await _onRemove(batch);
            } catch (error) {
                for (const fp of batch) if (!addedMusicItems.has(fp)) removedFilePaths.add(fp);
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
            watcher.add(addPaths);
        }
        if (rmPaths?.length) {
            watcher.unwatch(rmPaths);
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
        console.log(e);
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
