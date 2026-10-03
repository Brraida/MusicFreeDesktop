const assert = require('node:assert/strict');
const path = require('node:path');
const { load, deferred } = require('./source-loader.cjs');
const constants = load('src/common/constant.ts');
const enums = load('src/renderer/core/track-player/enum.ts');
const A = { id: 'A', platform: 'test' }, B = { id: 'B', platform: 'test' };
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
class Audio {
    src = ''; playCalls = 0; currentTime = 0; duration = NaN;
    play() { this.playCalls++; return Promise.resolve(); }
    pause() {} load() {} removeAttribute() { this.src = ''; }
}
class Hls {
    static instances = [];
    static isSupported() { return true; }
    constructor(config) { this.config = config; Hls.instances.push(this); }
    attachMedia() {} loadSource(url) { this.url = url; }
    on(_type, callback) { this.error = callback; } off() {} detachMedia() {}
    destroy() { this.destroyed = true; }
}
const globals = new Map(['Audio', 'MediaMetadata', 'fetch', 'navigator', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(global, key)]));
const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
const revoked = []; let created = 0, options;
Object.defineProperty(global, 'navigator', { configurable: true, value: { mediaSession: {} } });
global.Audio = Audio; global.MediaMetadata = class { constructor(data) { Object.assign(this, data); } }; global.window = {};
URL.createObjectURL = () => 'blob:test-' + ++created;
URL.revokeObjectURL = url => revoked.push(url);
const Controller = load('src/renderer/core/track-player/controller/audio-controller.ts', {
    '@/common/normalize-util': load('src/common/normalize-util.ts'), '@/assets/imgs/album-cover.jpg': 'cover.jpg',
    '@/renderer/utils/get-url-ext': url => path.extname(new URL(url).pathname),
    'hls.js': { __esModule: true, default: Hls, Events: { ERROR: 'error' } }, '@/common/constant': constants,
    '@shared/service-manager/renderer': { RequestForwarderService: { forwardRequest: () => null } },
    '@renderer/core/track-player/controller/controller-base': load('src/renderer/core/track-player/controller/controller-base.ts').default,
    '@renderer/core/track-player/enum': enums, '@/common/void-callback': () => {}, dexie: { Promise },
}).default;
const protectedSource = { url: 'https://user:pass@example.test/audio.mp3', headers: { 'X-Test': '1' }, userAgent: 'test-agent' };
const response = { ok: true, blob: async () => ({}) };

(async () => {
    try {
        // HLS cleanup and suppression of queued callbacks from detached instances.
        const controller = new Controller(), errors = [];
        controller.onError = (...args) => errors.push(args);
        controller.setTrackSource({ url: 'https://example.test/song.m3u8' }, A);
        const oldHls = Hls.instances.at(-1);
        controller.setTrackSource({ url: 'https://example.test/song.mp3' }, B);
        assert.ok(oldHls.destroyed); assert.equal(controller.hls, null);
        oldHls.error('error', { fatal: true }); assert.equal(errors.length, 0);
        controller.setTrackSource({ url: 'https://user:pass@example.test/folder/master.M3U8' }, A);
        const hls = Hls.instances.at(-1);
        assert.equal(hls.url, 'https://example.test/folder/master.M3U8');
        let encoded;
        hls.config.xhrSetup({ open: (_method, url) => { encoded = new URL(url); } }, 'https://example.test/folder/segment.ts');
        assert.equal(encoded.pathname, '/folder/segment.ts');
        assert.equal(JSON.parse(decodeURIComponent(encoded.searchParams.get('_setHeaders'))).authorization, 'Basic dXNlcjpwYXNz');
        hls.error('error', { fatal: false }); assert.equal(errors.length, 0);
        hls.error('error', { fatal: true }); assert.equal(errors.length, 1);
        controller.reset(); assert.ok(hls.destroyed);
        // Deferred autoplay, auth/user agent and seek survive Blob fetch.
        const held = deferred(); global.fetch = (_url, init) => { options = init; return held.promise; };
        controller.setTrackSource(protectedSource, A); controller.seekTo(12); controller.play();
        assert.equal(controller.audio.playCalls, 0);
        assert.equal(options.headers.Authorization, 'Basic dXNlcjpwYXNz');
        assert.equal(options.headers['user-agent'], 'test-agent'); assert.equal(options.headers['X-Test'], '1');
        held.resolve(response); await tick();
        assert.equal(controller.audio.playCalls, 1); assert.equal(controller.audio.currentTime, 12);
        const blob = controller.audio.src; controller.reset(); assert.ok(revoked.includes(blob));
        // Pause before fetch completes prevents unintended autoplay.
        const paused = deferred(); global.fetch = () => paused.promise;
        controller.setTrackSource(protectedSource, A); controller.play(); controller.pause();
        paused.resolve(response); await tick(); assert.equal(controller.audio.playCalls, 1);
        // A -> B -> A: old Blob bodies cannot replace the latest source, even if fetch ignores abort.
        const stale = deferred(); global.fetch = () => stale.promise;
        controller.setTrackSource(protectedSource, A); const signal = controller.sourceFetch.signal;
        controller.setTrackSource({ url: 'https://example.test/B.mp3' }, B);
        controller.setTrackSource({ url: 'https://example.test/new-A.mp3' }, A);
        const count = created; stale.resolve(response); await tick();
        assert.equal(signal.aborted, true); assert.equal(created, count);
        assert.equal(controller.audio.src, 'https://example.test/new-A.mp3');
        // Current failures report once; aborts and stale failures do not report errors.
        global.fetch = async () => ({ ok: false, status: 401 });
        controller.setTrackSource(protectedSource, A); await tick(); assert.equal(errors.length, 2);
        const failed = deferred(); global.fetch = () => failed.promise;
        controller.setTrackSource(protectedSource, A); controller.destroy();
        failed.reject(new Error('late failure')); await tick(); assert.equal(errors.length, 2);
        assert.equal(controller.audio.src, ''); assert.equal(controller.musicItem, null);
        console.log('PASS: HLS teardown/headers, Blob auth/autoplay/seek, pause, abort, A-B-A and Object URL cleanup');
    } finally {
        for (const [key, descriptor] of globals) {
            if (descriptor) Object.defineProperty(global, key, descriptor); else delete global[key];
        }
        URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
