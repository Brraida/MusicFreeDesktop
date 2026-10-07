const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { load } = require("./source-loader.cjs");

const originals = new Map(["platform", "argv", "execPath"].map(key => [key, Object.getOwnPropertyDescriptor(process, key)]));
const originalError = console.error;
try {
    const errors = [];
    console.error = (...args) => errors.push(args);
    function fixture(event, options = {}) {
        Object.defineProperty(process, "platform", { configurable: true, value: options.platform ?? "win32" });
        Object.defineProperty(process, "argv", { configurable: true, value: ["MusicFree.exe", event, "0.0.80"] });
        Object.defineProperty(process, "execPath", { configurable: true, value: "C:\\用户\\My Music\\app-0.0.80\\MusicFree.exe" });
        const calls = [], exits = [], timers = new Set();
        const child = new EventEmitter();
        let killed = 0, loaded = 0;
        child.kill = () => {
            ++killed;
        };
        const app = { isPackaged: options.packaged ?? true, exit: code => exits.push(code) };
        const events = load("src/main/squirrel-events.ts", {
            path: path.win32,
            child_process: { spawn: (...args) => {
                calls.push(args);
                if (options.throwSpawn) throw new Error("Injected spawn failure");
                return child;
            } },
            timers: { setTimeout: (callback, delay) => {
                assert.equal(delay, 10000);
                timers.add(callback); return callback;
            }, clearTimeout: timer => timers.delete(timer) },
        });
        load("src/main/startup.ts", { electron: { app }, "./squirrel-events": events,
            get "./index"() {
                ++loaded; return {};
            } });
        return { calls, exits, child, timers, loaded, killed: () => killed };
    }
    for (const [event, command] of [["--squirrel-install", "--createShortcut"], ["--squirrel-updated", "--createShortcut"], ["--squirrel-uninstall", "--removeShortcut"]]) {
        const f = fixture(event);
        assert.equal(f.loaded, 0, "Installation hooks must not load player/native/config modules or its instance lock");
        assert.deepEqual(f.calls, [["C:\\用户\\My Music\\Update.exe", [command, "MusicFree.exe", "--shortcut-locations=Desktop,StartMenu"], { windowsHide: true, stdio: "ignore" }]]);
        assert.deepEqual(f.exits, [], "Wait for the updater rather than a fixed quit delay");
        f.child.emit("close", 0, null);
        assert.deepEqual(f.exits, [0]); assert.equal(f.timers.size, 0);
    }
    const obsolete = fixture("--squirrel-obsolete");
    assert.equal(obsolete.loaded, 0); assert.equal(obsolete.calls.length, 0); assert.deepEqual(obsolete.exits, [0]);
    for (const [event, options] of [[undefined, {}], ["--squirrel-firstrun", {}], ["musicfree://play", {}],
        ["--squirrel-install", { platform: "linux" }], ["--squirrel-uninstall", { platform: "darwin" }],
        ["--squirrel-install", { packaged: false }]]) {
        const normal = fixture(event, options);
        assert.equal(normal.loaded, 1); assert.equal(normal.calls.length, 0); assert.equal(normal.exits.length, 0);
    }
    const spawnFailed = fixture("--squirrel-install", { throwSpawn: true });
    assert.deepEqual(spawnFailed.exits, [1]); assert.equal(spawnFailed.loaded, 0);
    const missing = fixture("--squirrel-install");
    missing.child.emit("error", Object.assign(new Error("Missing updater"), { code: "ENOENT" }));
    missing.child.emit("close", -2, null);
    assert.deepEqual(missing.exits, [1]); assert.equal(missing.timers.size, 0);
    for (const [code, signal] of [[1, null], [null, "SIGTERM"]]) {
        const failed = fixture("--squirrel-updated");
        failed.child.emit("close", code, signal); assert.deepEqual(failed.exits, [1]);
    }
    const hung = fixture("--squirrel-uninstall");
    [...hung.timers][0](); hung.child.emit("close", null, "SIGTERM");
    assert.equal(hung.killed(), 1); assert.deepEqual(hung.exits, [1]); assert.equal(hung.loaded, 0); assert.equal(hung.timers.size, 0);
    assert(errors.length >= 5);
    console.log("PASS: shortcut install/update/remove, early entry before player imports, first/normal/dev/non-Windows startup, paths with spaces/Unicode, spawn failure, nonzero/signal and timeout cleanup");
} finally {
    console.error = originalError;
    for (const [key, descriptor] of originals) Object.defineProperty(process, key, descriptor);
}
