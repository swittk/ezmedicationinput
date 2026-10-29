import { describe, expect, it } from "vitest";
import { parseClauseSign, parseClauseState } from "../src/parser";
import { projectHpsgSignToState } from "../src/hpsg/projection";
import { canonicalFromFhir, canonicalToFhir, parserStateFromFhir } from "../src/fhir";
import {
  calculateTotalUnits,
  parseInstructionActions,
  getDosageCondition,
  nextDueDoses,
  formatSig,
  parseSig as parsePublicSig,
  toDosageDetails,
  toFhirR5Dosages
} from "../src/index";
import { parseSig } from "./helpers/r5-parser";
import { EventTiming, FhirPeriodUnit, type FhirDosage } from "../src/types";
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
