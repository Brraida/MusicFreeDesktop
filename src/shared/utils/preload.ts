import { contextBridge, ipcRenderer } from "electron";
import fs from "fs/promises";
import { rimraf } from "rimraf";
import url from "url";
import { inspectDownloadFile } from "@/common/download-file-system";
import { DownloadDirectoryWatcher } from "@/common/download-directory-watcher";
import type { DownloadWatchEvent } from "@/common/download-resource";

const downloadWatcher = new DownloadDirectoryWatcher();
window.addEventListener("unload", () => {
    void downloadWatcher.stop();
});


/****** fs utils ******/
const originalFsWriteFile = fs.writeFile;
const originalFsReadFile = fs.readFile;

function writeFile(...args: Parameters<typeof originalFsWriteFile>): ReturnType<typeof originalFsWriteFile> {
    return originalFsWriteFile(...args);
}

function readFile(...args: Parameters<typeof originalFsReadFile>): ReturnType<typeof originalFsReadFile> {
    return originalFsReadFile(...args);
}

async function isFile(path: string) {
    try {
        const stat = await fs.stat(path);
        return stat.isFile();
    } catch {
        return false;
    }
}

async function isFolder(path: string) {
    try {
        const stat = await fs.stat(path);
        return stat.isDirectory();
    } catch {
        return false;
    }
}

function addFileScheme(filePath: string) {
    return filePath.startsWith("file:")
        ? filePath
        : url.pathToFileURL(filePath).toString();
}

const fsUtil = {
    inspectDownloadFile,
    // Load the metadata parser only when a visible song needs its duration.
    async getLocalMusicDuration(filePath: string) {
        try {
            const { parseFile, parseBuffer } = await import("music-metadata");
            const actualPath = filePath.startsWith("file:") ? url.fileURLToPath(filePath) : filePath;
            const options = { skipCovers: true, duration: true };
            // Preserve the tiny-file workaround used by the local scanner.
            const { format } = (await fs.stat(actualPath)).size < 128
                ? await parseBuffer(await fs.readFile(actualPath), { path: actualPath }, options)
                : await parseFile(actualPath, options);
            return Number.isFinite(format.duration) && format.duration > 0 ? format.duration : undefined;
        } catch {
            return undefined;
        }
    },
    watchDownloadDirectories: (directories: string[], notify: (event: DownloadWatchEvent) => void) => downloadWatcher.watch(directories, notify),
    stopDownloadWatcher: () => downloadWatcher.stop(),
    writeFile,
    readFile,
    isFile,
    isFolder,
    rimraf,
    addFileScheme,
};

/****** app utils *****/
function exitApp() {
    ipcRenderer.send("@shared/utils/exit-app");
}

async function getPath(pathName: "home" | "appData" | "userData" | "sessionData" | "temp" | "exe" | "module" | "desktop" | "documents" | "downloads" | "music" | "pictures" | "videos" | "recent" | "logs" | "crashDumps") {
    return await ipcRenderer.invoke("@shared/utils/app-get-path", pathName);
}

async function checkUpdate() {
    return await ipcRenderer.invoke("@shared/utils/check-update");
}

async function getCacheSize() {
    return await ipcRenderer.invoke("@shared/utils/get-cache-size");
}

async function clearCache() {
    ipcRenderer.send("@shared/utils/clear-cache");
}

const app = {
    exitApp,
    getPath,
    checkUpdate,
    getCacheSize,
    clearCache,
};


/****** window utils *****/
function minMainWindow(skipTaskBar: boolean) {
    ipcRenderer.send("@shared/utils/min-main-window", { skipTaskBar });
}

function showMainWindow() {
    ipcRenderer.send("@shared/utils/show-main-window");
}

function setLyricWindow(enabled: boolean) {
    ipcRenderer.send("@shared/utils/set-lyric-window", enabled);
}

function setMinimodeWindow(enabled: boolean) {
    ipcRenderer.send("@shared/utils/set-minimode-window", enabled);
}

function ignoreMouseEvent(ignore: boolean) {
    ipcRenderer.send("@shared/utils/ignore-mouse-event", ignore);
}

function toggleMainWindowVisible() {
    ipcRenderer.send("@shared/utils/toggle-main-window-visible");
}

function toggleMainWindowMaximize() {
    ipcRenderer.send("@shared/utils/toggle-maximize-main-window");
}

const appWindow = {
    minMainWindow,
    showMainWindow,
    setLyricWindow,
    setMinimodeWindow,
    ignoreMouseEvent,
    toggleMainWindowVisible,
    toggleMainWindowMaximize,
};

/****** shell utils *****/
function openExternal(url: string) {
    ipcRenderer.send("@shared/utils/open-url", url);
}

function openPath(path: string) {
    ipcRenderer.send("@shared/utils/open-path", path);
}

async function showItemInFolder(path: string): Promise<boolean> {
    return await ipcRenderer.invoke("@shared/utils/show-item-in-folder", path);
}

const shell = {
    openExternal,
    openPath,
    showItemInFolder,
};

/****** dialog utils *****/
function showOpenDialog(options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> {
    return ipcRenderer.invoke("@shared/utils/show-open-dialog", options);
}

function showSaveDialog(options: Electron.SaveDialogOptions): Promise<Electron.SaveDialogReturnValue> {
    return ipcRenderer.invoke("@shared/utils/show-save-dialog", options);
}

const dialog = {
    showOpenDialog,
    showSaveDialog,
};


const mod = {
    fs: fsUtil,
    app,
    appWindow,
    shell,
    dialog,
};

contextBridge.exposeInMainWorld("@shared/utils", mod);

