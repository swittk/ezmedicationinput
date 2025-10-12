import { describe, expect, it } from "vitest";
import { nextDueDoses } from "../src/index";
import { EventTiming, FhirDosage, NextDueDoseOptions } from "../src/types";

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
          periodUnit: "h"
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

  it("uses frequency defaults when no timing anchors exist", () => {
    const dosage: FhirDosage = {
      timing: {
        code: { coding: [{ code: "BID" }] },
        repeat: {
          frequency: 2,
          period: 1,
          periodUnit: "d",
          dayOfWeek: ["mon", "tue"]
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

  it("respects weekly intervals and day filters", () => {
    const dosage: FhirDosage = {
      timing: {
        repeat: {
          period: 1,
          periodUnit: "wk",
          dayOfWeek: ["mon"]
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
          periodUnit: "h"
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
