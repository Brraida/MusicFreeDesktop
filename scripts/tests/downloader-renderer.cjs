/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires, no-console -- Electron regression scripts use CommonJS and report results to the terminal. */
module.exports = async function runDownloadTests(testRoot, baseURL) {
    const fs = require("fs");
    const path = require("path");
    const assert = require("assert");
    const { createRequire } = require("module");
    const req = createRequire(path.resolve("package.json"));
    const ts = req("typescript");
    const cache = new Map();
    function compile(file, mocks = {}) {
        const full = path.resolve(file);
        const localRequire = createRequire(full);
        const module = { exports: {} };
        const baseline = process.env.MUSICFREE_STATUS_BASELINE
            ? path.join(path.resolve(process.env.MUSICFREE_STATUS_BASELINE), path.relative(process.cwd(), full)) : full;
        const sourceFile = fs.existsSync(baseline) ? baseline : full;
        const code = ts.transpileModule(fs.readFileSync(sourceFile, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX } }).outputText;
        new Function("require", "module", "exports", code)(name => {
            if (name in mocks) return mocks[name];
            try {
                return localRequire(name);
            } catch (error) {
                if (error.code !== "ERR_REQUIRE_ESM") throw error;
                const resolved = localRequire.resolve(name);
                if (!cache.has(resolved)) cache.set(resolved, compile(resolved));
                return cache.get(resolved);
            }
        }, module, module.exports);
        return module.exports;
    }
    const PQueue = compile(req.resolve("p-queue")).default;
    const constants = compile("src/common/constant.ts");
    const media = compile("src/common/media-util.ts", { "./constant": constants });
    const normalization = compile("src/common/normalize-util.ts");
    const Store = compile("src/common/store.ts");
    const eeModule = compile("src/renderer/core/downloader/ee.ts");
    const prefs = compile("src/renderer/utils/user-perference.ts", { "@/common/safe-serialization": compile("src/common/safe-serialization.ts") });
    const db = compile("src/renderer/core/db/music-sheet-db.ts", { "@/common/constant": constants }).default;
    const files = {
        async isFile(file) {
            try {
                return (await fs.promises.stat(file)).isFile();
            } catch {
                return false;
            }
        },
        async rimraf(file) {
            try {
                await fs.promises.rm(file, { force: true }); return true;
            } catch {
                return false;
            }
        },
    };
    const sheetMocks = {
        "@/common/media-util": media,
        "@/common/store": Store.default,
        "@/renderer/utils/user-perference": prefs,
        "../db/music-sheet-db": db,
        "@/common/constant": constants,
        "./ee": eeModule,
        "@shared/utils/renderer": { fsUtil: files },
        "p-queue": PQueue,
        "@shared/logger/renderer": { logInfo() { /* Logging is not relevant to assertions. */ }, logError(message, error) {
            console.error(message, error);
        } },
    };
    const sheet = compile("src/renderer/core/downloader/downloaded-sheet.ts", sheetMocks);
    await sheet.setupDownloadedMusicList();
    const makeSong = (id, title = id) => ({ id, title, artist: "artist", platform: "test" });
    function completed(song, file) {
        return media.setInternalData(song, "downloadData", { path: file, quality: "standard" }, true);
    }
    const successes = Array.from({ length: 30 }, (_, i) => makeSong("record-" + i));
    for (const song of successes) fs.writeFileSync(path.join(testRoot, song.id + ".mp3"), Buffer.from("test song"));
    assert((await Promise.all(successes.map(song => sheet.addDownloadedMusicToList(completed(song, path.join(testRoot, song.id + ".mp3")))))).every(result => result === true), "actual persistence function must return true on success");
    assert.strictEqual((await prefs.getUserPreferenceIDB("downloadedList")).length, 30, "concurrent completions must retain every indexed record");
    assert.strictEqual((await db.musicStore.toArray()).filter(item => media.getInternalData(item, "downloadData")).length, 30);
    assert((await sheet.addDownloadedMusicToList(completed(successes[0], path.join(testRoot, successes[0].id + ".mp3")))) === true);
    assert.strictEqual((await prefs.getUserPreferenceIDB("downloadedList")).length, 30, "duplicate completion must not duplicate records");
    // Reproduce the user's stale two-song index, then reload the actual module.
    await prefs.setUserPreferenceIDB("downloadedList", successes.slice(0, 2));
    const recovered = compile("src/renderer/core/downloader/downloaded-sheet.ts", sheetMocks);
    await recovered.setupDownloadedMusicList();
    assert.strictEqual((await prefs.getUserPreferenceIDB("downloadedList")).length, 30, "legacy two-song index must be rebuilt from file metadata");
    assert(successes.every(song => recovered.isDownloaded(song)));
    // Force one metadata write to fail. No completed icon may be published before commit.
    const originalBulkPut = db.musicStore.bulkPut.bind(db.musicStore);
    db.musicStore.bulkPut = async () => {
        throw new Error("Injected database failure");
    };
    const failedRecord = makeSong("record-failure");
    assert.strictEqual(await recovered.addDownloadedMusicToList(completed(failedRecord, path.join(testRoot, "record-0.mp3"))), false);
    assert.strictEqual(recovered.isDownloaded(failedRecord), false);
    db.musicStore.bulkPut = originalBulkPut;
    assert.strictEqual(await recovered.addDownloadedMusicToList(completed(failedRecord, path.join(testRoot, "record-0.mp3"))), true);

    const comlink = req("comlink");
    let workerAPI;
    compile("src/webworkers/downloader.ts", { comlink: { expose(api) {
        workerAPI = api;
    } }, "@/common/constant": constants, "@/common/normalize-util": normalization });
    const DS = constants.DownloadState;
    const target = name => path.join(testRoot, name);
    const workerDownload = (url, name, progress = () => { /* Most worker cases do not need progress events. */ }) => workerAPI.downloadFile({ url: baseURL + url }, target(name), progress, name);
    let terminal = await workerDownload("/ok", "worker-ok.mp3");
    assert.strictEqual(terminal.state, DS.DONE);
    assert.strictEqual(fs.statSync(terminal.path).size, 16384);
    const preserved = fs.readFileSync(terminal.path);
    terminal = await workerDownload("/ok", "worker-ok.mp3");
    assert.strictEqual(terminal.state, DS.DONE);
    assert.notStrictEqual(terminal.path, target("worker-ok.mp3"), "same-name songs must not overwrite existing files");
    assert(fs.readFileSync(target("worker-ok.mp3")).equals(preserved));
    terminal = await workerDownload("/404", "worker-404.mp3");
    assert.strictEqual(terminal.state, DS.ERROR);
    assert(!fs.existsSync(target("worker-404.mp3")));
    terminal = await workerDownload("/broken", "worker-broken.mp3");
    assert.strictEqual(terminal.state, DS.ERROR, "interrupted stream must never report completion");
    assert(!fs.existsSync(target("worker-broken.mp3")));
    let progressResolve;
    const firstProgress = new Promise(resolve => {
        progressResolve = resolve;
    });
    const slowTask = workerDownload("/slow", "worker-slow.mp3", status => {
        if (status.downloaded) progressResolve();
    });
    await firstProgress;
    await workerAPI.pauseAllDownloads();
    assert.strictEqual((await slowTask).state, DS.PAUSED);
    assert(!fs.existsSync(target("worker-slow.mp3")));
    assert(!fs.readdirSync(testRoot).some(name => name.endsWith(".part")), "pause/error must clean up temporary partial files");
    assert.strictEqual((await workerDownload("/ok", "worker-paused.mp3")).state, DS.PAUSED);
    await workerAPI.resumeAllDownloads();

    // Test actual queue control over real Comlink message ports with the actual worker and databases.
    const channel = new MessageChannel();
    comlink.expose(workerAPI, channel.port1);
    window.path = path;
    const originalWorker = window.Worker;
    window.Worker = class {};
    const statuses = new Map();
    eeModule.ee.on(eeModule.DownloadEvts.DownloadStatusUpdated, (song, status) => statuses.set(song.id, status));
    let holdSource;
    const heldSource = new Promise(resolve => {
        holdSource = resolve;
    });
    const sourceCalls = [];
    const plugin = { async callPluginDelegateMethod(song) {
        sourceCalls.push(song.id);
        if (song.id === "queue-source-held") return heldSource;
        return { url: baseURL + (song.id.includes("slow") ? "/slow" : "/ok") };
    } };
    const core = compile("src/renderer/core/downloader/index.ts", {
        "@/common/media-util": media,
        comlink: { ...comlink, wrap: () => comlink.wrap(channel.port2) },
        "@/common/constant": constants,
        "p-queue": PQueue,
        "./downloaded-sheet": recovered,
        "@/shared/global-context/renderer": { getGlobalContext: () => ({ workersPath: { downloader: "test" }, appPath: { downloads: testRoot } }) },
        "@/common/store": Store.default,
        "./ee": eeModule,
        "@shared/app-config/renderer": { getConfig: name => ({ "download.path": testRoot, "download.defaultQuality": "standard", "download.whenQualityMissing": "lower", "download.concurrency": 1 })[name] },
        "@shared/plugin-manager/renderer": plugin,
        "@/shared/i18n/renderer": { i18n: { t: value => value } },
        "@shared/logger/renderer": sheetMocks["@shared/logger/renderer"],
    }).default;
    await core.setupDownloader();
    async function until(check, description) {
        const deadline = Date.now() + 10000;
        while (!check()) {
            if (Date.now() > deadline) throw new Error("Timed out: " + description);
            await new Promise(resolve => setTimeout(resolve, 15));
        }
    }
    const slow = makeSong("queue-slow"), next = makeSong("queue-next");
    assert.strictEqual((await core.startDownload([slow, next, next])).added, 2);
    await until(() => statuses.get(slow.id)?.downloaded > 0, "active network transfer");
    assert.strictEqual((await core.startDownload([slow, next])).added, 0);
    await core.pauseAllDownloads();
    assert.strictEqual(statuses.get(slow.id).state, DS.PAUSED);
    assert.strictEqual(statuses.get(next.id).state, DS.PAUSED);
    assert(!sourceCalls.includes(next.id), "paused queued task must not obtain a source");
    // Resume and pause again while transfer is active, then let both songs finish with an ordinary URL.
    plugin.callPluginDelegateMethod = async song => {
        sourceCalls.push(song.id); return { url: baseURL + "/ok" };
    };
    await core.resumeAllDownloads();
    await until(() => recovered.isDownloaded(slow) && recovered.isDownloaded(next) &&
        statuses.get(slow.id)?.state === DS.DONE && statuses.get(next.id)?.state === DS.DONE, "resumed songs committed and tasks completed");
    assert.strictEqual(statuses.get(slow.id).state, DS.DONE);
    assert.strictEqual(statuses.get(next.id).state, DS.DONE);
    // A stalled plugin source lookup must not prevent pausing.
    plugin.callPluginDelegateMethod = async song => song.id === "queue-source-held" ? heldSource : { url: baseURL + "/ok" };
    const held = makeSong("queue-source-held");
    await core.startDownload(held);
    await core.pauseAllDownloads();
    assert.strictEqual(statuses.get(held.id).state, DS.PAUSED);
    holdSource({ url: baseURL + "/ok" });
    await core.resumeAllDownloads();
    await until(() => recovered.isDownloaded(held), "resume source lookup");
    // A saved file with a failed record write must retry only the metadata, not the network.
    const retry = makeSong("queue-record-retry");
    db.musicStore.bulkPut = async () => {
        throw new Error("Injected record save failure");
    };
    await core.startDownload(retry);
    await until(() => statuses.get(retry.id)?.state === DS.ERROR, "record save failure");
    assert.strictEqual(statuses.get(retry.id).msg, "download_page.save_failed");
    assert.strictEqual(recovered.isDownloaded(retry), false);
    const transfersBeforeRetry = sourceCalls.filter(id => id === retry.id).length;
    db.musicStore.bulkPut = originalBulkPut;
    await core.retryFailedDownloads();
    await until(() => recovered.isDownloaded(retry), "metadata retry");
    assert.strictEqual(sourceCalls.filter(id => id === retry.id).length, transfersBeforeRetry, "metadata retry must not download the song again");
    assert.strictEqual(statuses.get(retry.id).state, DS.DONE);
    // Reproduce a notification error after the music metadata transaction commits.
    // This must not leave an ERROR task beside a completed downloaded record.
    const observerFailure = makeSong("queue-observer-failure");
    const React = req("react");
    const { createRoot } = req("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const downloadStatusView = compile("src/renderer/pages/main-page/views/download-view/components/Downloading/DownloadStatus.tsx", {
        "@/common/constant": constants,
        "@/common/media-util": media,
        "@/common/normalize-util": normalization,
        "@/renderer/core/downloader": core,
        "react-i18next": { useTranslation: () => ({ t: key => key }) },
    }).default;
    function Probe() {
        const tasks = core.useDownloadingMusicList();
        return React.createElement("div", null,
            React.createElement("span", { id: "pending-count" }, tasks.length),
            React.createElement(downloadStatusView, { musicItem: observerFailure }));
    }
    const reactRoot = createRoot(container);
    reactRoot.render(React.createElement(Probe));
    await until(() => container.querySelector("#pending-count"), "mounted download status component");
    // Reproduce an exception from the completion notification after it reaches subscribers.
    const originalEmit = eeModule.ee.emit.bind(eeModule.ee);
    eeModule.ee.emit = (event, ...args) => {
        const result = originalEmit(event, ...args);
        if (event === eeModule.DownloadEvts.Downloaded && args[0].some(song => song.id === observerFailure.id)) {
            throw new Error("Injected post-commit completion notification failure");
        }
        return result;
    };
    await core.startDownload(observerFailure);
    await until(() => statuses.get(observerFailure.id)?.state === DS.DONE || statuses.get(observerFailure.id)?.state === DS.ERROR, "post-commit observer outcome");
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.strictEqual(recovered.isDownloaded(observerFailure), true, "metadata committed before notification error");
    assert.strictEqual(statuses.get(observerFailure.id).state, DS.DONE, "successful persisted download must never retain ERROR status after a notification error");
    await until(() => container.querySelector("#pending-count").textContent === "0", "successful task removed from downloading list");
    assert(!container.textContent.includes("download_page.failed"), "mounted download status must agree with completed song icon");
    assert(container.textContent.includes("common.downloaded"), "mounted component must show completed status");
    eeModule.ee.emit = originalEmit;
    assert.strictEqual((await core.removeDownloadedMusic(observerFailure))[0], true);
    await until(() => !container.textContent.includes("common.downloaded"), "removed record clears completed status");
    assert.strictEqual(core.getDownloadStatus(observerFailure), null);
    reactRoot.unmount();
    container.remove();
    channel.port1.close(); channel.port2.close();
    window.Worker = originalWorker;
    db.close();
    return "PASS: actual Windows Electron/IndexedDB concurrent records, stale index recovery, failed commits, real HTTP streams, collision protection, pause/resume, Comlink queue control, source cancellation, record-only retry, post-commit notification failure and mounted React status synchronization";

};
