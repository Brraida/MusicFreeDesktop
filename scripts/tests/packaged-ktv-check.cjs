/* Run shipped main/preload/renderer bundles with isolated data and silent local WAV. */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs"), path = require("node:path");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const root = path.resolve(__dirname, "../..");
const packageRoot = path.resolve(process.argv[2] || path.join(root, "out/MusicFree-win32-x64"));
const output = path.join(root, "out/.packaged-ktv-" + Date.now());
fs.mkdirSync(output, { recursive: true });
app.setName("MusicFree");
for (const key of ["userData", "appData", "downloads"]) {
    const dir = path.join(output, key); fs.mkdirSync(dir); app.setPath(key, dir);
}
app.setPath("temp", output);
Object.defineProperty(app, "isPackaged", { value: true });
Object.defineProperty(process, "resourcesPath", { value: path.join(packageRoot, "resources") });
app.getAppPath = () => path.join(packageRoot, "resources/app");
app.getVersion = () => "0.0.80";
let protocolCalls = 0;
app.setAsDefaultProtocolClient = () => {
    ++protocolCalls; return false;
};
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
fs.writeFileSync(path.join(app.getPath("userData"), "config.json"), JSON.stringify({
    "$schema-version": 1, "normal.checkUpdate": false, "normal.language": "zh-CN",
    "normal.closeBehavior": "exit_app", "playMusic.clickMusicList": "replace", "plugin.autoUpdatePlugin": false, "normal.builtinTheme": "jiangnan",
    "download.path": app.getPath("downloads"), "private.mainWindowSize": { width: 1200, height: 860 },
}));
const rate = 16000, duration = 45;
const wave = Buffer.alloc(44 + rate * 2 * duration);
wave.write("RIFF"); wave.writeUInt32LE(wave.length - 8, 4); wave.write("WAVEfmt ", 8);
wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(rate, 24); wave.writeUInt32LE(rate * 2, 28); wave.writeUInt16LE(2, 32);
wave.writeUInt16LE(16, 34); wave.write("data", 36); wave.writeUInt32LE(wave.length - 44, 40);
const wav = path.join(output, "silent-demo.wav"); fs.writeFileSync(wav, wave);
const cover = pathToFileURL(path.join(root, "scripts/tests/fixtures/cover.svg")).href;
const raw = "[00:03]把这一刻唱给你听\n[00:08]把这一刻唱给你听\n[00:13]让晚风接住我们的声音\n[00:20]\n[00:24]直到星光落在心里";
const songs = [
    { platform: "本地", id: "ktv-A", title: "微光", artist: "示例歌手", url: wav, duration, artwork: cover, rawLrc: raw, "$$ref": 1 },
    { platform: "本地", id: "ktv-B", title: "下一首示例", artist: "示例歌手", url: wav, duration, artwork: cover,
        rawLrc: "[00:00]换一首新的歌\n[00:05]继续下一段旋律\n[00:30]愿你快乐", "$$ref": 1 },
];
let main, desktop, mini;
const failures = [], requests = [];
const outputs = [];
app.on("browser-window-created", (_event, win) => {
    win.webContents.on("preload-error", (_evt, _file, err) => failures.push(err.message));
    win.webContents.on("did-finish-load", () => {
        const url = win.webContents.getURL();
        if (url.includes("main_window")) main = win;
        if (url.includes("lrc_window")) desktop = win;
        if (url.includes("minimode_window")) mini = win;
    });
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
        const remote = /^https?:/.test(details.url); if (remote) requests.push(details.url);
        callback({ cancel: remote });
    });
});
const timeout = setTimeout(() => finish(1, new Error("Packaged KTV check timed out")), 90000);
function finish(code, error) {
    if (error) console.error(error.stack || error);
    clearTimeout(timeout);
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    app.exit(code);
}
const evaluate = (win, code) => win.webContents.executeJavaScript(code);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
    const deadline = Date.now() + 15000;
    while (!await check()) {
        assert(Date.now() < deadline, "Timed out: " + label); await wait(80);
    }
}
async function texts(win, isMini = false) {
    return evaluate(win, `({current:document.querySelector(${JSON.stringify(isMini ? ".mini-current-lyric" : ".lyric-current-row")})?.textContent.trim(),
        next:document.querySelector(${JSON.stringify(isMini ? ".mini-next-lyric" : ".lyric-next-row")})?.textContent.trim()})`);
}
async function pair(current, next) {
    await until(async () => {
        if (!mini || !desktop) return false;
        const a = await texts(desktop), b = await texts(mini, true);
        return (!current || (a.current === current && b.current === current)) && a.next === next && b.next === next;
    }, "paired " + current + " / " + next);
}
async function capture(win, name) {
    win.show(); win.focus(); win.moveTop();
    await evaluate(win, "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    await wait(350);
    const image = await win.webContents.capturePage();
    assert(!image.isEmpty(), "Native screenshot must contain pixels: " + name);
    assert(image.getBitmap().some((value,index)=>index % 4 === 3 && value > 0), "Native screenshot must have visible pixels: " + name);
    const file = path.join(output, name + ".png"); fs.writeFileSync(file, image.toPNG()); outputs.push(file);
}
async function seek(seconds) {
    await evaluate(main, `document.querySelector('.music-bar--slider-container').dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:innerWidth*${seconds}/${duration}}))`);
}
(async () => {
    require(path.join(packageRoot, "resources/app/.webpack/main/index.js"));
    await until(() => main && evaluate(main, "!!document.querySelector('.music-info-outer-container')"), "main ready");
    await evaluate(main, `(async()=>{
        const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('musicSheetDB');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});
        await new Promise((resolve,reject)=>{const tx=db.transaction(['sheets','musicStore','localMusicStore'],'readwrite');
            tx.objectStore('sheets').put({id:'favorite',title:'我喜欢',platform:'本地',musicList:${JSON.stringify(songs.map(({ id, platform }) => ({ id, platform })))},$$sortIndex:-1});
            for(const song of ${JSON.stringify(songs)}){tx.objectStore('musicStore').put(song);tx.objectStore('localMusicStore').put({...song,$$localPath:song.url});}
            tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)});db.close();
        localStorage.setItem('currentMusic',${JSON.stringify(JSON.stringify(songs[0]))});localStorage.setItem('volume','0');
    })()`);
    const loaded = new Promise(resolve => main.webContents.once("did-finish-load", resolve));
    main.webContents.reload(); await loaded;
    await until(() => evaluate(main, "!!document.querySelector('.music-info-outer-container')"), "reload ready");
    await evaluate(main, "window['@shared/message-bus/main'].sendCommand('Navigate','/main/musicsheet/'+encodeURIComponent('本地')+'/favorite')");
    await until(() => evaluate(main, "document.querySelectorAll('.music-list-container tbody tr').length===2"), "seeded rows");
    await evaluate(main, "document.querySelector('.music-list-container tbody tr').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))");
    await until(() => evaluate(main, "document.querySelector('.music-cover.vinyl-cover')?.dataset.playing==='true'"), "local WAV playback");
    await evaluate(main, "window['@shared/utils'].appWindow.setMinimodeWindow(true);window['@shared/utils'].appWindow.setLyricWindow(true)");
    await pair(null, "把这一刻唱给你听");
    assert.equal(desktop.getSize()[1], 179); assert.deepEqual(mini.getSize(), [340,72]);
    desktop.webContents.setBackgroundThrottling(false); mini.webContents.setBackgroundThrottling(false);
    mini.setPosition(100,100);
    await capture(desktop, "desktop-intro");
    await seek(4); await pair("把这一刻唱给你听", "把这一刻唱给你听");
    await seek(9); await pair("把这一刻唱给你听", "让晚风接住我们的声音");
    await capture(desktop, "desktop-playing"); await capture(mini, "mini-playing");
    const bus = await evaluate(mini, "window['@shared/message-bus/extension'].getAppState()");
    assert.equal(bus.parsedLrc.index, 1); assert.equal(bus.fullLyric.length, 5); assert.equal(bus.lyricHasTimeline, true);
    await evaluate(mini, "document.querySelector('.album-container').focus();document.querySelector('.options-container button[aria-label=\"播放/暂停\"]').click()");
    await until(() => evaluate(mini, "document.querySelector('.album-container').dataset.playing==='false'"), "pause from mini");
    const paused = await texts(desktop); await wait(300); assert.deepEqual(await texts(desktop), paused);
    await capture(mini, "mini-hover");
    await capture(desktop, "desktop-paused");
    await evaluate(mini, "document.activeElement?.blur();document.querySelector('.options-container button[aria-label=\"播放/暂停\"]').click()");
    await until(() => evaluate(mini, "document.querySelector('.album-container').dataset.playing==='true'"), "resume from mini");
    await seek(0); await pair(null, "把这一刻唱给你听");
    assert((await texts(desktop)).current.includes("微光"));
    await seek(21); await pair("间奏", "直到星光落在心里");
    await seek(25); await pair("直到星光落在心里", ""); await capture(desktop, "desktop-last");
    await evaluate(mini, "document.querySelector('.options-container button[aria-label=\"下一首\"]').click()");
    await pair("换一首新的歌", "继续下一段旋律");
    const changed = await evaluate(mini, "window['@shared/message-bus/extension'].getAppState().musicItem.id"); assert.equal(changed,"ktv-B");
    for (const font of [16,80,54]) {
        await evaluate(main, `window['@shared/app-config'].setConfig({'lyric.fontSize':${font}})`);
        const height = Math.ceil(60+8+font*1.15*1.78);
        await until(() => desktop.getSize()[1]===height, "native height " + font);
        await until(() => evaluate(desktop, `Math.abs(parseFloat(getComputedStyle(document.querySelector('.lyric-current-row')).fontSize)-${font})<.1`), "font " + font);
        await wait(350);
        assert.equal(desktop.getSize()[1],height,"Resize feedback must not shrink the font");
    }
    const bounds = await evaluate(desktop, "(()=>{const parent=document.querySelector('.content-container').getBoundingClientRect(),pair=document.querySelector('.lyric-pair').getBoundingClientRect();return {top:pair.top,bottom:pair.bottom,parentTop:parent.top,parentBottom:parent.bottom}})()");
    assert(bounds.top>=bounds.parentTop-1 && bounds.bottom<=bounds.parentBottom+1);
    assert.deepEqual(failures,[]); assert.deepEqual(requests,[]); assert(protocolCalls>=1);
    const result={ passed:true,recordedAt:new Date().toISOString(),packageRoot,scope:"Unmodified packaged main/preload/renderer bundles, local silent WAV, real MessagePorts, isolated profile; hosted by installed Electron matching the shipped version",
        electron:process.versions.electron,chromium:process.versions.chrome,platform:process.platform,checks:["intro","first/identical-text transitions","paired native windows","mini pause/resume and focus controls","seek back to zero","blank interval","last line","next song without stale lyrics","fonts 16/80/54 and native resize feedback","340x72 mini","offline assets and intercepted protocol registration"],
        remoteRequests:requests.length,preloadErrors:failures.length,screenshots:outputs,output };
    fs.writeFileSync(path.join(output,"result.json"),JSON.stringify(result,null,2)+"\n");
    console.log("PASS: packaged KTV playback, paired native windows, repeat text, seek/blank/last/next-song, pause/resume and font resize");
    console.log("RESULT_FILE",path.join(output,"result.json"));finish(0);
})().catch(error=>finish(1,error));
