import { describe, expect, it } from "vitest";
import casesJson from "./real-world-fuzz-2026-cases.json";
import expectedJson from "./real-world-fuzz-2026-oracles.json";
import {
  calculateTotalUnits, fromFhirDosage, getDosageCondition,
  getDosageAlternativeChoice, nextDueDoses, parseSig, toFhirR5Dosages
} from "../src";

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


describe("held-out Parkinsonian dose-addition phases", () => {
  it("keeps the new 19:00 dose out of week one, then adds it from week two", () => {
    const input = "Take 1 tablet at 07:00, 11:00 and 15:00 for week 1; add a 19:00 dose from week 2.";
    const parsed = parseSig(input);
    const clocks = (step: number) => [...new Set(
      (parsed.fhirNext.step[step]?.component ?? []).flatMap(c =>
        c.timing?.repeat?.timeOfDay ?? [])
    )].sort();
    expect(parsed.fhirNext.step).toHaveLength(2);
    expect(clocks(0)).toEqual(["07:00:00", "11:00:00", "15:00:00"]);
    expect(clocks(1)).toEqual(["07:00:00", "11:00:00", "15:00:00", "19:00:00"]);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });

  it("adds noon only after the waking/bedtime first-week regimen", () => {
    const input = "Take 1 tablet upon waking and 1 tablet at bedtime for a week, then add a noon dose.";
    const parsed = parseSig(input);
    const events = (step: number) => [...new Set(
      (parsed.fhirNext.step[step]?.component ?? []).flatMap(c =>
        c.timing?.repeat?.when ?? [])
    )].sort();
    expect(parsed.fhirNext.step).toHaveLength(2);
    expect(events(0)).toEqual(["HS", "WAKE"]);
    expect(events(1)).toEqual(["HS", "NOON", "WAKE"]);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });
});


describe("held-out finite Parkinsonian dose/time phase transitions", () => {
  it.each([
    [
      "Take 1 tablet at 08:00, half a tablet at 14:00 and 1 tablet at 20:00 for 7 days, then take 1 tablet at 08:00, 14:00 and 20:00 for 7 days",
      38.5
    ],
    [
      "For 7 days take 1 tablet at 08:00 and 20:00. For the next 7 days, take 1 tablet at 08:00, 14:00 and 20:00",
      35
    ],
    [
      "Take 1 tablet at 08:00 and 20:00 for 7 days, then add half a tablet at 14:00 for 7 days",
      31.5
    ]
  ] as const)("keeps finite sequential and added doses on their proper weeks: %s", (input, expectedUnits) => {
    const parsed = parseSig(input);
    expect(parsed.fhirNext.step).toHaveLength(2);
    const orderedAt = "2026-11-02T00:00:00+07:00";
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(calculateTotalUnits({
        dosage, from: orderedAt, orderedAt, timeZone: "Asia/Bangkok",
        durationValue: 21, durationUnit: "d"
      }).totalUnits).toBe(expectedUnits);
      expect(nextDueDoses(dosage, {
        from: "2026-11-16T00:00:00+07:00",
        orderedAt, timeZone: "Asia/Bangkok", limit: 12
      })).toEqual([]);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });
});


describe("source-scoped multi-daughter course duration", () => {
  it.each([
    ["Take 1 tablet at 08:00, half a tablet at 14:00 and 2 tablets at 20:00 for 7 days.", [1, 0.5, 2], 24.5],
    ["Take 0.5 tablet at 06:00, 1 tablet at 10:00, 1.5 tablets at 14:00 and 2 tablets at 18:00 for 7 days.", [0.5, 1, 1.5, 2], 35]
  ] as const)("shares a final course across every coordinated dose: %s", (input, amounts, total) => {
    const parsed = parseSig(input);
    expect(parsed.fhir.map(d => d.doseAndRate?.[0]?.doseQuantity?.value)).toEqual(amounts);
    for (const row of toFhirR5Dosages(parsed.fhirNext)) {
      expect(row.timing?.repeat?.boundsDuration?.value).toBe(7);
    }
    const orderedAt = "2026-11-02T00:00:00+07:00";
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(calculateTotalUnits({ dosage, orderedAt, from: orderedAt,
        timeZone: "Asia/Bangkok", durationValue: 14, durationUnit: "d" }).totalUnits).toBe(total);
      expect(nextDueDoses(dosage, { orderedAt, from: "2026-11-09T00:00:00+07:00",
        timeZone: "Asia/Bangkok", limit: 8 })).toEqual([]);
    }
  });

  it("keeps explicitly local durations in a comma-delimited dose list", () => {
    const parsed = parseSig("Take 1 tablet at 08:00 for 3 days, half a tablet at 14:00 for 5 days and 2 tablets at 20:00 for 7 days.");
    expect(parsed.fhir.map(d => d.timing?.repeat?.boundsDuration?.value)).toEqual([3, 5, 7]);
  });
});


describe("fronted following-course constituent ownership", () => {
  it.each(["the next 4 days", "next four days", "the following 4 days"])(
    "keeps %s with the succeeding administration", modifier => {
      const input = `For 3 days take 1 tablet at 08:00. For ${modifier}, take 2 tablets at 08:00 and 20:00.`;
      const parsed = parseSig(input);
      expect(parsed.fhirNext.step).toHaveLength(2);
      expect(parsed.fhir.map(d => d.timing?.repeat?.boundsDuration?.value)).toEqual([3, 4]);
      const orderedAt = "2026-11-02T00:00:00+07:00";
      for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
        expect(calculateTotalUnits({ dosage, orderedAt, from: orderedAt, timeZone: "Asia/Bangkok",
          durationValue: 14, durationUnit: "d" }).totalUnits).toBe(19);
        expect(nextDueDoses(dosage, { orderedAt, from: "2026-11-09T00:00:00+07:00",
          timeZone: "Asia/Bangkok", limit: 8 })).toEqual([]);
      }
    }
  );

  it("does not turn ordinary independently headed sentences into a taper", () => {
    const parsed = parseSig("For 7 days take 1 tablet at 08:00. Take 2 tablets at 20:00 for 14 days.");
    const orderedAt = "2026-11-02T00:00:00+07:00";
    expect(calculateTotalUnits({ dosage: parsed.fhirNext, orderedAt, from: orderedAt,
      timeZone: "Asia/Bangkok", durationValue: 14, durationUnit: "d" }).totalUnits).toBe(35);
  });
});


describe("typed daily interval origin composition", () => {
  it("counts the waking origin once across both FHIR representations", () => {
    const input = "Take 1 tablet on waking, then 1 tablet every 4 hours while awake.";
    const parsed = parseSig(input);
    const orderedAt = "2026-11-02T00:00:00+07:00";
    const config = { orderedAt, from: orderedAt, timeZone: "Asia/Bangkok",
      eventClock: { WAKE: "06:30", HS: "22:00" } };
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(nextDueDoses(dosage, { ...config, limit: 4 })).toEqual([
        "2026-11-02T06:30:00+07:00", "2026-11-02T10:30:00+07:00",
        "2026-11-02T14:30:00+07:00", "2026-11-02T18:30:00+07:00"
      ]);
      expect(calculateTotalUnits({ dosage, ...config, durationValue: 21, durationUnit: "d" }).totalUnits).toBe(84);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });

  it("does not absorb a different-sized waking dose", () => {
    const parsed = parseSig("Take 2 tablets on waking, then 1 tablet every 4 hours while awake.");
    expect(parsed.fhir.map(d => d.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([2, 1]);
  });

  it("does not absorb independently headed instructions across a semicolon", () => {
    const parsed = parseSig("Take 1 tablet on waking; take 1 tablet every 4 hours while awake.");
    expect(parsed.fhir).toHaveLength(2);
    expect(parsed.fhir[0].timing?.repeat?.when).toEqual(["WAKE"]);
  });
});


describe("source-typed previous-time phase references", () => {
  it.each(["at the same times", "at those times", "at same times"])(
    "inherits recurrence but not the preceding duration: %s", reference => {
      const input = `Take half a tablet at 07:00 and 19:00 for 7 days; increase to one tablet ${reference} thereafter.`;
      const parsed = parseSig(input);
      expect(parsed.fhir.map(row => row.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([0.5, 1]);
      expect(parsed.fhir.map(row => row.timing?.repeat?.timeOfDay))
        .toEqual([["07:00:00", "19:00:00"], ["07:00:00", "19:00:00"]]);
      expect(parsed.fhir.map(row => row.timing?.repeat?.boundsDuration?.value)).toEqual([7, undefined]);
      expect(parsed.meta.canonical.clauses[1].schedule?.timingReference).toBeUndefined();
      expect(parsed.fhirNext.renderedInstruction).toBe(input);
    }
  );

  it("does not manufacture previous clocks when no predecessor exists", () => {
    const input = "Take 1 tablet at the same times.";
    const parsed = parseSig(input);
    expect(parsed.fhir[0].doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
    expect(parsed.fhir[0].timing?.repeat?.timeOfDay).toBeUndefined();
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });
});


describe("typed phase addition contrasting instructions", () => {
  it("retains the exact standard ADD dosing-fragment coding beside its local predicate", () => {
    const parsed = parseSig("Take 1 tablet daily; do not add an extra tablet at bedtime.");
    const action = parsed.meta.canonical.clauses[0].instructionGraph?.actions
      .find(item => item.predicate.lemma === "add");
    expect(action?.predicate.codings).toEqual(expect.arrayContaining([
      expect.objectContaining({ system: "http://snomed.info/sct", code: "422106007" }),
      expect.objectContaining({ code: "add" })
    ]));
    expect(parsed.fhir[0].timing?.repeat?.when).toBeUndefined();
    // Both the local compositional operator and its verified SNOMED CT
    // dosing-fragment equivalent must survive ordinary FHIR persistence.
    const strictR5 = toFhirR5Dosages(parsed.fhirNext)[0];
    for (const saved of [parsed.fhir[0], strictR5]) {
      const reopened = fromFhirDosage(saved).meta.normalized.instructionGraph?.actions
        .find(frame => frame.predicate.lemma === "add");
      expect(reopened?.predicate.codings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          system: "http://snomed.info/sct",
          code: "422106007"
        }),
        expect.objectContaining({ code: "add" })
      ]));
    }
  });
  it.each([
    "Take 1 tablet daily; do not add an extra tablet at bedtime.",
    "Take 1 tablet daily; never add a bedtime dose."
  ])("does not execute a prohibited addition: %s", input => {
    const parsed = parseSig(input);
    expect(parsed.fhir).toHaveLength(1);
    expect(parsed.fhir[0].doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
    expect(parsed.fhir[0].timing?.repeat?.frequency).toBe(1);
    expect(parsed.fhir[0].timing?.repeat?.when).toBeUndefined();
    expect(parsed.longText.toLowerCase()).toMatch(/do not add|never add/);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });

  it("never guesses an omitted added dose from unequal predecessor amounts", () => {
    const input = "Take half a tablet in the morning and one tablet at bedtime for 7 days, then add a noon dose.";
    const parsed = parseSig(input);
    const noon = parsed.fhir.filter(row => row.timing?.repeat?.when?.indexOf("NOON") !== -1 && row.timing?.repeat?.when);
    expect(noon.every(row => row.doseAndRate?.[0]?.doseQuantity?.value === undefined)).toBe(true);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });

  it("does not carry old administrations into an explicit replacement", () => {
    const parsed = parseSig("Take 1 tablet daily for 7 days, then take half a tablet at noon for 7 days.");
    expect(parsed.fhirNext.step.map(step => step.component.length)).toEqual([1, 1]);
    expect(parsed.fhirNext.step[1].component[0].doseAndRate?.[0]?.doseQuantity?.value).toBe(0.5);
  });
});
