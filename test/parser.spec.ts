import { describe, expect, it } from "vitest";
import {
  fromFhirDosage,
  formatSig,
  getBodySiteCode,
  getBodySiteCodeAsync,
  getBodySiteText,
  getBodySiteTextAsync,
  listSupportedBodySiteGrammar,
  listSupportedBodySiteText,
  lookupBodySite,
  parseSig,
  parseSigAsync,
  suggestBodySiteText,
  suggestBodySites
} from "../src/index";
import { BODY_SITE_SPATIAL_RELATION_EXTENSION_URL } from "../src/body-site-spatial";
import {
  SNOMED_CT_FINDING_SITE_ATTRIBUTE_CODE,
  SNOMED_CT_LATERALITY_ATTRIBUTE_CODE,
  SNOMED_CT_TOPOGRAPHICAL_MODIFIER_CODE
} from "../src/snomed";
import {
  DEFAULT_BODY_SITE_SNOMED,
  DEFAULT_UNIT_SYNONYMS,
  EVENT_TIMING_TOKENS,
  ROUTE_TEXT
} from "../src/maps";
import {
  AdvicePolarity,
  AdviceRelation,
  EventTiming,
  RouteCode,
  SNOMEDCTRouteCodes,
  SiteCodeLookupRequest
} from "../src/types";
import { normalizeDosageForm } from "../src/context";

const TAB_CONTEXT = { dosageForm: "tab" } as const;
const FHIR_TRANSLATION_EXTENSION_URL =
  "http://hl7.org/fhir/StructureDefinition/translation";
const findingSiteCode = (focus: string, site: string) =>
  `${focus}:${SNOMED_CT_FINDING_SITE_ATTRIBUTE_CODE}=${site}`;
const topographicalSiteCode = (site: string, modifier: string) =>
  `${site}:${SNOMED_CT_TOPOGRAPHICAL_MODIFIER_CODE}=${modifier}`;
const lateralizedSiteCode = (site: string, laterality: string) =>
  `${site}:${SNOMED_CT_LATERALITY_ATTRIBUTE_CODE}=${laterality}`;

function expectPrimitiveTranslation(
  element: { extension?: Array<{ url: string; extension?: Array<{ url: string; valueCode?: string; valueString?: string }> }> } | undefined,
  locale: string,
  content: string
): void {
  const translation = element?.extension?.find(
    (extension) => extension.url === FHIR_TRANSLATION_EXTENSION_URL
  );
  expect(translation).toBeDefined();
  expect(translation).toEqual(
    expect.objectContaining({
      url: FHIR_TRANSLATION_EXTENSION_URL,
      extension: expect.arrayContaining([
        expect.objectContaining({
          url: "lang",
          valueCode: locale
        }),
        expect.objectContaining({
          url: "content",
          valueString: content
        })
      ])
    })
  );
}

describe("parseSig core scenarios", () => {
  it("parses 1x3 po pc", () => {
    const result = parseSig("1x3 po pc", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("TID");
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 3,
      period: 1,
      periodUnit: "d",
      when: ["PC"]
    });
    expect(result.fhir.route?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: SNOMEDCTRouteCodes["Oral route"],
      display: "Oral route"
    });
    expect(result.longText).toBe("Take 1 tablet orally three times daily after meals.");
  });

  it("parses decimal multiplicative tokens", () => {
    const result = parseSig("1.5x3", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1.5, unit: "tab" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("TID");
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 3,
      period: 1,
      periodUnit: "d"
    });
    expect(result.fhir.timing?.repeat?.count).toBeUndefined();
    expect(result.shortText).toBe("1.5 tab TID");
    expect(result.longText).toBe("Use 1.5 tablets three times daily.");
  });

  it("parses spaced decimal multiplicative tokens", () => {
    const result = parseSig("1.5 x3", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1.5, unit: "tab" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("TID");
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 3,
      period: 1,
      periodUnit: "d"
    });
    expect(result.fhir.timing?.repeat?.count).toBeUndefined();
    expect(result.shortText).toBe("1.5 tab TID");
    expect(result.longText).toBe("Use 1.5 tablets three times daily.");
  });

  it("keeps meal dash syntax disabled by default", () => {
    const result = parseSig("1-0-1 ac", { context: TAB_CONTEXT });
    expect(result.count).toBe(1);
    expect(result.fhir.timing?.repeat?.when).toEqual([EventTiming["Before Meal"]]);
  });

  it("parses meal dash syntax into a single clause when dosage context matches", () => {
    const result = parseSig("1-0-1", {
      context: TAB_CONTEXT,
      enableMealDashSyntax: true
    });
    expect(result.count).toBe(1);
    expect(result.items[0].fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(result.items[0].fhir.timing?.repeat?.when).toEqual([
      EventTiming.Breakfast,
      EventTiming.Dinner
    ]);
  });

  it("applies PC mapping for meal dash syntax", () => {
    const result = parseSig("1-0-1 pc", {
      context: TAB_CONTEXT,
      enableMealDashSyntax: true
    });
    expect(result.count).toBe(1);
    expect(result.items[0].fhir.timing?.repeat?.when).toEqual([
      EventTiming["After Breakfast"],
      EventTiming["After Dinner"]
    ]);
  });

  it("supports asymmetric AC meal dash doses", () => {
    const result = parseSig("10-12-0 ac", {
      context: TAB_CONTEXT,
      enableMealDashSyntax: true
    });
    expect(result.count).toBe(2);
    expect(result.items[0].fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 10, unit: "tab" });
    expect(result.items[0].fhir.timing?.repeat?.when).toEqual([EventTiming["Before Breakfast"]]);
    expect(result.items[1].fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 12, unit: "tab" });
    expect(result.items[1].fhir.timing?.repeat?.when).toEqual([EventTiming["Before Lunch"]]);
  });

  it("maps fourth meal dash slot to bedtime", () => {
    const result = parseSig("1-0-0-1 ac", {
      context: TAB_CONTEXT,
      enableMealDashSyntax: true
    });
    expect(result.count).toBe(1);
    expect(result.items[0].fhir.timing?.repeat?.when).toEqual([
      EventTiming["Before Breakfast"],
      EventTiming["Before Sleep"]
    ]);
  });

  it("keeps split timing clauses in one item when dosage context is identical", () => {
    const result = parseSig("1 tab po @ 8:00, 1 tab po hs", { context: TAB_CONTEXT });
    expect(result.count).toBe(1);
    expect(result.items[0].fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(result.items[0].fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Oral route"]);
    expect(result.items[0].fhir.timing?.repeat?.timeOfDay).toEqual(["08:00:00"]);
    expect(result.items[0].fhir.timing?.repeat?.when).toEqual([EventTiming["Before Sleep"]]);
  });

  it("treats standalone c as with meals", () => {
    const result = parseSig("1 po c", { context: TAB_CONTEXT });
    expect(result.fhir.timing?.repeat?.when).toEqual([EventTiming.Meal]);
    expect(result.longText).toContain("with meals");
  });

  it("parses compact oral+meal tokens", () => {
    const withMeal = parseSig("1 poc", { context: TAB_CONTEXT });
    expect(withMeal.fhir.timing?.repeat?.when).toEqual([EventTiming.Meal]);
    expect(withMeal.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Oral route"]);

    const afterMeal = parseSig("1 popc", { context: TAB_CONTEXT });
    expect(afterMeal.fhir.timing?.repeat?.when).toEqual([EventTiming["After Meal"]]);
    expect(afterMeal.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Oral route"]);

    const beforeMeal = parseSig("1 poac", { context: TAB_CONTEXT });
    expect(beforeMeal.fhir.timing?.repeat?.when).toEqual([EventTiming["Before Meal"]]);
    expect(beforeMeal.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Oral route"]);
  });

  it("parses adverbial route descriptors", () => {
    const cases: Array<{ input: string; code: SNOMEDCTRouteCodes }> = [
      { input: "1x2 orally bid", code: SNOMEDCTRouteCodes["Oral route"] },
      { input: "1x2 nasally bid", code: SNOMEDCTRouteCodes["Nasal route"] },
      { input: "1x2 topically bid", code: SNOMEDCTRouteCodes["Topical route"] },
      { input: "1x2 transdermally bid", code: SNOMEDCTRouteCodes["Transdermal route"] },
      { input: "1x2 intramuscularly bid", code: SNOMEDCTRouteCodes["Intramuscular route"] }
    ];

    for (const { input, code } of cases) {
      const result = parseSig(input);
      expect(result.fhir.route?.coding?.[0]?.code).toBe(code);
    }
  });

  it("parses fractional q-intervals and count limits", () => {
    const result = parseSig("1 tab po q0.5h x3 times", { context: TAB_CONTEXT });
    expect(result.fhir.timing?.repeat).toMatchObject({
      period: 30,
      periodUnit: "min",
      count: 3
    });
  });

  it("supports slash fractions and trailing count tokens", () => {
    const result = parseSig("1 drop to OS q1/4h x4", { context: TAB_CONTEXT });
    expect(result.fhir.timing?.repeat).toMatchObject({
      period: 15,
      periodUnit: "min",
      count: 4
    });
    expect(result.fhir.site?.text).toBe("left eye");
  });

  it("extracts count limits from dose descriptors", () => {
    const result = parseSig("500 mg po pc breakfast lunch dinner x5 doses");
    expect(result.fhir.timing?.repeat?.count).toBe(5);
  });

  it("parses count phrases introduced by for", () => {
    const result = parseSig("1 tab po q1h for 10 times", { context: TAB_CONTEXT });
    expect(result.fhir.timing?.repeat?.count).toBe(10);
    expect(result.shortText).toBe("1 tab PO Q1H x10");
    expect(result.longText).toBe("Take 1 tablet orally every 1 hour for 10 doses.");
  });

  it("parses asterisk-prefixed count limits", () => {
    const result = parseSig("1 tab po q6h *10 doses", { context: TAB_CONTEXT });
    expect(result.fhir.timing?.repeat?.count).toBe(10);
    expect(result.longText).toBe("Take 1 tablet orally every 6 hours for 10 doses.");
  });

  it("renders minute intervals together with count limits in long text", () => {
    const result = parseSig("1 drop ou q15min x 8 doses");
    expect(result.fhir.timing?.repeat).toMatchObject({
      period: 15,
      periodUnit: "min",
      count: 8
    });
    expect(result.shortText).toBe("1 drop OPH Q15MIN x8");
    expect(result.longText).toBe("Instill 1 drop every 15 minutes for 8 doses in both eyes.");
  });

  it("parses finite duration windows introduced by for", () => {
    const result = parseSig("take 1 tab po od for 10 days", { context: TAB_CONTEXT });
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d",
      boundsDuration: {
        value: 10,
        code: "d",
        system: "http://unitsofmeasure.org"
      }
    });
    expect(result.shortText).toBe("1 tab PO QD x10d");
    expect(result.longText).toBe("Take 1 tablet orally once daily for 10 days.");
    expect(result.meta.leftoverText).toBeUndefined();
  });

  it("treats bare once as a single administration instead of once daily", () => {
    const result = parseSig("insert 1 tab pv once", { context: TAB_CONTEXT });
    expect(result.fhir.timing?.repeat).toMatchObject({ count: 1 });
    expect(result.fhir.timing?.repeat?.frequency).toBeUndefined();
    expect(result.fhir.timing?.repeat?.period).toBeUndefined();
    expect(result.longText).toBe("Insert 1 tablet vaginally once.");
  });

  it("treats one time as a single administration instead of once daily", () => {
    const result = parseSig("insert 1 tab pv one time", { context: TAB_CONTEXT });
    expect(result.fhir.timing?.repeat).toMatchObject({ count: 1 });
    expect(result.fhir.timing?.repeat?.frequency).toBeUndefined();
    expect(result.fhir.timing?.repeat?.period).toBeUndefined();
    expect(result.longText).toBe("Insert 1 tablet vaginally once.");
  });

  it("keeps one-time event-relative instructions finite without coercing them to daily", () => {
    const result = parseSig("insert 1 tab pv once after menstruation ends", { context: TAB_CONTEXT });
    expect(result.fhir.timing?.repeat).toMatchObject({ count: 1 });
    expect(result.fhir.timing?.repeat?.frequency).toBeUndefined();
    expect(result.longText).toBe("Insert 1 tablet vaginally once. Use after menstruation ends.");
  });

  it("treats xN days as duration instead of dose count", () => {
    const result = parseSig("1 tab po od x7 days", { context: TAB_CONTEXT });
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d",
      boundsDuration: {
        value: 7,
        code: "d",
        system: "http://unitsofmeasure.org"
      }
    });
    expect(result.fhir.timing?.repeat?.count).toBeUndefined();
    expect(result.shortText).toBe("1 tab PO QD x7d");
    expect(result.longText).toBe("Take 1 tablet orally once daily for 7 days.");
    expect(result.meta.leftoverText).toBeUndefined();
  });

  it("keeps PRN duration suffixes out of the PRN reason text", () => {
    const result = parseSig("take 1 tab po prn vaginal itch for 7 days", {
      context: TAB_CONTEXT
    });
    expect(result.fhir.timing?.repeat).toMatchObject({
      boundsDuration: {
        value: 7,
        code: "d",
        system: "http://unitsofmeasure.org"
      }
    });
    expect(result.fhir.asNeededFor).toEqual([
      {
        text: "vaginal itch",
        coding: [
          {
            system: "http://snomed.info/sct",
            code: "34363003",
            display: "Pruritus of vagina"
          }
        ]
      }
    ]);
    expect(result.longText).toBe(
      "Take 1 tablet orally for 7 days as needed for vaginal itch."
    );
    expect(result.meta.canonical.clauses[0]?.prn?.reason).toMatchObject({
      text: "vaginal itch",
      coding: {
        code: "34363003"
      }
    });
  });

  it("omits redundant mouth sites when route is oral", () => {
    const result = parseSig("500 mg per mouth every 4 to 6 hours as needed for pain");
    expect(result.fhir.site).toBeUndefined();
    expect(result.longText).toBe("Take 500 mg orally every 4 to 6 hours as needed for pain.");
  });

  it("treats descriptive route phrases as routes instead of sites", () => {
    const result = parseSig("2 mL via intravenous route every 8 hours");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(
      SNOMEDCTRouteCodes["Intravenous route"]
    );
    expect(result.fhir.site).toBeUndefined();
  });

  it("infers ophthalmic units from medication context", () => {
    const result = parseSig("1x3 OD", {
      context: { dosageForm: "eye drops, solution" }
    });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "drop" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("TID");
    expect(result.fhir.site?.text).toBe("right eye");
  });

  it("defaults ophthalmic units when only site hints are supplied", () => {
    const result = parseSig("1x3 OD");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "drop" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("TID");
    expect(result.fhir.site?.text).toBe("right eye");
  });

  it("interprets OD as once daily when systemic cues are present", () => {
    const result = parseSig("1 tab OD", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("QD");
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
    expect(result.fhir.site).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it("preserves ophthalmic interpretation of OD when eye context exists", () => {
    const result = parseSig("1 drop OD");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "drop" });
    expect(result.fhir.site?.text).toBe("right eye");
    expect(result.fhir.timing?.code).toBeUndefined();
  });

  it("treats OD as once daily for inhalation dosage-form context", () => {
    const result = parseSig("1 od", { context: { dosageForm: "inhalation" } });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "puff" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("QD");
    expect(result.fhir.site).toBeUndefined();
    expect(result.fhir.route?.coding?.[0]?.code).not.toBe(
      SNOMEDCTRouteCodes["Ophthalmic route"]
    );
  });

  it("interprets ophthalmic double OD as right eye once daily", () => {
    const result = parseSig("1 drop OD OD");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "drop" });
    expect(result.fhir.site?.text).toBe("right eye");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Ophthalmic route"]);
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
    expect(result.warnings).toEqual([]);
  });

  it("infers ophthalmic route from spelled eye site", () => {
    const result = parseSig("1 drop right eye once daily");
    expect(result.fhir.site?.text).toBe("right eye");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Ophthalmic route"]);
  });

  it("treats OD as once daily when no other frequency cues exist", () => {
    const result = parseSig("Take medication OD");
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
    expect(result.fhir.site).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it("interprets OS followed by OD as left eye once daily", () => {
    const result = parseSig("1 drop OS OD");
    expect(result.fhir.site?.text).toBe("left eye");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Ophthalmic route"]);
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
    expect(result.warnings).toEqual([]);
  });

  it("interprets to OS OD as left eye once daily", () => {
    const result = parseSig("1 drop to OS OD");
    expect(result.fhir.site?.text).toBe("left eye");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Ophthalmic route"]);
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
    expect(result.warnings).toEqual([]);
  });

  it("treats trailing OD as once daily when the eye site is already spelled out", () => {
    const result = parseSig("1 drop to left eye od");
    expect(result.fhir.site?.text).toBe("left eye");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(
      SNOMEDCTRouteCodes["Ophthalmic route"]
    );
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
    expect(result.warnings).toEqual([]);
  });

  it("treats spelled non-ophthalmic sites before OD as once daily cadence", () => {
    const result = parseSig("1 drop to forehead od");
    expect(result.fhir.site?.text).toBe("forehead");
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
    expect(result.warnings).toEqual([]);
  });

  it("treats spelled sites after OD as once daily cadence cues", () => {
    const result = parseSig("1 drop od to left eye");
    expect(result.fhir.site?.text).toBe("left eye");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(
      SNOMEDCTRouteCodes["Ophthalmic route"]
    );
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
    expect(result.warnings).toEqual([]);
  });

  it("keeps non-ophthalmic routes when OD precedes a spelled body site", () => {
    const result = parseSig("1 drop od to skin");
    expect(result.fhir.site?.text).toBe("skin");
    expect(result.fhir.route?.coding?.[0]?.code).not.toBe(
      SNOMEDCTRouteCodes["Ophthalmic route"]
    );
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
    expect(result.warnings).toEqual([]);
  });

  it("recognizes uncommon spelled sites after OD", () => {
    const result = parseSig("1 drop od to hair");
    expect(result.fhir.site?.text).toBe("hair");
    expect(result.fhir.route?.coding?.[0]?.code).not.toBe(
      SNOMEDCTRouteCodes["Ophthalmic route"]
    );
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
    expect(result.warnings).toEqual([]);
  });

  it("strips connector words from spelled site phrases", () => {
    const result = parseSig("1 drop bid to face");
    expect(result.fhir.site?.text).toBe("face");
    expect(result.fhir.route).toBeUndefined();
    expect(result.longText).toBe("Use 1 drop twice daily to the face.");
  });

  describe("custom siteCodeMap usage", () => {
    const CUSTOM_SYSTEM = "http://example.org/custom-sites";

    it("resolves novel non-lateral sites via siteCodeMap definitions", () => {
      const result = parseSig("apply to MoOb nightly", {
        siteCodeMap: {
          moob: {
            coding: {
              system: CUSTOM_SYSTEM,
              code: "MOOB",
              display: "Moob surface"
            },
            text: "Moob (custom)"
          }
        }
      });

      expect(result.fhir.site?.coding?.[0]).toEqual({
        system: CUSTOM_SYSTEM,
        code: "MOOB",
        display: "Moob surface"
      });
      expect(result.fhir.site?.text).toBe("Moob (custom)");
      expect(result.meta.normalized.site).toEqual({
        text: "Moob (custom)",
        coding: {
          system: CUSTOM_SYSTEM,
          code: "MOOB",
          display: "Moob surface"
        }
      });
      expect(result.meta.siteLookups).toBeUndefined();
    });

    it("normalizes siteCodeMap keys before performing lookups", () => {
      const result = parseSig("apply to calcaneus", {
        siteCodeMap: {
          "   CaLcAnEuS   ": {
            coding: {
              system: CUSTOM_SYSTEM,
              code: "CALC",
              display: "Calcaneus"
            },
            text: "Calcaneus (custom)"
          }
        }
      });

      expect(result.fhir.site?.coding?.[0]).toEqual({
        system: CUSTOM_SYSTEM,
        code: "CALC",
        display: "Calcaneus"
      });
      expect(result.fhir.site?.text).toBe("Calcaneus (custom)");
      expect(result.meta.siteLookups).toBeUndefined();
    });

    it("records custom suggestions when brace placeholders request lookups", () => {
      const result = parseSig("apply to {calcaneus}", {
        siteCodeMap: {
          calcaneus: {
            coding: {
              system: CUSTOM_SYSTEM,
              code: "CALC",
              display: "Calcaneus"
            },
            text: "Calcaneus (custom)"
          }
        }
      });

      expect(result.fhir.site?.coding?.[0]?.code).toBe("CALC");
      expect(result.meta.siteLookups?.[0]?.request.canonical).toBe("calcaneus");
      expect(result.meta.siteLookups?.[0]?.request.isProbe).toBe(true);
      expect(result.meta.siteLookups?.[0]?.suggestions).toEqual([
        {
          coding: {
            system: CUSTOM_SYSTEM,
            code: "CALC",
            display: "Calcaneus"
          },
          text: "Calcaneus (custom)"
        }
      ]);
    });

    it("merges custom and default suggestions for recognized sites with probes", () => {
      const result = parseSig("apply to {scalp}", {
        siteCodeMap: {
          scalp: {
            coding: {
              system: CUSTOM_SYSTEM,
              code: "SCALP",
              display: "Scalp custom"
            },
            text: "Scalp (custom)"
          }
        }
      });

      expect(result.fhir.site?.coding?.[0]).toEqual({
        system: CUSTOM_SYSTEM,
        code: "SCALP",
        display: "Scalp custom"
      });
      expect(result.meta.siteLookups?.[0]?.request.isProbe).toBe(true);
      expect(result.meta.siteLookups?.[0]?.suggestions).toEqual([
        {
          coding: {
            system: CUSTOM_SYSTEM,
            code: "SCALP",
            display: "Scalp custom"
          },
          text: "Scalp (custom)"
        },
        {
          coding: {
            system: "http://snomed.info/sct",
            code: "41695006",
            display: "Scalp"
          },
          text: undefined
        }
      ]);
    });

    it("allows explicit selections to keep default SNOMED codings", () => {
      const result = parseSig("apply to {scalp}", {
        siteCodeMap: {
          scalp: {
            coding: {
              system: CUSTOM_SYSTEM,
              code: "SCALP",
              display: "Scalp custom"
            },
            text: "Scalp (custom)"
          }
        },
        siteCodeSelections: {
          canonical: "scalp",
          resolution: DEFAULT_BODY_SITE_SNOMED["scalp"]!
        }
      });

      expect(result.fhir.site?.coding?.[0]).toEqual({
        system: "http://snomed.info/sct",
        code: "41695006",
        display: "Scalp"
      });
      expect(result.fhir.site?.text).toBe("scalp");
      expect(result.meta.siteLookups?.[0]?.suggestions).toEqual([
        {
          coding: {
            system: "http://snomed.info/sct",
            code: "41695006",
            display: "Scalp"
          },
          text: undefined
        },
        {
          coding: {
            system: CUSTOM_SYSTEM,
            code: "SCALP",
            display: "Scalp custom"
          },
          text: "Scalp (custom)"
        }
      ]);
    });

    it("applies range-specific selections for probe lookups", () => {
      const input = "apply to {scalp}";
      const start = input.indexOf("scalp");
      const end = start + "scalp".length;

      const result = parseSig(input, {
        siteCodeSelections: {
          range: { start, end },
          resolution: {
            coding: {
              system: CUSTOM_SYSTEM,
              code: "ALT-SCALP",
              display: "Alternate scalp"
            },
            text: "Alternate scalp"
          }
        }
      });

      expect(result.fhir.site?.coding?.[0]).toEqual({
        system: CUSTOM_SYSTEM,
        code: "ALT-SCALP",
        display: "Alternate scalp"
      });
      expect(result.fhir.site?.text).toBe("Alternate scalp");
      expect(result.meta.siteLookups?.[0]?.request.range).toEqual({ start, end });
      expect(result.meta.siteLookups?.[0]?.suggestions).toEqual([
        {
          coding: {
            system: CUSTOM_SYSTEM,
            code: "ALT-SCALP",
            display: "Alternate scalp"
          },
          text: "Alternate scalp"
        },
        {
          coding: {
            system: "http://snomed.info/sct",
            code: "41695006",
            display: "Scalp"
          },
          text: undefined
        }
      ]);
    });

    it("prefers siteCodeMap definitions when overriding default anatomy", () => {
      const result = parseSig("apply to left arm", {
        siteCodeMap: {
          "left arm": {
            coding: {
              system: CUSTOM_SYSTEM,
              code: "LARM",
              display: "Custom left arm"
            },
            text: "Left arm (custom override)"
          }
        }
      });

      expect(result.fhir.site?.coding?.[0]).toEqual({
        system: CUSTOM_SYSTEM,
        code: "LARM",
        display: "Custom left arm"
      });
      expect(result.fhir.site?.text).toBe("Left arm (custom override)");
    });

    it("handles custom non-lateral dental anatomy like 'middle molar'", () => {
      const result = parseSig("apply to middle molar", {
        siteCodeMap: {
          "middle molar": {
            coding: {
              system: CUSTOM_SYSTEM,
              code: "MIDMOLAR",
              display: "Middle molar"
            },
            text: "Middle molar"
          }
        }
      });

      expect(result.fhir.site?.coding?.[0]).toEqual({
        system: CUSTOM_SYSTEM,
        code: "MIDMOLAR",
        display: "Middle molar"
      });
      expect(result.fhir.site?.text).toBe("Middle molar");
    });

    it("supports aliases for directional dental phrases", () => {
      const siteCodeMap = {
        "left second molar": {
          coding: {
            system: CUSTOM_SYSTEM,
            code: "L2MOLAR",
            display: "Left second molar"
          },
          text: "Left second molar",
          aliases: ["second molar left"]
        },
        "left first bicuspid": {
          coding: {
            system: CUSTOM_SYSTEM,
            code: "L1BICUSPID",
            display: "Left first bicuspid"
          },
          text: "Left first bicuspid",
          aliases: [
            "first bicuspid left",
            "first bicuspid, left",
            "first bicuspid (left)"
          ]
        },
        "right first bicuspid": {
          coding: {
            system: CUSTOM_SYSTEM,
            code: "R1BICUSPID",
            display: "Right first bicuspid"
          },
          text: "Right first bicuspid",
          aliases: [
            "first bicuspid right",
            "first bicuspid, right",
            "first bicuspid (right)"
          ]
        }
      } as const;

      const cases: Array<{ input: string; code: string }> = [
        { input: "apply to left second molar", code: "L2MOLAR" },
        { input: "apply to second molar left", code: "L2MOLAR" },
        { input: "apply to left first bicuspid", code: "L1BICUSPID" },
        { input: "apply to first bicuspid left", code: "L1BICUSPID" },
        { input: "apply to first bicuspid, left", code: "L1BICUSPID" },
        { input: "apply to first bicuspid (left)", code: "L1BICUSPID" },
        { input: "apply to first bicuspid (right)", code: "R1BICUSPID" }
      ];

      for (const { input, code } of cases) {
        const result = parseSig(input, { siteCodeMap });
        expect(result.fhir.site?.coding?.[0]?.code).toBe(code);
        expect(result.fhir.site?.coding?.[0]?.system).toBe(CUSTOM_SYSTEM);
      }
    });
  });

  it("interprets repeated OD as right eye once daily", () => {
    const result = parseSig("OD OD");
    expect(result.fhir.site?.text).toBe("right eye");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(
      SNOMEDCTRouteCodes["Ophthalmic route"]
    );
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
    expect(result.warnings).toEqual([]);
  });

  it("prefers non-ophthalmic route matches over OD eye interpretation", () => {
    const result = parseSig("1 drop td od");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(
      SNOMEDCTRouteCodes["Transdermal route"]
    );
    expect(result.fhir.site).toBeUndefined();
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
    expect(result.warnings).toEqual([]);
  });

  it("keeps subcutaneous routes when OD supplies cadence", () => {
    const result = parseSig("1 drop sc od");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(
      SNOMEDCTRouteCodes["Subcutaneous route"]
    );
    expect(result.fhir.site).toBeUndefined();
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
    expect(result.warnings).toEqual([]);
  });

  it("interprets dotted O.D. as once daily when paired with oral route", () => {
    const result = parseSig("500 mg po O.D.");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 500, unit: "mg" });
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Oral route"]);
    expect(result.fhir.site).toBeUndefined();
  });

  it("parses numeric per-day cadence shorthand", () => {
    const result = parseSig("1 tab 3/day", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("TID");
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 3,
      period: 1,
      periodUnit: "d"
    });
  });

  it("parses numeric per-day shorthand with capital D", () => {
    const result = parseSig("1 tab 1/D", { context: TAB_CONTEXT });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("QD");
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
  });

  it("parses numeric per-week cadence", () => {
    const result = parseSig("2 puffs 2/week");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 2, unit: "puff" });
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 2,
      period: 1,
      periodUnit: "wk"
    });
  });

  it("parses numeric per-month cadence", () => {
    const result = parseSig("Apply 1 patch 1/month");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "patch" });
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "mo"
    });
  });

  it("parses thrice daily cadence phrases", () => {
    const result = parseSig("apply to right arm thrice daily");
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 3,
      period: 1,
      periodUnit: "d"
    });
  });

  it("parses numeric times-per-day cadence phrases", () => {
    const result = parseSig("apply to right arm 4 times daily");
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 4,
      period: 1,
      periodUnit: "d"
    });
  });

  it("parses numeric per-day cadence with articles", () => {
    const result = parseSig("apply to right arm 5 a day");
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 5,
      period: 1,
      periodUnit: "d"
    });
  });

  it("parses singular time daily cadence", () => {
    const result = parseSig("apply to right arm 2 time per day");
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 2,
      period: 1,
      periodUnit: "d"
    });
  });

  it("parses plural times-per-day cadence", () => {
    const result = parseSig("apply to right arm 3 times per day");
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 3,
      period: 1,
      periodUnit: "d"
    });
  });

  it("infers inhalation units from respiratory route hints", () => {
    const result = parseSig("2 inh q4h");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 2, unit: "puff" });
    expect(result.fhir.route?.coding?.[0]?.code).toBe(
      SNOMEDCTRouteCodes["Respiratory tract route (qualifier value)"]
    );
  });

  it("infers per vagina route from spelled site text", () => {
    const result = parseSig("Apply cream to vagina once daily");
    expect(result.fhir.site?.text).toBe("vagina");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Per vagina"]);
  });

  it("captures nasal site phrases without leaving stray text", () => {
    const result = parseSig("Spray once daily to nostril");
    expect(result.fhir.site?.text).toBe("nostril");
    expect(result.meta.leftoverText).toBeUndefined();
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Nasal route"]);
  });

  it("infers patch units for transdermal routes", () => {
    const result = parseSig("1 td daily");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "patch" });
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Transdermal route"]);
  });

  it("infers suppository units for rectal routes", () => {
    const result = parseSig("1 pr q12h");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({
      value: 1,
      unit: "suppository"
    });
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Per rectum"]);
  });

  it("formats oral bedtime instructions", () => {
    const result = parseSig("1 mg po hs");
    expect(result.longText).toBe("Take 1 mg orally at bedtime.");
  });

  it("normalizes spelled metric dose units", () => {
    const result = parseSig("500 milligrams po q12h");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({
      value: 500,
      unit: "mg"
    });
    expect(result.meta.normalized.unit).toBe("mg");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Oral route"]);
  });

  it("supports spelled millilitre synonyms", () => {
    const result = parseSig("10 millilitres po qd");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 10, unit: "mL" });
    expect(result.meta.normalized.unit).toBe("mL");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Oral route"]);
  });

  it("persists insulin shorthand units", () => {
    const result = parseSig("20 U sc hs");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 20, unit: "U" });
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Subcutaneous route"]);
    expect(result.fhir.timing?.repeat?.when).toEqual([EventTiming["Before Sleep"]]);
    expect(result.fhir.additionalInstruction).toBeUndefined();
  });

  it("keeps unit token in meal-dash expansion", () => {
    const result = parseSig("10-0-10 units sc ac", {
      enableMealDashSyntax: true,
      context: { dosageForm: "vial" }
    });
    expect(result.count).toBe(1);
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 10, unit: "U" });
    expect(result.fhir.timing?.repeat?.when).toEqual([EventTiming["Before Breakfast"], EventTiming["Before Dinner"]]);
  });

  it("parses million IU notation", () => {
    const result = parseSig("2.4M IU IM once");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 2400000, unit: "IU" });
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Intramuscular route"]);
    expect(result.fhir.timing?.repeat).toMatchObject({ count: 1 });
    expect(result.fhir.timing?.repeat?.frequency).toBeUndefined();
    expect(result.fhir.timing?.repeat?.frequencyMax).toBeUndefined();
    expect(result.fhir.timing?.repeat?.period).toBeUndefined();
    expect(result.fhir.timing?.repeat?.periodUnit).toBeUndefined();
    expect(result.fhir.timing?.repeat?.dayOfWeek).toBeUndefined();
    expect(result.fhir.timing?.repeat?.when).toBeUndefined();
  });

  it("keeps once daily as cadence rather than collapsing to a one-time count", () => {
    const result = parseSig("insert 1 tab pv once daily", { context: TAB_CONTEXT });
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
    expect(result.fhir.timing?.repeat?.count).toBeUndefined();
  });

  it("keeps once every 6 hours as cadence rather than collapsing to a one-time count", () => {
    const result = parseSig("1 tab po once every 6 hours", { context: TAB_CONTEXT });
    expect(result.fhir.timing?.repeat).toMatchObject({
      period: 6,
      periodUnit: "h"
    });
    expect(result.fhir.timing?.repeat?.count).toBeUndefined();
    expect(result.longText).toBe("Take 1 tablet orally every 6 hours.");
    expect(result.meta.leftoverText).toBeUndefined();
  });

  it("keeps one time every 8 hours as cadence rather than collapsing to a one-time count", () => {
    const result = parseSig("1 tab po one time every 8 hours", { context: TAB_CONTEXT });
    expect(result.fhir.timing?.repeat).toMatchObject({
      period: 8,
      periodUnit: "h"
    });
    expect(result.fhir.timing?.repeat?.count).toBeUndefined();
    expect(result.longText).toBe("Take 1 tablet orally every 8 hours.");
    expect(result.meta.leftoverText).toBeUndefined();
  });

  it("keeps once q week as cadence rather than collapsing to a one-time count", () => {
    const result = parseSig("1 tab po once q week", { context: TAB_CONTEXT });
    expect(result.fhir.timing?.repeat).toMatchObject({
      period: 1,
      periodUnit: "wk"
    });
    expect(result.fhir.timing?.repeat?.count).toBeUndefined();
    expect(result.longText).toBe("Take 1 tablet orally once weekly.");
    expect(result.meta.leftoverText).toBeUndefined();
  });

  it("parses million IU notation with weekly cadence", () => {
    const result = parseSig("2.4M IU IM Q1week");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 2400000, unit: "IU" });
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Intramuscular route"]);
    expect(result.fhir.timing?.repeat).toMatchObject({
      period: 1,
      periodUnit: "wk"
    });
  });

  it("keeps tablet units while mapping trailing suppository text to rectal route", () => {
    const result = parseSig("1 tab suppository");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({
      value: 1,
      unit: "tab"
    });
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Per rectum"]);
    expect(result.meta.leftoverText).toBeUndefined();
  });

  it("keeps tablet plurals while mapping shortened suppository tokens to rectal route", () => {
    const result = parseSig("11 tabs suppo");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({
      value: 11,
      unit: "tab"
    });
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Per rectum"]);
    expect(result.meta.leftoverText).toBeUndefined();
  });

  it("parses household teaspoon and tablespoon measures", () => {
    const teaspoon = parseSig("1 teaspoon po q6h");
    expect(teaspoon.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tsp" });
    expect(teaspoon.meta.normalized.unit).toBe("tsp");

    const tablespoon = parseSig("2 tablespoons po q8h");
    expect(tablespoon.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 2, unit: "tbsp" });
    expect(tablespoon.meta.normalized.unit).toBe("tbsp");
  });

  it("disables household volume measures when requested", () => {
    const result = parseSig("1 teaspoon po q6h", {
      allowHouseholdVolumeUnits: false,
    });
    expect(result.meta.normalized.unit).toBeUndefined();
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity?.unit).not.toBe("tsp");
    expect(result.meta.leftoverText?.toLowerCase() ?? "").toContain("teaspoon");
  });

  it("parses dose ranges with frequency code", () => {
    const result = parseSig("1-2 tabs po prn pain tid", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseRange).toEqual({
      low: { value: 1, unit: "tab" },
      high: { value: 2, unit: "tab" }
    });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("TID");
    expect(result.longText).toContain("1 to 2 tablets orally");
    expect(result.longText).toContain("as needed for pain");
  });

  it("parses po qid pc", () => {
    const result = parseSig("po qid pc");
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("QID");
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 4,
      period: 1,
      periodUnit: "d",
      when: ["PC"]
    });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toBeUndefined();
  });

  it("parses 1*3 po ac", () => {
    const result = parseSig("1*3 po ac", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("TID");
    expect(result.fhir.timing?.repeat?.when).toEqual(["AC"]);
  });

  it("parses daily without code", () => {
    const result = parseSig("500 mg po daily");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 500, unit: "mg" });
    expect(result.fhir.timing?.code).toBeUndefined();
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
  });

  it("parses q6h prn", () => {
    const result = parseSig("2 tab po q6h prn pain");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 2, unit: "tab" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("Q6H");
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 6, periodUnit: "h" });
    expect(result.fhir.asNeededBoolean).toBe(true);
    expect(result.fhir.asNeededFor?.[0]?.text).toBe("pain");
    expect(result.fhir.asNeededFor?.[0]?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: "22253000",
      display: "Pain"
    });
    expect(result.meta.normalized.prnReason?.coding).toEqual({
      system: "http://snomed.info/sct",
      code: "22253000",
      display: "Pain"
    });
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Oral route"]);
  });

  it("parses period ranges with prn reasons", () => {
    const result = parseSig("2 supp q 6-8 h prn constipation");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 2, unit: "suppository" });
    expect(result.fhir.timing?.repeat).toMatchObject({
      period: 6,
      periodMax: 8,
      periodUnit: "h"
    });
    expect(result.fhir.asNeededBoolean).toBe(true);
    expect(result.fhir.asNeededFor?.[0]?.text).toBe("constipation");
    expect(result.fhir.asNeededFor?.[0]?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: "14760008",
      display: "Constipation"
    });
    expect(result.meta.normalized.prnReason?.coding).toEqual({
      system: "http://snomed.info/sct",
      code: "14760008",
      display: "Constipation"
    });
    expect(result.longText).toContain("every 6 to 8 hours");
  });

  it("codes PRN reason suggestions when unresolved", () => {
    const result = parseSig("po prn {reason}");
    const lookup = result.meta.prnReasonLookups?.[0];
    expect(lookup?.request.isProbe).toBe(true);
    expect(lookup?.suggestions.some((suggestion) => suggestion.coding?.code === "22253000")).toBe(
      true
    );
  });

  it("codes additional instructions using SNOMED when recognized", () => {
    const result = parseSig("1 tab po daily - do not crush or chew", { context: TAB_CONTEXT });
    expect(result.fhir.additionalInstruction?.[0]).toEqual({
      text: "Swallow whole; do not crush or chew",
      coding: [
        {
          system: "http://snomed.info/sct",
          code: "418693002",
          display: "Swallowed whole, not chewed (qualifier value)"
        }
      ]
    });
    expect(result.meta.normalized.additionalInstructions).toEqual([
      {
        text: "Swallow whole; do not crush or chew",
        coding: {
          system: "http://snomed.info/sct",
          code: "418693002",
          display: "Swallowed whole, not chewed (qualifier value)"
        }
      }
    ]);
    expect(result.meta.canonical.clauses[0].additionalInstructions?.[0]?.frames).toEqual([
      expect.objectContaining({
        polarity: AdvicePolarity.Negate,
        predicate: expect.objectContaining({ lemma: "crush" })
      }),
      expect.objectContaining({
        polarity: AdvicePolarity.Negate,
        predicate: expect.objectContaining({ lemma: "chew" })
      })
    ]);
    expect(result.meta.leftoverText).toBeUndefined();
    expect(result.longText).toContain("Swallow whole; do not crush or chew");
  });

  it("preserves free-form additional instructions when unmatched", () => {
    const result = parseSig("1 tab po daily; use caution in storms");
    expect(result.fhir.additionalInstruction?.[0]).toEqual({
      text: "Use caution in storms",
      coding: undefined
    });
    expect(result.meta.normalized.additionalInstructions).toEqual([
      { text: "Use caution in storms", coding: undefined }
    ]);
  });

  it("stops PRN reason text at trailing additional instructions", () => {
    const result = parseSig("1x3 po prn vomiting; no alcohol", { context: TAB_CONTEXT });
    expect(result.fhir.asNeededBoolean).toBe(true);
    expect(result.fhir.asNeededFor?.[0]?.text).toBe("vomiting");
    expect(result.fhir.additionalInstruction?.[0]).toEqual({
      text: "Avoid alcoholic drinks",
      coding: [
        {
          system: "http://snomed.info/sct",
          code: "419822006",
          display: "Warning. Avoid alcoholic drink (qualifier value)"
        }
      ]
    });
    expect(result.meta.normalized.prnReason?.text).toBe("vomiting");
    expect(result.meta.normalized.additionalInstructions?.[0]?.text).toBe(
      "Avoid alcoholic drinks"
    );
    expect(result.meta.canonical.clauses[0].additionalInstructions?.[0]?.frames?.[0]).toEqual(
      expect.objectContaining({
        force: expect.any(String),
        args: expect.arrayContaining([
          expect.objectContaining({ conceptId: "alcohol" })
        ])
      })
    );
  });

  it("preserves PRN coding when semicolons separate additional instructions", () => {
    const result = parseSig("1x3 suppository prn constipation; no alcohol");
    expect(result.fhir.asNeededFor?.[0]?.text).toBe("constipation");
    expect(result.fhir.asNeededFor?.[0]?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: "14760008",
      display: "Constipation"
    });
    expect(result.fhir.additionalInstruction?.[0]?.text).toBe("Avoid alcoholic drinks");
    expect(result.fhir.additionalInstruction?.[0]?.coding?.[0]?.code).toBe("419822006");
  });

  it("formats rectal PRN sigs without swallowing trailing instructions", () => {
    const result = parseSig("1x3 rectal prn constipation; no alcohol");
    expect(result.fhir.asNeededFor?.[0]?.text).toBe("constipation");
    expect(result.fhir.additionalInstruction?.[0]?.text).toBe("Avoid alcoholic drinks");
    expect(result.fhir.additionalInstruction?.[0]?.coding?.[0]?.code).toBe("419822006");
    expect(result.fhir.site?.text).toBe("rectum");
    expect(result.longText).toBe(
      "Use 1 suppository rectally three times daily as needed for constipation. Avoid alcoholic drinks."
    );
  });

  it("retains rectal PRN location phrases inside the reason text", () => {
    const result = parseSig("1 mL rectal prn irritation at rectum");
    expect(result.fhir.asNeededFor?.[0]?.text).toBe("irritation at rectum");
    expect(result.fhir.asNeededFor?.[0]?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: findingSiteCode("257553007", "34402009"),
      display: "irritation at rectum"
    });
    expect(result.fhir.site?.text).toBe("rectum");
    expect(result.fhir.site?.coding?.[0]?.system).toBe("http://snomed.info/sct");
    expect(result.fhir.site?.coding?.[0]?.code).toBe("34402009");
    expect(result.fhir.asNeededFor?.[0]?.text?.toLowerCase()).toContain("rectum");
    expect(result.meta.normalized.prnReason?.text).toBe("irritation at rectum");
    expect(result.meta.normalized.prnReason?.coding).toEqual({
      system: "http://snomed.info/sct",
      code: findingSiteCode("257553007", "34402009"),
      display: "irritation at rectum"
    });
    expect(result.longText.toLowerCase()).toContain("irritation at rectum");
  });

  it("keeps conflicting PRN site phrases from merging with earlier route text", () => {
    const result = parseSig("1 mL rectal prn irritation at vagina");
    expect(result.fhir.asNeededFor?.[0]?.text).toBe("irritation at vagina");
    expect(result.fhir.site?.text).toBe("rectum");
    expect(result.fhir.route?.text?.toLowerCase()).toContain("rectal");
    expect(result.longText.toLowerCase()).not.toContain("rectal vagina");
    expect(result.longText.toLowerCase()).toContain("irritation at vagina");
  });

  it("normalizes adjectival site phrases across shared body-site definitions", () => {
    const result = parseSig("1x2 vaginal prn infection; no alcohol");
    expect(result.fhir.asNeededFor?.[0]?.text).toBe("infection");
    expect(result.fhir.additionalInstruction?.[0]?.text).toBe("Avoid alcoholic drinks");
    expect(result.fhir.site?.text).toBe("vagina");
    expect(result.longText).toContain("Avoid alcoholic drinks.");
    expect(result.longText).not.toMatch(/vaginal[^.]*no alcohol/i);
  });

  it("separates nasal PRN reasons from trailing additional instructions", () => {
    const result = parseSig("1 mg to nose prn congestion; no alcohol");
    expect(result.fhir.asNeededFor?.[0]?.text).toBe("congestion");
    expect(result.fhir.additionalInstruction?.[0]?.text).toBe("Avoid alcoholic drinks");
    expect(result.longText).toBe(
      "Use 1 mg as needed for congestion into the nose. Avoid alcoholic drinks."
    );
  });

  it("keeps after-food advice as schedule timing in real oral sigs", () => {
    const result = parseSig("1 tab po prn pain after food", { context: TAB_CONTEXT });
    expect(result.fhir.timing?.repeat?.when).toEqual([EventTiming["After Meal"]]);
    expect(result.fhir.additionalInstruction).toBeUndefined();
    expect(result.fhir.asNeededFor?.[0]?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: "22253000",
      display: "Pain"
    });
    expect(result.longText).toBe("Take 1 tablet orally after meals as needed for pain.");
  });

  it("codes Thai topical PRN reasons and sparing instructions in end-to-end sigs", () => {
    const result = parseSig("apply cream to affected area prn คัน; use minimal");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Topical route"]);
    expect(result.fhir.asNeededFor?.[0]?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: "418363000",
      display: "Itching of skin"
    });
    expect(result.fhir.additionalInstruction?.[0]?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: "420883007",
      display: "Sparingly - dosing instruction fragment"
    });
    expect(result.meta.normalized.prnReason?.coding).toEqual({
      system: "http://snomed.info/sct",
      code: "418363000",
      display: "Itching of skin"
    });
  });

  it("codes Thai pain reasons in topical PRN sigs with free-text sites", () => {
    const result = parseSig("apply to lesion prn เจ็บ; use little at a time");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Topical route"]);
    expect(result.fhir.site?.text).toBe("lesion");
    expect(result.fhir.asNeededFor?.[0]?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: "22253000",
      display: "Pain"
    });
    expect(result.fhir.additionalInstruction?.[0]?.coding?.[0]?.code).toBe("420883007");
    expect(result.longText).toContain("Apply sparingly.");
  });

  it("codes eye-specific itch reasons instead of falling back to generic skin itch", () => {
    const result = parseSig("1 drop to eye prn eye itch");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Ophthalmic route"]);
    expect(result.fhir.site?.coding?.[0]?.code).toBe("81745001");
    expect(result.fhir.asNeededFor?.[0]?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: "74776002",
      display: "Itching of eye"
    });
  });

  it("upgrades generic itch reasons to eye-specific coding when the parsed site is ocular", () => {
    const result = parseSig("1 drop to eye prn itch");
    expect(result.fhir.asNeededFor?.[0]?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: "74776002",
      display: "Itching of eye"
    });
  });

  it("treats conditional PRN adjuncts as movable grammar signs", () => {
    const cases = [
      "when itchy apply to left ear",
      "if itchy apply to left ear",
      "apply to left ear when itchy",
      "apply when itchy to left ear"
    ] as const;

    for (const sig of cases) {
      const result = parseSig(sig);
      expect(result.longText).toBe("Apply the medication as needed for itch in the left ear.");
      expect(result.meta.leftoverText).toBeUndefined();
      expect(result.fhir.site?.coding?.[0]?.code).toBe("89644007");
      expect(result.fhir.asNeededFor?.[0]?.text).toBe("itch");
      expect(result.fhir.asNeededFor?.[0]?.coding?.[0]?.code).toBe(
        findingSiteCode("418363000", "89644007")
      );
    }
  });

  it("normalizes predicative conditional reason adjectives to coded condition nouns", () => {
    const cases = [
      ["when dizzy take 1 tab po", "dizziness", "404640003"],
      ["when nauseous take 1 tab po", "nausea", "422587007"],
      ["when feverish take 1 tab po", "fever", "386661006"],
      ["when เวียนหัว take 1 tab po", "เวียนหัว", "404640003"],
      ["when คลื่นไส้ take 1 tab po", "คลื่นไส้", "422587007"],
      ["when มีไข้ take 1 tab po", "มีไข้", "386661006"]
    ] as const;

    for (const [sig, reason, code] of cases) {
      const result = parseSig(sig, { context: TAB_CONTEXT });
      expect(result.meta.leftoverText).toBeUndefined();
      expect(result.fhir.asNeededFor?.[0]?.text).toBe(reason);
      expect(result.fhir.asNeededFor?.[0]?.coding?.[0]?.code).toBe(code);
    }
  });

  it("codes Thai eye-itch reasons through localized PRN aliases", () => {
    const result = parseSig("1 drop to eye prn คันตา", { locale: "th" });
    expect(result.fhir.asNeededFor?.[0]?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: "74776002",
      display: "Itching of eye"
    });
    expect(result.longText).toContain("คันตา");
  });

  it("upgrades generic itch reasons to lesion-specific coding when the parsed site is a lesion", () => {
    const result = parseSig("apply to lesion prn itch");
    expect(result.fhir.asNeededFor?.[0]?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: "445329008",
      display: "Itching of lesion of skin"
    });
  });

  it("codes lesion-specific itch reasons when the symptom text says lesion itch", () => {
    const result = parseSig("apply to lesion prn lesion itch");
    expect(result.fhir.asNeededFor?.[0]?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: "445329008",
      display: "Itching of lesion of skin"
    });
  });

  it("falls back to generic itching when wound itch has no cleaner pre-coordinated concept", () => {
    const result = parseSig("apply to wound prn wound itch");
    expect(result.fhir.asNeededFor?.[0]?.text).toBe("wound itch");
    expect(result.fhir.asNeededFor?.[0]?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: "418363000",
      display: "Itching of skin"
    });
  });

  it("splits coordinated PRN reasons into multiple coded asNeededFor concepts", () => {
    const result = parseSig("1 tab po prn pain or fever", { context: TAB_CONTEXT });

    expect(result.longText).toBe("Take 1 tablet orally as needed for pain or fever.");
    expect(result.fhir.asNeededFor).toEqual([
      {
        text: "pain",
        coding: [
          {
            system: "http://snomed.info/sct",
            code: "22253000",
            display: "Pain"
          }
        ]
      },
      {
        text: "fever",
        coding: [
          {
            system: "http://snomed.info/sct",
            code: "386661006",
            display: "Fever"
          }
        ]
      }
    ]);
    expect(result.meta.canonical.clauses[0]?.prn?.reason?.text).toBe("pain or fever");
    expect(result.meta.canonical.clauses[0]?.prn?.reasons).toEqual([
      expect.objectContaining({
        text: "pain",
        coding: expect.objectContaining({ code: "22253000" })
      }),
      expect.objectContaining({
        text: "fever",
        coding: expect.objectContaining({ code: "386661006" })
      })
    ]);
    expect(result.meta.normalized.prnReason).toEqual({
      text: "pain or fever",
      coding: undefined
    });
    expect(result.meta.normalized.prnReasons).toEqual([
      {
        text: "pain",
        coding: {
          system: "http://snomed.info/sct",
          code: "22253000",
          display: "Pain"
        }
      },
      {
        text: "fever",
        coding: {
          system: "http://snomed.info/sct",
          code: "386661006",
          display: "Fever"
        }
      }
    ]);
  });

  it("renders slash- and comma-coordinated PRN reasons naturally once split", () => {
    const slash = parseSig("1 tab po prn pain/fever", { context: TAB_CONTEXT });
    expect(slash.longText).toBe("Take 1 tablet orally as needed for pain or fever.");

    const comma = parseSig("1 tab po prn pain, fever", { context: TAB_CONTEXT });
    expect(comma.longText).toBe("Take 1 tablet orally as needed for pain or fever.");
  });

  it("splits partially known coordinated PRN reasons into separate concepts", () => {
    const result = parseSig("1 tab po prn mania or depression", { context: TAB_CONTEXT });

    expect(result.longText).toBe("Take 1 tablet orally as needed for mania or depression.");
    expect(result.fhir.asNeededFor).toEqual([
      {
        text: "mania",
        coding: [
          {
            system: "http://snomed.info/sct",
            code: "231494001",
            display: "Mania"
          }
        ]
      },
      { text: "depression" }
    ]);
    expect(result.meta.canonical.clauses[0]?.prn?.reason?.text).toBe("mania or depression");
    expect(result.meta.canonical.clauses[0]?.prn?.reasons).toMatchObject([
      {
        text: "mania",
        coding: {
          system: "http://snomed.info/sct",
          code: "231494001",
          display: "Mania"
        }
      },
      { text: "depression" }
    ]);
  });

  it("splits fully unknown coordinated PRN reasons into separate text-only concepts", () => {
    const result = parseSig("1 tab po prn intrusive thoughts or unable to work", {
      context: TAB_CONTEXT
    });

    expect(result.longText).toBe(
      "Take 1 tablet orally as needed for intrusive thoughts or unable to work."
    );
    expect(result.fhir.asNeededFor).toEqual([
      { text: "intrusive thoughts" },
      { text: "unable to work" }
    ]);
    expect(result.meta.canonical.clauses[0]?.prn?.reasons).toEqual([
      { text: "intrusive thoughts", coding: undefined },
      { text: "unable to work", coding: undefined }
    ]);
  });

  it("codes expanded ambulatory PRN reasons across specialties", () => {
    const cases = [
      ["1 tab po prn headache", "25064002"],
      ["1 tab po prn diarrhea", "62315008"],
      ["1 tab po prn nasal congestion", "68235000"],
      ["1 drop ou prn red eye", "703630003"],
      ["1 tab po prn dysuria", "49650001"],
      ["1 tab po prn panic attack", "225624000"],
      ["apply prn acne", "88616000"],
      ["apply prn hives", "126485001"],
      ["1 tab po prn hemorrhoid", "70153002"],
      ["insert 1 supp pr prn hemorrhoids", "70153002"],
      ["1 tab po prn motion sickness", "37031009"],
      ["apply prn mouth ulcer", "26284000"]
    ] as const;

    for (const [sig, code] of cases) {
      const result = parseSig(sig, { context: TAB_CONTEXT });
      expect(result.fhir.asNeededFor?.[0]?.coding?.[0]?.code).toBe(code);
      expect(result.meta.canonical.clauses[0]?.prn?.reason?.coding?.code).toBe(code);
    }
  });

  it("maps anatomy-normalized variants for existing ambulatory PRN reasons", () => {
    const cases = [
      ["1 tab po prn abdomen pain", "21522001"],
      ["1 tab po prn pain at abdomen", "21522001"],
      ["1 tab po prn ulcer at mouth", "26284000"],
      ["1 tab po prn itching at scalp", "275921007"]
    ] as const;

    for (const [sig, code] of cases) {
      const result = parseSig(sig, { context: TAB_CONTEXT });
      expect(result.fhir.asNeededFor?.[0]?.coding?.[0]?.code).toBe(code);
      expect(result.meta.canonical.clauses[0]?.prn?.reason?.coding?.code).toBe(code);
    }
  });

  it("preserves locative PRN reason text across FHIR round-trips when using a generic symptom code", () => {
    const cases = [
      ["pain at hands", findingSiteCode("22253000", "85562004")],
      ["pain at buttock", findingSiteCode("22253000", "46862004")],
      ["pain at anus", findingSiteCode("22253000", "181262009")]
    ] as const;

    for (const [reason, code] of cases) {
      const parsed = parseSig(`1 tab po prn ${reason}`, { context: TAB_CONTEXT });
      const roundTripped = fromFhirDosage(parsed.fhir);

      expect(parsed.fhir.asNeededFor?.[0]?.text).toBe(reason);
      expect(parsed.fhir.asNeededFor?.[0]?.coding?.[0]?.code).toBe(code);
      expect(roundTripped.fhir.asNeededFor?.[0]?.text).toBe(reason);
      expect(roundTripped.meta.normalized.prnReason?.text).toBe(reason);
      expect(roundTripped.longText).toBe(`Take 1 tablet orally as needed for ${reason}.`);
    }
  });

  it("codes normalized topical itchiness sites and preserves the full PRN text", () => {
    const cases = [
      {
        sig: "apply to back of hand prn itchiness",
        siteText: "back of hand",
        siteCode: "731077003",
        prnCode: findingSiteCode("418363000", "731077003"),
        longText: "Apply the medication as needed for itchiness to the back of the hand."
      },
      {
        sig: "apply to back of head prn itchiness",
        siteText: "back of head",
        siteCode: "182322006",
        prnCode: findingSiteCode("418363000", "182322006"),
        longText: "Apply the medication as needed for itchiness to the back of the head."
      },
      {
        sig: "apply to palm prn itchiness",
        siteText: "palm",
        siteCode: "731973001",
        prnCode: findingSiteCode("418363000", "731973001"),
        longText: "Apply the medication as needed for itchiness to the palm."
      }
    ] as const;

    for (const { sig, siteText, siteCode, prnCode, longText } of cases) {
      const result = parseSig(sig);
      expect(result.longText).toBe(longText);
      expect(result.fhir.site?.text).toBe(siteText);
      expect(result.fhir.site?.coding?.[0]?.code).toBe(siteCode);
      expect(result.fhir.asNeededFor?.[0]?.text).toBe(sig.replace(/^apply to .+ prn /, ""));
      expect(result.fhir.asNeededFor?.[0]?.coding?.[0]?.code).toBe(prnCode);
    }
  });

  it("accepts Thai aliases for expanded ambulatory PRN reasons", () => {
    const cases = [
      ["1 tab po prn ปวดหัว", "25064002", "ปวดศีรษะ"],
      ["1 tab po prn คัดจมูก", "68235000", "คัดจมูก"],
      ["1 drop ou prn ตาแดง", "703630003", "ตาแดง"],
      ["1 tab po prn แสบขัด", "49650001", "แสบขัดเวลาปัสสาวะ"],
      ["apply prn สิว", "88616000", "สิว"],
      ["1 tab po prn เมารถ", "37031009", "เมารถหรือเมาเรือ"]
    ] as const;

    for (const [sig, code, localizedReason] of cases) {
      const result = parseSig(sig, { context: TAB_CONTEXT, locale: "th" });
      expect(result.fhir.asNeededFor?.[0]?.coding?.[0]?.code).toBe(code);
      expect(result.longText.includes(localizedReason)).toBe(true);
    }
  });

  it("splits Thai coordinated PRN reasons on หรือ into separate text-only concepts", () => {
    const result = parseSig("1 tab po prn คิดฟุ้งซ่าน หรือ ทำงานไม่ได้", {
      context: TAB_CONTEXT,
      locale: "th"
    });

    expect(result.longText).toBe(
      "รับประทาน ครั้งละ 1 เม็ด ใช้เมื่อจำเป็นสำหรับ คิดฟุ้งซ่าน หรือ ทำงานไม่ได้."
    );
    expect(result.fhir.asNeededFor).toEqual([
      { text: "คิดฟุ้งซ่าน" },
      { text: "ทำงานไม่ได้" }
    ]);
    expect(result.meta.canonical.clauses[0]?.prn?.reasons).toEqual([
      { text: "คิดฟุ้งซ่าน", coding: undefined },
      { text: "ทำงานไม่ได้", coding: undefined }
    ]);
  });

  it("localizes coordinated coded PRN reasons to Thai from split reasons", () => {
    const result = parseSig("1 tab po prn pain or fever", {
      context: TAB_CONTEXT,
      locale: "th"
    });

    expect(result.longText).toBe("รับประทาน ครั้งละ 1 เม็ด ใช้เมื่อจำเป็นสำหรับ ปวด หรือ ไข้.");
    expect(result.fhir.asNeededFor).toEqual([
      {
        text: "pain",
        coding: [
          {
            system: "http://snomed.info/sct",
            code: "22253000",
            display: "Pain"
          }
        ]
      },
      {
        text: "fever",
        coding: [
          {
            system: "http://snomed.info/sct",
            code: "386661006",
            display: "Fever"
          }
        ]
      }
    ]);
  });

  it("parses 1x2 subcutaneous", () => {
    const result = parseSig("1x2 subcutaneous");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1 });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("BID");
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 2,
      period: 1,
      periodUnit: "d"
    });
    expect(result.fhir.route?.text).toBe("subcutaneous");
    expect(result.fhir.route?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: SNOMEDCTRouteCodes["Subcutaneous route"],
      display: "Subcutaneous route"
    });
  });

  it("parses q12h", () => {
    const result = parseSig("q12h");
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("Q12H");
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 12, periodUnit: "h" });
  });

  it("parses q6-8h interval shorthand", () => {
    const result = parseSig("q6-8h");
    expect(result.fhir.timing?.repeat).toMatchObject({
      period: 6,
      periodMax: 8,
      periodUnit: "h"
    });
  });

  it("parses separated q 2 wk", () => {
    const result = parseSig("q 2 wk");
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 2, periodUnit: "wk" });
  });

  it("parses q wk", () => {
    const result = parseSig("q wk");
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 1, periodUnit: "wk" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("WK");
  });

  it("parses q 2 d", () => {
    const result = parseSig("q 2 d");
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 2, periodUnit: "d" });
  });

  it("parses weekly friday", () => {
    const result = parseSig("weekly friday");
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("WK");
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 1, periodUnit: "wk", dayOfWeek: ["fri"] });
  });

  it("parses 1xweekly tuesday", () => {
    const result = parseSig("1xweekly tuesday", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 1, periodUnit: "wk", dayOfWeek: ["tue"] });
  });

  it("parses 1*weekly wednesday", () => {
    const result = parseSig("1*weekly wednesday", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("WK");
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 1, periodUnit: "wk", dayOfWeek: ["wed"] });
    expect(result.longText).toContain("once weekly on Wednesday");
  });

  it("parses every X days with multiple times", () => {
    const result = parseSig("every 2 days at 9:00, 12:00, 18:00");
    expect(result.fhir.timing?.repeat).toMatchObject({
      period: 2,
      periodUnit: "d",
      timeOfDay: ["09:00:00", "12:00:00", "18:00:00"]
    });
    expect(result.meta.leftoverText).toBeUndefined();
  });

  it("parses q X days with multiple anchors", () => {
    const result = parseSig("q 3 days before lunch");
    expect(result.fhir.timing?.repeat).toMatchObject({
      period: 3,
      periodUnit: "d",
      when: [EventTiming["Before Lunch"]]
    });
    expect(result.meta.leftoverText).toBeUndefined();
  });

  it("parses multi-anchor intervals with connectors", () => {
    const result = parseSig("2 tabs q 2 days at morning, dinner", { context: TAB_CONTEXT });
    expect(result.fhir.timing?.repeat).toMatchObject({
      period: 2,
      periodUnit: "d",
      when: ["MORN", "CV"]
    });
    expect(result.meta.leftoverText).toBeUndefined();
  });

  it("parses weekly with on connector", () => {
    const result = parseSig("weekly on Monday and Friday");
    expect(result.fhir.timing?.repeat).toMatchObject({
      period: 1,
      periodUnit: "wk",
      dayOfWeek: ["mon", "fri"]
    });
    expect(result.meta.leftoverText).toBeUndefined();
  });

  it("parses weekday ranges written as mon-fri", () => {
    const cases = [
      "1 tab po once daily mon-fri",
      "1 tab po once daily mon - fri",
      "1 tab po once daily mon to fri"
    ];
    for (const input of cases) {
      const result = parseSig(input, { context: TAB_CONTEXT });
      expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
      expect(result.fhir.timing?.repeat).toMatchObject({
        frequency: 1,
        period: 1,
        periodUnit: "d",
        dayOfWeek: ["mon", "tue", "wed", "thu", "fri"]
      });
      expect(result.meta.leftoverText).toBeUndefined();
    }
  });

  it("parses arbitrary day-to-day ranges including wrap-around", () => {
    const tuesdayToThursday = parseSig("1 tab po once daily tuesday to thursday", { context: TAB_CONTEXT });
    expect(tuesdayToThursday.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d",
      dayOfWeek: ["tue", "wed", "thu"]
    });
    expect(tuesdayToThursday.meta.leftoverText).toBeUndefined();

    const fridayToMonday = parseSig("1 tab po once daily fri to mon", { context: TAB_CONTEXT });
    expect(fridayToMonday.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d",
      dayOfWeek: ["fri", "sat", "sun", "mon"]
    });
    expect(fridayToMonday.meta.leftoverText).toBeUndefined();
  });

  it("parses weekend expressions", () => {
    const cases = [
      "1.5 tabs po once daily on weekends",
      "1.5 tabs po once daily sat-sun",
      "1.5 tabs po once daily weekend"
    ];
    for (const input of cases) {
      const result = parseSig(input, { context: TAB_CONTEXT });
      expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1.5, unit: "tab" });
      expect(result.fhir.timing?.repeat).toMatchObject({
        frequency: 1,
        period: 1,
        periodUnit: "d",
        dayOfWeek: ["sat", "sun"]
      });
      expect(result.meta.leftoverText).toBeUndefined();
    }
  });

  it("parses Thai weekday and weekend variants", () => {
    const weekdayCases = [
      "1 tab po once daily จ-ศ",
      "1 tab po once daily จัน-ศุก",
      "1 tab po once daily จันทร์-ศุกร์",
      "1 tab po once daily วันธรรมดา",
      "1 tab po once daily จันทร์ถึงศุกร์"
    ];
    for (const input of weekdayCases) {
      const result = parseSig(input, { context: TAB_CONTEXT });
      expect(result.fhir.timing?.repeat).toMatchObject({
        frequency: 1,
        period: 1,
        periodUnit: "d",
        dayOfWeek: ["mon", "tue", "wed", "thu", "fri"]
      });
      expect(result.meta.leftoverText).toBeUndefined();
    }

    const thaiRangeCases = [
      "1 tab po once daily อังคาร ถึง พฤหัสบดี",
      "1 tab po once daily อังคารถึงพฤหัสบดี",
      "1 tab po once daily เสาร์ถึงอังคาร"
    ];
    const expectedRanges = [
      ["tue", "wed", "thu"],
      ["tue", "wed", "thu"],
      ["sat", "sun", "mon", "tue"]
    ];
    for (let i = 0; i < thaiRangeCases.length; i += 1) {
      const result = parseSig(thaiRangeCases[i], { context: TAB_CONTEXT });
      expect(result.fhir.timing?.repeat).toMatchObject({
        frequency: 1,
        period: 1,
        periodUnit: "d",
        dayOfWeek: expectedRanges[i]
      });
      expect(result.meta.leftoverText).toBeUndefined();
    }

    const weekendCases = [
      "1.5 tabs po once daily เสา-อา",
      "1.5 tabs po once daily เสา อา",
      "1.5 tabs po once daily เสาร์ อาทิตย์",
      "1.5 tabs po once daily สุดสัปดาห์",
      "1.5 tabs po once daily วันหยุด"
    ];
    for (const input of weekendCases) {
      const result = parseSig(input, { context: TAB_CONTEXT });
      expect(result.fhir.timing?.repeat).toMatchObject({
        frequency: 1,
        period: 1,
        periodUnit: "d",
        dayOfWeek: ["sat", "sun"]
      });
      expect(result.meta.leftoverText).toBeUndefined();
    }
  });

  it("supports methimazole-style split daily doses by weekday vs weekend", () => {
    const result = parseSig(
      "1 tab po once daily mon-fri, 1.5 tabs po once daily on weekends",
      { context: TAB_CONTEXT }
    );
    expect(result.count).toBe(2);
    expect(result.items[0].fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(result.items[0].fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d",
      dayOfWeek: ["mon", "tue", "wed", "thu", "fri"]
    });
    expect(result.items[1].fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1.5, unit: "tab" });
    expect(result.items[1].fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d",
      dayOfWeek: ["sat", "sun"]
    });
  });

  it("supports methimazole-style split doses with Thai day ranges", () => {
    const result = parseSig(
      "1 tab po once daily จ-ศ, 1.5 tabs po once daily เสา-อา",
      { context: TAB_CONTEXT }
    );
    expect(result.count).toBe(2);
    expect(result.items[0].fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(result.items[0].fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d",
      dayOfWeek: ["mon", "tue", "wed", "thu", "fri"]
    });
    expect(result.items[1].fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1.5, unit: "tab" });
    expect(result.items[1].fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d",
      dayOfWeek: ["sat", "sun"]
    });
  });

  it("parses q1mo", () => {
    const result = parseSig("q1mo");
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("MO");
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 1, periodUnit: "mo" });
  });

  it("parses separated q 2 mo", () => {
    const result = parseSig("q 2 mo");
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 2, periodUnit: "mo" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("Q2MO");
  });

  it("parses monthly token", () => {
    const result = parseSig("monthly");
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("MO");
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 1, periodUnit: "mo" });
  });

  it("maps AM to EventTiming", () => {
    const result = parseSig("1 po am", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("AM");
    expect(result.fhir.timing?.repeat?.when).toEqual(["MORN"]);
  });

  it("maps NOON", () => {
    const result = parseSig("1 po noon", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.repeat?.when).toEqual(["NOON"]);
  });

  it("maps PM", () => {
    const result = parseSig("1 po pm", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("PM");
    expect(result.fhir.timing?.repeat?.when).toEqual(["EVE"]);
  });

  it("maps HS", () => {
    const result = parseSig("1xHS", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.repeat?.when).toEqual(["HS"]);
  });

  it("maps STAT to immediate timing", () => {
    const result = parseSig("1 tab po stat", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.repeat?.when).toEqual([EventTiming.Immediate]);
  });

  it("maps early morning combo", () => {
    const result = parseSig("1 tab early morning", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.repeat?.when).toEqual([EventTiming["Early Morning"]]);
  });

  it("maps upon waking", () => {
    const result = parseSig("upon waking");
    expect(result.fhir.timing?.repeat?.when).toEqual([EventTiming.Wake]);
  });

  it("parses q1w via compact token", () => {
    const result = parseSig("q1w");
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 1, periodUnit: "wk" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("WK");
  });

  it("maps WM", () => {
    const result = parseSig("wm");
    expect(result.fhir.timing?.repeat?.when).toEqual(["C"]);
  });

  it("maps standalone breakfast tokens", () => {
    const result = parseSig("brkfst");
    expect(result.fhir.timing?.repeat?.when).toEqual([EventTiming.Breakfast]);
  });

  it("maps standalone lunch tokens", () => {
    const result = parseSig("lunchtime");
    expect(result.fhir.timing?.repeat?.when).toEqual([EventTiming.Lunch]);
  });

  it("maps standalone dinner tokens", () => {
    const result = parseSig("suppertime");
    expect(result.fhir.timing?.repeat?.when).toEqual([EventTiming.Dinner]);
  });

  it("maps midday synonym", () => {
    const result = parseSig("midday");
    expect(result.fhir.timing?.repeat?.when).toEqual([EventTiming.Noon]);
  });

  it("maps afternoon", () => {
    const result = parseSig("afternoon");
    expect(result.fhir.timing?.repeat?.when).toEqual([EventTiming.Afternoon]);
  });

  it("maps pc breakfast", () => {
    const result = parseSig("pc breakfast");
    expect(result.fhir.timing?.repeat?.when).toEqual(["PCM"]);
  });

  it("maps ac dinner", () => {
    const result = parseSig("ac dinner");
    expect(result.fhir.timing?.repeat?.when).toEqual(["ACV"]);
  });

  it("maps pc suppertime", () => {
    const result = parseSig("pc suppertime");
    expect(result.fhir.timing?.repeat?.when).toEqual([EventTiming["After Dinner"]]);
  });

  it("applies pc context across multiple meals", () => {
    const result = parseSig("pc breakfast lunch dinner hs");
    expect(result.fhir.timing?.repeat?.when).toEqual([
      EventTiming["After Breakfast"],
      EventTiming["After Lunch"],
      EventTiming["After Dinner"],
      EventTiming["Before Sleep"],
    ]);
  });

  it("maps ac dinnertime", () => {
    const result = parseSig("ac dinnertime");
    expect(result.fhir.timing?.repeat?.when).toEqual([EventTiming["Before Dinner"]]);
  });

  it("converts standalone meal names when ac appears elsewhere", () => {
    const result = parseSig("breakfast lunch ac");
    expect(result.fhir.timing?.repeat?.when).toEqual([
      EventTiming["Before Breakfast"],
      EventTiming["Before Lunch"],
    ]);
  });

  it("converts standalone meal names when pc appears elsewhere", () => {
    const result = parseSig("pc and dinner");
    expect(result.fhir.timing?.repeat?.when).toEqual([
      EventTiming["After Dinner"],
    ]);
  });

  it("warns for qd", () => {
    const result = parseSig("1 po qd");
    expect(result.warnings[0]).toContain("QD");
  });

  it("warns for qod", () => {
    const result = parseSig("1 po qod");
    expect(result.warnings[0]).toContain("QOD");
  });

  it("warns for bld", () => {
    const result = parseSig("1 po bld");
    expect(result.warnings[0]).toContain("BLD");
    expect(result.fhir.timing?.repeat?.when).toEqual(["C"]);
  });

  it("warns for ad alternate days", () => {
    const result = parseSig("1 po ad");
    expect(result.warnings[0]).toContain("AD");
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 2, periodUnit: "d" });
  });

  it("infers unit from context", () => {
    const result = parseSig("1", { context: { dosageForm: "tab" } });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
  });

  it("uses container unit from context", () => {
    const result = parseSig("2", {
      context: { dosageForm: "sol", containerUnit: "mL" }
    });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 2, unit: "mL" });
  });

  it("normalizes complex dosage forms from context", () => {
    const result = parseSig("1", { context: { dosageForm: "capsule, soft" } });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "cap" });
  });

  it("normalizes transdermal dosage forms", () => {
    const result = parseSig("1", { context: { dosageForm: "transdermal patch" } });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "patch" });
  });

  it("parses patch td daily", () => {
    const result = parseSig("1 patch td daily");
    expect(result.fhir.route?.text).toBe("transdermal");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(
      SNOMEDCTRouteCodes["Transdermal route"]
    );
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity?.unit).toBe("patch");
    expect(result.fhir.timing?.repeat).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
  });

  it("recognizes per rectum phrasing", () => {
    const result = parseSig("per rectum qd");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(
      SNOMEDCTRouteCodes["Per rectum"]
    );
    expect(result.fhir.route?.text).toBe(
      ROUTE_TEXT[SNOMEDCTRouteCodes["Per rectum"] as RouteCode]
    );
  });

  it("recognizes intravenous route text", () => {
    const result = parseSig("intravenous route q6h");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(
      SNOMEDCTRouteCodes["Intravenous route"]
    );
  });

  it("recognizes iv bolus synonyms", () => {
    const result = parseSig("iv bolus stat");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(
      SNOMEDCTRouteCodes["Intravenous route"]
    );
    expect(result.fhir.timing?.repeat?.when).toEqual([EventTiming.Immediate]);
  });

  it("captures site text", () => {
    const result = parseSig("1 mL IM left arm");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "mL" });
    expect(result.fhir.site?.text).toBe("left arm");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(
      SNOMEDCTRouteCodes["Intramuscular route"]
    );
  });

  it("keeps text-only body sites when coding unknown", () => {
    const result = parseSig("1 mL to larynx daily");
    expect(result.fhir.site?.text).toBe("larynx");
    expect(result.fhir.site?.coding).toBeUndefined();
    expect(result.meta.normalized.site).toEqual({ text: "larynx", coding: undefined });
  });

  it("codes recognized body sites with SNOMED", () => {
    const result = parseSig("apply cream to face daily");
    expect(result.fhir.site?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: "89545001",
      display: "Face"
    });
    expect(result.meta.normalized.site?.coding).toEqual({
      system: "http://snomed.info/sct",
      code: "89545001",
      display: "Face"
    });
  });

  it("provides lookup suggestions for probe syntax", () => {
    const input = "apply to {left arm} twice daily";
    const result = parseSig(input);
    const lookup = result.meta.siteLookups?.[0];
    expect(result.fhir.site?.text).toBe("left arm");
    expect(lookup?.request).toMatchObject({
      text: "left arm",
      isProbe: true,
      inputText: input,
      sourceText: "left arm"
    });
    expect(lookup?.request.range).toEqual({
      start: input.toLowerCase().indexOf("left arm"),
      end: input.toLowerCase().indexOf("left arm") + "left arm".length
    });
    const suggestionCodes = lookup?.suggestions.map((suggestion) => suggestion.coding.code);
    expect(suggestionCodes).toContain("368208006");
  });

  it("codes additional anatomy like penis with SNOMED", () => {
    const result = parseSig("apply ointment to penis daily");
    expect(result.fhir.site?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: "18911002",
      display: "Penis structure"
    });
  });

  it("codes common ambulatory musculoskeletal sites with SNOMED", () => {
    const cases = [
      {
        sig: "apply gel to left shoulder bid",
        expected: { code: "91775009", display: "Left shoulder", text: "left shoulder" }
      },
      {
        sig: "apply gel to right knee bid",
        expected: { code: "6757004", display: "Right knee", text: "right knee" }
      },
      {
        sig: "apply gel to both ankles bid",
        expected: { code: "69948000", display: "Both ankles", text: "both ankles" }
      }
    ];

    for (const { sig, expected } of cases) {
      const result = parseSig(sig);
      expect(result.fhir.site?.text).toBe(expected.text);
      expect(result.fhir.site?.coding?.[0]).toEqual({
        system: "http://snomed.info/sct",
        code: expected.code,
        display: expected.display
      });
    }
  });

  it("codes common clinic skin and breast application sites with SNOMED", () => {
    const cases = [
      {
        sig: "apply cream to groin daily",
        expected: { code: "26893007", display: "Inguinal region structure", text: "groin" }
      },
      {
        sig: "apply patch to left breast daily",
        expected: { code: "80248007", display: "Left breast", text: "left breast" }
      },
      {
        sig: "apply deodorant to axilla daily",
        expected: { code: "34797008", display: "Axilla structure", text: "axilla" }
      }
    ];

    for (const { sig, expected } of cases) {
      const result = parseSig(sig);
      expect(result.fhir.site?.text).toBe(expected.text);
      expect(result.fhir.site?.coding?.[0]).toEqual({
        system: "http://snomed.info/sct",
        code: expected.code,
        display: expected.display
      });
    }
  });

  it("codes lip and eyelid anatomy with SNOMED", () => {
    const lip = parseSig("apply ointment to lip daily");
    expect(lip.fhir.site?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: "48477009",
      display: "Lip structure"
    });

    const eyelid = parseSig("apply ointment to eyelid daily");
    expect(eyelid.fhir.site?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: "80243003",
      display: "Eyelid"
    });
  });

  it("derives topical route from body-site definitions without separate regex maintenance", () => {
    const result = parseSig("apply ointment to axilla daily");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Topical route"]);
    expect(result.fhir.site?.coding?.[0]?.code).toBe("34797008");
  });

  it("supports generic affected-area application as uncoded site text", () => {
    const result = parseSig("apply to affected area bid", { locale: "th" });
    expect(result.fhir.site?.text).toBe("affected area");
    expect(result.fhir.site?.coding).toBeUndefined();
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Topical route"]);
    expect(result.longText).toContain("บริเวณที่เป็น");
  });

  it("normalizes affected areas to the built-in affected area site", () => {
    const result = parseSig("apply to affected areas bid");
    expect(result.fhir.site?.text).toBe("affected area");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Topical route"]);
  });

  it("does not let generic abdomen site hints override topical application context", () => {
    const result = parseSig("apply to abdomen bid");
    expect(result.fhir.site?.text).toBe("abdomen");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Topical route"]);
  });

  it("keeps default ocular route hints when a custom site map entry omits routeHint", () => {
    const result = parseSig("1 drop to eye bid", {
      siteCodeMap: {
        eye: {
          coding: {
            code: "custom-eye",
            display: "Custom eye",
            system: "http://example.org/site"
          }
        }
      }
    });
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Ophthalmic route"]);
    expect(result.fhir.site?.coding?.[0]).toEqual({
      system: "http://example.org/site",
      code: "custom-eye",
      display: "Custom eye"
    });
  });

  it("codes head with bundled SNOMED anatomy", () => {
    const result = parseSig("apply to head bid");
    expect(result.fhir.site?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: "69536005",
      display: "Head structure"
    });
  });

  it("codes temple variants with bundled SNOMED anatomy", () => {
    const cases = [
      {
        sig: "apply to temple nightly",
        expected: { code: "450721000", display: "Temple region structure", text: "temple" }
      },
      {
        sig: "apply to left temple nightly",
        expected: { code: "1373280005", display: "Left temple region", text: "left temple" }
      },
      {
        sig: "apply to right temple nightly",
        expected: { code: "1373281009", display: "Right temple region", text: "right temple" }
      },
      {
        sig: "apply to both temples nightly",
        expected: { code: "362620003", display: "Entire temporal region", text: "both temples" }
      }
    ];

    for (const { sig, expected } of cases) {
      const result = parseSig(sig);
      expect(result.fhir.site?.text).toBe(expected.text);
      expect(result.fhir.site?.coding?.[0]).toEqual({
        system: "http://snomed.info/sct",
        code: expected.code,
        display: expected.display
      });
    }
  });

  it("normalizes coded ear and surface sub-sites instead of keeping raw interior text", () => {
    const cases = [
      {
        sig: "apply inside ear",
        site: { text: "ear", code: "117590005", display: "Ear-related structure" },
        longText: "Apply the medication in the ear."
      },
      {
        sig: "apply inside ear canal",
        site: { text: "ear canal", code: "181178004", display: "Entire external auditory canal" },
        longText: "Apply the medication in the ear canal."
      },
      {
        sig: "apply to palms",
        site: { text: "both palms", code: "731973001", display: "Entire palm (region)" },
        longText: "Apply the medication to both palms."
      },
      {
        sig: "apply to sole",
        site: { text: "sole of foot", code: "731075006", display: "Entire sole of foot" },
        longText: "Apply the medication to the sole of the foot."
      },
      {
        sig: "apply to heel",
        site: { text: "heel", code: "362804005", display: "Entire heel" },
        longText: "Apply the medication to the heel."
      },
      {
        sig: "apply to back of foot",
        site: { text: "back of foot", code: "731036002", display: "Entire dorsum of foot" },
        longText: "Apply the medication to the back of the foot."
      },
      {
        sig: "apply to back of hand",
        site: { text: "back of hand", code: "731077003", display: "Entire dorsum of hand" },
        longText: "Apply the medication to the back of the hand."
      },
      {
        sig: "apply to back of head",
        site: { text: "back of head", code: "182322006", display: "Entire back of head" },
        longText: "Apply the medication to the back of the head."
      },
      {
        sig: "apply to palm",
        site: { text: "palm", code: "731973001", display: "Entire palm (region)" },
        longText: "Apply the medication to the palm."
      }
    ] as const;

    for (const { sig, site, longText } of cases) {
      const result = parseSig(sig);
      expect(result.longText).toBe(longText);
      expect(result.fhir.site?.text).toBe(site.text);
      expect(result.fhir.site?.coding?.[0]).toEqual({
        system: "http://snomed.info/sct",
        code: site.code,
        display: site.display
      });
    }
  });

  it("uses otic route grammar instead of generic via-otic wording", () => {
    const result = parseSig("1 drop right ear once daily");
    expect(result.longText).toBe("Instill 1 drop once daily in the right ear.");
  });

  it("preserves unresolved topical site phrases and defaults them to topical route", () => {
    const cases = [
      { sig: "apply cream to left flank bid", site: "left flank" },
      { sig: "apply cream to right flank bid", site: "right flank" },
      { sig: "apply cream to top of head bid", site: "top of head" },
      { sig: "apply below ear bid", site: "below ear" },
      { sig: "apply under ear bid", site: "under ear" },
      { sig: "apply above ear bid", site: "above ear" },
      { sig: "apply at left side of hand bid", site: "left side of hand" },
      { sig: "apply to right side of abdomen bid", site: "right side of abdomen" },
      { sig: "apply between fingers", site: "between fingers" },
      { sig: "apply ระหว่างนิ้ว", site: "between fingers" },
      { sig: "apply ระหว่างนิ้วมือ", site: "between fingers" },
      { sig: "apply ระหว่างนิ้วเท้า", site: "between toes" },
      { sig: "apply to หัว", site: "head" },
      { sig: "apply ที่หนังศีรษะ", site: "scalp" },
      { sig: "apply to area between fingers", site: "area between fingers" }
    ];

    for (const { sig, site } of cases) {
      const result = parseSig(sig);
      expect(result.fhir.site?.text).toBe(site);
      expect(result.fhir.route?.coding?.[0]?.code).toBe(
        SNOMEDCTRouteCodes["Topical route"]
      );
    }
  });

  it("recognizes Thai body-site aliases for paired anatomy and named digits", () => {
    const cases = [
      { sig: "apply to ตา", site: "eye", code: "81745001", display: "Eye", route: SNOMEDCTRouteCodes["Ophthalmic route"] },
      { sig: "apply to ตาซ้าย", site: "left eye", code: "1290031003", display: "Structure of left eye proper", route: SNOMEDCTRouteCodes["Ophthalmic route"] },
      { sig: "apply to ตาขวา", site: "right eye", code: "1290032005", display: "Structure of right eye proper", route: SNOMEDCTRouteCodes["Ophthalmic route"] },
      { sig: "apply to ตาสองข้าง", site: "both eyes", code: "40638003", display: "Structure of both eyes", route: SNOMEDCTRouteCodes["Ophthalmic route"] },
      { sig: "apply to หูซ้าย", site: "left ear", code: "89644007", display: "Left ear", route: SNOMEDCTRouteCodes["Otic route"] },
      { sig: "apply to หูขวา", site: "right ear", code: "25577004", display: "Right ear", route: SNOMEDCTRouteCodes["Otic route"] },
      { sig: "apply to หูสองข้าง", site: "both ears", code: "34338003", display: "Both ears", route: SNOMEDCTRouteCodes["Otic route"] },
      { sig: "apply to แขน", site: "arm", code: "302538001", display: "Entire upper arm", route: SNOMEDCTRouteCodes["Topical route"] },
      { sig: "apply to ขา", site: "leg", code: "362793004", display: "Entire lower leg, from knee to ankle", route: SNOMEDCTRouteCodes["Topical route"] },
      { sig: "apply to เท้าซ้าย", site: "left foot", code: "22335008", display: "Left foot", route: SNOMEDCTRouteCodes["Topical route"] },
      { sig: "apply to เท้าขวา", site: "right foot", code: "7769000", display: "Right foot", route: SNOMEDCTRouteCodes["Topical route"] },
      { sig: "apply to คอ", site: "neck", code: "45048000", display: "Neck", route: SNOMEDCTRouteCodes["Topical route"] },
      { sig: "apply to อัณฑะ", site: "testis", code: "40689003", display: "Testis", route: SNOMEDCTRouteCodes["Topical route"] },
      { sig: "apply to นิ้วโป้ง", site: "thumb", code: "76505004", display: "Thumb", route: SNOMEDCTRouteCodes["Topical route"] },
      { sig: "apply to นิ้วชี้มือ", site: "index finger", code: "83738005", display: "Index finger", route: SNOMEDCTRouteCodes["Topical route"] },
      { sig: "apply to นิ้วกลางมือ", site: "middle finger", code: "65531009", display: "Middle finger", route: SNOMEDCTRouteCodes["Topical route"] },
      { sig: "apply to นิ้วนางมือ", site: "ring finger", code: "82002001", display: "Ring finger", route: SNOMEDCTRouteCodes["Topical route"] },
      { sig: "apply to นิ้วก้อยมือ", site: "little finger", code: "12406000", display: "Little finger", route: SNOMEDCTRouteCodes["Topical route"] },
      { sig: "apply to big toe", site: "great toe", code: "78883009", display: "Great toe", route: SNOMEDCTRouteCodes["Topical route"] },
      { sig: "apply to 2nd toe", site: "second toe", code: "55078004", display: "Second toe", route: SNOMEDCTRouteCodes["Topical route"] },
      { sig: "apply to right big toe", site: "right great toe", code: lateralizedSiteCode("78883009", "24028007"), display: "right great toe", route: SNOMEDCTRouteCodes["Topical route"] },
      { sig: "apply to left thumb", site: "left thumb", code: lateralizedSiteCode("76505004", "7771000"), display: "left thumb", route: SNOMEDCTRouteCodes["Topical route"] },
      { sig: "apply to นิ้วโป้งขวา", site: "right thumb", code: lateralizedSiteCode("76505004", "24028007"), display: "right thumb", route: SNOMEDCTRouteCodes["Topical route"] },
      { sig: "apply to นิ้วก้อยเท้าซ้าย", site: "left fifth toe", code: lateralizedSiteCode("39915008", "7771000"), display: "left fifth toe", route: SNOMEDCTRouteCodes["Topical route"] },
      { sig: "apply to นิ้วชี้เท้าสองข้าง", site: "both second toes", code: lateralizedSiteCode("55078004", "51440002"), display: "both second toes", route: SNOMEDCTRouteCodes["Topical route"] },
      { sig: "apply to นิ้วโป้งเท้า", site: "great toe", code: "78883009", display: "Great toe", route: SNOMEDCTRouteCodes["Topical route"] },
      { sig: "apply to นิ้วชี้เท้า", site: "second toe", code: "55078004", display: "Second toe", route: SNOMEDCTRouteCodes["Topical route"] },
      { sig: "apply to นิ้วกลางเท้า", site: "third toe", code: "78132007", display: "Third toe", route: SNOMEDCTRouteCodes["Topical route"] },
      { sig: "apply to นิ้วนางเท้า", site: "fourth toe", code: "80349001", display: "Fourth toe", route: SNOMEDCTRouteCodes["Topical route"] },
      { sig: "apply to นิ้วก้อยเท้า", site: "fifth toe", code: "39915008", display: "Fifth toe", route: SNOMEDCTRouteCodes["Topical route"] }
    ] as const;

    for (const { sig, site, code, display, route } of cases) {
      const result = parseSig(sig);
      expect(result.fhir.site?.text).toBe(site);
      expect(result.fhir.site?.coding?.[0]).toEqual({
        system: "http://snomed.info/sct",
        code,
        display
      });
      expect(result.fhir.route?.coding?.[0]?.code).toBe(route);
    }
  });

  it("localizes Thai body-site aliases through canonical site text", () => {
    const cases = [
      ["apply to ตาขวา", "ทา ที่ตาขวา."],
      ["apply to หูสองข้าง", "ทา ที่หูทั้งสองข้าง."],
      ["apply to นิ้วโป้งเท้า", "ทา บริเวณนิ้วโป้งเท้า."],
      ["apply to นิ้วก้อยเท้าซ้าย", "ทา บริเวณนิ้วก้อยเท้าซ้าย."],
      ["apply to อัณฑะ", "ทา บริเวณอัณฑะ."]
    ] as const;

    for (const [sig, text] of cases) {
      expect(parseSig(sig, { locale: "th" }).longText).toBe(text);
    }

    const fromCodeOnly = fromFhirDosage(
      {
        site: {
          coding: [
            {
              system: "http://snomed.info/sct",
              code: lateralizedSiteCode("78883009", "24028007")
            }
          ]
        }
      },
      { locale: "th" }
    );
    expect(fromCodeOnly.longText).toContain("นิ้วโป้งเท้าขวา");
  });

  it("does not infer instillation routes from external surface phrases", () => {
    const cases = [
      { sig: "apply to behind left ear bid", site: "behind left ear" },
      { sig: "apply cream around nostrils bid", site: "around nostrils" },
      { sig: "apply to around anus bid", site: "around anus" }
    ];

    for (const { sig, site } of cases) {
      const result = parseSig(sig);
      expect(result.fhir.site?.text).toBe(site);
      expect(result.fhir.route?.coding?.[0]?.code).toBe(
        SNOMEDCTRouteCodes["Topical route"]
      );
    }
  });

  it("formats unresolved locative site phrases as natural English noun phrases", () => {
    const cases = [
      ["apply to behind left ear bid", "Apply the medication twice daily behind the left ear."],
      ["apply cream to top of head bid", "Apply the medication twice daily to the top of the head."],
      ["apply below ear bid", "Apply the medication twice daily below the ear."],
      ["apply under ear bid", "Apply the medication twice daily under the ear."],
      ["apply above ear bid", "Apply the medication twice daily above the ear."],
      ["apply at left side of hand bid", "Apply the medication twice daily to the left side of the hand."],
      ["apply to both sides of neck bid", "Apply the medication twice daily to both sides of the neck."],
      ["apply between fingers", "Apply the medication between the fingers."],
      ["apply to area between fingers", "Apply the medication between the fingers."]
    ] as const;

    for (const [sig, longText] of cases) {
      const result = parseSig(sig);
      expect(result.longText).toBe(longText);
    }
  });

  it("emits structured spatial relation metadata for body-site relation phrases", () => {
    const result = parseSig("apply below ear bid");
    const relation = result.fhir.site?.extension?.find(
      (extension) => extension.url === BODY_SITE_SPATIAL_RELATION_EXTENSION_URL
    );

    expect(result.fhir.site?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: topographicalSiteCode("117590005", "351726001"),
      display: "below ear"
    });
    expect(result.meta.normalized.site?.coding).toEqual({
      system: "http://snomed.info/sct",
      code: topographicalSiteCode("117590005", "351726001"),
      display: "below ear"
    });
    expect(relation?.extension).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: "relation",
          valueCoding: expect.objectContaining({
            system: "http://snomed.info/sct",
            code: "351726001",
            display: "Beneath"
          })
        }),
        expect.objectContaining({
          url: "target",
          valueCodeableConcept: expect.objectContaining({
            text: "ear",
            coding: expect.arrayContaining([
              expect.objectContaining({
                system: "http://snomed.info/sct",
                code: "117590005",
                display: "Ear-related structure"
              })
            ])
          })
        })
      ])
    );
    expect(result.meta.normalized.site?.spatialRelation).toMatchObject({
      relationText: "below",
      targetText: "ear",
      targetCoding: { code: "117590005" }
    });

    const roundTripped = fromFhirDosage({
      ...result.fhir,
      site: { extension: result.fhir.site?.extension }
    });
    expect(roundTripped.longText).toBe("Apply the medication twice daily below the ear.");
    expect(roundTripped.meta.normalized.site?.spatialRelation?.targetCoding?.code).toBe("117590005");

    const side = parseSig("apply at left side of hand bid");
    expect(side.meta.normalized.site?.spatialRelation).toMatchObject({
      relationText: "left side",
      relationCoding: { code: "49370004" },
      targetText: "hand",
      targetCoding: { code: "85562004" }
    });
    expect(side.fhir.site?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: topographicalSiteCode("85562004", "49370004"),
      display: "left side of hand"
    });

    const between = parseSig("apply to area between fingers");
    expect(between.meta.normalized.site?.spatialRelation).toMatchObject({
      relationText: "between",
      targetText: "fingers",
      targetCoding: { code: "7569003" }
    });

    const topOfHead = parseSig("apply cream to top of head bid");
    expect(topOfHead.fhir.site?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: topographicalSiteCode("69536005", "261183002"),
      display: "top of head"
    });

    const directPrecoordinated = parseSig("apply to back of head");
    expect(directPrecoordinated.fhir.site?.coding?.[0]?.code).toBe("182322006");

    const forcedPostcoordinated = parseSig("apply to back of head", {
      bodySitePostcoordination: true
    });
    expect(forcedPostcoordinated.fhir.site?.coding?.[0]?.code).toBe(
      topographicalSiteCode("69536005", "255551008")
    );

    const disabled = parseSig("apply below ear bid", {
      bodySitePostcoordination: false
    });
    expect(disabled.fhir.site?.coding).toBeUndefined();
    expect(disabled.meta.normalized.site?.coding).toBeUndefined();
    expect(disabled.fhir.site?.extension?.[0]?.url).toBe(BODY_SITE_SPATIAL_RELATION_EXTENSION_URL);

    const imported = fromFhirDosage({
      site: {
        coding: [
          {
            system: "http://snomed.info/sct",
            code: topographicalSiteCode("69536005", "261183002")
          }
        ]
      }
    });
    expect(imported.meta.normalized.site?.text).toBe("top of head");
  });

  it("exposes body-site lookup and suggest helpers for UI search", () => {
    expect(getBodySiteCode("left ass")).toEqual({
      system: "http://snomed.info/sct",
      code: "723979003",
      display: "Structure of left buttock",
      i18n: undefined
    });
    expect(getBodySiteCode("top of head")).toEqual({
      system: "http://snomed.info/sct",
      code: topographicalSiteCode("69536005", "261183002"),
      display: "top of head"
    });
    expect(getBodySiteCode("top of head", { postcoordination: false })).toBeUndefined();
    expect(getBodySiteCode("right big toe")).toEqual({
      system: "http://snomed.info/sct",
      code: lateralizedSiteCode("78883009", "24028007"),
      display: "right great toe",
      i18n: undefined
    });
    expect(getBodySiteCode("นิ้วก้อยเท้าซ้าย")).toEqual({
      system: "http://snomed.info/sct",
      code: lateralizedSiteCode("39915008", "7771000"),
      display: "left fifth toe",
      i18n: undefined
    });
    expect(getBodySiteText("723979003")).toBe("left buttock");
    expect(getBodySiteText(findingSiteCode("22253000", "723979003"))).toBe("left buttock");
    expect(getBodySiteText(topographicalSiteCode("69536005", "261183002"))).toBe("top of head");
    expect(getBodySiteText(lateralizedSiteCode("78883009", "24028007"))).toBe("right great toe");
    expect(getBodySiteText(lateralizedSiteCode("56459004", "51440002"))).toBe("both feet");
    expect(
      getBodySiteText(findingSiteCode("22253000", "723979003"), {
        parsePostcoordination: false
      })
    ).toBeUndefined();
    expect(
      getBodySiteText(topographicalSiteCode("69536005", "261183002"), {
        postcoordination: false
      })
    ).toBeUndefined();

    const between = lookupBodySite("ระหว่างนิ้วมือ");
    expect(between).toMatchObject({
      text: "between fingers",
      canonical: "between fingers",
      spatialRelation: {
        relationText: "between",
        targetText: "fingers",
        targetCoding: { code: "7569003" }
      }
    });

    const contextualToes = lookupBodySite("ระหว่างนิ้ว", {
      bodySiteContext: "feet"
    });
    expect(contextualToes).toMatchObject({
      text: "between toes",
      spatialRelation: {
        relationText: "between",
        targetText: "toes",
        targetCoding: { code: "29707007" }
      }
    });

    const scalpSuggestions = suggestBodySites("หนัง", { limit: 3 });
    expect(scalpSuggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "scalp",
          coding: expect.objectContaining({ code: "41695006" })
        })
      ])
    );

    expect(suggestBodySiteText("นิ้วโป้ง", { limit: 3 })).toEqual(
      expect.arrayContaining(["thumb", "great toe"])
    );
    expect(listSupportedBodySiteText()).toEqual(
      expect.arrayContaining(["right great toe", "left thumb", "both second toes"])
    );
    expect(listSupportedBodySiteGrammar()).toMatchObject({
      siteAnchors: expect.arrayContaining(["to", "ที่", "between"]),
      locativeRelations: expect.arrayContaining(["above", "below", "between"]),
      partitiveHeads: expect.arrayContaining(["top", "side"]),
      partitiveModifiers: expect.arrayContaining(["left", "right"]),
      partitiveConnectors: expect.arrayContaining(["of"]),
      spatialRelationCodings: expect.objectContaining({
        below: expect.objectContaining({ code: "351726001" }),
        top: expect.objectContaining({ code: "261183002" })
      })
    });
  });

  it("allows custom sync and async body-site lookup helpers", async () => {
    const customMap = {
      "clinic site": {
        coding: {
          system: "http://example.org/sites",
          code: "CLINIC-SITE",
          display: "Clinic site"
        },
        text: "clinic site"
      }
    } as const;

    expect(getBodySiteCode("clinic site", { siteCodeMap: customMap })).toEqual({
      system: "http://example.org/sites",
      code: "CLINIC-SITE",
      display: "Clinic site",
      i18n: undefined
    });
    expect(getBodySiteText(
      { system: "http://example.org/sites", code: "CLINIC-SITE" },
      { siteCodeMap: customMap }
    )).toBe("clinic site");

    await expect(getBodySiteCodeAsync("remote site", {
      siteCodeResolvers: [async (request) => request.canonical === "remote site"
        ? {
          coding: {
            system: "http://example.org/sites",
            code: "REMOTE-SITE",
            display: "Remote site"
          },
          text: "remote site"
        }
        : undefined]
    })).resolves.toEqual({
      system: "http://example.org/sites",
      code: "REMOTE-SITE",
      display: "Remote site",
      i18n: undefined
    });

    await expect(getBodySiteTextAsync(
      { system: "http://example.org/sites", code: "REMOTE-SITE" },
      {
        siteTextResolvers: [async (request) =>
          request.originalCoding.code === "REMOTE-SITE" ? "remote site" : undefined]
      }
    )).resolves.toBe("remote site");
  });

  it("passes parsed spatial relation metadata to site terminology callbacks", () => {
    let request: SiteCodeLookupRequest | undefined;
    const result = parseSig("apply below custom scar bid", {
      siteCodeResolvers: [(candidate) => {
        request = candidate;
        return {
          text: candidate.text,
          coding: {
            system: "http://example.org/sites",
            code: "BELOW-SCAR",
            display: "Below custom scar"
          },
          spatialRelation: candidate.spatialRelation
            ? {
              ...candidate.spatialRelation,
              targetCoding: {
                system: "http://example.org/sites",
                code: "SCAR",
                display: "Custom scar"
              }
            }
            : undefined
        };
      }]
    });

    expect(request?.spatialRelation).toMatchObject({
      relationText: "below",
      targetText: "custom scar",
      relationCoding: { code: "351726001" }
    });
    expect(result.fhir.site?.coding?.[0]).toEqual({
      system: "http://example.org/sites",
      code: "BELOW-SCAR",
      display: "Below custom scar"
    });
    expect(result.meta.normalized.site?.spatialRelation?.targetCoding?.code).toBe("SCAR");
  });

  it("passes parsed spatial relation metadata to PRN reason terminology callbacks", () => {
    let seenRelation: unknown;
    const result = parseSig("apply prn itch below custom scar", {
      prnReasonResolvers: [(request) => {
        seenRelation = request.locativeSiteSpatialRelation;
        return {
          text: request.text,
          coding: {
            system: "http://example.org/reasons",
            code: "ITCH-BELOW-SCAR",
            display: "Itch below custom scar"
          }
        };
      }]
    });

    expect(seenRelation).toMatchObject({
      relationText: "below",
      targetText: "custom scar",
      relationCoding: { code: "351726001" }
    });
    expect(result.fhir.asNeededFor?.[0]?.coding?.[0]).toEqual({
      system: "http://example.org/reasons",
      code: "ITCH-BELOW-SCAR",
      display: "Itch below custom scar"
    });
  });

  it("preserves coordinated topical site phrases", () => {
    const result = parseSig("apply to scalp and forehead bid");
    expect(result.fhir.site?.text).toBe("scalp and forehead");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(
      SNOMEDCTRouteCodes["Topical route"]
    );
  });

  it("records probe requests for unresolved sites so UIs can prompt", () => {
    const input = "apply to {mole scalp} nightly";
    const result = parseSig(input);
    const lookup = result.meta.siteLookups?.[0];
    expect(result.fhir.site?.coding).toBeUndefined();
    expect(result.meta.siteLookups).toHaveLength(1);
    expect(lookup?.request).toMatchObject({
      text: "mole scalp",
      isProbe: true,
      inputText: input,
      sourceText: "mole scalp"
    });
    expect(lookup?.request.range).toEqual({
      start: input.toLowerCase().indexOf("mole scalp"),
      end: input.toLowerCase().indexOf("mole scalp") + "mole scalp".length
    });
    expect(lookup?.suggestions).toEqual([]);
  });

  it("records probe requests for known bundled sites and exposes the bundled suggestion", () => {
    const input = "apply to {temple} nightly";
    const result = parseSig(input);
    const lookup = result.meta.siteLookups?.[0];
    expect(result.fhir.site?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: "450721000",
      display: "Temple region structure"
    });
    expect(result.meta.siteLookups).toHaveLength(1);
    expect(lookup?.request).toMatchObject({
      text: "temple",
      isProbe: true,
      inputText: input,
      sourceText: "temple"
    });
    expect(lookup?.request.range).toEqual({
      start: input.toLowerCase().indexOf("temple"),
      end: input.toLowerCase().indexOf("temple") + "temple".length
    });
    expect(lookup?.suggestions).toEqual([
      {
        coding: {
          system: "http://snomed.info/sct",
          code: "450721000",
          display: "Temple region structure"
        }
      }
    ]);
  });

  it("leaves site lookups empty for unresolved sites without probes", () => {
    const result = parseSig("apply to mole on scalp nightly");
    expect(result.meta.siteLookups).toBeUndefined();
  });

  it("merges suggestion resolver results for probe lookups", () => {
    const input = "apply to {mole scalp} nightly";
    const captured: SiteCodeLookupRequest[] = [];
    const result = parseSig(input, {
      siteCodeSuggestionResolvers: (request) => {
        captured.push(request);
        return {
          suggestions: [
            {
              coding: {
                system: "http://snomed.info/sct",
                code: "450721000",
                display: "Temple region structure"
              },
              text: "Temple"
            }
          ]
        };
      }
    });
    expect(captured[0]).toMatchObject({
      inputText: input,
      sourceText: "mole scalp"
    });
    expect(captured[0]?.range).toEqual({
      start: input.toLowerCase().indexOf("mole scalp"),
      end: input.toLowerCase().indexOf("mole scalp") + "mole scalp".length
    });
    expect(result.meta.siteLookups?.[0].suggestions).toEqual([
      {
        coding: {
          system: "http://snomed.info/sct",
          code: "450721000",
          display: "Temple region structure"
        },
        text: "Temple"
      }
    ]);
  });

  it("awaits asynchronous suggestion resolvers", async () => {
    const input = "apply to {mole scalp} nightly";
    const result = await parseSigAsync(input, {
      siteCodeSuggestionResolvers: async (request) => {
        expect(request.inputText).toBe(input);
        expect(request.sourceText).toBe("mole scalp");
        expect(request.range).toEqual({
          start: input.toLowerCase().indexOf("mole scalp"),
          end: input.toLowerCase().indexOf("mole scalp") + "mole scalp".length
        });
        return [
          {
            coding: {
              system: "http://snomed.info/sct",
              code: "450721000",
              display: "Temple region structure"
            },
            text: "Temple"
          }
        ];
      }
    });
    expect(result.meta.siteLookups?.[0].suggestions?.[0]).toMatchObject({
      coding: {
        system: "http://snomed.info/sct",
        code: "450721000",
        display: "Temple region structure"
      },
      text: "Temple"
    });
  });

  it("computes precise ranges for probe placeholders", () => {
    const input = "apply to {upper left arm} nightly";
    const result = parseSig(input);
    const lookup = result.meta.siteLookups?.[0];
    expect(lookup?.request.sourceText).toBe("upper left arm");
    const start = input.toLowerCase().indexOf("upper left arm");
    expect(lookup?.request.range).toEqual({ start, end: start + "upper left arm".length });
  });

  it("supports asynchronous site code resolvers", async () => {
    const input = "apply to chin twice daily";
    const captured: SiteCodeLookupRequest[] = [];
    const result = await parseSigAsync(input, {
      siteCodeResolvers: async (request) => {
        captured.push(request);
        if (request.canonical === "chin") {
          return {
            coding: {
              system: "http://example.org/test",
              code: "123",
              display: "Custom chin"
            }
          };
        }
        return undefined;
      }
    });
    expect(captured[0]).toMatchObject({
      inputText: input,
      sourceText: "chin"
    });
    expect(captured[0]?.range).toEqual({
      start: input.toLowerCase().indexOf("chin"),
      end: input.toLowerCase().indexOf("chin") + "chin".length
    });
    expect(result.fhir.site?.coding?.[0]).toEqual({
      system: "http://example.org/test",
      code: "123",
      display: "Custom chin"
    });
  });

  it("short text round trip", () => {
    const sig = "2 tab po q6h prn pain";
    const parsed = parseSig(sig);
    const shortText = formatSig(parsed.fhir, "short");
    expect(shortText).toContain("Q6H");
  });

  it("fromFhirDosage falls back to text", () => {
    const sig = "1x3 po pc";
    const parsed = parseSig(sig, { context: TAB_CONTEXT });
    const again = fromFhirDosage(parsed.fhir);
    expect(again.longText).toBe(parsed.longText);
  });

  it("fromFhirDosage prefers computed formatting when format options are provided", () => {
    const parsed = parseSig("1 tab po pc breakfast lunch dinner");
    const again = fromFhirDosage(parsed.fhir, {
      groupMealTimingsByRelation: true,
      includeTimesPerDaySummary: true
    });
    expect(again.longText).toBe(
      "Take 1 tablet orally three times daily after breakfast, lunch and dinner."
    );
    expect(again.fhir.text).toBe(again.longText);
  });

  it("fromFhirDosage preserves non-SNOMED site codings when no site text is present", () => {
    const again = fromFhirDosage({
      site: {
        coding: [
          {
            system: "http://example.org/site-system",
            code: "custom-site",
            display: "Custom site"
          }
        ]
      }
    });
    expect(again.meta.normalized.site?.coding).toEqual({
      system: "http://example.org/site-system",
      code: "custom-site",
      display: "Custom site"
    });
  });

  it("fromFhirDosage formats coded sites when site text is absent", () => {
    const again = fromFhirDosage({
      route: {
        text: "topical",
        coding: [
          {
            system: "http://snomed.info/sct",
            code: "6064005",
            display: "Topical route"
          }
        ]
      },
      site: {
        coding: [
          {
            system: "http://snomed.info/sct",
            code: "41695006",
            display: "Scalp"
          }
        ]
      }
    });
    expect(again.longText).toBe("Apply the medication to the scalp.");
  });

  it("fromFhirDosage preserves one-sided dose ranges", () => {
    const again = fromFhirDosage({
      doseAndRate: [
        {
          doseRange: {
            high: { value: 2, unit: "tab" }
          }
        }
      ]
    });

    expect(again.meta.canonical.clauses[0]?.dose).toEqual({
      range: { high: 2 },
      unit: "tab"
    });
    expect(again.shortText).toContain("<=2 tab");
    expect(again.longText).toBe("Use up to 2 tablets.");
  });

  it("fromFhirDosage warns on mismatched dose range units instead of dropping the range", () => {
    const again = fromFhirDosage({
      doseAndRate: [
        {
          doseRange: {
            low: { value: 1, unit: "tab" },
            high: { value: 2, unit: "mL" }
          }
        }
      ]
    });

    expect(again.meta.canonical.clauses[0]?.dose).toEqual({
      range: { low: 1, high: 2 },
      unit: "tab"
    });
    expect(again.warnings).toContain(
      "FHIR doseRange low/high units differ (tab vs mL); preserved numeric bounds using tab."
    );
  });

  it("does not emit empty timing objects when no timing data is present", () => {
    const parsed = parseSig("apply prn itch");
    expect(parsed.fhir.timing).toBeUndefined();
  });

  it("treats oral administration verbs as route cues instead of stray advice text", () => {
    const result = parseSig("drink 10 ml prn pain");

    expect(result.shortText).toBe("10 mL PO PRN pain");
    expect(result.longText).toBe("Drink 10 mL as needed for pain.");
    expect(result.fhir.method?.text).toBe("Drink");
    expectPrimitiveTranslation(result.fhir.method?._text, "th", "รับประทาน");
    expect(result.fhir.method?.coding).toEqual([
      {
        system: "http://snomed.info/sct",
        code: "738995006",
        display: "Swallow",
        _display: {
          extension: [
            {
              url: FHIR_TRANSLATION_EXTENSION_URL,
              extension: [
                {
                  url: "lang",
                  valueCode: "th"
                },
                {
                  url: "content",
                  valueString: "รับประทาน"
                }
              ]
            }
          ]
        }
      }
    ]);
    expect(result.meta.normalized.route).toBe(RouteCode["Oral route"]);
    expect(result.meta.normalized.method).toEqual({
      text: "Drink",
      coding: {
        system: "http://snomed.info/sct",
        code: "738995006",
        display: "Swallow"
      }
    });
    expect(result.meta.normalized.additionalInstructions).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it("codes trailing adverbial method modifiers as additional instructions", () => {
    const result = parseSig("po 10 ml twice daily, drink slowly");

    expect(result.fhir.patientInstruction).toBeUndefined();
    expect(result.fhir.additionalInstruction?.[0]?.coding?.[0]?.code).toBe("419443000");
    expect(result.meta.normalized.additionalInstructions?.[0]?.coding?.code).toBe("419443000");
    expect(result.meta.leftoverText).toBeUndefined();
    expect(result.longText).toBe("Drink 10 mL twice daily. Drink slowly.");
  });

  it("codes bare slowly qualifiers using the clause administration context", () => {
    const result = parseSig("take 1 tab po daily slowly", { context: TAB_CONTEXT });

    expect(result.fhir.additionalInstruction?.[0]?.coding?.[0]?.code).toBe("419443000");
    expect(result.longText).toBe("Take 1 tablet orally once daily. Take slowly.");
  });

  it("codes explicit empty-stomach fragments as additional instructions", () => {
    const result = parseSig("drink 10 ml twice daily, on an empty stomach");

    expect(result.fhir.additionalInstruction?.[0]?.coding?.[0]?.code).toBe("717154004");
    expect(result.meta.normalized.additionalInstructions?.[0]?.coding?.code).toBe("717154004");
    expect(result.meta.leftoverText).toBeUndefined();
    expect(result.longText).toBe("Drink 10 mL twice daily. On an empty stomach.");
  });

  it("infers elliptical empty-stomach fragments through the advice grammar", () => {
    const result = parseSig("drink 10 ml twice daily, empty stomach");

    expect(result.fhir.additionalInstruction?.[0]?.coding?.[0]?.code).toBe("717154004");
    expect(result.meta.normalized.additionalInstructions?.[0]?.coding?.code).toBe("717154004");
    expect(result.meta.leftoverText).toBeUndefined();
    expect(result.longText).toBe("Drink 10 mL twice daily. On an empty stomach.");
  });

  it("cuts PRN reasons at structured warning tails and codes drowsiness warnings across modal variants", () => {
    const cases = [
      "take 10 ml prn dizziness, may cause drowsiness",
      "take 10 ml prn dizziness, can cause drowsiness",
      "take 10 ml prn dizziness, might cause drowsiness",
      "take 10 ml prn dizziness, could cause drowsiness"
    ];

    for (const input of cases) {
      const result = parseSig(input);
      expect(result.fhir.asNeededFor?.[0]?.text).toBe("dizziness");
      expect(result.fhir.additionalInstruction?.[0]?.coding?.[0]?.code).toBe("418639000");
      expect(result.meta.normalized.additionalInstructions?.[0]?.coding?.code).toBe("418639000");
      expect(result.meta.leftoverText).toBeUndefined();
      expect(result.longText).toBe("Take 10 mL orally as needed for dizziness. May cause drowsiness.");
    }
  });

  it("treats leading modal drowsiness warnings after PRN as additional instructions without punctuation", () => {
    const cases = [
      "1 tab po prn may drowsy",
      "1 tab po prn can drowsy",
      "1 tab po prn might drowsy",
      "1 tab po prn could drowsy",
      "1 tab po prn may cause drowsiness",
      "1 tab po prn can cause drowsiness",
      "1 tab po prn might cause drowsiness",
      "1 tab po prn could cause drowsiness"
    ];

    for (const input of cases) {
      const result = parseSig(input, { context: TAB_CONTEXT });
      expect(result.fhir.asNeededBoolean).toBe(true);
      expect(result.fhir.asNeededFor).toBeUndefined();
      expect(result.fhir.additionalInstruction?.[0]?.coding?.[0]?.code).toBe("418639000");
      expect(result.meta.normalized.additionalInstructions?.[0]?.coding?.code).toBe("418639000");
      expect(result.meta.leftoverText).toBeUndefined();
      expect(result.longText).toBe("Take 1 tablet orally as needed. May cause drowsiness.");
    }
  });

  it("codes negated alcohol-advice tails after PRN reasons", () => {
    const result = parseSig("take 1 tab po prn pain, do not take with alcohol", {
      context: TAB_CONTEXT
    });

    expect(result.fhir.asNeededFor?.[0]?.coding?.[0]?.code).toBe("22253000");
    expect(result.fhir.additionalInstruction?.[0]?.coding?.[0]?.code).toBe("419822006");
    expect(result.meta.normalized.additionalInstructions?.[0]?.coding?.code).toBe("419822006");
    expect(result.meta.leftoverText).toBeUndefined();
    expect(result.longText).toBe("Take 1 tablet orally as needed for pain. Avoid alcoholic drinks.");
  });

  it("normalizes uncoded affirmative relation tails through generic advice frames", () => {
    const result = parseSig("take 1 tab po daily, with grapefruit juice", {
      context: TAB_CONTEXT
    });

    expect(result.fhir.additionalInstruction?.[0]?.coding).toBeUndefined();
    expect(result.fhir.additionalInstruction?.[0]?.text).toBe("Take with grapefruit juice");
    expect(result.meta.leftoverText).toBeUndefined();
    expect(result.longText).toBe("Take 1 tablet orally once daily. Take with grapefruit juice.");
  });

  it("normalizes uncoded negated relation tails through generic advice frames", () => {
    const result = parseSig("take 1 tab po daily, must not take with warfarin", {
      context: TAB_CONTEXT
    });

    expect(result.fhir.additionalInstruction?.[0]?.coding).toBeUndefined();
    expect(result.fhir.additionalInstruction?.[0]?.text).toBe("Must not take with warfarin");
    expect(result.meta.leftoverText).toBeUndefined();
    expect(result.longText).toBe("Take 1 tablet orally once daily. Must not take with warfarin.");
  });

  it("preserves uncoded modal caution and warning tails through the generic advice grammar", () => {
    const caution = parseSig("take 1 tab po daily, should take with grapefruit juice", {
      context: TAB_CONTEXT
    });
    expect(caution.fhir.additionalInstruction?.[0]?.text).toBe("Should take with grapefruit juice");
    expect(caution.longText).toBe(
      "Take 1 tablet orally once daily. Should take with grapefruit juice."
    );

    const warning = parseSig("take 10 ml po daily, might cause dizziness");
    expect(warning.fhir.additionalInstruction?.[0]?.text).toBe("Might cause dizziness");
    expect(warning.longText).toBe("Take 10 mL orally once daily. Might cause dizziness.");
  });

  it("suppresses redundant oral route phrasing for swallow methods", () => {
    const result = parseSig("swallow 1 tab po daily", { context: TAB_CONTEXT });
    expect(result.longText).toBe("Swallow 1 tablet once daily.");
  });

  it("warns when an oral PRN instruction is missing the dose", () => {
    const result = parseSig("take prn pain");

    expect(result.meta.normalized.route).toBe(RouteCode["Oral route"]);
    expect(result.warnings).toContain(
      "Incomplete sig: missing dose for oral administration."
    );
  });

  it("warns when a topical site instruction is missing timing or PRN, but not when timing is present", () => {
    const bare = parseSig("apply to scalp");
    const scheduled = parseSig("apply to scalp twice daily");

    expect(bare.warnings).toContain(
      "Incomplete sig: missing timing or PRN qualifier for topical site administration."
    );
    expect(scheduled.warnings).not.toContain(
      "Incomplete sig: missing timing or PRN qualifier for topical site administration."
    );
  });

  it("codes known administration methods into FHIR dosage.method", () => {
    const cases = [
      {
        sig: "take 1 tab po daily",
        text: "Take",
        thaiText: "รับประทาน",
        code: "738990001",
        display: "Administer"
      },
      {
        sig: "swallow 1 tab po daily",
        text: "Swallow",
        thaiText: "รับประทาน",
        code: "738995006",
        display: "Swallow",
        thaiDisplay: "รับประทาน"
      },
      {
        sig: "apply cream to scalp twice daily",
        text: "Apply",
        thaiText: "ทา",
        code: "738991002",
        display: "Apply",
        thaiDisplay: "ทา"
      },
      {
        sig: "insert 1 applicatorful vaginally at bedtime",
        text: "Insert",
        thaiText: "สอด",
        code: "738993004",
        display: "Insert",
        thaiDisplay: "สอด"
      },
      {
        sig: "instill 1 drop to eye bid",
        text: "Instill",
        thaiText: "หยอด",
        code: "738994005",
        display: "Instill",
        thaiDisplay: "หยอด"
      },
      {
        sig: "spray once daily to nostril",
        text: "Spray",
        thaiText: "พ่น",
        code: "738996007",
        display: "Spray",
        thaiDisplay: "พ่น"
      },
      {
        sig: "use shampoo daily",
        text: "Use shampoo",
        thaiText: "สระ",
        code: "738990001",
        display: "Administer"
      },
      {
        sig: "wash scalp daily",
        text: "Wash",
        thaiText: "ล้าง",
        code: "785900008",
        display: "Rinse or wash",
        thaiDisplay: "ล้าง"
      },
      {
        sig: "reapply sunscreen every 2 hours",
        text: "Reapply sunscreen",
        thaiText: "ทากันแดดซ้ำ",
        code: "738991002",
        display: "Apply",
        thaiDisplay: "ทา"
      }
    ];

    for (const { sig, text, thaiText, code, display, thaiDisplay } of cases) {
      const result = parseSig(sig);
      expect(result.fhir.method?.text).toBe(text);
      expectPrimitiveTranslation(result.fhir.method?._text, "th", thaiText);
      expect(result.fhir.method?.coding).toEqual([
        {
          system: "http://snomed.info/sct",
          code,
          display,
          ...(thaiDisplay
            ? {
              _display: {
                extension: [
                  {
                    url: FHIR_TRANSLATION_EXTENSION_URL,
                    extension: [
                      {
                        url: "lang",
                        valueCode: "th"
                      },
                      {
                        url: "content",
                        valueString: thaiDisplay
                      }
                    ]
                  }
                ]
              }
            }
            : {})
        }
      ]);
      expect(result.meta.normalized.method).toEqual({
        text,
        coding: {
          system: "http://snomed.info/sct",
          code,
          display
        }
      });
    }
  });
});

describe("internationalization", () => {
  describe("Thai localization", () => {
    it("produces Thai text for parseSig", () => {
      const result = parseSig("1 tab po bid", { context: TAB_CONTEXT, locale: "th" });
      expect(result.shortText).toBe("1 เม็ด PO วันละ 2 ครั้ง");
      expect(result.longText).toBe("รับประทาน ครั้งละ 1 เม็ด วันละ 2 ครั้ง.");
      expect(result.fhir.text).toBe("รับประทาน ครั้งละ 1 เม็ด วันละ 2 ครั้ง.");
    });

    it("formats Thai text from FHIR dosage", () => {
      const parsed = parseSig("1 tab po bid", { context: TAB_CONTEXT });
      const fromFhir = fromFhirDosage(parsed.fhir, { locale: "th" });
      expect(fromFhir.shortText).toBe("1 เม็ด PO วันละ 2 ครั้ง");
      expect(fromFhir.longText).toBe("รับประทาน ครั้งละ 1 เม็ด วันละ 2 ครั้ง.");
    });

    it("formats Thai site text from SNOMED coding when FHIR site.text is absent", () => {
      const parsed = parseSig("apply to right temple bid");
      const fromFhir = fromFhirDosage(
        {
          ...parsed.fhir,
          site: {
            coding: parsed.fhir.site?.coding
          }
        },
        { locale: "th" }
      );

      expect(fromFhir.longText).toBe("ทา บริเวณขมับขวา วันละ 2 ครั้ง.");
    });

    it("suppresses duplicate Thai rectal and vaginal site phrases when coding already implies the route", () => {
      const rectal = fromFhirDosage(
        {
          route: {
            text: "rectal",
            coding: [{ system: "http://snomed.info/sct", code: "37161004", display: "Per rectum" }]
          },
          site: {
            text: "ไส้ตรง",
            coding: [{ system: "http://snomed.info/sct", code: "34402009", display: "Rectum" }]
          }
        },
        { locale: "th" }
      );
      expect(rectal.longText).toBe("สอด ทางทวารหนัก.");
      expect(rectal.longText).not.toContain("ไส้ตรง");

      const vaginal = fromFhirDosage(
        {
          route: {
            text: "vaginal",
            coding: [{ system: "http://snomed.info/sct", code: "16857009", display: "Per vagina" }]
          },
          site: {
            text: "ช่องคลอด",
            coding: [{ system: "http://snomed.info/sct", code: "76784001", display: "Vagina" }]
          }
        },
        { locale: "th" }
      );
      expect(vaginal.longText).toBe("สอด ทางช่องคลอด.");
    });

    it("suppresses duplicate Thai rectal and vaginal site phrases for text-only routes", () => {
      const rectal = fromFhirDosage(
        {
          route: {
            text: "rectal"
          },
          site: {
            text: "ไส้ตรง",
            coding: [{ system: "http://snomed.info/sct", code: "34402009", display: "Rectum" }]
          }
        },
        { locale: "th" }
      );
      expect(rectal.longText).toBe("สอด ทางทวารหนัก.");
      expect(rectal.longText).not.toContain("ไส้ตรง");

      const vaginal = fromFhirDosage(
        {
          route: {
            text: "vaginal"
          },
          site: {
            text: "ช่องคลอด",
            coding: [{ system: "http://snomed.info/sct", code: "76784001", display: "Vagina" }]
          }
        },
        { locale: "th" }
      );
      expect(vaginal.longText).toBe("สอด ทางช่องคลอด.");
    });

    it("translates eye site names in Thai", () => {
      const result = parseSig("1 drop OD", { locale: "th" });
      expect(result.longText).toBe("หยอด ครั้งละ 1 หยด ที่ตาขวา.");
      expect(result.fhir.text).toBe("หยอด ครั้งละ 1 หยด ที่ตาขวา.");
    });

    it("uses inhaler phrasing in Thai without สูดดม", () => {
      const result = parseSig("2 puff inhalation hs", { locale: "th" });
      expect(result.longText).toBe("สูด ครั้งละ 2 พัฟ ก่อนนอน.");
      expect(result.fhir.text).toBe("สูด ครั้งละ 2 พัฟ ก่อนนอน.");
    });

    it("uses inhaler phrasing in Thai for puff-only sigs", () => {
      const result = parseSig("1 puff od", { locale: "th" });
      expect(result.longText).toBe("สูด ครั้งละ 1 พัฟ วันละครั้ง.");
      expect(result.fhir.text).toBe("สูด ครั้งละ 1 พัฟ วันละครั้ง.");
    });

    it("translates ear site names in Thai", () => {
      const result = parseSig("1 drop right ear once daily", { locale: "th" });
      expect(result.longText).toBe("หยอด ครั้งละ 1 หยด วันละครั้ง ที่หูขวา.");
      expect(result.fhir.text).toBe("หยอด ครั้งละ 1 หยด วันละครั้ง ที่หูขวา.");
    });

    it("translates head site names in Thai", () => {
      const result = parseSig("apply to head bid", { locale: "th" });
      expect(result.longText).toBe("ทา บริเวณศีรษะ วันละ 2 ครั้ง.");
      expect(result.fhir.text).toBe("ทา บริเวณศีรษะ วันละ 2 ครั้ง.");

      const thaiHead = parseSig("apply to หัว", { locale: "th" });
      expect(thaiHead.longText).toBe("ทา บริเวณศีรษะ.");

      const thaiScalp = parseSig("apply ที่หนังศีรษะ", { locale: "th" });
      expect(thaiScalp.longText).toBe("ทา บริเวณหนังศีรษะ.");
    });

    it("translates spatial body-site relations in Thai", () => {
      const belowEar = parseSig("apply below ear bid", { locale: "th" });
      expect(belowEar.longText).toBe("ทา บริเวณใต้หู วันละ 2 ครั้ง.");

      const topOfHand = parseSig("apply to top of hand bid", { locale: "th" });
      expect(topOfHand.longText).toBe("ทา บริเวณด้านบนของมือ วันละ 2 ครั้ง.");

      const rightAbdomen = parseSig("apply to right side of abdomen bid", { locale: "th" });
      expect(rightAbdomen.longText).toBe("ทา บริเวณท้องด้านขวา วันละ 2 ครั้ง.");

      const betweenFingers = parseSig("apply to area between fingers", { locale: "th" });
      expect(betweenFingers.longText).toBe("ทา บริเวณระหว่างนิ้วมือ.");

      const thaiBetweenFingers = parseSig("apply ระหว่างนิ้วมือ", { locale: "th" });
      expect(thaiBetweenFingers.longText).toBe("ทา บริเวณระหว่างนิ้วมือ.");

      const thaiBetweenDigits = parseSig("apply ระหว่างนิ้ว", { locale: "th" });
      expect(thaiBetweenDigits.longText).toBe("ทา บริเวณระหว่างนิ้วมือ.");

      const thaiBetweenToes = parseSig("apply ระหว่างนิ้วเท้า", { locale: "th" });
      expect(thaiBetweenToes.longText).toBe("ทา บริเวณระหว่างนิ้วเท้า.");

      const contextualThaiBetweenToes = parseSig("apply ระหว่างนิ้ว", {
        locale: "th",
        context: { bodySiteContext: "feet" }
      });
      expect(contextualThaiBetweenToes.longText).toBe("ทา บริเวณระหว่างนิ้วเท้า.");

      const rightFlank = parseSig("apply to right flank", { locale: "th" });
      expect(rightFlank.longText).toBe("ทา บริเวณสีข้างขวา.");

      const fromExtensionOnly = fromFhirDosage(
        {
          ...belowEar.fhir,
          site: { extension: belowEar.fhir.site?.extension }
        },
        { locale: "th" }
      );
      expect(fromExtensionOnly.longText).toBe("ทา บริเวณใต้หู วันละ 2 ครั้ง.");
    });

    it("translates spatial PRN reason sites in Thai", () => {
      const result = parseSig("apply prn itch below ear", { locale: "th" });
      expect(result.longText).toBe("ทา ใช้เมื่อจำเป็นสำหรับ คันใต้หู.");
      expect(result.fhir.asNeededFor?.[0]?.extension?.[0]?.url).toBe(
        BODY_SITE_SPATIAL_RELATION_EXTENSION_URL
      );
    });

    it("translates SNOMED-coded site variants in Thai without alias-specific text keys", () => {
      const temple = parseSig("apply to temple region bid", { locale: "th" });
      expect(temple.longText).toBe("ทา บริเวณขมับ วันละ 2 ครั้ง.");

      const leftHead = parseSig("apply to left side of head bid", { locale: "th" });
      expect(leftHead.longText).toBe("ทา บริเวณศีรษะซ้าย วันละ 2 ครั้ง.");
    });

    it("translates ear site variants without leaving English route text", () => {
      const cases: Array<{ sig: string; expectedSite: string }> = [
        { sig: "1 drop left ear once daily", expectedSite: "หูซ้าย" },
        { sig: "1 drop both ears QID", expectedSite: "หูทั้งสองข้าง" }
      ];

      for (const { sig, expectedSite } of cases) {
        const result = parseSig(sig, { locale: "th" });
        expect(result.longText).toContain(`ที่${expectedSite}`);
        expect(result.longText).not.toMatch(/otic/i);
        expect(result.fhir.text).toBe(result.longText);
      }
    });

    it("combines frequency, event timing, and as-needed phrasing in Thai", () => {
      const result = parseSig("1 tab po bid ac prn pain", { locale: "th" });
      expect(result.longText).toBe(
        "รับประทาน ครั้งละ 1 เม็ด วันละ 2 ครั้ง ก่อนอาหาร ใช้เมื่อจำเป็นสำหรับ ปวด."
      );
      expect(result.shortText).toBe(
        "1 เม็ด PO วันละ 2 ครั้ง ก่อนอาหาร ใช้เมื่อจำเป็นสำหรับ ปวด"
      );
    });

    it("includes count information in Thai formatting", () => {
      const result = parseSig("1 tab po q1h for 10 times", {
        context: TAB_CONTEXT,
        locale: "th"
      });
      expect(result.shortText).toBe("1 เม็ด PO ทุก 1 ชั่วโมง x10");
      expect(result.longText).toBe("รับประทาน ครั้งละ 1 เม็ด ทุก 1 ชั่วโมง จำนวน 10 ครั้ง.");
      expect(result.fhir.text).toBe("รับประทาน ครั้งละ 1 เม็ด ทุก 1 ชั่วโมง จำนวน 10 ครั้ง.");
    });

    it("includes minute interval wording together with count information in Thai", () => {
      const result = parseSig("1 drop ou q15min x 8 doses", { locale: "th" });
      expect(result.shortText).toBe("1 หยด OPH ทุก 15 นาที x8");
      expect(result.longText).toBe("หยอด ครั้งละ 1 หยด ทุก 15 นาที จำนวน 8 ครั้ง ที่ตาทั้งสองข้าง.");
      expect(result.fhir.text).toBe("หยอด ครั้งละ 1 หยด ทุก 15 นาที จำนวน 8 ครั้ง ที่ตาทั้งสองข้าง.");
    });

    it("describes day-of-week schedules in Thai", () => {
      const result = parseSig("1 tab po every monday", { locale: "th" });
      expect(result.longText).toBe("รับประทาน ครั้งละ 1 เม็ด ในวันจันทร์.");
    });

    it("groups Thai meal timings by relation without forcing a daily count", () => {
      const result = parseSig("1 tab po pc breakfast lunch dinner", {
        locale: "th",
        groupMealTimingsByRelation: true
      });
      expect(result.longText).toBe("รับประทาน ครั้งละ 1 เม็ด หลังอาหารเช้า กลางวัน และเย็น.");
    });

    it("adds a Thai daily count summary independently from meal grouping", () => {
      const result = parseSig("1 tab po pc breakfast lunch dinner", {
        locale: "th",
        includeTimesPerDaySummary: true
      });
      expect(result.longText).toBe(
        "รับประทาน ครั้งละ 1 เม็ด วันละ 3 ครั้ง หลังอาหารเช้า, หลังอาหารกลางวัน และ หลังอาหารเย็น."
      );
    });

    it("supports grouped Thai meal timings together with a daily count summary", () => {
      const result = parseSig("1 tab po pc breakfast lunch dinner", {
        locale: "th",
        groupMealTimingsByRelation: true,
        includeTimesPerDaySummary: true
      });
      expect(result.longText).toBe(
        "รับประทาน ครั้งละ 1 เม็ด วันละ 3 ครั้ง หลังอาหารเช้า กลางวัน และเย็น."
      );
    });
  });

  it("supports grouped English meal timings together with a daily count summary", () => {
    const result = parseSig("1 tab po pc breakfast lunch dinner", {
      groupMealTimingsByRelation: true,
      includeTimesPerDaySummary: true
    });
    expect(result.longText).toBe(
      "Take 1 tablet orally three times daily after breakfast, lunch and dinner."
    );
  });

  it("groups the meal subset while keeping bedtime natural in English", () => {
    const result = parseSig("1 tab po ac breakfast lunch dinner hs", {
      groupMealTimingsByRelation: true,
      includeTimesPerDaySummary: true
    });
    expect(result.longText).toBe(
      "Take 1 tablet orally four times daily before breakfast, lunch and dinner and at bedtime."
    );
  });

  it("does not group non-contiguous meal anchors across other natural times", () => {
    const result = parseSig("1 tab po breakfast noon dinner", {
      groupMealTimingsByRelation: true,
      includeTimesPerDaySummary: true
    });
    expect(result.longText).toBe(
      "Take 1 tablet orally three times daily with breakfast, at noon and with dinner."
    );
  });

  it("allows custom translation overrides", () => {
    const custom = parseSig("1 tab po bid", {
      context: TAB_CONTEXT,
      i18n: {
        formatLong: () => "custom long",
        formatShort: () => "custom short"
      }
    });
    expect(custom.shortText).toBe("custom short");
    expect(custom.longText).toBe("custom long");
  });
});

describe("unit normalization", () => {
  it("normalizes every default unit synonym", () => {
    for (const [input, canonical] of Object.entries(DEFAULT_UNIT_SYNONYMS)) {
      const result = parseSig(`1 ${input}`);
      const dose = result.fhir.doseAndRate?.[0]?.doseQuantity;
      if (!dose) {
        throw new Error(`Expected dose quantity for unit ${input}`);
      }
      expect(dose.unit).toBe(canonical);
      expect(dose.value).toBe(1);
    }
  });

  it("normalizes dosage form strings", () => {
    expect(normalizeDosageForm("Nasal Spray, Suspension")).toBe("nasal spray");
    expect(normalizeDosageForm("capsule, soft")).toBe("capsule");
    expect(normalizeDosageForm(undefined)).toBeUndefined();
  });
});

describe("ocular and injection scenarios", () => {
  it("parses right eye drops with QID", () => {
    const result = parseSig("1 drop OD QID");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "drop" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("QID");
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 4,
      period: 1,
      periodUnit: "d"
    });
    expect(result.fhir.site?.text).toBe("right eye");
    expect(result.fhir.route?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: SNOMEDCTRouteCodes["Ophthalmic route"],
      display: "Ophthalmic route"
    });
    expect(result.longText).toBe("Instill 1 drop four times daily in the right eye.");
  });

  it("parses left eye drops every 2 hours", () => {
    const result = parseSig("1 drop OS Q2H");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "drop" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("Q2H");
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 2, periodUnit: "h" });
    expect(result.fhir.site?.text).toBe("left eye");
  });

  it("parses both eyes every hour", () => {
    const result = parseSig("1 drop OU Q1H");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "drop" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("Q1H");
    expect(result.fhir.site?.text).toBe("both eyes");
    expect(result.longText).toBe("Instill 1 drop every 1 hour in both eyes.");
  });

  it("formats combined qid and bedtime ocular dosing", () => {
    const result = parseSig("1 drop OU QID hs");
    expect(result.longText).toBe(
      "Instill 1 drop four times daily and at bedtime in both eyes."
    );
  });

  it("treats standalone OU before bedtime PRN as an ocular clause opener", () => {
    const result = parseSig("ou before bed prn itch");
    expect(result.fhir.route?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: SNOMEDCTRouteCodes["Ophthalmic route"],
      display: "Ophthalmic route"
    });
    expect(result.fhir.site?.text).toBe("both eyes");
    expect(result.fhir.asNeededFor?.[0]?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: "74776002",
      display: "Itching of eye"
    });
    expect(result.longText).toBe(
      "Instill the medication at bedtime as needed for itch in both eyes."
    );
  });

  it("parses intramuscular injections", () => {
    const result = parseSig("1 mL IM q6h");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "mL" });
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 6, periodUnit: "h" });
    expect(result.fhir.route?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: SNOMEDCTRouteCodes["Intramuscular route"],
      display: "Intramuscular route"
    });
  });

  it("parses intravenous stat dosing", () => {
    const result = parseSig("1 mL IV stat");
    expect(result.fhir.timing?.repeat?.when).toEqual([EventTiming.Immediate]);
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Intravenous route"]);
  });

  it("parses spaced IVT shorthand with eye side", () => {
    const result = parseSig("0.05 mL IVT OS q1mo");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 0.05, unit: "mL" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("MO");
    expect(result.fhir.route?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: SNOMEDCTRouteCodes["Intravitreal route (qualifier value)"],
      display: "Intravitreal route (qualifier value)"
    });
    expect(result.fhir.site?.text).toBe("left eye");
    expect(result.warnings).toHaveLength(0);
  });

  it("parses combined IVT shorthand tokens", () => {
    const result = parseSig("0.05 mL IVTOD q1mo");
    expect(result.fhir.site?.text).toBe("right eye");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(
      SNOMEDCTRouteCodes["Intravitreal route (qualifier value)"]
    );
  });

  it("parses VOD shorthand as intravitreal right eye", () => {
    const result = parseSig("0.05 mL VOD q1mo");
    expect(result.fhir.site?.text).toBe("right eye");
    expect(result.fhir.route?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: SNOMEDCTRouteCodes["Intravitreal route (qualifier value)"],
      display: "Intravitreal route (qualifier value)"
    });
    expect(result.warnings).toHaveLength(0);
  });

  it("parses VOS shorthand as intravitreal left eye", () => {
    const result = parseSig("0.05 mL VOS q1mo");
    expect(result.fhir.site?.text).toBe("left eye");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(
      SNOMEDCTRouteCodes["Intravitreal route (qualifier value)"]
    );
    expect(result.warnings).toHaveLength(0);
  });

  it("warns when intravitreal lacks an eye side", () => {
    const result = parseSig("0.05 mL intravitreal q1mo");
    expect(result.warnings).toContain(
      "Intravitreal administrations require an eye site (e.g., OD/OS/OU)."
    );
  });
});

describe("minute and fractional interval parsing", () => {
  const cases: Array<{ input: string; period: number; unit: string }> = [
    { input: "q30min", period: 30, unit: "min" },
    { input: "q15min", period: 15, unit: "min" },
    { input: "q0.5h", period: 30, unit: "min" },
    { input: "q1/2hr", period: 30, unit: "min" },
    { input: "q0.25h", period: 15, unit: "min" },
    { input: "q1/4hr", period: 15, unit: "min" },
    { input: "q 0.5 h", period: 30, unit: "min" },
    { input: "q 30 minutes", period: 30, unit: "min" },
    { input: "q 15 minutes", period: 15, unit: "min" },
    { input: "q30 m", period: 30, unit: "min" }
  ];

  for (const { input, period, unit } of cases) {
    it(`parses ${input} as every ${period} ${unit}`, () => {
      const result = parseSig(input);
      expect(result.fhir.timing?.repeat).toMatchObject({ period, periodUnit: unit });
    });
  }
});

describe("smart meal expansion", () => {
  it("keeps generic tokens when expansion disabled", () => {
    const result = parseSig("1x2 po ac");
    expect(result.fhir.timing?.repeat?.when).toEqual([EventTiming["Before Meal"]]);
  });

  it("expands before-meal tokens when enabled", () => {
    const result = parseSig("1x2 po ac", { smartMealExpansion: true });
    expect(result.fhir.timing?.repeat?.when).toEqual([
      EventTiming["Before Breakfast"],
      EventTiming["Before Dinner"]
    ]);
  });

  it("supports alternate meal pairing", () => {
    const result = parseSig("1x2 po pc", {
      smartMealExpansion: true,
      twoPerDayPair: "breakfast+lunch"
    });
    expect(result.fhir.timing?.repeat?.when).toEqual([
      EventTiming["After Breakfast"],
      EventTiming["After Lunch"]
    ]);
  });

  it("expands after-meal abbreviations for twice-daily cadences", () => {
    const result = parseSig("1 tab bid pc", { smartMealExpansion: true });
    expect(result.fhir.timing?.repeat?.when).toEqual([
      EventTiming["After Breakfast"],
      EventTiming["After Dinner"]
    ]);
  });

  it("translates after-meal tokens using detected frequency when enabled", () => {
    const result = parseSig("1 tab tid pc", { smartMealExpansion: true });
    expect(result.fhir.timing?.repeat?.when).toEqual([
      EventTiming["After Breakfast"],
      EventTiming["After Lunch"],
      EventTiming["After Dinner"]
    ]);
  });

  it("expands after-meal abbreviations for four daily doses", () => {
    const result = parseSig("1 tab qid pc", { smartMealExpansion: true });
    expect(result.fhir.timing?.repeat?.when).toEqual([
      EventTiming["After Breakfast"],
      EventTiming["After Lunch"],
      EventTiming["After Dinner"],
      EventTiming["Before Sleep"]
    ]);
  });

  it("expands after-meal tokens with additional bedtime events", () => {
    const result = parseSig("1 tab qid pc hs", { smartMealExpansion: true });
    expect(result.fhir.timing?.repeat?.when).toEqual([
      EventTiming["After Breakfast"],
      EventTiming["After Lunch"],
      EventTiming["After Dinner"],
      EventTiming["Before Sleep"]
    ]);
  });

  it("adds bedtime for four with-meal doses", () => {
    const result = parseSig("1x4 po wm", { smartMealExpansion: true });
    expect(result.fhir.timing?.repeat?.when).toEqual([
      EventTiming.Breakfast,
      EventTiming.Lunch,
      EventTiming.Dinner,
      EventTiming["Before Sleep"]
    ]);
  });

  it("avoids expanding when only interval cadence present", () => {
    const result = parseSig("po ac q6h", { smartMealExpansion: true });
    expect(result.fhir.timing?.repeat?.when).toEqual([EventTiming["Before Meal"]]);
  });

  it("expands default with-meal timings for twice-daily frequency", () => {
    const result = parseSig("1x2", { smartMealExpansion: true });
    expect(result.fhir.timing?.repeat?.when).toEqual([
      EventTiming.Breakfast,
      EventTiming.Dinner
    ]);
  });

  it("expands default with-meal timings for thrice-daily frequency", () => {
    const result = parseSig("1x3", { smartMealExpansion: true });
    expect(result.fhir.timing?.repeat?.when).toEqual([
      EventTiming.Breakfast,
      EventTiming.Lunch,
      EventTiming.Dinner
    ]);
  });

  it("expands default with-meal timings for four daily doses", () => {
    const result = parseSig("1x4", { smartMealExpansion: true });
    expect(result.fhir.timing?.repeat?.when).toEqual([
      EventTiming.Breakfast,
      EventTiming.Lunch,
      EventTiming.Dinner,
      EventTiming["Before Sleep"]
    ]);
  });

  it("avoids default expansion when more than four daily doses are requested", () => {
    const result = parseSig("1x5", { smartMealExpansion: true });
    expect(result.fhir.timing?.repeat?.when).toBeUndefined();
    expect(result.fhir.timing?.repeat?.frequency).toBe(5);
  });

  it("preserves generic meal timing for high-frequency after-meal dosing", () => {
    const result = parseSig("1 tab 5 times daily pc", { smartMealExpansion: true });
    expect(result.fhir.timing?.repeat?.when).toEqual([EventTiming["After Meal"]]);
    expect(result.fhir.timing?.repeat?.frequency).toBe(5);
  });

  it("does not expand cadence-only schedules when a non-enteral body site is present", () => {
    const result = parseSig("apply to head bid", { smartMealExpansion: true });
    expect(result.fhir.site?.text).toBe("head");
    expect(result.fhir.timing?.repeat?.when).toBeUndefined();
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 2,
      period: 1,
      periodUnit: "d"
    });
  });

  it("does not expand generic meal tokens for non-enteral routes", () => {
    const result = parseSig("1 mL IM bid pc", { smartMealExpansion: true });
    expect(result.fhir.timing?.repeat?.when).toEqual([EventTiming["After Meal"]]);
    expect(result.fhir.route?.coding?.[0]?.code).toBe(
      SNOMEDCTRouteCodes["Intramuscular route"]
    );
  });

  it("uses the default heuristic when no smart meal scope override is provided", () => {
    const result = parseSig("1x2", { smartMealExpansion: true });
    expect(result.fhir.timing?.repeat?.when).toEqual([
      EventTiming.Breakfast,
      EventTiming.Dinner
    ]);
  });

  it("supports excluding dosage forms from smart meal expansion", () => {
    const result = parseSig("1x2", {
      smartMealExpansion: true,
      context: { dosageForm: "tablet" },
      smartMealExpansionScope: { excludeDosageForms: ["tablet"] }
    });
    expect(result.fhir.timing?.repeat?.when).toBeUndefined();
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 2,
      period: 1,
      periodUnit: "d"
    });
  });

  it("supports including dosage forms for smart meal expansion", () => {
    const result = parseSig("1x2", {
      smartMealExpansion: true,
      context: { dosageForm: "tablet" },
      smartMealExpansionScope: { includeDosageForms: ["tablet"] }
    });
    expect(result.fhir.timing?.repeat?.when).toEqual([
      EventTiming.Breakfast,
      EventTiming.Dinner
    ]);
  });

  it("supports including routes for smart meal expansion", () => {
    const result = parseSig("1 tab po bid pc", {
      smartMealExpansion: true,
      smartMealExpansionScope: {
        includeRoutes: [RouteCode["Oral route"]]
      }
    });
    expect(result.fhir.timing?.repeat?.when).toEqual([
      EventTiming["After Breakfast"],
      EventTiming["After Dinner"]
    ]);
  });

  it("gives exclusions precedence over includes in smart meal scope overrides", () => {
    const result = parseSig("1 tab po bid pc", {
      smartMealExpansion: true,
      context: { dosageForm: "tablet" },
      smartMealExpansionScope: {
        includeRoutes: [RouteCode["Oral route"]],
        excludeDosageForms: ["tablet"]
      }
    });
    expect(result.fhir.timing?.repeat?.when).toEqual([EventTiming["After Meal"]]);
  });

  it("respects meal relation from context during default expansion", () => {
    const result = parseSig("1x3", {
      smartMealExpansion: true,
      context: { mealRelation: EventTiming["After Meal"] }
    });
    expect(result.fhir.timing?.repeat?.when).toEqual([
      EventTiming["After Breakfast"],
      EventTiming["After Lunch"],
      EventTiming["After Dinner"]
    ]);
  });

  it("supports before-meal relation from context during default expansion", () => {
    const result = parseSig("1x2", {
      smartMealExpansion: true,
      context: { mealRelation: EventTiming["Before Meal"] }
    });
    expect(result.fhir.timing?.repeat?.when).toEqual([
      EventTiming["Before Breakfast"],
      EventTiming["Before Dinner"]
    ]);
  });
});

describe("when ordering", () => {
  it("sorts EventTiming entries chronologically by default", () => {
    const result = parseSig("hs ac", { context: TAB_CONTEXT });
    expect(result.fhir.timing?.repeat?.when).toEqual([
      EventTiming["Before Meal"],
      EventTiming["Before Sleep"]
    ]);
  });

  it("uses provided event clock anchors when ordering", () => {
    const result = parseSig("breakfast lunch dinner", {
      eventClock: {
        [EventTiming.Dinner]: "07:00",
        [EventTiming.Breakfast]: "12:00",
        [EventTiming.Lunch]: "18:00"
      }
    });
    expect(result.fhir.timing?.repeat?.when).toEqual([
      EventTiming.Dinner,
      EventTiming.Breakfast,
      EventTiming.Lunch
    ]);
  });
});

describe("event timing token coverage", () => {
  for (const [token, expected] of Object.entries(EVENT_TIMING_TOKENS)) {
    it(`maps ${token} to ${expected}`, () => {
      const result = parseSig(token);
      expect(result.fhir.timing?.repeat?.when).toEqual([expected]);
    });
  }
});

describe("topical workflow and timing", () => {
  it("maps qam and qpm timing abbreviations", () => {
    const morning = parseSig("apply cream qam");
    expect(morning.fhir.timing?.repeat?.when).toEqual([EventTiming.Morning]);

    const evening = parseSig("apply cream qpm");
    expect(evening.fhir.timing?.repeat?.when).toEqual([EventTiming.Evening]);
  });

  it("maps nightly to night timing", () => {
    const result = parseSig("apply cream nightly");
    expect(result.fhir.timing?.repeat?.when).toEqual([EventTiming.Night]);
  });

  it("does not treat hygiene workflow phrases as meal timing", () => {
    const result = parseSig("apply after showering bid");
    expect(result.fhir.timing?.repeat?.when).toBeUndefined();
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 2,
      period: 1,
      periodUnit: "d"
    });
    expect(result.fhir.patientInstruction).toBe("after showering");
    expect(result.meta.normalized.patientInstruction).toBe("after showering");
  });

  it("keeps duration-based workflow phrases out of dose parsing", () => {
    const result = parseSig("leave on for 10 minutes then rinse");
    expect(result.fhir.doseAndRate).toBeUndefined();
    expect(result.fhir.patientInstruction).toBe(
      "leave on for 10 minutes then rinse"
    );
    expect(result.meta.normalized.patientInstruction).toBe(
      "leave on for 10 minutes then rinse"
    );
  });

  it("keeps workflow timing separate from medication timing", () => {
    const result = parseSig("apply to scalp nightly and rinse in the morning");
    expect(result.fhir.site?.text).toBe("scalp");
    expect(result.fhir.timing?.repeat?.when).toEqual([EventTiming.Night]);
    expect(result.fhir.patientInstruction).toBe("rinse in the morning");
    expect(result.meta.normalized.patientInstruction).toBe("rinse in the morning");
  });

  it("keeps explicit topical sites introduced by at after timing phrases", () => {
    const bedtime = parseSig("apply before bed at lesion");
    expect(bedtime.fhir.site?.text).toBe("lesion");
    expect(bedtime.fhir.timing?.repeat?.when).toEqual([EventTiming["Before Sleep"]]);
    expect(bedtime.meta.leftoverText).toBeUndefined();
    expect(bedtime.longText).toBe("Apply the medication at bedtime to the lesion.");

    const twiceDaily = parseSig("apply twice daily at wound");
    expect(twiceDaily.fhir.site?.text).toBe("wound");
    expect(twiceDaily.fhir.timing?.repeat).toMatchObject({
      frequency: 2,
      period: 1,
      periodUnit: "d"
    });
    expect(twiceDaily.meta.leftoverText).toBeUndefined();
    expect(twiceDaily.longText).toBe("Apply the medication twice daily to the wound.");
  });
});

describe("topical product forms and workflow", () => {
  it("consumes common topical product nouns without stray leftovers", () => {
    const scalp = parseSig("apply cream to scalp twice daily");
    expect(scalp.meta.leftoverText).toBeUndefined();
    expect(scalp.fhir.route?.coding?.[0]?.code).toBe(
      SNOMEDCTRouteCodes["Topical route"]
    );

    const face = parseSig("apply moisturizer to face every morning");
    expect(face.meta.leftoverText).toBeUndefined();
    expect(face.fhir.site?.text).toBe("face");
  });

  it("keeps shampoo instructions on the FHIR method path", () => {
    const result = parseSig("use shampoo daily");
    expect(result.meta.leftoverText).toBeUndefined();
    expect(result.fhir.method?.text).toBe("Use shampoo");
    expectPrimitiveTranslation(result.fhir.method?._text, "th", "สระ");
    expect(result.longText).toBe("Use shampoo topically once daily.");
  });

  it("preserves reapply nuance in Thai when method text is present", () => {
    const result = parseSig("reapply sunscreen every 2 hours", { locale: "th" });
    expect(result.longText).toBe("ทากันแดดซ้ำทุก 2 ชั่วโมง.");
  });

  it("round-trips Thai method text from standard FHIR translation extensions", () => {
    const parsed = parseSig("reapply sunscreen every 2 hours");
    const fromFhir = fromFhirDosage(parsed.fhir, { locale: "th" });
    expect(fromFhir.longText).toBe("ทากันแดดซ้ำทุก 2 ชั่วโมง.");
  });

  it("falls back to method display translations when method.text is absent", () => {
    const parsed = parseSig("spray once daily to nostril");
    const dosage = {
      ...parsed.fhir,
      method: {
        coding: parsed.fhir.method?.coding
      }
    };
    const fromFhir = fromFhirDosage(dosage, { locale: "th" });
    expect(fromFhir.longText).toBe("พ่นเข้ารูจมูก วันละครั้ง.");
  });

  it("prefers method.text overrides over generic translated method displays in Thai", () => {
    const parsed = parseSig("reapply sunscreen every 2 hours");
    const coding = parsed.fhir.method?.coding?.[0];
    const dosage = {
      ...parsed.fhir,
      method: {
        text: "Reapply",
        coding: coding ? [coding] : undefined
      }
    };
    const fromFhir = fromFhirDosage(dosage, { locale: "th" });
    expect(fromFhir.longText).toBe("ทาซ้ำทุก 2 ชั่วโมง.");
  });

  it("renders shampoo naturally in Thai when product form is preserved", () => {
    const result = parseSig("use shampoo daily", { locale: "th" });
    expect(result.longText).toBe("สระวันละครั้ง.");
  });

  it("captures topical quantity units including metric ribbons", () => {
    const pumps = parseSig("apply 2 pumps to face every morning");
    expect(pumps.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({
      value: 2,
      unit: "pump"
    });

    const ribbon = parseSig("apply 0.5 cm ribbon to eyelid nightly");
    expect(ribbon.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({
      value: 0.5,
      unit: "cm ribbon"
    });
  });

  it("stores workflow phrases in patientInstruction", () => {
    const sun = parseSig("apply sunscreen before sun exposure");
    expect(sun.fhir.patientInstruction).toBe("before sun exposure");
    expect(sun.fhir.timing?.repeat?.dayOfWeek).toBeUndefined();

    const dressing = parseSig("apply with each dressing change");
    expect(dressing.fhir.patientInstruction).toBe("with each dressing change");

    const bowel = parseSig("apply after each bowel movement");
    expect(bowel.fhir.patientInstruction).toBe("after each bowel movement");
  });

  it("does not force suppository or pessary units onto creams", () => {
    const vaginal = parseSig("apply vaginal cream nightly");
    expect(vaginal.fhir.route?.coding?.[0]?.code).toBe(
      SNOMEDCTRouteCodes["Per vagina"]
    );
    expect(vaginal.fhir.doseAndRate).toBeUndefined();
    expect(vaginal.meta.leftoverText).toBeUndefined();

    const rectal = parseSig("apply rectal cream twice daily");
    expect(rectal.fhir.route?.coding?.[0]?.code).toBe(
      SNOMEDCTRouteCodes["Per rectum"]
    );
    expect(rectal.fhir.doseAndRate).toBeUndefined();
    expect(rectal.meta.leftoverText).toBeUndefined();
  });
});

describe("canonical clause ir", () => {
  it("exposes a canonical clause for single parses", () => {
    const input = "1 tab po bid prn pain";
    const result = parseSig(input);
    expect(result.meta.canonical.clauses).toHaveLength(1);
    expect(result.meta.canonical.clauses[0]).toMatchObject({
      kind: "administration",
      rawText: input,
      dose: { value: 1, unit: "tab" },
      route: { code: RouteCode["Oral route"], text: "by mouth" },
      schedule: {
        frequency: 2,
        period: 1,
        periodUnit: "d",
        timingCode: "BID"
      },
      prn: {
        enabled: true,
        reason: {
          text: "pain",
          coding: { code: "22253000", display: "Pain", system: "http://snomed.info/sct" }
        }
      }
    });
    expect(result.meta.canonical.clauses[0]?.span).toEqual({
      start: 0,
      end: input.length
    });
  });

  it("rebases canonical clause spans across segmented batches", () => {
    const input = "1 tab po daily, apply cream to scalp nightly";
    const secondClause = "apply cream to scalp nightly";
    const secondStart = input.indexOf(secondClause);
    const result = parseSig(input);

    expect(result.meta.canonical.clauses).toHaveLength(2);
    expect(result.meta.canonical.clauses[0]?.span).toEqual({
      start: 0,
      end: "1 tab po daily".length
    });
    expect(result.meta.canonical.clauses[1]).toMatchObject({
      rawText: secondClause,
      route: { code: RouteCode["Topical route"] },
      site: { text: "scalp" },
      schedule: { when: [EventTiming.Night] }
    });
    expect(result.meta.canonical.clauses[1]?.span).toEqual({
      start: secondStart,
      end: secondStart + secondClause.length
    });
  });
});

describe("assume single discrete dose", () => {
  it("does not assume a dose when disabled", () => {
    const result = parseSig("po tid", { context: { dosageForm: "tablet" } });
    expect(result.fhir.doseAndRate).toBeUndefined();
  });

  it("defaults to one unit when enabled", () => {
    const result = parseSig("po tid", {
      context: { dosageForm: "tablet" },
      assumeSingleDiscreteDose: true
    });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
  });

  it("ignores non-discrete units", () => {
    const result = parseSig("po tid", {
      context: { defaultUnit: "mg" },
      assumeSingleDiscreteDose: true
    });
    expect(result.fhir.doseAndRate).toBeUndefined();
  });
});

describe("time-based schedules", () => {
  it("parses single 24h time", () => {
    const result = parseSig("at 9:00");
    expect(result.fhir.timing?.repeat?.timeOfDay).toEqual(["09:00:00"]);
  });

  it("parses multiple comma-separated times", () => {
    const result = parseSig("at 9:00, 10:00, 22:00");
    expect(result.fhir.timing?.repeat?.timeOfDay).toEqual(["09:00:00", "10:00:00", "22:00:00"]);
  });

  it("parses times with am/pm", () => {
    const result = parseSig("@ 9 am, 2 pm, 10:30 pm");
    expect(result.fhir.timing?.repeat?.timeOfDay).toEqual(["09:00:00", "14:00:00", "22:30:00"]);
  });

  it("parses compact @time with day filters", () => {
    const result = parseSig("1 tab po @12:00 sat/sun");
    expect(result.fhir.timing?.repeat).toMatchObject({
      timeOfDay: ["12:00:00"],
      dayOfWeek: ["sat", "sun"]
    });
  });

  it("parses dot-separated times", () => {
    const result = parseSig("at 14.00, 16.30");
    expect(result.fhir.timing?.repeat?.timeOfDay).toEqual(["14:00:00", "16:30:00"]);
  });

  it("parses times without prefix", () => {
    const result = parseSig("9:00 10:00");
    expect(result.fhir.timing?.repeat?.timeOfDay).toEqual(["09:00:00", "10:00:00"]);
  });

  it("formats timeOfDay in short text", () => {
    const result = parseSig("at 9:00, 22:00");
    expect(result.shortText).toContain("09:00,22:00");
  });

  it("formats timeOfDay in long text", () => {
    const result = parseSig("at 9:00, 10:00 pm");
    expect(result.longText).toContain("at 9:00 am, 10:00 pm");
  });

  it("formats multiple meals and times in English", () => {
    const result = parseSig("1 tab with breakfast, with lunch, and at 9 am, 5 pm");
    expect(result.longText).toBe("Use 1 tablet with breakfast, with lunch and at 9:00 am, 5:00 pm.");
  });

  it("formats generic 'with meals' and specific times in English", () => {
    const result = parseSig("1 tab with meals and @ 10:00");
    expect(result.longText).toBe("Use 1 tablet with meals and at 10:00 am.");
  });

  it("formats complex mixed schedules in Thai", () => {
    const cases = [
      {
        input: "1 tab with breakfast, with lunch, and at 9 am, 5 pm",
        expected: "ใช้ ครั้งละ 1 เม็ด พร้อมอาหารเช้า, พร้อมอาหารกลางวัน และ เวลา 09:00, 17:00."
      },
      {
        input: "1 tab with meals and @ 10:00",
        expected: "ใช้ ครั้งละ 1 เม็ด พร้อมอาหาร และ เวลา 10:00."
      },
      {
        input: "1 tab ac and @ 8:00",
        expected: "ใช้ ครั้งละ 1 เม็ด ก่อนอาหาร และ เวลา 08:00."
      }
    ];

    for (const { input, expected } of cases) {
      const result = parseSig(input, { locale: "th" });
      expect(result.longText).toBe(expected);
    }
  });

  it("consumes 'and' connector between schedule blocks to prevent leakage", () => {
    const result = parseSig("1 tab with meals and at 9:00");
    // Ensure "and" is not in additional instructions
    expect(result.fhir.additionalInstruction).toBeUndefined();
    expect(result.longText).not.toContain("and.");
    expect(result.longText).toBe("Use 1 tablet with meals and at 9:00 am.");
  });
});

describe("issue regression tests", () => {
  it("excludes already consumed frequency from PRN reason (Issue 1)", () => {
    const result = parseSig("1 tab po q4-6hr prn for pain", { locale: "th" });
    expect(result.meta.normalized.prnReason?.text).toBe("pain");
    expect(result.fhir.timing?.repeat?.period).toBe(4);
    expect(result.fhir.timing?.repeat?.periodMax).toBe(6);
  });

  it("handles PRN before frequency (Issue 1 fallback)", () => {
    const result = parseSig("1 tab po prn q4-6hr for pain", { locale: "th" });
    expect(result.meta.normalized.prnReason?.text).toBe("pain");
    expect(result.fhir.timing?.repeat?.period).toBe(4);
    expect(result.fhir.timing?.repeat?.periodMax).toBe(6);
  });

  it("supports 'with meal' and 'with food' instructions (Issue 2)", () => {
    const mealCases = ["1 tab po with meal", "1 tab po with meals", "1 tab po with food", "1 tab po cc"];
    for (const input of mealCases) {
      const result = parseSig(input, { locale: "th" });
      expect(result.fhir.timing?.repeat?.when).toContain("C");
      expect(result.longText).toContain("พร้อมอาหาร");
    }
  });

  it("translates common PRN reasons to Thai", () => {
    const cases = [
      { input: "1 tab prn pain", expected: "ใช้ ครั้งละ 1 เม็ด ใช้เมื่อจำเป็นสำหรับ ปวด." },
      { input: "1 tab prn fever", expected: "ใช้ ครั้งละ 1 เม็ด ใช้เมื่อจำเป็นสำหรับ ไข้." },
      { input: "1 tab prn sleep", expected: "ใช้ ครั้งละ 1 เม็ด ใช้เมื่อจำเป็นสำหรับ นอนหลับ." }
    ];
    for (const { input, expected } of cases) {
      const result = parseSig(input, { locale: "th" });
      expect(result.longText).toBe(expected);
    }
  });

  it("consumes optional 'for' after 'prn' to avoid duplication", () => {
    const result = parseSig("1 tab po prn for pain");
    expect(result.meta.normalized.prnReason?.text).toBe("pain");
    expect(result.longText).toBe("Take 1 tablet orally as needed for pain.");
  });

  it("consumes other introductory PRN connectors", () => {
    const cases = [
      { input: "1 tab prn if pain", reason: "pain" },
      { input: "1 tab prn when pain", reason: "pain" },
      { input: "1 tab prn upon pain", reason: "pain" },
      { input: "1 tab prn due to pain", reason: "pain" },
      { input: "1 tab prn to pain", reason: "pain" }
    ];

    for (const { input, reason } of cases) {
      const result = parseSig(input);
      expect(result.meta.normalized.prnReason?.text).toBe(reason);
      expect(result.longText).toContain(`as needed for ${reason}`);
    }
  });
});
