const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const root = path.resolve(__dirname, "../..");
process.chdir(root);
const suite = process.argv[2];
if (!["audio", "playlist", "startup", "relocation", "download-resource", "vinyl", "lyric", "quality"].includes(suite)) throw new Error("Specify audio, playlist, startup, relocation, download-resource, vinyl, lyric or quality");
const testRoot = path.join(root, "out/.correctness-regression-" + suite + "-" + Date.now());
fs.mkdirSync(testRoot, { recursive: true });
app.setPath("userData", path.join(testRoot, "profile"));
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
const wave = Buffer.alloc(44 + 16000 * 2 * 3);
wave.write("RIFF", 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write("WAVEfmt ", 8);
wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(16000, 24); wave.writeUInt32LE(32000, 28); wave.writeUInt16LE(2, 32);
wave.writeUInt16LE(16, 34); wave.write("data", 36); wave.writeUInt32LE(wave.length - 44, 40);
const counts = {}, sockets = new Set();
let window;
const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    counts[url.pathname] = (counts[url.pathname] || 0) + 1;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    if (req.method === "OPTIONS") {
        res.end(); return;
    }
    if (url.pathname === "/stats") {
        res.end(JSON.stringify(counts)); return;
    }
    if (url.pathname === "/manifest.m3u8") {
        res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
        res.end("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:3,\nsegment.ts\n#EXT-X-ENDLIST\n"); return;
    }
    if (url.pathname === "/segment.ts") {
        // Keep a real HLS fragment request in flight until source teardown aborts it.
        res.writeHead(200, { "Content-Type": "video/mp2t" }); res.flushHeaders(); return;
    }
    if (url.pathname.startsWith("/protected") && req.headers.authorization !== "Basic dXNlcjpwYXNz") {
        res.writeHead(401); res.end(); return;
    }
    const send = () => {
        if (!res.destroyed) {
            res.writeHead(200, { "Content-Type": "audio/wav" }); res.end(wave);
        }
    };
    url.pathname.includes("slow") ? setTimeout(send, 200) : send();
});
server.on("connection", socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
});
const timeout = setTimeout(() => finish(1, new Error("Regression timed out")), 90000);
function finish(code, error) {
    clearTimeout(timeout);
    if (error) console.error(error);
    window?.destroy(); sockets.forEach(socket => socket.destroy()); server.close();
    app.exit(code);
}
(async () => {
    await app.whenReady();
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    window = new BrowserWindow({ show: false, ...(["vinyl", "lyric"].includes(suite) ? { width: 1200, height: 1000 } : {}), webPreferences: {
        nodeIntegration: true, contextIsolation: false, backgroundThrottling: false,
    } });
    const page = path.join(testRoot, "index.html");
    fs.writeFileSync(page, "<!doctype html><meta charset=\"utf-8\"><div id=\"test-root\"></div>");
    await window.loadFile(page);
    let motionPreferences;
    if (["vinyl", "lyric"].includes(suite)) {
        const systemReducedMotion = await window.webContents.executeJavaScript("matchMedia('(prefers-reduced-motion: reduce)').matches");
        window.webContents.debugger.attach("1.3");
        await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
        const normalMotion = await window.webContents.executeJavaScript("!matchMedia('(prefers-reduced-motion: reduce)').matches");
        if (!normalMotion) throw new Error("Normal-motion test condition was not applied");
        motionPreferences = { systemReducedMotion, normalMotion: true };
    }
    const code = fs.readFileSync(path.join(__dirname, suite + "-renderer.cjs"), "utf8");
    const base = "http://127.0.0.1:" + server.address().port;
    const result = await window.webContents.executeJavaScript(`(async () => { const module = { exports: {} }; ${code}\n try { return await module.exports(${JSON.stringify(testRoot)}, ${JSON.stringify(base)}); } catch (error) { return { rendererError: error.stack || error.message || String(error) }; } })()`);
    if (result?.rendererError) throw new Error(result.rendererError);
    if (suite === "vinyl") {
        for (const mode of ["playing", "paused", "bar-mini"]) {
            await window.webContents.executeJavaScript(`window.vinylPreviewMode(${JSON.stringify(mode)})`);
            fs.writeFileSync(path.join(testRoot, mode + ".png"), (await window.webContents.capturePage()).toPNG());
        }
        await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
        const reduced = await window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => resolve([...document.querySelectorAll('.vinyl-record')].every(x => getComputedStyle(x).animationName === 'none'))))");
        if (!reduced) throw new Error("Reduced motion preference not respected");
        motionPreferences.reducedMotion = true;
        await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [] });
        window.webContents.debugger.detach();
        await window.webContents.executeJavaScript("window.vinylFinish()");
    }
    if (suite === "lyric") {
        for (const mode of ["normal", "long", "last"]) {
            await window.webContents.executeJavaScript(`window.lyricPreviewMode(${JSON.stringify(mode)})`);
            fs.writeFileSync(path.join(testRoot, mode + ".png"), (await window.webContents.capturePage()).toPNG());
        }
        await window.webContents.executeJavaScript("window.lyricPreviewMode('long')");
        await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
        const reduced = await window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => resolve(getComputedStyle(document.querySelector('.lyric-next-row span')).animationName === 'none')))");
        if (!reduced) throw new Error("Lyric preview ignores reduced motion");
        motionPreferences.reducedMotion = true;
        window.webContents.debugger.detach();
        await window.webContents.executeJavaScript("window.lyricFinish()");
    }
    fs.writeFileSync(path.join(testRoot, "result.json"), JSON.stringify({ suite, passed: true, result, counts, motionPreferences, electron: process.versions.electron }, null, 2));
    console.log(result);
    console.log("RESULT_FILE", path.join(testRoot, "result.json"));
    finish(0);
})().catch(error => finish(1, error));
