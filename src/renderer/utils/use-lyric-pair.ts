import { useMemo } from "react";
import { useAppState } from "@shared/message-bus/renderer/extension";
import { deriveLyricPair } from "./lyric-pair";

export default function useLyricPair() {
    // Both texts are computed from one snapshot, including the initial handshake.
    const state = useAppState();
    const pair = useMemo(() => deriveLyricPair(state.fullLyric ?? [], state.parsedLrc, state.lyricHasTimeline),
        [state.fullLyric, state.parsedLrc, state.lyricHasTimeline]);
    return { pair, musicItem: state.musicItem, playerState: state.playerState,
        progress: state.progress ?? 0, duration: state.duration ?? 0, offset: state.lyricOffset ?? 0 };
}
