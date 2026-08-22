import { describe, expect, it } from "vitest";
import {
  formatSig,
  fromFhirDosage,
  lintSig,
  parseInstructionActions,
  parseSig,
  realizeInstructionGraph
} from "../src/index";
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

  it("builds an ordered procedural graph with typed arguments and RF2-backed SNOMED mappings", () => {
    const result = parseSig(COMPLEX_THAI_SIG, { locale: "th" });
    const graph = result.meta.canonical.clauses[0]?.instructionGraph;
    expect(graph?.actions.map((action) => action.predicate.lemma)).toEqual([
      "shake",
      "pour",
      "mix",
      "rub",
      "clean",
      "rinse",
      "douche"
    ]);

    const pour = graph?.actions[1];
    expect(pour?.args.find((arg) => arg.role === "destination")).toMatchObject({
      normalized: "palm",
      coding: { system: "http://snomed.info/sct", code: "731973001" }
    });
    expect(pour?.args.find((arg) => arg.role === "amount")?.quantity).toEqual({
      value: undefined,
      range: { low: 1, high: 2 },
      unit: "mL"
    });

    const douche = graph?.actions[6];
    expect(douche?.polarity).toBe("negate");
    expect(douche?.predicate.codings).toContainEqual(
      expect.objectContaining({
        system: "http://snomed.info/sct",
        code: "21397001",
        display: "Douche of vagina"
      })
    );
    expect(douche?.args[0]).toMatchObject({
      role: "site",
      normalized: "vagina",
      coding: { system: "http://snomed.info/sct", code: "76784001" }
    });
  });

  it("realizes the semantic graph into understandable Thai and English", () => {
    const result = parseSig(COMPLEX_THAI_SIG, { locale: "th" });
    const graph = result.meta.canonical.clauses[0]?.instructionGraph;
    expect(graph).toBeDefined();
    if (!graph) return;

    expect(realizeInstructionGraph(graph, "th")).toBe(
      "เขย่าขวดก่อนใช้ จากนั้นเทผลิตภัณฑ์ลงฝ่ามือ 1-2 มิลลิลิตร จากนั้นผสมน้ำเล็กน้อย " +
      "จากนั้นถูให้เกิดฟอง จากนั้นทำความสะอาดบริเวณภายนอกจุดซ่อนเร้น " +
      "จากนั้นล้างด้วยน้ำสะอาด; ห้ามสวนล้างช่องคลอด"
    );
    expect(realizeInstructionGraph(graph, "en")).toBe(
      "Shake bottle before use; then Pour product 1-2 mL into the palm; " +
      "then Mix with a small amount of water; then Rub to form foam; " +
      "then Clean external intimate area; then Rinse with clean water; " +
      "Do not douche the vagina"
    );
  });

  it("preserves the instruction graph through FHIR and regenerates either language", () => {
    const parsed = parseSig(COMPLEX_THAI_SIG, { locale: "th" });
    const restored = fromFhirDosage(parsed.fhir);
    const restoredGraph = restored.meta.normalized.instructionGraph;

    expect(restoredGraph?.actions.map((action) => action.predicate.lemma)).toEqual([
      "shake",
      "pour",
      "mix",
      "rub",
      "clean",
      "rinse",
      "douche"
    ]);
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).toContain(
      "เทผลิตภัณฑ์ลงฝ่ามือ 1-2 มิลลิลิตร"
    );
    expect(formatSig(parsed.fhir, "long", { locale: "en" })).toContain(
      "Pour product 1-2 mL into the palm"
    );
    expect(formatSig(parsed.fhir, "long", { locale: "en" })).toContain(
      "Do not douche the vagina"
    );
  });

  it("understands ordinary English procedural negation through the same action model", () => {
    const frames = parseInstructionActions(
      "shake bottle before use then pour product into palm then do not douche vagina"
    );
    expect(frames.map((frame) => frame.predicate.lemma)).toEqual([
      "shake",
      "pour",
      "douche"
    ]);
    expect(frames[2]).toMatchObject({ polarity: "negate" });
  });


  it("reparses Thai and English realizations without changing the procedural action sequence", () => {
    const parsed = parseSig(COMPLEX_THAI_SIG, { locale: "th" });
    const graph = parsed.meta.canonical.clauses[0]?.instructionGraph;
    expect(graph).toBeDefined();
    if (!graph) return;

    for (const locale of ["th", "en"] as const) {
      const realized = realizeInstructionGraph(graph, locale);
      expect(realized).toBeDefined();
      if (!realized) continue;
      const reparsed = parseInstructionActions(realized);
      expect(reparsed.map((frame) => frame.predicate.lemma)).toEqual(
        graph.actions.map((frame) => frame.predicate.lemma)
      );
      expect(reparsed[reparsed.length - 1]?.polarity).toBe("negate");
    }
  });

});
