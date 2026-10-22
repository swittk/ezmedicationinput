import { describe, expect, it } from "vitest";
import { lintSig } from "../src";
import { parseSig } from "./helpers/r5-parser";

describe("HPSG count cardinal semantics", () => {
  it.each([
    "1 tab q6h for 3 doses",
    "1 tab q6h for three doses",
    "1 tab q6h three doses total",
    "1 tab q6h total three doses"
  ])("preserves an exact total count without depending on numeric token values: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.fhir.timing?.repeat).toMatchObject({
      count: 3,
      period: 6,
      periodUnit: "h"
    });
    expect(parsed.meta.canonical.clauses[0]?.schedule?.count).toBe(3);
    expect(parsed.meta.leftoverText).toBeUndefined();
  });

  it("preserves spelled maximum and periodic occurrence caps", () => {
    const total = parseSig("1 tab q6h max three doses");
    expect(total.fhir.timing?.repeat).toMatchObject({ count: 1, countMax: 3 });
    expect(total.meta.leftoverText).toBeUndefined();

    const daily = parseSig("1 tab q4h prn pain max three doses daily");
    expect(daily.meta.canonical.clauses[0]?.schedule?.occurrenceCap).toEqual({
      max: 3,
      period: 1,
      periodUnit: "d"
    });
    expect(daily.fhir.timing?.repeat?.countMax).toBeUndefined();
  });

  it.each([
    "1 tab q6h for 3-5 doses",
    "1 tab q6h total 3-5 doses"
  ])("rejects a range where an exact total count is required: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.fhir.timing?.repeat?.count).toBeUndefined();
    expect(parsed.fhir.timing?.repeat?.countMax).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0]?.schedule?.count).toBeUndefined();
    expect(parsed.meta.leftoverText).toContain("3-5 doses");
    expect(lintSig(source).issues).toContainEqual(expect.objectContaining({
      message: "Unrecognized text",
      text: expect.stringContaining("3-5 doses")
    }));
  });

  it("keeps an explicit maximum range unresolved instead of flattening it", () => {
    const parsed = parseSig("1 tab q6h max 3-5 doses");
    expect(parsed.fhir.timing).toBeUndefined();
    expect(parsed.warnings).toContainEqual(expect.stringContaining("unresolved-critical-constraint"));
  });

  it("uses a spelled cadence-first count as frequency, not total administrations", () => {
    const parsed = parseSig("1 tab daily three times");
    expect(parsed.fhir.timing?.repeat).toMatchObject({
      frequency: 3,
      period: 1,
      periodUnit: "d"
    });
    expect(parsed.fhir.timing?.repeat?.count).toBeUndefined();
    expect(parsed.meta.leftoverText).toBeUndefined();
  });

  it("continues to accept word-valued intervals and ranged durations", () => {
    const interval = parseSig("1 tab every three hours");
    expect(interval.fhir.timing?.repeat).toMatchObject({ period: 3, periodUnit: "h" });

    const duration = parseSig("1 tab daily for 7-14 days");
    expect(duration.fhir.timing?.repeat?.boundsRange).toEqual({
      low: { value: 7, unit: "days", code: "d", system: "http://unitsofmeasure.org" },
      high: { value: 14, unit: "days", code: "d", system: "http://unitsofmeasure.org" }
    });
  });
});
