import { describe, expect, it, vi } from "vitest";
import { calculateTotalUnits, findMedicationDateListSpans, formatSig, listMedicationDateResolvers, fromFhirDosage, nextDueDoses, parseSig as parseBatch, registerMedicationDateResolver } from "../src/index";
import { canonicalToFhir, canonicalFromFhir } from "../src/fhir";
import { toDosageDetails, toFhirR5Dosages } from "../src/index";
import { parseHpsgClause } from "../src/hpsg/clause-parser";
import { lexInput } from "../src/lexer/lex";
import { normalizeBodySiteKey } from "../src/maps";
import { parseClauseState, tokenize } from "../src/parser";
import { ParserState } from "../src/parser-state";
import type { HpsgSign } from "../src/hpsg/signature";
import type { ParseOptions } from "../src/types";
import { parseSig } from "./helpers/r5-parser";

const REFERENCE_DATE = "2026-09-27";

function parseRawHpsgSign(input: string, options?: ParseOptions): {
  sign: HpsgSign;
  tokens: ReturnType<typeof tokenize>;
} {
  const tokens = tokenize(input);
  const state = new ParserState(input, tokens);
  const sign = parseHpsgClause({
    state,
    tokens,
    options,
    dateSpans: findMedicationDateListSpans(input, options),
    limit: tokens.length,
    clinicalCache: {},
    deps: {
      addDayOfWeekList: () => undefined,
      addWhen: () => undefined,
      isCompatibleRouteRefinement: (current, next) => current === undefined || current === next,
      markToken: () => undefined,
      normalizeSiteText: normalizeBodySiteKey,
      recordEvidence: () => undefined,
      refreshMethodSurface: () => undefined,
      setRoute: () => undefined
    },
    project: false
  });
  if (!sign) throw new Error(`Expected a raw HPSG sign for ${input}`);
  return { sign, tokens };
}

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
    const recurringSchedule = recurring.meta.canonical.clauses[0]?.schedule;
    expect(recurringSchedule).toMatchObject({
      boundsStart: "2026-10-05",
      dayOfWeek: ["sun"],
      when: ["PCM"]
    });
    expect(recurringSchedule?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "hpsg.lex.schedule.eventPhrase.mealRelation" }),
      expect.objectContaining({ rule: "hpsg.lex.schedule.calendarDateList" }),
      expect.objectContaining({
        rule: "regimen.sequence.whole-predecessor-phase",
        spans: [expect.objectContaining({ text: "จากนั้น" })]
      })
    ]));
    for (const evidence of recurringSchedule?.evidence ?? []) {
      for (const span of evidence.spans) {
        expect(input.slice(span.start, span.end)).toBe(span.text);
      }
    }
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

  it("inherits an exact clock through a licensed date-to-recurrence transition", () => {
    const input = "take 1 tab at 08:00 on 28/9/2026 then every Sunday";
    const result = parseSig(input, {
      locale: "en-GB",
      datePolicy: { referenceDate: REFERENCE_DATE }
    });

    expect(result.count).toBe(2);
    expect(result.items[1]?.meta.canonical.clauses[0]?.schedule).toMatchObject({
      boundsStart: "2026-09-29",
      dayOfWeek: ["sun"],
      timeOfDay: ["08:00:00"]
    });
    expect(result.items[1]?.fhir.timing?.repeat).toMatchObject({
      boundsPeriod: { start: "2026-09-29" },
      dayOfWeek: ["sun"],
      timeOfDay: ["08:00:00"]
    });
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

    const usDmy = parseSig("take 1 tab on 28/9", {
      locale: "en-US",
      datePolicy: { referenceDate: REFERENCE_DATE }
    });
    expect(usDmy.fhir.timing?.event).toEqual(["2026-09-28"]);

    const usMdyWithoutOptIn = parseSig("take 1 tab on 09/28", {
      locale: "en-US",
      datePolicy: { referenceDate: REFERENCE_DATE }
    });
    expect(usMdyWithoutOptIn.fhir.timing?.event).toBeUndefined();
    expect(usMdyWithoutOptIn.meta.leftoverText).toContain("09/28");

    const usMdyExplicit = parseSig("take 1 tab on 09/28", {
      locale: "en-US",
      datePolicy: { referenceDate: REFERENCE_DATE, dateOrder: "MDY" }
    });
    expect(usMdyExplicit.fhir.timing?.event).toEqual(["2026-09-28"]);

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

  it("requires an explicit opt-in for MDY numeric dates", () => {
    const defaultDmy = parseSig("take 1 tab on 09/28/26", {
      locale: "en-US",
      datePolicy: { referenceDate: REFERENCE_DATE }
    });
    expect(defaultDmy.fhir.timing?.event).toBeUndefined();
    expect(defaultDmy.meta.leftoverText).toContain("09/28/26");

    const explicitMdy = parseSig("take 1 tab on 09/28/26", {
      locale: "en-US",
      datePolicy: { referenceDate: REFERENCE_DATE, dateOrder: "MDY" }
    });
    expect(explicitMdy.fhir.timing?.event).toEqual(["2026-09-28"]);
    expect(explicitMdy.meta.canonical.clauses[0]?.schedule?.calendarEvents?.[0]).toMatchObject({
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
        options: {
          locale: "en-US",
          datePolicy: { referenceDate: REFERENCE_DATE, dateOrder: "MDY" }
        }
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
      if (item.prn) expect(first?.fhir.asNeeded).toBe(true);
    }
  });

  it("uses Gregorian ISO YMD dates in both Thai and US-MDY medication directions", () => {
    const variants = [
      { input: "take 1 tab daily from 2026-10-25 until 2026-11-01",
        opts: { locale: "en-US", datePolicy: { dateOrder: "MDY" as const } } },
      { input: "รับประทาน 1 เม็ด ทุกวัน ตั้งแต่2026-10-25 ถึงวันที่2026-11-01",
        opts: { locale: "th", datePolicy: { dateOrder: "DMY" as const } } }
    ];
    for (const { input, opts } of variants) {
      const parsed = parseSig(input, opts);
      const batch = parseBatch(input, opts);
      expect(parsed.warnings).toEqual([]);
      expect(parsed.meta.leftoverText).toBeUndefined();
      expect(parsed.fhir.timing?.repeat?.boundsPeriod)
        .toEqual({ start: "2026-10-25", end: "2026-11-01" });
      expect(nextDueDoses(batch, {
        from: "2026-10-22T08:00:00+07:00",
        timeZone: "Asia/Bangkok",
        limit: 20
      })).toHaveLength(8);
      expect(calculateTotalUnits({
        dosage: batch,
        orderedAt: "2026-10-22T08:00:00+07:00",
        from: "2026-10-22T08:00:00+07:00",
        timeZone: "Asia/Bangkok",
        durationValue: 30,
        durationUnit: "d"
      }).totalUnits).toBe(8);
    }
  });

  it("resolves attached Buddhist YMD dates in Thai medication context", () => {
    const options = { locale: "th", datePolicy: { referenceDate: "2026-10-22" } };
    const bounded = parseSig("รับประทาน 1 เม็ด ทุกวัน ถึง2569-11-01", options);
    expect(bounded.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(bounded.fhir.timing?.repeat).toMatchObject({
      boundsPeriod: { end: "2026-11-01" }, frequency: 1, period: 1, periodUnit: "d"
    });
    expect(bounded.meta.canonical.clauses[0]?.schedule?.boundsEnd).toBe("2026-11-01");
    expect(bounded.meta.leftoverText).toBeUndefined();
    expect(bounded.warnings).toEqual([]);
    expect(bounded.longText).toContain("1/11/2569");

    const dated = parseSig("รับประทาน 1 เม็ด วันที่2569-10-25และ2569-11-01", options);
    expect(dated.fhir.timing?.event).toEqual(["2026-10-25", "2026-11-01"]);
    expect(dated.meta.canonical.clauses[0]?.schedule?.calendarEvents).toEqual([
      expect.objectContaining({
        isoDate: "2026-10-25", calendar: "buddhist", calendarYear: 2569
      }),
      expect.objectContaining({
        isoDate: "2026-11-01", calendar: "buddhist", calendarYear: 2569
      })
    ]);
    expect(dated.meta.leftoverText).toBeUndefined();
    expect(dated.warnings).toEqual([]);
  });

  it("keeps the known daily suggestion and raw text for invalid or ambiguous attached dates", () => {
    const cases = [
      {
        input: "รับประทาน 1 เม็ด ทุกวัน ถึง31/02/2569",
        evidence: "ถึง31/02/2569",
        options: { locale: "th", datePolicy: { referenceDate: "2026-10-22" } }
      },
      {
        input: "take 1 tab daily until 2026-10-25 and 2026-11-01",
        evidence: "until 2026-10-25 and 2026-11-01",
        options: { locale: "en-GB", datePolicy: { referenceDate: "2026-10-22" } }
      }
    ];
    for (const item of cases) {
      const parsed = parseSig(item.input, item.options);
      expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
      expect(parsed.fhir.timing?.repeat).toMatchObject({
        frequency: 1, period: 1, periodUnit: "d"
      });
      expect(parsed.fhir.timing?.repeat?.boundsPeriod).toBeUndefined();
      expect(parsed.fhir.timing?.event).toBeUndefined();
      expect(parsed.fhir.text?.toLocaleLowerCase())
        .toContain(item.evidence.toLocaleLowerCase());
      expect(parsed.meta.canonical.clauses[0]?.instructionGraph?.opaqueSpans)
        .toContainEqual(expect.objectContaining({ text: item.evidence }));
      expect(findMedicationDateListSpans(item.input, item.options))
        .toContainEqual(expect.objectContaining({ unresolved: true }));
    }
  });

  it("keeps complete attached Thai ISO lexeme boundaries with calendar-aware YMD semantics", () => {
    const cases = [
      {
        input: "รับประทาน 1 เม็ด ทุกวัน ตั้งแต่2026-10-25 ถึง2026-11-01",
        unresolved: [false, false]
      },
      {
        input: "รับประทาน 1 เม็ด ทุกวัน ถึง2569-11-01",
        unresolved: [false]
      },
      {
        input: "รับประทาน 1 เม็ด วันที่2569-10-25และ2569-11-01",
        unresolved: [false],
        separator: "และ"
      },
      ...["และ", "and", ","].map((separator) => ({
        input: `รับประทาน 1 เม็ด วันที่2026-10-25${separator}2026-11-01`,
        unresolved: [false],
        separator
      }))
    ];

    for (const item of cases) {
      const tokens = lexInput(item.input);
      const dateMatches = [...item.input.matchAll(/\d{4}-\d{2}-\d{2}/gu)];
      for (const match of dateMatches) {
        expect(tokens.some((token) => token.sourceStart === match.index)).toBe(true);
        expect(tokens.some((token) => token.sourceEnd === match.index! + match[0].length)).toBe(true);
      }
      expect(tokens.filter((token) =>
        /[\u0E00-\u0E7F]/u.test(token.original) && /\d/u.test(token.original)
      )).toEqual([]);
      if (item.separator) {
        expect(tokens.some((token) => token.original === item.separator)).toBe(true);
      }

      const spans = findMedicationDateListSpans(item.input, {
        locale: "th",
        datePolicy: { referenceDate: REFERENCE_DATE }
      });
      expect(spans.map((span) => span.unresolved)).toEqual(item.unresolved);
    }
  });

  it("retains contradictory bounds for correction while execution rejects the inverted interval", () => {
    const parsed = parseSig("take 1 tab daily from 2026-11-01 until 2026-10-25");
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
    expect(parsed.fhir.timing?.repeat).toMatchObject({
      boundsPeriod: { start: "2026-11-01", end: "2026-10-25" },
      frequency: 1, period: 1, periodUnit: "d"
    });
    expect(parsed.warnings).toEqual([]);
    expect(() => nextDueDoses(parsed.fhir, {
      from: "2026-09-28T08:00:00+07:00",
      timeZone: "Asia/Bangkok", limit: 4
    })).toThrow(/end must be after its start/i);
  });

  it("treats up to DATE as an inclusive end bound", () => {
    const input = "take 1 tab daily up to 30 Sep 2026";
    const options = {
      locale: "en-GB", datePolicy: { referenceDate: REFERENCE_DATE }
    };
    const spans = findMedicationDateListSpans(input, options);
    expect(spans).toEqual([
      expect.objectContaining({
        sourceText: "up to 30 Sep 2026",
        relation: "end-inclusive",
        unresolved: false,
        events: [expect.objectContaining({ isoDate: "2026-09-30" })]
      })
    ]);

    const parsed = parseSig(input, options);
    expect(parsed.fhir.timing?.repeat).toMatchObject({
      boundsPeriod: { end: "2026-09-30" }, frequency: 1, period: 1, periodUnit: "d"
    });
    expect(parsed.fhir.timing?.event).toBeUndefined();
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0]?.schedule?.boundsEnd).toBe("2026-09-30");
    expect(parsed.meta.canonical.clauses[0]?.schedule?.evidence).toContainEqual(
      expect.objectContaining({
        rule: "hpsg.lex.schedule.calendarDateList",
        scheduleFields: ["boundsEnd"],
        spans: [{ start: 17, end: 34, text: "up to 30 Sep 2026" }]
      })
    );
    expect(parsed.meta.canonical.clauses[0]?.schedule?.calendarEvents).toBeUndefined();
    expect(nextDueDoses(parsed.fhir, {
      from: "2026-09-28T08:00:00+07:00",
      timeZone: "Asia/Bangkok", limit: 10
    }).map(value => value.slice(0, 10))).toEqual([
      "2026-09-28", "2026-09-29", "2026-09-30"
    ]);
  });

  it("uses a plausible Buddhist YMD year even when the surrounding SIG is English", () => {
    const options = { locale: "en-GB", datePolicy: { referenceDate: REFERENCE_DATE } };
    const buddhist = parseSig("take 1 tab daily until 2569-11-01", options);
    expect(buddhist.fhir.timing?.repeat).toMatchObject({
      boundsPeriod: { end: "2026-11-01" }, frequency: 1, period: 1, periodUnit: "d"
    });
    expect(findMedicationDateListSpans("take 1 tab daily until 2569-11-01", options))
      .toContainEqual(expect.objectContaining({
        unresolved: false,
        events: [expect.objectContaining({
          isoDate: "2026-11-01", calendar: "buddhist", calendarYear: 2569
        })]
      }));

    const distant = parseSig("take 1 tab daily from 2400-01-01", options);
    expect(distant.fhir.timing?.repeat).toMatchObject({
      frequency: 1, period: 1, periodUnit: "d"
    });
    expect(distant.fhir.timing?.repeat?.boundsPeriod).toBeUndefined();
    expect(findMedicationDateListSpans("take 1 tab daily from 2400-01-01", options))
      .toContainEqual(expect.objectContaining({ unresolved: true }));
  });

  it("preserves intentional Gregorian and Buddhist calendar semantics", () => {
    const options = { locale: "th", datePolicy: { referenceDate: REFERENCE_DATE } };
    const be = parseSig("รับประทาน 1 เม็ด ทุกวัน ถึงวันที่25/10/2569", options);
    expect(be.fhir.timing?.repeat?.boundsPeriod?.end).toBe("2026-10-25");
    expect(be.warnings).toEqual([]);

    // The date-policy plausibleWindow applies only to inferred dates.
    // An explicitly written Gregorian ISO year remains explicit even when
    // outside the default inferred-year window.
    const iso = findMedicationDateListSpans("take 1 tab on 2090-10-25", options);
    expect(iso).toHaveLength(1);
    expect(iso[0].unresolved).toBe(false);
    expect(iso[0].events[0]?.isoDate).toBe("2090-10-25");

    const buddhistEvent = findMedicationDateListSpans(
      "รับประทาน 1 เม็ด วันที่2569-10-25", options
    );
    expect(buddhistEvent).toHaveLength(1);
    expect(buddhistEvent[0].unresolved).toBe(false);
    expect(buddhistEvent[0].events[0]).toMatchObject({
      isoDate: "2026-10-25", calendar: "buddhist", calendarYear: 2569
    });
  });

  it("keeps dose and cadence while leaving impossible ISO bounds editable", () => {
    for (const input of [
      "take 1 tab daily until 2026-02-30",
      "take 1 tab daily from 2025-02-29",
      "take 1 tab daily until 2026-11-31",
      "take 1 tab daily until 2026-13-01",
      "take 1 tab daily from 2026-00-15"
    ]) {
      const parsed = parseSig(input);
      const dateText = input.match(/\d{4}-\d{2}-\d{2}/u)![0];
      expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
      expect(parsed.fhir.timing?.repeat).toMatchObject({
        frequency: 1, period: 1, periodUnit: "d"
      });
      expect(parsed.fhir.timing?.repeat?.boundsPeriod).toBeUndefined();
      expect(parsed.fhir.text).toContain(dateText);
      expect(parsed.meta.canonical.clauses[0]?.instructionGraph?.opaqueSpans)
        .toContainEqual(expect.objectContaining({ text: expect.stringContaining(dateText) }));
      expect(findMedicationDateListSpans(input, { locale: "en-GB" }))
        .toContainEqual(expect.objectContaining({ unresolved: true }));
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

  it("constructs one open-ended schedule sign before FHIR lowering", () => {
    const cases: Array<{
      input: string;
      ownedSpan: string;
      options: Parameters<typeof parseClauseState>[1];
    }> = [
      {
        input: "take 1 tab daily on 2026-09-28 onwards",
        ownedSpan: "on 2026-09-28 onwards",
        options: { locale: "en-GB", datePolicy: { referenceDate: REFERENCE_DATE } }
      },
      {
        input: "take 1 tab daily from 2026-09-28 onwards",
        ownedSpan: "from 2026-09-28 onwards",
        options: { locale: "en-GB", datePolicy: { referenceDate: REFERENCE_DATE } }
      },
      {
        input: "รับประทาน 1 เม็ด ทุกวัน วันที่ 28/9/2569 เป็นต้นไป",
        ownedSpan: "วันที่ 28/9/2569 เป็นต้นไป",
        options: { locale: "th", datePolicy: { referenceDate: REFERENCE_DATE } }
      },
      {
        input: "รับประทาน 1 เม็ด ทุกวัน ตั้งแต่28/9/69ไป",
        ownedSpan: "ตั้งแต่28/9/69ไป",
        options: { locale: "th", datePolicy: { referenceDate: REFERENCE_DATE } }
      },
      {
        input: "รับประทาน 1 เม็ด ทุกวัน ตั้งแต่28/9/69 เป็นต้นไป",
        ownedSpan: "ตั้งแต่28/9/69 เป็นต้นไป",
        options: { locale: "th", datePolicy: { referenceDate: REFERENCE_DATE } }
      },
      {
        input: "รับประทาน 1 เม็ด ทุกวัน ตั้งแต่28/9/69 ต่อไป",
        ownedSpan: "ตั้งแต่28/9/69 ต่อไป",
        options: { locale: "th", datePolicy: { referenceDate: REFERENCE_DATE } }
      }
    ];

    for (const item of cases) {
      const { sign, tokens } = parseRawHpsgSign(item.input, item.options);
      expect(sign.synsem.head.schedule).toMatchObject({
        attachmentClass: "administration",
        boundsStart: "2026-09-28",
        frequency: 1,
        period: 1,
        periodUnit: "d"
      });
      expect(sign.synsem.head.schedule?.calendarEvents).toBeUndefined();
      expect(sign.synsem.valence.patientInstruction).toBeUndefined();
      const expectedStart = item.input.indexOf(item.ownedSpan);
      expect(sign.synsem.head.schedule?.sourceRanges).toEqual([{
        start: expectedStart,
        end: expectedStart + item.ownedSpan.length
      }]);
      const evidence = sign.evidence.find((value) => value.rule === "hpsg.lex.schedule.openEndedDate");
      expect(evidence).toBeDefined();
      const ownedTokens = tokens.filter((token) => evidence?.tokenIndices.includes(token.index));
      const ownedStart = Math.min(...ownedTokens.map((token) => token.sourceStart));
      const ownedEnd = Math.max(...ownedTokens.map((token) => token.sourceEnd));
      expect(item.input.slice(ownedStart, ownedEnd)).toBe(item.ownedSpan);

      const state = parseClauseState(item.input, item.options);
      const clause = state.primaryClause;
      expect(clause.schedule).toMatchObject({
        boundsStart: "2026-09-28",
        frequency: 1,
        period: 1,
        periodUnit: "d"
      });
      expect(clause.schedule?.calendarEvents).toBeUndefined();
      expect(clause.evidence).toContainEqual(expect.objectContaining({
        rule: "hpsg.lex.schedule.openEndedDate",
        scheduleFields: ["boundsStart"],
        spans: [expect.objectContaining({ text: item.ownedSpan })]
      }));
      expect(clause.instructionGraph, item.input).toBeUndefined();
      expect(clause.leftovers).toEqual([]);
      expect(clause.rawText).toBe(item.input);

      const fhir = canonicalToFhir(clause);
      expect(fhir.timing?.event).toBeUndefined();
      expect(fhir.timing?.repeat?.boundsPeriod).toEqual({ start: "2026-09-28" });
      expect(parseBatch(item.input, item.options).input).toBe(item.input);
    }
  });

  it("preserves conflicting date facts and keeps the continuation marker editable", () => {
    const input = "take 1 tab daily from 2026-09-20 on 2026-09-28 onwards";
    const state = parseClauseState(input, {
      locale: "en-GB",
      datePolicy: { referenceDate: REFERENCE_DATE }
    });
    const clause = state.primaryClause;
    expect(clause.schedule?.boundsStart).toBe("2026-09-20");
    expect(clause.schedule?.calendarEvents).toEqual([
      expect.objectContaining({ isoDate: "2026-09-28", sourceText: "2026-09-28" })
    ]);
    expect(clause.schedule?.evidence).toContainEqual(expect.objectContaining({
      rule: "hpsg.lex.schedule.calendarDateList",
      scheduleFields: ["calendarEvents"],
      spans: [expect.objectContaining({ text: "on 2026-09-28" })]
    }));
    expect(clause.leftovers).toContainEqual(expect.objectContaining({
      text: "onwards"
    }));
    expect(clause.rawText).toBe(input);
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


  it("keeps a full Thai explicit date list together before a recurring transition", () => {
    const result = parseSig(
      "รับประทานครั้งละ 1 เม็ด วันละครั้ง หลังอาหารเช้า. วันที่ 28/9/69, 1/10/69 และ 4/10/69 จากนั้น ทุกวันอาทิตย์",
      { locale: "th", datePolicy: { referenceDate: REFERENCE_DATE } }
    );

    expect(result.count).toBe(2);
    expect(result.items[0]?.meta.leftoverText).toBeUndefined();
    expect(result.items[0]?.fhir.timing).toMatchObject({
      event: ["2026-09-28", "2026-10-01", "2026-10-04"],
      repeat: {
        frequency: 1,
        period: 1,
        periodUnit: "d",
        when: ["PCM"]
      }
    });
    expect(result.items[1]?.meta.leftoverText).toBeUndefined();
    expect(result.items[1]?.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "wk",
      dayOfWeek: ["sun"],
      when: ["PCM"],
      boundsPeriod: { start: "2026-10-05" }
    });
    expect(nextDueDoses(result.items[1]!.fhir, {
      from: "2026-09-27T00:00:00+07:00",
      timeZone: "Asia/Bangkok",
      limit: 2
    })).toEqual([
      "2026-10-11T08:30:00+07:00",
      "2026-10-18T08:30:00+07:00"
    ]);
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

  it("accepts unambiguous English month-name dates in either textual order", () => {
    const cases = [
      "take 1 tab on 5 Oct 2026 at 08:00",
      "take 1 tab on Oct 5 2026 at 08:00",
      "take 1 tab on October 5, 2026 at 08:00",
      "รับประทาน 1 เม็ด on Oct 5 2026 เวลา 08:00"
    ];
    for (const input of cases) {
      const result = parseSig(input, {
        locale: "en-US",
        datePolicy: { referenceDate: REFERENCE_DATE }
      });
      expect(result.meta.leftoverText).toBeUndefined();
      expect(result.fhir.timing).toMatchObject({
        event: ["2026-10-05"],
        repeat: { timeOfDay: ["08:00:00"] }
      });
    }
  });

  it("keeps English month-name dates in day-month order under en-US locale", () => {
    const exact = parseSig("take 1 tab on 5 Oct 2026 at 08:00", {
      locale: "en-US",
      datePolicy: { referenceDate: REFERENCE_DATE }
    });
    expect(exact.meta.leftoverText).toBeUndefined();
    expect(exact.fhir.timing).toMatchObject({
      event: ["2026-10-05"],
      repeat: { timeOfDay: ["08:00:00"] }
    });

    const unambiguous = parseSig("take 1 tab on 28 Sep 2026 at 08:00", {
      locale: "en-US",
      datePolicy: { referenceDate: REFERENCE_DATE }
    });
    expect(unambiguous.meta.leftoverText).toBeUndefined();
    expect(unambiguous.fhir.timing?.event).toEqual(["2026-09-28"]);
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

  it("counts weekday and clock combinations in weekly FHIR frequency", () => {
    const result = parseSig(
      "รับประทาน 1 เม็ด ทุกวันจันทร์และวันพฤหัสบดี เวลา 09:30 และ 20:30 ถึงวันที่ 12/10",
      { locale: "th", datePolicy: { referenceDate: REFERENCE_DATE } }
    );
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 4,
      period: 1,
      periodUnit: "wk",
      dayOfWeek: ["mon", "thu"],
      timeOfDay: ["09:30:00", "20:30:00"],
      boundsPeriod: { end: "2026-10-12" }
    });
    expect(nextDueDoses(result.fhir, {
      from: "2026-09-27T00:00:00+07:00",
      timeZone: "Asia/Bangkok",
      limit: 6
    })).toEqual([
      "2026-09-28T09:30:00+07:00",
      "2026-09-28T20:30:00+07:00",
      "2026-10-01T09:30:00+07:00",
      "2026-10-01T20:30:00+07:00",
      "2026-10-05T09:30:00+07:00",
      "2026-10-05T20:30:00+07:00"
    ]);
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
  it("accepts explicit Buddhist DMY years in English clinical directions without overriding calendar policy", () => {
    const input = "Take 1 tab daily until 25/11/2569";
    const policy = { referenceDate: "2026-10-22" };
    const parsed = parseSig(input, { datePolicy: policy });
    expect(parsed.items[0]?.fhir.timing?.repeat?.boundsPeriod?.end).toBe("2026-11-25");
    expect(parsed.meta.leftoverText).toBeUndefined();
    const deliberatelyGregorian = parseSig(input, {
      datePolicy: { ...policy, calendars: ["gregory"] }
    });
    expect(deliberatelyGregorian.meta.leftoverText).toContain("until 25/11/2569");
    expect(deliberatelyGregorian.items[0]?.fhir.timing?.repeat?.boundsPeriod?.end).toBeUndefined();
  });

});

describe("monthly weekday ordinals survive without source prose", () => {
  it.each([
    ["last", -1, ["2026-11-27", "2026-12-25", "2027-01-29", "2027-02-26"]],
    ["third", 3, ["2026-11-20", "2026-12-18", "2027-01-15", "2027-02-19"]]
  ])("retains the typed %s Friday regardless of a later order-time anchor", (word, ordinal, expectedDates) => {
    const parsed = parseBatch(`Take 1 tablet on the ${word} Friday of each month at 08:00.`, {
      datePolicy: { referenceDate: "2026-11-01" }
    });
    expect(parsed.meta.canonical.clauses[0].schedule?.weekdayOrdinal).toBe(ordinal);
    const stripped = { ...parsed.fhir[0], text: undefined, patientInstruction: undefined };
    if (stripped.timing?.code) stripped.timing = { ...stripped.timing, code: { ...stripped.timing.code, text: undefined } };
    const course = toDosageDetails([stripped]);
    for (const dosage of [stripped, course, toFhirR5Dosages(course)]) {
      expect(nextDueDoses(dosage, {
        orderedAt: "2026-11-17T00:00:00+07:00", from: "2026-11-17T00:00:00+07:00",
        timeZone: "Asia/Bangkok", limit: 4
      }).map(at => at.slice(0, 10))).toEqual(expectedDates);
    }
    expect(canonicalFromFhir(stripped).schedule?.weekdayOrdinal).toBe(ordinal);
    expect(formatSig(stripped, "long", { locale: "en" })).toContain(`${word} Friday`);
    if (ordinal === -1) {
      expect(formatSig(stripped, "long", { locale: "th" })).toContain("ศุกร์สุดท้าย");
    }
  });
});


describe("Thai clock suffixes belong to the time constituent", () => {
  const orderedAt = "2026-11-02T00:00:00+07:00";
  it.each([
    "รับประทาน 1 เม็ด เวลา 08:00, 20:00 น. x7d",
    "รับประทาน 1 เม็ด เวลา 08:00 และ 20:00 น. นาน 7 วัน",
    "รับประทาน 1 เม็ด เวลา 08:00 น. และ 20:00 น. เป็นเวลา 7 วัน",
    "รับประทาน 1 เม็ด เวลา 08:00 และ 20:00 นาฬิกา เป็นเวลา 7 วัน"
  ])("does not lose a finite course after a normal Thai time-unit abbreviation: %s", input => {
    const parsed = parseBatch(input);
    expect(parsed.fhir).toHaveLength(1);
    expect(parsed.fhir[0].timing?.repeat?.timeOfDay).toEqual(["08:00:00", "20:00:00"]);
    expect(parsed.fhir[0].timing?.repeat?.boundsDuration?.value).toBe(7);
    for (const dosage of [parsed.fhirNext, parsed.fhir, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(calculateTotalUnits({ dosage, orderedAt, from: orderedAt,
        timeZone: "Asia/Bangkok", durationValue: 28, durationUnit: "d"
      }).totalUnits).toBe(14);
      expect(nextDueDoses(dosage, { orderedAt, from: "2026-11-09T00:00:00+07:00",
        timeZone: "Asia/Bangkok", limit: 2 })).toEqual([]);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });

  it("leaves a genuine following sentence boundary and its phase local", () => {
    const input = "รับประทาน 1 เม็ด เวลา 08:00 น. 7 วัน. จากนั้นรับประทาน 2 เม็ด เวลา 20:00 น. 7 วัน";
    const parsed = parseBatch(input);
    expect(parsed.fhirNext.step).toHaveLength(2);
    expect(parsed.fhir.map(row => row.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([1, 2]);
    expect(parsed.fhir.map(row => row.timing?.repeat?.timeOfDay)).toEqual([["08:00:00"], ["20:00:00"]]);
    expect(parsed.fhir.map(row => row.timing?.repeat?.boundsDuration?.value)).toEqual([7, 7]);
  });
});
