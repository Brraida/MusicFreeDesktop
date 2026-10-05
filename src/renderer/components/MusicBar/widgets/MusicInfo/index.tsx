import SvgAsset from "@/renderer/components/SvgAsset";
import "./index.scss";

import Tag from "@/renderer/components/Tag";
import { secondsToDuration } from "@/common/time-util";
import MusicFavorite from "@/renderer/components/MusicFavorite";
import MusicDetail, { useMusicDetailShown } from "@/renderer/components/MusicDetail";
import { useTranslation } from "react-i18next";
import { useCurrentMusic, usePlayerState, useProgress } from "@renderer/core/track-player/hooks";
import VinylCover from "@/renderer/components/VinylCover";
import { PlayerState } from "@/common/constant";
import { getMediaPrimaryKey } from "@/common/media-util";
import { hidePanel, showPanel } from "@renderer/components/Panel";
import MusicDownloaded from "@renderer/components/MusicDownloaded";
import PluginManager from "@shared/plugin-manager/renderer";

export default function MusicInfo() {
    const musicItem = useCurrentMusic();
    const playerState = usePlayerState();
    const musicDetailShown = useMusicDetailShown();

    const { t } = useTranslation();

    function toggleMusicDetail() {
        if (musicDetailShown) {
            MusicDetail.hide();
        } else {
            MusicDetail.show();
            hidePanel();
        }
    }

    return (
        <div className="music-info-outer-container">
            <div data-detail-shown={musicDetailShown} className="music-info-content-container">
                <div className="music-info-container">
                    {!musicItem ? null : (
                        <>
                            <VinylCover
                                compact
                                role="button"
                                className="music-cover"
                                artwork={musicItem.artwork}
                                alt={musicItem.title || t("media.unknown_title")}
                                aria-label={musicDetailShown ? t("music_bar.close_music_detail_page") : t("music_bar.open_music_detail_page")}
                                tabIndex={musicDetailShown ? -1 : 0}
                                onClick={toggleMusicDetail}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter" || event.key === " ") {
                                        event.preventDefault();
                                        toggleMusicDetail();
                                    }
                                }}
                                playing={playerState === PlayerState.Playing}
                                active={!musicDetailShown}
                                trackKey={getMediaPrimaryKey(musicItem)}
                            />

                            <div
                                className="open-detail"
                                role="button"
                                title={musicDetailShown ? t("music_bar.close_music_detail_page") : t("music_bar.open_music_detail_page")}
                                onClick={toggleMusicDetail}
                            >
                                <SvgAsset
                                    iconName={
                                        musicDetailShown ? "chevron-double-down" : "chevron-double-up"
                                    }
                                ></SvgAsset>
                            </div>
                            <div className="music-info">
                                <div className="music-title">
                                    <span role="button" onClick={toggleMusicDetail}
                                        title={musicItem.title}>{musicItem.title}</span>
                                    <Tag
                                        fill
                                        style={{
                                            fontSize: "0.9rem",
                                        }}
                                    >
                                        {musicItem.platform}
                                    </Tag>
                                </div>
                                <div className="music-artist">
                                    <div className="artist">{musicItem.artist}</div>
                                    <Progress></Progress>
                                    <MusicFavorite musicItem={musicItem} size={18}></MusicFavorite>
                                </div>
                            </div>
                        </>
                    )}
                </div>
            </div>
            <div data-detail-shown={musicDetailShown}
                className="music-info-content-container music-info-operations-container">
                <div
                    className="open-detail"
                    role="button"
                    title={musicDetailShown ? t("music_bar.close_music_detail_page") : t("music_bar.open_music_detail_page")}
                    onClick={toggleMusicDetail}
                >
                    <SvgAsset
                        iconName={
                            musicDetailShown ? "chevron-double-down" : "chevron-double-up"
                        }
                    ></SvgAsset>
                </div>
                <MusicFavorite musicItem={musicItem} size={22}></MusicFavorite>
                <MusicDownloaded musicItem={musicItem} size={22}></MusicDownloaded>
                <div role="button"
                    data-disabled={!PluginManager.isSupportFeatureMethod(musicItem?.platform, "getMusicComments")}
                    onClick={() => {
                        showPanel("MusicComment", {
                            musicItem: musicItem,
                            coverHeader: true,
                        });
                    }}>
                    <SvgAsset iconName="chat-bubble-left-ellipsis" size={22}></SvgAsset>
                </div>
                <div className="music-info-operation-divider"></div>
                <Progress></Progress>
            </div>
        </div>
    );
}

function Progress() {
    const { currentTime, duration } = useProgress();
    return (
        <div className="progress">
            {isFinite(duration)
                ? `${secondsToDuration(currentTime)}/${secondsToDuration(duration)}`
                : null}
        </div>
    );
}
