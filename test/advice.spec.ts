import { describe, expect, it } from "vitest";
import { parseSig } from "./helpers/r5-parser";
import { formatSig, fromFhirDosage, parseSig as parsePublicSig } from "../src/index";
import {
  buildAdditionalInstructionFramesFromCoding,
  __test__ as adviceTest,
  findAdditionalInstructionDefinitionByCoding,
  matchComposedAdviceCodings,
  parseAdditionalInstructions,
  realizeAdviceFramesText
} from "../src/advice";
import {
  AdviceArgumentRole,
  AdviceForce,
  AdviceModality,
  AdvicePolarity,
  AdviceRelation
} from "../src/types";

const SNOMED_SYSTEM = "http://snomed.info/sct";

describe("additional instruction rule inventory", () => {
  it("normalizes blank advice coding systems to SNOMED", () => {
    const definition = adviceTest.createDefinitionFromSource({
      system: "   ",
      code: "123",
      display: "Test display",
      text: "Test advice",
      thai: "ทดสอบ"
    });

    expect(definition.coding?.system).toBe(SNOMED_SYSTEM);
  });

  it("codes avoid-sunlight advice from declarative rule data", () => {
    const instructions = parseAdditionalInstructions("avoid sunlight", { start: 0, end: 14 });
    expect(instructions).toEqual([
      {
        text: "Avoid sunlight or sun lamps",
        coding: {
          system: SNOMED_SYSTEM,
          code: "418521000",
          display: "Avoid exposure of skin to direct sunlight or sun lamps (qualifier value)",
          i18n: { th: "หลีกเลี่ยงแสงแดดหรือหลอดไฟแสงยูวี" }
        },
        frames: [
          expect.objectContaining({
            predicate: expect.objectContaining({ lemma: "avoid" }),
            args: expect.arrayContaining([
              expect.objectContaining({ conceptId: "sunlight" })
            ])
          })
        ]
      }
    ]);
  });

  it("codes negated substance advice through generic parser semantics", () => {
    const instructions = parseAdditionalInstructions("no alcohol", { start: 0, end: 10 });
    expect(instructions[0]?.text).toBe("Avoid alcoholic drinks");
    expect(instructions[0]?.coding?.code).toBe("419822006");
    expect(instructions[0]?.frames).toEqual([
      expect.objectContaining({
        polarity: AdvicePolarity.Negate,
        predicate: expect.objectContaining({ lemma: "drink" }),
        args: expect.arrayContaining([
          expect.objectContaining({ conceptId: "alcohol" })
        ])
      })
    ]);
  });

  it("codes drowsiness-only warnings from structured frames", () => {
    const instructions = parseAdditionalInstructions("may cause drowsiness", { start: 0, end: 20 });
    expect(instructions[0]?.text).toBe("May cause drowsiness");
    expect(instructions[0]?.coding?.code).toBe("418639000");

    const modalVariants = [
      "can cause drowsiness",
      "might cause drowsiness",
      "could cause drowsiness"
    ];
    for (const input of modalVariants) {
      const variant = parseAdditionalInstructions(input, { start: 0, end: input.length });
      expect(variant[0]?.coding?.code).toBe("418639000");
    }
  });

  it("codes elliptical modal drowsiness warnings without an explicit cause verb", () => {
    const modalVariants = ["may drowsy", "can drowsy", "might drowsy", "could drowsy"];

    for (const input of modalVariants) {
      const variant = parseAdditionalInstructions(input, { start: 0, end: input.length });
      expect(variant[0]?.text).toBe("May cause drowsiness");
      expect(variant[0]?.coding?.code).toBe("418639000");
    }
  });

  it("codes specific meal-state instructions instead of broader fallback concepts", () => {
    const afterFood = parseAdditionalInstructions("after food", { start: 0, end: 10 });
    expect(afterFood[0]?.coding?.code).toBe("225758001");

    const beforeFood = parseAdditionalInstructions("before food", { start: 0, end: 11 });
    expect(beforeFood[0]?.coding?.code).toBe("311500009");

    const explicitEmptyStomach = parseAdditionalInstructions(
      "on an empty stomach",
      { start: 0, end: 19 },
      { defaultPredicate: "drink" }
    );
    expect(explicitEmptyStomach[0]?.coding?.code).toBe("717154004");

    const implicitEmptyStomach = parseAdditionalInstructions(
      "empty stomach",
      { start: 0, end: 13 },
      { defaultPredicate: "drink" }
    );
    expect(implicitEmptyStomach[0]?.coding?.code).toBe("717154004");
  });

  it("codes exact SNOMED canned advice phrases through normalized-text matching", () => {
    const caution = parseAdditionalInstructions("use with caution", { start: 0, end: 16 });
    expect(caution[0]?.coding?.code).toBe("428579001");

    const printed = parseAdditionalInstructions(
      "follow the printed instructions you have been given with this medicine",
      { start: 0, end: 66 }
    );
    expect(printed[0]?.coding?.code).toBe("418849000");

    const noAlcoholByNegatedAdministration = parseAdditionalInstructions(
      "do not take with alcohol",
      { start: 0, end: 24 }
    );
    expect(noAlcoholByNegatedAdministration[0]?.coding?.code).toBe("419822006");

    const contractedAlcohol = parseAdditionalInstructions(
      "don't take with alcohol",
      { start: 0, end: 23 }
    );
    expect(contractedAlcohol[0]?.coding?.code).toBe("419822006");

    const mustNotAlcohol = parseAdditionalInstructions(
      "must not take with alcohol",
      { start: 0, end: 26 }
    );
    expect(mustNotAlcohol[0]?.coding?.code).toBe("419822006");

    const mustntAlcohol = parseAdditionalInstructions(
      "mustn't take with alcohol",
      { start: 0, end: 24 }
    );
    expect(mustntAlcohol[0]?.coding?.code).toBe("419822006");

    const genericNegatedMedication = parseAdditionalInstructions(
      "don't take with ibuprofen",
      { start: 0, end: 25 }
    );
    expect(genericNegatedMedication[0]?.coding?.code).toBeUndefined();
    expect(genericNegatedMedication[0]?.text).toBe("Do not take with ibuprofen");
    expect(genericNegatedMedication[0]?.frames[0]).toMatchObject({
      polarity: AdvicePolarity.Negate,
      predicate: { lemma: "take" },
      relation: AdviceRelation.With
    });

    const genericMustNotMedication = parseAdditionalInstructions(
      "must not take with warfarin",
      { start: 0, end: 27 }
    );
    expect(genericMustNotMedication[0]?.coding?.code).toBeUndefined();
    expect(genericMustNotMedication[0]?.text).toBe("Must not take with warfarin");
    expect(genericMustNotMedication[0]?.frames[0]).toMatchObject({
      modality: AdviceModality.Must,
      polarity: AdvicePolarity.Negate,
      predicate: { lemma: "take" },
      relation: AdviceRelation.With
    });

    const genericAffirmativeRelation = parseAdditionalInstructions(
      "with grapefruit juice",
      { start: 0, end: 21 },
      { defaultPredicate: "take" }
    );
    expect(genericAffirmativeRelation[0]?.coding?.code).toBeUndefined();
    expect(genericAffirmativeRelation[0]?.text).toBe("Take with grapefruit juice");
    expect(genericAffirmativeRelation[0]?.frames[0]).toMatchObject({
      predicate: { lemma: "take" },
      relation: AdviceRelation.With
    });

    const genericCautionRelation = parseAdditionalInstructions(
      "should take with grapefruit juice",
      { start: 0, end: 33 }
    );
    expect(genericCautionRelation[0]?.coding?.code).toBeUndefined();
    expect(genericCautionRelation[0]?.text).toBe("Should take with grapefruit juice");
    expect(genericCautionRelation[0]?.frames[0]).toMatchObject({
      force: AdviceForce.Caution,
      modality: AdviceModality.Should,
      predicate: { lemma: "take" },
      relation: AdviceRelation.With
    });

    const genericModalWarning = parseAdditionalInstructions(
      "might cause dizziness",
      { start: 0, end: 21 }
    );
    expect(genericModalWarning[0]?.coding?.code).toBeUndefined();
    expect(genericModalWarning[0]?.text).toBe("Might cause dizziness");
    expect(genericModalWarning[0]?.frames[0]).toMatchObject({
      force: AdviceForce.Warning,
      modality: AdviceModality.Might,
      predicate: { lemma: "cause" }
    });
  });

  it("matches compound FHIR additional-instruction text before sentence splitting", () => {
    const compounds = [
      [
        "418577003",
        "Take at regular intervals. Complete the prescribed course unless otherwise directed"
      ],
      [
        "418850000",
        "Contains aspirin and paracetamol. Do not take with any other paracetamol products"
      ],
      [
        "419111009",
        "Allow to dissolve under the tongue. Do not transfer from this container. Keep tightly closed. Discard eight weeks after opening"
      ],
      [
        "419437002",
        "Do not take more than 2 at any one time. Do not take more than 8 in 24 hours"
      ]
    ] as const;
    for (const [code, text] of compounds) {
      const compound = parseAdditionalInstructions(text, { start: 0, end: text.length });
      expect(compound, code).toHaveLength(1);
      expect(compound[0]?.coding?.code, code).toBe(code);
      expect(compound[0]?.text, code).toBe(text);

      const partial = text.split(".")[0];
      const firstSentenceOnly = parseAdditionalInstructions(partial, { start: 0, end: partial.length });
      expect(firstSentenceOnly[0]?.coding?.code, `partial ${code}`).not.toBe(code);
    }
  });

  it("realizes leave-on duration without relation-word leakage", () => {
    const parsed = parseSig("leave on for 20 minutes");
    expect(parsed.longText).toContain("Leave on for 20 minutes.");
    expect(parsed.meta.canonical.clauses[0]?.instructionGraph?.actions[0]).toMatchObject({
      predicate: { lemma: "leave" },
      relation: AdviceRelation.For,
      args: [expect.objectContaining({
        role: AdviceArgumentRole.Duration,
        quantity: { value: 20, unit: "min" }
      })]
    });
  });

  it("codes common clinic instructions for topical and oral products", () => {
    const sparingly = parseAdditionalInstructions("apply sparingly", { start: 0, end: 15 });
    expect(sparingly[0]?.coding?.code).toBe("420883007");

    const liberally = parseAdditionalInstructions("use liberally", { start: 0, end: 13 });
    expect(liberally[0]?.coding?.code).toBe("419125005");

    const liberalAmount = parseAdditionalInstructions("apply a liberal amount", { start: 0, end: 22 });
    expect(liberalAmount[0]?.coding?.code).toBe("419125005");

    const thinly = parseAdditionalInstructions("apply thin layer", { start: 0, end: 16 });
    expect(thinly[0]?.coding).toMatchObject({
      system: SNOMED_SYSTEM,
      code: "420162004"
    });

    const gently = parseAdditionalInstructions("apply gently", { start: 0, end: 13 });
    expect(gently[0]?.coding).toMatchObject({
      system: SNOMED_SYSTEM,
      code: "418449005"
    });

    const thickly = parseAdditionalInstructions("apply thick layer", { start: 0, end: 17 });
    expect(thickly[0]?.coding).toMatchObject({
      system: SNOMED_SYSTEM,
      code: "246703001"
    });

    const dissolve = parseAdditionalInstructions("dissolve under the tongue", { start: 0, end: 25 });
    expect(dissolve[0]?.coding?.code).toBe("419529008");

    const swish = parseAdditionalInstructions("swish and swallow", { start: 0, end: 17 });
    expect(swish[0]?.coding?.code).toBe("421298005");

    const slowly = parseAdditionalInstructions("drink slowly", { start: 0, end: 12 });
    expect(slowly[0]?.coding?.code).toBe("419443000");
  });

  it("rebuilds template frames from coded advice definitions", () => {
    const definition = findAdditionalInstructionDefinitionByCoding(SNOMED_SYSTEM, "418693002");
    expect(definition).toMatchObject({
      text: "Swallow whole; do not chew",
      coding: {
        system: SNOMED_SYSTEM,
        code: "418693002"
      },
      i18n: { th: "กลืนทั้งเม็ด; ห้ามเคี้ยว" }
    });

    const frames = buildAdditionalInstructionFramesFromCoding(
      SNOMED_SYSTEM,
      "418693002",
      "do not crush or chew",
      { start: 0, end: 20 }
    );
    expect(frames).toEqual([
      expect.objectContaining({
        polarity: AdvicePolarity.Affirm,
        predicate: expect.objectContaining({ lemma: "swallow", semanticClass: "ingest" }),
        args: expect.arrayContaining([
          expect.objectContaining({ role: AdviceArgumentRole.Manner, conceptId: "whole" })
        ])
      }),
      expect.objectContaining({
        polarity: AdvicePolarity.Negate,
        predicate: expect.objectContaining({ lemma: "chew" })
      })
    ]);
  });

  it("keeps imported whole-swallow code facts separate from its authored advice text", () => {
    const reconstructed = fromFhirDosage({
      text: "Swallow whole; do not crush or chew",
      additionalInstruction: [{
        text: "Swallow whole; do not crush or chew",
        coding: [{ system: SNOMED_SYSTEM, code: "418693002" }]
      }]
    });
    expect(reconstructed.meta.canonical.clauses[0]?.additionalInstructions?.[0]?.text)
      .toBe("Swallow whole; do not crush or chew");
    const frames = reconstructed.meta.canonical.clauses[0]?.additionalInstructions?.[0]?.frames ?? [];
    expect(frames.map(frame => [frame.predicate.lemma, frame.polarity])).toEqual([
      ["swallow", AdvicePolarity.Affirm],
      ["chew", AdvicePolarity.Negate]
    ]);
    expect(frames[0]?.args).toContainEqual(
      expect.objectContaining({ role: AdviceArgumentRole.Manner, conceptId: "whole" })
    );
  });

  it("does not over-code swallow-whole advice from a single prohibition", () => {
    const instructions = parseAdditionalInstructions("do not crush", { start: 0, end: 12 });
    expect(instructions[0]?.coding?.code).not.toBe("418693002");
    expect(instructions[0]?.frames).toEqual([
      expect.objectContaining({
        polarity: AdvicePolarity.Negate,
        predicate: expect.objectContaining({ lemma: "crush" })
      })
    ]);
  });

  it("keeps decimal durations intact when splitting instruction sentences", () => {
    const instructions = parseAdditionalInstructions(
      "leave on for 0.5 hours. rinse",
      { start: 0, end: 29 }
    );
    expect(instructions).toHaveLength(2);
    expect(instructions[0]?.frames?.[0]?.args).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: AdviceArgumentRole.Duration,
          text: "0.5 hours"
        })
      ])
    );
  });

  it("renders coded advice in Thai when localized", () => {
    const drowsy = parseSig("1 tab po daily; may cause drowsiness", { locale: "th" });
    expect(drowsy.longText).toContain("อาจทำให้ง่วงซึม");

    const sparingly = parseSig("apply sparingly", { locale: "th" });
    expect(sparingly.longText).toContain("ทาเพียงเล็กน้อย");

    const thinly = parseSig("apply thinly", { locale: "th" });
    expect(thinly.longText).toContain("ทาบางๆ");

    const gently = parseSig("apply gently", { locale: "th" });
    expect(gently.longText).toContain("ทาเบาๆ");

    const thickly = parseSig("apply thickly", { locale: "th" });
    expect(thickly.longText).toContain("ทาหนาๆ");
  })

  it("parses terminology-declared Thai administration style suffixes as integrated modifiers", () => {
    const cases = [
      ["ทาบางๆ บริเวณรอยโรค วันละ 2 ครั้ง", "ทาบางๆ บริเวณรอยโรค วันละ 2 ครั้ง."],
      ["ทาเบาๆ บริเวณรอยโรค วันละ 2 ครั้ง", "ทาเบาๆ บริเวณรอยโรค วันละ 2 ครั้ง."],
      ["ทาหนาๆ บริเวณรอยโรค วันละ 2 ครั้ง", "ทาหนาๆ บริเวณรอยโรค วันละ 2 ครั้ง."],
      ["ทาเพียงเล็กน้อยบริเวณรอยโรค วันละ 2 ครั้ง", "ทาเพียงเล็กน้อย บริเวณรอยโรค วันละ 2 ครั้ง."],
      ["ทาอย่างทั่วถึงบริเวณรอยโรค วันละ 2 ครั้ง", "ทาอย่างทั่วถึง บริเวณรอยโรค วันละ 2 ครั้ง."]
    ] as const;
    for (const [source, expected] of cases) {
      const parsed = parseSig(source, { locale: "th" });
      expect(parsed.longText).toBe(expected);
      expect(parsed.meta.leftoverText).toBeUndefined();
    }
  });;

  it("localizes advice relations in both positive and negated Thai realization", () => {
    const base = {
      force: AdviceForce.Warning,
      predicate: { lemma: "ใช้" },
      relation: AdviceRelation.Before,
      args: [{ role: AdviceArgumentRole.Object, text: "food", i18n: { th: "อาหาร" } }],
      span: { start: 0, end: 1 },
      sourceText: "x",
      sequenceIndex: 0
    };

    expect(realizeAdviceFramesText([base], "th")).toBe("ใช้ ก่อน อาหาร");
    expect(realizeAdviceFramesText([base], "en")).toBe("ใช้ before food");
    expect(realizeAdviceFramesText([{ ...base, polarity: AdvicePolarity.Negate }], "th"))
      .toBe("ห้ามใช้ ก่อน อาหาร");
    expect(realizeAdviceFramesText([{ ...base, polarity: AdvicePolarity.Negate }], "en"))
      .toBe("Do not ใช้ before food");
  });

  it("uses locale-specific conjunctions when realizing multiple advice arguments", () => {
    const frame = {
      force: AdviceForce.Warning,
      predicate: { lemma: "avoid" },
      args: [
        { role: AdviceArgumentRole.Object, text: "eyes", i18n: { th: "ตา" } },
        { role: AdviceArgumentRole.Object, text: "mouth", i18n: { th: "ปาก" } }
      ],
      span: { start: 0, end: 1 },
      sourceText: "x",
      sequenceIndex: 0
    };
    expect(realizeAdviceFramesText([frame], "en")).toBe("Avoid eyes and mouth");
    expect(realizeAdviceFramesText([frame], "th")).toBe("หลีกเลี่ยงตา และ ปาก");

    frame.args.push({ role: AdviceArgumentRole.Object, text: "skin", i18n: { th: "ผิวหนัง" } });
    expect(realizeAdviceFramesText([frame], "en")).toBe("Avoid eyes, mouth and skin");
    expect(realizeAdviceFramesText([frame], "th")).toBe("หลีกเลี่ยงตา, ปาก และ ผิวหนัง");
  });

});


describe("alcohol advice action and polarity proof", () => {
  it.each([
    { source: "Avoid alcohol", lemma: "avoid", negative: false, avoidance: true },
    { source: "No alcohol", lemma: "drink", negative: true, avoidance: true },
    { source: "Do not drink alcohol", lemma: "drink", negative: true, avoidance: true },
    { source: "Do not take with alcohol", lemma: "take", negative: true, avoidance: true },
    { source: "Drink alcohol", lemma: "drink", negative: false, avoidance: false },
    { source: "Take with alcohol", lemma: "take", negative: false, avoidance: false }
  ])("requires actual avoidance meaning for $source", ({ source, lemma, negative, avoidance }) => {
    const rows = parseAdditionalInstructions(source, { start: 0, end: source.length });
    const frames = rows.flatMap(row => row.frames);
    expect(frames).toHaveLength(1);
    expect(frames[0].predicate.lemma).toBe(lemma);
    expect(frames[0].polarity ?? AdvicePolarity.Affirm)
      .toBe(negative ? AdvicePolarity.Negate : AdvicePolarity.Affirm);
    expect(frames[0].args).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: AdviceArgumentRole.Substance, conceptId: "alcohol" })
    ]));
    expect(rows.some(row => row.coding?.code === "419822006")).toBe(avoidance);
    expect(matchComposedAdviceCodings(frames).some(definition => definition.coding?.code === "419822006"))
      .toBe(avoidance);
  });

  it.each([
    { ending: "avoid alcohol", lemma: "avoid", compound: true },
    { ending: "take with alcohol", lemma: "take", compound: false },
    { ending: "mix with alcohol", lemma: "mix", compound: false }
  ])("requires an Avoid owner in the drowsiness compound: $ending", ({ ending, lemma, compound }) => {
    const source = `May cause drowsiness; do not drive if affected; ${ending}`;
    const frames = parseAdditionalInstructions(source, { start: 0, end: source.length }).flatMap(row => row.frames);
    expect(frames.map(frame => frame.predicate.lemma)).toEqual(["cause", "drive", lemma]);
    expect(frames[0]).toMatchObject({ modality: AdviceModality.May, args: [
      expect.objectContaining({ conceptId: "drowsiness" })
    ] });
    expect(frames[1]).toMatchObject({ polarity: AdvicePolarity.Negate, relation: AdviceRelation.If,
      args: [expect.objectContaining({ text: "affected" })] });
    expect(frames[2].args).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: AdviceArgumentRole.Substance, conceptId: "alcohol" })
    ]));
    const before = JSON.stringify(frames);
    const codes = matchComposedAdviceCodings(frames).map(definition => definition.coding?.code);
    expect(codes).not.toContain("418954008");
    expect(codes).not.toContain("418914006");
    expect(codes.includes("419822006")).toBe(compound);
    expect(JSON.stringify(frames)).toBe(before);
  });

  it.each(["419822006", "418914006"])("retains the complete meaning of the explicit %s template", code => {
    const frames = buildAdditionalInstructionFramesFromCoding(SNOMED_SYSTEM, code)!;
    expect(frames.map(frame => frame.predicate.lemma))
      .toEqual(code === "419822006" ? ["avoid"] : ["cause", "drive", "avoid"]);
    const avoidance = frames[frames.length - 1];
    expect(avoidance.polarity ?? AdvicePolarity.Affirm).toBe(AdvicePolarity.Affirm);
    expect(avoidance.args).toEqual([expect.objectContaining({
      role: AdviceArgumentRole.Substance, text: "alcohol", conceptId: "alcohol"
    })]);
    if (code === "418914006") {
      expect(frames[0]).toMatchObject({ modality: AdviceModality.May,
        args: [expect.objectContaining({ conceptId: "drowsiness" })] });
      expect(frames[1]).toMatchObject({ polarity: AdvicePolarity.Negate, relation: AdviceRelation.If,
        args: expect.arrayContaining([
          expect.objectContaining({ role: AdviceArgumentRole.Object, text: "or operate machinery" }),
          expect.objectContaining({ role: AdviceArgumentRole.Free, text: "affected" })
        ]) });
    }
    expect(matchComposedAdviceCodings(frames).map(definition => definition.coding?.code)).toContain(code);
  });
});


describe("independent sentence advice ownership", () => {
  it.each([".", ";", "!", "?"])("keeps unknown advice independent after %s", punctuation => {
    const source = `Take 1 tablet daily. Do not drive${punctuation} Arrange a ride home.`;
    const adviceSource = `Do not drive${punctuation} Arrange a ride home.`;
    const advice = parseAdditionalInstructions(adviceSource, { start: 0, end: adviceSource.length },
      { allowFreeTextFallback: true });
    expect(advice).toHaveLength(2);
    expect(advice[0].frames).toEqual([expect.objectContaining({
      polarity: AdvicePolarity.Negate, predicate: expect.objectContaining({ lemma: "drive" }), args: []
    })]);
    expect(advice[1]).toEqual({ text: "Arrange a ride home", frames: [] });
    const parsed = parsePublicSig(source);
    const before = JSON.stringify(parsed);
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    expect(parsed.meta.canonical.clauses[0].dose).toEqual({ value: 1, unit: "tab" });
    expect(parsed.meta.canonical.clauses[0].instructionGraph?.actions).toEqual([expect.objectContaining({
      polarity: AdvicePolarity.Negate, predicate: expect.objectContaining({ lemma: "drive" }), args: []
    })]);
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const text = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(text.match(/Do not drive/gu)).toHaveLength(1);
      expect(text.match(/Arrange a ride home/gu)).toHaveLength(1);
      expect(text).not.toContain("drive arrange");
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });
});


describe("complete drowsiness composite meaning", () => {
  it.each(["418954008", "418914006", "418071006"])("requires machinery as well as driving for %s", code => {
    const frames = buildAdditionalInstructionFramesFromCoding(SNOMED_SYSTEM, code)!;
    const saved = JSON.stringify(frames);
    const codes = matchComposedAdviceCodings(frames).map(definition => definition.coding?.code);
    expect(codes).toContain(code);
    const driveOnly = frames.map(frame => frame.predicate.lemma === "drive" ? { ...frame,
      args: frame.args.filter(argument => argument.text !== "or operate machinery") } : frame);
    expect(driveOnly.find(frame => frame.predicate.lemma === "drive")).toMatchObject({
      polarity: AdvicePolarity.Negate, relation: AdviceRelation.If,
      args: [expect.objectContaining({ text: "affected" })]
    });
    const reducedCodes = matchComposedAdviceCodings(driveOnly).map(definition => definition.coding?.code);
    for (const composite of ["418954008", "418914006", "418071006"]) expect(reducedCodes).not.toContain(composite);
    expect(JSON.stringify(frames)).toBe(saved);
  });

  it.each([
    ["Avoid alcohol", true], ["Do not drink alcohol", true], ["Do not take with alcohol", true],
    ["Drink alcohol", false], ["Take with alcohol", false], ["Mix with alcohol", false]
  ] as const)("requires owned alcohol avoidance in the next-day warning: %s", (source, expected) => {
    const template = buildAdditionalInstructionFramesFromCoding(SNOMED_SYSTEM, "418071006")!;
    const authored = parseAdditionalInstructions(source, { start: 0, end: source.length }).flatMap(row => row.frames);
    const frames = [...template.filter(frame => frame.predicate.lemma !== "avoid"), ...authored];
    const saved = JSON.stringify(frames);
    expect(matchComposedAdviceCodings(frames).some(definition => definition.coding?.code === "418071006"))
      .toBe(expected);
    expect(JSON.stringify(frames)).toBe(saved);
  });

  it("keeps a next-day administration separate from the drowsiness effect", () => {
    const frames = buildAdditionalInstructionFramesFromCoding(SNOMED_SYSTEM, "418071006")!;
    const cause = frames.find(frame => frame.predicate.lemma === "cause")!;
    const nextDay = cause.args.filter(argument => argument.conceptId === "next_day");
    expect(nextDay).toHaveLength(1);
    const separate = frames.map(frame => frame === cause ? { ...frame,
      args: frame.args.filter(argument => argument.conceptId !== "next_day") } : frame);
    separate.push({ force: AdviceForce.Instruction, predicate: { lemma: "take", semanticClass: "administration" },
      args: nextDay, span: { start: 0, end: 13 }, sourceText: "Take next day" });
    const saved = JSON.stringify(separate);
    expect(matchComposedAdviceCodings(frames).map(definition => definition.coding?.code)).toContain("418071006");
    expect(matchComposedAdviceCodings(separate).map(definition => definition.coding?.code)).not.toContain("418071006");
    expect(JSON.stringify(separate)).toBe(saved);
  });
});


describe("next-day cause certainty ownership", () => {
  it.each([
    [undefined, undefined, true], [undefined, AdvicePolarity.Affirm, true],
    [AdviceModality.May, AdvicePolarity.Affirm, false],
    [undefined, AdvicePolarity.Negate, false], [AdviceModality.May, AdvicePolarity.Negate, false]
  ] as const)("matches only affirmative unmodal causes (%s, %s)", (modality, polarity, expected) => {
    const template = buildAdditionalInstructionFramesFromCoding(SNOMED_SYSTEM, "418071006")!;
    const frames = template.map(frame => frame.predicate.lemma === "cause" ? { ...frame, modality, polarity } : frame);
    const before = JSON.stringify(frames);
    expect(matchComposedAdviceCodings(frames).some(definition => definition.coding?.code === "418071006")).toBe(expected);
    expect(JSON.stringify(frames)).toBe(before);
  });

  it("keeps certainty scoped to the matched cause when another modal cause is present", () => {
    const frames = buildAdditionalInstructionFramesFromCoding(SNOMED_SYSTEM, "418071006")!;
    const cause = frames.find(frame => frame.predicate.lemma === "cause")!;
    const current = [{ ...cause, modality: AdviceModality.May }, ...frames];
    const before = JSON.stringify(current);
    expect(matchComposedAdviceCodings(current).some(definition => definition.coding?.code === "418071006")).toBe(true);
    expect(JSON.stringify(current)).toBe(before);
  });
});
