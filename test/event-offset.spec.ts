import { describe, expect, it } from "vitest";
import {
  formatSig,
  fromFhirDosage,
  nextDueDoses,
  parseSig,
  TIMING_OFFSET_EXACT_EXTENSION_URL,
  TIMING_OFFSET_MIN_EXTENSION_URL
} from "../src";

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
    const schedule = parsed.meta.canonical.clauses[0]?.schedule;
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
