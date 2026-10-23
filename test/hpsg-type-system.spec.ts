import { describe, expect, it, vi } from "vitest";
import * as structuredValues from "../src/stable-structure";
import { parseHpsgChart } from "../src/hpsg/chart";
import {
  HPSG_TYPE_SYSTEM,
  HpsgTypeSystem,
  canonicalFeatureStructure,
  featureAtom,
  featureNode,
  unifyFeatureStructures,
  validateFeatureStructure
} from "../src/hpsg/type-system";
import { combineSignFeatureStructures, signFeatureStructure } from "../src/hpsg/feature-structure";
import { selectHpsgConstruction } from "../src/hpsg/constructions";
import { lexicalSign } from "../src/hpsg/signature";
import { tokenize, parseClauseState } from "../src/parser";
import { applyCoordinatedCadenceScopes } from "../src/regimen/coordination-scope";
import { createBoundaryPlan } from "../src/regimen/planner";
import { ParserState } from "../src/parser-state";
import { findMedicationDateListSpans } from "../src/date-interpretation";
import {
  calendarExclusionLexicalRule,
  medicationGuardLexicalRule
} from "../src/hpsg/rules/condition-rules";

function clinicalRuleContext(input: string) {
  const tokens = tokenize(input);
  return {
    state: new ParserState(input, tokens),
    tokens,
    dateSpans: findMedicationDateListSpans(input),
    limit: tokens.length,
    clinicalCache: {},
    deps: {
      addDayOfWeekList: () => undefined,
      addWhen: () => undefined,
      isCompatibleRouteRefinement: () => true,
      markToken: () => undefined,
      normalizeSiteText: (text: string) => text,
      recordEvidence: () => undefined,
      refreshMethodSurface: () => undefined,
      setRoute: () => undefined
    }
  };
}

function firstLexicalMatch(
  rule: ReturnType<typeof medicationGuardLexicalRule>,
  input: string
) {
  const context = clinicalRuleContext(input);
  for (let index = 0; index < context.limit; index += 1) {
    const match = rule.match(context, index)[0];
    if (match) return match;
  }
  return undefined;
}

describe("formal HPSG typed feature structures", () => {
  it("uses a real subtype hierarchy for signs", () => {
    expect(HPSG_TYPE_SYSTEM.isSubtype("method-sign", "word-sign")).toBe(true);
    expect(HPSG_TYPE_SYSTEM.isSubtype("method-sign", "sign")).toBe(true);
    expect(HPSG_TYPE_SYSTEM.isSubtype("clause-sign", "phrase-sign")).toBe(true);
    expect(HPSG_TYPE_SYSTEM.isSubtype("conditional-sign", "word-sign")).toBe(true);
    expect(HPSG_TYPE_SYSTEM.isSubtype("adjustment-sign", "word-sign")).toBe(true);
    expect(HPSG_TYPE_SYSTEM.isSubtype("clause-sign", "word-sign")).toBe(false);
  });

  it("supports multiple inheritance and computes a compatible subtype", () => {
    const types = new HpsgTypeSystem([
      { name: "top" },
      { name: "left", parents: ["top"] },
      { name: "right", parents: ["top"] },
      { name: "both", parents: ["left", "right"] }
    ]);
    expect(types.isSubtype("both", "left")).toBe(true);
    expect(types.isSubtype("both", "right")).toBe(true);
    expect(types.mostSpecificCompatibleType("left", "right")).toBe("both");
  });

  it("enforces appropriateness constraints", () => {
    const malformed = featureNode("method-sign", {
      SYNSEM: featureNode("synsem", {
        HEAD: featureNode("head", { ILLEGAL: featureNode("method-feature") }),
        VALENCE: featureNode("valence"),
        CONT: featureNode("content")
      })
    });
    const issues = validateFeatureStructure(malformed, HPSG_TYPE_SYSTEM);
    expect(issues.some((issue) => issue.message.includes("not appropriate"))).toBe(true);
  });

  it("performs general feature unification and rejects atom conflicts", () => {
    const types = new HpsgTypeSystem([
      { name: "top" },
      { name: "atom", parents: ["top"] },
      { name: "string", parents: ["atom"] },
      { name: "record", parents: ["top"], features: { NAME: { valueType: "string" } } }
    ]);
    const left = featureNode("record", { NAME: featureAtom("alpha") });
    const same = featureNode("record", { NAME: featureAtom("alpha") });
    const different = featureNode("record", { NAME: featureAtom("beta") });
    expect(unifyFeatureStructures(left, same, types).value).toBeDefined();
    expect(unifyFeatureStructures(left, different, types).value).toBeUndefined();
  });

  it("preserves reentrancy when a shared feature value is unified", () => {
    const types = new HpsgTypeSystem([
      { name: "top" },
      { name: "thing", parents: ["top"] },
      {
        name: "pair",
        parents: ["top"],
        features: { LEFT: { valueType: "thing" }, RIGHT: { valueType: "thing" } }
      }
    ]);
    const shared = featureNode("thing");
    const left = featureNode("pair", { LEFT: shared, RIGHT: shared });
    const right = featureNode("pair");
    const unified = unifyFeatureStructures(left, right, types).value;
    expect(unified?.kind).toBe("node");
    if (!unified || unified.kind !== "node") return;
    expect(unified.features.LEFT).toBe(unified.features.RIGHT);
    expect(canonicalFeatureStructure(unified)).toContain('"ref"');
  });

  it("types headed phrase constructions with the expected inheritance", () => {
    expect(HPSG_TYPE_SYSTEM.isSubtype("head-complement-phrase", "headed-phrase")).toBe(true);
    expect(HPSG_TYPE_SYSTEM.isSubtype("head-adjunct-phrase", "phrase-sign")).toBe(true);
    expect(HPSG_TYPE_SYSTEM.isSubtype("administration-clause", "clause-sign")).toBe(true);
    expect(HPSG_TYPE_SYSTEM.isSubtype("administration-clause", "headed-phrase")).toBe(true);
  });

  it("rejects ambiguous headed schemas instead of returning a headed phrase without daughter identity", () => {
    const tokens = tokenize("take apply");
    const makeAmbiguous = (index: number) => lexicalSign({
      type: "method-sign",
      rule: "test.ambiguous-head",
      tokens: [tokens[index]],
      synsem: {
        head: {
          method: { verb: index === 0 ? "take" : "apply", text: index === 0 ? "Take" : "Apply" },
          dose: { value: 1, unit: "tab" }
        },
        valence: {},
        cont: { clauseKind: "administration" }
      }
    });
    const selected = selectHpsgConstruction(makeAmbiguous(0), makeAmbiguous(1));
    expect(selected).toBeUndefined();
  });

  it("stores formal head and non-head daughter identity on headed phrase AVMs", () => {
    const head = signFeatureStructure("method-sign", {
      head: { method: { verb: "apply" } },
      valence: {},
      cont: { clauseKind: "administration" }
    });
    const complement = signFeatureStructure("site-sign", {
      head: {},
      valence: { site: { text: "lesion" } },
      cont: { clauseKind: "administration" }
    });
    const mother = combineSignFeatureStructures(
      head,
      complement,
      "head-complement-phrase",
      "left"
    );
    expect(mother).toBeDefined();
    expect(mother?.features.HEAD_DTR).toBe(head);
    expect(mother?.features.NON_HEAD_DTR).toBe(complement);
    expect(mother?.features.LEFT_DTR).toBe(head);
    expect(mother?.features.RIGHT_DTR).toBe(complement);
    expect(mother ? validateFeatureStructure(mother, HPSG_TYPE_SYSTEM) : []).toEqual([]);
  });

  it("materializes existing medication SYNSEM as an appropriate typed sign", () => {
    const fs = signFeatureStructure("method-sign", {
      head: { method: { verb: "apply" } },
      valence: {},
      cont: { clauseKind: "administration" }
    });
    expect(validateFeatureStructure(fs, HPSG_TYPE_SYSTEM)).toEqual([]);
    expect(fs.features.SYNSEM?.kind).toBe("node");
  });

  it("owns medication guards and calendar exclusions on typed HPSG lexical signs", () => {
    expect(HPSG_TYPE_SYSTEM.isSubtype("clinical-adjunct-sign", "word-sign")).toBe(true);

    const guard = firstLexicalMatch(
      medicationGuardLexicalRule(),
      "take 1 tab BID only if BP > 160, otherwise hold"
    );
    expect(guard?.type).toBe("clinical-adjunct-sign");
    expect(guard?.synsem.cont.clinicalAdjunct?.condition).toMatchObject({
      kind: "measurement",
      name: "bp",
      operation: "gt",
      value: 160
    });
    expect(guard ? validateFeatureStructure(guard.fs, HPSG_TYPE_SYSTEM) : []).toEqual([]);
    expect(guard ? canonicalFeatureStructure(guard.fs) : "")
      .toContain("clinical-adjunct-feature");

    const exclusion = firstLexicalMatch(
      calendarExclusionLexicalRule(),
      "take 1 tab daily except Sundays"
    );
    expect(exclusion?.type).toBe("clinical-adjunct-sign");
    expect(exclusion?.synsem.cont.clinicalAdjunct?.excludedWeekdays).toEqual(["sun"]);
    expect(exclusion ? validateFeatureStructure(exclusion.fs, HPSG_TYPE_SYSTEM) : []).toEqual([]);
  });
});


describe("typed lexical provenance independent of production names", () => {
  it("records lexical categories from typed signs, not diagnostic labels", () => {
    const tokens = tokenize("1");
    const dose = lexicalSign({
      type: "dose-sign", rule: "an.unrelated.diagnostic.label", tokens,
      synsem: { head: { dose: { value: 1, unit: "tab" } }, valence: {}, cont: {} }
    });
    expect(dose.evidence[0].lexicalCategory).toBe("dose");
    expect(dose.evidence[0].rule).toBe("an.unrelated.diagnostic.label");
  });

  it("does not claim undefined optional schedule fields as contributed meaning", () => {
    const sign = lexicalSign({
      type: "schedule-sign", rule: "custom.schedule.alias", tokens: tokenize("BID"),
      synsem: {
        head: { schedule: {
          frequency: 2, period: 1, periodUnit: "d", timingCode: undefined,
          boundsStart: undefined
        } }, valence: {}, cont: {}
      }
    });
    expect(sign.evidence[0].scheduleFields).toEqual(["frequency", "period", "periodUnit"]);
  });

  it.each([
    ["instill 1 drop in left eye and 2 drops in right eye twice daily", false],
    ["instill 1 drop in left eye and 2 drops in right eye twice daily as needed", true]
  ])("preserves coordination after every diagnostic production label is renamed: %s", (input, prn) => {
    const plan = createBoundaryPlan(input);
    expect(plan.segments).toHaveLength(2);
    const clauses = plan.segments.map(segment => ({
      state: parseClauseState(segment.text), start: segment.start, end: segment.end
    }));
    for (const item of clauses) {
      const clause = item.state.primaryClause;
      for (const evidence of clause.evidence) evidence.rule = "renamed-diagnostic-label";
      for (const evidence of clause.schedule?.evidence ?? []) evidence.rule = "renamed-schedule-label";
      for (const evidence of clause.prn?.evidence ?? []) evidence.rule = "renamed-prn-label";
    }
    const scopes = applyCoordinatedCadenceScopes(clauses, plan, input);
    expect(scopes.length).toBeGreaterThan(0);
    expect(clauses.map(item => item.state.primaryClause.dose?.value)).toEqual([1, 2]);
    expect(clauses.map(item => item.state.primaryClause.site?.text)).toEqual(["left eye", "right eye"]);
    expect(clauses.map(item => item.state.primaryClause.schedule?.frequency)).toEqual([2, 2]);
    if (prn) expect(clauses.every(item => item.state.primaryClause.prn?.enabled)).toBe(true);
  });
});


describe("typed coordination ignores diagnostic prose", () => {
  it.each(["Unresolved schedule", "incompatible timing", "timing conflict", "some localized warning"])(
    "retains a licensed shared cadence regardless of warning wording: %s", warning => {
      const input = "instill 1 drop in left eye and 2 drops in right eye twice daily";
      const plan = createBoundaryPlan(input);
      const states = plan.segments.map(segment => ({
        state: parseClauseState(segment.text), start: segment.start, end: segment.end
      }));
      states[1].state.warnings.push(warning);
      applyCoordinatedCadenceScopes(states, plan, input);
      expect(states.map(item => item.state.primaryClause.schedule?.frequency)).toEqual([2, 2]);
      expect(states.map(item => item.state.primaryClause.dose?.value)).toEqual([1, 2]);
      expect(states[1].state.warnings).toContain(warning);
    }
  );
});


describe("HPSG structural equality hygiene", () => {
  it("unifies equal structured atoms regardless of property order, without serialization", () => {
    const left = featureAtom({ code: "x", coding: { system: "urn:test", display: "Apply" } }, "json");
    const right = featureAtom({ coding: { display: "Apply", system: "urn:test" }, code: "x" }, "json");
    const stringify = vi.spyOn(JSON, "stringify").mockImplementation(() => { throw new Error("grammar must stay structured"); });
    let result: ReturnType<typeof unifyFeatureStructures>;
    try {
      result = unifyFeatureStructures(left, right, HPSG_TYPE_SYSTEM);
    } finally {
      stringify.mockRestore();
    }
    expect(result!.value).toBeDefined();
    expect(result!.issues).toEqual([]);
    expect(unifyFeatureStructures(left, featureAtom({ code: "different" }, "json"), HPSG_TYPE_SYSTEM).value)
      .toBeUndefined();
  });

  it("does not serialize ordinary typed clause parsing", () => {
    const stringify = vi.spyOn(JSON, "stringify").mockImplementation(() => { throw new Error("grammar must stay structured"); });
    let state: ReturnType<typeof parseClauseState>;
    try {
      state = parseClauseState("instill 1 drop OD QID");
    } finally {
      stringify.mockRestore();
    }
    expect(state!.primaryClause.dose?.value).toBe(1);
    expect(state!.primaryClause.schedule?.frequency).toBe(4);
  });

  it("keeps distinct doses on a hash collision while packing equivalent derivations", () => {
    const tokens = tokenize("1 tab");
    const one = lexicalSign({ type: "dose-sign", rule: "test.dose.one", tokens,
      synsem: { head: { dose: { value: 1, unit: "tab" } }, valence: {}, cont: {} } });
    const two = lexicalSign({ type: "dose-sign", rule: "test.dose.two", tokens,
      synsem: { head: { dose: { value: 2, unit: "tab" } }, valence: {}, cont: {} } });
    const equivalent = lexicalSign({ type: "dose-sign", rule: "test.dose.reordered", tokens, score: 10,
      synsem: { cont: {}, valence: {}, head: { dose: { unit: "tab", value: 1 } } } });
    const hash = vi.spyOn(structuredValues, "hashStructuredValue").mockReturnValue(7);
    let result: ReturnType<typeof parseHpsgChart>;
    try {
      result = parseHpsgChart({ tokens }, {
        lexicalRules: [{ id: "test.doses", type: "dose-sign", match: (_context, start) =>
          start === 0 ? [one, two, equivalent] : [] }],
        phraseRules: []
      });
    } finally {
      hash.mockRestore();
    }
    expect(result!.signs).toHaveLength(2);
    expect(result!.signs.map(sign => sign.synsem.head.dose?.value).sort()).toEqual([1, 2]);
    expect(result!.signs).toContain(equivalent);
    expect(result!.signs).not.toContain(one);
  });
});
