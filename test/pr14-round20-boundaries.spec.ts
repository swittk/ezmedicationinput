import { describe, expect, it } from "vitest";
import {
  parseSig, formatSig, fromFhir, fromDosageDetails, toDosageDetails, toFhirR5Dosages,
  registerMedicationLocaleDetector, inferMedicationLocale,
  registerMedicationSurfaceSegmenter, listMedicationSurfaceSegmenters,
  registerMedicationDateResolver, cloneBodySiteSpatialRelation,
} from "../src/index";
import {
  importCanonicalCourse, courseFromR6, courseToR6, courseToR5,
} from "../src/adapters/canonical-course";
import { getQuantityComparator } from "../src/fhir-quantity-operator";
import {
  R6_DRAFT_STEPS_SOURCE_URL,
} from "../src/adapters/r6-editable-metadata";
import { FhirPeriodUnit, type EzCourseMetadata, type FhirR6DosageInstruction } from "../src/types";
import type { CanonicalCourse } from "../src/canonical/course";

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
    expect(wire.step[0].start).toEqual(treatment(2));
    expect(wire.extension?.some(e => e.url === R6_DRAFT_STEPS_SOURCE_URL)).toBe(true);
    expect(() => fromFhir(wire)).not.toThrow();
    const reopened = fromDosageDetails(JSON.parse(JSON.stringify(wire)));
    expect(reopened.course.step).toHaveLength(2);
    expect(reopened.course.step![1].start).toBeUndefined();
    reopened.course.step![0].end = treatment(5);
    expect(toDosageDetails(reopened.dosages, undefined, reopened.course).step[0].start).toEqual(treatment(5));
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
    expect(wire.step[0].safety).toBeUndefined();
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
    expect(fromFhir(wire).fhirNext.step[0].start).toEqual(start);
    expect(toDosageDetails(toFhirR5Dosages(wire)).step[0].start).toEqual(start);
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
    expect(toDosageDetails(strict).step).toEqual([]);
    expect(importCanonicalCourse({ text: "ordinary R5" }).stages[0].administrations[0].text).toBe("ordinary R5");
  });

  it("retains an entirely empty draft without fabricating an active component", () => {
    const native: CanonicalCourse = { kind: "course", stages: [{ administrations: [], end: {
      anchor: "treatment-start", displacement: { value: 3, unit: "d" },
    } }] };
    const wire = courseToR6(native);
    expect(wire.step).toEqual([]);
    expect(() => fromFhir(wire)).not.toThrow();
    expect(importCanonicalCourse(wire).stages[0].end?.displacement?.value).toBe(3);
  });

  it("retains condition wording when an unrelated R5 safety delta exists", () => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      ...tablet(), condition: [{ code: { text: "Only if tolerated" } }],
      safety: { doseLimit: [{ scope: "administration", valueQuantity: { value: 4, unit: "tab" } }] },
    }] }] };
    const projected = fromDosageDetails(source);
    expect(toDosageDetails(projected.dosages, undefined, projected.course).step[0].component[0].condition)
      .toEqual(source.step[0].component[0].condition);
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
    const wire = courseToR6(native), amounts = wire.step[0].component[0].doseAndRate!;
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
    const provider = { locale: "test-first", script: /[A]/u, segment: (input: string) => [{ segment: input, index: 0 }] };
    registerMedicationSurfaceSegmenter(provider);
    provider.locale = "test-second";
    provider.script = /[B]/u;
    registerMedicationSurfaceSegmenter(provider);
    const entries = listMedicationSurfaceSegmenters();
    expect(entries.find(e => e.locale === "test-first")?.script.source).toBe("[A]");
    expect(entries.find(e => e.locale === "test-second")?.script.source).toBe("[B]");
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
    expect(parsed.fhirNext.step[0].component[0].timing?.event).toEqual(["2026-09-28"]);
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
