import { describe, expect, it } from "vitest";
import {
  parseSig, formatSig, toDosageDetails, toFhirR5Dosages,
  registerMedicationDateResolver, nextDueDoses, calculateTotalUnits
} from "../src/index";
import { formatCanonicalClause } from "../src/format";
import { formatCanonicalCourse } from "../src/canonical/format-course";
import { administrationFromClause, clauseForAdministration, courseFromAdministrations, courseFromPartialParallel, courseFromParallel } from "../src/canonical/compile";
import { courseFromR6, courseToR6 } from "../src/adapters/canonical-course";
import type { CanonicalCourse, CanonicalBoundary } from "../src/canonical/course";
import { canonicalFromFhir, canonicalToFhir, parserStateFromFhir, TIMING_EVENT_WINDOW_EXTENSION_URL } from "../src/fhir";
import { getQuantityComparator, simpleQuantityForR5 } from "../src/fhir-quantity-operator";
import { resolveSigLocalization, type SigFormatContext } from "../src/i18n";
import { parseInstructionActions, realizeInstructionAction } from "../src/instruction-graph";
import { resolveMedicationInstructionActionByMethod } from "../src/instruction-action-terminology";
import { buildInstructionGraphExtension, MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL } from "../src/instruction-graph-fhir";
import { tokenize, parseClauseState } from "../src/parser";
import { createBoundaryPlan } from "../src/regimen/planner";
import { buildRegimenGraph, scopeSequentialPhaseSemantics } from "../src/regimen/regimen";
import { buildCanonicalParallelRegimen } from "../src/regimen/parallel-course";
import { ParserState } from "../src/parser-state";
import { instructionLexicalRule } from "../src/hpsg/rules/instruction-rules";
import { clinicalQuantityLexicalRule } from "../src/hpsg/rules/clinical-quantity-rules";
import type { HpsgClauseContext } from "../src/hpsg/rule-context";
import {
  inferMedicationLocale, registerMedicationLocaleDetector,
  type MedicationLocaleDetector
} from "../src/locale-detection";
import {
  listMedicationSurfaceSegmenters, registerMedicationSurfaceSegmenter,
  splitMedicationScriptRuns, type MedicationSurfaceSegmenter
} from "../src/lexer/surface-segmenter";
import {
  AdviceArgumentRole, AdviceRelation, AdvicePolarity, EventTiming, FhirPeriodUnit,
  type CanonicalInstructionGraph,
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
    const [morning, night] = parsed.fhirNext.step![0].component;
    expect(morning.doseAndRate?.[0].doseQuantity).toMatchObject({ value: 2, unit: "tab" });
    expect(morning.timing?.repeat?.when).toEqual([EventTiming.Morning]);
    expect(night.doseAndRate?.[0].doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(getQuantityComparator(night.doseAndRate?.[0].doseQuantity)).toBe("<=");
    expect(night.timing?.repeat?.when).toEqual([EventTiming.Night]);
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
    const wire = JSON.parse(JSON.stringify(courseToR6(course))) as FhirR6DosageInstruction;
    const emitted = wire.step![0].component[0].timing?.repeat?.boundsRange;
    expect(emitted?.low).toMatchObject({ value: low / 60, code: "h", unit: "hours" });
    expect(emitted?.high).toMatchObject({ value: high, code: "h", unit: "hours" });
    const reopened = courseFromR6(wire).stages[0].administrations[0];
    expect(reopened.schedule?.recurrence?.courseLengthRange)
      .toMatchObject(raw.step![0].component[0].timing!.repeat!.boundsRange!);
    expect(clauseForAdministration(reopened).schedule).toMatchObject({
      duration: low, durationUnit: "min", durationMax: high, durationMaxUnit: "h"
    });
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
    const wire = JSON.parse(JSON.stringify(canonicalToFhir(clause))) as FhirDosage;
    const roundtrip = wire.timing?.repeat?.boundsRange;
    // Strict Range endpoints share a unit; retained typed metadata keeps the
    // author's independent endpoint units for the next canonical import.
    expect(roundtrip?.low).toMatchObject({ value: 0.5, code: "h" });
    expect(roundtrip?.high).toMatchObject({ value: 2, code: "h" });
    expect(roundtrip?.low?.unit).toBe(roundtrip?.high?.unit);
    expect(roundtrip?.low?.system).toBe(roundtrip?.high?.system);
    expect(getQuantityComparator(roundtrip?.low)).toBe(">=");
    expect(getQuantityComparator(roundtrip?.high)).toBe("<=");
    for (const reopened of [canonicalFromFhir(wire), parserStateFromFhir(wire).primaryClause]) {
      expect(reopened.schedule).toMatchObject({
        duration: 30, durationUnit: "min", durationMax: 2, durationMaxUnit: "h",
        durationComparator: ">=", durationMaxComparator: "<="
      });
    }
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
    expect(english).toContain("From treatment start until 1 day after treatment start; Perform this phase 2 times");
    expect(english).toContain("No doses from 2 days after treatment start until 3 days after treatment start");
    expect(english).not.toContain("No doses from 1 day after treatment start");
    const thai = formatCanonicalCourse(source, "long", { locale: "th" });
    expect(thai).toContain("งดยาตั้งแต่2 วันหลังเริ่มการรักษาจนถึง3 วันหลังเริ่มการรักษา");
    expect(thai).not.toContain("งดยาตั้งแต่1 วันหลังเริ่มการรักษา");
    expect(JSON.stringify(source)).toBe(before);
  });

  it("uses the completed repetitions as the implicit next-stage start and unions overlap", () => {
    const implicit = course(2);
    delete implicit.stages[1].start;
    implicit.stages[1].end = boundary(3);
    const text = formatCanonicalCourse(implicit, "long", { locale: "en" });
    expect(text).toContain("From 2 days after treatment start until 3 days after treatment start");
    expect(text).not.toContain("No doses");
    expect(formatCanonicalCourse(course(4), "long", { locale: "en" })).not.toContain("No doses");
  });

  it("keeps unresolved local repetition visible without asserting a global medication-free gap", () => {
    const unknownDuration = course(2);
    unknownDuration.stages[0].end = boundary(1, "mo");
    for (const source of [course(0), course(1.5), unknownDuration]) {
      const english = formatCanonicalCourse(source, "long", { locale: "en" });
      expect(english).toContain("1 tablet");
      expect(english).toContain("2 tablets");
      expect(english).not.toContain("No doses");
      const thai = formatCanonicalCourse(source, "long", { locale: "th" });
      expect(thai).toContain("1 เม็ด");
      expect(thai).toContain("2 เม็ด");
      expect(thai).not.toContain("งดยา");
    }
  });

  it("uses an optional separator only between generated course stages", () => {
    const source = course(2);
    const joined = formatCanonicalCourse(source, "long", { locale: "en", separator: " | " });
    expect(joined).toContain(" | From 3 days after treatment start until 4 days after treatment start");
    expect(joined).toContain(" | No doses from 2 days after treatment start until 3 days after treatment start");
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

describe("round 24: current facts and independent source wording", () => {
  it("keeps a newly supplied dose beside an amountless rich source action", () => {
    const dosage = parseSig("Swallow slowly with water").fhir[0];
    dosage.doseAndRate = [{ doseQuantity: { value: 2, unit: "tab" } }];
    const saved = JSON.stringify(dosage);
    const text = formatSig(dosage, "long", { locale: "en", realizationMode: "roundtrip" });
    expect(text).toContain("2 tablets");
    expect(text).toContain("slowly");
    expect(text).toContain("with water");
    expect(JSON.stringify(dosage)).toBe(saved);

    const source = "Squeeze 1 cm cream onto each spot";
    const unchanged = parseSig(source).meta.canonical.clauses[0];
    expect(formatCanonicalClause(unchanged, "long", resolveSigLocalization("en"), {
      realizationMode: "roundtrip"
    })).toBe(source);
  });

  it("keeps a saved primary Time from overriding an edited Thai schedule", () => {
    const source = "Take one tablet slowly before bed";
    const dosage = parseSig(source).fhir[0];
    const actions = parseInstructionActions(source);
    // This saved graph has separate typed Amount, Manner and Time slots.
    // Opaque additional advice has its own source contract and is not re-parsed.
    actions[0].args = actions[0].args.map(arg => arg.role === AdviceArgumentRole.Object
      ? { role: AdviceArgumentRole.Manner, text: "slowly", normalized: "slowly",
          i18n: { en: "slowly", th: "ช้าๆ" } }
      : arg);
    const graph: CanonicalInstructionGraph = {
      sourceText: source, sourceLocale: "en", primaryAdministrationSpan: { start: 0, end: 4 }, actions
    };
    dosage.extension = [
      ...(dosage.extension ?? []).filter(extension =>
        extension.url !== MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL),
      buildInstructionGraphExtension(graph)!
    ];
    delete dosage.additionalInstruction;
    dosage.timing!.repeat!.when = [EventTiming.Morning];
    const saved = JSON.stringify(dosage);
    const text = formatSig(dosage, "long", { locale: "th", realizationMode: "roundtrip" });
    expect(text).toContain("1 เม็ด");
    expect(text).toContain("เช้า");
    expect(text).toContain("ช้าๆ");
    expect(text).not.toMatch(/ก่อนนอน|bed|sleep/iu);
    expect(JSON.stringify(dosage)).toBe(saved);

    // The ordinary parser also supplies this graph for a rich swallow action.
    const natural = parseSig("Swallow 1 tablet slowly before bed").fhir[0];
    natural.timing!.repeat!.when = [EventTiming.Morning];
    const naturalText = formatSig(natural, "long", { locale: "th", realizationMode: "roundtrip" });
    expect(naturalText).toContain("เช้า");
    expect(naturalText).toContain("slowly");
    expect(naturalText).not.toMatch(/ก่อนนอน|bed|sleep/iu);
  });

  it("keeps a dose-less rich source from replaying its old clock through a locale fallback", () => {
    const dosage = parseSig("Swallow slowly with water at 08:00").fhir[0];
    dosage.timing!.repeat!.timeOfDay![0] = "10:00:00";
    const saved = JSON.stringify(dosage);
    for (const locale of ["en", "th"]) {
      const text = formatSig(dosage, "long", { locale, realizationMode: "roundtrip" });
      expect(text).toContain("10:00");
      expect(text).toContain("slowly");
      expect(text).toContain(locale === "en" ? "water" : "น้ำ");
      expect(text).not.toMatch(/08:00|8:00 am/);
    }
    expect(JSON.stringify(dosage)).toBe(saved);
  });

  it("clears a source-owned Object quantity without erasing its noun or an independent equal amount", () => {
    const parsed = parseSig("Dissolve 1 tablet of amoxicillin in 1 tablet saline");
    const dosage = parsed.fhir[0];
    const graph = JSON.parse(JSON.stringify(parsed.meta.canonical.clauses[0].instructionGraph)) as CanonicalInstructionGraph;
    const theme = graph.actions[0].args.find(arg => arg.role === AdviceArgumentRole.Theme)!;
    // Source span still covers the original Amount; nominal text need not repeat it.
    theme.text = "amoxicillin";
    theme.normalized = "amoxicillin";
    dosage.extension = dosage.extension!.map(extension =>
      extension.url === MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL
        ? buildInstructionGraphExtension(graph)! : extension);
    dosage.doseAndRate![0].doseQuantity!.value = 2;
    const saved = JSON.stringify(dosage);
    for (const locale of ["en", "th"]) {
      const text = formatSig(dosage, "long", { locale, realizationMode: "roundtrip" });
      expect(text).toContain(locale === "en" ? "2 tablets" : "2 เม็ด");
      expect(text).toContain("amoxicillin");
      expect(text).toContain(locale === "en" ? "1 tablet saline" : "saline 1 เม็ด");
      expect(text.match(locale === "en" ? /1 tablet\b/g : /1 เม็ด/g)).toHaveLength(1);
    }
    expect(JSON.stringify(dosage)).toBe(saved);
  });

  it("renders the current qualified rate when it is the only structured administration fact", () => {
    const dosage: FhirR6DosageInstruction = { step: [{ component: [{
      text: "Infuse at 5 mL/h.",
      doseAndRate: [{ rateQuantity: simpleQuantityForR5({ value: 10, unit: "mL/h", comparator: "~" })! }]
    }] }] };
    const saved = JSON.stringify(dosage);
    for (const locale of ["en", "th"]) for (const style of ["short", "long"] as const) {
      const text = formatSig(dosage, style, { locale });
      expect(text).toContain("~10 mL/h");
      expect(text).not.toContain("5 mL/h");
    }
    expect(JSON.stringify(dosage)).toBe(saved);
    expect(formatSig({ step: [{ component: [{ text: "Keep this exact text." }] }] }, "long"))
      .toBe("Keep this exact text.");
  });
});

describe("round 24: grouped alternatives and repeated calendar boundaries", () => {
  it("keeps a two-administration branch together against its alternative", () => {
    const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [
      { kind: "administration", amounts: [{ quantity: { value: 1, unit: "tab" } }],
        schedule: { recurrence: { anchors: [EventTiming.Morning] } },
        choice: { groupId: "dose-choice", branchId: "two-meals" } },
      { kind: "administration", amounts: [{ quantity: { value: 2, unit: "tab" } }],
        schedule: { recurrence: { anchors: [EventTiming.Evening] } },
        choice: { groupId: "dose-choice", branchId: "two-meals" } },
      { kind: "administration", amounts: [{ quantity: { value: 3, unit: "tab" } }],
        schedule: { recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
        choice: { groupId: "dose-choice", branchId: "daily" } }
    ] }] };
    const english = formatCanonicalCourse(course, "long", { locale: "en" });
    expect(english).toMatch(/Choose one: \([^)]*1 tablet[^)]*;[^)]*2 tablets[^)]*\) or [^(]*3 tablets/);
    const thai = formatCanonicalCourse(course, "long", { locale: "th" });
    expect(thai).toMatch(/\([^)]*1 เม็ด[^)]*;[^)]*2 เม็ด[^)]*\).*หรือ.*3 เม็ด/);
  });

  it("uses the completed fixed repetitions before an unresolved calendar endpoint", () => {
    const boundary = (value: number, unit: string): CanonicalBoundary => ({
      anchor: "treatment-start", displacement: { value, unit }
    });
    const course: CanonicalCourse = { kind: "course", stages: [
      { end: boundary(7, "d"), count: 2, administrations: [
        { kind: "administration", amounts: [{ quantity: { value: 1, unit: "tab" } }] }
      ] },
      { end: boundary(1, "mo"), administrations: [
        { kind: "administration", amounts: [{ quantity: { value: 2, unit: "tab" } }] }
      ] }
    ] };
    const saved = JSON.stringify(course);
    const english = formatCanonicalCourse(course, "long", { locale: "en" });
    expect(english).toContain("From 14 days after treatment start until 1 month");
    expect(english).toContain("1 tablet");
    expect(english).toContain("2 tablets");
    const thai = formatCanonicalCourse(course, "long", { locale: "th" });
    expect(thai).toContain("14 วัน");
    expect(thai).toContain("1 เดือน");
    expect(thai).toContain("1 เม็ด");
    expect(thai).toContain("2 เม็ด");
    expect(JSON.stringify(course)).toBe(saved);
  });
});

describe("round 24: typed quantity ownership", () => {
  it.each([">2", "approximately 2"])("keeps a negated dose-defining amount inactive: %s", amount => {
    const source = `Do not dissolve ${amount} tablets in water`;
    const parsed = parseSig(source);
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.dose?.value).toBeUndefined();
    expect(clause.dose?.range).toBeUndefined();
    expect(parsed.fhir[0].doseAndRate).toBeUndefined();
    expect(parsed.fhirNext.step[0].component[0].doseAndRate).toBeUndefined();
    expect(clause.instructionGraph?.actions[0].polarity).toBe(AdvicePolarity.Negate);
    expect(clause.instructionGraph?.actions[0].args.find(arg => arg.role === AdviceArgumentRole.Amount)?.quantity)
      .toMatchObject({ value: 2, unit: "tab", comparator: amount.startsWith(">") ? ">" : "~" });
    expect(parsed.input).toBe(source);
    expect(parseSig(`Dissolve ${amount} tablets in water`).meta.canonical.clauses[0].dose)
      .toMatchObject({ value: 2, unit: "tab" });
  });

  it.each(["PO", "orally", "by mouth", "per os"])("retains a qualified unitless dose before route %s and its schedule", route => {
    const parsed = parseSig(`Take 1 tablet BID, then about 2 ${route} BID`);
    expect(parsed.meta.canonical.clauses).toHaveLength(2);
    expect(parsed.meta.canonical.clauses[1].dose).toMatchObject({
      value: 2, unit: "tab", comparator: "~"
    });
    expect(parsed.meta.canonical.clauses[1].schedule).toMatchObject({ frequency: 2, period: 1 });
    const wire = toFhirR5Dosages(parsed.fhirNext)[1].doseAndRate![0].doseQuantity;
    expect(wire).toMatchObject({ value: 2, unit: "tab" });
    expect(getQuantityComparator(wire)).toBe("~");
  });

  it.each(["approx. 5 mg", "approx.5mg", "approx 5 mg"])("recognizes one dotted or undotted qualifier: %s", amount => {
    const parsed = parseSig("Take " + amount);
    expect(parsed.meta.canonical.clauses[0].dose).toMatchObject({ value: 5, unit: "mg", comparator: "~" });
    const quantity = parsed.fhirNext.step[0].component[0].doseAndRate?.[0].doseQuantity;
    expect(quantity).toMatchObject({ value: 5, unit: "mg" });
    expect(getQuantityComparator(quantity)).toBe("~");
  });

  it.each(["approximately ", ""])("keeps AT with the complete %svolume-over-time constituent", qualifier => {
    const parsed = parseSig(`Infuse at ${qualifier}100 mL over 1 hour`);
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.clinicalQuantity?.numerator).toMatchObject({ value: 100, unit: "mL" });
    expect(clause.clinicalQuantity?.numerator.comparator).toBe(qualifier ? "~" : undefined);
    expect(clause.clinicalQuantity?.administrationDuration).toMatchObject({ value: 1, unit: "h" });
    expect(clause.site).toBeUndefined();
    expect(clause.leftovers.some(span => /^at$/iu.test(span.text.trim()))).toBe(false);
    expect(parsed.fhirNext.step[0].component[0].doseAndRate?.[0].rateRatio?.numerator)
      .toMatchObject({ value: 100, unit: "mL" });
  });

  it("keeps later rate tokens out of a separator-led instruction before their chart position runs", () => {
    const source = "Infuse IV, approximately 100 mL/hr";
    const tokens = tokenize(source);
    const context: HpsgClauseContext = {
      state: new ParserState(source, tokens), tokens, limit: tokens.length,
      dateSpans: [], clinicalCache: {}, deps: {} as HpsgClauseContext["deps"]
    };
    const separator = tokens.findIndex(token => token.original === ",");
    const quantity = tokens.findIndex(token => token.lower === "approximately");
    expect(separator).toBeGreaterThanOrEqual(0);
    expect(quantity).toBeGreaterThan(separator);
    expect(instructionLexicalRule().match(context, separator)).toEqual([]);
    const rate = clinicalQuantityLexicalRule().match(context, quantity);
    expect(rate).toHaveLength(1);
    expect(rate[0].synsem.head.dose?.clinicalQuantity?.numerator)
      .toMatchObject({ value: 100, unit: "mL", comparator: "~" });
    const parsed = parseSig(source);
    expect(parsed.meta.canonical.clauses[0].clinicalQuantity?.numerator)
      .toMatchObject({ value: 100, unit: "mL", comparator: "~" });
    expect(parsed.meta.canonical.clauses[0].additionalInstructions).toBeUndefined();
  });

  it("does not revive a bolus scalar in a rate phase or the following elliptical schedule", () => {
    const parsed = parseSig("Give 5 mg IV once, then infuse at 1 mg/hr for 6 hours, then daily");
    expect(parsed.meta.canonical.clauses).toHaveLength(3);
    expect(parsed.fhir[0].doseAndRate?.[0].doseQuantity).toMatchObject({ value: 5, unit: "mg" });
    expect(parsed.fhir[1].doseAndRate?.[0].rateQuantity).toMatchObject({ value: 1, unit: "mg/h" });
    expect(parsed.fhir[1].doseAndRate?.[0].doseQuantity).toBeUndefined();
    expect(parsed.fhir[2].doseAndRate).toBeUndefined();
    expect(parsed.meta.canonical.clauses[2].schedule).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
  });
});

describe("round 24: independent local complements", () => {
  const options: ParseOptions = { instructionActionMap: {
    dilute: { code: "dilute", display: "Dilute", i18n: { th: "เจือจาง" },
      semanticClass: "procedure", procedural: true, acceptsAmount: true, definesDose: true,
      argumentParser: "amount-material-destination", realizer: "amount-material-destination" }
  } };

  it("retains the final volume independently from the diluent through both wire formats", () => {
    const source = "Dilute 5 mL saline with water to 100 mL";
    const parsed = parseSig(source, options);
    const action = parsed.meta.canonical.clauses[0].instructionGraph!.actions[0];
    expect(action.args.filter(arg => arg.relation).map(arg => [arg.relation, arg.text]))
      .toEqual([[AdviceRelation.With, "water"], [AdviceRelation.To, "100 mL"]]);
    const saved = JSON.stringify(action);
    for (const wire of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)[0]]) {
      const english = formatSig(wire, "long", { locale: "en", realizationMode: "normalized" });
      expect(english).toContain("5 mL");
      expect(english).toContain("saline with water to 100 mL");
      const thai = formatSig(wire, "long", { locale: "th", realizationMode: "normalized" });
      expect(thai).toContain("น้ำ");
      expect(thai).toContain("100 มิลลิลิตร");
    }
    expect(JSON.stringify(action)).toBe(saved);
  });

  it("retains a second accompaniment after an application target", () => {
    const parsed = parseSig("Squeeze 1 cm cream onto each spot with water");
    const text = formatSig(parsed.fhirNext, "long", { locale: "en", realizationMode: "normalized" });
    expect(text).toContain("1 cm line");
    expect(text).toContain("cream on each spot with water");
  });
});

describe("round 24: descriptor surface providers", () => {
  it("reads a non-enumerable script once and normalizes stateful flags", () => {
    const provider: MedicationSurfaceSegmenter = {
      locale: "round24-descriptor", script: /[ⴲⴳ]/gyu,
      *segment(input: string) {
        for (let index = 0; index < input.length; index++) yield { segment: input[index], index };
      }
    };
    let reads = 0;
    Object.defineProperty(provider, "script", {
      enumerable: false, get() { reads++; return /[ⴲⴳ]/gyu; }
    });
    registerMedicationSurfaceSegmenter(provider);
    const registered = listMedicationSurfaceSegmenters().find(item => item.locale === provider.locale)!;
    expect(reads).toBe(1);
    expect(registered.script.global).toBe(false);
    expect(registered.script.sticky).toBe(false);
    expect(splitMedicationScriptRuns("AⴲⴳB").map(run => run.text)).toEqual(["A", "ⴲⴳ", "B"]);
    expect([...registered.segment("ⴲⴳ")]).toEqual([
      { segment: "ⴲ", index: 0 }, { segment: "ⴳ", index: 1 }
    ]);
  });
});

describe("round 25: typed source owners survive independent clinical edits", () => {
  const options: ParseOptions = { instructionActionMap: {
    disperse: { code: "disperse", display: "Disperse", i18n: { th: "กระจาย" },
      semanticClass: "procedure", procedural: true, acceptsAmount: true, definesDose: true,
      argumentParser: "amount-material-destination", realizer: "amount-material-destination" }
  } };

  it("uses the custom preparation as the sole dose owner beside a rich primary action", () => {
    const source = "Disperse 2 tablets in water, then swallow slowly with water";
    const parsed = parseSig(source, options);
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.instructionGraph?.primaryAdministrationSpan?.start).toBe(source.indexOf("swallow"));
    expect(clause.instructionGraph?.actions).toHaveLength(2);
    const saved = JSON.stringify(parsed.fhir[0]);
    for (const locale of ["en", "th"]) {
      const dose = locale === "en" ? "2 tablets" : "2 เม็ด";
      for (const text of [
        formatCanonicalClause(clause, "long", resolveSigLocalization(locale),
          { ...options, realizationMode: "normalized" }),
        formatSig(parsed.fhir[0], "long", { ...options, locale, realizationMode: "normalized" })
      ]) {
        expect(text.split(dose)).toHaveLength(2);
        expect(text).toContain(locale === "en" ? "Disperse" : "กระจาย");
        expect(text).toContain("slowly");
      }
    }
    expect(JSON.stringify(parsed.fhir[0])).toBe(saved);
  });

  it.each([
    ["Disperse 2 tablets in water, then drink slowly", "ช้าๆ"],
    ["Disperse 2 tablets in water, then swallow slowly with water", "slowly"]
  ])("replaces a custom preparation dose in normalized and roundtrip EN/TH: %s", (source, thaiManner) => {
    const dosage: FhirDosage = JSON.parse(JSON.stringify(parseSig(source, options).fhir[0]));
    dosage.doseAndRate![0].doseQuantity!.value = 3;
    const saved = JSON.stringify(dosage);
    for (const locale of ["en", "th"]) for (const realizationMode of ["normalized", "roundtrip"] as const) {
      const text = formatSig(dosage, "long", { ...options, locale, realizationMode });
      expect(text).toContain(locale === "en" ? "3 tablets" : "3 เม็ด");
      expect(text).not.toMatch(/2 tablets|2 เม็ด/);
      expect(text).toContain(locale === "en" ? "water" : "น้ำ");
      expect(text).toContain(locale === "en" ? "slowly" : thaiManner);
      expect(text.toLowerCase()).toContain(locale === "en" ? "disperse" : "กระจาย");
      const action = source.includes("drink") ? ["drink", "ดื่ม"] : ["swallow", "กลืน"];
      expect(text.toLowerCase()).toContain(action[locale === "en" ? 0 : 1]);
    }
    expect(JSON.stringify(dosage)).toBe(saved);
  });

  it("retains an independent priming amount when the sole spanless dose definer is edited", () => {
    const source = "Prime with 2 sprays, then spray 1 spray into each nostril";
    const graph: CanonicalInstructionGraph = {
      sourceText: source, sourceLocale: "en", actions: parseInstructionActions(source)
    };
    const dosage: FhirDosage = {
      method: { text: "Spray", coding: [{ code: "spray" }] },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "spray" } }],
      extension: [buildInstructionGraphExtension(graph)!]
    };
    dosage.doseAndRate![0].doseQuantity!.value = 3;
    const saved = JSON.stringify(dosage), sourceGraph = JSON.stringify(graph);
    for (const locale of ["en", "th"]) for (const realizationMode of ["normalized", "roundtrip"] as const) {
      const text = formatSig(dosage, "long", { locale, realizationMode });
      expect(text).toContain(locale === "en" ? "Prime with 2 sprays" : "เตรียมอุปกรณ์พ่น 2 พ่น");
      expect(text).toContain(locale === "en" ? "3 sprays" : "3 พ่น");
      expect(text).toContain(locale === "en" ? "both nostrils" : "รูจมูกทั้งสองข้าง");
      expect(text).not.toMatch(/1 spray|1 พ่น/);
    }
    expect(JSON.stringify(dosage)).toBe(saved);
    expect(JSON.stringify(graph)).toBe(sourceGraph);
  });

  it("composes a typed before relation with its breakfast event before comparing live timing", () => {
    const source = "Swallow 1 tablet slowly before breakfast";
    const actions = parseInstructionActions(source);
    actions[0].args = actions[0].args.map(arg =>
      arg.role === AdviceArgumentRole.Time
        ? { ...arg, normalized: EventTiming.Breakfast, relation: AdviceRelation.Before }
        : arg.role === AdviceArgumentRole.Object
        ? { role: AdviceArgumentRole.Manner, text: "slowly", normalized: "slowly",
            i18n: { en: "slowly", th: "ช้าๆ" } }
        : arg);
    const graph: CanonicalInstructionGraph = {
      sourceText: source, sourceLocale: "en", actions,
      primaryAdministrationSpan: { start: 0, end: 7 }
    };
    const dosage = parseSig(source).fhir[0];
    dosage.extension = [
      ...(dosage.extension ?? []).filter(item => item.url !== MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL),
      buildInstructionGraphExtension(graph)!
    ];
    delete dosage.additionalInstruction;
    const sourceGraph = JSON.stringify(graph);
    for (const event of [EventTiming["Before Breakfast"], EventTiming.Breakfast]) {
      dosage.timing!.repeat!.when = [event];
      const saved = JSON.stringify(dosage);
      for (const locale of ["en", "th"]) {
        const text = formatSig(dosage, "long", { locale, realizationMode: "roundtrip" });
        if (event === EventTiming["Before Breakfast"]) {
          expect(text).toContain(locale === "en" ? "before breakfast" : "ก่อนอาหารเช้า");
        } else {
          expect(text).toContain(locale === "en" ? "with breakfast" : "พร้อมอาหารเช้า");
          expect(text).not.toMatch(/before breakfast|ก่อนอาหารเช้า/);
        }
        expect(text).toContain(locale === "en" ? "slowly" : "ช้าๆ");
      }
      expect(JSON.stringify(dosage)).toBe(saved);
    }
    expect(JSON.stringify(graph)).toBe(sourceGraph);
  });
});

describe("round 25: duration endpoints and course preview boundaries", () => {
  it.each([
    [undefined, ">=7", "at least 7", "อย่างน้อย 7"],
    [">", ">7", ">7", ">7"],
    [">=", ">=7", ">=7", ">=7"],
    ["~", ">=~7", "at least ~7", "อย่างน้อย ~7"]
  ] as const)("renders the lower-only duration comparator %s exactly once", (comparator, short, english, thai) => {
    const dosage: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { boundsRange: { low: simpleQuantityForR5({
        value: 7, unit: "days", system: "http://unitsofmeasure.org", code: "d", comparator
      })! } } }
    };
    const saved = JSON.stringify(dosage);
    for (const locale of ["en", "th"]) {
      const options = { locale, realizationMode: "normalized" as const };
      const shortFragment = "x" + short + "d";
      const longFragment = locale === "en" ? "for " + english + " days" : "เป็นเวลา " + thai + " วัน";
      expect(formatSig(dosage, "short", options).split(shortFragment)).toHaveLength(2);
      expect(formatSig(dosage, "long", options).split(longFragment)).toHaveLength(2);
    }
    expect(JSON.stringify(dosage)).toBe(saved);
  });

  it.each([undefined, 1, 2] as const)("does not infer the next start from one calendar iteration when count is %s", count => {
    const course: CanonicalCourse = { kind: "course", stages: [
      { count, end: { anchor: "treatment-start", displacement: { value: 1, unit: "mo" } },
        administrations: [{ kind: "administration", amounts: [{ quantity: { value: 1, unit: "tab" } }] }] },
      { end: { anchor: "treatment-start", displacement: { value: 3, unit: "mo" } },
        administrations: [{ kind: "administration", amounts: [{ quantity: { value: 2, unit: "tab" } }] }] }
    ] };
    const saved = JSON.stringify(course);
    for (const text of [
      formatCanonicalCourse(course, "long", { locale: "en", realizationMode: "normalized" }),
      formatSig(courseToR6(course), "long", { locale: "en", realizationMode: "normalized" })
    ]) {
      expect(text).toContain("3 months after treatment start");
      expect(text).toContain("2 tablets");
      if (count === 2) {
        expect(text).toContain("Until 3 months after treatment start: Use 2 tablets");
        expect(text).not.toContain("From 1 month after treatment start");
      } else {
        expect(text).toContain("From 1 month after treatment start until 3 months");
      }
    }
    expect(JSON.stringify(course)).toBe(saved);
  });

  it("retains an exact start while an event-relative end still requires review", () => {
    const course: CanonicalCourse = { kind: "course", stages: [{
      start: { anchor: "treatment-start", displacement: { value: 7, unit: "d" } },
      end: { anchor: "coded-event", contextCode: { text: "follow-up visit" }, description: "follow-up visit" },
      administrations: [{ kind: "administration", amounts: [{ quantity: { value: 1, unit: "tab" } }] }]
    }] };
    const saved = JSON.stringify(course);
    for (const locale of ["en", "th"]) {
      const text = formatCanonicalCourse(course, "long", { locale, realizationMode: "normalized" });
      expect(text).toContain(locale === "en" ? "7 days after treatment start" : "7 วันหลังเริ่มการรักษา");
      expect(text).toContain(locale === "en" ? "Timing requires review" : "ต้องตรวจสอบช่วงเวลา");
      expect(text).toContain("follow-up visit");
      expect(text).toContain(locale === "en" ? "1 tablet" : "1 เม็ด");
    }
    expect(JSON.stringify(course)).toBe(saved);
  });

  it("uses a requested separator within ordinary rows and grouped choice branches", () => {
    const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [
      { kind: "administration", amounts: [{ quantity: { value: 1, unit: "tab" } }] },
      { kind: "administration", amounts: [{ quantity: { value: 2, unit: "tab" } }] }
    ] }] };
    const ordinary = formatCanonicalCourse(course, "long", { locale: "en", separator: "\n" });
    expect(ordinary).toBe("Use 1 tablet\nUse 2 tablets.");
    course.stages[0].administrations[0].choice = { groupId: "choices", branchId: "pair" };
    course.stages[0].administrations[1].choice = { groupId: "choices", branchId: "pair" };
    course.stages[0].administrations.push(
      { kind: "administration", amounts: [{ quantity: { value: 3, unit: "tab" } }],
        choice: { groupId: "choices", branchId: "single" } },
      { kind: "administration", amounts: [{ quantity: { value: 4, unit: "tab" } }] }
    );
    const grouped = formatCanonicalCourse(course, "long", { locale: "en", separator: "\n" });
    expect(grouped).toBe("Choose one: (Use 1 tablet\nUse 2 tablets) or Use 3 tablets\nUse 4 tablets.");
    expect(grouped).not.toContain(".\n");
  });
});


describe("round 26: known timing and quantity stay attached to their clinical owner", () => {
  it.each([2, -2, 0])("retains an unresolved event and its %s-day displacement without assigning a date", value => {
    const wire: FhirR6DosageInstruction = { step: [{
      start: { contextCode: { text: "follow-up visit" }, offsetDuration: { value, code: "d" } },
      component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] }]
    }] };
    const saved = JSON.stringify(wire);
    for (const locale of ["en", "th"]) {
      const text = formatSig(wire, "long", { locale, realizationMode: "normalized" });
      expect(text).toContain("follow-up visit");
      expect(text).toContain(String(Math.abs(value)));
      expect(text).toContain(locale === "en" ? (value < 0 ? "before" : "after") : (value < 0 ? "ก่อน" : "หลัง"));
      expect(text).toContain(locale === "en" ? "requires review" : "ต้องตรวจสอบ");
      expect(text).not.toMatch(/2026|Days 1|วันที่ 1/);
    }
    expect(JSON.stringify(wire)).toBe(saved);
  });

  it("shows a bounded event offset and retains the generic fallback with no event facts", () => {
    const wire: FhirR6DosageInstruction = { step: [{
      start: { contextCode: { text: "follow-up visit" },
        offsetRange: { low: { value: 2, code: "d" }, high: { value: 3, code: "d" } } },
      component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] }]
    }] };
    const text = formatSig(wire, "long", { realizationMode: "normalized" });
    expect(text).toContain("2 days – 3 days after follow-up visit");
    const thai = formatSig(wire, "long", { locale: "th", realizationMode: "normalized" });
    expect(thai).toContain("2 วัน – 3 วันหลังfollow-up visit");
    expect(thai).toContain("ต้องตรวจสอบช่วงเวลา");
    expect(thai).not.toMatch(/2026|วันที่ 1/u);
    expect(wire.step![0].start).toEqual({ contextCode: { text: "follow-up visit" },
      offsetRange: { low: { value: 2, code: "d" }, high: { value: 3, code: "d" } } });
    const unknown: FhirR6DosageInstruction = { step: [{ start: {}, component: wire.step![0].component }] };
    expect(formatSig(unknown, "long", { realizationMode: "normalized" }))
      .toContain("Stage timing requires review");
  });

  it.each(["~", ">="] as const)("keeps the %s primary spray dose scoped to each nostril", comparator => {
    const wire: FhirR6DosageInstruction = { step: [{ component: [{
      route: { text: "intranasal" }, site: { concept: { text: "both nostrils" } },
      doseAndRate: [{ doseQuantity: simpleQuantityForR5({ value: 1, unit: "spray", comparator })! },
        { doseQuantity: simpleQuantityForR5({ value: 2, unit: "mg", comparator: "<" })! }]
    }] }] };
    const saved = JSON.stringify(wire);
    for (const locale of ["en", "th"]) {
      const text = formatSig(wire, "long", { locale, realizationMode: "normalized" });
      expect(text).toContain(locale === "en" ? "each nostril" : "ข้างละ");
      expect(text).toContain(locale === "en" ? comparator === "~" ? "approximately 1 spray" : "at least 1 spray"
        : comparator === "~" ? "ประมาณ 1" : "อย่างน้อย 1");
      expect(text).toContain("<2 mg");
      expect(text.match(locale === "en" ? /1 spray/g : /1 ครั้ง/g)).toHaveLength(1);
      const short = formatSig(wire, "short", { locale, realizationMode: "normalized" });
      expect(short).toContain("1");
      expect(short).toContain(locale === "en" ? comparator : comparator === "~" ? "ประมาณ" : "อย่างน้อย");
    }
    expect(JSON.stringify(wire)).toBe(saved);
  });

  it("shows a zero-step cycle interval without manufacturing an active administration", () => {
    const wire: FhirR6DosageInstruction = { repeatCycle: { value: 28, code: "d" } };
    expect(courseFromR6(wire).stages).toEqual([]);
    for (const locale of ["en", "th"]) {
      const text = formatSig(wire, "long", { locale });
      expect(text).toContain(locale === "en" ? "every 28 days" : "ทุก 28 วัน");
      expect(text).not.toMatch(/tablet|เม็ด|Take|รับประทาน/);
    }
    expect(formatSig({ renderedInstruction: "Keep this instruction" }, "long")).toBe("Keep this instruction");
    expect(formatSig({ safety: { doseLimit: [{ scope: "lifetime", valueInteger: 3 }] } }, "long"))
      .toContain("3 administrations");
    expect(wire.step).toBeUndefined();
  });

  it.each(["before", "after"])("composes the %s dose event after all dilution complements", relation => {
    const source = "Dilute 1 mL with saline to 10 mL " + relation + " each dose";
    const parsed = parseSig(source);
    const graph = parsed.meta.canonical.clauses[0].instructionGraph!;
    expect(graph.actions).toHaveLength(1);
    const frame = graph.actions[0];
    expect(frame.args.find(arg => arg.role === AdviceArgumentRole.Amount)?.quantity)
      .toMatchObject({ value: 1, unit: "mL" });
    expect(frame.args.filter(arg => arg.relation).map(arg => [arg.relation, arg.text]))
      .toEqual([[AdviceRelation.With, "saline"], [AdviceRelation.To, "10 mL"], [relation, "each dose"]]);
    const saved = JSON.stringify(graph);
    for (const wire of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)[0]]) {
      const english = formatSig(wire, "long", { locale: "en", realizationMode: "normalized" });
      expect(english).toContain("Dilute 1 mL with saline to 10 mL " + relation + " each dose");
      const thai = formatSig(wire, "long", { locale: "th", realizationMode: "normalized" });
      expect(thai).toContain("เจือจาง");
      expect(thai).toContain("1 มิลลิลิตร");
      expect(thai).toContain("10 มิลลิลิตร");
      expect(thai).toContain((relation === "before" ? "ก่อน" : "หลัง") + "การให้ยาแต่ละครั้ง");
    }
    expect(JSON.stringify(graph)).toBe(saved);
  });

  it("cleans a surviving primary frame after an external bedtime-to-morning edit", () => {
    const source = "Take 1 tablet at bedtime";
    const row: FhirDosage = JSON.parse(JSON.stringify(parseSig(source).fhir[0]));
    row.extension = [...(row.extension ?? []), buildInstructionGraphExtension({
      sourceText: source, sourceLocale: "en", actions: parseInstructionActions(source)
    })!];
    const originalGraph = JSON.stringify(row.extension);
    for (const locale of ["en", "th"]) {
      expect(formatSig(row, "long", { locale, realizationMode: "roundtrip" }))
        .toContain(locale === "en" ? "bedtime" : "ก่อนนอน");
    }
    row.timing!.repeat!.when = [EventTiming.Morning];
    for (const locale of ["en", "th"]) for (const realizationMode of ["normalized", "roundtrip"] as const) {
      const text = formatSig(row, "long", { locale, realizationMode });
      expect(text).toContain(locale === "en" ? "morning" : "ตอนเช้า");
      expect(text).not.toMatch(/bedtime|sleep|นอน/);
      expect(text.match(locale === "en" ? /1 tablet/g : /1 เม็ด/g)).toHaveLength(1);
    }
    expect(JSON.stringify(row.extension)).toBe(originalGraph);
  });

  it("keeps the independent later action's bedtime when only the primary schedule changes", () => {
    const source = "Take 1 tablet at bedtime";
    const row: FhirDosage = JSON.parse(JSON.stringify(parseSig(source).fhir[0]));
    const first = parseInstructionActions(source)[0];
    const laterText = "Take 2 tablets at bedtime";
    const prefix = source + "; ";
    const later = parseInstructionActions(laterText, prefix.length)[0];
    later.sequenceIndex = 1;
    row.extension = [...(row.extension ?? []), buildInstructionGraphExtension({
      sourceText: prefix + laterText, sourceLocale: "en",
      primaryAdministrationSpan: { start: 0, end: 4 }, actions: [first, later]
    })!];
    row.timing!.repeat!.when = [EventTiming.Morning];
    const text = formatSig(row, "long", { locale: "en", realizationMode: "roundtrip" });
    expect(text).toContain("1 tablet orally in the morning");
    expect(text).toContain("Take 2 tablets at bedtime");
    expect(text).not.toContain("Take 1 tablet at bedtime");
  });

  it("preserves an explicitly replaced instruction text beside the edited schedule", () => {
    const row: FhirDosage = JSON.parse(JSON.stringify(parseSig("Swallow 1 tablet whole at bedtime").fhir[0]));
    row.timing!.repeat!.when = [EventTiming.Morning];
    row.text = "Swallow 1 tablet whole in the morning after discussion with the clinician.";
    const saved = JSON.stringify(row);
    expect(formatSig(row, "long", { realizationMode: "roundtrip" })).toBe(row.text);
    expect(JSON.stringify(row)).toBe(saved);
  });

  it("renders the live meal offset exactly once beside the rich primary action", () => {
    const source = "Swallow 1 tablet whole before breakfast";
    const row: FhirDosage = JSON.parse(JSON.stringify(parseSig(source).fhir[0]));
    row.timing!.repeat!.offset = 30;
    const saved = JSON.stringify(row);
    for (const locale of ["en", "th"]) for (const realizationMode of ["normalized", "roundtrip"] as const) {
      const text = formatSig(row, "long", { locale, realizationMode });
      expect(text).toContain(locale === "en" ? "30 minutes before breakfast" : "ก่อนอาหารเช้า 30 นาที");
      expect(text).toContain(locale === "en" ? "whole" : "ทั้งเม็ด");
      expect(text.match(locale === "en" ? /breakfast/g : /อาหารเช้า/g)).toHaveLength(1);
      expect(text.match(locale === "en" ? /1 tablet/g : /1 เม็ด/g)).toHaveLength(1);
    }
    expect(JSON.stringify(row)).toBe(saved);
  });
});

describe("round 26: quantity grammar owns the complete comparative or scaled head", () => {
  it.each(["no greater than", "not greater than"])("keeps %s as an inclusive infusion upper limit", qualifier => {
    const source = "Infuse " + qualifier + " 100 mL per hour";
    const tokens = tokenize(source);
    const context: HpsgClauseContext = { state: new ParserState(source, tokens), tokens,
      limit: tokens.length, dateSpans: [], clinicalCache: {}, deps: {} as HpsgClauseContext["deps"] };
    const start = tokens.findIndex(token => token.lower === qualifier.split(" ")[0]);
    const signs = clinicalQuantityLexicalRule().match(context, start);
    expect(signs).toHaveLength(1);
    expect(signs[0].synsem.head.dose?.clinicalQuantity?.numerator)
      .toMatchObject({ value: 100, unit: "mL", comparator: "<=" });
    const parsed = parseSig(source);
    for (const wire of [parsed.fhirNext, toDosageDetails(JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext))))]) {
      const amounts = wire.step!.flatMap(step => step.component.flatMap(component => component.doseAndRate ?? []));
      expect(amounts).toHaveLength(1);
      expect(amounts[0].rateQuantity).toMatchObject({ value: 100, unit: "mL/h" });
      expect(getQuantityComparator(amounts[0].rateQuantity)).toBe("<=");
      expect(amounts[0].doseQuantity).toBeUndefined();
    }
    expect(parsed.meta.leftoverText).toBeUndefined();
  });

  it.each(["", "approximately "])("uses the shared fraction head in '%shalf a million units per hour'", qualifier => {
    const source = "Infuse " + qualifier + "half a million units per hour";
    const parsed = parseSig(source);
    const amounts = parsed.fhirNext.step!.flatMap(step => step.component.flatMap(component => component.doseAndRate ?? []));
    expect(amounts).toHaveLength(1);
    expect(amounts[0].rateQuantity).toMatchObject({ value: 500_000, unit: "[iU]/h" });
    expect(getQuantityComparator(amounts[0].rateQuantity)).toBe(qualifier ? "~" : undefined);
    expect(amounts[0].doseQuantity).toBeUndefined();
    expect(parsed.meta.leftoverText).toBeUndefined();
    const scalar = parseSig("Inject half a million units once").fhirNext.step![0].component[0].doseAndRate![0];
    expect(scalar.doseQuantity).toMatchObject({ value: 500_000, unit: "U" });
    expect(scalar.rateQuantity).toBeUndefined();
  });

  it.each(["", "approximately "])("keeps '%s1 million units per hour' as one owned rate", qualifier => {
    const source = "Infuse " + qualifier + "1 million units per hour";
    const tokens = tokenize(source);
    const context: HpsgClauseContext = { state: new ParserState(source, tokens), tokens,
      limit: tokens.length, dateSpans: [], clinicalCache: {}, deps: {} as HpsgClauseContext["deps"] };
    const start = tokens.findIndex(token => token.original === (qualifier ? "approximately" : "1"));
    const signs = clinicalQuantityLexicalRule().match(context, start);
    expect(signs).toHaveLength(1);
    expect(signs[0].tokens.map(token => token.original).join(" "))
      .toBe(qualifier + "1 million units per hour");
    const parsed = parseSig(source);
    const amounts = parsed.fhirNext.step!.flatMap(step => step.component.flatMap(component => component.doseAndRate ?? []));
    expect(amounts).toHaveLength(1);
    expect(amounts[0].rateQuantity).toMatchObject({ value: 1_000_000, unit: "[iU]/h" });
    expect(getQuantityComparator(amounts[0].rateQuantity)).toBe(qualifier ? "~" : undefined);
    expect(amounts[0].doseQuantity).toBeUndefined();
    expect(parsed.meta.leftoverText).toBeUndefined();
  });
});


describe("round 26: member-origin labels respect conservative calendar ordering", () => {
  it.each([[7, false], [30, true], [35, true]] as const)(
    "shows the %s-day origin under a one-month stage only when it adds timing information",
    (days, needsMemberNote) => {
      const native: CanonicalCourse = { kind: "course", stages: [{
        start: { anchor: "treatment-start", displacement: { value: 1, unit: "mo" } },
        administrations: [{ kind: "administration", phaseOrigin: { value: days, unit: "d" },
          amounts: [{ quantity: { value: 1, unit: "tab" } }] }]
      }] };
      const wire = courseToR6(native);
      for (const input of [native, wire]) {
        const text = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
        expect(text).toContain("From 1 month after treatment start onward");
        expect(text.includes("From " + days + " days after treatment start onward")).toBe(needsMemberNote);
        expect(text.match(/1 tablet/g)).toHaveLength(1);
      }
    }
  );
});


describe("round 27: authored phase relations constrain inheritance", () => {
  it("keeps a next-morning unitless dose after the preceding evening", () => {
    const parsed = parseSig("Take 1 tablet at 22:00, then 2 at 06:00 the next morning");
    expect(parsed.meta.canonical.clauses).toHaveLength(2);
    expect(parsed.meta.canonical.clauses[1].dose).toMatchObject({ value: 2, unit: "tab" });
    expect(parsed.meta.canonical.clauses[1].schedule).toMatchObject({
      phaseStartReference: "previous-phase-next-day", timeOfDay: ["06:00:00"]
    });
    expect(parsed.meta.canonical.clauses[1].site).toBeUndefined();
    expect(parsed.fhirNext.step).toHaveLength(2);
  });
  it("does not inherit injection as the method of a separate rate-only phase", () => {
    const parsed = parseSig("Inject 5 mg IV once, then IV at 1mg/hr");
    expect(parsed.meta.canonical.clauses).toHaveLength(2);
    expect(parsed.meta.canonical.clauses[0].method?.coding?.code).toBe("740685003");
    expect(parsed.meta.canonical.clauses[1].method).toBeUndefined();
    expect(parsed.meta.canonical.clauses[1].clinicalQuantity?.numerator).toMatchObject({ value: 1, unit: "mg" });
    const second = parsed.fhirNext.step[1].component[0];
    expect(second.method).toBeUndefined();
    expect(second.route?.coding?.[0]?.code).toBe("47625008");
    expect(second.doseAndRate?.[0]?.rateQuantity).toMatchObject({ value: 1, code: "mg/h" });
  });
});


describe("round 27: related relative-day and method families", () => {
  const clockOptions = { orderedAt: "2026-11-21T00:00:00Z", from: "2026-11-21T00:00:00Z", timeZone: "UTC", limit: 3 };
  it("continues unitless next-day daughters through a nonzero authored onset", () => {
    const source = "From day 5 take 1 tablet at 22:00 then 2 at 06:00 the next morning then 3 at 07:00 the following morning";
    const parsed = parseSig(source);
    expect(parsed.meta.canonical.clauses.map(clause => clause.dose)).toEqual([
      { value: 1, unit: "tab" }, { value: 2, unit: "tab" }, { value: 3, unit: "tab" }
    ]);
    expect(parsed.meta.canonical.clauses.map(clause => clause.schedule?.treatmentStartOffsetDays)).toEqual([4, undefined, undefined]);
    expect(parsed.meta.canonical.clauses.slice(1).map(clause => clause.schedule?.phaseStartReference))
      .toEqual(["previous-phase-next-day", "previous-phase-next-day"]);
    expect(nextDueDoses(parsed, clockOptions)).toEqual([
      "2026-11-25T22:00:00+00:00", "2026-11-26T06:00:00+00:00", "2026-11-27T07:00:00+00:00"
    ]);
  });
  it("anchors next morning to a dated predecessor without a contradictory treatment offset", () => {
    const parsed = parseSig("Take 1 tablet on 2026-11-25 at 22:00 then 2 at 06:00 the next morning");
    const next = parsed.meta.canonical.clauses[1].schedule;
    expect(next?.boundsStart).toBe("2026-11-26");
    expect(next?.treatmentStartOffsetDays).toBeUndefined();
    expect(nextDueDoses(parsed, { ...clockOptions, limit: 2 })).toEqual([
      "2026-11-25T22:00:00+00:00", "2026-11-26T06:00:00+00:00"
    ]);
  });
  it.each([
    ["Inject 5 mg IV once, then 2 mg IV daily", "740685003"],
    ["Infuse 2 mg/hr for 1 day, then IV at 1mg/hr", "764794000"]
  ])("retains a genuine shared administration method in %s", (source, code) => {
    const parsed = parseSig(source);
    expect(parsed.meta.canonical.clauses).toHaveLength(2);
    expect(parsed.meta.canonical.clauses[1].method?.coding?.code).toBe(code);
    expect(parsed.fhirNext.step[1].component[0].method?.coding?.[0].code).toBe(code);
  });
});


it("round 27: a mid-clause onset modifies its unscheduled dose before later next-day phases", () => {
  const source = "Take 1 tablet from day 5 at 22:00, then 2 at 06:00 the next morning, then 3 at 07:00 the following morning";
  const parsed = parseSig(source);
  expect(parsed.meta.canonical.clauses.map(clause => clause.dose?.value)).toEqual([1, 2, 3]);
  expect(parsed.meta.canonical.clauses.map(clause => clause.schedule?.treatmentStartOffsetDays)).toEqual([4, undefined, undefined]);
    expect(parsed.meta.canonical.clauses.slice(1).map(clause => clause.schedule?.phaseStartReference))
      .toEqual(["previous-phase-next-day", "previous-phase-next-day"]);
  expect(parsed.meta.canonical.clauses.map(clause => clause.schedule?.timeOfDay)).toEqual([
    ["22:00:00"], ["06:00:00"], ["07:00:00"]
  ]);
  expect(nextDueDoses(parsed, { orderedAt: "2026-11-21T00:00:00Z", from: "2026-11-21T00:00:00Z", timeZone: "UTC", limit: 3 }))
    .toEqual(["2026-11-25T22:00:00+00:00", "2026-11-26T06:00:00+00:00", "2026-11-27T07:00:00+00:00"]);
  expect(parsed.meta.canonical.course?.instruction).toBe(source);
});


it.each([
  "Take 1 tablet from day 5 take 2 tablets at 22:00",
  "Take 1 tablet daily for 3 days from day 5 take 2 tablets daily"
])("round 27: preserves a separately headed phase after its onset: %s", source => {
  const parsed = parseSig(source);
  expect(parsed.meta.canonical.clauses.map(clause => clause.dose?.value)).toEqual([1, 2]);
  expect(parsed.meta.canonical.clauses[1].schedule?.treatmentStartOffsetDays).toBe(4);
});


describe("round 27: next-day continuation after a finite predecessor", () => {
  const options = { orderedAt: "2026-11-21T00:00:00Z", from: "2026-11-21T00:00:00Z", timeZone: "UTC", limit: 6 };
  it("starts the next morning after all five authored treatment days", () => {
    const parsed = parseSig("Take 1 tablet daily for 5 days then take 2 tablets at 06:00 the next morning");
    expect(parsed.meta.canonical.clauses[0].schedule?.duration).toBe(5);
    expect(parsed.meta.canonical.clauses[1].schedule?.phaseStartReference).toBe("previous-phase-next-day");
    expect(parsed.meta.canonical.clauses[1].schedule?.treatmentStartOffsetDays).toBeUndefined();
    expect(nextDueDoses(parsed, options)).toEqual([
      "2026-11-21T09:00:00+00:00", "2026-11-22T09:00:00+00:00", "2026-11-23T09:00:00+00:00",
      "2026-11-24T09:00:00+00:00", "2026-11-25T09:00:00+00:00", "2026-11-26T06:00:00+00:00"
    ]);
  });
  it("uses the same five-day endpoint when the successor omits its clock", () => {
    const parsed = parseSig("Take 1 tablet daily for 5 days then take 2 tablets the next day");
    expect(parsed.meta.canonical.clauses[1].schedule?.phaseStartReference).toBe("previous-phase-next-day");
    expect(parsed.meta.canonical.clauses[1].schedule?.treatmentStartOffsetDays).toBeUndefined();
    expect(parsed.meta.canonical.course?.stages[1].start).toMatchObject({ anchor: "previous-phase-next-day" });
  });
  it("adds the finite duration to an already delayed predecessor origin", () => {
    const parsed = parseSig("From day 5 take 1 tablet daily for 5 days then take 2 tablets at 06:00 the next morning");
    expect(parsed.meta.canonical.clauses.map(clause => clause.schedule?.treatmentStartOffsetDays)).toEqual([4, undefined]);
    expect(parsed.meta.canonical.clauses[1].schedule?.phaseStartReference).toBe("previous-phase-next-day");
    expect(nextDueDoses(parsed, options)).toEqual([
      "2026-11-25T09:00:00+00:00", "2026-11-26T09:00:00+00:00", "2026-11-27T09:00:00+00:00",
      "2026-11-28T09:00:00+00:00", "2026-11-29T09:00:00+00:00", "2026-11-30T06:00:00+00:00"
    ]);
  });
});


describe("round 27: next day follows finite administration count completion", () => {
  it.each(["06:00", "15:00"])("keeps all five doses before the next-day %s successor", clock => {
    const source = `Take 1 tablet daily for 5 doses then take 2 tablets at ${clock} the next day`;
    const parsed = parseSig(source);
    expect(parsed.meta.canonical.clauses[0].schedule?.count).toBe(5);
    expect(parsed.meta.canonical.clauses[0].schedule?.duration).toBeUndefined();
    expect(parsed.meta.canonical.clauses[1].schedule?.phaseStartReference).toBe("previous-phase-next-day");
    expect(parsed.meta.canonical.clauses[1].schedule?.treatmentStartOffsetDays).toBeUndefined();
    expect(parsed.meta.canonical.clauses[1].dose).toMatchObject({ value: 2, unit: "tab" });
    for (const [orderedAt, expectedPrior, expectedDate] of [
      ["2026-11-21T00:00:00Z", ["2026-11-21T09:00:00+00:00", "2026-11-22T09:00:00+00:00", "2026-11-23T09:00:00+00:00", "2026-11-24T09:00:00+00:00", "2026-11-25T09:00:00+00:00"], "2026-11-26"],
      ["2026-11-21T18:00:00Z", ["2026-11-22T09:00:00+00:00", "2026-11-23T09:00:00+00:00", "2026-11-24T09:00:00+00:00", "2026-11-25T09:00:00+00:00", "2026-11-26T09:00:00+00:00"], "2026-11-27"]
    ] as const) {
      expect(nextDueDoses(parsed, { orderedAt, from: orderedAt, timeZone: "UTC", limit: 6 }))
        .toEqual([...expectedPrior, `${expectedDate}T${clock}:00+00:00`]);
    }
  });
  it("keeps a calendar-month predecessor governed by its complete calendar duration", () => {
    const parsed = parseSig("Take 1 tablet daily for 1 month then take 2 tablets at 06:00 the next morning");
    expect(parsed.meta.canonical.clauses[0].schedule).toMatchObject({ duration: 1, durationUnit: "mo" });
    expect(parsed.meta.canonical.clauses[1].schedule?.treatmentStartOffsetDays).toBeUndefined();
    expect(nextDueDoses(parsed, { orderedAt: "2026-11-21T00:00:00Z", from: "2026-12-20T00:00:00Z", timeZone: "UTC", limit: 2 }))
      .toEqual(["2026-12-20T09:00:00+00:00", "2026-12-21T06:00:00+00:00"]);
  });
});


it("round 27: carries a contextual next-day origin through another finite next-day daughter", () => {
  const source = "Take 1 tablet daily for 5 doses then take 2 tablets once at 06:00 the next day then take 3 tablets once at 15:00 the following day";
  const parsed = parseSig(source);
  expect(parsed.meta.canonical.clauses.map(clause => clause.schedule?.count)).toEqual([5, 1, 1]);
  expect(parsed.meta.canonical.clauses.map(clause => clause.schedule?.phaseStartReference)).toEqual([
    undefined, "previous-phase-next-day", "previous-phase-next-day"
  ]);
  expect(parsed.meta.canonical.clauses.slice(1).every(clause => clause.schedule?.treatmentStartOffsetDays === undefined)).toBe(true);
  expect(nextDueDoses(parsed, { orderedAt: "2026-11-21T00:00:00Z", from: "2026-11-21T00:00:00Z", timeZone: "UTC", limit: 7 }))
    .toEqual(["2026-11-21T09:00:00+00:00", "2026-11-22T09:00:00+00:00", "2026-11-23T09:00:00+00:00", "2026-11-24T09:00:00+00:00", "2026-11-25T09:00:00+00:00", "2026-11-26T06:00:00+00:00", "2026-11-27T15:00:00+00:00"]);
});


it("round 27: shares contextual onset across coordinated successor doses", () => {
  const parsed = parseSig("Take 1 tablet daily for 5 doses then take 2 tablets at 06:00 the next day and 3 tablets at 15:00");
  expect(parsed.meta.canonical.clauses.map(clause => clause.dose?.value)).toEqual([1, 2, 3]);
  expect(parsed.meta.canonical.clauses.slice(1).map(clause => clause.schedule?.phaseStartReference))
    .toEqual(["previous-phase-next-day", "previous-phase-next-day"]);
  expect(parsed.meta.canonical.course?.stages).toHaveLength(2);
  expect(parsed.meta.canonical.course?.stages[1].start?.anchor).toBe("previous-phase-next-day");
  expect(parsed.meta.canonical.course?.stages[1].administrations).toHaveLength(2);
});

it.each([
  ["fronted", "Take 1 tablet daily for 5 doses then take 2 tablets at 06:00 the next day and from day 10 take 3 tablets at 15:00"],
  ["postposed", "Take 1 tablet daily for 5 doses then take 2 tablets at 06:00 the next day and 3 tablets from day 10 at 15:00"]
])("round 27: preserves a member's independent %s authored onset beside a contextual next-day member", (_position, source) => {
  const parsed = parseSig(source);
  expect(parsed.meta.canonical.clauses.map(clause => clause.dose?.value)).toEqual([1, 2, 3]);
  expect(parsed.meta.canonical.clauses[1].schedule?.phaseStartReference).toBe("previous-phase-next-day");
  expect(parsed.meta.canonical.clauses[2].schedule?.phaseStartReference).toBe("treatment-day-start");
  expect(parsed.meta.canonical.clauses[2].schedule?.treatmentStartOffsetDays).toBe(9);
  const phase = parsed.meta.canonical.course!.stages[1];
  expect(phase.start).toBeUndefined();
  expect(phase.administrations[0].phaseStart?.anchor).toBe("previous-phase-next-day");
  expect(phase.administrations[1].onsetDays).toBe(9);
  expect(phase.administrations[1].phaseStart).toMatchObject({
    anchor: "treatment-day-start", displacement: { value: 9, unit: "d" }
  });
  expect(nextDueDoses(parsed, {
    orderedAt: "2026-11-21T00:00:00Z", from: "2026-11-29T00:00:00Z", timeZone: "UTC", limit: 5
  })).toEqual([
    "2026-11-29T06:00:00+00:00", "2026-11-30T06:00:00+00:00", "2026-11-30T15:00:00+00:00",
    "2026-12-01T06:00:00+00:00", "2026-12-01T15:00:00+00:00"
  ]);
});


describe("round 28: retained phase origins and clinical meaning", () => {
  it("keeps each numeric member onset after a finite shared predecessor", () => {
    const native = courseFromAdministrations([
      { kind: "administration", stageOrdinal: 1, amounts: [{ quantity: { value: 1, unit: "tab" } }],
        schedule: { recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          courseLength: { value: 3, unit: "d" }, clocks: ["09:00:00"] } } },
      { kind: "administration", stageOrdinal: 2, onsetDays: 3,
        amounts: [{ quantity: { value: 2, unit: "tab" } }],
        schedule: { recurrence: { count: 1, clocks: ["06:00:00"] } } },
      { kind: "administration", stageOrdinal: 2, onsetDays: 9,
        amounts: [{ quantity: { value: 3, unit: "tab" } }],
        schedule: { recurrence: { count: 1, clocks: ["07:00:00"] } } }
    ], "Three daily doses, then separate day-4 and day-10 administrations");
    expect(native.stages[1].administrations.map(a => a.phaseOrigin)).toEqual([
      { value: 3, unit: "d" }, { value: 9, unit: "d" }
    ]);
    const r6 = courseToR6(native);
    for (const input of [native, r6, toFhirR5Dosages(r6)]) {
      expect(nextDueDoses(input, {
        orderedAt: "2026-11-21T00:00:00Z", from: "2026-11-21T00:00:00Z",
        timeZone: "UTC", limit: 8
      })).toEqual([
        "2026-11-21T09:00:00+00:00", "2026-11-22T09:00:00+00:00",
        "2026-11-23T09:00:00+00:00", "2026-11-24T06:00:00+00:00",
        "2026-11-30T07:00:00+00:00"
      ]);
    }
  });

  it("retains the right-eye predecessor independently of a continuing left-eye course", () => {
    const parsed = parseSig("1 drop OD daily for 5 doses then 2 drops OD at 06:00 the next day; 1 drop OS BID");
    const members = parsed.meta.canonical.course!.stages.flatMap(stage => stage.administrations);
    expect(members).toHaveLength(3);
    expect(members[0].sourceMember).toBe(0);
    expect(members[0].phasePredecessors).toEqual([]);
    expect(members[1].sourceMember).toBe(1);
    expect(members[1].phasePredecessors).toEqual([0]);
    expect(members[1].phaseStart?.anchor).toBe("previous-phase-next-day");
    expect(members[2].sourceMember).toBe(2);
    expect(members[2].phasePredecessors).toBeUndefined();
    const imported = courseFromR6(toDosageDetails(toFhirR5Dosages(parsed.fhirNext)));
    const participants = imported.stages.flatMap(stage => stage.administrations)
      .filter(a => a.phasePredecessors !== undefined);
    expect(participants.map(a => [a.sourceMember, a.phasePredecessors])).toEqual([[0, []], [1, [0]]]);
  });

  it.each([
    ["UTC", "2026-11-21T08:00:00Z", ["2026-11-21T22:00:00+00:00", "2026-11-22T06:00:00+00:00"]],
    ["UTC", "2026-11-21T23:00:00Z", ["2026-11-22T22:00:00+00:00", "2026-11-23T06:00:00+00:00"]],
    ["Asia/Bangkok", "2026-11-21T08:00:00+07:00", ["2026-11-21T22:00:00+07:00", "2026-11-22T06:00:00+07:00"]],
    ["Asia/Bangkok", "2026-11-21T23:00:00+07:00", ["2026-11-22T22:00:00+07:00", "2026-11-23T06:00:00+07:00"]]
  ])("starts the next morning on the next local date in %s", (timeZone, orderedAt, expected) => {
    for (const frequency of ["", "daily ", "QD "]) {
      const parsed = parseSig("Take 1 tablet " + frequency + "at 22:00, then 2 at 06:00 the next morning");
      const native = parsed.meta.canonical.course!;
      expect(native.stages[0].administrations[0].schedule?.recurrence?.count).toBe(1);
      if (frequency) expect(native.stages[0].administrations[0].schedule?.recurrence).toMatchObject({
        frequency: 1, period: 1, periodUnit: "d"
      });
      expect(native.stages[1].start).toMatchObject({ anchor: "previous-phase-next-day" });
      for (const input of [parsed, parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
        expect(nextDueDoses(input, { orderedAt: orderedAt as string, from: orderedAt as string,
          timeZone: timeZone as string, limit: 2 })).toEqual(expected);
      }
    }
  });

  it("keeps an authored treatment day at local midnight for an early clock", () => {
    const parsed = parseSig("From day 5 take 1 tablet at 06:00 once");
    expect(parsed.meta.canonical.course!.stages[0].start).toMatchObject({
      anchor: "treatment-day-start", displacement: { value: 4, unit: "d" }
    });
    for (const input of [parsed, parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(nextDueDoses(input, { orderedAt: "2026-11-21T12:00:00Z",
        from: "2026-11-21T12:00:00Z", timeZone: "UTC", limit: 1 }))
        .toEqual(["2026-11-25T06:00:00+00:00"]);
    }
    const elapsed: CanonicalCourse = { kind: "course", stages: [{
      start: { anchor: "treatment-start", displacement: { value: 4, unit: "d" } },
      administrations: [{ kind: "administration", amounts: [{ quantity: { value: 1, unit: "tab" } }],
        schedule: { recurrence: { count: 1, clocks: ["06:00:00"] } } }]
    }] };
    expect(nextDueDoses(elapsed, { orderedAt: "2026-11-21T12:00:00Z",
      from: "2026-11-21T12:00:00Z", timeZone: "UTC", limit: 1 }))
      .toEqual(["2026-11-26T06:00:00+00:00"]);
  });

  it.each([
    ["approximately ", "~", [undefined, undefined, undefined]],
    ["at most ", "<=", [undefined, undefined, undefined]],
    ["", undefined, [undefined, undefined, undefined]]
  ] as const)("does not turn a %sfive-day course into exact later origins", (qualifier, comparator, expected) => {
    const source = "Take 1 tablet daily at 09:00 for 5 days then 2 tablets at 06:00 the next morning then 3 tablets at 07:00 the following morning";
    const plan = createBoundaryPlan(source);
    const states = plan.segments.map(segment => parseClauseState(segment.text));
    const graph = buildRegimenGraph(plan, plan.segments);
    // The sequence construction accepts an already typed duration operator;
    // recognizing a new duration wording is a separate lexical feature.
    states[0].primaryClause.schedule!.durationComparator = comparator;
    scopeSequentialPhaseSemantics(states, plan.segments, graph, source);
    expect(states).toHaveLength(3);
    expect(states[0].primaryClause.schedule?.durationComparator).toBe(comparator);
    expect(states.map(state => state.primaryClause.schedule?.treatmentStartOffsetDays)).toEqual(expected);
    expect(states.map(state => state.primaryClause.dose?.value)).toEqual([1, 2, 3]);
    expect(states[2].primaryClause.schedule?.phaseStartReference).toBe("previous-phase-next-day");
    if (!comparator) {
      const course = courseFromAdministrations(states.map((state, index) =>
        administrationFromClause(state.primaryClause, plan.segments[index].text, index + 1)), source);
      expect(nextDueDoses(course, { orderedAt: "2026-11-21T23:00:00Z",
        from: "2026-11-26T00:00:00Z", timeZone: "UTC", limit: 3 })).toEqual([
        "2026-11-26T09:00:00+00:00", "2026-11-27T06:00:00+00:00", "2026-11-28T07:00:00+00:00"
      ]);
    }
  });

  it("retains an approximate omitted-unit dose before a weekday preposition", () => {
    const parsed = parseSig("Take 2 tablets daily then approximately 1 on Mondays");
    const next = parsed.meta.canonical.clauses[1];
    expect(next.dose).toMatchObject({ value: 1, unit: "tab", comparator: "~" });
    expect(next.schedule?.dayOfWeek).toEqual(["mon"]);
    for (const details of [parsed.fhirNext, toDosageDetails(toFhirR5Dosages(parsed.fhirNext))]) {
      const component = details.step![1].component[0];
      expect(getQuantityComparator(component.doseAndRate![0].doseQuantity)).toBe("~");
      expect(component.timing?.repeat?.dayOfWeek).toEqual(["mon"]);
    }
  });

  it.each([
    ["Dilute 1 mL with 9 mL normal saline to 10 mL", "Dilute 1 mL with 9 mL normal saline to 10 mL"],
    ["Dilute 1 mL with normal saline to 10 mL", "Dilute 1 mL with normal saline to 10 mL"],
    ["Dilute 1 mL to 10 mL", "Dilute 1 mL to 10 mL"]
  ])("keeps every measured material in %s", (source, expected) => {
    const frame = parseInstructionActions(source)[0];
    const snapshot = JSON.stringify(frame);
    expect(realizeInstructionAction(frame, "en")).toBe(expected);
    expect(JSON.stringify(frame)).toBe(snapshot);
    const parsed = parseSig(source);
    for (const input of [parsed.meta.canonical.course!, parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toContain(expected);
    }
    expect(parsed.meta.canonical.course?.instruction).toBe(source);
  });
});


it("round 28: preserves a local-day origin through a finite partial-track successor", () => {
  const source = "From day 5 instill 1 drop OD at 06:00 daily for 3 days then instill 2 drops OD at 07:00 once; 1 drop OS BID";
  const parsed = parseSig(source);
  const members = parsed.meta.canonical.course!.stages.flatMap(stage => stage.administrations);
  expect(members).toHaveLength(3);
  expect(members[0].phaseStart).toMatchObject({
    anchor: "treatment-day-start", displacement: { value: 4, unit: "d" }
  });
  expect(members[1].phaseStart).toMatchObject({
    anchor: "treatment-day-start", displacement: { value: 7, unit: "d" }
  });
  // The unrelated left eye stays independent; project the already typed
  // right-eye track to assert its literal clinical clocks without queue noise.
  const right: CanonicalCourse = { kind: "course", stages: [{ administrations: members.slice(0, 2) }] };
  const details = courseToR6(right);
  for (const input of [right, details, toFhirR5Dosages(details)]) {
    expect(nextDueDoses(input, { orderedAt: "2026-11-21T12:00:00Z",
      from: "2026-11-21T12:00:00Z", timeZone: "UTC", limit: 5 })).toEqual([
      "2026-11-25T06:00:00+00:00", "2026-11-26T06:00:00+00:00",
      "2026-11-27T06:00:00+00:00", "2026-11-28T07:00:00+00:00"
    ]);
  }
});


it("round 28: does not carry a partial-track day origin through a qualified end", () => {
  const source = "From day 5 instill 1 drop OD daily for 3 days then instill 2 drops OD at 07:00 once; 1 drop OS BID";
  const plan = createBoundaryPlan(source);
  const states = plan.segments.map(segment => parseClauseState(segment.text));
  const graph = buildRegimenGraph(plan, plan.segments);
  states[0].primaryClause.schedule!.durationComparator = "~";
  scopeSequentialPhaseSemantics(states, plan.segments, graph, source);
  const regimen = buildCanonicalParallelRegimen(states.map(state => state.primaryClause), plan.segments, plan, graph);
  expect(regimen.kind).toBe("unresolved");
  if (regimen.kind !== "unresolved") throw new Error("Expected independently retained partial tracks");
  const course = courseFromPartialParallel(regimen, plan.segments.map(segment => segment.text), source);
  expect(course.stages[0].administrations[0].phaseStart).toMatchObject({
    anchor: "treatment-day-start", displacement: { value: 4, unit: "d" }
  });
  expect(course.stages[0].administrations[0].schedule?.recurrence?.courseLength?.comparator).toBe("~");
  expect(course.stages[0].administrations[1].phaseStart?.anchor).toBe("unresolved");
  expect(course.stages[0].administrations[1].phaseOrigin).toBeUndefined();
});


it("round 28: retains a typed waiting duration without appending a second nominal", () => {
  const frame = parseInstructionActions("รอ 5 นาที")[0];
  const quantity = frame.args.find(arg => arg.quantity);
  expect(quantity?.quantity).toMatchObject({ value: 5, unit: "min" });
  expect(realizeInstructionAction(frame, "en")).toBe("Wait 5 minutes");
  const reparsed = parseInstructionActions(realizeInstructionAction(frame, "en"))[0];
  expect(reparsed.args.filter(arg => arg.quantity)).toHaveLength(1);
  expect(reparsed.args.some(arg => arg.role === AdviceArgumentRole.Activity)).toBe(false);
});


it("round 28: keeps standalone and explicit recurrent clock phases unchanged", () => {
  const standalone = parseSig("Take 1 tablet at 22:00");
  expect(standalone.meta.canonical.clauses[0].schedule?.count).toBeUndefined();
  expect(nextDueDoses(standalone, { orderedAt: "2026-11-21T23:00:00Z",
    from: "2026-11-21T23:00:00Z", timeZone: "UTC", limit: 2 })).toEqual([
    "2026-11-22T22:00:00+00:00", "2026-11-23T22:00:00+00:00"
  ]);
  const recurring = parseSig("Take 1 tablet every 2 days at 22:00 then 2 at 06:00 the next morning");
  expect(recurring.meta.canonical.clauses[0].schedule?.count).toBeUndefined();
  expect(recurring.meta.canonical.clauses[0].schedule).toMatchObject({
    period: 2, periodUnit: "d", timeOfDay: ["22:00:00"]
  });
  const authoredCount = parseSig("Take 1 tablet daily at 22:00 for 3 doses then 2 at 06:00 the next morning");
  expect(authoredCount.meta.canonical.clauses[0].schedule?.count).toBe(3);
});


describe("round 28: explicit routes delimit inherited administration sites", () => {
  it("does not carry rectal anatomy into an oral daughter or its later ellipsis", () => {
    const source = "1 tab suppo at 08:00, 1 tab PO at 12:00, 2 tabs at 18:00";
    const parsed = parseSig(source);
    expect(parsed.items).toHaveLength(3);
    expect(parsed.meta.canonical.clauses[0].site?.text).toBe("rectum");
    for (const index of [1, 2]) {
      expect(parsed.meta.canonical.clauses[index].route?.text).toBe("by mouth");
      expect(parsed.meta.canonical.clauses[index].site).toBeUndefined();
      expect(parsed.fhir[index].site).toBeUndefined();
      expect(parsed.items[index].shortText).not.toMatch(/rectum|rectal/iu);
    }
    expect(parsed.meta.canonical.course?.instruction).toBe(source);
  });

  it("preserves an explicitly authored site on the new route", () => {
    const source = "Instill 1 drop in the right eye at 08:00, instill 1 drop in the left ear at 12:00";
    const parsed = parseSig(source);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.meta.canonical.clauses[1].route?.code).toBe("10547007");
    expect(parsed.fhir[1].route?.coding?.[0].code).toBe("10547007");
    expect(parsed.meta.canonical.clauses[1].site?.coding?.code).toBe("89644007");
    expect(parsed.fhir[1].site?.coding?.[0].code).toBe("89644007");
    expect(parsed.meta.canonical.course?.instruction).toBe(source);
  });

  it("preserves the inherited eye for an unchanged explicit route", () => {
    const source = "1 drop OD at 08:00, 2 drops OPH at 18:00";
    const parsed = parseSig(source);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.meta.canonical.clauses[1].site?.coding?.code)
      .toBe(parsed.meta.canonical.clauses[0].site?.coding?.code);
    expect(parsed.meta.canonical.clauses[1].site?.text).toBe("right eye");
    expect(parsed.meta.canonical.course?.instruction).toBe(source);
  });
});


describe("round 28: dirty PRN previews preserve authored reason qualifiers", () => {
  it.each([false, true])("keeps an unrecognized qualified reason after a cap edit (saved=%s)", saved => {
    const parsed = parseSig("Take 1 tablet PO daily as needed for pain max 2 tablets/day");
    const row = saved ? JSON.parse(JSON.stringify(parsed.fhir[0])) as FhirDosage : parsed.fhir[0];
    const source = row.text;
    row.asNeededFor![0].text = "severe breakthrough pain when standing";
    row.maxDosePerPeriod![0].numerator!.value = 3;
    const edited = JSON.stringify(row);
    for (const realizationMode of ["normalized", "roundtrip"] as const) {
      const text = formatSig(row, "long", { locale: "en", realizationMode });
      expect(text).toContain("severe breakthrough pain when standing");
      expect(text).toContain("max per period: 3 tab / 1 d");
    }
    expect(JSON.stringify(row)).toBe(edited);
    expect(row.text).toBe(source);
  });
});


describe("round 29: typed onsets and complete numeric daughters", () => {
  it.each([3, 9])("keeps terminal parallel member onset %s independent of its sibling", later => {
    const source = "1 drop OD daily for 3 days then 2 drops OD at 06:00 daily and 3 drops OD at 07:00 daily; 1 drop OS at 08:00 daily";
    const plan = createBoundaryPlan(source);
    const states = plan.segments.map(segment => parseClauseState(segment.text));
    const graph = buildRegimenGraph(plan, plan.segments);
    expect(graph.phases.map(phase => phase.members)).toEqual([[0], [1, 2], [3]]);
    // These are input facts to the regimen compiler, before a course exists.
    states[1].primaryClause.schedule!.treatmentStartOffsetDays = 3;
    states[2].primaryClause.schedule!.treatmentStartOffsetDays = later;
    const regimen = buildCanonicalParallelRegimen(states.map(state => state.primaryClause), plan.segments, plan, graph);
    expect(regimen.kind).toBe(later === 3 ? "resolved" : "unresolved");
    if (regimen.kind === "not-parallel") throw new Error("Expected independent tracks");
    const native = regimen.kind === "resolved"
      ? courseFromParallel(regimen, plan.segments.map(segment => segment.text), source)
      : courseFromPartialParallel(regimen, plan.segments.map(segment => segment.text), source);
    const r6 = courseToR6(native);
    const expected = later === 3 ? [
      "2026-11-24T06:00:00+00:00", "2026-11-24T07:00:00+00:00", "2026-11-24T08:00:00+00:00"
    ] : [
      "2026-11-24T06:00:00+00:00", "2026-11-24T08:00:00+00:00",
      "2026-11-25T06:00:00+00:00", "2026-11-25T08:00:00+00:00",
      "2026-11-26T06:00:00+00:00", "2026-11-26T08:00:00+00:00",
      "2026-11-27T06:00:00+00:00", "2026-11-27T08:00:00+00:00",
      "2026-11-28T06:00:00+00:00", "2026-11-28T08:00:00+00:00",
      "2026-11-29T06:00:00+00:00", "2026-11-29T08:00:00+00:00",
      "2026-11-30T06:00:00+00:00", "2026-11-30T07:00:00+00:00", "2026-11-30T08:00:00+00:00"
    ];
    for (const input of [native, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      expect(nextDueDoses(input, { orderedAt: "2026-11-21T00:00:00Z",
        from: "2026-11-24T00:00:00Z", timeZone: "UTC", limit: expected.length })).toEqual(expected);
    }
  });

  it.each([0, 7])("ends each seven-day member relative to its own onset (%s)", onsetDays => {
    const native = courseFromAdministrations([
      { kind: "administration", amounts: [{ quantity: { value: 1, unit: "tab" } }],
        schedule: { recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          courseLength: { value: 7, unit: "d" }, clocks: ["09:00:00"] } } },
      { kind: "administration", ...(onsetDays ? { onsetDays } : {}),
        amounts: [{ quantity: { value: 2, unit: "tab" } }],
        schedule: { recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          courseLength: { value: 7, unit: "d" }, clocks: ["09:00:00"] } } }
    ], "Two seven-day member courses with independently authored starts");
    if (onsetDays) expect(native.stages[0].end).toBeUndefined();
    else expect(native.stages[0].end).toMatchObject({ displacement: { value: 7, unit: "d" } });
    const expected = Array.from({ length: 14 }, (_, index) =>
      new Date(Date.UTC(2026, 10, 21 + (onsetDays ? index : Math.floor(index / 2)), 9))
        .toISOString().replace(".000Z", "+00:00"));
    const r6 = courseToR6(native);
    for (const input of [native, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      const context = { orderedAt: "2026-11-21T00:00:00Z", from: "2026-11-21T00:00:00Z", timeZone: "UTC" };
      expect(nextDueDoses(input, { ...context, limit: 20 })).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...context,
        durationValue: 15, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(21);
    }
  });

  it("retains QID coding and uses configured code clocks across all projections", () => {
    const parsed = parseSig("1 tab PO QID");
    const coding = { system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "QID" };
    expect(parsed.meta.canonical.course!.stages[0].administrations[0].schedule?.code?.coding).toEqual([coding]);
    const options = { orderedAt: "2026-11-21T00:00:00Z", from: "2026-11-21T00:00:00Z",
      timeZone: "UTC", limit: 4, frequencyDefaults: {
        byCode: { QID: ["05:00", "11:00", "17:00", "23:00"] },
        byFrequency: { "freq:4/d": ["06:00", "12:00", "18:00", "22:00"] }
      } };
    for (const input of [parsed, parsed.meta.canonical.course!, parsed.fhirNext,
        JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)))]) {
      expect(nextDueDoses(input, options)).toEqual([
        "2026-11-21T05:00:00+00:00", "2026-11-21T11:00:00+00:00",
        "2026-11-21T17:00:00+00:00", "2026-11-21T23:00:00+00:00"
      ]);
    }
  });

  it.each([true, false])("uses the preceding phase's authored onset before an inferred one (%s)", authored => {
    const source = "Take 1 tablet daily for 3 days, then " + (authored ? "from day 10 " : "") +
      "take 2 tablets daily for 2 days, then take 1 tablet at 06:00 the next morning";
    const parsed = parseSig(source);
    expect(parsed.meta.canonical.clauses[parsed.meta.canonical.clauses.length - 1]?.schedule?.phaseStartReference).toBe("previous-phase-next-day");
    expect(parsed.meta.canonical.clauses[parsed.meta.canonical.clauses.length - 1]?.schedule?.treatmentStartOffsetDays).toBeUndefined();
    const day = authored ? "2026-12-02" : "2026-11-26";
    for (const input of [parsed, parsed.fhirNext, JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)))]) {
      expect(nextDueDoses(input, { orderedAt: "2026-11-21T00:00:00Z",
        from: day + "T00:00:00Z", timeZone: "UTC", limit: 1 })).toEqual([day + "T06:00:00+00:00"]);
    }
  });

  it("copies the complete target onset onto continued ADD members", () => {
    const parsed = parseSig("Take 1 tablet at 08:00 daily for 3 days then from day 5 add 1 tablet at 06:00 daily");
    expect(parsed.meta.canonical.course!.stages[1].start).toMatchObject({
      anchor: "treatment-day-start", displacement: { value: 4, unit: "d" }
    });
    for (const clause of parsed.meta.canonical.clauses.slice(1)) expect(clause.schedule).toMatchObject({
      treatmentStartOffsetDays: 4, phaseStartReference: "treatment-day-start"
    });
    for (const input of [parsed, parsed.fhirNext, JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)))]) {
      expect(nextDueDoses(input, { orderedAt: "2026-11-21T12:00:00Z",
        from: "2026-11-25T00:00:00Z", timeZone: "UTC", limit: 4 })).toEqual([
        "2026-11-25T06:00:00+00:00", "2026-11-25T08:00:00+00:00",
        "2026-11-26T06:00:00+00:00", "2026-11-26T08:00:00+00:00"
      ]);
    }
  });

  it.each([
    ["UTC", "2026-11-21T15:00:00Z", "2026-11-22T06:00:00+00:00"],
    ["Asia/Bangkok", "2026-11-21T15:00:00+07:00", "2026-11-22T06:00:00+07:00"]
  ])("anchors a standalone next morning to the next local day in %s", (timeZone, orderedAt, expected) => {
    const parsed = parseSig("Take 1 tablet the next morning");
    expect(parsed.meta.canonical.course!.stages[0].start).toMatchObject({
      anchor: "treatment-day-start", displacement: { value: 1, unit: "d" }
    });
    for (const input of [parsed, parsed.fhirNext, JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)))]) {
      expect(nextDueDoses(input, { orderedAt, from: orderedAt, timeZone,
        eventClock: { MORN: "06:00" }, limit: 1 })).toEqual([expected]);
    }
  });

  it.each([
    ["three quarters", 0.75, undefined],
    ["3 quarters", 0.75, undefined],
    ["approximately three quarters", 0.75, "~"],
    ["three quarters million", 750000, undefined]
  ] as const)("keeps the complete %s quantity in a rate", (phrase, value, comparator) => {
    const unit = phrase.includes("million") ? "units" : "mL";
    const source = "Infuse " + phrase + " " + unit + " per hour";
    const tokens = tokenize(source);
    const context: HpsgClauseContext = { state: new ParserState(source, tokens), tokens,
      limit: tokens.length, dateSpans: [], clinicalCache: {}, deps: {} as HpsgClauseContext["deps"] };
    const signs = clinicalQuantityLexicalRule().match(context, 1);
    expect(signs).toHaveLength(1);
    expect(signs[0].tokens.map(token => token.original).join(" ")).toBe(phrase + " " + unit + " per hour");
    expect(signs[0].synsem.head.dose?.clinicalQuantity?.numerator).toMatchObject({ value });
    const parsed = parseSig(source);
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0].clinicalQuantity?.numerator.value).toBe(value);
    for (const wire of [parsed.fhirNext, toDosageDetails(JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext))))]) {
      const rate = wire.step![0].component[0].doseAndRate![0].rateQuantity;
      expect(rate).toMatchObject({ value, unit: unit === "mL" ? "mL/h" : "[iU]/h" });
      expect(getQuantityComparator(rate)).toBe(comparator);
    }
  });
});


describe("round 29: method coding index", () => {
  it.each([
    ["738992009", "chew"],
    ["738995006", "swallow"],
    ["738991002", "apply"],
    ["785900008", "wash"],
    ["738990001", "administer"],
    ["419747000", "chew"],
  ])("resolves %s to its own administration action %s", (code, expected) => {
    for (const system of [undefined, "http://snomed.info/sct"]) {
      const coding = { system, code, display: "Superseded action wording" };
      const source = JSON.stringify(coding);
      expect(resolveMedicationInstructionActionByMethod(coding)?.code).toBe(expected);
      expect(JSON.stringify(coding)).toBe(source);
    }
  });

  it("does not infer a known method from another system or an unknown code's display", () => {
    expect(resolveMedicationInstructionActionByMethod({
      system: "urn:clinic:method", code: "738992009", display: "Chew"
    })).toBeUndefined();
    expect(resolveMedicationInstructionActionByMethod({
      system: "http://snomed.info/sct", code: "unknown-method", display: "Chew"
    })).toBeUndefined();
  });

  it("uses a custom displayed method only when its exact declared identity agrees", () => {
    const options: ParseOptions = { instructionActionMap: {
      masticate: { code: "clinic-chew", display: "Masticate", i18n: { th: "เคี้ยวช้าๆ" },
        administrationMethod: { system: "urn:clinic:method", code: "chew-slowly" } }
    } };
    expect(resolveMedicationInstructionActionByMethod({
      system: "urn:clinic:method", code: "chew-slowly", display: "Masticate"
    }, options)).toMatchObject({ code: "clinic-chew", display: "Masticate", i18n: { th: "เคี้ยวช้าๆ" } });
    expect(resolveMedicationInstructionActionByMethod({
      system: "urn:clinic:other-method", code: "chew-slowly", display: "Masticate"
    }, options)).toBeUndefined();
    expect(resolveMedicationInstructionActionByMethod({
      system: "urn:clinic:method", code: "chew-slowly"
    }, options)).toBeUndefined();
    expect(resolveMedicationInstructionActionByMethod({
      system: "urn:clinic:method", code: "unknown", display: "Masticate"
    }, options)).toBeUndefined();
  });
});


describe("round 30: completed phase origins and exact boundary display", () => {
  it.each([
    ["1.5 days", "2026-11-21T08:00:00Z", "2026-11-22T20:00:00Z", "2026-11-23T06:00:00+00:00"],
    ["1.5 days", "2026-11-21T20:00:00Z", "2026-11-23T08:00:00Z", "2026-11-24T06:00:00+00:00"],
    ["0.5 days", "2026-11-21T08:00:00Z", "2026-11-21T20:00:00Z", "2026-11-22T06:00:00+00:00"],
    ["0.5 weeks", "2026-11-21T08:00:00Z", "2026-11-24T20:00:00Z", "2026-11-25T06:00:00+00:00"]
  ])("follows the actual local completion day of a %s predecessor ordered at %s", (duration, orderedAt, from, expected) => {
    const source = "Take 1 tablet every 6 hours for " + duration + ", then take 2 tablets at 06:00 the next morning";
    const parsed = parseSig(source);
    const native = parsed.meta.canonical.course!;
    expect(native.stages[0].administrations[0].schedule?.recurrence?.courseLength?.value).toBe(Number(duration.split(" ")[0]));
    for (const input of [parsed, native, parsed.fhirNext, JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)))]) {
      const before = JSON.stringify(input);
      expect(nextDueDoses(input, { orderedAt, from, timeZone: "UTC", limit: 1 })).toEqual([expected]);
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(native.stages[1].start?.anchor).toBe("previous-phase-next-day");
  });

  it.each([false, true])("waits for each coordinated predecessor's own end (explicit first day %s)", explicit => {
    const source = (explicit ? "From day 1 take" : "Take") +
      " 1 tablet at 08:00 daily for 5 days and from day 4 take 2 tablets at 20:00 daily for 3 days, then take 3 tablets at 06:00 the next morning";
    const parsed = parseSig(source);
    const expected = [
      "2026-11-21T08:00:00+00:00", "2026-11-22T08:00:00+00:00", "2026-11-23T08:00:00+00:00",
      "2026-11-24T08:00:00+00:00", "2026-11-24T20:00:00+00:00",
      "2026-11-25T08:00:00+00:00", "2026-11-25T20:00:00+00:00",
      "2026-11-26T20:00:00+00:00", "2026-11-27T06:00:00+00:00"
    ];
    for (const input of [parsed, parsed.meta.canonical.course!, parsed.fhirNext,
      JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)))]) {
      const before = JSON.stringify(input);
      const context = { orderedAt: "2026-11-21T08:00:00Z", from: "2026-11-21T08:00:00Z", timeZone: "UTC" };
      expect(nextDueDoses(input, { ...context, limit: expected.length })).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...context, durationValue: 7, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(17);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each([
    ["Take 1 tablet every 6 hours for 1.5 days, then stop for 2 days, then take 2 tablets at 06:00 the next morning",
      "2026-11-22T20:00:00Z", ["2026-11-25T06:00:00+00:00"]],
    ["Take 1 tablet at 08:00 daily for 5 days and from day 4 take 2 tablets at 20:00 daily for 3 days, then stop for 2 days, then take 3 tablets at 06:00 the next morning and take 4 tablets at 07:00 daily",
      "2026-11-27T00:00:00Z", ["2026-11-29T06:00:00+00:00", "2026-11-29T07:00:00+00:00"]]
  ])("retains the terminal pause after a completed predecessor: %s", (source, from, expected) => {
    const parsed = parseSig(source as string);
    const next = parsed.meta.canonical.course!.stages[1];
    for (const input of [parsed, parsed.meta.canonical.course!, parsed.fhirNext,
      JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)))]) {
      expect(nextDueDoses(input, { orderedAt: "2026-11-21T08:00:00Z", from: from as string,
        timeZone: "UTC", limit: (expected as string[]).length })).toEqual(expected);
    }
    expect(next.start).toMatchObject({ anchor: "previous-phase-next-day", displacement: { value: 2, unit: "d" } });
  });

  it.each([
    [1.5, "s", 90, "2026-11-21T00:01:30+00:00"],
    [1, "min", 1, "2026-11-21T00:01:00+00:00"],
    [60, "h", 1, "2026-11-21T01:00:00+00:00"],
    [1.501, undefined, undefined, "2026-11-21T00:01:30.060+00:00"]
  ] as const)("keeps a %s-minute delay at its actual elapsed precision", (minutes, unit, value, expected) => {
    const native = courseFromAdministrations([{ kind: "administration", delayMinutes: minutes,
      amounts: [{ quantity: { value: 1, unit: "tab" } }],
      schedule: { recurrence: { count: 1, period: 6, periodUnit: FhirPeriodUnit.Hour } }
    }], "Administer one tablet after the stated delay");
    if (unit) {
      expect(native.stages[0].start?.displacement).toMatchObject({ unit, value });
      expect(native.stages[0].administrations[0].delayMinutes).toBeUndefined();
    } else {
      expect(native.stages[0].start).toBeUndefined();
      expect(native.stages[0].administrations[0].delayMinutes).toBe(minutes);
    }
    const r6 = courseToR6(native);
    for (const input of [native, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      expect(nextDueDoses(input, { orderedAt: "2026-11-21T00:00:00Z", from: "2026-11-21T00:00:00Z",
        timeZone: "UTC", limit: 2 })).toEqual([expected]);
    }
  });

  it.each(["low", "high"] as const)("shows the valued %s endpoint of an event-relative range", valued => {
    const range = { low: { unit: "d", ...(valued === "low" ? { value: 2 } : {}) },
      high: { unit: "d", ...(valued === "high" ? { value: 2 } : {}) } };
    const source: FhirR6DosageInstruction = { step: [{
      start: { contextCode: { text: "follow-up" }, offsetRange: range },
      component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] }]
    }] };
    const before = JSON.stringify(source);
    for (const input of [source, toDosageDetails(JSON.parse(JSON.stringify(toFhirR5Dosages(source))))]) {
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(en).toContain((valued === "low" ? ">=" : "<=") + "2 days after follow-up");
      expect(th).toContain((valued === "low" ? ">=" : "<=") + "2 วัน");
      expect(en).not.toContain(" – ");
      expect(th).not.toContain(" – ");
      expect(input.step![0].start?.offsetRange).toEqual(range);
    }
    expect(JSON.stringify(source)).toBe(before);
    source.step![0].start!.offsetRange!.low!.value = 1;
    source.step![0].start!.offsetRange!.high!.value = 2;
    expect(formatSig(source, "long", { locale: "en", realizationMode: "normalized" }))
      .toContain("1 day – 2 days after follow-up");
  });

  it.each([undefined, 1, 2] as const)("shows the inherited elapsed start beside a successor's end (repeat count %s)", count => {
    const native: CanonicalCourse = { kind: "course", stages: [
      { count, end: { anchor: "treatment-start", displacement: { value: 48, unit: "h" } },
        administrations: [{ kind: "administration", amounts: [{ quantity: { value: 1, unit: "tab" } }] }] },
      { end: { anchor: "treatment-start", displacement: { value: 4, unit: "d" } },
        administrations: [{ kind: "administration", amounts: [{ quantity: { value: 2, unit: "tab" } }] }] }
    ] };
    const before = JSON.stringify(native);
    const r6 = courseToR6(native);
    for (const text of [formatCanonicalCourse(native, "long", { locale: "en" }),
      formatSig(r6, "long", { locale: "en" }),
      formatSig(toFhirR5Dosages(r6), "long", { locale: "en" })]) {
      expect(text).toContain("2 tablets");
      expect(text).toContain("4 days after treatment start");
      if (count === 2) expect(text).not.toContain("From 48 hours after treatment start");
      else expect(text).toContain("From 48 hours after treatment start until 4 days after treatment start");
    }
    expect(JSON.stringify(native)).toBe(before);
  });
});

describe("round 31: conditional and qualified timing display", () => {
  it("keeps a shared two-hour delay after the previous phase's next-day origin", () => {
    const members = [
      { kind: "administration" as const, stageOrdinal: 1,
        amounts: [{ quantity: { value: 1, unit: "tab" } }],
        schedule: { recurrence: { count: 1, period: 6, periodUnit: FhirPeriodUnit.Hour } } },
      { kind: "administration" as const, stageOrdinal: 2,
        onsetReference: "previous-phase-next-day" as const, delayMinutes: 120,
        amounts: [{ quantity: { value: 2, unit: "tab" } }],
        schedule: { recurrence: { count: 1, period: 6, periodUnit: FhirPeriodUnit.Hour } } }
    ];
    const before = JSON.stringify(members);
    const native = courseFromAdministrations(members,
      "Take one tablet now; on the next day wait two hours before taking two tablets once");
    expect(native.stages[1].start).toMatchObject({ anchor: "previous-phase-next-day" });
    expect(native.stages[1].administrations[0].delayMinutes).toBe(120);
    const r6 = courseToR6(native);
    for (const input of [native, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      expect(nextDueDoses(input, { orderedAt: "2026-11-21T00:00:00Z",
        from: "2026-11-21T00:00:00Z", timeZone: "UTC", limit: 3 })).toEqual([
        "2026-11-21T00:00:00+00:00", "2026-11-22T02:00:00+00:00"
      ]);
    }
    expect(JSON.stringify(members)).toBe(before);
  });

  it("keeps the same delay relative to each member's independent calendar origin", () => {
    const native = courseFromAdministrations([
      { kind: "administration", onsetReference: "treatment-day-start", onsetDays: 1, delayMinutes: 120,
        amounts: [{ quantity: { value: 1, unit: "tab" } }],
        schedule: { recurrence: { count: 1, period: 6, periodUnit: FhirPeriodUnit.Hour } } },
      { kind: "administration", delayMinutes: 120,
        amounts: [{ quantity: { value: 2, unit: "tab" } }],
        schedule: { recurrence: { count: 1, period: 6, periodUnit: FhirPeriodUnit.Hour } } }
    ], "Take two tablets two hours after treatment begins and one tablet two hours after the next day begins");
    expect(native.stages[0].start).toBeUndefined();
    expect(native.stages[0].administrations.map(a => a.delayMinutes)).toEqual([120, 120]);
    const r6 = courseToR6(native);
    for (const input of [native, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      expect(nextDueDoses(input, { orderedAt: "2026-11-21T00:00:00Z",
        from: "2026-11-21T00:00:00Z", timeZone: "UTC", limit: 3 })).toEqual([
        "2026-11-21T02:00:00+00:00", "2026-11-22T02:00:00+00:00"
      ]);
    }
  });

  it.each([
    [1, undefined, "once", "1 ครั้ง"],
    [2, undefined, "twice", "2 ครั้ง"],
    [1, 2, "1 to 2 times", "1 ถึง 2 ครั้ง"],
    [undefined, 2, "up to 2 times", "ไม่เกิน 2 ครั้ง"]
  ] as const)("preserves count %s–%s within a ranged period in English and Thai", (frequency, frequencyMax, englishCount, thaiCount) => {
    for (const [unit, englishUnit, thaiUnit] of [
      [FhirPeriodUnit.Day, "days", "วัน"], [FhirPeriodUnit.Hour, "hours", "ชั่วโมง"],
      [FhirPeriodUnit.Minute, "minutes", "นาที"], [FhirPeriodUnit.Week, "weeks", "สัปดาห์"],
      [FhirPeriodUnit.Month, "months", "เดือน"], [FhirPeriodUnit.Year, "years", "ปี"]
    ] as const) {
      const source: FhirR6DosageInstruction = { step: [{ component: [{
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { frequency, frequencyMax, period: 1, periodMax: 2, periodUnit: unit } }
      }] }] };
      const before = JSON.stringify(source);
      const native = courseFromR6(source);
      expect(native.stages[0].administrations[0].schedule?.recurrence).toMatchObject({
        ...(frequency === undefined ? {} : { frequency }), ...(frequencyMax === undefined ? {} : { frequencyMax }),
        period: 1, periodMax: 2, periodUnit: unit
      });
      for (const input of [source, native, JSON.parse(JSON.stringify(toFhirR5Dosages(source)))]) {
        expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
          .toContain(englishCount + " every 1 to 2 " + englishUnit);
        if (frequency === undefined)
          expect(formatSig(input, "short", { locale: "en", realizationMode: "normalized" })).toContain("<=2x/1-2");
        for (const style of ["short", "long"] as const) {
          expect(formatSig(input, style, { locale: "th", realizationMode: "normalized" }))
            .toContain(thaiCount + " ทุก 1 ถึง 2 " + thaiUnit);
        }
      }
      expect(JSON.stringify(source)).toBe(before);
    }
  });

  it.each([undefined, 1])("keeps fixed daily wording when periodMax is %s", periodMax => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodMax, periodUnit: FhirPeriodUnit.Day } }
    }] }] };
    expect(formatSig(source, "long", { locale: "en", realizationMode: "normalized" })).toContain("once daily");
    expect(formatSig(source, "long", { locale: "th", realizationMode: "normalized" })).toContain("วันละครั้ง");
  });

  it("does not add a conditional response to a cap that has none", () => {
    const source: FhirR6DosageInstruction = {
      safety: { doseLimit: [{ scope: "period", valueQuantity: { value: 4, unit: "tab" },
        period: { value: 1, unit: "d" } }] },
      step: [{ component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] }] }]
    };
    for (const locale of ["en", "th"]) {
      const text = formatSig(source, "long", { locale, realizationMode: "normalized" });
      expect(text).toContain("4 tab / 1 d");
      expect(text).not.toContain("If the limit is exceeded");
      expect(text).not.toContain("หากเกินขีดจำกัด");
    }
  });

  it.each([false, true])("shows a known local treatment-day start without guessing offsets (explicit zero %s)", explicit => {
    const contextCode = { coding: [{
      system: "urn:ezmedicationinput:CodeSystem:course-phase-event", code: "treatment-day-start"
    }] };
    const source: FhirR6DosageInstruction = { step: [{
      start: { contextCode, ...(explicit ? { offsetDuration: { value: 0, unit: "d" } } : {}) },
      end: { contextCode, offsetDuration: { value: 2, unit: "d" } },
      component: [{ doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] } } }]
    }] };
    const before = JSON.stringify(source);
    for (const input of [source, courseFromR6(source), JSON.parse(JSON.stringify(toFhirR5Dosages(source)))]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toContain("Days 1–2");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
        .toContain("วันที่ 1–2");
      const context = { orderedAt: "2026-11-21T12:00:00Z", from: "2026-11-21T12:00:00Z", timeZone: "UTC" };
      expect(nextDueDoses(input, { ...context, limit: 3 })).toEqual(["2026-11-22T08:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage: input, ...context,
        durationValue: 3, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(2);
    }
    expect(JSON.stringify(source)).toBe(before);
    source.step[0].start!.offsetDuration = { unit: "d" };
    const incomplete = formatSig(source, "long", { locale: "en", realizationMode: "normalized" });
    expect(incomplete).toContain("requires review");
    expect(incomplete).not.toContain("Days 1–2");
    source.step[0].start = { contextCode: { text: "follow-up" } };
    const unresolved = formatSig(source, "long", { locale: "en", realizationMode: "normalized" });
    expect(unresolved).toContain("follow-up");
    expect(unresolved).not.toContain("Days 1–2");
  });
});

describe("round 31: complete event-relative offset windows", () => {
  it.each([
    ["activity", "en"], ["activity", "th"], ["event", "en"], ["event", "th"]
  ] as const)("keeps both endpoints of a %s window in %s", (kind, locale) => {
    for (const [low, high] of [[15, 60], [30, 90], [0, 30]]) {
      const clause = canonicalFromFhir({ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] });
      clause.schedule = kind === "activity"
        ? { activityTiming: [{ relation: "after", activity: { text: "dialysis", i18n: { th: "การฟอกไต" } },
          offsetMin: low, offsetMax: high }] }
        : { when: [EventTiming["After Breakfast"]], offsetMin: low, offsetMax: high };
      const before = JSON.stringify(clause);
      for (const style of ["short", "long"] as const) {
        const text = formatCanonicalClause(clause, style, resolveSigLocalization(locale));
        expect(text).toContain(low + "–" + high + (locale === "en" ? " minutes" : " นาที"));
        expect(text).toContain(kind === "activity"
          ? locale === "en" ? "after dialysis" : "หลังการฟอกไต"
          : locale === "en" ? "after breakfast" : "หลังอาหารเช้า");
        expect(text).not.toMatch(/at least|at most|อย่างน้อย|ไม่เกิน|immediately|ทันที/u);
      }
      expect(JSON.stringify(clause)).toBe(before);
    }
  });

  it.each(["activity", "event"] as const)("retains scalar and one-sided %s offsets", kind => {
    for (const [offsets, english, thai] of [
      [{ offsetMin: 15 }, "at least 15 minutes", "อย่างน้อย 15 นาที"],
      [{ offsetMax: 60 }, "at most 1 hour", "ไม่เกิน 1 ชั่วโมง"],
      [{ offset: 30 }, "30 minutes", "30 นาที"],
      [{ offset: 0 }, "immediately", "ทันที"],
      [{ offsetMin: 15, offsetMax: 15 }, "15 minutes", "15 นาที"]
    ] as const) {
      const clause = canonicalFromFhir({ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] });
      clause.schedule = kind === "activity"
        ? { activityTiming: [{ relation: "after", activity: { text: "dialysis" }, ...offsets }] }
        : { when: [EventTiming["After Breakfast"]], ...offsets };
      expect(formatCanonicalClause(clause, "long", resolveSigLocalization("en"))).toContain(english);
      expect(formatCanonicalClause(clause, "long", resolveSigLocalization("th"))).toContain(thai);
      if ("offsetMin" in offsets && "offsetMax" in offsets) {
        expect(formatCanonicalClause(clause, "long", resolveSigLocalization("en")))
          .not.toMatch(/at least|at most/u);
      }
    }
  });
});

describe("round 31: bounded event windows remain in preview", () => {
  it.each([
    [EventTiming.Breakfast, EventTiming.Lunch, "between breakfast and lunch", "ระหว่างอาหารเช้าถึงอาหารกลางวัน"],
    [EventTiming.Night, EventTiming.Morning, "between night and morning", "ระหว่างตอนกลางคืนถึงตอนเช้า"],
    [EventTiming["Before Breakfast"], EventTiming["After Lunch"],
      "between before breakfast and after lunch", "ระหว่างก่อนอาหารเช้าถึงหลังอาหารกลางวัน"]
  ] as const)("keeps the ordered %s–%s window without inventing clocks", (start, end, english, thai) => {
    const row: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 4, periodUnit: FhirPeriodUnit.Hour, extension: [{
        url: TIMING_EVENT_WINDOW_EXTENSION_URL,
        extension: [{ url: "start", valueCode: start }, { url: "end", valueCode: end }]
      }] } }
    };
    const before = JSON.stringify(row);
    const clause = canonicalFromFhir(row);
    expect(clause.schedule?.eventWindow).toEqual({ start, end });
    for (const [locale, expected] of [["en", english], ["th", thai]]) {
      for (const style of ["short", "long"] as const) {
        expect(formatCanonicalClause(clause, style, resolveSigLocalization(locale))).toContain(expected);
        expect(formatSig(row, style, { locale, realizationMode: "normalized" })).toContain(expected);
      }
    }
    expect(JSON.stringify(row)).toBe(before);
  });

  it("keeps a window beside an already owned rich event and accompaniment", () => {
    const source = "Take 1 tablet in the morning with water";
    const row: FhirDosage = JSON.parse(JSON.stringify(parseSig(source).fhir[0]));
    const originalText = row.text;
    formatSig(row, "long", { locale: "en" });
    const repeat = row.timing!.repeat!;
    repeat.extension = [...repeat.extension ?? [], {
      url: TIMING_EVENT_WINDOW_EXTENSION_URL,
      extension: [{ url: "start", valueCode: EventTiming.Breakfast }, { url: "end", valueCode: EventTiming.Lunch }]
    }];
    const before = JSON.stringify(row);
    for (const mode of ["normalized", "roundtrip"] as const) {
      const en = formatSig(row, "long", { locale: "en", realizationMode: mode });
      const th = formatSig(row, "long", { locale: "th", realizationMode: mode });
      expect(en).toContain("between breakfast and lunch");
      expect(en).toContain("water");
      expect(en).toContain("morning");
      expect(th).toContain("ระหว่างอาหารเช้าถึงอาหารกลางวัน");
      // The authored object may retain its English source lexeme in Thai.
      expect(th).toMatch(/(?:พร้อม|กับ)\s*(?:น้ำ|water)/u);
      expect(th).toContain("เช้า");
    }
    expect(JSON.stringify(row)).toBe(before);
    expect(row.text).toBe(originalText);
  });

  it("does not turn an ordinary cadence into an event window", () => {
    const row: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 4, periodUnit: FhirPeriodUnit.Hour } }
    };
    expect(formatSig(row, "long", { locale: "en", realizationMode: "normalized" }))
      .toContain("every 4 hours");
    for (const locale of ["en", "th"]) for (const style of ["short", "long"] as const) {
      expect(formatSig(row, style, { locale, realizationMode: "normalized" })).not.toMatch(/between|ระหว่าง/u);
    }
  });
});
