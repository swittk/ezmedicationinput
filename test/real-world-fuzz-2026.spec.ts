import { describe, expect, it } from "vitest";
import casesJson from "./real-world-fuzz-2026-cases.json";
import {
  calculateTotalUnits,
  lintSig,
  nextDueDoses,
  parseSig,
  toFhirR5Dosages
} from "../src";
import type { FhirDosage, FhirR6DosageDetails, ParseBatchResult } from "../src";

interface FuzzCase { id: string; category: string; input: string }
const cases = casesJson as FuzzCase[];
const anchor = "2026-10-22T08:00:00+07:00";
const options = {
  from: anchor,
  orderedAt: anchor,
  timeZone: "Asia/Bangkok",
  limit: 12
} as const;
type ScheduleInput = FhirDosage | readonly FhirDosage[] | FhirR6DosageDetails | ParseBatchResult;

function executable(input: ScheduleInput) {
  let next: string[] | string, supply: number | string, kind: string | undefined;
  try { next = nextDueDoses(input, options); }
  catch (error) { next = "ERROR:" + String((error as Error).message); }
  try {
    const result = calculateTotalUnits({
      ...options, dosage: input,
      durationValue: 3, durationUnit: "d"
    });
    supply = result.totalUnits;
    kind = result.quantityKind;
  } catch (error) { supply = "ERROR:" + String((error as Error).message); }
  return { next, supply, kind };
}

describe("200 adversarial real-world-inspired SIGs — consistency, not clinical certification", () => {
  it("contains 20 distinct cases in each of ten clinical categories", () => {
    expect(cases).toHaveLength(200);
    expect(new Set(cases.map(value => value.id)).size).toBe(200);
    expect(new Set(cases.map(value => value.input)).size).toBe(200);
    const counts = new Map<string, number>();
    for (const item of cases)
      counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
    expect([...counts.values()]).toHaveLength(10);
    expect([...counts.values()].every(count => count === 20)).toBe(true);
  });

  for (const item of cases) {
    it(item.id + ": " + item.input, () => {
      const parseOptions = {
        locale: item.category === "thai" ? "th" as const : "en" as const,
        datePolicy: { referenceDate: "2026-10-22" }
      };
      const parsed = parseSig(item.input, parseOptions);
      const linted = lintSig(item.input, parseOptions);
      expect(parsed.items.length).toBeGreaterThan(0);
      expect(parsed.fhir.length).toBeGreaterThan(0);
      expect(parsed.input).toBe(item.input);
      expect(linted.items.length).toBeGreaterThan(0);
      for (const dosage of parsed.fhir) {
        for (const dose of dosage.doseAndRate ?? []) {
          for (const quantity of [dose.doseQuantity, dose.rateQuantity]) {
            if (quantity?.value !== undefined) {
              expect(Number.isFinite(quantity.value)).toBe(true);
              expect(quantity.value).toBeGreaterThan(0);
            }
          }
        }
        const repeat = dosage.timing?.repeat;
        for (const clock of repeat?.timeOfDay ?? []) {
          expect(clock).toMatch(/^\d{2}:\d{2}(?::\d{2})?$/u);
        }
        if (repeat?.when?.length && repeat.timeOfDay?.length) {
          expect(nextDueDoses(dosage, options).length).toBeGreaterThan(0);
        }
      }
      const first = executable(parsed);
      const other = [
        executable(parsed.fhir),
        executable(parsed.fhirNext),
        executable(toFhirR5Dosages(parsed.fhirNext))
      ];
      for (const actual of other) expect(actual).toEqual(first);
    });
  }
});
