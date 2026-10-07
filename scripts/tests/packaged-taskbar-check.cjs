const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const packageRoot = path.resolve(process.argv[2]);
assert.equal(process.platform, "win32");
const output = path.resolve(__dirname, "../../out/.taskbar-check-" + Date.now());
fs.mkdirSync(output, { recursive: true }); app.setPath("userData", output);
let window;
(async () => {
    await app.whenReady();
    window = new BrowserWindow({ width: 320, height: 240, show: false });
    await window.loadURL("data:text/html,<title>isolated taskbar check</title>");
    const modules = path.join(packageRoot, "resources/app/.webpack/main");
    const file = fs.readdirSync(modules).find(name => name.endsWith(".node"));
    assert(file, "Windows taskbar addon must be packaged");
    const native = require(path.join(modules, file));
    assert.equal(typeof native.config, "function");
    assert.equal(typeof native.sendIconicRepresentation, "function");
    const sharp = require(path.join(packageRoot, "resources/app/node_modules/sharp"));
    const handle = window.getNativeWindowHandle().readBigUInt64LE(0);
    native.config(handle);
    const images = [];
    for (const [width, height] of [[320, 106], [106, 320], [1, 1]]) {
        const png = await sharp({ create: { width, height, channels: 4, background: { r: 27, g: 58, b: 92, alpha: .5 } } }).png().toBuffer();
        const image = await sharp(png).resize(106, 106, { fit: "cover" }).png().ensureAlpha(1).raw().toBuffer({ resolveWithObject: true });
        assert.equal(image.info.width, 106); assert.equal(image.info.height, 106); assert.equal(image.info.channels, 4);
        assert.equal(image.data.length, 106 * 106 * 4);
        // Alpha premultiplication during resize introduces small rounding errors.
        for (const [channel, expected] of [27, 58, 92].entries()) assert(Math.abs(image.data[channel] - expected) <= 2);
        assert.equal(image.data[3], 128);
        native.sendIconicRepresentation(handle, { width: 106, height: 106 }, image.data);
        images.push({ width, height, bytes: image.data.length });
    }
    const report = { passed: true, packageRoot, electron: process.versions.electron, images,
        scope: "Real Windows HWND and shipped taskbar addon with packaged Sharp, rectangle/square crop and RGBA checks; no production data or protocol registration; native calls did not crash; does not assert physical taskbar preview screenshot" };
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(report, null, 2));
    console.log("PASS: shipped Sharp and taskbar native HWND operations", path.join(output, "result.json"));
    window.destroy(); app.exit(0);
})().catch(error => {
    console.error(error); window?.destroy(); app.exit(1);
});
