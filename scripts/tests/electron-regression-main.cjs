const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '../..');
process.chdir(root);
const suite = process.argv[2];
if (!['audio', 'playlist', 'startup'].includes(suite)) throw new Error('Specify audio, playlist or startup');
const testRoot = path.join(root, 'out/.correctness-regression-' + suite + '-' + Date.now());
fs.mkdirSync(testRoot, { recursive: true });
app.setPath('userData', path.join(testRoot, 'profile'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const wave = Buffer.alloc(44 + 16000 * 2 * 3);
wave.write('RIFF', 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(16000, 24); wave.writeUInt32LE(32000, 28); wave.writeUInt16LE(2, 32);
wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
const counts = {}, sockets = new Set();
let window;
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    counts[url.pathname] = (counts[url.pathname] || 0) + 1;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') { res.end(); return; }
    if (url.pathname === '/stats') { res.end(JSON.stringify(counts)); return; }
    if (url.pathname === '/manifest.m3u8') {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:3,\nsegment.ts\n#EXT-X-ENDLIST\n'); return;
    }
    if (url.pathname === '/segment.ts') {
        // Keep a real HLS fragment request in flight until source teardown aborts it.
        res.writeHead(200, { 'Content-Type': 'video/mp2t' }); res.flushHeaders(); return;
    }
    if (url.pathname.startsWith('/protected') && req.headers.authorization !== 'Basic dXNlcjpwYXNz') {
        res.writeHead(401); res.end(); return;
    }
    const send = () => { if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end(wave); } };
    url.pathname.includes('slow') ? setTimeout(send, 200) : send();
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
const timeout = setTimeout(() => finish(1, new Error('Regression timed out')), 45000);
function finish(code, error) {
    clearTimeout(timeout);
    if (error) console.error(error);
    window?.destroy(); sockets.forEach(socket => socket.destroy()); server.close();
    app.exit(code);
}
(async () => {
    await app.whenReady();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    window = new BrowserWindow({ show: false, webPreferences: {
        nodeIntegration: true, contextIsolation: false, backgroundThrottling: false,
    } });
    const page = path.join(testRoot, 'index.html');
    fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><div id="test-root"></div>');
    await window.loadFile(page);
    const code = fs.readFileSync(path.join(__dirname, suite + '-renderer.cjs'), 'utf8');
    const base = 'http://127.0.0.1:' + server.address().port;
    const result = await window.webContents.executeJavaScript(`(async () => { const module = { exports: {} }; ${code}\n return await module.exports(${JSON.stringify(testRoot)}, ${JSON.stringify(base)}); })()`);
    fs.writeFileSync(path.join(testRoot, 'result.json'), JSON.stringify({ suite, passed: true, result, counts, electron: process.versions.electron }, null, 2));
    console.log(result);
    console.log('RESULT_FILE', path.join(testRoot, 'result.json'));
    finish(0);
})().catch(error => finish(1, error));
