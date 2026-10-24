import { describe, expect, it } from "vitest";
import { parseClauseSign, parseClauseState } from "../src/parser";
import { projectHpsgSignToState } from "../src/hpsg/projection";
import { canonicalToFhir } from "../src/fhir";
import {
  calculateTotalUnits,
  nextDueDoses,
  parseSig as parsePublicSig,
  toDosageDetails,
  toFhirR5Dosages
} from "../src/index";
import { parseSig } from "./helpers/r5-parser";

describe("HPSG clinical quantity grammar", () => {
  it("lowers resolved quantities directly from typed canonical semantics, without a post-parse clinical resolver", () => {
    const weightRate = canonicalToFhir(parseClauseState("dopamine 5 mcg/kg/min IV").primaryClause);
    expect(weightRate.doseAndRate?.[0].rateQuantity).toMatchObject({
      value: 5, unit: "ug/kg/min", code: "ug/kg/min",
      system: "http://unitsofmeasure.org"
    });
    expect(weightRate.doseAndRate?.[0].doseQuantity).toBeUndefined();

    const fixed = canonicalToFhir(parseClauseState("Infuse 50 ML over 30 minutes IV").primaryClause);
    expect(fixed.doseAndRate?.[0]).toMatchObject({
      doseQuantity: { value: 50, code: "mL" },
      rateRatio: {
        numerator: { value: 50, code: "mL" },
        denominator: { value: 30, code: "min" }
      }
    });
  });

  it("projects dimensional weight-rate evidence into canonical IR", () => {
    const state = parseClauseState("dopamine 5 mcg/kg/min IV");
    expect(state.primaryClause.clinicalQuantity).toEqual({
      representation: "rate-quantity",
      status: "resolved",
      numerator: { value: 5, unit: "ug", dimension: "mass" },
      denominators: [
        { value: 1, unit: "kg", dimension: "patient-mass" },
        { value: 1, unit: "min", dimension: "time" }
      ],
      requiresPatientWeight: true
    });
    expect(state.primaryClause.dose).toBeUndefined();
    expect(state.primaryClause.evidence).toContainEqual(expect.objectContaining({
      rule: "hpsg.lex.clinicalQuantity.weightRate"
    }));
  });

  it("keeps a per-kg dose symbolic until patient weight is supplied", () => {
    const state = parseClauseState("0.5 mg/kg PO BID");
    expect(state.primaryClause.clinicalQuantity).toMatchObject({
      representation: "dose",
      status: "resolved",
      numerator: { value: 0.5, unit: "mg", dimension: "mass" },
      denominators: [{ value: 1, unit: "kg", dimension: "patient-mass" }],
      projectedDose: { value: 0.5, unit: "mg/kg" },
      requiresPatientWeight: true
    });
    expect(state.primaryClause.dose).toEqual({ value: 0.5, unit: "mg/kg" });
    expect(state.primaryClause.schedule).toMatchObject({
      frequency: 2,
      period: 1,
      periodUnit: "d"
    });
  });

  it("derives a per-administration dose and cadence from an explicit divided daily total", () => {
    const state = parseClauseState("10 mg/kg/day divided into 3 doses");
    expect(state.primaryClause.clinicalQuantity).toMatchObject({
      representation: "dose",
      status: "resolved",
      dailyTotal: true,
      dividedDoseCount: 3,
      projectedDose: { value: 10 / 3, unit: "mg/kg" },
      denominators: [
        { unit: "kg", dimension: "patient-mass" },
        { unit: "d", dimension: "time" }
      ]
    });
    expect(state.primaryClause.dose).toEqual({ value: 10 / 3, unit: "mg/kg" });
    expect(state.primaryClause.schedule).toMatchObject({ frequency: 3, period: 1, periodUnit: "d" });
    expect(state.primaryClause.leftovers).toEqual([]);
    expect(state.primaryClause.evidence).toContainEqual(expect.objectContaining({
      rule: "hpsg.lex.clinicalQuantity.divisionCount"
    }));
  });

  it("keeps infusion duration per administration alongside recurring cadence", () => {
    const state = parseClauseState(
      "infuse dopamine at 5 mcg/kg/min IV for 30 minutes every 8 hours"
    );
    expect(state.primaryClause.clinicalQuantity).toMatchObject({
      representation: "rate-quantity",
      status: "resolved",
      administrationDuration: { value: 30, unit: "min" }
    });
    expect(state.primaryClause.schedule).toMatchObject({
      period: 8,
      periodUnit: "h",
      administrationDuration: 30,
      administrationDurationUnit: "min"
    });
    expect(state.primaryClause.schedule?.count).toBeUndefined();
    expect(state.primaryClause.schedule?.duration).toBeUndefined();
  });

  it("projects fixed volume over time as dose plus rate ratio from typed evidence", () => {
    const parsed = parseSig("Infuse 50 ML over 30 minutes IV");
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.clinicalQuantity).toMatchObject({
      representation: "dose-with-rate-ratio",
      numerator: { value: 50, unit: "mL", dimension: "volume" },
      denominators: [{ value: 30, unit: "min", dimension: "time" }],
      administrationDuration: { value: 30, unit: "min" }
    });
    expect(parsed.fhir.doseAndRate?.[0]).toMatchObject({
      doseQuantity: { value: 50, unit: "mL", code: "mL" },
      rateRatio: {
        numerator: { value: 50, unit: "mL", code: "mL" },
        denominator: { value: 30, unit: "min", code: "min" }
      }
    });
  });

  it.each([
    ["over", "an hour"],
    ["for", "an hour"],
    ["over", "one hour"],
    ["for", "1 hour"]
  ])("treats %s %s as a one-hour administration quantity", (lead, duration) => {
    const source = `Infuse 25 mL ${lead} ${duration}`;
    const parsed = parsePublicSig(source);
    const clause = parsed.meta.canonical.clauses[0];
    const dosage = parsed.fhir[0];

    expect(parsed.items).toHaveLength(1);
    expect(clause.clinicalQuantity).toMatchObject({
      representation: "dose-with-rate-ratio",
      status: "resolved",
      numerator: { value: 25, unit: "mL", dimension: "volume" },
      denominators: [{ value: 1, unit: "h", dimension: "time" }],
      administrationDuration: { value: 1, unit: "h" }
    });
    expect(clause.schedule).toMatchObject({
      count: 1,
      administrationDuration: 1,
      administrationDurationUnit: "h"
    });
    expect(clause.schedule?.duration).toBeUndefined();
    expect(dosage.timing?.repeat).toMatchObject({ count: 1, duration: 1, durationUnit: "h" });
    expect(dosage.timing?.repeat?.boundsDuration).toBeUndefined();
    expect(dosage.doseAndRate?.[0]).toMatchObject({
      doseQuantity: { value: 25, code: "mL" },
      rateRatio: {
        numerator: { value: 25, code: "mL" },
        denominator: { value: 1, code: "h" }
      }
    });
    const strictR5 = toFhirR5Dosages(parsed.fhirNext)[0];
    const r6 = parsed.fhirNext.step[0]?.component[0];
    for (const projected of [strictR5, r6]) {
      expect(projected?.timing?.repeat).toMatchObject({ count: 1, duration: 1, durationUnit: "h" });
      expect(projected?.timing?.repeat?.boundsDuration).toBeUndefined();
      expect(projected?.doseAndRate?.[0]?.rateRatio).toMatchObject({
        numerator: { value: 25, code: "mL" },
        denominator: { value: 1, code: "h" }
      });
    }

    const sign = parseClauseSign(source);
    const durationSource = `${lead} ${duration}`;
    expect(sign?.synsem.head.schedule?.sourceRanges).toContainEqual({
      start: source.indexOf(durationSource),
      end: source.indexOf(durationSource) + durationSource.length
    });
  });

  describe("sequential infusion duration semantics", () => {
    it.each([
      "Infuse 50 mL over 30 min, then 25 mL over 60 min",
      "Infuse 50 mL over 30 min, then infuse 25 mL over 60 min"
    ])("keeps each stage as its own fixed-volume infusion: %s", source => {
      const parsed = parsePublicSig(source);
      expect(parsed.items).toHaveLength(2);
      expect(parsed.meta.canonical.clauses).toHaveLength(2);

      const expected = [
        { amount: 50, duration: 30 },
        { amount: 25, duration: 60 }
      ];
      for (let index = 0; index < expected.length; index += 1) {
        const clause = parsed.meta.canonical.clauses[index];
        const dosage = parsed.fhir[index];
        expect(clause.method?.coding?.code).toBe("764794000");
        expect(clause.clinicalQuantity).toMatchObject({
          representation: "dose-with-rate-ratio",
          status: "resolved",
          numerator: { value: expected[index].amount, unit: "mL", dimension: "volume" },
          denominators: [{ value: expected[index].duration, unit: "min", dimension: "time" }],
          administrationDuration: { value: expected[index].duration, unit: "min" }
        });
        expect(clause.schedule).toMatchObject({
          count: 1,
          administrationDuration: expected[index].duration,
          administrationDurationUnit: "min"
        });
        expect(clause.schedule?.duration).toBeUndefined();
        expect(dosage.timing?.repeat).toMatchObject({
          count: 1,
          duration: expected[index].duration,
          durationUnit: "min"
        });
        expect(dosage.timing?.repeat?.boundsDuration).toBeUndefined();
        expect(dosage.doseAndRate?.[0]).toMatchObject({
          doseQuantity: { value: expected[index].amount, code: "mL" },
          rateRatio: {
            numerator: { value: expected[index].amount, code: "mL" },
            denominator: { value: expected[index].duration, code: "min" }
          }
        });
      }
    });

    it("preserves the two rates through strict R5 and R6 round trips", () => {
      const parsed = parsePublicSig("Infuse 50 mL over 30 min, then 25 mL over 60 min");
      const strictR5 = toFhirR5Dosages(parsed.fhirNext);
      const restoredR6 = toDosageDetails(strictR5);

      expect(strictR5.map(dosage => dosage.timing?.repeat)).toMatchObject([
        { count: 1, duration: 30, durationUnit: "min" },
        { count: 1, duration: 60, durationUnit: "min" }
      ]);
      expect(strictR5.map(dosage => dosage.doseAndRate?.[0]?.rateRatio?.denominator)).toMatchObject([
        { value: 30, code: "min" },
        { value: 60, code: "min" }
      ]);
      expect(restoredR6.step.map(step => step.component[0]?.timing?.repeat)).toMatchObject([
        { count: 1, duration: 30, durationUnit: "min" },
        { count: 1, duration: 60, durationUnit: "min" }
      ]);
    });

    it("handles varied volume and elapsed-time units without combining stage rates", () => {
      const parsed = parsePublicSig(
        "Infuse 0.5 L over 2 hours, then 125 mL over 45 minutes"
      );
      expect(parsed.fhir).toHaveLength(2);
      expect(parsed.fhir[0].doseAndRate?.[0]).toMatchObject({
        doseQuantity: { value: 0.5, code: "L" },
        rateRatio: {
          numerator: { value: 0.5, code: "L" },
          denominator: { value: 2, code: "h" }
        }
      });
      expect(parsed.fhir[1].doseAndRate?.[0]).toMatchObject({
        doseQuantity: { value: 125, code: "mL" },
        rateRatio: {
          numerator: { value: 125, code: "mL" },
          denominator: { value: 45, code: "min" }
        }
      });

      const scheduleOptions = {
        from: "2026-10-24T08:00:00+07:00",
        to: "2026-10-25T08:00:00+07:00",
        timeZone: "Asia/Bangkok",
        limit: 3
      };
      expect(nextDueDoses(parsed.fhir[0], scheduleOptions)).toHaveLength(1);
      expect(nextDueDoses(parsed.fhir[1], scheduleOptions)).toHaveLength(1);
      expect(calculateTotalUnits({
        dosage: parsed.fhir[0], from: scheduleOptions.from,
        durationValue: 1, durationUnit: "d", timeZone: scheduleOptions.timeZone
      })).toMatchObject({ totalUnits: 0.5, unit: "L" });
      expect(calculateTotalUnits({
        dosage: parsed.fhir[1], from: scheduleOptions.from,
        durationValue: 1, durationUnit: "d", timeZone: scheduleOptions.timeZone
      })).toMatchObject({ totalUnits: 125, unit: "mL" });
    });

    it("keeps an explicit course duration separate from infusion duration", () => {
      const infusion = parsePublicSig(
        "Infuse 25 mL over 60 min once daily for 3 days"
      );
      const clause = infusion.meta.canonical.clauses[0];
      expect(clause.schedule).toMatchObject({
        frequency: 1,
        period: 1,
        periodUnit: "d",
        administrationDuration: 60,
        administrationDurationUnit: "min",
        duration: 3,
        durationUnit: "d"
      });
      expect(infusion.fhir[0].timing?.repeat).toMatchObject({
        frequency: 1,
        period: 1,
        periodUnit: "d",
        duration: 60,
        durationUnit: "min",
        boundsDuration: { value: 3, code: "d" }
      });
      const strictR5 = toFhirR5Dosages(infusion.fhirNext);
      const restoredR6 = toDosageDetails(strictR5);
      expect(strictR5[0].timing?.repeat).toMatchObject({
        duration: 60,
        durationUnit: "min",
        boundsDuration: { value: 3, code: "d" }
      });
      expect(restoredR6.step[0].component[0]?.timing?.repeat).toMatchObject({
        duration: 60,
        durationUnit: "min",
        boundsDuration: { value: 3, code: "d" }
      });
      for (const representation of [infusion, strictR5, restoredR6]) {
        expect(nextDueDoses(representation, {
          from: "2026-10-24T08:00:00+07:00",
          to: "2026-10-30T08:00:00+07:00",
          timeZone: "Asia/Bangkok",
          limit: 10
        })).toHaveLength(3);
        expect(calculateTotalUnits({
          dosage: representation,
          from: "2026-10-24T08:00:00+07:00",
          durationValue: 5,
          durationUnit: "d",
          timeZone: "Asia/Bangkok"
        })).toMatchObject({ totalUnits: 75, unit: "mL" });
      }

      const oralCourse = parsePublicSig("Take 1 tablet daily for 7 days");
      expect(oralCourse.fhir[0].timing?.repeat).toMatchObject({
        frequency: 1,
        period: 1,
        periodUnit: "d",
        boundsDuration: { value: 7, code: "d" }
      });
      expect(oralCourse.fhir[0].timing?.repeat?.duration).toBeUndefined();
    });

    it("keeps an indefinite administration hour separate from a repeated infusion course", () => {
      const source = "Infuse 25 mL over an hour once daily for 3 days";
      const infusion = parsePublicSig(source);
      const clause = infusion.meta.canonical.clauses[0];

      expect(clause.clinicalQuantity).toMatchObject({
        representation: "dose-with-rate-ratio",
        numerator: { value: 25, unit: "mL", dimension: "volume" },
        denominators: [{ value: 1, unit: "h", dimension: "time" }],
        administrationDuration: { value: 1, unit: "h" }
      });
      expect(clause.schedule).toMatchObject({
        frequency: 1,
        period: 1,
        periodUnit: "d",
        administrationDuration: 1,
        administrationDurationUnit: "h",
        duration: 3,
        durationUnit: "d"
      });
      expect(infusion.fhir[0].timing?.repeat).toMatchObject({
        frequency: 1,
        period: 1,
        periodUnit: "d",
        duration: 1,
        durationUnit: "h",
        boundsDuration: { value: 3, code: "d" }
      });
      expect(infusion.fhir[0].doseAndRate?.[0]?.rateRatio).toMatchObject({
        numerator: { value: 25, code: "mL" },
        denominator: { value: 1, code: "h" }
      });
      const strictR5 = toFhirR5Dosages(infusion.fhirNext)[0];
      const r6 = infusion.fhirNext.step[0]?.component[0];
      for (const projected of [strictR5, r6]) {
        expect(projected?.timing?.repeat).toMatchObject({
          frequency: 1,
          period: 1,
          periodUnit: "d",
          duration: 1,
          durationUnit: "h",
          boundsDuration: { value: 3, code: "d" }
        });
        expect(projected?.doseAndRate?.[0]?.rateRatio?.denominator).toMatchObject({
          value: 1, code: "h"
        });
      }
    });

    it("does not universally reinterpret for-duration as infusion duration", () => {
      const headed = parsePublicSig("Infuse 25 mL for 60 min");
      expect(headed.meta.canonical.clauses[0].clinicalQuantity).toMatchObject({
        representation: "dose-with-rate-ratio",
        administrationDuration: { value: 60, unit: "min" }
      });
      expect(headed.fhir[0].timing?.repeat).toMatchObject({
        count: 1, duration: 60, durationUnit: "min"
      });
      expect(headed.fhir[0].timing?.repeat?.boundsDuration).toBeUndefined();

      const unheaded = parsePublicSig("25 mL for 60 min");
      expect(unheaded.meta.canonical.clauses[0].clinicalQuantity).toBeUndefined();
      expect(unheaded.fhir[0].doseAndRate?.[0]?.rateRatio).toBeUndefined();
      expect(unheaded.fhir[0].timing?.repeat?.duration).toBeUndefined();
      expect(unheaded.fhir[0].timing?.repeat?.boundsDuration).toMatchObject({
        value: 60, code: "min"
      });
    });
  });

  it.each([
    ["Infuse IV at 5 MCG/min for 1 hour", "ug/min"],
    ["Infuse IV at 100 ML/HR for 30 minutes", "mL/h"]
  ])("preserves UCUM case through canonical rate projection: %s", (source, code) => {
    const parsed = parseSig(source);
    expect(parsed.meta.canonical.clauses[0].clinicalQuantity).toMatchObject({
      representation: "rate-quantity",
      status: "resolved"
    });
    expect(parsed.fhir.doseAndRate?.[0]?.rateQuantity).toMatchObject({
      code,
      unit: code,
      system: "http://unitsofmeasure.org"
    });
  });

  it("keeps unsupported weight-rate suffixes visible without erasing the typed quantity", () => {
    for (const source of ["5 mcg/kg/bolus IV"]) {
      const parsed = parseSig(source);
      expect(parsed.meta.canonical.clauses[0].clinicalQuantity).toMatchObject({
        status: "unsupported",
        reviewReason: "unsupported-weight-based-rate",
        requiresPatientWeight: true
      });
      expect(parsed.fhir.text).toBe(source);
    }
  });

  it("represents a supported weekly weight-based rate directly", () => {
    const parsed = parseSig("5 mg/kg/week IV");
    expect(parsed.meta.canonical.clauses[0].clinicalQuantity).toMatchObject({
      status: "resolved", requiresPatientWeight: true
    });
    expect(parsed.fhir.doseAndRate?.[0]?.rateQuantity).toMatchObject({
      value: 5, code: "mg/kg/wk"
    });
  });

  it("parses compact weight units followed by a spaced per-time suffix", () => {
    const infusion = parseSig("dopamine 5 mcg/kg per min IV");
    expect(infusion.meta.canonical.clauses[0].clinicalQuantity).toMatchObject({
      representation: "rate-quantity", status: "resolved", requiresPatientWeight: true
    });
    expect(infusion.fhir.doseAndRate?.[0]?.rateQuantity).toMatchObject({
      value: 5, code: "ug/kg/min"
    });

    const divided = parseSig("5 mg/kg per day divided into 3 doses PO");
    expect(divided.fhir.doseAndRate?.[0]?.doseQuantity?.unit).toBe("mg/kg");
    expect(divided.fhir.doseAndRate?.[0]?.doseQuantity?.value).toBeCloseTo(5 / 3);
    expect(divided.fhir.timing?.repeat).toMatchObject({
      frequency: 3, period: 1, periodUnit: "d"
    });
  });

  it("preserves an undivided daily total as a rate quantity instead of pretending it is a bolus", () => {
    const parsed = parseSig("10 mg/kg/day");
    expect(parsed.meta.canonical.clauses[0].clinicalQuantity).toMatchObject({
      status: "incomplete",
      dailyTotal: true,
      reviewReason: "incomplete-weight-based-dose"
    });
    expect(parsed.fhir.doseAndRate?.[0]?.rateQuantity).toMatchObject({
      value: 10, code: "mg/kg/d"
    });
  });
});


describe("compositional amount, rate, and division ownership", () => {
  it.each([
    "Give 10 mg/kg/day PO divided into 2 doses",
    "Give 10 mg/kg/24h PO divided into 2 doses",
    "Give 10 mg/kg/day divided into two equal doses PO",
    "Give 10 mg/kg/day in two equal doses orally"
  ])("composes division across a route without turning the divisor into a dose: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 5, unit: "mg/kg" });
    expect(parsed.fhir.timing?.repeat).toMatchObject({ frequency: 2, period: 1, periodUnit: "d" });
    expect(parsed.meta.canonical.clauses[0].clinicalQuantity).toMatchObject({
      status: "resolved", dividedDoseCount: 2,
      numerator: { value: 10 }, projectedDose: { value: 5, unit: "mg/kg" }
    });
    expect(parsed.meta.leftoverText).toBeUndefined();
  });

  it.each([
    "Administer 500 mL IV at 50 mL/hr",
    "Infuse 250 mL at 25 mL/hr IV"
  ])("retains the independently stated amount and rate: %s", source => {
    const parsed = parseSig(source);
    const expectedAmount = source.includes("500") ? 500 : 250;
    const expectedRate = expectedAmount / 10;
    expect(parsed.items).toHaveLength(1);
    expect(parsed.fhir.doseAndRate?.[0]).toMatchObject({
      doseQuantity: { value: expectedAmount, unit: "mL" },
      rateQuantity: { value: expectedRate, code: "mL/h" }
    });
    expect(parsed.meta.canonical.clauses[0].clinicalQuantity).toMatchObject({
      representation: "rate-quantity", status: "resolved",
      projectedDose: { value: expectedAmount, unit: "mL" }
    });
  });
});


it("represents the original compact 24-hour weight-total case without inventing an absolute dose", () => {
  const source = "5 mcg/kg/24h IV";
  const parsed = parseSig(source);
  expect(parsed.fhir.text).toBe(source);
  expect(parsed.fhir.route?.text).toBe("intravenous");
  expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toBeUndefined();
  expect(parsed.fhir.doseAndRate?.[0]?.rateQuantity).toMatchObject({ value: 5, code: "ug/kg/d" });
  expect(parsed.meta.canonical.clauses[0].clinicalQuantity).toMatchObject({
    numerator: { value: 5, unit: "ug" }, dailyTotal: true, requiresPatientWeight: true
  });
});


it.each([
  ["Infuse 25 mL over 60 min", undefined, undefined],
  ["Infuse 25 mL over 60 min daily for 3 days", 3, "d"]
])("requires actual course-duration evidence when projecting %s", (input, courseDuration, courseUnit) => {
  const sign = parseClauseSign(input);
  if (!sign) throw new Error("Expected a typed infusion sign");
  const state = parseClauseState(input);
  // Model the overlapping timing daughter that projection must distinguish
  // from a separately owned course duration. Missing optional evidence does
  // not establish ownership of this elapsed-time artifact.
  state.duration = 60;
  state.durationUnit = "min";
  projectHpsgSignToState(sign, state, state.tokens, {
    addDayOfWeekList: () => {},
    addWhen: () => {},
    markToken: () => {},
    recordEvidence: () => {},
    refreshMethodSurface: () => {},
    setRoute: () => {}
  });
  expect(state.primaryClause.schedule?.administrationDuration).toBe(60);
  expect(state.primaryClause.schedule?.administrationDurationUnit).toBe("min");
  expect(state.primaryClause.schedule?.duration).toBe(courseDuration);
  expect(state.primaryClause.schedule?.durationUnit).toBe(courseUnit);
});
