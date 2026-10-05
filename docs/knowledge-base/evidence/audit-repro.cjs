/* Isolated audit probes: historical baseline TypeScript methods, mocked OS/audio/DB services.
 * Run from repository root: node docs/knowledge-base/evidence/audit-repro.cjs
 * No app settings, music files, network listeners, or production sources are changed.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const ts = require('typescript');
const root = path.resolve(__dirname, '../../..');
const baselineCommit = '6bb1e21d9c642b1427d531aa207d9ccddc6acf25';
const baselineSource = relative => require('node:child_process').execFileSync('git', ['show', baselineCommit + ':' + relative], { cwd: root, encoding: 'utf8' });
function load(relative, mocks = {}, suffix = '') {
    const source = baselineSource(relative) + suffix;
    const code = ts.transpileModule(source, { compilerOptions: {
        target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    } }).outputText;
    const module = { exports: {} };
    new Function('require', 'module', 'exports', code)(name => {
        if (name in mocks) return mocks[name];
        if (!name.startsWith('@') && !name.startsWith('.')) return require(name);
        throw new Error('Unmocked import: ' + name);
    }, module, module.exports);
    return module.exports;
}
function deferred() {
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
}
const results = [];
async function probe(id, title, run) {
    await run();
    results.push({ id, title, outcome: 'reproduced', method: 'actual source with isolated mocks' });
    console.log('REPRODUCED', id, title);
}
(async () => {
    const constants = load('src/common/constant.ts');
    const media = {
        isSameMedia: (a, b) => !!a && !!b && a.id === b.id && a.platform === b.platform,
        getMediaPrimaryKey: a => a.platform + ':' + a.id,
        getInternalData: () => undefined,
        getQualityOrder: () => ['standard'],
        addSortProperty() {}, sortByTimestampAndIndex: a => a,
    };
    const Store = load('src/common/store.ts', { react: {} }).default;
    const stores = load('src/renderer/core/track-player/store.ts', {
        '@/common/store': Store, '@/common/constant': constants,
    }).default;
    const enums = load('src/renderer/core/track-player/enum.ts');
    class FakeAudioController {
        resetCount = 0;
        reset() { this.resetCount++; }
        prepareTrack() {} setTrackSource() {} play() {} seekTo() {}
    }
    class FakeLyricParser {
        constructor(raw, options) { this.raw = raw; this.musicItem = options.musicItem; }
        getPosition() { return { lrc: this.raw }; }
    }
    const plugins = { callPluginDelegateMethod: async () => null };
    const preferences = { setUserPreference() {}, setUserPreferenceIDB() {}, removeUserPreference() {} };
    const player = load('src/renderer/core/track-player/index.ts', {
        './enum': enums, '@/common/media-util': media, '@/common/constant': constants,
        '@/renderer/utils/lyric-parser': FakeLyricParser,
        '@/renderer/utils/user-perference': preferences,
        '@shared/app-config/renderer': { getConfig: () => 'standard' },
        '@/common/index-map': { createIndexMap: () => ({ update() {}, indexOf: a => a?.id === 'A' ? 0 : 1 }) },
        './store': stores, eventemitter3: EventEmitter,
        '@renderer/core/track-player/controller/audio-controller': FakeAudioController,
        '@shared/logger/renderer': { logError() {} }, '@/common/void-callback': () => {},
        '@/common/time-util': { delay: async () => {} }, '@/common/unique-map': {},
        '@renderer/core/link-lyric': { getLinkedLyric: async () => null },
        '@shared/utils/renderer': { fsUtil: {} }, '@shared/plugin-manager/renderer': plugins,
    }).default;
    const A = { platform: 'test', id: 'A', title: 'A' }, B = { ...A, id: 'B', title: 'B' };
    await probe('BUG-01', 'Old source failure resets the newer track', async () => {
        const held = deferred();
        player.fetchMediaSource = song => song.id === 'A' ? held.promise
            : Promise.resolve({ mediaSource: { url: 'https://example.invalid/B.mp3' }, quality: 'standard' });
        player.fetchCurrentLyric = async () => {};
        player.setMusicQueue([A, B]);
        const old = player.playIndex(0);
        await player.playIndex(1);
        const before = player.audioController.resetCount;
        held.reject(new Error('Old A request failed'));
        await old;
        assert.equal(player.currentMusic.id, 'B');
        assert.equal(player.audioController.resetCount, before + 1);
        delete player.fetchCurrentLyric;
    });
    await probe('BUG-02', 'Old lyric failure clears the newer lyrics', async () => {
        const held = deferred();
        plugins.callPluginDelegateMethod = song => song.id === 'A' ? held.promise
            : Promise.resolve({ rawLrc: 'B lyrics' });
        stores.currentMusicStore.setValue(A);
        const old = player.fetchCurrentLyric();
        await Promise.resolve(); await Promise.resolve();
        stores.currentMusicStore.setValue(B);
        await player.fetchCurrentLyric();
        assert.equal(player.lyric.parser.raw, 'B lyrics');
        held.reject(new Error('Old lyrics failed'));
        await old;
        assert.equal(player.lyric.parser, undefined);
    });
    await probe('BUG-03', 'Forwarder restart is blocked by the started flag', async () => {
        let forks = 0;
        const timers = [];
        let child;
        const manager = load('src/shared/service-manager/main.ts', {
            child_process: { fork: () => { forks++; child = new EventEmitter(); return child; } },
            electron: { app: {}, ipcMain: {} },
            '@shared/service-manager/common': { ServiceName: {} },
            '@/common/get-resource-path': name => name,
        }, '\nexport const AuditServiceInstance = ServiceInstance;');
        const previous = global.setTimeout;
        global.setTimeout = fn => { timers.push(fn); return 0; };
        try {
            const service = new manager.AuditServiceInstance('test', 'test');
            service.start(); child.emit('exit', 1); timers.shift()();
            assert.equal(forks, 1);
        } finally { global.setTimeout = previous; }
    });
    await probe('BUG-04', 'Forwarder has no explicit loopback bind and malformed URL throws', () => {
        let handler, bindArgs;
        const http = { createServer: fn => {
            handler = fn;
            return { listen: (...args) => { bindArgs = args; }, on() {} };
        } };
        vm.runInNewContext(baselineSource('res/.service/request-forwarder.js'), {
            require: name => name === 'http' ? http : {}, URL, URLSearchParams,
            console: { log() {}, error() {} }, process: { send() {} },
        });
        assert.equal(typeof bindArgs[1], 'function');
        assert.throws(() => handler({ method: 'GET', url: '/?url=not-a-url', headers: {} }, {
            setHeader() {}, writeHead() {}, end() {},
        }), { code: 'ERR_INVALID_URL' });
    });
    function createWatcherProbe() {
        const handlers = {}, flushers = [];
        const watcher = load('src/webworkers/local-file-watcher.ts', {
            comlink: { expose() {} },
            chokidar: { watch: () => ({ on: (event, fn) => { handlers[event] = fn; } }) },
            '@/common/constant': constants,
            'lodash.debounce': fn => { flushers.push(fn); return () => {}; },
            '@/common/file-util': { parseLocalMusicItem: async () => ({ ...A }) },
            '@/common/media-util': { setInternalData() {} },
        }, '\nexport { setupWatcher, onAdd };');
        return { watcher, handlers, flushers };
    }
    await probe('BUG-05', 'Scan batch is discarded before the callback is registered', async () => {
        const { watcher, handlers, flushers } = createWatcherProbe();
        await watcher.setupWatcher([]);
        await handlers.add('F:/test/song.mp3', { isFile: () => true });
        flushers[0]();
        let delivered = 0;
        await watcher.onAdd(items => { delivered += items.length; });
        flushers[0]();
        assert.equal(delivered, 0);
    });
    await probe('BUG-06', 'Uppercase music extensions are excluded', async () => {
        const { watcher, handlers, flushers } = createWatcherProbe();
        const delivered = [];
        await watcher.onAdd(items => delivered.push(...items));
        await watcher.setupWatcher([]);
        await handlers.add('F:/test/lower.mp3', { isFile: () => true });
        flushers[0]();
        assert.equal(delivered.length, 1);
        await handlers.add('F:/test/upper.MP3', { isFile: () => true });
        flushers[0]();
        assert.equal(delivered.length, 1);
        assert.equal(delivered[0].$$localPath, 'F:/test/lower.mp3');
    });
    const previousGlobals = new Map(['Audio', 'MediaMetadata', 'fetch', 'navigator', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(global, key)]));
    const previousCreate = URL.createObjectURL, previousRevoke = URL.revokeObjectURL;
    let hlsDestroyed = 0, fetchOptions, revoked = 0;
    class FakeAudio {
        src = ''; playCalls = 0;
        play() { this.playCalls++; return Promise.resolve(); }
        pause() {} removeAttribute() { this.src = ''; }
    }
    class FakeHls {
        static isSupported() { return true; }
        attachMedia() {} loadSource() {} on() {} off() {} detachMedia() {}
        destroy() { hlsDestroyed++; }
    }
    Object.defineProperty(global, 'navigator', { configurable: true, value: { userAgent: 'audit-only', mediaSession: { metadata: null } } });
    global.Audio = FakeAudio;
    global.MediaMetadata = class { constructor(value) { Object.assign(this, value); } };
    global.fetch = async (_url, options) => { fetchOptions = options; return { blob: async () => ({}) }; };
    URL.createObjectURL = () => 'blob:audit-only';
    URL.revokeObjectURL = () => { revoked++; };
    try {
        const AudioController = load('src/renderer/core/track-player/controller/audio-controller.ts', {
            '@/common/normalize-util': { encodeUrlHeaders: url => url },
            '@/assets/imgs/album-cover.jpg': 'cover.jpg',
            '@/renderer/utils/get-url-ext': url => path.extname(new URL(url).pathname),
            'hls.js': { __esModule: true, default: FakeHls, Events: { ERROR: 'error' } },
            '@/common/media-util': media, '@/common/constant': constants,
            '@shared/service-manager/renderer': { RequestForwarderService: { forwardRequest: () => null } },
            '@renderer/core/track-player/controller/controller-base': load('src/renderer/core/track-player/controller/controller-base.ts').default,
            '@renderer/core/track-player/enum': enums,
            '@/common/void-callback': () => {}, dexie: { Promise },
        }).default;
        global.window = {};
        await probe('BUG-07', 'HLS instance remains attached after switching to direct audio', () => {
            const controller = new AudioController();
            controller.setTrackSource({ url: 'https://example.invalid/song.m3u8' }, A);
            controller.setTrackSource({ url: 'https://example.invalid/song.mp3' }, B);
            assert(controller.hls);
            assert.equal(hlsDestroyed, 0);
        });
        await probe('BUG-08', 'Blob fallback loses generated auth and does not resume deferred play or revoke URL', async () => {
            const controller = new AudioController();
            controller.setTrackSource({ url: 'https://user:pass@example.invalid/song.mp3', headers: { 'X-test': '1' } }, A);
            controller.play();
            await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
            assert.equal(fetchOptions.headers.Authorization, undefined);
            assert.equal(controller.audio.src, 'blob:audit-only');
            assert.equal(controller.audio.playCalls, 0);
            controller.reset();
            assert.equal(revoked, 0);
        });
    } finally {
        for (const [key, descriptor] of previousGlobals) {
            if (descriptor) Object.defineProperty(global, key, descriptor); else delete global[key];
        }
        URL.createObjectURL = previousCreate; URL.revokeObjectURL = previousRevoke;
    }
    await probe('BUG-09', 'Observer failure prevents Store value from being committed', () => {
        const store = new Store(0);
        store.onValueChange(() => { throw new Error('observer failed'); });
        assert.throws(() => store.setValue(1));
        assert.equal(store.getValue(), 0);
    });
    await probe('BUG-10', 'Duplicate input produces duplicate playlist keys', async () => {
        const sheet = { id: 'favorite', musicList: [] };
        const backend = load('src/renderer/core/music-sheet/backend/index.ts', {
            '@/common/constant': constants, nanoid: { nanoid: () => 'id' }, immer: {},
            '../common/default-sheet': sheet, '@/common/media-util': media,
            '@/renderer/utils/user-perference': preferences,
            '../../db/music-sheet-db': {
                transaction: async (...args) => args.at(-1)(),
                musicStore: { bulkGet: async keys => keys.map(() => undefined), bulkPut: async () => {} },
                sheets: { toArray: async () => [sheet],
                    where: () => ({ equals: () => ({ modify: async fn => fn(sheet) }) }) },
            },
        });
        await backend.queryAllSheets();
        await backend.addMusicToSheet([A, A], sheet.id);
        assert.equal(sheet.musicList.length, 2);
        assert.equal(sheet.musicList[0].id, sheet.musicList[1].id);
    });
    fs.writeFileSync(path.join(__dirname, 'audit-results.json'), JSON.stringify({
        baselineCommit,
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        scope: 'Deterministic isolated probes; not end-to-end Windows playback tests or performance measurements',
        results,
    }, null, 2) + '\n');
})().catch(error => { console.error(error); process.exitCode = 1; });
