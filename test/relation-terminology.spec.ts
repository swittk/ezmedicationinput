import { describe, expect, it } from "vitest";
import adviceTerminologySource from "../src/advice-terminology.json";
import lexicalClassesSource from "../src/hpsg/lexical-classes.json";
import { formatSig, parseSig } from "../src/index";
import { listMedicationLocaleLexemes } from "../src/lexer/locale";
import { SITE_ANCHORS, SITE_SELF_DISPLAY_ANCHORS } from "../src/hpsg/lexical-classes";
import { AdviceRelation } from "../src/types";
import {
  ACTION_SEQUENCE_MARKERS,
  ACTION_SEQUENCE_RELATION_SURFACES,
  getAdviceRelationDefinition,
  getBodySiteRelationDefinition,
  getBodySiteRelationRealization,
  getRelationLocaleLexemeAliases,
  getRelationLocalePhrases,
  getRelationSplitPrefixes,
  listAdviceRelationDefinitions,
  listBodySiteRelationDefinitions,
  localizeAdviceRelation,
  normalizeBodySiteRelation,
  resolveActionRelationSurface,
  resolveAdviceRelationSurface
} from "../src/relation-terminology";

describe("declarative relation terminology", () => {
  it("owns every AdviceRelation exactly once with English and Thai realization", () => {
    const definitions = listAdviceRelationDefinitions();
    const semanticRelations = Object.values(AdviceRelation);
    expect(definitions.map((definition) => definition.relation).sort()).toEqual(
      [...semanticRelations].sort()
    );
    expect(new Set(definitions.map((definition) => definition.relation)).size)
      .toBe(definitions.length);
    for (const definition of definitions) {
      expect(definition.realization.en).toBeTruthy();
      expect(definition.realization.th).toBeTruthy();
    }
  });

  it("keeps action, advice, and sequence licenses distinct", () => {
    expect(resolveActionRelationSurface("before")).toBe(AdviceRelation.Before);
    expect(resolveActionRelationSurface("at")).toBe(AdviceRelation.On);
    expect(resolveActionRelationSurface("to")).toBe(AdviceRelation.To);
    expect(resolveAdviceRelationSurface("before")).toBe(AdviceRelation.Before);
    expect(resolveAdviceRelationSurface("to")).toBeUndefined();
    expect(ACTION_SEQUENCE_MARKERS.has("then")).toBe(true);
    expect(ACTION_SEQUENCE_MARKERS.has("and")).toBe(false);
    expect(ACTION_SEQUENCE_RELATION_SURFACES.has("then")).toBe(true);
    expect(ACTION_SEQUENCE_RELATION_SURFACES.has("and")).toBe(true);
  });

  it("owns HPSG relation-class features instead of reconstructing enum lists", () => {
    expect(getAdviceRelationDefinition(AdviceRelation.Before)?.grammar).toMatchObject({
      preposedAction: true,
      conditionScope: true,
      timeComplement: true,
      durationComplement: true,
      activityFallback: true,
      workflowStart: true,
      workflowActionLead: true
    });
    expect(getAdviceRelationDefinition(AdviceRelation.When)?.grammar).toMatchObject({
      conditionalTail: true,
      conditionScope: true,
      symptomOnsetPrnLead: true
    });
    expect(getAdviceRelationDefinition(AdviceRelation.Into)?.grammar).toMatchObject({
      negatedObjectAttachment: true
    });
    expect(getAdviceRelationDefinition(AdviceRelation.For)?.grammar.durationLead).toBe(true);
    expect(getAdviceRelationDefinition(AdviceRelation.On)?.grammar.instructionStart).toBe(true);
    expect(getAdviceRelationDefinition(AdviceRelation.Without)?.grammar).toMatchObject({
      instructionStart: true,
      freeTextDirectiveStart: true
    });
    expect(getAdviceRelationDefinition(AdviceRelation.To)?.grammar.conditionalTail).toBeUndefined();
  });

  it("localizes AdviceRelation through declarative realization profiles", () => {
    expect(localizeAdviceRelation(AdviceRelation.Before, "th")).toBe("ก่อน");
    expect(localizeAdviceRelation(AdviceRelation.Before, "en")).toBe("before");
    expect(localizeAdviceRelation(AdviceRelation.On, "th")).toBe("บน");
    expect(localizeAdviceRelation(AdviceRelation.On, "th", "temporal")).toBe("เมื่อ");
    expect(localizeAdviceRelation(AdviceRelation.For, "th", "duration")).toBe("เป็นเวลา");
  });

  it("owns Thai relation lexemes, phrases, and split-prefix behavior", () => {
    const aliases = getRelationLocaleLexemeAliases("th");
    expect(aliases.get("ก่อน")).toBe("before");
    expect(aliases.get("ที่")).toBe("at");
    expect(aliases.get("ภายนอก")).toBe("external");
    // ระหว่าง is intentionally ambiguous: HPSG context decides during vs between.
    expect(aliases.get("ระหว่าง")).toBeUndefined();
    expect(resolveActionRelationSurface("ระหว่าง")).toBe(AdviceRelation.During);
    expect(resolveActionRelationSurface("ระหว่าง", ["interval"])).toBe(AdviceRelation.Between);

    expect(getRelationLocalePhrases("th")).toContainEqual({
      parts: ["เข้าไป", "ภายใน"],
      canonical: "into"
    });
    expect(getRelationSplitPrefixes("th")).toEqual(expect.arrayContaining([
      "ระหว่าง", "ก่อน", "หลัง", "เมื่อ", "ขณะ"
    ]));
  });

  it("keeps multi-token Thai relation phrases out of the single-token locale lexicon", () => {
    const lexemes = listMedicationLocaleLexemes("th");
    expect(lexemes.some((lexeme) => /\s/u.test(lexeme.surface) && [
      "แล้ว จึง",
      "จาก นั้น",
      "หลัง จาก นั้น",
      "เป็น เวลา",
      "เข้าไป ภายใน",
      "เข้าไป ใน"
    ].includes(lexeme.surface))).toBe(false);
    expect(lexemes).toContainEqual(expect.objectContaining({ surface: "เข้าไปภายใน", canonical: "into" }));
    expect(lexemes).toContainEqual(expect.objectContaining({ surface: "ระหว่าง", canonical: "during" }));
  });

  it("round-trips ambiguous Thai ระหว่าง as during while preserving interval between", () => {
    const source = parseSig("during exercise wash affected area");
    const thai = formatSig(source.fhir, "long", { locale: "th", realizationMode: "roundtrip" });
    expect(thai).toContain("ระหว่าง");

    const reparsed = parseSig(thai, { locale: "th" });
    const duringAction = reparsed.meta.canonical.clauses[0]?.instructionGraph?.actions.find((action) =>
      action.args.some((arg) => arg.conceptId === "exercise")
    );
    expect(duringAction?.relation).toBe(AdviceRelation.During);

    const between = parseSig("รอ 5 นาที ระหว่างยาหยอดตา", { locale: "th" });
    expect(between.meta.canonical.clauses[0]?.instructionGraph?.actions[0]?.relation)
      .toBe(AdviceRelation.Between);
  });

  it("retains declarative external site anchors across relation-derived sets", () => {
    expect(SITE_ANCHORS.has("external")).toBe(true);
    expect(SITE_SELF_DISPLAY_ANCHORS.has("external")).toBe(true);
    const parsed = parseSig("apply external vulva");
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.fhir.site?.text).toBe("external vulva");
  });

  it("normalizes body-site relation aliases and owns their realization strategy", () => {
    expect(normalizeBodySiteRelation("within")).toBe("inside");
    expect(normalizeBodySiteRelation("underneath")).toBe("under");
    expect(normalizeBodySiteRelation("next to")).toBe("near");
    expect(normalizeBodySiteRelation("adjacent to")).toBe("near");
    expect(normalizeBodySiteRelation("surrounding")).toBe("around");

    expect(getBodySiteRelationDefinition("near")?.grammar.externalSiteLocativePrefix).toBe(true);
    expect(getBodySiteRelationRealization("near", "th")).toMatchObject({
      surface: "ใกล้",
      strategy: "prefix",
      omitOuterSitePreposition: true
    });
    expect(getBodySiteRelationRealization("inside", "en")).toMatchObject({
      surface: "in",
      strategy: "prefix"
    });
    expect(getBodySiteRelationRealization("left side", "th")).toMatchObject({
      surface: "ด้านซ้าย",
      strategy: "suffix"
    });
  });

  it("owns trustworthy body-site spatial codings declaratively", () => {
    expect(getBodySiteRelationDefinition("under")?.coding).toMatchObject({
      system: "http://snomed.info/sct",
      code: "351726001",
      display: "Beneath"
    });
    expect(getBodySiteRelationDefinition("side")?.coding).toMatchObject({
      system: "http://snomed.info/sct",
      code: "49370004",
      display: "Lateral"
    });
    expect(listBodySiteRelationDefinitions().length).toBeGreaterThan(10);
  });

  it("forbids legacy duplicate relation registries from reappearing", () => {
    const lexical = lexicalClassesSource as Record<string, unknown>;
    for (const legacyKey of [
      "actionRelationTokens",
      "actionSequenceMarkers",
      "actionSequenceConnectors",
      "externalSiteLocativePrefixes",
      "durationLeadTokens",
      "conditionalInstructionExclusiveLeads",
      "workflowActionRelationLeads",
      "bodySiteLocativeRelationAliases",
      "bodySiteLocativeRelationPhrases",
      "bodySiteLocativeRelations",
      "bodySiteLocativeRenderPrepositions",
      "bodySiteSpatialRelationCodings"
    ]) {
      expect(lexical).not.toHaveProperty(legacyKey);
    }
    for (const token of ["before", "after", "with"]) {
      expect(lexical.workflowStartWords).not.toContain(token);
    }
    for (const token of ["on", "with", "without"]) {
      expect(lexical.instructionStartWords).not.toContain(token);
    }
    expect(lexical.freeTextDirectiveStarts).not.toEqual(expect.arrayContaining(["without"]));

    expect((adviceTerminologySource as { grammar?: Record<string, unknown> }).grammar)
      .not.toHaveProperty("sequenceMarkers");

    const adviceLexemes = (adviceTerminologySource as {
      lexemes?: Array<{
        surface?: string;
        partOfSpeech?: string;
        parserProfile?: string;
        parserRelation?: string;
      }>
    }).lexemes ?? [];
    expect(adviceLexemes.some((lexeme) => lexeme.partOfSpeech === "relation")).toBe(false);
    expect(adviceLexemes.find((lexeme) => lexeme.surface === "leave")).toMatchObject({
      parserProfile: "particle-relation",
      parserRelation: "on"
    });
    expect(adviceLexemes.some((lexeme) => lexeme.parserProfile === "leave-on")).toBe(false);
  });
});
