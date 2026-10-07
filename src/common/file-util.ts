import { ICommonTagsResult, IPicture, parseBuffer, parseFile } from "music-metadata";
import path from "path";
import { localPluginName } from "./constant";
import { isSupportedLocalMediaFile } from "./local-media";
import CryptoJS from "crypto-js";
import fs from "fs/promises";
import TaskQueue from "./task-queue";
import url from "url";
import type { BigIntStats, PathLike, StatOptions, Stats } from "original-fs";

function getB64Picture(picture: IPicture) {
    return `data:${picture.format};base64,${picture.data.toString("base64")}`;
}

const specialEncoding = ["GB2312"];

export async function parseLocalMusicItem(
    filePath: string,
): Promise<IMusic.IMusicItem> {
    const hash = CryptoJS.MD5(filePath).toString();
    try {
        // music-metadata 8's trailing-tag probe can throw before closing its
        // tokenizer on files shorter than the 128-byte ID3v1 block. Buffering
        // only these tiny files preserves fallback metadata without leaking an FD.
        const size = (await fs.stat(filePath)).size;
        const { common = {} as ICommonTagsResult, format } = size < 128
            ? await parseBuffer(await fs.readFile(filePath), { path: filePath })
            : await parseFile(filePath);

        const jschardet = await import("jschardet");

        // 检测编码
        let encoding: string | null = null;
        let conf = 0;
        const testItems = [common.title, common.artist, common.album];

        for (const testItem of testItems) {
            if (!testItem) {
                continue;
            }
            const testResult = jschardet.detect(testItem, {
                minimumThreshold: 0.4,
            });
            if (testResult.confidence > conf) {
                conf = testResult.confidence;
                encoding = testResult.encoding;
            }

            if (conf > 0.9) {
                break;
            }
        }

        if (specialEncoding.includes(encoding)) {
            const iconv = await import("iconv-lite");

            if (common.title) {
                common.title = iconv.decode(
                    common.title as unknown as Buffer,
                    encoding,
                );
            }
            if (common.artist) {
                common.artist = iconv.decode(
                    common.artist as unknown as Buffer,
                    encoding,
                );
            }
            if (common.artist) {
                common.album = iconv.decode(
                    common.album as unknown as Buffer,
                    encoding,
                );
            }
            if (common.lyrics) {
                common.lyrics = common.lyrics.map((it) =>
                    it ? iconv.decode(it as unknown as Buffer, encoding) : "",
                );
            }
        }

        return {
            title: common.title ?? path.parse(filePath).name,
            artist: common.artist ?? "未知作者",
            artwork: common.picture?.[0]
                ? getB64Picture(common.picture[0])
                : undefined,
            album: common.album ?? "未知专辑",
            duration: Number.isFinite(format.duration) && format.duration > 0 ? format.duration : undefined,
            url: addFileScheme(filePath),
            localPath: filePath,
            platform: localPluginName,
            id: hash,
            rawLrc: common.lyrics?.join(""),
        };
    } catch (e) {
        return {
            title: path.parse(filePath).name || filePath,
            id: hash,
            platform: localPluginName,
            localPath: filePath,
            url: addFileScheme(filePath),
            artist: "未知作者",
            album: "未知专辑",
        };
    }
}

export async function parseLocalMusicItemFolder(
    folderPath: string,
): Promise<IMusic.IMusicItem[]> {
    /**
   * 1. 筛选出符合条件的
   */

    try {
        const folderStat = await fs.stat(folderPath);
        if (folderStat.isDirectory()) {
            const files = await fs.readdir(folderPath);
            const validFiles = files.filter(isSupportedLocalMediaFile);
            const queue = new TaskQueue();
            return Promise.all(
                validFiles.map((fp) =>
                    queue.run(() => parseLocalMusicItem(path.resolve(folderPath, fp))),
                ),
            );
        }
        throw new Error("Folder Not Found");
    } catch {
        return [];
    }
}

export function addFileScheme(filePath: string) {
    return filePath.startsWith("file:")
        ? filePath
        : url.pathToFileURL(filePath).toString();
}

export function addTailSlash(filePath: string) {
    return filePath.endsWith("/") || filePath.endsWith("\\")
        ? filePath
        : filePath + "/";
}

export async function safeStat(
    path: PathLike,
    opts?: StatOptions,
): Promise<Stats | BigIntStats | null> {
    try {
        return await fs.stat(path, opts);
    } catch {
        return null;
    }
}
