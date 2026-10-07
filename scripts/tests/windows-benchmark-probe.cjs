/* Instrumentation copied into an isolated package by windows-benchmark.cjs. */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const settings = JSON.parse(fs.readFileSync(process.env.MUSICFREE_BENCH_SPEC, "utf8"));
assert.equal(process.platform, "win32");
assert(settings.profile.includes("windows-validation"));
for (const key of ["userData", "appData", "downloads", "temp", "logs"]) {
    const directory = key === "downloads" ? settings.downloads : path.join(settings.profile, key);
    fs.mkdirSync(directory, { recursive: true });
    app.setPath(key, directory);
}
// Exercise shipped code without registering the copied EXE as a protocol handler.
app.setAsDefaultProtocolClient = () => false;
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
let main;
const failures = [];
app.on("browser-window-created", (_event, window) => {
    window.webContents.on("preload-error", (_evt, _file, error) => failures.push(error.message));
    window.webContents.on("did-finish-load", () => {
        if (window.webContents.getURL().includes("main_window")) main = window;
    });
    window.webContents.session.webRequest.onBeforeRequest((request, callback) => {
        callback({ cancel: /^https?:/.test(request.url) && !/^https?:\/\/127\.0\.0\.1[:/]/.test(request.url) });
    });
});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
    const end = Date.now() + 45000;
    while (!await check()) {
        assert(Date.now() < end, "Timed out: " + label);
        await wait(10);
    }
}
const evaluate = source => main.webContents.executeJavaScript(source);
const deadline = setTimeout(() => finish(new Error("Windows benchmark probe timed out")), 90000);
function finish(error) {
    clearTimeout(deadline);
    if (error) fs.writeFileSync(settings.result, JSON.stringify({ passed: false, error: error.stack }));
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    app.exit(error ? 1 : 0);
}
(async () => {
    require(path.join(process.resourcesPath, "app/.webpack/main/index.js"));
    await until(() => main && evaluate("!!document.querySelector('.music-info-outer-container') && !document.querySelector('.initialization-status')"), "interactive UI");
    fs.writeFileSync(settings.ready, JSON.stringify({ interactiveAt: Date.now() }));
    if (settings.seed) {
        const songs = JSON.parse(fs.readFileSync(settings.seed, "utf8"));
        await evaluate(`(async () => {
            const db = await new Promise((resolve, reject) => {
                const request = indexedDB.open('musicSheetDB');
                request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
            });
            const songs = ${JSON.stringify(songs)};
            await new Promise((resolve, reject) => {
                const tx = db.transaction(['sheets', 'musicStore', 'localMusicStore'], 'readwrite');
                for (const song of songs) {
                    tx.objectStore('localMusicStore').put({...song, $$localPath: song.localPath});
                    if (song.$) tx.objectStore('musicStore').put(song);
                }
                tx.objectStore('sheets').put({id:'favorite',title:'我喜欢',platform:'本地',musicList:songs.filter(x=>x.$).map(({platform,id})=>({platform,id})), $$sortIndex:-1});
            tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error);
            }); db.close(); localStorage.setItem('volume', '0');
        })()`);
        fs.writeFileSync(settings.result, JSON.stringify({ passed: true, seeded: songs.length }));
        finish(); return;
    }
    if (settings.verificationOnly) {
        await until(() => fs.existsSync(settings.verificationDone), "complete 1000-file verification");
        const verification = JSON.parse(fs.readFileSync(settings.verificationDone, "utf8"));
        assert.equal(verification.records, 1000);
        if (settings.legacy) {
            // Restore the same legacy input for the next fresh process, outside timing.
            await evaluate(`(async () => {
                const db = await new Promise((resolve,reject) => {const r=indexedDB.open('musicSheetDB');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
                await new Promise((resolve,reject) => {const tx=db.transaction('musicStore','readwrite');const store=tx.objectStore('musicStore');const r=store.getAll();
                    r.onsuccess=()=>{for(const item of r.result){const data=item.$?.downloadData;if(data?.path){delete data.fingerprint;delete data.verified;store.put(item)}}};
                    tx.oncomplete=resolve;tx.onabort=tx.onerror=()=>reject(tx.error)});db.close();
            })()`);
        }
        assert.deepEqual(failures, []);
        fs.writeFileSync(settings.result, JSON.stringify({ passed: true, verificationMs: verification.durationMs, records: verification.records, electron: process.versions.electron }));
        finish(); return;
    }
    await wait(1500);
    const electronMetrics = app.getAppMetrics().map(metric => ({
        pid: metric.pid, type: metric.type, memory: metric.memory, cpu: metric.cpu,
    }));
    fs.writeFileSync(settings.metricsReady, "ready");
    await until(() => fs.existsSync(settings.metricsDone), "process tree metrics");
    let operations = null;
    if (settings.library) {
        await evaluate("window['@shared/message-bus/main'].sendCommand('Navigate','/main/local-music')");
        await until(() => evaluate("!!document.querySelector('.search-local-music') && document.querySelectorAll('.music-list-container tbody tr').length>0"), "library rows");
        operations = await evaluate(`(async () => {
            const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const until = async check => {
                const end = performance.now()+10000;
                while (!check()) { if(performance.now()>end) throw Error('UI operation timed out'); await frame(); }
                await frame();
            };
            const samples = {searchMs:[], clearSearchMs:[], selectAllMs:[], clearSelectionMs:[]};
            const input = document.querySelector('.search-local-music');
            const inputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
            const set = value => {inputValue.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));};
            const buttons = () => [...document.querySelectorAll('.music-list-batch-toolbar button')];
            for(let iteration=0;iteration<5;iteration++) {
                let start=performance.now(); set('benchmark song 9999');
                await until(()=>document.querySelectorAll('.music-list-container tbody tr').length===1);
                samples.searchMs.push(performance.now()-start);
                start=performance.now(); set('');
                await until(()=>document.querySelectorAll('.music-list-container tbody tr').length>1);
                samples.clearSearchMs.push(performance.now()-start);
                buttons()[0].click(); await frame();
                start=performance.now(); buttons()[1].click();
                await until(()=>document.querySelector('.music-list-batch-toolbar [aria-live]')?.textContent.includes('10000'));
                samples.selectAllMs.push(performance.now()-start);
                start=performance.now(); buttons()[2].click();
                await until(()=>buttons()[2].disabled);
                samples.clearSelectionMs.push(performance.now()-start);
                buttons()[0].click(); await frame();
            }
            return {...samples, visibleRows:document.querySelectorAll('.music-list-container tbody tr').length};
        })()`);
    }
    assert.deepEqual(failures, []);
    fs.writeFileSync(settings.result, JSON.stringify({ passed: true, electron: process.versions.electron,
        chromium: process.versions.chrome, electronMetrics,
        processMetrics: JSON.parse(fs.readFileSync(settings.metricsDone, "utf8")), operations, isolatedProfile: settings.profile }));
    finish();
})().catch(finish);
