import { describe, expect, it } from "vitest";
import casesJson from "./real-world-fuzz-2026-cases.json";
import expectedJson from "./real-world-fuzz-2026-oracles.json";
import { calculateTotalUnits, getDosageCondition, nextDueDoses, parseSig } from "../src";

interface FuzzCase { id: string; category: string; input: string }
interface Oracle {
  dose?: number; unit?: string;
  rate?: number; rateUnit?: string;
  frequency?: number; frequencyMax?: number;
  period?: number; periodMax?: number; periodUnit?: string;
  duration?: number; durationLow?: number; durationHigh?: number;
  administrationDuration?: boolean;
  rows?: number; countMax?: number;
  route?: string; site?: string;
  prn?: boolean; condition?: boolean;
  unresolved?: string;
  invalidSupply?: boolean; maxSupply?: number; threeDaySupply?: number;
}
const cases = new Map((casesJson as FuzzCase[]).map(item => [item.id, item]));
const oracles = expectedJson as Record<string, Oracle>;
const options = {
  from: "2026-10-22T08:00:00+07:00",
  orderedAt: "2026-10-22T08:00:00+07:00",
  timeZone: "Asia/Bangkok",
  durationValue: 3,
  durationUnit: "d" as const
};

describe("manually specified clinical semantic oracles for the independent 200-case real-world corpus", () => {
  it("has at least 100 independently authored clinical expectations, every ID unique", () => {
    expect(Object.keys(oracles).length).toBeGreaterThanOrEqual(100);
    for (const id in oracles) expect(cases.has(id)).toBe(true);
  });

  for (const [id, oracle] of Object.entries(oracles)) {
    const original = cases.get(id)!;
    it(id + " — " + original.input, () => {
      const parsed = parseSig(original.input, {
        locale: original.category === "thai" ? "th" : "en",
        datePolicy: { referenceDate: "2026-10-22" }
      });
      const dosage = parsed.fhir[0];
      const entries = dosage?.doseAndRate?.[0];
      const repeat = dosage?.timing?.repeat;

      if (oracle.rows !== undefined) expect(parsed.fhir).toHaveLength(oracle.rows);
      if (oracle.dose !== undefined) expect(entries?.doseQuantity?.value).toBeCloseTo(oracle.dose, 8);
      if (oracle.unit !== undefined) expect(entries?.doseQuantity?.unit).toBe(oracle.unit);
      if (oracle.rate !== undefined) expect(entries?.rateQuantity?.value).toBeCloseTo(oracle.rate, 8);
      if (oracle.rateUnit !== undefined) expect(entries?.rateQuantity?.unit).toBe(oracle.rateUnit);
      if (oracle.frequency !== undefined) expect(repeat?.frequency).toBe(oracle.frequency);
      if (oracle.frequencyMax !== undefined) expect(repeat?.frequencyMax).toBe(oracle.frequencyMax);
      if (oracle.period !== undefined) expect(repeat?.period).toBe(oracle.period);
      if (oracle.periodMax !== undefined) expect(repeat?.periodMax).toBe(oracle.periodMax);
      if (oracle.periodUnit !== undefined) expect(repeat?.periodUnit).toBe(oracle.periodUnit);
      if (oracle.countMax !== undefined) expect(repeat?.countMax).toBe(oracle.countMax);
      if (oracle.duration !== undefined) {
        if (oracle.administrationDuration) expect(repeat?.duration).toBe(oracle.duration);
        else expect(repeat?.boundsDuration?.value).toBe(oracle.duration);
      }
      if (oracle.administrationDuration) {
        expect(repeat?.duration).toBeGreaterThan(0);
        expect(repeat?.durationUnit).toBeDefined();
      }
      if (oracle.durationLow !== undefined) expect(repeat?.boundsRange?.low?.value).toBe(oracle.durationLow);
      if (oracle.durationHigh !== undefined) expect(repeat?.boundsRange?.high?.value).toBe(oracle.durationHigh);
      if (oracle.route) expect(dosage.route?.text?.toLowerCase()).toContain(oracle.route.toLowerCase());
      if (oracle.site) expect(dosage.site?.text?.toLowerCase()).toContain(oracle.site.toLowerCase());
      if (oracle.prn !== undefined) expect(Boolean(dosage.asNeeded)).toBe(oracle.prn);
      if (oracle.condition !== undefined) expect(Boolean(getDosageCondition(dosage))).toBe(oracle.condition);

      if (oracle.unresolved) {
        expect(parsed.warnings.some(warning => warning.includes(oracle.unresolved))).toBe(true);
        expect(() => nextDueDoses(parsed, {
          from: options.from, orderedAt: options.orderedAt,
          timeZone: options.timeZone, limit: 12
        })).toThrow(/unresolved/i);
      }

      if (oracle.invalidSupply) {
        expect(() => calculateTotalUnits({ ...options, dosage: parsed })).toThrow();
      }
      if (oracle.maxSupply !== undefined) {
        const supply = calculateTotalUnits({ ...options, dosage: parsed });
        expect(supply.totalUnits).toBeCloseTo(oracle.maxSupply, 8);
        expect(supply.quantityKind).toBe("maximum");
      }
      if (oracle.threeDaySupply !== undefined) {
        expect(calculateTotalUnits({ ...options, dosage: parsed }).totalUnits)
          .toBeCloseTo(oracle.threeDaySupply, 8);
      }
    });
  }
});
