import { describe, expect, it } from "vitest";
import {
  fromDosageDetails, toDosageDetails, toFhirR5Dosages, formatSig, importCanonicalCourse,
  FhirPeriodUnit,
  type EzDosage, type FhirDosage, type FhirExtension, type FhirR6Dosage, type FhirR6DosageInstruction,
} from "../src/index";
import { canonicalFromFhir, canonicalToFhir, ANCHORED_COURSE_DURATION_EXTENSION_URL } from "../src/fhir";
import { COURSE_CYCLE_COUNT_EXTENSION_URL, getCourseCycleCount } from "../src/fhir-course-cycle-count";
import {
  simpleQuantityForR5, quantityForR5, quantityFromR5, getQuantityComparator,
  EMA_QUANTITY_COMPARATOR_EXTENSION_URL, EMA_QUANTITY_OPERATOR_SYSTEM,
} from "../src/fhir-quantity-operator";

import { DOSAGE_DETAILS_R5_URL, DOSAGE_RECONCILIATION_SOURCE_URL, decodeR5RetainedFields } from "../src/dosage-course";

const persisted = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const q = (value: number) => ({ value, unit: "tab" });
const course = (extras: Partial<FhirR6Dosage> = {}): FhirR6DosageInstruction => ({
  step: [{ component: [{
    doseAndRate: [{ doseQuantity: q(1) }],
    ...extras,
  }] }],
});

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
    const strict = persisted(toFhirR5Dosages(source));
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
    const edit = persisted(fromDosageDetails(source));
    edit.course.modifierExtension![0].valueInteger = 4;
    const changed = toDosageDetails(edit.dosages, undefined, edit.course);
    expect(getCourseCycleCount(changed)).toBe(4);
    expect(changed.step![0].count).toBe(2);
    const next = persisted(fromDosageDetails(changed));
    next.course.modifierExtension = [];
    const cleared = toDosageDetails(next.dosages, undefined, next.course);
    expect(getCourseCycleCount(cleared)).toBeUndefined();
    expect(importCanonicalCourse(cleared).cycleCount).toBeUndefined();
    expect(cleared.step![0].count).toBe(2);
    expect(getCourseCycleCount(toDosageDetails(persisted(toFhirR5Dosages(cleared)))))
      .toBeUndefined();
  });

  it("distinguishes an omitted step list from removal of a fieldless empty stage", () => {
    const wire = toDosageDetails([{ sequence: 2, doseAndRate: [{ doseQuantity: q(1) }] }],
      undefined, { step: [{ sequence: 1 }] });
    const edit = persisted(fromDosageDetails(wire));
    expect(edit.course.step).toContainEqual({ sequence: 1 });
    const omitted = { ...edit.course };
    delete omitted.step;
    expect(importCanonicalCourse(toDosageDetails(edit.dosages, undefined, omitted)).stages)
      .toHaveLength(2);
    edit.course.step = [];
    const removed = toDosageDetails(edit.dosages, undefined, edit.course);
    expect(importCanonicalCourse(removed).stages).toHaveLength(1);
    expect(importCanonicalCourse(toDosageDetails(persisted(toFhirR5Dosages(removed)))).stages)
      .toHaveLength(1);
  });

  it("removes the final metadata-only carrier stage without losing its raw annotations", () => {
    const wire = toDosageDetails([], undefined, { step: [{ sequence: 1, id: "draft",
      extension: [{ url: "urn:test:draft-source", valueString: "keep original" }] }] });
    const edit = persisted(fromDosageDetails(wire));
    edit.course.step = [];
    const removed = toDosageDetails(edit.dosages, undefined, edit.course);
    expect(removed.step).toBeUndefined();
    expect(importCanonicalCourse(removed).stages).toEqual([]);
    const annotation = { url: "urn:test:draft-source", valueString: "keep original" };
    expect(JSON.stringify(removed.extension)).toContain(JSON.stringify(annotation));
    const saved = persisted(fromDosageDetails(removed));
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
    const edit = persisted(fromDosageDetails(course({ safety })));
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
    const edit = persisted(fromDosageDetails(source));
    if (scope === "period") edit.dosages[0].maxDosePerPeriod![0].numerator!.value = 2;
    else edit.dosages[0].maxDosePerLifetime!.value = 2;
    const output = toDosageDetails(edit.dosages, undefined, edit.course);
    expect(output.step![0].component[0].safety!.doseLimit).toEqual([{
      scope, valueQuantity: q(2), ...(scope === "period" ? { period: { value: 1, unit: "d", code: "d" } } : {}),
    }]);
  });

  it("keeps an explicitly edited lifted safety value authoritative", () => {
    const edit = persisted(fromDosageDetails(course({
      safety: { doseLimit: [{ scope: "administration", valueQuantity: q(4) }] },
    })));
    edit.dosages[0].maxDosePerAdministration!.value = 2;
    edit.dosages[0].safety!.doseLimit![0].valueQuantity!.value = 3;
    const actual = toDosageDetails(edit.dosages, undefined, edit.course).step![0].component[0];
    expect(actual.safety!.doseLimit![0].valueQuantity!.value).toBe(3);
  });

  it("removes a deleted R5 maximum and preserves unrelated R6-only safety", () => {
    const edit = persisted(fromDosageDetails(course({
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

  it("keeps a persisted deletion of an editable expression distinct from a strict R5 omission", () => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseExpression: { expression: "%dose" }, rateExpression: { expression: "%rate" } }],
    }] }] };
    const edit = persisted(fromDosageDetails(source));
    delete edit.dosages[0].doseAndRate![0].doseExpression;
    const reopened = toDosageDetails(persisted(edit.dosages), undefined, edit.course);
    expect(reopened.step![0].component[0].doseAndRate![0].doseExpression).toBeUndefined();
    expect(reopened.step![0].component[0].doseAndRate![0].rateExpression!.expression).toBe("%rate");
    const strict = toDosageDetails(persisted(toFhirR5Dosages(source)));
    expect(strict.step![0].component[0].doseAndRate![0].doseExpression!.expression).toBe("%dose");
  });

  it("does not combine stale row text with a current text-only edit", () => {
    const edit = persisted(fromDosageDetails({
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
    const edit = persisted(fromDosageDetails({
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
    const changed = persisted(rows);
    // Changing the live period retires offsets tied to its old window.
    changed[0].timing!.repeat!.period = 2;
    const output = toFhirR5Dosages(changed);
    expect(toDosageDetails(output).step![0].component[0].timing!.repeat!.startOffset).toBeUndefined();
    // Returning to the earlier cadence later must not revive a retired marker.
    output[0].timing!.repeat!.period = 1;
    const next = toDosageDetails(persisted(output)).step![0].component[0];
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
    const reopened = toDosageDetails(persisted(toFhirR5Dosages(source)));
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
