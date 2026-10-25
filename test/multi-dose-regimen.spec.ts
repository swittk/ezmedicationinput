import { describe, expect, it } from "vitest";
import conditionBridgeDefinition from "../fhir/r5/medication-conditional-dose.json";
import {
  formatSig,
  calculateTotalUnits,
  getDosageAlternativeChoice,
  getDosageCondition,
  nextDueDoses,
  toDosageDetails,
  toFhirR5Dosages
} from "../src/index";
import { parseSig, parseSigAsync } from "./helpers/r5-parser";
import { AdviceArgumentRole, FhirDosage } from "../src/types";
import { getDosageCalendarDayCondition, setDosageCondition } from "../src/dosage-course";

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
      expect(getDosageCondition(item.fhir)).toMatchObject({ kind: "not", condition: { kind: "state", expected: true } });
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
      expect(getDosageCondition(item.fhir)).toMatchObject({ kind: "not", condition: { kind: "state", expected: true } });
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


describe("fronted treatment-relative ADD source ownership", () => {
  const orderedAt = "2026-11-02T00:00:00+07:00";
  it("retains the source week-two onset with the new dose, not the preceding course", () => {
    const source = "Take 1 tablet at 08:00 and 20:00 daily. From week 2 add half a tablet at 14:00 daily.";
    const parsed = parseSig(source);
    expect(parsed.fhirNext.step).toHaveLength(2);
    expect(parsed.fhirNext.step[1]?.start?.offsetDuration?.value).toBe(7);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      const on = (day: string) => nextDueDoses(dosage, {
        orderedAt, from: day + "T00:00:00+07:00",
        timeZone: "Asia/Bangkok", limit: 8
      }).filter(value => value.startsWith(day)).map(value => value.slice(11, 16));
      expect(on("2026-11-02")).toEqual(["08:00", "20:00"]);
      expect(on("2026-11-09")).toEqual(["08:00", "14:00", "20:00"]);
      expect(on("2026-11-16")).toEqual(["08:00", "14:00", "20:00"]);
      expect(calculateTotalUnits({ dosage, orderedAt, from: orderedAt,
        timeZone: "Asia/Bangkok", durationValue: 14, durationUnit: "d"
      }).totalUnits).toBe(31.5);
    }
  });

  it("keeps the explicit week-two onset if a clinician later edits the first phase length", () => {
    const source = "Take 1 tablet at 08:00 and 20:00 daily. From week 2 add half a tablet at 14:00 daily.";
    const parsed = parseSig(source);
    expect(parsed.fhirNext.step[1]?.start?.offsetDuration?.value).toBe(7);
    const firstCourse = parsed.fhirNext.step[0]?.component[0]?.timing?.repeat?.boundsDuration;
    expect(firstCourse?.value).toBe(7);
    if (!firstCourse) throw new Error("The initial finite phase was not structured.");
    // R6 editing permits changing the first phase without changing the
    // independent author-specified FROM WEEK 2 onset of the added dose.
    firstCourse.value = 5;
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      const on = (day: string) => nextDueDoses(dosage, {
        orderedAt, from: day + "T00:00:00+07:00",
        timeZone: "Asia/Bangkok", limit: 8
      }).filter(value => value.startsWith(day)).map(value => value.slice(11, 16));
      expect(on("2026-11-07")).toEqual([]);
      expect(on("2026-11-09")).toEqual(["08:00", "14:00", "20:00"]);
    }
  });

  it("keeps a fronted week-two full replacement distinct from an addition", () => {
    const input = "Take 1 tablet at 08:00 and 20:00 daily. From week 2 take 1 tablet at 20:00 daily.";
    const parsed = parseSig(input);
    expect(parsed.fhirNext.step).toHaveLength(2);
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      const on = (day: string) => nextDueDoses(dosage, {
        orderedAt, from: day + "T00:00:00+07:00",
        timeZone: "Asia/Bangkok", limit: 8
      }).filter(value => value.startsWith(day)).map(value => value.slice(11, 16));
      expect(on("2026-11-02")).toEqual(["08:00", "20:00"]);
      expect(on("2026-11-09")).toEqual(["20:00"]);
    }
  });
});

describe("typed STOP pause followed by a resumed medication phase", () => {
  it.each([", then resume", ", and resume", "; resume", ". Resume", ", and restart"])(
    "retains the medication-free week before %s", connector => {
      const source = `Take 1 tablet at 08:00 and 20:00 for 7 days, then stop for 7 days${connector} 1 tablet at 08:00 and 20:00 for 7 days.`;
      const parsed = parseSig(source);
      const base = { timeZone: "Asia/Bangkok", orderedAt: "2026-11-02T00:00:00+07:00" };
      for (const regimen of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
        const on = (date: string) => nextDueDoses(regimen, { ...base,
          from: date + "T00:00:00+07:00", limit: 12
        }).filter(at => at.startsWith(date)).map(at => at.slice(11, 16));
        expect(on("2026-11-02")).toEqual(["08:00", "20:00"]);
        expect(on("2026-11-09")).toEqual([]);
        expect(on("2026-11-16")).toEqual(["08:00", "20:00"]);
        expect(on("2026-11-23")).toEqual([]);
        expect(calculateTotalUnits({ dosage: regimen, ...base, from: base.orderedAt,
          durationValue: 28, durationUnit: "d" }).totalUnits).toBe(28);
      }
    }
  );

  it("does not convert ordinary simultaneous AND administrations into a delayed phase", () => {
    const parsed = parseSig("Take 1 tablet at 08:00 and take half a tablet at 20:00 for 7 days.");
    expect(nextDueDoses(parsed.fhirNext, {
      timeZone: "Asia/Bangkok", orderedAt: "2026-11-02T00:00:00+07:00",
      from: "2026-11-02T00:00:00+07:00", limit: 2
    })).toEqual(["2026-11-02T08:00:00+07:00", "2026-11-02T20:00:00+07:00"]);
  });
});

describe("finite recurring-course punctuation and terminal cycle bound", () => {
  it.each([
    "Take 1 tablet daily for 7 days then stop for 7 days repeat for 3 cycles.",
    "Take 1 tablet daily for 7 days, then stop for 7 days; repeat for 3 cycles.",
    "Take 1 tablet daily for 7 days, then stop for 7 days, and repeat for 3 cycles.",
    "Take 1 tablet daily for 7 days. Then stop for 7 days. Repeat for 3 cycles."
  ])("retains one typed finite active/rest course: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.fhirNext.repeatCycle).toMatchObject({ value: 14, code: "d" });
    expect(parsed.fhirNext.step).toHaveLength(1);
    expect(parsed.fhirNext.step[0].count).toBe(3);
    const base = { timeZone: "Asia/Bangkok", orderedAt: "2026-11-02T00:00:00+07:00" };
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(nextDueDoses(dosage, { ...base, from: "2026-12-14T00:00:00+07:00", limit: 2 })).toEqual([]);
      expect(calculateTotalUnits({ dosage, ...base, from: base.orderedAt,
        durationValue: 56, durationUnit: "d" }).totalUnits).toBe(21);
    }
    expect(parsed.input).toBe(source);
  });

  it("does not promote an explicit prohibition on repetition to a recurring course", () => {
    const parsed = parseSig("Take 1 tablet daily for 7 days, then stop for 7 days; do not repeat.");
    expect(parsed.fhirNext.repeatCycle).toBeUndefined();
    expect(parsed.input).toContain("do not repeat");
  });
});

describe("independently dosed administration adjuncts", () => {
  it.each([
    "Take 2 tablets with meals and 1 tablet with snacks.",
    "Take 2 tablets with meals; take 1 tablet with snacks.",
    "Take 2 tablets with meals. Take 1 tablet with snacks.",
    "Take 2 tablets with meals; 1 tablet with snacks.",
    "Take 2 tablets with every meal; take 1 tablet with each snack."
  ])("retains both amounts without assigning meal timing to the snack: %s", input => {
    const parsed = parseSig(input);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity))
      .toEqual([{ value: 2, unit: "tab" }, { value: 1, unit: "tab" }]);
    expect(parsed.items[0].fhir.timing?.repeat?.when).toContain("C");
    expect(parsed.items[1].fhir.timing?.repeat?.when).toBeUndefined();
    expect(parsed.items[1].longText.toLowerCase()).toContain("snack");
    expect(parsed.items[1].fhir.method?.coding?.[0]?.code).toBe("738990001");
    const strict = toFhirR5Dosages(parsed.fhirNext);
    expect(strict.map(row => row.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([2, 1]);
    expect(formatSig(strict[1], "long").toLowerCase()).toContain("snack");
  });

  it("does not turn a separately quantified non-administration procedure into a dose", () => {
    const parsed = parseSig("Take 2 tablets with meals; wash hands with 1 mL of soap.");
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([2]);
    expect(parsed.longText.toLowerCase()).toContain("soap");
  });
});

describe("weekday-set complement anaphora", () => {
  it.each([
    "Take 1 tablet on Monday Wednesday Friday and 0.5 tablet on other days.",
    "Take 1 tablet on Mondays Wednesdays Fridays; take 0.5 tablet on the other days.",
    "Take 1 tablet on Monday Wednesday Friday. Take 0.5 tablet on all remaining days.",
    "Take 1 tablet on Monday Wednesday Friday; 0.5 tablet on the remaining days.",
    "รับประทาน 1 เม็ดวันจันทร์ พุธ ศุกร์ และ 0.5 เม็ดวันอื่น"
  ])("resolves the complement before projecting and scheduling: %s", input => {
    const parsed = parseSig(input);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([1, 0.5]);
    expect(repeat(parsed, 0)?.dayOfWeek).toEqual(["mon", "wed", "fri"]);
    expect(repeat(parsed, 1)?.dayOfWeek).toEqual(["tue", "thu", "sat", "sun"]);
    expect(parsed.items[1].fhir.site).toBeUndefined();
    const strict = toFhirR5Dosages(parsed.fhirNext);
    expect(strict.map(row => row.timing?.repeat?.dayOfWeek)).toEqual([
      ["mon", "wed", "fri"], ["tue", "thu", "sat", "sun"]
    ]);
    const options = { orderedAt: "2026-11-02T00:00:00+07:00", from: "2026-11-02T00:00:00+07:00", timeZone: "Asia/Bangkok", limit: 4 };
    expect(nextDueDoses(strict[1], options).map(value => value.slice(0, 10)))
      .toEqual(["2026-11-03", "2026-11-05", "2026-11-07", "2026-11-08"]);
  });

  it("resolves other days against the whole preceding coordinated weekday set", () => {
    const parsed = parseSig("Take 1 tablet on Monday Wednesday Friday, 0.5 tablet on Tuesday and 2 tablets on the other days.");
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([1, 0.5, 2]);
    expect(repeat(parsed, 2)?.dayOfWeek).toEqual(["thu", "sat", "sun"]);
  });

  it("keeps every-other-day interval distinct from weekday-set anaphora", () => {
    const parsed = parseSig("Take 1 tablet every other day for 7 days.");
    expect(repeat(parsed, 0)).toMatchObject({ period: 2, periodUnit: "d" });
    expect(repeat(parsed, 0)?.dayOfWeek).toBeUndefined();
  });

  it("supports weekend antecedents without changing a separate dose's clock", () => {
    const parsed = parseSig("Take 1 tablet at 08:00 on weekends and 0.5 tablet at 20:00 on other days.");
    expect(repeat(parsed, 0)?.dayOfWeek).toEqual(["sat", "sun"]);
    expect(repeat(parsed, 1)?.dayOfWeek).toEqual(["mon", "tue", "wed", "thu", "fri"]);
    expect(repeat(parsed, 1)?.timeOfDay).toEqual(["20:00:00"]);
  });

  it("does not override an explicit second weekday set", () => {
    const parsed = parseSig("Take 1 tablet on Monday Wednesday Friday and 0.5 tablet on Tuesday Thursday.");
    expect(repeat(parsed, 1)?.dayOfWeek).toEqual(["tue", "thu"]);
  });

  it("does not invent a weekday set without a weekday antecedent", () => {
    const parsed = parseSig("Take 0.5 tablet on the other days.");
    expect(repeat(parsed, 0)?.dayOfWeek).toBeUndefined();
    expect(parsed.longText.toLowerCase()).toContain("other days");
    expect(parsed.fhir.site).toBeUndefined();
  });
});

describe("ordinal week headers scope over every coordinated dose", () => {
  it.each([
    "Week 1: take 1 tablet at 07:00 and half a tablet at 19:00. Week 2: take half a tablet at 07:00 and 19:00.",
    "Week 1: take 1 tablet at 07:00, half a tablet at 19:00. Week 2: take half a tablet at 07:00 and 19:00.",
    "สัปดาห์ที่ 1 รับประทาน 1 เม็ดเวลา 07:00 และครึ่งเม็ดเวลา 19:00 สัปดาห์ที่ 2 รับประทานครึ่งเม็ดเวลา 07:00 และ 19:00"
  ])("ends the whole first phase, not just its last administration: %s", input => {
    const parsed = parseSig(input);
    expect(parsed.fhirNext.step).toHaveLength(2);
    const first = parsed.fhirNext.step[0].component;
    expect(first.map(row => row.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([1, 0.5]);
    expect(first.every(row => row.timing?.repeat?.boundsDuration?.value === 1 &&
      row.timing.repeat.boundsDuration.code === "wk")).toBe(true);
    const base = { timeZone: "Asia/Bangkok", orderedAt: "2026-11-02T00:00:00+07:00" };
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(calculateTotalUnits({ dosage, ...base, from: base.orderedAt,
        durationValue: 21, durationUnit: "d" }).totalUnits).toBe(17.5);
      expect(nextDueDoses(dosage, { ...base, from: "2026-11-16T00:00:00+07:00", limit: 4 })).toEqual([]);
    }
  });

  it.each(["", " indefinitely"])("does not extend a week header across a later unlabelled phase%s", suffix => {
    const p = parseSig(`Week 1: take half a tablet twice daily. Week 2: take 1 tablet twice daily. Then take 1 tablet daily${suffix}.`);
    expect(p.fhirNext.step).toHaveLength(3);
    expect(p.fhirNext.step[2].component[0].timing?.repeat?.boundsDuration).toBeUndefined();
    const base = { orderedAt: "2026-11-02T00:00:00+07:00", from: "2026-11-02T00:00:00+07:00", timeZone: "Asia/Bangkok" };
    for (const dosage of [p.fhirNext, toFhirR5Dosages(p.fhirNext)]) {
      expect(calculateTotalUnits({ dosage, ...base, durationValue: 28, durationUnit: "d" }).totalUnits).toBe(35);
      expect(nextDueDoses(dosage, { ...base, from: "2026-11-23T00:00:00+07:00", limit: 1 })[0])
        .toBe("2026-11-23T09:00:00+07:00");
    }
  });

  it("retains an explicitly open-ended final week and preserves the preceding weekly bound", () => {
    const parsed = parseSig("Week 1: take 1 tablet at 07:00 and half a tablet at 19:00. Week 2 onwards: take half a tablet at 07:00 and 19:00.");
    expect(parsed.fhirNext.step[0].component.every(row => row.timing?.repeat?.boundsDuration?.value === 1)).toBe(true);
    expect(parsed.fhirNext.step[1].component[0].timing?.repeat?.boundsDuration).toBeUndefined();
  });
});

describe("course durations remain outside administration adjunct arguments", () => {
  it.each([
    "Take 2 tablets with meals and 1 tablet with snacks for 14 days.",
    "Take 2 tablets with meals and 1 tablet with snacks for two weeks.",
    "Take 2 tablets with meals and 1 tablet with snacks for an additional 14 days."
  ])("shares the explicit treatment end without inventing snack timing: %s", source => {
    const p = parseSig(source);
    expect(p.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([2, 1]);
    for (const row of p.items.map(item => item.fhir)) {
      const duration = row.timing?.repeat?.boundsDuration;
      expect(duration).toBeDefined();
      expect(duration!.value! * (duration!.code === "wk" ? 7 : 1)).toBe(14);
    }
    expect(p.items[1].fhir.timing?.repeat?.when).toBeUndefined();
    expect(p.items[1].longText.toLowerCase()).toContain("snack");
    const options = { orderedAt: "2026-11-02T00:00:00+07:00", from: "2026-11-16T00:00:00+07:00", timeZone: "Asia/Bangkok", limit: 4 };
    for (const dosage of [p.fhirNext, toFhirR5Dosages(p.fhirNext)]) expect(nextDueDoses(dosage, options)).toEqual([]);
  });

  it("retains two independently specified bounds instead of sharing the shorter one", () => {
    const p = parseSig("Take 2 tablets with meals for 14 days and 1 tablet with snacks for 7 days.");
    expect(p.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.value)).toEqual([14, 7]);
  });

  it("keeps a separate washing duration procedural rather than truncating the medication course", () => {
    const p = parseSig("Take 1 tablet daily for 14 days; wash hands for 1 minute.");
    expect(p.items).toHaveLength(1);
    expect(p.fhir.timing?.repeat?.boundsDuration).toMatchObject({ value: 14, code: "d" });
    expect(p.longText.toLowerCase()).toContain("minute");
  });
});

// Cardinal durations must not be confused with indexed treatment periods.
describe("cardinal versus ordinal course periods", () => {
  it.each([["two days", 2], ["three days", 3], ["four days", 4],
    ["two weeks", 14], ["three weeks", 21], ["four weeks", 28], ["2 weeks", 14]])(
    "keeps the complete duration of %s", (duration, days) => {
      const parsed = parseSig(`Take 1 tablet daily for ${duration}.`);
      expect(parsed.meta.canonical.clauses[0].schedule?.treatmentStartOffsetDays).toBeUndefined();
      const base = { orderedAt: "2026-11-02T00:00:00+07:00", from: "2026-11-02T00:00:00+07:00", timeZone: "Asia/Bangkok" };
      for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
        expect(nextDueDoses(dosage, { ...base, limit: 1 })[0]).toBe("2026-11-02T09:00:00+07:00");
        expect(calculateTotalUnits({ dosage, ...base, durationValue: 35, durationUnit: "d" }).totalUnits).toBe(days);
      }
    }
  );
  it.each([["the second week", 7], ["week two", 7], ["the third week", 14], ["week three", 14]])(
    "retains the treatment-relative ordinal in %s", (period, offset) => {
      const parsed = parseSig(`Take 1 tablet daily for ${period}.`);
      expect(parsed.meta.canonical.clauses[0].schedule).toMatchObject({
        treatmentStartOffsetDays: offset, duration: 1, durationUnit: "wk"
      });
    }
  );
});

describe("shared course bounds on dose-elliptic event lists", () => {
  it.each([
    ["Take 1 tablet 30 minutes before breakfast and 15 minutes after dinner for 7 days.", [30, 15], ["ACM", "PCV"]],
    ["Take 1 tablet 30 minutes before breakfast and 15 minutes before dinner for 7 days.", [30, 15], ["ACM", "ACV"]],
    ["Take 1 tablet 30 minutes before breakfast, 20 minutes before lunch and 15 minutes after dinner for 7 days.", [30, 20, 15], ["ACM", "ACD", "PCV"]]
  ])("keeps each relative event independent and scopes the shared end: %s", (source, offsets, events) => {
    const parsed = parseSig(source as string);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.offset)).toEqual(offsets);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.when?.[0])).toEqual(events);
    expect(parsed.items.every(item => item.fhir.timing?.repeat?.boundsDuration?.value === 7)).toBe(true);
    const base = { orderedAt: "2026-11-02T00:00:00+07:00", from: "2026-11-02T00:00:00+07:00", timeZone: "Asia/Bangkok" };
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(calculateTotalUnits({ dosage, ...base, durationValue: 14, durationUnit: "d" }).totalUnits).toBe(7 * offsets.length);
      expect(nextDueDoses(dosage, { ...base, from: "2026-11-09T00:00:00+07:00", limit: 2 })).toEqual([]);
    }
  });

  it("preserves explicitly different course lengths", () => {
    const parsed = parseSig("Take 1 tablet 30 minutes before breakfast for 14 days and 15 minutes after dinner for 7 days.");
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.value)).toEqual([14, 7]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.offset)).toEqual([30, 15]);
  });
});

describe("complementary registered activity-day predicates", () => {
  const evaluate = (member: boolean): NonNullable<Parameters<typeof nextDueDoses>[1]>["evaluateCondition"] => {
    const visit = (condition: NonNullable<ReturnType<typeof getDosageCondition>>): boolean =>
      condition.kind === "not" ? !visit(condition.condition) :
      condition.kind === "all" ? condition.conditions.every(visit) :
      condition.kind === "any" ? condition.conditions.some(visit) : member;
    return visit;
  };
  it.each([
    "Take 1 tablet at 08:00 on non-dialysis days.",
    "Take 1 tablet at 08:00 only on non-hemodialysis days.",
    "Take 1 tablet at 08:00 on non dialysis days.",
    "รับประทาน 1 เม็ดเวลา 08:00 ในวันที่ไม่ฟอกไต",
    "รับประทาน 1 เม็ดเวลา 08:00 เฉพาะวันไม่ฟอกไต"
  ])("retains negated membership rather than an unconditional daily dose: %s", source => {
    const p = parseSig(source);
    const condition = getDosageCondition(p.fhir);
    expect(condition?.kind).toBe("not");
    const base = { orderedAt: "2026-11-02T00:00:00+07:00", from: "2026-11-02T00:00:00+07:00", timeZone: "Asia/Bangkok", limit: 1 };
    for (const dosage of [p.fhirNext, toFhirR5Dosages(p.fhirNext)]) {
      expect(nextDueDoses(dosage, { ...base, evaluateCondition: evaluate(true) })).toEqual([]);
      expect(nextDueDoses(dosage, { ...base, evaluateCondition: evaluate(false) })[0]).toBe("2026-11-02T08:00:00+07:00");
    }
  });
  it("keeps different doses mutually exclusive on activity and non-activity days", () => {
    const p = parseSig("Take 1 tablet at 08:00 on dialysis days and half a tablet at 20:00 on non-dialysis days.");
    expect(p.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([1, 0.5]);
    const base = { orderedAt: "2026-11-02T00:00:00+07:00", from: "2026-11-02T00:00:00+07:00", timeZone: "Asia/Bangkok", limit: 2 };
    for (const dosage of [p.fhirNext, toFhirR5Dosages(p.fhirNext)]) {
      expect(nextDueDoses(dosage, { ...base, evaluateCondition: evaluate(true) }).filter(at => at.startsWith("2026-11-02"))).toEqual(["2026-11-02T08:00:00+07:00"]);
      expect(nextDueDoses(dosage, { ...base, evaluateCondition: evaluate(false) }).filter(at => at.startsWith("2026-11-02"))).toEqual(["2026-11-02T20:00:00+07:00"]);
    }
  });
  it("uses a caller-registered activity rather than a dialysis-specific negative rule", () => {
    const p = parseSig("Take 1 tablet at 08:00 on non-physiotherapy days.", {
      instructionConceptMap: { physiotherapy: {
        role: AdviceArgumentRole.Activity, display: "physiotherapy",
        coding: { system: "https://example.test/activity", code: "physiotherapy" }
      } }
    });
    expect(getDosageCondition(p.fhir)).toEqual({
      kind: "not", condition: { kind: "text", text: "physiotherapy days" }
    });
  });
  it("leaves a separate negative activity-day counseling instruction scoped to that instruction", () => {
    const p = parseSig("Take 1 tablet daily. Do not exercise on non-dialysis days.");
    expect(getDosageCondition(p.fhir)).toBeUndefined();
    expect(p.longText.toLowerCase()).toContain("non-dialysis days");
  });
  it("composes exclusion with a negative day domain without losing either operator", () => {
    const p = parseSig("Take 1 tablet at 08:00 except on non-dialysis days.");
    expect(getDosageCondition(p.fhir)).toMatchObject({ kind: "text", text: "dialysis days" });
  });
});

describe("one-time execution uses structured administration timing, not counseling text", () => {
  const start = "2026-11-02T08:00:00+07:00";
  const options = { orderedAt: start, from: start, timeZone: "Asia/Bangkok", limit: 2 };
  it.each(["Do not drive after taking.", "Wash hands before handling the tablet.", "Keep the medicine away from children."])(
    "does not erase a supplied one-time administration because of advice: %s", advice => {
      const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { count: 1, boundsPeriod: { start } } }, patientInstruction: advice };
      const course = toDosageDetails([row]);
      for (const dosage of [row, course, toFhirR5Dosages(course)]) {
        expect(nextDueDoses(dosage, options)).toEqual([start]);
        expect(calculateTotalUnits({ dosage, ...options, durationValue: 1, durationUnit: "d" }).totalUnits).toBe(1);
      }
      expect(row.patientInstruction).toBe(advice);
    }
  );
  it("keeps a source-defined one-time dose separate from a driving warning", () => {
    const p = parseSig("Take 1 tablet once. Do not drive after taking.");
    for (const dosage of [p.fhirNext, toFhirR5Dosages(p.fhirNext)]) {
      expect(nextDueDoses(dosage, options)).toEqual([start]);
      expect(calculateTotalUnits({ dosage, ...options, durationValue: 1, durationUnit: "d" }).totalUnits).toBe(1);
    }
  });
  it.each(["Take 1 tablet once after dialysis.", "insert 1 tab pv once after menstruation ends"])(
    "retains a source-owned relative activity without inventing its date: %s", source => {
      const p = parseSig(source);
      expect(p.meta.canonical.clauses[0].schedule?.activityTiming?.[0]).toMatchObject({ relation: "after" });
      for (const dosage of [p.fhirNext, toFhirR5Dosages(p.fhirNext)]) {
        expect(nextDueDoses(dosage, options)).toEqual([]);
        expect(calculateTotalUnits({ dosage, ...options, durationValue: 1, durationUnit: "d" }).totalUnits).toBe(0);
      }
    }
  );
  it("uses an explicitly supplied event instant to resolve the one-time occurrence", () => {
    const row = toFhirR5Dosages(parseSig("Take 1 tablet once after dialysis.").fhirNext)[0];
    row.timing = { ...row.timing, event: [start] };
    expect(nextDueDoses(row, options)).toEqual([start]);
  });
});

describe("scheduled courses followed by independently dosed PRN use", () => {
  it.each([
    "Take 1 tablet daily for 7 days then 1 tablet as needed.",
    "Take 1 tablet daily for 7 days, then 1 tablet PRN.",
    "Take 1 tablet daily for 7 days; then take 1 tablet as needed.",
    "Apply 1 mL to scalp nightly for 7 days then 1 mL as needed.",
    "รับประทาน 1 เม็ดวันละครั้ง 7 วัน จากนั้น 1 เม็ดเมื่อมีอาการปวด"
  ])("keeps the scheduled course non-PRN and the successor non-recurring: %s", source => {
    const p = parseSig(source);
    expect(p.items).toHaveLength(2);
    expect(p.fhirNext.step).toHaveLength(2);
    expect(p.items[0].fhir.asNeeded).not.toBe(true);
    expect(p.items[1].fhir.asNeeded).toBe(true);
    expect(p.items[0].fhir.timing?.repeat?.boundsDuration).toMatchObject({ value: 7, code: "d" });
    expect(p.items[1].fhir.timing?.repeat?.frequency).toBeUndefined();
    expect(p.items[1].fhir.timing?.repeat?.when).toBeUndefined();
    expect(p.items[1].fhir.method?.coding?.[0]?.code).toBe(p.items[0].fhir.method?.coding?.[0]?.code);
    const base = { orderedAt: "2026-11-02T00:00:00+07:00", from: "2026-11-02T00:00:00+07:00", timeZone: "Asia/Bangkok" };
    for (const dosage of [p.fhirNext, toFhirR5Dosages(p.fhirNext)]) {
      expect(nextDueDoses(dosage, { ...base, limit: 20 })).toHaveLength(7);
      expect(nextDueDoses(dosage, { ...base, from: "2026-11-09T00:00:00+07:00", limit: 2 })).toEqual([]);
    }
  });

  it("retains a single PRN course when no new administration is stated", () => {
    const p = parseSig("Take 1 tablet daily for 7 days as needed.");
    expect(p.items).toHaveLength(1);
    expect(p.fhir.asNeeded).toBe(true);
  });

  it("keeps coordinated standing and rescue doses separate without changing them into sequential phases", () => {
    const p = parseSig("Take 1 tablet daily and 1 tablet as needed for pain.");
    expect(p.items).toHaveLength(2);
    expect(p.items[0].fhir.asNeeded).not.toBe(true);
    expect(p.items[1].fhir.asNeeded).toBe(true);
    expect(p.fhirNext.step).toHaveLength(1);
  });
});

describe("source-licensed dose ellipsis in a PRN successor phase", () => {
  it.each([
    "Take 1 tablet daily for 7 days then as needed.",
    "Take 1 tablet daily for 7 days, then PRN for pain.",
    "Take 1 tablet daily for 7 days then take as needed.",
    "รับประทาน 1 เม็ดวันละครั้ง 7 วัน จากนั้นเมื่อมีอาการปวด"
  ])("inherits the unambiguous dose, not the standing cadence or PRN flag: %s", source => {
    const p = parseSig(source);
    expect(p.items).toHaveLength(2);
    expect(p.fhirNext.step).toHaveLength(2);
    expect(p.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity)).toEqual([
      { value: 1, unit: "tab" }, { value: 1, unit: "tab" }
    ]);
    expect(p.items[0].fhir.asNeeded).not.toBe(true);
    expect(p.items[1].fhir.asNeeded).toBe(true);
    expect(p.items[1].fhir.timing?.repeat?.frequency).toBeUndefined();
    expect(p.items[1].fhir.timing?.repeat?.boundsDuration).toBeUndefined();
    const base = { orderedAt: "2026-11-02T00:00:00+07:00", from: "2026-11-02T00:00:00+07:00", timeZone: "Asia/Bangkok" };
    for (const dosage of [p.fhirNext, toFhirR5Dosages(p.fhirNext)]) {
      expect(nextDueDoses(dosage, { ...base, limit: 20 })).toHaveLength(7);
      // Supply is a maximum, unlike nextDue's scheduled-dose enumeration.
      // Unbounded PRN use has no numeric maximum to invent.
      expect(() => calculateTotalUnits({ dosage, ...base, durationValue: 14, durationUnit: "d" }))
        .toThrow(/frequency|timing|dosing time/i);
    }
  });

  it("does not choose a dose from conflicting preceding parallel amounts", () => {
    const p = parseSig("Take 1 tablet at 08:00 and half a tablet at 20:00 for 7 days then as needed.");
    expect(p.items.slice(0, 2).map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([1, 0.5]);
    expect(p.items.slice(0, 2).every(item => item.fhir.asNeeded !== true)).toBe(true);
    expect(p.fhirNext.step).toHaveLength(2);
    const successor = p.fhirNext.step[1].component[0];
    expect(successor.asNeeded).toBe(true);
    expect(successor.doseAndRate?.[0]?.doseQuantity).toBeUndefined();
    expect(p.fhirNext.renderedInstruction).toBe("Take 1 tablet at 08:00 and half a tablet at 20:00 for 7 days then as needed.");
  });
});

describe("maximum occurrence count adverbs retain PRN semantics", () => {
  it.each([
    ["up to twice daily", 2, "d"], ["up to once daily", 1, "d"],
    ["no more than thrice daily", 3, "d"], ["maximum twice weekly", 2, "wk"],
    ["up to 2 times daily", 2, "d"], ["maximum 3 times weekly", 3, "wk"]
  ])("composes %s as a cap, not a scheduled cadence or opaque advice", (phrase, max, unit) => {
    const p = parseSig(`Take 1 tablet as needed ${phrase}.`);
    expect(p.fhir.asNeeded).toBe(true);
    expect(p.meta.canonical.clauses[0].schedule?.occurrenceCap)
      .toEqual({ max, period: 1, periodUnit: unit });
    expect(p.fhir.timing?.repeat?.frequency).toBeUndefined();
    for (const row of toFhirR5Dosages(p.fhirNext)) {
      expect(row.asNeeded).toBe(true);
      expect(row.timing?.repeat?.extension).toContainEqual(expect.objectContaining({
        url: expect.stringContaining("occurrence-cap")
      }));
    }
  });

  it("does not reinterpret an unqualified twice-daily cadence as a maximum", () => {
    const p = parseSig("Take 1 tablet twice daily.");
    expect(p.fhir.timing?.repeat).toMatchObject({ frequency: 2, period: 1, periodUnit: "d" });
    expect(p.meta.canonical.clauses[0].schedule?.occurrenceCap).toBeUndefined();
    expect(p.fhir.asNeeded).not.toBe(true);
  });

  it("retains a scheduled first stage followed by a capped PRN stage", () => {
    const p = parseSig("Take 1 tablet daily for 7 days then 1 tablet as needed up to twice daily.");
    expect(p.fhirNext.step).toHaveLength(2);
    expect(p.items[0].fhir.asNeeded).not.toBe(true);
    expect(p.items[1].fhir.asNeeded).toBe(true);
    expect(p.items[1].meta.canonical.clauses[0].schedule?.occurrenceCap).toEqual({ max: 2, period: 1, periodUnit: "d" });
    expect(p.items[1].fhir.timing?.repeat?.frequency).toBeUndefined();
  });
});

describe("calendar-day predicate type survives condition projection", () => {
  it.each([
    "Take 1 tablet at 08:00 on dialysis days.",
    "Take 1 tablet at 08:00 except on dialysis days.",
    "รับประทาน 1 เม็ดเวลา 08:00 เฉพาะวันฟอกไต"
  ])("retains a typed day-domain witness, not a guessed interpretation of its text: %s", source => {
    const p = parseSig(source);
    expect(p.meta.canonical.clauses[0].clinicalAdjuncts?.calendarDayCondition).toBeDefined();
    for (const row of [p.fhir, ...p.fhirNext.step.flatMap(step => step.component), ...toFhirR5Dosages(p.fhirNext)]) {
      expect(row.modifierExtension?.some(extension => extension.extension?.some(part => part.url === "calendarDayPredicate"))).toBe(true);
    }
    expect(p.fhirNext.renderedInstruction).toBe(source);
  });
});

describe("calendar-day typing does not outlive an edited condition", () => {
  it("reads the same source-certified predicate in all representations", () => {
    const p = parseSig("Take 1 tablet at 08:00 on dialysis days.");
    const expected = getDosageCondition(p.fhir);
    for (const row of [p.fhir, ...p.fhirNext.step[0].component, ...toFhirR5Dosages(p.fhirNext)]) {
      expect(getDosageCalendarDayCondition(row)).toEqual(expected);
    }
  });
  it("does not apply stale calendar metadata after a native condition is cleared", () => {
    const p = parseSig("Take 1 tablet at 08:00 on dialysis days.");
    p.fhirNext.step[0].component[0].condition = [];
    expect(getDosageCalendarDayCondition(p.fhirNext.step[0].component[0])).toBeUndefined();
    const strict = toFhirR5Dosages(p.fhirNext);
    expect(getDosageCondition(strict[0])).toBeUndefined();
    expect(getDosageCalendarDayCondition(strict[0])).toBeUndefined();
  });
  it("does not label a changed measurement or a mixed day/measurement predicate as day-constant", () => {
    const row: FhirDosage = {};
    const day = { kind: "text" as const, text: "dialysis days" };
    const measurement = { kind: "measurement" as const, name: "systolic BP", operation: "gt" as const, value: 100, unit: "mmHg", text: "systolic BP above 100 mmHg" };
    setDosageCondition(row, day, day);
    expect(getDosageCalendarDayCondition(row)).toEqual(day);
    setDosageCondition(row, measurement);
    expect(getDosageCondition(row)).toEqual(measurement);
    expect(getDosageCalendarDayCondition(row)).toBeUndefined();
    setDosageCondition(row, { kind: "all", conditions: [day, measurement] }, day);
    expect(getDosageCalendarDayCondition(row)).toBeUndefined();
    expect(getDosageCondition(row)).toEqual({ kind: "all", conditions: [day, measurement] });
  });
  it("leaves a separate unknown modifier intact while carrying known day metadata", () => {
    const unknown = { url: "https://example.test/unknown-condition", valueString: "retain me" };
    const row: FhirDosage = { modifierExtension: [unknown] };
    const day = { kind: "text" as const, text: "dialysis days" };
    setDosageCondition(row, day, day);
    const strict = toFhirR5Dosages(toDosageDetails([row]));
    expect(strict[0].modifierExtension).toContainEqual(unknown);
    expect(getDosageCalendarDayCondition(strict[0])).toEqual(day);
  });
});

describe("shared trailing course across coordinated target changes", () => {
  it.each([
    "Instill 1 drop in right eye at 08:00,12:00,20:00 and 1 drop in left eye at 08:00,20:00 for 7 days.",
    "Instill 1 drop in right eye at 08:00, 12:00 and 20:00 and 1 drop in left eye at 08:00 and 20:00 for 7 days.",
    "หยอดตาขวา 1 หยดเวลา 08:00 12:00 20:00 และตาซ้าย 1 หยดเวลา 08:00 20:00 เป็นเวลา 7 วัน"
  ])("bounds both separately timed targets without copying their clocks: %s", source => {
    const p = parseSig(source);
    expect(p.items).toHaveLength(2);
    expect(p.items.map(item => item.fhir.timing?.repeat?.timeOfDay)).toEqual([
      ["08:00:00", "12:00:00", "20:00:00"], ["08:00:00", "20:00:00"]
    ]);
    expect(p.items.every(item => item.fhir.timing?.repeat?.boundsDuration?.value === 7)).toBe(true);
    const base = { orderedAt: "2026-11-02T00:00:00+07:00", from: "2026-11-02T00:00:00+07:00", timeZone: "Asia/Bangkok" };
    for (const dosage of [p.fhirNext, toFhirR5Dosages(p.fhirNext)]) {
      expect(calculateTotalUnits({ dosage, ...base, durationValue: 28, durationUnit: "d" }).totalUnits).toBe(35);
      expect(nextDueDoses(dosage, { ...base, from: "2026-11-09T00:00:00+07:00", limit: 2 })).toEqual([]);
    }
  });
  it("retains explicitly distinct target-course lengths", () => {
    const p = parseSig("Instill 1 drop in right eye at 08:00,12:00,20:00 for 14 days and 1 drop in left eye at 08:00,20:00 for 7 days.");
    expect(p.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.value)).toEqual([14, 7]);
    expect(p.items.map(item => item.fhir.timing?.repeat?.timeOfDay?.length)).toEqual([3, 2]);
  });
});

describe("explicit daily clock lists are not labelled once daily", () => {
  it.each([
    "Take 1 tablet at 07:00, 13:00 and 19:00 daily for 7 days.",
    "รับประทาน 1 เม็ดเวลา 07:00 13:00 19:00 ทุกวัน 7 วัน"
  ])("renders daily recurrence and all clocks consistently without modifying stored frequency: %s", source => {
    const p = parseSig(source);
    expect(p.fhir.timing?.repeat?.timeOfDay).toEqual(["07:00:00", "13:00:00", "19:00:00"]);
    expect(p.longText.toLowerCase()).not.toContain("once daily");
    const original = structuredClone(p.fhir);
    for (const dosage of [p.fhir, p.fhirNext, toFhirR5Dosages(p.fhirNext)]) {
      for (const style of ["short", "long"] as const) {
        const en = formatSig(dosage, style, { locale: "en" });
        const th = formatSig(dosage, style, { locale: "th" });
        expect(en.toLowerCase()).not.toMatch(/once daily|\b1x\/d\b/);
        expect(th).not.toMatch(/วันละ(?:\s*1\s*)?ครั้ง/);
        expect(style === "short" ? en : en.toLowerCase()).toContain(style === "short" ? "07:00" : "7:00 am");
        expect(th).toContain("07:00");
      }
    }
    expect(p.fhir).toEqual(original);
  });

  it("retains a genuine once-daily instruction at one explicit clock", () => {
    const p = parseSig("Take 1 tablet at 07:00 daily.");
    expect(formatSig(p.fhir, "long", { locale: "en" })).toContain("once daily");
    expect(formatSig(p.fhir, "long", { locale: "th" })).toMatch(/วันละ(?:\s*1\s*)?ครั้ง/);
  });
  it("retains an explicit twice-daily count that agrees with two clocks", () => {
    const p = parseSig("Take 1 tablet twice daily at 08:00 and 20:00.");
    expect(formatSig(p.fhir, "long", { locale: "en" })).toContain("twice daily");
    expect(formatSig(p.fhir, "long", { locale: "th" })).toContain("วันละ 2 ครั้ง");
  });
});


describe("shared course duration on headed and headless clinical SIG lists", () => {
  it.each([
    ["0.5 tab PO at 07:00, 1 tab PO at 12:00 and 0.5 tab PO at 19:00 x7d", 7, 14, 3],
    ["1 tab PO at 07:00, 0.5 tab PO at 12:00, 1 tab PO at 17:00 and 0.5 tab PO at 22:00 x14d", 14, 42, 4],
    ["OD 1 drop at 08:00,12:00,20:00 and OS 1 drop at 08:00,20:00 x7d", 7, 35, 2]
  ] as const)("scopes the finite duration over the complete coordination: %s", (source, days, quantity, rows) => {
    const p = parseSig(source);
    expect(p.items).toHaveLength(rows);
    expect(p.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.value))
      .toEqual(Array(rows).fill(days));
    const base = { from: "2026-11-02T00:00:00+07:00", orderedAt: "2026-11-02T00:00:00+07:00", timeZone: "Asia/Bangkok" };
    for (const dosage of [p.fhirNext, toFhirR5Dosages(p.fhirNext)]) {
      expect(calculateTotalUnits({ dosage, ...base, durationValue: 28, durationUnit: "d" }).totalUnits).toBe(quantity);
      expect(nextDueDoses(dosage, { ...base, from: days === 7 ? "2026-11-09T00:00:00+07:00" : "2026-11-16T00:00:00+07:00", limit: 2 })).toEqual([]);
    }
    expect(p.fhirNext.renderedInstruction).toBe(source);
  });
});


describe("source-shared negative instructions carry their typed guard", () => {
  it.each([
    "take 1 tab at 12:00, then 2 tabs at 16:00, and 1.5 tabs before sleep; do not take if low blood pressure",
    "รับประทาน 1 เม็ด เวลา 12:00 จากนั้น 2 เม็ด เวลา 16:00 และ 1.5 เม็ด ก่อนนอน; ห้ามรับประทานหากความดันโลหิตต่ำ"
  ])("evaluates the shared prohibition on every related dosage: %s", source => {
    const p = parseSig(source, { context: TABLET_CONTEXT });
    const base = { from: "2026-11-02T00:00:00+07:00", orderedAt: "2026-11-02T00:00:00+07:00", timeZone: "Asia/Bangkok", eventClock: { HS: "22:00" }, durationValue: 1, durationUnit: "d" as const };
    for (const dosage of [p.fhirNext, toFhirR5Dosages(p.fhirNext)]) {
      expect(calculateTotalUnits({ dosage, ...base, evaluateCondition: () => false }).totalUnits).toBe(0);
      expect(calculateTotalUnits({ dosage, ...base, evaluateCondition: () => true }).totalUnits).toBe(4.5);
    }
    expect(p.fhirNext.renderedInstruction).toBe(source);
  });
});


describe("independent conditional counseling cannot absorb prescription timing", () => {
  it.each(["avoid driving if drowsy", "ห้ามขับรถหากง่วง", "avoid driving", "do not drive if drowsy"])(
    "preserves the finite PRN course and cap beside %s", counseling => {
      const source = `1 tab PO q6h PRN pain max 4 doses/day x7d; ${counseling}`;
      const p = parseSig(source);
      expect(p.fhir.timing?.repeat?.boundsDuration?.value).toBe(7);
      expect(p.fhir.maxDosePerPeriod?.[0]?.numerator?.value).toBe(4);
      expect(getDosageCondition(p.fhir)).toBeUndefined();
      expect(p.fhir.asNeeded).toBe(true);
      const base = { from: "2026-11-02T00:00:00+07:00", orderedAt: "2026-11-02T00:00:00+07:00", timeZone: "Asia/Bangkok" };
      for (const dosage of [p.fhirNext, toFhirR5Dosages(p.fhirNext)]) {
        expect(calculateTotalUnits({ dosage, ...base, durationValue: 28, durationUnit: "d" }).totalUnits).toBe(28);
        expect(nextDueDoses(dosage, { ...base, from: "2026-11-09T00:00:00+07:00", limit: 1 })).toEqual([]);
      }
      expect(p.fhirNext.renderedInstruction).toBe(source);
    }
  );
});


describe("published condition bridge metadata contract", () => {
  it("declares the optional whole-day witness alongside its executable predicate", () => {
    const parsed = parseSig("1 tab PO at 08:00 on dialysis days");
    const bridge = parsed.fhir.modifierExtension?.find(extension =>
      extension.extension?.some(child => child.url === "calendarDayPredicate"));
    expect(bridge?.extension?.map(child => child.url)).toEqual(["predicate", "calendarDayPredicate"]);
    const elements = conditionBridgeDefinition.differential.element;
    const rootChildren = elements.find(element => element.id === "Extension.extension");
    expect(rootChildren?.max === "*" || Number(rootChildren?.max) >= bridge!.extension!.length).toBe(true);
    expect(elements).toContainEqual(expect.objectContaining({
      id: "Extension.extension:calendarDayPredicate", sliceName: "calendarDayPredicate", min: 0, max: "1"
    }));
    expect(elements).toContainEqual(expect.objectContaining({
      id: "Extension.extension:calendarDayPredicate.url", fixedUri: "calendarDayPredicate"
    }));
    expect(elements).toContainEqual(expect.objectContaining({
      id: "Extension.extension:calendarDayPredicate.extension:kind.value[x]", type: [{ code: "code" }]
    }));
  });
});
