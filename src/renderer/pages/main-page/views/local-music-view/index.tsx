import localMusicListStore from "@/renderer/core/local-music/store";
import { useTranslation } from "react-i18next";

import "./index.scss";
import { showModal } from "@/renderer/components/Modal";
import SvgAsset from "@/renderer/components/SvgAsset";
import { useMemo, useState } from "react";
import SwitchCase from "@/renderer/components/SwitchCase";
import ListView from "./views/list";
import ArtistView from "./views/artist";
import AlbumView from "./views/album";
import FolderView from "./views/folder";
import useAppConfig from "@/hooks/useAppConfig";

enum DisplayView {
    LIST,
    ARTIST,
    ALBUM,
    FOLDER,
}

export default function LocalMusicView() {
    const { t } = useTranslation();
    const [displayView, setDisplayView] = useState(DisplayView.LIST);

    const localMusicList = localMusicListStore.useValue();
    const [inputSearch, setInputSearch] = useState("");
    const caseSensitive = useAppConfig("playMusic.caseSensitiveInSearch");
    // Derived rows share the input/library/config render instead of publishing
    // a second state update and an intermediate transition with obsolete rows.
    const finalMusicList = useMemo(() => {
        if (!inputSearch.trim()) return localMusicList;
        const query = caseSensitive ? inputSearch : inputSearch.toLocaleLowerCase();
        return localMusicList.filter(item => [item.title, item.artist, item.album].some(value =>
            caseSensitive ? value?.includes(query) : value?.toLocaleLowerCase().includes(query)));
    }, [inputSearch, localMusicList, caseSensitive]);

    return (
        <div
            id="page-container"
            className="page-container local-music-view--container"
            data-full-page={displayView !== DisplayView.LIST}
        >
            <div className="header">{t("local_music_page.local_music")}</div>
            <div className="operations">
                <div
                    data-type="normalButton"
                    role="button"
                    onClick={() => {
                        showModal("WatchLocalDir");
                    }}
                >
                    {t("local_music_page.auto_scan")}
                </div>
                <div className="operations-layout">
                    <input
                        className="search-local-music"
                        spellCheck={false}
                        onChange={(evt) => {
                            setInputSearch(evt.target.value);
                        }}
                        placeholder={t("local_music_page.search_local_music")}
                    ></input>
                    <div
                        className="list-view-action"
                        data-selected={displayView === DisplayView.LIST}
                        title={t("local_music_page.list_view")}
                        onClick={() => {
                            setDisplayView(DisplayView.LIST);
                        }}
                    >
                        <SvgAsset iconName="musical-note"></SvgAsset>
                    </div>
                    <div
                        className="list-view-action"
                        data-selected={displayView === DisplayView.ARTIST}
                        title={t("local_music_page.artist_view")}
                        onClick={() => {
                            setDisplayView(DisplayView.ARTIST);
                        }}
                    >
                        <SvgAsset iconName="user"></SvgAsset>
                    </div>
                    <div
                        className="list-view-action"
                        data-selected={displayView === DisplayView.ALBUM}
                        title={t("local_music_page.album_view")}
                        onClick={() => {
                            setDisplayView(DisplayView.ALBUM);
                        }}
                    >
                        <SvgAsset iconName="cd"></SvgAsset>
                    </div>
                    <div
                        className="list-view-action"
                        data-selected={displayView === DisplayView.FOLDER}
                        title={t("local_music_page.folder_view")}
                        onClick={() => {
                            setDisplayView(DisplayView.FOLDER);
                        }}
                    >
                        <SvgAsset iconName="folder-open"></SvgAsset>
                    </div>
                </div>
            </div>
            <SwitchCase.Switch switch={displayView}>
                <SwitchCase.Case case={DisplayView.LIST}>
                    <ListView localMusicList={finalMusicList}></ListView>
                </SwitchCase.Case>
                <SwitchCase.Case case={DisplayView.ARTIST}>
                    <ArtistView localMusicList={finalMusicList}></ArtistView>
                </SwitchCase.Case>
                <SwitchCase.Case case={DisplayView.ALBUM}>
                    <AlbumView localMusicList={finalMusicList}></AlbumView>
                </SwitchCase.Case>
                <SwitchCase.Case case={DisplayView.FOLDER}>
                    <FolderView localMusicList={finalMusicList}></FolderView>
                </SwitchCase.Case>
            </SwitchCase.Switch>
        </div>
    );
}
