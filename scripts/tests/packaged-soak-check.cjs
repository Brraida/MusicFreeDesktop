/* Packaged main/preload/renderer, isolated data, real silent audio and native window cycles. */
const { app, BrowserWindow, powerSaveBlocker } = require("electron");
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const crypto = require("node:crypto"), http = require("node:http"), { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "../.."), packageRoot = path.resolve(process.argv[2]);
const minutes = Number(process.argv[3] || 120), quick = process.argv.includes("--quick");
assert(Number.isFinite(minutes) && minutes > 0);
const output = path.join(root, "out/.packaged-soak-" + Date.now()); fs.mkdirSync(output, { recursive: true });
app.setName("MusicFree");
for (const key of ["userData", "appData", "downloads", "temp", "logs"]) {
    const directory = path.join(output, key); fs.mkdirSync(directory); app.setPath(key, directory);
}
Object.defineProperty(app, "isPackaged", { value: true });
Object.defineProperty(process, "resourcesPath", { value: path.join(packageRoot, "resources") });
app.getAppPath = () => path.join(packageRoot, "resources/app");
app.getVersion = () => JSON.parse(fs.readFileSync(path.join(app.getAppPath(), "package.json"), "utf8")).version;
assert(!fs.existsSync(path.resolve(app.getPath("exe"), "../portable")), "Test host must not redirect into a portable user profile");
app.setAsDefaultProtocolClient = () => false;
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
fs.writeFileSync(path.join(app.getPath("userData"), "config.json"), JSON.stringify({ "$schema-version": 1,
    "normal.checkUpdate": false, "normal.taskbarThumb": "artwork", "normal.language": "zh-CN", "normal.closeBehavior": "exit_app", "plugin.autoUpdatePlugin": false,
    "download.path": app.getPath("downloads"), "private.mainWindowSize": { width: 1200, height: 860 } }));
function wave(seconds) {
    const data = Buffer.alloc(44 + 32000 * seconds);
    data.write("RIFF"); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
    data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
    data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
    data.write("data", 36); data.writeUInt32LE(data.length - 44, 40); return data;
}
const music = path.join(output, "active.wav"); fs.writeFileSync(music, wave(45));
const cover = pathToFileURL(path.join(root, "scripts/tests/fixtures/cover.svg")).href;
const songs = ["A", "B"].map(id => ({ id: "soak-" + id, platform: "本地", title: "Soak " + id,
    url: music, duration: 45, artwork: cover, rawLrc: "[00:00]当前句\n[00:15]下一句\n[00:30]末句" }));
const sample = wave(2), records = [];
for (let i = 0; i < 20; i++) {
    const file = path.join(app.getPath("downloads"), i + ".wav"); fs.writeFileSync(file, sample);
    const stat = fs.statSync(file);
    records.push({ id: "download-" + i, platform: "本地", title: "Download " + i, duration: 2, "$$ref": 2,
        $: { downloadData: { path: file, quality: "standard", fingerprint: { size: stat.size, mtimeMs: stat.mtimeMs,
            sha256: crypto.createHash("sha256").update(sample).digest("hex"), device: String(stat.dev) } } } });
}
const fixturePlatform = "Soak loopback";
const traffic = { streamRequests: 0, downloadRequests: 0, completedDownloads: 0, activeDownloads: 0, peakDownloads: 0 };
let server, downloadFixtures, scanFolder;
const sockets = new Set();
async function setupLoopback() {
    const audio = wave(45);
    server = http.createServer((request, response) => {
        const downloading = request.url.startsWith("/download-");
        const body = downloading ? sample : audio;
        response.setHeader("Content-Type", "audio/wav");
        response.setHeader("Access-Control-Allow-Origin", "*");
        response.setHeader("Accept-Ranges", "bytes");
        response.setHeader("Cache-Control", "no-store");
        const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
        const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
        if (start > end) {
            response.writeHead(416); response.end(); return;
        }
        if (range) {
            response.statusCode = 206; response.setHeader("Content-Range", `bytes ${start}-${end}/${body.length}`);
        }
        response.setHeader("Content-Length", end - start + 1);
        if (request.method === "HEAD") {
            response.end(); return;
        }
        if (!downloading) {
            ++traffic.streamRequests; response.end(body.subarray(start, end + 1)); return;
        }
        ++traffic.downloadRequests; ++traffic.activeDownloads;
        traffic.peakDownloads = Math.max(traffic.peakDownloads, traffic.activeDownloads);
        let cursor = start;
        const timer = setInterval(() => {
            const next = Math.min(cursor + 8192, end + 1); response.write(body.subarray(cursor, next)); cursor = next;
            if (cursor > end) {
                clearInterval(timer); ++traffic.completedDownloads; response.end();
            }
        }, quick ? 50 : 250);
        response.once("close", () => {
            clearInterval(timer); --traffic.activeDownloads;
        });
    });
    server.on("connection", socket => {
        sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    songs[1] = { ...songs[1], platform: fixturePlatform, url: base + "/stream.wav" };
    downloadFixtures = Array.from({ length: quick ? 4 : 12 }, (_, index) => ({ id: "transfer-" + index,
        platform: fixturePlatform, title: "Soak download " + index, artist: "Fixture", url: base + "/download-" + index + ".wav", duration: 2, $$ref: 1 }));
    const plugins = path.join(app.getPath("userData"), "musicfree-plugins"); fs.mkdirSync(plugins);
    fs.writeFileSync(path.join(plugins, "loopback.js"), `module.exports={platform:${JSON.stringify(fixturePlatform)},version:"1.0.0",author:"test",getMediaSource:async item=>({url:item.url}),getLyric:async item=>({rawLrc:item.rawLrc})};`);
}
async function savedTransfers() {
    return evaluate(main, `(async () => {
        const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('musicSheetDB');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
        const rows=await new Promise((resolve,reject)=>{const r=db.transaction('musicStore','readonly').objectStore('musicStore').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});db.close();
        return rows.filter(item=>item.platform===${JSON.stringify(fixturePlatform)} && item.id.startsWith('transfer-'));
    })()`);
}
let main, mini, desktop;
let windowCyclesCompleted = 0, trackSwitchesCompleted = 0, fileChangesCompleted = 0, steadyStarted, blocker;
const failures = [], crashes = [], trace = [];
app.on("render-process-gone", (_event, contents, details) => {
    if (details.reason !== "clean-exit") crashes.push({ url: contents.getURL(), ...details });
});
app.on("browser-window-created", (_event, win) => {
    win.webContents.setBackgroundThrottling(false);
    win.webContents.on("preload-error", (_event, _file, error) => failures.push(error.message));
    win.webContents.on("did-finish-load", () => {
        const url = win.webContents.getURL();
        if (url.includes("main_window")) main = win;
        if (url.includes("minimode_window")) mini = win;
        if (url.includes("lrc_window")) desktop = win;
    });
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) && new URL(details.url).hostname !== "127.0.0.1" }));
});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = (win, code) => win.webContents.executeJavaScript(code);
async function until(check, name) {
    const end = Date.now() + 20000;
    while (!await check()) {
        assert(Date.now() < end, "Timed out: " + name); await wait(25);
    }
}
const deadline = setTimeout(() => finish(new Error("Soak deadline exceeded")), (minutes + 15) * 60000);
function finish(error) {
    clearTimeout(deadline);
    for (const socket of sockets) socket.destroy();
    server?.close();
    if (blocker !== undefined) powerSaveBlocker.stop(blocker);
    const report = { passed: !error, packageRoot, recordedAt: new Date().toISOString(), electron: process.versions.electron,
        minutesRequested: minutes, quick, windowCyclesCompleted, trackSwitchesCompleted, fileChangesCompleted,
        steadyElapsedMs: steadyStarted ? Date.now() - steadyStarted : 0, traffic, backgroundScanFiles: quick ? 20 : 1000, trace, failures, crashes, error: error?.stack,
        method: "Matching installed Electron hosts unmodified shipped bundles; isolated DB/config/files, muted local and loopback HTTP decoded WAV through a real fixture plugin; UI-triggered concurrent downloads and real metadata scanning; hidden native windows with renderer background throttling disabled. Resource samples are Electron app metrics plus Windows handle counts for those same PIDs, excluding the standalone forwarding service and sampling shell; no physical-device or online-plugin coverage." };
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(report, null, 2));
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    console.log("RESULT_FILE", path.join(output, "result.json")); if (error) console.error(error);
    app.exit(error ? 1 : 0);
}
async function portCount() {
    return main.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: "window.__extPorts?.size" }]);
}
async function extensions(enabled) {
    await evaluate(main, `window['@shared/utils'].appWindow.setMinimodeWindow(${enabled});window['@shared/utils'].appWindow.setLyricWindow(${enabled})`);
    await until(() => enabled ? mini && !mini.isDestroyed() && desktop && !desktop.isDestroyed() : BrowserWindow.getAllWindows().length === 1, "extension lifecycle");
    if (enabled) {
        await until(() => evaluate(mini, "!!document.querySelector('.album-container')"), "mini rendered");
        await until(() => evaluate(desktop, "!!document.querySelector('.lyric-current-row')"), "lyrics rendered");
        mini.hide(); desktop.hide();
    }
    await until(async () => await portCount() === (enabled ? 2 : 0), "MessagePort disposal");
}
async function state() {
    return evaluate(mini, "window['@shared/message-bus/extension'].getAppState()");
}
async function resourceRecord() {
    return evaluate(main, `(async () => {
        const db = await new Promise((resolve,reject) => {const r=indexedDB.open('musicSheetDB');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
        const item = await new Promise((resolve,reject) => {const r=db.transaction('musicStore','readonly').objectStore('musicStore').get(['本地','download-0']);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
        db.close(); return item;
    })()`);
}
async function snapshot(phase, elapsedMs) {
    await until(async () => (await state()).playerState === 1, "steady decoded playback");
    const value = await state();
    const metrics = app.getAppMetrics().map(item => ({ pid: item.pid, type: item.type, memory: item.memory, cpu: item.cpu }));
    const identifiers = metrics.map(item => item.pid);
    assert(identifiers.every(id => Number.isInteger(id) && id > 0));
    const handles = process.platform === "win32" ? JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "@(Get-Process -Id " + identifiers.join(",") + " | Select-Object Id,Handles) | ConvertTo-Json -Compress"], { encoding: "utf8", timeout: 10000 }).replace(/^\uFEFF/, "")) : undefined;
    const row = { phase, elapsedMs, state: value, download: await resourceRecord(), windows: BrowserWindow.getAllWindows().length, ports: await portCount(), metrics, handles };
    trace.push(row); fs.writeFileSync(path.join(output, "trace.json"), JSON.stringify(trace, null, 2));
    assert.equal(row.windows, 3); assert.equal(row.ports, 2); assert.equal(value.playerState, 1);
    assert(songs.some(song => song.id === value.musicItem?.id)); assert.equal(failures.length, 0); assert.equal(crashes.length, 0);
    return value;
}
(async () => {
    await setupLoopback();
    require(path.join(packageRoot, "resources/app/.webpack/main/index.js"));
    await until(() => main && evaluate(main, "!!document.querySelector('.music-info-outer-container') && !document.querySelector('.initialization-status')"), "main initialized");
    blocker = powerSaveBlocker.start("prevent-app-suspension");
    await evaluate(main, `(async () => {
        const open = name => new Promise((resolve,reject) => {const r=indexedDB.open(name);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
        const db = await open('musicSheetDB');
        await new Promise((resolve,reject) => {const tx=db.transaction(['sheets','musicStore'],'readwrite');
            for(const item of ${JSON.stringify([...records, ...songs.map(song => ({ ...song, $$ref: 1 })), ...downloadFixtures])})tx.objectStore('musicStore').put(item);
            tx.objectStore('sheets').put({id:'favorite',title:'Soak',platform:'本地',$$sortIndex:-1,musicList:${JSON.stringify(records.map(({ id, platform }) => ({ id, platform })))}});
            tx.objectStore('sheets').put({id:'soak-playlist',title:'Active audio',platform:'本地',$$sortIndex:0,musicList:${JSON.stringify(songs.map(({ id,platform })=>({ id,platform })))}});
            tx.objectStore('sheets').put({id:'soak-transfers',title:'Concurrent transfers',platform:'本地',$$sortIndex:1,musicList:${JSON.stringify(downloadFixtures.map(({ id,platform })=>({ id,platform })))}});
            tx.oncomplete=resolve;tx.onabort=tx.onerror=()=>reject(tx.error)});db.close();
        const prefs=await open('userPerferenceDB');
        await new Promise((resolve,reject)=>{const tx=prefs.transaction('perference','readwrite');tx.objectStore('perference').put({key:'localWatchDirChecked',value:[${JSON.stringify(app.getPath("downloads"))}]});tx.oncomplete=resolve;tx.onabort=tx.onerror=()=>reject(tx.error)});prefs.close();
        localStorage.setItem('volume','0');localStorage.removeItem('currentMusic');
    })()`);
    const reload = new Promise(resolve => main.webContents.once("did-finish-load", resolve)); main.webContents.reload(); await reload;
    await until(() => evaluate(main, "!!document.querySelector('.music-info-outer-container') && !document.querySelector('.initialization-status')"), "reload initialized");
    await evaluate(main, "window['@shared/message-bus/main'].sendCommand('Navigate','/main/musicsheet/'+encodeURIComponent('本地')+'/soak-playlist')");
    await until(() => evaluate(main, "document.querySelectorAll('.music-list-container tbody tr').length===2"), "active playlist");
    await evaluate(main, "document.querySelector('.music-list-container tbody tr').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))");
    await evaluate(main, "window['@shared/message-bus/main'].sendCommand('SetRepeatMode','queue-repeat')");
    const cycles = quick ? 3 : 100, switches = quick ? 4 : 1000;
    for (let i = 0; i < cycles; i++) {
        await extensions(true); await extensions(false);
        ++windowCyclesCompleted;
        if (i % 10 === 9) console.log("WINDOW_CYCLES", i + 1);
    }
    await extensions(true);
    await until(async () => (await state()).playerState === 1, "decoded playback");
    for (let i = 0; i < switches; i++) {
        const before = await state();
        await evaluate(main, "window['@shared/message-bus/main'].sendCommand('SkipToNext')");
        await until(async () => {
            const value=await state();return value.musicItem?.id !== before.musicItem?.id && value.playerState===1;
        }, "real track switch");
        ++trackSwitchesCompleted;
        if (i % 100 === 99) console.log("TRACK_SWITCHES", i + 1);
    }
    await evaluate(main, "window['@shared/message-bus/main'].sendCommand('Navigate','/main/musicsheet/'+encodeURIComponent('本地')+'/soak-transfers')");
    await until(() => evaluate(main, `document.querySelectorAll('.music-list-container tbody tr').length===${downloadFixtures.length}`), "download fixture rows");
    await evaluate(main, "document.querySelector('.music-list-batch-toolbar button').click()");
    await until(() => evaluate(main, "document.querySelectorAll('.music-list-batch-toolbar button').length===5"), "batch controls");
    await evaluate(main, "document.querySelectorAll('.music-list-batch-toolbar button')[1].click()");
    await until(() => evaluate(main, "!document.querySelectorAll('.music-list-batch-toolbar button')[3].disabled"), "batch selection");
    await evaluate(main, "document.querySelectorAll('.music-list-batch-toolbar button')[3].click()");
    scanFolder = path.join(app.getPath("downloads"), "background-scan"); fs.mkdirSync(scanFolder);
    for (let index = 0; index < (quick ? 20 : 1000); index++) fs.writeFileSync(path.join(scanFolder, index + ".wav"), sample);
    main.hide();
    const started = Date.now(); steadyStarted = started; let last;
    for (let index = 0; Date.now() - started < minutes * 60000; index++) {
        const value = await snapshot("steady", Date.now() - started);
        if (trace.length > 1) assert(trace.at(-1).elapsedMs - trace.at(-2).elapsedMs < 90000, "Sampling gap prevents continuous-playback validation");
        if (last && value.musicItem.id === last.musicItem.id) assert.notEqual(value.progress, last.progress, "Audio progress stalled");
        last = value;
        // Exercise both download-resource and local-library directory watchers.
        const watched = records[0].$.downloadData.path;
        if (index % 2 === 0) fs.unlinkSync(watched); else fs.writeFileSync(watched, sample);
        await until(async () => (await resourceRecord())?.$?.downloadData?.verified?.state === (index % 2 === 0 ? "MISSING" : "AVAILABLE"), "external deletion/restoration committed status");
        const association = await resourceRecord();
        assert.equal(association.$$ref, 2); assert.equal(association.$.downloadData.path, watched);
        ++fileChangesCompleted;
        console.log("SOAK_MINUTES", ((Date.now() - started) / 60000).toFixed(1), "WINDOWS", BrowserWindow.getAllWindows().length);
        await wait(Math.min(60000, Math.max(1, minutes * 60000 - (Date.now() - started))));
    }
    if (!fs.existsSync(records[0].$.downloadData.path)) fs.writeFileSync(records[0].$.downloadData.path, sample);
    await until(async () => (await resourceRecord())?.$?.downloadData?.verified?.state === "AVAILABLE", "final file restoration");
    await until(async () => (await state()).playerState === 1, "final playing state");
    await until(async () => (await savedTransfers()).every(item => item.$?.downloadData?.verified?.state === "AVAILABLE"), "download commit and availability");
    const transfers = await savedTransfers(); assert.equal(transfers.length, downloadFixtures.length);
    for (const item of transfers) {
        assert.equal(item.$$ref, 2);
        assert.equal(crypto.createHash("sha256").update(fs.readFileSync(item.$.downloadData.path)).digest("hex"), records[0].$.downloadData.fingerprint.sha256);
    }
    assert(traffic.peakDownloads >= 2, "Downloads must actually overlap");
    assert(traffic.streamRequests > 0, "HTTP song must be fetched and decoded");
    assert.equal(traffic.completedDownloads, downloadFixtures.length);
    const scanned = await evaluate(main, `(async () => {
        const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('musicSheetDB');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
        const rows=await new Promise((resolve,reject)=>{const r=db.transaction('localMusicStore','readonly').objectStore('localMusicStore').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});db.close();
        return rows.filter(item=>item.$$localPath && window.path.resolve(item.$$localPath).toLowerCase().startsWith(${JSON.stringify(scanFolder.toLowerCase() + path.sep)})).length;
    })()`);
    assert.equal(scanned, quick ? 20 : 1000, "Real metadata batches must commit while playing");
    await snapshot("complete", Date.now() - started);
    console.log("PASS: native window/port cycles, decoded track switches, sustained playback and external file changes"); finish();
})().catch(finish);
