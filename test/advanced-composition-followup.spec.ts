import { describe, expect, it } from "vitest";
import {
  AdviceArgumentRole, AdviceRelation, EventTiming, formatSig, fromFhirDosage,
  getDosageCondition
} from "../src/index";
import { parseSig } from "./helpers/r5-parser";
import { resolveBodySitePhrase } from "../src/body-site-grammar";
import { parseClauseSign } from "../src/parser";
import type { BodySiteRestriction } from "../src/types";
import { HPSG_TYPE_SYSTEM, type HpsgFeatureNode } from "../src/hpsg/type-system";
import { BODY_SITE_RESTRICTION_EXTENSION_URL } from "../src/fhir";

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
    "Dissolve water; then drink the medication. May cause vomiting.",
    "ละลายน้ำ จากนั้นดื่ม. อาจทำให้เกิดอาเจียน."
  ],
  [
    "dissolve in water before drinking, may cause vomiting",
    "Dissolve water before drinking. May cause vomiting.",
    "ละลายน้ำก่อนดื่ม. อาจทำให้เกิดอาเจียน."
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
      relation: AdviceRelation.Before,
      args: expect.arrayContaining([
        expect.objectContaining({ role: AdviceArgumentRole.Substance, conceptId: "water" }),
        expect.objectContaining({ role: AdviceArgumentRole.Activity, text: "drinking" })
      ])
    });
    expect(before.fhir.additionalInstruction?.[0]?.coding?.[0]?.code).toBeUndefined();
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
