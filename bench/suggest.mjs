import { performance } from "node:perf_hooks";
import { suggestSig } from "../dist/index.js";

const cases = [
  { input: "", options: { limit: 20 } },
  { input: "1x", options: { limit: 20 } },
  { input: "1 tab po q", options: { limit: 20 } },
  { input: "5 m", options: { limit: 20 } },
  { input: "0.5 tab", options: { limit: 20 } },
  { input: "1 tab po prn a", options: { limit: 20 } },
  { input: "1 tab po morn hs", options: { limit: 20 } },
  { input: "1 poc", options: { limit: 20 } },
  { input: "1-", options: { limit: 20, enableMealDashSyntax: true } },
  { input: "1 drop to od q2h", options: { limit: 20 } },
  { input: "500 mg po q4-6h prn pain", options: { limit: 20 } },
  { input: "500 millig", options: { limit: 20 } },
  { input: "at 14:3", options: { limit: 20 } },
  { input: "กิน", options: { limit: 20, locale: "th" } },
  { input: "กิน ครั้งล", options: { limit: 20, locale: "th" } },
  { input: "ทา", options: { limit: 20, locale: "th" } },
  { input: "รับประทาน 1 เม็ด เมื่อมีอาการปว", options: { limit: 20, locale: "th" } },
  { input: "รับประทาน 1 เม", options: { limit: 20, locale: "th" } },
  { input: "รับประทาน 1 เม็ด ว", options: { limit: 20, locale: "th" } },
  { input: "รับประทาน 1 เม็ด ก่อนอ", options: { limit: 20, locale: "th" } },
  { input: "ทาบริเวณผ", options: { limit: 20, locale: "th" } },
  { input: "apply to right e", options: { limit: 20 } },
  { input: "1 drop to o", options: { limit: 20 } },
  { input: "1 tab po b", options: { limit: 20 } },
  { input: "take", options: { limit: 20 } },
  { input: "apply", options: { limit: 20 } },
  { input: "take 1 tab bef", options: { limit: 20 } },
  { input: "zzzz", options: { limit: 20 } }
];

const warmupRounds = Number(process.env.WARMUP_ROUNDS ?? 20);
const rounds = Number(process.env.ROUNDS ?? 100);
const percentile = (sorted, ratio) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
const mib = (value) => Number((value / 1048576).toFixed(3));

for (let round = 0; round < warmupRounds; round += 1) {
  for (const testCase of cases) suggestSig(testCase.input, testCase.options);
}
if (global.gc) global.gc();
const baseline = process.memoryUsage();
let peakRss = baseline.rss;
let peakHeap = baseline.heapUsed;
const timings = [];
const started = performance.now();
let calls = 0;
for (let round = 0; round < rounds; round += 1) {
  for (const testCase of cases) {
    const before = performance.now();
    suggestSig(testCase.input, testCase.options);
    timings.push(performance.now() - before);
    calls += 1;
    if (calls % 20 === 0) {
      const memory = process.memoryUsage();
      peakRss = Math.max(peakRss, memory.rss);
      peakHeap = Math.max(peakHeap, memory.heapUsed);
    }
  }
}
const totalMs = performance.now() - started;
timings.sort((left, right) => left - right);
if (global.gc) global.gc();
const retained = process.memoryUsage();
console.log(JSON.stringify({
  corpus: "suggest",
  cases: cases.length,
  calls,
  warmupRounds,
  rounds,
  meanMs: Number((totalMs / calls).toFixed(4)),
  p50Ms: Number(percentile(timings, 0.5).toFixed(4)),
  p95Ms: Number(percentile(timings, 0.95).toFixed(4)),
  p99Ms: Number(percentile(timings, 0.99).toFixed(4)),
  throughputPerSec: Number((calls / (totalMs / 1000)).toFixed(1)),
  memoryMiB: {
    baselineRss: mib(baseline.rss),
    baselineHeap: mib(baseline.heapUsed),
    peakRss: mib(peakRss),
    peakHeap: mib(peakHeap),
    retainedRss: mib(retained.rss),
    retainedHeap: mib(retained.heapUsed),
    retainedHeapDelta: mib(retained.heapUsed - baseline.heapUsed)
  }
}, null, 2));
