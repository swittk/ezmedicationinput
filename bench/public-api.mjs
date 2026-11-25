/** Short paired hot-path performance diagnostic.
 *
 * Usage: node --expose-gc bench/public-api.mjs --baseline /path/to/dist/index.js
 *   [--only regex | --all] [--meaningful] [--rounds 6] [--target-ms 8] [--smoke] [--json report.json]
 *
 * The default covers representative parse, format, FHIR, scheduling, supply and
 * suggestion workflows. --only selects a suspect workflow; --all opts into the
 * complete existing scenario inventory. No exhaustive sweep or confirmation is
 * required. Paired warm runs share inputs and invocation counts.
 *
 * Judge absolute latency, frequency, spread and reproducibility, not an arbitrary
 * relative cutoff. Investigate significant common-workload regressions with a
 * focused measurement. Meaningful workloads retain the 4% limit. The indicative
 * 0.5 ms boundary avoids mechanical failures for tiny noisy calls; those still
 * need absolute-time and call-volume review. Use --meaningful with --only when a
 * frequently called fast workflow has meaningful cumulative impact. Unavailable
 * scenarios and clinical correctness errors also fail.
 */
import { performance } from "node:perf_hooks";
import { readFileSync, writeFileSync, renameSync, realpathSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const argv = process.argv.slice(2),
  value = (flag, fallback) => {
    const i = argv.indexOf(flag);
    if (i < 0) return fallback;
    const operand = argv[i + 1];
    if (!operand || operand.startsWith("--")) throw new Error(flag + " requires a value");
    return operand;
  };
const baselinePath = value("--baseline", process.env.EZMED_BASELINE);
if (!baselinePath) throw new Error("Supply --baseline pointing to the built origin/master package");
const representative = [
  "parseSig/ordinary", "parseSig/thai", "parseSig/staged",
  "formatSig/R5/en", "formatSig/R6-source-less/th",
  "fromFhir/simple/en", "fromFhirDosage/en",
  "toDosageDetails/simple", "toFhirR5Dosages/R6-simple",
  "nextDueDoses/scalar", "calculateTotalUnits/scalar",
  "suggestSig/1 tab po q", "suggestSig/กิน",
];
const all = argv.includes("--all");
const filter = new RegExp(value("--only", all ? "." : "^(?:" + representative.join("|") + ")$")),
  requestedRounds = Number(value("--rounds", "6"));
const targetMs = Number(value("--target-ms", "8")),
  smoke = argv.includes("--smoke");
if (!smoke && (!Number.isInteger(requestedRounds) || requestedRounds < 1))
  throw new Error("--rounds must be a positive integer for timed measurements");
if (!smoke && (!Number.isFinite(targetMs) || targetMs <= 0))
  throw new Error("--target-ms must be finite and greater than zero for timed measurements");
// Every timed comparison has equally many baseline-first and candidate-first
// batches. Preserve the requested minimum, including historical odd inputs.
const rounds = requestedRounds + requestedRounds % 2;
const candidateFirst = argv.includes("--candidate-first");
const maxRegression = 0.04;
const indicativeMeaningfulUs = 500;
const forceMeaningful = argv.includes("--meaningful");
const outputPath = value("--json", undefined);
const report = {
  mode: smoke ? "smoke" : "timed",
  complete: false,
  startedAt: new Date().toISOString(),
  phase: "initializing",
  cases: [],
  newApiMeasurements: [],
  newApiSmokeChecks: [],
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
  const timed = report.cases.filter(c => !c.smoke);
  const checked = report.cases.filter(c => c.smoke);
  report.timedComparisons = timed.length;
  report.smokeComparisons = checked.length;
  report.meaningfulRegressions = 0;
  report.fastTimingReview = 0;
  for (const result of timed) {
    if (!result.overRegressionLimit) continue;
    if (result.meaningfulTime) report.meaningfulRegressions++;
    else report.fastTimingReview++;
  }
  report.nonEquivalent = report.cases.filter((c) => c.equivalentWork === false).length;
  report.measuredPublicFunctions = new Set([
    ...timed.map(c => c.api), ...report.newApiMeasurements.map(c => c.api),
  ]).size;
  report.smokePublicFunctions = new Set([
    ...checked.map(c => c.api), ...report.newApiSmokeChecks.map(c => c.api),
  ]).size;
  if (outputPath) {
    const temporary = outputPath + "." + randomUUID() + ".tmp";
    writeFileSync(temporary, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    renameSync(temporary, outputPath);
  }
}
checkpoint();
// Report path resolution, imports and untimed fixture preparation together.
try {
const baselineEntry = realpathSync(resolve(baselinePath));
const candidateEntry = realpathSync(fileURLToPath(new URL("../dist/index.js", import.meta.url)));
if (baselineEntry === candidateEntry)
  throw new Error("--baseline must be a separate built module, not the candidate entrypoint");
const baseline = await import(pathToFileURL(baselineEntry).href);
const candidate = await import(pathToFileURL(candidateEntry).href);
const emaComparatorQuantity = { extension: [{
  url: candidate.EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
  valueCoding: { system: candidate.EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000055" },
}] };
const candidateEmaComparator = candidate.getEmaQuantityComparator;
if (filter.test("getEmaQuantityComparator") && candidateEmaComparator(emaComparatorQuantity) !== "~")
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
// This decoder fixture is independently encoded and constructed only for
// selected consumers; an older module need not export its builder or decoder.
const counted = ["parseBodySiteAdministrationTargetCountExtension", "getBodySiteAdministrationTargetCount"]
  .some(name => filter.test(name))
  ? { extension: [{ url: "urn:ezmedicationinput:body-site-administration-target-count", valueInteger: 2 }] }
  : undefined;
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
const authoredGraphSource = "ล้างมือก่อนหยอดตา หยอดตาขวา 1 หยด แล้วหลับตา";
const authoredGraphRow = baseline.parseSig(authoredGraphSource, { locale: "th" }).fhir[0];
const copiedAuthoredGraphRow = structuredClone(authoredGraphRow);
const editedGraphRow = structuredClone(authoredGraphRow);
if (!editedGraphRow?.doseAndRate?.[0]?.doseQuantity)
  throw new Error("Authoritative roundtrip benchmark requires the parsed quantity");
editedGraphRow.doseAndRate[0].doseQuantity.value = 2;
const amountlessGraphSource = "ผสมน้ำแล้วดื่ม";
const amountlessGraphRow = baseline.parseSig(amountlessGraphSource, { locale: "th" }).fhir[0];
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
// Keep the shared legacy batches above, and also measure each build's usual
// parse-then-format path. Parsing these fixtures is outside all timed work.
for (const key of ["ordinary", "staged"]) {
  const ownBatch = new Map([[baseline, parsed[key]]]);
  add("formatParseBatch", "formatParseBatch/" + key + "-own-batch", (m) =>
    m.formatParseBatch(ownBatch.get(m), "long"));
  // Prepare only selected fixtures, before probing or measuring the formatter.
  cases[cases.length - 1].setup = () => ownBatch.set(candidate, candidate.parseSig(S[key]));
}
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
// Retain the established warm workload across 97 distinct calendar dates.
const variedDates = Array.from({ length: 97 }, (_, i) =>
  new Date(Date.UTC(2026, 0, 1 + i * 7, 1)).toISOString()
);
add("nextDueDoses", "nextDueDoses/varied-calendars", (m, i) => {
  const d = variedDates[i % variedDates.length];
  return m.nextDueDoses(rows[0], { ...schedule, from: d, orderedAt: d });
});
// A separate fresh workload advances the same ordinal in each build through
// probes, warmup, calibration and measured rounds. Negative millisecond offsets
// retain the morning dose and the existing 2026-27 calendar range.
// The warm varied case must not seed the first fresh-calendar input instants.
const freshCalendarBases = variedDates.map(date => new Date(date).getTime() - 1);
const freshCalendarState = new Map([baseline, candidate].map(m =>
  [m, { nextOrdinal: 0, blocks: [] }]));
function freshCalendarDate(ordinal) {
  return new Date(freshCalendarBases[ordinal % freshCalendarBases.length] -
    Math.floor(ordinal / freshCalendarBases.length)).toISOString();
}
function prepareFreshCalendars(module, iterations) {
  const state = freshCalendarState.get(module);
  const startOrdinal = state.nextOrdinal;
  const queries = Array.from({ length: iterations }, (_, i) => {
    const date = freshCalendarDate(startOrdinal + i);
    return { ...schedule, from: date, orderedAt: date };
  });
  state.nextOrdinal += iterations;
  state.blocks.push({
    startOrdinal, iterations, first: queries[0].from, last: queries[iterations - 1].from,
  });
  return i => module.nextDueDoses(rows[0], queries[i]);
}
add("nextDueDoses", "nextDueDoses/fresh-calendars", m => prepareFreshCalendars(m, 1)(0));
cases[cases.length - 1].prepare = prepareFreshCalendars;
// Check the first wrap explicitly, outside timing and without advancing either
// build's execution sequence or touching the production calendar cache.
const freshCalendarCheck = Array.from({ length: 195 }, (_, i) => freshCalendarDate(i));
if (freshCalendarDate(0) !== "2026-01-01T00:59:59.999Z" ||
    freshCalendarDate(97) !== "2026-01-01T00:59:59.998Z" ||
    freshCalendarDate(194) !== "2026-01-01T00:59:59.997Z" ||
    new Set(freshCalendarCheck).size !== 195 || freshCalendarCheck.some(date => variedDates.includes(date)))
  throw new Error("Fresh-calendar fixture must retain distinct valid query instants disjoint from the varied case");
function expectedFreshCalendarDoses(year) {
  const expected = [];
  for (const day of ["01", "02", "03"])
    for (const clock of ["08:00:00", "20:00:00"])
      expected.push(year + "-01-" + day + "T" + clock + "+07:00");
  return expected;
}
// Use a held-out year so this oracle does not warm measured input instants.
if (filter.test("nextDueDoses/fresh-calendars")) {
  const warm = "2025-01-01T01:00:00.000Z", fresh = "2025-01-01T00:59:59.999Z";
  for (const module of [baseline, candidate]) {
    const expected = JSON.stringify(expectedFreshCalendarDoses(2025));
    const ordinary = module.nextDueDoses(rows[0], { ...schedule, from: warm, orderedAt: warm });
    const actual = module.nextDueDoses(rows[0], { ...schedule, from: fresh, orderedAt: fresh });
    if (JSON.stringify(ordinary) !== expected || JSON.stringify(actual) !== expected)
      throw new Error("Fresh-calendar offsets must preserve all six independently expected administrations");
  }
}
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
  const fixtures = {}, errors = {};
  for (const [name, input] of [["source", complex], ["textless", textlessWire]]) {
    if (typeof m.importCanonicalCourse !== "function") {
      errors[name] = "version has no importCanonicalCourse for a compatible native fixture";
      continue;
    }
    try {
      fixtures[name] = m.importCanonicalCourse(input);
    } catch (error) {
      errors[name] = String(error.message ?? error);
    }
  }
  nativeFixtures.set(m, fixtures);
  nativeFixtureErrors.set(m, errors);
}
function addNative(api, name, run, needsFixture) {
  add(api, name, run);
  if (typeof baseline[api] !== "function") return;
  for (const [label, m] of [["baseline", baseline], ["candidate", candidate]]) {
    if (typeof m[api] !== "function") {
      nativeUnavailable.set(name, `${label} does not export ${api}`);
      break;
    }
    if (needsFixture && nativeFixtures.get(m)?.[needsFixture] === undefined) {
      nativeUnavailable.set(name, label + ": " + nativeFixtureErrors.get(m)?.[needsFixture]);
      break;
    }
  }
}
addNative("importCanonicalCourse", "native/import-R6", (m) => m.importCanonicalCourse(complex));
addNative("importCanonicalCourse", "native/import-R5", (m) => m.importCanonicalCourse(parsed.eye.fhir));
addNative("projectCanonicalCourse", "native/project-both", (m) => m.projectCanonicalCourse(nativeFixtures.get(m).source), "source");
addNative("formatCanonicalAdministration", "native/format-administration", (m) =>
  m.formatCanonicalAdministration(nativeFixtures.get(m).textless.stages[0].administrations[0], "long", { locale: "th" }), "textless");
addNative("formatCanonicalCourse", "native/format-course", (m) =>
  m.formatCanonicalCourse(nativeFixtures.get(m).textless, "long", { locale: "th" }), "textless");
addNative("projectEditableR5Course", "native/project-editable-R5", (m) => m.projectEditableR5Course(complex));
const newApis = new Set([...covered].filter(api =>
  typeof candidate[api] === "function" && typeof baseline[api] !== "function"));
const missing = Object.keys(candidate).filter(
  (key) => typeof candidate[key] === "function" && !covered.has(key)
);
if (all && missing.length)
  throw new Error("Uncovered public APIs: " + missing.join(", "));
if (counted) for (const module of [baseline, candidate]) {
  const decode = module.parseBodySiteAdministrationTargetCountExtension;
  if (typeof decode === "function" && decode(counted) !== 2)
    throw new Error("Target-count decoder fixture must exercise the encoded count, not an empty input");
}
Object.assign(report, {
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
  methodology:
    "Balanced alternating paired warm batches; median log paired ratio; helper exports captured before timing; no cross-domain averaging",
  meaningfulRegressionLimit: 1 + maxRegression,
  filter: filter.source,
  selectedComparisons: cases.filter(
    (test) => filter.test(test.name) && typeof baseline[test.api] === "function"
  ).length,
  requestedRounds,
  rounds,
  firstBatch: candidateFirst ? "candidate" : "baseline",
  pairsPerOrder: rounds / 2,
});
checkpoint();
const median = (values) => {
  const sorted = [...values].sort((x, y) => x - y), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
let sink;
async function measure(test, module, iterations, async) {
  // Only the fresh-calendar fixture prepares changing inputs here, before the
  // clock starts. Existing scenarios retain their established timed work.
  const invoke = test.prepare?.(module, iterations) ??
    test.direct?.get(module) ?? ((i) => test.run(module, i));
  const start = performance.now();
  if (async) for (let i = 0; i < iterations; i++) sink = await invoke(i);
  else for (let i = 0; i < iterations; i++) sink = invoke(i);
  return ((performance.now() - start) * 1000) / iterations;
}
/** Calibrate to steady-state duration, not a three-call pilot that can be
 * dominated by a first JIT transition for sub-microsecond getters. Both builds
 * use the identical final count and balanced paired ordering.
 * Calibrate to the slower side: a 100x speedup must not force 100x-longer
 * baseline batches merely to give the faster implementation a long sample. */
async function calibratedIterations(test, modules, async) {
  // Scale the ceiling with the requested duration so tiny cached getters can
  // reach it when a focused investigation requests longer batches.
  const maxIterations = Math.max(1000000, Math.ceil(targetMs * 1000 / 0.005));
  let iterations = 4;
  for (let attempt = 0; attempt < 7; attempt++) {
    let slowest = 0;
    for (const module of modules) slowest = Math.max(slowest, await measure(test, module, iterations, async));
    if (slowest * iterations >= targetMs * 800 || iterations >= maxIterations) return iterations;
    const required = Math.ceil((targetMs * 1000) / Math.max(slowest, 0.005));
    iterations = Math.min(maxIterations, Math.max(iterations * 2, Math.min(iterations * 16, required)));
  }
  return iterations;
}
// These edit cases have an independent clinical oracle. An older formatter
// that returns the superseded quantity is doing different work; keep both
// timings visible but apply the latency gate only when both render the edit.
function completeThaiDose(output, action, unit, expected, requiredSite) {
  if (typeof output !== "string") return false;
  const number = "([+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+))";
  const verb = action === "หยอด" ? "หยอด(?:\\s*ตาขวา)?" : action;
  // These two fixtures retain their authored preparation before the dose.
  // Accept that complete prefix, never an arbitrary substring after a negator.
  const preparation = action === "หยอด" ? "ล้างมือก่อนหยอดตา" : "ผสมน้ำ";
  const lead = "^\\s*(?:" + preparation + "\\s*(?:[.;,]\\s*)?(?:(?:จากนั้น|แล้ว)\\s*)?)?";
  const siteAfter = action === "หยอด" ? "(?:\\s*(?:ที่)?ตาขวา)?" : "";
  const phrase = new RegExp(lead + verb + "\\s*(?:ครั้งละ\\s*)?" +
    number + "\\s*" + unit + siteAfter + "(?=$|[\\s.;,])", "u").exec(output);
  const quantities = [...output.matchAll(new RegExp("(?<![\\d.])" + number +
    "\\s*" + unit + "(?=$|[\\s.;,])", "gu"))];
  return phrase !== null && Number(phrase[1]) === expected && quantities.length === 1 &&
    Number(quantities[0][1]) === expected && (!requiredSite || phrase[0].includes(requiredSite));
}
function completeThaiRightEyeDose(output) {
  if (!completeThaiDose(output, "หยอด", "หยด", 2, "ตาขวา") || output.includes("ตาซ้าย")) return false;
  const preparation = "ล้างมือก่อนหยอดตา";
  const wash = output.indexOf(preparation);
  const dose = output.indexOf("หยอด", wash + preparation.length);
  const afterDose = output.slice(output.indexOf("หยด", dose) + "หยด".length);
  return wash >= 0 && dose > wash &&
    /^(?:\s*(?:ที่)?ตาขวา)?\s*[.;,]?\s*(?:(?:จากนั้น|แล้ว)\s*)?หลับตา[.;,]?\s*$/u.test(afterDose);
}
function completeThaiPreparedDrink(output) {
  return completeThaiDose(output, "ดื่ม", "เม็ด", 2) &&
    /^\s*ผสมน้ำ\s*(?:[.;,]\s*)?(?:(?:จากนั้น|แล้ว)\s*)?ดื่ม\s*(?:ครั้งละ\s*)?\+?2(?:\.0+)?\s*เม็ด\s*[.;,]?\s*$/u.test(output);
}
function completeStagedBatch(output) {
  if (typeof output !== "string") return false;
  const stages = output.trim().replace(/\s+/gu, " ").split(" then ");
  const finalDose = /^([+]?(?:\d+(?:\.\d+)?|\.\d+))(?:\/([+]?(?:\d+(?:\.\d+)?|\.\d+)))? tab PO on ([A-Za-z]+-[A-Za-z]+)$/u.exec(stages[2] ?? "");
  const finalAmount = finalDose
    ? Number(finalDose[1]) / (finalDose[2] === undefined ? 1 : Number(finalDose[2])) : NaN;
  return stages.length === 3 &&
    stages[0] === "2 tabs morning, 1 tab evening for 1 week" &&
    stages[1] === "2 tabs morning for 1 month" &&
    finalAmount === 0.5 && finalDose[3].toLowerCase() === "monday-friday";
}
const scalarScheduleControl = [
  "2026-11-18T08:00:00+07:00", "2026-11-18T20:00:00+07:00",
  "2026-11-19T08:00:00+07:00", "2026-11-19T20:00:00+07:00",
  "2026-11-20T08:00:00+07:00", "2026-11-20T20:00:00+07:00",
];
const scalarScheduleInstants = scalarScheduleControl.map(value => Date.parse(value));
function completeScalarSchedule(output) {
  return Array.isArray(output) && output.length === scalarScheduleInstants.length &&
    scalarScheduleInstants.every((instant, index) => typeof output[index] === "string" &&
      Date.parse(output[index]) === instant);
}
// The first ten administrations in the two-eye fixture: right Q2H from
// midnight, left QID at 08/12/16/20. Each eye keeps its own occurrence.
const parallelScheduleControl = [
  "2026-11-18T00:00:00+07:00", "2026-11-18T02:00:00+07:00",
  "2026-11-18T04:00:00+07:00", "2026-11-18T06:00:00+07:00",
  "2026-11-18T08:00:00+07:00", "2026-11-18T08:00:00+07:00",
  "2026-11-18T10:00:00+07:00", "2026-11-18T12:00:00+07:00",
  "2026-11-18T12:00:00+07:00", "2026-11-18T14:00:00+07:00",
];
const parallelScheduleInstants = parallelScheduleControl.map(value => Date.parse(value));
function requireParallelSchedule(output) {
  if (!Array.isArray(output) || output.length !== parallelScheduleInstants.length ||
      !parallelScheduleInstants.every((instant, index) => typeof output[index] === "string" &&
        Date.parse(output[index]) === instant))
    throw new Error("Parallel schedule failed the independent ten-administration oracle");
  return true;
}
const equivalenceOracles = new Map([
  ["nextDueDoses/scalar", completeScalarSchedule],
  ["nextDueDoses/parallel-array", requireParallelSchedule],
  ["formatSig/R5-roundtrip-edited-thai", output =>
    verifiedPreviewOrSource(output, completeThaiRightEyeDose(output), authoredGraphSource)],
  ["formatSig/R5-roundtrip-added-dose-thai", output =>
    verifiedPreviewOrSource(output, completeThaiPreparedDrink(output), amountlessGraphSource)],
  ["formatParseBatch/staged-own-batch", completeStagedBatch],
]);
// Source-bearing R6 fixtures used to return the saved input verbatim. The
// current public contract generates requested previews from editable facts.
// These ordered clinical phrases cover every phase, both eyes, and cadence;
// keep raw latency visible when an older build does only source replay.
const complexPreviewPhrases = {
  en: [
    "From treatment start until 7 days after treatment start", "Instill 1 drop every 2 hours in the right eye", "Instill 1 drop four times daily in the left eye",
    "From 7 days after treatment start until 1 month after treatment start",
    "Instill 1 drop four times daily in the right eye", "Instill 1 drop four times daily in the left eye",
    "From 1 month after treatment start onward", "Instill 1 drop four times daily in the right eye",
    "Instill 1 drop twice daily in the left eye",
  ],
  th: [
    "ตั้งแต่เริ่มการรักษาจนถึง7 วันหลังเริ่มการรักษา", "หยอดตาขวา ครั้งละ 1 หยด ทุก 2 ชั่วโมง", "หยอดตาซ้าย ครั้งละ 1 หยด วันละ 4 ครั้ง",
    "ตั้งแต่7 วันหลังเริ่มการรักษาจนถึง1 เดือนหลังเริ่มการรักษา",
    "หยอดตาขวา ครั้งละ 1 หยด วันละ 4 ครั้ง", "หยอดตาซ้าย ครั้งละ 1 หยด วันละ 4 ครั้ง",
    "ตั้งแต่1 เดือนหลังเริ่มการรักษาเป็นต้นไป", "หยอดตาขวา ครั้งละ 1 หยด วันละ 4 ครั้ง",
    "หยอดตาซ้าย ครั้งละ 1 หยด วันละ 2 ครั้ง",
  ],
};
function normalizeClinicalPreview(output) {
  // Formatting separators/spacing do not change the fixture's meaning.
  // Keep words, numeric signs, range dashes and comparison operators intact.
  return output.replace(/[+-]?(?:\d+(?:\.\d+)?|\.\d+)/gu, token => String(Number(token)))
    .replace(/\.(?=\s|$)/gu, "").replace(/[\s,;:]+/gu, "").toLowerCase();
}
// The left-eye month already ends at the explicit global month boundary.
// Stating that same full length at its own start is equivalent for this fixture.
const expectedComplexPreview = Object.fromEntries(
  Object.entries(complexPreviewPhrases).map(([locale, phrases]) => {
    const withInitialLength = phrases.slice();
    withInitialLength[2] = locale === "en"
      ? "Instill 1 drop four times daily for 1 month in the left eye"
      : "หยอดตาซ้าย ครั้งละ 1 หยด วันละ 4 ครั้ง เป็นเวลา 1 เดือน";
    return [locale, new Set([normalizeClinicalPreview(phrases.join(" ")),
      normalizeClinicalPreview(withInitialLength.join(" "))])];
  }));
function currentComplexPreview(output, locale) {
  return typeof output === "string" &&
    expectedComplexPreview[locale].has(normalizeClinicalPreview(output));
}
// Independent R5 output facts for the two-eye taper. These are not read back
// through either build's importer, and remain outside every timed invocation.
const complexRowFacts = [
  [1, "1290032005", 1, 2, "h", "Q2H", [0, "d"], null, [7, "d"]],
  [1, "1290031003", 4, 1, "d", "QID", [0, "d"], null, [7, "d"]],
  [2, "1290032005", 4, 1, "d", "QID", [7, "d"], [7, "d"], [1, "mo"]],
  [2, "1290031003", 4, 1, "d", "QID", [0, "d"], [7, "d"], [1, "mo"]],
  [3, "1290032005", 4, 1, "d", "QID", [7, "d"], [1, "mo"], null],
  [3, "1290031003", 2, 1, "d", "BID", [1, "mo"], [1, "mo"], null],
];
function completeComplexRows(output) {
  const rows = output?.fhir;
  if (!Array.isArray(rows) || rows.length !== complexRowFacts.length) return false;
  const oneCode = (concept, system, code) => concept?.coding?.length === 1 &&
    concept.coding[0].system === system && concept.coding[0].code === code;
  const quantity = value => value?.system === "http://unitsofmeasure.org" &&
    value.unit === value.code ? [value.value, value.code] : false;
  const boundary = (step, name) => {
    const value = step?.extension?.find(part => part.url === name);
    if (!value) return null;
    const context = value.extension?.find(part => part.url === "contextCode")?.valueCodeableConcept;
    return oneCode(context, "http://hl7.org/fhir/evidence-variable-event", "treatment-start")
      ? quantity(value.extension?.find(part => part.url === "offsetDuration")?.valueQuantity) : false;
  };
  // Iterate the required positions: a sparse six-slot array is not six rows.
  return complexRowFacts.every((expected, index) => {
    const row = rows[index], amount = row?.doseAndRate?.[0]?.doseQuantity;
    if (!row || (row.asNeeded !== undefined && row.asNeeded !== false) || row.asNeededFor?.length ||
        row.doseAndRate?.length !== 1 || amount?.value !== 1 || amount.unit !== "drop" ||
        amount.comparator !== undefined || amount.extension?.some(extension =>
          extension.url === "http://ema.europa.eu/fhir/extension/comparator" &&
          extension.valueCoding?.system === "http://spor.ema.europa.eu/v1/lists/100000000008" &&
          extension.valueCoding.code !== "100000000049") ||
        amount.system !== "http://standardterms.edqm.eu" || amount.code !== "15022000" ||
        !oneCode(row.route, "http://snomed.info/sct", "54485002") ||
        !oneCode(row.site, "http://snomed.info/sct", expected[1]) ||
        !oneCode(row.timing?.code, "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", expected[5]))
      return false;
    const details = row.modifierExtension?.find(part =>
      part.url === "urn:ezmedicationinput:StructureDefinition:medication-r6-course-details");
    const part = name => details?.extension?.find(value => value.url === name);
    if (part("rowIndex")?.valueInteger !== index || part("sequence")?.valueInteger !== expected[0] ||
        part("stepCount")?.valueInteger !== 3) return false;
    const repeat = row.timing?.repeat, step = part("step");
    if (repeat?.count !== undefined || repeat?.countMax !== undefined || repeat?.dayOfWeek?.length ||
        (repeat?.frequencyMax !== undefined && repeat.frequencyMax !== expected[2]) ||
        (repeat?.periodMax !== undefined && repeat.periodMax !== expected[3])) return false;
    // The final left-eye BID phase is ongoing. A standard repeat bound must
    // not silently shorten it while the retained step still looks open-ended.
    if (index === 5 && (repeat?.boundsDuration !== undefined || repeat?.boundsRange !== undefined ||
        repeat?.boundsPeriod !== undefined)) return false;
    const origin = row.modifierExtension?.find(part =>
      part.url === "urn:ezmedicationinput:StructureDefinition:medication-parallel-component-phase-origin");
    return JSON.stringify([row.sequence, expected[1], repeat?.frequency ?? 1,
      repeat?.period, repeat?.periodUnit, expected[5], quantity(origin?.valueQuantity),
      boundary(step, "start"), boundary(step, "end")]) === JSON.stringify(expected);
  });
}
// Clinical oracle controls stay outside every measured invocation.
if (filter.test("fromFhir/complex/en") || filter.test("fromFhir/complex/th")) {
  const ongoingBidControl = baseline.fromFhir(complex, { locale: "en" });
  if (!completeComplexRows(ongoingBidControl))
    throw new Error("Six-row oracle rejected the complete unbounded BID control");
  const conditional = structuredClone(ongoingBidControl);
  delete conditional.fhir[5].asNeeded;
  conditional.fhir[5].asNeededFor = [{ text: "eye discomfort" }];
  if (completeComplexRows(conditional))
    throw new Error("Six-row oracle accepted an as-needed indication");
  const weekdaysOnly = structuredClone(ongoingBidControl);
  weekdaysOnly.fhir[5].timing.repeat.dayOfWeek = ["mon", "tue", "wed", "thu", "fri"];
  if (completeComplexRows(weekdaysOnly))
    throw new Error("Six-row oracle accepted a weekday-restricted daily phase");
  const qualifiedDose = structuredClone(ongoingBidControl);
  qualifiedDose.fhir[0].doseAndRate[0].doseQuantity.extension = [{
    url: "http://ema.europa.eu/fhir/extension/comparator",
    valueCoding: { system: "http://spor.ema.europa.eu/v1/lists/100000000008", code: "100000000050" },
  }];
  if (completeComplexRows(qualifiedDose))
    throw new Error("Six-row oracle accepted a qualified one-drop dose");
  for (const bound of [{ boundsDuration: { value: 1, unit: "d", code: "d", system: "http://unitsofmeasure.org" } },
    { boundsRange: { low: { value: 1, unit: "d" }, high: { value: 2, unit: "d" } } },
    { boundsPeriod: { end: "2026-12-01T00:00:00Z" } }]) {
    const shortened = structuredClone(ongoingBidControl);
    Object.assign(shortened.fhir[5].timing.repeat, bound);
    if (completeComplexRows(shortened))
      throw new Error("Six-row oracle accepted a bounded ongoing BID phase");
  }
  for (const periodMax of [2, 4]) {
    const cadence = structuredClone(ongoingBidControl);
    cadence.fhir[0].timing.repeat.periodMax = periodMax;
    if (completeComplexRows(cadence) !== (periodMax === 2))
      throw new Error("Six-row oracle failed the fixed Q2H period control");
  }
  for (const frequencyMax of [2, 3]) {
    const cadence = structuredClone(ongoingBidControl);
    cadence.fhir[5].timing.repeat.frequencyMax = frequencyMax;
    if (completeComplexRows(cadence) !== (frequencyMax === 2))
      throw new Error("Six-row oracle must preserve the fixed twice-daily cadence");
  }
}
for (const locale of ["en", "th"]) {
  const exact = complexPreviewPhrases[locale].join(". ");
  if (!currentComplexPreview(exact, locale))
    throw new Error("Complex preview oracle rejected its six exact administrations");
  const initialLength = locale === "en"
    ? "Instill 1 drop four times daily for 1 month in the left eye"
    : "หยอดตาซ้าย ครั้งละ 1 หยด วันละ 4 ครั้ง เป็นเวลา 1 เดือน";
  if (!currentComplexPreview(exact.replace(complexPreviewPhrases[locale][2], initialLength), locale))
    throw new Error("Complex preview oracle rejected the same authored month at its own origin");
  const wrongPhase = complexPreviewPhrases[locale].slice();
  wrongPhase[5] = initialLength;
  if (currentComplexPreview(wrongPhase.join(". "), locale))
    throw new Error("Complex preview oracle accepted a restarted month in the copied phase");
  for (const amount of ["11", "1.2", "-1", "2", ".1", "0.1"])
    if (currentComplexPreview(exact.replace(/1 (drop|หยด)/u, amount + " $1"), locale))
      throw new Error("Complex preview oracle accepted a different numeric amount");
  if (currentComplexPreview(exact + (locale === "en" ? ". 1 drop" : ". 1 หยด"), locale))
    throw new Error("Complex preview oracle accepted an extra administration");
  if (currentComplexPreview(exact.replace(locale === "th" ? "7 วัน" : "7 days", locale === "th" ? "70 วัน" : "70 days"), locale))
    throw new Error("Complex preview oracle accepted a numeric endpoint suffix");
  if (!currentComplexPreview(exact.replace(/1 (drop|หยด)/u, "1.0 $1"), locale))
    throw new Error("Complex preview oracle rejected an equal decimal amount");
  const primary = complexPreviewPhrases[locale][1];
  for (const changed of [
    primary + (locale === "en" ? " as needed" : " ตามอาการ"),
    (locale === "en" ? "Do not " : "ห้าม") + primary,
  ])
    if (currentComplexPreview(exact.replace(primary, changed), locale))
      throw new Error("Complex preview oracle accepted a changed administration condition");
  if (!currentComplexPreview(exact.replaceAll(". ", ";\n  "), locale))
    throw new Error("Complex preview oracle rejected nonsemantic separators");
}
// A historical preview exclusion requires the exact authored source replay.
// Missing or unrelated output is an error, not evidence of different work.
function verifiedPreviewOrSource(output, current, savedSource) {
  if (current) return true;
  if (output === savedSource) return false;
  throw new Error("Preview is neither the independent current preview nor the saved-source fixture");
}
equivalenceOracles.set("nextDueDoses/fresh-calendars", output => {
  if (JSON.stringify(output) !== JSON.stringify(expectedFreshCalendarDoses(2026)))
    throw new Error("Fresh-calendar probe failed the independent six-administration oracle");
  return true;
});
const equivalenceDetails = new Map();
for (const name of ["formatSig/R5-roundtrip-edited-thai", "formatSig/R5-roundtrip-added-dose-thai"])
  equivalenceDetails.set(name, {
    classification: "different-clinical-output",
    reason: "Baseline replays the exact former source instead of rendering the edited dose; raw timings retained without a regression verdict",
  });
const sourcePreviewDifference = {
  classification: "different-preview-work",
  reason: "Baseline replays saved source instead of generating the requested current-field preview; raw timings retained without a regression verdict",
};
for (const locale of ["en", "th"]) {
  const formatName = `formatSig/R6-complex/${locale}`;
  const importName = `fromFhir/complex/${locale}`;
  equivalenceOracles.set(formatName, output =>
    verifiedPreviewOrSource(output, currentComplexPreview(output, locale), S.eye));
  equivalenceOracles.set(importName, output => {
    // Missing or wrong conversion work is an error for either build, even if
    // that build already differs in the historical source-preview behavior.
    if (!completeComplexRows(output))
      throw new Error("fromFhir failed the independent six-row R5 taper oracle");
    return verifiedPreviewOrSource(output?.longText, currentComplexPreview(output?.longText, locale), S.eye);
  });
  equivalenceDetails.set(formatName, sourcePreviewDifference);
  equivalenceDetails.set(importName, sourcePreviewDifference);
}
equivalenceOracles.set("formatSig/R6-author-source", output =>
  verifiedPreviewOrSource(output, output === "Take 1 tablet orally twice daily for 3 days.", S.routine));
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
for (const text of ["ล้างมือก่อนหยอดตา หยอดตาขวา 2 หยด แล้วหลับตา.",
  "ล้างมือก่อนหยอดตา หยอด 2 หยด ตาขวา แล้วหลับตา.",
  "ล้างมือก่อนหยอดตา จากนั้นหยอดตาขวา ครั้งละ 2 หยด จากนั้นหลับตา.",
  "ล้างมือก่อนหยอดตา. จากนั้นหยอดตาขวา 2 หยด แล้วหลับตา.",
  "ล้างมือก่อนหยอดตา; แล้วหยอดตาขวา 2 หยด แล้วหลับตา."])
  if (!completeThaiRightEyeDose(text))
    throw new Error("Complete-dose oracle rejected the authored site placement");
for (const text of ["หยอดตาขวา 2 หยด.", "หยอดตาขวา 2 หยด แล้วหลับตา.",
  "ล้างมือก่อนหยอดตา หยอดตาขวา 2 หยด.", "หลับตา ล้างมือก่อนหยอดตา หยอดตาขวา 2 หยด.", "หยอด 2 หยด.", "หยอด 2 หยด แล้วหลับตาขวา.", "หยอด 2 หยด ตาซ้าย.", "หยอดตาขวา 2 หยด แล้วหยอดตาซ้าย 2 หยด.", "ห้ามหยอดตาขวา 2 หยด.", "ไม่หยอด 2 หยด ตาขวา.",
  "ล้างมือก่อนหยอดตา จากนั้นห้ามหยอดตาขวา 2 หยด.", "ล้างมือก่อนหยอดตา ไม่หยอด 2 หยด ตาขวา.",
  "ล้างมือก่อนหยอดตา. จากนั้นห้ามหยอดตาขวา 2 หยด แล้วหลับตา.",
  "ล้างมือก่อนหยอดตา หยอดตาขวา 2 หยด แล้วไม่ต้องหลับตา.",
  "ล้างมือก่อนหยอดตา หยอดตาขวา 2 หยด แล้วห้ามหลับตา."])
  if (completeThaiRightEyeDose(text))
    throw new Error("Complete-dose oracle accepted a missing/conflicting eye or a negated administration");
if (!completeThaiPreparedDrink("ผสมน้ำ จากนั้นดื่มครั้งละ 2 เม็ด.") ||
    !completeThaiPreparedDrink("ผสมน้ำ. ดื่ม 2 เม็ด.") ||
    !completeThaiPreparedDrink("ผสมน้ำ. จากนั้นดื่มครั้งละ 2 เม็ด.") ||
    !completeThaiPreparedDrink("ผสมน้ำ;\nดื่มครั้งละ 2.0 เม็ด.") ||
    completeThaiPreparedDrink("ดื่มครั้งละ 2 เม็ด.") ||
    completeThaiPreparedDrink("ผสมน้ำ จากนั้นห้ามดื่มครั้งละ 2 เม็ด.") ||
    completeThaiPreparedDrink("ผสมน้ำ จากนั้นดื่มครั้งละ 2 เม็ด เมื่อมีอาการปวด"))
  throw new Error("Complete-dose oracle lost the preparation or unconditional administration");
const stagedBatchControl =
  "2 tabs morning, 1 tab evening for 1 week then 2 tabs morning for 1 month then 1/2 tab PO on monday-friday";
if (!completeStagedBatch(stagedBatchControl) ||
    !completeStagedBatch(stagedBatchControl.replaceAll(" then ", "\nthen  ")))
  throw new Error("Staged-batch oracle rejected the complete three-stage preview");
for (const spelling of ["Monday-Friday", "MONDAY-FRIDAY", "Monday-friday"])
  if (!completeStagedBatch(stagedBatchControl.replace("monday-friday", spelling)))
    throw new Error("Staged-batch oracle rejected equivalent weekday capitalization");
for (const amount of ["0.5", ".5", "0.50", "2/4"])
  if (!completeStagedBatch(stagedBatchControl.replace("1/2 tab", amount + " tab")))
    throw new Error("Staged-batch oracle rejected an equal half-tablet amount");
for (const changed of [
  stagedBatchControl.replace("2 tabs morning,", "1 tab morning,"),
  stagedBatchControl.replace("2 tabs morning for 1 month", "2 tabs evening for 1 month"),
  stagedBatchControl.replace("for 1 week", "for 2 weeks"),
  stagedBatchControl.replace("monday-friday", "monday"),
  ...["0.1", "1/20", "1.5", "-0.5", "1/0"].map(amount =>
    stagedBatchControl.replace("1/2 tab", amount + " tab")),
  stagedBatchControl.split(" then ").slice(0, 2).join(" then "),
])
  if (completeStagedBatch(changed))
    throw new Error("Staged-batch oracle accepted a changed or missing stage");
if (!completeScalarSchedule(scalarScheduleControl) ||
    !completeScalarSchedule(scalarScheduleControl.map(value => new Date(value).toISOString())))
  throw new Error("Scalar schedule oracle rejected the six expected BID administrations");
for (const changed of [
  [], Array(6), scalarScheduleControl.slice(0, -1),
  [...scalarScheduleControl, scalarScheduleControl[5]],
  [scalarScheduleControl[1], scalarScheduleControl[0], ...scalarScheduleControl.slice(2)],
  [scalarScheduleControl[0], scalarScheduleControl[0], ...scalarScheduleControl.slice(2)],
  ["2026-11-18T08:01:00+07:00", ...scalarScheduleControl.slice(1)],
])
  if (completeScalarSchedule(changed))
    throw new Error("Scalar schedule oracle accepted a missing, extra, duplicated, unordered or shifted administration");
// The exact parallel oracle accepts both authored simultaneous doses.
requireParallelSchedule(parallelScheduleControl);
requireParallelSchedule(parallelScheduleControl.map(value => new Date(value).toISOString()));
for (const changed of [
  undefined, [], Array(10), parallelScheduleControl.slice(0, -1),
  [...parallelScheduleControl, parallelScheduleControl[9]],
  [...new Set(parallelScheduleControl)],
  [...parallelScheduleControl.slice(0, 5), parallelScheduleControl[6], ...parallelScheduleControl.slice(6)],
  [...parallelScheduleControl.slice(0, 9), parallelScheduleControl[8]],
  [parallelScheduleControl[1], parallelScheduleControl[0], ...parallelScheduleControl.slice(2)],
  ["2026-11-18T00:01:00+07:00", ...parallelScheduleControl.slice(1)],
  parallelScheduleControl.slice(0, 5).concat(Array(1), parallelScheduleControl.slice(6)),
  parallelScheduleInstants,
]) {
  let rejected = false;
  try { requireParallelSchedule(changed); } catch { rejected = true; }
  if (!rejected) throw new Error("Parallel schedule oracle accepted wrong count, multiplicity, order or instants");
}
report.phase = smoke ? "smoke" : "measuring";
checkpoint();
const candidateOnlyCases = [];
for (const test of cases) {
  if (!filter.test(test.name)) continue;
  if (nativeUnavailable.has(test.name)) {
    const unavailable = { api: test.api, name: test.name, reason: nativeUnavailable.get(test.name) };
    report.unavailable.push(unavailable);
    console.error("UNAVAILABLE", test.name, unavailable.reason);
    checkpoint();
    continue;
  }
  if (typeof baseline[test.api] !== "function") {
    candidateOnlyCases.push(test);
    continue;
  }
  try {
    test.setup?.();
    // Complete each probe before starting the next. A rejected baseline
    // must not leave an already-started candidate promise unhandled.
    let left = test.run(baseline, 0);
    let async = !!left?.then;
    if (async) left = await left;
    let right = test.run(candidate, 0);
    if (right?.then) { async = true; right = await right; }
    const oracle = equivalenceOracles.get(test.name);
    if (oracle && !oracle(right)) throw new Error("Candidate failed the independent clinical preview oracle");
    const equivalentWork = !oracle || oracle(left);
    if (!equivalentWork && !equivalenceDetails.has(test.name))
      throw new Error("Baseline failed the independent clinical oracle for " + test.name);
    const equivalence = { equivalentWork, ...(equivalentWork ? {} : {
      ...equivalenceDetails.get(test.name),
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
      if ((r % 2 === 0) === candidateFirst) {
        b.push(await measure(test, candidate, iterations, async));
        a.push(await measure(test, baseline, iterations, async));
      } else {
        a.push(await measure(test, baseline, iterations, async));
        b.push(await measure(test, candidate, iterations, async));
      }
    }
    const old = median(a),
      current = median(b),
      // Log ratios make reciprocal order effects cancel symmetrically.
      // An arithmetic median of the two middle ratios biases even samples upward.
      ratio = Math.exp(median(b.map((value, index) => Math.log(value / a[index]))));
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
      changeUs: current - old,
      overRegressionLimit: equivalentWork && ratio > 1 + maxRegression,
      meaningfulTime: forceMeaningful || Math.max(old, current) >= indicativeMeaningfulUs,
      ...equivalence,
      baselineSpread: (Math.max(...a) - Math.min(...a)) / old,
      candidateSpread: (Math.max(...b) - Math.min(...b)) / current,
    };
    report.cases.push(result);
    console.log(
      (!equivalentWork ? "DIFFERENT " : result.overRegressionLimit
        ? result.meaningfulTime ? "REGRESSION " : "REVIEW " : "TIMING ") + test.name + ": " +
      old.toFixed(2) + " -> " + current.toFixed(2) + " us (" +
      ratio.toFixed(2) + "x, " + result.changePercent.toFixed(1) + "%; delta " +
      result.changeUs.toFixed(2) + " us; spread " +
      (result.baselineSpread * 100).toFixed(1) + "% -> " +
      (result.candidateSpread * 100).toFixed(1) + "%)"
    );
  } catch (error) {
    report.errors.push({ name: test.name, error: String(error.stack ?? error) });
    console.error("ERROR", test.name, error.message);
  } finally {
    if (test.name === "nextDueDoses/fresh-calendars") {
      const freshBaseline = freshCalendarState.get(baseline);
      const freshCandidate = freshCalendarState.get(candidate);
      const aligned = JSON.stringify(freshBaseline) === JSON.stringify(freshCandidate);
      report.freshCalendarPreparation = {
        policy: "97 weekly base instants plus one millisecond per 97-query cycle; prepared outside timing",
        baseline: freshBaseline, candidate: freshCandidate, aligned,
      };
      if (!aligned) report.errors.push({
        name: test.name, error: "Builds used different fresh-calendar query sequences",
      });
    }
    checkpoint();
  }
}
// New functions have no pre-refactor namesake. Measure them explicitly
// rather than exempt their costs from visibility or invent a false baseline.
// Clinical correctness of edits/projections is covered by native oracles.
for (const test of candidateOnlyCases) {
  const { api, name } = test;
  try {
    test.setup?.();
    const probe = test.run(candidate, 0);
    const async = !!probe?.then;
    const output = async ? await probe : probe;
    const oracle = equivalenceOracles.get(name);
    if (oracle && !oracle(output)) throw new Error("Candidate failed the independent clinical preview oracle");
    if (smoke) {
      report.newApiSmokeChecks.push({ api, name, smoke: true });
      continue;
    }
    for (let i = 0; i < 12; i++) {
      const warmup = test.run(candidate, i);
      if (async) await warmup;
    }
    const iterations = await calibratedIterations(test, [candidate], async);
    const times = [];
    for (let r = 0; r < rounds; r++) {
      if (global.gc) global.gc();
      times.push(await measure(test, candidate, iterations, async));
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
if (!report.cases.length && !report.newApiMeasurements.length && !report.newApiSmokeChecks.length)
  report.errors.push({ name: "selection", error: "--only selected no runnable benchmark scenarios" });
checkpoint(true);
console.log(
  JSON.stringify({
    mode: report.mode,
    covered: report.coveredPublicFunctions,
    total: report.publicFunctions,
    newApis: report.newApis,
    newApiMeasurements: report.newApiMeasurements.length,
    newApiSmokeChecks: report.newApiSmokeChecks.length,
    cases: report.cases.length,
    timedComparisons: report.timedComparisons,
    smokeComparisons: report.smokeComparisons,
    measuredPublicFunctions: report.measuredPublicFunctions,
    smokePublicFunctions: report.smokePublicFunctions,
    meaningfulRegressions: report.meaningfulRegressions,
    fastTimingReview: report.fastTimingReview,
    unavailable: report.unavailable,
    errors: report.errors,
  })
);
console.log("Meaningful workloads retain the 4% limit; selectively confirm suspects with --only. REVIEW marks fast timings needing absolute-latency, frequency and noise judgment, not automatic acceptance; use --meaningful when cumulative impact warrants the limit.");
if (report.errors.length || report.unavailable.length || report.meaningfulRegressions) process.exitCode = 1;
} catch (error) {
  const setup = report.phase === "initializing";
  report.phase = setup ? "setup-error" : "run-error";
  report.errors.push({ name: setup ? "setup" : "run", error: String(error.stack ?? error) });
  checkpoint();
  throw error;
}
