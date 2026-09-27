import { describe, expect, it, vi } from "vitest";
import {
  findMedicationDateListSpans,
  formatSig,
  listMedicationDateResolvers,
  fromFhirDosage,
  nextDueDoses,
  parseSig,
  registerMedicationDateResolver
} from "../src/index";

const REFERENCE_DATE = "2026-09-27";

describe("calendar date interpretation", () => {
  it("parses mixed Thai/English Buddhist shorthand dates then transitions to weekly Sunday", () => {
    const input =
      "take orally 1 tablet after meal at after breakfast on 28/9/69 และ 1,4/10/69 จากนั้น ทุกวันอาทิตย์";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T06:00:00Z"));
    let result: ReturnType<typeof parseSig>;
    try {
      result = parseSig(input);
    } finally {
      vi.useRealTimers();
    }

    expect(result.count).toBe(2);
    expect(result.meta.segments.map((segment) => segment.text)).toEqual([
      "take orally 1 tablet after meal at after breakfast on 28/9/69 และ 1,4/10/69",
      "ทุกวันอาทิตย์"
    ]);

    const dated = result.items[0];
    expect(dated.meta.leftoverText).toBeUndefined();
    expect(dated.fhir.site).toBeUndefined();
    expect(dated.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(dated.fhir.timing?.event).toEqual([
      "2026-09-28",
      "2026-10-01",
      "2026-10-04"
    ]);
    expect(dated.fhir.timing?.repeat?.when).toEqual(["PCM"]);
    expect(dated.meta.canonical.clauses[0]?.schedule?.calendarEvents).toEqual([
      expect.objectContaining({
        isoDate: "2026-09-28",
        calendar: "buddhist",
        calendarYear: 2569,
        month: 9,
        day: 28,
        inferredYear: true
      }),
      expect.objectContaining({
        isoDate: "2026-10-01",
        calendar: "buddhist",
        calendarYear: 2569,
        month: 10,
        day: 1,
        inferredYear: true
      }),
      expect.objectContaining({
        isoDate: "2026-10-04",
        calendar: "buddhist",
        calendarYear: 2569,
        month: 10,
        day: 4,
        inferredYear: true
      })
    ]);
    const restoredDated = fromFhirDosage(dated.fhir);
    expect(restoredDated.meta.canonical.clauses[0]?.schedule?.calendarEvents?.[0]).toMatchObject({
      calendar: "buddhist",
      calendarYear: 2569,
      inferredYear: true
    });

    expect(nextDueDoses(dated.fhir, {
      from: "2026-09-27T00:00:00+07:00",
      timeZone: "Asia/Bangkok",
      limit: 10
    })).toEqual([
      "2026-09-28T08:30:00+07:00",
      "2026-10-01T08:30:00+07:00",
      "2026-10-04T08:30:00+07:00"
    ]);

    const recurring = result.items[1];
    expect(recurring.meta.leftoverText).toBeUndefined();
    expect(recurring.fhir.timing?.repeat).toMatchObject({
      boundsPeriod: { start: "2026-10-05" },
      frequency: 1,
      period: 1,
      periodUnit: "wk",
      dayOfWeek: ["sun"],
      when: ["PCM"]
    });
    expect(nextDueDoses(recurring.fhir, {
      from: "2026-09-27T00:00:00+07:00",
      timeZone: "Asia/Bangkok",
      limit: 2
    })).toEqual([
      "2026-10-11T08:30:00+07:00",
      "2026-10-18T08:30:00+07:00"
    ]);
    expect(recurring.longText).toBe(
      "Take 1 tablet orally once weekly after breakfast on Sunday."
    );
  });

  it("selects Gregorian or Buddhist full years without caller configuration", () => {
    const gregorian = parseSig("take 1 tab on 28/9/2026", {
      locale: "th",
      datePolicy: { referenceDate: REFERENCE_DATE }
    });
    expect(gregorian.fhir.timing?.event).toEqual(["2026-09-28"]);
    expect(gregorian.meta.canonical.clauses[0]?.schedule?.calendarEvents?.[0]).toMatchObject({
      calendar: "gregory",
      calendarYear: 2026,
      inferredYear: undefined
    });

    const buddhist = parseSig("take 1 tab on 28/9/2569", {
      locale: "th",
      datePolicy: { referenceDate: REFERENCE_DATE }
    });
    expect(buddhist.fhir.timing?.event).toEqual(["2026-09-28"]);
    expect(buddhist.meta.canonical.clauses[0]?.schedule?.calendarEvents?.[0]).toMatchObject({
      calendar: "buddhist",
      calendarYear: 2569,
      inferredYear: undefined
    });

    const thaiGregorianFallback = parseSig("รับประทาน 1 เม็ด วันที่ 28/9/26", {
      locale: "th",
      datePolicy: { referenceDate: REFERENCE_DATE }
    });
    expect(thaiGregorianFallback.fhir.timing?.event).toEqual(["2026-09-28"]);
    expect(thaiGregorianFallback.meta.canonical.clauses[0]?.schedule?.calendarEvents?.[0]).toMatchObject({
      calendar: "gregory",
      calendarYear: 2026,
      inferredYear: true
    });
  });

  it("infers omitted years from the reference date for explicit date contexts", () => {
    const mixed = parseSig(
      "take 1 tab after breakfast on 28/9 และ 1,4/10 then every Sunday",
      { locale: "en-GB", datePolicy: { referenceDate: REFERENCE_DATE } }
    );
    expect(mixed.items[0]?.fhir.timing?.event).toEqual([
      "2026-09-28",
      "2026-10-01",
      "2026-10-04"
    ]);
    expect(mixed.items[0]?.meta.leftoverText).toBeUndefined();
    expect(mixed.items[1]?.fhir.timing?.repeat).toMatchObject({
      boundsPeriod: { start: "2026-10-05" },
      period: 1,
      periodUnit: "wk",
      dayOfWeek: ["sun"],
      when: ["PCM"]
    });

    const thai = parseSig(
      "รับประทาน 1 เม็ด หลังอาหารเช้า วันที่ 28/9 และ 1,4/10 จากนั้น ทุกวันอาทิตย์",
      { locale: "th", datePolicy: { referenceDate: REFERENCE_DATE } }
    );
    expect(thai.items[0]?.fhir.timing?.event).toEqual([
      "2026-09-28",
      "2026-10-01",
      "2026-10-04"
    ]);
    expect(thai.items[0]?.meta.canonical.clauses[0]?.schedule?.calendarEvents).toEqual([
      expect.objectContaining({ isoDate: "2026-09-28", inferredYear: true }),
      expect.objectContaining({ isoDate: "2026-10-01", inferredYear: true }),
      expect.objectContaining({ isoDate: "2026-10-04", inferredYear: true })
    ]);

    const us = parseSig("take 1 tab on 09/28", {
      locale: "en-US",
      datePolicy: { referenceDate: REFERENCE_DATE }
    });
    expect(us.fhir.timing?.event).toEqual(["2026-09-28"]);
    expect(us.meta.canonical.clauses[0]?.schedule?.calendarEvents?.[0]).toMatchObject({
      calendar: "gregory",
      calendarYear: 2026,
      month: 9,
      day: 28,
      inferredYear: true
    });

    const sharedForward = parseSig("take 1 tab on 28/9/2026 and 1,4/10", {
      locale: "en-GB",
      datePolicy: { referenceDate: REFERENCE_DATE }
    });
    expect(sharedForward.fhir.timing?.event).toEqual([
      "2026-09-28",
      "2026-10-01",
      "2026-10-04"
    ]);

    const sharedBackward = parseSig("take 1 tab on 28/9 and 1,4/10/2026", {
      locale: "en-GB",
      datePolicy: { referenceDate: REFERENCE_DATE }
    });
    expect(sharedBackward.fhir.timing?.event).toEqual([
      "2026-09-28",
      "2026-10-01",
      "2026-10-04"
    ]);
  });

  it("does not reinterpret unanchored slash fractions as yearless dates", () => {
    const fraction = parseSig("take 1/2 tablet after breakfast", {
      datePolicy: { referenceDate: REFERENCE_DATE }
    });
    expect(fraction.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({
      value: 0.5,
      unit: "tab"
    });
    expect(fraction.fhir.timing?.event).toBeUndefined();
  });

  it("uses explicit locale date order for Gregorian two-digit dates", () => {
    const result = parseSig("take 1 tab on 09/28/26", {
      locale: "en-US",
      datePolicy: { referenceDate: REFERENCE_DATE }
    });
    expect(result.fhir.timing?.event).toEqual(["2026-09-28"]);
    expect(result.meta.canonical.clauses[0]?.schedule?.calendarEvents?.[0]).toMatchObject({
      calendar: "gregory",
      calendarYear: 2026,
      month: 9,
      day: 28,
      inferredYear: true
    });
  });

  it("handles Thai, English, and code-switched date-list surfaces consistently", () => {
    const cases: Array<{
      input: string;
      options?: Parameters<typeof parseSig>[1];
    }> = [
      {
        input: "take orally 1 tablet after breakfast on 28/9/2026 and 1/10/2026,4/10/2026 then every Sunday",
        options: { locale: "en-GB" }
      },
      {
        input: "take orally 1 tablet after breakfast on 09/28/26,10/1/26 and 10/4/26 then every Sunday",
        options: { locale: "en-US", datePolicy: { referenceDate: REFERENCE_DATE } }
      },
      {
        input: "รับประทาน 1 เม็ด หลังอาหารเช้า วันที่ 28/9/2569 และ 1/10/2569,4/10/2569 จากนั้น ทุกวันอาทิตย์",
        options: { locale: "th" }
      },
      {
        input: "take orally 1 tablet after breakfast on 28/9/69 และ 1,4/10/69 จากนั้น ทุกวันอาทิตย์",
        options: { datePolicy: { referenceDate: REFERENCE_DATE } }
      },
      {
        input: "รับประทาน 1 เม็ด หลังอาหารเช้า วันที่ 28/9/69 และ 1,4/10/69 then every Sunday",
        options: { datePolicy: { referenceDate: REFERENCE_DATE } }
      },
      {
        input: "รับประทาน 1 เม็ด หลังอาหารเช้า on 28/9/69 and 1,4/10/69 then every Sunday",
        options: { datePolicy: { referenceDate: REFERENCE_DATE } }
      },
      {
        input: "take orally 1 tablet after breakfast วันที่ 28/9/69 และ 1,4/10/69 then every Sunday",
        options: { datePolicy: { referenceDate: REFERENCE_DATE } }
      },
      {
        input: "take orally 1 tablet after breakfast on 28/9 and 1,4/10 then every Sunday",
        options: { locale: "en-GB", datePolicy: { referenceDate: REFERENCE_DATE } }
      },
      {
        input: "take orally 1 tablet after breakfast on 28/9 และ 1,4/10 จากนั้น every Sunday",
        options: { datePolicy: { referenceDate: REFERENCE_DATE } }
      },
      {
        input: "take 1 tab after breakfast on 28/9/26,1,4/10/26 then every Sunday",
        options: { locale: "en-GB", datePolicy: { referenceDate: REFERENCE_DATE } }
      }
    ];

    for (const item of cases) {
      const result = parseSig(item.input, item.options);
      expect(result.count).toBe(2);
      expect(result.items[0]?.meta.leftoverText).toBeUndefined();
      expect(result.items[0]?.fhir.site).toBeUndefined();
      expect(result.items[0]?.fhir.timing?.event).toEqual([
        "2026-09-28",
        "2026-10-01",
        "2026-10-04"
      ]);
      expect(result.items[0]?.fhir.timing?.repeat?.when).toEqual(["PCM"]);
      expect(result.items[1]?.meta.leftoverText).toBeUndefined();
      expect(result.items[1]?.fhir.timing?.repeat).toMatchObject({
        boundsPeriod: { start: "2026-10-05" },
        period: 1,
        periodUnit: "wk",
        dayOfWeek: ["sun"],
        when: ["PCM"]
      });
    }
  });

  it("does not silently assume Buddhist years for pure-English two-digit 69 dates", () => {
    const unresolved = parseSig(
      "take 1 tab after breakfast on 28/9/69, 1/10/69 and 4/10/69 then every Sunday",
      {
        locale: "en-GB",
        datePolicy: { referenceDate: REFERENCE_DATE }
      }
    );
    expect(unresolved.items[0]?.fhir.timing?.event).toBeUndefined();
    expect(unresolved.items[0]?.meta.leftoverText).toContain("28/9/69");
    expect(unresolved.items[0]?.fhir.site).toBeUndefined();

    const explicitlyEnabled = parseSig(
      "take 1 tab after breakfast on 28/9/69, 1/10/69 and 4/10/69 then every Sunday",
      {
        locale: "en-GB",
        datePolicy: {
          calendars: ["buddhist", "gregory"],
          referenceDate: REFERENCE_DATE
        }
      }
    );
    expect(explicitlyEnabled.items[0]?.fhir.timing?.event).toEqual([
      "2026-09-28",
      "2026-10-01",
      "2026-10-04"
    ]);
    expect(explicitlyEnabled.items[0]?.meta.leftoverText).toBeUndefined();
  });

  it("allows callers to disable or extend calendar resolvers without changing parser grammar", () => {
    expect(listMedicationDateResolvers()).toEqual(expect.arrayContaining(["gregory", "buddhist"]));

    const disabled = parseSig("take 1 tab on 28/9/2569", {
      locale: "th",
      datePolicy: { calendars: [], referenceDate: REFERENCE_DATE }
    });
    expect(disabled.fhir.timing?.event).toBeUndefined();
    expect(disabled.fhir.site).toBeUndefined();
    expect(disabled.meta.leftoverText).toContain("28/9/2569");

    registerMedicationDateResolver({
      id: "test-offset-calendar",
      calendarYearFromIsoYear(isoYear) {
        return isoYear + 1000;
      },
      resolveYear(sourceYear, sourceYearDigits) {
        if (sourceYearDigits !== 4 || sourceYear < 3000) return undefined;
        return {
          isoYear: sourceYear - 1000,
          calendarYear: sourceYear,
          inferredYear: false
        };
      }
    });
    const custom = parseSig("take 1 tab on 28/9/3026", {
      datePolicy: {
        calendars: ["test-offset-calendar"],
        referenceDate: REFERENCE_DATE
      }
    });
    expect(custom.fhir.timing?.event).toEqual(["2026-09-28"]);
    expect(custom.meta.canonical.clauses[0]?.schedule?.calendarEvents?.[0]).toMatchObject({
      calendar: "test-offset-calendar",
      calendarYear: 3026
    });

    const customYearless = parseSig("take 1 tab on 28/9", {
      datePolicy: {
        calendars: ["test-offset-calendar"],
        referenceDate: REFERENCE_DATE
      }
    });
    expect(customYearless.fhir.timing?.event).toEqual(["2026-09-28"]);
    expect(customYearless.meta.canonical.clauses[0]?.schedule?.calendarEvents?.[0]).toMatchObject({
      calendar: "test-offset-calendar",
      calendarYear: 3026,
      inferredYear: true
    });
  });

  it("keeps unresolved date-shaped text out of site and dose semantics", () => {
    const input = "take 1 tab on 28/9/69 และ 1,4/10/69";
    const spans = findMedicationDateListSpans(input, {
      datePolicy: {
        calendars: ["gregory"],
        referenceDate: REFERENCE_DATE,
        ambiguity: "reject"
      }
    });
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ unresolved: true });

    const result = parseSig(input, {
      datePolicy: {
        calendars: ["gregory"],
        referenceDate: REFERENCE_DATE,
        ambiguity: "reject"
      }
    });
    const clause = result.meta.canonical.clauses[0];
    expect(clause?.site).toBeUndefined();
    expect(clause?.dose).toEqual({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.event).toBeUndefined();
    expect(result.meta.leftoverText).toContain("28/9/69");
    expect(result.meta.leftoverText).toContain("4/10/69");
  });

  it("keeps commas inside explicit date lists within one dosage segment", () => {
    const result = parseSig("take 1 tab on 28/9/2026,1/10/2026", {
      datePolicy: { referenceDate: REFERENCE_DATE }
    });
    expect(result.meta.segments).toHaveLength(1);
    expect(result.fhir.timing?.event).toEqual(["2026-09-28", "2026-10-01"]);
    expect(result.meta.leftoverText).toBeUndefined();
  });

  it("round-trips exact FHIR Timing.event dates into canonical schedule semantics", () => {
    const parsed = parseSig("take 1 tab on 28/9/2026", {
      datePolicy: { referenceDate: REFERENCE_DATE }
    });
    const restored = fromFhirDosage(parsed.fhir);
    expect(restored.meta.canonical.clauses[0]?.schedule?.calendarEvents?.map((event) => event.isoDate)).toEqual([
      "2026-09-28"
    ]);
    expect(formatSig(parsed.fhir, "long", { locale: "en" })).toContain("28 Sep 2026");
  });
});
