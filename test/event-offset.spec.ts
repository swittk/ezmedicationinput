import { describe, expect, it } from "vitest";
import {
  formatSig,
  calculateTotalUnits,
  fromFhirDosage,
  getDosageAlternativeChoice,
  nextDueDoses,
  TIMING_OFFSET_EXACT_EXTENSION_URL,
  TIMING_OFFSET_MIN_EXTENSION_URL,
  toDosageDetails,
  toFhirR5Dosages
} from "../src";
import { parseSig } from "./helpers/r5-parser";

describe("relative event-offset grammar", () => {
  it.each([
    {
      source: "กินยา 1 เม็ด เช้าเย็นหลังอาหาร 7 วัน",
      when: ["PCM", "PCV"]
    },
    {
      source: "กินยา 1 เม็ด วันละ 2 ครั้ง หลังอาหาร 7 วัน",
      when: ["PC"]
    }
  ])("keeps a Thai seven-day course outside the meal event offset: $source", ({ source, when }) => {
    const parsed = parseSig(source, { locale: "th" });
    const clause = parsed.meta.canonical.clauses[0];

    expect(clause?.rawText).toBe(source);
    expect(clause?.dose).toEqual({ value: 1, unit: "tab" });
    expect(clause?.schedule).toMatchObject({
      frequency: 2,
      period: 1,
      periodUnit: "d",
      duration: 7,
      durationUnit: "d",
      when
    });
    expect(clause?.schedule?.offset).toBeUndefined();
    expect(parsed.fhir.timing?.repeat).toMatchObject({
      frequency: 2,
      period: 1,
      periodUnit: "d",
      boundsDuration: { value: 7, code: "d" },
      when
    });
    expect(parsed.fhir.timing?.repeat?.offset).toBeUndefined();
    expect(parsed.meta.leftoverText).toBeUndefined();

    const strictR5 = toFhirR5Dosages(parsed.fhirNext);
    const restoredR6 = toDosageDetails(strictR5);
    for (const repeat of [
      strictR5[0]?.timing?.repeat,
      restoredR6.step[0]?.component[0]?.timing?.repeat
    ]) {
      expect(repeat).toMatchObject({
        frequency: 2,
        period: 1,
        periodUnit: "d",
        boundsDuration: { value: 7, code: "d" },
        when
      });
      expect(repeat?.offset).toBeUndefined();
    }
    const reopened = fromFhirDosage(parsed.fhir);
    expect(reopened.meta.canonical.clauses[0]?.schedule).toMatchObject({
      frequency: 2,
      duration: 7,
      durationUnit: "d",
      when
    });
    expect(reopened.meta.canonical.clauses[0]?.schedule?.offset).toBeUndefined();

    const english = formatSig(parsed.fhirNext, "long", { locale: "en" });
    const thai = formatSig(parsed.fhirNext, "long", { locale: "th" });
    expect(english).toMatch(/twice daily/iu);
    expect(english).toMatch(/after (?:breakfast.*dinner|meals)/iu);
    expect(english).toMatch(/for 7 days/iu);
    expect(thai).toMatch(/วันละ 2 ครั้ง/u);
    expect(thai).toMatch(/หลังอาหาร/u);
    expect(thai).toMatch(/7 วัน/u);
    if (when.length === 2) {
      expect(nextDueDoses(parsed.fhir, {
        timeZone: "UTC",
        eventClock: { PCM: "08:30", PCV: "19:00" },
        orderedAt: "2024-01-01T06:00:00Z",
        from: "2024-01-01T06:00:00Z",
        limit: 3
      })).toEqual([
        "2024-01-01T08:30:00+00:00",
        "2024-01-01T19:00:00+00:00",
        "2024-01-02T08:30:00+00:00"
      ]);
    }
  });

  it.each([
    ["กินยา 1 เม็ด เช้าและเย็นก่อนอาหาร 3 วัน", 2, ["ACM", "ACV"], 3],
    ["กินยา 1 เม็ด เช้ากลางวันเย็นหลังอาหาร 5 วัน", 3, ["PCM", "PCD", "PCV"], 5],
    ["Take 1 tablet morning and evening after meals for 7 days", 2, ["PCM", "PCV"], 7]
  ] as const)("scopes a shared meal relation over typed dayparts: %s",
    (source, frequency, when, duration) => {
      const parsed = parseSig(source, { locale: /[ก-๙]/u.test(source) ? "th" : "en" });
      expect(parsed.meta.canonical.clauses[0]?.schedule).toMatchObject({
        frequency, period: 1, periodUnit: "d", when, duration, durationUnit: "d"
      });
      expect(parsed.fhir.timing?.repeat?.offset).toBeUndefined();
      expect(parsed.meta.leftoverText).toBeUndefined();
    });

  it("keeps explicit meal and non-meal offsets distinct from course duration", () => {
    const afterMeal = parseSig("กินยา 1 เม็ด หลังอาหาร 30 นาที", { locale: "th" });
    expect(afterMeal.meta.canonical.clauses[0]?.schedule).toMatchObject({
      when: ["PC"], offset: 30
    });
    expect(afterMeal.meta.canonical.clauses[0]?.schedule?.duration).toBeUndefined();

    const beforeMeal = parseSig("กินยา 1 เม็ด ก่อนอาหารครึ่งชั่วโมง", { locale: "th" });
    expect(beforeMeal.meta.canonical.clauses[0]?.schedule).toMatchObject({
      when: ["AC"], offset: 30
    });
    expect(beforeMeal.meta.canonical.clauses[0]?.schedule?.duration).toBeUndefined();

    for (const [source, field] of [
      ["Take after meals at least 1 day", "offsetMin"],
      ["Take after meals at most 1 day", "offsetMax"]
    ] as const) {
      const boundedMealDay = parseSig(source);
      expect(boundedMealDay.meta.canonical.clauses[0]?.schedule).toMatchObject({
        when: ["PC"], [field]: 1440
      });
      expect(boundedMealDay.meta.canonical.clauses[0]?.schedule?.duration).toBeUndefined();
      expect(boundedMealDay.meta.leftoverText).toBeUndefined();
    }

    const nonMealDayOffset = parseSig("Take 1 tablet 2 days before exercise");
    expect(nonMealDayOffset.meta.canonical.clauses[0]?.schedule?.activityTiming?.[0])
      .toMatchObject({ relation: "before", activity: { text: "exercise" }, offset: 2880 });
    expect(nonMealDayOffset.meta.canonical.clauses[0]?.schedule?.duration).toBeUndefined();
    expect(nonMealDayOffset.meta.leftoverText).toBeUndefined();
  });

  it.each([
    "Take 1 tablet daily for an additional 7 days",
    "กินยา 1 เม็ด วันละครั้ง อีก 7 วัน"
  ])("keeps a preposed quantity modifier inside its duration constituent: %s", source => {
    const parsed = parseSig(source, { locale: /[ก-๙]/u.test(source) ? "th" : "en" });
    expect(parsed.meta.canonical.clauses[0]?.schedule).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d",
      duration: 7,
      durationUnit: "d"
    });
    expect(parsed.fhir.timing?.repeat?.boundsDuration).toMatchObject({ value: 7, code: "d" });
    expect(parsed.meta.leftoverText).toBeUndefined();
  });

  it.each([
    ["Take before meals at least half an hour", "offsetMin", 30],
    ["take before meals at least half hour", "offsetMin", 30],
    ["take before meals at least 0.5 hour", "offsetMin", 30],
    ["take before meals half an hour", "offset", 30],
    ["take before meals half hour", "offset", 30],
    ["take before meals half a day", "offset", 720],
    ["take before meals half day", "offset", 720],
    ["take before meals half a minute", "offset", 0.5],
    ["take before meals half minute", "offset", 0.5]
  ] as const)("parses %s compositionally", (source, field, value) => {
    const parsed = parseSig(source);
    const schedule = parsed.meta.canonical.clauses[0]?.schedule;
    expect(schedule?.[field]).toBe(value);
    expect(schedule?.when).toEqual(["AC"]);
    expect(schedule?.duration).toBeUndefined();
    expect(parsed.meta.leftoverText).toBeUndefined();
  });

  it.each([
    ["take 1 cap 30 min before breakfast", "offset", 30],
    ["take 1 cap half an hour before breakfast", "offset", 30],
    ["take 1 cap at least half an hour before breakfast", "offsetMin", 30]
  ] as const)("parses quantity-first event offsets in %s", (source, field, value) => {
    const parsed = parseSig(source);
    const clause = parsed.meta.canonical.clauses[0];
    const schedule = clause?.schedule;
    expect(clause?.dose).toEqual({ value: 1, unit: "cap" });
    expect(schedule?.[field]).toBe(value);
    expect(schedule?.when).toEqual(["ACM"]);
    expect(schedule?.duration).toBeUndefined();
    expect(parsed.meta.leftoverText).toBeUndefined();
  });

  it("preserves sub-minute exact offsets without writing an invalid FHIR offset", () => {
    const parsed = parseSig("take before meals half a minute");
    expect(parsed.longText).toBe("Take the medication orally 30 seconds before meals.");
    expect(parsed.fhir.timing?.repeat?.offset).toBeUndefined();
    expect(parsed.fhir.timing?.repeat?.extension).toContainEqual({
      url: TIMING_OFFSET_EXACT_EXTENSION_URL,
      valueDecimal: 0.5
    });

    const restored = fromFhirDosage(parsed.fhir);
    expect(restored.meta.canonical.clauses[0]?.schedule?.offset).toBe(0.5);
    expect(formatSig(parsed.fhir, "long", { locale: "en" }))
      .toBe("Take the medication orally 30 seconds before meals.");
  });

  it("preserves fractional minimum offsets losslessly", () => {
    const parsed = parseSig("take before meals at least half a minute");
    expect(parsed.meta.canonical.clauses[0]?.schedule?.offsetMin).toBe(0.5);
    expect(parsed.fhir.timing?.repeat?.extension).toContainEqual({
      url: TIMING_OFFSET_MIN_EXTENSION_URL,
      valueDecimal: 0.5
    });
    expect(fromFhirDosage(parsed.fhir).meta.canonical.clauses[0]?.schedule?.offsetMin).toBe(0.5);
    expect(parsed.longText).toBe("Take the medication orally at least 30 seconds before meals.");
  });

  it("schedules precise sub-minute offsets at second resolution", () => {
    const parsed = parseSig("take before meals half a minute");
    expect(nextDueDoses(parsed.fhir, {
      timeZone: "UTC",
      eventClock: { CM: "08:00", CD: "12:30", CV: "18:30" },
      orderedAt: "2024-01-01T06:00:00Z",
      from: "2024-01-01T07:00:00Z",
      limit: 3
    })).toEqual([
      "2024-01-01T07:59:30+00:00",
      "2024-01-01T12:29:30+00:00",
      "2024-01-01T18:29:30+00:00"
    ]);
  });

  it.each([
    ["Inject 5 units immediately after meals", "en", "immediately after meals"],
    ["กินหลังอาหารทันที", "th", "หลังอาหารทันที"]
  ])("realizes a zero event offset as immediacy, not an invented measurement: %s", (source, locale, expected) => {
    const parsed = parseSig(source, { locale });
    expect(parsed.fhir.timing?.repeat?.offset).toBe(0);
    expect(parsed.fhir.timing?.repeat?.when).toContain("PC");
    const shown = formatSig(parsed.fhir, "long", { locale });
    expect(shown.toLowerCase()).toContain(expected.toLowerCase());
    expect(shown).not.toMatch(/0 (?:seconds|วินาที)/iu);
    expect(fromFhirDosage(parsed.fhir).meta.canonical.clauses[0]?.schedule?.offset).toBe(0);
  });

  it.each([
    "Take 1 tablet twice daily immediately after breakfast and dinner",
    "Take 1 tablet twice daily immediately after breakfast and immediately after dinner"
  ])("shares zero distance across explicitly coordinated meal events, not a stat dose: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(parsed.fhir.timing?.repeat).toMatchObject({
      frequency: 2, period: 1, periodUnit: "d", offset: 0, when: ["PCM", "PCV"]
    });
    expect(parsed.fhir.timing?.repeat?.when).not.toContain("IMD");
    expect(parsed.meta.leftoverText).toBeUndefined();
    const shown = formatSig(parsed.fhir, "long", {locale: "en"});
    expect(shown.toLowerCase()).toContain("immediately after");
    expect(shown).not.toContain("0 seconds");
  });

  it("keeps immediate after-breakfast OR after-dinner as selectable alternatives", () => {
    const parsed = parseSig("Take 1 tablet twice daily immediately after breakfast or dinner");
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(row => row.fhir.timing?.repeat?.when)).toEqual([["PCM"], ["PCV"]]);
    const membership = parsed.items.map(row => getDosageAlternativeChoice(row.fhir));
    expect(membership[0]?.groupId).toBe(membership[1]?.groupId);
    expect(membership[0]?.branchId).not.toBe(membership[1]?.branchId);
    expect(parsed.items.map(row => row.fhir.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([1, 1]);
    expect(parsed.meta.leftoverText).toBeUndefined();
  });

  it.each([
    ["Take 1 tablet once daily immediately after breakfast or dinner",
      ["PCM", "PCV"], [0, 0]],
    ["Take 1 tablet once daily 15 minutes before breakfast or dinner",
      ["ACM", "ACV"], [15, 15]],
    ["Take 1 tablet once daily immediately after breakfast or with dinner",
      ["PCM", "CV"], [0, undefined]],
    ["Take 1 tablet once daily 15 minutes before breakfast or immediately after dinner",
      ["ACM", "PCV"], [15, 0]],
    ["Take 1 tablet once daily before breakfast or after dinner",
      ["ACM", "PCV"], [undefined, undefined]]
  ] as const)("inherits only OMITTED event-local relation and offset: %s",
    (source, when, offsets) => {
      const parsed = parseSig(source);
      expect(parsed.items).toHaveLength(2);
      const rows = parsed.items.map(item => item.fhir);
      expect(rows.map(row => row.timing?.repeat?.when)).toEqual([[when[0]], [when[1]]]);
      expect(rows.map(row => row.timing?.repeat?.offset)).toEqual([...offsets]);
      const alternatives = rows.map(getDosageAlternativeChoice);
      expect(alternatives[0]?.groupId).toBe(alternatives[1]?.groupId);
      expect(alternatives[0]?.branchId).not.toBe(alternatives[1]?.branchId);
      for (const row of rows) {
        expect(row.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
        expect(fromFhirDosage(row).fhir.timing?.repeat?.when).toEqual(row.timing?.repeat?.when);
        expect(fromFhirDosage(row).fhir.timing?.repeat?.offset).toBe(row.timing?.repeat?.offset);
      }
      expect(parsed.meta.leftoverText).toBeUndefined();
    }
  );

  it.each([
    ["กินยา 1 เม็ด ทันทีหลังอาหารเช้าหรือเย็น", ["PCM", "PCV"], [0, 0]],
    ["กินยา 1 เม็ด 15 นาทีก่อนอาหารเช้าหรือเย็น", ["ACM", "ACV"], [15, 15]],
    ["กินยา 1 เม็ด ทันทีหลังอาหารเช้าหรืออาหารเย็น", ["PCM", "PCV"], [0, 0]],
    ["กินยา 1 เม็ด หลังอาหารเช้าหรือเย็น", ["PCM", "PCV"], [undefined, undefined]],
    ["กินยา 1 เม็ด เช้าหรือเย็น", ["MORN", "EVE"], [undefined, undefined]]
  ] as const)("licenses nominal meal-head ellipsis ONLY under a typed meal phrase: %s",
    (source, when, offsets) => {
      const parsed = parseSig(source, { locale: "th" });
      expect(parsed.items).toHaveLength(2);
      expect(parsed.items.map(item => item.fhir.timing?.repeat?.when)).toEqual([[when[0]], [when[1]]]);
      expect(parsed.items.map(item => item.fhir.timing?.repeat?.offset)).toEqual([...offsets]);
      const choices = parsed.items.map(item => getDosageAlternativeChoice(item.fhir));
      expect(choices[0]?.groupId).toBe(choices[1]?.groupId);
      expect(choices[0]?.branchId).not.toBe(choices[1]?.branchId);
      expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value))
        .toEqual([1, 1]);
      expect(parsed.meta.leftoverText).toBeUndefined();
      for (const item of parsed.items) {
        expect(fromFhirDosage(item.fhir).fhir.timing?.repeat?.when).toEqual(
          item.fhir.timing?.repeat?.when
        );
      }
    });
  it("keeps bound qualifiers out of body-site parsing", () => {
    for (const source of [
      "take before meals at least 0.5 hour",
      "take before meals at most 0.5 hour"
    ]) {
      const parsed = parseSig(source);
      expect(parsed.fhir.site).toBeUndefined();
      expect(parsed.meta.leftoverText).toBeUndefined();
    }
  });
});


describe("indefinite singular course quantities", () => {
  it.each([["a day", "d"], ["a week", "wk"], ["a month", "mo"]] as const)(
    "binds for %s as an explicit one-unit course", (phrase, unit) => {
      const parsed = parseSig("Take 1 tablet twice daily for " + phrase);
      expect(parsed.items).toHaveLength(1);
      const row = parsed.items[0].fhir;
      expect(row.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
      expect(row.timing?.repeat).toMatchObject({
        frequency: 2, period: 1, periodUnit: "d",
        boundsDuration: { value: 1, code: unit }
      });
      expect(parsed.meta.leftoverText).toBeUndefined();
      expect(row.asNeeded).not.toBe(true);
      expect(row.asNeededFor).toBeUndefined();
      expect(toFhirR5Dosages(toDosageDetails([row]))[0].timing?.repeat?.boundsDuration)
        .toMatchObject({ value: 1, code: unit });
      expect(fromFhirDosage(row).meta.canonical.clauses[0]?.schedule)
        .toMatchObject({ duration: 1, durationUnit: unit });
    }
  );

  it("keeps a subsequent eye-dose phase when its duration uses an indefinite article", () => {
    const parsed = parseSig("1 drop OD q2h for 7 days then QID for a week");
    const rows = parsed.items.map(item => item.fhir);
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.site?.text)).toEqual(["right eye", "right eye"]);
    expect(rows[0].timing?.repeat).toMatchObject({ period: 2, periodUnit: "h", boundsDuration: { value: 7, code: "d" } });
    expect(rows[1].timing?.repeat).toMatchObject({ frequency: 4, boundsDuration: { value: 1, code: "wk" } });
    expect(rows.map(row => row.asNeeded)).toEqual([undefined, undefined]);
    expect(parsed.meta.leftoverText).toBeUndefined();
    const strict = toFhirR5Dosages(toDosageDetails(rows));
    expect(strict.map(row => row.timing?.repeat?.boundsDuration?.code)).toEqual(["d", "wk"]);
  });
});

describe("coordinated meal events keep explicit relation scope", () => {
  it.each([
    ["Take 1 tablet before breakfast and after dinner for 7 days.", ["ACM", "PCV"], ["07:30", "19:00"], 14],
    ["Take 1 tablet after breakfast and before dinner for 7 days.", ["PCM", "ACV"], ["08:30", "18:00"], 14],
    ["รับประทาน 1 เม็ดก่อนอาหารเช้าและหลังอาหารเย็น 7 วัน", ["ACM", "PCV"], ["07:30", "19:00"], 14],
    ["Take 1 tablet before breakfast and dinner for 7 days.", ["ACM", "ACV"], ["07:30", "18:00"], 14],
    ["Take 1 tablet before breakfast, after lunch and dinner for 7 days.", ["ACM", "PCD", "PCV"], ["07:30", "13:00", "19:00"], 21]
  ])("preserves each overt relation and only inherits omitted ones: %s", (source, expectedWhen, times, supply) => {
    const parsed = parseSig(source as string);
    expect(parsed.fhir.timing?.repeat?.when).toEqual(expectedWhen);
    const opts = {
      orderedAt: "2026-11-02T00:00:00+07:00", from: "2026-11-02T00:00:00+07:00", timeZone: "Asia/Bangkok",
      eventClock: { CM: "08:00", CD: "12:30", CV: "18:30" },
      mealOffsets: { ACM: -30, PCM: 30, ACD: -30, PCD: 30, ACV: -30, PCV: 30 }
    };
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      const actual = nextDueDoses(dosage, { ...opts, limit: 3 })
        .filter(at => at.startsWith("2026-11-02")).map(at => at.slice(11, 16));
      expect(actual).toEqual(times);
      expect(calculateTotalUnits({ dosage, ...opts, durationValue: 7, durationUnit: "d" }).totalUnits).toBe(supply);
    }
  });
});

describe("weekday exclusions are stable at sentence boundaries", () => {
  it.each(["", ".", "!", "?", ";"])("keeps Sunday excluded with terminal %s", end => {
    const parsed = parseSig("Take 1 tablet every day except Sunday" + end);
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      const dates = nextDueDoses(dosage, { orderedAt: "2026-11-02T00:00:00+07:00",
        from: "2026-11-08T00:00:00+07:00", timeZone: "Asia/Bangkok", limit: 7 }).map(at => at.slice(0, 10));
      expect(dates).not.toContain("2026-11-08");
      expect(dates).not.toContain("2026-11-15");
      expect(dates[0]).toBe("2026-11-09");
    }
  });
});
