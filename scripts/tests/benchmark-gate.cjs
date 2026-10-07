const fs = require("node:fs");
const assert = require("node:assert/strict");
const calibration = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const comparison = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const destination = process.argv[4];
// A corrected measurement protocol may tighten, but never relax, already frozen budgets.
const priorBudget = process.argv[5] ? JSON.parse(fs.readFileSync(process.argv[5], "utf8")) : undefined;
const priorKeys = new Set();
let seed = 20261006;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
function quantile(values, fraction) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}
function observations(run, metric) {
    if (metric === "startupMs") return [run.startupMs];
    if (metric === "verificationMs") return [run.verificationMs];
    if (metric === "workingSetMiB") return [run.processMetrics.workingSetBytes / 1048576];
    if (metric === "privateMiB") return [run.processMetrics.privateBytes / 1048576];
    if (metric === "handles") return [run.processMetrics.handles];
    if (metric === "settleCpuPercentOneCore") return [run.processMetrics.cpuPercentOneCore];
    return run.operations[metric];
}
assert(calibration.passed && comparison.passed);
assert.equal(calibration.methodVersion ?? 1, comparison.methodVersion ?? 1, "Calibration and comparison must use the same warmup protocol");
assert(calibration.variants.baseline.source === calibration.variants.candidate.source, "Calibration must be the same package twice");
assert.equal(calibration.host.cpu, comparison.host.cpu);
assert.equal(calibration.host.release, comparison.host.release);
assert(calibration.sampleCount >= 20 && comparison.sampleCount >= 20, "Need >=20 pairs per workload");
const gates = [];
for (const workload of Object.keys(comparison.variants.baseline.summary)) {
    const a = calibration.variants.baseline.scenarios[workload];
    const b = calibration.variants.candidate.scenarios[workload];
    for (const metric of Object.keys(comparison.variants.baseline.summary[workload])) {
        const noise = { median: [], p95: [] };
        for (let repeat = 0; repeat < 5000; repeat++) {
            const left = [], right = [];
            for (let index = 0; index < a.length; index++) {
                const chosen = Math.floor(random() * a.length);
                const x = observations(a[chosen], metric), y = observations(b[chosen], metric);
                const swap = random() < .5;
                left.push(...(swap ? y : x)); right.push(...(swap ? x : y));
            }
            noise.median.push(quantile(right, .5) - quantile(left, .5));
            noise.p95.push(quantile(right, .95) - quantile(left, .95));
        }
        for (const statistic of ["median", "p95"]) {
            const original = comparison.variants.baseline.summary[workload][metric][statistic];
            const candidate = comparison.variants.candidate.summary[workload][metric][statistic];
            const calibratedAllowance = Math.max(0, quantile(noise[statistic], .975));
            const prior = priorBudget?.gates.find(gate => gate.workload === workload && gate.metric === metric && gate.statistic === statistic);
            if (priorBudget) {
                assert(prior && Number.isFinite(prior.naturalNoiseUpper) && prior.naturalNoiseUpper >= 0, "Missing frozen prior budget");
                priorKeys.add(`${workload}/${metric}/${statistic}`);
            }
            const allowance = prior ? Math.min(calibratedAllowance, prior.naturalNoiseUpper) : calibratedAllowance;
            const delta = candidate - original;
            gates.push({ workload, metric, statistic, baseline: original, candidate, delta,
                naturalNoiseUpper: allowance, calibratedNaturalNoiseUpper: calibratedAllowance,
                priorNaturalNoiseUpper: prior?.naturalNoiseUpper, passed: delta <= allowance });
        }
    }
}
const size = { baseline: comparison.variants.baseline.artifact.bytes,
    candidate: comparison.variants.candidate.artifact.bytes };
size.passed = size.candidate <= size.baseline;
if (priorBudget) assert.equal(priorKeys.size, priorBudget.gates.length, "Frozen budget metrics differ");
const report = { passed: size.passed && gates.every(gate => gate.passed), calibration: process.argv[2], comparison: process.argv[3],
    priorBudgetCeiling: process.argv[5],
    method: "Each metric and median/P95 checked separately. Noise budget from same-package A/A 20-pair alternating control: 5000 paired-cluster resamples, random label swaps, fixed seed 20261006, upper 97.5% null-noise quantile. No tradeoffs across metrics. Requires functional regression separately; optional prior budget is an additional ceiling, never a relaxation.",
    size, gates };
fs.writeFileSync(destination, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: report.passed, size, failures: gates.filter(gate => !gate.passed) }, null, 2));
if (!report.passed) process.exitCode = 1;
