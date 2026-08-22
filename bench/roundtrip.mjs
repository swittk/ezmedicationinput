import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { formatSig, parseSig } from "../dist/index.js";

const english = JSON.parse(fs.readFileSync(new URL("../test/generation-roundtrip-cases.json", import.meta.url), "utf8"))
  .map((input) => ({ input, sourceLocale: "en", targetLocale: "en" }));
const thai = JSON.parse(fs.readFileSync(new URL("../test/generation-roundtrip-thai-cases.json", import.meta.url), "utf8"))
  .map((input) => ({ input, sourceLocale: "th", targetLocale: "th" }));
const crossLanguage = JSON.parse(fs.readFileSync(new URL("../test/generation-cross-language-cases.json", import.meta.url), "utf8"))
  .map((value) => ({ input: value.source, sourceLocale: value.from, targetLocale: value.to }));
const cases = [...english, ...thai, ...crossLanguage];
const warmupRounds = Number(process.env.WARMUP_ROUNDS ?? 5);
const rounds = Number(process.env.ROUNDS ?? 25);

function percentile(sorted, ratio) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function run(testCase) {
  const parsed = parseSig(testCase.input, { locale: testCase.sourceLocale });
  const realized = formatSig(parsed.fhir, "long", {
    locale: testCase.targetLocale,
    realizationMode: "roundtrip"
  });
  parseSig(realized, { locale: testCase.targetLocale });
}

for (let round = 0; round < warmupRounds; round += 1) for (const testCase of cases) run(testCase);
const timings = [];
const started = performance.now();
for (let round = 0; round < rounds; round += 1) {
  for (const testCase of cases) {
    const before = performance.now();
    run(testCase);
    timings.push(performance.now() - before);
  }
}
const totalMs = performance.now() - started;
timings.sort((a, b) => a - b);
console.log(JSON.stringify({
  corpus: "generation-roundtrip-en-th-cross",
  cases: cases.length,
  roundTrips: timings.length,
  warmupRounds,
  rounds,
  totalMs: Number(totalMs.toFixed(2)),
  meanMs: Number((totalMs / timings.length).toFixed(4)),
  p50Ms: Number(percentile(timings, 0.5).toFixed(4)),
  p95Ms: Number(percentile(timings, 0.95).toFixed(4)),
  p99Ms: Number(percentile(timings, 0.99).toFixed(4)),
  throughputPerSec: Number((timings.length / (totalMs / 1000)).toFixed(1))
}, null, 2));
