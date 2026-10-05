const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const root = path.resolve(__dirname, "../../..");
const packageRoot = path.resolve(process.argv[2] || path.join(root, "out/MusicFree-win32-x64"));
const testRoot = path.join(root, "out/.packaged-theme-smoke-" + Date.now());
const portable = path.join(testRoot, "fixture");
app.setName("MusicFree");
const media = path.join(portable, "preview-media");
fs.mkdirSync(testRoot, { recursive: true });
fs.mkdirSync(media, { recursive: true });
for (const name of ["userData", "appData", "downloads"]) {
    const isolated = path.join(name === "downloads" ? portable : testRoot, name);
    fs.mkdirSync(isolated, { recursive: true });
    app.setPath(name, isolated);
}
app.setPath("temp", testRoot);
Object.defineProperty(app, "isPackaged", { value: true });
Object.defineProperty(process, "resourcesPath", { value: path.join(packageRoot, "resources") });
app.getAppPath = () => path.join(packageRoot, "resources/app");
app.getVersion = () => "0.0.80";
let protocolCalls = 0;
app.setAsDefaultProtocolClient = () => { protocolCalls++; return false; };
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
fs.writeFileSync(path.join(app.getPath("userData"), "config.json"), JSON.stringify({
    "$schema-version": 1, "normal.checkUpdate": false, "normal.language": "zh-CN",
    "normal.closeBehavior": "exit_app", "plugin.autoUpdatePlugin": false, "normal.builtinTheme": "classic",
    "download.path": app.getPath("downloads"),
    "private.mainWindowSize": { width: 1200, height: 860 },
}));
const rate = 16000;
const wav = Buffer.alloc(44 + rate * 2 * 180);
wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
const notes = [261.63, 329.63, 392, 523.25, 392, 329.63];
for (let index = 0; index < rate * 180; index++) {
    const seconds = index / rate;
    const beat = seconds % 2;
    const envelope = Math.min(1, beat / 0.02) * Math.exp(-beat * 2.5);
    const frequency = notes[Math.floor(seconds / 2) % notes.length];
    wav.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * seconds) * envelope * 1300), 44 + index * 2);
}
const wavPath = path.join(media, "theme-demo.wav"); fs.writeFileSync(wavPath, wav);
const coverPath = path.join(media, "jiangnan-demo-cover.png");
fs.copyFileSync(path.join(root, "docs/knowledge-base/assets/previews/jiangnan-demo-cover.png"), coverPath);
assert(fs.existsSync(coverPath), "Generated sample album cover missing");
const names = ["烟雨入江南", "青花小调", "水岸听风", "雨落石桥", "月照乌篷", "云水之间"];
const songs = names.map((title, index) => ({ platform: "本地", id: "jiangnan-demo-" + index,
    title, artist: "示例歌手", album: "江南听雨", url: wavPath, duration: 180,
    artwork: pathToFileURL(coverPath).href, "$$ref": 3,
    rawLrc: "[00:00.00]听雨声轻轻落在水面\n[00:20.00]小桥迎来一缕风\n[00:40.00]乌篷缓缓驶过石桥\n[01:00.00]晚灯照着归来的船\n[01:20.00]把这一刻留给旋律",
}));
const refs = songs.map(({ platform, id }) => ({ platform, id }));
const sheets = [
    { id: "favorite", title: "我喜欢", platform: "本地", musicList: refs, "$$sortIndex": -1 },
    { id: "theme-rain", title: "雨巷", platform: "本地", musicList: refs, "$$sortIndex": 0 },
    { id: "theme-jiangnan", title: "江南听雨", platform: "本地", musicList: refs, "$$sortIndex": 1 },
];
const compatibilityPack = path.join(app.getPath("userData"), "musicfree-themepacks/theme-compatibility-test");
fs.mkdirSync(compatibilityPack, { recursive: true });
fs.writeFileSync(path.join(compatibilityPack, "config.json"), JSON.stringify({ name: "兼容性测试主题", preview: "#587253" }));
fs.writeFileSync(path.join(compatibilityPack, "index.css"), ":root { --primaryColor: #587253; }");
let main, mini;
let firstWindow, firstShown, firstShownSnapshot, heldChunk, blockedChunk = false;
let failNextPlayerChunk = false;
const started = Date.now();
const firstShownPromise = new Promise(resolve => { firstShown = resolve; });
const failures = [];
const remoteRequests = [];
app.on("browser-window-created", (_event, window) => {
    if (!firstWindow) {
        firstWindow = window;
        assert.equal(window.isVisible(), false, "Main window must start hidden");
        window.once("show", async () => {
            firstShownSnapshot = await window.webContents.executeJavaScript(`({
                shell:!!document.getElementById('startup-shell'), ready:!!document.querySelector('.music-info-outer-container'),
                theme:document.documentElement.dataset.builtinTheme, primary:getComputedStyle(document.documentElement).getPropertyValue('--primaryColor').trim(),
                status:document.getElementById('startup-status')?.textContent, shownAtMs:performance.now(),
                wordmark:document.querySelector('.startup-brand .musicfree-wordmark-text')?.textContent,
                note:document.querySelector('.startup-brand .musicfree-wordmark-note')?.textContent,
                noteColor:getComputedStyle(document.querySelector('.startup-brand .musicfree-wordmark-note')).color
            })`);
            assert(firstShownSnapshot.shell && !firstShownSnapshot.ready, "First shown frame must contain the shell before the player");
            assert.equal(firstShownSnapshot.theme,"jiangnan");
            assert.equal(firstShownSnapshot.primary,"#245a81");
            assert.equal(firstShownSnapshot.wordmark,"MusicFree");
            assert.equal(firstShownSnapshot.note,"♪");
            assert.equal(firstShownSnapshot.noteColor,"rgb(36, 90, 129)");
            firstShownSnapshot.processProbeMs=Date.now()-started;
            fs.writeFileSync(path.join(testRoot,"startup-shell.png"),(await window.webContents.capturePage()).toPNG());
            firstShown();
        });
        window.webContents.on("dom-ready", () => window.webContents.executeJavaScript(`(() => {
            window.startupThemeFrames=[];
            const sample=()=>{if(window.startupThemeFrames.length>=2000)return;
                window.startupThemeFrames.push({theme:document.documentElement.dataset.builtinTheme,primary:getComputedStyle(document.documentElement).getPropertyValue('--primaryColor').trim()});
                requestAnimationFrame(sample);};sample();
        })()`).catch(() => {}));
    }
    window.webContents.on("preload-error", (_evt, _file, error) => failures.push(error.message));
    window.webContents.on("did-finish-load", () => {
        if (window.webContents.getURL().includes("main_window")) main = window;
        if (window.webContents.getURL().includes("minimode")) mini = window;
    });
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
        const remote = /^https?:/.test(details.url);
        if (remote) remoteRequests.push(details.url);
        if (/\/player\/index\.js(?:$|\?)/.test(details.url)) {
            if (failNextPlayerChunk) { failNextPlayerChunk=false; blockedChunk=true; callback({cancel:true}); return; }
            if (!heldChunk) {
                heldChunk=details.url;
                setTimeout(()=>callback({cancel:false}),3200);
                return;
            }
        }
        callback({ cancel: remote });
    });
});
const timeout = setTimeout(() => finish(1, new Error("Packaged theme smoke timed out")), 90000);
function finish(code, error) {
    if (error) console.error(error);
    clearTimeout(timeout);
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    app.exit(code);
}
async function waitFor(check, label = "UI") {
    const deadline = Date.now() + 15000;
    while (!(await check())) {
        assert(Date.now() < deadline, "Theme condition timed out: " + label);
        await new Promise(resolve => setTimeout(resolve, 80));
    }
}
const evaluate = (window, code) => window.webContents.executeJavaScript(code);
const theme = window => evaluate(window, "document.documentElement.dataset.builtinTheme || 'classic'");
const navigate = route => evaluate(main, `window['@shared/message-bus/main'].sendCommand('Navigate',${JSON.stringify(route)})`);
async function screenshot(window, name) {
    await new Promise(resolve => setTimeout(resolve, 350));
    fs.writeFileSync(path.join(testRoot, name + ".png"), (await window.webContents.capturePage()).toPNG());
}
async function reloadMain() {
    const loaded = new Promise(resolve => main.webContents.once("did-finish-load", resolve));
    main.webContents.reload(); await loaded;
    await waitFor(() => evaluate(main, "!!document.querySelector('.music-info-outer-container')"), "reloaded bootstrap");
}
(async () => {
    require(path.join(packageRoot, "resources/app/.webpack/main/index.js"));
    await waitFor(() => main && evaluate(main, "!!document.querySelector('.music-info-outer-container')"));
    await firstShownPromise;
    assert(heldChunk,"Deferred player chunk was actually intercepted");
    assert(firstShownSnapshot.shownAtMs<3200,"Shell must be shown before the held player finishes");
    await waitFor(()=>evaluate(main,"!document.getElementById('startup-shell')"),"shell dismissed on player paint");
    const initialFrames=await evaluate(main,"window.startupThemeFrames");
    assert(initialFrames.length>2);
    assert(initialFrames.every(frame=>frame.theme==='jiangnan' && frame.primary==='#245a81'),"Legacy classic selection must never flash orange");
    const firstStartupMarks=await evaluate(main,"performance.getEntriesByType('mark').map(mark=>({name:mark.name,startTime:mark.startTime}))");
    await waitFor(async () => await theme(main) === "jiangnan", "initial built-in theme");
    assert.equal(app.getName(), "MusicFree");
    assert.equal(protocolCalls, 1, "Production protocol registration was intercepted without changing Windows associations");
    assert.equal(await evaluate(main, "getComputedStyle(document.documentElement).getPropertyValue('--primaryColor').trim()"), "#245a81");
    await evaluate(main, `(async () => {
        const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('musicSheetDB');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
        await new Promise((resolve,reject)=>{const tx=db.transaction(['sheets','musicStore','localMusicStore'],'readwrite');
            for(const sheet of ${JSON.stringify(sheets)})tx.objectStore('sheets').put(sheet);
            for(const song of ${JSON.stringify(songs)}){tx.objectStore('musicStore').put(song);tx.objectStore('localMusicStore').put({...song,$$localPath:song.url});}
            tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});db.close();
        localStorage.setItem('currentMusic',${JSON.stringify(JSON.stringify(songs[0]))});localStorage.setItem('volume','0');
    })()`);
    await reloadMain();
    await navigate("/main/musicsheet/" + encodeURIComponent("本地") + "/favorite");
    await waitFor(() => evaluate(main, "document.querySelectorAll('.music-list-container tbody tr[data-index]').length === 6 || document.querySelector('.music-list-container tbody')?.textContent.includes('云水之间')"), "six demo songs");
    const resources = await evaluate(main, `(async () => {
        const urls=['.side-bar-container','.music-sheetlike-view--header-container'].map(selector=>getComputedStyle(document.querySelector(selector)).backgroundImage.match(/url\\([\"']?(.*?)[\"']?\\)/)[1]);
        return Promise.all(urls.map(async src=>{const image=new Image();image.src=src;await image.decode();return {src,width:image.naturalWidth,height:image.naturalHeight};}));
    })()`);
    assert(resources.every(resource => new URL(resource.src).protocol === "file:" && resource.width > 0));
    assert.equal(await evaluate(main, "getComputedStyle(document.querySelector('.music-list-operations [style*=favoriteColor]')).color"), "rgb(36, 90, 129)", "Favorite icon follows blue theme");
    await screenshot(main, "main");
    await evaluate(main, "document.querySelector('.music-list-batch-toolbar button').click()");
    await waitFor(() => evaluate(main, "!!document.querySelector('.music-list-container tbody input[type=checkbox]')"));
    await evaluate(main, "[...document.querySelectorAll('.music-list-batch-toolbar button')].find(button=>button.textContent.trim()==='全选').click()");
    await waitFor(() => evaluate(main, "document.querySelectorAll('.music-list-container tbody input[type=checkbox]:checked').length===6"));
    await evaluate(main, "document.querySelector('.music-list-container tbody input[type=checkbox]').click()");
    await waitFor(() => evaluate(main, "document.querySelectorAll('.music-list-container tbody input[type=checkbox]:checked').length===5"));
    await screenshot(main, "main-batch");
    // The shipped main window normally enforces 1050px; test smaller responsive layout explicitly.
    main.setMinimumSize(850, 600);
    main.setSize(850, 700);
    await screenshot(main, "main-narrow");
    assert.equal(main.getSize()[0], 850, "Responsive fixture must really be 850px");
    assert.equal(await evaluate(main, "document.documentElement.scrollWidth <= innerWidth"), true, "Narrow page overflow");
    main.setSize(1200, 860);
    await evaluate(main, "window['@shared/message-bus/main'].sendCommand('TogglePlayerState')");
    await waitFor(() => evaluate(main, "document.querySelector('.music-cover.vinyl-cover')?.dataset.playing==='true'"));
    await evaluate(main, "window['@shared/message-bus/main'].sendCommand('OpenMusicDetailPage')");
    await waitFor(() => evaluate(main, "!!document.querySelector('.music-album.vinyl-cover')"));
    assert.equal(await evaluate(main, "getComputedStyle(document.querySelector('.music-detail-background')).display"), "none");
    assert.equal(await evaluate(main, "getComputedStyle(document.querySelector('.vinyl-artwork')).borderRadius"), "50%");
    await screenshot(main, "detail-playing");
    await evaluate(main, "window['@shared/utils'].appWindow.setMinimodeWindow(true)");
    await waitFor(() => mini && evaluate(mini, "document.querySelector('.album-container.vinyl-cover')?.dataset.playing==='true'"));
    assert.equal(await theme(mini), "jiangnan");
    await screenshot(mini, "mini-playing");
    await evaluate(mini, "document.querySelector('.minimode-header-container').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))");
    await screenshot(mini, "mini-hover");
    await evaluate(main, "window['@shared/message-bus/main'].sendCommand('TogglePlayerState')");
    await waitFor(() => evaluate(mini, "document.querySelector('.album-container.vinyl-cover')?.dataset.playing==='false'"));
    assert.equal(await evaluate(main, "document.querySelector('.music-album.vinyl-cover').dataset.playing"), "false");
    await screenshot(main, "detail-paused");
    await screenshot(mini, "mini-paused");
    await evaluate(main, "window.dispatchEvent(new KeyboardEvent('keydown',{code:'Escape',key:'Escape',bubbles:true}))");
    await navigate("/main/theme");
    await waitFor(() => evaluate(main, "!!document.querySelector('.builtin-theme-choice')"));
    await screenshot(main, "theme-selector");
    assert.equal(await evaluate(main,"[...document.querySelectorAll('.theme-name')].some(node=>node.textContent==='默认')"),false,"Old default theme choice must be removed");
    await evaluate(main, "[...document.querySelectorAll('.theme-name')].find(node=>node.textContent==='兼容性测试主题').click()");
    await waitFor(async () => await theme(main) === "classic", "external pack takes precedence");
    assert.equal(await evaluate(main, "getComputedStyle(document.documentElement).getPropertyValue('--primaryColor').trim()"), "#587253");
    await reloadMain();
    await waitFor(async () => await theme(main) === "classic", "external pack restored after reload");
    await waitFor(() => evaluate(main, "getComputedStyle(document.documentElement).getPropertyValue('--primaryColor').trim()==='#587253'"));
    await navigate("/main/theme");
    await waitFor(() => evaluate(main, "!!document.querySelector('.builtin-theme-choice')"));
    await evaluate(main, "document.querySelector('.builtin-theme-choice').click()");
    await waitFor(async () => await theme(main) === "jiangnan" && await theme(mini) === "jiangnan");
    assert.equal(await evaluate(main, "document.querySelector('#themepack-node').textContent"), "");
    await reloadMain();
    await waitFor(async () => await theme(main) === "jiangnan", "theme persisted across reload");
    await navigate("/main/musicsheet/" + encodeURIComponent("本地") + "/favorite");
    await waitFor(() => evaluate(main, "document.querySelector('.music-list-container tbody')?.textContent.includes('云水之间')"));
    const logoChecks=[];
    for (const width of [1050, 1200]) {
        main.setSize(width, 860);
        for (const scale of [1, 1.25, 1.5, 2]) {
            main.webContents.setZoomFactor(scale);
            const expectedViewport=main.getContentSize()[0]/scale;
            await waitFor(()=>evaluate(main,`Math.abs(innerWidth-${expectedViewport})<=1`),"wordmark zoom applied");
            await evaluate(main,"new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
            const geometry=await evaluate(main,`(() => {
                const logo=document.querySelector('.header-container .logo'), style=getComputedStyle(logo);
                const label=logo.querySelector('.musicfree-wordmark-text'),note=logo.querySelector('.musicfree-wordmark-note');
                const range=document.createRange();range.selectNodeContents(label);
                const text=range.getBoundingClientRect(),slot=logo.getBoundingClientRect();
                range.setStart(label.firstChild,label.textContent.length-1);
                const last=range.getBoundingClientRect();
                const clipped=[];
                for(let node=logo;node;node=node.parentElement){
                    const css=getComputedStyle(node),rect=node.getBoundingClientRect();
                    if(['hidden','clip','auto','scroll'].includes(css.overflowX) && (last.left<rect.left || last.right>rect.right))clipped.push(node.className || node.tagName);
                    if(['hidden','clip','auto','scroll'].includes(css.overflowY) && (last.top<rect.top || last.bottom>rect.bottom))clipped.push(node.className || node.tagName);
                }
                const noteRect=note.getBoundingClientRect(),noteStyle=getComputedStyle(note);
                return {scale:${scale},windowWidth:${width},text:label.textContent,svg:!!logo.querySelector('svg'),
                    note:note.textContent,noteHidden:note.getAttribute('aria-hidden'),noteColor:noteStyle.color,brandColor:style.color,noteWidth:noteRect.width,noteGap:text.left-noteRect.right,noteLeft:noteRect.left,roundedF:!!logo.querySelector('.musicfree-wordmark-f'),
                    left:text.left-slot.left,right:slot.right-text.right,top:text.top-slot.top,bottom:slot.bottom-text.bottom,
                    lastWidth:last.width,lastRight:last.right,viewportWidth:innerWidth,clipped,font:style.fontFamily};
            })()`);
            assert.equal(geometry.text,"MusicFree");
            assert.equal(geometry.note,"♪");
            assert.equal(geometry.noteHidden,"true","Decorative music note must not change the accessible brand name");
            assert(geometry.noteWidth>0 && geometry.noteGap>=7 && geometry.noteLeft>=0,"Music note must be visible before the label with spare space");
            assert.equal(geometry.noteColor,geometry.brandColor,"Music note must follow the theme color");
            assert.equal(geometry.roundedF,false,"F must use the regular font glyph");
            assert.equal(geometry.svg,false,"Wordmark must use native text without a cropped SVG viewport");
            assert(geometry.left>=0 && geometry.right>=7,"Complete wordmark needs spare space on the right");
            assert(geometry.top>=0 && geometry.bottom>=0,"Text must fit vertically");
            assert(geometry.lastWidth>0 && geometry.lastRight<geometry.viewportWidth,"Last e must be inside the viewport");
            assert.deepEqual(geometry.clipped,[],"No ancestor may clip the last e");
            logoChecks.push(geometry);
        }
    }
    main.setSize(1200, 860);
    main.webContents.setZoomFactor(1);
    await waitFor(()=>evaluate(main,"innerWidth===1200"),"wordmark zoom reset");
    await new Promise(resolve=>setTimeout(resolve,100));
    fs.writeFileSync(path.join(testRoot,"wordmark.png"),(await main.webContents.capturePage({x:0,y:0,width:165,height:60})).toPNG());
    // A missing legacy external pack falls back to porcelain without an orange frame.
    await navigate("/main/theme");
    await waitFor(()=>evaluate(main,"!!document.querySelector('.builtin-theme-choice')"));
    await evaluate(main,"[...document.querySelectorAll('.theme-name')].find(node=>node.textContent==='兼容性测试主题').click()");
    await waitFor(async()=>await theme(main)==='classic');
    fs.unlinkSync(path.join(compatibilityPack,"index.css"));
    await reloadMain();
    await waitFor(async()=>await theme(main)==='jiangnan');
    assert.equal(await evaluate(main,"getComputedStyle(document.documentElement).getPropertyValue('--primaryColor').trim()"),"#245a81");
    // Cancel the real emitted player chunk: the static shell must present retry.
    failNextPlayerChunk=true;
    main.webContents.reloadIgnoringCache();
    await waitFor(()=>evaluate(main,"document.getElementById('startup-shell')?.dataset.failed==='true'"),"chunk failure retry UI");
    assert(blockedChunk);
    assert.equal(await evaluate(main,"document.getElementById('startup-status').getAttribute('role')"),"alert");
    assert.equal(await evaluate(main,"document.getElementById('startup-retry').hidden"),false);
    await screenshot(main,"startup-failed");
    await evaluate(main,"document.getElementById('startup-retry').click()");
    await waitFor(()=>evaluate(main,"!!document.querySelector('.music-info-outer-container') && !document.getElementById('startup-shell')"),"retry recovers player");
    await navigate("/main/musicsheet/"+encodeURIComponent("本地")+"/favorite");
    await evaluate(main, "localStorage.setItem('volume','0.25')");
    main.webContents.session.flushStorageData();
    assert.deepEqual(failures, []);
    assert.deepEqual(remoteRequests, [], "Theme preview must work offline");
    const report = { passed: true, firstShownSnapshot, firstStartupMarks, heldChunk, logoChecks, legacyClassicMigrated:true, brokenExternalPackFallsBackToBlue:true, realChunkFailureRetryPassed:true, packagedMainPreloadRenderer: true, isolatedProfile: app.getPath("userData"), portableProfileTarget: path.join(portable, "userData"),
        appName: app.getName(), protocolCalls, platform: process.platform, electron: process.versions.electron,
        chromium: process.versions.chrome, network: "HTTP(S) blocked; no requests attempted", resources,
        checks: ["blue default and local images", "real six-song playlist", "select all then deselect one", "850px narrow page",
            "local synthesized WAV playback", "detail and mini circular covers", "real mini-window state sync", "pause in both windows",
            "legacy classic migrated to porcelain without an orange frame", "external pack precedence and restore", "theme persisted after reload", "nonblank first frame before 3.2s delayed player chunk", "music note, regular F and last e at 1050/1200px and 100/125/150/200 percent zoom", "chunk failure retry", "production identity; registration intercepted and isolated test profile"],
        demo: "Six fictional tracks share a locally synthesized quiet chime; original lyrics; isolated preview music only",
        narrowWindow: "Temporarily lowered minimum width to 850px in test; production minimum remains 1050px",
        screenshots: ["main", "main-batch", "main-narrow", "detail-playing", "detail-paused", "mini-playing", "mini-hover", "mini-paused", "theme-selector", "startup-shell", "startup-failed", "wordmark"].map(name => path.join(testRoot, name + ".png")) };
    fs.writeFileSync(path.join(testRoot, "result.json"), JSON.stringify(report, null, 2) + "\n");

    fs.rmSync(compatibilityPack, { recursive: true, force: true });
    console.log("PASS", JSON.stringify(report)); console.log("RESULT", path.join(testRoot, "result.json"));
    finish(0);
})().catch(error => finish(1, error));
