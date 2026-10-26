import { describe, expect, it } from "vitest";
import {
  resolveBodySitePhrase, resolveBodySiteRestrictionPredicate,
  formBodySiteRestriction, realizeBodySiteRestriction
} from "../src/body-site-grammar";
import { formatCanonicalClause } from "../src/format";
import {
  BODY_SITE_RESTRICTION_EXTENSION_URL,
  canonicalFromFhir
} from "../src/fhir";
import { parseClauseSign, tokenize } from "../src/parser";
import { ParserState } from "../src/parser-state";
import { siteLexicalRule } from "../src/hpsg/rules/site-rules";
import type { HpsgClauseContext } from "../src/hpsg/rule-context";
import {
  HPSG_TYPE_SYSTEM,
  type HpsgFeatureNode,
  type HpsgFeatureValue
} from "../src/hpsg/type-system";
import { parseSig } from "./helpers/r5-parser";
import { formatSig, fromFhirDosage, toDosageDetails, toFhirR5Dosages } from "../src/index";

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

describe("Thai typed relative-site existential realization", () => {
  it.each([
    ["there is rash", "ที่มีผื่น"],
    ["there is eczema", "ที่มีผื่นแพ้"],
    ["there is psoriasis", "ที่มีผื่นสะเก็ดเงิน"],
    ["there is acne", "ที่เป็นสิว"],
    ["there are hives", "ที่เป็นลมพิษ"]
  ])("uses one complete condition phrase for %s", (source, thai) => {
    const predicate = resolveBodySiteRestrictionPredicate(source);
    expect(predicate.form).toBe("existential");
    const restriction = formBodySiteRestriction(predicate, undefined, `where ${source}`);
    expect(realizeBodySiteRestriction(restriction, "th")).toBe(thai);
    expect(realizeBodySiteRestriction(restriction, "en")).toContain(source);
  });

  it("does not turn a non-existential site state into an existential one", () => {
    const state = formBodySiteRestriction(resolveBodySiteRestrictionPredicate("irritated"));
    expect(state.predicate.form).toBe("state");
    expect(realizeBodySiteRestriction(state, "th")).toBe("ที่ระคายเคือง");
  });

  it("keeps the same Thai restriction through parsed clinical FHIR representation", () => {
    const parsed = parseSig("apply 1 mL to skin where there is rash");
    expect(parsed.meta.canonical.clauses[0]?.site?.restrictions?.[0]?.predicate.form)
      .toBe("existential");
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).toContain("ที่มีผื่น");
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).not.toContain("ที่มีมีผื่น");
    expect(formatSig(toFhirR5Dosages(toDosageDetails([parsed.fhir]))[0], "long",
      { locale: "th" })).toContain("ที่มีผื่น");
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

it("localizes a symptom-qualified known body site without borrowing its SNOMED", () => {
  const site = resolveBodySitePhrase("painful rash");
  expect(site?.coding).toBeUndefined();
  expect(site?.siteI18n?.th).toBe("บริเวณผื่นที่ปวด");
});


describe("typed site coordination Thai realization", () => {
  it("retains typed disjunction translation across default R5 and R6 without a locale option", () => {
    const source = "ฉีดอินซูลิน 5 ยูนิตใต้ผิวหนังที่หน้าท้องหรือต้นขา สลับตำแหน่งทุกครั้ง ห้ามฉีดบริเวณที่ช้ำ";
    const parsed = parseSig(source);
    expect(parsed.meta.canonical.clauses[0]?.administrationTargetGroup).toMatchObject({
      coordination: "disjunction",
      targets: [
        { coding: { code: "302553009" } },
        { coding: { code: "68367000" } }
      ]
    });
    expect(parsed.fhir.site?.coding).toBeUndefined();
    expect(parsed.fhir.site?.text).toBe("abdomen or thigh");
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).toContain("ท้องหรือต้นขา");
    expect(formatSig(parsed.fhirNext, "long", { locale: "th" })).toContain("ท้องหรือต้นขา");
    const strictR5 = toFhirR5Dosages(toDosageDetails([parsed.fhir]));
    expect(strictR5).toHaveLength(1);
    expect(strictR5[0].site?.coding).toBeUndefined();
    expect(formatSig(strictR5[0], "long", { locale: "th" })).toContain("ท้องหรือต้นขา");
    expect(formatSig(fromFhirDosage(parsed.fhir).fhir, "long", { locale: "th" }))
      .toContain("ท้องหรือต้นขา");
    expect(parsed.meta.canonical.clauses[0]?.rawText).toContain("หน้าท้องหรือต้นขา");
  });

  it("realizes either-site choice with Thai clinical nouns without making simultaneous doses", () => {
    const parsed = parseSig("Apply 0.5 g to either arm or leg at bedtime.");
    expect(parsed.items).toHaveLength(1);
    expect(parsed.meta.canonical.clauses[0]?.administrationTargetGroup?.coordination)
      .toBe("disjunction");
    expect(parsed.fhir.site?.coding).toBeUndefined();
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).toContain("แขนหรือขา");
    expect(formatSig(parsed.fhirNext, "long", { locale: "th" })).toContain("แขนหรือขา");
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(0.5);
  });

  it("keeps bilateral coordinated anatomical targets distinct and translates them", () => {
    const parsed = parseSig("Apply 0.5 g to both arms and legs nightly.");
    expect(parsed.meta.canonical.clauses[0]?.administrationTargetGroup).toMatchObject({
      coordination: "conjunction",
      targets: [{ text: "both arms" }, { text: "both legs" }]
    });
    expect(parsed.items).toHaveLength(2);
    const th = parsed.items.map(item => formatSig(item.fhir, "long", { locale: "th" }));
    expect(th[0]).toContain("แขนทั้งสองข้าง");
    expect(th[1]).toContain("ขาทั้งสองข้าง");
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value))
      .toEqual([0.5, 0.5]);
    const strictR5 = toFhirR5Dosages(toDosageDetails(parsed.items.map(item => item.fhir)));
    expect(strictR5.map(row => row.site?.coding?.[0]?.code)).toEqual(["69273007", "40927001"]);
    expect(strictR5.map(row => formatSig(row, "long", { locale: "th" })))
      .toEqual(th);
  });

  it("recognizes laterality on the forearm while retaining an uncoded calf rather than fabricating SNOMED", () => {
    const parsed = parseSig("Apply 1 mL to the left forearm and right calf at bedtime.");
    expect(parsed.meta.canonical.clauses[0]?.administrationTargetGroup).toMatchObject({
      coordination: "conjunction",
      targets: [{ text: "left forearm" }, { text: "right calf" }]
    });
    expect(parsed.items).toHaveLength(2);
    const th = parsed.items.map(item => formatSig(item.fhir, "long", { locale: "th" }));
    expect(th[0]).toContain("ปลายแขนซ้าย");
    expect(th[1]).toContain("น่องขวา");
    expect(parsed.items[0]?.fhir.site?.coding?.[0]?.code).toBe("66480008");
    expect(parsed.items[1]?.fhir.site?.coding).toBeUndefined();
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value))
      .toEqual([1, 1]);
  });
});


describe("typed eyelid administration location and length units", () => {
  it.each([
    ["Apply 1 centimeter of ointment inside lower eyelid twice daily", "cm line"],
    ["Apply 1 cm ribbon of ointment inside the left lower eyelid nightly", "cm ribbon"],
    ["Apply 1 centimetre of ointment inside right lower eyelid twice daily", "cm line"]
  ] as const)("preserves ocular length and route for internal eyelid administration: %s", (source, unit) => {
    const parsed = parseSig(source);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit });
    expect(parsed.fhir.route?.coding?.[0]?.code).toBe("54485002");
    expect(parsed.fhir.site?.text).toMatch(/eyelid/i);
    expect(parsed.fhir.timing?.repeat?.frequency ??
      (parsed.fhir.timing?.repeat?.when?.includes("NIGHT") ? 1 : undefined))
      .toBeDefined();
    expect(parsed.input).toBe(source);
    const strict = toFhirR5Dosages(toDosageDetails([parsed.fhir]))[0];
    expect(strict.route?.coding?.[0]?.code).toBe("54485002");
    expect(strict.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit });
  });

  it("keeps ambiguous external lid cream application topical without an internal locative", () => {
    const parsed = parseSig("Apply 0.2 g of cream to lower eyelid twice daily");
    expect(parsed.fhir.route?.coding?.[0]?.code).toBe("6064005");
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity)
      .toMatchObject({ value: 0.2, unit: "g" });
  });

  it("does not interpret skin outside the lid as conjunctival drug administration", () => {
    const parsed = parseSig("Apply a thin layer of cream to skin outside the left lower eyelid twice daily");
    expect(parsed.fhir.route?.coding?.[0]?.code).not.toBe("54485002");
    expect(parsed.meta.canonical.clauses[0]?.rawText).toContain("outside");
  });
});


describe("coded anatomical spatial qualifiers", () => {
  it.each([
    ["center of chest", "26216008"],
    ["front of knee", "255549009"],
    ["inside cheek", "260521003"]
  ])("retains the precise qualifier for %s", (site, code) => {
    const parsed = parseSig(`Apply cream to ${site} BID`);
    const relation = parsed.meta.canonical.clauses[0]?.site?.spatialRelation;
    expect(relation?.relationCoding).toMatchObject({ system: "http://snomed.info/sct", code });
    const reopened = canonicalFromFhir(toFhirR5Dosages(toDosageDetails([parsed.fhir]))[0]);
    expect(reopened.site?.spatialRelation?.relationCoding?.code).toBe(code);
  });
});


describe("Thai site-anchor lexical ambiguity", () => {
  it("retains both locative site and relative-where readings of ที่", () => {
    const source = "ทาครีมที่แขนวันละ 2 ครั้ง";
    const tokens = tokenize(source);
    const index = tokens.findIndex(token => token.lower === "ที่");
    expect(index).toBeGreaterThanOrEqual(0);
    const context: HpsgClauseContext = {
      state: new ParserState(source, tokens), tokens, limit: tokens.length,
      dateSpans: [], clinicalCache: {}, deps: {} as HpsgClauseContext["deps"]
    };
    const signs = siteLexicalRule().match(context, index);
    expect(signs?.some(sign => sign.type === "site-relative-marker-sign")).toBe(true);
    expect(signs?.some(sign => sign.type === "site-sign" &&
      sign.tokens.some(token => token.lower === "แขน"))).toBe(true);
    const dosage = parseSig(source).fhir;
    expect(dosage.site?.coding?.[0]?.code).toBe("302538001");
    expect(dosage.timing?.repeat?.frequency).toBe(2);
  });
});
