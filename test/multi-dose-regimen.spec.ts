import { describe, expect, it } from "vitest";
import { formatSig, parseSig } from "../src/index";

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

  it("realizes negated food relation cleanly across English and Thai", () => {
    const english = parseSig("do not take with food", { locale: "en" });
    const thai = parseSig("ห้ามรับประทานพร้อมอาหาร", { locale: "th" });
    expect(formatSig(english.fhir, "long", { locale: "th" })).toBe("ห้ามรับประทานพร้อมอาหาร.");
    expect(formatSig(thai.fhir, "long", { locale: "en" })).toBe("Do not take with food.");
  });

  it("does not split ordinary coordination that lacks a new typed dose", () => {
    const procedural = parseSig("wash scalp and rinse", { locale: "en" });
    expect(procedural.count).toBe(1);
    const timingList = parseSig("take 1 tab at 09:00 and 12:00", { context: TABLET_CONTEXT });
    expect(timingList.count).toBe(1);
  });
});
