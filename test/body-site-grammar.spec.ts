import { describe, expect, it } from "vitest";
import { resolveBodySitePhrase } from "../src/body-site-grammar";
import { formatCanonicalClause } from "../src/format";
import {
  BODY_SITE_RESTRICTION_EXTENSION_URL,
  canonicalFromFhir
} from "../src/fhir";
import { parseClauseSign } from "../src/parser";
import {
  HPSG_TYPE_SYSTEM,
  type HpsgFeatureNode,
  type HpsgFeatureValue
} from "../src/hpsg/type-system";
import { parseSig } from "./helpers/r5-parser";

function featureGraphHasType(
  value: HpsgFeatureValue,
  expected: string,
  visited = new Set<object>()
): boolean {
  if (value.kind === "atom" || visited.has(value)) return false;
  if (value.type === expected) return true;
  visited.add(value);
  return Object.keys(value.features).some((key) =>
    featureGraphHasType(value.features[key], expected, visited)
  );
}

function findFeatureNode(
  value: HpsgFeatureValue,
  expected: string,
  visited = new Set<object>()
): HpsgFeatureNode | undefined {
  if (value.kind === "atom" || visited.has(value)) return undefined;
  if (value.type === expected) return value;
  visited.add(value);
  for (const key of Object.keys(value.features)) {
    const found = findFeatureNode(value.features[key], expected, visited);
    if (found) return found;
  }
  return undefined;
}

describe("body-site terminal inheritance", () => {
  it("does not erase clinically meaningful modifiers into an exact base-site code", () => {
    for (const phrase of [
      "affected knee",
      "broken knee",
      "painful knee",
      "external knee",
      "irritated knee",
      "inflamed knee"
    ]) {
      const resolved = resolveBodySitePhrase(phrase, undefined, { allowTerminalModifierInheritance: true });
      expect(resolved?.coding, phrase).toBeUndefined();
    }
  });

  it("retains terminal inheritance for non-pathological administration qualifiers", () => {
    const resolved = resolveBodySitePhrase("dry knee", undefined, { allowTerminalModifierInheritance: true });
    expect(resolved?.coding?.code).toBe("72696002");
    expect(resolved?.displayText).toBe("dry knee");
  });
});

describe("typed site-relative restrictions", () => {
  it.each([
    [
      "apply 1 mL to scalp where there is hair loss",
      {
        sourceText: "where there is hair loss",
        predicate: {
          text: "there is hair loss",
          form: "existential",
          focusText: "hair loss"
        }
      }
    ],
    [
      "apply 1 mL to scalp where affected",
      {
        sourceText: "where affected",
        predicate: {
          text: "affected",
          lemma: "affected",
          form: "state"
        }
      }
    ]
  ] as const)("attaches the relative predicate to the coded site in %s", (source, expected) => {
    const sign = parseClauseSign(source);
    const restrictedSite = sign && findFeatureNode(sign.fs, "restricted-site-phrase");
    expect(HPSG_TYPE_SYSTEM.isSubtype("restricted-site-phrase", "head-adjunct-phrase"))
      .toBe(true);
    expect(restrictedSite).toBeDefined();
    expect(restrictedSite?.features.HEAD_DTR).toMatchObject({ type: "site-sign" });
    expect(restrictedSite?.features.NON_HEAD_DTR).toMatchObject({ type: "site-relative-clause" });
    expect(featureGraphHasType(sign!.fs, "site-relative-clause")).toBe(true);
    expect(featureGraphHasType(sign!.fs, "restricted-site-phrase")).toBe(true);
    expect(sign?.evidence).toContainEqual(expect.objectContaining({
      rule: "hpsg.lex.site.relative-marker"
    }));
    expect(sign?.evidence).toContainEqual(expect.objectContaining({
      rule: "hpsg.lex.site.restriction-predicate"
    }));
    expect(restrictedSite?.type).toBe("restricted-site-phrase");
    expect(sign?.synsem.valence.site?.restrictions).toHaveLength(1);
    expect(sign?.synsem.valence.site?.restrictions?.[0]).toMatchObject(expected);
    expect(sign?.synsem.valence.site?.restrictions?.[0]?.relation).toBe("where");
    expect(sign?.synsem.valence.site?.restrictions?.[0]?.sourceText).toBe(expected.sourceText);
    expect(sign?.synsem.valence.site?.restrictions?.[0]?.predicate).toMatchObject(expected.predicate);
    expect((restrictedSite?.features.SYNSEM as HpsgFeatureNode | undefined)?.type).toBe("synsem");
    expect(sign?.construction).not.toMatchObject({
      kind: "head-adjunct",
      operation: "restrict-site",
      headSide: "left"
    });
    expect(sign?.synsem.head.method?.verb).toBe("apply");
    expect(sign?.synsem.head.dose).toMatchObject({ value: 1, unit: "mL" });
    expect(sign?.synsem.valence.site).toMatchObject({
      text: "scalp",
      coding: { system: "http://snomed.info/sct", code: "41695006" },
      restrictions: [{ relation: "where", ...expected }]
    });
    expect(sign?.synsem.head.schedule).toBeUndefined();
    expect(sign?.synsem.valence.prn).toBeUndefined();
    expect(sign?.synsem.cont.clinicalAdjunct).toBeUndefined();

    const parsed = parseSig(source);
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause?.dose).toEqual({ value: 1, unit: "mL" });
    expect(clause?.site).toMatchObject({
      text: "scalp",
      coding: { system: "http://snomed.info/sct", code: "41695006" },
      restrictions: [{ relation: "where", ...expected }]
    });
    expect(clause?.evidence).toContainEqual(expect.objectContaining({
      rule: "hpsg.lex.site.relative-marker",
      spans: [expect.objectContaining({ text: "where" })]
    }));
    expect(clause?.evidence).toContainEqual(expect.objectContaining({
      rule: "hpsg.lex.site.restriction-predicate",
      spans: [expect.objectContaining({ text: expected.predicate.text })]
    }));
    expect(clause?.schedule).toBeUndefined();
    expect(clause?.prn).toBeUndefined();
    expect(clause?.clinicalAdjuncts).toBeUndefined();
    expect(parsed.fhir.site?.coding?.[0]?.code).toBe("41695006");
    expect(parsed.fhir.site?.extension).toContainEqual(expect.objectContaining({
      url: BODY_SITE_RESTRICTION_EXTENSION_URL
    }));
    expect(parsed.fhir.timing).toBeUndefined();
    expect(parsed.fhir.asNeeded).not.toBe(true);
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.longText.toLowerCase()).toContain(expected.sourceText);

    const recovered = canonicalFromFhir(parsed.fhir);
    expect(recovered.site?.coding?.code).toBe("41695006");
    expect(recovered.site?.restrictions).toMatchObject([
      { relation: "where", ...expected }
    ]);
    expect(formatCanonicalClause(recovered, "long").toLowerCase())
      .toContain(expected.sourceText);
    expect(recovered.site?.restrictions?.[0]).not.toHaveProperty("coding");
    expect(recovered.site?.restrictions?.[0]?.predicate).not.toHaveProperty("coding");
  });
});
