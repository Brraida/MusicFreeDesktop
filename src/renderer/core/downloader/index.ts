import { getMediaPrimaryKey, getQualityOrder, isSameMedia, setInternalData } from "@/common/media-util";
import * as Comlink from "comlink";
import { DownloadState, localPluginName } from "@/common/constant";
import PQueue from "p-queue";
import {
    addDownloadedMusicToList, isDownloaded, removeDownloadedMusic,
    setupDownloadedMusicList, useDownloaded, useDownloadedMusicList,
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
}

const downloadingMusicStore = new Store<IMusic.IMusicItem[]>([]);
const downloadingProgress = new Map<string, IDownloadStatus>();
const queuedKeys = new Set<string>();
const activeControllers = new Map<string, AbortController>();
const activeTasks = new Set<Promise<void>>();
// Retrying a failed record save must not transfer the completed file again.
const completedFiles = new Map<string, IMusic.IMusicItem>();
const downloadingQueue = new PQueue({ concurrency: 5 });
let downloaderWorker: IDownloaderWorker;

async function setupDownloader() {
    setupDownloaderWorker();
    await setupDownloadedMusicList();
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
    return isDownloaded(item)
        ? { state: DownloadState.DONE }
        : downloadingProgress.get(getMediaPrimaryKey(item)) ?? null;
}

function updateStatus(item: IMusic.IMusicItem, status: IDownloadStatus) {
    // Committed metadata takes precedence over a delayed progress/error callback.
    if (isDownloaded(item)) {
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
                    source = await PluginManager.callPluginDelegateMethod(
                        item, "getMediaSource", item, quality,
                    );
                    if (source?.url) {
                        realQuality = quality;
                        break;
                    }
                } catch {}
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
                updateStatus(item, status);
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
        updateStatus(item, { state: DownloadState.ERROR, msg: error?.message });
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
            updateStatus(item, { state: DownloadState.WAITING });
            enqueue(item);
        }
    }
    return { added: validItems.length, skipped: items.length - validItems.length };
}

async function retryFailedDownloads() {
    return startDownload(downloadingMusicStore.getValue().filter((item) =>
        downloadingProgress.get(getMediaPrimaryKey(item))?.state === DownloadState.ERROR));
}

function useDownloadStatus(musicItem: IMusic.IMusicItem) {
    const [status, setStatus] = useState<IDownloadStatus | null>(() => getDownloadStatus(musicItem));
    const downloaded = useDownloaded(musicItem);
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
    return downloaded || isDownloaded(musicItem)
        ? { state: DownloadState.DONE }
        : status?.state === DownloadState.DONE ? null : status;
}

function useDownloadState(musicItem: IMusic.IMusicItem) {
    return useDownloadStatus(musicItem)?.state ?? DownloadState.NONE;
}

export default {
    setupDownloader, startDownload, retryFailedDownloads,
    getDownloadStatus, useDownloadStatus, useDownloadingMusicList: downloadingMusicStore.useValue,
    useDownloaded, isDownloaded, useDownloadedMusicList, removeDownloadedMusic,
    setDownloadingConcurrency, useDownloadState,
};
