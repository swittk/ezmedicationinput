import { THAI_COURSE } from "../src/locales/course/th";
import { ENGLISH_COURSE } from "../src/locales/course/en";
import { withDosageEditProvenance, encodeR6SourceMetadata, PARALLEL_COMPONENT_PHASE_ORIGIN_URL } from "../src/dosage-course";
import { describe, expect, it } from "vitest";
import {
  parseSig, formatSig, toDosageDetails, toFhirR5Dosages, registerMedicationDateResolver, nextDueDoses,
  calculateTotalUnits, fromFhir, projectCanonicalCourse, importCanonicalCourse,
  type CanonicalAdministration, formatParseBatch, fromFhirDosage
} from "../src/index";
import { formatCanonicalClause } from "../src/format";
import { formatCanonicalCourse } from "../src/canonical/format-course";
import { administrationFromClause, clauseForAdministration, courseFromAdministrations, courseFromPartialParallel, courseFromParallel } from "../src/canonical/compile";
import { courseFromR6, courseToR6 } from "../src/adapters/canonical-course";
import type { CanonicalCourse, CanonicalBoundary } from "../src/canonical/course";
import {
  canonicalFromFhir, canonicalToFhir, parserStateFromFhir, TIMING_EVENT_WINDOW_EXTENSION_URL,
  TIMING_FREQUENCY_MIN_EXTENSION_URL, ADMINISTRATION_OFFSET_EXTENSION_URL,
  CYCLE_DAY_ELIGIBILITY_EXTENSION_URL
} from "../src/fhir";
import { getQuantityComparator, simpleQuantityForR5 } from "../src/fhir-quantity-operator";
import {
  resolveSigLocalization, type SigFormatContext, registerSigLocalization
} from "../src/i18n";
import {
  parseInstructionActions, realizeInstructionAction, realizeRichPrimaryWithCanonicalDose,
  instructionGraphSourceConflictsWithDose
} from "../src/instruction-graph";
import { resolveMedicationInstructionActionByMethod } from "../src/instruction-action-terminology";
import {
  buildInstructionGraphExtension, MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL,
  parseInstructionGraphExtension
} from "../src/instruction-graph-fhir";
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
  type CanonicalInstructionGraph, type FhirDosage, type FhirR6DosageInstruction, type ParseOptions,
  type MedicationDateResolver, RouteCode, type FhirR6Dosage
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
    expect(emitted?.low).toMatchObject({ value: low, code: "min", unit: "minutes" });
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
    // The prescriber owns both active endpoint units. An interoperability
    // constraint does not authorize a 30-minute to 0.5-hour conversion.
    // Wire labels also retain authored min/h; the preview may spell them out.
    expect(roundtrip?.low).toMatchObject({ value: 30, code: "min", unit: "min" });
    expect(roundtrip?.high).toMatchObject({ value: 2, code: "h", unit: "h" });
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
    const numerator = parsed.fhirNext.step[0].component[0].doseAndRate?.[0].rateRatio?.numerator;
    expect(numerator).toMatchObject({ value: 100, unit: "mL" });
    expect(getQuantityComparator(numerator)).toBe(qualifier ? "~" : undefined);
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
      const dose = locale === "en" ? /(?:^|[^\d.])2 tablets\b/gu : /(?:^|[^\d.])2 เม็ด/gu;
      for (const text of [
        formatCanonicalClause(clause, "long", resolveSigLocalization(locale),
          { ...options, realizationMode: "normalized" }),
        formatSig(parsed.fhir[0], "long", { ...options, locale, realizationMode: "normalized" })
      ]) {
        expect(text.match(dose)).toHaveLength(1);
        expect(text).toMatch(locale === "en" ? /Disperse 2 tablets\b/u : /กระจาย[^.;]*\s2 เม็ด/u);
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
      expect(text.match(locale === "en" ? /(?:^|[^\d.])3 tablets\b/gu : /(?:^|[^\d.])3 เม็ด/gu)).toHaveLength(1);
      expect(text).toMatch(locale === "en" ? /Disperse 3 tablets\b/u : /กระจาย[^.;]*\s3 เม็ด/u);
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
      const displacement = locale === "en"
        ? Math.abs(value) + " days " + (value < 0 ? "before " : "after ") + "follow-up visit"
        : Math.abs(value) + " วัน" + (value < 0 ? "ก่อน" : "หลัง") + "follow-up visit";
      expect(text).toContain(displacement);
      expect(text).not.toMatch(/\b\d{1,2}:\d{2}\b/u);
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
      expect(text).toMatch(locale === "en"
        ? /(?:approximately|at least) 1 spray[^.;]*each nostril/u
        : /ข้างละ (?:ประมาณ|อย่างน้อย) 1 ครั้ง/u);
      expect(text).toContain(locale === "en" ? comparator === "~" ? "approximately 1 spray" : "at least 1 spray"
        : comparator === "~" ? "ประมาณ 1" : "อย่างน้อย 1");
      expect(text).toContain(locale === "en" ? "less than 2 mg" : "น้อยกว่า 2 มิลลิกรัม");
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
    row.extension = [...(row.extension ?? []).filter(extension =>
      extension.url !== MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL), buildInstructionGraphExtension({
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
      expect(text).toBe(locale === "en" ? "Take 1 tablet orally in the morning." :
        realizationMode === "roundtrip" ? "รับประทาน 1 เม็ด เช้า." : "รับประทานครั้งละ 1 เม็ด ตอนเช้า.");
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
    row.extension = [...(row.extension ?? []).filter(extension =>
      extension.url !== MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL), buildInstructionGraphExtension({
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
  expect(parsed.meta.canonical.clauses[1].schedule?.count).toBe(1);
  const query = { orderedAt: "2026-11-21T00:00:00Z", timeZone: "UTC" };
  for (const dosage of [parsed, parsed.meta.canonical.course!, parsed.fhirNext, JSON.parse(JSON.stringify(parsed.fhir))]) {
    expect(nextDueDoses(dosage, { ...query, from: query.orderedAt, limit: 8 })).toEqual([
      "2026-11-21T09:00:00+00:00", "2026-11-22T09:00:00+00:00", "2026-11-23T09:00:00+00:00",
      "2026-11-24T09:00:00+00:00", "2026-11-25T09:00:00+00:00", "2026-11-26T06:00:00+00:00",
      "2026-11-30T15:00:00+00:00", "2026-12-01T15:00:00+00:00"
    ]);
    expect(nextDueDoses(dosage, { ...query, from: "2026-11-29T00:00:00Z", limit: 5 })).toEqual([
      "2026-11-30T15:00:00+00:00", "2026-12-01T15:00:00+00:00", "2026-12-02T15:00:00+00:00",
      "2026-12-03T15:00:00+00:00", "2026-12-04T15:00:00+00:00"
    ]);
  }
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
    for (const administrations of [members, imported.stages.flatMap(stage => stage.administrations)]) {
      expect(administrations.map(a => a.target?.text)).toEqual(["right eye", "right eye", "left eye"]);
      expect(administrations.map(a => a.target?.coding?.[0]?.code)).toEqual([
        "1290032005", "1290032005", "1290031003",
      ]);
    }
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
      if (onsetDays === 7) expect(calculateTotalUnits({ dosage: input, ...context,
        durationValue: 7, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(7);
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
    const orderedAt = "2026-11-21T00:00:00Z";
    const successor = authored ? "2026-12-02T06:00:00+00:00" : "2026-11-26T06:00:00+00:00";
    const expected = [
      "2026-11-21T09:00:00+00:00", "2026-11-22T09:00:00+00:00", "2026-11-23T09:00:00+00:00",
      ...(authored
        ? ["2026-11-30T09:00:00+00:00", "2026-12-01T09:00:00+00:00"]
        : ["2026-11-24T09:00:00+00:00", "2026-11-25T09:00:00+00:00"]),
      successor,
    ];
    const successorTime = Date.parse(successor);
    for (const input of [parsed, parsed.fhirNext, JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)))]) {
      const due = nextDueDoses(input, { orderedAt, from: orderedAt, timeZone: "UTC", limit: expected.length });
      expect(due).toEqual(expected);
      expect(due.some(at => at.slice(11, 19) === "06:00:00" && Date.parse(at) < successorTime)).toBe(false);
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
        from: "2026-11-21T12:00:00Z", timeZone: "UTC", limit: 7 })).toEqual([
        "2026-11-22T08:00:00+00:00", "2026-11-23T08:00:00+00:00", "2026-11-24T08:00:00+00:00",
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
    }, options)?.code).toBe("clinic-chew");
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
      // Include every predecessor event and the earliest successor, so a
      // spurious 06:00 on its completion date cannot fall before the query.
      const completion = Date.parse(from);
      const predecessor: string[] = [];
      for (let instant = Date.parse(orderedAt); instant < completion; instant += 6 * 60 * 60 * 1000)
        predecessor.push(new Date(instant).toISOString().replace(".000Z", "+00:00"));
      expect(nextDueDoses(input, { orderedAt, from: orderedAt, timeZone: "UTC",
        limit: predecessor.length + 1 })).toEqual([...predecessor, expected]);
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
      expect(nextDueDoses(input, { ...context, limit: expected.length + 2 })).toEqual(expected);
      expect(nextDueDoses(input, { ...context, from: "2026-11-26T20:00:00Z", limit: 4 })).toEqual([
        "2026-11-26T20:00:00+00:00", "2026-11-27T06:00:00+00:00"
      ]);
      expect(nextDueDoses(input, { ...context, from: "2026-11-27T06:00:01Z", limit: 4 })).toEqual([]);
      // Five 1-tab doses + three 2-tab doses + one 3-tab NEXT dose.
      expect(calculateTotalUnits({ dosage: input, ...context, durationValue: 7, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(14);
      expect(calculateTotalUnits({ dosage: input, ...context, from: "2026-11-27T00:00:00Z",
        durationValue: 2, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(3);
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
        const local = formatCanonicalClause(clause, style, resolveSigLocalization(locale));
        const whole = formatSig(row, style, { locale, realizationMode: "normalized" });
        expect(local).toContain(expected);
        expect(whole).toContain(expected);
        expect(local).not.toMatch(/\d{1,2}:\d{2}/u);
        expect(whole).not.toMatch(/\d{1,2}:\d{2}/u);
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
      expect(th.replace("ระหว่างอาหารเช้าถึงอาหารกลางวัน", "")).toContain("เช้า");
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


describe("round34 successor and member origins", () => {
  it.each([false, true])("shares the dated successor onset with coordinated siblings (pause %s)", pause => {
    const source = "Take 1 tablet on 2026-11-25 at 22:00, " +
      (pause ? "then stop for 2 days, " : "") +
      "then take 2 tablets at 06:00 the next morning and take 3 tablets at 07:00 daily";
    const parsed = parseSig(source);
    const date = pause ? "2026-11-28" : "2026-11-26";
    expect(parsed.meta.canonical.clauses.map(clause => clause.dose?.value)).toEqual([1, 2, 3]);
    expect(parsed.meta.canonical.clauses.slice(1).map(clause => clause.schedule?.boundsStart)).toEqual([date, date]);
    for (const input of [parsed, parsed.meta.canonical.course!, parsed.fhirNext, JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)))]) {
      const before = JSON.stringify(input);
      expect(nextDueDoses(input, { orderedAt: "2026-11-21T12:00:00Z", from: "2026-11-26T00:00:00Z",
        timeZone: "UTC", limit: 2 })).toEqual([date + "T06:00:00+00:00", date + "T07:00:00+00:00"]);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it("keeps an independently dated sibling outside the shared dated pause", () => {
    const parsed = parseSig("Take 1 tablet on 2026-11-25 at 22:00, then stop for 2 days, then take 2 tablets at 06:00 the next morning and take 3 tablets on 2026-11-30 at 07:00");
    expect(parsed.meta.canonical.clauses.slice(1).map(clause => clause.schedule?.boundsStart)).toEqual(["2026-11-28", undefined]);
    const context = { orderedAt: "2026-11-21T12:00:00Z", timeZone: "UTC", limit: 4 };
    for (const dosage of [parsed, parsed.meta.canonical.course!, parsed.fhirNext,
      JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)))]) {
      const before = JSON.stringify(dosage);
      expect(nextDueDoses(dosage, { ...context, from: "2026-11-25T00:00:00Z" })).toEqual([
        "2026-11-25T22:00:00+00:00", "2026-11-28T06:00:00+00:00", "2026-11-30T07:00:00+00:00"
      ]);
      expect(nextDueDoses(dosage, { ...context, from: "2026-11-26T00:00:00Z" })).toEqual([
        "2026-11-28T06:00:00+00:00", "2026-11-30T07:00:00+00:00"
      ]);
      expect(nextDueDoses(dosage, { ...context, from: "2026-11-28T06:00:01Z" }))
        .toEqual(["2026-11-30T07:00:00+00:00"]);
      expect(nextDueDoses(dosage, { ...context, from: "2026-11-30T07:00:01Z" })).toEqual([]);
      // One dated 1-tab dose, one NEXT 2-tab dose, one independently dated 3-tab dose.
      expect(calculateTotalUnits({ dosage, ...context, from: "2026-11-25T00:00:00Z",
        durationValue: 7, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(6);
      expect(calculateTotalUnits({ dosage, ...context, from: "2026-11-26T00:00:00Z",
        durationValue: 5, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(5);
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });

  it.each(["mixed", "elapsed", "day-start"] as const)("keeps the first civil-day clock for %s member origins", kind => {
    const administrations = [8, 14].map((hour, index) => ({
      kind: "administration" as const, onsetDays: 1,
      ...(kind === "day-start" || kind === "mixed" && index === 0
        ? { onsetReference: "treatment-day-start" as const } : {}),
      amounts: [{ quantity: { value: index + 1, unit: "tab" } }],
      schedule: { recurrence: { count: 1, frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        clocks: [String(hour).padStart(2, "0") + ":00:00"] } }
    }));
    const before = JSON.stringify(administrations);
    const native = courseFromAdministrations(administrations, "Two members with their own onset origins");
    const wire = courseToR6(native);
    const expected = kind === "elapsed"
      ? ["2026-11-22T14:00:00+00:00", "2026-11-23T08:00:00+00:00"]
      : ["2026-11-22T08:00:00+00:00", "2026-11-22T14:00:00+00:00"];
    for (const input of [native, wire, JSON.parse(JSON.stringify(toFhirR5Dosages(wire)))])
      expect(nextDueDoses(input, { orderedAt: "2026-11-21T12:00:00Z", from: "2026-11-21T12:00:00Z",
        timeZone: "UTC", limit: 2 })).toEqual(expected);
    if (kind === "mixed") expect(native.stages[0].start).toBeUndefined();
    expect(JSON.stringify(administrations)).toBe(before);
  });
});


// Retained regression suite from test/pr14-round20-meaning.spec.ts.
{
// BEGIN PRESERVED meaning20

function tablet(): CanonicalAdministration {
  return { kind: "administration", amounts: [{ quantity: { value: 1, unit: "tab" } }],
    schedule: { recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } } };
}

describe("review family: current quantity and scope own meaning", () => {
  it.each(["100 mL/hr", "~100 mL/hr", "100mL/hr", "100 mL per hr"])(
    "retains unheaded dimensional source without detaching a scalar dose: %s", input => {
      const parsed = parseSig(input);
      const clause = parsed.meta.canonical.clauses[0];
      expect(clause.raw?.text).toBe(input);
      expect(clause.leftovers?.map(part => part.text).join(" ")).toBe(input);
      expect(clause.dose).toBeUndefined();
      expect(clause.clinicalQuantity).toBeUndefined();
      expect(parsed.fhirNext.step[0]?.component[0]?.doseAndRate).toBeUndefined();
    }
  );

  it("uses the typed IV route to license a verb-free rate while retaining its independent cadence", () => {
    const parsed = parseSig("100 mL / hr IV daily");
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.dose).toBeUndefined();
    expect(clause.clinicalQuantity).toMatchObject({
      representation: "rate-quantity",
      numerator: { value: 100, unit: "mL", dimension: "volume" },
      denominators: [{ value: 1, unit: "h", dimension: "time" }],
    });
    expect(clause.clinicalQuantity?.numerator.comparator).toBeUndefined();
    for (const amount of [parsed.fhir[0].doseAndRate![0],
      parsed.fhirNext.step[0].component[0].doseAndRate![0]]) {
      expect(amount.rateQuantity).toMatchObject({ value: 100, unit: "mL/h" });
      expect(amount.doseQuantity).toBeUndefined();
    }
    expect(clause.route?.code).toBe("47625008");
    expect(clause.schedule).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
    expect(clause.leftovers?.map(part => part.text).join(" ")).toBe("");
    expect(parsed.input).toBe("100 mL / hr IV daily");
  });

  it("carries the latest authored range instead of an earlier approximate scalar", () => {
    const p = parseSig("Take about 1 tablet daily for 3 days, then 2–3 tablets daily for 3 days, then twice daily");
    const clauses = p.meta.canonical.clauses;
    expect(clauses).toHaveLength(3);
    expect(clauses[2].dose).toMatchObject({ range: { low: 2, high: 3 }, unit: "tab" });
    expect(clauses[2].dose?.value).toBeUndefined();
    expect(clauses[2].dose?.comparator).toBeUndefined();
    expect(clauses[2].schedule).toMatchObject({ frequency: 2, period: 1, periodUnit: "d" });
  });

  it("does not coalesce unequal dose qualifiers into one timed administration", () => {
    const parsed = parseSig("Take 1 tablet at 08:00 and take at least 1 tablet at 20:00");
    const clauses = parsed.meta.canonical.clauses;
    expect(clauses).toHaveLength(2);
    expect(clauses.map(c => c.dose?.comparator)).toEqual([undefined, ">="]);
    expect(clauses.map(c => c.schedule?.timeOfDay)).toEqual([["08:00:00"], ["20:00:00"]]);
    for (const rows of [parsed.fhir, parsed.fhirNext.step[0].component]) {
      expect(rows).toHaveLength(2);
      expect(rows.map(row => ({
        clocks: row.timing?.repeat?.timeOfDay,
        quantity: row.doseAndRate?.[0].doseQuantity,
        comparator: getQuantityComparator(row.doseAndRate?.[0].doseQuantity)
      }))).toMatchObject([
        { clocks: ["08:00:00"], quantity: { value: 1, unit: "tab" }, comparator: undefined },
        { clocks: ["20:00:00"], quantity: { value: 1, unit: "tab" }, comparator: ">=" }
      ]);
    }
    const matching = parseSig("Take at least 1 tablet at 08:00 and take at least 1 tablet at 20:00");
    expect(matching.items).toHaveLength(1);
    expect(matching.items[0].fhir.timing?.repeat?.timeOfDay).toEqual(["08:00:00", "20:00:00"]);
    expect(matching.meta.canonical.clauses.every(c => c.dose?.comparator === ">=")).toBe(true);
  });

  it.each([
    ["approximately half a million units IM once", 500000, "~"],
    ["at least a quarter million units IM once", 250000, ">="],
    ["at most two and a half million units IM once", 2500000, "<="],
    ["half a million units IM once", 500000, undefined],
    ["a quarter million units IM once", 250000, undefined],
    ["one and a half million units IM once", 1500000, undefined],
  ])("keeps the complete qualified numeric head in %s", (source, value, comparator) => {
    const dose = parseSig(source as string).meta.canonical.clauses[0].dose;
    expect(dose).toMatchObject({ value, unit: "U" });
    expect(dose?.comparator).toBe(comparator);
  });

  it.each([["≤.๕", "<=", 0.5], ["≥๑.๕", ">=", 1.5], ["~.๒๕", "~", 0.25]])(
    "normalizes %s in the Thai lexer while retaining the source", (prefix, comparator, value) => {
      const input = prefix + " เม็ด วันละครั้ง";
      const p = parseSig(input, { locale: "th" });
      expect(p.meta.canonical.clauses[0].dose).toMatchObject({ value, unit: "tab", comparator });
      expect(p.meta.canonical.clauses[0].rawText).toBe(input);
    },
  );

  it("selects a supported route coding regardless of its position or local neighbors", () => {
    for (const coding of [
      [{ system: "urn:hospital", code: "local" }, { system: "http://snomed.info/sct", code: "78421000" }],
      [{ system: "http://snomed.info/sct", code: "78421000" }, { system: "urn:hospital", code: "local" }],
    ]) {
      const p = fromFhir({ step: [{ component: [{
        route: { coding }, doseAndRate: [{ doseQuantity: { value: 1, unit: "mL" } }],
      }] }] }, { locale: "en" });
      expect(p.items[0].meta.normalized.route).toBe("78421000");
      expect(p.longText).toContain("intramuscularly");
    }
    const foreign = fromFhir({ step: [{ component: [{
      route: { coding: [{ system: "urn:hospital", code: "78421000" }] },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "mL" } }],
    }] }] }, { locale: "en" });
    expect(foreign.items[0].meta.normalized.route).toBeUndefined();
    expect(foreign.longText).not.toContain("intramuscular");
  });

  it("retains qualified independent taper duration instead of deriving an exact cut", () => {
    const input = "1 drop OD q2h x7d then 1 drop OD QID; 1 drop OS QID x1mo then 1 drop OS BID";
    const plan = createBoundaryPlan(input);
    const states = plan.segments.map(segment => parseClauseState(segment.text));
    const graph = buildRegimenGraph(plan, plan.segments);
    scopeSequentialPhaseSemantics(states, plan.segments, graph, input);
    const clauses = states.map(state => state.primaryClause);
    const exact = buildCanonicalParallelRegimen(clauses, plan.segments, plan, graph);
    expect(exact.kind).toBe("resolved");
    if (exact.kind === "resolved") expect(exact.stages[0].end).toEqual({ value: 7, unit: "d" });
    clauses[0].schedule!.durationComparator = "~";
    const qualified = buildCanonicalParallelRegimen(clauses, plan.segments, plan, graph);
    expect(qualified.kind).toBe("unresolved");
    if (qualified.kind !== "unresolved" || !qualified.tracks) throw new Error("Expected retained independent tracks");
    expect(qualified.tracks).toHaveLength(2);
    const right = qualified.tracks[0].phases[0].members[0].clause;
    const left = qualified.tracks[1].phases[0].members[0].clause;
    expect(qualified.tracks.flatMap(track => track.phases.flatMap(phase =>
      phase.members.map(member => member.clause.dose?.value)))).toEqual([1, 1, 1, 1]);
    expect(right.schedule).toMatchObject({ period: 2, periodUnit: "h", duration: 7, durationComparator: "~" });
    expect(left.schedule).toMatchObject({ frequency: 4, duration: 1, durationUnit: "mo" });
    expect(formatCanonicalClause(right, "long")).toContain("~7 days");
  });
});

describe("review family: course preview preserves partial clinical bounds", () => {
  it.each(["en", "th", "th-TH"])("shows high-only course duration in both styles for %s", locale => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        boundsRange: { high: { value: 7, unit: "d" } } } } };
    const long = formatSig(row, "long", { locale });
    expect(long).toContain(locale === "en" ? "for up to 7 days" : "ไม่เกิน 7 วัน");
    expect(formatSig(row, "short", { locale })).toContain("x<=7d");
    row.timing!.repeat!.boundsRange!.high = simpleQuantityForR5({ value: 7, unit: "d", comparator: "<" });
    expect(formatSig(row, "long", { locale })).toContain("<7");
  });

  it.each(["en", "th"])("shows equal endpoints when only the lower endpoint is qualified in %s", locale => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        boundsRange: { low: simpleQuantityForR5({ value: 5, unit: "d", comparator: ">=" }), high: { value: 5, unit: "d" } } } } };
    expect(formatSig(row, "short", { locale })).toContain("x>=5-5d");
    expect(formatSig(row, "long", { locale })).toContain(locale === "en" ? ">=5 to 5 days" : ">=5 ถึง 5 วัน");
  });

  it("renders step count independently of course repetition", () => {
    const course: CanonicalCourse = { kind: "course", stages: [{ count: 3,
      start: { anchor: "treatment-start", displacement: { value: 0, unit: "d" } },
      end: { anchor: "treatment-start", displacement: { value: 1, unit: "d" } },
      administrations: [tablet()] }] };
    const text = formatCanonicalCourse(course, "long", { locale: "en" });
    expect(text).toContain("Perform this phase 3 times");
    expect(text).not.toContain("Repeat this schedule every");
  });

  it.each(["en", "th"])("keeps finite course cycles separate from local step repetitions in %s", locale => {
    const course: CanonicalCourse = { kind: "course", cycleCount: 4,
      cycleInterval: { value: 3, unit: "d" }, stages: [{ count: 2,
        start: { anchor: "treatment-start", displacement: { value: 0, unit: "d" } },
        end: { anchor: "treatment-start", displacement: { value: 1, unit: "d" } },
        administrations: [tablet()] }] };
    const text = formatCanonicalCourse(course, "long", { locale });
    expect(text).toContain(locale === "en" ? "Perform this phase 2 times" : "ทำซ้ำระยะนี้รวม 2 ครั้ง");
    expect(text).toContain(locale === "en" ? "Repeat this schedule every 3 days for 4 cycles" : "ทุก 3 วัน จำนวน 4 รอบ");
  });

  it("compiles a finite active/rest course count at course scope", () => {
    const parsed = parseSig("Take 1 tablet daily for 7 days then stop for 7 days repeat for 3 cycles");
    expect(parsed.meta.canonical.course?.cycleCount).toBe(3);
    expect(parsed.meta.canonical.course?.cycleInterval).toMatchObject({ value: 14, unit: "d" });
    expect(parsed.meta.canonical.course?.stages[0].count).toBeUndefined();
  });

  it("shows course limits even without a dosage step", () => {
    const course: CanonicalCourse = { kind: "course", stages: [],
      safety: { limits: [{ scope: "lifetime", count: 3 }] } };
    expect(formatCanonicalCourse(course, "long", { locale: "en" }))
      .toBe("Across this course: max lifetime: 3 administrations");
  });

  it("preserves relative range endpoints without inventing an exact start date", () => {
    const course: CanonicalCourse = { kind: "course", stages: [{
      start: { anchor: "treatment-start", displacementRange: {
        low: { value: 2, unit: "d", comparator: ">=" }, high: { value: 4, unit: "d" },
      } }, administrations: [tablet()],
    }] };
    const text = formatCanonicalCourse(course, "long", { locale: "en" });
    expect(text).toContain(">=2 days – 4 days after treatment start");
    expect(text).toContain("1 tablet");
    expect(text).not.toContain("From day 3");
    expect(text).not.toContain("requires review");
  });

  it("uses the same base locale for clause text and course limits", () => {
    const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [tablet()] }],
      safety: { limits: [{ scope: "lifetime", count: 3 }] } };
    const text = formatCanonicalCourse(course, "long", { locale: "th-TH" });
    expect(text).toContain("1 เม็ด");
    expect(text).toContain("วันละครั้ง");
    expect(text).toContain("ตลอดแผนการใช้ยานี้");
    expect(text).not.toContain("once daily");
  });

});

describe("review family: instruction graphs use live quantity and timing", () => {
  it.each(["en", "th"])("puts the current dose before a text-only Amount in a rich frame (%s)", locale => {
    const frame = parseInstructionActions("Take 1 tablet slowly")[0];
    const amount = frame.args.find(arg => arg.role === AdviceArgumentRole.Amount)!;
    delete amount.quantity;
    amount.text = "the prescribed amount";
    frame.args = [amount, { role: AdviceArgumentRole.Manner, text: "slowly",
      normalized: "slowly", i18n: { th: "ช้าๆ" } }];
    const snapshot = JSON.stringify(frame);
    const clause = parseSig("Take at most 2 tablets").meta.canonical.clauses[0];
    expect(clause.dose).toMatchObject({ value: 2, unit: "tab", comparator: "<=" });
    clause.instructionGraph = { sourceText: "Take the prescribed amount slowly",
      sourceLocale: "en", actions: [frame], primaryAdministrationSpan: { ...frame.span } };
    const text = realizeRichPrimaryWithCanonicalDose(frame, clause, locale);
    expect(text).toContain(locale === "en" ? "at most 2 tablets" : "ไม่เกิน 2 เม็ด");
    expect(text).toContain(locale === "en" ? "slowly" : "ช้า");
    expect(JSON.stringify(frame)).toBe(snapshot);
  });

  it("keeps a later independent dose definer separate from the primary dose", () => {
    const source = "Take 1 tablet, then dissolve 2 tablets in water";
    const actions = parseInstructionActions(source);
    const graph = { sourceText: source, sourceLocale: "en", actions };
    const clause = parseSig("Take 3 tablets").meta.canonical.clauses[0];
    clause.instructionGraph = graph;
    const snapshot = JSON.stringify(graph);
    expect(instructionGraphSourceConflictsWithDose(clause)).toBe(true);
    const text = formatCanonicalClause(clause, "long", resolveSigLocalization("en"));
    expect(text).toMatch(/\bTake 3 tablets\b/i);
    expect(text).toMatch(/\bdissolve 2 tablets (?:in|into) water\b/i);
    expect(text).not.toContain("Take 1 tablet");
    expect(JSON.stringify(graph)).toBe(snapshot);
  });

  it.each([
    "รับประทาน 1 เม็ด เวลา 08:00 และ 20:00",
    "ล้างมือก่อนหยอดตา หยอดตาขวา เวลา 08:00 และ 20:00 แล้วหลับตา",
    "รับประทานยา เวลา 08:00 และ 20:00",
  ])("rejects stale Thai clocks even when dose ownership cannot prove timing: %s", source => {
    const parsed = parseSig(source, { locale: "th" });
    const row = structuredClone(parsed.fhir[0]);
    expect(row.timing?.repeat?.timeOfDay).toEqual(["08:00:00", "20:00:00"]);
    row.timing!.repeat!.timeOfDay![1] = "22:00:00";
    const text = formatSig(row, "long", { locale: "th", realizationMode: "roundtrip" });
    expect(text).toContain("08:00");
    expect(text).toContain("22:00");
    expect(text).not.toContain("20:00");
    expect(text).not.toBe("");
  });
});

describe("round32 phase origin and numeric ownership audit", () => {
  const query = { orderedAt: "2026-11-21T08:00:00Z", from: "2026-11-21T08:00:00Z",
    timeZone: "UTC", eventClock: { MORN: "08:00" }, limit: 5 };

  it("does not promote a predecessor-relative pause to an absolute parallel-track origin", () => {
    const source = "1 drop OD daily for 5 doses, stop for 2 days, then 2 drops OD the next morning for 3 days, then 3 drops OD daily; 1 drop OS BID";
    const course = parseSig(source).meta.canonical.course!;
    const members = course.stages[0].administrations;
    expect(members).toHaveLength(4);
    expect(members[1]).toMatchObject({
      phaseStart: { anchor: "previous-phase-next-day", displacement: { value: 2, unit: "d" } },
      phasePredecessors: [0],
    });
    expect(members[1].phaseOrigin).toBeUndefined();
    expect(members[2].phaseOrigin).toBeUndefined();
    expect(members[2].phaseStart).toEqual({ anchor: "unresolved" });
    expect(members[3].phaseOrigin).toMatchObject({ value: 0, unit: "d" });

    const explicit = parseSig(source.replace("then 3 drops OD daily", "then from day 10 take 3 drops OD daily"))
      .meta.canonical.course!.stages[0].administrations;
    expect(explicit[2].phaseStart).toMatchObject({
      anchor: "treatment-day-start", displacement: { value: 9, unit: "d" }
    });
  });

  it.each([
    ["2026-11-21T08:00:00Z", "2026-11-25T09:00:00+00:00"],
    ["2026-11-21T00:00:00Z", "2026-11-24T09:00:00+00:00"],
  ])("opens next morning after the last occupied predecessor date from %s", (orderedAt, expected) => {
    const parsed = parseSig("Take 1 tablet daily for 3 days, then take 2 tablets the next morning at 9 AM");
    expect(parsed.meta.canonical.course!.stages[1].start).toMatchObject({ anchor: "previous-phase-next-day" });
    for (const input of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
      expect(nextDueDoses(input, { ...query, orderedAt, from: orderedAt, limit: 4 })).toEqual([
        "2026-11-21T09:00:00+00:00", "2026-11-22T09:00:00+00:00",
        "2026-11-23T09:00:00+00:00", expected
      ]);
    }
  });

  it.each([
    ["2026-11-21T06:00:00Z", "2026-11-21T06:00:00+00:00", "2026-11-21T07:00:00+00:00", "2026-11-22T09:00:00+00:00"],
    ["2026-11-21T22:00:00Z", "2026-11-21T22:00:00+00:00", "2026-11-21T23:00:00+00:00", "2026-11-22T09:00:00+00:00"],
  ])("keeps next morning after an hourly phase from %s", (orderedAt, first, second, next) => {
    const parsed = parseSig("1 puff q1h for 2 hours, then 2 puffs the next morning at 9 AM");
    expect(parsed.meta.canonical.course!.stages[1].start).toMatchObject({ anchor: "previous-phase-next-day" });
    for (const input of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext])
      expect(nextDueDoses(input, { ...query, orderedAt, from: orderedAt, limit: 3 }))
        .toEqual([first, second, next]);
  });

  it("lets authored dated events own their origin after an unresolved independent track", () => {
    const parsed = parseSig("1 drop OD daily for 2 doses then 2 drops OD on 2026-11-25 at 10:00; 1 drop OS on 2026-11-26 at 11:00");
    const course = parsed.meta.canonical.course!;
    expect(course.stages[0].administrations[1].phaseStart).toBeUndefined();
    for (const input of [course, parsed.fhir, parsed.fhirNext]) {
      expect(nextDueDoses(input, { ...query, limit: 8 })).toEqual([
        "2026-11-21T09:00:00+00:00", "2026-11-22T09:00:00+00:00",
        "2026-11-25T10:00:00+00:00", "2026-11-26T11:00:00+00:00",
      ]);
    }
  });

  it.each(["the next morning at 9 AM", "at 9 AM the next morning"])(
    "refines the next-day daypart with its authored clock: %s", successor => {
      const parsed = parseSig("Take 1 tablet at 8 PM, then take 1 tablet " + successor);
      const schedule = parsed.meta.canonical.clauses[1].schedule!;
      expect(schedule.when).toBeUndefined();
      expect(schedule.timeOfDay).toEqual(["09:00:00"]);
      expect(schedule.count).toBe(1);
      for (const input of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
        expect(nextDueDoses(input, { ...query, limit: 3 })).toEqual([
          "2026-11-21T20:00:00+00:00", "2026-11-22T09:00:00+00:00",
        ]);
        expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 3, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(2);
      }
    });

  it("keeps a daypart-only next morning and an independently coordinated evening", () => {
    const daypart = parseSig("Take 1 tablet at 8 PM, then take 1 tablet the next morning");
    expect(daypart.meta.canonical.clauses[1].schedule?.when).toEqual(["MORN"]);
    expect(nextDueDoses(daypart, { ...query, limit: 2 })).toEqual([
      "2026-11-21T20:00:00+00:00", "2026-11-22T08:00:00+00:00"
    ]);
    const separate = parseSig("Take 1 tablet the next morning at 9 AM and in the evening");
    expect(separate.meta.canonical.clauses[0].schedule?.when).toEqual(["EVE"]);
  });

  it.each(["≤.๕เม็ด", "≤.๕ เม็ด", "≤.5เม็ด", "<=.5เม็ด", "≥.๕เม็ด", "~.๕เม็ด", "≤0.๕เม็ด"])(
    "keeps the leading decimal in the Thai comparative quantity %s", amount => {
      const parsed = parseSig("กลืน " + amount, { locale: "th" });
      const comparator = amount.startsWith("≥") ? ">=" : amount.startsWith("~") ? "~" : "<=";
      expect(parsed.meta.canonical.clauses[0].dose).toMatchObject({ value: 0.5, unit: "tab", comparator });
      for (const row of [parsed.fhir[0], parsed.fhirNext.step[0].component[0]]) {
        expect(row.doseAndRate![0].doseQuantity).toMatchObject({ value: 0.5, unit: "tab" });
        expect(getQuantityComparator(row.doseAndRate![0].doseQuantity)).toBe(comparator);
      }
    });

  it("invalidates warm capped source replay after a live minimum-frequency edit", () => {
    const text = "Take 1 tablet zero to three times per day, maximum 3 tablets per day.";
    const row = withDosageEditProvenance<FhirDosage>([{
      text, doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequencyMax: 3, period: 1, periodUnit: FhirPeriodUnit.Day,
        extension: [{ url: TIMING_FREQUENCY_MIN_EXTENSION_URL, valueInteger: 0 }] } },
      maxDosePerPeriod: [{ numerator: { value: 3, unit: "tab" }, denominator: { value: 1, unit: "d" } }],
    }], text)[0];
    const options = { locale: "en", realizationMode: "roundtrip" as const };
    expect(formatSig(row, "long", options)).toBe(text);
    row.timing!.repeat!.extension![0].valueInteger = 2;
    expect(canonicalFromFhir(row).schedule?.frequency).toBe(2);
    const warm = formatSig(row, "long", options);
    const cold = formatSig(JSON.parse(JSON.stringify(row)), "long", options);
    expect(warm).not.toBe(text);
    expect(warm).toBe(cold);
    expect(warm).toMatch(/2(?:-|–| to )3/u);
  });
});


describe("round32 live schedule modifier proof family", () => {
  it.each(["delay", "cycle"] as const)("observes an in-place %s modifier edit on a warmed capped row", kind => {
    const modifier = kind === "delay"
      ? { url: ADMINISTRATION_OFFSET_EXTENSION_URL, valueQuantity: { value: 30, unit: "min", code: "min" } }
      : { url: CYCLE_DAY_ELIGIBILITY_EXTENSION_URL, extension: [
        { url: "day", valueInteger: 1 }, { url: "day", valueInteger: 8 },
        { url: "periodDays", valueInteger: 21 },
        { url: "reason", valueCode: "unresolved-cycle-eligibility" },
        { url: "source", valueString: "on days 1 and 8 of each cycle" },
      ] };
    const text = kind === "delay"
      ? "Take 1 tablet daily after a 30-minute delay, maximum 2 tablets daily."
      : "Take 1 tablet on days 1 and 8 of each cycle, maximum 2 tablets daily.";
    const row = withDosageEditProvenance<FhirDosage>([{
      text, doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
      maxDosePerPeriod: [{ numerator: { value: 2, unit: "tab" }, denominator: { value: 1, unit: "d" } }],
      modifierExtension: [modifier],
    }], text)[0];
    const options = { locale: "en", realizationMode: "roundtrip" as const };
    expect(formatSig(row, "long", options)).toBe(text);
    if (kind === "delay") row.modifierExtension![0].valueQuantity!.value = 60;
    else row.modifierExtension![0].extension![1].valueInteger = 15;
    const clause = canonicalFromFhir(row);
    if (kind === "delay") expect(clause.schedule?.administrationOffsetMinutes).toBe(60);
    else expect(clause.schedule?.cycleDayConstraint?.days).toEqual([1, 15]);
    const warm = formatSig(row, "long", options);
    expect(warm).not.toBe(text);
    expect(warm).toBe(formatSig(JSON.parse(JSON.stringify(row)), "long", options));
    if (kind === "delay") expect(warm).toContain("60 minutes later");
    else {
      expect(warm).toMatch(/days 1(?: and |, )15/u);
      expect(warm).not.toMatch(/days 1(?: and |, )8\b/u);
    }
  });
});

it.each(["the next morning and at 09:00", "at 09:00 and the next morning"])(
  "round32 retains explicitly coordinated NEXT and clock events in either order: %s", timing => {
    const parsed = parseSig("Take 1 tablet " + timing);
    const splitDay = timing.startsWith("at ");
    expect(parsed.meta.canonical.clauses[splitDay ? 1 : 0].schedule?.when).toEqual(["MORN"]);
    expect(parsed.meta.canonical.clauses[0].schedule?.timeOfDay).toEqual(["09:00:00"]);
    for (const row of parsed.fhir)
      expect(Boolean(row.timing?.repeat?.when?.length && row.timing.repeat.timeOfDay?.length)).toBe(false);
    expect(parsed.meta.canonical.clauses.map(clause => clause.schedule?.count)).toEqual(splitDay ? [1, 1] : [2]);
    const query = { orderedAt: "2026-11-21T00:00:00Z", from: "2026-11-21T00:00:00Z",
      timeZone: "UTC", eventClock: { MORN: "08:00" }, limit: 3 };
    for (const dosage of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
      expect(nextDueDoses(dosage, query)).toEqual(splitDay ? [
        "2026-11-21T09:00:00+00:00", "2026-11-22T08:00:00+00:00"
      ] : ["2026-11-22T08:00:00+00:00", "2026-11-22T09:00:00+00:00"]);
      expect(calculateTotalUnits({ ...query, dosage, durationValue: 4, durationUnit: "d" }).totalUnits).toBe(2);
    }
  });

describe("round33 onset scope and complete Thai fractions", () => {
  it("keeps the pause after a dated phase before its next-morning successor", () => {
    const parsed = parseSig("Take 1 tablet daily starting 2026-12-01 for 7 days, stop for 2 days, then 2 tablets the next morning for 3 days");
    const expected = [
      "2026-12-01T09:00:00+00:00", "2026-12-02T09:00:00+00:00", "2026-12-03T09:00:00+00:00",
      "2026-12-04T09:00:00+00:00", "2026-12-05T09:00:00+00:00", "2026-12-06T09:00:00+00:00",
      "2026-12-07T09:00:00+00:00", "2026-12-10T08:00:00+00:00", "2026-12-11T08:00:00+00:00",
      "2026-12-12T08:00:00+00:00"
    ];
    for (const input of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext])
      expect(nextDueDoses(input, { orderedAt: "2026-12-01T08:00:00Z", from: "2026-12-01T08:00:00Z",
        timeZone: "UTC", eventClock: { MORN: "08:00" }, limit: 20 })).toEqual(expected);
  });

  it.each(["the next morning and again at 18:00", "at 18:00 and again the next morning"])(
    "retains explicitly coordinated event and clock in %s", timing => {
      const parsed = parseSig("Take 1 tablet " + timing);
      const splitDay = timing.startsWith("at ");
      expect(parsed.meta.canonical.clauses[splitDay ? 1 : 0].schedule?.when).toEqual(["MORN"]);
      expect(parsed.meta.canonical.clauses.map(clause => clause.schedule?.count)).toEqual(splitDay ? [1, 1] : [2]);
      const query = { orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-01T00:00:00Z",
        timeZone: "UTC", eventClock: { MORN: "08:00" }, limit: 3 };
      for (const dosage of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
        expect(nextDueDoses(dosage, query)).toEqual(splitDay ? [
          "2026-12-01T18:00:00+00:00", "2026-12-02T08:00:00+00:00"
        ] : ["2026-12-02T08:00:00+00:00", "2026-12-02T18:00:00+00:00"]);
        expect(calculateTotalUnits({ ...query, dosage, durationValue: 4, durationUnit: "d" }).totalUnits).toBe(2);
      }
    });

  it.each(["until the next morning", "until next morning"])("does not turn %s into an onset", ending => {
    const parsed = parseSig("Take 1 tablet every 6 hours " + ending);
    const schedule = parsed.meta.canonical.clauses[0].schedule!;
    expect(schedule.treatmentStartOffsetDays).toBeUndefined();
    expect(schedule.phaseStartReference).toBeUndefined();
    expect(schedule).toMatchObject({ period: 6, periodUnit: "h" });
    expect(schedule.frequency ?? 1).toBe(1);
    expect(schedule.when).toBeUndefined();
    expect(parsed.input).toContain(ending);
    // The recognized but unresolved end remains visible and blocks numeric
    // execution through the existing unresolved RelativeTime contract.
    expect(parsed.meta.canonical.course!.stages[0].administrations[0].phaseEnd)
      .toEqual({ anchor: "unresolved", description: ending });
    for (const text of [parsed.shortText, parsed.longText]) {
      expect(text).toContain(ending);
      expect(text).toMatch(/every 6 hours|Q6H/u);
    }
    for (const dosage of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
      const query = { orderedAt: "2026-12-01T08:00:00Z", from: "2026-12-01T08:00:00Z",
        timeZone: "UTC", limit: 4 };
      const unresolved = "Unsupported R6 step RelativeTime: requires a treatment-start offset";
      expect(() => nextDueDoses(dosage, query)).toThrow(unresolved);
      expect(() => calculateTotalUnits({ ...query, dosage, durationValue: 3, durationUnit: "d" }))
        .toThrow(unresolved);
    }
  });

  it.each(["≤๑/๒เม็ด", "≤1/2เม็ด", ">=๑/๒เม็ด", "~๑/๒เม็ด"])("keeps the complete comparative fraction %s", amount => {
    const source = amount + " วันละครั้ง";
    const parsed = parseSig(source, { locale: "th" });
    const comparator = amount.startsWith(">=") ? ">=" : amount.startsWith("~") ? "~" : "<=";
    expect(parsed.input).toBe(source);
    expect(parsed.meta.canonical.clauses[0].dose).toMatchObject({ value: 0.5, unit: "tab", comparator });
    for (const row of [parsed.fhir[0], parsed.fhirNext.step[0].component[0]]) {
      expect(row.doseAndRate![0].doseQuantity!.value).toBe(0.5);
      expect(getQuantityComparator(row.doseAndRate![0].doseQuantity)).toBe(comparator);
    }
  });
});


describe("round33 mixed clock and event recurrence", () => {
  const context = { orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-01T00:00:00Z",
    timeZone: "UTC", eventClock: { MORN: "08:00" }, limit: 8 };
  const clockUrl = "urn:ezmedicationinput:StructureDefinition:medication-timing-additional-clock";
  function mixed(): CanonicalAdministration {
    const value = tablet();
    value.schedule!.recurrence = { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day,
      anchors: ["MORN"], clocks: ["09:00:00"] };
    return value;
  }
  it.each([1, 2])("retains one count and cap owner across mixed occurrence positions and the next phase (%s tablets/day)", cap => {
    const loading = mixed();
    loading.schedule!.recurrence!.count = 2;
    loading.limits = [{ scope: "period", amount: { value: cap, unit: "tab" },
      period: { value: 1, unit: "d" } }];
    const next = tablet();
    next.amounts![0].quantity!.value = 2;
    next.schedule!.recurrence = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
      clocks: ["20:00:00"], courseLength: { value: 2, unit: "d" } };
    const native: CanonicalCourse = { kind: "course", stages: [
      { administrations: [loading] }, { administrations: [next] }
    ] };
    const projection = projectCanonicalCourse(native);
    expect(projection.fhir).toHaveLength(2);
    for (const rows of [projection.fhir, ...projection.fhirNext.step.map(step => step.component)])
      for (const row of rows)
      expect(Boolean(row.timing?.repeat?.when?.length && row.timing.repeat.timeOfDay?.length)).toBe(false);
    for (const input of [native, JSON.parse(JSON.stringify(projection.fhir)), projection.fhirNext]) {
      expect(nextDueDoses(input, context)).toEqual(cap === 1 ? [
        "2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00",
        "2026-01-02T20:00:00+00:00", "2026-01-03T20:00:00+00:00"
      ] : [
        "2026-01-01T08:00:00+00:00", "2026-01-01T09:00:00+00:00",
        "2026-01-01T20:00:00+00:00", "2026-01-02T20:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ dosage: input, ...context,
        durationValue: 3, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(6);
    }
  });

  it("keeps a current clock edit or deletion and does not apply an event offset to that clock", () => {
    const administration = mixed();
    administration.schedule!.recurrence!.offset = 30;
    const native: CanonicalCourse = { kind: "course", stages: [{ administrations: [administration] }] };
    const row: FhirDosage = JSON.parse(JSON.stringify(projectCanonicalCourse(native).fhir[0]));
    const repeat = row.timing!.repeat!;
    expect(repeat.timeOfDay).toBeUndefined();
    const clock = repeat.extension!.find(field => field.url === clockUrl)!;
    expect(clock.valueTime).toBe("09:00:00");
    const due = (value: FhirDosage) => nextDueDoses([value], { ...context, limit: 2 });
    expect(due(row)).toEqual(["2026-01-01T08:30:00+00:00", "2026-01-01T09:00:00+00:00"]);
    clock.valueTime = "10:00:00";
    expect(due(row)).toEqual(["2026-01-01T08:30:00+00:00", "2026-01-01T10:00:00+00:00"]);
    const rewritten = toFhirR5Dosages(toDosageDetails([row]))[0];
    rewritten.timing!.repeat!.extension = rewritten.timing!.repeat!.extension!.filter(field => field.url !== clockUrl);
    expect(nextDueDoses([rewritten], { ...context, limit: 2 })).toEqual([
      "2026-01-01T08:30:00+00:00", "2026-01-02T08:30:00+00:00"
    ]);
    repeat.timeOfDay = ["11:00:00"];
    const replaced = toFhirR5Dosages(toDosageDetails([row]))[0];
    expect(due(replaced)).toEqual(["2026-01-01T08:30:00+00:00", "2026-01-01T11:00:00+00:00"]);
    expect(importCanonicalCourse(replaced).stages[0].administrations[0].schedule!.recurrence!.clocks).toEqual(["11:00:00"]);
  });
});


describe("round33 adjacent unqualified Thai fractions", () => {
  it.each(["1/2เม็ด", "๑/๒เม็ด", "1/2 เม็ด", "๑/๒ เม็ด"])("retains a half tablet in %s", amount => {
    const source = amount + " วันละครั้ง";
    const parsed = parseSig(source, { locale: "th" });
    expect(parsed.input).toBe(source);
    expect(parsed.meta.canonical.clauses[0].dose).toMatchObject({ value: 0.5, unit: "tab" });
    for (const row of [parsed.fhir[0], parsed.fhirNext.step[0].component[0]]) {
      expect(row.doseAndRate![0].doseQuantity!.value).toBe(0.5);
      expect(getQuantityComparator(row.doseAndRate![0].doseQuantity)).toBeUndefined();
    }
  });
});

describe("round36 clock positions and retained source directions", () => {
  const from = "2026-11-21T00:00:00Z";
  const clockOptions = { from, orderedAt: from, timeZone: "UTC",
    eventClock: { MORN: "08:00", EVE: "18:00", ACM: "06:00" }, limit: 4 };

  it.each(["at 08:00 and in the evening", "at 08:00 and at 20:00"])(
    "retains both predecessor administrations before NEXT: %s", timing => {
      const parsed = parseSig("Take 1 tablet " + timing + ", then 2 tablets the next morning");
      const second = timing.includes("evening") ? "18:00" : "20:00";
      expect(parsed.meta.canonical.clauses[0].schedule?.count).toBeUndefined();
      expect(parsed.meta.canonical.clauses[1].schedule?.count).toBe(1);
      for (const dosage of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext,
        JSON.parse(JSON.stringify(parsed.fhir)), JSON.parse(JSON.stringify(parsed.fhirNext))]) {
        expect(nextDueDoses(dosage, clockOptions)).toEqual([
          "2026-11-21T08:00:00+00:00", "2026-11-21T" + second + ":00+00:00",
          "2026-11-22T08:00:00+00:00"
        ]);
        expect(calculateTotalUnits({ ...clockOptions, dosage, durationValue: 1, durationUnit: "d" }).totalUnits).toBe(2);
        expect(calculateTotalUnits({ ...clockOptions, dosage, durationValue: 3, durationUnit: "d" }).totalUnits).toBe(4);
      }
    });

  it.each(["at 08:00", "at 08:00 in the morning"])(
    "keeps a single clock and its daypart qualification before NEXT after a late order: %s", timing => {
      const parsed = parseSig("Take 1 tablet " + timing + ", then 2 tablets the next morning");
      const late = { ...clockOptions, from: "2026-11-21T09:00:00Z", orderedAt: "2026-11-21T09:00:00Z", limit: 3 };
      expect(parsed.meta.canonical.clauses[1].schedule?.count).toBe(1);
      for (const dosage of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
        expect(nextDueDoses(dosage, late)).toEqual([
          "2026-11-22T08:00:00+00:00", "2026-11-23T08:00:00+00:00"
        ]);
        expect(calculateTotalUnits({ ...late, dosage, durationValue: 4, durationUnit: "d" }).totalUnits).toBe(3);
      }
    });

  it.each([
    "the next morning at 07:00 before breakfast",
    "the next morning before breakfast at 07:00",
    "at 07:00 the next morning before breakfast"
  ])("retains the meal as a qualifier of the NEXT-day clock: %s", timing => {
    const parsed = parseSig("Take 1 tablet " + timing);
    expect(parsed.meta.canonical.clauses[0].schedule?.when).toBeUndefined();
    expect(parsed.longText.toLowerCase()).toContain("before breakfast");
    expect(parsed.meta.canonical.clauses[0].schedule?.count).toBe(1);
    for (const dosage of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext,
      JSON.parse(JSON.stringify(parsed.fhir)), JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      expect(nextDueDoses(dosage, { ...clockOptions, limit: 2 })).toEqual([
        "2026-11-22T07:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ ...clockOptions, dosage, durationValue: 3, durationUnit: "d" }).totalUnits).toBe(1);
    }
  });

  it("keeps an explicitly coordinated meal separate from the NEXT-day clock", () => {
    const parsed = parseSig("Take 1 tablet at 07:00 the next morning and before breakfast");
    expect(parsed.meta.canonical.clauses[0].schedule?.when).toEqual(["ACM"]);
    expect(parsed.meta.canonical.clauses[0].schedule?.count).toBe(2);
    for (const dosage of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
      expect(nextDueDoses(dosage, { ...clockOptions, limit: 3 })).toEqual([
        "2026-11-22T06:00:00+00:00", "2026-11-22T07:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ ...clockOptions, dosage, durationValue: 3, durationUnit: "d" }).totalUnits).toBe(2);
    }
  });

  it.each(["en", "th"])("separates current timing from retained original instructions in %s", locale => {
    const source = "Swallow 1 tablet whole twice daily";
    const wire = { step: [{ component: [{ text: source,
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } }
    }] }] };
    const before = JSON.stringify(wire);
    const options = { locale, realizationMode: "normalized" as const };
    const parsed = fromFhir(wire, options);
    const reopened = fromFhir(toDosageDetails(JSON.parse(JSON.stringify(parsed.fhir))), options);
    for (const result of [parsed, reopened]) {
      for (const text of [result.longText, result.shortText]) {
        expect(text.startsWith(locale === "en" ? "Current:" : "ปัจจุบัน:")).toBe(true);
        expect(text).toContain((locale === "en" ? "original directions: " : "ข้อความเดิม: ") + source);
      }
      expect(result.longText).toContain(locale === "en" ? "once daily" : "วันละครั้ง");
      expect(result.fhirNext.step[0].component[0].text).toBe(source);
    }
    expect(JSON.stringify(wire)).toBe(before);
    const structured = fromFhir({ step: [{ component: [{ ...wire.step[0].component[0],
      doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }]
    }] }] }, options);
    expect(structured.longText).not.toContain(source);
    expect(structured.longText).not.toContain(locale === "en" ? "original directions:" : "ข้อความเดิม:");
  });
});

it("round37 inherits Chew for a resolved divided daily dose, while a real rate keeps its own method", () => {
  const divided = parseSig("Chew 2 tablets once, then 4 tablets daily in 2 divided doses");
  expect(divided.meta.canonical.clauses).toHaveLength(2);
  const second = divided.meta.canonical.clauses[1];
  expect(second.method?.coding?.code).toBe("738992009");
  expect(second.dose).toMatchObject({ value: 2, unit: "tab" });
  expect(second.schedule).toMatchObject({ frequency: 2, period: 1, periodUnit: "d" });
  for (const row of [divided.fhir[1], divided.fhirNext.step[1].component[0]]) {
    expect(row.method?.coding).toContainEqual(expect.objectContaining({ code: "738992009" }));
    expect(row.doseAndRate?.[0].doseQuantity).toMatchObject({ value: 2, unit: "tab" });
    expect(row.doseAndRate?.[0].rateQuantity).toBeUndefined();
  }
  for (const predecessor of ["Chew 2 tablets once", "Chew 4 tablets daily in 2 divided doses"]) {
    const rate = parseSig(predecessor + ", then at 4 mL per hour");
    expect(rate.meta.canonical.clauses).toHaveLength(2);
    expect(rate.meta.canonical.clauses[1].clinicalQuantity?.representation).toBe("rate-quantity");
    expect(rate.meta.canonical.clauses[1].method).toBeUndefined();
    for (const row of [rate.fhir[1], rate.fhirNext.step[1].component[0]]) {
      expect(row.method).toBeUndefined();
      expect(row.doseAndRate?.[0].rateQuantity).toMatchObject({ value: 4, unit: "mL/h" });
    }
  }
});

// END PRESERVED meaning20
}


// Retained regression suite from test/pr14-round21-meaning.spec.ts.
{
// BEGIN PRESERVED meaning21

const tabletQuantity = { value: 1, unit: "tab" };
const tablet: FhirR6Dosage = {
  doseAndRate: [{ doseQuantity: tabletQuantity }],
  timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
};
const cap = { doseLimit: [{ scope: "period" as const,
  valueQuantity: { value: 8, unit: "tab" }, period: { value: 1, unit: "d" } }] };
const normalized = { locale: "en", realizationMode: "normalized" as const };

describe("review 21 current structured course preview", () => {

  it("retains independently structured directions beside a live cap without replaying its opaque stale header", () => {
    const raw: FhirR6DosageInstruction = {
      renderedInstruction: "Take 1 tablet twice daily, maximum 3 tablets per day",
      safety: { doseLimit: [{ scope: "period", valueQuantity: { value: 4, unit: "tab" },
        period: { value: 1, unit: "d" } }] },
      step: [{ component: [{ doseAndRate: tablet.doseAndRate,
        timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day } } }] }]
    };
    const saved = JSON.stringify(raw);
    const text = formatSig(raw, "long", normalized);
    expect(text).toContain("1 tablet twice daily");
    expect(text).toContain("4 tab / 1 d");
    expect(text).not.toContain("maximum 3");
    expect(JSON.stringify(raw)).toBe(saved);
  });

  it("keeps the shared course cap in batch preview and an ordinary custom separator", () => {
    const batch = fromFhir({ safety: cap, step: [{ component: [tablet] }] }, normalized);
    for (const style of ["short", "long"] as const) {
      const text = formatParseBatch(batch, style, " | ");
      expect(text).toContain("Across this course: max per period: 8 tab / 1 d");
      expect(text.match(/8 tab/g)).toHaveLength(1);
    }
    const twoTablets: FhirR6Dosage = {
      ...tablet, doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }]
    };
    const ordinary = fromFhir({ step: [{ component: [tablet, twoTablets] }] }, normalized);
    expect(ordinary.items).toHaveLength(2);
    expect(ordinary.items[0].longText).toContain("1 tablet");
    expect(ordinary.items[1].longText).toContain("2 tablets");
    const joined = formatParseBatch(ordinary, "long", " | ");
    expect(joined.split(" | ")).toHaveLength(2);
    expect(joined).toBe(ordinary.items.map(item => item.longText).join(" | "));
  });

  it("uses the live R6 cadence and dose in normalized preview while retaining the authored source", () => {
    const source = "Take 1 tablet twice daily";
    const raw = JSON.parse(JSON.stringify(parseSig(source).fhirNext)) as FhirR6DosageInstruction;
    raw.safety = cap;
    raw.step[0].component[0].timing!.repeat!.frequency = 3;
    raw.step[0].component[0].doseAndRate![0].doseQuantity!.value = 2;
    const saved = JSON.stringify(raw);
    for (const text of [
      formatSig(raw, "long", normalized),
      fromFhir(raw, normalized).longText,
      formatCanonicalCourse(courseFromR6(raw), "long", normalized),
    ]) {
      expect(text).toMatch(/2 tablets/i);
      expect(text).toMatch(/three times daily/i);
      expect(text).toContain("8 tab / 1 d");
      expect(text).not.toContain("twice daily");
    }
    expect(JSON.stringify(raw)).toBe(saved);
    expect(raw.renderedInstruction).toBe(source);
    expect(formatSig({ renderedInstruction: source }, "long", normalized)).toBe(source);
  });

  it.each(["2026-11-20T15:00:00Z", "2026-11-20T15:30:00+07:00"])(
    "preserves every authored event clock and offset: %s", event => {
      const raw: FhirR6DosageInstruction = { step: [{ component: [{
        doseAndRate: tablet.doseAndRate, timing: { event: [event] },
      }] }] };
      for (const locale of ["en", "th"]) for (const style of ["short", "long"] as const) {
        const text = formatSig(raw, style, { locale, realizationMode: "normalized" });
        expect(text).toContain(event);
      }
      expect(fromFhir(raw).meta.canonical.course!.stages[0].administrations[0].schedule?.explicitEvents)
        .toEqual([event]);
      expect(nextDueDoses(raw, { from: event, orderedAt: event, timeZone: "UTC", limit: 1 })
        .map(Date.parse)).toEqual([Date.parse(event)]);
    }
  );

  it("keeps date-only events date-only", () => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: tablet.doseAndRate, timing: { event: ["2026-11-20"] },
    }] }] };
    const text = formatSig(raw, "long", normalized);
    expect(text).toMatch(/20 Nov 2026/);
    expect(text).not.toMatch(/T00:00|00:00|Z/);
  });

  it.each(["component", "stage", "course"] as const)(
    "retains a %s ifExceeded instruction with and without a numeric limit", scope => {
      const action = "Hold the next dose and call the clinic";
      for (const numeric of [false, true]) {
        const safety = { ...(numeric ? cap : {}), ifExceeded: action };
        const raw: FhirR6DosageInstruction = { step: [{ component: [{ ...tablet }] }] };
        if (scope === "component") {
          raw.step[0].component[0].safety = safety;
          raw.step[0].component.push({ ...tablet,
            doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }] });
        }
        else if (scope === "stage") {
          raw.step[0].safety = safety;
          raw.step.push({ component: [tablet] });
        }
        else raw.safety = safety;
        const text = fromFhir(raw, normalized).longText;
        expect(text).toContain("If the limit is exceeded: " + action);
        expect(text.split(action)).toHaveLength(2);
        if (numeric) expect(text).toContain("8 tab / 1 d");
        if (scope === "component") {
          expect(text).not.toContain("Across this course:");
          expect(text).not.toContain("Within this stage:");
          const [firstComponent, secondComponent] = text.split("2 tablets");
          expect(firstComponent).toContain("1 tablet");
          expect(firstComponent).toContain(action);
          if (numeric) expect(firstComponent).toContain("8 tab / 1 d");
          expect(secondComponent).toBeDefined();
          expect(secondComponent).not.toContain(action);
          expect(secondComponent).not.toContain("8 tab / 1 d");
        }
        const thai = fromFhir(raw, { ...normalized, locale: "th" }).longText;
        expect(thai).toContain("หากเกินขีดจำกัด: " + action);
        expect(thai.split(action)).toHaveLength(2);
        if (scope === "stage") {
          const stageSection = text.split("Within this stage: ")[1]?.split(" then ")[0];
          expect(stageSection).toContain(action);
          if (numeric) expect(stageSection).toContain("8 tab / 1 d");
          expect(text).not.toContain("Across this course:");
          expect(text.split(" then ")[0]).toContain(action);
          expect(text.split(" then ").slice(1).join(" then ")).not.toContain(action);
        }
        if (scope === "course") {
          for (const [rendered, label, exceeded] of [
            [text, "Across this course: ", "If the limit is exceeded: "],
            [thai, "ตลอดแผนการใช้ยานี้: ", "หากเกินขีดจำกัด: "],
          ]) {
            const [administration, courseSafety] = rendered.split(label);
            expect(courseSafety).toContain(exceeded + action);
            expect(administration).not.toContain(action);
            if (numeric) expect(courseSafety).toContain("8 tab / 1 d");
          }
        }
      }
    }
  );

  it("recognizes a safety-only R6 header in both public entry points", () => {
    const raw = { safety: { ...cap, ifExceeded: "Call the clinic" } };
    expect(formatSig(raw, "long", normalized)).toBe(fromFhir(raw, normalized).longText);
    expect(formatSig(raw, "long", normalized)).toContain("8 tab / 1 d");
    expect(formatSig({ safety: { ifExceeded: "Call the clinic" } }, "long", normalized))
      .toContain("Across this course: If the limit is exceeded: Call the clinic");
  });

  it("renders a later ordinary dose after a rate-only entry without duplicating a first dose", () => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      timing: tablet.timing,
      doseAndRate: [{ rateQuantity: { value: 5, unit: "mL/h" } },
        { doseQuantity: { value: 10, unit: "mL" } },
        { doseQuantity: { value: 2, unit: "mg" } }],
    }] }] };
    const text = formatSig(raw, "long", normalized);
    for (const amount of ["5 mL/h", "10 mL", "2 mg"]) expect(text.split(amount)).toHaveLength(2);
    const single = formatSig({ step: [{ component: [tablet] }] }, "long", normalized);
    expect(single.match(/1 tablet/g)).toHaveLength(1);
  });

  it("does not let component text hide a structured blood-pressure condition", () => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      ...tablet, text: "Take 1 tablet daily",
      condition: [{ code: { text: "SBP" }, operation: "gt",
        valueQuantity: { value: 160, unit: "mmHg" } }],
    }] }] };
    const text = fromFhir(raw, normalized).longText;
    expect(text).toMatch(/1 tablet/i);
    expect(text).toContain("only if SBP > 160 mmHg");
    expect(raw.step[0].component[0].text).toBe("Take 1 tablet daily");
  });

  it.each([
    [{ low: { unit: "mg" }, high: { value: 1, unit: "g" } }, /(?:up to|<=|≤) ?1 g/, "1 mg"],
    [{ low: { value: 2, unit: "mg" }, high: { unit: "g" } }, /(?:at least|>=|≥) ?2 mg/, "2 g"],
  ] as const)("takes the unit from a valued one-sided range endpoint", (doseRange, expected, wrong) => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseRange }], timing: tablet.timing,
    }] }] };
    const text = formatSig(raw, "long", normalized);
    expect(text).toMatch(expected);
    expect(text).not.toContain(wrong);
  });

  it("shows distinct two-sided range units and both endpoint qualifiers", () => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseRange: { low: simpleQuantityForR5({ value: 500, unit: "mg", comparator: ">=" }),
        high: simpleQuantityForR5({ value: 1, unit: "g", comparator: "<=" }) } }],
    }] }] };
    expect(formatSig(raw, "long", normalized)).toContain(">=500 mg – <=1 g");
  });
});

describe("review 21 R5 quantity and indication import", () => {
  it("uses a coded quantity unit for a qualified scalar and respects its authored display unit", () => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: simpleQuantityForR5({
      value: 500, code: "mg", system: "http://unitsofmeasure.org", comparator: "~",
    }) }] };
    expect(canonicalFromFhir(row).dose).toMatchObject({ value: 500, unit: "mg", comparator: "~" });
    expect(formatSig(row, "long", normalized)).toMatch(/approximately 500 mg/i);
    row.doseAndRate![0].doseQuantity!.unit = "milligrams";
    expect(canonicalFromFhir(row).dose?.unit).toBe("milligrams");
  });

  it.each([false, true])("retains every PRN reason independently of array order (%s)", reverse => {
    const translated = { _text: { extension: [{
      url: "http://hl7.org/fhir/StructureDefinition/translation",
      extension: [{ url: "lang", valueCode: "th" }, { url: "content", valueString: "คลื่นไส้" }],
    }] } };
    const pain = { text: "pain" };
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: tabletQuantity }],
      asNeededFor: reverse ? [pain, translated] : [translated, pain] };
    const clause = canonicalFromFhir(row);
    expect(clause.prn?.enabled).toBe(true);
    expect(clause.prn?.reasons).toHaveLength(2);
    expect(clause.prn?.reasons?.some(reason => reason.text === "pain")).toBe(true);
    expect(clause.prn?.reasons?.some(reason => reason.i18n?.th === "คลื่นไส้")).toBe(true);
    expect(formatSig(row, "long", normalized)).toMatch(/as needed.*pain/i);
    expect(formatSig(row, "long", { locale: "th", realizationMode: "normalized" })).toContain("คลื่นไส้");
    expect(canonicalFromFhir({ doseAndRate: [{ doseQuantity: tabletQuantity }] }).prn).toBeUndefined();
  });
});

describe("review 21 source graph amount ownership", () => {
  it("renders the unchanged preparation amount once beside an amountless rich drink action", () => {
    const source = "Dissolve 2 tablets in water, then drink slowly";
    const actions = parseInstructionActions(source);
    const drink = actions.find(action => action.predicate.lemma === "drink")!;
    drink.args = [{ role: AdviceArgumentRole.Manner, text: "slowly", normalized: "slowly" }];
    const graph = { sourceText: source, sourceLocale: "en", actions,
      primaryAdministrationSpan: { ...drink.span } };
    const clause = canonicalFromFhir(parseSig("Drink 2 tablets").fhir[0]);
    clause.instructionGraph = parseInstructionGraphExtension([buildInstructionGraphExtension(graph)!]);
    const saved = JSON.stringify(clause.instructionGraph);
    for (const locale of ["en", "th"]) {
      const text = formatCanonicalClause(clause, "long", resolveSigLocalization(locale), normalized);
      expect(text.match(locale === "en" ? /2 tablets/g : /2 เม็ด/g)).toHaveLength(1);
      expect(text.toLowerCase()).toContain(locale === "en" ? "dissolve" : "ละลาย");
      expect(text.toLowerCase()).toContain(locale === "en" ? "drink" : "ดื่ม");
    }
    expect(JSON.stringify(clause.instructionGraph)).toBe(saved);
  });

  it.each(["fresh", "persisted"] as const)(
    "does not revive a removed %s dose but retains duration and the independent spit action", kind => {
      const source = "Swish 10 mL for 30 seconds, then spit";
      const parsed = parseSig(source);
      const row = kind === "fresh" ? parsed.items[0].fhir
        : JSON.parse(JSON.stringify(parsed.fhir[0])) as FhirDosage;
      const savedGraph = canonicalFromFhir(row).instructionGraph;
      delete row.doseAndRate;
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        const text = formatSig(row, "long", { locale: "en", realizationMode });
        expect(text).not.toMatch(/10\s*mL/i);
        expect(text.toLowerCase()).toContain("30 seconds");
        expect(text.toLowerCase()).toContain("spit");
      }
      expect(canonicalFromFhir(row).instructionGraph).toEqual(savedGraph);
    }
  );

  it("uses preserved partial quantity text instead of a unit-only normalized token", () => {
    const actions = parseInstructionActions("Dissolve 2 tablets in water");
    const action = actions[0];
    const amount = action.args.find(arg => arg.role === AdviceArgumentRole.Amount)!;
    amount.text = "up to the prescribed amount";
    amount.normalized = "mg";
    amount.quantity = { unit: "mg", comparator: "<=" };
    const graph = parseInstructionGraphExtension([buildInstructionGraphExtension({
      sourceText: "Dissolve up to the prescribed amount in water", actions,
    })!])!;
    for (const locale of ["en", "th"]) {
      expect(realizeInstructionAction(graph.actions[0], locale)).toContain("up to the prescribed amount");
    }
    expect(graph.actions[0].args.find(arg => arg.role === AdviceArgumentRole.Amount)?.quantity)
      .toEqual({ unit: "mg", comparator: "<=" });
  });
});

describe("review 21 dimensional quantity grammar", () => {
  it.each([
    ["about .5m units", 500000, "U", "~"], ["~.5m units", 500000, "U", "~"],
    ["about .5 mg", 0.5, "mg", "~"], [".5m units", 500000, "U", undefined],
    [".5M IU", 500000, "IU", undefined], ["≤.5m IU", 500000, "IU", "<="],
  ] as const)("keeps the numeric multiplier and comparator together in %s", (source, value, unit, comparator) => {
    const parsed = parseSig(source);
    const quantity = parsed.fhir[0].doseAndRate![0].doseQuantity!;
    expect(quantity).toMatchObject({ value, unit });
    expect(getQuantityComparator(quantity)).toBe(comparator);
    expect(parsed.meta.canonical.clauses[0].dose).toMatchObject({ value, unit });
    expect(parsed.meta.canonical.clauses[0].dose?.comparator).toBe(comparator);
  });

  it.each([
    ["5 mL/h IV for 2 hours", 5, "mL/h", undefined, 2],
    ["5 mL per hour intravenously for 2 hours", 5, "mL/h", undefined, 2],
    ["IV @100mL/hr", 100, "mL/h", undefined, undefined],
    ["IV @ 100 mL/hr", 100, "mL/h", undefined, undefined],
    ["IV @~100mL/hr", 100, "mL/h", "~", undefined],
    ["Infuse heparin IV at approximately 1000 units / hr", 1000, "[iU]/h", "~", undefined],
    ["Infuse heparin IV at ~1000units/hr", 1000, "[iU]/h", "~", undefined],
  ] as const)("retains the licensed rate in %s", (source, value, unit, comparator, duration) => {
    const parsed = parseSig(source);
    const component = parsed.fhirNext.step[0].component[0];
    const amount = component.doseAndRate![0];
    expect(amount.rateQuantity).toMatchObject({ value, unit });
    expect(getQuantityComparator(amount.rateQuantity)).toBe(comparator);
    for (const step of parsed.fhirNext.step) for (const item of step.component)
      for (const dose of item.doseAndRate ?? []) expect(dose.doseQuantity).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0].route?.code).toBe(RouteCode["Intravenous route"]);
    if (duration !== undefined) expect(component.timing?.repeat)
      .toMatchObject({ duration, durationUnit: FhirPeriodUnit.Hour });
  });

  it.each(["100 mL/hr", "100 units/hr", "approximately 100 units / hr"])(
    "does not detach a scalar dose from an unlicensed per-time amount: %s", source => {
      const parsed = parseSig(source);
      for (const step of parsed.fhirNext.step) for (const component of step.component)
        for (const amount of component.doseAndRate ?? []) {
          expect(amount.doseQuantity).toBeUndefined();
          expect(amount.doseRange).toBeUndefined();
          expect(amount.doseExpression).toBeUndefined();
          expect(amount.rateQuantity).toBeUndefined();
          expect(amount.rateRatio).toBeUndefined();
          expect(amount.rateRange).toBeUndefined();
          expect(amount.rateExpression).toBeUndefined();
        }
      expect(parsed.input).toBe(source);
      const displayedSource = [parsed.fhirNext.renderedInstruction,
        ...(parsed.fhirNext.step ?? []).flatMap(step => step.component.map(component => component.text))];
      expect(displayedSource).toContain(source);
    }
  );

  it("keeps a biologic-activity scalar distinct from a rate and @ clocks distinct from rate markers", () => {
    const scalar = parseSig("Inject approximately 1000 units once").fhirNext.step[0].component[0].doseAndRate![0];
    expect(scalar.doseQuantity).toMatchObject({ value: 1000, unit: "U" });
    expect(getQuantityComparator(scalar.doseQuantity)).toBe("~");
    expect(scalar.rateQuantity).toBeUndefined();
    const clock = parseSig("Take 1 tablet @08:00").fhirNext.step[0].component[0];
    expect(clock.timing?.repeat?.timeOfDay).toEqual(["08:00:00"]);
    expect(clock.doseAndRate![0].doseQuantity).toMatchObject({ value: 1, unit: "tab" });
  });

  it.each(["at approximately", "@ approximately", "at most", "at least"])(
    "keeps the weight-rate marker out of an anatomical site: %s", marker => {
      const parsed = parseSig("Infuse IV " + marker + " 0.1 mcg/kg/min");
      const component = parsed.fhirNext.step[0].component[0];
      expect(component.site).toBeUndefined();
      expect(parsed.meta.canonical.clauses[0].site).toBeUndefined();
      expect(parsed.meta.leftoverText).toBeUndefined();
      expect(component.doseAndRate![0].rateQuantity).toMatchObject({ value: 0.1, unit: "ug/kg/min" });
      expect(getQuantityComparator(component.doseAndRate![0].rateQuantity))
        .toBe(marker === "at most" ? "<=" : marker === "at least" ? ">=" : "~");
    }
  );

  it("keeps a 24-hour delay elapsed across the spring DST transition", () => {
    const parsed = parseSig("Take 1 tablet once in 24 hours");
    const course = parsed.meta.canonical.course!;
    expect(course.stages[0].start?.displacement)
      .toMatchObject({ value: 24, unit: "h" });
    const options = { from: "2026-03-07T12:00:00-05:00", orderedAt: "2026-03-07T12:00:00-05:00",
      timeZone: "America/New_York", limit: 1 };
    for (const input of [parsed.fhirNext, parsed.fhir, course]) {
      expect(nextDueDoses(input, options)).toEqual(["2026-03-08T13:00:00-04:00"]);
    }
  });
});

describe("review 21 locale facets and grammar number", () => {
  it("inherits missing clause facets from a regional registration's base language", () => {
    registerSigLocalization({ locale: "th-TH", course: THAI_COURSE });
    const regional = resolveSigLocalization("th-TH")!;
    expect(regional.locale).toBe("th-TH");
    const base = resolveSigLocalization("th")!;
    const dose = { step: [{ component: [tablet] }] };
    for (const style of ["short", "long"] as const)
      expect(formatSig(dose, style, { locale: regional.locale }))
        .toBe(formatSig(dose, style, { locale: base.locale }));
    expect(formatSig({ step: [{ component: [tablet] }] }, "long", { locale: "th-TH" })).toContain("เม็ด");
  });

  it("refreshes a partial region after re-registering its base without scanning on ordinary lookup", () => {
    const before = ({ defaultText }: { defaultText: string }) => "Before " + defaultText;
    const after = ({ defaultText }: { defaultText: string }) => "After " + defaultText;
    const regionalShort = ({ defaultText }: { defaultText: string }) => "Short " + defaultText;
    registerSigLocalization({
      locale: "zz",
      formatShort: before,
      formatLong: before,
      course: ENGLISH_COURSE,
    });
    registerSigLocalization({ locale: "zz-ZZ", formatShort: regionalShort });
    const initial = resolveSigLocalization("zz-ZZ")!;
    expect(formatSig({ step: [{ component: [tablet] }] }, "long", { locale: "zz-ZZ" }))
      .toContain("Before ");
    expect(formatSig({ step: [{ component: [tablet] }] }, "short", { locale: "zz-ZZ" }))
      .toContain("Short ");
    expect(initial.course).toBe(ENGLISH_COURSE);
    registerSigLocalization({
      locale: "zz",
      formatShort: after,
      formatLong: after,
      course: ENGLISH_COURSE,
    });
    const updated = resolveSigLocalization("zz-ZZ")!;
    expect(updated).not.toBe(initial);
    expect(formatSig({ step: [{ component: [tablet] }] }, "long", { locale: "zz-ZZ" }))
      .toContain("After ");
    expect(formatSig({ step: [{ component: [tablet] }] }, "short", { locale: "zz-ZZ" }))
      .toContain("Short ");
    expect(updated.course).toBe(ENGLISH_COURSE);
  });

  it("inherits a missing regional course facet while preserving exact clause callbacks", () => {
    const formatLong = () => "LOCAL DOSE.";
    registerSigLocalization({ locale: "th-extra", formatLong });
    const localization = resolveSigLocalization("th-extra")!;
    expect(formatSig({ step: [{ component: [tablet] }] }, "long", { locale: "th-extra" }))
      .toBe("LOCAL DOSE.");
    expect(localization.course).toBe(THAI_COURSE);
    expect(formatSig({ safety: cap, step: [{ component: [tablet] }] }, "long", { locale: "th-extra" }))
      .toContain("ตลอดแผนการใช้ยานี้:");
    registerSigLocalization({ locale: "th-extra", course: ENGLISH_COURSE });
    expect(formatSig({ step: [{ component: [tablet] }] }, "long", { locale: "th-extra" }))
      .toBe(formatSig({ step: [{ component: [tablet] }] }, "long", { locale: "th" }));
  });

  it("uses singular administration for one and plural wording for multiple/ranged/limited counts", () => {
    expect(ENGLISH_COURSE.administrations("1", "day")).toBe("1 administration per day");
    expect(ENGLISH_COURSE.administrations("2", "day")).toBe("2 administrations per day");
    expect(ENGLISH_COURSE.administrations("1–2", "day")).toBe("1–2 administrations per day");
    const raw = { safety: { doseLimit: [{ scope: "lifetime" as const, valueInteger: 1 }] } };
    expect(formatSig(raw, "long", normalized)).toContain("1 administration");
    expect(formatSig(raw, "long", normalized)).not.toContain("1 administrations");
  });
});


describe("round27 current boundary and metadata-only previews", () => {
  it.each(["stage", "member"] as const)("uses the current structured %s start while retaining old descriptive text", scope => {
    const start = { text: "2 days after follow-up", contextCode: { text: "follow-up" },
      offsetDuration: { value: 2, unit: "d", code: "d" } };
    start.offsetDuration.value = 5;
    const raw: FhirR6DosageInstruction = { step: [{ component: [{ ...tablet }] }] };
    if (scope === "stage") raw.step![0].start = start;
    else raw.step![0].component[0].modifierExtension = [
      encodeR6SourceMetadata(PARALLEL_COMPONENT_PHASE_ORIGIN_URL, { start }, "step"),
    ];
    const text = formatSig(raw, "long", normalized);
    expect(text).toContain("5 days after follow-up");
    expect(text).not.toContain("2 days after follow-up");
    expect(JSON.stringify(projectCanonicalCourse(importCanonicalCourse(raw)).fhirNext)).toContain("2 days after follow-up");
  });

  it("formats an event-relative end as the upper bound of the first stage window", () => {
    const raw: FhirR6DosageInstruction = { step: [{ end: { contextCode: { text: "follow-up" },
      offsetDuration: { value: 2, unit: "d", code: "d" } }, component: [tablet] }] };
    const text = formatSig(raw, "long", normalized);
    expect(text).toContain("Timing requires review: From treatment start until 2 days after follow-up");
    expect(text).not.toContain("onward");
  });

  it("keeps text-only external instructions visible beside nonclinical safety annotations", () => {
    const instruction = "Use the patient's separately supplied administration plan.";
    const annotation = { url: "https://example.org/safety-source", valueString: "external note" };
    const raw: FhirR6DosageInstruction = { renderedInstruction: instruction, safety: { extension: [annotation] } };
    for (const realizationMode of ["roundtrip", "normalized"] as const)
      expect(formatSig(raw, "long", { locale: "en", realizationMode })).toBe(instruction);
    expect(formatSig(raw, "long", { locale: "en" })).toBe(instruction);
    expect(projectCanonicalCourse(importCanonicalCourse(raw)).fhirNext.safety?.extension).toEqual([annotation]);
  });
});

describe("round32 retained clinical labels and incomplete amounts", () => {
  it("uses the first nonblank event coding display without inventing a date", () => {
    const raw: FhirR6DosageInstruction = { step: [{
      start: { contextCode: { coding: [
        { system: "urn:test:event", code: "123", display: " " },
        { system: "urn:test:alternate", code: "visit", display: "Follow-up visit" }
      ] }, offsetDuration: { value: 2, unit: "d" } }, component: [tablet]
    }] };
    const before = JSON.stringify(raw);
    for (const locale of ["en", "th"]) {
      const text = formatSig(raw, "long", { locale, realizationMode: "normalized" });
      expect(text).toContain("Follow-up visit");
      expect(text).toContain(locale === "en" ? "2 days" : "2 วัน");
    }
    expect(JSON.stringify(raw)).toBe(before);
  });

  it.each(["quantity", "range"] as const)("keeps authored component text when %s carries no value", kind => {
    const amount = kind === "quantity" ? { doseQuantity: { unit: "tab" } }
      : { doseRange: { low: { unit: "tab" }, high: { unit: "tab" } } };
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      text: "Take one tablet daily", doseAndRate: [amount]
    }] }] };
    const before = JSON.stringify(raw);
    for (const locale of ["en", "th"]) for (const style of ["short", "long"] as const) {
      expect(formatSig(raw, style, { locale, realizationMode: "normalized" })).toBe("Take one tablet daily");
    }
    expect(JSON.stringify(raw)).toBe(before);
    const live = JSON.parse(before) as FhirR6DosageInstruction;
    live.step![0].component![0].timing = { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day } };
    const liveBefore = JSON.stringify(live);
    const rows = toFhirR5Dosages(live), rowsBefore = JSON.stringify(rows);
    for (const input of [live, rows, toDosageDetails(JSON.parse(rowsBefore))])
      for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        expect(text).toBe(locale === "en"
          ? "Current: Use the medication twice daily; original directions: Take one tablet daily"
          : "ปัจจุบัน: ใช้ยา วันละ 2 ครั้ง; ข้อความเดิม: Take one tablet daily");
      }
    expect(JSON.stringify(live)).toBe(liveBefore);
    expect(JSON.stringify(rows)).toBe(rowsBefore);
    const valued = JSON.parse(liveBefore) as FhirR6DosageInstruction;
    valued.step![0].component[0].doseAndRate = [{ doseQuantity: { value: 2, unit: "tab" } }];
    const current = formatSig(valued, "long", normalized);
    expect(current).toContain("2 tablets");
    expect(current).toContain("twice daily");
    expect(current).not.toContain("original directions");
  });

  it("retains a live R6 site qualifier beyond its recognized body-site code", () => {
    const site = { text: "left eye, lower conjunctival sac", coding: [
      { system: "http://snomed.info/sct", code: "1290031003", display: "Structure of left eye proper" }
    ] };
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      ...tablet, site: { concept: site }
    }] }] };
    const before = JSON.stringify(raw);
    const imported = fromFhir(raw, normalized);
    expect(imported.meta.canonical.clauses[0].site?.text).toBe(site.text);
    const preview = formatSig(raw, "long", normalized);
    expect(preview).toContain("left eye, lower conjunctival sac");
    expect(preview).not.toContain("right eye");
    expect(JSON.stringify(raw)).toBe(before);
  });
});

describe("round32 live cycle qualifier", () => {
  it.each([
    { advice: false, days: [1, 15], label: "1, 15" },
    { advice: true, days: [1, 15], label: "1, 15" },
    { advice: false, days: [1, 2, 3, 8, 15, 16], label: "1-3, 8, 15-16" },
    { advice: true, days: [1, 2, 3, 8, 15, 16], label: "1-3, 8, 15-16" },
  ])("uses edited cycle days $label beside retained source wording (advice $advice)", ({ advice, days, label }) => {
    const qualifier = "on days 1 and 8 of each cycle";
    const modifier = { url: CYCLE_DAY_ELIGIBILITY_EXTENSION_URL, extension: [
      { url: "day", valueInteger: 1 }, { url: "day", valueInteger: 8 },
      { url: "periodDays", valueInteger: 21 },
      { url: "reason", valueCode: "unresolved-cycle-eligibility" },
      { url: "source", valueString: qualifier }
    ] };
    const text = "Take 1 tablet " + qualifier + ", maximum 2 tablets daily.";
    const row: FhirDosage = withDosageEditProvenance([{
      text, doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
      maxDosePerPeriod: [{ numerator: { value: 2, unit: "tab" }, denominator: { value: 1, unit: "d" } }],
      modifierExtension: [modifier],
      ...(advice ? { additionalInstruction: [{ text: qualifier }] } : {})
    }], text)[0];
    formatSig(row, "long", { locale: "en", realizationMode: "roundtrip" });
    modifier.extension.splice(0, 2, ...days.map(day => ({ url: "day", valueInteger: day })));
    const before = JSON.stringify(row);
    for (const input of [row, JSON.parse(before)]) for (const locale of ["en", "th"]) {
      const current = formatSig(input, "long", { locale, realizationMode: "roundtrip" });
      expect(current).toContain((locale === "en" ? "cycle days " : "วันที่ในรอบ ") + label);
      expect(current).toContain(locale === "en" ? "21-day cycle" : "รอบละ 21 วัน");
      expect(current).not.toContain(qualifier);
    }
    expect(JSON.stringify(row)).toBe(before);
  });
});

it("round32: a code-only site edit supersedes its exact contradictory old label", () => {
  const raw: FhirR6DosageInstruction = { step: [{ component: [{
    ...tablet, site: { concept: { text: "right eye", coding: [
      { system: "http://snomed.info/sct", code: "1290031003", display: "Structure of left eye proper" }
    ] } }
  }] }] };
  const before = JSON.stringify(raw);
  const imported = fromFhir(raw, normalized);
  expect(imported.meta.canonical.clauses[0].site?.text).toBe("left eye");
  expect(formatSig(raw, "long", normalized)).toContain("left eye");
  expect(formatSig(raw, "long", normalized)).not.toContain("right eye");
  expect(JSON.stringify(raw)).toBe(before);
});

describe("round33 complete native amount and cadence previews", () => {
  const wire = (repeat: NonNullable<FhirR6Dosage["timing"]>["repeat"]): FhirR6DosageInstruction =>
    ({ step: [{ component: [{ doseAndRate: tablet.doseAndRate, timing: { repeat } }] }] });
  it.each([EventTiming.Night, EventTiming.Morning])("keeps both period endpoints for alternate %s", when => {
    for (const maximum of [undefined, 2, 3]) {
      const raw = wire({ period: 2, periodMax: maximum, periodUnit: FhirPeriodUnit.Day, when: [when] });
      for (const locale of ["en", "th"]) {
        const text = formatSig(raw, "long", { locale });
        if (maximum === 3) {
          expect(text).toContain(locale === "en" ? "2 to 3 days" : "2 ถึง 3 วัน");
          expect(text).toContain(locale === "en" ? when === EventTiming.Night ? "night" : "morning"
            : when === EventTiming.Night ? "กลางคืน" : "เช้า");
          expect(text).not.toMatch(/every other|วันเว้นคืน|เช้าเว้นเช้า/u);
        } else expect(text).toContain(locale === "en" ? when === EventTiming.Night ? "every other night" : "every other morning"
          : when === EventTiming.Night ? "วันเว้นคืน" : "เช้าเว้นเช้า");
      }
    }
  });
  it.each([
    [FhirPeriodUnit.Minute, 30, "minutes", "นาที"],
    [FhirPeriodUnit.Hour, 8, "hours", "ชั่วโมง"],
    [FhirPeriodUnit.Day, 2, "days", "วัน"],
    [FhirPeriodUnit.Week, 2, "weeks", "สัปดาห์"],
    [FhirPeriodUnit.Month, 2, "months", "เดือน"],
    [FhirPeriodUnit.Year, 2, "years", "ปี"],
  ] as const)("keeps two administrations per fixed %s period", (periodUnit, period, en, th) => {
    const raw = wire({ frequency: 2, period, periodUnit });
    const before = JSON.stringify(raw);
    expect(formatSig(raw, "long", { locale: "en" })).toContain("twice every " + period + " " + en);
    for (const style of ["short", "long"] as const)
      expect(formatSig(raw, style, { locale: "th" })).toContain("2 ครั้ง ทุก " + period + " " + th);
    expect(JSON.stringify(raw)).toBe(before);
  });
  it("keeps one administration's simple fixed interval wording", () => {
    const raw = wire({ frequency: 1, period: 8, periodUnit: FhirPeriodUnit.Hour });
    expect(formatSig(raw, "long", { locale: "en" })).toContain("every 8 hours");
    expect(formatSig(raw, "long", { locale: "en" })).not.toContain("twice");
    expect(formatSig(raw, "long", { locale: "th" })).toContain("ทุก 8 ชั่วโมง");
  });
  it.each([
    [{ frequency: 1, frequencyMax: 2 }, "1 to 2 times every 8 hours", "1 ถึง 2 ครั้ง ทุก 8 ชั่วโมง"],
    [{ frequencyMax: 2 }, "up to 2 times every 8 hours", "ไม่เกิน 2 ครั้ง ทุก 8 ชั่วโมง"]
  ])("keeps fixed-period frequency bounds %j", (frequency, en, th) => {
    const raw = wire({ ...frequency, period: 8, periodUnit: FhirPeriodUnit.Hour });
    expect(formatSig(raw, "long", { locale: "en" })).toContain(en);
    expect(formatSig(raw, "long", { locale: "th" })).toContain(th);
  });
  it.each([
    [FhirPeriodUnit.Day, "daily", "วัน"],
    [FhirPeriodUnit.Week, "weekly", "สัปดาห์"],
    [FhirPeriodUnit.Month, "monthly", "เดือน"],
    [FhirPeriodUnit.Year, "yearly", "ปี"],
  ] as const)("keeps an upper-only administration count at one %s period", (periodUnit, en, th) => {
    const raw = wire({ frequencyMax: 2, period: 1, periodUnit });
    expect(formatSig(raw, "long", { locale: "en" })).toContain("up to 2 times " + en);
    for (const style of ["short", "long"] as const)
      expect(formatSig(raw, style, { locale: "th" })).toContain(th + "ละไม่เกิน 2 ครั้ง");
  });
  it("keeps an offset weekly window distinct from an inferred daily summary", () => {
    const raw = wire({ frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Week,
      timeOfDay: ["08:00:00", "20:00:00"], startOffset: { value: 1, unit: "d" } });
    for (const locale of ["en", "th"]) {
      const text = formatSig(raw, "long", { locale, includeTimesPerDaySummary: true });
      expect(text).toContain(locale === "en" ? "2 administrations per 1 week" : "ให้ยา 2 ครั้งต่อช่วง 1 สัปดาห์");
      expect(text).toContain(locale === "en" ? "8:00 am" : "08:00");
      expect(text).toContain(locale === "en" ? "8:00 pm" : "20:00");
      expect(text).not.toMatch(/twice daily|วันละ 2 ครั้ง/u);
    }
  });
  const dose = (code: string, value: number) => ({
    type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/dose-rate-type", code }] },
    doseQuantity: { value, unit: "mg" }
  });
  it.each([false, true])("labels ordered and calculated amounts independently of order (%s)", reverse => {
    const amounts = [dose("calculated", 2), dose("ordered", 3)];
    if (reverse) amounts.reverse();
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      ...tablet, doseAndRate: amounts
    }] }] };
    const before = JSON.stringify(raw);
    for (const input of [raw, toFhirR5Dosages(raw)]) for (const style of ["short", "long"] as const) {
      const en = formatSig(input, style, { locale: "en" });
      const th = formatSig(input, style, { locale: "th" });
      expect(en).toContain("Calculated dose: 2 mg");
      expect(en).toContain("Ordered dose: 3 mg");
      expect(en).not.toMatch(/(?:Use|Take) (?:2|3) mg/u);
      expect(th).toContain(style === "short" ? "ขนาดยาที่คำนวณ: 2 มก" : "ขนาดยาที่คำนวณ: ครั้งละ 2 มิลลิกรัม");
      expect(th).toContain(style === "short" ? "ขนาดยาที่สั่ง: 3 มก" : "ขนาดยาที่สั่ง: ครั้งละ 3 มิลลิกรัม");
      expect(th).not.toMatch(/ใช้ครั้งละ (?:2|3) /u);
    }
    expect(fromFhir(raw).meta.canonical.clauses[0].dose).toBeUndefined();
    const rows = toFhirR5Dosages(raw);
    expect(fromFhirDosage(rows[0]).meta.canonical.clauses[0].dose).toBeUndefined();
    expect(rows[0].doseAndRate?.map(amount => amount.doseQuantity?.unit)).toEqual(["mg", "mg"]);
    expect(toDosageDetails(rows).step![0].component[0].doseAndRate?.map(amount => amount.doseQuantity?.unit))
      .toEqual(["mg", "mg"]);
    expect(JSON.stringify(raw)).toBe(before);
  });
  it.each([false, true])("keeps discrete each-target scope and metric totals in either role order (%s)", reverse => {
    const amounts = [
      { type: dose("ordered", 1).type, doseQuantity: simpleQuantityForR5({ value: 1, unit: "spray", comparator: "~" })! },
      { type: dose("calculated", 2).type, doseQuantity: { value: 2, unit: "mg" } }
    ];
    if (reverse) amounts.reverse();
    const raw: FhirR6DosageInstruction = { renderedInstruction: "Use approximately 1 spray in each nostril",
      step: [{ component: [{ route: { text: "intranasal" },
        site: { concept: { text: "both nostrils" } }, doseAndRate: amounts }] }] };
    const before = JSON.stringify(raw), rows = toFhirR5Dosages(raw);
    for (const locale of ["en", "th"]) {
      const tag = locale + "-x-round33-dose-scope";
      // A course-only regional pack inherits the same dose grammar as its
      // clause callbacks; quantity wording remains a language-pack facet.
      registerSigLocalization({ locale: tag, course: locale === "en" ? ENGLISH_COURSE : THAI_COURSE });
      for (const input of [raw, rows]) {
        const text = formatSig(input, "long", { locale: tag, realizationMode: "normalized" });
        expect(text).toContain(locale === "en" ? "Ordered dose: approximately 1 spray (each nostril)"
          : "ขนาดยาที่สั่ง: รูจมูกข้างละ ประมาณ 1 ครั้ง");
        expect(text).toContain(locale === "en" ? "Calculated dose: 2 mg"
          : "ขนาดยาที่คำนวณ: ครั้งละ 2 มิลลิกรัม");
        expect(text).not.toContain(locale === "en" ? "2 mg (each nostril)" : "ข้างละ 2 มิลลิกรัม");
        expect(text.match(locale === "en" ? /each nostril/gu : /ข้างละ/gu)).toHaveLength(1);
      }
    }
    expect(fromFhir(raw).meta.canonical.clauses[0].dose).toBeUndefined();
    expect(fromFhirDosage(rows[0]).meta.canonical.clauses[0].dose).toBeUndefined();
    expect(JSON.stringify(raw)).toBe(before);
  });
  it.each([true, false])("retains code-only equal units on a total metric role-labelled range (known low unit %s)", knownLow => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      route: { text: "intranasal" }, site: { concept: { text: "both nostrils" } },
      doseAndRate: [{ type: dose("ordered", 1).type, doseRange: {
        low: knownLow ? { value: 1, system: "http://unitsofmeasure.org", code: "mg" } : { value: 1 },
        high: { value: 2, system: "http://unitsofmeasure.org", code: "mg" }
      } }]
    }] }] };
    const before = JSON.stringify(raw);
    // A single known endpoint supplies the compact range's unit without
    // filling in or changing the retained source endpoint.
    for (const input of [raw, toFhirR5Dosages(raw)]) {
      const english = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      const thai = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(english).toContain("Ordered dose: 1 to 2 mg");
      expect(english).not.toContain("each nostril");
      expect(thai).toContain("ขนาดยาที่สั่ง: ครั้งละ 1 ถึง 2 มิลลิกรัม");
      expect(thai).not.toContain("ข้างละ");
    }
    expect(fromFhir(raw).meta.canonical.clauses[0].dose).toBeUndefined();
    expect(JSON.stringify(raw)).toBe(before);
  });
  it("labels a single calculated dose and leaves the simple untyped dose unchanged", () => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{ ...tablet, doseAndRate: [dose("calculated", 2)] }] }] };
    expect(formatSig(raw, "long", { locale: "en" })).toContain("Calculated dose: 2 mg");
    expect(fromFhir(raw).meta.canonical.clauses[0].dose).toBeUndefined();
    expect(formatSig({ step: [{ component: [tablet] }] }, "long", { locale: "en" })).toContain("1 tablet once daily");
  });
  it("keeps annotation-only amount types on the ordinary untyped dose path", () => {
    const amount = { doseQuantity: { value: 1, unit: "tab" }, type: {
      id: "type-annotation", extension: [{ url: "urn:example:annotation", valueString: "kept" }],
      coding: [{ id: "coding-annotation", extension: [{ url: "urn:example:coding", valueBoolean: true }] }]
    } };
    const raw: FhirR6DosageInstruction = { step: [{ component: [{ ...tablet, doseAndRate: [amount] }] }] };
    const before = JSON.stringify(raw), rows = toFhirR5Dosages(raw);
    for (const input of [raw, rows]) {
      const result = Array.isArray(input) ? fromFhirDosage(input[0]) : fromFhir(input);
      expect(result.meta.canonical.clauses[0].dose).toMatchObject({ value: 1, unit: "tab" });
      expect(formatSig(input, "long", { locale: "en" })).toContain("1 tablet once daily");
      expect(formatSig(input, "long", { locale: "en" })).not.toContain("unspecified");
    }
    expect(rows[0].doseAndRate?.[0].type).toEqual(amount.type);
    expect(JSON.stringify(raw)).toBe(before);
  });
  it.each([
    [{ type: dose("calculated", 2).type, doseRange: { low: { value: 2, unit: "mg" }, high: { value: 4, unit: "mg" } } },
      "Calculated dose: 2–4 mg"],
    [{ type: dose("ordered", 0).type, doseQuantity: { value: 0, unit: "mg" } }, "Ordered dose: 0 mg"],
    [{ type: { text: "locally adjusted", coding: [{ system: "urn:example:role", code: "ordered" }] },
      doseQuantity: { value: 3, unit: "mg" } }, "Dose (locally adjusted): 3 mg"],
    [{ type: dose("calculated", 2).type, doseQuantity: { unit: "mg" } }, "Calculated dose: unspecified mg"],
    [{ type: dose("calculated", 2).type, rateQuantity: { value: 2, unit: "mg/h" } }, "Calculated rate: 2 mg/h"],
  ] as const)("keeps the role on each native dose or rate choice %j", (amount, expected) => {
    const raw = { step: [{ component: [{ ...tablet, doseAndRate: [amount] }] }] } as FhirR6DosageInstruction;
    expect(formatSig(raw, "long", { locale: "en" })).toContain(expected);
    expect(fromFhir(raw).meta.canonical.clauses[0].dose).toBeUndefined();
  });
  it.each(["en", "th"])("uses the registered %s event-window facet through inherited clause formatting", locale => {
    const tag = locale + "-x-round33-window";
    registerSigLocalization({ locale: tag, course: {
      ...(locale === "en" ? ENGLISH_COURSE : THAI_COURSE),
      eventWindow: (start, end) => "REGISTERED WINDOW " + start + " -> " + end
    } });
    const parsed = parseSig("take 1 tablet from breakfast to dinner");
    const clause = { ...parsed.meta.canonical.clauses[0], schedule: {
      eventWindow: { start: EventTiming.Breakfast, end: EventTiming.Dinner }
    } };
    for (const style of ["short", "long"] as const) {
      const text = formatCanonicalClause(clause, style, resolveSigLocalization(tag));
      expect(text).toContain("REGISTERED WINDOW");
      expect(text).toContain(locale === "en" ? "breakfast" : "อาหารเช้า");
      expect(text).toContain(locale === "en" ? "dinner" : "อาหารเย็น");
    }
  });
});


describe("round34 typed recurrence and locale previews", () => {
  const code = (value: string) => ({ coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: value }] });
  it.each([
    [{ frequencyMax: 2 }, "<=2x/1d", "up to 2 times daily"],
    [{ frequency: 2 }, "BID", "twice daily"],
    [{ frequency: 1, frequencyMax: 2 }, "1-2x/d", "one to two times daily"]
  ])("does not promote a frequency bound to fixed shorthand (%j)", (frequency, short, long) => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      ...tablet, timing: { code: code("BID"), repeat: { ...frequency, period: 1, periodUnit: FhirPeriodUnit.Day } }
    }] }] };
    const before = JSON.stringify(raw);
    for (const input of [raw, JSON.parse(JSON.stringify(toFhirR5Dosages(raw)))]) {
      expect(formatSig(input, "short", normalized)).toContain(short);
      expect(formatSig(input, "long", normalized)).toContain(long);
      if (!("frequency" in frequency) || frequency.frequency !== 2)
        expect(formatSig(input, "short", normalized)).not.toContain("BID");
    }
    expect(JSON.stringify(raw)).toBe(before);
  });

  it.each([
    [{ period: 8, periodUnit: FhirPeriodUnit.Hour }, false, "8 hours"],
    [{ period: 6, periodUnit: FhirPeriodUnit.Hour }, true, "6 hours"],
    [{ period: 6, periodMax: 8, periodUnit: FhirPeriodUnit.Hour }, false, "6–8 hours"],
    [{ period: 6, periodUnit: FhirPeriodUnit.Day }, false, "6 days"],
    [{ frequency: 1, period: 6, periodUnit: FhirPeriodUnit.Hour }, false, "6 hours"]
  ] as const)("checks a timing code against its original offset period (%j)", (repeat, keepCode, period) => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      ...tablet, timing: { code: code("Q6H"), repeat: { ...repeat, startOffset: { value: 1, unit: "h" } } }
    }] }] };
    const before = JSON.stringify(raw);
    for (const input of [raw, JSON.parse(JSON.stringify(toFhirR5Dosages(raw)))]) {
      const text = formatSig(input, "short", normalized);
      expect(text.includes("Q6H")).toBe(keepCode);
      expect(text).toContain(period);
      expect(text).toContain("1 hour");
      expect(text).toContain("1 tab");
    }
    expect(JSON.stringify(raw)).toBe(before);
  });

  it.each(["step", "member"] as const)("shows signed %s starts without making negative day ranges", where => {
    for (const value of [-30, 30]) {
      const boundary = { anchor: "treatment-start" as const, displacement: { value, unit: "min" } };
      const native = { kind: "course" as const, stages: [{
        ...(where === "step" ? { start: boundary } : {}),
        administrations: [{ kind: "administration" as const,
          ...(where === "member" ? { phaseStart: boundary } : {}),
          amounts: [{ quantity: { value: 1, unit: "tab" } }] }]
      }] };
      const before = JSON.stringify(native);
      const r6 = projectCanonicalCourse(native).fhirNext;
      for (const input of [native, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
        for (const style of ["short", "long"] as const) {
          const english = formatSig(input, style, normalized);
          const thai = formatSig(input, style, { locale: "th", realizationMode: "normalized" });
          expect(english).toContain("30 minutes " + (value < 0 ? "before" : "after") + " treatment start");
          expect(thai).toContain("30 นาที");
          expect(thai).toContain(value < 0 ? "ก่อน" : "หลัง");
          expect(english).not.toMatch(/No dose|Review timing|Days? -/u);
        }
      }
      expect(JSON.stringify(native)).toBe(before);
    }
  });

  it("uses the effective inherited and custom course facets for regenerated cycle details", () => {
    const clause = canonicalFromFhir({
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } }
    });
    clause.schedule!.cycleDayConstraint = {
      days: [1, 2, 3, 8], periodDays: 21, cycles: 4, anchor: "2026-11-21",
      sourceText: "", reason: "unresolved-cycle-eligibility"
    };
    const inherited = resolveSigLocalization("en", { locale: "en", inherit: "th" });
    for (const style of ["short", "long"] as const) {
      const text = formatCanonicalClause(clause, style, inherited);
      expect(text).toContain("ยังระบุเวลาในรอบไม่ได้");
      expect(text).toContain("วันที่ในรอบ 1-3, 8");
      expect(text).toContain("รอบละ 21 วัน");
      expect(text).toContain("4 รอบ");
      expect(text).toContain("วันเริ่มรอบ 2026-11-21");
      expect(text).not.toContain("cycle days");
    }
    const calls: unknown[][] = [];
    const custom = resolveSigLocalization("round34-cycle", {
      locale: "round34-cycle", inherit: "en",
      course: { ...ENGLISH_COURSE, unresolvedCycleTiming: (days, periodDays, cycles, anchor) => {
        calls.push([days, periodDays, cycles, anchor]);
        return "Local cycle " + days + " | " + periodDays + " | " + cycles + " | " + anchor;
      } }
    });
    expect(formatCanonicalClause(clause, "long", custom)).toContain("Local cycle 1-3, 8 | 21 | 4 | 2026-11-21");
    expect(calls).toEqual([["1-3, 8", 21, 4, "2026-11-21"]]);
  });
});

// END PRESERVED meaning21
}


describe("round39 Thai infusion-duration labels", () => {
  it.each(["min", "min{infusion}", "unknown-duration"])("localizes recognized code %s and preserves unknown labels", code => {
    const range = { low: { value: 90, code, unit: code === "unknown-duration" ? "clinic ticks" : "minutes" },
      high: { value: 2, code: "h", unit: "hours" } };
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: { count: 1, extension: [{
        url: "urn:ezmedicationinput:StructureDefinition:timing-administration-duration", valueRange: range
      }] } },
      doseAndRate: [{ rateQuantity: { value: 20, unit: "mL/hour", code: "mL/h", system: "http://unitsofmeasure.org" } }]
    }] }] };
    const original = JSON.stringify(raw);
    const course = courseFromR6(raw);
    for (const input of [raw, course, JSON.parse(JSON.stringify(toFhirR5Dosages(raw)))]) {
      const thai = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(thai).toContain(code === "unknown-duration" ? "90 clinic ticks ถึง 2 ชั่วโมง" : "90 นาที ถึง 2 ชั่วโมง");
      expect(thai).not.toContain("2 hours");
    }
    expect(course.stages[0].administrations[0].schedule!.recurrence!.occurrenceDurationRange).toEqual(range);
    expect(JSON.stringify(raw)).toBe(original);
    const emitted = courseToR6(course).step![0].component[0].timing!.repeat!.extension!
      .find(extension => extension.url === "urn:ezmedicationinput:StructureDefinition:timing-administration-duration")!;
    expect(emitted.valueRange).toEqual(range);
  });
});


describe("round39 locale-owned target count and duration words", () => {
  const ENGLISH_COURSE = resolveSigLocalization("en")!.course!;
  const THAI_COURSE = resolveSigLocalization("th")!.course!;
  it.each(["en", "th", "third"] as const)("uses the selected %s course facet for live application count", locale => {
    const base = locale === "en" ? ENGLISH_COURSE : THAI_COURSE;
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "g" } }],
      site: { text: "lesions", extension: [{
        url: "urn:ezmedicationinput:body-site-administration-target-count", valueInteger: 3
      }] } };
    const i18n = { locale: locale === "third" ? "xx-round39" : locale,
      inherit: locale === "en" ? "en" : "th",
      course: { ...base, applicationSites: (count: number) => "pack-site-count-" + count } };
    for (const style of ["long", "short"] as const) {
      const text = formatSig(row, style, { locale: i18n.locale, i18n, realizationMode: "normalized" });
      expect(text).toContain("pack-site-count-3");
      expect(text).not.toContain("across 3 sites");
      expect(text).not.toContain("รวม 3 จุด");
    }
  });

  it("uses an inherited Thai formatter's selected temporal-unit facet", () => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: { extension: [{
        url: "urn:ezmedicationinput:StructureDefinition:timing-administration-duration",
        valueRange: { low: { value: 90, code: "min", unit: "minutes" }, high: { value: 2, code: "h", unit: "hours" } }
      }] } },
      doseAndRate: [{ rateQuantity: { value: 20, unit: "mL/hour", code: "mL/h", system: "http://unitsofmeasure.org" } }]
    }] }] };
    const i18n = { locale: "xx-round39-time", inherit: "th", course: {
      ...THAI_COURSE, timeUnit: (unit: string) => "pack-time-" + unit
    } };
    const text = formatSig(raw, "long", { i18n, realizationMode: "normalized" });
    expect(text).toContain("90 pack-time-min ถึง 2 pack-time-h");
    expect(text).not.toContain("minutes");
    expect(text).not.toContain("ชั่วโมง");
  });
});

describe("round 44: course-wide choice and timing ownership", () => {
  const boundary = (value: number): CanonicalBoundary => ({
    anchor: "treatment-start", displacement: { value, system: "http://unitsofmeasure.org", code: "d" }
  });
  const member = (value: number, branch?: string): CanonicalAdministration => ({
    kind: "administration", amounts: [{ quantity: { value, unit: "tab" } }],
    schedule: { recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, clocks: ["08:00:00"] } },
    ...(branch ? { choice: { groupId: "taper", branchId: branch } } : {})
  });
  const views = (course: CanonicalCourse) => {
    const r6 = courseToR6(course);
    return [r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))];
  };

  it.each(["en", "th"])("retains text-only application directions beside a member end in %s", locale => {
    const text = "Apply a thin layer to the affected area";
    const course: CanonicalCourse = { kind: "course", instruction: text, stages: [{
      administrations: [{ kind: "administration", text, phaseEnd: boundary(3) }]
    }] };
    for (const input of views(course)) {
      const before = JSON.stringify(input);
      expect(formatSig(input, "long", { locale, realizationMode: "normalized" }))
        .toBe((locale === "en" ? "Until 3 days after treatment start: " : "จนถึง3 วันหลังเริ่มการรักษา: ") + text);
      expect(JSON.stringify(input)).toBe(before);
    }
    const untimed = courseToR6({ ...course, stages: [{ administrations: [{ kind: "administration", text }] }] });
    expect(formatSig(untimed, "long", { locale, realizationMode: "normalized" })).toBe(text);
  });

  it.each(["en", "th"])("ties each taper branch to one choice across reordered stages in %s", locale => {
    const course: CanonicalCourse = { kind: "course", stages: [
      { start: boundary(0), end: boundary(7), administrations: [member(2, "A"), member(4, "B")] },
      { end: boundary(14), administrations: [member(3, "B"), member(1, "A")] }
    ] };
    const expected = locale === "en" ? [
      "Choose one: (1) or (2).",
      "From treatment start until 7 days after treatment start: (1) Use 2 tablets once daily at 8:00 am; (2) Use 4 tablets once daily at 8:00 am.",
      "From 7 days after treatment start until 14 days after treatment start: (2) Use 3 tablets once daily at 8:00 am; (1) Use 1 tablet once daily at 8:00 am."
    ] : [
      "เลือกอย่างใดอย่างหนึ่ง: (1) หรือ (2).",
      "ตั้งแต่เริ่มการรักษาจนถึง7 วันหลังเริ่มการรักษา: (1) ใช้ครั้งละ 2 เม็ด วันละครั้ง เวลา 08:00; (2) ใช้ครั้งละ 4 เม็ด วันละครั้ง เวลา 08:00.",
      "ตั้งแต่7 วันหลังเริ่มการรักษาจนถึง14 วันหลังเริ่มการรักษา: (2) ใช้ครั้งละ 3 เม็ด วันละครั้ง เวลา 08:00; (1) ใช้ครั้งละ 1 เม็ด วันละครั้ง เวลา 08:00."
    ];
    for (const input of views(course)) {
      const before = JSON.stringify(input);
      expect(formatSig(input, "long", { locale, realizationMode: "normalized" })).toBe(expected.join(" "));
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["en", "th"])("qualifies the B-only pause without forbidding A's successor doses in %s", locale => {
    const course: CanonicalCourse = { kind: "course", stages: [
      { start: boundary(0), end: boundary(2), administrations: [member(1, "A")] },
      { start: boundary(4), end: boundary(6), administrations: [member(2, "B")] },
      { end: boundary(8), administrations: [member(3)] }
    ] };
    const pause = locale === "en" ? "No doses from treatment start until 4 days after treatment start."
      : "งดยาตั้งแต่เริ่มการรักษาจนถึง4 วันหลังเริ่มการรักษา.";
    for (const input of views(course)) {
      const before = JSON.stringify(input);
      const preview = formatSig(input, "long", { locale, realizationMode: "normalized" });
      expect(preview.endsWith("(2): " + pause)).toBe(true);
      expect(preview.split(locale === "en" ? "No doses" : "งดยา")).toHaveLength(2);
      expect(preview).toContain(locale === "en"
        ? "After the previous phase; Until 8 days after treatment start: Use 3 tablets"
        : "หลังขั้นตอนก่อนหน้า; จนถึง8 วันหลังเริ่มการรักษา: ใช้ครั้งละ 3 เม็ด");
      const options = { orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-03T00:00:00Z", timeZone: "UTC", limit: 2 };
      expect(nextDueDoses(input, { ...options, alternativeChoices: { taper: "A" } })).toEqual([
        "2026-01-03T08:00:00+00:00", "2026-01-04T08:00:00+00:00"
      ]);
      expect(nextDueDoses(input, { ...options, alternativeChoices: { taper: "B" } })).toEqual([
        "2026-01-05T08:00:00+00:00", "2026-01-06T08:00:00+00:00"
      ]);
      expect(JSON.stringify(input)).toBe(before);
    }
    for (const input of views({ ...course, stages: course.stages.slice(1) })) {
      expect(formatSig(input, "long", { locale, realizationMode: "normalized" }).endsWith(pause)).toBe(true);
    }
  });

  it.each(["en", "th"])("uses the selected %s facet for scalar and ranged long duration units", locale => {
    const base = locale === "en" ? ENGLISH_COURSE : THAI_COURSE;
    const course = { ...base, timeUnit: (unit: string, value: number | undefined) =>
      unit === "h" ? "custom-hours" : base.timeUnit(unit, value) };
    const options = { locale, realizationMode: "normalized" as const, i18n: { course } };
    const quantities = [
      { duration: 2, durationUnit: FhirPeriodUnit.Hour },
      { boundsDuration: { value: 2, code: "h", unit: "h", system: "http://unitsofmeasure.org" } },
      { boundsRange: {
        low: { value: 1, code: "min", unit: "min", system: "http://unitsofmeasure.org" },
        high: { value: 2, code: "h", unit: "h", system: "http://unitsofmeasure.org" }
      } }
    ];
    for (const repeat of quantities) {
      const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], timing: { repeat } };
      const saved = JSON.stringify(row);
      expect(formatSig(row, "long", options)).toContain("2 custom-hours");
      expect(formatSig(row, "short", options)).not.toContain("custom-hours");
      expect(JSON.stringify(row)).toBe(saved);
    }
  });
});


describe("round45 authored directions with independent administration caps", () => {
  it.each(["en", "th"])("retains the only directions beside the live cap in %s", locale => {
    const directions = "Swallow 1 tablet whole every morning";
    for (const cap of [2, 3]) {
      const raw: FhirR6DosageInstruction = { step: [{ component: [{
        text: directions, safety: { doseLimit: [{
          scope: "administration", valueQuantity: { value: cap, unit: "tab" }
        }] }
      }] }] };
      const before = JSON.stringify(raw), rows = toFhirR5Dosages(raw);
      const rowsBefore = JSON.stringify(rows), persisted = JSON.parse(rowsBefore);
      for (const input of [raw, rows, toDosageDetails(persisted)]) {
        for (const realizationMode of [undefined, "normalized", "roundtrip"] as const) {
          const text = formatSig(input, "long", { locale, realizationMode });
          expect(text).toContain(directions);
          expect(text).toContain("max per administration: " + cap + " tab");
        }
      }
      expect(JSON.stringify(raw)).toBe(before);
      expect(JSON.stringify(rows)).toBe(rowsBefore);
      expect(JSON.stringify(persisted)).toBe(rowsBefore);
      const current = JSON.parse(before) as FhirR6DosageInstruction;
      current.step![0].component[0].doseAndRate = [{ doseQuantity: { value: 2, unit: "tab" } }];
      const text = formatSig(current, "long", { locale, realizationMode: "normalized" });
      expect(text).toMatch(locale === "en"
        ? /(?:^|\s)2 tablets(?:\s|[.;,]|$)/u
        : /(?:^|\s)2 เม็ด(?:\s|[.;,]|$)/u);
      expect(text).not.toContain(directions);
    }
  });
});

describe("round47 public preview timing and resolver ownership", () => {
  it.each([false, true])("keeps a range-start heading open only for a final stage (%s)", final => {
    const range = {
      low: { value: 1, unit: "d", code: "d", system: "http://unitsofmeasure.org", id: "low" },
      high: { value: 1, unit: "d", code: "d", system: "http://unitsofmeasure.org", id: "high" }
    };
    const contextCode = { coding: [{
      system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start"
    }] };
    const start = { contextCode, offsetRange: range };
    const component = (value: number): FhirR6Dosage => ({
      doseAndRate: [{ doseQuantity: { value, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] } }
    });
    const raw: FhirR6DosageInstruction = { step: [
      { start, component: [component(2)] },
      ...(final ? [] : [{ start: { contextCode, offsetDuration: {
        value: 7, unit: "d", code: "d", system: "http://unitsofmeasure.org"
      } }, component: [component(1)] }])
    ] };
    const rows = toFhirR5Dosages(raw), cold = JSON.parse(JSON.stringify(rows));
    const english = final
      ? "From 1 day – 1 day after treatment start onward: Use 2 tablets once daily at 8:00 am."
      : "1 day – 1 day after treatment start: Use 2 tablets once daily at 8:00 am. "
        + "From 7 days after treatment start onward: Use 1 tablet once daily at 8:00 am.";
    const thai = final
      ? "ตั้งแต่1 วัน – 1 วันหลังเริ่มการรักษาเป็นต้นไป: ใช้ครั้งละ 2 เม็ด วันละครั้ง เวลา 08:00."
      : "1 วัน – 1 วันหลังเริ่มการรักษา: ใช้ครั้งละ 2 เม็ด วันละครั้ง เวลา 08:00. "
        + "ตั้งแต่7 วันหลังเริ่มการรักษาเป็นต้นไป: ใช้ครั้งละ 1 เม็ด วันละครั้ง เวลา 08:00.";
    for (const input of [raw, rows, cold]) {
      const before = JSON.stringify(input);
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toBe(english);
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" })).toBe(thai);
      expect(toDosageDetails(toFhirR5Dosages(input)).step[0].start).toEqual(start);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it("snapshots own class resolver methods separately for explicit and yearless dates", () => {
    class Calendar implements MedicationDateResolver {
      id = "round47-own-calendar-a";
      offset = 1000;
      resolveYear: MedicationDateResolver["resolveYear"];
      calendarYearFromIsoYear: NonNullable<MedicationDateResolver["calendarYearFromIsoYear"]>;
      constructor() {
        this.resolveYear = function (this: Calendar, year: number, digits: number) {
          return digits === 4 && year >= 3000
            ? { isoYear: year - this.offset, calendarYear: year, inferredYear: false }
            : undefined;
        };
        this.calendarYearFromIsoYear = function (this: Calendar, year: number) {
          return year + this.offset;
        };
      }
    }
    const resolver = new Calendar();
    registerMedicationDateResolver(resolver);
    resolver.id = "round47-own-calendar-b";
    resolver.offset = 1001;
    registerMedicationDateResolver(resolver);
    for (const [calendar, explicitDate, inferredYear] of [
      ["round47-own-calendar-a", "2026-09-28", 3026],
      ["round47-own-calendar-b", "2025-09-28", 3027]
    ] as const) {
      for (const source of ["28/9/3026", "28/9"]) {
        const parsed = parseSig("Take 1 tablet on " + source, {
          datePolicy: { calendars: [calendar], referenceDate: "2026-09-01" }
        });
        expect(parsed.fhirNext.step[0].component[0].timing?.event)
          .toEqual([source === "28/9/3026" ? explicitDate : "2026-09-28"]);
        expect(parsed.meta.canonical.clauses[0].schedule?.calendarEvents?.[0]).toMatchObject({
          calendar, calendarYear: source === "28/9/3026" ? 3026 : inferredYear
        });
      }
    }
  });

  it.each([
    { name: "code-only", period: undefined, short: "1 tab QAM" },
    { name: "daily", period: 1, short: "1 tab QAM MORN" },
    { name: "every two days", period: 2, short: "1 tab Q2D MORN" }
  ])("renders the live $name morning cadence without changing the source code", ({ period, short }) => {
    const timing: FhirDosage["timing"] = {
      code: { text: "QAM" },
      ...(period === undefined ? {} : { repeat: {
        frequency: 1, period, periodUnit: FhirPeriodUnit.Day, when: [EventTiming.Morning]
      } })
    };
    const raw: FhirDosage[] = [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], timing }];
    const r6 = toDosageDetails(raw), cold = JSON.parse(JSON.stringify(toFhirR5Dosages(r6)));
    for (const input of [raw, r6, cold]) {
      const before = JSON.stringify(input);
      expect(formatSig(input, "short", { locale: "en" })).toBe(short);
      expect(toFhirR5Dosages(input)[0].timing).toEqual(timing);
      expect(toDosageDetails(toFhirR5Dosages(input)).step[0].component[0].timing).toEqual(timing);
      expect(JSON.stringify(input)).toBe(before);
    }
  });
});


describe("round48 saved sequence and locale ownership", () => {
  it.each([false, true])("keeps count-ended sequencing beside a ranged end (explicit start %s)", explicit => {
    const contextCode = { coding: [{
      system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start"
    }] };
    const range = {
      low: { value: 7, unit: "d", code: "d", system: "http://unitsofmeasure.org", id: "low" },
      high: { value: 7, unit: "d", code: "d", system: "http://unitsofmeasure.org", id: "high" }
    };
    const component = (value: number, count?: number): FhirR6Dosage => ({
      doseAndRate: [{ doseQuantity: { value, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["08:00:00"], ...(count ? { count } : {}) } }
    });
    const raw: FhirR6DosageInstruction = { step: [
      { component: [component(1, 2)] },
      { ...(explicit ? { start: { contextCode, offsetDuration: {
        value: 2, unit: "d", code: "d", system: "http://unitsofmeasure.org"
      } } } : {}), end: { contextCode, offsetRange: range }, component: [component(2)] }
    ] };
    const rows = toFhirR5Dosages(raw);
    for (const input of [raw, rows, JSON.parse(JSON.stringify(rows))]) {
      const before = JSON.stringify(input);
      for (const locale of ["en", "th"]) for (const style of ["long", "short"] as const) {
        const words = locale === "en" ? ENGLISH_COURSE : THAI_COURSE;
        const text = formatSig(input, style, { locale, realizationMode: "normalized" });
        expect(text.includes(words.afterPreviousPhase + "; ")).toBe(!explicit);
        expect(text).toContain(locale === "en" ? "7 days – 7 days" : "7 วัน – 7 วัน");
        if (explicit) expect(text).toContain(locale === "en" ? "From 2 days" : "ตั้งแต่2 วัน");
      }
      expect(toDosageDetails(toFhirR5Dosages(input)).step[1].end?.offsetRange).toEqual(range);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["en", "th"])("uses the inherited %s course facet for maximum-only periods", locale => {
    const base = locale === "en" ? ENGLISH_COURSE : THAI_COURSE;
    const course = { ...base, timeUnit: (unit: string, value: number | undefined) =>
      unit === "d" ? "custom-days" : base.timeUnit(unit, value) };
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { periodMax: 2, periodUnit: FhirPeriodUnit.Day } } };
    const saved = JSON.stringify(row);
    for (const style of ["long", "short"] as const) {
      const options = { locale: "round48-" + locale, realizationMode: "normalized" as const,
        i18n: { inherit: locale, course } };
      expect(formatSig(row, style, options))
        .toContain(locale === "en" ? "every up to 2 custom-days" : "ทุกไม่เกิน 2 custom-days");
      expect(formatSig(row, style, { locale, realizationMode: "normalized" }))
        .toContain(locale === "en" ? "every up to 2 days" : "ทุกไม่เกิน 2 วัน");
    }
    expect(JSON.stringify(row)).toBe(saved);
  });

  it("snapshots constructor-owned locale callbacks when a provider is registered again", () => {
    class Detector implements MedicationLocaleDetector {
      locale = "round48owna";
      marker = "__round48_locale_a__";
      priority = 902;
      test: MedicationLocaleDetector["test"];
      constructor() { this.test = function (this: Detector, text: string) { return text === this.marker; }; }
    }
    const detector = new Detector();
    registerMedicationLocaleDetector(detector);
    detector.locale = "round48ownb";
    detector.marker = "__round48_locale_b__";
    registerMedicationLocaleDetector(detector);
    expect(inferMedicationLocale("__round48_locale_a__")).toBe("round48owna");
    expect(inferMedicationLocale("__round48_locale_b__")).toBe("round48ownb");
    expect(inferMedicationLocale("ordinary English")).toBe("en");
  });
});
