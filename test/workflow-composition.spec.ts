import { describe, expect, it } from "vitest";
import { AdviceArgumentRole, AdviceRelation, EventTiming, formatSig, parseSig } from "../src/index";

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

  it("preserves coordinated anatomy when and does not introduce an action", () => {
    const parsed = parseSig("apply to scalp and forehead bid");
    expect(parsed.fhir.site?.text).toBe("scalp and forehead");
    expect(parsed.fhir.timing?.repeat).toMatchObject({ frequency: 2, period: 1, periodUnit: "d" });
    expect(parsed.meta.leftoverText).toBeUndefined();
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
