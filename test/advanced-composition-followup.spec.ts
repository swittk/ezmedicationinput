import { describe, expect, it } from "vitest";
import {
  AdviceArgumentRole, AdviceRelation, EventTiming, formatSig, fromFhirDosage,
  getDosageCondition, getDosageExcludedWeekdays, nextDueDoses, toDosageDetails, toFhirR5Dosages,
  parseSig as parseProductionSig
} from "../src/index";
import { parseSig } from "./helpers/r5-parser";
import { resolveBodySitePhrase } from "../src/body-site-grammar";
import { parseClauseSign } from "../src/parser";
import { lexInput } from "../src/lexer/lex";
import { annotateLexTokens } from "../src/lexer/meaning";
import { explicitDoseLexicalEnd } from "../src/hpsg/rules/core-rules";
import type { BodySiteRestriction } from "../src/types";
import { HPSG_TYPE_SYSTEM, type HpsgFeatureNode } from "../src/hpsg/type-system";
import {
  BODY_SITE_RESTRICTION_EXTENSION_URL,
  ADMINISTRATION_OFFSET_EXTENSION_URL,
  getAdministrationOffsetMinutes, parserStateFromFhir
} from "../src/fhir";
import { shiftCanonicalSigClauses } from "../src/ir";

const CUSTOM_RELATIVE_SITE_MAP = {
  moob: {
    text: "Moob patch",
    coding: {
      system: "http://example.org/custom-sites",
      code: "MOOB",
      display: "Moob patch"
    }
  },
  goob: {
    text: "Goob patch",
    coding: {
      system: "http://example.org/custom-sites",
      code: "GOOB",
      display: "Goob patch"
    }
  },
  "donor area": {
    text: "Donor area",
    coding: {
      system: "http://example.org/custom-sites",
      code: "DONOR-AREA",
      display: "Donor area"
    }
  },
  "treatment field": {
    text: "Treatment field",
    coding: {
      system: "http://example.org/custom-sites",
      code: "TREATMENT-FIELD",
      display: "Treatment field"
    }
  }
} as const;

function siteRestrictions(site: unknown): BodySiteRestriction[] | undefined {
  return (site as { restrictions?: BodySiteRestriction[] } | undefined)?.restrictions;
}

function expectRestriction(
  site: unknown,
  source: string,
  predicateText: string,
  wholeInput: string
): void {
  const restrictions = siteRestrictions(site);
  expect(restrictions, `${wholeInput}: typed site restrictions`).toHaveLength(1);
  const restriction = restrictions?.[0];
  expect(restriction?.relation).toBe("where");
  expect(restriction?.sourceText).toBe(source);
  expect(restriction?.predicate.text.toLowerCase())
    .toContain(predicateText.toLowerCase());
  const start = wholeInput.indexOf(source);
  expect(restriction?.range).toEqual({ start, end: start + source.length });
  expect(restriction?.markerRange).toEqual({ start, end: start + "where".length });
  const predicateStart = start + "where ".length;
  expect(restriction?.predicate.range).toEqual({
    start: predicateStart,
    end: start + source.length
  });
  const expectedForm = source.startsWith("where there ") ? "existential" :
    ["affected", "irritated"].includes(restriction?.predicate.text.toLowerCase() ?? "")
      ? "state"
      : "raw";
  expect(restriction?.predicate.form).toBe(expectedForm);
  if (expectedForm === "existential") {
    expect(restriction?.predicate.focusText?.toLowerCase()).toContain(predicateText.toLowerCase());
  }
}

function findSiteHeadedRestriction(root: HpsgFeatureNode): HpsgFeatureNode | undefined {
  const pending = [root];
  const visited = new Set<HpsgFeatureNode>();
  while (pending.length) {
    const node = pending.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    const head = node.features.HEAD_DTR;
    const adjunct = node.features.NON_HEAD_DTR;
    if (
      node.type === "restricted-site-phrase" &&
      head?.kind === "node" && head.type === "site-sign" &&
      adjunct?.kind === "node" && adjunct.type === "site-relative-clause"
    ) return node;
    for (const key of Object.keys(node.features)) {
      const feature = node.features[key];
      if (feature?.kind === "node") pending.push(feature);
    }
  }
  return undefined;
}

function expectSiteHeadedRestrictionDerivation(sign: ReturnType<typeof parseClauseSign>): void {
  expect(HPSG_TYPE_SYSTEM.isSubtype("restricted-site-phrase", "head-adjunct-phrase"))
    .toBe(true);
  expect(sign).toBeDefined();
  const attachment = findSiteHeadedRestriction(sign!.fs);
  expect(attachment, "restricted-site-phrase must attach to SITE-NP before administration composition")
    .toBeDefined();
  const relative = attachment?.features.NON_HEAD_DTR;
  expect(relative?.kind).toBe("node");
  if (relative?.kind !== "node") return;
  expect([
    relative.features.LEFT_DTR?.kind === "node" ? relative.features.LEFT_DTR.type : undefined,
    relative.features.RIGHT_DTR?.kind === "node" ? relative.features.RIGHT_DTR.type : undefined
  ]).toEqual(expect.arrayContaining(["site-relative-marker-sign", "site-predicate-sign"]));
  const restrictedSynsem = attachment?.features.SYNSEM;
  expect(restrictedSynsem?.kind).toBe("node");
  if (restrictedSynsem?.kind !== "node") return;
  const head = restrictedSynsem.features.HEAD;
  expect(head?.kind === "node" ? Object.keys(head.features) : []).toEqual([]);
  const valence = restrictedSynsem.features.VALENCE;
  expect(valence?.kind === "node" ? Object.keys(valence.features) : []).toEqual(["SITE"]);
}

const CASES = [
  [
    "1 drop to od q 30 min - 2h prn pain",
    "Instill 1 drop every 30 to 120 minutes as needed for pain in the right eye.",
    "หยอดตาขวา ครั้งละ 1 หยด ทุก 30 ถึง 120 นาที ใช้เมื่อปวด."
  ],
  [
    "apply to external genital area then wash off thoroughly",
    "Apply the medication to the external genitalia; then wash off thoroughly.",
    "ทาบริเวณอวัยวะเพศภายนอก จากนั้นล้างให้ทั่ว."
  ],
  [
    "apply to outside of vagina then wash off thoroughly",
    "Apply the medication outside the vagina; then wash off thoroughly.",
    "ทาบริเวณด้านนอกช่องคลอด จากนั้นล้างให้ทั่ว."
  ],
  [
    "insert under tongue then wait until dissolved",
    "Insert the medication under the tongue; then wait until dissolved.",
    "สอดที่ใต้ลิ้น จากนั้นรอจนกว่าละลายหมด."
  ],
  [
    "dissolve in water then drink, may cause vomiting",
    "Dissolve in water; then drink the medication. May cause vomiting.",
    "ละลายในน้ำ จากนั้นดื่ม. อาจทำให้เกิดอาเจียน."
  ],
  [
    "dissolve in water before drinking, may cause vomiting",
    "Dissolve in water before drinking. May cause vomiting.",
    "ละลายในน้ำก่อนการดื่ม. อาจทำให้เกิดอาเจียน."
  ],
  [
    "apply to right armpit",
    "Apply the medication to the right armpit.",
    "ทาบริเวณรักแร้ด้านขวา."
  ],
  [
    "apply to left flank at lesion",
    "Apply the medication to the left flank at the lesion.",
    "ทาบริเวณสีข้างด้านซ้ายตรงรอยโรค."
  ],
  [
    "apply to below right knee where pain",
    "Apply the medication below the right knee where painful.",
    "ทาบริเวณใต้เข่าขวาที่ปวด."
  ],
  [
    "apply to below right knee where painful",
    "Apply the medication below the right knee where painful.",
    "ทาบริเวณใต้เข่าขวาที่ปวด."
  ],
  [
    "apply to below right knee where hurt",
    "Apply the medication below the right knee where painful.",
    "ทาบริเวณใต้เข่าขวาที่ปวด."
  ],
  [
    "apply to below right knee where hurts",
    "Apply the medication below the right knee where painful.",
    "ทาบริเวณใต้เข่าขวาที่ปวด."
  ],
  [
    "apply to below left knee before sleep and when itchy",
    "Apply the medication at bedtime as needed for itch below the left knee.",
    "ทาบริเวณใต้เข่าซ้าย ก่อนนอน ใช้เมื่อคัน."
  ]
] as const;

describe("advanced compositional follow-up", () => {
  for (const [input, english, thai] of CASES) {
    it(`round-trips ${input}`, () => {
      const parsed = parseSig(input);
      expect(parsed.meta.leftoverText).toBeUndefined();
      expect(parsed.longText).toBe(english);
      expect(formatSig(parsed.fhir, "long", { locale: "th" })).toBe(thai);
      expect(thai).not.toMatch(/[A-Za-z]/u);

      const dosage = JSON.parse(JSON.stringify(parsed.fhir));
      expect(fromFhirDosage(dosage, { locale: "th" }).longText).toBe(thai);
      expect(formatSig(dosage, "long", { locale: "th" })).toBe(thai);
    });
  }

  it("normalizes mixed-unit interval ranges instead of dropping the high bound", () => {
    const clause = parseSig("1 drop to od q 30 min - 2h prn pain").meta.canonical.clauses[0];
    expect(clause?.schedule).toMatchObject({ period: 30, periodMax: 120, periodUnit: "min" });
    expect(clause?.prn?.reasons?.[0]?.coding?.code).toBe("22253000");
  });

  it("keeps sequence markers outside body-site constituents", () => {
    const genital = parseSig("apply to external genital area then wash off thoroughly");
    expect(genital.fhir.site?.coding?.[0]?.code).toBe("362207005");
    expect(genital.meta.canonical.clauses[0]?.instructionGraph?.actions[0]).toMatchObject({
      predicate: { lemma: "rinse" },
      args: [expect.objectContaining({ role: AdviceArgumentRole.Manner, conceptId: "thoroughly" })]
    });

    const vaginal = parseSig("apply to outside of vagina then wash off thoroughly");
    expect(vaginal.meta.canonical.clauses[0]?.site?.spatialRelation).toMatchObject({
      relationText: "outside",
      targetCoding: { code: "76784001" }
    });
  });

  it("models result-state and procedural activity relations explicitly", () => {
    const wait = parseSig("insert under tongue then wait until dissolved");
    expect(wait.meta.canonical.clauses[0]?.site?.spatialRelation).toMatchObject({
      relationText: "under",
      targetCoding: { code: "21974007" }
    });
    expect(wait.meta.canonical.clauses[0]?.instructionGraph?.actions[0]).toMatchObject({
      predicate: { lemma: "wait" },
      relation: AdviceRelation.Until,
      args: [expect.objectContaining({ role: AdviceArgumentRole.Result, conceptId: "dissolved" })]
    });

    const before = parseSig("dissolve in water before drinking, may cause vomiting");
    const graph = before.meta.canonical.clauses[0]?.instructionGraph;
    expect(graph?.actions.map((action) => action.predicate.lemma)).toEqual(["dissolve"]);
    expect(graph?.actions[0]).toMatchObject({
      relation: AdviceRelation.In,
      args: expect.arrayContaining([
        expect.objectContaining({ role: AdviceArgumentRole.Substance, conceptId: "water" }),
        expect.objectContaining({
          role: AdviceArgumentRole.Activity,
          conceptId: "drinking-activity",
          relation: AdviceRelation.Before,
          text: "drinking"
        })
      ])
    });
    const reread = fromFhirDosage(before.fhir,{locale:"en"});
    expect(reread.meta.canonical.clauses[0]?.instructionGraph?.actions[0]).toMatchObject({
      relation: AdviceRelation.In,
      args: expect.arrayContaining([
        expect.objectContaining({ role: AdviceArgumentRole.Substance, conceptId: "water" }),
        expect.objectContaining({
          role: AdviceArgumentRole.Activity, conceptId: "drinking-activity",
          relation: AdviceRelation.Before
        })
      ])
    });
    // Drinking the prepared water is a typed positive consumption activity,
    // distinct from water-only mixing or mixing after an unrelated event.
    expect(before.fhir.additionalInstruction?.flatMap(row =>
      row.coding?.map(coding => coding.code) ?? [])).toContain("417995008");
    expect(before.meta.canonical.clauses[0]?.additionalInstructions?.[0]?.frames?.[0]?.args?.[0]?.coding?.code)
      .toBe("422400008");
  });

  it("composes laterality and typed site qualifiers over coded anatomy", () => {
    const armpit = parseSig("apply to right armpit").meta.canonical.clauses[0]?.site;
    expect(armpit?.spatialRelation).toMatchObject({
      relationText: "right side",
      relationCoding: { code: "49370004" },
      targetCoding: { code: "34797008" }
    });

    const flank = resolveBodySitePhrase("left flank at lesion");
    expect(flank?.features.qualifier).toMatchObject({
      kind: "site", relation: "at", targetCoding: { code: "95324001" }
    });
    const painful = resolveBodySitePhrase("below right knee where hurts");
    expect(painful?.features.qualifier).toMatchObject({
      kind: "symptom", relation: "where", coding: { code: "22253000" }
    });
  });

  it("preserves independent regimen timing and site-qualified PRN", () => {
    const parsed = parseSig("apply to below left knee before sleep and when itchy");
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause?.schedule?.when).toEqual([EventTiming["Before Sleep"]]);
    expect(clause?.site?.spatialRelation?.targetCoding?.code).toBe("82169009");
    expect(clause?.prn?.reasons?.[0]?.coding?.code).toContain("418363000:363698007=82169009");
  });

  it.each([
    [
      "apply 1 mL to scalp where there is hair loss",
      undefined,
      "41695006",
      "where there is hair loss",
      "hair loss"
    ],
    ["apply 1 mL to scalp where affected", undefined, "41695006", "where affected", "affected"],
    ["apply 1 mL to skin where there is rash", undefined, "181469002", "where there is rash", "rash"],
    ["apply 2 mL to right arm where irritated", undefined, "368209003", "where irritated", "irritat"],
    ["apply 1 mL to face where there is acne", undefined, "89545001", "where there is acne", "acne"],
    [
      "apply 1 mL to moob where affected",
      { siteCodeMap: CUSTOM_RELATIVE_SITE_MAP },
      "MOOB",
      "where affected",
      "affected"
    ]
  ] as const)("attaches the relative predicate in the raw HPSG sign: %s", (
    input, options, siteCode, restrictionSource, predicate
  ) => {
    const sign = parseClauseSign(input, options);
    const site = sign?.synsem.valence.site;

    expect(sign?.synsem.head.dose).toMatchObject({
      value: input.includes("2 mL") ? 2 : 1,
      unit: "mL"
    });
    expect(site?.coding?.code).toBe(siteCode);
    expectRestriction(site, restrictionSource, predicate, input);
    expect(sign?.synsem.head.schedule).toBeUndefined();
    expect(sign?.synsem.valence.prn).toBeUndefined();
    expectSiteHeadedRestrictionDerivation(sign);
  });

  it.each([
    {
      input: "apply 1 mL to moob where affected", code: "MOOB", dose: 1,
      restriction: "where affected", predicate: "affected", schedule: undefined
    },
    {
      input: "apply 2 mL to moob where there is hair loss", code: "MOOB", dose: 2,
      restriction: "where there is hair loss", predicate: "hair loss", schedule: undefined
    },
    {
      input: "apply 1 mL to donor area where irritated twice daily", code: "DONOR-AREA", dose: 1,
      restriction: "where irritated", predicate: "irritat",
      schedule: { frequency: 2, period: 1, periodUnit: "d" }
    },
    {
      input: "apply 1 mL to donor area where there is rash in the morning",
      code: "DONOR-AREA", dose: 1,
      restriction: "where there is rash", predicate: "rash", schedule: { when: ["MORN"] }
    },
    {
      input: "apply 1 mL to treatment field where affected at bedtime", code: "TREATMENT-FIELD", dose: 1,
      restriction: "where affected", predicate: "affected", schedule: { when: ["HS"] }
    },
    {
      input: "apply 2 mL to treatment field where dry", code: "TREATMENT-FIELD", dose: 2,
      restriction: "where dry", predicate: "dry", schedule: undefined
    }
  ] as const)("composes custom coded sites with relative predicates: $input", ({
    input, code, dose, restriction, predicate, schedule
  }) => {
    const parsed = parseSig(input, { siteCodeMap: CUSTOM_RELATIVE_SITE_MAP });
    const clause = parsed.meta.canonical.clauses[0];

    expect(clause?.dose).toEqual({ value: dose, unit: "mL" });
    expect(clause?.site?.coding).toMatchObject({
      system: "http://example.org/custom-sites", code
    });
    expectRestriction(clause?.site, restriction, predicate, input);
    if (schedule) expect(clause?.schedule).toMatchObject(schedule);
    else expect(clause?.schedule).toBeUndefined();
    expect(clause?.prn).toBeUndefined();
    expect(clause?.clinicalAdjuncts?.condition).toBeUndefined();
    expect(clause?.leftovers).toEqual([]);
    expect(parsed.fhir.site?.coding?.[0]).toMatchObject({
      system: "http://example.org/custom-sites", code
    });
    expect(parsed.fhir.asNeeded).not.toBe(true);
    const r6Component = parsed.dosageDetails.step[0]?.component[0];
    expect(r6Component?.site?.concept?.coding?.[0]).toMatchObject({
      system: "http://example.org/custom-sites", code
    });
    expect(r6Component?.site?.concept?.extension?.find(extension =>
      extension.url === BODY_SITE_RESTRICTION_EXTENSION_URL
    )?.extension).toEqual(expect.arrayContaining([
      { url: "relation", valueCode: "where" },
      { url: "sourceText", valueString: restriction }
    ]));
  });

  it.each([
    {
      input: "apply 1 mL to scalp where affected and face where there is acne twice daily",
      options: undefined,
      dose: 1,
      sites: [
        { code: "41695006", restriction: "where affected", predicate: "affected" },
        { code: "89545001", restriction: "where there is acne", predicate: "acne" }
      ],
      schedule: { frequency: 2, period: 1, periodUnit: "d" }
    },
    {
      input: "apply 2 mL to left forearm where itchy and right forearm where irritated in the morning",
      options: undefined,
      dose: 2,
      sites: [
        { code: "66480008", restriction: "where itchy", predicate: "itch" },
        { code: "64262003", restriction: "where irritated", predicate: "irritat" }
      ],
      schedule: { when: ["MORN"] }
    },
    {
      input: "apply 1 mL to left knee where painful and right knee where there is rash at bedtime",
      options: undefined,
      dose: 1,
      sites: [
        { code: "82169009", restriction: "where painful", predicate: "pain" },
        { code: "6757004", restriction: "where there is rash", predicate: "rash" }
      ],
      schedule: { when: ["HS"] }
    },
    {
      input: "apply 1 mL to moob where affected and goob where there is irritation twice daily",
      options: { siteCodeMap: CUSTOM_RELATIVE_SITE_MAP },
      dose: 1,
      sites: [
        { code: "MOOB", restriction: "where affected", predicate: "affected" },
        { code: "GOOB", restriction: "where there is irritation", predicate: "irritation" }
      ],
      schedule: { frequency: 2, period: 1, periodUnit: "d" }
    }
  ] as const)("keeps each coordinated site's restriction local: $input", ({
    input, options, dose, sites, schedule
  }) => {
    const parsed = parseSig(input, options);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.meta.leftoverText).toBeUndefined();

    parsed.items.forEach((item, index) => {
      const expected = sites[index]!;
      const clause = item.meta.canonical.clauses[0];
      expect(clause?.dose).toEqual({ value: dose, unit: "mL" });
      expect(clause?.site?.coding?.code).toBe(expected.code);
      expectRestriction(clause?.site, expected.restriction, expected.predicate, input);
      expect(clause?.schedule).toMatchObject(schedule);
      expect(clause?.prn).toBeUndefined();
      expect(clause?.clinicalAdjuncts?.condition).toBeUndefined();
      expect(item.fhir.site?.coding?.[0]?.code).toBe(expected.code);
      expect(item.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: dose, unit: "mL" });
      expect(item.fhir.asNeeded).not.toBe(true);
      expect(item.fhir.site?.extension?.find(extension =>
        extension.url === BODY_SITE_RESTRICTION_EXTENSION_URL
      )?.extension).toEqual(expect.arrayContaining([
        { url: "relation", valueCode: "where" },
        { url: "sourceText", valueString: expected.restriction },
        { url: "predicateText", valueString: expected.restriction.slice("where ".length) }
      ]));
    });
    const components = parsed.dosageDetails.step[0]?.component ?? [];
    expect(components.map(component =>
      component.site?.concept?.coding?.[0]?.code
    )).toEqual(sites.map(site => site.code));
    components.forEach((component, index) => {
      const expected = sites[index]!;
      expect(component.site?.concept?.extension?.find(extension =>
        extension.url === BODY_SITE_RESTRICTION_EXTENSION_URL
      )?.extension).toEqual(expect.arrayContaining([
        { url: "relation", valueCode: "where" },
        { url: "sourceText", valueString: expected.restriction },
        { url: "predicateText", valueString: expected.restriction.slice("where ".length) }
      ]));
    });
  });

  it("keeps site restriction, dose, cadence, and duration in separate semantic slots", () => {
    const input = "apply 2 mL to scalp where affected twice daily for 7 days";
    const parsed = parseSig(input);
    const clause = parsed.meta.canonical.clauses[0];

    expect(clause?.dose).toEqual({ value: 2, unit: "mL" });
    expect(clause?.site?.coding?.code).toBe("41695006");
    expectRestriction(clause?.site, "where affected", "affected", input);
    expect(clause?.schedule).toMatchObject({
      frequency: 2, period: 1, periodUnit: "d", duration: 7, durationUnit: "d"
    });
    expect(clause?.prn).toBeUndefined();
    expect(clause?.clinicalAdjuncts?.condition).toBeUndefined();
  });

  it("keeps a site restriction independent from an explicit PRN indication", () => {
    const input = "apply 1 mL to scalp where affected as needed for itching";
    const parsed = parseSig(input);
    const clause = parsed.meta.canonical.clauses[0];

    expect(clause?.dose).toEqual({ value: 1, unit: "mL" });
    expect(clause?.site?.coding?.code).toBe("41695006");
    expectRestriction(clause?.site, "where affected", "affected", input);
    expect(clause?.prn).toMatchObject({
      enabled: true,
      reasons: [expect.objectContaining({ text: expect.stringMatching(/itch/iu) })]
    });
    expect(parsed.fhir.asNeeded).toBe(true);
    expect(parsed.fhir.asNeededFor?.[0]?.text).toMatch(/itch/iu);
  });

  it("keeps a site restriction independent from a global medication condition", () => {
    const input = "apply 1 mL to scalp where affected twice daily only if BP > 160";
    const parsed = parseSig(input);
    const clause = parsed.meta.canonical.clauses[0];

    expect(clause?.dose).toEqual({ value: 1, unit: "mL" });
    expect(clause?.site?.coding?.code).toBe("41695006");
    expectRestriction(clause?.site, "where affected", "affected", input);
    expect(clause?.schedule).toMatchObject({ frequency: 2, period: 1, periodUnit: "d" });
    expect(clause?.prn).toBeUndefined();
    const expectedCondition = {
      kind: "measurement",
      name: "bp",
      operation: "gt",
      value: 160,
      text: "BP > 160"
    } as const;
    expect(clause?.clinicalAdjuncts?.condition).toEqual(expectedCondition);
    expect(getDosageCondition(parsed.fhir)).toEqual(expectedCondition);
  });
});


describe("one site-relative semantic authority", () => {
  it.each([
    ["below right knee where hurts", "where painful"],
    ["scalp where affected", "where affected"],
    ["scalp where there is hair loss", "where there is hair loss"]
  ])("shares predicate meaning between standalone and full-SIG parsing: %s", (site, realized) => {
    const standalone = resolveBodySitePhrase(site)!;
    const parsed = parseSig(`apply 1 mL to ${site} twice daily`);
    const actual = parsed.meta.canonical.clauses[0].site!;
    const expected = standalone.restrictions![0];
    expect(actual.coding?.code).toBe(standalone.coding?.code);
    expect(actual.restrictions?.[0].predicate).toMatchObject({
      text: expected.predicate.text, lemma: expected.predicate.lemma, form: expected.predicate.form,
      ...(expected.predicate.focusText ? { focusText: expected.predicate.focusText } : {})
    });
    expect(parsed.longText).toContain(realized);
    expect(standalone.englishObjectText).toContain(realized);
    expect(actual.restrictions).toHaveLength(1);
    expect(parsed.meta.canonical.clauses[0].schedule?.frequency).toBe(2);
  });
});


it("does not invent original-source offsets from normalized standalone anatomy text", () => {
  const standalone = resolveBodySitePhrase("SCALP   where   affected")!;
  expect(standalone.restrictions![0].range).toBeUndefined();
  expect(standalone.restrictions![0].predicate.range).toBeUndefined();
  const input = "apply 1 mL to SCALP   where   affected twice daily";
  const restriction = parseSig(input).meta.canonical.clauses[0].site!.restrictions![0];
  expect(input.slice(restriction.range!.start, restriction.range!.end)).toBe("where   affected");
  expect(input.slice(restriction.predicate.range!.start, restriction.predicate.range!.end)).toBe("affected");
});


describe("bilingual clinical argument ownership", () => {
  it.each([
    "Inject 5 U subcutaneously into abdomen or thigh",
    "ฉีด 5 ยูนิต ใต้ผิวหนัง ที่หน้าท้องหรือต้นขา",
    "ฉีด 5 U ใต้ผิวหนัง ที่หน้าท้อง หรือ ต้นขา"
  ])("retains two anatomical alternatives without duplicating the injection: %s", (input) => {
    const parsed = parseSig(input);
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.dose).toEqual({ value: 5, unit: "U" });
    expect(clause.route?.code).toBe("34206005");
    expect(clause.administrationTargetGroup).toMatchObject({
      coordination: "disjunction",
      targets: [
        { coding: { code: "302553009" } },
        { coding: { code: "68367000" } }
      ]
    });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.fhir.doseAndRate?.[0].doseQuantity).toMatchObject({ value: 5, unit: "U" });
  });

  it.each([
    "Apply 1 g to abdomen and thigh daily",
    "ทา 1 กรัม ที่หน้าท้องและต้นขา วันละครั้ง"
  ])("distinguishes conjunctive sites from alternatives in either language: %s", (input) => {
    const clause = parseSig(input).meta.canonical.clauses[0];
    expect(clause.dose).toEqual({ value: 1, unit: "g" });
    expect(clause.administrationTargetGroup).toMatchObject({
      coordination: "conjunction",
      targets: [
        { coding: { code: "302553009" } },
        { coding: { code: "68367000" } }
      ]
    });
    expect(clause.schedule).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
  });

  it.each([
    "Inject 5 U subcutaneously into abdomen or thigh, rotate sites each time",
    "ฉีด 5 ยูนิต ใต้ผิวหนัง ที่หน้าท้องหรือต้นขา สลับตำแหน่งทุกครั้ง"
  ])("keeps site rotation separate from the anatomical alternatives: %s", (input) => {
    const clause = parseSig(input).meta.canonical.clauses[0];
    expect(clause.administrationTargetGroup?.coordination).toBe("disjunction");
    expect(clause.administrationTargetGroup?.targets.map(site => site.coding?.code))
      .toEqual(["302553009", "68367000"]);
    expect(clause.instructionGraph?.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ predicate: expect.objectContaining({ lemma: "rotate" }) })
    ]));
    expect(clause.site?.text).not.toMatch(/rotate|สลับ|every|ทุก/iu);
    expect(clause.schedule?.count).toBeUndefined();
  });

  it.each([
    "Swish 10 mL for 1 minute then spit out. Do not swallow. Avoid food and water for 30 minutes",
    "กลั้วปาก 10 มล. 1 นาที แล้วบ้วนทิ้ง ห้ามกลืน และงดอาหารน้ำ 30 นาที",
    "กลั้วปาก 10 mL 1 นาที แล้วบ้วนทิ้ง งดอาหารและน้ำ 30 นาที"
  ])("attaches an avoidance interval to its action rather than to the medication course: %s", (input) => {
    const parsed = parseSig(input);
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.dose).toMatchObject({ value: 10, unit: "mL" });
    expect(clause.schedule?.duration).toBeUndefined();
    expect(clause.schedule?.when).toBeUndefined();
    expect(parsed.fhir.timing?.repeat?.boundsDuration).toBeUndefined();
    const avoid = clause.instructionGraph?.actions.find(action => action.predicate.lemma === "avoid");
    expect(avoid?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: AdviceArgumentRole.Duration,
        quantity: { value: 30, unit: "min" }
      })
    ]));
    expect(clause.instructionGraph?.actions.some(action => action.predicate.lemma === "spit"))
      .toBe(true);
  });

  it.each([
    "Take 1 tab daily at same time",
    "Take 1 tab daily at the same time"
  ])("does not interpret a temporal noun phrase as an anatomical target: %s", (input) => {
    const parsed = parseSig(input);
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.dose).toEqual({ value: 1, unit: "tab" });
    expect(clause.schedule).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
    expect(clause.site).toBeUndefined();
    expect(parsed.fhir.site).toBeUndefined();
  });
});


describe("bilingual site coordination realization", () => {
  it.each([
    "Inject 5 U subcutaneously into abdomen or thigh",
    "ฉีด 5 ยูนิต ใต้ผิวหนัง ที่หน้าท้องหรือต้นขา"
  ])("realizes typed alternatives in either output language: %s", (input) => {
    // An explicit locale requests the public FHIR translation extensions.
    const parsed = parseSig(input, { locale: "en" });
    const english = formatSig(parsed.fhir, "long", { locale: "en" });
    const thai = formatSig(parsed.fhir, "long", { locale: "th" });
    expect(english).toContain("abdomen or thigh");
    expect(english).not.toMatch(/[\u0e00-\u0e7f]/u);
    expect(thai).toMatch(/ท้อง.*หรือ.*ต้นขา/u);
    expect(thai).not.toMatch(/abdomen|thigh/iu);
    const group = parsed.meta.canonical.clauses[0].administrationTargetGroup;
    expect(group?.coordination).toBe("disjunction");
    expect(input.slice(group!.range!.start, group!.range!.end)).toBe(group!.sourceText);
  });
});


describe("nominal prohibition and recurring procedural adjuncts", () => {
  it("keeps coordinated food and drink as prohibited objects", () => {
    const parsed = parseSig("Avoid food and drink for 30 minutes");
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.route).toBeUndefined();
    expect(clause.schedule?.duration).toBeUndefined();
    expect(clause.instructionGraph?.actions.some(action =>
      action.predicate.lemma === "drink" && action.polarity !== "negate"
    )).not.toBe(true);
    const avoidance = clause.instructionGraph?.actions.find(action => action.predicate.lemma === "avoid");
    expect(avoidance?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "food and drink" }),
      expect.objectContaining({ role: AdviceArgumentRole.Duration, quantity: { value: 30, unit: "min" } })
    ]));
    expect(parsed.longText).not.toMatch(/then drink/iu);
  });

  it("continues to distinguish negated verb coordination from nominal coordination", () => {
    const parsed = parseSig("Avoid eating or drinking for 30 minutes");
    const actions = parsed.meta.canonical.clauses[0].instructionGraph?.actions;
    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ polarity: "negate", predicate: expect.objectContaining({ lemma: "eat-food" }) }),
      expect.objectContaining({ polarity: "negate", predicate: expect.objectContaining({ lemma: "drink" }) })
    ]));
    expect(parsed.fhir.timing?.repeat?.boundsDuration).toBeUndefined();
  });

  it.each(["งดอาหารและน้ำ 30 นาที", "งดอาหารน้ำ 30 นาที"])(
    "keeps the Thai nominal restriction readable in both languages: %s", (input) => {
      const parsed = parseSig(input, { locale: "th" });
      expect(parsed.longText).toContain("อาหาร");
      expect(parsed.longText).toContain("น้ำ");
      expect(parsed.longText).not.toMatch(/meal|water|food/iu);
      expect(formatSig(parsed.fhir, "long", { locale: "en" })).toContain("food and water");
      expect(parsed.fhir.timing?.repeat?.when).toBeUndefined();
    }
  );

  it.each([
    "Inject 5 U subcutaneously into abdomen or thigh, rotate sites every time",
    "Inject 5 U subcutaneously into abdomen or thigh, rotate sites each administration",
    "ฉีด 5 ยูนิต ใต้ผิวหนัง ที่หน้าท้องหรือต้นขา สลับตำแหน่งทุกครั้ง"
  ])("retains per-administration scope on the rotation procedure: %s", (input) => {
    const parsed = parseSig(input);
    const clause = parsed.meta.canonical.clauses[0];
    const rotate = clause.instructionGraph?.actions.find(action => action.predicate.lemma === "rotate");
    expect(rotate?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: AdviceArgumentRole.Time, conceptId: "each-administration" })
    ]));
    expect(clause.schedule?.count).toBeUndefined();
    expect(formatSig(parsed.fhir, "long", { locale: "en" })).toContain("each time");
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).toContain("ทุกครั้ง");
  });

  it("retains an ordinary positive drinking administration", () => {
    const parsed = parseSig("Drink 10 mL daily");
    expect(parsed.fhir.doseAndRate?.[0].doseQuantity).toMatchObject({ value: 10, unit: "mL" });
    expect(parsed.fhir.timing?.repeat).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
    expect(parsed.meta.canonical.clauses[0].route?.code).toBe("26643006");
  });
});


describe("independent avoidance directive scope", () => {
  it.each([
    "Do not swallow and avoid food and water for 30 minutes",
    "Do not swallow. Avoid food and water for 30 minutes",
    "ห้ามกลืน และงดอาหารน้ำ 30 นาที",
    "ห้ามกลืน. งดอาหารน้ำ 30 นาที"
  ])("retains the new avoidance directive after a prohibition: %s", (input) => {
    const parsed = parseSig(input, { locale: "en" });
    const reloaded = fromFhirDosage(parsed.fhir, { locale: "en" });
    for (const result of [parsed, reloaded]) {
      const clause = result.meta.canonical.clauses[0];
      const actions = clause.instructionGraph?.actions;
      const swallow = actions?.find(action => action.predicate.lemma === "swallow");
      const avoid = actions?.find(action => action.predicate.lemma === "avoid");
      expect(swallow?.polarity).toBe("negate");
      expect(swallow?.args.some(arg => arg.role === AdviceArgumentRole.Duration)).not.toBe(true);
      expect(avoid).toBeDefined();
      expect(avoid?.polarity).not.toBe("negate");
      expect(avoid?.args).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: AdviceArgumentRole.Duration, quantity: { value: 30, unit: "min" } })
      ]));
      expect(clause.schedule?.duration).toBeUndefined();
    }
    expect(formatSig(parsed.fhir, "long", { locale: "en" })).not.toMatch(/do not avoid/iu);
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).not.toMatch(/ห้ามงด/u);
  });
});


describe("procedure-relative recurring events and temporal noun phrases", () => {
  it.each([
    ["Rotate injection sites after each dose", AdviceRelation.After, "each-dose", "after each dose", "หลัง"],
    ["Rotate the site before each injection", AdviceRelation.Before, "each-injection", "before each injection", "ก่อน"],
    ["Rotate sites after every injection", AdviceRelation.After, "each-injection", "after each injection", "หลัง"],
    ["สลับตำแหน่งก่อนการฉีดยาแต่ละครั้ง", AdviceRelation.Before, "each-injection", "before each injection", "ก่อน"]
  ])("attaches the recurring event to the rotation: %s", (input, relation, conceptId, english, thai) => {
    const parsed = parseSig(input, { locale: "en" });
    for (const result of [parsed, fromFhirDosage(parsed.fhir, { locale: "en" })]) {
      const clause = result.meta.canonical.clauses[0];
      const rotate = clause.instructionGraph?.actions.find(action => action.predicate.lemma === "rotate");
      expect(rotate?.relation).toBe(relation);
      expect(rotate?.args).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: AdviceArgumentRole.Object, conceptId: "administration-site" }),
        expect.objectContaining({ role: AdviceArgumentRole.Time, conceptId })
      ]));
      expect(clause.dose?.value).toBeUndefined();
      expect(clause.schedule?.count).toBeUndefined();
      expect(clause.schedule?.frequency).toBeUndefined();
      expect(clause.schedule?.duration).toBeUndefined();
    }
    expect(formatSig(parsed.fhir, "long", { locale: "en" })).toContain(english);
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).toContain(thai);
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).not.toMatch(/each|dose|injection|site/iu);
  });

  it.each([
    ["Rinse syringe after each use", "rinse", "syringe", "กระบอกฉีดยา"],
    ["Wash applicator after each use", "wash", "applicator", "อุปกรณ์ทายา"]
  ])("reuses temporal event composition with another procedure: %s", (input, lemma, object, thaiObject) => {
    const parsed = parseSig(input, { locale: "en" });
    const action = parsed.meta.canonical.clauses[0].instructionGraph?.actions.find(frame => frame.predicate.lemma === lemma);
    expect(action?.relation).toBe(AdviceRelation.After);
    expect(action?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: AdviceArgumentRole.Object, conceptId: object }),
      expect.objectContaining({ role: AdviceArgumentRole.Time, conceptId: "each-use" })
    ]));
    expect(formatSig(parsed.fhir, "long", { locale: "en" })).toContain(object);
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).toContain(thaiObject);
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).not.toMatch(/each|use|syringe|applicator/iu);
  });

  it.each([
    "กินยา 1 เม็ด เวลาเดิมทุกวัน",
    "ใช้ยา 1 ครั้ง วันละครั้ง เวลาเดิม",
    "ทายา 1 กรัม เวลาเดิมทุกวัน"
  ])("distinguishes a habitual time noun from an anatomical site: %s", (input) => {
    const parsed = parseSig(input, { locale: "th" });
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.site).toBeUndefined();
    expect(clause.schedule).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
    expect(clause.schedule?.timeOfDay).toBeUndefined();
    expect(clause.schedule?.count).toBeUndefined();
    expect(parsed.longText).toContain("เวลาเดิม");
  });

  it("does not infer a daily frequency from an unresolved time reference alone", () => {
    const parsed = parseSig("กินยา 1 เม็ด เวลาเดิม", { locale: "th" });
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.site).toBeUndefined();
    expect(clause.schedule?.frequency).toBeUndefined();
    expect(clause.schedule?.timeOfDay).toBeUndefined();
    expect(parsed.longText).toContain("เวลาเดิม");
  });

  it("retains a same-area reference as a site rather than a time", () => {
    const parsed = parseSig("ทายา 1 กรัม บริเวณเดิมทุกวัน", { locale: "th" });
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.site?.text).toContain("เดิม");
    expect(clause.site?.coding?.code).toBeUndefined();
    expect(clause.schedule).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
    expect(parsed.longText).not.toContain("เวลาเดิม");
  });

  it("keeps an unintroduced numeric duration inside the nominal avoidance complement", () => {
    const parsed = parseSig("Avoid food and drink 30 minutes");
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.route).toBeUndefined();
    expect(clause.instructionGraph?.actions.some(action => action.predicate.lemma === "drink")).not.toBe(true);
    expect(clause.instructionGraph?.actions.find(action => action.predicate.lemma === "avoid")?.args)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ role: AdviceArgumentRole.Duration, quantity: { value: 30, unit: "min" } })
      ]));
  });

  it("retains a separately quantified drinking command", () => {
    const parsed = parseSig("Avoid food and drink 10 mL");
    const clause = parsed.meta.canonical.clauses[0];
    // The positive administration is projected into canonical dose/route;
    // the instruction graph retains the separate avoidance procedure.
    expect(clause.dose).toMatchObject({ value: 10, unit: "mL" });
    expect(clause.route?.code).toBe("26643006");
    expect(parsed.longText).toMatch(/drink 10 mL/iu);
    expect(parsed.longText).not.toMatch(/do not drink/iu);
  });
});


describe("typed avoidance complements and Thai lexical selection", () => {
  it.each([
    "Apply 1 g to the cheek and avoid eyes and lips",
    "Avoid eyes and lips and apply 1 g to the cheek"
  ])("keeps the application site separate from coordinated avoided sites: %s", (input) => {
    const parsed = parseSig(input, { locale: "en" });
    for (const result of [parsed, fromFhirDosage(parsed.fhir, { locale: "en" })]) {
      expect(result.meta.canonical.clauses).toHaveLength(1);
      const clause = result.meta.canonical.clauses[0];
      expect(clause.dose).toMatchObject({ value: 1, unit: "g" });
      expect(clause.site?.coding?.code).toBe("60819002");
      expect(clause.administrationTargetGroup).toBeUndefined();
      const avoid = clause.instructionGraph?.actions.find(action => action.predicate.lemma === "avoid");
      expect(avoid?.polarity).not.toBe("negate");
      expect(avoid?.args).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: AdviceArgumentRole.Site,
          i18n: expect.objectContaining({ th: "ตาและริมฝีปาก" })
        })
      ]));
    }
    expect(formatSig(parsed.fhir, "long", { locale: "th" }))
      .toContain("หลีกเลี่ยงบริเวณตาและริมฝีปาก");
    expect(parsed.meta.canonical.clauses[0].leftovers).toEqual([]);
  });

  it.each([
    "Avoid eyes and lips for 30 minutes",
    "หลีกเลี่ยงตาและริมฝีปาก 30 นาที"
  ])("retains an avoidance duration across locale selection and FHIR: %s", (input) => {
    const parsed = parseSig(input, { locale: "en" });
    for (const result of [parsed, fromFhirDosage(parsed.fhir, { locale: "en" })]) {
      const clause = result.meta.canonical.clauses[0];
      const avoid = clause.instructionGraph?.actions.find(action => action.predicate.lemma === "avoid");
      expect(avoid?.args).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: AdviceArgumentRole.Site }),
        expect.objectContaining({
          role: AdviceArgumentRole.Duration, quantity: { value: 30, unit: "min" }
        })
      ]));
      expect(clause.site).toBeUndefined();
      expect(clause.route).toBeUndefined();
      expect(clause.schedule?.duration).toBeUndefined();
    }
    const thai = formatSig(parsed.fhir, "long", { locale: "th" });
    expect(thai).toContain("หลีกเลี่ยงบริเวณตาและริมฝีปาก");
    expect(thai).toContain("30 นาที");
    expect(thai).not.toMatch(/[A-Za-z]/u);
  });

  it("keeps a repeated administration head with water as advice when there is no product complement", () => {
    const parsed = parseSig("Take 1 tablet daily; take with water", { locale: "en" });
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.dose).toMatchObject({ value: 1, unit: "tab" });
    expect(clause.schedule).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
    expect(parsed.longText).toContain("Take with water");
    expect(parsed.longText).not.toMatch(/plenty of water/i);
    const hydrationCodes = parsed.fhir.additionalInstruction?.flatMap((entry) =>
      entry.coding?.map((coding) => coding.code) ?? []) ?? [];
    expect(hydrationCodes).not.toContain("419303009");
    expect(clause.additionalInstructions?.some((instruction) =>
      instruction.frames?.some((frame) => frame.args.some((arg) =>
        arg.role === AdviceArgumentRole.Substance && arg.conceptId === "water"
      ))
    )).toBe(true);
    expect(clause.leftovers).toEqual([]);
  });
});

describe("bilingual clinical compositional semantic torture", () => {
  it("retains rinse volume and duration ahead of a meal-scoped spit action", () => {
    const source = "Rinse mouth with 10 mL for 1 minute then spit after meals";
    const parsed = parseSig(source, {locale:"en"});
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.dose).toMatchObject({value:10,unit:"mL"});
    expect(clause.instructionGraph?.actions.map(a=>a.predicate.lemma)).toEqual(["rinse_mouth","spit"]);
    expect(clause.instructionGraph?.actions[0].args).toEqual(expect.arrayContaining([
      expect.objectContaining({role:AdviceArgumentRole.Duration, quantity:{value:1,unit:"min"}})
    ]));
    for (const result of [parsed,fromFhirDosage(parsed.fhir,{locale:"en"})]) {
      expect(result.meta.canonical.clauses[0].dose).toMatchObject({value:10,unit:"mL"});
    }
    const en=formatSig(parsed.fhir,"long",{locale:"en"});
    const th=formatSig(parsed.fhir,"long",{locale:"th"});
    expect(en).toMatch(/rinse.*10 mL.*1 minute/i);
    expect(en).toMatch(/spit.*after/i);
    expect(th).toContain("10 มิลลิลิตร");
    expect(th).toContain("บ้วนทิ้ง");
  });

  it("preserves two separately negated meal restrictions after the measured swish", () => {
    const source="Measure 10 mL, swish vigorously for 1 minute then spit out; do not swallow; do not eat or drink for 30 minutes";
    const parsed=parseSig(source,{locale:"en"});
    const c=parsed.meta.canonical.clauses[0];
    expect(c.dose).toMatchObject({value:10,unit:"mL"});
    for(const lemma of ["swallow","eat-food","drink"]) {
      const a=c.instructionGraph?.actions.find(x=>x.predicate.lemma===lemma);
      expect(a?.polarity).toBe("negate");
      if(lemma!=="swallow") expect(a?.args).toEqual(expect.arrayContaining([
        expect.objectContaining({role:AdviceArgumentRole.Duration,quantity:{value:30,unit:"min"}})
      ]));
    }
    const en=formatSig(parsed.fhir,"long",{locale:"en"});
    const th=formatSig(parsed.fhir,"long",{locale:"th"});
    expect(en).toMatch(/do not eat/i);
    expect(en).toMatch(/do not drink/i);
    expect(en).toMatch(/30 minutes/);
    expect(th).toMatch(/ห้าม.*อาหาร/);
    expect(th).toMatch(/ห้ามดื่ม/);
  });
});

describe("temporal object and preparation valence", () => {
  it("keeps food, drink and other medicines as targets of waiting, not positive drinking", () => {
    const source="Take 1 tablet on empty stomach with water; wait 30 minutes before food, drink, or other meds";
    const parsed=parseSig(source,{locale:"en"});
    const clause=parsed.meta.canonical.clauses[0];
    expect(clause.dose).toMatchObject({value:1,unit:"tab"});
    expect(clause.route?.code).toBe("26643006");
    expect(clause.instructionGraph?.actions.some(a=>a.predicate.lemma==="drink")).not.toBe(true);
    const wait=clause.instructionGraph?.actions.find(a=>a.predicate.lemma==="wait");
    expect(wait?.relation).toBe(AdviceRelation.Before);
    expect(wait?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({role:AdviceArgumentRole.Duration, quantity:{value:30,unit:"min"}}),
      expect.objectContaining({span:{start:source.indexOf("food"),end:source.length}})
    ]));
    expect(clause.schedule?.duration).toBeUndefined();
    const en=formatSig(parsed.fhir,"long",{locale:"en"});
    const th=formatSig(parsed.fhir,"long",{locale:"th"});
    expect(en).toMatch(/before.*food.*drink.*other med/i);
    expect(th).not.toMatch(/จากนั้นดื่ม/);
    expect(th).toMatch(/30 นาที/);
    expect(th).toMatch(/อาหาร/);
  });

  it("keeps wiping agent and drying step separate from a subcutaneous injection", () => {
    const source="Wipe skin with alcohol and let dry, pinch skin, inject 0.25 mg subcutaneously, keep needle in 6 seconds";
    const parsed=parseSig(source,{locale:"en"});
    const clause=parsed.meta.canonical.clauses[0];
    expect(clause.dose).toMatchObject({value:0.25,unit:"mg"});
    expect(clause.route?.code).toBe("34206005");
    const wipe=clause.instructionGraph?.actions.find(a=>a.predicate.lemma==="wipe");
    expect(wipe?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({role:AdviceArgumentRole.Site,conceptId:"skin"}),
      expect.objectContaining({text:expect.stringMatching(/alcohol/i)})
    ]));
    expect(wipe?.args.some(a=>/and let/i.test(a.text))).not.toBe(true);
    expect(clause.instructionGraph?.actions.some(a=>a.predicate.lemma==="dry")).toBe(true);
    const en=formatSig(parsed.fhir,"long",{locale:"en"});
    const th=formatSig(parsed.fhir,"long",{locale:"th"});
    expect(en).toMatch(/wipe.*skin.*alcohol/i);
    expect(en).toMatch(/dry/i);
    expect(en).not.toMatch(/alcohol and let/i);
    expect(th).not.toMatch(/and let/i);
    expect(th).toMatch(/ฉีด/);
  });
});

describe("composed clinical SNOMED polarity entailment", () => {
  const codes = (input: string): { parsed: ReturnType<typeof parseSig>, values: string[] } => {
    const parsed = parseSig(input, { locale: "en" });
    const values = parsed.fhir.additionalInstruction?.flatMap((instruction) =>
      instruction.coding?.map((coding) => coding.code ?? "") ?? []) ?? [];
    return { parsed, values };
  };
  it.each([
    ["Swallow tablets whole, do not chew", undefined],
    ["Swallow 2 tablets whole; do not chew", 2],
    ["Do not crush or chew extended-release tablets; swallow whole", undefined]
  ])("codes swallowed-whole-and-not-chewed only on jointly entailed meaning: %s", (text, quantity) => {
    const { parsed, values } = codes(text);
    expect(values).toContain("418693002");
    expect(values).not.toContain("418991002");
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(quantity);
    const recovered = fromFhirDosage(parsed.fhir, { locale: "en" });
    const frames = recovered.meta.canonical.clauses[0]?.instructionGraph?.actions ?? [];
    expect(frames.some((frame) =>
      frame.predicate.lemma === "chew" && frame.polarity === "negate"
    )).toBe(true);
    expect(formatSig(parsed.fhir, "long", { locale: "en" })).not.toMatch(/suck or chew before swallowing/i);
  });

  it.each([
    "Do not crush or chew extended-release tablets",
    "Do not chew these tablets",
    "Swallow tablets whole; chew the other tablets",
    "Chew one tablet and swallow",
    "Swallow capsule A whole; do not chew tablet B",
    "Swallow the first capsule whole; do not chew the second tablet",
    "Swallow this medication whole; do not chew the other medication",
    "Swallow tablets whole, do not chew gum"
  ])("never assigns the swallowed-whole negative-chew code without compatible joint scope: %s", (text) => {
    const { values } = codes(text);
    expect(values).not.toContain("418693002");
  });

  it("permits a combined code when explicitly repeated referents are the same", () => {
    const { parsed, values } = codes("Swallow tablet A whole; do not chew tablet A");
    expect(values).toContain("418693002");
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity?.value).toBeUndefined();
  });

  it.each([
    "Do not crush or chew extended-release tablets",
    "Do not chew these tablets",
    "Swallow tablets whole, do not chew"
  ])("never assigns a positive chew code to a negated chewing predicate: %s", (text) => {
    const { values } = codes(text);
    expect(values).not.toContain("418991002");
  });
});

describe("Thai whole-medication manner, polarity and referent identity", () => {
  it.each([
    ["กลืนยาเม็ดทั้งเม็ด ห้ามเคี้ยว", true],
    ["กลืนยาเม็ด A ทั้งเม็ด ห้ามเคี้ยวยาเม็ด B", false],
    ["กลืนยาเม็ด A ทั้งเม็ด ห้ามเคี้ยวยาเม็ด A", true],
    ["ห้ามเคี้ยวยาเม็ด แล้วกลืนทั้งเม็ด", true],
    ["ห้ามเคี้ยวยาเม็ด", false]
  ])("preserves composed clinical meaning and conditional SNOMED: %s", (text, codeExpected) => {
    const parsed = parseSig(text, { locale: "th" });
    const values = parsed.fhir.additionalInstruction?.flatMap((instruction) =>
      instruction.coding?.map((coding) => coding.code ?? "") ?? []) ?? [];
    expect(values.includes("418693002")).toBe(codeExpected);
    expect(values).not.toContain("418991002");
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity?.value).toBeUndefined();
    const recovered = fromFhirDosage(parsed.fhir, { locale: "th" });
    expect(recovered.meta.canonical.clauses[0].dose?.value).toBeUndefined();
    const thai = formatSig(parsed.fhir, "long", { locale: "th" });
    expect(thai).toContain("ห้ามเคี้ยว");
    if (codeExpected) {
      expect(thai).toContain("ทั้งเม็ด");
      const english = formatSig(parsed.fhir, "long", { locale: "en" });
      expect(english).toMatch(/swallow.*whole/i);
    }
  });
});

describe("coordinated prohibition scope across lists and sequence boundaries", () => {
  it("keeps all three prohibitions negative while preserving the sublingual dose and wait", () => {
    const source="Place 2 tablets under tongue and let dissolve; do not crush, chew, or swallow; wait 5 min before drinking";
    const parsed=parseSig(source, { locale:"en" });
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(2);
    for(const result of [parsed,fromFhirDosage(parsed.fhir,{locale:"en"})]){
      const actions=result.meta.canonical.clauses[0].instructionGraph?.actions??[];
      for(const lemma of ["crush","chew","swallow"]) {
        expect(actions.find(action=>action.predicate.lemma===lemma)?.polarity).toBe("negate");
      }
      expect(actions.find(action=>action.predicate.lemma==="wait")?.polarity).not.toBe("negate");
      expect(result.meta.canonical.clauses[0].schedule?.duration).toBeUndefined();
    }
    const codes=parsed.fhir.additionalInstruction?.flatMap(x=>x.coding?.map(y=>y.code)??[])??[];
    expect(codes).not.toContain("418991002");
    const en=formatSig(parsed.fhir,"long",{locale:"en"});
    const th=formatSig(parsed.fhir,"long",{locale:"th"});
    expect(en).toMatch(/do not chew/i);
    expect(en).toMatch(/do not swallow/i);
    expect(th).toMatch(/ห้ามเคี้ยว/);
    expect(th).toMatch(/ห้ามกลืน/);
  });

  it.each([
    "Do not chew, crush, or swallow these tablets",
    "Do not chew or crush the tablets",
    "ห้ามบด, เคี้ยว หรือกลืนยาเม็ด"
  ])("composes multi-member prohibitions rather than positive imperatives: %s", (source) => {
    const parsed=parseSig(source, {locale:/[\u0E00-\u0E7F]/u.test(source)?"th":"en"});
    const actions=parsed.meta.canonical.clauses[0].instructionGraph?.actions??[];
    for(const lemma of source.startsWith("Do not chew or")?["chew","crush"]:
      /[\u0E00-\u0E7F]/u.test(source)?["crush","chew","swallow"]:["chew","crush","swallow"]){
      expect(actions.find(action=>action.predicate.lemma===lemma)?.polarity).toBe("negate");
    }
    const codes=parsed.fhir.additionalInstruction?.flatMap(x=>x.coding?.map(y=>y.code)??[])??[];
    expect(codes).not.toContain("418991002");
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity?.value).toBeUndefined();
  });

  it.each([
    ["Do not crush; chew one tablet after a meal","chew"],
    ["Do not crush, then swallow a tablet whole","swallow"]
  ])("keeps a new explicitly sequenced command outside preceding negation: %s", (source, lemma) => {
    const parsed=parseSig(source,{locale:"en"});
    const actions=parsed.meta.canonical.clauses[0].instructionGraph?.actions??[];
    expect(actions.find(x=>x.predicate.lemma==="crush")?.polarity).toBe("negate");
    expect(actions.find(x=>x.predicate.lemma===lemma)?.polarity).not.toBe("negate");
  });
});

describe("negated procedural complements of typed WITHOUT relation", () => {
  it.each([
    ["Swallow two tablets whole without chewing", "chew", 2],
    ["Swallow tablets whole without chewing", "chew", undefined],
    ["Place 2 tablets under tongue without swallowing", "swallow", 2]
  ])("preserves subordinate negative action and dose: %s", (source, negatedAction, dose) => {
    const parsed = parseSig(source,{locale:"en"});
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.dose?.value).toBe(dose);
    for(const result of [parsed,fromFhirDosage(parsed.fhir,{locale:"en"})]){
      const actions=result.meta.canonical.clauses[0].instructionGraph?.actions ?? [];
      const neg=actions.find(a=>a.predicate.lemma===negatedAction);
      expect(neg?.polarity).toBe("negate");
    }
    expect(formatSig(parsed.fhir,"long",{locale:"en"})).toMatch(new RegExp("do not "+negatedAction,"i"));
  });
  it("uses shared typed swallow-whole/negative-chew advice code without a positive-chew code", () => {
    const p=parseSig("Swallow two tablets whole without chewing");
    const codings=p.fhir.additionalInstruction?.flatMap(a=>a.coding?.map(c=>c.code)??[])??[];
    expect(codings).toContain("418693002");
    expect(codings).not.toContain("418991002");
  });
  it("does not fabricate prohibition when an actual positive chewing action starts a new clause", () => {
    const p=parseSig("Swallow tablets whole; chew one tablet after dinner");
    expect(p.meta.canonical.clauses[0].instructionGraph?.actions.find(a=>a.predicate.lemma==="chew")?.polarity).not.toBe("negate");
    const codes=p.fhir.additionalInstruction?.flatMap(a=>a.coding?.map(c=>c.code)??[])??[];
    expect(codes).not.toContain("418693002");
  });
});

describe("shared prohibition duration with event-relative anchoring", () => {
  it("retains prohibition, 30-minute duration and placement anchor for two coordinated actions", () => {
    const source="Do not swallow or spit for 30 minutes after placing the tablet under your tongue";
    const parsed=parseSig(source,{locale:"en"});
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity?.value).toBeUndefined();
    for(const result of [parsed,fromFhirDosage(parsed.fhir,{locale:"en"})]){
      const actions=result.meta.canonical.clauses[0].instructionGraph?.actions??[];
      for(const lemma of ["swallow","spit"]){
        const action=actions.find(x=>x.predicate.lemma===lemma);
        expect(action?.polarity).toBe("negate");
        expect(action?.args).toEqual(expect.arrayContaining([
          expect.objectContaining({role:AdviceArgumentRole.Duration,quantity:{value:30,unit:"min"}})
        ]));
      }
      const spit=actions.find(x=>x.predicate.lemma==="spit");
      expect(spit?.relation).toBe(AdviceRelation.After);
      expect(spit?.args).toEqual(expect.arrayContaining([
        expect.objectContaining({role:AdviceArgumentRole.Activity,text:expect.stringMatching(/placing.*tablet.*tongue/i)})
      ]));
      expect(result.meta.canonical.clauses[0].schedule?.duration).toBeUndefined();
    }
    const en=formatSig(parsed.fhir,"long",{locale:"en"});
    expect(en).toMatch(/do not swallow.*30 minutes/i);
    expect(en).toMatch(/do not spit.*30 minutes after placing/i);
    const th=formatSig(parsed.fhir,"long",{locale:"th"});
    expect(th).toMatch(/ห้ามกลืน.*30 นาที/);
    expect(th).toMatch(/ห้ามบ้วนทิ้ง.*30 นาทีหลัง/);
  });
});

describe("hydration counseling as an auxiliary action rather than a medication dose", () => {
  it.each([
    "Drink plenty of water",
    "ดื่มน้ำตามมากๆ",
    "ดื่มน้ำตามมาก ๆ",
    "ดื่มน้ำเยอะๆ"
  ])("structures plentiful-water counseling without inventing medication administration: %s", (source) => {
    const locale = /[\u0e00-\u0e7f]/u.test(source) ? "th" : "en";
    const parsed=parseSig(source,{locale});
    const clause=parsed.meta.canonical.clauses[0];
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toBeUndefined();
    expect(parsed.fhir.method).toBeUndefined();
    expect(parsed.fhir.route).toBeUndefined();
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(clause.instructionGraph?.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        predicate:expect.objectContaining({lemma:"drink"}),
        args:expect.arrayContaining([
          expect.objectContaining({role:AdviceArgumentRole.Substance,conceptId:"plenty-of-water"})
        ])
      })
    ]));
    expect(parsed.fhir.additionalInstruction?.flatMap(x=>x.coding?.map(y=>y.code)??[]))
      .toContain("419303009");
    const loaded=fromFhirDosage(parsed.fhir,{locale});
    expect(loaded.meta.canonical.clauses[0].instructionGraph?.actions.some(a=>
      a.predicate.lemma==="drink" && a.args.some(b=>b.conceptId==="plenty-of-water")
    )).toBe(true);
    const en=formatSig(parsed.fhir,"long",{locale:"en"});
    const th=formatSig(parsed.fhir,"long",{locale:"th"});
    expect(en).toMatch(/drink plenty of water/i);
    expect(th).toMatch(/ดื่ม.*น้ำ/);
  });

  it("keeps the actual oral medication dose and hydrated accompaniment distinct in Thai",()=>{
    const parsed=parseSig("รับประทานยา 1 เม็ด พร้อมน้ำมากๆ",{locale:"th"});
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({value:1,unit:"tab"});
    expect(parsed.fhir.route?.coding?.[0]?.code).toBe("26643006");
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.fhir.additionalInstruction?.flatMap(x=>x.coding?.map(y=>y.code)??[]))
      .toContain("419303009");
    expect(formatSig(parsed.fhir,"long",{locale:"en"})).toMatch(/plenty of water/i);
    expect(formatSig(parsed.fhir,"long",{locale:"th"})).toMatch(/น้ำ.*มาก/);
  });

  it("keeps a Thai water prohibition negated and never codes affirmative hydration",()=>{
    const parsed=parseSig("ห้ามดื่มน้ำ 30 นาที",{locale:"th"});
    expect(parsed.fhir.additionalInstruction?.flatMap(x=>x.coding?.map(y=>y.code)??[]))
      .not.toContain("419303009");
    expect(parsed.meta.canonical.clauses[0].instructionGraph?.actions.some(a=>
      a.predicate.lemma==="drink" && a.polarity==="negate"
    )).toBe(true);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity?.value).toBeUndefined();
  });
});

describe("reconstitution advice requires affirmative material and temporal entailment",()=>{
  const code="417995008";
  const codings=(source:string):string[]=>{
    const parsed=parseSig(source,{locale:"en"});
    return parsed.fhir.additionalInstruction?.flatMap(i=>i.coding?.map(c=>c.code)??[])??[];
  };
  it.each([
    "Do not mix powder with water before taking",
    "Do not dissolve tablet in water before taking",
    "Mix powder without water",
    "Mix powder with water",
    "Mix powder with water after taking",
    "Dissolve tablet in water after taking"
  ])("must not emit positive BEFORE-taking reconstitution code unless entailed: %s",source=>{
    const parsed=parseSig(source,{locale:"en"});
    expect(codings(source)).not.toContain(code);
    const action=parsed.meta.canonical.clauses[0].instructionGraph?.actions.find(a=>
      ["mix","dissolve"].includes(a.predicate.lemma)
    );
    if(source.startsWith("Do not")) expect(action?.polarity).toBe("negate");
    expect(formatSig(parsed.fhir,"long",{locale:"en"})).not.toMatch(/Dissolve or mix with water before taking/iu);
  });
  it("preserves WITHOUT as a negative material relation instead of WITH plus affirmative code",()=>{
    const parsed=parseSig("Mix powder without water",{locale:"en"});
    const mix=parsed.meta.canonical.clauses[0].instructionGraph?.actions.find(a=>a.predicate.lemma==="mix");
    expect(mix?.relation).toBe(AdviceRelation.Without);
    expect(mix?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({role:AdviceArgumentRole.Substance,conceptId:"water"})
    ]));
    expect(codings("Mix powder without water")).not.toContain(code);
    const en=formatSig(parsed.fhir,"long",{locale:"en"});
    expect(en).toMatch(/mix.*powder without water/iu);
    expect(en).not.toMatch(/without with water/iu);
  });
  it("does not put a tablet-sized amount on the water when dissolving tablets", () => {
    const parsed = parseSig("Dissolve 1 tablet in water", { locale: "en" });
    expect(parsed.longText).toBe("Dissolve 1 tablet in water.");
    expect(parsed.meta.canonical.clauses[0]?.instructionGraph?.actions[0]?.predicate.lemma).toBe("dissolve");
    const measuredWater = parseSig("Dissolve 2 tablets in 30 mL water", { locale: "en" });
    expect(measuredWater.longText).toBe("Dissolve 2 tablets in 30 mL water.");
  });

  it("does not duplicate a dose onto the mixing water in Thai", () => {
    const input = "ละลายยา 1 เม็ดในน้ำ";
    const parsed = parseSig(input, { locale: "th" });
    expect(parsed.longText).toContain("น้ำ");
    expect(parsed.longText).not.toMatch(/น้ำ\s*1\s*เม็ด/u);
    expect((parsed.longText.match(/1\s*เม็ด/gu) ?? [])).toHaveLength(1);
    expect(parsed.input).toBe(input);
  });

  it.each([
    ["Dissolve in water before drinking", "dissolve"],
    ["Dissolve tablet in water before drinking", "dissolve"],
    ["Mix powder with water before drinking", "mix"]
  ] as const)("codes affirmative water reconstitution before the drinking event: %s", (source, verb) => {
    const parsed = parseSig(source, { locale: "en" });
    const dosage = parsed.fhir;
    const action = parsed.meta.canonical.clauses[0].instructionGraph?.actions.find(a =>
      a.predicate.lemma === verb);
    expect(action).toBeDefined();
    expect(action?.polarity).not.toBe("negate");
    expect(action?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: AdviceArgumentRole.Substance, conceptId: "water" }),
      expect.objectContaining({
        role: AdviceArgumentRole.Activity,
        conceptId: "drinking-activity",
        relation: AdviceRelation.Before
      })
    ]));
    const strict = toFhirR5Dosages(parsed.fhirNext)[0];
    const imported = fromFhirDosage(strict, { locale: "en" });
    for (const row of [dosage, strict, imported.fhir]) {
      expect(row.additionalInstruction?.flatMap(value => value.coding ?? []) ?? [])
        .toContainEqual(expect.objectContaining({
          system: "http://snomed.info/sct", code
        }));
    }
    expect(imported.meta.canonical.clauses[0]?.instructionGraph?.actions[0]?.args)
      .toEqual(expect.arrayContaining([expect.objectContaining({
        role: AdviceArgumentRole.Activity, conceptId: "drinking-activity",
        relation: AdviceRelation.Before
      })]));
    expect(parsed.fhir.text?.toLowerCase()).toContain("before drinking");
  });

  it.each([
    "Dissolve in water",
    "Mix powder with water",
    "Dissolve in water after drinking",
    "Mix powder without water before drinking",
    "Do not dissolve tablet in water before drinking"
  ])("never invents affirmative reconstitution for missing/reversed temporal or material evidence: %s", source => {
    const parsed = parseSig(source, { locale: "en" });
    const strict = toFhirR5Dosages(parsed.fhirNext)[0];
    const imported = fromFhirDosage(strict, { locale: "en" });
    for (const row of [parsed.fhir, strict, imported.fhir]) {
      expect(row.additionalInstruction?.flatMap(value => value.coding ?? [])
        .some(coding => coding.code === code)).not.toBe(true);
    }
  });

  it.each([
    "Mix powder with water before taking",
    "Dissolve tablet in water before taking"
  ])("codes only genuinely composed positive water-preparation before medication: %s",source=>{
    const parsed=parseSig(source,{locale:"en"});
    expect(codings(source)).toContain(code);
    expect(parsed.meta.canonical.clauses[0].instructionGraph?.actions[0]?.polarity).not.toBe("negate");
    const restored=fromFhirDosage(parsed.fhir,{locale:"en"});
    expect(restored.fhir.additionalInstruction?.flatMap(i=>i.coding?.map(c=>c.code)??[])).toContain(code);
  });
});

describe("application-action result versus site/manner valence", () => {
  it.each([
    ["Rub thinly on painful rash", "thinly", "painful rash"],
    ["Rub gently on affected rash", "gently", "affected rash"],
    ["ถูบางๆ บริเวณผื่นที่ปวด", "thinly", "บริเวณผื่นที่ปวด"]
  ])("uses typed manner + site rather than fabricating a result state: %s", (source, manner, site) => {
    const locale=/[\u0e00-\u0e7f]/u.test(source)?"th":"en";
    const parsed=parseSig(source,{locale});
    const clause=parsed.meta.canonical.clauses[0];
    const action=clause.instructionGraph?.actions.find(a=>a.predicate.lemma==="rub");
    expect(action).toBeDefined();
    expect(action?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({role:AdviceArgumentRole.Manner,normalized:manner}),
      expect.objectContaining({role:AdviceArgumentRole.Site,text:site})
    ]));
    expect(action?.args.some(a=>a.role===AdviceArgumentRole.Result)).toBe(false);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toBeUndefined();
    const reread=fromFhirDosage(parsed.fhir,{locale});
    expect(reread.meta.canonical.clauses[0].instructionGraph?.actions.find(a=>
      a.predicate.lemma==="rub"
    )?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({role:AdviceArgumentRole.Manner,normalized:manner}),
      expect.objectContaining({role:AdviceArgumentRole.Site,text:site})
    ]));
    const en=formatSig(parsed.fhir,"long",{locale:"en"});
    expect(en).toMatch(/rub (thinly|gently)/i);
    expect(en).not.toMatch(/to form (thinly|gently)/i);
    const th=formatSig(parsed.fhir,"long",{locale:"th"});
    expect(th).not.toMatch(/ให้เกิด(?:thinly|gently)/i);
    if(locale==="th")expect(th).toMatch(/ถูบาง/);
  });

  it.each(["Rub to form foam","Rub until foam forms"])("preserves true RESULT versus topical MANNER: %s",(source)=>{
    const parsed=parseSig(source);
    const rub=parsed.meta.canonical.clauses[0].instructionGraph?.actions.find(a=>a.predicate.lemma==="rub");
    expect(rub?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({role:AdviceArgumentRole.Result,conceptId:"foam"})
    ]));
    expect(rub?.args.some(a=>a.role===AdviceArgumentRole.Site)).toBe(false);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toBeUndefined();
    const en=formatSig(parsed.fhir,"long",{locale:"en"});
    expect(en).toMatch(/rub (to form|until) foam/i);
  });
});

describe("typed avoided skin qualifiers rather than positive site or untranslated object", () => {
  it.each([
    ["Avoid broken skin", "en"],
    ["Avoid damaged skin", "en"],
    ["หลีกเลี่ยงบริเวณผิวหนังที่มีแผล", "th"]
  ])("preserves negative anatomical target semantics through strict R5 and bilingual output: %s", (input, locale) => {
    const parsed = parseSig(input, {locale});
    for (const result of [parsed, fromFhirDosage(parsed.fhir, {locale})]) {
      const clause=result.meta.canonical.clauses[0];
      const avoided=clause.instructionGraph?.actions.find(a=>a.predicate.lemma==="avoid");
      expect(avoided).toBeDefined();
      expect(avoided?.args).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role:AdviceArgumentRole.Site,
          conceptId:"broken-skin",
          i18n:expect.objectContaining({ th:"ผิวหนังที่มีแผล" })
        })
      ]));
      expect(clause.site).toBeUndefined();
      expect(clause.route).toBeUndefined();
      expect(clause.dose).toBeUndefined();
    }
    expect(formatSig(parsed.fhir,"long",{locale:"th"}))
      .toContain("หลีกเลี่ยงบริเวณผิวหนังที่มีแผล");
    expect(formatSig(parsed.fhir,"long",{locale:"en"})).toMatch(/avoid broken skin/i);
    expect(parsed.meta.canonical.clauses[0].leftovers).toEqual([]);
  });

  it("does not confuse the avoided skin with the actual application target",()=>{
    const parsed=parseSig("Apply 1 g to the cheek and avoid broken skin",{locale:"en"});
    const clause=parsed.meta.canonical.clauses[0];
    expect(clause.dose).toMatchObject({value:1,unit:"g"});
    expect(clause.site?.coding?.code).toBe("60819002");
    expect(clause.instructionGraph?.actions.find(a=>a.predicate.lemma==="avoid")?.args)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({role:AdviceArgumentRole.Site,conceptId:"broken-skin"})
      ]));
    expect(formatSig(parsed.fhir,"long",{locale:"th"}))
      .toContain("หลีกเลี่ยงบริเวณผิวหนังที่มีแผล");
    expect(clause.leftovers).toEqual([]);
  });

  it("keeps water as an avoided substance, not an anatomical site",()=>{
    const parsed=parseSig("Avoid water",{locale:"en"});
    const action=parsed.meta.canonical.clauses[0].instructionGraph?.actions.find(a=>a.predicate.lemma==="avoid");
    expect(action?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({role:AdviceArgumentRole.Substance,conceptId:"water"})
    ]));
    expect(action?.args.some(a=>a.role===AdviceArgumentRole.Site)).toBe(false);
    expect(formatSig(parsed.fhir,"long",{locale:"th"})).not.toContain("หลีกเลี่ยงบริเวณ");
  });
});

describe("clinical polarity and whole-manner composition in bilingual SIGs", () => {
  it.each([
    "ห้ามบด เคี้ยว หรือกลืนยาเม็ด",
    "Do not crush chew or swallow the tablets"
  ])("keeps a comma-free list under its original negation: %s", (source) => {
    const locale = /[\u0E00-\u0E7F]/u.test(source) ? "th" : "en";
    const parsed = parseSig(source,{locale});
    const recovered = fromFhirDosage(parsed.fhir,{locale});
    for(const result of [parsed,recovered]) {
      const actions=result.meta.canonical.clauses[0].instructionGraph?.actions??[];
      for(const lemma of ["crush","chew","swallow"]){
        expect(actions.find(a=>a.predicate.lemma===lemma)?.polarity).toBe("negate");
      }
    }
    const codes=parsed.fhir.additionalInstruction?.flatMap(x=>x.coding?.map(y=>y.code)??[])??[];
    expect(codes).not.toContain("418991002");
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity?.value).toBeUndefined();
    const english=formatSig(parsed.fhir,"long",{locale:"en"});
    expect(english).toMatch(/do not chew/i);
    expect(english).toMatch(/do not swallow/i);
  });

  it.each([
    ["Swallow 2 tablets whole without chewing every morning",2,"MORN"],
    ["Swallow 2 tablets whole before breakfast without chewing",2,"ACM"],
    ["Swallow tablets whole without chewing",undefined,undefined]
  ])("renders owned whole-swallow and negative-chew meaning without duplicate positive imperatives: %s",
    (source,count,event) => {
      const parsed=parseSig(source,{locale:"en"});
      expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(count);
      if(event) expect(parsed.fhir.timing?.repeat?.when).toContain(event);
      const actions=parsed.meta.canonical.clauses[0].instructionGraph?.actions??[];
      expect(actions.find(x=>x.predicate.lemma==="swallow")?.args).toEqual(expect.arrayContaining([
        expect.objectContaining({role:AdviceArgumentRole.Manner,conceptId:"whole"})
      ]));
      expect(actions.find(x=>x.predicate.lemma==="chew")?.polarity).toBe("negate");
      const en=formatSig(parsed.fhir,"long",{locale:"en"});
      const th=formatSig(parsed.fhir,"long",{locale:"th"});
      expect(en).not.toMatch(/take without chewing/i);
      expect(en).toMatch(/do not chew/i);
      expect((en.match(/swallow\b/gi)??[]).length).toBe(1);
      expect(th).not.toMatch(/\b(?:whole|chewing)\b/iu);
      const reopened=fromFhirDosage(parsed.fhir,{locale:"th"});
      expect(reopened.meta.canonical.clauses[0].dose?.value).toBe(count);
    }
  );

  it("keeps independent positive commands positive across a genuine sequence", () => {
    const p=parseSig("Do not crush; chew one tablet and then swallow",{locale:"en"});
    const a=p.meta.canonical.clauses[0].instructionGraph?.actions??[];
    expect(a.find(x=>x.predicate.lemma==="crush")?.polarity).toBe("negate");
    expect(a.find(x=>x.predicate.lemma==="chew")?.polarity).not.toBe("negate");
  });
});

describe("composed solid dosage-form manner and subordinate prohibition", () => {
  it.each([
    ["Take 2 capsules whole without crushing",false],
    ["Take 2 capsules whole without crushing or chewing twice daily",true]
  ])("retains one administration and both clinical prohibitions: %s", (source, secondWarning) => {
    const parsed=parseSig(source,{locale:"en"});
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({value:2,unit:"cap"});
    const actions=parsed.meta.canonical.clauses[0].instructionGraph?.actions??[];
    expect(actions.find(x=>x.predicate.lemma==="take")?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({role:AdviceArgumentRole.Manner,conceptId:"whole"})
    ]));
    expect(actions.find(x=>x.predicate.lemma==="crush")?.polarity).toBe("negate");
    if(secondWarning) expect(actions.find(x=>x.predicate.lemma==="chew")?.polarity).toBe("negate");
    const en=formatSig(parsed.fhir,"long",{locale:"en"});
    const th=formatSig(parsed.fhir,"long",{locale:"th"});
    expect((en.match(/take 2 capsules/gi)??[]).length).toBe(1);
    expect(en).not.toMatch(/take without crushing/i);
    expect(en).toMatch(/do not crush/i);
    expect(th).toContain("ทั้งแคปซูล");
    expect(th).not.toMatch(/\b(?:whole|crushing|chewing)\b/iu);
    const reloaded=fromFhirDosage(parsed.fhir,{locale:"th"});
    expect(reloaded.meta.canonical.clauses[0].dose?.value).toBe(2);
  });
});

describe("clinical negation scope across directive boundaries", () => {
  it.each([
    "Do not take if heart rate below 60 or systolic BP below 100; hold and call clinic",
    "Do not take if HR below 60; hold and call clinic",
    "Do not take. Hold and call clinic",
    "Do not take, then hold and call clinic",
    "ห้ามกินยาเมื่อ SBP <90 and HR<60; hold and call clinic"
  ])("does not turn post-semicolon HOLD/CALL into prohibited commands: %s", (source) => {
    const locale=/[\u0E00-\u0E7F]/u.test(source)?"th":"en";
    const parsed=parseSig(source,{locale});
    for(const result of [parsed,fromFhirDosage(parsed.fhir,{locale})]){
      const actions=result.meta.canonical.clauses[0].instructionGraph?.actions??[];
      expect(actions.find(x=>x.predicate.lemma==="take")?.polarity).toBe("negate");
      expect(actions.find(x=>x.predicate.lemma==="hold")?.polarity).not.toBe("negate");
      expect(actions.find(x=>x.predicate.lemma==="call")?.polarity).not.toBe("negate");
    }
    const en=formatSig(parsed.fhir,"long",{locale:"en"});
    expect(en).not.toMatch(/do not (?:hold|call)/i);
    expect(en).toMatch(/call clinic/i);
  });

  it("keeps explicitly repeated negative directives negative on both sides of the semicolon", () => {
    const parsed=parseSig("Do not take if HR below 60; do not hold and do not call clinic",{locale:"en"});
    const actions=parsed.meta.canonical.clauses[0].instructionGraph?.actions??[];
    for(const name of ["take","hold","call"]){
      expect(actions.find(x=>x.predicate.lemma===name)?.polarity).toBe("negate");
    }
  });

  it("retains negation for a genuinely coordinated within-clause object list", () => {
    const parsed=parseSig("Do not crush, chew, or swallow the tablets",{locale:"en"});
    const actions=parsed.meta.canonical.clauses[0].instructionGraph?.actions??[];
    for(const name of ["crush","chew","swallow"]){
      expect(actions.find(x=>x.predicate.lemma===name)?.polarity).toBe("negate");
    }
  });
});


describe("source-ordered course-end counseling", () => {
  it.each([
    ["Take one tablet daily until itching resolves, then stop unless rash returns.", "until itching resolves", "stop unless rash returns"],
    ["Take 1 tablet daily until next appointment; then stop.", "until next appointment", "stop"]
  ])("keeps the course-end adjunct before its subsequent action: %s", (input, adjunct, action) => {
    const parsed = parseSig(input);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(parsed.fhir.timing?.repeat).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
    expect(parsed.fhir.timing?.repeat?.boundsPeriod).toBeUndefined();
    expect(parsed.fhir.asNeeded).not.toBe(true);
    expect(getDosageCondition(parsed.fhir)).toBeUndefined();
    const reopened = fromFhirDosage(parsed.fhir, { locale: "en" });
    for (const text of [parsed.fhir.text, formatSig(parsed.fhir, "long", { locale: "en" }), reopened.longText]) {
      const lower = (text ?? "").toLowerCase();
      expect(lower).toContain(adjunct);
      expect(lower).toContain(action);
      expect(lower.indexOf(adjunct)).toBeLessThan(lower.indexOf(action));
    }
  });

  it("retains ordered complete counseling when formatting Thai after save and reload", () => {
    const parsed = parseSig("Take one tablet daily until itching resolves, then stop unless rash returns.");
    const texts = [
      formatSig(parsed.fhir, "long", { locale: "th" }),
      formatSig(parsed.dosageDetails, "long", { locale: "th" }),
      fromFhirDosage(parsed.fhir, { locale: "th" }).longText
    ];
    for (const text of texts) {
      // The outcome adjunct was already typed and translated at HPSG time;
      // saving to default R5 must not throw away that translation.
      expect(text).toContain("ใช้ยาจนกว่าอาการคันจะหาย");
      expect(text).not.toContain("itching resolves");
      const adjunct = text.search(/อาการคัน/u);
      const action = text.search(/stop|หยุด/iu);
      expect(adjunct).toBeGreaterThanOrEqual(0);
      expect(action).toBeGreaterThan(adjunct);
      expect(text.match(/rash returns/giu)).toHaveLength(1);
      expect(text.match(/stop|หยุด/giu)).toHaveLength(1);
    }
  });

  it("does not turn a calendar course end into unstructured outcome advice", () => {
    const parsed = parseSig("Take 1 tablet daily until 2026-11-25.");
    expect(parsed.fhir.timing?.repeat?.boundsPeriod?.end).toBe("2026-11-25");
    expect(parsed.fhir.timing?.repeat?.frequency).toBe(1);
    expect(getDosageCondition(parsed.fhir)).toBeUndefined();
  });
});


describe("typed independently timed dose head inheritance", () => {
  it.each([
    "Inject 5 units before breakfast and 8 units before dinner",
    "Inject insulin 5 units before breakfast and 8 units before dinner",
    "ฉีด 5 ยูนิตก่อนอาหารเช้า และ 8 ยูนิตก่อนอาหารเย็น",
    "ฉีดอินซูลิน 5 ยูนิตก่อนอาหารเช้า และ 8 ยูนิตก่อนอาหารเย็น"
  ])("retains the explicit administration method on each headless coordinated dose: %s", input => {
    const parsed = parseSig(input);
    expect(parsed.items).toHaveLength(2);
    const rows = parsed.items.map(item => item.fhir);
    expect(rows.map(row => row.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([5, 8]);
    expect(rows.map(row => row.timing?.repeat?.when)).toEqual([["ACM"], ["ACV"]]);
    expect(rows.map(row => row.method?.coding?.[0]?.code)).toEqual(["740685003", "740685003"]);
    expect(rows.map(row => row.route?.coding?.[0]?.code)).toEqual([undefined, undefined]);
    expect(rows[1].text).toMatch(/^Inject 8 U/u);
    expect(formatSig(rows[1], "long", { locale: "th" })).toContain("ฉีด");
    expect(toFhirR5Dosages(toDosageDetails(rows)).map(row => row.method?.coding?.[0]?.code))
      .toEqual(["740685003", "740685003"]);
    for (const row of rows) expect(getDosageCondition(row)).toBeUndefined();
  });

  it.each([
    "Inject 5 units before breakfast and 8 units before lunch and 10 units before dinner",
    "ฉีด 5 ยูนิตก่อนอาหารเช้า และ 8 ยูนิตก่อนอาหารกลางวัน และ 10 ยูนิตก่อนอาหารเย็น"
  ])("carries the same typed head through a three-dose coordination chain: %s", input => {
    const parsed = parseSig(input);
    const rows = parsed.items.map(item => item.fhir);
    expect(rows).toHaveLength(3);
    expect(rows.map(row => row.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([5, 8, 10]);
    expect(rows.map(row => row.timing?.repeat?.when)).toEqual([["ACM"], ["ACD"], ["ACV"]]);
    expect(rows.map(row => row.method?.coding?.[0]?.code))
      .toEqual(["740685003", "740685003", "740685003"]);
  });

  it("inherits only the head, not a preceding meal relation or offset, when the next dose is explicit", () => {
    const parsed = parseSig("Take 1 tablet 30 minutes before breakfast twice daily and 2 tablets dinner twice daily");
    const rows = parsed.items.map(item => item.fhir);
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([1, 2]);
    expect(rows[0].timing?.repeat).toMatchObject({ when: ["ACM"], offset: 30 });
    expect(rows[1].timing?.repeat).toMatchObject({ when: ["CV"], frequency: 2 });
    expect(rows[1].timing?.repeat?.offset).toBeUndefined();
    expect(rows[1].method?.text).toBe("Take");
    const strict = toFhirR5Dosages(toDosageDetails(rows));
    expect(strict[1].timing?.repeat?.when).toEqual(["CV"]);
    expect(strict[1].timing?.repeat?.offset).toBeUndefined();
  });

  it("does not invent head-inheritance evidence when both ocular administrations omit their head", () => {
    const parsed = parseSig("OD 1 drop BID and OS 2 drops BID");
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([1, 2]);
    for (const clause of parsed.meta.canonical.clauses) {
      expect(clause.evidence.some(item => item.rule === "hpsg.cx.coordination.dosed-head-ellipsis"))
        .toBe(false);
    }
  });

  it("keeps an explicit alternative head authoritative instead of inheriting the preceding verb", () => {
    const parsed = parseSig("Inject 5 units before breakfast and take 1 tablet at bedtime");
    expect(parsed.items).toHaveLength(2);
    const rows = parsed.items.map(item => item.fhir);
    expect(rows[0].method?.coding?.[0]?.code).toBe("740685003");
    expect(rows[1].method?.text).toBe("Take");
    expect(rows[1].doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(rows[1].timing?.repeat?.when).toEqual(["HS"]);
  });

  it("inherits the method without moving an evening-only withholding predicate to breakfast", () => {
    const parsed = parseSig("Inject 5 units before breakfast and 8 units before dinner; hold only the evening dose if glucose below 70");
    const rows = parsed.items.map(item => item.fhir);
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.method?.coding?.[0]?.code)).toEqual(["740685003", "740685003"]);
    expect(getDosageCondition(rows[0])).toBeUndefined();
    expect(getDosageCondition(rows[1])).toMatchObject({ kind: "not", condition: {
      kind: "measurement", name: "glucose", operation: "lt", value: 70
    } });
  });
});


describe("typed mixed-dose clock ownership", () => {
  const doseValue = (row: { doseAndRate?: Array<{ doseQuantity?: { value?: number } }> }) =>
    row.doseAndRate?.[0]?.doseQuantity?.value;

  it.each([
    ["half a tablet", 3],
    ["a tablet", 2],
    ["0.5 tablet", 2],
    ["one and a half tablets", 5],
    ["ครึ่งเม็ด", 2]
  ] as const)("keeps the complete scalar dose as one lexical boundary head: %s", (source, end) => {
    const tokens = annotateLexTokens(lexInput(source));
    expect(explicitDoseLexicalEnd(tokens, 0)).toBe(end);
    for (let index = 1; index < end; index += 1) {
      expect(explicitDoseLexicalEnd(tokens, index)).toBeUndefined();
    }
  });

  it("keeps each PD11 amount with its own meal, clock, or bedtime anchor", () => {
    const source = "Take 1 tablet 30 minutes before breakfast, half a tablet at 15:00 and 1 tablet at bedtime.";
    const parsed = parseProductionSig(source);
    expect(parsed.fhir.map(doseValue)).toEqual([1, 0.5, 1]);
    expect(parsed.fhir.map(row => row.timing?.repeat)).toEqual([
      expect.objectContaining({ when: [EventTiming["Before Breakfast"]], offset: 30 }),
      expect.objectContaining({ timeOfDay: ["15:00:00"] }),
      expect.objectContaining({ when: [EventTiming["Before Sleep"]] })
    ]);
    expect(parsed.fhir[0].timing?.repeat?.timeOfDay).toBeUndefined();
    expect(parsed.fhir[1].timing?.repeat?.when).toBeUndefined();
    expect(parsed.fhirNext.step).toHaveLength(1);
    expect(parsed.fhirNext.step[0].component.map(doseValue)).toEqual([1, 0.5, 1]);

    const strict = toFhirR5Dosages(parsed.fhirNext);
    expect(strict.map(doseValue)).toEqual([1, 0.5, 1]);
    expect(toDosageDetails(strict).step).toHaveLength(1);
    expect(parsed.meta.canonical.clauses.map(clause => source.slice(clause.span.start, clause.span.end)))
      .toEqual(parsed.meta.canonical.clauses.map(clause => clause.rawText));
    expect(parsed.meta.canonical.clauses.map(clause =>
      clause.evidence.find(item => item.lexicalCategory === "dose")?.spans[0]?.text
    )).toEqual(["1 tablet", "half a tablet", "1 tablet"]);
  });

  it("keeps the PD29 bedtime clock on the explicit half-tablet daughter", () => {
    const source = "Take 1 tablet 30 minutes before meals, plus half a tablet at 22:00.";
    const parsed = parseProductionSig(source);
    expect(parsed.fhir.map(doseValue)).toEqual([1, 0.5]);
    expect(parsed.fhir[0].timing?.repeat).toMatchObject({
      when: [EventTiming["Before Meal"]], offset: 30
    });
    expect(parsed.fhir[0].timing?.repeat?.timeOfDay).toBeUndefined();
    expect(parsed.fhir[1].timing?.repeat).toMatchObject({ timeOfDay: ["22:00:00"] });
    expect(parsed.fhir[1].timing?.repeat?.when).toBeUndefined();
    expect(parsed.fhirNext.step).toHaveLength(1);
    expect(parsed.fhirNext.step[0].component.map(doseValue)).toEqual([1, 0.5]);
    expect(toFhirR5Dosages(parsed.fhirNext).map(doseValue)).toEqual([1, 0.5]);
    expect(parsed.input).toBe(source);
    expect(parsed.meta.canonical.clauses.map(clause =>
      clause.evidence.find(item => item.lexicalCategory === "dose")?.spans[0]?.text
    )).toEqual(["1 tablet", "half a tablet"]);
  });

  it("treats PD08 meal and bedtime doses as one same-day regimen, not unbounded phases", () => {
    const source = "Take 1 tablet after breakfast and lunch, then half a tablet at bedtime.";
    const parsed = parseProductionSig(source);
    expect(parsed.fhir.map(doseValue)).toEqual([1, 0.5]);
    expect(parsed.fhir.map(row => row.timing?.repeat?.when)).toEqual([
      [EventTiming["After Breakfast"], EventTiming["After Lunch"]],
      [EventTiming["Before Sleep"]]
    ]);
    expect(parsed.fhirNext.step).toHaveLength(1);
    expect(parsed.fhirNext.step[0].component.map(doseValue)).toEqual([1, 0.5]);
    expect(toDosageDetails(toFhirR5Dosages(parsed.fhirNext)).step).toHaveLength(1);
    expect(parsed.input).toBe(source);
  });

  it("keeps the PD25 half-dose week before the full-dose same-clock phase", () => {
    const source = "Take half a tablet at 07:00, noon and 19:00 for 7 days; increase to one tablet at the same times thereafter.";
    const parsed = parseProductionSig(source);
    expect(parsed.fhir.map(doseValue)).toEqual([0.5, 1]);
    expect(parsed.fhir.map(row => row.site)).toEqual([undefined, undefined]);
    expect(parsed.fhir.map(row => row.timing?.repeat?.boundsDuration?.value))
      .toEqual([7, undefined]);
    expect(parsed.fhir.map(row => ({
      when: row.timing?.repeat?.when,
      timeOfDay: row.timing?.repeat?.timeOfDay
    }))).toEqual([
      { when: [EventTiming.Noon], timeOfDay: ["07:00:00", "19:00:00"] },
      { when: [EventTiming.Noon], timeOfDay: ["07:00:00", "19:00:00"] }
    ]);
    expect(parsed.fhirNext.step).toHaveLength(2);
    expect(parsed.fhirNext.step.map(step => step.component.map(doseValue))).toEqual([[0.5], [1]]);
    expect(toDosageDetails(toFhirR5Dosages(parsed.fhirNext)).step).toHaveLength(2);
    expect(parsed.input).toBe(source);
  });

  it("keeps the PD26 second-week 22:00 half-dose separate from the baseline clocks", () => {
    const source = "Take 1 tablet three times daily at 07:00, 13:00 and 19:00, but add half a tablet at 22:00 only from the second week.";
    const parsed = parseProductionSig(source);
    expect(parsed.fhir.map(doseValue)).toContain(0.5);
    expect(parsed.fhir).toContainEqual(expect.objectContaining({
      doseAndRate: [expect.objectContaining({
        doseQuantity: expect.objectContaining({ value: 1, unit: "tab" })
      })],
      timing: expect.objectContaining({ repeat: expect.objectContaining({
        timeOfDay: ["07:00:00", "13:00:00", "19:00:00"]
      }) })
    }));
    const bedtime = parsed.fhir.find(row => doseValue(row) === 0.5);
    expect(bedtime?.timing?.repeat?.timeOfDay).toEqual(["22:00:00"]);
    expect(parsed.fhir.some(row =>
      doseValue(row) === 1 && row.timing?.repeat?.timeOfDay?.includes("22:00:00")
    )).toBe(false);
    expect(toFhirR5Dosages(parsed.fhirNext).some(row =>
      doseValue(row) === 0.5 && row.timing?.repeat?.timeOfDay?.includes("22:00:00")
    )).toBe(true);
    expect(parsed.meta.canonical.clauses.find(clause => clause.dose?.value === 0.5)
      ?.evidence.find(item => item.lexicalCategory === "dose")?.spans[0]?.text)
      .toBe("half a tablet");
    expect(parsed.input).toBe(source);
  });

  it("keeps the Thai breakfast-and-lunch dose apart from the bedtime half-dose", () => {
    const source = "รับประทาน 1 เม็ดหลังอาหารเช้าและเที่ยง ครึ่งเม็ดก่อนนอน";
    const parsed = parseProductionSig(source);
    expect(parsed.fhir.map(doseValue)).toEqual([1, 0.5]);
    expect(parsed.fhir.map(row => row.timing?.repeat?.when)).toEqual([
      [EventTiming["After Breakfast"], EventTiming["After Lunch"]],
      [EventTiming["Before Sleep"]]
    ]);
    expect(parsed.fhirNext.step).toHaveLength(1);
    expect(parsed.fhirNext.step[0].component.map(doseValue)).toEqual([1, 0.5]);
    expect(toDosageDetails(toFhirR5Dosages(parsed.fhirNext)).step).toHaveLength(1);
    expect(parsed.input).toBe(source);
  });

  it.each([
    [
      "Take 1 tablet at 06:00, 0.5 tablet at 10:00, 1 tablet at 14:00, and 0.5 tablet at 18:00 daily.",
      [1, 0.5, 1, 0.5],
      [["06:00:00"], ["10:00:00"], ["14:00:00"], ["18:00:00"]]
    ],
    [
      "Take 1 tablet at 07:00, 1 tablet at 11:00, 0.5 tablet at 15:00, and 1 tablet at 19:00.",
      [1, 0.5, 1],
      [["07:00:00", "11:00:00"], ["15:00:00"], ["19:00:00"]]
    ],
    [
      "กินครึ่งเม็ดตอนเช้า 1 เม็ดตอนเที่ยง และครึ่งเม็ดตอนเย็น",
      [0.5, 1, 0.5],
      [undefined, undefined, undefined]
    ]
  ] as const)("preserves an already-correct nonuniform-dose control: %s", (source, doses, clocks) => {
    const parsed = parseProductionSig(source);
    expect(parsed.fhir.map(doseValue)).toEqual(doses);
    expect(parsed.fhir.map(row => row.timing?.repeat?.timeOfDay)).toEqual(clocks);
    expect(parsed.fhir.some(row => doseValue(row) === 0)).toBe(false);
    expect(parsed.input).toBe(source);
  });
});


describe("preparatory sentence remains part of its medication", () => {
  it.each([
    "Shake bottle before use. Take 5 mL orally twice daily.",
    "Shake well; measure 5 mL with oral syringe. Take 5 mL by mouth twice daily.",
    "เขย่าขวดก่อนใช้. รับประทาน 5 มิลลิลิตร วันละ 2 ครั้ง"
  ])("keeps preparation and the following complete dose in one instruction: %s", input => {
    const parsed = parseSig(input);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 5, unit: "mL" });
    expect(parsed.fhir.route?.coding?.[0]?.code).toBe("26643006");
    expect(parsed.fhir.timing?.repeat).toMatchObject({ frequency: 2, period: 1, periodUnit: "d" });
    expect(parsed.meta.canonical.clauses[0]?.instructionGraph?.actions.some(action => action.predicate.lemma === "shake"))
      .toBe(true);
  });
});


it("keeps untimed but independently dosed administrations distinct across a sentence", () => {
  const parsed = parseSig("Instill 1 drop in the left eye. Instill 2 drops in the right eye twice daily.");
  expect(parsed.items).toHaveLength(2);
  expect(parsed.items.map(item => item.fhir.site?.text)).toEqual(["left eye", "right eye"]);
  expect(parsed.items[0].fhir.timing).toBeUndefined();
  expect(parsed.items[1].fhir.timing?.repeat?.frequency).toBe(2);
});


describe("registered nominal compounds own product-like words", () => {
  it.each([
    "Alternate injection sites nightly.",
    "Rotate injection sites nightly.",
    "Inspect injection sites daily."
  ])("does not infer an intravenous administration from the noun injection sites: %s", input => {
    const parsed = parseSig(input);
    for (const item of parsed.items) {
      expect(item.fhir.route).toBeUndefined();
      expect(item.fhir.doseAndRate).toBeUndefined();
    }
    expect(parsed.meta.canonical.clauses[0]?.rawText).toBe(input);
  });

  it("retains actual product-route and alternating-day dosage interpretations", () => {
    const nasal = parseSig("Use nasal spray 1 puff twice daily");
    expect(nasal.fhir.route?.coding?.[0]?.code).toBe("46713006");
    expect(nasal.fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
    const topical = parseSig("Apply cream to scalp twice daily");
    expect(topical.fhir.route?.coding?.[0]?.code).toBe("6064005");
    const everyOther = parseSig("Take 1 tablet every other day");
    expect(everyOther.fhir.timing?.repeat).toMatchObject({ period: 2, periodUnit: "d" });
  });
});


describe("independent release oracles for newly observed realistic clinical errors", () => {
  it.each([
    "Take 1 tablet if BG above 180; otherwise skip",
    "Take 1 tablet if BG above 180, otherwise skip"
  ])("does not reverse the condition for a positive dose with a negative ELSE: %s", (source) => {
    const parsed = parseSig(source);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(getDosageCondition(parsed.fhir)).toMatchObject({
      kind: "measurement", name: "bg", operation: "gt", value: 180
    });
    expect(getDosageCondition(toFhirR5Dosages(toDosageDetails([parsed.fhir]))[0]))
      .toMatchObject({ kind: "measurement", operation: "gt", value: 180 });
    expect(parsed.input).toBe(source);
  });

  it.each([
    "Take 2 tablets daily if weight above 70kg; otherwise 1 tablet daily",
    "Take 2 tablets daily if weight above 70kg; otherwise take 1 tablet daily"
  ])("does not transform a conditional weight threshold into a medicine dose: %s", source => {
    const parsed = parseSig(source);
    const doseQuantities = parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity);
    expect(doseQuantities).not.toContainEqual(expect.objectContaining({ value: 70, unit: "kg" }));
    expect(doseQuantities).toContainEqual(expect.objectContaining({ value: 2, unit: "tab" }));
    expect(doseQuantities).toContainEqual(expect.objectContaining({ value: 1, unit: "tab" }));
    expect(parsed.items.some(item => item.fhir.asNeeded === true)).toBe(false);
    expect(parsed.input).toBe(source);
  });

  it.each([
    "Take one and a half tablets every morning",
    "Take 1 and a half tablets every morning"
  ])("keeps additive fractional dose rather than interpreting only the half: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity)
      .toMatchObject({ value: 1.5, unit: "tab" });
    expect(parsed.fhir.timing?.repeat?.when).toEqual(["MORN"]);
    expect(parsed.meta.leftoverText).toBeUndefined();
  });

  it("interprets plural weekday daughters as calendar rather than anatomical sites", () => {
    const parsed = parseSig("Take 1 tablet on Mondays Wednesdays and Fridays, and 2 tablets on Saturdays");
    expect(parsed.items).toHaveLength(2);
    const rows = parsed.items.map(item => item.fhir);
    expect(rows.map(row => row.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([1, 2]);
    expect(rows.map(row => row.site)).toEqual([undefined, undefined]);
    expect(rows.map(row => row.timing?.repeat?.dayOfWeek)).toEqual([
      ["mon", "wed", "fri"], ["sat"]
    ]);
  });

  it.each([
    "Take 2 tablets now, then 1 tablet after 12 hours",
    "Take 2 tablets immediately, then 1 tablet in 12 hours"
  ])("represents a one-time delayed second administration without inventing course or nasal route: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.items).toHaveLength(2);
    const rows = parsed.items.map(item => item.fhir);
    expect(rows.map(row => row.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([2, 1]);
    expect(rows[0].timing?.repeat?.when).toEqual(["IMD"]);
    expect(rows[1].route?.coding?.[0]?.code).toBe("26643006");
    expect(rows[1].timing?.repeat?.boundsDuration).toBeUndefined();
    const course = parsed.fhirNext;
    const hasDelay = course.step.some(step => step.start?.offsetDuration?.value === 12 &&
      step.start.offsetDuration.code === "h");
    expect(hasDelay).toBe(true);
    // The historical test adapter exposes only the first dosage as .fhir;
    // check the shipping API's complete flattened, course-marked R5 array.
    const extendedR5 = toDosageDetails(parseProductionSig(source).fhir);
    expect(extendedR5.step.some(step => step.start?.offsetDuration?.value === 12 &&
      step.start.offsetDuration.code === "h")).toBe(true);
    const strictR5 = toFhirR5Dosages(course);
    expect(toDosageDetails(strictR5).step.some(step =>
      step.start?.offsetDuration?.value === 12 &&
      step.start.offsetDuration.code === "h")).toBe(true);
  });

  it("retains a second OD BID phase when its duration is phrased as five more days", () => {
    const parsed = parseSig("OD 1 drop q2h for 2 days, then BID for 5 more days. OS 1 drop nightly for 7 days.");
    const right = parsed.items.map(item => item.fhir).filter(row => row.site?.text === "right eye");
    expect(right.some(row => row.timing?.repeat?.period === 2 &&
      row.timing?.repeat?.periodUnit === "h")).toBe(true);
    expect(right.some(row => row.timing?.repeat?.frequency === 2 &&
      row.timing?.repeat?.boundsDuration?.value === 5)).toBe(true);
  });

  it("does not erase an explicit Sunday exclusion and four-week course", () => {
    const parsed = parseSig("Take 1 tablet every day except Sunday for 4 weeks");
    const row = parsed.fhir;
    expect(row.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(row.timing?.repeat?.boundsDuration?.value).toBe(4);
    expect(row.timing?.repeat?.boundsDuration?.code).toBe("wk");
    const ordinaryDays = row.timing?.repeat?.dayOfWeek;
    const excluded = getDosageExcludedWeekdays(row);
    // The R5 calendar may use either explicit included weekdays or the
    // existing source-preserving excluded-weekdays extension.
    expect(
      ordinaryDays?.length === 6 && !ordinaryDays.includes("sun") ||
      excluded.includes("sun")
    ).toBe(true);
  });

  it.each([
    ["Take 1 tab qAM and 2 tabs qPM for 7 days", 7, "d"],
    ["Take 0.5 tablet each morning and 1.5 tablets each evening for 14 days", 14, "d"],
    ["รับประทาน ครึ่งเม็ดเช้า และ 1 เม็ดเย็น 2 สัปดาห์", 2, "wk"]
  ] as const)("applies a terminal course duration to both coordinated daily doses: %s", (source, value, code) => {
    const parsed = parseSig(source);
    expect(parsed.items).toHaveLength(2);
    const rows = parsed.items.map(item => item.fhir);
    expect(rows.map(row => row.timing?.repeat?.boundsDuration)).toEqual([
      expect.objectContaining({ value, code }),
      expect.objectContaining({ value, code })
    ]);
    const strict = toFhirR5Dosages(toDosageDetails(rows));
    expect(strict.map(row => row.timing?.repeat?.boundsDuration))
      .toEqual(rows.map(row => row.timing?.repeat?.boundsDuration));
  });

  it("retains an offset-only external R5 dosage when importing canonical semantics", () => {
    const external = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      modifierExtension: [{
        url: ADMINISTRATION_OFFSET_EXTENSION_URL,
        valueQuantity: { value: 720, unit: "min", system: "http://unitsofmeasure.org", code: "min" }
      }]
    };
    const imported = fromFhirDosage(external);
    expect(imported.meta.canonical.clauses[0]?.schedule?.administrationOffsetMinutes)
      .toBe(720);
    expect(getAdministrationOffsetMinutes(imported.fhir)).toBe(720);
    const strict = toFhirR5Dosages(toDosageDetails([external]));
    expect(getAdministrationOffsetMinutes(strict[0])).toBe(720);
    expect(fromFhirDosage(strict[0]).meta.canonical.clauses[0]?.schedule?.administrationOffsetMinutes)
      .toBe(720);
  });

  it("keeps a clock-anchored delayed dose as a component offset, not an R6 course start", () => {
    const input = "Take 1 tablet daily at 08:00 then another tablet 2 hours later";
    const parsed = parseProductionSig(input);
    expect(parsed.items[0]?.meta.canonical.clauses[0]?.schedule?.administrationOffsetMinutes)
      .toBe(120);
    expect(parsed.items[0]?.fhir.timing?.repeat?.timeOfDay).toEqual(["08:00:00"]);
    expect(parsed.fhirNext.step[0]?.start).toBeUndefined();
    expect(getAdministrationOffsetMinutes(parsed.fhirNext.step[0]?.component[0])).toBe(120);
    expect(getAdministrationOffsetMinutes(parsed.fhir[0])).toBe(120);
    expect(getAdministrationOffsetMinutes(toDosageDetails(parsed.fhir).step[0]?.component[0])).toBe(120);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });

  it("keeps a single delayed administration as an R6 treatment-relative step", () => {
    const source = "Take 1 tablet after 12 hours";
    const parsed = parseProductionSig(source);
    expect(parsed.fhir).toHaveLength(1);
    expect(parsed.meta.canonical.clauses[0]?.schedule?.administrationOffsetMinutes)
      .toBe(720);
    expect(getAdministrationOffsetMinutes(parsed.items[0].fhir)).toBe(720);
    expect(getAdministrationOffsetMinutes(parsed.fhir[0])).toBeUndefined();
    expect(getAdministrationOffsetMinutes(parsed.fhirNext.step[0]?.component[0])).toBeUndefined();
    expect(parsed.fhirNext.step[0]?.start?.offsetDuration)
      .toMatchObject({ value: 12, code: "h" });
    const restored = toDosageDetails(parsed.fhir);
    expect(restored.step[0]?.start?.offsetDuration)
      .toMatchObject({ value: 12, code: "h" });
    expect(toDosageDetails(toFhirR5Dosages(parsed.fhirNext)).step[0]?.start?.offsetDuration)
      .toMatchObject({ value: 12, code: "h" });
  });

  it("does not shift a treatment-relative daily administration twice", () => {
    const parsed = parseProductionSig("Take 1 tablet QD 12 hours later");
    expect(getAdministrationOffsetMinutes(parsed.items[0].fhir)).toBe(720);
    expect(getAdministrationOffsetMinutes(parsed.fhirNext.step[0].component[0]))
      .toBeUndefined();
    const from = "2026-10-26T08:00:00+07:00";
    const options = { from, orderedAt: from, timeZone: "Asia/Bangkok", limit: 2 };
    const expected = ["2026-10-27T09:00:00+07:00", "2026-10-28T09:00:00+07:00"];
    expect(nextDueDoses(parsed.fhirNext, options)).toEqual(expected);
    expect(nextDueDoses(toDosageDetails(parsed.fhir), options)).toEqual(expected);
  });

  it.each([
    "Take 1 tablet only if SBP below 90 or above 180",
    "Take 1 tablet only if glucose <70 or >180"
  ])("inherits the same measurement head across OR's headless comparison: %s", source => {
    const parsed = parseSig(source);
    const condition = getDosageCondition(parsed.fhir);
    expect(condition).toMatchObject({
      kind: "any",
      conditions: [
        { kind: "measurement", operation: "lt" },
        { kind: "measurement", operation: "gt" }
      ]
    });
    if (condition?.kind === "any" &&
      condition.conditions[0]?.kind === "measurement" &&
      condition.conditions[1]?.kind === "measurement") {
      expect(condition.conditions[1].name).toBe(condition.conditions[0].name);
    }
    expect(getDosageCondition(toFhirR5Dosages(toDosageDetails([parsed.fhir]))[0]))
      .toEqual(condition);
  });

  it("keeps two SBP bounds on the same measurement", () => {
    const parsed = parseSig("Take one tablet only if SBP above 100 and below 160");
    expect(getDosageCondition(parsed.fhir)).toMatchObject({
      kind: "all",
      conditions: [
        { kind: "measurement", name: "sbp", operation: "gt", value: 100 },
        { kind: "measurement", name: "sbp", operation: "lt", value: 160 }
      ]
    });
  });
});


describe("CodeRabbit 2026-10-25 dose preservation review", () => {
  it("reopens coded FHIR body-site predicates in ParserState without losing location or text", () => {
    const source = "apply 1 mL to left knee where painful twice daily";
    const dosage = parseProductionSig(source).fhir[0];
    const state = parserStateFromFhir(dosage);
    expect(state.primaryClause.site?.text).toBe("left knee");
    expectRestriction(state.primaryClause.site, "where painful", "painful", source);
    expect(state.primaryClause.site?.coding?.code).toBe(dosage.site?.coding?.[0]?.code);
  });

  it("shows a monthly restriction alongside a rich, procedurally composed administration in both languages", () => {
    const rich = parseProductionSig("Rinse mouth with 10 mL for 1 minute then spit after meals");
    const monthly = parseProductionSig("1 tab PO QD on days 1-14 of each month").fhir[0];
    expect(rich.meta.canonical.clauses[0]?.instructionGraph?.actions[0]?.predicate.lemma)
      .toBe("rinse_mouth");
    const dosage = {
      ...rich.fhir[0],
      timing: {
        ...rich.fhir[0].timing,
        repeat: {
          ...rich.fhir[0].timing?.repeat,
          extension: [
            ...(rich.fhir[0].timing?.repeat?.extension ?? []),
            ...(monthly.timing?.repeat?.extension ?? [])
          ]
        }
      }
    };
    const en = formatSig(dosage, "long", { locale: "en" });
    const th = formatSig(dosage, "long", { locale: "th" });
    expect(en).toContain("on days 1–14 of each month");
    expect(th).toContain("วันที่ 1–14 ของทุกเดือน");
    expect(en.toLowerCase()).toMatch(/rinse/);
    expect(th).toContain("บ้วนปาก");
  });

  it("rebases an aliased clinical source span only once across projected clauses", () => {
    const input = "apply 1 mL to left knee where painful twice daily";
    const original = parseProductionSig(input).items[0].meta.canonical.clauses[0];
    const restriction = original.site?.restrictions?.[0];
    const shared = restriction?.range;
    if (!shared || !restriction || !original.site) throw new Error("Expected a typed restricted site.");
    const from = { ...shared };
    const local = original.raw.start;
    // Source-evidence and site restrictions may point to the same source object
    // in separate flattened FHIR dosage projections of a clinical clause.
    original.site.range = shared;
    restriction.predicate.range = shared;
    original.evidence.push({ rule: "test.shared-site-evidence", spans: [shared] });
    const separate = { start: 1, end: 6 };
    const separateFrom = { ...separate };
    original.clinicalAdjuncts = {
      localRanges: [shared, separate],
      evidence: [{ rule: "test.shared-adjunct-evidence", spans: [shared] }],
      treatmentPause: { durationDays: 2, range: shared }
    };
    original.provisionalSchedule = {
      evidence: [{ rule: "test.provisional-evidence", spans: [separate] }]
    };
    const other = { ...original, raw: { ...original.raw } };
    shiftCanonicalSigClauses([original, other], 7);
    expect(shared).toEqual({ start: from.start + 7, end: from.end + 7 });
    expect(original.site.range).toBe(shared);
    expect(other.site?.restrictions?.[0]?.range).toBe(shared);
    expect(original.clinicalAdjuncts.localRanges?.[0]).toBe(shared);
    expect(original.clinicalAdjuncts.treatmentPause?.range).toBe(shared);
    expect(original.clinicalAdjuncts.evidence?.[0]?.spans[0]).toBe(shared);
    expect(separate).toEqual({
      start: separateFrom.start + 7, end: separateFrom.end + 7
    });
    expect(original.provisionalSchedule.evidence?.[0]?.spans[0]).toBe(separate);
    expect(original.raw.start).toBe(local + 7);
    expect(other.raw.start).toBe(local + 7);
  });
});


describe("CodeRabbit 2026-10-25 second review: compositional instruction fidelity", () => {
  it.each([
    ["Remove contact lenses before instilling eye drops", "remove"],
    ["Remove soft contact lenses before using eye drops", "remove"],
    ["Do not wear contact lenses while using eye drops", "wear"]
  ] as const)("keeps the noun phrase contact lenses under the governing action: %s", (input, lemma) => {
    const parsed = parseProductionSig(input, { locale: "en" });
    const actions = parsed.meta.canonical.clauses.flatMap(clause =>
      clause.instructionGraph?.actions ?? []);
    expect(actions.some(action => action.predicate.lemma === "call")).toBe(false);
    const action = actions.find(action => action.predicate.lemma === lemma);
    expect(action).toBeDefined();
    expect(action?.args.some(arg => /contact lenses/i.test(arg.text))).toBe(true);
    if (input.startsWith("Remove contact lenses")) {
      expect(action?.args.find(arg => /contact lenses/i.test(arg.text))?.coding)
        .toMatchObject({ system: "http://snomed.info/sct", code: "57368009" });
    }
    if (/Do not/i.test(input)) expect(action?.polarity).toBe("negate");
    expect(parsed.longText).not.toMatch(/call lenses/i);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });

  it("preserves the separately licensed clinician-contact command", () => {
    const parsed = parseProductionSig("Contact your doctor if eye pain develops", { locale: "en" });
    const actions = parsed.meta.canonical.clauses.flatMap(clause =>
      clause.instructionGraph?.actions ?? []);
    expect(actions.some(action => action.predicate.lemma === "call" &&
      action.args.some(arg => /doctor/i.test(arg.text)))).toBe(true);
    expect(parsed.longText).toMatch(/call your doctor/i);
  });

  it("retains a known site noun instead of inventing an action to open wounds", () => {
    const parsed = parseProductionSig("Apply ointment to open wounds", { locale: "en" });
    expect(parsed.meta.canonical.clauses.flatMap(clause =>
      clause.instructionGraph?.actions ?? []).some(action =>
        action.predicate.lemma === "open")).toBe(false);
    expect(parsed.longText).not.toMatch(/then open/i);
  });

  const external = (offset: number, clocks: string[]) => ({
    doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
    timing: { repeat: { frequency: clocks.length, period: 1,
      periodUnit: "d" as const, timeOfDay: clocks } },
    modifierExtension: [{
      url: ADMINISTRATION_OFFSET_EXTENSION_URL,
      valueQuantity: { value: offset, unit: "min",
        system: "http://unitsofmeasure.org", code: "min" }
    }]
  });

  it("does not present different-day shifted clocks as the same-day frequency list", () => {
    const row = external(720, ["08:00:00", "20:00:00"]);
    const en = formatSig(row, "long", { locale: "en" });
    const th = formatSig(row, "long", { locale: "th" });
    expect(en).toMatch(/720 minutes later each time/i);
    expect(th).toContain("720 นาที");
    expect(getAdministrationOffsetMinutes(row)).toBe(720);
    expect(toFhirR5Dosages(toDosageDetails([row]))[0].modifierExtension)
      .toEqual(row.modifierExtension);
  });

  it("labels negative clock shifts correctly when an administration crosses to the previous day", () => {
    const row = external(-120, ["01:00:00"]);
    const en = formatSig(row, "long", { locale: "en" });
    const th = formatSig(row, "long", { locale: "th" });
    expect(en).toMatch(/previous day|day earlier/i);
    expect(th).toMatch(/วันก่อน|วันก่อนหน้า/);
    expect(en).not.toMatch(/-1 days later/i);
  });

  it("labels mixed negative clock shifts as earlier relative to each original time", () => {
    const row = external(-120, ["01:00:00", "20:00:00"]);
    const en = formatSig(row, "long", { locale: "en" });
    const th = formatSig(row, "long", { locale: "th" });
    expect(en).toMatch(/120 minutes earlier each time/i);
    expect(th).toContain("120 นาที");
    expect(en).not.toMatch(/-120 minutes later/i);
    expect(en).not.toMatch(/-1 days later/i);
  });

  it("still shows an unchanged date or a uniform following-day rollover normally", () => {
    const original = external(0, ["08:00:00", "20:00:00"]);
    const next = external(1440, ["08:00:00", "20:00:00"]);
    expect(formatSig(original, "long", { locale: "en" })).not.toMatch(/day later|day earlier/);
    expect(formatSig(next, "long", { locale: "en" })).toContain("following day");
  });
});
