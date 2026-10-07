const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { layout, metadata } = require("./build-info.cjs");

const build = layout();
if (process.argv[2]) {
    const resourcePath = path.relative(build.directory, build.resources);
    const executablePath = path.relative(build.directory, build.executable);
    build.directory = path.resolve(process.argv[2]);
    build.resources = path.join(build.directory, resourcePath);
    build.executable = path.join(build.directory, executablePath);
}
const info = metadata();
fs.writeFileSync(path.join(build.directory, "build-info.json"), JSON.stringify(info, null, 2) + "\n");
const result = spawnSync(build.executable, [path.join(__dirname, "verify-runtime.cjs"), build.resources], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1",
        ...(process.platform === "win32" ? { PATH: path.join(process.env.SystemRoot, "System32") + ";" + process.env.SystemRoot } : {}) },
    encoding: "utf8", timeout: 60000,
});
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status || 1;
