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
      "Take 1 tablet orally once weekly after breakfast on Sunday starting 5 Oct 2026."
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

  it("supports explicit hyphen dates without stealing medication ranges", () => {
    const dated = parseSig("take 1 tab on 28-9-26 after breakfast", {
      locale: "en-GB",
      datePolicy: { referenceDate: REFERENCE_DATE }
    });
    expect(dated.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(dated.fhir.timing?.event).toEqual(["2026-09-28"]);
    expect(dated.fhir.timing?.repeat?.when).toEqual(["PCM"]);
    expect(dated.meta.leftoverText).toBeUndefined();

    const yearless = parseSig("take 1 tab on 28-9 after breakfast", {
      locale: "en-GB",
      datePolicy: { referenceDate: REFERENCE_DATE }
    });
    expect(yearless.fhir.timing?.event).toEqual(["2026-09-28"]);
    expect(yearless.meta.leftoverText).toBeUndefined();

    const bounded = parseSig("take 1 tab daily until 30-9-2026", {
      locale: "en-GB",
      datePolicy: { referenceDate: REFERENCE_DATE }
    });
    expect(bounded.fhir.timing?.repeat?.boundsPeriod?.end).toBe("2026-09-30");
    expect(bounded.meta.leftoverText).toBeUndefined();

    const compressed = parseSig("take 1 tab on 28-9-26 and 1,4-10-26 after breakfast", {
      locale: "en-GB",
      datePolicy: { referenceDate: REFERENCE_DATE }
    });
    expect(compressed.fhir.timing?.event).toEqual([
      "2026-09-28",
      "2026-10-01",
      "2026-10-04"
    ]);
    expect(compressed.meta.leftoverText).toBeUndefined();

    const thai = parseSig("รับประทาน 1 เม็ด วันที่ 28-9-69 หลังอาหารเช้า", {
      datePolicy: { referenceDate: REFERENCE_DATE }
    });
    expect(thai.fhir.timing?.event).toEqual(["2026-09-28"]);
    expect(thai.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(thai.meta.leftoverText).toBeUndefined();

    const doseRange = parseSig("take 1-2 tablets daily", {
      datePolicy: { referenceDate: REFERENCE_DATE }
    });
    expect(doseRange.fhir.doseAndRate?.[0]?.doseRange).toMatchObject({
      low: { value: 1, unit: "tab" },
      high: { value: 2, unit: "tab" }
    });
    expect(doseRange.fhir.timing?.event).toBeUndefined();

    const frequencyRange = parseSig("take 1 tab po 1-2 times daily", {
      datePolicy: { referenceDate: REFERENCE_DATE }
    });
    expect(frequencyRange.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      frequencyMax: 2,
      period: 1,
      periodUnit: "d"
    });
    expect(frequencyRange.fhir.timing?.event).toBeUndefined();

    const bareAmbiguous = parseSig("take 1 tab 28-9-26 after breakfast", {
      locale: "en-GB",
      datePolicy: { referenceDate: REFERENCE_DATE }
    });
    expect(bareAmbiguous.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(bareAmbiguous.fhir.timing?.event).toBeUndefined();
    expect(bareAmbiguous.meta.leftoverText).toContain("28-9-26");
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

  it("keeps exact dates attached correctly across arbitrary clause positions", () => {
    const cases: Array<{
      input: string;
      options?: Parameters<typeof parseSig>[1];
      dates: string[];
      when?: string[];
      site?: string;
      prn?: boolean;
      count?: number;
    }> = [
      {
        input: "on 28/9/26 take 1 tab po after breakfast",
        options: { locale: "en-GB", datePolicy: { referenceDate: REFERENCE_DATE } },
        dates: ["2026-09-28"],
        when: ["PCM"]
      },
      {
        input: "take 1 tab on 28/9/26 po after breakfast",
        options: { locale: "en-GB", datePolicy: { referenceDate: REFERENCE_DATE } },
        dates: ["2026-09-28"],
        when: ["PCM"]
      },
      {
        input: "take 1 tab po after breakfast on 28/9/26 as needed for pain",
        options: { locale: "en-GB", datePolicy: { referenceDate: REFERENCE_DATE } },
        dates: ["2026-09-28"],
        when: ["PCM"],
        prn: true
      },
      {
        input: "apply on 28/9/26 to affected area",
        options: { locale: "en-GB", datePolicy: { referenceDate: REFERENCE_DATE } },
        dates: ["2026-09-28"],
        site: "affected area"
      },
      {
        input: "take 1 tab at 08:00 on 28/9/26",
        options: { locale: "en-GB", datePolicy: { referenceDate: REFERENCE_DATE } },
        dates: ["2026-09-28"]
      },
      {
        input: "take 1 tab on 28/9,1,4/10 after breakfast",
        options: { locale: "en-GB", datePolicy: { referenceDate: REFERENCE_DATE } },
        dates: ["2026-09-28", "2026-10-01", "2026-10-04"],
        when: ["PCM"]
      },
      {
        input: "วันที่ 28/9/69 รับประทาน 1 เม็ด หลังอาหารเช้า",
        options: { locale: "th", datePolicy: { referenceDate: REFERENCE_DATE } },
        dates: ["2026-09-28"],
        when: ["PCM"]
      },
      {
        input: "รับประทาน 1 เม็ด วันที่ 28/9 และ 1,4/10 หลังอาหารเช้า",
        options: { locale: "th", datePolicy: { referenceDate: REFERENCE_DATE } },
        dates: ["2026-09-28", "2026-10-01", "2026-10-04"],
        when: ["PCM"]
      },
      {
        input: "on 28/9/69 รับประทาน 1 เม็ด หลังอาหารเช้า",
        options: { datePolicy: { referenceDate: REFERENCE_DATE } },
        dates: ["2026-09-28"],
        when: ["PCM"]
      },
      {
        input: "วันที่ 28/9/69 take 1 tab po after breakfast",
        options: { datePolicy: { referenceDate: REFERENCE_DATE } },
        dates: ["2026-09-28"],
        when: ["PCM"]
      }
    ];

    for (const item of cases) {
      const result = parseSig(item.input, item.options);
      expect(result.count).toBe(item.count ?? 1);
      const first = result.items[0];
      expect(first?.meta.leftoverText).toBeUndefined();
      expect(first?.fhir.timing?.event).toEqual(item.dates);
      if (item.when) expect(first?.fhir.timing?.repeat?.when).toEqual(item.when);
      if (item.site) expect(first?.fhir.site?.text).toBe(item.site);
      if (item.prn) expect(first?.fhir.asNeededBoolean).toBe(true);
    }
  });

  it("models relational calendar dates as native timing bounds instead of exact events", () => {
    const cases: Array<{
      input: string;
      options?: Parameters<typeof parseSig>[1];
      bounds: { start?: string; end?: string };
    }> = [
      {
        input: "take 1 tab daily until 28/9/2026",
        options: { locale: "en-GB", datePolicy: { referenceDate: REFERENCE_DATE } },
        bounds: { end: "2026-09-28" }
      },
      {
        input: "take 1 tab daily from 28/9",
        options: { locale: "en-GB", datePolicy: { referenceDate: REFERENCE_DATE } },
        bounds: { start: "2026-09-28" }
      },
      {
        input: "take 1 tab before 30/9 after breakfast",
        options: { locale: "en-GB", datePolicy: { referenceDate: REFERENCE_DATE } },
        bounds: { end: "2026-09-29" }
      },
      {
        input: "take 1 tab after 28/9 at 08:00",
        options: { locale: "en-GB", datePolicy: { referenceDate: REFERENCE_DATE } },
        bounds: { start: "2026-09-29" }
      },
      {
        input: "รับประทาน 1 เม็ด ทุกวัน ถึงวันที่ 28/9/2569",
        options: { locale: "th", datePolicy: { referenceDate: REFERENCE_DATE } },
        bounds: { end: "2026-09-28" }
      },
      {
        input: "รับประทาน 1 เม็ด ทุกวัน ตั้งแต่วันที่ 28/9",
        options: { locale: "th", datePolicy: { referenceDate: REFERENCE_DATE } },
        bounds: { start: "2026-09-28" }
      }
    ];

    for (const item of cases) {
      const result = parseSig(item.input, item.options);
      expect(result.meta.leftoverText).toBeUndefined();
      expect(result.fhir.timing?.event).toBeUndefined();
      expect(result.fhir.timing?.repeat?.boundsPeriod).toEqual(item.bounds);
      expect(result.fhir.site).toBeUndefined();
    }
  });

  it("preserves an existing end bound when transition propagation adds a start bound", () => {
    const result = parseSig(
      "take 1 tab after breakfast on 28/9/2026 then every Sunday until 30/11/2026",
      { locale: "en-GB", datePolicy: { referenceDate: REFERENCE_DATE } }
    );
    expect(result.count).toBe(2);
    expect(result.items[1]?.fhir.timing?.repeat?.boundsPeriod).toEqual({
      start: "2026-09-29",
      end: "2026-11-30"
    });
  });

  it("uses Buddhist years consistently for Thai event and bound realization", () => {
    const result = parseSig(
      "รับประทาน 1 เม็ด หลังอาหารเช้า วันที่ 28/9/2026 จากนั้น ทุกวันอาทิตย์",
      { locale: "th", datePolicy: { referenceDate: REFERENCE_DATE } }
    );
    expect(result.count).toBe(2);
    expect(result.items[0]?.longText).toContain("28/9/2569");
    expect(result.items[1]?.longText).toContain("29/9/2569");
  });

  it("supports bounded schedules with dates in medial positions and honors inclusive end dates", () => {
    const result = parseSig(
      "from 28/9 take 1 tab at 08:00 daily until 30/9",
      { locale: "en-GB", datePolicy: { referenceDate: REFERENCE_DATE } }
    );
    expect(result.meta.leftoverText).toBeUndefined();
    expect(result.fhir.timing?.repeat).toMatchObject({
      boundsPeriod: { start: "2026-09-28", end: "2026-09-30" },
      frequency: 1,
      period: 1,
      periodUnit: "d",
      timeOfDay: ["08:00:00"]
    });
    expect(nextDueDoses(result.fhir, {
      from: "2026-09-27T00:00:00+07:00",
      timeZone: "Asia/Bangkok",
      limit: 10
    })).toEqual([
      "2026-09-28T08:00:00+07:00",
      "2026-09-29T08:00:00+07:00",
      "2026-09-30T08:00:00+07:00"
    ]);

    const restored = fromFhirDosage(result.fhir);
    expect(restored.meta.canonical.clauses[0]?.schedule).toMatchObject({
      boundsStart: "2026-09-28",
      boundsEnd: "2026-09-30"
    });
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


  it("composes exact date-time pairs with bounded recurrence in English, Thai, and code-switch", () => {
    const cases = [
      {
        input: "take 1 tab at 08:00 on 28/9 and at 20:00 on 1/10 then every Sunday at 09:30 until 30/11",
        options: { locale: "en-GB", datePolicy: { referenceDate: REFERENCE_DATE } }
      },
      {
        input: "รับประทาน 1 เม็ด เวลา 08:00 วันที่ 28/9 และ เวลา 20:00 วันที่ 1/10 จากนั้น ทุกวันอาทิตย์ เวลา 09:30 ถึงวันที่ 30/11",
        options: { locale: "th", datePolicy: { referenceDate: REFERENCE_DATE } }
      },
      {
        input: "take 1 tab เวลา 08:00 วันที่ 28/9 and at 20:00 on 1/10 จากนั้น every Sunday เวลา 09:30 until 30/11",
        options: { datePolicy: { referenceDate: REFERENCE_DATE } }
      }
    ];

    for (const item of cases) {
      const result = parseSig(item.input, item.options);
      expect(result.count).toBe(3);
      expect(result.items[0]?.meta.leftoverText).toBeUndefined();
      expect(result.items[1]?.meta.leftoverText).toBeUndefined();
      expect(result.items[2]?.meta.leftoverText).toBeUndefined();
      expect(result.items[0]?.fhir.timing).toMatchObject({
        event: ["2026-09-28"],
        repeat: { timeOfDay: ["08:00:00"] }
      });
      expect(result.items[1]?.fhir.timing).toMatchObject({
        event: ["2026-10-01"],
        repeat: { timeOfDay: ["20:00:00"] }
      });
      expect(result.items[2]?.fhir.timing?.repeat).toMatchObject({
        boundsPeriod: { start: "2026-10-02", end: "2026-11-30" },
        dayOfWeek: ["sun"],
        timeOfDay: ["09:30:00"]
      });
      expect(nextDueDoses(result.items[2]!.fhir, {
        from: "2026-09-27T00:00:00+07:00",
        timeZone: "Asia/Bangkok",
        limit: 2
      })).toEqual([
        "2026-10-04T09:30:00+07:00",
        "2026-10-11T09:30:00+07:00"
      ]);
    }
  });

  it("keeps distinct date-time pairs separate instead of creating a Cartesian product", () => {
    const result = parseSig(
      "take 1 tab at 08:00 on 28/9 and at 20:00 on 1/10",
      { locale: "en-GB", datePolicy: { referenceDate: REFERENCE_DATE } }
    );
    expect(result.count).toBe(2);
    expect(nextDueDoses(result.items[0]!.fhir, {
      from: "2026-09-27T00:00:00+07:00",
      timeZone: "Asia/Bangkok",
      limit: 10
    })).toEqual(["2026-09-28T08:00:00+07:00"]);
    expect(nextDueDoses(result.items[1]!.fhir, {
      from: "2026-09-27T00:00:00+07:00",
      timeZone: "Asia/Bangkok",
      limit: 10
    })).toEqual(["2026-10-01T20:00:00+07:00"]);
  });

  it("separates recurring and exact-date unions that cannot share one FHIR Timing", () => {
    const result = parseSig(
      "take 1 tab every Sunday at 09:30 until 30/11 and on 28/9 at 08:00",
      { locale: "en-GB", datePolicy: { referenceDate: REFERENCE_DATE } }
    );
    expect(result.count).toBe(2);
    expect(result.items[0]?.fhir.timing?.event).toBeUndefined();
    expect(result.items[0]?.fhir.timing?.repeat).toMatchObject({
      boundsPeriod: { end: "2026-11-30" },
      dayOfWeek: ["sun"],
      timeOfDay: ["09:30:00"]
    });
    expect(result.items[1]?.fhir.timing).toMatchObject({
      event: ["2026-09-28"],
      repeat: { timeOfDay: ["08:00:00"] }
    });
  });


  it("treats exact-date AND recurrence as a union, not a transition", () => {
    const result = parseSig(
      "take 1 tab on 28/9 at 08:00 and every Sunday at 09:30 until 30/11",
      { locale: "en-GB", datePolicy: { referenceDate: REFERENCE_DATE } }
    );
    expect(result.count).toBe(2);
    expect(result.items[0]?.fhir.timing).toMatchObject({
      event: ["2026-09-28"],
      repeat: { timeOfDay: ["08:00:00"] }
    });
    expect(result.items[1]?.fhir.timing?.repeat).toMatchObject({
      boundsPeriod: { end: "2026-11-30" },
      dayOfWeek: ["sun"],
      timeOfDay: ["09:30:00"]
    });
    expect(result.items[1]?.fhir.timing?.repeat?.boundsPeriod?.start).toBeUndefined();
  });

  it("reparses English month-name dates emitted by formatSig without losing timing semantics", () => {
    const exact = parseSig(
      "take 1 tab at 08:00 and 20:00 on 28/9 and 1,4/10",
      { locale: "en-GB", datePolicy: { referenceDate: REFERENCE_DATE } }
    );
    const exactText = formatSig(exact.fhir, "long", { locale: "en" });
    const exactRoundTrip = parseSig(exactText, {
      locale: "en-GB",
      datePolicy: { referenceDate: REFERENCE_DATE }
    });
    expect(exactRoundTrip.fhir.timing?.event).toEqual(exact.fhir.timing?.event);
    expect(exactRoundTrip.fhir.timing?.repeat).toEqual(exact.fhir.timing?.repeat);
    expect(exactRoundTrip.meta.leftoverText).toBeUndefined();

    const recurring = parseSig(
      "take 1 tab every Sunday at 09:30 from 5/10 until 30/11",
      { locale: "en-GB", datePolicy: { referenceDate: REFERENCE_DATE } }
    );
    const recurringText = formatSig(recurring.fhir, "long", { locale: "en" });
    const recurringRoundTrip = parseSig(recurringText, {
      locale: "en-GB",
      datePolicy: { referenceDate: REFERENCE_DATE }
    });
    expect(recurringRoundTrip.fhir.timing?.event).toEqual(recurring.fhir.timing?.event);
    expect(recurringRoundTrip.fhir.timing?.repeat).toEqual(recurring.fhir.timing?.repeat);
    expect(recurringRoundTrip.meta.leftoverText).toBeUndefined();
  });

  it("encodes multiple explicit weekly weekdays with matching weekly frequency in Thai", () => {
    const result = parseSig(
      "รับประทาน 1 เม็ด ทุกวันจันทร์และวันพฤหัสบดี เวลา 09:30 ถึงวันที่ 30/11",
      { locale: "th", datePolicy: { referenceDate: REFERENCE_DATE } }
    );
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 2,
      period: 1,
      periodUnit: "wk",
      dayOfWeek: ["mon", "thu"],
      timeOfDay: ["09:30:00"],
      boundsPeriod: { end: "2026-11-30" }
    });
    expect(result.longText).toContain("สัปดาห์ละ 2 ครั้ง");
  });
});
