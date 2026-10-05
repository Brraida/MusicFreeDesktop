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
    const favorite = {id:'review-favorite',platform:constants.localPluginName,title:'Review',musicList:[]};
    await db.sheets.put(favorite);
    const backend = compile('src/renderer/core/music-sheet/backend/index.ts', {
        '@/common/constant':constants, nanoid:{nanoid:()=> 'unused'}, '../../db/music-sheet-db':db,
        '../common/default-sheet':favorite, '@/common/media-util':media, '@/renderer/utils/user-perference':prefs,
    });
    await backend.queryAllSheets();
    const localPath=path.join(oldDir,'local.mp3');fs.writeFileSync(localPath,'local file');
    const local=media.setInternalData({platform:constants.localPluginName,id:'review-local',title:'Local',localPath},'downloadData',{path:localPath,quality:'standard'},true);
    await backend.addMusicToSheet(local,favorite.id);
    await sheet.setupDownloadedMusicList();
    const recognized=sheet.isDownloaded(local);
    const before=await db.musicStore.get([local.platform,local.id]);
    const remove=await sheet.removeDownloadedMusic(local,true);
    const after=await db.musicStore.get([local.platform,local.id]);
    const playlist=await db.sheets.get(favorite.id);
    assert.equal(recognized,true);assert.equal(before[constants.musicRefSymbol],1);
    assert.equal(after,undefined);assert.ok(playlist.musicList.some(x=>x.id===local.id));
    assert.equal(fs.existsSync(localPath),false);
    const localResult={originalLocalFileExists:fs.existsSync(localPath),recognized,refsBefore:before[constants.musicRefSymbol],remove,recordExistsAfter:!!after,playlistStillReferences:playlist.musicList.some(x=>x.id===local.id)};
    const remotePath=path.join(oldDir,'remote.mp3');fs.writeFileSync(remotePath,'remote file');
    const remote=media.setInternalData({platform:'test',id:'review-remote',title:'Remote'},'downloadData',{path:remotePath,quality:'standard'},true);
    await sheet.addDownloadedMusicToList(remote);
    let entered,release;
    const enteredGate=new Promise(resolve=>entered=resolve), releaseGate=new Promise(resolve=>release=resolve);
    files.rimraf=async fp=>{entered();await releaseGate;await fs.promises.rm(fp,{force:true});return true;};
    const pendingRemove=sheet.removeDownloadedMusic(remote,true);
    await enteredGate;
    await backend.addMusicToSheet(remote,favorite.id);
    const updatedRefs=(await db.musicStore.get([remote.platform,remote.id]))[constants.musicRefSymbol];
    release();await pendingRemove;
    const remaining=await db.musicStore.get([remote.platform,remote.id]);
    const latest=await db.sheets.get(favorite.id);
    assert.equal(updatedRefs,2);assert.equal(remaining,undefined);assert.ok(latest.musicList.some(x=>x.id===remote.id));
    const concurrencyResult={refsAfterConcurrentAdd:updatedRefs,recordExistsAfterRemove:!!remaining,playlistStillReferences:latest.musicList.some(x=>x.id===remote.id)};
    db.close();
    return {local:localResult,concurrentRemove:concurrencyResult};
};
