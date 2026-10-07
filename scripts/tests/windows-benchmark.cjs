/* Full shipped EXE, fresh processes, isolated profiles; no production data or registry writes. */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../..");
const source = path.resolve(process.argv[2]);
const label = process.argv[3];
const sampleCount = Number(process.argv[4] || 20);
const comparisonSource = process.argv[5] ? path.resolve(process.argv[5]) : null;
const verificationOnly = process.argv.includes("--verification-only");
const legacy = process.argv.includes("--legacy");
assert(!legacy || verificationOnly);
const workloads = verificationOnly ? ["library10000"] : ["empty", "library10000"];
assert.equal(process.platform, "win32", "Use Windows Node");
assert(/^[a-z0-9-]+$/.test(label), "Specify a simple result label");
assert(Number.isInteger(sampleCount) && sampleCount >= 2 && sampleCount <= 100);
assert(fs.existsSync(path.join(source, "MusicFree.exe")));
const output = path.join(root, "out/windows-validation", label + "-" + Date.now());
fs.mkdirSync(output, { recursive: true });
function inventory(directory) {
    const files = [];
    function visit(base) {
        for (const item of fs.readdirSync(base, { withFileTypes: true })) {
            if (item.name === "portable") continue;
            const file = path.join(base, item.name);
            if (item.isDirectory()) visit(file);
            else if (item.isFile()) files.push({ path: path.relative(directory, file).replaceAll("\\", "/"), bytes: fs.statSync(file).size });
        }
    }
    visit(directory);
    return { bytes: files.reduce((total, file) => total + file.bytes, 0), files };
}
const variants = {};
for (const [name, directory] of Object.entries(comparisonSource ? { baseline: source, candidate: comparisonSource } : { baseline: source })) {
    const artifact = inventory(directory);
    const copied = path.join(output, "package-" + name);
    fs.cpSync(directory, copied, { recursive: true, filter: file => path.basename(file) !== "portable" });
    const appRoot = path.join(copied, "resources/app");
    const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
    assert.equal(pkg.main, ".webpack/main", "Unexpected shipped entry point");
    fs.mkdirSync(path.join(appRoot, ".validation"));
    fs.copyFileSync(path.join(__dirname, "windows-benchmark-probe.cjs"), path.join(appRoot, ".validation/probe.cjs"));
    pkg.main = ".validation/probe.cjs";
    fs.writeFileSync(path.join(appRoot, "package.json"), JSON.stringify(pkg));
    variants[name] = { source: directory, copied, artifact, scenarios: Object.fromEntries(workloads.map(name => [name, []])) };
}
const downloads = path.join(output, "fixtures"); fs.mkdirSync(downloads);
const wav = Buffer.alloc(44 + 32000 * 2);
wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
const sha256 = crypto.createHash("sha256").update(wav).digest("hex");
const songs = Array.from({ length: 10000 }, (_, index) => {
    const file = path.join(downloads, "song-" + (index % 1000) + ".wav");
    if (index < 1000) fs.writeFileSync(file, wav);
    const song = { platform: "本地", id: "benchmark-" + index, title: "benchmark song " + index,
        artist: "benchmark artist " + index % 100, album: "benchmark album " + index % 500,
        duration: 2, localPath: file, url: file, "$$ref": 1 };
    if (index < 1000) {
        const stat = fs.statSync(file);
        song.$ = { downloadData: { path: file, quality: "standard", fingerprint: { size: stat.size, sha256, mtimeMs: stat.mtimeMs },
            verified: { version: 1, path: file, directory: downloads, state: "AVAILABLE", checkedAt: Date.now() } } };
        if (legacy) {
            delete song.$.downloadData.fingerprint; delete song.$.downloadData.verified;
        }
    }
    return song;
});
const seed = path.join(output, "seed.json"); fs.writeFileSync(seed, JSON.stringify(songs));
fs.writeFileSync(path.join(output, "empty.json"), "[]");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let sequence = 0;
async function run(copied, profile, options = {}) {
    const runDirectory = path.join(output, "run-" + ++sequence); fs.mkdirSync(runDirectory);
    const spec = { profile, downloads, ...options, ready: path.join(runDirectory, "ready.json"), result: path.join(runDirectory, "result.json"),
        metricsReady: path.join(runDirectory, "metrics-ready"), metricsDone: path.join(runDirectory, "process-metrics.json"),
        verificationOnly: verificationOnly && !options.seed, legacy, verificationDone: path.join(runDirectory, "verification.json") };
    const specPath = path.join(runDirectory, "spec.json"); fs.writeFileSync(specPath, JSON.stringify(spec));
    const started = process.hrtime.bigint();
    const child = spawn(path.join(copied, "MusicFree.exe"), [], { env: { ...process.env, MUSICFREE_BENCH_SPEC: specPath }, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [], stderr = [];
    child.stdout.on("data", bytes => {
        stdout.push(bytes);
        if (spec.verificationOnly && !fs.existsSync(spec.verificationDone)) {
            const matched = Buffer.concat(stdout).toString().match(/Startup download verification\s+(\{[^\r\n]*\})/);
            if (matched) {
                const result = JSON.parse(matched[1]);
                if (result.records === 1000 && Number.isFinite(result.durationMs)) fs.writeFileSync(spec.verificationDone, JSON.stringify(result));
            }
        }
    }); child.stderr.on("data", bytes => stderr.push(bytes));
    const completion = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
    let startupMs;
    const timer = setTimeout(() => child.kill(), 95000);
    try {
        while (!fs.existsSync(spec.ready)) {
            if (child.exitCode !== null || child.signalCode) throw new Error("EXE exited before ready");
            await wait(10);
        }
        startupMs = Number(process.hrtime.bigint() - started) / 1e6;
        if (!options.seed && !verificationOnly) {
            while (!fs.existsSync(spec.metricsReady)) {
                assert(child.exitCode === null && !child.signalCode, "EXE exited before metrics");
                await wait(10);
            }
            const raw = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File",
                path.join(__dirname, "windows-process-metrics.ps1"), "-RootProcessIdentifier", String(child.pid)], { encoding: "utf8", timeout: 20000 });
            const metrics = JSON.parse(raw.replace(/^\uFEFF/, ""));
            assert(metrics.processCount > 1 && metrics.workingSetBytes > 0 && metrics.privateBytes > 0);
            fs.writeFileSync(spec.metricsDone, JSON.stringify(metrics));
        }
        const exit = await completion;
        assert.equal(exit.code, 0, Buffer.concat(stderr).toString());
        const result = JSON.parse(fs.readFileSync(spec.result, "utf8"));
        assert(result.passed, result.error);
        return { startupMs, ...result };
    } finally {
        clearTimeout(timer);
        if (child.exitCode === null && !child.signalCode) child.kill();
        fs.writeFileSync(path.join(runDirectory, "stdout.log"), Buffer.concat(stdout));
        fs.writeFileSync(path.join(runDirectory, "stderr.log"), Buffer.concat(stderr));
    }
}
function quantile(values, fraction) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}
function summarize(runs) {
    const metrics = verificationOnly ? { verificationMs: runs.map(run => run.verificationMs) } : { startupMs: runs.map(run => run.startupMs),
        workingSetMiB: runs.map(run => run.processMetrics.workingSetBytes / 1048576),
        privateMiB: runs.map(run => run.processMetrics.privateBytes / 1048576),
        handles: runs.map(run => run.processMetrics.handles),
        settleCpuPercentOneCore: runs.map(run => run.processMetrics.cpuPercentOneCore) };
    for (const operation of ["searchMs", "clearSearchMs", "selectAllMs", "clearSelectionMs"]) {
        if (runs[0].operations) metrics[operation] = runs.flatMap(run => run.operations[operation]);
    }
    return Object.fromEntries(Object.entries(metrics).map(([name, values]) => [name,
        { samples: values.length, median: quantile(values, .5), p95: quantile(values, .95), min: Math.min(...values), max: Math.max(...values) }]));
}
(async () => {
    const profiles = {};
    for (const [variantName, variant] of Object.entries(variants)) {
        profiles[variantName] = {};
        for (const name of Object.keys(variant.scenarios)) {
            const profile = path.join(output, "profiles", variantName, name); profiles[variantName][name] = profile;
            fs.mkdirSync(path.join(profile, "userData"), { recursive: true });
            fs.writeFileSync(path.join(profile, "userData/config.json"), JSON.stringify({ "$schema-version": 1,
                "normal.checkUpdate": false, "normal.language": "zh-CN", "normal.closeBehavior": "exit_app",
                "normal.builtinTheme": "jiangnan", "plugin.autoUpdatePlugin": false, "download.path": downloads,
                "private.mainWindowSize": { width: 1200, height: 860 } }));
            await run(variant.copied, profile, { seed: name === "empty" ? path.join(output, "empty.json") : seed });
        }
    }
    // Warm the requested library route as well as the profile; retain warmup
    // samples separately rather than silently dropping measured outliers.
    const warmups = [];
    for (let round = 0; round < 2; round++) {
        const order = Object.keys(variants); if (round % 2) order.reverse();
        for (const name of workloads) for (const variantName of order) {
            warmups.push({ variant: variantName, workload: name,
                result: await run(variants[variantName].copied, profiles[variantName][name], { library: name !== "empty" }) });
        }
    }
    for (let index = 0; index < sampleCount; index++) {
        const order = Object.keys(variants);
        if (index % 2) order.reverse();
        for (const name of workloads) {
            for (const variantName of order) {
                const variant = variants[variantName];
                const measured = await run(variant.copied, profiles[variantName][name], { library: name !== "empty" });
                variant.scenarios[name].push(measured);
                console.log(`${label} ${variantName} ${name} ${index + 1}/${sampleCount}: ${(verificationOnly ? measured.verificationMs : measured.startupMs).toFixed(1)} ms`);
            }
        }
    }
    for (const variant of Object.values(variants)) {
        variant.summary = Object.fromEntries(Object.entries(variant.scenarios).map(([name, runs]) => [name, summarize(runs)]));
    }
    const report = { passed: true, methodVersion: verificationOnly ? legacy ? 4 : 3 : 5, verificationOnly, legacy,
        warmupRunsPerVariantPerScenario: 2, warmups, label, recordedAt: new Date().toISOString(), source,
        sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
        node: process.version, host: { platform: process.platform, release: os.release(), architecture: os.arch(), cpu: os.cpus()[0].model, cpuCount: os.cpus().length, totalMemoryMiB: os.totalmem() / 1048576 },
        fixture: { metadataRecords: 10000, downloadedRecords: 1000, files: 1000, bytesPerFile: wav.length, hardLinks: false, validSilentWav: true, fingerprints: !legacy, covers: false },
        method: verificationOnly ? "Real copied MusicFree.exe and unmodified shipped main/preload/renderer; each fresh process waits for the product's completion log of the first full 1000-file startup verification; durationMs includes watcher setup and all baseline batches. Alternating paired runs. Legacy inputs are restored in real IndexedDB after timing, before process exit." : "Real copied MusicFree.exe, fresh process per sample, cached disk, warm isolated persisted profile; package entry redirects to instrumentation which intercepts protocol registration then loads unmodified shipped main/preload/renderer; startup measured by external parent until interactive UI readiness file (10ms polling)",
        limitations: verificationOnly ? "Cached filesystem; synthetic metadata and 1000 distinct WAV files; no cover art, playback, online plugins, process-resource or input-latency measurements. Does not time a subsequent watcher-ready compensation pass. Cached and legacy SHA-migration workloads have separate controls/protocols." : "Not filesystem-cold boot; synthetic metadata/WAV without cover art or online plugins; operation times include two-frame rendering acknowledgement; PID plus process-creation-time verified tree metrics after 1.5s settle plus CIM query and 1s CPU interval; Electron subset metrics also retained",
        artifact: variants.baseline.artifact, sampleCount, summary: variants.baseline.summary,
        scenarios: variants.baseline.scenarios, variants };
    fs.writeFileSync(path.join(output, "benchmark.json"), JSON.stringify(report, null, 2) + "\n");
    console.log("BENCHMARK_FILE", path.join(output, "benchmark.json"));
})().catch(error => {
    console.error(error.stack); process.exitCode = 1;
});
