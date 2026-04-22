import { describe, expect, it } from "vitest";
import { parseSig } from "../src/index";
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

  it("codes drowsiness-only warnings from structured frames", () => {
    const instructions = parseAdditionalInstructions("may cause drowsiness", { start: 0, end: 20 });
    expect(instructions[0]?.text).toBe("May cause drowsiness");
    expect(instructions[0]?.coding?.code).toBe("418639000");
  });

  it("codes specific meal-state instructions instead of broader fallback concepts", () => {
    const afterFood = parseAdditionalInstructions("after food", { start: 0, end: 10 });
    expect(afterFood[0]?.coding?.code).toBe("225758001");

    const beforeFood = parseAdditionalInstructions("before food", { start: 0, end: 11 });
    expect(beforeFood[0]?.coding?.code).toBe("311500009");
  });

  it("codes exact SNOMED canned advice phrases through normalized-text matching", () => {
    const caution = parseAdditionalInstructions("use with caution", { start: 0, end: 16 });
    expect(caution[0]?.coding?.code).toBe("428579001");

    const printed = parseAdditionalInstructions(
      "follow the printed instructions you have been given with this medicine",
      { start: 0, end: 66 }
    );
    expect(printed[0]?.coding?.code).toBe("418849000");
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

  it("renders coded advice in Thai when localized", () => {
    const drowsy = parseSig("1 tab po daily; may cause drowsiness", { locale: "th" });
    expect(drowsy.longText).toContain("อาจทำให้ง่วงซึม");

    const sparingly = parseSig("apply sparingly", { locale: "th" });
    expect(sparingly.longText).toContain("ใช้เพียงเล็กน้อย");
  });
});
