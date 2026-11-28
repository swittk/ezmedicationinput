import { fromFhir } from "../src/index";
import { parseInstructionActions } from "../src/index";
import { buildInstructionGraphExtension } from "../src/index";
import { parseInstructionGraphExtension } from "../src/index";
import { AdviceArgumentRole } from "../src/index";
import { setDosageCondition } from "../src/dosage-course";
import { simpleQuantityForR5 } from "../src/fhir-quantity-operator";
import { numericAdministrationLimits } from "../src/canonical/course";
import { convertQuantityValue } from "../src/utils/units";
import { getQuantityComparator } from "../src/fhir-quantity-operator";
import { importCanonicalCourse, projectCanonicalCourse, type FhirR6Extension, type FhirR6Dosage, EventTiming, type FhirR6DosageInstruction, type FhirR6Quantity } from "../src/index";
import { DOSAGE_RECONCILIATION_SOURCE_URL, PARALLEL_COMPONENT_PHASE_ORIGIN_URL } from "../src/dosage-course";
import { EMA_QUANTITY_COMPARATOR_EXTENSION_URL, EMA_QUANTITY_OPERATOR_SYSTEM } from "../src/fhir-quantity-operator";
import { TIMING_ADDITIONAL_CLOCK_EXTENSION_URL, getTimingClocks } from "../src/fhir";
import { courseToR6 } from "../src/adapters/canonical-course";
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
import { FhirPeriodUnit, type FhirDosage, type ParseOptions } from "../src/types";
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
      sourceText: (start, end) => input.slice(start, end),
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
    expect(dated.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
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
    expect(fraction.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({
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
    expect(dated.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
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
    expect(thai.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
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
    expect(bareAmbiguous.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
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
        durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(8);
    }
  });

  it("resolves attached Buddhist YMD dates in Thai medication context", () => {
    const options = { locale: "th", datePolicy: { referenceDate: "2026-10-22" } };
    const bounded = parseSig("รับประทาน 1 เม็ด ทุกวัน ถึง2569-11-01", options);
    expect(bounded.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
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
      expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
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
      const datePattern = /\d{4}-\d{2}-\d{2}/gu;
      let nextMatch: RegExpExecArray | null;
      while ((nextMatch = datePattern.exec(item.input)) !== null) {
        const match = nextMatch;
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
      expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
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
      const ownedTokens = tokens.filter((token) => evidence?.tokenIndices.some(index => index === token.index));
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

  it("counts both daily event anchors on each coordinated weekly weekday", () => {
    for (const [source, morning] of [
      ["รับประทาน 1 เม็ด ทุกวันจันทร์และวันพฤหัสบดี เช้าและเย็น", "08:00"],
      ["รับประทาน 1 เม็ด ทุกวันจันทร์และวันพฤหัสบดี ก่อนอาหารเช้าและหลังอาหารเย็น", "07:30"]
    ] as const) {
      const result = parseSig(source, { locale: "th" });
      const schedule = result.meta.canonical.clauses[0]?.schedule;
      expect(schedule).toMatchObject({
        frequency: 4, period: 1, periodUnit: "wk",
        dayOfWeek: ["mon", "thu"]
      });
      expect(schedule?.when).toHaveLength(2);
      expect(result.fhir.timing?.repeat).toMatchObject({
        frequency: 4, period: 1, periodUnit: "wk",
        dayOfWeek: ["mon", "thu"],
        when: schedule?.when
      });
      expect(nextDueDoses(result.fhir, {
        from: "2026-11-02T00:00:00+07:00",
        orderedAt: "2026-11-02T00:00:00+07:00",
        timeZone: "Asia/Bangkok",
        limit: 4
      })).toEqual([
        `2026-11-02T${morning}:00+07:00`,
        "2026-11-02T19:00:00+07:00",
        `2026-11-05T${morning}:00+07:00`,
        "2026-11-05T19:00:00+07:00"
      ]);
      expect(calculateTotalUnits({
        dosage: result.fhir,
        from: "2026-11-02T00:00:00+07:00",
        orderedAt: "2026-11-02T00:00:00+07:00",
        timeZone: "Asia/Bangkok",
        durationValue: 7, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(4);
      expect(result.meta.leftoverText).toBeUndefined();
    }
  });

  it("does not double count a morning qualifier for the same fixed clock", () => {
    const source = "รับประทาน 1 เม็ด ทุกวันจันทร์และวันพฤหัสบดี เวลา 08:00 ตอนเช้า";
    const result = parseBatch(source, { locale: "th" });
    const firstDosage = result.items[0].fhir;
    const clause = result.meta.canonical.clauses[0];
    const course = result.meta.canonical.course!;
    expect(clause.schedule).toMatchObject({
      frequency: 2, period: 1, periodUnit: "wk",
      dayOfWeek: ["mon", "thu"],
      timeOfDay: ["08:00:00"]
    });
    // Morning qualifies the authored clock; it is not another administration.
    expect(clause.schedule?.when).toBeUndefined();
    expect(course.stages[0].administrations[0].schedule?.recurrence?.anchors).toBeUndefined();
    expect(firstDosage.timing?.repeat?.frequency).toBe(2);
    expect(firstDosage.timing?.repeat?.when).toBeUndefined();
    expect(firstDosage.timing?.repeat?.timeOfDay).toEqual(["08:00:00"]);
    expect(result.fhirNext.step?.[0]).toBeDefined();
    const currentStep = result.fhirNext.step![0];
    expect(currentStep.component[0].timing?.repeat?.when).toBeUndefined();
    expect(currentStep.component[0].timing?.repeat?.timeOfDay).toEqual(["08:00:00"]);
    expect(nextDueDoses(firstDosage, {
      from: "2026-11-02T00:00:00+07:00",
      orderedAt: "2026-11-02T00:00:00+07:00",
      timeZone: "Asia/Bangkok",
      limit: 2
    })).toEqual([
      "2026-11-02T08:00:00+07:00",
      "2026-11-05T08:00:00+07:00"
    ]);

    const qualification = {
      rule: "hpsg.cx.schedule.fixed-clock-daypart-qualification",
      spans: [{ start: source.indexOf("ตอนเช้า"), end: source.length, text: "ตอนเช้า" }]
    };
    expect(clause.rawText).toBe(source);
    expect(clause.evidence).toContainEqual(expect.objectContaining(qualification));
    expect(course.instruction).toBe(source);
    expect(course.stages[0].administrations[0].syntax?.evidence)
      .toContainEqual(expect.objectContaining(qualification));
    expect(result.fhirNext.renderedInstruction).toBe(source);
    const coldR5: typeof result.fhir = JSON.parse(JSON.stringify(result.fhir));
    expect(coldR5[0].extension?.find(item =>
      item.url === "urn:ezmedicationinput:StructureDefinition:medication-rendered-instruction"
    )?.extension?.find(item => item.url === "instruction")?.valueString).toBe(source);

    const query = {
      from: "2026-11-02T00:00:00+07:00",
      orderedAt: "2026-11-02T00:00:00+07:00",
      timeZone: "Asia/Bangkok",
      eventClock: { MORN: "07:00" },
      limit: 2
    };
    for (const input of [course, result.fhir, result.fhirNext, coldR5]) {
      expect(nextDueDoses(input, query)).toEqual([
        "2026-11-02T08:00:00+07:00",
        "2026-11-05T08:00:00+07:00"
      ]);
      expect(calculateTotalUnits({
        ...query, dosage: input, durationValue: 7, durationUnit: FhirPeriodUnit.Day
      })).toMatchObject({ totalUnits: 2, unit: "tab", quantityKind: "scheduled" });
    }
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
        timeZone: "Asia/Bangkok", durationValue: 28, durationUnit: FhirPeriodUnit.Day
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

describe("explicit cadence with distributive weekday selectors", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const monday = ["2026-11-23T08:00:00+00:00", "2026-11-23T20:00:00+00:00"];
  const mondayFriday = [...monday, "2026-11-27T08:00:00+00:00", "2026-11-27T20:00:00+00:00"];
  const query = { orderedAt: "2026-11-23T00:00:00Z", from: "2026-11-23T00:00:00Z", timeZone: "UTC" };
  it.each([
    { locale: "th", source: "รับประทาน 1 เม็ด วันละ 2 ครั้ง ทุกวันจันทร์และวันศุกร์", days: ["mon", "fri"], due: mondayFriday },
    { locale: "th", source: "รับประทาน 1 เม็ด ทุกวันจันทร์และวันศุกร์ วันละ 2 ครั้ง", days: ["mon", "fri"], due: mondayFriday },
    { locale: "th", source: "รับประทาน 1 เม็ด วันละ 2 ครั้ง ทุกวันจันทร์", days: ["mon"], due: monday },
    { locale: "th", source: "รับประทาน 1 เม็ด ทุกวันจันทร์ วันละ 2 ครั้ง", days: ["mon"], due: monday },
    { locale: "th", source: "รับประทาน 1 เม็ด วันละ 2 ครั้ง วันจันทร์และวันศุกร์", days: ["mon", "fri"], due: mondayFriday },
    { locale: "en", source: "Take 1 tablet twice daily on Monday and Friday", days: ["mon", "fri"], due: mondayFriday },
    { locale: "en", source: "Take 1 tablet twice daily every Monday and Friday", days: ["mon", "fri"], due: mondayFriday }
  ])("retains each selected day beside the authored daily cadence: $source", ({ locale, source, days, due }) => {
    const expected = { frequency: 2, period: 1, periodUnit: "d", dayOfWeek: days };
    const raw = parseRawHpsgSign(source, { locale }).sign;
    expect(raw.synsem.head.schedule).toMatchObject(expected);
    const parsed = parseBatch(source, { locale });
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    expect(parsed.meta.canonical.clauses[0].dose).toEqual({ value: 1, unit: "tab" });
    expect(parsed.meta.canonical.clauses[0].schedule).toMatchObject(expected);
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.fhir[0].timing?.repeat).toMatchObject(expected);
    expect(parsed.fhirNext.step![0].component[0].timing?.repeat).toMatchObject(expected);
    const english = days.length === 1 ? "Take 1 tablet orally twice daily on Monday."
      : "Take 1 tablet orally twice daily on Monday and Friday.";
    const thai = days.length === 1 ? "รับประทานครั้งละ 1 เม็ด วันละ 2 ครั้ง ในวันจันทร์."
      : "รับประทานครั้งละ 1 เม็ด วันละ 2 ครั้ง ในวันจันทร์ และ วันศุกร์.";
    for (const input of [parsed.meta.canonical.course!, fresh(parsed.fhir), fresh(parsed.fhirNext),
      fresh(toDosageDetails(fresh(parsed.fhir)))]) {
      const before = fresh(input);
      expect(nextDueDoses(input, { ...query, limit: due.length + 1 })
        .filter(stamp => Date.parse(stamp) < Date.parse("2026-11-30T00:00:00Z"))).toEqual(due);
      expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 7,
        durationUnit: FhirPeriodUnit.Day })).toMatchObject({ totalUnits: due.length, unit: "tab" });
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toBe(english);
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" })).toBe(thai);
      expect(input).toEqual(before);
    }
  });

  it.each([
    { source: "รับประทาน 1 เม็ด ทุกวันจันทร์ เวลา 08:00", days: ["mon"], frequency: 1,
      due: ["2026-11-23T08:00:00+00:00"] },
    { source: "รับประทาน 1 เม็ด ทุกวันจันทร์และวันศุกร์ เวลา 08:00", days: ["mon", "fri"], frequency: 2,
      due: ["2026-11-23T08:00:00+00:00", "2026-11-27T08:00:00+00:00"] },
    { source: "รับประทาน 1 เม็ด สัปดาห์ละ 2 ครั้ง ทุกวันจันทร์และวันศุกร์ เวลา 08:00",
      days: ["mon", "fri"], frequency: 2,
      due: ["2026-11-23T08:00:00+00:00", "2026-11-27T08:00:00+00:00"] }
  ])("retains standalone or explicitly authored weekly cadence: $source", ({ source, days, frequency, due }) => {
    const parsed = parseBatch(source, { locale: "th" });
    const expected = { frequency, period: 1, periodUnit: "wk", dayOfWeek: days, timeOfDay: ["08:00:00"] };
    expect(parsed.meta.canonical.clauses[0].schedule).toMatchObject(expected);
    expect(parsed.fhir[0].timing?.repeat).toMatchObject(expected);
    expect(parsed.fhirNext.step![0].component[0].timing?.repeat).toMatchObject(expected);
    expect(parsed.meta.leftoverText).toBeUndefined();
    for (const input of [parsed.meta.canonical.course!, fresh(parsed.fhir), fresh(parsed.fhirNext)]) {
      expect(nextDueDoses(input, { ...query, limit: due.length + 1 })
        .filter(stamp => Date.parse(stamp) < Date.parse("2026-11-30T00:00:00Z"))).toEqual(due);
      expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 7,
        durationUnit: FhirPeriodUnit.Day })).toMatchObject({ totalUnits: due.length, unit: "tab" });
    }
  });
});


it.each([
  "รับประทาน 1 เม็ด ทุกวันจันทร์ ทุก 6 ถึง 8 ชั่วโมง",
  "รับประทาน 1 เม็ด ทุก 6 ถึง 8 ชั่วโมง ทุกวันจันทร์"
])("round65 retains a period-only interval beside the weekday restriction: %s", source => {
  const expected = { period: 6, periodMax: 8, periodUnit: "h", dayOfWeek: ["mon"] };
  const sign = parseRawHpsgSign(source, { locale: "th" }).sign;
  expect(sign.synsem.head.schedule).toMatchObject(expected);
  expect(sign.synsem.head.schedule?.frequency).toBeUndefined();
  expect(sign.synsem.head.schedule?.frequencyMax).toBeUndefined();
  const parsed = parseBatch(source, { locale: "th" });
  expect(parsed.meta.canonical.clauses[0].schedule).toMatchObject(expected);
  expect(parsed.meta.canonical.clauses[0].schedule?.frequency).toBeUndefined();
  expect(parsed.meta.canonical.clauses[0].schedule?.frequencyMax).toBeUndefined();
  expect(parsed.meta.leftoverText).toBeUndefined();
  for (const row of [parsed.fhir[0], parsed.fhirNext.step![0].component[0]]) {
    expect(row.timing?.repeat).toMatchObject(expected);
    expect(row.timing?.repeat?.frequency).toBeUndefined();
    expect(row.timing?.repeat?.frequencyMax).toBeUndefined();
  }
});


describe("monthly inferred clocks across a daylight-saving gap", () => {
  const orderedAt = "2026-02-08T02:30:00-05:00";
  const timeZone = "America/New_York";
  const monthly = (clock?: string): FhirDosage => ({
    doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
    timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Month,
      ...(clock ? { timeOfDay: [clock] } : {}) } },
  });

  it("keeps the original clock after the gap-adjusted cycle boundary in due doses and supply", () => {
    const dosage = monthly();
    expect({
      due: nextDueDoses(dosage, { orderedAt, timeZone, from: "2026-03-07T00:00:00-05:00", limit: 2 }),
      totalUnits: calculateTotalUnits({ dosage, orderedAt, timeZone,
        from: "2026-03-23T02:00:00-04:00", durationValue: 1, durationUnit: FhirPeriodUnit.Hour }).totalUnits,
    }).toEqual({ due: ["2026-03-08T03:30:00-04:00", "2026-03-23T02:30:00-04:00"], totalUnits: 1 });
  });

  it.each(["authored", "configured"] as const)("keeps %s clocks authoritative", owner => {
    const dosage = monthly(owner === "authored" ? "09:15:00" : undefined);
    const config = owner === "configured"
      ? { frequencyDefaults: { byFrequency: { "freq:2/per:1mo": ["09:15"] } } } : undefined;
    expect(nextDueDoses(dosage, { orderedAt, timeZone, config,
      from: "2026-03-07T00:00:00-05:00", limit: 2 }))
      .toEqual(["2026-03-08T09:15:00-04:00", "2026-03-23T09:15:00-04:00"]);
  });
});

// Preserved public-contract regressions in their subject suite.
{


const persist = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const q = (value: number) => ({ value, unit: "tab" });


// Retained boundary and strict-type suite from test/pr14-round21-boundaries.spec.ts.
{
// BEGIN PRESERVED round39_boundaries
const tablet = () => ({ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] });
const persist = <T>(input: T): T => JSON.parse(JSON.stringify(input));

describe("round34 positional clock primitive annotations", () => {
  const clocks = [null, "09:00:00", null, "17:00:00", null];
  const notes = ["leading", "nine", "middle", "seventeen", "trailing"].map(id => ({ id }));
  it.each(["R5", "R6"] as const)("keeps metadata-only slots out of clinical clocks through %s", boundary => {
    for (const mixed of [false, true]) {
      const timing = { repeat: {
        frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        ...(mixed ? { when: [EventTiming.Morning] } : {}),
        timeOfDay: clocks, _timeOfDay: notes,
      } };
      // JSON is the public wire boundary, including legal primitive null slots.
      const source = persist(boundary === "R5"
        ? [{ ...tablet(), timing }]
        : { step: [{ component: [{ ...tablet(), timing }] }] });
      const before = JSON.stringify(source);
      expect(getTimingClocks(timing.repeat)).toEqual(["09:00:00", "17:00:00"]);
      let wire = courseToR6(importCanonicalCourse(source));
      for (let save = 0; save < 3; save++) {
        const rows = persist(toFhirR5Dosages(wire));
        for (const candidate of [wire, rows]) {
          const native = importCanonicalCourse(candidate);
          expect(native.stages[0].administrations[0].schedule?.recurrence?.clocks)
            .toEqual(["09:00:00", "17:00:00"]);
          expect(formatSig(candidate, "long", { locale: "en", realizationMode: "normalized" })).toMatch(/0?9:00/u);
          const repeat = Array.isArray(candidate) ? candidate[0].timing!.repeat! : candidate.step![0].component[0].timing!.repeat!;
          if (mixed) {
            const active = repeat.extension!.filter(marker => marker.url === TIMING_ADDITIONAL_CLOCK_EXTENSION_URL);
            expect(active.map(marker => marker.valueTime ?? null)).toEqual(clocks);
            expect(active.map(marker => marker._valueTime)).toEqual(notes);
          } else {
            expect(repeat.timeOfDay).toEqual(clocks);
            expect(repeat._timeOfDay).toEqual(notes);
          }
          expect(nextDueDoses(candidate, {
            orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-01T00:00:00Z",
            timeZone: "UTC", eventClock: { MORN: "08:00" }, limit: 3,
          })).toEqual(mixed
            ? ["2026-12-01T08:00:00+00:00", "2026-12-01T09:00:00+00:00", "2026-12-01T17:00:00+00:00"]
            : ["2026-12-01T09:00:00+00:00", "2026-12-01T17:00:00+00:00", "2026-12-02T09:00:00+00:00"]);
        }
        wire = persist(toDosageDetails(rows));
      }
      expect(JSON.stringify(source)).toBe(before);
    }
  });
});

// END PRESERVED round39_boundaries
}


describe("round58 retained range source retirement", () => {
  const fresh = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
  const sourceRanges = (wire: FhirR6DosageInstruction) => {
    const ranges: NonNullable<FhirR6Extension["valueRange"]>[] = [];
    for (const history of wire.extension ?? []) {
      if (history.url !== DOSAGE_RECONCILIATION_SOURCE_URL) continue;
      for (const marker of history.extension ?? [])
        for (const component of marker.extension ?? []) {
          if (component.url !== "component") continue;
          for (const entry of component.extension ?? []) {
            if (entry.url !== "doseAndRate") continue;
            for (const field of entry.extension ?? [])
              if (field.url === "doseRange" && field.valueRange) ranges.push(field.valueRange);
          }
        }
    }
    return ranges;
  };
  const rangeInput = (variant: string) => {
    const low = { id: "r58-s2-authored-low", extension: [
      { url: "urn:clinic:low-note", valueString: "Keep the original endpoint annotation" },
    ], ...(variant === "valued low removed" ? { value: 1, unit: "drop" } : {}) };
    const input: FhirR6DosageInstruction = { id: "r58-s2-source", extension: [
      { url: "urn:clinic:course-note", valueString: "Keep the independent course annotation" },
    ], step: [{ component: [{ site: { concept: { text: "both eyes" } },
      doseAndRate: [{ type: { text: "ordered" }, doseRange: { low, high: {
        value: 2, unit: "drop", extension: [{ url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
          valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000050" } }],
      } } }],
    }] }] };
    const original = fresh(input);
    const saved = toFhirR5Dosages(input);
    // This is a new persisted caller object, prepared before its first API submission.
    const rows = fresh(saved);
    const originalRange = fresh(saved[0].doseAndRate![0].doseRange!);
    if (variant === "low removed" || variant === "valued low removed")
      delete rows[0].doseAndRate![0].doseRange!.low;
    else if (variant === "low replaced")
      rows[0].doseAndRate![0].doseRange!.low = { id: "r58-s2-current-low",
        extension: [{ url: "urn:clinic:current-low-note", valueString: "Current endpoint annotation" }] };
    else if (variant === "entry removed") delete rows[0].doseAndRate;
    return { input, original, rows, originalRange };
  };
  it.each(["unchanged", "low removed", "low replaced", "valued low removed", "entry removed"] as const)(
    "keeps the current range separate from complete retired endpoint source (%s)", variant => {
      const { input, original, rows, originalRange } = rangeInput(variant), before = fresh(rows);
      const expected = fresh(rows[0].doseAndRate ?? []);
      let wire = toDosageDetails(rows);
      for (let save = 0; save < 2; save++) {
        const component = wire.step![0].component[0];
        expect(component.doseAndRate ?? []).toEqual(expected);
        expect(component.site).toEqual({ concept: { text: "both eyes" } });
        expect(wire.id).toBe("r58-s2-source");
        expect(wire.extension).toContainEqual(original.extension![0]);
        const retained = sourceRanges(wire);
        if (variant === "unchanged") expect(retained).toEqual([]);
        else expect(retained).toContainEqual(originalRange);
        if (variant === "low removed" || variant === "valued low removed")
          expect(component.doseAndRate![0].doseRange!.low).toBeUndefined();
        const savedR6 = fresh(wire), savedBefore = fresh(savedR6);
        const returnedR5 = toFhirR5Dosages(savedR6);
        expect(returnedR5[0].doseAndRate ?? []).toEqual(expected);
        expect(savedR6).toEqual(savedBefore);
        wire = toDosageDetails(fresh(returnedR5));
      }
      expect(rows).toEqual(before);
      expect(input).toEqual(original);
    });
});


describe("round75 opaque temporal unit ownership", () => {
  const local = { id: "authored-interval", value: 7, unit: "treatment blocks",
    system: "urn:clinic:interval-units", code: "d", _value: { id: "interval-value" },
    extension: [{ url: "urn:clinic:interval-note", valueString: "keep the local definition" }] } satisfies FhirR6Quantity;
  const event = { contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] } };
  const member: FhirR6Dosage = { doseAndRate: [{ doseQuantity: q(1) }] };
  const locations = ["repeat-cycle", "start-offset", "stage-start", "stage-range"] as const;
  type Location = typeof locations[number];
  const source = (location: Location): FhirR6DosageInstruction => {
    if (location === "repeat-cycle") return { repeatCycle: local, step: [{ component: [member] }] };
    if (location === "start-offset") return { step: [{ component: [{ ...member, timing: { repeat: {
      frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, startOffset: local,
    } } }] }] };
    return { step: [{ start: { ...event, ...(location === "stage-start" ? { offsetDuration: local }
      : { offsetRange: { low: local, high: { ...local, value: 9 } } }) }, component: [member] }] };
  };
  const retained = (wire: FhirR6DosageInstruction, location: Location) => location === "repeat-cycle" ? wire.repeatCycle
    : location === "start-offset" ? wire.step![0].component[0].timing!.repeat!.startOffset
    : location === "stage-start" ? wire.step![0].start!.offsetDuration : wire.step![0].start!.offsetRange;

  it.each(locations)("keeps a local-coded %s uninterpreted in both languages and interchange forms", location => {
    const raw = source(location), snapshot = persist(raw);
    for (const input of [persist(raw), persist(toFhirR5Dosages(persist(raw)))]) {
      const before = persist(input);
      const native = importCanonicalCourse(input);
      for (const value of [input, native]) for (const locale of ["en", "th"] as const) {
        const text = formatSig(value, "long", { locale, realizationMode: "normalized" });
        expect(text).toContain("7 treatment blocks");
        expect(text).not.toMatch(/7 days|7 วัน/u);
        if (location === "stage-range") expect(text).toContain("9 treatment blocks");
        if (location === "stage-start") expect(text).not.toMatch(/No doses|งดยา/u);
        if (location === "repeat-cycle") expect(text).toContain(locale === "en"
          ? "Repeat-cycle interval: 7 treatment blocks." : "ระยะรอบการใช้ยา: 7 treatment blocks.");
      }
      let saved = projectCanonicalCourse(native).fhirNext;
      for (let pass = 0; pass < 2; pass++) {
        expect(retained(saved, location)).toEqual(retained(raw, location));
        saved = toDosageDetails(persist(toFhirR5Dosages(persist(saved))));
      }
      expect(input).toEqual(before);
    }
    expect(raw).toEqual(snapshot);
  });

  it("retains independently coded member offsets when their labels share a familiar local code", () => {
    const outer = { ...local, unit: "outer blocks", code: "mo", system: "urn:clinic:outer-intervals" };
    const inner = { ...local, value: 3, unit: "inner blocks", code: "mo", system: "urn:clinic:inner-intervals" };
    const raw: FhirR6DosageInstruction = { step: [{ start: { ...event, offsetDuration: outer }, component: [{ ...member,
      modifierExtension: [{ url: PARALLEL_COMPONENT_PHASE_ORIGIN_URL, valueQuantity: inner }],
    }] }] };
    for (const input of [persist(raw), persist(toFhirR5Dosages(persist(raw)))]) for (const locale of ["en", "th"] as const) {
      const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
      expect(text).toContain("7 outer blocks");
      expect(text).toContain("3 inner blocks");
      expect(text).not.toMatch(/7 months|3 months|7 เดือน|3 เดือน/u);
    }
  });

  it.each(["ucum", "uncoded"] as const)("keeps an understood %s repeat interval localized", kind => {
    const interval = { value: 7, unit: "days", ...(kind === "ucum" ? { system: "http://unitsofmeasure.org", code: "d" } : {}) };
    const raw: FhirR6DosageInstruction = { repeatCycle: interval, step: [{ component: [member] }] };
    for (const input of [persist(raw), persist(toFhirR5Dosages(persist(raw)))]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toContain("Repeat this schedule every 7 days");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" })).toContain("ทุก 7 วัน");
      expect(projectCanonicalCourse(importCanonicalCourse(input)).fhirNext.repeatCycle).toEqual(interval);
    }
  });
});
}


// Additional calendar and supply assertions retained from the review suites.
{

describe("cycle-day eligibility is not an unrestricted bedtime schedule", () => {
  const orderedAt = "2026-11-01T00:00:00Z";
  const base = { orderedAt, from: orderedAt, timeZone: "UTC", eventClock: { [EventTiming["Before Sleep"]]: "22:00" } };

  it("keeps fully anchored finite cycle dates executable without losing dose or route", () => {
    const parsed = parseBatch("1 cap PV HS on days 16-25 of every 28-day cycle starting 2026-11-01 for 3 cycles");
    for (const dosage of [parsed.fhir[0], parsed.fhir, parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(calculateTotalUnits({ dosage, ...base, durationValue: 84, durationUnit: FhirPeriodUnit.Day }).totalUnits)
        .toBe(30);
      const times = nextDueDoses(dosage, { ...base, limit: 100 });
      const current = importCanonicalCourse(dosage).stages[0].administrations[0];
      expect(current.route?.coding).toContainEqual(expect.objectContaining({ system: "http://snomed.info/sct", code: "16857009" }));
      expect(times).toHaveLength(30);
      expect(times[0]).toContain("2026-11-16T22:00:00");
      expect(times[times.length - 1]).toContain("2027-01-20T22:00:00");
      expect(times).toEqual([
        ...Array.from({ length: 10 }, (_, i) => `2026-11-${16 + i}T22:00:00+00:00`),
        ...Array.from({ length: 10 }, (_, i) => `2026-12-${14 + i}T22:00:00+00:00`),
        ...Array.from({ length: 10 }, (_, i) => `2027-01-${11 + i}T22:00:00+00:00`),
      ]);
    }
  });
});


describe("fractional quantity limits retain administration ownership", () => {
  it("keeps decimal and word-fraction caps equivalent without changing the dose or cadence", () => {
    const start = "2026-11-26T08:00:00Z";
    const sources = ["0.5 tablets", "half a tablet"].map(amount =>
      `Take 0.25 tablet q12h max ${amount} within 12 hours`);
    const parsed = sources.map(source => parseBatch(source));
    const facts = (rows: FhirDosage[]) => rows.map(row => ({
      doseAndRate: row.doseAndRate,
      timing: row.timing,
      maxDosePerPeriod: row.maxDosePerPeriod
    }));
    const expected = facts(parsed[0].fhir);
    for (let index = 0; index < parsed.length; index++) {
      const result = parsed[index];
      const strict = toFhirR5Dosages(result.fhirNext);
      expect(result.input).toBe(sources[index]);
      expect(result.meta.leftoverText).toBeUndefined();
      for (const rows of [result.fhir, strict]) {
        expect(rows).toHaveLength(1);
        expect(facts(rows)).toEqual(expected);
        expect(rows[0].doseAndRate).toHaveLength(1);
        expect(rows[0].doseAndRate?.[0].doseQuantity).toMatchObject({ value: 0.25, unit: "tab" });
        expect(rows[0].maxDosePerPeriod).toHaveLength(1);
        expect(rows[0].maxDosePerPeriod?.[0]).toMatchObject({
          numerator: { value: 0.5, unit: "tab" },
          denominator: { value: 12, code: "h" }
        });
        expect(rows[0].timing?.repeat).toMatchObject({ period: 12, periodUnit: "h" });
        expect(rows[0].timing?.repeat?.boundsDuration).toBeUndefined();
        expect(rows[0].timing?.repeat?.timeOfDay).toBeUndefined();
      }
      for (const dosage of [result, result.fhirNext, strict]) {
        expect(calculateTotalUnits({
          dosage, from: start, orderedAt: start, timeZone: "UTC",
          durationValue: 7, durationUnit: FhirPeriodUnit.Day
        })).toMatchObject({ totalUnits: 3.5, unit: "tab" });
      }
    }
  });
});

describe("quantity windows and infusion minute aliases", () => {
  it("keeps a numeric-window maximum separate from an administered rate", () => {
    const source = "Give max 4 mg/24h as needed for pain";
    const parsed = parseBatch(source);
    expect(parsed.input).toBe(source);
    for (const rows of [parsed.fhir, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(rows).toHaveLength(1);
      expect(rows[0].doseAndRate).toBeUndefined();
      expect(rows[0].maxDosePerPeriod).toHaveLength(1);
      expect(rows[0].maxDosePerPeriod?.[0]).toMatchObject({
        numerator: { value: 4, unit: "mg" },
        denominator: { value: 24, code: "h" }
      });
      expect(rows[0].asNeeded).toBe(true);
    }
  });

  it.each([["m", "min"], ["min", "min"], ["min", "m"]])(
    "measures an existing minute rate alias %s with duration alias %s",
    (rateUnit, durationUnit) => {
      const source = `Infuse IV at 2 mL/${rateUnit} for 30 ${durationUnit}`;
      const parsed = parseBatch(source);
      expect(parsed.input).toBe(source);
      for (const rows of [parsed.fhir, toFhirR5Dosages(parsed.fhirNext)]) {
        expect(rows[0].doseAndRate).toHaveLength(1);
        expect(rows[0].doseAndRate?.[0].doseQuantity).toBeUndefined();
        expect(rows[0].doseAndRate?.[0].rateQuantity).toMatchObject({
          value: 2, system: "http://unitsofmeasure.org", code: "mL/min"
        });
        expect(rows[0].timing?.repeat).toMatchObject({ count: 1, duration: 30, durationUnit: "min" });
        expect(rows[0].timing?.repeat?.boundsDuration).toBeUndefined();
      }
      expect(calculateTotalUnits({
        dosage: parsed.fhirNext, from: "2027-01-01T00:00:00Z", orderedAt: "2027-01-01T00:00:00Z",
        durationValue: 1, durationUnit: FhirPeriodUnit.Day, timeZone: "UTC"
      })).toMatchObject({ totalUnits: 60, unit: "mL" });
    }
  );
});

describe("ranged lifetime supply remains attainable", () => {
  const options = {
    from: "2027-01-01T00:00:00Z", orderedAt: "2027-01-01T00:00:00Z", timeZone: "UTC",
    durationValue: 1, durationUnit: FhirPeriodUnit.Day
  };
  const ranged = (maximum: number): FhirDosage => ({
    doseAndRate: [{ doseRange: {
      low: { value: 2, unit: "mL" }, high: { value: 3, unit: "mL" }
    } }],
    timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day,
      timeOfDay: ["08:00:00", "20:00:00"] } },
    maxDosePerLifetime: { value: maximum, unit: "mL" }
  });

  it.each([[3.5, 3], [4, 4], [5, 5]])("admits complete ranged doses under a %s mL lifetime limit", (maximum, expected) => {
    const row = ranged(maximum);
    for (const dosage of [row, toDosageDetails([row]), importCanonicalCourse([row])]) {
      const before = JSON.stringify(dosage);
      expect(calculateTotalUnits({ dosage, ...options })).toMatchObject({ totalUnits: expected, unit: "mL" });
      expect(nextDueDoses(dosage, { ...options, limit: 2 })).toEqual([
        "2027-01-01T08:00:00+00:00", "2027-01-01T20:00:00+00:00"
      ]);
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });

  it("intersects the lifetime allowance with each rolling-period maximum", () => {
    const row = ranged(3.5);
    row.timing!.repeat = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] };
    row.maxDosePerPeriod = [{ numerator: { value: 2.5, unit: "mL" },
      denominator: { value: 24, unit: "h", code: "h" } }];
    for (const dosage of [row, toDosageDetails([row]), importCanonicalCourse([row])]) {
      expect(calculateTotalUnits({ dosage, ...options, durationValue: 2 }).totalUnits).toBe(2.5);
    }
  });

  it("preserves the strict lower endpoint when counting feasible administrations", () => {
    const row = ranged(4);
    row.doseAndRate![0].doseRange!.low!.extension = [{
      url: "http://ema.europa.eu/fhir/extension/comparator", valueCoding: {
        system: "http://spor.ema.europa.eu/v1/lists/100000000008", code: "100000000051",
      },
    }];
    for (const dosage of [row, toDosageDetails([row]), importCanonicalCourse([row])]) {
      expect(calculateTotalUnits({ dosage, ...options }).totalUnits).toBe(3);
    }
  });

  it("allocates a lifetime allowance jointly across ordinary daily course cycles", () => {
    const row = ranged(4);
    row.timing!.repeat = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] };
    const relative = (value: number) => ({
      contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] },
      offsetDuration: { value, unit: "d", system: "http://unitsofmeasure.org", code: "d" }
    });
    const course: FhirR6DosageInstruction = {
      repeatCycle: { value: 1, unit: "d", code: "d" },
      step: [{ start: relative(0), end: relative(1), component: [{
        doseAndRate: row.doseAndRate, timing: row.timing,
        safety: { doseLimit: [{ scope: "lifetime", valueQuantity: { value: 4, unit: "mL" } }] }
      }] }]
    };
    for (const dosage of [course, toFhirR5Dosages(course), importCanonicalCourse(course)]) {
      expect(calculateTotalUnits({ dosage, ...options, durationValue: 2 }).totalUnits).toBe(4);
    }
  });
});


describe("recorded daily-cycle use replaces nominal history", () => {
  const options = { from: "2027-01-02T00:00:00Z", orderedAt: "2027-01-01T00:00:00Z",
    timeZone: "UTC", durationValue: 1, durationUnit: FhirPeriodUnit.Day };
  const source = (bounded = false): FhirR6DosageInstruction => ({
    repeatCycle: { value: 1, code: "d" }, step: [{
      ...(bounded ? { end: {
        contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] },
        offsetDuration: { value: 1, code: "d" }
      } } : {}),
      component: [{
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          timeOfDay: ["08:00:00"] } },
        safety: { doseLimit: [{ scope: "period", valueQuantity: { value: 2, unit: "tab" },
          period: { value: 48, code: "h" } }] }
      }]
    }]
  });
  const check = (course: FhirR6DosageInstruction, priorDoseTimes?: string[]) => {
    const offGrid = priorDoseTimes?.[0].includes("09:00");
    for (const dosage of [course, toFhirR5Dosages(course), importCanonicalCourse(course)]) {
      const before = JSON.stringify(dosage);
      expect(calculateTotalUnits({ dosage, ...options, priorDoseTimes }).totalUnits).toBe(1);
      expect(nextDueDoses(dosage, { ...options, priorDoseTimes, limit: 2 })).toEqual([
        "2027-01-02T08:00:00+00:00",
        offGrid ? "2027-01-04T08:00:00+00:00" : "2027-01-03T08:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ dosage, ...options, priorDoseTimes,
        from: "2027-01-04T00:00:00Z" }).totalUnits).toBe(1);
      expect(JSON.stringify(dosage)).toBe(before);
    }
  };

  it.each([undefined, "08:00", "09:00"])("keeps one administration for recorded time %s", clock => {
    check(source(), clock ? [`2027-01-01T${clock}:00Z`] : undefined);
  });

  it("uses the same history ownership with an explicit one-day stage window", () => {
    check(source(true), ["2027-01-01T09:00:00Z"]);
  });
});


describe("recognized duration labels and qualified scheduling quantities", () => {
  it.each([
    [undefined, "urn:clinic:time", true],
    ["d", "http://unitsofmeasure.org", true],
    ["d", "urn:clinic:time", false]
  ] as const)("resolves duration labels without reinterpreting a foreign code (%s, %s)", (code, system, resolved) => {
    const unit = { unit: "days", system, ...(code ? { code } : {}) };
    const dosage: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["08:00:00"], boundsRange: { low: { value: 5, ...unit }, high: { value: 7, ...unit } } } }
    };
    const before = JSON.stringify(dosage);
    const query = () => nextDueDoses(dosage, { orderedAt: "2026-11-01T00:00:00Z",
      from: "2026-11-01T00:00:00Z", timeZone: "UTC", limit: 10 });
    if (resolved) {
      expect(query()).toEqual([
        "2026-11-01T08:00:00+00:00", "2026-11-02T08:00:00+00:00", "2026-11-03T08:00:00+00:00",
        "2026-11-04T08:00:00+00:00", "2026-11-05T08:00:00+00:00", "2026-11-06T08:00:00+00:00",
        "2026-11-07T08:00:00+00:00"
      ]);
    } else {
      expect(query).toThrowError(expect.objectContaining({ code: "course-duration-unresolved" }));
    }
    expect(JSON.stringify(dosage)).toBe(before);
  });

  it.each(["not greater than", "not more than"])("keeps a PRN dose and its %s daily maximum", lead => {
    const source = "Take 1 tablet every 6 hours as needed for pain; " + lead + " 4 tablets per day";
    const parsed = parseBatch(source);
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    expect(parsed.meta.canonical.clauses[0].dose).toEqual({ value: 1, unit: "tab" });
    expect(parsed.meta.canonical.clauses[0].schedule).toMatchObject({
      period: 6, periodUnit: "h", maxDosePerPeriod: [{ amount: 4, unit: "tab", period: 1, periodUnit: "d" }]
    });
    const maximum = parsed.meta.canonical.clauses[0].schedule!.maxDosePerPeriod![0];
    expect(maximum.amountComparator ?? "<=").toBe("<=");
    expect(maximum.periodComparator).toBeUndefined();
    const projected = toFhirR5Dosages(parsed.fhirNext);
    expect(parsed.fhir).toHaveLength(1);
    expect(projected).toHaveLength(1);
    for (const row of [...parsed.fhir, ...projected]) {
      expect(row.doseAndRate?.[0].doseQuantity).toMatchObject({ value: 1, unit: "tab" });
      expect(row.asNeeded).toBe(true);
      expect(row.maxDosePerPeriod).toMatchObject([
        { numerator: { value: 4, unit: "tab" }, denominator: { value: 1, unit: "d" } }
      ]);
      expect(getQuantityComparator(row.maxDosePerPeriod![0].numerator) ?? "<=").toBe("<=");
      expect(getQuantityComparator(row.maxDosePerPeriod![0].denominator)).toBeUndefined();
    }
    const query = { from: "2026-12-01T00:00:00Z", orderedAt: "2026-12-01T00:00:00Z", timeZone: "UTC", limit: 4 };
    for (const dosage of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      expect(nextDueDoses(dosage, query)).toEqual([
        "2026-12-01T00:00:00+00:00", "2026-12-01T06:00:00+00:00",
        "2026-12-01T12:00:00+00:00", "2026-12-01T18:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ dosage, ...query, durationValue: 1, durationUnit: FhirPeriodUnit.Day }))
        .toMatchObject({ totalUnits: 4, unit: "tab" });
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it.each([
    ["no more than", " per 2 hours"], ["no more than", " per 2h"],
    ["no more than", "/2h"], ["maximum", " per 2 hours"]
  ])("keeps a numeric-window %s ceiling%s on a PRN dose", (lead, period) => {
    const source = "Give 5 mg as needed, " + lead + " 10 mg" + period;
    const parsed = parseBatch(source);
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    expect(parsed.meta.canonical.clauses[0].dose).toEqual({ value: 5, unit: "mg" });
    expect(parsed.meta.canonical.clauses[0].schedule?.maxDosePerPeriod)
      .toEqual([{ amount: 10, unit: "mg", period: 2, periodUnit: "h" }]);
    const projected = toFhirR5Dosages(parsed.fhirNext);
    expect(parsed.fhir).toHaveLength(1);
    expect(projected).toHaveLength(1);
    for (const row of [...parsed.fhir, ...projected]) {
      expect(row.asNeeded).toBe(true);
      expect(row.doseAndRate?.[0].doseQuantity).toMatchObject({ value: 5, unit: "mg" });
      expect(row.doseAndRate?.[0].rateQuantity).toBeUndefined();
      expect(row.doseAndRate?.[0].rateRatio).toBeUndefined();
      expect(row.maxDosePerPeriod).toMatchObject([
        { numerator: { value: 10, unit: "mg" }, denominator: { value: 2, unit: "h" } }
      ]);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it.each([["2.30", "14:30:00"], ["2", "14:00:00"]])(
    "keeps the comparative clock %s pm out of the dose quantity", (clock, expected) => {
      const source = "Take around " + clock + " pm", parsed = parseBatch(source);
      expect(parsed.meta.canonical.clauses[0].dose).toBeUndefined();
      expect(parsed.fhir).toHaveLength(1);
      expect(parsed.fhirNext.step).toHaveLength(1);
      const [currentStep] = parsed.fhirNext.step!;
      expect(currentStep.component).toHaveLength(1);
      const reopened = toFhirR5Dosages(parsed.fhirNext);
      expect(reopened).toHaveLength(1);
      for (const row of [parsed.fhir[0], currentStep.component[0], reopened[0]]) {
        expect(row.doseAndRate?.[0]?.doseQuantity).toBeUndefined();
        expect(row.timing?.repeat?.timeOfDay).toEqual([expected]);
        expect(row.timing?.repeat?.when).toBeUndefined();
      }
      expect(parsed.fhirNext.renderedInstruction).toBe(source);
    }
  );
});


describe("supported compound quantity annotations", () => {
  const quantity = (code: string, system = "http://unitsofmeasure.org") => ({ code, system });
  it("uses the existing dimensional conversion for annotations on either term", () => {
    expect(convertQuantityValue(1, quantity("mg{drug}/kg"), quantity("mg/kg"))).toBe(1);
    expect(convertQuantityValue(1, quantity("mg{drug}/kg{patient}"), quantity("g/kg"))).toBe(0.001);
    expect(convertQuantityValue(1, quantity("mL{solution}/kg"), quantity("L/kg"))).toBe(0.001);
  });
  it("retains normalized-weight, case-sensitive and opaque code distinctions", () => {
    expect(convertQuantityValue(1, quantity("mg{drug}/kg"), quantity("mg"))).toBeNull();
    expect(convertQuantityValue(1, quantity("ML{solution}"), quantity("mL"))).toBeNull();
    expect(convertQuantityValue(1, quantity("mg{drug}/kg", "https://example.org/local-units"), quantity("mg/kg"))).toBeNull();
    expect(convertQuantityValue(1, quantity("dose{local}", "https://example.org/local-units"),
      quantity("dose{local}", "https://example.org/local-units"))).toBe(1);
  });
});


describe("concentration across a shared patient-weight denominator", () => {
  it("applies a mass-per-kg cap to volume-per-kg doses without inventing patient weight", () => {
    const strength = { numerator: { value: 2, unit: "mg" }, denominator: { value: 1, unit: "mL" } };
    expect(convertQuantityValue(1, { unit: "mL/kg" }, { unit: "mg/kg" }, strength)).toBe(2);
    expect(convertQuantityValue(3, { unit: "mg/kg" }, { unit: "mL/kg" }, strength)).toBe(1.5);
    expect(convertQuantityValue(1, { unit: "mL" }, { unit: "mg/kg" }, strength)).toBeNull();
    expect(convertQuantityValue(1, { unit: "mL/kg" }, { unit: "mg" }, strength)).toBeNull();
    const row: FhirDosage = {
      id: "per-weight-dose",
      doseAndRate: [{ doseQuantity: { id: "dose", value: 1, unit: "mL/kg",
        system: "http://unitsofmeasure.org", code: "mL/kg",
        extension: [{ url: "https://clinic.example/dose-note", valueString: "per kilogram volume" }] } }],
      timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["08:00:00", "20:00:00"] } },
      maxDosePerPeriod: [{ numerator: { id: "cap", value: 3, unit: "mg/kg",
        system: "http://unitsofmeasure.org", code: "mg/kg",
        extension: [{ url: "https://clinic.example/cap-note", valueString: "per kilogram mass" }] },
        denominator: { value: 24, unit: "h", system: "http://unitsofmeasure.org", code: "h" } }]
    };
    const original = JSON.stringify(row), r6 = toDosageDetails([row]);
    const restored = toFhirR5Dosages(JSON.parse(JSON.stringify(r6)));
    expect(restored).toHaveLength(1);
    expect(restored[0].doseAndRate![0].doseQuantity).toEqual(row.doseAndRate![0].doseQuantity);
    expect(restored[0].maxDosePerPeriod).toEqual(row.maxDosePerPeriod);
    for (const dosage of [importCanonicalCourse([row]), JSON.parse(JSON.stringify([row])),
      JSON.parse(JSON.stringify(r6))]) {
      const before = JSON.stringify(dosage);
      const member = importCanonicalCourse(dosage).stages[0].administrations[0];
      expect(member.amounts?.[0].quantity).toMatchObject({ value: 1, unit: "mL/kg" });
      expect(member.limits?.[0]).toMatchObject({ scope: "period", amount: { value: 3, unit: "mg/kg" },
        period: { value: 24, unit: "h" } });
      expect(calculateTotalUnits({ dosage, context: { strength: "2 mg/mL" },
        orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-01T00:00:00Z", timeZone: "UTC",
        durationValue: 1, durationUnit: FhirPeriodUnit.Day }))
        .toMatchObject({ totalUnits: 1, unit: "mL/kg" });
      expect(JSON.stringify(dosage)).toBe(before);
    }
    expect(JSON.stringify(row)).toBe(original);
  });
});

// Preserved public-contract regressions in their subject suite.
{



// Retained boundary and strict-type suite from test/pr14-round21-boundaries.spec.ts.
{
const persist = <T>(input: T): T => JSON.parse(JSON.stringify(input));

describe("round33 scalar R5 quantity meaning", () => {
  it.each(["mL/h", "mg/h"])("renders a source-less scalar %s rate through public scalar paths", unit => {
    const row: FhirDosage = { doseAndRate: [{ rateQuantity: { value: 5, unit } }] };
    const before = JSON.stringify(row);
    for (const locale of ["en", "th"]) {
      expect(formatSig(row, "long", { locale })).toContain("5 " + unit);
      expect(fromFhirDosage(row, { locale }).longText).toContain("5 " + unit);
    }
    expect(JSON.stringify(row)).toBe(before);
    const authored = { ...row, text: "Infuse five units hourly, per the original instruction." };
    expect(formatSig(authored, "long", { realizationMode: "roundtrip" }).split("; original directions: "))
      .toEqual([`Current: Use; Rate: 5 ${unit}`, authored.text]);
  });

  it.each(["mg", "mL"])("keeps code-only %s units in equal-unit dose ranges", code => {
    const quantity = (value: number) => ({ value, system: "http://unitsofmeasure.org", code });
    const row: FhirDosage = { doseAndRate: [{ doseRange: { low: quantity(2), high: quantity(5) } }] };
    const before = JSON.stringify(row);
    for (const locale of ["en", "th"]) {
      const parsed = fromFhirDosage(row, { locale });
      expect(parsed.meta.canonical.clauses[0].dose).toMatchObject({ range: { low: 2, high: 5 }, unit: code });
      expect(parsed.meta.normalized.unit).toBe(code);
      expect(formatSig(row, "long", { locale })).toContain(locale === "en" ? code :
        code === "mg" ? "มิลลิกรัม" : "มิลลิลิตร");
    }
    expect(JSON.stringify(row)).toBe(before);
  });

  it.each(["<", "<=", "~"] as const)("does not expose a qualified %s upper bound as an inclusive compact dose", comparator => {
    const row: FhirDosage = { doseAndRate: [{ doseRange: {
      low: { value: 2, unit: "mg" },
      high: simpleQuantityForR5({ value: 5, unit: "mg", comparator })!
    } }] };
    const before = JSON.stringify(row);
    const parsed = fromFhirDosage(row);
    expect(parsed.meta.canonical.clauses[0].dose).toBeUndefined();
    expect(parsed.meta.canonical.administration!.amounts![0].range!.high)
      .toMatchObject({ value: 5, unit: "mg", comparator });
    expect(JSON.stringify(row)).toBe(before);
    const ordinary = fromFhirDosage({ doseAndRate: [{ doseRange: {
      low: { value: 2, unit: "mg" }, high: { value: 5, unit: "mg" }
    } }] });
    expect(ordinary.meta.canonical.clauses[0].dose).toMatchObject({ range: { low: 2, high: 5 }, unit: "mg" });
  });
});

describe("round34 compact range and maximum ownership", () => {
  it.each(["authored", "coded"] as const)("keeps %s mixed-unit endpoints out of compact dose metadata", kind => {
    const range = kind === "authored"
      ? { low: { value: 500, unit: "mcg" }, high: { value: 1, unit: "mg" } }
      : { low: { value: 500, system: "http://unitsofmeasure.org", code: "ug" },
          high: { value: 1, system: "http://unitsofmeasure.org", code: "mg" } };
    const row: FhirDosage = { doseAndRate: [{ doseRange: range }] };
    const raw: FhirR6DosageInstruction = { step: [{ component: [persist(row)] }] };
    const before = JSON.stringify([row, raw]);
    expect(fromFhirDosage(row).meta.canonical.clauses[0].dose).toBeUndefined();
    expect(fromFhir(raw).meta.canonical.clauses[0].dose).toBeUndefined();
    for (const input of [row, raw]) {
      const amount = importCanonicalCourse(input).stages[0].administrations[0].amounts![0];
      expect(amount.range).toEqual(range);
      const text = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(text).toMatch(kind === "authored" ? /(?:^|\D)500 mcg\b/u : /(?:^|\D)500 ug\b/u);
      expect(text).toMatch(/(?:^|\D)1 mg\b/u);
      expect(text).not.toContain("500 to 1");
    }
    expect(JSON.stringify([row, raw])).toBe(before);
  });

  it.each(["low", "high", "both"] as const)("retains the known code-only %s endpoint unit in both editable views", known => {
    const unit = { system: "http://unitsofmeasure.org", code: "mg" };
    const range = {
      low: { value: 2, ...(known === "high" ? {} : unit) },
      high: { value: 5, ...(known === "low" ? {} : unit) },
    };
    const row: FhirDosage = { doseAndRate: [{ doseRange: range }] };
    const raw: FhirR6DosageInstruction = { step: [{ component: [persist(row)] }] };
    const before = JSON.stringify([row, raw]);
    for (const result of [fromFhirDosage(row), fromFhir(raw)]) {
      if (known === "both") {
        expect(result.meta.canonical.clauses[0].dose).toEqual({ range: { low: 2, high: 5 }, unit: "mg" });
        expect(result.meta.normalized.unit).toBe("mg");
      } else {
        expect(result.meta.canonical.clauses[0].dose).toBeUndefined();
        expect(result.meta.normalized.unit).toBeUndefined();
      }
    }
    for (const input of [row, raw]) {
      expect(importCanonicalCourse(input).stages[0].administrations[0].amounts![0].range).toEqual(range);
      for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        if (known === "both")
          expect(text).toContain(locale === "en" ? "2 to 5 mg" : "2 ถึง 5 มิลลิกรัม");
        else {
          expect(text).toContain(known === "low" ? "2 mg – 5" : "2 – 5 mg");
          expect(text).not.toContain("2 to 5 mg");
          expect(text).not.toContain("2 ถึง 5 มิลลิกรัม");
        }
      }
    }
    const rows = toFhirR5Dosages(raw), reopened = toDosageDetails(persist(rows));
    expect(rows[0].doseAndRate![0].doseRange).toEqual(range);
    expect(reopened.step![0].component[0].doseAndRate![0].doseRange).toEqual(range);
    expect(JSON.stringify([row, raw])).toBe(before);
  });

  it.each(["administration", "lifetime"] as const)("keeps a usable %s maximum regardless of a unitless limit's position", scope => {
    const unitless = { scope, valueQuantity: { value: 10, id: "unit-not-supplied" } };
    const known = { scope, valueQuantity: { value: 5, unit: "mg", id: "known-maximum" } };
    for (const limits of [[unitless, known], [known, unitless]]) {
      const raw: FhirR6DosageInstruction = { step: [{ component: [{ safety: { doseLimit: limits } }] }] };
      const before = JSON.stringify(raw);
      for (const input of [raw, toFhirR5Dosages(raw)]) {
        const member = importCanonicalCourse(input).stages[0].administrations[0];
        const bounds = numericAdministrationLimits(member);
        expect(bounds[scope]).toEqual(known.valueQuantity);
        expect(bounds.multiple).toBe(true);
        expect(member.limits).toHaveLength(2);
      }
      expect(JSON.stringify(raw)).toBe(before);
    }
  });
});

// END PRESERVED round39_boundaries
}


it("keeps an independently supplied OR condition beside its authored administration", () => {
  const persist = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const directions = "Swallow 1 tablet whole";
  const actions = parseInstructionActions(directions);
  const row: FhirDosage = { method: { text: "Swallow" },
    doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
    extension: [buildInstructionGraphExtension({ sourceText: directions, sourceLocale: "en",
      actions, primaryAdministrationSpan: actions[0].span,
      primaryOwnership: { administrationActionIndex: 0, dose: { actionIndex: 0,
        argumentIndex: actions[0].args.findIndex(argument => argument.role === AdviceArgumentRole.Amount) } } })!] };
  setDosageCondition(row, { kind: "any", conditions: [
    { kind: "measurement", name: "SBP", operation: "gt", value: 160, text: "SBP > 160" },
    { kind: "state", name: "dizziness", expected: true, text: "dizziness" }
  ] });
  const current = toDosageDetails([persist(row)]);
  for (const input of [[row], importCanonicalCourse([persist(row)]), persist(current), persist(toFhirR5Dosages(current))]) {
    expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
      .toBe("Swallow 1 tablet whole only if SBP > 160 or dizziness.");
    expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
      .toBe("กลืน 1 เม็ดทั้งเม็ด เฉพาะเมื่อ SBP > 160 หรือ dizziness.");
    const clause = importCanonicalCourse(input).stages[0].administrations[0];
    expect(clause.predicate).toMatchObject({ kind: "any", conditions: [
      { kind: "measurement", name: "SBP", operation: "gt", value: 160 }, { kind: "state", name: "dizziness", expected: true }
    ] });
  }
  expect(parseInstructionGraphExtension(row.extension)?.sourceText).toBe(directions);
});
}

}
