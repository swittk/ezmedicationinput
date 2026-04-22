import { describe, expect, it } from "vitest";
import {
  buildAdditionalInstructionFramesFromCoding,
  findAdditionalInstructionDefinitionByCoding,
  parseAdditionalInstructions
} from "../src/advice";
import { AdvicePolarity } from "../src/types";

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
});
