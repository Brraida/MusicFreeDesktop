const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { load } = require("./source-loader.cjs");
const resource = load("src/common/download-resource.ts");
const { DownloadResourceState: State } = resource;
const backend = mocks => load("src/common/download-file-system.ts", { "./download-resource": resource, ...mocks });
const { inspectDownloadFile } = backend();
const { DownloadDirectoryWatcher } = load("src/common/download-directory-watcher.ts", { "./download-resource": resource });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const key = fp => process.platform === "win32" ? path.resolve(fp).toLowerCase() : path.resolve(fp);
const contains = (event, fp) => event.paths.some(changed => key(changed) === key(fp));
async function until(check, label) {
    const deadline = Date.now() + 15000;
    while (!check()) {
        if (Date.now() > deadline) throw new Error("Timed out: " + label);
        await delay(25);
    }
}

(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "musicfree-download-resource-"));
    const monitor = new DownloadDirectoryWatcher();
    try {
        const downloads = path.join(root, "tree", "downloads");
        const other = path.join(root, "other");
        const unrelated = path.join(root, "unrelated");
        await fs.mkdir(downloads, { recursive: true }); await fs.mkdir(other); await fs.mkdir(unrelated);
        const file = path.join(downloads, "song.mp3");
        await fs.writeFile(file, "original audio");
        const initial = await inspectDownloadFile(file);
        assert.equal(initial.state, State.AVAILABLE);
        assert.match(initial.identity.sha256, /^[a-f0-9]{64}$/);
        assert.equal(initial.identity.size, 14);
        const verified = { version: 1, path: file, directory: downloads, state: State.AVAILABLE, checkedAt: Date.now() };
        const data = { path: file, fingerprint: initial.identity, verified };
        assert.deepEqual(resource.restoreDownloadResource(data, downloads, key),
            { state: State.AVAILABLE, path: file, checkedAt: verified.checkedAt, reason: undefined, cached: true });
        for (const invalid of [{ ...data, path: file + ".moved" }, { ...data, fingerprint: undefined },
            { ...data, verified: { ...verified, version: 2 } }, { ...data, verified: { ...verified, checkedAt: NaN } },
            { ...data, verified: { ...verified, state: State.CHECKING } }, { ...data, verified: undefined }]) {
            assert.equal(resource.restoreDownloadResource(invalid, downloads, key).state, State.CHECKING);
        }
        assert.equal(resource.restoreDownloadResource(data, other, key).state, State.CHECKING,"Changed download directory invalidates the cached result");
        for (const state of [State.MISSING, State.UNAVAILABLE]) {
            assert.equal(resource.restoreDownloadResource({ ...data, verified: { ...verified, state } }, downloads, key).state,state);
        }

        const copy = path.join(other, "song.mp3");
        await fs.copyFile(file, copy);
        assert.equal((await inspectDownloadFile(copy, initial.identity, true)).state, State.AVAILABLE);
        await fs.writeFile(copy, "different song"); // Same size and filename, different content.
        assert.equal((await inspectDownloadFile(copy, initial.identity, true)).reason, "changed");
        await fs.writeFile(copy, ""); assert.equal((await inspectDownloadFile(copy)).reason, "empty");
        assert.equal((await inspectDownloadFile(other)).state, State.UNAVAILABLE);
        const missing = path.join(downloads, "missing.mp3");
        assert.equal((await inspectDownloadFile(missing, initial.identity)).state, State.MISSING);
        assert.equal((await inspectDownloadFile(missing, { ...initial.identity, device: "disconnected-device" })).reason, "offline");
        for (const [code, reason] of [["EACCES", "permission"], ["EPERM", "permission"], ["EIO", "io"]]) {
            const injected = backend({ "fs/promises": { open: async () => {
                throw Object.assign(new Error(code), { code });
            } } });
            assert.equal((await injected.inspectDownloadFile(file)).reason, reason);
        }
        const volume = backend({ "fs/promises": {
            open: async () => {
                throw Object.assign(new Error("missing"), { code: "ENOENT" });
            },
            stat: async () => {
                throw Object.assign(new Error("offline"), { code: "ENOENT" });
            },
        } });
        assert.equal((await volume.inspectDownloadFile(file)).reason, "offline");
        const events = [];
        await monitor.watch([downloads], event => events.push(event));
        await until(() => events.some(event => event.full && !event.error), "initial watcher ready"); events.length = 0;
        await fs.unlink(file);
        await until(() => events.some(event => contains(event, file)), "external file deletion"); events.length = 0;
        await fs.writeFile(file, "original audio");
        await until(() => events.some(event => contains(event, file)), "file restoration"); events.length = 0;
        await fs.rm(path.dirname(downloads), { recursive: true });
        await until(() => events.some(event => contains(event, downloads) || contains(event, file)), "whole directory deletion"); events.length = 0;
        await fs.mkdir(downloads, { recursive: true }); await fs.writeFile(file, "original audio");
        await until(() => events.some(event => contains(event, file) || contains(event, downloads) || (event.full && !event.error)), "ancestor and directory recreation");
        assert.equal((await inspectDownloadFile(file, initial.identity, true)).state, State.AVAILABLE);
        // Recreation during reattachment is covered by ready/full; subsequent changes use native events.
        await until(() => events.some(event => event.full && !event.error), "recovered watcher ready"); events.length = 0;
        await fs.unlink(file);
        await until(() => events.some(event => contains(event, file)), "native events after reattachment");
        await fs.mkdir(path.join(unrelated, "nested")); await fs.writeFile(path.join(unrelated, "nested", "not-watched.mp3"), "unrelated");
        await delay(400);
        assert(!events.some(event => event.paths.some(fp => fp.startsWith(unrelated))));
        assert(!Object.keys(monitor.watcher.getWatched()).some(fp => fp.startsWith(unrelated)), "unrelated trees must not be scanned");
        const stale = [], current = [];
        await Promise.all([monitor.watch([downloads], event => stale.push(event)), monitor.watch([other], event => current.push(event))]);
        await until(() => current.some(event => event.full && !event.error), "replacement watcher ready");
        assert.equal(stale.length, 0, "superseded watcher must not deliver callbacks");
        await monitor.stop(); const count = current.length;
        await fs.writeFile(copy, "after stop"); await delay(400);
        assert.equal(current.length, count, "stop releases callbacks and timers");
        console.log("PASS: download file SHA-256, same-name impostors, missing/offline/permissions/I/O, real Chokidar deletion/restoration/ancestor recovery, bounded scopes, replacement generations and cleanup");
    } finally {
        await monitor.stop(); await fs.rm(root, { recursive: true, force: true });
    }
})().catch(error => {
    console.error(error); process.exitCode = 1;
});
