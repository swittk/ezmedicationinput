/**
 * Paired microbenchmark for the shipping parser surface.
 *
 * Usage:
 *   npm run build
 *   BASELINE_MODULE=/absolute/path/to/previous/dist/index.js npm run bench:r6-regression
 *   ROUNDS=12 WARMUP_ROUNDS=3 npm run bench:r6-regression
 *
 * This only measures parsing latency. It does not assert semantic correctness
 * or execute any Vitest suites. Run under a stable host load for comparisons.
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const baselineModule = process.env.BASELINE_MODULE;
const rounds = Number(process.env.ROUNDS ?? 12);
const warmup = Number(process.env.WARMUP_ROUNDS ?? 3);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 1000 ||
    !Number.isInteger(warmup) || warmup < 0 || warmup > 1000) {
  throw new Error("ROUNDS / WARMUP_ROUNDS must be bounded non-negative integers");
}

const current = await import("../dist/index.js");
const baseline = baselineModule
  ? await import(pathToFileURL(baselineModule).href)
  : null;
if (typeof current.parseSig !== "function" ||
    (baseline && typeof baseline.parseSig !== "function")) {
  throw new Error("Both modules must export parseSig()");
}
const cases = JSON.parse(
  fs.readFileSync(new URL("../test/real-world-torture-cases.json", import.meta.url), "utf8")
);

const versions = baseline ? { baseline: baseline.parseSig, current: current.parseSig } :
  { current: current.parseSig };
const timings = Object.fromEntries(
  Object.keys(versions).map(name => [name, []])
);
for (let iteration = 0; iteration < warmup; iteration++) {
  for (const parser of Object.values(versions)) {
    for (const testCase of cases) {
      parser(testCase.input, testCase.locale ? { locale: testCase.locale } : undefined);
    }
  }
}
for (let round = 0; round < rounds; round++) {
  const entries = Object.entries(versions);
  if (round % 2) entries.reverse();
  for (const [name, parser] of entries) {
    for (const testCase of cases) {
      const before = performance.now();
      parser(testCase.input, testCase.locale ? { locale: testCase.locale } : undefined);
      timings[name].push(performance.now() - before);
    }
  }
}
function metrics(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return {
    parses: sorted.length,
    meanMs: Number(mean.toFixed(3)),
    p50Ms: Number(sorted[Math.floor(sorted.length * 0.5)].toFixed(3)),
    p95Ms: Number(sorted[Math.floor(sorted.length * 0.95)].toFixed(3))
  };
}
const result = Object.fromEntries(Object.entries(timings).map(([name, t]) => [name, metrics(t)]));
if (result.baseline && result.current) {
  result.meanDeltaPct = Number(((result.current.meanMs / result.baseline.meanMs - 1) * 100).toFixed(1));
  result.p95DeltaPct = Number(((result.current.p95Ms / result.baseline.p95Ms - 1) * 100).toFixed(1));
}
console.log(JSON.stringify({
  ...result,
  corpus: "real-world-torture",
  cases: cases.length,
  rounds,
  warmupRounds: warmup,
  note: "Short paired parsing microbenchmark, not clinical or CI verification"
}, null, 2));
