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
import { buildInstructionGraphExtension, MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL } from "../src/instruction-graph-fhir";
import { tokenize } from "../src/parser";
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
