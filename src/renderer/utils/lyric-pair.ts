import type { IParsedLrcItem } from "./lyric-parser";

export interface ILyricPair {
    current?: IParsedLrcItem;
    next?: IParsedLrcItem;
    /** First later timestamp, including an instrumental/blank entry. */
    endTime?: number;
    phase: "line" | "intro" | "instrumental" | "empty" | "unsynced" | "loading";
}

/** The parser owns playback timing; attached windows only project its snapshot. */
export function deriveLyricPair(
    fullLyric: IParsedLrcItem[] = [], current?: IParsedLrcItem | null, hasTimeline?: boolean,
): ILyricPair {
    if (!fullLyric.length) return { phase: "empty" };
    const readable = (item: IParsedLrcItem) => Number.isFinite(item.time) && !!item.lrc?.trim();
    // Fallback supports an older sender; an explicit flag distinguishes a real
    // [00:00] line from untimed plain text whose timestamps are all zero.
    if (!(hasTimeline ?? fullLyric.some(item => item.time > 0))) return { phase: "unsynced" };
    if (!current) return { phase: "intro", next: fullLyric.find(readable) };
    const matches = (item: IParsedLrcItem) => item?.time === current.time
        && item?.lrc === current.lrc && item?.index === current.index;
    const position = matches(fullLyric[current.index]) ? current.index : fullLyric.findIndex(matches);
    if (position < 0) return { phase: "loading" };
    let next: IParsedLrcItem;
    let endTime: number;
    for (let i = position + 1; i < fullLyric.length; ++i) {
        const item = fullLyric[i];
        if (!Number.isFinite(item.time) || item.time <= current.time) continue;
        endTime ??= item.time;
        if (readable(item)) {
            next = item;
            break;
        }
    }
    return { current: readable(current) ? current : undefined, next, endTime,
        phase: readable(current) ? "line" : "instrumental" };
}
