import { simpleQuantityForR5 } from "../src/fhir-quantity-operator";
import { describe, expect, it } from "vitest";
import {
  fromFhir, fromFhirDosage, fromDosageDetails, toDosageDetails, toFhirR5Dosages, toEzDosages, formatSig,
  parseSig, registerMedicationLocaleDetector, inferMedicationLocale,
  registerMedicationSurfaceSegmenter, listMedicationSurfaceSegmenters,
  registerMedicationDateResolver, cloneBodySiteSpatialRelation,
  formatCanonicalCourse, nextDueDoses, formatSigBatch, suggestSig,
} from "../src/index";
import { courseFromR6, courseToR6, courseToR5, importCanonicalCourse } from "../src/adapters/canonical-course";
import { getQuantityComparator, quantityForR5 as generalQuantityForR5 } from "../src/fhir-quantity-operator";
import { R6_DRAFT_STEPS_SOURCE_URL, R6_SCOPED_SAFETY_MODIFIER_URL } from "../src/adapters/r6-editable-metadata";
import { numericAdministrationLimits, type CanonicalCourse } from "../src/canonical/course";
import { EventTiming, FhirPeriodUnit, type EzCourseMetadata, type FhirDosage, type FhirR6DosageInstruction, type FhirR6DosageSafety, type FhirR6DosageCondition, type FormatOptions, type FhirR6DoseLimit } from "../src/types";

import { TIMING_OFFSET_EXACT_EXTENSION_URL, TIMING_FREQUENCY_MIN_EXTENSION_URL, TIMING_ADDITIONAL_CLOCK_EXTENSION_URL, getTimingClocks } from "../src/fhir";
import { PARALLEL_COMPONENT_PHASE_ORIGIN_URL, decodeR6SourceMetadata } from "../src/dosage-course";
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
        expect(text).not.toMatch(/(?:^|[^0-9])1\s*(?:tab|tablet|เม็ด)/u);
      }
      const imported = fromFhir(input, options);
      for (const text of [imported.shortText, imported.longText, imported.items[0].shortText, imported.items[0].longText]) {
        expect(text.match(/(?:^|[^\p{L}\p{N}.,+\-])2\s*(?:tablets?|tabs?|เม็ด)(?![\p{L}\p{N}])/gu)).toHaveLength(1);
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
    for (const text of [formatSig(input, "short"), formatSig(input, "long"),
      imported.shortText, imported.longText, imported.items[0].shortText, imported.items[0].longText]) {
      expect(text).toMatch(/(?:^|[^0-9.])2\s*mg\b/u);
      expect(text).toMatch(/(?:^|[^0-9.])5\s*mL\/h\b/u);
      expect(text).not.toMatch(/(?:^|[^0-9.])1\s*mg\b/u);
      expect(text).not.toMatch(/(?:^|[^0-9.])4\s*mL\/h\b/u);
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
    for (const q of simple) {
      expect(q).not.toHaveProperty("comparator");
      expect(getQuantityComparator(q)).toBe(comparator);
    }
    expect(amounts[4].rateRatio!.numerator!.comparator).toBe(comparator);
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
  it.each([false, true])("uses a changed rate-only R5 amount after persisted=%s", persisted => {
    const source = "Infuse at 5 mL/h";
    const fresh = parseSig(source).fhir[0];
    const row = persisted ? persist(fresh) : fresh;
    expect(formatSig(row, "long", { locale: "en" })).toBe(source);
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

  it.each([false, true])("uses an independently changed R5 rate ratio after persisted=%s", persisted => {
    const source = "Infuse 120 mL over 2 hours";
    const fresh = parseSig(source).fhir[0], row = persisted ? persist(fresh) : fresh;
    expect(formatSig(row, "long", { locale: "en" })).toBe(source);
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
    expect(formatSig(authored, "long", { realizationMode: "roundtrip" })).toBe(authored.text);
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
    expect(parsed.meta.canonical.clauses[0].dose?.unit).toBe("mg");
    expect(parsed.meta.normalized.unit).toBe("mg");
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
      expect(text).toContain("500");
      expect(text).toContain("1 mg");
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
      expect(result.meta.canonical.clauses[0].dose).toEqual({ range: { low: 2, high: 5 }, unit: "mg" });
      expect(result.meta.normalized.unit).toBe("mg");
    }
    for (const input of [row, raw])
      expect(importCanonicalCourse(input).stages[0].administrations[0].amounts![0].range).toEqual(range);
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
