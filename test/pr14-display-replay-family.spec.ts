import { describe, expect, it } from "vitest";
import { formatCanonicalCourse, formatSig, parseSig, fromFhir } from "../src/index";
import { courseFromR6 } from "../src/adapters/canonical-course";
import { dosageMatchesSavedProjection, withDosageEditProvenance } from "../src/dosage-course";
import { registerMedicationLocaleDetector, inferMedicationLocale } from "../src/locale-detection";
import { registerSigLocalization } from "../src/i18n";
import { ENGLISH_COURSE } from "../src/locales/course/en";
import { EventTiming, FhirPeriodUnit, FhirDayOfWeek } from "../src/types";
import type { FhirDosage, FhirR6Dosage, FhirR6DosageInstruction, FhirR6DoseLimit } from "../src/types";

const tablet: FhirR6Dosage = {
  doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
  timing: { repeat: { frequency: 4, period: 1, periodUnit: FhirPeriodUnit.Day } },
};
const daily = { value: 1, unit: "d" };

describe("source-less limit wording retains value and ownership", () => {
  it("shows an integer period cap alongside the four-times-daily instruction", () => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      ...tablet, safety: { doseLimit: [{ scope: "period", valueInteger: 2, period: daily }] },
    }] }] };
    const course = courseFromR6(raw);
    const text = formatCanonicalCourse(course, "long", { locale: "en" });
    expect(text).toContain("four times daily");
    expect(text).toContain("max per period: 2 administrations / 1 d");
    expect(course.stages[0].administrations[0].limits?.[0].count).toBe(2);
    expect(fromFhir(raw, { locale: "en" }).longText)
      .toContain("max per period: 2 administrations / 1 d");
  });

  it.each(["period", "administration", "dosage", "lifetime"] as const)(
    "retains the %s scope for quantity, integer and unevaluated expression limits",
    (scope) => {
      const limits: FhirR6DoseLimit[] = [
        { scope, valueQuantity: { value: 8, unit: "tab" }, ...(scope === "period" ? { period: daily } : {}) },
        { scope, valueInteger: 2, ...(scope === "period" ? { period: daily } : {}) },
        { scope, valueExpression: { language: "text/fhirpath", expression: "weight * 2" },
          ...(scope === "period" ? { period: daily } : {}) },
      ];
      const course = courseFromR6({ step: [{ component: [{ ...tablet, safety: { doseLimit: limits } }] }] });
      const text = formatCanonicalCourse(course, "long", { locale: "en" });
      const label = scope === "period" ? "max per period:" :
        scope === "administration" ? "max per administration:" :
        scope === "dosage" ? "max per dosage:" : "max lifetime:";
      expect(text).toContain(label + " 8 tab");
      expect(text).toContain(label + " 2 administrations");
      expect(text).toContain(label + " unevaluated dose expression: weight * 2");
    },
  );

  it("shows a course-wide quantity cap exactly once for a simple course", () => {
    const course = courseFromR6({
      safety: { doseLimit: [{ scope: "period", valueQuantity: { value: 8, unit: "tab" }, period: daily }] },
      step: [{ component: [tablet] }],
    });
    const text = formatCanonicalCourse(course, "long", { locale: "en" });
    expect(text).toContain("Across this course: max per period: 8 tab / 1 d");
    expect(text.split("8 tab").length - 1).toBe(1);
    expect(course.stages[0].administrations[0].limits).toBeUndefined();
  });

  it("keeps course and stage caps outside member wording in a multi-stage plan", () => {
    const course = courseFromR6({
      safety: { doseLimit: [{ scope: "lifetime", valueInteger: 12 }] },
      step: [
        { component: [tablet, tablet], safety: {
          doseLimit: [{ scope: "period", valueInteger: 2, period: daily }],
        } },
        { component: [tablet] },
      ],
    });
    const text = formatCanonicalCourse(course, "long", { locale: "en" });
    expect(text).toContain("Within this stage: max per period: 2 administrations / 1 d");
    expect(text).toContain("Across this course: max lifetime: 12 administrations");
    expect(text.split("max per period:").length - 1).toBe(1);
    expect(text.split("max lifetime:").length - 1).toBe(1);
  });

  it("keeps the new scope labels and counts behind the existing locale facet", () => {
    registerSigLocalization({
      locale: "limit-family",
      formatLong: () => "Dose locale.",
      course: { ...ENGLISH_COURSE,
        courseLimitsLabel: "Cours: ", stageLimitsLabel: "Étape: ",
        maxPeriodLabel: "Plafond: ", administrations: (value) => value + " prises",
      },
    });
    const course = courseFromR6({
      safety: { doseLimit: [{ scope: "period", valueInteger: 2, period: daily }] },
      step: [{ component: [tablet] }],
    });
    expect(formatCanonicalCourse(course, "long", { locale: "limit-family" }))
      .toContain("Cours: Plafond: 2 prises / 1 d");
    expect(formatCanonicalCourse(course, "long", { locale: "th" }))
      .toContain("ตลอดแผนการใช้ยานี้: max per period: ให้ยา 2 ครั้ง / 1 d");
  });
});

describe("partial explicit calendar events remain visible", () => {
  it("retains year/month precision without fabricating a full date", () => {
    const course = courseFromR6({ step: [{ component: [{
      doseAndRate: tablet.doseAndRate,
      timing: { event: ["2026", "2026-11", "2026-11-20"] },
    }] }] });
    expect(formatCanonicalCourse(course, "long", { locale: "en" }))
      .toContain("Scheduled events: 2026, 2026-11");
    expect(formatCanonicalCourse(course, "long", { locale: "th" }))
      .toContain("วันที่กำหนด: 2026 และ 2026-11");
    for (const locale of ["en", "th"]) {
      const text = formatCanonicalCourse(course, "long", { locale });
      expect(text).not.toMatch(/2026-00|2026-11-00|2026-00-00/u);
      expect(text).not.toContain("NaN");
    }
    expect(course.stages[0].administrations[0].schedule?.explicitEvents)
      .toEqual(["2026", "2026-11", "2026-11-20"]);
  });
});

function savedRow(): FhirDosage {
  const row: FhirDosage = {
    doseAndRate: [{ doseQuantity: { value: 1, unit: "tab", code: "tab", system: "urn:unit" } }],
    timing: {
      event: ["2026-11-20T08:00:00Z", "2026-11-21T08:00:00Z"],
      code: { text: "BID", coding: [{ code: "BID", system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation" }] },
      repeat: {
        frequency: 1, frequencyMax: 2, period: 1, periodMax: 2,
        periodUnit: FhirPeriodUnit.Day, count: 3, countMax: 4,
        duration: 1, durationMax: 2, durationUnit: FhirPeriodUnit.Hour,
        dayOfWeek: [FhirDayOfWeek.Monday, FhirDayOfWeek.Wednesday], timeOfDay: ["08:00:00", "20:00:00"],
        when: [EventTiming["Before Breakfast"], EventTiming["Before Dinner"]], offset: 15,
        boundsDuration: { value: 7, unit: "d" },
      },
    },
  };
  return withDosageEditProvenance([row], "Original source")[0];
}
describe("saved R5 source replay observes all live timing values", () => {
  const edits: Array<[string, (row: FhirDosage) => void]> = [
    ["later clock", row => { row.timing!.repeat!.timeOfDay![1] = "22:00:00"; }],
    ["later weekday", row => { row.timing!.repeat!.dayOfWeek![1] = FhirDayOfWeek.Friday; }],
    ["later event", row => { row.timing!.event![1] = "2026-11-22T08:00:00Z"; }],
    ["later meal anchor", row => { row.timing!.repeat!.when![1] = EventTiming["After Dinner"]; }],
    ["timing abbreviation", row => { row.timing!.code!.coding![0].code = "TID"; }],
    ["timing description", row => { row.timing!.code!.text = "three times daily"; }],
    ["frequency maximum", row => { row.timing!.repeat!.frequencyMax = 3; }],
    ["period maximum", row => { row.timing!.repeat!.periodMax = 3; }],
    ["period unit", row => { row.timing!.repeat!.periodUnit = FhirPeriodUnit.Week; }],
    ["count maximum", row => { row.timing!.repeat!.countMax = 5; }],
    ["duration", row => { row.timing!.repeat!.duration = 2; }],
    ["duration maximum", row => { row.timing!.repeat!.durationMax = 3; }],
    ["duration unit", row => { row.timing!.repeat!.durationUnit = FhirPeriodUnit.Minute; }],
    ["meal offset", row => { row.timing!.repeat!.offset = 30; }],
    ["course length", row => { row.timing!.repeat!.boundsDuration!.value = 14; }],
    ["dose unit system", row => { row.doseAndRate![0].doseQuantity!.system = "urn:other-unit"; }],
  ];
  it.each(edits)("invalidates replay after changing the %s in place", (_, edit) => {
    const row = savedRow();
    expect(dosageMatchesSavedProjection(row)).toBe(true);
    edit(row);
    expect(dosageMatchesSavedProjection(row)).toBe(false);
  });

  it.each(["fresh", "persisted"] as const)(
    "invalidates the %s authored Thai source after editing its second clock", (kind) => {
    const source = "ล้างมือก่อนหยอดตา หยอดตาขวา 1 หยด เวลา 08:00 และ 20:00 แล้วหลับตา";
    const parsed = parseSig(source, { locale: "th" });
    const row = kind === "fresh" ? parsed.items[0].fhir
      : JSON.parse(JSON.stringify(parsed.fhir[0])) as FhirDosage;
    const options = { locale: "th", realizationMode: "roundtrip" as const };
    expect(formatSig(row, "long", options)).toBe(source);
    row.timing!.repeat!.timeOfDay![1] = "22:00:00";
    const edited = formatSig(row, "long", options);
    expect(edited).toContain("22:00");
    expect(edited).not.toContain("20:00");
    expect(edited).toContain("1 หยด");
    row.timing!.repeat!.timeOfDay![1] = "20:00:00";
    expect(formatSig(row, "long", options)).toBe(source);
  });

  it("does not replay BID source after a code-only R5 schedule is edited to TID", () => {
    const source = "ล้างมือก่อนหยอดตา หยอดตาขวา 1 หยด bid แล้วหลับตา";
    const parsed = structuredClone(parseSig(source, { locale: "th" }).fhir[0]);
    // A code-only Timing is valid R5. Keep this fixture free of an intentionally
    // contradictory old numeric frequency so the expected new cadence is clear.
    delete parsed.timing!.repeat;
    const row = withDosageEditProvenance([parsed], source)[0];
    const options = { locale: "th", realizationMode: "roundtrip" as const };
    expect(formatSig(row, "long", options)).toBe(source);
    row.timing!.code!.coding![0].code = "TID";
    row.timing!.code!.text = "TID";
    const edited = formatSig(row, "long", options);
    expect(edited).not.toBe(source);
    expect(edited).toContain("3 ครั้ง");
    expect(edited).not.toContain("bid");
  });

  it("shows the changed second clock through the public formatter and allows restoration", () => {
    const row = JSON.parse(JSON.stringify(parseSig("Take 1 tablet at 08:00 and 20:00").items[0].fhir));
    const options = { locale: "en", realizationMode: "roundtrip" as const };
    const original = formatSig(row, "long", options);
    row.timing.repeat.timeOfDay[1] = "22:00:00";
    expect(formatSig(row, "long", options)).toContain("10:00 pm");
    expect(formatSig(row, "long", options)).not.toContain("8:00 pm");
    row.timing.repeat.timeOfDay[1] = "20:00:00";
    expect(formatSig(row, "long", options)).toBe(original);
  });
});

describe("locale detector registration has stable provider identity", () => {
  it("retains the registered snapshot while allowing an explicit replacement", () => {
    const detector = { locale: "aa", priority: 10, test: (value: string) => value === "__locale_aa__" };
    registerMedicationLocaleDetector(detector);
    detector.locale = "bb";
    detector.test = value => value === "__locale_changed__";
    expect(inferMedicationLocale("__locale_aa__")).toBe("aa");
    expect(inferMedicationLocale("__locale_changed__", "fallback")).toBe("fallback");
    registerMedicationLocaleDetector({ locale: "cc", priority: 20, test: value => value === "__locale_cc__" });
    registerMedicationLocaleDetector({ locale: "aa", priority: 30, test: value => value === "__locale_aa_new__" });
    expect(inferMedicationLocale("__locale_cc__")).toBe("cc");
    expect(inferMedicationLocale("__locale_aa_new__")).toBe("aa");
    expect(inferMedicationLocale("__locale_changed__", "fallback")).toBe("fallback");
  });
});
