import { getTimingClocks } from "../src/fhir";
import { describe, expect, it } from "vitest";
import conditionBridgeDefinition from "../fhir/r5/medication-conditional-dose.json";
import renderedInstructionDefinition from "../fhir/r5/medication-rendered-instruction.json";
import conditionLogicDefinition from "../fhir/r6/medication-r6-condition-logic.json";
import {
  formatSig,
  calculateTotalUnits,
  getDosageAlternativeChoice,
  getDosageCondition,
  nextDueDoses,
  toDosageDetails,
  toFhirR5Dosages,
  parseSig as parseProductionSig
} from "../src/index";
import { parseSig, parseSigAsync } from "./helpers/r5-parser";
import { AdviceArgumentRole, FhirDosage } from "../src/types";
import { getDosageCalendarDayCondition, setDosageCondition } from "../src/dosage-course";
import { getCourseCycleCount } from "../src/dosage-course";
import { formatParseBatch } from "../src/index";
import { formatSigBatch } from "../src/index";
import { fromFhir } from "../src/index";
import { lintSig } from "../src/index";
import { parseSig as parsePublicSig } from "../src/index";
import { importCanonicalCourse } from "../src/index";
import { parseClauseState } from "../src/parser";
import { createBoundaryPlan } from "../src/regimen/planner";
import { composeCoordinatedTimingAnchors } from "../src/regimen/coordination-scope";
import { THAI_COURSE } from "../src/locales/course/th";
import { ENGLISH_COURSE } from "../src/locales/course/en";
import { withDosageEditProvenance } from "../src/dosage-course";
import { encodeR6SourceMetadata } from "../src/dosage-course";
import { PARALLEL_COMPONENT_PHASE_ORIGIN_URL } from "../src/dosage-course";
import { registerMedicationDateResolver } from "../src/index";
import { projectCanonicalCourse } from "../src/index";
import type { CanonicalAdministration } from "../src/index";
import { fromFhirDosage } from "../src/index";
import { formatCanonicalClause } from "../src/format";
import { formatCanonicalCourse } from "../src/canonical/format-course";
import { administrationFromClause } from "../src/canonical/compile";
import { clauseForAdministration } from "../src/canonical/compile";
import { courseFromAdministrations } from "../src/canonical/compile";
import { courseFromPartialParallel } from "../src/canonical/compile";
import { courseFromParallel } from "../src/canonical/compile";
import { courseFromR6 } from "../src/adapters/canonical-course";
import { courseToR6 } from "../src/adapters/canonical-course";
import type { CanonicalCourse } from "../src/canonical/course";
import type { CanonicalBoundary } from "../src/canonical/course";
import { canonicalFromFhir } from "../src/fhir";
import { canonicalToFhir } from "../src/fhir";
import { parserStateFromFhir } from "../src/fhir";
import { TIMING_EVENT_WINDOW_EXTENSION_URL } from "../src/fhir";
import { TIMING_FREQUENCY_MIN_EXTENSION_URL } from "../src/fhir";
import { ADMINISTRATION_OFFSET_EXTENSION_URL } from "../src/fhir";
import { CYCLE_DAY_ELIGIBILITY_EXTENSION_URL } from "../src/fhir";
import { TIMING_ADMINISTRATION_DURATION_EXTENSION_URL, ANCHORED_COURSE_DURATION_EXTENSION_URL, getAnchoredCourseDuration } from "../src/fhir";
import { buildBodySiteSpatialRelationExtension } from "../src/body-site-spatial";
import { getQuantityComparator } from "../src/fhir-quantity-operator";
import { simpleQuantityForR5 } from "../src/fhir-quantity-operator";
import { resolveSigLocalization } from "../src/i18n";
import type { SigFormatContext } from "../src/i18n";
import { registerSigLocalization } from "../src/i18n";
import { parseInstructionActions } from "../src/instruction-graph";
import { realizeInstructionAction } from "../src/instruction-graph";
import { realizeInstructionGraph } from "../src/instruction-graph";
import { realizeRichPrimaryWithCanonicalDose } from "../src/instruction-graph";
import { instructionGraphSourceConflictsWithDose } from "../src/instruction-graph";
import { resolveMedicationInstructionActionByMethod } from "../src/instruction-action-terminology";
import { buildInstructionGraphExtension } from "../src/instruction-graph-fhir";
import { MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL } from "../src/instruction-graph-fhir";
import { parseInstructionGraphExtension } from "../src/instruction-graph-fhir";
import { tokenize } from "../src/parser";
import { buildRegimenGraph } from "../src/regimen/regimen";
import { scopeSequentialPhaseSemantics } from "../src/regimen/regimen";
import { buildCanonicalParallelRegimen } from "../src/regimen/parallel-course";
import { ParserState } from "../src/parser-state";
import { instructionLexicalRule } from "../src/hpsg/rules/instruction-rules";
import { clinicalQuantityLexicalRule } from "../src/hpsg/rules/clinical-quantity-rules";
import type { HpsgClauseContext } from "../src/hpsg/rule-context";
import { inferMedicationLocale } from "../src/locale-detection";
import { registerMedicationLocaleDetector } from "../src/locale-detection";
import type { MedicationLocaleDetector } from "../src/locale-detection";
import { listMedicationSurfaceSegmenters } from "../src/lexer/surface-segmenter";
import { registerMedicationSurfaceSegmenter } from "../src/lexer/surface-segmenter";
import { splitMedicationScriptRuns } from "../src/lexer/surface-segmenter";
import type { MedicationSurfaceSegmenter } from "../src/lexer/surface-segmenter";
import { AdviceRelation } from "../src/types";
import { AdvicePolarity } from "../src/types";
import { EventTiming } from "../src/types";
import { FhirPeriodUnit } from "../src/types";
import type { CanonicalInstructionGraph } from "../src/types";
import type { FhirR6DosageInstruction } from "../src/types";
import type { ParseOptions } from "../src/types";
import type { MedicationDateResolver } from "../src/types";
import { RouteCode } from "../src/types";
import type { FhirR6Dosage } from "../src/types";
import { normalizeClock } from "../src/execution/calendar";
import { lexInput } from "../src/lexer/lex";
import { anchoredScheduleDurationEnd } from "../src/regimen/regimen";
import { courseToR5 } from "../src/adapters/canonical-course";
import { toEzDosages } from "../src/index";
import { TIMING_OCCURRENCE_CAP_EXTENSION_URL } from "../src/index";
import { FhirDayOfWeek } from "../src/types";
import { FhirPeriodUnit as Unit } from "../src/types";
import { describe as round38_execution20_describe } from "vitest";
import { expect as round38_execution20_expect } from "vitest";
import { it as round38_execution20_it } from "vitest";
import { calculateTotalUnits as round38_execution20_calculateTotalUnits } from "../src/index";
import { nextDueDoses as round38_execution20_nextDueDoses } from "../src/index";
import { parseSig as round38_execution20_parseSig } from "../src/index";
import { toFhirR5Dosages as round38_execution20_toFhirR5Dosages } from "../src/index";
import type { CanonicalAdministration as round38_execution20_CanonicalAdministration } from "../src/canonical/course";
import type { CanonicalCourse as round38_execution20_CanonicalCourse } from "../src/canonical/course";
import { FhirPeriodUnit as round38_execution20_FhirPeriodUnit } from "../src/types";
import type { FhirDosage as round38_execution20_FhirDosage } from "../src/types";
import type { FhirR6DosageInstruction as round38_execution20_FhirR6DosageInstruction } from "../src/types";
import { addCalendarDaysAtClock as round38_execution20_addCalendarDaysAtClock } from "../src/execution/calendar";
import { addCalendarMonths as round38_execution20_addCalendarMonths } from "../src/execution/calendar";
import { getTimeParts as round38_execution20_getTimeParts } from "../src/execution/calendar";

const TABLET_CONTEXT = { dosageForm: "tablet" };

function dose(result: ReturnType<typeof parseSig>, index: number) {
  return result.items[index]?.fhir.doseAndRate?.[0]?.doseQuantity;
}

function repeat(result: ReturnType<typeof parseSig>, index: number) {
  return result.items[index]?.fhir.timing?.repeat;
}

describe("heterogeneous multi-dose regimens", () => {
  it("splits omitted-head English then/and continuations into independent Dosage items", () => {
    const result = parseSig(
      "take 1 tab at 12:00, then 2 tabs at 16:00, and 1.5 tabs before sleep",
      { context: TABLET_CONTEXT }
    );
    expect(result.count).toBe(3);
    expect(dose(result, 0)).toMatchObject({ value: 1, unit: "tab" });
    expect(dose(result, 1)).toMatchObject({ value: 2, unit: "tab" });
    expect(dose(result, 2)).toMatchObject({ value: 1.5, unit: "tab" });
    expect(repeat(result, 0)?.timeOfDay).toEqual(["12:00:00"]);
    expect(repeat(result, 1)?.timeOfDay).toEqual(["16:00:00"]);
    expect(repeat(result, 2)?.when).toEqual(["HS"]);
    expect(result.items.map((item) => item.meta.leftoverText)).toEqual([undefined, undefined, undefined]);
    expect(result.items.map((item) => item.longText)).toEqual([
      "Take 1 tablet orally at 12:00 pm.",
      "Take 2 tablets orally at 4:00 pm.",
      "Take 1.5 tablets orally at bedtime."
    ]);
  });

  it("does the corresponding Thai multi-dose segmentation without a flag", () => {
    const result = parseSig(
      "รับประทาน 1 เม็ด เวลา 12:00 จากนั้น 2 เม็ด เวลา 16:00 และ 1.5 เม็ด ก่อนนอน",
      { locale: "th", context: TABLET_CONTEXT }
    );
    expect(result.count).toBe(3);
    expect(dose(result, 0)).toMatchObject({ value: 1, unit: "tab" });
    expect(dose(result, 1)).toMatchObject({ value: 2, unit: "tab" });
    expect(dose(result, 2)).toMatchObject({ value: 1.5, unit: "tab" });
    expect(repeat(result, 0)?.timeOfDay).toEqual(["12:00:00"]);
    expect(repeat(result, 1)?.timeOfDay).toEqual(["16:00:00"]);
    expect(repeat(result, 2)?.when).toEqual(["HS"]);
    expect(result.items.map((item) => item.meta.leftoverText)).toEqual([undefined, undefined, undefined]);
    expect(result.items.map((item) => item.longText)).toEqual([
      "รับประทานครั้งละ 1 เม็ด เวลา 12:00.",
      "รับประทานครั้งละ 2 เม็ด เวลา 16:00.",
      "รับประทานครั้งละ 1.5 เม็ด ก่อนนอน."
    ]);
  });

  it("parses compact Thai morning/evening dose changes and shares a trailing stage duration", async () => {
    const input = "1 เม็ดเช้า 2 เม็ดเย็นเป็นเวลา 2 สัปดาห์ หลังจากนั้นทาน 1 เม็ดเช้า 1 เม็ดเย็น";
    const options = { locale: "th" as const, context: TABLET_CONTEXT };
    const result = parseSig(input, options);
    expect(result.count).toBe(3);
    expect(result.meta.segments.map((segment) => segment.text)).toEqual([
      "1 เม็ดเช้า",
      "2 เม็ดเย็นเป็นเวลา 2 สัปดาห์",
      "ทาน 1 เม็ดเช้า",
      "1 เม็ดเย็น"
    ]);
    expect(result.items.map((item) => item.fhir.doseAndRate?.[0]?.doseQuantity)).toMatchObject([
      { value: 1, unit: "tab" },
      { value: 2, unit: "tab" },
      { value: 1, unit: "tab" }
    ]);
    expect(result.items.map((item) => item.fhir.timing?.repeat?.when)).toEqual([
      ["MORN"], ["EVE"], ["MORN", "EVE"]
    ]);
    expect(result.items[0].fhir.timing?.repeat?.boundsDuration).toMatchObject({ value: 2, code: "wk" });
    expect(result.items[1].fhir.timing?.repeat?.boundsDuration).toMatchObject({ value: 2, code: "wk" });
    expect(result.items[2].fhir.timing?.repeat?.boundsDuration).toBeUndefined();
    expect(result.items.map((item) => item.meta.leftoverText)).toEqual([undefined, undefined, undefined]);

    const asyncResult = await parseSigAsync(input, options);
    expect(asyncResult.items.map((item) => item.fhir)).toEqual(result.items.map((item) => item.fhir));
  });

  it("propagates a shared trailing duration before merging identical timed doses", async () => {
    const input = "1 tab morning 1 tab evening for 2 weeks";
    const result = parseSig(input, { context: TABLET_CONTEXT });

    expect(result.meta.segments).toHaveLength(2);
    expect(result.count).toBe(1);
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.repeat?.when).toEqual(["MORN", "EVE"]);
    expect(result.fhir.timing?.repeat?.boundsDuration).toMatchObject({
      value: 2,
      code: "wk",
      system: "http://unitsofmeasure.org"
    });
    expect(result.meta.canonical.clauses).toHaveLength(2);
    expect(result.meta.canonical.clauses.every((clause) =>
      clause.schedule?.duration === 2 && clause.schedule?.durationUnit === "wk"
    )).toBe(true);

    const asyncResult = await parseSigAsync(input, { context: TABLET_CONTEXT });
    expect(asyncResult.items.map((item) => item.fhir)).toEqual(result.items.map((item) => item.fhir));
  });

  it("does not merge timed doses with different course durations", () => {
    const result = parseSig(
      "1 tab morning for 1 week 1 tab evening for 2 weeks",
      { context: TABLET_CONTEXT }
    );
    expect(result.count).toBe(2);
    expect(result.items.map((item) => item.fhir.timing?.repeat?.boundsDuration?.value)).toEqual([1, 2]);
    expect(result.items.map((item) => item.fhir.timing?.repeat?.when)).toEqual([["MORN"], ["EVE"]]);
  });

  it("supports multiple timing anchors inside each heterogeneous dose group", () => {
    const result = parseSig(
      "Take 1 tab at wake and lunch, 2 tabs at dinner and 22:00",
      { context: TABLET_CONTEXT }
    );
    expect(result.count).toBe(2);
    expect(dose(result, 0)).toMatchObject({ value: 1, unit: "tab" });
    expect(repeat(result, 0)?.when).toEqual(["WAKE", "CD"]);
    expect(dose(result, 1)).toMatchObject({ value: 2, unit: "tab" });
    expect(repeat(result, 1)?.when).toEqual(["CV"]);
    expect(getTimingClocks(repeat(result, 1))).toEqual(["22:00:00"]);
    expect(repeat(result, 1)?.timeOfDay).toBeUndefined();
    expect(result.items[1].warnings).toEqual([]);
    expect(result.items[1].fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(2);
    expect(result.items[0].meta.leftoverText).toBeUndefined();
  });

  it("supports the corresponding Thai multi-dose multi-timing surface", () => {
    const result = parseSig(
      "รับประทาน 1 เม็ด หลังตื่นนอนและอาหารกลางวัน, 2 เม็ด พร้อมอาหารเย็นและเวลา 22:00",
      { locale: "th", context: TABLET_CONTEXT }
    );
    expect(result.count).toBe(2);
    expect(dose(result, 0)).toMatchObject({ value: 1, unit: "tab" });
    expect(repeat(result, 0)?.when).toEqual(["WAKE", "CD"]);
    expect(dose(result, 1)).toMatchObject({ value: 2, unit: "tab" });
    expect(repeat(result, 1)?.when).toEqual(["CV"]);
    expect(getTimingClocks(repeat(result, 1))).toEqual(["22:00:00"]);
    expect(repeat(result, 1)?.timeOfDay).toBeUndefined();
    expect(result.items[1].warnings).toEqual([]);
    expect(result.items[1].fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(2);
    expect(result.items[0].meta.leftoverText).toBeUndefined();
  });

  it("propagates a semicolon-delimited trailing low-BP safety condition across the regimen", () => {
    const result = parseSig(
      "take 1 tab at 12:00, then 2 tabs at 16:00, and 1.5 tabs before sleep; do not take if low blood pressure",
      { context: TABLET_CONTEXT }
    );
    expect(result.count).toBe(3);
    for (const item of result.items) {
      expect(item.fhir.additionalInstruction).toEqual([
        expect.objectContaining({ text: "do not take if low blood pressure" })
      ]);
      expect(item.longText).toContain("Do not take if low blood pressure.");
      expect(getDosageCondition(item.fhir)).toMatchObject({ kind: "not", condition: { kind: "state", expected: true } });
      expect(item.meta.leftoverText).toBeUndefined();
    }
  });

  it("keeps trailing shared safety consistent in async parsing", async () => {
    const input = "take 1 tab at 12:00, 2 tabs at 16:00; do not take with food";
    const sync = parseSig(input, { context: TABLET_CONTEXT });
    const asyncResult = await parseSigAsync(input, { context: TABLET_CONTEXT });
    expect(asyncResult.items.map((item) => item.fhir.additionalInstruction)).toEqual(
      sync.items.map((item) => item.fhir.additionalInstruction)
    );
    expect(asyncResult.items.every((item) =>
      item.fhir.additionalInstruction?.some((instruction) => instruction.text === "Do not take with food")
    )).toBe(true);
  });

  it("keeps negated food safety negative and shared without a positive with-food coding", () => {
    const result = parseSig(
      "take 1 tab at 12:00, then 2 tabs at 16:00, and 1.5 tabs before sleep; do not take with food",
      { context: TABLET_CONTEXT }
    );
    expect(result.count).toBe(3);
    for (const item of result.items) {
      expect(item.longText).toContain("Do not take with food.");
      expect(item.fhir.additionalInstruction).toEqual([
        expect.objectContaining({ text: "Do not take with food" })
      ]);
      expect(item.fhir.additionalInstruction?.some((instruction) =>
        instruction.coding?.some((coding) => coding.code === "311504000")
      )).toBe(false);
    }
  });

  it("retains independent same-text warning occurrences when the trailing instruction is shared", () => {
    const source = "Take 1 tablet at 12:00 do not take with food, then 2 tablets at 16:00; do not take with food";
    const parsed = parseProductionSig(source);
    const clauses = parsed.meta.canonical.clauses;
    expect(parsed.count).toBe(2);
    expect(clauses.map(clause => clause.dose?.value)).toEqual([1, 2]);
    expect(clauses.map(clause => clause.schedule?.timeOfDay)).toEqual([["12:00:00"], ["16:00:00"]]);
    const first = clauses[0].additionalInstructions!, second = clauses[1].additionalInstructions!;
    expect(first.map(instruction => instruction.text)).toEqual(["Do not take with food", "Do not take with food"]);
    expect(second.map(instruction => instruction.text)).toEqual(["Do not take with food"]);
    const firstFrames = first.map(instruction => instruction.frames![0]);
    expect(firstFrames.map(frame => frame.polarity)).toEqual([AdvicePolarity.Negate, AdvicePolarity.Negate]);
    expect(firstFrames[0].span.start).toBeLessThan(firstFrames[1].span.start);
    expect(firstFrames[1].span).toEqual(second[0].frames![0].span);
    for (const row of parsed.fhir) expect(row.additionalInstruction?.some(instruction => instruction.text === "Do not take with food")).toBe(true);
    expect(parsed.input).toBe(source);
  });

  it("round-trips negated food relation across English and Thai surfaces", () => {
    const english = parseSig("do not take with food", { locale: "en" });
    const thai = parseSig("ห้ามรับประทานพร้อมอาหาร", { locale: "th" });
    expect(english.longText).toContain("Do not take with food.");
    expect(thai.longText).toContain("ห้ามรับประทานพร้อมอาหาร.");
    expect(formatSig(english.fhir, "long", { locale: "th" })).toBe("ห้ามรับประทานพร้อมอาหาร.");
    expect(formatSig(thai.fhir, "long", { locale: "en" })).toBe("Do not take with food.");
  });


  it("propagates the corresponding Thai low-BP safety condition across the regimen", () => {
    const result = parseSig(
      "รับประทาน 1 เม็ด เวลา 12:00 จากนั้น 2 เม็ด เวลา 16:00 และ 1.5 เม็ด ก่อนนอน; ห้ามรับประทานหากความดันโลหิตต่ำ",
      { locale: "th", context: TABLET_CONTEXT }
    );
    expect(result.count).toBe(3);
    for (const item of result.items) {
      expect(item.longText).toContain("ห้ามรับประทานหากความดันโลหิตต่ำ.");
      expect(getDosageCondition(item.fhir)).toMatchObject({ kind: "not", condition: { kind: "state", expected: true } });
      expect(item.fhir.additionalInstruction).toEqual([
        expect.objectContaining({ text: "ห้ามรับประทานหากความดันโลหิตต่ำ" })
      ]);
      expect(item.meta.leftoverText).toBeUndefined();
    }
  });

  it("does not split ordinary coordination that lacks a new typed dose", () => {
    const procedural = parseSig("wash scalp and rinse", { locale: "en" });
    expect(procedural.count).toBe(1);
    const timingList = parseSig("take 1 tab at 09:00 and 12:00", { context: TABLET_CONTEXT });
    expect(timingList.count).toBe(1);
  });

  it.each([
    "หยอดตาขวา 1 หยดวันละ 4 ครั้ง 7 วัน ตาซ้าย 1 หยดวันละ 2 ครั้ง",
    "หยอดตาขวา 1 หยดวันละ 4 ครั้ง 7 วัน. ตาซ้าย 1 หยดวันละ 2 ครั้ง",
    "OD 1 drop QID x7d OS 1 drop BID",
    "OD one drop QID x7d OS one drop BID",
    "หยอดตาขวาหนึ่งหยดวันละสี่ครั้ง 7 วัน ตาซ้ายหนึ่งหยดวันละสองครั้ง",
    "Right eye 1 drop QID for 7 days left eye 1 drop BID"
  ])("keeps complete independently dosed ocular heads across an implicit boundary: %s", (input) => {
    const parsed = parseSig(input, { locale: input.includes("ตา") ? "th" : "en" });
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.site?.text)).toEqual(["right eye", "left eye"]);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([1, 1]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.frequency)).toEqual([4, 2]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.value))
      .toEqual([7, undefined]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.count)).toEqual([undefined, undefined]);
    expect(parsed.meta.leftoverText).toBeUndefined();

    const strictR5 = toFhirR5Dosages(parsed.fhirNext);
    expect(strictR5.map(dosage => dosage.site?.text)).toEqual(["right eye", "left eye"]);
    expect(strictR5.map(dosage => dosage.timing?.repeat?.frequency)).toEqual([4, 2]);
    expect(toDosageDetails(strictR5)).toEqual(parsed.fhirNext);
    expect(parsed.fhirNext.step).toHaveLength(1);
    expect(parsed.fhirNext.step[0]?.component).toHaveLength(2);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });

  it("keeps a compound ocular target under one shared dose construction", () => {
    const input = "OD and OS 1 drop BID";
    const parsed = parseSig(input);
    expect(parsed.meta.segments).toHaveLength(1);
    expect(parsed.items.map(item => item.fhir.site?.text)).toEqual(["right eye", "left eye"]);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([1, 1]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.frequency)).toEqual([2, 2]);
    expect(parsed.fhirNext.step).toHaveLength(1);
    expect(parsed.fhirNext.step[0]?.component).toHaveLength(2);
  });

  it("keeps connectorless independently timed Thai doses as separate heads", () => {
    const input = "ครึ่งเม็ดตอนเช้า 1 เม็ดตอนเย็น";
    const parsed = parseSig(input, { locale: "th" });
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity))
      .toMatchObject([{ value: 0.5, unit: "tab" }, { value: 1, unit: "tab" }]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.when))
      .toEqual([["MORN"], ["EVE"]]);
    expect(parsed.items.map(item => item.fhir.route?.text)).toEqual([undefined, undefined]);
    expect(parsed.meta.leftoverText).toBeUndefined();

    const strictR5 = toFhirR5Dosages(parsed.fhirNext);
    expect(strictR5.map(dosage => dosage.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([0.5, 1]);
    expect(strictR5.map(dosage => dosage.timing?.repeat?.when)).toEqual([["MORN"], ["EVE"]]);
    expect(toDosageDetails(strictR5)).toEqual(parsed.fhirNext);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });

  it("keeps a decimal dose intact while exposing a compact sentence boundary", () => {
    const input = "OD 0.5 drop BID.OS 1 drop QID";
    const parsed = parseSig(input);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.site?.text)).toEqual(["right eye", "left eye"]);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([0.5, 1]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.frequency)).toEqual([2, 4]);
    expect(parsed.meta.leftoverText).toBeUndefined();
    const strictR5 = toFhirR5Dosages(parsed.fhirNext);
    expect(strictR5.map(dosage => dosage.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([0.5, 1]);
    expect(toDosageDetails(strictR5)).toEqual(parsed.fhirNext);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });

  it.each([
    [
      "หยอดตาขวา 1 หยด ทุก 2 ชั่วโมง 7 วัน แล้วลดเหลือวันละ 4 ครั้ง อีก 7 วัน",
      "right eye",
      [undefined, 4],
      [2, 1],
      ["h", "d"]
    ],
    [
      "ทาที่ผื่นวันละ 2 ครั้ง 7 วัน แล้วลดเหลือวันละครั้งอีก 7 วัน",
      "rash",
      [2, 1],
      [1, 1],
      ["d", "d"]
    ]
  ] as const)("assigns each Thai taper duration to its typed phase: %s", (
    input, site, frequencies, periods, periodUnits
  ) => {
    const parsed = parseSig(input, { locale: "th" });
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.site?.text)).toEqual([site, site]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.frequency)).toEqual([...frequencies]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.period)).toEqual([...periods]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.periodUnit)).toEqual([...periodUnits]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.value)).toEqual([7, 7]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.code)).toEqual(["d", "d"]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.count)).toEqual([undefined, undefined]);
    expect(parsed.meta.leftoverText).toBeUndefined();

    const strictR5 = toFhirR5Dosages(parsed.fhirNext);
    expect(strictR5.map(dosage => dosage.timing?.repeat?.boundsDuration?.value)).toEqual([7, 7]);
    expect(strictR5.map(dosage => dosage.sequence)).toEqual([1, 2]);
    expect(toDosageDetails(strictR5)).toEqual(parsed.fhirNext);
    expect(parsed.fhirNext.step.map(step => step.component.length)).toEqual([1, 1]);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });
});

describe("typed delayed loading and phase continuations", () => {
  it.each([
    ["Take 2 tablets now, then 1 tablet after 12 hours", 12],
    ["Take 2 tablets immediately, then 1 tablet in 12 hours", 12],
    ["Take 2 tablets now, then 1 tablet 1 hour later", 1],
    ["Take 2 tablets immediately, then after 1 hour take 1 tablet", 1],
    ["Take 2 tablets now, then 1 tablet after twelve hours", 12],
    ["Take 2 tablets immediately, then 1 tablet in twelve hours", 12],
    ["Take 2 tablets now, then 1 tablet twelve hours later", 12]
  ] as const)("keeps a one-time delayed oral loading dose: %s", (input, hours) => {
    const parsed = parseSig(input, { context: TABLET_CONTEXT });
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity))
      .toMatchObject([{ value: 2, unit: "tab" }, { value: 1, unit: "tab" }]);
    expect(parsed.items[0]?.fhir.timing?.repeat?.when).toEqual(["IMD"]);
    expect(parsed.items.map(item => item.fhir.route?.coding?.[0]?.code))
      .toEqual(["26643006", "26643006"]);
    expect(parsed.items[1]?.fhir.timing?.repeat?.boundsDuration).toBeUndefined();
    expect(parsed.items[1]?.fhir.timing?.repeat?.frequency).toBeUndefined();
    expect(parsed.items[1]?.fhir.timing?.repeat?.period).toBeUndefined();
    expect(parsed.items[1]?.meta.canonical.clauses[0]?.schedule?.administrationOffsetMinutes)
      .toBe(hours * 60);
    expect(parsed.items[1]?.meta.canonical.clauses[0]?.evidence.some(item =>
      item.rule === "hpsg.lex.schedule.administrationOffset.relativeInterval"
    )).toBe(true);
    expect(parsed.fhirNext.step).toHaveLength(2);
    const production = parseProductionSig(input, { context: TABLET_CONTEXT });
    const clock = { orderedAt: "2026-11-21T08:00:00Z", from: "2026-11-21T08:00:00Z", timeZone: "UTC", limit: 4 };
    const expected = ["2026-11-21T08:00:00+00:00",
      hours === 12 ? "2026-11-21T20:00:00+00:00" : "2026-11-21T09:00:00+00:00"];
    for (const course of [production, production.meta.canonical.course!, production.fhirNext,
      JSON.parse(JSON.stringify(production.fhirNext)), production.fhir,
      JSON.parse(JSON.stringify(production.fhir))]) {
      const before = JSON.stringify(course);
      expect(nextDueDoses(course, clock)).toEqual(expected);
      expect(nextDueDoses(course, { ...clock, from: "2026-11-22T00:00:00Z" })).toEqual([]);
      expect(JSON.stringify(course)).toBe(before);
    }
    expect(parsed.fhirNext.step[1]?.component[0]?.timing?.repeat?.count).toBe(1);
    expect(production.meta.canonical.clauses[1].schedule?.count).toBe(1);
    expect(calculateTotalUnits({ dosage: production, ...clock, durationValue: 1, durationUnit: "d" }).totalUnits).toBe(3);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });

  it("keeps a more-days ocular cadence as a second phase before the independent eye regimen", () => {
    const input = "OD 1 drop q2h for 2 days, then BID for 5 more days. OS 1 drop nightly for 7 days.";
    const parsed = parseSig(input);

    expect(parsed.items).toHaveLength(3);
    expect(parsed.items.map(item => item.fhir.site?.text))
      .toEqual(["right eye", "right eye", "left eye"]);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity))
      .toMatchObject([
        { value: 1, unit: "drop" },
        { value: 1, unit: "drop" },
        { value: 1, unit: "drop" }
      ]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.frequency))
      .toEqual([undefined, 2, undefined]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.period))
      .toEqual([2, 1, undefined]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.periodUnit))
      .toEqual(["h", "d", undefined]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.when))
      .toEqual([undefined, undefined, ["NIGHT"]]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.value))
      .toEqual([2, 5, 7]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.code))
      .toEqual(["d", "d", "d"]);
    // The independent OS course persists in parallel across both sequential
    // OD phases, so R6 has two steps with two components rather than three
    // serial steps.
    expect(parsed.fhirNext.step.map(step => step.component.length)).toEqual([2, 2]);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });
});

describe("typed shared course bounds", () => {
  it.each([
    ["Take 1 tab qAM and 2 tabs qPM for 7 days", undefined, 7, "d"],
    ["Take 0.5 tablet each morning and 1.5 tablets each evening for 14 days", undefined, 14, "d"],
    ["รับประทาน ครึ่งเม็ดเช้า และ 1 เม็ดเย็น 2 สัปดาห์", "th", 2, "wk"]
  ] as const)("scopes one terminal duration over both coordinated dose slots: %s", (
    input, locale, value, code
  ) => {
    const parsed = parseSig(input, {
      ...(locale ? { locale } : {}),
      context: TABLET_CONTEXT
    });

    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration))
      .toEqual([
        expect.objectContaining({ value, code }),
        expect.objectContaining({ value, code })
      ]);
    const strictR5 = toFhirR5Dosages(parsed.fhirNext);
    expect(strictR5.map(item => item.timing?.repeat?.boundsDuration))
      .toEqual(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration));
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });

  it("does not replace either dose slot's explicit local duration", () => {
    const parsed = parseSig(
      "Take 1 tab qAM for 3 days and 2 tabs qPM for 7 days",
      { context: TABLET_CONTEXT }
    );

    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.value))
      .toEqual([3, 7]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.code))
      .toEqual(["d", "d"]);
  });
});

describe("typed ordinal-week Parkinson regimen phases", () => {
  const orderedAt = "2026-11-02T00:00:00+07:00";
  const dueOn = (
    regimen: Parameters<typeof nextDueDoses>[0],
    date: "2026-11-02" | "2026-11-09" | "2026-11-16"
  ) => nextDueDoses(regimen, {
    from: `${date}T00:00:00+07:00`,
    orderedAt,
    timeZone: "Asia/Bangkok",
    limit: 8
  }).filter(value => value.startsWith(date));

  it("keeps Week 1, Week 2, and Week 3 onwards as three exact dose/time phases", () => {
    const input = "Week 1: take half a tablet at 08:00 and 20:00. " +
      "Week 2: take 1 tablet at 08:00 and 20:00. " +
      "Week 3 onwards: take 1 tablet at 08:00, 14:00 and 20:00.";
    const parsed = parseSig(input, { context: TABLET_CONTEXT });
    expect(parsed.meta.segments.map(segment => segment.text)).toEqual([
      "Week 1: take half a tablet at 08:00 and 20:00",
      "Week 2: take 1 tablet at 08:00 and 20:00",
      "Week 3 onwards: take 1 tablet at 08:00, 14:00 and 20:00."
    ]);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity))
      .toMatchObject([
        { value: 0.5, unit: "tab" },
        { value: 1, unit: "tab" },
        { value: 1, unit: "tab" }
      ]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.timeOfDay))
      .toEqual([
        ["08:00:00", "20:00:00"],
        ["08:00:00", "20:00:00"],
        ["08:00:00", "14:00:00", "20:00:00"]
      ]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration))
      .toEqual([
        expect.objectContaining({ value: 1, code: "wk" }),
        expect.objectContaining({ value: 1, code: "wk" }),
        undefined
      ]);
    expect(parsed.items.map(item => item.fhir.sequence)).toEqual([1, 2, 3]);
    expect(parsed.fhirNext.step.map(step => step.component.length)).toEqual([1, 1, 1]);
    expect(parsed.items.slice(0, 2).every(item =>
      item.meta.canonical.clauses[0]?.evidence.some(evidence =>
        evidence.rule === "hpsg.cx.regimen.ordinal-week-stage-duration"
      )
    )).toBe(true);
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.fhirNext.renderedInstruction).toBe(input);

    const strictR5 = toFhirR5Dosages(parsed.fhirNext);
    expect(strictR5.map(item => item.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([0.5, 1, 1]);
    expect(strictR5.map(item => item.timing?.repeat?.timeOfDay))
      .toEqual(parsed.items.map(item => item.fhir.timing?.repeat?.timeOfDay));
    expect(toDosageDetails(strictR5)).toEqual(parsed.fhirNext);
    for (const regimen of [parsed.fhirNext, strictR5]) {
      expect(dueOn(regimen, "2026-11-02")).toEqual([
        "2026-11-02T08:00:00+07:00", "2026-11-02T20:00:00+07:00"
      ]);
      expect(dueOn(regimen, "2026-11-09")).toEqual([
        "2026-11-09T08:00:00+07:00", "2026-11-09T20:00:00+07:00"
      ]);
      expect(dueOn(regimen, "2026-11-16")).toEqual([
        "2026-11-16T08:00:00+07:00", "2026-11-16T14:00:00+07:00",
        "2026-11-16T20:00:00+07:00"
      ]);
    }
  });

  it("does not union the clocks of successive labelled weeks", () => {
    const input = "Week 1: take 1 tablet at 07:00, 12:00 and 17:00. " +
      "Week 2: take 1 tablet at 07:00, 11:00, 15:00 and 19:00.";
    const parsed = parseSig(input, { context: TABLET_CONTEXT });

    expect(parsed.items.map(item => item.fhir.timing?.repeat?.timeOfDay)).toEqual([
      ["07:00:00", "12:00:00", "17:00:00"],
      ["07:00:00", "11:00:00", "15:00:00", "19:00:00"]
    ]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.code))
      .toEqual(["wk", "wk"]);
    expect(parsed.items.map(item => item.fhir.sequence)).toEqual([1, 2]);
    expect(parsed.meta.leftoverText).toBeUndefined();
    const strictR5 = toFhirR5Dosages(parsed.fhirNext);
    for (const regimen of [parsed.fhirNext, strictR5]) {
      expect(dueOn(regimen, "2026-11-02")).toEqual([
        "2026-11-02T07:00:00+07:00", "2026-11-02T12:00:00+07:00",
        "2026-11-02T17:00:00+07:00"
      ]);
      expect(dueOn(regimen, "2026-11-09")).toEqual([
        "2026-11-09T07:00:00+07:00", "2026-11-09T11:00:00+07:00",
        "2026-11-09T15:00:00+07:00", "2026-11-09T19:00:00+07:00"
      ]);
      expect(dueOn(regimen, "2026-11-16")).toEqual([]);
    }
  });

  it.each([
    [
      "สัปดาห์แรกกินครึ่งเม็ดหลังอาหารเช้าและเย็น สัปดาห์ที่สองเพิ่มเป็น 1 เม็ดหลังอาหารเช้าและเย็น",
      [["PCM", "PCV"], ["PCM", "PCV"]],
      true
    ],
    [
      "สัปดาห์ที่ 1 กินครึ่งเม็ดเวลา 07:00 และ 19:00 สัปดาห์ที่ 2 กิน 1 เม็ดเวลา 07:00 และ 19:00",
      [undefined, undefined],
      false
    ]
  ] as const)("retains both Thai labelled-week doses: %s", (input, when, hasPhaseAdjustment) => {
    const parsed = parseSig(input, { locale: "th", context: TABLET_CONTEXT });
    expect(parsed.meta.segments).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value))
      .toEqual([0.5, 1]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.code))
      .toEqual(["wk", "wk"]);
    expect(parsed.items.map(item => item.fhir.sequence)).toEqual([1, 2]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.when)).toEqual([...when]);
    // The previously orphaned เพิ่มเป็น is now a licensed typed HPSG
    // phase-adjustment connective: preserve its source and evidence, not an
    // untranslated leftover next to already-correct week-two dose changes.
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.meta.canonical.clauses[1]?.evidence.some(evidence =>
      evidence.rule === "hpsg.lex.regimen.phaseAdjustment"
    )).toBe(hasPhaseAdjustment);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
    expect(toDosageDetails(toFhirR5Dosages(parsed.fhirNext))).toEqual(parsed.fhirNext);
  });

  it("drops an incompatible four-clock list when the next phase explicitly reduces to TID", () => {
    const input = "รับประทาน 1 เม็ดเวลา 07:00 11:00 15:00 19:00 เป็นเวลา 7 วัน " +
      "แล้วลดเหลือวันละสามครั้งอีก 7 วัน";
    const parsed = parseSig(input, { locale: "th", context: TABLET_CONTEXT });

    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.frequency)).toEqual([undefined, 3]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.timeOfDay)).toEqual([
      ["07:00:00", "11:00:00", "15:00:00", "19:00:00"],
      undefined
    ]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.value)).toEqual([7, 7]);
    const strictR5 = toFhirR5Dosages(parsed.fhirNext);
    expect(strictR5.map(item => item.timing?.repeat?.timeOfDay))
      .toEqual(parsed.items.map(item => item.fhir.timing?.repeat?.timeOfDay));
    expect(toDosageDetails(strictR5)).toEqual(parsed.fhirNext);
    for (const regimen of [parsed.fhirNext, strictR5]) {
      expect(dueOn(regimen, "2026-11-02")).toEqual([
        "2026-11-02T07:00:00+07:00", "2026-11-02T11:00:00+07:00",
        "2026-11-02T15:00:00+07:00", "2026-11-02T19:00:00+07:00"
      ]);
      expect(dueOn(regimen, "2026-11-09")).toEqual([
        "2026-11-09T08:00:00+07:00", "2026-11-09T14:00:00+07:00",
        "2026-11-09T20:00:00+07:00"
      ]);
      expect(dueOn(regimen, "2026-11-16")).toEqual([]);
    }
  });

  it("does not invent a relative course from a lone ordinal-week label", () => {
    const input = "Week 2: take 1 tablet at 08:00.";
    const parsed = parseSig(input, { context: TABLET_CONTEXT });

    expect(parsed.items).toHaveLength(1);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(parsed.fhir.timing?.repeat?.timeOfDay).toEqual(["08:00:00"]);
    expect(parsed.fhir.timing?.repeat?.boundsDuration).toBeUndefined();
    expect(parsed.fhir.sequence).toBeUndefined();
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });
});

describe("established explicit-duration Parkinson phase controls", () => {
  it.each([
    {
      input: "Take 0.5 tablet once daily for 7 days, then 0.5 tablet twice daily for 7 days, then 1 tablet twice daily.",
      locale: undefined,
      doses: [0.5, 0.5, 1], frequencies: [1, 2, 2], durations: [7, 7, undefined], codes: ["d", "d", undefined]
    },
    {
      input: "Take 0.25 mg at bedtime for 1 week, then 0.5 mg at bedtime for 1 week, then 1 mg at bedtime.",
      locale: undefined,
      doses: [0.25, 0.5, 1], frequencies: [undefined, undefined, undefined], durations: [1, 1, undefined], codes: ["wk", "wk", undefined]
    },
    {
      input: "Take 2 tablets three times daily for 7 days, then 1 tablet three times daily for 7 days, then half tablet three times daily for 7 days.",
      locale: undefined,
      doses: [2, 1, 0.5], frequencies: [3, 3, 3], durations: [7, 7, 7], codes: ["d", "d", "d"]
    },
    {
      input: "Take 1 tablet four times daily at 07:00, 11:00, 15:00 and 19:00 for 2 weeks, then take 1 tablet three times daily at 07:00, 13:00 and 19:00.",
      locale: undefined,
      doses: [1, 1], frequencies: [4, 3], durations: [2, undefined], codes: ["wk", undefined]
    },
    {
      input: "กินครึ่งเม็ดวันละสองครั้ง 7 วัน แล้วเพิ่มเป็น 1 เม็ดวันละสองครั้งอีก 7 วัน",
      locale: "th" as const,
      doses: [0.5, 1], frequencies: [2, 2], durations: [7, 7], codes: ["d", "d"]
    },
    {
      input: "รับประทานครึ่งเม็ดเวลา 7.00 12.00 และ 17.00 น. 1 สัปดาห์ จากนั้นเพิ่มเป็น 1 เม็ดเวลา 7.00 12.00 และ 17.00 น.",
      locale: "th" as const,
      doses: [0.5, 1], frequencies: [undefined, undefined], durations: [1, undefined], codes: ["wk", undefined]
    }
  ])("preserves explicit phase membership: $input", ({
    input, locale, doses, frequencies, durations, codes
  }) => {
    const parsed = parseSig(input, {
      ...(locale ? { locale } : {}),
      context: TABLET_CONTEXT
    });

    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value))
      .toEqual(doses);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.frequency)).toEqual(frequencies);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.value))
      .toEqual(durations);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.code))
      .toEqual(codes);
    expect(parsed.items.map(item => item.fhir.sequence))
      .toEqual(parsed.items.map((_item, index) => index + 1));
    expect(toDosageDetails(toFhirR5Dosages(parsed.fhirNext))).toEqual(parsed.fhirNext);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });
});

describe("typed coordinated meal offsets", () => {
  const executionOptions = {
    from: "2026-11-02T00:00:00+07:00",
    orderedAt: "2026-11-02T00:00:00+07:00",
    timeZone: "Asia/Bangkok",
    eventClock: { ACM: "07:30", ACD: "12:00", ACV: "18:30" },
    limit: 3
  } as const;

  it.each([
    ["Take 1 tablet 30 minutes before breakfast, lunch and dinner.", undefined],
    ["รับประทาน 1 เม็ดก่อนอาหารเช้า กลางวัน และเย็น 30 นาที", "th"]
  ] as const)("scopes one exact pre-meal offset across breakfast, lunch, and dinner: %s", (
    input, locale
  ) => {
    const parsed = parseSig(input, {
      ...(locale ? { locale } : {}),
      context: TABLET_CONTEXT
    });

    expect(parsed.items).toHaveLength(1);
    expect(parsed.fhir.timing?.repeat?.when).toEqual(["ACM", "ACD", "ACV"]);
    expect(parsed.fhir.timing?.repeat?.offset).toBe(30);
    expect(parsed.fhir.timing?.repeat?.boundsDuration).toBeUndefined();
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(nextDueDoses(parsed.fhirNext, executionOptions)).toEqual([
      "2026-11-02T07:00:00+07:00",
      "2026-11-02T11:30:00+07:00",
      "2026-11-02T18:00:00+07:00"
    ]);
    const strictR5 = toFhirR5Dosages(parsed.fhirNext);
    expect(nextDueDoses(strictR5, executionOptions)).toEqual(
      nextDueDoses(parsed.fhirNext, executionOptions)
    );
    expect(toDosageDetails(strictR5)).toEqual(parsed.fhirNext);
  });
});

describe("typed same-day Parkinson dose composition", () => {
  const executionOptions = {
    orderedAt: "2026-11-02T00:00:00+07:00",
    timeZone: "Asia/Bangkok",
    eventClock: {
      WAKE: "06:30", HS: "22:00",
      CM: "08:00", CD: "12:30", CV: "18:30"
    },
    mealOffsets: { AC: -30, PCM: 30, PCD: 30, PCV: 30 },
    limit: 12
  } as const;
  const dueOn = (
    regimen: Parameters<typeof nextDueDoses>[0],
    date: "2026-11-02" | "2026-11-09" | "2026-11-16"
  ) => nextDueDoses(regimen, {
    ...executionOptions,
    from: `${date}T00:00:00+07:00`
  }).filter(value => value.startsWith(date));

  it("keeps the half-tablet afternoon dose between the pre-breakfast and bedtime doses", () => {
    const input = "Take 1 tablet 30 minutes before breakfast, half a tablet at 15:00 and 1 tablet at bedtime.";
    const parsed = parseSig(input, { context: TABLET_CONTEXT });

    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity))
      .toMatchObject([
        { value: 1, unit: "tab" },
        { value: 0.5, unit: "tab" },
        { value: 1, unit: "tab" }
      ]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat)).toEqual([
      expect.objectContaining({ when: ["ACM"], offset: 30 }),
      expect.objectContaining({ timeOfDay: ["15:00:00"] }),
      expect.objectContaining({ when: ["HS"] })
    ]);
    expect(parsed.fhirNext.step).toHaveLength(1);
    expect(parsed.fhirNext.step[0]?.component).toHaveLength(3);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
    expect(parsed.meta.canonical.clauses.map(clause =>
      clause.evidence.find(item => item.lexicalCategory === "dose")?.spans[0]?.text
    )).toEqual(["1 tablet", "half a tablet", "1 tablet"]);

    const strictR5 = toFhirR5Dosages(parsed.fhirNext);
    for (const regimen of [parsed.fhirNext, strictR5]) {
      for (const date of ["2026-11-02", "2026-11-09", "2026-11-16"] as const) {
        expect(dueOn(regimen, date)).toEqual([
          `${date}T07:30:00+07:00`,
          `${date}T15:00:00+07:00`,
          `${date}T22:00:00+07:00`
        ]);
      }
    }
    expect(toDosageDetails(strictR5)).toEqual(parsed.fhirNext);
  });

  it("keeps the half-tablet 22:00 dose separate from the three pre-meal doses", () => {
    const input = "Take 1 tablet 30 minutes before meals, plus half a tablet at 22:00.";
    const parsed = parseSig(input, { context: TABLET_CONTEXT });

    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity))
      .toMatchObject([{ value: 1, unit: "tab" }, { value: 0.5, unit: "tab" }]);
    expect(parsed.items[0]?.fhir.timing?.repeat).toMatchObject({ when: ["AC"], offset: 30 });
    expect(parsed.items[0]?.fhir.timing?.repeat?.timeOfDay).toBeUndefined();
    expect(parsed.items[1]?.fhir.timing?.repeat).toMatchObject({ timeOfDay: ["22:00:00"] });
    expect(parsed.items[1]?.fhir.timing?.repeat?.when).toBeUndefined();
    expect(parsed.fhirNext.step).toHaveLength(1);
    expect(parsed.fhirNext.step[0]?.component).toHaveLength(2);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
    expect(parsed.meta.canonical.clauses.map(clause =>
      clause.evidence.find(item => item.lexicalCategory === "dose")?.spans[0]?.text
    )).toEqual(["1 tablet", "half a tablet"]);

    const strictR5 = toFhirR5Dosages(parsed.fhirNext);
    for (const regimen of [parsed.fhirNext, strictR5]) {
      for (const date of ["2026-11-02", "2026-11-09", "2026-11-16"] as const) {
        expect(dueOn(regimen, date)).toEqual([
          `${date}T07:30:00+07:00`,
          `${date}T12:00:00+07:00`,
          `${date}T18:00:00+07:00`,
          `${date}T22:00:00+07:00`
        ]);
      }
    }
    expect(toDosageDetails(strictR5)).toEqual(parsed.fhirNext);
  });

  it("composes meal and bedtime daughters on the same day despite a discourse THEN", () => {
    const input = "Take 1 tablet after breakfast and lunch, then half a tablet at bedtime.";
    const parsed = parseSig(input, { context: TABLET_CONTEXT });

    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity))
      .toMatchObject([{ value: 1, unit: "tab" }, { value: 0.5, unit: "tab" }]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.when))
      .toEqual([["PCM", "PCD"], ["HS"]]);
    expect(parsed.fhirNext.step).toHaveLength(1);
    expect(parsed.fhirNext.step[0]?.component).toHaveLength(2);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);

    const strictR5 = toFhirR5Dosages(parsed.fhirNext);
    for (const regimen of [parsed.fhirNext, strictR5]) {
      for (const date of ["2026-11-02", "2026-11-09", "2026-11-16"] as const) {
        expect(dueOn(regimen, date)).toEqual([
          `${date}T08:30:00+07:00`,
          `${date}T13:00:00+07:00`,
          `${date}T22:00:00+07:00`
        ]);
      }
    }
    expect(toDosageDetails(strictR5)).toEqual(parsed.fhirNext);
  });

  it("composes the waking dose and q4h while-awake daughter without a fake cutover", () => {
    const input = "Take 1 tablet on waking, then 1 tablet every 4 hours while awake.";
    const parsed = parseSig(input, { context: TABLET_CONTEXT });

    // The punctual WAKE dose is the first occurrence of the equivalent
    // q4h waking-day interval. One source-composed schedule must not
    // duplicate the 06:30 dose just because the doctor mentions it twice.
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.fhir.doseAndRate?.[0]?.doseQuantity)
      .toMatchObject({ value: 1, unit: "tab" });
    expect(parsed.items[0]?.fhir.timing?.repeat).toMatchObject({
      period: 4,
      periodUnit: "h",
      extension: [expect.objectContaining({
        url: expect.stringContaining("urn:ezmedicationinput:StructureDefinition:medication-timing-event-window"),
        extension: [
          { url: "start", valueCode: "WAKE" },
          { url: "end", valueCode: "HS" }
        ]
      })]
    });
    expect(parsed.items[0]?.fhir.timing?.repeat?.when).toBeUndefined();
    expect(parsed.fhirNext.step).toHaveLength(1);
    expect(parsed.fhirNext.step[0]?.component).toHaveLength(1);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);

    const strictR5 = toFhirR5Dosages(parsed.fhirNext);
    for (const regimen of [parsed.fhirNext, strictR5]) {
      expect(dueOn(regimen, "2026-11-02")).toEqual([
        "2026-11-02T06:30:00+07:00",
        "2026-11-02T10:30:00+07:00",
        "2026-11-02T14:30:00+07:00",
        "2026-11-02T18:30:00+07:00"
      ]);
    }
    expect(toDosageDetails(strictR5)).toEqual(parsed.fhirNext);
  });
});

describe("typed additive doses", () => {
  it.each([
    ["Take 1 and a half tablets each morning", 1.5, "MORN"],
    ["Take 2 and three quarters tablets nightly", 2.75, "NIGHT"]
  ] as const)("keeps one additive quantity daughter across its conjunction: %s", (
    input, value, event
  ) => {
    const parsed = parseSig(input, { context: TABLET_CONTEXT });

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.fhir.doseAndRate?.[0]?.doseQuantity)
      .toMatchObject({ value, unit: "tab" });
    expect(parsed.items[0]?.fhir.timing?.repeat?.when).toEqual([event]);
    expect(parsed.items[0]?.meta.canonical.clauses[0]?.evidence.some(item =>
      item.rule === "hpsg.lex.clinicalQuantity.additiveFractionDose"
    )).toBe(true);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });
});

describe("typed conditional dosage alternatives", () => {
  it.each([
    "Take 2 tablets daily if weight above 70kg; otherwise 1 tablet daily",
    "Take 2 tablets daily if weight above 70kg; otherwise take 1 tablet daily",
    "Take 2 tablets daily if weight above 70kg, otherwise take 1 tablet daily",
    "Take 2 tablets daily if weight above 70kg otherwise 1 tablet daily",
    "Take 2 tablets daily if weight above 70kg; otherwise 1 tablet daily.",
    "Take 2 tablets daily if weight above 70kg, otherwise take 1 tablet daily."
  ])("retains both branches of an explicit ELSE dosage choice: %s", input => {
    const parsed = parseSig(input, { context: TABLET_CONTEXT });

    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity))
      .toMatchObject([{ value: 2, unit: "tab" }, { value: 1, unit: "tab" }]);
    expect(parsed.items.some(item => item.fhir.asNeeded === true)).toBe(false);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity))
      .not.toContainEqual(expect.objectContaining({ value: 70, unit: "kg" }));
    expect(getDosageCondition(parsed.items[0].fhir)).toMatchObject({
      kind: "measurement",
      name: "weight",
      operation: "gt",
      value: 70,
      unit: "kg"
    });
    expect(getDosageCondition(parsed.items[1].fhir)).toBeUndefined();
    const choices = parsed.items.map(item => getDosageAlternativeChoice(item.fhir));
    expect(choices).toEqual([
      expect.objectContaining({ selectionBehavior: "exactly-one" }),
      expect.objectContaining({ selectionBehavior: "exactly-one" })
    ]);
    expect(choices[0]?.groupId).toBe(choices[1]?.groupId);
    expect(choices[0]?.branchId).not.toBe(choices[1]?.branchId);
    expect(parsed.fhirNext.step).toHaveLength(1);
    expect(parsed.fhirNext.step[0]?.component).toHaveLength(2);
    expect(toFhirR5Dosages(parsed.fhirNext).map(getDosageAlternativeChoice))
      .toEqual(choices);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });
});


describe("fronted treatment-relative ADD source ownership", () => {
  const orderedAt = "2026-11-02T00:00:00+07:00";
  it("retains the source week-two onset with the new dose, not the preceding course", () => {
    const source = "Take 1 tablet at 08:00 and 20:00 daily. From week 2 add half a tablet at 14:00 daily.";
    const parsed = parseSig(source);
    expect(parsed.fhirNext.step).toHaveLength(2);
    expect(parsed.fhirNext.step[1]?.start?.offsetDuration?.value).toBe(7);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      const on = (day: string) => nextDueDoses(dosage, {
        orderedAt, from: day + "T00:00:00+07:00",
        timeZone: "Asia/Bangkok", limit: 8
      }).filter(value => value.startsWith(day)).map(value => value.slice(11, 16));
      expect(on("2026-11-02")).toEqual(["08:00", "20:00"]);
      expect(on("2026-11-09")).toEqual(["08:00", "14:00", "20:00"]);
      expect(on("2026-11-16")).toEqual(["08:00", "14:00", "20:00"]);
      expect(calculateTotalUnits({ dosage, orderedAt, from: orderedAt,
        timeZone: "Asia/Bangkok", durationValue: 14, durationUnit: "d"
      }).totalUnits).toBe(31.5);
    }
  });

  it("keeps the explicit week-two onset if a clinician later edits the first phase length", () => {
    const source = "Take 1 tablet at 08:00 and 20:00 daily. From week 2 add half a tablet at 14:00 daily.";
    const parsed = parseSig(source);
    expect(parsed.fhirNext.step[1]?.start?.offsetDuration?.value).toBe(7);
    const firstCourse = parsed.fhirNext.step[0]?.component[0]?.timing?.repeat?.boundsDuration;
    expect(firstCourse?.value).toBe(7);
    if (!firstCourse) throw new Error("The initial finite phase was not structured.");
    // R6 editing permits changing the first phase without changing the
    // independent author-specified FROM WEEK 2 onset of the added dose.
    firstCourse.value = 5;
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      const on = (day: string) => nextDueDoses(dosage, {
        orderedAt, from: day + "T00:00:00+07:00",
        timeZone: "Asia/Bangkok", limit: 8
      }).filter(value => value.startsWith(day)).map(value => value.slice(11, 16));
      expect(on("2026-11-07")).toEqual([]);
      expect(on("2026-11-09")).toEqual(["08:00", "14:00", "20:00"]);
    }
  });

  it("keeps a fronted week-two full replacement distinct from an addition", () => {
    const input = "Take 1 tablet at 08:00 and 20:00 daily. From week 2 take 1 tablet at 20:00 daily.";
    const parsed = parseSig(input);
    expect(parsed.fhirNext.step).toHaveLength(2);
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      const on = (day: string) => nextDueDoses(dosage, {
        orderedAt, from: day + "T00:00:00+07:00",
        timeZone: "Asia/Bangkok", limit: 8
      }).filter(value => value.startsWith(day)).map(value => value.slice(11, 16));
      expect(on("2026-11-02")).toEqual(["08:00", "20:00"]);
      expect(on("2026-11-09")).toEqual(["20:00"]);
    }
  });
});

describe("typed STOP pause followed by a resumed medication phase", () => {
  it.each([", then resume", ", and resume", "; resume", ". Resume", ", and restart"])(
    "retains the medication-free week before %s", connector => {
      const source = `Take 1 tablet at 08:00 and 20:00 for 7 days, then stop for 7 days${connector} 1 tablet at 08:00 and 20:00 for 7 days.`;
      const parsed = parseSig(source);
      const base = { timeZone: "Asia/Bangkok", orderedAt: "2026-11-02T00:00:00+07:00" };
      for (const regimen of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
        const on = (date: string) => nextDueDoses(regimen, { ...base,
          from: date + "T00:00:00+07:00", limit: 12
        }).filter(at => at.startsWith(date)).map(at => at.slice(11, 16));
        expect(on("2026-11-02")).toEqual(["08:00", "20:00"]);
        expect(on("2026-11-09")).toEqual([]);
        expect(on("2026-11-16")).toEqual(["08:00", "20:00"]);
        expect(on("2026-11-23")).toEqual([]);
        expect(calculateTotalUnits({ dosage: regimen, ...base, from: base.orderedAt,
          durationValue: 28, durationUnit: "d" }).totalUnits).toBe(28);
      }
    }
  );

  it("does not convert ordinary simultaneous AND administrations into a delayed phase", () => {
    const parsed = parseSig("Take 1 tablet at 08:00 and take half a tablet at 20:00 for 7 days.");
    expect(nextDueDoses(parsed.fhirNext, {
      timeZone: "Asia/Bangkok", orderedAt: "2026-11-02T00:00:00+07:00",
      from: "2026-11-02T00:00:00+07:00", limit: 2
    })).toEqual(["2026-11-02T08:00:00+07:00", "2026-11-02T20:00:00+07:00"]);
  });
});

describe("finite recurring-course punctuation and terminal cycle bound", () => {
  it.each([
    "Take 1 tablet daily for 7 days then stop for 7 days repeat for 3 cycles.",
    "Take 1 tablet daily for 7 days, then stop for 7 days; repeat for 3 cycles.",
    "Take 1 tablet daily for 7 days, then stop for 7 days, and repeat for 3 cycles.",
    "Take 1 tablet daily for 7 days. Then stop for 7 days. Repeat for 3 cycles."
  ])("retains one typed finite active/rest course: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.fhirNext.repeatCycle).toMatchObject({ value: 14, code: "d" });
    expect(parsed.fhirNext.step).toHaveLength(1);
    expect(getCourseCycleCount(parsed.fhirNext)).toBe(3);
    expect(parsed.fhirNext.step[0].count).toBeUndefined();
    const base = { timeZone: "Asia/Bangkok", orderedAt: "2026-11-02T00:00:00+07:00" };
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(nextDueDoses(dosage, { ...base, from: "2026-12-14T00:00:00+07:00", limit: 2 })).toEqual([]);
      expect(calculateTotalUnits({ dosage, ...base, from: base.orderedAt,
        durationValue: 56, durationUnit: "d" }).totalUnits).toBe(21);
    }
    expect(parsed.input).toBe(source);
  });

  it("does not promote an explicit prohibition on repetition to a recurring course", () => {
    const parsed = parseSig("Take 1 tablet daily for 7 days, then stop for 7 days; do not repeat.");
    expect(parsed.fhirNext.repeatCycle).toBeUndefined();
    expect(parsed.input).toContain("do not repeat");
  });
});

describe("independently dosed administration adjuncts", () => {
  it.each([
    "Take 2 tablets with meals and 1 tablet with snacks.",
    "Take 2 tablets with meals; take 1 tablet with snacks.",
    "Take 2 tablets with meals. Take 1 tablet with snacks.",
    "Take 2 tablets with meals; 1 tablet with snacks.",
    "Take 2 tablets with every meal; take 1 tablet with each snack."
  ])("retains both amounts without assigning meal timing to the snack: %s", input => {
    const parsed = parseSig(input);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity))
      .toMatchObject([{ value: 2, unit: "tab" }, { value: 1, unit: "tab" }]);
    expect(parsed.items[0].fhir.timing?.repeat?.when).toContain("C");
    expect(parsed.items[1].fhir.timing?.repeat?.when).toBeUndefined();
    expect(parsed.items[1].longText.toLowerCase()).toContain("snack");
    expect(parsed.items[1].fhir.method?.coding?.[0]?.code).toBe("738990001");
    const strict = toFhirR5Dosages(parsed.fhirNext);
    expect(strict.map(row => row.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([2, 1]);
    expect(formatSig(strict[1], "long").toLowerCase()).toContain("snack");
  });

  it("does not turn a separately quantified non-administration procedure into a dose", () => {
    const parsed = parseSig("Take 2 tablets with meals; wash hands with 1 mL of soap.");
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([2]);
    expect(parsed.longText.toLowerCase()).toContain("soap");
  });
});

describe("weekday-set complement anaphora", () => {
  it.each([
    "Take 1 tablet on Monday Wednesday Friday and 0.5 tablet on other days.",
    "Take 1 tablet on Mondays Wednesdays Fridays; take 0.5 tablet on the other days.",
    "Take 1 tablet on Monday Wednesday Friday. Take 0.5 tablet on all remaining days.",
    "Take 1 tablet on Monday Wednesday Friday; 0.5 tablet on the remaining days.",
    "รับประทาน 1 เม็ดวันจันทร์ พุธ ศุกร์ และ 0.5 เม็ดวันอื่น"
  ])("resolves the complement before projecting and scheduling: %s", input => {
    const parsed = parseSig(input);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([1, 0.5]);
    expect(repeat(parsed, 0)?.dayOfWeek).toEqual(["mon", "wed", "fri"]);
    expect(repeat(parsed, 1)?.dayOfWeek).toEqual(["tue", "thu", "sat", "sun"]);
    expect(parsed.items[1].fhir.site).toBeUndefined();
    const strict = toFhirR5Dosages(parsed.fhirNext);
    expect(strict.map(row => row.timing?.repeat?.dayOfWeek)).toEqual([
      ["mon", "wed", "fri"], ["tue", "thu", "sat", "sun"]
    ]);
    const options = { orderedAt: "2026-11-02T00:00:00+07:00", from: "2026-11-02T00:00:00+07:00", timeZone: "Asia/Bangkok", limit: 4 };
    expect(nextDueDoses(strict[1], options).map(value => value.slice(0, 10)))
      .toEqual(["2026-11-03", "2026-11-05", "2026-11-07", "2026-11-08"]);
  });

  it("resolves other days against the whole preceding coordinated weekday set", () => {
    const parsed = parseSig("Take 1 tablet on Monday Wednesday Friday, 0.5 tablet on Tuesday and 2 tablets on the other days.");
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([1, 0.5, 2]);
    expect(repeat(parsed, 2)?.dayOfWeek).toEqual(["thu", "sat", "sun"]);
  });

  it("keeps every-other-day interval distinct from weekday-set anaphora", () => {
    const parsed = parseSig("Take 1 tablet every other day for 7 days.");
    expect(repeat(parsed, 0)).toMatchObject({ period: 2, periodUnit: "d" });
    expect(repeat(parsed, 0)?.dayOfWeek).toBeUndefined();
  });

  it("supports weekend antecedents without changing a separate dose's clock", () => {
    const parsed = parseSig("Take 1 tablet at 08:00 on weekends and 0.5 tablet at 20:00 on other days.");
    expect(repeat(parsed, 0)?.dayOfWeek).toEqual(["sat", "sun"]);
    expect(repeat(parsed, 1)?.dayOfWeek).toEqual(["mon", "tue", "wed", "thu", "fri"]);
    expect(repeat(parsed, 1)?.timeOfDay).toEqual(["20:00:00"]);
  });

  it("does not override an explicit second weekday set", () => {
    const parsed = parseSig("Take 1 tablet on Monday Wednesday Friday and 0.5 tablet on Tuesday Thursday.");
    expect(repeat(parsed, 1)?.dayOfWeek).toEqual(["tue", "thu"]);
  });

  it("does not invent a weekday set without a weekday antecedent", () => {
    const parsed = parseSig("Take 0.5 tablet on the other days.");
    expect(repeat(parsed, 0)?.dayOfWeek).toBeUndefined();
    expect(parsed.longText.toLowerCase()).toContain("other days");
    expect(parsed.fhir.site).toBeUndefined();
  });
});

describe("ordinal week headers scope over every coordinated dose", () => {
  it.each([
    "Week 1: take 1 tablet at 07:00 and half a tablet at 19:00. Week 2: take half a tablet at 07:00 and 19:00.",
    "Week 1: take 1 tablet at 07:00, half a tablet at 19:00. Week 2: take half a tablet at 07:00 and 19:00.",
    "สัปดาห์ที่ 1 รับประทาน 1 เม็ดเวลา 07:00 และครึ่งเม็ดเวลา 19:00 สัปดาห์ที่ 2 รับประทานครึ่งเม็ดเวลา 07:00 และ 19:00"
  ])("ends the whole first phase, not just its last administration: %s", input => {
    const parsed = parseSig(input);
    expect(parsed.fhirNext.step).toHaveLength(2);
    const first = parsed.fhirNext.step[0].component;
    expect(first.map(row => row.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([1, 0.5]);
    expect(first.every(row => row.timing?.repeat?.boundsDuration?.value === 1 &&
      row.timing.repeat.boundsDuration.code === "wk")).toBe(true);
    const base = { timeZone: "Asia/Bangkok", orderedAt: "2026-11-02T00:00:00+07:00" };
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(calculateTotalUnits({ dosage, ...base, from: base.orderedAt,
        durationValue: 21, durationUnit: "d" }).totalUnits).toBe(17.5);
      expect(nextDueDoses(dosage, { ...base, from: "2026-11-16T00:00:00+07:00", limit: 4 })).toEqual([]);
    }
  });

  it.each(["", " indefinitely"])("does not extend a week header across a later unlabelled phase%s", suffix => {
    const p = parseSig(`Week 1: take half a tablet twice daily. Week 2: take 1 tablet twice daily. Then take 1 tablet daily${suffix}.`);
    expect(p.fhirNext.step).toHaveLength(3);
    expect(p.fhirNext.step[2].component[0].timing?.repeat?.boundsDuration).toBeUndefined();
    const base = { orderedAt: "2026-11-02T00:00:00+07:00", from: "2026-11-02T00:00:00+07:00", timeZone: "Asia/Bangkok" };
    for (const dosage of [p.fhirNext, toFhirR5Dosages(p.fhirNext)]) {
      expect(calculateTotalUnits({ dosage, ...base, durationValue: 28, durationUnit: "d" }).totalUnits).toBe(35);
      expect(nextDueDoses(dosage, { ...base, from: "2026-11-23T00:00:00+07:00", limit: 1 })[0])
        .toBe("2026-11-23T09:00:00+07:00");
    }
  });

  it("retains an explicitly open-ended final week and preserves the preceding weekly bound", () => {
    const parsed = parseSig("Week 1: take 1 tablet at 07:00 and half a tablet at 19:00. Week 2 onwards: take half a tablet at 07:00 and 19:00.");
    expect(parsed.fhirNext.step[0].component.every(row => row.timing?.repeat?.boundsDuration?.value === 1)).toBe(true);
    expect(parsed.fhirNext.step[1].component[0].timing?.repeat?.boundsDuration).toBeUndefined();
  });
});

describe("course durations remain outside administration adjunct arguments", () => {
  it.each([
    "Take 2 tablets with meals and 1 tablet with snacks for 14 days.",
    "Take 2 tablets with meals and 1 tablet with snacks for two weeks.",
    "Take 2 tablets with meals and 1 tablet with snacks for an additional 14 days."
  ])("shares the explicit treatment end without inventing snack timing: %s", source => {
    const p = parseSig(source);
    expect(p.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([2, 1]);
    for (const row of p.items.map(item => item.fhir)) {
      const duration = row.timing?.repeat?.boundsDuration;
      expect(duration).toBeDefined();
      expect(duration!.value! * (duration!.code === "wk" ? 7 : 1)).toBe(14);
    }
    expect(p.items[1].fhir.timing?.repeat?.when).toBeUndefined();
    expect(p.items[1].longText.toLowerCase()).toContain("snack");
    const options = { orderedAt: "2026-11-02T00:00:00+07:00", from: "2026-11-16T00:00:00+07:00", timeZone: "Asia/Bangkok", limit: 4 };
    for (const dosage of [p.fhirNext, toFhirR5Dosages(p.fhirNext)]) expect(nextDueDoses(dosage, options)).toEqual([]);
  });

  it("retains two independently specified bounds instead of sharing the shorter one", () => {
    const p = parseSig("Take 2 tablets with meals for 14 days and 1 tablet with snacks for 7 days.");
    expect(p.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.value)).toEqual([14, 7]);
  });

  it("keeps a separate washing duration procedural rather than truncating the medication course", () => {
    const p = parseSig("Take 1 tablet daily for 14 days; wash hands for 1 minute.");
    expect(p.items).toHaveLength(1);
    expect(p.fhir.timing?.repeat?.boundsDuration).toMatchObject({ value: 14, code: "d" });
    expect(p.longText.toLowerCase()).toContain("minute");
  });
});

// Cardinal durations must not be confused with indexed treatment periods.
describe("cardinal versus ordinal course periods", () => {
  it.each([["two days", 2], ["three days", 3], ["four days", 4],
    ["two weeks", 14], ["three weeks", 21], ["four weeks", 28], ["2 weeks", 14]])(
    "keeps the complete duration of %s", (duration, days) => {
      const parsed = parseSig(`Take 1 tablet daily for ${duration}.`);
      expect(parsed.meta.canonical.clauses[0].schedule?.treatmentStartOffsetDays).toBeUndefined();
      const base = { orderedAt: "2026-11-02T00:00:00+07:00", from: "2026-11-02T00:00:00+07:00", timeZone: "Asia/Bangkok" };
      for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
        expect(nextDueDoses(dosage, { ...base, limit: 1 })[0]).toBe("2026-11-02T09:00:00+07:00");
        expect(calculateTotalUnits({ dosage, ...base, durationValue: 35, durationUnit: "d" }).totalUnits).toBe(days);
      }
    }
  );
  it.each([["the second week", 7], ["week two", 7], ["the third week", 14], ["week three", 14]])(
    "retains the treatment-relative ordinal in %s", (period, offset) => {
      const parsed = parseSig(`Take 1 tablet daily for ${period}.`);
      expect(parsed.meta.canonical.clauses[0].schedule).toMatchObject({
        treatmentStartOffsetDays: offset, duration: 1, durationUnit: "wk"
      });
    }
  );
});

describe("shared course bounds on dose-elliptic event lists", () => {
  it.each([
    ["Take 1 tablet 30 minutes before breakfast and 15 minutes after dinner for 7 days.", [30, 15], ["ACM", "PCV"]],
    ["Take 1 tablet 30 minutes before breakfast and 15 minutes before dinner for 7 days.", [30, 15], ["ACM", "ACV"]],
    ["Take 1 tablet 30 minutes before breakfast, 20 minutes before lunch and 15 minutes after dinner for 7 days.", [30, 20, 15], ["ACM", "ACD", "PCV"]]
  ])("keeps each relative event independent and scopes the shared end: %s", (source, offsets, events) => {
    const parsed = parseSig(source as string);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.offset)).toEqual(offsets);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.when?.[0])).toEqual(events);
    expect(parsed.items.every(item => item.fhir.timing?.repeat?.boundsDuration?.value === 7)).toBe(true);
    const base = { orderedAt: "2026-11-02T00:00:00+07:00", from: "2026-11-02T00:00:00+07:00", timeZone: "Asia/Bangkok" };
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(calculateTotalUnits({ dosage, ...base, durationValue: 14, durationUnit: "d" }).totalUnits).toBe(7 * offsets.length);
      expect(nextDueDoses(dosage, { ...base, from: "2026-11-09T00:00:00+07:00", limit: 2 })).toEqual([]);
    }
  });

  it("preserves explicitly different course lengths", () => {
    const parsed = parseSig("Take 1 tablet 30 minutes before breakfast for 14 days and 15 minutes after dinner for 7 days.");
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.value)).toEqual([14, 7]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.offset)).toEqual([30, 15]);
  });
});

describe("complementary registered activity-day predicates", () => {
  const evaluate = (member: boolean): NonNullable<Parameters<typeof nextDueDoses>[1]>["evaluateCondition"] => {
    const visit = (condition: NonNullable<ReturnType<typeof getDosageCondition>>): boolean =>
      condition.kind === "not" ? !visit(condition.condition) :
      condition.kind === "all" ? condition.conditions.every(visit) :
      condition.kind === "any" ? condition.conditions.some(visit) : member;
    return visit;
  };
  it.each([
    "Take 1 tablet at 08:00 on non-dialysis days.",
    "Take 1 tablet at 08:00 only on non-hemodialysis days.",
    "Take 1 tablet at 08:00 on non dialysis days.",
    "รับประทาน 1 เม็ดเวลา 08:00 ในวันที่ไม่ฟอกไต",
    "รับประทาน 1 เม็ดเวลา 08:00 เฉพาะวันไม่ฟอกไต"
  ])("retains negated membership rather than an unconditional daily dose: %s", source => {
    const p = parseSig(source);
    const condition = getDosageCondition(p.fhir);
    expect(condition?.kind).toBe("not");
    const base = { orderedAt: "2026-11-02T00:00:00+07:00", from: "2026-11-02T00:00:00+07:00", timeZone: "Asia/Bangkok", limit: 1 };
    for (const dosage of [p.fhirNext, toFhirR5Dosages(p.fhirNext)]) {
      expect(nextDueDoses(dosage, { ...base, evaluateCondition: evaluate(true) })).toEqual([]);
      expect(nextDueDoses(dosage, { ...base, evaluateCondition: evaluate(false) })[0]).toBe("2026-11-02T08:00:00+07:00");
    }
  });
  it("keeps different doses mutually exclusive on activity and non-activity days", () => {
    const p = parseSig("Take 1 tablet at 08:00 on dialysis days and half a tablet at 20:00 on non-dialysis days.");
    expect(p.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([1, 0.5]);
    const base = { orderedAt: "2026-11-02T00:00:00+07:00", from: "2026-11-02T00:00:00+07:00", timeZone: "Asia/Bangkok", limit: 2 };
    for (const dosage of [p.fhirNext, toFhirR5Dosages(p.fhirNext)]) {
      expect(nextDueDoses(dosage, { ...base, evaluateCondition: evaluate(true) }).filter(at => at.startsWith("2026-11-02"))).toEqual(["2026-11-02T08:00:00+07:00"]);
      expect(nextDueDoses(dosage, { ...base, evaluateCondition: evaluate(false) }).filter(at => at.startsWith("2026-11-02"))).toEqual(["2026-11-02T20:00:00+07:00"]);
    }
  });
  it("uses a caller-registered activity rather than a dialysis-specific negative rule", () => {
    const p = parseSig("Take 1 tablet at 08:00 on non-physiotherapy days.", {
      instructionConceptMap: { physiotherapy: {
        role: AdviceArgumentRole.Activity, display: "physiotherapy",
        coding: { system: "https://example.test/activity", code: "physiotherapy" }
      } }
    });
    expect(getDosageCondition(p.fhir)).toEqual({
      kind: "not", condition: { kind: "text", text: "physiotherapy days" }
    });
  });
  it("leaves a separate negative activity-day counseling instruction scoped to that instruction", () => {
    const p = parseSig("Take 1 tablet daily. Do not exercise on non-dialysis days.");
    expect(getDosageCondition(p.fhir)).toBeUndefined();
    expect(p.longText.toLowerCase()).toContain("non-dialysis days");
  });
  it("composes exclusion with a negative day domain without losing either operator", () => {
    const p = parseSig("Take 1 tablet at 08:00 except on non-dialysis days.");
    expect(getDosageCondition(p.fhir)).toMatchObject({ kind: "text", text: "dialysis days" });
  });
});

describe("one-time execution uses structured administration timing, not counseling text", () => {
  const start = "2026-11-02T08:00:00+07:00";
  const options = { orderedAt: start, from: start, timeZone: "Asia/Bangkok", limit: 2 };
  it.each(["Do not drive after taking.", "Wash hands before handling the tablet.", "Keep the medicine away from children."])(
    "does not erase a supplied one-time administration because of advice: %s", advice => {
      const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { count: 1, boundsPeriod: { start } } }, patientInstruction: advice };
      const course = toDosageDetails([row]);
      for (const dosage of [row, course, toFhirR5Dosages(course)]) {
        expect(nextDueDoses(dosage, options)).toEqual([start]);
        expect(calculateTotalUnits({ dosage, ...options, durationValue: 1, durationUnit: "d" }).totalUnits).toBe(1);
      }
      expect(row.patientInstruction).toBe(advice);
    }
  );
  it("keeps a source-defined one-time dose separate from a driving warning", () => {
    const p = parseSig("Take 1 tablet once. Do not drive after taking.");
    for (const dosage of [p.fhirNext, toFhirR5Dosages(p.fhirNext)]) {
      expect(nextDueDoses(dosage, options)).toEqual([start]);
      expect(calculateTotalUnits({ dosage, ...options, durationValue: 1, durationUnit: "d" }).totalUnits).toBe(1);
    }
  });
  it.each(["Take 1 tablet once after dialysis.", "insert 1 tab pv once after menstruation ends"])(
    "retains a source-owned relative activity without inventing its date: %s", source => {
      const p = parseSig(source);
      expect(p.meta.canonical.clauses[0].schedule?.activityTiming?.[0]).toMatchObject({ relation: "after" });
      for (const dosage of [p.fhirNext, toFhirR5Dosages(p.fhirNext)]) {
        expect(nextDueDoses(dosage, options)).toEqual([]);
        expect(calculateTotalUnits({ dosage, ...options, durationValue: 1, durationUnit: "d" }))
          .toMatchObject({ totalUnits: 1, quantityKind: "maximum" });
      }
    }
  );
  it("uses an explicitly supplied event instant to resolve the one-time occurrence", () => {
    const row = toFhirR5Dosages(parseSig("Take 1 tablet once after dialysis.").fhirNext)[0];
    row.timing = { ...row.timing, event: [start] };
    expect(nextDueDoses(row, options)).toEqual([start]);
  });
});

describe("scheduled courses followed by independently dosed PRN use", () => {
  it.each([
    "Take 1 tablet daily for 7 days then 1 tablet as needed.",
    "Take 1 tablet daily for 7 days, then 1 tablet PRN.",
    "Take 1 tablet daily for 7 days; then take 1 tablet as needed.",
    "Apply 1 mL to scalp nightly for 7 days then 1 mL as needed.",
    "รับประทาน 1 เม็ดวันละครั้ง 7 วัน จากนั้น 1 เม็ดเมื่อมีอาการปวด"
  ])("keeps the scheduled course non-PRN and the successor non-recurring: %s", source => {
    const p = parseSig(source);
    expect(p.items).toHaveLength(2);
    expect(p.fhirNext.step).toHaveLength(2);
    expect(p.items[0].fhir.asNeeded).not.toBe(true);
    expect(p.items[1].fhir.asNeeded).toBe(true);
    expect(p.items[0].fhir.timing?.repeat?.boundsDuration).toMatchObject({ value: 7, code: "d" });
    expect(p.items[1].fhir.timing?.repeat?.frequency).toBeUndefined();
    expect(p.items[1].fhir.timing?.repeat?.when).toBeUndefined();
    expect(p.items[1].fhir.method?.coding?.[0]?.code).toBe(p.items[0].fhir.method?.coding?.[0]?.code);
    const base = { orderedAt: "2026-11-02T00:00:00+07:00", from: "2026-11-02T00:00:00+07:00", timeZone: "Asia/Bangkok" };
    for (const dosage of [p.fhirNext, toFhirR5Dosages(p.fhirNext)]) {
      expect(nextDueDoses(dosage, { ...base, limit: 20 })).toHaveLength(7);
      expect(nextDueDoses(dosage, { ...base, from: "2026-11-09T00:00:00+07:00", limit: 2 })).toEqual([]);
    }
  });

  it("retains a single PRN course when no new administration is stated", () => {
    const p = parseSig("Take 1 tablet daily for 7 days as needed.");
    expect(p.items).toHaveLength(1);
    expect(p.fhir.asNeeded).toBe(true);
  });

  it("keeps coordinated standing and rescue doses separate without changing them into sequential phases", () => {
    const p = parseSig("Take 1 tablet daily and 1 tablet as needed for pain.");
    expect(p.items).toHaveLength(2);
    expect(p.items[0].fhir.asNeeded).not.toBe(true);
    expect(p.items[1].fhir.asNeeded).toBe(true);
    expect(p.fhirNext.step).toHaveLength(1);
  });
});

describe("source-licensed dose ellipsis in a PRN successor phase", () => {
  it.each([
    "Take 1 tablet daily for 7 days then as needed.",
    "Take 1 tablet daily for 7 days, then PRN for pain.",
    "Take 1 tablet daily for 7 days then take as needed.",
    "รับประทาน 1 เม็ดวันละครั้ง 7 วัน จากนั้นเมื่อมีอาการปวด"
  ])("inherits the unambiguous dose, not the standing cadence or PRN flag: %s", source => {
    const p = parseSig(source);
    expect(p.items).toHaveLength(2);
    expect(p.fhirNext.step).toHaveLength(2);
    expect(p.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity)).toMatchObject([
      { value: 1, unit: "tab" }, { value: 1, unit: "tab" }
    ]);
    expect(p.items[0].fhir.asNeeded).not.toBe(true);
    expect(p.items[1].fhir.asNeeded).toBe(true);
    expect(p.items[1].fhir.timing?.repeat?.frequency).toBeUndefined();
    expect(p.items[1].fhir.timing?.repeat?.boundsDuration).toBeUndefined();
    const base = { orderedAt: "2026-11-02T00:00:00+07:00", from: "2026-11-02T00:00:00+07:00", timeZone: "Asia/Bangkok" };
    for (const dosage of [p.fhirNext, toFhirR5Dosages(p.fhirNext)]) {
      expect(nextDueDoses(dosage, { ...base, limit: 20 })).toHaveLength(7);
      // Supply is a maximum, unlike nextDue's scheduled-dose enumeration.
      // Unbounded PRN use has no numeric maximum to invent.
      expect(() => calculateTotalUnits({ dosage, ...base, durationValue: 14, durationUnit: "d" }))
        .toThrow(/frequency|timing|dosing time/i);
    }
  });

  it("does not choose a dose from conflicting preceding parallel amounts", () => {
    const p = parseSig("Take 1 tablet at 08:00 and half a tablet at 20:00 for 7 days then as needed.");
    expect(p.items.slice(0, 2).map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([1, 0.5]);
    expect(p.items.slice(0, 2).every(item => item.fhir.asNeeded !== true)).toBe(true);
    expect(p.fhirNext.step).toHaveLength(2);
    const successor = p.fhirNext.step[1].component[0];
    expect(successor.asNeeded).toBe(true);
    expect(successor.doseAndRate?.[0]?.doseQuantity).toBeUndefined();
    expect(p.fhirNext.renderedInstruction).toBe("Take 1 tablet at 08:00 and half a tablet at 20:00 for 7 days then as needed.");
  });
});

describe("maximum occurrence count adverbs retain PRN semantics", () => {
  it.each([
    ["up to twice daily", 2, "d"], ["up to once daily", 1, "d"],
    ["no more than thrice daily", 3, "d"], ["maximum twice weekly", 2, "wk"],
    ["up to 2 times daily", 2, "d"], ["maximum 3 times weekly", 3, "wk"]
  ])("composes %s as a cap, not a scheduled cadence or opaque advice", (phrase, max, unit) => {
    const p = parseSig(`Take 1 tablet as needed ${phrase}.`);
    expect(p.fhir.asNeeded).toBe(true);
    expect(p.meta.canonical.clauses[0].schedule?.occurrenceCap)
      .toEqual({ max, period: 1, periodUnit: unit });
    expect(p.fhir.timing?.repeat?.frequency).toBeUndefined();
    for (const row of toFhirR5Dosages(p.fhirNext)) {
      expect(row.asNeeded).toBe(true);
      expect(row.timing?.repeat?.extension).toContainEqual(expect.objectContaining({
        url: expect.stringContaining("occurrence-cap")
      }));
    }
  });

  it("does not reinterpret an unqualified twice-daily cadence as a maximum", () => {
    const p = parseSig("Take 1 tablet twice daily.");
    expect(p.fhir.timing?.repeat).toMatchObject({ frequency: 2, period: 1, periodUnit: "d" });
    expect(p.meta.canonical.clauses[0].schedule?.occurrenceCap).toBeUndefined();
    expect(p.fhir.asNeeded).not.toBe(true);
  });

  it("retains a scheduled first stage followed by a capped PRN stage", () => {
    const p = parseSig("Take 1 tablet daily for 7 days then 1 tablet as needed up to twice daily.");
    expect(p.fhirNext.step).toHaveLength(2);
    expect(p.items[0].fhir.asNeeded).not.toBe(true);
    expect(p.items[1].fhir.asNeeded).toBe(true);
    expect(p.items[1].meta.canonical.clauses[0].schedule?.occurrenceCap).toEqual({ max: 2, period: 1, periodUnit: "d" });
    expect(p.items[1].fhir.timing?.repeat?.frequency).toBeUndefined();
  });
});

describe("calendar-day predicate type survives condition projection", () => {
  it.each([
    "Take 1 tablet at 08:00 on dialysis days.",
    "Take 1 tablet at 08:00 except on dialysis days.",
    "รับประทาน 1 เม็ดเวลา 08:00 เฉพาะวันฟอกไต"
  ])("retains a typed day-domain witness, not a guessed interpretation of its text: %s", source => {
    const p = parseSig(source);
    expect(p.meta.canonical.clauses[0].clinicalAdjuncts?.calendarDayCondition).toBeDefined();
    for (const row of [p.fhir, ...p.fhirNext.step.flatMap(step => step.component), ...toFhirR5Dosages(p.fhirNext)]) {
      expect(row.modifierExtension?.some(extension => extension.extension?.some(part => part.url === "calendarDayPredicate"))).toBe(true);
    }
    expect(p.fhirNext.renderedInstruction).toBe(source);
  });
});

describe("calendar-day typing does not outlive an edited condition", () => {
  it("reads the same source-certified predicate in all representations", () => {
    const p = parseSig("Take 1 tablet at 08:00 on dialysis days.");
    const expected = getDosageCondition(p.fhir);
    for (const row of [p.fhir, ...p.fhirNext.step[0].component, ...toFhirR5Dosages(p.fhirNext)]) {
      expect(getDosageCalendarDayCondition(row)).toEqual(expected);
    }
  });
  it("does not apply stale calendar metadata after a native condition is cleared", () => {
    const p = parseSig("Take 1 tablet at 08:00 on dialysis days.");
    p.fhirNext.step[0].component[0].condition = [];
    expect(getDosageCalendarDayCondition(p.fhirNext.step[0].component[0])).toBeUndefined();
    const strict = toFhirR5Dosages(p.fhirNext);
    expect(getDosageCondition(strict[0])).toBeUndefined();
    expect(getDosageCalendarDayCondition(strict[0])).toBeUndefined();
  });
  it("does not label a changed measurement or a mixed day/measurement predicate as day-constant", () => {
    const row: FhirDosage = {};
    const day = { kind: "text" as const, text: "dialysis days" };
    const measurement = { kind: "measurement" as const, name: "systolic BP", operation: "gt" as const, value: 100, unit: "mmHg", text: "systolic BP above 100 mmHg" };
    setDosageCondition(row, day, day);
    expect(getDosageCalendarDayCondition(row)).toEqual(day);
    setDosageCondition(row, measurement);
    expect(getDosageCondition(row)).toEqual(measurement);
    expect(getDosageCalendarDayCondition(row)).toBeUndefined();
    setDosageCondition(row, { kind: "all", conditions: [day, measurement] }, day);
    expect(getDosageCalendarDayCondition(row)).toBeUndefined();
    expect(getDosageCondition(row)).toEqual({ kind: "all", conditions: [day, measurement] });
  });
  it("leaves a separate unknown modifier intact while carrying known day metadata", () => {
    const unknown = { url: "https://example.test/unknown-condition", valueString: "retain me" };
    const row: FhirDosage = { modifierExtension: [unknown] };
    const day = { kind: "text" as const, text: "dialysis days" };
    setDosageCondition(row, day, day);
    const strict = toFhirR5Dosages(toDosageDetails([row]));
    expect(strict[0].modifierExtension).toContainEqual(unknown);
    expect(getDosageCalendarDayCondition(strict[0])).toEqual(day);
  });
});

describe("shared trailing course across coordinated target changes", () => {
  it.each([
    "Instill 1 drop in right eye at 08:00,12:00,20:00 and 1 drop in left eye at 08:00,20:00 for 7 days.",
    "Instill 1 drop in right eye at 08:00, 12:00 and 20:00 and 1 drop in left eye at 08:00 and 20:00 for 7 days.",
    "หยอดตาขวา 1 หยดเวลา 08:00 12:00 20:00 และตาซ้าย 1 หยดเวลา 08:00 20:00 เป็นเวลา 7 วัน"
  ])("bounds both separately timed targets without copying their clocks: %s", source => {
    const p = parseSig(source);
    expect(p.items).toHaveLength(2);
    expect(p.items.map(item => item.fhir.timing?.repeat?.timeOfDay)).toEqual([
      ["08:00:00", "12:00:00", "20:00:00"], ["08:00:00", "20:00:00"]
    ]);
    expect(p.items.every(item => item.fhir.timing?.repeat?.boundsDuration?.value === 7)).toBe(true);
    const base = { orderedAt: "2026-11-02T00:00:00+07:00", from: "2026-11-02T00:00:00+07:00", timeZone: "Asia/Bangkok" };
    for (const dosage of [p.fhirNext, toFhirR5Dosages(p.fhirNext)]) {
      expect(calculateTotalUnits({ dosage, ...base, durationValue: 28, durationUnit: "d" }).totalUnits).toBe(35);
      expect(nextDueDoses(dosage, { ...base, from: "2026-11-09T00:00:00+07:00", limit: 2 })).toEqual([]);
    }
  });
  it("retains explicitly distinct target-course lengths", () => {
    const p = parseSig("Instill 1 drop in right eye at 08:00,12:00,20:00 for 14 days and 1 drop in left eye at 08:00,20:00 for 7 days.");
    expect(p.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.value)).toEqual([14, 7]);
    expect(p.items.map(item => item.fhir.timing?.repeat?.timeOfDay?.length)).toEqual([3, 2]);
  });
});

describe("explicit daily clock lists are not labelled once daily", () => {
  it.each([
    "Take 1 tablet at 07:00, 13:00 and 19:00 daily for 7 days.",
    "รับประทาน 1 เม็ดเวลา 07:00 13:00 19:00 ทุกวัน 7 วัน"
  ])("renders daily recurrence and all clocks consistently without modifying stored frequency: %s", source => {
    const p = parseSig(source);
    expect(p.fhir.timing?.repeat?.timeOfDay).toEqual(["07:00:00", "13:00:00", "19:00:00"]);
    expect(p.longText.toLowerCase()).not.toContain("once daily");
    const original = structuredClone(p.fhir);
    for (const dosage of [p.fhir, p.fhirNext, toFhirR5Dosages(p.fhirNext)]) {
      for (const style of ["short", "long"] as const) {
        const en = formatSig(dosage, style, { locale: "en" });
        const th = formatSig(dosage, style, { locale: "th" });
        expect(en.toLowerCase()).not.toMatch(/once daily|\b1x\/d\b/);
        expect(th).not.toMatch(/วันละ(?:\s*1\s*)?ครั้ง/);
        expect(style === "short" ? en : en.toLowerCase()).toContain(style === "short" ? "07:00" : "7:00 am");
        expect(th).toContain("07:00");
      }
    }
    expect(p.fhir).toEqual(original);
  });

  it("retains a genuine once-daily instruction at one explicit clock", () => {
    const p = parseSig("Take 1 tablet at 07:00 daily.");
    expect(formatSig(p.fhir, "long", { locale: "en" })).toContain("once daily");
    expect(formatSig(p.fhir, "long", { locale: "th" })).toMatch(/วันละ(?:\s*1\s*)?ครั้ง/);
  });
  it("retains an explicit twice-daily count that agrees with two clocks", () => {
    const p = parseSig("Take 1 tablet twice daily at 08:00 and 20:00.");
    expect(formatSig(p.fhir, "long", { locale: "en" })).toContain("twice daily");
    expect(formatSig(p.fhir, "long", { locale: "th" })).toContain("วันละ 2 ครั้ง");
  });
});


describe("shared course duration on headed and headless clinical SIG lists", () => {
  it.each([
    ["0.5 tab PO at 07:00, 1 tab PO at 12:00 and 0.5 tab PO at 19:00 x7d", 7, 14, 3],
    ["1 tab PO at 07:00, 0.5 tab PO at 12:00, 1 tab PO at 17:00 and 0.5 tab PO at 22:00 x14d", 14, 42, 4],
    ["OD 1 drop at 08:00,12:00,20:00 and OS 1 drop at 08:00,20:00 x7d", 7, 35, 2]
  ] as const)("scopes the finite duration over the complete coordination: %s", (source, days, quantity, rows) => {
    const p = parseSig(source);
    expect(p.items).toHaveLength(rows);
    expect(p.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.value))
      .toEqual(Array(rows).fill(days));
    const base = { from: "2026-11-02T00:00:00+07:00", orderedAt: "2026-11-02T00:00:00+07:00", timeZone: "Asia/Bangkok" };
    for (const dosage of [p.fhirNext, toFhirR5Dosages(p.fhirNext)]) {
      expect(calculateTotalUnits({ dosage, ...base, durationValue: 28, durationUnit: "d" }).totalUnits).toBe(quantity);
      expect(nextDueDoses(dosage, { ...base, from: days === 7 ? "2026-11-09T00:00:00+07:00" : "2026-11-16T00:00:00+07:00", limit: 2 })).toEqual([]);
    }
    expect(p.fhirNext.renderedInstruction).toBe(source);
  });
});


describe("source-shared negative instructions carry their typed guard", () => {
  it.each([
    "take 1 tab at 12:00, then 2 tabs at 16:00, and 1.5 tabs before sleep; do not take if low blood pressure",
    "รับประทาน 1 เม็ด เวลา 12:00 จากนั้น 2 เม็ด เวลา 16:00 และ 1.5 เม็ด ก่อนนอน; ห้ามรับประทานหากความดันโลหิตต่ำ"
  ])("evaluates the shared prohibition on every related dosage: %s", source => {
    const p = parseSig(source, { context: TABLET_CONTEXT });
    const base = { from: "2026-11-02T00:00:00+07:00", orderedAt: "2026-11-02T00:00:00+07:00", timeZone: "Asia/Bangkok", eventClock: { HS: "22:00" }, durationValue: 1, durationUnit: "d" as const };
    for (const dosage of [p.fhirNext, toFhirR5Dosages(p.fhirNext)]) {
      expect(calculateTotalUnits({ dosage, ...base, evaluateCondition: () => false }).totalUnits).toBe(0);
      expect(calculateTotalUnits({ dosage, ...base, evaluateCondition: () => true }).totalUnits).toBe(4.5);
    }
    expect(p.fhirNext.renderedInstruction).toBe(source);
  });
});


describe("independent conditional counseling cannot absorb prescription timing", () => {
  it.each(["avoid driving if drowsy", "ห้ามขับรถหากง่วง", "avoid driving", "do not drive if drowsy"])(
    "preserves the finite PRN course and cap beside %s", counseling => {
      const source = `1 tab PO q4h PRN pain max 4 doses/day x7d; ${counseling}`;
      const p = parseSig(source);
      expect(p.fhir.timing?.repeat?.boundsDuration?.value).toBe(7);
      expect(p.meta.canonical.clauses[0]?.schedule?.occurrenceCap).toEqual({ max: 4, period: 1, periodUnit: "d" });
      expect(p.fhir.maxDosePerPeriod).toBeUndefined();
      expect(getDosageCondition(p.fhir)).toBeUndefined();
      expect(p.fhir.asNeeded).toBe(true);
      const base = { from: "2026-11-02T00:00:00+07:00", orderedAt: "2026-11-02T00:00:00+07:00", timeZone: "Asia/Bangkok" };
      for (const dosage of [p.fhirNext, toFhirR5Dosages(p.fhirNext)]) {
        expect(importCanonicalCourse(dosage).stages[0].administrations[0].schedule?.recurrence?.occurrenceCap)
          .toEqual({ max: 4, period: 1, periodUnit: "d" });
        expect(calculateTotalUnits({ dosage, ...base, durationValue: 28, durationUnit: "d" }).totalUnits).toBe(28);
        expect(nextDueDoses(dosage, { ...base, from: "2026-11-09T00:00:00+07:00", limit: 1 })).toEqual([]);
      }
      expect(p.fhirNext.renderedInstruction).toBe(source);
    }
  );
});


describe("published condition bridge metadata contract", () => {
  it("declares the optional whole-day witness alongside its executable predicate", () => {
    const parsed = parseSig("1 tab PO at 08:00 on dialysis days");
    const bridge = parsed.fhir.modifierExtension?.find(extension =>
      extension.extension?.some(child => child.url === "calendarDayPredicate"));
    expect(bridge?.extension?.map(child => child.url)).toEqual(["predicate", "calendarDayPredicate"]);
    const elements = conditionBridgeDefinition.differential.element;
    const rootChildren = elements.find(element => element.id === "Extension.extension");
    expect(rootChildren?.max === "*" || Number(rootChildren?.max) >= bridge!.extension!.length).toBe(true);
    expect(elements).toContainEqual(expect.objectContaining({
      id: "Extension.extension:calendarDayPredicate", sliceName: "calendarDayPredicate", min: 0, max: "1"
    }));
    expect(elements).toContainEqual(expect.objectContaining({
      id: "Extension.extension:calendarDayPredicate.url", fixedUri: "calendarDayPredicate"
    }));
    expect(elements).toContainEqual(expect.objectContaining({
      id: "Extension.extension:calendarDayPredicate.extension:kind.value[x]", type: [{ code: "code" }]
    }));
  });
});


describe("repeated-course count constituents", () => {
  it.each(["x3", "x 3", "for 3"])("composes repeat %s cycles using the same count meaning", count => {
    const source = `1 tab PO QD x21d then HOLD x7d then repeat ${count} cycles`;
    const p = parseSig(source);
    expect(p.meta.canonical.clauses[0].schedule?.repeatCount).toBe(3);
    const base = { from: "2026-11-02T00:00:00+07:00", orderedAt: "2026-11-02T00:00:00+07:00", timeZone: "Asia/Bangkok" };
    for (const dosage of [p.fhirNext, toFhirR5Dosages(p.fhirNext)]) {
      expect(calculateTotalUnits({ dosage, ...base, durationValue: 112, durationUnit: "d" }).totalUnits).toBe(63);
      expect(nextDueDoses(dosage, { ...base, from: "2026-11-23T00:00:00+07:00", limit: 1 })[0]?.slice(0, 10)).toBe("2026-11-30");
      expect(nextDueDoses(dosage, { ...base, from: "2027-01-25T00:00:00+07:00", limit: 1 })).toEqual([]);
    }
    expect(p.fhirNext.renderedInstruction).toBe(source);
  });
});


describe("cycle eligibility stays visible on structured-only import", () => {
  it("retains the typed qualifier without source label text or duplicated instructions", () => {
    const p = parseSig("1 cap PV HS on cycle days 16-25 for 3 cycles");
    const row = toFhirR5Dosages(p.fhirNext)[0];
    const standalone: FhirDosage = {
      doseAndRate: row.doseAndRate, route: row.route, site: row.site, timing: row.timing,
      modifierExtension: row.modifierExtension?.filter(extension => extension.url.endsWith("medication-cycle-day-eligibility"))
    };
    const before = JSON.stringify(standalone);
    for (const locale of ["en", "th"]) for (const style of ["short", "long"] as const) {
      const text = formatSig(standalone, style, { locale });
      expect(text).toContain("on cycle days 16-25 for 3 cycles");
      expect(text.split("cycle days")).toHaveLength(2);
    }
    expect(formatSig(row, "long", { locale: "en" }).toLowerCase().split("cycle days")).toHaveLength(2);
    expect(JSON.stringify(standalone)).toBe(before);
  });
  it("still displays the structural cycle days when optional source wording is absent", () => {
    const p = parseSig("1 cap PV HS on cycle days 16-25 for 3 cycles");
    const row = toFhirR5Dosages(p.fhirNext)[0];
    const standalone: FhirDosage = {
      doseAndRate: row.doseAndRate, route: row.route, site: row.site, timing: row.timing,
      modifierExtension: row.modifierExtension?.filter(extension => extension.url.endsWith("medication-cycle-day-eligibility"))
        .map(extension => ({ ...extension, extension: extension.extension?.filter(child => child.url !== "source") }))
    };
    const text = formatSig(standalone, "long", { locale: "en" });
    expect(text).toMatch(/cycle/iu);
    expect(text).toContain("16");
    expect(text).toContain("25");
    expect(formatSig(standalone, "long", { locale: "th" })).toContain("รอบ");
  });
});


describe("FHIR Extension differential ordering", () => {
  it.each([
    ["R5 conditional dose", conditionBridgeDefinition],
    ["R5 rendered instruction", renderedInstructionDefinition],
    ["R6 condition logic", conditionLogicDefinition]
  ] as const)("keeps %s in base element and depth-first order", (_name, profile) => {
    // HL7 StructureDefinition 5.4.6: base order, depth-first descendants,
    // and unsliced descendants before slices. Slice order itself is retained.
    const elements = profile.differential.element;
    const ids = elements.map(element => element.id);
    const order: Record<string, number> = { id: 0, extension: 1, url: 2, "value[x]": 3 };
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("Extension");
    for (const [index, id] of ids.entries()) {
      const descendants = ids.map((candidate, position) => candidate.startsWith(id + ".") ? position : -1)
        .filter(position => position >= 0);
      if (descendants.length) {
        expect(descendants, id + " descendants").toEqual(
          Array.from({ length: descendants.length }, (_, offset) => index + offset + 1));
      }
      const direct = ids.filter(candidate => candidate.startsWith(id + ".") &&
        !candidate.slice(id.length + 1).includes("."));
      const ranks = direct.map(candidate => order[candidate.slice(id.length + 1).split(":")[0]]);
      expect(ranks.every(rank => rank !== undefined), id + " known Extension children").toBe(true);
      expect(ranks, id + " base order").toEqual([...ranks].sort((left, right) => left - right));
      for (const [position, child] of direct.entries()) {
        const suffix = child.slice(id.length + 1);
        if (!suffix.includes(":")) continue;
        const unsliced = id + "." + suffix.split(":")[0];
        if (ids.includes(unsliced)) expect(ids.indexOf(unsliced)).toBeLessThan(ids.indexOf(child));
        expect(direct.slice(position + 1)).not.toContain(unsliced);
      }
    }
  });
});


describe("dose-times-frequency whitespace preserves the same clinical regimen", () => {
  const clocks = {
    from: "2026-11-02T00:00:00+07:00", orderedAt: "2026-11-02T00:00:00+07:00",
    timeZone: "Asia/Bangkok", eventClock: { CM: "08:00", CD: "12:30", CV: "18:30" },
    mealOffsets: { PC: 30, PCM: 30, PCD: 30, PCV: 30 }
  };
  it.each(["1x3", "1 x3", "1x 3", "1 x 3", "1 * 3"])(
    "keeps %s as one tablet three times daily, not three tablets once", shorthand => {
      const source = `${shorthand} po pc x5d`;
      const parsed = parseSig(source, { context: TABLET_CONTEXT });
      expect(parsed.fhirNext.renderedInstruction).toBe(source);
      expect(parsed.meta.canonical.clauses[0].dose).toMatchObject({ value: 1, unit: "tab" });
      expect(parsed.meta.canonical.clauses[0].schedule).toMatchObject({ frequency: 3, period: 1, periodUnit: "d", duration: 5, durationUnit: "d" });
      expect(parsed.meta.canonical.clauses[0].schedule?.count).toBeUndefined();
      const strict = toFhirR5Dosages(parsed.fhirNext);
      for (const dosage of [parsed.fhirNext, parsed.fhir, strict, toDosageDetails(strict)]) {
        expect(calculateTotalUnits({ dosage, ...clocks, durationValue: 14, durationUnit: "d" }).totalUnits).toBe(15);
        expect(nextDueDoses(dosage, { ...clocks, limit: 4 })).toEqual([
          "2026-11-02T08:30:00+07:00", "2026-11-02T13:00:00+07:00",
          "2026-11-02T19:00:00+07:00", "2026-11-03T08:30:00+07:00"
        ]);
        expect(nextDueDoses(dosage, { ...clocks, from: "2026-11-07T00:00:00+07:00", limit: 1 })).toEqual([]);
      }
    }
  );
  it("retains a fractional first operand as the per-administration amount", () => {
    const parsed = parseSig("0.5 x 2 po pc x5d", { context: TABLET_CONTEXT });
    expect(parsed.meta.canonical.clauses[0].dose).toMatchObject({ value: 0.5, unit: "tab" });
    expect(parsed.meta.canonical.clauses[0].schedule).toMatchObject({ frequency: 2, duration: 5 });
    expect(parsed.meta.canonical.clauses[0].schedule?.count).toBeUndefined();
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(calculateTotalUnits({ dosage, ...clocks, durationValue: 14, durationUnit: "d" }).totalUnits).toBe(5);
    }
  });
  it.each(["1 tab PO QD x3", "1 tab PO QD x 3 doses"])(
    "leaves an explicitly headed total-dose count unchanged: %s", source => {
      const parsed = parseSig(source);
      expect(parsed.meta.canonical.clauses[0].dose?.value).toBe(1);
      expect(parsed.meta.canonical.clauses[0].schedule).toMatchObject({ frequency: 1, count: 3 });
      for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
        expect(calculateTotalUnits({ dosage, ...clocks, durationValue: 14, durationUnit: "d" }).totalUnits).toBe(3);
        expect(nextDueDoses(dosage, { ...clocks, limit: 20 })).toHaveLength(3);
      }
    }
  );
});


it("round35 keeps a recurring cadence beside a delayed onset", () => {
  const parsed = parseProductionSig("Take 1 tablet every 6 hours in 2 hours");
  expect(parsed.meta.canonical.clauses[0].schedule).toMatchObject({
    period: 6, periodUnit: "h", administrationOffsetMinutes: 120
  });
  expect(parsed.meta.canonical.clauses[0].schedule?.count).toBeUndefined();
  for (const input of [parsed, parsed.meta.canonical.course!, parsed.fhirNext, JSON.parse(JSON.stringify(parsed.fhir))])
    expect(nextDueDoses(input, { orderedAt: "2026-11-21T08:00:00Z", from: "2026-11-21T08:00:00Z",
      timeZone: "UTC", limit: 4 })).toEqual([
        "2026-11-21T10:00:00+00:00", "2026-11-21T16:00:00+00:00",
        "2026-11-21T22:00:00+00:00", "2026-11-22T04:00:00+00:00"
      ]);
});

describe("postposed phase-relation adjuncts", () => {
  it.each(["afterwards", "thereafter", "subsequently"])(
    "keeps an existing phase transition and consumes trailing %s without making a fourth step", (adverb) => {
      const result = parseSig(
        `2 tabs morning, 1 tab evening, for 1 week, then 2 tabs once morning for 1 month, then 1/2 tab po on monday-friday ${adverb}`,
        { locale: "th", context: TABLET_CONTEXT }
      );
      expect(result.count).toBe(4);
      expect(result.fhirNext.step.map(step => step.component.length)).toEqual([2, 1, 1]);
      expect(result.items.map(item => item.fhir.sequence)).toEqual([1, 1, 2, 3]);
      expect(result.meta.leftoverText).toBeUndefined();
      expect(result.items[3].longText).toContain("0.5 เม็ด");
      expect(result.items[3].longText).toContain("วันจันทร์");
      expect(result.items[3].fhir.timing?.repeat?.dayOfWeek).toEqual(["mon", "tue", "wed", "thu", "fri"]);
      expect(result.items[3].fhir.timing?.repeat?.when).toEqual(["MORN"]);
    }
  );
});


{

const parseSig = parsePublicSig;


describe("round 44: course-wide choice and timing ownership", () => {
  const boundary = (value: number): CanonicalBoundary => ({
    anchor: "treatment-start", displacement: { value, system: "http://unitsofmeasure.org", code: "d" }
  });
  const member = (value: number, branch?: string): CanonicalAdministration => ({
    kind: "administration", amounts: [{ quantity: { value, unit: "tab" } }],
    schedule: { recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, clocks: ["08:00:00"] } },
    ...(branch ? { choice: { groupId: "taper", branchId: branch } } : {})
  });
  const views = (course: CanonicalCourse) => {
    const r6 = courseToR6(course);
    return [r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))];
  };

  it.each(["en", "th"])("retains text-only application directions beside a member end in %s", locale => {
    const text = "Apply a thin layer to the affected area";
    const course: CanonicalCourse = { kind: "course", instruction: text, stages: [{
      administrations: [{ kind: "administration", text, phaseEnd: boundary(3) }]
    }] };
    for (const input of views(course)) {
      const before = JSON.stringify(input);
      expect(formatSig(input, "long", { locale, realizationMode: "normalized" }))
        .toBe((locale === "en" ? "Until 3 days after treatment start: " : "จนถึง3 วันหลังเริ่มการรักษา: ") + text);
      expect(JSON.stringify(input)).toBe(before);
    }
    const untimed = courseToR6({ ...course, stages: [{ administrations: [{ kind: "administration", text }] }] });
    expect(formatSig(untimed, "long", { locale, realizationMode: "normalized" })).toBe(text);
  });

  it.each(["en", "th"])("ties each taper branch to one choice across reordered stages in %s", locale => {
    const course: CanonicalCourse = { kind: "course", stages: [
      { start: boundary(0), end: boundary(7), administrations: [member(2, "A"), member(4, "B")] },
      { end: boundary(14), administrations: [member(3, "B"), member(1, "A")] }
    ] };
    const expected = locale === "en" ? [
      "Choose one: (1) or (2).",
      "From treatment start until 7 days after treatment start: (1) Use 2 tablets once daily at 8:00 am; (2) Use 4 tablets once daily at 8:00 am.",
      "From 7 days after treatment start until 14 days after treatment start: (2) Use 3 tablets once daily at 8:00 am; (1) Use 1 tablet once daily at 8:00 am."
    ] : [
      "เลือกอย่างใดอย่างหนึ่ง: (1) หรือ (2).",
      "ตั้งแต่เริ่มการรักษาจนถึง7 วันหลังเริ่มการรักษา: (1) ใช้ครั้งละ 2 เม็ด วันละครั้ง เวลา 08:00; (2) ใช้ครั้งละ 4 เม็ด วันละครั้ง เวลา 08:00.",
      "ตั้งแต่7 วันหลังเริ่มการรักษาจนถึง14 วันหลังเริ่มการรักษา: (2) ใช้ครั้งละ 3 เม็ด วันละครั้ง เวลา 08:00; (1) ใช้ครั้งละ 1 เม็ด วันละครั้ง เวลา 08:00."
    ];
    for (const input of views(course)) {
      const before = JSON.stringify(input);
      expect(formatSig(input, "long", { locale, realizationMode: "normalized" })).toBe(expected.join(" "));
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["en", "th"])("qualifies the B-only pause without forbidding A's successor doses in %s", locale => {
    const course: CanonicalCourse = { kind: "course", stages: [
      { start: boundary(0), end: boundary(2), administrations: [member(1, "A")] },
      { start: boundary(4), end: boundary(6), administrations: [member(2, "B")] },
      { end: boundary(8), administrations: [member(3)] }
    ] };
    const pause = locale === "en" ? "No doses from treatment start until 4 days after treatment start."
      : "งดยาตั้งแต่เริ่มการรักษาจนถึง4 วันหลังเริ่มการรักษา.";
    for (const input of views(course)) {
      const before = JSON.stringify(input);
      const preview = formatSig(input, "long", { locale, realizationMode: "normalized" });
      expect(preview.endsWith("(2): " + pause)).toBe(true);
      expect(preview.split(locale === "en" ? "No doses" : "งดยา")).toHaveLength(2);
      expect(preview).toContain(locale === "en"
        ? "After the previous phase; Until 8 days after treatment start: Use 3 tablets"
        : "หลังขั้นตอนก่อนหน้า; จนถึง8 วันหลังเริ่มการรักษา: ใช้ครั้งละ 3 เม็ด");
      const options = { orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-03T00:00:00Z", timeZone: "UTC", limit: 2 };
      expect(nextDueDoses(input, { ...options, alternativeChoices: { taper: "A" } })).toEqual([
        "2026-01-03T08:00:00+00:00", "2026-01-04T08:00:00+00:00"
      ]);
      expect(nextDueDoses(input, { ...options, alternativeChoices: { taper: "B" } })).toEqual([
        "2026-01-05T08:00:00+00:00", "2026-01-06T08:00:00+00:00"
      ]);
      expect(JSON.stringify(input)).toBe(before);
    }
    for (const input of views({ ...course, stages: course.stages.slice(1) })) {
      expect(formatSig(input, "long", { locale, realizationMode: "normalized" }).endsWith(pause)).toBe(true);
    }
  });

  it.each(["en", "th"])("uses the selected %s facet for scalar and ranged long duration units", locale => {
    const base = locale === "en" ? ENGLISH_COURSE : THAI_COURSE;
    const course = { ...base, timeUnit: (unit: string, value: number | undefined) =>
      unit === "h" ? "custom-hours" : base.timeUnit(unit, value) };
    const options = { locale, realizationMode: "normalized" as const, i18n: { course } };
    const quantities = [
      { duration: 2, durationUnit: FhirPeriodUnit.Hour },
      { boundsDuration: { value: 2, code: "h", unit: "h", system: "http://unitsofmeasure.org" } },
      { boundsRange: {
        low: { value: 1, code: "min", unit: "min", system: "http://unitsofmeasure.org" },
        high: { value: 2, code: "h", unit: "h", system: "http://unitsofmeasure.org" }
      } }
    ];
    for (const repeat of quantities) {
      const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], timing: { repeat } };
      const saved = JSON.stringify(row);
      expect(formatSig(row, "long", options)).toContain("2 custom-hours");
      expect(formatSig(row, "short", options)).not.toContain("custom-hours");
      expect(JSON.stringify(row)).toBe(saved);
    }
  });
});


describe("round45 authored directions with independent administration caps", () => {
  it.each(["en", "th"])("retains the only directions beside the live cap in %s", locale => {
    const directions = "Swallow 1 tablet whole every morning";
    for (const cap of [2, 3]) {
      const raw: FhirR6DosageInstruction = { step: [{ component: [{
        text: directions, safety: { doseLimit: [{
          scope: "administration", valueQuantity: { value: cap, unit: "tab" }
        }] }
      }] }] };
      const before = JSON.stringify(raw), rows = toFhirR5Dosages(raw);
      const rowsBefore = JSON.stringify(rows), persisted = JSON.parse(rowsBefore);
      for (const input of [raw, rows, toDosageDetails(persisted)]) {
        for (const realizationMode of [undefined, "normalized", "roundtrip"] as const) {
          const text = formatSig(input, "long", { locale, realizationMode });
          expect(text).toContain(directions);
          expect(text).toContain("max per administration: " + cap + " tab");
        }
      }
      expect(JSON.stringify(raw)).toBe(before);
      expect(JSON.stringify(rows)).toBe(rowsBefore);
      expect(JSON.stringify(persisted)).toBe(rowsBefore);
      const current = JSON.parse(before) as FhirR6DosageInstruction;
      current.step![0].component[0].doseAndRate = [{ doseQuantity: { value: 2, unit: "tab" } }];
      const text = formatSig(current, "long", { locale, realizationMode: "normalized" });
      expect(text).toMatch(locale === "en"
        ? /(?:^|\s)2 tablets(?:\s|[.;,]|$)/u
        : /(?:^|\s)2 เม็ด(?:\s|[.;,]|$)/u);
      const [currentText, original] = text.split(locale === "en" ? "; original directions: " : "; ข้อความเดิม: ");
      expect(currentText).not.toContain(directions);
      expect(currentText).toContain("max per administration: " + cap + " tab");
      expect(original).toBe(directions);
    }
  });
});

describe("round47 public preview timing and resolver ownership", () => {
  it.each([false, true])("keeps a range-start heading open only for a final stage (%s)", final => {
    const range = {
      low: { value: 1, unit: "d", code: "d", system: "http://unitsofmeasure.org", id: "low" },
      high: { value: 1, unit: "d", code: "d", system: "http://unitsofmeasure.org", id: "high" }
    };
    const contextCode = { coding: [{
      system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start"
    }] };
    const start = { contextCode, offsetRange: range };
    const component = (value: number): FhirR6Dosage => ({
      doseAndRate: [{ doseQuantity: { value, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] } }
    });
    const raw: FhirR6DosageInstruction = { step: [
      { start, component: [component(2)] },
      ...(final ? [] : [{ start: { contextCode, offsetDuration: {
        value: 7, unit: "d", code: "d", system: "http://unitsofmeasure.org"
      } }, component: [component(1)] }])
    ] };
    const rows = toFhirR5Dosages(raw), cold = JSON.parse(JSON.stringify(rows));
    const english = final
      ? "From 1 day – 1 day after treatment start onward: Use 2 tablets once daily at 8:00 am."
      : "1 day – 1 day after treatment start: Use 2 tablets once daily at 8:00 am. "
        + "From 7 days after treatment start onward: Use 1 tablet once daily at 8:00 am.";
    const thai = final
      ? "ตั้งแต่1 วัน – 1 วันหลังเริ่มการรักษาเป็นต้นไป: ใช้ครั้งละ 2 เม็ด วันละครั้ง เวลา 08:00."
      : "1 วัน – 1 วันหลังเริ่มการรักษา: ใช้ครั้งละ 2 เม็ด วันละครั้ง เวลา 08:00. "
        + "ตั้งแต่7 วันหลังเริ่มการรักษาเป็นต้นไป: ใช้ครั้งละ 1 เม็ด วันละครั้ง เวลา 08:00.";
    for (const input of [raw, rows, cold]) {
      const before = JSON.stringify(input);
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toBe(english);
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" })).toBe(thai);
      expect(toDosageDetails(toFhirR5Dosages(input)).step[0].start).toEqual(start);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each([
    { name: "code-only", period: undefined, short: "1 tab QAM" },
    { name: "daily", period: 1, short: "1 tab QAM MORN" },
    { name: "every two days", period: 2, short: "1 tab Q2D MORN" }
  ])("renders the live $name morning cadence without changing the source code", ({ period, short }) => {
    const timing: FhirDosage["timing"] = {
      code: { text: "QAM" },
      ...(period === undefined ? {} : { repeat: {
        frequency: 1, period, periodUnit: FhirPeriodUnit.Day, when: [EventTiming.Morning]
      } })
    };
    const raw: FhirDosage[] = [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], timing }];
    const r6 = toDosageDetails(raw), cold = JSON.parse(JSON.stringify(toFhirR5Dosages(r6)));
    for (const input of [raw, r6, cold]) {
      const before = JSON.stringify(input);
      expect(formatSig(input, "short", { locale: "en" })).toBe(short);
      expect(toFhirR5Dosages(input)[0].timing).toEqual(timing);
      expect(toDosageDetails(toFhirR5Dosages(input)).step[0].component[0].timing).toEqual(timing);
      expect(JSON.stringify(input)).toBe(before);
    }
  });
});


describe("round48 saved sequence and locale ownership", () => {
  it.each([false, true])("keeps count-ended sequencing beside a ranged end (explicit start %s)", explicit => {
    const contextCode = { coding: [{
      system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start"
    }] };
    const range = {
      low: { value: 7, unit: "d", code: "d", system: "http://unitsofmeasure.org", id: "low" },
      high: { value: 7, unit: "d", code: "d", system: "http://unitsofmeasure.org", id: "high" }
    };
    const component = (value: number, count?: number): FhirR6Dosage => ({
      doseAndRate: [{ doseQuantity: { value, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["08:00:00"], ...(count ? { count } : {}) } }
    });
    const raw: FhirR6DosageInstruction = { step: [
      { component: [component(1, 2)] },
      { ...(explicit ? { start: { contextCode, offsetDuration: {
        value: 2, unit: "d", code: "d", system: "http://unitsofmeasure.org"
      } } } : {}), end: { contextCode, offsetRange: range }, component: [component(2)] }
    ] };
    const rows = toFhirR5Dosages(raw);
    for (const input of [raw, rows, JSON.parse(JSON.stringify(rows))]) {
      const before = JSON.stringify(input);
      for (const locale of ["en", "th"]) for (const style of ["long", "short"] as const) {
        const words = locale === "en" ? ENGLISH_COURSE : THAI_COURSE;
        const text = formatSig(input, style, { locale, realizationMode: "normalized" });
        expect(text.includes(words.afterPreviousPhase + "; ")).toBe(!explicit);
        expect(text).toContain(locale === "en" ? "7 days – 7 days" : "7 วัน – 7 วัน");
        if (explicit) expect(text).toContain(locale === "en" ? "From 2 days" : "ตั้งแต่2 วัน");
      }
      expect(toDosageDetails(toFhirR5Dosages(input)).step[1].end?.offsetRange).toEqual(range);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["en", "th"])("uses the inherited %s course facet for maximum-only periods", locale => {
    const base = locale === "en" ? ENGLISH_COURSE : THAI_COURSE;
    const course = { ...base, timeUnit: (unit: string, value: number | undefined) =>
      unit === "d" ? "custom-days" : base.timeUnit(unit, value) };
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { periodMax: 2, periodUnit: FhirPeriodUnit.Day } } };
    const saved = JSON.stringify(row);
    for (const style of ["long", "short"] as const) {
      const options = { locale: "round48-" + locale, realizationMode: "normalized" as const,
        i18n: { inherit: locale, course } };
      expect(formatSig(row, style, options))
        .toContain(locale === "en" ? "every up to 2 custom-days" : "ทุกไม่เกิน 2 custom-days");
      expect(formatSig(row, style, { locale, realizationMode: "normalized" }))
        .toContain(locale === "en" ? "every up to 2 days" : "ทุกไม่เกิน 2 วัน");
    }
    expect(JSON.stringify(row)).toBe(saved);
  });
});

describe("round52 independent preparation and explicit accompaniment owners", () => {
  it.each([false, true])("retains independently measured water beside a live tablet dose (primary span: %s)", explicitPrimary => {
    const action = parseInstructionActions("Measure 100 mL of water")[0];
    action.args.push({ role: AdviceArgumentRole.Theme, text: "water", normalized: "water",
      span: { start: 18, end: 23 } });
    const graph: CanonicalInstructionGraph = {
      actions: [action], sourceLocale: "en", sourceText: explicitPrimary
        ? "Measure 100 mL of water then swallow 1 tablet" : "Measure 100 mL of water",
      ...(explicitPrimary ? { primaryAdministrationSpan: { start: 29, end: 45 } } : {})
    };
    const row: FhirDosage = JSON.parse(JSON.stringify(parseSig("Swallow 1 tablet").fhir[0]));
    const annotation = { url: "urn:round52:unrelated", valueString: "preserve" };
    row.extension = [...(row.extension ?? []).filter(item => item.url !== MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL),
      buildInstructionGraphExtension(graph)!, annotation];
    const before = JSON.stringify(row), graphBefore = JSON.stringify(graph);
    const r6 = toDosageDetails([row]);
    const cold = JSON.parse(JSON.stringify(toFhirR5Dosages(r6)));
    for (const input of [[row], r6, cold]) {
      const saved = JSON.stringify(input);
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        const text = formatSig(input, "long", { locale: "en", realizationMode });
        expect(text).toContain("100 mL");
        expect(text.toLowerCase()).toContain("water");
        expect(text.toLowerCase()).toContain("swallow 1 tablet");
        expect(text.match(/100 mL/gu)).toHaveLength(1);
        expect(text.match(/1 tablet/gu)).toHaveLength(1);
      }
      const first = importCanonicalCourse(input).stages[0].administrations[0];
      expect(first.amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(JSON.stringify(input)).toBe(saved);
    }
    expect(cold[0].extension).toContainEqual(annotation);
    expect(parseInstructionGraphExtension(cold[0].extension)?.actions[0].args.find(
      arg => arg.role === AdviceArgumentRole.Amount)?.quantity).toMatchObject({ value: 100, unit: "mL" });
    expect(JSON.stringify(row)).toBe(before);
    expect(JSON.stringify(graph)).toBe(graphBefore);
  });

  it("keeps the sole spanless medication amount under the current structured dose", () => {
    const graph: CanonicalInstructionGraph = {
      actions: parseInstructionActions("Measure 100 mL"), sourceText: "Measure 100 mL", sourceLocale: "en"
    };
    const row: FhirDosage = JSON.parse(JSON.stringify(parseSig("Measure 100 mL").fhir[0]));
    row.doseAndRate![0].doseQuantity!.value = 150;
    row.extension = [...(row.extension ?? []).filter(item => item.url !== MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL),
      buildInstructionGraphExtension(graph)!];
    const saved = JSON.stringify(row), graphSaved = JSON.stringify(graph);
    for (const input of [[row], toDosageDetails([row])])
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        const text = formatSig(input, "long", { locale: "en", realizationMode });
        expect(text.match(/150 mL/gu)).toHaveLength(1);
        expect(text).not.toContain("100 mL");
        expect(text).toContain("Measure");
      }
    expect(JSON.stringify(row)).toBe(saved);
    expect(JSON.stringify(graph)).toBe(graphSaved);
  });

  it.each(["site-before-with", "with-before-site", "locative-only"] as const)(
    "retains the typed application site independently of explicit accompaniment (%s)", order => {
      const source = order === "locative-only" ? "Apply cream to the skin" : "Apply cream to the skin with a cotton swab";
      const parsed = parseInstructionActions("Apply cream to the skin")[0];
      const theme = { role: AdviceArgumentRole.Theme, text: "cream", normalized: "cream" };
      const site = { ...parsed.args.find(arg => arg.role === AdviceArgumentRole.Site)!, relation: AdviceRelation.To };
      const object = { role: AdviceArgumentRole.Object, text: "a cotton swab", normalized: "cotton swab",
        relation: AdviceRelation.With };
      const graph: CanonicalInstructionGraph = { sourceText: source, sourceLocale: "en", actions: [{
        ...parsed, sourceText: source, span: { start: 0, end: source.length },
        args: order === "locative-only" ? [theme, site] :
          order === "site-before-with" ? [theme, site, object] : [theme, object, site]
      }] };
      const annotation = { url: "urn:round52:unrelated", valueString: "preserve" };
      const row: FhirDosage = { method: { coding: [{
        system: "http://snomed.info/sct", code: "738991002", display: "Apply"
      }] }, extension: [buildInstructionGraphExtension(graph)!, annotation] };
      const expected = "Apply cream to the skin" + (order === "locative-only" ? "" : " with cotton swab");
      expect(realizeInstructionGraph(graph, "en")).toBe(expected);
      const before = JSON.stringify(row), graphBefore = JSON.stringify(graph);
      const r6 = toDosageDetails([row]);
      const cold = JSON.parse(JSON.stringify(toFhirR5Dosages(r6)));
      for (const input of [[row], r6, cold]) {
        const saved = JSON.stringify(input);
        const normalized = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
        expect(normalized).toContain(expected);
        expect(normalized).toContain("cream to the skin");
        if (order !== "locative-only") expect(normalized.match(/with cotton swab/gu)).toHaveLength(1);
        else expect(normalized).not.toContain("with");
        const roundtrip = formatSig(input, "long", { locale: "en", realizationMode: "roundtrip" });
        expect(roundtrip).toContain(source);
        expect(JSON.stringify(input)).toBe(saved);
      }
      expect(cold[0].extension).toContainEqual(annotation);
      expect(JSON.stringify(row)).toBe(before);
      expect(JSON.stringify(graph)).toBe(graphBefore);
    });
});


describe("round 53: saved graph and calendar realization ownership", () => {
  const persist = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const annotation = { url: "urn:round53:independent-note", valueString: "keep authored note" };
  const graphNote = { url: "urn:round53:graph-note", valueString: "keep graph annotation" };
  const rowForGraph = (graph: CanonicalInstructionGraph): FhirDosage => {
    const wire = persist(buildInstructionGraphExtension(graph)!);
    wire.extension!.push(graphNote);
    return { extension: [wire, annotation] };
  };
  const graphViews = (row: FhirDosage) => {
    const r6 = toDosageDetails([row]);
    const cold = persist(toFhirR5Dosages(r6));
    expect(cold[0].extension).toContainEqual(annotation);
    expect(cold[0].extension!.find(item => item.url === MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL)!.extension)
      .toContainEqual(graphNote);
    return [[row], r6, cold];
  };

  it.each(["A", "B", "no-choice"] as const)(
    "retains an authored empty timed stage before a selected successor (%s)", branch => {
      const boundary = (value: number): CanonicalBoundary => ({
        anchor: "treatment-start", displacement: { value, system: "http://unitsofmeasure.org", code: "d" }
      });
      const member = (value: number, choice?: string): CanonicalAdministration => ({
        kind: "administration", amounts: [{ quantity: { value, unit: "tab" } }],
        schedule: { recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, clocks: ["08:00:00"] } },
        ...(choice ? { choice: { groupId: "round53-pause", branchId: choice } } : {})
      });
      const course: CanonicalCourse = { kind: "course", stages: [
        { start: boundary(0), end: boundary(2), administrations: branch === "no-choice"
          ? [member(1)] : [member(1, "A"), member(2, "B")] },
        { end: boundary(4), administrations: [] },
        { end: boundary(7), administrations: [member(3)] }
      ] };
      const before = JSON.stringify(course), r6 = courseToR6(course);
      for (const input of [r6, persist(toFhirR5Dosages(r6))]) {
        const saved = JSON.stringify(input);
        expect(nextDueDoses(input, { orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-03T00:00:00Z",
          timeZone: "UTC", limit: 2,
          ...(branch === "no-choice" ? {} : { alternativeChoices: { "round53-pause": branch } })
        })).toEqual(["2026-01-05T08:00:00+00:00", "2026-01-06T08:00:00+00:00"]);
        const english = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
        expect(english).toContain("No doses from 2 days after treatment start until 4 days after treatment start.");
        expect(english.match(/No doses/gu)).toHaveLength(1);
        const thai = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
        expect(thai).toContain("งดยาตั้งแต่2 วันหลังเริ่มการรักษาจนถึง4 วันหลังเริ่มการรักษา.");
        expect(thai.match(/งดยา/gu)).toHaveLength(1);
        expect(JSON.stringify(input)).toBe(saved);
      }
      expect(JSON.stringify(course)).toBe(before);
    });

  it.each(["current-threshold", "graph-only"] as const)(
    "keeps primary and independent graph conditions with the correct owner (%s)", mode => {
      const source = "Take 1 tablet daily if SBP > 160; Call clinic if dizzy";
      const take = parseInstructionActions("Take 1 tablet")[0];
      const callStart = source.indexOf("Call"), conditionStart = source.indexOf("if SBP");
      const call = parseInstructionActions("Call clinic")[0];
      const graph: CanonicalInstructionGraph = { sourceText: source, sourceLocale: "en",
        primaryAdministrationSpan: take.span,
        actions: [take, { ...call, span: { start: callStart, end: callStart + 11 } }],
        relations: [
          { kind: AdviceRelation.If, toActionIndex: 0, text: "if SBP > 160",
            span: { start: conditionStart, end: conditionStart + 12 } },
          { kind: AdviceRelation.If, toActionIndex: 1, text: "if dizzy",
            span: { start: source.indexOf("if dizzy"), end: source.length } }
        ] };
      const row = rowForGraph(graph);
      const base = persist(parseSig("Take 1 tablet daily if SBP > 160").fhirNext.step![0].component[0]);
      const condition = mode === "current-threshold" ? [{ ...base.condition![0],
        valueQuantity: { ...base.condition![0].valueQuantity, value: 140 } }] : undefined;
      const current: FhirR6DosageInstruction = { step: [{ component: [{ ...base,
        condition, extension: row.extension, text: undefined
      }] }] };
      const saved = JSON.stringify(current), graphSaved = JSON.stringify(graph);
      for (const input of [current, persist(toFhirR5Dosages(current))]) {
        const inputSaved = JSON.stringify(input);
        for (const locale of ["en", "th"]) {
          const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
          expect(text.match(new RegExp(mode === "current-threshold" ? "140" : "160", "gu"))).toHaveLength(1);
          if (mode === "current-threshold") expect(text).not.toContain("160");
          expect(text).toContain(locale === "en" ? "if dizzy" : "ถ้าเวียนศีรษะ");
          expect(text).toContain("Call clinic");
          const threshold = mode === "current-threshold" ? "140" : "160";
          expect(text).toContain(locale === "en"
            ? `Take 1 tablet orally once daily ${mode === "current-threshold" ? "only if" : "if"} SBP > ${threshold}.`
            : `รับประทานครั้งละ 1 เม็ด วันละครั้ง ${mode === "current-threshold" ? "เฉพาะเมื่อ" : "if"} SBP > ${threshold}.`);
          expect(text).toContain(locale === "en" ? "Call clinic if dizzy." : "Call clinicถ้าเวียนศีรษะ.");
        }
        const exported = toFhirR5Dosages(input);
        expect(exported[0].extension).toContainEqual(annotation);
        expect(parseInstructionGraphExtension(exported[0].extension)?.relations)
          .toEqual(graph.relations!.map(relation => ({
            ...relation,
            sourceKindCoding: { system: "http://snomed.info/sct", code: "421803000",
              display: "If - dosing instruction fragment" },
          })));
        expect(JSON.stringify(input)).toBe(inputSaved);
      }
      expect(JSON.stringify(current)).toBe(saved);
      expect(JSON.stringify(graph)).toBe(graphSaved);
    });

  it.each(["theme-first", "vehicle-first", "explicit-vehicle-first"] as const)(
    "prefers the explicit mixing Theme regardless of saved argument order (%s)", order => {
      const source = "Mix powder with household spoon", parsed = parseInstructionActions(source)[0];
      const theme = { ...parsed.args.find(arg => arg.role === AdviceArgumentRole.Theme)!,
        i18n: { en: "powder", th: "ผง" } };
      const vehicle = { ...parsed.args.find(arg => arg.role === AdviceArgumentRole.Object)!,
        relation: order === "explicit-vehicle-first" ? AdviceRelation.With : undefined };
      const graph: CanonicalInstructionGraph = { sourceText: source, sourceLocale: "en", actions: [{
        ...parsed, relation: AdviceRelation.With,
        args: order === "theme-first" ? [theme, vehicle] : [vehicle, theme]
      }] };
      const saved = JSON.stringify(graph), row = rowForGraph(graph), rowSaved = JSON.stringify(row);
      expect(realizeInstructionGraph(graph, "en")).toBe(source);
      const thaiAction = realizeInstructionGraph(graph, "th")!;
      expect(thaiAction.match(/ผง/gu)).toHaveLength(1);
      expect(thaiAction.match(/ช้อนกินข้าว/gu)).toHaveLength(1);
      for (const input of graphViews(row)) {
        const before = JSON.stringify(input);
        for (const locale of ["en", "th"]) {
          const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
          expect(text.match(locale === "en" ? /powder/gu : /ผง/gu)).toHaveLength(1);
          expect(text.match(locale === "en" ? /with household spoon/gu : /ช้อนกินข้าว/gu)).toHaveLength(1);
        }
        expect(JSON.stringify(input)).toBe(before);
      }
      expect(JSON.stringify(graph)).toBe(saved);
      expect(JSON.stringify(row)).toBe(rowSaved);
    });

  it.each(["substance", "material", "unmarked-material", "legacy-to"] as const)(
    "renders a dilution material and each related complement once (%s)", kind => {
      const source = kind === "legacy-to" ? "Dilute to 10 mL" :
        kind === "unmarked-material" ? "Dilute 1 mL saline to 10 mL" : "Dilute 1 mL with saline to 10 mL";
      const parsed = parseInstructionActions("Dilute 1 mL with saline to 10 mL")[0];
      const amount = parsed.args.find(arg => arg.role === AdviceArgumentRole.Amount)!;
      const saline = { role: kind === "substance" ? AdviceArgumentRole.Substance : AdviceArgumentRole.Material,
        text: "saline", normalized: "saline", i18n: { th: "น้ำเกลือ" },
        relation: kind === "unmarked-material" ? undefined : AdviceRelation.With };
      const destination = { role: kind === "legacy-to" ? AdviceArgumentRole.Object : AdviceArgumentRole.Destination,
        text: "10 mL", normalized: "mL", quantity: { value: 10, unit: "mL" },
        relation: kind === "legacy-to" ? undefined : AdviceRelation.To };
      const graph: CanonicalInstructionGraph = { sourceText: source, sourceLocale: "en", actions: [{
        ...parsed, sourceText: source, span: { start: 0, end: source.length },
        relation: kind === "legacy-to" ? AdviceRelation.To : undefined,
        args: kind === "legacy-to" ? [destination] : [amount, saline, destination]
      }] };
      const saved = JSON.stringify(graph), row = rowForGraph(graph), rowSaved = JSON.stringify(row);
      expect(realizeInstructionGraph(graph, "en")).toBe(kind === "unmarked-material"
        ? "Dilute 1 mL of saline to 10 mL" : source);
      for (const input of graphViews(row)) {
        const before = JSON.stringify(input);
        for (const locale of ["en", "th"]) {
          const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
          expect(text.match(locale === "en" ? /10 mL/gu : /10 มิลลิลิตร/gu)).toHaveLength(1);
          if (kind !== "legacy-to") {
            expect(text.match(locale === "en" ? /saline/gu : /น้ำเกลือ/gu)).toHaveLength(1);
            expect(text.match(locale === "en" ? /1 mL/gu : /1 มิลลิลิตร/gu)).toHaveLength(1);
          }
        }
        expect(JSON.stringify(input)).toBe(before);
      }
      expect(JSON.stringify(graph)).toBe(saved);
      expect(JSON.stringify(row)).toBe(rowSaved);
    });

  it.each(["before-and-until", "before-only", "until-only"] as const)(
    "keeps a saved action time and independently related result distinct (%s)", kind => {
      const source = "Shake" + (kind !== "until-only" ? " before each use" : "") +
        (kind !== "before-only" ? " until evenly mixed" : "");
      const parsed = parseInstructionActions("Shake before each use")[0];
      const time = { role: AdviceArgumentRole.Time, text: "each use", normalized: "each use",
        relation: AdviceRelation.Before, i18n: { th: "การใช้แต่ละครั้ง" } };
      const result = { role: AdviceArgumentRole.Result, text: "evenly mixed", normalized: "evenly mixed",
        relation: AdviceRelation.Until, i18n: { th: "ผสมเข้ากันดี" } };
      const graph: CanonicalInstructionGraph = { sourceText: source, sourceLocale: "en", actions: [{
        ...parsed, predicate: { ...parsed.predicate, realizer: "default" },
        sourceText: source, span: { start: 0, end: source.length },
        relation: kind === "until-only" ? AdviceRelation.Until : AdviceRelation.Before,
        args: kind === "before-only" ? [time] : kind === "until-only" ? [result] : [time, result]
      }] };
      const saved = JSON.stringify(graph), row = rowForGraph(graph), rowSaved = JSON.stringify(row);
      expect(realizeInstructionGraph(graph, "en")).toBe(source);
      for (const input of graphViews(row)) {
        const before = JSON.stringify(input);
        for (const locale of ["en", "th"]) {
          const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
          if (kind !== "until-only") expect(text.match(locale === "en"
            ? /before each use/gu : /ก่อนการใช้แต่ละครั้ง/gu)).toHaveLength(1);
          if (kind !== "before-only") expect(text.match(locale === "en"
            ? /until evenly mixed/gu : /จนกว่าผสมเข้ากันดี/gu)).toHaveLength(1);
          expect(text).not.toContain(locale === "en" ? "before evenly mixed" : "ก่อนผสมเข้ากันดี");
        }
        expect(JSON.stringify(input)).toBe(before);
      }
      expect(JSON.stringify(graph)).toBe(saved);
      expect(JSON.stringify(row)).toBe(rowSaved);
    });

  it.each(["2026-12-05T09:00:00+07:00", "2026-12-05T02:00:00Z", "2026-12-05"])(
    "uses the Buddhist date while preserving the exact event time and offset (%s)", event => {
      const row: FhirDosage = { timing: { event: [event], _event: [{ id: "authored-event" }] },
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], extension: [annotation] };
      const r6 = toDosageDetails([row]), cold = persist(toFhirR5Dosages(r6));
      for (const input of [[row], r6, cold]) {
        const before = JSON.stringify(input);
        const thai = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
        expect(thai).toContain("วันที่ 5/12/2569" + (event.length > 10 ? " เวลา " + event.slice(11) : ""));
        expect(thai).not.toContain("2026-12-05");
        const exported = toFhirR5Dosages(input)[0];
        expect(exported.timing?.event).toEqual([event]);
        expect(exported.timing?._event).toEqual([{ id: "authored-event" }]);
        expect(exported.extension).toContainEqual(annotation);
        expect(JSON.stringify(input)).toBe(before);
      }
    });
});


describe("round54: current unit identity and graph argument ownership", () => {
  const persist = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const annotation = { url: "urn:round54:independent-note", valueString: "keep authored note" };
  const graphNote = { url: "urn:round54:graph-note", valueString: "keep graph annotation" };
  const rowForGraph = (graph: CanonicalInstructionGraph): FhirDosage => {
    const wire = persist(buildInstructionGraphExtension(graph)!);
    wire.extension!.push(graphNote);
    return { extension: [wire, annotation] };
  };
  const graphViews = (row: FhirDosage) => {
    const r6 = toDosageDetails([row]);
    return [[row], r6, persist(toFhirR5Dosages(r6))];
  };
  const checkSavedGraph = (input: FhirDosage[] | FhirR6DosageInstruction, expected: CanonicalInstructionGraph) => {
    const exported = toFhirR5Dosages(input)[0];
    expect(exported.extension).toContainEqual(annotation);
    const wire = exported.extension!.find(item => item.url === MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL)!;
    expect(wire.extension).toContainEqual(graphNote);
    expect(persist(parseInstructionGraphExtension(exported.extension)!)).toEqual(expected);
  };

  it.each(["authored-spray-label", "code-only-spray", "metric-total"] as const)(
    "uses coded dose identity for paired targets without changing authored quantities (%s)", kind => {
      const quantity = kind === "metric-total"
        ? { value: 1, unit: "mL", system: "http://unitsofmeasure.org", code: "mL", id: "authored-dose", extension: [annotation] }
        : { value: 1, ...(kind === "authored-spray-label" ? { unit: "metered spray" } : {}),
          system: "http://spor.ema.europa.eu/v1/lists/200000000014", code: "200000016451", id: "authored-dose", extension: [annotation] };
      const r6: FhirR6DosageInstruction = { step: [{ component: [{
        site: { concept: { text: "both nostrils", extension: [annotation] } },
        doseAndRate: [{ doseQuantity: quantity }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } }, extension: [annotation]
      }] }] };
      const saved = JSON.stringify(r6);
      for (const input of [r6, persist(toFhirR5Dosages(r6))]) {
        const before = JSON.stringify(input);
        const english = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
        const thai = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
        if (kind === "metric-total") {
          expect(english).toContain("1 mL");
          expect(english).toContain("both nostrils");
          expect(english).not.toContain("each nostril");
          expect(thai).toContain("1 มิลลิลิตร");
          expect(thai).not.toContain("ข้างละ");
        } else {
          expect(english).toContain("each nostril");
          expect(thai).toContain("ข้างละ");
          if (kind === "authored-spray-label") {
            expect(english).toContain("1 metered spray");
            expect(thai).toContain("1 metered spray");
          } else {
            expect(english).toContain("1 spray");
            expect(thai).toContain("1 ครั้ง");
          }
        }
        expect(calculateTotalUnits({ dosage: input, durationValue: 1, durationUnit: FhirPeriodUnit.Day,
          orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-01T00:00:00Z", timeZone: "UTC" }))
          .toMatchObject({ totalUnits: kind === "metric-total" ? 1 : 2, unit: kind === "metric-total" ? "mL" : "spray" });
        const projected = projectCanonicalCourse(importCanonicalCourse(input));
        expect(projected.fhirNext.step![0].component[0].doseAndRate![0].doseQuantity).toEqual(quantity);
        const savedR5 = toFhirR5Dosages(input)[0];
        expect(savedR5.doseAndRate![0].doseQuantity).toEqual(quantity);
        expect(savedR5.extension).toContainEqual(annotation);
        expect(savedR5.site?.extension).toContainEqual(annotation);
        expect(JSON.stringify(input)).toBe(before);
      }
      expect(JSON.stringify(r6)).toBe(saved);
    });

  it.each(["theme-with", "substance-with", "unmarked-theme"] as const)(
    "retains an explicit accompaniment independently of its nominal role (%s)", kind => {
      const parsed = parseInstructionActions("Swallow 1 tablet")[0];
      const source = kind === "unmarked-theme" ? "Swallow medicine 1 tablet" : "Swallow 1 tablet with applesauce";
      const object = { role: kind === "substance-with" ? AdviceArgumentRole.Substance : AdviceArgumentRole.Theme,
        text: kind === "unmarked-theme" ? "medicine" : "applesauce",
        normalized: kind === "unmarked-theme" ? "medicine" : "applesauce",
        i18n: { th: kind === "unmarked-theme" ? "ยา" : "แอปเปิลบด" },
        ...(kind !== "unmarked-theme" ? { relation: AdviceRelation.With } : {}) };
      const graph: CanonicalInstructionGraph = { sourceText: source, sourceLocale: "en", actions: [{
        ...parsed, sourceText: source, span: { start: 0, end: source.length },
        args: [parsed.args.find(arg => arg.role === AdviceArgumentRole.Amount)!, object]
      }] };
      const row = rowForGraph(graph), decoded = parseInstructionGraphExtension(row.extension)!;
      const accompaniment = decoded.actions[0].args.find(arg => arg.text === object.text)!;
      expect(accompaniment.role).toBe(object.role);
      expect(accompaniment.relation).toBe(object.relation);
      const expected = persist(decoded);
      const saved = JSON.stringify(row), graphSaved = JSON.stringify(graph);
      const thai = kind === "unmarked-theme" ? "กลืนยา 1 เม็ด." : "กลืน 1 เม็ดร่วมกับแอปเปิลบด.";
      for (const input of graphViews(row)) {
        const before = JSON.stringify(input);
        expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toBe(source + ".");
        expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" })).toBe(thai);
        checkSavedGraph(input, expected);
        expect(JSON.stringify(input)).toBe(before);
      }
      expect(JSON.stringify(row)).toBe(saved);
      expect(JSON.stringify(graph)).toBe(graphSaved);
    });

  it.each(["legacy-with", "fully-explicit"] as const)(
    "keeps an explicit dilution destination out of the legacy accompaniment slot (%s)", kind => {
      const source = "Dilute 1 mL with saline to 10 mL", parsed = parseInstructionActions(source)[0];
      const graph: CanonicalInstructionGraph = { sourceText: source, sourceLocale: "en", actions: [{
        ...parsed, relation: AdviceRelation.With, args: [
          parsed.args.find(arg => arg.role === AdviceArgumentRole.Amount)!,
          { role: AdviceArgumentRole.Substance, text: "saline", normalized: "saline", i18n: { th: "น้ำเกลือ" },
            ...(kind === "fully-explicit" ? { relation: AdviceRelation.With } : {}) },
          { role: AdviceArgumentRole.Destination, text: "10 mL", normalized: "mL",
            quantity: { value: 10, unit: "mL" }, relation: AdviceRelation.To }
        ]
      }] };
      const row = rowForGraph(graph), expected = persist(parseInstructionGraphExtension(row.extension)!);
      const saved = JSON.stringify(row), graphSaved = JSON.stringify(graph);
      for (const input of graphViews(row)) {
        const before = JSON.stringify(input);
        expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toBe(source + ".");
        expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
          .toBe("เจือจาง 1 มิลลิลิตรพร้อมน้ำเกลือไปยัง10 มิลลิลิตร.");
        checkSavedGraph(input, expected);
        expect(JSON.stringify(input)).toBe(before);
      }
      expect(JSON.stringify(row)).toBe(saved);
      expect(JSON.stringify(graph)).toBe(graphSaved);
    });

  it.each(["below", "above", "plain-ear"] as const)(
    "gives the current spatial site ownership after a fresh dose submission (%s)", relation => {
      const source = "Apply 1 g above the ear gently", parsed = parseInstructionActions("Apply 1 g")[0];
      const graph: CanonicalInstructionGraph = { sourceText: source, sourceLocale: "en",
        primaryAdministrationSpan: { start: 0, end: source.length }, actions: [{ ...parsed,
          sourceText: source, span: { start: 0, end: source.length }, args: [
            parsed.args.find(arg => arg.role === AdviceArgumentRole.Amount)!,
            { role: AdviceArgumentRole.Site, text: "above the ear", normalized: "above the ear", i18n: { th: "เหนือหู" } },
            { role: AdviceArgumentRole.Manner, text: "gently", normalized: "gently", i18n: { th: "เบาๆ" } }
          ]
        }] };
      const row: FhirDosage = { ...persist(toFhirR5Dosages(parseSig("Apply 1 g above the ear").fhirNext)[0]),
        ...rowForGraph(graph), doseAndRate: [{ doseQuantity: { value: 2, unit: "g", system: "http://unitsofmeasure.org", code: "g" } }],
        site: { text: "ear", extension: [annotation, ...(relation === "plain-ear" ? [] : [
          buildBodySiteSpatialRelationExtension({ relationText: relation, targetText: "ear" })!
        ])] }
      };
      const expected = persist(parseInstructionGraphExtension(row.extension)!);
      expect(expected.actions[0].args.filter(arg => arg.role === AdviceArgumentRole.Site)).toEqual([
        expect.objectContaining({ role: AdviceArgumentRole.Site, text: "above the ear",
          normalized: "above the ear", i18n: { th: "เหนือหู" } })
      ]);
      const saved = JSON.stringify(row), graphSaved = JSON.stringify(graph);
      for (const input of graphViews(row)) {
        const before = JSON.stringify(input);
        for (const locale of ["en", "th"]) {
          const rendered = formatSig(input, "long", { locale, realizationMode: "normalized" });
          const text = rendered.split(locale === "en" ? "; original directions: " : "; ข้อความเดิม: ")[0];
          expect(text.match(/(?:^|[^\d.])2 g\b/gu)).toHaveLength(1);
          expect(text).not.toContain("1 g");
          expect(text.match(locale === "en" ? /gently/gu : /เบาๆ/gu)).toHaveLength(1);
          if (relation === "plain-ear") {
            expect(text).toMatch(locale === "en" ? /\bear\b/u : /หู|\bear\b/u);
            expect(text).not.toMatch(/above|below|เหนือหู|ใต้หู/u);
          } else {
            expect(text.match(locale === "en" ? new RegExp(relation + " the ear", "gu")
              : new RegExp(relation === "below" ? "ใต้หู" : "เหนือหู", "gu"))).toHaveLength(1);
            expect(text).not.toContain(locale === "en" ? (relation === "below" ? "above the ear" : "below the ear")
              : relation === "below" ? "เหนือหู" : "ใต้หู");
          }
        }
        checkSavedGraph(input, expected);
        expect(toFhirR5Dosages(input)[0].site).toEqual(row.site);
        expect(JSON.stringify(input)).toBe(before);
      }
      expect(JSON.stringify(row)).toBe(saved);
      expect(JSON.stringify(graph)).toBe(graphSaved);
    });
});


describe("round54: configured safety targets and duration endpoints", () => {
  const persist = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const annotation = { url: "urn:round54:duration-note", valueString: "keep authored metadata" };
  const options: ParseOptions = { instructionActionMap: { "sit down": {
    code: "clinic-seat", display: "Sit down", i18n: { th: "นั่งลง" }, semanticClass: "procedure",
    procedural: false, safetyScopeTarget: true
  } } };

  it.each(["Sit down", "Sit down if dizzy", "If dizzy, sit down"])(
    "retains a registered safety-only action and its exact condition scope: %s", source => {
      const parsed = parseSig(source, options), clause = parsed.meta.canonical.clauses[0];
      expect(clause.evidence.some(item => item.rule === "hpsg.lex.patientInstruction.procedure")).toBe(true);
      expect(clause.leftovers).toEqual([]);
      if (source === "Sit down") expect(clause.patientInstruction).toBe(source);
      else {
        expect(clause.additionalInstructions).toHaveLength(1);
        expect(clause.additionalInstructions![0].frames).toHaveLength(1);
        expect(clause.additionalInstructions![0].frames![0].predicate.lemma).toBe("clinic-seat");
        expect(clause.instructionGraph?.relations).toHaveLength(1);
        expect(clause.instructionGraph?.relations![0]).toMatchObject({
          kind: AdviceRelation.If, toActionIndex: 0, text: source.startsWith("If") ? "If dizzy," : "if dizzy"
        });
      }
      expect(clause.prn?.enabled).not.toBe(true);
      const saved = JSON.stringify(parsed.fhirNext);
      for (const input of [parsed.fhirNext, persist(toFhirR5Dosages(parsed.fhirNext))]) {
        const before = JSON.stringify(input);
        const english = formatSig(input, "long", { ...options, locale: "en", realizationMode: "normalized" });
        const thai = formatSig(input, "long", { ...options, locale: "th", realizationMode: "normalized" });
        expect(english).toBe(source + ".");
        if (source === "Sit down") expect(thai).toBe("นั่งลง.");
        else {
          expect(thai.startsWith(source.startsWith("If")
            ? "ถ้าเวียนศีรษะให้นั่งลง." : "นั่งลงถ้าเวียนศีรษะ.")).toBe(true);
          expect(clause.additionalInstructions![0].text.toLowerCase()).toBe(source.toLowerCase());
        }
        const graph = parseInstructionGraphExtension(toFhirR5Dosages(input)[0].extension)!;
        expect(graph.actions[0].predicate.lemma).toBe("clinic-seat");
        expect(graph.sourceText).toBe(source);
        expect(JSON.stringify(input)).toBe(before);
      }
      expect(JSON.stringify(parsed.fhirNext)).toBe(saved);
    });

  it.each(["clinic-seat", "clinic-seat if dizzy"])(
    "does not register a saved action code as a new input phrase: %s", source => {
      const parsed = parseSig(source, options);
      expect(parsed.meta.canonical.clauses[0].instructionGraph?.actions).toEqual([]);
      expect(parsed.meta.canonical.clauses[0].additionalInstructions?.some(instruction =>
        instruction.frames?.some(frame => frame.predicate.lemma === "clinic-seat"))).not.toBe(true);
      expect(parsed.input).toBe(source);
    });

  it.each(["metadata-low", "metadata-high", "two-valued", "metadata-both", "zero-low", "independent-units"] as const)(
    "renders only valued administration-duration endpoints while preserving both quantities (%s)", kind => {
      const low = kind === "metadata-low" || kind === "metadata-both"
        ? { id: "saved-low", extension: [annotation] }
        : { value: kind === "zero-low" ? 0 : 1, unit: kind === "independent-units" ? "min" : "h",
          system: "http://unitsofmeasure.org", code: kind === "independent-units" ? "min" : "h", id: "saved-low", extension: [annotation] };
      const high = kind === "metadata-high" || kind === "metadata-both"
        ? { id: "saved-high", extension: [annotation] }
        : { value: 2, unit: "h", system: "http://unitsofmeasure.org", code: "h", id: "saved-high", extension: [annotation] };
      const range = { low, high }, marker = { url: TIMING_ADMINISTRATION_DURATION_EXTENSION_URL, valueRange: range };
      const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "mL" } }],
        timing: { repeat: { extension: [marker] } }, extension: [annotation] };
      const saved = JSON.stringify(row), r6 = toDosageDetails([row]);
      const phrases = {
        "metadata-low": ["over up to 2 hours", "โดยให้ยานาน ไม่เกิน 2 ชั่วโมง"],
        "metadata-high": ["over at least 1 hour", "โดยให้ยานาน อย่างน้อย 1 ชั่วโมง"],
        "two-valued": ["over 1 hour to 2 hours", "โดยให้ยานาน 1 ชั่วโมง ถึง 2 ชั่วโมง"],
        "zero-low": ["over 0 hours to 2 hours", "โดยให้ยานาน 0 ชั่วโมง ถึง 2 ชั่วโมง"],
        "independent-units": ["over 1 minute to 2 hours", "โดยให้ยานาน 1 นาที ถึง 2 ชั่วโมง"],
        "metadata-both": [undefined, undefined]
      }[kind];
      for (const input of [[row], r6, persist(toFhirR5Dosages(r6))]) {
        const before = JSON.stringify(input);
        for (const [index, locale] of ["en", "th"].entries()) {
          const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
          if (phrases[index]) expect(text).toContain(phrases[index]);
          else expect(text).not.toContain(locale === "en" ? "over" : "โดยให้ยานาน");
          expect(text).not.toContain(locale === "en" ? "over to" : "โดยให้ยานาน ถึง");
        }
        const exported = toFhirR5Dosages(input)[0];
        expect(exported.timing?.repeat?.extension).toContainEqual(marker);
        expect(exported.extension).toContainEqual(annotation);
        expect(JSON.stringify(input)).toBe(before);
      }
      expect(JSON.stringify(row)).toBe(saved);
    });
});


describe("round54: compact administration count boundaries", () => {
  it.each(["ceiling-only", "authored-equal-range", "authored-distinct-range"] as const)(
    "does not fabricate a compact lower count for %s", kind => {
      const parsed = parseSig("Take 1 tablet daily").meta.canonical.clauses[0];
      const clause = { ...parsed, schedule: { ...parsed.schedule,
        count: kind === "ceiling-only" ? undefined : 1,
        countMax: kind === "authored-distinct-range" ? 3 : 1
      } };
      const before = JSON.stringify(clause);
      const count = kind === "ceiling-only" ? "x<=1" : kind === "authored-equal-range" ? "x1-1" : "x1-3";
      for (const locale of ["en", "th"]) {
        const text = formatCanonicalClause(clause, "short", resolveSigLocalization(locale));
        expect(text.match(/x(?:<=)?\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?/gu)).toEqual([count]);
        if (kind === "ceiling-only") expect(text).not.toContain("x1-");
      }
      expect(JSON.stringify(clause)).toBe(before);
    });
});


describe("round59 partial facts and complete authored directions", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const note = { url: "urn:round59:source-note", valueString: "retain complete authored data" };
  const native = (component: FhirR6Dosage): FhirR6DosageInstruction => ({
    id: "round59-root", extension: [fresh(note)], step: [{ component: [component] }]
  });
  const views = (input: FhirR6DosageInstruction) => {
    const saved = fresh(toFhirR5Dosages(input)), reopened = fresh(toDosageDetails(saved));
    expect(reopened).toEqual(input);
    return [input, saved, reopened];
  };

  it.each([false, true])("qualifies the authored exclusion directions with live amount=%s", liveAmount => {
    const row: FhirDosage & { excludedDates: string[] } = {
      text: "Take 1 tablet daily", excludedDates: ["2027-01-01"], extension: [fresh(note)],
      ...(liveAmount ? { doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }] } : {})
    };
    const before = fresh(row), input = fresh(toDosageDetails([row]));
    for (const value of [row, ...views(input)])
      for (const locale of ["en", "th"]) for (const style of ["short", "long"] as const) {
        const text = formatSig(value, style, { locale, realizationMode: "normalized" });
        expect(text).toContain("2027-01-01");
        if (liveAmount) {
          expect(text).toMatch(locale === "en" ? /(?:^|[^0-9.])2 (?:tablets|tab)\b/u : /(?:^|[^0-9.])2 เม็ด/u);
          const [current, original] = text.split(locale === "en" ? "; original directions: " : "; ข้อความเดิม: ");
          expect(current).not.toContain("Take 1 tablet daily");
          expect(current).toContain("2027-01-01");
          expect(original).toBe(row.text);
        } else expect(text).toBe("Take 1 tablet daily " + (locale === "en" ? "except" : "ยกเว้นวันที่") + " 2027-01-01.");
      }
    expect(row).toEqual(before);
    expect(input.step![0].component[0].text).toBe(row.text);
  });

  it.each([false, true])("retains the qualitative amount beside a method with site=%s", hasSite => {
    for (const hasRoute of [false, true]) {
      const row: FhirDosage = { text: "Apply a thin layer", method: { text: "Apply" }, extension: [fresh(note)],
        ...(hasRoute ? { route: { text: "topical", coding: [{ system: "http://snomed.info/sct", code: "6064005", display: "Topical route" }] } } : {}),
        ...(hasSite ? { site: { coding: [{ system: "http://snomed.info/sct", code: "66480008", display: "Left forearm" }] } } : {}) };
      const before = fresh(row), input = fresh(toDosageDetails([row]));
      for (const value of [row, ...views(input)]) for (const locale of ["en", "th"])
        for (const style of ["short", "long"] as const) {
          const rendered = formatSig(value, style, { locale, realizationMode: "normalized" });
          // The live method/site/route remains separate from the untyped
          // qualitative amount, which is retained as labeled original wording.
          const separator = locale === "en" ? "; original directions: " : "; ข้อความเดิม: ";
          const [current, original] = rendered.split(separator);
          expect(original).toBe(row.text + ".");
          expect(current).not.toContain("a thin layer");
          expect(rendered.trim()).not.toBe("");
          if (style === "long" || !hasSite && !hasRoute)
            expect(current).toMatch(locale === "en" ? /apply/iu : /ทา/u);
          if (hasSite) expect(rendered).toContain(locale === "en" ? "left forearm" : "ปลายแขนซ้าย");
        }
      expect(input.step![0].component[0].text).toBe(row.text);
      expect(fromFhirDosage(fresh(row)).fhir).toEqual(row);
      expect(fromFhirDosage(fresh(row)).meta.canonical.clauses[0].rawText).toBe(row.text);
      // Source-only qualitative directions still own the visible instruction.
      const sourceOnly = fresh(row);
      delete sourceOnly.method;
      for (const value of [sourceOnly, ...views(fresh(toDosageDetails([sourceOnly])))])
        for (const locale of ["en", "th"]) for (const style of ["short", "long"] as const)
          expect(formatSig(value, style, { locale, realizationMode: "normalized" })).toContain(row.text!);
      // Existing HPSG interpretation owns the qualifier when it is structured.
      const typed = parseSig("apply a thin layer twice daily").fhir[0];
      expect(typed.additionalInstruction?.some(instruction =>
        instruction.coding?.some(coding => coding.code === "420162004"))).toBe(true);
      for (const value of [fresh(typed), ...views(fresh(toDosageDetails([fresh(typed)])))])
        expect(formatSig(value, "long", { realizationMode: "normalized" }))
          .toBe("Apply a thin layer topically twice daily.");
      expect(input.step![0].component[0].doseAndRate).toBeUndefined();
      expect(input.step![0].component[0].route).toEqual(row.route);
      expect(row).toEqual(before);
    }
  });

  it.each([
    ["apply a thin layer twice daily", "420162004", "thin layer", "บางๆ"],
    ["apply thickly twice daily", "246703001", "thickly", "หนาๆ"],
    ["apply sparingly twice daily", "420883007", "sparingly", "เพียงเล็กน้อย"],
    ["apply liberally twice daily", "419125005", "liberally", "อย่างทั่วถึง"]
  ] as const)("keeps a coded qualitative amount as current directions: %s", (source, code, english, thai) => {
    const parsed = parseSig(source), before = JSON.stringify(parsed);
    expect(parsed.fhir[0].additionalInstruction?.some(instruction =>
      instruction.coding?.some(coding => coding.code === code))).toBe(true);
    const native = parsed.meta.canonical.course!;
    for (const locale of ["en", "th"]) {
      const options = { locale, realizationMode: "normalized" as const };
      const outputs = [formatCanonicalCourse(native, "long", options),
        ...[fresh(parsed.fhir), fresh(parsed.fhirNext), fresh(toFhirR5Dosages(parsed.fhirNext))]
          .map(value => formatSig(value, "long", options))];
      for (const current of outputs) {
        expect(current).toContain(locale === "en" ? english : thai);
        expect(current).toContain(locale === "en" ? "twice daily" : "วันละ 2 ครั้ง");
        expect(current).not.toMatch(/Current:|original directions:|ปัจจุบัน:|ข้อความเดิม:/u);
      }
    }
    const changed = fresh(parsed.fhir);
    changed[0].doseAndRate = [{ doseQuantity: { value: 2, unit: "g" } }];
    const current = formatSig(changed, "long", { realizationMode: "normalized" }).split("; original directions: ")[0];
    expect(current).toMatch(/(?:^|[^0-9])2 (?:g|grams)\b/u);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it.each(["after dialysis", "BID", "twice daily"])("retains only independent offset timing text %s", text => {
    const code = { text, id: "complete-timing-label", extension: [fresh(note)] };
    const input = native({ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], timing: {
      code, repeat: { frequency: 3, period: 1, periodUnit: FhirPeriodUnit.Week,
        endOffset: { value: 1, unit: "d" } }
    } });
    const before = fresh(input);
    for (const value of views(input)) for (const locale of ["en", "th"])
      for (const style of ["short", "long"] as const) {
        const rendered = formatSig(value, style, { locale, realizationMode: "normalized" });
        if (text === "after dialysis") expect(rendered.split(text)).toHaveLength(2);
        else expect(rendered.toLowerCase()).not.toContain(text.toLowerCase());
        expect(rendered).toContain(locale === "en" ? "3 administrations per 1 week" : "ให้ยา 3 ครั้งต่อช่วง 1 สัปดาห์");
        expect(rendered).toContain(locale === "en" ? "No doses during the final 1 day" : "งดยาในช่วง 1 วันสุดท้าย");
      }
    expect(input).toEqual(before);
    expect(toFhirR5Dosages(input)[0].timing?.code).toEqual(code);
  });

  it.each(["low missing", "high missing", "both days", "neither unit", "upper only"] as const)(
    "renders duration endpoints independently with %s", kind => {
      const range = {
        ...(kind !== "upper only" ? { low: { value: 2, ...(kind !== "low missing" && kind !== "neither unit" ? { unit: "d" } : {}) } } : {}),
        high: { value: 3, ...(kind !== "high missing" && kind !== "neither unit" ? { unit: "d" } : {}) }
      };
      const independentUnits = kind === "low missing" || kind === "high missing";
      const coreRange = independentUnits ? { low: range.low } : range;
      const modifierExtension = independentUnits ? [{ url: ANCHORED_COURSE_DURATION_EXTENSION_URL, extension: [
        { url: "low", valueQuantity: range.low! }, { url: "high", valueQuantity: range.high }
      ] }] : undefined;
      const component = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { boundsRange: coreRange } }, ...(modifierExtension ? { modifierExtension } : {}) };
      const input = native(component), row: FhirDosage = fresh(component);
      const before = fresh({ input, row });
      for (const value of [row, ...views(input)]) {
        const current = importCanonicalCourse(value);
        expect(current.stages[0].administrations[0].schedule?.recurrence?.courseLengthRange).toEqual(range);
        for (const locale of ["en", "th"]) {
          const short = kind === "low missing" ? "x2 – 3d" : kind === "high missing" ? "x2d – 3"
            : kind === "neither unit" ? "x2 – 3" : kind === "upper only" ? "x<=3d" : "x2-3d";
          const long = locale === "en"
            ? kind === "low missing" ? "for 2 – 3 days" : kind === "high missing" ? "for 2 days – 3"
              : kind === "neither unit" ? "for 2 – 3" : kind === "upper only" ? "for up to 3 days" : "for 2 to 3 days"
            : kind === "low missing" ? "เป็นเวลา 2 – 3 วัน" : kind === "high missing" ? "เป็นเวลา 2 วัน – 3"
              : kind === "neither unit" ? "เป็นเวลา 2 – 3" : kind === "upper only" ? "เป็นเวลา ไม่เกิน 3 วัน" : "เป็นเวลา 2 ถึง 3 วัน";
          const options = { locale, realizationMode: "normalized" as const };
          expect(formatSig(value, "short", options)).toBe((locale === "en" ? "1 tab " : "1 เม็ด ") + short);
          expect(formatSig(value, "long", options)).toBe((locale === "en" ? "Use 1 tablet " : "ใช้ครั้งละ 1 เม็ด ") + long + ".");
        }
      }
      expect({ input, row }).toEqual(before);
      const projected = toFhirR5Dosages(input)[0];
      expect(projected.timing?.repeat?.boundsRange).toEqual(coreRange);
      if (independentUnits) expect(getAnchoredCourseDuration(projected)?.valueRange).toEqual(range);
    });

  it.each([false, true])("keeps authored directions guarded beside a count cap and independent advice=%s", advice => {
    const row: FhirDosage = { text: "Swallow 1 tablet whole", timing: { repeat: { countMax: 2,
      _count: { extension: [{ url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown" }] }
    } }, extension: [fresh(note)], ...(advice ? { patientInstruction: "Otherwise hold." } : {}) };
    setDosageCondition(row, { kind: "measurement", name: "sbp", operation: "gt", value: 160, text: "SBP > 160" });
    const before = fresh(row), input = fresh(toDosageDetails([row]));
    for (const value of [row, ...views(input)]) for (const locale of ["en", "th"])
      for (const style of ["short", "long"] as const) {
        const rendered = formatSig(value, style, { locale, realizationMode: "normalized" });
        expect(rendered).toContain((locale === "en" ? "original directions: " : "ข้อความเดิม: ") +
          "Swallow 1 tablet whole " + (locale === "en" ? "only if " : "เฉพาะเมื่อ ") + "SBP > 160.");
        expect(rendered).toContain(style === "short" ? "x<=2" : locale === "en" ? "up to 2 doses" : "ไม่เกิน 2 ครั้ง");
        if (style === "long") expect(rendered.match(/SBP > 160/gu)).toHaveLength(1);
        if (advice && style === "long") {
          const [current, original] = rendered.split(locale === "en" ? "; original directions: " : "; ข้อความเดิม: ");
          expect(current).toContain("Otherwise hold");
          expect(original).not.toContain("Otherwise hold");
          expect(rendered).not.toMatch(/Otherwise hold\.? (?:only if|เฉพาะเมื่อ)/u);
        }
      }
    expect(row).toEqual(before);
  });

  it.each(["on dialysis days", "twice daily", "no label"] as const)(
    "keeps independent timing text beside a graph-covered meal event: %s", label => {
      const row = fresh(parseSig("Swallow 1 tablet whole before breakfast").fhir[0]);
      if (label !== "no label") row.timing = { ...row.timing,
        code: { text: label, id: "meal-timing-label", extension: [fresh(note)] },
        repeat: { ...row.timing?.repeat, frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } };
      const before = fresh(row), input = fresh(toDosageDetails([row]));
      for (const value of [row, ...views(input)]) for (const locale of ["en", "th"])
        for (const style of ["short", "long"] as const) {
          const rendered = formatSig(value, style, { locale, realizationMode: "normalized" });
          if (label === "on dialysis days") expect(rendered.split(label)).toHaveLength(2);
          else expect(rendered).not.toContain("on dialysis days");
          expect(rendered.toLowerCase()).not.toContain("twice daily");
          const meal = locale === "en" ? style === "short" ? "ACM" : "before breakfast" : "ก่อนอาหารเช้า";
          expect(rendered.split(meal)).toHaveLength(2);
          if (style === "long") expect(rendered).toContain(locale === "en" ? "whole" : "ทั้งเม็ด");
        }
      expect(row).toEqual(before);
      if (label !== "no label") expect(toFhirR5Dosages(input)[0].timing?.code).toEqual(row.timing?.code);
    });
});

describe("round60 typed meaning and interchange ownership", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  it.each([
    ["about half a mL", 0.5],
    ["about three quarters of a mL", 0.75],
    ["about 0.5 mL", 0.5]
  ] as const)("keeps the independent active dose beside a qualified carrier: %s", (carrier, value) => {
    const source = "Infuse 2 mg in " + carrier + " over 5 minutes";
    const result = parseSig(source);
    for (const wire of [result.fhirNext, toDosageDetails(fresh(toFhirR5Dosages(result.fhirNext)))]) {
      const a = courseFromR6(wire).stages[0].administrations[0];
      expect(a.amounts).toHaveLength(1);
      expect(a.amounts![0].quantity).toMatchObject({ value: 2, unit: "mg" });
      expect(a.amounts![0].rateRatio).toMatchObject({
        numerator: { value, unit: "mL", comparator: "~" }, denominator: { value: 5, unit: "min" }
      });
      expect(a.schedule?.recurrence).toMatchObject({ count: 1, occurrenceDuration: 5, occurrenceDurationUnit: "min" });
    }
    expect(result.input).toBe(source);
  });

  it.each([false, true])("keeps a built-in withholding predicate with a distinct custom code collision: %s", custom => {
    const options: ParseOptions | undefined = custom ? {
      instructionActionMap: { abstain: { code: "withhold-administration", display: "Custom abstain" } }
    } : undefined;
    const result = parseSig("Take 1 tablet daily. If dizzy, omit the dose.", options);
    const expected = { kind: "not", condition: { kind: "state", name: "dizzy", expected: true, text: "dizzy" } };
    for (const course of [result.meta.canonical.course, courseFromR6(fresh(result.fhirNext)),
      courseFromR6(toDosageDetails(fresh(toFhirR5Dosages(result.fhirNext))))]) {
      const a = course.stages[0].administrations[0];
      expect(a.predicate).toEqual(expected);
      expect(a.amounts![0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(a.schedule?.recurrence).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
    }
  });

  it.each([false, true])("keeps a quantified Take conditional out of procedural advice ownership: %s", custom => {
    const source = "If dizzy, take 1 tablet.";
    const options: ParseOptions | undefined = custom ? {
      instructionActionMap: { "custom-mix": { code: "take", display: "Custom mix", procedural: true, definesDose: false } }
    } : undefined;
    const tokens = tokenize(source);
    const context: HpsgClauseContext = { state: new ParserState(source, tokens), tokens, options,
      limit: tokens.length, dateSpans: [], clinicalCache: {}, deps: {} as HpsgClauseContext["deps"] };
    return import("../src/hpsg/procedural-context").then(({ conditionalAdviceOwnerAt, getProceduralFrames }) => {
      const frame = getProceduralFrames(context).find(value => value.predicate.lemma === "take")!;
      expect(frame.args.find(arg => arg.role === AdviceArgumentRole.Amount)?.quantity)
        .toMatchObject({ value: 1, unit: "tab" });
      expect(conditionalAdviceOwnerAt(context, tokens.findIndex(token => token.lower === "if"))).toBeUndefined();
    });
  });

  it.each(["8.30", "08:30", "8 AM"])("keeps an UNTIL next-day clock as an end complement: %s", clock => {
    return import("../src/hpsg/rule-context").then(({ nextDayOnsetAt, isEndBoundDaypartAt }) => {
      for (const lead of ["until", "by"]) {
        const tokens = tokenize(lead + " " + clock + " the next morning");
        const next = tokens.findIndex(token => token.lower === "next");
        const article = tokens.findIndex(token => token.lower === "the");
        expect(nextDayOnsetAt(tokens, next, tokens.length)).toBeUndefined();
        expect(nextDayOnsetAt(tokens, article, tokens.length)).toBeUndefined();
        expect(isEndBoundDaypartAt(tokens, next + 1)).toBe(true);
      }
      const start = tokenize("the next morning");
      expect(nextDayOnsetAt(start, 0, start.length)).toMatchObject({ headIndex: 2, tokenEnd: 3 });
    });
  });

  it.each(["r5", "r6"] as const)("retains opaque graph children at their original owner through public codecs: %s", kind => {
    const known = buildInstructionGraphExtension({ sourceText: "Swallow 1 tablet before bedtime", sourceLocale: "en",
      actions: parseInstructionActions("Swallow 1 tablet before bedtime") })!;
    const unknown = { url: "urn:round60:graph-provenance", id: "clinic-owner", extension: [
      { url: "note", valueString: "Preserve independently authored note" },
      { url: "opaque", extension: [{ url: "zero", valueInteger: 0 }, { url: "flag", valueBoolean: false }] }
    ] };
    const marker = fresh(known);
    marker.extension!.push(unknown);
    const before = JSON.stringify(marker);
    const decoded = parseInstructionGraphExtension([marker])!;
    const rebuilt = buildInstructionGraphExtension(decoded)!;
    expect(rebuilt.extension!.find(field => field.url === unknown.url)).toEqual(unknown);
    expect(rebuilt.extension!.filter(field => field.url !== unknown.url)).toEqual(known.extension);
    expect(buildInstructionGraphExtension(parseInstructionGraphExtension([known]))).toEqual(known);
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], extension: [rebuilt] };
    const input = kind === "r5" ? [row] : { step: [{ component: [row] }] };
    const projected = projectCanonicalCourse(importCanonicalCourse(input));
    for (const wire of [projected.fhir, projected.fhirNext, fresh(toFhirR5Dosages(projected.fhirNext))]) {
      const saved = Array.isArray(wire) ? wire[0].extension : wire.step![0].component[0].extension;
      expect(saved!.find(field => field.url === MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL)!.extension)
        .toContainEqual(unknown);
    }
    expect(JSON.stringify(marker)).toBe(before);
  });

  it.each(["gel", "water"])("retains an explicit accompaniment in the default action preview: %s", material => {
    const frame = parseInstructionActions("Moisten gauze with " + material)[0];
    expect(realizeInstructionAction(frame, "en")).toBe("Moisten gauze with " + material);
    const reopened = parseInstructionGraphExtension([buildInstructionGraphExtension({ sourceText: frame.sourceText, actions: [frame] })!])!;
    expect(realizeInstructionAction(reopened.actions[0], "en")).toBe("Moisten gauze with " + material);
  });

  it("does not turn an unmarked Material into the default action object", () => {
    const frame = fresh(parseInstructionActions("Moisten gauze with gel")[0]);
    delete frame.args.find(arg => arg.role === AdviceArgumentRole.Material)!.relation;
    expect(realizeInstructionAction(frame, "en")).toBe("Moisten gauze");
  });

  it.each(["08:00", "8 AM"])("keeps a Mix clock outside its trailing condition and material: %s", clock => {
    const source = "Mix with water at " + clock + " if instructed";
    const frame = parseInstructionActions(source)[0];
    expect(frame.args.find(arg => arg.role === AdviceArgumentRole.Substance)?.text).toBe("water");
    expect(frame.args.find(arg => arg.role === AdviceArgumentRole.Time)?.normalized).toBe("08:00:00");
    expect(frame.sourceText).not.toContain("if instructed");
    expect(realizeInstructionAction(frame, "en")).toBe("Mix with water at 08:00:00");
    const graph = parseSig(source).meta.canonical.clauses[0].instructionGraph!;
    expect(graph.sourceText).toBe(source);
    expect(graph.relations?.some(relation => relation.kind === "if" && relation.text?.includes("instructed"))).toBe(true);
    const control = parseInstructionActions("Mix with water at " + clock)[0];
    expect(realizeInstructionAction(control, "en")).toBe("Mix with water at 08:00:00");
  });

  it("gives the explicit administration span precedence over equal preparation amounts", () => {
    const source = "Measure 5 mL of water; then drink 5 mL slowly";
    const actions = parseInstructionActions(source);
    const clause = { kind: "administration" as const, dose: { value: 5, unit: "mL" },
      schedule: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day },
      instructionGraph: { sourceText: source, actions, primaryAdministrationSpan: actions[1].span } };
    return import("../src/instruction-graph").then(({ instructionGraphRichPrimaryAction }) => {
      expect(instructionGraphRichPrimaryAction(clause)?.predicate.lemma).toBe("drink");
      for (const locale of ["en", "th"]) {
        const text = formatSig(courseFromAdministrations([administrationFromClause(clause)], source),
          "long", { locale, realizationMode: "normalized" });
        expect(text).toContain("slowly");
        expect(text).toContain(locale === "en" ? "once daily" : "วันละครั้ง");
      }
      const { primaryAdministrationSpan, ...spanlessGraph } = fresh(clause.instructionGraph);
      const spanless = { ...clause, instructionGraph: spanlessGraph };
      expect(instructionGraphRichPrimaryAction(spanless)?.predicate.lemma).toBe("measure");
      const mismatched = fresh(spanless); mismatched.dose.value = 7;
      expect(instructionGraphRichPrimaryAction(mismatched)).toBeUndefined();
    });
  });

  it.each(["r5", "r6"] as const)("keeps source-only directions and disabled PRN through fresh %s import", kind => {
    const source = "Apply a thin layer to the affected area";
    const row = { text: source, asNeeded: false };
    const r6: FhirR6DosageInstruction = { step: [{ component: [row] }] };
    const wire = kind === "r5" ? fresh(toFhirR5Dosages(r6)) : r6;
    const before = JSON.stringify(wire);
    const rows = Array.isArray(wire) ? wire : toFhirR5Dosages(wire);
    for (const input of [wire, toDosageDetails(fresh(rows))]) {
      expect(formatSig(input, "short", { realizationMode: "normalized" })).toBe(source);
      expect(formatSig(input, "long", { realizationMode: "normalized" })).toBe(source);
      expect(importCanonicalCourse(input).stages[0].administrations[0].asNeeded).toBe(false);
    }
    expect(JSON.stringify(wire)).toBe(before);
    const current: FhirR6DosageInstruction = { step: [{ component: [{ ...row,
      doseAndRate: [{ doseQuantity: { value: 2, unit: "g" } }] }] }] };
    const a = courseFromR6(current).stages[0].administrations[0];
    expect(a.asNeeded).toBe(false);
    const [currentText, original] = formatSig(current, "long", { realizationMode: "normalized" }).split("; original directions: ");
    expect(currentText).toContain("2 g");
    expect(currentText).not.toContain("thin layer");
    expect(original).toBe(source);
  });

  it.each([
    ["low", undefined, "at least 3", "อย่างน้อย 3"],
    ["high", undefined, "up to 3", "ไม่เกิน 3"],
    ["low", "d", "at least 3 days", "อย่างน้อย 3 วัน"],
    ["high", "d", "up to 3 days", "ไม่เกิน 3 วัน"]
  ] as const)("keeps an authored %s duration endpoint with unit %s visible", (side, unit, en, th) => {
    const quantity = { value: 3, ...(unit ? { unit, code: unit } : {}) };
    const range = side === "low" ? { low: quantity } : { high: quantity };
    const input: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, boundsRange: range } }
    }] }] };
    const before = JSON.stringify(input);
    for (const wire of [input, toDosageDetails(fresh(toFhirR5Dosages(input)))]) {
      for (const [locale, expected] of [["en", en], ["th", th]]) {
        expect(formatSig(wire, "long", { locale, realizationMode: "normalized" })).toContain(expected);
        const short = formatSig(wire, "short", { locale, realizationMode: "normalized" });
        expect(short).toContain("x" + (side === "low" ? ">=" : "<=") + "3" + (unit ?? ""));
        expect(short).not.toContain("undefined");
      }
      expect(wire.step![0].component[0].timing!.repeat!.boundsRange).toEqual(range);
    }
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(["en", "th"])("renders a graph-owned bedtime once beside its daily cadence: %s", locale => {
    const frame = fresh(parseInstructionActions("Swallow 1 tablet before bedtime")[0]);
    frame.sourceText = "";
    const marker = buildInstructionGraphExtension({ sourceText: "", sourceLocale: "en",
      primaryAdministrationSpan: frame.span, actions: [frame] })!;
    const wire: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, when: [EventTiming["Before Sleep"]] } },
      extension: [marker]
    }] }] };
    const text = formatSig(wire, "long", { locale, realizationMode: "roundtrip" });
    expect(text.match(locale === "en" ? /before sleep|bedtime/gu : /ก่อนนอน/gu)).toHaveLength(1);
    expect(text).toContain(locale === "en" ? "once daily" : "วันละครั้ง");
    const control = fresh(wire); delete control.step![0].component[0].extension;
    expect(formatSig(control, "long", { locale, realizationMode: "roundtrip" }))
      .toContain(locale === "en" ? "bedtime" : "ก่อนนอน");
  });
});


describe("round61 complete carrier quantity daughters", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  it.each([
    ["mg", "half a L", 0.5, "L", undefined],
    ["mg", "half L", 0.5, "L", undefined],
    ["mg", "half of a L", 0.5, "L", undefined],
    ["mg", "three quarters of a L", 0.75, "L", undefined],
    ["mg", "five quarters of a L", 1.25, "L", undefined],
    ["mg", "a quarter L", 0.25, "L", undefined],
    ["mg", "one and a half L", 1.5, "L", undefined],
    ["mg", "about half a L", 0.5, "L", "~"],
    ["mg", "at least half a L", 0.5, "L", ">="],
    ["mg", "0.5 L", 0.5, "L", undefined],
    ["mg", "0.5 litre", 0.5, "L", undefined],
    ["mg", "500 milliliters", 500, "mL", undefined],
    ["milligrams", "half a litre", 0.5, "L", undefined],
    ["units", "half a litre", 0.5, "L", undefined],
  ] as const)("keeps the active %s dose beside %s", (activeUnit, carrier, value, unit, comparator) => {
    const source = "Infuse 20 " + activeUnit + " in " + carrier + " over 4 h";
    const parsed = parseSig(source);
    expect(parsed.input).toBe(source);
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    for (const input of [parsed.fhir, parsed.fhirNext,
      fresh(toFhirR5Dosages(fresh(parsed.fhirNext)))]) {
      const before = fresh(input), course = importCanonicalCourse(input);
      expect(course.stages).toHaveLength(1);
      expect(course.stages[0].administrations).toHaveLength(1);
      const member = course.stages[0].administrations[0];
      expect(member.target).toBeUndefined();
      expect(member.amounts).toHaveLength(1);
      const amount = member.amounts![0];
      expect(amount.quantity?.value).toBe(20);
      expect(amount.quantity?.code ?? amount.quantity?.unit).toBe(activeUnit === "units" ? "[iU]" : "mg");
      expect(amount.rateRatio).toMatchObject({
        numerator: { value, unit }, denominator: { value: 4, unit: "h" },
      });
      expect(getQuantityComparator(amount.rateRatio!.numerator)).toBe(comparator);
      expect(member.schedule?.recurrence).toMatchObject({ count: 1, occurrenceDuration: 4, occurrenceDurationUnit: "h" });
      expect(input).toEqual(before);
    }
  });

  it("uses the registered unit vocabulary for both typed amounts", () => {
    const parsed = parseSig("Infuse 20 activeunits in half a carrierunit over 4 h", {
      unitMap: { activeunits: "mg", carrierunit: "L" },
    });
    const member = parsed.meta.canonical.course!.stages[0].administrations[0];
    expect(member.amounts).toMatchObject([{ quantity: { value: 20, unit: "mg" },
      rateRatio: { numerator: { value: 0.5, unit: "L" }, denominator: { value: 4, unit: "h" } } }]);
    expect(member.target).toBeUndefined();
    expect(parsed.meta.leftoverText).toBeUndefined();
  });
});


describe("round61 supported grammar and display ownership", () => {
  const saved = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const views = (value: FhirR6DosageInstruction) => [value, saved(value),
    saved(toFhirR5Dosages(value)), saved(toDosageDetails(saved(toFhirR5Dosages(value))))];

  it("inherits all authored infusion clocks without inventing a singleton", () => {
    const source = "Infuse 100 mL at 08:00 and 20:00 daily for 3 days, then infuse 50 mL over 1 hour at the same times for 2 days";
    const parsed = parseSig(source), second = parsed.meta.canonical.clauses[1];
    expect(second.schedule).toMatchObject({ timeOfDay: ["08:00:00", "20:00:00"],
      duration: 2, durationUnit: "d", administrationDuration: 1, administrationDurationUnit: "h" });
    expect(second.schedule?.count).toBeUndefined();
    const query = { orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-01T00:00:00Z", timeZone: "UTC", limit: 20 };
    const expected = [1, 2, 3, 4, 5].flatMap(day => [8, 20].map(hour =>
      `2026-01-0${day}T${String(hour).padStart(2, "0")}:00:00+00:00`));
    for (const input of [parsed.meta.canonical.course!, ...views(parsed.fhirNext)]) {
      const before = JSON.stringify(input);
      expect(nextDueDoses(input, query)).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 6, durationUnit: "d" }))
        .toMatchObject({ totalUnits: 800, unit: "mL" });
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(parseSig("Infuse 50 mL over 1 hour").meta.canonical.clauses[0].schedule?.count).toBe(1);
  });

  it.each(["IV slowly", "IV gently", "IV", "IV solution"])(
    "keeps carrier material and route daughters separate: %s", phrase => {
      const parsed = parseSig(`Infuse 2 mg in 50 mL ${phrase} over 1 hour`);
      const clause = parsed.meta.canonical.clauses[0];
      expect(clause.dose).toEqual({ value: 2, unit: "mg" });
      expect(clause.clinicalQuantity).toMatchObject({ rateNumerator: { value: 50, unit: "mL" },
        administrationDuration: { value: 1, unit: "h" } });
      expect(clause.clinicalQuantity?.carrierMaterial?.text).toBe(phrase === "IV solution" ? phrase : undefined);
      expect(clause.route?.code).toBe(phrase === "IV solution" ? undefined : RouteCode["Intravenous route"]);
      for (const input of views(parsed.fhirNext)) {
        const before = JSON.stringify(input), member = importCanonicalCourse(input).stages[0].administrations[0];
        expect(member.amounts).toMatchObject([{ quantity: { value: 2, unit: "mg" },
          rateRatio: { numerator: { value: 50, unit: "mL" }, denominator: { value: 1, unit: "h" } } }]);
        if (phrase !== "IV solution") expect(toFhirR5Dosages(input)[0].route?.coding?.[0].code)
          .toBe(RouteCode["Intravenous route"]);
        expect(JSON.stringify(input)).toBe(before);
      }
    });

  it.each(["Infuse 20 to 40 mg in 2 divided doses at 0.1 mg/kg/hr",
    "Infuse 20 to 40 mg at 0.1 mg/kg/hr in 2 divided doses"])(
    "divides the authored total range independently from its weight-based rate: %s", source => {
      const parsed = parseSig(source), clause = parsed.meta.canonical.clauses[0];
      expect(clause.dose).toEqual({ range: { low: 10, high: 20 }, unit: "mg" });
      expect(clause.schedule?.count).toBe(2);
      expect(clause.schedule?.frequency).toBeUndefined();
      expect(clause.clinicalQuantity).toMatchObject({ representation: "rate-quantity", dividedDoseCount: 2,
        numerator: { value: 0.1, unit: "mg" }, requiresPatientWeight: true });
      for (const input of [parsed.meta.canonical.course!, ...views(parsed.fhirNext)]) {
        const before = JSON.stringify(input);
        expect(importCanonicalCourse(input).stages[0].administrations[0].amounts).toMatchObject([{
          range: { low: { value: 10, unit: "mg" }, high: { value: 20, unit: "mg" } },
          rate: { value: 0.1, unit: "mg/kg/h" }
        }]);
        expect(JSON.stringify(input)).toBe(before);
      }
      const daily = parseSig("Give 20 mg/kg/day in 2 divided doses").meta.canonical.clauses[0];
      expect(daily.dose).toEqual({ value: 10, unit: "mg/kg" });
      expect(daily.schedule).toMatchObject({ frequency: 2, period: 1, periodUnit: "d" });
      expect(daily.clinicalQuantity?.dailyTotal).toBe(true);
    });

  it("retains distinct plain-data locales and registered script configuration", () => {
    const providers = [
      { locale: "round61-script-a", script: /[ⵤⵥ]/gu, char: "ⵤ" },
      { locale: "round61-script-b", script: /[ꙮ꙯]/yu, char: "ꙮ" }
    ];
    for (const input of providers) {
      const provider: MedicationSurfaceSegmenter = { locale: input.locale, script: input.script,
        *segment(text: string) { if (this.script.test(text[0])) yield { segment: text, index: 0 }; } };
      registerMedicationSurfaceSegmenter(provider);
    }
    for (const input of providers) {
      const registered = listMedicationSurfaceSegmenters().find(value => value.locale === input.locale)!;
      expect(registered).toBeDefined();
      expect(registered.script.global || registered.script.sticky).toBe(false);
      expect([...registered.segment(input.char)]).toEqual([{ segment: input.char, index: 0 }]);
      expect(splitMedicationScriptRuns("A" + input.char + "B").map(run => run.text)).toEqual(["A", input.char, "B"]);
    }
  });

  it("keeps source-only directions with independent warning and dose cap", () => {
    const row: FhirDosage = { text: "Swallow 1 tablet whole every morning",
      additionalInstruction: [{ text: "Do not crush" }], maxDosePerAdministration: { value: 2, unit: "tab" } };
    const original = saved(row);
    for (const input of [row, ...views(toDosageDetails([saved(row)]))]) {
      const text = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(text).toContain(row.text);
      expect(text).toContain("Do not crush");
      expect(text).toContain("max per administration: 2 tab");
      expect(formatSig(input, "short", { locale: "en", realizationMode: "normalized" })).toContain(row.text);
    }
    const edited = { ...saved(row), doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }] };
    const [current, authored] = formatSig(edited, "long", { locale: "en" }).split("; original directions: ");
    expect(current).toContain("2 tablets");
    expect(current).not.toContain("Swallow 1 tablet");
    expect(current).toContain("Do not crush");
    expect(current).toContain("max per administration: 2 tab");
    expect(authored).toBe(row.text);
    expect(row).toEqual(original);
  });

  it.each([false, true])("keeps live PRN beside a retained graph warning: %s", needed => {
    const graph = parseSig("Do not crush").meta.canonical.clauses[0].instructionGraph!;
    const input: FhirR6DosageInstruction = { step: [{ component: [{ asNeeded: needed,
      extension: [buildInstructionGraphExtension(graph)!] }] }] };
    for (const wire of views(input)) for (const locale of ["en", "th"]) {
      const before = JSON.stringify(wire), text = formatSig(wire, "long", { locale, realizationMode: "normalized" });
      expect(text).toContain(locale === "en" ? "Do not crush" : "ห้ามบด");
      if (needed) expect(text).toContain(locale === "en" ? "as needed" : "เมื่อจำเป็น");
      else expect(text).toBe(locale === "en" ? "Do not crush." : "ห้ามบด.");
      expect(importCanonicalCourse(wire).stages[0].administrations[0].asNeeded).toBe(needed);
      expect(JSON.stringify(wire)).toBe(before);
    }
  });

  it("classifies conditions by the selected action definition despite a configured code collision", () => {
    const options: ParseOptions = { instructionActionMap: { "clinic warning": {
      code: "rinse", display: "Clinic warning", semanticClass: "procedure", procedural: false, safetyScopeTarget: true
    } } };
    for (const selectedOptions of [undefined, options]) {
      const source = "If dizzy, rinse the skin", parsed = parseSig(source, selectedOptions);
      expect(parsed.meta.canonical.clauses).toHaveLength(1);
      const clause = parsed.meta.canonical.clauses[0];
      expect(clause.additionalInstructions).toBeUndefined();
      expect(clause.patientInstruction).toBe("rinse the skin");
      expect(clause.prn?.enabled).not.toBe(true);
      const graph = clause.instructionGraph!;
      const rinseIndex = graph.actions.findIndex(action => action.predicate.lemma === "rinse");
      expect(rinseIndex).toBeGreaterThanOrEqual(0);
      expect(graph.relations).toContainEqual(expect.objectContaining({ kind: AdviceRelation.If, toActionIndex: rinseIndex }));
      for (const input of views(parsed.fhirNext)) {
        const text = formatSig(input, "long", { ...selectedOptions, locale: "en", realizationMode: "normalized" });
        expect(text.split("; original directions:")[0]).toMatch(/if dizzy,? rinse the skin/iu);
      }
    }
    expect(parseSig("If dizzy, clinic warning", options).meta.canonical.clauses[0].additionalInstructions)
      .toMatchObject([{ text: "If dizzy, clinic warning" }]);
  });

  it.each([1, 2, undefined])("shows a supplied partial frequency without inventing a period: %s", frequency => {
    const input: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], timing: {
        code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "BID" }] },
        ...(frequency === undefined ? {} : { repeat: { frequency } })
      } }] }] };
    for (const wire of views(input)) {
      const text = formatSig(wire, "short", { locale: "en", realizationMode: "normalized" });
      expect(text).toBe(frequency === 1 ? "1 tab 1x" : "1 tab BID");
      if (frequency === 1) expect(text).not.toContain("/d");
    }
  });

  it("replays replacement wording when the saved clinical projection still agrees", () => {
    const row = saved(parseSig("Take 2 tablets daily").fhir[0]);
    row.text = "Take 2 tablets daily with water";
    const before = saved(row);
    expect(formatSig(row, "long", { realizationMode: "roundtrip" })).toBe(row.text);
    expect(fromFhirDosage(row, { realizationMode: "roundtrip" }).longText).toBe(row.text);
    expect(parseSig(formatSig(row, "long", { realizationMode: "roundtrip" })).meta.canonical.clauses[0].dose)
      .toMatchObject({ value: 2, unit: "tab" });
    expect(row).toEqual(before);
  });
});
}



{

const parseSig = parsePublicSig;


const freshExecutionInput = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const origin = "2026-01-01T00:00:00Z";
const options = { from: origin, orderedAt: origin, timeZone: "UTC" };
const dose = (value = 1): CanonicalAdministration => ({
  kind: "administration", amounts: [{ quantity: { value, unit: "tab" } }],
  schedule: { recurrence: { frequency: 1, period: 1, periodUnit: Unit.Day, clocks: ["09:00:00"] } },
});
const supply = (dosage: CanonicalAdministration | CanonicalCourse, days: number, extra = {}) =>
  calculateTotalUnits({ ...options, dosage, durationValue: days, durationUnit: Unit.Day, ...extra });
const relative = (value: number, unit = "d") => ({
  anchor: "treatment-start" as const, displacement: { value, unit },
});
const capacity = (count = 2): CanonicalAdministration => ({
  ...dose(), asNeeded: true,
  amounts: [{ range: { low: { value: 1, unit: "tab" }, high: { value: 2, unit: "tab" } } }],
  schedule: { recurrence: { countMax: count,
    occurrenceCap: { max: 2, period: 1, periodUnit: Unit.Day } } },
  limits: [{ scope: "period", amount: { value: 3, unit: "tab" }, period: { value: 24, unit: "h" } }],
});



describe("round60 supported execution and quantity boundaries", () => {
  const versions = ["native", "R5", "R6"] as const;
  const persist = freshExecutionInput;
  const wire = (course: CanonicalCourse, version: typeof versions[number]) => version === "native" ? course
    : persist(version === "R5" ? courseToR5(course) : courseToR6(course));
  const reopen = (input: ReturnType<typeof wire>) => persist(toDosageDetails(persist(courseToR5(importCanonicalCourse(input)))));
  const query = { ...options, limit: 4 };
  const delayed = (bounded: boolean) => courseFromAdministrations([{
    ...dose(), delayMinutes: 120,
    schedule: { recurrence: { frequency: 1, period: 6, periodUnit: Unit.Hour,
      ...(bounded ? { calendarWindow: { end: "2026-01-02T00:00:00Z" } } : {}) } },
  }], "One tablet every six hours beginning after two hours");
  // These extension-backed facts start as fresh wire submissions. Native
  // compilation is not an editing API for inventing absent wire annotations.
  const monthly = (clocks: string[], selected = true): CanonicalCourse => courseFromR6({ step: [{ component: [{
    doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
    timing: { repeat: { frequency: clocks.length * 2, period: 1, periodUnit: Unit.Month, timeOfDay: clocks,
      ...(selected ? { extension: [1, 15].map(valuePositiveInt => ({
        url: "http://hl7.org/fhir/StructureDefinition/timing-dayOfMonth", valuePositiveInt,
      })) } : {}) } },
  }] }] });
  const upper = (clocks: boolean): CanonicalCourse => courseFromR6({ step: [{ component: [{
    doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
    timing: { repeat: { frequencyMax: 2, period: 1, periodUnit: Unit.Day,
      extension: [{ url: "urn:ezmedicationinput:StructureDefinition:medication-timing-frequency-min", valueInteger: 0 }],
      ...(clocks ? { timeOfDay: ["09:00:00"] } : {}) } },
  }] }] });
  const durationCourse = (kind: "equal elapsed" | "unequal elapsed" | "civil day"): CanonicalCourse => courseFromR6({
    step: [{ component: [{ doseAndRate: [{ doseQuantity: { value: 100, unit: "mL" } }],
      timing: { repeat: { count: 1, timeOfDay: ["08:00:00"], extension: [{
        url: "urn:ezmedicationinput:StructureDefinition:timing-administration-duration", valueRange: {
          low: { value: kind === "civil day" ? 1 : 0.5, unit: "d" },
          high: { value: kind === "civil day" ? 24 : kind === "unequal elapsed" ? 13 : 12, unit: "h" },
        },
      }] } } }] }, { component: [{ doseAndRate: [{ doseQuantity: { value: 50, unit: "mL" } }],
      timing: { repeat: { count: 1, timeOfDay: ["22:00:00"] } } }] }],
  });
  const ratioCourse = (code: string): CanonicalCourse => ({ kind: "course", stages: [{ administrations: [{
    kind: "administration", amounts: [{ rateRatio: { numerator: { value: 100, unit: "mL" },
      denominator: { value: 60, unit: "infusion minutes", system: "http://unitsofmeasure.org", code } } }],
    schedule: { recurrence: { count: 1, clocks: ["08:00:00"], occurrenceDuration: 1, occurrenceDurationUnit: Unit.Hour } },
  }] }] });

  it.each(versions.flatMap(version => [false, true].map(bounded => ({ version, bounded }))))(
    "keeps the elapsed delay on the bounded and unbounded q6h grid ($bounded/$version)", ({ version, bounded }) => {
      const input = wire(delayed(bounded), version), before = JSON.stringify(input);
      const expected = ["2026-01-01T02:00:00+00:00", "2026-01-01T08:00:00+00:00",
        "2026-01-01T14:00:00+00:00", "2026-01-01T20:00:00+00:00"];
      expect(nextDueDoses(input, query)).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(4);
      expect(nextDueDoses(reopen(input), query)).toEqual(expected);
      for (const dosage of [input, reopen(input)]) {
        // The retained native/R5/R6 bound is nominal. The separate administration
        // delay displaces each occurrence, including the inclusive terminal one:
        // 02:00 remains eligible; the following 08:00 opportunity is excluded.
        const throughNextOpportunity = nextDueDoses(dosage, { ...query, limit: 7 })
          .filter(stamp => Date.parse(stamp) < Date.parse("2026-01-02T09:00:00Z"));
        const throughDisplacedEnd = [...expected, "2026-01-02T02:00:00+00:00"];
        expect(throughNextOpportunity).toEqual(bounded ? throughDisplacedEnd
          : [...throughDisplacedEnd, "2026-01-02T08:00:00+00:00"]);
        expect(calculateTotalUnits({ dosage, ...query, durationValue: 33, durationUnit: Unit.Hour }).totalUnits)
          .toBe(bounded ? 5 : 6);
      }
      expect(JSON.stringify(input)).toBe(before);
    });

  it.each(versions.flatMap(version => [1, 2].map(clocks => ({ version, clocks }))))(
    "uses the authored first and fifteenth before monthly clock distribution ($clocks/$version)", ({ version, clocks }) => {
      const times = clocks === 1 ? ["09:00:00"] : ["09:00:00", "17:00:00"];
      const input = wire(monthly(times), version), before = JSON.stringify(input);
      const expected = ["2026-01-01", "2026-01-15", "2026-02-01", "2026-02-15"]
        .flatMap(day => times.map(time => day + "T" + time + "+00:00"));
      expect(nextDueDoses(input, { ...query, limit: expected.length })).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 1, durationUnit: Unit.Month }).totalUnits).toBe(2 * clocks);
      expect(nextDueDoses(reopen(input), { ...query, limit: expected.length })).toEqual(expected);
      expect(importCanonicalCourse(input).stages[0].administrations[0].schedule!.recurrence)
        .toMatchObject({ frequency: clocks * 2, period: 1, periodUnit: Unit.Month, monthDays: [1, 15], clocks: times });
      expect(nextDueDoses(wire(monthly(["09:00:00"], false), version), { ...query, limit: 2 }))
        .toEqual(["2026-01-01T09:00:00+00:00", "2026-01-16T09:00:00+00:00"]);
      expect(JSON.stringify(input)).toBe(before);
    });

  it.each(versions.flatMap(version => [false, true].map(clocks => ({ version, clocks }))))(
    "counts the executable upper recurrence while retaining its zero minimum ($clocks/$version)", ({ version, clocks }) => {
      const input = wire(upper(clocks), version), before = JSON.stringify(input);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 1, durationUnit: Unit.Day }))
        .toMatchObject({ totalUnits: 2, unit: "tab", quantityKind: "maximum" });
      expect(importCanonicalCourse(input).stages[0].administrations[0].schedule!.recurrence)
        .toMatchObject({ frequency: 0, frequencyMax: 2, period: 1, periodUnit: Unit.Day });
      expect(calculateTotalUnits({ dosage: reopen(input), ...query, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(2);
      expect(JSON.stringify(input)).toBe(before);
    });

  it.each(versions.flatMap(version => (["equal elapsed", "unequal elapsed", "civil day"] as const).map(kind => ({ version, kind }))))(
    "resolves only equivalent elapsed infusion endpoints without rewriting their units ($kind/$version)", ({ version, kind }) => {
      const course = durationCourse(kind), input = wire(course, version), before = JSON.stringify(input);
      const expected = kind === "equal elapsed"
        ? ["2026-01-01T08:00:00+00:00", "2026-01-01T22:00:00+00:00"] : ["2026-01-01T08:00:00+00:00"];
      expect(nextDueDoses(input, query)).toEqual(expected);
      const total = () => calculateTotalUnits({ dosage: input, ...query, durationValue: 1, durationUnit: Unit.Day });
      if (kind === "unequal elapsed")
        expect(total).toThrowError(expect.objectContaining({ code: "course-duration-unresolved" }));
      else expect(total().totalUnits).toBe(kind === "equal elapsed" ? 150 : 100);
      expect(importCanonicalCourse(input).stages[0].administrations[0].schedule!.recurrence!.occurrenceDurationRange)
        .toMatchObject(course.stages[0].administrations[0].schedule!.recurrence!.occurrenceDurationRange!);
      expect(nextDueDoses(reopen(input), query)).toEqual(expected);
      expect(JSON.stringify(input)).toBe(before);
    });

  it.each(versions.flatMap(version => ["min", "min{infusion}", "furlong"].map(code => ({ version, code }))))(
    "measures a recognized annotated time denominator and preserves unknown units ($code/$version)", ({ version, code }) => {
      const input = wire(ratioCourse(code), version), before = JSON.stringify(input);
      const calculate = (dosage: typeof input) => calculateTotalUnits({ dosage, ...query, durationValue: 1, durationUnit: Unit.Day });
      if (code === "furlong") expect(() => calculate(input)).toThrow(expect.objectContaining({ code: "rate-units-unresolved" }));
      else expect(calculate(input)).toMatchObject({ totalUnits: 100, unit: "mL" });
      const saved = reopen(input);
      expect(importCanonicalCourse(saved).stages[0].administrations[0].amounts![0].rateRatio!.denominator)
        .toMatchObject({ value: 60, unit: "infusion minutes", system: "http://unitsofmeasure.org", code });
      if (code !== "furlong") expect(calculate(saved)).toMatchObject({ totalUnits: 100, unit: "mL" });
      expect(JSON.stringify(input)).toBe(before);
    });

  it.each(versions)("completes a bare stat predecessor on its own parallel eye track (%s)", version => {
    const parsed = parseSig("1 drop OD stat then 2 drops OD daily at 10:00; 1 drop OS BID");
    const course = parsed.meta.canonical.course!, members = course.stages[0].administrations;
    expect(members[1].phasePredecessors).toEqual([members[0].sourceMember]);
    expect(members[1].phaseStart).toBeUndefined();
    const input = wire(course, version), before = JSON.stringify(input);
    const expected = ["2026-01-01T00:00:00+00:00", "2026-01-01T08:00:00+00:00", "2026-01-01T10:00:00+00:00",
      "2026-01-01T20:00:00+00:00", "2026-01-02T08:00:00+00:00", "2026-01-02T10:00:00+00:00"];
    expect(nextDueDoses(input, { ...query, limit: 6 })).toEqual(expected);
    expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 2, durationUnit: Unit.Day }).totalUnits).toBe(9);
    expect(nextDueDoses(reopen(input), { ...query, limit: 6 })).toEqual(expected);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(versions.flatMap(version => ["", "once "].map(once => ({ version, once }))))(
    "places the next morning after the single predecessor's actual day ($once/$version)", ({ version, once }) => {
      const source = "Take 1 tablet " + once + "at 22:00 and take 2 tablets the next morning";
      expect(createBoundaryPlan(source).relations).toEqual(expect.arrayContaining([expect.objectContaining({ rule: "regimen.sequence" })]));
      const input = wire(parseSig(source).meta.canonical.course!, version), before = JSON.stringify(input);
      const lateOrder = { from: "2026-12-01T23:00:00Z", orderedAt: "2026-12-01T23:00:00Z", timeZone: "UTC",
        eventClock: { MORN: "08:00" }, limit: 3 };
      const expected = ["2026-12-02T22:00:00+00:00", "2026-12-03T08:00:00+00:00"];
      expect(nextDueDoses(input, lateOrder)).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...lateOrder, durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(3);
      expect(nextDueDoses(reopen(input), lateOrder)).toEqual(expected);
      expect(JSON.stringify(input)).toBe(before);
    });

  it("keeps a daily predecessor outside the single-point next-morning construction", () => {
    const plan = createBoundaryPlan("Take 1 tablet daily at 22:00 and take 2 tablets the next morning");
    expect(plan.relations.some(relation => relation.rule === "regimen.sequence")).toBe(false);
  });
});


describe("round61 equivalent civil infusion endpoints", () => {
  const versions = ["native", "R5", "R6"] as const;
  const variants = [
    { name: "week/day", low: { value: 1, unit: "wk" }, high: { value: 7, unit: "d" }, exact: true },
    { name: "day/week", low: { value: 7, unit: "d" }, high: { value: 1, unit: "wk" }, exact: true },
    { name: "week/week", low: { value: 1, unit: "wk" }, high: { value: 1, unit: "wk" }, exact: true },
    { name: "day/day", low: { value: 7, unit: "d" }, high: { value: 7, unit: "d" }, exact: true },
    { name: "unequal civil bounds", low: { value: 1, unit: "wk" }, high: { value: 8, unit: "d" }, exact: false },
    { name: "civil day/elapsed hours", low: { value: 1, unit: "d" }, high: { value: 24, unit: "h" }, exact: false },
    { name: "civil week/elapsed hours", low: { value: 1, unit: "wk" }, high: { value: 168, unit: "h" }, exact: false },
  ];
  const query = {
    orderedAt: "2026-03-01T00:00:00-05:00", from: "2026-03-01T00:00:00-05:00",
    timeZone: "America/New_York", limit: 2,
  };
  for (const version of versions) for (const variant of variants) {
    it("preserves authored endpoints and resolves only equal civil intervals across DST (" + variant.name + "/" + version + ")", () => {
      const range = {
        low: { ...variant.low, id: "authored-lower-duration", extension: [
          { url: "urn:clinic:duration-note", valueString: "Keep this lower endpoint" },
        ] },
        high: { ...variant.high, id: "authored-upper-duration", extension: [
          { url: "urn:clinic:duration-note", valueString: "Keep this upper endpoint" },
        ] },
      };
      const course = courseFromR6({
        step: [{ component: [{ doseAndRate: [{ doseQuantity: { value: 100, unit: "mL" } }],
          timing: { repeat: { count: 1, timeOfDay: ["08:00:00"], extension: [{
            url: "urn:ezmedicationinput:StructureDefinition:timing-administration-duration",
            valueRange: range,
          }] } },
        }] }, { component: [{ doseAndRate: [{ doseQuantity: { value: 50, unit: "mL" } }],
          timing: { repeat: { count: 1, timeOfDay: ["08:30:00"] } },
        }] }],
      });
      const input = version === "native" ? course
        : freshExecutionInput(version === "R5" ? courseToR5(course) : courseToR6(course));
      const before = JSON.stringify(input);
      const expected = variant.exact
        ? ["2026-03-01T08:00:00-05:00", "2026-03-08T08:30:00-04:00"]
        : ["2026-03-01T08:00:00-05:00"];
      expect(nextDueDoses(input, query)).toEqual(expected);
      if (variant.name === "unequal civil bounds") {
        for (const end of ["2026-03-08T08:15:00-04:00", "2026-03-08T08:30:00-04:00"])
          expect(calculateTotalUnits({ dosage: input, ...query,
            durationValue: (Date.parse(end) - Date.parse(query.from)) / 60000, durationUnit: Unit.Minute }).totalUnits)
            .toBe(100);
      }
      const total = () => calculateTotalUnits({ dosage: input, ...query, durationValue: 8, durationUnit: Unit.Day });
      if (variant.exact) expect(total().totalUnits).toBe(150);
      else expect(total).toThrowError(expect.objectContaining({ code: "course-duration-unresolved" }));
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 1, durationUnit: Unit.Day }).totalUnits)
        .toBe(100);
      expect(importCanonicalCourse(input).stages[0].administrations[0].schedule!.recurrence!.occurrenceDurationRange)
        .toEqual(range);
      const saved = freshExecutionInput(toDosageDetails(freshExecutionInput(courseToR5(importCanonicalCourse(input)))));
      expect(nextDueDoses(saved, query)).toEqual(expected);
      const savedTotal = () => calculateTotalUnits({ dosage: saved, ...query, durationValue: 8, durationUnit: Unit.Day });
      if (variant.exact) expect(savedTotal().totalUnits).toBe(150);
      else expect(savedTotal).toThrowError(expect.objectContaining({ code: "course-duration-unresolved" }));
      expect(calculateTotalUnits({ dosage: saved, ...query, durationValue: 1, durationUnit: Unit.Day }).totalUnits)
        .toBe(100);
      expect(importCanonicalCourse(saved).stages[0].administrations[0].schedule!.recurrence!.occurrenceDurationRange)
        .toEqual(range);
      expect(JSON.stringify(input)).toBe(before);
    });
  }
});

describe("round61 zero-minimum compatible timing codes", () => {
  const versions = ["native", "R5", "R6"] as const;
  const ranges = [
    { minimum: 0, maximum: 2 },
    { minimum: 1, maximum: 2 },
    { minimum: 0, maximum: 1 },
  ];
  const query = { ...options, limit: 2 };
  for (const version of versions) {
    for (const { minimum, maximum } of ranges) {
      it("executes BID only inside the authored frequency range (" + minimum + "-" + maximum + "/" + version + ")", () => {
        const code = { coding: [{
          system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "BID",
        }] };
        const course = courseFromR6({ step: [{ component: [{
          doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
          timing: { code, repeat: { frequencyMax: maximum, period: 1, periodUnit: Unit.Day,
            ...(minimum === 0 ? { extension: [{
              url: "urn:ezmedicationinput:StructureDefinition:medication-timing-frequency-min", valueInteger: 0,
            }] } : { frequency: minimum }),
          } },
        }] }] });
        const input = version === "native" ? course
          : freshExecutionInput(version === "R5" ? courseToR5(course) : courseToR6(course));
        const before = JSON.stringify(input);
        const saved = freshExecutionInput(toDosageDetails(freshExecutionInput(courseToR5(importCanonicalCourse(input)))));
        for (const dosage of [input, saved]) {
          if (maximum === 1) {
            expect(() => nextDueDoses(dosage, query))
              .toThrow(expect.objectContaining({ code: "timing-code-repeat-conflict" }));
            expect(() => calculateTotalUnits({ dosage, ...query, durationValue: 1, durationUnit: Unit.Day }))
              .toThrow(expect.objectContaining({ code: "timing-code-repeat-conflict" }));
          } else {
            expect(nextDueDoses(dosage, query))
              .toEqual(["2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00"]);
            expect(calculateTotalUnits({ dosage, ...query, durationValue: 1, durationUnit: Unit.Day }))
              .toMatchObject({ totalUnits: 2, unit: "tab", quantityKind: "maximum" });
          }
          expect(importCanonicalCourse(dosage).stages[0].administrations[0].schedule)
            .toMatchObject({ code, recurrence: {
              frequency: minimum, frequencyMax: maximum, period: 1, periodUnit: Unit.Day,
            } });
        }
        expect(JSON.stringify(input)).toBe(before);
      });
    }
  }
});

describe("round61 PRN history, bare hourly codes and immediate supply", () => {
  const versions = ["native", "R5", "R6"] as const;
  const wire = (member: CanonicalAdministration, version: typeof versions[number]) => {
    const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [member] }] };
    return version === "native" ? course
      : freshExecutionInput(version === "R5" ? courseToR5(course) : courseToR6(course));
  };
  const reopen = (input: ReturnType<typeof wire>) =>
    freshExecutionInput(toDosageDetails(freshExecutionInput(courseToR5(importCanonicalCourse(input)))));
  const start = "2026-01-03T00:00:00Z";
  const query = { orderedAt: start, from: start, timeZone: "UTC" };

  const untimed = (calendar = false) => courseFromR6({ step: [{ component: [{
    doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], asNeeded: true,
    timing: { repeat: { countMax: 2, ...(calendar ? { boundsPeriod: { start: "2026-01-03" } } : {}),
      extension: [{ url: TIMING_OCCURRENCE_CAP_EXTENSION_URL, extension: [
        { url: "max", valueInteger: 1 },
        { url: "period", valueQuantity: { value: 1, unit: "d", code: "d", system: "http://unitsofmeasure.org" } },
      ] }],
    } },
  }] }] }).stages[0].administrations[0];

  for (const version of versions) {
    it("counts only current-order records against untimed PRN allowance (" + version + ")", () => {
      for (const calendar of [false, true]) {
        const member = untimed(calendar);
        const input = wire(member, version);
        const local = { ...query, orderedAt: calendar ? origin : start };
        for (const dosage of [input, reopen(input)]) {
          const calculate = (extra = {}) => calculateTotalUnits({
            dosage, ...local, durationValue: 2, durationUnit: Unit.Day, ...extra,
          }).totalUnits;
          expect(calculate()).toBe(2);
          expect(calculate({ priorDoseTimes: ["2026-01-02T12:00:00Z"] })).toBe(2);
          expect(calculate({ priorDoseTimes: ["2026-01-02T12:00:00Z"], priorCount: 1 })).toBe(1);
          expect(calculate({ priorDoseTimes: ["2026-01-02T12:00:00Z"], priorCount: 0 })).toBe(2);
          expect(calculate({ from: "2026-01-04T00:00:00Z",
            priorDoseTimes: ["2026-01-02T12:00:00Z", "2026-01-03T09:00:00Z"] })).toBe(1);
        }
      }
    });

    it("retains pre-order history for rolling PRN limits (" + version + ")", () => {
      const member: CanonicalAdministration = {
        ...untimed(),
        limits: [{ scope: "period", amount: { value: 1, unit: "tab" }, period: { value: 24, unit: "h" } }],
      };
      const input = wire(member, version);
      for (const dosage of [input, reopen(input)]) {
        const supply = { dosage, ...query, durationValue: 12, durationUnit: Unit.Hour };
        expect(calculateTotalUnits(supply).totalUnits).toBe(1);
        expect(calculateTotalUnits({ ...supply, priorDoseTimes: ["2026-01-02T20:00:00Z"] }).totalUnits).toBe(0);
      }
    });

    for (const variant of ["bare", "explicit events", "local code"] as const) {
      it("executes only recognized bare hourly cadence with event ownership (" + variant + "/" + version + ")", () => {
        const code = { coding: [{ code: "Q4H",
          ...(variant === "local code" ? { system: "urn:clinic:local-timing" } : {}),
        }] };
        const events = ["2026-01-03T03:00:00Z", "2026-01-03T13:00:00Z"];
        const input = wire({ ...dose(), schedule: { code,
          ...(variant === "explicit events" ? { explicitEvents: events } : {}),
        } }, version);
        for (const dosage of [input, reopen(input)]) {
          if (variant === "local code") {
            expect(nextDueDoses(dosage, { ...query, limit: 6 })).toEqual([]);
            expect(() => calculateTotalUnits({ dosage, ...query, durationValue: 1, durationUnit: Unit.Day }))
              .toThrow(expect.objectContaining({ code: "timing-required" }));
          } else {
            const clocks = variant === "bare" ? ["00", "04", "08", "12", "16", "20"] : ["03", "13"];
            expect(nextDueDoses(dosage, { ...query, limit: 6 }))
              .toEqual(clocks.map(hour => "2026-01-03T" + hour + ":00:00+00:00"));
            expect(calculateTotalUnits({ dosage, ...query, durationValue: 1, durationUnit: Unit.Day }).totalUnits)
              .toBe(clocks.length);
          }
          expect(importCanonicalCourse(dosage).stages[0].administrations[0].schedule)
            .toMatchObject({ code, ...(variant === "explicit events" ? { explicitEvents: events } : {}) });
        }
      });
    }

    for (const variant of ["coincident", "distinct", "counted"] as const) {
      it("counts immediate and inferred administrations once (" + variant + "/" + version + ")", () => {
        const member = { ...dose(), schedule: { recurrence: {
          anchors: [EventTiming.Immediate], frequency: 2,
          period: variant === "distinct" ? 1 : 24, periodUnit: variant === "distinct" ? Unit.Day : Unit.Hour,
          ...(variant === "counted" ? { count: 2 } : {}),
        } } };
        const input = wire(member, version);
        const stamp = "2026-01-03T" + (variant === "coincident" ? "08" : "07") + ":00:00Z";
        const local = { orderedAt: stamp, from: stamp, timeZone: "UTC" };
        const clocks = variant === "coincident" ? ["08", "20"] : variant === "distinct" ? ["07", "08", "20"] : ["07", "19"];
        for (const dosage of [input, reopen(input)]) {
          expect(nextDueDoses(dosage, { ...local, limit: variant === "counted" ? 3 : clocks.length }))
            .toEqual(clocks.map(hour => "2026-01-03T" + hour + ":00:00+00:00"));
          expect(calculateTotalUnits({ dosage, ...local, durationValue: variant === "counted" ? 2 : 1, durationUnit: Unit.Day }).totalUnits)
            .toBe(clocks.length);
        }
      });
    }
  }
});

describe("round61 distinct-target typed NEXT ownership", () => {
  const query = { orderedAt: "2026-12-01T23:00:00Z", from: "2026-12-01T23:00:00Z", timeZone: "UTC", limit: 2 };
  for (const version of ["native", "R5", "R6"] as const) {
    for (const next of [true, false]) {
      it("preserves an explicit next-day sequence across eye targets (" + next + "/" + version + ")", () => {
        const parsed = parseSig("Instill 1 drop in the right eye at 22:00 and instill 2 drops in the left eye at 06:00" +
          (next ? " the next morning" : ""));
        const input = version === "native" ? parsed.meta!.canonical!.course!
          : freshExecutionInput(version === "R5" ? parsed.fhir : parsed.fhirNext);
        const saved = freshExecutionInput(toDosageDetails(freshExecutionInput(courseToR5(importCanonicalCourse(input)))));
        for (const dosage of [input, saved]) {
          const members = importCanonicalCourse(dosage).stages.flatMap(stage => stage.administrations);
          expect(members.map(member => ({
            eye: member.target?.text, amount: { value: member.amounts?.[0].quantity?.value, unit: member.amounts?.[0].quantity?.unit },
            clocks: member.schedule?.recurrence?.clocks,
          }))).toEqual([
            { eye: "right eye", amount: { value: 1, unit: "drop" }, clocks: ["22:00:00"] },
            { eye: "left eye", amount: { value: 2, unit: "drop" }, clocks: ["06:00:00"] },
          ]);
          expect(nextDueDoses(dosage, query)).toEqual(next
            ? ["2026-12-02T22:00:00+00:00", "2026-12-03T06:00:00+00:00"]
            : ["2026-12-02T06:00:00+00:00", "2026-12-02T22:00:00+00:00"]);
          for (const [from, totalUnits] of [
            ["2026-12-02T22:00:00Z", 1],
            [next ? "2026-12-03T06:00:00Z" : "2026-12-02T06:00:00Z", 2],
          ] as const)
            expect(calculateTotalUnits({ dosage, ...query, from, durationValue: 1, durationUnit: Unit.Hour }))
              .toMatchObject({ totalUnits, unit: "drop" });
          if (next)
            expect(calculateTotalUnits({ dosage, ...query, durationValue: 2, durationUnit: Unit.Day }).totalUnits).toBe(3);
        }
      });
    }
  }
});

describe("round62 coded cadence with independent constraints", () => {
  const versions = ["native", "R5", "R6"] as const;
  const note = { url: "urn:clinic:timing-note", valueString: "Keep the prescribed timing" };
  const query = { ...options, limit: 5 };
  const wire = (source: FhirR6DosageInstruction, version: typeof versions[number]) => {
    const course = courseFromR6(source);
    return version === "native" ? course
      : freshExecutionInput(version === "R5" ? courseToR5(course) : source);
  };
  const reopen = (input: ReturnType<typeof wire>) =>
    freshExecutionInput(toDosageDetails(freshExecutionInput(courseToR5(importCanonicalCourse(input)))));

  for (const version of versions) {
    for (const kind of ["count", "maximum", "window", "BID", "event", "local"] as const) {
      it("retains independent constraints on a coded cadence (" + kind + "/" + version + ")", () => {
        const repeat = {
          ...(kind === "window" ? { boundsPeriod: { start: "2026-01-01T08:00:00Z", end: "2026-01-01T17:00:00Z" } }
            : kind === "maximum" ? { countMax: 3 } : { count: kind === "event" ? 1 : 3 }),
          extension: [note],
        };
        const code = { coding: [{
          system: kind === "local" ? "urn:clinic:local-timing" : "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation",
          code: kind === "BID" ? "BID" : "Q4H",
        }] };
        const input = wire({ step: [{ component: [{
          doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
          timing: { code, repeat, ...(kind === "event" ? { event: ["2026-01-01T13:00:00Z"] } : {}) },
        }] }] }, version);
        const expected = kind === "window"
          ? ["2026-01-01T08:00:00+00:00", "2026-01-01T12:00:00+00:00", "2026-01-01T16:00:00+00:00"]
          : kind === "BID"
          ? ["2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00", "2026-01-02T08:00:00+00:00"]
          : kind === "event" ? ["2026-01-01T13:00:00+00:00"]
          : ["2026-01-01T00:00:00+00:00", "2026-01-01T04:00:00+00:00", "2026-01-01T08:00:00+00:00"];
        for (const dosage of [input, reopen(input)]) {
          const before = JSON.stringify(dosage);
          if (kind === "local") {
            expect(nextDueDoses(dosage, query)).toEqual([]);
            expect(() => calculateTotalUnits({ dosage, ...query, durationValue: 2, durationUnit: Unit.Day }))
              .toThrow(expect.objectContaining({ code: "timing-required" }));
          } else {
            expect(nextDueDoses(dosage, query)).toEqual(expected);
            expect(calculateTotalUnits({ dosage, ...query, durationValue: 2, durationUnit: Unit.Day }))
              .toMatchObject({ totalUnits: kind === "event" ? 1 : 3, unit: "tab",
                ...(kind === "maximum" ? { quantityKind: "maximum" } : {}),
              });
          }
          const timing = courseToR5(importCanonicalCourse(dosage))[0].timing!;
          expect(timing.code).toEqual(code);
          expect(timing.repeat).toMatchObject(repeat);
          expect(timing.repeat?.frequency).toBeUndefined();
          expect(timing.repeat?.period).toBeUndefined();
          expect(JSON.stringify(dosage)).toBe(before);
        }
      });
    }

    it("opens a successor only after the counted coded loading course (" + version + ")", () => {
      const input = wire({ step: [{ component: [{
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { code: { coding: [{
          system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "Q4H",
        }] }, repeat: { count: 3 } },
      }] }, { component: [{
        doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }],
        timing: { repeat: { count: 1, timeOfDay: ["10:00:00"] } },
      }] }] }, version);
      for (const dosage of [input, reopen(input)]) {
        expect(nextDueDoses(dosage, query)).toEqual([
          "2026-01-01T00:00:00+00:00", "2026-01-01T04:00:00+00:00",
          "2026-01-01T08:00:00+00:00", "2026-01-01T10:00:00+00:00",
        ]);
        expect(calculateTotalUnits({ dosage, ...query, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(5);
        const later = { ...query, from: "2026-01-01T05:00:00Z" };
        expect(nextDueDoses(dosage, later))
          .toEqual(["2026-01-01T08:00:00+00:00", "2026-01-01T10:00:00+00:00"]);
        expect(calculateTotalUnits({ dosage, ...later, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(3);
      }
    });
  }
});


describe("round62 review execution and phase boundaries", () => {
  const versions = ["native", "R5", "R6"] as const;
  const wire = (course: CanonicalCourse, version: typeof versions[number]) =>
    version === "native" ? course : freshExecutionInput(version === "R5" ? courseToR5(course) : courseToR6(course));
  const reopen = (input: ReturnType<typeof wire>) =>
    freshExecutionInput(toDosageDetails(freshExecutionInput(courseToR5(importCanonicalCourse(input)))));

  for (const version of versions) {
    for (const next of [false, true]) {
      it("keeps a paused NEXT origin separate from a treatment-day adjustment (" + next + "/" + version + ")", () => {
        const source = "Take 1 tablet daily at 09:00 for 5 days, then HOLD for 2 days, then take 2 tablets " +
          (next ? "the next morning " : "") + "daily at 09:00, then increase to 3 tablets daily at 09:00 from day 10";
        const parsed = parseSig(source);
        expect(parsed.meta.canonical.clauses.map(clause => clause.dose)).toEqual([
          { value: 1, unit: "tab" }, { value: 2, unit: "tab" }, { value: 3, unit: "tab" },
        ]);
        const middle = parsed.meta.canonical.clauses[1].schedule!;
        expect(middle.treatmentStartOffsetDays).toBe(next ? 2 : 7);
        expect(middle.phaseStartReference).toBe(next ? "previous-phase-next-day" : undefined);
        expect(middle.duration).toBe(next ? undefined : 2);
        const input = wire(parsed.meta.canonical.course!, version), before = JSON.stringify(input);
        const query = { orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-01T00:00:00Z", timeZone: "UTC", limit: 10 };
        const expected = [1, 2, 3, 4, 5, 8, 9, 10, 11, 12].map(day =>
          "2026-12-" + String(day).padStart(2, "0") + "T09:00:00+00:00");
        for (const dosage of [input, reopen(input)]) {
          expect(importCanonicalCourse(dosage).stages.map(stage => stage.administrations.map(member => ({
            amount: member.amounts?.[0].quantity?.value, frequency: member.schedule?.recurrence?.frequency,
            clocks: member.schedule?.recurrence?.clocks,
          })))).toEqual([1, 2, 3].map(amount => [{ amount, frequency: 1, clocks: ["09:00:00"] }]));
          expect(nextDueDoses(dosage, query)).toEqual(expected);
          expect(calculateTotalUnits({ dosage, ...query, durationValue: 12, durationUnit: Unit.Day }).totalUnits).toBe(18);
          expect(calculateTotalUnits({ dosage, ...query, from: "2026-12-10T00:00:00Z",
            durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(3);
        }
        expect(JSON.stringify(input)).toBe(before);
      });
    }

    it("compares clockless frequency defaults through the chronological caps (" + version + ")", () => {
      const member: CanonicalAdministration = { ...dose(),
        schedule: { recurrence: { frequency: 1, frequencyMax: 2, period: 1, periodUnit: Unit.Day,
          courseLength: { value: 2, unit: "d" } } },
        limits: [{ scope: "period", amount: { value: 4, unit: "tab" }, period: { value: 24, unit: "h" } }],
      };
      const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "d" },
        stages: [{ administrations: [member] }] };
      const input = wire(course, version), before = JSON.stringify(input);
      for (const dosage of [input, reopen(input)]) {
        expect(calculateTotalUnits({ dosage, ...options, from: "2026-01-01T08:30:00Z",
          durationValue: 1, durationUnit: Unit.Hour })).toMatchObject({ totalUnits: 1, unit: "tab" });
        expect(calculateTotalUnits({ dosage, ...options, durationValue: 1, durationUnit: Unit.Day }))
          .toMatchObject({ totalUnits: 2, unit: "tab", quantityKind: "maximum" });
        expect(calculateTotalUnits({ dosage, ...options, from: "2026-01-02T00:00:00Z",
          durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(4);
        expect(importCanonicalCourse(dosage).stages[0].administrations[0].schedule?.recurrence)
          .toMatchObject({ frequency: 1, frequencyMax: 2, period: 1, periodUnit: Unit.Day });
      }
      expect(JSON.stringify(input)).toBe(before);
    });

    for (const kind of ["selected", "same-day fence", "unanchored"] as const) {
      it("lets the monthly selector own the successor date (" + kind + "/" + version + ")", () => {
        const selected = kind !== "unanchored", firstDay = kind === "same-day fence" ? "15" : "10";
        const source: FhirR6DosageInstruction = { step: [
          { component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
            timing: { repeat: { count: 1, timeOfDay: ["09:00:00"] } } }] },
          { component: [{ doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }],
            timing: { repeat: { frequency: 1, period: 1, periodUnit: Unit.Month,
              ...(selected ? { extension: [{ url: "http://hl7.org/fhir/StructureDefinition/timing-dayOfMonth",
                valuePositiveInt: 15 }] } : {}) } } }] },
        ] };
        const input = wire(courseFromR6(source), version), before = JSON.stringify(input);
        const query = { orderedAt: "2026-01-" + firstDay + "T00:00:00Z",
          from: "2026-01-" + firstDay + "T00:00:00Z", timeZone: "UTC", limit: 3 };
        const expected = ["2026-01-" + firstDay + "T09:00:00+00:00",
          ...(kind === "selected" ? ["2026-01-15T09:00:00+00:00", "2026-02-15T09:00:00+00:00"]
            : kind === "same-day fence" ? ["2026-02-15T09:00:00+00:00", "2026-03-15T09:00:00+00:00"]
            : ["2026-02-10T09:00:00+00:00", "2026-03-10T09:00:00+00:00"])];
        for (const dosage of [input, reopen(input)]) {
          expect(nextDueDoses(dosage, query)).toEqual(expected);
          expect(calculateTotalUnits({ dosage, ...query, from: "2026-01-15T00:00:00Z",
            durationValue: 1, durationUnit: Unit.Day }).totalUnits)
            .toBe(kind === "selected" ? 2 : kind === "same-day fence" ? 1 : 0);
          const members = importCanonicalCourse(dosage).stages.map(stage => stage.administrations[0]);
          expect(members.map(member => member.amounts?.[0].quantity?.value)).toEqual([1, 2]);
          expect(members[1].schedule?.recurrence?.monthDays).toEqual(selected ? [15] : undefined);
        }
        expect(JSON.stringify(input)).toBe(before);
      });
    }

    it("renders bounded and unresolved member ends without indefinite continuation (" + version + ")", () => {
      for (const anchor of ["treatment-start", "treatment-day-start"] as const) {
        const start: CanonicalBoundary = { anchor, displacement: { value: 1, unit: "d" } };
        const end: CanonicalBoundary = { anchor, displacement: { value: 3, unit: "d" } };
        const course = (ending: CanonicalBoundary | undefined): CanonicalCourse => ({
          kind: "course", stages: [{ administrations: [{ ...dose(), phaseStart: start, phaseEnd: ending }] }],
        });
        const input = wire(course(end), version), before = JSON.stringify(input);
        const originEn = anchor === "treatment-start" ? "treatment start" : "the start of the first treatment day";
        const originTh = anchor === "treatment-start" ? "เริ่มการรักษา" : "ต้นวันแรกของการรักษา";
        for (const dosage of [input, reopen(input)]) {
          expect(formatSig(dosage, "long", { locale: "en" })).toBe(
            "From 1 day after " + originEn + " until 3 days after " + originEn +
            ": Use 1 tablet once daily at 9:00 am.");
          expect(formatSig(dosage, "long", { locale: "th" })).toBe(
            "ตั้งแต่1 วันหลัง" + originTh + "จนถึง3 วันหลัง" + originTh +
            ": ใช้ครั้งละ 1 เม็ด วันละครั้ง เวลา 09:00.");
          expect(nextDueDoses(dosage, { ...options, limit: 4 })).toEqual([
            "2026-01-02T09:00:00+00:00", "2026-01-03T09:00:00+00:00",
          ]);
          expect(calculateTotalUnits({ dosage, ...options, durationValue: 4, durationUnit: Unit.Day }).totalUnits).toBe(2);
        }
        expect(JSON.stringify(input)).toBe(before);
        const open = wire(course(undefined), version);
        expect(formatSig(open, "long", { locale: "en" })).toContain(" onward");
        expect(formatSig(open, "long", { locale: "th" })).toContain("เป็นต้นไป");
        const unresolved = wire(course({ anchor: "unresolved", description: "pending clinical review" }), version);
        for (const dosage of [unresolved, reopen(unresolved)]) {
          const en = formatSig(dosage, "long", { locale: "en" });
          const th = formatSig(dosage, "long", { locale: "th" });
          expect(en).not.toContain("onward");
          expect(en).toContain("End timing requires review: pending clinical review");
          expect(en).toContain("Use 1 tablet once daily at 9:00 am.");
          expect(th).not.toContain("เป็นต้นไป");
          expect(th).toContain("ต้องตรวจสอบเวลาสิ้นสุด: pending clinical review");
          expect(importCanonicalCourse(dosage).stages[0].administrations[0].phaseEnd?.description)
            .toBe("pending clinical review");
        }
      }
    });

    it("qualifies the civil-day successor after an equal ranged predecessor end (" + version + ")", () => {
      const course: CanonicalCourse = { kind: "course", stages: [
        { end: { anchor: "treatment-day-start", displacementRange: {
          low: { value: 3, unit: "d" }, high: { value: 3, unit: "d" },
        } }, administrations: [dose()] },
        { end: { anchor: "treatment-day-start", displacement: { value: 7, unit: "d" } },
          administrations: [dose(2)] },
      ] };
      const input = wire(course, version), before = JSON.stringify(input);
      for (const dosage of [input, reopen(input)]) {
        expect(formatSig(dosage, "long", { locale: "en" })).toContain(
          "After the previous phase; Through day 7: Use 2 tablets once daily at 9:00 am.");
        expect(formatSig(dosage, "long", { locale: "th" })).toContain(
          "หลังขั้นตอนก่อนหน้า; ถึงวันที่ 7: ใช้ครั้งละ 2 เม็ด วันละครั้ง เวลา 09:00.");
        expect(nextDueDoses(dosage, { ...options, limit: 8 })).toEqual(
          [1, 2, 3, 4, 5, 6, 7].map(day => "2026-01-0" + day + "T09:00:00+00:00"));
        expect(calculateTotalUnits({ dosage, ...options, durationValue: 7, durationUnit: Unit.Day }).totalUnits).toBe(11);
        expect(importCanonicalCourse(dosage).stages.map(stage => stage.administrations[0].amounts?.[0].quantity?.value))
          .toEqual([1, 2]);
      }
      expect(JSON.stringify(input)).toBe(before);
    });
  }
});


describe("round74 independent count history and cadence origins", () => {
  const versions = ["native", "R5", "R6", "saved R5"] as const;
  const wire = (course: CanonicalCourse, version: typeof versions[number]) => {
    if (version === "native") return freshExecutionInput(course);
    if (version === "R6") return freshExecutionInput(courseToR6(course));
    const rows = freshExecutionInput(courseToR5(course));
    return version === "R5" ? rows : freshExecutionInput(courseToR5(importCanonicalCourse(rows)));
  };

  it.each(versions)("retains a single-cycle PRN count beside a rolling quantity cap (%s)", version => {
    for (const cycleCount of [1, 2]) for (const priorCount of [0, 1, 2]) {
      const member = dose();
      member.asNeeded = true;
      member.schedule!.recurrence!.countMax = 2;
      member.limits = [{ scope: "period", amount: { value: 1, unit: "tab" }, period: { value: 24, unit: "h" } }];
      const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 7, unit: "d" },
        cycleCount, stages: [{ administrations: [member] }] };
      const input = wire(course, version), before = JSON.stringify(input);
      const query = { ...options, from: "2026-01-04T00:00:00Z", priorCount, limit: 1 };
      // An untimed count belongs to the sole cycle/member. Multiple cycles
      // cannot assign that count to one cycle, so retain their existing policy.
      const exhausted = cycleCount === 1 && priorCount === 2;
      expect(nextDueDoses(input, query)).toEqual(exhausted ? [] : ["2026-01-04T09:00:00+00:00"]);
      expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 1, durationUnit: Unit.Day }).totalUnits)
        .toBe(exhausted ? 0 : 1);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(versions)("keeps an explicit cadence origin separate from its calendar eligibility floor (%s)", version => {
    for (const explicitOrigin of [false, true]) for (const count of [undefined, 2]) {
      const member = dose();
      member.schedule!.recurrence = { frequency: 1, period: 2, periodUnit: Unit.Day, clocks: ["09:00:00"],
        calendarWindow: { start: "2026-01-02" }, ...(count === undefined ? {} : { count }) };
      if (explicitOrigin) member.phaseStart = relative(0);
      const input = wire({ kind: "course", stages: [{ administrations: [member] }] }, version);
      const before = JSON.stringify(input), query = { ...options, from: "2026-01-02T00:00:00Z", limit: 3 };
      const expectedDays = explicitOrigin ? count === undefined ? [3, 5, 7] : [3, 5]
        : count === undefined ? [2, 4, 6] : [2, 4];
      expect(nextDueDoses(input, query)).toEqual(expectedDays
        .map(day => "2026-01-0" + day + "T09:00:00+00:00"));
      expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 1, durationUnit: Unit.Day }).totalUnits)
        .toBe(explicitOrigin ? 0 : 1);
      expect(JSON.stringify(input)).toBe(before);
    }
  });
  it.each(versions)("uses known clocks only to disprove partial-event overlap (%s)", version => {
    for (const [partial, from, hours, knownClock, expected] of [
      ["2026-11", "2026-11-30T18:00:00Z", 1, true, 0],
      ["2026-11", "2026-11-15T18:00:00Z", 1, true, 0],
      ["2026", "2026-12-31T18:00:00Z", 1, true, 0],
      ["2026-11", "2026-11-30T08:00:00Z", 1, true, 0],
      ["2026-11", "2026-11-30T08:00:00Z", 2, true, undefined],
      ["2026-11", "2026-11-30T18:00:00Z", 1, false, undefined],
    ] as const) {
      const member = dose();
      member.schedule = { explicitEvents: [partial], ...(knownClock ? { recurrence: { clocks: ["09:00:00"] } } : {}) };
      const input = wire({ kind: "course", stages: [{ administrations: [member] }] }, version);
      const before = JSON.stringify(input), query = { orderedAt: origin, from, timeZone: "UTC", limit: 1 };
      expect(nextDueDoses(input, query)).toEqual([]);
      const calculate = () => calculateTotalUnits({ dosage: input, ...query, durationValue: hours, durationUnit: Unit.Hour });
      if (expected === undefined) expect(calculate).toThrow(expect.objectContaining({ code: "timing-required" }));
      else expect(calculate()).toMatchObject({ totalUnits: expected, unit: "tab" });
      expect(JSON.stringify(input)).toBe(before);
    }
  });

});


describe("round75 duration identity in execution", () => {
  const contextCode = { coding: [{
    system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start"
  }] };
  const annotation = { url: "urn:clinic:duration-note", valueString: "Retain the authored duration" };
  const local = (value: number, code: string, unit: string) => ({
    value, code, unit, system: "urn:clinic:time", extension: [annotation]
  });
  const forms = (source: FhirR6DosageInstruction) => {
    const rows = freshExecutionInput(toFhirR5Dosages(freshExecutionInput(source)));
    return [freshExecutionInput(source), rows, freshExecutionInput(toDosageDetails(rows))];
  };
  const once = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
    timing: { repeat: { count: 1 } } };

  it.each(["scalar", "range"] as const)("does not execute local %s treatment offsets as familiar time codes", kind => {
    const quantity = local(kind === "scalar" ? 7 : 2, kind === "scalar" ? "d" : "h",
      kind === "scalar" ? "treatment blocks" : "sessions");
    const start = { contextCode, ...(kind === "scalar"
      ? { offsetDuration: quantity } : { offsetRange: { low: quantity, high: { ...quantity } } }) };
    const source: FhirR6DosageInstruction = { step: [{ start, component: [once] }] };
    for (const input of forms(source)) {
      const before = JSON.stringify(input);
      expect(() => nextDueDoses(input, { ...options, limit: 2 })).toThrow(/treatment-start time unit/u);
      expect(() => calculateTotalUnits({ dosage: input, ...options, durationValue: 10, durationUnit: Unit.Day }))
        .toThrow(/treatment-start time unit/u);
      expect(toDosageDetails(toFhirR5Dosages(input)).step[0].start).toEqual(start);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["UCUM", "systemless"] as const)("retains recognized %s treatment offsets", identity => {
    const offsetDuration = { value: 2, unit: "h", code: "h",
      ...(identity === "UCUM" ? { system: "http://unitsofmeasure.org" } : {}), extension: [annotation] };
    const start = { contextCode, offsetDuration };
    const source: FhirR6DosageInstruction = { step: [{ start, component: [once] }] };
    for (const input of forms(source)) {
      const before = JSON.stringify(input);
      expect(nextDueDoses(input, { ...options, limit: 2 })).toEqual(["2026-01-01T02:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 3, durationUnit: Unit.Hour }))
        .toMatchObject({ totalUnits: 1, unit: "tab", quantityKind: "scheduled" });
      expect(toDosageDetails(toFhirR5Dosages(input)).step[0].start).toEqual(start);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["local collision", "opaque local", "UCUM", "systemless"] as const)(
    "uses the period terminology before applying a rolling maximum: %s", identity => {
      const known = identity === "UCUM" || identity === "systemless";
      const period = known
        ? { value: 1, unit: "d", code: "d",
          ...(identity === "UCUM" ? { system: "http://unitsofmeasure.org" } : {}), extension: [annotation] }
        : local(1, identity === "local collision" ? "d" : "clinic-session", "sessions");
      const source: FhirR6DosageInstruction = { step: [{ component: [{
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { frequency: 2, period: 1, periodUnit: Unit.Day, timeOfDay: ["09:00:00", "17:00:00"] } },
        safety: { doseLimit: [{ scope: "period", valueQuantity: { value: 1, unit: "tab" }, period }] }
      }] }] };
      const expected = known
        ? ["2026-01-01T09:00:00+00:00", "2026-01-02T09:00:00+00:00",
          "2026-01-03T09:00:00+00:00", "2026-01-04T09:00:00+00:00"]
        : ["2026-01-01T09:00:00+00:00", "2026-01-01T17:00:00+00:00",
          "2026-01-02T09:00:00+00:00", "2026-01-02T17:00:00+00:00"];
      for (const input of forms(source)) {
        const before = JSON.stringify(input);
        expect(nextDueDoses(input, { ...options, limit: 4 })).toEqual(expected);
        const total = calculateTotalUnits({ dosage: input, ...options, durationValue: 2, durationUnit: Unit.Day });
        expect(total).toMatchObject({ totalUnits: known ? 2 : 4, unit: "tab", quantityKind: "maximum" });
        if (known) expect(total.explanation).not.toContain("unevaluable maximum-dose constraint");
        else expect(total.explanation).toContain("an unevaluable maximum-dose constraint was retained but could not be applied");
        expect(toDosageDetails(toFhirR5Dosages(input)).step[0].component[0].safety?.doseLimit?.[0].period).toEqual(period);
        expect(JSON.stringify(input)).toBe(before);
      }
    }
  );
});


describe("round76 partial-event selectors and supply qualifications", () => {
  const versions = (course: CanonicalCourse) => {
    const projected = projectCanonicalCourse(course);
    return [course, freshExecutionInput(projected.fhir), freshExecutionInput(projected.fhirNext),
      freshExecutionInput(toDosageDetails(projected.fhir))];
  };

  it.each([false, true])("applies month-day membership to possible partial dates without choosing one (clock=%s)", clock => {
    const course = courseFromR6({ step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { event: ["2026-11"], repeat: {
        ...(clock ? { timeOfDay: ["09:00:00"] } : {}),
        extension: [{ url: "http://hl7.org/fhir/StructureDefinition/timing-dayOfMonth", valuePositiveInt: 15 }],
      } },
    }] }] });
    for (const input of versions(course)) {
      const before = JSON.stringify(input);
      const query = { orderedAt: "2026-11-01T00:00:00Z", from: "2026-11-16T00:00:00Z", timeZone: "UTC" };
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(0);
      expect(() => calculateTotalUnits({ dosage: input, ...query, from: "2026-11-15T00:00:00Z",
        durationValue: 1, durationUnit: Unit.Day })).toThrow(/resolved administration date/u);
      expect(nextDueDoses(input, { ...query, from: "2026-11-01T00:00:00Z", limit: 2 })).toEqual([]);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each([false, true])("retains normalized-weight supply meaning through course aggregation (known=%s)", known => {
    const member: CanonicalAdministration = { ...dose(), amounts: [{ quantity: { value: 1, unit: "mg/kg" } }] };
    const patientWeightKg = known ? 70 : undefined;
    const scalar = supply(member, 1, { patientWeightKg });
    expect(scalar).toMatchObject({ totalUnits: known ? 70 : 1, unit: known ? "mg" : "mg/kg" });
    expect(scalar.quantityKind ?? "scheduled").toBe("scheduled");
    for (const input of versions({ kind: "course", stages: [{ administrations: [member] }] })) {
      const before = JSON.stringify(input);
      const result = calculateTotalUnits({ dosage: input, ...options, patientWeightKg, durationValue: 1, durationUnit: Unit.Day });
      expect(result).toMatchObject({ totalUnits: scalar.totalUnits, unit: scalar.unit });
      expect(result.quantityKind ?? "scheduled").toBe("scheduled");
      if (known) expect(result.explanation ?? "").not.toContain("provide patientWeightKg");
      else expect(result.explanation).toContain("provide patientWeightKg for an absolute quantity");
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each([false, true])("keeps qualified-cap supply policy while resolving a finite phase completion (event=%s)", event => {
    const member: CanonicalAdministration = { ...dose(),
      schedule: event ? { explicitEvents: ["2026-01-01T09:00:00Z", "2026-01-01T17:00:00Z"], recurrence: { count: 2 } }
        : { recurrence: { count: 2, frequency: 2, period: 1, periodUnit: Unit.Day, clocks: ["09:00:00", "17:00:00"] } },
      limits: [{ scope: "period", amount: { value: 1, unit: "tab" },
        period: { value: 24, unit: "h", comparator: "<=", id: "authored-cap-period" } }],
    };
    const scalar = supply(member, 1);
    expect(scalar).toMatchObject({ totalUnits: 2, unit: "tab", quantityKind: "maximum" });
    expect(scalar.explanation).toContain("could not be applied");
    const exact = freshExecutionInput(member);
    delete exact.limits![0].period!.comparator;
    expect(supply(exact, 1)).toMatchObject({ totalUnits: 1, unit: "tab" });
    const course: CanonicalCourse = { kind: "course", stages: [{
      start: relative(0), end: relative(1), administrations: [member],
    }] };
    for (const input of versions(course)) {
      const before = JSON.stringify(input);
      const result = calculateTotalUnits({ dosage: input, ...options, durationValue: 1, durationUnit: Unit.Day });
      expect(result).toMatchObject({ totalUnits: 2, unit: "tab", quantityKind: "maximum" });
      expect(result.explanation).toContain("could not be applied");
      const exactCourse = freshExecutionInput(importCanonicalCourse(freshExecutionInput(input)));
      delete exactCourse.stages[0].administrations[0].limits![0].period!.comparator;
      expect(calculateTotalUnits({ dosage: exactCourse, ...options, durationValue: 1, durationUnit: Unit.Day }))
        .toMatchObject({ totalUnits: 1, unit: "tab" });
      expect(() => nextDueDoses(input, { ...options, limit: 1 })).toThrow(/unresolved inequality/u);
      expect(importCanonicalCourse(input).stages[0].administrations[0].limits?.[0].period)
        .toMatchObject({ value: 24, unit: "h", comparator: "<=", id: "authored-cap-period" });
      expect(JSON.stringify(input)).toBe(before);
    }
  });
});
}


describe("shared administration totals in current previews", () => {
  const member = (clock: string, count?: number, countMax?: number): CanonicalAdministration => ({
    kind: "administration",
    amounts: [{ quantity: { value: 1, unit: "tab" } }],
    schedule: { recurrence: {
      frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, clocks: [clock],
      sharedCount: { groupId: "morning-evening", ...(count === undefined ? {} : { count }),
        ...(countMax === undefined ? {} : { countMax }) }
    } }
  });
  const independent = (): CanonicalAdministration => ({
    kind: "administration", amounts: [{ quantity: { value: 2, unit: "tab" } }],
    schedule: { recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
      clocks: ["12:00:00"], count: 2 } }
  });
  const views = (course: CanonicalCourse) => {
    const unknown = { url: "urn:clinic:shared-schedule-note", valueString: "keep current group metadata" };
    const r6 = { ...courseToR6(course), extension: [unknown] };
    const r5 = JSON.parse(JSON.stringify(toFhirR5Dosages(r6))) as FhirDosage[];
    expect(toDosageDetails(r5).extension).toContainEqual(unknown);
    return [course, r6, r5] as const;
  };

  it("states one four-dose allowance for the two current clocks and preserves the prescribed exclusion", () => {
    const source = "Take 1 tablet at 08:00 and 20:00 for 4 doses. On Mondays, do not take the 1-tablet morning dose";
    const parsed = parseProductionSig(source);
    const course = parsed.meta.canonical.course!;
    const members = course.stages[0].administrations;
    expect(members).toHaveLength(2);
    expect(members.map(value => value.schedule?.recurrence?.sharedCount?.count)).toEqual([4, 4]);
    expect(members.every(value => value.schedule?.recurrence?.count === undefined)).toBe(true);
    for (const input of [course, parsed.fhirNext, JSON.parse(JSON.stringify(parsed.fhir))]) {
      const before = JSON.stringify(input);
      for (const locale of ["en", "th"]) for (const style of ["short", "long"] as const) {
        const text = formatSig(input, style, { locale, realizationMode: "normalized" });
        expect(text.match(/\b4\b/gu)).toHaveLength(1);
        expect(text).toContain(locale === "en" ? "sharing its limits" : "ใช้ข้อจำกัดร่วมกัน");
        expect(text).toMatch(locale === "en" && style === "long" ? /8:00 am/u : /08:00/u);
        expect(text).toMatch(locale === "en" && style === "long" ? /8:00 pm/u : /20:00/u);
        expect(text).toContain(locale === "en" ? "except Monday" : "ยกเว้นวันจันทร์");
      }
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(parsed.input).toBe(source);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(formatParseBatch(parsed, "long").match(/\b4\b/gu)).toHaveLength(1);
    for (const item of parsed.items) {
      expect(item.longText.match(/\b4\b/gu)).toHaveLength(1);
      expect(item.longText).toContain("sharing its limits");
      expect(item.longText.match(/8:00 (?:am|pm)/gu)).toHaveLength(1);
    }
  });

  it("keeps an unrelated noon dose outside a shared four-dose group", () => {
    const am = { ...member("08:00:00", 4), excludedWeekdays: ["mon" as const] };
    const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [am, independent(), member("20:00:00", 4)] }] };
    const expected = {
      en: "(Schedule sharing its limits and a total of 4 administrations: Use 1 tablet once daily at 8:00 am except Monday; Use 1 tablet once daily at 8:00 pm.); Use 2 tablets once daily at 12:00 pm for 2 doses.",
      th: "(ตารางให้ยาที่ใช้ข้อจำกัดร่วมกัน และให้ยา 4 ครั้งรวมทั้งชุด: ใช้ครั้งละ 1 เม็ด วันละครั้ง เวลา 08:00 ยกเว้นวันจันทร์; ใช้ครั้งละ 1 เม็ด วันละครั้ง เวลา 20:00.); ใช้ครั้งละ 2 เม็ด วันละครั้ง เวลา 12:00 จำนวน 2 ครั้ง."
    };
    for (const input of views(course)) {
      const before = JSON.stringify(input);
      for (const locale of ["en", "th"] as const)
        expect(formatSig(input, "long", { locale, realizationMode: "normalized" })).toBe(expected[locale]);
      const current = importCanonicalCourse(input);
      expect(current.stages[0].administrations[1].schedule?.recurrence?.sharedCount).toBeUndefined();
      expect(current.stages[0].administrations[1].schedule?.recurrence?.count).toBe(2);
      expect(JSON.stringify(input)).toBe(before);
    }
    for (const locale of ["en", "th"] as const) {
      const text = formatSig(am, "long", { locale });
      expect(text).toContain(locale === "en" ? "a total of 4 administrations" : "ให้ยา 4 ครั้งรวมทั้งชุด");
      expect(text).not.toMatch(/20:00|8:00 pm|12:00/u);
    }
  });

  it("distinguishes a shared upper count and a shared daily ceiling without a finite total", () => {
    const upper: CanonicalCourse = { kind: "course", stages: [{ administrations: [member("08:00:00", undefined, 4), member("20:00:00", undefined, 4)] }] };
    const capped: CanonicalCourse = { kind: "course", stages: [{ administrations: ["08:00:00", "20:00:00"].map(clock => ({
      ...member(clock), limits: [{ scope: "period", amount: { value: 1, unit: "tab" },
        period: { value: 1, unit: "d", system: "http://unitsofmeasure.org", code: "d" } }]
    })) }] };
    for (const input of views(upper)) for (const locale of ["en", "th"]) {
      const text = formatSig(input, "long", { locale });
      expect(text.match(/\b4\b/gu)).toHaveLength(1);
      expect(text).toContain(locale === "en" ? "up to 4 administrations" : "ให้ยา ไม่เกิน 4 ครั้งรวมทั้งชุด");
    }
    for (const input of views(capped)) for (const locale of ["en", "th"]) {
      const text = formatSig(input, "long", { locale });
      expect(text).toContain(locale === "en" ? "Schedule sharing its limits:" : "ตารางให้ยาที่ใช้ข้อจำกัดร่วมกัน:");
      expect(text).toContain("max per period: 1 tab / 1 d");
      expect(text).not.toContain("a total of");
      expect(text).not.toContain("รวมทั้งชุด");
    }
  });

  it("keeps full shared facts and cached defaults available to one authoritative callback", () => {
    const input = member("08:00:00", 4), before = JSON.stringify(input);
    for (const locale of ["en", "th"]) {
      let calls = 0;
      const expected = formatSig(input, "long", { locale });
      const text = formatSig(input, "long", { locale, i18n: { inherit: locale, formatLong: context => {
        calls++;
        expect(context.clause.schedule?.sharedCount).toEqual({ groupId: "morning-evening", count: 4 });
        expect(context.defaultText).toBe(expected);
        expect(context.formatDefault("long")).toBe(expected);
        expect(context.formatDefault("short")).toContain("4");
        return "Clinic directions exactly.";
      } } });
      expect(text).toBe("Clinic directions exactly.");
      expect(calls).toBe(1);
    }
    expect(JSON.stringify(input)).toBe(before);
  });

  it("preserves the ordinary independent multi-member output", () => {
    const first: CanonicalAdministration = { kind: "administration", amounts: [{ quantity: { value: 1, unit: "tab" } }],
      schedule: { recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, clocks: ["08:00:00"] } } };
    const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [first, independent()] }] };
    for (const input of views(course))
      expect(formatSig(input, "long", { locale: "en" })).toBe("Use 1 tablet once daily at 8:00 am; Use 2 tablets once daily at 12:00 pm for 2 doses.");
  });
});
