const assert = require("node:assert/strict");
const { load, deferred } = require("./source-loader.cjs");

(async () => {
    // The system thumbnail must retain B even when A arrives later or a window closes.
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
        const slow = deferred(), calls = [], errors = [], requests = [];
        const native = { config() {}, sendIconicRepresentation: (_hwnd, _size, bytes) => calls.push(bytes.toString()) };
        const manager = load("src/common/thumb-bar-util.ts", {
            electron: {}, "@/common/get-resource-path": () => "default", "@shared/i18n/main": {},
            "@/common/constant": { ResourceName: {} }, "@/common/async-memoize": fn => fn,
            "fs/promises": { readFile: async () => Buffer.from("default") },
            "@shared/logger/main": { logError: (...args) => errors.push(args) }, "@shared/message-bus/main": {},
            axios: { get: (url, options) => {
                requests.push(options.signal); return url.endsWith("A") ? slow.promise : Promise.resolve({ data: Buffer.from(url.endsWith("bad") ? "bad" : "B") });
            } },
            "@native/TaskbarThumbnailManager/TaskbarThumbnailManager.node": native,
            sharp: bytes => {
                if (bytes.toString() === "bad") throw new Error("Invalid image"); const chain = { resize: () => chain, png: () => chain, ensureAlpha: () => chain, raw: () => chain,
                    toBuffer: async () => ({ data: bytes }) }; return chain;
            },
        }).default;
        let destroyed = false; let onClose;
        const win = { once: (_event, callback) => {
            onClose = callback;
        }, isDestroyed: () => destroyed, getNativeWindowHandle: () => {
            const value = Buffer.alloc(8); value.writeBigUInt64LE(1n); return value;
        } };
        const first = manager.setThumbImage(win, "http://test/A"); await new Promise(r => setImmediate(r));
        await manager.setThumbImage(win, "http://test/B");
        slow.resolve({ data: Buffer.from("A") }); await first;
        assert.deepEqual(calls, ["B"]); assert.equal(requests[0].aborted, true);
        await manager.setThumbImage(win, "http://test/bad");
        assert.deepEqual(calls, ["B", "default"]); assert.equal(errors.length, 1);
        destroyed = true; onClose(); assert.equal(requests.at(-1).aborted, true); await manager.setThumbImage(win, "http://test/B"); assert.deepEqual(calls, ["B", "default"]); assert.equal(errors.length, 1);
    } finally {
        Object.defineProperty(process, "platform", platform);
    }
    console.log("PASS: thumbnail A/B cancellation and destroyed-window guard");
})().catch(error => {
    console.error(error); process.exitCode = 1;
});
