import { describe, expect, it } from "vitest";
import { formatSig, fromFhirDosage, lintSig, parseInstructionActions, realizeInstructionGraph } from "../src/index";
import { parseSig } from "./helpers/r5-parser";
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

  it("exposes compact clause periods without splitting decimals or dotted abbreviations", () => {
    const input = "OD 0.5 drop BID.OS 1 drop QID";
    const tokens = scanSurfaceTokens(input);
    expect(tokens.map((token) => token.original)).toEqual([
      "OD", "0.5", "drop", "BID", ".", "OS", "1", "drop", "QID"
    ]);
    for (const token of tokens) {
      expect(input.slice(token.start, token.end)).toBe(token.original);
    }

    expect(scanSurfaceTokens("1 gtt O.D. b.i.d. I.U. 0.5 mL")
      .map((token) => token.original)).toEqual([
      "1", "gtt", "O.D.", "b.i.d.", "I.U.", "0.5", "mL"
    ]);

    const dottedCadence = "OD 1 drop b.i.d.OS 1 drop QID";
    expect(scanSurfaceTokens(dottedCadence).map((token) => token.original)).toEqual([
      "OD", "1", "drop", "b.i.d", ".", "OS", "1", "drop", "QID"
    ]);
    const parsed = parseSig(dottedCadence);
    expect(parsed.items.map((item) => item.fhir.doseAndRate?.[0]?.doseQuantity?.value))
      .toEqual([1, 1]);
    expect(parsed.items.map((item) => item.fhir.site?.text)).toEqual(["right eye", "left eye"]);
    expect(parsed.items.map((item) => item.fhir.timing?.repeat?.frequency)).toEqual([2, 4]);
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

  it.each([
    ["รับประทาน 1 เม็ด ต่อวันละ 2 ครั้ง", "ต่อวันละ", "daily", "d", "วันละ 2 ครั้ง"],
    ["รับประทาน 1 เม็ด ต่อสัปดาห์ละ 2 ครั้ง", "ต่อสัปดาห์ละ", "weekly", "wk", "สัปดาห์ละ 2 ครั้ง"],
    ["รับประทาน 1 เม็ด ต่อเดือนละ 2 ครั้ง", "ต่อเดือนละ", "monthly", "mo", "เดือนละ 2 ครั้ง"],
    ["รับประทาน 1 เม็ด ต่อ วัน ละ 2 ครั้ง", "ต่อวันละ", "daily", "d", "วันละ 2 ครั้ง"]
  ])("preserves the entire distributive cadence in %s", (source, phrase, cadence, periodUnit, realization) => {
    const tokens = lexInput(source);
    const cadenceToken = tokens.find(token => token.canonical === cadence);
    expect(cadenceToken?.sourceText.replace(/\s+/gu, "")).toBe(phrase);
    expect(tokens.some(token => token.lower === "ละ")).toBe(false);
    const parsed = parseSig(source, { locale: "th" });
    expect(parsed.items[0]?.fhir.timing?.repeat).toMatchObject({
      frequency: 2, period: 1, periodUnit
    });
    expect(parsed.longText).toContain(realization);
    expect(parsed.meta.leftoverText).toBeUndefined();
  });

  it("renders monthly and yearly multiple doses without losing the frequency", () => {
    const monthly = parseSig("1 tab PO twice monthly").items[0].fhir;
    expect(monthly.timing?.repeat).toMatchObject({ frequency: 2, period: 1, periodUnit: "mo" });
    expect(formatSig(monthly, "long", { locale: "en" })).toContain("twice monthly");
    expect(formatSig(monthly, "long", { locale: "th" })).toContain("เดือนละ 2 ครั้ง");
    const yearly = {
      ...monthly,
      timing: { repeat: { frequency: 2, period: 1, periodUnit: "a" as const } }
    };
    expect(formatSig(yearly, "long", { locale: "en" })).toContain("twice yearly");
    expect(formatSig(yearly, "long", { locale: "th" })).toContain("ปีละ 2 ครั้ง");
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

    const postposed = parseSig("หยอดตาทั้งสองข้าง 1 หยด สองครั้งต่อวัน", { locale: "th" });
    expect(postposed.fhir.timing?.repeat).toMatchObject({
      frequency: 2,
      period: 1,
      periodUnit: "d"
    });
    expect(postposed.fhir.timing?.repeat?.count).toBeUndefined();
    expect(postposed.meta.leftoverText).toBeUndefined();
  });

  it("keeps Thai lexical quantities on their exact original source spans", () => {
    const input = "รับประทานครึ่งเม็ด วันละสองครั้ง และ ๒ เม็ด";
    const tokens = lexInput(input);

    for (const [source, canonical] of [
      ["ครึ่ง", "half"],
      ["สอง", "two"]
    ] as const) {
      const token = tokens.find((candidate) => candidate.sourceText === source);
      expect(token).toMatchObject({ original: source, canonical, kind: "WORD" });
      expect(input.slice(token?.sourceStart, token?.sourceEnd)).toBe(source);
    }

    const thaiDigit = tokens.find((candidate) => candidate.sourceText === "๒");
    expect(thaiDigit).toMatchObject({ original: "๒", kind: "NUMBER", value: 2 });
    expect(input.slice(thaiDigit?.sourceStart, thaiDigit?.sourceEnd)).toBe("๒");

    const productName = lexInput("วิตามินบี12");
    expect(productName.some((token) => token.kind === "NUMBER")).toBe(false);
    expect(productName.map((token) => token.sourceText).join("")).toBe("วิตามินบี12");

    const durationInput = "อีก๓วัน";
    const durationTokens = lexInput(durationInput);
    expect(durationTokens.map((token) => ({
      source: token.sourceText,
      canonical: token.canonical,
      kind: token.kind,
      value: token.value
    }))).toEqual([
      { source: "อีก", canonical: "additional", kind: "WORD", value: undefined },
      { source: "๓", canonical: undefined, kind: "NUMBER", value: 3 },
      { source: "วัน", canonical: "day", kind: "WORD", value: undefined }
    ]);
    for (const token of durationTokens) {
      expect(durationInput.slice(token.sourceStart, token.sourceEnd)).toBe(token.sourceText);
    }

    const decimalInput = "๐.๕ เม็ด";
    const thaiDecimal = lexInput(decimalInput).find((token) => token.value === 0.5);
    expect(thaiDecimal).toMatchObject({
      original: "๐.๕",
      sourceText: "๐.๕",
      kind: "NUMBER",
      value: 0.5
    });
    expect(decimalInput.slice(thaiDecimal?.sourceStart, thaiDecimal?.sourceEnd)).toBe("๐.๕");
  });

  it.each([
    "รับประทาน ๐.๕เม็ด วันละ 2 ครั้ง",
    "รับประทาน ๐.๕ เม็ด วันละ 2 ครั้ง",
    "รับประทาน 0.5เม็ด วันละ 2 ครั้ง"
  ])("treats a compact Thai decimal as 0.5 tablets, never 0 plus 5: %s", source => {
    const decimalText = source.includes("๐") ? "๐.๕" : "0.5";
    const tokens = lexInput(source);
    const quantity = tokens.filter(token => token.kind === "NUMBER")
      .find(token => token.value === 0.5);
    expect(quantity).toMatchObject({
      kind: "NUMBER", value: 0.5,
      original: decimalText, sourceText: decimalText
    });
    expect(source.slice(quantity?.sourceStart, quantity?.sourceEnd)).toBe(decimalText);
    expect(tokens.filter(token => token.kind === "NUMBER").map(token => token.value))
      .toEqual([0.5, 2]);
    const parsed = parseSig(source, { locale: "th" });
    expect(parsed.count).toBe(1);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 0.5, unit: "tab" });
    expect(parsed.fhir.timing?.repeat).toMatchObject({ frequency: 2, period: 1, periodUnit: "d" });
    expect(parsed.meta.leftoverText).toBeUndefined();
    // The editable source remains exact even when the FHIR display normalizes
    // Thai numerals to ASCII decimal notation.
    expect(parsed.input).toBe(source);
    expect(parsed.fhir.text).toContain("0.5");
  });

  it("keeps different Thai morning and evening quantities independent", () => {
    const input = "รับประทาน ครึ่งเม็ดตอนเช้า และ 1 เม็ดตอนเย็น";
    const parsed = parseSig(input, { locale: "th" });

    expect(parsed.count).toBe(2);
    expect(parsed.items.map((item) => item.fhir.doseAndRate?.[0]?.doseQuantity)).toMatchObject([
      { value: 0.5, unit: "tab" },
      { value: 1, unit: "tab" }
    ]);
    expect(parsed.items.map((item) => item.fhir.timing?.repeat?.when)).toEqual([
      ["MORN"],
      ["EVE"]
    ]);
    expect(parsed.items.map((item) => item.meta.canonical.clauses[0]?.rawText)).toEqual([
      "รับประทาน ครึ่งเม็ดตอนเช้า",
      "1 เม็ดตอนเย็น"
    ]);
    expect(parsed.items.map((item) => item.meta.leftoverText)).toEqual([undefined, undefined]);
  });

  it.each([
    ["หนึ่ง", 1],
    ["สอง", 2],
    ["สาม", 3],
    ["สี่", 4],
    ["๒", 2],
    ["2", 2],
    ["3", 3]
  ] as const)("parses compact Thai daily cardinal %s as frequency %i", (cardinal, frequency) => {
    const input = `หยอดตาทั้งสองข้างครั้งละ 1 หยด วันละ${cardinal}ครั้ง`;
    const parsed = parseSig(input, { locale: "th" });

    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "drop" });
    expect(parsed.fhir.timing?.repeat).toMatchObject({
      frequency,
      period: 1,
      periodUnit: "d"
    });
    expect(parsed.meta.leftoverText).toBeUndefined();
  });

  it("uses the same dose quantity for Thai half, decimal, and slash fraction", () => {
    const variants = ["ครึ่งเม็ด", "0.5 เม็ด", "1/2 เม็ด", "๐.๕ เม็ด"];
    const parsed = variants.map((dose) => parseSig(`รับประทาน ${dose}`, { locale: "th" }));

    expect(parsed.map((result) => result.fhir.doseAndRate?.[0]?.doseQuantity)).toMatchObject([
      { value: 0.5, unit: "tab" },
      { value: 0.5, unit: "tab" },
      { value: 0.5, unit: "tab" },
      { value: 0.5, unit: "tab" }
    ]);
    expect(parsed.map((result) => result.meta.leftoverText)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined
    ]);

    for (const [cardinal, value] of [
      ["หนึ่ง", 1], ["สอง", 2], ["สาม", 3], ["สี่", 4], ["๒", 2]
    ] as const) {
      expect(parseSig(`รับประทาน${cardinal}เม็ด`, { locale: "th" })
        .fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value, unit: "tab" });
    }
  });

  it("parses natural Thai distributive doses and symptom conditions compositionally", () => {
    const oral = parseSig("กินวันละเม็ดเวลาที่ง่วง", { locale: "th" });
    expect(oral.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(oral.fhir.timing?.repeat).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
    expect(oral.fhir.asNeededFor?.[0]?.coding?.[0]).toMatchObject({
      system: "http://snomed.info/sct",
      code: "79519003",
      display: "Drowsiness"
    });
    expect(oral.meta.leftoverText).toBeUndefined();

    const topical = parseSig("ทาผิวเวลาที่คัน", { locale: "th" });
    expect(topical.fhir.site?.coding?.[0]).toMatchObject({
      system: "http://snomed.info/sct",
      code: "181469002",
      display: "Entire skin"
    });
    expect(topical.fhir.asNeededFor?.[0]?.coding?.[0]?.code)
      .toBe("418363000:363698007=181469002");
    expect(topical.meta.leftoverText).toBeUndefined();
  });

  it("parses quantified meal offsets without confusing them with treatment duration", () => {
    const minimum = parseSig("กินก่อนอาหารอย่างน้อยครึ่งชั่วโมง", { locale: "th" });
    expect(minimum.meta.canonical.clauses[0]?.schedule).toMatchObject({
      when: ["AC"],
      offsetMin: 30
    });
    expect(minimum.meta.canonical.clauses[0]?.schedule?.duration).toBeUndefined();
    expect(minimum.fhir.timing?.repeat?.offset).toBeUndefined();
    expect(minimum.fhir.timing?.repeat?.extension).toContainEqual({
      url: "urn:ezmedicationinput:StructureDefinition:medication-timing-offset-min",
      valueInteger: 30
    });
    expect(minimum.longText).toBe("รับประทานก่อนอาหารอย่างน้อย 30 นาที.");
    expect(minimum.meta.leftoverText).toBeUndefined();
    expect(formatSig(minimum.fhir, "long", { locale: "th" }))
      .toBe("รับประทานก่อนอาหารอย่างน้อย 30 นาที.");
    expect(formatSig(minimum.fhir, "long", { locale: "en" }))
      .toBe("Take the medication orally at least 30 minutes before meals.");
    expect(fromFhirDosage(minimum.fhir, { locale: "th" }).longText)
      .toBe("รับประทานก่อนอาหารอย่างน้อย 30 นาที.");

    const exact = parseSig("กินก่อนอาหารครึ่งชั่วโมง", { locale: "th" });
    expect(exact.meta.canonical.clauses[0]?.schedule).toMatchObject({
      when: ["AC"],
      offset: 30
    });
    expect(exact.fhir.timing?.repeat).toMatchObject({ when: ["AC"], offset: 30 });
    expect(exact.meta.canonical.clauses[0]?.schedule?.duration).toBeUndefined();
  });

  it("uses the distributive-dose construction across discrete units", () => {
    const drops = parseSig("หยอดวันละหยด", { locale: "th" });
    expect(drops.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "drop" });
    expect(drops.fhir.timing?.repeat).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
    expect(drops.meta.leftoverText).toBeUndefined();

    const capsules = parseSig("กินวันละแคปซูลเวลาที่เวียนหัว", { locale: "th" });
    expect(capsules.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "cap" });
    expect(capsules.fhir.asNeededFor?.[0]?.coding?.[0]?.code).toBe("404640003");
    expect(capsules.meta.leftoverText).toBeUndefined();
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
      "จากนั้นล้างด้วยน้ำสะอาด. ห้ามสวนล้างช่องคลอด"
    );
    expect(realizeInstructionGraph(graph, "en")).toBe(
      "Shake bottle before use; then pour product 1-2 mL into the palm; " +
      "then mix with a small amount of water; then rub to form foam; " +
      "then clean external intimate area; then rinse with clean water. " +
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
      "pour product 1-2 mL into the palm"
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
