import retainedCourseProfile from "../fhir/r5/medication-r6-course-details.json";
import { COURSE_CYCLE_COUNT_EXTENSION_URL, getCourseCycleCount, setCourseCycleCount } from "../src/dosage-course";
import { describe, expect, it } from "vitest";
import {
  fromDosageDetails, fromFhir, fromFhirDosage, toDosageDetails, toFhirR5Dosages, parseSig, parseSig as parsePublicSig, parseInstructionActions, formatSig, importCanonicalCourse, projectCanonicalCourse,
  type EzDosage, type FhirDosage, type FhirExtension, type FhirR6Extension, type FhirElement, type FhirR6PrimitiveElement, type FhirRatio, type FhirR6Ratio, type FhirR6Dosage,
  FhirPeriodUnit, FhirDayOfWeek, EventTiming, nextDueDoses, calculateTotalUnits,
  type FhirR6DosageInstruction, type FhirR6Quantity, type FhirR6SimpleQuantity, type FhirR6DosageInstructionInput,
  type FhirR6Expression, type FhirR6Range, type FhirR6Period, type FhirPeriod, type FhirR6CodeableConcept, type FhirR6Reference, type FhirR6DoseAndRate, type FhirDoseAndRate, type FhirR6DosageCondition, type FhirR6Timing, type FhirR6DosageStep, type FhirR6RelativeTime, type FhirReference,
  registerMedicationLocaleDetector, inferMedicationLocale, registerMedicationSurfaceSegmenter,
  listMedicationSurfaceSegmenters, registerMedicationDateResolver, cloneBodySiteSpatialRelation,
  buildBodySiteSpatialRelationExtension, parseBodySiteSpatialRelationExtension,
  registerSigLocalization, getMedicationInstructionAction,
  formatCanonicalCourse, formatCanonicalAdministration, formatSigBatch, formatParseBatch, suggestSig,
  buildInstructionGraphExtension, parseInstructionGraphExtension, AdviceForce, AdviceArgumentRole, AdviceRelation,
  type CanonicalInstructionGraph,
} from "../src/index";
import {
  DOSAGE_CONDITION_R5_URL, DOSAGE_RECONCILIATION_WARNING_URL, DOSAGE_RECONCILIATION_SOURCE_URL, DOSAGE_RENDERED_INSTRUCTION_R5_URL, DOSAGE_RETAINED_R5_SEQUENCE_URL,
  setDosageCondition, getDosageCondition, getDosageCalendarDayCondition, conditionToR6, toEzDosages, isExactConditionBridge, DOSAGE_DETAILS_R5_URL, decodeR5RetainedFields, encodeR5RetainedFields,
  decodeR6SourceMetadata, encodeR6SourceMetadata, readRetainedField, retainField, sourceWithoutNestedHistory, withDosageEditProvenance, isRenderedInstructionMarker, getDosageSourceTextAgreement,
  PARALLEL_COMPONENT_PHASE_ORIGIN_URL, DOSAGE_ALTERNATIVE_CHOICE_URL, setDosageAlternativeChoice,
  DOSAGE_EXCLUDED_DATES_R5_URL, DOSAGE_EXCLUDED_WEEKDAYS_R5_URL,
  setDosageExcludedDates, getDosageExcludedDates, setDosageExcludedWeekdays, R5_RATE_MODIFIERS_R6_URL,
  dosageMatchesSavedProjection, dosageProjectionFingerprint, R5_EXPRESSION_SLOT_SOURCE_URL, fromR6Dosage,
} from "../src/dosage-course";
import {
  EMA_QUANTITY_COMPARATOR_EXTENSION_URL, EMA_QUANTITY_OPERATOR_SYSTEM, QUANTITY_OPERATOR_SOURCE_URL,
  simpleQuantityForR5, quantityForR5, quantityFromR5, getQuantityComparator, quantityFromWire, getEmaQuantityComparator,
} from "../src/fhir-quantity-operator";
import {
  PRN_TRIGGER_PHASE_EXTENSION_URL, TIMING_ADDITIONAL_CLOCK_EXTENSION_URL, TIMING_OFFSET_MIN_EXTENSION_URL, TIMING_OFFSET_MAX_EXTENSION_URL,
  TIMING_OFFSET_EXACT_EXTENSION_URL, TIMING_FREQUENCY_MIN_EXTENSION_URL, TIMING_DAY_OF_MONTH_EXTENSION_URL,
  canonicalFromFhir, canonicalToFhir, parserStateFromFhir, toFhir as parserStateToFhir, getAnchoredCourseDuration, TIMING_ACTIVITY_WINDOW_EXTENSION_URL,
  CYCLE_DAY_ELIGIBILITY_EXTENSION_URL, ANCHORED_COURSE_DURATION_EXTENSION_URL, TIMING_ADMINISTRATION_DURATION_EXTENSION_URL,
  ADMINISTRATION_OFFSET_EXTENSION_URL, getTimingClocks, getTimingMonthDays, getTimingWeekdayOrdinal, getTimingOccurrenceCap, cycleDayConstraintExtension, getCycleDayConstraint,
} from "../src/fhir";
import { courseToR6, courseFromR6, courseToR5, administrationFromR5, boundaryToWire, R5_SOURCE_ONLY_MAXIMUM_URL } from "../src/adapters/canonical-course";
import { courseFromR5 } from "../src/adapters/r5-import";
import { R6_DRAFT_STEPS_SOURCE_URL, R6_SINGLE_STEP_SAFETY_SOURCE_URL, R6_SCOPED_SAFETY_MODIFIER_URL } from "../src/adapters/r6-editable-metadata";

import { getPrimitiveTranslation, getPrimitiveTranslations, FHIR_TRANSLATION_EXTENSION_URL } from "../src/fhir-translations";
import { numericAdministrationLimits, type CanonicalCourse } from "../src/canonical/course";
import { type EzCourseMetadata, type FhirR6DosageSafety, type FormatOptions, type FhirR6DoseLimit, type ParseOptions } from "../src/types";

const persist = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const q = (value: number) => ({ value, unit: "tab" });
const expression = (name: string) => ({ language: "text/fhirpath", expression: "%" + name });
const course = (component: Partial<FhirR6Dosage> = {}): FhirR6DosageInstruction => ({
  step: [{ component: [{ doseAndRate: [{ doseQuantity: q(1) }], ...component }] }],
});
const r6Save = (value: FhirR6DosageInstruction): FhirR6DosageInstruction => {
  return projectCanonicalCourse(importCanonicalCourse(persist(value))).fhirNext;
};


// Retained regression suite from test/pr14-round21-r5.spec.ts.
{
// BEGIN PRESERVED r521








const persist = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const rowDose = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] };
const componentSafety = (course: FhirR6DosageInstruction) => course.step![0].component[0].safety;
function historicalRows(extra: FhirExtension[] = []): EzDosage[] {
  const marker: FhirExtension = { url: DOSAGE_DETAILS_R5_URL, extension: [{
    url: "dosageDetails", extension: [
      { url: "renderedInstruction", valueString: "Take one tablet, two repeats." },
      ...extra,
      { url: "step", extension: [
        { url: "count", valueInteger: 2 },
        { url: "component", extension: [
          { url: "text", valueString: "Take one tablet, two repeats." },
          { url: "doseAndRate", extension: [{
            url: "doseQuantity", valueQuantity: { value: 1, unit: "tab" },
          }] },
        ] },
      ] },
    ],
  }] };
  return withDosageEditProvenance([{
    ...persist(rowDose), sequence: 1, text: "Take one tablet, two repeats.", modifierExtension: [marker],
  }], "Take one tablet, two repeats.");
}

describe("review round 21: persisted R5 ownership and retention", () => {
  it("writes free-text safety actions as strings and reads the historical code spelling", () => {
    const action = "Stop the dose.\nContact the prescriber.";
    const actions = retainedCourseProfile.differential.element.filter(item => item.id.endsWith(":ifExceeded.value[x]"));
    expect(actions).toHaveLength(4);
    for (const field of actions) expect(field.type).toEqual([{ code: "code" }, { code: "string" }]);
    const marker: FhirExtension = { url: DOSAGE_DETAILS_R5_URL,
      extension: encodeR5RetainedFields({ component: { safety: { ifExceeded: action } } }) };
    const safety = marker.extension![0].extension!.find(child => child.url === "safety")!;
    expect(safety.extension).toEqual([{ url: "ifExceeded", valueString: action }]);
    expect(decodeR5RetainedFields(persist(marker)).component?.safety?.ifExceeded).toBe(action);
    const single = encodeR6SourceMetadata("urn:example:single-step", { course: { ifExceeded: action } }, "safety");
    expect(single.extension![0].extension).toEqual([{ url: "ifExceeded", valueString: action }]);
    expect(decodeR6SourceMetadata(persist(single), "safety")).toEqual({ course: { ifExceeded: action } });
    safety.extension = [{ url: "ifExceeded", valueCode: "hold" }];
    expect(decodeR5RetainedFields(persist(marker)).component?.safety?.ifExceeded).toBe("hold");
  });

  it.each(["timing", "repeat"] as const)("checks newly submitted %s extensions against the saved baseline", owner => {
    let row = withDosageEditProvenance<FhirDosage>([{
      ...persist(rowDose), timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
    }], "Take one tablet daily.")[0];
    expect(dosageMatchesSavedProjection(row)).toBe(true);
    row = persist(row);
    const annotation = [{ url: "urn:example:clinical-timing", valueInteger: 2 }];
    if (owner === "timing") row.timing!.extension = annotation;
    else row.timing!.repeat!.extension = annotation;
    expect(dosageMatchesSavedProjection(row)).toBe(false);
  });

  it("clears the final R5 maximum from its lifted safety mirror after persistence", () => {
    const original: FhirR6DosageInstruction = { step: [{ component: [{ ...persist(rowDose),
      safety: { doseLimit: [{ scope: "administration", valueQuantity: { value: 2, unit: "tab" } }] },
    }] }] };
    const rows = persist(fromDosageDetails(original).dosages);
    expect(rows[0].safety?.doseLimit?.[0].valueQuantity?.value).toBe(2);
    delete rows[0].maxDosePerAdministration;
    const changed = toDosageDetails(rows);
    expect(componentSafety(changed)).toBeUndefined();
    const sources = changed.extension?.filter(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL);
    expect(sources?.length).toBeGreaterThan(0);
    const sourceExtensions: FhirR6Extension[] = [];
    for (const item of sources!) sourceExtensions.push(...(item.extension ?? []));
    const source = sourceExtensions.find(item =>
      decodeR5RetainedFields(item).component?.safety?.doseLimit?.[0].valueQuantity?.value === 2);
    expect(source).toBeDefined();
    expect(componentSafety(toDosageDetails(persist(toFhirR5Dosages(changed))))).toBeUndefined();
    expect(componentSafety(toDosageDetails(persist(fromDosageDetails(original).dosages))))
      .toEqual(original.step![0].component[0].safety);
  });

  it("keeps independent R6 safety after deleting the only projected quantity limit", () => {
    const original: FhirR6DosageInstruction = { step: [{ component: [{ ...persist(rowDose),
      safety: { ifExceeded: "Hold and call.", doseLimit: [
        { scope: "administration", valueQuantity: { value: 2, unit: "tab" } },
        { id: "independent", scope: "lifetime", valueInteger: 20 },
      ] },
    }] }] };
    const rows = persist(fromDosageDetails(original).dosages);
    delete rows[0].maxDosePerAdministration;
    const active = componentSafety(toDosageDetails(rows));
    expect(active).toEqual({ ifExceeded: "Hold and call.", doseLimit: [
      { id: "independent", scope: "lifetime", valueInteger: 20 },
    ] });
  });

  it("retires baseline wording after historical step or header edits and accepts explicit replacement wording", () => {
    const rows = persist(historicalRows());
    expect(toDosageDetails(rows).renderedInstruction).toBe("Take one tablet, two repeats.");
    const changed = toDosageDetails(rows, undefined, { renderedInstruction: "Take one tablet, two repeats.",
      step: [{ sequence: 1, count: 3 }] });
    expect(changed.step![0].count).toBe(3);
    expect(changed.renderedInstruction).toBeUndefined();
    expect(changed.extension?.some(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL)).toBe(true);
    expect(toDosageDetails(rows, undefined, { id: "revised-course" }).renderedInstruction).toBeUndefined();
    expect(toDosageDetails(rows, "Take one tablet, three repeats.", { step: [{ sequence: 1, count: 3 }] })
      .renderedInstruction).toBe("Take one tablet, three repeats.");
  });

  it("retains flat historical sources when active course annotations are replaced", () => {
    const previous = { url: "urn:example:older-source", valueString: "earlier independent annotation" };
    const history = { url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [previous] };
    const replacement = { url: "urn:example:current-note", valueString: "current annotation" };
    let current = toDosageDetails(persist(historicalRows([
      { url: "extension", extension: [history] },
    ])), undefined, { extension: [replacement] });
    expect(current.extension).toContainEqual(replacement);
    expect(current.extension).toContainEqual(history);
    const sourceCount = current.extension!.filter(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL).length;
    expect(sourceCount).toBe(2);
    for (let i = 0; i < 3; i++) {
      current = toDosageDetails(persist(toFhirR5Dosages(current)));
      expect(current.extension).toContainEqual(history);
      expect(current.extension!.filter(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL)).toHaveLength(sourceCount);
    }
  });

  it("emits valid expression-only R5 slots and restores their original associations", () => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: [
      { doseExpression: { language: "text/fhirpath", expression: "%weight * 2" } },
      { doseQuantity: { value: 5, unit: "mg" } },
      { rateExpression: { language: "text/fhirpath", expression: "%rate" } },
    ] }] }] };
    const rows = persist(toFhirR5Dosages(source));
    expect(rows[0].doseAndRate).toHaveLength(3);
    for (const index of [0, 2]) {
      const slot = rows[0].doseAndRate![index];
      expect(slot).not.toHaveProperty("doseExpression");
      expect(slot).not.toHaveProperty("rateExpression");
      expect(slot.doseQuantity).toBeUndefined();
      expect(slot.rateQuantity).toBeUndefined();
      expect(slot.extension?.[0].url).toBe(R5_EXPRESSION_SLOT_SOURCE_URL);
      expect(slot.extension?.[0].extension?.[0].valueExpression?.expression).toBe(index === 0 ? "%weight * 2" : "%rate");
    }
    const restored = toDosageDetails(rows);
    expect(restored.step![0].component[0].doseAndRate).toEqual(source.step![0].component[0].doseAndRate);
    expect(toDosageDetails(persist(toFhirR5Dosages(restored))).step![0].component[0].doseAndRate)
      .toEqual(source.step![0].component[0].doseAndRate);
    const scalar = fromR6Dosage(source.step![0].component[0], 1);
    expect(scalar.doseAndRate?.[0].extension?.[0].extension?.[0].valueExpression)
      .toEqual(source.step![0].component[0].doseAndRate![0].doseExpression);
    rows[0].doseAndRate![0].doseQuantity = { value: 7, unit: "mg" };
    const replaced = toDosageDetails(rows).step![0].component[0].doseAndRate![0];
    expect(replaced.doseQuantity).toEqual({ value: 7, unit: "mg" });
    expect(replaced.doseExpression).toBeUndefined();
  });

  it("keeps site wrapper metadata over repeated persisted R5 saves and respects a live concept clear", () => {
    const site = { id: "site-wrapper", extension: [{ url: "urn:example:site-note", valueString: "source note" }],
      concept: { text: "right eye" } };
    let source: FhirR6DosageInstruction = { step: [{ component: [{ ...persist(rowDose), site }] }] };
    for (let i = 0; i < 3; i++) {
      source = toDosageDetails(persist(toFhirR5Dosages(source)));
      expect(source.step![0].component[0].site).toEqual(site);
    }
    const rows = persist(toFhirR5Dosages(source));
    delete rows[0].site;
    const cleared = toDosageDetails(rows);
    expect(cleared.step![0].component[0].site?.concept).toBeUndefined();
    expect(toDosageDetails(persist(toFhirR5Dosages(cleared))).step![0].component[0].site?.concept).toBeUndefined();
  });

  it.each(["simple", "general"] as const)("removes stale active operator translations in %s quantities and retains their original coding", kind => {
    const originalCoding = { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000055", display: "Approximately",
      _display: { extension: [{ url: "http://hl7.org/fhir/StructureDefinition/translation", extension: [
        { url: "lang", valueCode: "th" }, { url: "content", valueString: "ประมาณ" },
      ] }] }, i18n: { th: "ประมาณ" } };
    const quantity: FhirR6Quantity = { value: 5, unit: "mg", comparator: "<", extension: [{
      url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL, valueCoding: originalCoding,
    }] };
    const write = kind === "simple" ? simpleQuantityForR5 : quantityForR5;
    const changed = write(quantity)!;
    const active = changed.extension!.find(item => item.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL)?.valueCoding;
    if (kind === "simple") {
      expect(active).toEqual({ system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000050", display: "less than" });
      expect(changed.extension).toContainEqual({
        url: "urn:ezmedicationinput:StructureDefinition:quantity-operator-source", valueCoding: originalCoding,
      });
    } else {
      expect(active).toBeUndefined();
      expect(changed.comparator).toBe("<");
      expect(changed.extension).toContainEqual({
        url: "urn:ezmedicationinput:StructureDefinition:quantity-operator-source", extension: quantity.extension,
      });
    }
    expect(getQuantityComparator(changed)).toBe("<");
    expect(write(persist(changed))!.extension).toEqual(changed.extension);
    expect(write({ ...quantity, comparator: "~" })!.extension?.[0].valueCoding).toEqual(originalCoding);
  });

  it("uses persisted live R5 maximum edits for scalar scheduling and retains explicit safety edits", () => {
    const initial: FhirDosage = { ...persist(rowDose),
      timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day } },
      maxDosePerPeriod: [{ numerator: { value: 2, unit: "tab" }, denominator: { value: 1, unit: "d" } }],
    };
    const row = persist(toEzDosages([initial])[0]);
    row.maxDosePerPeriod![0].numerator!.value = 1;
    expect(administrationFromR5(row).limits?.[0].amount?.value).toBe(1);
    const dates = nextDueDoses(row, { from: "2026-11-18T08:00:00Z", orderedAt: "2026-11-18T08:00:00Z",
      timeZone: "UTC", limit: 2 }).map(value => new Date(value).toISOString());
    expect(dates).toEqual(["2026-11-18T08:00:00.000Z", "2026-11-19T08:00:00.000Z"]);
    const explicit = persist(toEzDosages([initial])[0]);
    explicit.safety!.doseLimit![0].valueQuantity!.value = 3;
    expect(administrationFromR5(explicit).limits?.[0].amount?.value).toBe(3);
    const cleared = persist(toEzDosages([initial])[0]);
    delete cleared.maxDosePerPeriod;
    expect(administrationFromR5(cleared).limits).toBeUndefined();
    expect(administrationFromR5(cleared).safety).toBeUndefined();
  });

  it("migrates the actual previous-writer R5 course count without reinterpreting current step counts", () => {
    // Serialized origin/master output for a seven-day active/rest course,
    // copied as a wire fixture rather than produced by the current writer.
    const saved: FhirDosage[] = [{
      timing: { repeat: { frequency: 1, boundsDuration: { value: 7, unit: "days", system: "http://unitsofmeasure.org", code: "d" }, period: 1, periodUnit: FhirPeriodUnit.Day } },
      text: "Use 1 tablet once daily for 7 days.", sequence: 1,
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab", system: "http://standardterms.edqm.eu", code: "15054000" } }],
      modifierExtension: [{ url: DOSAGE_DETAILS_R5_URL, extension: [
        { url: "rowIndex", valueInteger: 0 }, { url: "sequence", valueInteger: 1 }, { url: "stepCount", valueInteger: 1 },
        { url: "step", extension: [{ url: "count", valueInteger: 3 }] },
        { url: "context", valueString: "72f2f03d1f8289c5" }, { url: "contextRequired", valueBoolean: true },
        { url: "course", extension: [{ url: "repeatCycle", valueQuantity: { value: 14, unit: "d", code: "d", system: "http://unitsofmeasure.org" } }] },
      ] }], extension: [{ url: "urn:ezmedicationinput:StructureDefinition:medication-rendered-instruction", extension: [
        { url: "instruction", valueString: "1 tablet daily for 7 days then stop for 7 days, repeat for 3 cycles" },
        { url: "row", extension: [{ url: "projectionFingerprint", valueString: "4346df4e5678f52b" }, { url: "textFingerprint", valueString: "dab22a241c7d0f4f" }] },
      ] }],
    }];
    const unrelated = { url: "urn:test:course-modifier", valueString: "retain policy" };
    const unrelatedEdit = toDosageDetails(persist(saved), undefined, { modifierExtension: [unrelated] });
    expect(getCourseCycleCount(unrelatedEdit)).toBe(3);
    expect(unrelatedEdit.modifierExtension).toContainEqual(unrelated);
    expect(unrelatedEdit.step![0].count).toBeUndefined();
    expect(getCourseCycleCount(toDosageDetails(persist(saved), undefined, {
      modifierExtension: [{ url: COURSE_CYCLE_COUNT_EXTENSION_URL, valueInteger: 4 }, unrelated],
    }))).toBe(4);
    // [] explicitly clears all legacy course modifiers. To clear only this
    // count, reopen the migrated public edit view and remove its visible entry.
    const clearedAll = toDosageDetails(persist(saved), undefined, { modifierExtension: [] });
    expect(getCourseCycleCount(clearedAll)).toBeUndefined();
    expect(clearedAll.step![0].count).toBeUndefined();
    expect(toDosageDetails(persist(toFhirR5Dosages(clearedAll))).step![0].count).toBeUndefined();
    const edit = persist(fromDosageDetails(unrelatedEdit));
    edit.course.modifierExtension = edit.course.modifierExtension!.filter(e => e.url !== COURSE_CYCLE_COUNT_EXTENSION_URL);
    const clear = toDosageDetails(edit.dosages, undefined, edit.course);
    expect(getCourseCycleCount(clear)).toBeUndefined();
    expect(clear.step![0].count).toBeUndefined();
    expect(clear.modifierExtension).toContainEqual(unrelated);
    const reopenedClear = toDosageDetails(persist(toFhirR5Dosages(clear)));
    expect(getCourseCycleCount(reopenedClear)).toBeUndefined();
    expect(reopenedClear.step![0].count).toBeUndefined();
    const migrated = toDosageDetails(persist(saved));
    expect(getCourseCycleCount(migrated)).toBe(3);
    expect(migrated.step![0].count).toBeUndefined();
    expect(migrated.extension).toContainEqual({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [saved[0].modifierExtension![0]] });
    const dates = nextDueDoses(migrated, { from: "2026-11-18T08:00:00Z", orderedAt: "2026-11-18T08:00:00Z", timeZone: "UTC", limit: 30 });
    // The historical frequency-only fixture uses the established 09:00
    // daily default; orderedAt at 08:00 is not an authored dosing clock.
    const expected: string[] = [];
    for (const start of ["2026-11-18", "2026-12-02", "2026-12-16"]) {
      expected.push(...Array.from({ length: 7 }, (_, day) =>
        new Date(Date.parse(start + "T09:00:00Z") + day * 86400000).toISOString().replace(".000Z", "+00:00")));
    }
    expect(dates).toEqual(expected);
    expect(getCourseCycleCount(toDosageDetails(persist(toFhirR5Dosages(migrated))))).toBe(3);
    const current: FhirR6DosageInstruction = { repeatCycle: { value: 14, unit: "d", code: "d" },
      step: [{ count: 2, component: [{ ...persist(rowDose), timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, boundsDuration: { value: 1, unit: "d", code: "d" } } } }] }] };
    expect(courseFromR6(current).cycleCount).toBeUndefined();
    for (const bounded of [false, true]) {
      const source = { ...current, ...(bounded ? { modifierExtension: [{ url: COURSE_CYCLE_COUNT_EXTENSION_URL, valueInteger: 3 }] } : {}) };
      const rows = persist(toFhirR5Dosages(source));
      expect(rows[0].modifierExtension?.find(item => item.url === DOSAGE_DETAILS_R5_URL)?.extension)
        .toContainEqual({ url: "countScope", valueCode: "step" });
      const restored = toDosageDetails(rows);
      expect(restored.step![0].count).toBe(2);
      expect(getCourseCycleCount(restored)).toBe(bounded ? 3 : undefined);
    }
  });
});

// END PRESERVED r521
}


// Retained boundary and strict-type suite from test/pr14-round21-boundaries.spec.ts.
{
  const generalQuantityForR5 = quantityForR5;
// BEGIN PRESERVED round39_boundaries
const tablet = () => ({ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] });
const persist = <T>(input: T): T => JSON.parse(JSON.stringify(input));
const boundary = { anchor: "treatment-start" as const, displacement: { value: 2, unit: "d" } };

describe("round 21 external boundary preservation", () => {
  it.each(["course", "step", "component"] as const)("preserves extension-only integer limits at %s scope", scope => {
    const safety: FhirR6DosageSafety = { doseLimit: [{ scope: "lifetime", _valueInteger: {
      id: "unknown-ceiling", extension: [{ url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown" }],
    } }] };
    const input: FhirR6DosageInstruction = { step: [{ component: [tablet()] }] };
    if (scope === "course") input.safety = safety;
    else if (scope === "step") { input.step![0].safety = safety; input.step!.push({ component: [tablet()] }); }
    else input.step![0].component[0].safety = safety;
    const read = (wire: FhirR6DosageInstruction) => scope === "course" ? wire.safety :
      scope === "step" ? wire.step![0].safety : wire.step![0].component[0].safety;
    const expectedSafety = persist(safety), original = persist(input);
    const imported = fromFhir(input);
    expect(input).toEqual(original);
    const rows = persist(toFhirR5Dosages(input)), originalRows = persist(rows);
    expect(input).toEqual(original);
    const reopened = toDosageDetails(rows);
    expect(rows).toEqual(originalRows);
    for (const wire of [imported.fhirNext, reopened]) {
      expect(read(wire)).toEqual(expectedSafety);
      expect(read(wire)!.doseLimit![0].valueInteger).toBeUndefined();
      expect(wire.step![0].component[0].doseAndRate![0].doseQuantity!.value).toBe(1);
    }
  });

  it.each(["reference", "definition"] as const)("keeps a %s event code and context path together", kind => {
    const start = {
      ...(kind === "reference" ? { contextReference: { reference: "Observation/trigger" } } :
        { contextDefinition: "https://example.org/PlanDefinition/trigger" }),
      contextCode: { coding: [{ system: "urn:test:events", code: "released" }] },
      contextPath: "effective.ofType(dateTime)", offsetDuration: { value: 2, unit: "h", code: "h" },
    };
    const source: FhirR6DosageInstruction = { step: [{ start, component: [tablet()] }] };
    expect(fromFhir(source).fhirNext.step![0].start).toEqual(start);
    const restored = toDosageDetails(persist(toFhirR5Dosages(source)));
    expect(restored.step![0].start).toEqual(start);
    expect(() => nextDueDoses(restored, { from: "2026-01-01T00:00:00Z", orderedAt: "2026-01-01T00:00:00Z", timeZone: "UTC", limit: 2 })).toThrow(/Unsupported.*RelativeTime/);
  });

  it("uses current cyclic dose values in normalized previews while retaining authored wording", () => {
    const source: FhirR6DosageInstruction = { renderedInstruction: "Take 1 tablet daily", repeatCycle: { value: 7, unit: "d" },
      step: [{ component: [{ ...tablet(), timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } } }] }] };
    source.step![0].component[0].doseAndRate![0].doseQuantity!.value = 2;
    expect(formatSig(source, "long", { locale: "en", realizationMode: "normalized" })).toContain("2 tablets");
    const native = importCanonicalCourse(source);
    expect(formatCanonicalCourse(native, "long", { locale: "en", realizationMode: "normalized" })).toContain("2 tablets");
    expect(courseToR6(native).renderedInstruction).toBe("Take 1 tablet daily");
  });

  it.each(["~", "<", ">=", "ad"] as const)("reopens retained drafts with an unchanged %s SimpleQuantity wire projection", comparator => {
    const native: CanonicalCourse = { kind: "course", stages: [
      { provenance: { id: "draft" }, end: boundary, administrations: [] },
      { provenance: { id: "active" }, administrations: [{ kind: "administration", amounts: [{ quantity: { value: 2, unit: "tab", comparator } }] }] },
    ] };
    const wire = courseToR6(native);
    expect(wire.step).toHaveLength(1);
    const reopened = importCanonicalCourse(persist(wire));
    expect(reopened.stages).toHaveLength(2);
    expect(reopened.stages[0].provenance?.id).toBe("draft");
    expect(reopened.stages[1].administrations[0].amounts![0].quantity!.comparator).toBe(comparator);
    expect(getQuantityComparator(wire.step![0].component[0].doseAndRate![0].doseQuantity)).toBe(comparator);
    expect(courseToR6(reopened)).toEqual(wire);
  });

  it("keeps a dose-edited pause, then retires it after a live boundary edit across repeated saves", () => {
    const native: CanonicalCourse = { kind: "course", stages: [
      { provenance: { id: "unmatched-draft-note" }, end: boundary, administrations: [] },
      { administrations: [{ kind: "administration", amounts: [{ quantity: { value: 1, unit: "tab" } }] }] },
    ] };
    let wire = persist(courseToR6(native));
    wire.step![0].component[0].doseAndRate![0].doseQuantity!.value = 2;
    wire = courseToR6(importCanonicalCourse(wire));
    const doseEdited = importCanonicalCourse(wire);
    expect(doseEdited.stages).toHaveLength(2);
    expect(doseEdited.stages[0].end).toMatchObject(boundary);
    expect(doseEdited.stages[1].administrations[0].amounts![0].quantity!.value).toBe(2);
    expect(wire.step![0].start!.offsetDuration!.value).toBe(2);
    wire = persist(wire);
    wire.step![0].start!.offsetDuration!.value = 3;
    wire = courseToR6(importCanonicalCourse(wire));
    expect(wire.step![0].start!.offsetDuration!.value).toBe(3);
    expect(wire.extension?.some(e => e.url === R6_DRAFT_STEPS_SOURCE_URL)).not.toBe(true);
    expect(JSON.stringify(wire)).toContain("unmatched-draft-note");
    for (let round = 0; round < 3; round++) {
      const restored = fromDosageDetails(persist(wire));
      expect(restored.course.step).toHaveLength(1);
      const saved = toDosageDetails(persist(toFhirR5Dosages(wire)));
      expect(JSON.stringify(saved)).toContain("unmatched-draft-note");
      expect(importCanonicalCourse(saved).stages).toHaveLength(1);
      expect(saved.step![0].component[0].doseAndRate![0].doseQuantity!.value).toBe(2);
      expect(saved.step![0].start!.offsetDuration!.value).toBe(3);
      if (round > 0) expect(saved).toEqual(wire);
      wire = saved;
    }
  });

  it("preserves typed Ratio conditions and opaque annotations", () => {
    const condition: FhirR6DosageCondition = { code: { text: "Ratio threshold" },
      valueRatio: { numerator: { value: 2, unit: "mg" }, denominator: { value: 1, unit: "mL" } },
      extension: [{ url: "urn:test:condition", valueString: "source annotation" }],
    };
    const source: FhirR6DosageInstruction = { step: [{ component: [{ ...tablet(), condition: [condition] }] }] };
    expect(toDosageDetails(persist(toFhirR5Dosages(source))).step![0].component[0].condition).toEqual([condition]);
  });

  it("keeps R5 maximum Ratio metadata when numerical values are edited", () => {
    const ratio = { id: "maximum-ratio", extension: [{ url: "urn:test:ratio-note", valueString: "retain" }],
      numerator: { value: 4, unit: "tab" }, denominator: { value: 1, unit: "d" } };
    const source: FhirDosage = { ...tablet(), maxDosePerPeriod: [ratio] };
    const edited = persist(source);
    edited.maxDosePerPeriod![0].numerator!.value = 3;
    const native = importCanonicalCourse(edited);
    const r5 = courseToR5(native);
    expect(r5[0].maxDosePerPeriod?.[0]).toEqual({ ...ratio, numerator: { value: 3, unit: "tab" } });
    const r6 = courseToR6(native);
    expect(r6.step![0].component[0].safety!.doseLimit![0]).not.toHaveProperty("numerator");
    expect(toFhirR5Dosages(persist(r6))[0].maxDosePerPeriod?.[0]).toEqual(r5[0].maxDosePerPeriod![0]);
  });

  it("keeps Ratio metadata through the editable R5 safety view and a persisted edit", () => {
    const ratio = { id: "editable-maximum-ratio", extension: [{ url: "urn:test:ratio-note", valueString: "retain" }],
      numerator: { value: 4, unit: "tab" }, denominator: { value: 1, unit: "d" } };
    const editable = persist(toEzDosages([{ ...tablet(), maxDosePerPeriod: [ratio] }]));
    editable[0].maxDosePerPeriod![0].numerator!.value = 3;
    const saved = toFhirR5Dosages(editable)[0].maxDosePerPeriod![0];
    expect(saved).toEqual({ ...ratio, numerator: { value: 3, unit: "tab" } });
  });

  it("retains source-marker annotations and duplicate markers without history growth", () => {
    const native: CanonicalCourse = { kind: "course", stages: [
      { end: boundary, administrations: [] },
      { administrations: [{ kind: "administration", amounts: [{ quantity: { value: 1, unit: "tab" } }] }] },
    ] };
    let wire = courseToR6(native);
    const marker = wire.extension!.find(e => e.url === R6_DRAFT_STEPS_SOURCE_URL)!;
    marker.id = "source-marker-id";
    marker.extension!.push({ url: "urn:test:future-source-child", valueString: "retain-future-source" });
    const duplicate = { ...persist(marker), id: "second-source-marker" };
    wire.extension!.push(duplicate);
    wire = courseToR6(importCanonicalCourse(persist(wire)));
    expect(importCanonicalCourse(wire).stages).toHaveLength(2);
    expect(wire.extension!.find(e => e.url === R6_DRAFT_STEPS_SOURCE_URL)!.id).toBe("source-marker-id");
    expect(JSON.stringify(wire)).toContain("retain-future-source");
    expect(JSON.stringify(wire)).toContain("second-source-marker");
    expect(courseToR6(importCanonicalCourse(persist(wire)))).toEqual(wire);
    wire = persist(wire); // Edit the persisted external value, not a borrowed projection.
    wire.step![0].component[0].doseAndRate![0].doseQuantity!.value = 2;
    wire = courseToR6(importCanonicalCourse(persist(wire)));
    const doseEdited = importCanonicalCourse(wire);
    expect(doseEdited.stages).toHaveLength(2);
    expect(doseEdited.stages[0].end).toMatchObject(boundary);
    expect(doseEdited.stages[1].administrations[0].amounts![0].quantity!.value).toBe(2);
    expect(courseToR6(importCanonicalCourse(persist(wire)))).toEqual(wire);
    wire = persist(wire);
    wire.step![0].start!.offsetDuration!.value = 3;
    wire = courseToR6(importCanonicalCourse(wire));
    expect(importCanonicalCourse(wire).stages).toHaveLength(1);
    expect(wire.step![0].start!.offsetDuration!.value).toBe(3);
    expect(JSON.stringify(wire)).toContain("source-marker-id");
    expect(JSON.stringify(wire)).toContain("second-source-marker");
    expect(JSON.stringify(wire)).toContain("retain-future-source");
    expect(courseToR6(importCanonicalCourse(persist(wire)))).toEqual(wire);
  });

  it("keeps conflicting qualified ratio source portable through strict R5", () => {
    const input = [{ doseAndRate: [{
      doseQuantity: { value: 3, unit: "mg" },
      rateRatio: { numerator: generalQuantityForR5({ value: 10, unit: "mL", comparator: "~" })!,
        denominator: { value: 1, unit: "h" } },
      rateExpression: { language: "text/fhirpath", expression: "%patient.weight" },
    }] }];
    const first = toDosageDetails(input);
    for (const amount of [first.step![0].component[0].doseAndRate![0],
      toFhirR5Dosages(persist(first))[0].doseAndRate![0]]) {
      const saved = amount.extension!.find(e => e.url === "urn:ezmedicationinput:r6-unresolved-rate-source")!
        .extension!.find(e => e.url === "rateRatio")!.valueRatio!;
      expect(saved.numerator!.comparator).toBeUndefined();
      expect(getQuantityComparator(saved.numerator)).toBe("~");
      expect(amount.doseQuantity!.value).toBe(3);
      expect(amount.rateRatio).toBeUndefined();
      expect(amount).not.toHaveProperty("rateExpression");
    }
  });

  it.each(["dose", "rate"] as const)("retains conflicting external %s edits without choosing an active value", kind => {
    const expression = { language: "text/fhirpath", expression: "%patient.weight * 3" };
    const amount = kind === "dose" ? {
      doseQuantity: { value: 3, unit: "mg" }, doseExpression: expression, rateQuantity: { value: 5, unit: "mL/h" },
    } : { doseQuantity: { value: 3, unit: "mg" }, rateQuantity: { value: 5, unit: "mL/h" }, rateExpression: expression };
    const input = [{ doseAndRate: [amount] }];
    const before = persist(input);
    const saved = toDosageDetails(input);
    const current = saved.step![0].component[0].doseAndRate![0];
    expect(kind === "dose" ? current.doseQuantity : current.rateQuantity).toBeUndefined();
    expect(kind === "dose" ? current.doseExpression : current.rateExpression).toBeUndefined();
    expect(kind === "dose" ? current.rateQuantity!.value : current.doseQuantity!.value).toBe(kind === "dose" ? 5 : 3);
    const source = current.extension!.find(e => e.url === `urn:ezmedicationinput:r6-unresolved-${kind}-source`)!;
    expect(source.extension).toHaveLength(2);
    expect(source.extension!.find(child => child.url === kind + "Quantity")!.valueQuantity)
      .toEqual(kind === "dose" ? { value: 3, unit: "mg" } : { value: 5, unit: "mL/h" });
    expect(source.extension!.find(child => child.url === kind + "Expression")!.valueExpression).toEqual(expression);
    expect(() => fromFhir(saved)).not.toThrow();
    expect(toDosageDetails(persist(toFhirR5Dosages(saved))).step![0].component[0].doseAndRate![0]).toEqual(current);
    expect(input).toEqual(before);
  });
});


const dailyTablet = (value = 1) => ({
  doseAndRate: [{ doseQuantity: { value, unit: "tab" } }],
  timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
});

describe("round 23 public boundary corrections", () => {
  it("retains fractional offsets and zero minimum frequency only in their typed wire extensions", () => {
    const offset = 0.5;
    const extensions = [
      { url: TIMING_OFFSET_EXACT_EXTENSION_URL, valueDecimal: offset },
      { url: TIMING_FREQUENCY_MIN_EXTENSION_URL, valueInteger: 0 },
    ];
    const input: FhirR6DosageInstruction = { step: [{ component: [{ ...dailyTablet(), timing: { repeat: {
      frequencyMax: 2, period: 1, periodUnit: FhirPeriodUnit.Day, extension: extensions,
    } } }] }] };
    const before = persist(input);
    const native = importCanonicalCourse(input);
    expect(native.stages[0].administrations[0].schedule?.recurrence).toMatchObject({ frequency: 0, offset });
    for (const timing of [courseToR5(native)[0].timing, courseToR6(native).step![0].component[0].timing]) {
      expect(timing?.repeat?.offset).toBeUndefined();
      expect(timing?.repeat?.frequency).toBeUndefined();
      expect(timing?.repeat?.extension?.filter(e => e.url === TIMING_OFFSET_EXACT_EXTENSION_URL))
        .toEqual([extensions[0]]);
      expect(timing?.repeat?.extension?.filter(e => e.url === TIMING_FREQUENCY_MIN_EXTENSION_URL))
        .toEqual([extensions[1]]);
    }
    expect(input).toEqual(before);
  });

  it("retains ordinary unsigned integer offsets and positive frequencies in standard wire fields", () => {
    const input: FhirR6DosageInstruction = { step: [{ component: [{ ...dailyTablet(), timing: { repeat: {
      frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, when: [EventTiming["Before Meal"]], offset: 30,
    } } }] }] };
    const native = importCanonicalCourse(input);
    for (const timing of [courseToR5(native)[0].timing, courseToR6(native).step![0].component[0].timing])
      expect(timing?.repeat).toMatchObject({ frequency: 1, when: [EventTiming["Before Meal"]], offset: 30 });
  });

  it("keeps phase-origin Element metadata through edits and repeated version crossings", () => {
    const origin = { id: "origin-element", url: PARALLEL_COMPONENT_PHASE_ORIGIN_URL,
      valueQuantity: { id: "origin-quantity", value: 2, unit: "d", extension: [{ url: "urn:origin-note", valueString: "authored" }] } };
    const sibling = { id: "independent", url: "urn:other-modifier", valueString: "keep" };
    const input: FhirR6DosageInstruction = { step: [{ component: [{ ...dailyTablet(), modifierExtension: [origin, sibling] }] }] };
    const before = persist(input);
    const native = importCanonicalCourse(input);
    expect(courseToR6(native).step![0].component[0].modifierExtension).toEqual([origin, sibling]);
    const edited = persist(input);
    edited.step![0].component[0].modifierExtension![0].valueQuantity!.value = 3;
    const expected = edited.step![0].component[0].modifierExtension;
    let wire = edited;
    for (let pass = 0; pass < 3; pass++) {
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      expect(wire.step![0].component[0].modifierExtension).toEqual(expected);
    }
    expect(input).toEqual(before);
  });

  it.each([undefined, {}, { locale: "en" }, { locale: "th" }, { realizationMode: "roundtrip" }] as Array<FormatOptions | undefined>)(
    "previews edited R6 fields while keeping original wording (%j)", options => {
      const input: FhirR6DosageInstruction = { renderedInstruction: "Take 1 tablet daily", step: [{ component: [{
        ...dailyTablet(2), text: "Take 1 tablet daily",
      }] }] };
      const before = persist(input);
      for (const style of ["short", "long"] as const) {
        const text = formatSig(input, style, options);
        expect(text.match(/(?:^|[^\p{L}\p{N}.,+\-])2\s*(?:tablets?|tabs?|เม็ด)(?![\p{L}\p{N}])/gu)).toHaveLength(1);
        expect(text.split(/; (?:original directions|ข้อความเดิม):/u)[0])
          .not.toMatch(/(?:^|[^0-9])1\s*(?:tab|tablet|เม็ด)/u);
        expect(text).toContain("Take 1 tablet daily");
      }
      const imported = fromFhir(input, options);
      for (const text of [imported.shortText, imported.longText, imported.items[0].shortText, imported.items[0].longText]) {
        expect(text.match(/(?:^|[^\p{L}\p{N}.,+\-])2\s*(?:tablets?|tabs?|เม็ด)(?![\p{L}\p{N}])/gu)).toHaveLength(1);
        expect(text.split(/; (?:original directions|ข้อความเดิม):/u)[0])
          .not.toMatch(/(?:^|[^0-9])1\s*(?:tab|tablet|เม็ด)/u);
        expect(text).toContain("Take 1 tablet daily");
      }
      expect(imported.fhirNext.renderedInstruction).toBe("Take 1 tablet daily");
      expect(courseToR6(importCanonicalCourse(input)).renderedInstruction).toBe("Take 1 tablet daily");
      expect(input).toEqual(before);
    }
  );

  it("uses live rich R6 component values while retaining their authored text", () => {
    const input: FhirR6DosageInstruction = { renderedInstruction: "Infuse 1 mg at 4 mL/h", step: [{ component: [{
      text: "Infuse 1 mg at 4 mL/h", doseAndRate: [{ doseQuantity: { value: 2, unit: "mg" },
        rateQuantity: { value: 5, unit: "mL/h" } }],
    }] }] };
    const imported = fromFhir(input);
    for (const text of [formatSig(input, "short"), formatSig(input, "long"),
      imported.shortText, imported.longText, imported.items[0].shortText, imported.items[0].longText]) {
      expect(text).toMatch(/(?:^|[^0-9.])2\s*mg\b/u);
      expect(text).toMatch(/(?:^|[^0-9.])5\s*mL\/h\b/u);
      const current = text.split("; original directions:")[0];
      expect(current).not.toMatch(/(?:^|[^0-9.])1\s*mg\b/u);
      expect(current).not.toMatch(/(?:^|[^0-9.])4\s*mL\/h\b/u);
      expect(text).toContain("; original directions: Infuse 1 mg at 4 mL/h");
    }
    expect(imported.fhirNext.step![0].component[0].text).toBe("Infuse 1 mg at 4 mL/h");
  });

  it("still displays text-only R6 instructions without inventing an administration", () => {
    const input = { renderedInstruction: "Use as directed by the clinic" };
    expect(formatSig(input, "long")).toBe(input.renderedInstruction);
    expect(fromFhir(input).longText).toBe(input.renderedInstruction);
    expect(importCanonicalCourse(input).stages).toEqual([]);
  });

  it.each([undefined, "Apply as instructed."])("preserves text-only R6 components with header %s", header => {
    const input: FhirR6DosageInstruction = { ...(header ? { renderedInstruction: header } : {}),
      step: [{ component: [{ text: "Apply as instructed.", timing: { id: "timing-source-only" } }] }] };
    for (const realizationMode of [undefined, "roundtrip", "normalized"] as const) {
      expect(formatSig(input, "long", { realizationMode })).toBe("Apply as instructed.");
      const imported = fromFhir(input, { realizationMode });
      expect(imported.longText).toBe("Apply as instructed.");
      expect(imported.items[0].longText).toBe("Apply as instructed.");
      expect(imported.fhirNext).toEqual(input);
    }
  });

  it("honors a caller separator between generated R5 course stages", () => {
    const rows = [{ ...dailyTablet(1), sequence: 1 }, { ...dailyTablet(2), sequence: 2 }];
    for (const locale of ["en", "th"]) {
      const text = formatSigBatch(rows, "long", { locale, separator: "\n" });
      const stages = text.split("\n");
      expect(stages).toHaveLength(2);
      expect(stages[0]).toMatch(/1\s*(?:tab|tablet|เม็ด)/u);
      expect(stages[1]).toMatch(/2\s*(?:tab|tablet|เม็ด)/u);
    }
  });

  it.each([false, true])("does not begin a rate-range preview with a separator (dose=%s)", withDose => {
    const row: FhirDosage = { doseAndRate: [{
      ...(withDose ? { doseQuantity: { value: 2, unit: "mg" } } : {}),
      rateRange: { low: { value: 5, unit: "mL/h" }, high: { value: 10, unit: "mL/h" } },
    }] };
    const text = formatSig(row, "short");
    expect(text).not.toMatch(/^\s*[;,]/u);
    expect(text).toMatch(/(?<![\d.])5–10 mL\/h(?![\w/])/u);
    if (withDose) expect(text).toMatch(/2 mg; /u);
  });


});

const integerWithMetadata: FhirR6DoseLimit = { scope: "lifetime", valueInteger: 2, _valueInteger: { id: "count" } };
const primitiveOnly: FhirR6DoseLimit = { scope: "lifetime", _valueInteger: { extension: [{ url: "urn:unknown" }] } };
// @ts-expect-error Integer primitive metadata cannot accompany a different value[x] choice.
const invalidQuantityChoice: FhirR6DoseLimit = { scope: "lifetime", valueQuantity: { value: 2 }, _valueInteger: { id: "wrong-choice" } };
// @ts-expect-error Integer primitive metadata cannot accompany an expression choice.
const invalidExpressionChoice: FhirR6DoseLimit = { scope: "lifetime", valueExpression: { expression: "weight * 2" }, _valueInteger: { id: "wrong-choice" } };
it("keeps integer values and extension-only integer metadata valid", () => {
  expect(integerWithMetadata.valueInteger).toBe(2);
  expect(primitiveOnly.valueInteger).toBeUndefined();
  void invalidQuantityChoice; void invalidExpressionChoice;
});


// Earlier external-boundary regressions share this maintained suite.
// Keep their fixture helpers local while retaining every original oracle.
{
const treatment = (days: number) => ({
  contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] },
  offsetDuration: { value: days, unit: "d", code: "d", system: "http://unitsofmeasure.org" },
});
const tablet = () => ({
  doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
  timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] } },
});

describe("strict R6 projection preserves current editable facts", () => {

  it("exports R5 metadata-only stages as source while preserving the next start", () => {
    const rows = [{ ...tablet(), sequence: 2 }];
    const metadata: EzCourseMetadata = { step: [
      { sequence: 1, id: "inactive-stage", end: treatment(2) }, { sequence: 2, id: "active-stage" },
    ] };
    const wire = toDosageDetails(rows, undefined, metadata);
    expect(wire.step).toHaveLength(1);
    expect(wire.step![0].start).toEqual(treatment(2));
    expect(wire.extension?.some(e => e.url === R6_DRAFT_STEPS_SOURCE_URL)).toBe(true);
    expect(() => fromFhir(wire)).not.toThrow();
    const reopened = fromDosageDetails(JSON.parse(JSON.stringify(wire)));
    expect(reopened.course.step).toHaveLength(2);
    expect(reopened.course.step![1].start).toBeUndefined();
    reopened.course.step![0].end = treatment(5);
    expect(toDosageDetails(reopened.dosages, undefined, reopened.course).step![0].start).toEqual(treatment(5));
    reopened.course.step!.shift();
    const removed = toDosageDetails(reopened.dosages, undefined, reopened.course);
    expect(removed.extension?.some(e => e.url === R6_DRAFT_STEPS_SOURCE_URL)).not.toBe(true);
    expect(importCanonicalCourse(removed).stages).toHaveLength(1);
  });

  it("preserves both external course and sole-step safety without invalid R6 step safety", () => {
    const metadata: EzCourseMetadata = {
      safety: { id: "course-policy", ifExceeded: "Call clinic",
        doseLimit: [{ scope: "period", valueQuantity: { value: 8, unit: "tab" }, period: { value: 1, unit: "d" } }] },
      step: [{ sequence: 1, safety: { id: "step-policy", ifExceeded: "Hold next dose",
        extension: [{ url: "urn:test:note", valueString: "retain" }],
        doseLimit: [{ scope: "administration", valueQuantity: { value: 2, unit: "tab" } }] } }],
    };
    const wire = toDosageDetails([{ ...tablet(), sequence: 1 }], undefined, metadata);
    expect(wire.step![0].safety).toBeUndefined();
    expect(wire.safety?.doseLimit?.map(limit => limit.valueQuantity?.value)).toEqual([8, 2]);
    expect(wire.safety?.ifExceeded).toBe("Call clinic\nHold next dose");
    const activeScope = wire.safety?.modifierExtension?.find(item => item.url === R6_SCOPED_SAFETY_MODIFIER_URL);
    expect(activeScope).toBeDefined();
    expect(decodeR6SourceMetadata(activeScope!, "safety")).toEqual({
      course: metadata.safety, step: metadata.step![0].safety,
    });
    expect(() => fromFhir(wire)).not.toThrow();
    const reopened = fromDosageDetails(JSON.parse(JSON.stringify(wire)));
    expect(reopened.course.safety?.ifExceeded).toBe("Call clinic");
    expect(reopened.course.step![0].safety?.id).toBe("step-policy");
    expect(toDosageDetails(reopened.dosages, undefined, reopened.course)).toEqual(wire);
    const changedWire = JSON.parse(JSON.stringify(wire));
    changedWire.safety = { ifExceeded: "New policy" };
    const changed = fromDosageDetails(changedWire);
    expect(changed.course.safety?.ifExceeded).toBe("New policy");
    expect(changed.course.step?.[0].safety).toBeUndefined();
  });

  it.each(["reference", "definition"] as const)("preserves a path owned by an external %s", kind => {
    const start = kind === "reference"
      ? { contextReference: { reference: "Observation/1" }, contextPath: "effective.ofType(dateTime)" }
      : { contextDefinition: "http://example.org/PlanDefinition/a", contextPath: "action.first()" };
    const wire: FhirR6DosageInstruction = { step: [{ start, component: [tablet()] }] };
    expect(fromFhir(wire).fhirNext.step![0].start).toEqual(start);
    expect(toDosageDetails(toFhirR5Dosages(wire)).step![0].start).toEqual(start);
  });

  it("imports text-only R6 through dedicated and generic entry points", () => {
    const source = { renderedInstruction: "Use as directed" };
    const native = importCanonicalCourse(source);
    expect(native.stages).toEqual([]);
    expect(native.instruction).toBe("Use as directed");
    expect(formatSig(source, "long")).toBe("Use as directed");
    expect(fromFhir(source).fhirNext.renderedInstruction).toBe("Use as directed");
    const strict = toFhirR5Dosages(source);
    expect(toDosageDetails(strict).renderedInstruction).toBe("Use as directed");
    expect(toDosageDetails(strict).step).toBeUndefined();
    expect(importCanonicalCourse({ text: "ordinary R5" }).stages[0].administrations[0].text).toBe("ordinary R5");
  });

  it("retains an entirely empty draft without fabricating an active component", () => {
    const native: CanonicalCourse = { kind: "course", stages: [{ administrations: [], end: {
      anchor: "treatment-start", displacement: { value: 3, unit: "d" },
    } }] };
    const wire = courseToR6(native);
    expect(wire.step).toBeUndefined();
    expect(() => fromFhir(wire)).not.toThrow();
    expect(importCanonicalCourse(wire).stages[0].end?.displacement?.value).toBe(3);
  });

  it("retains condition wording when an unrelated R5 safety delta exists", () => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      ...tablet(), condition: [{ code: { text: "Only if tolerated" } }],
      safety: { doseLimit: [{ scope: "administration", valueQuantity: { value: 4, unit: "tab" } }] },
    }] }] };
    const projected = fromDosageDetails(source);
    projected.dosages[0].maxDosePerAdministration = { value: 3, unit: "tab" };
    const changed = toDosageDetails(projected.dosages, undefined, projected.course).step![0].component[0];
    expect(changed.safety?.doseLimit?.[0].valueQuantity?.value).toBe(3);
    expect(changed.condition).toEqual(source.step![0].component[0].condition);
  });

  it.each(["~", "<=", ">="] as const)("encodes %s only in permitted scalar/range/ratio wire slots", comparator => {
    const native: CanonicalCourse = { kind: "course", stages: [{ administrations: [{
      kind: "administration", amounts: [
        { quantity: { value: 2, unit: "tab", comparator } },
        { rate: { value: 100, unit: "mL/h", comparator } },
        { range: { low: { value: 1, unit: "tab", comparator }, high: { value: 2, unit: "tab" } } },
        { rateRange: { high: { value: 100, unit: "mL/h", comparator } } },
        { rateRatio: { numerator: { value: 500, unit: "mL", comparator }, denominator: { value: 2, unit: "h", comparator } } },
      ],
    }] }] };
    const wire = courseToR6(native), amounts = wire.step![0].component[0].doseAndRate!;
    const simple = [amounts[0].doseQuantity, amounts[1].rateQuantity, amounts[2].doseRange!.low,
      amounts[3].rateRange!.high, amounts[4].rateRatio!.denominator];
    const expected = [[2, "tab"], [100, "mL/h"], [1, "tab"], [100, "mL/h"], [2, "h"]] as const;
    simple.forEach((q, index) => {
      expect(q).toMatchObject({ value: expected[index][0], unit: expected[index][1] });
      expect(q).not.toHaveProperty("comparator");
      expect(getQuantityComparator(q)).toBe(comparator);
    });
    expect(amounts[2].doseRange!.high).toMatchObject({ value: 2, unit: "tab" });
    expect(getQuantityComparator(amounts[2].doseRange!.high)).toBeUndefined();
    expect(amounts[4].rateRatio!.numerator).toMatchObject({ value: 500, unit: "mL", comparator });
    const restored = importCanonicalCourse(wire).stages[0].administrations[0].amounts!;
    expect(restored[0].quantity?.comparator).toBe(comparator);
    expect(restored[4].rateRatio?.denominator?.comparator).toBe(comparator);
  });
});

describe("provider registration and explicit cloning preserve owned data", () => {
  it("keeps detector configuration used through this on the registered snapshot", () => {
    const detector = { locale: "configuration-test", priority: 300,
      marker: /^__configuration_works__$/, test(text: string) { return this.marker.test(text); } };
    registerMedicationLocaleDetector(detector);
    detector.marker = /^__configuration_changed__$/;
    expect(inferMedicationLocale("__configuration_works__")).toBe("configuration");
    expect(inferMedicationLocale("__configuration_changed__", "en")).toBe("en");
  });

  it("keeps distinct registered segmenter slots when a descriptor is reused", () => {
    const provider = { locale: "test-first", script: /[\uE100]/u, segment: (input: string) => [{ segment: input, index: 0 }] };
    registerMedicationSurfaceSegmenter(provider);
    provider.locale = "test-second";
    provider.script = /[\uE101]/u;
    registerMedicationSurfaceSegmenter(provider);
    const entries = listMedicationSurfaceSegmenters();
    expect(entries.find(e => e.locale === "test-first")?.script.source).toBe("[\\uE100]");
    expect(entries.find(e => e.locale === "test-second")?.script.source).toBe("[\\uE101]");
  });

  it("keeps a date resolver's registered year interpretation", () => {
    const resolver = { id: "test-owned-calendar", calendarYearFromIsoYear: (year: number) => year + 1000,
      resolveYear: (year: number, digits: number) => digits === 4 && year >= 3000
        ? { isoYear: year - 1000, calendarYear: year, inferredYear: false } : undefined };
    registerMedicationDateResolver(resolver);
    resolver.resolveYear = (year, digits) => digits === 4 && year >= 3000
      ? { isoYear: year - 2000, calendarYear: year, inferredYear: false } : undefined;
    const parsed = parseSig("take 1 tab on 28/9/3026", {
      datePolicy: { calendars: ["test-owned-calendar"], referenceDate: "2026-11-18" },
    });
    expect(parsed.fhirNext.step![0].component[0].timing?.event).toEqual(["2026-09-28"]);
  });

  it("keeps the terminology version in the explicitly requested spatial clone", () => {
    const source = { relationText: "around", relationCoding: {
      system: "http://snomed.info/sct", version: "20261101", code: "66459002" },
      targetText: "eye" };
    const cloned = cloneBodySiteSpatialRelation(source)!;
    expect(cloned.relationCoding?.version).toBe("20261101");
    expect(cloned.relationCoding).not.toBe(source.relationCoding);
  });
});
}

describe("round 25 live rate and wire boundary regressions", () => {
  it.each([false, true])("uses a newly submitted rate-only R5 amount (original persisted=%s)", persisted => {
    const source = "Infuse at 5 mL/h";
    const fresh = parseSig(source).fhir[0];
    let row = persisted ? persist(fresh) : fresh;
    expect(formatSig(row, "long", { locale: "en", realizationMode: "roundtrip" })).toBe(source);
    expect(formatSig(row, "long", { locale: "en" })).toContain("Rate: 5 mL/h");
    row = persist(row);
    row.doseAndRate![0].rateQuantity!.value = 10;
    for (const text of [formatSig(row, "long", { locale: "en" }),
      formatSig(row, "long", { locale: "en", realizationMode: "roundtrip" }),
      fromFhirDosage(row, { locale: "en" }).longText]) {
      expect(text).toContain("Rate: 10 mL/h");
      expect(text).not.toContain("5 mL/h");
    }
    expect(row.text).toBe(source);
    expect(toDosageDetails([row]).step![0].component[0].doseAndRate![0].rateQuantity)
      .toMatchObject({ value: 10, unit: "mL/h" });
  });

  it.each([false, true])("uses an independently submitted R5 rate ratio (original persisted=%s)", persisted => {
    const source = "Infuse 120 mL over 2 hours";
    const fresh = parseSig(source).fhir[0];
    let row = persisted ? persist(fresh) : fresh;
    expect(formatSig(row, "long", { locale: "en", realizationMode: "roundtrip" })).toBe(source);
    expect(formatSig(row, "long", { locale: "en" })).toContain("Rate: 120 mL / 2 h");
    row = persist(row);
    row.doseAndRate![0].rateRatio!.denominator!.value = 4;
    for (const text of [formatSig(row, "long", { locale: "en" }),
      fromFhirDosage(row, { locale: "en" }).longText]) {
      expect(text).toContain("Rate: 120 mL / 4 h");
      expect(text).not.toContain("Rate: 120 mL / 2 h");
    }
    expect(row.doseAndRate![0].doseQuantity!.value).toBe(120);
    expect(row.text).toBe(source);
  });

  it("keeps a replaced rate range live without removing its original source", () => {
    const row = persist(parseSig("Infuse at 5 mL/h").fhir[0]);
    delete row.doseAndRate![0].rateQuantity;
    row.doseAndRate![0].rateRange = { low: { value: 10, unit: "mL/h" }, high: { value: 15, unit: "mL/h" } };
    for (const text of [formatSig(row, "long", { locale: "en" }),
      fromFhirDosage(row, { locale: "en" }).longText]) {
      expect(text).toMatch(/(?<![\d.])10–15 mL\/h(?![\w/])/u);
      expect(text).not.toContain("at 5 mL/h");
    }
    expect(row.text).toBe("Infuse at 5 mL/h");
  });

  it.each([false, true])("omits empty R6 step on a text-only instruction with safety=%s", safety => {
    const wire: FhirR6DosageInstruction = {
      id: "authored-directions", renderedInstruction: "Take as directed",
      extension: [{ url: "urn:test:authored", valueString: "retained" }],
      ...(safety ? { safety: { doseLimit: [{ scope: "lifetime", valueInteger: 8 }] } } : {}),
    };
    for (const output of [fromFhir(wire).fhirNext, fromFhir({ ...wire, step: [] }).fhirNext,
      courseToR6(courseFromR6(wire)), toDosageDetails(persist(toFhirR5Dosages(wire)))]) {
      expect(Object.prototype.hasOwnProperty.call(output, "step")).toBe(false);
      expect(output.renderedInstruction).toBe("Take as directed");
      expect(output.extension).toContainEqual({ url: "urn:test:authored", valueString: "retained" });
      if (safety) expect(output.safety?.doseLimit).toEqual([{ scope: "lifetime", valueInteger: 8 }]);
    }
  });

  it("accepts R5 Timing modifier metadata while retaining its R5 repeat boundary", () => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { modifierExtension: [{ url: "urn:test:timing-modifier", valueBoolean: true }],
        repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } } };
    expect(toFhirR5Dosages(toDosageDetails([row]))[0].timing?.modifierExtension)
      .toEqual([{ url: "urn:test:timing-modifier", valueBoolean: true }]);
    // @ts-expect-error R6 period offsets do not belong to an R5 Timing.repeat.
    const r6OnlyOffset: FhirDosage = { timing: { repeat: { startOffset: { value: 1, unit: "h" } } } };
    void r6OnlyOffset;
  });

  it.each([
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ])("intersects rate-only quantity caps independent of order %j", (...order) => {
    const amounts = [{ value: 1000, unit: "mg" }, { value: 0.5, unit: "g" }, { value: 0.75, unit: "g" }];
    const limits: FhirR6DoseLimit[] = [];
    for (const scope of ["administration", "lifetime"] as const)
      for (const index of order) limits.push({ scope, valueQuantity: amounts[index] });
    const wire: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ rateQuantity: { value: 5, unit: "mL/h" } }], safety: { doseLimit: limits },
    }] }] };
    for (const course of [courseFromR6(wire),
      courseFromR6(toDosageDetails(persist(toFhirR5Dosages(wire))))]) {
      const actual = numericAdministrationLimits(course.stages[0].administrations[0]);
      expect(actual.administration).toMatchObject({ value: 0.5, unit: "g" });
      expect(actual.lifetime).toMatchObject({ value: 0.5, unit: "g" });
      expect(actual.multiple).toBe(false);
    }
  });
});

it("keeps a metadata-only R6 header at the explicit interchange boundary", () => {
  const metadata = { id: "empty-course", extension: [{ url: "urn:test:opaque-header", valueString: "authored" }] };
  const wire = { ...persist(metadata), step: [] };
  const imported = fromFhir(wire);
  expect(imported.meta.canonical.course!.stages).toEqual([]);
  expect(imported.fhirNext).toEqual(metadata);
  expect(wire.step).toEqual([]);
  expect(courseFromR6(imported.fhirNext).stages).toEqual([]);
  expect(toDosageDetails(persist(toFhirR5Dosages(imported.fhirNext)))).toEqual(metadata);
});


describe("round26 single-step safety modifier scope", () => {
  it.each(["step", "course", "both"] as const)("keeps %s policy modifiers active without qualifying the other policy", scope => {
    const courseModifier = { url: "urn:test:course-policy-qualifier", valueString: "course policy only" };
    const stepModifier = { url: "urn:test:step-policy-qualifier", valueString: "step policy only" };
    const courseSafety: FhirR6DosageSafety = { id: "course-policy", ifExceeded: "Call clinic",
      doseLimit: [{ id: "course-limit", scope: "period", valueQuantity: { value: 8, unit: "tab" }, period: { value: 1, unit: "d" } }],
      ...(scope !== "step" ? { modifierExtension: [courseModifier] } : {}),
    };
    const stepSafety: FhirR6DosageSafety = { id: "step-policy", ifExceeded: "Hold next dose",
      doseLimit: [{ id: "step-limit", scope: "administration", valueQuantity: { value: 2, unit: "tab" } }],
      ...(scope !== "course" ? { modifierExtension: [stepModifier] } : {}),
    };
    let wire = toDosageDetails([{ ...tablet(), sequence: 1 }], undefined,
      { safety: courseSafety, step: [{ sequence: 1, safety: stepSafety }] });
    for (let save = 0; save < 3; save++) {
      expect(wire.step![0].safety).toBeUndefined();
      expect(wire.safety!.doseLimit).toEqual([...courseSafety.doseLimit!, ...stepSafety.doseLimit!]);
      expect(wire.safety!.modifierExtension).toHaveLength(1);
      const active = wire.safety!.modifierExtension![0];
      expect(active.url).toBe(R6_SCOPED_SAFETY_MODIFIER_URL);
      expect(decodeR6SourceMetadata(active, "safety")).toEqual({ course: courseSafety, step: stepSafety });
      const edit = fromDosageDetails(persist(wire));
      expect(edit.course.safety).toEqual(courseSafety);
      expect(edit.course.step![0].safety).toEqual(stepSafety);
      wire = toDosageDetails(edit.dosages, undefined, edit.course);
    }
  });
});

describe("round33 scalar R5 quantity meaning", () => {
  it.each(["mL/h", "mg/h"])("renders a source-less scalar %s rate through public scalar paths", unit => {
    const row: FhirDosage = { doseAndRate: [{ rateQuantity: { value: 5, unit } }] };
    const before = JSON.stringify(row);
    for (const locale of ["en", "th"]) {
      expect(formatSig(row, "long", { locale })).toContain("5 " + unit);
      expect(fromFhirDosage(row, { locale }).longText).toContain("5 " + unit);
    }
    expect(JSON.stringify(row)).toBe(before);
    const authored = { ...row, text: "Infuse five units hourly, per the original instruction." };
    expect(formatSig(authored, "long", { realizationMode: "roundtrip" }).split("; original directions: "))
      .toEqual([`Current: Use; Rate: 5 ${unit}`, authored.text]);
  });

  it.each(["mg", "mL"])("keeps code-only %s units in equal-unit dose ranges", code => {
    const quantity = (value: number) => ({ value, system: "http://unitsofmeasure.org", code });
    const row: FhirDosage = { doseAndRate: [{ doseRange: { low: quantity(2), high: quantity(5) } }] };
    const before = JSON.stringify(row);
    for (const locale of ["en", "th"]) {
      const parsed = fromFhirDosage(row, { locale });
      expect(parsed.meta.canonical.clauses[0].dose).toMatchObject({ range: { low: 2, high: 5 }, unit: code });
      expect(parsed.meta.normalized.unit).toBe(code);
      expect(formatSig(row, "long", { locale })).toContain(locale === "en" ? code :
        code === "mg" ? "มิลลิกรัม" : "มิลลิลิตร");
    }
    expect(JSON.stringify(row)).toBe(before);
  });

  it.each(["<", "<=", "~"] as const)("does not expose a qualified %s upper bound as an inclusive compact dose", comparator => {
    const row: FhirDosage = { doseAndRate: [{ doseRange: {
      low: { value: 2, unit: "mg" },
      high: simpleQuantityForR5({ value: 5, unit: "mg", comparator })!
    } }] };
    const before = JSON.stringify(row);
    const parsed = fromFhirDosage(row);
    expect(parsed.meta.canonical.clauses[0].dose).toBeUndefined();
    expect(parsed.meta.canonical.administration!.amounts![0].range!.high)
      .toMatchObject({ value: 5, unit: "mg", comparator });
    expect(JSON.stringify(row)).toBe(before);
    const ordinary = fromFhirDosage({ doseAndRate: [{ doseRange: {
      low: { value: 2, unit: "mg" }, high: { value: 5, unit: "mg" }
    } }] });
    expect(ordinary.meta.canonical.clauses[0].dose).toMatchObject({ range: { low: 2, high: 5 }, unit: "mg" });
  });
});


describe("round33 adjacent range metadata", () => {
  it.each([
    { low: { value: 2 }, high: { value: 5, unit: "mg" } },
    { low: { value: 2 }, high: { value: 5, system: "http://unitsofmeasure.org", code: "mg" } },
    { low: { extension: [{ url: "urn:local:unmeasured", valueString: "not specified" }] },
      high: { value: 5, system: "http://unitsofmeasure.org", code: "mg" } }
  ])("retains the known endpoint unit when the other endpoint has none: %j", range => {
    const row: FhirDosage = { doseAndRate: [{ doseRange: range }] };
    const source = JSON.stringify(row);
    const parsed = fromFhirDosage(row);
    if (range.low.value !== undefined) {
      // A single shared unit cannot describe both independently authored
      // valued endpoints. The complete rich range remains the suggestion.
      expect(parsed.meta.canonical.clauses[0].dose).toBeUndefined();
      expect(parsed.meta.normalized.unit).toBeUndefined();
      for (const locale of ["en", "th"])
        expect(formatSig(row, "long", { locale, realizationMode: "normalized" })).toContain("2 – 5 mg");
    } else {
      expect(parsed.meta.canonical.clauses[0].dose?.unit).toBe("mg");
      expect(parsed.meta.normalized.unit).toBe("mg");
    }
    expect(importCanonicalCourse(row).stages[0].administrations[0].amounts![0].range).toEqual(range);
    const reopened = toDosageDetails(persist([row]));
    expect(reopened.step![0].component[0].doseAndRate![0].doseRange).toEqual(range);
    expect(toFhirR5Dosages(reopened)[0].doseAndRate![0].doseRange).toEqual(range);
    expect(JSON.stringify(row)).toBe(source);
  });
});

describe("round34 compact range and maximum ownership", () => {
  it.each(["authored", "coded"] as const)("keeps %s mixed-unit endpoints out of compact dose metadata", kind => {
    const range = kind === "authored"
      ? { low: { value: 500, unit: "mcg" }, high: { value: 1, unit: "mg" } }
      : { low: { value: 500, system: "http://unitsofmeasure.org", code: "ug" },
          high: { value: 1, system: "http://unitsofmeasure.org", code: "mg" } };
    const row: FhirDosage = { doseAndRate: [{ doseRange: range }] };
    const raw: FhirR6DosageInstruction = { step: [{ component: [persist(row)] }] };
    const before = JSON.stringify([row, raw]);
    expect(fromFhirDosage(row).meta.canonical.clauses[0].dose).toBeUndefined();
    expect(fromFhir(raw).meta.canonical.clauses[0].dose).toBeUndefined();
    for (const input of [row, raw]) {
      const amount = importCanonicalCourse(input).stages[0].administrations[0].amounts![0];
      expect(amount.range).toEqual(range);
      const text = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(text).toMatch(kind === "authored" ? /(?:^|\D)500 mcg\b/u : /(?:^|\D)500 ug\b/u);
      expect(text).toMatch(/(?:^|\D)1 mg\b/u);
      expect(text).not.toContain("500 to 1");
    }
    expect(JSON.stringify([row, raw])).toBe(before);
  });

  it.each(["low", "high", "both"] as const)("retains the known code-only %s endpoint unit in both editable views", known => {
    const unit = { system: "http://unitsofmeasure.org", code: "mg" };
    const range = {
      low: { value: 2, ...(known === "high" ? {} : unit) },
      high: { value: 5, ...(known === "low" ? {} : unit) },
    };
    const row: FhirDosage = { doseAndRate: [{ doseRange: range }] };
    const raw: FhirR6DosageInstruction = { step: [{ component: [persist(row)] }] };
    const before = JSON.stringify([row, raw]);
    for (const result of [fromFhirDosage(row), fromFhir(raw)]) {
      if (known === "both") {
        expect(result.meta.canonical.clauses[0].dose).toEqual({ range: { low: 2, high: 5 }, unit: "mg" });
        expect(result.meta.normalized.unit).toBe("mg");
      } else {
        expect(result.meta.canonical.clauses[0].dose).toBeUndefined();
        expect(result.meta.normalized.unit).toBeUndefined();
      }
    }
    for (const input of [row, raw]) {
      expect(importCanonicalCourse(input).stages[0].administrations[0].amounts![0].range).toEqual(range);
      for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        if (known === "both")
          expect(text).toContain(locale === "en" ? "2 to 5 mg" : "2 ถึง 5 มิลลิกรัม");
        else {
          expect(text).toContain(known === "low" ? "2 mg – 5" : "2 – 5 mg");
          expect(text).not.toContain("2 to 5 mg");
          expect(text).not.toContain("2 ถึง 5 มิลลิกรัม");
        }
      }
    }
    const rows = toFhirR5Dosages(raw), reopened = toDosageDetails(persist(rows));
    expect(rows[0].doseAndRate![0].doseRange).toEqual(range);
    expect(reopened.step![0].component[0].doseAndRate![0].doseRange).toEqual(range);
    expect(JSON.stringify([row, raw])).toBe(before);
  });

  it.each(["administration", "lifetime"] as const)("keeps a usable %s maximum regardless of a unitless limit's position", scope => {
    const unitless = { scope, valueQuantity: { value: 10, id: "unit-not-supplied" } };
    const known = { scope, valueQuantity: { value: 5, unit: "mg", id: "known-maximum" } };
    for (const limits of [[unitless, known], [known, unitless]]) {
      const raw: FhirR6DosageInstruction = { step: [{ component: [{ safety: { doseLimit: limits } }] }] };
      const before = JSON.stringify(raw);
      for (const input of [raw, toFhirR5Dosages(raw)]) {
        const member = importCanonicalCourse(input).stages[0].administrations[0];
        const bounds = numericAdministrationLimits(member);
        expect(bounds[scope]).toEqual(known.valueQuantity);
        expect(bounds.multiple).toBe(true);
        expect(member.limits).toHaveLength(2);
      }
      expect(JSON.stringify(raw)).toBe(before);
    }
  });
});

describe("round34 qualified Thai fractions", () => {
  it.each([
    ["≤๑ / ๒ เม็ด วันละครั้ง", "<="],
    ["≥๑ / ๒ เม็ด วันละครั้ง", ">="],
    [">=๑ / ๒ เม็ด วันละครั้ง", ">="],
    ["~๑ / ๒ เม็ด วันละครั้ง", "~"],
    ["≤๑/๒เม็ด วันละครั้ง", "<="],
  ] as const)("preserves the half tablet and qualifier in %s", (source, comparator) => {
    const parsed = parseSig(source);
    expect(parsed.input).toBe(source);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.meta.canonical.clauses[0].dose).toMatchObject({ value: 0.5, unit: "tab", comparator });
    for (const wire of [parsed.fhir, parsed.fhirNext]) {
      const native = importCanonicalCourse(wire);
      expect(native.stages).toHaveLength(1);
      expect(native.stages[0].administrations).toHaveLength(1);
      expect(native.stages[0].administrations[0].amounts![0].quantity).toMatchObject({ value: 0.5, comparator });
    }
    expect(getQuantityComparator(parsed.fhir[0].doseAndRate![0].doseQuantity)).toBe(comparator);
    expect(getQuantityComparator(parsed.fhirNext.step![0].component[0].doseAndRate![0].doseQuantity)).toBe(comparator);
  });
});

describe("round34 positional clock primitive annotations", () => {
  const clocks = [null, "09:00:00", null, "17:00:00", null];
  const notes = ["leading", "nine", "middle", "seventeen", "trailing"].map(id => ({ id }));
  it.each(["R5", "R6"] as const)("keeps metadata-only slots out of clinical clocks through %s", boundary => {
    for (const mixed of [false, true]) {
      const timing = { repeat: {
        frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        ...(mixed ? { when: [EventTiming.Morning] } : {}),
        timeOfDay: clocks, _timeOfDay: notes,
      } };
      // JSON is the public wire boundary, including legal primitive null slots.
      const source = persist(boundary === "R5"
        ? [{ ...tablet(), timing }]
        : { step: [{ component: [{ ...tablet(), timing }] }] });
      const before = JSON.stringify(source);
      expect(getTimingClocks(timing.repeat)).toEqual(["09:00:00", "17:00:00"]);
      let wire = courseToR6(importCanonicalCourse(source));
      for (let save = 0; save < 3; save++) {
        const rows = persist(toFhirR5Dosages(wire));
        for (const candidate of [wire, rows]) {
          const native = importCanonicalCourse(candidate);
          expect(native.stages[0].administrations[0].schedule?.recurrence?.clocks)
            .toEqual(["09:00:00", "17:00:00"]);
          expect(formatSig(candidate, "long", { locale: "en", realizationMode: "normalized" })).toMatch(/0?9:00/u);
          const repeat = Array.isArray(candidate) ? candidate[0].timing!.repeat! : candidate.step![0].component[0].timing!.repeat!;
          if (mixed) {
            const active = repeat.extension!.filter(marker => marker.url === TIMING_ADDITIONAL_CLOCK_EXTENSION_URL);
            expect(active.map(marker => marker.valueTime ?? null)).toEqual(clocks);
            expect(active.map(marker => marker._valueTime)).toEqual(notes);
          } else {
            expect(repeat.timeOfDay).toEqual(clocks);
            expect(repeat._timeOfDay).toEqual(notes);
          }
          expect(nextDueDoses(candidate, {
            orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-01T00:00:00Z",
            timeZone: "UTC", eventClock: { MORN: "08:00" }, limit: 3,
          })).toEqual(mixed
            ? ["2026-12-01T08:00:00+00:00", "2026-12-01T09:00:00+00:00", "2026-12-01T17:00:00+00:00"]
            : ["2026-12-01T09:00:00+00:00", "2026-12-01T17:00:00+00:00", "2026-12-02T09:00:00+00:00"]);
        }
        wire = persist(toDosageDetails(rows));
      }
      expect(JSON.stringify(source)).toBe(before);
    }
  });
});

it("round37 updates a known equality display after a code-only edit and preserves unchanged equality", () => {
  const marker = { url: "http://ema.europa.eu/fhir/extension/comparator",
    valueCoding: { id: "authored-equality", system: "http://spor.ema.europa.eu/v1/lists/100000000008",
      code: "100000000049", display: "equal to" } };
  const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 2, unit: "tab", extension: [marker] } }] };
  expect(toDosageDetails([row]).step![0].component[0].doseAndRate![0].doseQuantity?.extension).toEqual([marker]);
  const edited = persist(row);
  edited.doseAndRate![0].doseQuantity!.extension![0].valueCoding!.code = "100000000052";
  const changed = toDosageDetails([edited]).step![0].component[0].doseAndRate![0].doseQuantity!;
  expect(changed).toMatchObject({ value: 2, unit: "tab" });
  expect(getQuantityComparator(changed)).toBe("<=");
  expect(changed.extension).toContainEqual({ ...marker,
    valueCoding: { ...marker.valueCoding, code: "100000000052", display: "less than or equal to" } });
  expect(changed.extension).toContainEqual({
    url: "urn:ezmedicationinput:StructureDefinition:quantity-operator-source",
    valueCoding: { ...marker.valueCoding, code: "100000000052" },
  });
});

// END PRESERVED round39_boundaries
}

describe("round57 interop annotation and historical ownership", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] };
  const boundary = (value: number) => ({ contextCode: { coding: [{
    system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start",
  }] }, offsetDuration: { value, unit: "d" } });
  const historicalMarker = (step: FhirR6DosageStep): FhirExtension => ({
    url: DOSAGE_DETAILS_R5_URL, extension: [{ url: "dosageDetails",
      extension: [encodeR6SourceMetadata("step", step, "step")] }],
  });

  const expressionInput = (slot: "dose" | "rate", identity: string) => {
    const expressions = ["first retained expression", identity === "same expression"
      ? "first retained expression" : "surviving retained expression"].map(expression => ({
      language: "text/cql", expression,
    }));
    const values = [5, identity === "distinct projection" ? 7 : 5];
    const components: FhirR6Dosage[] = expressions.map((expression, index) => ({
      ...(identity === "identified" ? { id: index ? "survivor" : "removed" } : {}),
      timing: { repeat: daily },
      doseAndRate: [slot === "dose"
        ? { doseExpression: expression, rateQuantity: { value: values[index], unit: "mL/h" } }
        : { doseQuantity: q(values[index]), rateExpression: expression }],
    }));
    const rows: FhirDosage[] = [{
      sequence: 1, ...(identity === "identified" ? { id: "survivor" } : {}),
      timing: { repeat: daily },
      doseAndRate: [slot === "dose" ? { rateQuantity: { value: values[1], unit: "mL/h" } }
        : { doseQuantity: q(values[1]) }],
      modifierExtension: [historicalMarker({ component: components })],
    }];
    return { rows, expressions, value: values[1] };
  };

  it.each([
    ["dose", "anonymous"], ["dose", "identified"], ["dose", "distinct projection"], ["dose", "same expression"],
    ["rate", "anonymous"], ["rate", "identified"], ["rate", "distinct projection"], ["rate", "same expression"],
  ] as const)("restores only the owned historical %s expression after deletion (%s)", (slot, identity) => {
    const { rows, expressions, value } = expressionInput(slot, identity), before = persist(rows);
    let wire = toDosageDetails(rows);
    for (let save = 0; save < 2; save++) {
      expect(wire.step![0].component).toHaveLength(1);
      const amount = wire.step![0].component[0].doseAndRate![0];
      expect(slot === "dose" ? amount.rateQuantity : amount.doseQuantity)
        .toEqual(slot === "dose" ? { value, unit: "mL/h" } : q(value));
      expect(slot === "dose" ? amount.doseExpression : amount.rateExpression)
        .toEqual(identity === "anonymous" ? undefined : expressions[1]);
      if (identity === "anonymous") for (const expression of expressions)
        expect(JSON.stringify(wire.extension)).toContain(expression.expression);
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
    }
    expect(rows).toEqual(before);
  });

  const safetyInput = (variant: string) => {
    const safety = { doseLimit: [{ scope: "administration" as const, valueQuantity: q(2) }],
      extension: [{ url: "urn:clinic:policy-code", valueCodeableConcept: {
        coding: [{ system: "urn:clinic:policy", code: "dose-policy",
          extension: [{ url: "urn:clinic:policy-note", valueString: "retain the policy coding annotation" }] }],
      } }],
    };
    const step: FhirR6DosageStep = { component: [{
      id: "policy-dose", doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily }, safety,
    }] };
    const rows: EzDosage[] = persist(toFhirR5Dosages({ step: [step] }));
    rows[0].modifierExtension = [
      ...(rows[0].modifierExtension ?? []).filter(item => item.url !== DOSAGE_DETAILS_R5_URL), historicalMarker(step),
    ];
    const current: NonNullable<EzDosage["safety"]> = persist(safety);
    if (variant.startsWith("version")) {
      current.extension![0].valueCodeableConcept!.coding![0].version = "2026-11";
      if (variant === "version and dose")
        current.extension![0].valueCodeableConcept!.coding![0]._version = { id: "current-policy-edition" };
    }
    if (variant !== "omitted") rows[0].safety = current;
    if (variant === "version and dose") rows[0].doseAndRate![0].doseQuantity!.value = 2;
    return { rows, safety, current };
  };

  it.each(["omitted", "unchanged", "version", "version and dose"] as const)(
    "keeps supplied historical safety Coding metadata (%s)", variant => {
      const { rows, safety, current } = safetyInput(variant), before = persist(rows);
      let wire = toDosageDetails(rows);
      for (let save = 0; save < 2; save++) {
        expect(wire.step![0].component[0].safety).toEqual(variant === "omitted" ? safety : current);
        expect(wire.step![0].component[0].doseAndRate![0].doseQuantity)
          .toEqual(q(variant === "version and dose" ? 2 : 1));
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      }
      expect(rows).toEqual(before);
    });

  const durationInput = (variant: string): FhirR6DosageInstruction => {
    const saved = toDosageDetails([
      { sequence: 1, id: "induction-dose", doseAndRate: [{ doseQuantity: q(1) }],
        timing: { repeat: { ...daily, boundsDuration: { value: 1, unit: "d" } } } },
      { sequence: 3, id: "maintenance-dose", doseAndRate: [{ doseQuantity: q(2) }],
        timing: { repeat: { ...daily, count: 1 } } },
    ], undefined, { step: [
      { sequence: 1, id: "induction" },
      { sequence: 2, id: "pause", end: boundary(3),
        extension: [{ url: "urn:clinic:pause", valueString: "retain the prescribed pause" }] },
      { sequence: 3, id: "maintenance" },
    ] });
    const input = persist(saved), duration = input.step![0].component[0].timing!.repeat!.boundsDuration!;
    if (variant === "annotation") duration._value = { id: "current-duration-note",
      extension: [{ url: "urn:clinic:duration-note", valueString: "one-day annotation only" }] };
    if (variant === "value") duration.value = 2;
    if (variant === "unit") duration.unit = "wk";
    if (variant === "qualifier") duration.comparator = ">";
    return input;
  };

  it.each(["unchanged", "annotation", "value", "unit", "qualifier"] as const)(
    "keeps the editable pause only for unchanged duration meaning (%s)", variant => {
      const input = durationInput(variant), before = persist(input), editable = fromDosageDetails(input);
      const unchanged = variant === "unchanged" || variant === "annotation";
      expect(editable.course.step!.map(step => step.id))
        .toEqual(["induction", ...(unchanged ? ["pause"] : []), "maintenance"]);
      const duration = input.step![0].component[0].timing!.repeat!.boundsDuration;
      expect(editable.dosages[0].timing!.repeat!.boundsDuration).toEqual(duration);
      const reopened = toDosageDetails(persist(editable.dosages), undefined, persist(editable.course));
      expect(fromDosageDetails(reopened).course.step!.map(step => step.id))
        .toEqual(["induction", ...(unchanged ? ["pause"] : []), "maintenance"]);
      expect(JSON.stringify(reopened)).toContain("retain the prescribed pause");
      expect(input).toEqual(before);
    });

  const cycleInput = (variant: string) => {
    const url = variant === "period annotation" ? "periodDays" : variant === "cycles annotation" ? "cycles" : "anchor";
    const child: FhirExtension & { _valueString?: FhirElement; _valueInteger?: FhirElement } = {
      url, id: "authored-cycle-child",
      ...(variant === "valued anchor" ? { valueString: "2026-01-01" } :
        url === "anchor" ? { _valueString: { id: "cycle-anchor",
          extension: [{ url: "urn:clinic:cycle-note", valueString: "retain the unvalued anchor" }] } } :
        { _valueInteger: { id: "cycle-integer-note" } }),
    };
    const marker: FhirExtension = { url: CYCLE_DAY_ELIGIBILITY_EXTENSION_URL, id: "authored-cycle-marker",
      extension: [{ url: "day", valueInteger: 1 }, child,
        { url: "reason", valueCode: "unresolved-cycle-eligibility" },
        { url: "source", valueString: "authored cycle constraint" },
        { url: "urn:clinic:cycle-unknown", valueString: "retain this child" }],
    };
    const rows: FhirDosage[] = [{ doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily },
      modifierExtension: [marker] }];
    return { rows, marker };
  };

  it.each(["anchor annotation", "period annotation", "cycles annotation", "valued anchor"] as const)(
    "preserves the complete cycle marker on an unchanged save (%s)", variant => {
      const { rows, marker } = cycleInput(variant), before = persist(rows);
      let wire = toDosageDetails(rows);
      for (let save = 0; save < 2; save++) {
        expect(wire.step![0].component[0].modifierExtension)
          .toContainEqual(marker);
        expect(toFhirR5Dosages(persist(wire))[0].modifierExtension).toContainEqual(marker);
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      }
      expect(rows).toEqual(before);
    });

  const sequenceInput = (variant: string) => {
    const original = { id: "original-sequence-note",
      extension: [{ url: "urn:clinic:sequence-note", valueString: "retain the authored ordering annotation" }] };
    const current = { id: "current-sequence-note",
      extension: [{ url: "urn:clinic:current-sequence-note", valueString: "replacement ordering annotation" }] };
    let rows: Array<FhirDosage & { _sequence?: FhirElement }> = [{
      sequence: 1, _sequence: original, doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily },
    }];
    if (variant !== "unchanged") {
      rows = persist(toFhirR5Dosages(toDosageDetails(rows)));
      if (variant === "replacement") rows[0]._sequence = current;
      else delete rows[0]._sequence;
    }
    return { rows, expected: variant === "removed" ? undefined : variant === "replacement" ? current : original };
  };

  it.each(["unchanged", "replacement", "removed"] as const)(
    "retains the current R5 sequence annotation as typed R6 source (%s)", variant => {
      const { rows, expected } = sequenceInput(variant), before = persist(rows);
      let wire = toDosageDetails(rows);
      for (let save = 0; save < 2; save++) {
        const component = wire.step![0].component[0];
        expect(component).not.toHaveProperty("sequence");
        expect(component).not.toHaveProperty("_sequence");
        const reopened = persist(toFhirR5Dosages(wire)) as Array<FhirDosage & { _sequence?: FhirElement }>;
        expect(reopened[0].sequence).toBe(1);
        expect(reopened[0]._sequence).toEqual(expected);
        expect(reopened[0].doseAndRate).toEqual([{ doseQuantity: q(1) }]);
        if (expected) expect(JSON.stringify(component.extension)).toContain(expected.id);
        wire = toDosageDetails(reopened);
      }
      expect(rows).toEqual(before);
    });

  const countInput = (variant: string): FhirR6DosageInstruction => ({ step: [{
    id: "annotated-phase", ...(variant === "numeric count" ? { count: 2 } : {}),
    _count: { id: "phase-count-note",
      extension: [{ url: "urn:clinic:count-note", valueString: "retain the phase count annotation" }] },
    component: [{ doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: { ...daily, count: 1 } } }],
  }] });

  it.each(["annotation only", "numeric count"] as const)(
    "exposes the typed step count companion without inventing a value (%s)", variant => {
      const input = countInput(variant), before = persist(input), editable = fromDosageDetails(input);
      const companion: FhirR6PrimitiveElement | undefined = editable.course.step![0]._count;
      expect(companion).toEqual(input.step![0]._count);
      expect(editable.course.step![0].count).toBe(variant === "numeric count" ? 2 : undefined);
      const wire = toDosageDetails(persist(editable.dosages), undefined, persist(editable.course));
      expect(wire.step![0]._count).toEqual(input.step![0]._count);
      expect(wire.step![0].count).toBe(variant === "numeric count" ? 2 : undefined);
      expect(input).toEqual(before);
    });

  const instructionInput = (variant: string) => {
    const input: FhirR6DosageInstruction = { renderedInstruction: "Take one tablet daily",
      _renderedInstruction: { id: "original-instruction-note" },
      step: [{ component: [{ doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } }] }],
    };
    const editable = fromDosageDetails(persist(input));
    const original: FhirR6PrimitiveElement | undefined = editable.course._renderedInstruction;
    const current: EzCourseMetadata = { ...editable.course,
      renderedInstruction: variant === "replacement" ? "Current prescribed daily instruction" : input.renderedInstruction,
      _renderedInstruction: { id: "current-instruction-note",
        extension: [{ url: "urn:clinic:instruction-note", valueString: "retain current instruction metadata" }] },
    };
    return { input, editable, original, current };
  };

  it.each(["companion only", "replacement"] as const)(
    "accepts typed editable instruction primitive metadata (%s)", variant => {
      const { input, editable, original, current } = instructionInput(variant), before = persist(editable);
      expect(original).toEqual(input._renderedInstruction);
      const wire = toDosageDetails(editable.dosages, current.renderedInstruction, current);
      expect(wire.renderedInstruction).toBe(current.renderedInstruction);
      expect(wire._renderedInstruction).toEqual(current._renderedInstruction);
      expect(fromDosageDetails(persist(wire)).course._renderedInstruction).toEqual(current._renderedInstruction);
      expect(editable).toEqual(before);
    });

  const limitsInput = (variant: string) => {
    const limits: FhirR6DoseLimit[] = [
      { scope: "period", valueQuantity: q(4), period: { value: 1, unit: "d" }, text: "first authored daily maximum" },
      { scope: "period", valueQuantity: q(4), period: { value: 1, unit: "d" }, text: "second authored daily maximum" },
      { scope: "period", valueQuantity: { unit: "tab" }, period: { value: 1, unit: "wk" },
        text: "authored partial weekly maximum" },
    ];
    const rows = persist(toFhirR5Dosages(course({ timing: { repeat: daily }, safety: { doseLimit: limits } })));
    if (variant === "dose edit") rows[0].doseAndRate![0].doseQuantity!.value = 2;
    if (variant === "partial change") rows[0].maxDosePerPeriod![2].numerator!.value = 6;
    if (variant === "partial deletion") rows[0].maxDosePerPeriod!.pop();
    return { rows, limits };
  };

  it.each(["unchanged", "dose edit", "partial change", "partial deletion"] as const)(
    "keeps authored duplicate limit text only for an unchanged complete R5 projection (%s)", variant => {
      const { rows, limits } = limitsInput(variant), before = persist(rows);
      let wire = toDosageDetails(rows);
      for (let save = 0; save < 2; save++) {
        const actual = wire.step![0].component[0].safety!.doseLimit!;
        expect(actual.filter(limit => limit.period?.unit === "d").map(limit => limit.valueQuantity)).toEqual([q(4), q(4)]);
        if (variant === "unchanged" || variant === "dose edit") expect(actual).toEqual(limits);
        else {
          expect(actual.filter(limit => limit.period?.unit === "wk"))
            .toEqual(variant === "partial deletion" ? [] : [{ ...limits[2], valueQuantity: q(6) }]);
          for (const limit of limits) expect(JSON.stringify(wire)).toContain(limit.text!);
        }
        expect(wire.step![0].component[0].doseAndRate![0].doseQuantity).toEqual(q(variant === "dose edit" ? 2 : 1));
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      }
      expect(rows).toEqual(before);
    });

  it("preserves an unknown sequence companion supplied on a fresh R6 component", () => {
    const primitive = { id: "future-R6-source-field", extension: [{
      url: "urn:clinic:future-sequence-annotation", valueString: "keep the supplied unknown R6 metadata",
    }] };
    const input = persist({ step: [{ component: [{
      _sequence: primitive, doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily },
      extension: [{ url: "urn:clinic:unrelated-source", valueString: "keep the unrelated R6 field" }],
    }] }] });
    const before = persist(input);
    let wire = projectCanonicalCourse(importCanonicalCourse(input)).fhirNext;
    for (let save = 0; save < 2; save++) {
      expect(wire.step![0].component[0]).toMatchObject({ _sequence: primitive });
      expect(wire.step![0].component[0].extension).toContainEqual({
        url: "urn:clinic:unrelated-source", valueString: "keep the unrelated R6 field",
      });
      expect(wire.step![0].component[0].doseAndRate).toEqual([{ doseQuantity: q(1) }]);
      wire = projectCanonicalCourse(importCanonicalCourse(persist(wire))).fhirNext;
    }
    expect(input).toEqual(before);
  });
});

describe("round58 interop occurrence and metadata ownership", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] };
  const member = () => ({ doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } });
  const historicalInput = (edited: boolean) => {
    const modifier = { id: "phase-rule", url: "urn:clinic:phase-rule",
      valueString: "retain the authored phase restriction",
      _valueString: { extension: [{ url: "urn:clinic:unknown", valueBoolean: true }] } };
    const modifiers: FhirExtension[] = [modifier];
    const step = { id: "loading", modifierExtension: modifiers, component: [member()] };
    const marker: FhirExtension = { url: DOSAGE_DETAILS_R5_URL, extension: [{ url: "dosageDetails",
      extension: [encodeR6SourceMetadata("step", step, "step")] }] };
    const rows: FhirDosage[] = [{ sequence: 1, ...member(), modifierExtension: [marker] }];
    const edits: EzCourseMetadata | undefined = edited ? { step: [{ sequence: 1, id: "current-loading" }] } : undefined;
    return { rows, edits, modifiers };
  };
  it.each([false, true])("reopens legacy step modifiers in the current R6 wrapper (step edit %s)", edited => {
    const { rows, edits, modifiers } = historicalInput(edited), before = persist(rows);
    let wire = toDosageDetails(rows, undefined, edits);
    for (let save = 0; save < 2; save++) {
      expect(wire.step![0]).not.toHaveProperty("modifierExtension");
      expect(wire.step![0].extension).toContainEqual({
        url: "urn:ezmedicationinput:StructureDefinition:r5-step-modifier-extensions", extension: modifiers,
      });
      expect(wire.step![0].id).toBe(edited ? "current-loading" : "loading");
      expect(wire.step![0].component[0].doseAndRate).toEqual(member().doseAndRate);
      expect(() => fromFhir(persist(wire))).not.toThrow();
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
    }
    expect(rows).toEqual(before);
  });

  const aliasedSafetyInput = (variant: string) => {
    const limit: FhirR6DoseLimit = { scope: "administration", valueQuantity: q(2),
      text: "independently authored two-tablet cap" };
    const saved = toDosageDetails([{ sequence: 1, ...member() }], undefined, {
      safety: { doseLimit: [persist(limit)], ifExceeded: "course instruction" },
      step: [{ sequence: 1, id: "loading", safety: { doseLimit: [persist(limit)], ifExceeded: "phase instruction" } }],
    });
    const input = persist(saved), shared = persist(input.safety!.doseLimit![0]);
    const additional: FhirR6DoseLimit = { scope: "lifetime", valueQuantity: q(12), text: "new course maximum" };
    input.safety!.doseLimit = variant === "one survivor" ? [shared, additional]
      : [shared, variant === "shared immutable object" ? shared : persist(shared), additional];
    return { input, limit, additional };
  };
  it.each(["shared immutable object", "separate equal objects", "one survivor"] as const)(
    "keeps independently scoped equal limits by live occurrence (%s)", variant => {
      const { input, limit, additional } = aliasedSafetyInput(variant), before = persist(input);
      if (variant === "shared immutable object") expect(input.safety!.doseLimit![0]).toBe(input.safety!.doseLimit![1]);
      const view = fromDosageDetails(input);
      if (variant === "one survivor") {
        expect(view.course.step![0].safety).toBeUndefined();
        expect(view.course.safety!.doseLimit).toEqual([limit, additional]);
      } else {
        expect(view.course.step![0].safety).toEqual({ doseLimit: [limit], ifExceeded: "phase instruction" });
        expect(view.course.safety).toEqual({ doseLimit: [limit, additional], ifExceeded: "course instruction" });
        const wire = toDosageDetails(persist(view.dosages), undefined, persist(view.course));
        const reopened = fromDosageDetails(persist(wire));
        expect(reopened.course.step![0].safety).toEqual(view.course.step![0].safety);
        expect(reopened.course.safety).toEqual(view.course.safety);
      }
      expect(input).toEqual(before);
    });

  const cycleScalarInput = (cycles: number | undefined, nested = false) => {
    const note = { url: "urn:clinic:count-note", valueString: "retain count annotation" };
    const slot: FhirExtension & { _valueInteger?: FhirElement } = { id: "count-slot", url: "cycles",
      ...(nested ? { extension: [note] } : { _valueInteger: { id: "pending-count", extension: [note] } }) };
    const previous: FhirExtension = { id: "cycle-rule", url: CYCLE_DAY_ELIGIBILITY_EXTENSION_URL,
      extension: [{ url: "day", valueInteger: 1 }, slot, { url: "urn:clinic:cycle-note", valueString: "unrelated cycle note" }] };
    const constraint = { days: [1], ...(cycles !== undefined ? { cycles } : {}),
      reason: "unresolved-cycle-eligibility" as const, sourceText: "" };
    return { previous, slot, constraint };
  };
  it.each([undefined, 3])("preserves an annotation-only cycle count or fills its scalar slot (%s)", cycles => {
    const { previous, slot, constraint } = cycleScalarInput(cycles), before = persist(previous);
    const marker = cycleDayConstraintExtension(constraint, previous);
    expect(marker.extension!.filter(item => item.url === "cycles")).toEqual([
      cycles === undefined ? slot : { ...slot, valueInteger: cycles },
    ]);
    let rows: FhirDosage[] = [{ ...member(), modifierExtension: [marker] }];
    for (let save = 0; save < 2; save++) {
      expect(getCycleDayConstraint(rows[0])?.cycles).toBe(cycles);
      const wire = toDosageDetails(persist(rows));
      expect(wire.step![0].component[0].modifierExtension).toContainEqual(marker);
      rows = toFhirR5Dosages(persist(wire));
    }
    expect(previous).toEqual(before);
  });

  it.each([undefined, 3])("retains nested cycle-count annotations when filling a valid scalar (%s)", cycles => {
    const { previous, slot, constraint } = cycleScalarInput(cycles, true), before = persist(previous);
    const marker = cycleDayConstraintExtension(constraint, previous);
    expect(marker.extension!.filter(item => item.url === "cycles")).toEqual([
      cycles === undefined ? slot : { id: "count-slot", url: "cycles", valueInteger: cycles },
    ]);
    if (cycles !== undefined) expect(marker.extension).toContainEqual({
      url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [slot],
    });
    let rows: FhirDosage[] = [{ ...member(), modifierExtension: [marker] }];
    for (let save = 0; save < 2; save++) {
      expect(getCycleDayConstraint(rows[0])?.cycles).toBe(cycles);
      const wire = toDosageDetails(persist(rows));
      expect(wire.step![0].component[0].modifierExtension).toContainEqual(marker);
      rows = toFhirR5Dosages(persist(wire));
    }
    expect(previous).toEqual(before);
  });

  const cycleDaysInput = (variant: string) => {
    const days = [1, 8, 15].map(valueInteger => ({ id: "day-" + valueInteger, url: "day", valueInteger,
      _valueInteger: { extension: [{ url: "urn:clinic:day-note", valueString: "annotation for day " + valueInteger }] } }));
    const previous: FhirExtension = { id: "cycle-days", url: CYCLE_DAY_ELIGIBILITY_EXTENSION_URL,
      extension: days };
    const currentDays = variant === "remove middle" ? [1, 15] : variant === "reorder" ? [15, 1, 8] : [1, 8, 15, 22];
    const constraint = { days: currentDays, reason: "unresolved-cycle-eligibility" as const, sourceText: "" };
    return { days, previous, constraint };
  };
  it.each(["remove middle", "reorder", "add new day"] as const)(
    "keeps each cycle-day annotation on its authored ordinal (%s)", variant => {
      const { days, previous, constraint } = cycleDaysInput(variant), before = persist(previous);
      const marker = cycleDayConstraintExtension(constraint, previous);
      const active = marker.extension!.filter(item => item.url === "day");
      expect(active).toEqual(constraint.days.map(value => days.find(day => day.valueInteger === value) ??
        { url: "day", valueInteger: value }));
      if (variant === "remove middle") expect(marker.extension).toContainEqual({
        url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [days[1]],
      });
      let wire = toDosageDetails([{ ...member(), modifierExtension: [marker] }]);
      for (let save = 0; save < 2; save++) {
        expect(wire.step![0].component[0].modifierExtension).toContainEqual(marker);
        expect(getCycleDayConstraint(toFhirR5Dosages(persist(wire))[0])!.days).toEqual(constraint.days);
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      }
      expect(previous).toEqual(before);
    });

  const durationInput = (variant: string) => {
    const low: FhirR6Quantity = { id: "low-duration", value: 30, unit: "min", system: "http://unitsofmeasure.org",
      code: "min", comparator: "<", extension: [{ url: "urn:clinic:duration-note", valueString: "authored lower endpoint" }] };
    const high: FhirR6Quantity = { id: "high-duration", value: 90, unit: "min", system: "http://unitsofmeasure.org",
      code: "min", comparator: ">", extension: [{ url: "urn:clinic:duration-note", valueString: "authored upper endpoint" }] };
    const marker: FhirExtension = { id: "duration-source", url: TIMING_ADMINISTRATION_DURATION_EXTENSION_URL,
      valueRange: { low: simpleQuantityForR5(low), high: simpleQuantityForR5(high) } };
    const rows: FhirDosage[] = [{ ...member(), timing: { repeat: { ...daily,
      ...(variant === "lower" ? { duration: 45, durationUnit: FhirPeriodUnit.Minute } :
        variant === "upper" ? { durationMax: 60, durationUnit: FhirPeriodUnit.Minute } :
        variant === "matching core" ? { duration: 30, durationMax: 90, durationUnit: FhirPeriodUnit.Minute } : {}),
      extension: [marker],
    } } }];
    return { rows, marker, low, high };
  };
  it.each(["unchanged", "matching core", "lower", "upper"] as const)(
    "uses a fresh core duration endpoint without reviving its retired qualifier (%s)", variant => {
      const { rows, marker, low, high } = durationInput(variant), before = persist(rows);
      let native = importCanonicalCourse(rows);
      for (let save = 0; save < 2; save++) {
        const range = native.stages[0].administrations[0].schedule!.recurrence!.occurrenceDurationRange!;
        expect(range.low!.value).toBe(variant === "lower" ? 45 : 30);
        expect(range.high!.value).toBe(variant === "upper" ? 60 : 90);
        expect(getQuantityComparator(range.low)).toBe(variant === "lower" ? undefined : "<");
        expect(getQuantityComparator(range.high)).toBe(variant === "upper" ? undefined : ">");
        if (variant !== "lower") expect(range.low).toEqual(low);
        if (variant !== "upper") expect(range.high).toEqual(high);
        if (variant === "lower") expect(range.low).toMatchObject({ extension: [{
          url: DOSAGE_RECONCILIATION_SOURCE_URL, valueQuantity: marker.valueRange!.low,
        }] });
        if (variant === "upper") expect(range.high).toMatchObject({ extension: [{
          url: DOSAGE_RECONCILIATION_SOURCE_URL, valueQuantity: marker.valueRange!.high,
        }] });
        const output = projectCanonicalCourse(native);
        if (variant !== "unchanged") expect(JSON.stringify(output.fhirNext)).toContain("duration-source");
        expect(output.fhirNext.step![0].component[0].doseAndRate).toEqual(member().doseAndRate);
        native = importCanonicalCourse(persist(output.fhir));
      }
      expect(rows).toEqual(before);
      expect(marker.valueRange!.low!.value).toBe(30);
    });

  const countInput = (count: number | undefined) => {
    const marker: FhirExtension & { _valueInteger?: FhirElement } = {
      id: "authored-course-count", url: COURSE_CYCLE_COUNT_EXTENSION_URL, valueInteger: 3,
      _valueInteger: { extension: [{ url: "urn:clinic:course-count-note", valueString: "retain original count metadata" }] },
    };
    const owner = { modifierExtension: [marker] };
    return { count, marker, owner };
  };
  it.each([undefined, 2, 3])("retains a cleared course count as inactive source (%s)", count => {
    const { marker, owner } = countInput(count), before = persist(marker);
    const displaced = setCourseCycleCount(owner, count);
    expect(getCourseCycleCount(owner)).toBe(count);
    if (count === undefined) expect(displaced).toEqual([marker]);
    else expect(owner.modifierExtension).toEqual([{ ...marker, valueInteger: count }]);
    const input: FhirR6DosageInstruction = { ...course(member()), ...owner,
      repeatCycle: { value: 7, unit: "d" },
      ...(displaced ? { extension: [{ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: displaced }] } : {}),
    };
    let wire = input;
    for (let save = 0; save < 2; save++) {
      expect(getCourseCycleCount(wire)).toBe(count);
      expect(JSON.stringify(wire)).toContain("retain original count metadata");
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
    }
    expect(marker).toEqual(before);
  });

  const opaqueDraftInput = (active: boolean, collision: boolean) => {
    const marker: FhirExtension = { id: "opaque-draft-source", url: R6_DRAFT_STEPS_SOURCE_URL, extension: [
      { url: "retainedField", extension: [{ url: "name", valueString: "drafts" },
        retainField("value", "unrecognized saved draft payload")] },
      ...(collision ? [{ url: "drafts", extension: [{ url: "index", valueInteger: 0 },
        { url: "step", extension: [{ url: "id", valueString: "opaque-draft" }] }] }] : []),
      { url: "urn:clinic:opaque-note", valueString: "retain unrelated opaque source" },
    ] };
    const rows: FhirDosage[] = active ? [member()] : [];
    const metadata: EzCourseMetadata = { step: [], extension: [marker] };
    return { rows, metadata, marker };
  };
  it.each([[true, true], [false, true], [true, false], [false, false]] as const)(
    "keeps fresh opaque draft metadata without losing active rows (active %s, mixed source %s)", (active, collision) => {
      const { rows, metadata, marker } = opaqueDraftInput(active, collision), before = persist({ rows, metadata });
      let wire = toDosageDetails(rows, undefined, metadata);
      expect((wire.step ?? []).reduce<Array<FhirR6Dosage["doseAndRate"]>>((values, step) =>
        values.concat(step.component.map(component => component.doseAndRate)), []))
        .toEqual(active ? [member().doseAndRate] : []);
      expect(JSON.stringify(wire)).toContain("opaque-draft-source");
      expect(JSON.stringify(wire)).toContain("unrecognized saved draft payload");
      expect(JSON.stringify(wire)).toContain("retain unrelated opaque source");
      const view = fromDosageDetails(persist(wire));
      wire = toDosageDetails(persist(view.dosages), undefined, persist(view.course));
      expect(JSON.stringify(wire)).toContain("opaque-draft-source");
      expect({ rows, metadata }).toEqual(before);
      expect(metadata.extension).toEqual([marker]);
    });

  const operatorInput = (qualifier: string, order: string) => {
    const equal: FhirExtension = { id: "exact-operator", url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000049", display: "equal to",
        extension: [{ url: "urn:clinic:operator-note", valueString: "original equality" }] } };
    const other: FhirExtension = { id: "qualified-operator", url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM,
        code: qualifier === "approximate" ? "100000000055" : "100000000050" } };
    const extension = order === "equality only" ? [equal] : order === "qualifier only" ? [other]
      : order === "equality first" ? [equal, other] : [other, equal];
    const quantity = { value: 5, unit: "mg", extension };
    const rows: FhirDosage[] = [{ ...member(), doseAndRate: [{ doseQuantity: quantity }] }];
    return { quantity, rows };
  };
  it.each([
    ["approximate", "equality first"], ["approximate", "equality last"],
    ["less than", "equality first"], ["less than", "equality last"],
    ["approximate", "equality only"], ["approximate", "qualifier only"], ["less than", "qualifier only"],
  ] as const)("keeps conflicting equality and %s operators unresolved (%s)", (qualifier, order) => {
    const { quantity, rows } = operatorInput(qualifier, order), before = persist(rows);
    const expected = order === "qualifier only" ? qualifier === "approximate" ? "~" : "<" : undefined;
    expect(getEmaQuantityComparator(quantity)).toBe(expected);
    expect(quantityFromWire(quantity)?.comparator).toBe(expected);
    let wire = toDosageDetails(rows);
    for (let save = 0; save < 2; save++) {
      const dose = wire.step![0].component[0].doseAndRate![0].doseQuantity!;
      expect(dose.value).toBe(5);
      expect(dose.unit).toBe("mg");
      expect(getQuantityComparator(dose)).toBe(expected);
      expect(dose.extension).toEqual(quantity.extension);
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
    }
    expect(rows).toEqual(before);
  });
});


describe("round58 retained range source retirement", () => {
  const fresh = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
  const sourceRanges = (wire: FhirR6DosageInstruction) => {
    const ranges: NonNullable<FhirR6Extension["valueRange"]>[] = [];
    for (const history of wire.extension ?? []) {
      if (history.url !== DOSAGE_RECONCILIATION_SOURCE_URL) continue;
      for (const marker of history.extension ?? [])
        for (const component of marker.extension ?? []) {
          if (component.url !== "component") continue;
          for (const entry of component.extension ?? []) {
            if (entry.url !== "doseAndRate") continue;
            for (const field of entry.extension ?? [])
              if (field.url === "doseRange" && field.valueRange) ranges.push(field.valueRange);
          }
        }
    }
    return ranges;
  };
  const rangeInput = (variant: string) => {
    const low = { id: "r58-s2-authored-low", extension: [
      { url: "urn:clinic:low-note", valueString: "Keep the original endpoint annotation" },
    ], ...(variant === "valued low removed" ? { value: 1, unit: "drop" } : {}) };
    const input: FhirR6DosageInstruction = { id: "r58-s2-source", extension: [
      { url: "urn:clinic:course-note", valueString: "Keep the independent course annotation" },
    ], step: [{ component: [{ site: { concept: { text: "both eyes" } },
      doseAndRate: [{ type: { text: "ordered" }, doseRange: { low, high: {
        value: 2, unit: "drop", extension: [{ url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
          valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000050" } }],
      } } }],
    }] }] };
    const original = fresh(input);
    const saved = toFhirR5Dosages(input);
    // This is a new persisted caller object, prepared before its first API submission.
    const rows = fresh(saved);
    const originalRange = fresh(saved[0].doseAndRate![0].doseRange!);
    if (variant === "low removed" || variant === "valued low removed")
      delete rows[0].doseAndRate![0].doseRange!.low;
    else if (variant === "low replaced")
      rows[0].doseAndRate![0].doseRange!.low = { id: "r58-s2-current-low",
        extension: [{ url: "urn:clinic:current-low-note", valueString: "Current endpoint annotation" }] };
    else if (variant === "entry removed") delete rows[0].doseAndRate;
    return { input, original, rows, originalRange };
  };
  it.each(["unchanged", "low removed", "low replaced", "valued low removed", "entry removed"] as const)(
    "keeps the current range separate from complete retired endpoint source (%s)", variant => {
      const { input, original, rows, originalRange } = rangeInput(variant), before = fresh(rows);
      const expected = fresh(rows[0].doseAndRate ?? []);
      let wire = toDosageDetails(rows);
      for (let save = 0; save < 2; save++) {
        const component = wire.step![0].component[0];
        expect(component.doseAndRate ?? []).toEqual(expected);
        expect(component.site).toEqual({ concept: { text: "both eyes" } });
        expect(wire.id).toBe("r58-s2-source");
        expect(wire.extension).toContainEqual(original.extension![0]);
        const retained = sourceRanges(wire);
        if (variant === "unchanged") expect(retained).toEqual([]);
        else expect(retained).toContainEqual(originalRange);
        if (variant === "low removed" || variant === "valued low removed")
          expect(component.doseAndRate![0].doseRange!.low).toBeUndefined();
        const savedR6 = fresh(wire), savedBefore = fresh(savedR6);
        const returnedR5 = toFhirR5Dosages(savedR6);
        expect(returnedR5[0].doseAndRate ?? []).toEqual(expected);
        expect(savedR6).toEqual(savedBefore);
        wire = toDosageDetails(fresh(returnedR5));
      }
      expect(rows).toEqual(before);
      expect(input).toEqual(original);
    });
});


describe("round59 interop live wire ownership", () => {
  const note: FhirExtension = { url: "urn:clinic:round59-note", valueString: "keep the authored annotation" };
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] };
  const options = { orderedAt: "2026-11-22T00:00:00Z", from: "2026-11-22T00:00:00Z", timeZone: "UTC", limit: 6 };
  const allExtensions = (value: unknown): FhirExtension[] => {
    if (Array.isArray(value)) return value.reduce<FhirExtension[]>((all, item) => all.concat(allExtensions(item)), []);
    if (!value || typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    return (typeof record.url === "string" ? [value as FhirExtension] : [])
      .concat(...Object.keys(record).map(key => allExtensions(record[key])));
  };
  const sequenceInput = (sequence: number, moved: boolean): FhirR6DosageInstruction => {
    const rows: FhirDosage[] = [
      { id: "anchor", sequence, doseAndRate: [{ doseQuantity: q(1) }],
        timing: { repeat: { ...daily, boundsDuration: { value: 1, unit: "d" } } } },
      { id: "movable", sequence, _sequence: { id: "sequence-note", extension: [note] },
        doseAndRate: [{ doseQuantity: q(3) }],
        timing: { repeat: { ...daily, boundsDuration: { value: 1, unit: "d" } } }, extension: [note] },
      { id: "later", sequence: 2, doseAndRate: [{ doseQuantity: q(2) }],
        timing: { repeat: { ...daily, boundsDuration: { value: 1, unit: "d" } } } },
    ];
    const fresh = persist(toDosageDetails(rows));
    if (moved) {
      const index = fresh.step![0].component.findIndex(item => item.id === "movable");
      fresh.step![1].component.push(...fresh.step![0].component.splice(index, 1));
    }
    return fresh;
  };
  it.each([[0, false], [0, true], [-2, false], [-2, true]] as const)(
    "keeps the current phase while retaining the original R5 sequence %s (moved %s)", (sequence, moved) => {
      const input = sequenceInput(sequence, moved), before = persist(input);
      const original = { url: DOSAGE_RETAINED_R5_SEQUENCE_URL, valueDecimal: sequence,
        _valueDecimal: { id: "sequence-note", extension: [note] } };
      let wire = input;
      for (let save = 0; save < 2; save++) {
        const rows = toFhirR5Dosages(wire), current = rows.find(row => row.id === "movable")!;
        expect(current.sequence).toBe(moved ? 2 : sequence);
        expect(current.doseAndRate).toEqual([{ doseQuantity: q(3) }]);
        expect(current.extension).toContainEqual(note);
        expect(allExtensions(rows)).toContainEqual(original);
        wire = toDosageDetails(persist(rows));
        expect(wire.step![moved ? 1 : 0].component.map(item => item.id)).toContain("movable");
        expect(wire.step![moved ? 0 : 1].component.map(item => item.id)).not.toContain("movable");
        expect(nextDueDoses(wire, options)).toEqual(moved ? [
          "2026-11-22T09:00:00+00:00", "2026-11-23T09:00:00+00:00", "2026-11-23T09:00:00+00:00",
        ] : ["2026-11-22T09:00:00+00:00", "2026-11-22T09:00:00+00:00", "2026-11-23T09:00:00+00:00"]);
        expect(calculateTotalUnits({ dosage: wire, ...options,
          durationValue: 2, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(6);
      }
      expect(input).toEqual(before);
    });

  const cycleInput = (variant: string): FhirDosage[] => [{ id: "cycle-dose",
    doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily }, modifierExtension: [{
      id: "cycle-rule", url: CYCLE_DAY_ELIGIBILITY_EXTENSION_URL, extension: [
        { url: "day", valueInteger: 1 }, { url: "periodDays", valueInteger: 7 },
        { id: "source-note", url: "source", ...(variant === "authored text"
          ? { valueString: "day one of each seven-day cycle", _valueString: { extension: [note] } }
          : { extension: [note] }) },
        ...(variant === "new count" ? [{ url: "cycles", valueInteger: 3 }] : []),
      ],
    }] }];
  it.each(["annotation only", "authored text", "new count"] as const)(
    "does not turn a cycle source decoder default into authored text (%s)", variant => {
      const input = cycleInput(variant), before = persist(input), marker = input[0].modifierExtension![0];
      let rows = projectCanonicalCourse(importCanonicalCourse(input)).fhir;
      for (let save = 0; save < 2; save++) {
        expect(rows[0].modifierExtension).toContainEqual(marker);
        expect(getCycleDayConstraint(rows[0])).toMatchObject({ days: [1], periodDays: 7,
          sourceText: variant === "authored text" ? "day one of each seven-day cycle" : "" });
        expect(getCycleDayConstraint(rows[0])?.cycles).toBe(variant === "new count" ? 3 : undefined);
        rows = toFhirR5Dosages(persist(toDosageDetails(persist(rows))));
      }
      expect(input).toEqual(before);
    });
  it("writes a real cycle-source replacement and cycle count while retaining annotations", () => {
    const previous = cycleInput("annotation only")[0].modifierExtension![0], before = persist(previous);
    const source = previous.extension!.find(item => item.url === "source")!;
    const result = cycleDayConstraintExtension({ days: [1], periodDays: 7, cycles: 3,
      reason: "unresolved-cycle-eligibility", sourceText: "day one; three cycles" }, previous);
    expect(result.extension).toContainEqual({ id: "source-note", url: "source", valueString: "day one; three cycles" });
    expect(result.extension).toContainEqual({ url: "cycles", valueInteger: 3 });
    expect(result.extension).toContainEqual({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [source] });
    expect(previous).toEqual(before);
  });

  const maximumInput = (variant: string) => {
    const ratio: FhirRatio = variant === "original pending period" ? {
      id: "pending-window", numerator: q(4), denominator: { unit: "d", _value: { id: "pending-period", extension: [{
        url: "urn:clinic:period-note", valueString: "period remains unentered",
      }] } },
    } : variant === "original annotated site" ? {
      numerator: { _value: { id: "authored-maximum" } }, denominator: { value: 1, unit: "d" },
    } : { id: "partial-limit", extension: [note],
      ...(variant === "denominator only" ? {} : { numerator: { id: "amount", unit: "tab", extension: [note],
        ...(["missing amount", "both missing"].indexOf(variant) >= 0 ? {} : { value: 4 }) } }),
      ...(variant === "numerator only" ? {} : { denominator: { id: "period", unit: "d", extension: [note],
        ...(["missing period", "both missing"].indexOf(variant) >= 0 ? {} : { value: 1 }) } }),
    };
    const site: NonNullable<FhirR6Dosage["site"]> | undefined = variant === "original annotated site" ? { reference: {
      reference: "BodyStructure/right", _reference: { id: "authored-reference" },
      type: "BodyStructure", _type: { id: "authored-type" },
      display: "Right eye", _display: { id: "authored-display" },
    } } : undefined;
    const rows: FhirDosage[] = site ? persist(toFhirR5Dosages(course({ id: "partial-dose", site,
      timing: { repeat: daily }, extension: [note] }))) : [{ id: "partial-dose", doseAndRate: [{ doseQuantity: q(1) }],
      timing: { repeat: daily }, extension: [note] }];
    rows[0].maxDosePerPeriod = [ratio];
    return { ratio, rows, site };
  };
  it.each(["missing amount", "missing period", "both missing", "complete", "numerator only", "denominator only", "original pending period", "original annotated site"] as const)(
    "keeps the authored period maximum editable only when both endpoints exist (%s)", variant => {
      const { ratio, rows: input, site } = maximumInput(variant), before = persist(input);
      let wire = toDosageDetails(input);
      for (let save = 0; save < 2; save++) {
        const limits = wire.step![0].component[0].safety?.doseLimit;
        if (site) expect(wire.step![0].component[0].site).toEqual(site);
        if (!ratio.numerator || !ratio.denominator) expect(limits).toBeUndefined();
        else expect(limits).toEqual([{ id: ratio.id, ...(ratio.extension ? { extension: ratio.extension } : {}),
          scope: "period", valueQuantity: ratio.numerator, period: ratio.denominator }]);
        const rows = toFhirR5Dosages(persist(wire));
        if (!ratio.numerator || !ratio.denominator) {
          expect(rows[0].maxDosePerPeriod).toBeUndefined();
          const retained = rows[0].extension!.find(item => item.url === R5_SOURCE_ONLY_MAXIMUM_URL)!;
          expect(readRetainedField(retained)).toEqual(ratio);
        } else expect(rows[0].maxDosePerPeriod).toEqual([ratio]);
        expect(rows[0].extension).toContainEqual(note);
        expect(calculateTotalUnits({ dosage: wire, ...options,
          durationValue: 2, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(2);
        wire = toDosageDetails(persist(rows));
      }
      expect(input).toEqual(before);
    });

  const clockInput = (variant: string): FhirDosage[] => [{ id: "clock-dose",
    doseAndRate: [{ doseQuantity: q(1) }], extension: [note], timing: { repeat: {
      frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
      ...(variant === "clock metadata alone" ? {} : { when: [EventTiming["Before Breakfast"]] }),
      timeOfDay: variant === "mixed slots" ? [null, "09:00:00"] : variant === "valued clock" ? ["09:00:00"] : [null],
      _timeOfDay: [{ id: "clock-annotation", extension: [note] }],
    } } }];
  it.each(["metadata only", "mixed slots", "valued clock", "clock metadata alone"] as const)(
    "preserves positional clock annotations without core clocks beside event anchors (%s)", variant => {
      const input = clockInput(variant), before = persist(input), authored = input[0].timing!.repeat!;
      let wire = toDosageDetails(input);
      for (let save = 0; save < 2; save++) {
        const rows = toFhirR5Dosages(persist(wire)), repeat = rows[0].timing!.repeat!;
        if (variant === "clock metadata alone") {
          expect(repeat.timeOfDay).toEqual([null]);
          expect(repeat._timeOfDay).toEqual(authored._timeOfDay);
          expect(repeat.when).toBeUndefined();
        } else {
          expect(repeat.when).toEqual([EventTiming["Before Breakfast"]]);
          expect(repeat.timeOfDay).toBeUndefined();
          expect(repeat._timeOfDay).toBeUndefined();
          expect(repeat.extension!.filter(item => item.url === TIMING_ADDITIONAL_CLOCK_EXTENSION_URL))
            .toEqual(authored.timeOfDay!.map((value, index) => ({ url: TIMING_ADDITIONAL_CLOCK_EXTENSION_URL,
              ...(value ? { valueTime: value } : {}),
              ...(authored._timeOfDay?.[index] ? { _valueTime: authored._timeOfDay[index] } : {}) })));
        }
        expect(rows[0].extension).toContainEqual(note);
        wire = toDosageDetails(persist(rows));
      }
      expect(input).toEqual(before);
    });

  const exclusionInput = (clear: boolean): EzDosage[] => {
    const parsed = parseSig("1 tab daily except 2026-11-23; maximum 2 tablets per day");
    const rows: EzDosage[] = persist(toFhirR5Dosages(parsed.fhir));
    if (clear) rows[0].excludedDates = [];
    return rows;
  };
  it.each([false, true])("lets a fresh explicit exclusion clear own the saved capped preview (clear %s)", clear => {
    const input = exclusionInput(clear), before = persist(input), originalText = input[0].text;
    const maximum = persist(input[0].maxDosePerPeriod);
    expect(dosageMatchesSavedProjection(input[0])).toBe(!clear);
    expect(getDosageExcludedDates(input[0])).toEqual(clear ? [] : ["2026-11-23"]);
    for (const source of [input[0], input, toDosageDetails(persist(input))]) {
      const text = formatSig(source, "long", { locale: "en", realizationMode: "roundtrip" });
      if (clear) expect(text).not.toContain("2026-11-23");
      else expect(text).toContain("2026-11-23");
    }
    let wire = toDosageDetails(persist(input));
    for (let save = 0; save < 2; save++) {
      const rows = toFhirR5Dosages(persist(wire));
      expect(getDosageExcludedDates(rows[0])).toEqual(clear ? [] : ["2026-11-23"]);
      expect(rows[0].maxDosePerPeriod).toEqual(maximum);
      expect(JSON.stringify(wire)).toContain(originalText!);
      expect(calculateTotalUnits({ dosage: wire, ...options,
        durationValue: 2, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(clear ? 2 : 1);
      wire = toDosageDetails(persist(rows));
    }
    expect(input).toEqual(before);
  });
  it("keeps an empty exclusion field equivalent when no valued date modifier is suppressed", () => {
    const parsed = parseSig("1 tab daily; maximum 2 tablets per day");
    const unchanged = persist(toFhirR5Dosages(parsed.fhir));
    const empty: EzDosage[] = persist(unchanged);
    empty[0].excludedDates = [];
    expect(dosageMatchesSavedProjection(empty[0])).toBe(true);
    expect(formatSig(empty[0], "long", { locale: "en", realizationMode: "roundtrip" }))
      .toBe(unchanged[0].text);
  });
});


describe("round60 interoperability ownership", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] };
  const note = { url: "urn:clinic:round60-note", valueString: "Preserve the complete authored annotation" };
  const boundary = (value: number) => ({
    contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] },
    offsetDuration: { value, unit: "d" },
  });
  const originalRange = {
    id: "authored-rate-range", extension: [note],
    low: { value: 5, unit: "mL/h", extension: [{
      url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000053" },
    }] },
    high: { value: 10, unit: "mL/h", _value: { id: "authored-rate-high" } },
  };
  const retiredSources = (wire: FhirR6DosageInstruction): FhirR6Extension[] => {
    const sources: FhirR6Extension[] = [];
    for (const item of wire.extension ?? [])
      if (item.url === DOSAGE_RECONCILIATION_SOURCE_URL) sources.push(...(item.extension ?? []));
    return sources;
  };
  const retiredAmounts = (wire: FhirR6DosageInstruction) => {
    const amounts: NonNullable<FhirR6Dosage["doseAndRate"]> = [];
    for (const item of retiredSources(wire))
      if (item.url === DOSAGE_DETAILS_R5_URL) amounts.push(...(decodeR5RetainedFields(item).component?.doseAndRate ?? []));
    return amounts;
  };

  it.each(["unchanged", "replace", "remove", "remove rate entry"] as const)(
    "keeps the independent dose and complete inactive rate Range after %s", edit => {
      const source: FhirR6DosageInstruction = { step: [{ component: [{
        timing: { repeat: daily },
        doseAndRate: edit === "remove rate entry"
          ? [{ id: "dose", doseQuantity: { value: 100, unit: "mL" } },
            { id: "rate", rateRange: persist(originalRange) }]
          : [{ id: "amount", doseQuantity: { value: 100, unit: "mL" }, rateRange: persist(originalRange) }],
      }] }] };
      const sourceBefore = persist(source);
      let rows = persist(toFhirR5Dosages(source));
      if (edit === "remove rate entry") rows[0].doseAndRate = [rows[0].doseAndRate![0]];
      else if (edit !== "unchanged") {
        delete rows[0].doseAndRate![0].rateRange;
        if (edit === "replace") rows[0].doseAndRate![0].rateQuantity = { value: 8, unit: "mL/h" };
      }
      for (let save = 0; save < 2; save++) {
        const before = persist(rows), actual = toDosageDetails(rows);
        const amounts = actual.step![0].component[0].doseAndRate!;
        expect(amounts[0].doseQuantity).toEqual({ value: 100, unit: "mL" });
        if (edit === "unchanged") expect(amounts[0].rateRange).toEqual(originalRange);
        else {
          expect(amounts.some(item => item.rateRange)).toBe(false);
          expect(amounts[0].rateQuantity).toEqual(edit === "replace" ? { value: 8, unit: "mL/h" } : undefined);
          expect(retiredAmounts(actual).map(item => item.rateRange)).toContainEqual(originalRange);
        }
        expect(rows).toEqual(before);
        rows = persist(toFhirR5Dosages(actual));
      }
      expect(source).toEqual(sourceBefore);
    });

  it.each(["annotation", "dose", "timing"] as const)(
    "distinguishes an annotated empty-course carrier from an active %s row", edit => {
      const source: FhirR6DosageInstruction = {
        id: "round60-empty-course", renderedInstruction: "Clinician source-only instruction", extension: [note],
      };
      const annotation = { id: "source-sequence", extension: [note] };
      let rows = persist(toFhirR5Dosages(source));
      rows[0]._sequence = annotation;
      if (edit === "dose") rows[0].doseAndRate = [{ doseQuantity: q(1) }];
      if (edit === "timing") rows[0].timing = { repeat: daily };
      for (let save = 0; save < 2; save++) {
        const before = persist(rows), actual = toDosageDetails(rows);
        expect(actual.extension).toContainEqual(note);
        if (edit === "annotation") {
          expect(actual.step).toBeUndefined();
          expect(actual.renderedInstruction).toBe(source.renderedInstruction);
          const sources = retiredSources(actual).filter(item => item.url === "r5SourceCarrier");
          expect(sources.map(readRetainedField))
            .toContainEqual({ _sequence: annotation });
        } else {
          expect(actual.step).toHaveLength(1);
          const member = actual.step![0].component[0];
          expect(member.extension).toContainEqual({
            url: DOSAGE_RETAINED_R5_SEQUENCE_URL, ...(save ? { valueDecimal: 1 } : {}), _valueDecimal: annotation,
          });
          if (edit === "dose") expect(member.doseAndRate).toEqual([{ doseQuantity: q(1) }]);
          else expect(member.timing).toEqual({ repeat: daily });
        }
        expect(rows).toEqual(before);
        rows = persist(toFhirR5Dosages(actual));
      }
    });

  it.each(["before", "after"] as const)(
    "retains an annotated source carrier %s a separate live dose row", position => {
      const annotation = { id: "source-sequence", extension: [note, {
        url: "urn:clinic:sequence-detail", extension: [{ url: "reviewer", valueString: "prescriber" }],
      }] };
      const liveAnnotation = { id: "live-sequence", extension: [note] };
      for (const persisted of [false, true]) {
        const source: FhirR6DosageInstruction = {
          id: "mixed-empty-course", renderedInstruction: "Clinician source-only instruction", extension: [note],
        };
        const carrier: FhirDosage = { ...toFhirR5Dosages(source)[0], _sequence: annotation };
        const live: FhirDosage = {
          sequence: 1, _sequence: liveAnnotation,
          doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: daily },
        };
        let rows = position === "before" ? [carrier, live] : [live, carrier];
        if (persisted) rows = persist(rows);
        for (let save = 0; save < 2; save++) {
          const before = structuredClone(rows), actual = toDosageDetails(rows);
          for (const wire of [actual, r6Save(actual)]) {
            expect(wire.extension).toContainEqual(note);
            expect(wire.step).toHaveLength(1);
            expect(wire.step![0].component).toHaveLength(1);
            const member = wire.step![0].component[0];
            expect(member.doseAndRate).toEqual([{ doseQuantity: q(2) }]);
            expect(member.timing).toEqual({ repeat: daily });
            expect(member.extension).toContainEqual({
              url: DOSAGE_RETAINED_R5_SEQUENCE_URL, valueDecimal: 1, _valueDecimal: liveAnnotation,
            });
            expect(retiredSources(wire).filter(item => item.url === "r5SourceCarrier").map(readRetainedField))
              .toContainEqual({ _sequence: annotation });
          }
          expect(rows).toEqual(before);
          rows = persist(toFhirR5Dosages(actual));
        }
      }
    });

  it.each(["unchanged", "annotation", "phase end"] as const)(
    "keeps an implicit pause only with its unchanged member completion (%s)", edit => {
      const source: FhirR6DosageInstruction = { step: [
        { id: "induction", component: [{ id: "initial", doseAndRate: [{ doseQuantity: q(1) }],
          timing: { repeat: daily }, modifierExtension: [encodeR6SourceMetadata(
            PARALLEL_COMPONENT_PHASE_ORIGIN_URL, { end: boundary(1) }, "step")] }] },
        { id: "pause", end: boundary(2), component: [] },
        { id: "resume", component: [{ id: "later", doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: daily } }] },
      ] };
      const baseline = persist(r6Save(source));
      let wire = persist(baseline);
      if (edit === "phase end") wire.step![0].component[0].modifierExtension = [
        encodeR6SourceMetadata(PARALLEL_COMPONENT_PHASE_ORIGIN_URL, { end: boundary(2) }, "step")];
      if (edit === "annotation") wire.step![0].component[0].modifierExtension![0].id = "authored-phase";
      for (let save = 0; save < 2; save++) {
        const before = persist(wire), actual = r6Save(wire);
        expect(fromDosageDetails(actual).course.step?.map(step => step.id)).toEqual(edit === "phase end"
          ? ["induction", "resume"] : ["induction", "pause", "resume"]);
        expect(importCanonicalCourse(actual).stages[0].administrations[0].phaseEnd?.displacement?.value)
          .toBe(edit === "phase end" ? 2 : 1);
        expect(nextDueDoses(actual, { orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-01T00:00:00Z",
          timeZone: "UTC", limit: 3 })).toEqual(edit === "phase end"
          ? ["2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00", "2026-01-03T08:00:00+00:00"]
          : ["2026-01-01T08:00:00+00:00", "2026-01-03T08:00:00+00:00", "2026-01-04T08:00:00+00:00"]);
        if (edit === "phase end") {
          const retired = retiredSources(actual).find(item => item.url === R6_DRAFT_STEPS_SOURCE_URL)!;
          const savedDraft = decodeR6SourceMetadata(retired, "drafts")!;
          expect(savedDraft.drafts).toEqual([{ index: 1, step: { id: "pause", end: boundary(2) } }]);
          expect(savedDraft.synthesizedStarts).toEqual([1]);
          expect(savedDraft.projected).toEqual(baseline.step);
        }
        expect(wire).toEqual(before);
        wire = toDosageDetails(persist(toFhirR5Dosages(actual)));
      }
    });

  it.each([0, undefined, 1] as const)(
    "preserves stated frequency minimum %s beside independently authored clocks", minimum => {
      const clause = canonicalFromFhir({
        doseAndRate: [{ doseQuantity: q(1) }],
        timing: { repeat: {
          ...(minimum === 0 ? { extension: [{ url: TIMING_FREQUENCY_MIN_EXTENSION_URL, valueInteger: 0 }] }
            : minimum !== undefined ? { frequency: minimum } : {}),
          frequencyMax: 2, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00", "20:00:00"],
        } },
      });
      const before = persist(clause), row = canonicalToFhir(clause);
      expect(row.timing!.repeat!.frequency).toBe(minimum === 0 ? undefined : minimum ?? 2);
      expect(canonicalFromFhir(row).schedule?.frequency).toBe(minimum ?? 2);
      expect(row.timing!.repeat!.timeOfDay).toEqual(["08:00:00", "20:00:00"]);
      let wire = toDosageDetails(persist([row]));
      for (let save = 0; save < 2; save++) {
        const recurrence = importCanonicalCourse(wire).stages[0].administrations[0].schedule!.recurrence!;
        expect(recurrence.frequency).toBe(minimum ?? 2);
        expect(recurrence.frequencyMax).toBe(2);
        expect(recurrence.clocks).toEqual(["08:00:00", "20:00:00"]);
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      }
      expect(persist(clause)).toEqual(before);
    });

  it("keeps PRN clock opportunities optional beside an upper frequency", () => {
    const clause = canonicalFromFhir({
      asNeeded: true, doseAndRate: [{ doseQuantity: q(1) }],
      timing: { repeat: { frequencyMax: 2, period: 1, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["08:00:00", "20:00:00"] } },
    });
    const before = persist(clause), row = canonicalToFhir(clause);
    expect(row.asNeeded).toBe(true);
    expect(row.timing!.repeat!.frequency).toBeUndefined();
    expect(row.timing!.repeat!.frequencyMax).toBe(2);
    expect(row.timing!.repeat!.timeOfDay).toEqual(["08:00:00", "20:00:00"]);
    const wire = toDosageDetails(persist([row]));
    for (const input of [wire, persist(toFhirR5Dosages(wire))]) {
      const member = importCanonicalCourse(input).stages[0].administrations[0];
      expect(member.asNeeded).toBe(true);
      expect(member.schedule!.recurrence!.frequency).toBeUndefined();
      expect(member.schedule!.recurrence!.frequencyMax).toBe(2);
      expect(member.schedule!.recurrence!.clocks).toEqual(["08:00:00", "20:00:00"]);
    }
    expect(persist(clause)).toEqual(before);
  });

  it.each(["id", "translation", "dose", "dose and id"] as const)(
    "separates current narrative annotations from clinical edits (%s)", edit => {
      const wording = "Take one tablet daily";
      const translation = { url: "http://hl7.org/fhir/StructureDefinition/translation", extension: [
        { url: "lang", valueCode: "th" }, { url: "content", valueString: "รับประทานหนึ่งเม็ดทุกวัน" },
      ] };
      const source: FhirR6DosageInstruction = { renderedInstruction: wording, step: [{ component: [{
        text: wording, _text: { extension: [translation, note] },
        doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily },
      }] }] };
      let rows = persist(toFhirR5Dosages(source));
      if (edit.includes("id")) rows[0]._text!.id = "current-text-id";
      if (edit === "translation") rows[0]._text!.extension![0].extension![1].valueString = "ข้อความแปลฉบับปัจจุบัน";
      if (edit.startsWith("dose")) rows[0].doseAndRate![0].doseQuantity!.value = 2;
      const currentCompanion = persist(rows[0]._text!);
      for (let save = 0; save < 2; save++) {
        const before = persist(rows), actual = toDosageDetails(rows), member = actual.step![0].component[0];
        expect(member.doseAndRate).toEqual([{ doseQuantity: q(edit.startsWith("dose") ? 2 : 1) }]);
        if (edit.startsWith("dose")) {
          expect(member.text).toBeUndefined();
          expect(member._text).toEqual({ ...(edit.includes("id") ? { id: "current-text-id" } : {}), extension: [note] });
          const sources = retiredSources(actual).filter(item => item.url === DOSAGE_DETAILS_R5_URL);
          expect(sources.map(item => decodeR5RetainedFields(item).component))
            .toContainEqual({ text: wording, _text: currentCompanion });
        } else {
          expect(member.text).toBe(wording);
          expect(member._text).toEqual(currentCompanion);
          expect(actual.renderedInstruction).toBe(wording);
        }
        expect(rows).toEqual(before);
        rows = persist(toFhirR5Dosages(actual));
      }
    });

  it.each([false, true])("reads the saved untagged narrative fingerprint without rewriting its meaning (dose edit=%s)", changed => {
    const wording = "Take one tablet daily";
    const companion = { extension: [{
      url: "http://hl7.org/fhir/StructureDefinition/translation", extension: [
        { url: "lang", valueCode: "th" }, { url: "content", valueString: "รับประทานหนึ่งเม็ดทุกวัน" },
      ],
    }] };
    // Literal persisted output captured from accepted 0c57, before clinical-v2 agreement.
    const legacy: FhirDosage = {
      text: wording, _text: companion, doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily }, sequence: 1,
      extension: [{ url: DOSAGE_RENDERED_INSTRUCTION_R5_URL, extension: [
        { url: "instruction", valueString: wording }, { url: "sourceAgreement", valueBoolean: false },
        { url: "textFingerprint", valueString: "1dae8fd876985d78" },
        { url: "row", extension: [
          { url: "projectionFingerprint", valueString: "b6532ed6b1e44f91" },
          { url: "textFingerprint", valueString: "1dae8fd876985d78" },
        ] },
      ] }],
    };
    expect(dosageProjectionFingerprint(legacy)).toBe("b6532ed6b1e44f91");
    const submitted = persist(legacy);
    if (changed) submitted.doseAndRate![0].doseQuantity!.value = 2;
    const before = persist(submitted), actual = toDosageDetails([submitted]);
    const member = actual.step![0].component[0];
    expect(member.doseAndRate).toEqual([{ doseQuantity: q(changed ? 2 : 1) }]);
    expect(member.text).toBe(changed ? undefined : wording);
    expect(member._text).toEqual(changed ? undefined : companion);
    if (changed) expect(retiredSources(actual).filter(item => item.url === DOSAGE_DETAILS_R5_URL)
      .map(item => decodeR5RetainedFields(item).component)).toContainEqual({ text: wording, _text: companion });
    expect(submitted).toEqual(before);
  });

  it("types and preserves nested R6 extension quantities without allowing approximate R5 quantities", () => {
    const opaque: FhirR6DosageInstruction = { extension: [{ url: "urn:clinic:r6-quantity", extension: [
      { url: "duration", valueQuantity: { value: 30, unit: "min", comparator: "~", _value: { id: "duration-value" } } },
    ] }], step: [{ component: [{ doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } }] }] };
    const invalidR5: FhirExtension = {
      url: "urn:clinic:r5-quantity",
      // @ts-expect-error R5 general Quantity has no approximate comparator.
      valueQuantity: { value: 30, unit: "min", comparator: "~" },
    };
    void invalidR5;
    const before = persist(opaque), actual = r6Save(opaque);
    expect(actual.extension).toEqual(opaque.extension);
    expect(opaque).toEqual(before);
  });
});


describe("round61 supported interchange ownership", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] };
  const note = { url: "urn:clinic:round61-note", valueString: "Keep complete authored metadata" };
  const boundary = (value: number) => ({
    contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] },
    offsetDuration: { value, unit: "d" },
  });
  const retired = (wire: FhirR6DosageInstruction): FhirR6Extension[] => {
    const sources: FhirR6Extension[] = [];
    for (const marker of wire.extension ?? [])
      if (marker.url === DOSAGE_RECONCILIATION_SOURCE_URL) sources.push(...(marker.extension ?? []));
    return sources;
  };
  const qualifier = { url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
    valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000053" } };

  it.each(["scalar origin", "typed start"] as const)(
    "keeps current %s authority over a dependent pause", kind => {
      for (const edit of ["unchanged", "dose", "annotation", "origin"] as const) {
        const origin = kind === "scalar origin"
          ? { url: PARALLEL_COMPONENT_PHASE_ORIGIN_URL, valueQuantity: { value: 0, unit: "d" } }
          : encodeR6SourceMetadata(PARALLEL_COMPONENT_PHASE_ORIGIN_URL, { start: boundary(0) }, "step");
        const source: FhirR6DosageInstruction = { step: [
          { id: "induction", component: [{ id: "initial", doseAndRate: [{ doseQuantity: q(1) }],
            timing: { repeat: { ...daily, boundsDuration: { value: 1, unit: "d" } } }, modifierExtension: [origin] }] },
          { id: "pause", end: boundary(2), extension: [note], component: [] },
          { id: "maintenance", component: [{ id: "later", doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: daily } }] },
        ] };
        let wire = persist(r6Save(source));
        const originalDraft = persist(wire.extension!.find(marker => marker.url === R6_DRAFT_STEPS_SOURCE_URL)!);
        const member = wire.step![0].component[0], marker = member.modifierExtension![0];
        if (edit === "dose") member.doseAndRate![0].doseQuantity!.value = 3;
        if (edit === "annotation") marker.id = "authored-member-origin";
        if (edit === "origin") {
          if (kind === "scalar origin") marker.valueQuantity!.value = 1;
          else member.modifierExtension = [encodeR6SourceMetadata(
            PARALLEL_COMPONENT_PHASE_ORIGIN_URL, { start: boundary(1) }, "step")];
        }
        for (let save = 0; save < 2; save++) {
          const before = persist(wire), actual = r6Save(wire);
          const due = nextDueDoses(actual, { orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-01T00:00:00Z",
            timeZone: "UTC", limit: 3 });
          expect(due).toEqual(edit === "origin"
            ? ["2026-01-02T08:00:00+00:00", "2026-01-03T08:00:00+00:00", "2026-01-04T08:00:00+00:00"]
            : ["2026-01-01T08:00:00+00:00", "2026-01-03T08:00:00+00:00", "2026-01-04T08:00:00+00:00"]);
          expect(fromDosageDetails(actual).course.step?.map(step => step.id)).toEqual(edit === "origin"
            ? ["induction", "maintenance"] : ["induction", "pause", "maintenance"]);
          expect(actual.step![0].component[0].doseAndRate![0].doseQuantity).toEqual(q(edit === "dose" ? 3 : 1));
          if (edit === "origin") expect(retired(actual)).toContainEqual(originalDraft);
          else expect(fromDosageDetails(actual).course.step?.find(step => step.id === "pause")?.extension).toEqual([note]);
          expect(wire).toEqual(before);
          wire = toDosageDetails(persist(toFhirR5Dosages(actual)));
        }
      }
    });

  it.each(["unchanged", "replace", "remove"] as const)(
    "retains the qualified Ratio source after a %s edit", edit => {
      const ratio: FhirRatio = {
        id: "original-ratio", extension: [note],
        numerator: { id: "carrier", value: 100, unit: "mL", _value: { id: "authored-carrier" } },
        denominator: { id: "duration", value: 2, unit: "h", extension: [note, qualifier] },
      };
      const source: FhirR6DosageInstruction = { step: [{ component: [{
        doseAndRate: [{ id: "dose", doseQuantity: { value: 100, unit: "mL" } }, { id: "rate", rateRatio: ratio }],
      }] }] };
      let rows = persist(toFhirR5Dosages(source));
      if (edit === "replace") rows[0].doseAndRate![1] = { id: "rate", rateQuantity: { value: 8, unit: "mL/h" } };
      if (edit === "remove") rows[0].doseAndRate = [rows[0].doseAndRate![0]];
      for (let save = 0; save < 2; save++) {
        const before = persist(rows), actual = toDosageDetails(rows), amounts = actual.step![0].component[0].doseAndRate!;
        expect(amounts[0].doseQuantity).toEqual({ value: 100, unit: "mL" });
        if (edit === "unchanged") expect(amounts[1].rateRatio).toEqual(ratio);
        else {
          expect(amounts.some(amount => amount.rateRatio)).toBe(false);
          expect(amounts[1]?.rateQuantity).toEqual(edit === "replace" ? { value: 8, unit: "mL/h" } : undefined);
          const ratios: Array<NonNullable<FhirR6Dosage["doseAndRate"]>[number]["rateRatio"]> = [];
          for (const marker of retired(actual))
            if (marker.url === DOSAGE_DETAILS_R5_URL)
              for (const entry of decodeR5RetainedFields(marker).component?.doseAndRate ?? []) ratios.push(entry.rateRatio);
          expect(ratios).toContainEqual(ratio);
        }
        expect(rows).toEqual(before);
        rows = persist(toFhirR5Dosages(actual));
      }
    });

  it.each(["groupId", "branchId", "selectionBehavior"] as const)(
    "adds a valued %s without losing its annotation-only source", field => {
      const child: FhirExtension = { id: "authored-choice-field", url: field, extension: [note] };
      const original: FhirExtension = { id: "choice-source", url: DOSAGE_ALTERNATIVE_CHOICE_URL, extension: [
        field === "groupId" ? child : { url: "groupId", valueString: "regimen" },
        field === "branchId" ? child : { url: "branchId", valueString: "first" },
        field === "selectionBehavior" ? child : { url: "selectionBehavior", valueCode: "exactly-one" },
      ] };
      const row: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }], modifierExtension: [persist(original)] };
      setDosageAlternativeChoice(row, { groupId: "regimen", branchId: "second", selectionBehavior: "exactly-one" });
      const active = row.modifierExtension![0].extension!.find(item => item.url === field)!;
      expect(active.extension).toBeUndefined();
      expect(field === "selectionBehavior" ? active.valueCode : active.valueString)
        .toBe(field === "selectionBehavior" ? "exactly-one" : field === "groupId" ? "regimen" : "second");
      expect(active.id).toBe(child.id);
      expect(row.extension?.find(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL)?.extension).toContainEqual(original);
      const reopened = toDosageDetails(persist(toFhirR5Dosages([row])));
      expect(reopened.step![0].component[0].doseAndRate![0].doseQuantity).toEqual(q(1));
      expect(JSON.stringify(reopened)).toContain(note.valueString);
    });

  it.each(["local", "UCUM", "uncoded"] as const)(
    "infers a self-carrier duration only from recognized %s units", kind => {
      const ratio: FhirRatio = { numerator: { value: 100, unit: "mL" },
        denominator: { value: 2, unit: kind === "local" ? "half-hour blocks" : "h",
          ...(kind === "uncoded" ? {} : { system: kind === "local" ? "urn:clinic:time-block" : "http://unitsofmeasure.org", code: "h" }),
          extension: [note, qualifier] } };
      let wire: FhirR6DosageInstruction = { step: [{ component: [{
        doseAndRate: [{ doseQuantity: { value: 100, unit: "mL" }, rateRatio: ratio }],
      }] }] };
      for (let save = 0; save < 2; save++) {
        const before = persist(wire), native = importCanonicalCourse(wire), member = native.stages[0].administrations[0];
        expect(member.schedule?.recurrence?.occurrenceDuration).toBe(kind === "local" ? undefined : 2);
        expect(member.schedule?.recurrence?.occurrenceDurationUnit).toBe(kind === "local" ? undefined : FhirPeriodUnit.Hour);
        const actual = r6Save(wire);
        expect(actual.step![0].component[0].doseAndRate![0].rateRatio).toEqual(ratio);
        expect(actual.step![0].component[0].doseAndRate![0].doseQuantity).toEqual({ value: 100, unit: "mL" });
        expect(wire).toEqual(before);
        wire = toDosageDetails(persist(toFhirR5Dosages(actual)));
      }
    });

  it("keeps a sequence companion and lifted safety on their R5 member", () => {
    const annotation = { id: "authored-sequence", extension: [note] };
    const safety = { doseLimit: [{ scope: "administration" as const, valueQuantity: { value: 2, unit: "drop" } }] };
    const row: EzDosage = { _sequence: annotation, safety };
    const before = persist(row), native = importCanonicalCourse(row);
    expect(native.stages).toHaveLength(1);
    expect(native.stages[0].administrations).toHaveLength(1);
    expect(native.safety?.limits).toBeUndefined();
    const wire = projectCanonicalCourse(native).fhirNext;
    expect(wire.step![0].component[0].extension).toContainEqual({
      url: DOSAGE_RETAINED_R5_SEQUENCE_URL, _valueDecimal: annotation,
    });
    const reopened = toDosageDetails(persist(toFhirR5Dosages(wire)));
    expect(reopened.step![0].component[0].extension).toContainEqual({
      url: DOSAGE_RETAINED_R5_SEQUENCE_URL, valueDecimal: 1, _valueDecimal: annotation,
    });
    expect(reopened.step![0].component[0].safety).toEqual(safety);
    expect(importCanonicalCourse({ safety }).stages).toHaveLength(0);
    expect(courseFromR6({ safety }, true).stages).toHaveLength(0);
    expect(row).toEqual(before);
  });

  it.each([false, true])("preserves opaque target Coding fields with translations=%s", translated => {
    const metadata = { clinic: "eye service", flags: ["review"] };
    const target = { code: "129004000", clinicMetadata: metadata,
      ...(translated ? { i18n: { th: "ตา" } } : {}) };
    const actual = cloneBodySiteSpatialRelation({ relationText: "around", targetCoding: target })!;
    expect(actual.targetCoding).toEqual(target);
    expect(actual.targetCoding).not.toBe(target);
    expect((actual.targetCoding as typeof target).clinicMetadata).toBe(metadata);
    if (translated) expect(actual.targetCoding!.i18n).not.toBe(target.i18n);
  });

  it.each([false, true])("preserves unfamiliar site-wrapper fields with an ID=%s", identified => {
    const site = { concept: { text: "left eye" }, clinicNote: "verify at follow-up", ...(identified ? { id: "site-wrapper" } : {}) };
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }], site,
    }] }] };
    let rows = persist(toFhirR5Dosages(source));
    for (let save = 0; save < 2; save++) {
      const before = persist(rows), actual = toDosageDetails(rows);
      expect(actual.step![0].component[0].site).toEqual(site);
      expect(actual.step![0].component[0].doseAndRate![0].doseQuantity).toEqual({ value: 1, unit: "drop" });
      expect(rows).toEqual(before);
      rows = persist(toFhirR5Dosages(actual));
    }
    const plain: FhirR6DosageInstruction = { step: [{ component: [{ site: { concept: { text: "left eye" } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }] }] }] };
    expect(toFhirR5Dosages(plain)[0].modifierExtension?.some(marker => marker.url === DOSAGE_DETAILS_R5_URL) ?? false).toBe(false);
  });

  it("accepts native R6 Quantity qualifiers on component extension slots", () => {
    const extension: FhirR6Extension = { url: "urn:clinic:quantity", valueQuantity: { value: 5, unit: "mg", comparator: "~" } };
    const nativeNestedValues: FhirR6Extension[] = [
      { url: "urn:clinic:concept", valueCodeableConcept: { extension: [extension] } },
      { url: "urn:clinic:coding", valueCoding: { code: "dose", _code: { extension: [extension] } } },
      { url: "urn:clinic:range", valueRange: { low: { value: 1, extension: [extension] } } },
      { url: "urn:clinic:expression", valueExpression: { expression: "%weight", extension: [extension] } }
    ];
    void nativeNestedValues;
    const component: FhirR6Dosage = {
      extension: [extension], modifierExtension: [{ ...extension, url: "urn:clinic:modifier-quantity" }],
      doseAndRate: [{ doseQuantity: q(1) }],
    };
    // @ts-expect-error R5 Quantity does not accept the native R6 approximate comparator.
    const r5Only: FhirExtension = { url: "urn:clinic:quantity", valueQuantity: { value: 5, comparator: "~" } };
    void r5Only;
    const actual = r6Save({ step: [{ component: [component] }] });
    expect(actual.step![0].component[0].extension).toEqual(component.extension);
    expect(actual.step![0].component[0].modifierExtension).toEqual(component.modifierExtension);
    expect(actual.step![0].component[0].doseAndRate![0].doseQuantity).toEqual(q(1));
  });
});


describe("round62 reviewed interchange ownership", () => {
  const note: FhirExtension = { url: "urn:clinic:annotation", valueString: "retain-independent-note" };
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] };
  const member = (id: string, value: number) => ({ id, doseAndRate: [{ doseQuantity: q(value) }],
    timing: { repeat: { ...daily } } });

  it.each([false, true])("keeps a retained sequence companion with its original phase (moved=%s)", moved => {
    const annotation = { id: "sequence-owner", extension: [note] };
    const source: FhirDosage[] = [{ sequence: 0, _sequence: annotation, doseAndRate: [{ doseQuantity: q(1) }] }];
    const wire = persist(toDosageDetails(source));
    if (moved) wire.step!.unshift({ component: [member("new-first", 3)] });
    const before = persist(wire);
    let rows = persist(toFhirR5Dosages(wire));
    for (let save = 0; save < 2; save++) {
      const row = rows.find(item => item.doseAndRate?.[0].doseQuantity?.value === 1)!;
      expect(row.sequence).toBe(moved ? 2 : 0);
      expect(row._sequence).toEqual(moved ? undefined : annotation);
      const retained = { url: DOSAGE_RETAINED_R5_SEQUENCE_URL, valueDecimal: 0, _valueDecimal: annotation };
      if (moved && save > 0) {
        expect(row.extension!.find(item => item.url === DOSAGE_RETAINED_R5_SEQUENCE_URL)).toBeUndefined();
        expect(row.extension!.find(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL)!.extension).toContainEqual(retained);
      } else expect(row.extension!.find(item => item.url === DOSAGE_RETAINED_R5_SEQUENCE_URL)).toEqual(retained);
      expect(row.doseAndRate).toEqual([{ doseQuantity: q(1) }]);
      rows = persist(toFhirR5Dosages(toDosageDetails(rows)));
    }
    expect(wire).toEqual(before);
    expect(source[0]._sequence).toEqual(annotation);
  });

  it.each([
    { text: "left ear canal", code: "89644007", expected: "left ear canal" },
    { text: "right ear canal", code: "25577004", expected: "right ear canal" },
    { text: "left ear canal", code: "25577004", expected: "right ear" },
  ])("keeps compatible authored canal detail for $text and code $code", ({ text, code, expected }) => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 2, unit: "drop" } }],
      site: { text, _text: { id: "site-label", extension: [note] },
        coding: [{ system: "http://snomed.info/sct", code, _code: { extension: [note] } }] } };
    const before = persist(row);
    for (const input of [row, persist(row), persist(toDosageDetails([row]))]) {
      expect(formatSig(input, "short", { locale: "en" })).toBe("2 drop in the " + expected);
      expect(formatSig(input, "long", { locale: "en" })).toBe("Use 2 drops in the " + expected + ".");
    }
    const saved = toFhirR5Dosages(persist(toDosageDetails([row])))[0];
    expect(saved.site).toEqual(before.site);
    expect(saved.doseAndRate).toEqual(before.doseAndRate);
    expect(row).toEqual(before);
  });

  it.each(["fresh", "persisted"] as const)("checks detached clocked source replay through %s rows and saves", kind => {
    const parsed = parseSig("Swallow 1 tablet slowly with water at 08:00 and swallow 2 tablets slowly with water at 20:00");
    expect(parsed.fhir).toHaveLength(2);
    const row = kind === "fresh" ? structuredClone(parsed.fhir[1]) : persist(parsed.fhir[1]);
    const original = persist(row);
    const options = { locale: "en", realizationMode: "roundtrip" as const };
    expect(dosageMatchesSavedProjection(row)).toBe(true);
    expect(formatSig(row, "long", options)).toBe("swallow 2 tablets slowly with water at 20:00");
    const unchangedSaved = persist(toFhirR5Dosages([row]))[0];
    expect(formatSig(unchangedSaved, "long", options)).toBe("swallow 2 tablets slowly with water at 20:00");
    let current = persist(row);
    current.timing!.repeat!.timeOfDay = ["22:00:00"];
    for (let save = 0; save < 2; save++) {
      const before = persist(current);
      expect(dosageMatchesSavedProjection(current)).toBe(false);
      if (save > 0) expect(getDosageSourceTextAgreement(current, false)).toBe(false);
      for (const locale of ["en", "th"] as const) {
        const localized = { ...options, locale };
        const imported = fromFhirDosage(current, localized);
        for (const preview of [formatSig(current, "long", localized), imported.longText]) {
          expect(preview.match(locale === "en" ? /\b2 tablets\b/gu : /\b2 เม็ด/gu)).toHaveLength(1);
          if (locale === "th") expect(preview).not.toContain("tablets");
          expect(preview).toMatch(/22:00|10:00 pm/u);
          expect(preview).not.toMatch(/20:00|8:00 pm/u);
          expect(preview).toContain("slowly");
          expect(preview).toContain(locale === "en" ? "water" : "น้ำ");
        }
        expect(imported.fhir).toEqual(before);
      }
      expect(current.timing!.repeat!.timeOfDay).toEqual(["22:00:00"]);
      expect(current.doseAndRate![0].doseQuantity!.value).toBe(2);
      expect(current).toEqual(before);
      expect(JSON.stringify(current)).toContain("swallow 2 tablets slowly with water at 20:00");
      current = persist(toFhirR5Dosages([current]))[0];
    }
    expect(row).toEqual(original);
  });

  // Complete detached second row exported by parseSig at 3699b99, before
  // clocked rows carried their own clinical projection fingerprint.
  const historicalClockRow: FhirDosage = {
    "extension": [
      {
        "url": "urn:ezmedicationinput:StructureDefinition:medication-instruction-graph",
        "extension": [
          {"url": "sourceText", "valueString": "swallow 2 tablets slowly with water at 20:00"},
          {"url": "sourceLocale", "valueCode": "en"},
          {"url": "primaryAdministrationStart", "valueInteger": 0},
          {"url": "primaryAdministrationEnd", "valueInteger": 7},
          {
            "url": "action",
            "extension": [
              {"url": "sequenceIndex", "valueInteger": 0},
              {"url": "force", "valueCode": "sequence"},
              {
                "url": "relationCoding",
                "valueCoding": {"system": "http://snomed.info/sct", "code": "421463005", "display": "With - dosing instruction fragment"}
              },
              {"url": "predicateLemma", "valueString": "swallow"},
              {"url": "predicateDisplay", "valueString": "Swallow"},
              {"url": "semanticClass", "valueString": "ingest"},
              {
                "url": "predicateTranslation",
                "extension": [{"url": "locale", "valueCode": "th"}, {"url": "text", "valueString": "กลืน"}]
              },
              {
                "url": "predicateCoding",
                "valueCoding": {"system": "http://snomed.info/sct", "code": "738995006", "display": "Swallow"}
              },
              {
                "url": "predicateCoding",
                "valueCoding": {
                  "system": "http://snomed.info/sct",
                  "code": "421521009",
                  "display": "Swallow - dosing instruction imperative"
                }
              },
              {"url": "spanStart", "valueInteger": 0},
              {"url": "spanEnd", "valueInteger": 44},
              {"url": "sourceText", "valueString": "swallow 2 tablets slowly with water at 20:00"},
              {
                "url": "argument",
                "extension": [
                  {"url": "role", "valueCode": "object"},
                  {"url": "text", "valueString": "2 tablets slowly"},
                  {"url": "normalized", "valueString": "2 tablets slowly"}
                ]
              },
              {
                "url": "argument",
                "extension": [
                  {"url": "role", "valueCode": "substance"},
                  {
                    "url": "relationCoding",
                    "valueCoding": {"system": "http://snomed.info/sct", "code": "421463005", "display": "With - dosing instruction fragment"}
                  },
                  {"url": "text", "valueString": "water"},
                  {"url": "normalized", "valueString": "water"},
                  {"url": "conceptId", "valueString": "water"},
                  {
                    "url": "coding",
                    "valueCoding": {"system": "http://snomed.info/sct", "code": "11713004", "display": "Water"}
                  },
                  {
                    "url": "argumentCoding",
                    "valueCoding": {"system": "http://snomed.info/sct", "code": "11713004", "display": "Water"}
                  },
                  {
                    "url": "translation",
                    "extension": [{"url": "locale", "valueCode": "en"}, {"url": "text", "valueString": "water"}]
                  },
                  {
                    "url": "translation",
                    "extension": [{"url": "locale", "valueCode": "th"}, {"url": "text", "valueString": "น้ำ"}]
                  }
                ]
              },
              {
                "url": "argument",
                "extension": [
                  {"url": "role", "valueCode": "time"},
                  {
                    "url": "relationCoding",
                    "valueCoding": {"system": "http://snomed.info/sct", "code": "420862001", "display": "On"}
                  },
                  {"url": "text", "valueString": "20:00"},
                  {"url": "normalized", "valueString": "20:00:00"},
                  {"url": "spanStart", "valueInteger": 39},
                  {"url": "spanEnd", "valueInteger": 44}
                ]
              },
              {
                "url": "argument",
                "extension": [
                  {"url": "role", "valueCode": "amount"},
                  {"url": "text", "valueString": "2 tablets"},
                  {"url": "normalized", "valueString": "tab"},
                  {"url": "spanStart", "valueInteger": 8},
                  {"url": "spanEnd", "valueInteger": 17},
                  {
                    "url": "quantity",
                    "extension": [{"url": "value", "valueDecimal": 2}, {"url": "unit", "valueString": "tab"}]
                  }
                ]
              }
            ]
          },
          {
            "url": "coverage",
            "extension": [
              {"url": "understoodCharacters", "valueInteger": 44},
              {"url": "opaqueCharacters", "valueInteger": 0},
              {"url": "ratio", "valueDecimal": 1},
              {"url": "complete", "valueBoolean": true}
            ]
          }
        ]
      },
      {
        "url": "urn:ezmedicationinput:StructureDefinition:medication-rendered-instruction",
        "extension": [
          {"url": "sourceAgreement", "valueBoolean": true},
          {"url": "textFingerprint", "valueString": "2c1b7585d11b2d37"},
          {"url": "sourceHasStructuredClocks", "valueBoolean": true},
          {"url": "sourceHasStructuredEvents", "valueBoolean": false},
          {"url": "sourceHasStructuredSite", "valueBoolean": false}
        ]
      }
    ],
    "route": {"text": "by mouth", "coding": [{"system": "http://snomed.info/sct", "code": "26643006", "display": "Oral route"}]},
    "method": {
      "text": "Swallow",
      "_text": {
        "extension": [
          {
            "url": "http://hl7.org/fhir/StructureDefinition/translation",
            "extension": [{"url": "lang", "valueCode": "th"}, {"url": "content", "valueString": "กลืน"}]
          }
        ]
      },
      "coding": [
        {
          "system": "http://snomed.info/sct",
          "code": "738995006",
          "display": "Swallow",
          "_display": {
            "extension": [
              {
                "url": "http://hl7.org/fhir/StructureDefinition/translation",
                "extension": [{"url": "lang", "valueCode": "th"}, {"url": "content", "valueString": "รับประทาน"}]
              }
            ]
          }
        }
      ]
    },
    "timing": {"repeat": {"timeOfDay": ["20:00:00"]}},
    "doseAndRate": [{"doseQuantity": {"value": 2, "unit": "tab", "system": "http://standardterms.edqm.eu", "code": "15054000"}}],
    "text": "Swallow 2 tablets slowly on 20:00:00 with water at 8:00 pm."
  };

  it.each(["20:00:00", "22:00:00"])("uses current %s clocks from a historical detached R5 row", clock => {
    const submitted = persist(historicalClockRow);
    const clockAnnotation = { id: "current-clock", extension: [{ url: "https://example.test/clock-note", valueString: "retain clock note" }] };
    const rowAnnotation = { url: "https://example.test/row-note", valueString: "retain row note" };
    submitted.timing!.repeat!.timeOfDay = [clock];
    submitted.timing!.repeat!._timeOfDay = [clockAnnotation];
    submitted.extension!.push(rowAnnotation);
    const original = persist(submitted);
    const originalGraph = original.extension![0];
    const expectedClock = clock === "20:00:00" ? /20:00|8:00 pm/u : /22:00|10:00 pm/u;
    const otherClock = clock === "20:00:00" ? /22:00|10:00 pm/u : /20:00|8:00 pm/u;
    let current = submitted;
    for (let save = 0; save < 3; save++) {
      const before = persist(current);
      expect(dosageMatchesSavedProjection(current)).toBe(false);
      if (save > 0) expect(getDosageSourceTextAgreement(current, false)).toBe(false);
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        const options = { locale: "en", realizationMode };
        const imported = fromFhirDosage(current, options);
        for (const preview of [formatSig(current, "long", options), imported.longText]) {
          const active = preview.split("; original directions:")[0];
          expect(active).toMatch(/\b2 tablets\b/u);
          expect(active).toMatch(expectedClock);
          expect(active).not.toMatch(otherClock);
          expect(active).toContain("slowly");
          expect(active).toContain("water");
        }
        expect(imported.fhir).toEqual(before);
      }
      expect(current.timing!.repeat!.timeOfDay).toEqual([clock]);
      expect(current.timing!.repeat!._timeOfDay).toEqual([clockAnnotation]);
      expect(current.doseAndRate).toEqual([{
        doseQuantity: { value: 2, unit: "tab", system: "http://standardterms.edqm.eu", code: "15054000" }
      }]);
      expect(current.extension).toContainEqual(originalGraph);
      expect(current.extension).toContainEqual(rowAnnotation);
      expect(current).toEqual(before);
      current = save === 0
        ? persist(toFhirR5Dosages([current]))[0]
        : persist(toFhirR5Dosages(persist(toDosageDetails([current]))))[0];
    }
    expect(submitted).toEqual(original);
  });

  it("keeps an independent numeric member origin after its predecessor is removed", () => {
    const source: FhirR6DosageInstruction = { step: [
      { id: "loading", component: [{ ...member("first", 1), timing: { repeat: { ...daily, count: 1 } } }] },
      { id: "independent", component: [{ ...member("later", 2), timing: { repeat: { ...daily, count: 2 } },
        modifierExtension: [{ url: PARALLEL_COMPONENT_PHASE_ORIGIN_URL, valueQuantity: { value: 7, unit: "d" } }] }] }
    ] };
    let rows = persist(toFhirR5Dosages(source).slice(1));
    const options = { orderedAt: "2026-11-21T00:00:00Z", from: "2026-11-21T00:00:00Z", timeZone: "UTC", limit: 3 };
    for (let save = 0; save < 2; save++) {
      const before = persist(rows), native = importCanonicalCourse(rows);
      expect(native.contextIssue).toBeUndefined();
      const active = native.stages.map(stage => stage.administrations).reduce((all, rows) => all.concat(rows), []);
      expect(active).toHaveLength(1);
      expect(active[0].phaseOrigin).toEqual({ value: 7, unit: "d" });
      expect(active[0].amounts![0].quantity).toEqual(q(2));
      expect(nextDueDoses(rows, options)).toEqual(["2026-11-28T08:00:00+00:00", "2026-11-29T08:00:00+00:00"]);
      expect(calculateTotalUnits({ ...options, dosage: rows, durationValue: 14,
        durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(4);
      expect(rows).toEqual(before);
      rows = persist(toFhirR5Dosages(toDosageDetails(rows)));
    }
  });

  it("starts an independent zero-origin member after an empty retained predecessor", () => {
    const source: FhirR6DosageInstruction = { step: [
      { id: "loading", component: [{ ...member("first", 1), timing: { repeat: { ...daily, count: 1 } } }] },
      { id: "independent", component: [{ ...member("later", 2), timing: { repeat: { ...daily, count: 2 } },
        modifierExtension: [{ url: PARALLEL_COMPONENT_PHASE_ORIGIN_URL, valueQuantity: { value: 0, unit: "d" } }] }] }
    ] };
    let rows = persist(toFhirR5Dosages(source).slice(1));
    const options = { orderedAt: "2026-11-21T00:00:00Z", from: "2026-11-21T00:00:00Z", timeZone: "UTC", limit: 3 };
    for (let save = 0; save < 2; save++) {
      const native = importCanonicalCourse(rows);
      expect(native.contextIssue).toBeUndefined();
      expect(native.stages.map(stage => stage.administrations.length)).toEqual([0, 1]);
      expect(native.stages[1].administrations[0].phaseOrigin).toEqual({ value: 0, unit: "d" });
      expect(native.stages[1].administrations[0].amounts![0].quantity).toEqual(q(2));
      for (const input of [native, rows, persist(toDosageDetails(rows))]) {
        const before = persist(input);
        expect(nextDueDoses(input, options)).toEqual(["2026-11-21T08:00:00+00:00", "2026-11-22T08:00:00+00:00"]);
        expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 14,
          durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(4);
        expect(input).toEqual(before);
      }
      rows = persist(toFhirR5Dosages(toDosageDetails(rows)));
    }
  });

  it.each([0, 7])("executes an independent %sd origin after two retained empty stages", offset => {
    const independent = { ...member("independent-member", 2), timing: { repeat: { ...daily, count: 2 } },
      extension: [note],
      modifierExtension: [{ url: PARALLEL_COMPONENT_PHASE_ORIGIN_URL, valueQuantity: { value: offset, unit: "d" } }] };
    const source: FhirR6DosageInstruction = { step: [
      { id: "previous-first", component: [{ ...member("previous-first-member", 1), timing: { repeat: { ...daily, count: 1 } } }] },
      { id: "previous-second", component: [{ ...member("previous-second-member", 1), timing: { repeat: { ...daily, count: 1 } } }] },
      { id: "independent", component: [independent] }
    ] };
    let rows = persist(toFhirR5Dosages(source).slice(2));
    const options = { orderedAt: "2026-11-21T00:00:00Z", from: "2026-11-21T00:00:00Z", timeZone: "UTC", limit: 3 };
    const expected = offset === 0
      ? ["2026-11-21T08:00:00+00:00", "2026-11-22T08:00:00+00:00"]
      : ["2026-11-28T08:00:00+00:00", "2026-11-29T08:00:00+00:00"];
    for (let save = 0; save < 2; save++) {
      const native = importCanonicalCourse(rows);
      expect(native.contextIssue).toBeUndefined();
      expect(native.stages.map(stage => stage.administrations.length)).toEqual([0, 0, 1]);
      expect(rows[0].extension).toContainEqual(note);
      expect(native.stages[2].administrations[0].phaseOrigin).toEqual({ value: offset, unit: "d" });
      expect(native.stages[2].administrations[0].amounts![0].quantity).toEqual(q(2));
      for (const input of [native, rows, persist(toDosageDetails(rows)), [persist(independent)]]) {
        const before = persist(input);
        expect(nextDueDoses(input, options)).toEqual(expected);
        expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 14,
          durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(4);
        expect(input).toEqual(before);
      }
      rows = persist(toFhirR5Dosages(toDosageDetails(rows)));
    }
  });

  it("accepts native Ratio and Timing values in R6 extensions while R5 remains strict", () => {
    const ratio: FhirR6Extension = { url: "urn:clinic:ratio",
      valueRatio: { numerator: { value: 2, unit: "mg", comparator: "~" }, denominator: { value: 1, unit: "mL" } } };
    const timing: FhirR6Extension = { url: "urn:clinic:timing",
      valueTiming: { repeat: { ...daily, startOffset: { value: 2, unit: "h" }, endOffset: { value: 4, unit: "h" } } } };
    // @ts-expect-error R5 Extension Ratio numerator does not accept the R6 approximate comparator.
    const strictRatio: FhirExtension = { url: "urn:clinic:ratio", valueRatio: { numerator: { value: 2, comparator: "~" } } };
    // @ts-expect-error R5 Timing repeat does not expose native R6 period offsets.
    const strictTiming: FhirExtension = { url: "urn:clinic:timing", valueTiming: { repeat: { startOffset: { value: 2, unit: "h" } } } };
    void strictRatio; void strictTiming;
    const nativeSite: FhirR6Dosage = { site: { extension: [{ url: "urn:clinic:site-quantity", valueQuantity: { value: 2, comparator: "~" } }] } };
    // @ts-expect-error R5 site extensions retain strict R5 Quantity comparators.
    const strictSite: FhirDosage = { site: { extension: [{ url: "urn:clinic:site-quantity", valueQuantity: { value: 2, comparator: "~" } }] } };
    void nativeSite; void strictSite;
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: q(1) }], extension: [ratio, timing]
    }] }] };
    const before = persist(source), actual = projectCanonicalCourse(importCanonicalCourse(source)).fhirNext;
    expect(actual.step![0].component[0].extension).toEqual([ratio, timing]);
    expect(actual.step![0].component[0].doseAndRate).toEqual([{ doseQuantity: q(1) }]);
    expect(source).toEqual(before);
  });

  it.each(["~", undefined] as const)("projects a native concentration annotation with comparator %s to strict R5", comparator => {
    const annotation: FhirR6Extension = { id: "concentration-annotation", url: "urn:clinic:concentration", valueRatio: {
      id: "concentration", extension: [{ url: "urn:clinic:ratio-note", valueString: "authored concentration" }],
      numerator: { id: "concentration-mass", value: 2, unit: "mg", ...(comparator ? { comparator } : {}) },
      denominator: { id: "concentration-volume", value: 1, unit: "mL" },
    } };
    const source: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: [{
      doseQuantity: { value: 1, unit: "mL", extension: [annotation] },
    }] }] }] };
    const before = persist(source), rows = toFhirR5Dosages(source);
    const projected = rows[0].doseAndRate![0].doseQuantity!.extension!.find(item => item.url === annotation.url)!;
    expect(projected.id).toBe(annotation.id);
    expect(projected.valueRatio).toMatchObject({ id: "concentration", extension: annotation.valueRatio!.extension,
      numerator: { id: "concentration-mass", value: 2, unit: "mg" }, denominator: annotation.valueRatio!.denominator });
    expect(projected.valueRatio!.numerator!.comparator).toBeUndefined();
    expect(getQuantityComparator(projected.valueRatio!.numerator)).toBe(comparator);
    if (!comparator) expect(projected).toEqual(annotation);
    expect(toDosageDetails(rows).step![0].component[0].doseAndRate![0].doseQuantity!.extension).toEqual([annotation]);
    expect(source).toEqual(before);
  });

  const quantityNode = (graph: FhirExtension): FhirExtension => {
    for (const action of graph.extension ?? [])
      for (const argument of action.extension ?? []) {
        const quantity = argument.url === "argument" && argument.extension?.find(field => field.url === "quantity");
        if (quantity) return quantity;
      }
    throw new Error("Complete measurement graph has no quantity");
  };

  it.each(["value", "low", "high", "unit"] as const)("retains recognized graph quantity %s annotations beside the current value", field => {
    const graph = parseSig("Measure 100 mL of water").meta.canonical.clauses[0].instructionGraph!;
    const wire = buildInstructionGraphExtension(graph)!;
    const amount = quantityNode(wire);
    if (field === "low" || field === "high") {
      amount.extension = amount.extension!.filter(child => child.url !== "value");
      amount.extension.unshift({ url: "low", valueDecimal: 100 }, { url: "high", valueDecimal: 200 });
    }
    const child = amount.extension!.find(part => part.url === field)!;
    const metadata = { id: field + "-primitive", extension: [note] };
    child.id = field + "-owner";
    Object.assign(child, field === "unit" ? { _valueString: metadata } : { _valueDecimal: metadata });
    amount.extension!.push({ url: "urn:clinic:quantity-note", valueString: "retain-quantity-note" });
    const before = persist(wire), parsed = parseInstructionGraphExtension([wire])!;
    const rebuilt = buildInstructionGraphExtension(parsed)!;
    expect(quantityNode(rebuilt).extension).toContainEqual(child);
    expect(quantityNode(rebuilt).extension).toContainEqual({ url: "urn:clinic:quantity-note", valueString: "retain-quantity-note" });
    const edited = structuredClone(parsed);
    const quantity = edited.actions.map(action => action.args).reduce((all, args) => all.concat(args), [])
      .find(argument => argument.quantity)!.quantity!;
    if (field === "value") quantity.value = 200;
    if (field === "low") quantity.range!.low = 150;
    if (field === "high") quantity.range!.high = 300;
    if (field === "unit") { quantity.value = 0.1; quantity.unit = "L"; }
    const current = buildInstructionGraphExtension(edited)!;
    const expected = { ...child, ...(field === "unit" ? { valueString: "L" }
      : { valueDecimal: field === "value" ? 200 : field === "low" ? 150 : 300 }) };
    expect(quantityNode(current).extension).toContainEqual(expected);
    const reopened = parseInstructionGraphExtension([current])!;
    const actual = reopened.actions.map(action => action.args).reduce((all, args) => all.concat(args), [])
      .find(argument => argument.quantity)!.quantity!;
    if (field === "value") expect(actual.value).toBe(200);
    if (field === "low") expect(actual.range).toEqual({ low: 150, high: 200 });
    if (field === "high") expect(actual.range).toEqual({ low: 100, high: 300 });
    if (field === "unit") expect(actual).toMatchObject({ value: 0.1, unit: "L" });
    expect(wire).toEqual(before);
  });
});


describe("round64 preserved R5 list and replacement ownership", () => {
  it("does not revive an expression-only dose after the saved slot is replaced by a rate", () => {
    const source = course({ doseAndRate: [{ doseExpression: expression("authoredDose") }] });
    const rows = persist(toFhirR5Dosages(source));
    expect(rows[0].doseAndRate![0].extension?.some(item => item.url === R5_EXPRESSION_SLOT_SOURCE_URL)).toBe(true);
    expect(toDosageDetails(rows).step![0].component[0].doseAndRate![0].doseExpression).toEqual(expression("authoredDose"));
    const replacement: FhirDosage = { ...rows[0], doseAndRate: [{ rateQuantity: { value: 5, unit: "mL/h" } }] };
    const reopened = toDosageDetails([replacement]);
    expect(reopened.step![0].component[0].doseAndRate![0].doseExpression).toBeUndefined();
    expect(reopened.step![0].component[0].doseAndRate![0].rateQuantity).toEqual({ value: 5, unit: "mL/h" });
    expect(JSON.stringify(reopened)).toContain("%authoredDose");
    const withRate = persist(toFhirR5Dosages(course({ doseAndRate: [{
      doseExpression: expression("independentDose"), rateQuantity: { value: 5, unit: "mL/h" }
    }] })));
    const changedRate: FhirDosage = { ...withRate[0], doseAndRate: [{ ...withRate[0].doseAndRate![0], rateQuantity: { value: 7, unit: "mL/h" } }] };
    expect(toDosageDetails([changedRate]).step![0].component[0].doseAndRate![0].doseExpression).toEqual(expression("independentDose"));
  });

  it("keeps annotation-only period maxima in their authored array positions", () => {
    const first = { id: "first", numerator: q(4), denominator: { value: 1, unit: "d" } };
    const note = { id: "annotation-only", extension: [{ url: "urn:example:maximum-note", valueString: "source only" }] };
    const last = { id: "last", numerator: q(2), denominator: { value: 8, unit: "h" } };
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }], maxDosePerPeriod: [first, note, last] };
    const reopened = toDosageDetails(persist([row]));
    expect(toFhirR5Dosages(reopened)[0].maxDosePerPeriod).toEqual([first, note, last]);
  });

  it.each([false, true])("keeps an unchanged step modifier wrapper before unrelated extensions (annotated %s)", annotated => {
    const wrapper = { ...(annotated ? { id: "authored-wrapper" } : {}), url: "urn:ezmedicationinput:StructureDefinition:r5-step-modifier-extensions",
      extension: [{ url: "urn:example:step-modifier", valueString: "retain" }] };
    const unrelated = { url: "urn:example:step-note", valueString: "after wrapper" };
    const source: FhirR6DosageInstruction = { step: [{ extension: [wrapper, unrelated], component: [{ doseAndRate: [{ doseQuantity: q(1) }] }] }] };
    const reopened = toDosageDetails(persist(toFhirR5Dosages(source)));
    expect(reopened.step![0].extension).toEqual([wrapper, unrelated]);
  });
});


describe("round66 interchange review corrections", () => {
  const contextCode = { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] };
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] };

  it.each([false, true])("retains current source-carrier text beside a live dose (annotated=%s)", annotated => {
    const source: FhirR6DosageInstruction = { renderedInstruction: "Call clinic for dose" };
    const carrier = persist(toFhirR5Dosages(source)[0]);
    carrier.text = "Confirm dose with clinic before use";
    if (annotated) carrier._text = { id: "current-source-text" };
    let rows: FhirDosage[] = [carrier, { doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: daily } }];
    for (let save = 0; save < 2; save++) {
      const before = persist(rows), wire = toDosageDetails(rows);
      expect(wire.step).toHaveLength(1);
      expect(wire.step![0].component).toHaveLength(1);
      expect(wire.step![0].component[0].doseAndRate).toEqual([{ doseQuantity: q(2) }]);
      expect(wire.step![0].component[0].text).toBeUndefined();
      const sources: unknown[] = [];
      for (const marker of wire.extension ?? []) if (marker.url === DOSAGE_RECONCILIATION_SOURCE_URL)
        for (const item of marker.extension ?? []) if (item.url === "r5SourceCarrier") sources.push(readRetainedField(item));
      expect(sources).toContainEqual({ text: carrier.text, ...(annotated ? { _text: carrier._text } : {}) });
      expect(rows).toEqual(before);
      rows = persist(toFhirR5Dosages(wire));
    }
  });

  it.each(["condition", "annotation"] as const)("retires only a completion-changing condition's outgoing pause (%s)", edit => {
    const source: FhirR6DosageInstruction = { step: [
      { id: "induction", component: [{ id: "initial", doseAndRate: [{ doseQuantity: q(1) }],
        timing: { repeat: { ...daily, count: 2 } }, condition: [conditionToR6({ kind: "measurement",
          name: "glucose", operation: "gt", value: 85, unit: "mg/dL", text: "Glucose above threshold" })] }] },
      { id: "pause", end: { contextCode, offsetDuration: { value: 2, unit: "d" } }, component: [] },
      { id: "maintenance", start: { contextCode, offsetDuration: { value: 3, unit: "d" } }, component: [{
        id: "later", doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: daily } }] },
    ] };
    let wire = persist(r6Save(source));
    const condition = wire.step![0].component[0].condition![0];
    if (edit === "condition") condition.valueQuantity!.value = 95;
    else condition.extension = [{ url: "urn:clinic:condition-note", valueString: "reviewed" }];
    for (let save = 0; save < 2; save++) {
      const before = persist(wire);
      expect(fromDosageDetails(wire).course.step?.map(step => step.id)).toEqual(edit === "condition"
        ? ["induction", "maintenance"] : ["induction", "pause", "maintenance"]);
      expect(nextDueDoses(wire, { orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-01T00:00:00Z",
        timeZone: "UTC", limit: 4, evaluateCondition: (condition, at) => condition.kind !== "measurement" ||
          (at.startsWith("2026-01-02") ? 90 : 100) > condition.value })).toEqual([
        "2026-01-01T09:00:00+00:00", edit === "condition" ? "2026-01-03T09:00:00+00:00" : "2026-01-02T09:00:00+00:00",
        "2026-01-04T09:00:00+00:00", "2026-01-05T09:00:00+00:00",
      ]);
      expect(wire).toEqual(before);
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
    }
  });

  it.each(["left nostril", "left naris", "right nostril", "right naris"])(
    "keeps authored %s specificity with a generic Naris code", text => {
      const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "spray" } }],
        site: { text, coding: [{ system: "http://snomed.info/sct", code: "1797002", display: "Naris" }] } };
      const before = persist(row);
      for (const input of [row, toDosageDetails([row])]) expect(formatSig(input, "long")).toContain(text);
      expect(row).toEqual(before);
      const changed = persist(row);
      changed.site!.coding![0] = { system: "http://snomed.info/sct", code: "723609004", display: "Structure of right anterior naris" };
      expect(formatSig(changed, "long")).toContain("right");
      expect(changed.site!.text).toBe(text);
    });

  it("accepts native approximate Quantity extensions on R6 dosage conditions", () => {
    const extension: FhirR6Extension = { url: "urn:clinic:threshold", valueQuantity: { value: 90, comparator: "~", unit: "mg/dL" } };
    const condition: FhirR6DosageCondition = { code: { text: "glucose" }, extension: [extension],
      valueQuantity: { value: 90, comparator: "~", unit: "mg/dL" } };
    // @ts-expect-error R5 Element extensions retain strict R5 Quantity comparators.
    const strict: FhirElement = { extension: [{ url: "urn:clinic:threshold", valueQuantity: { value: 90, comparator: "~" } }] };
    void strict;
    const source = course({ condition: [condition] });
    expect(r6Save(source).step![0].component[0].condition).toEqual([condition]);
    expect(toDosageDetails(persist(toFhirR5Dosages(source))).step![0].component[0].condition).toEqual([condition]);
  });

  it("retains complete spatial target Coding through the public parse-clone-build path", () => {
    const url = "urn:ezmedicationinput:body-site-spatial-relation";
    const target = { id: "authored-knee", system: "http://snomed.info/sct", code: "82169009", display: "Left knee",
      version: "20260131", _display: { extension: [{ url: "urn:clinic:display-note", valueString: "retain" }] },
      extension: [{ url: "urn:clinic:coding-note", valueBoolean: true }], clinicMetadata: { service: "wound care" } };
    const source: FhirExtension = { url, extension: [
      { url: "relationText", valueString: "below" },
      { url: "target", valueCodeableConcept: { text: "left knee", coding: [target] } },
    ] };
    const before = persist(source);
    const parsed = parseBodySiteSpatialRelationExtension({ extension: [source] })!;
    expect(parsed.targetCoding).toEqual(target);
    const cloned = cloneBodySiteSpatialRelation(parsed)!;
    expect(buildBodySiteSpatialRelationExtension(cloned)).toEqual(source);
    expect(buildBodySiteSpatialRelationExtension({ relationText: "below", targetText: "left knee", targetCoding: target })).toEqual(source);
    const { system: _system, ...unqualified } = target;
    expect(buildBodySiteSpatialRelationExtension({ relationText: "below", targetCoding: unqualified })!.extension![1]
      .valueCodeableConcept!.coding).toEqual([target]);
    expect(buildBodySiteSpatialRelationExtension({ relationText: "below", targetCoding: { code: "82169009" } })!.extension![1]
      .valueCodeableConcept!.coding).toEqual([{ system: "http://snomed.info/sct", code: "82169009" }]);
    expect(source).toEqual(before);
  });
});


describe("round67 native R6 Element extension typing", () => {
  it("retains native Quantity extensions on steps, boundaries and safety wrappers", () => {
    const measure: FhirR6Extension = { url: "urn:clinic:measured-margin", valueQuantity: {
      id: "authored-margin", value: 2, comparator: "~", unit: "mg",
      _value: { extension: [{ url: "urn:clinic:measurement-note", valueString: "authored approximation" }] },
    } };
    const note: FhirR6Extension = { url: "urn:clinic:unknown-policy-note", extension: [
      { url: "reviewer", valueString: "prescriber" }, { url: "reviewed", valueBoolean: true },
    ] };
    const limit: FhirR6DoseLimit = { id: "daily-limit", scope: "period", valueQuantity: q(3),
      period: { value: 1, unit: "d" }, extension: [measure, note] };
    const safety: FhirR6DosageSafety = { id: "step-safety", extension: [measure, note],
      modifierExtension: [measure], doseLimit: [limit] };
    const start: FhirR6RelativeTime = { id: "start", contextCode: { coding: [
      { system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" },
    ] }, offsetDuration: { value: 1, unit: "d" }, extension: [measure, note], modifierExtension: [measure] };
    const step: FhirR6DosageStep = { id: "initial", start, safety, extension: [measure, note],
      component: [{ doseAndRate: [{ doseQuantity: q(1) }] }] };
    // @ts-expect-error Strict R5 Element extensions do not accept the R6 approximate comparator.
    const strictR5: FhirElement = { extension: [measure] };
    void strictR5;
    const source: FhirR6DosageInstruction = { step: [step, { id: "later",
      component: [{ doseAndRate: [{ doseQuantity: q(2) }] }] }] };
    const before = persist(source);
    let wire = r6Save(source);
    for (let save = 0; save < 2; save++) {
      expect(wire.step![0].extension).toEqual([measure, note]);
      expect(wire.step![0].start).toEqual(start);
      expect(wire.step![0].safety).toEqual(safety);
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
    }
    expect(source).toEqual(before);
  });
});


describe("round68 current interchange ownership", () => {
  const boundary = (value: number) => ({ contextCode: { coding: [
    { system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" },
  ] }, offsetDuration: { value, unit: "d" } });
  const member = () => ({ id: "dose", doseAndRate: [{ doseQuantity: q(1) }],
    timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } } });

  it.each(["boundary id", "quantity annotation", "boundary value"] as const)(
    "restores an opening pause only with an unchanged clinical start (%s)", edit => {
      let wire = persist(r6Save({ step: [
        { id: "pause", end: boundary(2), component: [] }, { id: "receiver", component: [member()] },
      ] }));
      if (edit === "boundary id") wire.step![0].start!.id = "submitted-start";
      else if (edit === "quantity annotation") wire.step![0].start!.offsetDuration!._value = { id: "submitted-offset" };
      else wire.step![0].start!.offsetDuration!.value = 3;
      const submittedStart = persist(wire.step![0].start);
      for (let save = 0; save < 2; save++) {
        const before = persist(wire), view = fromDosageDetails(wire);
        expect(view.course.step?.map(step => step.id)).toEqual(edit === "boundary value" ? ["receiver"] : ["pause", "receiver"]);
        const receiver = view.course.step!.find(step => step.id === "receiver")!;
        if (edit === "boundary value") expect(receiver.start).toEqual(submittedStart);
        else {
          expect(receiver.start).toBeUndefined();
          const starts: unknown[] = [];
          for (const marker of receiver.extension ?? []) if (marker.url === DOSAGE_RECONCILIATION_SOURCE_URL)
            for (const child of marker.extension ?? []) starts.push(decodeR6SourceMetadata(child, "step")?.start);
          expect(starts).toContainEqual(submittedStart);
        }
        expect(wire).toEqual(before);
        wire = toDosageDetails(persist(view.dosages), undefined, persist(view.course));
      }
    });

  it.each([false, true])("keeps an explicitly changed header response at course scope (%s)", changed => {
    const courseSafety: FhirR6DosageSafety = { doseLimit: [{ id: "course-limit", scope: "period",
      valueQuantity: q(10), period: { value: 1, unit: "d" } }], ifExceeded: "course response" };
    const stepSafety: FhirR6DosageSafety = { doseLimit: [{ id: "phase-limit", scope: "administration", valueQuantity: q(2) }],
      ifExceeded: "phase response" };
    let wire = persist(r6Save({ safety: courseSafety, step: [{ id: "phase", safety: stepSafety, component: [member()] }] }));
    if (changed) wire.safety!.ifExceeded = "phase response";
    for (let save = 0; save < 2; save++) {
      const before = persist(wire), view = fromDosageDetails(wire);
      expect(view.course.safety).toEqual({ ...courseSafety, ifExceeded: changed ? "phase response" : "course response" });
      expect(view.course.step![0].safety).toEqual(stepSafety);
      expect(wire).toEqual(before);
      wire = toDosageDetails(persist(view.dosages), undefined, persist(view.course));
    }
  });

  it("accepts and retains native R6 annotations on a site Reference", () => {
    const extension: FhirR6Extension = { url: "urn:clinic:site-size", valueQuantity: { value: 2, comparator: "~", unit: "cm2" } };
    const input: FhirR6Dosage = { ...member(), site: { reference: { reference: "BodyStructure/left-arm", display: "left arm",
      extension: [extension] } } };
    // @ts-expect-error R5 Reference extensions retain strict R5 Quantity comparators.
    const strict: FhirReference = { extension: [extension] };
    void strict;
    const source = course(input), before = persist(source);
    const wire = r6Save(source);
    expect(wire.step![0].component[0].site).toEqual(input.site);
    expect(toDosageDetails(persist(toFhirR5Dosages(wire))).step![0].component[0].site).toEqual(input.site);
    expect(source).toEqual(before);
  });

  it.each(["low", "high"] as const)("shows a unitless %s course-length bound in both public R5 previews", endpoint => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: {
      frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, boundsRange: { [endpoint]: { value: 3 } },
    } } };
    const before = persist(row);
    for (const text of [formatSig(row, "long", { locale: "en" }), fromFhirDosage(row, { locale: "en" }).longText]) {
      expect(text).toContain(endpoint === "high" ? "up to 3" : "at least 3");
      expect(text).not.toMatch(/3 (?:days?|weeks?|months?|hours?)/u);
    }
    expect(toDosageDetails([row]).step![0].component[0].timing!.repeat!.boundsRange).toEqual({ [endpoint]: { value: 3 } });
    expect(row).toEqual(before);
  });

  it("archives a cleared annotated cycle count without restoring it", () => {
    const slot: FhirExtension & { _valueInteger?: FhirElement } = { id: "authored-cycles", url: "cycles", valueInteger: 3,
      _valueInteger: { extension: [{ url: "urn:clinic:count-note", valueString: "retain" }] } };
    const unknown = { url: "urn:clinic:cycle-note", valueString: "independent" };
    const previous: FhirExtension = { url: CYCLE_DAY_ELIGIBILITY_EXTENSION_URL, extension: [
      { url: "day", valueInteger: 1 }, { url: "periodDays", valueInteger: 7 }, slot, unknown,
    ] };
    const before = persist(previous);
    const marker = cycleDayConstraintExtension({ days: [1], periodDays: 7, reason: "unresolved-cycle-eligibility", sourceText: "" }, previous);
    expect(marker.extension!.filter(child => child.url === "cycles")).toEqual([]);
    expect(marker.extension).toContainEqual({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [slot] });
    expect(marker.extension).toContainEqual(unknown);
    let rows: FhirDosage[] = [{ ...member(), modifierExtension: [marker] }];
    for (let save = 0; save < 2; save++) {
      expect(getCycleDayConstraint(rows[0])?.cycles).toBeUndefined();
      const wire = toDosageDetails(persist(rows));
      expect(wire.step![0].component[0].modifierExtension).toContainEqual(marker);
      rows = persist(toFhirR5Dosages(wire));
    }
    expect(previous).toEqual(before);
  });

  it.each([false, true])("keeps an annotation-only clock bridge beside its event anchor (valued=%s)", valued => {
    const when = { id: "event-annotation", extension: [{ url: "urn:clinic:event", valueString: "retain event" }] };
    const bridge = { url: TIMING_ADDITIONAL_CLOCK_EXTENSION_URL, _valueTime: {
      id: "clock-annotation", extension: [{ url: "urn:clinic:clock", valueString: "retain clock" }],
    } };
    const source = course({ ...member(), timing: { repeat: {
      ...(valued ? { when: [EventTiming.Morning] } : {}), _when: [when], extension: [bridge],
    } } });
    const before = persist(source);
    let wire = r6Save(source);
    for (let save = 0; save < 2; save++) {
      const repeat = wire.step![0].component[0].timing!.repeat!;
      expect(repeat.timeOfDay).toBeUndefined();
      expect(repeat._timeOfDay).toBeUndefined();
      expect(repeat._when).toEqual([when]);
      expect(repeat.extension).toContainEqual(bridge);
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
    }
    expect(source).toEqual(before);
  });
});


describe("round68 live R5 expression carrier", () => {
  it.each(["doseExpression", "rateExpression"] as const)("reads the current %s owner through fresh saves", field => {
    const original = { language: "text/fhirpath", expression: "%patient.weight" };
    const replacement = { language: "text/fhirpath", expression: "%patient.weight * 2" };
    const lifted = { language: "text/fhirpath", expression: "%patient.weight * 3" };
    const note: FhirExtension = { url: "urn:clinic:slot-note", valueString: "keep current slot annotation" };
    for (const edit of ["unchanged", "replace", "remove", "lifted"] as const) {
      const source = course({ doseAndRate: [field === "doseExpression" ? { doseExpression: original } : { rateExpression: original }] });
      let rows: EzDosage[] = persist(toFhirR5Dosages(source));
      const entry = rows[0].doseAndRate![0];
      const slot = entry.extension!.find(item => item.url === R5_EXPRESSION_SLOT_SOURCE_URL)!;
      slot.id = "current-expression-slot";
      slot.extension!.push({ url: "urn:clinic:expression-note", valueString: "retain carrier metadata" });
      (entry.extension ??= []).push(note);
      if (edit === "replace" || edit === "lifted") slot.extension!.find(item => item.url === field)!.valueExpression = replacement;
      if (edit === "remove") entry.extension = entry.extension!.filter(item => item.url !== R5_EXPRESSION_SLOT_SOURCE_URL);
      if (edit === "lifted") entry[field] = lifted;
      const expected = edit === "unchanged" ? original : edit === "replace" ? replacement : edit === "lifted" ? lifted : undefined;
      for (let save = 0; save < 2; save++) {
        const before = persist(rows), wire = toDosageDetails(rows);
        const actual = wire.step![0].component[0].doseAndRate![0];
        expect(actual[field], edit + " save " + save).toEqual(expected);
        expect(actual.extension).toContainEqual(note);
        if (edit !== "remove") expect(actual.extension?.reduce<FhirR6Extension[]>((all, item) =>
          all.concat(item.url === DOSAGE_RECONCILIATION_SOURCE_URL ? item.extension ?? [] : [item]), []
        )).toContainEqual(slot);
        expect(rows).toEqual(before);
        rows = persist(toFhirR5Dosages(wire));
      }
    }
  });
});


describe("round70 current interchange annotations and limits", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] };
  const note: FhirExtension = { url: "urn:clinic:source-note", valueString: "retain supplied metadata" };

  it("keeps both nasal targets under an unqualified Naris code", () => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "spray" } }],
      site: { text: "both nostrils", coding: [{ system: "http://snomed.info/sct", code: "1797002", display: "Naris" }] },
      timing: { repeat: daily } };
    const before = persist(row), wire = toDosageDetails([row]);
    for (const input of [row, wire, persist(toFhirR5Dosages(wire))]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toMatch(/\b(?:both nostrils|each nostril)\b/);
      expect(calculateTotalUnits({ dosage: input, orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-01T00:00:00Z", timeZone: "UTC",
        durationValue: 1, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(2);
    }
    const changed = persist(row);
    changed.site!.coding![0] = { system: "http://snomed.info/sct", code: "723609004", display: "Structure of right anterior naris" };
    expect(formatSig(changed, "long", { locale: "en" })).toContain("right");
    expect(calculateTotalUnits({ dosage: changed, orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-01T00:00:00Z", timeZone: "UTC",
      durationValue: 1, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(1);
    expect(changed.site!.text).toBe("both nostrils");
    expect(row).toEqual(before);
    expect(wire.step![0].component[0].site?.concept).toEqual(row.site);
  });

  it.each(["clear amount", "clear period", "remove"] as const)("keeps the current period maximum after %s", edit => {
    const source = course({ safety: { doseLimit: [{ id: "daily-max", scope: "period", valueQuantity: q(4),
      period: { value: 1, unit: "d" }, extension: [note] }] } });
    let rows = persist(toFhirR5Dosages(source));
    const ratio = rows[0].maxDosePerPeriod![0];
    if (edit === "remove") delete rows[0].maxDosePerPeriod;
    else {
      const endpoint = edit === "clear amount" ? ratio.numerator! : ratio.denominator!;
      delete endpoint.value;
      endpoint._value = { id: "unentered-value", extension: [{
        url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown",
      }] };
    }
    const expected = persist(ratio);
    for (let save = 0; save < 2; save++) {
      const before = persist(rows), wire = toDosageDetails(rows);
      const limits = wire.step![0].component[0].safety?.doseLimit;
      if (edit === "remove") expect(limits ?? []).toEqual([]);
      else expect(limits).toEqual([{ id: "daily-max", scope: "period", valueQuantity: expected.numerator,
        period: expected.denominator, extension: [note] }]);
      expect(rows).toEqual(before);
      rows = persist(toFhirR5Dosages(wire));
      expect(rows[0].maxDosePerPeriod).toEqual(edit === "remove" ? undefined : [expected]);
    }
  });

  it.each(["annotation", "timestamp"] as const)("uses valued events to own the pause after an event %s edit", edit => {
    let wire = r6Save({ step: [
      { id: "induction", component: [{ id: "initial", doseAndRate: [{ doseQuantity: q(1) }],
        timing: { event: ["2026-01-01T09:00:00Z", "2026-01-02T09:00:00Z"] } }] },
      { id: "pause", end: { contextCode: { coding: [{
        system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start",
      }] }, offsetDuration: { value: 14, unit: "d" } }, component: [] },
      { id: "resume", component: [{ id: "later", doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: daily } }] },
    ] });
    wire = persist(wire);
    const timing = wire.step![0].component[0].timing!;
    timing.event!.push(null);
    timing._event = [null, null, { id: "event-position", extension: [note] }];
    if (edit === "timestamp") timing.event![1] = "2026-01-03T09:00:00Z";
    const expectedTiming = persist(timing);
    for (let save = 0; save < 2; save++) {
      const before = persist(wire), editable = fromDosageDetails(wire);
      expect(editable.course.step!.map(step => step.id)).toEqual(edit === "annotation"
        ? ["induction", "pause", "resume"] : ["induction", "resume"]);
      expect(wire.step![0].component[0].timing).toEqual(expectedTiming);
      expect(wire).toEqual(before);
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
    }
  });

  it.each([false, true])("retains a qualified rate denominator without a false edit warning (edited %s)", edited => {
    const source = course({ doseAndRate: [{ rateRatio: {
      numerator: { value: 100, unit: "mL" },
      denominator: simpleQuantityForR5({ value: 2, unit: "h", comparator: "~", extension: [note] }),
    } }] });
    let rows = persist(toFhirR5Dosages(source));
    if (edited) rows[0].doseAndRate![0].rateRatio!.denominator!.value = 3;
    for (let save = 0; save < 2; save++) {
      const before = persist(rows), wire = toDosageDetails(rows);
      const denominator = wire.step![0].component[0].doseAndRate![0].rateRatio!.denominator!;
      expect(denominator.value).toBe(edited ? 3 : 2);
      expect(getQuantityComparator(denominator)).toBe("~");
      expect(denominator.extension).toContainEqual(note);
      if (!edited) expect((wire.extension ?? []).filter(item => item.url === DOSAGE_RECONCILIATION_WARNING_URL &&
        item.valueString?.includes("superseded"))).toEqual([]);
      expect(rows).toEqual(before);
      rows = persist(toFhirR5Dosages(wire));
    }
  });

  it("accepts R6 Quantity extensions on dose-and-rate entries without loosening scalar doses", () => {
    const extension: FhirR6Extension = { url: "urn:clinic:rate-note", valueQuantity: { value: 2, comparator: "~", unit: "h" } };
    const entry: FhirR6DoseAndRate = { rateQuantity: { value: 2, unit: "mL/h" }, extension: [extension] };
    // @ts-expect-error R5 extension Quantity still excludes the R6 approximation comparator.
    const r5: FhirDoseAndRate = { extension: [{ url: "urn:clinic:rate-note", valueQuantity: { comparator: "~" } }] };
    // @ts-expect-error R6 scalar doses remain SimpleQuantity.
    const scalar: FhirR6DoseAndRate = { doseQuantity: { value: 2, comparator: "~" } };
    void r5; void scalar;
    const wire = toDosageDetails(persist(toFhirR5Dosages(course({ doseAndRate: [entry] }))));
    expect(wire.step![0].component[0].doseAndRate![0].extension).toContainEqual(extension);
  });

  it("keeps annotations on a recognized argument component through the public codec", () => {
    const graph = parseSig("Apply ointment then cover with occlusive dressing").meta.canonical.clauses[0].instructionGraph!;
    const original = buildInstructionGraphExtension(graph)!;
    const qualifier = (marker: FhirExtension) => {
      const action = marker.extension!.find(item => item.url === "action" &&
        item.extension?.some(field => field.url === "predicateLemma" && field.valueString === "cover"))!;
      const argument = action.extension!.find(item => item.url === "argument" &&
        item.extension?.some(field => field.url === "conceptId" && field.valueString === "occlusive_dressing"))!;
      return argument.extension!.find(item => item.url === "component" &&
        item.extension?.some(field => field.url === "role" && field.valueCode === "qualifier"))!;
    };
    expect(qualifier(buildInstructionGraphExtension(parseInstructionGraphExtension([original])!)!)).toEqual(qualifier(original));
    const annotated = persist(original), component = qualifier(annotated);
    component.id = "dressing-qualifier";
    component.extension!.push(note);
    const before = persist(annotated);
    let current = annotated;
    for (let save = 0; save < 2; save++) {
      current = buildInstructionGraphExtension(parseInstructionGraphExtension([persist(current)])!)!;
      expect(qualifier(current)).toEqual(component);
    }
    expect(annotated).toEqual(before);
  });
});


describe("round70 source-less native timing projection", () => {
  const note: FhirExtension = { url: "urn:clinic:recurrence-note", valueString: "retain independently supplied metadata" };

  it.each([undefined, 3])("projects explicit month days and ordinal %s without source dosage", weekdayOrdinal => {
    const native: CanonicalCourse = { kind: "course", stages: [{ administrations: [{
      kind: "administration", amounts: [{ quantity: { value: 1, unit: "tab" } }], schedule: { recurrence: {
        period: 1, periodUnit: FhirPeriodUnit.Month, monthDays: [15], weekdayOrdinal,
        dayOfWeek: [FhirDayOfWeek.Monday, FhirDayOfWeek.Tuesday, FhirDayOfWeek.Wednesday, FhirDayOfWeek.Thursday, FhirDayOfWeek.Friday],
        clocks: ["09:00:00"], provenance: { extension: [note] },
      } },
    }] }] };
    const before = persist(native), projected = projectCanonicalCourse(native);
    for (const row of [projected.fhir[0], projected.fhirNext.step![0].component[0]]) {
      expect(getTimingMonthDays(row.timing?.repeat)).toEqual([15]);
      expect(getTimingWeekdayOrdinal(row.timing?.repeat)).toBe(weekdayOrdinal);
      expect(getTimingClocks(row.timing?.repeat)).toEqual(["09:00:00"]);
      expect(row.timing?.repeat?.extension).toContainEqual(note);
    }
    expect(native).toEqual(before);
  });

  it("projects an explicit-event occurrence cap with its current count", () => {
    const events = ["2026-01-01T10:00:00Z", "2026-01-02T10:00:00Z"];
    const cap = { max: 1, period: 1, periodUnit: FhirPeriodUnit.Day };
    const native: CanonicalCourse = { kind: "course", stages: [{ administrations: [{
      kind: "administration", amounts: [{ quantity: { value: 1, unit: "tab" } }],
      schedule: { explicitEvents: events, recurrence: { count: 1, occurrenceCap: cap, provenance: { extension: [note] } } },
    }] }] };
    const before = persist(native), projected = projectCanonicalCourse(native);
    for (const row of [projected.fhir[0], projected.fhirNext.step![0].component[0]]) {
      expect(row.timing?.event).toEqual(events);
      expect(row.timing?.repeat?.count).toBe(1);
      expect(getTimingOccurrenceCap(row.timing?.repeat)).toEqual(cap);
      expect(row.timing?.repeat?.extension).toContainEqual(note);
    }
    expect(native).toEqual(before);
  });
});

describe("round71 recognized graph component annotations", () => {
  it.each([false, true])("retains field annotations and unknown Coding data (coding child ID %s)", codingChildId => {
    const parsed = parseSig("Apply ointment then cover with occlusive dressing");
    const marker = buildInstructionGraphExtension(parsed.meta.canonical.clauses[0].instructionGraph!)!;
    const component = (wire: FhirExtension) => {
      const action = wire.extension!.find(item => item.url === "action" &&
        item.extension?.some(field => field.url === "predicateLemma" && field.valueString === "cover"))!;
      const argument = action.extension!.find(item => item.url === "argument" &&
        item.extension?.some(field => field.url === "conceptId" && field.valueString === "occlusive_dressing"))!;
      return argument.extension!.find(item => item.url === "component" &&
        item.extension?.some(field => field.url === "role" && field.valueCode === "head"))!;
    };
    const note: FhirExtension = { url: "urn:clinic:component-note", valueString: "retain authored annotations" };
    const head = component(marker), role = head.extension!.find(item => item.url === "role")!,
      text = head.extension!.find(item => item.url === "text")!, coding = head.extension!.find(item => item.url === "coding")!;
    role.id = "role-element";
    role._valueCode = { id: "role-value", extension: [note] };
    text.id = "text-element";
    text._valueString = { id: "text-value", extension: [note] };
    if (codingChildId) coding.id = "coding-element";
    Object.assign(coding.valueCoding!, { id: "coding-value", extension: [note], clinicSource: { revision: "authored" } });
    const before = persist(marker), expected = persist(head);
    let current = marker;
    for (let save = 0; save < 2; save++) {
      const supplied = persist(current), suppliedBefore = persist(supplied);
      const decoded = parseInstructionGraphExtension([supplied])!;
      const decodedBefore = persist(decoded);
      current = buildInstructionGraphExtension(decoded)!;
      expect(component(current)).toEqual(expected);
      expect(supplied).toEqual(suppliedBefore);
      expect(decoded).toEqual(decodedBefore);
    }
    const row = persist(parsed.fhir[0]);
    row.extension = [...(row.extension ?? []).filter(item => item.url !== marker.url), marker];
    const rowBefore = persist(row), wire = toDosageDetails([row]);
    const saved = toFhirR5Dosages(persist(wire));
    const savedMarker = saved[0].extension!.find(item => item.url === marker.url)!;
    expect(component(savedMarker)).toEqual(expected);
    expect(row).toEqual(rowBefore);

    const decoded = parseInstructionGraphExtension([persist(marker)])!, edited = persist(decoded);
    const editedComponent = edited.actions.find(action => action.predicate.lemma === "cover")!.args
      .find(argument => argument.conceptId === "occlusive_dressing")!.components!.find(item => item.role === "head")!;
    delete editedComponent.coding;
    const editedBefore = persist(edited);
    current = buildInstructionGraphExtension(edited)!;
    for (let save = 0; save < 2; save++) {
      const fields = component(current).extension!;
      expect(fields.find(item => item.url === "coding")).toBeUndefined();
      expect(fields.find(item => item.url === "sourceCoding")).toEqual({ ...coding, url: "sourceCoding" });
      const fresh = parseInstructionGraphExtension([persist(current)])!;
      expect(fresh.actions.find(action => action.predicate.lemma === "cover")!.args
        .find(argument => argument.conceptId === "occlusive_dressing")!.components!.find(item => item.role === "head")!.coding).toBeUndefined();
      current = buildInstructionGraphExtension(fresh)!;
    }
    expect(edited).toEqual(editedBefore);
    expect(decoded.actions.find(action => action.predicate.lemma === "cover")!.args
      .find(argument => argument.conceptId === "occlusive_dressing")!.components!.find(item => item.role === "head")!.coding).toEqual(coding.valueCoding);
    expect(marker).toEqual(before);
  });
});

describe("round71 predicate component annotations", () => {
  it.each(["code", "display", "clear display"])("retains source annotations while a fresh typed Coding %s edit stays active", edit => {
    const parsed = parseSig("Rub cream gently");
    const marker = buildInstructionGraphExtension(parsed.meta.canonical.clauses[0].instructionGraph!)!;
    const component = (wire: FhirExtension) => wire.extension!.find(item => item.url === "action")!
      .extension!.find(item => item.url === "predicateComponent")!;
    const part = component(marker), role = part.extension!.find(item => item.url === "role")!,
      coding = part.extension!.find(item => item.url === "coding")!;
    const note: FhirExtension = { url: "urn:clinic:mechanism-note", valueString: "retain the authored annotation" };
    part.id = "friction-component";
    role.id = "mechanism-role";
    role._valueCode = { id: "mechanism-value", extension: [note] };
    coding.id = "friction-coding";
    Object.assign(coding.valueCoding!, { id: "friction-source", extension: [note], clinicSource: { revision: "authored" } });
    part.extension!.push(note);
    const before = persist(marker), expected = persist(part);
    let current = marker;
    for (let save = 0; save < 2; save++) {
      current = buildInstructionGraphExtension(parseInstructionGraphExtension([persist(current)])!)!;
      expect(component(current)).toEqual(expected);
    }
    const row = persist(parsed.fhir[0]);
    row.extension = [...(row.extension ?? []).filter(item => item.url !== marker.url), marker];
    const rowBefore = persist(row), wire = toDosageDetails([row]);
    const saved = toFhirR5Dosages(persist(wire));
    expect(component(saved[0].extension!.find(item => item.url === marker.url)!)).toEqual(expected);
    expect(row).toEqual(rowBefore);

    const decoded = parseInstructionGraphExtension([persist(marker)])!, edited = persist(decoded);
    const previous = coding.valueCoding!;
    const replacement = edit === "code"
      ? { system: "https://example.org/clinic/mechanisms", code: "gentle-rubbing", display: "Gentle rubbing" }
      : { system: previous.system, code: previous.code,
          ...(previous.version === undefined ? {} : { version: previous.version }),
          ...(edit === "display" ? { display: "Current friction label" } : {}) };
    edited.actions[0].predicate.semanticComponents![0].coding = replacement;
    const editedBefore = persist(edited);
    current = buildInstructionGraphExtension(edited)!;
    for (let save = 0; save < 2; save++) {
      const fields = component(current).extension!;
      expect(fields.filter(item => item.url === "sourceCoding")).toEqual([{ ...coding, url: "sourceCoding" }]);
      expect(fields.filter(item => item.url === "coding")).toEqual([{ url: "coding", valueCoding: replacement }]);
      expect(fields).toContainEqual(role);
      expect(fields).toContainEqual(note);
      const fresh = parseInstructionGraphExtension([persist(current)])!;
      expect(fresh.actions[0].predicate.semanticComponents![0].coding).toEqual(replacement);
      current = buildInstructionGraphExtension(fresh)!;
    }
    expect(edited).toEqual(editedBefore);
    expect(decoded.actions[0].predicate.semanticComponents![0].coding).toEqual(coding.valueCoding);
    expect(marker).toEqual(before);
  });
});

describe("round72 reviewed completion and batch directions", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] };
  const note: FhirExtension = { url: "urn:clinic:pause-note", valueString: "retain the prescribed pause metadata" };
  const boundary = { contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] },
    offsetDuration: { value: 2, unit: "d" } };

  it.each(["PRN", "PRN reason", "dose", "scheduled false", "annotation"] as const)("reconciles completion after a fresh %s edit", edit => {
    const saved = r6Save({ step: [
      { id: "induction", component: [{ id: "initial", doseAndRate: [{ doseQuantity: q(1) }],
        timing: { repeat: { ...daily, count: 2 } } }] },
      { id: "pause", end: boundary, component: [], extension: [note] },
      { id: "maintenance", component: [{ id: "later", doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: daily } }] },
    ] });
    const input = persist(saved), first = input.step![0].component[0];
    if (edit === "PRN") first.asNeeded = true;
    if (edit === "PRN reason") first.asNeededFor = [{ text: "pain" }];
    if (edit === "dose") first.doseAndRate![0].doseQuantity!.value = 2;
    if (edit === "scheduled false") first.asNeeded = false;
    if (edit === "annotation") first._asNeeded = { id: "prn-annotation", extension: [note] };
    const before = persist(input), editable = fromDosageDetails(input);
    const ids = ["induction", ...(edit === "PRN" || edit === "PRN reason" ? [] : ["pause"]), "maintenance"];
    expect(editable.course.step!.map(step => step.id)).toEqual(ids);
    const reopened = toDosageDetails(persist(editable.dosages), undefined, persist(editable.course));
    expect(fromDosageDetails(reopened).course.step!.map(step => step.id)).toEqual(ids);
    expect(reopened.step![0].component[0].asNeeded === true || Boolean(reopened.step![0].component[0].asNeededFor?.length))
      .toBe(edit === "PRN" || edit === "PRN reason");
    expect(JSON.stringify(reopened)).toContain(note.valueString);
    expect(input).toEqual(before);
  });

  it("keeps an imported whole-course header when it owns the directions", () => {
    const source: FhirR6DosageInstruction = { renderedInstruction: "Follow specialist directions",
      step: [{ component: [{ text: "Use the supplied instructions" }] }] };
    const before = persist(source), batch = fromFhir(source, { locale: "en" });
    expect(batch.items[0].longText).toBe("Use the supplied instructions");
    for (const style of ["short", "long"] as const) {
      expect(style === "short" ? batch.shortText : batch.longText).toBe(source.renderedInstruction);
      expect(formatParseBatch(batch, style, " / ")).toBe("Follow specialist directions");
    }
    expect(source).toEqual(before);
  });

  it.each([1, 2])("keeps independently authored header directions beside %s clock-only components", count => {
    const source: FhirR6DosageInstruction = { renderedInstruction: "Apply a thin layer", step: [{ component:
      ["08:00:00", "17:00:00"].slice(0, count).map(clock => ({ timing: { repeat: { timeOfDay: [clock] } } }))
    }] };
    const before = persist(source);
    for (const locale of ["en", "th"]) {
      const batch = fromFhir(persist(source), { locale });
      for (const style of ["short", "long"] as const) {
        const whole = style === "short" ? batch.shortText : batch.longText;
        expect(whole).toContain("Apply a thin layer");
        expect(whole).toContain(style === "long" && locale === "en" ? "8:00 am" : "08:00");
        if (count === 2) expect(whole).toContain(style === "long" && locale === "en" ? "5:00 pm" : "17:00");
        expect(formatParseBatch(batch, style, " / ")).toBe(whole);
      }
    }
    expect(source).toEqual(before);
  });

  it("keeps separator joining for independent imported components with clinical facts", () => {
    const source: FhirR6DosageInstruction = { step: [{ component: [
      { doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } },
      { doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: daily } },
    ] }] };
    const batch = fromFhir(source, { locale: "en", realizationMode: "normalized" });
    expect(batch.items).toHaveLength(2);
    for (let index = 0; index < batch.items.length; index++) {
      expect(batch.items[index].fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(index + 1);
      expect(batch.items[index].shortText).toContain(`${index + 1} tab`);
      expect(batch.items[index].longText).toContain(index ? "2 tablets" : "1 tablet");
    }
    for (const style of ["short", "long"] as const) {
      const values = batch.items.map(item => style === "short" ? item.shortText : item.longText);
      expect(formatParseBatch(batch, style, " / ")).toBe(values.join(" / "));
      expect(formatParseBatch(batch, style)).toBe(values.join(", "));
    }
    const labelled = fromFhir({ ...source, renderedInstruction: "Retained source heading" },
      { locale: "en", realizationMode: "normalized" });
    for (const style of ["short", "long"] as const) {
      const text = formatParseBatch(labelled, style, " / ");
      expect(text).toBe(style === "short" ? labelled.shortText : labelled.longText);
      expect(text.match(/Retained source heading/gu)).toHaveLength(1);
      expect(text).toContain(style === "short" ? "1 tab" : "1 tablet");
      expect(text).toContain(style === "short" ? "2 tab" : "2 tablets");
    }
  });
});

describe("round72 reviewed interchange source families", () => {
  const note: FhirExtension = { url: "urn:clinic:source-note", valueString: "retain the supplied annotation" };
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] };
  const boundary = { contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] },
    offsetDuration: { value: 3, unit: "d" } };

  it.each(["annotation", "endpoint"] as const)("reconciles a duration range after a fresh %s edit", edit => {
    const source = r6Save({ step: [
      { id: "induction", component: [{ id: "initial", doseAndRate: [{ doseQuantity: q(1) }],
        timing: { repeat: { ...daily, boundsRange: { low: { value: 1, unit: "d" }, high: { value: 1, unit: "d" } } } } }] },
      { id: "pause", end: boundary, component: [], extension: [note] },
      { id: "maintenance", component: [{ id: "later", doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: daily } }] },
    ] });
    const input = persist(source), range = input.step![0].component[0].timing!.repeat!.boundsRange!;
    range.low!.id = "range-low";
    range.low!._value = { id: "range-value", extension: [note] };
    if (edit === "endpoint") range.high!.value = 2;
    const before = persist(input), editable = fromDosageDetails(input);
    const ids = ["induction", ...(edit === "annotation" ? ["pause"] : []), "maintenance"];
    expect(editable.course.step!.map(step => step.id)).toEqual(ids);
    const reopened = toDosageDetails(persist(editable.dosages), undefined, persist(editable.course));
    expect(reopened.step![0].component[0].timing!.repeat!.boundsRange).toEqual(range);
    expect(fromDosageDetails(reopened).course.step!.map(step => step.id)).toEqual(ids);
    expect(input).toEqual(before);
  });

  it("accepts native Reference Quantity annotations on a boundary without loosening R5", () => {
    const annotation: FhirR6Extension = { url: "urn:clinic:reference-note", valueQuantity: { value: 2, comparator: "~" } };
    const start: FhirR6RelativeTime = { contextReference: { reference: "Observation/anchor", extension: [annotation] } };
    const ordinary: FhirR6RelativeTime = { contextReference: { reference: "Observation/ordinary" } };
    // @ts-expect-error The R5 Reference annotation still uses the R5 Quantity comparator set.
    const r5: FhirReference = { extension: [annotation] };
    void r5; void ordinary;
    const source: FhirR6DosageInstruction = { step: [{ start, component: [{ doseAndRate: [{ doseQuantity: q(1) }] }] }] };
    const before = persist(source), projected = projectCanonicalCourse(importCanonicalCourse(source));
    expect(projected.fhirNext.step![0].start!.contextReference).toEqual(start.contextReference);
    expect(toDosageDetails(persist(projected.fhir)).step![0].start!.contextReference).toEqual(start.contextReference);
    expect(source).toEqual(before);
  });

  it.each([false, true])("projects negated graph advice in the standard field once (represented %s)", represented => {
    const graph = parseSig("Take 1 tablet daily; do not crush").meta.canonical.clauses[0].instructionGraph!;
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily },
      extension: [buildInstructionGraphExtension(graph)!],
      ...(represented ? { additionalInstruction: [{ id: "current-advice", text: "Do not crush.", extension: [note] }] } : {}) };
    const before = persist(row), projected = projectCanonicalCourse(importCanonicalCourse([row]));
    for (const output of [projected.fhir[0], projected.fhirNext.step![0].component[0]]) {
      expect(output.additionalInstruction).toHaveLength(1);
      expect(output.additionalInstruction![0].text!.toLowerCase().replace(/[.]/gu, "")).toBe("do not crush");
      if (represented) expect(output.additionalInstruction![0]).toMatchObject({ id: "current-advice", extension: [note] });
    }
    expect(row).toEqual(before);
  });

  it.each(["en", "th"] as const)("shows replacement directions once beside current timing in %s", locale => {
    const source: FhirDosage = { text: "Swallow 1 tablet whole", timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } } };
    const row = persist(toFhirR5Dosages(toDosageDetails([source]))[0]);
    row.text = "Swallow 1 tablet with water";
    row.timing!.repeat!.frequency = 2;
    const before = persist(row), options = { locale, realizationMode: "roundtrip" as const };
    const imported = fromFhirDosage(row, options);
    for (const text of [formatSig(row, "short", options), formatSig(row, "long", options), imported.shortText, imported.longText]) {
      expect(text.split(row.text).length - 1).toBe(1);
      expect(text).toMatch(locale === "en" ? /twice daily|2 times|2x\/d/iu : /วันละ ?2/u);
    }
    expect(row).toEqual(before);
  });

  it("retains configured action Coding annotations before graph serialization", () => {
    const coding = { system: "https://example.org/clinic/actions", version: "2026", code: "coat-lightly", display: "Coat lightly",
      id: "clinic-action", userSelected: false, _code: { id: "authored-action-code", extension: [note] },
      extension: [note], clinicSource: { revision: "authored" } };
    const options = { instructionActionMap: { "coat lightly": { code: "coat-lightly", display: "Coat lightly",
      semanticClass: "procedure", procedural: true, coding } } };
    const before = persist(options), parsed = parseSig("coat lightly", options);
    const graph = parsed.meta.canonical.clauses[0].instructionGraph!;
    expect(graph.actions[0].predicate.codings).toContainEqual(coding);
    const restored = parseInstructionGraphExtension([buildInstructionGraphExtension(graph)!])!;
    expect(restored.actions[0].predicate.codings).toContainEqual(expect.objectContaining({
      id: coding.id, userSelected: false, _code: coding._code, extension: [note],
    }));
    expect(options).toEqual(before);
  });
});

describe("round73 native Reference identifier annotations", () => {
  it.each(["identifier", "assigner"] as const)("keeps native R6 Quantity annotations on %s", owner => {
    const note: FhirR6Extension = { url: "urn:clinic:reference-note", valueQuantity: { value: 2, comparator: "~" } };
    const reference: FhirR6Reference = { identifier: {
      system: "urn:clinic:orders", value: "order-A",
      ...(owner === "identifier" ? { extension: [note] } : { assigner: { reference: "Organization/clinic", extension: [note] } }),
    } };
    const ordinary: FhirR6Reference = { identifier: { system: "urn:clinic:orders", value: "order-B",
      assigner: { reference: "Organization/clinic" } } };
    // @ts-expect-error R5 Identifier annotations retain the R5 Quantity comparator set.
    const r5Identifier: FhirReference = { identifier: { extension: [note] } };
    // @ts-expect-error R5 Identifier.assigner remains an R5 Reference.
    const r5Assigner: FhirReference = { identifier: { assigner: { extension: [note] } } };
    void ordinary; void r5Identifier; void r5Assigner;
    const source: FhirR6DosageInstruction = { step: [{ start: { contextReference: reference },
      component: [{ doseAndRate: [{ doseQuantity: q(1) }] }] }] };
    const before = persist(source), projected = projectCanonicalCourse(importCanonicalCourse(source));
    expect(projected.fhirNext.step![0].start!.contextReference).toEqual(reference);
    expect(toDosageDetails(persist(projected.fhir)).step![0].start!.contextReference).toEqual(reference);
    expect(source).toEqual(before);
  });
});

describe("round74 reviewed interchange directions", () => {
  const note: FhirR6Extension = { url: "urn:clinic:reference-observation", valueQuantity: { value: 2, comparator: "~" } };

  it("accepts native Reference annotations in condition and extension values", () => {
    const reference: FhirR6Reference = { reference: "Observation/assessment", extension: [note] };
    const condition: FhirR6DosageCondition = { code: { text: "assessment" }, valueReference: reference };
    const annotation: FhirR6Extension = { url: "urn:clinic:assessment", valueReference: reference };
    const linked: FhirR6Extension = { url: "urn:clinic:linked-assessment", valueCodeableReference: { reference } };
    const linkedCondition: FhirR6DosageCondition = { code: { text: "linked assessment" }, valueCodeableReference: { reference } };
    const identifierCondition: FhirR6DosageCondition = { code: { text: "identified assessment" },
      valueIdentifier: { system: "urn:clinic:orders", value: "assessment-A", extension: [note], assigner: reference } };
    const ordinary: FhirR6DosageCondition = { code: { text: "assessment" }, valueReference: { reference: "Observation/plain" } };
    // @ts-expect-error R5 Extension Reference values retain R5 Quantity annotation types.
    const r5: FhirExtension = { url: annotation.url, valueReference: reference };
    void ordinary; void r5;
    const source: FhirR6DosageInstruction = { extension: [annotation, linked], step: [{ component: [{
      condition: [condition, linkedCondition, identifierCondition], doseAndRate: [{ doseQuantity: q(1) }],
    }] }] };
    const before = persist(source), projected = projectCanonicalCourse(importCanonicalCourse(source));
    for (const output of [projected.fhirNext, toDosageDetails(persist(projected.fhir))]) {
      expect(output.extension).toContainEqual(annotation);
      expect(output.extension).toContainEqual(linked);
      expect(output.step![0].component[0].condition).toEqual([condition, linkedCondition, identifierCondition]);
    }
    expect(source).toEqual(before);
  });

  it.each([false, true])("preserves authored Timing text in clause projection (coded %s)", coded => {
    const source: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }], timing: { code: {
      text: coded ? "Twice daily" : "During wound care",
      ...(coded ? { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "BID" }] } : {}),
    } } };
    const before = persist(source), projected = canonicalToFhir(canonicalFromFhir(source));
    expect(projected.timing?.code).toEqual(source.timing!.code);
    expect(source).toEqual(before);
  });

  it("retains a complete graph warning beside a shorter current warning", () => {
    const graph = persist(parseSig("Take 1 tablet daily; do not crush").meta.canonical.clauses[0].instructionGraph!);
    graph.actions[0].sourceText = "Do not crush or chew";
    const source: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }],
      additionalInstruction: [{ id: "short-warning", text: "Do not crush" }],
      extension: [buildInstructionGraphExtension(graph)!] };
    const before = persist(source), projected = projectCanonicalCourse(importCanonicalCourse([source]));
    for (const output of [projected.fhir[0], projected.fhirNext.step![0].component[0]]) {
      expect(output.additionalInstruction).toContainEqual({ id: "short-warning", text: "Do not crush" });
      expect(output.additionalInstruction?.map(item => item.text)).toContain("Do not crush or chew");
    }
    expect(source).toEqual(before);
  });

  it.each(["en", "th"] as const)("keeps header-only dose directions beside live component timing in %s", locale => {
    const source: FhirR6DosageInstruction = { renderedInstruction: "Swallow 1 tablet whole",
      step: [{ component: [{ timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day } } }] }] };
    const before = persist(source), options = { locale, realizationMode: "roundtrip" as const };
    const batch = fromFhir(source, options);
    for (const text of [formatSig(source, "long", options), formatSig(source, "short", options), batch.longText, batch.shortText]) {
      expect(text.split(source.renderedInstruction!).length - 1).toBe(1);
      expect(text).toMatch(locale === "en" ? /twice daily|2 times|2x\/d/iu : /วันละ ?2/u);
    }
    expect(source).toEqual(before);
  });
});

describe("round74 shared source owners", () => {
  const note: FhirExtension = { url: "urn:clinic:source-note", valueString: "keep the source annotation" };
  const options: ParseOptions = { instructionActionMap: { disperse: {
    code: "disperse", display: "Disperse", semanticClass: "prepare", procedural: true, acceptsAmount: true, definesDose: true,
    argumentParser: "amount-material-destination", realizer: "amount-material-destination",
  } } };

  it("keeps primary owner annotations through the public graph codec", () => {
    const graph = parseSig("Disperse 2 tablets in 100 mL water, then swallow slowly with water at 10:00", options)
      .meta.canonical.clauses[0].instructionGraph!;
    const marker = buildInstructionGraphExtension(graph)!;
    const ownership = marker.extension!.find(item => item.url === "primaryOwnership")!;
    ownership.id = "authored-owner"; ownership.extension!.push(note);
    const resolved = ownership.extension!.find(item => item.url === "resolved")!;
    Object.assign(resolved, { id: "resolved-owner", _valueBoolean: { id: "resolved-value", extension: [note] } });
    const doseOwner = ownership.extension!.find(item => item.url === "doseActionIndex")!;
    doseOwner.id = "amount-owner";
    const before = persist(marker);
    let current = marker;
    for (let save = 0; save < 2; save++) {
      const decoded = parseInstructionGraphExtension([persist(current)])!;
      expect(decoded.primaryOwnership).toMatchObject({ administrationActionIndex: 1, dose: { actionIndex: 0, argumentIndex: 0 } });
      current = buildInstructionGraphExtension(decoded)!;
      const retained = current.extension!.filter(item => item.url === "primaryOwnership");
      expect(retained).toHaveLength(1);
      expect(retained[0].id).toBe("authored-owner");
      expect(retained[0].extension).toContainEqual(note);
      expect(retained[0].extension).toContainEqual(resolved);
      expect(retained[0].extension).toContainEqual(doseOwner);
    }
    expect(marker).toEqual(before);
  });



  it("merges current same-locale translations for graph Coding and PRN projection", () => {
    const oldThai = { id: "authored-translation", url: FHIR_TRANSLATION_EXTENSION_URL, extension: [
      { url: "lang", valueCode: "th" }, { id: "translation-content", url: "content", valueString: "เดิม" }, note,
    ] };
    const german = { url: FHIR_TRANSLATION_EXTENSION_URL, extension: [
      { url: "lang", valueCode: "de" }, { url: "content", valueString: "Beibehalten" },
    ] };
    const coding = { system: "https://example.org/clinic/actions", code: "coat-lightly", display: "Coat lightly",
      _display: { id: "display-owner", extension: [oldThai, german, note] }, i18n: { th: "ปัจจุบัน", fr: "Actuel" } };
    const parsed = parseSig("coat lightly", { instructionActionMap: { "coat lightly": {
      code: "coat-lightly", display: "Coat lightly", semanticClass: "procedure", procedural: true, coding,
    } } });
    const marker = buildInstructionGraphExtension(parsed.meta.canonical.clauses[0].instructionGraph!)!;
    const graphCoding = marker.extension!.find(item => item.url === "action")!.extension!
      .find(item => item.url === "predicateCoding")!.valueCoding!;
    const clause = persist(parseSig("Take 1 tablet as needed for pain").meta.canonical.clauses[0]);
    clause.prn = { enabled: true, reasons: [{ text: "pain", coding }] };
    const projected = canonicalToFhir(clause, undefined, { includeTranslationExtensions: true });
    const prnCoding = projected.asNeededFor![0].coding![0];
    for (const output of [graphCoding, prnCoding]) {
      expect(getPrimitiveTranslation(output._display, "th")).toBe("ปัจจุบัน");
      expect(getPrimitiveTranslations(output._display)).toMatchObject({ th: "ปัจจุบัน", de: "Beibehalten", fr: "Actuel" });
      expect(output._display!.id).toBe("display-owner");
      expect(output._display!.extension).toContainEqual(note);
      const thai = output._display!.extension!.filter(item =>
        item.url === FHIR_TRANSLATION_EXTENSION_URL && item.extension?.some(child => child.url === "lang" && child.valueCode === "th"));
      expect(thai).toHaveLength(1);
      expect(thai[0].id).toBe("authored-translation");
      expect(thai[0].extension).toContainEqual({ id: "translation-content", url: "content", valueString: "ปัจจุบัน" });
      expect(thai[0].extension).toContainEqual(note);
    }
    expect(coding._display.extension[0]).toEqual(oldThai);
  });

  it("retains independent historical header annotations when compact header fields win", () => {
    const historicalNote = { id: "historical-note", url: "urn:clinic:historical-header", valueString: "historical header annotation",
      _valueString: { id: "historical-value", extension: [note] } };
    const currentNote = { url: "urn:clinic:current-header", valueString: "current header annotation" };
    const header = encodeR5RetainedFields({ course: { id: "historical-header", extension: [historicalNote] } })
      .find(item => item.url === "course")!.extension!;
    const historical: FhirDosage = { sequence: 1, doseAndRate: [{ doseQuantity: q(1) }], modifierExtension: [{
      url: DOSAGE_DETAILS_R5_URL, extension: [{ url: "dosageDetails", extension: [
        ...header, encodeR6SourceMetadata("step", { component: [{ doseAndRate: [{ doseQuantity: q(1) }] }] }, "step"),
      ] }],
    }] };
    const compact = toFhirR5Dosages({ id: "current-header", extension: [currentNote],
      step: [{ component: [{ doseAndRate: [{ doseQuantity: q(2) }] }] }] })[0];
    let rows = persist([historical, compact]);
    const before = persist(rows);
    for (let save = 0; save < 2; save++) {
      const output = toDosageDetails(rows);
      expect(output.id).toBe("current-header");
      expect(output.extension).toContainEqual(currentNote);
      expect(JSON.stringify(output)).toContain(JSON.stringify(historicalNote));
      expect(output.step![0].component.map(member => member.doseAndRate![0].doseQuantity!.value)).toEqual([1, 2]);
      if (!save) expect(rows).toEqual(before);
      rows = persist(toFhirR5Dosages(output));
    }
  });

  it.each(["weekday", "anchor", "event"] as const)("reads a fresh wire %s edit through both supported interchange forms", kind => {
    const timing: FhirR6Timing = kind === "event"
      ? { event: ["2026-01-01T09:00:00Z"], _event: [{ id: "event-value", extension: [note] }] }
      : { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        ...(kind === "weekday" ? { dayOfWeek: [FhirDayOfWeek.Monday], _dayOfWeek: [{ id: "weekday-value", extension: [note] }] }
          : { when: [EventTiming.Morning], _when: [{ id: "anchor-value", extension: [note] }] }) } };
    const source = r6Save(course({ timing }));
    for (const input of [persist(source), persist(toFhirR5Dosages(source))]) {
      const member = Array.isArray(input) ? input[0] : input.step![0].component[0];
      if (kind === "weekday") member.timing!.repeat!.dayOfWeek = [FhirDayOfWeek.Tuesday];
      else if (kind === "anchor") member.timing!.repeat!.when = [EventTiming.Evening];
      else member.timing!.event = ["2026-01-02T09:00:00Z"];
      const before = persist(input), output = projectCanonicalCourse(importCanonicalCourse(input));
      for (const current of [output.fhir[0], output.fhirNext.step![0].component[0]]) {
        if (kind === "weekday") expect(current.timing!.repeat!.dayOfWeek).toEqual([FhirDayOfWeek.Tuesday]);
        else if (kind === "anchor") expect(current.timing!.repeat!.when).toEqual([EventTiming.Evening]);
        else expect(current.timing!.event).toEqual(["2026-01-02T09:00:00Z"]);
        expect(JSON.stringify(current)).toContain(note.valueString);
      }
      expect(input).toEqual(before);
    }
  });

  it.each(["range", "qualified", "scalar"] as const)("projects a source-less typed %s administration duration", kind => {
    const source: CanonicalCourse = { kind: "course", stages: [{ administrations: [{ kind: "administration",
      amounts: [{ quantity: { value: 1, unit: "tab" } }], schedule: { recurrence: {
        frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        ...(kind === "range" ? { occurrenceDurationRange: { low: { value: 20, unit: "min" }, high: { value: 30, unit: "min" } } }
          : { occurrenceDuration: 20, occurrenceDurationUnit: FhirPeriodUnit.Minute, ...(kind === "qualified" ? { occurrenceDurationComparator: ">=" as const } : {}) }),
      } },
    }] }] };
    const before = persist(source), projected = projectCanonicalCourse(source);
    for (const output of [projected.fhir[0], projected.fhirNext.step![0].component[0]]) {
      const repeat = output.timing!.repeat!, marker = repeat.extension?.find(item => item.url === TIMING_ADMINISTRATION_DURATION_EXTENSION_URL);
      if (kind === "scalar") {
        expect(repeat).toMatchObject({ duration: 20, durationUnit: "min" });
        expect(marker).toBeUndefined();
      } else {
        expect(repeat.duration).toBeUndefined();
        if (kind === "range") expect(marker?.valueRange).toMatchObject({ low: { value: 20, unit: "min" }, high: { value: 30, unit: "min" } });
        else expect(marker?.valueQuantity).toMatchObject({ value: 20, code: "min", comparator: ">=" });
      }
    }
    expect(source).toEqual(before);
  });
});

describe("round74 ancillary advice and independent authored directions", () => {
  const header = "Swallow 1 tablet whole";
  const timing = { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day } };

  it.each(["Shake well", "Do not crush"])("keeps header dose directions beside current timing and %s", advice => {
    const graph = parseSig(advice).meta.canonical.clauses[0].instructionGraph!;
    expect(graph.primaryOwnership).toEqual({});
    const source: FhirR6DosageInstruction = { renderedInstruction: header, step: [{ component: [{
      timing, extension: [buildInstructionGraphExtension(graph)!],
    }] }] };
    const original = persist(source);
    const rows = persist(toFhirR5Dosages(source)), native = importCanonicalCourse(persist(source));
    for (const input of [native, persist(source), rows]) for (const locale of ["en", "th"] as const) {
      const text = formatSig(input, "long", { locale, realizationMode: "roundtrip" });
      expect(text.split(header).length - 1).toBe(1);
      expect(text).toMatch(locale === "en" ? /twice daily/iu : /วันละ ?2/u);
      expect(text).toMatch(locale === "en" ? (advice === "Shake well" ? /shake well/iu : /do not crush/iu)
        : advice === "Shake well" ? /เขย่า/u : /ห้ามบด/u);
    }
    expect(fromFhir(persist(source), { locale: "en", realizationMode: "roundtrip" }).longText.split(header).length - 1).toBe(1);
    expect(source).toEqual(original);
  });

  it("keeps independent header dose directions beside a graph-owned administration head", () => {
    const graph = parseSig("Swallow slowly with water at 10:00").meta.canonical.clauses[0].instructionGraph!;
    expect(graph.primaryOwnership).toEqual({ administrationActionIndex: 0 });
    expect(graph.primaryOwnership?.dose).toBeUndefined();
    const source: FhirR6DosageInstruction = { renderedInstruction: header, step: [{ component: [{
      timing, extension: [buildInstructionGraphExtension(graph)!],
    }] }] };
    const before = persist(source);
    for (const input of [importCanonicalCourse(persist(source)), persist(source), persist(toFhirR5Dosages(source))]) {
      for (const locale of ["en", "th"] as const) {
        const text = formatSig(input, "long", { locale, realizationMode: "roundtrip" });
        expect(text.split(header).length - 1).toBe(1);
        expect(text).toMatch(locale === "en" ? /twice daily/iu : /วันละ ?2/u);
        expect(text).toMatch(locale === "en" ? /swallow.*water/iu : /กลืน.*น้ำ/u);
      }
    }
    expect(source).toEqual(before);
  });

  it.each([false, true])("shares source ownership for a fresh R5 member beside ancillary advice (current dose %s)", dose => {
    const graph = parseSig("Shake well").meta.canonical.clauses[0].instructionGraph!;
    const source: FhirDosage = { text: header, timing, extension: [buildInstructionGraphExtension(graph)!],
      ...(dose ? { doseAndRate: [{ doseQuantity: q(2) }] } : {}) };
    const before = persist(source), options = { locale: "en", realizationMode: "roundtrip" as const };
    const imported = fromFhirDosage(source, options);
    for (const text of [formatSig(source, "long", options), imported.longText]) {
      expect(text.split(header).length - 1).toBe(1);
      const current = text.split("; original directions:")[0];
      expect(current).toMatch(/twice daily/iu);
      expect(text.match(/shake well/giu)).toHaveLength(1);
      if (dose) {
        expect(current).toMatch(/2 tablets/iu);
        expect(current).not.toContain("1 tablet");
      }
    }
    expect(source).toEqual(before);
  });

  it("keeps a complete graph authoritative for the same authored directions", () => {
    const instruction = "Shake well";
    const graph = parseSig(instruction).meta.canonical.clauses[0].instructionGraph!;
    expect(graph.coverage?.complete).toBe(true);
    const source: FhirR6DosageInstruction = { renderedInstruction: instruction, step: [{ component: [{
      timing, extension: [buildInstructionGraphExtension(graph)!],
    }] }] };
    for (const input of [importCanonicalCourse(persist(source)), persist(source), persist(toFhirR5Dosages(source))]) {
      const english = formatSig(input, "long", { locale: "en", realizationMode: "roundtrip" });
      expect(english.match(/shake well/giu)).toHaveLength(1);
      expect(english).toMatch(/twice daily/iu);
      expect(english).not.toContain("original directions");
      const thai = formatSig(input, "long", { locale: "th", realizationMode: "roundtrip" });
      expect(thai).toMatch(/เขย่า/u);
      expect(thai).not.toContain(instruction);
    }
  });

  it("keeps the current structured amount authoritative beside a different course header", () => {
    const graph = parseSig("Shake well").meta.canonical.clauses[0].instructionGraph!;
    const source: FhirR6DosageInstruction = { renderedInstruction: header, step: [{ component: [{
      timing, doseAndRate: [{ doseQuantity: q(2) }], extension: [buildInstructionGraphExtension(graph)!],
    }] }] };
    for (const input of [importCanonicalCourse(persist(source)), persist(source), persist(toFhirR5Dosages(source))]) {
      const text = formatSig(input, "long", { locale: "en", realizationMode: "roundtrip" });
      expect(text).toMatch(/2 tablets.*twice daily/iu);
      expect(text).toMatch(/shake well/iu);
      expect(text).toContain("; original directions: " + header);
      expect(text.split(header)).toHaveLength(2);
      expect(text.split("; original directions:")[0]).not.toContain("1 tablet");
    }
  });
});


describe("round75 opaque temporal unit ownership", () => {
  const local = { id: "authored-interval", value: 7, unit: "treatment blocks",
    system: "urn:clinic:interval-units", code: "d", _value: { id: "interval-value" },
    extension: [{ url: "urn:clinic:interval-note", valueString: "keep the local definition" }] } satisfies FhirR6Quantity;
  const event = { contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] } };
  const member: FhirR6Dosage = { doseAndRate: [{ doseQuantity: q(1) }] };
  const locations = ["repeat-cycle", "start-offset", "stage-start", "stage-range"] as const;
  type Location = typeof locations[number];
  const source = (location: Location): FhirR6DosageInstruction => {
    if (location === "repeat-cycle") return { repeatCycle: local, step: [{ component: [member] }] };
    if (location === "start-offset") return { step: [{ component: [{ ...member, timing: { repeat: {
      frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, startOffset: local,
    } } }] }] };
    return { step: [{ start: { ...event, ...(location === "stage-start" ? { offsetDuration: local }
      : { offsetRange: { low: local, high: { ...local, value: 9 } } }) }, component: [member] }] };
  };
  const retained = (wire: FhirR6DosageInstruction, location: Location) => location === "repeat-cycle" ? wire.repeatCycle
    : location === "start-offset" ? wire.step![0].component[0].timing!.repeat!.startOffset
    : location === "stage-start" ? wire.step![0].start!.offsetDuration : wire.step![0].start!.offsetRange;

  it.each(locations)("keeps a local-coded %s uninterpreted in both languages and interchange forms", location => {
    const raw = source(location), snapshot = persist(raw);
    for (const input of [persist(raw), persist(toFhirR5Dosages(persist(raw)))]) {
      const before = persist(input);
      const native = importCanonicalCourse(input);
      for (const value of [input, native]) for (const locale of ["en", "th"] as const) {
        const text = formatSig(value, "long", { locale, realizationMode: "normalized" });
        expect(text).toContain("7 treatment blocks");
        expect(text).not.toMatch(/7 days|7 วัน/u);
        if (location === "stage-range") expect(text).toContain("9 treatment blocks");
        if (location === "stage-start") expect(text).not.toMatch(/No doses|งดยา/u);
        if (location === "repeat-cycle") expect(text).toContain(locale === "en"
          ? "Repeat-cycle interval: 7 treatment blocks." : "ระยะรอบการใช้ยา: 7 treatment blocks.");
      }
      let saved = projectCanonicalCourse(native).fhirNext;
      for (let pass = 0; pass < 2; pass++) {
        expect(retained(saved, location)).toEqual(retained(raw, location));
        saved = toDosageDetails(persist(toFhirR5Dosages(persist(saved))));
      }
      expect(input).toEqual(before);
    }
    expect(raw).toEqual(snapshot);
  });

  it("retains independently coded member offsets when their labels share a familiar local code", () => {
    const outer = { ...local, unit: "outer blocks", code: "mo", system: "urn:clinic:outer-intervals" };
    const inner = { ...local, value: 3, unit: "inner blocks", code: "mo", system: "urn:clinic:inner-intervals" };
    const raw: FhirR6DosageInstruction = { step: [{ start: { ...event, offsetDuration: outer }, component: [{ ...member,
      modifierExtension: [{ url: PARALLEL_COMPONENT_PHASE_ORIGIN_URL, valueQuantity: inner }],
    }] }] };
    for (const input of [persist(raw), persist(toFhirR5Dosages(persist(raw)))]) for (const locale of ["en", "th"] as const) {
      const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
      expect(text).toContain("7 outer blocks");
      expect(text).toContain("3 inner blocks");
      expect(text).not.toMatch(/7 months|3 months|7 เดือน|3 เดือน/u);
    }
  });

  it.each(["ucum", "uncoded"] as const)("keeps an understood %s repeat interval localized", kind => {
    const interval = { value: 7, unit: "days", ...(kind === "ucum" ? { system: "http://unitsofmeasure.org", code: "d" } : {}) };
    const raw: FhirR6DosageInstruction = { repeatCycle: interval, step: [{ component: [member] }] };
    for (const input of [persist(raw), persist(toFhirR5Dosages(persist(raw)))]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toContain("Repeat this schedule every 7 days");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" })).toContain("ทุก 7 วัน");
      expect(projectCanonicalCourse(importCanonicalCourse(input)).fhirNext.repeatCycle).toEqual(interval);
    }
  });
});


describe("round76 shared current preview owners", () => {
  it.each(["scalar", "range"] as const)("preserves local %s course-duration labels in the clause projection", kind => {
    const low = { id: "local-duration", value: 2, unit: "half-hour blocks", system: "urn:clinic:duration", code: "h",
      extension: [{ url: "urn:clinic:duration-note", valueString: "authored local interval" }] };
    const high = { ...low, value: 3, unit: "session blocks", code: "d" };
    const raw = course({ timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
      ...(kind === "scalar" ? { boundsDuration: low } : { boundsRange: { low, high } }) } } });
    const rows = persist(toFhirR5Dosages(persist(raw)));
    for (const input of [persist(raw), rows, rows[0]]) {
      const before = persist(input), native = importCanonicalCourse(input);
      for (const value of [input, native]) for (const locale of ["en", "th"] as const) {
        const text = formatSig(value, "long", { locale, realizationMode: "normalized" });
        expect(text).toContain("2 half-hour blocks");
        expect(text).not.toMatch(/for 2 hours|2 ชั่วโมง/u);
        if (kind === "range") { expect(text).toContain("3 session blocks"); expect(text).not.toMatch(/3 days|3 วัน/u); }
      }
      const repeat = projectCanonicalCourse(native).fhirNext.step![0].component[0].timing!.repeat!;
      if (kind === "scalar") expect(repeat.boundsDuration).toEqual(low);
      else expect(repeat.boundsRange).toEqual({ low, high });
      expect(input).toEqual(before);
    }
  });

  it.each([undefined, "h"])("keeps a local code opaque even when its authored label is %s", unit => {
    const bound = { value: 2, system: "urn:clinic:duration", code: "h", ...(unit ? { unit } : {}) };
    const raw = course({ timing: { repeat: { boundsDuration: bound } } });
    const rows = persist(toFhirR5Dosages(persist(raw)));
    for (const input of [raw, rows, rows[0]]) for (const locale of ["en", "th"] as const) {
      expect(formatSig(input, "long", { locale })).toContain("2 h");
      expect(formatSig(input, "long", { locale })).not.toMatch(/hours|ชั่วโมง/u);
      const short = formatSig(input, "short", { locale });
      expect(short).toContain("2 h");
      expect(short).not.toMatch(/x2h|hours|ชั่วโมง/u);
      const native = importCanonicalCourse(input);
      expect(native.stages[0].administrations[0].schedule?.recurrence?.courseLength).toEqual(bound);
      expect(projectCanonicalCourse(native).fhirNext.step[0].component[0].timing?.repeat?.boundsDuration).toEqual(bound);
    }
  });

  it("keeps recognized UCUM hours distinct from an opaque local duration label", () => {
    const bound = { value: 2, system: "http://unitsofmeasure.org", code: "h", unit: "h" };
    const raw = course({ timing: { repeat: { boundsDuration: bound } } });
    for (const input of [raw, toFhirR5Dosages(raw)]) for (const locale of ["en", "th"]) {
      expect(formatSig(input, "short", { locale })).toContain("x2h");
      expect(formatSig(input, "long", { locale })).toContain(locale === "en" ? "2 hours" : "2 ชั่วโมง");
    }
  });

  it("uses the same quantity identity for administration-duration range labels", () => {
    const range = { low: { value: 2, system: "urn:clinic:duration", code: "h", unit: "half-hour blocks" },
      high: { value: 3, system: "urn:clinic:duration", code: "d", unit: "session blocks" } };
    const raw = course({ timing: { repeat: { extension: [{ url: TIMING_ADMINISTRATION_DURATION_EXTENSION_URL,
      valueRange: range }] } } });
    const rows = persist(toFhirR5Dosages(persist(raw)));
    for (const input of [raw, rows, rows[0]]) for (const locale of ["en", "th"] as const) {
      const rendered = formatSig(input, "long", { locale });
      expect(rendered).toContain("2 half-hour blocks");
      expect(rendered).toContain("3 session blocks");
      expect(rendered).not.toMatch(/2 hours|3 days|2 ชั่วโมง|3 วัน/u);
    }
    expect(importCanonicalCourse(raw).stages[0].administrations[0].schedule!.recurrence!.occurrenceDurationRange).toEqual(range);
  });

  it("keeps opaque and standard duration endpoints separate in short previews", () => {
    const raw = course({ timing: { repeat: { boundsRange: {
      low: { value: 2, unit: "h", system: "urn:clinic:duration", code: "h" },
      high: { value: 3, unit: "h", system: "http://unitsofmeasure.org", code: "h" },
    } } } });
    const rows = persist(toFhirR5Dosages(persist(raw)));
    for (const input of [raw, rows, rows[0]]) for (const locale of ["en", "th"] as const) {
      expect(formatSig(input, "short", { locale })).toContain("x2 h – 3h");
      expect(formatSig(input, "short", { locale })).not.toContain("x2-3h");
    }
    expect(projectCanonicalCourse(importCanonicalCourse(raw)).fhirNext.step![0].component[0].timing!.repeat!.boundsRange)
      .toEqual(raw.step![0].component[0].timing!.repeat!.boundsRange);
  });

  it.each([false, true])("keeps member-only directions next to an independent warning, matching header=%s", matchingHeader => {
    const text = "Swallow 1 tablet whole";
    const graph = parseSig("Do not crush").meta.canonical.clauses[0].instructionGraph!;
    const raw: FhirR6DosageInstruction = { ...(matchingHeader ? { renderedInstruction: text } : {}), step: [{ component: [{
      text, extension: [buildInstructionGraphExtension(graph)!],
    }] }] };
    const rows = persist(toFhirR5Dosages(persist(raw)));
    for (const input of [persist(raw), rows, rows[0], importCanonicalCourse(persist(raw))]) {
      for (const locale of ["en", "th"] as const) for (const realizationMode of ["normalized", "roundtrip"] as const) {
        const output = formatSig(input, "long", { locale, realizationMode });
        expect(output.split(text)).toHaveLength(2);
        expect(output).toMatch(locale === "en" ? /do not crush/iu : /ห้ามบด/u);
      }
    }
    const saved = projectCanonicalCourse(importCanonicalCourse(persist(raw))).fhirNext;
    expect(saved.step![0].component[0].text).toBe(text);
    expect(saved.step![0].component[0].doseAndRate).toBeUndefined();
  });

  it("renders an upper frequency without inventing a recurrence period", () => {
    for (const daily of [false, true]) {
      const raw = course({ timing: { repeat: { frequencyMax: 2,
        ...(daily ? { period: 1, periodUnit: FhirPeriodUnit.Day } : {}) } } });
      const rows = persist(toFhirR5Dosages(persist(raw)));
      for (const input of [persist(raw), rows, rows[0], importCanonicalCourse(persist(raw))]) {
        expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toBe(
          daily ? "Use 1 tablet up to 2 times daily." : "Use 1 tablet up to 2 times.");
      }
      const repeat = projectCanonicalCourse(importCanonicalCourse(raw)).fhirNext.step![0].component[0].timing!.repeat!;
      expect(repeat.frequencyMax).toBe(2); expect(repeat.frequency).toBeUndefined();
      expect(repeat.period).toBe(daily ? 1 : undefined);
    }
  });

  it.each(["doseExpression", "rateExpression"] as const)("routes retained %s to the existing unevaluated preview", field => {
    const formula = { language: "text/fhirpath", expression: "%patient.weight * 2" };
    const raw = course({ doseAndRate: [{ [field]: formula }] });
    const rows = persist(toFhirR5Dosages(persist(raw)));
    expect((rows[0].doseAndRate![0] as FhirR6DoseAndRate)[field]).toBeUndefined();
    for (const row of [rows[0], persist(rows[0])]) {
      expect(formatSig(row, "long", { locale: "en", realizationMode: "normalized" })).toContain(formula.expression);
      expect(fromFhirDosage(row, { locale: "en", realizationMode: "normalized" }).longText).toContain(formula.expression);
      const native = importCanonicalCourse(row).stages[0].administrations[0];
      expect(native.amounts![0][field === "doseExpression" ? "expression" : "rateExpression"]).toEqual(formula);
      expect(native.amounts![0].quantity).toBeUndefined();
    }
    expect(formatSig(raw, "long", { locale: "en", realizationMode: "normalized" })).toContain(formula.expression);
  });
});

describe("round76 interchange owners", () => {
  const note = { url: "urn:clinic:round76-note", valueString: "retain this annotation" };
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day };

  it.each([false, true])("serializes spatial target translations without internal fields (translated=%s)", translated => {
    const target = { system: "http://snomed.info/sct", code: "72696002", display: "Knee region",
      id: "target-code", version: "2026", extension: [note],
      _display: { id: "target-display", extension: [note] }, clinicAnnotation: { retained: true },
      ...(translated ? { i18n: { th: "บริเวณเข่า" } } : {}) };
    const before = persist(target);
    const marker = buildBodySiteSpatialRelationExtension({ relationText: "below", targetCoding: target })!;
    const coding = marker.extension!.find(child => child.url === "target")!.valueCodeableConcept!.coding![0];
    expect(coding).not.toHaveProperty("i18n");
    expect(coding).toMatchObject({ system: target.system, code: target.code, id: target.id,
      version: target.version, extension: [note], clinicAnnotation: target.clinicAnnotation });
    expect(coding._display!.id).toBe("target-display");
    expect(coding._display!.extension).toContainEqual(note);
    expect(getPrimitiveTranslation(coding._display, "th")).toBe(translated ? "บริเวณเข่า" : undefined);
    if (!translated) expect(coding).toBe(target);
    expect(target).toEqual(before);
  });

  it("retains an independent clock annotation outside the event repeat beside its active bridge", () => {
    const bridge = { id: "authored-clock", url: TIMING_ADDITIONAL_CLOCK_EXTENSION_URL,
      valueTime: "08:00:00", _valueTime: { id: "bridge-clock", extension: [note] } };
    const independent = { id: "independent-clock-note", extension: [note] };
    const input = course({ timing: { repeat: { ...daily, when: [EventTiming["Before Breakfast"]],
      _timeOfDay: [independent], extension: [bridge] } } });
    const before = persist(input);
    let wire = r6Save(input);
    for (let save = 0; save < 2; save++) {
      const r5 = toFhirR5Dosages(persist(wire));
      for (const repeat of [wire.step![0].component[0].timing!.repeat!, r5[0].timing!.repeat!]) {
        expect(repeat.timeOfDay).toBeUndefined();
        expect(repeat._timeOfDay).toBeUndefined();
        expect(repeat.when).toEqual([EventTiming["Before Breakfast"]]);
        expect(getTimingClocks(repeat)).toEqual(["08:00:00"]);
        expect(repeat.extension).toContainEqual(bridge);
        expect(repeat.extension).toContainEqual({ url: DOSAGE_RECONCILIATION_SOURCE_URL,
          extension: [retainField("_timeOfDay", [independent])] });
      }
      wire = toDosageDetails(persist(r5));
    }
    expect(input).toEqual(before);
  });

  it.each(["unchanged", "annotation", "removed", "reordered"] as const)(
    "reuses a draft pause only while its member predecessor link owns completion (%s)", edit => {
    const phase = (member: number, predecessor?: number) => ({
      url: PARALLEL_COMPONENT_PHASE_ORIGIN_URL, extension: [
        ...(member === 1 ? encodeR6SourceMetadata("phase", { start: boundaryToWire({ anchor: "treatment-start",
          displacement: { value: 4, unit: "d" } }) }, "step").extension! : []),
        { url: "sourceMember", valueInteger: member },
        ...(predecessor === undefined ? [] : [{ url: "predecessor", valueInteger: predecessor }]),
      ],
    });
    const input: FhirR6DosageInstruction = { step: [
      { id: "initial", component: [
        { id: "old-cadence", doseAndRate: [{ doseQuantity: q(1) }],
          timing: { repeat: { ...daily, timeOfDay: ["09:00:00"],
            boundsPeriod: { start: "2026-12-05", end: "2026-12-07T00:00:00Z" } } },
          modifierExtension: [phase(0)] },
        { id: "replacement", doseAndRate: [{ doseQuantity: q(2) }],
          timing: { repeat: { ...daily, count: 1, timeOfDay: ["18:00:00"],
            boundsPeriod: { start: "2026-12-05" } } },
          modifierExtension: [phase(1, 0)] },
      ] },
      { id: "pause", end: boundaryToWire({ anchor: "treatment-start", displacement: { value: 6, unit: "d" } }), component: [] },
      { id: "resume", component: [{ id: "maintenance", doseAndRate: [{ doseQuantity: q(3) }],
        timing: { repeat: { ...daily, timeOfDay: ["09:00:00"] } } }] },
    ] };
    if (edit === "reordered") {
      input.step![0].component.push({ ...persist(input.step![0].component[0]),
        id: "other-predecessor", modifierExtension: [phase(2)] });
      input.step![0].component[1].modifierExtension![0].extension!.push({
        url: "predecessor", valueInteger: 2, id: "other-dependency",
      });
    }
    let wire = persist(r6Save(input));
    const marker = wire.step![0].component[1].modifierExtension!.find(item => item.url === PARALLEL_COMPONENT_PHASE_ORIGIN_URL)!;
    if (edit === "reordered") marker.extension!.reverse();
    if (edit === "removed") marker.extension = marker.extension!.filter(child => child.url !== "predecessor");
    if (edit === "annotation") marker.extension!.find(child => child.url === "predecessor")!.id = "dependency-note";
    for (let save = 0; save < 2; save++) {
      const before = persist(wire);
      const restored = fromDosageDetails(wire).course.step!;
      expect(restored.map(step => step.id)).toEqual(edit === "removed" ? ["initial", "resume"] : ["initial", "pause", "resume"]);
      expect(wire).toEqual(before);
      if (edit === "reordered") expect(wire.step![0].component[1].modifierExtension!
        .find(item => item.url === PARALLEL_COMPONENT_PHASE_ORIGIN_URL)).toEqual(marker);
      expect(nextDueDoses(persist(wire), { orderedAt: "2026-12-01T00:00:00Z",
        from: "2026-12-06T00:00:00Z", timeZone: "UTC", limit: 1 }))
        .toEqual([edit === "removed" ? "2026-12-06T09:00:00+00:00" : "2026-12-07T09:00:00+00:00"]);
      if (edit === "removed") {
        expect(restored[1].start?.offsetDuration).toMatchObject({ value: 6, unit: "d" });
        expect(JSON.stringify(wire)).toContain("pause");
      }
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
    }
  });

  it.each([false, true])("retires mixed historical wording and translation unless explicitly replaced (%s)", replacePrimitive => {
    const originalText = "Take 1 tablet daily";
    const translation = { url: FHIR_TRANSLATION_EXTENSION_URL, extension: [
      { url: "lang", valueCode: "th" }, { url: "content", valueString: "รับประทาน 1 เม็ดทุกวัน" },
    ] };
    const originalPrimitive = { id: "authored-instruction", extension: [note, translation] };
    const header = [{ url: "renderedInstruction", valueString: originalText },
      ...encodeR5RetainedFields({ course: { _renderedInstruction: originalPrimitive } })
        .find(item => item.url === "course")!.extension!];
    const historical: FhirDosage = { sequence: 1, text: originalText, doseAndRate: [{ doseQuantity: q(1) }],
      timing: { repeat: daily }, modifierExtension: [{
        url: DOSAGE_DETAILS_R5_URL, extension: [{ url: "dosageDetails", extension: [
          ...header, encodeR6SourceMetadata("step", { component: [{ text: originalText, doseAndRate: [{ doseQuantity: q(1) }],
            timing: { repeat: daily } }] }, "step"),
        ] }],
      }] };
    const compact = toFhirR5Dosages({ id: "compact-course",
      ...course({ doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: daily } }) })[0];
    const rows = persist([historical, compact]), before = persist(rows);
    const replacement = { id: "new-instruction", extension: [note, { ...translation, extension: [
      { url: "lang", valueCode: "th" }, { url: "content", valueString: "รับประทานตามคำสั่งใหม่" },
    ] }] };
    let wire = toDosageDetails(rows, "Follow the revised two-dose course",
      replacePrimitive ? { _renderedInstruction: replacement } : undefined);
    for (let save = 0; save < 2; save++) {
      expect(wire.renderedInstruction).toBe("Follow the revised two-dose course");
      expect(wire.step![0].component.map(member => member.doseAndRate![0].doseQuantity!.value)).toEqual([1, 2]);
      expect(getPrimitiveTranslation(wire._renderedInstruction, "th"))
        .toBe(replacePrimitive ? "รับประทานตามคำสั่งใหม่" : undefined);
      expect(wire._renderedInstruction!.extension).toContainEqual(note);
      expect(wire._renderedInstruction!.id).toBe(replacePrimitive ? "new-instruction" : "authored-instruction");
      if (!replacePrimitive) {
        const sources: FhirR6Extension[] = [];
        for (const item of wire.extension ?? [])
          if (item.url === DOSAGE_RECONCILIATION_SOURCE_URL) sources.push(...(item.extension ?? []));
        expect(sources.some(source => {
          if (source.url !== DOSAGE_DETAILS_R5_URL) return false;
          const prior: Omit<FhirR6DosageInstruction, "step"> | undefined = decodeR5RetainedFields(source).course;
          return prior?.renderedInstruction === originalText &&
            getPrimitiveTranslation(prior._renderedInstruction, "th") === "รับประทาน 1 เม็ดทุกวัน";
        })).toBe(true);
      }
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
    }
    expect(rows).toEqual(before);
  });
});

describe("round76 R6 primitive metadata contracts", () => {
  it("accepts native R6 extension values on current primitive companions and retains them", () => {
    const extension: FhirR6Extension = { url: "urn:clinic:approximate-annotation",
      valueQuantity: { value: 2, comparator: "~", unit: "cm2" } };
    const primitive = { id: "r6-primitive", extension: [extension] };
    const input: FhirR6DosageInstruction = {
      renderedInstruction: "Take 1 tablet daily", _renderedInstruction: primitive,
      safety: { _ifExceeded: primitive },
      step: [{ _count: primitive, safety: { ifExceeded: "Contact the clinic", _ifExceeded: primitive },
        component: [{ text: "Take 1 tablet daily", _text: primitive, _asNeeded: primitive,
          doseAndRate: [{ doseQuantity: q(1) }],
          safety: { _ifExceeded: primitive },
          timing: { _event: [primitive], repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
            _count: primitive, _duration: primitive, _period: primitive, _dayOfWeek: [primitive] } },
          condition: [{ code: { text: "Local condition" }, _valueString: primitive }],
          site: { reference: { reference: "BodyStructure/arm", _reference: primitive,
            identifier: { _value: primitive } } },
        }],
      }, { component: [{ doseAndRate: [{ doseQuantity: q(2) }] }] }],
    };
    const before = persist(input);
    fromFhir(input);
    let wire = r6Save(persist(input));
    for (let save = 0; save < 2; save++) {
      expect(wire._renderedInstruction).toEqual(primitive);
      expect(wire.safety?._ifExceeded).toEqual(primitive);
      expect(wire.step![0].safety?._ifExceeded).toEqual(primitive);
      expect(wire.step![0].component[0].safety?._ifExceeded).toEqual(primitive);
      expect(wire.step![0].component[0].timing!._event).toEqual([primitive]);
      expect(wire.step![0].component[0].timing!.repeat!._period).toEqual(primitive);
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
    }
    expect(input).toEqual(before);
    const strictR5: FhirDosage = { _text: { extension: [{ url: "urn:clinic:annotation",
      valueQuantity: {
        // @ts-expect-error The approximate comparator is an R6 Quantity choice.
        comparator: "~",
      } }] } };
    expect(strictR5._text!.extension![0].valueQuantity!.comparator).toBe("~");
  });

  it.each([["scalar", "primitive"], ["scalar", "element"], ["ratio", "primitive"], ["ratio", "element"]] as const)(
    "bridges a nested Quantity without changing its annotation owner (%s/%s)", (kind, placement) => {
    const unknown = { url: "urn:clinic:device", valueString: "device-A" };
    const annotation: FhirR6PrimitiveElement = { id: "dose-value-note", extension: [{
      url: "urn:clinic:estimated-area", id: "area-estimate",
      valueQuantity: { value: 2, comparator: "~", unit: "cm2",
        system: "http://unitsofmeasure.org", code: "cm2", extension: [unknown] },
    }, { url: "urn:clinic:opaque-note", valueString: "retain this" }] };
    const unit = kind === "scalar" ? "tab" : "mL";
    const quantity: FhirR6SimpleQuantity = { value: 1, unit, ...(placement === "primitive"
      ? { _value: annotation } : { id: annotation.id, extension: annotation.extension }) };
    const input = course({ doseAndRate: [kind === "scalar" ? { doseQuantity: quantity } :
      { rateRatio: { numerator: quantity, denominator: { value: 1, unit: "h" } } }] });
    const original = persist(input);
    let wire = r6Save(persist(input));
    for (let save = 0; save < 2; save++) {
      const before = persist(wire);
      const rows = toFhirR5Dosages(wire);
      expect(wire).toEqual(before);
      const amount = kind === "scalar" ? rows[0].doseAndRate![0].doseQuantity! :
        rows[0].doseAndRate![0].rateRatio!.numerator!;
      expect(amount.value).toBe(save ? 3 : 1);
      const metadata = placement === "primitive" ? amount._value! : amount;
      expect(metadata.id).toBe("dose-value-note");
      expect(metadata.extension![0]).toMatchObject({
        url: "urn:clinic:estimated-area", id: "area-estimate",
        valueQuantity: { value: 2, unit: "cm2", system: "http://unitsofmeasure.org", code: "cm2" },
      });
      const nested = metadata.extension![0].valueQuantity!;
      expect(nested.comparator).toBeUndefined();
      expect(nested.extension).toEqual([unknown, { url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
        valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000055" } }]);
      expect(metadata.extension![1]).toEqual(annotation.extension![1]);
      const fresh = persist(rows);
      const current = kind === "scalar" ? fresh[0].doseAndRate![0].doseQuantity! :
        fresh[0].doseAndRate![0].rateRatio!.numerator!;
      current.value = 3;
      const saved = persist(fresh);
      wire = toDosageDetails(fresh);
      expect(fresh).toEqual(saved);
      const nativeAmount = wire.step![0].component[0].doseAndRate![0];
      expect(kind === "scalar" ? nativeAmount.doseQuantity : nativeAmount.rateRatio!.numerator)
        .toEqual({ ...quantity, value: 3 });
      if (kind === "ratio") expect(nativeAmount.rateRatio!.denominator).toEqual({ value: 1, unit: "h" });
    }
    expect(input).toEqual(original);
    const strictR5: FhirDosage = { doseAndRate: [{ doseQuantity: { _value: { extension: [{
      url: "urn:clinic:estimated-area", valueQuantity: {
        // @ts-expect-error R5 primitive Quantity values use the operator extension for approximation.
        comparator: "~",
      },
    }] } } }] };
    expect(strictR5.doseAndRate![0].doseQuantity!._value!.extension![0].valueQuantity!.comparator).toBe("~");
  });

  it("retains unchanged opaque Quantity annotations without copying their owner", () => {
    const quantity: FhirR6Quantity = { value: 1, unit: "tab", extension: [{
      url: "urn:clinic:device", id: "dose-device", valueString: "device-A",
    }, {
      url: "urn:clinic:notes", extension: [{ url: "urn:clinic:note", valueString: "retain this" }],
    }] };
    expect(quantityForR5(quantity)).toBe(quantity);
    expect(simpleQuantityForR5(quantity)).toBe(quantity);
    expect(quantityFromWire(quantity)).toBe(quantity);
  });

  it("keeps the target version of a scalar operator's primitive source", () => {
    const annotation: FhirR6PrimitiveElement = { id: "operator-annotation", extension: [{
      url: "urn:clinic:estimated-area", id: "operator-area",
      valueQuantity: { value: 2, comparator: "~", unit: "cm2" },
    }] };
    const quantity: FhirR6Quantity = { value: 2, unit: "mg", comparator: "~", _comparator: annotation };
    const input: CanonicalCourse = { kind: "course", stages: [{ administrations: [{
      kind: "administration", amounts: [{ quantity }],
    }] }] };
    const before = persist(input);
    const native = projectCanonicalCourse(input).fhirNext;
    const scalar = native.step![0].component[0].doseAndRate![0].doseQuantity!;
    expect(scalar.comparator).toBeUndefined();
    expect(scalar.extension!.find(item => item.url === QUANTITY_OPERATOR_SOURCE_URL)?._valueCode).toEqual(annotation);
    const rows = toFhirR5Dosages(persist(native));
    const source = rows[0].doseAndRate![0].doseQuantity!.extension!
      .find(item => item.url === QUANTITY_OPERATOR_SOURCE_URL)!;
    const nested = source._valueCode!.extension![0].valueQuantity!;
    expect(nested.comparator).toBeUndefined();
    expect(nested.extension).toEqual([{ url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000055" } }]);
    const reopened = toDosageDetails(persist(rows));
    expect(quantityFromWire(reopened.step![0].component[0].doseAndRate![0].doseQuantity)?._comparator).toEqual(annotation);
    expect(reopened.step![0].component[0].doseAndRate![0].doseQuantity!.extension!
      .find(item => item.url === QUANTITY_OPERATOR_SOURCE_URL)?._valueCode).toEqual(annotation);
    expect(input).toEqual(before);
  });
});

describe("round76 action source-text metadata", () => {
  it.each(["Apply one patch", "Apply the replacement patch", ""])(
    "retains annotated action source text with its current value: %s", text => {
    const graph = { sourceText: "Apply one patch", actions: parseInstructionActions("Apply one patch") };
    const wire = JSON.parse(JSON.stringify(buildInstructionGraphExtension(graph)!)) as FhirExtension;
    const field = wire.extension!.find(child => child.url === "action")!.extension!.find(child => child.url === "sourceText")!;
    const primitive = { id: "source-string", extension: [{ url: "urn:clinic:patch-source", valueString: "retain" }] };
    field.id = "source-field";
    field._valueString = primitive;
    const before = JSON.parse(JSON.stringify(wire));
    const decoded = parseInstructionGraphExtension([wire])!;
    const edited = { ...decoded, actions: decoded.actions.map(action => ({ ...action, sourceText: text })) };
    let encoded = buildInstructionGraphExtension(edited)!;
    for (let save = 0; save < 2; save++) {
      const fields = encoded.extension!.find(child => child.url === "action")!.extension!.filter(child => child.url === "sourceText");
      expect(fields).toEqual([{ url: "sourceText", ...(text ? { valueString: text } : {}), id: "source-field", _valueString: primitive }]);
      expect(parseInstructionGraphExtension([encoded])!.actions[0].sourceText).toBe(text);
      encoded = buildInstructionGraphExtension(parseInstructionGraphExtension([JSON.parse(JSON.stringify(encoded))])!)!;
    }
    expect(wire).toEqual(before);
  });
});


describe("round76 typed action complements in normalized previews", () => {
  const fresh = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
  const current = (value: string, locale: string) => value
    .split(locale === "en" ? "; original directions: " : "; ข้อความเดิม: ")[0]
    .replace(locale === "en" ? /^Current: /u : /^ปัจจุบัน: /u, "");

  it.each([
    { source: "Remove patch at bedtime.", action: "remove", role: AdviceArgumentRole.Time,
      relation: AdviceRelation.On, en: ["Remove patch at bedtime"], th: ["เอาแผ่นแปะออกก่อนนอน"] },
    { source: "Close eye and press inner corner for 1 minute.", action: "close", role: AdviceArgumentRole.Site,
      relation: undefined, en: ["Close the eye", "press inner corner for 1 minute"], th: ["หลับตา", "press inner corner for 1 minute"] },
    { source: "Repeat in the other eye.", action: "repeat", role: AdviceArgumentRole.Object,
      relation: AdviceRelation.In, en: ["Repeat in the other eye"], th: ["Repeat in the other eye"] },
    { source: "Shake suspension well before each dose; discard after 14 days.", action: "shake", role: AdviceArgumentRole.Time,
      relation: AdviceRelation.Before, en: ["Shake suspension well before each dose", "discard after 14 days"],
      th: ["เขย่าsuspension wellก่อนการให้ยาแต่ละครั้ง", "ทิ้งหลัง 14 วัน"] },
  ])("retains the owned complements of $action across native and saved wire views", fixture => {
    const parsed = parsePublicSig(fixture.source);
    const graph = parsed.meta.canonical.clauses[0].instructionGraph!;
    const frame = graph.actions.find(value => value.predicate.lemma === fixture.action)!;
    expect(frame.relation).toBe(fixture.relation);
    expect(frame.args.some(arg => arg.role === fixture.role)).toBe(true);
    if (fixture.action === "remove") expect(frame.args).toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Time, normalized: "HS" }));
    if (fixture.action === "close") {
      expect(frame.args).toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Site, coding: expect.objectContaining({ code: "81745001" }) }));
      expect(graph.actions[1].args).toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Duration, quantity: { value: 1, unit: "min" } }));
    }
    if (fixture.action === "repeat") expect(frame.args).toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Object, text: "the other eye" }));
    if (fixture.action === "shake") expect(frame.args).toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Time, conceptId: "each-dose" }));
    for (const input of [parsed.meta.canonical.course!, fresh(parsed.fhir), fresh(parsed.fhirNext), fresh(toFhirR5Dosages(parsed.fhirNext))]) {
      const before = JSON.stringify(input);
      for (const locale of ["en", "th"] as const) {
        const displayed = current(formatSig(input, "long", { locale, realizationMode: "normalized" }), locale);
        for (const phrase of fixture[locale]) expect(displayed).toContain(phrase);
        if (fixture.action === "close" && locale === "th") expect(displayed).not.toContain("หลับตาตา");
        if (fixture.action === "shake" && locale === "en") expect(displayed).not.toContain("at each dose");
      }
      const restored = importCanonicalCourse(input).stages[0].administrations[0].syntax!.instructionGraph!;
      expect(restored.sourceText).toBe(fixture.source);
      expect(restored.actions.find(value => value.predicate.lemma === fixture.action)!.args.some(arg => arg.role === fixture.role)).toBe(true);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["Remove patch for 12 hours", "เอาแผ่นแปะออกนาน 12 ชั่วโมง"])(
    "retains the typed removal duration and its licensed relation: %s", source => {
      const parsed = parsePublicSig(source);
      const frame = parsed.meta.canonical.clauses[0].instructionGraph!.actions[0];
      expect(frame.relation).toBe(AdviceRelation.For);
      expect(frame.args).toContainEqual(expect.objectContaining({
        role: AdviceArgumentRole.Duration, quantity: { value: 12, unit: "h" }
      }));
      for (const input of [parsed.meta.canonical.course!, fresh(parsed.fhir), fresh(parsed.fhirNext), fresh(toFhirR5Dosages(parsed.fhirNext))]) {
        expect(current(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }), "en").replace(/\.$/u, ""))
          .toBe("Remove patch for 12 hours");
        expect(current(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }), "th").replace(/\.$/u, ""))
          .toBe("เอาแผ่นแปะออกเป็นเวลา 12 ชั่วโมง");
        expect(importCanonicalCourse(input).stages[0].administrations[0].syntax!.instructionGraph!.sourceText).toBe(source);
      }
    });

  it.each([["right", "1290032005", "ตาขวา"], ["left", "1290031003", "ตาซ้าย"]] as const)(
    "keeps the %s eye explicit when the Thai head entails only generic eye", (side, code, thai) => {
      const parsed = parsePublicSig("Close " + side + " eye");
      const site = parsed.meta.canonical.clauses[0].instructionGraph!.actions[0].args.find(arg => arg.role === AdviceArgumentRole.Site)!;
      expect(site.conceptId).toBe(side + " eye");
      expect(site.coding).toMatchObject({ code });
      for (const input of [parsed.meta.canonical.course!, fresh(parsed.fhir), fresh(parsed.fhirNext), fresh(toFhirR5Dosages(parsed.fhirNext))]) {
        expect(current(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }), "en").replace(/\.$/u, ""))
          .toBe("Close the " + side + " eye");
        expect(current(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }), "th").replace(/\.$/u, ""))
          .toBe("หลับตา (" + thai + ")");
      }
    });

  it("keeps a configured closing head's explicit site when that label does not entail it", () => {
    const parsed = parsePublicSig("Shut eye", { instructionActionMap: { shut: {
      code: "close", display: "Shut", semanticClass: "manipulate", i18n: { th: "ปิด" }, aliases: ["shut"],
      procedural: true, argumentParser: "bare-duration", realizer: "duration"
    } } });
    const frame = parsed.meta.canonical.clauses[0].instructionGraph!.actions[0];
    expect(frame.predicate.display).toBe("Shut");
    expect(frame.args).toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Site, conceptId: "eye" }));
    for (const input of [fresh(parsed.fhir), fresh(parsed.fhirNext), fresh(toFhirR5Dosages(parsed.fhirNext))]) {
      expect(current(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }), "en")).toContain("Shut the eye");
      expect(current(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }), "th")).toContain("ปิดตา");
    }
  });
});


describe("round77 procedure target beside duration and time", () => {
  const current = (value: string, locale: "en" | "th") => value
    .split(locale === "en" ? "; original directions: " : "; ข้อความเดิม: ")[0]
    .replace(locale === "en" ? /^Current: /u : /^ปัจจุบัน: /u, "")
    .replace(/\.$/u, "");
  it.each([
    { source: "Close right eye for 1 minute after each dose", side: "right", code: "1290032005", duration: 1,
      event: "each dose", relation: AdviceRelation.After,
      en: "Close the right eye for 1 minute after each dose", th: "หลับตา (ตาขวา) 1 นาทีหลังการให้ยาแต่ละครั้ง" },
    { source: "Close left eye 1 minute", side: "left", code: "1290031003", duration: 1,
      event: undefined, relation: undefined,
      en: "Close the left eye for 1 minute", th: "หลับตา (ตาซ้าย) 1 นาที" },
    { source: "Close right eye at bedtime", side: "right", code: "1290032005", duration: undefined,
      event: "bedtime", relation: AdviceRelation.On,
      en: "Close the right eye at bedtime", th: "หลับตา (ตาขวา)ก่อนนอน" },
  ])("retains the selected eye with independent complements: $source", fixture => {
    const parsed = parsePublicSig(fixture.source);
    const frame = parsed.meta.canonical.clauses[0].instructionGraph!.actions[0];
    expect(frame.predicate.lemma).toBe("close");
    expect(frame.args.find(arg => arg.role === AdviceArgumentRole.Site)).toMatchObject({
      conceptId: fixture.side + " eye", coding: { code: fixture.code }
    });
    expect(frame.args.find(arg => arg.role === AdviceArgumentRole.Duration)?.quantity)
      .toEqual(fixture.duration === undefined ? undefined : { value: fixture.duration, unit: "min" });
    const time = frame.args.find(arg => arg.role === AdviceArgumentRole.Time);
    expect(time?.normalized).toBe(fixture.event);
    expect(time?.relation ?? frame.relation).toBe(fixture.relation);
    for (const input of [parsed.meta.canonical.course!, persist(parsed.fhir), persist(parsed.fhirNext),
      persist(toFhirR5Dosages(parsed.fhirNext))]) {
      const before = JSON.stringify(input);
      for (const locale of ["en", "th"] as const)
        expect(current(formatSig(input, "long", { locale, realizationMode: "normalized" }), locale)).toBe(fixture[locale]);
      const administration = importCanonicalCourse(input).stages[0].administrations[0];
      expect(administration.amounts).toBeUndefined();
      expect(administration.syntax!.instructionGraph!.sourceText).toBe(fixture.source);
      expect(JSON.stringify(input)).toBe(before);
    }
  });
});


describe("round77 independent advice and selected Time ownership", () => {
  const current = (value: string, locale: "en" | "th") => value
    .split(locale === "en" ? "; original directions: " : "; ข้อความเดิม: ")[0]
    .replace(locale === "en" ? /^Current: /u : /^ปัจจุบัน: /u, "")
    .replace(/\.$/u, "");

  it.each([false, true])("keeps an independent warning outside the administration guard (dose=%s)", withDose => {
    const source = persist(parsePublicSig("1 tab only if SBP > 160").fhirNext);
    const component = source.step![0].component[0];
    delete source.renderedInstruction;
    delete component.text;
    if (!withDose) delete component.doseAndRate;
    component.additionalInstruction = [{ text: "Do not crush", _text: { extension: [{
      url: FHIR_TRANSLATION_EXTENSION_URL, extension: [
        { url: "lang", valueCode: "th" }, { url: "content", valueString: "ห้ามบด" }
      ]
    }] } }];
    for (const input of [source, importCanonicalCourse(source), persist(toFhirR5Dosages(source)),
      persist(toDosageDetails(toFhirR5Dosages(source)))]) {
      const before = JSON.stringify(input);
      for (const locale of ["en", "th"] as const) {
        const text = current(formatSig(input, "long", { locale, realizationMode: "normalized" }), locale);
        const guard = locale === "en" ? "Use" + (withDose ? " 1 tablet" : "") + " only if SBP > 160"
          : "ใช้" + (withDose ? "ครั้งละ 1 เม็ด" : "") + " เฉพาะเมื่อ SBP > 160";
        const warning = locale === "en" ? "Do not crush" : "ห้ามบด";
        expect(text).toBe(guard + ". " + warning);
      }
      expect(importCanonicalCourse(input).stages[0].administrations[0].predicate).toMatchObject({ kind: "measurement", value: 160 });
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it("preserves a disjunctive meal complement without promoting breakfast to the sole event", () => {
    const source = "Rinse mouth 15 mL after breakfast or dinner";
    const parsed = parsePublicSig(source);
    const frame = parsed.meta.canonical.clauses[0].instructionGraph!.actions[0];
    expect(frame.args.filter(arg => arg.role === AdviceArgumentRole.Time)).toHaveLength(0);
    expect(frame.args).toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Activity, text: "breakfast or dinner" }));
    expect(frame.relation).toBe(AdviceRelation.After);
    expect(parsed.meta.canonical.clauses[0].schedule?.when ?? []).not.toContain(EventTiming["After Breakfast"]);
    for (const input of [parsed.meta.canonical.course!, persist(parsed.fhir), persist(parsed.fhirNext), persist(toFhirR5Dosages(parsed.fhirNext))]) {
      for (const locale of ["en", "th"] as const) {
        const text = current(formatSig(input, "long", { locale, realizationMode: "normalized" }), locale);
        expect(text).toContain((locale === "en" ? "after " : "หลัง") + "breakfast or dinner");
        expect(text).toContain(locale === "en" ? "15 mL" : "15 มิลลิลิตร");
      }
      expect(importCanonicalCourse(input).stages[0].administrations[0].syntax!.instructionGraph!.sourceText).toBe(source);
    }
  });

  it.each(["breakfast", "breakfast and dinner"])("retains supported conjunctive Time daughters for %s", event => {
    const parsed = parsePublicSig("Rinse mouth 15 mL after " + event);
    const times = parsed.meta.canonical.clauses[0].instructionGraph!.actions[0].args.filter(arg => arg.role === AdviceArgumentRole.Time);
    expect(times.map(arg => arg.normalized)).toEqual(event === "breakfast" ? ["CM"] : ["CM", "CV"]);
    for (const locale of ["en", "th"] as const) {
      const text = formatSig(persist(parsed.fhirNext), "long", { locale, realizationMode: "normalized" });
      expect(text).toContain(locale === "en" ? "after breakfast" : "หลังอาหารเช้า");
      if (times.length === 2) expect(text).toContain(locale === "en" ? "after dinner" : "หลังอาหารเย็น");
    }
  });

  it.each([
    { suffix: "at bedtime", events: ["HS"], en: "Rub to form foam at bedtime", th: "ถูให้เกิดฟองก่อนนอน" },
    { suffix: "before breakfast and before dinner", events: ["CM", "CV"],
      en: "Rub to form foam before breakfast before dinner", th: "ถูให้เกิดฟองก่อนอาหารเช้าก่อนอาหารเย็น" }
  ])("realizes a result action's typed Time: $suffix", fixture => {
    const source = "Rub to form foam " + fixture.suffix;
    const parsed = parsePublicSig(source);
    const frame = parsed.meta.canonical.clauses[0].instructionGraph!.actions[0];
    expect(frame.args.find(arg => arg.role === AdviceArgumentRole.Result)?.conceptId).toBe("foam");
    expect(frame.args.filter(arg => arg.role === AdviceArgumentRole.Time).map(arg => arg.normalized)).toEqual(fixture.events);
    for (const input of [parsed.meta.canonical.course!, persist(parsed.fhir), persist(parsed.fhirNext), persist(toFhirR5Dosages(parsed.fhirNext))]) {
      for (const locale of ["en", "th"] as const)
        expect(current(formatSig(input, "long", { locale, realizationMode: "normalized" }), locale)).toBe(fixture[locale]);
      const administration = importCanonicalCourse(input).stages[0].administrations[0];
      expect(administration.amounts).toBeUndefined();
      expect(administration.syntax!.instructionGraph!.sourceText).toBe(source);
    }
  });

  it("exports requested uncoded advice translations from the existing typed realization", () => {
    const source = "Take 1 tablet daily, do not lie down immediately";
    const parsed = parsePublicSig(source, { locale: "th" });
    for (const instruction of [parsed.fhir[0].additionalInstruction![0], parsed.fhirNext.step![0].component[0].additionalInstruction![0],
      toFhirR5Dosages(persist(parsed.fhirNext))[0].additionalInstruction![0]]) {
      expect(instruction.text).toBe("do not lie down immediately");
      expect(instruction.coding).toBeUndefined();
      expect(getPrimitiveTranslation(instruction._text, "th")).toBe("ห้ามนอนราบทันที");
    }
    expect(parsePublicSig(source).fhir[0].additionalInstruction![0]._text).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0].dose).toMatchObject({ value: 1, unit: "tab" });
    expect(parsed.meta.canonical.clauses[0].schedule).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
  });
});


describe("round77 selected procedural definition", () => {
  it("keeps the selected Rinse procedure when another configured action shares its code", () => {
    const parsed = parsePublicSig("Rinse the left eye daily", { instructionActionMap: { inspect: {
      code: "rinse", display: "Inspect", aliases: ["inspect"], procedural: false
    } } });
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.instructionGraph!.actions[0].predicate).toMatchObject({ lemma: "rinse", display: "Rinse" });
    expect(clause.method?.text).toBe("Rinse");
    expect(clause.site?.coding?.code).toBe("1290031003");
    expect(clause.schedule).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
    expect(clause.patientInstruction).toBeUndefined();
    for (const input of [persist(parsed.fhir), persist(parsed.fhirNext), persist(toFhirR5Dosages(parsed.fhirNext))]) {
      for (const locale of ["en", "th"] as const) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        expect(text).toContain(locale === "en" ? "left eye" : "ตาซ้าย");
        expect(text).not.toContain("Inspect");
      }
    }
  });
});

describe("round78 interchange owner contracts", () => {
  it("keeps R6 Quantity annotations on both period offsets through fresh saves", () => {
    const annotation: FhirR6PrimitiveElement = { id: "offset-unit-note", extension: [{
      url: "urn:clinic:estimated-area", id: "offset-area",
      valueQuantity: { value: 2, unit: "cm2", comparator: "~" },
    }] };
    const startOffset = { value: 2, unit: "d", _unit: annotation };
    const endOffset = { value: 3, unit: "d", _unit: annotation };
    const timing: FhirR6Timing = { repeat: {
      frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Week, startOffset, endOffset,
    } };
    const input = course({ timing }), before = persist(input);
    let wire = persist(input);
    for (let save = 0; save < 2; save++) {
      const saved = persist(wire);
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      expect(saved.step![0].component[0].timing!.repeat!.startOffset).toEqual(startOffset);
      expect(wire.step![0].component[0].timing!.repeat!.startOffset).toEqual(startOffset);
      expect(wire.step![0].component[0].timing!.repeat!.endOffset).toEqual(endOffset);
    }
    expect(input).toEqual(before);
    const invalid: FhirR6Timing = { repeat: { startOffset: {
      // @ts-expect-error A period offset is SimpleQuantity, even in R6.
      comparator: "~",
    } } };
    expect(invalid.repeat!.startOffset!.comparator).toBe("~");
  });

  it.each([true, false])("imports an explicit R5 PRN field with lifted safety (asNeeded=%s)", prn => {
    const row = { asNeededBoolean: prn, safety: { ifExceeded: "Hold the next dose" },
      extension: [{ url: "urn:clinic:prn-note", valueString: "retain source" }] };
    const before = persist(row);
    for (const input of [row, [persist(row)]]) {
      const native = importCanonicalCourse(input);
      expect(native.stages).toHaveLength(1);
      expect(native.stages[0].administrations).toHaveLength(1);
      expect(native.stages[0].administrations[0].asNeeded).toBe(prn);
      expect(native.stages[0].administrations[0].safety?.ifExceeded).toBe("Hold the next dose");
      const wire = projectCanonicalCourse(native).fhirNext;
      expect(wire.step![0].component[0].safety?.ifExceeded).toBe("Hold the next dose");
      expect(wire.step![0].component[0].extension).toContainEqual(row.extension[0]);
      const reopened = importCanonicalCourse(persist(toFhirR5Dosages(wire)));
      expect(reopened.stages[0].administrations[0].asNeeded).toBe(prn);
      expect(reopened.stages[0].administrations[0].safety?.ifExceeded).toBe("Hold the next dose");
    }
    expect(importCanonicalCourse({ safety: row.safety }).stages).toEqual([]);
    expect(row).toEqual(before);
  });

  it("retains the Element ID and current facts of a complete graph argument", () => {
    const text = "Take 1 tablet with 100 mL water";
    const wire = persist(buildInstructionGraphExtension({
      sourceText: text, actions: parseInstructionActions(text),
    })!);
    const action = wire.extension!.find(item => item.url === "action")!;
    const water = action.extension!.find(item => item.url === "argument" &&
      item.extension?.some(field => field.url === "text" && field.valueString?.includes("water")))!;
    expect(water).toBeDefined();
    water.id = "water-argument";
    water.extension!.push({ url: "urn:clinic:water-note", valueString: "retain this" });
    const before = persist(wire);
    let encoded = buildInstructionGraphExtension(parseInstructionGraphExtension([wire])!)!;
    for (let save = 0; save < 2; save++) {
      expect(encoded.extension!.find(item => item.url === "action")!.extension!
        .filter(item => item.url === "argument")).toEqual(action.extension!.filter(item => item.url === "argument"));
      encoded = buildInstructionGraphExtension(parseInstructionGraphExtension([persist(encoded)])!)!;
    }
    expect(wire).toEqual(before);
  });
});

describe("round78 configured spatial Coding", () => {
  it("keeps declared target identity with a default system", () => {
    const note = { url: "urn:clinic:target-note", valueString: "retain" };
    const targetCoding = { id: "spatial-target", extension: [note], code: "181299001", display: "Entire nose" };
    const marker = buildBodySiteSpatialRelationExtension({ relationText: "below", targetCoding })!;
    const target = marker.extension!.find(item => item.url === "target")!.valueCodeableConcept!;
    expect(target.coding).toEqual([{ id: "spatial-target", extension: [note],
      system: "http://snomed.info/sct", code: "181299001", display: "Entire nose" }]);
    expect(parseBodySiteSpatialRelationExtension({ extension: [persist(marker)] })!.targetCoding)
      .toEqual(target.coding![0]);
    expect(targetCoding.code).toBe("181299001");
    expect(targetCoding.extension).toEqual([note]);
  });
});

describe("round78 graph argument field metadata", () => {
  it.each([false, true])("preserves recognized field annotations while the current role wins (edited=%s)", edited => {
    const source = "Take 1 tablet with 100 mL water";
    const marker = persist(buildInstructionGraphExtension({
      sourceText: source, sourceLocale: "en", actions: parseInstructionActions(source),
    })!);
    const action = marker.extension!.find(item => item.url === "action")!;
    const argument = action.extension!.filter(item => item.url === "argument").find(item =>
      item.extension!.some(field => field.url === "quantity" && field.extension!.some(child =>
        child.url === "unit" && child.valueString === "mL")))!;
    argument.id = "water-argument";
    argument.extension!.push({ url: "urn:clinic:argument-note", valueString: "retain" });
    const role = argument.extension!.find(item => item.url === "role")!;
    role.id = "role-owner";
    role._valueCode = { id: "role-value", extension: [{ url: "urn:clinic:role-note", valueString: "retain" }] };
    const text = argument.extension!.find(item => item.url === "text")!;
    text.id = "text-owner";
    text._valueString = { id: "text-value", extension: [{ url: "urn:clinic:text-note", valueString: "retain" }] };
    const original = persist(marker);
    let graph = persist(parseInstructionGraphExtension([marker])!);
    const current = graph.actions[0].args.find(item => item.quantity?.unit === "mL")!;
    if (edited) current.role = AdviceArgumentRole.Destination;
    const expected = persist(argument);
    if (edited) expected.extension!.find(item => item.url === "role")!.valueCode = AdviceArgumentRole.Destination;
    for (let save = 0; save < 2; save++) {
      const before = persist(graph), output = buildInstructionGraphExtension(graph)!;
      const saved = output.extension!.find(item => item.url === "action")!.extension!
        .find(item => item.url === "argument" && item.id === "water-argument")!;
      expect(saved).toEqual(expected);
      expect(saved.extension!.filter(item => item.url === "role")).toHaveLength(1);
      expect(graph).toEqual(before);
      graph = persist(parseInstructionGraphExtension([persist(output)])!);
    }
    expect(marker).toEqual(original);
  });
});


describe("round78 scoped additional-instruction translations", () => {
  it.each([
    { source: "If skin irritation occurs, do not apply the patch",
      en: "If skin irritation occurs, do not apply patch", th: "If skin irritation occurs ห้ามทาแผ่นแปะ" },
    { source: "Do not apply the patch if skin irritation occurs",
      en: "Do not apply patch if skin irritation occurs", th: "ห้ามทาแผ่นแปะ if skin irritation occurs" },
    { source: "หากมีอาการระคายเคือง ห้ามตัดแผ่นแปะ",
      en: "หากมีอาการระคายเคือง, do not cut patch", th: "หากมีอาการระคายเคือง ห้ามตัดแผ่นแปะ" }
  ])("keeps the complete condition and negation: $source", fixture => {
    const parsed = parsePublicSig(fixture.source, { locale: "th" });
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    const graph = parsed.meta.canonical.clauses[0].instructionGraph!;
    expect(graph.relations).toContainEqual(expect.objectContaining({ kind: AdviceRelation.If, toActionIndex: 0 }));
    expect(graph.actions[0].polarity).toBe("negate");
    for (const instruction of [parsed.fhir[0].additionalInstruction![0], parsed.fhirNext.step![0].component[0].additionalInstruction![0],
      toFhirR5Dosages(persist(parsed.fhirNext))[0].additionalInstruction![0]]) {
      expect(instruction.text).toBe(fixture.source);
      expect(instruction.coding).toBeUndefined();
      for (const locale of ["en", "th"] as const)
        expect(getPrimitiveTranslation(instruction._text, locale)).toBe(fixture[locale]);
    }
    for (const input of [parsed.meta.canonical.course!, persist(parsed.fhir), persist(parsed.fhirNext)])
      expect(importCanonicalCourse(input).stages[0].administrations[0].syntax!.instructionGraph!.sourceText).toBe(fixture.source);
  });

  it("keeps a second warning independent from the first warning's condition", () => {
    const parsed = parsePublicSig("If skin irritation occurs, do not apply the patch; do not lie down immediately", { locale: "th" });
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    const graph = parsed.meta.canonical.clauses[0].instructionGraph!;
    expect(graph.relations).toEqual([expect.objectContaining({ kind: AdviceRelation.If, toActionIndex: 0 })]);
    for (const instructions of [parsed.fhir[0].additionalInstruction!, parsed.fhirNext.step![0].component[0].additionalInstruction!,
      toFhirR5Dosages(persist(parsed.fhirNext))[0].additionalInstruction!]) {
      expect(instructions).toHaveLength(2);
      expect(getPrimitiveTranslation(instructions[0]._text, "en")).toBe("If skin irritation occurs, do not apply patch");
      expect(getPrimitiveTranslation(instructions[0]._text, "th")).toBe("If skin irritation occurs ห้ามทาแผ่นแปะ");
      expect(instructions[1].text).toBe("do not lie down immediately");
      expect(getPrimitiveTranslation(instructions[1]._text, "en")).toBe("Do not lie down immediately");
      expect(getPrimitiveTranslation(instructions[1]._text, "th")).toBe("ห้ามนอนราบทันที");
    }
  });
});

describe("round79 graph wrapper identity", () => {
  it.each([false, true])("preserves graph and action Element IDs through the public codec (annotated=%s)", annotated => {
    const source = "Take 1 tablet with 100 mL water";
    const marker = persist(buildInstructionGraphExtension({
      sourceText: source, sourceLocale: "en", actions: parseInstructionActions(source),
    })!);
    const action = marker.extension!.find(item => item.url === "action")!;
    const argument = action.extension!.find(item => item.url === "argument")!;
    if (annotated) {
      marker.id = "instruction-graph";
      action.id = "take-action";
      argument.id = "water-argument";
      marker.extension!.push({ url: "urn:clinic:graph-note", valueString: "retain graph" });
      action.extension!.push({ url: "urn:clinic:action-note", valueString: "retain action" });
    }
    const original = persist(marker);
    let current = marker;
    for (let save = 0; save < 2; save++) {
      const graph = parseInstructionGraphExtension([persist(current)])!, before = persist(graph);
      current = buildInstructionGraphExtension(graph)!;
      expect(current).toStrictEqual(original);
      expect(graph).toEqual(before);
    }
    const rows = toFhirR5Dosages(toDosageDetails(persist([{ extension: [marker] }])));
    expect(rows[0].extension!.find(item => item.url === marker.url)).toEqual(original);
    expect(marker).toEqual(original);
  });
});

describe("round80 interchange ownership", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] };
  const afterDays = (value: number) => boundaryToWire({ anchor: "treatment-start", displacement: { value, unit: "d" } });

  it.each(["anonymous", "identified", "distinct projection", "same policy"] as const)(
    "restores only an identified surviving safety action (%s)", identity => {
    const actions = ["Hold the next dose", identity === "same policy" ? "Hold the next dose" : "Call the clinic"];
    const amounts = [1, identity === "distinct projection" ? 2 : 1];
    const components: FhirR6Dosage[] = actions.map((ifExceeded, index) => ({
      ...(identity === "identified" ? { id: index ? "survivor" : "removed" } : {}),
      doseAndRate: [{ doseQuantity: q(amounts[index]) }], timing: { repeat: daily },
      safety: { doseLimit: [{ scope: "administration", valueQuantity: q(3) }], ifExceeded },
    }));
    const marker: FhirExtension = { url: DOSAGE_DETAILS_R5_URL, extension: [{ url: "dosageDetails",
      extension: [encodeR6SourceMetadata("step", { component: components }, "step")] }] };
    const rows: FhirDosage[] = [{ sequence: 1, ...(identity === "identified" ? { id: "survivor" } : {}),
      doseAndRate: [{ doseQuantity: q(amounts[1]) }], timing: { repeat: daily },
      maxDosePerAdministration: q(3), modifierExtension: [marker] }];
    const before = persist(rows);
    let wire = toDosageDetails(rows);
    for (let save = 0; save < 2; save++) {
      expect(wire.step![0].component).toHaveLength(1);
      const member = wire.step![0].component[0];
      expect(member.doseAndRate![0].doseQuantity).toEqual(q(amounts[1]));
      expect(member.safety?.doseLimit).toEqual([{ scope: "administration", valueQuantity: q(3) }]);
      expect(member.safety?.ifExceeded).toBe(identity === "anonymous" ? undefined : actions[1]);
      if (identity === "anonymous") for (const action of actions)
        expect(JSON.stringify(wire.extension)).toContain(action);
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
    }
    expect(rows).toEqual(before);
  });

  it.each(["unchanged", "annotation", "swapped"] as const)(
    "keeps a saved pause only while the selected induction branch owns completion (%s)", edit => {
    const initial: FhirR6Dosage[] = [1, 2].map((days, index) => {
      const member: FhirR6Dosage = { id: "dose-" + index, doseAndRate: [{ doseQuantity: q(1) }],
        timing: { repeat: { ...daily, boundsDuration: { value: days, unit: "d" } } } };
      setDosageAlternativeChoice(member, { groupId: "induction-choice", branchId: index ? "long" : "short",
        selectionBehavior: "exactly-one" });
      return member;
    });
    const source = r6Save({ step: [
      { id: "induction", component: initial },
      { id: "pause", end: afterDays(2), component: [] },
      { id: "maintenance", component: [{ id: "steady", doseAndRate: [{ doseQuantity: q(2) }],
        timing: { repeat: daily } }] },
    ] });
    let wire = persist(source);
    if (edit === "swapped") for (let index = 0; index < 2; index++)
      setDosageAlternativeChoice(wire.step![0].component[index], { groupId: "induction-choice",
        branchId: index ? "short" : "long", selectionBehavior: "exactly-one" });
    if (edit === "annotation") wire.step![0].component[0].modifierExtension![0].extension![1].id = "branch-note";
    const before = persist(wire);
    for (let save = 0; save < 2; save++) {
      const restored = fromDosageDetails(persist(wire)).course.step!;
      expect(restored.map(step => step.id)).toEqual(edit === "swapped"
        ? ["induction", "maintenance"] : ["induction", "pause", "maintenance"]);
      expect(nextDueDoses(persist(wire), { orderedAt: "2026-12-01T00:00:00Z",
        from: "2026-12-03T00:00:00Z", timeZone: "UTC", limit: 1,
        alternativeChoices: { "induction-choice": "short" } })).toEqual(["2026-12-03T09:00:00+00:00"]);
      if (edit === "swapped") {
        expect(restored[1].start?.offsetDuration).toMatchObject({ value: 2, unit: "d" });
        expect(JSON.stringify(wire.extension)).toContain("pause");
      }
      if (save === 0) expect(wire).toEqual(before);
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
    }
    expect(source.step![0].component.map(member => member.timing!.repeat!.boundsDuration!.value)).toEqual([1, 2]);
  });

  it.each([false, true])("keeps companion-only clocks without inventing values (event anchor %s)", anchored => {
    const metadata = { id: "clock-note", extension: [{ url: "urn:clinic:clock-note", valueString: "authored" }] };
    const source = course({ timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
      ...(anchored ? { when: [EventTiming["Before Breakfast"]] } : {}), _timeOfDay: [metadata] } } });
    const original = persist(source);
    let wire = r6Save(source);
    for (let save = 0; save < 2; save++) {
      const rows = toFhirR5Dosages(persist(wire));
      for (const repeat of [wire.step![0].component[0].timing!.repeat!, rows[0].timing!.repeat!]) {
        expect(getTimingClocks(repeat) ?? []).toEqual([]);
        expect(repeat.timeOfDay).toBeUndefined();
        if (anchored) {
          expect(repeat._timeOfDay).toBeUndefined();
          expect(repeat.when).toEqual([EventTiming["Before Breakfast"]]);
          expect(repeat.extension).toContainEqual({ url: TIMING_ADDITIONAL_CLOCK_EXTENSION_URL, _valueTime: metadata });
        } else {
          expect(repeat._timeOfDay).toEqual([metadata]);
          expect(repeat.extension?.some(item => item.url === TIMING_ADDITIONAL_CLOCK_EXTENSION_URL)).not.toBe(true);
        }
      }
      wire = toDosageDetails(persist(rows));
    }
    expect(source).toEqual(original);
  });

  it("keeps an authored zero frequency through the parser-state wire boundary", () => {
    const marker = { url: TIMING_FREQUENCY_MIN_EXTENSION_URL, valueInteger: 0 };
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: {
      frequencyMax: 2, period: 1, periodUnit: FhirPeriodUnit.Day, extension: [marker,
        { url: TIMING_ADDITIONAL_CLOCK_EXTENSION_URL, valueTime: "08:00:00" },
        { url: TIMING_ADDITIONAL_CLOCK_EXTENSION_URL, valueTime: "20:00:00" }],
    } } };
    const before = persist(row);
    const state = parserStateFromFhir(row);
    expect(state.frequency).toBe(0);
    const output = parserStateToFhir(state);
    expect(output.timing!.repeat!.frequency).toBeUndefined();
    expect(output.timing!.repeat!.frequencyMax).toBe(2);
    expect(output.timing!.repeat!.extension).toContainEqual(marker);
    expect(getTimingClocks(output.timing!.repeat)).toEqual(["08:00:00", "20:00:00"]);
    expect(row).toEqual(before);
    const noMinimum = persist(row);
    noMinimum.timing!.repeat!.extension!.shift();
    expect(parserStateToFhir(parserStateFromFhir(noMinimum)).timing!.repeat!.frequency).toBe(2);
  });

  it.each(["unchanged", "changed", "cleared"] as const)(
    "preserves normalized argument annotations with the current typed value (%s)", edit => {
    const actions = parseInstructionActions("Drink water");
    const source = buildInstructionGraphExtension({ sourceText: "Drink water", actions })!;
    const argument = source.extension!.find(child => child.url === "action")!.extension!
      .find(child => child.url === "argument" && child.extension?.some(field => field.url === "normalized" && field.valueString === "water"))!;
    const field = argument.extension!.find(child => child.url === "normalized")!;
    field.id = "normalized-water";
    field._valueString = { extension: [{ url: FHIR_TRANSLATION_EXTENSION_URL, extension: [
      { url: "lang", valueCode: "th" }, { url: "content", valueString: "น้ำ" },
    ] }, { url: "urn:clinic:term-note", valueString: "known water" }] };
    const original = persist(source), decoded = parseInstructionGraphExtension([source])!;
    const fresh = persist(decoded);
    const target = fresh.actions[0].args.find(value => value.normalized === "water")!;
    if (edit === "changed") target.normalized = "saline";
    if (edit === "cleared") delete target.normalized;
    let rebuilt = buildInstructionGraphExtension(fresh)!;
    for (let save = 0; save < 2; save++) {
      const current = rebuilt.extension!.find(child => child.url === "action")!.extension!
        .find(child => child.url === "argument" && child.extension?.some(value => value.url === "text" && value.valueString === target.text))!;
      const active = current.extension!.find(value => value.url === "normalized");
      if (edit === "cleared") {
        expect(active).toBeUndefined();
        expect(current.extension).toContainEqual({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [field] });
      } else expect(active).toEqual({ ...field, valueString: edit === "changed" ? "saline" : "water" });
      const reread = parseInstructionGraphExtension([persist(rebuilt)])!;
      expect(reread.actions[0].args.find(value => value.text === target.text)!.normalized)
        .toBe(edit === "cleared" ? undefined : edit === "changed" ? "saline" : "water");
      rebuilt = buildInstructionGraphExtension(reread)!;
    }
    expect(source).toEqual(original);
  });

  it.each([false, true])("retains ownership annotations when the dose binding is cleared (%s)", clear => {
    const source = buildInstructionGraphExtension({ sourceText: "Take 2 tablets", actions: parseInstructionActions("Take 2 tablets"),
      primaryOwnership: { administrationActionIndex: 0, dose: { actionIndex: 0, argumentIndex: 0 } } })!;
    const ownership = source.extension!.find(child => child.url === "primaryOwnership")!;
    const field = ownership.extension!.find(child => child.url === "doseArgumentIndex")!;
    field.id = "dose-argument-owner";
    const original = persist(source), current = persist(parseInstructionGraphExtension([source])!);
    if (clear) delete current.primaryOwnership!.dose;
    let rebuilt = buildInstructionGraphExtension(current)!;
    for (let save = 0; save < 2; save++) {
      const marker = rebuilt.extension!.find(child => child.url === "primaryOwnership")!;
      if (clear) {
        expect(marker.extension!.some(value => value.url === "doseArgumentIndex" || value.url === "doseActionIndex")).toBe(false);
        expect(marker.extension).toContainEqual({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [field] });
      } else expect(marker.extension).toContainEqual(field);
      const next = parseInstructionGraphExtension([persist(rebuilt)])!;
      expect(next.primaryOwnership!.dose).toEqual(clear ? undefined : { actionIndex: 0, argumentIndex: 0 });
      rebuilt = buildInstructionGraphExtension(next)!;
    }
    expect(source).toEqual(original);
  });
});

describe("round80 R6 Ratio annotation types", () => {
  it("admits native annotations on the ratio and its comparator-free denominator", () => {
    const extension: FhirR6Extension = { url: "urn:clinic:ratio-estimate", id: "estimate",
      valueQuantity: { value: 1, comparator: "~", unit: "mL" } };
    const ratio: FhirR6Ratio = { id: "rate-ratio", extension: [extension],
      numerator: { value: 5, unit: "mL" },
      denominator: { value: 1, unit: "h", extension: [extension], _value: { extension: [extension] } } };
    const input = course({ doseAndRate: [{ rateRatio: ratio }] }), before = persist(input);
    const output = r6Save(input);
    expect(output.step![0].component[0].doseAndRate![0].rateRatio).toEqual(ratio);
    const rows = toFhirR5Dosages(persist(output));
    const strict = rows[0].doseAndRate![0].rateRatio!;
    for (const nested of [strict.extension![0].valueQuantity!,
      strict.denominator!.extension![0].valueQuantity!, strict.denominator!._value!.extension![0].valueQuantity!]) {
      expect(nested.comparator).toBeUndefined();
      expect(nested.extension).toContainEqual({ url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
        valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000055" } });
    }
    expect(toDosageDetails(persist(rows)).step![0].component[0].doseAndRate![0].rateRatio).toEqual(ratio);
    const edited = persist(output);
    edited.step![0].component[0].doseAndRate![0].rateRatio!.numerator!.value = 6;
    expect(r6Save(edited).step![0].component[0].doseAndRate![0].rateRatio)
      .toEqual({ ...ratio, numerator: { value: 6, unit: "mL" } });
    expect(input).toEqual(before);
    const invalidR6: FhirR6Ratio = { denominator: {
      // @ts-expect-error A Ratio denominator remains SimpleQuantity in R6.
      comparator: "~",
    } };
    const strictR5: FhirRatio = { extension: [{ url: "urn:clinic:ratio-estimate", valueQuantity: {
      // @ts-expect-error The approximate Quantity comparator is an R6 choice.
      comparator: "~",
    } }] };
    expect(invalidR6.denominator!.comparator).toBe("~");
    expect(strictR5.extension![0].valueQuantity!.comparator).toBe("~");
  });
});


describe("round78 saved action and cycle locale ownership", () => {
  const persist = <T>(value: T): T => JSON.parse(JSON.stringify(value));

  it.each([AdviceRelation.On, AdviceRelation.Before, undefined])("realizes the saved patch Time with its relation %s", relation => {
    const frame = parseInstructionActions("Apply patch in the morning")[0];
    const clocked = relation !== undefined;
    const sourceText = relation === AdviceRelation.On ? "Apply patch at 08:00" : relation === AdviceRelation.Before
      ? "Apply patch before 08:00" : "Apply patch in the morning";
    const graph: CanonicalInstructionGraph = { sourceText,
      sourceLocale: "en", actions: [{ ...frame, sourceText, span: { start: 0, end: sourceText.length }, relation, args: [{
        role: AdviceArgumentRole.Time, text: clocked ? "08:00" : "morning", normalized: clocked ? "08:00" : "MORN",
        ...(clocked ? { relation } : { i18n: { en: "the morning", th: "ตอนเช้า" } })
      }] }] };
    const row: FhirDosage = { extension: [buildInstructionGraphExtension(graph)!] };
    const r6 = toDosageDetails([persist(row)]);
    for (const input of [[row], persist(r6), persist(toFhirR5Dosages(r6))]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe(relation === AdviceRelation.On ? "Apply patch at 08:00." : relation === AdviceRelation.Before
          ? "Apply patch before 08:00." : "Apply patch in the morning.");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
        .toBe(relation === AdviceRelation.On ? "แปะ เวลา 08:00." : relation === AdviceRelation.Before
          ? "แปะก่อน08:00." : "แปะตอนเช้า.");
      expect(parseInstructionGraphExtension(toFhirR5Dosages(input)[0].extension)?.actions[0].args[0])
        .toMatchObject({ role: AdviceArgumentRole.Time, text: clocked ? "08:00" : "morning" });
    }
  });

  it("matches an imported method to the configured primary action Coding", () => {
    const coding = { system: "urn:clinic:action", code: "coat-lightly", id: "authored-action",
      extension: [{ url: "urn:clinic:note", valueString: "retain" }] };
    const options: ParseOptions = { instructionActionMap: { "coat lightly": {
      code: "coat-lightly", display: "Coat lightly", semanticClass: "administration", coding,
      administrationMethod: { system: "urn:clinic:method", code: "coat" }, i18n: { en: "Coat lightly", th: "ทาบาง ๆ" }
    } } };
    const row: FhirDosage = { method: { coding: [coding] }, doseAndRate: [{ doseQuantity: { value: 1, unit: "g" } }] };
    const r6 = toDosageDetails([persist(row)]);
    for (const input of [[row], persist(r6), persist(toFhirR5Dosages(r6))]) {
      expect(formatSig(input, "long", { ...options, locale: "en", realizationMode: "normalized" })).toBe("Coat lightly 1 g.");
      expect(formatSig(input, "long", { ...options, locale: "th", realizationMode: "normalized" })).toBe("ทาบาง ๆครั้งละ 1 g.");
      expect(toFhirR5Dosages(input)[0].method?.coding).toEqual([coding]);
    }
  });

  it.each([1, 2, undefined])("states the complete course count without an extra repetition: %s", count => {
    const course: FhirR6DosageInstruction = { repeatCycle: { value: 28, unit: "d", code: "d" },
      step: [{ component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, boundsDuration: { value: 7, unit: "d" } } } }] }] };
    if (count !== undefined) setCourseCycleCount(course, count);
    for (const input of [course, persist(toFhirR5Dosages(course))]) {
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      if (count === 1) {
        expect(th).toContain("ใช้แผนการใช้ยานี้รวม 1 รอบ.");
        expect(th).not.toContain("ทำซ้ำ");
        expect(th).not.toContain("ทุก 28 วัน");
      } else {
        expect(th).toContain("ทำซ้ำแผนการใช้ยานี้ทุก 28 วัน");
        expect(th.includes("จำนวน 2 รอบ")).toBe(count === 2);
      }
      expect(getCourseCycleCount(Array.isArray(input) ? toDosageDetails(input) : input)).toBe(count);
    }
  });
});


it("keeps an independently supplied OR condition beside its authored administration", () => {
  const persist = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const directions = "Swallow 1 tablet whole";
  const actions = parseInstructionActions(directions);
  const row: FhirDosage = { method: { text: "Swallow" },
    doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
    extension: [buildInstructionGraphExtension({ sourceText: directions, sourceLocale: "en",
      actions, primaryAdministrationSpan: actions[0].span,
      primaryOwnership: { administrationActionIndex: 0, dose: { actionIndex: 0,
        argumentIndex: actions[0].args.findIndex(argument => argument.role === AdviceArgumentRole.Amount) } } })!] };
  setDosageCondition(row, { kind: "any", conditions: [
    { kind: "measurement", name: "SBP", operation: "gt", value: 160, text: "SBP > 160" },
    { kind: "state", name: "dizziness", expected: true, text: "dizziness" }
  ] });
  const current = toDosageDetails([persist(row)]);
  for (const input of [[row], importCanonicalCourse([persist(row)]), persist(current), persist(toFhirR5Dosages(current))]) {
    expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
      .toBe("Swallow 1 tablet whole only if SBP > 160 or dizziness.");
    expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
      .toBe("กลืน 1 เม็ดทั้งเม็ด เฉพาะเมื่อ SBP > 160 หรือ dizziness.");
    const clause = importCanonicalCourse(input).stages[0].administrations[0];
    expect(clause.predicate).toMatchObject({ kind: "any", conditions: [
      { kind: "measurement", value: 160 }, { kind: "state", name: "dizziness", expected: true }
    ] });
  }
  expect(parseInstructionGraphExtension(row.extension)?.sourceText).toBe(directions);
});


describe("graph argument singleton annotations", () => {
  const saved = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const argumentField = (marker: FhirExtension, name: string): FhirExtension => {
    const action = marker.extension!.find(item => item.url === "action")!;
    for (const argument of action.extension!.filter(item => item.url === "argument")) {
      const field = argument.extension!.find(item => item.url === name);
      if (field) return field;
    }
    throw new Error("Expected graph argument field " + name);
  };

  it("retains concept field annotations beside current identity", () => {
    const source = "Cover with an occlusive dressing";
    const original = saved(buildInstructionGraphExtension({
      sourceText: source, sourceLocale: "en", actions: parseInstructionActions(source),
    })!);
    const field = argumentField(original, "conceptId");
    field.id = "material-identity";
    field._valueString = { id: "material-value", extension: [
      { url: "urn:clinic:material-note", valueString: "retain material annotation" },
    ] };
    const input = saved(original);
    const before = saved(input), expected = saved(argumentField(input, "conceptId"));
    let graph = parseInstructionGraphExtension([input])!;
    for (let save = 0; save < 2; save++) {
      expect(graph.actions[0].args.find(argument => argument.conceptId)?.conceptId)
        .toBe("occlusive_dressing");
      const rebuilt = buildInstructionGraphExtension(graph)!;
      expect(argumentField(rebuilt, "conceptId")).toEqual(expected);
      graph = parseInstructionGraphExtension([saved(rebuilt)])!;
    }
    expect(input).toEqual(before);
    expect(argumentField(original, "conceptId").valueString).toBe("occlusive_dressing");
  });

  it("retains coding wrapper annotations beside current identity", () => {
    const source = "Cover with an occlusive dressing";
    const original = saved(buildInstructionGraphExtension({
      sourceText: source, sourceLocale: "en", actions: parseInstructionActions(source),
    })!);
    const field = argumentField(original, "coding");
    field.id = "material-coding";
    field.valueCoding!._code = { id: "material-code", extension: [
      { url: "urn:clinic:coding-note", valueString: "retain coding annotation" },
    ] };
    const input = saved(original);
    const before = saved(input), expected = saved(argumentField(input, "coding"));
    let graph = parseInstructionGraphExtension([input])!;
    for (let save = 0; save < 2; save++) {
      const coding = graph.actions[0].args.find(argument => argument.coding)?.coding;
      expect(coding?.code).toBe("occlusive_dressing");
      expect(coding?.display).toBe("an occlusive dressing");
      const rebuilt = buildInstructionGraphExtension(graph)!;
      expect(argumentField(rebuilt, "coding")).toEqual(expected);
      graph = parseInstructionGraphExtension([saved(rebuilt)])!;
    }
    expect(input).toEqual(before);
    expect(argumentField(original, "coding").valueCoding!.code).toBe("occlusive_dressing");
  });

  it("retains quantity wrapper identity beside current amount", () => {
    const source = "Rinse mouth with 10 mL water";
    const original = saved(buildInstructionGraphExtension({
      sourceText: source, sourceLocale: "en", actions: parseInstructionActions(source),
    })!);
    const field = argumentField(original, "quantity");
    field.id = "rinse-volume";
    field.extension!.push({ url: "urn:clinic:volume-note", valueString: "retain volume annotation" });
    const input = saved(original);
    const before = saved(input), expected = saved(argumentField(input, "quantity"));
    let graph = parseInstructionGraphExtension([input])!;
    for (let save = 0; save < 2; save++) {
      const quantity = graph.actions[0].args.find(argument => argument.quantity)?.quantity;
      expect(quantity?.value).toBe(10);
      expect(quantity?.unit).toBe("mL");
      const rebuilt = buildInstructionGraphExtension(graph)!;
      expect(argumentField(rebuilt, "quantity")).toEqual(expected);
      graph = parseInstructionGraphExtension([saved(rebuilt)])!;
    }
    expect(input).toEqual(before);
    expect(argumentField(original, "quantity").extension!.find(child => child.url === "value")!.valueDecimal).toBe(10);
  });
});


describe("independent source coding and safety scope", () => {
  it.each([false, true])("keeps an explicitly absent target Coding system with translations %s", translated => {
    const systemMetadata = { extension: [{ url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown" }] };
    const target = { code: "ear-left", display: "Left ear", _system: systemMetadata,
      ...(translated ? { i18n: { en: "Left ear", th: "หูซ้าย" } } : {}) };
    const wire = buildBodySiteSpatialRelationExtension({ relationText: "near", targetCoding: target })!;
    const coding = wire.extension!.find(child => child.url === "target")!.valueCodeableConcept!.coding![0];
    expect(coding.system).toBeUndefined();
    expect(coding._system).toEqual(systemMetadata);
    expect(coding.code).toBe("ear-left");
    if (translated) expect(getPrimitiveTranslation(coding._display, "th")).toBe("หูซ้าย");
    expect(parseBodySiteSpatialRelationExtension({ extension: [wire] })!.targetCoding)
      .toMatchObject({ code: "ear-left", _system: systemMetadata });
  });

  it("keeps a shared action unqualified when both lifted policies apply it", () => {
    const metadata: EzCourseMetadata = {
      safety: { ifExceeded: "Call clinic", doseLimit: [
        { scope: "period", valueQuantity: q(8), period: { value: 1, unit: "d" } },
      ] },
      step: [{ sequence: 1, safety: { ifExceeded: "Call clinic", doseLimit: [
        { scope: "administration", valueQuantity: q(2) },
      ] } }],
    };
    const wire = toDosageDetails([{ sequence: 1, doseAndRate: [{ doseQuantity: q(1) }] }], undefined, metadata);
    expect(wire.step![0].safety).toBeUndefined();
    expect(wire.safety!.doseLimit!.map(limit => limit.valueQuantity!.value)).toEqual([8, 2]);
    expect(wire.safety!.ifExceeded).toBe("Call clinic");
    expect(wire.safety!.modifierExtension).toBeUndefined();
  });
});


describe("native R6 nested datatype declarations", () => {
  it("accepts native Period annotations at each R6 boundary while R5 remains strict", () => {
    const annotation: FhirR6Extension = { url: "urn:clinic:end-estimate", valueQuantity: { value: 1, comparator: "~", unit: "h" } };
    const period: FhirR6Period = { start: "2026-11-01", end: "2026-11-07", _end: { extension: [annotation] } };
    const timing: FhirR6Timing = { repeat: { boundsPeriod: period } };
    const condition: FhirR6DosageCondition = { code: { text: "Treatment period" }, valuePeriod: period };
    const reference: FhirR6Reference = { identifier: { period } };
    const strict: FhirPeriod = { _end: { extension: [{ url: "urn:clinic:end-estimate", valueQuantity: {
      // @ts-expect-error R5 Period metadata retains strict R5 Quantity comparator values.
      comparator: "~",
    } }] } };
    expect(timing.repeat!.boundsPeriod).toBe(period);
    expect(condition.valuePeriod).toBe(period);
    expect(reference.identifier!.period).toBe(period);
    expect(strict._end!.extension![0].valueQuantity!.comparator).toBe("~");
  });

  it("accepts native annotations in expressions, concepts and ranges while R5 remains strict", () => {
    const annotation: FhirR6Extension = { url: "urn:clinic:estimate", valueQuantity: { value: 1, comparator: "~", unit: "mg" } };
    const expression: FhirR6Expression = { language: "text/fhirpath", expression: "%patient.weight * 0.1", extension: [annotation] };
    const route: FhirR6CodeableConcept = { text: "Oral route", coding: [{ system: "http://snomed.info/sct", code: "26643006", extension: [annotation] }] };
    const range: FhirR6Range = { low: { value: 1, unit: "mg", extension: [annotation] }, high: { value: 2, unit: "mg" } };
    const input: FhirR6DosageInstruction = { step: [{ component: [{ route,
      doseAndRate: [{ doseExpression: expression }],
    }] }] };
    const output = fromFhir(input).fhirNext.step![0].component[0];
    expect(output.doseAndRate![0].doseExpression).toEqual(expression);
    expect(output.route).toEqual(route);
    const rangeInput: FhirR6DosageInstruction = { step: [{ component: [{ route,
      doseAndRate: [{ doseRange: range }],
    }] }] };
    expect(fromFhir(rangeInput).fhirNext.step![0].component[0].doseAndRate![0].doseRange).toEqual(range);
    const strictR5: FhirDoseAndRate = { doseRange: { low: { extension: [{ url: "urn:clinic:estimate", valueQuantity: {
      // @ts-expect-error R5 nested Quantity annotations do not admit the R6 approximate comparator.
      comparator: "~",
    } }] } } };
    const invalidSimpleQuantity: FhirR6Range = { low: {
      // @ts-expect-error R6 Range endpoints remain comparator-free SimpleQuantity.
      comparator: "~",
    } };
    expect(strictR5.doseRange!.low!.extension![0].valueQuantity!.comparator).toBe("~");
    expect(invalidSimpleQuantity.low!.comparator).toBe("~");
  });
});

describe("independent interchange scope and quantity annotations", () => {
  it.each([false, true])("keeps a phase-total limit separate from the course total (course limit: %s)", includeCourse => {
    const phase: FhirR6DosageSafety = { doseLimit: [{ scope: "dosage", valueQuantity: q(3) }] };
    const header: FhirR6DosageSafety = { doseLimit: [{ scope: "dosage", valueQuantity: q(6) }] };
    const metadata: EzCourseMetadata = {
      ...(includeCourse ? { safety: header } : {}),
      step: [{ sequence: 1, safety: phase, end: { offsetDuration: { value: 3, unit: "d" } } }] };
    setCourseCycleCount(metadata, 2);
    const before = persist(metadata);
    const output = toDosageDetails([{ sequence: 1, doseAndRate: [{ doseQuantity: q(1) }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } } }], undefined, metadata);
    expect(output.step![0].safety).toBeUndefined();
    expect(output.safety?.doseLimit).toEqual(includeCourse ? header.doseLimit : undefined);
    const native = importCanonicalCourse(output);
    expect(native.cycleCount).toBe(2);
    expect(native.stages[0].safety?.limits?.map(limit => limit.amount)).toEqual([q(3)]);
    expect(native.safety?.limits?.map(limit => limit.amount)).toEqual(includeCourse ? [q(6)] : undefined);
    const marker = output.safety?.modifierExtension?.find(item => item.url === R6_SCOPED_SAFETY_MODIFIER_URL);
    expect(marker).toBeDefined();
    expect(decodeR6SourceMetadata(marker!, "safety")).toMatchObject({ step: phase,
      ...(includeCourse ? { course: header } : {}) });
    expect(metadata).toEqual(before);
  });

  it("keeps each translation with its complete safety action", () => {
    const translation = { extension: [{ url: FHIR_TRANSLATION_EXTENSION_URL, extension: [
      { url: "lang", valueCode: "th" }, { url: "content", valueString: "โทรหาคลินิก" }
    ] }] };
    const header: FhirR6DosageSafety = { ifExceeded: "Call the clinic", _ifExceeded: translation };
    const phase: FhirR6DosageSafety = { ifExceeded: "Hold the next dose" };
    const metadata: EzCourseMetadata = { safety: header, step: [{ sequence: 1, safety: phase }] };
    const output = toDosageDetails([{ sequence: 1, doseAndRate: [{ doseQuantity: q(1) }] }], undefined, metadata);
    expect(output.safety?.ifExceeded).toBe("Call the clinic\nHold the next dose");
    expect(output.safety?._ifExceeded).toBeUndefined();
    const marker = output.safety?.modifierExtension?.find(item => item.url === R6_SCOPED_SAFETY_MODIFIER_URL);
    expect(decodeR6SourceMetadata(marker!, "safety")).toEqual({ course: header, step: phase });
    const decoded = fromDosageDetails(output);
    expect(decoded.course.safety?._ifExceeded).toEqual(translation);
    expect(decoded.course.step?.[0].safety?.ifExceeded).toBe(phase.ifExceeded);
    const unchanged = toDosageDetails([{ sequence: 1, doseAndRate: [{ doseQuantity: q(1) }] }],
      undefined, { safety: header, step: [{ sequence: 1, safety: { ifExceeded: header.ifExceeded } }] });
    expect(unchanged.safety?._ifExceeded).toEqual(translation);
  });

  it.each(["administration", "lifetime"] as const)("keeps a same-code minimum comparable in every %s cap order", scope => {
    const labeled = { value: 300, unit: "mg", system: "urn:clinic:units", code: "mass" };
    const minimum = { value: 100, system: "urn:clinic:units", code: "mass" };
    const metric = { value: 0.25, unit: "g", system: "http://unitsofmeasure.org", code: "g" };
    for (const values of [[labeled, minimum, metric], [labeled, metric, minimum], [minimum, labeled, metric],
      [minimum, metric, labeled], [metric, labeled, minimum], [metric, minimum, labeled]]) {
      const input = course({ safety: { doseLimit: values.map(valueQuantity => ({ scope, valueQuantity })) } });
      const before = persist(input), output = toFhirR5Dosages(input)[0];
      expect(scope === "administration" ? output.maxDosePerAdministration : output.maxDosePerLifetime).toEqual(minimum);
      expect(importCanonicalCourse(input).stages[0].administrations[0].limits?.map(limit => limit.amount)).toEqual(values);
      expect(input).toEqual(before);
    }
  });

  it.each([["eq", true, true], ["eq", false, false], ["ne", true, false], ["ne", false, true]] as const)(
    "resolves a coded-only condition with Boolean %s %s", (operation, valueBoolean, expected) => {
      const condition: FhirR6DosageCondition = {
        code: { coding: [{ system: "http://hl7.org/fhir/CodeSystem/dosage-condition-code", code: "problem-presents" }] },
        details: { coding: [{ system: "http://snomed.info/sct", code: "422587007" }] },
        operation, valueBoolean, extension: [{ url: "urn:clinic:condition-note", valueString: "retain" }]
      };
      const input = course({ condition: [condition] }), before = persist(input);
      const rows = toFhirR5Dosages(input);
      expect(getDosageCondition(rows[0])).toMatchObject({ kind: "state", name: "Nausea", expected });
      expect(courseToR6(importCanonicalCourse(input)).step![0].component[0].condition).toEqual([condition]);
      expect(input).toEqual(before);
    });

  it("keeps an unknown coded subject unresolved and preserves its source", () => {
    const condition: FhirR6DosageCondition = {
      code: { coding: [{ code: "problem-presents" }] },
      details: { coding: [{ system: "urn:clinic:unregistered", code: "422587007" }] },
      operation: "ne", valueBoolean: false, text: "Clinic-specific condition"
    };
    const input = course({ condition: [condition] });
    expect(getDosageCondition(toFhirR5Dosages(input)[0])).toEqual({ kind: "text", text: condition.text });
    expect(courseToR6(importCanonicalCourse(input)).step![0].component[0].condition).toEqual([condition]);
  });

  it("emits an unknown lower-count primitive for an authored upper-only count", () => {
    const parsed = parsePublicSig("Take 1 tablet daily up to 3 doses");
    for (const row of [parsed.fhir[0], parsed.fhirNext.step![0].component[0]]) {
      expect(row.timing?.repeat?.countMax).toBe(3);
      expect(row.timing?.repeat?.count).toBeUndefined();
      expect(row.timing?.repeat?._count?.extension).toContainEqual({
        url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown"
      });
    }
  });

  it("keeps independently supplied frequency companions in both wire versions", () => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }],
      timing: { repeat: { frequency: 2, _frequency: { id: "r5-frequency" },
        period: 1, periodUnit: FhirPeriodUnit.Day } } };
    const input: FhirR6DosageInstruction = course({ timing: { repeat: { frequency: 2,
      _frequency: { id: "r6-frequency" }, period: 1, periodUnit: FhirPeriodUnit.Day } } });
    expect(toDosageDetails([row]).step![0].component[0].timing?.repeat?._frequency).toEqual({ id: "r5-frequency" });
    expect(toFhirR5Dosages(input)[0].timing?.repeat?._frequency).toEqual({ id: "r6-frequency" });
  });

  it("converts nested Ratio denominator annotations without changing the authored denominator", () => {
    const estimate: FhirR6Extension = { url: "urn:clinic:estimated-volume",
      valueQuantity: { value: 2, unit: "mL", comparator: "~" } };
    const annotation: FhirR6Extension = { url: "urn:clinic:concentration", valueRatio: {
      numerator: { value: 10, unit: "mg" }, denominator: { value: 1, unit: "mL",
        _value: { id: "diluent", extension: [estimate] } }
    } };
    const input = course({ doseAndRate: [{ doseQuantity: { value: 1, unit: "mL", extension: [annotation] } }] });
    const before = persist(input);
    const projected = toFhirR5Dosages(input)[0].doseAndRate![0].doseQuantity!.extension![0].valueRatio!.denominator!;
    expect(projected).toMatchObject({ value: 1, unit: "mL", _value: { id: "diluent" } });
    const quantity = projected._value!.extension![0].valueQuantity!;
    expect(quantity.comparator).toBeUndefined();
    expect(getQuantityComparator(quantity)).toBe("~");
    expect(quantity).toMatchObject({ value: 2, unit: "mL" });
    expect(input).toEqual(before);
  });

  it.each(["relation", "target"] as const)("converts a spatial %s Coding's Quantity annotations at R5 output", owner => {
    const annotation: FhirR6Extension = { url: "urn:clinic:distance",
      valueQuantity: { value: 2, unit: "cm", comparator: "~" } };
    const coding = { system: "http://snomed.info/sct", code: owner === "relation" ? "255651002" : "39937001",
      extension: [annotation], _display: { id: "display-note", extension: [annotation] } };
    const concept: FhirR6CodeableConcept = { extension: [{ url: "urn:ezmedicationinput:body-site-spatial-relation",
      extension: owner === "relation" ? [{ url: "relation", valueCoding: coding }]
        : [{ url: "target", valueCodeableConcept: { coding: [coding] } }]
    }] };
    const before = persist(concept);
    const output = buildBodySiteSpatialRelationExtension(parseBodySiteSpatialRelationExtension(concept))!;
    const child = output.extension!.find(item => item.url === owner)!;
    const actual = owner === "relation" ? child.valueCoding! : child.valueCodeableConcept!.coding![0];
    for (const quantity of [actual.extension![0].valueQuantity!, actual._display!.extension![0].valueQuantity!]) {
      expect(quantity.comparator).toBeUndefined();
      expect(getQuantityComparator(quantity)).toBe("~");
      expect(quantity).toMatchObject({ value: 2, unit: "cm" });
    }
    expect(actual._display?.id).toBe("display-note");
    expect(concept).toEqual(before);
  });
});

describe("independent graph locale annotations", () => {
  it.each([false, true])("retains metadata on a direct-dose locale value of %s", directDose => {
    const locale: FhirExtension = { id: "locale-profile", url: "predicateRealizerLocale", extension: [
      { url: "locale", valueCode: "th" },
      { id: "direct-dose-setting", url: "directDose", valueBoolean: directDose },
      { url: "routePhrase", id: "oral-phrase", extension: [
        { id: "oral-code", url: "route", valueCode: "PO" },
        { id: "oral-text", url: "text", valueString: "ทางปาก" },
      ] },
      { url: "urn:clinic:profile-note", valueString: "retain" },
    ] };
    const input: FhirExtension = { url: "urn:ezmedicationinput:StructureDefinition:medication-instruction-graph",
      extension: [{ url: "action", extension: [
        { url: "predicateLemma", valueString: "chew" },
        { url: "sourceText", valueString: "Chew 1 tablet" },
        { url: "force", valueCode: AdviceForce.Sequence },
        { url: "spanStart", valueInteger: 0 }, { url: "spanEnd", valueInteger: 13 }, locale,
      ] }]
    };
    const before = persist(input), graph = parseInstructionGraphExtension([input])!;
    expect(graph.actions[0].predicate.realizerConfig?.locales?.th.directDose).toBe(directDose);
    expect(graph.actions[0].predicate.realizerConfig?.locales?.th.routePhrases).toEqual({ PO: "ทางปาก" });
    const rebuilt = buildInstructionGraphExtension(graph)!;
    const action = rebuilt.extension!.find(item => item.url === "action")!;
    expect(action.extension!.filter(item => item.url === "predicateRealizerLocale")).toEqual([locale]);
    expect(input).toEqual(before);
  });
});

describe("plain count maximum identity", () => {
  it.each(["administration", "lifetime"] as const)("selects the tighter unitless %s limit in both orders", scope => {
    for (const values of [[1, 2], [2, 1]]) {
      const input = course({ doseAndRate: [{ doseQuantity: { value: 1 } }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
        safety: { doseLimit: values.map(value => ({ scope, valueQuantity: { value } })) }
      });
      const before = persist(input), rows = toFhirR5Dosages(input);
      expect(scope === "administration" ? rows[0].maxDosePerAdministration : rows[0].maxDosePerLifetime)
        .toEqual({ value: 1 });
      expect(numericAdministrationLimits(importCanonicalCourse(input).stages[0].administrations[0])[scope])
        .toEqual({ value: 1 });
      expect(input).toEqual(before);
    }
  });
});


describe("independent current FHIR field fidelity", () => {
  const graphUrl = "urn:ezmedicationinput:StructureDefinition:medication-instruction-graph";
  const note: FhirExtension = { url: "urn:clinic:annotation", valueString: "retain" };
  const actionFields = (): FhirExtension[] => [
    { url: "predicateLemma", valueString: "swallow" },
    { url: "force", valueCode: AdviceForce.Sequence },
    { url: "spanStart", valueInteger: 0 }, { url: "spanEnd", valueInteger: 13 },
    { url: "sourceText", valueString: "Swallow tablet" },
  ];
  const graphInput = (parts: FhirExtension[], extra: FhirExtension[] = []): FhirExtension => ({
    url: graphUrl, extension: [{ url: "action", extension: parts }, ...extra]
  });
  const rebuiltAction = (input: FhirExtension) => buildInstructionGraphExtension(
    parseInstructionGraphExtension([input]))!.extension!.find(field => field.url === "action")!;

  it("converts a Quantity nested inside an annotated Ratio while preserving every owner", () => {
    const annotation: FhirR6Extension = { url: "urn:clinic:concentration", valueRatio: {
      id: "concentration", numerator: { value: 1, unit: "mg" }, denominator: { value: 1, unit: "mL" },
      extension: [{ url: "urn:clinic:flush-volume", valueQuantity: { value: 5, unit: "mL", comparator: "~" } }]
    } };
    const input = course({ doseAndRate: [{ rateRatio: {
      numerator: { value: 10, unit: "mL" }, denominator: { value: 1, unit: "h" }, extension: [annotation]
    } }] });
    const before = persist(input), rows = toFhirR5Dosages(input);
    const ratio = rows[0].doseAndRate![0].rateRatio!.extension![0].valueRatio!;
    expect(ratio).toMatchObject({ id: "concentration", numerator: { value: 1, unit: "mg" }, denominator: { value: 1, unit: "mL" } });
    const flush = ratio.extension![0].valueQuantity!;
    expect(flush).toMatchObject({ value: 5, unit: "mL" });
    expect(flush.comparator).toBeUndefined();
    expect(getQuantityComparator(flush)).toBe("~");
    const roundtrip = toDosageDetails(rows).step![0].component[0].doseAndRate![0].rateRatio!;
    expect(getQuantityComparator(roundtrip.extension![0].valueRatio!.extension![0].valueQuantity)).toBe("~");
    expect(input).toEqual(before);
  });

  it.each(["181178004", "117590005"])("keeps both otic targets with unqualified anatomy %s", code => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 2, unit: "drop" } }],
      site: { text: "both ears", coding: [{ system: "http://snomed.info/sct", code }] },
      timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day } } };
    const before = persist(row), r6 = toDosageDetails([row]);
    for (const input of [row, r6, persist(toFhirR5Dosages(r6))]) {
      expect(importCanonicalCourse(input).stages[0].administrations[0].targetCount).toBe(2);
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toMatch(/both ears|each ear/u);
      expect(calculateTotalUnits({ dosage: input, orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-01T00:00:00Z", timeZone: "UTC",
        durationValue: 1, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(8);
    }
    expect(row).toEqual(before);
    expect(r6.step![0].component[0].site?.concept).toEqual(row.site);
  });

  it("keeps an explicit opposite-side code distinct from unqualified anatomy", () => {
    const row: FhirDosage = { site: { text: "left ear", coding: [{ system: "http://snomed.info/sct", code: "368566007" }] },
      doseAndRate: [{ doseQuantity: { value: 2, unit: "drop" } }] };
    expect(formatSig(row, "long", { locale: "en", realizationMode: "normalized" })).toContain("right ear canal");
    expect(row.site?.text).toBe("left ear");
  });

  it.each([false, true])("uses the readable concept before a reference, and reference before a local code (known %s)", known => {
    const site: NonNullable<FhirR6Dosage["site"]> = { concept: { coding: [known
      ? { system: "http://snomed.info/sct", code: "1290031003" }
      : { system: "urn:clinic:site", code: "EYE-1" }] },
      reference: { reference: "BodyStructure/eye", display: known ? "Local eye description" : "Left eye" } };
    const input = course({ site }), before = persist(input);
    expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }).toLowerCase()).toContain("left eye");
    expect(formatSig(input, "long", { locale: "en" })).not.toContain("EYE-1");
    expect(projectCanonicalCourse(importCanonicalCourse(input)).fhirNext.step![0].component[0].site).toEqual(site);
    expect(input).toEqual(before);
  });

  it("accepts and retains upper frequency primitive annotations in both wire versions", () => {
    const metadata = { id: "upper-frequency", extension: [note] };
    const input = course({ timing: { repeat: { frequency: 1, frequencyMax: 2, _frequencyMax: metadata,
      period: 1, periodUnit: FhirPeriodUnit.Day } } });
    const before = persist(input), rows: FhirDosage[] = toFhirR5Dosages(input);
    expect(rows[0].timing?.repeat).toMatchObject({ frequency: 1, frequencyMax: 2, _frequencyMax: metadata });
    expect(toDosageDetails(rows).step![0].component[0].timing?.repeat?._frequencyMax).toEqual(metadata);
    expect(input).toEqual(before);
  });

  it("keeps every authored translation variant when re-encoding its selected display", () => {
    const translation = (id: string, text: string): FhirExtension => ({ id, url: FHIR_TRANSLATION_EXTENSION_URL,
      extension: [{ url: "lang", valueCode: "th" }, { url: "content", valueString: text }] });
    const coding = { system: "http://snomed.info/sct", code: "311501000", display: "Take with food",
      _display: { extension: [translation("first", "รับประทานพร้อมอาหาร"), translation("second", "ใช้ยาพร้อมอาหาร")] } };
    const input = graphInput([...actionFields(), { url: "predicateCoding", valueCoding: coding }]);
    const before = persist(input), graph = parseInstructionGraphExtension([input])!;
    expect(graph.actions[0].predicate.codings![0].i18n?.th).toBe("ใช้ยาพร้อมอาหาร");
    const output = rebuiltAction(input).extension!.find(field => field.url === "predicateCoding")!.valueCoding!;
    expect(output._display).toEqual(coding._display);
    expect(input).toEqual(before);
  });

  it("keeps primitive action and relation-wrapper annotations at their original fields", () => {
    const display: FhirExtension = { id: "display-field", url: "predicateDisplay", valueString: "Swallow",
      _valueString: { id: "display-value", extension: [note] } };
    const relationCoding: FhirExtension = { id: "relation-coding", url: "kindCoding", valueCoding: {
      system: "http://hl7.org/fhir/action-relationship-type", code: "before" } };
    const input = graphInput([...actionFields(), display], [{ id: "relation", url: "graphRelation", extension: [
      relationCoding, { url: "fromActionIndex", valueInteger: 0 }, { url: "toActionIndex", valueInteger: 1 }
    ] }]);
    const before = persist(input), output = buildInstructionGraphExtension(parseInstructionGraphExtension([input]))!;
    expect(output.extension!.find(field => field.url === "action")!.extension).toContainEqual(display);
    const relation = output.extension!.find(field => field.url === "graphRelation")!;
    expect(relation.id).toBe("relation");
    expect(relation.extension!.filter(field => field.url === "kindCoding")).toEqual([relationCoding]);
    expect(parseInstructionGraphExtension([output])!.relations![0].kind).toBe(AdviceRelation.Before);
    expect(input).toEqual(before);
  });

  it("merges legacy locale settings without losing explicit false or node annotations", () => {
    const locale: FhirExtension = { id: "thai-profile", url: "predicateRealizerLocale", extension: [
      { url: "locale", valueCode: "th" }, { id: "direct-dose", url: "directDose", valueBoolean: false }, note
    ] };
    const input = graphInput([...actionFields(), locale,
      { url: "predicateRealizerThaiFallbackObject", valueString: "ยาเม็ด" }]);
    const before = persist(input), output = rebuiltAction(input);
    const saved = output.extension!.find(field => field.url === "predicateRealizerLocale")!;
    expect(saved.id).toBe("thai-profile");
    expect(saved.extension).toContainEqual({ id: "direct-dose", url: "directDose", valueBoolean: false });
    expect(saved.extension).toContainEqual({ url: "fallbackObject", valueString: "ยาเม็ด" });
    expect(saved.extension).toContainEqual(note);
    const again = parseInstructionGraphExtension([{ url: graphUrl, extension: [output] }])!;
    expect(again.actions[0].predicate.realizerConfig?.locales?.th).toMatchObject({ directDose: false, fallbackObject: "ยาเม็ด" });
    expect(input).toEqual(before);
  });

  it("keeps opaque-span and coverage annotations inert at their own nodes", () => {
    const opaque: FhirExtension = { id: "opaque-span", url: "opaque", extension: [
      { url: "start", valueInteger: 14 }, { url: "end", valueInteger: 20 },
      { url: "text", valueString: "clinic", _valueString: { extension: [note] } },
      { id: "token-three", url: "tokenIndex", valueInteger: 3 },
      { id: "token-four", url: "tokenIndex", valueInteger: 4 }, note
    ] };
    const coverage: FhirExtension = { id: "coverage", url: "coverage", extension: [
      { url: "understoodCharacters", valueInteger: 13 }, { url: "opaqueCharacters", valueInteger: 6 },
      { url: "ratio", valueDecimal: 0.65, _valueDecimal: { extension: [note] } },
      { url: "complete", valueBoolean: false }, note
    ] };
    const input = graphInput(actionFields(), [opaque, coverage]), before = persist(input);
    const graph = parseInstructionGraphExtension([input])!, output = buildInstructionGraphExtension(graph)!;
    expect(graph.actions).toHaveLength(1);
    expect(graph.coverage).toMatchObject({ understoodCharacters: 13, opaqueCharacters: 6, ratio: 0.65, complete: false });
    expect(output.extension!.find(field => field.url === "opaque")).toEqual(opaque);
    expect(output.extension!.find(field => field.url === "coverage")).toEqual(coverage);
    expect(input).toEqual(before);
  });

  it("keeps an absent quantity value's reason on its original primitive without inventing a number", () => {
    const missing: FhirExtension = { id: "measured-amount", url: "value", _valueDecimal: { extension: [
      { url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown" }
    ] } };
    const input = graphInput([...actionFields(), { url: "argument", extension: [
      { url: "role", valueCode: AdviceArgumentRole.Amount }, { url: "text", valueString: "measured liquid" },
      { url: "quantity", extension: [missing, { url: "unit", valueString: "mL" }] }
    ] }]);
    const before = persist(input), graph = parseInstructionGraphExtension([input])!;
    expect(graph.actions[0].args[0].quantity?.value).toBeUndefined();
    const argument = rebuiltAction(input).extension!.find(field => field.url === "argument")!;
    const quantity = argument.extension!.find(field => field.url === "quantity")!;
    expect(quantity.extension).toContainEqual(missing);
    expect(quantity.extension!.some(field => field.url === "sourceQuantityField")).toBe(false);
    expect(input).toEqual(before);
  });
});
