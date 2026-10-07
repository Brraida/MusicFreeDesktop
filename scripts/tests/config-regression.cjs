const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { load } = require("./source-loader.cjs");

(async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "musicfree-config-"));
    const file = path.join(folder, "config.json"), handlers = new Map(), notices = [], errors = [];
    let fault;
    const injected = { ...fs,
        writeFileSync: (...args) => {
            if (fault === "write") throw Object.assign(new Error("Disk full"), { code: "ENOSPC" }); return fs.writeFileSync(...args);
        },
        fsyncSync: (...args) => {
            if (fault === "flush") throw Object.assign(new Error("Flush failed"), { code: "EIO" }); return fs.fsyncSync(...args);
        },
        renameSync: (...args) => {
            if (fault === "rename" && args[1] === file) throw Object.assign(new Error("Access denied"), { code: "EACCES" }); return fs.renameSync(...args);
        },
    };
    const atomic = load("src/common/atomic-json.ts", { fs: injected });
    const defaults = { "$schema-version": 1, "normal.language": "zh-CN", "normal.checkUpdate": false };
    const manager = { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (_name, patch) => notices.push(patch) } }] };
    const make = () => load("src/shared/app-config/main.ts", {
        electron: { app: { getPath: () => folder }, ipcMain: { handle: (name, fn) => handlers.set(name, fn) } },
        "@/common/atomic-json": atomic, "@shared/app-config/default-app-config": defaults,
        "@shared/logger/main": { logError: (...args) => errors.push(args), logInfo() {} },
    }).default;
    try {
        let config = make(); await config.setup(manager);
        assert.equal(config.setConfig({ "normal.language": "en-US" }), true);
        assert.equal(config.setConfig({ "download.path": "D:\\Music" }), true);
        const before = fs.readFileSync(file, "utf8"), value = config.getAllConfig(), notified = notices.length;
        for (fault of ["write", "flush", "rename"]) {
            const reply = handlers.get("@shared/app-config/set-app-config")(null, { "normal.language": "broken" });
            assert.equal(reply.success, false);
            assert.equal(fs.readFileSync(file, "utf8"), before);
            assert.equal(config.getAllConfig(), value); assert.equal(notices.length, notified);
            assert(!fs.existsSync(file + ".tmp")); assert(!fs.existsSync(file + ".bak.tmp"));
            assert.equal(atomic.parseConfigJSON(fs.readFileSync(file + ".bak", "utf8"))["normal.language"], "en-US");
        }
        fault = undefined;
        assert.equal(config.setConfig(null), false); assert.equal(config.setConfig([]), false);
        assert.equal(config.setConfig(JSON.parse("{\"__proto__\":{}}")), false);
        config.onConfigUpdated(() => {
            throw new Error("Subscriber failure after commit");
        });
        assert.equal(config.setConfig({ "normal.language": "zh-TW" }), true);
        assert.equal(JSON.parse(fs.readFileSync(file, "utf8"))["normal.language"], "zh-TW");
        fs.writeFileSync(file + ".tmp", "{\"normal.language\":");
        config = make(); await config.setup(manager);
        assert.equal(config.getConfig("normal.language"), "zh-TW", "Interrupted temporary write must not override committed state");
        fs.writeFileSync(file, "{truncated");
        fault = "rename";
        config = make(); await config.setup(manager);
        assert.equal(config.getConfig("normal.language"), "en-US", "Readable backup must remain usable even if main-file repair fails");
        assert.equal(config.setConfig({ "normal.language": "en-US" }), false, "Failed repair cannot be acknowledged as a saved setting");
        fault = undefined;
        config = make(); await config.setup(manager);
        assert.equal(config.getConfig("normal.language"), "en-US", "Valid previous backup must be recovered");
        assert.equal(JSON.parse(fs.readFileSync(file, "utf8"))["normal.language"], "en-US");
        fault = "write"; const old = config.getAllConfig(); assert.equal(config.reset(), false); assert.equal(config.getAllConfig(), old);
        fault = undefined; assert.equal(config.reset(), true);
        assert.equal(config.getConfig("download.path"), undefined);
        assert(Object.hasOwn(notices.at(-1), "download.path")); assert.equal(notices.at(-1)["download.path"], undefined);
        for (const raw of ["null", "[]", "\"string\"", "{broken"]) {
            assert.throws(() => atomic.parseConfigJSON(raw));
        }
        fs.writeFileSync(file, JSON.stringify({ normal: { language: "en-US", closeBehavior: "exit" }, download: { path: "E:\\Legacy" } }));
        config = make(); await config.setup(manager);
        assert.equal(config.getConfig("$schema-version"), 1);
        assert.equal(config.getConfig("normal.closeBehavior"), "exit_app");
        assert.equal(config.getConfig("download.path"), "E:\\Legacy");
        const legacy = JSON.stringify({ normal: { language: "en-US", closeBehavior: "exit" }, download: { path: "E:\\Legacy" } });
        fs.writeFileSync(file, legacy); fault = "write";
        config = make(); await config.setup(manager);
        assert.equal(config.getConfig("normal.language"), "en-US", "Failed migration keeps legacy settings usable");
        assert.equal(config.getConfig("download.path"), "E:\\Legacy");
        assert.equal(fs.readFileSync(file, "utf8"), legacy, "Failed migration preserves the legacy file");
        const legacyView = config.getAllConfig();
        assert.equal(config.setConfig({ "normal.language": "zh-CN" }), false);
        assert.equal(config.getAllConfig(), legacyView);
        fault = undefined;
        assert.equal(config.setConfig({ "normal.maxHistoryLength": 20 }), true);
        assert.equal(JSON.parse(fs.readFileSync(file, "utf8"))["normal.language"], "en-US");
        assert(errors.length >= 6);
        console.log("PASS: actual Windows atomic replace/restart/backup recovery; injected ENOSPC, EIO and EACCES preserve disk/cache, failed reset, invalid IPC and subscriber isolation");
    } finally {
        fs.rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
})().catch(error => {
    console.error(error); process.exitCode = 1;
});
