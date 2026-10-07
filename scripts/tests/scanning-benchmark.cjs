/* Actual WAV metadata reads; same-process alternating A/A and A/B, separate from EXE benchmark. */
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { execFileSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { load, root } = require("./source-loader.cjs");
const label = process.argv[2];
assert(/^[a-z0-9-]+$/.test(label));
const output = path.join(root, "out/windows-validation", label + "-" + Date.now());
fs.mkdirSync(output, { recursive: true });
const folder = path.join(output, "songs"); fs.mkdirSync(folder);
const wav = Buffer.alloc(44 + 32000 * 2);
wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
for (let i = 0; i < 1000; i++) fs.writeFileSync(path.join(folder, "song-" + i + ".WAV"), wav);
const baseline = path.join(output, "baseline.ts"), candidate = path.join(output, "candidate.ts");
fs.writeFileSync(baseline, execFileSync("git", ["show", "HEAD:src/common/file-util.ts"], { cwd: root }));
fs.copyFileSync(path.join(root, "src/common/file-util.ts"), candidate);
const constants = load("src/common/constant.ts");
const queue = load("src/common/task-queue.ts").default;
const supported = load("src/common/local-media.ts", { "./constant": constants });
const quantile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
(async () => {
    const metadata = await import("music-metadata");
    async function run(source) {
        let active = 0, peak = 0, maxTimerDelayMs = 0;
        const util = load(path.relative(root, source), { "./constant": constants, "./local-media": supported, "./task-queue": queue,
            "music-metadata": { ...metadata, parseFile: async (...args) => {
                ++active; peak = Math.max(peak, active);
                try {
                    return await metadata.parseFile(...args);
                } finally {
                    --active;
                }
            } } });
        let last = performance.now();
        const timer = setInterval(() => {
            const now = performance.now(); maxTimerDelayMs = Math.max(maxTimerDelayMs, now - last - 5); last = now;
        }, 5);
        const start = performance.now();
        try {
            const songs = await util.parseLocalMusicItemFolder(folder);
            const durationMs = performance.now() - start;
            assert.equal(songs.length, 1000); assert(songs.every(song => song.duration === 2));
            return { durationMs, maxTimerDelayMs, peakMetadataReads: peak };
        } finally {
            clearInterval(timer);
        }
    }
    await run(baseline); await run(candidate); // unmeasured filesystem/parser warmup
    const calibration = [], comparison = [];
    for (const [name, destination] of [["AA", calibration], ["AB", comparison]]) {
        for (let i = 0; i < 20; i++) {
            let a, b;
            if (i % 2) {
                b = await run(name === "AA" ? baseline : candidate); a = await run(baseline);
            } else {
                a = await run(baseline); b = await run(name === "AA" ? baseline : candidate);
            }
            destination.push({ baseline: a, candidate: b });
            console.log(name, i + 1, a.durationMs.toFixed(1), b.durationMs.toFixed(1));
        }
    }
    let seed = 20261006;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    const gates = [];
    for (const metric of ["durationMs", "maxTimerDelayMs"]) {
        for (const [statistic, fraction] of [["median", .5], ["p95", .95]]) {
            const noise = [];
            for (let repeat = 0; repeat < 5000; repeat++) {
                const left = [], right = [];
                for (let i = 0; i < 20; i++) {
                    const pair = calibration[Math.floor(random() * 20)], swap = random() < .5;
                    left.push(pair[swap ? "candidate" : "baseline"][metric]);
                    right.push(pair[swap ? "baseline" : "candidate"][metric]);
                }
                noise.push(quantile(right, fraction) - quantile(left, fraction));
            }
            const before = quantile(comparison.map(pair => pair.baseline[metric]), fraction);
            const after = quantile(comparison.map(pair => pair.candidate[metric]), fraction);
            const allowance = Math.max(0, quantile(noise, .975));
            gates.push({ metric, statistic, baseline: before, candidate: after, naturalNoiseUpper: allowance, passed: after - before <= allowance });
        }
    }
    const report = { passed: gates.every(gate => gate.passed), host: { platform: os.platform(), release: os.release(), cpu: os.cpus()[0].model },
        fixture: { files: 1000, bytesPerFile: wav.length, realWav: true, artwork: false }, calibration, comparison, gates,
        method: "20 alternating pairs each A/A and A/B in Windows Node, warm files and parsers; duration until all actual metadata results validated; 5ms timer delay in that Node process. Same bootstrap noise rule as EXE gate.",
        limitations: "Not packaged renderer/UI, not cold disk; metadata without cover art; concurrency measured at parseFile boundary, not kernel FD count." };
    fs.writeFileSync(path.join(output, "benchmark.json"), JSON.stringify(report, null, 2));
    console.log("BENCHMARK_FILE", path.join(output, "benchmark.json")); console.log(gates);
    if (!report.passed) process.exitCode = 1;
})().catch(error => {
    console.error(error); process.exitCode = 1;
});
