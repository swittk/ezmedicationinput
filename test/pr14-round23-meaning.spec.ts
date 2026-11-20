import { describe, expect, it } from "vitest";
import {
  parseSig, formatSig, toDosageDetails, toFhirR5Dosages,
  registerMedicationDateResolver
} from "../src/index";
import { formatCanonicalClause } from "../src/format";
import { formatCanonicalCourse } from "../src/canonical/format-course";
import { administrationFromClause, clauseForAdministration } from "../src/canonical/compile";
import { courseFromR6, courseToR6 } from "../src/adapters/canonical-course";
import type { CanonicalCourse, CanonicalBoundary } from "../src/canonical/course";
import { canonicalFromFhir, canonicalToFhir, parserStateFromFhir } from "../src/fhir";
import { getQuantityComparator, simpleQuantityForR5 } from "../src/fhir-quantity-operator";
import { resolveSigLocalization, type SigFormatContext } from "../src/i18n";
import { parseInstructionActions, realizeInstructionAction } from "../src/instruction-graph";
import {
  inferMedicationLocale, registerMedicationLocaleDetector,
  type MedicationLocaleDetector
} from "../src/locale-detection";
import {
  listMedicationSurfaceSegmenters, registerMedicationSurfaceSegmenter,
  splitMedicationScriptRuns, type MedicationSurfaceSegmenter
} from "../src/lexer/surface-segmenter";
import {
  AdviceArgumentRole, AdviceRelation,
  type FhirDosage, type FhirR6DosageInstruction, type ParseOptions,
  type MedicationDateResolver
} from "../src/types";

describe("round 23: language provider callable contracts", () => {
  it("retains class detector methods and private receivers while snapshotting registration priority", () => {
    class Detector implements MedicationLocaleDetector {
      #marker = "__round23_class_locale__";
      constructor(public locale: string, public priority: number) {}
      test(text: string) { return text === this.#marker; }
    }
    const first = new Detector("classlocalea", 901);
    const second = new Detector("classlocaleb", 900);
    registerMedicationLocaleDetector(first);
    registerMedicationLocaleDetector(second);
    expect(inferMedicationLocale("ordinary English")).toBe("en");
    expect(inferMedicationLocale("__round23_class_locale__")).toBe("classlocalea");
    first.priority = 899;
    expect(inferMedicationLocale("__round23_class_locale__")).toBe("classlocalea");
    registerMedicationLocaleDetector(first);
    expect(inferMedicationLocale("__round23_class_locale__")).toBe("classlocaleb");
    expect(parseSig("Take 1 tablet daily").meta.canonical.clauses[0].dose)
      .toMatchObject({ value: 1, unit: "tab" });
  });

  it("retains class surface segmentation and normalizes only stateful script matching", () => {
    class Segmenter implements MedicationSurfaceSegmenter {
      locale = "round23-segment";
      script = /[ⴰⴱ]/gu;
      #size = 1;
      *segment(input: string) {
        for (let index = 0; index < input.length; index += this.#size)
          yield { segment: input.slice(index, index + this.#size), index };
      }
    }
    registerMedicationSurfaceSegmenter(new Segmenter());
    const registered = listMedicationSurfaceSegmenters().find(s => s.locale === "round23-segment")!;
    expect([...registered.segment("ⴰⴱ")]).toEqual([
      { segment: "ⴰ", index: 0 }, { segment: "ⴱ", index: 1 }
    ]);
    expect(registered.script.global).toBe(false);
    expect(splitMedicationScriptRuns("AⴰⴱB").map(run => run.text)).toEqual(["A", "ⴰⴱ", "B"]);
  });

  it("retains both class calendar resolver methods through explicit and inferred years", () => {
    class Calendar implements MedicationDateResolver {
      id = "round23-class-calendar";
      #offset = 1000;
      resolveYear(year: number, digits: number) {
        return digits === 4 && year >= 3000
          ? { isoYear: year - this.#offset, calendarYear: year, inferredYear: false }
          : undefined;
      }
      calendarYearFromIsoYear(year: number) { return year + this.#offset; }
    }
    registerMedicationDateResolver(new Calendar());
    for (const source of ["28/9/3026", "28/9"]) {
      const parsed = parseSig("Take 1 tablet on " + source, {
        datePolicy: { calendars: ["round23-class-calendar"], referenceDate: "2026-09-01" }
      });
      expect(parsed.fhirNext.step[0].component[0].timing?.event).toEqual(["2026-09-28"]);
      expect(parsed.meta.canonical.clauses[0].schedule?.calendarEvents?.[0])
        .toMatchObject({ calendar: "round23-class-calendar", calendarYear: 3026 });
    }
  });

  it("forwards the same request action vocabulary to short and long language callbacks", () => {
    const clause = parseSig("Take 1 tablet daily").meta.canonical.clauses[0];
    const instructionActionMap: ParseOptions["instructionActionMap"] = {
      custom: { code: "custom", display: "Custom action", semanticClass: "procedure" }
    };
    const contexts: SigFormatContext[] = [];
    const callback = (context: SigFormatContext) => {
      contexts.push(context);
      return context.instructionActionMap?.custom.display ?? "No custom action";
    };
    const localization = { locale: "round23-custom", formatShort: callback, formatLong: callback };
    for (const style of ["short", "long"] as const) {
      expect(formatCanonicalClause(clause, style, localization, { instructionActionMap }))
        .toBe("Custom action");
      expect(contexts[contexts.length - 1]?.instructionActionMap).toBe(instructionActionMap);
      expect(formatCanonicalClause(clause, style, localization)).toBe("No custom action");
      expect(contexts[contexts.length - 1]?.instructionActionMap).toBeUndefined();
    }
  });
});

describe("round 23: qualified unit ellipsis remains a typed dose continuation", () => {
  it.each([
    ["≤1", "<="], ["at most one", "<="], ["approximately 1", "~"],
    [">=1", ">="], [">1", ">"], ["<1", "<"], ["1", undefined]
  ] as const)("retains %s in its own later phase with the inherited tablet unit", (amount, comparator) => {
    const input = `Take 2 tablets daily for 3 days, then ${amount} daily`;
    const parsed = parseSig(input);
    expect(parsed.meta.canonical.clauses).toHaveLength(2);
    expect(parsed.meta.canonical.clauses[0].dose).toMatchObject({ value: 2, unit: "tab" });
    expect(parsed.meta.canonical.clauses[1].dose).toMatchObject({ value: 1, unit: "tab" });
    expect(parsed.meta.canonical.clauses[1].dose?.comparator).toBe(comparator);
    expect(parsed.fhirNext.step).toHaveLength(2);
    const reopened = toDosageDetails(JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext))));
    const dose = reopened.step[1].component[0].doseAndRate?.[0].doseQuantity;
    expect(dose).toMatchObject({ value: 1, unit: "tab" });
    expect(getQuantityComparator(dose)).toBe(comparator);
    expect(parsed.input).toBe(input);
  });

  it("keeps explicit morning and night anchors in the same day despite a unitless qualifier", () => {
    const parsed = parseSig("Take 2 tablets every morning, then ≤1 at night");
    expect(parsed.fhirNext.step).toHaveLength(1);
    expect(parsed.fhirNext.step[0].component).toHaveLength(2);
    expect(parsed.meta.canonical.clauses[1].dose).toMatchObject({
      value: 1, unit: "tab", comparator: "<="
    });
  });

  it("does not infer a dose from comparative duration nouns or unrecognized objects", () => {
    for (const input of ["approximately 3 weeks", "approximately one week", "at most one symptom"]) {
      const parsed = parseSig(input);
      expect(parsed.fhir[0].doseAndRate?.[0]?.doseQuantity).toBeUndefined();
      expect(parsed.input).toBe(input);
    }
    const standalone = parseSig("≤1 daily").meta.canonical.clauses[0].dose;
    expect(standalone).toMatchObject({ value: 1, comparator: "<=" });
    expect(standalone?.unit).toBeUndefined();
  });
});

describe("round 23: material and relational complement have independent owners", () => {
  const options: ParseOptions = {
    instructionActionMap: {
      dilute: {
        code: "dilute", display: "Dilute", i18n: { th: "เจือจาง" },
        semanticClass: "procedure", procedural: true, acceptsAmount: true, definesDose: true,
        argumentParser: "amount-material-destination", realizer: "amount-material-destination"
      }
    },
    instructionConceptMap: {
      saline: {
        code: "saline", display: "saline", role: AdviceArgumentRole.Substance,
        i18n: { th: "น้ำเกลือ" }
      }
    }
  };

  it("retains both Substance nouns, their source, and the WITH target across wire formats", () => {
    const input = "Dilute 5 mL saline with water";
    const parsed = parseSig(input, options);
    const action = parsed.meta.canonical.clauses[0].instructionGraph!.actions[0];
    const nouns = action.args.filter(arg => arg.role === AdviceArgumentRole.Substance);
    expect(nouns.map(arg => [arg.text, arg.relation])).toEqual([
      ["saline", undefined], ["water", AdviceRelation.With]
    ]);
    const source = JSON.stringify(action);
    const r5 = toFhirR5Dosages(parsed.fhirNext);
    for (const wire of [parsed.fhirNext, r5[0], toDosageDetails(r5)]) {
      expect(formatSig(wire, "long", { locale: "en", realizationMode: "normalized" }))
        .toContain("saline with water");
      const thai = formatSig(wire, "long", { locale: "th", realizationMode: "normalized" });
      expect(thai).toContain("น้ำเกลือ");
      expect(thai).toContain("พร้อมน้ำ");
    }
    expect(JSON.stringify(action)).toBe(source);
    expect(parsed.input).toBe(input);
  });

  it("keeps material and target when a dose edit removes the Amount daughter", () => {
    const frame = parseInstructionActions("Dilute 5 mL saline with water", 0, options)[0];
    frame.args = frame.args.filter(arg => arg.role !== AdviceArgumentRole.Amount);
    expect(realizeInstructionAction(frame, "en")).toBe("Dilute saline with water");
    const thai = realizeInstructionAction(frame, "th");
    expect(thai).toContain("น้ำเกลือ");
    expect(thai).toContain("พร้อมน้ำ");
  });
});

describe("round 23: duration endpoints retain their own units", () => {
  it.each([[30, 2], [2, 2]])("renders %s minutes to %s hours without changing either endpoint", (low, high) => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { boundsRange: {
        low: { value: low, code: "min", unit: "minutes" },
        high: { value: high, code: "h", unit: "hours" }
      } } }
    }] }] };
    const course = courseFromR6(raw);
    const original = JSON.stringify(course);
    const administration = course.stages[0].administrations[0];
    const clause = clauseForAdministration(administration);
    expect(clause.schedule).toMatchObject({
      duration: low, durationUnit: "min", durationMax: high, durationMaxUnit: "h"
    });
    expect(administrationFromClause(clause).schedule?.recurrence?.courseLengthRange)
      .toMatchObject({ low: { value: low, unit: "min" }, high: { value: high, unit: "h" } });
    expect(formatCanonicalCourse(course, "long", { locale: "en" }))
      .toContain(`${low} minutes to ${high} hours`);
    expect(formatCanonicalCourse(course, "long", { locale: "th" }))
      .toContain(`${low} นาที ถึง ${high} ชั่วโมง`);
    for (const locale of ["en", "th"])
      expect(formatCanonicalCourse(course, "short", { locale })).toContain(`x${low}min-${high}h`);
    expect(courseToR6(course).step[0].component[0].timing?.repeat?.boundsRange)
      .toEqual(raw.step[0].component[0].timing?.repeat?.boundsRange);
    expect(JSON.stringify(course)).toBe(original);
  });

  it("retains endpoint units and qualifiers through the legacy clause and parser-state boundaries", () => {
    const input: FhirDosage = { timing: { repeat: { boundsRange: {
      low: simpleQuantityForR5({ value: 30, unit: "min", code: "min", comparator: ">=" })!,
      high: simpleQuantityForR5({ value: 2, unit: "h", code: "h", comparator: "<=" })!
    } } } };
    const clause = canonicalFromFhir(input);
    const state = parserStateFromFhir(input);
    expect(state.primaryClause.schedule).toMatchObject({
      duration: 30, durationUnit: "min", durationMax: 2, durationMaxUnit: "h",
      durationComparator: ">=", durationMaxComparator: "<="
    });
    expect(formatCanonicalClause(clause, "long"))
      .toContain(">=30 minutes to <=2 hours");
    expect(formatCanonicalClause(clause, "long", resolveSigLocalization("th")))
      .toContain(">=30 นาที ถึง <=2 ชั่วโมง");
    const roundtrip = canonicalToFhir(clause).timing?.repeat?.boundsRange;
    expect(roundtrip?.low).toMatchObject({ value: 30, code: "min" });
    expect(roundtrip?.high).toMatchObject({ value: 2, code: "h" });
    expect(getQuantityComparator(roundtrip?.low)).toBe(">=");
    expect(getQuantityComparator(roundtrip?.high)).toBe("<=");
  });
});

describe("round 23: no-dose gaps include repeated stage coverage", () => {
  const boundary = (value: number, unit = "d"): CanonicalBoundary => ({
    anchor: "treatment-start", displacement: { value, unit }
  });
  const course = (count: number): CanonicalCourse => ({
    kind: "course", stages: [
      { end: boundary(1), count, administrations: [{ kind: "administration", amounts: [{ quantity: { value: 1, unit: "tab" } }] }] },
      { start: boundary(3), end: boundary(4), administrations: [{ kind: "administration", amounts: [{ quantity: { value: 2, unit: "tab" } }] }] }
    ]
  });

  it("leaves only day 3 empty after a one-day stage repeated twice", () => {
    const source = course(2), before = JSON.stringify(source);
    const english = formatCanonicalCourse(source, "long", { locale: "en" });
    expect(english).toContain("Days 1–1; for 2 cycles");
    expect(english).toContain("No doses on days 3–3");
    expect(english).not.toContain("No doses on days 2");
    const thai = formatCanonicalCourse(source, "long", { locale: "th" });
    expect(thai).toContain("งดยาในวันที่ 3–3");
    expect(thai).not.toContain("งดยาในวันที่ 2");
    expect(JSON.stringify(source)).toBe(before);
  });

  it("uses the completed repetitions as the implicit next-stage start and unions overlap", () => {
    const implicit = course(2);
    delete implicit.stages[1].start;
    implicit.stages[1].end = boundary(3);
    const text = formatCanonicalCourse(implicit, "long", { locale: "en" });
    expect(text).toContain("Days 3–3");
    expect(text).not.toContain("No doses");
    expect(formatCanonicalCourse(course(4), "long", { locale: "en" })).not.toContain("No doses");
  });

  it("keeps unresolved local repetition visible without asserting a global medication-free gap", () => {
    const unknownDuration = course(2);
    unknownDuration.stages[0].end = boundary(1, "mo");
    for (const source of [course(0), course(1.5), unknownDuration]) {
      expect(formatCanonicalCourse(source, "long", { locale: "en" })).not.toContain("No doses");
      expect(formatCanonicalCourse(source, "long", { locale: "th" })).not.toContain("งดยา");
    }
  });

  it("uses an optional separator only between generated course stages", () => {
    const source = course(2);
    const joined = formatCanonicalCourse(source, "long", { locale: "en", separator: " | " });
    expect(joined).toContain(" | Days 4–4");
    expect(joined).toContain(" | No doses on days 3–3");
    const textOnly: CanonicalCourse = { kind: "course", instruction: "Keep this exact instruction.", stages: [] };
    expect(formatCanonicalCourse(textOnly, "long", { separator: " | " })).toBe(textOnly.instruction);
  });
});

describe("round 23: authored Thai PRN wording precedes terminology fallback", () => {
  it("keeps registered Thai condition wording for ordinary fever and coordinated reasons", () => {
    for (const [input, expected] of [
      ["1 tab PRN fever", "ใช้เมื่อมีไข้"],
      ["Take 1 tablet PRN pain or fever", "ใช้เมื่อปวดหรือมีไข้"],
      ["Take 1 tablet at onset of migraine", "เมื่อเริ่มมีอาการไมเกรน"]
    ]) {
      expect(parseSig(input, { locale: "th" }).longText).toContain(expected);
    }
  });

  it.each(["reason", "coding"] as const)("preserves a %s translation for a recognized broader code", (owner) => {
    const clause = parseSig("Take 1 tablet as needed for pain").meta.canonical.clauses[0];
    const reason = {
      text: "breakthrough pain", coding: {
        code: "22253000", system: "http://snomed.info/sct", display: "Pain",
        ...(owner === "coding" ? { i18n: { th: "ปวดแทรกขณะใช้ยาประจำ" } } : {})
      },
      ...(owner === "reason" ? { i18n: { th: "ปวดแทรกขณะใช้ยาประจำ" } } : {})
    };
    clause.prn = { enabled: true, reason, reasons: [reason] };
    const before = JSON.stringify(reason);
    expect(formatCanonicalClause(clause, "long", resolveSigLocalization("th")))
      .toContain("ปวดแทรกขณะใช้ยาประจำ");
    expect(JSON.stringify(reason)).toBe(before);
    const fallback = { text: "pain", coding: { code: "22253000", system: "http://snomed.info/sct" } };
    clause.prn = { enabled: true, reason: fallback, reasons: [fallback] };
    expect(formatCanonicalClause(clause, "long", resolveSigLocalization("th"))).toContain("ปวด");
  });
});

describe("round 23: authored PRN wording retains its onset context", () => {
  it.each(["reason", "coding"] as const)("preserves a custom %s translation at symptom onset", owner => {
    const clause = parseSig("Take 1 tablet at onset of migraine").meta.canonical.clauses[0];
    const custom = "มีอาการเตือนไมเกรนเฉพาะของผู้ป่วย";
    const reason = {
      text: "patient-specific migraine prodrome",
      triggerPhase: "onset" as const,
      coding: {
        code: "37796009", system: "http://snomed.info/sct", display: "Migraine",
        ...(owner === "coding" ? { i18n: { th: custom } } : {})
      },
      ...(owner === "reason" ? { i18n: { th: custom } } : {})
    };
    clause.prn = { enabled: true, reason, reasons: [reason] };
    const before = JSON.stringify(reason);
    expect(formatCanonicalClause(clause, "long", resolveSigLocalization("th")))
      .toContain("เมื่อเริ่ม" + custom);
    expect(JSON.stringify(reason)).toBe(before);
  });
});

describe("round 23: attached carrier amounts share the quantity grammar", () => {
  it.each([".5L", "0.5L"])("retains the decimal carrier %s independently from the active dose", carrier => {
    const input = `Infuse 20mg in ${carrier} normal saline over 4 hours`;
    const parsed = parseSig(input);
    const amount = parsed.fhirNext.step[0].component[0].doseAndRate?.[0];
    expect(amount?.doseQuantity).toMatchObject({ value: 20, unit: "mg" });
    expect(amount?.rateRatio).toMatchObject({
      numerator: { value: 0.5, unit: "L" }, denominator: { value: 4, unit: "h" }
    });
    expect(parsed.meta.canonical.clauses[0].clinicalQuantity?.carrierMaterial?.text)
      .toBe("normal saline");
    const reopened = toDosageDetails(toFhirR5Dosages(parsed.fhirNext));
    expect(reopened.step[0].component[0].doseAndRate?.[0].rateRatio)
      .toMatchObject({ numerator: { value: 0.5, unit: "L" }, denominator: { value: 4, unit: "h" } });
    expect(parsed.input).toBe(input);
  });
});
