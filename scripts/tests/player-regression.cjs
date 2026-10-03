const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { load, deferred } = require('./source-loader.cjs');
const A = { platform: 'test', id: 'A', title: 'A' };
const B = { ...A, id: 'B', title: 'B' };

function createPlayer() {
    const constants = load('src/common/constant.ts');
    const media = {
        isSameMedia: (a, b) => !!a && !!b && a.id === b.id && a.platform === b.platform,
        getInternalData: () => undefined, getQualityOrder: () => ['standard'],
        addSortProperty() {}, sortByTimestampAndIndex: a => a,
    };
    const Store = load('src/common/store.ts', { react: {} }).default;
    const stores = load('src/renderer/core/track-player/store.ts', {
        '@/common/store': Store, '@/common/constant': constants,
    }).default;
    class Audio {
        resetCount = 0; tracks = [];
        reset() { this.resetCount++; }
        prepareTrack() {} play() {} seekTo() {}
        setTrackSource(source, song) { this.tracks.push({ source, song }); }
    }
    class Lyric {
        constructor(raw, options) { this.raw = raw; this.musicItem = options.musicItem; }
        getPosition() { return { lrc: this.raw }; }
    }
    const plugins = { callPluginDelegateMethod: async () => null };
    const player = load('src/renderer/core/track-player/index.ts', {
        './enum': load('src/renderer/core/track-player/enum.ts'),
        '@/common/media-util': media, '@/common/constant': constants,
        '@/renderer/utils/lyric-parser': Lyric,
        '@/renderer/utils/user-perference': { setUserPreference() {}, setUserPreferenceIDB() {}, removeUserPreference() {} },
        '@shared/app-config/renderer': { getConfig: () => 'standard' },
        '@/common/index-map': { createIndexMap: () => ({ update() {}, indexOf: a => a?.id === 'A' ? 0 : 1 }) },
        './store': stores, eventemitter3: EventEmitter,
        '@renderer/core/track-player/controller/audio-controller': Audio,
        '@shared/logger/renderer': { logError() {} }, '@/common/void-callback': () => {},
        '@/common/time-util': { delay: async () => {} }, '@/common/unique-map': {},
        '@renderer/core/link-lyric': { getLinkedLyric: async () => null },
        '@shared/utils/renderer': { fsUtil: {} }, '@shared/plugin-manager/renderer': plugins,
    }).default;
    player.setMusicQueue([A, B]);
    return { player, stores, plugins };
}
const source = (url, quality = 'standard') => ({ mediaSource: { url }, quality });
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

(async () => {
    // A's delayed failure must not reset B or its quality.
    {
        const { player } = createPlayer();
        player.fetchCurrentLyric = async () => {};
        const held = deferred();
        player.fetchMediaSource = song => song.id === 'A' ? held.promise : Promise.resolve(source('B', 'high'));
        const old = player.playIndex(0);
        await player.playIndex(1);
        const before = player.audioController.resetCount;
        held.reject(new Error('stale A')); await old;
        assert.equal(player.audioController.resetCount, before);
        assert.equal(player.currentQuality, 'high');
    }
    // A -> B -> A: even matching song identities do not make old results current.
    for (const rejected of [false, true]) {
        const { player } = createPlayer();
        player.fetchCurrentLyric = async () => {};
        const held = deferred(); let calls = 0;
        player.fetchMediaSource = () => ++calls === 1 ? held.promise : Promise.resolve(source('new-' + calls));
        const old = player.playIndex(0);
        await player.playIndex(1); await player.playIndex(0);
        const before = player.audioController.resetCount;
        rejected ? held.reject(new Error('old A')) : held.resolve(source('old-A'));
        await old;
        assert.equal(player.audioController.tracks.at(-1).source.url, 'new-3');
        assert.equal(player.audioController.tracks.length, 2);
        assert.equal(player.audioController.resetCount, before);
    }
    // Racing quality selections, including a stale rejection.
    for (const rejected of [false, true]) {
        const { player } = createPlayer();
        player.fetchCurrentLyric = async () => {};
        player.fetchMediaSource = async () => source('initial'); await player.playIndex(0);
        const held = deferred();
        player.fetchMediaSource = (_song, quality) => quality === 'high' ? held.promise : Promise.resolve(source('latest', 'super'));
        const old = player.setQuality('high'); await player.setQuality('super');
        rejected ? held.reject(new Error('stale quality')) : held.resolve(source('stale', 'high'));
        await old;
        assert.equal(player.currentQuality, 'super');
        assert.equal(player.audioController.tracks.at(-1).source.url, 'latest');
    }
    // Lyrics: late success/failure for A -> B -> A and force reload on the same A.
    for (const switchSong of [false, true]) for (const rejected of [false, true]) {
        const { player, stores, plugins } = createPlayer();
        const held = deferred(); let calls = 0;
        plugins.callPluginDelegateMethod = () => ++calls === 1 ? held.promise : Promise.resolve({ rawLrc: 'current-' + calls });
        stores.currentMusicStore.setValue(A);
        const old = player.fetchCurrentLyric(true); await tick();
        if (switchSong) {
            player.setCurrentMusic(B); await tick();
            player.setCurrentMusic(A); await tick();
        } else await player.fetchCurrentLyric(true);
        const current = player.lyric.parser.raw;
        rejected ? held.reject(new Error('stale lyrics')) : held.resolve({ rawLrc: 'stale' });
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
        held.resolve(source('stale')); lyric.resolve({ rawLrc: 'stale' }); await old; await tick();
        assert.equal(player.currentMusic, null);
        assert.equal(player.audioController.tracks.length, 0);
        assert.equal(player.lyric, null);
    }
    console.log('PASS: player source/lyrics generations, A-B-A, quality races, stale errors and reset');
})().catch(error => { console.error(error); process.exitCode = 1; });
