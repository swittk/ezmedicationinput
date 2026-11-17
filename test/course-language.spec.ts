/** Course language is a facet of the existing localization registry, not
 * another clinical engine. Independent oracles cover both built-in surfaces
 * and a third-language extension without editing canonical semantics. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { registerSigLocalization, resolveSigLocalization } from "../src/i18n";
import { formatSigBatch, setDosageAlternativeChoice } from "../src/index";
import type { FhirDosage } from "../src/types";
import { ENGLISH_COURSE } from "../src/locales/course/en";
import {
  formatCanonicalCourse,
  formatCanonicalAdministration,
  appendMedicationConditionText,
  appendMedicationExcludedWeekdaysText,
} from "../src/canonical/format-course";
import type { CanonicalCourse } from "../src/canonical/course";

const boundaries: CanonicalCourse = {
  kind: "course",
  cycleInterval: { value: 7, unit: "d" },
  stages: [
    {
      start: { anchor: "treatment-start", displacement: { value: 0, unit: "d" } },
      end: { anchor: "treatment-start", displacement: { value: 3, unit: "d" } },
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
      formatLong: () => "Dose locale.",
      course: inherited,
    });
    const rows: FhirDosage[] = [{ text: "First dose" }, { text: "Second dose" }];
    for (let i = 0; i < rows.length; i++)
      setDosageAlternativeChoice(rows[i], {
        groupId: "one-choice",
        branchId: String(i),
        selectionBehavior: "exactly-one",
      });
    const options = { i18n: { locale: "unregistered-output-tag", inherit: "choice-inherit" } };
    expect(formatSigBatch(rows, "long", options)).toBe("Sélection: Dose locale ou Dose locale.");
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
