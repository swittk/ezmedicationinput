import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { parseSig } from "../dist/index.js";

const cases = JSON.parse(
  fs.readFileSync(new URL("../test/real-world-torture-cases.json", import.meta.url), "utf8")
);
const warmupRounds = Number(process.env.WARMUP_ROUNDS ?? 20);
const rounds = Number(process.env.ROUNDS ?? 100);

function options(testCase) {
  return testCase.locale ? { locale: testCase.locale } : undefined;
}

function percentile(sorted, ratio) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

for (let round = 0; round < warmupRounds; round += 1) {
  for (const testCase of cases) parseSig(testCase.input, options(testCase));
}

const timings = [];
const perCase = cases.map(() => []);
const started = performance.now();
for (let round = 0; round < rounds; round += 1) {
  for (let index = 0; index < cases.length; index += 1) {
    const testCase = cases[index];
    const before = performance.now();
    parseSig(testCase.input, options(testCase));
    const elapsed = performance.now() - before;
    timings.push(elapsed);
    perCase[index].push(elapsed);
  }
}
const totalMs = performance.now() - started;
timings.sort((left, right) => left - right);

const slowest = perCase
  .map((values, index) => {
    values.sort((left, right) => left - right);
    return {
      case: index + 1,
      name: cases[index].name,
      meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
      p50Ms: percentile(values, 0.5),
      p95Ms: percentile(values, 0.95)
    };
  })
  .sort((left, right) => right.meanMs - left.meanMs)
  .slice(0, 5)
  .map((entry) => ({
    ...entry,
    meanMs: Number(entry.meanMs.toFixed(2)),
    p50Ms: Number(entry.p50Ms.toFixed(2)),
    p95Ms: Number(entry.p95Ms.toFixed(2))
  }));

console.log(JSON.stringify({
  cases: cases.length,
  parses: timings.length,
  warmupRounds,
  rounds,
  totalMs: Number(totalMs.toFixed(2)),
  meanMs: Number((totalMs / timings.length).toFixed(4)),
  p50Ms: Number(percentile(timings, 0.5).toFixed(4)),
  p95Ms: Number(percentile(timings, 0.95).toFixed(4)),
  p99Ms: Number(percentile(timings, 0.99).toFixed(4)),
  throughputPerSec: Number((timings.length / (totalMs / 1000)).toFixed(1)),
  slowest
}, null, 2));
