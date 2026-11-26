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
  getAdministrationOffsetMinutes, parserStateFromFhir, getTimingClocks
} from "../src/fhir";
import { shiftCanonicalSigClauses } from "../src/ir";
import { readFileSync } from "node:fs";
import * as ts from "typescript";
import { courseFromR6, courseToR6, courseToR5, inputToCanonical } from "../src/adapters/canonical-course";
import { calculateTotalUnits as nativeSupply } from "../src/execution/engine";
import { calculateTotalUnits, fromFhir, formatSigBatch, setDosageAlternativeChoice, projectCanonicalCourse, importCanonicalCourse } from "../src/index";
import { formatCanonicalCourse, formatCanonicalAdministration, appendMedicationConditionText, appendMedicationExcludedWeekdaysText } from "../src/canonical/format-course";
import { clauseForAdministration, courseFromAdministrations, administrationFromClause } from "../src/canonical/compile";
import { TIMING_DAY_OF_MONTH_EXTENSION_URL, TIMING_ADMINISTRATION_DURATION_EXTENSION_URL, TIMING_WEEKDAY_ORDINAL_EXTENSION_URL, TIMING_CLOCK_WINDOW_EXTENSION_URL, TIMING_EVENT_WINDOW_EXTENSION_URL, ANCHORED_COURSE_DURATION_EXTENSION_URL, TIMING_OCCURRENCE_CAP_EXTENSION_URL, TIMING_OFFSET_EXACT_EXTENSION_URL, getAnchoredCourseDuration } from "../src/fhir";
import { cloneStructuredValue } from "../src/stable-structure";
import { dosageMatchesSavedProjection, withDosageEditProvenance } from "../src/dosage-course";
import { registerMedicationLocaleDetector, inferMedicationLocale } from "../src/locale-detection";
import { registerSigLocalization, resolveSigLocalization, DAY_NAMES_THAI, joinWithAndThai } from "../src/i18n";
import { formatCanonicalClause, DAY_NAMES, joinWithAnd } from "../src/format";
import { instructionGraphSourceConflictsWithDose } from "../src/instruction-graph";
import { ENGLISH_DAY_NAMES } from "../src/locales/course/en";
import { THAI_DAY_NAMES } from "../src/locales/course/th";
import { joinLocalizedList } from "../src/utils/text";
import { EMA_QUANTITY_COMPARATOR_EXTENSION_URL, EMA_QUANTITY_OPERATOR_SYSTEM } from "../src/fhir-quantity-operator";
import { ENGLISH_COURSE } from "../src/locales/course/en";
import { EventTiming as canonicalCourseEventTiming, FhirDayOfWeek, FhirPeriodUnit, type FhirDosage, type FhirR6Dosage, type FhirR6DosageInstruction, type FhirR6DoseLimit } from "../src/types";
import type { CanonicalAdministration, CanonicalCourse, CanonicalScheduleInput } from "../src/canonical/course";

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

      const dosage = JSON.parse(JSON.stringify(parseProductionSig(input).fhir[0]));
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
    expect(parsed.dosageDetails.step).toBeDefined();
    const r6Component = parsed.dosageDetails.step![0]?.component[0];
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
    expect(parsed.dosageDetails.step).toBeDefined();
    const components = parsed.dosageDetails.step![0]?.component ?? [];
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
      timeOfDay: getTimingClocks(row.timing?.repeat)
    }))).toEqual([
      { when: [EventTiming.Noon], timeOfDay: ["07:00:00", "19:00:00"] },
      { when: [EventTiming.Noon], timeOfDay: ["07:00:00", "19:00:00"] }
    ]);
    expect(parsed.fhir.every(row => row.timing?.repeat?.timeOfDay === undefined)).toBe(true);
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
    expect(course.step[1].component[0].timing?.repeat?.count).toBe(1);
    // Assert the actual delayed administration after both supported
    // projections, rather than requiring a treatment-global start encoding.
    const production = parseProductionSig(source);
    const extendedR5 = toDosageDetails(production.fhir);
    const strictR5 = toFhirR5Dosages(course);
    for (const input of [production.meta.canonical.course!, course, production.fhir,
      JSON.parse(JSON.stringify(production.fhir)), extendedR5, strictR5,
      JSON.parse(JSON.stringify(strictR5)), toDosageDetails(strictR5)]) {
      const before = JSON.stringify(input);
      expect(nextDueDoses(input, { orderedAt: "2026-11-21T08:00:00Z", from: "2026-11-21T08:00:00Z",
        timeZone: "UTC", limit: 4 })).toEqual([
          "2026-11-21T08:00:00+00:00", "2026-11-21T20:00:00+00:00"
        ]);
      expect(JSON.stringify(input)).toBe(before);
    }
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


/** Independent architectural/clinical oracles for the native course boundary.
 * These cases exercise canonical edits, not only adapter self-roundtrips. */
{
const parseSig = parseProductionSig;
const EventTiming = canonicalCourseEventTiming;
type EventTiming = canonicalCourseEventTiming;


const source: FhirR6DosageInstruction = {
  id: "native-course",
  extension: [{ url: "urn:test:opaque-course", valueString: "retained" }],
  step: [
    {
      id: "s1",
      component: [
        {
          id: "dose-a",
          extension: [{ url: "urn:test:opaque-dose", valueString: "untouched" }],
          site: {
            id: "site-wrapper",
            concept: { text: "left eye", coding: [{ system: "urn:anatomy", code: "left", version: "7" }] },
            reference: { reference: "BodyStructure/left" },
            extension: [{ url: "urn:site:extra", valueString: "kept" }],
          },
          doseAndRate: [
            {
              id: "amount-a",
              doseQuantity: { value: 1, unit: "tab", system: "http://unitsofmeasure.org", code: "{tbl}" },
            },
          ],
          timing: {
            repeat: {
              frequency: 1,
              period: 1,
              periodUnit: "d",
              timeOfDay: ["08:00:00"],
              boundsDuration: { value: 3, unit: "d", code: "d" },
            },
          },
        },
      ],
    },
  ],
};
const options = {
  orderedAt: "2026-11-02T00:00:00+07:00",
  from: "2026-11-02T00:00:00+07:00",
  timeZone: "Asia/Bangkok",
  limit: 8,
  durationValue: 3,
  durationUnit: "d" as const,
};

describe("canonical course architecture", () => {
  it("the execution kernel and clinical compiler do not import FHIR adapters or inspect wire markers", () => {
    const forbiddenModuleSpecifiers = (text: string) => {
      const source = ts.createSourceFile("boundary.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const modules: string[] = [];
      const visit = (node: ts.Node) => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
            node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
          modules.push(node.moduleSpecifier.text);
        } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) &&
            node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) {
          modules.push(node.moduleReference.expression.text);
        } else if (ts.isCallExpression(node) &&
                   (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                    ts.isIdentifier(node.expression) && node.expression.text === "require") &&
                   node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
          modules.push(node.arguments[0].text);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      return modules.filter(module => /(?:dosage-course|adapters\/|\/fhir(?:$|\.))/u.test(module));
    };
    for (const source of [
      'import { administrationFromR5 } from "../adapters/r5-import";',
      'import "../adapters/r5-import";',
      'const adapter = import("../adapters/r5-import");',
      'export * from "../adapters/r5-import";',
      'import adapter = require("../adapters/r5-import");',
      'const adapter = require("../adapters/r5-import");'
    ]) expect(forbiddenModuleSpecifiers(source)).toEqual(["../adapters/r5-import"]);
    expect(forbiddenModuleSpecifiers(`const text = 'from "../adapters/r5-import"';`)).toEqual([]);
    expect(forbiddenModuleSpecifiers(`const text = 'require("../adapters/r5-import")';`)).toEqual([]);
    const wireBoundaryAccesses = (text: string) => {
      const source = ts.createSourceFile("boundary.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const accesses: string[] = [];
      const visit = (node: ts.Node) => {
        const boundProperty = ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)
          ? node.propertyName ?? node.name : undefined;
        if ((ts.isPropertyAccessExpression(node) && node.name.text === "modifierExtension") ||
            (ts.isElementAccessExpression(node) && node.argumentExpression &&
             ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === "modifierExtension") ||
            (boundProperty && (ts.isIdentifier(boundProperty) || ts.isStringLiteralLike(boundProperty)) &&
             boundProperty.text === "modifierExtension"))
          accesses.push(node.getText(source));
        if (ts.isCallExpression(node)) {
          const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
          if (ts.isIdentifier(callee) && ["toFhirR5Dosages", "fromR6Dosage", "toDosageDetails"].includes(callee.text))
            accesses.push(node.getText(source));
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      return accesses;
    };
    for (const access of ["row.modifierExtension", "row?.modifierExtension",
      'row["modifierExtension"]', 'row?.["modifierExtension"]'])
      expect(wireBoundaryAccesses("const modifiers = " + access + " ?? [];")).toEqual([access]);
    for (const binding of ["modifierExtension", "modifierExtension: markers", '"modifierExtension": markers'])
      expect(wireBoundaryAccesses("const { " + binding + " } = row;")).toEqual([binding]);
    expect(wireBoundaryAccesses('const text = "row.modifierExtension";')).toEqual([]);
    expect(wireBoundaryAccesses('const text = "{ modifierExtension: markers }";')).toEqual([]);
    for (const name of ["toFhirR5Dosages", "fromR6Dosage", "toDosageDetails"]) {
      expect(wireBoundaryAccesses(name + "(rows);")).toEqual([name + "(rows)"]);
      expect(wireBoundaryAccesses("// R5 clients use " + name + "(rows) at the adapter boundary.")).toEqual([]);
    }
    for (const name of [
      "../src/execution/engine.ts",
      "../src/canonical/compile.ts",
      "../src/canonical/format-course.ts",
    ]) {
      const text = readFileSync(new URL(name, import.meta.url), "utf8");
      expect(forbiddenModuleSpecifiers(text)).toEqual([]);
      expect(wireBoundaryAccesses(text)).toEqual([]);
    }
  });
  it("R5 import/export are independent native adapters, never complete R6 intermediate workflows",()=>{
    const writer=readFileSync(new URL("../src/adapters/r5-course.ts",import.meta.url),"utf8");
    const reader=readFileSync(new URL("../src/adapters/r5-import.ts",import.meta.url),"utf8");
    const calledFunctions = (text: string): string[] => {
      const source = ts.createSourceFile("adapter.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const imports = new Map<string, string>(), namespaces = new Set<string>(), calls: string[] = [];
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement)) continue;
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings))
          for (const binding of bindings.elements) imports.set(binding.name.text, (binding.propertyName ?? binding.name).text);
        else if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      }
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const callee = node.expression;
          if (ts.isIdentifier(callee)) calls.push(imports.get(callee.text) ?? callee.text);
          else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && namespaces.has(callee.expression.text))
            calls.push(callee.name.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      return calls;
    };
    expect(calledFunctions('import { courseToR6 as lower } from "./canonical-course"; lower(course);')).toEqual(["courseToR6"]);
    expect(calledFunctions('import * as adapter from "./canonical-course"; adapter.courseToR6(course);')).toEqual(["courseToR6"]);
    expect(calledFunctions('// courseToR6(course) is forbidden here.')).toEqual([]);
    const forbidden = new Set(["courseToR6", "projectCourseToR6", "courseFromR6", "administrationToR6", "fromR6Dosage", "toDosageDetails"]);
    for (const source of [writer, reader]) expect(calledFunctions(source).filter(name => forbidden.has(name))).toEqual([]);
    expect(calledFunctions(writer)).toContain("administrationToR5");
    expect(calledFunctions(reader)).toContain("administrationFromR5");
  });
  it("the original public scheduling file is only an input adapter, not a second engine", () => {
    const text = readFileSync(new URL("../src/schedule.ts", import.meta.url), "utf8");
    expect(text).toContain("inputToCanonical");
    expect(text).toContain('from "./execution/engine"');
    expect(text).not.toMatch(/function (?:treatmentStepWindow|calculateCourseTotalUnits|scheduleRegimen)/u);
  });
  it("parser owns a native course before projecting either FHIR version", () => {
    const parsed = parseSig("2 tabs morning, 1 tab evening for 1 week, then 1 tab morning for 1 week");
    const native = parsed.meta.canonical.course!;
    expect(native.kind).toBe("course");
    expect(native.stages.map((s) => s.administrations.length)).toEqual([2, 1]);
    expect(native.stages[0].administrations.map((a) => a.amounts?.[0].quantity?.value)).toEqual([2, 1]);
    expect(inputToCanonical(parsed)).toBe(native);
    for (const input of [native, parsed, parsed.fhirNext, parsed.fhir]) {
      expect(nextDueDoses(input, { ...options, limit: 3 })).toEqual([
        "2026-11-02T08:00:00+07:00",
        "2026-11-02T19:00:00+07:00",
        "2026-11-03T08:00:00+07:00",
      ]);
    }
    expect(nativeSupply({ ...options, dosage: native }).totalUnits).toBe(9);
  });
});

describe("native course and sibling projections", () => {
  it("preserves external element/coding metadata exactly on untouched R6 import/export", () => {
    const input = cloneStructuredValue(source);
    const original = cloneStructuredValue(input);
    const native = courseFromR6(input, true);
    expect(courseToR6(native)).toEqual(original);
    expect(input).toEqual(original);
    expect(fromFhir(input).meta.canonical.course?.kind).toBe("course");
    expect(input).toEqual(original);
  });
  it("clearing one target side cannot resurrect it from the retained CodeableReference wrapper", () => {
    const native = cloneStructuredValue(courseFromR6(source, true));
    native.stages[0].administrations[0].siteReference = undefined;
    const a = courseToR6(native).step[0].component[0];
    expect(a.site?.concept?.text).toBe("left eye");
    expect(a.site).not.toHaveProperty("reference");
    expect(a.site?.id).toBe("site-wrapper");
    expect(a.site?.extension).toEqual(source.step[0].component[0].site?.extension);
  });
  it("known maximum edits and removals govern native export without dropping unknown safety siblings", () => {
    const raw: FhirR6DosageInstruction = {
      step: [
        {
          component: [
            {
              doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
              safety: {
                id: "safety-source",
                ifExceeded: "contact prescriber",
                doseLimit: [
                  { id: "limit-a", scope: "administration", valueQuantity: { value: 2, unit: "tab" } },
                  {
                    id: "limit-b",
                    scope: "lifetime",
                    valueExpression: { language: "text/fhirpath", expression: "%external.total" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const native = cloneStructuredValue(courseFromR6(raw, true)),
      a = native.stages[0].administrations[0];
    a.limits![0].amount = { value: 3, unit: "tab" };
    let out = courseToR6(native).step[0].component[0];
    expect(out.safety?.doseLimit?.[0]).toMatchObject({ id: "limit-a", valueQuantity: { value: 3 } });
    expect(out.safety?.doseLimit?.[1]).toEqual(raw.step[0].component[0].safety?.doseLimit?.[1]);
    expect(out.safety?.ifExceeded).toBe("contact prescriber");
    const removed = cloneStructuredValue(courseFromR6(structuredClone(raw), true));
    removed.stages[0].administrations[0].limits!.splice(0, 1);
    out = courseToR6(removed).step[0].component[0];
    expect(out.safety?.doseLimit).toHaveLength(1);
    expect(out.safety?.doseLimit?.[0].id).toBe("limit-b");
  });
  it("a changed native condition becomes the structured current predicate", () => {
    const raw: FhirR6DosageInstruction = {
      step: [
        {
          component: [
            {
              condition: [{ text: "Original guard", code: { text: "Original guard" } }],
              doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
            },
          ],
        },
      ],
    };
    const c = cloneStructuredValue(courseFromR6(raw, true));
    c.stages[0].administrations[0].predicate = {
      kind: "measurement",
      name: "SBP",
      operation: "gt",
      value: 160,
      text: "SBP >160",
    };
    const exported = courseToR6(c);
    expect(exported.step[0].component[0].condition?.[0]).toMatchObject({
      operation: "gt",
      valueQuantity: { value: 160 },
    });
    expect(raw.step[0].component[0].condition?.[0].text).toBe("Original guard");
    const cleared = cloneStructuredValue(courseFromR6(structuredClone(raw), true));
    cleared.stages[0].administrations[0].predicate = undefined;
    expect(courseToR6(cleared).step[0].component[0]).not.toHaveProperty("condition");
  });
});

describe("native ownership of source-encoded semantics", () => {
  it("exports edited month-day membership and clears a source delay without resurrecting annotations", () => {
    const external: FhirR6DosageInstruction = {
      step: [
        {
          component: [
            {
              modifierExtension: [
                {
                  url: ADMINISTRATION_OFFSET_EXTENSION_URL,
                  valueQuantity: { value: 5, unit: "min", code: "min" },
                },
              ],
              timing: {
                repeat: {
                  frequency: 1,
                  period: 1,
                  periodUnit: "d",
                  timeOfDay: ["08:00:00"],
                  extension: [
                    { url: TIMING_DAY_OF_MONTH_EXTENSION_URL, valuePositiveInt: 1 },
                    { url: "urn:test:unrecognized", valueString: "retained" },
                  ],
                },
              },
              doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
            },
          ],
        },
      ],
    };
    const native = cloneStructuredValue(courseFromR6(external, true));
    const a = native.stages[0].administrations[0];
    a.schedule!.recurrence!.monthDays = [15];
    a.delayMinutes = undefined;
    const out = courseToR6(native);
    expect(out.step[0].component[0].timing?.repeat?.extension?.filter(
      marker => marker.url === TIMING_DAY_OF_MONTH_EXTENSION_URL
    )).toEqual([{
      url: TIMING_DAY_OF_MONTH_EXTENSION_URL,
      valuePositiveInt: 15,
    }]);
    expect(out.step[0].component[0].timing?.repeat?.extension).toContainEqual({
      url: "urn:test:unrecognized",
      valueString: "retained",
    });
    expect(
      out.step[0].component[0].modifierExtension?.some((e) => e.url === ADMINISTRATION_OFFSET_EXTENSION_URL)
    ).not.toBe(true);
    const request = { ...options, limit: 2 };
    expect(nextDueDoses(native, request)).toEqual(["2026-11-15T08:00:00+07:00", "2026-12-15T08:00:00+07:00"]);
    expect(nextDueDoses(out, request)).toEqual(nextDueDoses(native, request));
    expect(nextDueDoses(courseToR5(native), request)).toEqual(nextDueDoses(native, request));
    expect(external.step[0].component[0].timing?.repeat?.extension?.[0].valuePositiveInt).toBe(1);
  });
  it("a fractional native offset is one clinical field and one correct wire encoding", () => {
    const native = cloneStructuredValue(courseFromR6(
      {
        step: [
          {
            component: [
              {
                timing: {
                  repeat: {
                    frequency: 1,
                    period: 1,
                    periodUnit: "d",
                    when: ["MORN"],
                    extension: [{ url: TIMING_OFFSET_EXACT_EXTENSION_URL, valueDecimal: 0.5 }],
                  },
                },
                doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
              },
            ],
          },
        ],
      },
      true
    ));
    const r = native.stages[0].administrations[0].schedule!.recurrence!;
    expect(r.offset).toBe(0.5);
    r.offset = 1.5;
    const out = courseToR6(native);
    expect(out.step[0].component[0].timing?.repeat?.extension?.filter(
      marker => marker.url === TIMING_OFFSET_EXACT_EXTENSION_URL
    )).toEqual([{ url: TIMING_OFFSET_EXACT_EXTENSION_URL, valueDecimal: 1.5 }]);
    expect(courseFromR6(out).stages[0].administrations[0].schedule?.recurrence?.offset).toBe(1.5);
  });
  it("exports native target multiplicity once while retaining the source site identity", () => {
    const native = cloneStructuredValue(courseFromR6(source, true));
    native.stages[0].administrations[0].targetCount = 2;
    const out = courseToR6(native);
    const a = courseFromR6(out).stages[0].administrations[0];
    expect(a.targetCount).toBe(2);
    expect(out.step[0].component[0].site?.id).toBe("site-wrapper");
    expect(calculateTotalUnits({ ...options, dosage: native }).totalUnits).toBe(6);
    expect(calculateTotalUnits({ ...options, dosage: out }).totalUnits).toBe(6);
  });
});

describe("typed external boundary anchors", () => {
  it("retains resource/event/path anchors as understood references but never guesses treatment-start execution", () => {
    const forms = [
      { contextReference: { reference: "Observation/anchor" }, anchor: "resource-reference" },
      { contextDefinition: "https://example.org/StructureDefinition/visit", anchor: "definition" },
      { contextReference: { reference: "Patient/anchor" }, contextPath: "startDate", anchor: "resource-reference" },
      { contextCode: { coding: [{ system: "urn:events", code: "trigger" }] }, anchor: "coded-event" }
    ] as const;
    for (const form of forms) {
      const { anchor, ...relative } = form;
      const input: FhirR6DosageInstruction = {
        step: [{ start: { ...relative, offsetDuration: { value: 2, unit: "d", code: "d" } },
          component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
            timing: { repeat: { frequency: 1, period: 1, periodUnit: "d" } } }] }]
      };
      const native = courseFromR6(input);
      expect(native.stages[0].start?.anchor).toBe(anchor);
      expect(courseToR6(native)).toEqual(input);
      expect(() => nextDueDoses(native, options)).toThrow("Unsupported R6 step RelativeTime: requires a treatment-start offset");
    }
  });
});

describe("typed native safety and coding ownership", () => {
  it("retains parsed clinical period maxima while FHIR R5/R6 projections add complete standardized unit coding", () => {
    const parsed = parseSig("Take 2 tabs QID max 2 tabs/day");
    const native = parsed.meta.canonical.course!;
    const administration = native.stages[0].administrations[0];
    expect(administration.safety?.maximaDeclared).toBe(true);
    expect(administration.limits).toEqual([{
      scope: "period",
      amount: { value: 2, unit: "tab" },
      period: { value: 1, unit: "d" }
    }]);
    const projected = projectCanonicalCourse(native);
    const r5 = projected.fhir[0].maxDosePerPeriod![0];
    expect(r5.numerator).toMatchObject({
      value: 2, unit: "tab", system: "http://standardterms.edqm.eu", code: "15054000"
    });
    expect(r5.denominator).toMatchObject({
      value: 1, unit: "d", system: "http://unitsofmeasure.org", code: "d"
    });
    const r6 = projected.fhirNext.step[0].component[0].safety!;
    expect(r6.doseLimit).toEqual([{
      scope: "period",
      valueQuantity: { value: 2, unit: "tab", system: "http://standardterms.edqm.eu", code: "15054000" },
      period: { value: 1, unit: "d", system: "http://unitsofmeasure.org", code: "d" },
    }]);
  });
});


describe("November 17 review: live native clinical facts own projection and realization", () => {
  it("removing a native administration limit clears it from R6 without dropping unrelated safety annotations", () => {
    const raw: FhirR6DosageInstruction = {
      step: [
        {
          component: [
            {
              safety: {
                id: "policy",
                ifExceeded: "contact prescriber",
                extension: [{ url: "urn:external:safety", valueString: "retain" }],
                doseLimit: [{ scope: "administration", valueQuantity: { value: 2, unit: "tab" } }],
              },
              doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
            },
          ],
        },
      ],
    };
    const native = cloneStructuredValue(courseFromR6(raw, true));
    expect(native.stages[0].administrations[0].limits).toHaveLength(1);
    native.stages[0].administrations[0].limits = undefined;
    const exported = courseToR6(native).step[0].component[0].safety!;
    expect(exported.doseLimit).toBeUndefined();
    expect(exported.id).toBe("policy");
    expect(exported.ifExceeded).toBe("contact prescriber");
    expect(exported.extension).toEqual(raw.step[0].component[0].safety?.extension);
  });

  it("R5 retained site metadata cannot restore explicitly cleared native concept/reference", () => {
    const native = cloneStructuredValue(courseFromR6(source, true));
    const a = native.stages[0].administrations[0];
    a.siteReference = undefined;
    let rows = courseToR5(native);
    let reopened = inputToCanonical(rows);
    expect("stages" in reopened && reopened.stages[0].administrations[0].siteReference).toBeUndefined();
    expect("stages" in reopened && reopened.stages[0].administrations[0].target?.text).toBe("left eye");
    const cleared = cloneStructuredValue(courseFromR6(structuredClone(source), true));
    cleared.stages[0].administrations[0].siteReference = undefined;
    cleared.stages[0].administrations[0].target = undefined;
    rows = courseToR5(cleared);
    reopened = inputToCanonical(rows);
    if (!("stages" in reopened)) throw new Error("R5 course metadata lost");
    expect(reopened.stages[0].administrations[0].target).toBeUndefined();
    expect(reopened.stages[0].administrations[0].siteReference).toBeUndefined();
  });
});

describe("November 17 review: typed course ownership without inferred exact bounds", () => {
  it("does not create an exact stage cutover from two approximate seven-day components", async () => {
    const { courseFromAdministrations } = await import("../src/canonical/compile");
    const length = { value: 7, unit: "d", code: "d", comparator: "~" as const };
    const administration = (clock: string) => ({
      kind: "administration" as const,
      stageOrdinal: 1,
      amounts: [{ quantity: { value: 1, unit: "tab" } }],
      schedule: {
        recurrence: {
          frequency: 1,
          period: 1,
          periodUnit: "d" as const,
          clocks: [clock],
          courseLength: length,
        },
      },
    });
    const course = courseFromAdministrations(
      [administration("08:00:00"), administration("20:00:00")],
      "Take twice daily for approximately one week"
    );
    expect(course.stages).toHaveLength(1);
    expect(course.stages[0].end).toBeUndefined();
    expect(course.stages[0].administrations).toHaveLength(2);
    expect(
      course.stages[0].administrations.every((a) => a.schedule?.recurrence?.courseLength?.comparator === "~")
    ).toBe(true);
  });

  it("intersects compatible administration maxima without replacing a contradictory stated dose", async () => {
    const { numericAdministrationLimits } = await import("../src/canonical/course");
    const native = {
      kind: "administration" as const,
      amounts: [{ quantity: { value: 1, unit: "tab" } }],
      schedule: { recurrence: { frequency: 1, period: 1, periodUnit: "d" as const, clocks: ["08:00:00"] } },
      limits: [
        { scope: "administration" as const, amount: { value: 2, unit: "tab" } },
        { scope: "administration" as const, amount: { value: 0.5, unit: "tab" } },
      ],
    };
    for (const limits of [native.limits, native.limits.slice().reverse()]) {
      const variant = { ...native, limits };
      expect(numericAdministrationLimits(variant)).toMatchObject({
        multiple: false,
        administration: { value: 0.5, unit: "tab" },
      });
      const calculated = calculateTotalUnits({ ...options, dosage: variant });
      expect(calculated.totalUnits).toBe(3);
      expect(calculated.quantityKind).toBe("maximum");
      expect(calculated.explanation).toContain("could not be applied");
    }
  });
});


describe("round 24: live projection and course boundaries", () => {
  it("shows reference-only site display without inventing a coding or replacing the Reference", () => {
    const reference = {
      id: "external-site", reference: "BodyStructure/left", display: "left eye",
      extension: [{ url: "urn:test:reference-detail", valueString: "preserved" }],
    };
    const wire: FhirR6DosageInstruction = {
      renderedInstruction: "Instill one drop in the right eye twice daily.",
      step: [{ component: [{
        site: { reference },
        doseAndRate: [{ doseQuantity: { value: 1, unit: "drop", code: "[drp]",
          system: "http://unitsofmeasure.org" } }],
        timing: { repeat: { frequency: 2, period: 1, periodUnit: "d" } },
      }] }],
    };
    const course = courseFromR6(wire);
    const member = course.stages[0].administrations[0];
    expect(member.target).toBeUndefined();
    expect(member.siteReference).toEqual(reference);
    expect(clauseForAdministration(member).site).toEqual({
      text: "left eye", administrationTargetCount: undefined,
    });
    const oneDrop = /(?:^|\s)1 drop(?=\s|[.;,]|$)/u;
    for (const changed of ["Instill 11 drops into the left eye twice daily",
      "Instill 0.1 drop into the left eye twice daily"])
      expect(changed).not.toMatch(oneDrop);
    for (const preview of [
      formatSig(wire, "long", { locale: "en" }),
      fromFhir(wire, { locale: "en" }).longText,
      formatCanonicalCourse(course, "long", { locale: "en" }),
    ]) {
      expect(preview).toMatch(oneDrop);
      expect(preview).toContain("left eye");
      expect(preview.split("; original directions:")[0]).not.toContain("right eye");
      expect(preview).toContain("; original directions: " + wire.renderedInstruction);
    }
    const saved = courseToR6(inputToCanonical(JSON.parse(JSON.stringify(courseToR5(course)))));
    expect(saved.step[0].component![0].site?.reference).toEqual(reference);
    expect(saved.step[0].component![0].site?.concept).toBeUndefined();

    const conceptBacked = structuredClone(wire);
    conceptBacked.step[0].component![0].site!.concept = { text: "left lower eyelid" };
    expect(formatSig(conceptBacked, "long", { locale: "en" })).toContain("left lower eyelid");
  });

  it.each([
    [1.5, [
      "2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00",
      "2026-01-02T08:00:00+00:00",
    ], 4],
    [2, [
      "2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00",
      "2026-01-02T08:00:00+00:00", "2026-01-02T20:00:00+00:00",
    ], 6],
  ] as const)("keeps a %s-day component course executable without an unsupported shared boundary", (days, due, total) => {
    const parsed = parseSig(
      "Take 1 tab at 08:00 for " + days + " days; take 2 tabs at 20:00 for " + days + " days",
    );
    const course = inputToCanonical(parsed);
    expect(course.stages).toHaveLength(1);
    expect(course.stages[0].administrations).toHaveLength(2);
    if (days === 1.5) expect(course.stages[0].end).toBeUndefined();
    else expect(course.stages[0].end?.displacement?.value).toBe(2);
    for (const administration of course.stages[0].administrations)
      expect(administration.schedule?.recurrence?.courseLength?.value).toBe(days);
    const query = {
      orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-01T00:00:00Z",
      timeZone: "UTC", limit: 10,
    };
    for (const input of [parsed, parsed.fhir, parsed.fhirNext]) {
      expect(nextDueDoses(input, query)).toEqual(due);
      expect(calculateTotalUnits({
        ...query, dosage: input, durationValue: 3, durationUnit: "d",
      }).totalUnits).toBe(total);
    }
  });

  it.each([undefined, []])("labels the original zero-step header separately from the live cap (steps=%s)", step => {
    const wire = {
      renderedInstruction: "maximum 3 administrations", step,
      safety: { doseLimit: [{ scope: "dosage" as const, valueInteger: 2 }] },
    };
    for (const preview of [
      formatSig(wire, "long", { locale: "en" }),
      fromFhir(wire, { locale: "en" }).longText,
    ]) {
      expect(preview).toBe("Current: Across this course: max per dosage: 2 administrations; original directions: maximum 3 administrations");
      const [current, original] = preview.split("; original directions: ");
      expect(current).toBe("Current: Across this course: max per dosage: 2 administrations");
      expect(current).not.toContain("3 administrations");
      expect(original).toBe("maximum 3 administrations");
    }
    const saved = courseToR6(inputToCanonical(wire));
    expect(saved.renderedInstruction).toBe("maximum 3 administrations");
    expect(saved.safety?.doseLimit).toEqual([{ scope: "dosage", valueInteger: 2 }]);
    expect(saved.step).toBeUndefined();
  });

  it("keeps a genuine text-only R6 header literal", () => {
    const wire = { renderedInstruction: "Follow the supplied instructions." };
    expect(formatSig(wire, "long", { locale: "en" })).toBe(wire.renderedInstruction);
    expect(fromFhir(wire, { locale: "en" }).longText).toBe(wire.renderedInstruction);
  });

  it("captures fresh timing ownership for a dose-less graph and retains its source after an external clock edit", () => {
    const row = structuredClone(parseSig("Swallow slowly with water at 08:00").fhir[0]);
    const original = JSON.stringify(row.extension);
    const authoredText = row.text;
    const options = { locale: "en", realizationMode: "roundtrip" as const };
    expect(row.doseAndRate).toBeUndefined();
    expect(formatSig(structuredClone(row), "long", options)).toContain("08:00");
    row.timing!.repeat!.timeOfDay = ["10:00:00"];
    const submitted = structuredClone(row);
    const preview = formatSig(submitted, "long", options);
    expect(preview).toContain("10:00");
    expect(preview).not.toContain("08:00");
    expect(preview).toContain("slowly");
    expect(preview).toContain("water");
    expect(submitted.text).toBe(authoredText);
    expect(JSON.stringify(submitted.extension)).toBe(original);
    expect(row.text).toBe(authoredText);
    expect(JSON.stringify(row.extension)).toBe(original);
  });
});

// Consolidated from pr14-native-edit-family.spec.ts; all eight clinical cases retained.
{
const asCourse = (input: CanonicalScheduleInput): CanonicalCourse => {
  if ("kind" in input) return input.kind === "course"
    ? input : { kind: "course", stages: [{ administrations: [input] }] };
  return { kind: "course", stages: [{ administrations: [...input] }] };
};
const member = (input: CanonicalScheduleInput) => asCourse(input).stages[0].administrations[0];

describe("compiled clinical facts and source units survive projection", () => {

  it("keeps seven days of dosing after a shared two-day stage delay", () => {
    const dose = (value: number): CanonicalAdministration => ({ kind: "administration",
      delayMinutes: 2 * 1440, amounts: [{ quantity: { value, unit: "tab" } }],
      schedule: { recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        courseLength: { value: 7, unit: "d" } } } });
    const after = courseFromAdministrations([dose(1), dose(2)], "");
    expect(after.stages[0].start!.displacement).toMatchObject({ value: 48, unit: "h" });
    expect(after.stages[0].end).toBeUndefined();
    const options = { from: "2026-01-01T00:00:00Z", orderedAt: "2026-01-01T00:00:00Z",
      timeZone: "UTC", durationValue: 14, durationUnit: FhirPeriodUnit.Day };
    for (const input of [after, courseToR6(after), courseToR5(after)]) {
      const supply = "kind" in input
        ? calculateTotalUnits({ ...options, dosage: input })
        : calculateTotalUnits({ ...options, dosage: input });
      expect(supply.totalUnits).toBe(21);
      const due = nextDueDoses(input, { ...options, limit: 20 });
      expect(due).toHaveLength(14);
      expect(due.map(instant => instant.slice(0, 10))).toEqual(
        Array.from({ length: 7 }, (_, day) => `2026-01-${String(day + 3).padStart(2, "0")}`)
          .flatMap(day => [day, day])
      );
    }
  });

  it("retains the derived unshifted stage end and avoids one for a qualified duration", () => {
    const dose = (): CanonicalAdministration => ({ kind: "administration",
      amounts: [{ quantity: { value: 1, unit: "tab" } }],
      schedule: { recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        courseLength: { value: 7, unit: "d" } } } });
    const first = dose(), second = dose();
    expect(courseFromAdministrations([first, second], "").stages[0].end!.displacement).toMatchObject({ value: 7, unit: "d" });
    const approximateFirst = dose(), approximateSecond = dose();
    approximateFirst.schedule!.recurrence!.courseLength!.comparator = "~";
    approximateSecond.schedule!.recurrence!.courseLength!.comparator = "~";
    expect(courseFromAdministrations([approximateFirst, approximateSecond], "").stages[0].end).toBeUndefined();
  });

  it.each([
    [{ value: 500, system: "http://unitsofmeasure.org", code: "mg" }, "mg", "500 mg"],
    [{ value: 2, system: "http://standardterms.edqm.eu", code: "15054000" }, "tab", "2 tablets"],
    [{ value: 1, system: "urn:test:units", code: "custom-unit" }, "custom-unit", "custom-unit"],
  ] as const)("retains a code-only scalar dose unit in generated wording", (quantity, expectedUnit, wording) => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: [{ doseQuantity: quantity }] }] }] };
    const course = courseFromR6(raw, true);
    expect(clauseForAdministration(member(course)).dose!.unit).toBe(expectedUnit);
    expect(formatSig(course, "long", { locale: "en" })).toContain(wording);
    expect(courseToR6(course).step![0].component[0].doseAndRate![0].doseQuantity).toEqual(quantity);
  });

  it.each(["coded", "authored"] as const)("preserves independent %s units on a mixed-unit dose range", kind => {
    const range = kind === "coded" ? {
      low: { value: 500, system: "http://unitsofmeasure.org", code: "mg" },
      high: { value: 1, system: "http://unitsofmeasure.org", code: "g" },
    } : { low: { value: 500, unit: "mg" }, high: { value: 1, unit: "g" } };
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseRange: range }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
    }] }] };
    const course = courseFromR6(raw, true);
    const rendered = formatSig(course, "long", { locale: "en" });
    expect(rendered).toContain("500 mg – 1 g");
    expect(rendered).not.toMatch(/500[–-]1 mg/);
    expect(rendered).toContain("once daily");
    expect(courseToR6(course).step![0].component[0].doseAndRate![0].doseRange).toEqual(range);
  });

  it("retains independent endpoint comparators without duplicating the range across stages", () => {
    const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [{
      kind: "administration", amounts: [{ range: {
        low: { value: 500, unit: "mg", comparator: ">=" },
        high: { value: 1000, unit: "mg", comparator: "<=" },
      } }], schedule: { recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
    }] }, { administrations: [{
      kind: "administration", amounts: [{ quantity: { value: 250, unit: "mg" } }],
    }] }] };
    const rendered = formatSig(course, "long", { locale: "en" });
    expect(rendered).toContain(">=500–<=1000 mg");
    expect(rendered).toContain("250 mg");
    expect(rendered.split(">=500–<=1000 mg")).toHaveLength(2);
    expect(rendered).not.toMatch(/(?<!>=)500[–-]1000 mg/);
    expect(member(course).amounts![0].range!.high!.comparator).toBe("<=");
  });

});

}


describe("display and replay family boundaries", () => {

const tablet: FhirR6Dosage = {
  doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
  timing: { repeat: { frequency: 4, period: 1, periodUnit: FhirPeriodUnit.Day } },
};
const daily = { value: 1, unit: "d" };

describe("source-less limit wording retains value and ownership", () => {
  it("shows an integer period cap alongside the four-times-daily instruction", () => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      ...tablet, safety: { doseLimit: [{ scope: "period", valueInteger: 2, period: daily }] },
    }] }] };
    const course = courseFromR6(raw);
    const text = formatCanonicalCourse(course, "long", { locale: "en" });
    expect(text).toContain("four times daily");
    expect(text).toContain("max per period: 2 administrations / 1 d");
    expect(course.stages[0].administrations[0].limits?.[0].count).toBe(2);
    expect(fromFhir(raw, { locale: "en" }).longText)
      .toContain("max per period: 2 administrations / 1 d");
  });

  it.each(["period", "administration", "dosage", "lifetime"] as const)(
    "retains the %s scope for quantity, integer and unevaluated expression limits",
    (scope) => {
      const limits: FhirR6DoseLimit[] = [
        { scope, valueQuantity: { value: 8, unit: "tab" }, ...(scope === "period" ? { period: daily } : {}) },
        { scope, valueInteger: 2, ...(scope === "period" ? { period: daily } : {}) },
        { scope, valueExpression: { language: "text/fhirpath", expression: "weight * 2" },
          ...(scope === "period" ? { period: daily } : {}) },
      ];
      const course = courseFromR6({ step: [{ component: [{ ...tablet, safety: { doseLimit: limits } }] }] });
      const text = formatCanonicalCourse(course, "long", { locale: "en" });
      const label = scope === "period" ? "max per period:" :
        scope === "administration" ? "max per administration:" :
        scope === "dosage" ? "max per dosage:" : "max lifetime:";
      expect(text).toContain(label + " 8 tab");
      expect(text).toContain(label + " 2 administrations");
      expect(text).toContain(label + " unevaluated dose expression: weight * 2");
    },
  );

  it("shows a course-wide quantity cap exactly once for a simple course", () => {
    const course = courseFromR6({
      safety: { doseLimit: [{ scope: "period", valueQuantity: { value: 8, unit: "tab" }, period: daily }] },
      step: [{ component: [tablet] }],
    });
    const text = formatCanonicalCourse(course, "long", { locale: "en" });
    expect(text).toContain("Across this course: max per period: 8 tab / 1 d");
    expect(text.split("8 tab").length - 1).toBe(1);
    expect(course.stages[0].administrations[0].limits).toBeUndefined();
  });

  it("keeps course and stage caps outside member wording in a multi-stage plan", () => {
    const course = courseFromR6({
      safety: { doseLimit: [{ scope: "lifetime", valueInteger: 12 }] },
      step: [
        { component: [tablet, tablet], safety: {
          doseLimit: [{ scope: "period", valueInteger: 2, period: daily }],
        } },
        { component: [tablet] },
      ],
    });
    const text = formatCanonicalCourse(course, "long", { locale: "en" });
    expect(text).toContain("Within this stage: max per period: 2 administrations / 1 d");
    expect(text).toContain("Across this course: max lifetime: 12 administrations");
    expect(text.split("max per period:").length - 1).toBe(1);
    expect(text.split("max lifetime:").length - 1).toBe(1);
  });

  it("keeps the new scope labels and counts behind the existing locale facet", () => {
    registerSigLocalization({
      locale: "limit-family",
      formatLong: () => "Dose locale.",
      course: { ...ENGLISH_COURSE,
        courseLimitsLabel: "Cours: ", stageLimitsLabel: "Étape: ",
        maxPeriodLabel: "Plafond: ", administrations: (value) => value + " prises",
      },
    });
    const course = courseFromR6({
      safety: { doseLimit: [{ scope: "period", valueInteger: 2, period: daily }] },
      step: [{ component: [tablet] }],
    });
    expect(formatCanonicalCourse(course, "long", { locale: "limit-family" }))
      .toContain("Cours: Plafond: 2 prises / 1 d");
    expect(formatCanonicalCourse(course, "long", { locale: "th" }))
      .toContain("ตลอดแผนการใช้ยานี้: max per period: ให้ยา 2 ครั้ง / 1 d");
  });
});

describe("partial explicit calendar events remain visible", () => {
  it("retains year/month precision without fabricating a full date", () => {
    const course = courseFromR6({ step: [{ component: [{
      doseAndRate: tablet.doseAndRate,
      timing: { event: ["2026", "2026-11", "2026-11-20"] },
    }] }] });
    expect(formatCanonicalCourse(course, "long", { locale: "en" }))
      .toMatch(/Scheduled events: 2026, 2026-11(?![0-9-])/u);
    expect(formatCanonicalCourse(course, "long", { locale: "th" }))
      .toMatch(/วันที่กำหนด: 2026 และ 2026-11(?![0-9-])/u);
    expect(formatCanonicalCourse(course, "long", { locale: "en" })).toContain("on 20 Nov 2026");
    expect(formatCanonicalCourse(course, "long", { locale: "th" })).toContain("วันที่ 20/11/2569");
    for (const locale of ["en", "th"]) {
      const text = formatCanonicalCourse(course, "long", { locale });
      expect(text).not.toMatch(/2026-00|2026-11-00|2026-00-00/u);
      expect(text).not.toContain("NaN");
    }
    expect(course.stages[0].administrations[0].schedule?.explicitEvents)
      .toEqual(["2026", "2026-11", "2026-11-20"]);
  });
});

function savedRow(): FhirDosage {
  const row: FhirDosage = {
    doseAndRate: [{ doseQuantity: { value: 1, unit: "tab", code: "tab", system: "urn:unit" } }],
    timing: {
      event: ["2026-11-20T08:00:00Z", "2026-11-21T08:00:00Z"],
      code: { text: "BID", coding: [{ code: "BID", system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation" }] },
      repeat: {
        frequency: 1, frequencyMax: 2, period: 1, periodMax: 2,
        periodUnit: FhirPeriodUnit.Day, count: 3, countMax: 4,
        duration: 1, durationMax: 2, durationUnit: FhirPeriodUnit.Hour,
        dayOfWeek: [FhirDayOfWeek.Monday, FhirDayOfWeek.Wednesday], timeOfDay: ["08:00:00", "20:00:00"],
        when: [EventTiming["Before Breakfast"], EventTiming["Before Dinner"]], offset: 15,
        boundsDuration: { value: 7, unit: "d" },
      },
    },
  };
  return withDosageEditProvenance([row], "Original source")[0];
}
describe("saved R5 source replay observes all live timing values", () => {
  const edits: Array<[string, (row: FhirDosage) => void]> = [
    ["later clock", row => { row.timing!.repeat!.timeOfDay![1] = "22:00:00"; }],
    ["later weekday", row => { row.timing!.repeat!.dayOfWeek![1] = FhirDayOfWeek.Friday; }],
    ["later event", row => { row.timing!.event![1] = "2026-11-22T08:00:00Z"; }],
    ["later meal anchor", row => { row.timing!.repeat!.when![1] = EventTiming["After Dinner"]; }],
    ["timing abbreviation", row => { row.timing!.code!.coding![0].code = "TID"; }],
    ["timing description", row => { row.timing!.code!.text = "three times daily"; }],
    ["frequency maximum", row => { row.timing!.repeat!.frequencyMax = 3; }],
    ["period maximum", row => { row.timing!.repeat!.periodMax = 3; }],
    ["period unit", row => { row.timing!.repeat!.periodUnit = FhirPeriodUnit.Week; }],
    ["count maximum", row => { row.timing!.repeat!.countMax = 5; }],
    ["duration", row => { row.timing!.repeat!.duration = 2; }],
    ["duration maximum", row => { row.timing!.repeat!.durationMax = 3; }],
    ["duration unit", row => { row.timing!.repeat!.durationUnit = FhirPeriodUnit.Minute; }],
    ["meal offset", row => { row.timing!.repeat!.offset = 30; }],
    ["course length", row => { row.timing!.repeat!.boundsDuration!.value = 14; }],
    ["dose unit system", row => { row.doseAndRate![0].doseQuantity!.system = "urn:other-unit"; }],
  ];
  it.each(edits)("verifies a fresh submission after changing the %s", (_, edit) => {
    const row = savedRow();
    expect(dosageMatchesSavedProjection(structuredClone(row))).toBe(true);
    edit(row);
    expect(dosageMatchesSavedProjection(structuredClone(row))).toBe(false);
  });

  it.each(["fresh", "persisted"] as const)(
    "invalidates the %s authored Thai source after editing its second clock", (kind) => {
    const source = "ล้างมือก่อนหยอดตา หยอดตาขวา 1 หยด เวลา 08:00 และ 20:00 แล้วหลับตา";
    const parsed = parseSig(source, { locale: "th" });
    const row = structuredClone(kind === "fresh" ? parsed.fhir[0]
      : JSON.parse(JSON.stringify(parsed.fhir[0])) as FhirDosage);
    const options = { locale: "th", realizationMode: "roundtrip" as const };
    expect(formatSig(structuredClone(row), "long", options)).toBe(source);
    row.timing!.repeat!.timeOfDay![1] = "22:00:00";
    const edited = formatSig(structuredClone(row), "long", options);
    expect(edited).toContain("22:00");
    expect(edited).not.toContain("20:00");
    expect(edited).toContain("1 หยด");
    row.timing!.repeat!.timeOfDay![1] = "20:00:00";
    expect(formatSig(structuredClone(row), "long", options)).toBe(source);
  });

  it("does not replay BID source after a code-only R5 schedule is edited to TID", () => {
    const source = "ล้างมือก่อนหยอดตา หยอดตาขวา 1 หยด bid แล้วหลับตา";
    const parsed = structuredClone(parseSig(source, { locale: "th" }).fhir[0]);
    // A code-only Timing is valid R5. Keep this fixture free of an intentionally
    // contradictory old numeric frequency so the expected new cadence is clear.
    delete parsed.timing!.repeat;
    const row = withDosageEditProvenance([parsed], source)[0];
    const options = { locale: "th", realizationMode: "roundtrip" as const };
    expect(formatSig(structuredClone(row), "long", options)).toBe(source);
    row.timing!.code!.coding![0].code = "TID";
    row.timing!.code!.text = "TID";
    const edited = formatSig(structuredClone(row), "long", options);
    expect(edited).not.toBe(source);
    expect(edited).toContain("3 ครั้ง");
    expect(edited).not.toContain("bid");
  });


});

describe("locale detector registration has stable provider identity", () => {
  it("retains the registered snapshot while allowing an explicit replacement", () => {
    const detector = { locale: "aa", priority: 10, test: (value: string) => value === "__locale_aa__" };
    registerMedicationLocaleDetector(detector);
    detector.locale = "bb";
    detector.test = value => value === "__locale_changed__";
    expect(inferMedicationLocale("__locale_aa__")).toBe("aa");
    expect(inferMedicationLocale("__locale_changed__", "fallback")).toBe("fallback");
    registerMedicationLocaleDetector({ locale: "cc", priority: 20, test: value => value === "__locale_cc__" });
    registerMedicationLocaleDetector({ locale: "aa", priority: 30, test: value => value === "__locale_aa_new__" });
    expect(inferMedicationLocale("__locale_cc__")).toBe("cc");
    expect(inferMedicationLocale("__locale_aa_new__")).toBe("aa");
    expect(inferMedicationLocale("__locale_changed__", "fallback")).toBe("fallback");
  });
});
});


describe("review 26 external display ownership", () => {
  it.each(["fresh", "persisted"] as const)("uses the edited weekday ordinal in a %s graph-backed row", kind => {
    const source = "Swallow 1 tablet whole on the first Monday of each month";
    const parsed = parseSig(source);
    const row = structuredClone(kind === "fresh" ? parsed.fhir[0]
      : JSON.parse(JSON.stringify(parsed.fhir[0])) as FhirDosage);
    const options = { locale: "en", realizationMode: "roundtrip" as const };
    expect(formatSig(structuredClone(row), "long", options)).toContain("first Monday");
    const ordinal = row.timing!.repeat!.extension!.find(x => x.url === TIMING_WEEKDAY_ORDINAL_EXTENSION_URL)!;
    expect(ordinal.valueInteger).toBe(1);
    ordinal.valueInteger = 2;
    for (const text of [formatSig(structuredClone(row), "long", options), fromFhirDosage(structuredClone(row), options).longText]) {
      expect(text).toMatch(/second Monday|2nd Monday/iu);
      expect(text).not.toContain("first Monday");
      expect(text).toContain("1 tablet");
    }
    ordinal.valueInteger = 1;
    expect(formatSig(structuredClone(row), "long", options)).toContain("first Monday");
  });

  it("uses current clock-window endpoints from fresh persisted infusion submissions", () => {
    const source = "Infuse 5 mL/h between 08:00 and 18:00";
    const row = JSON.parse(JSON.stringify(withDosageEditProvenance([{
      text: source, doseAndRate: [{ rateQuantity: { value: 5, unit: "mL/h" } }],
      timing: { repeat: { frequency: 1, period: 2, periodUnit: FhirPeriodUnit.Hour,
        extension: [{ url: TIMING_CLOCK_WINDOW_EXTENSION_URL, extension: [
          { url: "start", valueTime: "08:00:00" }, { url: "end", valueTime: "18:00:00" },
          { url: "endInclusive", valueBoolean: true }
        ] }] } }
    }], source)[0])) as FhirDosage;
    const options = { locale: "en", realizationMode: "roundtrip" as const };
    expect(formatSig(structuredClone(row), "long", options)).toBe(source);
    expect(formatSig(structuredClone(row), "long", options)).toBe(source);
    const window = row.timing!.repeat!.extension![0].extension!;
    window[0].valueTime = "09:00:00";
    const text = formatSig(structuredClone(row), "long", options);
    expect(text).toMatch(/09:00|9:00 am/u);
    expect(text).toMatch(/18:00|6:00 pm/u);
    expect(text).not.toMatch(/08:00|8:00 am/u);
    expect(text).toContain("5 mL/h");
    window[1].valueTime = "17:00:00";
    expect(formatSig(structuredClone(row), "long", options)).toMatch(/17:00|5:00 pm/u);
    expect(formatSig(structuredClone(row), "long", options)).not.toMatch(/18:00|6:00 pm/u);
    window[0].valueTime = "08:00:00";
    window[1].valueTime = "18:00:00";
    expect(dosageMatchesSavedProjection(structuredClone(row))).toBe(true);
    window[2].valueBoolean = false;
    expect(dosageMatchesSavedProjection(structuredClone(row))).toBe(false);
  });

  it.each(["", "."])("does not replay a removed persisted rate beside an unchanged maximum: terminator %s", terminator => {
    const source = "Infuse 5 mL/h, maximum 10 mL per administration";
    const row = JSON.parse(JSON.stringify(withDosageEditProvenance([{
      text: source, doseAndRate: [{ rateQuantity: { value: 5, unit: "mL/h" } }],
      maxDosePerAdministration: { value: 10, unit: "mL" }
    }], source)[0])) as FhirDosage;
    expect(formatSig(structuredClone(row), "long", { realizationMode: "roundtrip" })).toBe(source);
    const unchanged = formatSig(structuredClone(row), "long");
    expect(unchanged).toContain("Rate: 5 mL/h");
    expect(unchanged).toContain("max per administration: 10 mL");
    delete row.doseAndRate![0].rateQuantity;
    for (const text of [formatSig(structuredClone(row), "long"), fromFhirDosage(structuredClone(row)).longText]) {
      expect(text).not.toContain("5 mL/h");
      expect(text).toContain("10 mL");
    }
    row.text = "Clinician replacement instruction: maximum 10 mL" + terminator;
    const currentSource = structuredClone(row);
    const replay = formatSig(structuredClone(row), "long", { realizationMode: "roundtrip" });
    expect(replay).toBe("Clinician replacement instruction: maximum 10 mL; max per administration: 10 mL");
    expect(fromFhirDosage(structuredClone(row), { realizationMode: "roundtrip" }).longText).toBe(replay);
    expect(replay).not.toContain("5 mL/h");
    expect(fromFhirDosage(structuredClone(row)).fhir).toEqual(currentSource);
    const normalized = formatSig(structuredClone(row), "long", { realizationMode: "normalized" });
    expect(formatSig(structuredClone(row), "long")).toBe(normalized);
    expect(normalized).toContain("10 mL");
    expect(normalized).not.toContain("5 mL/h");
  });

  it.each(["en", "th"])("keeps a strict high dose endpoint in both %s public previews", locale => {
    const row: FhirDosage = { doseAndRate: [{ doseRange: {
      low: { value: 2, unit: "mg" }, high: { value: 5, unit: "mg", extension: [{
        url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
        valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000050" }
      }] }
    } }] };
    const expectedDoseAndRate = structuredClone(row.doseAndRate);
    const text = formatSig(row, "long", { locale });
    expect(text).toMatch(/2–<5 mg(?:$|[.;])/u);
    expect(row.doseAndRate).toEqual(expectedDoseAndRate);
    const reopened = fromFhirDosage(row, { locale });
    expect(reopened.longText).toBe(text);
    expect(reopened.shortText).toMatch(/2–<5 mg(?:$|[.;])/u);
    expect(row.doseAndRate).toEqual(expectedDoseAndRate);
    expect(reopened.fhir.doseAndRate).toEqual(expectedDoseAndRate);
  });


});


describe("review 26 independent partial phase boundaries", () => {
  it("keeps the other eye's exact transition beside a missing cutover", () => {
    const source = "1 drop OS QID then BID; 1 drop OD BID for 7 days then QID";
    const parsed = parseSig(source);
    const native = parsed.meta.canonical.course!;
    const saved = JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)));
    for (const course of [native, courseFromR6(parsed.fhirNext), courseFromR6(toDosageDetails(saved))]) {
      expect(course.stages).toHaveLength(1);
      const right = course.stages[0].administrations.filter(a => a.target?.text === "right eye");
      const left = course.stages[0].administrations.filter(a => a.target?.text === "left eye");
      expect(right).toHaveLength(2);
      expect(left).toHaveLength(2);
      // The wire boundary codec can express the scalar origin as a full
      // treatment boundary when this member also owns a successor cutoff.
      if (right[0].phaseStart) expect(right[0].phaseStart.anchor).toBe("treatment-start");
      expect(right[0].phaseStart?.displacement ?? right[0].phaseOrigin).toMatchObject({ value: 0, code: "d" });
      expect(right[0].phaseEnd).toMatchObject({
        anchor: "treatment-start", displacement: { value: 7, code: "d" }
      });
      const length = right[0].schedule?.recurrence?.courseLength;
      expect(length?.value).toBe(7);
      expect(length?.code ?? length?.unit).toBe("d");
      expect(right[1].phaseOrigin).toMatchObject({ value: 7, code: "d" });
      expect(right[1].schedule?.recurrence?.frequency).toBe(4);
      expect(left[1].phaseOrigin).toBeUndefined();
      expect(left[1].phaseStart?.anchor).toBe("unresolved");
    }
    const options = { orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-08T00:00:00Z",
      timeZone: "UTC", limit: 4,
      config: { frequencyDefaultsByCode: { QID: ["08:00", "12:00", "16:00", "20:00"] } } };
    expect(() => nextDueDoses(parsed.fhirNext, options)).toThrow(/relative|resolv|anchor/iu);
    // A clinician can still use the independently complete right-eye track.
    const rightOnly = { ...parsed.fhirNext, step: parsed.fhirNext.step!.map(step => ({ ...step,
      component: step.component.filter(a => a.site?.concept?.text === "right eye") })) };
    expect(nextDueDoses(rightOnly, options)).toEqual([
      "2026-01-08T08:00:00+00:00", "2026-01-08T12:00:00+00:00",
      "2026-01-08T16:00:00+00:00", "2026-01-08T20:00:00+00:00"
    ]);
    expect(calculateTotalUnits({ dosage: rightOnly, ...options,
      durationValue: 1, durationUnit: FhirPeriodUnit.Day })).toMatchObject({ totalUnits: 4, unit: "drop" });
    for (const view of [native, parsed.fhirNext, saved]) {
      const preview = formatSig(view, "long", { locale: "en", realizationMode: "normalized" });
      expect(preview).toContain("7 days after treatment start");
      expect(preview).toContain("Stage timing requires review");
      expect(preview).toContain("right eye");
      expect(preview).toContain("left eye");
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(parsed.longText).toMatch(/right eye|OD/u);
    expect(parsed.longText).toMatch(/left eye|OS/u);
  });
});


it.each(["fresh", "persisted"] as const)("keeps %s clinician text edits and honors an explicit text clear", kind => {
  const parsed = parseSig("Swallow 1 tablet whole at bedtime per the agreed plan.");
  const row = structuredClone(kind === "fresh" ? parsed.fhir[0]
    : JSON.parse(JSON.stringify(parsed.fhir[0])) as FhirDosage);
  const options = { locale: "en", realizationMode: "roundtrip" as const };
  const replacement = "Swallow 1 tablet whole at bedtime after discussion with the clinician.";
  row.text = replacement;
  expect(formatSig(structuredClone(row), "long", options)).toBe(replacement);
  expect(fromFhirDosage(structuredClone(row), options).longText).toBe(replacement);
  const normalized = formatSig(structuredClone(row), "long", { ...options, realizationMode: "normalized" });
  const current = normalized.split("; original directions:")[0];
  expect(current).toContain("1 tablet");
  expect(current).toMatch(/bedtime|on sleep/u);
  expect(current).not.toContain("discussion with the clinician");
  expect(normalized).toContain("; original directions: " + replacement);
  row.text = "";
  for (const text of [formatSig(structuredClone(row), "long", options), fromFhirDosage(structuredClone(row), options).longText]) {
    expect(text).not.toContain("per the agreed plan");
    expect(text).not.toContain("discussion with the clinician");
    expect(text).toContain("1 tablet");
    expect(text).toMatch(/bedtime|on sleep/u);
  }
});


it("keeps replacement text authoritative on a qualified range while preserving rich structured metadata", () => {
  const row = withDosageEditProvenance([{
    text: "Use 2 mg to less than 5 mg",
    doseAndRate: [{ doseRange: { low: { value: 2, unit: "mg" }, high: {
      value: 5, unit: "mg", extension: [{ url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
        valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000050" } }]
    } } }]
  }], "Use 2 mg to less than 5 mg")[0];
  const persisted = JSON.parse(JSON.stringify(row)) as FhirDosage;
  persisted.text = "Use 2 mg to less than 5 mg after discussing the plan with the clinician.";
  const options = { locale: "en", realizationMode: "roundtrip" as const };
  expect(formatSig(persisted, "long", options)).toBe(persisted.text);
  const imported = fromFhirDosage(persisted, options);
  expect(imported.longText).toBe(persisted.text);
  expect(imported.shortText).toBe(persisted.text);
  expect(imported.meta.canonical.administration?.amounts?.[0].range?.high)
    .toMatchObject({ value: 5, unit: "mg", comparator: "<" });
  expect(fromFhirDosage(persisted, { ...options, realizationMode: "normalized" }).longText).toContain("<5");
});


describe("review 27 live clinical source proofs and language receivers", () => {
  it.each(["fresh", "persisted"] as const)("honors each freshly submitted %s occurrence-cap edit", kind => {
    const source = "Dissolve 1 tablet in water as needed, maximum 3 doses per day";
    const parsed = parseSig(source);
    const row = structuredClone(kind === "fresh" ? parsed.fhir[0]
      : JSON.parse(JSON.stringify(parsed.fhir[0])) as FhirDosage);
    const options = { locale: "en", realizationMode: "roundtrip" as const };
    const originalRowText = row.text;
    expect(formatSig(structuredClone(row), "long", options)).toContain("3 doses per day");
    const cap = row.timing!.repeat!.extension!.find(e => e.url === TIMING_OCCURRENCE_CAP_EXTENSION_URL)!;
    cap.extension!.find(e => e.url === "max")!.valueInteger = 2;
    for (const text of [formatSig(structuredClone(row), "long", options), fromFhirDosage(structuredClone(row), options).longText]) {
      expect(text).toContain("maximum 2 doses per day");
      expect(text).not.toContain("3 doses");
    }
    cap.extension!.find(e => e.url === "period")!.valueQuantity!.value = 2;
    for (const text of [formatSig(structuredClone(row), "long", options), fromFhirDosage(structuredClone(row), options).longText]) {
      expect(text).toContain("maximum 2 doses per 2 days");
      expect(text).not.toContain("3 doses");
    }
    expect(row.text).toBe(originalRowText);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it.each(["period", "administration", "lifetime"] as const)("honors a freshly submitted saved %s maximum edit", scope => {
    const suffix = scope === "period" ? "per day" : "per " + scope;
    const text = "Take 1 tablet as needed, max 4 tablets " + suffix;
    const raw: FhirDosage = { text, asNeeded: true,
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      ...(scope === "period" ? { maxDosePerPeriod: [{ numerator: { value: 4, unit: "tab" }, denominator: { value: 1, unit: "d" } }] }
        : scope === "administration" ? { maxDosePerAdministration: { value: 4, unit: "tab" } }
        : { maxDosePerLifetime: { value: 4, unit: "tab" } }) };
    const row = JSON.parse(JSON.stringify(withDosageEditProvenance([raw], text)[0])) as FhirDosage;
    const options = { locale: "en", realizationMode: "roundtrip" as const };
    expect(formatSig(structuredClone(row), "long", options)).toContain("4 tablets");
    const quantity = scope === "period" ? row.maxDosePerPeriod![0].numerator!
      : scope === "administration" ? row.maxDosePerAdministration! : row.maxDosePerLifetime!;
    quantity.value = 2;
    for (const text of [formatSig(structuredClone(row), "long", options), fromFhirDosage(structuredClone(row), options).longText]) {
      expect(text).toMatch(/(?:Take|Use) 1 tablet\b/u);
      expect(text).toMatch(scope === "period" ? /max per period: 2 tab \/ 1 d\b/u
        : scope === "administration" ? /max per administration: 2 tab\b/u : /max lifetime: 2 tab\b/u);
      expect(text).not.toMatch(/(?<![\d.])4 tab(?:lets?)?\b/u);
      expect(text).toMatch(/as needed|when needed/iu);
    }
    if (scope === "period") {
      row.maxDosePerPeriod![0].denominator!.value = 2;
      for (const text of [formatSig(structuredClone(row), "long", options), fromFhirDosage(structuredClone(row), options).longText])
        expect(text).toMatch(/(?<![\d.])2 (?:tablets per 2 days|tab \/ 2 d)\b/u);
    }
  });


});

it.each(["Take 1 tablet", "Dissolve 1 tablet in water"])("honors a freshly submitted R5 maximum edit for %s", head => {
  const batch = parseSig(head + " as needed, max 4 tablets per day");
  const row = structuredClone(batch.fhir[0]);
  const originalText = row.text;
  expect(row).not.toBe(batch.fhir[0]);
  expect(formatSig(structuredClone(row), "long", { realizationMode: "roundtrip" })).toContain("4 tablets");
  row.maxDosePerPeriod![0].numerator!.value = 2;
  for (const realizationMode of ["roundtrip", "normalized"] as const) {
    const options = { locale: "en", realizationMode };
    for (const text of [formatSig(structuredClone(row), "long", options), fromFhirDosage(structuredClone(row), options).longText]) {
      expect(text).toMatch(head.startsWith("Take") ? /Take 1 tablet\b/u : /Dissolve 1 tablet in water\b/u);
      expect(text).toContain("max per period: 2 tab / 1 d");
      expect(text).not.toMatch(/(?<![\d.])4 tab(?:lets?)?\b/u);
    }
  }
  expect(row.text).toBe(originalText);
});

it("honors inserted and removed maxima on fresh R5 submissions", () => {
  const row = structuredClone(parseSig("Take 1 tablet daily").fhir[0]);
  const sourceText = row.text;
  expect(formatSig(structuredClone(row), "long")).not.toMatch(/max|limit/iu);
  row.maxDosePerPeriod = [{ numerator: { value: 4, unit: "tab" }, denominator: { value: 1, unit: "d" } }];
  for (const realizationMode of ["roundtrip", "normalized"] as const)
    for (const text of [formatSig(structuredClone(row), "long", { realizationMode }),
      fromFhirDosage(structuredClone(row), { realizationMode }).longText])
      expect(text).toMatch(/(?<![\d.])4 (?:tablets per day|tab \/ 1 d)\b/u);
  delete row.maxDosePerPeriod;
  for (const realizationMode of ["roundtrip", "normalized"] as const)
    for (const text of [formatSig(structuredClone(row), "long", { realizationMode }),
      fromFhirDosage(structuredClone(row), { realizationMode }).longText]) {
      expect(text).toContain("1 tablet");
      expect(text).not.toMatch(/max|limit|4 tab/iu);
    }
  expect(row.text).toBe(sourceText);
});

it.each([
  ["en", "the day after the previous phase"],
  ["th", "วันถัดจากวันสุดท้ายของขั้นตอนก่อนหน้า"],
] as const)("localizes the completion-relative next-day boundary in %s", (locale, expected) => {
  const course: CanonicalCourse = { kind: "course", stages: [
    { administrations: [{ kind: "administration", amounts: [{ quantity: { value: 1, unit: "tab" } }],
      schedule: { recurrence: { count: 5, frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, clocks: ["09:00:00"] } } }] },
    { start: { anchor: "previous-phase-next-day" }, administrations: [{
      kind: "administration", amounts: [{ quantity: { value: 2, unit: "tab" } }],
      schedule: { recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, clocks: ["15:00:00"] } }
    }] }
  ] };
  const text = formatCanonicalCourse(course, "long", { locale });
  expect(text).toContain(expected);
  expect(text).not.toMatch(/day 2|วันที่ 2|requires review|ต้องตรวจสอบช่วงเวลา/iu);
});

it("retains an independent member onset beside a completion-relative member over three external saves", () => {
  const source = "Take 1 tablet daily for 5 doses then take 2 tablets at 06:00 the next day and from day 10 take 3 tablets at 15:00";
  let wire = parseSig(source).fhirNext;
  for (let save = 0; save <= 3; save++) {
    const native = courseFromR6(wire);
    expect(native.stages).toHaveLength(2);
    const members = native.stages[1].administrations;
    expect(members).toHaveLength(2);
    expect(members[0]).toMatchObject({ phaseStart: { anchor: "previous-phase-next-day" },
      amounts: [{ quantity: { value: 2, unit: "tab" } }] });
    expect(members[1]).toMatchObject({ phaseStart: { anchor: "treatment-day-start", displacement: { value: 9, unit: "d" } },
      amounts: [{ quantity: { value: 3, unit: "tab" } }] });
    if (save < 3) wire = toDosageDetails(JSON.parse(JSON.stringify(toFhirR5Dosages(wire))));
  }
});


describe("round 28 live capped source concepts", () => {
  for (const saved of [false, true]) {
    it.each(["replace", "nested-code"] as const)(
      "uses the live eye in both previews after a %s edit (saved=" + saved + ")",
      edit => {
        const batch = parseSig("1 drop OD BID max 2 drops/day");
        const row = structuredClone(saved ? JSON.parse(JSON.stringify(batch.fhir[0])) as FhirDosage
          : batch.fhir[0]);
        const source = row.text;
        expect(row.maxDosePerPeriod?.[0].numerator?.value).toBe(2);
        expect(formatSig(structuredClone(row), "long", { locale: "en", realizationMode: "roundtrip" }))
          .toMatch(/right eye|\bOD\b/iu);
        if (edit === "replace")
          row.site = { text: "left eye", coding: [{
            system: "http://snomed.info/sct", code: "1290031003",
            display: "Structure of left eye proper"
          }] };
        else row.site!.coding![0].code = "1290031003";
        for (const mode of ["roundtrip", "normalized"] as const) {
          const options = { locale: "en", realizationMode: mode };
          const imported = fromFhirDosage(structuredClone(row), options);
          for (const text of [formatSig(structuredClone(row), "short", options), formatSig(structuredClone(row), "long", options),
            imported.shortText, imported.longText]) {
            expect(text).toMatch(/left eye|\bOS\b/iu);
            expect(text).not.toMatch(/right eye|\bOD\b/iu);
          }
        }
        expect(row.text).toBe(source);
        expect(row.site?.coding?.[0].code).toBe("1290031003");
      }
    );
    it.each(["route", "method", "prn"] as const)(
      "invalidates the capped source for a live %s edit (saved=" + saved + ")",
      field => {
        const batch = parseSig("Take 1 tablet PO daily max 2 tablets/day");
        const row = structuredClone(saved ? JSON.parse(JSON.stringify(batch.fhir[0])) as FhirDosage
          : batch.fhir[0]);
        const source = row.text;
        expect(row.maxDosePerPeriod?.[0].numerator?.value).toBe(2);
        formatSig(structuredClone(row), "long", { locale: "en", realizationMode: "roundtrip" });
        if (field === "prn") row.asNeeded = true;
        else if (field === "route") {
          row.route!.text = "sublingual";
          Object.assign(row.route!.coding![0], { code: "37839007", display: "Sublingual route" });
        } else {
          row.method!.text = "Chew";
          Object.assign(row.method!.coding![0], { code: "738992009", display: "Chew" });
        }
        const options = { locale: "en", realizationMode: "roundtrip" as const };
        const imported = fromFhirDosage(structuredClone(row), options);
        for (const text of [formatSig(structuredClone(row), "long", options), imported.longText]) {
          if (field === "route") {
            expect(text).toMatch(/sublingual|\bSL\b/iu);
            expect(text).not.toMatch(/by mouth|\bPO\b/iu);
          } else if (field === "method") expect(text).toMatch(/\bchew\b/iu);
          else expect(text).toMatch(/as needed|when needed|\bPRN\b/iu);
        }
        expect(row.text).toBe(source);
      }
    );
  }
});


describe("round 28 live source concept lists", () => {
  for (const saved of [false, true]) {
    it.each(["replace", "nested", "coding", "remove"] as const)(
      "updates a capped PRN reason after %s (saved=" + saved + ")", edit => {
        const batch = parseSig("Take 1 tablet PO daily as needed for pain max 2 tablets/day");
        const row = structuredClone(saved ? JSON.parse(JSON.stringify(batch.fhir[0])) as FhirDosage : batch.fhir[0]);
        const source = row.text;
        expect(row.asNeeded).toBe(true);
        expect(row.asNeededFor?.[0].text).toBe("pain");
        expect(formatSig(structuredClone(row), "long", { locale: "en", realizationMode: "roundtrip" })).toMatch(/pain/i);
        if (edit === "replace") row.asNeededFor = [{ text: "nausea" }];
        else if (edit === "nested") {
          row.asNeededFor![0].text = "nausea";
          row.asNeededFor![0].coding = undefined;
        } else if (edit === "coding") row.asNeededFor![0].coding![0].code = "422587007";
        else row.asNeededFor = [];
        const edited = JSON.stringify(row);
        for (const realizationMode of ["roundtrip", "normalized"] as const) {
          const options = { locale: "en", realizationMode };
          const imported = fromFhirDosage(structuredClone(row), options);
          for (const text of [formatSig(structuredClone(row), "long", options), imported.longText]) {
            expect(text).toMatch(/as needed|when needed/iu);
            expect(text).not.toMatch(/\bpain\b/iu);
            if (edit !== "remove") expect(text).toMatch(/\bnausea\b/iu);
          }
        }
        expect(JSON.stringify(row)).toBe(edited);
        expect(row.text).toBe(source);
      }
    );

    it("shows newly supplied advice beside the current cap (saved=" + saved + ")", () => {
      const batch = parseSig("Take 1 tablet PO daily max 2 tablets/day");
      const row = structuredClone(saved ? JSON.parse(JSON.stringify(batch.fhir[0])) as FhirDosage : batch.fhir[0]);
      const source = row.text;
      formatSig(structuredClone(row), "long", { locale: "en", realizationMode: "roundtrip" });
      row.additionalInstruction = [{ text: "Avoid grapefruit" }];
      const edited = JSON.stringify(row);
      for (const text of [
        formatSig(structuredClone(row), "long", { locale: "en", realizationMode: "roundtrip" }),
        fromFhirDosage(structuredClone(row), { locale: "en", realizationMode: "roundtrip" }).longText
      ]) {
        expect(text).toContain("Avoid grapefruit");
        expect(text).toMatch(/max(?:imum)?[^\d]*2\s*(?:tab|tablet).*?(?:day|1\s*d)/i);
      }
      expect(JSON.stringify(row)).toBe(edited);
      expect(row.text).toBe(source);
    });
  }
});

describe("round30 current cadence and duration metadata", () => {
  it.each([
    [2, undefined, "wk", "2x/1wk"],
    [1, 2, "wk", "1-2x/1wk"],
    [2, undefined, "mo", "2x/1mo"]
  ])("shows current frequency %s-%s per %s in short form", (frequency, frequencyMax, unit, expected) => {
    const input = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: unit === "wk" ? "WK" : "MO" }] },
        repeat: { frequency: frequency as number, frequencyMax: frequencyMax as number | undefined,
          period: 1, periodUnit: unit as FhirPeriodUnit } }
    }] }] };
    const before = JSON.stringify(input);
    const beforeText = formatSig(input, "short", { locale: "en" });
    expect(beforeText.toLowerCase()).toContain(expected as string);
    expect(beforeText).not.toMatch(/\b(?:WK|MO)\b/u);
    expect(JSON.stringify(input)).toBe(before);
    const edited = structuredClone(input);
    edited.step[0].component[0].timing.repeat.frequency = 1;
    edited.step[0].component[0].timing.repeat.frequencyMax = undefined;
    const afterText = formatSig(edited, "short", { locale: "en" });
    expect(afterText).toContain(unit === "wk" ? "WK" : "MO");
    expect(afterText.toLowerCase()).not.toContain(expected as string);
  });

  it.each([
    [2, 3, FhirPeriodUnit.Day, "2-3x/1-2d"],
    [2, undefined, FhirPeriodUnit.Month, "2x/1-2mo"]
  ] as const)("keeps frequency and period ranges together in short form", (frequency, frequencyMax, periodUnit, expected) => {
    const input = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency, frequencyMax, period: 1, periodMax: 2, periodUnit } } };
    expect(formatSig(input, "short", { locale: "en" }).toLowerCase()).toContain(expected);
  });

  it("keeps deletion of a projected duration annotation while retaining unprojected source-unit metadata", () => {
    const source = {
      low: { value: 48, unit: "hours", code: "h", system: "http://unitsofmeasure.org",
        _value: { id: "number" }, _unit: { id: "authored-hour" }, _code: { id: "hour-code" } },
      high: { value: 3, unit: "days", code: "d", system: "http://unitsofmeasure.org" }
    };
    const sourceBefore = JSON.stringify(source);
    // An existing source record can retain a formerly projected range. New
    // writes keep authored endpoints active; import must still honor live edits
    // to this saved record without reintroducing automatic unit conversion.
    const projected = {
      low: { value: 2, unit: "days", code: "d", system: "http://unitsofmeasure.org", _value: { id: "number" } },
      high: source.high,
    };
    const input = { modifierExtension: [{ url: ANCHORED_COURSE_DURATION_EXTENSION_URL, extension: [
      { url: "low", valueQuantity: source.low }, { url: "high", valueQuantity: source.high },
      { url: "projectedRange", valueRange: projected },
    ] }], timing: { repeat: { boundsRange: cloneStructuredValue(projected) } } };
    delete (input.timing.repeat.boundsRange.low as { _value?: { id: string } })._value;
    const before = JSON.stringify(input);
    const restored = getAnchoredCourseDuration(input)!.valueRange!.low!;
    expect(restored).toMatchObject({ value: 48, unit: "hours", code: "h",
      _unit: { id: "authored-hour" }, _code: { id: "hour-code" } });
    expect(restored._value).toBeUndefined();
    expect(JSON.stringify(input)).toBe(before);
    expect(JSON.stringify(source)).toBe(sourceBefore);
  });
});

describe("round31 live source replay observations", () => {
  const options = { locale: "en", realizationMode: "roundtrip" as const };
  it("shows a freshly submitted meal-window endpoint on a saved capped R5 row", () => {
    const text = "Take 1 tablet every 4 hours between breakfast and dinner, maximum 4 tablets per day.";
    const raw: FhirDosage = { text,
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      maxDosePerPeriod: [{ numerator: { value: 4, unit: "tab" }, denominator: { value: 1, unit: "d" } }],
      timing: { repeat: { frequency: 1, period: 4, periodUnit: FhirPeriodUnit.Hour, extension: [{
        url: TIMING_EVENT_WINDOW_EXTENSION_URL,
        extension: [{ url: "start", valueCode: "CM" }, { url: "end", valueCode: "CV" }]
      }] } }
    };
    const row: FhirDosage = JSON.parse(JSON.stringify(withDosageEditProvenance([raw], text)[0]));
    expect(formatSig(structuredClone(row), "long", options)).toContain("dinner");
    expect(dosageMatchesSavedProjection(structuredClone(row))).toBe(true);
    row.timing!.repeat!.extension![0].extension![1].valueCode = "CD";
    const before = JSON.stringify(row);
    expect(dosageMatchesSavedProjection(structuredClone(row))).toBe(false);
    for (const input of [row, JSON.parse(before)]) {
      for (const output of [formatSig(input, "long", options), fromFhirDosage(input, options).longText]) {
        expect(output).toContain("between breakfast and lunch");
        expect(output).not.toContain("dinner");
      }
    }
    expect(JSON.stringify(row)).toBe(before);
    expect(row.text).toBe(text);
  });

  it.each(["quantity", "range", "mixed"] as const)("shows a freshly submitted anchored %s edit", kind => {
    const text = "Take 1 tablet daily from 2026-11-21 for " + (kind === "quantity" ? "7 days" : kind === "range" ? "7–9 days" : "1 week to 10 days") +
      ", maximum 2 tablets per day.";
    const duration = kind === "quantity" ? { valueQuantity: { value: 7, code: "d", unit: "days" } }
      : kind === "mixed" ? { extension: [
        { url: "low", valueQuantity: { value: 1, code: "wk", unit: "weeks" } },
        { url: "high", valueQuantity: { value: 10, code: "d", unit: "days" } }
      ] } : { valueRange: { low: { value: 7, code: "d", unit: "days" }, high: { value: 9, code: "d", unit: "days" } } };
    const raw: FhirDosage = { text,
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      maxDosePerPeriod: [{ numerator: { value: 2, unit: "tab" }, denominator: { value: 1, unit: "d" } }],
      modifierExtension: [{ url: ANCHORED_COURSE_DURATION_EXTENSION_URL, ...duration }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        boundsPeriod: { start: "2026-11-21", end: "2026-11-27" } } }
    };
    const row: FhirDosage = JSON.parse(JSON.stringify(withDosageEditProvenance([raw], text)[0]));
    expect(formatSig(structuredClone(row), "long", options)).toContain(kind === "mixed" ? "1 week" : "7");
    expect(dosageMatchesSavedProjection(structuredClone(row))).toBe(true);
    const marker = row.modifierExtension![0];
    if (kind === "quantity") marker.valueQuantity!.value = 10;
    else if (kind === "mixed") {
      marker.extension![0].valueQuantity!.value = 2; marker.extension![1].valueQuantity!.value = 17;
    } else { marker.valueRange!.low!.value = 10; marker.valueRange!.high!.value = 12; }
    const before = JSON.stringify(row);
    expect(dosageMatchesSavedProjection(structuredClone(row))).toBe(false);
    for (const input of [row, JSON.parse(before)]) {
      expect(getAnchoredCourseDuration(input)).toMatchObject(kind === "quantity"
        ? { valueQuantity: { value: 10 } } : kind === "mixed"
          ? { valueRange: { low: { value: 2, code: "wk" }, high: { value: 17, code: "d" } } }
          : { valueRange: { low: { value: 10 }, high: { value: 12 } } });
      for (const output of [formatSig(input, "long", options), fromFhirDosage(input, options).longText])
        expect(output).toMatch(kind === "quantity" ? /for 10 days/u : kind === "mixed"
          ? /for 2 weeks to 17 days/u : /for 10(?:[–-]| to )12 days/u);
    }
    expect(JSON.stringify(row)).toBe(before);
    expect(row.text).toBe(text);
  });

  it.each(["1 tab BID only if BP > 160", "1 tab BID"])("adds patient instructions to fresh %s without replaying stale text", source => {
    const row = structuredClone(parseSig(source).fhir[0]);
    const originalText = row.text;
    formatSig(structuredClone(row), "long", options);
    row.patientInstruction = "Swallow whole.";
    const before = JSON.stringify(row);
    for (const output of [formatSig(structuredClone(row), "long", options), fromFhirDosage(structuredClone(row), options).longText]) {
      expect(output).toMatch(/swallow whole/iu);
      if (source.includes("BP")) expect(output).toMatch(/BP\s*(?:>|greater than)\s*160\b/u);
    }
    expect(JSON.stringify(row)).toBe(before);
    expect(row.text).toBe(originalText);
  });
});

describe("round35 partial authored directions and sequential previews", () => {
  const options = { locale: "en", realizationMode: "normalized" as const };
  it("retains text-only dose directions beside independently edited live timing", () => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      text: "Swallow 1 tablet whole",
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } }
    }] }] };
    formatSig(raw, "long", options);
    const edited = structuredClone(raw);
    edited.step[0].component[0].timing!.repeat!.frequency = 2;
    const before = JSON.stringify(edited);
    for (const text of [formatSig(edited, "long", options), fromFhir(edited, options).longText]) {
      expect(text).toContain("Swallow 1 tablet whole");
      expect(text).toContain("twice daily");
      expect(text).not.toContain("once daily");
    }
    expect(JSON.stringify(edited)).toBe(before);
    expect(courseToR6(courseFromR6(edited)).step[0].component[0].text).toBe("Swallow 1 tablet whole");
  });

  it("lets a live structured dose replace old component wording", () => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      text: "Take 1 tablet once daily",
      doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }],
      timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day } }
    }] }] };
    for (const text of [formatSig(raw, "long", options), fromFhir(raw, options).longText]) {
      expect(text).toContain("2 tablets twice daily");
      const current = text.split("; original directions:")[0];
      expect(current).not.toContain("1 tablet");
      expect(current).not.toContain("once daily");
      expect(text).toContain("; original directions: Take 1 tablet once daily");
    }
  });

  it.each([false, true])("does not call an earlier sequential dose open-ended (earlier duration %s)", duration => {
    const start = (value: number) => ({
      contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] },
      offsetDuration: { value, unit: "d" }
    });
    const raw: FhirR6DosageInstruction = { step: [2, 1].map((dose, index) => ({
      start: start(index * 7),
      component: [{ doseAndRate: [{ doseQuantity: { value: dose, unit: "tab" } }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          ...(duration && index === 0 ? { boundsDuration: { value: 3, unit: "d" } } : {}) } }
      }]
    })) };
    const before = JSON.stringify(raw);
    for (const text of [formatSig(raw, "long", options), fromFhir(raw, options).longText]) {
      expect(text.match(/onward/gu)).toHaveLength(1);
      expect(text).toMatch(/^treatment start: [^.]*2 tablets once daily[^.]*\./u);
      expect(text).toMatch(/From 7 days after treatment start onward: [^.]*1 tablet once daily/u);
      expect(text.slice(0, text.indexOf("From 7 days"))).not.toContain("onward");
      expect(text).not.toContain("until 7 days");
      if (duration) expect(text).toContain("for 3 days");
    }
    expect(nextDueDoses(raw, { orderedAt: "2026-11-21T08:00:00Z",
      from: "2026-11-28T00:00:00Z", timeZone: "UTC", limit: 2 }))
      .toEqual(["2026-11-28T09:00:00+00:00", "2026-11-29T09:00:00+00:00"]);
    expect(JSON.stringify(raw)).toBe(before);
  });
});

describe("round37 upper-only timing and stage origins", () => {
  const options = { realizationMode: "normalized" as const };
  const relative = (value: number, dayStart = false) => ({
    contextCode: { coding: [{ system: dayStart ? "urn:ezmedicationinput:CodeSystem:course-phase-event"
      : "http://hl7.org/fhir/evidence-variable-event", code: dayStart ? "treatment-day-start" : "treatment-start" }] },
    offsetDuration: { value, unit: "d" }
  });
  const component = (dose: number): FhirR6Dosage => ({
    doseAndRate: [{ doseQuantity: { value: dose, unit: "tab" } }],
    timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } }
  });

  it.each([2, 1])("shows an upper-only %i-day period without a fabricated daily cadence", maximum => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 2, periodMax: maximum, periodUnit: FhirPeriodUnit.Day } } };
    const before = JSON.stringify(row);
    let saved = toDosageDetails([row]);
    for (let save = 0; save < 3; save++) {
      for (const input of [row, saved, toFhirR5Dosages(saved)]) for (const locale of ["en", "th"])
        for (const style of ["short", "long"] as const) {
          const text = formatSig(input, style, { ...options, locale });
          expect(text).toContain(locale === "en" ? "twice every up to " + maximum + " day"
            : "2 ครั้ง ทุกไม่เกิน " + maximum + " วัน");
          expect(text).not.toMatch(/twice daily|2x\/d|วันละ 2 ครั้ง/u);
        }
      const repeat = saved.step[0].component[0].timing!.repeat!;
      expect(repeat.period).toBeUndefined();
      expect(repeat.periodMax).toBe(maximum);
      expect(repeat.frequency).toBe(2);
      saved = toDosageDetails(JSON.parse(JSON.stringify(toFhirR5Dosages(saved))));
    }
    expect(JSON.stringify(row)).toBe(before);
    const daily = { ...row, timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day } } };
    expect(formatSig(daily, "long", { ...options, locale: "en" })).toContain("twice daily");
    expect(formatSig(daily, "long", { ...options, locale: "th" })).toContain("วันละ 2 ครั้ง");
  });

  it.each([undefined, 15, 30])("retains a 30-minute infusion maximum with lower endpoint %s", minimum => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 100, unit: "mL" } }],
      method: { text: "Infuse" },
      timing: { repeat: { duration: minimum, durationMax: 30, durationUnit: FhirPeriodUnit.Minute } } };
    const before = JSON.stringify(row);
    let saved = toDosageDetails([row]);
    for (let save = 0; save < 3; save++) {
      for (const input of [row, saved, toFhirR5Dosages(saved)]) for (const locale of ["en", "th"])
        for (const style of ["short", "long"] as const) {
          const text = formatSig(input, style, { ...options, locale });
          const span = minimum === undefined ? "<=30" : minimum === 15 ? "15-30" : "30";
          if (style === "short") expect(text).toContain((locale === "en" ? "over" : "นาน") + span + "min");
          else if (minimum === undefined) expect(text).toContain(locale === "en" ? "over up to 30 minutes" : "ไม่เกิน 30 นาที");
          else expect(text).toContain(locale === "en" ? (minimum === 15 ? "over 15 to 30 minutes" : "over 30 minutes")
            : (minimum === 15 ? "15 ถึง 30 นาที" : "30 นาที"));
          expect(text).toMatch(locale === "en" ? /(?:^|\s)100 mL(?:\s|[.,;]|$)/
            : style === "short" ? /(?:^|\s)100 มล\.(?:\s|$)/ : /(?:^|\s)100 มิลลิลิตร(?:\s|$)/);
        }
      const repeat = saved.step[0].component[0].timing!.repeat!;
      expect(repeat.duration).toBe(minimum);
      expect(repeat.durationMax).toBe(30);
      expect(repeat.durationUnit).toBe(FhirPeriodUnit.Minute);
      const r5Repeat = toFhirR5Dosages(saved)[0].timing!.repeat!;
      expect(r5Repeat.duration).toBe(minimum);
      expect(r5Repeat.durationMax).toBe(30);
      expect(r5Repeat.durationUnit).toBe(FhirPeriodUnit.Minute);
      if (minimum === undefined) expect(r5Repeat._duration).toEqual({ extension: [{
        url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown",
      }] });
      else expect(r5Repeat._duration).toBeUndefined();
      saved = toDosageDetails(JSON.parse(JSON.stringify(toFhirR5Dosages(saved))));
    }
    expect(JSON.stringify(row)).toBe(before);
  });

  it("orders a bounded successor after the previous phase without inventing its start", () => {
    const first = component(2);
    first.timing!.repeat!.boundsDuration = { value: 1, unit: "wk" };
    const raw: FhirR6DosageInstruction = { step: [
      { component: [first] }, { end: relative(14), component: [component(1)] }
    ] };
    let saved = raw;
    for (let save = 0; save < 3; save++) {
      for (const input of [saved, toFhirR5Dosages(saved)]) for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { ...options, locale });
        expect(text).toContain(locale === "en" ? "After the previous phase; Until 14 days after treatment start"
          : "หลังขั้นตอนก่อนหน้า; จนถึง14 วันหลังเริ่มการรักษา");
        expect(text).toMatch(locale === "en" ? /After the previous phase[^.]*1 tablet once daily/u
          : /หลังขั้นตอนก่อนหน้า[^.]*1 เม็ด วันละครั้ง/u);
        expect(text).toContain(locale === "en" ? "2 tablets once daily for 1 week" : "2 เม็ด วันละครั้ง เป็นเวลา 1 สัปดาห์");
      }
      saved = toDosageDetails(JSON.parse(JSON.stringify(toFhirR5Dosages(saved))));
    }
    expect(raw.step[1].start).toBeUndefined();
  });

  it.each([false, true])("compares boundary offsets only within the same origin (same origin %s)", sameOrigin => {
    const raw: FhirR6DosageInstruction = { step: [{
      start: relative(1, !sameOrigin), end: relative(1), component: [component(1)]
    }] };
    let saved = raw;
    for (let save = 0; save < 3; save++) {
      for (const input of [saved, toFhirR5Dosages(saved)]) for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { ...options, locale });
        if (sameOrigin) expect(text).toContain(locale === "en" ? "Timing requires review" : "ต้องตรวจสอบช่วงเวลา");
        else {
          expect(text).not.toContain(locale === "en" ? "Timing requires review" : "ต้องตรวจสอบช่วงเวลา");
          expect(text).toContain(locale === "en" ? "1 day after the start of the first treatment day" : "1 วันหลังต้นวันแรกของการรักษา");
          expect(text).toContain(locale === "en" ? "until 1 day after treatment start" : "จนถึง1 วันหลังเริ่มการรักษา");
        }
      }
      saved = toDosageDetails(JSON.parse(JSON.stringify(toFhirR5Dosages(saved))));
    }
    if (!sameOrigin) expect(nextDueDoses(raw, { orderedAt: "2026-11-22T12:00:00Z",
      from: "2026-11-23T00:00:00Z", timeZone: "UTC", limit: 2 }))
      .toEqual(["2026-11-23T09:00:00+00:00"]);
  });
});


// Retained regression suite from test/pr14-followup-clinical.spec.ts.
/**
 * November 18 review: preserve clinical meaning through repeated-course
 * chronology and through a clinician's live R5 dose edits.
 * These are independent oracles, not roundtrips of the same broken output.
 */
{
// BEGIN PRESERVED followup
/**
 * November 18 review: preserve clinical meaning through repeated-course
 * chronology and through a clinician's live R5 dose edits.
 * These are independent oracles, not roundtrips of the same broken output.
 */







const from = "2026-01-01T00:00:00Z";
const options = { from, orderedAt: from, timeZone: "UTC" } as const;

describe("repeated-course clinical chronology", () => {
  it("completes an uncapped finite loading stage before an overlapping capped maintenance stage", () => {
    const course = {
      kind: "course" as const,
      cycleInterval: { value: 7, unit: "d" },
      stages: [
        {
          administrations: [{
            kind: "administration" as const,
            amounts: [{ quantity: { value: 2, unit: "tab" } }],
            schedule: { recurrence: {
              count: 1,
              frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
              clocks: ["08:00:00"]
            } }
          }]
        },
        {
          administrations: [{
            kind: "administration" as const,
            amounts: [{ quantity: { value: 1, unit: "tab" } }],
            schedule: { recurrence: {
              frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
              clocks: ["09:00:00"],
              courseLength: { value: 10, unit: "d" },
            } },
            limits: [{scope: "period" as const,
              amount: {value: 2, unit: "tab"}, period: {value: 1, unit: "d"}}],
          }]
        }
      ]
    };
    const due = nextDueDoses(course, { ...options, limit: 20 });
    expect(due.slice(0, 6)).toEqual([
      "2026-01-01T08:00:00+00:00",
      "2026-01-01T09:00:00+00:00",
      "2026-01-02T09:00:00+00:00",
      "2026-01-03T09:00:00+00:00",
      "2026-01-04T09:00:00+00:00",
      "2026-01-05T09:00:00+00:00",
    ]);
    const supply = calculateTotalUnits({
      ...options, dosage: course, durationValue: 5, durationUnit: FhirPeriodUnit.Day
    });
    // A finite 08:00 loading dose completes before the 09:00 maintenance
    // clock ON JANUARY 1. The 5-day window therefore has two loading
    // tablets plus five maintenance tablets (Jan 1 through Jan 5).
    expect(supply.totalUnits).toBe(7);
    // A partially stated cap is preserved for review but cannot impose
    // shared chronological acceptance; the uncapped loading stage must
    // still finish before maintenance starts.
    const incomplete = {
      ...course,
      stages: [
        {
          ...course.stages[0],
          administrations: course.stages[0].administrations.map(a => ({
            ...a,
            limits: [{
              scope: "period" as const,
              amount: { value: 2, unit: "tab" },
              period: { unit: "d" }
            }]
          })),
        },
        course.stages[1],
      ]
    };
    const incompleteDue = nextDueDoses(incomplete, { ...options, limit: 20 });
    expect(incompleteDue.slice(0, 2)).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-01T09:00:00+00:00",
    ]);
    expect(incompleteDue).toContain("2026-01-02T09:00:00+00:00");
  });

  it("counts two genuinely accepted administrations at one time across overlapping daily cycles", () => {
    const course = {
      kind: "course" as const,
      cycleInterval: { value: 1, unit: "d" },
      stages: [{
        administrations: [{
          kind: "administration" as const,
          amounts: [{quantity: {value: 1, unit: "tab"}}],
          schedule: {recurrence: {
            frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
            clocks: ["00:00:00"], courseLength: {value: 2, unit: "d"}
          }},
          limits: [{
            scope: "period" as const,
            amount: {value: 2, unit: "tab"},
            period: {value: 1, unit: "d"}
          }]
        }]
      }]
    };
    const due = nextDueDoses(course, {...options, limit: 5});
    expect(due).toEqual([
      "2026-01-01T00:00:00+00:00",
      "2026-01-02T00:00:00+00:00",
      "2026-01-02T00:00:00+00:00",
      "2026-01-03T00:00:00+00:00",
      "2026-01-03T00:00:00+00:00",
    ]);
    const supply = calculateTotalUnits({
      ...options, dosage: course, durationValue: 3, durationUnit: FhirPeriodUnit.Day,
    });
    expect(supply.totalUnits).toBe(5);
  });
});

describe("R5 source dose identity after live edits", () => {
  it("honors independently submitted edits of an HPSG-owned R5 dose", () => {
    const source = "ล้างมือก่อนหยอดตา หยอดตาขวา 1 หยด แล้วหลับตา";
    const row = structuredClone(parseSig(source, { locale: "th" }).fhir[0]);
    const display = () => formatSig(structuredClone(row), "long", { locale: "th", realizationMode: "roundtrip" });
    expect(display()).toBe(source);
    const dose = row.doseAndRate?.[0]?.doseQuantity;
    expect(dose?.value).toBe(1);
    dose!.value = 2;
    expect(display()).not.toBe(source);
    expect(display()).toMatch(/(?:^|[^\d])(?:2|สอง)\s*หยด/u);
    dose!.value = 1;
    expect(display()).toBe(source);
    const originalUnit = dose!.unit, originalCode = dose!.code;
    dose!.unit = "tab";
    dose!.code = "15054";
    expect(display()).not.toBe(source);
    expect(display()).toContain("เม็ด");
    dose!.unit = originalUnit;
    dose!.code = originalCode;
    expect(display()).toBe(source);
    const originalExtensions = dose!.extension;
    dose!.extension = [{
      url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000055" }
    }];
    expect(display()).not.toBe(source);
    expect(display()).toContain("ประมาณ");
    dose!.extension = originalExtensions;
    expect(display()).toBe(source);
  });

  it("treats a changed defaulted amount as a live dose while keeping the original default source", () => {
    const source = "Mix with water then swallow";
    const parsed = parseSig(source, {
      assumeSingleDiscreteDose: true,
      context: { dosageForm: "tablet" }
    });
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.dose).toMatchObject({value: 1, defaulted: true});
    expect(clause.instructionGraph?.actions.length).toBeGreaterThan(0);
    const original = formatCanonicalClause(
      clause, "long", resolveSigLocalization("en"), {realizationMode: "roundtrip"}
    );
    expect(original).toBe(source);
    const changed = { ...clause, dose: { ...clause.dose!, value: 2 } };
    expect(instructionGraphSourceConflictsWithDose(changed)).toBe(true);
    const text = formatCanonicalClause(
      changed, "long", resolveSigLocalization("en"), {realizationMode: "roundtrip"}
    );
    expect(text).not.toBe(original);
    expect(text).toMatch(/(?<![\w.+-])(?:2|two)\s+tablets?\b/iu);
    const changedUnit = { ...clause, dose: { ...clause.dose!, unit: "drop" } };
    expect(instructionGraphSourceConflictsWithDose(changedUnit)).toBe(true);
    const changedUnitText = formatCanonicalClause(
      changedUnit, "long", resolveSigLocalization("en"), { realizationMode: "roundtrip" }
    );
    expect(changedUnitText).not.toBe(source);
    expect(changedUnitText).toMatch(/(?<![\w.+-])(?:1|one)\s+drop\b/iu);
  });
});

describe("November 18 overlapping-course maximum supply and rate dose caps", () => {
  const capPeriod = { value: 1, unit: "d" };
  const anchor = "2026-01-01T00:00:00Z";
  const o = { from: anchor, orderedAt: anchor, timeZone: "UTC" };
  const stage = (amounts: Array<{
    quantity?: { value: number; unit: string };
    rate?: { value: number; unit: string };
    rateRatio?: { numerator: { value: number; unit: string }; denominator: { value: number; unit: string } };
  }>, limit: number, maximum?: boolean) => ({
    kind: "course" as const,
    cycleInterval: { value: 1, unit: "d" },
    stages: [{ administrations: [{
      kind: "administration" as const,
      amounts,
      schedule: { recurrence: {
        frequency: 1,
        ...(maximum ? { frequencyMax: 2 } : {}),
        period: 1,
        periodUnit: FhirPeriodUnit.Day,
        clocks: [maximum ? "09:00:00" : "00:00:00"],
        courseLength: { value: 2, unit: "d" },
        ...(amounts[0]?.rate || amounts[0]?.rateRatio
          ? { occurrenceDuration: 1, occurrenceDurationUnit: FhirPeriodUnit.Hour }
          : {}),
      } },
      limits: [{ scope: "period" as const,
        amount: { value: limit, unit: amounts[0]?.quantity?.unit ?? "mL" },
        period: capPeriod
      }]
    }] }]
  });

  it("keeps concrete scheduling at one clock, but computes two-per-cycle maximum supply through shared caps", () => {
    const course = stage([{ quantity: { value: 1, unit: "tab" } }], 4, true);
    expect(nextDueDoses(course, { ...o, limit: 5 })).toEqual([
      "2026-01-01T09:00:00+00:00",
      "2026-01-02T09:00:00+00:00",
      "2026-01-02T09:00:00+00:00",
      "2026-01-03T09:00:00+00:00",
      "2026-01-03T09:00:00+00:00",
    ]);
    const supply = calculateTotalUnits({
      ...o, dosage: course, durationValue: 3, durationUnit: FhirPeriodUnit.Day
    });
    expect(supply).toMatchObject({ totalUnits: 10, unit: "tab", quantityKind: "maximum" });
  });

  it("applies a one-tablet rolling cap to the upper-frequency plan, not just the source clock plan", () => {
    const course = stage([{ quantity: { value: 1, unit: "tab" } }], 1, true);
    // Even two-per-cycle maximum opportunities must respect the one
    // administration/day clinical ceiling across overlapping cycles.
    expect(calculateTotalUnits({
      ...o, dosage: course, durationValue: 3, durationUnit: FhirPeriodUnit.Day
    })).toMatchObject({ totalUnits: 3, unit: "tab", quantityKind: "maximum" });
  });

  it("retains a contradictory 5 mL/day cap without making the 10 mL infusion unschedulable", () => {
    const course = stage([{ rate: { value: 10, unit: "mL/h" } }], 5);
    const scheduled = nextDueDoses(course, { ...o, limit: 4 });
    expect(scheduled).toEqual([
      "2026-01-01T00:00:00+00:00",
      "2026-01-02T00:00:00+00:00",
      "2026-01-02T00:00:00+00:00",
      "2026-01-03T00:00:00+00:00",
    ]);
    const supply = calculateTotalUnits({
      ...o, dosage: course, durationValue: 3, durationUnit: FhirPeriodUnit.Day
    });
    expect(supply).toMatchObject({ totalUnits: 50, unit: "mL", quantityKind: "maximum" });
    expect(supply.explanation).toContain("unevaluable maximum-dose constraint");
    expect(course.stages[0].administrations[0].amounts[0].rate).toEqual({
      value: 10, unit: "mL/h"
    });
  });

  it("evaluates a rate-only maximum-frequency course with the SAME shared volume ceiling", () => {
    const course = stage([{ rate: { value: 10, unit: "mL/h" } }], 10, true);
    const before = structuredClone(course);
    const due = nextDueDoses(course, { ...o, limit: 3 });
    expect(due).toEqual([
      "2026-01-01T09:00:00+00:00",
      "2026-01-02T09:00:00+00:00",
      "2026-01-03T09:00:00+00:00"
    ]);
    expect(calculateTotalUnits({
      ...o, dosage: course, durationValue: 3, durationUnit: FhirPeriodUnit.Day
    })).toMatchObject({ totalUnits: 30, unit: "mL", quantityKind: "maximum" });
    expect(course).toEqual(before);
  });

  it("carries rate-only rolling-cap history across a late supply query", () => {
    const course = stage([{ rate: { value: 10, unit: "mL/h" } }], 10);
    const from = "2026-01-02T12:00:00Z";
    expect(nextDueDoses(course, { ...o, from, limit: 2 })).toEqual([
      "2026-01-03T00:00:00+00:00", "2026-01-04T00:00:00+00:00"
    ]);
    expect(calculateTotalUnits({
      ...o, from, dosage: course, durationValue: 1, durationUnit: FhirPeriodUnit.Day
    }).totalUnits).toBe(10);
  });

  it("carries the pre-query infusion across a 48-hour supply cap", () => {
    const course = stage([{ rate: { value: 10, unit: "mL/h" } }], 10);
    course.stages[0].administrations[0].limits[0].period = { value: 48, unit: "h" };
    const from = "2026-01-02T00:00:00Z";
    // January 1 consumes the window until January 3. Starting the ledger at
    // the query would incorrectly accept January 2 and 4 for twice the supply.
    expect(nextDueDoses(course, { ...o, from, limit: 2 })).toEqual([
      "2026-01-03T00:00:00+00:00", "2026-01-05T00:00:00+00:00"
    ]);
    expect(calculateTotalUnits({
      ...o, from, dosage: course, durationValue: 3, durationUnit: FhirPeriodUnit.Day
    }).totalUnits).toBe(10);
  });

  it("retains an incompatible period cap as unevaluated clinical meaning instead of claiming exact supply", () => {
    const course = stage([{ rate: { value: 10, unit: "mL/h" } }], 10);
    const member = course.stages[0].administrations[0];
    member.limits[0].amount.unit = "mg";
    const originalLimit = structuredClone(member.limits);
    const supply = calculateTotalUnits({
      ...o, dosage: course, durationValue: 3, durationUnit: FhirPeriodUnit.Day
    });
    expect(supply.totalUnits).toBe(50);
    expect(supply.unit).toBe("mL");
    expect(supply.quantityKind).toBe("maximum");
    expect(supply.explanation).toContain("unevaluable maximum-dose constraint");
    expect(member.limits).toEqual(originalLimit);
  });

  for (const [name, amounts] of [
    ["rate quantity", [{ rate: { value: 10, unit: "mL/h" } }]],
    ["rate ratio", [{ rateRatio: { numerator: { value: 10, unit: "mL" },
      denominator: { value: 1, unit: "h" } } }]],
  ] as const) {
    it("applies a 10 mL/24h limit to each measured 10 mL infusion from " + name, () => {
      const course = stage([...amounts], 10);
      expect(nextDueDoses(course, { ...o, limit: 4 })).toEqual([
        "2026-01-01T00:00:00+00:00",
        "2026-01-02T00:00:00+00:00",
        "2026-01-03T00:00:00+00:00",
        "2026-01-04T00:00:00+00:00",
      ]);
      expect(calculateTotalUnits({
        ...o, dosage: course, durationValue: 3, durationUnit: FhirPeriodUnit.Day
      })).toMatchObject({ totalUnits: 30, unit: "mL" });
    });
  }
});

describe("November 18 review: dose ranges own upper-bound rolling-cap quantity", () => {
  const options = {
    from: "2026-01-01T00:00:00Z",
    orderedAt: "2026-01-01T00:00:00Z",
    timeZone: "UTC",
  };
  function rangedCourse(maxPerDay: number) {
    return {
      kind: "course" as const,
      cycleInterval: { value: 1, unit: "d" },
      stages: [{
        administrations: [{
          kind: "administration" as const,
          amounts: [{ range: {
            low: { value: 1, unit: "tab" },
            high: { value: 2, unit: "tab" },
          } }],
          schedule: { recurrence: {
            frequency: 1, frequencyMax: 2,
            period: 1, periodUnit: FhirPeriodUnit.Day,
            clocks: ["09:00:00"],
            courseLength: { value: 2, unit: "d" },
          } },
          limits: [{ scope: "period" as const,
            amount: { value: maxPerDay, unit: "tab" },
            period: { value: 1, unit: "d" },
          }],
        }],
      }],
    };
  }

  it("caps the upper-range maximum plan by tablets, not just administrations", () => {
    const course = rangedCourse(4);
    const original = structuredClone(course);
    // Clinical scheduling uses the one authored concrete clock; the
    // two-per-day range belongs to maximum supply estimation only.
    expect(nextDueDoses(course, { ...options, limit: 3 })).toEqual([
      "2026-01-01T09:00:00+00:00",
      "2026-01-02T09:00:00+00:00",
      "2026-01-02T09:00:00+00:00",
    ]);
    // Jan 1 and Jan 2 each allow only TWO 2-tab administrations:
    // maximum quantity = 4 tabs/day x 2 days = 8, never 12.
    expect(calculateTotalUnits({
      ...options, dosage: course, durationValue: 2,
      durationUnit: FhirPeriodUnit.Day,
    })).toMatchObject({
      totalUnits: 8, unit: "tab", quantityKind: "maximum",
    });
    expect(course).toEqual(original);
  });

  it("uses the upper dose of two tablets when one administration exhausts each day's cap", () => {
    const course = rangedCourse(2);
    expect(calculateTotalUnits({
      ...options, dosage: course, durationValue: 2,
      durationUnit: FhirPeriodUnit.Day,
    })).toMatchObject({
      totalUnits: 4, unit: "tab", quantityKind: "maximum",
    });
  });

  it("uses a feasible one-tablet dose when the cap intersects the authored range", () => {
    const course = rangedCourse(1);
    const supply = calculateTotalUnits({
      ...options, dosage: course, durationValue: 2,
      durationUnit: FhirPeriodUnit.Day,
    });
    expect(supply).toMatchObject({ totalUnits: 2, quantityKind: "maximum" });
    expect(supply.explanation).not.toContain("unevaluable maximum-dose constraint");
    expect(course.stages[0].administrations[0].amounts[0].range.high.value).toBe(2);
  });

  it("keeps a cap below the range's lower endpoint recoverable and explicitly unevaluated", () => {
    const course = rangedCourse(0.5);
    const supply = calculateTotalUnits({
      ...options, dosage: course, durationValue: 2,
      durationUnit: FhirPeriodUnit.Day,
    });
    expect(supply).toMatchObject({ totalUnits: 12, unit: "tab", quantityKind: "maximum" });
    expect(supply.explanation).toContain("unevaluable maximum-dose constraint");
    expect(course.stages[0].administrations[0].amounts[0].range.low.value).toBe(1);
  });
});

// END PRESERVED followup
}


// Retained regression suite from test/course-language.spec.ts.
/** Course language is a facet of the existing localization registry, not
 * another clinical engine. Independent oracles cover both built-in surfaces
 * and a third-language extension without editing canonical semantics. */
{
// BEGIN PRESERVED language
/** Course language is a facet of the existing localization registry, not
 * another clinical engine. Independent oracles cover both built-in surfaces
 * and a third-language extension without editing canonical semantics. */













// Day-number wording is valid only for an explicitly local-day origin.
const boundaries: CanonicalCourse = {
  kind: "course",
  cycleInterval: { value: 7, unit: "d" },
  stages: [
    {
      start: { anchor: "treatment-day-start", displacement: { value: 0, unit: "d" } },
      end: { anchor: "treatment-day-start", displacement: { value: 3, unit: "d" } },
      administrations: [
        {
          kind: "administration",
          amounts: [{ quantity: { value: 2, unit: "tab" } }],
          schedule: { recurrence: { frequency: 1, period: 1, periodUnit: "d" } },
        },
      ],
    },
  ],
};

describe("dependency-free course vocabulary", () => {
  it("reuses the historical weekday tables without a circular locale-registry dependency", () => {
    expect(DAY_NAMES).toBe(ENGLISH_DAY_NAMES);
    expect(DAY_NAMES_THAI).toBe(THAI_DAY_NAMES);
    for (const name of ["en", "th"]) {
      const moduleText = readFileSync(new URL("../src/locales/course/" + name + ".ts", import.meta.url), "utf8");
      expect(moduleText).not.toMatch(/from\s+["']\.\.\/\.\.\/(?:i18n|format)["']/u);
      expect(moduleText).toContain('import type { CourseLanguage } from "../../localization"');
      expect(moduleText).toContain('import { joinLocalizedList } from "../../utils/text"');
    }
  });
  it("retains original 0/1/2/3+ list join behavior without slicing arrays", () => {
    const items = ["Monday", "Tuesday", "Wednesday", "Thursday"];
    expect(joinWithAnd([])).toBe("");
    expect(joinWithAnd(items.slice(0, 1))).toBe("Monday");
    expect(joinWithAnd(items.slice(0, 2))).toBe("Monday and Tuesday");
    expect(joinWithAnd(items.slice(0, 3))).toBe("Monday, Tuesday and Wednesday");
    expect(joinWithAnd(items)).toBe("Monday, Tuesday, Wednesday and Thursday");
    expect(joinWithAndThai(items.slice(0, 3))).toBe("Monday, Tuesday และ Wednesday");
    expect(joinLocalizedList(items, "ou")).toBe("Monday, Tuesday, Wednesday ou Thursday");
  });
});

describe("course locale boundary", () => {
  it("keeps built-in clinical windows, gaps and repeat periods exact in EN and TH", () => {
    const en = formatCanonicalCourse(boundaries, "long", { locale: "en" });
    const th = formatCanonicalCourse(boundaries, "long", { locale: "th" });
    expect(en).toContain("Days 1–3:");
    expect(en).toContain("No doses on days 4–7.");
    expect(en).toContain("Repeat this schedule every 7 days");
    expect(th).toContain("วันที่ 1–3:");
    expect(th).toContain("งดยาในวันที่ 4–7.");
    expect(th).toContain("ทำซ้ำแผนการใช้ยานี้ทุก 7 วัน");
  });
  it("preserves Boolean grouping and the distinction between a negated state and an outer unless", () => {
    const guard = {
      kind: "all" as const,
      conditions: [
        { kind: "state" as const, name: "awake", expected: false },
        {
          kind: "any" as const,
          conditions: [
            { kind: "measurement" as const, name: "SBP", operation: "gt" as const, value: 100 },
            { kind: "measurement" as const, name: "HR", operation: "lt" as const, value: 90 },
          ],
        },
      ],
    };
    expect(appendMedicationConditionText("Take 1 tablet.", guard, { locale: "en" })).toBe(
      "Take 1 tablet only if not awake and (SBP > 100 or HR < 90)."
    );
    expect(appendMedicationConditionText("รับประทาน 1 เม็ด.", guard, { locale: "th" })).toBe(
      "รับประทาน 1 เม็ด เฉพาะเมื่อ ไม่ awake และ (SBP > 100 หรือ HR < 90)."
    );
    const outerUnless = { kind: "not" as const, condition: guard };
    expect(appendMedicationConditionText("Take 1 tablet.", outerUnless, { locale: "en" })).toBe(
      "Take 1 tablet unless not awake and (SBP > 100 or HR < 90)."
    );
    expect(appendMedicationConditionText("รับประทาน 1 เม็ด.", outerUnless, { locale: "th" })).toBe(
      "รับประทาน 1 เม็ด เว้นแต่ ไม่ awake และ (SBP > 100 หรือ HR < 90)."
    );
  });
  it("adds a third language through the same registration including clauses, stages, rates and conditions", () => {
    let checkMethod = false, methodChecks = 0, nativeDefault = "";
    registerSigLocalization({
      locale: "course-test",
      formatLong: ({ clause, defaultText }) => {
        nativeDefault = defaultText;
        if (checkMethod) {
          expect(clause.method?.text).toBe("Apply");
          expect(clause.schedule).toMatchObject({ frequency: 2, period: 1, periodUnit: "d" });
          methodChecks++;
        }
        return "Dose locale.";
      },
      formatShort: () => "Dose locale.",
      course: {
        ...ENGLISH_COURSE,
        dayRange: (a, b) => `Jours ${a}–${b}`,
        noDoseDays: (a, b) => `Pause ${a}–${b}.`,
        timeUnit: (unit) => (unit === "d" ? "jours" : unit),
        repeatCycle: (interval) => `Répéter ${interval}.`,
        rateLabel: "Débit: ",
        unspecified: "non spécifié",
        onlyIf: "si",
        notPrefix: "non ",
        allSeparator: " et ",
        anySeparator: " ou ",
      },
    });
    const text = formatCanonicalCourse(boundaries, "long", { locale: "course-test" });
    expect(text).toContain("Jours 1–3: Dose locale.");
    expect(text).toContain("Pause 4–7.");
    expect(text).toContain("Répéter 7 jours.");
    expect(text).not.toContain("Days");
    expect(
      formatCanonicalAdministration(
        { kind: "administration", amounts: [{ rate: { unit: "mL/h" } }] },
        "long",
        { locale: "course-test" }
      )
    ).toBe("Dose locale.");
    expect(nativeDefault).toContain("Débit: non spécifié mL/h");
    expect(
      appendMedicationConditionText(
        "Dose.",
        { kind: "state", name: "awake", expected: false },
        { locale: "course-test" }
      )
    ).toBe("Dose si non awake.");
    // The same inheritance configuration applies to course and clause facets.
    expect(
      formatCanonicalCourse(boundaries, "long", {
        i18n: { inherit: "course-test", locale: "course-derived" },
      })
    ).toContain("Jours 1–3");
    // Typed method/cadence ownership also works for registered and inherited
    // packs, without comparing their wording with built-in language output.
    const methodRow: FhirDosage = {
      text: "Dose locale.", method: { text: "Apply" },
      timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day } },
      extension: [{ url: "urn:round59:locale-source", valueString: "retain complete input" }]
    };
    const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
    const methodR6 = fresh(toDosageDetails([fresh(methodRow)]));
    checkMethod = true;
    for (const options of [
      { locale: "course-test", realizationMode: "normalized" as const },
      { i18n: { inherit: "course-test", locale: "course-derived" }, realizationMode: "normalized" as const }
    ]) {
      for (const input of [fresh(methodRow), fresh(methodR6), fresh(toFhirR5Dosages(methodR6))]) {
        const before = fresh(input), previousChecks = methodChecks;
        expect(formatSig(input, "long", options)).toBe("Dose locale.");
        expect(methodChecks).toBeGreaterThan(previousChecks);
        expect(input).toEqual(before);
      }
      expect(formatCanonicalAdministration({
        kind: "administration", text: methodRow.text, method: methodRow.method,
        schedule: { recurrence: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day } }
      }, "long", options)).toBe("Dose locale.");
    }
    checkMethod = false;
    expect(toDosageDetails(fresh(toFhirR5Dosages(methodR6)))).toEqual(methodR6);
  });
  it("applies per-call inheritance to public R5 choices and standalone course wording", () => {
    const inherited = {
      ...ENGLISH_COURSE,
      choicePrefix: "Sélection: ",
      anySeparator: " ou ",
      exceptWeekdays: "sauf ",
      weekdayName: () => "lundi",
      joinList: (items: readonly string[]) => items.join(" et "),
    };
    registerSigLocalization({
      locale: "choice-inherit",
      formatLong: ({ clause }) => "Dose " + clause.dose?.value + ".",
      course: inherited,
    });
    const rows: FhirDosage[] = [1, 2].map(value => ({
      doseAndRate: [{ doseQuantity: { value, unit: "tab" } }],
    }));
    for (let i = 0; i < rows.length; i++)
      setDosageAlternativeChoice(rows[i], {
        groupId: "one-choice",
        branchId: String(i),
        selectionBehavior: "exactly-one",
      });
    const options = { i18n: { locale: "unregistered-output-tag", inherit: "choice-inherit" } };
    expect(formatSigBatch(rows, "long", options)).toBe("Sélection: Dose 1 ou Dose 2.");
    expect(appendMedicationExcludedWeekdaysText("Dose.", ["mon"], options)).toBe("Dose sauf lundi.");
  });
  it("keeps a course-only override even when no clause callbacks are registered", () => {
    registerSigLocalization({ locale: "course-only", course: ENGLISH_COURSE });
    const course = { ...ENGLISH_COURSE, onlyIf: "provided that" };
    expect(resolveSigLocalization("course-only", { course })?.course).toBe(course);
    expect(
      appendMedicationConditionText(
        "Dose.",
        { kind: "state", name: "awake", expected: true },
        { locale: "course-only", i18n: { course } }
      )
    ).toBe("Dose provided that awake.");
  });
  it("does not resolve or interpret language in the clinical course algorithm", () => {
    const source = readFileSync(new URL("../src/canonical/format-course.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/(?:startsWith|indexOf)\(["']th["']\)|\bthai\s*\?/u);
    expect(source).not.toMatch(/[ก-๙]/u);
    expect(resolveSigLocalization("th")?.course).toBeDefined();
  });
});


describe("round 28 complete-value locale facets", () => {
  it("passes a complete count and period to a suffix-language upper-bound template", () => {
    registerSigLocalization({
      locale: "course-suffix-bound",
      formatLong: ({ defaultText }) => defaultText,
      course: { ...ENGLISH_COURSE, upTo: value => value + "以下" }
    });
    const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [{
      kind: "administration",
      amounts: [{ quantity: { value: 1, unit: "tab" } }],
      schedule: { recurrence: { frequencyMax: 2, periodMax: 3, periodUnit: "d",
        startOffset: { value: 1, unit: "h" } } }
    }] }] };
    const text = formatCanonicalCourse(course, "long", { locale: "course-suffix-bound" });
    expect(text).toContain("2以下 administrations per 3 days以下");
    expect(text).not.toMatch(/以下2|以下3/);
  });

  it("does not assert a global pause by comparing elapsed and civil origins", () => {
    const mixed: CanonicalCourse = { kind: "course", stages: [
      { start: { anchor: "treatment-start", displacement: { value: 0, unit: "d" } },
        end: { anchor: "treatment-start", displacement: { value: 2, unit: "d" } },
        administrations: [{ kind: "administration", amounts: [{ quantity: { value: 1, unit: "tab" } }] }] },
      { start: { anchor: "treatment-day-start", displacement: { value: 4, unit: "d" } },
        end: { anchor: "treatment-day-start", displacement: { value: 6, unit: "d" } },
        administrations: [{ kind: "administration", amounts: [{ quantity: { value: 2, unit: "tab" } }] }] }
    ] };
    const text = formatCanonicalCourse(mixed, "long", { locale: "en" });
    expect(text).toContain("From treatment start until 2 days after treatment start");
    expect(text).toContain("Days 5–6");
    expect(text).not.toContain("No doses");
  });
});


describe("round 28 origin-aware member and ranged windows", () => {
  it("renders an executable local-day member without a review warning", () => {
    const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [
      { kind: "administration", phaseStart: { anchor: "treatment-day-start",
          displacement: { value: 4, code: "d" } },
        amounts: [{ quantity: { value: 1, unit: "tab" } }] }
    ] }] };
    const en = formatCanonicalCourse(course, "long", { locale: "en" });
    const th = formatCanonicalCourse(course, "long", { locale: "th" });
    expect(en).toContain("From day 5 onward");
    expect(en).not.toContain("requires review");
    expect(th).toContain("ตั้งแต่วันที่ 5 เป็นต้นไป");
    expect(th).not.toContain("ต้องตรวจสอบ");
  });

  it("keeps an elapsed member floor visible inside an equal-number local-day stage", () => {
    const course: CanonicalCourse = { kind: "course", stages: [{
      start: { anchor: "treatment-day-start", displacement: { value: 4, code: "d" } },
      end: { anchor: "treatment-day-start", displacement: { value: 6, code: "d" } },
      administrations: [{ kind: "administration", phaseOrigin: { value: 4, code: "d" },
        amounts: [{ quantity: { value: 1, unit: "tab" } }] }]
    }] };
    const text = formatCanonicalCourse(course, "long", { locale: "en" });
    expect(text).toContain("Days 5–6");
    expect(text).toContain("From 4 days after treatment start onward");
  });

  it("uses the same local-day origin for scalar and ranged sides of a window", () => {
    const course: CanonicalCourse = { kind: "course", stages: [{
      start: { anchor: "treatment-day-start", displacement: { value: 4, code: "d" } },
      end: { anchor: "treatment-day-start",
        displacementRange: { low: { value: 6, code: "d" }, high: { value: 8, code: "d" } } },
      administrations: [{ kind: "administration", amounts: [{ quantity: { value: 1, unit: "tab" } }] }]
    }] };
    const text = formatCanonicalCourse(course, "long", { locale: "en" });
    expect(text).toContain("From 4 days after the start of the first treatment day until 6 days – 8 days after the start of the first treatment day");
    expect(text).not.toContain("4 days after treatment start");
    // The known leading gap is still exact; the ranged end licenses no
    // invented trailing pause.
    expect(text).toContain("No doses on days 1–4.");
    expect(text.match(/No doses/g)).toHaveLength(1);
  });
});


it("uses locale-owned measurement labels with live values and retained old source text", () => {
  const condition = { kind: "measurement" as const, name: "bp", operation: "gt" as const,
    value: 150, text: "BP > 160" };
  const source = JSON.stringify(condition);
  expect(appendMedicationConditionText("Dose.", condition, { locale: "en" })).toBe("Dose only if BP > 150.");
  expect(appendMedicationConditionText("ยา.", condition, { locale: "th" })).toBe("ยา เฉพาะเมื่อ BP > 150.");
  expect(JSON.stringify(condition)).toBe(source);
  expect(appendMedicationConditionText("Dose.", { ...condition, name: "custom pressure" }, { locale: "en" }))
    .toBe("Dose only if custom pressure > 150.");
});

// END PRESERVED language
}


describe("round39 metric totals and live event identity", () => {
  it.each([false, true])("does not distribute metric bilateral endpoints per eye (labelled %s)", labelled => {
    const range = {
      low: { value: 500, unit: "uL", code: "uL", system: "http://unitsofmeasure.org" },
      high: { value: 1, unit: "mL", code: "mL", system: "http://unitsofmeasure.org" }
    };
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      site: { concept: { text: "both eyes", coding: [{ system: "http://snomed.info/sct", code: "40638003" }] } },
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
      doseAndRate: [{ ...(labelled ? { type: { coding: [{ code: "ordered" }] } } : {}), doseRange: range }]
    }] }] };
    const original = JSON.stringify(raw);
    const course = courseFromR6(raw);
    expect(course.stages[0].administrations[0].targetCount).toBe(2);
    for (const input of [raw, course, JSON.parse(JSON.stringify(toFhirR5Dosages(raw)))]) {
      const english = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      const thai = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(english).toContain("500 uL – 1 mL");
      expect(english).not.toMatch(/per administration target|each eye/u);
      expect(thai).toContain("500 uL – 1 mL");
      expect(thai).not.toMatch(/แต่ละจุด|ข้างละ/u);
    }
    expect(courseToR6(course).step![0].component[0].doseAndRate![0].doseRange).toEqual(range);
    expect(JSON.stringify(raw)).toBe(original);
  });

  it("keeps a labelled discrete drop range per target beside a metric total", () => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      site: { concept: { text: "both eyes", coding: [{ system: "http://snomed.info/sct", code: "40638003" }] } },
      doseAndRate: [
        { type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/dose-rate-type", code: "ordered" }] },
          doseRange: { low: { value: 1, unit: "drop" }, high: { value: 2, unit: "drop" } } },
        { doseQuantity: { value: 1, unit: "mL" } }
      ]
    }] }] };
    for (const input of [raw, JSON.parse(JSON.stringify(toFhirR5Dosages(raw)))]) {
      const text = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(text).toMatch(/Ordered dose: 1 to 2 drops \(per administration target\)/u);
      expect(text).toContain("Dose: 1 mL");
      expect(text).not.toMatch(/1 mL \(per administration target\)/u);
      const thai = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(thai.split(/;\s*/u).filter(fragment => fragment.startsWith("ขนาดยา"))).toEqual([
        "ขนาดยาที่สั่ง: แต่ละจุด 1 ถึง 2 หยด",
        "ขนาดยาต่อครั้ง: ครั้งละ 1 มิลลิลิตร"
      ]);
    }
  });

  it.each([
    ["QHS", EventTiming["Before Sleep"], true],
    ["QHS", EventTiming.Morning, false],
    ["AM", EventTiming.Morning, true],
    ["AM", EventTiming.Evening, false],
    ["PM", EventTiming.Evening, true],
    ["PM", EventTiming.Morning, false]
  ] as const)("uses %s only when its live event %s agrees", (code, event, matches) => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { code: { text: code }, repeat: {
        frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, when: [event]
      } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    const original = JSON.stringify(raw);
    for (const input of [raw, JSON.parse(JSON.stringify(toFhirR5Dosages(raw)))]) {
      const short = formatSig(input, "short", { locale: "en", realizationMode: "normalized" });
      expect(short.includes(code)).toBe(matches);
      if (!matches) expect(short).toContain(event);
      const long = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(long).toContain(event === EventTiming.Morning ? "morning" :
        event === EventTiming.Evening ? "evening" : "bedtime");
    }
    expect(JSON.stringify(raw)).toBe(original);
    expect(courseToR6(courseFromR6(raw)).step![0].component[0].timing!.code!.text).toBe(code);
  });
});


describe("round40 current R6 generation and localized previews", () => {
  it.each([false, true])("preserves requested generation mode with live structured R6 data (saved text %s)", hasText => {
    const seen: string[] = [];
    registerSigLocalization({
      locale: "round40-mode",
      formatLong: context => {
        seen.push(context.realizationMode);
        return context.realizationMode + " dose " + context.clause.dose?.value;
      },
      formatShort: context => {
        seen.push(context.realizationMode);
        return context.realizationMode + " dose " + context.clause.dose?.value;
      }
    });
    const raw: FhirR6DosageInstruction = {
      ...(hasText ? { renderedInstruction: "Old course: 9 tablets" } : {}),
      step: [{ component: [{
        ...(hasText ? { text: "Old component: 9 tablets" } : {}),
        doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }]
      }] }]
    };
    const original = JSON.stringify(raw), course = courseFromR6(raw);
    for (const style of ["short", "long"] as const) {
      const options = { locale: "round40-mode", realizationMode: "roundtrip" as const };
      expect(formatSig(raw, style, options)).toContain("roundtrip dose 2");
      expect(formatCanonicalCourse(course, style, options)).toContain("roundtrip dose 2");
      expect(formatCanonicalAdministration(course.stages[0].administrations[0], style, options))
        .toContain("roundtrip dose 2");
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(mode => mode === "roundtrip")).toBe(true);
    expect(JSON.stringify(raw)).toBe(original);
    expect(courseToR6(course).renderedInstruction).toBe(raw.renderedInstruction);
    expect(courseToR6(course).step[0].component[0].text).toBe(raw.step[0].component[0].text);
  });

  it("keeps text-only external R6 directions when no clinical fields can replace them", () => {
    const raw: FhirR6DosageInstruction = {
      renderedInstruction: "Follow specialist directions", step: [{ component: [{ text: "Use the supplied instructions" }] }]
    };
    expect(formatSig(raw, "long", { locale: "en", realizationMode: "roundtrip" }))
      .toBe("Follow specialist directions");
    const course = courseFromR6(raw);
    expect(formatCanonicalAdministration(course.stages[0].administrations[0], "long",
      { locale: "en", realizationMode: "roundtrip" })).toBe("Use the supplied instructions");
  });

  it("localizes a labelled scalar independently of a per-target scope", () => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      route: { text: "oral" },
      doseAndRate: [{ type: { coding: [{
        system: "http://terminology.hl7.org/CodeSystem/dose-rate-type", code: "ordered"
      }] }, doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    const original = JSON.stringify(raw);
    for (const input of [raw, JSON.parse(JSON.stringify(toFhirR5Dosages(raw)))]) {
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(th).toContain("ขนาดยาที่สั่ง:");
      expect(th).toContain("1 เม็ด");
      expect(th).not.toMatch(/1 tab|แต่ละจุด/u);
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(en).toContain("Ordered dose: 1 tablet");
    }
    expect(JSON.stringify(raw)).toBe(original);
  });
});

describe("round 41 execution corrections", () => {
  const anchor = "2026-01-01T00:00:00Z";
  const context = { orderedAt: anchor, from: anchor, timeZone: "UTC" };
  const daily = (): CanonicalAdministration => ({
    kind: "administration", amounts: [{ quantity: { value: 1, unit: "tab" } }],
    schedule: { recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
      clocks: ["09:00:00"] } }
  });
  const projections = (course: CanonicalCourse) => {
    const r6 = courseToR6(course);
    return [course, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))];
  };

  it.each([false, true])("uses the measured lower dose unit regardless of maximum order (%s)", reverse => {
    const maxima: FhirR6DoseLimit[] = [
      { scope: "administration", valueQuantity: { value: 20, unit: "mg" } },
      { scope: "administration", valueQuantity: { value: 10, unit: "mL" } }
    ];
    if (reverse) maxima.reverse();
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseRange: {
        low: { value: 5, unit: "mL" }, high: { id: "unbounded-upper" }
      } }],
      timing: { repeat: { count: 1, timeOfDay: ["09:00:00"] } },
      safety: { doseLimit: maxima }
    }] }] };
    const original = structuredClone(raw);
    for (const dosage of [raw, courseFromR6(raw),
        JSON.parse(JSON.stringify(toFhirR5Dosages(raw)))]) {
      const total = calculateTotalUnits({ dosage, ...context,
        durationValue: 1, durationUnit: FhirPeriodUnit.Day });
      expect(total).toMatchObject({ totalUnits: 10, unit: "mL", quantityKind: "maximum" });
      expect(total.explanation).toContain("unevaluable maximum-dose constraint");
    }
    expect(raw).toEqual(original);
    const saved = courseToR6(courseFromR6(raw)).step![0].component[0];
    expect(saved.doseAndRate).toEqual(raw.step![0].component[0].doseAndRate);
    expect(saved.safety!.doseLimit).toEqual(maxima);
  });

  it.each([
    ["2026-10-29T23:30:00-04:00", "2026-10-30T00:00:00-04:00",
      ["2026-10-29T23:45:00-04:00", "2026-10-30T00:00:00-04:00", "2026-10-31T00:00:00-04:00"]],
    ["2026-10-31T23:30:00-04:00", "2026-11-01T00:00:00-04:00",
      ["2026-10-31T23:45:00-04:00", "2026-11-01T00:00:00-04:00", "2026-11-02T00:00:00-05:00"]]
  ] as const)("retains local-day occurrence history across the cycle starting %s", (orderedAt, from, expected) => {
    const course = courseFromR6({ repeatCycle: { value: 1, unit: "d" }, step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["00:00:00", "23:45:00"], boundsDuration: { value: 1, unit: "d" },
        extension: [{ url: TIMING_OCCURRENCE_CAP_EXTENSION_URL, extension: [
          { url: "max", valueInteger: 1 }, { url: "period", valueQuantity: { value: 1, unit: "d" } }
        ] }]
      } }
    }] }] });
    const before = structuredClone(course);
    for (const dosage of projections(course)) {
      const options = { orderedAt, timeZone: "America/New_York" };
      expect(nextDueDoses(dosage, { ...options, from: orderedAt, limit: 3 })).toEqual(expected);
      expect(calculateTotalUnits({ dosage, ...options, from,
        durationValue: 1, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(1);
    }
    expect(course).toEqual(before);
  });

  it.each([undefined, 1])("counts accepted scheduled doses with lower count %s", count => {
    const member = daily();
    Object.assign(member.schedule!.recurrence!, { count, countMax: 2 });
    member.excludedDates = ["2026-01-01"];
    const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [member] }] };
    const before = structuredClone(course);
    for (const dosage of projections(course)) {
      expect(nextDueDoses(dosage, { ...context, limit: 3 })).toEqual([
        "2026-01-02T09:00:00+00:00", "2026-01-03T09:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ dosage, ...context,
        durationValue: 3, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(2);
    }
    expect(course).toEqual(before);
    const ordinary = daily();
    Object.assign(ordinary.schedule!.recurrence!, { count, countMax: 2 });
    expect(nextDueDoses(ordinary, { ...context, limit: 3 })).toEqual([
      "2026-01-01T09:00:00+00:00", "2026-01-02T09:00:00+00:00"
    ]);
    const successor = daily();
    successor.schedule!.recurrence!.clocks = ["12:00:00"];
    const sequential: CanonicalCourse = { kind: "course",
      stages: [{ administrations: [member] }, { administrations: [successor] }] };
    expect(nextDueDoses(sequential, { ...context, limit: 4 })).toEqual([
      "2026-01-02T09:00:00+00:00", "2026-01-03T09:00:00+00:00"
    ]);
  });

  it.each([undefined, 35])("measures the infusion duration range before the shared cap (maximum %s)", maximum => {
    const course = courseFromR6({ repeatCycle: { value: 1, unit: "d" }, step: [{ component: [{
      doseAndRate: [{ rateQuantity: { value: 20, unit: "mL/h" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["09:00:00"], boundsDuration: { value: 2, unit: "d" },
        extension: [{
          url: "urn:ezmedicationinput:StructureDefinition:timing-administration-duration",
          valueRange: { low: { value: 1, unit: "h" }, high: { value: 2, unit: "h" } }
        }]
      } },
      safety: { doseLimit: [
        ...(maximum === undefined ? [] : [{ scope: "administration" as const,
          valueQuantity: { value: maximum, unit: "mL" } }]),
        { scope: "period", valueQuantity: { value: 100, unit: "mL" }, period: { value: 24, unit: "h" } }
      ] }
    }] }] });
    const before = structuredClone(course);
    for (const dosage of projections(course)) {
      expect(calculateTotalUnits({ dosage, ...context,
        durationValue: 2, durationUnit: FhirPeriodUnit.Day })).toMatchObject({
        totalUnits: maximum === undefined ? 120 : 105, unit: "mL", quantityKind: "maximum"
      });
    }
    expect(course).toEqual(before);
  });

  it.each([
    ["urn:local", "h", "half-hour blocks", undefined],
    ["http://unitsofmeasure.org", "h", "hours", 200],
    ["http://unitsofmeasure.org", "h{infusion}", "hours", 200],
    [undefined, "h", "hours", 200]
  ] as const)("interprets a duration code only in its supported system (%s, %s)", (system, code, unit, expected) => {
    const endpoint = { value: 2, code, unit, ...(system ? { system } : {}) };
    const range = { low: { ...endpoint }, high: { ...endpoint } };
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ rateQuantity: { value: 100, unit: "mL/h" } }],
      timing: { repeat: { count: 1, timeOfDay: ["09:00:00"], extension: [{
        url: "urn:ezmedicationinput:StructureDefinition:timing-administration-duration",
        valueRange: range
      }] } }
    }] }] };
    const before = structuredClone(raw);
    for (const dosage of [raw, courseFromR6(raw),
        JSON.parse(JSON.stringify(toFhirR5Dosages(raw)))]) {
      const supply = () => calculateTotalUnits({ dosage, ...context,
        durationValue: 1, durationUnit: FhirPeriodUnit.Day });
      if (expected === undefined) expect(supply).toThrowError(expect.objectContaining({ code: "rate-units-unresolved" }));
      else expect(supply().totalUnits).toBe(expected);
    }
    expect(raw).toEqual(before);
    expect(courseToR6(courseFromR6(raw)).step![0].component[0].timing!.repeat!.extension!
      .find(extension => extension.url === "urn:ezmedicationinput:StructureDefinition:timing-administration-duration")
      ?.valueRange).toEqual(range);
  });

  it.each([undefined, 3])("keeps scalar and single-member rounding below the lifetime maximum (%s)", maximum => {
    const raw: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] } },
      ...(maximum === undefined ? {} : { maxDosePerLifetime: { value: maximum, unit: "tab" } })
    };
    const course = courseFromAdministrations([inputToCanonical(raw) as CanonicalAdministration], "");
    for (const dosage of [raw, [raw], ...projections(course)]) {
      expect(calculateTotalUnits({ dosage, ...context, roundToMultiple: 5,
        durationValue: 7, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(maximum ?? 10);
    }
  });

  it.each([
    [1, 2, false], [undefined, 2, false], [1, 1, true], [1, undefined, true]
  ] as const)("requires an exact duration to complete a counted phase (%s to %s)", (duration, durationMax, exact) => {
    const raw: FhirR6DosageInstruction = { step: [
      { component: [{
        doseAndRate: [{ rateQuantity: { value: 10, unit: "mL/h" } }],
        timing: { repeat: { count: 1, timeOfDay: ["08:00:00"],
          duration, durationMax, durationUnit: FhirPeriodUnit.Hour } }
      }] },
      { component: [{
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          timeOfDay: ["09:30:00"] } }
      }] }
    ] };
    const before = structuredClone(raw);
    for (const dosage of [raw, courseFromR6(raw),
        JSON.parse(JSON.stringify(toFhirR5Dosages(raw)))]) {
      expect(nextDueDoses(dosage, { ...context, limit: 2 })).toEqual([
        "2026-01-01T08:00:00+00:00",
        ...(exact ? ["2026-01-01T09:30:00+00:00"] : [])
      ]);
    }
    expect(raw).toEqual(before);
  });
});


describe("round 42 execution phase and history ownership", () => {
  const anchor = "2026-01-01T00:00:00Z";
  const context = { orderedAt: anchor, from: anchor, timeZone: "UTC" };
  const periodLimit = (unit = "mL", value = 100): FhirR6DoseLimit => ({
    scope: "period", valueQuantity: { value, unit }, period: { value: 24, unit: "h" }
  });
  const boundary = (value: number) => ({
    contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] },
    offsetDuration: { value, unit: "d" }
  });
  const maintenance = (): FhirR6Dosage => ({
    doseAndRate: [{ doseQuantity: { value: 10, unit: "mL" } }],
    timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["11:00:00"] } }
  });
  const surfaces = (raw: FhirR6DosageInstruction) => [
    raw, courseFromR6(raw), JSON.parse(JSON.stringify(toFhirR5Dosages(raw)))
  ];

  it.each([false, true])("uses a known phase fence when infusion completion is uncertain (%s)", fenced => {
    const raw: FhirR6DosageInstruction = { repeatCycle: { value: 7, unit: "d" }, step: [
      { component: [{
        doseAndRate: [{ doseQuantity: { value: 10, unit: "mL" } }],
        timing: { repeat: { count: 1, frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          timeOfDay: ["08:00:00"], durationMax: 2, durationUnit: FhirPeriodUnit.Hour,
          ...(fenced ? { boundsDuration: { value: 1, unit: "d" } } : {}) } },
        safety: { doseLimit: [periodLimit()] }
      }] },
      { ...(fenced ? { start: boundary(1) } : {}), component: [maintenance()] }
    ] };
    const before = structuredClone(raw);
    for (const dosage of surfaces(raw)) {
      expect(nextDueDoses(dosage, { ...context, limit: 2 })).toEqual([
        "2026-01-01T08:00:00+00:00",
        fenced ? "2026-01-02T11:00:00+00:00" : "2026-01-08T08:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ dosage, ...context,
        durationValue: 2, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(fenced ? 20 : 10);
    }
    expect(raw).toEqual(before);
  });

  it.each([false, true])("measures the upper infusion amount without inventing exact completion (%s)", exact => {
    const raw: FhirR6DosageInstruction = { repeatCycle: { value: 7, unit: "d" }, step: [
      { component: [{
        doseAndRate: [{ rateQuantity: { value: 20, unit: "mL/h" } }],
        timing: { repeat: { count: 1, frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          timeOfDay: ["08:00:00"], duration: exact ? 2 : 1, ...(exact ? {} : { durationMax: 2 }),
          durationUnit: FhirPeriodUnit.Hour } },
        safety: { doseLimit: [periodLimit()] }
      }] },
      { component: [maintenance()] }
    ] };
    const before = structuredClone(raw);
    for (const dosage of surfaces(raw)) {
      expect(nextDueDoses(dosage, { ...context, limit: 2 })).toEqual([
        "2026-01-01T08:00:00+00:00",
        exact ? "2026-01-01T11:00:00+00:00" : "2026-01-08T08:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ dosage, ...context,
        durationValue: 1, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(exact ? 50 : 40);
    }
    expect(raw).toEqual(before);
  });

  it.each([
    ["2026-01-01T12:00:00Z", [], 2],
    ["2026-01-01T12:00:00Z", ["2026-01-01T08:00:00Z"], 0],
    ["2026-01-02T12:00:00Z", ["2026-01-01T08:00:00Z"], 2]
  ] as const)("counts recorded PRN use from its phase origin, query %s", (from, recorded, total) => {
    const raw: FhirR6DosageInstruction = { repeatCycle: { value: 1, unit: "d" }, step: [{ component: [{
      asNeeded: true,
      doseAndRate: [{ doseRange: { low: { value: 1, unit: "tab" }, high: { value: 2, unit: "tab" } } }],
      timing: { repeat: { countMax: 1, boundsDuration: { value: 1, unit: "d" },
        extension: [{ url: TIMING_OCCURRENCE_CAP_EXTENSION_URL, extension: [
          { url: "max", valueInteger: 2 }, { url: "period", valueQuantity: { value: 1, unit: "d" } }
        ] }] } },
      safety: { doseLimit: [periodLimit("tab", 10)] }
    }] }] };
    const before = structuredClone(raw);
    const options = { ...context, from, priorDoseTimes: [...recorded] };
    for (const dosage of surfaces(raw)) {
      expect(nextDueDoses(dosage, { ...options, limit: 2 })).toEqual([]);
      expect(calculateTotalUnits({ dosage, ...options,
        durationValue: 12, durationUnit: FhirPeriodUnit.Hour }).totalUnits).toBe(total);
    }
    expect(raw).toEqual(before);
  });

  it("skips an unselected persisted R5 branch before checking its edited timing", () => {
    const raw: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: {
        code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "BID" }] },
        repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day }
      }
    };
    setDosageAlternativeChoice(raw, { groupId: "mode", branchId: "B", selectionBehavior: "exactly-one" });
    const selected = { ...context, alternativeChoices: { mode: "B" } };
    expect(nextDueDoses(raw, { ...selected, limit: 2 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00"
    ]);
    const saved: FhirDosage = JSON.parse(JSON.stringify(raw));
    saved.timing!.repeat!.frequency = 1;
    const before = structuredClone(saved);
    const unselected = { ...context, alternativeChoices: { mode: "A" } };
    expect(nextDueDoses(saved, { ...unselected, limit: 2 })).toEqual([]);
    expect(calculateTotalUnits({ dosage: saved, ...unselected,
      durationValue: 1, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(0);
    expect(() => nextDueDoses(saved, { ...selected, limit: 2 }))
      .toThrowError(expect.objectContaining({ code: "timing-code-repeat-conflict" }));
    expect(() => calculateTotalUnits({ dosage: saved, ...selected,
      durationValue: 1, durationUnit: FhirPeriodUnit.Day }))
      .toThrowError(expect.objectContaining({ code: "timing-code-repeat-conflict" }));
    expect(saved).toEqual(before);
  });

  it.each([1, 2])("keeps %s prior-cycle records outside the next cycle's finite quota", recordedCount => {
    const raw: FhirR6DosageInstruction = { repeatCycle: { value: 1, unit: "d" }, step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { count: 1, frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["09:00:00"], boundsPeriod: { start: "2026-01-01" } } },
      safety: { doseLimit: [periodLimit("tab", 10)] }
    }] }] };
    const priorDoseTimes = ["2026-01-01T09:00:00Z", "2026-01-01T10:00:00Z"].slice(0, recordedCount);
    const options = { ...context, from: "2026-01-02T00:00:00Z", priorDoseTimes };
    const before = structuredClone(raw);
    for (const dosage of surfaces(raw)) {
      expect(nextDueDoses(dosage, { ...options, limit: 2 })).toEqual([
        "2026-01-02T09:00:00+00:00", "2026-01-03T09:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ dosage, ...options,
        durationValue: 1, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(1);
      const usedCurrent = { ...options, from: "2026-01-02T12:00:00Z",
        priorDoseTimes: [...priorDoseTimes, "2026-01-02T08:00:00Z"] };
      expect(nextDueDoses(dosage, { ...usedCurrent, limit: 1 })).toEqual(["2026-01-03T09:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage, ...usedCurrent,
        durationValue: 12, durationUnit: FhirPeriodUnit.Hour }).totalUnits).toBe(0);
    }
    expect(raw).toEqual(before);
  });
});


describe("round 42 clockless daily window", () => {
  it.each([
    ["Take 1 tablet daily between 18:00 and 20:00 for 7 days", ["18:00:00"], 7],
    ["Take 1 tablet daily for 7 days", ["09:00:00"], 7],
    ["Take 1 tablet every 3 hours between 07:00 and 19:00 for 7 days",
      ["07:00:00", "10:00:00", "13:00:00", "16:00:00", "19:00:00"], 35]
  ] as const)("uses the established clock origin for %s", (source, clocks, total) => {
    const parsed = parseSig(source);
    const before = JSON.stringify(parsed);
    const expected = Array.from({ length: 7 }, (_, day) =>
      clocks.map(clock => "2026-12-0" + (day + 1) + "T" + clock + "+00:00")).flat();
    const context = { orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-01T00:00:00Z", timeZone: "UTC" };
    for (const dosage of [parsed, parsed.meta.canonical.course!, parsed.fhirNext,
        JSON.parse(JSON.stringify(parsed.fhir))]) {
      expect(nextDueDoses(dosage, { ...context, limit: 40 })).toEqual(expected);
      expect(calculateTotalUnits({ dosage, ...context,
        durationValue: 7, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(total);
    }
    expect(JSON.stringify(parsed)).toBe(before);
  });
});

describe("round 43 supported supply bounds", () => {
  const origin = "2026-01-01T00:00:00Z";
  const options = { orderedAt: origin, from: origin, timeZone: "UTC" };
  const periodLimit = (value: number, unit: string): FhirR6DoseLimit => ({
    scope: "period", valueQuantity: { value, unit }, period: { value: 24, unit: "h" }
  });
  const surfaces = (raw: FhirR6DosageInstruction) => [
    raw, courseFromR6(raw), JSON.parse(JSON.stringify(toFhirR5Dosages(raw)))
  ];

  it.each([false, true].flatMap(repeated =>
    ["numeric", "typed", "exact"].map(kind => [repeated, kind] as const)))
    ("retains both infusion bounds for rolling supply (%s, %s)", (repeated, kind) => {
    const raw: FhirR6DosageInstruction = {
      ...(repeated ? { repeatCycle: { value: 1, unit: "d" } } : {}),
      step: [{ component: [{
        doseAndRate: [{ rateQuantity: { value: 10, unit: "mL/h", code: "mL/h", system: "http://unitsofmeasure.org" } }],
        timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day,
          timeOfDay: ["08:00:00", "20:00:00"], boundsDuration: { value: 1, unit: "d" },
          ...(kind === "typed" ? { extension: [{
            url: "urn:ezmedicationinput:StructureDefinition:timing-administration-duration",
            valueRange: { low: { value: 1, unit: "h" }, high: { value: 2, unit: "h" } }
          }] } : { duration: kind === "exact" ? 2 : 1, durationUnit: FhirPeriodUnit.Hour,
            ...(kind === "numeric" ? { durationMax: 2 } : {}) })
        } }, safety: { doseLimit: [periodLimit(30, "mL")] }
      }] }]
    };
    const before = structuredClone(raw);
    const expected = (kind === "exact" ? 20 : 30) * (repeated ? 2 : 1);
    // 10 mL/h x (2 h + 1 h) attains 30 mL. Two exact 2 h doses cannot fit.
    for (const dosage of surfaces(raw)) {
      const source = JSON.stringify(dosage);
      expect(calculateTotalUnits({ dosage, ...options, durationValue: repeated ? 2 : 1,
        durationUnit: FhirPeriodUnit.Day })).toMatchObject({ totalUnits: expected, unit: "mL" });
      expect(JSON.stringify(dosage)).toBe(source);
    }
    expect(raw).toEqual(before);
    expect(courseToR6(courseFromR6(raw)).step![0].component[0].timing?.repeat)
      .toMatchObject(raw.step![0].component[0].timing!.repeat!);
  });

  it.each(([
    ["2026-01-04T00:00:00Z", [], 2, 4, ["2026-01-04", "2026-01-05"]],
    ["2026-01-05T00:00:00Z", [], 1, 2, ["2026-01-05"]],
    ["2026-01-04T00:00:00Z", ["2026-01-03T20:00:00Z"], 2, 2, ["2026-01-05", "2026-01-06"]],
    ["2026-01-05T00:00:00Z", ["2026-01-04T09:00:00Z"], 1, 2, ["2026-01-05"]]
  ] as const).flatMap(row => ["exact", "range", "maximum"].map(quota => [quota, ...row] as const)))
    ("spends count allowances only after phase eligibility (%s, %s, %s)", (quota, from, prior, days, total, dates) => {
    const raw: FhirR6DosageInstruction = { step: [{
      start: { contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] },
        offsetDuration: { value: 3, unit: "d" } },
      component: [{
        doseAndRate: [{ doseRange: { low: { value: 1, unit: "tab" }, high: { value: 2, unit: "tab" } } }],
        timing: { repeat: { ...(quota === "exact" ? { count: 2 } :
          { countMax: 2, ...(quota === "range" ? { count: 1 } : {}) }),
          frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          timeOfDay: ["09:00:00"], boundsPeriod: { start: "2026-01-01" } } },
        safety: { doseLimit: [periodLimit(2, "tab")] }
      }]
    }] };
    const before = structuredClone(raw);
    const query = { ...options, from, priorDoseTimes: [...prior], limit: 4 };
    const fixed = structuredClone(raw);
    fixed.step![0].component[0].doseAndRate = [{ doseQuantity: { value: 2, unit: "tab" } }];
    for (const dosage of [...surfaces(raw), ...surfaces(fixed)]) {
      const source = JSON.stringify(dosage);
      expect(nextDueDoses(dosage, query)).toEqual(dates.map(date => date + "T09:00:00+00:00"));
      expect(calculateTotalUnits({ dosage, ...query, durationValue: days,
        durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(total);
      expect(JSON.stringify(dosage)).toBe(source);
    }
    expect(raw).toEqual(before);
    if (quota !== "exact") {
      const sequential = structuredClone(raw);
      sequential.step!.push({ component: [{
        doseAndRate: [{ doseQuantity: { value: 10, unit: "tab" } }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["12:00:00"] } }
      }] });
      // An upper allowance admits the same eligible doses but does not
      // establish completion, so the implicit noon successor stays closed.
      for (const dosage of surfaces(sequential)) {
        expect(nextDueDoses(dosage, query)).toEqual(dates.map(date => date + "T09:00:00+00:00"));
        expect(calculateTotalUnits({ dosage, ...query, durationValue: days,
          durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(total);
      }
    }
  });

  it.each([[undefined, false, 10], [3, false, 3], [3, true, 2]] as const)
    ("rounds repeated supply within its remaining lifetime ceiling (%s, prior %s)", (maximum, recorded, expected) => {
    const member: FhirR6Dosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { count: 1, frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] } },
      ...(maximum === undefined ? {} : { safety: { doseLimit: [{
        scope: "lifetime", valueQuantity: { value: maximum, unit: "tab" }
      }] } })
    };
    const raw: FhirR6DosageInstruction = { repeatCycle: { value: 1, unit: "d" }, step: [{ component: [member] }] };
    const scalar: FhirR6DosageInstruction = { step: [{ component: [{ ...member,
      timing: { repeat: { ...member.timing!.repeat!, count: undefined } }
    }] }] };
    const query = { ...options, ...(recorded ? { from: "2026-01-02T00:00:00Z",
      priorDoseTimes: ["2026-01-01T09:00:00Z"] } : {}),
      durationValue: 7, durationUnit: FhirPeriodUnit.Day,
      context: { containerValue: 2, containerUnit: "tab" } };
    const before = structuredClone(raw);
    const phaseRow = structuredClone(toFhirR5Dosages(scalar)[0]);
    phaseRow.modifierExtension = [...(phaseRow.modifierExtension ?? []), {
      url: "urn:ezmedicationinput:StructureDefinition:medication-parallel-component-phase-origin",
      valueQuantity: { value: 0, unit: "d", code: "d", system: "http://unitsofmeasure.org" }
    }];
    for (const dosage of [...surfaces(raw), ...surfaces(scalar), phaseRow, [phaseRow]]) {
      const source = JSON.stringify(dosage);
      expect(calculateTotalUnits({ dosage, ...query }).totalUnits).toBe(maximum === undefined ? 7 : expected);
      expect(calculateTotalUnits({ dosage, ...query, roundToMultiple: 5 })).toMatchObject({
        totalUnits: expected, unit: "tab", totalContainers: Math.ceil(expected / 2),
        totalContainerQuantity: { value: expected, unit: "tab" }
      });
      expect(JSON.stringify(dosage)).toBe(source);
    }
    expect(raw).toEqual(before);
  });
});


describe("round47 pooled calendar release windows", () => {
  const ucum = "http://unitsofmeasure.org";
  it.each([
    ["before release", 20, false, false, 1],
    ["within one day", 60, false, false, 2],
    ["across midnight", 1455, false, false, 2],
    ["fixed elapsed cap", 1455, true, false, 2],
    ["spent phase quota", 1455, false, true, 0]
  ] as const)("keeps the exact feasible maximum %s", (_name, minutes, elapsed, spent, expected) => {
    const raw: FhirR6DosageInstruction = {
      repeatCycle: { value: 2, unit: "d", code: "d", system: ucum },
      step: [{ component: [{
        id: "r47-bounded-prn", asNeeded: true,
        extension: [{ url: "urn:test:r47:source", valueString: "retain" }],
        doseAndRate: [{ doseRange: {
          low: { value: 1, unit: "tab" }, high: { value: 2, unit: "tab" }
        } }],
        timing: { repeat: { countMax: 1,
          boundsDuration: { value: 2, unit: "d", code: "d", system: ucum },
          extension: [{ url: TIMING_OCCURRENCE_CAP_EXTENSION_URL, extension: [
            { url: "max", valueInteger: 1 },
            { url: "period", valueQuantity: { value: 1, unit: "d", code: "d", system: ucum } }
          ] }]
        } },
        safety: { doseLimit: [{ scope: "period", valueQuantity: { value: 3, unit: "tab" },
          period: { value: elapsed ? 30 : 1, unit: elapsed ? "d" : "mo",
            code: elapsed ? "d" : "mo", system: ucum } }] }
      }] }]
    };
    const query = { from: spent ? "2026-03-30T08:00:00Z" : "2026-03-30T07:00:00Z",
      orderedAt: "2026-03-30T07:00:00Z", timeZone: "UTC",
      priorDoseTimes: [spent ? "2026-03-30T07:15:00Z" : "2026-02-28T07:30:00Z"] };
    // At March30 07:30 the old two-tablet record leaves the monthly
    // window. A single two-tablet use then fits and attains the phase's
    // one-use maximum. Extending the horizon past midnight cannot erase it.
    const rows = toFhirR5Dosages(raw);
    for (const dosage of [raw, rows, JSON.parse(JSON.stringify(rows)) as FhirDosage[]]) {
      const before = JSON.stringify(dosage);
      expect(calculateTotalUnits({ dosage, ...query, durationValue: minutes, durationUnit: FhirPeriodUnit.Minute }))
        .toMatchObject({ totalUnits: expected, unit: "tab" });
      expect(nextDueDoses(dosage, { ...query, limit: 2 })).toEqual([]);
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });
});


describe("round50 upper-only periods with native offsets", () => {
  it.each([false, true])("retains an exact timing code only for an exact matching period (%s)", exact => {
    const wire: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { ...(exact ? { period: 6 } : { periodMax: 6 }),
        periodUnit: FhirPeriodUnit.Hour, startOffset: { value: 1, unit: "h" } },
        code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "Q6H" }] } }
    }] }] };
    const original = JSON.stringify(wire), cold = JSON.parse(JSON.stringify(toFhirR5Dosages(wire)));
    for (const input of [wire, cold, toDosageDetails(cold)]) {
      const before = JSON.stringify(input);
      for (const realizationMode of ["normalized", "roundtrip"] as const) for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { locale, realizationMode });
        const cadence = locale === "en" ? "every 6 hours" : "ทุก 6 ชั่วโมง";
        if (exact) expect(text).toContain(cadence);
        else {
          expect(text).not.toContain(cadence);
          expect(text).toContain(locale === "en" ? "up to 6 hours" : "ไม่เกิน 6 ชั่วโมง");
        }
        expect(text).toContain(locale === "en" ? "1 hour after" : "หลังเริ่มรอบ 1 ชั่วโมง");
      }
      expect(JSON.stringify(input)).toBe(before);
    }
    const reopened = toDosageDetails(cold).step![0].component[0].timing!;
    expect(reopened.code!.coding![0].code).toBe("Q6H");
    expect(reopened.repeat!.period).toBe(exact ? 6 : undefined);
    expect(reopened.repeat!.periodMax).toBe(exact ? undefined : 6);
    expect(JSON.stringify(wire)).toBe(original);
  });
});


describe("round51 relative phase cutoffs and route-only source", () => {
  const context = { orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-01T00:00:00Z", timeZone: "UTC" };
  const right = "Instill 1 drop OD daily at 08:00 for 7 days, then instill 2 drops OD daily at 08:00 for 2 days, then instill 3 drops OD daily at 08:00";
  it.each([
    right + " from 2026-12-10; instill 1 drop OS BID",
    "Instill 1 drop OS BID; " + right + " from 2026-12-10",
    right + "; instill 1 drop OS BID"
  ])("keeps each relative phase on its own days beside a dated cutoff: %s", text => {
    const parsed = parseSig(text, { datePolicy: { referenceDate: "2026-12-01" } });
    for (const dosage of [parsed, parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext,
        JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)))]) {
      const before = JSON.stringify(dosage);
      const course = inputToCanonical(dosage);
      const members: Array<{ stage: CanonicalCourse["stages"][number]; member: CanonicalAdministration }> = [];
      for (const stage of course.stages) for (const member of stage.administrations) members.push({ stage, member });
      const rightEye = members.filter(({ member }) => member.target?.coding?.some(code => code.code === "1290032005"));
      const leftEye = members.filter(({ member }) => member.target?.coding?.some(code => code.code === "1290031003"));
      expect(rightEye.map(({ member }) => ({
        value: member.amounts?.[0].quantity?.value, unit: member.amounts?.[0].quantity?.unit,
        clocks: member.schedule?.recurrence?.clocks,
      }))).toEqual([
        { value: 1, unit: "drop", clocks: ["08:00:00"] },
        { value: 2, unit: "drop", clocks: ["08:00:00"] },
        { value: 3, unit: "drop", clocks: ["08:00:00"] },
      ]);
      // The first phase can retain an explicit zero origin or use the course's implicit start.
      expect(rightEye[0].member.phaseOrigin?.value ?? 0).toBe(0);
      if (rightEye[0].member.phaseStart) expect(rightEye[0].member.phaseStart)
        .toMatchObject({ anchor: "treatment-start", displacement: { value: 0, unit: "d" } });
      expect(rightEye[0].stage.start).toBeUndefined();
      expect(rightEye[0].member.schedule?.recurrence?.calendarWindow?.start).toBeUndefined();
      expect(rightEye[0].member.phaseEnd ?? rightEye[0].stage.end)
        .toMatchObject({ anchor: "treatment-start", displacement: { value: 7, unit: "d" } });
      const second = rightEye[1].member;
      if (second.phaseStart) expect(second.phaseStart).toMatchObject({ anchor: "treatment-start" });
      expect(second.phaseOrigin ?? second.phaseStart?.displacement).toMatchObject({ value: 7, unit: "d" });
      if (text.includes("from 2026-12-10")) {
        // The public day and timestamp assertions below verify the cutoff.
        const length = second.schedule?.recurrence?.courseLength;
        expect(length?.value).toBe(2);
        expect(length?.code ?? length?.unit).toBe("d");
        expect(rightEye[2].member.schedule?.recurrence?.calendarWindow?.start).toBe("2026-12-10");
      } else {
        expect(rightEye[1].stage.start).toMatchObject({ anchor: "treatment-start", displacement: { value: 7, unit: "d" } });
        expect(rightEye[1].stage.end).toMatchObject({ anchor: "treatment-start", displacement: { value: 9, unit: "d" } });
        expect(rightEye[2].member.phaseOrigin).toMatchObject({ value: 9, unit: "d" });
      }
      expect(leftEye).toHaveLength(course.stages.length);
      for (const { member } of leftEye) {
        expect(member.amounts?.[0].quantity).toMatchObject({ value: 1, unit: "drop" });
        expect(member.schedule?.recurrence).toMatchObject({ frequency: 2, period: 1, periodUnit: "d" });
        expect(member.phaseStart).toBeUndefined();
        expect(member.phaseEnd).toBeUndefined();
        expect(member.schedule?.recurrence?.calendarWindow).toBeUndefined();
      }
      expect(calculateTotalUnits({ ...context, dosage, durationValue: 12, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(44);
      // The same total can hide two early 2-drop doses and an omitted middle phase.
      for (const [day, expected] of [[1, 3], [7, 3], [8, 4], [9, 4], [10, 5]] as const) {
        const from = "2026-12-" + (day < 10 ? "0" : "") + day + "T00:00:00Z";
        expect(calculateTotalUnits({ ...context, from, dosage,
          durationValue: 1, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(expected);
      }
      // Both eyes have an independent administration at 08:00.
      expect(nextDueDoses(dosage, { ...context, from: "2026-12-08T00:00:00Z", limit: 6 })).toEqual([
        "2026-12-08T08:00:00+00:00", "2026-12-08T08:00:00+00:00", "2026-12-08T20:00:00+00:00",
        "2026-12-09T08:00:00+00:00", "2026-12-09T08:00:00+00:00", "2026-12-09T20:00:00+00:00"
      ]);
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });

  it.each(["en", "th"])("retains the only dose, manner and cadence beside an imported route: %s", locale => {
    const text = "Swallow 1 tablet whole every morning";
    const route = parseSig("Take 1 tablet PO").fhir[0].route!;
    const raw: FhirR6DosageInstruction = {
      renderedInstruction: text, step: [{ component: [{ text, route }] }]
    };
    const plainR5: FhirDosage[] = [{ text, route }];
    for (const input of [raw, toFhirR5Dosages(raw), plainR5, toDosageDetails(plainR5)]) {
      const before = JSON.stringify(input);
      for (const realizationMode of ["normalized", "roundtrip"] as const)
        expect(formatSig(input, "long", { locale, realizationMode })).toContain(text);
      expect(JSON.stringify(input)).toBe(before);
    }
    const edited: FhirR6DosageInstruction = { step: [{ component: [{
      text, route, doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }]
    }] }] };
    for (const input of [edited, toFhirR5Dosages(edited)]) {
      const rendered = formatSig(input, "long", { locale, realizationMode: "normalized" });
      expect(rendered).toMatch(locale === "en" ? /2 tablets/u : /2 เม็ด/u);
      const label = locale === "en" ? "; original directions: " : "; ข้อความเดิม: ";
      expect(rendered.split(label)[0]).not.toContain(text);
      expect(rendered).toContain(label + text);
    }
    const timingOnly: FhirR6DosageInstruction = { step: [{ component: [{
      text, timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day } }
    }] }] };
    const rendered = formatSig(timingOnly, "long", { locale, realizationMode: "normalized" });
    expect(rendered).toContain(text);
    expect(rendered).toContain(locale === "en" ? "Current:" : "ปัจจุบัน:");
    expect(rendered).toContain(locale === "en" ? "twice daily" : "วันละ 2 ครั้ง");
  });
});


describe("round58 direct activity projection", () => {
  it.each([false, true])("omits absent marker properties and retains supplied coding/translation=%s", annotated => {
    const activity = { text: "exercise", ...(annotated ? {
      coding: { system: "urn:r58:activity", code: "exercise", display: "Exercise" },
      i18n: { th: "ออกกำลังกาย" } } : {}) };
    const administration = administrationFromClause({ dose: { value: 1, unit: "tab" },
      schedule: { activityTiming: [{ relation: "before", activity, offset: 30 }] } });
    const course = courseFromAdministrations([administration], "");
    const projected = projectCanonicalCourse(course, annotated ? { locale: "en" } : undefined);
    const marker = projected.fhir[0].timing?.repeat?.extension
      ?.find(extension => extension.url.endsWith("medication-timing-activity-window"))
      ?.extension?.find(extension => extension.url === "activity")?.valueCodeableConcept;
    expect(marker?.text).toBe("exercise");
    if (annotated) {
      expect(marker?.coding).toEqual([{ system: "urn:r58:activity", code: "exercise", display: "Exercise" }]);
      expect(JSON.stringify(marker?._text)).toContain("ออกกำลังกาย");
    } else {
      expect(marker).not.toHaveProperty("coding");
      expect(marker).not.toHaveProperty("_text");
    }
    expect(JSON.parse(JSON.stringify(projected.fhir[0]))).toEqual(projected.fhir[0]);
  });
});


describe("round64 independent endpoint and authored direction ownership", () => {
  const options = { locale: "en", realizationMode: "normalized" as const };
  const absent = { extension: [{ url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown" }] };

  it.each(["low", "high"] as const)("does not borrow a unit from a metadata-only %s endpoint", missing => {
    const range = missing === "low"
      ? { low: { unit: "mg", _value: absent }, high: { value: 500 } }
      : { low: { value: 500 }, high: { unit: "mg", _value: absent } };
    const raw: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: [{ doseRange: range }] }] }] };
    const rows = JSON.parse(JSON.stringify(toFhirR5Dosages(raw))) as FhirDosage[];
    for (const input of [raw, rows]) {
      const text = formatSig(input, "long", options);
      expect(text).toContain("500");
      expect(text).not.toContain("mg");
      expect((Array.isArray(input) ? toDosageDetails(input) : courseToR6(courseFromR6(input))).step[0].component[0].doseAndRate![0].doseRange).toEqual(range);
    }
    const valued = missing === "low" ? { ...range, high: { value: 500, unit: "mg" } }
      : { ...range, low: { value: 500, unit: "mg" } };
    expect(formatSig({ step: [{ component: [{ doseAndRate: [{ doseRange: valued }] }] }] }, "long", options)).toContain("500 mg");
  });

  it.each(["rateRange", "rateQuantity", "rateRatio"] as const)("keeps authored directions beside a metadata-only %s", field => {
    const metadata = { id: "unknown-rate", extension: absent.extension };
    const raw: FhirR6DosageInstruction = { step: [{ component: [{ text: "Infuse over 30 minutes", doseAndRate: [{ [field]: metadata }] }] }] };
    for (const input of [raw, JSON.parse(JSON.stringify(toFhirR5Dosages(raw))) as FhirDosage[]]) {
      expect(formatSig(input, "long", options)).toContain("Infuse over 30 minutes");
      expect((Array.isArray(input) ? toDosageDetails(input) : courseToR6(courseFromR6(input))).step[0].component[0].doseAndRate![0][field]).toEqual(metadata);
    }
    const rate = field === "rateQuantity" ? { value: 5, unit: "mL/h" }
      : field === "rateRatio" ? { numerator: { value: 5, unit: "mL" }, denominator: { value: 1, unit: "h" } }
      : { low: { value: 5, unit: "mL/h" }, high: { value: 10, unit: "mL/h" } };
    const valued: FhirR6DosageInstruction = { step: [{ component: [{ text: "Infuse over 30 minutes", doseAndRate: [{ [field]: rate }] }] }] };
    const text = formatSig(valued, "long", options);
    const completeRate = field === "rateQuantity" ? /(?:^|[^\d.])5 mL\/h\b/u
      : field === "rateRatio" ? /(?:^|[^\d.])5 mL \/ 1 h\b/u
      : /(?:^|[^\d.])5–10 mL\/h\b/u;
    expect(text).toMatch(completeRate);
    expect(text).toContain("Infuse over 30 minutes");
    const saved = toDosageDetails(JSON.parse(JSON.stringify(toFhirR5Dosages(valued))));
    expect(saved.step![0].component[0].text).toBe("Infuse over 30 minutes");
    const replaced: FhirR6DosageInstruction = { step: [{ component: [{
      ...valued.step![0].component[0], timing: { repeat: { duration: 60, durationUnit: FhirPeriodUnit.Minute } },
    }] }] };
    const current = formatSig(replaced, "long", options);
    expect(current).toMatch(completeRate);
    expect(current).toContain("over 60 minutes");
    expect(toDosageDetails(JSON.parse(JSON.stringify(toFhirR5Dosages(replaced))))
      .step![0].component[0].timing!.repeat!.duration).toBe(60);
  });

  it.each(["en", "th"] as const)("keeps source-only infusion directions in complete native defaults: %s", locale => {
    const text = "Infuse through a central line";
    const note = { url: "https://example.test/infusion-note", valueString: "Keep the authored route" };
    const row = { text, extension: [note], doseAndRate: [{ rateRatio: {
      numerator: { value: 100, unit: "mL" }, denominator: { value: 2, unit: "h" }
    } }] };
    const native: FhirR6DosageInstruction = { step: [{ component: [row] }] };
    for (const input of [row, native]) for (const realizationMode of ["normalized", "roundtrip"] as const) {
      const before = JSON.stringify(input);
      const plain = formatSig(input, "long", { locale, realizationMode });
      expect(plain).toContain(text);
      expect(plain).toContain("100 mL / 2 h");
      let calls = 0;
      expect(formatSig(input, "long", { locale, realizationMode, i18n: {
        formatLong: context => {
          calls++;
          expect(context.defaultText).toBe(plain);
          expect(context.formatDefault("long")).toBe(plain);
          return "Infusion clinic wording.";
        }
      } })).toBe("Infusion clinic wording.");
      expect(calls).toBe(1);
      expect(JSON.stringify(input)).toBe(before);
    }
    const saved = toDosageDetails(toFhirR5Dosages(native)).step![0].component[0];
    expect(saved.text).toBe(text);
    expect(saved.extension).toContainEqual(note);
  });

  it("supplies only a primitive companion for a missing R5 period minimum", () => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{ timing: { repeat: {
      frequency: 2, periodMax: 3, periodUnit: FhirPeriodUnit.Day
    } } }] }] };
    const repeat = toFhirR5Dosages(raw)[0].timing!.repeat!;
    expect(repeat.period).toBeUndefined();
    expect(repeat.periodMax).toBe(3);
    expect(repeat._period).toEqual(absent);
    const companion = { id: "authored-period", extension: [{ url: "urn:example:period-note", valueString: "minimum unknown" }] };
    const withMetadata: FhirR6DosageInstruction = { step: [{ component: [{ timing: { repeat: {
      ...raw.step[0].component[0].timing!.repeat!, _period: companion
    } } }] }] };
    expect(toFhirR5Dosages(withMetadata)[0].timing!.repeat!._period).toEqual(companion);
    const exact: FhirR6DosageInstruction = { step: [{ component: [{ timing: { repeat: {
      frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day
    } } }] }] };
    expect(toFhirR5Dosages(exact)[0].timing!.repeat!._period).toBeUndefined();
  });
});


describe("round66 source meaning and authored metadata", () => {
  const options = { locale: "en", realizationMode: "normalized" as const };
  const tabletDaily = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
    timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } } };

  it.each([undefined, "2026"])("retains an authored Thai instruction translation with coding version %s", version => {
    const instruction = { coding: [{ system: "urn:test:counseling", code: "do-not-crush", version }],
      _text: { id: "authored-counseling", extension: [{ url: "http://hl7.org/fhir/StructureDefinition/translation",
        extension: [{ url: "lang", valueCode: "th" }, { url: "content", valueString: "ห้ามบดเม็ดยา" }] }] } };
    const source: FhirR6DosageInstruction = { step: [{ component: [{ ...tabletDaily,
      additionalInstruction: [instruction] }] }] };
    for (const [label, input] of [["R6", source], ["native", courseFromR6(source, true)],
      ["R5", JSON.parse(JSON.stringify(toFhirR5Dosages(source)))]] as const)
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }), label).toContain("ห้ามบดเม็ดยา");
    expect(toDosageDetails(JSON.parse(JSON.stringify(toFhirR5Dosages(source)))).step[0].component[0].additionalInstruction)
      .toEqual(JSON.parse(JSON.stringify([instruction])));
  });

  it("attaches excluded dates and weekdays before the independent limit response", () => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{ ...tabletDaily,
      safety: { doseLimit: [{ scope: "period", valueQuantity: { value: 4, unit: "tab" },
        period: { value: 1, unit: "d" } }], ifExceeded: "Call the clinic" } }] }] };
    const native = JSON.parse(JSON.stringify(courseFromR6(source))) as CanonicalCourse;
    native.stages[0].administrations[0].excludedDates = ["2026-12-25"];
    native.stages[0].administrations[0].excludedWeekdays = [FhirDayOfWeek.Sunday];
    const r6 = courseToR6(native);
    for (const input of [native, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      const text = formatSig(input, "long", options);
      expect(text).toContain("except 2026-12-25");
      expect(text).toContain("except Sunday");
      expect(text.indexOf("except 2026-12-25")).toBeLessThan(text.indexOf("If the limit is exceeded: Call the clinic"));
      expect(text.indexOf("except Sunday")).toBeLessThan(text.indexOf("If the limit is exceeded: Call the clinic"));
    }
    expect(formatSig(source, "long", options)).toContain("If the limit is exceeded: Call the clinic");
  });

  it("keeps the unresolved predecessor warning after removing the first saved step", () => {
    const native: CanonicalCourse = { kind: "course", stages: [
      { administrations: [{ kind: "administration", amounts: [{ quantity: { value: 1, unit: "tab" } }] }] },
      { start: { anchor: "previous-phase-next-day" }, administrations: [{ kind: "administration", amounts: [{ quantity: { value: 2, unit: "tab" } }] }] },
      { administrations: [{ kind: "administration", amounts: [{ quantity: { value: 3, unit: "tab" } }] }] },
    ] };
    const saved = courseToR6(native);
    const edited = { ...saved, step: saved.step.slice(1) };
    for (const input of [edited, JSON.parse(JSON.stringify(toFhirR5Dosages(edited)))])
      expect(formatSig(input, "long", options)).toContain("Timing requires review");
    expect(formatSig(saved, "long", options)).not.toContain("Timing requires review");
  });

  it("retains a fresh Ratio annotation Coding.version without changing its limit", () => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{ ...tabletDaily,
      safety: { doseLimit: [{ scope: "period", valueQuantity: { value: 4, unit: "tab" },
        period: { value: 1, unit: "d" }, extension: [{ url: "urn:test:limit-annotation",
          valueCodeableConcept: { coding: [{ system: "urn:test:limit", code: "daily" }] } }] }] } }] }] };
    const rows = JSON.parse(JSON.stringify(toFhirR5Dosages(source))) as FhirDosage[];
    rows[0].maxDosePerPeriod![0].extension![0].valueCodeableConcept!.coding![0].version = "2026";
    const limit = toDosageDetails(rows).step[0].component[0].safety!.doseLimit![0];
    expect(limit).toMatchObject({ scope: "period", valueQuantity: { value: 4, unit: "tab" },
      period: { value: 1, unit: "d" }, extension: [{ url: "urn:test:limit-annotation",
        valueCodeableConcept: { coding: [{ system: "urn:test:limit", code: "daily", version: "2026" }] } }] });
  });

  it.each(["2026", "2026-12"])("shows reduced-precision R5 events without choosing a day: %s", event => {
    const row: FhirDosage = { doseAndRate: tabletDaily.doseAndRate,
      timing: { event: [event], _event: [{ id: "authored-precision" }] } };
    for (const text of [formatSig(row, "long", options), fromFhirDosage(row, options).longText]) {
      const completeToken = new RegExp("Scheduled events: " + event + "(?![\\d-])", "u");
      expect(text).toMatch(completeToken);
      expect("Scheduled events: " + (event === "2026" ? "2026-12" : "2026-12-25")).not.toMatch(completeToken);
    }
    expect(toDosageDetails([row]).step[0].component[0].timing)
      .toMatchObject({ event: [event], _event: [{ id: "authored-precision" }] });
  });
});


describe("round68 numeric member safety qualification", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const quantity = (value: number, unit: string) => ({ value, unit, code: unit, system: "http://unitsofmeasure.org" });
  const query = { orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-01T00:00:00Z",
    timeZone: "UTC", durationValue: 2, durationUnit: FhirPeriodUnit.Day, patientWeightKg: 70 };
  const liquidCourse = (): FhirR6DosageInstruction => ({ step: [
    { component: [{ id: "liquid-phase", doseAndRate: [{ doseQuantity: quantity(5, "mL") }],
      timing: { repeat: { count: 3, frequency: 3, period: 1, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["08:00:00", "14:00:00", "20:00:00"] } },
      safety: { id: "safety-source", doseLimit: [{ id: "daily-cap", scope: "period",
        valueQuantity: quantity(3, "mg/kg"), period: quantity(1, "d"), text: "daily limit" }] },
      extension: [{ url: "https://example.org/liquid-note", valueString: "retain source" }],
    }] },
    { component: [{ doseAndRate: [{ doseQuantity: quantity(1, "mL") }],
      timing: { repeat: { count: 1, timeOfDay: ["09:00:00"] } },
    }] },
  ] });
  const views = (source: FhirR6DosageInstruction) => {
    const r5 = fresh(toFhirR5Dosages(fresh(source)));
    const native = courseFromR6(fresh(source)), r6 = courseToR6(fresh(native));
    return [r5, native, r6, fresh(toFhirR5Dosages(fresh(r6)))];
  };
  const savedRows = (dosage: ReturnType<typeof views>[number]) => {
    const wire = !Array.isArray(dosage) && "stages" in dosage
      ? courseToR6(fresh(dosage)) : fresh(dosage);
    return fresh(toFhirR5Dosages(wire));
  };

  it.each([
    { strength: "20 mg/mL" },
    { strengthRatio: { numerator: quantity(20, "mg"), denominator: quantity(1, "mL") } },
  ])("keeps numeric maximum accounting without an unevaluated-safety warning (%j)", context => {
    const source = liquidCourse(), before = fresh(source);
    for (const dosage of views(source)) {
      const original = fresh(dosage);
      expect(calculateTotalUnits({ dosage, ...query, context }))
        .toMatchObject({ totalUnits: 16, unit: "mL", quantityKind: "maximum" });
      expect(calculateTotalUnits({ dosage: fresh(dosage), ...query, durationValue: 1, context }))
        .toMatchObject({ totalUnits: 10, unit: "mL", quantityKind: "maximum" });
      expect(calculateTotalUnits({ dosage: fresh(dosage), ...query, from: "2026-12-02T00:00:00Z",
        durationValue: 1, context }))
        .toMatchObject({ totalUnits: 6, unit: "mL", quantityKind: "maximum" });
      expect(calculateTotalUnits({ dosage, ...query, context }).explanation).not.toContain("not evaluated");
      const saved = toDosageDetails(savedRows(dosage)).step[0].component[0];
      expect(saved.safety).toEqual(source.step[0].component[0].safety);
      expect(saved.extension).toContainEqual(source.step[0].component[0].extension![0]);
      expect(dosage).toEqual(original);
    }
    expect(source).toEqual(before);
  });

  it.each(["wrapper extension", "limit extension", "response", "expression", "count", "dosage scope"] as const)(
    "retains the unevaluated safety qualification and metadata for %s", variant => {
      const source = liquidCourse(), safety = source.step[0].component[0].safety!;
      if (variant === "wrapper extension") safety.extension = [
        { url: "https://example.org/safety-rule", valueString: "retained rule" },
      ];
      else if (variant === "limit extension") safety.doseLimit![0].extension = [
        { url: "https://example.org/limit-rule", valueString: "retained rule" },
      ];
      else if (variant === "response") safety.ifExceeded = "Call the clinic";
      else safety.doseLimit!.push(variant === "expression"
        ? { scope: "administration", valueExpression: { language: "text/fhirpath", expression: "%patient.weight * 2" } }
        : variant === "count" ? { scope: "administration", valueInteger: 2 }
        : { scope: "dosage", valueQuantity: quantity(20, "mL") });
      const before = fresh(source);
      for (const dosage of views(source)) {
        const original = fresh(dosage);
        const result = calculateTotalUnits({ dosage, ...query, context: { strength: "20 mg/mL" } });
        expect(result).toMatchObject({ totalUnits: 16, unit: "mL", quantityKind: "maximum" });
        expect(result.explanation).toContain("safety");
        expect(result.explanation?.match(/R6 safety details/gu)).toHaveLength(1);
        expect(toDosageDetails(savedRows(dosage)).step[0].component[0].safety)
          .toEqual(safety);
        expect(dosage).toEqual(original);
      }
      expect(source).toEqual(before);
    });
  it("explains a freshly cleared numeric maximum once without applying its stale value", () => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: quantity(1, "tab") }],
      timing: { repeat: { frequency: 3, period: 1, periodUnit: FhirPeriodUnit.Day } },
      safety: { doseLimit: [{ scope: "period", valueQuantity: quantity(2, "tab"), period: quantity(1, "d") }] }
    }] }] };
    const limit = source.step[0].component[0].safety!.doseLimit![0];
    delete limit.valueQuantity!.value;
    limit.valueQuantity!._value = { extension: [{
      url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown"
    }] };
    for (const dosage of views(source)) {
      const original = fresh(dosage);
      const result = calculateTotalUnits({ dosage, ...query });
      expect(result).toMatchObject({ totalUnits: 6, unit: "tab", quantityKind: "maximum" });
      expect(result.explanation).toContain("unevaluable maximum-dose constraint");
      expect(result.explanation?.match(/R6 safety details/gu)).toHaveLength(1);
      expect(toDosageDetails(savedRows(dosage)).step[0].component[0].safety)
        .toEqual(source.step[0].component[0].safety);
      expect(dosage).toEqual(original);
    }
  });

});

describe("round74 current instruction identity", () => {
  it("keeps each coded instruction's source annotations after a typed composition reorders them", () => {
    const native = cloneStructuredValue(parseSig("Take 1 tablet daily").meta.canonical.course!);
    const administration = native.stages[0].administrations[0];
    const original = ["A", "B", "C"].map(code => ({
      coding: { system: "urn:clinic:instructions", code, display: code }, i18n: { th: "คำแนะนำ " + code },
    }));
    administration.syntax!.additionalInstructions = original;
    administration.additionalInstructions = [original[2], original[0], original[1]].map(item => ({ coding: [item.coding] }));
    const before = cloneStructuredValue(native), clause = clauseForAdministration(administration);
    expect(clause.additionalInstructions).toEqual([original[2], original[0], original[1]]);
    expect(native).toEqual(before);
  });
});


describe("round76 bound source wording agreement", () => {
  const fresh = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
  const marker = "urn:ezmedicationinput:StructureDefinition:medication-rendered-instruction";
  const graph = "urn:ezmedicationinput:StructureDefinition:medication-instruction-graph";
  const options = { locale: "en", realizationMode: "normalized" as const };

  it("keeps a later generated procedure localized through independent saves without changing its text", () => {
    const dose = parseSig("Take 1 tablet daily").fhirNext.step![0].component[0];
    const procedure = parseSig("Rotate sites after every injection").fhirNext.step![0].component[0];
    let current: FhirR6DosageInstruction = { step: [{ component: [fresh(dose), fresh(procedure)] }] };
    for (let save = 0; save < 3; save++) {
      const before = fresh(current);
      const english = formatSig(current, "long", options);
      expect(english).toContain("Rotate sites after each injection");
      expect(english.match(/Rotate sites/gu)).toHaveLength(1);
      expect(english).not.toContain("original directions");
      const thai = formatSig(current, "long", { locale: "th", realizationMode: "normalized" });
      expect(thai).toContain("สลับตำแหน่งหลังการฉีดยาแต่ละครั้ง");
      expect(thai.match(/สลับตำแหน่ง/gu)).toHaveLength(1);
      expect(thai).not.toMatch(/Rotate|injection|original directions/u);
      expect(current.step![0].component[1].text).toBe("Rotate sites after each injection.");
      const rows = fresh(toFhirR5Dosages(current));
      expect(rows[1].text).toBe("Rotate sites after each injection.");
      expect(current).toEqual(before);
      current = fresh(toDosageDetails(rows));
    }
  });

  it.each(["unmarked", "replacement"] as const)("keeps %s independent dose text unowned after repeated saves", kind => {
    let current = fresh(parseSig("Do not crush").fhirNext);
    current.renderedInstruction = "Swallow 1 tablet whole";
    const component = current.step![0].component[0];
    component.text = current.renderedInstruction;
    if (kind === "unmarked") component.extension = component.extension!.filter(item => item.url !== marker);
    const note = { url: "urn:clinic:source-note", valueString: "Keep the authored dose directions" };
    component.extension!.push(note);
    for (let save = 0; save < 3; save++) {
      const before = fresh(current);
      const text = formatSig(current, "long", options);
      expect(text).toContain("Swallow 1 tablet whole");
      expect(text).toContain("Do not crush");
      expect(courseFromR6(current).stages[0].administrations[0].provenance?.sourceTextAgreed).not.toBe(true);
      expect(current).toEqual(before);
      current = fresh(toDosageDetails(fresh(toFhirR5Dosages(current))));
      expect(current.step![0].component[0].text).toBe("Swallow 1 tablet whole");
      expect(current.step![0].component[0].extension).toContainEqual(note);
    }
  });

  it("lets a current graph edit replace old generated wording without validating old replay on save", () => {
    let current = fresh(parseSig("Rotate sites after every injection").fhirNext);
    delete current.renderedInstruction;
    const replacement = parseSig("Rotate sites after each dose").fhirNext.step![0].component[0].extension!
      .find(item => item.url === graph)!;
    current.step![0].component[0].extension = current.step![0].component[0].extension!.map(item =>
      item.url === graph ? fresh(replacement) : item);
    for (let save = 0; save < 3; save++) {
      const before = fresh(current);
      expect(dosageMatchesSavedProjection(current.step![0].component[0])).toBe(false);
      for (const realizationMode of ["normalized", "roundtrip"] as const)
        expect(formatSig(current, "long", { locale: "en", realizationMode })).toBe("Rotate sites after each dose.");
      expect(current).toEqual(before);
      current = fresh(toDosageDetails(fresh(toFhirR5Dosages(current))));
    }
  });

  it.each([false, true])("preserves source-only wording under its current or legacy saved agreement (legacy=%s)", legacy => {
    const original: FhirDosage = { text: "Swallow 1 tablet whole", timing: {
      repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day },
    } };
    const source = fresh(original);
    // Exact unmarked first save from the previously validated public build.
    const oldRows: FhirDosage[] = JSON.parse("[{\"text\":\"Swallow 1 tablet whole\",\"timing\":{\"repeat\":{\"frequency\":1,\"period\":1,\"periodUnit\":\"d\"}},\"sequence\":1,\"extension\":[{\"url\":\"urn:ezmedicationinput:StructureDefinition:medication-rendered-instruction\",\"extension\":[{\"url\":\"instruction\",\"valueString\":\"Swallow 1 tablet whole\"},{\"url\":\"row\",\"extension\":[{\"url\":\"projectionFingerprint\",\"valueString\":\"clinical-v2:45821bc262703c09\"},{\"url\":\"textFingerprint\",\"valueString\":\"2dcd50ba8eb8a909\"}]}]}]}]");
    let rows = legacy ? oldRows : fresh(toFhirR5Dosages(toDosageDetails([source])));
    const warning = parseSig("Do not crush").fhir[0].extension!.find(item => item.url === graph)!;
    rows[0].extension = [...(rows[0].extension ?? []), fresh(warning)];
    for (let save = 0; save < 3; save++) {
      const text = formatSig(rows, "long", options);
      expect(text).toContain("Do not crush");
      const native = toDosageDetails(rows);
      if (legacy) {
        // An implicit historical baseline cannot distinguish this artifact's
        // origin from parser output. Its established clinical-edit contract
        // retires the old wording while preserving the exact source.
        expect(text).not.toContain("Swallow 1 tablet whole");
        expect(native.step![0].component[0].text).toBeUndefined();
        expect(JSON.stringify(native.extension)).toContain(JSON.stringify(original.text));
      } else {
        expect(text.match(/Swallow 1 tablet whole/gu)).toHaveLength(1);
        expect(native.step![0].component[0].text).toBe(original.text);
      }
      rows = fresh(toFhirR5Dosages(native));
    }
    expect(source).toEqual(original);
  });

  it("retires annotated old agreement while preserving its metadata on a text replacement", () => {
    let current = fresh(parseSig("Do not crush").fhirNext);
    const component = current.step![0].component[0];
    const baseline = component.extension!.find(item => item.url === marker)!;
    baseline.id = "authored-baseline-note";
    baseline.extension!.find(item => item.url === "textFingerprint")!.id = "authored-text-note";
    component.text = "Swallow 1 tablet whole";
    for (let save = 0; save < 3; save++) {
      const before = fresh(current);
      current = fresh(courseToR6(courseFromR6(current)));
      expect(before.step![0].component[0].text).toBe("Swallow 1 tablet whole");
      const active = current.step![0].component[0].extension!.filter(item => item.url === marker);
      expect(active).toHaveLength(1);
      expect(active[0].extension).toContainEqual({ url: "sourceAgreement", valueBoolean: false });
      expect(JSON.stringify(current)).toContain("authored-baseline-note");
      expect(JSON.stringify(current)).toContain("authored-text-note");
      const text = formatSig(current, "long", options);
      expect(text).toContain("Swallow 1 tablet whole");
      expect(text).toContain("Do not crush");
    }
  });

  it("does not use component agreement to suppress a different authored course header", () => {
    const current = fresh(parseSig("Do not crush").fhirNext);
    current.renderedInstruction = "Swallow 1 tablet whole";
    const text = formatSig(current, "long", options);
    expect(text).toContain("Swallow 1 tablet whole");
    expect(text).toContain("Do not crush");
  });
});


describe("round78 current clinical facts and retained directions", () => {
  const fresh = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
  const options = { locale: "en", realizationMode: "normalized" as const };
  const dose = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] };

  it("keeps the authored amount beside a ratio with only a measured denominator", () => {
    const header = "Infuse 25 mL per hour";
    const raw: FhirR6DosageInstruction = { renderedInstruction: header, step: [{ component: [{
      doseAndRate: [{ rateRatio: { numerator: { id: "unvalued-dose", _value: { extension: [{
        url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown",
      }] } }, denominator: { value: 1, unit: "h" } } }],
    }] }] };
    for (const input of [raw, fresh(toFhirR5Dosages(raw)), fresh(toDosageDetails(fresh(toFhirR5Dosages(raw))))]) {
      expect(formatSig(input, "long", options)).toContain(header);
      const native = importCanonicalCourse(input);
      const ratio = native.stages[0].administrations[0].amounts![0].rateRatio!;
      expect(ratio.numerator!.value).toBeUndefined();
      expect(ratio.numerator!.id).toBe("unvalued-dose");
      expect(ratio.denominator).toEqual({ value: 1, unit: "h" });
    }
  });

  it.each(["literal", "month-day"] as const)("renders rate-only %s timing in both styles", kind => {
    const timing = kind === "literal" ? { code: { coding: [{ system: "urn:clinic:timing", code: "dialysis", display: "after dialysis" }] } }
      : { repeat: { extension: [{ url: TIMING_DAY_OF_MONTH_EXTENSION_URL, valuePositiveInt: 15 }] } };
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ rateQuantity: { value: 5, unit: "mL/h" } }], timing,
    }] }] };
    for (const input of [raw, fresh(toFhirR5Dosages(raw)), fresh(toDosageDetails(fresh(toFhirR5Dosages(raw))))]) {
      for (const style of ["long", "short"] as const) {
        const text = formatSig(input, style, options);
        expect(text).toContain("5 mL/h");
        expect(text).toContain(kind === "literal" ? "after dialysis" : "15");
      }
    }
  });

  it.each(["coding", "text", "foreign"] as const)("keeps edited hourly cadence authoritative over %s timing", kind => {
    const code = kind === "text" ? { text: "Q30MIN" } : { coding: [{ code: "Q30MIN",
      ...(kind === "foreign" ? { system: "urn:clinic:timing" } : {}) }] };
    const row: FhirDosage = { ...dose, timing: { code, repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Hour } } };
    const wire = toDosageDetails([fresh(row)]);
    for (const input of [[row], wire, fresh(toFhirR5Dosages(wire))]) {
      const text = formatSig(input, "long", options);
      expect(text).toMatch(/every (?:1 )?hour/u);
      expect(text.includes("Q30MIN")).toBe(kind === "foreign");
    }
    expect(toFhirR5Dosages(fresh(wire))[0].timing!.code).toEqual(code);
  });

  it.each(["standard first", "local first", "systemless", "foreign only"] as const)("reads Boolean condition coding by identity: %s", order => {
    const standard = { system: "http://hl7.org/fhir/CodeSystem/dosage-condition-code", code: "problem-presents" };
    const local = { system: "urn:clinic:condition", code: order === "foreign only" ? "problem-presents" : "rash-present" };
    const coding = order === "standard first" ? [standard, local] : order === "local first" ? [local, standard]
      : order === "systemless" ? [{ code: "problem-presents" }] : [local];
    const raw: FhirR6DosageInstruction = { step: [{ component: [{ ...dose, condition: [{
      code: { coding }, details: { text: "Rash" }, operation: "ne", valueBoolean: true,
    }] }] }] };
    const predicate = courseFromR6(raw).stages[0].administrations[0].predicate;
    expect(predicate).toEqual(order === "foreign only" ? { kind: "text", text: "Rash" }
      : { kind: "state", name: "Rash", expected: false, text: "Rash" });
    expect(toDosageDetails(fresh(toFhirR5Dosages(raw))).step![0].component[0].condition![0].code!.coding).toEqual(coding);
  });

  it.each(["low", "high"] as const)("retains an approximate administration-duration %s bound", side => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{ ...dose, timing: { repeat: { extension: [{
      url: TIMING_ADMINISTRATION_DURATION_EXTENSION_URL, valueRange: { [side]: {
        value: 2, unit: "h", system: "http://unitsofmeasure.org", code: "h", extension: [{
          url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
          valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000055" },
        }],
      } },
    }] } } }] }] };
    for (const input of [raw, fresh(toFhirR5Dosages(raw))]) for (const locale of ["en", "th"]) {
      const text = formatSig(input, "long", { ...options, locale });
      expect(text).toContain(locale === "en" ? side === "low" ? "at least" : "up to" : side === "low" ? "อย่างน้อย" : "ไม่เกิน");
      expect(formatSig(input, "short", { ...options, locale })).toContain((side === "low" ? ">=" : "<=") + "~2h");
    }
  });
});

}
