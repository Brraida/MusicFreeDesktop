import { getInternalData, getMediaPrimaryKey, isSameMedia, setInternalData } from "@/common/media-util";
import Store from "@/common/store";
import { getUserPreferenceIDB, setUserPreferenceIDB } from "@/renderer/utils/user-perference";
import musicSheetDB from "../db/music-sheet-db";
import { internalDataKey, musicRefSymbol } from "@/common/constant";
import { useEffect, useState } from "react";
import { DownloadEvts, ee } from "./ee";
import { fsUtil } from "@shared/utils/renderer";
import PQueue from "p-queue";
import logger from "@shared/logger/renderer";

const downloadedMusicListStore = new Store<IMusic.IMusicItem[]>([]);
const downloadedSet = new Set<string>();
const mutations = new PQueue({ concurrency: 1 });
let initialization: Promise<void>;

export function setupDownloadedMusicList() {
    if (!initialization) {
        initialization = (async () => {
            const keys = (await getUserPreferenceIDB("downloadedList")) ?? [];
            // Download metadata is authoritative. Rebuild an incomplete legacy index.
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
            const exists = await Promise.all(candidates.map((item) => fsUtil.isFile(
                getInternalData<IMusic.IMusicItemInternalData>(item, "downloadData").path,
            )));
            const valid = candidates.filter((_item, index) => exists[index]);
            downloadedSet.clear();
            valid.forEach((item) => downloadedSet.add(getMediaPrimaryKey(item)));
            downloadedMusicListStore.setValue(valid);
            await setUserPreferenceIDB("downloadedList", valid.map(primaryKeyMap));
        })().catch((error) => {
            initialization = undefined;
            throw error;
        });
    }
    return initialization;
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
                        [musicRefSymbol]: (previous?.[musicRefSymbol] ?? 0) + 1,
                        [internalDataKey]: { ...(previous?.[internalDataKey] ?? {}), ...(item[internalDataKey] ?? {}) },
                    };
                });
                await musicSheetDB.musicStore.bulkPut(records);
                return records;
            });
            committed = true;
            // Publish changes after commit. The preference index lives in a different database.
            allMusic.forEach((item) => downloadedSet.add(getMediaPrimaryKey(item)));
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
            removedKeys.forEach((pk) => downloadedSet.delete(pk));
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

export function useDownloaded(musicItem: IMedia.IMediaBase) {
    const [downloaded, setDownloaded] = useState(isDownloaded(musicItem));

    useEffect(() => {
        const dlCb = (musicItems: IMusic.IMusicItem | IMusic.IMusicItem[]) => {
            if (Array.isArray(musicItems)) {
                setDownloaded(
                    (prev) =>
                        prev ||
                        musicItems.findIndex((it) => isSameMedia(it, musicItem)) !== -1,
                );
            } else {
                setDownloaded((prev) => prev || isSameMedia(musicItem, musicItems));
            }
        };

        const rmCb = (musicItems: IMusic.IMusicItem | IMusic.IMusicItem[]) => {
            if (Array.isArray(musicItems)) {
                setDownloaded(
                    (prev) =>
                        prev &&
                        musicItems.findIndex((it) => isSameMedia(it, musicItem)) === -1,
                );
            } else {
                setDownloaded((prev) => prev && !isSameMedia(musicItem, musicItems));
            }
        };

        if (musicItem) {
            setDownloaded(isDownloaded(musicItem));
        }

        ee.on(DownloadEvts.Downloaded, dlCb);
        ee.on(DownloadEvts.RemoveDownload, rmCb);

        return () => {
            ee.off(DownloadEvts.Downloaded, dlCb);
            ee.off(DownloadEvts.RemoveDownload, rmCb);
        };
    }, [musicItem]);

    return downloaded;
}
