import SvgAsset from "@/renderer/components/SvgAsset";
import { PlayerState } from "@/common/constant";
import albumImg from "@/assets/imgs/album-cover.jpg";
import VinylCover from "@/renderer/components/VinylCover";
import { getMediaPrimaryKey } from "@/common/media-util";
import useLyricPair from "@/renderer/utils/use-lyric-pair";
import "./index.scss";
import { useTranslation } from "react-i18next";
import { appWindowUtil } from "@shared/utils/renderer";
import messageBus from "@shared/message-bus/renderer/extension";

export default function MinimodePage() {
    const { pair, musicItem, playerState } = useLyricPair();
    const { t } = useTranslation();
    const playing = playerState === PlayerState.Playing;
    const currentText = pair.current?.lrc || (pair.phase === "instrumental"
        ? t("lyric_pair.instrumental") : musicItem?.title || t("media.unknown_title"));
    const nextText = pair.next?.lrc || "";
    const title = (musicItem?.title || t("media.unknown_title")) + " - "
        + (musicItem?.artist || t("media.unknown_artist"));

    return (
        <div className="minimode-page-container">
            <div className="minimode-header-container">
                <div className="mini-mode-header-background-mask"></div>
                <div className="mini-mode-header-background" style={{
                    backgroundImage: `url(${musicItem?.artwork || albumImg})`,
                }}></div>
                <div className="mini-cover-container">
                    <VinylCover
                        compact title={title} role="button" tabIndex={0}
                        className="album-container" artwork={musicItem?.artwork}
                        alt={musicItem?.title || t("media.unknown_title")}
                        playing={!!musicItem && playing}
                        trackKey={musicItem ? getMediaPrimaryKey(musicItem) : undefined}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                appWindowUtil.showMainWindow();
                            }
                        }}
                        onDoubleClick={() => appWindowUtil.showMainWindow()}
                    />
                    <div className="options-container">
                        <button className="option-item" title={t("music_bar.previous_music")}
                            aria-label={t("music_bar.previous_music")}
                            onClick={() => messageBus.sendCommand("SkipToPrevious")}>
                            <SvgAsset iconName="skip-left" />
                        </button>
                        <button className="option-item" title={t("media.music_state_play_or_pause")}
                            aria-label={t("media.music_state_play_or_pause")}
                            onClick={() => messageBus.sendCommand("TogglePlayerState")}>
                            <SvgAsset iconName={playing ? "pause" : "play"} />
                        </button>
                        <button className="option-item" title={t("music_bar.next_music")}
                            aria-label={t("music_bar.next_music")}
                            onClick={() => messageBus.sendCommand("SkipToNext")}>
                            <SvgAsset iconName="skip-right" />
                        </button>
                        <button className="close-button" title={t("common.exit")}
                            aria-label={t("common.exit")}
                            onClick={() => {
                                appWindowUtil.setMinimodeWindow(false);
                                appWindowUtil.showMainWindow();
                            }}>
                            <SvgAsset iconName="x-mark" />
                        </button>
                    </div>
                </div>
                <div className="body-container">
                    <div className="text-container" data-phase={pair.phase}>
                        <span className="mini-current-lyric" title={currentText}
                            aria-label={t("lyric_pair.current")}>{currentText}</span>
                        <span className="mini-next-lyric" title={nextText} aria-label={t("lyric_pair.next")}
                            data-empty={!nextText}>{nextText || "\u00a0"}</span>
                    </div>
                </div>
            </div>
        </div>
    );
}
