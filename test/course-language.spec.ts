/** Course language is a facet of the existing localization registry, not
 * another clinical engine. Independent oracles cover both built-in surfaces
 * and a third-language extension without editing canonical semantics. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { registerSigLocalization, resolveSigLocalization } from "../src/i18n";
import { formatSigBatch, setDosageAlternativeChoice } from "../src/index";
import type { FhirDosage } from "../src/types";
import { ENGLISH_COURSE } from "../src/locales/course/en";
import { DAY_NAMES, joinWithAnd } from "../src/format";
import { DAY_NAMES_THAI, joinWithAndThai } from "../src/i18n";
import { ENGLISH_DAY_NAMES, THAI_DAY_NAMES, joinLocalizedList } from "../src/locales/course/weekday-vocabulary";

import {
  formatCanonicalCourse,
  formatCanonicalAdministration,
  appendMedicationConditionText,
  appendMedicationExcludedWeekdaysText,
} from "../src/canonical/format-course";
import type { CanonicalCourse } from "../src/canonical/course";

// Day-number wording is valid only for an explicitly local-day origin.
const boundaries: CanonicalCourse = {
  kind: "course",
  cycleInterval: { value: 7, unit: "d" },
  stages: [
    {
      start: { anchor: "treatment-day-start", displacement: { value: 0, unit: "d" } },
      end: { anchor: "treatment-day-start", displacement: { value: 3, unit: "d" } },
      administrations: [
        {
          kind: "administration",
          amounts: [{ quantity: { value: 2, unit: "tab" } }],
          schedule: { recurrence: { frequency: 1, period: 1, periodUnit: "d" } },
        },
      ],
    },
  ],
};

describe("dependency-free course vocabulary", () => {
  it("reuses the historical weekday tables without a circular locale-registry dependency", () => {
    expect(DAY_NAMES).toBe(ENGLISH_DAY_NAMES);
    expect(DAY_NAMES_THAI).toBe(THAI_DAY_NAMES);
    for (const name of ["en", "th"]) {
      const moduleText = readFileSync(new URL("../src/locales/course/" + name + ".ts", import.meta.url), "utf8");
      expect(moduleText).not.toMatch(/from\s+["']\.\.\/\.\.\/(?:i18n|format)["']/u);
      expect(moduleText).toContain('from "./weekday-vocabulary"');
    }
  });
  it("retains original 0/1/2/3+ list join behavior without slicing arrays", () => {
    const items = ["Monday", "Tuesday", "Wednesday", "Thursday"];
    expect(joinWithAnd([])).toBe("");
    expect(joinWithAnd(items.slice(0, 1))).toBe("Monday");
    expect(joinWithAnd(items.slice(0, 2))).toBe("Monday and Tuesday");
    expect(joinWithAnd(items.slice(0, 3))).toBe("Monday, Tuesday and Wednesday");
    expect(joinWithAnd(items)).toBe("Monday, Tuesday, Wednesday and Thursday");
    expect(joinWithAndThai(items.slice(0, 3))).toBe("Monday, Tuesday และ Wednesday");
    expect(joinLocalizedList(items, "ou")).toBe("Monday, Tuesday, Wednesday ou Thursday");
  });
});

describe("course locale boundary", () => {
  it("keeps built-in clinical windows, gaps and repeat periods exact in EN and TH", () => {
    const en = formatCanonicalCourse(boundaries, "long", { locale: "en" });
    const th = formatCanonicalCourse(boundaries, "long", { locale: "th" });
    expect(en).toContain("Days 1–3:");
    expect(en).toContain("No doses on days 4–7.");
    expect(en).toContain("Repeat this schedule every 7 days");
    expect(th).toContain("วันที่ 1–3:");
    expect(th).toContain("งดยาในวันที่ 4–7.");
    expect(th).toContain("ทำซ้ำแผนการใช้ยานี้ทุก 7 วัน");
  });
  it("preserves Boolean grouping and the distinction between a negated state and an outer unless", () => {
    const guard = {
      kind: "all" as const,
      conditions: [
        { kind: "state" as const, name: "awake", expected: false },
        {
          kind: "any" as const,
          conditions: [
            { kind: "measurement" as const, name: "SBP", operation: "gt" as const, value: 100 },
            { kind: "measurement" as const, name: "HR", operation: "lt" as const, value: 90 },
          ],
        },
      ],
    };
    expect(appendMedicationConditionText("Take 1 tablet.", guard, { locale: "en" })).toBe(
      "Take 1 tablet only if not awake and (SBP > 100 or HR < 90)."
    );
    expect(appendMedicationConditionText("รับประทาน 1 เม็ด.", guard, { locale: "th" })).toBe(
      "รับประทาน 1 เม็ด เฉพาะเมื่อ ไม่ awake และ (SBP > 100 หรือ HR < 90)."
    );
    const outerUnless = { kind: "not" as const, condition: guard };
    expect(appendMedicationConditionText("Take 1 tablet.", outerUnless, { locale: "en" })).toBe(
      "Take 1 tablet unless not awake and (SBP > 100 or HR < 90)."
    );
    expect(appendMedicationConditionText("รับประทาน 1 เม็ด.", outerUnless, { locale: "th" })).toBe(
      "รับประทาน 1 เม็ด เว้นแต่ ไม่ awake และ (SBP > 100 หรือ HR < 90)."
    );
  });
  it("adds a third language through the same registration including clauses, stages, rates and conditions", () => {
    registerSigLocalization({
      locale: "course-test",
      formatLong: () => "Dose locale.",
      formatShort: () => "Dose locale.",
      course: {
        ...ENGLISH_COURSE,
        dayRange: (a, b) => `Jours ${a}–${b}`,
        noDoseDays: (a, b) => `Pause ${a}–${b}.`,
        timeUnit: (unit) => (unit === "d" ? "jours" : unit),
        repeatCycle: (interval) => `Répéter ${interval}.`,
        rateLabel: "Débit: ",
        unspecified: "non spécifié",
        onlyIf: "si",
        notPrefix: "non ",
        allSeparator: " et ",
        anySeparator: " ou ",
      },
    });
    const text = formatCanonicalCourse(boundaries, "long", { locale: "course-test" });
    expect(text).toContain("Jours 1–3: Dose locale.");
    expect(text).toContain("Pause 4–7.");
    expect(text).toContain("Répéter 7 jours.");
    expect(text).not.toContain("Days");
    expect(
      formatCanonicalAdministration(
        { kind: "administration", amounts: [{ rate: { unit: "mL/h" } }] },
        "long",
        { locale: "course-test" }
      )
    ).toContain("Débit: non spécifié mL/h");
    expect(
      appendMedicationConditionText(
        "Dose.",
        { kind: "state", name: "awake", expected: false },
        { locale: "course-test" }
      )
    ).toBe("Dose si non awake.");
    // The same inheritance configuration applies to course and clause facets.
    expect(
      formatCanonicalCourse(boundaries, "long", {
        i18n: { inherit: "course-test", locale: "course-derived" },
      })
    ).toContain("Jours 1–3");
  });
  it("applies per-call inheritance to public R5 choices and standalone course wording", () => {
    const inherited = {
      ...ENGLISH_COURSE,
      choicePrefix: "Sélection: ",
      anySeparator: " ou ",
      exceptWeekdays: "sauf ",
      weekdayName: () => "lundi",
      joinList: (items: readonly string[]) => items.join(" et "),
    };
    registerSigLocalization({
      locale: "choice-inherit",
      formatLong: ({ clause }) => "Dose " + clause.dose?.value + ".",
      course: inherited,
    });
    const rows: FhirDosage[] = [1, 2].map(value => ({
      doseAndRate: [{ doseQuantity: { value, unit: "tab" } }],
    }));
    for (let i = 0; i < rows.length; i++)
      setDosageAlternativeChoice(rows[i], {
        groupId: "one-choice",
        branchId: String(i),
        selectionBehavior: "exactly-one",
      });
    const options = { i18n: { locale: "unregistered-output-tag", inherit: "choice-inherit" } };
    expect(formatSigBatch(rows, "long", options)).toBe("Sélection: Dose 1 ou Dose 2.");
    expect(appendMedicationExcludedWeekdaysText("Dose.", ["mon"], options)).toBe("Dose sauf lundi.");
  });
  it("keeps a course-only override even when no clause callbacks are registered", () => {
    registerSigLocalization({ locale: "course-only", course: ENGLISH_COURSE });
    const course = { ...ENGLISH_COURSE, onlyIf: "provided that" };
    expect(resolveSigLocalization("course-only", { course })?.course).toBe(course);
    expect(
      appendMedicationConditionText(
        "Dose.",
        { kind: "state", name: "awake", expected: true },
        { locale: "course-only", i18n: { course } }
      )
    ).toBe("Dose provided that awake.");
  });
  it("does not resolve or interpret language in the clinical course algorithm", () => {
    const source = readFileSync(new URL("../src/canonical/format-course.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/(?:startsWith|indexOf)\(["']th["']\)|\bthai\s*\?/u);
    expect(source).not.toMatch(/[ก-๙]/u);
    expect(resolveSigLocalization("th")?.course).toBeDefined();
  });
});


describe("round 28 complete-value locale facets", () => {
  it("passes a complete count and period to a suffix-language upper-bound template", () => {
    registerSigLocalization({
      locale: "course-suffix-bound",
      formatLong: () => "Dose locale.",
      course: { ...ENGLISH_COURSE, upTo: value => value + "以下" }
    });
    const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [{
      kind: "administration",
      amounts: [{ quantity: { value: 1, unit: "tab" } }],
      schedule: { recurrence: { frequencyMax: 2, periodMax: 3, periodUnit: "d",
        startOffset: { value: 1, unit: "h" } } }
    }] }] };
    const text = formatCanonicalCourse(course, "long", { locale: "course-suffix-bound" });
    expect(text).toContain("2以下 administrations per 3 days以下");
    expect(text).not.toMatch(/以下2|以下3/);
  });

  it("does not assert a global pause by comparing elapsed and civil origins", () => {
    const mixed: CanonicalCourse = { kind: "course", stages: [
      { start: { anchor: "treatment-start", displacement: { value: 0, unit: "d" } },
        end: { anchor: "treatment-start", displacement: { value: 2, unit: "d" } },
        administrations: [{ kind: "administration", amounts: [{ quantity: { value: 1, unit: "tab" } }] }] },
      { start: { anchor: "treatment-day-start", displacement: { value: 4, unit: "d" } },
        end: { anchor: "treatment-day-start", displacement: { value: 6, unit: "d" } },
        administrations: [{ kind: "administration", amounts: [{ quantity: { value: 2, unit: "tab" } }] }] }
    ] };
    const text = formatCanonicalCourse(mixed, "long", { locale: "en" });
    expect(text).toContain("From treatment start until 2 days after treatment start");
    expect(text).toContain("Days 5–6");
    expect(text).not.toContain("No doses");
  });
});


describe("round 28 origin-aware member and ranged windows", () => {
  it("renders an executable local-day member without a review warning", () => {
    const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [
      { kind: "administration", phaseStart: { anchor: "treatment-day-start",
          displacement: { value: 4, code: "d" } },
        amounts: [{ quantity: { value: 1, unit: "tab" } }] }
    ] }] };
    const en = formatCanonicalCourse(course, "long", { locale: "en" });
    const th = formatCanonicalCourse(course, "long", { locale: "th" });
    expect(en).toContain("From day 5 onward");
    expect(en).not.toContain("requires review");
    expect(th).toContain("ตั้งแต่วันที่ 5 เป็นต้นไป");
    expect(th).not.toContain("ต้องตรวจสอบ");
  });

  it("keeps an elapsed member floor visible inside an equal-number local-day stage", () => {
    const course: CanonicalCourse = { kind: "course", stages: [{
      start: { anchor: "treatment-day-start", displacement: { value: 4, code: "d" } },
      end: { anchor: "treatment-day-start", displacement: { value: 6, code: "d" } },
      administrations: [{ kind: "administration", phaseOrigin: { value: 4, code: "d" },
        amounts: [{ quantity: { value: 1, unit: "tab" } }] }]
    }] };
    const text = formatCanonicalCourse(course, "long", { locale: "en" });
    expect(text).toContain("Days 5–6");
    expect(text).toContain("From 4 days after treatment start onward");
  });

  it("uses the same local-day origin for scalar and ranged sides of a window", () => {
    const course: CanonicalCourse = { kind: "course", stages: [{
      start: { anchor: "treatment-day-start", displacement: { value: 4, code: "d" } },
      end: { anchor: "treatment-day-start",
        displacementRange: { low: { value: 6, code: "d" }, high: { value: 8, code: "d" } } },
      administrations: [{ kind: "administration", amounts: [{ quantity: { value: 1, unit: "tab" } }] }]
    }] };
    const text = formatCanonicalCourse(course, "long", { locale: "en" });
    expect(text).toContain("From 4 days after the start of the first treatment day until 6 days – 8 days after the start of the first treatment day");
    expect(text).not.toContain("4 days after treatment start");
    // The known leading gap is still exact; the ranged end licenses no
    // invented trailing pause.
    expect(text).toContain("No doses on days 1–4.");
    expect(text.match(/No doses/g)).toHaveLength(1);
  });
});


it("uses locale-owned measurement labels with live values and retained old source text", () => {
  const condition = { kind: "measurement" as const, name: "bp", operation: "gt" as const,
    value: 150, text: "BP > 160" };
  const source = JSON.stringify(condition);
  expect(appendMedicationConditionText("Dose.", condition, { locale: "en" })).toBe("Dose only if BP > 150.");
  expect(appendMedicationConditionText("ยา.", condition, { locale: "th" })).toBe("ยา เฉพาะเมื่อ BP > 150.");
  expect(JSON.stringify(condition)).toBe(source);
  expect(appendMedicationConditionText("Dose.", { ...condition, name: "custom pressure" }, { locale: "en" }))
    .toBe("Dose only if custom pressure > 150.");
});
