const assert = require('node:assert/strict');
const { load } = require('./source-loader.cjs');
const constants = load('src/common/constant.ts');
const enums = load('src/renderer/core/track-player/enum.ts');
const globals = new Map(['document', 'navigator', 'localStorage'].map(key => [key, Object.getOwnPropertyDescriptor(global, key)]));
global.document = { addEventListener() {} };
global.localStorage = { getItem: () => '0', setItem() {} };
Object.defineProperty(global, 'navigator', { configurable: true, value: { mediaDevices: { enumerateDevices: async () => [] } } });
(async () => {
    try {
        for (const stage of ['配置', '插件', '歌单', '播放状态', '语言', '下载记录']) {
            const initialize = name => async () => { if (stage === name) throw new Error('Injected failure'); };
            const bootstrap = load('src/renderer/document/bootstrap.ts', {
                '@/common/constant': constants, '@/common/local-media': {},
                '../core/music-sheet': { frontend: { setupMusicSheets: initialize('歌单') } },
                '../core/track-player': { setup: initialize('播放状态'), on() {} },
                '../core/local-music': { setupLocalMusic() {} }, immer: { setAutoFreeze() {} },
                '../core/downloader': { setupDownloader: initialize('下载记录') },
                '@shared/app-config/renderer': { setup: initialize('配置'), getConfig: () => false },
                '@/shared/i18n/renderer': { setupI18n: initialize('语言') }, '@/shared/themepack/renderer': {},
                '../core/recently-playlist': { setupRecentlyPlaylist() {} },
                '@shared/service-manager/renderer': { setup() {} },
                '@renderer/core/track-player/enum': enums, '@shared/utils/renderer': {},
                '@shared/plugin-manager/renderer': { setup: initialize('插件') },
                '@shared/message-bus/renderer/main': { onCommand() {}, syncAppState() {} },
                '@renderer/components/MusicDetail': {}, '@shared/short-cut/renderer': { setup() {} },
            }).default;
            await assert.rejects(bootstrap, error => error.message === stage + '初始化失败：Injected failure');
        }
        console.log('PASS: startup failures carry config/plugin/playlist/player/language/download stage diagnostics');
    } finally {
        for (const [key, descriptor] of globals) {
            if (descriptor) Object.defineProperty(global, key, descriptor); else delete global[key];
        }
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
