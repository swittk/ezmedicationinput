import { describe, expect, it } from "vitest";
import { nextDueDoses, calculateTotalUnits } from "../src/index";
import { EventTiming, FhirDosage, NextDueDoseOptions, FhirPeriodUnit, FhirDayOfWeek } from "../src/types";

const EVENT_CLOCK = {
  [EventTiming.Morning]: "08:00",
  [EventTiming.Noon]: "12:00",
  [EventTiming.Afternoon]: "15:00",
  [EventTiming.Evening]: "18:00",
  [EventTiming.Night]: "22:00",
  [EventTiming["Before Sleep"]]: "22:00",
  [EventTiming.Breakfast]: "08:00",
  [EventTiming.Lunch]: "12:30",
  [EventTiming.Dinner]: "18:30"
};

const MEAL_OFFSETS = {
  [EventTiming["Before Meal"]]: -30,
  [EventTiming["After Meal"]]: 30,
  [EventTiming["After Breakfast"]]: 30,
  [EventTiming["After Lunch"]]: 30,
  [EventTiming["After Dinner"]]: 30
};

const BASE_OPTIONS = {
  timeZone: "UTC",
  eventClock: EVENT_CLOCK,
  mealOffsets: MEAL_OFFSETS
} as const satisfies Pick<NextDueDoseOptions, "timeZone" | "eventClock" | "mealOffsets">;

describe("nextDueDoses", () => {
  it("anchors to explicit meal timings", () => {
    const dosage: FhirDosage = {
      timing: {
        repeat: {
          when: [
            EventTiming["After Breakfast"],
            EventTiming["After Lunch"],
            EventTiming["After Dinner"],
            EventTiming["Before Sleep"]
          ]
        }
      }
    };

    const results = nextDueDoses(dosage, {
      ...BASE_OPTIONS,
      orderedAt: "2024-01-01T09:00:00Z",
      from: "2024-01-01T10:00:00Z",
      limit: 4
    });

    expect(results).toEqual([
      "2024-01-01T13:00:00+00:00",
      "2024-01-01T19:00:00+00:00",
      "2024-01-01T22:00:00+00:00",
      "2024-01-02T08:30:00+00:00"
    ]);
  });

  it("handles q6h interval stepping", () => {
    const dosage: FhirDosage = {
      timing: {
        repeat: {
          period: 6,
          periodUnit: FhirPeriodUnit.Hour
        }
      }
    };

    const results = nextDueDoses(dosage, {
      ...BASE_OPTIONS,
      orderedAt: "2024-01-01T09:05:00Z",
      from: "2024-01-01T10:00:00Z",
      limit: 4
    });

    expect(results).toEqual([
      "2024-01-01T15:05:00+00:00",
      "2024-01-01T21:05:00+00:00",
      "2024-01-02T03:05:00+00:00",
      "2024-01-02T09:05:00+00:00"
    ]);
  });

  it("stops generating interval doses once the count limit is met", () => {
    const dosage: FhirDosage = {
      timing: {
        repeat: {
          period: 1,
          periodUnit: FhirPeriodUnit.Hour,
          count: 3
        }
      }
    };

    const results = nextDueDoses(dosage, {
      ...BASE_OPTIONS,
      orderedAt: "2024-01-01T09:00:00Z",
      from: "2024-01-01T09:00:00Z",
      limit: 10
    });

    expect(results).toEqual([
      "2024-01-01T09:00:00+00:00",
      "2024-01-01T10:00:00+00:00",
      "2024-01-01T11:00:00+00:00"
    ]);
  });

  it("respects doses consumed before the evaluation window when priorCount is provided", () => {
    const dosage: FhirDosage = {
      timing: {
        repeat: {
          period: 1,
          periodUnit: FhirPeriodUnit.Day,
          count: 5
        }
      }
    };

    const results = nextDueDoses(dosage, {
      ...BASE_OPTIONS,
      orderedAt: "2024-01-01T09:00:00Z",
      from: "2024-01-04T09:00:00Z",
      priorCount: 3,
      limit: 5
    });

    expect(results).toEqual([
      "2024-01-04T09:00:00+00:00",
      "2024-01-05T09:00:00+00:00"
    ]);
  });

  it("respects doses consumed before the evaluation window when priorCount is not provided", () => {
    const dosage: FhirDosage = {
      timing: {
        repeat: {
          count: 8,
          timeOfDay: ['08:00', '16:00']
        },
      }
    };

    const results = nextDueDoses(dosage, {
      ...BASE_OPTIONS,
      orderedAt: "2024-01-01T00:00:00Z",
      from: "2024-01-03T12:00:00Z",
      limit: 5
    });

    expect(results).toEqual([
      "2024-01-03T16:00:00+00:00",
      "2024-01-04T08:00:00+00:00",
      "2024-01-04T16:00:00+00:00",
    ]);
  });

  it("respects doses entirely consumed before the evaluation window when priorCount is not provided", () => {
    const dosage: FhirDosage = {
      timing: {
        repeat: {
          count: 8,
          timeOfDay: ['08:00', '16:00']
        },
      }
    };

    const results = nextDueDoses(dosage, {
      ...BASE_OPTIONS,
      orderedAt: "2024-01-01T00:00:00Z",
      from: "2024-01-05T12:00:00Z",
      limit: 5
    });

    expect(results).toEqual([]);
  });

  it("uses frequency defaults when no timing anchors exist", () => {
    const dosage: FhirDosage = {
      timing: {
        code: { coding: [{ code: "BID" }] },
        repeat: {
          frequency: 2,
          period: 1,
          periodUnit: FhirPeriodUnit.Day,
          dayOfWeek: [FhirDayOfWeek.Monday, FhirDayOfWeek.Tuesday]
        }
      }
    };

    const results = nextDueDoses(dosage, {
      ...BASE_OPTIONS,
      orderedAt: "2024-01-01T00:00:00Z",
      from: "2024-01-01T05:00:00Z",
      limit: 4
    });

    expect(results).toEqual([
      "2024-01-01T08:00:00+00:00",
      "2024-01-01T20:00:00+00:00",
      "2024-01-02T08:00:00+00:00",
      "2024-01-02T20:00:00+00:00"
    ]);
  });

  it("expands generic AC tokens using meal offsets", () => {
    const dosage: FhirDosage = {
      timing: {
        repeat: {
          when: [EventTiming["Before Meal"]]
        }
      }
    };

    const results = nextDueDoses(dosage, {
      ...BASE_OPTIONS,
      orderedAt: "2024-01-01T07:00:00Z",
      from: "2024-01-01T07:15:00Z",
      limit: 3
    });

    expect(results).toEqual([
      "2024-01-01T07:30:00+00:00",
      "2024-01-01T12:00:00+00:00",
      "2024-01-01T18:00:00+00:00"
    ]);
  });

  it("respects count limits for anchored event timings", () => {
    const dosage: FhirDosage = {
      timing: {
        repeat: {
          when: [EventTiming.Breakfast, EventTiming.Dinner],
          count: 2
        }
      }
    };

    const results = nextDueDoses(dosage, {
      ...BASE_OPTIONS,
      orderedAt: "2024-01-01T06:00:00Z",
      from: "2024-01-01T07:00:00Z",
      limit: 5
    });

    expect(results).toEqual([
      "2024-01-01T08:00:00+00:00",
      "2024-01-01T18:30:00+00:00"
    ]);
  });

  it("respects weekly intervals and day filters", () => {
    const dosage: FhirDosage = {
      timing: {
        repeat: {
          period: 1,
          periodUnit: FhirPeriodUnit.Week,
          dayOfWeek: [FhirDayOfWeek.Monday]
        }
      }
    };

    const results = nextDueDoses(dosage, {
      ...BASE_OPTIONS,
      orderedAt: "2024-01-01T09:00:00Z",
      from: "2024-01-03T00:00:00Z",
      limit: 3
    });

    expect(results).toEqual([
      "2024-01-08T09:00:00+00:00",
      "2024-01-15T09:00:00+00:00",
      "2024-01-22T09:00:00+00:00"
    ]);
  });

  it("emits immediate doses when IMD is present", () => {
    const dosage: FhirDosage = {
      timing: {
        repeat: {
          when: [EventTiming.Immediate]
        }
      }
    };

    const results = nextDueDoses(dosage, {
      ...BASE_OPTIONS,
      orderedAt: "2024-01-01T11:00:00Z",
      from: "2024-01-01T09:00:00Z"
    });

    expect(results).toEqual(["2024-01-01T11:00:00+00:00"]);
  });

  it("uses from as the baseline when orderedAt is omitted", () => {
    const dosage: FhirDosage = {
      timing: {
        repeat: {
          period: 8,
          periodUnit: FhirPeriodUnit.Hour
        }
      }
    };

    const results = nextDueDoses(dosage, {
      ...BASE_OPTIONS,
      from: "2024-01-01T00:00:00Z",
      limit: 3
    });

    expect(results).toEqual([
      "2024-01-01T00:00:00+00:00",
      "2024-01-01T08:00:00+00:00",
      "2024-01-01T16:00:00+00:00"
    ]);
  });
});

describe("calculateTotalUnits", () => {
  const dosageBID: FhirDosage = {
    doseAndRate: [{ doseQuantity: { value: 1, unit: "g" } }],
    timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day } }
  };

  it("calculates total for cream (weight/weight)", () => {
    const res = calculateTotalUnits({
      dosage: dosageBID,
      from: "2024-01-01T08:00:00Z",
      durationValue: 7,
      durationUnit: FhirPeriodUnit.Day,
      timeZone: "UTC",
      context: {
        dosageForm: "cream",
        strength: "1%",
        containerValue: 30,
        containerUnit: "g"
      }
    });
    expect(res.totalUnits).toBe(14);
    expect(res.totalContainers).toBe(1);
  });

  it("calculates total for solution (weight/volume bridge)", () => {
    const dosage: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 500, unit: "mg" } }],
      timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day } }
    };
    const res = calculateTotalUnits({
      dosage,
      from: "2024-01-01T08:00:00Z",
      durationValue: 10,
      durationUnit: FhirPeriodUnit.Day,
      timeZone: "UTC",
      context: {
        dosageForm: "oral solution",
        strength: "2%",
        containerValue: 100,
        containerUnit: "mL"
      }
    });
    expect(res.totalUnits).toBe(10000);
    expect(res.totalContainers).toBe(5);
  });

  it("handles composite strengths in context", () => {
    const dosage: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 480, unit: "mg" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } }
    };
    const res = calculateTotalUnits({
      dosage,
      from: "2024-01-01T08:00:00Z",
      durationValue: 1,
      durationUnit: FhirPeriodUnit.Day,
      timeZone: "UTC",
      context: {
        strength: "400 mg/5mL + 80 mg/5mL",
        containerValue: 100,
        containerUnit: "mL"
      }
    });
    expect(res.totalUnits).toBe(480);
    expect(res.totalContainers).toBe(1);
  });

  it("handles complex interval stepping (q3d) for 10 days", () => {
    // Doses at: d0, d3, d6, d9 -> 4 doses total
    const dosage: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { period: 3, periodUnit: FhirPeriodUnit.Day } }
    };
    const res = calculateTotalUnits({
      dosage,
      from: "2024-01-01T08:00:00Z",
      durationValue: 10,
      durationUnit: FhirPeriodUnit.Day,
      timeZone: "UTC"
    });
    expect(res.totalUnits).toBe(4);
  });

  it("handles complex weekly schedules with dayOfWeek", () => {
    // Mon, Wed, Fri for 2 weeks = 6 doses
    const dosage: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: {
        repeat: {
          period: 1,
          periodUnit: FhirPeriodUnit.Week,
          dayOfWeek: [FhirDayOfWeek.Monday, FhirDayOfWeek.Wednesday, FhirDayOfWeek.Friday]
        }
      }
    };
    const res = calculateTotalUnits({
      dosage,
      from: "2024-01-01T08:00:00Z", // Monday
      durationValue: 2,
      durationUnit: FhirPeriodUnit.Week,
      timeZone: "UTC"
    });
    expect(res.totalUnits).toBe(6);
  });

  it("handles anchored event timings (Breakfast + Dinner) for 5 days", () => {
    // 2 doses/day * 5 days = 10 doses
    const dosage: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { when: [EventTiming.Breakfast, EventTiming.Dinner] } }
    };
    const res = calculateTotalUnits({
      dosage,
      from: "2024-01-01T00:00:00Z",
      durationValue: 5,
      durationUnit: FhirPeriodUnit.Day,
      timeZone: "UTC",
      eventClock: EVENT_CLOCK
    });
    expect(res.totalUnits).toBe(10);
  });

  it("handles PRN (asNeededBoolean)", () => {
    const dosage: FhirDosage = {
      asNeededBoolean: true,
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 4, periodUnit: FhirPeriodUnit.Hour } }
    };
    const res = calculateTotalUnits({
      dosage,
      from: "2024-01-01T00:00:00Z",
      durationValue: 1,
      durationUnit: FhirPeriodUnit.Day,
      timeZone: "UTC"
    });
    expect(res.totalUnits).toBe(6); // 24/4 = 6 doses
  });

  it("handles very complex percentage strength with different units", () => {
    // 500mg/dL = 5mg/mL
    // 5mg/mL + 5mg/mL = 10mg/mL
    // Dose 20mg BID for 5 days = 200mg total.
    // 200mg @ 10mg/mL = 20mL.
    // Container 15mL -> 2 containers.
    const dosage: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 20, unit: "mg" } }],
      timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day } }
    };
    const res = calculateTotalUnits({
      dosage,
      from: "2024-01-01T08:00:00Z",
      durationValue: 5,
      durationUnit: FhirPeriodUnit.Day,
      timeZone: "UTC",
      context: {
        strength: "500 mg/dL + 5 mg/mL",
        containerValue: 15,
        containerUnit: "mL"
      }
    });
    expect(res.totalUnits).toBe(200);
    expect(res.totalContainers).toBe(2);
  });
});
