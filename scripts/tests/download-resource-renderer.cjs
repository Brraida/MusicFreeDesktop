module.exports = async (testRoot, base) => {
    const fs = require("node:fs");
    const path = require("node:path");
    window.path = path;
    const assert = require("node:assert/strict");
    const { createRequire } = require("node:module");
    const req = createRequire(path.resolve("package.json"));
    const ts = req("typescript"), cache = new Map();
    function compile(file, mocks = {}) {
        const full = path.resolve(file), localRequire = createRequire(full);
        const module = { exports: {} };
        const code = ts.transpileModule(fs.readFileSync(full, "utf8"), { compilerOptions: {
            module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021,
            esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX,
        } }).outputText;
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
    const constants = compile("src/common/constant.ts");
    const media = compile("src/common/media-util.ts", { "./constant": constants });
    const Store = compile("src/common/store.ts").default;
    const db = compile("src/renderer/core/db/music-sheet-db.ts", { "@/common/constant": constants }).default;
    const prefs = compile("src/renderer/utils/user-perference.ts", {
        "@/common/safe-serialization": compile("src/common/safe-serialization.ts"),
    });
    const oldDir = path.join(testRoot, "old"), newDir = path.join(testRoot, "new"), missingDir = path.join(testRoot, "missing");
    for (const dir of [oldDir, newDir, missingDir]) fs.mkdirSync(dir);
    let configChanged;
    window["@shared/app-config"] = { syncConfig: async () => ({ "download.path": oldDir }),
        onConfigUpdate: callback => {
            configChanged = callback;
        },
        setConfig: patch => configChanged(patch), reset() {},
    };
    const config = compile("src/shared/app-config/renderer.ts", { "@shared/app-config/default-app-config": {} }).default;
    await config.setup();
    const ee = compile("src/renderer/core/downloader/ee.ts");
    const PQueue = compile(req.resolve("p-queue")).default;
    const resource = compile("src/common/download-resource.ts");
    const fileSystem = compile("src/common/download-file-system.ts", { "./download-resource": resource });
    const Watcher = compile("src/common/download-directory-watcher.ts", { "./download-resource": resource }).DownloadDirectoryWatcher;
    const watcher = new Watcher();
    const faults = new Map();
    let beforeInspection = async () => {};
    const files = {
        inspectDownloadFile: async (...args) => {
            await beforeInspection(...args);
            return faults.get(args[0]) ?? fileSystem.inspectDownloadFile(...args);
        },
        watchDownloadDirectories: (dirs, notify) => watcher.watch(dirs, notify),
        stopDownloadWatcher: () => watcher.stop(),
        async isFile(fp) {
            try {
                return (await fs.promises.stat(fp)).isFile();
            } catch {
                return false;
            }
        },
        addFileScheme: fp => require("node:url").pathToFileURL(fp).toString(),
        async rimraf(fp) {
            await fs.promises.rm(fp, { force: true }); return true;
        },
    };
    const context = { getGlobalContext: () => ({ platform: process.platform, appPath: { downloads: oldDir }, workersPath: { downloader: "test" } }) };
    const logger = { logError() {}, logInfo() {} };
    const mocks = { "@/common/download-resource": resource, "@/common/media-util": media, "@/common/store": Store,
        "@/renderer/utils/user-perference": prefs, "../db/music-sheet-db": db,
        "@/common/constant": constants, "./ee": ee, "@shared/utils/renderer": { fsUtil: files },
        "p-queue": PQueue, "@shared/logger/renderer": logger,
        "@shared/app-config/renderer": config, "@/shared/global-context/renderer": context,
    };
    const sheet = compile("src/renderer/core/downloader/downloaded-sheet.ts", mocks);
    const { DownloadResourceState: State } = resource;
    const song = id => ({ platform: "test", id, title: id, artist: "artist" });
    const A = song("A"), B = song("B"), C = song("C"), D = song("D");
    const oldA = path.join(oldDir, "A.mp3"), oldB = path.join(oldDir, "B.mp3");
    const complete = (item, fp) => media.setInternalData(item, "downloadData", { path: fp, quality: "high" }, true);
    fs.writeFileSync(oldA, "original-A"); fs.writeFileSync(oldB, "original-B");
    const originalWorker = window.Worker; window.Worker = class {};
    const core = compile("src/renderer/core/downloader/index.ts", {
        "@/common/media-util": media, comlink: { wrap: () => ({}) }, "@/common/constant": constants,
        "p-queue": PQueue, "./downloaded-sheet": sheet, "@/shared/global-context/renderer": context,
        "@/common/store": Store, "./ee": ee, "@shared/app-config/renderer": config,
        "@shared/plugin-manager/renderer": {}, "@/shared/i18n/renderer": { i18n: { t: key => key } },
        "@shared/logger/renderer": logger,
    }).default;
    await sheet.setupDownloadedMusicList();
    assert.equal(await sheet.addDownloadedMusicToList([complete(A, oldA), complete(B, oldB)]), true);
    const favorite = await db.musicStore.get([A.platform, A.id]);
    favorite[constants.musicRefSymbol]++; favorite.favoriteMarker = "keep favorite metadata";
    await db.musicStore.put(favorite);
    const React = req("react"), { createRoot } = req("react-dom/client");
    const Icon = compile("src/renderer/components/MusicDownloaded/index.tsx", {
        "@/common/media-util": media, "@/renderer/components/SvgAsset": props => React.createElement("span", { "data-icon": props.iconName }),
        "@/common/download-resource": resource, "./index.scss": {}, "@/common/constant": constants, "@/renderer/core/downloader": core,
        "react-i18next": { useTranslation: () => ({ t: key => key }) },
    }).default;
    const container = document.getElementById("test-root"), view = createRoot(container);
    function Probe() {
        const downloaded = core.useDownloadedMusicList();
        return React.createElement("div", null, React.createElement(Icon, { musicItem: favorite }),
            React.createElement("span", { id: "downloaded-count" }, downloaded.length));
    }
    const alerts = [];
    const DownloadView = compile("src/renderer/pages/main-page/views/download-view/index.tsx", {
        "./index.scss": {}, "./components/Downloaded": Probe, "./components/Downloading": () => null,
        "@/renderer/core/downloader": core, "react-toastify": { toast: { error: message => alerts.push(message) } },
        "react-i18next": { useTranslation: () => ({ t: key => key }) },
    }).default;
    view.render(React.createElement(DownloadView));
    const until = async (check, label) => {
        const deadline = Date.now() + 12000;
        while (!await check()) {
            if (Date.now() > deadline) throw new Error("Timed out: " + label);
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    };
    const iconIs = name => !!container.querySelector("[data-icon=\"" + name + "\"]");
    const dataOf = item => media.getInternalData(sheet.getDownloadedMusicItem(item), "downloadData");
    const effective = item => resource.effectiveResourceState(sheet.getDownloadResourceStatus(item));
    await until(() => iconIs("check-circle"), "mounted favorite initially downloaded");
    fs.unlinkSync(oldA);
    await until(() => iconIs("array-download-tray"), "external deletion updates favorite without setting change");
    assert.equal(effective(A), State.MISSING); assert.equal(container.querySelector("#downloaded-count").textContent, "1");
    assert.equal((await db.musicStore.get([A.platform, A.id]))[constants.musicRefSymbol], 2);
    fs.writeFileSync(oldA, "original-A");
    await until(() => iconIs("check-circle"), "restored file updates mounted UI");
    fs.rmSync(oldDir, { recursive: true });
    await until(() => effective(A) === State.MISSING && effective(B) === State.MISSING, "whole directory deleted");
    fs.mkdirSync(oldDir); fs.writeFileSync(oldA, "original-A"); fs.writeFileSync(oldB, "original-B");
    await until(() => sheet.isDownloaded(A) && sheet.isDownloaded(B), "deleted directory recreated");

    // Same name and size cannot impersonate a moved file.
    const newA = path.join(newDir, "A.mp3");
    fs.writeFileSync(newA, "impostor-A"); fs.unlinkSync(oldA);
    config.setConfig({ "download.path": newDir });
    await until(() => effective(A) === State.MISSING, "wrong same-name candidate rejected");
    assert.equal(dataOf(A).path, oldA);
    fs.writeFileSync(newA, "original-A");
    await until(() => dataOf(A).path === newA && iconIs("check-circle"), "hash-matched move recovered by watcher");
    assert.equal((await db.musicStore.get([A.platform, A.id])).favoriteMarker, favorite.favoriteMarker);

    // Access errors retain the association and remain visible in the downloaded list.
    const refreshButton = () => [...container.querySelectorAll("button")].find(button => button.textContent === "download_page.refresh_files");
    for (const reason of ["permission", "offline", "io"]) {
        faults.set(newA, { state: State.UNAVAILABLE, reason });
        refreshButton().click();
        await until(() => effective(A) === State.UNAVAILABLE && sheet.getDownloadResourceStatus(A).reason === reason
            && iconIs("question-mark-circle") && refreshButton(), reason + " UI");
        assert.equal(dataOf(A).path, newA); assert.equal(sheet.isDownloaded(A), false);
        assert.equal(container.querySelector("#downloaded-count").textContent, "2");
        assert.equal((await db.musicStore.get([A.platform, A.id]))[constants.musicRefSymbol], 2);
    }
    faults.clear(); refreshButton().click();
    await until(() => iconIs("check-circle") && refreshButton(), "access restoration via manual refresh");
    fs.writeFileSync(newA, "tampered-A");
    await until(() => effective(A) === State.UNAVAILABLE && sheet.getDownloadResourceStatus(A).reason === "changed", "content modification rejected");
    fs.writeFileSync(newA, "original-A");
    await until(() => iconIs("check-circle"), "original content restoration");
    await sheet.refreshDownloadedMusicItem(A, newA);
    assert.equal(sheet.getDownloadResourceStatus(A).reason, "playback");
    await sheet.refreshDownloadedMusicList(); assert.equal(sheet.isDownloaded(A), true);

    // A check started for an old configuration cannot commit or publish its result.
    const race1 = path.join(testRoot, "race1"), race2 = path.join(testRoot, "race2");
    fs.mkdirSync(race1); fs.mkdirSync(race2);
    const oldC = path.join(oldDir, "C.mp3"), firstC = path.join(race1, "C.mp3"), finalC = path.join(race2, "C.mp3");
    fs.writeFileSync(oldC, "C"); await sheet.addDownloadedMusicToList(complete(C, oldC));
    fs.renameSync(oldC, firstC); fs.copyFileSync(firstC, finalC);
    let release, entered;
    const held = new Promise(resolve => {
        release = resolve;
    });
    const started = new Promise(resolve => {
        entered = resolve;
    });
    beforeInspection = async fp => {
        if (fp === firstC) {
            entered(); await held;
        }
    };
    const publishedPaths = [];
    const observer = items => items.forEach(item => {
        if (item.id === C.id) publishedPaths.push(media.getInternalData(item, "downloadData").path);
    });
    ee.ee.on(ee.DownloadEvts.ResourcesChanged, observer);
    config.setConfig({ "download.path": race1 }); const obsolete = sheet.refreshDownloadedMusicList();
    await started; config.setConfig({ "download.path": race2 }); release(); await obsolete;
    beforeInspection = async () => {};
    await until(() => dataOf(C).path === finalC, "latest directory wins");
    assert(!publishedPaths.includes(firstC)); ee.ee.off(ee.DownloadEvts.ResourcesChanged, observer);

    // Failed relocation writes preserve both the record and last confirmed resource state.
    const oldD = path.join(oldDir, "D.mp3"), newD = path.join(race2, "D.mp3");
    fs.writeFileSync(oldD, "D"); await sheet.addDownloadedMusicToList(complete(D, oldD)); fs.renameSync(oldD, newD);
    const put = db.musicStore.bulkPut.bind(db.musicStore);
    db.musicStore.bulkPut = async () => {
        throw new Error("Injected resource commit failure");
    };
    await assert.rejects(sheet.refreshDownloadedMusicList(), /Injected resource commit failure/);
    assert.equal(dataOf(D).path, oldD); assert.equal(effective(D), State.AVAILABLE);
    db.musicStore.bulkPut = put; await sheet.refreshDownloadedMusicList();
    assert.equal(dataOf(D).path, newD);
    // Re-downloading a missing resource replaces the association without adding a reference.
    fs.unlinkSync(newA); await sheet.refreshDownloadedMusicList();
    const replacementA = path.join(race2, "A-new.mp3"); fs.writeFileSync(replacementA, "replacement");
    await Promise.all([sheet.addDownloadedMusicToList(complete(A, replacementA)), sheet.refreshDownloadedMusicList()]);
    assert.equal(dataOf(A).path, replacementA); assert.equal((await db.musicStore.get([A.platform, A.id]))[constants.musicRefSymbol], 2);
    assert.equal(alerts.length, 0);
    view.unmount(); await sheet.stopDownloadedMusicMonitor(); window.Worker = originalWorker; db.close();
    return "PASS: real Windows watcher + IndexedDB + React, external deletion/restoration/directory recreation, hash-verified moves, manual refresh, offline/permission/I/O/content/playback unavailability, stale configuration exclusion, commit rollback, concurrent re-download ownership";
};
