/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires, no-console -- Electron regression scripts use CommonJS and report results to the terminal. */
const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const projectRoot = path.resolve(__dirname, "../..");
process.chdir(projectRoot);
const testRoot = path.resolve("out/.download-regression-data-" + Date.now());
fs.mkdirSync(testRoot, { recursive: true });
app.setPath("userData", path.join(testRoot, "user-data"));
fs.mkdirSync(app.getPath("userData"), { recursive: true });
let window;
const requests = new Map();
const sockets = new Set();
const audio = Buffer.alloc(16384, 90);
const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    requests.set(pathname, (requests.get(pathname) || 0) + 1);
    response.setHeader("Access-Control-Allow-Origin", "*");
    if (pathname === "/playlist-mime") {
        response.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
        response.end("#EXTM3U\n#EXT-X-ENDLIST\n"); return;
    }
    if (pathname === "/playlist-disguised.mp3") {
        response.writeHead(200, { "Content-Type": "application/octet-stream" });
        response.end("\uFEFF#EXTM3U\n#EXT-X-TARGETDURATION:10\nsegment.ts\n"); return;
    }
    if (pathname === "/playlist-split") {
        response.writeHead(200);
        response.write("#EX");
        setTimeout(() => {
            response.write("TM"); setTimeout(() => response.end("3U\n#EXT-X-ENDLIST\n"), 10);
        }, 10);
        return;
    }
    if (pathname.includes("404")) {
        response.writeHead(404); response.end("not found"); return;
    }
    if (pathname.includes("broken")) {
        response.writeHead(200, { "Content-Length": 40000 });
        response.write(audio);
        setTimeout(() => response.destroy(), 30);
        return;
    }
    if (pathname.includes("slow")) {
        response.writeHead(200, { "Content-Length": audio.length * 30 });
        const timer = setInterval(() => response.write(audio), 40);
        request.on("close", () => clearInterval(timer));
        return;
    }
    response.writeHead(200, { "Content-Length": audio.length }); response.end(audio);
});
server.on("connection", socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
});
(async () => {
    await app.whenReady();
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
    const html = path.join(testRoot, "index.html");
    fs.writeFileSync(html, "<!doctype html><meta charset=\"utf-8\"><title>Download regression test</title>");
    await window.loadFile(html);
    const code = fs.readFileSync(path.join(__dirname, "downloader-renderer.cjs"), "utf8");
    const result = await window.webContents.executeJavaScript(`(async () => { const testRoot = ${JSON.stringify(testRoot)}; const baseURL = ${JSON.stringify("http://127.0.0.1:" + server.address().port)}; const module = { exports: {} }; ${code}\n return await module.exports(testRoot, baseURL); })()`);
    console.log(result);
    console.log("HTTP_REQUEST_COUNTS", JSON.stringify(Object.fromEntries(requests)));
    window.destroy();
    sockets.forEach(socket => socket.destroy());
    server.close();
    app.exit(0);
})().catch(error => {
    console.error(error); fs.writeFileSync("out/.download-test-error.txt", String(error.stack || error)); window?.destroy(); sockets.forEach(socket => socket.destroy()); server.close(); app.exit(1);
});
