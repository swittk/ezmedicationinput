import { describe, expect, it } from "vitest";
import { parseSig } from "../src/index";
import {
  buildAdditionalInstructionFramesFromCoding,
  findAdditionalInstructionDefinitionByCoding,
  parseAdditionalInstructions
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

  it("codes common clinic instructions for topical and oral products", () => {
    const sparingly = parseAdditionalInstructions("apply sparingly", { start: 0, end: 15 });
    expect(sparingly[0]?.coding?.code).toBe("420883007");

    const liberally = parseAdditionalInstructions("use liberally", { start: 0, end: 13 });
    expect(liberally[0]?.coding?.code).toBe("419125005");

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
      text: "Swallow whole; do not crush or chew",
      coding: {
        system: SNOMED_SYSTEM,
        code: "418693002"
      },
      i18n: { th: "กลืนทั้งเม็ด; ห้ามเคี้ยวหรือบด" }
    });

    const frames = buildAdditionalInstructionFramesFromCoding(
      SNOMED_SYSTEM,
      "418693002",
      "do not crush or chew",
      { start: 0, end: 20 }
    );
    expect(frames).toEqual([
      expect.objectContaining({
        polarity: AdvicePolarity.Negate,
        predicate: expect.objectContaining({ lemma: "crush" })
      }),
      expect.objectContaining({
        polarity: AdvicePolarity.Negate,
        predicate: expect.objectContaining({ lemma: "chew" })
      })
    ]);
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
    expect(sparingly.longText).toContain("ใช้เพียงเล็กน้อย");
  });
});
