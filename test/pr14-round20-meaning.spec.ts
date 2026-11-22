import { describe, expect, it } from "vitest";
import {
  parseSig, formatSig, formatCanonicalCourse, fromFhir, nextDueDoses, calculateTotalUnits,
  projectCanonicalCourse, toFhirR5Dosages, toDosageDetails, importCanonicalCourse,
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
import { canonicalFromFhir, TIMING_FREQUENCY_MIN_EXTENSION_URL, ADMINISTRATION_OFFSET_EXTENSION_URL, CYCLE_DAY_ELIGIBILITY_EXTENSION_URL } from "../src/fhir";
import { withDosageEditProvenance } from "../src/dosage-course";

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
      for (const input of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
        expect(nextDueDoses(input, { ...query, limit: 3 })).toEqual([
          "2026-11-21T20:00:00+00:00", "2026-11-22T09:00:00+00:00", "2026-11-23T09:00:00+00:00",
        ]);
        expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 3, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(3);
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
    if (kind === "delay") modifier.valueQuantity!.value = 60;
    else modifier.extension![1].valueInteger = 15;
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
    expect(row.modifierExtension![0]).toBe(modifier);
  });
});

it.each(["the next morning and at 09:00", "at 09:00 and the next morning"])(
  "round32 retains explicitly coordinated NEXT and clock events in either order: %s", timing => {
    const parsed = parseSig("Take 1 tablet " + timing);
    expect(parsed.meta.canonical.clauses[0].schedule?.when).toEqual(["MORN"]);
    expect(parsed.meta.canonical.clauses[0].schedule?.timeOfDay).toEqual(["09:00:00"]);
    for (const row of parsed.fhir)
      expect(Boolean(row.timing?.repeat?.when?.length && row.timing.repeat.timeOfDay?.length)).toBe(false);
    for (const input of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext])
      expect(nextDueDoses(input, { orderedAt: "2026-11-21T00:00:00Z", from: "2026-11-21T00:00:00Z",
        timeZone: "UTC", eventClock: { MORN: "08:00" }, limit: 3 })).toEqual([
        "2026-11-22T08:00:00+00:00", "2026-11-22T09:00:00+00:00", "2026-11-23T08:00:00+00:00"
      ]);
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
      expect(parsed.meta.canonical.clauses[0].schedule?.when).toEqual(["MORN"]);
      for (const input of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext])
        expect(nextDueDoses(input, { orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-01T00:00:00Z",
          timeZone: "UTC", eventClock: { MORN: "08:00" }, limit: 3 })).toEqual([
            "2026-12-02T08:00:00+00:00", "2026-12-02T18:00:00+00:00", "2026-12-03T08:00:00+00:00"
          ]);
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
    // Relative morning-end execution is not modeled; the clinician-facing
    // suggestion retains that authored qualifier beside the known cadence.
    for (const text of [parsed.shortText, parsed.longText]) {
      expect(text).toContain(ending);
      expect(text).toMatch(/every 6 hours|Q6H/u);
    }
    for (const input of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext])
      expect(nextDueDoses(input, { orderedAt: "2026-12-01T08:00:00Z", from: "2026-12-01T08:00:00Z",
        timeZone: "UTC", limit: 4 })).toEqual([
          "2026-12-01T08:00:00+00:00", "2026-12-01T14:00:00+00:00",
          "2026-12-01T20:00:00+00:00", "2026-12-02T02:00:00+00:00"
        ]);
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
