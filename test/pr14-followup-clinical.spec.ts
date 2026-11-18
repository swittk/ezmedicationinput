/**
 * November 18 review: preserve clinical meaning through repeated-course
 * chronology and through a clinician's live R5 dose edits.
 * These are independent oracles, not roundtrips of the same broken output.
 */
import { describe, expect, it } from "vitest";
import {
  calculateTotalUnits, formatSig, nextDueDoses, parseSig,
  EMA_QUANTITY_COMPARATOR_EXTENSION_URL, EMA_QUANTITY_OPERATOR_SYSTEM
} from "../src/index";
import { formatCanonicalClause } from "../src/format";
import { resolveSigLocalization } from "../src/i18n";
import { instructionGraphSourceConflictsWithDose } from "../src/instruction-graph";
import { FhirPeriodUnit } from "../src/types";

const from = "2026-01-01T00:00:00Z";
const options = { from, orderedAt: from, timeZone: "UTC" } as const;

describe("repeated-course clinical chronology", () => {
  it("completes an uncapped finite loading stage before an overlapping capped maintenance stage", () => {
    const course = {
      kind: "course" as const,
      cycleInterval: { value: 7, unit: "d" },
      stages: [
        {
          administrations: [{
            kind: "administration" as const,
            amounts: [{ quantity: { value: 2, unit: "tab" } }],
            schedule: { recurrence: {
              count: 1,
              frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
              clocks: ["08:00:00"]
            } }
          }]
        },
        {
          administrations: [{
            kind: "administration" as const,
            amounts: [{ quantity: { value: 1, unit: "tab" } }],
            schedule: { recurrence: {
              frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
              clocks: ["09:00:00"],
              courseLength: { value: 10, unit: "d" },
            } },
            limits: [{scope: "period" as const,
              amount: {value: 2, unit: "tab"}, period: {value: 1, unit: "d"}}],
          }]
        }
      ]
    };
    const due = nextDueDoses(course, { ...options, limit: 20 });
    expect(due).toContain("2026-01-01T08:00:00+00:00");
    expect(due).toContain("2026-01-02T09:00:00+00:00");
    expect(due.some(value => value.startsWith("2026-01-04"))).toBe(true);
    const supply = calculateTotalUnits({
      ...options, dosage: course, durationValue: 5, durationUnit: FhirPeriodUnit.Day
    });
    expect(supply.totalUnits).toBeGreaterThan(2);
    // A partially stated cap is preserved for review but cannot impose
    // shared chronological acceptance; the uncapped loading stage must
    // still finish before maintenance starts.
    const incomplete = {
      ...course,
      stages: [
        {
          ...course.stages[0],
          administrations: course.stages[0].administrations.map(a => ({
            ...a,
            limits: [{
              scope: "period" as const,
              amount: { value: 2, unit: "tab" },
              period: { unit: "d" }
            }]
          })),
        },
        course.stages[1],
      ]
    };
    expect(nextDueDoses(incomplete, { ...options, limit: 20 }))
      .toContain("2026-01-02T09:00:00+00:00");
  });

  it("counts two genuinely accepted administrations at one time across overlapping daily cycles", () => {
    const course = {
      kind: "course" as const,
      cycleInterval: { value: 1, unit: "d" },
      stages: [{
        administrations: [{
          kind: "administration" as const,
          amounts: [{quantity: {value: 1, unit: "tab"}}],
          schedule: {recurrence: {
            frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
            clocks: ["00:00:00"], courseLength: {value: 2, unit: "d"}
          }},
          limits: [{
            scope: "period" as const,
            amount: {value: 2, unit: "tab"},
            period: {value: 1, unit: "d"}
          }]
        }]
      }]
    };
    const due = nextDueDoses(course, {...options, limit: 5});
    expect(due).toEqual([
      "2026-01-01T00:00:00+00:00",
      "2026-01-02T00:00:00+00:00",
      "2026-01-02T00:00:00+00:00",
      "2026-01-03T00:00:00+00:00",
      "2026-01-03T00:00:00+00:00",
    ]);
    const supply = calculateTotalUnits({
      ...options, dosage: course, durationValue: 3, durationUnit: FhirPeriodUnit.Day,
    });
    expect(supply.totalUnits).toBe(5);
  });
});

describe("R5 source dose identity after live edits", () => {
  it("does not reuse an HPSG dose's source text after an in-place edit of its original parser row", () => {
    const source = "ล้างมือก่อนหยอดตา หยอดตาขวา 1 หยด แล้วหลับตา";
    const row = parseSig(source, { locale: "th" }).items[0].fhir;
    const display = () => formatSig(row, "long", { locale: "th", realizationMode: "roundtrip" });
    expect(display()).toBe(source);
    const dose = row.doseAndRate?.[0]?.doseQuantity;
    expect(dose?.value).toBe(1);
    dose!.value = 2;
    expect(display()).not.toBe(source);
    expect(display()).toMatch(/(?:2|สอง)/u);
    dose!.value = 1;
    expect(display()).toBe(source);
    const originalUnit = dose!.unit, originalCode = dose!.code;
    dose!.unit = "tab";
    dose!.code = "15054";
    expect(display()).not.toBe(source);
    expect(display()).toContain("เม็ด");
    dose!.unit = originalUnit;
    dose!.code = originalCode;
    expect(display()).toBe(source);
    const originalExtensions = dose!.extension;
    dose!.extension = [{
      url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000055" }
    }];
    expect(display()).not.toBe(source);
    expect(display()).toContain("ประมาณ");
    dose!.extension = originalExtensions;
    expect(display()).toBe(source);
  });

  it("treats a changed defaulted amount as a live dose while keeping the original default source", () => {
    const source = "Mix with water then swallow";
    const parsed = parseSig(source, {
      assumeSingleDiscreteDose: true,
      context: { dosageForm: "tablet" }
    });
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.dose).toMatchObject({value: 1, defaulted: true});
    expect(clause.instructionGraph?.actions.length).toBeGreaterThan(0);
    const original = formatCanonicalClause(
      clause, "long", resolveSigLocalization("en"), {realizationMode: "roundtrip"}
    );
    expect(original).toBe(source);
    const changed = { ...clause, dose: { ...clause.dose!, value: 2 } };
    expect(instructionGraphSourceConflictsWithDose(changed)).toBe(true);
    const text = formatCanonicalClause(
      changed, "long", resolveSigLocalization("en"), {realizationMode: "roundtrip"}
    );
    expect(text).not.toBe(original);
    expect(text).toMatch(/(?:2|two)/iu);
    const changedUnit = { ...clause, dose: { ...clause.dose!, unit: "drop" } };
    expect(instructionGraphSourceConflictsWithDose(changedUnit)).toBe(true);
    const changedUnitText = formatCanonicalClause(
      changedUnit, "long", resolveSigLocalization("en"), { realizationMode: "roundtrip" }
    );
    expect(changedUnitText).not.toBe(source);
    expect(changedUnitText).toMatch(/drop/iu);
  });
});
