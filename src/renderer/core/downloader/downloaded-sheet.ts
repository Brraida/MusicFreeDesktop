import { getInternalData, getMediaPrimaryKey, setInternalData } from "@/common/media-util";
import Store from "@/common/store";
import { DownloadResourceState, DownloadResourceStatus, DownloadFileInspection, DownloadWatchEvent, effectiveResourceState } from "@/common/download-resource";
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
const resourceStore = new Store(new Map<string, DownloadResourceStatus>());
const downloadedSet = new Set<string>();
// Includes missing and unavailable associations so file restoration can recover them.
const downloadedRecords = new Map<string, IMusic.IMusicItem>();
const mutations = new PQueue({ concurrency: 1 });
let initialization: Promise<void>;
let observingConfig = false;
let configurationGeneration = 0;
let monitorGeneration = 0;
let monitorSignature = "";
let monitoring = true;
let compensationTimer: ReturnType<typeof setInterval>;
let deliveryTimer: ReturnType<typeof setTimeout>;
let retryTimer: ReturnType<typeof setTimeout>;
let delivering = false;
let pendingFull = false;
const pendingPaths = new Set<string>();

function downloadDirectory() {
    return AppConfig.getConfig("download.path") || getGlobalContext().appPath.downloads;
}

export function setupDownloadedMusicList() {
    if (!observingConfig) {
        observingConfig = true;
        AppConfig.onConfigUpdate((patch) => {
            if ("download.path" in patch) {
                ++configurationGeneration;
                ++monitorGeneration;
                monitorSignature = "";
                requestReconciliation({ paths: [], full: true });
            }
        });
        compensationTimer = setInterval(() => requestReconciliation({ paths: [], full: true }), 300000);
        let lastFocus = 0;
        window.addEventListener("focus", () => {
            if (Date.now() - lastFocus < 30000) return;
            lastFocus = Date.now();
            requestReconciliation({ paths: [], full: true });
        });
    }
    if (!initialization) {
        initialization = mutations.add(() => reconcileDownloadedMusicList()).catch(error => {
            initialization = undefined;
            throw error;
        });
    }
    return initialization;
}

function requestReconciliation(event: DownloadWatchEvent) {
    if (!monitoring) return;
    if (event.error) reportSaveError("Download file watcher needs recovery", new Error(event.error));
    pendingFull ||= event.full === true;
    event.paths.forEach(filePath => pendingPaths.add(pathKey(filePath)));
    if (pendingPaths.size > 1000) {
        pendingFull = true; pendingPaths.clear();
    }
    scheduleReconciliation();
}

function scheduleReconciliation() {
    if (!monitoring || delivering || deliveryTimer || retryTimer) return;
    deliveryTimer = setTimeout(() => {
        deliveryTimer = undefined;
        delivering = true;
        const paths = pendingFull ? undefined : new Set(pendingPaths);
        pendingFull = false; pendingPaths.clear();
        void setupDownloadedMusicList().then(() => mutations.add(() => reconcileDownloadedMusicList(paths, !!paths)))
            .catch((error) => {
                reportSaveError("Failed to reconcile download files", error);
                pendingFull = true;
                retryTimer = setTimeout(() => {
                    retryTimer = undefined; scheduleReconciliation();
                }, 5000);
            }).finally(() => {
                delivering = false;
                if (pendingFull || pendingPaths.size) scheduleReconciliation();
            });
    }, 250);
}

async function updateMonitor() {
    if (!monitoring) return;
    const directories = [...new Set([downloadDirectory(), ...[...downloadedRecords.values()]
        .map(item => window.path.dirname(getInternalData<IMusic.IMusicItemInternalData>(item, "downloadData").path))])];
    const signature = directories.map(pathKey).sort().join("\n");
    if (signature === monitorSignature) return;
    monitorSignature = signature;
    const generation = ++monitorGeneration;
    try {
        await fsUtil.watchDownloadDirectories(directories, event => {
            if (generation === monitorGeneration) requestReconciliation(event);
        });
    } catch (error) {
        monitorSignature = "";
        requestReconciliation({ paths: [], full: true, error: error.message });
    }
}

export async function stopDownloadedMusicMonitor() {
    monitoring = false;
    ++monitorGeneration;
    clearInterval(compensationTimer); clearTimeout(deliveryTimer); clearTimeout(retryTimer);
    pendingPaths.clear(); pendingFull = false;
    await fsUtil.stopDownloadWatcher();
}

export async function refreshDownloadedMusicList() {
    await setupDownloadedMusicList();
    await mutations.add(() => reconcileDownloadedMusicList(undefined, true));
}

export async function refreshDownloadedMusicItem(item: IMedia.IMediaBase, failedPath?: string) {
    await setupDownloadedMusicList();
    await mutations.add(async () => {
        const record = downloadedRecords.get(getMediaPrimaryKey(item));
        const data = getInternalData<IMusic.IMusicItemInternalData>(record, "downloadData");
        if (!data?.path || (failedPath && pathKey(data.path) !== pathKey(failedPath))) return;
        const paths = new Set([pathKey(data.path), pathKey(window.path.join(downloadDirectory(), window.path.basename(data.path)))]);
        await reconcileDownloadedMusicList(paths, !!failedPath, failedPath ? getMediaPrimaryKey(item) : undefined);
    }, { priority: 1 });
    return getDownloadResourceStatus(item);
}

function pathKey(filePath: string) {
    const resolved = window.path.resolve(filePath);
    return getGlobalContext().platform === "win32" ? resolved.toLowerCase() : resolved;
}

function touches(paths: Set<string>, filePath: string) {
    const file = pathKey(filePath);
    return [...paths].some(changed => file === changed || file.startsWith(changed.endsWith(window.path.sep) ? changed : changed + window.path.sep));
}

async function reconcileDownloadedMusicList(paths?: Set<string>, forceHash = false, playbackFailure?: string) {
    const generation = configurationGeneration;
    const directory = downloadDirectory();
    const partial = !!paths;
    const records = partial ? [...downloadedRecords.values()] : await musicSheetDB.musicStore.toArray();
    const all = records.filter(item => getInternalData<IMusic.IMusicItemInternalData>(item, "downloadData")?.path);
    const candidates = all.filter(item => {
        const data = getInternalData<IMusic.IMusicItemInternalData>(item, "downloadData");
        return !paths || touches(paths, data.path) || touches(paths, window.path.join(directory, window.path.basename(data.path)));
    });
    if (!candidates.length && partial) return;
    const previous = resourceStore.getValue();
    const checking = new Map(previous);
    candidates.forEach(item => {
        const key = getMediaPrimaryKey(item);
        checking.set(key, { ...previous.get(key), state: DownloadResourceState.CHECKING,
            previousState: effectiveResourceState(previous.get(key) ?? { state: DownloadResourceState.NO_RECORD }) });
    });
    resourceStore.setValue(checking);
    try {
        const checked = new Map<string, DownloadFileInspection>();
        // Bound hashing and disk reads, including migration of old records without fingerprints.
        for (let index = 0; index < candidates.length; index += 4) {
            await Promise.all(candidates.slice(index, index + 4).map(async item => {
                const data = getInternalData<IMusic.IMusicItemInternalData>(item, "downloadData");
                checked.set(getMediaPrimaryKey(item), await fsUtil.inspectDownloadFile(data.path, data.fingerprint, forceHash));
            }));
        }
        const destinationCounts = new Map<string, number>();
        const claimed = new Set<string>();
        all.forEach(item => {
            const key = getMediaPrimaryKey(item);
            const data = getInternalData<IMusic.IMusicItemInternalData>(item, "downloadData");
            if ((checked.get(key)?.state ?? effectiveResourceState(previous.get(key) ?? { state: DownloadResourceState.NO_RECORD })) === DownloadResourceState.AVAILABLE) {
                claimed.add(pathKey(data.path));
            }
            const destination = pathKey(window.path.join(directory, window.path.basename(data.path)));
            destinationCounts.set(destination, (destinationCounts.get(destination) ?? 0) + 1);
        });
        const updates = new Map<string, { item: IMusic.IMusicItem; data: IMusic.IMusicItemInternalData["downloadData"] }>();
        for (const item of candidates) {
            const key = getMediaPrimaryKey(item);
            const data = getInternalData<IMusic.IMusicItemInternalData>(item, "downloadData");
            let inspection = checked.get(key);
            let target = data.path;
            const candidate = window.path.join(directory, window.path.basename(data.path));
            // A filename alone is not an identity. Legacy missing records require a new download.
            if (inspection.state === DownloadResourceState.MISSING && data.fingerprint && pathKey(candidate) !== pathKey(data.path)
                && destinationCounts.get(pathKey(candidate)) === 1 && !claimed.has(pathKey(candidate))) {
                const relocated = await fsUtil.inspectDownloadFile(candidate, { ...data.fingerprint, device: undefined }, true);
                if (relocated.state === DownloadResourceState.AVAILABLE) {
                    target = candidate; inspection = relocated; claimed.add(pathKey(candidate));
                }
            }
            if (playbackFailure === key && inspection.state === DownloadResourceState.AVAILABLE) {
                inspection = { ...inspection, state: DownloadResourceState.UNAVAILABLE, reason: "playback" };
            }
            checked.set(key, inspection);
            if (inspection.identity && (target !== data.path || JSON.stringify(data.fingerprint) !== JSON.stringify(inspection.identity))) {
                updates.set(key, { item, data: { ...data, path: target, fingerprint: inspection.identity } });
            }
        }
        if (generation !== configurationGeneration) return;
        const committed = updates.size ? await musicSheetDB.transaction("rw", musicSheetDB.musicStore, async () => {
            const changes = [...updates.values()];
            const current = await musicSheetDB.musicStore.bulkGet(changes.map(({ item }) => [item.platform, item.id]));
            const updated = current.flatMap((item, index) => {
                const old = getInternalData<IMusic.IMusicItemInternalData>(changes[index].item, "downloadData");
                const now = getInternalData<IMusic.IMusicItemInternalData>(item, "downloadData");
                return now?.path === old.path ? [setInternalData<IMusic.IMusicItemInternalData, "downloadData", typeof item>(item, "downloadData", changes[index].data, true)] : [];
            });
            if (generation !== configurationGeneration) throw new Error("Download configuration changed during reconciliation");
            await musicSheetDB.musicStore.bulkPut(updated);
            if (generation !== configurationGeneration) throw new Error("Download configuration changed during reconciliation");
            return updated;
        }) : [];
        if (generation !== configurationGeneration) return;
        const committedByKey = new Map(committed.map(item => [getMediaPrimaryKey(item), item]));
        const nextRecords = partial ? new Map(downloadedRecords) : new Map(all.map(item => [getMediaPrimaryKey(item), item]));
        const statuses = partial ? new Map(previous) : new Map<string, DownloadResourceStatus>();
        candidates.forEach(item => {
            const key = getMediaPrimaryKey(item);
            const record = committedByKey.get(key) ?? item;
            const inspection = checked.get(key);
            // If the write was skipped because an association changed, keep the previous conclusion.
            if (updates.has(key) && !committedByKey.has(key)) return;
            nextRecords.set(key, record);
            statuses.set(key, { state: inspection.state, reason: inspection.reason,
                path: getInternalData<IMusic.IMusicItemInternalData>(record, "downloadData").path });
        });
        publishResources(nextRecords, statuses);
        await setUserPreferenceIDB("downloadedList", downloadedMusicListStore.getValue().map(primaryKeyMap));
        await updateMonitor();
    } finally {
        // Failed commits and superseded checks retain the last confirmed UI result.
        if (resourceStore.getValue() === checking) resourceStore.setValue(previous);
    }
}

function publishResources(records: Map<string, IMusic.IMusicItem>, statuses: Map<string, DownloadResourceStatus>, taskCompletion = false) {
    const removed = [...downloadedSet].filter(key => statuses.get(key)?.state !== DownloadResourceState.AVAILABLE)
        .map(key => downloadedRecords.get(key)).filter(Boolean);
    const added = [...records.values()].filter(item => statuses.get(getMediaPrimaryKey(item))?.state === DownloadResourceState.AVAILABLE
        && (!downloadedSet.has(getMediaPrimaryKey(item)) || downloadedRecords.get(getMediaPrimaryKey(item)) !== item));
    downloadedRecords.clear(); downloadedSet.clear();
    records.forEach((item, key) => {
        downloadedRecords.set(key, item);
        if (statuses.get(key)?.state === DownloadResourceState.AVAILABLE) downloadedSet.add(key);
    });
    resourceStore.setValue(statuses);
    const visible = [...records.values()].filter(item => [DownloadResourceState.AVAILABLE, DownloadResourceState.UNAVAILABLE].includes(statuses.get(getMediaPrimaryKey(item))?.state));
    downloadedMusicListStore.setValue(visible);
    for (const [event, items] of [[DownloadEvts.RemoveDownload, removed], [taskCompletion ? DownloadEvts.Downloaded : DownloadEvts.ResourcesChanged, added]] as const) {
        if (!items.length) continue;
        try {
            ee.emit(event, items);
        } catch (error) {
            reportSaveError("Download resource observer failed", error);
        }
    }
}

export function getDownloadResourceStatus(item: IMedia.IMediaBase): DownloadResourceStatus {
    return resourceStore.getValue().get(getMediaPrimaryKey(item)) ?? { state: DownloadResourceState.NO_RECORD };
}

export function useDownloadResourceStatus(item: IMedia.IMediaBase) {
    resourceStore.useValue();
    return getDownloadResourceStatus(item);
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
    await setupDownloadedMusicList();
    const result = await mutations.add(async () => {
        let committed = false;
        try {
            const uniqueItems = new Map((Array.isArray(musicItems) ? musicItems : [musicItems])
                .map((item) => [getMediaPrimaryKey(item), item]));
            const validItems: IMusic.IMusicItem[] = [];
            for (const item of uniqueItems.values()) {
                const data = getInternalData<IMusic.IMusicItemInternalData>(item, "downloadData");
                if (!data?.path) return false;
                const existing = getInternalData<IMusic.IMusicItemInternalData>(getDownloadedMusicItem(item), "downloadData");
                if (isDownloaded(item) && existing?.path === data.path) continue;
                const file = await fsUtil.inspectDownloadFile(data.path, undefined, true);
                if (file.state !== DownloadResourceState.AVAILABLE) return false;
                validItems.push(setInternalData<IMusic.IMusicItemInternalData, "downloadData", typeof item>(item, "downloadData", {
                    ...data, fingerprint: file.identity,
                }, true));
            }
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
            const records = new Map(downloadedRecords), statuses = new Map(resourceStore.getValue());
            allMusic.forEach(item => {
                const key = getMediaPrimaryKey(item);
                records.set(key, item);
                statuses.set(key, { state: DownloadResourceState.AVAILABLE,
                    path: getInternalData<IMusic.IMusicItemInternalData>(item, "downloadData").path });
            });
            publishResources(records, statuses, true);
            await updateMonitor();
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
    }, { priority: 1 });
    return result === true;
}

export async function removeDownloadedMusic(
    musicItems: IMusic.IMusicItem | IMusic.IMusicItem[],
    removeFile = false,
): Promise<ICommon.ICommonReturnType> {
    await setupDownloadedMusicList();
    const result = await mutations.add(async (): Promise<ICommon.ICommonReturnType> => {
        try {
            const items = Array.isArray(musicItems) ? musicItems : [musicItems];
            const records = await musicSheetDB.musicStore.bulkGet(items.map((item) => [item.platform, item.id]));
            const valid = records.filter(item => getInternalData<IMusic.IMusicItemInternalData>(item, "downloadData")?.path);
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
            const nextRecords = new Map(downloadedRecords), statuses = new Map(resourceStore.getValue());
            removedKeys.forEach(key => {
                nextRecords.delete(key); statuses.delete(key);
            });
            publishResources(nextRecords, statuses);
            await updateMonitor();
            await setUserPreferenceIDB("downloadedList", downloadedMusicListStore.getValue().map(primaryKeyMap));
            return results.every(Boolean) ? [true] : [false, { msg: "部分歌曲删除失败" }];
        } catch (error) {
            return [false, { msg: error?.message }];
        }
    }, { priority: 1 });
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
