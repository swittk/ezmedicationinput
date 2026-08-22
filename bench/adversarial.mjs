import fs from "node:fs";
import { runCorpusBenchmark } from "./corpus-runner.mjs";

function readCases(relativePath) {
  return JSON.parse(fs.readFileSync(new URL(relativePath, import.meta.url), "utf8"));
}

const cases = [
  ...readCases("../test/real-world-torture-cases.json"),
  ...readCases("../test/weird-clinician-cases.json")
];
runCorpusBenchmark(cases, "combined-adversarial");
