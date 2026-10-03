import { getInternalData, getMediaPrimaryKey, setInternalData } from "@/common/media-util";
import Store from "@/common/store";
import { getUserPreferenceIDB, setUserPreferenceIDB } from "@/renderer/utils/user-perference";
import musicSheetDB from "../db/music-sheet-db";
import { internalDataKey, musicRefSymbol } from "@/common/constant";
import { DownloadEvts, ee } from "./ee";
import { fsUtil } from "@shared/utils/renderer";
import PQueue from "p-queue";
import logger from "@shared/logger/renderer";
import AppConfig from "@shared/app-config/renderer";
import { getGlobalContext } from "@/shared/global-context/renderer";

const downloadedMusicListStore = new Store<IMusic.IMusicItem[]>([]);
const downloadedSet = new Set<string>();
const downloadedRecords = new Map<string, IMusic.IMusicItem>();
const mutations = new PQueue({ concurrency: 1 });
let initialization: Promise<void>;

let observingConfig = false;

export function setupDownloadedMusicList() {
    if (!observingConfig) {
        observingConfig = true;
        AppConfig.onConfigUpdate((patch) => {
            if ("download.path" in patch) {
                refreshDownloadedMusicList().catch((error) => {
                    reportSaveError("Failed to reconcile the download directory", error);
                });
            }
        });
    }
    if (!initialization) {
        initialization = reconcileDownloadedMusicList().catch((error) => {
            initialization = undefined;
            throw error;
        });
    }
    return initialization;
}

export async function refreshDownloadedMusicList() {
    await setupDownloadedMusicList();
    await mutations.add(reconcileDownloadedMusicList);
}

function pathKey(filePath: string) {
    const resolved = window.path.resolve(filePath);
    return getGlobalContext().platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function reconcileDownloadedMusicList() {
    const directory = AppConfig.getConfig("download.path") || getGlobalContext().appPath.downloads;
    const keys = (await getUserPreferenceIDB("downloadedList")) ?? [];
    // Missing-file metadata is retained so moved files can be recovered later.
    const records = await musicSheetDB.musicStore.toArray();
    const byKey = new Map(records.map((item) => [getMediaPrimaryKey(item), item]));
    const ordered = new Map<string, IMusic.IMusicItem>();
    [...keys, ...records].forEach((item) => {
        const pk = getMediaPrimaryKey(item);
        const record = byKey.get(pk);
        if (record && getInternalData<IMusic.IMusicItemInternalData>(record, "downloadData")?.path) {
            ordered.set(pk, record);
        }
    });
    const candidates = [...ordered.values()];
    const recordedPath = (item: IMusic.IMusicItem) => getInternalData<IMusic.IMusicItemInternalData>(item, "downloadData").path;
    const exists = await Promise.all(candidates.map((item) => fsUtil.isFile(recordedPath(item))));
    const claimedPaths = new Set(candidates.filter((_item, index) => exists[index]).map((item) => pathKey(recordedPath(item))));
    const missing = candidates.filter((_item, index) => !exists[index]).map((item) => ({
        item, oldPath: recordedPath(item), newPath: window.path.join(directory, window.path.basename(recordedPath(item))),
    }));
    const destinationCounts = new Map<string, number>();
    missing.forEach(({ newPath }) => {
        const key = pathKey(newPath);
        destinationCounts.set(key, (destinationCounts.get(key) ?? 0) + 1);
    });
    const relocated = (await Promise.all(missing.map(async (candidate) => {
        const key = pathKey(candidate.newPath);
        // One file must not be silently associated with multiple song identities.
        return destinationCounts.get(key) === 1 && !claimedPaths.has(key) && await fsUtil.isFile(candidate.newPath)
            ? candidate : undefined;
    }))).filter(Boolean);
    const committed = relocated.length ? await musicSheetDB.transaction("rw", musicSheetDB.musicStore, async () => {
        const current = await musicSheetDB.musicStore.bulkGet(relocated.map(({ item }) => [item.platform, item.id]));
        const updated = current.flatMap((item, index) => {
            const downloadData = getInternalData<IMusic.IMusicItemInternalData>(item, "downloadData");
            if (downloadData?.path !== relocated[index].oldPath) {
                return [];
            }
            return [setInternalData<IMusic.IMusicItemInternalData, "downloadData", typeof item>(item, "downloadData", {
                ...downloadData, path: relocated[index].newPath,
            }, true)];
        });
        await musicSheetDB.musicStore.bulkPut(updated);
        return updated;
    }) : [];
    const committedByKey = new Map(committed.map((item) => [getMediaPrimaryKey(item), item]));
    const valid = candidates.flatMap((item, index) => {
        const updated = committedByKey.get(getMediaPrimaryKey(item));
        return updated ? [updated] : exists[index] ? [item] : [];
    });
    const validKeys = new Set(valid.map(getMediaPrimaryKey));
    const removed = [...downloadedRecords.values()].filter((item) => !validKeys.has(getMediaPrimaryKey(item)));
    const added = valid.filter((item) => !isDownloaded(item) || committedByKey.has(getMediaPrimaryKey(item)));
    downloadedSet.clear();
    downloadedRecords.clear();
    valid.forEach((item) => {
        const pk = getMediaPrimaryKey(item);
        downloadedSet.add(pk);
        downloadedRecords.set(pk, item);
    });
    downloadedMusicListStore.setValue(valid);
    for (const [event, items] of [[DownloadEvts.RemoveDownload, removed], [DownloadEvts.Downloaded, added]] as const) {
        if (items.length) {
            try {
                ee.emit(event, items);
            } catch (error) {
                reportSaveError("Download reconciliation observer failed", error);
            }
        }
    }
    await setUserPreferenceIDB("downloadedList", valid.map(primaryKeyMap));
}

function primaryKeyMap(item: IMedia.IMediaBase) {
    return { platform: item.platform, id: item.id };
}

function reportSaveError(message: string, error: Error) {
    try {
        logger.logError(message, error);
    } catch {
        // A logging transport failure must not change a committed download result.
    }
}

export async function addDownloadedMusicToList(
    musicItems: IMusic.IMusicItem | IMusic.IMusicItem[],
): Promise<boolean> {
    const result = await mutations.add(async () => {
        let committed = false;
        try {
            await setupDownloadedMusicList();
            const uniqueItems = new Map((Array.isArray(musicItems) ? musicItems : [musicItems])
                .map((item) => [getMediaPrimaryKey(item), item]));
            const validItems = [...uniqueItems.values()].filter((item) => !isDownloaded(item));
            if (!validItems.length) {
                return true;
            }
            const allMusic = await musicSheetDB.transaction("rw", musicSheetDB.musicStore, async () => {
                const existing = await musicSheetDB.musicStore.bulkGet(validItems.map((item) => [item.platform, item.id]));
                const records = validItems.map((item, index) => {
                    const previous = existing[index];
                    return {
                        ...(previous ?? item),
                        // A missing-file record already owns a download reference.
                        [musicRefSymbol]: (previous?.[musicRefSymbol] ?? 0)
                            + (getInternalData<IMusic.IMusicItemInternalData>(previous, "downloadData")?.path ? 0 : 1),
                        [internalDataKey]: { ...(previous?.[internalDataKey] ?? {}), ...(item[internalDataKey] ?? {}) },
                    };
                });
                await musicSheetDB.musicStore.bulkPut(records);
                return records;
            });
            committed = true;
            // Publish changes after commit. The preference index lives in a different database.
            allMusic.forEach((item) => {
                const pk = getMediaPrimaryKey(item);
                downloadedSet.add(pk);
                downloadedRecords.set(pk, item);
            });
            downloadedMusicListStore.setValue((previous) => [...previous, ...allMusic]);
            try {
                ee.emit(DownloadEvts.Downloaded, allMusic);
            } catch (error) {
                reportSaveError("Download metadata saved, but a completion observer failed", error);
            }
            const savedIndex = await setUserPreferenceIDB("downloadedList", downloadedMusicListStore.getValue().map(primaryKeyMap));
            if (!savedIndex) {
                logger.logInfo("Download index will be reconstructed from committed music metadata on startup");
            }
            return true;
        } catch (error) {
            reportSaveError(committed
                ? "Download metadata saved, but a notification or index update failed"
                : "Failed to save downloaded music metadata", error);
            return committed;
        }
    });
    return result === true;
}

export async function removeDownloadedMusic(
    musicItems: IMusic.IMusicItem | IMusic.IMusicItem[],
    removeFile = false,
): Promise<ICommon.ICommonReturnType> {
    const result = await mutations.add(async (): Promise<ICommon.ICommonReturnType> => {
        try {
            await setupDownloadedMusicList();
            const items = Array.isArray(musicItems) ? musicItems : [musicItems];
            const records = await musicSheetDB.musicStore.bulkGet(items.map((item) => [item.platform, item.id]));
            const valid = records.filter(Boolean);
            const results = removeFile ? await Promise.all(valid.map((item) => fsUtil.rimraf(
                getInternalData<IMusic.IMusicItemInternalData>(item, "downloadData")?.path,
            ))) : valid.map(() => true);
            const removed = valid.filter((_item, index) => results[index]);
            const removedKeys = new Set(removed.map(getMediaPrimaryKey));
            await musicSheetDB.transaction("rw", musicSheetDB.musicStore, async () => {
                const deleted: string[][] = [];
                const updated: typeof records = [];
                for (const item of removed) {
                    item[musicRefSymbol] = Math.max((item[musicRefSymbol] ?? 1) - 1, 0);
                    if (!item[musicRefSymbol]) {
                        deleted.push([item.platform, item.id]);
                    } else {
                        setInternalData<IMusic.IMusicItemInternalData>(item, "downloadData", undefined);
                        updated.push(item);
                    }
                }
                await musicSheetDB.musicStore.bulkDelete(deleted);
                await musicSheetDB.musicStore.bulkPut(updated);
            });
            removedKeys.forEach((pk) => {
                downloadedSet.delete(pk);
                downloadedRecords.delete(pk);
            });
            downloadedMusicListStore.setValue((previous) => previous.filter((item) => !removedKeys.has(getMediaPrimaryKey(item))));
            ee.emit(DownloadEvts.RemoveDownload, removed);
            await setUserPreferenceIDB("downloadedList", downloadedMusicListStore.getValue().map(primaryKeyMap));
            return results.every(Boolean) ? [true] : [false, { msg: "部分歌曲删除失败" }];
        } catch (error) {
            return [false, { msg: error?.message }];
        }
    });
    return result || [false, { msg: "Download mutation did not complete" }];
}

export function isDownloaded(musicItem: IMedia.IMediaBase) {
    return musicItem ? downloadedSet.has(getMediaPrimaryKey(musicItem)) : false;
}

export const useDownloadedMusicList = downloadedMusicListStore.useValue;

export function getDownloadedMusicItem(musicItem: IMedia.IMediaBase) {
    return musicItem ? downloadedRecords.get(getMediaPrimaryKey(musicItem)) : undefined;
}

export function useDownloaded(musicItem: IMedia.IMediaBase) {
    downloadedMusicListStore.useValue();
    return isDownloaded(musicItem);
}
