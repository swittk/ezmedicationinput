import { describe, expect, it } from "vitest";
import { formatParseBatch, formatSig, formatSigBatch, fromFhir, lintSig } from "../src/index";
import { parseSig, parseSigAsync } from "./helpers/r5-parser";

describe("multi-clause parsing", () => {
  it("returns batch shape and keeps first-item compatibility fields", () => {
    const batch = parseSig("1 tab po bid");

    expect(batch.count).toBe(1);
    expect(batch.items).toHaveLength(1);
    expect(batch.fhir).toEqual(batch.items[0].fhir);
    expect(batch.shortText).toBe(batch.items[0].shortText);
    expect(batch.longText).toBe(batch.items[0].longText);
    expect(batch.meta.consumedTokens).toEqual(batch.items[0].meta.consumedTokens);
    expect(batch.meta.segments).toEqual([
      {
        index: 0,
        text: "1 tab po bid",
        range: { start: 0, end: "1 tab po bid".length }
      }
    ]);
  });

  it("renders short and long multi-clause instructions rather than echoing source shorthand", () => {
    const source = "1 tab po bid + 1 tab po qid";
    const batch = parseSig(source);
    expect(batch.fhirNext.renderedInstruction).toBe(source);
    expect(batch.shortText).not.toBe(source);
    expect(batch.longText).toContain("orally twice daily");
    expect(batch.longText).toContain("orally four times daily");
    expect(batch.count).toBe(2);
  });

  it.each([
    ["en", "Instill 1 drop twice daily in the left eye; Instill 2 drops twice daily in the right eye."],
    ["th", "หยอดตาซ้าย ครั้งละ 1 หยด วันละ 2 ครั้ง; หยอดตาขวา ครั้งละ 2 หยด วันละ 2 ครั้ง."]
  ] as const)("joins generated %s clauses without duplicated punctuation", (locale, expected) => {
    const batch = parseSig(
      "instill 1 drop in left eye and 2 drops in right eye twice daily",
      { locale }
    );

    expect(batch.longText).toBe(expected);
    expect(batch.longText).not.toContain(".;");
  });

  it("forwards English realization flags to whole-course multi-clause text", () => {
    const batch = parseSig(
      "1 tab po pc breakfast lunch dinner + 2 tab po pc breakfast lunch dinner",
      {
        locale: "en",
        groupMealTimingsByRelation: true,
        includeTimesPerDaySummary: true
      }
    );

    expect(batch.longText).toContain(
      "Take 1 tablet orally three times daily after breakfast, lunch and dinner;"
    );
    expect(batch.longText).toContain(
      "Take 2 tablets orally three times daily after breakfast, lunch and dinner."
    );
  });

  it("forwards Thai locale and realization flags through the async whole-course path", async () => {
    const batch = await parseSigAsync(
      "1 tab po pc breakfast lunch dinner + 2 tab po pc breakfast lunch dinner",
      {
        locale: "th",
        groupMealTimingsByRelation: true,
        includeTimesPerDaySummary: true
      }
    );

    expect(batch.longText).toContain(
      "รับประทานครั้งละ 1 เม็ด วันละ 3 ครั้ง หลังอาหารเช้า กลางวัน และเย็น;"
    );
    expect(batch.longText).toContain(
      "รับประทานครั้งละ 2 เม็ด วันละ 3 ครั้ง หลังอาหารเช้า กลางวัน และเย็น."
    );
    expect(batch.longText).not.toContain("Take");
  });

  it("re-realizes ordinary saved courses when explicit format options make their text stale", () => {
    const details = parseSig(
      "1 tab po pc breakfast lunch dinner + 2 tab po pc breakfast lunch dinner"
    ).dosageDetails;
    details.renderedInstruction = "stale saved instruction";
    const options = {
      locale: "th",
      groupMealTimingsByRelation: true,
      includeTimesPerDaySummary: true
    } as const;

    expect(formatSig(details, "long")).toBe("stale saved instruction");
    const formatted = formatSig(details, "long", options);
    expect(formatted).toContain("รับประทานครั้งละ 1 เม็ด วันละ 3 ครั้ง");
    expect(formatted).not.toContain("stale saved instruction");

    const imported = fromFhir(details, options);
    expect(imported.longText).toBe(formatted);
    expect(imported.longText).not.toContain("stale saved instruction");
    expect(imported.fhirNext.renderedInstruction).toBe("stale saved instruction");

    const advanced = { ...details, repeatCycle: { value: 28, unit: "d" } };
    expect(formatSig(advanced, "long", options)).toBe("stale saved instruction");
    expect(fromFhir(advanced, options).longText).toBe("stale saved instruction");
  });

  it("parses plus-separated ocular clauses into multiple items", () => {
    const batch = parseSig("1 drop to OD Q 2 H + 1 drop to OS QID");

    expect(batch.count).toBe(2);
    expect(batch.items[0].fhir.site?.text).toBe("right eye");
    expect(batch.items[0].fhir.timing?.repeat).toMatchObject({
      period: 2,
      periodUnit: "h"
    });
    expect(batch.items[1].fhir.site?.text).toBe("left eye");
    expect(batch.items[1].fhir.timing?.repeat).toMatchObject({
      frequency: 4,
      period: 1,
      periodUnit: "d"
    });
  });

  it("parses slash and double-slash separated ocular clauses", () => {
    const batch = parseSig("2 drops OD HS // 1 drop OS BID");

    expect(batch.count).toBe(2);
    expect(batch.items[0].fhir.site?.text).toBe("right eye");
    expect(batch.items[0].fhir.timing?.repeat?.when).toEqual(["HS"]);
    expect(batch.items[1].fhir.site?.text).toBe("left eye");
    expect(batch.items[1].fhir.timing?.repeat).toMatchObject({
      frequency: 2,
      period: 1,
      periodUnit: "d"
    });
  });

  it("parses comma-separated mixed routine and PRN clauses", () => {
    const batch = parseSig(
      "1 tab po bid, 2 tabs po prn insomnia hs (2 tabs as routine + 1 dose if not sleepy hs)"
    );

    expect(batch.count).toBe(2);
    expect(batch.items[0].fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
    expect(batch.items[0].fhir.timing?.repeat).toMatchObject({
      frequency: 2,
      period: 1,
      periodUnit: "d"
    });
    expect(batch.items[0].fhir.asNeededFor?.[0]?.text).toBeFalsy();
    expect(batch.items[1].fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(2);
    expect(batch.items[1].fhir.asNeeded).toBe(true);
    expect(batch.items[1].fhir.asNeededFor?.[0]?.text?.toLowerCase()).toContain("insomnia");
  });

  it("parses comma-separated meal clauses into multiple dose entries", () => {
    const batch = parseSig("1 tab po in morning, 2 tabs po with lunch, 1 tab before dinner");

    expect(batch.count).toBe(3);
    expect(batch.items[0].fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
    expect(batch.items[0].fhir.timing?.repeat?.when).toEqual(["MORN"]);
    expect(batch.items[1].fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(2);
    expect(batch.items[1].fhir.timing?.repeat?.when).toEqual(["CD"]);
    expect(batch.items[2].fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
    expect(batch.items[2].fhir.timing?.repeat?.when).toEqual(["ACV"]);
  });

  it("exposes batch wrappers for lint and async parse", async () => {
    const linted = lintSig("1 drop RE tid / 1 drop LE QID");
    expect(linted.count).toBe(2);
    expect(linted.items[0].issues).toEqual([]);
    expect(linted.result).toEqual(linted.items[0].result);

    const asyncBatch = await parseSigAsync("OD 2 drops BID, OS 1 drop OD");
    expect(asyncBatch.count).toBe(2);
    expect(asyncBatch.items[0].fhir.site?.text).toBe("right eye");
    expect(asyncBatch.items[1].fhir.site?.text).toBe("left eye");
  });

  it("handles example 1: 1 drop to OD Q 2 H +  1 drop to OS QID", () => {
    const input = "1 drop to OD Q 2 H +  1 drop to OS QID";
    const batch = parseSig(input);

    expect(batch.count).toBe(2);
    expect(batch.items[0].fhir.site?.text).toBe("right eye");
    expect(batch.items[0].fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
    expect(batch.items[0].fhir.timing?.repeat).toMatchObject({ period: 2, periodUnit: "h" });
    expect(batch.items[1].fhir.site?.text).toBe("left eye");
    expect(batch.items[1].fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
    expect(batch.items[1].fhir.timing?.repeat).toMatchObject({
      frequency: 4,
      period: 1,
      periodUnit: "d"
    });
  });

  it("handles example 2: 2 drops OD HS // 1 drop OS BID", () => {
    const input = "2 drops OD HS // 1 drop OS BID";
    const batch = parseSig(input);

    expect(batch.count).toBe(2);
    expect(batch.items[0].fhir.site?.text).toBe("right eye");
    expect(batch.items[0].fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(2);
    expect(batch.items[0].fhir.timing?.repeat?.when).toEqual(["HS"]);
    expect(batch.items[1].fhir.site?.text).toBe("left eye");
    expect(batch.items[1].fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
    expect(batch.items[1].fhir.timing?.repeat).toMatchObject({
      frequency: 2,
      period: 1,
      periodUnit: "d"
    });
  });

  it("handles example 3: 1 drop RE tid / 1 drop LE QID", () => {
    const input = "1 drop RE tid / 1 drop LE QID";
    const batch = parseSig(input);

    expect(batch.count).toBe(2);
    expect(batch.items[0].fhir.site?.text).toBe("right eye");
    expect(batch.items[0].fhir.timing?.repeat).toMatchObject({
      frequency: 3,
      period: 1,
      periodUnit: "d"
    });
    expect(batch.items[1].fhir.site?.text).toBe("left eye");
    expect(batch.items[1].fhir.timing?.repeat).toMatchObject({
      frequency: 4,
      period: 1,
      periodUnit: "d"
    });
  });

  it("handles example 4: apply to right arm once daily, apply to left leg twice daily", () => {
    const input = "apply to right arm once daily, apply to left leg twice daily";
    const batch = parseSig(input);

    expect(batch.count).toBe(2);
    expect(batch.items[0].fhir.site?.text).toBe("right arm");
    expect(batch.items[0].fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
    expect(batch.items[1].fhir.site?.text).toBe("left leg");
    expect(batch.items[1].fhir.timing?.repeat).toMatchObject({
      frequency: 2,
      period: 1,
      periodUnit: "d"
    });
  });

  it("handles example 5: 2 drops tid RE // 1 drop bid LE", () => {
    const input = "2 drops tid RE // 1 drop bid LE";
    const batch = parseSig(input);

    expect(batch.count).toBe(2);
    expect(batch.items[0].fhir.site?.text).toBe("right eye");
    expect(batch.items[0].fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(2);
    expect(batch.items[0].fhir.timing?.repeat).toMatchObject({
      frequency: 3,
      period: 1,
      periodUnit: "d"
    });
    expect(batch.items[1].fhir.site?.text).toBe("left eye");
    expect(batch.items[1].fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
    expect(batch.items[1].fhir.timing?.repeat).toMatchObject({
      frequency: 2,
      period: 1,
      periodUnit: "d"
    });
  });

  it("handles example 6: OD 2 drops BID, OS 1 drop OD", () => {
    const input = "OD 2 drops BID, OS 1 drop OD";
    const batch = parseSig(input);

    expect(batch.count).toBe(2);
    expect(batch.items[0].fhir.site?.text).toBe("right eye");
    expect(batch.items[0].fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(2);
    expect(batch.items[0].fhir.timing?.repeat).toMatchObject({
      frequency: 2,
      period: 1,
      periodUnit: "d"
    });
    expect(batch.items[1].fhir.site?.text).toBe("left eye");
    expect(batch.items[1].fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
    expect(batch.items[1].fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
  });

  it("handles example 7: 1 tab po bid, 2 tabs po prn insomnia hs (2 tabs as routine + 1 dose if not sleepy hs)", () => {
    const input =
      "1 tab po bid, 2 tabs po prn insomnia hs (2 tabs as routine + 1 dose if not sleepy hs)";
    const batch = parseSig(input);

    expect(batch.count).toBe(2);
    expect(batch.items[0].fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
    expect(batch.items[0].fhir.timing?.repeat).toMatchObject({
      frequency: 2,
      period: 1,
      periodUnit: "d"
    });
    expect(batch.items[1].fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(2);
    expect(batch.items[1].fhir.asNeeded).toBe(true);
    expect(batch.items[1].fhir.asNeededFor?.[0]?.text?.toLowerCase()).toContain("insomnia");
    expect(batch.items[1].fhir.timing?.repeat?.when).toEqual(["HS"]);
  });

  it("handles example 8: 1 tab po in morning, 2 tabs po with lunch, 1 tab before dinner", () => {
    const input = "1 tab po in morning, 2 tabs po with lunch, 1 tab before dinner";
    const batch = parseSig(input);

    expect(batch.count).toBe(3);
    expect(batch.items[0].fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
    expect(batch.items[0].fhir.timing?.repeat?.when).toEqual(["MORN"]);
    expect(batch.items[1].fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(2);
    expect(batch.items[1].fhir.timing?.repeat?.when).toEqual(["CD"]);
    expect(batch.items[2].fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
    expect(batch.items[2].fhir.timing?.repeat?.when).toEqual(["ACV"]);
  });

  it("handles: 1 tab po @ 8:00, 2 tabs po with lunch, 1 tab before dinner, 4 tabs po hs", () => {
    const input = "1 tab po @ 8:00, 2 tabs po with lunch, 1 tab before dinner, 4 tabs po hs";
    const batch = parseSig(input);

    expect(batch.count).toBe(4);
    expect(batch.items[0].shortText).toBe("1 tab PO 08:00");
    expect(batch.items[0].fhir.timing?.repeat?.timeOfDay).toEqual(["08:00:00"]);
    expect(batch.items[1].fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(2);
    expect(batch.items[1].fhir.timing?.repeat?.when).toEqual(["CD"]);
    expect(batch.items[2].fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
    expect(batch.items[2].fhir.timing?.repeat?.when).toEqual(["ACV"]);
    expect(batch.items[3].fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(4);
    expect(batch.items[3].fhir.timing?.repeat?.when).toEqual(["HS"]);
  });

  it("handles: 1 tab po at wake, 1 tab suppo before lunch, 1 tab po before dinner, 1 tab suppo hs", () => {
    const input = "1 tab po at wake, 1 tab suppo before lunch, 1 tab po before dinner, 1 tab suppo hs";
    const batch = parseSig(input);

    expect(batch.count).toBe(4);
    expect(batch.items[0].shortText).toBe("1 tab PO WAKE");
    expect(batch.items[0].fhir.route?.text).toBe("by mouth");
    expect(batch.items[1].shortText).toBe("1 tab PR ACD");
    expect(batch.items[1].fhir.route?.text).toBe("rectal");
    expect(batch.items[2].shortText).toBe("1 tab PO ACV");
    expect(batch.items[2].fhir.route?.text).toBe("by mouth");
    expect(batch.items[3].shortText).toBe("1 tab PR HS");
    expect(batch.items[3].fhir.route?.text).toBe("rectal");
  });

  it("formats parse batches back into combined sig strings", () => {
    const input = "1 tab po @ 8:00, 2 tabs po with lunch, 1 tab before dinner, 4 tabs po hs";
    const batch = parseSig(input);

    const shortCombined = formatParseBatch(batch, "short");
    expect(shortCombined).toBe(batch.items.map((item) => item.shortText).join(", "));

    const longCombined = formatParseBatch(batch, "long", " | ");
    expect(longCombined).toContain(batch.items[0].longText);
    expect(longCombined).toContain(batch.items[3].longText);
    expect(longCombined.split(" | ").length).toBe(4);

    const shortPipeCombined = formatParseBatch(batch, "short", " | ");
    const reparsedFromPipe = parseSig(shortPipeCombined);
    expect(reparsedFromPipe.count).toBe(4);
    expect(reparsedFromPipe.items[0].shortText).toBe("1 tab PO 08:00");
    expect(reparsedFromPipe.items[3].shortText).toBe("4 tab PO HS");
  });

  it("formats multi-item FHIR arrays and supports parse round-trips", () => {
    const input = "1 tab po at wake, 1 tab suppo before lunch, 1 tab po before dinner, 1 tab suppo hs";
    const batch = parseSig(input);

    const shortSig = formatSigBatch(batch.items.map((item) => item.fhir), "short");
    expect(shortSig).toContain("1 tab PO WAKE");
    expect(shortSig).toContain("1 tab PR ACD");
    expect(shortSig).toContain("1 tab PO ACV");
    expect(shortSig).toContain("1 tab PR HS");

    const reparsed = parseSig(shortSig);
    expect(reparsed.count).toBe(4);
    expect(reparsed.items[0].shortText).toBe("1 tab PO WAKE");
    expect(reparsed.items[1].shortText).toBe("1 tab PR ACD");
    expect(reparsed.items[2].shortText).toBe("1 tab PO ACV");
    expect(reparsed.items[3].shortText).toBe("1 tab PR HS");
  });

  it("detects native pipe separators in raw sig input", () => {
    const batch = parseSig("1 tab po bid | 2 tabs po hs");

    expect(batch.count).toBe(2);
    expect(batch.items[0].shortText).toBe("1 tab PO BID");
    expect(batch.items[1].shortText).toBe("2 tab PO HS");
  });

  it("does not split caution-style comma/semicolon tails into extra clauses", () => {
    const commaTail = parseSig("1 tab po OD, do not eat before swimming");
    expect(commaTail.count).toBe(1);
    expect(commaTail.meta.segments).toHaveLength(1);

    const semicolonTail = parseSig("1 tab po OD, do not eat before swimming; no alcohol");
    expect(semicolonTail.count).toBe(1);
    expect(semicolonTail.meta.segments).toHaveLength(1);
  });

});
