import * as Comlink from "comlink";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { encodeUrlHeaders } from "@/common/normalize-util";
import throttle from "lodash.throttle";
import { DownloadState } from "@/common/constant";

interface IDownloadResult {
    state: DownloadState;
    path?: string;
    downloaded?: number;
    total?: number;
    msg?: string;
}

type IOnStateChangeFunc = (data: IDownloadResult) => void;

const activeDownloads = new Map<string, AbortController>();
const reservedPaths = new Set<string>();
let paused = false;

async function pauseAllDownloads() {
    paused = true;
    activeDownloads.forEach((controller) => controller.abort());
}

function resumeAllDownloads() {
    paused = false;
}

async function reserveFilePath(filePath: string) {
    const { dir, name, ext } = path.parse(filePath);
    for (let suffix = 0; ; suffix++) {
        const candidate = suffix ? path.join(dir, `${name} (${suffix})${ext}`) : filePath;
        let exists = true;
        try {
            await fsPromises.stat(candidate);
        } catch (error) {
            if (error.code !== "ENOENT") {
                throw error;
            }
            exists = false;
        }
        if (!exists && !reservedPaths.has(candidate)) {
            reservedPaths.add(candidate);
            return candidate;
        }
    }
}

async function downloadFile(
    mediaSource: IMusic.IMusicSource,
    filePath: string,
    onStateChange: IOnStateChangeFunc,
    taskId = randomUUID(),
): Promise<IDownloadResult> {
    if (paused) {
        return { state: DownloadState.PAUSED };
    }
    const controller = new AbortController();
    activeDownloads.set(taskId, controller);
    let targetPath: string | undefined;
    let temporaryPath: string | undefined;
    let downloaded = 0;
    let total = 0;
    const reportProgress = throttle(() => {
        if (!controller.signal.aborted) {
            onStateChange({ state: DownloadState.DOWNLOADING, downloaded, total });
        }
    }, 100, { leading: true, trailing: true });

    try {
        await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
        targetPath = await reserveFilePath(filePath);
        temporaryPath = `${targetPath}.${randomUUID()}.part`;
        const headers: Record<string, string> = { ...(mediaSource.headers ?? {}) };
        if (mediaSource.userAgent) {
            headers["user-agent"] = mediaSource.userAgent;
        }
        const url = new URL(mediaSource.url);
        let response: Response;
        if (url.username && url.password) {
            headers.Authorization = `Basic ${Buffer.from(
                `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`,
            ).toString("base64")}`;
            url.username = "";
            url.password = "";
            response = await fetch(url.toString(), { headers, signal: controller.signal });
        } else {
            response = await fetch(encodeUrlHeaders(url.toString(), headers), { signal: controller.signal });
        }
        if (!response.ok || !response.body) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
        const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
        const unsupportedHls = () => new Error("HLS playlist downloads are not supported; choose a direct audio source.");
        if (["application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl", "audio/x-mpegurl"].includes(contentType)) {
            await response.body.cancel();
            throw unsupportedHls();
        }
        total = Number(response.headers.get("content-length")) || 0;
        onStateChange({ state: DownloadState.DOWNLOADING, downloaded, total });
        const progressStream = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
                downloaded += chunk.length;
                reportProgress();
                callback(null, chunk);
            },
        });
        const reader = response.body.getReader();
        const sourceStream = Readable.from((async function* () {
            const prefixChunks: Buffer[] = [];
            let prefixSize = 0;
            let checked = false;
            const checkPrefix = () => {
                const prefix = Buffer.concat(prefixChunks).subarray(0, 512).toString("utf8").trimStart();
                if (prefix.startsWith("#EXTM3U")) throw unsupportedHls();
            };
            try {
                while (true) {
                    const chunk = await reader.read();
                    if (chunk.done) {
                        if (!checked) {
                            checkPrefix();
                            for (const part of prefixChunks) yield part;
                        }
                        break;
                    }
                    const part = Buffer.from(chunk.value);
                    if (!checked) {
                        prefixChunks.push(part);
                        prefixSize += part.length;
                        if (prefixSize < 512 && !part.includes(10)) continue;
                        checkPrefix();
                        checked = true;
                        for (const prefixPart of prefixChunks) yield prefixPart;
                        prefixChunks.length = 0;
                    } else {
                        yield part;
                    }
                }
            } finally {
                await reader.cancel().catch(() => {
                    // The response may already have been aborted or closed.
                });
                reader.releaseLock();
            }
        })());
        await pipeline(
            sourceStream,
            progressStream,
            fs.createWriteStream(temporaryPath, { flags: "wx" }),
            { signal: controller.signal },
        );
        reportProgress.cancel();
        if (controller.signal.aborted) {
            return { state: DownloadState.PAUSED };
        }
        if (!downloaded) {
            throw new Error("Empty download");
        }
        // A file is complete only after both the network and the file writer finish.
        await fsPromises.rename(temporaryPath, targetPath);
        temporaryPath = undefined;
        return { state: DownloadState.DONE, path: targetPath, downloaded, total };
    } catch (error) {
        return controller.signal.aborted
            ? { state: DownloadState.PAUSED }
            : { state: DownloadState.ERROR, msg: error?.message };
    } finally {
        reportProgress.cancel();
        if (temporaryPath) {
            await fsPromises.rm(temporaryPath, { force: true }).catch(() => {
                // A failed cleanup must not change the terminal download result.
            });
        }
        if (targetPath) {
            reservedPaths.delete(targetPath);
        }
        activeDownloads.delete(taskId);
    }
}

Comlink.expose({ downloadFile, pauseAllDownloads, resumeAllDownloads });
