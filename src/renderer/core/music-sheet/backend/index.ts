/**
 * 这里不应该写任何和UI有关的逻辑，只是简单的数据库操作
 *
 * 除了frontend文件夹外，其他任何地方不应该直接调用此处定义的函数
 */

import { localPluginName, musicRefSymbol, sortIndexSymbol, timeStampSymbol } from "@/common/constant";
import { nanoid } from "nanoid";
import musicSheetDB from "../../db/music-sheet-db";
import { produce } from "immer";
import defaultSheet from "../common/default-sheet";
import { getMediaPrimaryKey, isSameMedia } from "@/common/media-util";
import { getUserPreferenceIDB, setUserPreferenceIDB } from "@/renderer/utils/user-perference";

/******************** 内存缓存 ***********************/
// 默认歌单，快速判定是否在列表中
const favoriteMusicListIds = new Set<string>();
// 全部的歌单列表(无详情，只有ID)
let musicSheets: IMusic.IDBMusicSheetItem[] = [];
// 星标的歌单信息
let starredMusicSheets: IMedia.IMediaBase[] = [];

/******************** 方法 ***********************/

/**
 * 获取全部音乐信息
 * @returns
 */
export function getAllSheets() {
    return musicSheets;
}

export function getAllStarredSheets() {
    return starredMusicSheets;
}

/**
 *
 * 查询所有歌单信息（无详情）
 *
 * @returns 全部歌单信息
 */
export async function queryAllSheets() {
    try {
        // 读取全部歌单
        const allSheets = await musicSheetDB.sheets.toArray();

        const defaultSheetIndex = allSheets.findIndex(item => item.id === defaultSheet.id);

        if (allSheets.length === 0 || defaultSheetIndex === -1) {
            await musicSheetDB.transaction(
                "readwrite",
                musicSheetDB.sheets,
                async () => {
                    musicSheetDB.sheets.put(defaultSheet);
                },
            );
            musicSheets = [defaultSheet, ...allSheets];
        } else {
            const dbDefaultSheet = allSheets.find(
                (item) => item.id === defaultSheet.id,
            );
            dbDefaultSheet.musicList.forEach((mi) => {
                favoriteMusicListIds.add(getMediaPrimaryKey(mi));
            });
            musicSheets = allSheets;

            if (defaultSheetIndex !== 0) {
                allSheets.splice(defaultSheetIndex, 1);
                allSheets.unshift(dbDefaultSheet);
            }
        }

        // 收藏歌单
        return musicSheets;
    } catch (e) {
        console.log(e);
        return musicSheets;
    }
}

/**
 * 查询所有收藏歌单
 * @returns 收藏歌单信息
 */
export async function queryAllStarredSheets() {
    try {
        starredMusicSheets =
            (await getUserPreferenceIDB("starredMusicSheets")) || [];
        return starredMusicSheets;
    } catch {
        return [];
    }
}

/**
 * 新建歌单
 * @param sheetName 歌单名
 * @returns 新建的歌单信息
 */
export async function addSheet(sheetName: string) {
    const id = nanoid();
    const newSheet: IMusic.IMusicSheetItem = {
        id,
        title: sheetName,
        createAt: Date.now(),
        platform: localPluginName,
        musicList: [],
        $$sortIndex: musicSheets[musicSheets.length - 1].$$sortIndex + 1,
    };
    try {
        await musicSheetDB.transaction(
            "readwrite",
            musicSheetDB.sheets,
            async () => {
                musicSheetDB.sheets.put(newSheet);
            },
        );
        musicSheets = [...musicSheets, newSheet];
        return newSheet;
    } catch {
        throw new Error("新建失败");
    }
}

/**
 * 更新歌单信息
 * @param sheetId 歌单ID
 * @param newData 最新的歌单信息
 * @returns
 */
export async function updateSheet(
    sheetId: string,
    newData: Partial<IMusic.IMusicSheetItem>,
) {
    try {
        if (!newData) {
            return;
        }
        await musicSheetDB.transaction(
            "readwrite",
            musicSheetDB.sheets,
            async () => {
                musicSheetDB.sheets.update(sheetId, newData);
            },
        );

        musicSheets = produce(musicSheets, (draft) => {
            const currentIndex = draft.findIndex((_) => _.id === sheetId);
            if (currentIndex === -1) {
                draft.push(newData as IMusic.IDBMusicSheetItem);
            } else {
                draft[currentIndex] = {
                    ...draft[currentIndex],
                    ...newData,
                };
            }
        });
    } catch (e) {
        // 更新歌单信息失败
        console.log(e);
    }
}

/**
 * 移除歌单
 * @param sheetId 歌单ID
 * @returns 删除后的ID
 */
export async function removeSheet(sheetId: string) {
    if (sheetId === defaultSheet.id) return;
    await musicSheetDB.transaction(
        "rw", musicSheetDB.sheets, musicSheetDB.musicStore, async () => {
            await removeMusicInTransaction(sheetId, () => true);
            await musicSheetDB.sheets.delete(sheetId);
        },
    );
    musicSheets = musicSheets.filter(item => item.id !== sheetId);
    return musicSheets;
}

/** 清空歌曲，原有歌单信息保留。 */
export async function clearSheet(sheetId: string) {
    const sheet = await musicSheetDB.transaction(
        "rw", musicSheetDB.sheets, musicSheetDB.musicStore,
        () => removeMusicInTransaction(sheetId, () => true),
    );
    publishCommittedSheet(sheet);
    return musicSheets;
}

/**
 * 收藏歌单
 * @param sheet
 */
export async function starMusicSheet(sheet: IMedia.IMediaBase) {
    const newSheets = [...starredMusicSheets, sheet];
    await setUserPreferenceIDB("starredMusicSheets", newSheets);
    starredMusicSheets = newSheets;
}

/**
 * 取消收藏歌单
 * @param sheet
 */
export async function unstarMusicSheet(sheet: IMedia.IMediaBase) {
    const newSheets = starredMusicSheets.filter(
        (item) => !isSameMedia(item, sheet),
    );
    await setUserPreferenceIDB("starredMusicSheets", newSheets);
    starredMusicSheets = newSheets;
}

/**
 * 收藏歌单排序
 */

export async function setStarredMusicSheets(sheets: IMedia.IMediaBase[]) {
    await setUserPreferenceIDB("starredMusicSheets", sheets);
    starredMusicSheets = sheets;
}

/**************************** 歌曲相关方法 ************************/

/**
 * 添加歌曲到歌单
 * @param musicItems
 * @param sheetId
 * @returns
 */
export async function addMusicToSheet(
    musicItems: IMusic.IMusicItem | IMusic.IMusicItem[],
    sheetId: string,
) {
    const items = Array.isArray(musicItems) ? musicItems : [musicItems];
    const sheet = await musicSheetDB.transaction(
        "rw", musicSheetDB.musicStore, musicSheetDB.sheets, async () => {
            const target = await musicSheetDB.sheets.get(sheetId);
            if (!target) throw new Error("Music sheet not found");
            // Both duplicate input and competing writers are checked against the
            // latest persisted state inside the same read/write transaction.
            const keys = new Set((target.musicList ?? []).map(getMediaPrimaryKey));
            const valid = items.filter(item => {
                const key = getMediaPrimaryKey(item);
                if (keys.has(key)) return false;
                keys.add(key);
                return true;
            });
            if (!valid.length) return target;
            const records = await musicSheetDB.musicStore.bulkGet(valid.map(item => [item.platform, item.id]));
            await musicSheetDB.musicStore.bulkPut(records.map((record, index) => record ? {
                ...record, [musicRefSymbol]: (record[musicRefSymbol] ?? 0) + 1,
            } : { ...valid[index], [musicRefSymbol]: 1 }));
            const timeStamp = Date.now();
            target.artwork = valid[valid.length - 1]?.artwork ?? target.artwork;
            target.musicList = [...(target.musicList ?? []), ...valid.map((item, index) => ({
                platform: item.platform, id: item.id,
                [sortIndexSymbol]: index, [timeStampSymbol]: timeStamp,
            }))];
            await musicSheetDB.sheets.put(target);
            return target;
        },
    );
    publishCommittedSheet(sheet);
    return musicSheets;
}

function publishCommittedSheet(sheet: IMusic.IDBMusicSheetItem) {
    const existing = musicSheets.some(item => item.id === sheet.id);
    musicSheets = existing ? musicSheets.map(item => item.id === sheet.id ? sheet : item) : [...musicSheets, sheet];
    if (sheet.id === defaultSheet.id) {
        favoriteMusicListIds.clear();
        sheet.musicList.forEach(item => favoriteMusicListIds.add(getMediaPrimaryKey(item)));
    }
}

// Called only from a transaction. Cache/index changes happen after its commit.
async function removeMusicInTransaction(sheetId: string, shouldRemove: (item: IMedia.IMediaBase) => boolean) {
    const sheet = await musicSheetDB.sheets.get(sheetId);
    if (!sheet) throw new Error("Music sheet not found");
    const removed = (sheet.musicList ?? []).filter(shouldRemove);
    const remaining = (sheet.musicList ?? []).filter(item => !shouldRemove(item));
    const removedCounts = new Map<string, { item: IMedia.IMediaBase; count: number }>();
    for (const item of removed) {
        const key = getMediaPrimaryKey(item);
        const entry = removedCounts.get(key);
        if (entry) ++entry.count;
        else removedCounts.set(key, { item, count: 1 });
    }
    const entries = [...removedCounts.values()];
    const records = await musicSheetDB.musicStore.bulkGet(entries.map(({ item }) => [item.platform, item.id]));
    const deleted: Array<[string, string | number]> = [];
    const updated: typeof records = [];
    records.forEach((record, index) => {
        if (!record) return;
        const references = (record[musicRefSymbol] ?? 0) - entries[index].count;
        if (references <= 0) deleted.push([record.platform, record.id]);
        else updated.push({ ...record, [musicRefSymbol]: references });
    });
    await musicSheetDB.musicStore.bulkDelete(deleted);
    await musicSheetDB.musicStore.bulkPut(updated);
    const last = remaining[remaining.length - 1];
    sheet.artwork = last ? (await musicSheetDB.musicStore.get([last.platform, last.id]))?.artwork : undefined;
    sheet.musicList = remaining;
    await musicSheetDB.sheets.put(sheet);
    return sheet;
}

/** 从歌单内移除歌曲；并发添加不会被旧缓存覆盖。 */
export async function removeMusicFromSheet(
    musicItems: IMusic.IMusicItem | IMusic.IMusicItem[],
    sheetId: string,
) {
    const items = Array.isArray(musicItems) ? musicItems : [musicItems];
    const keys = new Set(items.map(getMediaPrimaryKey));
    const sheet = await musicSheetDB.transaction(
        "rw", musicSheetDB.sheets, musicSheetDB.musicStore,
        () => removeMusicInTransaction(sheetId, item => keys.has(getMediaPrimaryKey(item))),
    );
    publishCommittedSheet(sheet);
}

/** 获取歌单内的歌曲详细信息 */
export async function getSheetItemDetail(
    sheetId: string,
): Promise<IMusic.IMusicSheetItem | null> {
    // 取太多歌曲时会卡顿， 1000首歌大约100ms
    const targetSheet = musicSheets.find((item) => item.id === sheetId);
    if (!targetSheet) {
        return null;
    }
    const tmpResult = [];
    const musicList = targetSheet.musicList ?? [];
    // 一组800个
    const groupSize = 800;
    const groupNum = Math.ceil(musicList.length / groupSize);

    for (let i = 0; i < groupNum; ++i) {
        const sliceResult = await musicSheetDB.transaction(
            "readonly",
            musicSheetDB.musicStore,
            async () => {
                return await musicSheetDB.musicStore.bulkGet(
                    musicList
                        .slice(i * groupSize, (i + 1) * groupSize)
                        .map((item) => [item.platform, item.id]),
                );
            },
        );

        tmpResult.push(...(sliceResult ?? []));
    }

    return {
        ...targetSheet,
        musicList: tmpResult,
    } as IMusic.IMusicSheetItem;
}

/**
 * 某首歌是否被标记为喜欢
 * @param musicItem
 * @returns
 */
export function isFavoriteMusic(musicItem: IMusic.IMusicItem) {
    return favoriteMusicListIds.has(getMediaPrimaryKey(musicItem));
}

/** 导出所有歌单信息 */
export async function exportAllSheetDetails() {
    return await musicSheetDB.transaction(
        "readonly",
        musicSheetDB.musicStore,
        async () => {
            const allSheets = musicSheets;
            if (!allSheets) {
                return [];
            }
            const musicLists = await Promise.all(
                allSheets.map((sheet) =>
                    musicSheetDB.musicStore.bulkGet(
                        (sheet.musicList ?? []).map((item) => [item.platform, item.id]),
                    ),
                ),
            );

            const allSheetDetails = produce(allSheets, (draft) => {
                draft.forEach((sheet, index) => {
                    sheet.musicList = musicLists[index];
                });
            });

            return allSheetDetails;
        },
    );
}
