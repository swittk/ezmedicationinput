import { describe, expect, it } from "vitest";
import {
  formatSig,
  getDosageAlternativeChoice,
  getDosageCondition,
  nextDueDoses,
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

describe("typed ordinal-week Parkinson regimen phases", () => {
  const orderedAt = "2026-11-02T00:00:00+07:00";
  const dueOn = (
    regimen: Parameters<typeof nextDueDoses>[0],
    date: "2026-11-02" | "2026-11-09" | "2026-11-16"
  ) => nextDueDoses(regimen, {
    from: `${date}T00:00:00+07:00`,
    orderedAt,
    timeZone: "Asia/Bangkok",
    limit: 8
  }).filter(value => value.startsWith(date));

  it("keeps Week 1, Week 2, and Week 3 onwards as three exact dose/time phases", () => {
    const input = "Week 1: take half a tablet at 08:00 and 20:00. " +
      "Week 2: take 1 tablet at 08:00 and 20:00. " +
      "Week 3 onwards: take 1 tablet at 08:00, 14:00 and 20:00.";
    const parsed = parseSig(input, { context: TABLET_CONTEXT });
    expect(parsed.meta.segments.map(segment => segment.text)).toEqual([
      "Week 1: take half a tablet at 08:00 and 20:00",
      "Week 2: take 1 tablet at 08:00 and 20:00",
      "Week 3 onwards: take 1 tablet at 08:00, 14:00 and 20:00."
    ]);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity))
      .toEqual([
        { value: 0.5, unit: "tab" },
        { value: 1, unit: "tab" },
        { value: 1, unit: "tab" }
      ]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.timeOfDay))
      .toEqual([
        ["08:00:00", "20:00:00"],
        ["08:00:00", "20:00:00"],
        ["08:00:00", "14:00:00", "20:00:00"]
      ]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration))
      .toEqual([
        expect.objectContaining({ value: 1, code: "wk" }),
        expect.objectContaining({ value: 1, code: "wk" }),
        undefined
      ]);
    expect(parsed.items.map(item => item.fhir.sequence)).toEqual([1, 2, 3]);
    expect(parsed.fhirNext.step.map(step => step.component.length)).toEqual([1, 1, 1]);
    expect(parsed.items.slice(0, 2).every(item =>
      item.meta.canonical.clauses[0]?.evidence.some(evidence =>
        evidence.rule === "hpsg.cx.regimen.ordinal-week-stage-duration"
      )
    )).toBe(true);
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.fhirNext.renderedInstruction).toBe(input);

    const strictR5 = toFhirR5Dosages(parsed.fhirNext);
    expect(strictR5.map(item => item.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([0.5, 1, 1]);
    expect(strictR5.map(item => item.timing?.repeat?.timeOfDay))
      .toEqual(parsed.items.map(item => item.fhir.timing?.repeat?.timeOfDay));
    expect(toDosageDetails(strictR5)).toEqual(parsed.fhirNext);
    for (const regimen of [parsed.fhirNext, strictR5]) {
      expect(dueOn(regimen, "2026-11-02")).toEqual([
        "2026-11-02T08:00:00+07:00", "2026-11-02T20:00:00+07:00"
      ]);
      expect(dueOn(regimen, "2026-11-09")).toEqual([
        "2026-11-09T08:00:00+07:00", "2026-11-09T20:00:00+07:00"
      ]);
      expect(dueOn(regimen, "2026-11-16")).toEqual([
        "2026-11-16T08:00:00+07:00", "2026-11-16T14:00:00+07:00",
        "2026-11-16T20:00:00+07:00"
      ]);
    }
  });

  it("does not union the clocks of successive labelled weeks", () => {
    const input = "Week 1: take 1 tablet at 07:00, 12:00 and 17:00. " +
      "Week 2: take 1 tablet at 07:00, 11:00, 15:00 and 19:00.";
    const parsed = parseSig(input, { context: TABLET_CONTEXT });

    expect(parsed.items.map(item => item.fhir.timing?.repeat?.timeOfDay)).toEqual([
      ["07:00:00", "12:00:00", "17:00:00"],
      ["07:00:00", "11:00:00", "15:00:00", "19:00:00"]
    ]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.code))
      .toEqual(["wk", "wk"]);
    expect(parsed.items.map(item => item.fhir.sequence)).toEqual([1, 2]);
    expect(parsed.meta.leftoverText).toBeUndefined();
    const strictR5 = toFhirR5Dosages(parsed.fhirNext);
    for (const regimen of [parsed.fhirNext, strictR5]) {
      expect(dueOn(regimen, "2026-11-02")).toEqual([
        "2026-11-02T07:00:00+07:00", "2026-11-02T12:00:00+07:00",
        "2026-11-02T17:00:00+07:00"
      ]);
      expect(dueOn(regimen, "2026-11-09")).toEqual([
        "2026-11-09T07:00:00+07:00", "2026-11-09T11:00:00+07:00",
        "2026-11-09T15:00:00+07:00", "2026-11-09T19:00:00+07:00"
      ]);
      expect(dueOn(regimen, "2026-11-16")).toEqual([]);
    }
  });

  it.each([
    [
      "สัปดาห์แรกกินครึ่งเม็ดหลังอาหารเช้าและเย็น สัปดาห์ที่สองเพิ่มเป็น 1 เม็ดหลังอาหารเช้าและเย็น",
      [["PCM", "PCV"], ["PCM", "PCV"]],
      true
    ],
    [
      "สัปดาห์ที่ 1 กินครึ่งเม็ดเวลา 07:00 และ 19:00 สัปดาห์ที่ 2 กิน 1 เม็ดเวลา 07:00 และ 19:00",
      [undefined, undefined],
      false
    ]
  ] as const)("retains both Thai labelled-week doses: %s", (input, when, hasPhaseAdjustment) => {
    const parsed = parseSig(input, { locale: "th", context: TABLET_CONTEXT });
    expect(parsed.meta.segments).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value))
      .toEqual([0.5, 1]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.code))
      .toEqual(["wk", "wk"]);
    expect(parsed.items.map(item => item.fhir.sequence)).toEqual([1, 2]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.when)).toEqual([...when]);
    // The previously orphaned เพิ่มเป็น is now a licensed typed HPSG
    // phase-adjustment connective: preserve its source and evidence, not an
    // untranslated leftover next to already-correct week-two dose changes.
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.meta.canonical.clauses[1]?.evidence.some(evidence =>
      evidence.rule === "hpsg.lex.regimen.phaseAdjustment"
    )).toBe(hasPhaseAdjustment);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
    expect(toDosageDetails(toFhirR5Dosages(parsed.fhirNext))).toEqual(parsed.fhirNext);
  });

  it("drops an incompatible four-clock list when the next phase explicitly reduces to TID", () => {
    const input = "รับประทาน 1 เม็ดเวลา 07:00 11:00 15:00 19:00 เป็นเวลา 7 วัน " +
      "แล้วลดเหลือวันละสามครั้งอีก 7 วัน";
    const parsed = parseSig(input, { locale: "th", context: TABLET_CONTEXT });

    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.frequency)).toEqual([undefined, 3]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.timeOfDay)).toEqual([
      ["07:00:00", "11:00:00", "15:00:00", "19:00:00"],
      undefined
    ]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.value)).toEqual([7, 7]);
    const strictR5 = toFhirR5Dosages(parsed.fhirNext);
    expect(strictR5.map(item => item.timing?.repeat?.timeOfDay))
      .toEqual(parsed.items.map(item => item.fhir.timing?.repeat?.timeOfDay));
    expect(toDosageDetails(strictR5)).toEqual(parsed.fhirNext);
    for (const regimen of [parsed.fhirNext, strictR5]) {
      expect(dueOn(regimen, "2026-11-02")).toEqual([
        "2026-11-02T07:00:00+07:00", "2026-11-02T11:00:00+07:00",
        "2026-11-02T15:00:00+07:00", "2026-11-02T19:00:00+07:00"
      ]);
      expect(dueOn(regimen, "2026-11-09")).toEqual([
        "2026-11-09T08:00:00+07:00", "2026-11-09T14:00:00+07:00",
        "2026-11-09T20:00:00+07:00"
      ]);
      expect(dueOn(regimen, "2026-11-16")).toEqual([]);
    }
  });

  it("does not invent a relative course from a lone ordinal-week label", () => {
    const input = "Week 2: take 1 tablet at 08:00.";
    const parsed = parseSig(input, { context: TABLET_CONTEXT });

    expect(parsed.items).toHaveLength(1);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(parsed.fhir.timing?.repeat?.timeOfDay).toEqual(["08:00:00"]);
    expect(parsed.fhir.timing?.repeat?.boundsDuration).toBeUndefined();
    expect(parsed.fhir.sequence).toBeUndefined();
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });
});

describe("established explicit-duration Parkinson phase controls", () => {
  it.each([
    {
      input: "Take 0.5 tablet once daily for 7 days, then 0.5 tablet twice daily for 7 days, then 1 tablet twice daily.",
      locale: undefined,
      doses: [0.5, 0.5, 1], frequencies: [1, 2, 2], durations: [7, 7, undefined], codes: ["d", "d", undefined]
    },
    {
      input: "Take 0.25 mg at bedtime for 1 week, then 0.5 mg at bedtime for 1 week, then 1 mg at bedtime.",
      locale: undefined,
      doses: [0.25, 0.5, 1], frequencies: [undefined, undefined, undefined], durations: [1, 1, undefined], codes: ["wk", "wk", undefined]
    },
    {
      input: "Take 2 tablets three times daily for 7 days, then 1 tablet three times daily for 7 days, then half tablet three times daily for 7 days.",
      locale: undefined,
      doses: [2, 1, 0.5], frequencies: [3, 3, 3], durations: [7, 7, 7], codes: ["d", "d", "d"]
    },
    {
      input: "Take 1 tablet four times daily at 07:00, 11:00, 15:00 and 19:00 for 2 weeks, then take 1 tablet three times daily at 07:00, 13:00 and 19:00.",
      locale: undefined,
      doses: [1, 1], frequencies: [4, 3], durations: [2, undefined], codes: ["wk", undefined]
    },
    {
      input: "กินครึ่งเม็ดวันละสองครั้ง 7 วัน แล้วเพิ่มเป็น 1 เม็ดวันละสองครั้งอีก 7 วัน",
      locale: "th" as const,
      doses: [0.5, 1], frequencies: [2, 2], durations: [7, 7], codes: ["d", "d"]
    },
    {
      input: "รับประทานครึ่งเม็ดเวลา 7.00 12.00 และ 17.00 น. 1 สัปดาห์ จากนั้นเพิ่มเป็น 1 เม็ดเวลา 7.00 12.00 และ 17.00 น.",
      locale: "th" as const,
      doses: [0.5, 1], frequencies: [undefined, undefined], durations: [1, undefined], codes: ["wk", undefined]
    }
  ])("preserves explicit phase membership: $input", ({
    input, locale, doses, frequencies, durations, codes
  }) => {
    const parsed = parseSig(input, {
      ...(locale ? { locale } : {}),
      context: TABLET_CONTEXT
    });

    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value))
      .toEqual(doses);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.frequency)).toEqual(frequencies);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.value))
      .toEqual(durations);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.code))
      .toEqual(codes);
    expect(parsed.items.map(item => item.fhir.sequence))
      .toEqual(parsed.items.map((_item, index) => index + 1));
    expect(toDosageDetails(toFhirR5Dosages(parsed.fhirNext))).toEqual(parsed.fhirNext);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });
});

describe("typed coordinated meal offsets", () => {
  const executionOptions = {
    from: "2026-11-02T00:00:00+07:00",
    orderedAt: "2026-11-02T00:00:00+07:00",
    timeZone: "Asia/Bangkok",
    eventClock: { ACM: "07:30", ACD: "12:00", ACV: "18:30" },
    limit: 3
  } as const;

  it.each([
    ["Take 1 tablet 30 minutes before breakfast, lunch and dinner.", undefined],
    ["รับประทาน 1 เม็ดก่อนอาหารเช้า กลางวัน และเย็น 30 นาที", "th"]
  ] as const)("scopes one exact pre-meal offset across breakfast, lunch, and dinner: %s", (
    input, locale
  ) => {
    const parsed = parseSig(input, {
      ...(locale ? { locale } : {}),
      context: TABLET_CONTEXT
    });

    expect(parsed.items).toHaveLength(1);
    expect(parsed.fhir.timing?.repeat?.when).toEqual(["ACM", "ACD", "ACV"]);
    expect(parsed.fhir.timing?.repeat?.offset).toBe(30);
    expect(parsed.fhir.timing?.repeat?.boundsDuration).toBeUndefined();
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(nextDueDoses(parsed.fhirNext, executionOptions)).toEqual([
      "2026-11-02T07:00:00+07:00",
      "2026-11-02T11:30:00+07:00",
      "2026-11-02T18:00:00+07:00"
    ]);
    const strictR5 = toFhirR5Dosages(parsed.fhirNext);
    expect(nextDueDoses(strictR5, executionOptions)).toEqual(
      nextDueDoses(parsed.fhirNext, executionOptions)
    );
    expect(toDosageDetails(strictR5)).toEqual(parsed.fhirNext);
  });
});

describe("typed same-day Parkinson dose composition", () => {
  const executionOptions = {
    orderedAt: "2026-11-02T00:00:00+07:00",
    timeZone: "Asia/Bangkok",
    eventClock: {
      WAKE: "06:30", HS: "22:00",
      CM: "08:00", CD: "12:30", CV: "18:30"
    },
    mealOffsets: { AC: -30, PCM: 30, PCD: 30, PCV: 30 },
    limit: 12
  } as const;
  const dueOn = (
    regimen: Parameters<typeof nextDueDoses>[0],
    date: "2026-11-02" | "2026-11-09" | "2026-11-16"
  ) => nextDueDoses(regimen, {
    ...executionOptions,
    from: `${date}T00:00:00+07:00`
  }).filter(value => value.startsWith(date));

  it("keeps the half-tablet afternoon dose between the pre-breakfast and bedtime doses", () => {
    const input = "Take 1 tablet 30 minutes before breakfast, half a tablet at 15:00 and 1 tablet at bedtime.";
    const parsed = parseSig(input, { context: TABLET_CONTEXT });

    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity))
      .toEqual([
        { value: 1, unit: "tab" },
        { value: 0.5, unit: "tab" },
        { value: 1, unit: "tab" }
      ]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat)).toEqual([
      expect.objectContaining({ when: ["ACM"], offset: 30 }),
      expect.objectContaining({ timeOfDay: ["15:00:00"] }),
      expect.objectContaining({ when: ["HS"] })
    ]);
    expect(parsed.fhirNext.step).toHaveLength(1);
    expect(parsed.fhirNext.step[0]?.component).toHaveLength(3);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
    expect(parsed.meta.canonical.clauses.map(clause =>
      clause.evidence.find(item => item.lexicalCategory === "dose")?.spans[0]?.text
    )).toEqual(["1 tablet", "half a tablet", "1 tablet"]);

    const strictR5 = toFhirR5Dosages(parsed.fhirNext);
    for (const regimen of [parsed.fhirNext, strictR5]) {
      for (const date of ["2026-11-02", "2026-11-09", "2026-11-16"] as const) {
        expect(dueOn(regimen, date)).toEqual([
          `${date}T07:30:00+07:00`,
          `${date}T15:00:00+07:00`,
          `${date}T22:00:00+07:00`
        ]);
      }
    }
    expect(toDosageDetails(strictR5)).toEqual(parsed.fhirNext);
  });

  it("keeps the half-tablet 22:00 dose separate from the three pre-meal doses", () => {
    const input = "Take 1 tablet 30 minutes before meals, plus half a tablet at 22:00.";
    const parsed = parseSig(input, { context: TABLET_CONTEXT });

    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity))
      .toEqual([{ value: 1, unit: "tab" }, { value: 0.5, unit: "tab" }]);
    expect(parsed.items[0]?.fhir.timing?.repeat).toMatchObject({ when: ["AC"], offset: 30 });
    expect(parsed.items[0]?.fhir.timing?.repeat?.timeOfDay).toBeUndefined();
    expect(parsed.items[1]?.fhir.timing?.repeat).toMatchObject({ timeOfDay: ["22:00:00"] });
    expect(parsed.items[1]?.fhir.timing?.repeat?.when).toBeUndefined();
    expect(parsed.fhirNext.step).toHaveLength(1);
    expect(parsed.fhirNext.step[0]?.component).toHaveLength(2);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
    expect(parsed.meta.canonical.clauses.map(clause =>
      clause.evidence.find(item => item.lexicalCategory === "dose")?.spans[0]?.text
    )).toEqual(["1 tablet", "half a tablet"]);

    const strictR5 = toFhirR5Dosages(parsed.fhirNext);
    for (const regimen of [parsed.fhirNext, strictR5]) {
      for (const date of ["2026-11-02", "2026-11-09", "2026-11-16"] as const) {
        expect(dueOn(regimen, date)).toEqual([
          `${date}T07:30:00+07:00`,
          `${date}T12:00:00+07:00`,
          `${date}T18:00:00+07:00`,
          `${date}T22:00:00+07:00`
        ]);
      }
    }
    expect(toDosageDetails(strictR5)).toEqual(parsed.fhirNext);
  });

  it("composes meal and bedtime daughters on the same day despite a discourse THEN", () => {
    const input = "Take 1 tablet after breakfast and lunch, then half a tablet at bedtime.";
    const parsed = parseSig(input, { context: TABLET_CONTEXT });

    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity))
      .toEqual([{ value: 1, unit: "tab" }, { value: 0.5, unit: "tab" }]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.when))
      .toEqual([["PCM", "PCD"], ["HS"]]);
    expect(parsed.fhirNext.step).toHaveLength(1);
    expect(parsed.fhirNext.step[0]?.component).toHaveLength(2);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);

    const strictR5 = toFhirR5Dosages(parsed.fhirNext);
    for (const regimen of [parsed.fhirNext, strictR5]) {
      for (const date of ["2026-11-02", "2026-11-09", "2026-11-16"] as const) {
        expect(dueOn(regimen, date)).toEqual([
          `${date}T08:30:00+07:00`,
          `${date}T13:00:00+07:00`,
          `${date}T22:00:00+07:00`
        ]);
      }
    }
    expect(toDosageDetails(strictR5)).toEqual(parsed.fhirNext);
  });

  it("composes the waking dose and q4h while-awake daughter without a fake cutover", () => {
    const input = "Take 1 tablet on waking, then 1 tablet every 4 hours while awake.";
    const parsed = parseSig(input, { context: TABLET_CONTEXT });

    // The punctual WAKE dose is the first occurrence of the equivalent
    // q4h waking-day interval. One source-composed schedule must not
    // duplicate the 06:30 dose just because the doctor mentions it twice.
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.fhir.doseAndRate?.[0]?.doseQuantity)
      .toEqual({ value: 1, unit: "tab" });
    expect(parsed.items[0]?.fhir.timing?.repeat).toMatchObject({
      period: 4,
      periodUnit: "h",
      extension: [expect.objectContaining({
        url: expect.stringContaining("/medication-timing-event-window"),
        extension: [
          { url: "start", valueCode: "WAKE" },
          { url: "end", valueCode: "HS" }
        ]
      })]
    });
    expect(parsed.items[0]?.fhir.timing?.repeat?.when).toBeUndefined();
    expect(parsed.fhirNext.step).toHaveLength(1);
    expect(parsed.fhirNext.step[0]?.component).toHaveLength(1);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);

    const strictR5 = toFhirR5Dosages(parsed.fhirNext);
    for (const regimen of [parsed.fhirNext, strictR5]) {
      expect(dueOn(regimen, "2026-11-02")).toEqual([
        "2026-11-02T06:30:00+07:00",
        "2026-11-02T10:30:00+07:00",
        "2026-11-02T14:30:00+07:00",
        "2026-11-02T18:30:00+07:00"
      ]);
    }
    expect(toDosageDetails(strictR5)).toEqual(parsed.fhirNext);
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
