import { describe, expect, it } from "vitest";
import { AdviceArgumentRole, AdvicePolarity, AdviceRelation, EventTiming, formatSig } from "../src/index";
import { canonicalToFhir } from "../src/fhir";
import { parseSig } from "./helpers/r5-parser";

function clause(input: string) {
  const parsed = parseSig(input);
  return { parsed, clause: parsed.meta.canonical.clauses[0] };
}

describe("compositional workflow and regimen scope", () => {
  it("lets an explicit daily frequency refine a period-only daily cadence default", () => {
    const { parsed, clause: value } = clause("apply to between fingers every day, twice daily");
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(value?.schedule).toMatchObject({
      timingCode: "BID",
      frequency: 2,
      period: 1,
      periodUnit: "d"
    });
    expect(value?.site?.spatialRelation?.relationText).toBe("between");
    expect(parsed.longText).toBe("Apply the medication twice daily between the fingers.");
  });

  it("keeps bedtime application, overnight retention, and morning wash in semantic order", () => {
    const input = "apply to web spaces before sleep, leave overnight, then wash thoroughly in the morning";
    const { parsed, clause: value } = clause(input);
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(value?.site).toMatchObject({ text: "interdigital spaces" });
    expect(value?.schedule?.when).toEqual([EventTiming["Before Sleep"]]);

    const actions = value?.instructionGraph?.actions ?? [];
    expect(actions.map((action) => action.predicate.lemma)).toEqual(["leave", "wash"]);
    expect(actions[0]?.args).toContainEqual(expect.objectContaining({
      role: AdviceArgumentRole.Duration,
      conceptId: "overnight"
    }));
    expect(actions[1]?.relation).toBe(AdviceRelation.In);
    expect(actions[1]?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: AdviceArgumentRole.Manner, conceptId: "thoroughly" }),
      expect.objectContaining({ role: AdviceArgumentRole.Time, conceptId: "morning" })
    ]));
    expect(value?.instructionGraph?.relations?.[0]).toMatchObject({
      kind: AdviceRelation.Then,
      fromActionIndex: 0,
      toActionIndex: 1
    });
    expect(parsed.longText).toBe(
      "Apply the medication at bedtime to the interdigital spaces; then leave on overnight; then wash thoroughly in the morning."
    );
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).toBe(
      "ทาบริเวณระหว่างร่องนิ้ว ก่อนนอน จากนั้นทิ้งไว้ข้ามคืน จากนั้นล้างให้ทั่วตอนเช้า."
    );
  });

  it("does not invent a morning wash when the optional phrase is absent", () => {
    const input = "apply to web spaces before sleep, leave overnight, then wash thoroughly";
    const { parsed, clause: value } = clause(input);
    const wash = value?.instructionGraph?.actions.find((action) => action.predicate.lemma === "wash");
    expect(wash?.args).toContainEqual(expect.objectContaining({
      role: AdviceArgumentRole.Manner,
      conceptId: "thoroughly"
    }));
    expect(wash?.args.some((arg) => arg.role === AdviceArgumentRole.Time)).toBe(false);
    expect(parsed.longText).toBe(
      "Apply the medication at bedtime to the interdigital spaces; then leave on overnight; then wash thoroughly."
    );
  });

  it("keeps action coordination out of the site and scopes comma-delimited bedtime to the regimen", () => {
    const input = "apply to scalp and shampoo thoroughly once daily, leave on for 15 minutes, then wash off, before sleep";
    const { parsed, clause: value } = clause(input);
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(value?.site).toMatchObject({
      text: "scalp",
      coding: { code: "41695006" }
    });
    expect(value?.schedule).toMatchObject({
      timingCode: "QD",
      frequency: 1,
      period: 1,
      periodUnit: "d",
      when: [EventTiming["Before Sleep"]]
    });

    const actions = value?.instructionGraph?.actions ?? [];
    expect(actions.map((action) => action.predicate.lemma)).toEqual(["shampoo", "leave", "rinse"]);
    expect(actions[0]?.args).toContainEqual(expect.objectContaining({
      role: AdviceArgumentRole.Manner,
      conceptId: "thoroughly"
    }));
    expect(actions[1]).toMatchObject({ relation: AdviceRelation.For });
    expect(actions[1]?.args).toContainEqual(expect.objectContaining({
      role: AdviceArgumentRole.Duration,
      quantity: { value: 15, unit: "min" }
    }));
    expect(actions[2]?.relation).toBeUndefined();
    expect(parsed.longText).toBe(
      "Apply the medication once daily at bedtime to the scalp; then shampoo thoroughly; leave on for 15 minutes; then wash off."
    );
  });

  it("preserves concurrent coordinated anatomy without introducing procedural actions", () => {
    const parsed = parseSig("apply to scalp and forehead bid");
    expect(parsed.items.map(item => item.fhir.site?.text)).toEqual(["scalp", "forehead"]);
    for (const item of parsed.items) {
      expect(item.fhir.timing?.repeat).toMatchObject({ frequency: 2, period: 1, periodUnit: "d" });
    }
    expect(parsed.meta.canonical.clauses.every(clause =>
      !clause.instructionGraph?.actions.length)).toBe(true);
    expect(parsed.meta.leftoverText).toBeUndefined();
  });

  it("scopes a terminal eye-drop precaution before FHIR while retaining its local action provenance", () => {
    const input = "instill 1 drop in left eye and 2 drops in right eye twice daily; do not touch dropper tip to eye";
    const parsed = parseSig(input);
    expect(parsed.items).toHaveLength(2);
    const [left, right] = parsed.items;
    const leftClause = left.meta.canonical.clauses[0];
    const rightClause = right.meta.canonical.clauses[0];
    const tailStart = input.indexOf("do not touch");

    for (const item of parsed.items) {
      expect(item.fhir.additionalInstruction).toEqual([
        expect.objectContaining({ text: "do not touch dropper tip to eye" })
      ]);
      expect(item.longText).toContain("Do not touch dropper tip to eye.");
    }
    const inherited = leftClause.additionalInstructions?.[0];
    const local = rightClause.additionalInstructions?.[0];
    expect(inherited?.frames?.[0]).toMatchObject({
      polarity: AdvicePolarity.Negate,
      predicate: { lemma: "touch" },
      span: { start: tailStart, end: input.length }
    });
    expect(inherited?.evidence?.some(evidence =>
      evidence.rule === "hpsg.cx.regimen.trailing-shared-negative-instruction" &&
      evidence.spans.some(span => span.start === tailStart && span.text === input.slice(tailStart))
    )).toBe(true);
    expect(local?.evidence?.some(evidence =>
      evidence.rule === "hpsg.cx.regimen.trailing-shared-negative-instruction"
    )).toBe(false);
    expect(rightClause.instructionGraph?.actions[0]).toMatchObject({
      polarity: AdvicePolarity.Negate,
      predicate: { lemma: "touch" },
      span: { start: tailStart, end: input.length }
    });
    expect(leftClause.instructionGraph?.actions.some(action =>
      action.predicate.lemma === "touch"
    ) ?? false).toBe(false);
    expect(canonicalToFhir(leftClause).additionalInstruction)
      .toEqual(left.fhir.additionalInstruction);
  });

  it("keeps an undelimited morning relation local to the procedural action", () => {
    const { clause: value } = clause("wash thoroughly in the morning");
    expect(value?.schedule).toBeUndefined();
    const wash = value?.instructionGraph?.actions[0];
    expect(wash?.predicate.lemma).toBe("wash");
    expect(wash?.relation).toBe(AdviceRelation.In);
    expect(wash?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: AdviceArgumentRole.Manner, conceptId: "thoroughly" }),
      expect.objectContaining({ role: AdviceArgumentRole.Time, conceptId: "morning" })
    ]));
  });
});
