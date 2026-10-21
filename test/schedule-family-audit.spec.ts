import { describe, expect, it } from "vitest";
import { calculateTotalUnits, nextDueDoses } from "../src";
import type { FhirDosage, FhirPeriodUnit } from "../src";

const start = "2024-01-01T00:00:00Z";
const due = {
  from: start,
  orderedAt: start,
  timeZone: "UTC",
  limit: 10
} as const;
const supply = {
  from: start,
  orderedAt: start,
  timeZone: "UTC",
  durationValue: 2,
  durationUnit: "d" as FhirPeriodUnit
} as const;

function dailyDose(overrides: Partial<FhirDosage> = {}): FhirDosage {
  return {
    doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
    timing: { repeat: { frequency: 1, period: 1, periodUnit: "d" } },
    ...overrides
  };
}

describe("schedule/supply audit regressions", () => {
  it("enforces administration and period maxima against the aggregate bilateral dose", () => {
    const bilateral = dailyDose({
      site: { text: "both eyes" },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }],
      timing: { repeat: { frequency: 2, period: 1, periodUnit: "d" } }
    });
    expect(() => nextDueDoses({
      ...bilateral,
      maxDosePerAdministration: { value: 1, unit: "drop" }
    }, due)).toThrow(/per-administration maximum/);
    expect(() => calculateTotalUnits({
      ...supply,
      dosage: { ...bilateral, maxDosePerAdministration: { value: 1, unit: "drop" } }
    })).toThrow(/maximum/);

    const periodCapped = {
      ...bilateral,
      maxDosePerPeriod: [{
        numerator: { value: 2, unit: "drop" },
        denominator: { value: 1, unit: "d", code: "d" }
      }]
    };
    expect(nextDueDoses(periodCapped, { ...due, limit: 2 })).toHaveLength(2);
    expect(calculateTotalUnits({ ...supply, dosage: periodCapped }).totalUnits).toBe(4);
  });

  it("does not fabricate prior PRN administrations and honors explicit priorCount", () => {
    const prn = dailyDose({
      asNeeded: true,
      timing: { repeat: { count: 3, frequency: 1, period: 1, periodUnit: "d" } }
    });
    const later = { ...due, from: "2024-01-05T00:00:00Z", limit: 5 };
    expect(() => nextDueDoses(prn, later)).toThrow(/priorCount or priorDoseTimes/);
    expect(nextDueDoses(prn, { ...later, priorCount: 0 })).toHaveLength(3);
    expect(nextDueDoses(prn, { ...later, priorCount: 2 })).toHaveLength(1);
    expect(nextDueDoses(prn, {
      ...later,
      priorDoseTimes: ["2024-01-02T09:00:00Z", "2024-01-03T09:00:00Z"]
    })).toHaveLength(1);
    const laterSupply = {
      ...supply,
      from: later.from,
      durationValue: 10,
      dosage: prn
    };
    expect(calculateTotalUnits(laterSupply).totalUnits).toBe(3);
    expect(calculateTotalUnits({ ...laterSupply, priorCount: 2 }).totalUnits).toBe(1);
  });

  it("uses the upper frequency bound only for explicitly labelled maximum supply", () => {
    const ranged = dailyDose({
      timing: {
        code: { coding: [{ code: "QD" }] },
        repeat: { frequency: 1, frequencyMax: 2, period: 1, periodUnit: "d" }
      }
    });
    expect(() => nextDueDoses(ranged, due)).toThrow(/frequency range/);
    expect(calculateTotalUnits({ ...supply, dosage: ranged })).toMatchObject({
      totalUnits: 4,
      unit: "tab",
      quantityKind: "maximum",
      explanation: expect.stringMatching(/upper bound.*frequency range/i)
    });
  });

  it("rejects an unanchored twice-weekly frequency instead of scheduling weekly", () => {
    const ambiguous = dailyDose({
      timing: { repeat: { frequency: 2, period: 1, periodUnit: "wk" } }
    });
    expect(() => nextDueDoses(ambiguous, due)).toThrow(/non-daily period/);
    expect(() => calculateTotalUnits({ ...supply, dosage: ambiguous }))
      .toThrow(/non-daily period/);
  });

  it("rejects non-degenerate duration ranges but compares each endpoint in its own unit", () => {
    const ambiguous = dailyDose({
      timing: { repeat: {
        frequency: 1, period: 1, periodUnit: "d",
        boundsRange: {
          low: { value: 7, unit: "d" },
          high: { value: 2, unit: "wk" }
        }
      } }
    });
    expect(() => nextDueDoses(ambiguous, due)).toThrow(/not an exact course duration/);
    expect(() => nextDueDoses([
      { ...ambiguous, sequence: 1 },
      { ...dailyDose(), sequence: 2 }
    ], due)).toThrow(/not an exact course duration/);
    expect(() => calculateTotalUnits({ ...supply, dosage: ambiguous, durationValue: 30 }))
      .toThrow(/not an exact course duration/);

    const equivalent = dailyDose({
      timing: { repeat: {
        frequency: 1, period: 1, periodUnit: "d",
        boundsRange: {
          low: { value: 7, unit: "d" },
          high: { value: 1, unit: "wk" }
        }
      } }
    });
    expect(nextDueDoses(equivalent, { ...due, limit: 20 })).toHaveLength(7);
  });

  it("rejects invalid boundsPeriod dates consistently for a dosage and an array", () => {
    const invalid = dailyDose({
      timing: { repeat: {
        frequency: 1, period: 1, periodUnit: "d",
        boundsPeriod: { end: "not-a-date" }
      } }
    });
    expect(() => nextDueDoses(invalid, due)).toThrow(/boundsPeriod\.end is invalid/);
    expect(() => nextDueDoses([invalid], due)).toThrow(/boundsPeriod\.end is invalid/);
  });

  it("uses durationMax for maximum infusion supply", () => {
    const infusion: FhirDosage = {
      doseAndRate: [{ rateQuantity: { value: 2, unit: "mL/h" } }],
      timing: { repeat: {
        count: 1,
        duration: 1,
        durationMax: 3,
        durationUnit: "h"
      } }
    };
    expect(calculateTotalUnits({ ...supply, dosage: infusion })).toMatchObject({
      totalUnits: 6,
      unit: "mL",
      quantityKind: "maximum",
      explanation: expect.stringMatching(/infusion-duration range/i)
    });
  });

  it("keeps scanning for sparse quarterly clock schedules", () => {
    const quarterly = dailyDose({
      timing: { repeat: {
        period: 3,
        periodUnit: "mo",
        timeOfDay: ["09:00"]
      } }
    });
    expect(nextDueDoses(quarterly, {
      ...due,
      from: "2024-01-02T00:00:00Z",
      limit: 2
    })).toEqual([
      "2024-04-01T09:00:00+00:00",
      "2024-07-01T09:00:00+00:00"
    ]);
  });

  it("applies count caps to exact events even when orderedAt is absent", () => {
    const exact = dailyDose({
      timing: {
        event: [
          "2024-01-01T09:00:00Z",
          "2024-01-02T09:00:00Z",
          "2024-01-03T09:00:00Z"
        ],
        repeat: { count: 2 }
      }
    });
    expect(nextDueDoses(exact, {
      from: "2024-01-02T00:00:00Z",
      timeZone: "UTC",
      limit: 10
    })).toEqual(["2024-01-02T09:00:00+00:00"]);
    expect(calculateTotalUnits({
      ...supply,
      dosage: exact,
      orderedAt: undefined,
      from: "2024-01-02T00:00:00Z",
      durationValue: 3
    }).totalUnits).toBe(1);
  });

  it("validates single supply horizons and always returns known unit metadata", () => {
    const dosage = dailyDose();
    expect(() => calculateTotalUnits({
      ...supply,
      dosage,
      durationValue: 0
    })).toThrow(/positive number/);
    expect(() => calculateTotalUnits({
      ...supply,
      dosage,
      durationUnit: "fortnight" as FhirPeriodUnit
    })).toThrow(/supported time unit/);
    expect(calculateTotalUnits({ ...supply, dosage })).toMatchObject({
      totalUnits: 2,
      unit: "tab"
    });
  });
});
