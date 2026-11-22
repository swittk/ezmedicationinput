import { COURSE_CYCLE_COUNT_EXTENSION_URL, getCourseCycleCount } from "../src/fhir-course-cycle-count";
import { describe, expect, it } from "vitest";
import {
  fromDosageDetails, fromFhir, fromFhirDosage, toDosageDetails, toFhirR5Dosages, parseSig, formatSig, importCanonicalCourse, projectCanonicalCourse,
  type EzDosage, type FhirDosage, type FhirExtension, type FhirRatio, type FhirR6Dosage,
  FhirPeriodUnit, FhirDayOfWeek, EventTiming, nextDueDoses, calculateTotalUnits,
  type FhirR6DosageInstruction, type FhirR6Quantity, type FhirR6DosageInstructionInput,
  type FhirR6DosageCondition, type FhirR6Timing, type FhirR6DosageStep,
} from "../src/index";
import {
  DOSAGE_CONDITION_R5_URL, DOSAGE_RECONCILIATION_SOURCE_URL, DOSAGE_RENDERED_INSTRUCTION_R5_URL,
  setDosageCondition, getDosageCondition, getDosageCalendarDayCondition, conditionToR6, toEzDosages, isExactConditionBridge, DOSAGE_DETAILS_R5_URL, decodeR5RetainedFields, encodeR5RetainedFields,
  decodeR6SourceMetadata, encodeR6SourceMetadata, readRetainedField, retainField, sourceWithoutNestedHistory, withDosageEditProvenance, isRenderedInstructionMarker,
  PARALLEL_COMPONENT_PHASE_ORIGIN_URL, DOSAGE_ALTERNATIVE_CHOICE_URL, setDosageAlternativeChoice,
  DOSAGE_EXCLUDED_DATES_R5_URL, DOSAGE_EXCLUDED_WEEKDAYS_R5_URL,
  setDosageExcludedDates, getDosageExcludedDates, setDosageExcludedWeekdays, R5_RATE_MODIFIERS_R6_URL,
  captureSourceReplayTiming, matchesSourceReplayTiming, dosageMatchesSavedProjection,
  captureSourceReplayConcept, matchesSourceReplayConcept,
} from "../src/dosage-course";
import {
  EMA_QUANTITY_COMPARATOR_EXTENSION_URL, EMA_QUANTITY_OPERATOR_SYSTEM,
  simpleQuantityForR5, quantityForR5, quantityFromR5, getQuantityComparator,
} from "../src/fhir-quantity-operator";
import {
  PRN_TRIGGER_PHASE_EXTENSION_URL, TIMING_ADDITIONAL_CLOCK_EXTENSION_URL, TIMING_OFFSET_MIN_EXTENSION_URL, TIMING_OFFSET_MAX_EXTENSION_URL,
  TIMING_OFFSET_EXACT_EXTENSION_URL, TIMING_FREQUENCY_MIN_EXTENSION_URL, TIMING_DAY_OF_MONTH_EXTENSION_URL,
  canonicalFromFhir, canonicalToFhir, getAnchoredCourseDuration, TIMING_ACTIVITY_WINDOW_EXTENSION_URL,
  CYCLE_DAY_ELIGIBILITY_EXTENSION_URL, ANCHORED_COURSE_DURATION_EXTENSION_URL, TIMING_ADMINISTRATION_DURATION_EXTENSION_URL,
  ADMINISTRATION_OFFSET_EXTENSION_URL,
} from "../src/fhir";
import { courseToR6, boundaryToWire, R5_SOURCE_ONLY_MAXIMUM_URL } from "../src/adapters/canonical-course";
import { courseFromR5 } from "../src/adapters/r5-import";
import { R6_DRAFT_STEPS_SOURCE_URL, R6_SINGLE_STEP_SAFETY_SOURCE_URL, R6_SCOPED_SAFETY_MODIFIER_URL } from "../src/adapters/r6-editable-metadata";

const persist = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const q = (value: number) => ({ value, unit: "tab" });
const expression = (name: string) => ({ language: "text/fhirpath", expression: "%" + name });
const course = (component: Partial<FhirR6Dosage> = {}): FhirR6DosageInstruction => ({
  step: [{ component: [{ doseAndRate: [{ doseQuantity: q(1) }], ...component }] }],
});
const r6Save = (value: FhirR6DosageInstruction): FhirR6DosageInstruction => {
  return projectCanonicalCourse(importCanonicalCourse(persist(value))).fhirNext;
};

// Public wire edits are supported inputs. Expected amounts, associations and
// source fragments are authored here independently of the adapter output.
describe("round23 R5 external identity and source preservation", () => {
  it("keeps each same-valued period limit's metadata on its unique ID after reorder and edit", () => {
    const first = { id: "limit-a", scope: "period" as const, valueQuantity: q(4),
      period: { value: 1, unit: "d" }, text: "first limit" };
    const second = { ...first, id: "limit-b", text: "second limit" };
    const rows = persist(toFhirR5Dosages(course({ safety: { doseLimit: [first, second] } })));
    rows[0].maxDosePerPeriod!.reverse();
    rows[0].maxDosePerPeriod![1].numerator!.value = 3;
    let actual = toDosageDetails(rows);
    const expected = [second, { ...first, valueQuantity: q(3) }];
    expect(actual.step![0].component[0].safety!.doseLimit).toEqual(expected);
    for (let save = 0; save < 3; save++) {
      actual = toDosageDetails(persist(toFhirR5Dosages(actual)));
      expect(actual.step![0].component[0].safety!.doseLimit).toEqual(expected);
    }
  });

  it("keeps the unique ID-less period limit's metadata on an ordinary amount edit", () => {
    const rows = persist(toFhirR5Dosages(course({ safety: { doseLimit: [{
      scope: "period", valueQuantity: q(4), period: { value: 1, unit: "d" }, text: "one day limit",
    }] } })));
    rows[0].maxDosePerPeriod![0].numerator!.value = 3;
    expect(toDosageDetails(rows).step![0].component[0].safety!.doseLimit).toEqual([{
      scope: "period", valueQuantity: q(3), period: { value: 1, unit: "d" }, text: "one day limit",
    }]);
  });

  it("does not transfer an old limit's text onto a different explicit ID", () => {
    const rows = persist(toFhirR5Dosages(course({ safety: { doseLimit: [{
      id: "old", scope: "period", valueQuantity: q(4), period: { value: 1, unit: "d" }, text: "old label",
    }] } })));
    rows[0].maxDosePerPeriod![0].id = "new";
    rows[0].maxDosePerPeriod![0].numerator!.value = 3;
    expect(toDosageDetails(rows).step![0].component[0].safety!.doseLimit).toEqual([{
      id: "new", scope: "period", valueQuantity: q(3), period: { value: 1, unit: "d" },
    }]);
  });

  it.each(["dose", "rate"] as const)("keeps anonymous %s expressions with their distinct numeric sibling on reordering", dimension => {
    const entries = dimension === "dose" ? [
      { doseExpression: expression("firstDose"), rateQuantity: { value: 5, unit: "mL/h" } },
      { doseExpression: expression("secondDose"), rateQuantity: { value: 10, unit: "mL/h" } },
    ] : [
      { doseQuantity: { value: 5, unit: "mg" }, rateExpression: expression("firstRate") },
      { doseQuantity: { value: 10, unit: "mg" }, rateExpression: expression("secondRate") },
    ];
    const rows = persist(toFhirR5Dosages(course({ doseAndRate: entries })));
    rows[0].doseAndRate!.reverse();
    let actual = toDosageDetails(rows);
    const expected = [entries[1], entries[0]];
    for (let save = 0; save < 3; save++) {
      expect(actual.step![0].component[0].doseAndRate).toEqual(expected);
      actual = toDosageDetails(persist(toFhirR5Dosages(actual)));
    }
  });

  it("restores an anonymous expression's unique surviving numeric sibling after deletion", () => {
    const entries = [
      { doseExpression: expression("firstDose"), rateQuantity: { value: 5, unit: "mL/h" } },
      { doseExpression: expression("secondDose"), rateQuantity: { value: 10, unit: "mL/h" } },
    ];
    const rows = persist(toFhirR5Dosages(course({ doseAndRate: entries })));
    rows[0].doseAndRate!.splice(0, 1);
    expect(toDosageDetails(rows).step![0].component[0].doseAndRate).toEqual([entries[1]]);
  });

  it("uses each expression-only slot's own typed source when reordered", () => {
    const entries = [ { doseExpression: expression("firstDose") }, { doseExpression: expression("secondDose") } ];
    const rows = persist(toFhirR5Dosages(course({ doseAndRate: entries })));
    rows[0].doseAndRate!.reverse();
    expect(toDosageDetails(rows).step![0].component[0].doseAndRate).toEqual([entries[1], entries[0]]);
  });

  it("keeps a numeric replacement authoritative after expression slots are reordered", () => {
    const rows = persist(toFhirR5Dosages(course({ doseAndRate: [
      { doseExpression: expression("firstDose"), rateQuantity: { value: 5, unit: "mL/h" } },
      { doseExpression: expression("secondDose"), rateQuantity: { value: 10, unit: "mL/h" } },
    ] })));
    rows[0].doseAndRate!.reverse();
    rows[0].doseAndRate![0].doseQuantity = { value: 2, unit: "mg" };
    const actual = toDosageDetails(rows);
    expect(actual.step![0].component[0].doseAndRate).toEqual([
      { doseQuantity: { value: 2, unit: "mg" }, rateQuantity: { value: 10, unit: "mL/h" } },
      { doseExpression: expression("firstDose"), rateQuantity: { value: 5, unit: "mL/h" } },
    ]);
    expect(JSON.stringify(actual)).toContain("%secondDose");
  });

  it("keeps expression associations inert when numeric edits make the slots ambiguous", () => {
    const rows = persist(toFhirR5Dosages(course({ doseAndRate: [
      { doseExpression: expression("firstDose"), rateQuantity: { value: 5, unit: "mL/h" } },
      { doseExpression: expression("secondDose"), rateQuantity: { value: 10, unit: "mL/h" } },
    ] })));
    rows[0].doseAndRate!.reverse();
    rows[0].doseAndRate![0].rateQuantity!.value = 5;
    const actual = toDosageDetails(rows);
    expect(actual.step![0].component[0].doseAndRate).toEqual([
      { rateQuantity: { value: 5, unit: "mL/h" } }, { rateQuantity: { value: 5, unit: "mL/h" } },
    ]);
    expect(JSON.stringify(actual)).toContain("%firstDose");
    expect(JSON.stringify(actual)).toContain("%secondDose");
  });

  it.each(["empty", "denominator", "numerator", "primitive"] as const)("retains %s-only R5 period Ratio metadata through both boundaries", shape => {
    const ratio: FhirRatio = {
      id: "authored-ratio", extension: [{ url: "urn:test:ratio-note", valueString: "pending amount" }],
      ...(shape === "denominator" ? { denominator: { value: 1, unit: "d" } } : {}),
      ...(shape === "numerator" ? { numerator: q(4) } : {}),
      ...(shape === "primitive" ? {
        numerator: { _value: { extension: [{ url: "urn:test:pending", valueString: "not entered" }] }, unit: "tab" },
        denominator: { value: 1, unit: "d" },
      } : {}),
    };
    const rows: FhirDosage[] = [{ doseAndRate: [{ doseQuantity: q(1) }], maxDosePerPeriod: [ratio] }];
    const validRatio = shape === "empty" || shape === "primitive";
    const checkR5 = (row: FhirDosage) => {
      expect(row.maxDosePerPeriod).toEqual(validRatio ? [ratio] : undefined);
      if (!validRatio) {
        const marker = row.extension!.find(value => value.url === R5_SOURCE_ONLY_MAXIMUM_URL)!;
        expect(marker.valueRatio).toBeUndefined();
        expect(readRetainedField(marker)).toEqual(ratio);
      }
    };
    checkR5(toFhirR5Dosages(rows)[0]);
    let r6 = toDosageDetails(persist(rows));
    for (let save = 0; save < 3; save++) {
      const member = r6.step![0].component[0];
      expect(member.safety?.doseLimit).toBeUndefined();
      const marker = member.extension!.find(value => value.url === R5_SOURCE_ONLY_MAXIMUM_URL)!;
      expect(marker.valueRatio).toBeUndefined();
      expect(readRetainedField(marker)).toEqual(ratio);
      expect(importCanonicalCourse(r6).stages[0].administrations[0].limits).toBeUndefined();
      const saved = persist(toFhirR5Dosages(r6));
      checkR5(saved[0]);
      r6 = toDosageDetails(saved);
    }
  });

  it.each([simpleQuantityForR5, quantityForR5])("replaces authored EMA equality when the current comparator changes", convert => {
    const coding = { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000049", display: "equal to",
      _display: { extension: [{ url: "urn:test:translation", valueString: "เท่ากับ" }] } };
    const unrelated = { url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000054", display: "range" } };
    const source: FhirR6Quantity = { value: 4, unit: "mg", extension: [
      { id: "operator", url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL, valueCoding: coding }, unrelated,
    ] };
    expect(convert(source)).toBe(source);
    const changed = convert({ ...source, comparator: "<" })!;
    const operators = changed.extension!.filter(item => item.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL);
    expect(operators).toEqual(convert === simpleQuantityForR5 ? [
      { id: "operator", url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
        valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000050", display: "less than" } }, unrelated,
    ] : [unrelated]);
    expect(getQuantityComparator(changed)).toBe("<");
    expect(changed.extension).toContainEqual({
      url: "urn:ezmedicationinput:StructureDefinition:quantity-operator-source",
      ...(convert === simpleQuantityForR5 ? { valueCoding: coding } : { extension: [source.extension![0]] }),
    });
    expect(convert(persist({ ...changed, comparator: "<" }))).toEqual(changed);
    const exact = { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000049", display: "equal to" };
    expect(convert({ value: 4, unit: "mg", comparator: "<", extension: [{
      url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL, valueCoding: exact,
    }] })!.extension).toContainEqual({
      url: "urn:ezmedicationinput:StructureDefinition:quantity-operator-source",
      ...(convert === simpleQuantityForR5 ? { valueCoding: exact } : { extension: [{
        url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL, valueCoding: exact,
      }] }),
    });

  });

  it.each(["draft", "safety"] as const)("preserves authored IDs on recognized %s snapshot children and stays stable", kind => {
    const initial = toDosageDetails([{ sequence: kind === "draft" ? 2 : 1, doseAndRate: [{ doseQuantity: q(1) }] }],
      undefined, { step: kind === "draft" ? [{ sequence: 1, id: "draft-step" }] : [
        { sequence: 1, safety: { doseLimit: [{ scope: "dosage", valueInteger: 3 }] } },
      ] });
    const url = kind === "draft" ? R6_DRAFT_STEPS_SOURCE_URL : R6_SINGLE_STEP_SAFETY_SOURCE_URL;
    const marker = initial.extension!.find(item => item.url === url)!;
    marker.id = "marker-id";
    const projected = marker.extension!.find(item => item.url === "projected")!;
    projected.id = "projected-child-id";
    projected.extension![0].id = "nested-child-id";
    let current = initial;
    for (let save = 0; save < 3; save++) {
      current = r6Save(current);
      expect(current.extension!.find(item => item.url === url)).toEqual(marker);
      expect(current.extension!.filter(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL)).toHaveLength(0);
    }
  });

  it("retires changed safety source once while retaining recognized child metadata", () => {
    const original = toDosageDetails([{ sequence: 1, doseAndRate: [{ doseQuantity: q(1) }] }], undefined,
      { step: [{ sequence: 1, safety: { doseLimit: [{ scope: "dosage", valueInteger: 3 }] } }] });
    const marker = original.extension!.find(item => item.url === R6_SINGLE_STEP_SAFETY_SOURCE_URL)!;
    marker.extension!.find(item => item.url === "projected")!.id = "retired-projected-id";
    original.safety!.doseLimit![0].valueInteger = 4;
    let current = r6Save(original);
    expect(current.safety!.doseLimit).toEqual([{ scope: "dosage", valueInteger: 4 }]);
    expect(current.extension!.find(item => item.url === R6_SINGLE_STEP_SAFETY_SOURCE_URL)).toBeUndefined();
    const history = current.extension!.filter(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL);
    const retainedChildren: Array<typeof marker> = [];
    for (const item of history) retainedChildren.push(...(item.extension ?? []));
    expect(retainedChildren).toContainEqual(marker);
    for (let save = 0; save < 3; save++) {
      current = r6Save(current);
      expect(current.safety!.doseLimit).toEqual([{ scope: "dosage", valueInteger: 4 }]);
      expect(current.extension!.filter(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL)).toEqual(history);
    }
  });

  it("preserves an authored condition bridge ID while consuming the plain generated bridge", () => {
    const plain: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }] };
    setDosageCondition(plain, { kind: "measurement", name: "systolic blood pressure", operation: "gt", value: 140, text: "systolic blood pressure above 140 mmHg", unit: "mmHg" });
    const bridge = plain.modifierExtension!.find(item => item.url === DOSAGE_CONDITION_R5_URL)!;
    expect(isExactConditionBridge(bridge)).toBe(true);
    const active = toDosageDetails([plain]).step![0].component[0];
    expect(active.modifierExtension).toBeUndefined();
    expect(active.condition).toEqual([{
      code: { text: "systolic blood pressure", coding: [{
        system: "urn:ezmedicationinput:CodeSystem:medication-condition", code: "measurement", display: "systolic blood pressure",
      }] }, operation: "gt",
      valueQuantity: { value: 140, unit: "mmHg" }, text: "systolic blood pressure above 140 mmHg",
    }]);
    bridge.id = "authored-condition-bridge";
    expect(isExactConditionBridge(bridge)).toBe(false);
    let result = toDosageDetails(persist([plain]));
    for (let save = 0; save < 3; save++) {
      const component = result.step![0].component[0];
      expect(component.modifierExtension?.some(item => item.url === DOSAGE_CONDITION_R5_URL)).not.toBe(true);
      expect(component.extension, "condition source save " + save).toContainEqual({
        url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [bridge],
      });
      result = toDosageDetails(persist(toFhirR5Dosages(result)));
    }
  });
});

describe("round23 external R6 wording across R5", () => {
  it("does not certify the old graph when the current text alone is explicitly replaced", () => {
    const source = persist(parseSig("Take 1 tablet orally daily.").fhirNext);
    source.step![0].component[0].doseAndRate![0].rateQuantity = { value: 5, unit: "mL/h" };
    let rows = persist(toFhirR5Dosages(source));
    const replacement = "Take 1 tablet every morning with the prescribed infusion.";
    rows[0].text = replacement;
    for (let save = 0; save < 3; save++) {
      expect(dosageMatchesSavedProjection(rows[0])).toBe(false);
      expect(rows[0].text).toBe(replacement);
      expect(formatSig(rows[0], "long", { locale: "en", realizationMode: "roundtrip" })).toBe(replacement);
      rows = persist(toFhirR5Dosages(rows));
    }
  });

  it("accepts explicit text and dose replacements on a later unverified R5 row", () => {
    const source = persist(parseSig("Take 1 tablet orally daily.").fhirNext);
    const component = source.step![0].component[0];
    component.doseAndRate![0].rateQuantity = { value: 5, unit: "mL/h" };
    source.step![0].component.push(persist(component));
    const rows = persist(toFhirR5Dosages(source));
    rows[1].doseAndRate![0].doseQuantity!.value = 2;
    rows[1].text = "Take 2 tablets orally each morning with the prescribed infusion.";
    expect(formatSig(rows[1], "long", { locale: "en", realizationMode: "roundtrip" })).toBe(rows[1].text);
    const current = toDosageDetails(rows);
    expect(current.step![0].component[1].text).toBe(rows[1].text);
    expect(current.step![0].component[1].doseAndRate![0].doseQuantity!.value).toBe(2);
    expect(JSON.stringify(current)).toContain("Take 1 tablet orally daily.");
  });

  it("keeps fromDosageDetails wording unverified through persisted R6 and R5 crossings", () => {
    const source = persist(parseSig("Take 1 tablet orally daily.").fhirNext);
    source.step![0].count = 2;
    const component = source.step![0].component[0];
    component.doseAndRate![0].doseQuantity!.value = 2;
    component.doseAndRate![0].rateQuantity = { value: 5, unit: "mL/h" };
    let edit = persist(fromDosageDetails(source));
    for (let save = 0; save < 3; save++) {
      expect(edit.course.renderedInstruction).toBe("Take 1 tablet orally daily.");
      expect(edit.dosages[0].text).toContain("1 tablet");
      expect(edit.dosages[0].doseAndRate![0].doseQuantity!.value).toBe(2);
      expect(dosageMatchesSavedProjection(edit.dosages[0])).toBe(false);
      for (const input of [edit.dosages, edit.dosages[0]]) {
        const display = formatSig(input, "long", { locale: "en", realizationMode: "roundtrip" });
        expect(display).toContain("2 tablets");
        expect(display).not.toContain("1 tablet");
      }
      const reopened = persist(toDosageDetails(edit.dosages));
      expect(reopened.renderedInstruction).toBe("Take 1 tablet orally daily.");
      expect(reopened.step![0].component[0].doseAndRate![0].doseQuantity!.value).toBe(2);
      edit = persist(fromDosageDetails(reopened));
    }
  });

  it("retains an explicit replacement course instruction without discarding its original", () => {
    const source = persist(parseSig("Take 1 tablet orally daily.").fhirNext);
    source.step![0].count = 2;
    source.step![0].component[0].doseAndRate![0].doseQuantity!.value = 2;
    const edit = persist(fromDosageDetails(source));
    edit.dosages[0].doseAndRate![0].doseQuantity!.value = 2;
    edit.course.renderedInstruction = "Take 2 tablets daily; repeat this course twice as directed.";
    const current = toDosageDetails(edit.dosages, undefined, edit.course);
    expect(current.renderedInstruction).toBe(edit.course.renderedInstruction);
    expect(current.step![0].component[0].doseAndRate![0].doseQuantity!.value).toBe(2);
    expect(JSON.stringify(current)).toContain("Take 1 tablet orally daily.");
    const native = courseFromR5(edit.dosages, undefined, edit.course);
    const projected = projectCanonicalCourse(native).fhir;
    expect(formatSig(projected, "long", { locale: "en", realizationMode: "roundtrip" })).toBe(edit.course.renderedInstruction);
    expect(projected[0].text).toContain("1 tablet");
    expect(formatSig(projected[0], "long", { locale: "en", realizationMode: "roundtrip" })).toContain("2 tablets");
  });

  it.each([true, false])("marks each later rich R5 row independently without duplicating source headers (header %s)", header => {
    const source = persist(parseSig("Take 1 tablet orally daily.").fhirNext);
    if (!header) delete source.renderedInstruction;
    const component = source.step![0].component[0];
    component.doseAndRate![0].doseQuantity!.value = 2;
    component.doseAndRate![0].rateQuantity = { value: 5, unit: "mL/h" };
    source.step![0].component.push(persist(component));
    let rows = persist(toFhirR5Dosages(source));
    for (let save = 0; save < 3; save++) {
      for (const row of rows) {
        expect(formatSig(row, "long", { locale: "en", realizationMode: "roundtrip" })).toContain("2 tablets");
        expect(row.text).toContain("1 tablet");
      }
      expect(rows[1].extension!.filter(item => item.url === DOSAGE_RENDERED_INSTRUCTION_R5_URL)).toEqual([{
        url: DOSAGE_RENDERED_INSTRUCTION_R5_URL, extension: [
          { url: "sourceAgreement", valueBoolean: false },
          { url: "textFingerprint", valueString: expect.any(String) },
        ],
      }]);
      const reopened = toDosageDetails(rows);
      expect(reopened.renderedInstruction).toBe(source.renderedInstruction);
      rows = persist(toFhirR5Dosages(reopened));
    }
  });

  it.each([
    ["step", undefined], ["step", "roundtrip"], ["rate", undefined], ["rate", "roundtrip"],
  ] as const)("uses current dose after a rich %s R6 source crosses R5 (mode %s)", (shape, realizationMode) => {
    const source = persist(parseSig("Take 1 tablet orally daily.").fhirNext);
    const component = source.step![0].component[0];
    component.doseAndRate![0].doseQuantity!.value = 2;
    if (shape === "step") source.step![0].count = 2;
    else component.doseAndRate![0].rateQuantity = { value: 5, unit: "mL/h" };
    let rows = persist(toFhirR5Dosages(source));
    for (let save = 0; save < 3; save++) {
      expect(rows[0].doseAndRate![0].doseQuantity!.value).toBe(2);
      const display = formatSig(rows, "long", { locale: "en", realizationMode });
      expect(display).toContain("2 tablets");
      expect(display).not.toContain("1 tablet");
      expect(JSON.stringify(rows)).toContain("Take 1 tablet orally daily.");
      const reopened = toDosageDetails(rows);
      expect(reopened.renderedInstruction).toBe(source.renderedInstruction);
      rows = persist(toFhirR5Dosages(reopened));
    }
  });

  it.each([undefined, "roundtrip"] as const)("does not bless a stale one-tablet R6 source after exporting two tablets (mode %s)", realizationMode => {
    const source = persist(parseSig("Take 1 tablet orally daily.").fhirNext);
    source.step![0].component[0].doseAndRate![0].doseQuantity!.value = 2;
    let rows = persist(toFhirR5Dosages(source));
    for (let save = 0; save < 3; save++) {
      expect(rows[0].doseAndRate![0].doseQuantity!.value).toBe(2);
      const display = formatSig(rows, "long", { locale: "en", realizationMode });
      expect(display).toContain("2 tablets");
      expect(display).not.toContain("1 tablet");
      expect(JSON.stringify(rows)).toContain("Take 1 tablet orally daily.");
      rows = persist(toFhirR5Dosages(toDosageDetails(rows)));
    }
  });
});

describe("round23 typed timing replay observations", () => {
  it.each([TIMING_OFFSET_EXACT_EXTENSION_URL, TIMING_OFFSET_MIN_EXTENSION_URL, TIMING_OFFSET_MAX_EXTENSION_URL])(
    "invalidates cached timing after an in-place typed offset edit: %s", url => {
      const timing = { repeat: { extension: [{ url, valueDecimal: 0.5 }] } };
      const proof = captureSourceReplayTiming(timing);
      expect(matchesSourceReplayTiming(timing, proof)).toBe(true);
      timing.repeat.extension[0].valueDecimal = 1.5;
      expect(matchesSourceReplayTiming(timing, proof)).toBe(false);
    });

  it.each([false, true])("renders an externally edited Thai minimum offset from 30 to 60 minutes (persisted %s)", saved => {
    const parsed = parseSig("รับประทาน 1 เม็ด ก่อนอาหารอย่างน้อย 30 นาที", { locale: "th" });
    const row = saved ? persist(parsed.fhir[0]) : parsed.fhir[0];
    expect(formatSig(row, "long", { locale: "th" })).toContain("30 นาที");
    row.timing!.repeat!.extension!.find(item => item.url === TIMING_OFFSET_MIN_EXTENSION_URL)!.valueInteger = 60;
    const text = formatSig(row, "long", { locale: "th" });
    expect(text).toBe("รับประทานครั้งละ 1 เม็ด ก่อนอาหารอย่างน้อย 1 ชั่วโมง.");
    expect(text).not.toContain("30 นาที");
  });
});


describe("round24 supported FHIR edit boundaries", () => {
  const ucum = "http://unitsofmeasure.org";
  const relative = (value: number) => ({ contextCode: { coding: [{
    system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start",
  }] }, offsetDuration: { value, unit: "d", code: "d" } });
  const approximate: FhirExtension = { url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
    valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000055" } };

  it("uses a live positive R6 frequency and retires only its old zero marker", () => {
    const sibling = { id: "timing-note", url: "urn:test:frequency-note", valueString: "keep" };
    const input = course({ timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day,
      extension: [{ url: TIMING_FREQUENCY_MIN_EXTENSION_URL, valueInteger: 0 }, sibling],
    } } });
    const native = importCanonicalCourse(input);
    expect(native.stages[0].administrations[0].schedule?.recurrence?.frequency).toBe(2);
    for (const row of [courseToR6(native).step![0].component[0], toFhirR5Dosages(input)[0]]) {
      expect(row.timing?.repeat?.frequency).toBe(2);
      expect(row.timing?.repeat?.extension).toEqual([sibling]);
    }
    const zero = persist(input);
    delete zero.step![0].component[0].timing!.repeat!.frequency;
    expect(importCanonicalCourse(zero).stages[0].administrations[0].schedule?.recurrence?.frequency).toBe(0);
  });

  it("leaves ambiguous legacy same-site references inert while matching a distinct site", () => {
    const concepts = [{ text: "eye" }, { text: "eye" }, { text: "left arm" }];
    const references = ["BodyStructure/right-eye", "BodyStructure/left-eye", "BodyStructure/left-arm"];
    const marker: FhirExtension = { url: DOSAGE_DETAILS_R5_URL, extension: [{
      url: "dosageDetails", extension: [{ url: "step", extension: concepts.map((concept, index) => ({
        url: "component", extension: [
          { url: "site", valueCodeableReference: { concept, reference: { reference: references[index] } } },
          { url: "doseAndRate", extension: [{ url: "doseQuantity", valueQuantity: q(index + 1) }] },
        ],
      })) }],
    }] };
    const rows: FhirDosage[] = [1, 0, 2].map(index => ({ sequence: 1, site: concepts[index],
      doseAndRate: [{ doseQuantity: q((index + 1) * 10) }], modifierExtension: [marker],
    }));
    const result = toDosageDetails(persist(rows));
    expect(result.step![0].component.map(value => value.doseAndRate![0].doseQuantity!.value)).toEqual([20, 10, 30]);
    expect(result.step![0].component.slice(0, 2).map(value => value.site)).toEqual([
      { concept: concepts[0] }, { concept: concepts[1] },
    ]);
    expect(result.step![0].component[2].site).toEqual({ concept: concepts[2], reference: { reference: references[2] } });
    expect(result.extension?.filter(value => value.url === DOSAGE_RECONCILIATION_SOURCE_URL)
      .some(value => value.extension?.some(source => JSON.stringify(source) === JSON.stringify(marker)))).toBe(true);
  });

  it("keeps an in-memory external edit to a synthesized start independent of its draft snapshot", () => {
    const input: FhirR6DosageInstruction = { step: [
      { end: relative(2), component: [] }, { component: [{ doseAndRate: [{ doseQuantity: q(1) }] }] },
    ] };
    const output = courseToR6(importCanonicalCourse(input));
    expect(importCanonicalCourse(output).stages.map(stage => stage.administrations.length)).toEqual([0, 1]);
    output.step![0].start!.contextCode!.coding![0].code = "treatment-end";
    const marker = output.extension!.find(value => value.url === R6_DRAFT_STEPS_SOURCE_URL)!;
    const saved = decodeR6SourceMetadata(marker, "drafts") as { projected: FhirR6DosageStep[] };
    expect(saved.projected[0].start!.contextCode!.coding![0].code).toBe("treatment-start");
    const current = importCanonicalCourse(output);
    expect(current.stages).toHaveLength(1);
    expect(courseToR6(current).step![0].start).toEqual({
      ...relative(2), contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-end" }] },
    });
  });

  it("keeps period-local offsets for frequency edits but retires changed or ineligible periods", () => {
    const input = course({ timing: { repeat: { frequency: 21, period: 28, periodUnit: FhirPeriodUnit.Day,
      startOffset: { value: 2, unit: "d", code: "d" }, endOffset: { value: 5, unit: "d", code: "d" },
    } } });
    const rows = persist(toFhirR5Dosages(input));
    rows[0].timing!.repeat!.frequency = 20;
    expect(toDosageDetails(rows).step![0].component[0].timing!.repeat).toEqual({
      frequency: 20, period: 28, periodUnit: FhirPeriodUnit.Day,
      startOffset: { value: 2, unit: "d", code: "d" }, endOffset: { value: 5, unit: "d", code: "d" },
    });
    for (const edit of [{ period: 30 }, { frequency: 1 }]) {
      const changed = persist(rows);
      Object.assign(changed[0].timing!.repeat!, edit);
      const repeat = toDosageDetails(changed).step![0].component[0].timing!.repeat!;
      expect(repeat).not.toHaveProperty("startOffset");
      expect(repeat).not.toHaveProperty("endOffset");
    }
  });

  it("gives an emitted native Quantity comparator sole authority over enriched EMA source", () => {
    const authored: FhirExtension = { id: "operator-source", ...approximate,
      valueCoding: { ...approximate.valueCoding!, display: "approximately equal to",
        _display: { extension: [{ url: "urn:test:translation", valueString: "ประมาณ" }] } } };
    const input: FhirDosage = { doseAndRate: [{ rateRatio: {
      numerator: { value: 50, unit: "mL", extension: [authored] }, denominator: { value: 1, unit: "h" },
    } }] };
    const output = courseToR6(importCanonicalCourse(input));
    const numerator = output.step![0].component[0].doseAndRate![0].rateRatio!.numerator!;
    expect(numerator.comparator).toBe("~");
    expect(numerator.extension?.some(value => value.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL)).toBe(false);
    expect(numerator.extension).toContainEqual({ url: "urn:ezmedicationinput:StructureDefinition:quantity-operator-source", extension: [authored] });
    delete numerator.comparator;
    const cleared = courseToR6(importCanonicalCourse(output));
    expect(getQuantityComparator(cleared.step![0].component[0].doseAndRate![0].rateRatio!.numerator)).toBeUndefined();
    expect(cleared.step![0].component[0].doseAndRate![0].rateRatio!.numerator!.extension).toEqual(numerator.extension);
    expect(getQuantityComparator(input.doseAndRate![0].rateRatio!.numerator)).toBe("~");
  });

  it.each(["at most 5 mg PO daily", "approximately 5 mg PO daily"])("marks a parsed qualified R5 dose as modified: %s", text => {
    const parsed = parseSig(text);
    const row = parsed.fhir[0];
    expect(row.doseAndRate![0].doseQuantity!.value).toBe(5);
    expect(row.doseAndRate![0].doseQuantity).not.toHaveProperty("comparator");
    const modifier = row.modifierExtension!.find(value => value.url === DOSAGE_DETAILS_R5_URL)!;
    expect(modifier).toBeDefined();
    const retained = decodeR5RetainedFields(modifier);
    expect(retained.component!.doseAndRate![0].doseQuantity!.value).toBe(5);
    expect(getQuantityComparator(retained.component!.doseAndRate![0].doseQuantity)).toBe(text.startsWith("at most") ? "<=" : "~");
    expect(getQuantityComparator(toDosageDetails(persist([row])).step![0].component[0].doseAndRate![0].doseQuantity))
      .toBe(text.startsWith("at most") ? "<=" : "~");
    expect(parseSig("5 mg PO daily").fhir[0].modifierExtension?.some(value => value.url === DOSAGE_DETAILS_R5_URL)).not.toBe(true);
  });

  it.each([
    { text: "at most 5 mg daily then at most 3 mg daily", counts: [1, 1] },
    { text: "at most 5 mg every morning and at most 3 mg every evening", counts: [2] },
  ])("assigns final source indices to qualified parser rows: $text", ({ text, counts }) => {
    const parsed = parseSig(text);
    const rows = persist(parsed.fhir);
    expect(rows.map(row => decodeR5RetainedFields(row.modifierExtension!
      .find(value => value.url === DOSAGE_DETAILS_R5_URL)!).rowIndex)).toEqual([0, 1]);
    const unchanged = toDosageDetails(rows);
    expect(unchanged.renderedInstruction).toBe(text);
    expect(unchanged.step!.map(step => step.component.length)).toEqual(counts);
    expect(unchanged.extension?.some(value => value.url === DOSAGE_RECONCILIATION_SOURCE_URL)).not.toBe(true);
    rows[1].doseAndRate![0].doseQuantity!.value = 7;
    const edited = toDosageDetails(rows);
    const components = edited.step!.length === 2
      ? [edited.step![0].component[0], edited.step![1].component[0]] : edited.step![0].component;
    expect(components.map(value => value.doseAndRate![0].doseQuantity!.value)).toEqual([5, 7]);
    expect(components.map(value => getQuantityComparator(value.doseAndRate![0].doseQuantity))).toEqual(["<=", "<="]);
    expect(components[0].text).toBe(parsed.fhir[0].text);
    expect(components[1].text).toBeUndefined();
    expect(edited.renderedInstruction).toBeUndefined();
  });

  it("marks qualified range endpoints and ratio denominators on strict R5 output", () => {
    const input = course({ doseAndRate: [{ doseRange: { low: simpleQuantityForR5({ value: 2, unit: "mg", comparator: "~" })!, high: { value: 4, unit: "mg" } },
      rateRatio: { numerator: { value: 50, unit: "mL" }, denominator: simpleQuantityForR5({ value: 1, unit: "h", comparator: ">=" })! } }] });
    const rows = toFhirR5Dosages(input);
    expect(rows[0].modifierExtension?.some(value => value.url === DOSAGE_DETAILS_R5_URL)).toBe(true);
    const amount = toDosageDetails(persist(rows)).step![0].component[0].doseAndRate![0];
    expect(getQuantityComparator(amount.doseRange!.low)).toBe("~");
    expect(getQuantityComparator(amount.rateRatio!.denominator)).toBe(">=");
  });

  it.each([false, true])("invalidates the live month-day replay proof after an in-place edit (persisted=%s)", saved => {
    const parsed = parseSig("Take 1 tablet PO on day 1 of every month");
    const row = saved ? persist(parsed.fhir[0]) : parsed.fhir[0];
    formatSig(row, "long", { locale: "en", realizationMode: "roundtrip" });
    const marker = row.timing!.repeat!.extension!.find(value => value.url === TIMING_DAY_OF_MONTH_EXTENSION_URL)!;
    expect(marker.valuePositiveInt).toBe(1);
    marker.valuePositiveInt = 15;
    const text = formatSig(row, "long", { locale: "en", realizationMode: "roundtrip" });
    expect(text).toMatch(/(?:^|[^0-9])15(?:[^0-9]|$)/u);
    expect(text).not.toContain("day 1 of every month");
    expect(dosageMatchesSavedProjection(row)).toBe(false);
  });

  it.each([undefined, "~"] as const)("keeps a lower-only duration range and its endpoint qualifier %s", comparator => {
    const low = simpleQuantityForR5({ value: 5, unit: "days", code: "d", system: ucum, ...(comparator ? { comparator } : {}) })!;
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: { frequency: 1,
      period: 1, periodUnit: FhirPeriodUnit.Day, boundsRange: { low },
    } } };
    const clause = canonicalFromFhir(row);
    expect(clause.schedule?.durationIsRange).toBe(true);
    expect(clause.schedule?.duration).toBe(5);
    expect(clause.schedule?.durationMax).toBeUndefined();
    const restored = canonicalToFhir(clause);
    expect(restored.timing!.repeat!.boundsRange).toEqual({ low });
    expect(restored.timing!.repeat!.boundsDuration).toBeUndefined();
    const native = importCanonicalCourse(row);
    expect(native.stages[0].administrations[0].schedule?.recurrence?.courseLength).toBeUndefined();
    expect(native.stages[0].administrations[0].schedule?.recurrence?.courseLengthRange?.low?.value).toBe(5);
    for (const wire of [row, courseToR6(native)]) {
      expect(formatSig(wire, "short", { locale: "en", realizationMode: "normalized" })).toContain(`x>=${comparator ?? ""}5d`);
      expect(formatSig(wire, "long", { locale: "en", realizationMode: "normalized" })).toContain(`for at least ${comparator ?? ""}5 days`);
      expect(formatSig(wire, "long", { locale: "th", realizationMode: "normalized" })).toContain(`อย่างน้อย ${comparator ?? ""}5 วัน`);
    }
    const scalar = canonicalFromFhir({ timing: { repeat: { boundsDuration: { value: 5, code: "d" } } } });
    expect(scalar.schedule?.durationIsRange).toBeUndefined();
    expect(canonicalToFhir(scalar).timing?.repeat?.boundsDuration?.value).toBe(5);
    const upper = canonicalToFhir(canonicalFromFhir({ timing: { repeat: { boundsRange: { high: { value: 5, code: "d" } } } } }));
    expect(upper.timing?.repeat?.boundsRange?.low).toBeUndefined();
    expect(upper.timing?.repeat?.boundsRange?.high?.value).toBe(5);
  });

  it("accepts the pinned R6 Timing and condition choices without executing uninterpreted values", () => {
    const timing: FhirR6Timing = { modifierExtension: [{ url: "urn:test:timing-modifier", valueBoolean: true }],
      repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } };
    const conditions: FhirR6DosageCondition[] = [
      { code: { text: "observer count" }, valuePositiveInt: 3, _valuePositiveInt: { id: "count-value" } },
      { code: { text: "opaque large integer" }, valueInteger64: "9223372036854775807" },
      { code: { text: "clinical availability" }, valueAvailability: { availableTime: [{ daysOfWeek: ["mon"] }] } },
      { code: { text: "external dosage detail" }, valueDosage: { patientInstruction: "source condition" } },
    ];
    // @ts-expect-error A positiveInt is numeric, with no permissive index signature.
    const invalid: FhirR6DosageCondition = { code: { text: "count" }, valuePositiveInt: "three" };
    void invalid;
    const input = course({ timing, condition: conditions });
    expect(courseToR6(importCanonicalCourse(input)).step![0].component[0].timing).toEqual(timing);
    const current = toDosageDetails(persist(toFhirR5Dosages(input)));
    expect(current.step![0].component[0].condition).toEqual(conditions);
    expect(importCanonicalCourse(input).stages[0].administrations[0].predicate?.kind).not.toBe("measurement");
  });

  it("accepts the public optional-step R6 input type at both execution APIs", () => {
    const input: FhirR6DosageInstructionInput = course({ timing: { repeat: {
      frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"],
    } } });
    const options = { from: "2026-11-20T00:00:00Z", orderedAt: "2026-11-20T00:00:00Z", timeZone: "UTC", limit: 2 };
    expect(nextDueDoses(input, options)).toEqual(["2026-11-20T08:00:00+00:00", "2026-11-21T08:00:00+00:00"]);
    expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 2, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(2);
    const header: FhirR6DosageInstructionInput = { renderedInstruction: "Use as directed" };
    expect(nextDueDoses(header, options)).toEqual([]);
  });

  it("reopens an unchanged approximate Ratio draft snapshot and invalidates a real numerator edit", () => {
    const input: FhirR6DosageInstruction = { step: [{ id: "draft", component: [] }, { component: [{ doseAndRate: [{
      rateRatio: { numerator: { value: 50, unit: "mL", comparator: "~", extension: [approximate] },
        denominator: { value: 1, unit: "h" } },
    }] }] }] };
    const output = courseToR6(importCanonicalCourse(input));
    expect(importCanonicalCourse(persist(output)).stages.map(stage => stage.administrations.length)).toEqual([0, 1]);
    const numerator = output.step![0].component[0].doseAndRate![0].rateRatio!.numerator!;
    expect(numerator.comparator).toBe("~");
    const rows = persist(toFhirR5Dosages(output));
    expect(rows[0].doseAndRate![0].rateRatio!.numerator!.extension).toContainEqual(approximate);
    expect(rows[0].doseAndRate![0].rateRatio!.numerator!.comparator).toBeUndefined();
    const saved = decodeR5RetainedFields(rows[0].modifierExtension!.find(item => item.url === DOSAGE_DETAILS_R5_URL)!);
    const draftSource = saved.course!.extension!.find(item => item.url === R6_DRAFT_STEPS_SOURCE_URL)!;
    // Retained source keeps its authored wire spelling; the live R5 Quantity
    // above uses the existing EMA representation and the draft still reopens.
    expect(draftSource).toEqual(output.extension!.find(item => item.url === R6_DRAFT_STEPS_SOURCE_URL));
    const snapshot = decodeR6SourceMetadata(draftSource, "drafts") as { projected: FhirR6DosageStep[] };
    expect(snapshot.projected[0].component[0].doseAndRate![0].rateRatio!.numerator!.comparator).toBe("~");
    expect(importCanonicalCourse(rows).stages.map(stage => stage.administrations.length)).toEqual([0, 1]);
    numerator.value = 51;
    expect(importCanonicalCourse(persist(output)).stages.map(stage => stage.administrations.length)).toEqual([1]);
  });

  it("preserves limit wrapper metadata across coded display edits but not changed codes", () => {
    const metadata = { id: "limit-wrapper", extension: [{ url: "urn:test:limit-note", valueString: "authored" }] };
    const input = course({ safety: { doseLimit: [{ ...metadata, scope: "administration",
      valueQuantity: { value: 2, unit: "mg", system: ucum, code: "mg" },
    }] } });
    const rows = persist(toFhirR5Dosages(input));
    rows[0].maxDosePerAdministration!.unit = "milligrams";
    const limit = toDosageDetails(rows).step![0].component[0].safety!.doseLimit![0];
    expect(limit).toEqual({ ...metadata, scope: "administration", valueQuantity: { value: 2, unit: "milligrams", system: ucum, code: "mg" } });
    rows[0].maxDosePerAdministration!.code = "mL";
    rows[0].maxDosePerAdministration!.unit = "mL";
    const changed = toDosageDetails(rows).step![0].component[0].safety!.doseLimit![0];
    expect(changed.id).toBeUndefined();
    expect(changed.extension).toBeUndefined();
    expect(changed.valueQuantity!.code).toBe("mL");
  });

  it("keeps outer CodeableReference metadata after a live concept edit without reviving the old reference", () => {
    const metadata = { id: "site-wrapper", extension: [{ url: "urn:test:site-note", valueString: "authored" }] };
    const input = course({ site: { ...metadata, concept: { text: "right eye" }, reference: { reference: "BodyStructure/right-eye" } } });
    const rows = persist(toFhirR5Dosages(input));
    rows[0].site = { text: "left eye" };
    let current = toDosageDetails(rows);
    for (let save = 0; save < 3; save++) {
      expect(current.step![0].component[0].site).toEqual({ ...metadata, concept: { text: "left eye" } });
      expect(JSON.stringify(current.extension)).toContain("BodyStructure/right-eye");
      current = toDosageDetails(persist(toFhirR5Dosages(current)));
    }
  });
});


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
      expect(scoped.course.ifExceeded).toBeUndefined();
      expect(scoped.course.doseLimit).toEqual(courseSafety.doseLimit);
      expect(scoped.step).toEqual(stepSafety);
    }
    const retired: unknown[] = [];
    const collect = (extensions: readonly FhirExtension[] | undefined): void => {
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

  it.each([false, true])("observes an in-place saved R5 condition edit after warming replay (compound %s)", compound => {
    const text = "Take 1 tablet daily if SBP > 160, maximum 2 tablets per administration";
    const predicate = { kind: "measurement" as const, name: "SBP", operation: "gt" as const,
      value: 160, unit: "mmHg", text: "SBP > 160" };
    const raw: FhirDosage = { text, doseAndRate: [{ doseQuantity: q(1) }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
      maxDosePerAdministration: q(2) };
    setDosageCondition(raw, compound ? { kind: "all", conditions: [predicate,
      { kind: "state", name: "dizziness", expected: false, text: "no dizziness" }] } : predicate);
    const row = persist(withDosageEditProvenance([raw], text)[0]);
    expect(formatSig(row)).toBe(text);
    expect(formatSig(row)).toBe(text);
    const root = row.modifierExtension!.find(item => item.url === DOSAGE_CONDITION_R5_URL)!.extension![0];
    const leaf = compound ? root.extension!.find(item => item.url === "conditions")! : root;
    leaf.extension!.find(item => item.url === "value")!.valueDecimal = 150;
    expect(dosageMatchesSavedProjection(row)).toBe(false);
    const warm = formatSig(row);
    expect(warm).toBe(formatSig(persist(row)));
    expect(warm).toContain("150");
    expect(warm).not.toContain("160");
  });

  it("observes an in-place state predicate polarity edit without replaying its old text", () => {
    const text = "Take 1 tablet if dizziness, maximum 2 tablets per administration";
    const raw: FhirDosage = { text, doseAndRate: [{ doseQuantity: q(1) }], maxDosePerAdministration: q(2) };
    setDosageCondition(raw, { kind: "state", name: "dizziness", expected: true, text: "dizziness" });
    const row = persist(withDosageEditProvenance([raw], text)[0]);
    expect(formatSig(row)).toBe(text);
    const leaf = row.modifierExtension!.find(item => item.url === DOSAGE_CONDITION_R5_URL)!.extension![0];
    leaf.extension!.find(item => item.url === "expected")!.valueBoolean = false;
    const warm = formatSig(row);
    expect(warm).toBe(formatSig(persist(row)));
    expect(warm).toContain("not dizziness");
    expect(row.text).toBe(text);
  });

  it("observes a later strict R5 capped row's rate edit without losing unchanged authored text", () => {
    const text = "Infuse 5 mL/h, maximum 10 mL per administration";
    const input: FhirDosage[] = [
      { sequence: 1, text: "Give 1 mL", doseAndRate: [{ doseQuantity: { value: 1, unit: "mL" } }] },
      { sequence: 2, text, doseAndRate: [{ rateQuantity: { value: 5, unit: "mL/h" } }],
        maxDosePerAdministration: { value: 10, unit: "mL" } },
    ];
    const rows = persist(toFhirR5Dosages(withDosageEditProvenance(input, "Initial dose, then maintenance")));
    expect(formatSig(rows[1])).toBe(text);
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

  it("observes a fresh parser row's condition threshold without stale source text", () => {
    const row = parseSig("1 tab BID only if BP > 160").items[0].fhir;
    const original = row.text;
    expect(formatSig(row)).toContain("160");
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

  it.each(["fresh", "saved"] as const)("does not revive a removed %s condition", mode => {
    const parsed = parseSig("1 tab BID only if BP > 160").items[0].fhir;
    const row = mode === "fresh" ? parsed : persist(withDosageEditProvenance([parsed], parsed.text)[0]);
    expect(formatSig(row)).toContain("160");
    row.modifierExtension = row.modifierExtension!.filter(item => item.url !== DOSAGE_CONDITION_R5_URL);
    const text = formatSig(row);
    expect(text).not.toMatch(/BP|160|only if/u);
    expect(text).toMatch(/1 tab|one tablet/u);
    expect(fromFhirDosage(row).longText).not.toMatch(/BP|160|only if/u);
  });

  it.each(["relation", "activity", "offset", "offsetMin", "offsetMax"] as const)(
    "observes a nested activity-window %s edit after warming source replay", field => {
      const text = "Take 1 tablet 30 minutes after dialysis";
      const row = persist(withDosageEditProvenance([{
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

  it.each(["date", "weekday"] as const)("invalidates fresh source wording when a %s exclusion is added", kind => {
    const row = parseSig("Take 1 tablet twice daily").items[0].fhir;
    const original = row.text;
    if (kind === "date") setDosageExcludedDates(row, ["2026-01-02"]);
    else setDosageExcludedWeekdays(row, [FhirDayOfWeek.Monday]);
    for (const input of [row, persist(row)]) {
      expect(formatSig(input, "long")).toMatch(kind === "date" ? /2026-01-02/u : /Mon(?:day)?/u);
      expect(fromFhirDosage(input).longText).toMatch(kind === "date" ? /2026-01-02/u : /Mon(?:day)?/u);
    }
    expect(row.text).toBe(original);
  });

  it.each(["date", "weekday"] as const)("observes a %s exclusion edit after warming persisted source replay", kind => {
    const row: FhirDosage = { text: kind === "date" ? "Take one tablet except 2026-01-02." : "Take one tablet except Monday.",
      doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } } };
    if (kind === "date") setDosageExcludedDates(row, ["2026-01-02"]);
    else setDosageExcludedWeekdays(row, [FhirDayOfWeek.Monday]);
    const saved = persist(withDosageEditProvenance([row], row.text)[0]);
    expect(dosageMatchesSavedProjection(saved)).toBe(true);
    expect(formatSig(saved, "long", { realizationMode: "roundtrip" })).toBe(row.text);
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

  it("observes the existing extended R5 excluded-date array without reviving stale text", () => {
    const row = toEzDosages([parseSig("Take 1 tablet daily").items[0].fhir])[0];
    row.excludedDates = ["2026-01-02"];
    expect(formatSig(row, "long")).toContain("2026-01-02");
    const saved = persist(withDosageEditProvenance([row], "Take one tablet except 2026-01-02.")[0]);
    expect(dosageMatchesSavedProjection(saved)).toBe(true);
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
    const pending = { numerator: { _value: { id: "authored-maximum" } }, denominator: { value: 1, unit: "d" } };
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
      expect(actual).toMatch(/1 เม็ด/u);
      expect(actual).toContain(scope === "administration" ? "max per administration: 2 tab" :
        scope === "lifetime" ? "max lifetime: 2 tab" : "max per period: 2 tab / 1 d");
      expect(actual).not.toMatch(/Take one tablet/u);
    }
    expect(formatSig(row, "long", { realizationMode: "roundtrip" })).toBe(row.text);
    expect(JSON.stringify(row)).toBe(before);
  });

  it("keeps an annotation-only period numerator out of the active safety mirror", () => {
    const valid = { numerator: q(2), denominator: { value: 1, unit: "d" } };
    const pending = { id: "pending", numerator: { _value: { id: "numerator-note" } },
      denominator: { value: 1, unit: "d" } };
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }], maxDosePerPeriod: [valid, pending] };
    const lifted = toEzDosages([persist(row)])[0];
    expect(lifted.safety?.doseLimit).toEqual([{ scope: "period", valueQuantity: q(2), period: { value: 1, unit: "d" } }]);
    const output = toDosageDetails([lifted]);
    expect(output.step![0].component[0].safety?.doseLimit).toHaveLength(1);
    expect(JSON.stringify(output.step![0].component[0].extension)).toContain("numerator-note");
  });
  it.each(["value", "unit", "code", "system", "comparator", "ema", "removed"] as const)(
    "invalidates administration-duration source replay after a live %s edit", field => {
      const quantity = quantityForR5({ value: 2, unit: "h", code: "h", system: "http://unitsofmeasure.org", comparator: "~" })!;
      const timing = { repeat: { extension: [{ url: TIMING_ADMINISTRATION_DURATION_EXTENSION_URL, valueQuantity: quantity }] } };
      const proof = captureSourceReplayTiming(timing);
      expect(matchesSourceReplayTiming(timing, proof)).toBe(true);
      if (field === "value") quantity.value = 3;
      else if (field === "unit") quantity.unit = "min";
      else if (field === "code") quantity.code = "min";
      else if (field === "system") quantity.system = "urn:test:duration-unit";
      else if (field === "comparator") quantity.comparator = ">";
      else if (field === "ema") quantity.extension![0].valueCoding!.code = "100000000051";
      else timing.repeat.extension.length = 0;
      expect(matchesSourceReplayTiming(timing, proof)).toBe(false);
    });

  it("keeps first-marker semantics for an incomplete administration duration", () => {
    const empty: FhirExtension = { url: TIMING_ADMINISTRATION_DURATION_EXTENSION_URL };
    const timing = { repeat: { extension: [empty,
      { url: TIMING_ADMINISTRATION_DURATION_EXTENSION_URL, valueQuantity: { value: 8, unit: "h" } }] } };
    const proof = captureSourceReplayTiming(timing);
    expect(matchesSourceReplayTiming(timing, proof)).toBe(true);
    timing.repeat.extension[1].valueQuantity!.value = 9;
    expect(matchesSourceReplayTiming(timing, proof)).toBe(true);
    empty.valueQuantity = { value: 2, unit: "h", comparator: ">" };
    expect(matchesSourceReplayTiming(timing, proof)).toBe(false);
  });

  it("rejects stale persisted rate-duration wording after an in-place duration edit", () => {
    const row: FhirDosage = { text: "Infuse at 5 mL/hour over approximately two hours.",
      doseAndRate: [{ rateQuantity: { value: 5, unit: "mL/h" } }], timing: { repeat: { extension: [{
        url: TIMING_ADMINISTRATION_DURATION_EXTENSION_URL,
        valueQuantity: quantityForR5({ value: 2, unit: "h", comparator: "~" }),
      }] } } };
    const saved = persist(withDosageEditProvenance([row], row.text)[0]);
    expect(dosageMatchesSavedProjection(saved)).toBe(true);
    expect(formatSig(saved, "long", { realizationMode: "roundtrip" })).toBe(row.text);
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

describe("round33 interchange ownership families", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day };
  const relative = (value: number) => ({ contextCode: { coding: [{
    system: "urn:ezmedicationinput:CodeSystem:course-phase-event", code: "treatment-start",
  }] }, offsetDuration: { value, unit: "d" } });
  const threshold = (value: number) => ({
    kind: "measurement" as const, name: "sbp", operation: "gt" as const, value, text: "SBP above " + value, unit: "mmHg",
  });
  const induction = (identified = true, additionalComponent = false) => toDosageDetails([
    { id: "induction-dose", sequence: 1, doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } },
    ...(additionalComponent ? [{ id: "second-dose", sequence: 1, doseAndRate: [{ doseQuantity: q(0.5) }], timing: { repeat: daily } }] : []),
  ], undefined, { step: [{ sequence: 1, ...(identified ? { id: "induction" } : {}),
    safety: { doseLimit: [{ scope: "administration", valueQuantity: q(2) }], ifExceeded: "Review induction" },
  }] });

  it.each(["id", "extension"] as const)("keeps lifted safety on its phase after only %s changes", field => {
    let wire = persist(induction());
    wire.step!.push({ id: "maintenance", component: [{ doseAndRate: [{ doseQuantity: q(3) }], timing: { repeat: daily } }] });
    if (field === "id") wire.safety!.id = "updated-safety";
    else wire.safety!.extension = [{ url: "urn:test:safety-note", valueString: "updated-safety" }];
    const before = JSON.stringify(wire);
    for (let save = 0; save < 3; save++) {
      const native = importCanonicalCourse(wire);
      expect(native.safety).toBeUndefined();
      expect(native.stages[0].safety?.limits?.[0]).toMatchObject({ scope: "administration", amount: { value: 2 } });
      expect(native.stages[1].safety).toBeUndefined();
      expect(native.stages[1].administrations[0].amounts![0].quantity?.value).toBe(3);
      const output = r6Save(wire);
      expect(JSON.stringify(output.step![0].safety)).toContain("updated-safety");
      if (!save) expect(JSON.stringify(wire)).toBe(before);
      wire = save === 1 ? toDosageDetails(persist(toFhirR5Dosages(output))) : output;
    }
  });

  it.each(["dose", "component-order"] as const)("uses stable component identity for lifted phase safety after %s edits", edit => {
    let wire = induction(false, edit === "component-order");
    if (edit === "component-order") wire.step![0].component.reverse();
    wire.step![0].component.find(row => row.id === "induction-dose")!.doseAndRate![0].doseQuantity!.value = 1.5;
    for (let save = 0; save < 3; save++) {
      const native = importCanonicalCourse(wire);
      expect(native.safety).toBeUndefined();
      expect(native.stages[0].safety?.limits?.[0].amount?.value).toBe(2);
      expect(wire.step![0].component.find(row => row.id === "induction-dose")!.doseAndRate![0].doseQuantity!.value).toBe(1.5);
      wire = save === 1 ? toDosageDetails(persist(toFhirR5Dosages(wire))) : r6Save(wire);
    }
  });

  it.each(["replacement", "split-owner"] as const)("does not restore lifted policy on %s components", edit => {
    const wire = induction(false);
    if (edit === "replacement") wire.step![0].component[0].id = "replacement-dose";
    else wire.step!.push({ component: [persist(wire.step![0].component[0])] });
    wire.step![0].component[0].doseAndRate![0].doseQuantity!.value = 3;
    const native = importCanonicalCourse(wire);
    expect(native.safety).toBeUndefined();
    for (const stage of native.stages) expect(stage.safety).toBeUndefined();
    expect(JSON.stringify(r6Save(wire).extension)).toContain("Review induction");
  });

  it.each(["limit", "action"] as const)("keeps an actual %s edit authoritative", edit => {
    const wire = induction();
    if (edit === "limit") wire.safety!.doseLimit![0].valueQuantity!.value = 3;
    else wire.safety!.ifExceeded = "Contact the clinician";
    const native = importCanonicalCourse(wire);
    if (edit === "limit") {
      expect(native.stages[0].safety).toBeUndefined();
      expect(native.safety?.limits?.[0].amount?.value).toBe(3);
    } else {
      expect(native.safety?.ifExceeded).toBe("Contact the clinician");
      expect(native.safety?.limits ?? []).toEqual([]);
      expect(native.stages[0].safety?.limits?.[0].amount?.value).toBe(2);
      expect(native.stages[0].safety?.ifExceeded).toBeUndefined();
    }
  });

  it("keeps an explicit planned pause after a successor cadence edit", () => {
    let wire = toDosageDetails([
      { sequence: 1, doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } },
      { sequence: 3, doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: { ...daily, frequency: 2 } } },
    ], undefined, { step: [
      { sequence: 1, id: "induction", end: relative(3) },
      { sequence: 2, id: "pause", end: relative(5), extension: [{ url: "urn:test:pause", valueString: "Pause until day six" }] },
      { sequence: 3, id: "maintenance", end: relative(8) },
    ] });
    wire.step![1].component[0].timing!.repeat!.frequency = 1;
    for (let save = 0; save < 3; save++) {
      const native = importCanonicalCourse(wire);
      expect(native.stages.map(stage => stage.administrations.length)).toEqual([1, 0, 1]);
      expect(native.stages[1].end?.displacement?.value).toBe(5);
      expect(native.stages[2].end?.displacement?.value).toBe(8);
      expect(native.stages[2].administrations[0].schedule?.recurrence?.frequency).toBe(1);
      wire = r6Save(wire);
    }
  });

  it.each([false, true])("retires a qualified occurrence duration when exact core duration replaces it (annotation %s)", annotated => {
    const marker: FhirExtension = { url: TIMING_ADMINISTRATION_DURATION_EXTENSION_URL,
      ...(annotated ? { id: "old-duration-note" } : {}),
      valueQuantity: quantityForR5({ value: 90, unit: "min", comparator: "~" })! };
    let wire = toDosageDetails([{ doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: { ...daily, extension: [marker] } } }]);
    const original = persist(wire.step![0].component[0].timing!.repeat!.extension!.find(item => item.url === marker.url)!);
    expect(importCanonicalCourse(r6Save(wire)).stages[0].administrations[0].schedule?.recurrence)
      .toMatchObject({ occurrenceDuration: 90, occurrenceDurationUnit: "min", occurrenceDurationComparator: "~" });
    const repeat = wire.step![0].component[0].timing!.repeat!;
    repeat.duration = 60; repeat.durationUnit = FhirPeriodUnit.Minute;
    wire = r6Save(wire);
    expect(wire.step![0].component[0].timing!.repeat!.extension?.some(item => item.url === marker.url) ?? false).toBe(false);
    expect(importCanonicalCourse(wire).stages[0].administrations[0].schedule?.recurrence?.occurrenceDuration).toBe(60);
    expect(JSON.stringify(wire)).toContain(JSON.stringify(original));
    delete wire.step![0].component[0].timing!.repeat!.duration;
    delete wire.step![0].component[0].timing!.repeat!.durationUnit;
    for (let save = 0; save < 3; save++) {
      expect(importCanonicalCourse(wire).stages[0].administrations[0].schedule?.recurrence?.occurrenceDuration).toBeUndefined();
      expect(JSON.stringify(wire)).toContain(JSON.stringify(original));
      wire = save === 1 ? toDosageDetails(persist(toFhirR5Dosages(wire))) : r6Save(wire);
    }
  });

  it.each([false, true])("retains a disagreeing exact condition bridge as inactive source (annotation %s)", annotated => {
    const stale: FhirDosage = {};
    setDosageCondition(stale, threshold(150));
    const marker = stale.modifierExtension![0];
    if (annotated) marker.id = "condition-note";
    const source: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }] };
    setDosageCondition(source, threshold(160));
    const row = toEzDosages([source])[0];
    row.modifierExtension = [marker];
    expect(isExactConditionBridge(marker)).toBe(!annotated);
    const before = JSON.stringify(row);
    let wire = toDosageDetails([row]);
    for (let save = 0; save < 3; save++) {
      expect(importCanonicalCourse(wire).stages[0].administrations[0].predicate).toEqual(threshold(160));
      const component = wire.step![0].component[0];
      expect(component.modifierExtension?.some(item => item.url === DOSAGE_CONDITION_R5_URL) ?? false).toBe(false);
      expect(JSON.stringify(component.extension)).toContain(JSON.stringify(marker));
      wire = r6Save(wire);
    }
    expect(JSON.stringify(row)).toBe(before);
  });

  it.each(["replace", "clear", "same-r5-value"] as const)("synchronizes lifted condition mirrors for %s", edit => {
    const source: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }] };
    setDosageCondition(source, threshold(160));
    source.modifierExtension![0].id = "old-condition-bridge-note";
    const row = persist(toEzDosages([source])[0]);
    row.condition![0].id = "old-native-condition-note";
    if (edit === "same-r5-value") row.condition = [{ ...conditionToR6(threshold(150)), id: "old-native-condition-note" }];
    const expected = edit === "clear" ? undefined : threshold(edit === "same-r5-value" ? 160 : 150);
    setDosageCondition(row, expected);
    expect(getDosageCondition(row)).toEqual(expected);
    let wire = toDosageDetails([row]);
    for (let save = 0; save < 3; save++) {
      expect(importCanonicalCourse(wire).stages[0].administrations[0].predicate).toEqual(expected);
      expect(JSON.stringify(wire)).toContain("old-native-condition-note");
      expect(JSON.stringify(wire)).toContain("old-condition-bridge-note");
      wire = save === 1 ? toDosageDetails(persist(toFhirR5Dosages(wire))) : r6Save(wire);
    }
  });

  it.each([false, true])("keeps calendar predicate ownership explicit during condition edits (new day predicate %s)", explicit => {
    const old = { kind: "state" as const, name: "workday", expected: true, text: "workday" };
    const current = { kind: "state" as const, name: "weekend", expected: true, text: "weekend" };
    const source: FhirDosage = {};
    setDosageCondition(source, old, old);
    const row = persist(toEzDosages([source])[0]);
    setDosageCondition(row, current, explicit ? current : undefined);
    expect(getDosageCondition(row)).toEqual(current);
    expect(getDosageCalendarDayCondition(row)).toEqual(explicit ? current : undefined);
    setDosageCondition(row, undefined);
    expect(getDosageCondition(row)).toBeUndefined();
    expect(getDosageCalendarDayCondition(row)).toBeUndefined();
  });

  it.each(["remove", "add"] as const)("invalidates warm PRN reason replay after trigger phase %s", edit => {
    const phase: FhirExtension = { url: PRN_TRIGGER_PHASE_EXTENSION_URL, valueCode: "onset" };
    const text = edit === "remove" ? "Take 1 tablet at onset of migraine, maximum 2 tablets per dose"
      : "Take 1 tablet as needed for migraine, maximum 2 tablets per dose";
    const rows = toFhirR5Dosages([{ text, doseAndRate: [{ doseQuantity: q(1) }],
      asNeeded: true, asNeededFor: [{ text: "migraine", extension: edit === "remove" ? [phase] : [] }],
      maxDosePerAdministration: q(2) }]);
    formatSig(rows[0]);
    rows[0].asNeededFor![0].extension = edit === "remove" ? [] : [phase];
    const before = JSON.stringify(rows[0]);
    for (const row of [rows[0], persist(rows[0])]) {
      const actual = formatSig(row, "long");
      expect(dosageMatchesSavedProjection(row)).toBe(false);
      expect(canonicalFromFhir(row).prn?.reasons?.[0].triggerPhase).toBe(edit === "add" ? "onset" : undefined);
      expect(actual.toLowerCase().includes("onset")).toBe(edit === "add");
      expect(actual.toLowerCase()).toContain("migraine");
    }
    expect(JSON.stringify(rows[0])).toBe(before);
  });

  it("types and preserves the markdown primitive metadata on the R6 instruction header", () => {
    const source: FhirR6DosageInstruction = { renderedInstruction: "Take once daily",
      _renderedInstruction: { id: "authored-header", extension: [{ url: "urn:test:header", valueString: "authored metadata" }] } };
    const before = JSON.stringify(source);
    const imported = fromFhir(source);
    expect(imported.fhirNext._renderedInstruction).toEqual(source._renderedInstruction);
    expect(toDosageDetails(persist(imported.fhir))._renderedInstruction).toEqual(source._renderedInstruction);
    expect(JSON.stringify(source)).toBe(before);
  });
});

describe("round33 mixed clock carrier ownership", () => {
  const marker = (): FhirExtension => ({ url: TIMING_ADDITIONAL_CLOCK_EXTENSION_URL, id: "authored-clock-carrier",
    valueTime: "09:00:00", _valueTime: { id: "authored-clock", extension: [{ url: "urn:test:clock", valueString: "authored precision" }] },
    extension: [{ url: "urn:test:clock-envelope", valueString: "retain this note" }] });
  const input = (): FhirDosage => ({ doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: {
    frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, when: [EventTiming.Morning], extension: [marker()],
  } } });

  it("keeps primitive metadata on the current clock carrier and never revives its retired predecessor", () => {
    const row = input(), before = JSON.stringify(row);
    let wire = toDosageDetails([row]);
    const repeat = wire.step![0].component[0].timing!.repeat!;
    expect(repeat.timeOfDay).toBeUndefined();
    expect(repeat._timeOfDay).toBeUndefined();
    expect(repeat.extension).toContainEqual(marker());
    expect(JSON.stringify(row)).toBe(before);
    repeat.timeOfDay = ["10:00:00"];
    repeat._timeOfDay = [{ id: "current-clock" }];
    wire = r6Save(wire);
    const current = wire.step![0].component[0].timing!.repeat!;
    expect(current.extension?.find(item => item.url === TIMING_ADDITIONAL_CLOCK_EXTENSION_URL)?.valueTime).toBe("10:00:00");
    current.extension = current.extension?.filter(item => item.url !== TIMING_ADDITIONAL_CLOCK_EXTENSION_URL);
    for (let save = 0; save < 3; save++) {
      const rows = persist(toFhirR5Dosages(wire));
      const current = rows[0].timing!.repeat!;
      expect(current.timeOfDay?.length ?? 0).toBe(0);
      expect(current.extension?.some(item => item.url === TIMING_ADDITIONAL_CLOCK_EXTENSION_URL) ?? false).toBe(false);
      expect(importCanonicalCourse(rows).stages[0].administrations[0].schedule?.recurrence?.clocks?.length ?? 0).toBe(0);
      expect(JSON.stringify(rows)).toContain("retain this note");
      wire = toDosageDetails(rows);
    }
  });

  it.each([false, true])("keeps current explicit core clock edits authoritative (clear %s)", clear => {
    const row = input();
    row.timing!.repeat!.timeOfDay = clear ? [] : ["10:00:00"];
    row.timing!.repeat!._timeOfDay = clear ? [] : [{ id: "current-clock" }];
    let rows = persist(toFhirR5Dosages([row]));
    for (let save = 0; save < 3; save++) {
      const repeat = rows[0].timing!.repeat!;
      const active = repeat.extension?.filter(item => item.url === TIMING_ADDITIONAL_CLOCK_EXTENSION_URL) ?? [];
      expect(active.map(item => item.valueTime)).toEqual(clear ? [] : ["10:00:00"]);
      if (!clear) expect(active[0]._valueTime).toEqual({ id: "current-clock" });
      expect(importCanonicalCourse(rows).stages[0].administrations[0].schedule?.recurrence?.clocks ?? []).toEqual(clear ? [] : ["10:00:00"]);
      expect(JSON.stringify(rows)).toContain("authored-clock-carrier");
      rows = persist(toFhirR5Dosages(toDosageDetails(rows)));
    }
  });

  it.each(["R5", "R6"] as const)("preserves metadata-only clock tails through %s without inventing an occurrence", boundary => {
    const timing = { repeat: {
      frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
      when: [EventTiming.Morning], timeOfDay: ["09:00:00"],
      _timeOfDay: [null, { id: "unmeasured-clock-note", extension: [
        { url: "urn:test:clock-tail", valueString: "retain without a clock" },
      ] }],
    } };
    const source = boundary === "R5"
      ? [{ doseAndRate: [{ doseQuantity: q(1) }], timing }]
      : course({ timing });
    const before = JSON.stringify(source);
    let wire = projectCanonicalCourse(importCanonicalCourse(source)).fhirNext;
    for (let save = 0; save < 3; save++) {
      const rows = persist(toFhirR5Dosages(wire));
      for (const candidate of [wire, rows]) {
        expect(JSON.stringify(candidate)).toContain("unmeasured-clock-note");
        expect(JSON.stringify(candidate)).toContain("retain without a clock");
        expect(importCanonicalCourse(candidate).stages[0].administrations[0].schedule?.recurrence?.clocks)
          .toEqual(["09:00:00"]);
        expect(nextDueDoses(candidate, {
          orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-01T00:00:00Z",
          timeZone: "UTC", eventClock: { MORN: "08:00" }, limit: 3,
        })).toEqual(["2026-12-01T08:00:00+00:00", "2026-12-01T09:00:00+00:00", "2026-12-02T08:00:00+00:00"]);
      }
      wire = toDosageDetails(rows);
    }
    expect(JSON.stringify(source)).toBe(before);
    delete wire.step![0].component[0].timing!.repeat!.when;
    const withoutAnchor = r6Save(wire);
    expect(JSON.stringify(withoutAnchor)).toContain("unmeasured-clock-note");
    expect(withoutAnchor.step![0].component[0].timing!.repeat!.timeOfDay).toEqual(["09:00:00"]);
    expect(nextDueDoses(withoutAnchor, {
      orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-01T00:00:00Z", timeZone: "UTC", limit: 2,
    })).toEqual(["2026-12-01T09:00:00+00:00", "2026-12-02T09:00:00+00:00"]);
  });

  it("restores core clocks with their primitive metadata after the symbolic event is removed", () => {
    const row = input();
    delete row.timing!.repeat!.when;
    const repeat = toFhirR5Dosages([row])[0].timing!.repeat!;
    expect(repeat.timeOfDay).toEqual(["09:00:00"]);
    expect(repeat._timeOfDay).toEqual([marker()._valueTime]);
    expect(repeat.extension?.some(item => item.url === TIMING_ADDITIONAL_CLOCK_EXTENSION_URL) ?? false).toBe(false);
  });

  it("observes an edited bridge clock in the public display after warming the source proof", () => {
    const text = "Take 1 tablet in the morning and at 09:00";
    const rows = withDosageEditProvenance([{ ...input(), text }], text);
    formatSig(rows[0], "long");
    rows[0].timing!.repeat!.extension![0].valueTime = "10:00:00";
    expect(dosageMatchesSavedProjection(rows[0])).toBe(false);
    for (const row of [rows[0], persist(rows[0])]) {
      expect(importCanonicalCourse(row).stages[0].administrations[0].schedule?.recurrence?.clocks).toEqual(["10:00:00"]);
      const displayed = formatSig(row, "long");
      expect(displayed).toContain("10:00");
      expect(displayed).not.toContain("09:00");
    }
  });
});

// Consolidated external R5 ownership and quantity boundary cases.
describe("R5 edit ownership and quantity boundaries", () => {
  it("retains independent course and local step counts through both external boundaries", () => {
    const source = course();
    source.repeatCycle = { value: 7, unit: "d" };
    source.modifierExtension = [{ url: COURSE_CYCLE_COUNT_EXTENSION_URL, valueInteger: 3,
      id: "course-count" }, { url: "urn:test:count-note", valueString: "retain" }];
    source.step![0].count = 2;
    const native = importCanonicalCourse(source);
    expect(native.cycleCount).toBe(3);
    expect(native.stages[0].count).toBe(2);
    const strict = persist(toFhirR5Dosages(source));
    const reopened = toDosageDetails(strict);
    expect(reopened).toEqual(source);
    expect(getCourseCycleCount(reopened)).toBe(3);
    expect(importCanonicalCourse(strict).cycleCount).toBe(3);
    expect(importCanonicalCourse(strict).stages[0].count).toBe(2);
  });

  it("uses an externally edited course count without changing the local step count", () => {
    const source = course();
    source.repeatCycle = { value: 7, unit: "d" };
    source.modifierExtension = [{ url: COURSE_CYCLE_COUNT_EXTENSION_URL, valueInteger: 3 }];
    source.step![0].count = 2;
    const edit = persist(fromDosageDetails(source));
    edit.course.modifierExtension![0].valueInteger = 4;
    const changed = toDosageDetails(edit.dosages, undefined, edit.course);
    expect(getCourseCycleCount(changed)).toBe(4);
    expect(changed.step![0].count).toBe(2);
    const next = persist(fromDosageDetails(changed));
    next.course.modifierExtension = [];
    const cleared = toDosageDetails(next.dosages, undefined, next.course);
    expect(getCourseCycleCount(cleared)).toBeUndefined();
    expect(importCanonicalCourse(cleared).cycleCount).toBeUndefined();
    expect(cleared.step![0].count).toBe(2);
    expect(getCourseCycleCount(toDosageDetails(persist(toFhirR5Dosages(cleared)))))
      .toBeUndefined();
  });

  it("distinguishes an omitted step list from removal of a fieldless empty stage", () => {
    const wire = toDosageDetails([{ sequence: 2, doseAndRate: [{ doseQuantity: q(1) }] }],
      undefined, { step: [{ sequence: 1 }] });
    const edit = persist(fromDosageDetails(wire));
    expect(edit.course.step).toContainEqual({ sequence: 1 });
    const omitted = { ...edit.course };
    delete omitted.step;
    expect(importCanonicalCourse(toDosageDetails(edit.dosages, undefined, omitted)).stages)
      .toHaveLength(2);
    edit.course.step = [];
    const removed = toDosageDetails(edit.dosages, undefined, edit.course);
    for (const current of [removed, toDosageDetails(persist(toFhirR5Dosages(removed)))]) {
      const stages = importCanonicalCourse(current).stages;
      expect(stages).toHaveLength(1);
      expect(stages[0].administrations).toHaveLength(1);
      expect(stages[0].administrations[0].amounts![0]).toMatchObject({ quantity: { value: 1, unit: "tab" } });
    }
  });

  it("removes the final metadata-only carrier stage without losing its raw annotations", () => {
    const wire = toDosageDetails([], undefined, { step: [{ sequence: 1, id: "draft",
      extension: [{ url: "urn:test:draft-source", valueString: "keep original" }] }] });
    const edit = persist(fromDosageDetails(wire));
    edit.course.step = [];
    const removed = toDosageDetails(edit.dosages, undefined, edit.course);
    expect(removed.step).toBeUndefined();
    expect(importCanonicalCourse(removed).stages).toEqual([]);
    const annotation = { url: "urn:test:draft-source", valueString: "keep original" };
    expect(JSON.stringify(removed.extension)).toContain(JSON.stringify(annotation));
    const saved = persist(fromDosageDetails(removed));
    const reopened = toDosageDetails(saved.dosages, undefined, saved.course);
    expect(importCanonicalCourse(reopened).stages).toEqual([]);
    expect(JSON.stringify(reopened.extension)).toContain(JSON.stringify(annotation));
  });

  it.each([false, true])("applies edited R5 maxima when unchanged lifted safety remains (metadata %s)", rich => {
    const safety = {
      doseLimit: [
        { scope: "administration" as const, valueQuantity: q(4),
          ...(rich ? { id: "numeric-limit", extension: [{ url: "urn:test:limit", valueString: "keep" }] } : {}) },
        ...(rich ? [{ scope: "dosage" as const, valueInteger: 3, text: "three administrations" }] : []),
      ],
      ...(rich ? { ifExceeded: "call" } : {}),
    };
    const edit = persist(fromDosageDetails(course({ safety })));
    edit.dosages[0].maxDosePerAdministration!.value = 2;
    const actual = toDosageDetails(edit.dosages, undefined, edit.course).step![0].component[0].safety!;
    expect(actual.doseLimit).toEqual([
      { ...safety.doseLimit[0], valueQuantity: q(2) }, ...safety.doseLimit.slice(1),
    ]);
    if (rich) {
      expect(actual.doseLimit).toContainEqual(safety.doseLimit[1]);
      expect(actual.ifExceeded).toEqual(safety.ifExceeded);
      expect(actual.doseLimit![0]).toMatchObject({ id: "numeric-limit",
        extension: [{ url: "urn:test:limit", valueString: "keep" }] });
    }
  });

  it.each(["lifetime", "period"] as const)("reconciles the changed %s maximum without reviving the lifted copy", scope => {
    const source = course({ safety: { doseLimit: [{
      scope, valueQuantity: q(4), ...(scope === "period" ? { period: { value: 1, unit: "d", code: "d" } } : {}),
    }] } });
    const edit = persist(fromDosageDetails(source));
    if (scope === "period") edit.dosages[0].maxDosePerPeriod![0].numerator!.value = 2;
    else edit.dosages[0].maxDosePerLifetime!.value = 2;
    const output = toDosageDetails(edit.dosages, undefined, edit.course);
    expect(output.step![0].component[0].safety!.doseLimit).toEqual([{
      scope, valueQuantity: q(2), ...(scope === "period" ? { period: { value: 1, unit: "d", code: "d" } } : {}),
    }]);
  });

  it("keeps an explicitly edited lifted safety value authoritative", () => {
    const edit = persist(fromDosageDetails(course({
      safety: { doseLimit: [{ scope: "administration", valueQuantity: q(4) }] },
    })));
    edit.dosages[0].maxDosePerAdministration!.value = 2;
    edit.dosages[0].safety!.doseLimit![0].valueQuantity!.value = 3;
    const actual = toDosageDetails(edit.dosages, undefined, edit.course).step![0].component[0];
    expect(actual.safety!.doseLimit![0].valueQuantity!.value).toBe(3);
  });

  it("removes a deleted R5 maximum and preserves unrelated R6-only safety", () => {
    const edit = persist(fromDosageDetails(course({
      safety: { ifExceeded: "call", doseLimit: [
        { scope: "administration", valueQuantity: q(4) },
        { scope: "dosage", valueInteger: 3 },
      ] },
    })));
    delete edit.dosages[0].maxDosePerAdministration;
    const actual = toDosageDetails(edit.dosages, undefined, edit.course).step![0].component[0].safety!;
    expect(actual.doseLimit).toEqual([{ scope: "dosage", valueInteger: 3 }]);
    expect(actual.ifExceeded).toEqual("call");
  });

  const legacyExpressionRow = (): EzDosage => ({
    sequence: 1,
    doseAndRate: [{ type: { text: "calculated" } }],
    modifierExtension: [{
      url: "urn:ezmedicationinput:StructureDefinition:medication-r6-course-details",
      extension: [{ url: "dosageDetails", extension: [{ url: "step", extension: [{
        url: "component", extension: [{ url: "doseAndRate", extension: [
          { url: "type", valueCodeableConcept: { text: "calculated" } },
          { url: "doseExpression", valueExpression: { language: "text/fhirpath", expression: "%oldDose" } },
          { url: "rateExpression", valueExpression: { language: "text/fhirpath", expression: "%oldRate" } },
        ] }],
      }] }] }],
    }],
  });
  it.each(["doseExpression", "rateExpression"] as const)(
    "honors a live %s edit under the full retained-course bridge", field => {
      const row = legacyExpressionRow();
      row.doseAndRate![0][field] = { language: "text/fhirpath", expression: "%edited" };
      const actual = toDosageDetails([row]).step![0].component[0].doseAndRate![0];
      expect(actual[field]!.expression).toBe("%edited");
      const untouched = field === "doseExpression" ? "rateExpression" : "doseExpression";
      expect(actual[untouched]!.expression).toBe(field === "doseExpression" ? "%oldRate" : "%oldDose");
    }
  );
  it("restores absent strict-R5 expressions while respecting an explicit editable clear", () => {
    const strict = legacyExpressionRow();
    expect(toDosageDetails([strict]).step![0].component[0].doseAndRate![0]).toMatchObject({
      doseExpression: { expression: "%oldDose" }, rateExpression: { expression: "%oldRate" },
    });
    strict.doseAndRate![0].doseExpression = undefined;
    const cleared = toDosageDetails([strict]).step![0].component[0].doseAndRate![0];
    expect(cleared.doseExpression).toBeUndefined();
    expect(cleared.rateExpression!.expression).toBe("%oldRate");
  });
  it("honors explicit expression clearing under the compact bridge", () => {
    const edit = fromDosageDetails({ step: [{ component: [{
      doseAndRate: [{ doseExpression: { expression: "%dose" }, rateExpression: { expression: "%rate" } }],
    }] }] });
    edit.dosages[0].doseAndRate![0].doseExpression = undefined;
    const actual = toDosageDetails(edit.dosages, undefined, edit.course).step![0].component[0].doseAndRate![0];
    expect(actual.doseExpression).toBeUndefined();
    expect(actual.rateExpression!.expression).toBe("%rate");
  });

  it("keeps a persist deletion of an editable expression distinct from a strict R5 omission", () => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseExpression: { expression: "%dose" }, rateExpression: { expression: "%rate" } }],
    }] }] };
    const edit = persist(fromDosageDetails(source));
    delete edit.dosages[0].doseAndRate![0].doseExpression;
    const reopened = toDosageDetails(persist(edit.dosages), undefined, edit.course);
    expect(reopened.step![0].component[0].doseAndRate![0].doseExpression).toBeUndefined();
    expect(reopened.step![0].component[0].doseAndRate![0].rateExpression!.expression).toBe("%rate");
    const strict = toDosageDetails(persist(toFhirR5Dosages(source)));
    expect(strict.step![0].component[0].doseAndRate![0].doseExpression!.expression).toBe("%dose");
  });

  it("does not combine stale row text with a current text-only edit", () => {
    const edit = persist(fromDosageDetails({
      renderedInstruction: "Two administration times were prescribed",
      step: [{ component: [
        { text: "Take one in morning", doseAndRate: [{ doseQuantity: q(1) }] },
        { text: "Take one in evening", doseAndRate: [{ doseQuantity: q(1) }] },
      ] }],
    }));
    edit.dosages[0].doseAndRate![0].doseQuantity!.value = 2;
    edit.dosages[1].text = "Take one at bedtime";
    const actual = toDosageDetails(edit.dosages, undefined, edit.course);
    expect(actual.renderedInstruction).toBeUndefined();
    expect(actual.step![0].component[0].doseAndRate![0].doseQuantity!.value).toBe(2);
    expect(actual.step![0].component[0].text).toBeUndefined();
    expect(actual.step![0].component[1].text).toBe("Take one at bedtime");
    const retiredRows: ReturnType<typeof decodeR5RetainedFields>[] = [];
    for (const item of actual.extension ?? []) if (item.url === DOSAGE_RECONCILIATION_SOURCE_URL)
      for (const source of item.extension ?? []) if (source.url === DOSAGE_DETAILS_R5_URL)
        retiredRows.push(decodeR5RetainedFields(source));
    expect(retiredRows).toContainEqual({ rowIndex: 0, sequence: 1, component: { text: "Take one in morning" } });
  });
  it("honors whole-course text-only edits while all row text remains current", () => {
    const edit = persist(fromDosageDetails({
      renderedInstruction: "Original wording",
      step: [{ component: [
        { text: "Take one morning", doseAndRate: [{ doseQuantity: q(1) }] },
        { text: "Take one evening", doseAndRate: [{ doseQuantity: q(1) }] },
      ] }],
    }));
    edit.dosages[1].text = "Take one bedtime";
    expect(toDosageDetails(edit.dosages, undefined, edit.course).renderedInstruction)
      .toBe("Take one morning; Take one bedtime");
  });

  it("retires an old marker after the final retained timing offset is cleared", () => {
    const rows = toFhirR5Dosages(course({ timing: { repeat: {
      frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day, startOffset: { value: 8, unit: "h", code: "h" },
    } } }));
    const changed = persist(rows);
    // Changing the live period retires offsets tied to its old window.
    changed[0].timing!.repeat!.period = 2;
    const output = toFhirR5Dosages(changed);
    expect(toDosageDetails(output).step![0].component[0].timing!.repeat!.startOffset).toBeUndefined();
    // Returning to the earlier cadence later must not revive a retired marker.
    output[0].timing!.repeat!.period = 1;
    const next = toDosageDetails(persist(output)).step![0].component[0];
    expect(next.timing!.repeat!.period).toBe(1);
    expect(next.timing!.repeat!.startOffset).toBeUndefined();
    expect(toDosageDetails(rows).step![0].component[0].timing!.repeat!.startOffset).toMatchObject({ value: 8 });
  });

  it.each([false, true])("retains a high-only approximate course length (anchored %s)", anchored => {
    const high = simpleQuantityForR5({ value: 7, code: "d", unit: "days", comparator: "~" })!;
    const row: FhirDosage = {
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        ...(anchored ? { boundsPeriod: { start: "2026-11-20" } } : { boundsRange: { high } }),
      } },
      ...(anchored ? { modifierExtension: [{ url: ANCHORED_COURSE_DURATION_EXTENSION_URL, valueRange: { high } }] } : {}),
    };
    const output = canonicalToFhir(canonicalFromFhir(row));
    const bound = anchored
      ? output.modifierExtension!.find(value => value.url === ANCHORED_COURSE_DURATION_EXTENSION_URL)!.valueRange!
      : output.timing!.repeat!.boundsRange!;
    expect(bound.low).toBeUndefined();
    expect(bound.high!.value).toBe(7);
    expect(getQuantityComparator(bound.high)).toBe("~");
    expect(output.timing!.repeat!.frequency).toBe(1);
    if (anchored) expect(output.timing!.repeat!.boundsPeriod!.start).toBe("2026-11-20");
  });

  it("keeps both equal-valued course bounds when only the lower endpoint is qualified", () => {
    const row: FhirDosage = { timing: { repeat: { boundsRange: {
      low: simpleQuantityForR5({ value: 7, unit: "days", code: "d", comparator: "~" }),
      high: { value: 7, unit: "days", code: "d" },
    } } } };
    const bound = canonicalToFhir(canonicalFromFhir(row)).timing!.repeat!.boundsRange!;
    expect(bound.low!.value).toBe(7);
    expect(getQuantityComparator(bound.low)).toBe("~");
    expect(bound.high!.value).toBe(7);
    expect(getQuantityComparator(bound.high)).toBeUndefined();
  });

  it.each(["<", "<=", ">", ">=", "~"] as const)("does not create edit history for an unchanged scalar %s roundtrip", comparator => {
    const source = course({ doseAndRate: [{ doseQuantity: simpleQuantityForR5({ value: 5, unit: "mg", comparator }) }] });
    const reopened = toDosageDetails(persist(toFhirR5Dosages(source)));
    expect(getQuantityComparator(reopened.step![0].component[0].doseAndRate![0].doseQuantity)).toBe(comparator);
    expect(reopened).toEqual(source);
    expect(reopened.extension).toBeUndefined();
    expect(reopened.step![0].component[0].doseAndRate![0].doseQuantity).not.toHaveProperty("comparator");
  });

  it("shows qualified R5 range endpoints in the clinician preview", () => {
    const row: FhirDosage = { doseAndRate: [{ doseRange: {
      low: simpleQuantityForR5({ value: 500, unit: "mg", comparator: "~" }),
      high: { value: 1000, unit: "mg" },
    } }] };
    const text = formatSig(row, "long", { locale: "en", realizationMode: "normalized" });
    expect(text).toMatch(/(?:about|approximately|~)\s*500/i);
    expect(text).toContain("1000");
    expect(text).toContain("mg");
  });

  it("does not generate a redundant R5 comparator fallback beside unrelated metadata", () => {
    const extension: FhirExtension = { url: "urn:test:note", valueString: "keep" };
    const projected = quantityForR5({ value: 7, unit: "d", comparator: "<", extension: [extension] })!;
    expect(projected).toEqual({ value: 7, unit: "d", comparator: "<", extension: [extension] });
    delete projected.comparator;
    expect(quantityFromR5(projected)!.comparator).toBeUndefined();
  });
  it("keeps a native operator active and its enriched previous EMA annotation inert", () => {
    const authored = { url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL, id: "operator", valueCoding: {
      system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000055", display: "approximately equal to",
    } };
    const note = { url: "urn:test:note", valueString: "keep" };
    const projected = quantityForR5({ value: 7, comparator: "<=", extension: [authored, note] })!;
    expect(projected.comparator).toBe("<=");
    expect(projected.extension).toEqual([
      { url: "urn:ezmedicationinput:StructureDefinition:quantity-operator-source", extension: [authored] }, note,
    ]);
    delete projected.comparator;
    expect(getQuantityComparator(projected)).toBeUndefined();
  });
});

describe("round34 interchange current clinical ownership", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] };
  const options = { from: "2026-11-21T00:00:00Z", orderedAt: "2026-11-21T00:00:00Z", timeZone: "UTC", limit: 10 };
  const boundary = (days: number) => ({ contextCode: { coding: [{
    system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start",
  }] }, offsetDuration: { value: days, unit: "d" } });

  it("retires the saved missing-predecessor reason when its real first phase is restored", () => {
    const input: FhirR6DosageInstruction = { step: [
      { component: [{ doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: { ...daily, count: 3 } } }] },
      { start: { contextCode: { coding: [{ system: "urn:ezmedicationinput:CodeSystem:course-phase-event", code: "previous-phase-next-day" }] } },
        component: [{ doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: { ...daily, count: 1 } } }] },
    ] };
    const original = persist(toFhirR5Dosages(input));
    const incomplete = persist(toFhirR5Dosages(toDosageDetails(original.slice(1))));
    expect(() => nextDueDoses(incomplete, options)).toThrow(/complete dosage array/i);
    let restored = [original[0], ...incomplete];
    for (let save = 0; save < 3; save++) {
      expect(nextDueDoses(restored, options).map(value => new Date(value).toISOString())).toEqual([
        "2026-11-21T08:00:00.000Z", "2026-11-22T08:00:00.000Z",
        "2026-11-23T08:00:00.000Z", "2026-11-24T08:00:00.000Z",
      ]);
      expect(calculateTotalUnits({ ...options, dosage: restored, durationValue: 7, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(5);
      expect(importCanonicalCourse(restored).stages[1].administrations[0].missingContexts).toBeUndefined();
      restored = persist(toFhirR5Dosages(toDosageDetails(restored)));
    }
    expect(JSON.stringify(toDosageDetails(restored).extension)).toContain("predecessor");
  });

  it.each([false, true])("keeps mixed saved R5 count meanings unresolved in either row order (%s)", reverse => {
    // Actual former writer's first-stage course count shape, combined with a
    // current explicitly step-scoped row from the same persisted course.
    const marker: FhirExtension = { url: DOSAGE_DETAILS_R5_URL, extension: [
      { url: "rowIndex", valueInteger: 0 }, { url: "sequence", valueInteger: 1 }, { url: "stepCount", valueInteger: 1 },
      { url: "step", extension: [{ url: "count", valueInteger: 3 }] },
      { url: "context", valueString: "72f2f03d1f8289c5" }, { url: "contextRequired", valueBoolean: true },
      { url: "course", extension: [{ url: "repeatCycle", valueQuantity: { value: 14, unit: "d", code: "d", system: "http://unitsofmeasure.org" } }] },
    ] };
    const old: FhirDosage = { sequence: 1, doseAndRate: [{ doseQuantity: q(1) }],
      timing: { repeat: { ...daily, boundsDuration: { value: 7, unit: "d", code: "d" } } }, modifierExtension: [marker] };
    const current = persist(old);
    current.modifierExtension![0].extension![0].valueInteger = 1;
    current.modifierExtension![0].extension!.push({ url: "countScope", valueCode: "step" });
    let rows = reverse ? [current, old] : [old, current];
    for (let save = 0; save < 3; save++) {
      expect(() => nextDueDoses(rows, { ...options, limit: 50 })).toThrow(/conflicting|complete dosage array|resolve/i);
      expect(() => calculateTotalUnits({ ...options, dosage: rows, durationValue: 42, durationUnit: FhirPeriodUnit.Day }))
        .toThrow(/conflicting|complete dosage array|resolve/i);
      rows = persist(toFhirR5Dosages(toDosageDetails(rows)));
    }
    const resolved = toDosageDetails(rows, undefined, { step: [{ sequence: 1, count: 1 }],
      modifierExtension: [{ url: COURSE_CYCLE_COUNT_EXTENSION_URL, valueInteger: 3 }] }, { resolvedPhaseSequences: [1] });
    const actual = nextDueDoses(resolved, { ...options, limit: 100 });
    expect(actual).toHaveLength(42); // two members, three seven-day active blocks
    expect(new Set(actual).size).toBe(21);
    expect(new Date(actual[41]).toISOString()).toBe("2026-12-25T08:00:00.000Z");
    expect(calculateTotalUnits({ ...options, dosage: resolved, durationValue: 42, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(42);
    expect(JSON.stringify(resolved.extension)).toContain("72f2f03d1f8289c5");
  });

  it("does not move an unidentified phase policy with its member into a new identified phase", () => {
    let wire = toDosageDetails([{ id: "original-member", doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } }],
      undefined, { step: [{ sequence: 1, safety: {
        doseLimit: [{ scope: "administration", valueQuantity: q(2) }], ifExceeded: "Review the original phase",
      } }] });
    wire.step = [{ id: "replacement-phase", component: wire.step![0].component }];
    for (let save = 0; save < 3; save++) {
      const native = importCanonicalCourse(wire);
      expect(native.safety).toBeUndefined();
      expect(native.stages[0].safety).toBeUndefined();
      expect(JSON.stringify(r6Save(wire).extension)).toContain("Review the original phase");
      wire = save === 1 ? toDosageDetails(persist(toFhirR5Dosages(wire))) : r6Save(wire);
    }
  });

  it.each(["replace", "clear", "stale-mirror"] as const)("synchronizes the lifted date owner on setter %s", edit => {
    const row: EzDosage = { doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } };
    setDosageExcludedDates(row, ["2026-11-22"]);
    row.excludedDates = ["2026-11-22"];
    if (edit === "stale-mirror") row.excludedDates = ["2026-11-23"];
    const dates = edit === "clear" ? [] : edit === "replace" ? ["2026-11-23"] : ["2026-11-22"];
    setDosageExcludedDates(row, dates);
    expect(getDosageExcludedDates(row)).toEqual(dates);
    const expected = ["2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24"].filter(day => dates.indexOf(day) < 0);
    expect(nextDueDoses(row, { ...options, limit: expected.length }).map(value => value.slice(0, 10))).toEqual(expected);
    const wire = toDosageDetails([row]);
    expect(getDosageExcludedDates({ modifierExtension: wire.step![0].component[0].modifierExtension })).toEqual(dates);
  });

  it.each(["value", "period", "scope", "action", "expression"] as const)("invalidates a warmed lifted safety preview after a live %s edit", edit => {
    const row: EzDosage = { text: "Take one tablet daily; maximum four tablets per dose.",
      doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily },
      safety: { doseLimit: [{ scope: "administration", valueQuantity: q(4) }] } };
    if (edit === "period") row.safety!.doseLimit![0] = { scope: "period", valueQuantity: q(4), period: { value: 1, unit: "d" } };
    if (edit === "expression") row.safety!.doseLimit![0] = { scope: "administration", valueExpression: expression("originalLimit") };
    const saved = persist(withDosageEditProvenance([row], row.text)[0]);
    expect(dosageMatchesSavedProjection(saved)).toBe(true);
    expect(formatSig(saved, "long", { locale: "en", realizationMode: "roundtrip" })).toBe(row.text);
    if (edit === "value") saved.safety!.doseLimit![0].valueQuantity!.value = 2;
    else if (edit === "period") saved.safety!.doseLimit![0].period!.value = 2;
    else if (edit === "scope") saved.safety!.doseLimit![0].scope = "lifetime";
    else if (edit === "action") saved.safety!.ifExceeded = "Contact the clinician";
    else saved.safety!.doseLimit![0].valueExpression!.expression = "%currentLimit";
    expect(dosageMatchesSavedProjection(saved)).toBe(false);
    const warm = formatSig(saved, "long", { locale: "en", realizationMode: "roundtrip" });
    expect(warm).toBe(formatSig(persist(saved), "long", { locale: "en", realizationMode: "roundtrip" }));
    expect(warm).not.toBe(row.text);
    if (edit === "value") expect(warm).toContain("2 tab");
    if (edit === "action") expect(warm).toContain("Contact the clinician");
  });

  it("keeps a primitive-metadata-only R6 header as a header without inventing a dosage", () => {
    const input = { _renderedInstruction: { id: "instruction-annotation", extension: [
      { url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown" },
    ] } };
    let current: FhirR6DosageInstructionInput = input;
    for (let save = 0; save < 3; save++) {
      const native = importCanonicalCourse(current);
      expect(native.stages).toEqual([]);
      const output = projectCanonicalCourse(native).fhirNext;
      expect(output._renderedInstruction).toEqual(input._renderedInstruction);
      expect(output.step).toBeUndefined();
      current = save === 1 ? toDosageDetails(persist(toFhirR5Dosages(output))) : persist(output);
    }
  });

  it.each(["unchanged", "replace", "clear"] as const)("preserves rate wrapper annotations while current modifier %s owns the value", edit => {
    const original = { url: "urn:test:rate-policy", valueString: "Original clinical rate policy" };
    const replacement = { url: "urn:test:rate-policy", valueString: "Replacement clinical rate policy" };
    const wrapper = { id: "authored-rate-wrapper", url: R5_RATE_MODIFIERS_R6_URL, extension: [original] };
    const input = course({ doseAndRate: [{ doseQuantity: q(1), extension: [wrapper, { url: "urn:test:rate-note", valueString: "Keep rate note" }] }] });
    let rows = persist(toFhirR5Dosages(input));
    if (edit !== "unchanged") rows[0].doseAndRate![0].modifierExtension = edit === "replace" ? [replacement] : [];
    for (let save = 0; save < 3; save++) {
      const output = toDosageDetails(rows);
      const rate = output.step![0].component[0].doseAndRate![0];
      const active = rate.extension?.find(marker => marker.url === R5_RATE_MODIFIERS_R6_URL);
      if (edit === "clear") {
        expect(active).toBeUndefined();
        expect(JSON.stringify(rate.extension)).toContain("authored-rate-wrapper");
      } else expect(active).toEqual({ ...wrapper, extension: [edit === "replace" ? replacement : original] });
      expect(rate.extension).toContainEqual({ url: "urn:test:rate-note", valueString: "Keep rate note" });
      rows = persist(toFhirR5Dosages(output));
    }
  });

  it("retains a displaced authored course count without rewriting it to the first value", () => {
    const first = { id: "authoritative-count", url: COURSE_CYCLE_COUNT_EXTENSION_URL, valueInteger: 2 };
    const second = { id: "displaced-count", url: COURSE_CYCLE_COUNT_EXTENSION_URL, valueInteger: 3,
      extension: [{ url: "urn:test:count-note", valueString: "Second authored cycle count" }] };
    const unknown = { url: COURSE_CYCLE_COUNT_EXTENSION_URL, valueString: "unresolved authored value" };
    let current: FhirR6DosageInstruction = { ...course({ timing: { repeat: { ...daily, count: 1 } } }),
      repeatCycle: { value: 7, unit: "d" }, modifierExtension: [first, second, unknown] };
    for (let save = 0; save < 3; save++) {
      const output = r6Save(current);
      expect(output.modifierExtension).toEqual([first, unknown]);
      expect(output.extension).toContainEqual({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [second] });
      expect(nextDueDoses(output, options).map(value => value.slice(0, 10))).toEqual(["2026-11-21", "2026-11-28"]);
      current = save === 1 ? toDosageDetails(persist(toFhirR5Dosages(output))) : output;
    }
  });

  it("retains independent phase start and end with their authored wrapper annotations", () => {
    const start = { ...boundary(2), id: "component-start" }, end = { ...boundary(35), id: "component-cutoff" };
    const marker = encodeR6SourceMetadata(PARALLEL_COMPONENT_PHASE_ORIGIN_URL, { start, end }, "step");
    marker.id = "phase-window";
    marker.extension!.push({ url: "urn:test:phase-note", valueString: "Independent member interval" });
    let current = course({ modifierExtension: [marker], timing: { repeat: daily } });
    for (let save = 0; save < 3; save++) {
      const member = importCanonicalCourse(current).stages[0].administrations[0];
      expect(member.phaseStart?.displacement?.value).toBe(2);
      expect(member.phaseEnd?.displacement?.value).toBe(35);
      current = save === 1 ? toDosageDetails(persist(toFhirR5Dosages(current))) : r6Save(current);
      expect(current.step![0].component[0].modifierExtension).toContainEqual(marker);
    }
  });
});


describe("round35 interchange field ownership", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day };
  const ucum = "http://unitsofmeasure.org";

  it.each(["~", "<", ">="] as const)("preserves the decoded %s denominator beside an approximate rate numerator", comparator => {
    const source = course({ doseAndRate: [{ rateRatio: {
      numerator: { value: 5, unit: "mL", comparator: "~" },
      denominator: simpleQuantityForR5({ value: 1, unit: "h", comparator }),
    } }] });
    let rows = persist(toFhirR5Dosages(source));
    for (let save = 0; save < 3; save++) {
      const amount = importCanonicalCourse(rows).stages[0].administrations[0].amounts![0];
      expect(amount.rateRatio?.numerator).toMatchObject({ value: 5, comparator: "~" });
      expect(amount.rateRatio?.denominator).toMatchObject({ value: 1, comparator });
      rows = persist(toFhirR5Dosages(toDosageDetails(rows)));
    }
    rows[0].doseAndRate![0].rateRatio!.denominator = simpleQuantityForR5({ value: 2, unit: "h", comparator: "<=" })!;
    expect(importCanonicalCourse(rows).stages[0].administrations[0].amounts![0].rateRatio?.denominator)
      .toMatchObject({ value: 2, comparator: "<=" });
  });

  it("keeps a lifted anonymous phase maximum after a live dose amount edit", () => {
    let wire = r6Save({ step: [{ safety: { doseLimit: [{ scope: "administration", valueQuantity: q(3), text: "Phase maximum" }] },
      component: [{ doseAndRate: [{ doseQuantity: q(1) }] }] }] });
    wire.step![0].component[0].doseAndRate![0].doseQuantity!.value = 2;
    const source = JSON.stringify(wire);
    for (let save = 0; save < 3; save++) {
      const native = importCanonicalCourse(wire);
      expect(native.safety).toBeUndefined();
      expect(native.stages[0].safety?.limits?.[0]).toMatchObject({ amount: { value: 3 }, text: "Phase maximum" });
      expect(native.stages[0].administrations[0].amounts![0].quantity?.value).toBe(2);
      if (!save) expect(JSON.stringify(wire)).toBe(source);
      wire = save === 1 ? toDosageDetails(persist(toFhirR5Dosages(wire))) : r6Save(wire);
    }
  });

  it.each(["replace", "duplicate"] as const)("does not attach a lifted anonymous phase maximum to a %s owner", edit => {
    const wire = r6Save({ step: [{ safety: { doseLimit: [{ scope: "administration", valueQuantity: q(3), text: "Old phase limit" }] },
      component: [{ doseAndRate: [{ doseQuantity: q(1) }] }] }] });
    if (edit === "replace") wire.step = [{ component: [{ doseAndRate: [{ doseQuantity: q(2) }] }] }];
    else wire.step!.push(persist(wire.step![0]));
    const native = importCanonicalCourse(wire);
    expect(native.safety).toBeUndefined();
    for (const stage of native.stages) expect(stage.safety).toBeUndefined();
    expect(JSON.stringify(r6Save(wire).extension)).toContain("Old phase limit");
  });

  it.each(["date", "day"] as const)("clears every duplicate %s restriction while retaining source annotations", kind => {
    const url = kind === "date" ? DOSAGE_EXCLUDED_DATES_R5_URL : DOSAGE_EXCLUDED_WEEKDAYS_R5_URL;
    const markers: FhirExtension[] = [0, 1].map(index => ({ id: "calendar-" + index, url,
      extension: [{ id: "value-" + index, url: kind,
        ...(kind === "date" ? { valueDate: "2026-11-2" + (2 + index) } : { valueCode: index ? "tue" : "mon" }) }] }));
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }],
      ...(kind === "date" ? { modifierExtension: markers } : { extension: markers }) };
    if (kind === "date") setDosageExcludedDates(row, []);
    else setDosageExcludedWeekdays(row, []);
    expect((kind === "date" ? row.modifierExtension : row.extension)?.some(item => item.url === url)).toBeFalsy();
    if (kind === "date") expect(getDosageExcludedDates(row)).toEqual([]);
    const retained: FhirExtension[] = [];
    for (const item of row.extension!) if (item.url === DOSAGE_RECONCILIATION_SOURCE_URL) retained.push(...(item.extension ?? []));
    expect(retained).toEqual(expect.arrayContaining(markers));
    const wire = toDosageDetails(persist([row]));
    for (const marker of markers) expect(JSON.stringify(wire)).toContain(marker.id);
  });

  it("reconciles duplicate calendar sources without replacing an unchanged primary wrapper", () => {
    const first: FhirExtension = { id: "primary", url: DOSAGE_EXCLUDED_DATES_R5_URL,
      extension: [{ url: "date", valueDate: "2026-11-22" }] };
    const second: FhirExtension = { id: "duplicate", url: DOSAGE_EXCLUDED_DATES_R5_URL,
      extension: [{ url: "date", valueDate: "2026-11-23" }] };
    const row: FhirDosage = { modifierExtension: [first, second] };
    setDosageExcludedDates(row, ["2026-11-22"]);
    expect(row.modifierExtension).toEqual([first]);
    expect(row.modifierExtension![0]).toBe(first);
    expect(row.extension).toContainEqual({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [second] });
  });

  it.each(["period", "unit"] as const)("keeps distinct ID-less %s limit text after both amounts are edited", identity => {
    const limits = [
      { scope: "period" as const, valueQuantity: q(4), period: { value: 1, unit: "d" }, text: "Daily ceiling" },
      { scope: "period" as const, valueQuantity: { value: 12, unit: identity === "unit" ? "mL" : "tab" },
        period: { value: identity === "period" ? 7 : 1, unit: "d" }, text: "Independent ceiling" },
    ];
    const rows = persist(toFhirR5Dosages(course({ safety: { doseLimit: limits } })));
    rows[0].maxDosePerPeriod![0].numerator!.value = 3;
    rows[0].maxDosePerPeriod![1].numerator!.value = 10;
    rows[0].maxDosePerPeriod!.reverse();
    let wire = toDosageDetails(rows);
    const expected = [{ ...limits[1], valueQuantity: { ...limits[1].valueQuantity, value: 10 } }, { ...limits[0], valueQuantity: q(3) }];
    for (let save = 0; save < 3; save++) {
      expect(wire.step![0].component[0].safety!.doseLimit).toEqual(expected);
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
    }
  });

  it("keeps ambiguous old period-limit text inactive and recoverable", () => {
    const limits = [
      { scope: "period" as const, valueQuantity: q(4), period: { value: 1, unit: "d" }, text: "First old ceiling" },
      { scope: "period" as const, valueQuantity: q(5), period: { value: 1, unit: "d" }, text: "Second old ceiling" },
    ];
    const rows = persist(toFhirR5Dosages(course({ safety: { doseLimit: limits } })));
    rows[0].maxDosePerPeriod![0].numerator!.value = 2;
    rows[0].maxDosePerPeriod![1].numerator!.value = 3;
    let wire = toDosageDetails(rows);
    for (let save = 0; save < 3; save++) {
      expect(wire.step![0].component[0].safety!.doseLimit!.map(limit => limit.text)).toEqual([undefined, undefined]);
      expect(wire.step![0].component[0].safety!.doseLimit!.map(limit => limit.valueQuantity!.value)).toEqual([2, 3]);
      const retained = JSON.stringify(wire.extension);
      expect(retained).toContain("First old ceiling");
      expect(retained).toContain("Second old ceiling");
      expect(wire.step![0].component[0].safety!.extension).toBeUndefined();
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
    }
  });

  it("clears active safety while retaining the removed final limit in inactive source", () => {
    const original = course({ safety: { doseLimit: [{ scope: "administration", valueQuantity: q(3),
      text: "Authored maximum removed by clinician" }] } });
    const rows = persist(fromDosageDetails(original).dosages);
    delete rows[0].maxDosePerAdministration;
    let wire = toDosageDetails(rows);
    for (let save = 0; save < 3; save++) {
      expect(wire.step![0].component[0].safety).toBeUndefined();
      const member = importCanonicalCourse(wire).stages[0].administrations[0];
      expect(member.safety).toBeUndefined();
      expect(member.limits).toBeUndefined();
      expect(JSON.stringify(wire.extension)).toContain("Authored maximum removed by clinician");
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
    }
  });

  it.each([["h", 48, "d", 3], ["mo", 1, "wk", 6]] as const)(
    "keeps the prescriber's active range (%s, %s, %s, %s) in R5 and R6", (lowUnit, lowValue, highUnit, highValue) => {
      const range = { id: "authored-duration", low: { value: lowValue, unit: lowUnit, code: lowUnit, system: ucum, _unit: { id: "low-label" } },
        high: { value: highValue, unit: highUnit, code: highUnit, system: ucum } };
      let wire = course({ timing: { repeat: { ...daily, boundsRange: range } } });
      for (let save = 0; save < 3; save++) {
        const projected = projectCanonicalCourse(importCanonicalCourse(wire));
        expect(projected.fhir[0].timing!.repeat!.boundsRange).toEqual(range);
        expect(projected.fhirNext.step![0].component[0].timing!.repeat!.boundsRange).toEqual(range);
        wire = toDosageDetails(persist(projected.fhir));
      }
    });

  it("recovers authored duration endpoints and keeps the retired projection marker annotations", () => {
    const low = { value: 48, unit: "hours", code: "h", system: ucum, _unit: { id: "hour-label" } };
    const high = { value: 3, unit: "days", code: "d", system: ucum };
    const projected = { low: { value: 2, unit: "days", code: "d", system: ucum }, high };
    const marker: FhirExtension = { id: "duration-source-id", url: ANCHORED_COURSE_DURATION_EXTENSION_URL,
      extension: [{ url: "low", valueQuantity: low }, { url: "high", valueQuantity: high },
        retainField("projectedRange", projected), { url: "urn:test:duration-note", valueString: "Duration annotation" }] };
    let wire = course({ timing: { repeat: { boundsRange: projected } }, modifierExtension: [marker] });
    for (let save = 0; save < 3; save++) {
      wire = r6Save(wire);
      const row = wire.step![0].component[0];
      expect(row.timing!.repeat!.boundsRange).toEqual({ low, high });
      expect(row.modifierExtension?.some(value => value.url === ANCHORED_COURSE_DURATION_EXTENSION_URL)).toBeFalsy();
      expect(JSON.stringify(row.extension)).toContain("duration-source-id");
      expect(JSON.stringify(row.extension)).toContain("Duration annotation");
    }
  });

  it("restores metadata-only comparator primitives without inventing an operator", () => {
    const original = { value: 2, unit: "tab", _comparator: { id: "operator-slot",
      extension: [{ url: "urn:test:operator-note", valueString: "Pending operator" }] } };
    let current = original;
    for (let save = 0; save < 3; save++) {
      const simple = simpleQuantityForR5(current)!;
      expect(simple).not.toHaveProperty("comparator");
      expect(simple).not.toHaveProperty("_comparator");
      current = quantityFromR5(persist(simple))! as typeof original;
      expect(current._comparator).toEqual(original._comparator);
      expect(current).not.toHaveProperty("comparator");
    }
  });

  it("does not select among conflicting metadata-only comparator source markers", () => {
    const first = simpleQuantityForR5({ value: 2, _comparator: { id: "first-slot" } })!;
    const second = simpleQuantityForR5({ value: 2, _comparator: { id: "second-slot" } })!;
    const mixed = { ...first, extension: [...first.extension!, ...second.extension!] };
    expect(quantityFromR5(mixed)).toEqual(mixed);
  });

  it.each(["100000000049", "100000000052", "unrecognized"])("does not attach metadata-only comparator source to a live operator %s", code => {
    const simple = simpleQuantityForR5({ value: 2, _comparator: { id: "empty-operator-slot" } })!;
    simple.extension!.push({ url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code } });
    const restored = quantityFromR5(simple)!;
    expect(restored._comparator).toBeUndefined();
    expect(JSON.stringify(restored.extension)).toContain("empty-operator-slot");
    expect(restored.comparator).toBe(code === "100000000052" ? "<=" : undefined);
  });

  it("retains a compatible authored method alias and its primitive translation", () => {
    const swallow = parseSig("Swallow 1 tablet daily").fhir[0].method!.coding!;
    const translation = { id: "authored-method-text", extension: [{ url: "urn:test:translation", valueString: "กลืน" }] };
    const row: FhirDosage = { method: { text: "Swallowing", _text: translation, coding: swallow } };
    expect(canonicalFromFhir(row).method).toMatchObject({ text: "Swallowing", _text: translation });
    row.method!.coding = parseSig("Chew 1 tablet daily").fhir[0].method!.coding!;
    const edited = canonicalFromFhir(row).method!;
    expect(edited.text).toBe("Chew");
    expect(edited._text).toBeUndefined();
  });

  it.each([{ clocks: [] as string[] }, { clocks: ["09:00:00"] }])("retires the mixed clock bridge on an explicit core edit $clocks", ({ clocks }) => {
    const row = persist(toFhirR5Dosages(course({ timing: { repeat: { ...daily, when: [EventTiming.Breakfast], timeOfDay: ["08:00:00"] } } }))[0]);
    const marker = row.timing!.repeat!.extension!.find(value => value.url === TIMING_ADDITIONAL_CLOCK_EXTENSION_URL)!;
    marker.id = "old-clock-source";
    row.timing!.repeat!.timeOfDay = clocks;
    const projected = projectCanonicalCourse(importCanonicalCourse(row));
    for (const wire of [projected.fhir[0], projected.fhirNext.step![0].component[0]]) {
      const repeat = wire.timing!.repeat!;
      expect(repeat.when).toEqual([EventTiming.Breakfast]);
      // An explicit [] is already a correct edit signal. Do not erase it only
      // for wire-schema neatness; the old bridge is inactive in either case.
      expect(repeat.timeOfDay).toEqual(clocks.length ? undefined : []);
      expect(importCanonicalCourse(wire).stages[0].administrations[0].schedule?.recurrence?.clocks ?? []).toEqual(clocks);
      expect(repeat.extension?.filter(value => value.url === TIMING_ADDITIONAL_CLOCK_EXTENSION_URL).map(value => value.valueTime) ?? []).toEqual(clocks);
      expect(JSON.stringify(repeat.extension)).toContain("old-clock-source");
    }
  });

  it("invalidates a fresh capped scheduled preview when only asNeededBoolean is edited", () => {
    const parsed = parseSig("Take 1 tablet daily, maximum 2 tablets per day");
    const row = parsed.fhir[0] as FhirDosage & { asNeededBoolean?: boolean };
    expect(row.text).toBeTruthy();
    row.asNeededBoolean = true;
    expect(fromFhirDosage(row).longText).toMatch(/as needed/i);
    expect(formatSig(row, "long")).toMatch(/as needed/i);
  });

  it.each([true, false])("keeps explicit asNeeded %s authoritative over the alternative R5 spelling", asNeeded => {
    const row: FhirDosage & { asNeededBoolean?: boolean } = { asNeeded, asNeededBoolean: !asNeeded,
      doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } };
    expect(importCanonicalCourse(row).stages[0].administrations[0].asNeeded).toBe(asNeeded);
  });

  it.each(["doseExpression", "rateExpression"] as const)("invalidates warm replay after in-place %s edits", field => {
    const row: EzDosage = { text: "Use the specified expression.", doseAndRate: [{ [field]: expression("original") }] };
    const saved = persist(withDosageEditProvenance([row], row.text)[0]) as EzDosage;
    expect(dosageMatchesSavedProjection(saved)).toBe(true);
    saved.doseAndRate![0][field]!.expression = "%current";
    expect(dosageMatchesSavedProjection(saved)).toBe(false);
    expect(dosageMatchesSavedProjection(persist(saved))).toBe(false);
  });

  it.each(["label", "uncoded", "amount", "comparator", "annotation"] as const)("compares repeated course interval identity independently from its %s", edit => {
    const oldCycle = { value: 28, unit: "days", system: ucum, code: "d" };
    const currentCycle: FhirR6Quantity = edit === "label" ? { ...oldCycle, unit: "d" }
      : edit === "uncoded" ? { value: 28, unit: "weeks" }
      : edit === "amount" ? { ...oldCycle, value: 14 }
      : edit === "annotation" ? { ...oldCycle, extension: [{ url: "urn:test:repeat-note", valueString: "Changed interval annotation" }] }
      : { ...oldCycle, comparator: "<" };
    const historicalCycle = edit === "uncoded" ? { value: 28, unit: "days" } : oldCycle;
    const fields = encodeR5RetainedFields({ course: { repeatCycle: historicalCycle } })
      .find(value => value.url === "course")!.extension!;
    const historical: FhirDosage = { sequence: 1, doseAndRate: [{ doseQuantity: q(1) }], modifierExtension: [{
      url: DOSAGE_DETAILS_R5_URL, extension: [{ url: "dosageDetails", extension: [...fields,
        encodeR6SourceMetadata("step", { component: [{ doseAndRate: [{ doseQuantity: q(1) }] }] }, "step")] }],
    }] };
    const compact = toFhirR5Dosages({ repeatCycle: currentCycle, step: [{ component: [{
      doseAndRate: [{ doseQuantity: simpleQuantityForR5({ ...q(2), comparator: "~" })! }],
    }] }] })[0];
    const rows = persist([historical, compact]);
    const imported = importCanonicalCourse(rows);
    if (edit === "label") {
      expect(imported.contextIssue).toBeUndefined();
      expect(imported.cycleInterval).toMatchObject({ value: 28, code: "d", system: ucum });
    } else expect(imported.contextIssue).toBe("missing-course-context");
    let output = toDosageDetails(rows);
    for (let save = 0; save <= 3; save++) {
      const intervals: FhirR6Quantity[] = output.repeatCycle ? [output.repeatCycle] : [];
      const collect = (markers: readonly FhirExtension[] | undefined): void => {
        for (const marker of markers ?? []) {
          if (marker.url === "course" || marker.url === "dosageDetails") {
            const decoded = decodeR5RetainedFields({ url: DOSAGE_DETAILS_R5_URL,
              extension: [{ url: "course", extension: marker.extension }] });
            if (decoded.course?.repeatCycle) intervals.push(decoded.course.repeatCycle);
          }
          collect(marker.extension);
        }
      };
      collect(output.extension);
      expect(intervals).toContainEqual(historicalCycle);
      expect(intervals).toContainEqual(currentCycle);
      if (save < 3) output = toDosageDetails(persist(toFhirR5Dosages(output)));
    }
  });

  it("retains authored history IDs and contents through text-only R5 edits", () => {
    const old: FhirExtension = { id: "old-history-child", url: "urn:test:old-text", valueString: "Earlier authored instructions" };
    let wire: FhirR6DosageInstruction = { renderedInstruction: "Current authored instructions",
      extension: [{ id: "authored-history-envelope", url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [old] }] };
    for (let save = 0; save < 3; save++) {
      const rows = persist(toFhirR5Dosages(wire));
      rows[0].text = "Edited instructions " + save;
      wire = toDosageDetails(rows);
      expect(wire.renderedInstruction).toBe("Edited instructions " + save);
      const retained = JSON.stringify(wire);
      expect(retained).toContain("old-history-child");
      expect(retained).toContain("authored-history-envelope");
      expect(retained).toContain("Earlier authored instructions");
    }
  });

  it("retains the exact authored history envelope while flattening its already retained children", () => {
    const old = { url: "urn:test:old-source", valueString: "Old text" };
    const marker: FhirExtension = { url: DOSAGE_DETAILS_R5_URL, extension: [{ url: "dosageDetails", extension: [
      { url: "renderedInstruction", valueString: "Previous text" },
      { id: "field-id", url: "extension", extension: [{ id: "history-id", url: DOSAGE_RECONCILIATION_SOURCE_URL,
        extension: [old] }] },
    ] }] };
    const retained = sourceWithoutNestedHistory(marker);
    expect(retained.extension![0].extension).toEqual([
      { url: "renderedInstruction", valueString: "Previous text" },
      { id: "field-id", url: "extension", extension: [{ id: "history-id", url: DOSAGE_RECONCILIATION_SOURCE_URL }] },
    ]);
    expect(sourceWithoutNestedHistory(retained)).toEqual(retained);
  });
});


describe("round36 external policy ownership and current source replay", () => {
  const daily = { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } };
  const component = () => ({ doseAndRate: [{ doseQuantity: q(1) }], timing: persist(daily) });
  const cap = (value: number, text: string) => ({ scope: "lifetime" as const, valueQuantity: q(value), text });

  it.each(["keep", "delete", "replace", "duplicate"] as const)(
    "keeps an unchanged induction ceiling scoped after a course edit (%s)", edit => {
      const wire = r6Save({ safety: { doseLimit: [cap(4, "course cap")] }, step: [{
        id: "induction", safety: { doseLimit: [cap(2, "induction cap")] }, component: [component()]
      }] });
      wire.step!.push({ id: "maintenance", component: [component()] });
      wire.safety!.doseLimit!.find(limit => limit.valueQuantity?.value === 4)!.valueQuantity!.value = 5;
      if (edit === "delete") wire.safety!.doseLimit = wire.safety!.doseLimit!.filter(limit => limit.valueQuantity?.value !== 2);
      if (edit === "replace") wire.step![0].id = "replacement";
      if (edit === "duplicate") wire.step![1].id = "induction";
      const native = importCanonicalCourse(persist(wire));
      expect(native.safety?.limits?.map(limit => limit.amount?.value)).toEqual([5]);
      expect(native.stages[1].safety?.limits).toBeUndefined();
      // Independent effective ceiling oracle: induction is constrained by
      // its own surviving 2-tablet limit and the edited 5-tablet course limit;
      // maintenance is constrained only by the current course limit.
      const effectiveCeilings = native.stages.map(stage => Math.min(
        ...(native.safety?.limits ?? []).map(limit => limit.amount!.value!),
        ...(stage.safety?.limits ?? []).map(limit => limit.amount!.value!)
      ));
      expect(effectiveCeilings).toEqual(edit === "keep" ? [2, 5] : [5, 5]);
      if (edit === "keep") expect(native.stages[0].safety?.limits?.map(limit => limit.amount?.value)).toEqual([2]);
      else expect(native.stages[0].safety?.limits).toBeUndefined();
      expect(JSON.stringify(projectCanonicalCourse(native).fhirNext)).toContain("induction cap");
    });

  it.each([
    { annotated: true, edit: "amount" }, { annotated: false, edit: "amount" },
    { annotated: true, edit: "period" },
  ])("matches period-limit annotations before mutable $edit edits (annotated=$annotated)", ({ annotated, edit }) => {
    const input = course({ safety: { doseLimit: [4, 8].map((value, index) => ({
      scope: "period" as const, valueQuantity: q(value), period: { value: edit === "period" ? index + 1 : 1, unit: "d" }, text: "limit " + index,
      ...(annotated ? { extension: [{ url: "urn:limit-note", valueString: "tag " + index }] } : {})
    })) } });
    const rows = persist(toFhirR5Dosages(input));
    if (edit === "amount") {
      rows[0].maxDosePerPeriod![0].numerator!.value = 8;
      rows[0].maxDosePerPeriod![1].numerator!.value = 10;
    } else {
      rows[0].maxDosePerPeriod![0].denominator!.value = 2;
      rows[0].maxDosePerPeriod![1].denominator!.value = 3;
    }
    let saved = toDosageDetails(rows);
    for (let pass = 0; pass <= 3; pass++) {
      const limits = saved.step![0].component[0].safety!.doseLimit!;
      expect(limits.map(limit => limit.valueQuantity?.value)).toEqual(edit === "amount" ? [8, 10] : [4, 8]);
      expect(limits.map(limit => limit.period?.value)).toEqual(edit === "period" ? [2, 3] : [1, 1]);
      expect(limits.map(limit => limit.text)).toEqual(annotated ? ["limit 0", "limit 1"] : [undefined, undefined]);
      if (annotated) expect(limits.map(limit => limit.extension?.[0].valueString)).toEqual(["tag 0", "tag 1"]);
      expect(JSON.stringify(saved)).toContain("limit 0");
      expect(JSON.stringify(saved)).toContain("limit 1");
      if (pass < 3) saved = toDosageDetails(persist(toFhirR5Dosages(saved)));
    }
  });

  it("detaches lifted Ratio annotations from both original and safety baseline", () => {
    const input: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }], maxDosePerPeriod: [{
      numerator: q(4), denominator: { value: 1, unit: "d" },
      extension: [{ url: "urn:limit-note", extension: [{ url: "note", valueString: "original" }] }]
    }] };
    const row = toEzDosages([input])[0];
    row.safety!.doseLimit![0].extension![0].extension![0].valueString = "safety edit";
    row.maxDosePerPeriod![0].numerator!.value = 3;
    expect(input.maxDosePerPeriod![0].extension![0].extension![0].valueString).toBe("original");
    for (const edited of [row, persist(row)]) {
      const limit = importCanonicalCourse([edited]).stages[0].administrations[0].limits![0];
      expect(limit.amount?.value).toBe(4);
      expect(limit.provenance?.extension).toEqual([{ url: "urn:limit-note", extension: [{ url: "note", valueString: "safety edit" }] }]);
    }
  });

  it.each(["r5", "r6"] as const)("preserves and edits qualified occurrence-duration endpoints through %s saves", target => {
    const marker: FhirExtension = { url: TIMING_ADMINISTRATION_DURATION_EXTENSION_URL, id: "duration-range",
      valueRange: {
        low: simpleQuantityForR5({ value: 1, unit: "h", code: "h", system: "http://unitsofmeasure.org", comparator: ">=" })!,
        high: { value: 2, unit: "h", code: "h", system: "http://unitsofmeasure.org",
          extension: [{ url: "urn:test:duration-high", valueString: "prescriber upper bound" }] },
      } };
    const row: FhirDosage = { doseAndRate: [{ rateQuantity: { value: 5, unit: "mL/h" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, extension: [marker] } } };
    let current: FhirDosage[] | FhirR6DosageInstruction = target === "r5" ? [row] : course(row);
    const firstRow = () => Array.isArray(current) ? current[0] : current.step![0].component[0];
    const liveMarker = () => firstRow().timing!.repeat!.extension!.find(item => item.url === marker.url)!;
    for (const max of [2, 3]) {
      if (max === 3) {
        // Saved text replay belongs to the editable R5 surface. Current R6
        // is verified below through native reimport and its own projections.
        if (Array.isArray(current)) {
          const timing = current[0].timing!;
          const proof = captureSourceReplayTiming(timing);
          expect(matchesSourceReplayTiming(timing, proof)).toBe(true);
          liveMarker().valueRange!.high!.value = 3;
          expect(matchesSourceReplayTiming(timing, proof)).toBe(false);
        } else liveMarker().valueRange!.high!.value = 3;
      }
      for (let save = 0; save <= 3; save++) {
        const native = importCanonicalCourse(current);
        expect(native.stages[0].administrations[0].schedule?.recurrence).toMatchObject({
          occurrenceDurationRange: {
            low: { value: 1, unit: "h", code: "h", system: "http://unitsofmeasure.org", comparator: ">=" },
            high: { value: max, unit: "h", code: "h", system: "http://unitsofmeasure.org" },
          },
        });
        const active = liveMarker();
        expect(getQuantityComparator(active.valueRange!.low)).toBe(">=");
        expect(active.valueRange!.low).toMatchObject({ value: 1, unit: "h" });
        expect(active.valueRange!.high).toMatchObject({ value: max, unit: "h",
          extension: [{ url: "urn:test:duration-high", valueString: "prescriber upper bound" }] });
        expect(firstRow().timing!.repeat!.duration).toBeUndefined();
        expect(firstRow().timing!.repeat!.durationMax).toBeUndefined();
        if (save < 3) {
          const projected = projectCanonicalCourse(native);
          current = persist(target === "r5" ? projected.fhir : projected.fhirNext);
        }
      }
    }
    // The current core upper bound supersedes the marker's former high endpoint.
    // Its displaced annotated Range stays available as inactive source.
    let wire = projectCanonicalCourse(importCanonicalCourse(current)).fhirNext;
    const prior = persist(wire.step![0].component[0].timing!.repeat!.extension!.find(item => item.url === marker.url)!);
    wire.step![0].component[0].timing!.repeat!.durationMax = 4;
    for (let save = 0; save < 3; save++) {
      wire = r6Save(wire);
      expect(importCanonicalCourse(wire).stages[0].administrations[0].schedule?.recurrence).toMatchObject({
        occurrenceDurationRange: { low: { value: 1, comparator: ">=" }, high: { value: 4 } },
      });
      const repeat = wire.step![0].component[0].timing!.repeat!;
      expect(repeat.durationMax).toBeUndefined();
      expect(repeat.extension!.find(item => item.url === marker.url)!.valueRange!.high!.value).toBe(4);
      expect(JSON.stringify(wire)).toContain(JSON.stringify(prior));
    }
  });

  it("invalidates a warmed site restriction proof without changing the source wording", () => {
    const source = "Apply 1 g to skin where skin is red daily max 2 g/day";
    const row = parseSig(source).items[0].fhir;
    const proof = captureSourceReplayConcept(row.site, true);
    formatSig(row, "long", { locale: "en", realizationMode: "roundtrip" });
    const restriction = row.site!.extension!.find(item => item.url.endsWith("medication-body-site-restriction"))!;
    restriction.extension!.find(item => item.url === "predicateText")!.valueString = "skin is itchy";
    expect(matchesSourceReplayConcept(row.site, proof)).toBe(false);
    const text = formatSig(row, "long", { locale: "en", realizationMode: "roundtrip" });
    expect(text).toContain("itchy");
    expect(text).not.toContain("skin is red");
    expect(row.text).toBe(source);
  });

  it.each(["dose", "rate"] as const)("uses a newly supplied %s expression instead of fresh scalar source text", dimension => {
    const row = parseSig("Take 1 tablet daily").items[0].fhir as EzDosage;
    const item = row.doseAndRate![0];
    if (dimension === "dose") delete item.doseQuantity;
    item[dimension === "dose" ? "doseExpression" : "rateExpression"] = {
      language: "text/fhirpath", expression: "weight-based current " + dimension
    };
    const source = JSON.stringify(row);
    for (const mode of ["roundtrip", "normalized"] as const) {
      const options = { locale: "en", realizationMode: mode };
      const direct = formatSig(row, "long", options);
      const imported = fromFhirDosage(row, options).longText;
      for (const text of [direct, imported]) {
        expect(text).toContain("weight-based current " + dimension);
        if (dimension === "dose") expect(text).not.toMatch(/\b1 tablet\b/);
      }
    }
    item[dimension === "dose" ? "doseExpression" : "rateExpression"]!.expression = "second current " + dimension;
    expect(formatSig(row, "long", { locale: "en", realizationMode: "roundtrip" })).toContain("second current " + dimension);
    expect(source).toContain("weight-based current " + dimension);
  });

  it.each([false, true])("retains an intervening draft after an append only while original owners stay unique (duplicate=%s)", duplicate => {
    const wire = r6Save({ step: [
      { id: "first", component: [component()] },
      { id: "draft", start: {
        contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] },
        offsetDuration: { value: 2, unit: "d" },
      }, component: [] },
      { id: "second", component: [component()] },
    ] });
    wire.step!.push({ id: duplicate ? "first" : "third", component: [component()] });
    const native = importCanonicalCourse(persist(wire));
    const ids = native.stages.map(stage => stage.provenance?.id);
    expect(ids).toEqual(duplicate ? ["first", "second", "first"] : ["first", "draft", "second", "third"]);
    expect(JSON.stringify(projectCanonicalCourse(native).fhirNext)).toContain("draft");
  });

  it("retains nonclinical carrier annotations without inventing a treatment phase", () => {
    const rows = toFhirR5Dosages({ renderedInstruction: "Consult clinician" });
    rows[0].id = "source-carrier";
    rows[0].extension = [{ url: "urn:carrier-note", valueString: "only a source record" }];
    let saved = toDosageDetails(persist(rows));
    for (let pass = 0; pass < 3; pass++) {
      expect(saved.step ?? []).toHaveLength(0);
      expect(saved.renderedInstruction).toBe("Consult clinician");
      expect(JSON.stringify(saved)).toContain("source-carrier");
      expect(JSON.stringify(saved)).toContain("only a source record");
      saved = toDosageDetails(persist(toFhirR5Dosages(saved)));
    }
    const clinical = persist(rows);
    clinical[0].doseAndRate = [{ doseQuantity: q(2) }];
    expect(importCanonicalCourse(clinical).stages[0].administrations[0].amounts![0].quantity?.value).toBe(2);
  });

  it.each(["weekday", "date", "offset"] as const)("keeps a live %s restriction on an annotated source carrier", kind => {
    let rows = toFhirR5Dosages({ renderedInstruction: "Consult clinician" });
    rows[0].id = "clinical-carrier";
    rows[0].extension = [{ url: "urn:carrier-note", valueString: "preserve this annotation" }];
    if (kind === "weekday") setDosageExcludedWeekdays(rows[0], [FhirDayOfWeek.Monday]);
    else if (kind === "date") setDosageExcludedDates(rows[0], ["2026-12-01"]);
    else rows[0].modifierExtension!.push({ url: ADMINISTRATION_OFFSET_EXTENSION_URL,
      valueQuantity: { value: 30, unit: "min", code: "min", system: "http://unitsofmeasure.org" } });
    const original = JSON.stringify(rows);
    for (let save = 0; save <= 3; save++) {
      const native = importCanonicalCourse(rows);
      expect(native.stages).toHaveLength(1);
      expect(native.stages[0].administrations).toHaveLength(1);
      const administration = native.stages[0].administrations[0];
      if (kind === "weekday") expect(administration.excludedWeekdays).toEqual(["mon"]);
      else if (kind === "date") expect(administration.excludedDates).toEqual(["2026-12-01"]);
      else expect(administration.delayMinutes).toBe(30);
      expect(administration.amounts ?? []).toEqual([]);
      const projected = projectCanonicalCourse(native);
      expect(JSON.stringify(projected.fhirNext)).toContain("clinical-carrier");
      expect(JSON.stringify(projected.fhirNext)).toContain("preserve this annotation");
      if (save === 0) expect(JSON.stringify(rows)).toBe(original);
      if (save < 3) rows = persist(toFhirR5Dosages(projected.fhirNext));
    }
  });

  it("translates the supported R5 PRN alias into self-importable current R6", () => {
    const row = { doseAndRate: [{ doseQuantity: q(1) }], asNeededBoolean: true,
      extension: [{ url: "urn:prn-note", valueString: "retained" }] } as FhirDosage;
    const wire = toDosageDetails([row]);
    expect(wire.step![0].component[0].asNeeded).toBe(true);
    expect(wire.step![0].component[0]).not.toHaveProperty("asNeededBoolean");
    expect(fromFhir(persist(wire)).longText).toMatch(/as needed|when needed/i);
    expect(JSON.stringify(wire)).toContain("retained");
    expect(row).toHaveProperty("asNeededBoolean", true);
  });

  it("keeps a superseded unannotated EMA Coding under approximation source", () => {
    const old = { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000050" };
    const input = { value: 5, unit: "mL", comparator: "~" as const,
      extension: [{ url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL, valueCoding: old }] };
    const projected = quantityForR5(input)!;
    expect(getQuantityComparator(projected)).toBe("~");
    expect(projected.extension!.find(item => item.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL)?.valueCoding?.code)
      .toBe("100000000055");
    expect(projected.extension!.some(item => item.url !== EMA_QUANTITY_COMPARATOR_EXTENSION_URL &&
      item.valueCoding?.system === old.system && item.valueCoding?.code === old.code)).toBe(true);
    expect(input.extension[0].valueCoding).toEqual(old);
  });

  it("preserves displaced alternative-choice wrapper annotations through repeated saves", () => {
    const marker = (id: string): FhirExtension => ({ id, url: DOSAGE_ALTERNATIVE_CHOICE_URL,
      extension: [{ url: "groupId", valueString: "g" }, { url: "branchId", valueString: "a" },
        { url: "selectionBehavior", valueCode: "exactly-one" },
        { url: "urn:choice-note", valueString: "note " + id }] });
    let saved = r6Save(course({ ...component(), modifierExtension: [marker("first"), marker("second")] }));
    for (let pass = 0; pass < 3; pass++) {
      const live = saved.step![0].component[0].modifierExtension!.filter(item => item.url === DOSAGE_ALTERNATIVE_CHOICE_URL);
      expect(live).toHaveLength(1);
      expect(live[0].id).toBe("first");
      expect(JSON.stringify(saved)).toContain("second");
      expect(JSON.stringify(saved)).toContain("note second");
      saved = r6Save(persist(saved));
    }
  });
});


describe("round37 interchange phase, limit and source ownership", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] };
  const member = (value = 1, repeat: NonNullable<FhirR6Timing["repeat"]> = {}): FhirR6Dosage => ({
    doseAndRate: [{ doseQuantity: q(value) }], timing: { repeat: { ...daily, ...repeat } },
  });
  const options = { from: "2026-11-21T00:00:00Z", orderedAt: "2026-11-21T00:00:00Z", timeZone: "UTC", limit: 10 };

  it.each([
    { edited: false, compact: false }, { edited: false, compact: true }, { edited: true, compact: true },
  ])("keeps a historical header carrier separate from mixed live rows (clinical edit=$edited, compact=$compact)", ({ edited, compact }) => {
    const carrier = toFhirR5Dosages({ renderedInstruction: "Consult clinician" })[0];
    carrier.id = "original-source-carrier";
    carrier.extension = [{ url: "urn:source-note", valueString: "Retain this source" }];
    if (edited) carrier.doseAndRate = [{ doseQuantity: q(3) }];
    const live = toFhirR5Dosages({ step: [{ ...(compact ? { id: "active-dose-phase" } : {}), component: [
      { ...member(2), safety: { doseLimit: [{ scope: "administration", valueQuantity: q(4) }] } },
    ] }] })[0];
    let rows = persist([carrier, live]);
    for (let save = 0; save <= 3; save++) {
      const native = importCanonicalCourse(rows);
      const administrations = native.stages.map(stage => stage.administrations).reduce((all, members) => all.concat(members), []);
      expect(administrations.map(value => value.amounts?.[0]?.quantity?.value)).toEqual(edited ? [3, 2] : [2]);
      const output = projectCanonicalCourse(native);
      expect(JSON.stringify(output.fhirNext)).toContain("Consult clinician");
      expect(JSON.stringify(output.fhirNext)).toContain("original-source-carrier");
      expect(JSON.stringify(output.fhirNext)).toContain("Retain this source");
      if (save < 3) rows = persist(output.fhir);
    }
  });

  it.each([false, true])("aligns historical real members around a source carrier (carrier first=%s)", carrierFirst => {
    const carrier = toFhirR5Dosages({ renderedInstruction: "Historical header only" })[0];
    const historical: FhirDosage = { sequence: 1, doseAndRate: [{ doseQuantity: q(5) }],
      modifierExtension: [{ url: DOSAGE_DETAILS_R5_URL, extension: [{ url: "dosageDetails", extension: [
        encodeR6SourceMetadata("step", { component: [member(5)] }, "step"),
      ] }] }],
    };
    const compact = toFhirR5Dosages({ step: [{ id: "current-phase", component: [member(2)] }] })[0];
    let rows = persist([...(carrierFirst ? [carrier, historical] : [historical, carrier]), compact]);
    for (let save = 0; save <= 3; save++) {
      const native = importCanonicalCourse(rows);
      expect(native.stages.map(stage => stage.administrations).reduce((all, members) => all.concat(members), [])
        .map(value => value.amounts?.[0]?.quantity?.value)).toEqual([5, 2]);
      const output = projectCanonicalCourse(native);
      expect(JSON.stringify(output.fhirNext)).toContain("Historical header only");
      if (save < 3) rows = persist(output.fhir);
    }
  });

  it.each([true, false])("keeps an absolute component start independent after predecessor deletion (absolute=%s)", absolute => {
    const input: FhirR6DosageInstruction = { step: [
      { id: "loading", component: [member(1, { count: 1 })] },
      { component: [member(2, { count: 2, ...(absolute ? { boundsPeriod: { start: "2026-11-24T00:00:00Z" } } : {}) })] },
    ] };
    let rows = persist(toFhirR5Dosages(input).slice(1));
    for (let save = 0; save <= 3; save++) {
      const native = importCanonicalCourse(rows);
      const active = native.stages.map(stage => stage.administrations).reduce((all, members) => all.concat(members), []);
      expect(active.map(value => value.amounts?.[0]?.quantity?.value)).toEqual([2]);
      if (absolute) {
        expect(native.contextIssue).toBeUndefined();
        expect(nextDueDoses(rows, options)).toEqual([
          "2026-11-24T08:00:00+00:00", "2026-11-25T08:00:00+00:00",
        ]);
        expect(calculateTotalUnits({ ...options, dosage: rows, durationValue: 7, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(4);
      } else {
        expect(native.contextIssue).toBe("missing-course-context");
        expect(() => nextDueDoses(rows, options)).toThrow(/complete dosage array/i);
      }
      if (save < 3) rows = persist(projectCanonicalCourse(native).fhir);
    }
  });

  it("retains implicit successor membership without inventing a new treatment origin", () => {
    const input: FhirR6DosageInstruction = { step: [
      { component: [member(1, { count: 1 })] }, { component: [member(2, { count: 3 })] },
    ] };
    const full = persist(toFhirR5Dosages(input));
    expect(nextDueDoses(full, options)).toEqual([
      "2026-11-21T08:00:00+00:00", "2026-11-22T08:00:00+00:00",
      "2026-11-23T08:00:00+00:00", "2026-11-24T08:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ ...options, dosage: full, durationValue: 7, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(7);
    let rows = full.slice(1);
    for (let save = 0; save <= 3; save++) {
      const native = importCanonicalCourse(rows);
      expect(native.stages.map(stage => stage.administrations).reduce((all, members) => all.concat(members), []).map(value => value.amounts?.[0]?.quantity?.value)).toEqual([2]);
      expect(native.contextIssue).toBe("missing-course-context");
      expect(() => nextDueDoses(rows, options)).toThrow(/complete dosage array/i);
      if (save < 3) rows = persist(projectCanonicalCourse(native).fhir);
    }
  });

  it.each([
    { scope: "administration" as const, values: [2, 4] }, { scope: "administration" as const, values: [4, 2] },
    { scope: "lifetime" as const, values: [2, 4] }, { scope: "lifetime" as const, values: [4, 2] },
  ])("projects the tighter exact $scope cap independently of order $values", ({ scope, values }) => {
    const limits = values.map(value => ({ scope, valueQuantity: q(value), text: value + "-tablet authored cap" }));
    let wire = course({ ...member(), safety: { doseLimit: limits } });
    for (let save = 0; save <= 3; save++) {
      const rows = persist(toFhirR5Dosages(wire));
      expect(scope === "administration" ? rows[0].maxDosePerAdministration : rows[0].maxDosePerLifetime).toEqual(q(2));
      const reopened = toDosageDetails(rows);
      expect(reopened.step![0].component[0].safety?.doseLimit).toEqual(limits);
      if (save < 3) wire = persist(reopened);
    }
  });

  it.each([
    { saved: "compact", edit: "change" }, { saved: "compact", edit: "delete" },
    { saved: "full", edit: "change" }, { saved: "full", edit: "delete" },
    { saved: "current", edit: "change" }, { saved: "current", edit: "delete" },
  ])("edits the actual shown maximum from $saved R5 storage ($edit)", ({ saved, edit }) => {
    const amount = (value: number, id: string) => ({ value, unit: "tab", id,
      extension: [{ url: "urn:quantity-note", valueString: id }] });
    const limits = [
      { id: "first-cap", scope: "administration" as const, valueQuantity: amount(2, "first-quantity"), text: "First cap" },
      { id: "volume-cap", scope: "administration" as const, valueQuantity: { value: 4, unit: "mL", id: "volume-quantity" }, text: "Independent volume cap" },
      { id: "last-cap", scope: "administration" as const, valueQuantity: amount(4, "last-quantity"), text: "Last cap" },
      { id: "period-cap", scope: "period" as const, valueQuantity: q(8), period: { value: 1, unit: "d" },
        extension: [{ url: "urn:period-note", valueString: "Keep period annotation" }] },
    ];
    const component = { doseAndRate: [{ doseQuantity: q(1) }], safety: { doseLimit: limits } };
    // Captured from the public writer at 6c0e3cd: the shown cap was 4,
    // with its exact annotated projected-safety fingerprint. This fixture
    // does not derive its expected original ownership from today's writer.
    const historical: FhirDosage = { sequence: 1, doseAndRate: [{ doseQuantity: q(1) }],
      maxDosePerAdministration: amount(4, "last-quantity"),
      maxDosePerPeriod: [{ id: "period-cap", numerator: q(8), denominator: { value: 1, unit: "d" },
        extension: [{ url: "urn:period-note", valueString: "Keep period annotation" }] }],
      modifierExtension: [{ url: DOSAGE_DETAILS_R5_URL, extension: saved === "full"
        ? [{ url: "dosageDetails", extension: [encodeR6SourceMetadata("step", { component: [component] }, "step")] }]
        : encodeR5RetainedFields({ rowIndex: 0, sequence: 1, stepCount: 1, countScope: "step",
          component: { safety: { doseLimit: limits } }, baseline: { safety: "ced94fe0a80e7663" } }),
      }],
    };
    let rows = persist(saved === "current" ? toFhirR5Dosages(course(component)) : [historical]);
    expect(rows[0].maxDosePerAdministration!.value).toBe(saved === "current" ? 2 : 4);
    if (edit === "delete") delete rows[0].maxDosePerAdministration;
    else rows[0].maxDosePerAdministration!.value = 3;
    const shownId = saved === "current" ? "first-cap" : "last-cap";
    const expected = limits.filter(limit => edit !== "delete" || limit.id !== shownId).map(limit =>
      edit === "change" && limit.id === shownId ? { ...limit, valueQuantity: { ...limit.valueQuantity, value: 3 } } : limit);
    for (let save = 0; save <= 3; save++) {
      const wire = toDosageDetails(rows);
      const actual = wire.step![0].component[0].safety!.doseLimit!;
      expect(actual).toHaveLength(expected.length);
      for (const limit of expected) expect(actual.find(value => value.id === limit.id)).toEqual(limit);
      expect(JSON.stringify(wire)).toContain("first-quantity");
      expect(JSON.stringify(wire)).toContain("last-quantity");
      if (save < 3) rows = persist(toFhirR5Dosages(wire));
    }
  });

  it.each([
    { amounts: [{ value: 2, unit: "tab" }, { value: 4, unit: "mL" }, { value: 4, unit: "tab" }], owner: 0 },
    { amounts: [{ value: 4, unit: "tab" }, { value: 4, unit: "mL" }, { value: 2, unit: "tab" }], owner: 2 },
    { amounts: [{ value: 2, unit: "mL" }, { value: 4, unit: "tab" }, { value: 4, unit: "mL" }], owner: 0 },
    { amounts: [{ value: 4, unit: "mL" }, { value: 2, unit: "tab" }, { value: 4, unit: "tab" }, { value: 2, unit: "mL" }], owner: 3 },
  ])("keeps the tighter annotated maximum within the last interleaved unit (owner=$owner)", ({ amounts, owner }) => {
    const limits = amounts.map((amount, index) => ({ id: "cap-" + index, scope: "administration" as const,
      valueQuantity: { ...amount, id: "quantity-" + index }, text: "Authored cap " + index }));
    let wire = course({ safety: { doseLimit: limits } });
    for (let save = 0; save <= 3; save++) {
      const rows = persist(toFhirR5Dosages(wire));
      expect(rows[0].maxDosePerAdministration).toEqual({ ...amounts[owner], id: "quantity-" + owner });
      wire = toDosageDetails(rows);
      expect(wire.step![0].component[0].safety?.doseLimit).toEqual(limits);
    }
  });

  it.each(["~", "<"] as const)("retains the exact minimum around an authored %s maximum", comparator => {
    const limits = [
      { id: "exact-tight", scope: "administration" as const, valueQuantity: { ...q(2), id: "exact-quantity" } },
      { id: "qualified", scope: "administration" as const, valueQuantity: { ...q(1), comparator, id: "qualified-quantity" } },
      { id: "exact-later", scope: "administration" as const, valueQuantity: q(4) },
    ];
    let wire = course({ safety: { doseLimit: limits } });
    for (let save = 0; save <= 3; save++) {
      const rows = persist(toFhirR5Dosages(wire));
      expect(rows[0].maxDosePerAdministration).toEqual({ ...q(2), id: "exact-quantity" });
      wire = toDosageDetails(rows);
      expect(wire.step![0].component[0].safety?.doseLimit).toEqual(limits);
    }
  });

  it("keeps the edited annotated cap as the shown owner when its value reaches an equal sibling", () => {
    const limits = [
      { id: "edited-cap", scope: "administration" as const, valueQuantity: { ...q(4), id: "edited-quantity" }, text: "Edited owner" },
      { id: "hidden-cap", scope: "administration" as const, valueQuantity: { ...q(6), id: "hidden-quantity" }, text: "Independent sibling" },
    ];
    let rows = persist(toFhirR5Dosages(course({ safety: { doseLimit: limits } })));
    for (const value of [6, 5]) {
      expect(rows[0].maxDosePerAdministration!.id).toBe("edited-quantity");
      rows[0].maxDosePerAdministration!.value = value;
      for (let save = 0; save <= 3; save++) {
        const output = toDosageDetails(rows);
        const actual = output.step![0].component[0].safety!.doseLimit!;
        expect(actual.find(limit => limit.id === "edited-cap")).toEqual({
          ...limits[0], valueQuantity: { ...q(value), id: "edited-quantity" },
        });
        expect(actual.find(limit => limit.id === "hidden-cap")).toEqual(limits[1]);
        rows = persist(toFhirR5Dosages(output));
        expect(rows[0].maxDosePerAdministration).toEqual({ ...q(value), id: "edited-quantity" });
      }
    }
  });

  it.each(["unit", "comparator"] as const)("retains incomparable %s caps without converting authored quantities", difference => {
    const last: FhirR6Quantity = difference === "unit" ? { value: 4, unit: "mL" } : { ...q(4), comparator: "<" };
    const limits = [{ scope: "administration" as const, valueQuantity: q(2) }, { scope: "administration" as const, valueQuantity: last }];
    let wire = course({ safety: { doseLimit: limits } });
    for (let save = 0; save <= 3; save++) {
      const rows = persist(toFhirR5Dosages(wire));
      expect(quantityFromR5(rows[0].maxDosePerAdministration)).toEqual(difference === "unit" ? last : q(2));
      wire = toDosageDetails(rows);
      expect(wire.step![0].component[0].safety?.doseLimit).toEqual(limits);
    }
  });

  it.each(["keep", "delete", "replace", "duplicate"] as const)("separates a course action edit from unchanged phase cap ownership (%s)", edit => {
    let wire = r6Save({ safety: { ifExceeded: "Original course action" }, step: [{
      id: "induction", safety: { doseLimit: [{ scope: "administration", valueQuantity: q(2), text: "Induction only" }] },
      component: [member()],
    }] });
    wire.step!.push({ id: "maintenance", component: [member(3)] });
    wire.safety!.ifExceeded = "Contact clinician";
    if (edit === "delete") wire.safety!.doseLimit = [];
    if (edit === "replace") wire.step![0].id = "replacement";
    if (edit === "duplicate") wire.step![1].id = "induction";
    for (let save = 0; save <= 3; save++) {
      const native = importCanonicalCourse(persist(wire));
      expect(native.safety?.ifExceeded).toBe("Contact clinician");
      expect(native.safety?.limits ?? []).toEqual([]);
      expect(native.stages[1].safety?.limits).toBeUndefined();
      expect(native.stages[0].safety?.limits?.map(limit => limit.amount?.value) ?? []).toEqual(edit === "keep" ? [2] : []);
      expect(native.stages[1].administrations[0].amounts![0].quantity?.value).toBe(3);
      const output = projectCanonicalCourse(native);
      expect(JSON.stringify(output.fhirNext)).toContain("Induction only");
      if (save < 3) wire = persist(save === 1 ? toDosageDetails(output.fhir) : output.fhirNext);
    }
  });

  it.each([false, true])("keeps incomplete annotated period maxima source-only through editable saves (valid sibling=%s)", valid => {
    const incomplete: FhirRatio = { id: "incomplete-limit", numerator: q(2), denominator: {
      unit: "d", extension: [{ url: "urn:period-note", valueString: "Period value was not authored" }],
    } };
    const complete: FhirRatio = { id: "complete-limit", numerator: q(2), denominator: { value: 1, unit: "d" } };
    let rows = toEzDosages([{ doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily },
      maxDosePerPeriod: [incomplete, ...(valid ? [complete] : [])] }]);
    expect(rows[0].safety?.doseLimit?.map(limit => limit.id) ?? []).toEqual(valid ? ["complete-limit"] : []);
    for (let save = 0; save <= 3; save++) {
      const native = importCanonicalCourse(persist(rows));
      const limits = native.stages[0].administrations[0].limits ?? [];
      expect(limits.map(limit => ({ amount: limit.amount?.value, period: limit.period?.value }))).toEqual(valid ? [{ amount: 2, period: 1 }] : []);
      const output = projectCanonicalCourse(native);
      expect(JSON.stringify(output.fhirNext)).toContain("Period value was not authored");
      expect(JSON.stringify(output.fhirNext)).toContain("incomplete-limit");
      if (save < 3) rows = toEzDosages(persist(output.fhir));
    }
  });

  it("invalidates warm source replay only when the effective site target count changes", () => {
    const countUrl = "urn:ezmedicationinput:body-site-administration-target-count";
    const source = "Apply 1 g to each of 2 lesions daily max 2 g/day";
    const input: FhirDosage = {
      text: source, doseAndRate: [{ doseQuantity: { value: 1, unit: "g" } }], timing: { repeat: daily },
      maxDosePerPeriod: [{ numerator: { value: 2, unit: "g" }, denominator: { value: 1, unit: "d" } }],
      site: { text: "lesions", extension: [{ url: countUrl, valueInteger: 2 }] },
    };
    let row = persist(projectCanonicalCourse(importCanonicalCourse(input)).fhir[0]);
    const proof = captureSourceReplayConcept(row.site, true);
    expect(formatSig(row, "long", { realizationMode: "roundtrip" })).toBe(source);
    const marker = { ...row.site!.extension!.find(item => item.url === countUrl)!, id: "unchanged-count-new-annotation" };
    row.site!.extension = [marker];
    expect(matchesSourceReplayConcept(row.site, proof)).toBe(true);
    marker.valueInteger = 3;
    expect(matchesSourceReplayConcept(row.site, proof)).toBe(false);
    const edited = formatSig(row, "long", { realizationMode: "roundtrip" });
    expect(edited).not.toContain("2 lesions");
    expect(edited).toBe(formatSig(persist(row), "long", { realizationMode: "roundtrip" }));
    expect(row.text).toBe(source);
    for (let save = 0; save <= 3; save++) {
      const native = importCanonicalCourse(row);
      expect(native.stages[0].administrations[0].targetCount).toBe(3);
      const output = projectCanonicalCourse(native);
      expect(JSON.stringify(output.fhirNext)).toContain(source);
      if (save < 3) row = persist(output.fhir[0]);
    }
  });

  it.each([false, true])("shows a source-less ordinary R5 rate Ratio in both previews (dose=%s)", dose => {
    const row: FhirDosage = { doseAndRate: [{ ...(dose ? { doseQuantity: q(1) } : {}),
      rateRatio: { numerator: { value: 100, unit: "mL" }, denominator: { value: 2, unit: "h" } },
    }] };
    for (const displayed of [formatSig(row, "long"), fromFhirDosage(row).longText]) {
      expect(displayed).toContain("100 mL / 2 h");
      if (dose) expect(displayed).toMatch(/1 (?:tab|tablet)/);
    }
    row.text = "Authored infusion instructions";
    expect(formatSig(row, "long")).toBe("Authored infusion instructions");
  });
});


describe("round38 external safety, identity, and source ownership", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day };
  const predicate = (value: number) => ({ kind: "measurement" as const, name: "SBP",
    operation: "gt" as const, value, unit: "mmHg", text: "SBP > " + value });
  const component = { id: "dose", doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } };

  it.each(["keep", "delete", "change"] as const)("keeps a surviving lifted phase cap scoped beside an independent header modifier (%s)", edit => {
    let wire = r6Save({ step: [{ id: "induction", component: [component], safety: {
      doseLimit: [{ id: "phase-limit", scope: "administration", valueQuantity: q(2) }],
    } }] });
    wire.step!.push({ id: "maintenance", component: [{ ...component, id: "maintenance-dose" }] });
    wire.safety!.modifierExtension = [{ url: "urn:test:header-policy", valueString: "independent" }];
    if (edit === "delete") wire.safety!.doseLimit = [];
    if (edit === "change") wire.safety!.doseLimit![0].valueQuantity!.value = 3;
    for (let save = 0; save <= 2; save++) {
      const native = importCanonicalCourse(persist(wire));
      expect(native.stages[0].safety?.limits?.map(limit => limit.amount?.value) ?? []).toEqual(edit === "keep" ? [2] : []);
      expect(native.stages[1].safety?.limits ?? []).toEqual([]);
      expect(native.safety?.limits?.map(limit => limit.amount?.value) ?? []).toEqual(edit === "change" ? [3] : []);
      const output = projectCanonicalCourse(native).fhirNext;
      expect(output.safety?.modifierExtension).toContainEqual({ url: "urn:test:header-policy", valueString: "independent" });
      wire = persist(output);
    }
  });


  it.each([
    { coursePolicy: false, edit: "append" }, { coursePolicy: false, edit: "replace" }, { coursePolicy: false, edit: "remove" },
    { coursePolicy: true, edit: "append" }, { coursePolicy: true, edit: "replace" }, { coursePolicy: true, edit: "remove" },
  ])("keeps existing scoped modifiers with their live owners ($edit, course=$coursePolicy)", ({ coursePolicy, edit }) => {
    const phase = { id: "phase-qualifier", url: "urn:test:phase-policy", valueString: "induction only" };
    const header = { id: "course-qualifier", url: "urn:test:course-policy", valueString: "whole course" };
    const added = { url: "urn:test:independent-header-policy", valueString: "new whole-course qualifier" };
    let wire = r6Save({
      ...(coursePolicy ? { safety: { modifierExtension: [header],
        doseLimit: [{ id: "course-cap", scope: "lifetime", valueQuantity: q(20) }] } } : {}),
      step: [{ id: "induction", component: [component], safety: {
        doseLimit: [{ id: "phase-cap", scope: "administration", valueQuantity: q(2) }], modifierExtension: [phase],
      } }],
    });
    wire.step!.push({ id: "maintenance", component: [{ ...component, id: "maintenance-dose" }] });
    wire.safety!.modifierExtension = edit === "append" ? [...wire.safety!.modifierExtension!, added] :
      edit === "replace" ? [added] : [];
    for (let save = 0; save <= 2; save++) {
      const native = importCanonicalCourse(persist(wire));
      expect(native.stages[0].safety?.limits?.map(limit => limit.amount?.value)).toEqual([2]);
      wire = projectCanonicalCourse(native).fhirNext;
      expect(wire.step![0].safety?.modifierExtension ?? []).toEqual(edit === "append" ? [phase] : []);
      expect(wire.safety?.modifierExtension ?? []).toEqual(edit === "remove" ? [] :
        edit === "append" && coursePolicy ? [header, added] : [added]);
      expect(wire.step![1].safety).toBeUndefined();
      expect(JSON.stringify(wire)).toContain("induction only");
    }
  });

  it.each(["change", "delete"] as const)("retains an induction-only action when its independent course limit is %s", edit => {
    let wire = r6Save({ safety: { doseLimit: [{ id: "course-limit", scope: "administration", valueQuantity: q(4) }] },
      step: [{ id: "induction", component: [component], safety: { ifExceeded: "Review induction" } }] });
    wire.step!.push({ id: "maintenance", component: [{ ...component, id: "maintenance-dose" }] });
    if (edit === "delete") wire.safety!.doseLimit = [];
    else wire.safety!.doseLimit![0].valueQuantity!.value = 3;
    for (let save = 0; save <= 2; save++) {
      const native = importCanonicalCourse(persist(wire));
      expect(native.stages[0].safety?.ifExceeded).toBe("Review induction");
      expect(native.stages[1].safety).toBeUndefined();
      expect(native.safety?.ifExceeded).toBeUndefined();
      expect(native.safety?.limits?.map(limit => limit.amount?.value) ?? []).toEqual(edit === "delete" ? [] : [3]);
      wire = persist(projectCanonicalCourse(native).fhirNext);
    }
  });

  it.each(["administration", "lifetime"] as const)("keeps the exact %s ceiling ahead of a later approximate sibling", scope => {
    const limits = [
      { id: "tight", scope, valueQuantity: q(3) },
      { id: "loose", scope, valueQuantity: q(5) },
      { id: "approximate", scope, valueQuantity: { ...q(8), comparator: "~" as const } },
    ];
    let wire = course({ safety: { doseLimit: limits } });
    for (let save = 0; save <= 2; save++) {
      const rows = persist(toFhirR5Dosages(wire));
      const active = scope === "administration" ? rows[0].maxDosePerAdministration : rows[0].maxDosePerLifetime;
      expect(active).toEqual(q(3));
      wire = toDosageDetails(rows);
      expect(wire.step![0].component[0].safety?.doseLimit).toEqual(limits);
    }
    const rows = persist(toFhirR5Dosages(wire));
    const active = scope === "administration" ? rows[0].maxDosePerAdministration! : rows[0].maxDosePerLifetime!;
    active.value = 2;
    const edited = toDosageDetails(rows).step![0].component[0].safety!.doseLimit!;
    expect(edited.find(limit => limit.id === "tight")?.valueQuantity).toEqual(q(2));
    expect(edited.find(limit => limit.id === "approximate")?.valueQuantity).toEqual({ ...q(8), comparator: "~" });
  });


  it.each(["change", "delete"] as const)("edits the actually shown approximate cap in a reviewed saved R5 row (%s)", edit => {
    const limits = [
      { id: "tight", scope: "administration" as const, valueQuantity: q(3) },
      { id: "loose", scope: "administration" as const, valueQuantity: q(5) },
      { id: "approximate", scope: "administration" as const, valueQuantity: { ...q(8), comparator: "~" as const } },
    ];
    // Actual a6ed242 writer: approximate 8 was exposed in the singular field.
    // The fingerprint and shown owner are captured independently of this writer.
    let rows: FhirDosage[] = [{ ...component, sequence: 1,
      maxDosePerAdministration: simpleQuantityForR5({ ...q(8), comparator: "~" })!,
      modifierExtension: [{ url: DOSAGE_DETAILS_R5_URL, extension: encodeR5RetainedFields({
        rowIndex: 0, sequence: 1, stepCount: 1, countScope: "step",
        component: { safety: { doseLimit: limits } }, baseline: { safety: "9557b781cdbb15cc" },
      }) }],
    }];
    if (edit === "delete") delete rows[0].maxDosePerAdministration;
    else rows[0].maxDosePerAdministration!.value = 9;
    for (let save = 0; save <= 3; save++) {
      const wire = toDosageDetails(persist(rows));
      const active = wire.step![0].component[0].safety!.doseLimit!;
      expect(active.find(limit => limit.id === "tight")).toEqual(limits[0]);
      expect(active.find(limit => limit.id === "loose")).toEqual(limits[1]);
      expect(active.find(limit => limit.id === "approximate")).toEqual(edit === "delete" ? undefined :
        { ...limits[2], valueQuantity: { ...q(9), comparator: "~" } });
      expect(JSON.stringify(wire)).toContain("approximate");
      rows = toFhirR5Dosages(wire);
      expect(rows[0].maxDosePerAdministration).toEqual(q(3));
    }
  });

  it("keeps an authored qualified maximum when there is no exact ceiling", () => {
    const limits = [
      { scope: "administration" as const, valueQuantity: { ...q(3), comparator: "<" as const } },
      { scope: "administration" as const, valueQuantity: { ...q(8), comparator: "~" as const } },
    ];
    const rows = persist(toFhirR5Dosages(course({ safety: { doseLimit: limits } })));
    expect(quantityFromR5(rows[0].maxDosePerAdministration)).toEqual({ ...q(8), comparator: "~" });
    expect(toDosageDetails(rows).step![0].component[0].safety!.doseLimit).toEqual(limits);
  });

  it.each(["administration", "lifetime", "period"] as const)("keeps the external editable %s safety baseline detached before JSON save", scope => {
    const source = course({ safety: { doseLimit: [{ scope, valueQuantity: q(2),
      ...(scope === "period" ? { period: { value: 1, unit: "d" } } : {}) }] } });
    const editable = structuredClone(fromDosageDetails(source));
    const row = editable.dosages[0];
    row.safety!.doseLimit![0].valueQuantity!.value = 3;
    const flat = scope === "administration" ? row.maxDosePerAdministration! :
      scope === "lifetime" ? row.maxDosePerLifetime! : row.maxDosePerPeriod![0].numerator!;
    flat.value = 4;
    expect(toDosageDetails(editable.dosages, undefined, editable.course).step![0].component[0].safety!.doseLimit![0].valueQuantity!.value).toBe(3);
  });

  it.each([false, true])("does not lend a historical offset to a replacement explicit component ID (site=%s)", withSite => {
    const old: FhirR6Dosage = { ...component, id: "A", timing: { repeat: {
      frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day, startOffset: { value: 2, unit: "h" },
    } }, ...(withSite ? { site: { concept: { text: "right eye" } } } : {}) };
    const marker: FhirExtension = { url: DOSAGE_DETAILS_R5_URL, extension: [{ url: "dosageDetails",
      extension: [encodeR6SourceMetadata("step", { component: [old] }, "step")] }] };
    for (const id of ["A", "B"]) {
      let rows: FhirDosage[] = [{ ...component, id, sequence: 1,
        timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day } },
        ...(withSite ? { site: { text: "right eye" } } : {}), modifierExtension: [marker] }];
      for (let save = 0; save <= 2; save++) {
        const wire = toDosageDetails(persist(rows));
        expect(wire.step![0].component[0].id).toBe(id);
        expect(wire.step![0].component[0].timing?.repeat?.startOffset).toEqual(id === "A" ? { value: 2, unit: "h" } : undefined);
        expect(JSON.stringify(wire)).toContain('"value":2,"unit":"h"');
        rows = toFhirR5Dosages(wire);
      }
    }
  });

  it.each(["change", "clear"] as const)("retains every displaced condition modifier on %s", edit => {
    const row: FhirDosage = { ...component };
    setDosageCondition(row, predicate(160));
    const first = { ...row.modifierExtension![0], id: "first-condition" };
    const second = { ...persist(first), id: "second-condition",
      extension: [...first.extension!, { url: "urn:test:condition-note", valueString: "second annotation" }] };
    row.modifierExtension = [first, second];
    setDosageCondition(row, edit === "change" ? predicate(180) : undefined);
    expect(getDosageCondition(row)).toEqual(edit === "change" ? predicate(180) : undefined);
    expect(row.modifierExtension?.filter(value => value.url === DOSAGE_CONDITION_R5_URL).length ?? 0).toBe(edit === "change" ? 1 : 0);
    const history = JSON.stringify(row.extension);
    expect(history).toContain("first-condition");
    expect(history).toContain("second-condition");
    expect(history).toContain("second annotation");
  });

  it.each([false, true])("invalidates explicit empty condition replay on a saved capped R5 row (warm=%s)", warm => {
    const raw: FhirDosage = { ...component, text: "Take 1 tablet daily if SBP > 160, maximum 2 tablets per administration",
      maxDosePerAdministration: q(2) };
    setDosageCondition(raw, predicate(160));
    const row = persist(toFhirR5Dosages([raw])[0]) as EzDosage;
    const options = { locale: "en", realizationMode: "roundtrip" as const };
    expect(formatSig(row, "long", options)).toContain("SBP");
    row.condition = [];
    const edited = warm ? row : persist(row);
    expect(getDosageCondition(edited)).toBeUndefined();
    expect(formatSig(edited, "long", options)).not.toContain("SBP");
    expect(formatSig(edited, "long", options)).toContain("1 tablet");
  });

  it.each(["replace", "clear", "same"] as const)("keeps superseded dose-rate policy children as inactive source on %s", edit => {
    const prior = { url: "urn:test:old-rate-policy", valueString: "old restriction" };
    const wrapper = { id: "rate-wrapper", url: R5_RATE_MODIFIERS_R6_URL, extension: [prior] };
    let rows = persist(toFhirR5Dosages(course({ doseAndRate: [{
      rateQuantity: { value: 5, unit: "mL/h" }, extension: [wrapper],
    }] })));
    const replacement = { url: "urn:test:new-rate-policy", valueString: "new restriction" };
    rows[0].doseAndRate![0].modifierExtension = edit === "replace" ? [replacement] : edit === "clear" ? [] : [prior];
    for (let save = 0; save <= 2; save++) {
      const wire = toDosageDetails(rows);
      const rate = wire.step![0].component[0].doseAndRate![0];
      const active = rate.extension?.filter(item => item.url === R5_RATE_MODIFIERS_R6_URL) ?? [];
      expect(active.length).toBe(edit === "clear" ? 0 : 1);
      if (edit !== "clear") expect(active[0]).toEqual({ ...wrapper, extension: edit === "same" ? [prior] : [replacement] });
      expect(JSON.stringify(rate.extension)).toContain("old restriction");
      if (edit === "same") expect(rate.extension).toEqual([wrapper]);
      rows = persist(toFhirR5Dosages(wire));
    }
  });


  it.each([false, true])("uses current PRN spatial target after a capped-row preview (warm=%s)", warm => {
    const location: FhirExtension = { url: "urn:ezmedicationinput:body-site-spatial-relation", extension: [
      { url: "relationText", valueString: "in" },
      { url: "target", valueCodeableConcept: { text: "right eye" } },
    ] };
    const raw: FhirDosage = { ...component, text: "Take 1 tablet daily as needed for headache in right eye, maximum 2 tablets per administration",
      asNeeded: true, asNeededFor: [{ coding: [{ system: "http://snomed.info/sct", code: "25064002", display: "Headache" }], extension: [location] }],
      maxDosePerAdministration: q(2) };
    const row = persist(toFhirR5Dosages([raw])[0]);
    const options = { locale: "en", realizationMode: "roundtrip" as const };
    expect(formatSig(row, "long", options)).toContain("right eye");
    row.asNeededFor![0].extension![0].extension![1].valueCodeableConcept!.text = "left eye";
    const preview = formatSig(warm ? row : persist(row), "long", options);
    expect(preview).toContain("left eye");
    expect(preview).not.toContain("right eye");
  });

  it.each(["less than or equal to", "equal to", "local exact wording"])("reconciles EMA equality with supplied display %s", display => {
    const old = { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000049", display };
    const source = { value: 2, unit: "mg", extension: [{ url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL, valueCoding: old }] };
    const wire = toDosageDetails([{ doseAndRate: [{ doseQuantity: source }] }]);
    const dose = wire.step![0].component[0].doseAndRate![0].doseQuantity!;
    const active = dose.extension!.find(item => item.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL)!;
    expect(active.valueCoding).toEqual({ ...old, display: display === "less than or equal to" ? "equal to" : display });
    if (display === "less than or equal to") expect(JSON.stringify(dose.extension)).toContain('"display":"less than or equal to"');
    else expect(dose.extension).toHaveLength(1);
  });

  it("restores the newest comparator primitive while retaining an older same-operator marker", () => {
    let wire = simpleQuantityForR5({ ...q(2), comparator: "~", _comparator: { id: "A" } })!;
    wire.extension!.find(item => item.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL)!.valueCoding!.code = "100000000052";
    const edited = quantityFromR5(wire)!;
    edited.comparator = "~";
    edited._comparator = { id: "B" };
    wire = simpleQuantityForR5(edited)!;
    for (let save = 0; save <= 2; save++) {
      const reopened = quantityFromR5(persist(wire))!;
      expect(reopened._comparator).toEqual({ id: "B" });
      expect(JSON.stringify(reopened.extension)).toContain('"id":"A"');
      wire = simpleQuantityForR5(reopened)!;
    }
  });
});


// Retained regression suite from test/pr14-round21-r5.spec.ts.
import round38_r521_retainedCourseProfile from "../fhir/r5/medication-r6-course-details.json";
import { describe as round38_r521_describe, expect as round38_r521_expect, it as round38_r521_it } from "vitest";
import { fromDosageDetails as round38_r521_fromDosageDetails, nextDueDoses as round38_r521_nextDueDoses, toDosageDetails as round38_r521_toDosageDetails, toEzDosages as round38_r521_toEzDosages, toFhirR5Dosages as round38_r521_toFhirR5Dosages, FhirPeriodUnit as round38_r521_FhirPeriodUnit, type EzDosage as round38_r521_EzDosage, type FhirDosage as round38_r521_FhirDosage, type FhirExtension as round38_r521_FhirExtension, type FhirR6DosageInstruction as round38_r521_FhirR6DosageInstruction, type FhirR6Quantity as round38_r521_FhirR6Quantity } from "../src/index";
import { DOSAGE_DETAILS_R5_URL as round38_r521_DOSAGE_DETAILS_R5_URL, DOSAGE_RECONCILIATION_SOURCE_URL as round38_r521_DOSAGE_RECONCILIATION_SOURCE_URL, R5_EXPRESSION_SLOT_SOURCE_URL as round38_r521_R5_EXPRESSION_SLOT_SOURCE_URL, decodeR5RetainedFields as round38_r521_decodeR5RetainedFields, encodeR5RetainedFields as round38_r521_encodeR5RetainedFields, encodeR6SourceMetadata as round38_r521_encodeR6SourceMetadata, decodeR6SourceMetadata as round38_r521_decodeR6SourceMetadata, dosageMatchesSavedProjection as round38_r521_dosageMatchesSavedProjection, withDosageEditProvenance as round38_r521_withDosageEditProvenance, fromR6Dosage as round38_r521_fromR6Dosage } from "../src/dosage-course";
import { EMA_QUANTITY_COMPARATOR_EXTENSION_URL as round38_r521_EMA_QUANTITY_COMPARATOR_EXTENSION_URL, EMA_QUANTITY_OPERATOR_SYSTEM as round38_r521_EMA_QUANTITY_OPERATOR_SYSTEM, getQuantityComparator as round38_r521_getQuantityComparator, quantityForR5 as round38_r521_quantityForR5, simpleQuantityForR5 as round38_r521_simpleQuantityForR5 } from "../src/fhir-quantity-operator";
import { COURSE_CYCLE_COUNT_EXTENSION_URL as round38_r521_COURSE_CYCLE_COUNT_EXTENSION_URL, getCourseCycleCount as round38_r521_getCourseCycleCount } from "../src/fhir-course-cycle-count";
import { administrationFromR5 as round38_r521_administrationFromR5, courseFromR6 as round38_r521_courseFromR6 } from "../src/adapters/canonical-course";
{
  const retainedCourseProfile = round38_r521_retainedCourseProfile;
  const describe = round38_r521_describe;
  const expect = round38_r521_expect;
  const it = round38_r521_it;
  const fromDosageDetails = round38_r521_fromDosageDetails;
  const nextDueDoses = round38_r521_nextDueDoses;
  const toDosageDetails = round38_r521_toDosageDetails;
  const toEzDosages = round38_r521_toEzDosages;
  const toFhirR5Dosages = round38_r521_toFhirR5Dosages;
  const FhirPeriodUnit = round38_r521_FhirPeriodUnit;
  type FhirPeriodUnit = round38_r521_FhirPeriodUnit;
  type EzDosage = round38_r521_EzDosage;
  type FhirDosage = round38_r521_FhirDosage;
  type FhirExtension = round38_r521_FhirExtension;
  type FhirR6DosageInstruction = round38_r521_FhirR6DosageInstruction;
  type FhirR6Quantity = round38_r521_FhirR6Quantity;
  const DOSAGE_DETAILS_R5_URL = round38_r521_DOSAGE_DETAILS_R5_URL;
  const DOSAGE_RECONCILIATION_SOURCE_URL = round38_r521_DOSAGE_RECONCILIATION_SOURCE_URL;
  const R5_EXPRESSION_SLOT_SOURCE_URL = round38_r521_R5_EXPRESSION_SLOT_SOURCE_URL;
  const decodeR5RetainedFields = round38_r521_decodeR5RetainedFields;
  const encodeR5RetainedFields = round38_r521_encodeR5RetainedFields;
  const encodeR6SourceMetadata = round38_r521_encodeR6SourceMetadata;
  const decodeR6SourceMetadata = round38_r521_decodeR6SourceMetadata;
  const dosageMatchesSavedProjection = round38_r521_dosageMatchesSavedProjection;
  const withDosageEditProvenance = round38_r521_withDosageEditProvenance;
  const fromR6Dosage = round38_r521_fromR6Dosage;
  const EMA_QUANTITY_COMPARATOR_EXTENSION_URL = round38_r521_EMA_QUANTITY_COMPARATOR_EXTENSION_URL;
  const EMA_QUANTITY_OPERATOR_SYSTEM = round38_r521_EMA_QUANTITY_OPERATOR_SYSTEM;
  const getQuantityComparator = round38_r521_getQuantityComparator;
  const quantityForR5 = round38_r521_quantityForR5;
  const simpleQuantityForR5 = round38_r521_simpleQuantityForR5;
  const COURSE_CYCLE_COUNT_EXTENSION_URL = round38_r521_COURSE_CYCLE_COUNT_EXTENSION_URL;
  const getCourseCycleCount = round38_r521_getCourseCycleCount;
  const administrationFromR5 = round38_r521_administrationFromR5;
  const courseFromR6 = round38_r521_courseFromR6;
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
    for (const field of actions) expect(field).toMatchObject({ type: [{ code: "string" }] });
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

  it.each(["timing", "repeat"] as const)("invalidates a saved replay proof when %s extensions are replaced", owner => {
    const row = withDosageEditProvenance<FhirDosage>([{
      ...persist(rowDose), timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
    }], "Take one tablet daily.")[0];
    expect(dosageMatchesSavedProjection(row)).toBe(true);
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
    const sourceExtensions: FhirExtension[] = [];
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
