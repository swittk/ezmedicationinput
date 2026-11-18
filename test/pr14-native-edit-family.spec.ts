import { describe, expect, it } from "vitest";
import { parseSig, editCanonicalCourse, formatSig, nextDueDoses, calculateTotalUnits, toDosageDetails } from "../src/index";
import { courseFromR6, courseToR5, courseToR6, inputToCanonical } from "../src/adapters/canonical-course";
import { clauseForAdministration, courseFromAdministrations } from "../src/canonical/compile";
import { FhirPeriodUnit, type FhirR6DosageInstruction } from "../src/types";
import { EMA_QUANTITY_COMPARATOR_EXTENSION_URL, EMA_QUANTITY_OPERATOR_SYSTEM, getQuantityComparator } from "../src/fhir-quantity-operator";
import { TIMING_EVENT_CALENDAR_SOURCE_EXTENSION_URL } from "../src/fhir";
import type { CanonicalAdministration, CanonicalCourse, CanonicalScheduleInput } from "../src/canonical/course";

const asCourse = (input: CanonicalScheduleInput): CanonicalCourse => {
  if (Array.isArray(input)) return { kind: "course", stages: [{ administrations: input }] };
  return input.kind === "course" ? input : { kind: "course", stages: [{ administrations: [input] }] };
};
const member = (input: CanonicalScheduleInput) => asCourse(input).stages[0].administrations[0];

describe("live native edits govern retained source families", () => {
  it("removes modeled limit fields while retaining source identity through both projections", () => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      safety: { doseLimit: [{ id: "limit-original", scope: "period",
        valueQuantity: { value: 4, unit: "tab" }, period: { value: 1, unit: "d" },
        text: "old daily limit", extension: [{ url: "urn:test:limit-note", valueString: "keep" }] }] }
    }] }] };
    const before = courseFromR6(raw, true);
    const after = editCanonicalCourse(before, draft => {
      const limit = member(draft).limits![0];
      limit.scope = "administration";
      delete limit.period;
      delete limit.text;
      limit.amount = { value: 2, unit: "tab" };
    });
    for (const projected of [courseToR6(after), courseToR6(asCourse(inputToCanonical(courseToR5(after))))]) {
      const limit = projected.step[0].component[0].safety!.doseLimit![0];
      expect(limit).toMatchObject({ id: "limit-original", scope: "administration", valueQuantity: { value: 2, unit: "tab" },
        extension: [{ url: "urn:test:limit-note", valueString: "keep" }] });
      expect(limit).not.toHaveProperty("period");
      expect(limit).not.toHaveProperty("text");
    }
    expect(raw.step[0].component[0].safety!.doseLimit![0].text).toBe("old daily limit");
  });

  it("compiles additional instructions and applies replacements and removals to syntax-backed members", () => {
    const before = parseSig("Take 1 tablet daily. Do not drive").meta.canonical.course!;
    expect(member(before).additionalInstructions).toEqual([{ text: "Do not drive" }]);
    const replaced = editCanonicalCourse(before, draft => {
      member(draft).additionalInstructions = [{ text: "Avoid alcohol", coding: [{ system: "urn:test:advice", code: "alcohol" }] }];
    });
    const removed = editCanonicalCourse(before, draft => { delete member(draft).additionalInstructions; });
    for (const projected of [courseToR5(replaced)[0], courseToR6(replaced).step[0].component[0]]) {
      expect(projected.additionalInstruction).toEqual([{ text: "Avoid alcohol", coding: [{ system: "urn:test:advice", code: "alcohol" }] }]);
    }
    for (const projected of [courseToR5(removed)[0], courseToR6(removed).step[0].component[0]]) {
      expect(projected.additionalInstruction).toBeUndefined();
    }
    expect(formatSig(replaced, "long", { locale: "en" })).toContain("Avoid alcohol");
    expect(formatSig(replaced, "long", { locale: "en" })).not.toMatch(/drive/i);
    expect(formatSig(removed, "long", { locale: "en" })).not.toMatch(/drive/i);
    expect(member(before).syntax!.additionalInstructions![0].text).toBe("Do not drive");
  });

  it("preserves an edited approximate rate denominator on strict R5 reimport", () => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ id: "rate-original", rateRatio: {
        numerator: { value: 100, unit: "mL", comparator: "~" },
        denominator: { value: 1, unit: "h", id: "duration-original",
          extension: [{ url: "urn:test:duration-note", valueString: "keep" }] }
      } }]
    }] }] };
    const before = courseFromR6(raw, true);
    const after = editCanonicalCourse(before, draft => { member(draft).amounts![0].rateRatio!.denominator!.value = 2; });
    const projected = courseToR5(after);
    expect(projected[0].doseAndRate![0].rateRatio!.denominator!.value).toBe(2);
    const ratio = member(inputToCanonical(projected)).amounts![0].rateRatio!;
    expect(ratio.numerator).toMatchObject({ value: 100, unit: "mL", comparator: "~" });
    expect(ratio.denominator).toMatchObject({ value: 2, unit: "h", id: "duration-original",
      extension: [{ url: "urn:test:duration-note", valueString: "keep" }] });
    expect(raw.step[0].component[0].doseAndRate![0].rateRatio!.denominator!.value).toBe(1);
  });

  it.each(["2026-11-21", "2026-11-21T09:30:00.500+07:00"])("renders and projects the live calendar event %s", value => {
    const before = parseSig("Take 1 tablet on 20/11/2569").meta.canonical.course!;
    const after = editCanonicalCourse(before, draft => { member(draft).schedule!.explicitEvents = [value]; });
    const view = clauseForAdministration(member(after));
    expect(view.schedule!.calendarEvents![0]).toMatchObject({ isoDate: "2026-11-21", calendar: "gregory", calendarYear: 2026, month: 11, day: 21 });
    expect(formatSig(after, "long", { locale: "en" })).toContain("21 Nov 2026");
    expect(formatSig(after, "long", { locale: "en" })).not.toContain("20 Nov");
    for (const row of [courseToR5(after)[0], courseToR6(after).step[0].component[0]]) {
      expect(row.timing!.event).toEqual([value]);
      expect(JSON.stringify(row.timing!._event)).not.toContain("20/11/2569");
    }
    expect(member(before).syntax!.schedule!.calendarEvents![0].calendarYear).toBe(2569);
  });

  it("clears removed calendar events instead of reusing source dates", () => {
    const before = parseSig("Take 1 tablet on 20/11/2026").meta.canonical.course!;
    const after = editCanonicalCourse(before, draft => { delete member(draft).schedule!.explicitEvents; });
    expect(clauseForAdministration(member(after)).schedule!.calendarEvents).toBeUndefined();
    expect(formatSig(after, "long", { locale: "en" })).not.toContain("20 Nov");
    expect(courseToR5(after)[0].timing!.event).toBeUndefined();
  });

  it("keeps seven days of dosing after a shared two-day stage delay", () => {
    const dose = (value: number): CanonicalAdministration => ({ kind: "administration",
      delayMinutes: 2 * 1440, amounts: [{ quantity: { value, unit: "tab" } }],
      schedule: { recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        courseLength: { value: 7, unit: "d" } } } });
    const after = courseFromAdministrations([dose(1), dose(2)], "");
    expect(after.stages[0].start!.displacement).toMatchObject({ value: 2, unit: "d" });
    expect(after.stages[0].end).toBeUndefined();
    const options = { from: "2026-01-01T00:00:00Z", orderedAt: "2026-01-01T00:00:00Z",
      timeZone: "UTC", durationValue: 14, durationUnit: FhirPeriodUnit.Day };
    for (const input of [after, courseToR6(after), courseToR5(after)]) {
      expect(calculateTotalUnits({ ...options, dosage: input }).totalUnits).toBe(21);
      const due = nextDueDoses(input, { ...options, limit: 20 });
      expect(due).toHaveLength(14);
      expect(due[0]).toContain("2026-01-03");
      expect(due[13]).toContain("2026-01-09");
    }
  });
  it("does not resurrect a removed safety policy or removed course-wide limits", () => {
    const raw: FhirR6DosageInstruction = {
      safety: { id: "course-policy", ifExceeded: "review", doseLimit: [{
        scope: "lifetime", valueQuantity: { value: 30, unit: "tab" },
      }] },
      step: [{ component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        safety: { id: "member-policy", ifExceeded: "old advice", doseLimit: [{
          scope: "administration", valueQuantity: { value: 2, unit: "tab" },
        }] } }] }],
    };
    const after = editCanonicalCourse(courseFromR6(raw, true), draft => {
      delete draft.safety!.limits;
      delete member(draft).safety;
    });
    for (const projected of [courseToR6(after), courseToR6(asCourse(inputToCanonical(courseToR5(after))))]) {
      expect(projected.safety).toMatchObject({ id: "course-policy", ifExceeded: "review" });
      expect(projected.safety).not.toHaveProperty("doseLimit");
      expect(projected.step[0].component[0].safety).toMatchObject({ id: "member-policy",
        doseLimit: [{ scope: "administration", valueQuantity: { value: 2, unit: "tab" } }] });
      expect(projected.step[0].component[0].safety).not.toHaveProperty("ifExceeded");
    }
  });

  it.each(["r5", "r6"] as const)("updates imported %s calendar annotations without dropping unrelated metadata", version => {
    const parsed = parseSig("Take 1 tablet on 20/11/2569").meta.canonical.course!;
    const row = courseToR6(parsed);
    const primitive = row.step[0].component[0].timing!._event![0]!;
    primitive.id = "event-identity";
    primitive.extension!.push({ url: "urn:test:event-note", valueString: "keep" });
    const before = version === "r6" ? courseFromR6(row, true) : asCourse(inputToCanonical(courseToR5(courseFromR6(row, true))));
    const after = editCanonicalCourse(before, draft => {
      member(draft).schedule!.explicitEvents = ["2026-11-21"];
    });
    for (const projected of [courseToR6(after).step[0].component[0], courseToR5(after)[0]]) {
      expect(projected.timing!.event).toEqual(["2026-11-21"]);
      expect(projected.timing!._event![0]).toMatchObject({ id: "event-identity",
        extension: [{ url: "urn:test:event-note", valueString: "keep" }] });
      expect(projected.timing!._event![0]!.extension!.some(e => e.url === TIMING_EVENT_CALENDAR_SOURCE_EXTENSION_URL)).toBe(false);
    }
    expect(formatSig(after, "long", { locale: "en" })).toContain("21 Nov 2026");
  });

  it("reuses calendar provenance for unchanged and reordered dates", () => {
    const before = parseSig("Take 1 tablet on 20/11/2569 and 21/11/2569").meta.canonical.course!;
    const original = member(before).syntax!.schedule!.calendarEvents!;
    const unchanged = clauseForAdministration(member(before)).schedule!.calendarEvents!;
    expect(unchanged).toBe(original);
    const reordered = editCanonicalCourse(before, draft => member(draft).schedule!.explicitEvents!.reverse());
    const view = clauseForAdministration(member(reordered)).schedule!.calendarEvents!;
    expect(view.map(e => e.isoDate)).toEqual(["2026-11-21", "2026-11-20"]);
    expect(view.map(e => e.calendarYear)).toEqual([2569, 2569]);
    expect(view.map(e => e.sourceText)).toEqual([original[1].sourceText, original[0].sourceText]);
  });

  it.each(["2026", "2026-11", "date to be arranged"])("retains partial or unresolved event %s without inventing date parts", value => {
    const before = parseSig("Take 1 tablet on 20/11/2026").meta.canonical.course!;
    const after = editCanonicalCourse(before, draft => { member(draft).schedule!.explicitEvents = [value]; });
    expect(clauseForAdministration(member(after)).schedule!.calendarEvents).toBeUndefined();
    expect(courseToR6(after).step[0].component[0].timing!.event).toEqual([value]);
    expect(courseToR5(after)[0].timing!.event).toEqual([value]);
    expect(member(after).schedule!.explicitEvents).toEqual([value]);
  });

  it("does not restore a removed source timing code over current recurrence", () => {
    const before = parseSig("1 tab BID").meta.canonical.course!;
    expect(member(before).syntax!.schedule!.timingCode).toBe("BID");
    const after = editCanonicalCourse(before, draft => {
      delete member(draft).schedule!.code;
      member(draft).schedule!.recurrence!.frequency = 3;
    });
    expect(clauseForAdministration(member(after)).schedule!.timingCode).toBeUndefined();
    for (const projected of [courseToR5(after)[0], courseToR6(after).step[0].component[0]]) {
      expect(projected.timing!.code).toBeUndefined();
      expect(projected.timing!.repeat!.frequency).toBe(3);
    }
    expect(formatSig(after, "long", { locale: "en" })).toContain("three times daily");
  });

  it("retains the derived unshifted stage end and avoids one for a qualified duration", () => {
    const dose = (): CanonicalAdministration => ({ kind: "administration",
      amounts: [{ quantity: { value: 1, unit: "tab" } }],
      schedule: { recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        courseLength: { value: 7, unit: "d" } } } });
    const first = dose(), second = dose();
    expect(courseFromAdministrations([first, second], "").stages[0].end!.displacement).toMatchObject({ value: 7, unit: "d" });
    first.schedule!.recurrence!.courseLength!.comparator = "~";
    second.schedule!.recurrence!.courseLength!.comparator = "~";
    expect(courseFromAdministrations([first, second], "").stages[0].end).toBeUndefined();
  });

  it("retains distinct primitive metadata on duplicate dates when another event changes", () => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { event: ["2026-11-20", "2026-11-20", "2026-11-22"],
        _event: [{ id: "first" }, { id: "second" }, { id: "third" }] },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
    }] }] };
    const after = editCanonicalCourse(courseFromR6(raw, true), draft => {
      member(draft).schedule!.explicitEvents![2] = "2026-11-23";
    });
    for (const projected of [courseToR6(after).step[0].component[0], courseToR5(after)[0]])
      expect(projected.timing!._event!.map(e => e?.id)).toEqual(["first", "second", "third"]);
  });

  it.each([
    [{ value: 500, system: "http://unitsofmeasure.org", code: "mg" }, "mg", "500 mg"],
    [{ value: 2, system: "http://standardterms.edqm.eu", code: "15054000" }, "tab", "2 tablets"],
    [{ value: 1, system: "urn:test:units", code: "custom-unit" }, "custom-unit", "custom-unit"],
  ] as const)("retains a code-only scalar dose unit in generated wording", (quantity, expectedUnit, wording) => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: [{ doseQuantity: quantity }] }] }] };
    const course = courseFromR6(raw, true);
    expect(clauseForAdministration(member(course)).dose!.unit).toBe(expectedUnit);
    expect(formatSig(course, "long", { locale: "en" })).toContain(wording);
    expect(courseToR6(course).step[0].component[0].doseAndRate![0].doseQuantity).toEqual(quantity);
  });

  it("retains a code-only range unit and honors an authored scalar display unit", () => {
    const course = courseFromR6({ step: [{ component: [{ doseAndRate: [{ doseRange: {
      low: { value: 500, system: "http://unitsofmeasure.org", code: "mg" },
      high: { value: 1000, system: "http://unitsofmeasure.org", code: "mg" },
    } }] }] }] }, true);
    expect(clauseForAdministration(member(course)).dose).toEqual({ range: { low: 500, high: 1000 }, unit: "mg" });
    expect(formatSig(course, "long", { locale: "en" })).toMatch(/500.*1000.*mg/);
    const authored = editCanonicalCourse(course, draft => {
      member(draft).amounts = [{ quantity: { value: 500, unit: "milligrams", system: "http://unitsofmeasure.org", code: "mg" } }];
    });
    expect(clauseForAdministration(member(authored)).dose!.unit).toBe("milligrams");
  });

  it.each(["coded", "authored"] as const)("preserves independent %s units on a mixed-unit dose range", kind => {
    const range = kind === "coded" ? {
      low: { value: 500, system: "http://unitsofmeasure.org", code: "mg" },
      high: { value: 1, system: "http://unitsofmeasure.org", code: "g" },
    } : { low: { value: 500, unit: "mg" }, high: { value: 1, unit: "g" } };
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseRange: range }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
    }] }] };
    const course = courseFromR6(raw, true);
    const rendered = formatSig(course, "long", { locale: "en" });
    expect(rendered).toContain("500 mg – 1 g");
    expect(rendered).not.toMatch(/500[–-]1 mg/);
    expect(rendered).toContain("once daily");
    expect(courseToR6(course).step[0].component[0].doseAndRate![0].doseRange).toEqual(range);
  });

  it("retains independent endpoint comparators without duplicating the range across stages", () => {
    const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [{
      kind: "administration", amounts: [{ range: {
        low: { value: 500, unit: "mg", comparator: ">=" },
        high: { value: 1000, unit: "mg", comparator: "<=" },
      } }], schedule: { recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
    }] }, { administrations: [{
      kind: "administration", amounts: [{ quantity: { value: 250, unit: "mg" } }],
    }] }] };
    const rendered = formatSig(course, "long", { locale: "en" });
    expect(rendered).toContain(">=500–<=1000 mg");
    expect(rendered.split(">=500–<=1000 mg")).toHaveLength(2);
    expect(rendered).not.toMatch(/(?<!>=)500[–-]1000 mg/);
    expect(member(course).amounts![0].range!.high!.comparator).toBe("<=");
  });

  it.each(["native", "extension"] as const)("retains an edited qualified denominator's %s representation and unknown metadata", representation => {
    const note = { url: "urn:test:duration-note", valueString: "keep" };
    const operator = (code: string) => ({ url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code } });
    // Imported source is preserved permissively, including older direct
    // denominator comparators. Strict R5 output still uses SimpleQuantity.
    const raw = { step: [{ component: [{ doseAndRate: [{ rateRatio: {
      numerator: { value: 100, unit: "mL", comparator: "~" },
      denominator: { value: 1, unit: "h", id: "duration-original",
        ...(representation === "native"
          ? { comparator: ">=", extension: [note] }
          : { extension: [operator("100000000053"), note] }) },
    } }] }] }] } as unknown as FhirR6DosageInstruction;
    const after = editCanonicalCourse(courseFromR6(raw, true), draft => {
      const denominator = member(draft).amounts![0].rateRatio!.denominator!;
      denominator.value = 2;
      denominator.comparator = "<=";
    });
    const r5 = courseToR5(after);
    expect(r5[0].doseAndRate![0].rateRatio!.denominator).not.toHaveProperty("comparator");
    expect(getQuantityComparator(r5[0].doseAndRate![0].rateRatio!.denominator)).toBe("<=");
    const restored = toDosageDetails(r5).step[0].component[0].doseAndRate![0].rateRatio!.denominator;
    expect(restored).toEqual({ value: 2, unit: "h", id: "duration-original",
      ...(representation === "native"
        ? { comparator: "<=", extension: [note] }
        : { extension: [operator("100000000052"), note] }) });
  });

});
