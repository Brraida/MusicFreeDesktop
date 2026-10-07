module.exports = async (testRoot, base) => {
    const fs = require("node:fs");
    const path = require("node:path");
    window.path = path;
    const assert = require("node:assert/strict");
    const { createRequire } = require("node:module");
    const req = createRequire(path.resolve("package.json"));
    const ts = req("typescript"), cache = new Map();
    function compile(file, mocks = {}, suffix = "") {
        const full = path.resolve(file), localRequire = createRequire(full);
        const module = { exports: {} };
        const code = ts.transpileModule(fs.readFileSync(full, "utf8") + suffix, { compilerOptions: {
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
        setConfig: patch => {
            configChanged(patch); return { success: true };
        }, reset() {},
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
    let indexWrites = 0, indexSaveFails = false;
    const trackedPrefs = { ...prefs, setUserPreferenceIDB: async (key, value) => {
        if (key === "downloadedList") {
            ++indexWrites;
            if (indexSaveFails) return false;
        }
        return prefs.setUserPreferenceIDB(key, value);
    } };
    const mocks = { "@/common/time-util": compile("src/common/time-util.ts"), "@/common/download-resource": resource, "@/common/media-util": media, "@/common/store": Store,
        "@/renderer/utils/user-perference": trackedPrefs, "../db/music-sheet-db": db,
        "@/common/constant": constants, "./ee": ee, "@shared/utils/renderer": { fsUtil: files },
        "p-queue": PQueue, "@shared/logger/renderer": logger,
        "@shared/app-config/renderer": config, "@/shared/global-context/renderer": context,
    };
    const HookReact = req("react"); let stateUpdates = 0;
    let sheet = compile("src/renderer/core/downloader/downloaded-sheet.ts", { ...mocks, react: { ...HookReact,
        useState: initial => {
            const [value, setValue] = HookReact.useState(initial);
            return [value, next => {
                ++stateUpdates; setValue(next);
            }];
        },
    } }, "\nexport { resourceStore as resourceStoreTest, saveDownloadIndex as saveDownloadIndexTest }; export const checkBatchTest = (items) => mutations.add(() => reconcileDownloadedMusicList(undefined, false, undefined, new Set(items.map(getMediaPrimaryKey)))); export const getVisibleTest = () => downloadedMusicListStore.getValue();");
    const { DownloadResourceState: State } = resource;
    const song = id => ({ platform: "test", id, title: id, artist: "artist" });
    const A = song("A"), B = song("B"), C = song("C"), D = song("D");
    const oldA = path.join(oldDir, "A.mp3"), oldB = path.join(oldDir, "B.mp3");
    const complete = (item, fp) => media.setInternalData(item, "downloadData", { path: fp, quality: "high" }, true);
    fs.writeFileSync(oldA, "original-A"); fs.writeFileSync(oldB, "original-B");
    const originalWorker = window.Worker; window.Worker = class {};
    const makeCore = sheet => compile("src/renderer/core/downloader/index.ts", {
        "@/common/download-resource": resource,
        "@/common/media-util": media, comlink: { wrap: () => ({}) }, "@/common/constant": constants,
        "p-queue": PQueue, "./downloaded-sheet": sheet, "@/shared/global-context/renderer": context,
        "@/common/store": Store, "./ee": ee, "@shared/app-config/renderer": config,
        "@shared/plugin-manager/renderer": {}, "@/shared/i18n/renderer": { i18n: { t: key => key } },
        "@shared/logger/renderer": logger,
    }).default;
    let core = makeCore(sheet);
    indexSaveFails = true;
    assert.equal(await sheet.saveDownloadIndexTest(), false);
    indexSaveFails = false;
    assert.equal(await sheet.saveDownloadIndexTest(), true);
    const committedWrites = indexWrites;
    assert.equal(await sheet.saveDownloadIndexTest(), true);
    assert.equal(indexWrites, committedWrites, "Identical committed indexes skip writes; failed indexes retry");
    {
        const React = req("react"), { createRoot } = req("react-dom/client"), { flushSync } = req("react-dom");
        const fixture = createRoot(document.getElementById("test-root"));
        let renders = 0, current;
        function Target({ item }) {
            ++renders; current = sheet.useDownloadResourceStatus(item); return null;
        }
        flushSync(() => fixture.render(React.createElement(Target, { item: A })));
        await new Promise(r => setTimeout(r, 50)); const before = renders, beforeUpdates = stateUpdates;
        flushSync(() => sheet.resourceStoreTest.setValue(new Map([[media.getMediaPrimaryKey(B), { state: State.AVAILABLE }]])));
        assert.equal(renders, before, "Unrelated resource changes must not rerender this song");
        assert.equal(stateUpdates, beforeUpdates, "Unrelated changes must not enqueue React state updates");
        const available = { state: State.AVAILABLE, path: oldA };
        flushSync(() => sheet.resourceStoreTest.setValue(new Map([[media.getMediaPrimaryKey(A), available]])));
        assert.equal(current, available);
        flushSync(() => fixture.render(React.createElement(Target, { item: C })));
        assert.equal(current.state, State.NO_RECORD, "Identity changes cannot flash another song's availability");
        fixture.unmount(); assert.equal(sheet.resourceStoreTest.valueChangeCbs.size, 0);
        sheet.resourceStoreTest.setValue(new Map());
    }

    {
        // First launch with legacy download metadata: showing the UI must not wait for any disk read.
        const legacy = Array.from({ length: 24 }, (_, index) => {
            const item = complete(song("startup-" + index), path.join(oldDir, "startup-" + index + ".mp3"));
            item[constants.musicRefSymbol] = 1;
            fs.writeFileSync(media.getInternalData(item, "downloadData").path, "startup audio " + index);
            return item;
        });
        await db.musicStore.bulkPut(legacy);
        let unblock, entered;
        const blocked = new Promise(resolve => {
            unblock = resolve;
        });
        const started = new Promise(resolve => {
            entered = resolve;
        });
        const inspections = [];
        beforeInspection = async fp => {
            inspections.push(fp);
            if (fp === media.getInternalData(legacy[0], "downloadData").path) {
                entered(); await blocked;
            }
        };
        await sheet.setupDownloadedMusicListInBackground();
        assert.equal(inspections.length, 0, "metadata readiness must not perform disk I/O");
        assert.equal(sheet.getDownloadResourceStatus(legacy[23]).state, State.CHECKING);
        assert.equal(sheet.isDownloaded(legacy[23]), false, "unchecked files must not be advertised as available");
        await started;
        let allChecked = false;
        const fullCheck = sheet.setupDownloadedMusicList().then(() => {
            allChecked = true;
        });
        const selected = sheet.refreshDownloadedMusicItem(legacy[23]);
        const noDuplicate = core.startDownload(legacy[22]);
        unblock();
        assert.equal((await selected).state, State.AVAILABLE);
        assert.deepEqual(await noDuplicate, { added: 0, skipped: 1 }, "unchecked existing song must not be downloaded again");
        assert.equal(allChecked, false, "playing one song must not wait for the entire library");
        assert(inspections.indexOf(media.getInternalData(legacy[23], "downloadData").path)
        < inspections.indexOf(media.getInternalData(legacy[8], "downloadData").path)
        || !inspections.includes(media.getInternalData(legacy[8], "downloadData").path), "selected song takes priority between batches");
        await fullCheck;
        assert(legacy.every(item => sheet.isDownloaded(item)), "background migration must eventually verify every record");
        assert.deepEqual(sheet.getVisibleTest().map(item => item.id), (await db.musicStore.toArray()).map(item => item.id), "Verification priority cannot reorder the download list");
        await sheet.stopDownloadedMusicMonitor();
        beforeInspection = async () => {};
        const unchangedItem = sheet.getDownloadedMusicItem(legacy[0]);
        const unchangedData = JSON.stringify(await db.musicStore.get([legacy[0].platform, legacy[0].id]));
        let redundantWrites = 0;
        const originalPut = db.musicStore.bulkPut.bind(db.musicStore);
        db.musicStore.bulkPut = (...args) => {
            ++redundantWrites; return originalPut(...args);
        };
        beforeInspection = async file => {
            inspections.push(file);
        };
        const checksBefore = inspections.length;
        await sheet.checkBatchTest(legacy.slice(0, 8));
        assert.equal(redundantWrites, 0, "Unchanged background conclusions must not rewrite persistence timestamps");
        assert.equal(inspections.length - checksBefore, 8, "Skipping redundant writes must still inspect every file");
        assert.equal(sheet.getDownloadedMusicItem(legacy[0]), unchangedItem);
        assert.equal(JSON.stringify(await db.musicStore.get([legacy[0].platform, legacy[0].id])), unchangedData);
        await db.musicStore.update([legacy[1].platform, legacy[1].id], { "$.downloadData.quality": "high" });
        await sheet.checkBatchTest([legacy[1]]);
        assert.equal(media.getInternalData(sheet.getDownloadedMusicItem(legacy[1]), "downloadData").quality, "high", "Record reuse must not drop a new DB quality");
        let enteredMetadata, releaseMetadata;
        const metadataEntered = new Promise(resolve => {
            enteredMetadata = resolve;
        });
        const hold = new Promise(resolve => {
            releaseMetadata = resolve;
        });
        beforeInspection = async () => {
            enteredMetadata(); await hold;
        };
        const metadataCheck = sheet.checkBatchTest([legacy[1]]); await metadataEntered;
        await db.musicStore.update([legacy[1].platform, legacy[1].id], { title: "Concurrent DB title", [constants.musicRefSymbol]: 7 });
        releaseMetadata(); await metadataCheck;
        assert.equal(sheet.getDownloadedMusicItem(legacy[1]).title, "Concurrent DB title");
        assert.equal(sheet.getDownloadedMusicItem(legacy[1])[constants.musicRefSymbol], 7);
        assert.equal(redundantWrites, 0, "Background checks must preserve concurrent metadata without rewriting unchanged file conclusions");
        beforeInspection = async () => {};
        db.musicStore.bulkPut = originalPut;
        // A real file identity change still requires a commit and can fail.
        const changedFile = media.getInternalData(legacy[0], "downloadData").path;
        const stat = fs.statSync(changedFile);
        fs.utimesSync(changedFile, stat.atime, new Date(stat.mtimeMs + 1000));
        const statusBefore = sheet.getDownloadResourceStatus(legacy[0]), itemBefore = sheet.getDownloadedMusicItem(legacy[0]);
        const bulkPut = db.musicStore.bulkPut.bind(db.musicStore);
        db.musicStore.bulkPut = () => {
            throw new Error("Injected background batch commit failure");
        };
        await assert.rejects(sheet.checkBatchTest(legacy.slice(0, 8)), /Injected background batch commit failure/);
        assert.equal(sheet.getDownloadResourceStatus(legacy[0]), statusBefore, "Background rollback restores the confirmed status object");
        assert.equal(sheet.getDownloadedMusicItem(legacy[0]), itemBefore, "A failed batch cannot publish metadata");
        assert(legacy.every(item => sheet.isDownloaded(item)));
        db.musicStore.bulkPut = bulkPut;
        await sheet.checkBatchTest(legacy.slice(0, 8));
        assert.equal(sheet.getDownloadResourceStatus(legacy[0]).state, State.AVAILABLE);
        assert.notEqual(sheet.getDownloadedMusicItem(legacy[0]), itemBefore);
        assert.equal(sheet.getDownloadResourceStatus(legacy[8]).state, State.AVAILABLE, "The next batch remains intact");
        const confirmed = sheet.getDownloadResourceStatus(legacy[0]);
        const persisted = JSON.stringify(await db.musicStore.get([legacy[0].platform, legacy[0].id]));
        let releaseStale, startedStale;
        const heldStale = new Promise(resolve => {
            releaseStale = resolve;
        });
        const enteredStale = new Promise(resolve => {
            startedStale = resolve;
        });
        beforeInspection = async file => {
            if (file === media.getInternalData(legacy[0], "downloadData").path) {
                startedStale(); await heldStale;
            }
        };
        const obsolete = sheet.checkBatchTest(legacy.slice(0, 8));
        await enteredStale;
        await config.setConfig({ "download.path": newDir }); releaseStale(); await obsolete;
        assert.equal(sheet.getDownloadResourceStatus(legacy[0]), confirmed, "A superseded batch restores its journal");
        assert.equal(JSON.stringify(await db.musicStore.get([legacy[0].platform, legacy[0].id])), persisted);
        await config.setConfig({ "download.path": oldDir }); beforeInspection = async () => {};
        assert.equal(await sheet.removeDownloadedMusic(legacy, true).then(result => result[0]), true);
        beforeInspection = async () => {};
    }
    await sheet.stopDownloadedMusicMonitor();
    {
        // Recreate the module over the same real IndexedDB to simulate a process restart.
        const cached = [];
        for (let index = 0; index < 24; index++) {
            const fp = path.join(oldDir,"cached-"+index+".mp3");
            fs.writeFileSync(fp,"cached audio "+index);
            const inspection = await fileSystem.inspectDownloadFile(fp);
            const state = index===1 ? State.MISSING : index===23 ? State.UNAVAILABLE : State.AVAILABLE;
            const item = media.setInternalData({ ...song("cached-"+String(index).padStart(2,"0")), duration:180, [constants.musicRefSymbol]:2 },"downloadData",{
                path:fp,quality:"high",fingerprint:inspection.identity,
                verified:{ version:1,path:fp,directory:oldDir,state,reason:state===State.UNAVAILABLE ? "permission" : undefined,checkedAt:Date.now() },
            },true);
            cached.push(item);
        }
        await db.musicStore.bulkPut(cached);
        const fp = index => media.getInternalData(cached[index],"downloadData").path;
        fs.unlinkSync(fp(1));fs.unlinkSync(fp(14)); // One already known missing; one removed while the app was closed.
        faults.set(fp(23),{ state:State.UNAVAILABLE,reason:"permission" });
        let watchNotify, monitorAttached=false, release0, entered0, release8, entered8;
        const held0=new Promise(resolve=>{
            release0=resolve;
        });const begun0=new Promise(resolve=>{
            entered0=resolve;
        });
        const held8=new Promise(resolve=>{
            release8=resolve;
        });const begun8=new Promise(resolve=>{
            entered8=resolve;
        });
        const inspections=[];
        beforeInspection=async file=>{
            inspections.push(file);
            if(file===fp(0)){
                entered0();await held0;
            }
            if(file===fp(8)){
                entered8();await held8;
            }
        };
        const restart=compile("src/renderer/core/downloader/downloaded-sheet.ts",{
            ...mocks,"@shared/utils/renderer":{ fsUtil:{ ...files,
                watchDownloadDirectories:async (_dirs,notify)=>{
                    monitorAttached=true;watchNotify=notify;notify({ paths:[],full:true });
                },
                stopDownloadWatcher:async()=>{},
            } },
        });
        await restart.prepareDownloadedMusicList();
        assert.equal(inspections.length,0,"Cache restoration performs no audio/disk inspection");
        assert.equal(restart.getDownloadResourceStatus(cached[14]).cached,true);
        assert.equal(restart.isDownloaded(cached[14]),true,"Last confirmed icon is available immediately");
        assert.equal(restart.getDownloadResourceStatus(cached[1]).state,State.MISSING,"Known missing results survive restart");
        assert.equal(restart.getDownloadResourceStatus(cached[23]).state,State.UNAVAILABLE,"Offline/access results survive restart");
        const React=req("react"),{ createRoot }=req("react-dom/client");
        const Icon=compile("src/renderer/components/MusicDownloaded/index.tsx",{
            "@/common/media-util":media,"@/renderer/components/SvgAsset":props=>React.createElement("span",{ "data-icon":props.iconName }),
            "@/common/download-resource":resource,"./index.scss":{},"@/common/constant":constants,
            "@/renderer/core/downloader":{ ...core,useDownloadResourceStatus:restart.useDownloadResourceStatus,
                useDownloadState:()=>constants.DownloadState.NONE,prioritizeDownloadResource:()=>Promise.resolve() },
            "react-i18next":{ useTranslation:()=>({ t:key=>key }) },
        }).default;
        const container=document.getElementById("test-root"),view=createRoot(container);
        view.render(React.createElement(Icon,{ musicItem:cached[14] }));
        const until=async check=>{
            const deadline=Date.now()+10000;while(!check()){
                assert(Date.now()<deadline,"Cached icon condition timed out");await new Promise(resolve=>setTimeout(resolve,20));
            }
        };
        await until(()=>!!container.querySelector("[data-icon=\"check-circle\"]"));
        assert.equal(container.querySelector(".music-download-base").title,"download_page.cached_status");
        assert.equal(inspections.length,0,"The restored icon renders before validation starts");
        const all=restart.setupDownloadedMusicList();await begun0;
        assert(monitorAttached,"Watcher must be attached before the baseline inspection");
        const selected=restart.prioritizeDownloadResource(cached[14]);
        assert.equal(selected,restart.prioritizeDownloadResource(cached[14]),"Visible rows share one priority request");
        release0();assert.equal(resource.effectiveResourceState(await selected),State.MISSING);
        await until(()=>!!container.querySelector("[data-icon=\"array-download-tray\"]"));
        await begun8;fs.unlinkSync(fp(3));watchNotify({ paths:[fp(3)] });
        await new Promise(resolve=>setTimeout(resolve,300));release8();await all;
        const first3=inspections.indexOf(fp(3)),second3=inspections.indexOf(fp(3),first3+1);
        assert(second3>first3 && second3<inspections.indexOf(fp(16)),"Incremental watcher corrections run before the remaining full baseline: "+JSON.stringify(inspections.map(file=>path.basename(file))));
        assert.equal(restart.getDownloadResourceStatus(cached[3]).state,State.MISSING);
        assert.equal(restart.getDownloadResourceStatus(cached[14]).cached,undefined,"Checked results are no longer historical");
        assert.equal((await db.musicStore.get([cached[14].platform,cached[14].id]))[constants.musicRefSymbol],2);
        const saved=media.getInternalData(await db.musicStore.get([cached[14].platform,cached[14].id]),"downloadData");
        assert.equal(saved.verified.state,State.MISSING);
        view.unmount();await restart.stopDownloadedMusicMonitor();
        beforeInspection=async file=>{
            inspections.push(file);
        };const before=inspections.length;
        const again=compile("src/renderer/core/downloader/downloaded-sheet.ts",{ ...mocks,"@shared/utils/renderer":{ fsUtil:{ ...files,stopDownloadWatcher:async()=>{} } } });
        await again.prepareDownloadedMusicList();assert.equal(inspections.length,before);
        assert.equal(again.getDownloadResourceStatus(cached[14]).state,State.MISSING,"Corrected missing state is restored on the next restart");
        assert.equal(again.getDownloadResourceStatus(cached[14]).cached,true);
        await again.stopDownloadedMusicMonitor();
        await db.musicStore.bulkDelete(cached.map(item=>[item.platform,item.id]));
        faults.clear();beforeInspection=async()=>{};
    }
    sheet = compile("src/renderer/core/downloader/downloaded-sheet.ts", mocks);
    core = makeCore(sheet);
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
    // The bottom bar renders this component before any song has been selected.
    req("react-dom").flushSync(() => view.render(React.createElement(Icon, { musicItem: undefined })));
    assert(container.querySelector("[data-icon=\"array-download-tray\"]"), "Empty playback state must render without crashing");
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
    assert(!(await prefs.getUserPreferenceIDB("downloadedList")).some(item => item.id === A.id && item.platform === A.platform));
    const replacementA = path.join(race2, "A-new.mp3"); fs.writeFileSync(replacementA, "replacement");
    await Promise.all([sheet.addDownloadedMusicToList(complete(A, replacementA)), sheet.refreshDownloadedMusicList()]);
    assert.equal(dataOf(A).path, replacementA); assert.equal((await db.musicStore.get([A.platform, A.id]))[constants.musicRefSymbol], 2);
    assert((await prefs.getUserPreferenceIDB("downloadedList")).some(item => item.id === A.id && item.platform === A.platform));
    assert.equal(alerts.length, 0);
    // Real HTMLAudio: delete the verified local WAV immediately before opening it.
    const enumModule = compile("src/renderer/core/track-player/enum.ts");
    const Hls = req("hls.js");
    const AudioController = compile("src/renderer/core/track-player/controller/audio-controller.ts", {
        "@/common/normalize-util": compile("src/common/normalize-util.ts"), "@/assets/imgs/album-cover.jpg": "",
        "@/renderer/utils/get-url-ext": url => path.extname(new URL(url).pathname),
        "hls.js": { __esModule: true, default: Hls, Events: Hls.Events }, "@/common/constant": constants,
        "@shared/service-manager/renderer": { RequestForwarderService: { forwardRequest: () => null } },
        "@renderer/core/track-player/controller/controller-base": compile("src/renderer/core/track-player/controller/controller-base.ts").default,
        "@renderer/core/track-player/enum": enumModule, "@/common/void-callback": () => {},
    }).default;
    const playerStore = compile("src/renderer/core/track-player/store.ts", {
        "@/common/store": Store, "@/common/constant": constants,
    }).default;
    let fallbackCalls = 0;
    const player = compile("src/renderer/core/track-player/index.ts", {
        "./enum": enumModule, "@/common/download-resource": resource,
        "@/common/media-util": { ...media, getQualityOrder: () => ["standard"] }, "@/common/constant": constants,
        "@/renderer/utils/lyric-parser": class {}, "@/renderer/utils/user-perference": prefs,
        "@shared/app-config/renderer": { getConfig: () => "standard" },
        "@/common/index-map": compile("src/common/index-map.ts", { "./media-util": media }),
        "./store": playerStore, "@renderer/core/track-player/controller/audio-controller": AudioController,
        "@shared/logger/renderer": logger, "@/common/void-callback": () => {},
        "@/common/time-util": { delay: ms => new Promise(resolve => setTimeout(resolve, ms)) },
        "@/common/unique-map": {}, "@renderer/core/link-lyric": { getLinkedLyric: async () => null },
        "@renderer/core/downloader/downloaded-sheet": sheet, "@shared/utils/renderer": { fsUtil: files },
        "@shared/plugin-manager/renderer": { callPluginDelegateMethod: async (_context, method) => {
            if (method !== "getMediaSource") return null;
            fallbackCalls++; return { url: base + "/fallback.wav" };
        } },
    }).default;
    const local = song("actual-audio"), wavPath = path.join(race2, "actual-audio.wav");
    fs.writeFileSync(wavPath, Buffer.from(await (await fetch(base + "/seed.wav")).arrayBuffer()));
    await sheet.addDownloadedMusicToList(complete(local, wavPath));
    player.audioController?.destroy(); player.createAudioController(); player.audioController.audio.muted = true;
    player.fetchCurrentLyric = async () => {}; player.setMusicQueue([local]);
    const setTrack = player.setTrack.bind(player);
    player.setTrack = (source, item, options) => {
        if (source.url.startsWith("file:")) fs.unlinkSync(wavPath);
        setTrack(source, item, options);
    };
    const playerErrors = [];
    player.on(enumModule.PlayerEvents.Error, (_item, error) => playerErrors.push(error));
    await player.playIndex(0);
    await until(() => player.audioController.audio.src === base + "/fallback.wav"
        && player.audioController.audio.currentTime > 0.02, "actual local open error recovers to decoded network WAV");
    assert.equal(fallbackCalls, 1); assert.equal(playerErrors.length, 0); assert.equal(effective(local), State.MISSING);
    player.audioController.destroy();
    view.unmount(); await sheet.stopDownloadedMusicMonitor(); window.Worker = originalWorker; db.close();
    return "PASS: cached restart before any disk reads, incremental correction during baseline, real Windows watcher + IndexedDB + React, external deletion/restoration/directory recreation, hash-verified moves, manual refresh, offline/permission/I/O/content/playback unavailability, stale configuration exclusion, commit rollback, concurrent re-download ownership, real HTMLAudio local-open failure and decoded network fallback";
};
