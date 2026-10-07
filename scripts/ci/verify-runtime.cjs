const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
    assert.ok(process.versions.electron, "Use the packaged Electron executable");
    const resources = path.resolve(process.argv[2]);
    const appRoot = path.join(resources, "app");
    const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
    for (const entry of [".webpack/main/index.js", ".webpack/renderer/main_window/index.html",
        ".webpack/renderer/lrc_window/index.html", ".webpack/renderer/minimode_window/index.html",
        ".webpack/renderer/worker_downloader/index.js",
        ".webpack/renderer/local_file_watcher/index.js"]) {
        assert.ok(fs.statSync(path.join(appRoot, entry)).size > 0, entry);
    }
    const sharp = require(path.join(appRoot, "node_modules/sharp"));
    const image = await sharp({ create: { width: 1, height: 1, channels: 3, background: "#000000" } }).png().toBuffer();
    assert.ok(image.length > 0);
    assert.ok(fs.statSync(path.join(resources, "res/.service/request-forwarder.js")).size > 0);
    const directory = path.resolve(resources, process.platform === "darwin" ? "../../.." : "..");
    const output = path.resolve(__dirname, "../../out/ci-test-results");
    fs.mkdirSync(output, { recursive: true });
    const result = { passed: true, version: pkg.version, platform: process.platform, arch: process.arch,
        electron: process.versions.electron, sharpImageProcessed: true };
    fs.writeFileSync(path.join(output, "package-runtime.json"), JSON.stringify(result, null, 2) + "\n");
    assert.ok(fs.existsSync(path.join(directory, "build-info.json")));
    console.log("PASS: packaged Electron entry points, resources and Sharp on " + process.platform + "/" + process.arch);
})().catch(error => {
    console.error(error); process.exitCode = 1;
});
