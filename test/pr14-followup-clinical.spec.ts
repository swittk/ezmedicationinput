/**
 * November 18 review: preserve clinical meaning through repeated-course
 * chronology and through a clinician's live R5 dose edits.
 * These are independent oracles, not roundtrips of the same broken output.
 */
import { describe, expect, it } from "vitest";
import {
  calculateTotalUnits, formatSig, nextDueDoses, parseSig,
  EMA_QUANTITY_COMPARATOR_EXTENSION_URL, EMA_QUANTITY_OPERATOR_SYSTEM
} from "../src/index";
import { formatCanonicalClause } from "../src/format";
import { resolveSigLocalization } from "../src/i18n";
import { instructionGraphSourceConflictsWithDose } from "../src/instruction-graph";
import { FhirPeriodUnit } from "../src/types";

const from = "2026-01-01T00:00:00Z";
const options = { from, orderedAt: from, timeZone: "UTC" } as const;

describe("repeated-course clinical chronology", () => {
  it("completes an uncapped finite loading stage before an overlapping capped maintenance stage", () => {
    const course = {
      kind: "course" as const,
      cycleInterval: { value: 7, unit: "d" },
      stages: [
        {
          administrations: [{
            kind: "administration" as const,
            amounts: [{ quantity: { value: 2, unit: "tab" } }],
            schedule: { recurrence: {
              count: 1,
              frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
              clocks: ["08:00:00"]
            } }
          }]
        },
        {
          administrations: [{
            kind: "administration" as const,
            amounts: [{ quantity: { value: 1, unit: "tab" } }],
            schedule: { recurrence: {
              frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
              clocks: ["09:00:00"],
              courseLength: { value: 10, unit: "d" },
            } },
            limits: [{scope: "period" as const,
              amount: {value: 2, unit: "tab"}, period: {value: 1, unit: "d"}}],
          }]
        }
      ]
    };
    const due = nextDueDoses(course, { ...options, limit: 20 });
    expect(due.slice(0, 6)).toEqual([
      "2026-01-01T08:00:00+00:00",
      "2026-01-01T09:00:00+00:00",
      "2026-01-02T09:00:00+00:00",
      "2026-01-03T09:00:00+00:00",
      "2026-01-04T09:00:00+00:00",
      "2026-01-05T09:00:00+00:00",
    ]);
    const supply = calculateTotalUnits({
      ...options, dosage: course, durationValue: 5, durationUnit: FhirPeriodUnit.Day
    });
    // A finite 08:00 loading dose completes before the 09:00 maintenance
    // clock ON JANUARY 1. The 5-day window therefore has two loading
    // tablets plus five maintenance tablets (Jan 1 through Jan 5).
    expect(supply.totalUnits).toBe(7);
    // A partially stated cap is preserved for review but cannot impose
    // shared chronological acceptance; the uncapped loading stage must
    // still finish before maintenance starts.
    const incomplete = {
      ...course,
      stages: [
        {
          ...course.stages[0],
          administrations: course.stages[0].administrations.map(a => ({
            ...a,
            limits: [{
              scope: "period" as const,
              amount: { value: 2, unit: "tab" },
              period: { unit: "d" }
            }]
          })),
        },
        course.stages[1],
      ]
    };
    const incompleteDue = nextDueDoses(incomplete, { ...options, limit: 20 });
    expect(incompleteDue.slice(0, 2)).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-01T09:00:00+00:00",
    ]);
    expect(incompleteDue).toContain("2026-01-02T09:00:00+00:00");
  });

  it("counts two genuinely accepted administrations at one time across overlapping daily cycles", () => {
    const course = {
      kind: "course" as const,
      cycleInterval: { value: 1, unit: "d" },
      stages: [{
        administrations: [{
          kind: "administration" as const,
          amounts: [{quantity: {value: 1, unit: "tab"}}],
          schedule: {recurrence: {
            frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
            clocks: ["00:00:00"], courseLength: {value: 2, unit: "d"}
          }},
          limits: [{
            scope: "period" as const,
            amount: {value: 2, unit: "tab"},
            period: {value: 1, unit: "d"}
          }]
        }]
      }]
    };
    const due = nextDueDoses(course, {...options, limit: 5});
    expect(due).toEqual([
      "2026-01-01T00:00:00+00:00",
      "2026-01-02T00:00:00+00:00",
      "2026-01-02T00:00:00+00:00",
      "2026-01-03T00:00:00+00:00",
      "2026-01-03T00:00:00+00:00",
    ]);
    const supply = calculateTotalUnits({
      ...options, dosage: course, durationValue: 3, durationUnit: FhirPeriodUnit.Day,
    });
    expect(supply.totalUnits).toBe(5);
  });
});

describe("R5 source dose identity after live edits", () => {
  it("does not reuse an HPSG dose's source text after an in-place edit of its original parser row", () => {
    const source = "ล้างมือก่อนหยอดตา หยอดตาขวา 1 หยด แล้วหลับตา";
    const row = parseSig(source, { locale: "th" }).items[0].fhir;
    const display = () => formatSig(row, "long", { locale: "th", realizationMode: "roundtrip" });
    expect(display()).toBe(source);
    const dose = row.doseAndRate?.[0]?.doseQuantity;
    expect(dose?.value).toBe(1);
    dose!.value = 2;
    expect(display()).not.toBe(source);
    expect(display()).toMatch(/(?:^|[^\d])(?:2|สอง)\s*หยด/u);
    dose!.value = 1;
    expect(display()).toBe(source);
    const originalUnit = dose!.unit, originalCode = dose!.code;
    dose!.unit = "tab";
    dose!.code = "15054";
    expect(display()).not.toBe(source);
    expect(display()).toContain("เม็ด");
    dose!.unit = originalUnit;
    dose!.code = originalCode;
    expect(display()).toBe(source);
    const originalExtensions = dose!.extension;
    dose!.extension = [{
      url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000055" }
    }];
    expect(display()).not.toBe(source);
    expect(display()).toContain("ประมาณ");
    dose!.extension = originalExtensions;
    expect(display()).toBe(source);
  });

  it("treats a changed defaulted amount as a live dose while keeping the original default source", () => {
    const source = "Mix with water then swallow";
    const parsed = parseSig(source, {
      assumeSingleDiscreteDose: true,
      context: { dosageForm: "tablet" }
    });
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.dose).toMatchObject({value: 1, defaulted: true});
    expect(clause.instructionGraph?.actions.length).toBeGreaterThan(0);
    const original = formatCanonicalClause(
      clause, "long", resolveSigLocalization("en"), {realizationMode: "roundtrip"}
    );
    expect(original).toBe(source);
    const changed = { ...clause, dose: { ...clause.dose!, value: 2 } };
    expect(instructionGraphSourceConflictsWithDose(changed)).toBe(true);
    const text = formatCanonicalClause(
      changed, "long", resolveSigLocalization("en"), {realizationMode: "roundtrip"}
    );
    expect(text).not.toBe(original);
    expect(text).toMatch(/(?:2|two)/iu);
    const changedUnit = { ...clause, dose: { ...clause.dose!, unit: "drop" } };
    expect(instructionGraphSourceConflictsWithDose(changedUnit)).toBe(true);
    const changedUnitText = formatCanonicalClause(
      changedUnit, "long", resolveSigLocalization("en"), { realizationMode: "roundtrip" }
    );
    expect(changedUnitText).not.toBe(source);
    expect(changedUnitText).toMatch(/drop/iu);
  });
});

describe("November 18 overlapping-course maximum supply and rate dose caps", () => {
  const capPeriod = { value: 1, unit: "d" };
  const anchor = "2026-01-01T00:00:00Z";
  const o = { from: anchor, orderedAt: anchor, timeZone: "UTC" };
  const stage = (amounts: Array<{
    quantity?: { value: number; unit: string };
    rate?: { value: number; unit: string };
    rateRatio?: { numerator: { value: number; unit: string }; denominator: { value: number; unit: string } };
  }>, limit: number, maximum?: boolean) => ({
    kind: "course" as const,
    cycleInterval: { value: 1, unit: "d" },
    stages: [{ administrations: [{
      kind: "administration" as const,
      amounts,
      schedule: { recurrence: {
        frequency: 1,
        ...(maximum ? { frequencyMax: 2 } : {}),
        period: 1,
        periodUnit: FhirPeriodUnit.Day,
        clocks: [maximum ? "09:00:00" : "00:00:00"],
        courseLength: { value: 2, unit: "d" },
        ...(amounts[0]?.rate || amounts[0]?.rateRatio
          ? { occurrenceDuration: 1, occurrenceDurationUnit: FhirPeriodUnit.Hour }
          : {}),
      } },
      limits: [{ scope: "period" as const,
        amount: { value: limit, unit: amounts[0]?.quantity?.unit ?? "mL" },
        period: capPeriod
      }]
    }] }]
  });

  it("keeps concrete scheduling at one clock, but computes two-per-cycle maximum supply through shared caps", () => {
    const course = stage([{ quantity: { value: 1, unit: "tab" } }], 4, true);
    expect(nextDueDoses(course, { ...o, limit: 5 })).toEqual([
      "2026-01-01T09:00:00+00:00",
      "2026-01-02T09:00:00+00:00",
      "2026-01-02T09:00:00+00:00",
      "2026-01-03T09:00:00+00:00",
      "2026-01-03T09:00:00+00:00",
    ]);
    const supply = calculateTotalUnits({
      ...o, dosage: course, durationValue: 3, durationUnit: FhirPeriodUnit.Day
    });
    expect(supply).toMatchObject({ totalUnits: 10, unit: "tab", quantityKind: "maximum" });
  });

  it("applies a one-tablet rolling cap to the upper-frequency plan, not just the source clock plan", () => {
    const course = stage([{ quantity: { value: 1, unit: "tab" } }], 1, true);
    // Even two-per-cycle maximum opportunities must respect the one
    // administration/day clinical ceiling across overlapping cycles.
    expect(calculateTotalUnits({
      ...o, dosage: course, durationValue: 3, durationUnit: FhirPeriodUnit.Day
    })).toMatchObject({ totalUnits: 3, unit: "tab", quantityKind: "maximum" });
  });

  it("retains a contradictory 5 mL/day cap without making the 10 mL infusion unschedulable", () => {
    const course = stage([{ rate: { value: 10, unit: "mL/h" } }], 5);
    const scheduled = nextDueDoses(course, { ...o, limit: 4 });
    expect(scheduled).toEqual([
      "2026-01-01T00:00:00+00:00",
      "2026-01-02T00:00:00+00:00",
      "2026-01-02T00:00:00+00:00",
      "2026-01-03T00:00:00+00:00",
    ]);
    const supply = calculateTotalUnits({
      ...o, dosage: course, durationValue: 3, durationUnit: FhirPeriodUnit.Day
    });
    expect(supply).toMatchObject({ totalUnits: 50, unit: "mL", quantityKind: "maximum" });
    expect(supply.explanation).toContain("unevaluable maximum-dose constraint");
    expect(course.stages[0].administrations[0].amounts[0].rate).toEqual({
      value: 10, unit: "mL/h"
    });
  });

  it("evaluates a rate-only maximum-frequency course with the SAME shared volume ceiling", () => {
    const course = stage([{ rate: { value: 10, unit: "mL/h" } }], 10, true);
    const before = structuredClone(course);
    const due = nextDueDoses(course, { ...o, limit: 3 });
    expect(due).toEqual([
      "2026-01-01T09:00:00+00:00",
      "2026-01-02T09:00:00+00:00",
      "2026-01-03T09:00:00+00:00"
    ]);
    expect(calculateTotalUnits({
      ...o, dosage: course, durationValue: 3, durationUnit: FhirPeriodUnit.Day
    })).toMatchObject({ totalUnits: 30, unit: "mL", quantityKind: "maximum" });
    expect(course).toEqual(before);
  });

  it("carries rate-only rolling-cap history across a late supply query", () => {
    const course = stage([{ rate: { value: 10, unit: "mL/h" } }], 10);
    const from = "2026-01-02T12:00:00Z";
    expect(nextDueDoses(course, { ...o, from, limit: 2 })).toEqual([
      "2026-01-03T00:00:00+00:00", "2026-01-04T00:00:00+00:00"
    ]);
    expect(calculateTotalUnits({
      ...o, from, dosage: course, durationValue: 1, durationUnit: FhirPeriodUnit.Day
    }).totalUnits).toBe(10);
  });

  it("retains an incompatible period cap as unevaluated clinical meaning instead of claiming exact supply", () => {
    const course = stage([{ rate: { value: 10, unit: "mL/h" } }], 10);
    const member = course.stages[0].administrations[0];
    member.limits[0].amount.unit = "mg";
    const originalLimit = structuredClone(member.limits);
    const supply = calculateTotalUnits({
      ...o, dosage: course, durationValue: 3, durationUnit: FhirPeriodUnit.Day
    });
    expect(supply.totalUnits).toBe(50);
    expect(supply.unit).toBe("mL");
    expect(supply.quantityKind).toBe("maximum");
    expect(supply.explanation).toContain("unevaluable maximum-dose constraint");
    expect(member.limits).toEqual(originalLimit);
  });

  for (const [name, amounts] of [
    ["rate quantity", [{ rate: { value: 10, unit: "mL/h" } }]],
    ["rate ratio", [{ rateRatio: { numerator: { value: 10, unit: "mL" },
      denominator: { value: 1, unit: "h" } } }]],
  ] as const) {
    it("applies a 10 mL/24h limit to each measured 10 mL infusion from " + name, () => {
      const course = stage([...amounts], 10);
      expect(nextDueDoses(course, { ...o, limit: 4 })).toEqual([
        "2026-01-01T00:00:00+00:00",
        "2026-01-02T00:00:00+00:00",
        "2026-01-03T00:00:00+00:00",
        "2026-01-04T00:00:00+00:00",
      ]);
      expect(calculateTotalUnits({
        ...o, dosage: course, durationValue: 3, durationUnit: FhirPeriodUnit.Day
      })).toMatchObject({ totalUnits: 30, unit: "mL" });
    });
  }
});

describe("November 18 review: dose ranges own upper-bound rolling-cap quantity", () => {
  const options = {
    from: "2026-01-01T00:00:00Z",
    orderedAt: "2026-01-01T00:00:00Z",
    timeZone: "UTC",
  };
  function rangedCourse(maxPerDay: number) {
    return {
      kind: "course" as const,
      cycleInterval: { value: 1, unit: "d" },
      stages: [{
        administrations: [{
          kind: "administration" as const,
          amounts: [{ range: {
            low: { value: 1, unit: "tab" },
            high: { value: 2, unit: "tab" },
          } }],
          schedule: { recurrence: {
            frequency: 1, frequencyMax: 2,
            period: 1, periodUnit: FhirPeriodUnit.Day,
            clocks: ["09:00:00"],
            courseLength: { value: 2, unit: "d" },
          } },
          limits: [{ scope: "period" as const,
            amount: { value: maxPerDay, unit: "tab" },
            period: { value: 1, unit: "d" },
          }],
        }],
      }],
    };
  }

  it("caps the upper-range maximum plan by tablets, not just administrations", () => {
    const course = rangedCourse(4);
    const original = structuredClone(course);
    // Clinical scheduling uses the one authored concrete clock; the
    // two-per-day range belongs to maximum supply estimation only.
    expect(nextDueDoses(course, { ...options, limit: 3 })).toEqual([
      "2026-01-01T09:00:00+00:00",
      "2026-01-02T09:00:00+00:00",
      "2026-01-02T09:00:00+00:00",
    ]);
    // Jan 1 and Jan 2 each allow only TWO 2-tab administrations:
    // maximum quantity = 4 tabs/day x 2 days = 8, never 12.
    expect(calculateTotalUnits({
      ...options, dosage: course, durationValue: 2,
      durationUnit: FhirPeriodUnit.Day,
    })).toMatchObject({
      totalUnits: 8, unit: "tab", quantityKind: "maximum",
    });
    expect(course).toEqual(original);
  });

  it("uses the upper dose of two tablets when one administration exhausts each day's cap", () => {
    const course = rangedCourse(2);
    expect(calculateTotalUnits({
      ...options, dosage: course, durationValue: 2,
      durationUnit: FhirPeriodUnit.Day,
    })).toMatchObject({
      totalUnits: 4, unit: "tab", quantityKind: "maximum",
    });
  });

  it("uses a feasible one-tablet dose when the cap intersects the authored range", () => {
    const course = rangedCourse(1);
    const supply = calculateTotalUnits({
      ...options, dosage: course, durationValue: 2,
      durationUnit: FhirPeriodUnit.Day,
    });
    expect(supply).toMatchObject({ totalUnits: 2, quantityKind: "maximum" });
    expect(supply.explanation).not.toContain("unevaluable maximum-dose constraint");
    expect(course.stages[0].administrations[0].amounts[0].range.high.value).toBe(2);
  });

  it("keeps a cap below the range's lower endpoint recoverable and explicitly unevaluated", () => {
    const course = rangedCourse(0.5);
    const supply = calculateTotalUnits({
      ...options, dosage: course, durationValue: 2,
      durationUnit: FhirPeriodUnit.Day,
    });
    expect(supply).toMatchObject({ totalUnits: 12, unit: "tab", quantityKind: "maximum" });
    expect(supply.explanation).toContain("unevaluable maximum-dose constraint");
    expect(course.stages[0].administrations[0].amounts[0].range.low.value).toBe(1);
  });
});
