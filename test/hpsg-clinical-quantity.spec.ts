import { unifySynsem } from "../src/hpsg/unification";
import { describe, expect, it } from "vitest";
import { parseClauseSign, parseClauseState } from "../src/parser";
import { projectHpsgSignToState } from "../src/hpsg/projection";
import { canonicalFromFhir, canonicalToFhir, parserStateFromFhir, TIMING_ADMINISTRATION_DURATION_EXTENSION_URL } from "../src/fhir";
import {
  calculateTotalUnits, importCanonicalCourse,
  getEmaQuantityComparator,
  parseInstructionActions,
  getDosageCondition,
  nextDueDoses,
  formatSig,
  parseSig as parsePublicSig,
  toDosageDetails,
  toFhirR5Dosages
} from "../src/index";
import { parseSig } from "./helpers/r5-parser";
import { EventTiming, FhirPeriodUnit, type FhirDosage, type FhirQuantity } from "../src/types";
import { getQuantityComparator } from "../src/fhir-quantity-operator";
import { formatZonedIso } from "../src/execution/calendar";

/** Scalar dose/rate choices use SimpleQuantity at either wire boundary.
 * Their operator survives in the existing extension; native clinical facts
 * still carry their operator directly and are asserted separately below. */
function expectSimpleQuantityOperator(quantity: FhirQuantity | undefined, comparator: string | undefined): void {
  expect(quantity?.comparator).toBeUndefined();
  expect(quantity?._comparator).toBeUndefined();
  expect(getQuantityComparator(quantity)).toBe(comparator);
  expect(getEmaQuantityComparator(quantity)).toBe(comparator);
}
import { getTimingMonthDays, TIMING_DAY_OF_MONTH_EXTENSION_URL } from "../src/fhir";

describe("HPSG clinical quantity grammar", () => {
  it("does not impose an invented one-dose cap on a PRN fixed-duration infusion", () => {
    const input = "Infuse 25 mL IV over 1 hour as needed for pain";
    const parsed = parsePublicSig(input);
    expect(parsed.items).toHaveLength(1);
    const dosage = parsed.fhir[0];
    expect(dosage.asNeeded).toBe(true);
    expect(dosage.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 25, code: "mL" });
    expect(dosage.timing?.repeat).toMatchObject({ duration: 1, durationUnit: "h" });
    expect(dosage.timing?.repeat?.count).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0]?.prn?.enabled).toBe(true);
    const strict = toFhirR5Dosages(parsed.fhirNext)[0];
    expect(strict.timing?.repeat?.count).toBeUndefined();
    expect(canonicalFromFhir(strict).schedule?.count).toBeUndefined();

    // Unlike PRN, an actually one-time fixed-duration infusion retains count=1.
    const oneTime = parsePublicSig("Infuse 25 mL IV over 1 hour once").fhir[0];
    expect(oneTime.timing?.repeat?.count).toBe(1);
    const recurring = parsePublicSig("Infuse 25 mL IV over 1 hour QD PRN").fhir[0];
    expect(recurring.timing?.repeat).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
    expect(recurring.timing?.repeat?.count).toBeUndefined();
  });

  it.each([
    {
      source: "Infuse 25 mL IV over 1 hour on days 1 and 15 of each month",
      expected: ["2026-11-01", "2026-11-15", "2026-12-01", "2026-12-15"]
    },
    {
      source: "Infuse 25 mL IV over 1 hour on day 1 of each month",
      expected: ["2026-11-01", "2026-12-01", "2027-01-01", "2027-02-01"]
    },
    {
      source: "Infuse 25 mL IV over 1 hour on 02/11/2026 and 09/11/2026",
      expected: ["2026-11-02", "2026-11-09"]
    }
  ])("keeps recurring or source-dated infusions uncapped: $source", ({ source, expected }) => {
    const parsed = parsePublicSig(source);
    expect(parsed.fhir).toHaveLength(1);
    expect(parsed.meta.canonical.clauses[0].clinicalQuantity).toMatchObject({
      administrationDuration: { value: 1, unit: "h" }
    });
    for (const row of [parsed.fhir[0], toFhirR5Dosages(parsed.fhirNext)[0]]) {
      expect(row.timing?.repeat?.count).toBeUndefined();
      expect(row.timing?.repeat).toMatchObject({ duration: 1, durationUnit: "h" });
      expect(row.doseAndRate?.[0]?.rateRatio).toMatchObject({
        numerator: { value: 25, code: "mL" },
        denominator: { value: 1, code: "h" }
      });
      const due = nextDueDoses(row, {
        from: "2026-11-01T00:00:00+07:00",
        orderedAt: "2026-11-01T00:00:00+07:00",
        timeZone: "Asia/Bangkok",
        limit: expected.length
      });
      expect(due.map(iso => iso.slice(0, 10))).toEqual(expected);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it("retains count one only for a genuinely one-time infusion", () => {
    const parsed = parsePublicSig("Infuse 25 mL IV over 1 hour once");
    for (const row of [parsed.fhir[0], toFhirR5Dosages(parsed.fhirNext)[0]]) {
      expect(row.timing?.repeat).toMatchObject({ count: 1, duration: 1, durationUnit: "h" });
    }
  });

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

  it("retains an explicit fluid infusion rate through both FHIR import paths", () => {
    const parsed = parsePublicSig("Infuse 500 mL IV over 2 hours");
    const row = parsed.fhir[0];
    const expected = row.doseAndRate?.[0]?.rateRatio;
    expect(expected).toMatchObject({
      numerator: { value: 500, code: "mL" },
      denominator: { value: 2, code: "h" }
    });
    expect(row.extension?.some(extension =>
      extension.url.endsWith("medication-infusion-carrier-material"))).not.toBe(true);

    const strictRow = toFhirR5Dosages(parsed.fhirNext)[0];
    for (const clause of [
      canonicalFromFhir(strictRow),
      parserStateFromFhir(strictRow).primaryClause
    ]) {
      expect(clause.clinicalQuantity).toMatchObject({
        representation: "dose-with-rate-ratio",
        status: "resolved",
        numerator: { value: 500, unit: "mL", dimension: "volume" },
        projectedDose: { value: 500, unit: "mL" },
        administrationDuration: { value: 2, unit: "h" }
      });
      expect(clause.clinicalQuantity?.carrierMaterial).toBeUndefined();
      expect(canonicalToFhir(clause).doseAndRate?.[0]?.rateRatio).toEqual(expected);
    }
  });

  it("does not infer a carrier meaning for unrelated active-dose and fluid-rate quantities", () => {
    const row: FhirDosage = {
      doseAndRate: [{
        doseQuantity: { value: 5, unit: "mg" },
        rateRatio: {
          numerator: { value: 100, unit: "mL" },
          denominator: { value: 2, unit: "h" }
        }
      }]
    };
    expect(canonicalFromFhir(row).clinicalQuantity).toBeUndefined();
    expect(parserStateFromFhir(row).primaryClause.clinicalQuantity).toBeUndefined();
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

  it.each([
    "10 mg/kg daily divided into 3 doses",
    "10 mg/kg daily in 3 divided doses",
    "10 mg/kg PO daily divided into 3 doses",
    "10 mg/kg QD divided into 3 doses",
    "10 mg/kg once daily divided into 3 doses"
  ])("divides an explicit daily weight-based total without erasing the patient-mass denominator: %s", source => {
    const parsed = parsePublicSig(source);
    expect(parsed.items).toHaveLength(1);
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.clinicalQuantity).toMatchObject({
      representation: "dose",
      status: "resolved",
      numerator: { value: 10, unit: "mg", dimension: "mass" },
      denominators: [
        { value: 1, unit: "kg", dimension: "patient-mass" },
        { value: 1, unit: "d", dimension: "time" }
      ],
      dailyTotal: true,
      dividedDoseCount: 3,
      requiresPatientWeight: true,
      projectedDose: { value: 10 / 3, unit: "mg/kg" }
    });
    expect(clause.dose?.value).toBeCloseTo(10 / 3);
    expect(clause.dose?.unit).toBe("mg/kg");
    expect(clause.schedule).toMatchObject({ frequency: 3, period: 1, periodUnit: "d" });
    expect(parsed.meta.leftoverText).toBeUndefined();
    for (const dosage of [parsed.fhir[0], toFhirR5Dosages(parsed.fhirNext)[0]]) {
      expect(dosage.doseAndRate?.[0]?.doseQuantity?.value).toBeCloseTo(10 / 3);
      expect(dosage.doseAndRate?.[0]?.doseQuantity?.code).toBe("mg/kg");
      expect(dosage.timing?.repeat).toMatchObject({ frequency: 3, period: 1, periodUnit: "d" });
      expect(dosage.timing?.code?.coding?.some(coding => coding.code === "QD")).not.toBe(true);
    }
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

  it.each([
    "30 mg daily divided into 3 doses",
    "30 mg daily in 3 divided doses"
  ])("projects a daily total as three 10 mg administrations: %s", (source) => {
    const parsed = parsePublicSig(source);
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.clinicalQuantity).toMatchObject({
      representation: "dose",
      status: "resolved",
      numerator: { value: 30, unit: "mg", dimension: "mass" },
      denominators: [{ value: 1, unit: "d", dimension: "time" }],
      dailyTotal: true,
      dividedDoseCount: 3,
      projectedDose: { value: 10, unit: "mg" }
    });
    expect(clause.dose).toEqual({ value: 10, unit: "mg" });
    expect(clause.schedule).toMatchObject({ frequency: 3, period: 1, periodUnit: "d" });
    expect(parsed.meta.leftoverText).toBeUndefined();
    for (const dosage of [parsed.fhir[0], toFhirR5Dosages(parsed.fhirNext)[0]]) {
      expect(dosage.doseAndRate?.[0]?.doseQuantity).toMatchObject({
        value: 10, unit: "mg"
      });
      expect(dosage.timing?.repeat).toMatchObject({
        frequency: 3, period: 1, periodUnit: "d"
      });
      expect(nextDueDoses(dosage, {
        from: "2026-10-26T08:00:00+07:00",
        orderedAt: "2026-10-26T08:00:00+07:00",
        timeZone: "Asia/Bangkok", limit: 3
      })).toEqual([
        "2026-10-26T08:00:00+07:00",
        "2026-10-26T14:00:00+07:00",
        "2026-10-26T20:00:00+07:00"
      ]);
    }
  });

  it("does not retain a contradictory QD code after typed daily-total division", () => {
    const parsed = parsePublicSig("30 mg PO QD in 3 divided doses");
    for (const dosage of [parsed.fhir[0], toFhirR5Dosages(parsed.fhirNext)[0]]) {
      expect(dosage.doseAndRate?.[0]?.doseQuantity?.value).toBe(10);
      expect(dosage.timing?.repeat).toMatchObject({
        frequency: 3, period: 1, periodUnit: "d"
      });
      expect(dosage.timing?.code?.coding?.some(c => c.code === "QD")).not.toBe(true);
    }
  });

  it("does not divide an ordinary once-daily 30 mg administration without a split", () => {
    const parsed = parsePublicSig("30 mg daily");
    expect(parsed.fhir[0].doseAndRate?.[0]?.doseQuantity?.value).toBe(30);
    expect(parsed.fhir[0].timing?.repeat?.frequency).toBe(1);
  });

  it.each([
    "one whole tablet PO BID",
    "one entire tablet PO BID",
    "one full tablet PO BID"
  ])("recognizes the stated complete tablet as one tablet: %s", (source) => {
    const parsed = parsePublicSig(source);
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.fhir[0].doseAndRate?.[0]?.doseQuantity).toMatchObject({
      value: 1, unit: "tab"
    });
    expect(parsed.fhir[0].timing?.repeat).toMatchObject({
      frequency: 2, period: 1, periodUnit: "d"
    });
    expect(toFhirR5Dosages(parsed.fhirNext)[0]?.doseAndRate?.[0]?.doseQuantity)
      .toMatchObject({ value: 1, unit: "tab" });
  });

  it("understands pre-nominal division modifiers for a dimensional daily total", () => {
    const clause = parseClauseState("10 mg/kg/day in 3 divided doses").primaryClause;
    expect(clause.clinicalQuantity).toMatchObject({
      numerator: { value: 10, unit: "mg" },
      dividedDoseCount: 3,
      projectedDose: { value: 10 / 3, unit: "mg/kg" }
    });
    expect(clause.schedule).toMatchObject({ frequency: 3, period: 1, periodUnit: "d" });
    expect(clause.leftovers).toEqual([]);
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

  it.each([
    "Infuse at 125 mL/h over 8 hours",
    "Infuse at 125 mL/hr over 8 hours",
    "Infuse at 125 mL/h for 8 hours"
  ])("attaches the explicit duration to the infusion rate, not the course: %s", source => {
    const parsed = parsePublicSig(source);
    expect(parsed.meta.canonical.clauses[0].clinicalQuantity).toMatchObject({
      representation: "rate-quantity", status: "resolved",
      numerator: { value: 125, unit: "mL" },
      administrationDuration: { value: 8, unit: "h" }
    });
    const dosage = parsed.fhir[0];
    expect(dosage.doseAndRate?.[0]?.rateQuantity).toMatchObject({ value: 125, code: "mL/h" });
    expect(dosage.doseAndRate?.[0]?.doseQuantity).toBeUndefined();
    expect(dosage.timing?.repeat).toMatchObject({ duration: 8, durationUnit: "h" });
    expect(dosage.timing?.repeat?.boundsDuration).toBeUndefined();
    expect(parsed.meta.leftoverText).toBeUndefined();
  });

  it.each([
    "Infuse at 100 mL/h and observe for 30 minutes",
    "Infuse at 100 mL/h then observe for 30 minutes",
    "Infuse at 100 mL/h; observe for 30 minutes",
    "Infuse at 100 mL/h, and observe for 30 minutes"
  ])("does not attach a separate observation duration to the infusion: %s", source => {
    const result = parsePublicSig(source);
    expect(result.meta.canonical.clauses[0].clinicalQuantity).toMatchObject({
      representation: "rate-quantity", status: "resolved",
      numerator: { value: 100, unit: "mL" }
    });
    expect(result.meta.canonical.clauses[0].clinicalQuantity?.administrationDuration).toBeUndefined();
    expect(result.fhir[0].doseAndRate?.[0]?.rateQuantity).toMatchObject({
      value: 100, code: "mL/h"
    });
    expect(result.fhir[0].timing?.repeat?.duration).toBeUndefined();
    expect(result.fhir[0].text).toBe(source);
  });

  it.each([
    "Infuse at 100 mL/h, over 2 hours",
    "Infuse at 100 mL/h IV over 2 hours",
    "Infuse at 100 mL/h, IV, over 2 hours",
    "Infuse at 100 mL/h for 2 hours"
  ])("keeps an infusion-local duration through optional commas and route: %s", source => {
    const result = parsePublicSig(source);
    expect(result.meta.canonical.clauses[0].clinicalQuantity?.administrationDuration)
      .toEqual({ value: 2, unit: "h" });
    expect(result.fhir[0].doseAndRate?.[0]?.rateQuantity).toMatchObject({
      value: 100, code: "mL/h"
    });
    expect(result.fhir[0].timing?.repeat).toMatchObject({
      duration: 2, durationUnit: "h"
    });
    expect(result.fhir[0].timing?.repeat?.boundsDuration).toBeUndefined();
  });

  it("keeps a separate observation interval out of weight-based infusion time", () => {
    const source = "Infuse IV at 5 mcg/kg/min and observe for 30 minutes";
    const result = parsePublicSig(source);
    expect(result.meta.canonical.clauses[0].clinicalQuantity).toMatchObject({
      representation: "rate-quantity", status: "resolved", requiresPatientWeight: true,
      denominators: [
        { value: 1, unit: "kg", dimension: "patient-mass" },
        { value: 1, unit: "min", dimension: "time" }
      ]
    });
    expect(result.meta.canonical.clauses[0].clinicalQuantity?.administrationDuration).toBeUndefined();
    expect(result.fhir[0].doseAndRate?.[0]?.rateQuantity).toMatchObject({
      value: 5, code: "ug/kg/min"
    });
    expect(result.fhir[0].timing?.repeat?.duration).toBeUndefined();
    expect(result.fhir[0].text).toBe(source);
  });

  it("keeps an over-duration attached to a patient-weight infusion rate", () => {
    const parsed = parsePublicSig("Infuse IV at 5 mcg/kg/min over 8 hours");
    expect(parsed.meta.canonical.clauses[0].clinicalQuantity).toMatchObject({
      representation: "rate-quantity", status: "resolved", requiresPatientWeight: true,
      administrationDuration: { value: 8, unit: "h" },
      denominators: [
        { value: 1, unit: "kg", dimension: "patient-mass" },
        { value: 1, unit: "min", dimension: "time" }
      ]
    });
    for (const dosage of [parsed.fhir[0], toFhirR5Dosages(parsed.fhirNext)[0]]) {
      expect(dosage.doseAndRate?.[0]?.rateQuantity).toMatchObject({ value: 5, code: "ug/kg/min" });
      expect(dosage.timing?.repeat).toMatchObject({ duration: 8, durationUnit: "h" });
      expect(dosage.timing?.repeat?.boundsDuration).toBeUndefined();
    }
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


describe("additive dose quantities and conditional measurement ownership", () => {
  it.each([
    ["Take one and a half tablets every morning", 1.5],
    ["Take 1 and a half tablets every morning", 1.5],
    ["Take two and a half tablets every morning", 2.5],
    ["Take 2 and three quarters tablets every morning", 2.75]
  ])("forms one typed additive quantity daughter for %s", (source, expected) => {
    const sign = parseClauseSign(source);
    const state = parseClauseState(source);
    const parsed = parsePublicSig(source);

    expect(sign?.synsem.head.dose).toMatchObject({ value: expected, unit: "tab" });
    expect(sign?.evidence).toContainEqual(expect.objectContaining({
      rule: "hpsg.lex.clinicalQuantity.additiveFractionDose"
    }));
    expect(state.primaryClause.dose).toEqual({ value: expected, unit: "tab" });
    expect(state.primaryClause.leftovers).toEqual([]);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.fhir[0].doseAndRate?.[0]?.doseQuantity).toMatchObject({
      value: expected,
      unit: "tab"
    });
    expect(parsed.fhir[0].timing?.repeat?.when).toEqual(["MORN"]);
    expect(parsed.input).toBe(source);
  });

  it("does not extend the shared-unit construction across an intervening tablet unit", () => {
    const source = "Take one tablet and half a tablet every morning";
    const sign = parseClauseSign(source);

    expect(sign?.evidence).not.toContainEqual(expect.objectContaining({
      rule: "hpsg.lex.clinicalQuantity.additiveFractionDose"
    }));
    expect(parsePublicSig(source).input).toBe(source);
  });

  it.each([
    "Take 2 tablets daily if weight above 70kg; otherwise 1 tablet daily",
    "Take 2 tablets daily if weight above 70kg; otherwise take 1 tablet daily"
  ])("keeps the body-weight measurement distinct from both medication doses: %s", source => {
    const parsed = parsePublicSig(source);
    const quantities = parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity);
    const twoTabletRow = parsed.items.find(item =>
      item.fhir.doseAndRate?.[0]?.doseQuantity?.value === 2
    );

    expect(quantities).toContainEqual(expect.objectContaining({ value: 2, unit: "tab" }));
    expect(quantities).toContainEqual(expect.objectContaining({ value: 1, unit: "tab" }));
    expect(quantities).not.toContainEqual(expect.objectContaining({ value: 70, unit: "kg" }));
    expect(getDosageCondition(twoTabletRow?.fhir ?? {})).toMatchObject({
      kind: "measurement",
      name: "weight",
      operation: "gt",
      value: 70,
      unit: "kg"
    });
    expect(parsed.items.some(item => item.fhir.asNeeded === true)).toBe(false);
    expect(parsed.input).toBe(source);
  });

  it("continues to accept an explicitly administered 70 kg product quantity", () => {
    const source = "Administer 70 kg product daily";
    const parsed = parsePublicSig(source);

    expect(parsed.fhir[0].doseAndRate?.[0]?.doseQuantity).toMatchObject({
      value: 70,
      unit: "kg"
    });
    expect(parsed.input).toBe(source);
  });
});


describe("prenominal supplemental dose quantities", () => {
  it.each([
    ["take an extra half tablet HS", 0.5, true],
    ["take an additional 0.5 tablet HS", 0.5, true],
    ["take extra one tablet", 1, false]
  ] as const)("keeps the supplemental modifier inside one typed dose: %s",
    (source, expectedDose, hasBedtime) => {
      const sign = parseClauseSign(source);
      const state = parseClauseState(source);
      const parsed = parsePublicSig(source);

      expect(sign?.synsem.head.dose).toMatchObject({ value: expectedDose, unit: "tab" });
      expect(sign?.evidence).toContainEqual(expect.objectContaining({
        rule: "hpsg.lex.dose.supplementalQuantity"
      }));
      expect(state.primaryClause.dose).toEqual({ value: expectedDose, unit: "tab" });
      expect(state.primaryClause.evidence).toContainEqual(expect.objectContaining({
        rule: "hpsg.lex.dose.supplementalQuantity"
      }));
      expect(state.primaryClause.leftovers).toEqual([]);
      expect(parsed.meta.leftoverText).toBeUndefined();
      expect(parsed.fhir[0].doseAndRate?.[0]?.doseQuantity).toMatchObject({
        value: expectedDose,
        unit: "tab"
      });
      expect(parsed.fhir[0].timing?.repeat?.when).toEqual(hasBedtime ? ["HS"] : undefined);
      expect(parsed.meta.canonical.clauses[0]?.rawText).toBe(source);
      expect(parsed.input).toBe(source);
    });

  it("does not turn an ordinary modified object into a medication dose", () => {
    const source = "an extra cleaning tissue";
    const sign = parseClauseSign(source);
    const state = parseClauseState(source);
    const parsed = parsePublicSig(source);

    expect(sign?.synsem.head.dose).toBeUndefined();
    expect(state.primaryClause.dose).toBeUndefined();
    expect(parsed.fhir[0]?.doseAndRate?.[0]?.doseQuantity).toBeUndefined();
    expect(parsed.input).toBe(source);
  });

  it("keeps the full modifier phrase on the right of a fixed-clock boundary", () => {
    const source = "Take 1 tablet at 07:00, 11:00, 15:00 and 19:00; take an extra half tablet at bedtime if symptoms worsen";
    const parsed = parsePublicSig(source);
    const regular = parsed.fhir.find(row =>
      row.doseAndRate?.[0]?.doseQuantity?.value === 1
    );
    const supplemental = parsed.fhir.find(row =>
      row.doseAndRate?.[0]?.doseQuantity?.value === 0.5
    );

    expect(parsed.fhir).toHaveLength(2);
    expect(regular?.timing?.repeat?.timeOfDay).toEqual([
      "07:00:00", "11:00:00", "15:00:00", "19:00:00"
    ]);
    expect(supplemental?.timing?.repeat?.when).toEqual(["HS"]);
    expect(getDosageCondition(regular!)).toBeUndefined();
    expect(supplemental?.asNeeded === true || Boolean(getDosageCondition(supplemental!))).toBe(true);
    expect(parsed.meta.canonical.clauses[0]?.rawText.toLowerCase()).not.toContain("extra");
    expect(parsed.meta.canonical.clauses[1]?.rawText.toLowerCase())
      .toMatch(/^take an extra half tablet/u);
    expect(parsed.meta.canonical.clauses[1]?.leftovers).toEqual([]);
    expect(parsed.input).toBe(source);
  });

  it("keeps a conditional supplemental bedtime dose independent of the waking-hours base", () => {
    const source = "Take 1 tablet every 4 hours while awake; take an extra half tablet at bedtime only if symptoms persist.";
    const parsed = parsePublicSig(source);
    const regular = parsed.fhir.find(row =>
      row.doseAndRate?.[0]?.doseQuantity?.value === 1
    );
    const supplemental = parsed.fhir.find(row =>
      row.doseAndRate?.[0]?.doseQuantity?.value === 0.5
    );

    expect(parsed.fhir).toHaveLength(2);
    expect(parsed.fhirNext.step).toHaveLength(1);
    expect(parsed.fhirNext.step[0]?.component).toHaveLength(2);
    expect(regular?.timing?.repeat).toMatchObject({ period: 4, periodUnit: "h" });
    expect(regular?.timing?.repeat?.when).toBeUndefined();
    expect(regular?.asNeeded).not.toBe(true);
    expect(getDosageCondition(regular!)).toBeUndefined();
    expect(supplemental?.timing?.repeat?.when).toEqual(["HS"]);
    expect(supplemental?.asNeeded === true || Boolean(getDosageCondition(supplemental!))).toBe(true);
    expect(parsed.meta.canonical.clauses[1]?.rawText).toContain("an extra half tablet");
    expect(parsed.meta.canonical.clauses[1]?.leftovers).toEqual([]);
    expect(parsed.input).toBe(source);

    const orderedAt = "2026-11-02T00:00:00+07:00";
    const schedule = {
      orderedAt,
      from: orderedAt,
      timeZone: "Asia/Bangkok",
      eventClock: {
        [EventTiming.Wake]: "06:30",
        [EventTiming["Before Sleep"]]: "22:00"
      },
      limit: 5
    } as const;
    const expectedTimes = ["06:30", "10:30", "14:30", "18:30", "22:00"];
    for (const regimen of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(nextDueDoses(regimen, schedule).map(value => value.slice(11, 16)))
        .toEqual(expectedTimes);
      expect(calculateTotalUnits({
        dosage: regimen,
        ...schedule,
        durationValue: 7,
        durationUnit: "d"
      })).toMatchObject({ totalUnits: 31.5, unit: "tab", quantityKind: "maximum" });
    }
  });
});


describe("conditional observation quantities never become medication doses", () => {
  it.each([
    "Take 1 tablet every morning. Take 1 extra tablet if weight increases by 2 kg in 3 days.",
    "Take 1 tablet in the morning. Take an extra 1 tablet if weight gain exceeds 2 kg over 3 days."
  ])("preserves the two tablet administrations and the complete observation condition: %s", input => {
    const parsed = parsePublicSig(input);
    expect(parsed.fhir.map(row => row.doseAndRate?.[0]?.doseQuantity))
      .toMatchObject([{ value: 1, unit: "tab" }, { value: 1, unit: "tab" }]);
    expect(parsed.fhir.every(row => row.timing?.repeat?.boundsDuration === undefined)).toBe(true);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
    expect(getDosageCondition(parsed.fhir[0])).toBeUndefined();
    expect(getDosageCondition(parsed.fhir[1])).toMatchObject({ kind: "text" });
    const last = parsed.fhir[1];
    expect(last.text).toContain("weight");
    expect(last.text).toContain("2 kg");
    expect(last.text).toContain("3 days");
    const strict = toFhirR5Dosages(parsed.fhirNext);
    expect(strict.map(row => row.doseAndRate?.[0]?.doseQuantity))
      .toMatchObject([{ value: 1, unit: "tab" }, { value: 1, unit: "tab" }]);
    for (const frame of parseInstructionActions(input)) {
      for (const argument of frame.args) {
        if (argument.role !== "amount" || !argument.span) continue;
        expect(argument.span.start).toBeGreaterThanOrEqual(frame.span.start);
        expect(argument.span.end).toBeLessThanOrEqual(frame.span.end);
        expect(argument.quantity?.unit).not.toBe("kg");
      }
    }
  });

  it("still interprets a real quantified medication instruction rather than banning mass units", () => {
    const parsed = parsePublicSig("Take 2 g daily for 3 days.");
    expect(parsed.fhir[0].doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 2, unit: "g" });
    expect(parsed.fhir[0].timing?.repeat?.boundsDuration?.value).toBe(3);
  });
  it.each([
    ["Take 2 additional tablets if weight rises by 2 kg within 72 hours.", 2],
    ["Take an additional half tablet if weight decreases by 1 kg over 3 days.", 0.5],
    ["Take 1 extra tablet if creatinine rises by 0.3 mg/dl in 48 hours.", 1]
  ] as const)("keeps the observation window separate for adjacent quantified conditional forms: %s", (input, amount) => {
    const parsed = parsePublicSig(input);
    expect(parsed.fhir).toHaveLength(1);
    expect(parsed.fhir[0].doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: amount, unit: "tab" });
    expect(parsed.fhir[0].timing?.repeat?.boundsDuration).toBeUndefined();
    expect(getDosageCondition(parsed.fhir[0])).toMatchObject({ kind: "text" });
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });

  it.each([
    "Take 1 tablet in the morning; if body weight increases by 2 kg in 3 days, take an extra 1 tablet at noon.",
    "Take 1 tablet in the morning. If weight increases by 2 kg, take 1 extra tablet at noon.",
    "Take 1 tablet in the morning and take an extra 1 tablet at noon if body weight increases by 2 kg in 3 days."
  ])("attaches a conditional extra administration without conditioning the unrelated standing dose: %s", input => {
    const parsed = parsePublicSig(input);
    expect(parsed.fhirNext.step).toHaveLength(1);
    expect(parsed.fhir).toHaveLength(2);
    expect(getDosageCondition(parsed.fhir[0])).toBeUndefined();
    expect(getDosageCondition(parsed.fhir[1])).toBeDefined();
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      const day = "2026-11-02";
      const options = { orderedAt: day + "T00:00:00+07:00", from: day + "T00:00:00+07:00",
        timeZone: "Asia/Bangkok", eventClock: { MORN: "08:00", NOON: "12:00" }, limit: 4 };
      const times = (enabled: boolean) => nextDueDoses(dosage, {
        ...options, evaluateCondition: () => enabled
      }).filter(value => value.startsWith(day)).map(value => value.slice(11, 16));
      expect(times(false)).toEqual(["08:00"]);
      expect(times(true)).toEqual(["08:00", "12:00"]);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });

  it.each([
    "Take 1 tablet at 08:00 for 7 days if dialysis day.",
    "Take 1 tablet at 08:00 for 7 days if it is a dialysis day.",
    "รับประทาน 1 เม็ด เวลา 08:00 เป็นเวลา 7 วัน ถ้าเป็นวันฟอกไต"
  ])("retains an explicit context-day condition without inventing the patient's calendar: %s", input => {
    const parsed = parsePublicSig(input);
    expect(parsed.fhir).toHaveLength(1);
    expect(parsed.fhir[0].doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    // Calendar membership is supplied by the caller, not a coded patient problem.
    expect(getDosageCondition(parsed.fhir[0])).toMatchObject({ kind: "text" });
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      const options = { orderedAt: "2026-11-02T00:00:00+07:00", from: "2026-11-02T00:00:00+07:00",
        timeZone: "Asia/Bangkok", limit: 2 };
      expect(nextDueDoses(dosage, { ...options, evaluateCondition: () => false })).toEqual([]);
      expect(nextDueDoses(dosage, { ...options, evaluateCondition: () => true })[0])
        .toBe("2026-11-02T08:00:00+07:00");
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });

  it.each(["only if dialysis day", "unless dialysis day", "เฉพาะเมื่อเป็นวันฟอกไต"])(
    "does not recode contextual day membership as a patient problem under an explicit guard: %s", guard => {
      const input = "Take 1 tablet at 08:00 for 7 days " + guard + ".";
      const parsed = parsePublicSig(input);
      const condition = getDosageCondition(parsed.fhir[0]);
      if (guard.startsWith("unless")) {
        expect(condition).toMatchObject({ kind: "not", condition: { kind: "text" } });
      } else expect(condition).toMatchObject({ kind: "text" });
      expect(getDosageCondition(toFhirR5Dosages(parsed.fhirNext)[0])).toEqual(condition);
      expect(parsed.fhirNext.renderedInstruction).toBe(input);
    }
  );

});


describe("finite duration follows an administration adjunct", () => {
  it.each([
    "Take 1 tablet with snacks for 14 days.",
    "Take 1 tablet with snacks for 2 weeks."
  ])("keeps the course bound separate from the adjunct object: %s", input => {
    const parsed = parsePublicSig(input);
    expect(parsed.fhir).toHaveLength(1);
    expect(parsed.fhir[0].doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(parsed.fhir[0].timing?.repeat?.boundsDuration?.value).toBe(input.includes("14") ? 14 : 2);
    expect(parsed.fhir[0].timing?.repeat?.boundsDuration?.code).toBe(input.includes("14") ? "d" : "wk");
    expect(parsed.fhir[0].timing?.repeat?.when).toBeUndefined();
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });
  it("does not promote the duration of an unrelated procedure into the medication course", () => {
    const parsed = parsePublicSig("Take 2 tablets with meals; wash hands for 14 seconds.");
    expect(parsed.fhir).toHaveLength(1);
    expect(parsed.fhir[0].doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 2, unit: "tab" });
    expect(parsed.fhir[0].timing?.repeat?.boundsDuration).toBeUndefined();
  });
});


describe("calendar month-day source ownership", () => {
  const activeDays = Array.from({ length: 14 }, (_, index) => index + 1);
  it.each([
    "1 tab PO QD on days 1-14 of each month",
    "1 tablet daily on days 1 through 14 each month",
    "รับประทาน 1 เม็ด วันละครั้ง วันที่ 1-14 ของทุกเดือน"
  ])("never projects monthly calendar ordinals into the prescribed dose: %s", input => {
    const parsed = parsePublicSig(input);
    expect(parsed.fhir).toHaveLength(1);
    expect(parsed.fhir[0].doseAndRate?.[0]).toMatchObject({
      doseQuantity: { value: 1, unit: "tab" }
    });
    expect(parsed.meta.canonical.clauses[0].dose).toMatchObject({ value: 1, unit: "tab" });
    expect(parsed.meta.canonical.clauses[0].schedule?.dayOfMonth).toEqual(activeDays);
    expect(parsed.meta.canonical.clauses[0].dose?.range).toBeUndefined();
    const strict = toFhirR5Dosages(parsed.fhirNext);
    for (const row of [parsed.fhir[0], strict[0]]) {
      expect(getTimingMonthDays(row.timing?.repeat)).toEqual(activeDays);
      expect(row.timing?.repeat?.extension?.filter(ext =>
        ext.url === TIMING_DAY_OF_MONTH_EXTENSION_URL)).toHaveLength(14);
    }
    const reopened = toDosageDetails(strict);
    expect(getTimingMonthDays(reopened.step[0].component[0].timing?.repeat)).toEqual(activeDays);
    expect(formatSig(strict[0], "long", { locale: "en" })).toContain("on days 1–14 of each month");
    expect(formatSig(strict[0], "long", { locale: "th" })).toContain("วันที่ 1–14 ของทุกเดือน");
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });

  it("keeps isolated monthly day 31 without fabricating shorter-month occurrences", () => {
    const parsed = parsePublicSig("Take 1 tablet daily on day 31 of every month.");
    expect(parsed.fhir[0].doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
    expect(getTimingMonthDays(parsed.fhir[0].timing?.repeat)).toEqual([31]);
    expect(formatSig(parsed.fhir[0], "long")).toContain("on day 31 of each month");
  });

  it.each([
    ["range", activeDays], ["single day", [31]], ["separate days", [1, 15]],
    ["three separate days", [1, 15, 28]]
  ] as const)("reparses source-less English and Thai monthly %s in both styles", (_name, days) => {
    const row: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: {
        frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        extension: days.map(day => ({ url: TIMING_DAY_OF_MONTH_EXTENSION_URL, valuePositiveInt: day }))
      } }
    };
    for (const locale of ["en", "th"] as const) for (const style of ["short", "long"] as const) {
      const text = formatSig(row, style, { locale });
      const reparsed = parsePublicSig(text);
      expect(reparsed.fhir, text).toHaveLength(1);
      expect(reparsed.fhir[0].doseAndRate?.[0], text).toMatchObject({ doseQuantity: { value: 1, unit: "tab" } });
      expect(getTimingMonthDays(reparsed.fhir[0].timing?.repeat), text).toEqual(days);
      expect(reparsed.fhir[0].timing?.repeat?.frequency, text).toBe(1);
    }
  });

  it.each([
    ["1 tab PO QD on days 1-14 of each month", activeDays],
    ["รับประทาน 1 เม็ด วันละครั้ง วันที่ 1-14 ของทุกเดือน", activeDays],
    ["Take 1 tablet daily on day 31 of every month.", [31]]
  ] as const)("can reparse human-readable EN/TH short AND long monthly restrictions: %s", (input, days) => {
    const original = parsePublicSig(input);
    for (const dosage of [original.fhir[0], toFhirR5Dosages(original.fhirNext)[0]]) {
      for (const locale of ["en", "th"] as const) {
        for (const mode of ["short", "long"] as const) {
          const formatted = formatSig(dosage, mode, { locale });
          expect(formatted).not.toContain("month:");
          expect(formatted).not.toContain("วันที่:");
          const reentered = parsePublicSig(formatted, { locale });
          expect(reentered.fhir[0].doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
          expect(reentered.fhir[0].doseAndRate?.[0]?.doseRange).toBeUndefined();
          expect(getTimingMonthDays(reentered.fhir[0].timing?.repeat)).toEqual([...days]);
        }
      }
    }
  });

  it("does not say once monthly for imported days 1 and 15 without a frequency", () => {
    const row: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: {
        period: 1, periodUnit: FhirPeriodUnit.Month,
        extension: [1, 15].map(day => ({ url: TIMING_DAY_OF_MONTH_EXTENSION_URL, valuePositiveInt: day }))
      } }
    };
    for (const locale of ["en", "th"] as const) for (const style of ["short", "long"] as const) {
      const text = formatSig(row, style, { locale });
      expect(text).not.toContain(locale === "en" ? "once monthly" : "เดือนละครั้ง");
      if (style === "short") expect(text).not.toContain("Q1MO");
      expect(text).toContain(locale === "en"
        ? "on days 1 and 15 of each month" : "วันที่ 1 และ 15 ของทุกเดือน");
      expect(getTimingMonthDays(parsePublicSig(text, { locale }).fhir[0].timing?.repeat))
        .toEqual([1, 15]);
    }
  });

  it("reparses a noncontiguous month-day set imported from FHIR in both languages", () => {
    const base = parsePublicSig("Take 1 tablet daily on day 1 of every month.").fhir[0];
    const imported = {
      ...base, timing: { ...base.timing, repeat: { ...base.timing?.repeat, extension: [
        { url: TIMING_DAY_OF_MONTH_EXTENSION_URL, valuePositiveInt: 1 },
        { url: TIMING_DAY_OF_MONTH_EXTENSION_URL, valuePositiveInt: 15 }
      ] } }
    };
    expect(getTimingMonthDays(imported.timing.repeat)).toEqual([1, 15]);
    for (const locale of ["en", "th"] as const) {
      for (const mode of ["short", "long"] as const) {
        const formatted = formatSig(imported, mode, { locale });
        expect(formatted).toContain(locale === "en"
          ? "on days 1 and 15 of each month" : "วันที่ 1");
        const next = parsePublicSig(formatted, { locale });
        expect(next.fhir[0].doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
        expect(next.fhir[0].doseAndRate?.[0]?.doseRange).toBeUndefined();
        expect(getTimingMonthDays(next.fhir[0].timing?.repeat)).toEqual([1, 15]);
      }
    }
  });

  it("retains true medication quantity and finite course when no monthly-day head exists", () => {
    const parsed = parsePublicSig("Take 2 tablets daily for 14 days.");
    expect(parsed.fhir[0].doseAndRate?.[0]?.doseQuantity?.value).toBe(2);
    expect(parsed.fhir[0].timing?.repeat?.boundsDuration?.value).toBe(14);
    expect(getTimingMonthDays(parsed.fhir[0].timing?.repeat)).toBeUndefined();
  });
});


describe("CodeRabbit 2026-10-25 second review: schedule-only semantics", () => {
  it("preserves a clinician-authored monthly-day restriction without requiring a separate QD token", () => {
    const source = "1 tab PO on days 1-14 of each month";
    const typed = parseClauseSign(source)?.synsem.head.schedule;
    const actual = parseClauseState(source).primaryClause.schedule;
    expect(typed?.dayOfMonth).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
    expect(actual?.dayOfMonth).toEqual(typed?.dayOfMonth);
    expect(getTimingMonthDays(canonicalToFhir(parseClauseState(source).primaryClause).timing?.repeat))
      .toEqual(typed?.dayOfMonth);
  });

  it("preserves an unanchored menstrual-cycle restriction even without a separate cadence", () => {
    const source = "1 tab PO on cycle days 3-7";
    const typed = parseClauseSign(source)?.synsem.head.schedule;
    const actual = parseClauseState(source).primaryClause.schedule;
    expect(typed?.cycleDayConstraint?.days).toEqual([3, 4, 5, 6, 7]);
    expect(actual?.cycleDayConstraint).toMatchObject({
      days: [3, 4, 5, 6, 7],
      reason: "missing-or-unresolved-cycle-anchor"
    });
  });
});


describe("qualified clinical quantity family: source through HPSG and FHIR", () => {
  const prefixes = [
    ["", undefined], ["approximately ", "~"], ["about ", "~"],
    ["~", "~"], ["≈", "~"], [">=", ">="], ["≥", ">="],
    ["<=", "<="], ["≤", "<="], ["at least ", ">="], ["no more than ", "<="],
    ["more than ", ">"], ["less than ", "<"]
  ] as const;

  it.each(prefixes)("preserves '%s' on a full infusion amount and its derived rate", (prefix, comparator) => {
    for (const separator of [" ", ""]) {
      // Word prefixes have ordinary spaced units; compact symbol doses
      // share the same bounded clinical construction, not a new parser.
      if (separator === "" && prefix.endsWith(" ")) continue;
      const input = `Infuse ${prefix}500${separator}mL IV over 2 hours once`;
      const parsed = parsePublicSig(input);
      const canonical = parsed.meta.canonical.clauses[0];
      expect(canonical.dose).toMatchObject({ value: 500, unit: "mL" });
      expect(canonical.dose?.comparator).toBe(comparator);
      expect(canonical.clinicalQuantity?.administrationDuration).toEqual({ value: 2, unit: "h" });
      const native = parsed.fhirNext.step[0].component[0].doseAndRate![0];
      expect(native.doseQuantity).toMatchObject({ value: 500, unit: "mL" });
      expectSimpleQuantityOperator(native.doseQuantity, comparator);
      expect(native.rateRatio?.numerator).toMatchObject({ value: 500, unit: "mL" });
      expect(native.rateRatio?.numerator?.comparator).toBe(comparator);
      expect(native.rateRatio?.denominator).toMatchObject({ value: 2, unit: "h" });
      const r5 = toFhirR5Dosages(parsed.fhirNext);
      expect(r5[0].doseAndRate?.[0].doseQuantity?.value).toBe(500);
      expect(getEmaQuantityComparator(r5[0].doseAndRate?.[0].doseQuantity)).toBe(comparator);
      const reopened = toDosageDetails(JSON.parse(JSON.stringify(r5))).step[0].component[0]
        .doseAndRate?.[0];
      expect(reopened?.doseQuantity).toMatchObject({ value: 500, unit: "mL" });
      expectSimpleQuantityOperator(reopened?.doseQuantity, comparator);
      expect(reopened?.rateRatio?.numerator).toMatchObject({ value: 500, unit: "mL" });
      expect(getQuantityComparator(reopened?.rateRatio?.numerator)).toBe(comparator);
      expect(reopened?.rateRatio?.denominator).toMatchObject({ value: 2, unit: "h" });
      expect(parsed.input).toBe(input);
      expect(parsed.meta.leftoverText).toBeUndefined();
    }
  });

  it.each([
    ["approximately ", "", "~", undefined],
    ["", "approximately ", undefined, "~"],
    ["at least ", "no more than ", ">=", "<="],
    ["~", "<=", "~", "<="],
    ["", "", undefined, undefined]
  ] as const)("keeps '%s' drug and '%s' carrier qualifiers independent", (active, carrier, drugOp, carrierOp) => {
    const input = `Infuse ${active}20 mg in ${carrier}500 mL normal saline over 4 hours once`;
    const parsed = parsePublicSig(input);
    const entry = parsed.fhirNext.step[0].component[0].doseAndRate![0];
    expect(entry.doseQuantity).toMatchObject({ value: 20, unit: "mg" });
    expectSimpleQuantityOperator(entry.doseQuantity, drugOp);
    expect(entry.rateRatio?.numerator).toMatchObject({ value: 500, unit: "mL" });
    expect(entry.rateRatio?.numerator?.comparator).toBe(carrierOp);
    expect(entry.rateRatio?.denominator).toMatchObject({ value: 4, unit: "h" });
    expect(parsed.meta.canonical.clauses[0].clinicalQuantity?.carrierMaterial?.text).toBe("normal saline");
    expect(parsed.meta.leftoverText).toBeUndefined();
    const fromStored = toDosageDetails(JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext))));
    expect(fromStored.step[0].component[0].doseAndRate?.[0]).toEqual(entry);
  });

  it.each([
    ["approximately ", "", "~", undefined],
    ["", "approximately ", undefined, "~"],
    ["at least ", "no more than ", ">=", "<="],
    ["~", ">=", "~", ">="],
    ["", "", undefined, undefined]
  ] as const)("keeps '%s' dose and '%s' independently stated rate separate", (dose, rate, doseOp, rateOp) => {
    const parsed = parsePublicSig(`Infuse ${dose}500 mL IV at ${rate}100 mL/hr once`);
    const entry = parsed.fhirNext.step[0].component[0].doseAndRate![0];
    expect(entry.doseQuantity).toMatchObject({ value: 500, unit: "mL" });
    expectSimpleQuantityOperator(entry.doseQuantity, doseOp);
    expect(entry.rateQuantity).toMatchObject({ value: 100, unit: "mL/h" });
    expectSimpleQuantityOperator(entry.rateQuantity, rateOp);
    expect(parsed.meta.leftoverText).toBeUndefined();
    const numeric = () => calculateTotalUnits({ dosage: parsed, durationValue: 1,
      durationUnit: "d", from: "2026-11-01T00:00:00Z", orderedAt: "2026-11-01T00:00:00Z", timeZone: "UTC" });
    if (doseOp === ">=") expect(numeric).toThrow(/lower bound/);
    else expect(numeric().totalUnits).toBe(500);
  });

  it.each(["approximately ", "~", ">=", "≤"])("retains %s on unresolved daily amounts and divided doses without inventing a scalar", prefix => {
    const expected = prefix === ">=" ? ">=" : prefix === "≤" ? "<=" : "~";
    const incomplete = parsePublicSig(`${prefix}6 mg/kg/day`);
    expect(incomplete.meta.canonical.clauses[0].dose).toBeUndefined();
    expect(incomplete.meta.canonical.clauses[0].clinicalQuantity?.numerator.comparator).toBe(expected);
    expect(incomplete.fhir[0].doseAndRate?.[0].doseQuantity).toBeUndefined();
    const rate = incomplete.fhirNext.step[0].component[0].doseAndRate?.[0].rateQuantity;
    expect(rate).toMatchObject({ value: 6, unit: "mg/kg/d" });
    expectSimpleQuantityOperator(rate, expected);
    const divided = parsePublicSig(`${prefix}6 mg/kg/day in 3 divided doses`);
    expect(divided.meta.canonical.clauses[0].dose).toMatchObject({ value: 2, unit: "mg/kg", comparator: expected });
    const dividedQuantity = divided.fhirNext.step[0].component[0].doseAndRate?.[0].doseQuantity;
    expect(dividedQuantity).toMatchObject({ value: 2, unit: "mg/kg" });
    expectSimpleQuantityOperator(dividedQuantity, expected);
    const infusion = parsePublicSig(`Infuse ${prefix}2 mcg/kg/min`);
    expect(infusion.meta.canonical.clauses[0].dose).toBeUndefined();
    const infusionRate = infusion.fhirNext.step[0].component[0].doseAndRate?.[0].rateQuantity;
    expect(infusionRate).toMatchObject({ value: 2, unit: "ug/kg/min" });
    expectSimpleQuantityOperator(infusionRate, expected);
  });
});


describe("qualified infusion duration imported as a Ratio denominator", () => {
  it.each([["100000000055", "~"], ["100000000053", ">="], ["100000000052", "<="]] as const)(
    "retains standard EMA code %s in structured duration, R5 output and R6 display", (code, comparator) => {
      const source: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 500, unit: "mL" },
        rateRatio: { numerator: { value: 500, unit: "mL" }, denominator: {
          value: 2, unit: "h", extension: [{ url: "http://ema.europa.eu/fhir/extension/comparator",
            valueCoding: { system: "http://spor.ema.europa.eu/v1/lists/100000000008", code } }]
        } }
      }] };
      const canonical = canonicalFromFhir(source);
      expect(canonical.clinicalQuantity?.administrationDuration).toEqual({ value: 2, unit: "h", comparator });
      expect(canonical.dose?.comparator).toBeUndefined();
      const saved = canonicalToFhir(canonical);
      expect(saved.doseAndRate?.[0].rateRatio?.denominator?.value).toBe(2);
      expectSimpleQuantityOperator(saved.doseAndRate?.[0].rateRatio?.denominator, comparator);
      expect(formatSig(toDosageDetails([saved]), "long", { locale: "en" }))
        .toContain(`Rate: 500 mL / ${comparator}2 h`);
    }
  );
});


describe("comparative mixed numbers and shared dimensional quantities", () => {
  it.each([
    ["Take at most two and a half tablets at bedtime", 2.5, "<="],
    ["Take approximately 2 and a quarter tablets daily", 2.25, "~"],
    ["Take >=2 and three quarters tablets daily", 2.75, ">="],
    ["Take ≤2 and one half tablets daily", 2.5, "<="],
    ["Take ~2 and 1/2 tablets daily", 2.5, "~"],
    ["Take at least one and two thirds tablets daily", 1 + 2 / 3, ">="],
    ["Dissolve at most two and a half tablets in water", 2.5, "<="],
    ["squeeze at most two and a half cm ribbon cream onto each spot", 2.5, "<="]
  ] as const)("retains the qualified mixed number in %s", (text, value, comparator) => {
    const parsed = parsePublicSig(text);
    const quantity = parsed.fhirNext.step[0].component[0].doseAndRate?.[0].doseQuantity;
    expect(quantity?.value).toBeCloseTo(value);
    expectSimpleQuantityOperator(quantity, comparator);
    expect(getEmaQuantityComparator(parsed.fhir[0].doseAndRate?.[0].doseQuantity)).toBe(comparator);
    expectSimpleQuantityOperator(toDosageDetails(JSON.parse(JSON.stringify(parsed.fhir))).step[0]
      .component[0].doseAndRate?.[0].doseQuantity, comparator);
    expect(parsed.input).toBe(text);
  });

  it("keeps unit-bearing coordinated amounts independent of the mixed-number construction", () => {
    const parsed = parsePublicSig("Take at most two tablets and half a tablet at bedtime");
    const amounts = parsed.fhirNext.step.flatMap(step => step.component.flatMap(
      component => component.doseAndRate?.map(value => value.doseQuantity) ?? []));
    expect(amounts.map(value => value?.value)).toEqual([2, 0.5]);
    expect(amounts.map(getQuantityComparator)).toEqual(["<=", undefined]);
    expect(amounts.map(value => value?.comparator)).toEqual([undefined, undefined]);
    expect(parsePublicSig("Take two and a half tablets daily").fhirNext.step[0]
      .component[0].doseAndRate?.[0].doseQuantity).toMatchObject({ value: 2.5 });
  });

  it.each(["µ", "μ", "u", "mc"])("normalizes attached and separated %sg rates with identical ownership", micro => {
    for (const [prefix, comparator] of [["~", "~"], [">=", ">="], ["≤", "<="]] as const) {
      for (const suffix of ["/kg/min", "/hr"]) {
        const joined = parsePublicSig(`Infuse ${prefix}0.1${micro}g${suffix}`);
        const separated = parsePublicSig(`Infuse ${prefix}0.1 ${micro}g${suffix}`);
        const a = joined.fhirNext.step[0].component[0].doseAndRate?.[0];
        const b = separated.fhirNext.step[0].component[0].doseAndRate?.[0];
        expect(a).toEqual(b);
        expect(a?.rateQuantity).toMatchObject({ value: 0.1,
          unit: suffix === "/hr" ? "ug/h" : "ug/kg/min" });
        expectSimpleQuantityOperator(a?.rateQuantity, comparator);
        expect(a?.doseQuantity).toBeUndefined();
        expect(getEmaQuantityComparator(joined.fhir[0].doseAndRate?.[0].rateQuantity)).toBe(comparator);
      }
    }
  });

  it("retains the daily-total qualifier through later feature merges without dividing twice", () => {
    const context = { normalizeSiteText: (text: string) => text,
      isCompatibleRouteRefinement: () => true };
    for (const comparator of ["~", "<=", ">="] as const) {
      const combined = unifySynsem({ head: { dose: { value: 30, unit: "mg",
        comparator, divisionCount: 2 } }, valence: {}, cont: {} },
      { head: { schedule: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
        valence: {}, cont: {} }, context)!;
      expect(combined.head.dose?.clinicalQuantity?.numerator).toMatchObject({ value: 30, comparator });
      expect(combined.head.dose?.clinicalQuantity?.projectedDose).toMatchObject({ value: 15, comparator });
      const mergedAgain = unifySynsem(combined, { head: { dose: { divisionCount: 2 } },
        valence: {}, cont: {} }, context)!;
      expect(mergedAgain.head.dose?.value).toBe(15);
      expect(mergedAgain.head.dose?.clinicalQuantity?.numerator).toMatchObject({ value: 30, comparator });
      expect(mergedAgain.head.dose?.clinicalQuantity?.projectedDose).toMatchObject({ value: 15, comparator });
    }
    for (const text of ["approximately 30 mg daily in 2 divided doses",
      "approximately 30 mg daily in 2 divided doses PO",
      "approximately 30 mg daily in 2 divided doses with food"]) {
      const parsed = parsePublicSig(text);
      expect(parsed.meta.canonical.clauses[0].clinicalQuantity?.numerator)
        .toMatchObject({ value: 30, comparator: "~" });
      const dividedQuantity = parsed.fhirNext.step[0].component[0].doseAndRate?.[0].doseQuantity;
      expect(dividedQuantity).toMatchObject({ value: 15 });
      expectSimpleQuantityOperator(dividedQuantity, "~");
      expect(calculateTotalUnits({ dosage: parsed, from: "2026-11-02T00:00:00Z",
        timeZone: "UTC", durationValue: 1, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(30);
    }
  });
});

describe("fractional million and attached dimensional rate families", () => {
  it.each([
    ["approximately two and a half million units PO daily", 2500000, "U", "~"],
    ["two and a half million units PO daily", 2500000, "U", undefined],
    ["~2 and a half million units", 2500000, "U", "~"],
    [">=2 and three quarters million IU once", 2750000, "IU", ">="],
    ["approximately two and a half tablets", 2.5, "tab", "~"],
    ["Take two and a half tablets daily", 2.5, "tab", undefined]
  ] as const)("does not lose magnitude or comparator in %s",
    (input, value, unit, comparator) => {
      const parsed = parsePublicSig(input);
      const dose = parsed.fhirNext.step[0].component[0].doseAndRate?.[0].doseQuantity;
      expect(dose).toMatchObject({ value, unit });
      expectSimpleQuantityOperator(dose, comparator);
      const r5 = parsed.fhir[0].doseAndRate?.[0].doseQuantity;
      expect(r5?.value).toBe(value);
      expect(getEmaQuantityComparator(r5)).toBe(comparator);
      const reopened = toDosageDetails(JSON.parse(JSON.stringify(parsed.fhir)));
      const savedDose = reopened.step[0].component[0].doseAndRate?.[0].doseQuantity;
      expect(savedDose?.value).toBe(value);
      expectSimpleQuantityOperator(savedDose, comparator);
      expect(parsed.input).toBe(input);
    }
  );

  it.each([
    ["~", "~"], [">=", ">="], ["≤", "<="]
  ] as const)("joins attached and separated mass/time denominators without losing %s", (symbol, comparator) => {
    for (const micro of ["µ", "μ", "u", "mc"]) {
      const joined = parsePublicSig(`Infuse ${symbol}0.1${micro}g/kg per min`);
      const separated = parsePublicSig(`Infuse ${symbol}0.1 ${micro}g/kg per min`);
      const compact = parsePublicSig(`Infuse ${symbol}0.1${micro}g/kg/min`);
      const doses = [joined, separated, compact].map(result =>
        result.fhirNext.step[0].component[0].doseAndRate?.[0]);
      for (const dose of doses) {
        expect(dose?.rateQuantity).toMatchObject({
          value: 0.1, unit: "ug/kg/min"
        });
        expectSimpleQuantityOperator(dose?.rateQuantity, comparator);
        expect(dose?.doseQuantity).toBeUndefined();
      }
      expect(doses[0]).toEqual(doses[1]);
      expect(doses[0]).toEqual(doses[2]);
      expect(getEmaQuantityComparator(joined.fhir[0].doseAndRate?.[0].rateQuantity))
        .toBe(comparator);
    }
  });

  it.each([
    ["Infuse approximately 0.1mcg/kg per minute", "~"],
    ["Infuse approximately 0.1µg/kg per minute", "~"],
    ["Infuse ~0.1mcg/kg per minute", "~"],
    ["Infuse 0.1mcg/kg per minute", undefined],
    ["Infuse 0.1mcg/kg/min", undefined],
    ["Infuse ~0.1 mcg/kg per minute", "~"]
  ] as const)("shares the compact and separated per-minute grammar for %s", (text, comparator) => {
    const parsed = parsePublicSig(text);
    const dose = parsed.fhirNext.step[0].component[0].doseAndRate?.[0];
    expect(dose?.doseQuantity).toBeUndefined();
    expect(dose?.rateQuantity).toMatchObject({ value: 0.1, unit: "ug/kg/min" });
    expectSimpleQuantityOperator(dose?.rateQuantity, comparator);
    expect(getEmaQuantityComparator(parsed.fhir[0].doseAndRate?.[0].rateQuantity)).toBe(comparator);
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.input).toBe(text);
  });

  it("does not invent a per-minute rate when only a per-kilogram dose was authored", () => {
    const amount = parsePublicSig("Inject approximately 0.1 µg/kg once");
    const dose = amount.fhirNext.step[0].component[0].doseAndRate?.[0];
    expect(dose?.doseQuantity).toMatchObject({
      value: 0.1, unit: "ug/kg"
    });
    expectSimpleQuantityOperator(dose?.doseQuantity, "~");
    expect(dose?.rateQuantity).toBeUndefined();
  });
});


describe("compact million multiplier stays distinct from an attached medication unit", () => {
  it.each([
    ["approximately 2.4M IU IM once", 2400000, "~"],
    ["~2.4M IU IM once", 2400000, "~"],
    [">=2.4m IU IM once", 2400000, ">="],
    ["≤2.4M IU IM once", 2400000, "<="],
    ["2.4M IU IM once", 2400000, undefined],
    ["approximately 2.4 million IU IM once", 2400000, "~"]
  ] as const)("keeps the authored numeric million and comparator for %s",
    (text, value, comparator) => {
      const parsed = parsePublicSig(text);
      const dose = parsed.fhirNext.step[0].component[0].doseAndRate?.[0].doseQuantity;
      expect(dose).toMatchObject({ value, unit: "IU" });
      expectSimpleQuantityOperator(dose, comparator);
      const r5 = parsed.fhir[0].doseAndRate?.[0].doseQuantity;
      expect(r5).toMatchObject({ value, unit: "IU" });
      expect(getEmaQuantityComparator(r5)).toBe(comparator);
      const reopened = toDosageDetails(toFhirR5Dosages(parsed.fhirNext)).step[0]
        .component[0].doseAndRate?.[0].doseQuantity;
      expect(reopened).toMatchObject({ value, unit: "IU" });
      expectSimpleQuantityOperator(reopened, comparator);
      expect(parsed.input).toBe(text);
    });
});

describe("adversarial compact infusion carriers and leading-decimal rates", () => {
  it.each([
    ["Infuse 20mg in 500mL over 4 hours", false, false, undefined],
    ["Infuse 20 mg in 500 mL over 4 hours", false, false, undefined],
    ["Infuse 20mg in approximately 500mL over 4 hours", true, false, undefined],
    ["Infuse approximately 20mg in 500mL over 4 hours", false, true, undefined],
    ["Infuse 20mg in 500mL normal saline over 4 hours", false, false, "normal saline"]
  ] as const)("keeps independently authored active and attached carrier amounts: %s",
    (input, approximateCarrier, approximateDrug, carrierMaterial) => {
      const parsed = parsePublicSig(input);
      const amount = parsed.fhirNext.step[0].component[0].doseAndRate![0];
      expect(amount.doseQuantity).toMatchObject({ value: 20, unit: "mg" });
      expectSimpleQuantityOperator(amount.doseQuantity, approximateDrug ? "~" : undefined);
      expect(amount.rateRatio?.numerator).toMatchObject({ value: 500, unit: "mL" });
      expect(amount.rateRatio?.numerator?.comparator).toBe(approximateCarrier ? "~" : undefined);
      expect(amount.rateRatio?.denominator).toMatchObject({ value: 4, unit: "h" });
      if (carrierMaterial) expect(parsed.meta.canonical.clauses[0].clinicalQuantity?.carrierMaterial?.text)
        .toBe(carrierMaterial);
      const recovered = toDosageDetails(JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext))));
      expect(recovered.step[0].component[0].doseAndRate?.[0].doseQuantity?.value).toBe(20);
      expect(recovered.step[0].component[0].doseAndRate?.[0].rateRatio?.numerator?.value).toBe(500);
      const reopened = recovered.step[0].component[0].doseAndRate?.[0];
      expectSimpleQuantityOperator(reopened?.doseQuantity, approximateDrug ? "~" : undefined);
      expect(reopened?.rateRatio?.numerator?.comparator).toBe(approximateCarrier ? "~" : undefined);
      expect(reopened?.rateRatio?.denominator).toMatchObject({ value: 4, unit: "h" });
      expect(reopened?.rateRatio?.denominator?.comparator).toBeUndefined();
      expect(parsed.input).toBe(input);
    }
  );

  it.each([
    ["Infuse .1mcg/kg/min", undefined],
    ["Infuse ~.1mcg/kg/min", "~"],
    ["Infuse ≈.1mcg/kg/min", "~"],
    ["Infuse >=.1mcg/kg/min", ">="],
    ["Infuse <=.1mcg/kg/min", "<="],
    ["Infuse approximately .1mcg/kg/min", "~"],
    ["Infuse .1mcg/kg per min", undefined],
    ["Infuse .1mcg/kg/min.", undefined]
  ] as const)("preserves a leading decimal and a source comparator in %s",
    (input, comparator) => {
      const parsed = parsePublicSig(input);
      const rate = parsed.fhirNext.step[0].component[0].doseAndRate?.[0].rateQuantity;
      expect(rate).toMatchObject({ value: 0.1, unit: "ug/kg/min" });
      expectSimpleQuantityOperator(rate, comparator);
      expect(parsed.fhirNext.step[0].component[0].doseAndRate?.[0].doseQuantity).toBeUndefined();
      expect(getEmaQuantityComparator(parsed.fhir[0].doseAndRate?.[0].rateQuantity))
        .toBe(comparator);
      expect(parsed.input).toBe(input);
    }
  );
});


describe("November 16 qualified glued tablet fractions", () => {
  it.each([
    ["≤1/2 tablet", 0.5, "<="],
    [">=3/4 tab", 0.75, ">="],
    ["~1/2 tab", 0.5, "~"],
    ["≤0.5 tablet", 0.5, "<="],
    ["≤ 1/2 tablet", 0.5, "<="]
  ] as const)("%s retains its comparator and clinical numeric dose", (sig, value, comparator) => {
    const parsed = parsePublicSig(sig, { context: { dosageForm: "tablet" } });
    const dose = parsed.meta.canonical.clauses[0]?.dose;
    expect(dose?.value).toBe(value);
    expect(dose?.comparator).toBe(comparator);
    expect(parsed.fhir[0]?.doseAndRate?.[0]?.doseQuantity?.value).toBe(value);
  });
  it.each(["≤1/0 tablet", "≥2/0 tablet"])("never produces a non-finite dose: %s", sig => {
    const parsed = parsePublicSig(sig, { context: { dosageForm: "tablet" } });
    for (const value of [parsed.meta.canonical.clauses[0]?.dose?.value,
      parsed.fhir[0]?.doseAndRate?.[0]?.doseQuantity?.value]) {
      expect(value === undefined || Number.isFinite(value)).toBe(true);
    }
  });
});


describe("November 17 review: comparator-headed million quantity", () => {
  it.each([
    ["approximately 2.4M IU IM once", "~"],
    ["about 2.4m IU IM once", "~"],
    ["≤2.4m IU IM once", "<="],
  ] as const)(
    "preserves qualified million scaling in %s",
    (source, comparator) => {
      const parsed = parsePublicSig(source);
      const quantity = parsed.fhir[0]?.doseAndRate?.[0]?.doseQuantity;
      expect(quantity).toMatchObject({ value: 2400000, unit: "IU" });
      expect(getQuantityComparator(quantity)).toBe(comparator);
      expect(parsed.meta.canonical.clauses[0].dose)
        .toMatchObject({ value: 2400000, unit: "IU", comparator });
    }
  );
});


describe("rate and timestamp interchange family", () => {
  const parseSig = parsePublicSig;
describe("rate heads shared with inclusive quantity comparators", () => {
  it.each([
    ["at most", "<="], ["at least", ">="],
    ["at approximately", "~"], ["at no more than", "<="],
    ["at", undefined], ["@", undefined],
  ] as const)("preserves the dimensional rate licensed by '%s'", (lead, comparator) => {
    for (const unit of ["mL/hr", "mL / hr", "mL per hour"]) {
      const input = `IV ${lead} 100 ${unit}`;
      const parsed = parseSig(input);
      const dose = parsed.fhirNext.step[0].component[0].doseAndRate![0];
      expect(dose.rateQuantity, input).toMatchObject({ value: 100, unit: "mL/h" });
      expect(getQuantityComparator(dose.rateQuantity), input).toBe(comparator);
      expect(dose.rateQuantity).not.toHaveProperty("comparator");
      for (const step of parsed.fhirNext.step ?? []) for (const component of step.component)
        for (const entry of component.doseAndRate ?? []) expect(entry.doseQuantity, input).toBeUndefined();
      expect(parsed.input).toBe(input);
      expect(parsed.meta.leftoverText, input).toBeUndefined();
      const reopened = toDosageDetails(JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext))));
      const recovered = reopened.step[0].component[0].doseAndRate![0];
      expect(recovered.rateQuantity, input).toEqual(dose.rateQuantity);
      for (const step of reopened.step ?? []) for (const component of step.component)
        for (const entry of component.doseAndRate ?? []) expect(entry.doseQuantity, input).toBeUndefined();
    }
  });

  it.each([
    ["IV at most 0.5mg/min", "<="],
    ["IV at least 0.5 mg / min", ">="],
    ["Infuse at most 0.5 mg per minute", "<="],
  ] as const)("keeps amount and per-time units together in %s", (input, comparator) => {
    const dose = parseSig(input).fhirNext.step[0].component[0].doseAndRate![0];
    expect(dose.rateQuantity).toMatchObject({ value: 0.5, unit: "mg/min" });
    expect(getQuantityComparator(dose.rateQuantity)).toBe(comparator);
    expect(dose.doseQuantity).toBeUndefined();
  });

  it.each([
    ["IV, 100 mL/hr", undefined],
    ["IV, approximately 100 mL/hr", "~"],
    ["IV, at most 100 mL/hr", "<="],
    ["approximately 100 mL/hr, IV", "~"],
  ] as const)("retains a route-licensed rate through one comma: %s", (source, comparator) => {
    const parsed = parseSig(source);
    const component = parsed.fhirNext.step![0].component[0];
    expect(component.route?.coding?.[0].code).toBe("47625008");
    expect(component.doseAndRate?.[0].rateQuantity).toMatchObject({ value: 100, unit: "mL/h" });
    expect(getQuantityComparator(component.doseAndRate?.[0].rateQuantity)).toBe(comparator);
    expect(component.doseAndRate?.[0].doseQuantity).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0].additionalInstructions).toBeUndefined();
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.input).toBe(source);
  });

  it("keeps two explicit administrations separate across a numeric-headed comma", () => {
    const parsed = parseSig("Give 5 mg IV in the morning, 10 mg IV at night");
    const components = parsed.fhirNext.step![0].component;
    expect(components).toHaveLength(2);
    expect(components[0].doseAndRate?.[0].doseQuantity).toMatchObject({ value: 5, unit: "mg" });
    expect(components[0].timing?.repeat?.when).toEqual(["MORN"]);
    expect(components[1].doseAndRate?.[0].doseQuantity).toMatchObject({ value: 10, unit: "mg" });
    expect(components[1].timing?.repeat?.when).toEqual(["NIGHT"]);
  });

  it("retains scalar comparators and requires a rate head for unmarked rates", () => {
    const scalar = parseSig("Take at most 2 tablets daily").fhirNext.step[0].component[0].doseAndRate![0];
    expect(scalar.doseQuantity).toMatchObject({ value: 2, unit: "tab" });
    expect(getQuantityComparator(scalar.doseQuantity)).toBe("<=");
    expect(scalar.rateQuantity).toBeUndefined();
    const unmarked = parseSig("100 mL/hr");
    expect(unmarked.fhirNext.step).toHaveLength(1);
    expect(unmarked.fhirNext.step![0].component).toHaveLength(1);
    const retained = unmarked.fhirNext.step![0].component[0];
    expect(retained.text).toBe("100 mL/hr");
    expect(unmarked.fhirNext.renderedInstruction).toBe("100 mL/hr");
    for (const entry of retained.doseAndRate ?? []) {
      for (const choice of ["doseQuantity", "doseRange", "rateQuantity", "rateRange", "rateRatio"] as const)
        expect(entry[choice]).toBeUndefined();
    }
    expect(unmarked.input).toBe("100 mL/hr");
    const qualifiedTablet = parseSig("at most 2 tablets daily").fhirNext.step[0].component[0].doseAndRate![0];
    expect(qualifiedTablet.doseQuantity).toMatchObject({ value: 2, unit: "tab" });
    expect(getQuantityComparator(qualifiedTablet.doseQuantity)).toBe("<=");
    expect(qualifiedTablet.rateQuantity).toBeUndefined();
  });
});

describe("execution timestamps retain the accepted instant", () => {
  it.each([
    ["2026-11-02T12:00:00.500Z", "UTC", "2026-11-02T12:00:00.500+00:00"],
    ["2026-11-02T12:00:00.001Z", "Asia/Bangkok", "2026-11-02T19:00:00.001+07:00"],
    ["2026-11-02T12:00:00.050Z", "Asia/Kathmandu", "2026-11-02T17:45:00.050+05:45"],
    ["2026-11-01T05:59:59.999Z", "America/New_York", "2026-11-01T01:59:59.999-04:00"],
    ["2026-11-01T06:00:00.001Z", "America/New_York", "2026-11-01T01:00:00.001-05:00"],
  ])("preserves explicit event %s in %s", (instant, timeZone, expected) => {
    const dosage: FhirDosage = {
      timing: { event: [instant] },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
    };
    const due = nextDueDoses(dosage, { from: instant, orderedAt: instant, timeZone, limit: 1 });
    expect(due).toEqual([expected]);
    expect(Date.parse(due[0])).toBe(Date.parse(instant));
  });

  it("keeps whole-second output stable and formats pre-epoch fractions correctly", () => {
    expect(formatZonedIso(new Date("2026-11-02T12:00:00Z"), "UTC"))
      .toBe("2026-11-02T12:00:00+00:00");
    expect(formatZonedIso(new Date("1969-12-31T23:59:59.500Z"), "UTC"))
      .toBe("1969-12-31T23:59:59.500+00:00");
  });
});

});


describe("round 27: numeric constituents own dimensional continuations", () => {
  it.each(["1 and a half", "one and a half", "1.5"])("keeps the entire %s mL/h rate", number => {
    const parsed = parsePublicSig(`Infuse ${number} mL per hour`);
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.dose?.value).toBeUndefined();
    expect(clause.clinicalQuantity?.numerator).toMatchObject({ value: 1.5, unit: "mL" });
    for (const row of [parsed.fhir[0], parsed.fhirNext.step[0].component[0]]) {
      expect(row.doseAndRate).toHaveLength(1);
      expect(row.doseAndRate![0].rateQuantity).toMatchObject({ value: 1.5, code: "mL/h" });
      expect(row.doseAndRate![0].doseQuantity).toBeUndefined();
    }
  });
  it.each(["about", "approximately", "at most"])("retains %s duration independently of the active and carrier amounts", qualifier => {
    const parsed = parsePublicSig(`Infuse 20 mg in 500 mL normal saline over ${qualifier} 2 hours`);
    const comparator = qualifier === "at most" ? "<=" : "~";
    const q = parsed.meta.canonical.clauses[0].clinicalQuantity;
    expect(q?.projectedDose).toMatchObject({ value: 20, unit: "mg" });
    expect(q?.projectedDose?.comparator).toBeUndefined();
    expect(q?.rateNumerator).toMatchObject({ value: 500, unit: "mL" });
    expect(q?.rateNumerator?.comparator).toBeUndefined();
    expect(q?.denominators).toEqual([{ value: 2, unit: "h", dimension: "time", comparator }]);
    expect(q?.administrationDuration).toMatchObject({ value: 2, unit: "h", comparator });
    expect(q?.carrierMaterial?.text).toBe("normal saline");
    const entry = parsed.fhirNext.step[0].component[0].doseAndRate![0];
    expect(entry.doseQuantity).toMatchObject({ value: 20, code: "mg" });
    expect(entry.rateRatio?.numerator).toMatchObject({ value: 500, code: "mL" });
    expect(entry.rateRatio?.denominator).toMatchObject({ value: 2, code: "h" });
    expect(getQuantityComparator(entry.rateRatio?.denominator)).toBe(comparator);
  });
});


describe("round 28: qualified infusion durations keep their clinical operator", () => {
  it.each([
    ["Infuse 500 mL over at most 2 hours", "<="],
    ["Infuse 500 mL IV over at most 2 hours", "<="],
    ["Infuse 500 mL over at least 2 hours", ">="],
    ["Infuse 20 mg in 500 mL saline over at most 2 hours", "<="],
    ["Infuse 20 mg in 500 mL saline over at least 2 hours", ">="],
    ["Infuse 500 mL over 2 hours", undefined],
    ["Infuse 20 mg in 500 mL saline over 2 hours", undefined]
  ] as const)("preserves the duration in %s", (source, comparator) => {
    const parsed = parsePublicSig(source);
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.clinicalQuantity?.administrationDuration).toMatchObject({
      value: 2, unit: "h", ...(comparator ? { comparator } : {})
    });
    expect(clause.schedule?.administrationDurationComparator).toBe(comparator);
    expect(parsed.meta.canonical.course!.stages[0].administrations[0]
      .schedule?.recurrence?.occurrenceDurationComparator).toBe(comparator);
    for (const input of [parsed.fhirNext, toDosageDetails(toFhirR5Dosages(parsed.fhirNext))]) {
      const component = input.step![0].component[0];
      expect(component.doseAndRate![0].rateRatio!.denominator)
        .toMatchObject({ value: 2, code: "h" });
      expect(getQuantityComparator(component.doseAndRate![0].rateRatio!.denominator)).toBe(comparator);
      expect(component.timing?.repeat?.duration).toBe(comparator ? undefined : 2);
      expect(nextDueDoses(input, { orderedAt: "2026-11-21T08:00:00Z",
        from: "2026-11-21T08:00:00Z", timeZone: "UTC", limit: 1 }))
        .toEqual(["2026-11-21T08:00:00+00:00"]);
    }
    for (const row of toFhirR5Dosages(parsed.fhirNext)) {
      expect(canonicalFromFhir(row).schedule?.administrationDurationComparator).toBe(comparator);
      expect(row.timing?.repeat?.duration).toBe(comparator ? undefined : 2);
    }
    expect(parsed.meta.canonical.course?.instruction).toBe(source);
  });
});

describe("round30 qualified scalar infusion duration", () => {
  it.each([
    ["approximately", "~"], ["at most", "<="], ["at least", ">="]
  ])("keeps %s duration separate from the one-hour rate denominator", (qualifier, comparator) => {
    const parsed = parsePublicSig("Infuse at 100 mL/h for " + qualifier + " 2 hours");
    const quantity = parsed.meta.canonical.clauses[0].clinicalQuantity!;
    expect(quantity.administrationDuration).toEqual({ value: 2, unit: "h", comparator });
    expect(quantity.denominators).toEqual([{ value: 1, unit: "h", dimension: "time" }]);
    const inputs = [parsed.fhir, parsed.fhirNext, toDosageDetails(parsed.fhir), toFhirR5Dosages(parsed.fhirNext)];
    for (const input of inputs) {
      const before = JSON.stringify(input);
      const imported = JSON.parse(before);
      const recurrence = importCanonicalCourse(imported).stages[0].administrations[0].schedule!.recurrence!;
      expect(recurrence).toMatchObject({
        occurrenceDuration: 2, occurrenceDurationUnit: "h", occurrenceDurationComparator: comparator
      });
      expect(recurrence.courseLength).toBeUndefined();
      expect(JSON.stringify(imported)).toBe(before);
    }
    expect(parsed.fhir[0].doseAndRate![0].rateQuantity).toMatchObject({ value: 100, unit: "mL/h" });
    expect(getQuantityComparator(parsed.fhir[0].doseAndRate![0].rateQuantity!)).toBeUndefined();
  });
});

describe("round30 carrier duration keeps one wire owner", () => {
  it.each([
    "Infuse 500 mL over approximately 2 hours",
    "Infuse 1 g in 500 mL saline over approximately 2 hours"
  ])("keeps the carrier denominator authoritative after editing %s", source => {
    const parsed = parsePublicSig(source);
    for (const input of [parsed.fhir, toFhirR5Dosages(parsed.fhirNext)]) {
      const row = JSON.parse(JSON.stringify(input[0]));
      expect(row.timing?.repeat?.extension?.some((extension: { url: string }) =>
        extension.url === "urn:ezmedicationinput:StructureDefinition:timing-administration-duration")).not.toBe(true);
      row.doseAndRate[0].rateRatio.denominator.value = 3;
      const recurrence = importCanonicalCourse([row]).stages[0].administrations[0].schedule!.recurrence!;
      expect(recurrence).toMatchObject({
        occurrenceDuration: 3, occurrenceDurationUnit: "h", occurrenceDurationComparator: "~"
      });
      expect(canonicalFromFhir(row).schedule).toMatchObject({
        administrationDuration: 3, administrationDurationUnit: "h", administrationDurationComparator: "~"
      });
    }
  });
});

describe("round30 qualified duration unit ownership", () => {
  it("uses the qualified Quantity unit until a live exact duration supplies the duration owner", () => {
    const parsed = parsePublicSig("Infuse at 100 mL/h for approximately 2 hours");
    const row = JSON.parse(JSON.stringify(parsed.fhir[0])) as FhirDosage;
    const repeat = row.timing!.repeat!;
    const quantity = repeat.extension!.find(item =>
      item.url === "urn:ezmedicationinput:StructureDefinition:timing-administration-duration")!.valueQuantity!;
    repeat.durationUnit = FhirPeriodUnit.Hour;
    quantity.value = 3;
    quantity.code = "min";
    quantity.unit = "minutes";
    const before = JSON.stringify(row);
    for (const input of [[row], toDosageDetails([row])]) {
      const recurrence = importCanonicalCourse(input).stages[0].administrations[0].schedule!.recurrence!;
      expect(recurrence).toMatchObject({
        occurrenceDuration: 3, occurrenceDurationUnit: "min", occurrenceDurationComparator: "~"
      });
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toContain("approximately 3 minutes");
    }
    expect(canonicalFromFhir(row).schedule).toMatchObject({
      administrationDuration: 3, administrationDurationUnit: "min", administrationDurationComparator: "~"
    });
    expect(parserStateFromFhir(row).primaryClause.schedule).toMatchObject({
      administrationDuration: 3, administrationDurationUnit: "min", administrationDurationComparator: "~"
    });
    expect(JSON.stringify(row)).toBe(before);
    repeat.duration = 4;
    expect(importCanonicalCourse([row]).stages[0].administrations[0].schedule!.recurrence)
      .toMatchObject({ occurrenceDuration: 4, occurrenceDurationUnit: "h", occurrenceDurationComparator: undefined });
  });
});

describe("round31 independent and compact infusion durations", () => {
  it.each(["self", "carrier"] as const)("keeps a distinct duration beside the %s carrier rate denominator", kind => {
    const row: FhirDosage = JSON.parse(JSON.stringify(parsePublicSig(kind === "self"
      ? "Infuse 120 mL over approximately 2 hours"
      : "Infuse 20 mg in 120 mL saline over approximately 2 hours").fhir[0]));
    (row.timing ??= {}).repeat ??= {};
    row.timing.repeat!.extension = [{
      url: "urn:ezmedicationinput:StructureDefinition:timing-administration-duration",
      valueQuantity: { value: 3, code: "h", unit: "hours", system: "http://unitsofmeasure.org", comparator: ">=" }
    }];
    const before = JSON.stringify(row);
    const clause = canonicalFromFhir(row);
    expect(clause.schedule).toMatchObject({
      administrationDuration: 3, administrationDurationUnit: "h", administrationDurationComparator: ">="
    });
    for (const input of [[row], [canonicalToFhir(clause)], toDosageDetails([row]),
      toDosageDetails([canonicalToFhir(clause)])]) {
      const course = importCanonicalCourse(input);
      expect(course.stages[0].administrations[0].schedule!.recurrence).toMatchObject({
        occurrenceDuration: 3, occurrenceDurationUnit: "h", occurrenceDurationComparator: ">="
      });
      const projected = toFhirR5Dosages(input)[0];
      const denominator = projected.doseAndRate![0].rateRatio!.denominator!;
      expect(denominator).toMatchObject({ value: 2, code: "h" });
      expect(getQuantityComparator(denominator)).toBe("~");
      expect(canonicalFromFhir(projected).schedule).toMatchObject({
        administrationDuration: 3, administrationDurationUnit: "h", administrationDurationComparator: ">="
      });
    }
    expect(JSON.stringify(row)).toBe(before);
  });

  it.each([
    ["Infuse at 100 mL/hr for ~2h", "~", 2, "h"],
    ["Infuse at 100 mL/hr for ≤2h", "<=", 2, "h"],
    ["Infuse at 100 mL/hr for ≥30min", ">=", 30, "min"],
    ["Infuse at 100 mL/hr for 2h", undefined, 2, "h"],
    ["Infuse at 2 mcg/kg/min for ~2h", "~", 2, "h"]
  ] as const)("retains the trailing joined duration in %s", (source, comparator, value, unit) => {
    const parsed = parsePublicSig(source);
    expect(parsed.meta.canonical.clauses[0].clinicalQuantity!.administrationDuration)
      .toEqual({ value, unit, ...(comparator ? { comparator } : {}) });
    for (const input of [parsed.fhir, parsed.fhirNext]) {
      const before = JSON.stringify(input);
      const recurrence = importCanonicalCourse(input).stages[0].administrations[0].schedule!.recurrence!;
      expect(recurrence).toMatchObject({ occurrenceDuration: value, occurrenceDurationUnit: unit });
      expect(recurrence.occurrenceDurationComparator).toBe(comparator);
      expect(JSON.stringify(input)).toBe(before);
    }
  });
});

describe("round32 complete numeric daughters in dimensional quantities", () => {
  it.each(["Infuse 500 mL over about half an hour", "Infuse 20 mg in 500 mL saline over about half an hour",
    "Infuse 500 mL over about 0.5 hours"])("keeps qualified fraction articles inside %s", source => {
    const parsed = parsePublicSig(source);
    const quantity = parsed.meta.canonical.clauses[0].clinicalQuantity!;
    expect(quantity.denominators).toContainEqual({ value: 0.5, unit: "h", dimension: "time", comparator: "~" });
    expect(quantity.administrationDuration).toEqual({ value: 0.5, unit: "h", comparator: "~" });
    for (const input of [parsed.fhir, parsed.fhirNext]) {
      const administration = importCanonicalCourse(input).stages[0].administrations[0];
      expect(administration.amounts![0].rateRatio!.denominator).toMatchObject({ value: 0.5, unit: "h", comparator: "~" });
      expect(administration.schedule!.recurrence).toMatchObject({
        occurrenceDuration: 0.5, occurrenceDurationUnit: "h", occurrenceDurationComparator: "~"
      });
    }
  });

  it.each(["IV @100 mL/hr", "IV @ 100 mL/hr", "IV @.5 mL/hr", "IV @ .5 mL/hr"])(
    "recognizes the exact attached or separate rate marker in %s", source => {
      const parsed = parsePublicSig(source);
      const value = source.includes(".5") ? 0.5 : 100;
      expect(parsed.meta.canonical.clauses[0].clinicalQuantity).toMatchObject({
        representation: "rate-quantity", numerator: { value, unit: "mL" },
        denominators: [{ value: 1, unit: "h" }]
      });
      for (const row of [parsed.fhir[0], parsed.fhirNext.step[0].component[0]]) {
        expect(row.doseAndRate![0].rateQuantity).toMatchObject({ value, unit: "mL/h" });
        expect(row.route!.coding!.some(coding => coding.code === "47625008")).toBe(true);
        for (const amount of row.doseAndRate ?? []) {
          expect(amount.doseQuantity).toBeUndefined();
          expect(amount.doseRange).toBeUndefined();
          expect("doseExpression" in amount && amount.doseExpression).toBeFalsy();
        }
      }
    });

  it.each([[".5M", 500000], ["2M", 2000000], ["0.5 million", 500000]] as const)(
    "keeps the million multiplier in the numeric head: %s", (amount, value) => {
      const parsed = parsePublicSig("Infuse " + amount + " IU per hour");
      expect(parsed.meta.canonical.clauses[0].clinicalQuantity).toMatchObject({
        representation: "rate-quantity", numerator: { value, unit: "[iU]" },
        denominators: [{ value: 1, unit: "h" }]
      });
      for (const row of [parsed.fhir[0], parsed.fhirNext.step[0].component[0]]) {
        expect(row.doseAndRate![0].rateQuantity).toMatchObject({ value, unit: "[iU]/h" });
        for (const amount of row.doseAndRate ?? []) {
          expect(amount.doseQuantity).toBeUndefined();
          expect(amount.doseRange).toBeUndefined();
          expect("doseExpression" in amount && amount.doseExpression).toBeFalsy();
        }
      }
    });

  it("keeps an attached clock temporal and a compact million scalar dose outside the rate construction", () => {
    const clock = parsePublicSig("Take 1 tablet @09:00");
    expect(clock.meta.canonical.clauses[0].schedule?.timeOfDay).toEqual(["09:00:00"]);
    expect(clock.meta.canonical.clauses[0].clinicalQuantity).toBeUndefined();
    const scalar = parsePublicSig(".5M IU IM once");
    expect(scalar.meta.canonical.clauses[0].dose).toMatchObject({ value: 500000, unit: "IU" });
    expect(scalar.meta.canonical.clauses[0].clinicalQuantity).toBeUndefined();
    expect(scalar.fhir[0].doseAndRate![0].rateQuantity).toBeUndefined();
  });
});

describe("round33 exact fractional duration and rate ownership", () => {
  it.each([
    ["Infuse 100 mL over half an hour", 0.5, "h", undefined],
    ["Infuse 100 mL over half hour", 0.5, "h", undefined],
    ["Infuse 20 mg in 100 mL saline over half an hour", 0.5, "h", undefined],
    ["Infuse 100 mL over about half an hour", 0.5, "h", "~"],
    ["Infuse 100 mL over 30 minutes", 30, "min", undefined],
  ] as const)("preserves the complete elapsed duration in %s", (source, value, unit, comparator) => {
    const parsed = parsePublicSig(source);
    const quantity = parsed.meta.canonical.clauses[0].clinicalQuantity!;
    expect(quantity?.administrationDuration).toEqual({ value, unit, ...(comparator ? { comparator } : {}) });
    for (const input of [parsed.fhir, parsed.fhirNext]) {
      const a = importCanonicalCourse(input).stages[0].administrations[0];
      expect(a.amounts![0].rateRatio!.denominator).toMatchObject({ value, unit });
      expect(a.amounts![0].rateRatio!.denominator!.comparator).toBe(comparator);
      expect(a.schedule!.recurrence).toMatchObject({ occurrenceDuration: value, occurrenceDurationUnit: unit });
    }
  });

  it("keeps an oral hourly cumulative limit separate from an infusion rate", () => {
    const source = "Take 5 mL by mouth as needed, at most 10 mL per hour";
    const parsed = parsePublicSig(source);
    expect(parsed.input).toBe(source);
    expect(parsed.meta.canonical.clauses[0].dose).toMatchObject({ value: 5, unit: "mL" });
    expect(parsed.meta.canonical.clauses[0].schedule?.maxDosePerPeriod)
      .toEqual([{ amount: 10, unit: "mL", period: 1, periodUnit: "h" }]);
    expect(parsed.fhir[0].maxDosePerPeriod).toMatchObject([{
      numerator: { value: 10, unit: "mL" }, denominator: { value: 1, unit: "h" },
    }]);
    expect(parsed.fhirNext.step![0].component[0].safety?.doseLimit).toMatchObject([{
      scope: "period", valueQuantity: { value: 10, unit: "mL" }, period: { value: 1, unit: "h" },
    }]);
    expect(parsed.meta.canonical.clauses[0].clinicalQuantity?.representation).not.toBe("rate-quantity");
    for (const row of [...parsed.fhir, ...parsed.fhirNext.step.flatMap(step => step.component)])
      for (const amount of row.doseAndRate ?? []) {
        expect(amount.rateQuantity).toBeUndefined();
        expect(amount.rateRatio).toBeUndefined();
        expect(amount.rateRange).toBeUndefined();
      }
    const infusion = parsePublicSig("IV at most 100 mL/hr");
    expect(infusion.meta.canonical.clauses[0].clinicalQuantity)
      .toMatchObject({ representation: "rate-quantity", numerator: { value: 100, unit: "mL", comparator: "<=" } });
  });
});


describe("round33 adjacent oral limit attachment", () => {
  it.each(["Give 100 mL per hour", "Administer at most 100 mL per hour", "Infuse at most 100 mL per hour"])(
    "keeps an independently headed rate in %s", source => {
      const parsed = parsePublicSig(source);
      expect(parsed.meta.canonical.clauses[0].clinicalQuantity).toMatchObject({
        representation: "rate-quantity", numerator: { value: 100, unit: "mL" }
      });
    });
  it.each(["Give", "Administer", "Take"])("keeps the oral dose before a cumulative limit after %s", head => {
    const source = head + " 5 mL orally, at most 10 mL per hour";
    const parsed = parsePublicSig(source);
    expect(parsed.input).toBe(source);
    expect(parsed.meta.canonical.clauses[0].dose).toMatchObject({ value: 5, unit: "mL" });
    expect(parsed.meta.canonical.clauses[0].schedule?.maxDosePerPeriod)
      .toEqual([{ amount: 10, unit: "mL", period: 1, periodUnit: "h" }]);
    expect(parsed.fhir[0].maxDosePerPeriod).toMatchObject([{
      numerator: { value: 10, unit: "mL" }, denominator: { value: 1, unit: "h" },
    }]);
    expect(parsed.fhirNext.step![0].component[0].safety?.doseLimit).toMatchObject([{
      scope: "period", valueQuantity: { value: 10, unit: "mL" }, period: { value: 1, unit: "h" },
    }]);
    expect(parsed.meta.canonical.clauses[0].clinicalQuantity).toBeUndefined();
    for (const row of [parsed.fhir[0], parsed.fhirNext.step[0].component[0]]) {
      expect(row.doseAndRate![0].doseQuantity!.value).toBe(5);
      expect(row.doseAndRate![0].rateQuantity).toBeUndefined();
      expect(row.doseAndRate![0].rateRatio).toBeUndefined();
    }
  });
});

describe("round34 complete dimensional numeric phrases", () => {
  it.each([
    ["Give 1 million units per hour", 1000000],
    ["Give one and a half million units per hour", 1500000],
    ["Administer half a million units per hour", 500000],
    ["Give 100 units per hour", 100],
  ] as const)("keeps the whole administration rate in %s", (source, value) => {
    const parsed = parsePublicSig(source);
    expect(parsed.meta.canonical.clauses[0].clinicalQuantity).toMatchObject({
      representation: "rate-quantity", numerator: { value, unit: "[iU]" },
      denominators: [{ value: 1, unit: "h" }],
    });
    for (const input of [parsed.fhir, parsed.fhirNext]) {
      const amounts = importCanonicalCourse(input).stages[0].administrations[0].amounts!;
      expect(amounts[0].rate?.value).toBe(value);
      for (const amount of amounts) {
        expect(amount.quantity).toBeUndefined();
        expect(amount.range).toBeUndefined();
        expect(amount.expression).toBeUndefined();
      }
    }
    expect(parsed.input).toBe(source);
  });

  it.each([
    ["Infuse 100 mL over one and a half hours", 1.5, undefined],
    ["Infuse 100 mL over one and three quarters hours", 1.75, undefined],
    ["Infuse 20 mg in 100 mL saline over two and a half hours", 2.5, undefined],
    ["Infuse 100 mL over approximately one and a half hours", 1.5, "~"],
    ["Infuse 100 mL over 1.5 hours", 1.5, undefined],
  ] as const)("retains the complete duration in %s", (source, value, comparator) => {
    const parsed = parsePublicSig(source);
    expect(parsed.meta.canonical.clauses[0].clinicalQuantity?.administrationDuration)
      .toEqual({ value, unit: "h", ...(comparator ? { comparator } : {}) });
    for (const input of [parsed.fhir, parsed.fhirNext]) {
      const member = importCanonicalCourse(input).stages[0].administrations[0];
      expect(member.amounts![0].rateRatio?.numerator).toMatchObject({ value: 100, unit: "mL" });
      expect(member.amounts![0].rateRatio?.denominator).toMatchObject({ value, unit: "h" });
      expect(member.amounts![0].rateRatio?.denominator?.comparator).toBe(comparator);
    }
    expect(parsed.input).toBe(source);
  });

  it.each(["h", "hr", "hrs", "hour", "hours"])("retains an oral ten-mL maximum per %s without a rate", unit => {
    const parsed = parsePublicSig("Give 5 mL orally, at most 10 mL per " + unit);
    expect(parsed.meta.canonical.clauses[0].dose).toMatchObject({ value: 5, unit: "mL" });
    expect(parsed.meta.canonical.clauses[0].schedule?.maxDosePerPeriod)
      .toEqual([{ amount: 10, unit: "mL", period: 1, periodUnit: "h" }]);
    expect(parsed.fhir[0].maxDosePerPeriod).toMatchObject([{
      numerator: { value: 10, unit: "mL" }, denominator: { value: 1, unit: "h" },
    }]);
    expect(parsed.fhirNext.step![0].component[0].safety?.doseLimit).toMatchObject([{
      scope: "period", valueQuantity: { value: 10, unit: "mL" }, period: { value: 1, unit: "h" },
    }]);
    for (const input of [parsed.fhir, parsed.fhirNext]) {
      const member = importCanonicalCourse(input).stages[0].administrations[0];
      expect(member.amounts![0].quantity).toMatchObject({ value: 5, unit: "mL" });
      expect(member.amounts![0].rate).toBeUndefined();
      expect(member.amounts![0].rateRatio).toBeUndefined();
    }
  });
});


describe("round35 quantity ownership and lexical neighbors", () => {
  it.each([
    ["2 million", 2000000, "units"],
    ["1 and a half", 1.5, "mg"],
    ["about 20", 20, "mg"],
  ])("keeps the active amount in Give %s %s with a carrier", (number, value, unit) => {
    const input = "Give " + number + " " + unit + " in 50 mL over 1 hour";
    const parsed = parsePublicSig(input);
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    const quantity = parsed.meta.canonical.clauses[0].clinicalQuantity;
    expect(quantity?.projectedDose).toMatchObject({ value, unit: unit === "units" ? "[iU]" : unit });
    expect(quantity?.rateNumerator).toMatchObject({ value: 50, unit: "mL" });
    for (const row of [parsed.fhir[0], parsed.fhirNext.step[0].component[0]]) {
      expect(row.doseAndRate?.[0].doseQuantity?.value).toBe(value);
      expect(row.doseAndRate?.[0].rateRatio?.numerator?.value).toBe(50);
      expect(row.doseAndRate?.[0].rateRatio?.denominator).toMatchObject({ value: 1, code: "h" });
    }
    expect(parsed.input).toBe(input);
  });

  it("licenses the entire mixed amount under a generic infusion head with for", () => {
    const parsed = parsePublicSig("Give 1 and a half mL for 1 hour");
    expect(parsed.meta.canonical.clauses[0].clinicalQuantity?.projectedDose).toEqual({ value: 1.5, unit: "mL" });
    expect(parsed.fhir[0].doseAndRate?.[0].rateRatio?.denominator).toMatchObject({ value: 1, code: "h" });
    const control = parsePublicSig("Give 1 tablet, maximum 2 tablets per day");
    expect(control.fhir[0].doseAndRate?.[0].doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(control.fhir[0].doseAndRate?.[0].rateQuantity).toBeUndefined();
  });

  it.each(["about", "at most"])("keeps the %s qualifier on a next-day unitless dose", qualifier => {
    const input = "Take 1 tablet tonight, then " + qualifier + " 2 the next morning";
    const parsed = parsePublicSig(input);
    expect(parsed.meta.canonical.clauses[1].dose).toMatchObject({
      value: 2, unit: "tab", comparator: qualifier === "about" ? "~" : "<="
    });
    expect(getQuantityComparator(parsed.fhir[1].doseAndRate?.[0].doseQuantity))
      .toBe(qualifier === "about" ? "~" : "<=");
    expect(parsed.meta.canonical.clauses[1].schedule).toMatchObject({ when: ["MORN"], treatmentStartOffsetDays: 1 });
    const control = parsePublicSig("Take 1 tablet daily for about one week");
    expect(control.meta.canonical.clauses[0].dose).toMatchObject({ value: 1, unit: "tab" });
    expect(control.meta.canonical.clauses[0].dose?.comparator).toBeUndefined();
  });

  it.each(["≤๑ /๒", "≤๑ / ๒", "≤๑/๒", "≤๑/ ๒", "≤1 /๒", "≤๑ /2",
    "≤1 / 2", "≤1 /2", "≤1/ 2", "≤1/2"])(
    "retains a Thai qualified fraction across spacing: %s", number => {
      const input = "กิน " + number + " เม็ด";
      const parsed = parsePublicSig(input);
      expect(parsed.meta.canonical.clauses).toHaveLength(1);
      expect(parsed.meta.canonical.clauses[0].dose).toMatchObject({ value: 0.5, unit: "tab", comparator: "<=" });
      for (const row of [parsed.fhir[0], parsed.fhirNext.step[0].component[0]]) {
        expect(row.doseAndRate?.[0].doseQuantity).toMatchObject({ value: 0.5, unit: "tab" });
        expect(getQuantityComparator(row.doseAndRate?.[0].doseQuantity)).toBe("<=");
      }
      expect(parsed.input).toBe(input);
    });

  it.each([
    ["20 mg in approximately 100 mL", undefined, "~"],
    ["approximately 20 mg in 100 mL", "~", undefined],
    ["at most 20 mg in at least 100 mL", "<=", ">="],
  ])("divides the drug amount independently of the carrier: %s", (amount, doseComparator, carrierComparator) => {
    const parsed = parsePublicSig("Infuse " + amount + " over 1 hour in 2 divided doses");
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.dose).toMatchObject({ value: 10, unit: "mg" });
    expect(clause.dose?.comparator).toBe(doseComparator);
    expect(clause.clinicalQuantity?.projectedDose).toEqual({ value: 10, unit: "mg",
      ...(doseComparator ? { comparator: doseComparator } : {}) });
    expect(clause.clinicalQuantity?.rateNumerator).toEqual({ value: 100, unit: "mL",
      ...(carrierComparator ? { comparator: carrierComparator } : {}) });
    for (const row of [parsed.fhir[0], parsed.fhirNext.step[0].component[0]]) {
      expect(row.doseAndRate?.[0].doseQuantity).toMatchObject({ value: 10, unit: "mg" });
      expect(getQuantityComparator(row.doseAndRate?.[0].doseQuantity)).toBe(doseComparator);
    }
  });

  it.each([
    ["a half hour", 0.5, undefined], ["half an hour", 0.5, undefined],
    ["about a half hour", 0.5, "~"], ["a quarter hour", 0.25, undefined], ["2 hours", 2, undefined]
  ] as const)("reads the complete elapsed duration %s", (duration, value, comparator) => {
    const parsed = parsePublicSig("Infuse 100 mL over " + duration);
    const elapsed = parsed.meta.canonical.clauses[0].clinicalQuantity?.administrationDuration;
    expect(elapsed).toMatchObject({ value, unit: "h" });
    expect(elapsed?.comparator).toBe(comparator);
    for (const row of [parsed.fhir[0], parsed.fhirNext.step[0].component[0]]) {
      const denominator = row.doseAndRate?.[0].rateRatio?.denominator;
      expect(denominator).toMatchObject({ value, code: "h" });
      expect(getQuantityComparator(denominator)).toBe(comparator);
    }
  });

  it.each([["h", "h", 1], ["hr", "h", 1], ["min", "min", 1], ["day", "d", 1], ["wk", "wk", 1], ["24h", "h", 24]] as const)(
    "retains a compact maximum denominator /%s", (suffix, unit, period) => {
      const parsed = parsePublicSig("Take 5 mL every 2 hours, maximum 10 mL/" + suffix);
      expect(parsed.meta.canonical.clauses[0].schedule?.maxDosePerPeriod)
        .toEqual([{ amount: 10, unit: "mL", period, periodUnit: unit }]);
      expect(parsed.fhir[0].doseAndRate?.[0].doseQuantity).toMatchObject({ value: 5, unit: "mL" });
      expect(parsed.fhir[0].doseAndRate?.[0].rateQuantity).toBeUndefined();
    });

  it("shows a monthly maximum beside independent permitted month days", () => {
    const row: FhirDosage = { asNeeded: true, doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequencyMax: 1, period: 1, periodUnit: FhirPeriodUnit.Month,
        extension: [1, 15].map(day => ({ url: TIMING_DAY_OF_MONTH_EXTENSION_URL, valuePositiveInt: day })) } } };
    for (const input of [row, toDosageDetails([row])]) {
      const text = formatSig(input, "short", { locale: "en", realizationMode: "normalized" });
      expect(text).toContain("<=1x/1mo");
      expect(text).toContain("PRN");
      expect(text).toContain("on days 1 and 15 of each month");
    }
  });
});

describe("round36 complete quantity constituents", () => {
  it.each(["about 1 tablet", "at most 1 tablet", "≤1 tablet", "about half a tablet"])(
    "keeps the clock target for %s", amount => {
      const parsed = parsePublicSig("Take 2 tablets at 08:00 and 20:00 for 3 days, then reduce the 20:00 dose to " + amount);
      const last = parsed.fhirNext.step[1].component;
      expect(last).toHaveLength(2);
      const morning = last.find(row => row.timing?.repeat?.timeOfDay?.includes("08:00:00"))!;
      const evening = last.find(row => row.timing?.repeat?.timeOfDay?.includes("20:00:00"))!;
      expect(morning.doseAndRate?.[0].doseQuantity).toMatchObject({ value: 2, unit: "tab" });
      expect(evening.doseAndRate?.[0].doseQuantity).toMatchObject({ value: amount.includes("half") ? 0.5 : 1, unit: "tab" });
      expect(getQuantityComparator(evening.doseAndRate?.[0].doseQuantity)).toBe(amount.startsWith("about") ? "~" : "<=");
    });

  it.each(["via a peripheral IV", "via an intravenous line", "IV"])(
    "keeps a route determiner separate from the amount: %s", route => {
      const parsed = parsePublicSig("Give " + route + " 500 mL for 2 hours");
      const clause = parsed.meta.canonical.clauses[0];
      expect(clause.dose).toMatchObject({ value: 500, unit: "mL" });
      expect(clause.clinicalQuantity?.administrationDuration).toEqual({ value: 2, unit: "h" });
      expect(clause.route?.code).toBe("47625008");
      for (const row of [parsed.fhir[0], parsed.fhirNext.step[0].component[0]]) {
        expect(row.route?.coding).toContainEqual(expect.objectContaining({
          system: "http://snomed.info/sct", code: "47625008",
        }));
        expect(row.doseAndRate?.[0].rateRatio).toMatchObject({
          numerator: { value: 500, code: "mL" }, denominator: { value: 2, code: "h" }
        });
      }
    });

  it.each([
    ["three quarters of an hour", 0.75, undefined],
    ["about three quarters of an hour", 0.75, "~"],
    ["five quarters of an hour", 1.25, undefined],
    ["0.75 hours", 0.75, undefined], ["2 hours", 2, undefined],
  ] as const)("keeps the drug volume separate from %s", (duration, value, comparator) => {
    const parsed = parsePublicSig("Infuse 100 mL over " + duration);
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.dose).toMatchObject({ value: 100, unit: "mL" });
    expect(clause.clinicalQuantity?.administrationDuration).toEqual({
      value, unit: "h", ...(comparator ? { comparator } : {})
    });
    for (const row of [parsed.fhir[0], parsed.fhirNext.step[0].component[0]]) {
      expect(row.doseAndRate?.[0].doseQuantity).toMatchObject({ value: 100, unit: "mL" });
      expect(row.doseAndRate?.[0].rateRatio?.denominator).toMatchObject({ value, code: "h" });
      expect(getQuantityComparator(row.doseAndRate?.[0].rateRatio?.denominator)).toBe(comparator);
    }
  });

  it("keeps an earlier actual dose from licensing an unrelated maximum as an infusion", () => {
    const parsed = parsePublicSig("Give 5 mL every 2 hours, maximum 10 mL for 1 hour");
    expect(parsed.meta.canonical.clauses[0].dose).toMatchObject({ value: 5, unit: "mL" });
    for (const row of parsed.fhir) for (const dose of row.doseAndRate ?? []) expect(dose.rateRatio).toBeUndefined();
    const temporal = parsePublicSig("Take 1 tablet daily for about one week");
    expect(temporal.meta.canonical.clauses[0].dose).toMatchObject({ value: 1, unit: "tab" });
    expect(temporal.meta.canonical.clauses[0].dose?.comparator).toBeUndefined();
  });
});


describe("round36 authored duration endpoints", () => {
  it.each([false, true])("keeps a qualified occurrence upper bound with carrier=%s", carrier => {
    const parsed = parsePublicSig(carrier ? "Infuse 100 mL over at least 1 hour" : "Apply 1 g");
    let clause = { ...parsed.meta.canonical.clauses[0], schedule: {
      ...parsed.meta.canonical.clauses[0].schedule,
      administrationDuration: 1, administrationDurationMax: 2,
      administrationDurationUnit: FhirPeriodUnit.Hour, administrationDurationComparator: ">=" as const,
    } };
    for (let save = 0; save < 3; save++) {
      const before = JSON.stringify(clause);
      const wire = canonicalToFhir(clause);
      const repeat = wire.timing!.repeat!;
      const marker = repeat.extension!.find(extension => extension.url === TIMING_ADMINISTRATION_DURATION_EXTENSION_URL)!;
      expect(marker.valueRange?.low).toMatchObject({ value: 1, code: "h" });
      expect(getQuantityComparator(marker.valueRange?.low)).toBe(">=");
      expect(marker.valueRange?.high).toMatchObject({ value: 2, code: "h" });
      expect(repeat.duration).toBeUndefined();
      expect(repeat.durationMax).toBeUndefined();
      expect(JSON.stringify(clause)).toBe(before);
      const imported = canonicalFromFhir(wire);
      expect(imported.schedule?.administrationDurationRange).toMatchObject({
        low: { value: 1, code: "h", comparator: ">=" }, high: { value: 2, code: "h" } });
      clause = imported as typeof clause;
    }
  });

  it.each([["day", "days"], ["days", "day"]])(
    "preserves separately authored low=%s and high=%s labels", (lowUnit, highUnit) => {
      let row: FhirDosage = { timing: { repeat: { boundsRange: {
        low: { value: 1, unit: lowUnit, system: "http://unitsofmeasure.org", code: "d" },
        high: { value: 3, unit: highUnit, system: "http://unitsofmeasure.org", code: "d" },
      } } } };
      for (let save = 0; save < 3; save++) {
        const before = JSON.stringify(row);
        const next = canonicalToFhir(canonicalFromFhir(row));
        expect(next.timing?.repeat?.boundsRange).toEqual({
          low: { value: 1, unit: lowUnit, system: "http://unitsofmeasure.org", code: "d" },
          high: { value: 3, unit: highUnit, system: "http://unitsofmeasure.org", code: "d" },
        });
        expect(JSON.stringify(row)).toBe(before);
        row = next;
      }
    });

  it("preserves an authored scalar duration label independently of its UCUM code", () => {
    const row: FhirDosage = { timing: { repeat: { boundsDuration: {
      value: 1, unit: "one authored day", system: "http://unitsofmeasure.org", code: "d",
    } } } };
    expect(canonicalToFhir(canonicalFromFhir(row)).timing?.repeat?.boundsDuration)
      .toEqual(row.timing!.repeat!.boundsDuration);
  });
});

describe("round37 fractional unit complements and event-period limits", () => {
  it.each([
    ["half a", 0.5], ["half of a", 0.5], ["three quarters of a", 0.75],
    ["five quarters of a", 1.25], ["about half a", 0.5], ["a", 1], ["0.5", 0.5],
  ] as const)("retains the full numeric head of %s mL per hour", (amount, value) => {
    const parsed = parsePublicSig("Infuse " + amount + " mL per hour");
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    const q = parsed.meta.canonical.clauses[0].clinicalQuantity;
    expect(q).toMatchObject({ representation: "rate-quantity", status: "resolved",
      numerator: { value, unit: "mL" }, denominators: [{ value: 1, unit: "h", dimension: "time" }] });
    for (const row of [parsed.fhir[0], parsed.fhirNext.step[0].component[0]]) {
      expect(row.doseAndRate?.[0].doseQuantity).toBeUndefined();
      expect(row.doseAndRate?.[0].rateQuantity).toMatchObject({ value, unit: "mL/h" });
      expect(getQuantityComparator(row.doseAndRate?.[0].rateQuantity)).toBe(amount.startsWith("about") ? "~" : undefined);
    }
  });

  it("keeps a fractional volume and a fractional weight rate with their own denominators", () => {
    const volume = parsePublicSig("Infuse half a mL over 1 hour");
    for (const row of [volume.fhir[0], volume.fhirNext.step[0].component[0]]) {
      expect(row.doseAndRate?.[0].doseQuantity).toMatchObject({ value: 0.5, unit: "mL" });
      expect(row.doseAndRate?.[0].rateRatio).toMatchObject({
        numerator: { value: 0.5, unit: "mL" }, denominator: { value: 1, unit: "h" },
      });
    }
    const weight = parsePublicSig("Infuse half a mg per kg per hour");
    expect(weight.meta.canonical.clauses[0].clinicalQuantity).toMatchObject({
      representation: "rate-quantity", numerator: { value: 0.5, unit: "mg" },
      denominators: [{ value: 1, unit: "kg" }, { value: 1, unit: "h" }],
    });
  });

  it.each(["per night", "/night", "/nights", "per 2 nights", "over 2 nights"])(
    "retains %s without inventing a rolling 24-hour maximum", period => {
      const source = "Take 1 tablet at bedtime as needed, max 1 tablet" + (period.startsWith("/") ? "" : " ") + period;
      const parsed = parsePublicSig(source);
      expect(parsed.meta.canonical.clauses[0].dose).toMatchObject({ value: 1, unit: "tab" });
      const schedule = parsed.meta.canonical.clauses[0].schedule;
      expect(schedule?.maxDosePerPeriod).toBeUndefined();
      expect(schedule?.when).toEqual(["HS"]);
      expect(schedule?.duration).toBeUndefined();
      expect(parsed.fhir.every(row => !row.maxDosePerPeriod?.length)).toBe(true);
      for (const input of [parsed, parsed.fhirNext, JSON.parse(JSON.stringify(parsed.fhir))])
        expect(nextDueDoses(input, { orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-01T00:00:00Z",
          timeZone: "UTC", eventClock: { NIGHT: "20:00", HS: "22:00" }, limit: 3 })).toEqual([
          "2026-01-01T22:00:00+00:00", "2026-01-02T22:00:00+00:00", "2026-01-03T22:00:00+00:00",
        ]);
      expect(parsed.longText).toMatch(/max 1 tablet/i);
      expect(parsed.fhir.map(row => row.text).join(" ")).toContain(period);
    });

  it.each([["per day", "d", 1], ["/day", "d", 1], ["per hour", "h", 1], ["/24h", "h", 24]] as const)(
    "retains the declared elapsed maximum %s", (period, unit, value) => {
      const parsed = parsePublicSig("Take 1 tablet as needed, max 2 tablets" + (period.startsWith("/") ? "" : " ") + period);
      expect(parsed.fhir[0].maxDosePerPeriod?.[0]).toMatchObject({
        numerator: { value: 2, unit: "tab" }, denominator: { value, unit },
      });
    });
});


describe("round38 complete authored duration and maximum constituents", () => {
  it.each([".5h", ".5hr", ".5hours", "0.5h", "0.5 h", "~.5h"])(
    "retains the exact or qualified attached infusion duration %s", duration => {
      const parsed = parsePublicSig("Infuse 100 mL/hr for " + duration);
      expect(parsed.meta.canonical.clauses[0].clinicalQuantity?.administrationDuration)
        .toMatchObject({ value: 0.5, unit: "h" });
      for (const input of [parsed.fhirNext, JSON.parse(JSON.stringify(parsed.fhir))]) {
        const recurrence = importCanonicalCourse(input).stages[0].administrations[0].schedule?.recurrence;
        expect(recurrence).toMatchObject({ occurrenceDuration: 0.5, occurrenceDurationUnit: "h" });
        expect(recurrence?.occurrenceDurationComparator).toBe(duration.startsWith("~") ? "~" : undefined);
        expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
          .toContain(duration.startsWith("~") ? "over approximately 0.5 hours" : "over 0.5 hours");
      }
    });

  it.each([["/12h", 12, "h"], ["/24h", 24, "h"], ["/.5h", 0.5, "h"],
    ["/30min", 30, "min"], ["/2wk", 2, "wk"], [" / 12 h", 12, "h"],
    [" per 12 h", 12, "h"], [" in 12 h", 12, "h"], ["/day", 1, "d"]] as const)(
    "keeps the explicit maximum period %s as authored", (period, value, unit) => {
      const parsed = parsePublicSig("Take 1 mg daily, max 10 mg" + period);
      expect(parsed.meta.canonical.clauses[0].schedule?.maxDosePerPeriod)
        .toEqual([{ amount: 10, unit: "mg", period: value, periodUnit: unit }]);
      const r5 = parsed.fhir[0];
      expect(r5.doseAndRate?.[0].doseQuantity).toMatchObject({ value: 1, unit: "mg" });
      expect(r5.doseAndRate?.[0].rateQuantity).toBeUndefined();
      expect(r5.maxDosePerPeriod?.[0]).toMatchObject({
        numerator: { value: 10, unit: "mg" }, denominator: { value, unit }
      });
      const restored = toDosageDetails(JSON.parse(JSON.stringify(parsed.fhir)));
      expect(restored.step[0].component[0].doseAndRate?.[0].doseQuantity).toMatchObject({ value: 1, unit: "mg" });
      expect(restored.step[0].component[0].safety?.doseLimit?.[0]?.period).toMatchObject({ value, unit });
    });

  it.each(["until next morning", "until the next evening", "until next day", "till next morning", "through the next night"])(
    "keeps %s as one visible unresolved ending instruction", ending => {
      const parsed = parsePublicSig("1 tab PO BID " + ending);
      for (const suggestion of [parsed.shortText, parsed.longText]) {
        expect(suggestion.toLowerCase()).toContain(ending);
        expect(suggestion).toContain("BID");
      }
      const row = parsed.fhir[0];
      expect(row.doseAndRate?.[0].doseQuantity).toMatchObject({ value: 1, unit: "tab" });
      expect(row.timing?.repeat).toMatchObject({ frequency: 2, period: 1, periodUnit: "d" });
      expect(row.timing?.repeat?.when).toBeUndefined();
      expect(row.timing?.repeat?.boundsPeriod).toBeUndefined();
      for (const input of [parsed.fhirNext, JSON.parse(JSON.stringify(parsed.fhir))]) {
        const text = formatSig(input, "long", { locale: "en" });
        expect(text.toLowerCase()).toContain(ending);
        expect(text.toLowerCase()).not.toContain("at the next");
      }
    });

  it.each(["Infuse", "Run", "Administer", "Give"])(
    "does not lend %s across a completed volume to a following rate limit", head => {
      const parsed = parsePublicSig(head + " 20 mL over 1 h, no more than 50 mL/hr");
      expect(parsed.fhir[0].doseAndRate?.[0].doseQuantity).toMatchObject({ value: 20, unit: "mL" });
      expect(parsed.fhir[0].doseAndRate?.[0].rateRatio).toMatchObject({
        numerator: { value: 20, unit: "mL" }, denominator: { value: 1, unit: "h" }
      });
      expect(parsed.fhir[0].doseAndRate?.[0].rateQuantity).toBeUndefined();
      expect(parsed.fhir[0].maxDosePerPeriod?.[0]).toMatchObject({
        numerator: { value: 50, unit: "mL" }, denominator: { value: 1, unit: "h" }
      });
      const control = parsePublicSig(head + " no more than 50 mL/hr");
      expect(control.fhir[0].doseAndRate?.[0].rateQuantity).toMatchObject({ value: 50, unit: "mL/h" });
      expect(getQuantityComparator(control.fhir[0].doseAndRate?.[0].rateQuantity)).toBe("<=");
    });
});

describe("round38 independent occurrence duration endpoints", () => {
  it.each([
    [{ value: 90, unit: "min", code: "min" }, { value: 2, unit: "h", code: "h" }, "90 minutes", "2 hours"],
    [{ value: 1, unit: "hour", code: "h", comparator: ">=" }, { value: 120, unit: "minutes", code: "min", comparator: "<" }, "1 hour", "120 minutes"],
    [undefined, { value: 2, unit: "h", code: "h" }, undefined, "2 hours"],
    [{ value: 90, unit: "min", code: "min" }, undefined, "90 minutes", undefined],
  ] as const)("retains every endpoint through R5/current R6 and canonical preview", (low, high, lowText, highText) => {
    let row: FhirDosage = { doseAndRate: [{ rateQuantity: { value: 100, unit: "mL/h" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, extension: [{
        url: TIMING_ADMINISTRATION_DURATION_EXTENSION_URL, id: "duration-range",
        valueRange: { ...(low ? { low: { ...low, id: "low" } } : {}),
          ...(high ? { high: { ...high, id: "high" } } : {}) }
      }] } } };
    for (let pass = 0; pass < 3; pass++) {
      const before = JSON.stringify(row);
      const clause = canonicalFromFhir(row);
      expect(clause.schedule?.administrationDurationRange?.low?.value).toBe(low?.value);
      expect(clause.schedule?.administrationDurationRange?.high?.value).toBe(high?.value);
      const detail = toDosageDetails([row]);
      for (const input of [[row], detail]) {
        const recurrence = importCanonicalCourse(input).stages[0].administrations[0].schedule!.recurrence!;
        expect(recurrence.occurrenceDurationRange?.low?.value).toBe(low?.value);
        expect(recurrence.occurrenceDurationRange?.high?.value).toBe(high?.value);
        expect(recurrence.occurrenceDuration).toBeUndefined();
        const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
        const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
        if (lowText) expect(en).toContain(lowText);
        if (highText) expect(en).toContain(highText);
        if (low) { expect(th).toContain(String(low.value)); expect(recurrence.occurrenceDurationRange?.low?.unit).toBe(low.unit); }
        if (high) { expect(th).toContain(String(high.value)); expect(recurrence.occurrenceDurationRange?.high?.unit).toBe(high.unit); }
      }
      const written = toFhirR5Dosages(detail)[0];
      expect(written.timing?.repeat?.duration).toBeUndefined();
      expect(written.timing?.repeat?.durationMax).toBeUndefined();
      const range = written.timing?.repeat?.extension?.find(item => item.url === TIMING_ADMINISTRATION_DURATION_EXTENSION_URL)?.valueRange;
      for (const side of ["low", "high"] as const) {
        const expected = side === "low" ? low : high;
        expect(range?.[side]?.value).toBe(expected?.value);
        expect(range?.[side]?.unit).toBe(expected?.unit);
        expect(getQuantityComparator(range?.[side])).toBe(expected && "comparator" in expected ? expected.comparator : undefined);
      }
      const clauseWritten = canonicalToFhir(clause);
      expect(clauseWritten.timing?.repeat?.duration).toBeUndefined();
      expect(clauseWritten.timing?.repeat?.extension?.some(item => item.url === TIMING_ADMINISTRATION_DURATION_EXTENSION_URL && item.valueRange)).toBe(true);
      expect(JSON.stringify(row)).toBe(before);
      row = JSON.parse(JSON.stringify(written));
    }
  });
});


it("keeps an explicitly added upper duration endpoint with its authored unit and marker identity", () => {
  const original: FhirDosage = { doseAndRate: [{ rateQuantity: { value: 20, unit: "mL/h" } }],
    timing: { repeat: { extension: [{
      url: TIMING_ADMINISTRATION_DURATION_EXTENSION_URL, id: "authored-duration",
      valueRange: { low: { value: 90, unit: "min", code: "min", id: "minimum" } }
    }] } } };
  let wire = toDosageDetails([original]);
  const repeat = wire.step[0].component[0].timing!.repeat!;
  repeat.durationMax = 2;
  repeat.durationUnit = FhirPeriodUnit.Hour;
  for (let pass = 0; pass < 3; pass++) {
    const recurrence = importCanonicalCourse(wire).stages[0].administrations[0].schedule!.recurrence!;
    expect(recurrence.occurrenceDurationRange).toMatchObject({
      low: { value: 90, unit: "min", code: "min", id: "minimum" },
      high: { value: 2, unit: "h", code: "h" }
    });
    expect(recurrence.occurrenceDuration).toBeUndefined();
    expect(recurrence.occurrenceDurationMax).toBeUndefined();
    const saved = toFhirR5Dosages(wire);
    const marker = saved[0].timing!.repeat!.extension!.find(item => item.url === TIMING_ADMINISTRATION_DURATION_EXTENSION_URL)!;
    expect(marker.id).toBe("authored-duration");
    expect(marker.valueRange?.low).toMatchObject({ value: 90, unit: "min" });
    expect(marker.valueRange?.high).toMatchObject({ value: 2, unit: "h" });
    expect(saved[0].timing!.repeat!.durationMax).toBeUndefined();
    wire = toDosageDetails(JSON.parse(JSON.stringify(saved)));
  }
});


describe("round39 independent delimiters, device sizes and annotated durations", () => {
  it.each(["", " ", "\n        ", "\t\t"])(
    "keeps the spaced maximum period after an independent delimiter (%j)", indent => {
      const parsed = parsePublicSig("Take 1 tablet in the morning;" + indent +
        "Take 1 tablet daily, max 4 tablets / 24 h");
      expect(parsed.meta.canonical.clauses).toHaveLength(2);
      for (const rows of [parsed.fhir, toFhirR5Dosages(parsed.fhirNext),
        toFhirR5Dosages(toDosageDetails(JSON.parse(JSON.stringify(parsed.fhir))))]) {
        expect(rows).toHaveLength(2);
        expect(rows[0].doseAndRate?.[0].doseQuantity).toMatchObject({ value: 1, unit: "tab" });
        expect(rows[0].timing?.repeat?.when).toEqual(["MORN"]);
        expect(rows[1].doseAndRate?.[0].doseQuantity).toMatchObject({ value: 1, unit: "tab" });
        expect(rows[1].timing?.repeat).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
        expect(rows[1].maxDosePerPeriod).toHaveLength(1);
        expect(rows[1].maxDosePerPeriod?.[0]).toMatchObject({
          numerator: { value: 4, unit: "tab" }, denominator: { value: 24, unit: "h" }
        });
      }
    });

  it("keeps an independent slash between complete numeric administrations", () => {
    const parsed = parsePublicSig("Take 1 tablet / 2 tablets in the evening");
    expect(parsed.fhir).toHaveLength(2);
    expect(parsed.fhir[0].doseAndRate?.[0].doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(parsed.fhir[1].doseAndRate?.[0].doseQuantity).toMatchObject({ value: 2, unit: "tab" });
    expect(parsed.fhir[1].timing?.repeat?.when).toEqual(["EVE"]);
  });

  it.each(["Infuse via a 22 gauge IV catheter", "Run via an 18 gauge IV catheter",
    "Administer via an 18 gauge IV catheter", "Infuse via a 22 gauge peripheral IV catheter",
    "Infuse via a 22 gauge peripheral IV catheter at", "Infuse via an IV catheter"])("keeps a device size out of the dose in %s", lead => {
      const source = lead + " 100 mL/hr";
      const parsed = parsePublicSig(source);
      const reopened = toDosageDetails(JSON.parse(JSON.stringify(parsed.fhir)));
      for (const row of [parsed.fhir[0], parsed.fhirNext.step[0].component[0],
        reopened.step[0].component[0]]) {
        expect(row.doseAndRate).toHaveLength(1);
        expect(row.doseAndRate?.[0].rateQuantity).toMatchObject({ value: 100, unit: "mL/h" });
        expect(row.doseAndRate?.[0].doseQuantity).toBeUndefined();
        expect(row.doseAndRate?.[0].doseRange).toBeUndefined();
      }
      expect(parsed.input).toBe(source);
    });

  it.each(["min", "min{infusion}", "min{infusion}{pump}"])(
    "interprets %s without rewriting the authored duration", code => {
      const duration = { id: "prescribed-duration", value: 30, code, unit: "minutes",
        system: "http://unitsofmeasure.org" };
      const row: FhirDosage = { doseAndRate: [{ rateQuantity: { value: 100, unit: "mL/h" } }],
        timing: { repeat: { count: 1, extension: [{
          url: TIMING_ADMINISTRATION_DURATION_EXTENSION_URL, valueQuantity: duration
        }] } } };
      const before = JSON.stringify(row);
      const details = toDosageDetails([row]);
      for (const input of [[row], details, JSON.parse(JSON.stringify(toFhirR5Dosages(details)))]) {
        const recurrence = importCanonicalCourse(input).stages[0].administrations[0].schedule!.recurrence!;
        expect(recurrence).toMatchObject({ occurrenceDuration: 30, occurrenceDurationUnit: "min" });
        expect(calculateTotalUnits({ dosage: input, from: "2026-01-01T00:00:00Z",
          durationValue: 1, durationUnit: "d", timeZone: "UTC" }))
          .toMatchObject({ totalUnits: 50, unit: "mL" });
        expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
          .toContain("over 30 minutes");
        const projected = toFhirR5Dosages(Array.isArray(input) ? toDosageDetails(input) : input);
        expect(projected[0].timing?.repeat?.extension?.find(item =>
          item.url === TIMING_ADMINISTRATION_DURATION_EXTENSION_URL)?.valueQuantity).toEqual(duration);
      }
      expect(JSON.stringify(row)).toBe(before);
    });

  it.each(["unknown{infusion}", "min{infusion}/h"])(
    "retains an unrecognized duration code %s without inventing minutes from its label", code => {
      const duration = { value: 30, code, unit: "minutes", system: "http://unitsofmeasure.org" };
      const row: FhirDosage = { timing: { repeat: { extension: [{
        url: TIMING_ADMINISTRATION_DURATION_EXTENSION_URL, valueQuantity: duration
      }] } } };
      const details = toDosageDetails([row]);
      for (const input of [[row], details]) {
        const recurrence = importCanonicalCourse(input).stages[0].administrations[0].schedule?.recurrence;
        expect(recurrence?.occurrenceDuration).toBeUndefined();
        const projected = toFhirR5Dosages(Array.isArray(input) ? toDosageDetails(input) : input);
        expect(projected[0].timing?.repeat?.extension?.find(item =>
          item.url === TIMING_ADMINISTRATION_DURATION_EXTENSION_URL)?.valueQuantity).toEqual(duration);
      }
    });
});
