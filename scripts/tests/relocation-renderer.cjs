module.exports = async (testRoot) => {
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
    const files = {
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
    const mocks = { "@/common/media-util": media, "@/common/store": Store,
        "@/renderer/utils/user-perference": prefs, "../db/music-sheet-db": db,
        "@/common/constant": constants, "./ee": ee, "@shared/utils/renderer": { fsUtil: files },
        "p-queue": PQueue, "@shared/logger/renderer": logger,
        "@shared/app-config/renderer": config, "@/shared/global-context/renderer": context,
    };
    const sheet = compile("src/renderer/core/downloader/downloaded-sheet.ts", mocks);
    const makeSong = id => ({ platform: "test", id, title: id, artist: "artist" });
    const A = makeSong("A"), B = makeSong("B"), unknown = makeSong("unrecorded");
    const oldA = path.join(oldDir, "A-artist (1).MP3"), oldB = path.join(oldDir, "B-artist.flac");
    fs.writeFileSync(oldA, "audio-A"); fs.writeFileSync(oldB, "audio-B");
    await sheet.setupDownloadedMusicList();
    const complete = (song, fp) => media.setInternalData(song, "downloadData", { path: fp, quality: "high" }, true);
    assert.equal(await sheet.addDownloadedMusicToList([complete(A, oldA), complete(B, oldB)]), true);
    // This is the same persisted favorite song object the view held before moving files.
    const favoriteA = await db.musicStore.get([A.platform, A.id]);
    favoriteA[constants.musicRefSymbol]++;
    favoriteA.favoriteMarker = "preserve this playlist metadata";
    await db.musicStore.put(favoriteA);
    const refsBefore = favoriteA[constants.musicRefSymbol];
    const originalWorker = window.Worker; window.Worker = class {};
    window.path = path;
    const core = compile("src/renderer/core/downloader/index.ts", {
        "@/common/media-util": media, comlink: { wrap: () => ({}) }, "@/common/constant": constants,
        "p-queue": PQueue, "./downloaded-sheet": sheet, "@/shared/global-context/renderer": context,
        "@/common/store": Store, "./ee": ee, "@shared/app-config/renderer": config,
        "@shared/plugin-manager/renderer": {}, "@/shared/i18n/renderer": { i18n: { t: key => key } },
        "@shared/logger/renderer": logger,
    }).default;
    const React = req("react"), { createRoot } = req("react-dom/client");
    const icon = compile("src/renderer/components/MusicDownloaded/index.tsx", {
        "@/common/media-util": media, "@/renderer/components/SvgAsset": props => React.createElement("span", { "data-icon": props.iconName }),
        "./index.scss": {}, "@/common/constant": constants, "@/renderer/core/downloader": core,
        "react-i18next": { useTranslation: () => ({ t: key => key }) },
    }).default;
    const container = document.getElementById("test-root"), view = createRoot(container);
    function Probe() {
        const downloaded = core.useDownloadedMusicList();
        return React.createElement("div", null, React.createElement(icon, { musicItem: favoriteA }),
            React.createElement("span", { id: "downloaded-count" }, downloaded.length));
    }
    view.render(React.createElement(Probe));
    const until = async (check, description) => {
        const deadline = Date.now() + 10000;
        while (!await check()) {
            if (Date.now() > deadline) throw new Error("Timed out: " + description);
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    };
    const iconIs = name => !!container.querySelector("[data-icon=\"" + name + "\"]");
    await until(() => iconIs("check-circle"), "initial favorite icon");
    const newA = path.join(newDir, path.basename(oldA));
    fs.renameSync(oldA, newA);
    fs.writeFileSync(path.join(newDir, "unrecorded-artist.mp3"), "not a recorded download");
    config.setConfig({ "download.path": newDir });
    await until(async () => media.getInternalData(await db.musicStore.get([A.platform, A.id]), "downloadData").path === newA,
        "configuration change relinks the moved file");
    await until(() => iconIs("check-circle") && container.querySelector("#downloaded-count").textContent === "2", "favorite and downloaded list agree");
    assert.equal(sheet.isDownloaded(unknown), false);
    assert.equal(media.getInternalData(await db.musicStore.get([B.platform, B.id]), "downloadData").path, oldB,
        "changing the directory must not discard a file that still exists at its old location");
    assert.equal((await db.musicStore.get([A.platform, A.id]))[constants.musicRefSymbol], refsBefore);
    assert.equal(sheet.getDownloadedMusicItem(A)[constants.musicRefSymbol], refsBefore);
    // Missing in both places clears the already mounted favorite icon.
    fs.renameSync(newA, path.join(testRoot, "temporarily-away.mp3"));
    config.setConfig({ "download.path": missingDir });
    await until(() => iconIs("array-download-tray"), "missing file clears favorite icon");
    assert.equal(sheet.isDownloaded(A), false);
    assert.equal(container.querySelector("#downloaded-count").textContent, "1");
    fs.renameSync(path.join(testRoot, "temporarily-away.mp3"), newA);
    config.setConfig({ "download.path": newDir });
    await until(() => iconIs("check-circle"), "restored file is recognized without restarting");
    // Index-only reconstruction never loses the path metadata needed for later recovery.
    assert.equal((await prefs.getUserPreferenceIDB("downloadedList")).filter(song => song.id === "A").length, 1);
    assert.equal(media.getInternalData(sheet.getDownloadedMusicItem(A), "downloadData").quality, "high");
    assert.equal(fs.readFileSync(newA, "utf8"), "audio-A");
    assert.equal((await db.musicStore.get([A.platform, A.id])).favoriteMarker, favoriteA.favoriteMarker);
    // Re-download of a missing file must reuse its existing download ownership.
    fs.unlinkSync(newA);
    await sheet.refreshDownloadedMusicList();
    assert.equal(sheet.isDownloaded(A), false);
    fs.writeFileSync(newA, "audio-A");
    assert.equal(await sheet.addDownloadedMusicToList(complete(A, newA)), true);
    assert.equal((await db.musicStore.get([A.platform, A.id]))[constants.musicRefSymbol], refsBefore);
    // Two recorded songs with the same basename cannot both claim one moved file.
    const C = makeSong("C"), D = makeSong("D");
    const subdir = path.join(oldDir, "another"); fs.mkdirSync(subdir);
    const oldC = path.join(oldDir, "shared.mp3"), oldD = path.join(subdir, "shared.mp3");
    fs.writeFileSync(oldC, "C"); fs.writeFileSync(oldD, "D");
    await sheet.addDownloadedMusicToList([complete(C, oldC), complete(D, oldD)]);
    fs.renameSync(oldC, path.join(newDir, "shared.mp3")); fs.unlinkSync(oldD);
    await sheet.refreshDownloadedMusicList();
    assert.equal(sheet.isDownloaded(C), false); assert.equal(sheet.isDownloaded(D), false);
    assert.equal(media.getInternalData(await db.musicStore.get([C.platform, C.id]), "downloadData").path, oldC);
    // Failed metadata writes must not publish the relocated path.
    const E = makeSong("E"), oldE = path.join(oldDir, "E.mp3"), newE = path.join(newDir, "E.mp3");
    fs.writeFileSync(oldE, "E"); await sheet.addDownloadedMusicToList(complete(E, oldE));
    fs.renameSync(oldE, newE);
    const bulkPut = db.musicStore.bulkPut.bind(db.musicStore);
    db.musicStore.bulkPut = async () => {
        throw new Error("Injected relocation write failure");
    };
    await assert.rejects(sheet.refreshDownloadedMusicList(), /Injected relocation write failure/);
    assert.equal(media.getInternalData(sheet.getDownloadedMusicItem(E), "downloadData").path, oldE);
    assert.equal(media.getInternalData(await db.musicStore.get([E.platform, E.id]), "downloadData").path, oldE);
    db.musicStore.bulkPut = bulkPut;
    await sheet.refreshDownloadedMusicList();
    assert.equal(media.getInternalData(sheet.getDownloadedMusicItem(E), "downloadData").path, newE);
    // A fresh module recovers moved files even when the preference index is empty.
    const nextDir = path.join(testRoot, "after-restart"); fs.mkdirSync(nextDir);
    const restartedA = path.join(nextDir, path.basename(newA)); fs.renameSync(newA, restartedA);
    await prefs.setUserPreferenceIDB("downloadedList", []);
    const startupConfig = { getConfig: () => nextDir, onConfigUpdate() {} };
    const restarted = compile("src/renderer/core/downloader/downloaded-sheet.ts", { ...mocks, "@shared/app-config/renderer": startupConfig });
    await restarted.setupDownloadedMusicList();
    assert.equal(restarted.isDownloaded(A), true);
    assert.equal(media.getInternalData(restarted.getDownloadedMusicItem(A), "downloadData").path, restartedA);
    assert.equal((await db.musicStore.get([A.platform, A.id]))[constants.musicRefSymbol], refsBefore);
    view.unmount(); window.Worker = originalWorker; db.close();
    return "PASS: real Windows file move, automatic download directory reconciliation, mounted favorite icon, missing/restore, suffix/case, old valid files, startup recovery, ambiguous names, transaction rollback, re-download ownership, index/quality/reference preservation";
};
