import { describe, expect, it } from "vitest";
import {
  fromFhir, fromDosageDetails, toDosageDetails, toFhirR5Dosages, toEzDosages, formatSig,
  formatCanonicalCourse, nextDueDoses,
} from "../src/index";
import { courseToR6, courseToR5, importCanonicalCourse } from "../src/adapters/canonical-course";
import { getQuantityComparator, quantityForR5 as generalQuantityForR5 } from "../src/fhir-quantity-operator";
import { R6_DRAFT_STEPS_SOURCE_URL } from "../src/adapters/r6-editable-metadata";
import type { CanonicalCourse } from "../src/canonical/course";
import { FhirPeriodUnit, type FhirDosage, type FhirR6DosageInstruction, type FhirR6DosageSafety, type FhirR6DosageCondition } from "../src/types";

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
    else if (scope === "step") { input.step[0].safety = safety; input.step.push({ component: [tablet()] }); }
    else input.step[0].component[0].safety = safety;
    const read = (wire: FhirR6DosageInstruction) => scope === "course" ? wire.safety :
      scope === "step" ? wire.step[0].safety : wire.step[0].component[0].safety;
    for (const wire of [fromFhir(input).fhirNext, toDosageDetails(persist(toFhirR5Dosages(input)))]) {
      expect(read(wire)).toEqual(safety);
      expect(read(wire)!.doseLimit![0].valueInteger).toBeUndefined();
      expect(wire.step[0].component[0].doseAndRate![0].doseQuantity!.value).toBe(1);
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
    expect(fromFhir(source).fhirNext.step[0].start).toEqual(start);
    const restored = toDosageDetails(persist(toFhirR5Dosages(source)));
    expect(restored.step[0].start).toEqual(start);
    expect(() => nextDueDoses(restored, { from: "2026-01-01T00:00:00Z", orderedAt: "2026-01-01T00:00:00Z", timeZone: "UTC", limit: 2 })).toThrow(/Unsupported.*RelativeTime/);
  });

  it("uses current cyclic dose values in normalized previews while retaining authored wording", () => {
    const source: FhirR6DosageInstruction = { renderedInstruction: "Take 1 tablet daily", repeatCycle: { value: 7, unit: "d" },
      step: [{ component: [{ ...tablet(), timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } } }] }] };
    source.step[0].component[0].doseAndRate![0].doseQuantity!.value = 2;
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
    expect(getQuantityComparator(wire.step[0].component[0].doseAndRate![0].doseQuantity)).toBe(comparator);
    expect(courseToR6(reopened)).toEqual(wire);
  });

  it("keeps obsolete draft source inert after a live dose edit across repeated saves", () => {
    const native: CanonicalCourse = { kind: "course", stages: [
      { provenance: { id: "unmatched-draft-note" }, end: boundary, administrations: [] },
      { administrations: [{ kind: "administration", amounts: [{ quantity: { value: 1, unit: "tab" } }] }] },
    ] };
    let wire = persist(courseToR6(native));
    wire.step[0].component[0].doseAndRate![0].doseQuantity!.value = 2;
    wire = courseToR6(importCanonicalCourse(wire));
    expect(wire.extension?.some(e => e.url === R6_DRAFT_STEPS_SOURCE_URL)).not.toBe(true);
    expect(JSON.stringify(wire)).toContain("unmatched-draft-note");
    for (let round = 0; round < 3; round++) {
      const restored = fromDosageDetails(persist(wire));
      expect(restored.course.step).toHaveLength(1);
      const saved = toDosageDetails(persist(toFhirR5Dosages(wire)));
      expect(JSON.stringify(saved)).toContain("unmatched-draft-note");
      expect(importCanonicalCourse(saved).stages).toHaveLength(1);
      expect(saved.step[0].component[0].doseAndRate![0].doseQuantity!.value).toBe(2);
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
    expect(toDosageDetails(persist(toFhirR5Dosages(source))).step[0].component[0].condition).toEqual([condition]);
  });

  it("keeps R5 maximum Ratio metadata when numerical values are edited", () => {
    const ratio = { id: "maximum-ratio", extension: [{ url: "urn:test:ratio-note", valueString: "retain" }],
      numerator: { value: 4, unit: "tab" }, denominator: { value: 1, unit: "d" } };
    const source: FhirDosage = { ...tablet(), maxDosePerPeriod: [ratio] };
    const native = importCanonicalCourse(source);
    native.stages[0].administrations[0].limits![0].amount!.value = 3;
    const r5 = courseToR5(native);
    expect(r5[0].maxDosePerPeriod?.[0]).toEqual({ ...ratio, numerator: { value: 3, unit: "tab" } });
    const r6 = courseToR6(native);
    expect(r6.step[0].component[0].safety!.doseLimit![0]).not.toHaveProperty("numerator");
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
    wire.step[0].component[0].doseAndRate![0].doseQuantity!.value = 2;
    wire = courseToR6(importCanonicalCourse(persist(wire)));
    expect(importCanonicalCourse(wire).stages).toHaveLength(1);
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
    for (const amount of [first.step[0].component[0].doseAndRate![0],
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
    const saved = toDosageDetails(input);
    const current = saved.step[0].component[0].doseAndRate![0];
    expect(kind === "dose" ? current.doseQuantity : current.rateQuantity).toBeUndefined();
    expect(kind === "dose" ? current.doseExpression : current.rateExpression).toBeUndefined();
    expect(kind === "dose" ? current.rateQuantity!.value : current.doseQuantity!.value).toBe(kind === "dose" ? 5 : 3);
    const source = current.extension!.find(e => e.url === `urn:ezmedicationinput:r6-unresolved-${kind}-source`)!;
    expect(source.extension).toHaveLength(2);
    expect(source.extension![1].valueExpression).toEqual(expression);
    expect(() => fromFhir(saved)).not.toThrow();
    expect(toDosageDetails(persist(toFhirR5Dosages(saved))).step[0].component[0].doseAndRate![0]).toEqual(current);
    expect(input[0].doseAndRate[0]).toEqual(amount);
  });
});
