import { getInternalData, getMediaPrimaryKey, setInternalData } from "@/common/media-util";
import { durationToSeconds } from "@/common/time-util";
import Store from "@/common/store";
import { useEffect, useRef, useState } from "react";
import { DownloadResourceState, DownloadResourceStatus, DownloadFileInspection, DownloadWatchEvent, effectiveResourceState, restoreDownloadResource } from "@/common/download-resource";
import { setUserPreferenceIDB } from "@/renderer/utils/user-perference";
import musicSheetDB from "../db/music-sheet-db";
import { internalDataKey, musicRefSymbol } from "@/common/constant";
import { DownloadEvts, ee } from "./ee";
import { fsUtil } from "@shared/utils/renderer";
import PQueue from "p-queue";
import logger from "@shared/logger/renderer";
import AppConfig from "@shared/app-config/renderer";
import { getGlobalContext } from "@/shared/global-context/renderer";

const downloadedMusicListStore = new Store<IMusic.IMusicItem[]>([]);
// Consumers subscribe to entry snapshots, including when serial checks retain the map instance.
const resourceStore = new Store(new Map<string, DownloadResourceStatus>());
const downloadedSet = new Set<string>();
// Includes missing and unavailable associations so file restoration can recover them.
const downloadedRecords = new Map<string, IMusic.IMusicItem>();
let savedDownloadIndex: IMedia.IUnique[];
let savedDownloadList: IMusic.IMusicItem[];
const mutations = new PQueue({ concurrency: 1 });
let initialization: Promise<void>;
let preparation: Promise<void>;
let initializing = false;
const visibleChecks = new Map<string, Promise<DownloadResourceStatus>>();
let backgroundTimer: ReturnType<typeof setTimeout>;
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

export function prepareDownloadedMusicList() {
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
    if (!preparation) {
        preparation = mutations.add(loadDownloadAssociations).then(() => undefined).catch(error => {
            preparation = undefined;
            throw error;
        });
    }
    return preparation;
}

async function loadDownloadAssociations() {
    const records = (await musicSheetDB.musicStore.toArray())
        .filter(item => getInternalData<IMusic.IMusicItemInternalData>(item, "downloadData")?.path);
    const statuses = new Map<string, DownloadResourceStatus>();
    const previous = resourceStore.getValue();
    for (const item of records) {
        const key = getMediaPrimaryKey(item);
        const data = getInternalData<IMusic.IMusicItemInternalData>(item, "downloadData");
        const old = getInternalData<IMusic.IMusicItemInternalData>(downloadedRecords.get(key), "downloadData");
        const same = old?.path === data.path && JSON.stringify(old.fingerprint) === JSON.stringify(data.fingerprint);
        statuses.set(key, same && previous.has(key) ? previous.get(key) : restoreDownloadResource(data, downloadDirectory(), pathKey));
    }
    publishResources(new Map(records.map(item => [getMediaPrimaryKey(item), item])), statuses);
}

// Load associations before displaying the UI; disk reads and legacy SHA migration follow later.
export async function setupDownloadedMusicListInBackground() {
    await prepareDownloadedMusicList();
    if (!backgroundTimer && !initialization) {
        backgroundTimer = setTimeout(() => {
            backgroundTimer = undefined;
            void setupDownloadedMusicList().catch(error => {
                reportSaveError("Background download verification failed", error);
                requestReconciliation({ paths: [], full: true });
            });
        }, 100);
    }
}

async function reconcileAllDownloads(forceHash = false) {
    await prepareDownloadedMusicList();
    // Also discover restored/imported associations and removals made outside the download queue.
    await mutations.add(async () => {
        await loadDownloadAssociations();
        await updateMonitor();
    });
    const keys = [...downloadedRecords.keys()];
    // No batch owns the queue while waiting for the next batch. Visible rows and actions can preempt it.
    for (let index = 0; index < keys.length; index += 8) {
        if (!monitoring) return;
        const batch = new Set(keys.slice(index, index + 8));
        await mutations.add(() => reconcileDownloadedMusicList(undefined, forceHash, undefined, batch), { priority: -1 });
        // Leave a short input/render opportunity without holding the mutation queue.
        await new Promise(resolve => setTimeout(resolve, 4));
    }
}

export function setupDownloadedMusicList() {
    if (!initialization) {
        initializing = true;
        initialization = (async () => {
            await prepareDownloadedMusicList();
            const started = Date.now();
            const records = downloadedRecords.size;
            // Attach before scanning so mutations during a long legacy migration are not missed.
            await updateMonitor();
            await reconcileAllDownloads();
            logger.logInfo("Startup download verification", { records, durationMs: Date.now() - started });
        })().catch(error => {
            initialization = undefined;
            throw error;
        }).finally(() => {
            initializing = false;
            if (pendingFull || pendingPaths.size) scheduleReconciliation();
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
    // A watcher-ready full pass follows the startup baseline; actual file events run immediately.
    if (initializing && pendingFull && !pendingPaths.size) return;
    deliveryTimer = setTimeout(() => {
        deliveryTimer = undefined;
        delivering = true;
        const full = pendingFull && !initializing;
        const paths = full ? undefined : new Set(pendingPaths);
        if (full) pendingFull = false;
        pendingPaths.clear();
        void prepareDownloadedMusicList().then(() => paths
            ? mutations.add(() => reconcileDownloadedMusicList(paths, true), { priority: 1 })
            : reconcileAllDownloads())
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
    clearInterval(compensationTimer); clearTimeout(deliveryTimer); clearTimeout(retryTimer); clearTimeout(backgroundTimer);
    pendingPaths.clear(); pendingFull = false;
    await fsUtil.stopDownloadWatcher();
}

export async function refreshDownloadedMusicList() {
    await prepareDownloadedMusicList();
    await updateMonitor();
    await reconcileAllDownloads(true);
}

export async function refreshDownloadedMusicItem(item: IMedia.IMediaBase, failedPath?: string, onlyIfPending = false) {
    await prepareDownloadedMusicList();
    await mutations.add(async () => {
        const status = getDownloadResourceStatus(item);
        if (onlyIfPending && !status.cached && status.state !== DownloadResourceState.CHECKING) return;
        const record = downloadedRecords.get(getMediaPrimaryKey(item));
        const data = getInternalData<IMusic.IMusicItemInternalData>(record, "downloadData");
        if (!data?.path || (failedPath && pathKey(data.path) !== pathKey(failedPath))) return;
        const paths = new Set([pathKey(data.path), pathKey(window.path.join(downloadDirectory(), window.path.basename(data.path)))]);
        await reconcileDownloadedMusicList(paths, !!failedPath, failedPath ? getMediaPrimaryKey(item) : undefined);
    }, { priority: 1 });
    return getDownloadResourceStatus(item);
}

export function prioritizeDownloadResource(item: IMedia.IMediaBase) {
    const key = getMediaPrimaryKey(item);
    if (!visibleChecks.has(key)) {
        const pending = refreshDownloadedMusicItem(item, undefined, true).finally(() => visibleChecks.delete(key));
        visibleChecks.set(key, pending);
    }
    return visibleChecks.get(key);
}

function pathKey(filePath: string) {
    const resolved = window.path.resolve(filePath);
    return getGlobalContext().platform === "win32" ? resolved.toLowerCase() : resolved;
}

function touches(paths: Set<string>, filePath: string) {
    const file = pathKey(filePath);
    return [...paths].some(changed => file === changed || file.startsWith(changed.endsWith(window.path.sep) ? changed : changed + window.path.sep));
}

async function reconcileDownloadedMusicList(paths?: Set<string>, forceHash = false, playbackFailure?: string, keys?: Set<string>) {
    const generation = configurationGeneration;
    const directory = downloadDirectory();
    const partial = !!paths || !!keys;
    const records = keys ? [] : partial ? [...downloadedRecords.values()] : await musicSheetDB.musicStore.toArray();
    const all = records.filter(item => getInternalData<IMusic.IMusicItemInternalData>(item, "downloadData")?.path);
    const candidates = keys ? [...keys].map(key => downloadedRecords.get(key)).filter(Boolean) : all.filter(item => {
        const data = getInternalData<IMusic.IMusicItemInternalData>(item, "downloadData");
        return !paths || touches(paths, data.path) || touches(paths, window.path.join(directory, window.path.basename(data.path)));
    });
    if (!candidates.length && partial) return;
    const previous = resourceStore.getValue();
    const originals = keys ? new Map(candidates.map(item => {
        const key = getMediaPrimaryKey(item);
        return [key, previous.get(key)] as const;
    })) : undefined;
    // Background batches own the serial mutation queue. Journal their entries
    // instead of copying the whole resource map for each eight-song check.
    const checking = keys ? previous : new Map(previous);
    let published = false;
    const restoreEntry = (key: string) => {
        const value = originals.get(key);
        if (value) checking.set(key, value);
        else checking.delete(key);
    };
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
        const mayRelocate = candidates.some(item => {
            const data = getInternalData<IMusic.IMusicItemInternalData>(item, "downloadData");
            return checked.get(getMediaPrimaryKey(item))?.state === DownloadResourceState.MISSING && data.fingerprint &&
                pathKey(window.path.join(directory, window.path.basename(data.path))) !== pathKey(data.path);
        });
        // A successful stat/hash needs no global destination collision calculation.
        if (mayRelocate) (keys ? [...downloadedRecords.values()] : all).forEach(item => {
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
            updates.set(key, { item, data: {
                ...data, path: target, fingerprint: inspection.identity ?? data.fingerprint,
                verified: { version: 1, path: target, directory, state: inspection.state,
                    reason: inspection.reason, checkedAt: Date.now() },
            } });
        }
        if (generation !== configurationGeneration) return;
        const checkedAt = Date.now();
        const committed = updates.size ? await musicSheetDB.transaction("rw", musicSheetDB.musicStore, async () => {
            const changes = [...updates.values()];
            const current = await musicSheetDB.musicStore.bulkGet(changes.map(({ item }) => [item.platform, item.id]));
            const writes: Array<NonNullable<typeof current[number]>> = [];
            const updated = current.flatMap((item, index) => {
                const original = changes[index].item;
                const old = getInternalData<IMusic.IMusicItemInternalData>(original, "downloadData");
                const now = getInternalData<IMusic.IMusicItemInternalData>(item, "downloadData");
                if (now?.path !== old.path || JSON.stringify(now.fingerprint) !== JSON.stringify(old.fingerprint)) return [];
                const next = { ...now, path: changes[index].data.path, fingerprint: changes[index].data.fingerprint, verified: changes[index].data.verified };
                const snapshot = now.verified, result = next.verified;
                // A background recheck still opens every file. Persist only a
                // changed conclusion/identity; foreground/forced checks save time too.
                const unchanged = keys && !forceHash && !playbackFailure && snapshot &&
                    snapshot.version === result.version && snapshot.path === result.path && snapshot.directory === result.directory &&
                    snapshot.state === result.state && snapshot.reason === result.reason &&
                    JSON.stringify(now.fingerprint) === JSON.stringify(next.fingerprint);
                if (unchanged) {
                    const sameFields = (left: object, right: object, excluded: string) => {
                        const names = Object.keys(left).filter(name => name !== excluded);
                        return names.length === Object.keys(right).filter(name => name !== excluded).length &&
                            names.every(name => Object.is((left as Record<string, unknown>)[name], (right as Record<string, unknown>)[name]));
                    };
                    // Reuse a record only when all remaining shallow metadata agrees;
                    // nested changes conservatively retain the fresh DB record.
                    return [JSON.stringify(now) === JSON.stringify(old) && sameFields(item, original, internalDataKey) &&
                        sameFields(item[internalDataKey] ?? {}, original[internalDataKey] ?? {}, "downloadData") ? original : item];
                }
                const updatedItem = setInternalData<IMusic.IMusicItemInternalData, "downloadData", typeof item>(item, "downloadData", next, true);
                writes.push(updatedItem);
                return [updatedItem];
            });
            if (generation !== configurationGeneration) throw new Error("Download configuration changed during reconciliation");
            if (writes.length) await musicSheetDB.musicStore.bulkPut(writes);
            if (generation !== configurationGeneration) throw new Error("Download configuration changed during reconciliation");
            return updated;
        }) : [];
        if (generation !== configurationGeneration) return;
        const changedPath = committed.some(item => {
            const key = getMediaPrimaryKey(item);
            return getInternalData<IMusic.IMusicItemInternalData>(item, "downloadData").path !==
                getInternalData<IMusic.IMusicItemInternalData>(updates.get(key).item, "downloadData").path;
        });
        const committedByKey = new Map(committed.map(item => [getMediaPrimaryKey(item), item]));
        const nextRecords = keys ? undefined : partial ? new Map(downloadedRecords) : new Map(all.map(item => [getMediaPrimaryKey(item), item]));
        const statuses = keys ? checking : partial ? new Map(previous) : new Map<string, DownloadResourceStatus>();
        const changes: Array<{ item: IMusic.IMusicItem; status: DownloadResourceStatus }> = [];
        candidates.forEach(item => {
            const key = getMediaPrimaryKey(item);
            const record = committedByKey.get(key) ?? item;
            const inspection = checked.get(key);
            // If the write was skipped because an association changed, keep the previous conclusion.
            if (updates.has(key) && !committedByKey.has(key)) {
                if (keys) restoreEntry(key);
                return;
            }
            const status = { state: inspection.state, reason: inspection.reason,
                path: getInternalData<IMusic.IMusicItemInternalData>(record, "downloadData").path,
                checkedAt };
            if (keys) changes.push({ item: record, status });
            else {
                nextRecords.set(key, record); statuses.set(key, status);
            }
        });
        if (keys) publishResourceChanges(changes);
        else publishResources(nextRecords, statuses);
        published = true;
        await saveDownloadIndex();
        if (changedPath) await updateMonitor();
    } finally {
        // Failed commits and superseded checks retain the last confirmed UI result.
        if (!published && resourceStore.getValue() === checking) {
            if (keys) for (const key of originals.keys()) restoreEntry(key);
            resourceStore.setValue(previous);
        }
    }
}

function publishResourceChanges(changes: Array<{ item: IMusic.IMusicItem; status: DownloadResourceStatus }>) {
    const statuses = resourceStore.getValue();
    const removed: IMusic.IMusicItem[] = [], added: IMusic.IMusicItem[] = [];
    let listChanged = false;
    for (const { item, status } of changes) {
        const key = getMediaPrimaryKey(item), old = downloadedRecords.get(key);
        const wasAvailable = downloadedSet.has(key), available = effectiveResourceState(status) === DownloadResourceState.AVAILABLE;
        if (wasAvailable && !available && old) removed.push(old);
        if (available && (!wasAvailable || old !== item)) added.push(item);
        const wasVisible = [DownloadResourceState.AVAILABLE, DownloadResourceState.UNAVAILABLE].includes(effectiveResourceState(statuses.get(key)));
        const visible = [DownloadResourceState.AVAILABLE, DownloadResourceState.UNAVAILABLE].includes(effectiveResourceState(status));
        listChanged ||= wasVisible !== visible || (visible && old !== item);
        downloadedRecords.set(key, item); statuses.set(key, status);
        if (available) downloadedSet.add(key);
        else downloadedSet.delete(key);
    }
    const visible: IMusic.IMusicItem[] = [];
    // Keep association order even when a visible/selected song verifies first.
    if (listChanged) for (const [key, item] of downloadedRecords) {
        const state = effectiveResourceState(statuses.get(key));
        if (state === DownloadResourceState.AVAILABLE || state === DownloadResourceState.UNAVAILABLE) visible.push(item);
    }
    resourceStore.setValue(statuses);
    if (listChanged) downloadedMusicListStore.setValue(visible);
    notifyResourceChanges(removed, added);
}

function publishResources(records: Map<string, IMusic.IMusicItem>, statuses: Map<string, DownloadResourceStatus>, taskCompletion = false) {
    const removed = [...downloadedSet].filter(key => effectiveResourceState(statuses.get(key)) !== DownloadResourceState.AVAILABLE)
        .map(key => downloadedRecords.get(key)).filter(Boolean);
    const added = [...records.values()].filter(item => effectiveResourceState(statuses.get(getMediaPrimaryKey(item))) === DownloadResourceState.AVAILABLE
        && (!downloadedSet.has(getMediaPrimaryKey(item)) || downloadedRecords.get(getMediaPrimaryKey(item)) !== item));
    downloadedRecords.clear(); downloadedSet.clear();
    records.forEach((item, key) => {
        downloadedRecords.set(key, item);
        if (effectiveResourceState(statuses.get(key)) === DownloadResourceState.AVAILABLE) downloadedSet.add(key);
    });
    resourceStore.setValue(statuses);
    const visible = [...records.values()].filter(item => [DownloadResourceState.AVAILABLE, DownloadResourceState.UNAVAILABLE].includes(effectiveResourceState(statuses.get(getMediaPrimaryKey(item)))));
    downloadedMusicListStore.setValue(visible);
    notifyResourceChanges(removed, added, taskCompletion);
}

function notifyResourceChanges(removed: IMusic.IMusicItem[], added: IMusic.IMusicItem[], taskCompletion = false) {
    for (const [event, items] of [[DownloadEvts.RemoveDownload, removed], [taskCompletion ? DownloadEvts.Downloaded : DownloadEvts.ResourcesChanged, added]] as const) {
        if (!items.length) continue;
        try {
            ee.emit(event, items);
        } catch (error) {
            reportSaveError("Download resource observer failed", error);
        }
    }
}

const noDownloadResource: DownloadResourceStatus = { state: DownloadResourceState.NO_RECORD };
export function getDownloadResourceStatus(item: IMedia.IMediaBase): DownloadResourceStatus {
    return resourceStore.getValue().get(getMediaPrimaryKey(item)) ?? noDownloadResource;
}

export function useDownloadResourceStatus(item: IMedia.IMediaBase) {
    const key = getMediaPrimaryKey(item);
    const read = () => resourceStore.getValue().get(key) ?? noDownloadResource;
    const [snapshot, setSnapshot] = useState(() => ({ key, value: read() }));
    const latest = useRef(snapshot);
    useEffect(() => {
        const update = () => {
            const value = read();
            // Avoid enqueueing React updates for every unrelated background batch.
            if (latest.current.key !== key || latest.current.value !== value) {
                latest.current = { key, value };
                setSnapshot(latest.current);
            }
        };
        const unsubscribe = resourceStore.onValueChange(update);
        update(); // reconcile a publication between render and subscription
        return unsubscribe;
    }, [key]);
    return snapshot.key === key ? snapshot.value : read();
}

function primaryKeyMap(item: IMedia.IMediaBase) {
    return { platform: item.platform, id: item.id };
}

async function saveDownloadIndex() {
    const list = downloadedMusicListStore.getValue();
    if (list === savedDownloadList) return true;
    const next = list.map(primaryKeyMap);
    if (savedDownloadIndex?.length === next.length && next.every((item, index) =>
        item.id === savedDownloadIndex[index].id && item.platform === savedDownloadIndex[index].platform)) {
        savedDownloadList = list;
        return true;
    }
    const saved = await setUserPreferenceIDB("downloadedList", next);
    // Failed writes must be retried; only a committed identical index can be skipped.
    if (saved) {
        savedDownloadIndex = next; savedDownloadList = list;
    }
    return saved;
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
    await prepareDownloadedMusicList();
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
                if (isDownloaded(item) && !getDownloadResourceStatus(item).cached && existing?.path === data.path) continue;
                const file = await fsUtil.inspectDownloadFile(data.path, undefined, true);
                if (file.state !== DownloadResourceState.AVAILABLE) return false;
                let duration = durationToSeconds(item.duration);
                if (!(duration > 0)) {
                    try {
                        duration = await fsUtil.getLocalMusicDuration?.(data.path);
                    } catch {
                        // Optional metadata must not change a successfully committed download result.
                        duration = undefined;
                    }
                }
                validItems.push(setInternalData<IMusic.IMusicItemInternalData, "downloadData", typeof item>({ ...item, duration }, "downloadData", {
                    ...data, fingerprint: file.identity,
                    verified: { version: 1, path: data.path, directory: downloadDirectory(), state: file.state, checkedAt: Date.now() },
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
                        duration: item.duration ?? previous?.duration,
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
                    path: getInternalData<IMusic.IMusicItemInternalData>(item, "downloadData").path,
                    checkedAt: getInternalData<IMusic.IMusicItemInternalData>(item, "downloadData").verified?.checkedAt });
            });
            publishResources(records, statuses, true);
            await updateMonitor();
            const savedIndex = await saveDownloadIndex();
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
    await prepareDownloadedMusicList();
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
            await saveDownloadIndex();
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
