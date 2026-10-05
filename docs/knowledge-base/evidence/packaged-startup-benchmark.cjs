const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../../..");
const label = process.argv[2];
const packageRoot = path.join(root, "out", label, "MusicFree-win32-x64");
const testRoot = path.join(root, "out/.startup-benchmark-" + label + "-" + Date.now());
fs.mkdirSync(testRoot, { recursive: true });
for (const name of ["userData", "appData", "downloads", "temp", "logs"]) {
    const isolated = path.join(testRoot, name); fs.mkdirSync(isolated); app.setPath(name, isolated);
}
app.setName("MusicFree-startup-benchmark");
Object.defineProperty(app, "isPackaged", { value: true });
Object.defineProperty(process, "resourcesPath", { value: path.join(packageRoot, "resources") });
app.getAppPath = () => path.join(packageRoot, "resources/app");
app.getVersion = () => "0.0.80";
app.setAsDefaultProtocolClient = () => true;
fs.writeFileSync(path.join(app.getPath("userData"), "config.json"), JSON.stringify({
    "$schema-version": 1, "normal.checkUpdate": false, "normal.language": "zh-CN",
    "normal.closeBehavior": "exit_app", "download.path": app.getPath("downloads"), "plugin.autoUpdatePlugin": false,
}));
const source = path.join(testRoot, "fixture.bin");
fs.writeFileSync(source, Buffer.alloc(1024 * 1024, 37));
const records = Array.from({ length: 1000 }, (_, index) => {
    const file = path.join(app.getPath("downloads"), "song-" + index + ".mp3");
    fs.linkSync(source, file);
    return { platform: "startup-fixture", id: String(index), title: "fixture " + index, artist: "fixture", "$$ref": 1,
        "$": { downloadData: { path: file, quality: "standard" } } };
});
let main;
const failures = [];
app.on("browser-window-created", (_event, window) => {
    window.hide(); window.show = () => {};
    window.webContents.on("preload-error", (_evt, _file, error) => failures.push(error.message));
    window.webContents.on("did-finish-load", () => {
        if (window.webContents.getURL().includes("main_window")) main = window;
    });
});
const timeout = setTimeout(() => finish(1, new Error("Startup benchmark timed out")), 90000);
function finish(code, error) {
    clearTimeout(timeout); if (error) console.error(error);
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    app.exit(code);
}
const evaluate = code => main.webContents.executeJavaScript(code);
async function until(check) {
    const end = Date.now() + 60000;
    while (!await check()) {
        assert(Date.now() < end, "Benchmark condition timed out");
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}
const logPath = path.join(app.getPath("userData"), "logs/main.log");
function perfSince(offset) {
    const text = fs.readFileSync(logPath, "utf8").slice(offset);
    return { text, bootstrapMs: Number(text.match(/Bundle Bootstrap Ready \[Offset\]: (\d+)ms/)?.[1]),
        firstScreenMs: Number(text.match(/Bundle First Screen \[Offset\]: (\d+)ms/)?.[1]) };
}
async function fingerprintCount() {
    return evaluate(`new Promise((resolve,reject)=> { const r=indexedDB.open('musicSheetDB'); r.onerror=()=>reject(r.error); r.onsuccess=()=> { const db=r.result; const tx=db.transaction('musicStore','readonly'); const q=tx.objectStore('musicStore').getAll(); q.onsuccess=()=>{resolve(q.result.filter(x=>x.$?.downloadData?.fingerprint).length);db.close()};q.onerror=()=>reject(q.error) }; })`);
}
(async () => {
    require(path.join(packageRoot, "resources/app/.webpack/main/index.js"));
    await until(() => main && evaluate("!!document.querySelector('.music-info-outer-container')"));
    await until(() => fs.existsSync(logPath) && /Bundle First Screen/.test(fs.readFileSync(logPath, "utf8")));
    const empty = perfSince(0);
    await evaluate(`new Promise((resolve,reject)=>{const r=indexedDB.open('musicSheetDB');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;const tx=db.transaction('musicStore','readwrite');for(const item of ${JSON.stringify(records)})tx.objectStore('musicStore').put(item);tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error)}})`);
    const legacyOffset = fs.readFileSync(logPath, "utf8").length;
    const beforeReload = Date.now();
    main.webContents.reload();
    await new Promise(resolve => main.webContents.once("did-finish-load", resolve));
    await until(() => evaluate("!!document.querySelector('.music-info-outer-container')"));
    const reloadToUiMs = Date.now() - beforeReload;
    const fingerprintsAtUi = await fingerprintCount();
    await until(() => /Bundle First Screen/.test(fs.readFileSync(logPath, "utf8").slice(legacyOffset)));
    const legacy = perfSince(legacyOffset);
    await until(async () => await fingerprintCount() === 1000);
    const migrationCompleteMs = Date.now() - beforeReload;
    await new Promise(resolve => setTimeout(resolve, 500));
    const warmOffset = fs.readFileSync(logPath, "utf8").length;
    main.webContents.reload();
    await new Promise(resolve => main.webContents.once("did-finish-load", resolve));
    await until(() => evaluate("!!document.querySelector('.music-info-outer-container')"));
    await until(() => /Bundle First Screen/.test(fs.readFileSync(logPath, "utf8").slice(warmOffset)));
    const warm = perfSince(warmOffset);
    assert.deepEqual(failures, []);
    const report = { passed: true, package: label, platform: process.platform, electron: process.versions.electron,
        isolatedProfile: true, fixture: { records: 1000, logicalBytesPerFile: 1024 * 1024, hardLinks: true, legacyWithoutFingerprints: true },
        empty, legacy: { ...legacy, reloadToUiMs, fingerprintsAtUi, migrationCompleteMs }, warm,
        limitations: "One sample per workload; cached filesystem, same process reload; not physical cold launch P95; fixture is binary, not audio decoding" };
    fs.writeFileSync(path.join(testRoot, "result.json"), JSON.stringify(report, null, 2) + "\n");
    console.log("STARTUP_RESULT", JSON.stringify(report)); console.log("RESULT_FILE", path.join(testRoot, "result.json"));
    finish(0);
})().catch(error => finish(1, error));
