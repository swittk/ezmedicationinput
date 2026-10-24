import { describe, expect, it } from "vitest";
import { formatSig, fromFhirDosage, getDosageAlternativeChoice, nextDueDoses, TIMING_OFFSET_EXACT_EXTENSION_URL, TIMING_OFFSET_MIN_EXTENSION_URL } from "../src";
import { parseSig } from "./helpers/r5-parser";

describe("relative event-offset grammar", () => {
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
