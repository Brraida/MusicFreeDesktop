const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
process.chdir(root);
const group = process.argv[2];
if (!["node", "electron"].includes(group)) throw new Error("Specify node or electron");
const output = path.join(root, "out/ci-test-results");
fs.mkdirSync(output, { recursive: true });
const cases = group === "node"
    ? ["player", "service", "scanner", "audio", "store", "startup", "ci", "download-resource"].map(name => ({
        name: "node-" + name, args: ["scripts/tests/" + name + "-regression.cjs"],
    }))
    : [{ name: "electron-downloader", args: ["scripts/tests/downloader-main.cjs"] },
        ...["audio", "playlist", "startup", "relocation", "download-resource"].map(name => ({
            name: "electron-" + name, args: ["scripts/tests/electron-regression-main.cjs", name],
        }))];
const executable = group === "node" ? process.execPath : require("electron");
const results = [];
for (const test of cases) {
    console.log("Running " + test.name);
    const started = Date.now();
    const child = spawnSync(executable, test.args, {
        cwd: root, encoding: "utf8", timeout: 180000, maxBuffer: 10 * 1024 * 1024,
    });
    const log = (child.stdout || "") + (child.stderr || "") + (child.error ? "\n" + child.error.stack : "");
    fs.writeFileSync(path.join(output, test.name + ".log"), log);
    process.stdout.write(log);
    results.push({ name: test.name, passed: !child.error && child.status === 0,
        exitCode: child.status, signal: child.signal, durationMs: Date.now() - started });
}
fs.writeFileSync(path.join(output, group + "-results.json"), JSON.stringify(results, null, 2) + "\n");
if (results.some(test => !test.passed)) process.exitCode = 1;
