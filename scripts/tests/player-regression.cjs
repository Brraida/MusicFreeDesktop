const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const { load, deferred } = require("./source-loader.cjs");
const A = { platform: "test", id: "A", title: "A" };
const B = { ...A, id: "B", title: "B" };

function createPlayer({ delay = async () => {}, downloaded, files = {}, internalData = () => undefined, reconcile } = {}) {
    const constants = load("src/common/constant.ts");
    const resource = load("src/common/download-resource.ts");
    const media = {
        isSameMedia: (a, b) => !!a && !!b && a.id === b.id && a.platform === b.platform,
        getInternalData: internalData, getQualityOrder: () => ["standard"],
        addSortProperty() {}, sortByTimestampAndIndex: a => a,
    };
    const Store = load("src/common/store.ts", { react: {} }).default;
    const stores = load("src/renderer/core/track-player/store.ts", {
        "@/common/store": Store, "@/common/constant": constants,
    }).default;
    class Audio {
        resetCount = 0; tracks = [];
        get hasSource() {
            return this.tracks.length > 0;
        }
        reset() {
            this.musicItem = null;
            this.resetCount++;
        }
        prepareTrack() {} play() {
            this.playing = true;
        } pause() {
            this.playing = false;
        } seekTo(seconds) {
            this.seek = seconds;
        }
        setVolume() {} setSpeed() {}
        setTrackSource(source, song) {
            this.musicItem = song; this.tracks.push({ source, song });
        }
    }
    class Lyric {
        constructor(raw, options) {
            this.raw = raw; this.musicItem = options.musicItem;
        }
        getPosition() {
            return { lrc: this.raw };
        }
    }
    const plugins = { callPluginDelegateMethod: async () => null };
    const player = load("src/renderer/core/track-player/index.ts", {
        "./enum": load("src/renderer/core/track-player/enum.ts"),
        "@/common/download-resource": resource, "@/common/media-util": media, "@/common/constant": constants,
        "@/renderer/utils/lyric-parser": Lyric,
        "@/renderer/utils/user-perference": { setUserPreference() {}, setUserPreferenceIDB() {}, removeUserPreference() {} },
        "@shared/app-config/renderer": { getConfig: key => key === "playMusic.playError" ? "skip" : "standard" },
        "@/common/index-map": { createIndexMap: () => ({ update() {}, indexOf: a => a?.id === "A" ? 0 : 1 }) },
        "./store": stores, eventemitter3: EventEmitter,
        "@renderer/core/track-player/controller/audio-controller": Audio,
        "@shared/logger/renderer": { logError() {} }, "@/common/void-callback": () => {},
        "@/common/time-util": { delay }, "@/common/unique-map": {},
        "@renderer/core/link-lyric": { getLinkedLyric: async () => null },
        "@renderer/core/downloader/downloaded-sheet": {
            getDownloadedMusicItem: item => item?.id === downloaded?.id ? downloaded : undefined,
            refreshDownloadedMusicItem: reconcile ?? (async () => ({ state: downloaded && await files.isFile(internalData(downloaded).path)
                ? resource.DownloadResourceState.AVAILABLE : resource.DownloadResourceState.NO_RECORD })),
        },
        "@shared/utils/renderer": { fsUtil: files }, "@shared/plugin-manager/renderer": plugins,
    }).default;
    player.setMusicQueue([A, B]);
    return { player, stores, plugins };
}
const source = (url, quality = "standard") => ({ mediaSource: { url }, quality });
const tick = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
};

(async () => {
    // A view may still hold the old metadata after automatic path reconciliation.
    {
        const updated = { ...A, downloadData: { path: "new/A.mp3", quality: "high" } };
        const { player, plugins } = createPlayer({ downloaded: updated,
            internalData: song => song.downloadData,
            files: { isFile: async fp => fp === "new/A.mp3", addFileScheme: fp => "file://" + fp },
        });
        plugins.callPluginDelegateMethod = () => {
            throw new Error("Relocated downloads must use the local file");
        };
        const result = await player.fetchMediaSource({ ...A, downloadData: { path: "old/A.mp3" } });
        assert.equal(result.mediaSource.url, "file://new/A.mp3");
        assert.equal(result.quality, "high");
    }
    // Missing files update resource state before selecting the online source.
    {
        const downloaded = { ...A, downloadData: { path: "gone.mp3", quality: "high" } };
        let checks = 0;
        const { player, plugins } = createPlayer({ downloaded, internalData: song => song?.downloadData,
            reconcile: async () => {
                checks++; return { state: "MISSING" };
            },
        });
        plugins.callPluginDelegateMethod = async () => ({ url: "online" });
        assert.equal((await player.fetchMediaSource(A)).mediaSource.url, "online");
        assert.equal(checks, 1);
    }
    // An actual local open error gets one guarded network fallback, preserving seek/pause intent.
    for (const paused of [false, true]) {
        const downloaded = { ...A, downloadData: { path: "local.mp3", quality: "high" } };
        const reconciled = [];
        const held = deferred();
        const { player, plugins, stores } = createPlayer({ downloaded, internalData: song => song?.downloadData,
            files: { addFileScheme: fp => "file://" + fp },
            reconcile: async (_song, failedPath) => {
                reconciled.push(failedPath); return { state: failedPath ? "UNAVAILABLE" : "AVAILABLE" };
            },
        });
        player.createAudioController(); player.fetchCurrentLyric = async () => {};
        let calls = 0;
        plugins.callPluginDelegateMethod = async (_context, method) => method === "getMediaSource" ? (++calls, held.promise) : null;
        await player.playIndex(0); stores.progressStore.setValue({ currentTime: 7, duration: 20 });
        // Cancelling a quality switch must leave the installed local source eligible for recovery.
        await player.setQuality(player.currentQuality);
        const recovering = player.audioController.onError(0, new Error("local open failed"));
        await tick();
        await player.audioController.onError(0, new Error("duplicate local error"));
        if (paused) player.pause();
        held.resolve({ url: "network" }); await recovering;
        assert.equal(player.audioController.tracks.at(-1).source.url, "network");
        assert.equal(player.audioController.seek, 7); assert.equal(player.audioController.playing, !paused);
        assert.equal(calls, 1); assert(reconciled.includes("local.mp3"));
    }
    // A's delayed recovery cannot replace B or issue an unnecessary online request for A.
    {
        const downloaded = { ...A, downloadData: { path: "local.mp3", quality: "high" } };
        const held = deferred();
        const { player, plugins } = createPlayer({ downloaded, internalData: song => song?.downloadData,
            files: { addFileScheme: fp => "file://" + fp },
            reconcile: async (_song, failedPath) => failedPath ? held.promise : { state: "AVAILABLE" },
        });
        player.createAudioController(); player.fetchCurrentLyric = async () => {};
        const network = [];
        plugins.callPluginDelegateMethod = async (_context, method, song) => {
            if (method !== "getMediaSource") return null;
            network.push(song.id); return { url: "online-" + song.id };
        };
        await player.playIndex(0); const recovering = player.audioController.onError(0, new Error("local failed"));
        await player.playIndex(1); held.resolve({ state: "MISSING" }); await recovering;
        assert.equal(player.audioController.tracks.at(-1).source.url, "online-B"); assert.deepEqual(network, ["B"]);
    }
    // A pure local item has no network fallback; an unsuccessful online fallback cannot loop.
    for (const pureLocal of [false, true]) {
        const constants = load("src/common/constant.ts");
        const song = { ...A, platform: pureLocal ? constants.localPluginName : A.platform };
        const downloaded = { ...song, downloadData: { path: "local.mp3", quality: "high" } };
        const { player, plugins } = createPlayer({ downloaded, internalData: item => item?.downloadData,
            files: { addFileScheme: fp => "file://" + fp }, reconcile: async () => ({ state: "AVAILABLE" }),
        });
        player.setMusicQueue([song]); player.createAudioController(); player.fetchCurrentLyric = async () => {};
        let calls = 0, errors = 0;
        plugins.callPluginDelegateMethod = async (_context, method) => {
            if (method === "getMediaSource") calls++; return null;
        };
        player.on(load("src/renderer/core/track-player/enum.ts").PlayerEvents.Error, () => errors++);
        await player.playIndex(0); await player.audioController.onError(0, new Error("local failed"));
        assert.equal(calls, pureLocal ? 0 : 1); assert.equal(errors, 1);
        if (!pureLocal) {
            await player.audioController.onError(0, new Error("still failed")); assert.equal(calls, 1);
        }
    }
    // A's delayed failure must not reset B or its quality.
    {
        const { player } = createPlayer();
        player.fetchCurrentLyric = async () => {};
        const held = deferred();
        player.fetchMediaSource = song => song.id === "A" ? held.promise : Promise.resolve(source("B", "high"));
        const old = player.playIndex(0);
        await player.playIndex(1);
        const before = player.audioController.resetCount;
        held.reject(new Error("stale A")); await old;
        assert.equal(player.audioController.resetCount, before);
        assert.equal(player.currentQuality, "high");
    }
    // A -> B -> A: even matching song identities do not make old results current.
    for (const rejected of [false, true]) {
        const { player } = createPlayer();
        player.fetchCurrentLyric = async () => {};
        const held = deferred(); let calls = 0;
        player.fetchMediaSource = () => ++calls === 1 ? held.promise : Promise.resolve(source("new-" + calls));
        const old = player.playIndex(0);
        await player.playIndex(1); await player.playIndex(0);
        const before = player.audioController.resetCount;
        rejected ? held.reject(new Error("old A")) : held.resolve(source("old-A"));
        await old;
        assert.equal(player.audioController.tracks.at(-1).source.url, "new-3");
        assert.equal(player.audioController.tracks.length, 2);
        assert.equal(player.audioController.resetCount, before);
    }
    // Racing quality selections, including a stale rejection.
    for (const rejected of [false, true]) {
        const { player } = createPlayer();
        player.fetchCurrentLyric = async () => {};
        player.fetchMediaSource = async () => source("initial"); await player.playIndex(0);
        const held = deferred();
        player.fetchMediaSource = (_song, quality) => quality === "high" ? held.promise : Promise.resolve(source("latest", "super"));
        const old = player.setQuality("high"); await player.setQuality("super");
        rejected ? held.reject(new Error("stale quality")) : held.resolve(source("stale", "high"));
        await old;
        assert.equal(player.currentQuality, "super");
        assert.equal(player.audioController.tracks.at(-1).source.url, "latest");
    }
    // Returning to the currently playing quality cancels a pending quality switch.
    {
        const { player } = createPlayer();
        player.fetchCurrentLyric = async () => {};
        player.fetchMediaSource = async () => source("initial"); await player.playIndex(0);
        const held = deferred(); player.fetchMediaSource = () => held.promise;
        const old = player.setQuality("high"); await player.setQuality("standard");
        held.resolve(source("unwanted-high", "high")); await old;
        assert.equal(player.currentQuality, "standard");
        assert.equal(player.audioController.tracks.at(-1).source.url, "initial");
    }
    // A delayed automatic skip from an old A failure cannot skip a new A.
    {
        const previous = Object.getOwnPropertyDescriptor(global, "navigator");
        Object.defineProperty(global, "navigator", { configurable: true, value: { mediaSession: { setActionHandler() {} } } });
        try {
            const held = deferred(); const { player } = createPlayer({ delay: () => held.promise });
            player.fetchCurrentLyric = async () => {};
            player.fetchMediaSource = async () => source("current");
            player.setupEvents(); await player.playIndex(0);
            player.ee.emit(load("src/renderer/core/track-player/enum.ts").PlayerEvents.Error, A);
            await player.playIndex(1); await player.playIndex(0);
            held.resolve(); await tick(); assert.equal(player.currentMusic.id, "A");
        } finally {
            if (previous) Object.defineProperty(global, "navigator", previous); else delete global.navigator;
        }
    }
    // Lyrics: late success/failure for A -> B -> A and force reload on the same A.
    for (const switchSong of [false, true]) for (const rejected of [false, true]) {
        const { player, stores, plugins } = createPlayer();
        const held = deferred(); let calls = 0;
        plugins.callPluginDelegateMethod = () => ++calls === 1 ? held.promise : Promise.resolve({ rawLrc: "current-" + calls });
        stores.currentMusicStore.setValue(A);
        const old = player.fetchCurrentLyric(true); await tick();
        if (switchSong) {
            player.setCurrentMusic(B); await tick();
            player.setCurrentMusic(A); await tick();
        } else await player.fetchCurrentLyric(true);
        const current = player.lyric.parser.raw;
        rejected ? held.reject(new Error("stale lyrics")) : held.resolve({ rawLrc: "stale" });
        await old;
        assert.equal(player.lyric.parser.raw, current);
    }
    // Clear/reset while source and lyrics are pending.
    {
        const { player, plugins } = createPlayer();
        const held = deferred(); const lyric = deferred();
        player.fetchMediaSource = () => held.promise;
        plugins.callPluginDelegateMethod = () => lyric.promise;
        const old = player.playIndex(0); await tick(); player.reset();
        held.resolve(source("stale")); lyric.resolve({ rawLrc: "stale" }); await old; await tick();
        assert.equal(player.currentMusic, null);
        assert.equal(player.audioController.tracks.length, 0);
        assert.equal(player.lyric, null);
    }
    console.log("PASS: player source/lyrics generations, A-B-A, quality races, stale errors and reset");
})().catch(error => {
    console.error(error); process.exitCode = 1;
});
