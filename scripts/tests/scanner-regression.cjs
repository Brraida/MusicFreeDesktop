const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const EventEmitter = require("node:events");
const { load, deferred, root } = require("./source-loader.cjs");
const constants = load("src/common/constant.ts");
const supported = load("src/common/local-media.ts", { "./constant": constants });
const metadata = { setInternalData() {} };
const suffix = "\nexport { onAdd, onRemove, setupWatcher, changeWatchPath, readMusic, syncMusic }; export const waitDelivery = () => delivery; export const closeTest = async () => { syncMusic.cancel(); await watcher?.close(); await delivery; };";

function createProbe(parse) {
    const watcher = new EventEmitter(); watcher.close = async () => {}; watcher.unwatch = async () => {}; watcher.add = () => {}; watcher._watched = new Map();
    let pending;
    const api = load("src/webworkers/local-file-watcher.ts", {
        "@/common/task-queue": load("src/common/task-queue.ts").default, comlink: { expose() {} }, chokidar: { watch: () => watcher },
        "@/common/local-media": supported, "@/common/media-util": metadata,
        "@/common/file-util": { parseLocalMusicItem: parse || (async fp => ({ id: fp, platform: "local", title: fp })) },
        "lodash.debounce": fn => {
            pending = fn; const wrapped = () => {}; wrapped.cancel = () => {}; return wrapped;
        },
    }, suffix);
    return { api, watcher, flush: async () => {
        pending(); await api.waitDelivery();
    } };
}

(async () => {
    for (const count of [1, 100, 10000, 50000]) {
        const { api, watcher, flush } = createProbe();
        await api.setupWatcher([]);
        const paths = Array.from({ length: count }, (_, i) => "test/" + i + ".MP3");
        await Promise.all(paths.map(fp => api.readMusic(fp, { isFile: () => true })));
        await flush(); // no callbacks yet: batch must remain buffered
        const received = [];
        await api.onAdd(items => received.push(...items)); await flush();
        assert.equal(new Set(received.map(item => item.id)).size, count);
        assert.equal(received.length, count);
        assert.equal(watcher.listenerCount("change"), 1);
        await api.closeTest();
    }
    // A delayed parse must not resurrect an unlinked song or overwrite a newer edit.
    for (const deleted of [true, false]) {
        const held = deferred(); let calls = 0;
        const { api, watcher, flush } = createProbe(() => ++calls === 1 ? held.promise : Promise.resolve({ id: "song", platform: "local", title: "new" }));
        const received = [], removed = [];
        await api.onAdd(items => received.push(...items)); await api.onRemove(items => removed.push(...items));
        await api.setupWatcher([]);
        const pending = api.readMusic("song.MP3", { isFile: () => true });
        await new Promise(resolve => setImmediate(resolve)); // let the first bounded task enter its held parse
        deleted ? watcher.emit("unlink", "song.MP3") : await api.readMusic("song.MP3", { isFile: () => true });
        held.resolve({ id: "song", platform: "local", title: "old" }); await pending; await flush();
        assert.equal(received.length, deleted ? 0 : 1);
        if (!deleted) assert.equal(received[0].title, "new");
        else assert.deepEqual(removed, ["song.MP3"]);
        await api.closeTest();
    }
    // An event queued by a closed watcher must not inherit the new generation.
    {
        const { api, watcher, flush } = createProbe();
        let calls = 0; await api.onAdd(() => ++calls);
        await api.setupWatcher([]);
        const oldRead = watcher.listeners("add")[0];
        await api.setupWatcher([]);
        oldRead("stale.MP3", { isFile: () => true }); await new Promise(r => setImmediate(r)); await flush();
        assert.equal(calls, 0); await api.closeTest();
    }
    // A failed in-flight save cannot requeue tracks from an unwatched directory.
    {
        const held = deferred(); let calls = 0;
        const { api, flush } = createProbe();
        await api.setupWatcher([]);
        await api.onAdd(() => ++calls === 1 ? held.promise : undefined);
        await api.readMusic("removed/song.MP3", { isFile: () => true });
        const saving = flush(); await new Promise(resolve => setImmediate(resolve));
        await api.changeWatchPath([], ["removed"]);
        held.reject(new Error("Injected save failure after directory removal")); await saving; await flush();
        assert.equal(calls, 1);
        await api.readMusic("removed/song.MP3", { isFile: () => true }); await flush(); assert.equal(calls, 1);
        await api.changeWatchPath(["removed"], []);
        await api.readMusic("removed/song.MP3", { isFile: () => true }); await flush(); assert.equal(calls, 2);
        await api.closeTest();
    }
    // Work is bounded, queued deletions do not open files, and delivery batches stay small.
    {
        const held = deferred(); let active = 0, peak = 0, reads = 0;
        const { api, watcher, flush } = createProbe(async fp => {
            ++reads; ++active; peak = Math.max(peak, active);
            await held.promise; --active;
            return { id: fp, platform: "local", title: fp };
        });
        await api.setupWatcher([]);
        const sizes = []; await api.onAdd(batch => sizes.push(batch.length));
        const jobs = Array.from({ length: 1000 }, (_, i) => api.readMusic("bounded/" + i + ".MP3", { isFile: () => true }));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(active, 64);
        watcher.emit("unlink", "bounded/999.MP3");
        held.resolve(); await Promise.all(jobs); await flush();
        assert.equal(peak, 64); assert.equal(reads, 999);
        assert.equal(sizes.reduce((sum, count) => sum + count, 0), 999);
        assert(sizes.every(count => count <= 200)); await api.closeTest();
    }
    assert.equal(supported.isSupportedLocalMediaFile("C:\\Music\\A.FlAc"), true);
    assert.equal(supported.isSupportedLocalMediaFile("cover.PNG"), false);
    // Real Chokidar + real files and metadata on the host platform.
    const testRoot = path.join(root, "out/.scanner-regression-" + Date.now());
    await fs.mkdir(testRoot, { recursive: true });
    let api;
    try {
        const fileUtil = load("src/common/file-util.ts", {
            "./task-queue": load("src/common/task-queue.ts").default,
            "music-metadata": await import("music-metadata"), "./constant": constants, "./local-media": supported,
        });
        const originalParse = fileUtil.parseLocalMusicItem;
        const local = { ...fileUtil, parseLocalMusicItem: async fp => ({ ...(await originalParse(fp)), title: await fs.readFile(fp, "utf8") }) };
        api = load("src/webworkers/local-file-watcher.ts", {
            "@/common/task-queue": load("src/common/task-queue.ts").default, comlink: { expose() {} }, "@/common/local-media": supported,
            "@/common/media-util": metadata, "@/common/file-util": local,
        }, suffix);
        for (let i = 0; i < 100; i++) await fs.writeFile(path.join(testRoot, i + ".MP3"), "initial");
        const songs = new Map();
        await api.onAdd(items => {
            for (const item of items) songs.set(item.$$localPath, item);
        });
        await api.onRemove(paths => {
            for (const fp of paths) songs.delete(fp);
        });
        await api.setupWatcher([testRoot]);
        const until = async check => {
            const start = Date.now();
            while (!check()) {
                if (Date.now() - start > 15000) throw new Error("Watcher condition timed out");
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        };
        await until(() => songs.size === 100);
        const fp = path.join(testRoot, "0.MP3");
        const id = songs.get(fp).id;
        await fs.writeFile(fp, "updated"); await until(() => songs.get(fp)?.title === "updated");
        assert.equal(songs.get(fp).id, id);
        await api.readMusic(fp); // explicit missing-stats branch must safely stat the file
        api.syncMusic.flush(); await api.waitDelivery();
        // Windows can temporarily hold a metadata file handle while change settles.
        for (let attempt = 0; ; attempt++) {
            try {
                await fs.unlink(fp); break;
            } catch (error) {
                if (!["EPERM", "EBUSY"].includes(error.code) || attempt >= 10) throw error;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        await until(() => !songs.has(fp));
        assert.equal(songs.size, 99);
        const imported = await fileUtil.parseLocalMusicItemFolder(testRoot);
        assert.equal(imported.length, 99); // folder import shares the uppercase rule
        await api.changeWatchPath([], [testRoot]);
        songs.clear();
        await fs.writeFile(path.join(testRoot, "1.MP3"), "changed while unwatched");
        await new Promise(resolve => setTimeout(resolve, 750)); assert.equal(songs.size, 0);
        await api.changeWatchPath([testRoot], []);
        await until(() => songs.size === 99);
        assert.equal(songs.get(path.join(testRoot, "1.MP3")).title, "changed while unwatched");
        console.log("PASS: scan handshake at 1/100/10000, stale parses, real Windows watcher add/change/unlink, optional stats and folder import");
    } catch (error) {
        console.error("Scanner regression failure:", error);
        throw error;
    } finally {
        await api?.closeTest();
        await fs.rm(testRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
})().catch(error => {
    console.error(error); process.exitCode = 1;
});
