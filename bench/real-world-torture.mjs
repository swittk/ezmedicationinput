import fs from "node:fs";
import { runCorpusBenchmark } from "./corpus-runner.mjs";

const cases = JSON.parse(
  fs.readFileSync(new URL("../test/real-world-torture-cases.json", import.meta.url), "utf8")
);
runCorpusBenchmark(cases, "real-world-torture");
