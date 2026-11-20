import { describe, expect, it } from "vitest";
import {
  fromFhir, fromDosageDetails, toDosageDetails, toFhirR5Dosages, toEzDosages, formatSig,
  formatCanonicalCourse, nextDueDoses, formatSigBatch, suggestSig,
} from "../src/index";
import { courseToR6, courseToR5, importCanonicalCourse } from "../src/adapters/canonical-course";
import { getQuantityComparator, quantityForR5 as generalQuantityForR5 } from "../src/fhir-quantity-operator";
import { R6_DRAFT_STEPS_SOURCE_URL } from "../src/adapters/r6-editable-metadata";
import type { CanonicalCourse } from "../src/canonical/course";
import { FhirPeriodUnit, type FhirDosage, type FhirR6DosageInstruction, type FhirR6DosageSafety, type FhirR6DosageCondition, type FormatOptions, type FhirR6DoseLimit } from "../src/types";

import { TIMING_OFFSET_EXACT_EXTENSION_URL, TIMING_FREQUENCY_MIN_EXTENSION_URL } from "../src/fhir";
import { PARALLEL_COMPONENT_PHASE_ORIGIN_URL } from "../src/dosage-course";
import { getSuggestLocaleAdapter, registerSuggestLocaleAdapter } from "../src/suggest-locale-adapter";

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
    const before = persist(input);
    const saved = toDosageDetails(input);
    const current = saved.step[0].component[0].doseAndRate![0];
    expect(kind === "dose" ? current.doseQuantity : current.rateQuantity).toBeUndefined();
    expect(kind === "dose" ? current.doseExpression : current.rateExpression).toBeUndefined();
    expect(kind === "dose" ? current.rateQuantity!.value : current.doseQuantity!.value).toBe(kind === "dose" ? 5 : 3);
    const source = current.extension!.find(e => e.url === `urn:ezmedicationinput:r6-unresolved-${kind}-source`)!;
    expect(source.extension).toHaveLength(2);
    expect(source.extension!.find(child => child.url === kind + "Quantity")!.valueQuantity)
      .toEqual(kind === "dose" ? { value: 3, unit: "mg" } : { value: 5, unit: "mL/h" });
    expect(source.extension!.find(child => child.url === kind + "Expression")!.valueExpression).toEqual(expression);
    expect(() => fromFhir(saved)).not.toThrow();
    expect(toDosageDetails(persist(toFhirR5Dosages(saved))).step[0].component[0].doseAndRate![0]).toEqual(current);
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
    for (const timing of [courseToR5(native)[0].timing, courseToR6(native).step[0].component[0].timing]) {
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
      frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, offset: 30,
    } } }] }] };
    const native = importCanonicalCourse(input);
    for (const timing of [courseToR5(native)[0].timing, courseToR6(native).step[0].component[0].timing])
      expect(timing?.repeat).toMatchObject({ frequency: 1, offset: 30 });
  });

  it("keeps phase-origin Element metadata through edits and repeated version crossings", () => {
    const origin = { id: "origin-element", url: PARALLEL_COMPONENT_PHASE_ORIGIN_URL,
      valueQuantity: { id: "origin-quantity", value: 2, unit: "d", extension: [{ url: "urn:origin-note", valueString: "authored" }] } };
    const sibling = { id: "independent", url: "urn:other-modifier", valueString: "keep" };
    const input: FhirR6DosageInstruction = { step: [{ component: [{ ...dailyTablet(), modifierExtension: [origin, sibling] }] }] };
    const before = persist(input);
    const native = importCanonicalCourse(input);
    expect(courseToR6(native).step[0].component[0].modifierExtension).toEqual([origin, sibling]);
    const edited = persist(input);
    edited.step[0].component[0].modifierExtension![0].valueQuantity!.value = 3;
    const expected = edited.step[0].component[0].modifierExtension;
    let wire = edited;
    for (let pass = 0; pass < 3; pass++) {
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      expect(wire.step[0].component[0].modifierExtension).toEqual(expected);
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
        expect(text).toMatch(/(?:^|[^0-9])2\s*(?:tab|tablet|เม็ด)/u);
        expect(text).not.toMatch(/(?:^|[^0-9])1\s*(?:tab|tablet|เม็ด)/u);
      }
      const imported = fromFhir(input, options);
      for (const text of [imported.shortText, imported.longText, imported.items[0].shortText, imported.items[0].longText]) {
        expect(text).toMatch(/(?:^|[^0-9])2\s*(?:tab|tablet|เม็ด)/u);
        expect(text).not.toMatch(/(?:^|[^0-9])1\s*(?:tab|tablet|เม็ด)/u);
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
    for (const text of [formatSig(input, "long"), imported.longText, imported.items[0].longText]) {
      expect(text).toContain("2 mg");
      expect(text).toContain("5 mL/h");
      expect(text).not.toContain("1 mg");
      expect(text).not.toContain("4 mL/h");
    }
    expect(imported.fhirNext.step[0].component[0].text).toBe("Infuse 1 mg at 4 mL/h");
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
    expect(text).toMatch(/5.*10.*mL\/h/u);
    if (withDose) expect(text).toMatch(/2 mg; /u);
  });

  it("keeps cached PRN defaults intact across mutable extension callbacks", () => {
    const original = getSuggestLocaleAdapter("en");
    const direct: string[][] = [], defaults: string[][] = [];
    registerSuggestLocaleAdapter({ ...original, directPrnCompletion(_input, reasons) {
      direct.push([...reasons]);
      reasons.splice(0, reasons.length);
      return ["custom direction"];
    }, defaultDirections(_pairs, _limit, _lexeme, reasons) {
      const first = reasons(); defaults.push([...first]); first.splice(0, first.length);
      const second = reasons(); defaults.push([...second]);
      return ["custom direction"];
    } });
    try {
      suggestSig("prn", { locale: "en" }); suggestSig("prn", { locale: "en" });
      suggestSig("", { locale: "en" }); suggestSig("", { locale: "en" });
      expect(direct).toHaveLength(2);
      expect(direct[0].length).toBeGreaterThan(0);
      expect(direct[1]).toEqual(direct[0]);
      expect(defaults).toHaveLength(4);
      for (const reasons of defaults) expect(reasons).toEqual(direct[0]);
    } finally { registerSuggestLocaleAdapter(original); }
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
