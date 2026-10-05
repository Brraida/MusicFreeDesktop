import PQueue from "p-queue";
import { durationToSeconds } from "@/common/time-util";
import { getMediaPrimaryKey } from "@/common/media-util";
import { fsUtil } from "@shared/utils/renderer";
import PluginManager from "@shared/plugin-manager/renderer";
import musicSheetDB from "./db/music-sheet-db";

const queue = new PQueue({ concurrency: 3 });
const requests = new Map<string, { result: Promise<number | undefined>; expires: number }>();
const remembered = new Map<string, number>();

/** Patch existing records only; never recreate a song removed during an async read. */
export async function rememberMusicDuration(item: IMusic.IMusicItem, duration: unknown) {
    const seconds = durationToSeconds(duration);
    if (!(seconds > 0)) return;
    const key = getMediaPrimaryKey(item);
    if (remembered.get(key) === seconds) return;
    remembered.set(key, seconds);
    if (remembered.size > 2000) remembered.delete(remembered.keys().next().value);
    try {
        await musicSheetDB.transaction("rw", musicSheetDB.musicStore, musicSheetDB.localMusicStore, async () => {
            await musicSheetDB.musicStore.update([item.platform, item.id], { duration: seconds });
            await musicSheetDB.localMusicStore.update([item.platform, item.id], { duration: seconds });
        });
    } catch {
        remembered.delete(key);
        // Persistence failure must not hide valid metadata or interrupt playback.
    }
}

export function resolveMusicDuration(item: IMusic.IMusicItem, localPath?: string): Promise<number | undefined> {
    const supplied = durationToSeconds(item.duration);
    if (supplied > 0) return Promise.resolve(supplied);
    const key = getMediaPrimaryKey(item) + "\n" + (localPath ?? "remote");
    const cached = requests.get(key);
    if (cached && cached.expires > Date.now()) return cached.result;
    const entry = { expires: Infinity, result: undefined as Promise<number | undefined> };
    entry.result = queue.add(async () => {
        let seconds: number | undefined;
        try {
            if (localPath) seconds = await fsUtil.getLocalMusicDuration(localPath);
            if (!(seconds > 0) && PluginManager.getSupportedPlugin("getMusicInfo").some(plugin => plugin.platform === item.platform)) {
                let timer: ReturnType<typeof setTimeout>;
                try {
                    const info = await Promise.race([
                        PluginManager.callPluginDelegateMethod({ platform: item.platform }, "getMusicInfo", item),
                        new Promise<null>(resolve => {
                            timer = setTimeout(() => resolve(null), 8000);
                        }),
                    ]);
                    seconds = durationToSeconds(info?.duration);
                } finally {
                    clearTimeout(timer);
                }
            }
            if (seconds > 0) {
                await rememberMusicDuration(item, seconds);
                entry.expires = Date.now() + 3600000;
                return seconds;
            }
        } catch {
            // Missing/offline files and incomplete plugins have an explicit unknown duration.
        }
        entry.expires = Date.now() + 30000;
        return undefined;
    }) as Promise<number | undefined>;
    requests.set(key, entry);
    // Bound the session cache without evicting pending work and duplicating reads.
    if (requests.size > 2000) {
        for (const [oldKey, old] of requests) {
            if (oldKey !== key && old.expires !== Infinity) requests.delete(oldKey);
            if (requests.size <= 2000) break;
        }
    }
    return entry.result;
}
