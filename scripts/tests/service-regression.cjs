const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const { fork } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const vm = require("node:vm");
const fs = require("node:fs");
const { load, root } = require("./source-loader.cjs");

function lifecycle() {
    const children = [], timers = new Map(), hosts = [];
    const originalSet = global.setTimeout, originalClear = global.clearTimeout;
    let timerId = 0;
    global.setTimeout = (fn, delay) => {
        const id = ++timerId; timers.set(id, { fn, delay }); return id;
    };
    global.clearTimeout = id => timers.delete(id);
    const { TestService } = load("src/shared/service-manager/main.ts", {
        child_process: { fork: (_file, _args, options) => {
            const child = new EventEmitter(); child.killed = false;
            child.kill = () => {
                child.killed = true;
            };
            child.token = options?.env.MUSICFREE_FORWARDER_TOKEN;
            children.push(child); return child;
        } }, electron: { app: {}, ipcMain: {} },
        "@shared/service-manager/common": {}, "@/common/get-resource-path": name => name,
    }, "\nexport { ServiceInstance as TestService };");
    try {
        const service = new TestService("test", "test");
        service.onHostChange(host => hosts.push(host));
        service.stop(); service.stop(); // stop before start must be harmless
        service.start(); service.start(); assert.equal(children.length, 1);
        children[0].emit("message", { type: "port", port: 1234 });
        assert.equal(new URL(hosts.at(-1)).searchParams.get("token"), children[0].token);
        children[0].emit("error", new Error("failed"));
        children[0].emit("exit", 1);
        assert.equal(hosts.at(-1), null); assert.equal(timers.size, 1);
        const retry = [...timers.values()][0]; timers.clear(); retry.fn();
        assert.equal(children.length, 2);
        assert.notEqual(children[0].token, children[1].token);
        children[0].emit("message", { type: "port", port: 9999 });
        assert.equal(hosts.at(-1), null);
        children[1].emit("message", { type: "port", port: 1235 });
        children[1].emit("exit", 1);
        assert.equal([...timers.values()][0].delay, 6000);
        service.stop(); assert.equal(timers.size, 0);
        retry.fn(); assert.equal(children.length, 2); // even an already queued callback cannot revive a stopped service
        service.start(); assert.equal(children.length, 3);
        service.stop(); assert.ok(children[2].killed);
    } finally {
        global.setTimeout = originalSet; global.clearTimeout = originalClear;
    }
}

(async () => {
    lifecycle();
    // Verify the explicit bind address using the real server source.
    let bind;
    vm.runInNewContext(fs.readFileSync(path.join(root, "res/.service/request-forwarder.js"), "utf8"), {
        require: name => name === "http" ? { createServer: () => ({ on() {}, listen: (...args) => {
            bind = args;
        } }) } : require(name),
        process: { env: { MUSICFREE_FORWARDER_TOKEN: "test", MUSICFREE_FORWARDER_PORT: "0" }, once() {} },
        URL, Buffer,
    });
    assert.equal(bind[1], "127.0.0.1");
    let child, target;
    const token = "test-session-" + Date.now();
    try {
        const seen = [];
        target = http.createServer((req, res) => {
            seen.push(req.headers);
            if (req.url === "/broken") {
                res.writeHead(200); res.write("partial"); setTimeout(() => res.destroy(), 10); return;
            }
            res.writeHead(206, { "Content-Type": "audio/mpeg" }); res.end("audio-body");
        });
        await new Promise(resolve => target.listen(0, "127.0.0.1", resolve));
        child = fork(path.join(root, "res/.service/request-forwarder.js"), [], {
            env: { ...process.env, MUSICFREE_FORWARDER_TOKEN: token, MUSICFREE_FORWARDER_PORT: "0" },
            stdio: ["ignore", "ignore", "inherit", "ipc"],
        });
        const port = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Forwarder did not start")), 10000);
            child.once("error", reject);
            child.once("exit", code => {
                clearTimeout(timer); reject(new Error("Child exited " + code));
            });
            child.on("message", msg => {
                if (msg.type === "port") {
                    clearTimeout(timer); resolve(msg.port);
                }
            });
        });
        const base = "http://127.0.0.1:" + port;
        const makeURL = (url, params = {}) => {
            const u = new URL(base); u.searchParams.set("token", token);
            if (url) u.searchParams.set("url", url);
            for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
            return u;
        };
        assert.equal((await fetch(base)).status, 403);
        assert.equal((await fetch(makeURL(null, { token: "wrong" }))).status, 403);
        for (const url of ["not-a-url", "file:///etc/passwd", "ftp://example.test/file"]) {
            assert.equal((await fetch(makeURL(url))).status, 400);
        }
        const upstream = "http://127.0.0.1:" + target.address().port;
        assert.equal((await fetch(makeURL(upstream, { headers: "[]" }))).status, 400);
        assert.equal((await fetch(makeURL(upstream, { headers: "{" }))).status, 400);
        assert.equal((await fetch(makeURL(upstream, { headers: JSON.stringify({ X: "bad\r\nvalue" }) }))).status, 400);
        assert.equal((await fetch(makeURL(upstream, { method: "POST" }))).status, 405);
        const result = await fetch(makeURL(upstream, { headers: JSON.stringify({ Authorization: "Basic test", Host: "wrong.test" }) }), {
            headers: { Range: "bytes=0-9", Cookie: "private-cookie", Origin: "https://foreign.test" },
        });
        assert.equal(result.status, 206); assert.equal(await result.text(), "audio-body");
        assert.equal(seen.at(-1).host, new URL(upstream).host);
        assert.equal(seen.at(-1).authorization, "Basic test");
        assert.equal(seen.at(-1).range, "bytes=0-9");
        assert.equal(seen.at(-1).cookie, undefined); assert.equal(seen.at(-1).origin, undefined);
        const broken = await fetch(makeURL(upstream + "/broken"));
        await assert.rejects(() => broken.text());
        const closedPort = target.address().port; await new Promise(resolve => target.close(resolve)); target = null;
        assert.equal((await fetch(makeURL("http://127.0.0.1:" + closedPort))).status, 502);
        assert.equal((await fetch(base + "/heartbeat?token=" + token)).status, 200);
        console.log("PASS: service restart/stop/backoff and real HTTP loopback authorization, invalid inputs, headers, stream errors");
    } finally {
        child?.kill();
        if (target) {
            target.closeAllConnections(); await new Promise(resolve => target.close(resolve));
        }
    }
})().catch(error => {
    console.error(error); process.exitCode = 1;
});
