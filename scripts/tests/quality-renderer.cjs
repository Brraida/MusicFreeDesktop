module.exports = async () => {
    const path = require("node:path"), assert = require("node:assert/strict");
    const req = require("node:module").createRequire(path.resolve("package.json"));
    const { load } = req("./scripts/tests/source-loader.cjs");
    const React = req("react"), { createRoot } = req("react-dom/client"), { flushSync } = req("react-dom");
    const constants = load("src/common/constant.ts");
    const media = load("src/common/media-util.ts", { "./constant": constants });
    const Store = load("src/common/store.ts").default;
    const db = load("src/renderer/core/db/music-sheet-db.ts", { "@/common/constant": constants }).default;
    const store = new Store([]);
    let onAdd, onRemove, workerCount = 0;
    const watchedPaths = new Set();
    const local = load("src/renderer/core/local-music/index.ts", {
        "./store": store, "@/common/media-util": media,
        "@/renderer/utils/user-perference": { getUserPreferenceIDB: async () => [] },
        comlink: { wrap: () => ({ onAdd: async cb => {
            onAdd = cb;
        }, onRemove: async cb => {
            onRemove = cb;
        }, setupWatcher: async paths => {
            assert.equal(paths.length, 0);
        }, changeWatchPath: async (add, remove) => {
            add.forEach(value => watchedPaths.add(value)); remove.forEach(value => watchedPaths.delete(value));
        } }), proxy: fn => fn },
        "../db/music-sheet-db": db, "@/shared/global-context/renderer": { getGlobalContext: () => ({ workersPath: { localFileWatcher: "data:application/javascript," } }) },
    }).default;
    const RealWorker = window.Worker;
    window.Worker = class {
        constructor() {
            ++workerCount;
        }
    };
    await local.setupLocalMusic();
    assert.equal(workerCount, 0, "No local directories must not allocate a scanner worker");
    await Promise.all([local.changeWatchPath(new Map([["root-A", "add"]])), local.changeWatchPath(new Map([["root-B", "add"]]))]);
    assert.equal(workerCount, 1, "Concurrent first directory additions must share one ready worker");
    assert.deepEqual([...watchedPaths].sort(), ["root-A", "root-B"]);
    window.Worker = RealWorker;
    const A = { id: "A", platform: "test", title: "MATCH A", $$localPath: "A.mp3" };
    const B = { ...A, id: "B", title: "MATCH B", $$localPath: "B.mp3" };
    let fullReads = 0;
    db.localMusicStore.toArray = () => {
        fullReads++; throw new Error("Full library reads forbidden after initialization");
    };
    await Promise.all([onAdd([A]), onAdd([B]), onAdd([{ ...A, title: "Updated" }])]);
    assert.equal(fullReads, 0); assert.equal(store.getValue().length, 2);
    assert.equal(store.getValue()[0].title, "Updated");
    const before = store.getValue(), dbBefore = await db.localMusicStore.orderBy(":id").toArray();
    const transaction = db.transaction.bind(db);
    db.transaction = (...args) => transaction(...args.slice(0, -1), async () => {
        await args.at(-1)(); throw new Error("Injected failure after bulk write before commit");
    });
    await assert.rejects(() => onAdd([{ ...A, title: "Corrupt" }]));
    await assert.rejects(() => onRemove([A.$$localPath]));
    assert.equal(store.getValue(), before);
    assert.deepEqual(await db.localMusicStore.orderBy(":id").toArray(), dbBefore);
    db.transaction = transaction;
    await onRemove([A.$$localPath]);
    assert.deepEqual(store.getValue(), [B]);
    await onAdd([{ ...A, title: "Updated" }]); // A failed queue item must not poison later commits.

    const node = document.getElementById("test-root"), root = createRoot(node);
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    // A layout update before passive subscription must not leave a stale value.
    const counter = new Store(0);
    function Reader() {
        return React.createElement("span", { id: "snapshot" }, counter.useValue());
    }
    function Parent() {
        React.useLayoutEffect(() => {
            counter.setValue(1);
        }, []);
        return React.createElement(Reader);
    }
    flushSync(() => root.render(React.createElement(Parent))); await frame();
    assert.equal(node.querySelector("#snapshot").textContent, "1");
    flushSync(() => root.render(null)); assert.equal(counter.stateMapper.cbs.size, 0);

    const callbacks = new Set(); let sensitive = false, shown;
    const config = { getConfig: () => sensitive, onConfigUpdate: cb => callbacks.add(cb), offConfigUpdate: cb => callbacks.delete(cb) };
    const useAppConfig = load("src/hooks/useAppConfig.ts", { "@shared/app-config/renderer": config }).default;
    const Switch = props => React.createElement(React.Fragment, {}, props.children);
    const View = load("src/renderer/pages/main-page/views/local-music-view/index.tsx", {
        "./index.scss": {}, "@/renderer/core/local-music/store": store,
        "react-i18next": { useTranslation: () => ({ t: text => text }) },
        "@/renderer/components/Modal": {}, "@/renderer/components/SvgAsset": () => null,
        "../unused": {}, "@/hooks/useAppConfig": useAppConfig,
        "@/renderer/components/SwitchCase": { Switch, Case: Switch },
        ...Object.fromEntries(["list", "artist", "album", "folder"].map(name => ["./views/" + name, props => {
            shown = props.localMusicList; return null;
        }])),
    }).default;
    flushSync(() => root.render(React.createElement(View))); await frame();
    const input = node.querySelector("input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "match");
    input.dispatchEvent(new Event("input", { bubbles: true })); await frame();
    assert.deepEqual(shown.map(it => it.id), ["B"]);
    await onAdd([{ ...A, title: "match new" }]); await frame();
    assert.equal(shown.length, 2);
    await onRemove([B.$$localPath]); await frame(); assert.deepEqual(shown.map(it => it.id), ["A"]);
    sensitive = true; callbacks.forEach(cb => cb({ "playMusic.caseSensitiveInSearch": true }, { "playMusic.caseSensitiveInSearch": true })); await frame();
    assert.equal(shown.length, 1);
    await onAdd([{ ...A, title: "MATCH" }]); await frame(); assert.equal(shown.length, 0);
    flushSync(() => root.render(null)); assert.equal(callbacks.size, 0);

    // Exercise the real table engine: filtering back must reuse full rows,
    // while sorting, a replaced dataset and a separate table remain independent.
    const { createTable, getSortedRowModel } = req("@tanstack/react-table");
    const cachedRows = load("src/renderer/components/MusicList/row-model.ts", { "@tanstack/react-table": req("@tanstack/react-table") }).default;
    const tableData = [{ id: "B", title: "Bravo" }, { id: "A", title: "Alpha" }];
    const options = { data: tableData, columns: [{ accessorKey: "title" }], state: { sorting: [] },
        onStateChange() {}, renderFallbackValue: null, getCoreRowModel: cachedRows(), getSortedRowModel: getSortedRowModel() };
    const table = createTable(options);
    const allRows = table.getCoreRowModel();
    table.setOptions(previous => ({ ...previous, data: [tableData[1]] }));
    assert.equal(table.getRowModel().rows[0].getValue("title"), "Alpha");
    table.setOptions(previous => ({ ...previous, data: tableData }));
    assert.equal(table.getCoreRowModel(), allRows);
    table.setOptions(previous => ({ ...previous, state: { sorting: [{ id: "title", desc: false }] } }));
    assert.deepEqual(table.getRowModel().rows.map(row => row.original.id), ["A", "B"]);
    const updatedData = [{ id: "B", title: "Changed" }, tableData[1]];
    table.setOptions(previous => ({ ...previous, data: updatedData }));
    assert.equal(table.getCoreRowModel().rows[0].getValue("title"), "Changed");
    assert.notEqual(table.getCoreRowModel(), allRows);
    const secondTable = createTable({ ...options, getCoreRowModel: cachedRows() });
    assert.notEqual(secondTable.getCoreRowModel(), allRows, "Row closures must belong to their own table");

    const useVirtual = load("src/hooks/useVirtualList.ts").default;
    const scroll = document.createElement("div"); scroll.style.cssText = "height:80px;overflow:auto";
    const filler = document.createElement("div"); filler.style.height = "10000px"; scroll.append(filler); document.body.append(scroll);
    let binds = 0, unbinds = 0;
    const addScroll = scroll.addEventListener.bind(scroll), removeScroll = scroll.removeEventListener.bind(scroll);
    scroll.addEventListener = (type, ...args) => {
        if (type === "scroll") ++binds; return addScroll(type, ...args);
    };
    scroll.removeEventListener = (type, ...args) => {
        if (type === "scroll") ++unbinds; return removeScroll(type, ...args);
    };
    let virtual;
    const data = Array.from({ length: 1000 }, (_, i) => i);
    const props = { data, estimateItemHeight: 20, renderCount: 10, getScrollElement: () => scroll };
    function Virtual(p) {
        virtual = useVirtual(p); return null;
    }
    flushSync(() => root.render(React.createElement(Virtual, props))); await new Promise(r => setTimeout(r, 70));
    assert.equal(virtual.virtualItems.length, 10);
    for (let index = 0; index < 10; index++) {
        flushSync(() => root.render(React.createElement(Virtual, { ...props, getScrollElement: () => scroll })));
    }
    assert.equal(binds, 1, "Inline container getters must not rebind listeners");
    assert.equal(unbinds, 0);
    scroll.dispatchEvent(new Event("scroll"));
    flushSync(() => root.render(React.createElement(Virtual, { ...props, data: [42], getScrollElement: () => scroll })));
    await frame();
    assert.equal(virtual.virtualItems.length, 1, "Data changes must not wait behind the scroll throttle");
    assert.equal(virtual.virtualItems[0].dataItem, 42);
    flushSync(() => root.render(React.createElement(Virtual, { ...props, estimateItemHeight: 40, renderCount: 5 }))); await new Promise(r => setTimeout(r, 70));
    assert.equal(virtual.totalHeight, 40000); assert.equal(virtual.virtualItems.length, 5);
    virtual.scrollToIndex(20); scroll.dispatchEvent(new Event("scroll")); await new Promise(r => setTimeout(r, 50));
    assert.equal(virtual.virtualItems[0].rowIndex, 18); assert.equal(virtual.virtualItems[0].top, 720);
    const replacement = document.createElement("div"); replacement.style.cssText = scroll.style.cssText;
    replacement.append(filler.cloneNode()); document.body.append(replacement);
    let target = scroll;
    const stableProps = { ...props, estimateItemHeight: 40, renderCount: 5, getScrollElement: () => target };
    flushSync(() => root.render(React.createElement(Virtual, stableProps)));
    target = replacement;
    flushSync(() => root.render(React.createElement(Virtual, stableProps))); await frame();
    assert.equal(unbinds, 1, "A stable getter returning a new container must detach the old container");
    virtual.scrollToIndex(20); replacement.dispatchEvent(new Event("scroll")); await new Promise(r => setTimeout(r, 50));
    assert.equal(virtual.virtualItems[0].rowIndex, 18);
    scroll.scrollTop = 0; scroll.dispatchEvent(new Event("scroll")); await new Promise(r => setTimeout(r, 50));
    assert.equal(virtual.virtualItems[0].rowIndex, 18, "Detached containers must not drive the current list");
    replacement.dispatchEvent(new Event("scroll")); flushSync(() => root.unmount()); scroll.remove(); replacement.remove();
    // Full playlist restore must be atomic across sheets, references and UI indexes.
    const favorite = { id: "favorite", title: "Favorite", platform: "local", musicList: [{ platform: "test", id: "A" }], $$sortIndex: -1 };
    const other = { ...favorite, id: "old", title: "Old", musicList: [{ platform: "test", id: "A" }, { platform: "test", id: "B" }], $$sortIndex: 1 };
    await db.sheets.bulkPut([favorite, other]);
    const ref = constants.musicRefSymbol;
    const downloadA = { ...A, [ref]: 3, $: { downloadData: { path: "current/A.mp3", quality: "high" } } };
    const downloaded = { ...A, id: "download-only", [ref]: 1, $: { downloadData: { path: "current/only.mp3" } } };
    await db.musicStore.bulkPut([downloadA, { ...B, [ref]: 1 }, downloaded]);
    let sequence = 0, preferenceSaved = true;
    const backend = load("src/renderer/core/music-sheet/backend/index.ts", {
        "@/common/constant": constants, "@/common/media-util": media,
        nanoid: { nanoid: () => "restored-" + ++sequence }, "../../db/music-sheet-db": db, "../common/default-sheet": favorite,
        "@/renderer/utils/user-perference": { getUserPreferenceIDB: async () => [], setUserPreferenceIDB: async () => preferenceSaved },
    });
    const frontend = load("src/renderer/core/music-sheet/frontend/index.old.ts", {
        "@/common/store": Store, "../backend": backend, "../common/default-sheet": favorite,
        "@/common/constant": constants, "@/common/media-util": media,
    });
    await frontend.setupMusicSheets();
    await frontend.starMusicSheet(other);
    const starred = backend.getAllStarredSheets();
    preferenceSaved = false;
    for (const save of [() => frontend.starMusicSheet(favorite), () => frontend.unstarMusicSheet(other),
        () => frontend.setStarredMusicSheets([])]) {
        await assert.rejects(save, /Failed to save starred playlists/);
        assert.equal(backend.getAllStarredSheets(), starred);
    }
    preferenceSaved = true;
    const resume = load("src/renderer/core/backup-resume/index.ts", { "../music-sheet": { frontend, defaultSheet: favorite } }).default.resume;
    const C = { ...A, id: "C", title: "C" }, D = { ...A, id: "D", title: "D" };
    const backup = { musicSheets: [{ ...favorite, musicList: [C, { ...A, $: { downloadData: { path: "stale/A.mp3" } } }, A] }, { ...other, title: "Imported", musicList: [D, A] }] };
    const snapshot = async () => JSON.stringify({ sheets: await db.sheets.toArray(), music: await db.musicStore.toArray() });
    const persisted = await snapshot(), ui = JSON.stringify(frontend.getAllSheets());
    for (const bad of [null, "{broken", { musicSheets: null }, { version: 99, musicSheets: [] },
        { musicSheets: [{ title: "bad", musicList: [null] }] }, { musicSheets: [{ title: "bad", musicList: [{ platform: "test", id: [] }] }] },
        { musicSheets: [backup.musicSheets[0], backup.musicSheets[0]] }]) {
        await assert.rejects(() => resume(bad, true)); assert.equal(await snapshot(), persisted);
    }
    const bulkPut = db.sheets.bulkPut.bind(db.sheets);
    db.sheets.bulkPut = () => {
        throw new Error("Injected last playlist write failure");
    };
    await assert.rejects(() => resume(backup, true));
    assert.equal(await snapshot(), persisted); assert.equal(JSON.stringify(frontend.getAllSheets()), ui);
    assert.equal(backend.isFavoriteMusic(A), true); assert.equal(backend.isFavoriteMusic(C), false);
    db.sheets.bulkPut = bulkPut;
    await resume(backup, true);
    assert.equal((await db.sheets.toArray()).length, 2); assert.equal(await db.musicStore.get([B.platform, B.id]), undefined);
    assert.equal((await db.musicStore.get([A.platform, A.id]))[ref], 3);
    assert.deepEqual((await db.musicStore.get([A.platform, A.id])).$, downloadA.$);
    assert.deepEqual(await db.musicStore.get([downloaded.platform, downloaded.id]), downloaded);
    assert.equal((await db.sheets.get(favorite.id)).musicList.length, 2);
    assert.equal(backend.isFavoriteMusic(C), true); assert.equal(frontend.getAllSheets().some(sheet => sheet.id === "old"), false);
    await resume({ version: 1, musicSheets: [{ ...other, musicList: [D] }] }, true);
    assert.equal(backend.isFavoriteMusic(C), true, "Overwrite without a favorite backup preserves favorite tracks");
    const size = frontend.getAllSheets().length;
    await resume({ musicSheets: [{ ...other, musicList: [D, D] }] });
    await resume({ musicSheets: [{ ...other, musicList: [D, D] }] });
    assert.equal(frontend.getAllSheets().length, size + 2);
    assert.equal((await db.musicStore.get([D.platform, D.id]))[ref], 3);
    const numbered = { platform: "typed", id: 1, title: "Numeric identity" };
    const textual = { ...numbered, id: "1", title: "String identity" };
    await resume({ musicSheets: [{ ...other, musicList: [numbered, textual] }] });
    assert.equal((await db.musicStore.get(["typed", 1]))[ref], 1);
    assert.equal((await db.musicStore.get(["typed", "1"]))[ref], 1);
    assert.equal((await db.sheets.get(frontend.getAllSheets().at(-1).id)).musicList.length, 2);
    const realClear = backend.clearSheet; backend.clearSheet = async () => {
        throw new Error("Clear failed");
    };
    await assert.rejects(() => frontend.clearSheet(favorite.id)); backend.clearSheet = realClear;

    // Renderer receives failed save acknowledgements and resyncs, never reports success.
    const notices = [], synced = { "normal.language": "en-US" };
    let update, resolveSync;
    window["@shared/app-config"] = { syncConfig: () => new Promise(resolve => {
        resolveSync = resolve;
    }),
    onConfigUpdate: cb => {
        update = cb;
    }, setConfig: async () => ({ success: false, error: "ENOSPC", config: synced }),
    reset: async () => ({ success: false, error: "EACCES", config: synced }) };
    const appConfig = load("src/shared/app-config/renderer.ts", { "@shared/app-config/default-app-config": {},
        "react-toastify": { toast: { error: message => notices.push(message) } }, i18next: { t: (_key, options) => options.reason } }).default;
    const starting = appConfig.setup(); update({ "normal.language": "zh-TW" }); resolveSync(synced); await starting;
    assert.equal(appConfig.getConfig("normal.language"), "zh-TW", "Initial sync must retain broadcasts received while loading");
    window["@shared/app-config"].syncConfig = async () => synced;
    const originalLog = console.error; console.error = () => {};
    try {
        assert.equal(await appConfig.setConfig({ "normal.language": "bad" }), false);
        assert.equal(appConfig.getConfig("normal.language"), "en-US");
        assert.equal(await appConfig.reset(), false); assert.deepEqual(notices, ["ENOSPC", "EACCES"]);
        window["@shared/app-config"].setConfig = async () => {
            update({ "normal.language": "zh-CN" }); return { success: true, config: synced };
        };
        assert.equal(await appConfig.setConfig({ "normal.language": "zh-CN" }), true);
        assert.equal(appConfig.getConfig("normal.language"), "zh-CN", "An old successful reply cannot replace a newer broadcast");
        for (const acknowledgement of [undefined, {}, false]) {
            window["@shared/app-config"].setConfig = async () => acknowledgement;
            assert.equal(await appConfig.setConfig({ "normal.language": "bad" }), false);
            assert.equal(appConfig.getConfig("normal.language"), "en-US");
            assert.equal(notices.at(-1), "Invalid configuration acknowledgement");
        }
    } finally {
        console.error = originalLog;
    }

    // Persistence hook subscriptions must remain bounded through window remounts.
    const prefs = load("src/renderer/utils/user-perference.ts", {}, "\nexport const subscriptionCount = () => [...dbKeyUpdateCbs.values()].reduce((sum, callbacks) => sum + callbacks.size, 0); export const closeTest = () => upDB.close();");
    const up = createRoot(node);
    function PreferenceReader() {
        prefs.useUserPreferenceIDBValue("playList"); return null;
    }
    for (let i = 0; i < 100; i++) {
        flushSync(() => up.render(React.createElement(PreferenceReader)));
        flushSync(() => up.render(null));
    }
    await frame(); up.unmount();
    assert.equal(prefs.subscriptionCount(), 0);
    prefs.closeTest();
    const errors = [], originalError = console.error;
    console.error = (...args) => errors.push(args);
    const realSet = Storage.prototype.setItem;
    try {
        for (const value of [true, 0, "text", null, { nested: [1, "中文"] }]) {
            assert.equal(prefs.setUserPreference("currentMusic", value), true);
            assert.deepEqual(prefs.getUserPreference("currentMusic"), value);
        }
        assert.equal(prefs.setUserPreference("currentMusic", undefined), true);
        assert.equal(localStorage.getItem("currentMusic"), null);
        Storage.prototype.setItem = () => {
            throw new DOMException("Quota full", "QuotaExceededError");
        };
        assert.equal(prefs.setUserPreference("currentProgress", 123), false); assert(errors.length > 0);
    } finally {
        Storage.prototype.setItem = realSet; console.error = originalError;
    }
    // UI hotplug subscription and output-setting rollback, without touching host hardware.
    const deviceRoot = createRoot(node);
    const nativeDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    const events = new EventTarget(); let devices = [{ kind: "audiooutput", deviceId: "A" }];
    events.enumerateDevices = async () => devices;
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: events });
    try {
        const useOutput = load("src/hooks/useMediaDevices.ts").useOutputAudioDevices;
        let visible;
        function DeviceReader() {
            visible = useOutput(); return null;
        }
        flushSync(() => deviceRoot.render(React.createElement(DeviceReader))); await frame();
        assert.deepEqual(visible.map(item => item.deviceId), ["A"]);
        devices = [{ kind: "audioinput", deviceId: "mic" }, { kind: "audiooutput", deviceId: "B" }];
        events.dispatchEvent(new Event("devicechange")); await frame();
        assert.deepEqual(visible.map(item => item.deviceId), ["B"]);
        flushSync(() => deviceRoot.render(null));
        let selections, saves = 0, successful = true, change;
        const notice = [];
        const output = { setAudioOutputDevice: async id => {
            selections.push(id); return successful;
        } };
        const outputConfig = { getConfig: () => ({ deviceId: "A" }), setConfig: async () => {
            ++saves; return false;
        } };
        const PlayerSettings = load("src/renderer/pages/main-page/views/setting-view/routers/PlayMusic/index.tsx", {
            "./index.scss": {}, "../../components/RadioGroupSettingItem": () => null, "../../components/CheckBoxSettingItem": () => null,
            "@/hooks/useMediaDevices": { useOutputAudioDevices: () => [] },
            "../../components/ListBoxSettingItem": props => {
                change = props.onChange; return null;
            },
            "@renderer/core/track-player": output,
            "react-i18next": { useTranslation: () => ({ t: text => text }) }, "react-toastify": { toast: { error: text => notice.push(text) } },
            "@shared/app-config/renderer": outputConfig,
        }).default;
        flushSync(() => deviceRoot.render(React.createElement(PlayerSettings)));
        selections = [];
        await change(new Event("change", { cancelable: true }), { deviceId: "B", toJSON: () => ({ deviceId: "B" }) });
        assert.deepEqual(selections, ["B", "A"]); assert.equal(saves, 1);
        successful = false; selections = [];
        await change(new Event("change", { cancelable: true }), { deviceId: "B" });
        assert.deepEqual(selections, ["B"]); assert.equal(saves, 1); assert.equal(notice.length, 1);
        let releaseNative, startedNative, confirmedOutput = "A";
        const nativeHeld = new Promise(resolve => {
            releaseNative = resolve;
        });
        const nativeStarted = new Promise(resolve => {
            startedNative = resolve;
        });
        output.setAudioOutputDevice = async id => {
            selections.push(id);
            if (id === "B") {
                startedNative(); await nativeHeld;
            }
            return true;
        };
        const savedDevices = [];
        outputConfig.getConfig = () => ({ deviceId: confirmedOutput });
        outputConfig.setConfig = async patch => {
            confirmedOutput = patch["playMusic.audioOutputDevice"].deviceId; savedDevices.push(confirmedOutput); return true;
        };
        selections = [];
        const select = id => change(new Event("change", { cancelable: true }), { deviceId: id, toJSON: () => ({ deviceId: id }) });
        const oldSelection = select("B"); await nativeStarted;
        const newSelection = select("C"); releaseNative(); await Promise.all([oldSelection, newSelection]);
        assert.deepEqual(selections, ["B", "C"]); assert.deepEqual(savedDevices, ["C"]); assert.equal(confirmedOutput, "C");
        let releaseSave, startedSave;
        const saveHeld = new Promise(resolve => {
            releaseSave = resolve;
        });
        const saveStarted = new Promise(resolve => {
            startedSave = resolve;
        });
        confirmedOutput = "A"; selections = []; savedDevices.length = 0;
        output.setAudioOutputDevice = async id => {
            selections.push(id); return true;
        };
        outputConfig.setConfig = async patch => {
            const id = patch["playMusic.audioOutputDevice"].deviceId;
            if (id === "B") {
                startedSave(); await saveHeld; return false;
            }
            confirmedOutput = id; savedDevices.push(id); return true;
        };
        const failedOld = select("B"); await saveStarted;
        const latest = select("C"); releaseSave(); await Promise.all([failedOld, latest]);
        assert.deepEqual(selections, ["B", "A", "C"], "Rollback finishes before the newer native change");
        assert.deepEqual(savedDevices, ["C"]); assert.equal(confirmedOutput, "C");
    } finally {
        deviceRoot.unmount();
        if (nativeDevices) Object.defineProperty(navigator, "mediaDevices", nativeDevices); else delete navigator.mediaDevices;
    }
    db.close();
    return "PASS: committed incremental local updates, commit rollback, queue recovery, live search/config, subscription race/disposal and virtual dimensions/scroll; atomic backup validation/rollback/reference/download preservation, repeat imports and storage failure";
};
