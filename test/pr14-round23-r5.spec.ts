import { describe, expect, it } from "vitest";
import {
  fromDosageDetails, fromFhirDosage, toDosageDetails, toFhirR5Dosages, parseSig, formatSig, importCanonicalCourse, projectCanonicalCourse,
  type FhirDosage, type FhirExtension, type FhirRatio, type FhirR6Dosage,
  FhirPeriodUnit, FhirDayOfWeek, nextDueDoses, calculateTotalUnits,
  type FhirR6DosageInstruction, type FhirR6Quantity, type FhirR6DosageInstructionInput,
  type FhirR6DosageCondition, type FhirR6Timing, type FhirR6DosageStep,
} from "../src/index";
import {
  DOSAGE_CONDITION_R5_URL, DOSAGE_RECONCILIATION_SOURCE_URL, DOSAGE_RENDERED_INSTRUCTION_R5_URL,
  setDosageCondition, toEzDosages, isExactConditionBridge, DOSAGE_DETAILS_R5_URL, decodeR5RetainedFields,
  decodeR6SourceMetadata, encodeR6SourceMetadata, readRetainedField, withDosageEditProvenance, isRenderedInstructionMarker,
  PARALLEL_COMPONENT_PHASE_ORIGIN_URL, DOSAGE_ALTERNATIVE_CHOICE_URL, setDosageAlternativeChoice,
  DOSAGE_EXCLUDED_DATES_R5_URL, DOSAGE_EXCLUDED_WEEKDAYS_R5_URL,
  setDosageExcludedDates, setDosageExcludedWeekdays,
  captureSourceReplayTiming, matchesSourceReplayTiming, dosageMatchesSavedProjection,
} from "../src/dosage-course";
import {
  EMA_QUANTITY_COMPARATOR_EXTENSION_URL, EMA_QUANTITY_OPERATOR_SYSTEM,
  simpleQuantityForR5, quantityForR5, getQuantityComparator,
} from "../src/fhir-quantity-operator";
import {
  TIMING_OFFSET_MIN_EXTENSION_URL, TIMING_OFFSET_MAX_EXTENSION_URL,
  TIMING_OFFSET_EXACT_EXTENSION_URL, TIMING_FREQUENCY_MIN_EXTENSION_URL, TIMING_DAY_OF_MONTH_EXTENSION_URL,
  canonicalFromFhir, canonicalToFhir, TIMING_ACTIVITY_WINDOW_EXTENSION_URL,
  CYCLE_DAY_ELIGIBILITY_EXTENSION_URL, ANCHORED_COURSE_DURATION_EXTENSION_URL,
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
    expect(toFhirR5Dosages(output)[0].doseAndRate![0].rateRatio!.numerator!.extension).toContainEqual(approximate);
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
    expect(rows[0][field]?.value).toBe(6);
    delete rows[0][field];
    let output = toDosageDetails(rows);
    for (let save = 0; save < 3; save++) {
      expect(output.step![0].component[0].safety?.doseLimit).toEqual([first]);
      const reopened = persist(toFhirR5Dosages(output));
      expect(reopened[0][field]).toEqual(q(4));
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


describe("round25 duration Range units remain lawful and lossless", () => {
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
  it("keeps elapsed lower and calendar upper endpoints through strict R5/R6 saves across DST", () => {
    let row = persist(canonicalToFhir(canonicalFromFhir(source())));
    const options = { from: "2026-03-07T00:00:00-05:00", orderedAt: "2026-03-07T00:00:00-05:00",
      timeZone: "America/New_York", limit: 10 };
    const expected = ["2026-03-07T00:30:00-05:00", "2026-03-08T00:30:00-05:00", "2026-03-09T00:30:00-04:00"];
    for (let save = 0; save < 3; save++) {
      const range = row.timing!.repeat!.boundsRange!;
      expect(range.low).toMatchObject({ value: 2, unit: "days", code: "d" });
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
      value.url === "urn:ezmedicationinput:StructureDefinition:medication-anchored-course-duration")).toBe(true);
    expect(JSON.stringify(changed)).toContain('"value":48');
  });
  it("keeps both authored units in a valid typed anchored-duration modifier", () => {
    const clause = canonicalFromFhir(source());
    clause.schedule!.boundsStart = "2026-03-07T00:00:00-05:00";
    const row = persist(canonicalToFhir(clause));
    expect(row.timing!.repeat!.boundsPeriod?.start).toBe("2026-03-07T00:00:00-05:00");
    expect(row.timing!.repeat!.boundsRange).toBeUndefined();
    const marker = row.modifierExtension!.find(value =>
      value.url === "urn:ezmedicationinput:StructureDefinition:medication-anchored-course-duration")!;
    expect(marker.valueRange).toBeUndefined();
    expect(marker.extension).toContainEqual({ url: "low", valueQuantity: {
      value: 48, unit: "hours", system: "http://unitsofmeasure.org", code: "h",
    } });
    expect(marker.extension).toContainEqual({ url: "high", valueQuantity: {
      value: 3, unit: "days", system: "http://unitsofmeasure.org", code: "d",
    } });
    const restored = canonicalFromFhir(persist(toFhirR5Dosages(toDosageDetails([row]))[0]));
    expect(restored.schedule).toMatchObject({ duration: 48, durationUnit: FhirPeriodUnit.Hour,
      durationMax: 3, durationMaxUnit: FhirPeriodUnit.Day });
  });
  it("retains month/day endpoints without an average month conversion or fabricated upper bound", () => {
    const row = persist(canonicalToFhir(canonicalFromFhir(source(
      { value: 1, unit: "month", code: "mo" }, { value: 40, unit: "days", code: "d" },
    ))));
    expect(row.timing!.repeat!.boundsRange?.low).toBeUndefined();
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
    expect(range.low).toMatchObject({ value: 1, unit: "days", code: "d" });
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

  it("retains a nonprojectable lower duration when only the upper month bound changes", () => {
    let row = persist(canonicalToFhir(canonicalFromFhir(durationRow(
      { value: 3, unit: "weeks", code: "wk" }, { value: 1, unit: "month", code: "mo" },
    ))));
    expect(row.timing!.repeat!.boundsRange!.low).toBeUndefined();
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
    row.timing!.repeat!.boundsRange!.low!.value = 2.5;
    expect(canonicalFromFhir(row as FhirDosage).schedule).toMatchObject({ duration: 2.5,
      durationUnit: FhirPeriodUnit.Day, durationMax: 3, durationMaxUnit: FhirPeriodUnit.Day });
    expect(importCanonicalCourse(row as FhirDosage).stages[0].administrations[0].schedule?.recurrence?.courseLengthRange)
      .toMatchObject({ low: { value: 2.5, code: "d" }, high: { value: 3, code: "d" } });
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
      expect(range.low).toMatchObject({ value: 2, unit: "days", code: "d", _system: { id: "same-ucum-system" } });
      expect(range.low!._unit).toBeUndefined();
      expect(range.low!._code).toBeUndefined();
      expect(range.high).toEqual(high);
      const source = row.modifierExtension!.find(item => item.url.endsWith("medication-anchored-course-duration"))!;
      expect(source.extension).toContainEqual({ url: "low", valueQuantity: low });
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
      expect(fromDosageDetails(current).course.safety!.doseLimit).toEqual(stepSafety.doseLimit);
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
    const retired = current.safety!.extension!.find(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL)!
      .extension!.find(item => item.url === R6_SCOPED_SAFETY_MODIFIER_URL)!;
    expect(decodeR6SourceMetadata(retired, "safety")).toEqual({ course: courseSafety, step: stepSafety });
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
      const before = JSON.stringify(rows);
      const restored = importCanonicalCourse(persist(rows));
      const members: (typeof restored.stages)[number]["administrations"] = [];
      for (const stage of restored.stages) members.push(...stage.administrations);
      expect(members.find(member => member.stageOrdinal === 3)).toMatchObject({
        stageOrdinal: 3, amounts: [{ quantity: { value: 3 } }], target: { text: "Right eye" }
      });
      expect(members.find(member => member.stageOrdinal === 4)).toMatchObject({
        stageOrdinal: 4, amounts: [{ quantity: { value: 4 } }], target: { text: "Left eye" }
      });
      expect(JSON.stringify(rows)).toBe(before);
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
    const source = row.modifierExtension!.find(item => item.url === ANCHORED_COURSE_DURATION_EXTENSION_URL)!;
    row.timing!.repeat!.boundsRange!.high!.value = 4;
    expect(source.extension!.find(item => item.url === "high")!.valueQuantity!.value).toBe(3);
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
