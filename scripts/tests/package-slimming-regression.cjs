const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { trimSharpDlls } = require("../ci/trim-sharp-dlls.cjs");

(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "musicfree-sharp-dll-"));
    try {
        const sharp = path.join(root, "node_modules/sharp");
        const vendor = path.join(sharp, "vendor/8.14.5/win32-x64/lib");
        const runtime = path.join(sharp, "build/Release");
        await fs.mkdir(vendor, { recursive: true }); await fs.mkdir(runtime, { recursive: true });
        for (const [name, original, installed] of [
            ["identical.dll", "same bytes", "same bytes"],
            ["different.dll", "left", "rght"],
            ["missing.dll", "keep", null],
        ]) {
            await fs.writeFile(path.join(vendor, name), original);
            if (installed) await fs.writeFile(path.join(runtime, name), installed);
        }
        await fs.writeFile(path.join(vendor, "LICENSE.txt"), "license");
        assert.deepEqual(await trimSharpDlls(root, "linux", "x64"), { files: 0, bytes: 0 });
        const result = await trimSharpDlls(root, "win32", "x64");
        assert.deepEqual(result, { files: 1, bytes: 10 });
        assert.deepEqual((await fs.readdir(vendor)).sort(), ["LICENSE.txt", "different.dll", "missing.dll"]);
        assert.equal(await fs.readFile(path.join(runtime, "identical.dll"), "utf8"), "same bytes");
        assert.deepEqual(await trimSharpDlls(root, "win32", "x64"), { files: 0, bytes: 0 });
        // Benchmark acceptance must reject a slowdown even when bytes decrease.
        const sample = { startupMs: 100, processMetrics: { workingSetBytes: 1048576,
            privateBytes: 1048576, handles: 10, cpuPercentOneCore: 0 } };
        const summary = { startupMs: { median: 100, p95: 100 }, workingSetMiB: { median: 1, p95: 1 },
            privateMiB: { median: 1, p95: 1 }, handles: { median: 10, p95: 10 }, settleCpuPercentOneCore: { median: 0, p95: 0 } };
        const variant = () => ({ source: "original", artifact: { bytes: 100 },
            scenarios: { empty: Array(20).fill(sample), library10000: Array(20).fill(sample) },
            summary: { empty: structuredClone(summary), library10000: structuredClone(summary) } });
        const control = { passed: true, sampleCount: 20, host: { cpu: "fixture", release: "fixture" },
            variants: { baseline: variant(), candidate: variant() } };
        const controlFile = path.join(root, "control.json"); await fs.writeFile(controlFile, JSON.stringify(control));
        for (const slow of [false, true]) {
            const compared = structuredClone(control);
            compared.variants.candidate.source = "trimmed";
            compared.variants.candidate.artifact.bytes = 50;
            if (slow) {
                compared.variants.candidate.scenarios.empty = compared.variants.candidate.scenarios.empty.map(run => ({ ...run, startupMs: run.startupMs + 1 }));
                compared.variants.candidate.summary.empty.startupMs.median++;
                compared.variants.candidate.summary.empty.startupMs.p95++;
            }
            const comparisonFile = path.join(root, "comparison.json"), resultFile = path.join(root, "gate.json");
            await fs.writeFile(comparisonFile, JSON.stringify(compared));
            const checked = spawnSync(process.execPath, [path.join(__dirname, "benchmark-gate.cjs"), controlFile, comparisonFile, resultFile], { encoding: "utf8" });
            assert.equal(checked.status, slow ? 1 : 0, checked.stderr);
            assert.equal(JSON.parse(await fs.readFile(resultFile, "utf8")).passed, !slow);
        }
        const mismatched = { ...control, methodVersion: 2 };
        const mismatchFile = path.join(root, "mismatched.json");
        await fs.writeFile(mismatchFile, JSON.stringify(mismatched));
        const rejected = spawnSync(process.execPath, [path.join(__dirname, "benchmark-gate.cjs"), controlFile, mismatchFile, path.join(root, "mismatch-gate.json")], { encoding: "utf8" });
        assert.equal(rejected.status, 1); assert(rejected.stderr.includes("same warmup protocol"));
        const verification = structuredClone(control); verification.methodVersion = 3;
        for (const item of Object.values(verification.variants)) {
            item.scenarios = { library10000: Array(20).fill({ verificationMs: 100 }) };
            item.summary = { library10000: { verificationMs: { median: 100, p95: 100 } } };
        }
        await fs.writeFile(controlFile, JSON.stringify(verification));
        const slowerVerification = structuredClone(verification);
        slowerVerification.variants.candidate.artifact.bytes = 50;
        slowerVerification.variants.candidate.scenarios.library10000 = Array(20).fill({ verificationMs: 101 });
        slowerVerification.variants.candidate.summary.library10000.verificationMs = { median: 101, p95: 101 };
        await fs.writeFile(mismatchFile, JSON.stringify(slowerVerification));
        const slowResult = path.join(root, "verification-gate.json");
        const slower = spawnSync(process.execPath, [path.join(__dirname, "benchmark-gate.cjs"), controlFile, mismatchFile, slowResult], { encoding: "utf8" });
        assert.equal(slower.status, 1); assert.equal(JSON.parse(await fs.readFile(slowResult, "utf8")).passed, false);
        // A new control may be noisier, but cannot raise an already frozen budget.
        const noisyControl = structuredClone(verification);
        for (const [name, item] of Object.entries(noisyControl.variants)) {
            const sign = name === "baseline" ? 1 : -1;
            item.scenarios.library10000 = item.scenarios.library10000.map((run, index) => ({ verificationMs: 100 + sign * (index % 2 ? 20 : -20) }));
        }
        await fs.writeFile(controlFile, JSON.stringify(noisyControl));
        const ceilingFile = path.join(root, "ceiling.json");
        await fs.writeFile(ceilingFile, JSON.stringify({ gates: ["median", "p95"].map(statistic => ({
            workload: "library10000", metric: "verificationMs", statistic, naturalNoiseUpper: 0,
        })) }));
        const tightened = spawnSync(process.execPath, [path.join(__dirname, "benchmark-gate.cjs"), controlFile, mismatchFile, slowResult, ceilingFile], { encoding: "utf8" });
        assert.equal(tightened.status, 1);
        const cappedGates = JSON.parse(await fs.readFile(slowResult, "utf8")).gates;
        assert(cappedGates.every(gate => gate.naturalNoiseUpper === 0));
        assert(cappedGates.some(gate => gate.calibratedNaturalNoiseUpper > 0));
        if (process.platform === "win32") {
            const snapshotFile = path.join(root, "processes.json");
            const old = "2026-10-07T00:00:00Z", current = "2026-10-07T00:10:00Z", later = "2026-10-07T00:11:00Z";
            await fs.writeFile(snapshotFile, JSON.stringify([
                { ProcessId: 10, ParentProcessId: 1, CreationDate: current },
                { ProcessId: 11, ParentProcessId: 10, CreationDate: old },
                { ProcessId: 12, ParentProcessId: 10, CreationDate: later },
                { ProcessId: 13, ParentProcessId: 12, CreationDate: later },
                { ProcessId: 14, ParentProcessId: 11, CreationDate: later },
            ]));
            const literal = value => "'" + value.replaceAll("'", "''") + "'";
            const command = ". " + literal(path.join(__dirname, "windows-process-tree.ps1")) +
                "; $rows=Get-Content -Raw " + literal(snapshotFile) + " | ConvertFrom-Json; @(Get-ProcessTreeSnapshot $rows 10 | Select-Object -ExpandProperty ProcessId | Sort-Object) | ConvertTo-Json -Compress";
            const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], { encoding: "utf8" });
            assert.equal(result.status, 0, result.stderr);
            assert.deepEqual(JSON.parse(result.stdout.replace(/^\uFEFF/, "")), [10, 12, 13], "Reused parent PID must not admit old processes or their descendants");
        }
        console.log("PASS: packaged Sharp dedup preserves runtime DLLs, mismatches, missing counterparts, metadata and other platforms; idempotent");
        console.log("PASS: benchmark gate accepts unchanged metrics and rejects slowdown despite smaller package");
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
})().catch(error => {
    console.error(error); process.exitCode = 1;
});
