import { describe, expect, it } from "vitest";
import {
  formatSig,
  getDosageAlternativeChoice,
  getDosageCondition,
  toDosageDetails,
  toFhirR5Dosages
} from "../src/index";
import { parseSig, parseSigAsync } from "./helpers/r5-parser";

const TABLET_CONTEXT = { dosageForm: "tablet" };

function dose(result: ReturnType<typeof parseSig>, index: number) {
  return result.items[index]?.fhir.doseAndRate?.[0]?.doseQuantity;
}

function repeat(result: ReturnType<typeof parseSig>, index: number) {
  return result.items[index]?.fhir.timing?.repeat;
}

describe("heterogeneous multi-dose regimens", () => {
  it("splits omitted-head English then/and continuations into independent Dosage items", () => {
    const result = parseSig(
      "take 1 tab at 12:00, then 2 tabs at 16:00, and 1.5 tabs before sleep",
      { context: TABLET_CONTEXT }
    );
    expect(result.count).toBe(3);
    expect(dose(result, 0)).toEqual({ value: 1, unit: "tab" });
    expect(dose(result, 1)).toEqual({ value: 2, unit: "tab" });
    expect(dose(result, 2)).toEqual({ value: 1.5, unit: "tab" });
    expect(repeat(result, 0)?.timeOfDay).toEqual(["12:00:00"]);
    expect(repeat(result, 1)?.timeOfDay).toEqual(["16:00:00"]);
    expect(repeat(result, 2)?.when).toEqual(["HS"]);
    expect(result.items.map((item) => item.meta.leftoverText)).toEqual([undefined, undefined, undefined]);
    expect(result.items.map((item) => item.longText)).toEqual([
      "Take 1 tablet orally at 12:00 pm.",
      "Take 2 tablets orally at 4:00 pm.",
      "Take 1.5 tablets orally at bedtime."
    ]);
  });

  it("does the corresponding Thai multi-dose segmentation without a flag", () => {
    const result = parseSig(
      "รับประทาน 1 เม็ด เวลา 12:00 จากนั้น 2 เม็ด เวลา 16:00 และ 1.5 เม็ด ก่อนนอน",
      { locale: "th", context: TABLET_CONTEXT }
    );
    expect(result.count).toBe(3);
    expect(dose(result, 0)).toEqual({ value: 1, unit: "tab" });
    expect(dose(result, 1)).toEqual({ value: 2, unit: "tab" });
    expect(dose(result, 2)).toEqual({ value: 1.5, unit: "tab" });
    expect(repeat(result, 0)?.timeOfDay).toEqual(["12:00:00"]);
    expect(repeat(result, 1)?.timeOfDay).toEqual(["16:00:00"]);
    expect(repeat(result, 2)?.when).toEqual(["HS"]);
    expect(result.items.map((item) => item.meta.leftoverText)).toEqual([undefined, undefined, undefined]);
    expect(result.items.map((item) => item.longText)).toEqual([
      "รับประทานครั้งละ 1 เม็ด เวลา 12:00.",
      "รับประทานครั้งละ 2 เม็ด เวลา 16:00.",
      "รับประทานครั้งละ 1.5 เม็ด ก่อนนอน."
    ]);
  });

  it("parses compact Thai morning/evening dose changes and shares a trailing stage duration", async () => {
    const input = "1 เม็ดเช้า 2 เม็ดเย็นเป็นเวลา 2 สัปดาห์ หลังจากนั้นทาน 1 เม็ดเช้า 1 เม็ดเย็น";
    const options = { locale: "th" as const, context: TABLET_CONTEXT };
    const result = parseSig(input, options);
    expect(result.count).toBe(3);
    expect(result.meta.segments.map((segment) => segment.text)).toEqual([
      "1 เม็ดเช้า",
      "2 เม็ดเย็นเป็นเวลา 2 สัปดาห์",
      "ทาน 1 เม็ดเช้า",
      "1 เม็ดเย็น"
    ]);
    expect(result.items.map((item) => item.fhir.doseAndRate?.[0]?.doseQuantity)).toEqual([
      { value: 1, unit: "tab" },
      { value: 2, unit: "tab" },
      { value: 1, unit: "tab" }
    ]);
    expect(result.items.map((item) => item.fhir.timing?.repeat?.when)).toEqual([
      ["MORN"], ["EVE"], ["MORN", "EVE"]
    ]);
    expect(result.items[0].fhir.timing?.repeat?.boundsDuration).toMatchObject({ value: 2, code: "wk" });
    expect(result.items[1].fhir.timing?.repeat?.boundsDuration).toMatchObject({ value: 2, code: "wk" });
    expect(result.items[2].fhir.timing?.repeat?.boundsDuration).toBeUndefined();
    expect(result.items.map((item) => item.meta.leftoverText)).toEqual([undefined, undefined, undefined]);

    const asyncResult = await parseSigAsync(input, options);
    expect(asyncResult.items.map((item) => item.fhir)).toEqual(result.items.map((item) => item.fhir));
  });

  it("propagates a shared trailing duration before merging identical timed doses", async () => {
    const input = "1 tab morning 1 tab evening for 2 weeks";
    const result = parseSig(input, { context: TABLET_CONTEXT });

    expect(result.meta.segments).toHaveLength(2);
    expect(result.count).toBe(1);
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.repeat?.when).toEqual(["MORN", "EVE"]);
    expect(result.fhir.timing?.repeat?.boundsDuration).toMatchObject({
      value: 2,
      code: "wk",
      system: "http://unitsofmeasure.org"
    });
    expect(result.meta.canonical.clauses).toHaveLength(2);
    expect(result.meta.canonical.clauses.every((clause) =>
      clause.schedule?.duration === 2 && clause.schedule?.durationUnit === "wk"
    )).toBe(true);

    const asyncResult = await parseSigAsync(input, { context: TABLET_CONTEXT });
    expect(asyncResult.items.map((item) => item.fhir)).toEqual(result.items.map((item) => item.fhir));
  });

  it("does not merge timed doses with different course durations", () => {
    const result = parseSig(
      "1 tab morning for 1 week 1 tab evening for 2 weeks",
      { context: TABLET_CONTEXT }
    );
    expect(result.count).toBe(2);
    expect(result.items.map((item) => item.fhir.timing?.repeat?.boundsDuration?.value)).toEqual([1, 2]);
    expect(result.items.map((item) => item.fhir.timing?.repeat?.when)).toEqual([["MORN"], ["EVE"]]);
  });

  it("supports multiple timing anchors inside each heterogeneous dose group", () => {
    const result = parseSig(
      "Take 1 tab at wake and lunch, 2 tabs at dinner and 22:00",
      { context: TABLET_CONTEXT }
    );
    expect(result.count).toBe(2);
    expect(dose(result, 0)).toEqual({ value: 1, unit: "tab" });
    expect(repeat(result, 0)?.when).toEqual(["WAKE", "CD"]);
    expect(dose(result, 1)).toEqual({ value: 2, unit: "tab" });
    expect(repeat(result, 1)?.when).toEqual(["CV"]);
    expect(repeat(result, 1)?.timeOfDay).toEqual(["22:00:00"]);
    expect(result.items[1].warnings).toEqual([]);
    expect(result.items[1].fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(2);
    expect(result.items[0].meta.leftoverText).toBeUndefined();
  });

  it("supports the corresponding Thai multi-dose multi-timing surface", () => {
    const result = parseSig(
      "รับประทาน 1 เม็ด หลังตื่นนอนและอาหารกลางวัน, 2 เม็ด พร้อมอาหารเย็นและเวลา 22:00",
      { locale: "th", context: TABLET_CONTEXT }
    );
    expect(result.count).toBe(2);
    expect(dose(result, 0)).toEqual({ value: 1, unit: "tab" });
    expect(repeat(result, 0)?.when).toEqual(["WAKE", "CD"]);
    expect(dose(result, 1)).toEqual({ value: 2, unit: "tab" });
    expect(repeat(result, 1)?.when).toEqual(["CV"]);
    expect(repeat(result, 1)?.timeOfDay).toEqual(["22:00:00"]);
    expect(result.items[1].warnings).toEqual([]);
    expect(result.items[1].fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(2);
    expect(result.items[0].meta.leftoverText).toBeUndefined();
  });

  it("propagates a semicolon-delimited trailing low-BP safety condition across the regimen", () => {
    const result = parseSig(
      "take 1 tab at 12:00, then 2 tabs at 16:00, and 1.5 tabs before sleep; do not take if low blood pressure",
      { context: TABLET_CONTEXT }
    );
    expect(result.count).toBe(3);
    for (const item of result.items) {
      expect(item.fhir.additionalInstruction).toEqual([
        expect.objectContaining({ text: "do not take if low blood pressure" })
      ]);
      expect(item.longText).toContain("Do not take if low blood pressure.");
      expect(item.meta.leftoverText).toBeUndefined();
    }
  });

  it("keeps trailing shared safety consistent in async parsing", async () => {
    const input = "take 1 tab at 12:00, 2 tabs at 16:00; do not take with food";
    const sync = parseSig(input, { context: TABLET_CONTEXT });
    const asyncResult = await parseSigAsync(input, { context: TABLET_CONTEXT });
    expect(asyncResult.items.map((item) => item.fhir.additionalInstruction)).toEqual(
      sync.items.map((item) => item.fhir.additionalInstruction)
    );
    expect(asyncResult.items.every((item) =>
      item.fhir.additionalInstruction?.some((instruction) => instruction.text === "Do not take with food")
    )).toBe(true);
  });

  it("keeps negated food safety negative and shared without a positive with-food coding", () => {
    const result = parseSig(
      "take 1 tab at 12:00, then 2 tabs at 16:00, and 1.5 tabs before sleep; do not take with food",
      { context: TABLET_CONTEXT }
    );
    expect(result.count).toBe(3);
    for (const item of result.items) {
      expect(item.longText).toContain("Do not take with food.");
      expect(item.fhir.additionalInstruction).toEqual([
        expect.objectContaining({ text: "Do not take with food" })
      ]);
      expect(item.fhir.additionalInstruction?.some((instruction) =>
        instruction.coding?.some((coding) => coding.code === "311504000")
      )).toBe(false);
    }
  });

  it("round-trips negated food relation across English and Thai surfaces", () => {
    const english = parseSig("do not take with food", { locale: "en" });
    const thai = parseSig("ห้ามรับประทานพร้อมอาหาร", { locale: "th" });
    expect(english.longText).toContain("Do not take with food.");
    expect(thai.longText).toContain("ห้ามรับประทานพร้อมอาหาร.");
    expect(formatSig(english.fhir, "long", { locale: "th" })).toBe("ห้ามรับประทานพร้อมอาหาร.");
    expect(formatSig(thai.fhir, "long", { locale: "en" })).toBe("Do not take with food.");
  });


  it("propagates the corresponding Thai low-BP safety condition across the regimen", () => {
    const result = parseSig(
      "รับประทาน 1 เม็ด เวลา 12:00 จากนั้น 2 เม็ด เวลา 16:00 และ 1.5 เม็ด ก่อนนอน; ห้ามรับประทานหากความดันโลหิตต่ำ",
      { locale: "th", context: TABLET_CONTEXT }
    );
    expect(result.count).toBe(3);
    for (const item of result.items) {
      expect(item.longText).toContain("ห้ามรับประทานหากความดันโลหิตต่ำ.");
      expect(item.fhir.additionalInstruction).toEqual([
        expect.objectContaining({ text: "ห้ามรับประทานหากความดันโลหิตต่ำ" })
      ]);
      expect(item.meta.leftoverText).toBeUndefined();
    }
  });

  it("does not split ordinary coordination that lacks a new typed dose", () => {
    const procedural = parseSig("wash scalp and rinse", { locale: "en" });
    expect(procedural.count).toBe(1);
    const timingList = parseSig("take 1 tab at 09:00 and 12:00", { context: TABLET_CONTEXT });
    expect(timingList.count).toBe(1);
  });

  it.each([
    "หยอดตาขวา 1 หยดวันละ 4 ครั้ง 7 วัน ตาซ้าย 1 หยดวันละ 2 ครั้ง",
    "หยอดตาขวา 1 หยดวันละ 4 ครั้ง 7 วัน. ตาซ้าย 1 หยดวันละ 2 ครั้ง",
    "OD 1 drop QID x7d OS 1 drop BID",
    "OD one drop QID x7d OS one drop BID",
    "หยอดตาขวาหนึ่งหยดวันละสี่ครั้ง 7 วัน ตาซ้ายหนึ่งหยดวันละสองครั้ง",
    "Right eye 1 drop QID for 7 days left eye 1 drop BID"
  ])("keeps complete independently dosed ocular heads across an implicit boundary: %s", (input) => {
    const parsed = parseSig(input, { locale: input.includes("ตา") ? "th" : "en" });
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.site?.text)).toEqual(["right eye", "left eye"]);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([1, 1]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.frequency)).toEqual([4, 2]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.value))
      .toEqual([7, undefined]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.count)).toEqual([undefined, undefined]);
    expect(parsed.meta.leftoverText).toBeUndefined();

    const strictR5 = toFhirR5Dosages(parsed.fhirNext);
    expect(strictR5.map(dosage => dosage.site?.text)).toEqual(["right eye", "left eye"]);
    expect(strictR5.map(dosage => dosage.timing?.repeat?.frequency)).toEqual([4, 2]);
    expect(toDosageDetails(strictR5)).toEqual(parsed.fhirNext);
    expect(parsed.fhirNext.step).toHaveLength(1);
    expect(parsed.fhirNext.step[0]?.component).toHaveLength(2);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });

  it("keeps a compound ocular target under one shared dose construction", () => {
    const input = "OD and OS 1 drop BID";
    const parsed = parseSig(input);
    expect(parsed.meta.segments).toHaveLength(1);
    expect(parsed.items.map(item => item.fhir.site?.text)).toEqual(["right eye", "left eye"]);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([1, 1]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.frequency)).toEqual([2, 2]);
    expect(parsed.fhirNext.step).toHaveLength(1);
    expect(parsed.fhirNext.step[0]?.component).toHaveLength(2);
  });

  it("keeps connectorless independently timed Thai doses as separate heads", () => {
    const input = "ครึ่งเม็ดตอนเช้า 1 เม็ดตอนเย็น";
    const parsed = parseSig(input, { locale: "th" });
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity))
      .toEqual([{ value: 0.5, unit: "tab" }, { value: 1, unit: "tab" }]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.when))
      .toEqual([["MORN"], ["EVE"]]);
    expect(parsed.items.map(item => item.fhir.route?.text)).toEqual([undefined, undefined]);
    expect(parsed.meta.leftoverText).toBeUndefined();

    const strictR5 = toFhirR5Dosages(parsed.fhirNext);
    expect(strictR5.map(dosage => dosage.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([0.5, 1]);
    expect(strictR5.map(dosage => dosage.timing?.repeat?.when)).toEqual([["MORN"], ["EVE"]]);
    expect(toDosageDetails(strictR5)).toEqual(parsed.fhirNext);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });

  it("keeps a decimal dose intact while exposing a compact sentence boundary", () => {
    const input = "OD 0.5 drop BID.OS 1 drop QID";
    const parsed = parseSig(input);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.site?.text)).toEqual(["right eye", "left eye"]);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([0.5, 1]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.frequency)).toEqual([2, 4]);
    expect(parsed.meta.leftoverText).toBeUndefined();
    const strictR5 = toFhirR5Dosages(parsed.fhirNext);
    expect(strictR5.map(dosage => dosage.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([0.5, 1]);
    expect(toDosageDetails(strictR5)).toEqual(parsed.fhirNext);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });

  it.each([
    [
      "หยอดตาขวา 1 หยด ทุก 2 ชั่วโมง 7 วัน แล้วลดเหลือวันละ 4 ครั้ง อีก 7 วัน",
      "right eye",
      [undefined, 4],
      [2, 1],
      ["h", "d"]
    ],
    [
      "ทาที่ผื่นวันละ 2 ครั้ง 7 วัน แล้วลดเหลือวันละครั้งอีก 7 วัน",
      "rash",
      [2, 1],
      [1, 1],
      ["d", "d"]
    ]
  ] as const)("assigns each Thai taper duration to its typed phase: %s", (
    input, site, frequencies, periods, periodUnits
  ) => {
    const parsed = parseSig(input, { locale: "th" });
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.site?.text)).toEqual([site, site]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.frequency)).toEqual([...frequencies]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.period)).toEqual([...periods]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.periodUnit)).toEqual([...periodUnits]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.value)).toEqual([7, 7]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.code)).toEqual(["d", "d"]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.count)).toEqual([undefined, undefined]);
    expect(parsed.meta.leftoverText).toBeUndefined();

    const strictR5 = toFhirR5Dosages(parsed.fhirNext);
    expect(strictR5.map(dosage => dosage.timing?.repeat?.boundsDuration?.value)).toEqual([7, 7]);
    expect(strictR5.map(dosage => dosage.sequence)).toEqual([1, 2]);
    expect(toDosageDetails(strictR5)).toEqual(parsed.fhirNext);
    expect(parsed.fhirNext.step.map(step => step.component.length)).toEqual([1, 1]);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });
});

describe("typed delayed loading and phase continuations", () => {
  it.each([
    ["Take 2 tablets now, then 1 tablet after 12 hours", 12],
    ["Take 2 tablets immediately, then 1 tablet in 12 hours", 12],
    ["Take 2 tablets now, then 1 tablet 1 hour later", 1],
    ["Take 2 tablets immediately, then after 1 hour take 1 tablet", 1],
    ["Take 2 tablets now, then 1 tablet after twelve hours", 12],
    ["Take 2 tablets immediately, then 1 tablet in twelve hours", 12],
    ["Take 2 tablets now, then 1 tablet twelve hours later", 12]
  ] as const)("keeps a one-time delayed oral loading dose: %s", (input, hours) => {
    const parsed = parseSig(input, { context: TABLET_CONTEXT });

    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity))
      .toEqual([{ value: 2, unit: "tab" }, { value: 1, unit: "tab" }]);
    expect(parsed.items[0]?.fhir.timing?.repeat?.when).toEqual(["IMD"]);
    expect(parsed.items.map(item => item.fhir.route?.coding?.[0]?.code))
      .toEqual(["26643006", "26643006"]);
    expect(parsed.items[1]?.fhir.timing?.repeat?.boundsDuration).toBeUndefined();
    expect(parsed.items[1]?.fhir.timing?.repeat?.frequency).toBeUndefined();
    expect(parsed.items[1]?.fhir.timing?.repeat?.period).toBeUndefined();
    expect(parsed.items[1]?.meta.canonical.clauses[0]?.schedule?.administrationOffsetMinutes)
      .toBe(hours * 60);
    expect(parsed.items[1]?.meta.canonical.clauses[0]?.evidence.some(item =>
      item.rule === "hpsg.lex.schedule.administrationOffset.relativeInterval"
    )).toBe(true);
    expect(parsed.fhirNext.step).toHaveLength(2);
    expect(parsed.fhirNext.step[1]?.start?.offsetDuration).toMatchObject({
      value: hours,
      code: "h"
    });
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });

  it("keeps a more-days ocular cadence as a second phase before the independent eye regimen", () => {
    const input = "OD 1 drop q2h for 2 days, then BID for 5 more days. OS 1 drop nightly for 7 days.";
    const parsed = parseSig(input);

    expect(parsed.items).toHaveLength(3);
    expect(parsed.items.map(item => item.fhir.site?.text))
      .toEqual(["right eye", "right eye", "left eye"]);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity))
      .toEqual([
        { value: 1, unit: "drop" },
        { value: 1, unit: "drop" },
        { value: 1, unit: "drop" }
      ]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.frequency))
      .toEqual([undefined, 2, undefined]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.period))
      .toEqual([2, 1, undefined]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.periodUnit))
      .toEqual(["h", "d", undefined]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.when))
      .toEqual([undefined, undefined, ["NIGHT"]]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.value))
      .toEqual([2, 5, 7]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.code))
      .toEqual(["d", "d", "d"]);
    // The independent OS course persists in parallel across both sequential
    // OD phases, so R6 has two steps with two components rather than three
    // serial steps.
    expect(parsed.fhirNext.step.map(step => step.component.length)).toEqual([2, 2]);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });
});

describe("typed shared course bounds", () => {
  it.each([
    ["Take 1 tab qAM and 2 tabs qPM for 7 days", undefined, 7, "d"],
    ["Take 0.5 tablet each morning and 1.5 tablets each evening for 14 days", undefined, 14, "d"],
    ["รับประทาน ครึ่งเม็ดเช้า และ 1 เม็ดเย็น 2 สัปดาห์", "th", 2, "wk"]
  ] as const)("scopes one terminal duration over both coordinated dose slots: %s", (
    input, locale, value, code
  ) => {
    const parsed = parseSig(input, {
      ...(locale ? { locale } : {}),
      context: TABLET_CONTEXT
    });

    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration))
      .toEqual([
        expect.objectContaining({ value, code }),
        expect.objectContaining({ value, code })
      ]);
    const strictR5 = toFhirR5Dosages(parsed.fhirNext);
    expect(strictR5.map(item => item.timing?.repeat?.boundsDuration))
      .toEqual(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration));
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });

  it("does not replace either dose slot's explicit local duration", () => {
    const parsed = parseSig(
      "Take 1 tab qAM for 3 days and 2 tabs qPM for 7 days",
      { context: TABLET_CONTEXT }
    );

    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.value))
      .toEqual([3, 7]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.code))
      .toEqual(["d", "d"]);
  });
});

describe("typed additive doses", () => {
  it.each([
    ["Take 1 and a half tablets each morning", 1.5, "MORN"],
    ["Take 2 and three quarters tablets nightly", 2.75, "NIGHT"]
  ] as const)("keeps one additive quantity daughter across its conjunction: %s", (
    input, value, event
  ) => {
    const parsed = parseSig(input, { context: TABLET_CONTEXT });

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.fhir.doseAndRate?.[0]?.doseQuantity)
      .toEqual({ value, unit: "tab" });
    expect(parsed.items[0]?.fhir.timing?.repeat?.when).toEqual([event]);
    expect(parsed.items[0]?.meta.canonical.clauses[0]?.evidence.some(item =>
      item.rule === "hpsg.lex.clinicalQuantity.additiveFractionDose"
    )).toBe(true);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });
});

describe("typed conditional dosage alternatives", () => {
  it.each([
    "Take 2 tablets daily if weight above 70kg; otherwise 1 tablet daily",
    "Take 2 tablets daily if weight above 70kg; otherwise take 1 tablet daily",
    "Take 2 tablets daily if weight above 70kg, otherwise take 1 tablet daily",
    "Take 2 tablets daily if weight above 70kg otherwise 1 tablet daily",
    "Take 2 tablets daily if weight above 70kg; otherwise 1 tablet daily.",
    "Take 2 tablets daily if weight above 70kg, otherwise take 1 tablet daily."
  ])("retains both branches of an explicit ELSE dosage choice: %s", input => {
    const parsed = parseSig(input, { context: TABLET_CONTEXT });

    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity))
      .toEqual([{ value: 2, unit: "tab" }, { value: 1, unit: "tab" }]);
    expect(parsed.items.some(item => item.fhir.asNeeded === true)).toBe(false);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity))
      .not.toContainEqual(expect.objectContaining({ value: 70, unit: "kg" }));
    expect(getDosageCondition(parsed.items[0].fhir)).toMatchObject({
      kind: "measurement",
      name: "weight",
      operation: "gt",
      value: 70,
      unit: "kg"
    });
    expect(getDosageCondition(parsed.items[1].fhir)).toBeUndefined();
    const choices = parsed.items.map(item => getDosageAlternativeChoice(item.fhir));
    expect(choices).toEqual([
      expect.objectContaining({ selectionBehavior: "exactly-one" }),
      expect.objectContaining({ selectionBehavior: "exactly-one" })
    ]);
    expect(choices[0]?.groupId).toBe(choices[1]?.groupId);
    expect(choices[0]?.branchId).not.toBe(choices[1]?.branchId);
    expect(parsed.fhirNext.step).toHaveLength(1);
    expect(parsed.fhirNext.step[0]?.component).toHaveLength(2);
    expect(toFhirR5Dosages(parsed.fhirNext).map(getDosageAlternativeChoice))
      .toEqual(choices);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });
});
