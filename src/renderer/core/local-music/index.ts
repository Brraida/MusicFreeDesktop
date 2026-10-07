import localMusicListStore from "./store";
import { getMediaPrimaryKey } from "@/common/media-util";
import { getUserPreferenceIDB } from "@/renderer/utils/user-perference";
import * as Comlink from "comlink";
import musicSheetDB from "../db/music-sheet-db";
import { getGlobalContext } from "@/shared/global-context/renderer";

type ProxyMarkedFunction<T extends (...args: any) => void> = T &
    Comlink.ProxyMarked;

type IMusicItemWithLocalPath = IMusic.IMusicItem & { $$localPath: string };

interface ILocalFileWatcherWorker {
    setupWatcher: (initPaths?: string[]) => Promise<void>;
    changeWatchPath: (addPaths?: string[], rmPaths?: string[]) => Promise<void>;
    onAdd: (
        cb: ProxyMarkedFunction<
            (musicItems: Array<IMusicItemWithLocalPath>) => Promise<void>
        >
    ) => Promise<void>;
    onRemove: (
        cb: ProxyMarkedFunction<(filePaths: string[]) => Promise<void>>
    ) => Promise<void>;
}

let localFileWatcherWorker: ILocalFileWatcherWorker;
let workerCreation: Promise<ILocalFileWatcherWorker>;

function getWatcherWorker() {
    if (!workerCreation) {
        const workerPath = getGlobalContext().workersPath.localFileWatcher;
        if (!workerPath) return Promise.resolve(undefined);
        let worker: Worker;
        workerCreation = (async () => {
            worker = new Worker(workerPath);
            const proxy: ILocalFileWatcherWorker = Comlink.wrap(worker);
            await proxy.onAdd(Comlink.proxy(saveAddedMusic));
            await proxy.onRemove(Comlink.proxy(saveRemovedPaths));
            await proxy.setupWatcher([]);
            localFileWatcherWorker = proxy;
            return proxy;
        })().catch(error => {
            worker?.terminate();
            workerCreation = undefined;
            throw error;
        });
    }
    return workerCreation;
}

function isSubDir(parent: string, target: string) {
    const relative = window.path.relative(parent, target);
    return (
        relative && relative !== ".." && !relative.startsWith(".." + window.path.sep) && !window.path.isAbsolute(relative)
    );
}

async function setupLocalMusic() {
    try {
        const localWatchDir =
            (await getUserPreferenceIDB("localWatchDirChecked")) ?? [];


        const allMusic = await musicSheetDB.localMusicStore.toArray();
        localMusicListStore.setValue(allMusic);
        // Persisted rows are useful even with no watched directories. Avoid
        // loading the metadata parser and a Node worker until monitoring is needed.
        if (localWatchDir.length) {
            const proxy = await getWatcherWorker();
            await proxy?.changeWatchPath(localWatchDir, []);
        }
    } catch (error) {
        console.error("Local music initialization failed", error);
    }
}

async function changeWatchPath(logs: Map<string, "add" | "delete">) {
    // 对所有的要删除的路径
    const tobeDeletedPaths: string[] = [];
    const tobeAddedPaths: string[] = [];
    logs.forEach((action, dirPath) => {
        if (action === "delete") {
            tobeDeletedPaths.push(dirPath);
        } else {
            tobeAddedPaths.push(dirPath);
        }
    });

    // Stop queued metadata from repopulating removed directories before deleting.
    const proxy = localFileWatcherWorker ?? (tobeAddedPaths.length ? await getWatcherWorker() : undefined);
    await proxy?.changeWatchPath(tobeAddedPaths, tobeDeletedPaths);
    if (tobeDeletedPaths.length) {
        await serializeUpdate(async () => {
            const removed = localMusicListStore.getValue().filter(it =>
                tobeDeletedPaths.some(dir => isSubDir(dir, it.$$localPath)));
            await removeMusic(removed);
        });
    }
}

// File events and directory edits must publish in the same order as DB commits.
let updates = Promise.resolve();
function serializeUpdate(work: () => Promise<void>) {
    const result = updates.then(work);
    updates = result.catch(() => {});
    return result;
}

async function saveAddedMusic(items: IMusicItemWithLocalPath[]) {
    await serializeUpdate(async () => {
        await musicSheetDB.transaction("rw", musicSheetDB.localMusicStore, async () => {
            await musicSheetDB.localMusicStore.bulkPut(items);
        });
        const merged = new Map(localMusicListStore.getValue().map(item => [getMediaPrimaryKey(item), item]));
        for (const item of items) merged.set(getMediaPrimaryKey(item), item);
        localMusicListStore.setValue([...merged.values()]);
    });
}

async function removeMusic(items: IMusicItemWithLocalPath[]) {
    const keys = new Set(items.map(getMediaPrimaryKey));
    await musicSheetDB.transaction("rw", musicSheetDB.localMusicStore, async () => {
        await musicSheetDB.localMusicStore.bulkDelete(items.map(item => [item.platform, item.id]));
    });
    localMusicListStore.setValue(localMusicListStore.getValue().filter(item => !keys.has(getMediaPrimaryKey(item))));
}

async function saveRemovedPaths(paths: string[]) {
    await serializeUpdate(async () => {
        const removed = new Set(paths);
        await removeMusic(localMusicListStore.getValue().filter(item => removed.has(item.$$localPath)));
    });
}

export default { setupLocalMusic, changeWatchPath };
