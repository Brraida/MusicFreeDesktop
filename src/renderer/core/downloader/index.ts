import { getMediaPrimaryKey, getQualityOrder, isSameMedia, setInternalData } from "@/common/media-util";
import * as Comlink from "comlink";
import { DownloadState, localPluginName } from "@/common/constant";
import PQueue from "p-queue";
import {
    addDownloadedMusicToList, isDownloaded, removeDownloadedMusic,
    setupDownloadedMusicList, useDownloaded, useDownloadedMusicList,
    refreshDownloadedMusicList, useDownloadResourceStatus,
    setupDownloadedMusicListInBackground, prepareDownloadedMusicList, refreshDownloadedMusicItem, getDownloadedMusicItem,
} from "./downloaded-sheet";
import { getGlobalContext } from "@/shared/global-context/renderer";
import Store from "@/common/store";
import { useEffect, useState } from "react";
import { DownloadEvts, ee } from "./ee";
import AppConfig from "@shared/app-config/renderer";
import PluginManager from "@shared/plugin-manager/renderer";
import { i18n } from "@/shared/i18n/renderer";
import logger from "@shared/logger/renderer";

export interface IDownloadStatus {
    state: DownloadState;
    path?: string;
    downloaded?: number;
    total?: number;
    msg?: string;
}

type IOnStateChangeFunc = (data: IDownloadStatus) => void;
interface IDownloaderWorker {
    downloadFile: (
        source: IMusic.IMusicSource, path: string,
        onProgress: IOnStateChangeFunc & Comlink.ProxyMarked, taskId: string,
    ) => Promise<IDownloadStatus>;
    pauseAllDownloads: () => Promise<void>;
    resumeAllDownloads: () => Promise<void>;
}

const downloadingMusicStore = new Store<IMusic.IMusicItem[]>([]);
const downloadingProgress = new Map<string, IDownloadStatus>();
const queueStateStore = new Store({ paused: false, changing: false });
const queuedKeys = new Set<string>();
const activeControllers = new Map<string, AbortController>();
const activeTasks = new Set<Promise<void>>();
// Retrying a failed record save must not transfer the completed file again.
const completedFiles = new Map<string, IMusic.IMusicItem>();
const downloadingQueue = new PQueue({ concurrency: 5 });
let downloaderWorker: IDownloaderWorker;

async function setupDownloader(background = false) {
    setupDownloaderWorker();
    await (background ? setupDownloadedMusicListInBackground() : setupDownloadedMusicList());
}

function setupDownloaderWorker() {
    if (downloaderWorker) {
        return;
    }
    const workerPath = getGlobalContext().workersPath.downloader;
    if (!workerPath) {
        throw new Error("Download worker is unavailable");
    }
    downloaderWorker = Comlink.wrap(new Worker(workerPath));
    setDownloadingConcurrency(AppConfig.getConfig("download.concurrency"));
}

function setDownloadingConcurrency(concurrency: number) {
    if (!Number.isFinite(concurrency)) {
        return;
    }
    downloadingQueue.concurrency = Math.min(Math.max(Math.floor(concurrency), 1), 20);
}

function notifyStatus(item: IMusic.IMusicItem, status: IDownloadStatus) {
    try {
        ee.emit(DownloadEvts.DownloadStatusUpdated, item, status);
    } catch (error) {
        try {
            logger.logError("Download status observer failed", error);
        } catch {
            // Logging must not change the state of a completed download.
        }
    }
}

function finishDownload(item: IMusic.IMusicItem) {
    const pk = getMediaPrimaryKey(item);
    completedFiles.delete(pk);
    downloadingProgress.delete(pk);
    downloadingMusicStore.setValue((previous) => previous.filter((song) => getMediaPrimaryKey(song) !== pk));
    notifyStatus(item, { state: DownloadState.DONE });
}

function getDownloadStatus(item: IMusic.IMusicItem): IDownloadStatus | null {
    return downloadingProgress.get(getMediaPrimaryKey(item))
        ?? (isDownloaded(item) ? { state: DownloadState.DONE } : null);
}

function updateStatus(item: IMusic.IMusicItem, status: IDownloadStatus) {
    // Only a finished task discards late callbacks; restoration must not finish an active transfer.
    if (isDownloaded(item) && !downloadingProgress.has(getMediaPrimaryKey(item))) {
        finishDownload(item);
        return;
    }
    downloadingProgress.set(getMediaPrimaryKey(item), status);
    notifyStatus(item, status);
}

ee.on(DownloadEvts.Downloaded, (items: IMusic.IMusicItem | IMusic.IMusicItem[]) => {
    for (const item of Array.isArray(items) ? items : [items]) {
        const pk = getMediaPrimaryKey(item);
        if (downloadingProgress.has(pk) || completedFiles.has(pk) || queuedKeys.has(pk)) {
            finishDownload(item);
        }
    }
});

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(new Error("Download paused"));
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
}

async function runDownload(item: IMusic.IMusicItem) {
    const pk = getMediaPrimaryKey(item);
    const controller = new AbortController();
    activeControllers.set(pk, controller);
    try {
        let completedItem = completedFiles.get(pk);
        if (!completedItem) {
            updateStatus(item, { state: DownloadState.DOWNLOADING });
            const qualityOrder = getQualityOrder(
                AppConfig.getConfig("download.defaultQuality"),
                AppConfig.getConfig("download.whenQualityMissing"),
            );
            let source: IPlugin.IMediaSourceResult | null = null;
            let realQuality = qualityOrder[0];
            for (const quality of qualityOrder) {
                try {
                    source = await abortable(PluginManager.callPluginDelegateMethod(
                        item, "getMediaSource", item, quality,
                    ), controller.signal);
                    if (source?.url) {
                        realQuality = quality;
                        break;
                    }
                } catch (error) {
                    if (controller.signal.aborted) {
                        throw error;
                    }
                }
            }
            if (controller.signal.aborted) {
                throw new Error("Download paused");
            }
            if (!source?.url) {
                throw new Error(i18n.t("download_page.invalid_source"));
            }
            const fileName = `${item.title}-${item.artist}`.replace(/[/|\\?*"<>:]/g, "_");
            const extension = source.url.match(/.*\/.+\.([^./?#]+)/)?.[1] ?? "mp3";
            const downloadPath = window.path.resolve(
                AppConfig.getConfig("download.path") || getGlobalContext().appPath.downloads,
                `${fileName}.${extension.replace(/[^a-zA-Z0-9]/g, "") || "mp3"}`,
            );
            const result = await downloaderWorker.downloadFile(source, downloadPath, Comlink.proxy((status) => {
                if (!queueStateStore.getValue().paused && !controller.signal.aborted) {
                    updateStatus(item, status);
                }
            }), pk);
            if (result.state !== DownloadState.DONE) {
                updateStatus(item, result);
                return;
            }
            completedItem = setInternalData<IMusic.IMusicItemInternalData>(item, "downloadData", {
                path: result.path ?? downloadPath, quality: realQuality,
            }, true) as IMusic.IMusicItem;
            completedFiles.set(pk, completedItem);
        }
        updateStatus(item, { state: DownloadState.SAVING });
        if (!await addDownloadedMusicToList(completedItem)) {
            updateStatus(item, { state: DownloadState.ERROR, msg: i18n.t("download_page.save_failed") });
            return;
        }
        finishDownload(item);
    } catch (error) {
        updateStatus(item, controller.signal.aborted
            ? { state: DownloadState.PAUSED }
            : { state: DownloadState.ERROR, msg: error?.message });
    } finally {
        activeControllers.delete(pk);
    }
}

function enqueue(item: IMusic.IMusicItem) {
    const pk = getMediaPrimaryKey(item);
    queuedKeys.add(pk);
    void downloadingQueue.add(async () => {
        queuedKeys.delete(pk);
        if (isDownloaded(item)) {
            finishDownload(item);
            return;
        }
        const task = runDownload(item);
        activeTasks.add(task);
        try {
            await task;
        } finally {
            activeTasks.delete(task);
        }
    }).catch((error) => updateStatus(item, { state: DownloadState.ERROR, msg: error?.message }));
}

async function startDownload(musicItems: IMusic.IMusicItem | IMusic.IMusicItem[]) {
    setupDownloaderWorker();
    const items = Array.isArray(musicItems) ? musicItems : [musicItems];
    await prepareDownloadedMusicList();
    // Never redownload an unchecked startup association. Check selected songs ahead of background work.
    await Promise.all(items.filter(item => getDownloadedMusicItem(item)).map(item => refreshDownloadedMusicItem(item)));
    const seen = new Set<string>();
    const validItems = items.filter((item) => {
        const pk = getMediaPrimaryKey(item);
        const state = downloadingProgress.get(pk)?.state;
        if (seen.has(pk) || isDownloaded(item) || item.platform === localPluginName ||
            queuedKeys.has(pk) || activeControllers.has(pk) ||
            (state && state !== DownloadState.ERROR)) {
            return false;
        }
        seen.add(pk);
        return true;
    });
    if (validItems.length) {
        downloadingMusicStore.setValue((previous) => [
            ...previous.filter((item) => !seen.has(getMediaPrimaryKey(item))), ...validItems,
        ]);
        for (const item of validItems) {
            updateStatus(item, { state: queueStateStore.getValue().paused ? DownloadState.PAUSED : DownloadState.WAITING });
            enqueue(item);
        }
    }
    return { added: validItems.length, skipped: items.length - validItems.length };
}

async function pauseAllDownloads() {
    if (queueStateStore.getValue().paused || queueStateStore.getValue().changing) {
        return;
    }
    queueStateStore.setValue({ paused: true, changing: true });
    downloadingQueue.pause();
    for (const item of downloadingMusicStore.getValue()) {
        const status = downloadingProgress.get(getMediaPrimaryKey(item));
        if (status?.state === DownloadState.WAITING || status?.state === DownloadState.DOWNLOADING) {
            updateStatus(item, { ...status, state: DownloadState.PAUSED });
        }
    }
    activeControllers.forEach((controller) => controller.abort());
    try {
        await downloaderWorker?.pauseAllDownloads();
        await Promise.allSettled([...activeTasks]);
    } finally {
        queueStateStore.setValue({ paused: true, changing: false });
    }
}

async function resumeAllDownloads() {
    if (!queueStateStore.getValue().paused || queueStateStore.getValue().changing) {
        return;
    }
    queueStateStore.setValue({ paused: true, changing: true });
    try {
        await downloaderWorker?.resumeAllDownloads();
        for (const item of downloadingMusicStore.getValue()) {
            const pk = getMediaPrimaryKey(item);
            if (downloadingProgress.get(pk)?.state === DownloadState.PAUSED) {
                updateStatus(item, { state: DownloadState.WAITING });
                if (!queuedKeys.has(pk)) {
                    enqueue(item);
                }
            }
        }
        queueStateStore.setValue({ paused: false, changing: false });
        downloadingQueue.start();
    } catch (error) {
        queueStateStore.setValue({ paused: true, changing: false });
        throw error;
    }
}

async function retryFailedDownloads() {
    return startDownload(downloadingMusicStore.getValue().filter((item) =>
        downloadingProgress.get(getMediaPrimaryKey(item))?.state === DownloadState.ERROR));
}

function useDownloadStatus(musicItem: IMusic.IMusicItem) {
    const [status, setStatus] = useState<IDownloadStatus | null>(() => getDownloadStatus(musicItem));
    useDownloaded(musicItem);
    useEffect(() => {
        setStatus(getDownloadStatus(musicItem));
        const update = (item: IMusic.IMusicItem, next: IDownloadStatus) => {
            if (isSameMedia(item, musicItem)) {
                setStatus(getDownloadStatus(musicItem) ?? next);
            }
        };
        ee.on(DownloadEvts.DownloadStatusUpdated, update);
        return () => {
            ee.off(DownloadEvts.DownloadStatusUpdated, update);
        };
    }, [musicItem]);
    return getDownloadStatus(musicItem) ?? (status?.state === DownloadState.DONE ? null : status);
}

function useDownloadState(musicItem: IMusic.IMusicItem) {
    return useDownloadStatus(musicItem)?.state ?? DownloadState.NONE;
}

export default {
    setupDownloader, startDownload, pauseAllDownloads, resumeAllDownloads, retryFailedDownloads,
    useQueueState: queueStateStore.useValue,
    getDownloadStatus, useDownloadStatus, useDownloadingMusicList: downloadingMusicStore.useValue,
    useDownloaded, isDownloaded, useDownloadedMusicList, removeDownloadedMusic,
    setDownloadingConcurrency, useDownloadState,
    refreshDownloadedMusicList, useDownloadResourceStatus,
    setupDownloadedMusicListInBackground, prepareDownloadedMusicList, refreshDownloadedMusicItem, getDownloadedMusicItem,
};
