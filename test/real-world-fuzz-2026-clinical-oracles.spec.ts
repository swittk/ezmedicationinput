import { describe, expect, it } from "vitest";
import casesJson from "./real-world-fuzz-2026-cases.json";
import expectedJson from "./real-world-fuzz-2026-oracles.json";
import { calculateTotalUnits, getDosageCondition, getDosageAlternativeChoice, nextDueDoses, parseSig } from "../src";

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
  conditionKind?: string; conditionOperation?: string; conditionValue?: number;
  review?: string;
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
      expect(parsed.input).toBe(original.input);

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
      const condition = getDosageCondition(dosage);
      if (oracle.condition !== undefined) expect(Boolean(condition)).toBe(oracle.condition);
      if (oracle.conditionKind !== undefined) expect(condition?.kind).toBe(oracle.conditionKind);
      if (oracle.conditionOperation !== undefined) {
        expect(condition).toMatchObject({ operation: oracle.conditionOperation });
      }
      if (oracle.conditionValue !== undefined) {
        expect(condition).toMatchObject({ value: oracle.conditionValue });
      }

      if (oracle.review) {
        expect(dosage.text).toBeTruthy();
        expect(Boolean(
          dosage.doseAndRate?.length || dosage.timing || dosage.route || dosage.site || dosage.text
        )).toBe(true);
        if (oracle.review === "calendar-start-after-end") {
          expect(repeat?.boundsPeriod).toEqual({
            start: "2026-11-08", end: "2026-11-01"
          });
          expect(() => nextDueDoses(parsed, {
            from: options.from, orderedAt: options.orderedAt,
            timeZone: options.timeZone, limit: 12
          })).toThrow(/end must be after its start/i);
        } else {
          const groups = new Map<string, Set<string>>();
          for (const item of parsed.fhir) {
            const choice = getDosageAlternativeChoice(item);
            if (!choice) continue;
            const branches = groups.get(choice.groupId) ?? new Set<string>();
            branches.add(choice.branchId); groups.set(choice.groupId, branches);
          }
          const scheduleOptions = {
            from: options.from, orderedAt: options.orderedAt,
            timeZone: options.timeZone, limit: 12
          };
          if (groups.size) {
            // An editable OR suggestion is NOT a concurrent regimen. Check
            // the explicit selection path for EVERY branch rather than
            // treating default enumeration of all alternatives as success.
            expect(() => nextDueDoses(parsed, scheduleOptions))
              .toThrow(/alternativeChoices/u);
            const defaults: Record<string, string> = {};
            for (const [group, branches] of groups) defaults[group] = [...branches][0];
            for (const [group, branches] of groups) {
              expect(branches.size).toBeGreaterThan(1);
              for (const branch of branches) {
                expect(nextDueDoses(parsed, {
                  ...scheduleOptions,
                  alternativeChoices: { ...defaults, [group]: branch }
                })).toBeInstanceOf(Array);
              }
            }
            expect(parsed.input).toBe(original.input);
            expect(parsed.fhir.some(item => getDosageAlternativeChoice(item))).toBe(true);
          } else {
            expect(nextDueDoses(parsed, scheduleOptions)).toBeInstanceOf(Array);
          }
        }
      }

      if (oracle.invalidSupply) {
        const result = calculateTotalUnits({ ...options, dosage: parsed });
        expect(result.totalUnits).toBeGreaterThanOrEqual(0);
        expect(result.quantityKind).toBe("maximum");
        if (dosage.maxDosePerPeriod?.length) {
          expect(dosage.maxDosePerPeriod[0].numerator?.value).toBe(0.5);
          expect(result.explanation).toMatch(/retained but could not be applied/i);
        } else {
          expect(repeat?.periodMax).toBeGreaterThan(repeat?.period ?? 0);
          expect(result.explanation).toMatch(/shortest executable period bound/i);
        }
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
