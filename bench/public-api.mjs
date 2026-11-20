/** Public API performance gate, not just parse/format/supply.
 *
 * Usage: node --expose-gc bench/public-api.mjs --baseline /path/to/dist/index.js
 *   [--only regex] [--rounds 9] [--target-ms 12] [--smoke] [--json report.json]
 *
 * Each exported function has a fixture or an explicit new-API classification.
 * Ordinary and adversarial API families are separate measurements; a fast
 * scheduler cannot hide slow suggestions/import/formatting. Paired alternating
 * runs share inputs, JIT warmup and invocation counts. No timing assertion lives
 * inside correctness tests. Tiny noisy APIs report both absolute time and spread.
 */
import { performance } from "node:perf_hooks";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const argv = process.argv.slice(2),
  value = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i < 0 ? fallback : argv[i + 1];
  };
const baselinePath = value("--baseline", process.env.EZMED_BASELINE);
if (!baselinePath) throw new Error("Supply --baseline pointing to the built origin/master package");
const filter = new RegExp(value("--only", ".")),
  rounds = Number(value("--rounds", "9"));
const targetMs = Number(value("--target-ms", "12")),
  smoke = argv.includes("--smoke");
if (!smoke && (!Number.isInteger(rounds) || rounds < 1))
  throw new Error("--rounds must be a positive integer for timed measurements");
const maxRegression = 0.04;
const outputPath = value("--json", undefined);
const report = {
  complete: false,
  startedAt: new Date().toISOString(),
  phase: "initializing",
  cases: [],
  newApiMeasurements: [],
  unavailable: [],
  errors: [],
};
/** Save outside measured work. A timed-out run remains an explicitly
 * incomplete report containing every completed scenario instead of losing
 * its evidence or accidentally being treated as a successful complete run. */
function checkpoint(complete = false) {
  report.complete = complete;
  if (complete) report.phase = "complete";
  report.updatedAt = new Date().toISOString();
  report.passing = report.cases.filter((c) => c.pass || c.smoke).length;
  report.failing = report.cases.filter((c) => c.pass === false).length;
  report.nonEquivalent = report.cases.filter((c) => c.equivalentWork === false).length;
  report.measuredPublicFunctions = new Set([
    ...report.cases.map(c => c.api), ...report.newApiMeasurements.map(c => c.api),
  ]).size;
  if (outputPath) {
    const temporary = outputPath + ".tmp";
    writeFileSync(temporary, JSON.stringify(report, null, 2) + "\n");
    renameSync(temporary, outputPath);
  }
}
checkpoint();
const baseline = await import(pathToFileURL(resolve(baselinePath)).href);
const candidate = await import(new URL("../dist/index.js", import.meta.url));
const emaComparatorQuantity = { extension: [{
  url: candidate.EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
  valueCoding: { system: candidate.EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000055" },
}] };
const candidateEmaComparator = candidate.getEmaQuantityComparator;
if (candidateEmaComparator(emaComparatorQuantity) !== "~")
  throw new Error("EMA comparator fixture must decode the encoded approximation");
const S = {
  ordinary: "1 tab PO BID",
  thai: "กิน 2 เม็ดเช้า, 3 เม็ดเย็น เป็นเวลา 1 สัปดาห์",
  eye: "1 drop OD q2h x7d then qid; 1 drop OS qid x1mo then bid",
  staged:
    "2 tabs morning, 1 tab evening for 1 week then 2 tabs morning for 1 month then 1/2 tab PO on monday-friday",
  guard: "Take 2 tabs QID max 2 tabs/day",
  action: "Dissolve 2 tablets in water, then drink slowly",
  routine: "Take 1 tablet PO BID for 3 days",
};
const parsed = Object.fromEntries(Object.entries(S).map(([key, text]) => [key, baseline.parseSig(text)]));
const rows = parsed.routine.fhir,
  wire = parsed.routine.fhirNext,
  complex = parsed.eye.fhirNext;
const plainWire = structuredClone(wire);
delete plainWire.renderedInstruction;
for (const s of plainWire.step) for (const a of s.component) delete a.text;
const condition = { kind: "measurement", name: "SBP", operation: "gt", value: 160, text: "SBP >160" };
const graph = parsed.action.meta.canonical.clauses[0].instructionGraph;
const graphExtension = baseline.buildInstructionGraphExtension(graph);
const action = baseline.listMedicationInstructionActions()[0],
  concept = baseline.listMedicationInstructionConcepts()[0];
const symptom = baseline.listSymptomDefinitions().find((s) => s.coding?.code);
const relation = {
  relationText: "around",
  relationCoding: { system: baseline.SNOMED_SYSTEM, code: "66459002" },
  targetText: "left eye",
  targetCoding: { system: baseline.SNOMED_SYSTEM, code: "129004000" },
  sourceText: "around left eye",
};
const relationConcept = { extension: baseline.buildBodySiteSpatialRelationExtensions(relation) };
const counted = { extension: [baseline.buildBodySiteAdministrationTargetCountExtension(2)] };
const conditionRow = {};
baseline.setDosageCondition(conditionRow, condition);
const dateRow = {};
baseline.setDosageExcludedDates(dateRow, ["2026-11-19"]);
const weekdayRow = {};
baseline.setDosageExcludedWeekdays(weekdayRow, ["sat", "sun"]);
const choice = { groupId: "g1", branchId: "b1", selectionBehavior: "exactly-one" };
const choiceRow = {};
baseline.setDosageAlternativeChoice(choiceRow, choice);
const dateOptions = { datePolicy: { referenceDate: "2026-11-17" } };
const schedule = {
  from: "2026-11-18T00:00:00+07:00",
  orderedAt: "2026-11-18T00:00:00+07:00",
  timeZone: "Asia/Bangkok",
  limit: 10,
  durationValue: 3,
  durationUnit: "d",
};
const cases = [],
  covered = new Set();
function add(api, label, run, domain = api) {
  covered.add(api);
  cases.push({ api, name: label, domain, run });
}
function simple(api, args = [], label = api) {
  // Resolve each named export once, as a consuming named import does. A
  // different-size module namespace must not add a per-call property lookup
  // to the latency of an otherwise identical sub-microsecond helper.
  const before = baseline[api],
    after = candidate[api];
  add(api, label, (m) => (m === baseline ? before : after)(...args));
  cases[cases.length - 1].direct = new Map([
    [baseline, () => before(...args)],
    [candidate, () => after(...args)],
  ]);
}
for (const key of ["ordinary", "thai", "eye", "staged", "guard", "action"]) {
  add("parseSig", "parseSig/" + key, (m) => m.parseSig(S[key]));
  add("parseSigAsync", "parseSigAsync/" + key, (m) => m.parseSigAsync(S[key]));
  add("lintSig", "lintSig/" + key, (m) => m.lintSig(S[key]));
}
// Same established interactive autocomplete corpus as bench/suggest.mjs.
const suggestCases = [
  "",
  "1x",
  "1 tab po q",
  "5 m",
  "0.5 tab",
  "1 tab po prn a",
  "1 tab po morn hs",
  "1 poc",
  "1-",
  "1 drop to od q2h",
  "500 mg po q4-6h prn pain",
  "500 millig",
  "at 14:3",
  "กิน",
  "กิน ครั้งล",
  "ทา",
  "รับประทาน 1 เม็ด เมื่อมีอาการปว",
  "รับประทาน 1 เม",
  "รับประทาน 1 เม็ด ว",
  "รับประทาน 1 เม็ด ก่อนอ",
  "ทาบริเวณผ",
  "apply to right e",
  "1 drop to o",
  "1 tab po b",
  "take",
  "apply",
  "take 1 tab bef",
  "zzzz",
];
for (const input of suggestCases)
  add("suggestSig", "suggestSig/" + (input || "empty"), (m) =>
    m.suggestSig(input, {
      limit: 20,
      ...(/[ก-๙]/u.test(input) ? { locale: "th" } : {}),
      ...(input === "1-" ? { enableMealDashSyntax: true } : {}),
    })
  );
for (const locale of ["en", "th"]) {
  for (const [label, input] of [
    ["R5", rows[0]],
    ["R6", wire],
    ["R6-source-less", plainWire],
    ["R6-complex", complex],
  ])
    add("formatSig", `formatSig/${label}/${locale}`, (m) => m.formatSig(input, "long", { locale }));
  add("fromFhir", "fromFhir/simple/" + locale, (m) => m.fromFhir(wire, { locale }));
  add("fromFhir", "fromFhir/complex/" + locale, (m) => m.fromFhir(complex, { locale }));
  add("fromFhirDosage", "fromFhirDosage/" + locale, (m) => m.fromFhirDosage(rows[0], { locale }));
  add("formatSigBatch", "formatSigBatch/" + locale, (m) =>
    m.formatSigBatch(parsed.eye.fhir, "long", { locale })
  );
}
// Source-preserving formatting has its own clinical ownership and performance
// boundary. A graph-backed authored dose must be retained when unchanged but
// never replayed after the R5 dosage quantity is edited.
const authoredGraphRow = baseline.parseSig("ล้างมือก่อนหยอดตา หยอดตาขวา 1 หยด แล้วหลับตา", { locale: "th" })
  .fhir[0];
const copiedAuthoredGraphRow = structuredClone(authoredGraphRow);
const editedGraphRow = structuredClone(authoredGraphRow);
if (!editedGraphRow?.doseAndRate?.[0]?.doseQuantity)
  throw new Error("Authoritative roundtrip benchmark requires the parsed quantity");
editedGraphRow.doseAndRate[0].doseQuantity.value = 2;
const amountlessGraphRow = baseline.parseSig("ผสมน้ำแล้วดื่ม", { locale: "th" }).fhir[0];
const addedDoseRow = { ...amountlessGraphRow, doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }] };
add("formatSig", "formatSig/R5-roundtrip-unchanged-thai", (m) =>
  m.formatSig(copiedAuthoredGraphRow, "long", { locale: "th", realizationMode: "roundtrip" })
);
add("formatSig", "formatSig/R5-roundtrip-edited-thai", (m) =>
  m.formatSig(editedGraphRow, "long", { locale: "th", realizationMode: "roundtrip" })
);
add("formatSig", "formatSig/R5-roundtrip-added-dose-thai", (m) =>
  m.formatSig(addedDoseRow, "long", { locale: "th", realizationMode: "roundtrip" })
);

add("formatSig", "formatSig/R6-author-source", (m) => m.formatSig(wire, "long"));
add("formatParseBatch", "formatParseBatch/ordinary", (m) => m.formatParseBatch(parsed.ordinary, "long"));
add("formatParseBatch", "formatParseBatch/staged", (m) => m.formatParseBatch(parsed.staged, "long"));
for (const [name, input] of [
  ["scalar", rows[0]],
  ["parallel-array", parsed.eye.fhir],
  ["native-R6", complex],
]) {
  add("nextDueDoses", "nextDueDoses/" + name, (m) => m.nextDueDoses(input, schedule));
  add("calculateTotalUnits", "calculateTotalUnits/" + name, (m) =>
    m.calculateTotalUnits({ ...schedule, dosage: input })
  );
}
// Varied dates defeat a benchmark which only wins by remembering one query.
let variedIndex = 0;
const variedDates = Array.from({ length: 97 }, (_, i) =>
  new Date(Date.UTC(2026, 0, 1 + i * 7, 1)).toISOString()
);
add("nextDueDoses", "nextDueDoses/varied-calendars", (m, i) => {
  const d = variedDates[i % variedDates.length];
  return m.nextDueDoses(rows[0], { ...schedule, from: d, orderedAt: d });
});
for (const [name, input] of [
  ["simple", rows],
  ["complex", parsed.eye.fhir],
]) {
  add("toDosageDetails", "toDosageDetails/" + name, (m) => m.toDosageDetails(input));
  add("toFhirR5Dosages", "toFhirR5Dosages/R5-" + name, (m) => m.toFhirR5Dosages(input));
  add("toEzDosages", "toEzDosages/" + name, (m) => m.toEzDosages(input));
}
for (const [name, input] of [
  ["simple", wire],
  ["complex", complex],
]) {
  add("toFhirR5Dosages", "toFhirR5Dosages/R6-" + name, (m) => m.toFhirR5Dosages(input));
  add("fromDosageDetails", "fromDosageDetails/" + name, (m) => m.fromDosageDetails(input));
}
simple("parseStrength", ["250 mg/5 mL"]);
simple("parseStrengthIntoRatio", ["500 mg/tablet"]);
simple("parseStrengthComponents", ["875 mg + 125 mg"]);
simple("evaluateMedicationCondition", [condition, { SBP: 170 }]);
for (const [api, args] of [
  ["getDosageCondition", [conditionRow]],
  ["getDosageExcludedDates", [dateRow]],
  ["getDosageExcludedWeekdays", [weekdayRow]],
  ["getDosageAlternativeChoice", [choiceRow]],
  ["getEmaQuantityComparator", [emaComparatorQuantity]],
  ["getTimingOccurrenceCap", [baseline.parseSig("1 tab up to 3 doses per day").fhir[0].timing?.repeat]],
])
  simple(api, args);
for (const [api, value] of [
  ["setDosageCondition", condition],
  ["setDosageExcludedDates", ["2026-11-19"]],
  ["setDosageExcludedWeekdays", ["sun"]],
  ["setDosageAlternativeChoice", choice],
])
  add(api, api, (m) => {
    const row = {};
    m[api](row, value);
    return row;
  });
for (const api of ["getDoseUnitApproximation", "getDoseUnitKind", "getDoseUnitSemantics"])
  simple(api, ["drop"]);
simple("listDoseUnitTerminology");
for (const api of ["lookupBodySite", "lookupBodySiteAsync", "getBodySiteCode", "getBodySiteCodeAsync"])
  simple(api, ["left eye"]);
for (const api of ["getBodySiteText", "getBodySiteTextAsync"])
  simple(api, [{ system: baseline.SNOMED_SYSTEM, code: "129004000" }, { locale: "th" }]);
for (const api of ["suggestBodySites", "suggestBodySiteText"]) simple(api, ["left e", { limit: 10 }]);
simple("listSupportedBodySiteText", [{ limit: 30 }]);
simple("listSupportedBodySiteGrammar");
simple("buildBodySiteTopographicalModifierCoding", [relation]);
simple("buildBodySiteAdministrationTargetCountExtension", [2]);
simple("parseBodySiteAdministrationTargetCountExtension", [counted]);
simple("getBodySiteAdministrationTargetCount", [counted]);
simple("buildBodySiteSpatialRelationExtension", [relation]);
simple("buildBodySiteSpatialRelationExtensions", [relation]);
simple("parseBodySiteSpatialRelationExtension", [relationConcept]);
simple("cloneBodySiteSpatialRelation", [relation]);
for (const [suffix, params] of [
  ["FindingSite", ["22253000", "129004000"]],
  ["BodySiteLaterality", ["81745001", "7771000"]],
  ["BodySiteTopographicalModifier", ["81745001", "66459002"]],
]) {
  const build = "buildSnomed" + suffix + "PostcoordinationCode",
    code = baseline[build](...params);
  simple(build, params);
  simple("parseSnomed" + suffix + "PostcoordinationCode", [code]);
  const has =
    suffix === "BodySiteTopographicalModifier"
      ? "hasSnomedTopographicalModifierPostcoordination"
      : "hasSnomed" + suffix + "Postcoordination";
  simple(has, [code]);
}
simple("buildSnomedFindingSiteCoding", [
  {
    focusCoding: { system: baseline.SNOMED_SYSTEM, code: "22253000" },
    siteCoding: { system: baseline.SNOMED_SYSTEM, code: "129004000" },
  },
]);
simple("parseInstructionActions", [S.action]);
simple("realizeInstructionGraph", [graph, "th"]);
simple("buildInstructionGraphExtension", [graph]);
simple("parseInstructionGraphExtension", [[graphExtension]]);
simple("getMedicationInstructionAction", [action.code]);
simple("resolveMedicationInstructionAction", ["dissolve"]);
simple("resolveMedicationInstructionSequenceAction", ["swallow"]);
simple("getMedicationInstructionConcept", [concept.code]);
simple("resolveMedicationInstructionConcept", ["water"]);
for (const api of [
  "listMedicationInstructionActions",
  "listMedicationInstructionConcepts",
  "buildMedicationInstructionActionCodeSystem",
  "buildMedicationInstructionConceptCodeSystem",
  "buildInfusionCarrierMaterialStructureDefinition",
  "buildDosageAlternativeChoiceStructureDefinition",
  "listSymptomDefinitions",
  "listAdviceRelationDefinitions",
  "listBodySiteRelationDefinitions",
  "getRegisteredSigLocalizations",
  "listMedicationSurfaceSegmenters",
  "listMedicationDateResolvers",
])
  simple(api);
simple("normalizeSymptomKey", ["  CHEST pain  "]);
simple("resolveSymptomDefinition", ["pain"]);
simple("findSymptomDefinitionByCoding", [symptom.coding.system, symptom.coding.code]);
simple("getAdviceRelationDefinition", ["before"]);
simple("getBodySiteRelationDefinition", ["around"]);
simple("getBodySiteRelationRealization", ["around", "th"]);
simple("localizeAdviceRelation", ["before", "th"]);
simple("normalizeBodySiteRelation", ["around"]);
simple("resolveActionRelationSurface", ["then"]);
simple("resolveAdviceRelationSurface", ["before"]);
for (const api of [
  "getAdviceLocaleAdapter",
  "getInstructionActionLocaleAdapter",
  "getSuggestLocaleAdapter",
  "getMedicationLexerLocalePack",
  "listMedicationLocaleLexemes",
  "resolveSigLocalization",
  "resolveSigTranslation",
])
  simple(api, ["th"]);
simple("inferMedicationLocale", [S.thai, "en"]);
simple("findMedicationDateListSpans", ["Take 1 tablet on 2026-11-18, 2026-11-20", dateOptions]);
simple("parseMedicationDateListAt", ["on 2026-11-18, 2026-11-20", 0, dateOptions]);
add(
  "MedicationQuantityCalculationError",
  "MedicationQuantityCalculationError",
  (m) => new m.MedicationQuantityCalculationError("missing-regimen", "benchmark")
);
// Registration cases replace a single fixed ID (no growing registry). Run last
// because lexer registration deliberately invalidates locale suggestion indexes.
for (const [register, get] of [
  ["registerAdviceLocaleAdapter", "getAdviceLocaleAdapter"],
  ["registerInstructionActionLocaleAdapter", "getInstructionActionLocaleAdapter"],
  ["registerSuggestLocaleAdapter", "getSuggestLocaleAdapter"],
]) {
  const adapters = new Map([
    [baseline, baseline[get]("en")],
    [candidate, candidate[get]("en")],
  ]);
  add(register, register, (m) => m[register](adapters.get(m)), "registration");
}
const lexerPacks = new Map([
  [baseline, baseline.getMedicationLexerLocalePack("th")],
  [candidate, candidate.getMedicationLexerLocalePack("th")],
]);
add(
  "registerMedicationLexerLocalePack",
  "registerMedicationLexerLocalePack",
  (m) => m.registerMedicationLexerLocalePack(lexerPacks.get(m)),
  "registration"
);
add(
  "registerMedicationLocaleDetector",
  "registerMedicationLocaleDetector",
  (m) => m.registerMedicationLocaleDetector({ locale: "bench", test: () => false, priority: -100 }),
  "registration"
);
add(
  "registerMedicationSurfaceSegmenter",
  "registerMedicationSurfaceSegmenter",
  (m) => m.registerMedicationSurfaceSegmenter({ locale: "bench", script: /a^/, segment: () => [] }),
  "registration"
);
add(
  "registerIntlMedicationSurfaceSegmenter",
  "registerIntlMedicationSurfaceSegmenter",
  (m) => m.registerIntlMedicationSurfaceSegmenter("en", /a^/),
  "registration"
);
add(
  "registerMedicationDateResolver",
  "registerMedicationDateResolver",
  (m) => m.registerMedicationDateResolver({ id: "bench", resolveYear: () => undefined }),
  "registration"
);
add(
  "registerSigLocalization",
  "registerSigLocalization",
  (m) => m.registerSigLocalization({ locale: "bench" }),
  "registration"
);
// Each measured API owns its paired scenario. Import support is a fixture
// dependency, never a gate that silently removes a different exported API.
const nativeFixtures = new Map();
const nativeFixtureErrors = new Map();
const nativeUnavailable = new Map();
const textlessWire = structuredClone(complex);
delete textlessWire.renderedInstruction;
for (const step of textlessWire.step) for (const a of step.component) delete a.text;
for (const m of [baseline, candidate]) {
  if (typeof m.importCanonicalCourse !== "function") {
    nativeFixtureErrors.set(m, "version has no importCanonicalCourse for a compatible native fixture");
    continue;
  }
  try {
    nativeFixtures.set(m, {
      source: m.importCanonicalCourse(complex),
      textless: m.importCanonicalCourse(textlessWire),
    });
  } catch (error) {
    nativeFixtureErrors.set(m, String(error.message ?? error));
  }
}
function addNative(api, name, run, needsFixture = false) {
  add(api, name, run);
  if (typeof baseline[api] !== "function") return;
  for (const [label, m] of [["baseline", baseline], ["candidate", candidate]]) {
    if (typeof m[api] !== "function") {
      nativeUnavailable.set(name, `${label} does not export ${api}`);
      break;
    }
    if (needsFixture && !nativeFixtures.has(m)) {
      nativeUnavailable.set(name, `${label}: ${nativeFixtureErrors.get(m)}`);
      break;
    }
  }
}
addNative("importCanonicalCourse", "native/import-R6", (m) => m.importCanonicalCourse(complex));
addNative("importCanonicalCourse", "native/import-R5", (m) => m.importCanonicalCourse(parsed.eye.fhir));
addNative("projectCanonicalCourse", "native/project-both", (m) => m.projectCanonicalCourse(nativeFixtures.get(m).source), true);
addNative("formatCanonicalAdministration", "native/format-administration", (m) =>
  m.formatCanonicalAdministration(nativeFixtures.get(m).textless.stages[0].administrations[0], "long", { locale: "th" }), true);
addNative("formatCanonicalCourse", "native/format-course", (m) =>
  m.formatCanonicalCourse(nativeFixtures.get(m).textless, "long", { locale: "th" }), true);
addNative("projectEditableR5Course", "native/project-editable-R5", (m) => m.projectEditableR5Course(complex));
const newApis = new Set([
  "importCanonicalCourse",
  "projectCanonicalCourse",
  "formatCanonicalAdministration",
  "formatCanonicalCourse",
  "projectEditableR5Course",
  "getEmaQuantityComparator",
].filter(api => typeof baseline[api] !== "function"));
const missing = Object.keys(candidate).filter(
  (k) => typeof candidate[k] === "function" && !covered.has(k) && !newApis.has(k)
);
if (missing.length) throw new Error("Uncovered public APIs: " + missing.join(", "));
if (
  baseline.parseBodySiteAdministrationTargetCountExtension(counted) !== 2 ||
  candidate.parseBodySiteAdministrationTargetCountExtension(counted) !== 2
)
  throw new Error("Target-count decoder fixture must exercise the encoded count, not an empty input");
Object.assign(report, {
  phase: "measuring",
  runtime: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    cpu: cpus()[0]?.model,
  },
  baselineSha256: createHash("sha256")
    .update(readFileSync(resolve(baselinePath)))
    .digest("hex"),
  candidateSha256: createHash("sha256")
    .update(readFileSync(new URL("../dist/index.js", import.meta.url)))
    .digest("hex"),
  baseline: resolve(baselinePath),
  candidate: new URL("../dist/index.js", import.meta.url).pathname,
  publicFunctions: Object.keys(candidate).filter((k) => typeof candidate[k] === "function").length,
  coveredPublicFunctions: covered.size,
  newApis: [...newApis],
  threshold: 1 + maxRegression,
  methodology:
    "Alternating paired warm batches; helper exports captured before timing; no cross-domain averaging",
  filter: filter.source,
  selectedComparisons: cases.filter(
    (test) => filter.test(test.name) && typeof baseline[test.api] === "function"
  ).length,
  rounds,
});
checkpoint();
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
let sink;
async function measure(test, module, iterations, async) {
  const invoke = test.direct?.get(module) ?? ((i) => test.run(module, i));
  const start = performance.now();
  if (async) for (let i = 0; i < iterations; i++) sink = await invoke(i);
  else for (let i = 0; i < iterations; i++) sink = invoke(i);
  return ((performance.now() - start) * 1000) / iterations;
}
/** Calibrate to steady-state duration, not a three-call pilot that can be
 * dominated by a first JIT transition for sub-microsecond getters. Both builds
 * use the identical final count; threshold and paired ordering stay fixed.
 * Calibrate to the slower side: a 100x speedup must not force 100x-longer
 * baseline batches merely to give the faster implementation a long sample. */
async function calibratedIterations(test, modules, async) {
  let iterations = 4;
  for (let attempt = 0; attempt < 7; attempt++) {
    let slowest = 0;
    for (const module of modules) slowest = Math.max(slowest, await measure(test, module, iterations, async));
    if (slowest * iterations >= targetMs * 800 || iterations >= 1000000) return iterations;
    const required = Math.ceil((targetMs * 1000) / Math.max(slowest, 0.005));
    iterations = Math.min(1000000, Math.max(iterations * 2, Math.min(iterations * 16, required)));
  }
  return iterations;
}
// These edit cases have an independent clinical oracle. An older formatter
// that returns the superseded quantity is doing different work; keep both
// timings visible but apply the latency gate only when both render the edit.
function completeThaiDose(output, action, unit, expected) {
  if (typeof output !== "string") return false;
  const number = "([+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+))";
  const verb = action === "หยอด" ? "หยอด(?:\\s*ตาขวา)?" : action;
  const phrase = new RegExp(`${verb}\\s*(?:ครั้งละ\\s*)?${number}\\s*${unit}(?=$|[\\s.;,])`, "u").exec(output);
  const quantities = [...output.matchAll(new RegExp(`(?<![\\d.])${number}\\s*${unit}(?=$|[\\s.;,])`, "gu"))];
  return phrase !== null && Number(phrase[1]) === expected && quantities.length === 1 &&
    Number(quantities[0][1]) === expected;
}
const equivalenceOracles = new Map([
  ["formatSig/R5-roundtrip-edited-thai", output => completeThaiDose(output, "หยอด", "หยด", 2)],
  ["formatSig/R5-roundtrip-added-dose-thai", output => completeThaiDose(output, "ดื่ม", "เม็ด", 2)],
]);
// Source-bearing R6 fixtures used to return the saved input verbatim. The
// current public contract generates requested previews from editable facts.
// These ordered clinical phrases cover every phase, both eyes, and cadence;
// keep raw latency visible when an older build does only source replay.
const complexPreviewPhrases = {
  en: [
    "Days 1–7", "1 drop every 2 hours in the right eye", "1 drop four times daily in the left eye",
    "From 7 days after treatment start until 1 month after treatment start",
    "1 drop four times daily in the right eye", "1 drop four times daily in the left eye",
    "From 1 month after treatment start onward", "1 drop four times daily in the right eye",
    "1 drop twice daily in the left eye",
  ],
  th: [
    "วันที่ 1–7", "หยอดตาขวา ครั้งละ 1 หยด ทุก 2 ชั่วโมง", "หยอดตาซ้าย ครั้งละ 1 หยด วันละ 4 ครั้ง",
    "ตั้งแต่7 วันหลังเริ่มการรักษาจนถึง1 เดือนหลังเริ่มการรักษา",
    "หยอดตาขวา ครั้งละ 1 หยด วันละ 4 ครั้ง", "หยอดตาซ้าย ครั้งละ 1 หยด วันละ 4 ครั้ง",
    "ตั้งแต่1 เดือนหลังเริ่มการรักษาเป็นต้นไป", "หยอดตาขวา ครั้งละ 1 หยด วันละ 4 ครั้ง",
    "หยอดตาซ้าย ครั้งละ 1 หยด วันละ 2 ครั้ง",
  ],
};
function currentComplexPreview(output, locale) {
  if (typeof output !== "string") return false;
  const unit = locale === "en" ? "drops?\\b" : "หยด(?=$|[\\s.;,])";
  const amounts = [...output.matchAll(new RegExp(
    "(?<![\\d.])([+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+))\\s*" + unit, "gu"))];
  // Each of the three phases owns one right-eye and one left-eye dose.
  // Ordered phrase presence alone would accept 11 as a suffix match for 1.
  if (amounts.length !== 6 || amounts.some(amount => Number(amount[1]) !== 1)) return false;
  let after = 0;
  for (const phrase of complexPreviewPhrases[locale]) {
    const position = output.indexOf(phrase, after);
    if (position < 0) return false;
    after = position + phrase.length;
    if (/\d$/u.test(phrase) && /^(?:\d|\.\d)/u.test(output.slice(after))) return false;
  }
  return true;
}
for (const locale of ["en", "th"]) {
  const exact = complexPreviewPhrases[locale].join(". ");
  if (!currentComplexPreview(exact, locale))
    throw new Error("Complex preview oracle rejected its six exact administrations");
  for (const amount of ["11", "1.2", "-1", "2"])
    if (currentComplexPreview(exact.replace(/1 (drop|หยด)/u, amount + " $1"), locale))
      throw new Error("Complex preview oracle accepted a different numeric amount");
  if (currentComplexPreview(exact + (locale === "en" ? ". 1 drop" : ". 1 หยด"), locale))
    throw new Error("Complex preview oracle accepted an extra administration");
  if (currentComplexPreview(exact.replace("1–7", "1–70"), locale))
    throw new Error("Complex preview oracle accepted a numeric endpoint suffix");
}
const equivalenceDetails = new Map();
const sourcePreviewDifference = {
  classification: "different-preview-work",
  reason: "Baseline replays saved source instead of generating the requested current-field preview; raw timings retained without a regression verdict",
};
for (const locale of ["en", "th"]) {
  const formatName = `formatSig/R6-complex/${locale}`;
  const importName = `fromFhir/complex/${locale}`;
  equivalenceOracles.set(formatName, output => currentComplexPreview(output, locale));
  equivalenceOracles.set(importName, output => currentComplexPreview(output?.longText, locale));
  equivalenceDetails.set(formatName, sourcePreviewDifference);
  equivalenceDetails.set(importName, sourcePreviewDifference);
}
equivalenceOracles.set("formatSig/R6-author-source", output =>
  output === "Take 1 tablet orally twice daily for 3 days.");
equivalenceDetails.set("formatSig/R6-author-source", sourcePreviewDifference);

// Check the independent amount oracle outside the measured loops. A suffix
// match, decimal, or a second superseded dose must never classify as correct.
for (const [action, unit] of [["หยอด", "หยด"], ["ดื่ม", "เม็ด"]]) {
  if (!completeThaiDose(`${action} 2 ${unit}.`, action, unit, 2))
    throw new Error("Complete-dose oracle rejected its exact administration");
  if (!completeThaiDose(`${action} 2.0 ${unit}.`, action, unit, 2))
    throw new Error("Complete-dose oracle rejected an equal decimal amount");
  for (const amount of ["12", "1.2", "2.5", "-2", "22"])
    if (completeThaiDose(`${action} ${amount} ${unit}.`, action, unit, 2))
      throw new Error("Complete-dose oracle accepted a different numeric amount");
  if (completeThaiDose(`${action} 2 ${unit}; ${action} 1 ${unit}.`, action, unit, 2))
    throw new Error("Complete-dose oracle accepted the superseded administration");
}
for (const text of ["หยอดตาขวา 2 หยด แล้วหลับตา.", "หยอดตาขวา ครั้งละ 2 หยด."])
  if (!completeThaiDose(text, "หยอด", "หยด", 2))
    throw new Error("Complete-dose oracle rejected the authored site placement");
for (const test of cases) {
  if (!filter.test(test.name)) continue;
  if (typeof baseline[test.api] !== "function") continue;
  if (nativeUnavailable.has(test.name)) {
    const unavailable = { api: test.api, name: test.name, reason: nativeUnavailable.get(test.name) };
    report.unavailable.push(unavailable);
    console.error("UNAVAILABLE", test.name, unavailable.reason);
    checkpoint();
    continue;
  }
  try {
    let left = test.run(baseline, 0), right = test.run(candidate, 0);
    const async = !!left?.then || !!right?.then;
    if (async) { left = await left; right = await right; }
    const oracle = equivalenceOracles.get(test.name);
    if (oracle && !oracle(right)) throw new Error("Candidate failed the independent clinical preview oracle");
    const equivalentWork = !oracle || oracle(left);
    const equivalence = { equivalentWork, ...(equivalentWork ? {} : {
      ...(equivalenceDetails.get(test.name) ?? {
        classification: "different-clinical-output",
        reason: "Baseline does not render the edited dose; raw timings retained without a regression verdict",
      }),
      output: { baseline: left, candidate: right },
    }) };
    if (smoke) {
      report.cases.push({ name: test.name, api: test.api, smoke: true, ...equivalence });
      continue;
    }
    for (let i = 0; i < 12; i++) {
      if (async) {
        await test.run(baseline, i);
        await test.run(candidate, i);
      } else {
        test.run(baseline, i);
        test.run(candidate, i);
      }
    }
    const iterations = await calibratedIterations(test, [baseline, candidate], async);
    const a = [],
      b = [];
    for (let r = 0; r < rounds; r++) {
      if (global.gc) global.gc();
      if (r % 2) {
        b.push(await measure(test, candidate, iterations, async));
        a.push(await measure(test, baseline, iterations, async));
      } else {
        a.push(await measure(test, baseline, iterations, async));
        b.push(await measure(test, candidate, iterations, async));
      }
    }
    const old = median(a),
      current = median(b),
      ratio = median(b.map((value, index) => value / a[index]));
    const result = {
      name: test.name,
      api: test.api,
      domain: test.domain,
      iterations,
      baselineUs: old,
      candidateUs: current,
      ratio,
      samples: { baselineUs: a, candidateUs: b },
      changePercent: (ratio - 1) * 100,
      ...equivalence,
      ...(equivalentWork ? { pass: ratio <= 1 + maxRegression } : {}),
      baselineSpread: (Math.max(...a) - Math.min(...a)) / old,
      candidateSpread: (Math.max(...b) - Math.min(...b)) / current,
    };
    report.cases.push(result);
    console.log(
      `${!equivalentWork ? "DIFFERENT" : result.pass ? "PASS" : "FAIL"} ${test.name}: ${old.toFixed(2)} -> ${current.toFixed(
        2
      )} us (${result.changePercent.toFixed(1)}%)`
    );
  } catch (error) {
    report.errors.push({ name: test.name, error: String(error.stack ?? error) });
    console.error("ERROR", test.name, error.message);
  } finally {
    checkpoint();
  }
}
// New functions have no pre-refactor namesake. Measure them explicitly
// rather than exempt their costs from visibility or invent a false baseline.
// Clinical correctness of edits/projections is covered by native oracles.
const { source: nativeSource, textless: nativeTextless } = nativeFixtures.get(candidate) ?? {};
const nativeCases = [
  ["getEmaQuantityComparator", "getEmaQuantityComparator", () => candidateEmaComparator(emaComparatorQuantity)],
  ["importCanonicalCourse", "native/import-R6", () => candidate.importCanonicalCourse(complex)],
  ["importCanonicalCourse", "native/import-R5", () => candidate.importCanonicalCourse(parsed.eye.fhir)],

  ["projectCanonicalCourse", "native/project-both", () => candidate.projectCanonicalCourse(nativeSource)],
  [
    "formatCanonicalAdministration",
    "native/format-administration",
    () =>
      candidate.formatCanonicalAdministration(nativeTextless.stages[0].administrations[0], "long", {
        locale: "th",
      }),
  ],
  [
    "formatCanonicalCourse",
    "native/format-course",
    () => candidate.formatCanonicalCourse(nativeTextless, "long", { locale: "th" }),
  ],
  ["projectEditableR5Course", "native/project-editable-R5", () => candidate.projectEditableR5Course(complex)],
];
report.newApiMeasurements = [];
for (const [api, name, run] of nativeCases) {
  if (!filter.test(name) || typeof baseline[api] === "function") continue;
  try {
    run();
    if (smoke) {
      report.newApiMeasurements.push({ api, name, smoke: true });
      continue;
    }
    const test = { run };
    for (let i = 0; i < 12; i++) run();
    const iterations = await calibratedIterations(test, [candidate], false);
    const times = [];
    for (let r = 0; r < rounds; r++) {
      if (global.gc) global.gc();
      times.push(await measure(test, candidate, iterations, false));
    }
    const candidateUs = median(times);
    report.newApiMeasurements.push({
      api,
      name,
      iterations,
      candidateUs,
      spread: (Math.max(...times) - Math.min(...times)) / candidateUs,
    });
    console.log(`NEW ${name}: ${candidateUs.toFixed(2)} us (no previous API baseline)`);
  } catch (error) {
    report.errors.push({ name, error: String(error.stack ?? error) });
    console.error("ERROR", name, error.message);
  } finally {
    checkpoint();
  }
}
if (!report.cases.length && !report.newApiMeasurements.length)
  report.errors.push({ name: "selection", error: "--only selected no runnable benchmark scenarios" });
report.passing = report.cases.filter((c) => c.pass || c.smoke).length;
report.failing = report.cases.filter((c) => c.pass === false).length;
checkpoint(true);
console.log(
  JSON.stringify({
    covered: report.coveredPublicFunctions,
    total: report.publicFunctions,
    newApis: report.newApis,
    newApiMeasurements: report.newApiMeasurements.length,
    cases: report.cases.length,
    passing: report.passing,
    failing: report.failing,
    unavailable: report.unavailable,
    errors: report.errors,
  })
);
if (report.errors.length || report.failing || report.unavailable.length) process.exitCode = 1;
