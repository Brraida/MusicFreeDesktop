import { localPluginHash, PlayerState, RepeatMode } from "@/common/constant";
import { isSupportedLocalMediaFile } from "@/common/local-media";
import MusicSheet from "../core/music-sheet";
import trackPlayer from "../core/track-player";
import localMusic from "../core/local-music";
import { setAutoFreeze } from "immer";
import Downloader from "../core/downloader";
import AppConfig from "@shared/app-config/renderer";
import { setupI18n } from "@/shared/i18n/renderer";
import ThemePack from "@/shared/themepack/renderer";
import { addToRecentlyPlaylist, setupRecentlyPlaylist } from "../core/recently-playlist";
import ServiceManager from "@shared/service-manager/renderer";
import { CurrentTime, PlayerEvents } from "@renderer/core/track-player/enum";
import { appWindowUtil, fsUtil } from "@shared/utils/renderer";
import PluginManager from "@shared/plugin-manager/renderer";
import messageBus from "@shared/message-bus/renderer/main";
import throttle from "lodash.throttle";
import { IAppState } from "@shared/message-bus/type";
import MusicDetail from "@renderer/components/MusicDetail";
import shortCut from "@shared/short-cut/renderer";
import logger from "@shared/logger/renderer";
import { setupBuiltinTheme } from "@shared/themepack/builtin";


setAutoFreeze(false);

async function initializeStage(stage: string, initialize: () => Promise<unknown>) {
    const started = Date.now();
    try {
        await initialize();
    } catch (error) {
        throw new Error(`${stage}初始化失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
        try {
            logger.logInfo("Startup stage", { stage, durationMs: Date.now() - started });
        } catch {
            // Diagnostics must not interfere with initialization.
        }
    }
}

export default async function () {
    await Promise.all([
        initializeStage("配置", async () => {
            await AppConfig.setup();
            setupBuiltinTheme();
        }),
        initializeStage("插件", () => PluginManager.setup()),
    ]);
    await Promise.all([
        initializeStage("歌单", () => MusicSheet.frontend.setupMusicSheets()),
        initializeStage("播放状态", () => trackPlayer.setup()),
    ]);
    await initializeStage("语言", setupI18n);
    shortCut.setup();
    dropHandler();
    clearDefaultBehavior();
    setupCommandAndEvents();
    setupDeviceChange();
    localMusic.setupLocalMusic();
    await initializeStage("下载记录", () => Downloader.setupDownloader(true));
    setupRecentlyPlaylist();
    // 本地服务
    ServiceManager.setup();

    // 自动更新插件
    if (AppConfig.getConfig("plugin.autoUpdatePlugin")) {
        const lastUpdated = +(localStorage.getItem("pluginLastupdatedTime") || 0);
        const now = Date.now();
        if (Math.abs(now - lastUpdated) > 86400000) {
            localStorage.setItem("pluginLastupdatedTime", `${now}`);
            PluginManager.updateAllPlugins();
        }
    }

}

function dropHandler() {
    document.addEventListener("drop", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        console.log(event);

        const validMusicList: IMusic.IMusicItem[] = [];
        for (const f of event.dataTransfer.files) {
            if (f.type === "" && (await fsUtil.isFolder(f.path))) {
                validMusicList.push(
                    ...(await PluginManager.callPluginDelegateMethod(
                        {
                            hash: localPluginHash,
                        },
                        "importMusicSheet",
                        f.path,
                    )),
                );
            } else if (
                isSupportedLocalMediaFile(f.path)
            ) {
                validMusicList.push(
                    await PluginManager.callPluginDelegateMethod(
                        {
                            hash: localPluginHash,
                        },
                        "importMusicItem",
                        f.path,
                    ),
                );
            } else if (f.path.endsWith(".mftheme")) {
                // 主题包
                const themeConfig = await ThemePack.installThemePack(f.path);
                if (themeConfig) {
                    await ThemePack.selectTheme(themeConfig);
                }
            }
        }
        if (validMusicList.length) {
            trackPlayer.playMusicWithReplaceQueue(validMusicList);
        }
    });

    document.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.stopPropagation();
    });
}

function clearDefaultBehavior() {
    const killSpaceBar = function (evt: any) {
        // https://greasyfork.org/en/scripts/25035-disable-space-bar-scrolling/code
        const target = evt.target || {},
            isInput =
                "INPUT" == target.tagName ||
                "TEXTAREA" == target.tagName ||
                "SELECT" == target.tagName ||
                "EMBED" == target.tagName;

        // if we're an input or not a real target exit
        if (isInput || !target.tagName) return;

        // if we're a fake input like the comments exit
        if (
            target &&
            target.getAttribute &&
            target.getAttribute("role") === "textbox"
        )
            return;

        // ignore the space
        if (evt.keyCode === 32) {
            evt.preventDefault();
        }
    };

    document.addEventListener("keydown", killSpaceBar, false);
}


/** 设置事件 */
function setupCommandAndEvents() {
    messageBus.onCommand("SkipToNext", () => {
        trackPlayer.skipToNext();
    });
    messageBus.onCommand("SkipToPrevious", () => {
        trackPlayer.skipToPrev();
    });
    messageBus.onCommand("TogglePlayerState", () => {
        if (trackPlayer.playerState === PlayerState.Playing) {
            trackPlayer.pause();
        } else {
            trackPlayer.resume();
        }
    });
    messageBus.onCommand("SetRepeatMode", (mode) => {
        trackPlayer.setRepeatMode(mode);
    });
    messageBus.onCommand("VolumeUp", (val = 0.04) => {
        trackPlayer.setVolume(Math.min(1, trackPlayer.volume + val));
    });

    messageBus.onCommand("VolumeDown", (val = 0.04) => {
        trackPlayer.setVolume(Math.max(0, trackPlayer.volume - val));
    });

    messageBus.onCommand("ToggleFavorite", async (item) => {
        const realItem = item || trackPlayer.currentMusic;
        if (MusicSheet.frontend.isFavoriteMusic(realItem)) {
            MusicSheet.frontend.removeMusicFromFavorite(realItem);
        } else {
            MusicSheet.frontend.addMusicToFavorite(realItem);
        }
    });

    messageBus.onCommand("ToggleDesktopLyric", () => {
        const enableDesktopLyric = AppConfig.getConfig("lyric.enableDesktopLyric");
        appWindowUtil.setLyricWindow(!enableDesktopLyric);
        AppConfig.setConfig({
            "lyric.enableDesktopLyric": !enableDesktopLyric,
        });
    });

    messageBus.onCommand("OpenMusicDetailPage", () => {
        MusicDetail.show();
    });

    messageBus.onCommand("ToggleMainWindowVisible", () => {
        appWindowUtil.toggleMainWindowVisible();
    });


    const sendAppStateTo = (from: "main" | number) => {
        const appState: IAppState = {
            repeatMode: trackPlayer.repeatMode || RepeatMode.Queue,
            playerState: trackPlayer.playerState || PlayerState.None,
            musicItem: trackPlayer.currentMusicBasicInfo || null,
            lyricText: trackPlayer.lyric?.currentLrc?.lrc || null,
            parsedLrc: trackPlayer.lyric?.currentLrc || null,
            fullLyric: trackPlayer.lyric?.parser?.getLyricItems() || [],
            lyricHasTimeline: trackPlayer.lyric?.parser?.hasTimeTags ?? false,
            lyricOffset: trackPlayer.lyric?.parser?.getMeta()?.offset ?? 0,
            progress: trackPlayer.progress?.currentTime || 0,
            duration: trackPlayer.progress?.duration || 0,
        };

        messageBus.syncAppState(appState, from);
    };

    messageBus.onCommand("SyncAppState", (_, from) => {
        sendAppStateTo(from);
    });
    sendAppStateTo("main");

    // 状态同步
    trackPlayer.on(PlayerEvents.StateChanged, state => {
        messageBus.syncAppState({
            playerState: state,
        });
    });

    trackPlayer.on(PlayerEvents.RepeatModeChanged, mode => {
        messageBus.syncAppState({
            repeatMode: mode,
        });
    });

    trackPlayer.on(PlayerEvents.CurrentLyricChanged, lyric => {
        messageBus.syncAppState({
            lyricText: lyric?.lrc ?? null,
            parsedLrc: lyric,
        });
    });

    trackPlayer.on(PlayerEvents.LyricChanged, lyric => {
        messageBus.syncAppState({
            fullLyric: lyric?.getLyricItems?.() || [],
            parsedLrc: trackPlayer.lyric?.currentLrc ?? null,
            lyricText: trackPlayer.lyric?.currentLrc?.lrc ?? null,
            lyricHasTimeline: lyric?.hasTimeTags ?? false,
            lyricOffset: lyric?.getMeta()?.offset ?? 0,
        });
    });

    const progressChangedHandler = throttle((currentTime: CurrentTime) => {
        messageBus.syncAppState({
            progress: currentTime?.currentTime || 0,
            duration: currentTime.duration || 0,
        });
    }, 800);

    trackPlayer.on(PlayerEvents.ProgressChanged, progressChangedHandler);

    // 最近播放
    trackPlayer.on(PlayerEvents.MusicChanged, (musicItem) => {
        messageBus.syncAppState({
            musicItem,
            lyricText: null,
            fullLyric: [],
            lyricHasTimeline: false,
            lyricOffset: 0,
            parsedLrc: null,
            progress: 0,
            duration: 0,
        });
        addToRecentlyPlaylist(musicItem);
    });
}

async function setupDeviceChange() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    let devices: MediaDeviceInfo[] = [];
    let generation = 0;
    const refresh = async (initial = false) => {
        const request = ++generation;
        let next: MediaDeviceInfo[];
        try {
            next = await navigator.mediaDevices.enumerateDevices();
        } catch (error) {
            console.error("Audio device enumeration failed", error); return;
        }
        if (request !== generation) return;
        const previousOutputs = devices.filter(device => device.kind === "audiooutput");
        const nextOutputs = next.filter(device => device.kind === "audiooutput");
        const selected = AppConfig.getConfig("playMusic.audioOutputDevice")?.deviceId;
        let removed: boolean;
        if (selected && selected !== "default" && selected !== "communications") {
            removed = previousOutputs.some(device => device.deviceId === selected) &&
                !nextOutputs.some(device => device.deviceId === selected);
        } else {
            const previousDefault = previousOutputs.find(device => device.deviceId === (selected || "default"));
            const nextDefault = nextOutputs.find(device => device.deviceId === (selected || "default"));
            removed = previousDefault?.groupId && nextDefault?.groupId
                ? previousDefault.groupId !== nextDefault.groupId
                : previousOutputs.some(device => !nextOutputs.some(next => next.deviceId === device.deviceId));
        }
        if (!initial && removed && AppConfig.getConfig("playMusic.whenDeviceRemoved") === "pause") trackPlayer.pause();
        devices = next;
    };
    navigator.mediaDevices.ondevicechange = () => {
        void refresh();
    };
    await refresh(true);
}
