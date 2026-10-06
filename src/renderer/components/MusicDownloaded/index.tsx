import { getMediaPrimaryKey, isSameMedia } from "@/common/media-util";
import SvgAsset, { SvgAssetIconNames } from "@/renderer/components/SvgAsset";
import { memo, useEffect, useRef } from "react";
import { DownloadResourceState, effectiveResourceState } from "@/common/download-resource";
import "./index.scss";
import { DownloadState, localPluginName } from "@/common/constant";
import Downloader from "@/renderer/core/downloader";
import { useTranslation } from "react-i18next";

interface IMusicDownloadedProps {
    musicItem: IMusic.IMusicItem;
    size?: number;
}

function MusicDownloaded(props: IMusicDownloadedProps) {
    const { musicItem, size = 18 } = props;
    // const [loading, setLoading] = useState(false);

    const downloadState = Downloader.useDownloadState(musicItem);
    const resource = Downloader.useDownloadResourceStatus(musicItem);
    const element = useRef<HTMLDivElement>(null);
    const pending = !!musicItem && musicItem.platform !== localPluginName && (resource.cached
        || (resource.state === DownloadResourceState.CHECKING && effectiveResourceState(resource) === DownloadResourceState.NO_RECORD));
    const key = getMediaPrimaryKey(musicItem);
    useEffect(() => {
        if (!pending || !element.current) return;
        const observer = new IntersectionObserver(entries => {
            if (!entries.some(entry => entry.isIntersecting)) return;
            observer.disconnect();
            void Downloader.prioritizeDownloadResource(musicItem).catch(() => {});
        });
        observer.observe(element.current);
        return () => observer.disconnect();
    }, [key, pending]);
    const checking = resource.state === DownloadResourceState.CHECKING
        && effectiveResourceState(resource) === DownloadResourceState.NO_RECORD;
    const unavailable = effectiveResourceState(resource) === DownloadResourceState.UNAVAILABLE;

    const { t } = useTranslation();
    const isDownloadedOrLocal =
    effectiveResourceState(resource) === DownloadResourceState.AVAILABLE ||
    downloadState === DownloadState.DONE ||
    musicItem?.platform === localPluginName;

    let iconName: SvgAssetIconNames = "array-download-tray";

    if (isDownloadedOrLocal) {
        iconName = "check-circle";
    } else if (checking && downloadState === DownloadState.NONE) {
        iconName = "rolling-1s";
    } else if (downloadState === DownloadState.PAUSED) {
        iconName = "pause";
    } else if (unavailable && (downloadState === DownloadState.NONE || downloadState === DownloadState.ERROR)) {
        iconName = "question-mark-circle";
    } else if (
        downloadState !== DownloadState.NONE &&
    downloadState !== DownloadState.ERROR
    ) {
        iconName = "rolling-1s";
    }

    const label = isDownloadedOrLocal ? t("common.downloaded")
        : downloadState === DownloadState.PAUSED ? t("download_page.paused")
            : checking ? t("download_page.checking")
                : unavailable ? t("download_page.local_unavailable", { reason: t("download_page.file_reasons." + resource.reason) }) : t("common.download");

    return (
        <div
            ref={element}
            data-cached={resource.cached || undefined}
            className={`music-download-base ${
                isDownloadedOrLocal ? "music-downloaded" : "music-can-download"
            }`}
            title={resource.cached && musicItem.platform !== localPluginName ? t("download_page.cached_status", { status: label }) : label}
            onClick={() => {
                if (
                    musicItem && (downloadState === DownloadState.NONE ||
                downloadState === DownloadState.ERROR)
                ) {
                    Downloader.startDownload(musicItem);
                }
            }}
        >
            <SvgAsset iconName={iconName} size={size}></SvgAsset>
        </div>
    );
}

export default memo(MusicDownloaded, (prev, curr) =>
    isSameMedia(prev.musicItem, curr.musicItem),
);
