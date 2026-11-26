import { describe, expect, it } from "vitest";
import { formatSig, fromFhirDosage, importCanonicalCourse, nextDueDoses, projectCanonicalCourse, RouteCode } from "../src";
import { parseSig } from "./helpers/r5-parser";
import cases from "./generation-roundtrip-cases.json";
import thaiCases from "./generation-roundtrip-thai-cases.json";
import crossLanguageCases from "./generation-cross-language-cases.json";
import { parseSig as parsePublicSig } from "../src/index";
import { formatSigBatch } from "../src/index";
import { formatParseBatch } from "../src/index";
import { fromFhir } from "../src/index";
import { toDosageDetails } from "../src/index";
import { toFhirR5Dosages } from "../src/index";
import { calculateTotalUnits } from "../src/index";
import { FhirPeriodUnit } from "../src/index";
import { DOSAGE_ALTERNATIVE_CHOICE_URL } from "../src/dosage-course";
import { PARALLEL_COMPONENT_PHASE_ORIGIN_URL } from "../src/dosage-course";
import type { AdviceArgument } from "../src/types";
import type { AdviceFrame } from "../src/types";
import type { CanonicalSigClause } from "../src/types";
import type { FhirR6DosageInstruction } from "../src/types";
import type { FhirR6Extension } from "../src/types";
import { COURSE_CYCLE_COUNT_EXTENSION_URL } from "../src/dosage-course";
import { getCourseCycleCount } from "../src/dosage-course";
import { fromDosageDetails } from "../src/index";
import type { EzDosage } from "../src/index";
import type { FhirDosage } from "../src/index";
import type { FhirExtension } from "../src/index";
import type { FhirElement } from "../src/index";
import type { FhirRatio } from "../src/index";
import type { FhirR6Dosage } from "../src/index";
import { FhirDayOfWeek } from "../src/index";
import { EventTiming } from "../src/index";
import type { FhirR6Quantity } from "../src/index";
import type { FhirR6DosageInstructionInput } from "../src/index";
import type { FhirR6DosageCondition } from "../src/index";
import type { FhirR6Timing } from "../src/index";
import type { FhirR6DosageStep } from "../src/index";
import { registerSigLocalization } from "../src/index";
import { getMedicationInstructionAction } from "../src/index";
import { formatCanonicalCourse } from "../src/index";
import { formatCanonicalAdministration } from "../src/index";
import { buildInstructionGraphExtension } from "../src/index";
import { parseInstructionGraphExtension } from "../src/index";
import { AdviceForce } from "../src/index";
import { AdviceArgumentRole } from "../src/index";
import type { CanonicalInstructionGraph } from "../src/index";
import { DOSAGE_CONDITION_R5_URL } from "../src/dosage-course";
import { DOSAGE_RECONCILIATION_SOURCE_URL } from "../src/dosage-course";
import { DOSAGE_RENDERED_INSTRUCTION_R5_URL } from "../src/dosage-course";
import { DOSAGE_RETAINED_R5_SEQUENCE_URL } from "../src/dosage-course";
import { setDosageCondition } from "../src/dosage-course";
import { getDosageCondition } from "../src/dosage-course";
import { getDosageCalendarDayCondition } from "../src/dosage-course";
import { conditionToR6 } from "../src/dosage-course";
import { toEzDosages } from "../src/dosage-course";
import { isExactConditionBridge } from "../src/dosage-course";
import { DOSAGE_DETAILS_R5_URL } from "../src/dosage-course";
import { decodeR5RetainedFields } from "../src/dosage-course";
import { encodeR5RetainedFields } from "../src/dosage-course";
import { decodeR6SourceMetadata } from "../src/dosage-course";
import { encodeR6SourceMetadata } from "../src/dosage-course";
import { readRetainedField } from "../src/dosage-course";
import { retainField } from "../src/dosage-course";
import { sourceWithoutNestedHistory } from "../src/dosage-course";
import { withDosageEditProvenance } from "../src/dosage-course";
import { isRenderedInstructionMarker } from "../src/dosage-course";
import { setDosageAlternativeChoice } from "../src/dosage-course";
import { DOSAGE_EXCLUDED_DATES_R5_URL } from "../src/dosage-course";
import { DOSAGE_EXCLUDED_WEEKDAYS_R5_URL } from "../src/dosage-course";
import { setDosageExcludedDates } from "../src/dosage-course";
import { getDosageExcludedDates } from "../src/dosage-course";
import { setDosageExcludedWeekdays } from "../src/dosage-course";
import { R5_RATE_MODIFIERS_R6_URL } from "../src/dosage-course";
import { dosageMatchesSavedProjection } from "../src/dosage-course";
import { EMA_QUANTITY_COMPARATOR_EXTENSION_URL } from "../src/fhir-quantity-operator";
import { EMA_QUANTITY_OPERATOR_SYSTEM } from "../src/fhir-quantity-operator";
import { QUANTITY_OPERATOR_SOURCE_URL } from "../src/fhir-quantity-operator";
import { simpleQuantityForR5 } from "../src/fhir-quantity-operator";
import { quantityForR5 } from "../src/fhir-quantity-operator";
import { quantityFromR5 } from "../src/fhir-quantity-operator";
import { getQuantityComparator } from "../src/fhir-quantity-operator";
import { PRN_TRIGGER_PHASE_EXTENSION_URL } from "../src/fhir";
import { TIMING_ADDITIONAL_CLOCK_EXTENSION_URL } from "../src/fhir";
import { TIMING_OFFSET_MIN_EXTENSION_URL } from "../src/fhir";
import { TIMING_OFFSET_MAX_EXTENSION_URL } from "../src/fhir";
import { TIMING_OFFSET_EXACT_EXTENSION_URL } from "../src/fhir";
import { TIMING_FREQUENCY_MIN_EXTENSION_URL } from "../src/fhir";
import { TIMING_DAY_OF_MONTH_EXTENSION_URL } from "../src/fhir";
import { canonicalFromFhir } from "../src/fhir";
import { canonicalToFhir } from "../src/fhir";
import { getAnchoredCourseDuration } from "../src/fhir";
import { TIMING_ACTIVITY_WINDOW_EXTENSION_URL } from "../src/fhir";
import { CYCLE_DAY_ELIGIBILITY_EXTENSION_URL } from "../src/fhir";
import { ANCHORED_COURSE_DURATION_EXTENSION_URL } from "../src/fhir";
import { TIMING_ADMINISTRATION_DURATION_EXTENSION_URL } from "../src/fhir";
import { ADMINISTRATION_OFFSET_EXTENSION_URL } from "../src/fhir";
import { getTimingClocks } from "../src/fhir";
import { courseToR6 } from "../src/adapters/canonical-course";
import { boundaryToWire } from "../src/adapters/canonical-course";
import { R5_SOURCE_ONLY_MAXIMUM_URL } from "../src/adapters/canonical-course";
import { courseFromR5 } from "../src/adapters/r5-import";
import type { SigFormatContext } from "../src/i18n";
import { R6_DRAFT_STEPS_SOURCE_URL } from "../src/adapters/r6-editable-metadata";
import { R6_SINGLE_STEP_SAFETY_SOURCE_URL } from "../src/adapters/r6-editable-metadata";
import { R6_SCOPED_SAFETY_MODIFIER_URL } from "../src/adapters/r6-editable-metadata";
import type { FhirR6DosageSafety } from "../src/types";
import type { FormatOptions } from "../src/types";
import type { FhirR6DoseLimit } from "../src/types";
import type { ParseOptions } from "../src/types";
import retainedCourseProfile from "../fhir/r5/medication-r6-course-details.json";
import { setCourseCycleCount } from "../src/dosage-course";
import { parseInstructionActions } from "../src/index";
import type { FhirR6PrimitiveElement } from "../src/index";
import type { FhirR6Ratio } from "../src/index";
import type { FhirR6SimpleQuantity } from "../src/index";
import type { FhirR6Reference } from "../src/index";
import type { FhirR6DoseAndRate } from "../src/index";
import type { FhirDoseAndRate } from "../src/index";
import type { FhirR6RelativeTime } from "../src/index";
import type { FhirReference } from "../src/index";
import { registerMedicationLocaleDetector } from "../src/index";
import { inferMedicationLocale } from "../src/index";
import { registerMedicationSurfaceSegmenter } from "../src/index";
import { listMedicationSurfaceSegmenters } from "../src/index";
import { registerMedicationDateResolver } from "../src/index";
import { cloneBodySiteSpatialRelation } from "../src/index";
import { buildBodySiteSpatialRelationExtension } from "../src/index";
import { parseBodySiteSpatialRelationExtension } from "../src/index";
import { suggestSig } from "../src/index";
import { AdviceRelation } from "../src/index";
import { DOSAGE_RECONCILIATION_WARNING_URL } from "../src/dosage-course";
import { getDosageSourceTextAgreement } from "../src/dosage-course";
import { dosageProjectionFingerprint } from "../src/dosage-course";
import { R5_EXPRESSION_SLOT_SOURCE_URL } from "../src/dosage-course";
import { fromR6Dosage } from "../src/dosage-course";
import { quantityFromWire } from "../src/fhir-quantity-operator";
import { getEmaQuantityComparator } from "../src/fhir-quantity-operator";
import { parserStateFromFhir } from "../src/fhir";
import { toFhir as parserStateToFhir } from "../src/fhir";
import { getTimingMonthDays } from "../src/fhir";
import { getTimingWeekdayOrdinal } from "../src/fhir";
import { getTimingOccurrenceCap } from "../src/fhir";
import { cycleDayConstraintExtension } from "../src/fhir";
import { getCycleDayConstraint } from "../src/fhir";
import { courseFromR6 } from "../src/adapters/canonical-course";
import { courseToR5 } from "../src/adapters/canonical-course";
import { administrationFromR5 } from "../src/adapters/canonical-course";
import { getPrimitiveTranslation } from "../src/fhir-translations";
import { getPrimitiveTranslations } from "../src/fhir-translations";
import { FHIR_TRANSLATION_EXTENSION_URL } from "../src/fhir-translations";
import { numericAdministrationLimits } from "../src/canonical/course";
import type { CanonicalCourse } from "../src/canonical/course";
import type { EzCourseMetadata } from "../src/types";
import { getSuggestLocaleAdapter } from "../src/suggest-locale-adapter";
import { registerSuggestLocaleAdapter } from "../src/suggest-locale-adapter";

describe("OPD clinician dogfood grammar", () => {
  it.each([
    ["2 drops affected ear bid x5d", "affected ear", RouteCode["Otic route"]],
    ["1 drop affected eye qid", "affected eye", RouteCode["Ophthalmic route"]]
  ] as const)("preserves pathological site modifiers without over-coding: %s", (source, site, route) => {
    const parsed = parseSig(source);
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.fhir.site?.text).toBe(site);
    expect(parsed.fhir.site?.coding).toBeUndefined();
    expect(parsed.fhir.route?.coding?.[0]?.code).toBe(route);
  });

  it("realizes affected eye/ear naturally in Thai without inventing anatomy coding", () => {
    expect(formatSig(parseSig("2 drops affected ear bid").fhir, "long", { locale: "th" }))
      .toContain("หูข้างที่มีอาการ");
    expect(formatSig(parseSig("1 drop affected eye qid").fhir, "long", { locale: "th" }))
      .toContain("ตาข้างที่มีอาการ");
  });

  it("models maximum dose counts without contaminating the PRN reason", () => {
    const parsed = parseSig("1 tab sl q5min prn chest pain max 3 doses");
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0]?.prn?.reason?.text).toBe("chest pain");
    expect(parsed.meta.canonical.clauses[0]?.schedule?.count).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0]?.schedule).toMatchObject({ countMax: 3 });
    expect(parsed.fhir.timing?.repeat?.count).toBeUndefined();
    expect(parsed.fhir.timing?.repeat).toMatchObject({ countMax: 3 });
    expect(parsed.fhir.timing?.repeat?._count).toEqual({ extension: [{
      url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown",
    }] });
    expect(parsed.longText).toContain("for up to 3 doses");
    const persisted = JSON.parse(JSON.stringify(parsed.fhir));
    const reopened = fromFhirDosage(persisted);
    expect(reopened.meta.canonical.clauses[0]?.schedule?.count).toBeUndefined();
    expect(reopened.meta.canonical.clauses[0]?.schedule).toMatchObject({ countMax: 3 });
    const exported = projectCanonicalCourse(importCanonicalCourse([persisted])).fhir[0];
    expect(exported.timing?.repeat?.count).toBeUndefined();
    expect(exported.timing?.repeat?.countMax).toBe(3);
    expect(exported.timing?.repeat?._count).toEqual({ extension: [{
      url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown",
    }] });
  });

  it("uses countMax as the operational schedule cap", () => {
    const dosage = parseSig("1 tab q5min max 3 doses").fhir;
    expect(nextDueDoses(dosage, {
      timeZone: "UTC",
      orderedAt: "2024-01-01T08:00:00Z",
      from: "2024-01-01T08:00:00Z",
      limit: 10
    })).toEqual([
      "2024-01-01T08:00:00+00:00",
      "2024-01-01T08:05:00+00:00",
      "2024-01-01T08:10:00+00:00"
    ]);
  });

  it.each([
    ["1 drop od q2h while awake", "while awake", "ขณะตื่น"],
    ["1 drop od q2h while awake only", "while awake only", "เฉพาะขณะตื่น"],
    ["1 drop od q2h ขณะตื่น", "while awake", "ขณะตื่น"],
    ["1 drop od q2h เฉพาะขณะตื่น", "while awake only", "เฉพาะขณะตื่น"]
  ] as const)("preserves awake-window qualifiers without pretending they are WAKE events: %s", (source, text, thai) => {
    const parsed = parseSig(source);
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.fhir.timing?.repeat?.when).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0]?.schedule?.eventWindow)
      .toEqual({ start: "WAKE", end: "HS" });
    expect(parsed.fhir.timing?.repeat?.extension).toContainEqual(
      expect.objectContaining({
        url: expect.stringContaining("urn:ezmedicationinput:StructureDefinition:medication-timing-event-window"),
        extension: [
          { url: "start", valueCode: "WAKE" },
          { url: "end", valueCode: "HS" }
        ]
      })
    );
    expect(parsed.meta.canonical.clauses[0]?.additionalInstructions).toContainEqual(
      expect.objectContaining({ text })
    );
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).toContain(thai);
  });

  it("keeps trailing cadence outside procedural action arguments", () => {
    const parsed = parseSig("gargle 10 mL then spit tid");
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0]?.schedule).toMatchObject({
      frequency: 3,
      period: 1,
      periodUnit: "d"
    });
    const spit = parsed.meta.canonical.clauses[0]?.instructionGraph?.actions?.find(
      (action) => action.predicate.lemma === "spit"
    );
    expect(spit).toBeDefined();
    expect(spit?.args).toEqual([]);
  });

  it.each([
    ["wait 5 minutes between eye drops", "Wait 5 minutes between eye drops.", "รอ 5 นาที ระหว่างการหยอดตา."],
    ["รอ 5 นาที ระหว่างยาหยอดตา", "Wait 5 minutes between eye drops.", "รอ 5 นาที ระหว่างการหยอดตา."]
  ] as const)("types between-dose waiting intervals: %s", (source, english, thai) => {
    const parsed = parseSig(source);
    expect(parsed.meta.leftoverText).toBeUndefined();
    const wait = parsed.meta.canonical.clauses[0]?.instructionGraph?.actions?.find(
      (action) => action.predicate.lemma === "wait"
    );
    expect(wait?.relation).toBe("between");
    expect(wait?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "duration", quantity: { value: 5, unit: "min" } }),
      expect.objectContaining({ role: "activity", conceptId: "eye_drop_administration" })
    ]));
    expect(parsed.longText).toBe(english);
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).toBe(thai);
  });

  it.each([
    ["chew 1 tab before swallowing", "Chew 1 tablet before swallowing.", "เคี้ยว 1 เม็ดก่อนกลืน."],
    ["เคี้ยว 1 เม็ด ก่อนกลืน", "Chew 1 tablet before swallow.", "เคี้ยว 1 เม็ดก่อนกลืน."]
  ] as const)("preserves chew-before-swallow workflow semantics: %s", (source, english, thai) => {
    const parsed = parseSig(source);
    expect(parsed.meta.leftoverText).toBeUndefined();
    const chew = parsed.meta.canonical.clauses[0]?.instructionGraph?.actions?.find(
      (action) => action.predicate.lemma === "chew"
    );
    expect(chew?.relation).toBe("before");
    expect(chew?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "activity" })
    ]));
    expect(parsed.longText).toBe(english);
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).toBe(thai);
  });

  it.each([
    ["inhale 2 puffs before exercise", "ก่อนออกกำลังกาย"],
    ["สูด 2 พัฟ ก่อนออกกำลังกาย", "ก่อนออกกำลังกาย"]
  ] as const)("preserves pre-exercise inhaler windows without inventing a FHIR event: %s", (source, thai) => {
    const parsed = parseSig(source);
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.fhir.route?.coding?.[0]?.code).toBe(RouteCode["Respiratory tract route (qualifier value)"]);
    expect(parsed.fhir.timing?.repeat?.when).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0]?.schedule?.activityTiming).toContainEqual(
      expect.objectContaining({
        relation: "before",
        activity: expect.objectContaining({ text: "exercise" })
      })
    );
    expect(parsed.fhir.timing?.repeat?.extension).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: "urn:ezmedicationinput:StructureDefinition:medication-timing-activity-window"
      })
    ]));
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).toContain(thai);
  });

  it("keeps mouth-rinse amount, contact time, and trailing cadence in their own semantic slots", () => {
    const parsed = parseSig("rinse mouth with 10 mL for 30 seconds then spit, bid");
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0]?.dose).toMatchObject({ value: 10, unit: "mL" });
    expect(parsed.meta.canonical.clauses[0]?.schedule).toMatchObject({ frequency: 2, period: 1, periodUnit: "d" });
    const rinse = parsed.meta.canonical.clauses[0]?.instructionGraph?.actions?.find(
      (action) => action.predicate.lemma === "rinse_mouth"
    );
    expect(rinse?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "amount", quantity: { value: 10, unit: "mL" } }),
      expect.objectContaining({ role: "duration", quantity: { value: 30, unit: "s" } })
    ]));
    const spit = parsed.meta.canonical.clauses[0]?.instructionGraph?.actions?.find(
      (action) => action.predicate.lemma === "spit"
    );
    expect(spit).toBeDefined();
    expect(spit?.args).toEqual([]);
  });

  it("recognizes now as immediate event timing", () => {
    const parsed = parseSig("take 1 tab now");
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.fhir.timing?.repeat?.when).toEqual(["IMD"]);
  });

  it.each([
    [
      "take 1 tab now then repeat 1 tab after 2 hours if migraine persists",
      "Take 1 tablet orally immediately; then repeat 1 tablet after 2 hours if migraine persists.",
      "ถ้ายังมีอาการไมเกรน"
    ],
    [
      "กิน 1 เม็ดทันที แล้วกินซ้ำหลัง 2 ชั่วโมงถ้ายังปวดไมเกรน",
      "Take 1 tablet orally immediately; then repeat after 2 hours if migraine persists.",
      "ถ้ายังปวดไมเกรน"
    ]
  ] as const)("models dependent repeat timing and condition separately: %s", (source, english, thaiCondition) => {
    const parsed = parseSig(source);
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0]?.schedule?.when).toEqual(["IMD"]);
    const repeat = parsed.meta.canonical.clauses[0]?.instructionGraph?.actions?.find(
      (action) => action.predicate.lemma === "repeat"
    );
    expect(repeat?.relation).toBe("after");
    expect(repeat?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "duration", quantity: { value: 2, unit: "h" } })
    ]));
    expect(parsed.meta.canonical.clauses[0]?.instructionGraph?.relations).toContainEqual(
      expect.objectContaining({
        kind: "if",
        toActionIndex: repeat?.sequenceIndex
      })
    );
    expect(formatSig(parsed.fhir, "long", { locale: "en" })).toBe(english);
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).toContain(thaiCondition);
  });

  it("does not duplicate an amount already contained in a procedural object", () => {
    const parsed = parseSig("dissolve 1 tab under tongue prn chest pain");
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0]?.prn?.reason?.text).toBe("chest pain");
    expect(parsed.longText).toBe("Dissolve 1 tab under tongue as needed for chest pain.");
    expect(parsed.longText.match(/\b1 tab(?:let)?\b/gi)).toHaveLength(1);
  });

  it.each([
    ["remain upright 30 minutes", 30, "min"],
    ["stay upright half an hour", 0.5, "h"],
    ["sit upright half a day", 0.5, "d"],
    ["นั่งตัวตรงครึ่งชั่วโมง", 0.5, "h"]
  ] as const)("types upright-duration advice compositionally: %s", (source, value, unit) => {
    const parsed = parseSig(source);
    expect(parsed.meta.leftoverText).toBeUndefined();
    const action = parsed.meta.canonical.clauses[0]?.instructionGraph?.actions?.[0];
    expect(action?.predicate.lemma).toBe("remain-upright");
    expect(action?.args?.find((arg) => arg.role === "duration")?.quantity).toEqual({ value, unit });
  });
});


{

const parseSig = parsePublicSig;
const persist = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const q = (value: number) => ({ value, unit: "tab" });
const expression = (name: string) => ({ language: "text/fhirpath", expression: "%" + name });
const course = (component: Partial<FhirR6Dosage> = {}): FhirR6DosageInstruction => ({
  step: [{ component: [{ doseAndRate: [{ doseQuantity: q(1) }], ...component }] }],
});
const r6Save = (value: FhirR6DosageInstruction): FhirR6DosageInstruction => {
  return projectCanonicalCourse(importCanonicalCourse(persist(value))).fhirNext;
};



describe("round25 strict wire and retained source boundaries", () => {
  it("keeps an evaluated cap unchanged beside source-only incomplete maxima", () => {
    const cap = { numerator: q(1), denominator: { value: 1, unit: "d" } };
    const incomplete = { id: "pending-cap", numerator: q(5),
      extension: [{ url: "urn:test:pending-cap", valueString: "denominator not supplied" }] };
    const make = (maxima: FhirRatio[]): FhirDosage => ({
      doseAndRate: [{ doseQuantity: q(1) }], maxDosePerPeriod: maxima,
      timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["08:00:00", "20:00:00"] } },
    });
    const options = { from: "2026-01-01T00:00:00Z", orderedAt: "2026-01-01T00:00:00Z",
      timeZone: "UTC", durationValue: 2, durationUnit: FhirPeriodUnit.Day };
    for (const row of [make([cap]), make([cap, incomplete])]) {
      const saved = toDosageDetails(persist(toFhirR5Dosages([row])));
      const actual = calculateTotalUnits({ ...options, dosage: saved });
      expect(actual).toMatchObject({ totalUnits: 2, quantityKind: "maximum" });
      expect(actual.explanation).not.toContain("could not be applied");
      expect(importCanonicalCourse(saved).stages[0].administrations[0].limits).toHaveLength(1);
    }
    const unsupported = calculateTotalUnits({ ...options, dosage: toDosageDetails([make([
      cap, { numerator: q(5), denominator: { value: 1, unit: "unresolved-period" } },
    ])]) });
    expect(unsupported).toMatchObject({ totalUnits: 2, quantityKind: "maximum" });
    expect(unsupported.explanation).toContain("could not be applied");
  });

  it("keeps an annotated step modifier wrapper around the current editable children", () => {
    const url = "urn:ezmedicationinput:StructureDefinition:r5-step-modifier-extensions";
    const original = { id: "step-wrapper", url, extension: [{ url: "urn:test:step-modifier", valueString: "old" }] };
    const input = course(); input.step![0].extension = [original];
    const edit = persist(fromDosageDetails(input));
    expect(toDosageDetails(edit.dosages, undefined, edit.course).step![0].extension).toEqual([original]);
    edit.course.step![0].modifierExtension = [{ url: "urn:test:step-modifier", valueString: "current" }];
    let output = toDosageDetails(edit.dosages, undefined, edit.course);
    const expected = { ...original, extension: [{ url: "urn:test:step-modifier", valueString: "current" }] };
    for (let save = 0; save < 3; save++) {
      expect(output.step![0].extension?.filter(value => value.url === url)).toEqual([expected]);
      output = toDosageDetails(persist(toFhirR5Dosages(output)));
    }
    const clear = persist(fromDosageDetails(output));
    clear.course.step![0].modifierExtension = [];
    const cleared = toDosageDetails(clear.dosages, undefined, clear.course);
    expect(cleared.step![0].extension?.some(value => value.url === url)).not.toBe(true);
    expect(JSON.stringify(cleared.step![0].extension)).toContain('"id":"step-wrapper"');
  });

  it.each(["administration", "lifetime"] as const)("deletes only the projected %s cap and reopens the surviving sibling", scope => {
    const first = { id: "first-cap", scope, valueQuantity: q(4) };
    const second = { id: "second-cap", scope, valueQuantity: q(6) };
    const rows = persist(toFhirR5Dosages(course({ safety: { doseLimit: [first, second] } })));
    const field = scope === "administration" ? "maxDosePerAdministration" : "maxDosePerLifetime";
    expect(rows[0][field]?.value).toBe(4);
    delete rows[0][field];
    let output = toDosageDetails(rows);
    for (let save = 0; save <= 3; save++) {
      expect(output.step![0].component[0].safety?.doseLimit).toEqual([second]);
      const reopened = persist(toFhirR5Dosages(output));
      expect(reopened[0][field]).toEqual(q(6));
      output = toDosageDetails(reopened);
    }
  });

  it("retires an annotated rendered baseline exactly once when refreshing source authority", () => {
    let rows = withDosageEditProvenance<FhirDosage>([{ text: "one tablet", doseAndRate: [{ doseQuantity: q(1) }] }], "old wording");
    const original = rows[0].extension!.find(isRenderedInstructionMarker)!;
    original.id = "external-baseline";
    original.extension!.push({ url: "urn:test:baseline-annotation", valueString: "keep complete annotation" });
    const saved = persist(original);
    rows = withDosageEditProvenance(persist(rows), "current wording");
    for (let refresh = 0; refresh < 3; refresh++) {
      const active = rows[0].extension!.filter(isRenderedInstructionMarker);
      expect(active).toHaveLength(1);
      expect(active[0].extension).toContainEqual({ url: "instruction", valueString: "current wording" });
      expect(rows[0].extension!.filter(value => value.url === DOSAGE_RECONCILIATION_SOURCE_URL))
        .toEqual([{ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [saved] }]);
      rows = withDosageEditProvenance(persist(rows), "current wording");
    }
  });

  it("keeps a shared legacy site source inert when two edited live rows claim it", () => {
    const concept = { text: "left eye" };
    const marker: FhirExtension = { url: DOSAGE_DETAILS_R5_URL, extension: [{
      url: "dosageDetails", extension: [{ url: "step", extension: [{ url: "component", extension: [
        { url: "site", valueCodeableReference: { concept, reference: { reference: "BodyStructure/original-eye" } } },
        { url: "condition", extension: [{ url: "code", valueCodeableConcept: { text: "authored condition" } }] },
        { url: "doseAndRate", extension: [{ url: "doseQuantity", valueQuantity: q(1) }] },
      ] }] }],
    }] };
    const rows: FhirDosage[] = [9, 3].map(value => ({ sequence: 1, site: concept,
      doseAndRate: [{ doseQuantity: q(value) }], modifierExtension: [marker] }));
    const output = toDosageDetails(persist(rows));
    expect(output.step![0].component.map(row => row.doseAndRate![0].doseQuantity!.value)).toEqual([9, 3]);
    for (const row of output.step![0].component) {
      expect(row.site).toEqual({ concept });
      expect(row.condition).toBeUndefined();
    }
    expect(output.extension?.filter(value => value.url === DOSAGE_RECONCILIATION_SOURCE_URL)
      .some(value => value.extension?.some(source => JSON.stringify(source) === JSON.stringify(marker)))).toBe(true);
  });

  it.each([true, false])("keeps comparator primitive metadata off strict SimpleQuantity (code present %s)", withCode => {
    const metadata = { id: "comparator-primitive", extension: [{ url: "urn:test:operator-note", valueString: "retain" }] };
    const amount: FhirR6Quantity = { value: 100, unit: "mg", _comparator: metadata,
      ...(withCode ? { comparator: "<" } : {}) };
    const input = course({ safety: { doseLimit: [{ scope: "administration", valueQuantity: amount }] } });
    let output = input;
    for (let save = 0; save < 3; save++) {
      const rows = persist(toFhirR5Dosages(output));
      const strict = rows[0].maxDosePerAdministration!;
      expect(Object.prototype.hasOwnProperty.call(strict, "comparator")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(strict, "_comparator")).toBe(false);
      expect(getQuantityComparator(strict)).toBe(withCode ? "<" : undefined);
      expect(strict.extension).toContainEqual({
        url: "urn:ezmedicationinput:StructureDefinition:quantity-operator-source",
        ...(withCode ? { valueCode: "<" } : {}), _valueCode: metadata,
      });
      output = toDosageDetails(rows);
      expect(JSON.stringify(output)).toContain('"id":"comparator-primitive"');
      expect(JSON.stringify(output)).toContain('"valueString":"retain"');
    }
  });
});


describe("round25 duration Range units retain their authored meaning", () => {
  const source = (low = { value: 48, unit: "hours", code: "h" }, high = { value: 3, unit: "days", code: "d" }): FhirDosage => ({
    doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: {
      frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["00:30:00"],
      boundsRange: { low: { ...low, system: "http://unitsofmeasure.org" }, high: { ...high, system: "http://unitsofmeasure.org" } },
    } },
  });
  const authored = (row: FhirDosage) => {
    expect(canonicalFromFhir(row).schedule).toMatchObject({
      duration: 48, durationUnit: FhirPeriodUnit.Hour, durationMax: 3, durationMaxUnit: FhirPeriodUnit.Day,
    });
    expect(importCanonicalCourse(row).stages[0].administrations[0].schedule?.recurrence?.courseLengthRange)
      .toMatchObject({ low: { value: 48, code: "h" }, high: { value: 3, code: "d" } });
  };
  it("keeps authored elapsed lower and calendar upper endpoints through R5/R6 saves across DST", () => {
    let row = persist(canonicalToFhir(canonicalFromFhir(source())));
    const options = { from: "2026-03-07T00:00:00-05:00", orderedAt: "2026-03-07T00:00:00-05:00",
      timeZone: "America/New_York", limit: 10 };
    const expected = ["2026-03-07T00:30:00-05:00", "2026-03-08T00:30:00-05:00", "2026-03-09T00:30:00-04:00"];
    for (let save = 0; save < 3; save++) {
      const range = row.timing!.repeat!.boundsRange!;
      expect(range.low).toMatchObject({ value: 48, unit: "hours", code: "h" });
      expect(range.high).toMatchObject({ value: 3, unit: "days", code: "d" });
      expect(range.low?.system).toBe(range.high?.system);
      authored(row);
      expect(nextDueDoses(row, options)).toEqual(expected);
      const r6 = toDosageDetails([row]);
      expect(r6.step![0].component[0].timing!.repeat!.boundsRange).toEqual(range);
      expect(nextDueDoses(r6, options)).toEqual(expected);
      row = persist(toFhirR5Dosages(r6)[0]);
    }
    row.timing!.repeat!.boundsRange!.high!.value = 4;
    expect(canonicalFromFhir(row).schedule).toMatchObject({
      duration: 48, durationUnit: FhirPeriodUnit.Hour, durationMax: 4, durationMaxUnit: FhirPeriodUnit.Day,
    });
    const changed = toDosageDetails([row]);
    expect(nextDueDoses(changed, options)).toEqual([...expected, "2026-03-10T00:30:00-04:00"]);
    expect(changed.step![0].component[0].modifierExtension?.some(value =>
      value.url === "urn:ezmedicationinput:StructureDefinition:medication-anchored-course-duration")).toBeFalsy();
    expect(JSON.stringify(changed)).toContain('"value":48');
  });
  it("keeps both authored units in the typed anchored-duration range", () => {
    const clause = canonicalFromFhir(source());
    clause.schedule!.boundsStart = "2026-03-07T00:00:00-05:00";
    const row = persist(canonicalToFhir(clause));
    expect(row.timing!.repeat!.boundsPeriod?.start).toBe("2026-03-07T00:00:00-05:00");
    expect(row.timing!.repeat!.boundsRange).toBeUndefined();
    const marker = row.modifierExtension!.find(value =>
      value.url === "urn:ezmedicationinput:StructureDefinition:medication-anchored-course-duration")!;
    expect(marker.valueRange).toEqual({
      low: { value: 48, unit: "hours", system: "http://unitsofmeasure.org", code: "h" },
      high: { value: 3, unit: "days", system: "http://unitsofmeasure.org", code: "d" },
    });
    const restored = canonicalFromFhir(persist(toFhirR5Dosages(toDosageDetails([row]))[0]));
    expect(restored.schedule).toMatchObject({ duration: 48, durationUnit: FhirPeriodUnit.Hour,
      durationMax: 3, durationMaxUnit: FhirPeriodUnit.Day });
  });
  it("retains month/day endpoints without an average month conversion or fabricated upper bound", () => {
    const row = persist(canonicalToFhir(canonicalFromFhir(source(
      { value: 1, unit: "month", code: "mo" }, { value: 40, unit: "days", code: "d" },
    ))));
    expect(row.timing!.repeat!.boundsRange?.low).toMatchObject({ value: 1, unit: "month", code: "mo" });
    expect(row.timing!.repeat!.boundsRange?.high).toMatchObject({ value: 40, code: "d" });
    const reopened = persist(toFhirR5Dosages(toDosageDetails([row]))[0]);
    expect(canonicalFromFhir(reopened).schedule).toMatchObject({
      duration: 1, durationUnit: FhirPeriodUnit.Month, durationMax: 40, durationMaxUnit: FhirPeriodUnit.Day,
    });
  });
  it("uses one display unit for same-unit endpoints while retaining both qualifiers", () => {
    const input = source({ value: 1, unit: "day", code: "d" }, { value: 3, unit: "days", code: "d" });
    input.timing!.repeat!.boundsRange!.low = simpleQuantityForR5({
      ...input.timing!.repeat!.boundsRange!.low, comparator: ">=" });
    input.timing!.repeat!.boundsRange!.high = simpleQuantityForR5({
      ...input.timing!.repeat!.boundsRange!.high, comparator: "<=" });
    const row = persist(canonicalToFhir(canonicalFromFhir(input)));
    const range = row.timing!.repeat!.boundsRange!;
    expect(range.low).toMatchObject({ value: 1, unit: "day", code: "d" });
    expect(range.high).toMatchObject({ value: 3, unit: "days", code: "d" });
    expect(getQuantityComparator(range.low)).toBe(">=");
    expect(getQuantityComparator(range.high)).toBe("<=");
    expect(canonicalFromFhir(row).schedule).toMatchObject({ duration: 1, durationMax: 3,
      durationUnit: FhirPeriodUnit.Day, durationMaxUnit: FhirPeriodUnit.Day,
      durationComparator: ">=", durationMaxComparator: "<=" });
  });
});


describe("round26 independent duration edits and cleared conditions", () => {
  const ucum = "http://unitsofmeasure.org";
  const durationUrl = "urn:ezmedicationinput:StructureDefinition:medication-anchored-course-duration";
  const durationRow = (low = { value: 48, unit: "hours", code: "h" }, high = { value: 3, unit: "days", code: "d" }): FhirDosage => ({
    doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: {
      frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
      boundsRange: { low: { ...low, system: ucum }, high: { ...high, system: ucum } },
    } },
  });

  it("retains the authored lower duration when only the upper month bound changes", () => {
    let row = persist(canonicalToFhir(canonicalFromFhir(durationRow(
      { value: 3, unit: "weeks", code: "wk" }, { value: 1, unit: "month", code: "mo" },
    ))));
    expect(row.timing!.repeat!.boundsRange!.low).toMatchObject({ value: 3, unit: "weeks", code: "wk" });
    row.timing!.repeat!.boundsRange!.high!.value = 2;
    for (let save = 0; save < 3; save++) {
      expect(canonicalFromFhir(row).schedule).toMatchObject({ duration: 3,
        durationUnit: FhirPeriodUnit.Week, durationMax: 2, durationMaxUnit: FhirPeriodUnit.Month });
      const native = importCanonicalCourse(row);
      expect(native.stages[0].administrations[0].schedule?.recurrence?.courseLengthRange)
        .toMatchObject({ low: { value: 3, code: "wk" }, high: { value: 2, code: "mo" } });
      row = persist(toFhirR5Dosages(projectCanonicalCourse(native).fhirNext)[0]);
    }
  });

  it("reads a persisted earlier valueRange projection baseline endpoint by endpoint", () => {
    const low = { value: 48, unit: "hours", system: ucum, code: "h" };
    const high = { value: 3, unit: "days", system: ucum, code: "d" };
    const row: FhirDosage = { timing: { repeat: { boundsRange: {
      low: { value: 2, unit: "days", system: ucum, code: "d" }, high: { ...high, value: 4 },
    } } }, modifierExtension: [{ url: durationUrl, extension: [
      { url: "low", valueQuantity: low }, { url: "high", valueQuantity: high },
      { url: "projectedRange", valueRange: {
        low: { value: 2, unit: "days", system: ucum, code: "d" }, high,
      } },
    ] }] };
    expect(canonicalFromFhir(row).schedule).toMatchObject({ duration: 48, durationUnit: FhirPeriodUnit.Hour,
      durationMax: 4, durationMaxUnit: FhirPeriodUnit.Day });
  });

  it.each(["clause", "r5", "r6"] as const)("reads a live duration endpoint edit after a structured copy of %s output", route => {
    const original = durationRow();
    const projected = route === "clause" ? canonicalToFhir(canonicalFromFhir(original))
      : route === "r5" ? toFhirR5Dosages([original])[0] : toDosageDetails([original]).step![0].component[0];
    const row = structuredClone(projected);
    expect(canonicalFromFhir(row as FhirDosage).schedule).toMatchObject({ duration: 48, durationUnit: FhirPeriodUnit.Hour });
    row.timing!.repeat!.boundsRange!.low!.value = 60;
    expect(canonicalFromFhir(row as FhirDosage).schedule).toMatchObject({ duration: 60,
      durationUnit: FhirPeriodUnit.Hour, durationMax: 3, durationMaxUnit: FhirPeriodUnit.Day });
    expect(importCanonicalCourse(row as FhirDosage).stages[0].administrations[0].schedule?.recurrence?.courseLengthRange)
      .toMatchObject({ low: { value: 60, code: "h" }, high: { value: 3, code: "d" } });
  });

  it("observes a nested duration qualifier edit while preserving its authored elapsed unit", () => {
    const original = durationRow();
    original.timing!.repeat!.boundsRange!.low = simpleQuantityForR5({
      ...original.timing!.repeat!.boundsRange!.low, comparator: ">=" });
    const row = structuredClone(canonicalToFhir(canonicalFromFhir(original)));
    const operator = row.timing!.repeat!.boundsRange!.low!.extension!.find(e => e.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL)!;
    operator.valueCoding!.code = "100000000050";
    expect(canonicalFromFhir(row).schedule).toMatchObject({ duration: 48,
      durationUnit: FhirPeriodUnit.Hour, durationComparator: "<", durationMax: 3 });
  });

  it("does not restore an explicitly removed projected duration endpoint", () => {
    let row = persist(canonicalToFhir(canonicalFromFhir(durationRow())));
    delete row.timing!.repeat!.boundsRange!.low;
    for (let save = 0; save < 3; save++) {
      const schedule = canonicalFromFhir(row).schedule!;
      expect(schedule.duration).toBeUndefined();
      expect(schedule).toMatchObject({ durationMax: 3, durationMaxUnit: FhirPeriodUnit.Day });
      row = persist(toFhirR5Dosages(toDosageDetails([row]))[0]);
      expect(row.timing!.repeat!.boundsRange!.low).toBeUndefined();
    }
  });

  it.each(["range", "quantity"] as const)("uses a replacement %s after absolute bounds without restoring the anchored source", choice => {
    const clause = canonicalFromFhir(durationRow());
    clause.schedule!.boundsStart = "2026-11-20T09:00:00Z";
    let row = persist(canonicalToFhir(clause));
    expect(canonicalFromFhir(row).schedule).toMatchObject({ duration: 48, durationUnit: FhirPeriodUnit.Hour });
    delete row.timing!.repeat!.boundsPeriod;
    if (choice === "range") row.timing!.repeat!.boundsRange = {
      low: { value: 5, unit: "days", code: "d" }, high: { value: 7, unit: "days", code: "d" },
    };
    else row.timing!.repeat!.boundsDuration = { value: 5, unit: "days", code: "d" };
    for (let save = 0; save < 3; save++) {
      expect(canonicalFromFhir(row).schedule).toMatchObject({ duration: 5, durationUnit: FhirPeriodUnit.Day });
      expect(canonicalFromFhir(row).schedule!.durationMax).toBe(choice === "range" ? 7 : undefined);
      const native = importCanonicalCourse(row);
      expect(native.stages[0].administrations[0].anchoredLength).toBeUndefined();
      row = persist(toFhirR5Dosages(projectCanonicalCourse(native).fhirNext)[0]);
      expect(row.modifierExtension?.some(e => e.url === durationUrl)).not.toBe(true);
      expect(JSON.stringify(row)).toContain('"value":48');
    }
  });

  it.each([
    [false, false, false], [false, false, true], [false, true, false], [false, true, true],
    [true, false, false], [true, false, true], [true, true, false], [true, true, true],
  ])(
    "keeps a cleared external R6 condition inactive (calendar %s, via R5 %s, delete %s)", (calendar, viaR5, remove) => {
    const raw: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }] };
    const predicate = { kind: "measurement" as const, name: "systolic blood pressure", operation: "gt" as const,
      value: 140, unit: "mmHg", text: "systolic blood pressure above 140 mmHg" };
    setDosageCondition(raw, predicate, calendar ? predicate : undefined);
    raw.modifierExtension![0].id = "authored-condition";
    const marker = persist(raw.modifierExtension![0]);
    let wire = toDosageDetails([raw]);
    expect(importCanonicalCourse(wire).stages[0].administrations[0].predicate).toEqual(predicate);
    if (remove) delete wire.step![0].component[0].condition;
    else wire.step![0].component[0].condition = [];
    if (viaR5) wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
    for (let save = 0; save < 3; save++) {
      const native = importCanonicalCourse(persist(wire));
      expect(native.stages[0].administrations[0].predicate).toBeUndefined();
      expect(native.stages[0].administrations[0].calendarPredicate).toBeUndefined();
      wire = projectCanonicalCourse(native).fhirNext;
      expect(wire.step![0].component[0].modifierExtension?.some(e => e.url === DOSAGE_CONDITION_R5_URL)).not.toBe(true);
      expect(wire.step![0].component[0].extension).toContainEqual({
        url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [marker],
      });
    }
  });

  it("accepts annotated R6 condition periods and preserves their Element and primitive metadata", () => {
    const input: FhirR6DosageInstruction = { step: [{ component: [{ condition: [{ code: { text: "eligibility window" },
      valuePeriod: { id: "eligibility-window", extension: [{ url: "urn:test:period-note", valueString: "retain" }],
        start: "2026-11-01", _start: { id: "authored-start" }, end: "2026-12-01", _end: { id: "authored-end" } },
    }] }] }] };
    let output = input;
    for (let save = 0; save < 3; save++) {
      output = r6Save(output);
      expect(output.step![0].component[0].condition).toEqual(input.step![0].component[0].condition);
    }
  });
});


describe("round26 symbolic member origins across wire boundaries", () => {
  it.each([[false, false], [true, false], [false, true], [true, true]])(
    "retains each typed event origin and annotations (via R5 %s, approximate offset %s)", (viaR5, approximate) => {
    const offset = quantityForR5({ value: 2, unit: "days", code: "d",
      ...(approximate ? { comparator: "~" as const } : {}) })!;
    const marker: FhirExtension = { id: "member-origin", url: PARALLEL_COMPONENT_PHASE_ORIGIN_URL, extension: [
      { id: "origin-start-wrapper", url: "start", extension: [
        { url: "id", valueString: "authored-relative-start" },
        { url: "contextCode", valueCodeableConcept: { text: "follow-up visit" } },
        { url: "offsetDuration", valueQuantity: offset },
        { url: "text", valueString: "After the follow-up visit" },
        { url: "extension", extension: [{ url: "urn:test:origin-annotation", valueString: "retain boundary metadata" }] },
      ] },
      { url: "urn:test:future-origin-field", valueString: "retain wrapper child" },
    ] };
    let wire = course({ modifierExtension: [marker] });
    for (let save = 0; save < 3; save++) {
      const native = importCanonicalCourse(viaR5 ? persist(toFhirR5Dosages(wire)) : persist(wire));
      const member = native.stages[0].administrations[0];
      expect(member.phaseOrigin).toBeUndefined();
      expect(member.phaseOriginIssue).toBe(false);
      expect(member.phaseStart).toMatchObject({ anchor: "coded-event", contextCode: { text: "follow-up visit" },
        description: "After the follow-up visit", displacement: { value: 2, code: "d" } });
      expect(member.phaseStart!.displacement!.comparator).toBe(approximate ? "~" : undefined);
      wire = projectCanonicalCourse(native).fhirNext;
      expect(wire.step![0].component[0].modifierExtension).toContainEqual(marker);
      expect(wire.step![0].component[0].modifierExtension!.find(e => e.url === PARALLEL_COMPONENT_PHASE_ORIGIN_URL)!.valueQuantity)
        .toBeUndefined();
    }
    const current = wire.step![0].component[0].modifierExtension!.find(e => e.url === PARALLEL_COMPONENT_PHASE_ORIGIN_URL)!;
    const start = current.extension!.find(e => e.url === "start")!.extension!;
    start.find(e => e.url === "offsetDuration")!.valueQuantity!.value = 3;
    start.find(e => e.url === "contextCode")!.valueCodeableConcept!.text = "laboratory review";
    const edited = importCanonicalCourse(viaR5 ? persist(toFhirR5Dosages(wire)) : persist(wire));
    expect(edited.stages[0].administrations[0].phaseStart).toMatchObject({ anchor: "coded-event",
      contextCode: { text: "laboratory review" }, displacement: { value: 3, code: "d" } });
    expect(projectCanonicalCourse(edited).fhirNext.step![0].component[0].modifierExtension).toContainEqual(current);
  });
});


describe("round27 calendar marker preservation", () => {
  const date = { id: "date-child", url: "date", valueDate: "2026-11-27",
    _valueDate: { id: "date-primitive" } };
  const day = { id: "day-child", url: "day", valueCode: "fri",
    _valueCode: { id: "day-primitive" } };
  const annotation = { url: "https://example.org/calendar-note", valueString: "authored calendar policy" };
  const dates: FhirExtension = { id: "date-marker", url: DOSAGE_EXCLUDED_DATES_R5_URL,
    extension: [date, annotation] };
  const days: FhirExtension = { id: "day-marker", url: DOSAGE_EXCLUDED_WEEKDAYS_R5_URL,
    extension: [day, annotation] };

  it.each(["r5", "r6"] as const)("keeps unchanged %s marker and primitive annotations across saves", version => {
    let current = course({ extension: [persist(days)], modifierExtension: [persist(dates)] });
    for (let save = 0; save < 3; save++) {
      current = version === "r5" ? toDosageDetails(persist(toFhirR5Dosages(current))) : r6Save(current);
      const component = current.step![0].component[0];
      expect(component.extension).toContainEqual(days);
      expect(component.modifierExtension).toContainEqual(dates);
    }
  });

  it("changes only owned calendar values and retires cleared annotated markers", () => {
    const row: FhirDosage = { extension: [persist(days)], modifierExtension: [persist(dates)] };
    setDosageExcludedDates(row, ["2026-11-27", "2026-11-28"]);
    setDosageExcludedWeekdays(row, [FhirDayOfWeek.Friday, FhirDayOfWeek.Saturday]);
    expect(row.modifierExtension).toContainEqual({ ...dates,
      extension: [date, annotation, { url: "date", valueDate: "2026-11-28" }] });
    expect(row.extension).toContainEqual({ ...days,
      extension: [day, annotation, { url: "day", valueCode: "sat" }] });
    setDosageExcludedDates(row, []);
    setDosageExcludedWeekdays(row, []);
    expect(row.modifierExtension?.some(item => item.url === DOSAGE_EXCLUDED_DATES_R5_URL)).toBeFalsy();
    expect(row.extension?.some(item => item.url === DOSAGE_EXCLUDED_WEEKDAYS_R5_URL)).toBeFalsy();
    const history = row.extension?.filter(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL);
    expect(JSON.stringify(history)).toContain("date-marker");
    expect(JSON.stringify(history)).toContain("day-marker");
    expect(JSON.stringify(history)).toContain("authored calendar policy");
  });
});


describe("round27 current external interchange facts", () => {
  it("keeps a surviving row's missing shared repeat context through repeated R5 saves", () => {
    const repeat = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] };
    const raw: FhirR6DosageInstruction = { repeatCycle: { value: 7, unit: "d", code: "d" }, step: [{
      end: { contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] },
        offsetDuration: { value: 2, unit: "d", code: "d" } },
      component: [{ doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat } },
        { text: "Take 2 tablets every morning", doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat } }],
    }] };
    const options = { from: "2026-11-21T00:00:00Z", orderedAt: "2026-11-21T00:00:00Z", timeZone: "UTC", limit: 2 };
    const complete = persist(toFhirR5Dosages(raw));
    expect(nextDueDoses(complete, options)).toHaveLength(2);
    expect(importCanonicalCourse(complete).stages[0].administrations.every(a => !a.missingContexts?.length)).toBe(true);
    let rows = complete.slice(1);
    const missing = importCanonicalCourse(rows).stages[0].administrations[0].missingContexts;
    expect(missing?.length).toBeGreaterThan(0);
    for (let save = 0; save < 3; save++) {
      rows = persist(toFhirR5Dosages(rows));
      const a = importCanonicalCourse(rows).stages[0].administrations[0];
      expect(a.missingContexts).toEqual(missing);
      expect(a.amounts![0].quantity).toMatchObject({ value: 2, unit: "tab" });
      expect(rows[0].text).toBe("Take 2 tablets every morning");
      expect(() => nextDueDoses(rows, options)).toThrow(/complete dosage array/i);
      expect(() => calculateTotalUnits({ ...options, dosage: rows, durationValue: 7, durationUnit: FhirPeriodUnit.Day }))
        .toThrow(/complete dosage array/i);
      rows = persist(toFhirR5Dosages(toDosageDetails(rows)));
      expect(importCanonicalCourse(rows).stages[0].administrations[0].missingContexts).toEqual(missing);
      expect(() => nextDueDoses(rows, options)).toThrow(/complete dosage array/i);
    }
  });

  it("keeps original unit/code annotations on the authored mixed-duration endpoint", () => {
    const low = { id: "elapsed-low", value: 48, unit: "hours", system: "http://unitsofmeasure.org", code: "h",
      _unit: { id: "hours-translation" }, _code: { id: "hour-code" }, _system: { id: "same-ucum-system" } };
    const high = { value: 3, unit: "days", system: "http://unitsofmeasure.org", code: "d",
      _unit: { id: "days-translation" }, _code: { id: "day-code" } };
    let row: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: { boundsRange: { low, high } } } };
    for (let save = 0; save < 3; save++) {
      row = persist(toFhirR5Dosages([row])[0]);
      const range = row.timing!.repeat!.boundsRange!;
      expect(range.low).toEqual(low);
      expect(range.high).toEqual(high);
      expect(row.modifierExtension?.some(item => item.url === ANCHORED_COURSE_DURATION_EXTENSION_URL)).toBeFalsy();
      expect(importCanonicalCourse(row).stages[0].administrations[0].schedule?.recurrence?.courseLengthRange)
        .toMatchObject({ low, high });
    }
  });

  it("keeps EMA primitive code annotations with the original code after an external R6 comparator edit", () => {
    const coding = { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000055", _code: { id: "approximate-code" } };
    const input = course({ safety: { doseLimit: [{ scope: "administration", valueQuantity: {
      value: 5, unit: "mg", comparator: "~", extension: [{ url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL, valueCoding: coding }],
    } }] } });
    expect(toFhirR5Dosages(input)[0].maxDosePerAdministration!.extension)
      .toContainEqual({ url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL, valueCoding: coding });
    input.step![0].component[0].safety!.doseLimit![0].valueQuantity!.comparator = "<=";
    let rows = persist(toFhirR5Dosages(input));
    for (let save = 0; save < 3; save++) {
      const quantity = rows[0].maxDosePerAdministration!;
      expect(getQuantityComparator(quantity)).toBe("<=");
      expect(quantity.extension).toContainEqual({ url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
        valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000052" } });
      const source = quantity.extension!.filter(item =>
        item.url === "urn:ezmedicationinput:StructureDefinition:quantity-operator-source");
      const originalCodings: NonNullable<FhirExtension["valueCoding"]>[] = [];
      for (const item of source) {
        if (item.valueCoding) originalCodings.push(item.valueCoding);
        else for (const child of item.extension ?? [])
          if (child.valueCoding) originalCodings.push(child.valueCoding);
      }
      expect(originalCodings).toContainEqual(coding);
      rows = persist(toFhirR5Dosages(rows));
    }
  });

  it("removes deleted live limits from active scoped safety while preserving surviving qualifiers", () => {
    const courseSafety = { id: "course-policy", doseLimit: [{ id: "course-cap", scope: "period" as const,
      valueQuantity: q(8), period: { value: 1, unit: "d" } }],
      modifierExtension: [{ url: "https://example.org/course-qualifier", valueString: "course only" }] };
    const stepSafety = { id: "stage-policy", doseLimit: [{ id: "stage-cap", scope: "administration" as const,
      valueQuantity: q(2) }], modifierExtension: [{ url: "https://example.org/stage-qualifier", valueString: "stage only" }] };
    let current = persist(toDosageDetails([{ sequence: 1, doseAndRate: [{ doseQuantity: q(1) }] }], undefined,
      { safety: courseSafety, step: [{ sequence: 1, safety: stepSafety }] }));
    current.safety!.doseLimit = current.safety!.doseLimit!.filter(limit => limit.id === "stage-cap");
    for (let save = 0; save < 3; save++) {
      current = r6Save(current);
      expect(current.safety!.doseLimit).toEqual(stepSafety.doseLimit);
      const active = current.safety!.modifierExtension?.find(item => item.url === R6_SCOPED_SAFETY_MODIFIER_URL);
      expect(active).toBeDefined();
      const scoped = decodeR6SourceMetadata(active!, "safety");
      expect(JSON.stringify(scoped)).not.toContain("course-cap");
      expect(scoped?.step).toEqual(stepSafety);
      const inactive = [current.extension, current.safety!.extension];
      expect(JSON.stringify(inactive)).toContain("course-cap");
      const reopened = importCanonicalCourse(current);
      expect(reopened.safety?.limits ?? []).toEqual([]);
      expect(reopened.stages[0].safety?.limits).toMatchObject([{
        scope: "administration", amount: { value: 2, unit: "tab" }
      }]);
      expect(fromDosageDetails(current).course.step?.[0].safety?.doseLimit).toEqual(stepSafety.doseLimit);
    }
  });
});



it.each(["limit", "action"] as const)("round27 reconciles a live lifted safety %s edit without moving its qualifier", edit => {
  const qualifier = { url: "https://example.org/stage-qualifier", valueString: "stage only" };
  const courseSafety = { ifExceeded: "Call the clinic", doseLimit: [{ id: "course-cap", scope: "period" as const,
    valueQuantity: q(8), period: { value: 1, unit: "d" } }] };
  const stepSafety = { ifExceeded: "Hold the next dose", doseLimit: [{ id: "stage-cap", scope: "administration" as const,
    valueQuantity: q(2) }], modifierExtension: [qualifier] };
  let current = persist(toDosageDetails([{ sequence: 1, doseAndRate: [{ doseQuantity: q(1) }] }], undefined,
    { safety: courseSafety, step: [{ sequence: 1, safety: stepSafety }] }));
  if (edit === "limit") current.safety!.doseLimit!.find(limit => limit.id === "stage-cap")!.valueQuantity!.value = 1;
  else current.safety!.ifExceeded = "Hold the next dose";
  for (let save = 0; save < 3; save++) {
    current = r6Save(current);
    const marker = current.safety!.modifierExtension!.find(item => item.url === R6_SCOPED_SAFETY_MODIFIER_URL)!;
    const scoped = decodeR6SourceMetadata(marker, "safety") as { course: typeof courseSafety; step: typeof stepSafety };
    expect(scoped.step.modifierExtension).toEqual([qualifier]);
    if (edit === "limit") {
      expect(scoped.course).toEqual(courseSafety);
      expect(scoped.step.doseLimit).toEqual([{ id: "stage-cap", scope: "administration", valueQuantity: q(1) }]);
      expect(scoped.step.ifExceeded).toBe("Hold the next dose");
    } else {
      // The edited header owns its action even when the phase uses the same text.
      expect(scoped.course.ifExceeded).toBe("Hold the next dose");
      expect(scoped.course.doseLimit).toEqual(courseSafety.doseLimit);
      expect(scoped.step).toEqual(stepSafety);
    }
    const retired: unknown[] = [];
    const collect = (extensions: readonly FhirR6Extension[] | undefined): void => {
      for (const item of extensions ?? []) {
        if (item.url === R6_SCOPED_SAFETY_MODIFIER_URL) retired.push(decodeR6SourceMetadata(item, "safety"));
        collect(item.extension);
      }
    };
    // Reconciled phase ownership retains the original complete policy in
    // course history; component-local reconciliation retains it on safety.
    collect(current.extension);
    collect(current.safety?.extension);
    expect(retired).toContainEqual({ course: courseSafety, step: stepSafety });
  }
});


it.each([
  ["Do not double your next dose", ["Do not double your next dose"]],
  ["Take 1 tablet daily. Do not double your next dose", ["Do not double your next dose"]],
  ["Take 1 tablet daily; do not double your next dose", ["do not double your next dose"]],
  ["Dissolve 1 tablet in water, do not mix with milk", ["Do not mix with milk"]],
  ["Take 1 tablet after meals. Do not crush the tablet", ["Do not crush the tablet"]],
  ["Take 1 tablet daily with water, do not chew.", ["Take with water", "Do not chew"]],
])("round27 fresh public negation stays present once in both wire versions: %s", (input, expected) => {
  const parsed = parseSig(input as string);
  const r5: Array<string | undefined> = [], r6: Array<string | undefined> = [];
  for (const row of parsed.fhir)
    for (const value of row.additionalInstruction ?? []) r5.push(value.text);
  for (const step of parsed.fhirNext.step ?? [])
    for (const row of step.component)
      for (const value of row.additionalInstruction ?? []) r6.push(value.text);
  expect(r5).toEqual(expected);
  expect(r6).toEqual(expected);
  if ((input as string).includes("double")) {
    const components: FhirR6Dosage[] = [];
    for (const step of parsed.fhirNext.step ?? []) components.push(...step.component);
    for (const rows of [parsed.fhir, components]) {
      const active = rows.filter(row => row.doseAndRate?.length);
      expect(active).toHaveLength((input as string).startsWith("Take ") ? 1 : 0);
      if (active.length) {
        expect(active[0].doseAndRate).toHaveLength(1);
        expect(active[0].doseAndRate![0].doseQuantity).toMatchObject({ value: 1, unit: "tab" });
        expect(active[0].timing?.repeat).toMatchObject({ frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day });
      }
    }
  }
});


describe("round27 contextual phase boundary interchange", () => {
  const system = "urn:ezmedicationinput:CodeSystem:course-phase-event";
  const code = "previous-phase-next-day";
  const prior: FhirR6Dosage = { doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: {
    frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, count: 3, timeOfDay: ["08:00:00"],
  } } };
  const successor: FhirR6Dosage = { doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: {
    frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, count: 1, timeOfDay: ["08:00:00"],
  } } };
  const raw = (start: NonNullable<FhirR6DosageStep["start"]>): FhirR6DosageInstruction => ({
    step: [{ component: [persist(prior)] }, { start, component: [persist(successor)] }],
  });

  it.each(["quantity", "range"] as const)("keeps annotated %s displacement and event identity through repeated R5/R6 saves", kind => {
    const note = { url: "https://example.org/context-note", valueString: "authored relative context" };
    const amount = { id: "offset-value", value: 0, unit: "days", system: "http://unitsofmeasure.org", code: "d",
      _unit: { id: "offset-unit" }, extension: [note] };
    const start: NonNullable<FhirR6DosageStep["start"]> = {
      id: "contextual-start", extension: [note], text: "The day after the prior phase finishes",
      contextCode: { id: "phase-event", text: "Authored event label", coding: [{ system, code, version: "1",
        _code: { id: "phase-event-code" }, extension: [note] }] },
      ...(kind === "quantity" ? { offsetDuration: amount } : { offsetRange: {
        id: "offset-window", low: amount, high: { ...amount, id: "offset-upper", value: 2 }, extension: [note],
      } }),
    };
    let current = raw(persist(start));
    for (let save = 0; save < 3; save++) {
      const native = importCanonicalCourse(current);
      expect(native.stages[1].start?.anchor).toBe("previous-phase-next-day");
      current = persist(projectCanonicalCourse(native).fhirNext);
      expect(current.step![1].start).toEqual(start);
      current = persist(toDosageDetails(persist(toFhirR5Dosages(current))));
      expect(current.step![1].start).toEqual(start);
    }
    if (kind === "quantity") current.step![1].start!.offsetDuration!.value = 3;
    else current.step![1].start!.offsetRange!.high!.value = 4;
    const changed = persist(current.step![1].start!);
    current = persist(toDosageDetails(persist(toFhirR5Dosages(current))));
    expect(current.step![1].start).toEqual(changed);
  });

  it("projects a fresh contextual anchor without inventing another day offset", () => {
    expect(boundaryToWire({ anchor: "previous-phase-next-day" })).toEqual({
      contextCode: { coding: [{ system, code }] },
    });
  });

  it("keeps a removed predecessor unresolved despite the successor's explicit contextual start", () => {
    let rows = persist(toFhirR5Dosages(raw({ contextCode: { coding: [{ system, code }] } }))).slice(1);
    const options = { from: "2026-11-21T00:00:00Z", orderedAt: "2026-11-21T00:00:00Z", timeZone: "UTC", limit: 2 };
    for (let save = 0; save < 3; save++) {
      const native = importCanonicalCourse(rows);
      const next = native.stages[1];
      expect(next.start?.anchor).toBe("previous-phase-next-day");
      expect(next.administrations[0].missingContexts).toContain("predecessor");
      expect(() => nextDueDoses(rows, options)).toThrow(/complete dosage array/i);
      rows = persist(toFhirR5Dosages(toDosageDetails(rows)));
    }
  });

  it("keeps a nonshared member reference and its predecessor dependency beside an independent step start", () => {
    const memberStart = { id: "member-start", text: "Next day after the prior phase", contextCode: {
      coding: [{ system, code, _code: { id: "member-event-code" } }],
    }, offsetDuration: { value: 0, unit: "d", _unit: { id: "member-offset-unit" } } };
    const marker = encodeR6SourceMetadata(PARALLEL_COMPONENT_PHASE_ORIGIN_URL, { start: memberStart }, "step");
    marker.id = "member-phase-marker";
    marker.extension!.push({ url: "https://example.org/phase-note", valueString: "member context annotation" });
    let current = raw({ contextCode: { coding: [{
      system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start",
    }] }, offsetDuration: { value: 4, unit: "d" } });
    current.step![1].component[0].modifierExtension = [persist(marker)];
    for (let save = 0; save < 3; save++) {
      const native = importCanonicalCourse(current);
      expect(native.stages[1].start?.anchor).toBe("treatment-start");
      expect(native.stages[1].administrations[0].phaseStart?.anchor).toBe("previous-phase-next-day");
      current = persist(projectCanonicalCourse(native).fhirNext);
      expect(current.step![1].component[0].modifierExtension).toContainEqual(marker);
      current = persist(toDosageDetails(persist(toFhirR5Dosages(current))));
      expect(current.step![1].component[0].modifierExtension).toContainEqual(marker);
    }
    let rows = persist(toFhirR5Dosages(current)).slice(1);
    for (let save = 0; save < 3; save++) {
      const native = importCanonicalCourse(rows);
      expect(native.stages[1].administrations[0].missingContexts).toContain("predecessor");
      expect(() => nextDueDoses(rows, { from: "2026-11-21T00:00:00Z", orderedAt: "2026-11-21T00:00:00Z",
        timeZone: "UTC", limit: 2 })).toThrow(/complete dosage array/i);
      rows = persist(toFhirR5Dosages(toDosageDetails(rows)));
    }
  });

  it.each(["code", "system", "reference", "conflicting-codes"] as const)("uses the current external %s instead of reviving the recognized event", edit => {
    const start: NonNullable<FhirR6DosageStep["start"]> = { text: "Day after the previous phase", contextCode: {
      coding: [{ system, code }],
    } };
    if (edit === "code") start.contextCode!.coding![0].code = "external-other-event";
    else if (edit === "system") start.contextCode!.coding![0].system = "https://example.org/foreign-events";
    else if (edit === "conflicting-codes") start.contextCode!.coding!.push({
      system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start",
    });
    else start.contextReference = { reference: "Observation/external-event" };
    let current = raw(persist(start));
    for (let save = 0; save < 3; save++) {
      const native = importCanonicalCourse(current);
      expect(native.stages[1].start?.anchor).toBe(edit === "reference" ? "resource-reference" : "coded-event");
      current = persist(toDosageDetails(persist(toFhirR5Dosages(current))));
      expect(current.step![1].start).toEqual(start);
    }
  });
});

describe("round28 live interchange authority and retained clinical identity", () => {
  it.each([false, true])("does not mistake normalized EMA annotations for a safety edit (real mirror edit %s)", edited => {
    const annotation: FhirExtension = { id: "authored-less-than", url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000050", display: "Less than" } };
    const lifted = persist(toEzDosages([{ doseAndRate: [{ doseQuantity: { value: 1, unit: "mL" } }],
      maxDosePerAdministration: { value: 4, unit: "mL", extension: [annotation] } }]));
    lifted[0].maxDosePerAdministration!.value = 2;
    if (edited) lifted[0].safety!.doseLimit![0].valueQuantity!.value = 3;
    let wire = toDosageDetails(lifted);
    for (let save = 0; save < 3; save++) {
      const limit = wire.step![0].component[0].safety!.doseLimit![0].valueQuantity!;
      expect(limit.value).toBe(edited ? 3 : 2);
      expect(getQuantityComparator(limit)).toBe("<");
      expect(JSON.stringify(wire)).toContain("authored-less-than");
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
    }
  });

  it.each([false, true])("uses a newly submitted saved R5 condition threshold (compound %s)", compound => {
    const text = "Take 1 tablet daily if SBP > 160, maximum 2 tablets per administration";
    const predicate = { kind: "measurement" as const, name: "SBP", operation: "gt" as const,
      value: 160, unit: "mmHg", text: "SBP > 160" };
    const raw: FhirDosage = { text, doseAndRate: [{ doseQuantity: q(1) }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
      maxDosePerAdministration: q(2) };
    setDosageCondition(raw, compound ? { kind: "all", conditions: [predicate,
      { kind: "state", name: "dizziness", expected: false, text: "no dizziness" }] } : predicate);
    let row = persist(withDosageEditProvenance([raw], text)[0]);
    expect(formatSig(row, "short", { realizationMode: "roundtrip" })).toBe(text);
    expect(formatSig(row)).toContain("SBP > 160 mmHg");
    expect(formatSig(row)).toContain("max per administration: 2 tab");
    row = persist(row);
    const root = row.modifierExtension!.find(item => item.url === DOSAGE_CONDITION_R5_URL)!.extension![0];
    const leaf = compound ? root.extension!.find(item => item.url === "conditions")! : root;
    leaf.extension!.find(item => item.url === "value")!.valueDecimal = 150;
    expect(dosageMatchesSavedProjection(row)).toBe(false);
    const warm = formatSig(row);
    expect(warm).toBe(formatSig(persist(row)));
    expect(warm).toContain("150");
    expect(warm).not.toContain("160");
  });

  it("uses a newly submitted state predicate polarity without replaying its old text", () => {
    const text = "Take 1 tablet if dizziness, maximum 2 tablets per administration";
    const raw: FhirDosage = { text, doseAndRate: [{ doseQuantity: q(1) }], maxDosePerAdministration: q(2) };
    setDosageCondition(raw, { kind: "state", name: "dizziness", expected: true, text: "dizziness" });
    let row = persist(withDosageEditProvenance([raw], text)[0]);
    expect(formatSig(row, "short", { realizationMode: "roundtrip" })).toBe(text);
    expect(formatSig(row)).toContain("only if dizziness");
    expect(formatSig(row)).toContain("max per administration: 2 tab");
    row = persist(row);
    const leaf = row.modifierExtension!.find(item => item.url === DOSAGE_CONDITION_R5_URL)!.extension![0];
    leaf.extension!.find(item => item.url === "expected")!.valueBoolean = false;
    const warm = formatSig(row);
    expect(warm).toBe(formatSig(persist(row)));
    expect(warm).toContain("not dizziness");
    expect(row.text).toBe(text);
  });

  it("uses a newly submitted later capped R5 rate without losing unchanged authored text", () => {
    const text = "Infuse 5 mL/h, maximum 10 mL per administration";
    const input: FhirDosage[] = [
      { sequence: 1, text: "Give 1 mL", doseAndRate: [{ doseQuantity: { value: 1, unit: "mL" } }] },
      { sequence: 2, text, doseAndRate: [{ rateQuantity: { value: 5, unit: "mL/h" } }],
        maxDosePerAdministration: { value: 10, unit: "mL" } },
    ];
    let rows = persist(toFhirR5Dosages(withDosageEditProvenance(input, "Initial dose, then maintenance")));
    expect(formatSig(rows[1], "short", { realizationMode: "roundtrip" })).toBe(text);
    expect(formatSig(rows[1])).toContain("Rate: 5 mL/h");
    expect(formatSig(rows[1])).toContain("max per administration: 10 mL");
    rows = persist(rows);
    rows[1].doseAndRate![0].rateQuantity!.value = 6;
    const preview = formatSig(rows[1]);
    expect(preview).toBe(formatSig(persist(rows[1])));
    expect(preview).toMatch(/(?<![\d.])6 mL\/h(?![\w/])/u);
    expect(preview).not.toMatch(/(?<![\d.])5 mL\/h/u);
  });

  it.each([false, true])("associates only a unique anonymous edited scoped cap (ambiguous family %s)", ambiguous => {
    const qualifier = { url: "https://example.org/stage-qualifier", valueString: "stage only" };
    const courseSafety = { doseLimit: [{ scope: ambiguous ? "administration" as const : "period" as const,
      valueQuantity: q(8), ...(ambiguous ? {} : { period: { value: 1, unit: "d" } }) }] };
    const stepSafety = { doseLimit: [{ scope: "administration" as const, valueQuantity: q(2) }],
      modifierExtension: [qualifier] };
    let current = persist(toDosageDetails([{ sequence: 1, doseAndRate: [{ doseQuantity: q(1) }] }], undefined,
      { safety: courseSafety, step: [{ sequence: 1, safety: stepSafety }] }));
    current.safety!.doseLimit![1].valueQuantity!.value = 1;
    for (let save = 0; save < 3; save++) {
      current = r6Save(current);
      expect(current.safety!.doseLimit![1].valueQuantity!.value).toBe(1);
      const marker = current.safety!.modifierExtension!.find(item => item.url === R6_SCOPED_SAFETY_MODIFIER_URL)!;
      const scoped = decodeR6SourceMetadata(marker, "safety") as { step: typeof stepSafety };
      expect(scoped.step.modifierExtension).toEqual([qualifier]);
      expect(scoped.step.doseLimit ?? []).toEqual(ambiguous ? [] : [{ scope: "administration", valueQuantity: q(1) }]);
      expect(JSON.stringify(current.safety!.extension)).toContain('"value":2');
    }
  });

  it("keeps a standalone annotated R5 predicate active on first R6 import", () => {
    const raw: FhirDosage = {};
    const predicate = { kind: "measurement" as const, name: "SBP", operation: "gt" as const,
      value: 160, text: "SBP > 160" };
    setDosageCondition(raw, predicate);
    raw.modifierExtension![0].id = "external-condition-source";
    let wire = course({ modifierExtension: persist(raw.modifierExtension) });
    for (let save = 0; save < 3; save++) {
      expect(importCanonicalCourse(wire).stages[0].administrations[0].predicate).toEqual(predicate);
      wire = r6Save(wire);
      expect(wire.step![0].component[0].condition).toHaveLength(1);
      expect(JSON.stringify(wire)).toContain("external-condition-source");
    }
  });

  it("retains a display-only EMA Coding under its original operator after an edit", () => {
    const coding = { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000052", display: "Inférieur ou égal à" };
    const input = course({ doseAndRate: [{ rateRatio: { numerator: { value: 5, unit: "mL", comparator: "~",
      extension: [{ url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL, valueCoding: coding }] },
      denominator: { value: 1, unit: "h" } } }] });
    let rows = persist(toFhirR5Dosages(input));
    for (let save = 0; save < 3; save++) {
      const quantity = rows[0].doseAndRate![0].rateRatio!.numerator!;
      expect(getQuantityComparator(quantity)).toBe("~");
      expect(quantity.extension).toContainEqual({
        url: "urn:ezmedicationinput:StructureDefinition:quantity-operator-source", valueCoding: coding,
      });
      expect(quantity.extension!.find(item => item.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL)!.valueCoding!.display)
        .not.toBe(coding.display);
      rows = persist(toFhirR5Dosages(toDosageDetails(rows)));
    }
  });

  it("does not pair an unmatched survivor positionally beside ambiguous site matches", () => {
    const component = (site: string, value: number, offset: number): FhirR6Dosage => ({
      site: { concept: { text: site } }, doseAndRate: [{ doseQuantity: q(value) }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        startOffset: { value: offset, unit: "d" }, endOffset: { value: offset + 1, unit: "d" } } },
    });
    const input: FhirR6DosageInstruction = { step: [{ component: [
      component("same site", 1, 1), component("same site", 2, 2), component("deleted site", 3, 9),
    ] }] };
    // The supported full-course source form predates per-row compact
    // identity; no current local marker independently identifies these rows.
    const rows: FhirDosage[] = [1, 2].map(value => ({
      sequence: 1, site: { text: "same site" }, doseAndRate: [{ doseQuantity: q(value) }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
    }));
    rows[0].modifierExtension = [{ url: DOSAGE_DETAILS_R5_URL, extension: [{
      url: "dosageDetails", extension: [encodeR6SourceMetadata("step", input.step![0], "step")],
    }] }];
    rows[0].doseAndRate![0].doseQuantity!.value = 8;
    rows[1].doseAndRate![0].doseQuantity!.value = 9;
    rows[1].site = { text: "new site" };
    const current = toDosageDetails(rows);
    const survivor = current.step![0].component.find(item => item.site?.concept?.text === "new site")!;
    expect(survivor.timing!.repeat!.startOffset).toBeUndefined();
    expect(survivor.timing!.repeat!.endOffset).toBeUndefined();
    expect(JSON.stringify(current)).toContain("deleted site");
  });

  it.each([false, true])("retains period-cap text on first ID only for an unchanged amount (amount edit %s)", edited => {
    let rows = persist(toFhirR5Dosages(course({ safety: { doseLimit: [{
      scope: "period", text: "Authored daily cap", valueQuantity: q(4), period: { value: 1, unit: "d" },
    }] } })));
    rows[0].maxDosePerPeriod![0].id = "assigned-id";
    if (edited) rows[0].maxDosePerPeriod![0].numerator!.value = 3;
    for (let save = 0; save < 3; save++) {
      const wire = toDosageDetails(rows);
      const limit = wire.step![0].component[0].safety!.doseLimit![0];
      expect(limit.id).toBe("assigned-id");
      expect(limit.valueQuantity!.value).toBe(edited ? 3 : 4);
      expect(limit.text).toBe(edited ? undefined : "Authored daily cap");
      rows = persist(toFhirR5Dosages(wire));
    }
  });

  it("retains the elapsed lower endpoint across a DST transition after a qualifier-only edit", () => {
    const original: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: {
      boundsRange: { low: { value: 48, unit: "hours", system: "http://unitsofmeasure.org", code: "h" },
        high: { value: 3, unit: "days", system: "http://unitsofmeasure.org", code: "d" } },
    } } };
    let row = persist(canonicalToFhir(canonicalFromFhir(original)));
    row.timing!.repeat!.boundsRange!.low = simpleQuantityForR5({
      ...row.timing!.repeat!.boundsRange!.low, comparator: ">" });
    for (let save = 0; save < 3; save++) {
      const low = importCanonicalCourse(row).stages[0].administrations[0].schedule!.recurrence!.courseLengthRange!.low!;
      expect(low).toMatchObject({ value: 48, unit: "hours", code: "h", comparator: ">" });
      // New York advances one hour on March 8: 48 elapsed hours from noon
      // March 7 ends at 13:00 March 9, not the noon calendar-day endpoint.
      const elapsed = new Date(Date.parse("2026-03-07T12:00:00-05:00") + low.value! * 3_600_000);
      expect(elapsed.toISOString()).toBe("2026-03-09T17:00:00.000Z");
      expect(elapsed.toISOString()).not.toBe("2026-03-09T16:00:00.000Z");
      row = persist(toFhirR5Dosages(toDosageDetails([row]))[0]);
    }
  });

  it.each([false, true])("keeps sparse own-track member IDs through reorder and deletion (via R5 %s)", viaR5 => {
    const parsed = parseSig("1 drop OD daily for 5 doses then 2 drops OD at 06:00 the next day; 1 drop OS BID");
    let current = persist(parsed.fhirNext);
    const first = importCanonicalCourse(current).stages[0].administrations;
    expect(first.map(member => [member.sourceMember, member.phasePredecessors])).toEqual([[0, []], [1, [0]], [undefined, undefined]]);
    const items = current.step![0].component;
    current.step![0].component = [items[2], items[1], items[0]];
    for (let save = 0; save < 3; save++) {
      if (viaR5) current = toDosageDetails(persist(toFhirR5Dosages(current)));
      else current = r6Save(current);
      const members = importCanonicalCourse(current).stages[0].administrations;
      expect(members.map(member => [member.sourceMember, member.phasePredecessors]))
        .toEqual([[undefined, undefined], [1, [0]], [0, []]]);
      expect(nextDueDoses(current, { orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-06T05:00:00Z",
        timeZone: "UTC", limit: 1 })).toEqual(["2026-01-06T06:00:00+00:00"]);
    }
    current.step![0].component.pop();
    if (viaR5) current = toDosageDetails(persist(toFhirR5Dosages(current)));
    else current = r6Save(current);
    const remaining = importCanonicalCourse(current).stages[0].administrations;
    expect(remaining.map(member => [member.sourceMember, member.phasePredecessors]))
      .toEqual([[undefined, undefined], [1, [0]]]);
    expect(() => nextDueDoses(current, { orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-06T05:00:00Z",
      timeZone: "UTC", limit: 1 })).toThrow(expect.objectContaining({ code: "previous-phase-required" }));
  });

  it("retains annotated local-midnight treatment anchors in both wire versions", () => {
    const start = { id: "authored-day-start", contextCode: { text: "Ordered local date",
      coding: [{ system: "urn:ezmedicationinput:CodeSystem:course-phase-event", code: "treatment-day-start",
        _code: { id: "day-start-code" } }] }, offsetDuration: { value: 1, unit: "d" } };
    let wire: FhirR6DosageInstruction = { step: [{ start, component: [{ doseAndRate: [{ doseQuantity: q(1) }] }] }] };
    for (let save = 0; save < 3; save++) {
      expect(importCanonicalCourse(wire).stages[0].start?.anchor).toBe("treatment-day-start");
      wire = toDosageDetails(persist(toFhirR5Dosages(r6Save(wire))));
      expect(wire.step![0].start).toEqual(start);
    }
  });
});

describe("round29 interchange ownership", () => {
  const referenceMarker = (components: Array<{ value: number; id?: string; reference: string }>): FhirExtension => ({
    url: DOSAGE_DETAILS_R5_URL, extension: [{ url: "dosageDetails", extension: [
      { url: "step", extension: components.map(item => ({ url: "component", extension: [
        ...(item.id ? [{ url: "id", valueString: item.id }] : []),
        { url: "site", valueCodeableReference: { reference: { reference: item.reference } } },
        { url: "doseAndRate", extension: [{ url: "doseQuantity", valueQuantity: q(item.value) }] },
      ] })) },
    ] }],
  });

  it("restores a historical reference-only row beside a compact qualified-dose row", () => {
    const marker = referenceMarker([{ id: "eye", value: 1, reference: "BodyStructure/right-eye" }]);
    const historical: FhirDosage = { id: "eye", sequence: 1, doseAndRate: [{ doseQuantity: q(1) }], modifierExtension: [marker] };
    const compact = toFhirR5Dosages(course({
      doseAndRate: [{ doseQuantity: simpleQuantityForR5({ ...q(2), comparator: "~" })! }],
    }))[0];
    const input = persist([historical, compact]);
    const before = JSON.stringify(input);
    let current = toDosageDetails(input);
    for (let save = 0; save < 3; save++) {
      expect(current.step![0].component[0].site?.reference).toEqual({ reference: "BodyStructure/right-eye" });
      expect(current.step![0].component.map(item => item.doseAndRate![0].doseQuantity!.value)).toEqual([1, 2]);
      current = toDosageDetails(persist(toFhirR5Dosages(current)));
    }
    expect(JSON.stringify(input)).toBe(before);
  });

  it("keeps live members with sparse sequence identities when historical and compact rows mix", () => {
    const marker = referenceMarker([{ id: "old", value: 1, reference: "BodyStructure/old" }]);
    const historical: FhirDosage[] = [
      { id: "three", sequence: 3, site: { text: "Right eye" },
        doseAndRate: [{ doseQuantity: q(3) }], modifierExtension: [marker] },
      { id: "four", sequence: 4, site: { text: "Left eye" },
        doseAndRate: [{ doseQuantity: q(4) }], modifierExtension: [marker] }
    ];
    const compact = toFhirR5Dosages(course({
      doseAndRate: [{ doseQuantity: simpleQuantityForR5({ ...q(2), comparator: "~" })! }]
    }))[0];
    for (const rows of [[compact, ...historical], [historical[1], compact, historical[0]]]) {
      const input = persist(rows);
      const before = JSON.stringify(input);
      const restored = importCanonicalCourse(input);
      const members: (typeof restored.stages)[number]["administrations"] = [];
      for (const stage of restored.stages) members.push(...stage.administrations);
      expect(members.find(member => member.stageOrdinal === 3)).toMatchObject({
        stageOrdinal: 3, amounts: [{ quantity: { value: 3 } }], target: { text: "Right eye" }
      });
      expect(members.find(member => member.stageOrdinal === 4)).toMatchObject({
        stageOrdinal: 4, amounts: [{ quantity: { value: 4 } }], target: { text: "Left eye" }
      });
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each([false, true])("restores reference-only sites only with established row identity (identified %s)", identified => {
    const marker = referenceMarker([
      { value: 1, ...(identified ? { id: "right" } : {}), reference: "BodyStructure/right-eye" },
      { value: 2, ...(identified ? { id: "left" } : {}), reference: "BodyStructure/left-eye" },
    ]);
    const rows: FhirDosage[] = [1, 0].map(index => ({ sequence: 1,
      ...(identified ? { id: index ? "left" : "right" } : {}),
      doseAndRate: [{ doseQuantity: q((index + 1) * 10) }], modifierExtension: [marker] }));
    const result = toDosageDetails(persist(rows));
    expect(result.step![0].component.map(item => item.doseAndRate![0].doseQuantity!.value)).toEqual([20, 10]);
    expect(result.step![0].component.map(item => item.site?.reference?.reference)).toEqual(
      identified ? ["BodyStructure/left-eye", "BodyStructure/right-eye"] : [undefined, undefined]);
    if (!identified) expect(JSON.stringify(result.extension)).toContain("BodyStructure/right-eye");
  });

  it("uses a newly submitted parser-row condition threshold without stale source text", () => {
    let row = toFhirR5Dosages(parseSig("1 tab BID only if BP > 160").fhir)[0];
    const original = row.text;
    expect(formatSig(row)).toContain("160");
    row = persist(row);
    const marker = row.modifierExtension!.find(item => item.url === DOSAGE_CONDITION_R5_URL)!;
    const pending = [marker];
    for (let index = 0; index < pending.length; index++) {
      const item = pending[index];
      if (item.url === "value" && item.valueDecimal === 160) item.valueDecimal = 180;
      pending.push(...(item.extension ?? []));
    }
    for (const source of [row, persist(row)]) {
      const text = formatSig(source);
      expect(text, source === row ? "fresh" : "persisted").toContain("180");
      expect(text).not.toContain("160");
      expect(fromFhirDosage(source).longText).toContain("180");
    }
    expect(row.text).toBe(original);
  });

  it.each(["fresh", "saved"] as const)("does not revive a removed condition in a newly submitted %s value", mode => {
    const parsed = toFhirR5Dosages(parseSig("1 tab BID only if BP > 160").fhir)[0];
    let row = mode === "fresh" ? parsed : persist(withDosageEditProvenance([parsed], parsed.text)[0]);
    expect(formatSig(row)).toContain("160");
    row = persist(row);
    row.modifierExtension = row.modifierExtension!.filter(item => item.url !== DOSAGE_CONDITION_R5_URL);
    const text = formatSig(row);
    expect(text).not.toMatch(/BP|160|only if/u);
    expect(text).toMatch(/1 tab|one tablet/u);
    expect(fromFhirDosage(row).longText).not.toMatch(/BP|160|only if/u);
  });

  it.each(["relation", "activity", "offset", "offsetMin", "offsetMax"] as const)(
    "uses a newly submitted nested activity-window %s edit", field => {
      const text = "Take 1 tablet 30 minutes after dialysis";
      let row = persist(withDosageEditProvenance([{
        text, doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: { extension: [{
          url: TIMING_ACTIVITY_WINDOW_EXTENSION_URL, extension: [
            { url: "relation", valueCode: "after" }, { url: "activity", valueCodeableConcept: { text: "dialysis" } },
            ...(field === "offsetMin" || field === "offsetMax" ? [
              { url: "offsetMin", valueQuantity: { value: 30, unit: "min", code: "min" } },
              { url: "offsetMax", valueQuantity: { value: 60, unit: "min", code: "min" } },
            ] : [{ url: "offset", valueQuantity: { value: 30, unit: "min", code: "min" } }]),
          ],
        }] } },
      }], text)[0]);
      expect(dosageMatchesSavedProjection(row)).toBe(true);
      row = persist(row);
      const parts = row.timing!.repeat!.extension![0].extension!;
      if (field === "relation") parts[0].valueCode = "before";
      else if (field === "activity") parts[1].valueCodeableConcept!.text = "physiotherapy";
      else if (field === "offset") parts[2].valueQuantity!.value = 60;
      else parts.find(item => item.url === field)!.valueQuantity!.value = field === "offsetMin" ? 15 : 90;
      expect(dosageMatchesSavedProjection(row)).toBe(false);
      const warm = formatSig(row);
      expect(warm).toBe(formatSig(persist(row)));
      if (field === "relation") expect(warm).toContain("before dialysis");
      if (field === "activity") expect(warm).toContain("physiotherapy");
      if (field === "offset") expect(warm).toMatch(/60 minutes|1 hour/u);
      if (field === "offsetMin") expect(warm).toMatch(/15(?:–|-| to )60 minutes|0\.25(?:–|-| to )1 hour/u);
      if (field === "offsetMax") expect(warm).toMatch(/30(?:–|-| to )90 minutes|0\.5(?:–|-| to )1\.5 hour/u);
      expect(row.text).toBe(text);
    });

  it.each(["choice", "cycle", "cycle-minimal"] as const)("retains the %s modifier wrapper and child annotations", kind => {
    const marker: FhirExtension = kind === "choice" ? {
      id: "membership", url: DOSAGE_ALTERNATIVE_CHOICE_URL, extension: [
        { id: "group-note", url: "groupId", valueString: "regimen" },
        { id: "branch-note", url: "branchId", valueString: "first" },
        { url: "selectionBehavior", valueCode: "exactly-one" },
        { url: "urn:test:author", valueString: "retain" },
      ],
    } : {
      id: "cycle-days", url: CYCLE_DAY_ELIGIBILITY_EXTENSION_URL, extension: [
        { id: "day-1", url: "day", valueInteger: 1 }, { id: "day-8", url: "day", valueInteger: 8 },
        { url: "reason", valueCode: "unresolved-cycle-eligibility" }, { url: "source", valueString: "days 1 and 8" },
        { url: "urn:test:author", valueString: "retain" },
      ],
    };
    if (kind === "cycle-minimal")
      marker.extension = marker.extension!.filter(item => item.url !== "reason" && item.url !== "source");
    let value = course({ modifierExtension: [marker] });
    for (let save = 0; save < 3; save++) {
      value = toDosageDetails(persist(toFhirR5Dosages(value)));
      expect(value.step![0].component[0].modifierExtension).toContainEqual(marker);
    }
    if (kind === "choice") {
      const dosage = persist(value.step![0].component[0]);
      setDosageAlternativeChoice(dosage, { groupId: "regimen", branchId: "second", selectionBehavior: "exactly-one" });
      expect(dosage.modifierExtension).toContainEqual({ ...marker, extension: marker.extension!.map(item =>
        item.url === "branchId" ? { ...item, valueString: "second" } : item) });
    } else {
      const live = value.step![0].component[0].modifierExtension!.find(item => item.url === marker.url)!;
      live.extension!.find(item => item.url === "day")!.valueInteger = 2;
      const edited = toDosageDetails(persist(toFhirR5Dosages(value))).step![0].component[0];
      expect(edited.modifierExtension).toContainEqual({ ...marker, extension: marker.extension!.map(item =>
        item.url === "day" && item.valueInteger === 1 ? { ...item, valueInteger: 2 } : item) });
    }
  });

  it("keeps the authored mixed-duration endpoint independent of a live upper-bound edit", () => {
    const row = canonicalToFhir(canonicalFromFhir({
      doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: {
        boundsRange: { low: { value: 48, unit: "h", code: "h" }, high: { value: 3, unit: "d", code: "d" } },
      } },
    }));
    const sourceLow = persist(row.timing!.repeat!.boundsRange!.low);
    row.timing!.repeat!.boundsRange!.high!.value = 4;
    expect(row.timing!.repeat!.boundsRange!.low).toEqual(sourceLow);
    expect(canonicalFromFhir(row).schedule).toMatchObject({ duration: 48, durationUnit: FhirPeriodUnit.Hour,
      durationMax: 4, durationMaxUnit: FhirPeriodUnit.Day });
  });

  it("restores an inactive draft beside an unchanged EMA-only condition threshold", () => {
    const annotation: FhirExtension = { url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000053" } };
    const active: FhirR6DosageStep = { component: [{
      doseAndRate: [{ doseQuantity: q(1) }], condition: [{ code: { text: "BP" },
        valueQuantity: { value: 160, unit: "mmHg", extension: [annotation] } }],
    }] };
    const wire: FhirR6DosageInstruction = { step: [active], extension: [
      encodeR6SourceMetadata(R6_DRAFT_STEPS_SOURCE_URL, {
        drafts: [{ index: 0, step: { id: "draft" } }], projected: [active],
      }, "drafts"),
    ] };
    expect(importCanonicalCourse(persist(wire)).stages.map(stage => stage.administrations.length)).toEqual([0, 1]);
    wire.step![0].component[0].condition![0].valueQuantity!.value = 180;
    expect(importCanonicalCourse(persist(wire)).stages.map(stage => stage.administrations.length)).toEqual([1]);
  });

  it.each([false, true])("matches identical scoped limits one-to-one (one removed %s)", removed => {
    const limit = { scope: "administration" as const, valueQuantity: q(2) };
    const courseSafety = { doseLimit: [persist(limit)], modifierExtension: [{ url: "urn:test:course-policy", valueBoolean: true }] };
    const stepSafety = { doseLimit: [persist(limit)], modifierExtension: [{ url: "urn:test:step-policy", valueBoolean: true }] };
    let value = persist(toDosageDetails([{ sequence: 1, doseAndRate: [{ doseQuantity: q(1) }] }], undefined,
      { safety: courseSafety, step: [{ sequence: 1, safety: stepSafety }] }));
    if (removed) value.safety!.doseLimit!.pop();
    for (let save = 0; save < 3; save++) {
      value = r6Save(value);
      expect(value.safety!.doseLimit).toHaveLength(removed ? 1 : 2);
      const marker = value.safety!.modifierExtension!.find(item => item.url === R6_SCOPED_SAFETY_MODIFIER_URL)!;
      const scoped = decodeR6SourceMetadata(marker, "safety") as { course: typeof courseSafety; step: typeof stepSafety };
      for (const policy of [scoped.course, scoped.step])
        expect(policy.doseLimit ?? []).toEqual(removed ? [] : [limit]);
      if (removed) expect(JSON.stringify(value.safety!.extension)).toContain("urn:test:step-policy");
    }
  });
});

describe("round30 interchange meaning", () => {
  it("keeps numeric phase origin and supplied phase identity together across R5 saves", () => {
    const marker: FhirExtension = { url: PARALLEL_COMPONENT_PHASE_ORIGIN_URL,
      valueQuantity: { value: 3, unit: "d" }, extension: [{ url: "sourceMember", valueInteger: 7 }] };
    let wire = course({ modifierExtension: [marker] });
    for (let save = 0; save < 3; save++) {
      const rows = persist(toFhirR5Dosages(wire));
      expect(rows[0].modifierExtension).toContainEqual(marker);
      const native = courseFromR5(rows);
      expect(native.stages[0].administrations[0]).toMatchObject({
        phaseOrigin: { value: 3, unit: "d" }, sourceMember: 7, phasePredecessors: [], phaseOriginIssue: false,
      });
      wire = projectCanonicalCourse(native).fhirNext;
      expect(wire.step![0].component[0].modifierExtension).toContainEqual(marker);
    }
  });

  const phasePolicy = { doseLimit: [{ scope: "administration" as const, valueQuantity: q(2) }] };
  const induction = (identified: boolean): FhirR6DosageInstruction => ({
    step: [{ ...(identified ? { id: "induction" } : {}), safety: phasePolicy,
      component: [{ doseAndRate: [{ doseQuantity: q(1) }] }] }]
  });
  const maintenance = (): FhirR6DosageStep => ({
    id: "maintenance", component: [{ doseAndRate: [{ doseQuantity: q(3) }] }]
  });

  it.each([false, true])("keeps a lifted phase cap with its owner after append and reorder (identified %s)", identified => {
    const output = r6Save(induction(identified));
    output.step!.push(maintenance());
    output.step!.reverse();
    const before = JSON.stringify(output);
    const native = importCanonicalCourse(output);
    expect(native.safety).toBeUndefined();
    expect(native.stages[0].safety).toBeUndefined();
    expect(native.stages[1].safety?.limits).toEqual([
      expect.objectContaining({ scope: "administration", amount: { value: 2, unit: "tab" } })
    ]);
    const reopened = projectCanonicalCourse(native).fhirNext;
    expect(reopened.safety).toBeUndefined();
    expect(reopened.step![0].safety).toBeUndefined();
    expect(reopened.step![1].safety).toEqual(phasePolicy);
    expect(JSON.stringify(output)).toBe(before);
  });

  it("keeps lifted safety on its active owner beside a restored inactive draft", () => {
    const input = induction(true);
    input.step!.unshift({ id: "draft", component: [] });
    const output = r6Save(input);
    const native = importCanonicalCourse(persist(output));
    expect(native.stages.map(stage => stage.administrations.length)).toEqual([0, 1]);
    expect(native.safety).toBeUndefined();
    expect(native.stages[0].safety).toBeUndefined();
    expect(native.stages[1].safety?.limits?.[0].amount?.value).toBe(2);
    expect(native.stages[1].start).toBeUndefined();
  });

  it.each(["replacement", "duplicate-id", "duplicate-anonymous", "header-edit", "step-edit"] as const)(
    "does not use an obsolete or ambiguous lifted owner after an external %s", edit => {
      const output = r6Save(induction(edit !== "duplicate-anonymous"));
      if (edit === "replacement") output.step![0].id = "replacement";
      else if (edit === "duplicate-id" || edit === "duplicate-anonymous") output.step!.push(persist(output.step![0]));
      else if (edit === "header-edit") output.safety!.doseLimit![0].valueQuantity!.value = 4;
      else output.step![0].safety = { doseLimit: [{ scope: "administration", valueQuantity: q(5) }] };
      const native = importCanonicalCourse(output);
      if (edit === "step-edit") {
        expect(native.safety).toBeUndefined();
        expect(native.stages[0].safety?.limits?.[0].amount?.value).toBe(5);
      } else {
        expect(native.safety?.limits?.[0].amount?.value).toBe(edit === "header-edit" ? 4 : undefined);
        for (const stage of native.stages) expect(stage.safety).toBeUndefined();
      }
      expect(JSON.stringify(projectCanonicalCourse(native).fhirNext.extension)).toContain(R6_SINGLE_STEP_SAFETY_SOURCE_URL);
    });

  it.each(["date", "weekday"] as const)("uses a newly submitted %s exclusion instead of former source wording", kind => {
    const row = persist(parseSig("Take 1 tablet twice daily").fhir[0]);
    const original = row.text;
    if (kind === "date") setDosageExcludedDates(row, ["2026-01-02"]);
    else setDosageExcludedWeekdays(row, [FhirDayOfWeek.Monday]);
    for (const input of [row, persist(row)]) {
      expect(formatSig(input, "long")).toMatch(kind === "date" ? /2026-01-02/u : /Mon(?:day)?/u);
      expect(fromFhirDosage(input).longText).toMatch(kind === "date" ? /2026-01-02/u : /Mon(?:day)?/u);
    }
    expect(row.text).toBe(original);
  });

  it.each(["date", "weekday"] as const)("uses newly submitted %s exclusion edits and clears", kind => {
    const row: FhirDosage = { text: kind === "date" ? "Take one tablet except 2026-01-02." : "Take one tablet except Monday.",
      doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } } };
    if (kind === "date") setDosageExcludedDates(row, ["2026-01-02"]);
    else setDosageExcludedWeekdays(row, [FhirDayOfWeek.Monday]);
    let saved = persist(withDosageEditProvenance([row], row.text)[0]);
    expect(dosageMatchesSavedProjection(saved)).toBe(true);
    expect(formatSig(saved, "long", { realizationMode: "roundtrip" })).toBe(row.text);
    saved = persist(saved);
    const marker = kind === "date"
      ? saved.modifierExtension!.find(value => value.url === DOSAGE_EXCLUDED_DATES_R5_URL)!
      : saved.extension!.find(value => value.url === DOSAGE_EXCLUDED_WEEKDAYS_R5_URL)!;
    if (kind === "date") marker.extension![0].valueDate = "2026-01-03";
    else marker.extension![0].valueCode = FhirDayOfWeek.Tuesday;
    expect(dosageMatchesSavedProjection(saved)).toBe(false);
    for (const input of [saved, persist(saved)]) {
      const actual = formatSig(input, "long");
      expect(actual).toMatch(kind === "date" ? /2026-01-03/u : /Tue(?:sday)?/u);
      expect(actual).not.toMatch(kind === "date" ? /2026-01-02/u : /Mon(?:day)?/u);
      expect(fromFhirDosage(input).longText).toMatch(kind === "date" ? /2026-01-03/u : /Tue(?:sday)?/u);
    }
    saved = persist(saved);
    if (kind === "date") setDosageExcludedDates(saved, []);
    else setDosageExcludedWeekdays(saved, []);
    for (const input of [saved, persist(saved)]) {
      expect(dosageMatchesSavedProjection(input)).toBe(false);
      expect(formatSig(input, "long")).not.toMatch(kind === "date" ? /2026-01-0[23]/u : /Mon(?:day)?|Tue(?:sday)?/u);
    }
    expect(saved.text).toBe(row.text);
  });

  it.each(["date", "weekday"] as const)("renders live %s exclusions when a standalone row has no source proof", kind => {
    const row: FhirDosage = { text: "Take one tablet daily.", doseAndRate: [{ doseQuantity: q(1) }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } } };
    if (kind === "date") setDosageExcludedDates(row, ["2026-01-02"]);
    else setDosageExcludedWeekdays(row, [FhirDayOfWeek.Monday]);
    expect(formatSig(row, "long")).toMatch(kind === "date" ? /2026-01-02/u : /Mon(?:day)?/u);
    expect(fromFhirDosage(row).longText).toMatch(kind === "date" ? /2026-01-02/u : /Mon(?:day)?/u);
    expect(row.text).toBe("Take one tablet daily.");
  });

  it("uses a newly submitted extended R5 excluded-date array without reviving stale text", () => {
    const row = persist(toEzDosages([parseSig("Take 1 tablet daily").fhir[0]])[0]);
    row.excludedDates = ["2026-01-02"];
    expect(formatSig(row, "long")).toContain("2026-01-02");
    let saved = persist(withDosageEditProvenance([row], "Take one tablet except 2026-01-02.")[0]);
    expect(dosageMatchesSavedProjection(saved)).toBe(true);
    saved = persist(saved);
    saved.excludedDates![0] = "2026-01-03";
    expect(dosageMatchesSavedProjection(saved)).toBe(false);
    expect(formatSig(saved, "long")).toContain("2026-01-03");
  });

  it("retains normalized source-only maxima beside a restored annotated site reference", () => {
    const site: NonNullable<FhirR6Dosage["site"]> = { reference: {
      reference: "BodyStructure/right", _reference: { id: "authored-reference" },
      type: "BodyStructure", _type: { id: "authored-type" },
      display: "Right eye", _display: { id: "authored-display" }
    } };
    const rows = persist(toFhirR5Dosages(course({ site })));
    const pending = { numerator: { _value: { id: "authored-maximum" } } };
    rows[0].maxDosePerPeriod = [pending];
    const before = JSON.stringify(rows);
    let output = toDosageDetails(rows);
    for (let save = 0; save < 3; save++) {
      const component = output.step![0].component[0];
      expect(component.site).toEqual(site);
      expect(component.safety?.doseLimit ?? []).toEqual([]);
      expect(JSON.stringify(component.extension)).toContain("authored-maximum");
      output = toDosageDetails(persist(toFhirR5Dosages(output)));
    }
    expect(JSON.stringify(rows)).toBe(before);
  });

  it.each([false, true])("carries a restored historical stage start and count beside another compact sequence (reverse %s)", reverse => {
    const start = { contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] },
      offsetDuration: { value: 3, unit: "d" } };
    const end = { ...start, offsetDuration: { value: 4, unit: "d" } };
    const step: FhirR6DosageStep = { id: "historical", start, end, count: 2,
      component: [{ id: "first", doseAndRate: [{ doseQuantity: q(1) }] }] };
    const historical: FhirDosage = { id: "first", sequence: 1, doseAndRate: [{ doseQuantity: q(1) }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] } },
      modifierExtension: [{ url: DOSAGE_DETAILS_R5_URL, extension: [
        { url: "dosageDetails", extension: [encodeR6SourceMetadata("step", step, "step")] }
      ] }] };
    const compact = toFhirR5Dosages(course({ doseAndRate: [
      { doseQuantity: simpleQuantityForR5({ ...q(2), comparator: "~" })! }
    ] }))[0];
    compact.sequence = 2;
    const marker = compact.modifierExtension!.find(value => value.url === DOSAGE_DETAILS_R5_URL)!;
    marker.extension!.find(value => value.url === "sequence")!.valueInteger = 2;
    marker.extension!.find(value => value.url === "stepCount")!.valueInteger = 2;
    const input = persist(reverse ? [compact, historical] : [historical, compact]);
    const before = JSON.stringify(input);
    const native = courseFromR5(input);
    expect(native.stages[0].start).toMatchObject({ anchor: "treatment-start", displacement: { value: 3, unit: "d" } });
    expect(native.stages[0].end).toMatchObject({ anchor: "treatment-start", displacement: { value: 4, unit: "d" } });
    expect(native.stages[0].count).toBe(2);
    let output = toDosageDetails(input);
    for (let save = 0; save < 3; save++) {
      expect(output.step![0].start).toEqual(start);
      expect(output.step![0].end).toEqual(end);
      expect(output.step![0].count).toBe(2);
      expect(output.step![0].component[0].doseAndRate![0].doseQuantity!.value).toBe(1);
      output = toDosageDetails(persist(toFhirR5Dosages(output)));
    }
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(["administration", "period", "lifetime"] as const)("honors normalized Thai formatting for an external %s cap", scope => {
    const row: FhirDosage = { text: "Take one tablet daily. Do not exceed two tablets.",
      doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
      ...(scope === "administration" ? { maxDosePerAdministration: q(2) } :
        scope === "lifetime" ? { maxDosePerLifetime: q(2) } :
        { maxDosePerPeriod: [{ numerator: q(2), denominator: { value: 1, unit: "d" } }] }) };
    const before = JSON.stringify(row);
    const options = { locale: "th", realizationMode: "normalized" as const };
    for (const actual of [formatSig(row, "long", options), fromFhirDosage(row, options).longText]) {
      const [current, original] = actual.split("; ข้อความเดิม: ");
      expect(current).toMatch(/1 เม็ด/u);
      expect(current).toContain("วันละครั้ง");
      expect(current).toContain(scope === "administration" ? "max per administration: 2 tab" :
        scope === "lifetime" ? "max lifetime: 2 tab" : "max per period: 2 tab / 1 d");
      expect(current).not.toMatch(/Take one tablet/u);
      expect(original).toBe(row.text);
    }
    const currentCap = scope === "administration" ? "max per administration: 2 tab" :
      scope === "lifetime" ? "max lifetime: 2 tab" : "max per period: 2 tab / 1 d";
    for (const text of [formatSig(row, "long", { realizationMode: "roundtrip" }),
      fromFhirDosage(row, { realizationMode: "roundtrip" }).longText])
      expect(text.split("; original directions: ")).toEqual([`Current: Use 1 tablet once daily; ${currentCap}`, row.text]);
    expect(JSON.stringify(row)).toBe(before);
  });

  it("keeps an annotation-only period numerator out of the active safety mirror", () => {
    const valid = { numerator: q(2), denominator: { value: 1, unit: "d" } };
    const pending = { id: "pending", numerator: { _value: { id: "numerator-note" } },
      denominator: { value: 1, unit: "d" } };
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }], maxDosePerPeriod: [valid, pending] };
    const lifted = toEzDosages([persist(row)])[0];
    // Partial values stay nonnumeric while remaining visible to the editor.
    expect(lifted.safety?.doseLimit).toEqual([
      { scope: "period", valueQuantity: q(2), period: { value: 1, unit: "d" } },
      { id: "pending", scope: "period", valueQuantity: pending.numerator, period: pending.denominator },
    ]);
    const output = toDosageDetails([lifted]);
    expect(output.step![0].component[0].safety?.doseLimit).toHaveLength(2);
    expect(output.step![0].component[0].safety?.doseLimit?.[1].valueQuantity?.value).toBeUndefined();
    expect(JSON.stringify(output.step![0].component[0].extension)).toContain("numerator-note");
    expect(toFhirR5Dosages(output)[0].maxDosePerPeriod).toEqual([valid, pending]);
  });
  it.each(["value", "unit", "code", "system", "comparator", "ema", "removed"] as const)(
    "imports newly submitted administration-duration %s values", field => {
      const quantity = quantityForR5({ value: 2, unit: "h", code: "h", system: "http://unitsofmeasure.org", comparator: "~" })!;
      const original: FhirDosage = { doseAndRate: [{ rateQuantity: { value: 5, unit: "mL/h" } }],
        timing: { repeat: { extension: [{ url: TIMING_ADMINISTRATION_DURATION_EXTENSION_URL, valueQuantity: quantity }] } } };
      expect(importCanonicalCourse(original).stages[0].administrations[0].schedule?.recurrence).toMatchObject({
        occurrenceDuration: 2, occurrenceDurationUnit: "h", occurrenceDurationComparator: "~",
      });
      const submitted = persist(original);
      const current = submitted.timing!.repeat!.extension![0].valueQuantity!;
      if (field === "value") current.value = 3;
      else if (field === "unit") current.unit = "min";
      else if (field === "code") current.code = "min";
      else if (field === "system") current.system = "urn:test:duration-unit";
      else if (field === "comparator") current.comparator = ">";
      else if (field === "ema") current.extension![0].valueCoding!.code = "100000000051";
      else submitted.timing!.repeat!.extension!.length = 0;
      const before = persist(submitted);
      const recurrence = importCanonicalCourse(submitted).stages[0].administrations[0].schedule?.recurrence;
      expect(recurrence?.occurrenceDuration).toBe(field === "removed" ? undefined : field === "value" ? 3 : 2);
      if (field !== "removed") {
        expect(recurrence?.occurrenceDurationUnit).toBe(field === "system" ? undefined : field === "code" ? "min" : "h");
        expect(recurrence?.occurrenceDurationComparator).toBe(field === "comparator" || field === "ema" ? ">" : "~");
      }
      expect(submitted).toEqual(before);
    });

  it("keeps first-marker semantics for an incomplete administration duration", () => {
    const empty: FhirExtension = { url: TIMING_ADMINISTRATION_DURATION_EXTENSION_URL };
    const timing = { repeat: { extension: [empty,
      { url: TIMING_ADMINISTRATION_DURATION_EXTENSION_URL, valueQuantity: { value: 8, unit: "h" } }] } };
    const original: FhirDosage = { doseAndRate: [{ rateQuantity: { value: 5, unit: "mL/h" } }], timing };
    expect(importCanonicalCourse(original).stages[0].administrations[0].schedule?.recurrence?.occurrenceDuration).toBeUndefined();
    const laterMarkerEdit = persist(original);
    laterMarkerEdit.timing!.repeat!.extension![1].valueQuantity!.value = 9;
    expect(importCanonicalCourse(laterMarkerEdit).stages[0].administrations[0].schedule?.recurrence?.occurrenceDuration).toBeUndefined();
    const firstMarkerEdit = persist(laterMarkerEdit);
    firstMarkerEdit.timing!.repeat!.extension![0].valueQuantity = { value: 2, unit: "h", comparator: ">" };
    expect(importCanonicalCourse(firstMarkerEdit).stages[0].administrations[0].schedule?.recurrence).toMatchObject({
      occurrenceDuration: 2, occurrenceDurationUnit: "h", occurrenceDurationComparator: ">",
    });
  });

  it("uses a newly submitted rate-duration value instead of stale wording", () => {
    const row: FhirDosage = { text: "Infuse at 5 mL/hour over approximately two hours.",
      doseAndRate: [{ rateQuantity: { value: 5, unit: "mL/h" } }], timing: { repeat: { extension: [{
        url: TIMING_ADMINISTRATION_DURATION_EXTENSION_URL,
        valueQuantity: quantityForR5({ value: 2, unit: "h", comparator: "~" }),
      }] } } };
    let saved = persist(withDosageEditProvenance([row], row.text)[0]);
    expect(dosageMatchesSavedProjection(saved)).toBe(true);
    expect(formatSig(saved, "long", { realizationMode: "roundtrip" })).toBe(row.text);
    saved = persist(saved);
    saved.timing!.repeat!.extension![0].valueQuantity!.value = 3;
    for (const input of [saved, persist(saved)]) {
      expect(dosageMatchesSavedProjection(input)).toBe(false);
      const native = courseFromR5([input]);
      expect(native.stages[0].administrations[0].schedule?.recurrence).toMatchObject({
        occurrenceDuration: 3, occurrenceDurationUnit: "h", occurrenceDurationComparator: "~",
      });
      expect(formatSig(input, "long")).not.toBe(row.text);
    }
    expect(saved.text).toBe(row.text);
  });
});


describe("round31 interchange owners and retained annotations", () => {
  const historicalMarker = (source: FhirR6DosageInstruction): FhirExtension => {
    const { step, ...header } = source;
    const fields = encodeR5RetainedFields({ course: header }).find(item => item.url === "course")?.extension ?? [];
    return { url: DOSAGE_DETAILS_R5_URL, extension: [{ url: "dosageDetails",
      extension: [...fields, ...(step ?? []).map(value => encodeR6SourceMetadata("step", value, "step"))] }] };
  };
  const compactRow = (sequence = 1): FhirDosage => {
    const row = toFhirR5Dosages(course({ doseAndRate: [
      { doseQuantity: simpleQuantityForR5({ ...q(2), comparator: "~" })! }
    ] }))[0];
    row.sequence = sequence;
    const marker = row.modifierExtension!.find(item => item.url === DOSAGE_DETAILS_R5_URL)!;
    marker.extension!.find(item => item.url === "sequence")!.valueInteger = sequence;
    marker.extension!.find(item => item.url === "stepCount")!.valueInteger = sequence;
    return row;
  };

  it.each([1, 2])("keeps a historical exact-match offset on its external sequence %s", sequence => {
    const repeat = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day };
    const offset = { value: 2, unit: "d", code: "d" };
    const member = { id: "historical-dose", doseAndRate: [{ doseQuantity: q(1) }],
      timing: { repeat: { ...repeat, startOffset: offset } } };
    const steps = sequence === 1 ? [{ component: [member] }]
      : [{ component: [{ doseAndRate: [{ doseQuantity: q(3) }] }] }, { component: [member] }];
    const historical: FhirDosage = { id: member.id, sequence, doseAndRate: member.doseAndRate,
      timing: { repeat }, modifierExtension: [historicalMarker({ step: steps })] };
    const input = persist([compactRow(sequence === 1 ? 2 : 1), historical]);
    const before = JSON.stringify(input);
    let actual = toDosageDetails(input);
    for (let save = 0; save < 3; save++) {
      const found = actual.step![sequence - 1].component.find(item => item.id === member.id)!;
      expect(found.timing!.repeat!.startOffset).toEqual(offset);
      expect(found.doseAndRate![0].doseQuantity!.value).toBe(1);
      actual = toDosageDetails(persist(toFhirR5Dosages(actual)));
    }
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each([false, true])("carries an unambiguous historical course repeat beside a local compact row (reverse %s)", reverse => {
    const repeatCycle = { value: 28, unit: "d", code: "d" };
    const historical: FhirDosage = { sequence: 1, doseAndRate: [{ doseQuantity: q(1) }],
      modifierExtension: [historicalMarker({ repeatCycle, step: [{ component: [{ doseAndRate: [{ doseQuantity: q(1) }] }] }] })] };
    const rows = reverse ? [compactRow(), historical] : [historical, compactRow()];
    let actual = toDosageDetails(persist(rows));
    for (let save = 0; save < 3; save++) {
      expect(actual.repeatCycle).toEqual(repeatCycle);
      expect(actual.step![0].component.map(value => value.doseAndRate![0].doseQuantity!.value).sort()).toEqual([1, 2]);
      actual = toDosageDetails(persist(toFhirR5Dosages(actual)));
    }
    expect(toDosageDetails(rows, undefined, { repeatCycle: { value: 14, unit: "d", code: "d" } }).repeatCycle)
      .toEqual({ value: 14, unit: "d", code: "d" });
  });

  it("marks incompatible historical and compact shared headers unresolved while retaining both", () => {
    const oldCycle = { value: 28, unit: "d", code: "d" }, newCycle = { value: 14, unit: "d", code: "d" };
    const historical: FhirDosage = { sequence: 1, doseAndRate: [{ doseQuantity: q(1) }],
      modifierExtension: [historicalMarker({ repeatCycle: oldCycle,
        step: [{ component: [{ doseAndRate: [{ doseQuantity: q(1) }] }] }] })] };
    const compact = toFhirR5Dosages({ repeatCycle: newCycle, step: [{ component: [{
      doseAndRate: [{ doseQuantity: simpleQuantityForR5({ ...q(2), comparator: "~" })! }]
    }] }] })[0];
    const rows = persist([historical, compact]);
    expect(importCanonicalCourse(rows).contextIssue).toBe("missing-course-context");
    const actual = toDosageDetails(rows);
    expect(JSON.stringify(actual)).toContain('"value":28');
    expect(JSON.stringify(actual)).toContain('"value":14');
    expect(() => nextDueDoses(actual, { from: "2026-01-01T00:00:00Z",
      orderedAt: "2026-01-01T00:00:00Z", timeZone: "UTC", limit: 2 })).toThrow(/shared course metadata/i);
  });

  it("unions phase and missing-header reasons and retains the phase conflict when the header is supplied", () => {
    const rows: FhirDosage[] = [1, 2].map((count, rowIndex) => ({
      sequence: 1, doseAndRate: [{ doseQuantity: q(count) }], modifierExtension: [{
        url: DOSAGE_DETAILS_R5_URL, extension: encodeR5RetainedFields({
          rowIndex, sequence: 1, stepCount: 1, context: "absent-header", contextRequired: true, step: { count },
        }),
      }],
    }));
    const absent = importCanonicalCourse(persist(rows));
    expect(absent.contextIssue).toBe("conflicting-course-phase");
    for (const member of absent.stages[0].administrations)
      expect(new Set(member.missingContexts)).toEqual(new Set(["conflicting-phase", "absent-header"]));
    rows[0].modifierExtension![0].extension!.push(...encodeR5RetainedFields({ course: { id: "shared-header" } }));
    const resolved = importCanonicalCourse(persist(rows));
    expect(resolved.contextIssue).toBe("conflicting-course-phase");
    for (const member of resolved.stages[0].administrations)
      expect(member.missingContexts).toEqual(["conflicting-phase"]);
  });

  it.each(["course", "step"] as const)("reserves the edited %s ID before anonymous safety shape matching", owner => {
    const identified = { doseLimit: [{ id: "daily-cap", scope: "period" as const,
      valueQuantity: q(8), period: { value: 1, unit: "d" } }],
      modifierExtension: [{ url: "urn:test:identified-policy", valueString: owner }] };
    const anonymous = { doseLimit: [{ scope: "administration" as const, valueQuantity: q(2) }],
      modifierExtension: [{ url: "urn:test:anonymous-policy", valueString: "deleted" }] };
    const source = { safety: owner === "course" ? identified : anonymous,
      step: [{ sequence: 1, safety: owner === "step" ? identified : anonymous }] };
    let actual = persist(toDosageDetails([{ sequence: 1, doseAndRate: [{ doseQuantity: q(1) }] }], undefined, source));
    const replacement = { id: "daily-cap", scope: "administration" as const, valueQuantity: q(2) };
    actual.safety!.doseLimit = [replacement];
    for (let save = 0; save < 3; save++) {
      actual = r6Save(actual);
      const marker = actual.safety!.modifierExtension!.find(item => item.url === R6_SCOPED_SAFETY_MODIFIER_URL)!;
      const scoped = decodeR6SourceMetadata(marker, "safety") as { course: typeof identified; step: typeof identified };
      expect(scoped[owner].doseLimit).toEqual([replacement]);
      expect(scoped[owner === "course" ? "step" : "course"].doseLimit).toBeUndefined();
      expect(JSON.stringify(actual.safety!.extension)).toContain("urn:test:anonymous-policy");
      expect(actual.safety!.doseLimit).toEqual([replacement]);
    }
  });

  it("keeps the unique anonymous amount edit on its original policy", () => {
    const source = { safety: { doseLimit: [{ scope: "period" as const, valueQuantity: q(8), period: { value: 1, unit: "d" } }] },
      step: [{ sequence: 1, safety: { doseLimit: [{ scope: "administration" as const, valueQuantity: q(2) }],
        modifierExtension: [{ url: "urn:test:anonymous-policy", valueString: "keep" }] } }] };
    let actual = persist(toDosageDetails([{ sequence: 1, doseAndRate: [{ doseQuantity: q(1) }] }], undefined, source));
    actual.safety!.doseLimit![1].valueQuantity!.value = 3;
    actual = r6Save(actual);
    const marker = actual.safety!.modifierExtension!.find(item => item.url === R6_SCOPED_SAFETY_MODIFIER_URL)!;
    const scoped = decodeR6SourceMetadata(marker, "safety") as { step: typeof source.step[0]["safety"] };
    expect(scoped.step.doseLimit).toEqual([{ scope: "administration", valueQuantity: q(3) }]);
    expect(scoped.step.modifierExtension).toEqual(source.step[0].safety.modifierExtension);
  });

  it("keeps missing-context wrapper annotations as current reasons change and resolve", () => {
    const marker: FhirExtension = { id: "context-wrapper", url: DOSAGE_DETAILS_R5_URL, extension: [
      { id: "reason-note", url: "missingContext", valueString: "missing-one" },
      { url: "urn:test:context-note", valueString: "retain authored note" },
    ] };
    let actual = r6Save(course({ modifierExtension: [marker] }));
    expect(actual.step![0].component[0].modifierExtension).toContainEqual(marker);
    for (let save = 0; save < 2; save++) {
      const rows = persist(toFhirR5Dosages(actual));
      const currentAnnotation = { url: "urn:test:live-modifier", valueString: "current" };
      if (!save) rows[0].modifierExtension!.push(currentAnnotation);
      actual = toDosageDetails(rows);
      expect(actual.step![0].component[0].modifierExtension).toContainEqual(marker);
      expect(actual.step![0].component[0].modifierExtension).toContainEqual(currentAnnotation);
    }
    const current = actual.step![0].component[0].modifierExtension!.find(item => item.url === marker.url)!;
    current.extension![0].valueString = "missing-two";
    actual = r6Save(actual);
    expect(actual.step![0].component[0].modifierExtension).toContainEqual({
      ...marker, extension: [{ ...marker.extension![0], valueString: "missing-two" }, marker.extension![1]],
    });
    const resolved = actual.step![0].component[0].modifierExtension!.find(item => item.url === marker.url)!;
    resolved.extension = resolved.extension!.filter(item => item.url !== "missingContext");
    actual = r6Save(actual);
    expect(importCanonicalCourse(actual).contextIssue).toBeUndefined();
    expect(JSON.stringify(actual.step![0].component[0].extension)).toContain("context-wrapper");
    expect(JSON.stringify(actual.step![0].component[0].extension)).toContain("retain authored note");
    expect(JSON.stringify(actual.step![0].component[0].modifierExtension ?? [])).not.toContain("missing-two");
    const compact = persist(toFhirR5Dosages(course({ modifierExtension: [marker] })));
    const active = compact[0].modifierExtension!.find(item => item.url === marker.url)!;
    active.extension = active.extension!.filter(item => item.url !== "missingContext");
    const cleared = toDosageDetails(compact);
    expect(importCanonicalCourse(cleared).contextIssue).toBeUndefined();
    expect(JSON.stringify(cleared.step![0].component[0].extension)).toContain("context-wrapper");
    expect(JSON.stringify(cleared.step![0].component[0].modifierExtension ?? [])).not.toContain("missing-one");
  });

  it.each([false, true])("keeps a second step modifier wrapper as inert source (annotated %s)", annotated => {
    const url = "urn:ezmedicationinput:StructureDefinition:r5-step-modifier-extensions";
    const first = { id: "owner-wrapper", url, extension: [{ url: "urn:test:owner", valueString: "first" }] };
    const second = { ...(annotated ? { id: "secondary-wrapper" } : {}), url,
      extension: [{ url: "urn:test:secondary", valueString: "second" }] };
    const input = course(); input.step![0].extension = [first, second];
    const edit = persist(fromDosageDetails(input));
    edit.course.step![0].modifierExtension = [{ url: "urn:test:owner", valueString: "edited" }];
    let actual = toDosageDetails(edit.dosages, undefined, edit.course);
    for (let save = 0; save < 3; save++) {
      const extensions = actual.step![0].extension!;
      expect(extensions.filter(item => item.url === url)).toEqual([{ ...first, extension: edit.course.step![0].modifierExtension }]);
      expect(extensions.find(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL)!.extension).toContainEqual(second);
      actual = toDosageDetails(persist(toFhirR5Dosages(actual)));
    }
  });

  it.each(["historical", "compact"] as const)("keeps a flattened %s reconciliation envelope ID without copying its children twice", codec => {
    const child = { url: "urn:test:history-child", valueString: "unique-leaf" };
    const wrapper = { id: "history-envelope", url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [child] };
    const source = { extension: [wrapper], step: [{ component: [{ doseAndRate: [{ doseQuantity: q(1) }] }] }] };
    const rows: FhirDosage[] = codec === "historical"
      ? [{ sequence: 1, doseAndRate: [{ doseQuantity: q(1) }], modifierExtension: [historicalMarker(source)] }]
      : toFhirR5Dosages(source);
    let actual = toDosageDetails(persist(rows), undefined, { extension: [{ url: "urn:test:current-note", valueString: "current" }] });
    for (let save = 0; save < 3; save++) {
      const encoded = JSON.stringify(actual.extension);
      expect(encoded).toContain("history-envelope");
      expect(encoded.match(/unique-leaf/g)).toHaveLength(1);
      expect(encoded).toContain("urn:test:current-note");
      actual = toDosageDetails(persist(toFhirR5Dosages(actual)));
    }
  });

  it.each(["approximately equal to", "custom local wording", "less than or equal to"])(
    "reconciles a code-only EMA edit with %s without dropping original annotations", display => {
      const coding = { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000052", display,
        _display: { id: "display-note" } };
      const original = { ...q(5), extension: [{ id: "operator-wrapper", url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL, valueCoding: coding }] };
      const before = JSON.stringify(original);
      const projected = simpleQuantityForR5(quantityFromR5(original))!;
      const publicProjection = toFhirR5Dosages([{ doseAndRate: [{ doseQuantity: original }] }])[0]
        .doseAndRate![0].doseQuantity!;
      expect(publicProjection.extension!.find(item => item.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL)!.valueCoding)
        .toEqual(projected.extension!.find(item => item.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL)!.valueCoding);
      const active = projected.extension!.find(item => item.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL)!;
      expect(getQuantityComparator(projected)).toBe("<=");
      expect(active.id).toBe("operator-wrapper");
      if (display === "approximately equal to") {
        expect(active.valueCoding!.display).toBe("less than or equal to");
        expect(projected.extension).toContainEqual({ url: "urn:ezmedicationinput:StructureDefinition:quantity-operator-source", valueCoding: coding });
      } else expect(active.valueCoding).toEqual(coding);
      expect(JSON.stringify(original)).toBe(before);
    });
});

describe("round32 interchange ownership family", () => {
  const relative = (days: number) => ({
    contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] },
    offsetDuration: { value: days, unit: "d" },
  });
  const following = { contextCode: { coding: [{
    system: "urn:ezmedicationinput:CodeSystem:course-phase-event", code: "previous-phase-next-day",
  }] } };
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] };
  const pause = (identified = true) => toDosageDetails([
    { sequence: 1, doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } },
    { sequence: 3, doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: { ...daily, count: 2 } } },
  ], undefined, { step: [
    { sequence: 1, ...(identified ? { id: "induction" } : {}), end: relative(2) },
    { sequence: 2, id: "planned-pause", end: relative(5), extension: [{ url: "urn:test:pause-note", valueString: "resume January 6" }] },
    { sequence: 3, ...(identified ? { id: "maintenance" } : {}), start: following },
  ] });
  const scheduleOptions = { from: "2026-01-01T00:00:00Z", orderedAt: "2026-01-01T00:00:00Z", timeZone: "UTC", limit: 4 };

  it.each([false, true])("keeps a planned pause after a successor dose edit (identified %s)", identified => {
    let wire = persist(pause(identified));
    wire.step![1].component[0].doseAndRate![0].doseQuantity!.value = 3;
    const before = JSON.stringify(wire);
    for (let save = 0; save < 3; save++) {
      const native = importCanonicalCourse(wire);
      expect(native.stages.map(stage => stage.administrations.length)).toEqual([1, 0, 1]);
      expect(native.stages[1].end).toMatchObject({ anchor: "treatment-start", displacement: { value: 5, unit: "d" } });
      expect(native.stages[2].administrations[0].amounts![0]).toMatchObject({ quantity: { value: 3, unit: "tab" } });
      expect(nextDueDoses(wire, scheduleOptions)).toEqual([
        "2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00",
        "2026-01-06T08:00:00+00:00", "2026-01-07T08:00:00+00:00",
      ]);
      if (!save) expect(JSON.stringify(wire)).toBe(before);
      wire = save === 1 ? toDosageDetails(persist(toFhirR5Dosages(wire))) : r6Save(wire);
    }
  });

  it("keeps a planned pause after a predecessor dose edit at the implicit treatment origin", () => {
    let wire = toDosageDetails([
      { sequence: 1, doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: { ...daily, count: 2 } } },
      { sequence: 3, doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: { ...daily, count: 2 } } },
    ], undefined, { step: [{ sequence: 2, end: relative(5) }, { sequence: 3, start: following }] });
    wire.step![0].component[0].doseAndRate![0].doseQuantity!.value = 3;
    for (let save = 0; save < 3; save++) {
      expect(importCanonicalCourse(wire).stages.map(stage => stage.administrations.length)).toEqual([1, 0, 1]);
      expect(nextDueDoses(wire, scheduleOptions)).toEqual([
        "2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00",
        "2026-01-06T08:00:00+00:00", "2026-01-07T08:00:00+00:00",
      ]);
      wire = r6Save(wire);
    }
    const reordered = persist(wire); reordered.step!.reverse();
    expect(importCanonicalCourse(reordered).stages.map(stage => stage.administrations.length)).toEqual([1, 1]);
    const changedBoundary = persist(wire); changedBoundary.step![0].component[0].timing!.repeat!.count = 3;
    expect(importCanonicalCourse(changedBoundary).stages.map(stage => stage.administrations.length)).toEqual([1, 1]);
  });

  it.each(["delete", "reorder", "boundary", "new-id"] as const)("does not reinstate a pause after an actual %s of its active stages", edit => {
    const wire = persist(pause());
    if (edit === "delete") wire.step!.shift();
    else if (edit === "reorder") wire.step!.reverse();
    else if (edit === "new-id") wire.step![1].id = "replacement";
    else wire.step![1].start = relative(7);
    const native = importCanonicalCourse(wire);
    expect(native.stages.every(stage => stage.administrations.length === 1)).toBe(true);
    if (edit === "boundary") expect(native.stages[1].start?.displacement?.value).toBe(7);
    expect(JSON.stringify(r6Save(wire).extension)).toContain("resume January 6");
  });

  it.each([false, true])("does not match ambiguous phase identities by position (identified %s)", identified => {
    const steps: FhirR6DosageStep[] = [
      { id: "pause", end: relative(5), component: [] },
      ...[1, 2].map(value => ({ ...(identified ? { id: "duplicate" } : {}), start: following,
        component: [{ doseAndRate: [{ doseQuantity: q(value) }] }] })),
    ];
    const wire = r6Save({ step: steps });
    wire.step![0].component[0].doseAndRate![0].doseQuantity!.value = 3;
    expect(importCanonicalCourse(wire).stages.map(stage => stage.administrations.length)).toEqual([1, 1]);
  });

  it.each([false, true])("keeps only authored course policy when a lifted step owner disappears (course policy %s)", authoredCourse => {
    let wire = toDosageDetails([{ sequence: 1, doseAndRate: [{ doseQuantity: q(1) }] }], undefined, {
      ...(authoredCourse ? { safety: { doseLimit: [{ scope: "lifetime", valueQuantity: q(50) }] } } : {}),
      step: [{ sequence: 1, id: "induction", safety: { doseLimit: [{ scope: "administration", valueQuantity: q(2) }],
        ifExceeded: "Review the induction dose" } }],
    });
    for (const remaining of ["replacement", "none"] as const) {
      let edited = persist(wire);
      edited.step = remaining === "replacement"
        ? [{ id: "maintenance", component: [{ doseAndRate: [{ doseQuantity: q(3) }] }] }] : [];
      for (let save = 0; save < 3; save++) {
        const native = importCanonicalCourse(edited);
        expect(native.safety?.limits?.map(limit => [limit.scope, limit.amount?.value]) ?? [])
          .toEqual(authoredCourse ? [["lifetime", 50]] : []);
        expect(native.safety?.ifExceeded).toBeUndefined();
        for (const stage of native.stages) expect(stage.safety).toBeUndefined();
        const output = r6Save(edited);
        expect(output.safety?.doseLimit ?? []).toEqual(authoredCourse ? [{ scope: "lifetime", valueQuantity: q(50) }] : []);
        expect(JSON.stringify(output.extension)).toContain("Review the induction dose");
        edited = save === 1 ? toDosageDetails(persist(toFhirR5Dosages(output))) : persist(output);
      }
    }
  });

  it.each(["anonymous-amount", "first-id", "replacement-id"] as const)(
    "reconciles scoped anonymous limits without borrowing a deleted policy (%s)", edit => {
      const source = { safety: { doseLimit: [{ scope: "period" as const, valueQuantity: q(8), period: { value: 1, unit: "d" } }] },
        step: [{ sequence: 1, id: "induction", safety: { doseLimit: [{ scope: "administration" as const, valueQuantity: q(2) }],
          ifExceeded: "Review this induction limit", modifierExtension: [{ url: "urn:test:induction-policy", valueBoolean: true }] } }] };
      let actual = persist(toDosageDetails([{ sequence: 1, doseAndRate: [{ doseQuantity: q(1) }] }], undefined, source));
      const current = actual.safety!.doseLimit![1];
      if (edit !== "anonymous-amount") current.id = "new-limit";
      if (edit !== "first-id") current.valueQuantity!.value = 3;
      for (let save = 0; save < 3; save++) {
        actual = r6Save(actual);
        expect(actual.safety!.doseLimit).toEqual([
          source.safety.doseLimit[0], { ...current },
        ]);
        const marker = actual.safety!.modifierExtension!.find(item => item.url === R6_SCOPED_SAFETY_MODIFIER_URL)!;
        const scoped = decodeR6SourceMetadata(marker, "safety") as { step: typeof source.step[0]["safety"] };
        expect(scoped.step.doseLimit ?? []).toEqual(edit === "replacement-id" ? [] : [current]);
        if (edit === "replacement-id") expect(JSON.stringify(actual.safety!.extension)).toContain("Review this induction limit");
      }
    });

  it.each([false, true])("preserves an empty historical phase beside compact rows (reversed %s)", reverse => {
    const steps: FhirR6DosageStep[] = [
      { id: "pause", end: relative(5), component: [], extension: [{ url: "urn:test:historic-pause", valueString: "five days" }] },
      { id: "resume", start: following, component: [{ id: "resumed-dose", doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } }] },
    ];
    const historical: FhirDosage = { id: "resumed-dose", sequence: 2, doseAndRate: [{ doseQuantity: q(1) }],
      timing: { repeat: daily }, modifierExtension: [{ url: DOSAGE_DETAILS_R5_URL, extension: [{
        url: "dosageDetails", extension: steps.map(step => encodeR6SourceMetadata("step", step, "step")),
      }] }] };
    const compact = toFhirR5Dosages(course({ doseAndRate: [{ doseQuantity: simpleQuantityForR5({ ...q(2), comparator: "~" })! }] }))[0];
    compact.sequence = 3;
    const marker = compact.modifierExtension!.find(item => item.url === DOSAGE_DETAILS_R5_URL)!;
    marker.extension!.find(item => item.url === "sequence")!.valueInteger = 3;
    marker.extension!.find(item => item.url === "stepCount")!.valueInteger = 3;
    expect(courseFromR5([persist(historical)]).stages[0].end?.displacement?.value).toBe(5);
    let rows = persist(reverse ? [compact, historical] : [historical, compact]);
    for (let save = 0; save < 3; save++) {
      const native = courseFromR5(rows);
      expect(native.stages.map(stage => stage.administrations.length)).toEqual([0, 1, 1]);
      expect(native.stages[0].end?.displacement?.value).toBe(5);
      expect(native.stages[1].administrations[0].missingContexts).toBeUndefined();
      expect(native.stages[1].administrations[0].amounts![0]).toMatchObject({ quantity: { value: 1, unit: "tab" } });
      expect(JSON.stringify(toDosageDetails(rows))).toContain("five days");
      rows = persist(toFhirR5Dosages(toDosageDetails(rows)));
    }
    const edited = toDosageDetails([historical, compact], undefined, { step: [{ sequence: 1, end: relative(7) }] });
    const changed = importCanonicalCourse(edited);
    expect(changed.stages[0].end?.displacement?.value).toBe(7);
    expect(changed.stages[0].provenance).toMatchObject({ id: "pause",
      extension: [{ url: "urn:test:historic-pause", valueString: "five days" }] });
    const removed = toDosageDetails([historical, compact], undefined, { step: [] });
    const retained = importCanonicalCourse(removed);
    expect(retained.stages.map(stage => stage.administrations.length)).toEqual([1, 1]);
    expect(retained.stages[0].administrations[0].amounts![0].quantity).toMatchObject({ value: 1, unit: "tab" });
    expect(JSON.stringify(removed.extension)).toContain("five days");
  });

  it.each(["course", "scalar", "later"] as const)("writes a self-consistent baseline after retaining annotated %s provenance", kind => {
    const input: FhirDosage = { text: "Take one tablet, maximum two per dose.", doseAndRate: [{ doseQuantity: q(1) }],
      maxDosePerAdministration: q(2) };
    let rows = withDosageEditProvenance([input], kind === "scalar" ? undefined : input.text);
    rows[0].extension!.find(item => item.url === DOSAGE_RENDERED_INSTRUCTION_R5_URL)!.id = "authored-baseline";
    const original = persist(rows[0].extension![0]);
    if (kind === "later") rows.unshift({ text: "Initial directions", doseAndRate: [{ doseQuantity: q(1) }] });
    const index = kind === "later" ? 1 : 0;
    const current = withDosageEditProvenance(rows, kind === "scalar" ? undefined : "Updated instructions")[index];
    expect(current.extension).toContainEqual({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [original] });
    expect(dosageMatchesSavedProjection(persist(current))).toBe(true);
    const changed = persist(current); changed.doseAndRate![0].doseQuantity!.value = 3;
    expect(dosageMatchesSavedProjection(changed)).toBe(false);
  });

  it.each([false, true])("keeps live day annotations separate from restored hour units (authored annotation %s)", annotated => {
    const authored = { value: 48, unit: "hours", system: "http://unitsofmeasure.org", code: "h",
      ...(annotated ? { _unit: { id: "hours-label" }, _code: { id: "hour-code" } } : {}) };
    // Existing source metadata retains an earlier projection. New saves keep
    // authored endpoints active, but import must still reconcile this source.
    const high = { value: 3, unit: "days", system: "http://unitsofmeasure.org", code: "d" };
    const projected = { low: { value: 2, unit: "days", system: "http://unitsofmeasure.org", code: "d" }, high };
    let row: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: { boundsRange: persist(projected) } },
      modifierExtension: [{ url: ANCHORED_COURSE_DURATION_EXTENSION_URL, extension: [
        { url: "low", valueQuantity: authored }, { url: "high", valueQuantity: high },
        retainField("projectedRange", projected),
      ] }] };
    const current = row.timing!.repeat!.boundsRange!.low!;
    current._unit = { id: "days-label" }; current._code = { id: "day-code" };
    row.timing!.repeat!.boundsRange!.low = simpleQuantityForR5({ ...current, comparator: "<=" })!;
    for (let save = 0; save < 3; save++) {
      const low = getAnchoredCourseDuration(row)?.valueRange?.low ?? row.timing?.repeat?.boundsRange?.low;
      expect(low).toMatchObject({ value: 48, unit: "hours", code: "h" });
      expect(getQuantityComparator(low)).toBe("<=");
      expect(importCanonicalCourse(row).stages[0].administrations[0].schedule?.recurrence?.courseLengthRange?.low)
        .toMatchObject({ value: 48, unit: "hours", code: "h", comparator: "<=" });
      expect(low?._unit).toEqual(annotated ? { id: "hours-label" } : undefined);
      expect(low?._code).toEqual(annotated ? { id: "hour-code" } : undefined);
      expect(JSON.stringify(low?.extension)).toContain("days-label");
      expect(JSON.stringify(low?.extension)).toContain("day-code");
      row = persist(toFhirR5Dosages([row])[0]);
    }
  });

  it("shows structured course limits on an editable zero-step carrier while retaining exact text-only headers", () => {
    const imported = fromFhir({ safety: { doseLimit: [{ scope: "period", valueQuantity: q(2), period: { value: 24, unit: "h" } }] } });
    expect(imported.items).toHaveLength(1);
    expect(imported.items[0].longText).toContain("2 tab");
    expect(imported.items[0].longText).toContain("24 h");
    expect(imported.items[0].shortText).toBe(imported.shortText);
    expect(imported.items[0].longText).toBe(imported.longText);
    const text = "Use according to the supplied plan.  Keep this spacing.";
    const textOnly = fromFhir({ renderedInstruction: text });
    expect(textOnly.items[0].shortText).toBe(text);
    expect(textOnly.items[0].longText).toBe(text);
  });
});
}



{

const parseSig = parsePublicSig;


const persist = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const q = (value: number) => ({ value, unit: "tab" });
const expression = (name: string) => ({ language: "text/fhirpath", expression: "%" + name });
const course = (component: Partial<FhirR6Dosage> = {}): FhirR6DosageInstruction => ({
  step: [{ component: [{ doseAndRate: [{ doseQuantity: q(1) }], ...component }] }],
});
const r6Save = (value: FhirR6DosageInstruction): FhirR6DosageInstruction => {
  return projectCanonicalCourse(importCanonicalCourse(persist(value))).fhirNext;
};



describe("round48 interop value ownership and primitive annotations", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] };
  const boundary = (value: number) => ({ contextCode: { coding: [{
    system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start",
  }] }, offsetDuration: { value, unit: "d" } });

  it.each([{ phase: 2, cycles: 3 }, { phase: 3, cycles: 4 }])(
    "keeps independently supplied phase $phase and course $cycles counts on legacy rows", ({ phase, cycles }) => {
      // Actual master 7d62823 wire fixture: its unmarked old count still uses
      // the established migration policy until the caller supplies both scopes.
      const rows: FhirDosage[] = [{
        timing: { repeat: { frequency: 1, boundsDuration: { value: 7, unit: "days", system: "http://unitsofmeasure.org", code: "d" }, period: 1, periodUnit: FhirPeriodUnit.Day } },
        text: "Use 1 tablet once daily for 7 days.", sequence: 1,
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab", system: "http://standardterms.edqm.eu", code: "15054000" } }],
        modifierExtension: [{ url: DOSAGE_DETAILS_R5_URL, extension: [
          { url: "rowIndex", valueInteger: 0 }, { url: "sequence", valueInteger: 1 }, { url: "stepCount", valueInteger: 1 },
          { url: "step", extension: [{ url: "count", valueInteger: 3 }] },
          { url: "context", valueString: "72f2f03d1f8289c5" }, { url: "contextRequired", valueBoolean: true },
          { url: "course", extension: [{ url: "repeatCycle", valueQuantity: { value: 14, unit: "d", code: "d", system: "http://unitsofmeasure.org" } }] },
        ] }], extension: [{ url: DOSAGE_RENDERED_INSTRUCTION_R5_URL, extension: [
          { url: "instruction", valueString: "1 tablet daily for 7 days then stop for 7 days, repeat for 3 cycles" },
          { url: "row", extension: [{ url: "projectionFingerprint", valueString: "4346df4e5678f52b" }, { url: "textFingerprint", valueString: "dab22a241c7d0f4f" }] },
        ] }],
      }];
      const edits = { modifierExtension: [{ url: COURSE_CYCLE_COUNT_EXTENSION_URL, valueInteger: cycles }],
        step: [{ sequence: 1, count: phase }] };
      const before = persist({ rows, edits });
      let wire = toDosageDetails(rows, undefined, edits);
      expect({ rows, edits }).toEqual(before);
      for (let save = 0; save < 3; save++) {
        expect(getCourseCycleCount(wire)).toBe(cycles);
        expect(wire.step![0].count).toBe(phase);
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      }
    }
  );

  it.each(["unchanged", "annotation", "row-text", "course-text", "copied-companion", "replacement"] as const)(
    "keeps only currently owned zero-step translations after a %s edit", edit => {
      const translation = (value: number): FhirExtension => ({
        url: "http://hl7.org/fhir/StructureDefinition/translation",
        extension: [{ url: "lang", valueCode: "th" }, { url: "content", valueString: "รับประทาน " + value + " เม็ด ทุกวัน" }],
      });
      const author = { url: "urn:test:author", valueString: "original" };
      const primitive = { id: "english-text", extension: [translation(1), author] };
      const source = { renderedInstruction: "Take 1 tablet daily", _renderedInstruction: primitive };
      const rows = persist(toFhirR5Dosages(source));
      const original = persist(rows[0].modifierExtension!.find(item => item.url === DOSAGE_DETAILS_R5_URL)!);
      const edited = edit === "row-text" || edit === "course-text" || edit === "copied-companion" || edit === "replacement";
      if (edit === "row-text" || edit === "replacement") rows[0].text = "Take 2 tablets daily";
      const edits: (EzCourseMetadata & Pick<FhirR6DosageInstruction, "_renderedInstruction">) | undefined =
        edit === "course-text" ? { renderedInstruction: "Take 2 tablets daily" }
        : edit === "copied-companion" ? { renderedInstruction: "Take 2 tablets daily", _renderedInstruction: persist(primitive) }
        : edit === "replacement" ? { _renderedInstruction: { id: "replacement-text", extension: [translation(2), author] } }
        : edit === "annotation" ? { extension: [{ url: "urn:test:course-note", valueString: "unchanged wording" }] }
        : undefined;
      const before = persist({ rows, edits, source });
      let wire = toDosageDetails(rows, undefined, edits);
      expect(persist({ rows, edits, source })).toEqual(before);
      for (let save = 0; save < 3; save++) {
        expect(wire.renderedInstruction).toBe(edited ? "Take 2 tablets daily" : source.renderedInstruction);
        expect(wire._renderedInstruction).toEqual(edit === "replacement" ? edits!._renderedInstruction
          : edited ? { id: primitive.id, extension: [author] } : primitive);
        if (edited) expect(wire.extension?.some(item =>
          item.url === DOSAGE_RECONCILIATION_SOURCE_URL && item.extension?.some(child =>
            JSON.stringify(child) === JSON.stringify(original)))).toBe(true);
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      }
    }
  );

  it.each(["_frequency", "_frequencyMax", "_period", "_periodMax", "_periodUnit",
    "_countMax", "_duration", "_durationMax", "_durationUnit", "_dayOfWeek", "_when", "_offset"] as const)(
    "keeps the editable pause after a %s annotation-only edit", field => {
      const repeat = { ...daily, frequencyMax: 1, periodMax: 1, count: 7, countMax: 7,
        duration: 1, durationMax: 1, durationUnit: FhirPeriodUnit.Hour };
      let wire = r6Save({ step: [
        { id: "induction", component: [{ id: "initial", doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat } }] },
        { id: "pause", end: boundary(14), component: [] },
        { id: "resume", component: [{ id: "later", doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: daily } }] },
      ] });
      const annotation = field === "_dayOfWeek" || field === "_when"
        ? [{ id: "cadence-annotation", extension: [{ url: "urn:test:note", valueString: "retain" }] }]
        : { id: "cadence-annotation", extension: [{ url: "urn:test:note", valueString: "retain" }] };
      (wire.step![0].component[0].timing!.repeat! as unknown as Record<string, unknown>)[field] = annotation;
      for (let save = 0; save < 3; save++) {
        const before = persist(wire), view = fromDosageDetails(wire);
        expect(view.course.step?.map(step => step.id)).toEqual(["induction", "pause", "resume"]);
        expect(wire).toEqual(before);
        const current = wire.step![0].component[0].timing!.repeat!;
        if (field === "_when") {
          const { timeOfDay, ...recurrence } = repeat;
          expect(current).toMatchObject(recurrence);
          expect(getTimingClocks(current)).toEqual(timeOfDay);
          if (save > 0) expect(current.timeOfDay).toBeUndefined();
        } else expect(current).toMatchObject(repeat);
        expect((current as unknown as Record<string, unknown>)[field]).toEqual(annotation);
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      }
    }
  );

  it.each(["frequency", "period", "semantic-extension", "unknown-companion"] as const)(
    "still retires the old pause on a %s completion edit", edit => {
      const wire = r6Save({ step: [
        { id: "induction", component: [{ id: "initial", doseAndRate: [{ doseQuantity: q(1) }],
          timing: { repeat: { ...daily, count: 7 } } }] },
        { id: "pause", end: boundary(14), component: [] },
        { id: "resume", component: [{ id: "later", doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: daily } }] },
      ] });
      const repeat = wire.step![0].component[0].timing!.repeat!;
      if (edit === "frequency" || edit === "period") repeat[edit] = 2;
      else if (edit === "semantic-extension") repeat.extension = [{ url: "urn:clinic:cadence-policy", valueString: "current" }];
      else (repeat as unknown as Record<string, unknown>)._clinicCadence = { id: "unfamiliar" };
      const before = persist(wire), view = fromDosageDetails(wire);
      expect(view.course.step?.map(step => step.id)).toEqual(["induction", "resume"]);
      expect(wire).toEqual(before);
    }
  );

  it.each([8, 9])("keeps metadata-only cycle-day children apart from numerical day %s", day => {
    const marker = { id: "cycle", url: CYCLE_DAY_ELIGIBILITY_EXTENSION_URL, extension: [
      { id: "metadata-only", url: "day", extension: [{ url: "urn:test:empty-day-note", valueString: "retained" }] },
      { id: "eighth-day", url: "day", valueInteger: day, _valueInteger: { id: "eight-value" } },
    ] };
    const rows: FhirDosage[] = [{ doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily }, modifierExtension: [marker] }];
    const before = persist(rows);
    let wire = toDosageDetails(rows);
    for (let save = 0; save < 3; save++) {
      const saved = persist(toFhirR5Dosages(wire));
      expect(saved[0].modifierExtension?.find(item => item.url === CYCLE_DAY_ELIGIBILITY_EXTENSION_URL)).toEqual(marker);
      wire = toDosageDetails(saved);
    }
    expect(rows).toEqual(before);
  });

  it("accepts and preserves Reference.identifier primitive companions in the public types", () => {
    const source = course({ site: { reference: {
      reference: "BodyStructure/site", identifier: {
        use: "official", _use: { id: "identifier-use" },
        system: "https://clinic.example/sites", _system: { id: "identifier-system" },
        value: "left-arm", _value: { id: "identifier-value", extension: [{ url: "urn:test:source", valueString: "authored" }] },
      },
    } } });
    const before = persist(source);
    let wire = source;
    for (let save = 0; save < 3; save++) {
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      expect(wire.step![0].component[0].site).toEqual(source.step![0].component[0].site);
    }
    expect(source).toEqual(before);
  });
});


describe("round48 source agreement default ownership", () => {
  it.each([true, false])("stores only row overrides of the %s containing default", agreement => {
    const rows: FhirDosage[] = [
      { text: "Take one tablet daily", doseAndRate: [{ doseQuantity: q(1) }] },
      { text: "Take two tablets daily", doseAndRate: [{ doseQuantity: q(2) }] },
    ];
    const before = persist(rows);
    const output = withDosageEditProvenance(rows, "Two independent directions", agreement,
      [{ sourceAgreement: agreement }, { sourceAgreement: !agreement }]);
    const marker = output[0].extension!.find(item => item.url === DOSAGE_RENDERED_INSTRUCTION_R5_URL)!;
    const baseline = marker.extension!.filter(item => item.url === "row");
    expect(marker.extension).toContainEqual({ url: "sourceAgreement", valueBoolean: agreement });
    expect(baseline[0].extension?.some(item => item.url === "sourceAgreement")).toBe(false);
    expect(baseline[1].extension).toContainEqual({ url: "sourceAgreement", valueBoolean: !agreement });
    expect(output.map(row => getDosageSourceTextAgreement(row))).toEqual([agreement, !agreement]);
    // Older generated rows redundantly repeated this same default. The public
    // importer reads either representation as the exact same course.
    const verbose = persist(output);
    verbose[0].extension!.find(item => item.url === DOSAGE_RENDERED_INSTRUCTION_R5_URL)!
      .extension!.find(item => item.url === "row")!.extension!
      .push({ url: "sourceAgreement", valueBoolean: agreement });
    expect(toDosageDetails(persist(output))).toEqual(toDosageDetails(verbose));
    const edited = persist(output);
    const stale = agreement ? 1 : 0;
    edited[stale].text = "Current explicit replacement instruction";
    expect(getDosageSourceTextAgreement(edited[stale])).toBe(true);
    expect(getDosageSourceTextAgreement(edited[stale], false)).toBe(false);
    expect(rows).toEqual(before);
  });

  it("retains an annotated prior equal flag as exact source when writing the compact default", () => {
    const rows = withDosageEditProvenance<FhirDosage>([
      { text: "Take one tablet daily", doseAndRate: [{ doseQuantity: q(1) }] },
    ], "Take one tablet daily", false);
    const original = rows[0].extension!.find(item => item.url === DOSAGE_RENDERED_INSTRUCTION_R5_URL)!;
    const annotated = { id: "external-agreement", url: "sourceAgreement", valueBoolean: false,
      _valueBoolean: { id: "external-primitive", extension: [{ url: "urn:clinic:agreement-note", valueString: "keep exact" }] } };
    original.extension!.find(item => item.url === "row")!.extension!.push(annotated);
    original.extension!.push({ url: "urn:clinic:foreign-baseline", valueString: "keep exact too" });
    const before = persist(rows), source = persist(original);
    const output = withDosageEditProvenance(rows, "Take one tablet daily", false);
    const marker = output[0].extension!.find(item => item.url === DOSAGE_RENDERED_INSTRUCTION_R5_URL)!;
    expect(marker.extension!.find(item => item.url === "row")!.extension!
      .some(item => item.url === "sourceAgreement")).toBe(false);
    expect(output[0].extension).toContainEqual({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [source] });
    expect(getDosageSourceTextAgreement(output[0])).toBe(false);
    expect(rows).toEqual(before);
    const reopened = toDosageDetails(persist(output));
    expect(reopened.step![0].component[0].extension)
      .toContainEqual({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [source] });
  });
});


describe("round49 current interop ownership", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] };
  const boundary = (value: number) => ({ contextCode: { coding: [{
    system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start",
  }] }, offsetDuration: { value, unit: "d" } });
  const options = { from: "2026-01-01T00:00:00Z", orderedAt: "2026-01-01T00:00:00Z", timeZone: "UTC", limit: 5 };

  it.each(["unchanged", "dose", "delete", "replace"] as const)(
    "keeps the live modifier list authoritative beside a historical full component (%s)", edit => {
      const policy: FhirExtension & { _valueString: FhirElement } = {
        id: "old-policy", url: "urn:clinic:member-policy", valueString: "current policy",
        _valueString: { extension: [{ url: "urn:clinic:opaque", valueString: "preserve policy annotation" }] } };
      const dates: FhirExtension = { id: "old-dates", url: DOSAGE_EXCLUDED_DATES_R5_URL, extension: [
        { id: "excluded-date", url: "date", valueDate: "2026-01-02" },
      ] };
      const site = { concept: { text: "left eye" }, reference: {
        reference: "BodyStructure/left-eye", identifier: { system: "urn:clinic:eye", value: "left" },
      } };
      const old: FhirR6Dosage = { id: "identified-dose", doseAndRate: [{ doseQuantity: q(1) }],
        timing: { repeat: daily }, site, modifierExtension: [policy, dates] };
      const marker: FhirExtension = { id: "historical-full-course", url: DOSAGE_DETAILS_R5_URL, extension: [{
        url: "dosageDetails", extension: [encodeR6SourceMetadata("step", {
          id: "loading", component: [old],
        }, "step")],
      }] };
      const modifiers = edit === "delete" ? [] : edit === "replace"
        ? [{ ...policy, valueString: "replacement policy" }, { ...dates, extension: [{ url: "date", valueDate: "2026-01-03" }] }]
        : [policy, dates];
      const annotation = { id: "live-row-note", url: "urn:clinic:row-note", valueString: "current external annotation" };
      let rows: FhirDosage[] = persist([{ id: old.id, sequence: 1, site: site.concept,
        doseAndRate: [{ doseQuantity: q(edit === "dose" ? 2 : 1) }], timing: { repeat: daily },
        ...(edit === "unchanged" ? {} : { extension: [annotation] }), modifierExtension: [marker, ...modifiers] }]);
      for (let save = 0; save < 3; save++) {
        const before = persist(rows), wire = toDosageDetails(rows), member = wire.step![0].component[0];
        expect(member.modifierExtension ?? []).toEqual(modifiers);
        expect(member.doseAndRate).toEqual([{ doseQuantity: q(edit === "dose" ? 2 : 1) }]);
        expect(member.site).toEqual(site);
        expect(getDosageExcludedDates({ modifierExtension: member.modifierExtension })).toEqual(
          edit === "delete" ? [] : [edit === "replace" ? "2026-01-03" : "2026-01-02"]);
        if (edit !== "unchanged") {
          expect(member.extension).toContainEqual(annotation);
          expect(wire.extension?.some(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL &&
            item.extension?.some(source => JSON.stringify(source) === JSON.stringify(marker)))).toBe(true);
        }
        expect(rows).toEqual(before);
        rows = persist(toFhirR5Dosages(wire));
      }
    }
  );

  it.each(["unchanged", "dose", "dates", "weekdays", "date-annotation", "weekday-annotation", "date-order", "weekday-order"] as const)(
    "keeps completion ownership after an administration exclusion %s edit", edit => {
      const dates: FhirExtension = { id: "original-dates", url: DOSAGE_EXCLUDED_DATES_R5_URL, extension: [
        { id: "original-date", url: "date", valueDate: "2026-01-03" },
        { url: "urn:clinic:exclusion-note", valueString: "preserve date metadata" },
      ] };
      const weekdays: FhirExtension = { id: "original-weekdays", url: DOSAGE_EXCLUDED_WEEKDAYS_R5_URL, extension: [
        { url: "day", valueCode: "sat", _valueCode: { id: "original-weekday" } },
        { url: "urn:clinic:weekday-note", valueString: "preserve weekday metadata" },
      ] };
      if (edit === "date-order") dates.extension!.push({ url: "date", valueDate: "2026-01-06" });
      if (edit === "weekday-order") weekdays.extension!.push({ url: "day", valueCode: "sun" });
      let wire = toDosageDetails([
        { sequence: 1, id: "initial", doseAndRate: [{ doseQuantity: q(1) }],
          timing: { repeat: { ...daily, count: 2 } }, modifierExtension: [dates], extension: [weekdays] },
        { sequence: 3, id: "later", doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: { ...daily, count: 2 } } },
      ], undefined, { step: [
        { sequence: 1, id: "induction" },
        { sequence: 2, id: "pause", end: boundary(3),
          extension: [{ id: "pause-note", url: "urn:clinic:pause-note", valueString: "original pause" }] },
        { sequence: 3, id: "resume" },
      ] });
      const draft = persist(wire.extension!.find(item => item.url === R6_DRAFT_STEPS_SOURCE_URL)!);
      const liveStart = persist(wire.step![1].start), member = wire.step![0].component[0];
      if (edit === "dose") member.doseAndRate![0].doseQuantity!.value = 3;
      if (edit === "dates") setDosageExcludedDates(member as FhirDosage, ["2026-01-02", "2026-01-03"]);
      if (edit === "weekdays") setDosageExcludedWeekdays(member as FhirDosage, [FhirDayOfWeek.Friday, FhirDayOfWeek.Saturday]);
      if (edit === "date-annotation") member.modifierExtension!.find(item => item.url === DOSAGE_EXCLUDED_DATES_R5_URL)!.extension![0].id = "current-date-note";
      if (edit === "weekday-annotation") member.extension!.find(item => item.url === DOSAGE_EXCLUDED_WEEKDAYS_R5_URL)!.extension![0]._valueCode = { id: "current-weekday-note" };
      if (edit === "date-order") member.modifierExtension!.find(item => item.url === DOSAGE_EXCLUDED_DATES_R5_URL)!.extension!.reverse();
      if (edit === "weekday-order") member.extension!.find(item => item.url === DOSAGE_EXCLUDED_WEEKDAYS_R5_URL)!.extension!.reverse();
      const completionChanged = edit === "dates" || edit === "weekdays";
      for (let save = 0; save < 3; save++) {
        const before = persist(wire), view = fromDosageDetails(wire);
        expect(view.course.step?.map(step => step.id)).toEqual(
          completionChanged ? ["induction", "resume"] : ["induction", "pause", "resume"]);
        if (!completionChanged) expect(view.course.step?.find(step => step.id === "pause")?.extension)
          .toEqual([{ id: "pause-note", url: "urn:clinic:pause-note", valueString: "original pause" }]);
        expect(wire.step![1].start).toEqual(liveStart);
        expect(nextDueDoses(wire, options)).toEqual(completionChanged ? [
          // The initial 1-tablet dose and resumed 2-tablet dose are two
          // distinct administrations at the preserved January 4 clock.
          "2026-01-01T09:00:00+00:00", "2026-01-04T09:00:00+00:00",
          "2026-01-04T09:00:00+00:00", "2026-01-05T09:00:00+00:00",
        ] : [
          "2026-01-01T09:00:00+00:00", "2026-01-02T09:00:00+00:00",
          "2026-01-04T09:00:00+00:00", "2026-01-05T09:00:00+00:00",
        ]);
        expect(calculateTotalUnits({ dosage: wire, ...options,
          durationValue: 5, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(edit === "dose" ? 10 : 6);
        expect(wire.step![0].component[0].doseAndRate![0].doseQuantity!.value).toBe(edit === "dose" ? 3 : 1);
        expect(wire).toEqual(before);
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
        if (completionChanged) expect(wire.extension?.some(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL &&
          item.extension?.some(source => JSON.stringify(source) === JSON.stringify(draft)))).toBe(true);
        expect(JSON.stringify(wire)).toContain("preserve date metadata");
        expect(JSON.stringify(wire)).toContain("preserve weekday metadata");
        if (edit === "date-annotation") expect(wire.step![0].component[0].modifierExtension!
          .find(item => item.url === DOSAGE_EXCLUDED_DATES_R5_URL)!.extension![0].id).toBe("current-date-note");
        if (edit === "weekday-annotation") expect(wire.step![0].component[0].extension!
          .find(item => item.url === DOSAGE_EXCLUDED_WEEKDAYS_R5_URL)!.extension![0]._valueCode).toEqual({ id: "current-weekday-note" });
      }
    }
  );

  it.each(["distinct-scopes", "distinct-amounts", "amount-edit", "duplicate-values"] as const)(
    "retains only uniquely unchanged anonymous phase limits (%s)", kind => {
      const first: FhirR6DoseLimit = { scope: "administration", valueQuantity: q(2), text: "phase cap" };
      const second: FhirR6DoseLimit = kind === "distinct-scopes"
        ? { scope: "period", valueQuantity: q(4), period: { value: 1, unit: "d" }, text: "daily cap" }
        : { ...first, valueQuantity: q(kind === "duplicate-values" ? 2 : 4) };
      let wire = toDosageDetails([{ id: "initial", doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } }],
        undefined, { step: [{ sequence: 1, id: "loading", safety: { doseLimit: [first, second] } }] });
      wire.step!.push({ id: "maintenance", component: [{ id: "later", doseAndRate: [{ doseQuantity: q(1) }],
        timing: { repeat: daily } }] });
      const annotation = { id: "limit-note", url: "urn:clinic:limit-note", valueString: "current annotation" };
      wire.safety!.doseLimit![0].extension = [annotation];
      wire.safety!.doseLimit![0].valueQuantity!._value = { id: "current-quantity-note" };
      if (kind === "amount-edit") wire.safety!.doseLimit![0].valueQuantity!.value = 3;
      const current = persist(wire.safety!.doseLimit![0]);
      for (let save = 0; save < 3; save++) {
        const before = persist(wire);
        const output = toDosageDetails(persist(toFhirR5Dosages(wire)));
        expect(output.step![1].safety).toBeUndefined();
        expect(output.step![0].safety?.doseLimit ?? []).toEqual(
          kind === "duplicate-values" ? [] : kind === "amount-edit" ? [second] : [current, second]);
        expect(output.safety?.doseLimit ?? []).toEqual(
          kind === "duplicate-values" ? [current, second] : kind === "amount-edit" ? [current] : []);
        expect(JSON.stringify(output)).toContain("current annotation");
        expect(JSON.stringify(output)).toContain("current-quantity-note");
        expect(wire).toEqual(before);
        wire = output;
      }
    }
  );
});


describe("round50 explicit interchange scope and primitive ownership", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] };
  const afterDays = (value: number) => ({ contextCode: { coding: [{
    system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start",
  }] }, offsetDuration: { value, unit: "d" } });
  const options = { from: "2026-01-01T00:00:00Z", orderedAt: "2026-01-01T00:00:00Z", timeZone: "UTC", limit: 6 };
  // Actual pinned-master writer output, including its unversioned count scope.
  const legacyRows: FhirDosage[] = [{"timing": {"repeat": {"frequency": 1, "boundsDuration": {"value": 7, "unit": "days", "system": "http://unitsofmeasure.org", "code": "d"}, "period": 1, "periodUnit": FhirPeriodUnit.Day}}, "text": "Use 1 tablet once daily for 7 days.", "sequence": 1, "doseAndRate": [{"doseQuantity": {"value": 1, "unit": "tab", "system": "http://standardterms.edqm.eu", "code": "15054000"}}], "modifierExtension": [{"url": "urn:ezmedicationinput:StructureDefinition:medication-r6-course-details", "extension": [{"url": "rowIndex", "valueInteger": 0}, {"url": "sequence", "valueInteger": 1}, {"url": "stepCount", "valueInteger": 1}, {"url": "step", "extension": [{"url": "count", "valueInteger": 3}]}, {"url": "context", "valueString": "aacf252a6b0e6e74"}, {"url": "contextRequired", "valueBoolean": true}, {"url": "course", "extension": [{"url": "repeatCycle", "valueQuantity": {"value": 28, "unit": "d", "code": "d", "system": "http://unitsofmeasure.org"}}]}]}], "extension": [{"url": "urn:ezmedicationinput:StructureDefinition:medication-rendered-instruction", "extension": [{"url": "instruction", "valueString": "1 tablet daily for 7 days then stop for 21 days, repeat for 3 cycles"}, {"url": "row", "extension": [{"url": "projectionFingerprint", "valueString": "975c16dd2e988203"}, {"url": "textFingerprint", "valueString": "dab22a241c7d0f4f"}]}]}]}];

  it.each([2, 3])("keeps phase count %s when the same public edit clears legacy course modifiers", phase => {
    const rows = persist(legacyRows), edits = { modifierExtension: [], step: [{ sequence: 1, count: phase }] };
    const before = persist({ rows, edits });
    let wire = toDosageDetails(rows, undefined, edits);
    expect({ rows, edits }).toEqual(before);
    for (let save = 0; save < 3; save++) {
      expect(getCourseCycleCount(wire)).toBeUndefined();
      expect(wire.step![0].count).toBe(phase);
      expect(nextDueDoses(wire, { ...options, limit: phase * 7 + 2 })).toEqual([
        ...Array.from({ length: phase * 7 }, (_, index) => "2026-01-" + ("0" + (index + 1)).slice(-2) + "T09:00:00+00:00"),
        "2026-01-29T09:00:00+00:00", "2026-01-30T09:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ dosage: wire, ...options, durationValue: 28, durationUnit: FhirPeriodUnit.Day }))
        .toMatchObject({ totalUnits: phase * 7, unit: "tab" });
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
    }
  });

  it.each(["omitted", "unrelated"] as const)("retains established legacy count migration for %s course metadata", edit => {
    const policy = { url: "urn:clinic:course-policy", valueString: "preserve policy" };
    const edits = { ...(edit === "unrelated" ? { modifierExtension: [policy] } : {}),
      step: [{ sequence: 1, count: 2 }] };
    let wire = toDosageDetails(persist(legacyRows), undefined, edits);
    for (let save = 0; save < 3; save++) {
      expect(getCourseCycleCount(wire)).toBe(2);
      expect(wire.step![0].count).toBeUndefined();
      if (edit === "unrelated") expect(wire.modifierExtension).toContainEqual(policy);
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
    }
  });

  function inductionPause(withDelay = false): FhirR6DosageInstruction {
    return toDosageDetails([
      { sequence: 1, id: "initial", doseAndRate: [{ doseQuantity: q(1) }],
        timing: { repeat: { ...daily, boundsDuration: { value: 1, unit: "d" } } },
        ...(withDelay ? { modifierExtension: [{ id: "delay-policy", url: ADMINISTRATION_OFFSET_EXTENSION_URL,
          valueQuantity: { value: 0, unit: "min", code: "min",
            extension: [{ url: "urn:clinic:delay-note", valueString: "original delay annotation" }] } }] } : {}) },
      { sequence: 3, id: "later", doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: { ...daily, count: 2 } } },
    ], undefined, { step: [
      { sequence: 1, id: "induction" },
      { sequence: 2, id: "pause", end: afterDays(2),
        extension: [{ id: "pause-note", url: "urn:clinic:pause-note", valueString: "original pause" }] },
      { sequence: 3, id: "resume" },
    ] });
  }

  it.each(["unchanged", "delay", "dose", "delay-annotation", "zero-delay"] as const)(
    "keeps dependent pause ownership after a public administration %s edit", edit => {
      let wire = inductionPause(edit === "delay-annotation");
      const originalDraft = persist(wire.extension!.find(item => item.url === R6_DRAFT_STEPS_SOURCE_URL)!);
      const liveStart = persist(wire.step![1].start), member = wire.step![0].component[0];
      if (edit === "delay" || edit === "zero-delay") member.modifierExtension = [{
        id: "delay-policy", url: ADMINISTRATION_OFFSET_EXTENSION_URL,
        valueQuantity: { value: edit === "delay" ? 2880 : 0, unit: "min", code: "min",
          extension: [{ url: "urn:clinic:delay-note", valueString: "current delay annotation" }] },
      }];
      if (edit === "dose") member.doseAndRate![0].doseQuantity!.value = 3;
      if (edit === "delay-annotation") member.modifierExtension![0].valueQuantity!.id = "current-delay-note";
      for (let save = 0; save < 3; save++) {
        const before = persist(wire), view = fromDosageDetails(wire);
        expect(view.course.step?.map(step => step.id)).toEqual(edit === "delay"
          ? ["induction", "resume"] : ["induction", "pause", "resume"]);
        expect(wire.step![1].start).toEqual(liveStart);
        expect(nextDueDoses(wire, options)).toEqual(edit === "delay" ? [
          "2026-01-03T09:00:00+00:00", "2026-01-03T09:00:00+00:00", "2026-01-04T09:00:00+00:00",
        ] : ["2026-01-01T09:00:00+00:00", "2026-01-03T09:00:00+00:00", "2026-01-04T09:00:00+00:00"]);
        expect(calculateTotalUnits({ dosage: wire, ...options, durationValue: 5, durationUnit: FhirPeriodUnit.Day }))
          .toMatchObject({ totalUnits: edit === "dose" ? 7 : 5, unit: "tab" });
        expect(wire).toEqual(before);
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
        if (edit === "delay") expect(wire.extension?.some(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL &&
          item.extension?.some(source => JSON.stringify(source) === JSON.stringify(originalDraft)))).toBe(true);
        expect(JSON.stringify(wire)).toContain("original pause");
      }
    });

  it.each([false, true])("keeps a saved trailing draft from acquiring an appended receiver (%s)", appended => {
    let wire = toDosageDetails([
      { sequence: 1, id: "initial", doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } },
    ], undefined, { step: [
      { sequence: 1, id: "induction", end: afterDays(1) },
      { sequence: 2, id: "trailing-draft", end: afterDays(3),
        extension: [{ url: "urn:clinic:draft-note", valueString: "saved trailing draft" }] },
    ] });
    if (appended) wire.step!.push({ id: "maintenance", start: { contextCode: { coding: [{
      system: "urn:ezmedicationinput:CodeSystem:course-phase-event", code: "previous-phase-next-day",
    }] } }, component: [{ id: "maintenance-dose", doseAndRate: [{ doseQuantity: q(2) }],
      timing: { repeat: { ...daily, count: 2 } } }] });
    for (let save = 0; save < 3; save++) {
      const before = persist(wire), view = fromDosageDetails(wire);
      expect(view.course.step?.map(step => step.id)).toEqual(appended
        ? ["induction", "maintenance"] : ["induction", "trailing-draft"]);
      expect(nextDueDoses(wire, options)).toEqual(appended ? [
        "2026-01-01T09:00:00+00:00", "2026-01-02T09:00:00+00:00", "2026-01-03T09:00:00+00:00",
      ] : ["2026-01-01T09:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage: wire, ...options, durationValue: 5, durationUnit: FhirPeriodUnit.Day }))
        .toMatchObject({ totalUnits: appended ? 5 : 1, unit: "tab" });
      expect(wire).toEqual(before);
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      expect(JSON.stringify(wire)).toContain("saved trailing draft");
    }
  });

  it.each(["unchanged", "administration", "administration-delete", "valued-period-edit", "valued-period-delete"] as const)(
    "preserves an independent partial period limit after a %s maximum edit", edit => {
      const valued = edit.startsWith("valued");
      const period: FhirR6DoseLimit = { id: "period-cap", scope: "period",
        valueQuantity: { ...(valued ? { value: 4 } : {}), unit: "tab", _value: { id: "numerator-note" },
          extension: [{ url: "urn:clinic:quantity-note", valueString: "retain partial numerator" }] },
        period: { value: 1, unit: "d" } };
      const rows = persist(toFhirR5Dosages(course({ timing: { repeat: daily }, safety: { doseLimit: [
        period, { scope: "administration", valueQuantity: q(4) },
      ] } })));
      if (edit === "administration") rows[0].maxDosePerAdministration!.value = 3;
      if (edit === "administration-delete") delete rows[0].maxDosePerAdministration;
      if (edit === "valued-period-edit") rows[0].maxDosePerPeriod![0].numerator!.value = 2;
      if (edit === "valued-period-delete") delete rows[0].maxDosePerPeriod;
      const before = persist(rows);
      let wire = toDosageDetails(rows);
      expect(rows).toEqual(before);
      for (let save = 0; save < 3; save++) {
        const limits = wire.step![0].component[0].safety?.doseLimit ?? [];
        expect(limits).toHaveLength(edit === "administration-delete" || edit === "valued-period-delete" ? 1 : 2);
        expect(limits.find(limit => limit.scope === "period")).toEqual(edit === "valued-period-delete" ? undefined :
          { ...period, valueQuantity: { ...period.valueQuantity,
            ...(edit === "valued-period-edit" ? { value: 2 } : {}) } });
        expect(limits.find(limit => limit.scope === "administration")?.valueQuantity).toEqual(
          edit === "administration-delete" ? undefined : q(edit === "administration" ? 3 : 4));
        if (!valued) expect(limits.find(limit => limit.scope === "period")?.valueQuantity?.value).toBeUndefined();
        const saved = persist(toFhirR5Dosages(wire));
        if (!valued) expect(saved[0].maxDosePerPeriod?.[0].numerator).toEqual(period.valueQuantity);
        wire = toDosageDetails(saved);
      }
    });

  it.each(["both", "bridge", "core", "null-core"] as const)("keeps independent core and promoted clock annotations separate (%s)", owner => {
    const core = [{ id: "core-note", extension: [{ url: "urn:clinic:core-note", valueString: "independent core annotation" }] }];
    const bridgeNote = { id: "clock-note", extension: [{ url: "urn:clinic:clock-note", valueString: "authored bridge annotation" }] };
    const bridge: FhirExtension = { id: "clock-carrier", url: TIMING_ADDITIONAL_CLOCK_EXTENSION_URL,
      valueTime: "08:00:00", ...(owner !== "core" ? { _valueTime: bridgeNote } : {}) };
    const rows: FhirDosage[] = [{ id: "clock-dose", doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: {
      frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
      ...(owner !== "bridge" ? { _timeOfDay: core } : {}),
      ...(owner === "null-core" ? { timeOfDay: [null] } : {}), extension: [bridge],
    } } }];
    const before = persist(rows);
    let wire = toDosageDetails(rows);
    expect(rows).toEqual(before);
    for (let save = 0; save < 3; save++) {
      const repeat = wire.step![0].component[0].timing!.repeat!;
      expect(repeat.timeOfDay).toEqual(["08:00:00"]);
      expect(repeat._timeOfDay).toEqual(owner === "core" ? undefined : [bridgeNote]);
      const source = repeat.extension?.filter(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL)
        .reduce<NonNullable<typeof repeat.extension>>((items, item) => items.concat(item.extension ?? []), []) ?? [];
      expect(source).toContainEqual(bridge);
      const originalCore = source.find(item => item.url === "_timeOfDay");
      expect(originalCore ? readRetainedField(originalCore) : undefined).toEqual(owner === "bridge" ? undefined : core);
      expect(nextDueDoses(wire, { ...options, limit: 2 })).toEqual([
        "2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00",
      ]);
      const snapshot = persist(wire);
      const saved = toFhirR5Dosages(wire);
      expect(wire).toEqual(snapshot);
      wire = toDosageDetails(persist(saved));
    }
  });
});


describe("round51 retained phase boundaries and primitive positions", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] };
  const boundary = (value: number) => ({ contextCode: { coding: [{
    system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start",
  }] }, offsetDuration: { value, unit: "d" } });
  const options = { from: "2026-01-01T00:00:00Z", orderedAt: "2026-01-01T00:00:00Z",
    timeZone: "UTC", limit: 40 };
  const dates = (days: number[]) => days.map(day => "2026-01-" + ("0" + day).slice(-2) + "T09:00:00+00:00");

  it.each(["unchanged", "id", "boundary", "start-only", "annotation"] as const)(
    "retains historical phase fields beneath a partial public %s edit", edit => {
      const originalNote = { id: "stage-note", url: "urn:clinic:phase-note",
        valueString: "preserve historical phase annotation" };
      const originalStep: FhirR6DosageStep = { id: "old-maintenance", start: boundary(7), end: boundary(14),
        extension: [originalNote], component: [{ id: "historical-dose", doseAndRate: [{ doseQuantity: q(2) }],
          timing: { repeat: daily } }] };
      const marker: FhirExtension = { id: "historical-full-course", url: DOSAGE_DETAILS_R5_URL, extension: [{
        url: "dosageDetails", extension: [
          encodeR6SourceMetadata("step", { id: "historical-first", component: [] }, "step"),
          encodeR6SourceMetadata("step", originalStep, "step"),
        ],
      }] };
      const compact = toFhirR5Dosages({ step: [{ id: "loading", end: boundary(7), component: [{
        id: "compact-dose", doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily },
      }] }] })[0];
      compact.modifierExtension!.find(item => item.url === DOSAGE_DETAILS_R5_URL)!
        .extension!.find(item => item.url === "stepCount")!.valueInteger = 2;
      const rows: EzDosage[] = JSON.parse(JSON.stringify([compact,
        { ...originalStep.component[0], sequence: 2, modifierExtension: [marker] }]));
      const currentNote = { url: "urn:clinic:edited-note", valueString: "current note" };
      const editing: EzCourseMetadata | undefined = edit === "unchanged" ? undefined : { step: [{
        sequence: 2, ...(edit === "id" ? { id: "maintenance" } :
          edit === "boundary" ? { start: boundary(9), end: boundary(16) } :
          edit === "start-only" ? { start: boundary(9) } : { extension: [currentNote] }),
      }] };
      const before = persist({ rows, editing });
      let wire = toDosageDetails(rows, undefined, editing);
      expect(persist({ rows, editing })).toEqual(before);
      const startDay = edit === "boundary" || edit === "start-only" ? 10 : 8;
      const endDay = edit === "boundary" ? 16 : 14;
      const maintenanceDays = Array.from({ length: endDay - startDay + 1 }, (_, index) => startDay + index);
      for (let save = 0; save < 3; save++) {
        const beforeWire = persist(wire), step = wire.step![1];
        expect(step.id).toBe(edit === "id" ? "maintenance" : "old-maintenance");
        expect(step.start).toEqual(boundary(startDay - 1));
        expect(step.end).toEqual(boundary(endDay));
        expect(step.extension).toEqual(edit === "annotation" ? [currentNote] : [originalNote]);
        expect(step.component[0]).toMatchObject({ id: "historical-dose", doseAndRate: [{ doseQuantity: q(2) }] });
        expect(nextDueDoses(wire, options)).toEqual(dates([1, 2, 3, 4, 5, 6, 7, ...maintenanceDays]));
        expect(calculateTotalUnits({ dosage: wire, ...options, durationValue: 20, durationUnit: FhirPeriodUnit.Day }))
          .toMatchObject({ totalUnits: edit === "start-only" ? 17 : 21, unit: "tab" });
        const coldRows = persist(toFhirR5Dosages(wire));
        expect(wire).toEqual(beforeWire);
        wire = toDosageDetails(coldRows);
        expect(JSON.stringify(wire)).toContain("preserve historical phase annotation");
      }
    });

  function dependentPause(extra = false, independentStart = false, fixedEnd = false): FhirR6DosageInstruction {
    const pauseSequence = extra ? 4 : 3;
    return toDosageDetails([
      { sequence: 1, id: "a-dose", doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } },
      { sequence: 2, id: "b-dose", doseAndRate: [{ doseQuantity: q(2) }],
        timing: { repeat: { ...daily, boundsDuration: { value: 1, unit: "d" } } } },
      ...(extra ? [{ sequence: 3, id: "c-dose", doseAndRate: [{ doseQuantity: q(2) }],
        timing: { repeat: { ...daily, boundsDuration: { value: 1, unit: "d" } } } }] : []),
      { sequence: pauseSequence + 1, id: "maintenance-dose", doseAndRate: [{ doseQuantity: q(3) }],
        timing: { repeat: { ...daily, count: 2 } } },
    ], undefined, { step: [
      { sequence: 1, id: "phase-a", end: boundary(1) },
      { sequence: 2, id: "phase-b", ...(independentStart ? { start: boundary(2) } : {}),
        ...(fixedEnd ? { end: boundary(3) } : {}) },
      ...(extra ? [{ sequence: 3, id: "phase-c" }] : []),
      { sequence: pauseSequence, id: "pause", end: boundary(extra || independentStart || fixedEnd ? 4 : 3),
        extension: [{ id: "saved-pause-note", url: "urn:clinic:pause-note", valueString: "original pause retained" }] },
      { sequence: pauseSequence + 1, id: "maintenance" },
    ] });
  }

  it.each(["unchanged", "earlier-end", "dose", "annotation", "two-implicit", "independent-start", "fixed-end"] as const)(
    "keeps only independently owned pauses after a transitive %s edit", edit => {
      let wire = persist(dependentPause(edit === "two-implicit", edit === "independent-start", edit === "fixed-end"));
      const originalDraft = persist(wire.extension!.find(item => item.url === R6_DRAFT_STEPS_SOURCE_URL)!);
      const currentStart = persist(wire.step![wire.step!.length - 1].start);
      if (edit === "earlier-end" || edit === "two-implicit" || edit === "independent-start" || edit === "fixed-end")
        wire.step![0].end = boundary(2);
      if (edit === "dose") wire.step![0].component[0].doseAndRate![0].doseQuantity!.value = 4;
      if (edit === "annotation") wire.step![0].end!.id = "current-boundary-note";
      const retired = edit === "earlier-end" || edit === "two-implicit";
      const phaseIds = ["phase-a", "phase-b", ...(edit === "two-implicit" ? ["phase-c"] : []),
        ...(!retired ? ["pause"] : []), "maintenance"];
      const expectedDays = edit === "two-implicit" ? [1, 2, 3, 4, 5, 6] :
        edit === "earlier-end" ? [1, 2, 3, 4, 5] :
        edit === "independent-start" || edit === "fixed-end" ? [1, 2, 3, 5, 6] : [1, 2, 4, 5];
      const total = edit === "dose" || edit === "two-implicit" ? 12 :
        edit === "earlier-end" || edit === "independent-start" || edit === "fixed-end" ? 10 : 9;
      for (let save = 0; save < 3; save++) {
        const before = persist(wire);
        expect(fromDosageDetails(wire).course.step?.map(step => step.id)).toEqual(phaseIds);
        expect(wire.step![wire.step!.length - 1].start).toEqual(currentStart);
        expect(nextDueDoses(wire, options)).toEqual(dates(expectedDays));
        expect(calculateTotalUnits({ dosage: wire, ...options, durationValue: 7, durationUnit: FhirPeriodUnit.Day }))
          .toMatchObject({ totalUnits: total, unit: "tab" });
        expect(wire).toEqual(before);
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
        expect(JSON.stringify(wire)).toContain("original pause retained");
        expect(JSON.stringify(wire)).toContain("saved-pause-note");
        if (retired) expect(wire.extension?.some(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL &&
          item.extension?.some(source => JSON.stringify(source) === JSON.stringify(originalDraft)))).toBe(true);
      }
    });

  function anchoredPause(): FhirR6DosageInstruction {
    return toDosageDetails([
      { sequence: 1, id: "induction-dose", doseAndRate: [{ doseQuantity: q(1) }],
        timing: { repeat: { ...daily, boundsPeriod: { start: "2026-01-01T00:00:00Z" } } },
        modifierExtension: [{ id: "duration-policy", url: ANCHORED_COURSE_DURATION_EXTENSION_URL,
          valueQuantity: { id: "authored-length", value: 1, unit: "d", _unit: { id: "length-unit" },
            extension: [{ url: "urn:clinic:duration-note", valueString: "original duration annotation" }] } }] },
      { sequence: 3, id: "maintenance-dose", doseAndRate: [{ doseQuantity: q(2) }],
        timing: { repeat: { ...daily, count: 2 } } },
    ], undefined, { step: [
      { sequence: 1, id: "induction" },
      { sequence: 2, id: "pause", end: boundary(2),
        extension: [{ url: "urn:clinic:pause-note", valueString: "anchored pause retained" }] },
      { sequence: 3, id: "maintenance" },
    ] });
  }

  it.each(["unchanged", "length", "dose", "marker-annotation", "quantity-annotation"] as const)(
    "compares the effective anchored length after a public %s edit", edit => {
      let wire = persist(anchoredPause());
      const originalDraft = persist(wire.extension!.find(item => item.url === R6_DRAFT_STEPS_SOURCE_URL)!);
      const member = wire.step![0].component[0];
      const length = member.modifierExtension!.find(item => item.url === ANCHORED_COURSE_DURATION_EXTENSION_URL)!;
      if (edit === "length") length.valueQuantity!.value = 2;
      if (edit === "dose") member.doseAndRate![0].doseQuantity!.value = 3;
      if (edit === "marker-annotation") length.id = "current-policy-note";
      if (edit === "quantity-annotation") length.valueQuantity!.id = "current-length-note";
      const authoredLength = persist(length);
      for (let save = 0; save < 3; save++) {
        const before = persist(wire);
        expect(fromDosageDetails(wire).course.step?.map(step => step.id)).toEqual(edit === "length"
          ? ["induction", "maintenance"] : ["induction", "pause", "maintenance"]);
        expect(wire.step![0].component[0].modifierExtension!
          .find(item => item.url === ANCHORED_COURSE_DURATION_EXTENSION_URL)).toEqual(authoredLength);
        expect(nextDueDoses(wire, options)).toEqual(dates(edit === "length" ? [1, 2, 3, 4] : [1, 3, 4]));
        expect(calculateTotalUnits({ dosage: wire, ...options, durationValue: 7, durationUnit: FhirPeriodUnit.Day }))
          .toMatchObject({ totalUnits: edit === "length" ? 6 : edit === "dose" ? 7 : 5, unit: "tab" });
        expect(wire).toEqual(before);
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
        expect(JSON.stringify(wire)).toContain("anchored pause retained");
        if (edit === "length") expect(wire.extension?.some(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL &&
          item.extension?.some(source => JSON.stringify(source) === JSON.stringify(originalDraft)))).toBe(true);
      }
    });

  it.each([
    ["tail", "r5"], ["tail", "r6"], ["head", "r5"], ["head", "r6"],
    ["only", "r5"], ["only", "r6"], ["valued", "r5"], ["valued", "r6"],
  ] as const)("keeps %s weekday primitive positions on %s while scheduling only real weekdays", (position, kind) => {
    const values = position === "tail" ? [FhirDayOfWeek.Monday, null] :
      position === "head" ? [null, FhirDayOfWeek.Monday] : position === "only" ? [null] : [FhirDayOfWeek.Monday];
    const note = { id: "weekday-placeholder", extension: [{
      url: "urn:clinic:weekday-note", valueString: "unvalued calendar annotation",
    }] };
    const annotations = position === "tail" ? [null, note] : position === "head" ? [note, null] :
      position === "only" ? [note] : [{ id: "monday-note" }];
    // JSON is a public external FHIR boundary, including nullable primitive slots.
    const rows: EzDosage[] = JSON.parse(JSON.stringify([{ id: "weekday-dose", doseAndRate: [{ doseQuantity: q(1) }],
      timing: { repeat: { ...daily, dayOfWeek: values, _dayOfWeek: annotations } } }]));
    const input: EzDosage[] | FhirR6DosageInstruction = kind === "r5" ? rows :
      JSON.parse(JSON.stringify({ step: [{ component: rows }] }));
    const beforeInput = persist(input);
    const native = importCanonicalCourse(input);
    expect(native.stages[0].administrations[0].schedule?.recurrence?.dayOfWeek)
      .toEqual(position === "only" ? [] : [FhirDayOfWeek.Monday]);
    let wire = projectCanonicalCourse(native).fhirNext;
    expect(input).toEqual(beforeInput);
    const query = { ...options, from: "2026-01-04T00:00:00Z", orderedAt: "2026-01-04T00:00:00Z", limit: 2 };
    for (let save = 0; save < 3; save++) {
      const before = persist(wire), repeat = wire.step![0].component[0].timing!.repeat!;
      expect(repeat.dayOfWeek).toEqual(values);
      expect(repeat).toMatchObject({ _dayOfWeek: annotations });
      expect(nextDueDoses(wire, query)).toEqual(dates(position === "only" ? [4, 5] : [5, 12]));
      expect(calculateTotalUnits({ dosage: wire, ...query, durationValue: 7, durationUnit: FhirPeriodUnit.Day }))
        .toMatchObject({ totalUnits: position === "only" ? 7 : 1, unit: "tab" });
      for (const locale of ["en", "th"] as const)
        expect(() => fromFhir(wire, { locale })).not.toThrow();
      const coldRows = persist(toFhirR5Dosages(wire));
      expect(coldRows[0].timing!.repeat!.dayOfWeek).toEqual(values);
      expect(coldRows[0].timing!.repeat!).toMatchObject({ _dayOfWeek: annotations });
      expect(wire).toEqual(before);
      wire = toDosageDetails(coldRows);
    }
  });
});


describe("round52 interop current annotation and boundary ownership", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] };
  const boundary = (value: number) => ({
    contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] },
    offsetDuration: { value, unit: "d" },
  });
  const previousNextDay = { contextCode: { coding: [{
    system: "urn:ezmedicationinput:CodeSystem:course-phase-event", code: "previous-phase-next-day",
  }] } };
  const options = { from: "2026-01-01T00:00:00Z", orderedAt: "2026-01-01T00:00:00Z", timeZone: "UTC", limit: 8 };
  const dates = (days: number[]) => days.map(day => "2026-01-" + (day < 10 ? "0" + day : String(day)) + "T09:00:00+00:00");
  const translationUrl = "http://hl7.org/fhir/StructureDefinition/translation";
  const translation = (text: string): FhirExtension => ({ url: translationUrl, extension: [
    { url: "lang", valueCode: "th" }, { url: "content", valueString: text },
  ] });

  it.each(["unchanged", "dose", "wording", "replacement", "clear-companion"] as const)(
    "keeps the current populated header and displaced translation after a %s edit", edit => {
      const original = "Take 1 tablet daily", replacement = "Take 2 tablets daily";
      const originalPrimitive = { id: "original-header-primitive", extension: [
        translation("รับประทานครั้งละ 1 เม็ด วันละครั้ง"),
        { url: "urn:clinic:header-note", valueString: "keep this independent annotation" },
      ] };
      const input: FhirR6DosageInstruction = { id: "course-original",
        renderedInstruction: original, _renderedInstruction: originalPrimitive,
        step: [{ id: "daily-phase", component: [{ id: "daily-dose",
          doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } }] }],
      };
      const editable = persist(fromDosageDetails(input));
      if (edit !== "unchanged") editable.dosages[0].doseAndRate![0].doseQuantity!.value = 2;
      if (edit === "wording" || edit === "replacement" || edit === "clear-companion")
        editable.course.renderedInstruction = replacement;
      const replacementPrimitive = { id: "replacement-header-primitive", extension: [
        translation("รับประทานครั้งละ 2 เม็ด วันละครั้ง"),
        { url: "urn:clinic:current-header-note", valueString: "current independent annotation" },
      ] };
      const header = editable.course as EzCourseMetadata & Pick<FhirR6DosageInstruction, "_renderedInstruction">;
      if (edit === "replacement") header._renderedInstruction = replacementPrimitive;
      if (edit === "clear-companion") header._renderedInstruction = { id: "current-untranslated-primitive" };
      const beforeEdit = persist(editable);
      let rows = toFhirR5Dosages(editable.dosages, editable.course);
      expect(editable).toEqual(beforeEdit);
      for (let save = 0; save < 3; save++) {
        const before = persist(rows), reopened = toDosageDetails(persist(rows));
        expect(reopened.step![0].component[0].doseAndRate![0].doseQuantity).toEqual(q(edit === "unchanged" ? 1 : 2));
        expect(reopened.renderedInstruction).toBe(edit === "dose" ? undefined : edit === "unchanged" ? original : replacement);
        expect(reopened._renderedInstruction).toEqual(edit === "unchanged" ? originalPrimitive :
          edit === "replacement" ? replacementPrimitive : edit === "clear-companion" ? { id: "current-untranslated-primitive" } :
            { id: originalPrimitive.id, extension: [originalPrimitive.extension[1]] });
        if (edit !== "unchanged") {
          const retained: Array<Partial<EzCourseMetadata> | undefined> = [];
          for (const marker of reopened.extension ?? [])
            if (marker.url === DOSAGE_RECONCILIATION_SOURCE_URL)
              for (const source of marker.extension ?? [])
                if (source.url === DOSAGE_DETAILS_R5_URL) retained.push(decodeR5RetainedFields(source).course);
          expect(retained).toContainEqual(expect.objectContaining({
            renderedInstruction: original, _renderedInstruction: originalPrimitive,
          }));
          expect(formatSig(reopened, "long", { locale: "en", realizationMode: "normalized" })).toContain("2 tablets");
          expect(formatSig(reopened, "long", { locale: "th", realizationMode: "normalized" })).toContain("2 เม็ด");
        }
        expect(rows).toEqual(before);
        rows = toFhirR5Dosages(reopened);
      }
    });

  function nextDayPause(kind: string): FhirR6DosageInstruction {
    return toDosageDetails([
      { sequence: 1, id: "a-dose", doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } },
      { sequence: 2, id: "b-dose", doseAndRate: [{ doseQuantity: q(2) }],
        timing: { repeat: { ...daily, boundsDuration: { value: 1, unit: "d" } } } },
      { sequence: 4, id: "maintenance-dose", doseAndRate: [{ doseQuantity: q(3) }],
        timing: { repeat: { ...daily, count: 2 } } },
    ], undefined, { step: [
      { sequence: 1, id: "phase-a", end: boundary(1) },
      { sequence: 2, id: "phase-b", start: kind === "independent-start" ? boundary(2) : previousNextDay,
        ...(kind === "fixed-end" ? { end: boundary(3) } : {}) },
      { sequence: 3, id: "pause", end: boundary(kind === "independent-start" || kind === "fixed-end" ? 4 : 3),
        extension: [{ id: "original-pause-note", url: "urn:clinic:pause-note",
          valueString: "recover complete original next-day pause" }] },
      { sequence: 4, id: "maintenance" },
    ] });
  }

  it.each(["unchanged", "earlier-end", "dose", "annotation", "independent-start", "fixed-end"] as const)(
    "rechecks a previous-phase-next-day completion after a %s edit", edit => {
      let wire = persist(nextDayPause(edit));
      const originalDraft = persist(wire.extension!.find(item => item.url === R6_DRAFT_STEPS_SOURCE_URL)!);
      const originalStart = persist(wire.step![1].start);
      if (edit === "earlier-end" || edit === "independent-start" || edit === "fixed-end") wire.step![0].end = boundary(2);
      if (edit === "dose") wire.step![0].component[0].doseAndRate![0].doseQuantity!.value = 4;
      if (edit === "annotation") wire.step![0].end!.id = "current-boundary-annotation";
      const retired = edit === "earlier-end";
      const expectedDays = retired ? [1, 2, 3, 4, 5] :
        edit === "independent-start" || edit === "fixed-end" ? [1, 2, 3, 5, 6] : [1, 2, 4, 5];
      const total = retired || edit === "independent-start" || edit === "fixed-end" ? 10 : edit === "dose" ? 12 : 9;
      for (let save = 0; save < 3; save++) {
        const before = persist(wire);
        expect(fromDosageDetails(wire).course.step?.map(step => step.id))
          .toEqual(["phase-a", "phase-b", ...(!retired ? ["pause"] : []), "maintenance"]);
        expect(wire.step![1].start).toEqual(originalStart);
        expect(nextDueDoses(wire, options)).toEqual(dates(expectedDays));
        expect(calculateTotalUnits({ dosage: wire, ...options, durationValue: 8, durationUnit: FhirPeriodUnit.Day }))
          .toMatchObject({ totalUnits: total, unit: "tab" });
        expect(wire).toEqual(before);
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
        if (retired) expect(wire.extension?.some(marker => marker.url === DOSAGE_RECONCILIATION_SOURCE_URL &&
          marker.extension?.some(source => JSON.stringify(source) === JSON.stringify(originalDraft)))).toBe(true);
        else expect(decodeR6SourceMetadata(
          wire.extension!.find(marker => marker.url === R6_DRAFT_STEPS_SOURCE_URL)!, "drafts")?.drafts)
          .toEqual(decodeR6SourceMetadata(originalDraft, "drafts")?.drafts);
      }
    });

  it.each(["unchanged", "clear", "replace", "unannotated-clear"] as const)(
    "keeps the explicit public graph comparator %s authoritative over annotated carriers", edit => {
      const graph: CanonicalInstructionGraph = { sourceText: "Take at most 2 tablets",
        actions: [{ force: AdviceForce.Instruction, predicate: { lemma: "take" },
          args: [{ role: AdviceArgumentRole.Amount, text: "at most 2 tablets",
            quantity: { value: 2, unit: "tab", comparator: "<=" } }],
          span: { start: 0, end: 22 }, sourceText: "Take at most 2 tablets" }],
      };
      const quantity = (wire: FhirExtension) => wire.extension!.find(item => item.url === "action")!
        .extension!.find(item => item.url === "argument")!.extension!.find(item => item.url === "quantity")!;
      let wire = persist(buildInstructionGraphExtension(graph)!);
      const operator = quantity(wire).extension!.find(item => item.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL)!;
      if (edit !== "unannotated-clear") {
        operator.id = "authored-operator-carrier";
        Object.assign(operator.valueCoding!, { id: "authored-operator-coding", display: "less than or equal to", userSelected: true,
          _code: { id: "authored-operator-code", extension: [{
            url: "urn:clinic:operator-label", valueString: "original qualifier annotation",
          }] },
        });
      }
      const authoredOperator = persist(operator);
      const independent = { id: "independent-quantity-note", url: "urn:clinic:quantity-note",
        valueString: "keep alongside current exact amount" };
      quantity(wire).extension!.push(independent);
      for (let save = 0; save < 3; save++) {
        const before = persist(wire), parsed = persist(parseInstructionGraphExtension([wire])!);
        if (!save) {
          if (edit === "clear" || edit === "unannotated-clear") delete parsed.actions[0].args[0].quantity!.comparator;
          if (edit === "replace") parsed.actions[0].args[0].quantity!.comparator = ">=";
        }
        const beforeBuild = persist(parsed), next = buildInstructionGraphExtension(parsed)!;
        expect(persist(parsed)).toEqual(beforeBuild);
        const reopened = parseInstructionGraphExtension([persist(next)])!;
        const amount = reopened.actions[0].args[0].quantity!;
        expect(amount.value).toBe(2);
        expect(amount.unit).toBe("tab");
        expect(amount.comparator).toBe(edit === "unchanged" ? "<=" : edit === "replace" ? ">=" : undefined);
        expect(quantity(next).extension).toContainEqual(independent);
        if (edit === "unchanged") expect(quantity(next).extension).toContainEqual(authoredOperator);
        if (edit === "clear") {
          expect(quantity(next).extension?.filter(item => item.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL)).toEqual([]);
          expect(quantity(next).extension).toContainEqual({ url: QUANTITY_OPERATOR_SOURCE_URL, extension: [authoredOperator] });
        }
        if (edit === "replace") expect(quantity(next).extension).toContainEqual({
          url: QUANTITY_OPERATOR_SOURCE_URL, valueCoding: authoredOperator.valueCoding,
        });
        expect(wire).toEqual(before);
        wire = persist(next);
      }
    });

  it.each([
    ["head", "r5"], ["head", "r6"], ["tail", "r5"], ["tail", "r6"],
    ["only", "r5"], ["only", "r6"], ["valued", "r5"], ["valued", "r6"],
  ] as const)("keeps %s when primitive positions on %s without adding a meal dose", (position, kind) => {
    const annotation = { id: "unvalued-anchor", extension: [{
      url: "urn:clinic:anchor-note", valueString: "preserve the unvalued event annotation",
    }] };
    const values = position === "head" ? [null, EventTiming.Meal] :
      position === "tail" ? [EventTiming.Meal, null] : position === "only" ? [null] : [EventTiming.Meal];
    const repeat = { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day, when: values,
      _when: position === "head" ? [annotation, null] : position === "tail" ? [null, annotation] :
        position === "only" ? [annotation] : [{ id: "meal-anchor" }],
    };
    // Complete valid external JSON retains primitive companions absent from
    // the deliberately narrow convenience interface.
    const row = JSON.parse(JSON.stringify({ id: "meal-dose",
      doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat } })) as FhirDosage;
    let wire: FhirDosage[] | FhirR6DosageInstruction = kind === "r5" ? [row] : { step: [{ component: [row] }] };
    const clocks = { ...options, limit: 4, eventClock: { CM: "08:00", CD: "12:00", CV: "18:00" },
      frequencyDefaults: { byFrequency: { "freq:2/d": ["08:00", "18:00"] } },
    };
    const expected = ["2026-01-01T08:00:00+00:00", "2026-01-01T18:00:00+00:00",
      "2026-01-02T08:00:00+00:00", "2026-01-02T18:00:00+00:00"];
    for (let save = 0; save < 3; save++) {
      const before = persist(wire);
      expect(nextDueDoses(wire, clocks)).toEqual(expected);
      expect(calculateTotalUnits({ dosage: wire, ...clocks, durationValue: 2, durationUnit: FhirPeriodUnit.Day }))
        .toMatchObject({ totalUnits: 4, unit: "tab" });
      const output = toFhirR5Dosages(wire);
      expect(output[0].timing!.repeat!.when).toEqual(values);
      expect((output[0].timing!.repeat! as typeof repeat)._when).toEqual(repeat._when);
      expect(wire).toEqual(before);
      wire = kind === "r5" ? persist(output) : toDosageDetails(persist(output));
    }
  });

  it("retains every authored relation Coding field in the existing explicit clone", () => {
    const coding = { id: "relation-coding", system: "http://snomed.info/sct", version: "20261101",
      code: "66459002", display: "Around", userSelected: true,
      _code: { id: "relation-code", extension: [{ url: "urn:clinic:relation-code-note",
        valueString: "retain authored coding metadata" }] },
      _version: { id: "relation-version" },
      extension: [{ url: "urn:clinic:relation-note", valueString: "preserve independent relation annotation" }],
    };
    const input = { text: "around the left eye", extension: [buildBodySiteSpatialRelationExtension({
      relationText: "around", relationCoding: coding, targetText: "left eye", sourceText: "around the left eye",
    })!] };
    const before = persist(input);
    const parsed = parseBodySiteSpatialRelationExtension(input)!;
    const cloned = cloneBodySiteSpatialRelation(parsed)!;
    expect(cloned.relationCoding).toEqual(coding);
    expect(cloned.relationCoding).not.toBe(parsed.relationCoding);
    expect(cloned.relationCoding!._code).not.toBe(parsed.relationCoding!._code);
    expect(cloned.relationCoding!.extension).not.toBe(parsed.relationCoding!.extension);
    let saved = buildBodySiteSpatialRelationExtension(cloned)!;
    for (let save = 0; save < 3; save++) {
      const reopened = parseBodySiteSpatialRelationExtension({ extension: [persist(saved)] })!;
      expect(reopened.relationCoding).toEqual(coding);
      saved = buildBodySiteSpatialRelationExtension(cloneBodySiteSpatialRelation(reopened))!;
    }
    cloned.relationCoding!._code!.extension![0].valueString = "changed only on requested clone";
    expect(input).toEqual(before);
  });
  it("preserves extra relation Coding data and detaches FHIR annotations", () => {
    const codings = [
      { code: "66459002" },
      { system: "http://snomed.info/sct", code: "66459002", version: "20261101", display: "Around" },
      { system: undefined, code: "66459002", display: undefined,
        clinicNote: { labels: ["authored", "independent"] },
        _system: { id: "system-note", extension: [{ url: "urn:clinic:source", valueString: "authored" }] },
        _version: { id: "version-note" }, _display: { id: "display-note" },
        _userSelected: { id: "selection-note" }, i18n: { th: "รอบ" } },
      { code: "66459002", version: undefined, extraNote: undefined },
      { id: "relation-annotation-only", _code: { id: "pending-code",
        extension: [{ url: "urn:clinic:code-note", valueString: "retained" }] } },
    ];
    for (const coding of codings) {
      const relation = { relationText: "around", relationCoding: coding, targetText: "left eye",
        targetCoding: { system: "http://snomed.info/sct", code: "129004000",
          display: "Left eye", i18n: { th: "ตาซ้าย" } }, sourceText: "around left eye" };
      const before = persist(relation);
      const originalKeys = Object.keys(coding);
      const cloned = cloneBodySiteSpatialRelation(relation)!;
      expect(cloned.relationCoding).toEqual(coding);
      expect(cloned.relationCoding).not.toBe(coding);
      for (const key of originalKeys) {
        expect(Object.prototype.hasOwnProperty.call(cloned.relationCoding, key)).toBe(true);
      }
      expect(cloned.targetCoding).toEqual(relation.targetCoding);
      expect(cloned.targetCoding).not.toBe(relation.targetCoding);
      expect(cloned.targetCoding!.i18n).not.toBe(relation.targetCoding.i18n);
      cloned.targetCoding!.i18n!.th = "changed only on clone";
      if (coding._system) {
        const copied = cloned.relationCoding as typeof coding;
        expect(copied._system).not.toBe(coding._system);
        expect(copied._system!.extension).not.toBe(coding._system.extension);
        expect(copied._version).not.toBe(coding._version);
        expect(copied._display).not.toBe(coding._display);
        expect(copied._userSelected).not.toBe(coding._userSelected);
        expect(copied.i18n).not.toBe(coding.i18n);
        copied._system!.extension[0].valueString = "clone only";
        copied.i18n!.th = "clone only";
      }
      if (coding._code) {
        expect(cloned.relationCoding!._code).not.toBe(coding._code);
        cloned.relationCoding!._code!.extension![0].valueString = "clone only";
      }
      expect(persist(relation)).toEqual(before);
      expect(Object.keys(coding)).toEqual(originalKeys);
    }
    const target = { code: "129004000", display: undefined, i18n: undefined };
    const clonedTarget = cloneBodySiteSpatialRelation({ relationText: "around", targetCoding: target })!.targetCoding!;
    expect(clonedTarget).toEqual(target);
    expect(Object.prototype.hasOwnProperty.call(clonedTarget, "display")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(clonedTarget, "i18n")).toBe(true);
  });
});


describe("round53 import/data correctness", () => {
  const translationUrl = "http://hl7.org/fhir/StructureDefinition/translation";
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] };
  const boundary = (value: number) => ({
    contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] },
    offsetDuration: { value, unit: "d", code: "d", system: "http://unitsofmeasure.org" },
  });
  const options = { orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-01T00:00:00Z", timeZone: "UTC" };

  it.each(["compact changed", "compact unchanged", "row-baseline changed", "row-baseline unchanged"])(
    "retires only stale active row translations on fresh %s input", variant => {
      const wording = "Take one tablet daily";
      const opaque = { url: "urn:clinic:row-text-note", valueString: "keep independent annotation" };
      const companion: FhirElement = { id: "row-text-id", extension: [opaque, {
        url: translationUrl, extension: [
          { url: "lang", valueCode: "th" }, { url: "content", valueString: "รับประทานหนึ่งเม็ดทุกวัน" },
        ],
      }] };
      const source: FhirR6DosageInstruction = { renderedInstruction: wording, step: [{ component: [{
        text: wording, _text: companion, doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily },
      }] }] };
      const rows = persist(toFhirR5Dosages(source));
      if (variant.startsWith("row-baseline"))
        rows[0].modifierExtension = rows[0].modifierExtension?.filter(item => item.url !== DOSAGE_DETAILS_R5_URL);
      const changed = variant.endsWith(" changed");
      if (changed) rows[0].doseAndRate![0].doseQuantity!.value = 2;
      const before = persist(rows);
      let actual = toDosageDetails(rows);
      for (let save = 0; save < 2; save++) {
        const member = actual.step![0].component[0];
        expect(member.doseAndRate![0].doseQuantity!.value).toBe(changed ? 2 : 1);
        expect(member._text).toEqual(changed ? { id: "row-text-id", extension: [opaque] } : companion);
        if (changed) {
          expect(member.text).toBeUndefined();
          const retiredRows: ReturnType<typeof decodeR5RetainedFields>[] = [];
          for (const item of actual.extension ?? []) if (item.url === DOSAGE_RECONCILIATION_SOURCE_URL)
            for (const old of item.extension ?? []) if (old.url === DOSAGE_DETAILS_R5_URL)
              retiredRows.push(decodeR5RetainedFields(old));
          expect(retiredRows).toContainEqual({
            rowIndex: 0, sequence: 1, component: { text: wording, _text: companion },
          });
        }
        actual = toDosageDetails(persist(toFhirR5Dosages(actual)));
      }
      expect(rows).toEqual(before);
    });

  it.each(["anonymous", "identified", "distinct projection", "same reference"])(
    "retains the correct reference owner after a fresh surviving row (%s)", identity => {
      const rightReference = "BodyStructure/right-eye";
      const leftReference = identity === "same reference" ? rightReference : "BodyStructure/left-eye";
      const components = [
        { id: "right", value: 1, reference: rightReference },
        { id: "left", value: identity === "distinct projection" ? 2 : 1, reference: leftReference },
      ];
      const marker: FhirExtension = { url: DOSAGE_DETAILS_R5_URL, extension: [
        { url: "dosageDetails", extension: [{ url: "step", extension: components.map(item => ({
          url: "component", extension: [
            ...(identity === "identified" ? [{ url: "id", valueString: item.id }] : []),
            { url: "site", valueCodeableReference: { reference: { reference: item.reference },
              extension: [{ url: "urn:clinic:reference-note", valueString: item.id + " original site" }] } },
            { url: "doseAndRate", extension: [{ url: "doseQuantity", valueQuantity: q(item.value) }] },
          ],
        })) }] },
      ] };
      const rows: FhirDosage[] = [{
        sequence: 1, ...(identity === "identified" ? { id: "left" } : {}),
        doseAndRate: [{ doseQuantity: q(components[1].value) }], modifierExtension: [marker],
      }];
      const before = persist(rows);
      let actual = toDosageDetails(rows);
      for (let save = 0; save < 2; save++) {
        expect(actual.step![0].component).toHaveLength(1);
        const member = actual.step![0].component[0];
        expect(member.doseAndRate![0].doseQuantity!.value).toBe(components[1].value);
        expect(member.site?.reference?.reference).toBe(identity === "anonymous" ? undefined : leftReference);
        if (identity === "anonymous") {
          expect(JSON.stringify(actual.extension)).toContain(rightReference);
          expect(JSON.stringify(actual.extension)).toContain(leftReference);
          expect(JSON.stringify(actual.extension)).toContain("left original site");
        }
        actual = toDosageDetails(persist(toFhirR5Dosages(actual)));
      }
      expect(rows).toEqual(before);
    });

  it.each([0, 1])("previews the submitted phase offsets after %i preceding draft stages", phase => {
    const active: FhirR6Dosage = { id: "active-dose", doseAndRate: [{ doseQuantity: q(2) }],
      timing: { repeat: { frequency: 21, period: 28, periodUnit: FhirPeriodUnit.Day,
        startOffset: { value: 2, unit: "d", code: "d" }, endOffset: { value: 5, unit: "d", code: "d" },
      } } };
    const source: FhirR6DosageInstruction = { step: [
      ...(phase ? [{ id: "induction", component: [{ doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } }] }] : []),
      { id: "active-phase", start: boundary(6), component: [active] },
    ] };
    const rows = persist(toFhirR5Dosages(source));
    const row = rows[phase];
    const before = persist(row);
    const preview = fromFhirDosage(row, { locale: "en", realizationMode: "normalized" });
    expect(preview.longText).toContain("Dosing starts 2 days after the period begins");
    expect(preview.longText).toContain("No doses during the final 5 days of each period");
    const formatted = formatSig(row, "long", { locale: "en", realizationMode: "normalized" });
    expect(formatted).toContain("Dosing starts 2 days after the period begins");
    expect(formatted).toContain("No doses during the final 5 days of each period");
    const native = importCanonicalCourse(persist([row]));
    expect(native.stages.filter(stage => stage.administrations.length)).toHaveLength(1);
    expect(native.stages[phase].administrations[0].amounts?.[0].quantity?.value).toBe(2);
    if (phase) expect(native.stages[0].administrations).toEqual([]);
    expect(row).toEqual(before);
  });

  it.each(["unchanged", "end Element ID", "end displacement"])(
    "keeps only owned editable pauses after a fresh %s change", variant => {
      const saved = toDosageDetails([
        { sequence: 1, id: "induction-dose", doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } },
        { sequence: 3, id: "maintenance-dose", doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: daily } },
      ], undefined, { step: [
        { sequence: 1, id: "induction", end: boundary(1) },
        { sequence: 2, id: "pause", end: boundary(3),
          extension: [{ url: "urn:clinic:pause-note", valueString: "keep authored pause" }] },
        { sequence: 3, id: "maintenance" },
      ] });
      const input = persist(saved);
      if (variant === "end Element ID") input.step![0].end!.id = "current-end-annotation";
      if (variant === "end displacement") input.step![0].end!.offsetDuration!.value = 2;
      const before = persist(input);
      const editable = fromDosageDetails(input);
      expect(editable.course.step!.map(step => step.id)).toEqual(
        variant === "end displacement" ? ["induction", "maintenance"] : ["induction", "pause", "maintenance"]);
      expect(editable.course.step![0].end).toEqual(input.step![0].end);
      const reopened = toDosageDetails(persist(editable.dosages), undefined, persist(editable.course));
      expect(fromDosageDetails(reopened).course.step!.map(step => step.id)).toEqual(
        variant === "end displacement" ? ["induction", "maintenance"] : ["induction", "pause", "maintenance"]);
      expect(JSON.stringify(reopened)).toContain("keep authored pause");
      expect(input).toEqual(before);
    });

  it.each(["exact", "numerator", "lower-bounded numerator"])(
    "does not invent exact ingredient or container totals from %s strength", qualified => {
      const strengthRatio: FhirRatio = {
        numerator: { value: 5, unit: "mg", ...(qualified === "numerator" ? { comparator: "<" as const } :
          qualified === "lower-bounded numerator" ? { comparator: ">=" as const } : {}) },
        denominator: { value: 1, unit: "mL" },
      };
      const before = persist(strengthRatio);
      const drops: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 20, unit: "drop" } }], timing: { repeat: daily } };
      const approximate = calculateTotalUnits({ dosage: drops, ...options, durationValue: 1,
        durationUnit: FhirPeriodUnit.Day, context: { dosageForm: "eye drops", strengthRatio } });
      expect(approximate.totalUnits).toBe(20);
      expect(approximate.totalApproximateQuantity).toMatchObject({ value: 1, unit: "mL" });
      if (qualified === "exact")
        expect(approximate.totalApproximateIngredientQuantity).toMatchObject({ value: 5, unit: "mg" });
      else expect(approximate.totalApproximateIngredientQuantity).toBeUndefined();
      const mass: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 10, unit: "mg" } }], timing: { repeat: daily } };
      const converted = calculateTotalUnits({ dosage: mass, ...options, durationValue: 1,
        durationUnit: FhirPeriodUnit.Day, context: { strengthRatio, containerValue: 1, containerUnit: "mL" } });
      expect(converted).toMatchObject({ totalUnits: 10, unit: "mg" });
      expect(converted.totalContainers).toBe(qualified === "exact" ? 2 : undefined);
      expect(strengthRatio).toEqual(before);
    });
});


describe("round54 import/data fresh interchange", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] };
  const boundary = (value: number) => ({ contextCode: { coding: [{
    system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start",
  }] }, offsetDuration: { value, unit: "d" } });
  const options = { orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-01T00:00:00Z", timeZone: "UTC", limit: 20 };
  const dates = (days: number[]) => days.map(day => "2026-01-" + ("0" + day).slice(-2) + "T09:00:00+00:00");
  const historicalMarker = (step: FhirR6DosageStep): FhirExtension => ({
    url: DOSAGE_DETAILS_R5_URL, extension: [{ url: "dosageDetails",
      extension: [encodeR6SourceMetadata("step", step, "step")] }],
  });

  it.each(["omitted", "unchanged", "version", "version and amount"] as const)(
    "preserves current condition metadata on a fresh historical row (%s)", variant => {
      const condition: FhirR6DosageCondition = {
        code: { coding: [{ system: "urn:clinic:condition", code: "pain", display: "Pain" }] },
        operation: "eq", valueBoolean: true, text: "If pain persists",
        extension: [{ url: "urn:clinic:condition-note", valueString: "keep condition annotation" }],
      };
      const step: FhirR6DosageStep = { id: "historical-phase", component: [{
        id: "historical-dose", doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily }, condition: [condition],
      }] };
      const rows: EzDosage[] = persist(toFhirR5Dosages({ step: [step] }));
      rows[0].modifierExtension = [
        ...(rows[0].modifierExtension ?? []).filter(item => item.url !== DOSAGE_DETAILS_R5_URL),
        historicalMarker(step),
      ];
      const supplied = persist(condition);
      if (variant.startsWith("version")) supplied.code!.coding![0].version = "2026-review";
      if (variant !== "omitted") rows[0].condition = [supplied];
      if (variant === "version and amount") rows[0].doseAndRate![0].doseQuantity!.value = 2;
      const before = persist(rows);
      let wire = toDosageDetails(rows);
      for (let save = 0; save < 2; save++) {
        const member = wire.step![0].component[0];
        expect(member.condition).toEqual([variant === "omitted" ? condition : supplied]);
        expect(member.doseAndRate![0].doseQuantity).toEqual(q(variant === "version and amount" ? 2 : 1));
        expect(member.id).toBe("historical-dose");
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      }
      expect(rows).toEqual(before);
    });

  it.each(["unchanged repeated", "earlier repeated", "earlier single", "annotated repeated"] as const)(
    "keeps only owned pauses after an explicit-end phase (%s)", variant => {
      const count = variant === "earlier single" ? 1 : 2;
      const saved = toDosageDetails([
        { sequence: 1, id: "a-dose", doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } },
        { sequence: 2, id: "b-dose", doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: daily } },
        { sequence: 4, id: "maintenance-dose", doseAndRate: [{ doseQuantity: q(3) }],
          timing: { repeat: { ...daily, count: 1 } } },
      ], undefined, { step: [
        { sequence: 1, id: "phase-a", end: boundary(2) },
        { sequence: 2, id: "phase-b", end: boundary(4), count },
        { sequence: 3, id: "pause", end: boundary(7),
          extension: [{ id: "pause-note", url: "urn:clinic:pause", valueString: "keep original repeated-phase pause" }] },
        { sequence: 4, id: "maintenance" },
      ] });
      let wire = persist(saved);
      if (variant.startsWith("earlier")) wire.step![0].end = boundary(1);
      if (variant === "annotated repeated") wire.step![0].end!.id = "current-boundary-annotation";
      const liveStart = persist(wire.step![wire.step!.length - 1].start);
      const retired = variant === "earlier repeated";
      const expectedDays = retired ? [1, 2, 3, 4, 5, 6, 7, 8] : count === 1 ? [1, 2, 3, 4, 8] : [1, 2, 3, 4, 5, 6, 8];
      const expectedTotal = retired ? 16 : count === 1 ? 10 : 13;
      for (let save = 0; save < 2; save++) {
        const before = persist(wire);
        const editable = fromDosageDetails(wire);
        expect(editable.course.step!.map(step => step.id)).toEqual(
          ["phase-a", "phase-b", ...(!retired ? ["pause"] : []), "maintenance"]);
        expect(wire.step![wire.step!.length - 1].start).toEqual(liveStart);
        expect(nextDueDoses(wire, options)).toEqual(dates(expectedDays));
        expect(calculateTotalUnits({ dosage: wire, ...options, durationValue: 9, durationUnit: FhirPeriodUnit.Day }))
          .toMatchObject({ totalUnits: expectedTotal, unit: "tab" });
        expect(wire).toEqual(before);
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
        expect(JSON.stringify(wire)).toContain("keep original repeated-phase pause");
      }
    });

  it.each(["amount", "period", "unchanged", "missing live ratio"] as const)(
    "completes only the identified projected partial period cap (%s)", variant => {
      const cap: FhirR6DoseLimit = { id: "daily-max", scope: "period",
        valueQuantity: { ...(variant === "period" ? { value: 4 } : {}), unit: "tab",
          extension: [{ url: "urn:clinic:amount-note", valueString: "keep amount note" }] },
        period: { ...(variant === "period" ? {} : { value: 1 }), unit: "d" },
        text: "Keep the authored daily maximum",
        extension: [{ url: "urn:clinic:cap-note", valueString: "keep cap note" }],
      };
      const source = course({ timing: { repeat: daily }, safety: { doseLimit: [cap],
        extension: [{ url: "urn:clinic:safety-note", valueString: "keep safety policy" }] } });
      const rows = persist(toFhirR5Dosages(source));
      if (variant === "amount") rows[0].maxDosePerPeriod![0].numerator!.value = 4;
      if (variant === "period") rows[0].maxDosePerPeriod![0].denominator!.value = 1;
      if (variant === "missing live ratio") delete rows[0].maxDosePerPeriod;
      const before = persist(rows);
      const expected = variant === "amount" || variant === "period"
        ? { ...cap, valueQuantity: { ...cap.valueQuantity, value: 4 }, period: { ...cap.period, value: 1 } } : cap;
      let wire = toDosageDetails(rows);
      for (let save = 0; save < 2; save++) {
        const safety = wire.step![0].component[0].safety!;
        if (variant === "missing live ratio") {
          expect(safety.doseLimit).toBeUndefined();
          const retainedCaps: FhirR6DoseLimit[] = [];
          for (const envelope of wire.extension ?? []) if (envelope.url === DOSAGE_RECONCILIATION_SOURCE_URL)
            for (const marker of envelope.extension ?? []) if (marker.url === DOSAGE_DETAILS_R5_URL)
              retainedCaps.push(...(decodeR5RetainedFields(marker).component?.safety?.doseLimit ?? []));
          expect(retainedCaps).toContainEqual(cap);
        } else expect(safety.doseLimit).toEqual([expected]);
        expect(safety.extension).toEqual(source.step![0].component[0].safety!.extension);
        expect(wire.step![0].component[0].doseAndRate![0].doseQuantity).toEqual(q(1));
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      }
      expect(rows).toEqual(before);
    });

  it.each(["live reference", "strict retained reference", "historical retained reference", "historical current fields", "concept only", "concept and reference"] as const)(
    "previews the independently supplied eye from a fresh %s", variant => {
      const reference = { reference: "BodyStructure/left-eye", display: "left eye",
        extension: [{ url: "urn:clinic:reference-note", valueString: "keep eye reference" }] };
      const component: FhirR6Dosage = { id: "eye-dose", doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }],
        site: { reference } };
      let row: EzDosage;
      if (variant === "strict retained reference" || variant.startsWith("historical")) {
        row = persist(toFhirR5Dosages({ step: [{ component: [component] }] })[0]);
        if (variant.startsWith("historical")) row.modifierExtension = [
          ...(row.modifierExtension ?? []).filter(item => item.url !== DOSAGE_DETAILS_R5_URL),
          historicalMarker({ component: [component] }),
        ];
      } else row = { id: "eye-dose", doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }],
        ...(variant === "concept only" ? {} : { siteReference: reference }),
        ...(variant.startsWith("concept") ? { site: { text: "right eye" } } : {}),
      };
      const currentReference = variant === "historical current fields"
        ? { ...reference, reference: "BodyStructure/right-eye", display: "right eye" } : reference;
      const amount = variant === "historical current fields" ? 2 : 1;
      if (variant === "historical current fields") {
        row.doseAndRate![0].doseQuantity!.value = amount;
        row.siteReference = currentReference;
        row.timing = { repeat: { ...daily, frequency: 2, timeOfDay: ["08:00:00", "20:00:00"] } };
      }
      const before = persist(row);
      const right = variant.startsWith("concept") || variant === "historical current fields";
      const expectedEye = right ? "right eye" : "left eye";
      const otherEye = right ? "left eye" : "right eye";
      for (const mode of [undefined, "normalized"] as const) {
        const preview = fromFhirDosage(persist(row), { locale: "en", realizationMode: mode });
        const formatted = formatSig(persist(row), "long", { locale: "en", realizationMode: mode });
        for (const text of [preview.longText, formatted]) {
          expect(text).toContain(amount === 2 ? "2 drops" : "1 drop");
          expect(text).toContain(expectedEye);
          expect(text).not.toContain(otherEye);
        }
      }
      const native = toDosageDetails(persist([row]));
      const member = native.step![0].component[0];
      expect(member.doseAndRate![0].doseQuantity).toEqual({ value: amount, unit: "drop" });
      if (variant === "historical current fields") expect(member.timing?.repeat).toEqual(row.timing!.repeat);
      if (variant !== "concept only") expect(member.site?.reference).toEqual(currentReference);
      const reopened = toDosageDetails(persist(toFhirR5Dosages(native)));
      expect(reopened.step![0].component[0].site).toEqual(member.site);
      expect(row).toEqual(before);
    });

  it.each(["weekday", "when"] as const)(
    "accepts typed current R6 %s primitive slots while keeping recurrence value-only", kind => {
      const annotation = { id: "metadata-only-slot", extension: [{
        url: "urn:clinic:timing-note", valueString: "keep positional timing annotation",
      }] };
      const timing: FhirR6Timing = { repeat: kind === "weekday"
        ? { ...daily, dayOfWeek: [null, FhirDayOfWeek.Monday], _dayOfWeek: [annotation, null] }
        : { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          when: [EventTiming.Morning, null], _when: [null, annotation] } };
      const input: FhirR6DosageInstruction = { step: [{ component: [{
        id: "typed-timing-dose", doseAndRate: [{ doseQuantity: q(1) }], timing,
      }] }] };
      const before = persist(input);
      const native = importCanonicalCourse(input);
      const recurrence = native.stages[0].administrations[0].schedule!.recurrence!;
      expect(recurrence.dayOfWeek).toEqual(kind === "weekday" ? [FhirDayOfWeek.Monday] : undefined);
      expect(recurrence.anchors).toEqual(kind === "when" ? [EventTiming.Morning] : undefined);
      let wire = projectCanonicalCourse(native).fhirNext;
      for (let save = 0; save < 2; save++) {
        const repeat = wire.step![0].component[0].timing!.repeat!;
        expect(repeat.dayOfWeek).toEqual(timing.repeat!.dayOfWeek);
        expect(repeat.when).toEqual(timing.repeat!.when);
        expect(repeat).toMatchObject(kind === "weekday" ? { _dayOfWeek: [annotation, null] } : { _when: [null, annotation] });
        expect(nextDueDoses(wire, { orderedAt: "2026-01-04T00:00:00Z", from: "2026-01-04T00:00:00Z",
          timeZone: "UTC", limit: 2, eventClock: { MORN: "09:00" } }))
          .toEqual(dates(kind === "weekday" ? [5, 12] : [4, 5]));
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      }
      expect(input).toEqual(before);
    });
});

describe("round55 interop current ownership", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] };
  const boundary = (value: number, anchor = "treatment-start") => ({ contextCode: { coding: [{
    system: anchor === "treatment-start" ? "http://hl7.org/fhir/evidence-variable-event"
      : "urn:ezmedicationinput:CodeSystem:course-phase-event", code: anchor,
  }] }, offsetDuration: { value, unit: "d" } });
  const options = { orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-01T00:00:00Z", timeZone: "UTC", limit: 20 };
  const dates = (days: number[]) => days.map(day => "2026-01-" + ("0" + day).slice(-2) + "T09:00:00+00:00");
  const sourceCaps = (wire: FhirR6DosageInstruction): FhirR6DoseLimit[] => {
    const result: FhirR6DoseLimit[] = [];
    for (const envelope of wire.extension ?? []) if (envelope.url === DOSAGE_RECONCILIATION_SOURCE_URL)
      for (const marker of envelope.extension ?? []) if (marker.url === DOSAGE_DETAILS_R5_URL)
        result.push(...(decodeR5RetainedFields(marker).component?.safety?.doseLimit ?? []));
    return result;
  };

  it.each(["unchanged repeated", "earlier repeated", "earlier single", "annotated repeated"] as const)(
    "reconciles a fixed-end phase after its own fresh start edit (%s)", variant => {
      const count = variant === "earlier single" ? 1 : 2;
      const saved = toDosageDetails([
        { sequence: 1, id: "a-dose", doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } },
        { sequence: 2, id: "b-dose", doseAndRate: [{ doseQuantity: q(2) }],
          timing: { repeat: { ...daily, boundsDuration: { value: 1, unit: "d" } } } },
        { sequence: 4, id: "maintenance-dose", doseAndRate: [{ doseQuantity: q(3) }],
          timing: { repeat: { ...daily, count: 1 } } },
      ], undefined, { step: [
        { sequence: 1, id: "phase-a", start: boundary(1), end: boundary(3), count },
        { sequence: 2, id: "phase-b" },
        { sequence: 3, id: "pause", end: boundary(7),
          extension: [{ url: "urn:clinic:pause", valueString: "keep the original fixed-end pause" }] },
        { sequence: 4, id: "maintenance" },
      ] });
      let wire = persist(saved);
      if (variant.startsWith("earlier")) wire.step![0].start = boundary(0);
      if (variant === "annotated repeated") wire.step![0].start!.id = "current-start-note";
      const retired = variant === "earlier repeated";
      const expectedDays = retired ? [1, 2, 3, 4, 5, 6, 7, 8]
        : count === 1 ? [1, 2, 3, 4, 8] : [2, 3, 4, 5, 6, 8];
      for (let save = 0; save < 2; save++) {
        const before = persist(wire);
        expect(fromDosageDetails(wire).course.step!.map(step => step.id))
          .toEqual(["phase-a", "phase-b", ...(!retired ? ["pause"] : []), "maintenance"]);
        expect(nextDueDoses(wire, options)).toEqual(dates(expectedDays));
        expect(calculateTotalUnits({ dosage: wire, ...options, durationValue: 9, durationUnit: FhirPeriodUnit.Day }))
          .toMatchObject({ totalUnits: retired ? 11 : count === 1 ? 8 : 9, unit: "tab" });
        expect(wire).toEqual(before);
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
        expect(JSON.stringify(wire)).toContain("keep the original fixed-end pause");
      }
    });

  it.each(["unchanged", "dose edit", "delete amount-missing", "delete period-missing"] as const)(
    "keeps a submitted partial period maximum active only while present (%s)", variant => {
      const cap: FhirR6DoseLimit = { id: "partial-period-cap", scope: "period",
        valueQuantity: { ...(variant === "delete period-missing" ? { value: 4 } : {}), unit: "tab",
          extension: [{ url: "urn:clinic:partial-amount", valueString: "awaiting prescribed amount" }] },
        period: { ...(variant === "delete period-missing" ? {} : { value: 1 }), unit: "d",
          extension: [{ url: "urn:clinic:partial-period", valueString: "keep original period annotation" }] },
        text: "Awaiting the completed daily maximum",
        extension: [{ url: "urn:clinic:partial-limit", valueString: "retain complete authored limit" }],
      };
      const safetyNote = { url: "urn:clinic:safety-owner", valueString: "independent safety annotation" };
      const original = course({ timing: { repeat: daily }, safety: { doseLimit: [cap], extension: [safetyNote] } });
      const rows = persist(toFhirR5Dosages(original));
      if (variant === "dose edit") rows[0].doseAndRate![0].doseQuantity!.value = 2;
      if (variant.startsWith("delete")) delete rows[0].maxDosePerPeriod;
      const before = persist(rows), deleted = variant.startsWith("delete");
      let wire = toDosageDetails(rows);
      for (let save = 0; save < 2; save++) {
        const member = wire.step![0].component[0];
        expect(member.safety?.doseLimit).toEqual(deleted ? undefined : [cap]);
        expect(member.safety?.extension).toEqual([safetyNote]);
        expect(member.doseAndRate![0].doseQuantity).toEqual(q(variant === "dose edit" ? 2 : 1));
        expect(calculateTotalUnits({ dosage: wire, ...options, durationValue: 2, durationUnit: FhirPeriodUnit.Day }))
          .toMatchObject({ totalUnits: variant === "dose edit" ? 4 : 2, unit: "tab" });
        if (deleted) expect(sourceCaps(wire)).toContainEqual(cap);
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      }
      expect(rows).toEqual(before);
    });

  it.each(["plain", "extra child", "marker annotation"] as const)(
    "restores a source-only Ratio without losing enriched marker data (%s)", variant => {
      const ratio: FhirRatio = { id: "pending-window", extension: [
        { url: "urn:clinic:pending-amount-source", valueQuantity: q(4) },
        { url: "urn:clinic:pending-period-source", extension: [{
          id: "pending-period", url: "urn:clinic:period-note", valueString: "period remains unentered",
        }] },
      ] };
      const input = persist(toDosageDetails([{ doseAndRate: [{ doseQuantity: q(1) }], maxDosePerPeriod: [ratio] }]));
      const marker = input.step![0].component[0].extension!.find(item => item.url === R5_SOURCE_ONLY_MAXIMUM_URL)!;
      if (variant === "extra child") marker.extension!.push({ url: "urn:clinic:unknown-marker-child",
        valueString: "keep the source-only marker annotation" });
      if (variant === "marker annotation") marker.id = "annotated-maximum-marker";
      const before = persist(input), expectedMarker = persist(marker);
      let rows = toFhirR5Dosages(input);
      for (let save = 0; save < 2; save++) {
        expect(rows[0].maxDosePerPeriod).toEqual([ratio]);
        const history: FhirExtension[] = [];
        for (const envelope of rows[0].extension ?? [])
          if (envelope.url === DOSAGE_RECONCILIATION_SOURCE_URL) history.push(...(envelope.extension ?? []));
        if (variant === "plain") expect(history).not.toContainEqual(expectedMarker);
        else expect(history).toContainEqual(expectedMarker);
        const native = toDosageDetails(persist(rows));
        expect(native.step![0].component[0].safety?.doseLimit).toBeUndefined();
        rows = toFhirR5Dosages(persist(native));
      }
      expect(input).toEqual(before);
    });

  it.each(["unchanged", "replacement", "companion only", "wording only"] as const)(
    "applies the submitted instruction companion to a populated historical save (%s)", variant => {
      const oldPrimitive = { id: "historical-instruction", extension: [{
        url: "http://hl7.org/fhir/StructureDefinition/translation", extension: [
          { url: "lang", valueCode: "th" }, { url: "content", valueString: "รับประทานครั้งละ 1 เม็ด" },
        ],
      }, { url: "urn:clinic:old-header-note", valueString: "keep original header annotation" }] };
      const currentPrimitive = { id: "current-instruction", extension: [
        { url: "urn:clinic:current-header-note", valueString: "current header annotation" },
      ] };
      const original = { renderedInstruction: "Take 1 tablet daily", _renderedInstruction: oldPrimitive };
      const fields = encodeR5RetainedFields({ course: original }).find(item => item.url === "course")!.extension!;
      const step: FhirR6DosageStep = { component: [{ id: "historical-dose",
        doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } }] };
      const rows: EzDosage[] = [{ sequence: 1, id: "historical-dose",
        doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily }, modifierExtension: [{
        url: DOSAGE_DETAILS_R5_URL, extension: [{ url: "dosageDetails",
          extension: [...fields, encodeR6SourceMetadata("step", step, "step")] }],
      }] }];
      const edits: EzCourseMetadata & Pick<FhirR6DosageInstruction, "_renderedInstruction"> = {
        ...original, ...(variant === "replacement" || variant === "wording only" ? { renderedInstruction: "Current one-tablet instruction" } : {}),
        ...(variant === "replacement" || variant === "companion only" ? { _renderedInstruction: currentPrimitive } : {}),
      };
      const before = persist({ rows, edits });
      let wire = toDosageDetails(rows, edits.renderedInstruction, edits);
      for (let save = 0; save < 2; save++) {
        expect(wire.renderedInstruction).toBe(edits.renderedInstruction);
        expect(wire._renderedInstruction).toEqual(variant === "replacement" || variant === "companion only"
          ? currentPrimitive : variant === "wording only" ? { id: oldPrimitive.id, extension: [oldPrimitive.extension[1]] } : oldPrimitive);
        expect(wire.step![0].component[0].doseAndRate![0].doseQuantity).toEqual(q(1));
        if (variant !== "unchanged") {
          const saved: Array<Partial<EzCourseMetadata> | undefined> = [];
          for (const envelope of wire.extension ?? []) if (envelope.url === DOSAGE_RECONCILIATION_SOURCE_URL)
            for (const marker of envelope.extension ?? []) if (marker.url === DOSAGE_DETAILS_R5_URL) {
              const historical = marker.extension?.find(item => item.url === "dosageDetails");
              saved.push(decodeR5RetainedFields(historical ? { url: DOSAGE_DETAILS_R5_URL,
                extension: [{ url: "course", extension: historical.extension }] } : marker).course);
            }
          expect(saved).toContainEqual(expect.objectContaining(original));
        }
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      }
      expect({ rows, edits }).toEqual(before);
    });

  it.each(["treatment-start", "treatment-day-start", "previous-phase-next-day"] as const)(
    "requires a removed predecessor only for a dependent member start (%s)", anchor => {
      const start = boundary(4, anchor);
      const marker = encodeR6SourceMetadata(PARALLEL_COMPONENT_PHASE_ORIGIN_URL, { start }, "step");
      const original: FhirR6DosageInstruction = { step: [
        { component: [{ id: "removed-dose", doseAndRate: [{ doseQuantity: q(2) }],
          timing: { repeat: { ...daily, count: 1 } } }] },
        { component: [{ id: "survivor", doseAndRate: [{ doseQuantity: q(1) }],
          modifierExtension: [marker], timing: { repeat: { ...daily, count: 2,
            boundsPeriod: { start: "2026-01-05T00:00:00Z" } } } }] },
      ] };
      const rows = persist(toFhirR5Dosages(original)).slice(1);
      const before = persist(rows), dependent = anchor === "previous-phase-next-day";
      let current = rows;
      for (let save = 0; save < 2; save++) {
        const native = importCanonicalCourse(current);
        const member = native.stages[1].administrations[0];
        expect(member.phaseStart?.anchor).toBe(anchor);
        if (dependent) {
          expect(member.missingContexts).toContain("predecessor");
          expect(() => nextDueDoses(current, options)).toThrow(/complete dosage array/i);
        } else {
          expect(member.missingContexts).toBeUndefined();
          expect(native.contextIssue).toBeUndefined();
          expect(nextDueDoses(current, options)).toEqual(dates([5, 6]));
        }
        const wire = toDosageDetails(persist(current));
        expect(wire.step!.find(step => step.component.some(item => item.id === "survivor"))!
          .component[0].modifierExtension).toContainEqual(marker);
        current = persist(toFhirR5Dosages(wire));
      }
      expect(rows).toEqual(before);
    });

  it.each(["weekday", "when"] as const)(
    "accepts typed R5 positional %s metadata without adding clinical values", kind => {
      const annotation = { id: "r5-metadata-slot", extension: [{
        url: "urn:clinic:repeat-note", valueString: "keep R5 primitive positions",
      }] };
      const rows: FhirDosage[] = [{ doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: kind === "weekday"
        ? { ...daily, dayOfWeek: [null, FhirDayOfWeek.Monday], _dayOfWeek: [annotation, null] }
        : { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          when: [null, EventTiming.Morning], _when: [annotation, null] } } }];
      const before = persist(rows);
      let current = rows;
      for (let save = 0; save < 2; save++) {
        const native = importCanonicalCourse(current), recurrence = native.stages[0].administrations[0].schedule!.recurrence!;
        expect(recurrence.dayOfWeek).toEqual(kind === "weekday" ? [FhirDayOfWeek.Monday] : undefined);
        expect(recurrence.anchors).toEqual(kind === "when" ? [EventTiming.Morning] : undefined);
        const wire = toDosageDetails(current);
        expect(wire.step![0].component[0].timing!.repeat).toEqual(rows[0].timing!.repeat);
        const output: FhirDosage[] = toFhirR5Dosages(persist(wire));
        expect(output[0].timing!.repeat).toEqual(rows[0].timing!.repeat);
        expect(output[0].timing!.repeat!._dayOfWeek).toEqual(rows[0].timing!.repeat!._dayOfWeek);
        expect(output[0].timing!.repeat!._when).toEqual(rows[0].timing!.repeat!._when);
        expect(nextDueDoses(output, { orderedAt: "2026-01-04T00:00:00Z", from: "2026-01-04T00:00:00Z",
          timeZone: "UTC", limit: 2, eventClock: { MORN: "09:00" } })).toEqual(dates(kind === "weekday" ? [5, 12] : [4, 5]));
        current = persist(output);
      }
      expect(rows).toEqual(before);
    });
});

describe("round55 maximum-only R5 primitive ownership", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] };
  const missingMinimum = { extension: [{
    url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown",
  }] };
  it.each(["maximum only", "authored companion", "exact", "range"] as const)(
    "retains active count facts and the submitted minimum companion (%s)", variant => {
      const authored = { id: "authored-count-note", extension: [{
        url: "urn:clinic:count-note", valueString: "no minimum was supplied",
      }] };
      const input = course({ timing: { repeat: { ...daily,
        ...(variant === "exact" ? { count: 3 } : variant === "range" ? { count: 2, countMax: 3 } : { countMax: 3 }),
        ...(variant === "authored companion" ? { _count: authored } : {}),
      } } });
      const before = persist(input), count = variant === "exact" ? 3 : variant === "range" ? 2 : undefined;
      let rows = toFhirR5Dosages(input);
      for (let save = 0; save < 2; save++) {
        const repeat = rows[0].timing!.repeat!;
        expect(repeat.count).toBe(count);
        expect(repeat.countMax).toBe(variant === "exact" ? undefined : 3);
        expect(repeat._count).toEqual(variant === "authored companion" ? authored : variant === "maximum only" ? missingMinimum : undefined);
        const native = importCanonicalCourse(persist(rows)).stages[0].administrations[0].schedule!.recurrence!;
        expect(native.count).toBe(count);
        expect(native.countMax).toBe(variant === "exact" ? undefined : 3);
        if (variant === "maximum only" || variant === "authored companion")
          expect(formatSig(rows, "long", { locale: "en", realizationMode: "normalized" })).toContain("up to 3 doses");
        if (variant !== "range") expect(nextDueDoses(rows, { orderedAt: "2026-01-01T00:00:00Z",
          from: "2026-01-01T00:00:00Z", timeZone: "UTC", limit: 10 }))
          .toEqual(["2026-01-01T09:00:00+00:00", "2026-01-02T09:00:00+00:00", "2026-01-03T09:00:00+00:00"]);
        rows = toFhirR5Dosages(persist(toDosageDetails(persist(rows))));
      }
      expect(input).toEqual(before);
    });

  it.each(["Take 1 tablet every 6 hours as needed for pain, up to 3 doses",
    "1 tab sl q5min prn chest pain max 3 doses"])(
    "exports an extension-only minimum without changing the authored ceiling (%s)", text => {
      const parsed = parseSig(text);
      const rows = persist(parsed.fhir), before = persist(rows);
      expect(rows[0].timing!.repeat).toMatchObject({ countMax: 3, _count: missingMinimum });
      expect(rows[0].timing!.repeat!.count).toBeUndefined();
      const native = importCanonicalCourse(rows).stages[0].administrations[0];
      expect(native.schedule!.recurrence!.count).toBeUndefined();
      expect(native.schedule!.recurrence!.countMax).toBe(3);
      expect(native.asNeeded).toBe(true);
      const wire = toDosageDetails(persist(rows));
      const saved = toFhirR5Dosages(persist(wire));
      expect(saved[0].timing!.repeat).toMatchObject({ countMax: 3, _count: missingMinimum });
      expect(saved[0].timing!.repeat!.count).toBeUndefined();
      expect(formatSig(persist(saved), "long", { locale: "en", realizationMode: "normalized" })).toContain("up to 3 doses");
      expect(rows).toEqual(before);
    });
});


describe("round56 interop current ownership", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] };
  const boundary = (value: number) => ({ contextCode: { coding: [{
    system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start",
  }] }, offsetDuration: { value, unit: "d" } });
  const options = { orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-01T00:00:00Z", timeZone: "UTC", limit: 20 };
  const dates = (days: number[]) => days.map(day => "2026-01-" + ("0" + day).slice(-2) + "T09:00:00+00:00");
  const historicalMarker = (step: FhirR6DosageStep): FhirExtension => ({
    url: DOSAGE_DETAILS_R5_URL, extension: [{ url: "dosageDetails",
      extension: [encodeR6SourceMetadata("step", step, "step")] }],
  });

  const completionInput = (variant: string): FhirR6DosageInstruction => {
    const saved = toDosageDetails([
      { sequence: 1, id: "first-dose", doseAndRate: [{ doseQuantity: q(1) }],
        timing: { repeat: { ...daily, boundsDuration: { value: 1, unit: "d" } } } },
      { sequence: 2, id: "second-dose", doseAndRate: [{ doseQuantity: q(2) }],
        timing: { repeat: { ...daily, boundsDuration: { value: 1, unit: "d" } } } },
      { sequence: 4, id: "maintenance-dose", doseAndRate: [{ doseQuantity: q(3) }],
        timing: { repeat: { ...daily, count: 1 } } },
    ], undefined, { step: [
      { sequence: 1, id: "first-phase" }, { sequence: 2, id: "second-phase" },
      { sequence: 3, id: "pause", end: boundary(3),
        extension: [{ url: "urn:clinic:pause-owner", valueString: "keep the authored pause boundary" }] },
      { sequence: 4, id: "maintenance" },
    ] });
    const input = persist(saved);
    if (variant.includes("owner")) input.step![0].id = "replacement-first-phase";
    if (variant.includes("duration"))
      input.step![0].component[0].timing!.repeat!.boundsDuration!.value = 2;
    return input;
  };

  const actionInput = (variant: string): FhirR6DosageInstruction => {
    const saved = toDosageDetails([{ sequence: 1, id: "dose", doseAndRate: [{ doseQuantity: q(1) }],
      timing: { repeat: daily } }], undefined, {
      safety: { id: "course-policy", ifExceeded: "Call the clinic",
        doseLimit: [{ id: "course-cap", scope: "period", valueQuantity: q(8), period: { value: 1, unit: "d" } }],
        extension: [{ url: "urn:clinic:course-policy-note", valueString: "keep the course annotation" }] },
      step: [{ sequence: 1, id: "phase", safety: { id: "phase-policy", ifExceeded: "Hold the next dose",
        doseLimit: [{ id: "phase-cap", scope: "administration", valueQuantity: q(2) }],
        extension: [{ url: "urn:clinic:phase-policy-note", valueString: "keep the retired phase annotation" }] } }],
    });
    const input = persist(saved);
    if (variant !== "unchanged")
      input.safety!.doseLimit = input.safety!.doseLimit!.filter(limit => limit.id !== "phase-cap");
    if (variant === "new action") input.safety!.ifExceeded = "Contact the prescriber now";
    return input;
  };

  const referenceInput = (variant: string) => {
    const reference = { reference: "BodyStructure/left-eye", identifier: {
      type: { coding: [{ system: "urn:clinic:body-identifier", code: "eye",
        extension: [{ url: "urn:clinic:identifier-note", valueString: "original site identifier annotation" }] }] },
      system: "urn:clinic:body-site", value: "left-eye",
    } };
    const step: FhirR6DosageStep = { id: "historical-phase", component: [{
      id: "historical-dose", doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily },
      site: { concept: { text: "left eye" }, reference },
    }] };
    const rows: EzDosage[] = persist(toFhirR5Dosages({ step: [step] }));
    rows[0].modifierExtension = [
      ...(rows[0].modifierExtension ?? []).filter(item => item.url !== DOSAGE_DETAILS_R5_URL), historicalMarker(step),
    ];
    const supplied: NonNullable<EzDosage["siteReference"]> = persist(reference);
    if (variant.startsWith("version")) {
      supplied.identifier!.type!.coding![0].version = "2026-11";
      if (variant === "version and dose") supplied.identifier!.type!.coding![0]._version = { id: "current-version",
        extension: [{ url: "urn:clinic:version-note", valueString: "current identifier coding version" }] };
    }
    if (variant !== "omitted") rows[0].siteReference = variant === "clear" ? undefined : supplied;
    if (variant === "version and dose") rows[0].doseAndRate![0].doseQuantity!.value = 2;
    return { rows, reference, supplied };
  };

  const exclusionInput = (variant: string): EzDosage | FhirR6DosageInstructionInput => ({
    ...(variant === "R6 safety header" ? {} : { excludedDates: ["2026-12-25"] }),
    ...(variant === "date only" ? {} : { safety: { doseLimit: [{
      scope: "administration" as const, valueQuantity: q(2),
    }] } }),
  });

  const partialInput = (variant: string) => {
    const ratio: FhirRatio = { id: "authored-period-limit",
      numerator: { ...(variant === "missing amount" ? {} : { value: 1 }), unit: "tab",
        extension: [{ url: "urn:clinic:amount-note", valueString: "keep authored amount metadata" }] },
      denominator: { ...(variant === "missing period" ? {} : { value: 1 }), unit: "d",
        extension: [{ url: "urn:clinic:period-note", valueString: "keep authored period metadata" }] },
      extension: [{ url: "urn:clinic:ratio-note", valueString: "keep the incomplete Ratio" }],
    };
    const rows: EzDosage[] = [{ doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: {
      ...daily, frequency: 2, timeOfDay: ["08:00:00", "20:00:00"],
    } }, maxDosePerPeriod: [ratio] }];
    return { rows, ratio };
  };

  it.each(["unchanged", "owner", "duration", "owner and duration"] as const)(
    "propagates current completion independently of a prior phase owner (%s)", variant => {
      let wire = completionInput(variant);
      const changed = variant.includes("duration");
      for (let save = 0; save < 2; save++) {
        const before = persist(wire);
        expect(fromDosageDetails(wire).course.step!.map(step => step.id)).toEqual([
          variant.includes("owner") ? "replacement-first-phase" : "first-phase",
          "second-phase", ...(!changed ? ["pause"] : []), "maintenance",
        ]);
        expect(nextDueDoses(wire, options)).toEqual(dates(changed ? [1, 2, 3, 4] : [1, 2, 4]));
        expect(calculateTotalUnits({ dosage: wire, ...options, durationValue: 5, durationUnit: FhirPeriodUnit.Day }))
          .toMatchObject({ totalUnits: changed ? 7 : 6, unit: "tab" });
        expect(wire).toEqual(before);
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
        expect(JSON.stringify(wire)).toContain("keep the authored pause boundary");
      }
    });

  it.each(["unchanged", "retired phase", "new action"] as const)(
    "keeps the course action separate from a removed phase limit (%s)", variant => {
      let wire = actionInput(variant);
      for (let save = 0; save < 2; save++) {
        const before = persist(wire), reopened = fromDosageDetails(wire);
        expect(reopened.course.safety?.ifExceeded)
          .toBe(variant === "new action" ? "Contact the prescriber now" : "Call the clinic");
        expect(reopened.course.safety?.doseLimit?.map(limit => limit.id)).toEqual(["course-cap"]);
        expect(reopened.course.step![0].safety?.doseLimit?.map(limit => limit.id))
          .toEqual(variant === "unchanged" ? ["phase-cap"] : undefined);
        expect(reopened.course.step![0].safety?.ifExceeded)
          .toBe(variant === "unchanged" ? "Hold the next dose" : undefined);
        expect(reopened.course.safety?.extension)
          .toContainEqual({ url: "urn:clinic:course-policy-note", valueString: "keep the course annotation" });
        expect(wire).toEqual(before);
        wire = toDosageDetails(reopened.dosages, undefined, reopened.course);
        expect(wire.safety?.ifExceeded).toBe(variant === "unchanged" ? "Call the clinic\nHold the next dose"
          : variant === "new action" ? "Contact the prescriber now" : "Call the clinic");
        expect(JSON.stringify(wire)).toContain("keep the retired phase annotation");
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      }
    });

  it.each(["omitted", "unchanged", "version", "version and dose", "clear"] as const)(
    "retains the supplied historical site-reference Coding fields (%s)", variant => {
      const { rows, reference, supplied } = referenceInput(variant), before = persist(rows);
      let wire = toDosageDetails(rows);
      for (let save = 0; save < 2; save++) {
        const member = wire.step![0].component[0];
        expect(member.site?.reference).toEqual(variant === "clear" ? undefined : variant === "omitted" ? reference : supplied);
        expect(member.site?.concept).toEqual({ text: "left eye" });
        expect(member.doseAndRate![0].doseQuantity).toEqual(q(variant === "version and dose" ? 2 : 1));
        expect(member.timing?.repeat).toEqual(daily);
        expect(JSON.stringify(wire)).toContain("original site identifier annotation");
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      }
      expect(persist(rows)).toEqual(before);
      if (variant === "clear") expect(Object.prototype.hasOwnProperty.call(rows[0], "siteReference")).toBe(true);
    });

  it.each(["date only", "date and safety", "R6 safety header"] as const)(
    "distinguishes partial R5 exclusions from a genuine R6 safety header (%s)", variant => {
      const input = exclusionInput(variant), before = persist(input);
      const native = importCanonicalCourse(input);
      for (const style of ["short", "long"] as const) {
        const text = formatSig(input, style, { locale: "en" });
        if (variant === "R6 safety header") {
          expect(text).toBe("Across this course: max per administration: 2 tab");
          expect(native.stages).toEqual([]);
          expect(native.safety?.limits?.[0].amount).toEqual(q(2));
        } else {
          expect(text).toContain("except 2026-12-25");
          expect(native.stages[0].administrations[0].excludedDates).toEqual(["2026-12-25"]);
          if (variant === "date and safety") expect(text).toContain("max per administration: 2 tab");
        }
      }
      expect(input).toEqual(before);
    });

  it.each(["missing amount", "missing period", "complete"] as const)(
    "lifts an authored editable period Ratio without inventing or duplicating a value (%s)", variant => {
      const { rows, ratio } = partialInput(variant), before = persist(rows);
      const lifted = toEzDosages(rows);
      expect(lifted[0].maxDosePerPeriod).toEqual([ratio]);
      expect(lifted[0].safety?.doseLimit).toEqual([{
        id: ratio.id, extension: ratio.extension, scope: "period",
        valueQuantity: ratio.numerator, period: ratio.denominator,
      }]);
      expect(rows).toEqual(before);
      let wire = toDosageDetails(lifted);
      for (let save = 0; save < 2; save++) {
        const exported = toFhirR5Dosages(wire);
        expect(exported[0].maxDosePerPeriod).toEqual([ratio]);
        expect(toEzDosages(persist(exported))[0].safety?.doseLimit).toHaveLength(1);
        expect(calculateTotalUnits({ dosage: wire, ...options, durationValue: 2, durationUnit: FhirPeriodUnit.Day }))
          .toMatchObject({ totalUnits: variant === "complete" ? 2 : 4, unit: "tab" });
        wire = toDosageDetails(persist(exported));
      }
    });
});
}
