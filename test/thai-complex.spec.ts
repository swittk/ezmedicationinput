import { describe, expect, it } from "vitest";
import { parseSig, lintSig } from "../src/index";
import { lexInput } from "../src/lexer/lex";
import { scanSurfaceTokens } from "../src/lexer/surface";

const COMPLEX_THAI_SIG =
  "เขย่าขวดก่อนใช้ เทผลิตภัณฑ์ลงฝ่ามือ 1-2 มิลลิลิตร ผสมน้ำเล็กน้อยถูให้เกิดฟอง ทำความสะอาดบริเวณภายนอกจุดซ่อนเร้น จากนั้นล้างด้วยน้ำสะอาด ใช้วันละ 2 ครั้ง เช้าเย็น (ห้ามสวนล้างช่องคลอด).";

describe("Thai clinician free-text parsing", () => {
  it("segments Thai script into source-faithful word boundaries", () => {
    const input = "เขย่าขวดก่อนใช้ เช้าเย็น";
    const tokens = scanSurfaceTokens(input);

    expect(tokens.map((token) => token.original)).toEqual([
      "เขย่า",
      "ขวด",
      "ก่อน",
      "ใช้",
      "เช้า",
      "เย็น"
    ]);
    for (const token of tokens) {
      expect(input.slice(token.start, token.end)).toBe(token.original);
    }
  });

  it("recomposes existing Thai domain compounds before grammar lookup", () => {
    const tokens = lexInput("คันตา หนังศีรษะ วันธรรมดา เม็ดถั่วเขียว");

    expect(tokens.map((token) => token.original)).toEqual([
      "คันตา",
      "หนังศีรษะ",
      "วันธรรมดา",
      "เม็ดถั่วเขียว"
    ]);
  });

  it("normalizes only stable Thai medication lexemes while retaining exact source", () => {
    const input = "ใช้วันละ 2 ครั้ง เช้าเย็น 1-2 มิลลิลิตร";
    const tokens = lexInput(input);

    expect(tokens.map((token) => token.canonical ?? token.lower)).toEqual([
      "use",
      "daily",
      "2",
      "times",
      "morning",
      "evening",
      "1-2",
      "ml"
    ]);
    expect(tokens.find((token) => token.canonical === "daily")?.sourceText).toBe("วันละ");
    expect(tokens.find((token) => token.canonical === "ml")?.sourceText).toBe("มิลลิลิตร");
  });

  it("extracts dose, BID cadence, event timing, and safeguards while preserving procedure prose", () => {
    const result = parseSig(COMPLEX_THAI_SIG, { locale: "th" });
    const repeat = result.fhir.timing?.repeat;
    const doseRange = result.fhir.doseAndRate?.[0]?.doseRange;

    expect(doseRange?.low).toMatchObject({ value: 1, unit: "mL" });
    expect(doseRange?.high).toMatchObject({ value: 2, unit: "mL" });
    expect(repeat).toMatchObject({ frequency: 2, period: 1, periodUnit: "d" });
    expect(repeat?.when).toEqual(["MORN", "EVE"]);
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("BID");
    expect(result.fhir.additionalInstruction?.map((item) => item.text)).toContain(
      "ห้ามสวนล้างช่องคลอด"
    );
    expect(result.fhir.patientInstruction).toBe(
      "เขย่าขวดก่อนใช้ เทผลิตภัณฑ์ลงฝ่ามือ; " +
      "ผสมน้ำเล็กน้อยถูให้เกิดฟอง ทำความสะอาดบริเวณภายนอกจุดซ่อนเร้น จากนั้นล้างด้วยน้ำสะอาด"
    );
    expect(result.meta.leftoverText).toBeUndefined();
    expect(lintSig(COMPLEX_THAI_SIG, { locale: "th" }).issues).toEqual([]);
  });

  it("parses cadence-first Thai word order as frequency rather than total count", () => {
    const twice = parseSig("ใช้วันละ 2 ครั้ง เช้าเย็น", { locale: "th" });
    expect(twice.fhir.timing?.repeat).toMatchObject({
      frequency: 2,
      period: 1,
      periodUnit: "d"
    });
    expect(twice.fhir.timing?.repeat?.count).toBeUndefined();

    const three = parseSig("ใช้วันละ 3 ครั้ง เช้า เที่ยง เย็น", { locale: "th" });
    expect(three.fhir.timing?.repeat).toMatchObject({
      frequency: 3,
      period: 1,
      periodUnit: "d"
    });
    expect(three.fhir.timing?.repeat?.when).toEqual(["MORN", "NOON", "EVE"]);
  });

  it("recognizes common Thai administration verbs and units through the same grammar", () => {
    const oral = parseSig("รับประทาน 1 เม็ด วันละ 2 ครั้ง เช้าเย็น", { locale: "th" });
    expect(oral.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1 });
    expect(oral.fhir.route?.text).toBe("by mouth");
    expect(oral.fhir.timing?.repeat).toMatchObject({ frequency: 2, period: 1, periodUnit: "d" });
  });
});
