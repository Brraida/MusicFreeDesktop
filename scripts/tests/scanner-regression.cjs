const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const EventEmitter = require('node:events');
const { load, deferred, root } = require('./source-loader.cjs');
const constants = load('src/common/constant.ts');
const supported = load('src/common/local-media.ts', { './constant': constants });
const metadata = { setInternalData() {} };
const suffix = '\nexport { onAdd, onRemove, setupWatcher, readMusic, syncMusic }; export const waitDelivery = () => delivery; export const closeTest = async () => { syncMusic.cancel(); await watcher?.close(); await delivery; };';

function createProbe(parse) {
    const watcher = new EventEmitter(); watcher.close = async () => {};
    let pending;
    const api = load('src/webworkers/local-file-watcher.ts', {
        comlink: { expose() {} }, chokidar: { watch: () => watcher },
        '@/common/local-media': supported, '@/common/media-util': metadata,
        '@/common/file-util': { parseLocalMusicItem: parse || (async fp => ({ id: fp, platform: 'local', title: fp })) },
        'lodash.debounce': fn => { pending = fn; const wrapped = () => {}; wrapped.cancel = () => {}; return wrapped; },
    }, suffix);
    return { api, watcher, flush: async () => { pending(); await api.waitDelivery(); } };
}

(async () => {
    for (const count of [1, 100, 10000]) {
        const { api, watcher, flush } = createProbe();
        await api.setupWatcher([]);
        const paths = Array.from({ length: count }, (_, i) => 'test/' + i + '.MP3');
        await Promise.all(paths.map(fp => api.readMusic(fp, { isFile: () => true })));
        await flush(); // no callbacks yet: batch must remain buffered
        const received = [];
        await api.onAdd(items => received.push(...items)); await flush();
        assert.equal(new Set(received.map(item => item.id)).size, count);
        assert.equal(received.length, count);
        assert.equal(watcher.listenerCount('change'), 1);
        await api.closeTest();
    }
    // A delayed parse must not resurrect an unlinked song or overwrite a newer edit.
    for (const deleted of [true, false]) {
        const held = deferred(); let calls = 0;
        const { api, watcher, flush } = createProbe(() => ++calls === 1 ? held.promise : Promise.resolve({ id: 'song', platform: 'local', title: 'new' }));
        const received = [], removed = [];
        await api.onAdd(items => received.push(...items)); await api.onRemove(items => removed.push(...items));
        await api.setupWatcher([]);
        const pending = api.readMusic('song.MP3', { isFile: () => true });
        deleted ? watcher.emit('unlink', 'song.MP3') : await api.readMusic('song.MP3', { isFile: () => true });
        held.resolve({ id: 'song', platform: 'local', title: 'old' }); await pending; await flush();
        assert.equal(received.length, deleted ? 0 : 1);
        if (!deleted) assert.equal(received[0].title, 'new');
        else assert.deepEqual(removed, ['song.MP3']);
        await api.closeTest();
    }
    assert.equal(supported.isSupportedLocalMediaFile('C:\\Music\\A.FlAc'), true);
    assert.equal(supported.isSupportedLocalMediaFile('cover.PNG'), false);
    // Real Chokidar + real files and metadata on the host platform.
    const testRoot = path.join(root, 'out/.scanner-regression-' + Date.now());
    await fs.mkdir(testRoot, { recursive: true });
    let api;
    try {
        const fileUtil = load('src/common/file-util.ts', {
            'music-metadata': await import('music-metadata'), './constant': constants, './local-media': supported,
        });
        const originalParse = fileUtil.parseLocalMusicItem;
        const local = { ...fileUtil, parseLocalMusicItem: async fp => ({ ...(await originalParse(fp)), title: await fs.readFile(fp, 'utf8') }) };
        api = load('src/webworkers/local-file-watcher.ts', {
            comlink: { expose() {} }, '@/common/local-media': supported,
            '@/common/media-util': metadata, '@/common/file-util': local,
        }, suffix);
        for (let i = 0; i < 100; i++) await fs.writeFile(path.join(testRoot, i + '.MP3'), 'initial');
        const songs = new Map();
        await api.onAdd(items => { for (const item of items) songs.set(item.$$localPath, item); });
        await api.onRemove(paths => { for (const fp of paths) songs.delete(fp); });
        await api.setupWatcher([testRoot]);
        const until = async check => {
            const start = Date.now();
            while (!check()) {
                if (Date.now() - start > 15000) throw new Error('Watcher condition timed out');
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        };
        await until(() => songs.size === 100);
        const fp = path.join(testRoot, '0.MP3');
        const id = songs.get(fp).id;
        await fs.writeFile(fp, 'updated'); await until(() => songs.get(fp)?.title === 'updated');
        assert.equal(songs.get(fp).id, id);
        await api.readMusic(fp); // explicit missing-stats branch must safely stat the file
        api.syncMusic.flush(); await api.waitDelivery();
        // Windows can temporarily hold a metadata file handle while change settles.
        for (let attempt = 0; ; attempt++) {
            try { await fs.unlink(fp); break; }
            catch (error) {
                if (!['EPERM', 'EBUSY'].includes(error.code) || attempt >= 10) throw error;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        await until(() => !songs.has(fp));
        assert.equal(songs.size, 99);
        const imported = await fileUtil.parseLocalMusicItemFolder(testRoot);
        assert.equal(imported.length, 99); // folder import shares the uppercase rule
        console.log('PASS: scan handshake at 1/100/10000, stale parses, real Windows watcher add/change/unlink, optional stats and folder import');
    } catch (error) {
        console.error('Scanner regression failure:', error);
        throw error;
    } finally {
        await api?.closeTest();
        await fs.rm(testRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
