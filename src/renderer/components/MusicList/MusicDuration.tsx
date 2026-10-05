import { useEffect, useRef, useState } from "react";
import { durationToSeconds, secondsToDuration } from "@/common/time-util";
import { getMediaPrimaryKey, isSameMedia } from "@/common/media-util";
import { localPluginName } from "@/common/constant";
import { DownloadResourceState, effectiveResourceState } from "@/common/download-resource";
import Downloader from "@/renderer/core/downloader";
import trackPlayer from "@/renderer/core/track-player";
import { PlayerEvents } from "@/renderer/core/track-player/enum";
import { rememberMusicDuration, resolveMusicDuration } from "@/renderer/core/music-duration";

export default function MusicDuration({ musicItem }: { musicItem: IMusic.IMusicItem }) {
    const resource = Downloader.useDownloadResourceStatus(musicItem);
    const localPath = musicItem.platform === localPluginName
        ? musicItem.$$localPath || musicItem.localPath || musicItem.url
        : effectiveResourceState(resource) === DownloadResourceState.AVAILABLE ? resource.path : undefined;
    const supplied = durationToSeconds(musicItem.duration);
    const [resolved, setResolved] = useState<number>();
    const key = getMediaPrimaryKey(musicItem);
    const cellRef = useRef<HTMLSpanElement>(null);

    useEffect(() => {
        let active = true;
        setResolved(undefined);
        if (supplied > 0) return;
        // Request only rows that enter the viewport, including lists without virtualization.
        const observer = new IntersectionObserver(entries => {
            if (!entries.some(entry => entry.isIntersecting)) return;
            observer.disconnect();
            void resolveMusicDuration(musicItem, localPath).then(seconds => {
                if (active && seconds > 0) setResolved(seconds);
            });
        });
        if (cellRef.current) observer.observe(cellRef.current);
        const onProgress = () => {
            if (!isSameMedia(trackPlayer.currentMusic, musicItem)) return;
            const duration = durationToSeconds(trackPlayer.progress?.duration);
            if (duration > 0) {
                setResolved(duration);
                void rememberMusicDuration(musicItem, duration);
            }
        };
        onProgress();
        const unsubscribe = trackPlayer.on(PlayerEvents.ProgressChanged, onProgress);
        return () => {
            active = false;
            observer.disconnect();
            unsubscribe();
        };
    }, [key, supplied, localPath]);

    const seconds = supplied > 0 ? supplied : resolved;
    return <span ref={cellRef}>{seconds > 0 ? secondsToDuration(seconds) : "--:--"}</span>;
}
