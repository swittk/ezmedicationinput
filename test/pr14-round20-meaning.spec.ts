import { describe, expect, it } from "vitest";
import {
  parseSig, formatSig, formatCanonicalCourse, fromFhir,
  FhirPeriodUnit, type FhirDosage, type CanonicalCourse, type CanonicalAdministration,
} from "../src/index";
import { formatCanonicalClause } from "../src/format";
import { resolveSigLocalization } from "../src/i18n";
import { parseClauseState } from "../src/parser";
import { createBoundaryPlan } from "../src/regimen/planner";
import { buildRegimenGraph, scopeSequentialPhaseSemantics } from "../src/regimen/regimen";
import { buildCanonicalParallelRegimen } from "../src/regimen/parallel-course";
import {
  parseInstructionActions, realizeRichPrimaryWithCanonicalDose, instructionGraphSourceConflictsWithDose,
} from "../src/instruction-graph";
import { AdviceArgumentRole } from "../src/types";
import { getQuantityComparator, simpleQuantityForR5 } from "../src/fhir-quantity-operator";

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
    expect(clauses.map(c => c.dose?.value)).toEqual([1, 1, 1, 1]);
    expect(clauses[0].schedule).toMatchObject({ period: 2, periodUnit: "h", duration: 7, durationComparator: "~" });
    expect(clauses[2].schedule).toMatchObject({ frequency: 4, duration: 1, durationUnit: "mo" });
    expect(formatCanonicalClause(clauses[0], "long")).toContain("~7 days");
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
    expect(parsed.meta.canonical.course?.cycleInterval).toMatchObject({ value: 14 });
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
