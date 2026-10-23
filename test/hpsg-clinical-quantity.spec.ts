import { describe, expect, it } from "vitest";
import { parseClauseState } from "../src/parser";
import { canonicalToFhir } from "../src/fhir";
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
