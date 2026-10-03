const http = require("http");
const https = require("https");
const { timingSafeEqual } = require("crypto");

// The owning main process generates a token for each service instance.
const sessionToken = process.env.MUSICFREE_FORWARDER_TOKEN;
if (!sessionToken) throw new Error("Missing forwarder session token");
const initialPort = Number(process.env.MUSICFREE_FORWARDER_PORT ?? 52735);
const maxRetries = 20;

function respond(res, status, message) {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) return res.destroy();
    res.writeHead(status, { "Content-Type": "text/plain" });
    res.end(message);
}

function authorized(token) {
    const supplied = Buffer.from(token || "");
    const expected = Buffer.from(sessionToken);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function forwardRequest(clientReq, clientRes, target, method, headers) {
    const transport = target.protocol === "https:" ? https : http;
    const upstream = transport.request(target, { method, headers }, response => {
        if (clientRes.destroyed) return response.destroy();
        clientRes.writeHead(response.statusCode, response.headers);
        response.on("error", () => respond(clientRes, 502, "Upstream response failed"));
        response.on("aborted", () => respond(clientRes, 502, "Upstream response aborted"));
        response.pipe(clientRes);
    });
    upstream.setTimeout(30000, () => upstream.destroy(new Error("Upstream timeout")));
    upstream.on("error", () => respond(clientRes, 502, "Upstream request failed"));
    clientReq.on("aborted", () => upstream.destroy());
    clientRes.on("close", () => upstream.destroy());
    upstream.end();
}

function startServer(port, retry = 0) {
    const server = http.createServer((req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        try {
            const incoming = new URL(req.url, "http://127.0.0.1");
            if (!authorized(incoming.searchParams.get("token"))) return respond(res, 403, "Forbidden");
            if (req.method !== "GET" && req.method !== "HEAD") {
                return respond(res, 405, "Only GET and HEAD requests are allowed");
            }
            if (incoming.pathname === "/heartbeat") return respond(res, 200, "OK");
            const target = new URL(incoming.searchParams.get("url"));
            if (target.protocol !== "http:" && target.protocol !== "https:") {
                return respond(res, 400, "Unsupported target protocol");
            }
            const method = (incoming.searchParams.get("method") || req.method).toUpperCase();
            if (method !== "GET" && method !== "HEAD") return respond(res, 405, "Unsupported target method");
            const suppliedHeaders = JSON.parse(incoming.searchParams.get("headers") || "{}");
            if (!suppliedHeaders || Array.isArray(suppliedHeaders) || typeof suppliedHeaders !== "object") {
                return respond(res, 400, "Invalid headers");
            }
            // Do not forward browser cookies, origin, or the local Host by default.
            const headers = {};
            for (const name of ["range", "if-range", "accept", "user-agent"]) {
                if (req.headers[name]) headers[name] = req.headers[name];
            }
            for (const [name, value] of Object.entries(suppliedHeaders)) {
                http.validateHeaderName(name);
                if (typeof value !== "string") throw new Error("Invalid header value");
                http.validateHeaderValue(name, value);
                const lower = name.toLowerCase();
                if (!["host", "connection", "content-length", "transfer-encoding", "upgrade",
                    "proxy-authorization", "proxy-connection"].includes(lower)) headers[lower] = value;
            }
            headers.host = target.host;
            forwardRequest(req, res, target, method, headers);
        } catch {
            respond(res, 400, "Invalid forwarding request");
        }
    });
    server.on("error", error => {
        if (error.code === "EADDRINUSE" && retry < maxRetries && port > 0) {
            startServer(port + 1, retry + 1);
        } else {
            process.send?.({ type: "error" });
            process.exitCode = 1;
        }
    });
    server.listen(port, "127.0.0.1", () => {
        process.send?.({ type: "port", port: server.address().port });
    });
    process.once("disconnect", () => server.close());
}

startServer(initialPort);
