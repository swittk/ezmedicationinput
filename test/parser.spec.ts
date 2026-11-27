import { tokenize } from "../src/parser";
import { nextDayOnsetAt } from "../src/hpsg/rule-context";
import { describe,expect,it } from "vitest";
import retainedCourseProfile from "../fhir/r5/medication-r6-course-details.json";
import { R5_SOURCE_ONLY_MAXIMUM_URL,administrationFromR5,courseFromR6,courseToR5,courseToR6 } from "../src/adapters/canonical-course";
import { R6_DRAFT_STEPS_SOURCE_URL } from "../src/adapters/r6-editable-metadata";
import { buildAdditionalInstructionFramesFromCoding } from "../src/advice";
import { BODY_SITE_SPATIAL_RELATION_EXTENSION_URL } from "../src/body-site-spatial";
import { BODY_SITE_ADMINISTRATION_TARGET_COUNT_EXTENSION_URL } from "../src/body-site-target";
import type { CanonicalCourse } from "../src/canonical/course";
import { numericAdministrationLimits } from "../src/canonical/course";
import { normalizeDosageForm } from "../src/context";
import { COURSE_CYCLE_COUNT_EXTENSION_URL,DOSAGE_ALTERNATIVE_CHOICE_URL,DOSAGE_DETAILS_R5_URL,DOSAGE_RECONCILIATION_SOURCE_URL,DOSAGE_RENDERED_INSTRUCTION_R5_URL,DOSAGE_RETAINED_R5_SEQUENCE_URL,PARALLEL_COMPONENT_PHASE_ORIGIN_URL,R5_EXPRESSION_SLOT_SOURCE_URL,conditionToR6,decodeR5RetainedFields,decodeR6SourceMetadata,dosageMatchesSavedProjection,dosageProjectionFingerprint,encodeR5RetainedFields,encodeR6SourceMetadata,fromR6Dosage,getCourseCycleCount,getDosageExcludedDates,getDosageSourceTextAgreement,readRetainedField,setDosageAlternativeChoice,toEzDosages,withDosageEditProvenance } from "../src/dosage-course";
import { CYCLE_DAY_ELIGIBILITY_EXTENSION_URL,TIMING_ADDITIONAL_CLOCK_EXTENSION_URL,TIMING_ADMINISTRATION_DURATION_EXTENSION_URL,TIMING_FREQUENCY_MIN_EXTENSION_URL,TIMING_OFFSET_EXACT_EXTENSION_URL,canonicalFromFhir,canonicalToFhir,cycleDayConstraintExtension,getCycleDayConstraint,getTimingClocks } from "../src/fhir";
import { EMA_QUANTITY_COMPARATOR_EXTENSION_URL,EMA_QUANTITY_OPERATOR_SYSTEM,getQuantityComparator,quantityForR5,simpleQuantityForR5 } from "../src/fhir-quantity-operator";
import { getPrimitiveTranslation,getPrimitiveTranslations,FHIR_TRANSLATION_EXTENSION_URL as reviewFHIR_TRANSLATION_EXTENSION_URL } from "../src/fhir-translations";
import type { CanonicalInstructionGraph,EzDosage,FhirDosage,FhirElement,FhirR6Dosage,FhirR6DosageCondition,FhirR6DosageStep,FhirR6PrimitiveElement,FhirR6Quantity,FhirR6RelativeTime,FhirR6Timing,FhirRatio,FhirReference } from "../src/index";
import { AdviceArgumentRole,AdviceForce,AdviceModality,FhirDayOfWeek,FhirPeriodUnit,buildBodySiteSpatialRelationExtension,buildInstructionGraphExtension,calculateTotalUnits,cloneBodySiteSpatialRelation,formatCanonicalCourse,formatSig,formatSigBatch,fromDosageDetails,fromFhir,fromFhirDosage,getBodySiteCode,getBodySiteCodeAsync,getBodySiteText,getBodySiteTextAsync,getDoseUnitSemantics,importCanonicalCourse,inferMedicationLocale,listDoseUnitTerminology,listMedicationSurfaceSegmenters,listSupportedBodySiteGrammar,listSupportedBodySiteText,lookupBodySite,nextDueDoses,parseBodySiteSpatialRelationExtension,parseInstructionActions,parseInstructionGraphExtension,parseSig as parseProductionSig,parseSig as parsePublicSig,projectCanonicalCourse,registerMedicationDateResolver,registerMedicationLocaleDetector,registerMedicationSurfaceSegmenter,parseSig as reviewParseSig,suggestBodySiteText,suggestBodySites,toDosageDetails,toFhirR5Dosages,type FhirExtension } from "../src/index";
import { MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL } from "../src/instruction-graph-fhir";
import {
DEFAULT_BODY_SITE_SNOMED,
DEFAULT_UNIT_SYNONYMS,
EVENT_TIMING_TOKENS,
ROUTE_TEXT
} from "../src/maps";
import {
SNOMED_CT_BILATERAL_QUALIFIER_CODE,
SNOMED_CT_FINDING_SITE_ATTRIBUTE_CODE,
SNOMED_CT_LATERALITY_ATTRIBUTE_CODE,
SNOMED_CT_TOPOGRAPHICAL_MODIFIER_CODE
} from "../src/snomed";
import type { AdviceFrame,EzCourseMetadata,FhirR6DosageInstruction,FhirR6DosageSafety,FhirR6DoseLimit,FhirR6Extension,FormatOptions,ParseOptions } from "../src/types";
import {
AdvicePolarity,
AdviceRelation,
EventTiming,
RouteCode,
SNOMEDCTRouteCodes,
SiteCodeLookupRequest
} from "../src/types";
import { parseSig,parseSigAsync } from "./helpers/r5-parser";

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

function translationPrimitive(locale: string, value: string) {
  return {
    extension: [
      {
        url: FHIR_TRANSLATION_EXTENSION_URL,
        extension: [
          { url: "lang", valueCode: locale },
          { url: "content", valueString: value }
        ]
      }
    ]
  };
}

describe("parseSig core scenarios", () => {
  it("parses 1x3 po pc", () => {
    const result = parseSig("1x3 po pc", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
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
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1.5, unit: "tab" });
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
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1.5, unit: "tab" });
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

  it("parses clinician shorthand leading-decimal doses", () => {
    const spaced = parseSig("take .5 tablet daily");
    expect(spaced.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 0.5, unit: "tab" });
    expect(spaced.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
    expect(spaced.meta.leftoverText).toBeUndefined();

    const compact = parseSig("take .5tab daily");
    expect(compact.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 0.5, unit: "tab" });
    expect(compact.meta.leftoverText).toBeUndefined();

    const thai = parseSig("รับประทาน .5 เม็ด หลังอาหารเช้า");
    expect(thai.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 0.5, unit: "tab" });
    expect(thai.fhir.timing?.repeat?.when).toEqual(["PCM"]);
    expect(thai.meta.leftoverText).toBeUndefined();
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
    expect(result.items[0].fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
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
    expect(result.items[0].fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 10, unit: "tab" });
    expect(result.items[0].fhir.timing?.repeat?.when).toEqual([EventTiming["Before Breakfast"]]);
    expect(result.items[1].fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 12, unit: "tab" });
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
    expect(result.items[0].fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(result.items[0].fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Oral route"]);
    expect(getTimingClocks(result.items[0].fhir.timing?.repeat)).toEqual(["08:00:00"]);
    expect(result.items[0].fhir.timing?.repeat?.timeOfDay).toBeUndefined();
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
    expect(result.shortText).toBe("1 drop OPH in both eyes Q15MIN x8");
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

  it("models alternative daily frequencies as a range rather than count plus frequency", () => {
    for (const source of ["once or twice daily", "1 or 2 times daily"]) {
      const result = parseSig(source, { locale: "en" });
      expect(result.meta.canonical.clauses[0]?.schedule).toMatchObject({
        frequency: 1,
        frequencyMax: 2,
        period: 1,
        periodUnit: "d"
      });
      expect(result.meta.canonical.clauses[0]?.schedule?.count).toBeUndefined();
      expect(result.meta.leftoverText).toBeUndefined();
    }

    const thai = parseSig("วันละ 1 หรือ 2 ครั้ง", { locale: "th" });
    expect(thai.meta.canonical.clauses[0]?.schedule).toMatchObject({
      frequency: 1,
      frequencyMax: 2,
      period: 1,
      periodUnit: "d"
    });
    expect(thai.meta.canonical.clauses[0]?.schedule?.count).toBeUndefined();
    expect(thai.meta.leftoverText).toBeUndefined();
  });

  it("treats once-only surface variants as one total administration", () => {
    for (const source of ["once only", "only once", "one time only", "only one time"]) {
      const result = parseSig(source, { locale: "en" });
      expect(result.meta.canonical.clauses[0]?.schedule).toMatchObject({ count: 1 });
      expect(result.meta.canonical.clauses[0]?.schedule?.frequency).toBeUndefined();
      expect(result.meta.leftoverText).toBeUndefined();
    }
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

  it("composes Thai one-time-only timing into an English vaginal bedtime instruction", () => {
    const result = parseSig("insert into vagina 1 tablet at before sleep ใช้ครั้งเดียว");
    expect(result.fhir.timing?.repeat).toMatchObject({
      count: 1,
      when: ["HS"]
    });
    expect(result.fhir.timing?.repeat?.frequency).toBeUndefined();
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Per vagina"]);
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(result.meta.leftoverText).toBeUndefined();
    expect(result.longText).toBe("Insert 1 tablet vaginally at bedtime once only.");
    expect(formatSig(result.fhir, "long", { locale: "th" })).toBe(
      "สอดครั้งละ 1 เม็ด ทางช่องคลอด ก่อนนอน ครั้งเดียว."
    );
  });

  it("keeps one-time event-relative instructions finite without coercing them to daily", () => {
    const result = parseSig("insert 1 tab pv once after menstruation ends", { context: TAB_CONTEXT });
    expect(result.fhir.timing?.repeat).toMatchObject({ count: 1 });
    expect(result.fhir.timing?.repeat?.frequency).toBeUndefined();
    expect(result.longText).toBe("Insert 1 tablet vaginally after menstruation ends once only.");
    const relative = { relation: "after", activity: { text: "menstruation ends" } };
    expect(result.meta.canonical.clauses[0].schedule?.activityTiming).toEqual([relative]);
    expect(fromFhirDosage(toFhirR5Dosages(result.fhirNext)[0]).meta.canonical.clauses[0].schedule?.activityTiming)
      .toMatchObject([relative]);
    expect(result.fhirNext.renderedInstruction).toBe("insert 1 tab pv once after menstruation ends");
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
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "drop" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("TID");
    expect(result.fhir.site?.text).toBe("right eye");
  });

  it("defaults ophthalmic units when only site hints are supplied", () => {
    const result = parseSig("1x3 OD");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "drop" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("TID");
    expect(result.fhir.site?.text).toBe("right eye");
  });

  it("interprets OD as once daily when systemic cues are present", () => {
    const result = parseSig("1 tab OD", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
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
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "drop" });
    expect(result.fhir.site?.text).toBe("right eye");
    expect(result.fhir.timing?.code).toBeUndefined();
  });

  it("treats OD as once daily for inhalation dosage-form context", () => {
    const result = parseSig("1 od", { context: { dosageForm: "inhalation" } });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "puff" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("QD");
    expect(result.fhir.site).toBeUndefined();
    expect(result.fhir.route?.coding?.[0]?.code).not.toBe(
      SNOMEDCTRouteCodes["Ophthalmic route"]
    );
  });

  it("interprets ophthalmic double OD as right eye once daily", () => {
    const result = parseSig("1 drop OD OD");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "drop" });
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
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 500, unit: "mg" });
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
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
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
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 2, unit: "puff" });
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 2,
      period: 1,
      periodUnit: "wk"
    });
  });

  it("parses numeric per-month cadence", () => {
    const result = parseSig("Apply 1 patch 1/month");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "patch" });
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
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 2, unit: "puff" });
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
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "patch" });
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Transdermal route"]);
  });

  it("infers suppository units for rectal routes", () => {
    const result = parseSig("1 pr q12h");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({
      value: 1,
      unit: "suppository"
    });
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Per rectum"]);
  });

  it("formats oral bedtime instructions", () => {
    const result = parseSig("1 mg po hs");
    expect(result.longText).toBe("Take 1 mg orally at bedtime.");
  });

  it("formats once-daily bedtime instructions without a string-level conjunction hack", () => {
    const result = parseSig("1 drop ou qd hs");
    expect(result.longText).toBe("Instill 1 drop once daily at bedtime in both eyes.");
  });

  it("normalizes spelled metric dose units", () => {
    const result = parseSig("500 milligrams po q12h");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({
      value: 500,
      unit: "mg"
    });
    expect(result.meta.normalized.unit).toBe("mg");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Oral route"]);
  });

  it("supports spelled millilitre synonyms", () => {
    const result = parseSig("10 millilitres po qd");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 10, unit: "mL" });
    expect(result.meta.normalized.unit).toBe("mL");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Oral route"]);
  });

  it("persists insulin shorthand units", () => {
    const result = parseSig("20 U sc hs");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 20, unit: "U" });
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
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 10, unit: "U" });
    expect(result.fhir.timing?.repeat?.when).toEqual([EventTiming["Before Breakfast"], EventTiming["Before Dinner"]]);
  });

  it("parses million IU notation", () => {
    const result = parseSig("2.4M IU IM once");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 2400000, unit: "IU" });
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
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 2400000, unit: "IU" });
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Intramuscular route"]);
    expect(result.fhir.timing?.repeat).toMatchObject({
      period: 1,
      periodUnit: "wk"
    });
  });

  it("keeps tablet units while mapping trailing suppository text to rectal route", () => {
    const result = parseSig("1 tab suppository");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({
      value: 1,
      unit: "tab"
    });
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Per rectum"]);
    expect(result.meta.leftoverText).toBeUndefined();
  });

  it("keeps tablet plurals while mapping shortened suppository tokens to rectal route", () => {
    const result = parseSig("11 tabs suppo");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({
      value: 11,
      unit: "tab"
    });
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Per rectum"]);
    expect(result.meta.leftoverText).toBeUndefined();
  });

  it("parses household teaspoon and tablespoon measures", () => {
    const teaspoon = parseSig("1 teaspoon po q6h");
    expect(teaspoon.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tsp" });
    expect(teaspoon.meta.normalized.unit).toBe("tsp");

    const tablespoon = parseSig("2 tablespoons po q8h");
    expect(tablespoon.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 2, unit: "tbsp" });
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
    expect(result.fhir.doseAndRate?.[0]?.doseRange).toMatchObject({
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
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("TID");
    expect(result.fhir.timing?.repeat?.when).toEqual(["AC"]);
  });

  it("parses daily without code", () => {
    const result = parseSig("500 mg po daily");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 500, unit: "mg" });
    expect(result.fhir.timing?.code).toBeUndefined();
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
  });

  it("parses q6h prn", () => {
    const result = parseSig("2 tab po q6h prn pain");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 2, unit: "tab" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("Q6H");
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 6, periodUnit: "h" });
    expect(result.fhir.asNeeded).toBe(true);
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
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 2, unit: "suppository" });
    expect(result.fhir.timing?.repeat).toMatchObject({
      period: 6,
      periodMax: 8,
      periodUnit: "h"
    });
    expect(result.fhir.asNeeded).toBe(true);
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

  it("does not invent swallowing-whole meaning from negative crush/chew precautions", () => {
    const result = parseSig("1 tab po daily - do not crush or chew", { context: TAB_CONTEXT });
    const advice = result.fhir.additionalInstruction ?? [];
    // Positive swallowing whole is NOT entailed by prohibiting two forms of
    // manipulation; attributing 418693002 here was a false clinical assertion.
    expect(advice.some(item => item.coding?.some(c => c.code === "418693002"))).toBe(false);
    expect(result.meta.normalized.additionalInstructions?.some(item =>
      item.coding?.code === "418693002"
    )).not.toBe(true);
    const negated = result.meta.canonical.clauses[0].instructionGraph?.actions
      .filter(action => action.polarity === AdvicePolarity.Negate) ?? [];
    expect(negated.map(action => action.predicate.lemma)).toEqual(["crush", "chew"]);
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
    expect(result.longText.toLowerCase()).toContain("do not crush");
    expect(result.longText.toLowerCase()).toContain("do not chew");
    expect(result.longText.toLowerCase()).not.toContain("swallow whole");
  });

  it("preserves free-form additional instructions when unmatched", () => {
    const result = parseSig("1 tab po daily; use caution in storms");
    expect(result.fhir.additionalInstruction).toHaveLength(1);
    const { extension: instructionExtensions, ...instructionFields } = result.fhir.additionalInstruction![0];
    expect(instructionFields).toEqual({ text: "Use caution in storms", coding: undefined });
    expect(instructionExtensions).toHaveLength(1);
    expect(instructionExtensions![0].url).toBe("urn:ezmedicationinput:StructureDefinition:medication-instruction-graph");
    expect(instructionExtensions![0].extension?.map(child => child.url)).toEqual(["action"]);
    const instructionGraph = parseInstructionGraphExtension(instructionExtensions);
    expect(instructionGraph?.actions).toEqual([{
      force: "sequence", relation: AdviceRelation.In,
      predicate: {
        lemma: "use", display: "Use", semanticClass: "administration", i18n: { th: "ใช้" },
        codings: [{ system: "http://snomed.info/sct", code: "419385000", display: "Use" }]
      },
      args: [
        { role: AdviceArgumentRole.Object, text: "caution", normalized: "caution", codings: [] },
        { role: AdviceArgumentRole.Object, text: "storms", normalized: "storms", codings: [] }
      ],
      span: { start: 16, end: 37 }, sourceText: "use caution in storms", sequenceIndex: 0,
      sourceRelationCoding: { system: "http://snomed.info/sct", code: "18720000", display: "In" }
    }]);
    expect(instructionGraph?.relations).toBeUndefined();
    expect(instructionGraph?.coverage).toBeUndefined();
    expect(parseInstructionGraphExtension(result.fhir.extension)?.actions).toEqual(instructionGraph!.actions);
    expect(result.meta.normalized.additionalInstructions).toEqual([
      { text: "Use caution in storms", coding: undefined }
    ]);
  });

  it("stops PRN reason text at trailing additional instructions", () => {
    const result = parseSig("1x3 po prn vomiting; no alcohol", { context: TAB_CONTEXT });
    expect(result.fhir.asNeeded).toBe(true);
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
    expect(result.fhir.asNeededFor?.[0]?.coding?.[0]).toMatchObject({
      system: "http://snomed.info/sct",
      code: "74776002",
      display: "Itching of eye"
    });
    expectPrimitiveTranslation(
      result.fhir.asNeededFor?.[0]?.coding?.[0]?._display,
      "th",
      "คันตา"
    );
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
    expect(result.fhir.asNeededFor).toMatchObject([
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
      const codeOnlyFhir = {
        ...parsed.fhir,
        asNeededFor: parsed.fhir.asNeededFor?.map((concept) => ({
          ...concept,
          text: undefined
        }))
      };
      const codeOnlyRoundTripped = fromFhirDosage(codeOnlyFhir);
      const extensionOnlyFhir = {
        ...parsed.fhir,
        asNeededFor: parsed.fhir.asNeededFor?.map((concept) => ({
          ...concept,
          text: undefined,
          coding: concept.coding?.map((coding) => ({
            ...coding,
            display: "Pain"
          })),
          extension: [
            ...(concept.extension?.filter(
              (extension) => extension.url !== BODY_SITE_SPATIAL_RELATION_EXTENSION_URL
            ) ?? []),
            {
              url: BODY_SITE_SPATIAL_RELATION_EXTENSION_URL,
              extension: [
                { url: "relationText", valueString: "at" },
                {
                  url: "target",
                  valueCodeableConcept: { text: reason.replace(/^pain at /, "") }
                }
              ]
            }
          ]
        }))
      };
      const extensionOnlyRoundTripped = fromFhirDosage(extensionOnlyFhir);

      expect(parsed.fhir.asNeededFor?.[0]?.text).toBe(reason);
      expect(parsed.fhir.asNeededFor?.[0]?.coding?.[0]?.code).toBe(code);
      expect(roundTripped.fhir.asNeededFor?.[0]?.text).toBe(reason);
      expect(roundTripped.meta.normalized.prnReason?.text).toBe(reason);
      expect(roundTripped.longText).toBe(`Take 1 tablet orally as needed for ${reason}.`);
      expect(codeOnlyRoundTripped.meta.normalized.prnReason?.text).toBe(reason);
      expect(codeOnlyRoundTripped.longText).toBe(`Take 1 tablet orally as needed for ${reason}.`);
      expect(extensionOnlyRoundTripped.meta.normalized.prnReason?.text).toBe(reason);
      expect(extensionOnlyRoundTripped.longText).toBe(
        `Take 1 tablet orally as needed for ${reason}.`
      );
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

  it("codes common Thai and English dizziness variants consistently", () => {
    const variants = ["เวียนหัว", "มึนหัว", "มึนงง", "dizzy", "dizziness"] as const;
    for (const variant of variants) {
      const result = parseSig(`กินวันละครั้งก่อนนอนเมื่อมีอาการ${variant}`, { locale: "th" });
      expect(result.fhir.asNeededFor?.[0]?.coding?.[0]).toMatchObject({
        system: "http://snomed.info/sct",
        code: "404640003",
        display: "Dizziness"
      });
      expect(result.meta.leftoverText).toBeUndefined();
    }
  });

  it("accepts Thai aliases for expanded ambulatory PRN reasons", () => {
    const cases = [
      ["1 tab po prn ปวดหัว", "25064002", "ปวดหัว"],
      ["1 tab po prn คัดจมูก", "68235000", "คัดจมูก"],
      ["1 drop ou prn ตาแดง", "703630003", "ตาแดง"],
      ["1 tab po prn แสบขัด", "49650001", "แสบขัด"],
      ["apply prn สิว", "88616000", "เป็นสิว"],
      ["1 tab po prn เมารถ", "37031009", "เมารถ"]
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
      "รับประทานครั้งละ 1 เม็ด ใช้เมื่อคิดฟุ้งซ่านหรือทำงานไม่ได้."
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

    expect(result.longText).toBe("รับประทานครั้งละ 1 เม็ด ใช้เมื่อปวดหรือมีไข้.");
    expect(result.fhir.asNeededFor).toMatchObject([
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
    expectPrimitiveTranslation(result.fhir.asNeededFor?.[0]?._text, "th", "ปวด");
    expectPrimitiveTranslation(result.fhir.asNeededFor?.[1]?._text, "th", "ไข้");
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
    // Q12H is local shorthand, not an R5 GTSAbbreviation code.
    expect(result.fhir.timing?.code?.coding).toBeUndefined();
    expect(result.fhir.timing?.code?.text).toBe("Q12H");
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
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 1, periodUnit: "wk", dayOfWeek: ["tue"] });
  });

  it("parses 1*weekly wednesday", () => {
    const result = parseSig("1*weekly wednesday", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
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
      expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
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
      expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1.5, unit: "tab" });
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
    expect(result.items[0].fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(result.items[0].fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d",
      dayOfWeek: ["mon", "tue", "wed", "thu", "fri"]
    });
    expect(result.items[1].fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1.5, unit: "tab" });
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
    expect(result.items[0].fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(result.items[0].fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d",
      dayOfWeek: ["mon", "tue", "wed", "thu", "fri"]
    });
    expect(result.items[1].fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1.5, unit: "tab" });
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
    expect(result.fhir.timing?.code?.coding).toBeUndefined();
    expect(result.fhir.timing?.code?.text).toBe("Q2MO");
  });

  it("parses monthly token", () => {
    const result = parseSig("monthly");
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("MO");
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 1, periodUnit: "mo" });
  });

  it("maps AM to EventTiming", () => {
    const result = parseSig("1 po am", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("AM");
    expect(result.fhir.timing?.repeat?.when).toEqual(["MORN"]);
  });

  it("maps NOON", () => {
    const result = parseSig("1 po noon", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.repeat?.when).toEqual(["NOON"]);
  });

  it("keeps PM shorthand as evening without an afternoon code", () => {
    const result = parseSig("1 po pm", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.code).toEqual({ text: "PM" });
    expect(result.fhir.timing?.repeat?.when).toEqual(["EVE"]);
  });

  it("maps HS", () => {
    const result = parseSig("1xHS", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.repeat?.when).toEqual(["HS"]);
  });

  it("maps STAT to immediate timing", () => {
    const result = parseSig("1 tab po stat", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.repeat?.when).toEqual([EventTiming.Immediate]);
  });

  it("maps early morning combo", () => {
    const result = parseSig("1 tab early morning", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
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

  it.each([
    ["รับประทานก่อนอาหารเช้า", EventTiming["Before Breakfast"]],
    ["รับประทานก่อนอาหารกลางวัน", EventTiming["Before Lunch"]],
    ["รับประทานก่อนอาหารเย็น", EventTiming["Before Dinner"]],
    ["รับประทานหลังอาหารเย็น", EventTiming["After Dinner"]]
  ])("composes Thai meal-period timing %s", (sig, expected) => {
    const result = parseSig(sig, { locale: "th" });
    expect(result.fhir.timing?.repeat?.when).toEqual([expected]);
  });

  it("does not collapse explicitly coordinated before-meal and evening timings", () => {
    const result = parseSig("รับประทานก่อนอาหาร และ ตอนเย็น", { locale: "th" });
    expect(result.fhir.timing?.repeat?.when).toEqual([
      EventTiming["Before Meal"],
      EventTiming.Evening
    ]);
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
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
  });

  it("uses container unit from context", () => {
    const result = parseSig("2", {
      context: { dosageForm: "sol", containerUnit: "mL" }
    });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 2, unit: "mL" });
  });

  it("parses fractional topical container doses without treating slash fractions as clock times", () => {
    const cases = [
      ["apply half tube to arm", 0.5, "tube", "arm"],
      ["apply a half tube", 0.5, "tube", undefined],
      ["apply 1/2 tube", 0.5, "tube", undefined],
      ["apply 1/4 tube", 0.25, "tube", undefined],
      ["apply 1/4 container", 0.25, "container", undefined],
      ["apply 1/3 of bottle", 1 / 3, "bottle", undefined],
      ["apply half bottle", 0.5, "bottle", undefined],
      ["apply fifth tube", 0.2, "tube", undefined],
      ["apply sixth tube", 1 / 6, "tube", undefined],
      ["apply two fifths of bottle", 2 / 5, "bottle", undefined],
      ["apply 2 fifths of bottle", 2 / 5, "bottle", undefined],
      ["apply three quarters tube", 3 / 4, "tube", undefined],
      ["apply one twelfth container", 1 / 12, "container", undefined]
    ] as const;

    for (const [sig, value, unit, site] of cases) {
      const result = parseSig(sig);
      expect(result.fhir.doseAndRate?.[0]?.doseQuantity?.value).toBeCloseTo(value);
      expect(result.fhir.doseAndRate?.[0]?.doseQuantity?.unit).toBe(unit);
      expect(result.fhir.timing?.repeat?.timeOfDay).toBeUndefined();
      expect(result.meta.canonical.clauses[0]?.leftovers).toEqual([]);
      if (site) {
        expect(result.fhir.site?.text).toBe(site);
      }
    }
  });

  it("normalizes complex dosage forms from context", () => {
    const result = parseSig("1", { context: { dosageForm: "capsule, soft" } });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "cap" });
  });

  it("normalizes transdermal dosage forms", () => {
    const result = parseSig("1", { context: { dosageForm: "transdermal patch" } });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "patch" });
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
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "mL" });
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
    expect(result.meta.normalized.site?.coding).toMatchObject({
      system: "http://snomed.info/sct",
      code: "89545001",
      display: "Face"
    });
    expect(result.meta.normalized.site?.coding?.i18n?.th).toBe("ใบหน้า");
  });

  it("codes eyebrow, hair-region, and joint body sites with SNOMED", () => {
    const cases = [
      {
        sig: "apply ointment to eyebrow daily",
        site: "eyebrow",
        code: "392262008",
        display: "Eyebrow structure"
      },
      {
        sig: "apply ointment to left eyebrow daily",
        site: "left eyebrow",
        code: "722011002",
        display: "Structure of eyebrow of left eye region"
      },
      {
        sig: "apply ointment to both eyebrows daily",
        site: "both eyebrows",
        code: lateralizedSiteCode("392262008", SNOMED_CT_BILATERAL_QUALIFIER_CODE),
        display: "both eyebrows",
        administrationTargetCount: 2
      },
      {
        sig: "apply ointment to left & right eyebrows daily",
        site: "both eyebrows",
        code: lateralizedSiteCode("392262008", SNOMED_CT_BILATERAL_QUALIFIER_CODE),
        display: "both eyebrows",
        administrationTargetCount: 2
      },
      {
        sig: "apply ointment to moustache daily",
        site: "mustache",
        code: "256925006",
        display: "Structure of hair of mustache"
      },
      {
        sig: "apply ointment to pubic hair daily",
        site: "pubic hair",
        code: "75776007",
        display: "Structure of hair of pubis"
      },
      {
        sig: "apply ointment to armpit hair daily",
        site: "axillary hair",
        code: "75703003",
        display: "Structure of hair of axilla"
      },
      {
        sig: "apply ointment to knuckles daily",
        site: "knuckles",
        code: "70420003",
        display: "Metacarpophalangeal joint structure"
      },
      {
        sig: "apply ointment to joints daily",
        site: "joints",
        code: "81087007",
        display: "Joints"
      }
    ];

    for (const testCase of cases) {
      const result = parseSig(testCase.sig);
      expect(result.fhir.site?.text).toBe(testCase.site);
      expect(result.fhir.site?.coding?.[0]).toEqual({
        system: "http://snomed.info/sct",
        code: testCase.code,
        display: testCase.display
      });
      expect(result.meta.normalized.site?.coding).toEqual({
        system: "http://snomed.info/sct",
        code: testCase.code,
        display: testCase.display
      });
      expect(result.fhir.route?.coding?.[0]?.code).toBe(
        SNOMEDCTRouteCodes["Topical route"]
      );
      if (testCase.administrationTargetCount !== undefined) {
        expect(result.meta.normalized.site?.administrationTargetCount).toBe(
          testCase.administrationTargetCount
        );
      }
    }
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
    expect(result.longText).toContain("บริเวณที่มีอาการ");
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
      ["apply to ตาขวา", "ทาที่ตาขวา."],
      ["apply to หูสองข้าง", "ทาที่หูทั้งสองข้าง."],
      ["apply to นิ้วโป้งเท้า", "ทาบริเวณนิ้วโป้งเท้า."],
      ["apply to นิ้วก้อยเท้าซ้าย", "ทาบริเวณนิ้วก้อยเท้าซ้าย."],
      ["apply to อัณฑะ", "ทาบริเวณอัณฑะ."]
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

  it("keeps topical manner and thin-layer instructions separate from body-site text", () => {
    const cases = [
      ["apply to hairline gently", "hairline", "418449005", "Apply the medication to the hairline. Apply gently."],
      ["apply gently to lesion", "lesion", "418449005", "Apply the medication to the lesion. Apply gently."],
      ["apply to lesion gently", "lesion", "418449005", "Apply the medication to the lesion. Apply gently."],
      ["apply thinly to face", "face", "420162004", "Apply a thin layer to the face."],
      ["apply thin layer to face", "face", "420162004", "Apply a thin layer to the face."],
      ["apply thinly to lesions", "lesions", "420162004", "Apply a thin layer to the lesions."],
      ["apply thinly to lesion", "lesion", "420162004", "Apply a thin layer to the lesion."],
      ["apply thickly to face", "face", "246703001", "Apply the medication to the face. Apply thickly."],
      ["apply thick layer to face", "face", "246703001", "Apply the medication to the face. Apply thickly."],
      ["apply to lesion thickly", "lesion", "246703001", "Apply the medication to the lesion. Apply thickly."]
    ] as const;

    for (const [sig, site, instructionCode, longText] of cases) {
      const result = parseSig(sig);
      expect(result.fhir.site?.text).toBe(site);
      expect(result.fhir.additionalInstruction?.[0]?.coding?.[0]).toMatchObject({
        system: "http://snomed.info/sct",
        code: instructionCode
      });
      expect(result.longText).toBe(longText);
      expect(result.meta.canonical.clauses[0]?.leftovers).toEqual([]);
    }

    const standalone = parseSig("apply thinly");
    expect(standalone.fhir.additionalInstruction?.[0]?.coding?.[0]?.code).toBe("420162004");
    expect(standalone.longText).toBe("Apply a thin layer topically.");

    const thickStandalone = parseSig("apply thickly");
    expect(thickStandalone.fhir.additionalInstruction?.[0]?.coding?.[0]?.code).toBe("246703001");
    expect(thickStandalone.longText).toBe("Apply the medication topically. Apply thickly.");
  });

  it("emits structured spatial relation metadata for body-site relation phrases", () => {
    const result = parseProductionSig("apply below ear bid");
    const relation = result.fhir[0].site?.extension?.find(
      (extension) => extension.url === BODY_SITE_SPATIAL_RELATION_EXTENSION_URL
    );

    expect(result.fhir[0].site?.coding?.[0]).toEqual({
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
      ...result.fhir[0],
      site: { extension: result.fhir[0].site?.extension }
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

  it("preserves coordinated topical sites as concurrent, independently identified targets", () => {
    const result = parseSig("apply to scalp and forehead bid");
    expect(result.items.map(item => item.fhir.site?.text)).toEqual(["scalp", "forehead"]);
    expect(result.items.map(item => item.fhir.route?.coding?.[0]?.code)).toEqual([
      SNOMEDCTRouteCodes["Topical route"],
      SNOMEDCTRouteCodes["Topical route"]
    ]);
    expect(result.items.map(item => item.fhir.timing?.repeat?.frequency)).toEqual([2, 2]);
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

  it("fromFhirDosage computes requested formatting without rewriting supplied FHIR", () => {
    const parsed = parseSig("1 tab po pc breakfast lunch dinner");
    const original = JSON.parse(JSON.stringify(parsed.fhir));
    const again = fromFhirDosage(parsed.fhir, {
      groupMealTimingsByRelation: true,
      includeTimesPerDaySummary: true
    });
    expect(again.longText).toBe(
      "Take 1 tablet orally three times daily after breakfast, lunch and dinner."
    );
    expect(again.fhir).toEqual(original);
    expect(parsed.fhir).toEqual(original);
    expect(again.fhir.text).not.toBe(again.longText);
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

  it("fromFhirDosage retains independent range endpoints without a false compact unit", () => {
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

    expect(again.meta.canonical.clauses[0]?.dose).toBeUndefined();
    const endpoints = {
      low: { value: 1, unit: "tab" },
      high: { value: 2, unit: "mL" }
    };
    expect(again.meta.canonical.administration?.amounts?.[0].range).toEqual(endpoints);
    expect(again.fhir.doseAndRate?.[0].doseRange).toEqual(endpoints);
    expect(again.longText).toBe("Use; Dose: 1 tab – 2 mL");
  });

  it("does not emit empty timing objects when no timing data is present", () => {
    const parsed = parseSig("apply prn itch");
    expect(parsed.fhir.timing).toBeUndefined();
  });

  it("emits standard primitive translation extensions for coded site and PRN reason text", () => {
    const result = parseSig("1 drop ou q2h prn dry eyes", { locale: "th" });

    expect(result.fhir.site?.text).toBe("both eyes");
    expectPrimitiveTranslation(result.fhir.site?._text, "th", "ตาทั้งสองข้าง");
    expectPrimitiveTranslation(
      result.fhir.site?.coding?.[0]?._display,
      "th",
      "ตาทั้งสองข้าง"
    );
    expect(result.fhir.asNeededFor?.[0]?.text).toBe("dry eyes");
    expectPrimitiveTranslation(
      result.fhir.asNeededFor?.[0]?._text,
      "th",
      "ตาแห้ง"
    );
    expectPrimitiveTranslation(
      result.fhir.asNeededFor?.[0]?.coding?.[0]?._display,
      "th",
      "ตาแห้ง"
    );
  });

  it("preserves site and PRN translation primitives when importing FHIR dosage", () => {
    const result = fromFhirDosage({
      site: {
        text: "ocular surface",
        _text: translationPrimitive("th", "ผิวตา"),
        coding: [
          {
            system: "http://example.org/site",
            code: "ocular-surface",
            display: "Ocular surface",
            _display: translationPrimitive("th", "พื้นผิวตา")
          }
        ]
      },
      asNeeded: true,
      asNeededFor: [
        {
          text: "dryness",
          _text: translationPrimitive("th", "แห้ง"),
          coding: [
            {
              system: "http://example.org/reason",
              code: "dryness",
              display: "Dryness",
              _display: translationPrimitive("th", "อาการแห้ง")
            }
          ]
        }
      ]
    });

    expect(result.meta.normalized.site?.coding?.i18n).toEqual({
      th: "พื้นผิวตา"
    });
    expect(result.meta.canonical.clauses[0]?.site?.coding?.i18n).toEqual({
      th: "พื้นผิวตา"
    });
    expect(result.meta.canonical.clauses[0]?.site?.i18n).toEqual({
      th: "ผิวตา"
    });
    expect(
      result.meta.canonical.clauses[0]?.prn?.reasons?.[0]?.coding?.i18n
    ).toEqual({
      th: "อาการแห้ง"
    });
    expect(result.meta.canonical.clauses[0]?.prn?.reasons?.[0]?.i18n).toEqual({
      th: "แห้ง"
    });
  });

  it("treats oral administration verbs as route cues instead of stray advice text", () => {
    const result = parseSig("drink 10 ml prn pain");

    expect(result.shortText).toBe("10 mL PO PRN pain");
    expect(result.longText).toBe("Drink 10 mL as needed for pain.");
    expect(result.fhir.method?.text).toBe("Drink");
    expectPrimitiveTranslation(result.fhir.method?._text, "th", "ดื่ม");
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
      expect(result.fhir.asNeeded).toBe(true);
      expect(result.fhir.asNeededFor).toBeUndefined();
      expect(result.fhir.additionalInstruction?.[0]?.coding?.[0]?.code).toBe("418639000");
      expect(result.meta.normalized.additionalInstructions?.[0]?.coding?.code).toBe("418639000");
      expect(result.meta.leftoverText).toBeUndefined();
      expect(result.fhir.additionalInstruction).toHaveLength(1);
      expect(result.meta.canonical.clauses[0]?.patientInstruction).toBeUndefined();
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
        thaiText: "กลืน",
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
      expect(result.longText).toBe("รับประทานครั้งละ 1 เม็ด วันละ 2 ครั้ง.");
      expect(result.fhir.text).toBe("รับประทานครั้งละ 1 เม็ด วันละ 2 ครั้ง.");
    });

    it("formats Thai text from FHIR dosage", () => {
      const parsed = parseSig("1 tab po bid", { context: TAB_CONTEXT });
      const fromFhir = fromFhirDosage(parsed.fhir, { locale: "th" });
      expect(fromFhir.shortText).toBe("1 เม็ด PO วันละ 2 ครั้ง");
      expect(fromFhir.longText).toBe("รับประทานครั้งละ 1 เม็ด วันละ 2 ครั้ง.");
    });

    it("formats Thai site text from SNOMED coding when FHIR site.text is absent", () => {
      const parsed = parseProductionSig("apply to right temple bid");
      const fromFhir = fromFhirDosage(
        {
          ...parsed.fhir[0],
          site: {
            coding: parsed.fhir[0].site?.coding
          }
        },
        { locale: "th" }
      );

      expect(fromFhir.longText).toBe("ทาบริเวณขมับขวา วันละ 2 ครั้ง.");
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
      expect(rectal.longText).toBe("สอดทางทวารหนัก.");
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
      expect(vaginal.longText).toBe("สอดทางช่องคลอด.");
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
      expect(rectal.longText).toBe("สอดทางทวารหนัก.");
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
      expect(vaginal.longText).toBe("สอดทางช่องคลอด.");
    });

    it("translates eye site names in Thai", () => {
      const result = parseSig("1 drop OD", { locale: "th" });
      expect(result.longText).toBe("หยอดตาขวา ครั้งละ 1 หยด.");
      expect(result.fhir.text).toBe("หยอดตาขวา ครั้งละ 1 หยด.");
    });

    it("formats once-daily bedtime ocular dosing in Thai without splitting the timing", () => {
      const result = parseSig("1 drop ou qd hs", { locale: "th" });
      expect(result.longText).toBe("หยอดตาทั้งสองข้าง ครั้งละ 1 หยด วันละครั้ง ก่อนนอน.");
      expect(result.fhir.text).toBe("หยอดตาทั้งสองข้าง ครั้งละ 1 หยด วันละครั้ง ก่อนนอน.");
    });

    it("uses inhaler phrasing in Thai without สูดดม", () => {
      const result = parseSig("2 puff inhalation hs", { locale: "th" });
      expect(result.longText).toBe("สูดครั้งละ 2 พัฟ ก่อนนอน.");
      expect(result.fhir.text).toBe("สูดครั้งละ 2 พัฟ ก่อนนอน.");
    });

    it("uses inhaler phrasing in Thai for puff-only sigs", () => {
      const result = parseSig("1 puff od", { locale: "th" });
      expect(result.longText).toBe("สูดครั้งละ 1 พัฟ วันละครั้ง.");
      expect(result.fhir.text).toBe("สูดครั้งละ 1 พัฟ วันละครั้ง.");
    });

    it("translates ear site names in Thai", () => {
      const result = parseSig("1 drop right ear once daily", { locale: "th" });
      expect(result.longText).toBe("หยอดหูขวา ครั้งละ 1 หยด วันละครั้ง.");
      expect(result.fhir.text).toBe("หยอดหูขวา ครั้งละ 1 หยด วันละครั้ง.");
    });

    it("translates head site names in Thai", () => {
      const result = parseSig("apply to head bid", { locale: "th" });
      expect(result.longText).toBe("ทาบริเวณศีรษะ วันละ 2 ครั้ง.");
      expect(result.fhir.text).toBe("ทาบริเวณศีรษะ วันละ 2 ครั้ง.");

      const thaiHead = parseSig("apply to หัว", { locale: "th" });
      expect(thaiHead.longText).toBe("ทาบริเวณศีรษะ.");

      const thaiScalp = parseSig("apply ที่หนังศีรษะ", { locale: "th" });
      expect(thaiScalp.longText).toBe("ทาบริเวณหนังศีรษะ.");
    });

    it("translates spatial body-site relations in Thai", () => {
      const belowEar = parseProductionSig("apply below ear bid", { locale: "th" });
      expect(belowEar.longText).toBe("ทาบริเวณใต้หู วันละ 2 ครั้ง.");

      const topOfHand = parseSig("apply to top of hand bid", { locale: "th" });
      expect(topOfHand.longText).toBe("ทาบริเวณด้านบนของมือ วันละ 2 ครั้ง.");

      const rightAbdomen = parseSig("apply to right side of abdomen bid", { locale: "th" });
      expect(rightAbdomen.longText).toBe("ทาบริเวณท้องด้านขวา วันละ 2 ครั้ง.");

      const betweenFingers = parseSig("apply to area between fingers", { locale: "th" });
      expect(betweenFingers.longText).toBe("ทาบริเวณระหว่างนิ้วมือ.");

      const thaiBetweenFingers = parseSig("apply ระหว่างนิ้วมือ", { locale: "th" });
      expect(thaiBetweenFingers.longText).toBe("ทาบริเวณระหว่างนิ้วมือ.");

      const thaiBetweenDigits = parseSig("apply ระหว่างนิ้ว", { locale: "th" });
      expect(thaiBetweenDigits.longText).toBe("ทาบริเวณระหว่างนิ้วมือ.");

      const thaiBetweenToes = parseSig("apply ระหว่างนิ้วเท้า", { locale: "th" });
      expect(thaiBetweenToes.longText).toBe("ทาบริเวณระหว่างนิ้วเท้า.");

      const contextualThaiBetweenToes = parseSig("apply ระหว่างนิ้ว", {
        locale: "th",
        context: { bodySiteContext: "feet" }
      });
      expect(contextualThaiBetweenToes.longText).toBe("ทาบริเวณระหว่างนิ้วเท้า.");

      const rightFlank = parseSig("apply to right flank", { locale: "th" });
      expect(rightFlank.longText).toBe("ทาบริเวณสีข้างขวา.");

      const fromExtensionOnly = fromFhirDosage(
        {
          ...belowEar.fhir[0],
          site: { extension: belowEar.fhir[0].site?.extension }
        },
        { locale: "th" }
      );
      expect(fromExtensionOnly.longText).toBe("ทาบริเวณใต้หู วันละ 2 ครั้ง.");
    });

    it("translates spatial PRN reason sites in Thai", () => {
      const result = parseSig("apply prn itch below ear", { locale: "th" });
      expect(result.longText).toBe("ทาเมื่อคันใต้หู.");
      expect(result.fhir.asNeededFor?.[0]?.extension?.[0]?.url).toBe(
        BODY_SITE_SPATIAL_RELATION_EXTENSION_URL
      );
    });

    it("translates SNOMED-coded site variants in Thai without alias-specific text keys", () => {
      const temple = parseSig("apply to temple region bid", { locale: "th" });
      expect(temple.longText).toBe("ทาบริเวณขมับ วันละ 2 ครั้ง.");

      const leftHead = parseSig("apply to left side of head bid", { locale: "th" });
      expect(leftHead.longText).toBe("ทาบริเวณศีรษะซ้าย วันละ 2 ครั้ง.");
    });

    it("translates ear site variants without leaving English route text", () => {
      const cases: Array<{ sig: string; expectedSite: string }> = [
        { sig: "1 drop left ear once daily", expectedSite: "หูซ้าย" },
        { sig: "1 drop both ears QID", expectedSite: "หูทั้งสองข้าง" }
      ];

      for (const { sig, expectedSite } of cases) {
        const result = parseSig(sig, { locale: "th" });
        expect(result.longText).toContain(expectedSite);
        expect(result.longText).not.toMatch(/otic/i);
        expect(result.fhir.text).toBe(result.longText);
      }
    });

    it("combines frequency, event timing, and as-needed phrasing in Thai", () => {
      const result = parseSig("1 tab po bid ac prn pain", { locale: "th" });
      expect(result.longText).toBe(
        "รับประทานครั้งละ 1 เม็ด วันละ 2 ครั้ง ก่อนอาหาร ใช้เมื่อปวด."
      );
      expect(result.shortText).toBe(
        "1 เม็ด PO วันละ 2 ครั้ง ก่อนอาหาร ใช้เมื่อปวด"
      );
    });

    it("includes count information in Thai formatting", () => {
      const result = parseSig("1 tab po q1h for 10 times", {
        context: TAB_CONTEXT,
        locale: "th"
      });
      expect(result.shortText).toBe("1 เม็ด PO ทุก 1 ชั่วโมง x10");
      expect(result.longText).toBe("รับประทานครั้งละ 1 เม็ด ทุก 1 ชั่วโมง จำนวน 10 ครั้ง.");
      expect(result.fhir.text).toBe("รับประทานครั้งละ 1 เม็ด ทุก 1 ชั่วโมง จำนวน 10 ครั้ง.");
    });

    it("includes minute interval wording together with count information in Thai", () => {
      const result = parseSig("1 drop ou q15min x 8 doses", { locale: "th" });
      expect(result.shortText).toBe("1 หยด OPH ที่ตาทั้งสองข้าง ทุก 15 นาที x8");
      expect(result.longText).toBe("หยอดตาทั้งสองข้าง ครั้งละ 1 หยด ทุก 15 นาที จำนวน 8 ครั้ง.");
      expect(result.fhir.text).toBe("หยอดตาทั้งสองข้าง ครั้งละ 1 หยด ทุก 15 นาที จำนวน 8 ครั้ง.");
    });

    it("describes day-of-week schedules in Thai", () => {
      const result = parseSig("1 tab po every monday", { locale: "th" });
      expect(result.longText).toBe("รับประทานครั้งละ 1 เม็ด สัปดาห์ละครั้ง ในวันจันทร์.");
    });

    it("groups Thai meal timings by relation without forcing a daily count", () => {
      const result = parseSig("1 tab po pc breakfast lunch dinner", {
        locale: "th",
        groupMealTimingsByRelation: true
      });
      expect(result.longText).toBe("รับประทานครั้งละ 1 เม็ด หลังอาหารเช้า กลางวัน และเย็น.");
    });

    it("adds a Thai daily count summary independently from meal grouping", () => {
      const result = parseSig("1 tab po pc breakfast lunch dinner", {
        locale: "th",
        includeTimesPerDaySummary: true
      });
      expect(result.longText).toBe(
        "รับประทานครั้งละ 1 เม็ด วันละ 3 ครั้ง หลังอาหารเช้า, หลังอาหารกลางวัน และ หลังอาหารเย็น."
      );
    });

    it("supports grouped Thai meal timings together with a daily count summary", () => {
      const result = parseSig("1 tab po pc breakfast lunch dinner", {
        locale: "th",
        groupMealTimingsByRelation: true,
        includeTimesPerDaySummary: true
      });
      expect(result.longText).toBe(
        "รับประทานครั้งละ 1 เม็ด วันละ 3 ครั้ง หลังอาหารเช้า กลางวัน และเย็น."
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
    for (const input of Object.keys(DEFAULT_UNIT_SYNONYMS)) {
      const canonical = DEFAULT_UNIT_SYNONYMS[input];
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
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "drop" });
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
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "drop" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("Q2H");
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 2, periodUnit: "h" });
    expect(result.fhir.site?.text).toBe("left eye");
  });

  it("parses both eyes every hour", () => {
    const result = parseSig("1 drop OU Q1H");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "drop" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("Q1H");
    expect(result.fhir.site?.text).toBe("both eyes");
    expect(result.longText).toBe("Instill 1 drop every 1 hour in both eyes.");
  });

  it("normalizes each-eye phrasing to the bilateral ocular site", () => {
    const result = parseSig("1 drop each eye q2h");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "drop" });
    expect(result.fhir.site?.text).toBe("both eyes");
    expect(result.fhir.site?.coding?.[0]?.code).toBe("40638003");
    expect(
      result.fhir.site?.extension?.find(
        (extension) => extension.url === BODY_SITE_ADMINISTRATION_TARGET_COUNT_EXTENSION_URL
      )
    ).toBeUndefined();
  });

  it("parses AU as both ears", () => {
    const result = parseSig("1 drop au bid");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "drop" });
    expect(result.fhir.site?.text).toBe("both ears");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Otic route"]);
  });

  it("normalizes each-nostril phrasing to a bilateral nasal site", () => {
    const result = parseSig("1 spray each nostril bid", {
      context: { dosageForm: "nasal spray, solution" }
    });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "spray" });
    expect(result.fhir.site?.text).toBe("both nostrils");
    expect(result.fhir.site?.coding?.[0]?.code).toBe("244506005");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Nasal route"]);
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
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "mL" });
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
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 0.05, unit: "mL" });
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

  it("supports source-faithful smart meal expansion without cadence-only meal invention", () => {
    const cadenceOnly = parseSig("1x3", { smartMealExpansion: "explicit" });
    expect(cadenceOnly.fhir.timing?.repeat?.when).toBeUndefined();
    expect(cadenceOnly.fhir.timing?.repeat?.frequency).toBe(3);

    const explicitMeal = parseSig("1 tab tid pc", { smartMealExpansion: "explicit" });
    expect(explicitMeal.fhir.timing?.repeat?.when).toEqual([
      EventTiming["After Breakfast"],
      EventTiming["After Lunch"],
      EventTiming["After Dinner"]
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
  for (const token of Object.keys(EVENT_TIMING_TOKENS)) {
    const expected = EVENT_TIMING_TOKENS[token];
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
    // A recognized workflow anchor is typed timing, not opaque advice.
    const relative = { relation: "after", activity: { text: "showering" } };
    expect(result.meta.canonical.clauses[0].schedule?.activityTiming).toMatchObject([relative]);
    expect(fromFhirDosage(toFhirR5Dosages(result.fhirNext)[0]).meta.canonical.clauses[0].schedule?.activityTiming)
      .toMatchObject([relative]);
    expect(result.longText).toContain("after showering");
    expect(result.fhirNext.renderedInstruction).toBe("apply after showering bid");
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

  it("keeps a terminal 'leave on' workflow editable without treating 'on' as monthly timing", () => {
    const result = parseSig("apply cream to face and leave on");
    expect(result.fhir.site?.text).toBe("face");
    expect(result.fhir.route?.text).toBe("topical");
    expect(result.fhir.timing).toBeUndefined();
    expect(result.fhir.patientInstruction).toBe("leave on");
    expect(result.fhir.text).toBe("Apply the medication to the face; then leave on.");
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

  it("codes topical lesion sites as skin lesion with Thai translation metadata", () => {
    const result = parseSig("apply twice daily at lesion", { locale: "th" });

    expect(result.fhir.site?.text).toBe("lesion");
    expect(result.fhir.site?.coding?.[0]).toMatchObject({
      system: "http://snomed.info/sct",
      code: "95324001",
      display: "Skin lesion"
    });
    expectPrimitiveTranslation(result.fhir.site?._text, "th", "รอยโรค");
    expectPrimitiveTranslation(
      result.fhir.site?.coding?.[0]?._display,
      "th",
      "รอยโรค"
    );
    expect(result.longText).toContain("รอยโรค");
    expect(result.longText).not.toContain("lesion");
  });

  it("keeps topical lesion translations from bare-site parsing and site merging", () => {
    const bare = parseSig("apply lesion twice daily", { locale: "th" });
    expect(bare.fhir.site?.coding?.[0]?.code).toBe("95324001");
    expectPrimitiveTranslation(bare.fhir.site?._text, "th", "รอยโรค");
    expectPrimitiveTranslation(bare.fhir.site?.coding?.[0]?._display, "th", "รอยโรค");
    expect(bare.longText).toContain("รอยโรค");
    expect(bare.longText).not.toContain("lesion");

    const merged = parseSig("apply lesion at lesion twice daily", { locale: "th" });
    expect(merged.fhir.site?.coding?.[0]?.code).toBe("95324001");
    expectPrimitiveTranslation(merged.fhir.site?._text, "th", "รอยโรค");
    expectPrimitiveTranslation(merged.fhir.site?.coding?.[0]?._display, "th", "รอยโรค");
    expect(merged.longText).toContain("รอยโรค");
    expect(merged.longText).not.toContain("lesion");
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
    const parsed = parseProductionSig("spray once daily to nostril");
    const dosage = {
      ...parsed.fhir[0],
      method: {
        coding: parsed.fhir[0].method?.coding
      }
    };
    const fromFhir = fromFhirDosage(dosage, { locale: "th" });
    expect(fromFhir.longText).toBe("พ่นเข้ารูจมูก วันละครั้ง.");
  });

  it("prefers method.text overrides over generic translated method displays in Thai", () => {
    const parsed = parseProductionSig("reapply sunscreen every 2 hours");
    const coding = parsed.fhir[0].method?.coding?.[0];
    const dosage = {
      ...parsed.fhir[0],
      method: {
        text: "Reapply",
        coding: coding ? [coding] : undefined
      }
    };
    const original = structuredClone(dosage);
    const fromFhir = fromFhirDosage(dosage, { locale: "th" });
    expect(fromFhir.longText).toBe("ทาซ้ำทุก 2 ชั่วโมง.");
    expect(fromFhir.fhir).toEqual(original);
    expect(dosage).toEqual(original);
    expect(fromFhir.fhir.text).toBe(original.text);
    // The current method owns the localized preview. The complete original
    // product wording remains source data; no reverse rendering infers it.
    const currentOnly = fromFhirDosage({ ...dosage, text: undefined }, { locale: "th" });
    expect(currentOnly.longText).toBe("ทาซ้ำทุก 2 ชั่วโมง.");
  });

  it("renders shampoo naturally in Thai when product form is preserved", () => {
    const result = parseSig("use shampoo daily", { locale: "th" });
    expect(result.longText).toBe("สระวันละครั้ง.");
  });

  it("models IV drip duration per administration rather than as regimen bounds", () => {
    const result = parseSig("1 g IV Q 8h drip in 30 minutes");
    expect(result.meta.leftoverText).toBeUndefined();
    expect(result.fhir.method?.coding?.[0]).toMatchObject({
      system: "http://snomed.info/sct", code: "764794000", display: "Infuse"
    });
    expect(result.fhir.timing?.repeat).toMatchObject({
      period: 8, periodUnit: "h", duration: 30, durationUnit: "min"
    });
    expect(result.fhir.timing?.repeat?.boundsDuration).toBeUndefined();
    expect(result.meta.canonical.clauses[0]?.schedule).toMatchObject({
      timingCode: "Q8H", period: 8, periodUnit: "h",
      administrationDuration: 30, administrationDurationUnit: "min"
    });
    expect(result.longText).toBe("Infuse 1 g intravenously every 8 hours over 30 minutes.");
    expect(formatSig(result.fhir, "long", { locale: "th" })).toBe(
      "ให้ยา 1 g ทางหลอดเลือดดำแบบหยด ทุก 8 ชั่วโมง ใช้เวลาให้ยาครั้งละ 30 นาที."
    );

    const rangedDuration = {
      ...result.fhir,
      timing: {
        ...(result.fhir.timing ?? {}),
        repeat: {
          ...(result.fhir.timing?.repeat ?? {}),
          duration: 30,
          durationMax: 60,
          durationUnit: "min" as const
        }
      }
    };
    expect(formatSig(rangedDuration, "short", { locale: "en" })).toContain("over30-60min");
    expect(formatSig(rangedDuration, "short", { locale: "th" })).toContain("นาน30-60min");

    const bounded = parseSig("infuse 1 g IV q8h for 5 days");
    expect(bounded.fhir.timing?.repeat?.duration).toBeUndefined();
    expect(bounded.fhir.timing?.repeat?.boundsDuration).toMatchObject({ value: 5, code: "d" });
    expect(formatSig(bounded.fhir, "long", { locale: "th" })).toBe(
      "ให้ยา 1 g ทางหลอดเลือดดำแบบหยด ทุก 8 ชั่วโมง เป็นเวลา 5 วัน."
    );

    const injection = parseSig("inject 1 g IV q8h");
    expect(formatSig(injection.fhir, "long", { locale: "th" })).toBe(
      "ฉีดครั้งละ 1 g เข้าหลอดเลือดดำ ทุก 8 ชั่วโมง."
    );
  });

  it("captures topical quantity units including metric ribbons", () => {
    const pumps = parseSig("apply 2 pumps to face every morning");
    expect(pumps.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({
      value: 2,
      unit: "pump"
    });

    const ribbon = parseSig("apply 0.5 cm ribbon to eyelid nightly");
    expect(ribbon.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({
      value: 0.5,
      unit: "cm ribbon"
    });

    const contextualLine = parseSig("1 cm to arm");
    expect(contextualLine.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({
      value: 1,
      unit: "cm line"
    });
    expect(contextualLine.fhir.timing?.repeat?.when).toBeUndefined();

    const trailingLine = parseSig("apply to arm 1cm");
    expect(trailingLine.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({
      value: 1,
      unit: "cm line"
    });
    expect(trailingLine.fhir.site?.text).toBe("arm");
    expect(trailingLine.fhir.timing?.repeat?.when).toBeUndefined();

    const multiTokenFollowingSite = parseSig("apply 1 cm to affected area");
    expect(multiTokenFollowingSite.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({
      value: 1,
      unit: "cm line"
    });
    expect(multiTokenFollowingSite.fhir.site?.text).toBe("affected area");

    const multiTokenTrailingSite = parseSig("apply to affected area 1 cm");
    expect(multiTokenTrailingSite.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({
      value: 1,
      unit: "cm line"
    });
    expect(multiTokenTrailingSite.fhir.site?.text).toBe("affected area");
  });

  it("captures natural topical amount units with unit semantics", () => {
    const fingertip = parseSig("apply 1 fingertip unit to affected area once daily");
    expect(fingertip.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({
      value: 1,
      unit: "FTU"
    });
    expect(fingertip.meta.normalized.unit).toBe("FTU");
    expect(fingertip.meta.normalized.unitKind).toBe("product_specific_amount");
    expect(fingertip.meta.normalized.unitSemantics).toMatchObject({
      unit: "FTU",
      kind: "product_specific_amount",
      approximateQuantity: {
        value: 0.5,
        unit: "g",
        confidence: "approximate"
      }
    });
    expect(fingertip.meta.canonical.clauses[0]?.leftovers).toEqual([]);

    const compact = parseSig("apply 1 FTU to affected area once daily");
    expect(compact.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({
      value: 1,
      unit: "FTU"
    });
    expect(compact.meta.canonical.clauses[0]?.leftovers).toEqual([]);
  });

  it("captures natural SIG unit vocabulary from terminology data", () => {
    const fixtures = [
      {
        sig: "instill 1 gtt to eye once daily",
        unit: "drop",
        kind: "product_specific_amount",
        approximateQuantity: { value: 0.05, unit: "mL" }
      },
      {
        sig: "instill 1 eyedrop to eye once daily",
        unit: "drop",
        kind: "product_specific_amount",
        approximateQuantity: { value: 0.05, unit: "mL" }
      },
      {
        sig: "instill 1 eye drop to eye once daily",
        unit: "drop",
        kind: "product_specific_amount",
        approximateQuantity: { value: 0.05, unit: "mL" }
      },
      {
        sig: "inhale 2 puffs twice daily",
        unit: "puff",
        kind: "device_actuation"
      },
      {
        sig: "spray 1 actuation in nostril once daily",
        unit: "actuation",
        kind: "device_actuation"
      },
      {
        sig: "insert 1 applicatorful pv at bedtime",
        unit: "applicatorful",
        kind: "product_specific_amount"
      },
      {
        sig: "take 1 lozenge orally once daily",
        unit: "lozenge",
        kind: "counted_presentation"
      },
      {
        sig: "use 1 vial once daily",
        unit: "vial",
        kind: "counted_presentation"
      },
      {
        sig: "insert 1 ring pv once",
        unit: "ring",
        kind: "counted_presentation"
      },
      {
        sig: "apply 1 transdermal system every 3 days",
        unit: "patch",
        kind: "counted_presentation"
      },
      {
        sig: "apply 1 inch ribbon to eyelid nightly",
        unit: "inch ribbon",
        kind: "length_of_product"
      },
      {
        sig: "apply 1 cm strip to eyelid nightly",
        unit: "cm strip",
        kind: "length_of_product"
      },
      {
        sig: "apply 1 cm line to arm daily",
        unit: "cm line",
        kind: "length_of_product"
      },
      {
        sig: "1 cm to arm",
        unit: "cm line",
        kind: "length_of_product"
      },
      {
        sig: "apply pea-sized amount to face daily",
        unit: "pea-sized amount",
        kind: "product_specific_amount",
        approximateQuantity: { value: 0.25, unit: "mL" }
      },
      {
        sig: "1 pea-size to arm bid",
        unit: "pea-sized amount",
        kind: "product_specific_amount",
        approximateQuantity: { value: 0.25, unit: "mL" }
      },
      {
        sig: "1 peasize to arm",
        unit: "pea-sized amount",
        kind: "product_specific_amount",
        approximateQuantity: { value: 0.25, unit: "mL" }
      },
      {
        sig: "1 pea sized to arm",
        unit: "pea-sized amount",
        kind: "product_specific_amount",
        approximateQuantity: { value: 0.25, unit: "mL" }
      },
      {
        sig: "1 pea to arm",
        unit: "pea-sized amount",
        kind: "product_specific_amount",
        approximateQuantity: { value: 0.25, unit: "mL" }
      },
      {
        sig: "1 pea amount to arm",
        unit: "pea-sized amount",
        kind: "product_specific_amount",
        approximateQuantity: { value: 0.25, unit: "mL" }
      },
      {
        sig: "apply a pea-sized amount to face daily",
        unit: "pea-sized amount",
        kind: "product_specific_amount",
        approximateQuantity: { value: 0.25, unit: "mL" }
      },
      {
        sig: "apply 1 เม็ดถั่ว once daily to face",
        unit: "pea-sized amount",
        kind: "product_specific_amount",
        approximateQuantity: { value: 0.25, unit: "mL" }
      },
      {
        sig: "apply 1 เม็ดถั่วเขียว once daily to face",
        unit: "pea-sized amount",
        kind: "product_specific_amount",
        approximateQuantity: { value: 0.25, unit: "mL" }
      },
      {
        sig: "apply 1 เมล็ดถั่ว once daily to face",
        unit: "pea-sized amount",
        kind: "product_specific_amount",
        approximateQuantity: { value: 0.25, unit: "mL" }
      },
      {
        sig: "apply 1 palm to burn daily",
        unit: "palm",
        kind: "body_area_proxy"
      },
      {
        sig: "apply 1 handprint to burn daily",
        unit: "handprint",
        kind: "body_area_proxy"
      },
      {
        sig: "apply 1% BSA to burn daily",
        unit: "% BSA",
        kind: "body_area_proxy"
      },
      {
        sig: "apply 1 shot glass of sunscreen daily",
        unit: "shot glass",
        kind: "product_specific_amount",
        approximateQuantity: { value: 29.5735, unit: "mL" }
      },
      {
        sig: "apply 2 finger lengths of sunscreen daily",
        unit: "finger length",
        kind: "product_specific_amount"
      },
      {
        sig: "apply two-finger rule sunscreen daily",
        unit: "finger length",
        kind: "product_specific_amount"
      },
      {
        sig: "insert 1 full applicator pv at bedtime",
        unit: "applicatorful",
        kind: "product_specific_amount"
      },
      {
        sig: "take 1 cap to line daily",
        unit: "capful",
        kind: "product_specific_amount"
      },
      {
        sig: "take 1 stick pack daily",
        unit: "stick-pack",
        kind: "counted_presentation"
      },
      {
        sig: "use 1 unit-dose vial daily",
        unit: "vial",
        kind: "counted_presentation"
      },
      {
        sig: "inject 5 clicks daily",
        unit: "click",
        kind: "device_actuation"
      },
      {
        sig: "inject 5 insulin units daily",
        unit: "U",
        kind: "biologic_unit"
      }
    ] as const;

    for (const fixture of fixtures) {
      const result = parseSig(fixture.sig);
      expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({
        value: expect.any(Number),
        unit: fixture.unit
      });
      expect(result.meta.normalized.unitKind).toBe(fixture.kind);
      expect(result.meta.leftoverText).toBeUndefined();
      if ("approximateQuantity" in fixture) {
        expect(result.meta.normalized.unitSemantics?.approximateQuantity).toMatchObject(
          fixture.approximateQuantity
        );
      }
    }
  });

  it("exposes unit terminology helpers for UI/search consumers", () => {
    const units = listDoseUnitTerminology();
    expect(units.some((entry) => entry.unit === "FTU")).toBe(true);
    expect(getDoseUnitSemantics("drop")).toMatchObject({
      unit: "drop",
      kind: "product_specific_amount",
      approximateQuantity: {
        value: 0.05,
        unit: "mL",
        confidence: "approximate"
      }
    });
    expect(getDoseUnitSemantics("gtt")).toMatchObject({
      unit: "drop",
      kind: "product_specific_amount"
    });
    expect(getDoseUnitSemantics("eyedrop")).toMatchObject({
      unit: "drop",
      kind: "product_specific_amount"
    });
    expect(getDoseUnitSemantics("gtt/min")).toMatchObject({
      unit: "drop/min",
      kind: "infusion_rate",
      parseAsDose: false
    });
  });

  it("keeps bare cm meal timing outside the site-anchored dose grammar", () => {
    const breakfast = parseSig("cm");
    expect(breakfast.fhir.timing?.repeat?.when).toEqual([EventTiming.Breakfast]);
    expect(breakfast.fhir.doseAndRate).toBeUndefined();

    const oral = parseSig("1 tab cm");
    expect(oral.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({
      value: 1,
      unit: "tab"
    });
    expect(oral.fhir.timing?.repeat?.when).toEqual([EventTiming.Breakfast]);

    const subcutaneous = parseSig("1 unit sc cm");
    expect(subcutaneous.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({
      value: 1,
      unit: "U"
    });
    expect(subcutaneous.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Subcutaneous route"]);
    expect(subcutaneous.fhir.timing?.repeat?.when).toEqual([EventTiming.Breakfast]);
  });

  it("preserves typed workflow timing and unresolved workflow instruction text", () => {
    const sun = parseSig("apply sunscreen before sun exposure");
    const relative = { relation: "before", activity: { text: "sun exposure" } };
    expect(sun.meta.canonical.clauses[0].schedule?.activityTiming).toMatchObject([relative]);
    expect(fromFhirDosage(toFhirR5Dosages(sun.fhirNext)[0]).meta.canonical.clauses[0].schedule?.activityTiming)
      .toMatchObject([relative]);
    expect(sun.longText).toContain("before sun exposure");
    expect(sun.fhirNext.renderedInstruction).toBe("apply sunscreen before sun exposure");
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
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
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

  it("formats multiple meals and exact times together in English", () => {
    const result = parseSig("1 tab with breakfast, with lunch, and at 9 am, 5 pm");
    expect(result.longText).toBe("Use 1 tablet with breakfast, with lunch and at 9:00 am, 5:00 pm.");
    expect(result.fhir.timing?.repeat?.when).toEqual(["CM", "CD"]);
    expect(getTimingClocks(result.fhir.timing?.repeat)).toEqual(["09:00:00", "17:00:00"]);
    expect(result.fhir.timing?.repeat?.extension?.filter(extension =>
      extension.url === "urn:ezmedicationinput:StructureDefinition:medication-timing-additional-clock"))
      .toEqual([{ url: "urn:ezmedicationinput:StructureDefinition:medication-timing-additional-clock", valueTime: "09:00:00" },
        { url: "urn:ezmedicationinput:StructureDefinition:medication-timing-additional-clock", valueTime: "17:00:00" }]);
    expect(result.fhir.timing?.repeat?.timeOfDay).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it("formats generic 'with meals' and exact time together in English", () => {
    const result = parseSig("1 tab with meals and @ 10:00");
    expect(result.longText).toBe("Use 1 tablet with meals and at 10:00 am.");
    expect(result.fhir.timing?.repeat?.when).toEqual(["C"]);
    expect(getTimingClocks(result.fhir.timing?.repeat)).toEqual(["10:00:00"]);
    expect(result.fhir.timing?.repeat?.extension).toContainEqual({
      url: "urn:ezmedicationinput:StructureDefinition:medication-timing-additional-clock", valueTime: "10:00:00"
    });
    expect(result.fhir.timing?.repeat?.timeOfDay).toBeUndefined();
  });

  it("formats complex mixed schedules in Thai", () => {
    const cases = [
      {
        input: "1 tab with breakfast, with lunch, and at 9 am, 5 pm",
        when: ["CM", "CD"],
        clocks: ["09:00:00", "17:00:00"],
        expected: "ใช้ครั้งละ 1 เม็ด พร้อมอาหารเช้า, พร้อมอาหารกลางวัน และ เวลา 09:00, 17:00."
      },
      {
        input: "1 tab with meals and @ 10:00",
        when: ["C"],
        clocks: ["10:00:00"],
        expected: "ใช้ครั้งละ 1 เม็ด พร้อมอาหาร และ เวลา 10:00."
      },
      {
        input: "1 tab ac and @ 8:00",
        when: ["AC"],
        clocks: ["08:00:00"],
        expected: "ใช้ครั้งละ 1 เม็ด ก่อนอาหาร และ เวลา 08:00."
      }
    ];

    for (const { input, expected, clocks, when } of cases) {
      const result = parseSig(input, { locale: "th" });
      expect(result.longText).toBe(expected);
      expect(result.fhir.timing?.repeat?.when).toEqual(when);
      expect(getTimingClocks(result.fhir.timing?.repeat)).toEqual(clocks);
      expect(result.fhir.timing?.repeat?.timeOfDay).toBeUndefined();
      expect(result.warnings).toEqual([]);
    }
  });

  it("consumes 'and' connector between schedule blocks to prevent leakage", () => {
    const result = parseSig("1 tab with meals and at 9:00");
    expect(result.fhir.additionalInstruction).toBeUndefined();
    expect(result.longText).not.toContain("and.");
    expect(result.longText).toBe("Use 1 tablet with meals and at 9:00 am.");
    expect(result.fhir.timing?.repeat?.when).toEqual(["C"]);
    expect(getTimingClocks(result.fhir.timing?.repeat)).toEqual(["09:00:00"]);
    expect(result.fhir.timing?.repeat?.timeOfDay).toBeUndefined();
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
      { input: "1 tab prn pain", expected: "ใช้ครั้งละ 1 เม็ด ใช้เมื่อปวด." },
      { input: "1 tab prn fever", expected: "ใช้ครั้งละ 1 เม็ด ใช้เมื่อมีไข้." },
      { input: "1 tab prn sleep", expected: "ใช้ครั้งละ 1 เม็ด ใช้เมื่อนอนไม่หลับ." }
    ];
    for (const { input, expected } of cases) {
      const result = parseSig(input, { locale: "th" });
      expect(result.longText).toBe(expected);
    }
  });

  it("keeps symptom-adjustment reasons from consuming following dose and schedule", () => {
    const result = parseSig("adjust according to headache 2 tabs bid", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 2, unit: "tab" });
    expect(result.fhir.timing?.repeat).toMatchObject({ frequency: 2, period: 1, periodUnit: "d" });
    expect(result.fhir.asNeededFor?.[0]?.coding?.[0]?.code).toBe("25064002");
    expect(result.meta.canonical.clauses[0]?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "hpsg.lex.symptomAdjustment" }),
      expect.objectContaining({ rule: "hpsg.lex.dose.numeric" }),
      expect.objectContaining({ rule: "hpsg.lex.schedule.timingAbbreviation" })
    ]));
  });

  it("uses custom action terminology when projecting method display and translation", () => {
    const result = parseSig("frobnicate 1 tab", {
      context: TAB_CONTEXT,
      instructionActionMap: {
        frobnicate: {
          code: "frobnicate",
          semanticClass: "administration",
          display: "Frobnicate",
          i18n: { th: "ฟรอบ" },
          procedural: false,
          acceptsAmount: true,
          definesDose: true,
          administrationMethod: { system: "https://example.test/method", code: "frob", display: "Frobnicate" },
          verbRouteHint: SNOMEDCTRouteCodes["Oral route"]
        }
      }
    });
    expect(result.fhir.method?.text).toBe("Frobnicate");
    expect(result.fhir.method?.coding?.[0]).toMatchObject({
      system: "https://example.test/method", code: "frob", display: "Frobnicate"
    });
    expect(result.fhir.method?._text?.extension?.[0]?.extension).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: "content", valueString: "ฟรอบ" })
    ]));
    expect(result.longText).toBe("Frobnicate 1 tablet orally.");
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

// Preserved public-contract regressions in their subject suite.
{
const parseSig = reviewParseSig;
const FHIR_TRANSLATION_EXTENSION_URL = reviewFHIR_TRANSLATION_EXTENSION_URL;


const persist = <T>(value: T): T => JSON.parse(JSON.stringify(value));


// Retained boundary and strict-type suite from test/pr14-round21-boundaries.spec.ts.
{


// Earlier external-boundary regressions share this maintained suite.
// Keep their fixture helpers local while retaining every original oracle.
{

describe("provider registration and explicit cloning preserve owned data", () => {
  it("keeps detector configuration used through this on the registered snapshot", () => {
    const detector = { locale: "configuration-test", priority: 300,
      marker: /^__configuration_works__$/, test(text: string) { return this.marker.test(text); } };
    registerMedicationLocaleDetector(detector);
    detector.marker = /^__configuration_changed__$/;
    expect(inferMedicationLocale("__configuration_works__")).toBe("configuration");
    expect(inferMedicationLocale("__configuration_changed__", "en")).toBe("en");
  });

  it("keeps distinct registered segmenter slots when a descriptor is reused", () => {
    const provider = { locale: "test-first", script: /[\uE100]/u, segment: (input: string) => [{ segment: input, index: 0 }] };
    registerMedicationSurfaceSegmenter(provider);
    provider.locale = "test-second";
    provider.script = /[\uE101]/u;
    registerMedicationSurfaceSegmenter(provider);
    const entries = listMedicationSurfaceSegmenters();
    expect(entries.find(e => e.locale === "test-first")?.script.source).toBe("[\\uE100]");
    expect(entries.find(e => e.locale === "test-second")?.script.source).toBe("[\\uE101]");
  });

  it("keeps a date resolver's registered year interpretation", () => {
    const resolver = { id: "test-owned-calendar", calendarYearFromIsoYear: (year: number) => year + 1000,
      resolveYear: (year: number, digits: number) => digits === 4 && year >= 3000
        ? { isoYear: year - 1000, calendarYear: year, inferredYear: false } : undefined };
    registerMedicationDateResolver(resolver);
    resolver.resolveYear = (year, digits) => digits === 4 && year >= 3000
      ? { isoYear: year - 2000, calendarYear: year, inferredYear: false } : undefined;
    const parsed = parseSig("take 1 tab on 28/9/3026", {
      datePolicy: { calendars: ["test-owned-calendar"], referenceDate: "2026-11-18" },
    });
    expect(parsed.fhirNext.step![0].component[0].timing?.event).toEqual(["2026-09-28"]);
  });

  it("keeps the terminology version in the explicitly requested spatial clone", () => {
    const source = { relationText: "around", relationCoding: {
      system: "http://snomed.info/sct", version: "20261101", code: "66459002" },
      targetText: "eye" };
    const cloned = cloneBodySiteSpatialRelation(source)!;
    expect(cloned.relationCoding?.version).toBe("20261101");
    expect(cloned.relationCoding).not.toBe(source.relationCoding);
  });
});
}

// END PRESERVED round39_boundaries
}

describe("round71 recognized graph component annotations", () => {
  it.each([false, true])("retains field annotations and unknown Coding data (coding child ID %s)", codingChildId => {
    const parsed = parseSig("Apply ointment then cover with occlusive dressing");
    const marker = buildInstructionGraphExtension(parsed.meta.canonical.clauses[0].instructionGraph!)!;
    const component = (wire: FhirExtension) => {
      const action = wire.extension!.find(item => item.url === "action" &&
        item.extension?.some(field => field.url === "predicateLemma" && field.valueString === "cover"))!;
      const argument = action.extension!.find(item => item.url === "argument" &&
        item.extension?.some(field => field.url === "conceptId" && field.valueString === "occlusive_dressing"))!;
      return argument.extension!.find(item => item.url === "component" &&
        item.extension?.some(field => field.url === "role" && field.valueCode === "head"))!;
    };
    const note: FhirExtension = { url: "urn:clinic:component-note", valueString: "retain authored annotations" };
    const head = component(marker), role = head.extension!.find(item => item.url === "role")!,
      text = head.extension!.find(item => item.url === "text")!, coding = head.extension!.find(item => item.url === "coding")!;
    role.id = "role-element";
    role._valueCode = { id: "role-value", extension: [note] };
    text.id = "text-element";
    text._valueString = { id: "text-value", extension: [note] };
    if (codingChildId) coding.id = "coding-element";
    Object.assign(coding.valueCoding!, { id: "coding-value", extension: [note], clinicSource: { revision: "authored" } });
    const before = persist(marker), expected = persist(head);
    let current = marker;
    for (let save = 0; save < 2; save++) {
      const supplied = persist(current), suppliedBefore = persist(supplied);
      const decoded = parseInstructionGraphExtension([supplied])!;
      const decodedBefore = persist(decoded);
      current = buildInstructionGraphExtension(decoded)!;
      expect(component(current)).toEqual(expected);
      expect(supplied).toEqual(suppliedBefore);
      expect(decoded).toEqual(decodedBefore);
    }
    const row = persist(parsed.fhir[0]);
    row.extension = [...(row.extension ?? []).filter(item => item.url !== marker.url), marker];
    const rowBefore = persist(row), wire = toDosageDetails([row]);
    const saved = toFhirR5Dosages(persist(wire));
    const savedMarker = saved[0].extension!.find(item => item.url === marker.url)!;
    expect(component(savedMarker)).toEqual(expected);
    expect(row).toEqual(rowBefore);

    const decoded = parseInstructionGraphExtension([persist(marker)])!, edited = persist(decoded);
    const editedComponent = edited.actions.find(action => action.predicate.lemma === "cover")!.args
      .find(argument => argument.conceptId === "occlusive_dressing")!.components!.find(item => item.role === "head")!;
    delete editedComponent.coding;
    const editedBefore = persist(edited);
    current = buildInstructionGraphExtension(edited)!;
    for (let save = 0; save < 2; save++) {
      const fields = component(current).extension!;
      expect(fields.find(item => item.url === "coding")).toBeUndefined();
      expect(fields.find(item => item.url === "sourceCoding")).toEqual({ ...coding, url: "sourceCoding" });
      const fresh = parseInstructionGraphExtension([persist(current)])!;
      expect(fresh.actions.find(action => action.predicate.lemma === "cover")!.args
        .find(argument => argument.conceptId === "occlusive_dressing")!.components!.find(item => item.role === "head")!.coding).toBeUndefined();
      current = buildInstructionGraphExtension(fresh)!;
    }
    expect(edited).toEqual(editedBefore);
    expect(decoded.actions.find(action => action.predicate.lemma === "cover")!.args
      .find(argument => argument.conceptId === "occlusive_dressing")!.components!.find(item => item.role === "head")!.coding).toEqual(coding.valueCoding);
    expect(marker).toEqual(before);
  });
});

describe("round71 predicate component annotations", () => {
  it.each(["code", "display", "clear display"])("retains source annotations while a fresh typed Coding %s edit stays active", edit => {
    const parsed = parseSig("Rub cream gently");
    const marker = buildInstructionGraphExtension(parsed.meta.canonical.clauses[0].instructionGraph!)!;
    const component = (wire: FhirExtension) => wire.extension!.find(item => item.url === "action")!
      .extension!.find(item => item.url === "predicateComponent")!;
    const part = component(marker), role = part.extension!.find(item => item.url === "role")!,
      coding = part.extension!.find(item => item.url === "coding")!;
    const note: FhirExtension = { url: "urn:clinic:mechanism-note", valueString: "retain the authored annotation" };
    part.id = "friction-component";
    role.id = "mechanism-role";
    role._valueCode = { id: "mechanism-value", extension: [note] };
    coding.id = "friction-coding";
    Object.assign(coding.valueCoding!, { id: "friction-source", extension: [note], clinicSource: { revision: "authored" } });
    part.extension!.push(note);
    const before = persist(marker), expected = persist(part);
    let current = marker;
    for (let save = 0; save < 2; save++) {
      current = buildInstructionGraphExtension(parseInstructionGraphExtension([persist(current)])!)!;
      expect(component(current)).toEqual(expected);
    }
    const row = persist(parsed.fhir[0]);
    row.extension = [...(row.extension ?? []).filter(item => item.url !== marker.url), marker];
    const rowBefore = persist(row), wire = toDosageDetails([row]);
    const saved = toFhirR5Dosages(persist(wire));
    expect(component(saved[0].extension!.find(item => item.url === marker.url)!)).toEqual(expected);
    expect(row).toEqual(rowBefore);

    const decoded = parseInstructionGraphExtension([persist(marker)])!, edited = persist(decoded);
    const previous = coding.valueCoding!;
    const replacement = edit === "code"
      ? { system: "https://example.org/clinic/mechanisms", code: "gentle-rubbing", display: "Gentle rubbing" }
      : { system: previous.system, code: previous.code,
          ...(previous.version === undefined ? {} : { version: previous.version }),
          ...(edit === "display" ? { display: "Current friction label" } : {}) };
    edited.actions[0].predicate.semanticComponents![0].coding = replacement;
    const editedBefore = persist(edited);
    current = buildInstructionGraphExtension(edited)!;
    for (let save = 0; save < 2; save++) {
      const fields = component(current).extension!;
      expect(fields.filter(item => item.url === "sourceCoding")).toEqual([{ ...coding, url: "sourceCoding" }]);
      expect(fields.filter(item => item.url === "coding")).toEqual([{ url: "coding", valueCoding: replacement }]);
      expect(fields).toContainEqual(role);
      expect(fields).toContainEqual(note);
      const fresh = parseInstructionGraphExtension([persist(current)])!;
      expect(fresh.actions[0].predicate.semanticComponents![0].coding).toEqual(replacement);
      current = buildInstructionGraphExtension(fresh)!;
    }
    expect(edited).toEqual(editedBefore);
    expect(decoded.actions[0].predicate.semanticComponents![0].coding).toEqual(coding.valueCoding);
    expect(marker).toEqual(before);
  });
});

describe("round76 action source-text metadata", () => {
  it.each(["Apply one patch", "Apply the replacement patch", ""])(
    "retains annotated action source text with its current value: %s", text => {
    const graph = { sourceText: "Apply one patch", actions: parseInstructionActions("Apply one patch") };
    const wire = JSON.parse(JSON.stringify(buildInstructionGraphExtension(graph)!)) as FhirExtension;
    const field = wire.extension!.find(child => child.url === "action")!.extension!.find(child => child.url === "sourceText")!;
    const primitive = { id: "source-string", extension: [{ url: "urn:clinic:patch-source", valueString: "retain" }] };
    field.id = "source-field";
    field._valueString = primitive;
    const before = JSON.parse(JSON.stringify(wire));
    const decoded = parseInstructionGraphExtension([wire])!;
    const edited = { ...decoded, actions: decoded.actions.map(action => ({ ...action, sourceText: text })) };
    let encoded = buildInstructionGraphExtension(edited)!;
    for (let save = 0; save < 2; save++) {
      const fields = encoded.extension!.find(child => child.url === "action")!.extension!.filter(child => child.url === "sourceText");
      expect(fields).toEqual([{ url: "sourceText", ...(text ? { valueString: text } : {}), id: "source-field", _valueString: primitive }]);
      expect(parseInstructionGraphExtension([encoded])!.actions[0].sourceText).toBe(text);
      encoded = buildInstructionGraphExtension(parseInstructionGraphExtension([JSON.parse(JSON.stringify(encoded))])!)!;
    }
    expect(wire).toEqual(before);
  });
});


describe("round76 typed action complements in normalized previews", () => {
  const fresh = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
  const current = (value: string, locale: string) => value
    .split(locale === "en" ? "; original directions: " : "; ข้อความเดิม: ")[0]
    .replace(locale === "en" ? /^Current: /u : /^ปัจจุบัน: /u, "");

  it.each([
    { source: "Remove patch at bedtime.", action: "remove", role: AdviceArgumentRole.Time,
      relation: AdviceRelation.On, en: ["Remove patch at bedtime"], th: ["เอาแผ่นแปะออกก่อนนอน"] },
    { source: "Close eye and press inner corner for 1 minute.", action: "close", role: AdviceArgumentRole.Site,
      relation: undefined, en: ["Close the eye", "press inner corner for 1 minute"], th: ["หลับตา", "press inner corner for 1 minute"] },
    { source: "Repeat in the other eye.", action: "repeat", role: AdviceArgumentRole.Object,
      relation: AdviceRelation.In, en: ["Repeat in the other eye"], th: ["Repeat in the other eye"] },
    { source: "Shake suspension well before each dose; discard after 14 days.", action: "shake", role: AdviceArgumentRole.Time,
      relation: AdviceRelation.Before, en: ["Shake suspension well before each dose", "discard after 14 days"],
      th: ["เขย่าsuspension wellก่อนการให้ยาแต่ละครั้ง", "ทิ้งหลัง 14 วัน"] },
  ])("retains the owned complements of $action across native and saved wire views", fixture => {
    const parsed = parsePublicSig(fixture.source);
    const graph = parsed.meta.canonical.clauses[0].instructionGraph!;
    const frame = graph.actions.find(value => value.predicate.lemma === fixture.action)!;
    expect(frame.relation).toBe(fixture.relation);
    expect(frame.args.some(arg => arg.role === fixture.role)).toBe(true);
    if (fixture.action === "remove") expect(frame.args).toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Time, normalized: "HS" }));
    if (fixture.action === "close") {
      expect(frame.args).toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Site, coding: expect.objectContaining({ code: "81745001" }) }));
      expect(graph.actions[1].args).toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Duration, quantity: { value: 1, unit: "min" } }));
    }
    if (fixture.action === "repeat") expect(frame.args).toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Object, text: "the other eye" }));
    if (fixture.action === "shake") expect(frame.args).toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Time, conceptId: "each-dose" }));
    for (const input of [parsed.meta.canonical.course!, fresh(parsed.fhir), fresh(parsed.fhirNext), fresh(toFhirR5Dosages(parsed.fhirNext))]) {
      const before = JSON.stringify(input);
      for (const locale of ["en", "th"] as const) {
        const displayed = current(formatSig(input, "long", { locale, realizationMode: "normalized" }), locale);
        for (const phrase of fixture[locale]) expect(displayed).toContain(phrase);
        if (fixture.action === "close" && locale === "th") expect(displayed).not.toContain("หลับตาตา");
        if (fixture.action === "shake" && locale === "en") expect(displayed).not.toContain("at each dose");
      }
      const restored = importCanonicalCourse(input).stages[0].administrations[0].syntax!.instructionGraph!;
      expect(restored.sourceText).toBe(fixture.source);
      expect(restored.actions.find(value => value.predicate.lemma === fixture.action)!.args.some(arg => arg.role === fixture.role)).toBe(true);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["Remove patch for 12 hours", "เอาแผ่นแปะออกนาน 12 ชั่วโมง"])(
    "retains the typed removal duration and its licensed relation: %s", source => {
      const parsed = parsePublicSig(source);
      const frame = parsed.meta.canonical.clauses[0].instructionGraph!.actions[0];
      expect(frame.relation).toBe(AdviceRelation.For);
      expect(frame.args).toContainEqual(expect.objectContaining({
        role: AdviceArgumentRole.Duration, quantity: { value: 12, unit: "h" }
      }));
      for (const input of [parsed.meta.canonical.course!, fresh(parsed.fhir), fresh(parsed.fhirNext), fresh(toFhirR5Dosages(parsed.fhirNext))]) {
        expect(current(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }), "en").replace(/\.$/u, ""))
          .toBe("Remove patch for 12 hours");
        expect(current(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }), "th").replace(/\.$/u, ""))
          .toBe("เอาแผ่นแปะออกเป็นเวลา 12 ชั่วโมง");
        expect(importCanonicalCourse(input).stages[0].administrations[0].syntax!.instructionGraph!.sourceText).toBe(source);
      }
    });

  it.each([["right", "1290032005", "ตาขวา"], ["left", "1290031003", "ตาซ้าย"]] as const)(
    "keeps the %s eye explicit when the Thai head entails only generic eye", (side, code, thai) => {
      const parsed = parsePublicSig("Close " + side + " eye");
      const site = parsed.meta.canonical.clauses[0].instructionGraph!.actions[0].args.find(arg => arg.role === AdviceArgumentRole.Site)!;
      expect(site.conceptId).toBe(side + " eye");
      expect(site.coding).toMatchObject({ code });
      for (const input of [parsed.meta.canonical.course!, fresh(parsed.fhir), fresh(parsed.fhirNext), fresh(toFhirR5Dosages(parsed.fhirNext))]) {
        expect(current(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }), "en").replace(/\.$/u, ""))
          .toBe("Close the " + side + " eye");
        expect(current(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }), "th").replace(/\.$/u, ""))
          .toBe("หลับตา (" + thai + ")");
      }
    });

  it("keeps a configured closing head's explicit site when that label does not entail it", () => {
    const parsed = parsePublicSig("Shut eye", { instructionActionMap: { shut: {
      code: "close", display: "Shut", semanticClass: "manipulate", i18n: { th: "ปิด" }, aliases: ["shut"],
      procedural: true, argumentParser: "bare-duration", realizer: "duration"
    } } });
    const frame = parsed.meta.canonical.clauses[0].instructionGraph!.actions[0];
    expect(frame.predicate.display).toBe("Shut");
    expect(frame.args).toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Site, conceptId: "eye" }));
    for (const input of [fresh(parsed.fhir), fresh(parsed.fhirNext), fresh(toFhirR5Dosages(parsed.fhirNext))]) {
      expect(current(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }), "en")).toContain("Shut the eye");
      expect(current(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }), "th")).toContain("ปิดตา");
    }
  });
});


describe("round77 procedure target beside duration and time", () => {
  const current = (value: string, locale: "en" | "th") => value
    .split(locale === "en" ? "; original directions: " : "; ข้อความเดิม: ")[0]
    .replace(locale === "en" ? /^Current: /u : /^ปัจจุบัน: /u, "")
    .replace(/\.$/u, "");
  it.each([
    { source: "Close right eye for 1 minute after each dose", side: "right", code: "1290032005", duration: 1,
      event: "each dose", relation: AdviceRelation.After,
      en: "Close the right eye for 1 minute after each dose", th: "หลับตา (ตาขวา) 1 นาทีหลังการให้ยาแต่ละครั้ง" },
    { source: "Close left eye 1 minute", side: "left", code: "1290031003", duration: 1,
      event: undefined, relation: undefined,
      en: "Close the left eye for 1 minute", th: "หลับตา (ตาซ้าย) 1 นาที" },
    { source: "Close right eye at bedtime", side: "right", code: "1290032005", duration: undefined,
      event: "bedtime", relation: AdviceRelation.On,
      en: "Close the right eye at bedtime", th: "หลับตา (ตาขวา)ก่อนนอน" },
  ])("retains the selected eye with independent complements: $source", fixture => {
    const parsed = parsePublicSig(fixture.source);
    const frame = parsed.meta.canonical.clauses[0].instructionGraph!.actions[0];
    expect(frame.predicate.lemma).toBe("close");
    expect(frame.args.find(arg => arg.role === AdviceArgumentRole.Site)).toMatchObject({
      conceptId: fixture.side + " eye", coding: { code: fixture.code }
    });
    expect(frame.args.find(arg => arg.role === AdviceArgumentRole.Duration)?.quantity)
      .toEqual(fixture.duration === undefined ? undefined : { value: fixture.duration, unit: "min" });
    const time = frame.args.find(arg => arg.role === AdviceArgumentRole.Time);
    expect(time?.normalized).toBe(fixture.event);
    expect(time?.relation ?? frame.relation).toBe(fixture.relation);
    for (const input of [parsed.meta.canonical.course!, persist(parsed.fhir), persist(parsed.fhirNext),
      persist(toFhirR5Dosages(parsed.fhirNext))]) {
      const before = JSON.stringify(input);
      for (const locale of ["en", "th"] as const)
        expect(current(formatSig(input, "long", { locale, realizationMode: "normalized" }), locale)).toBe(fixture[locale]);
      const administration = importCanonicalCourse(input).stages[0].administrations[0];
      expect(administration.amounts).toBeUndefined();
      expect(administration.syntax!.instructionGraph!.sourceText).toBe(fixture.source);
      expect(JSON.stringify(input)).toBe(before);
    }
  });
});


describe("round77 independent advice and selected Time ownership", () => {
  const current = (value: string, locale: "en" | "th") => value
    .split(locale === "en" ? "; original directions: " : "; ข้อความเดิม: ")[0]
    .replace(locale === "en" ? /^Current: /u : /^ปัจจุบัน: /u, "")
    .replace(/\.$/u, "");

  it.each([false, true])("keeps an independent warning outside the administration guard (dose=%s)", withDose => {
    const source = persist(parsePublicSig("1 tab only if SBP > 160").fhirNext);
    const component = source.step![0].component[0];
    delete source.renderedInstruction;
    delete component.text;
    if (!withDose) delete component.doseAndRate;
    component.additionalInstruction = [{ text: "Do not crush", _text: { extension: [{
      url: FHIR_TRANSLATION_EXTENSION_URL, extension: [
        { url: "lang", valueCode: "th" }, { url: "content", valueString: "ห้ามบด" }
      ]
    }] } }];
    for (const input of [source, importCanonicalCourse(source), persist(toFhirR5Dosages(source)),
      persist(toDosageDetails(toFhirR5Dosages(source)))]) {
      const before = JSON.stringify(input);
      for (const locale of ["en", "th"] as const) {
        const text = current(formatSig(input, "long", { locale, realizationMode: "normalized" }), locale);
        const guard = locale === "en" ? "Use" + (withDose ? " 1 tablet" : "") + " only if SBP > 160"
          : "ใช้" + (withDose ? "ครั้งละ 1 เม็ด" : "") + " เฉพาะเมื่อ SBP > 160";
        const warning = locale === "en" ? "Do not crush" : "ห้ามบด";
        expect(text).toBe(guard + ". " + warning);
      }
      expect(importCanonicalCourse(input).stages[0].administrations[0].predicate).toMatchObject({ kind: "measurement", value: 160 });
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it("preserves a disjunctive meal complement without promoting breakfast to the sole event", () => {
    const source = "Rinse mouth 15 mL after breakfast or dinner";
    const parsed = parsePublicSig(source);
    const frame = parsed.meta.canonical.clauses[0].instructionGraph!.actions[0];
    expect(frame.args.filter(arg => arg.role === AdviceArgumentRole.Time)).toHaveLength(0);
    expect(frame.args).toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Activity, text: "breakfast or dinner" }));
    expect(frame.relation).toBe(AdviceRelation.After);
    expect(parsed.meta.canonical.clauses[0].schedule?.when ?? []).toEqual([]);
    for (const input of [parsed.meta.canonical.course!, persist(parsed.fhir), persist(parsed.fhirNext), persist(toFhirR5Dosages(parsed.fhirNext))]) {
      for (const locale of ["en", "th"] as const) {
        const text = current(formatSig(input, "long", { locale, realizationMode: "normalized" }), locale);
        expect(importCanonicalCourse(input).stages[0].administrations[0].schedule?.recurrence?.anchors ?? []).toEqual([]);
        expect(text).toContain((locale === "en" ? "after " : "หลัง") + "breakfast or dinner");
        expect(text).toContain(locale === "en" ? "15 mL" : "15 มิลลิลิตร");
      }
      expect(importCanonicalCourse(input).stages[0].administrations[0].syntax!.instructionGraph!.sourceText).toBe(source);
    }
  });

  it.each(["breakfast", "breakfast and dinner"])("retains supported conjunctive Time daughters for %s", event => {
    const parsed = parsePublicSig("Rinse mouth 15 mL after " + event);
    const times = parsed.meta.canonical.clauses[0].instructionGraph!.actions[0].args.filter(arg => arg.role === AdviceArgumentRole.Time);
    expect(times.map(arg => arg.normalized)).toEqual(event === "breakfast" ? ["CM"] : ["CM", "CV"]);
    for (const locale of ["en", "th"] as const) {
      const text = formatSig(persist(parsed.fhirNext), "long", { locale, realizationMode: "normalized" });
      expect(text).toContain(locale === "en" ? "after breakfast" : "หลังอาหารเช้า");
      if (times.length === 2) expect(text).toContain(locale === "en" ? "after dinner" : "หลังอาหารเย็น");
    }
  });

  it.each([
    { suffix: "at bedtime", events: ["HS"], en: "Rub to form foam at bedtime", th: "ถูให้เกิดฟองก่อนนอน" },
    { suffix: "before breakfast and before dinner", events: ["CM", "CV"],
      en: "Rub to form foam before breakfast before dinner", th: "ถูให้เกิดฟองก่อนอาหารเช้าก่อนอาหารเย็น" }
  ])("realizes a result action's typed Time: $suffix", fixture => {
    const source = "Rub to form foam " + fixture.suffix;
    const parsed = parsePublicSig(source);
    const frame = parsed.meta.canonical.clauses[0].instructionGraph!.actions[0];
    expect(frame.args.find(arg => arg.role === AdviceArgumentRole.Result)?.conceptId).toBe("foam");
    expect(frame.args.filter(arg => arg.role === AdviceArgumentRole.Time).map(arg => arg.normalized)).toEqual(fixture.events);
    for (const input of [parsed.meta.canonical.course!, persist(parsed.fhir), persist(parsed.fhirNext), persist(toFhirR5Dosages(parsed.fhirNext))]) {
      for (const locale of ["en", "th"] as const)
        expect(current(formatSig(input, "long", { locale, realizationMode: "normalized" }), locale)).toBe(fixture[locale]);
      const administration = importCanonicalCourse(input).stages[0].administrations[0];
      expect(administration.amounts).toBeUndefined();
      expect(administration.syntax!.instructionGraph!.sourceText).toBe(source);
    }
  });

  it("exports requested uncoded advice translations from the existing typed realization", () => {
    const source = "Take 1 tablet daily, do not lie down immediately";
    const parsed = parsePublicSig(source, { locale: "th" });
    for (const instruction of [parsed.fhir[0].additionalInstruction![0], parsed.fhirNext.step![0].component[0].additionalInstruction![0],
      toFhirR5Dosages(persist(parsed.fhirNext))[0].additionalInstruction![0]]) {
      expect(instruction.text).toBe("do not lie down immediately");
      expect(instruction.coding).toBeUndefined();
      expect(getPrimitiveTranslation(instruction._text, "th")).toBe("ห้ามนอนราบทันที");
    }
    expect(parsePublicSig(source).fhir[0].additionalInstruction![0]._text).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0].dose).toMatchObject({ value: 1, unit: "tab" });
    expect(parsed.meta.canonical.clauses[0].schedule).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
  });
});

describe("round78 graph argument field metadata", () => {
  it.each([false, true])("preserves recognized field annotations while the current role wins (edited=%s)", edited => {
    const source = "Take 1 tablet with 100 mL water";
    const marker = persist(buildInstructionGraphExtension({
      sourceText: source, sourceLocale: "en", actions: parseInstructionActions(source),
    })!);
    const action = marker.extension!.find(item => item.url === "action")!;
    const argument = action.extension!.filter(item => item.url === "argument").find(item =>
      item.extension!.some(field => field.url === "quantity" && field.extension!.some(child =>
        child.url === "unit" && child.valueString === "mL")))!;
    argument.id = "water-argument";
    argument.extension!.push({ url: "urn:clinic:argument-note", valueString: "retain" });
    const role = argument.extension!.find(item => item.url === "role")!;
    role.id = "role-owner";
    role._valueCode = { id: "role-value", extension: [{ url: "urn:clinic:role-note", valueString: "retain" }] };
    const text = argument.extension!.find(item => item.url === "text")!;
    text.id = "text-owner";
    text._valueString = { id: "text-value", extension: [{ url: "urn:clinic:text-note", valueString: "retain" }] };
    const original = persist(marker);
    let graph = persist(parseInstructionGraphExtension([marker])!);
    const current = graph.actions[0].args.find(item => item.quantity?.unit === "mL")!;
    if (edited) current.role = AdviceArgumentRole.Destination;
    const expected = persist(argument);
    if (edited) expected.extension!.find(item => item.url === "role")!.valueCode = AdviceArgumentRole.Destination;
    for (let save = 0; save < 2; save++) {
      const before = persist(graph), output = buildInstructionGraphExtension(graph)!;
      const saved = output.extension!.find(item => item.url === "action")!.extension!
        .find(item => item.url === "argument" && item.id === "water-argument")!;
      expect(saved).toEqual(expected);
      expect(saved.extension!.filter(item => item.url === "role")).toHaveLength(1);
      expect(graph).toEqual(before);
      graph = persist(parseInstructionGraphExtension([persist(output)])!);
    }
    expect(marker).toEqual(original);
  });
});

describe("round79 graph wrapper identity", () => {
  it.each([false, true])("preserves graph and action Element IDs through the public codec (annotated=%s)", annotated => {
    const source = "Take 1 tablet with 100 mL water";
    const marker = persist(buildInstructionGraphExtension({
      sourceText: source, sourceLocale: "en", actions: parseInstructionActions(source),
    })!);
    const action = marker.extension!.find(item => item.url === "action")!;
    const argument = action.extension!.find(item => item.url === "argument")!;
    if (annotated) {
      marker.id = "instruction-graph";
      action.id = "take-action";
      argument.id = "water-argument";
      marker.extension!.push({ url: "urn:clinic:graph-note", valueString: "retain graph" });
      action.extension!.push({ url: "urn:clinic:action-note", valueString: "retain action" });
    }
    const original = persist(marker);
    let current = marker;
    for (let save = 0; save < 2; save++) {
      const graph = parseInstructionGraphExtension([persist(current)])!, before = persist(graph);
      current = buildInstructionGraphExtension(graph)!;
      expect(current).toStrictEqual(original);
      expect(graph).toEqual(before);
    }
    const rows = toFhirR5Dosages(toDosageDetails(persist([{ extension: [marker] }])));
    expect(rows[0].extension!.find(item => item.url === marker.url)).toEqual(original);
    expect(marker).toEqual(original);
  });
});


describe("graph argument singleton annotations", () => {
  const saved = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const argumentField = (marker: FhirExtension, name: string): FhirExtension => {
    const action = marker.extension!.find(item => item.url === "action")!;
    for (const argument of action.extension!.filter(item => item.url === "argument")) {
      const field = argument.extension!.find(item => item.url === name);
      if (field) return field;
    }
    throw new Error("Expected graph argument field " + name);
  };

  it("retains concept field annotations beside current identity", () => {
    const source = "Cover with an occlusive dressing";
    const original = saved(buildInstructionGraphExtension({
      sourceText: source, sourceLocale: "en", actions: parseInstructionActions(source),
    })!);
    const field = argumentField(original, "conceptId");
    field.id = "material-identity";
    field._valueString = { id: "material-value", extension: [
      { url: "urn:clinic:material-note", valueString: "retain material annotation" },
    ] };
    const input = saved(original);
    const before = saved(input), expected = saved(argumentField(input, "conceptId"));
    let graph = parseInstructionGraphExtension([input])!;
    for (let save = 0; save < 2; save++) {
      expect(graph.actions[0].args.find(argument => argument.conceptId)?.conceptId)
        .toBe("occlusive_dressing");
      const rebuilt = buildInstructionGraphExtension(graph)!;
      expect(argumentField(rebuilt, "conceptId")).toEqual(expected);
      graph = parseInstructionGraphExtension([saved(rebuilt)])!;
    }
    expect(input).toEqual(before);
    expect(argumentField(original, "conceptId").valueString).toBe("occlusive_dressing");
  });

  it("retains coding wrapper annotations beside current identity", () => {
    const source = "Cover with an occlusive dressing";
    const original = saved(buildInstructionGraphExtension({
      sourceText: source, sourceLocale: "en", actions: parseInstructionActions(source),
    })!);
    const field = argumentField(original, "coding");
    field.id = "material-coding";
    field.valueCoding!._code = { id: "material-code", extension: [
      { url: "urn:clinic:coding-note", valueString: "retain coding annotation" },
    ] };
    const input = saved(original);
    const before = saved(input), expected = saved(argumentField(input, "coding"));
    let graph = parseInstructionGraphExtension([input])!;
    for (let save = 0; save < 2; save++) {
      const coding = graph.actions[0].args.find(argument => argument.coding)?.coding;
      expect(coding?.code).toBe("occlusive_dressing");
      expect(coding?.display).toBe("an occlusive dressing");
      const rebuilt = buildInstructionGraphExtension(graph)!;
      expect(argumentField(rebuilt, "coding")).toEqual(expected);
      graph = parseInstructionGraphExtension([saved(rebuilt)])!;
    }
    expect(input).toEqual(before);
    expect(argumentField(original, "coding").valueCoding!.code).toBe("occlusive_dressing");
  });

  it("retains quantity wrapper identity beside current amount", () => {
    const source = "Rinse mouth with 10 mL water";
    const original = saved(buildInstructionGraphExtension({
      sourceText: source, sourceLocale: "en", actions: parseInstructionActions(source),
    })!);
    const field = argumentField(original, "quantity");
    field.id = "rinse-volume";
    field.extension!.push({ url: "urn:clinic:volume-note", valueString: "retain volume annotation" });
    const input = saved(original);
    const before = saved(input), expected = saved(argumentField(input, "quantity"));
    let graph = parseInstructionGraphExtension([input])!;
    for (let save = 0; save < 2; save++) {
      const quantity = graph.actions[0].args.find(argument => argument.quantity)?.quantity;
      expect(quantity?.value).toBe(10);
      expect(quantity?.unit).toBe("mL");
      const rebuilt = buildInstructionGraphExtension(graph)!;
      expect(argumentField(rebuilt, "quantity")).toEqual(expected);
      graph = parseInstructionGraphExtension([saved(rebuilt)])!;
    }
    expect(input).toEqual(before);
    expect(argumentField(original, "quantity").extension!.find(child => child.url === "value")!.valueDecimal).toBe(10);
  });
});
}

{
const FHIR_TRANSLATION_EXTENSION_URL = reviewFHIR_TRANSLATION_EXTENSION_URL;


// Preserved public-contract regressions in their subject suite.
{
const parseSig = reviewParseSig;


const persist = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const q = (value: number) => ({ value, unit: "tab" });
const expression = (name: string) => ({ language: "text/fhirpath", expression: "%" + name });
const course = (component: Partial<FhirR6Dosage> = {}): FhirR6DosageInstruction => ({
  step: [{ component: [{ doseAndRate: [{ doseQuantity: q(1) }], ...component }] }],
});
const r6Save = (value: FhirR6DosageInstruction): FhirR6DosageInstruction => {
  return projectCanonicalCourse(importCanonicalCourse(persist(value))).fhirNext;
};


// Retained regression suite from test/pr14-round21-r5.spec.ts.
{
// BEGIN PRESERVED r521








const persist = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const rowDose = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] };
const componentSafety = (course: FhirR6DosageInstruction) => course.step![0].component[0].safety;
function historicalRows(extra: FhirExtension[] = []): EzDosage[] {
  const marker: FhirExtension = { url: DOSAGE_DETAILS_R5_URL, extension: [{
    url: "dosageDetails", extension: [
      { url: "renderedInstruction", valueString: "Take one tablet, two repeats." },
      ...extra,
      { url: "step", extension: [
        { url: "count", valueInteger: 2 },
        { url: "component", extension: [
          { url: "text", valueString: "Take one tablet, two repeats." },
          { url: "doseAndRate", extension: [{
            url: "doseQuantity", valueQuantity: { value: 1, unit: "tab" },
          }] },
        ] },
      ] },
    ],
  }] };
  return withDosageEditProvenance([{
    ...persist(rowDose), sequence: 1, text: "Take one tablet, two repeats.", modifierExtension: [marker],
  }], "Take one tablet, two repeats.");
}

describe("review round 21: persisted R5 ownership and retention", () => {
  it("writes free-text safety actions as strings and reads the historical code spelling", () => {
    const action = "Stop the dose.\nContact the prescriber.";
    const actions = retainedCourseProfile.differential.element.filter(item => item.id.endsWith(":ifExceeded.value[x]"));
    expect(actions).toHaveLength(4);
    for (const field of actions) expect(field.type).toEqual([{ code: "code" }, { code: "string" }]);
    const marker: FhirExtension = { url: DOSAGE_DETAILS_R5_URL,
      extension: encodeR5RetainedFields({ component: { safety: { ifExceeded: action } } }) };
    const safety = marker.extension![0].extension!.find(child => child.url === "safety")!;
    expect(safety.extension).toEqual([{ url: "ifExceeded", valueString: action }]);
    expect(decodeR5RetainedFields(persist(marker)).component?.safety?.ifExceeded).toBe(action);
    const single = encodeR6SourceMetadata("urn:example:single-step", { course: { ifExceeded: action } }, "safety");
    expect(single.extension![0].extension).toEqual([{ url: "ifExceeded", valueString: action }]);
    expect(decodeR6SourceMetadata(persist(single), "safety")).toEqual({ course: { ifExceeded: action } });
    safety.extension = [{ url: "ifExceeded", valueCode: "hold" }];
    expect(decodeR5RetainedFields(persist(marker)).component?.safety?.ifExceeded).toBe("hold");
  });

  it.each(["timing", "repeat"] as const)("checks newly submitted %s extensions against the saved baseline", owner => {
    let row = withDosageEditProvenance<FhirDosage>([{
      ...persist(rowDose), timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
    }], "Take one tablet daily.")[0];
    expect(dosageMatchesSavedProjection(row)).toBe(true);
    row = persist(row);
    const annotation = [{ url: "urn:example:clinical-timing", valueInteger: 2 }];
    if (owner === "timing") row.timing!.extension = annotation;
    else row.timing!.repeat!.extension = annotation;
    expect(dosageMatchesSavedProjection(row)).toBe(false);
  });

  it("clears the final R5 maximum from its lifted safety mirror after persistence", () => {
    const original: FhirR6DosageInstruction = { step: [{ component: [{ ...persist(rowDose),
      safety: { doseLimit: [{ scope: "administration", valueQuantity: { value: 2, unit: "tab" } }] },
    }] }] };
    const rows = persist(fromDosageDetails(original).dosages);
    expect(rows[0].safety?.doseLimit?.[0].valueQuantity?.value).toBe(2);
    delete rows[0].maxDosePerAdministration;
    const changed = toDosageDetails(rows);
    expect(componentSafety(changed)).toBeUndefined();
    const sources = changed.extension?.filter(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL);
    expect(sources?.length).toBeGreaterThan(0);
    const sourceExtensions: FhirR6Extension[] = [];
    for (const item of sources!) sourceExtensions.push(...(item.extension ?? []));
    const source = sourceExtensions.find(item =>
      decodeR5RetainedFields(item).component?.safety?.doseLimit?.[0].valueQuantity?.value === 2);
    expect(source).toBeDefined();
    expect(componentSafety(toDosageDetails(persist(toFhirR5Dosages(changed))))).toBeUndefined();
    expect(componentSafety(toDosageDetails(persist(fromDosageDetails(original).dosages))))
      .toEqual(original.step![0].component[0].safety);
  });

  it("keeps independent R6 safety after deleting the only projected quantity limit", () => {
    const original: FhirR6DosageInstruction = { step: [{ component: [{ ...persist(rowDose),
      safety: { ifExceeded: "Hold and call.", doseLimit: [
        { scope: "administration", valueQuantity: { value: 2, unit: "tab" } },
        { id: "independent", scope: "lifetime", valueInteger: 20 },
      ] },
    }] }] };
    const rows = persist(fromDosageDetails(original).dosages);
    delete rows[0].maxDosePerAdministration;
    const active = componentSafety(toDosageDetails(rows));
    expect(active).toEqual({ ifExceeded: "Hold and call.", doseLimit: [
      { id: "independent", scope: "lifetime", valueInteger: 20 },
    ] });
  });

  it("retires baseline wording after historical step or header edits and accepts explicit replacement wording", () => {
    const rows = persist(historicalRows());
    expect(toDosageDetails(rows).renderedInstruction).toBe("Take one tablet, two repeats.");
    const changed = toDosageDetails(rows, undefined, { renderedInstruction: "Take one tablet, two repeats.",
      step: [{ sequence: 1, count: 3 }] });
    expect(changed.step![0].count).toBe(3);
    expect(changed.renderedInstruction).toBeUndefined();
    expect(changed.extension?.some(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL)).toBe(true);
    expect(toDosageDetails(rows, undefined, { id: "revised-course" }).renderedInstruction).toBeUndefined();
    expect(toDosageDetails(rows, "Take one tablet, three repeats.", { step: [{ sequence: 1, count: 3 }] })
      .renderedInstruction).toBe("Take one tablet, three repeats.");
  });

  it("retains flat historical sources when active course annotations are replaced", () => {
    const previous = { url: "urn:example:older-source", valueString: "earlier independent annotation" };
    const history = { url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [previous] };
    const replacement = { url: "urn:example:current-note", valueString: "current annotation" };
    let current = toDosageDetails(persist(historicalRows([
      { url: "extension", extension: [history] },
    ])), undefined, { extension: [replacement] });
    expect(current.extension).toContainEqual(replacement);
    expect(current.extension).toContainEqual(history);
    const sourceCount = current.extension!.filter(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL).length;
    expect(sourceCount).toBe(2);
    for (let i = 0; i < 3; i++) {
      current = toDosageDetails(persist(toFhirR5Dosages(current)));
      expect(current.extension).toContainEqual(history);
      expect(current.extension!.filter(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL)).toHaveLength(sourceCount);
    }
  });

  it("emits valid expression-only R5 slots and restores their original associations", () => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: [
      { doseExpression: { language: "text/fhirpath", expression: "%weight * 2" } },
      { doseQuantity: { value: 5, unit: "mg" } },
      { rateExpression: { language: "text/fhirpath", expression: "%rate" } },
    ] }] }] };
    const rows = persist(toFhirR5Dosages(source));
    expect(rows[0].doseAndRate).toHaveLength(3);
    for (const index of [0, 2]) {
      const slot = rows[0].doseAndRate![index];
      expect(slot).not.toHaveProperty("doseExpression");
      expect(slot).not.toHaveProperty("rateExpression");
      expect(slot.doseQuantity).toBeUndefined();
      expect(slot.rateQuantity).toBeUndefined();
      expect(slot.extension?.[0].url).toBe(R5_EXPRESSION_SLOT_SOURCE_URL);
      expect(slot.extension?.[0].extension?.[0].valueExpression?.expression).toBe(index === 0 ? "%weight * 2" : "%rate");
    }
    const restored = toDosageDetails(rows);
    expect(restored.step![0].component[0].doseAndRate).toEqual(source.step![0].component[0].doseAndRate);
    expect(toDosageDetails(persist(toFhirR5Dosages(restored))).step![0].component[0].doseAndRate)
      .toEqual(source.step![0].component[0].doseAndRate);
    const scalar = fromR6Dosage(source.step![0].component[0], 1);
    expect(scalar.doseAndRate?.[0].extension?.[0].extension?.[0].valueExpression)
      .toEqual(source.step![0].component[0].doseAndRate![0].doseExpression);
    rows[0].doseAndRate![0].doseQuantity = { value: 7, unit: "mg" };
    const replaced = toDosageDetails(rows).step![0].component[0].doseAndRate![0];
    expect(replaced.doseQuantity).toEqual({ value: 7, unit: "mg" });
    expect(replaced.doseExpression).toBeUndefined();
  });

  it("keeps site wrapper metadata over repeated persisted R5 saves and respects a live concept clear", () => {
    const site = { id: "site-wrapper", extension: [{ url: "urn:example:site-note", valueString: "source note" }],
      concept: { text: "right eye" } };
    let source: FhirR6DosageInstruction = { step: [{ component: [{ ...persist(rowDose), site }] }] };
    for (let i = 0; i < 3; i++) {
      source = toDosageDetails(persist(toFhirR5Dosages(source)));
      expect(source.step![0].component[0].site).toEqual(site);
    }
    const rows = persist(toFhirR5Dosages(source));
    delete rows[0].site;
    const cleared = toDosageDetails(rows);
    expect(cleared.step![0].component[0].site?.concept).toBeUndefined();
    expect(toDosageDetails(persist(toFhirR5Dosages(cleared))).step![0].component[0].site?.concept).toBeUndefined();
  });

  it.each(["simple", "general"] as const)("removes stale active operator translations in %s quantities and retains their original coding", kind => {
    const originalCoding = { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000055", display: "Approximately",
      _display: { extension: [{ url: "http://hl7.org/fhir/StructureDefinition/translation", extension: [
        { url: "lang", valueCode: "th" }, { url: "content", valueString: "ประมาณ" },
      ] }] }, i18n: { th: "ประมาณ" } };
    const quantity: FhirR6Quantity = { value: 5, unit: "mg", comparator: "<", extension: [{
      url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL, valueCoding: originalCoding,
    }] };
    const write = kind === "simple" ? simpleQuantityForR5 : quantityForR5;
    const changed = write(quantity)!;
    const active = changed.extension!.find(item => item.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL)?.valueCoding;
    if (kind === "simple") {
      expect(active).toEqual({ system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000050", display: "less than" });
      expect(changed.extension).toContainEqual({
        url: "urn:ezmedicationinput:StructureDefinition:quantity-operator-source", valueCoding: originalCoding,
      });
    } else {
      expect(active).toBeUndefined();
      expect(changed.comparator).toBe("<");
      expect(changed.extension).toContainEqual({
        url: "urn:ezmedicationinput:StructureDefinition:quantity-operator-source", extension: quantity.extension,
      });
    }
    expect(getQuantityComparator(changed)).toBe("<");
    expect(write(persist(changed))!.extension).toEqual(changed.extension);
    expect(write({ ...quantity, comparator: "~" })!.extension?.[0].valueCoding).toEqual(originalCoding);
  });

  it("uses persisted live R5 maximum edits for scalar scheduling and retains explicit safety edits", () => {
    const initial: FhirDosage = { ...persist(rowDose),
      timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day } },
      maxDosePerPeriod: [{ numerator: { value: 2, unit: "tab" }, denominator: { value: 1, unit: "d" } }],
    };
    const row = persist(toEzDosages([initial])[0]);
    row.maxDosePerPeriod![0].numerator!.value = 1;
    expect(administrationFromR5(row).limits?.[0].amount?.value).toBe(1);
    const dates = nextDueDoses(row, { from: "2026-11-18T08:00:00Z", orderedAt: "2026-11-18T08:00:00Z",
      timeZone: "UTC", limit: 2 }).map(value => new Date(value).toISOString());
    expect(dates).toEqual(["2026-11-18T08:00:00.000Z", "2026-11-19T08:00:00.000Z"]);
    const explicit = persist(toEzDosages([initial])[0]);
    explicit.safety!.doseLimit![0].valueQuantity!.value = 3;
    expect(administrationFromR5(explicit).limits?.[0].amount?.value).toBe(3);
    const cleared = persist(toEzDosages([initial])[0]);
    delete cleared.maxDosePerPeriod;
    expect(administrationFromR5(cleared).limits).toBeUndefined();
    expect(administrationFromR5(cleared).safety).toBeUndefined();
  });

  it("migrates the actual previous-writer R5 course count without reinterpreting current step counts", () => {
    // Serialized origin/master output for a seven-day active/rest course,
    // copied as a wire fixture rather than produced by the current writer.
    const saved: FhirDosage[] = [{
      timing: { repeat: { frequency: 1, boundsDuration: { value: 7, unit: "days", system: "http://unitsofmeasure.org", code: "d" }, period: 1, periodUnit: FhirPeriodUnit.Day } },
      text: "Use 1 tablet once daily for 7 days.", sequence: 1,
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab", system: "http://standardterms.edqm.eu", code: "15054000" } }],
      modifierExtension: [{ url: DOSAGE_DETAILS_R5_URL, extension: [
        { url: "rowIndex", valueInteger: 0 }, { url: "sequence", valueInteger: 1 }, { url: "stepCount", valueInteger: 1 },
        { url: "step", extension: [{ url: "count", valueInteger: 3 }] },
        { url: "context", valueString: "72f2f03d1f8289c5" }, { url: "contextRequired", valueBoolean: true },
        { url: "course", extension: [{ url: "repeatCycle", valueQuantity: { value: 14, unit: "d", code: "d", system: "http://unitsofmeasure.org" } }] },
      ] }], extension: [{ url: "urn:ezmedicationinput:StructureDefinition:medication-rendered-instruction", extension: [
        { url: "instruction", valueString: "1 tablet daily for 7 days then stop for 7 days, repeat for 3 cycles" },
        { url: "row", extension: [{ url: "projectionFingerprint", valueString: "4346df4e5678f52b" }, { url: "textFingerprint", valueString: "dab22a241c7d0f4f" }] },
      ] }],
    }];
    const unrelated = { url: "urn:test:course-modifier", valueString: "retain policy" };
    const unrelatedEdit = toDosageDetails(persist(saved), undefined, { modifierExtension: [unrelated] });
    expect(getCourseCycleCount(unrelatedEdit)).toBe(3);
    expect(unrelatedEdit.modifierExtension).toContainEqual(unrelated);
    expect(unrelatedEdit.step![0].count).toBeUndefined();
    expect(getCourseCycleCount(toDosageDetails(persist(saved), undefined, {
      modifierExtension: [{ url: COURSE_CYCLE_COUNT_EXTENSION_URL, valueInteger: 4 }, unrelated],
    }))).toBe(4);
    // [] explicitly clears all legacy course modifiers. To clear only this
    // count, reopen the migrated public edit view and remove its visible entry.
    const clearedAll = toDosageDetails(persist(saved), undefined, { modifierExtension: [] });
    expect(getCourseCycleCount(clearedAll)).toBeUndefined();
    expect(clearedAll.step![0].count).toBeUndefined();
    expect(toDosageDetails(persist(toFhirR5Dosages(clearedAll))).step![0].count).toBeUndefined();
    const edit = persist(fromDosageDetails(unrelatedEdit));
    edit.course.modifierExtension = edit.course.modifierExtension!.filter(e => e.url !== COURSE_CYCLE_COUNT_EXTENSION_URL);
    const clear = toDosageDetails(edit.dosages, undefined, edit.course);
    expect(getCourseCycleCount(clear)).toBeUndefined();
    expect(clear.step![0].count).toBeUndefined();
    expect(clear.modifierExtension).toContainEqual(unrelated);
    const reopenedClear = toDosageDetails(persist(toFhirR5Dosages(clear)));
    expect(getCourseCycleCount(reopenedClear)).toBeUndefined();
    expect(reopenedClear.step![0].count).toBeUndefined();
    const migrated = toDosageDetails(persist(saved));
    expect(getCourseCycleCount(migrated)).toBe(3);
    expect(migrated.step![0].count).toBeUndefined();
    expect(migrated.extension).toContainEqual({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [saved[0].modifierExtension![0]] });
    const dates = nextDueDoses(migrated, { from: "2026-11-18T08:00:00Z", orderedAt: "2026-11-18T08:00:00Z", timeZone: "UTC", limit: 30 });
    // The historical frequency-only fixture uses the established 09:00
    // daily default; orderedAt at 08:00 is not an authored dosing clock.
    const expected: string[] = [];
    for (const start of ["2026-11-18", "2026-12-02", "2026-12-16"]) {
      expected.push(...Array.from({ length: 7 }, (_, day) =>
        new Date(Date.parse(start + "T09:00:00Z") + day * 86400000).toISOString().replace(".000Z", "+00:00")));
    }
    expect(dates).toEqual(expected);
    expect(getCourseCycleCount(toDosageDetails(persist(toFhirR5Dosages(migrated))))).toBe(3);
    const current: FhirR6DosageInstruction = { repeatCycle: { value: 14, unit: "d", code: "d" },
      step: [{ count: 2, component: [{ ...persist(rowDose), timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, boundsDuration: { value: 1, unit: "d", code: "d" } } } }] }] };
    expect(courseFromR6(current).cycleCount).toBeUndefined();
    for (const bounded of [false, true]) {
      const source = { ...current, ...(bounded ? { modifierExtension: [{ url: COURSE_CYCLE_COUNT_EXTENSION_URL, valueInteger: 3 }] } : {}) };
      const rows = persist(toFhirR5Dosages(source));
      expect(rows[0].modifierExtension?.find(item => item.url === DOSAGE_DETAILS_R5_URL)?.extension)
        .toContainEqual({ url: "countScope", valueCode: "step" });
      const restored = toDosageDetails(rows);
      expect(restored.step![0].count).toBe(2);
      expect(getCourseCycleCount(restored)).toBe(bounded ? 3 : undefined);
    }
  });
});

// END PRESERVED r521
}


// Retained boundary and strict-type suite from test/pr14-round21-boundaries.spec.ts.
{
  const generalQuantityForR5 = quantityForR5;
// BEGIN PRESERVED round39_boundaries
const tablet = () => ({ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] });
const persist = <T>(input: T): T => JSON.parse(JSON.stringify(input));
const boundary = { anchor: "treatment-start" as const, displacement: { value: 2, unit: "d" } };

describe("round 21 external boundary preservation", () => {
  it.each(["course", "step", "component"] as const)("preserves extension-only integer limits at %s scope", scope => {
    const safety: FhirR6DosageSafety = { doseLimit: [{ scope: "lifetime", _valueInteger: {
      id: "unknown-ceiling", extension: [{ url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown" }],
    } }] };
    const input: FhirR6DosageInstruction = { step: [{ component: [tablet()] }] };
    if (scope === "course") input.safety = safety;
    else if (scope === "step") { input.step![0].safety = safety; input.step!.push({ component: [tablet()] }); }
    else input.step![0].component[0].safety = safety;
    const read = (wire: FhirR6DosageInstruction) => scope === "course" ? wire.safety :
      scope === "step" ? wire.step![0].safety : wire.step![0].component[0].safety;
    const expectedSafety = persist(safety), original = persist(input);
    const imported = fromFhir(input);
    expect(input).toEqual(original);
    const rows = persist(toFhirR5Dosages(input)), originalRows = persist(rows);
    expect(input).toEqual(original);
    const reopened = toDosageDetails(rows);
    expect(rows).toEqual(originalRows);
    for (const wire of [imported.fhirNext, reopened]) {
      expect(read(wire)).toEqual(expectedSafety);
      expect(read(wire)!.doseLimit![0].valueInteger).toBeUndefined();
      expect(wire.step![0].component[0].doseAndRate![0].doseQuantity!.value).toBe(1);
    }
  });

  it.each(["reference", "definition"] as const)("keeps a %s event code and context path together", kind => {
    const start = {
      ...(kind === "reference" ? { contextReference: { reference: "Observation/trigger" } } :
        { contextDefinition: "https://example.org/PlanDefinition/trigger" }),
      contextCode: { coding: [{ system: "urn:test:events", code: "released" }] },
      contextPath: "effective.ofType(dateTime)", offsetDuration: { value: 2, unit: "h", code: "h" },
    };
    const source: FhirR6DosageInstruction = { step: [{ start, component: [tablet()] }] };
    expect(fromFhir(source).fhirNext.step![0].start).toEqual(start);
    const restored = toDosageDetails(persist(toFhirR5Dosages(source)));
    expect(restored.step![0].start).toEqual(start);
    expect(() => nextDueDoses(restored, { from: "2026-01-01T00:00:00Z", orderedAt: "2026-01-01T00:00:00Z", timeZone: "UTC", limit: 2 })).toThrow(/Unsupported.*RelativeTime/);
  });

  it("uses current cyclic dose values in normalized previews while retaining authored wording", () => {
    const source: FhirR6DosageInstruction = { renderedInstruction: "Take 1 tablet daily", repeatCycle: { value: 7, unit: "d" },
      step: [{ component: [{ ...tablet(), timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } } }] }] };
    source.step![0].component[0].doseAndRate![0].doseQuantity!.value = 2;
    expect(formatSig(source, "long", { locale: "en", realizationMode: "normalized" })).toContain("2 tablets");
    const native = importCanonicalCourse(source);
    expect(formatCanonicalCourse(native, "long", { locale: "en", realizationMode: "normalized" })).toContain("2 tablets");
    expect(courseToR6(native).renderedInstruction).toBe("Take 1 tablet daily");
  });

  it.each(["~", "<", ">=", "ad"] as const)("reopens retained drafts with an unchanged %s SimpleQuantity wire projection", comparator => {
    const native: CanonicalCourse = { kind: "course", stages: [
      { provenance: { id: "draft" }, end: boundary, administrations: [] },
      { provenance: { id: "active" }, administrations: [{ kind: "administration", amounts: [{ quantity: { value: 2, unit: "tab", comparator } }] }] },
    ] };
    const wire = courseToR6(native);
    expect(wire.step).toHaveLength(1);
    const reopened = importCanonicalCourse(persist(wire));
    expect(reopened.stages).toHaveLength(2);
    expect(reopened.stages[0].provenance?.id).toBe("draft");
    expect(reopened.stages[1].administrations[0].amounts![0].quantity!.comparator).toBe(comparator);
    expect(getQuantityComparator(wire.step![0].component[0].doseAndRate![0].doseQuantity)).toBe(comparator);
    expect(courseToR6(reopened)).toEqual(wire);
  });

  it("keeps a dose-edited pause, then retires it after a live boundary edit across repeated saves", () => {
    const native: CanonicalCourse = { kind: "course", stages: [
      { provenance: { id: "unmatched-draft-note" }, end: boundary, administrations: [] },
      { administrations: [{ kind: "administration", amounts: [{ quantity: { value: 1, unit: "tab" } }] }] },
    ] };
    let wire = persist(courseToR6(native));
    wire.step![0].component[0].doseAndRate![0].doseQuantity!.value = 2;
    wire = courseToR6(importCanonicalCourse(wire));
    const doseEdited = importCanonicalCourse(wire);
    expect(doseEdited.stages).toHaveLength(2);
    expect(doseEdited.stages[0].end).toMatchObject(boundary);
    expect(doseEdited.stages[1].administrations[0].amounts![0].quantity!.value).toBe(2);
    expect(wire.step![0].start!.offsetDuration!.value).toBe(2);
    wire = persist(wire);
    wire.step![0].start!.offsetDuration!.value = 3;
    wire = courseToR6(importCanonicalCourse(wire));
    expect(wire.step![0].start!.offsetDuration!.value).toBe(3);
    expect(wire.extension?.some(e => e.url === R6_DRAFT_STEPS_SOURCE_URL)).not.toBe(true);
    expect(JSON.stringify(wire)).toContain("unmatched-draft-note");
    for (let round = 0; round < 3; round++) {
      const restored = fromDosageDetails(persist(wire));
      expect(restored.course.step).toHaveLength(1);
      const saved = toDosageDetails(persist(toFhirR5Dosages(wire)));
      expect(JSON.stringify(saved)).toContain("unmatched-draft-note");
      expect(importCanonicalCourse(saved).stages).toHaveLength(1);
      expect(saved.step![0].component[0].doseAndRate![0].doseQuantity!.value).toBe(2);
      expect(saved.step![0].start!.offsetDuration!.value).toBe(3);
      if (round > 0) expect(saved).toEqual(wire);
      wire = saved;
    }
  });

  it("preserves typed Ratio conditions and opaque annotations", () => {
    const condition: FhirR6DosageCondition = { code: { text: "Ratio threshold" },
      valueRatio: { numerator: { value: 2, unit: "mg" }, denominator: { value: 1, unit: "mL" } },
      extension: [{ url: "urn:test:condition", valueString: "source annotation" }],
    };
    const source: FhirR6DosageInstruction = { step: [{ component: [{ ...tablet(), condition: [condition] }] }] };
    expect(toDosageDetails(persist(toFhirR5Dosages(source))).step![0].component[0].condition).toEqual([condition]);
  });

  it("keeps R5 maximum Ratio metadata when numerical values are edited", () => {
    const ratio = { id: "maximum-ratio", extension: [{ url: "urn:test:ratio-note", valueString: "retain" }],
      numerator: { value: 4, unit: "tab" }, denominator: { value: 1, unit: "d" } };
    const source: FhirDosage = { ...tablet(), maxDosePerPeriod: [ratio] };
    const edited = persist(source);
    edited.maxDosePerPeriod![0].numerator!.value = 3;
    const native = importCanonicalCourse(edited);
    const r5 = courseToR5(native);
    expect(r5[0].maxDosePerPeriod?.[0]).toEqual({ ...ratio, numerator: { value: 3, unit: "tab" } });
    const r6 = courseToR6(native);
    expect(r6.step![0].component[0].safety!.doseLimit![0]).not.toHaveProperty("numerator");
    expect(toFhirR5Dosages(persist(r6))[0].maxDosePerPeriod?.[0]).toEqual(r5[0].maxDosePerPeriod![0]);
  });

  it("keeps Ratio metadata through the editable R5 safety view and a persisted edit", () => {
    const ratio = { id: "editable-maximum-ratio", extension: [{ url: "urn:test:ratio-note", valueString: "retain" }],
      numerator: { value: 4, unit: "tab" }, denominator: { value: 1, unit: "d" } };
    const editable = persist(toEzDosages([{ ...tablet(), maxDosePerPeriod: [ratio] }]));
    editable[0].maxDosePerPeriod![0].numerator!.value = 3;
    const saved = toFhirR5Dosages(editable)[0].maxDosePerPeriod![0];
    expect(saved).toEqual({ ...ratio, numerator: { value: 3, unit: "tab" } });
  });

  it("retains source-marker annotations and duplicate markers without history growth", () => {
    const native: CanonicalCourse = { kind: "course", stages: [
      { end: boundary, administrations: [] },
      { administrations: [{ kind: "administration", amounts: [{ quantity: { value: 1, unit: "tab" } }] }] },
    ] };
    let wire = courseToR6(native);
    const marker = wire.extension!.find(e => e.url === R6_DRAFT_STEPS_SOURCE_URL)!;
    marker.id = "source-marker-id";
    marker.extension!.push({ url: "urn:test:future-source-child", valueString: "retain-future-source" });
    const duplicate = { ...persist(marker), id: "second-source-marker" };
    wire.extension!.push(duplicate);
    wire = courseToR6(importCanonicalCourse(persist(wire)));
    expect(importCanonicalCourse(wire).stages).toHaveLength(2);
    expect(wire.extension!.find(e => e.url === R6_DRAFT_STEPS_SOURCE_URL)!.id).toBe("source-marker-id");
    expect(JSON.stringify(wire)).toContain("retain-future-source");
    expect(JSON.stringify(wire)).toContain("second-source-marker");
    expect(courseToR6(importCanonicalCourse(persist(wire)))).toEqual(wire);
    wire = persist(wire); // Edit the persisted external value, not a borrowed projection.
    wire.step![0].component[0].doseAndRate![0].doseQuantity!.value = 2;
    wire = courseToR6(importCanonicalCourse(persist(wire)));
    const doseEdited = importCanonicalCourse(wire);
    expect(doseEdited.stages).toHaveLength(2);
    expect(doseEdited.stages[0].end).toMatchObject(boundary);
    expect(doseEdited.stages[1].administrations[0].amounts![0].quantity!.value).toBe(2);
    expect(courseToR6(importCanonicalCourse(persist(wire)))).toEqual(wire);
    wire = persist(wire);
    wire.step![0].start!.offsetDuration!.value = 3;
    wire = courseToR6(importCanonicalCourse(wire));
    expect(importCanonicalCourse(wire).stages).toHaveLength(1);
    expect(wire.step![0].start!.offsetDuration!.value).toBe(3);
    expect(JSON.stringify(wire)).toContain("source-marker-id");
    expect(JSON.stringify(wire)).toContain("second-source-marker");
    expect(JSON.stringify(wire)).toContain("retain-future-source");
    expect(courseToR6(importCanonicalCourse(persist(wire)))).toEqual(wire);
  });

  it("keeps conflicting qualified ratio source portable through strict R5", () => {
    const input = [{ doseAndRate: [{
      doseQuantity: { value: 3, unit: "mg" },
      rateRatio: { numerator: generalQuantityForR5({ value: 10, unit: "mL", comparator: "~" })!,
        denominator: { value: 1, unit: "h" } },
      rateExpression: { language: "text/fhirpath", expression: "%patient.weight" },
    }] }];
    const first = toDosageDetails(input);
    for (const amount of [first.step![0].component[0].doseAndRate![0],
      toFhirR5Dosages(persist(first))[0].doseAndRate![0]]) {
      const saved = amount.extension!.find(e => e.url === "urn:ezmedicationinput:r6-unresolved-rate-source")!
        .extension!.find(e => e.url === "rateRatio")!.valueRatio!;
      expect(saved.numerator!.comparator).toBeUndefined();
      expect(getQuantityComparator(saved.numerator)).toBe("~");
      expect(amount.doseQuantity!.value).toBe(3);
      expect(amount.rateRatio).toBeUndefined();
      expect(amount).not.toHaveProperty("rateExpression");
    }
  });

  it.each(["dose", "rate"] as const)("retains conflicting external %s edits without choosing an active value", kind => {
    const expression = { language: "text/fhirpath", expression: "%patient.weight * 3" };
    const amount = kind === "dose" ? {
      doseQuantity: { value: 3, unit: "mg" }, doseExpression: expression, rateQuantity: { value: 5, unit: "mL/h" },
    } : { doseQuantity: { value: 3, unit: "mg" }, rateQuantity: { value: 5, unit: "mL/h" }, rateExpression: expression };
    const input = [{ doseAndRate: [amount] }];
    const before = persist(input);
    const saved = toDosageDetails(input);
    const current = saved.step![0].component[0].doseAndRate![0];
    expect(kind === "dose" ? current.doseQuantity : current.rateQuantity).toBeUndefined();
    expect(kind === "dose" ? current.doseExpression : current.rateExpression).toBeUndefined();
    expect(kind === "dose" ? current.rateQuantity!.value : current.doseQuantity!.value).toBe(kind === "dose" ? 5 : 3);
    const source = current.extension!.find(e => e.url === `urn:ezmedicationinput:r6-unresolved-${kind}-source`)!;
    expect(source.extension).toHaveLength(2);
    expect(source.extension!.find(child => child.url === kind + "Quantity")!.valueQuantity)
      .toEqual(kind === "dose" ? { value: 3, unit: "mg" } : { value: 5, unit: "mL/h" });
    expect(source.extension!.find(child => child.url === kind + "Expression")!.valueExpression).toEqual(expression);
    expect(() => fromFhir(saved)).not.toThrow();
    expect(toDosageDetails(persist(toFhirR5Dosages(saved))).step![0].component[0].doseAndRate![0]).toEqual(current);
    expect(input).toEqual(before);
  });
});


const dailyTablet = (value = 1) => ({
  doseAndRate: [{ doseQuantity: { value, unit: "tab" } }],
  timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
});

describe("round 23 public boundary corrections", () => {
  it("retains fractional offsets and zero minimum frequency only in their typed wire extensions", () => {
    const offset = 0.5;
    const extensions = [
      { url: TIMING_OFFSET_EXACT_EXTENSION_URL, valueDecimal: offset },
      { url: TIMING_FREQUENCY_MIN_EXTENSION_URL, valueInteger: 0 },
    ];
    const input: FhirR6DosageInstruction = { step: [{ component: [{ ...dailyTablet(), timing: { repeat: {
      frequencyMax: 2, period: 1, periodUnit: FhirPeriodUnit.Day, extension: extensions,
    } } }] }] };
    const before = persist(input);
    const native = importCanonicalCourse(input);
    expect(native.stages[0].administrations[0].schedule?.recurrence).toMatchObject({ frequency: 0, offset });
    for (const timing of [courseToR5(native)[0].timing, courseToR6(native).step![0].component[0].timing]) {
      expect(timing?.repeat?.offset).toBeUndefined();
      expect(timing?.repeat?.frequency).toBeUndefined();
      expect(timing?.repeat?.extension?.filter(e => e.url === TIMING_OFFSET_EXACT_EXTENSION_URL))
        .toEqual([extensions[0]]);
      expect(timing?.repeat?.extension?.filter(e => e.url === TIMING_FREQUENCY_MIN_EXTENSION_URL))
        .toEqual([extensions[1]]);
    }
    expect(input).toEqual(before);
  });

  it("retains ordinary unsigned integer offsets and positive frequencies in standard wire fields", () => {
    const input: FhirR6DosageInstruction = { step: [{ component: [{ ...dailyTablet(), timing: { repeat: {
      frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, when: [EventTiming["Before Meal"]], offset: 30,
    } } }] }] };
    const native = importCanonicalCourse(input);
    for (const timing of [courseToR5(native)[0].timing, courseToR6(native).step![0].component[0].timing])
      expect(timing?.repeat).toMatchObject({ frequency: 1, when: [EventTiming["Before Meal"]], offset: 30 });
  });

  it("keeps phase-origin Element metadata through edits and repeated version crossings", () => {
    const origin = { id: "origin-element", url: PARALLEL_COMPONENT_PHASE_ORIGIN_URL,
      valueQuantity: { id: "origin-quantity", value: 2, unit: "d", extension: [{ url: "urn:origin-note", valueString: "authored" }] } };
    const sibling = { id: "independent", url: "urn:other-modifier", valueString: "keep" };
    const input: FhirR6DosageInstruction = { step: [{ component: [{ ...dailyTablet(), modifierExtension: [origin, sibling] }] }] };
    const before = persist(input);
    const native = importCanonicalCourse(input);
    expect(courseToR6(native).step![0].component[0].modifierExtension).toEqual([origin, sibling]);
    const edited = persist(input);
    edited.step![0].component[0].modifierExtension![0].valueQuantity!.value = 3;
    const expected = edited.step![0].component[0].modifierExtension;
    let wire = edited;
    for (let pass = 0; pass < 3; pass++) {
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      expect(wire.step![0].component[0].modifierExtension).toEqual(expected);
    }
    expect(input).toEqual(before);
  });

  it.each([undefined, {}, { locale: "en" }, { locale: "th" }, { realizationMode: "roundtrip" }] as Array<FormatOptions | undefined>)(
    "previews edited R6 fields while keeping original wording (%j)", options => {
      const input: FhirR6DosageInstruction = { renderedInstruction: "Take 1 tablet daily", step: [{ component: [{
        ...dailyTablet(2), text: "Take 1 tablet daily",
      }] }] };
      const before = persist(input);
      for (const style of ["short", "long"] as const) {
        const text = formatSig(input, style, options);
        expect(text.match(/(?:^|[^\p{L}\p{N}.,+\-])2\s*(?:tablets?|tabs?|เม็ด)(?![\p{L}\p{N}])/gu)).toHaveLength(1);
        expect(text.split(/; (?:original directions|ข้อความเดิม):/u)[0])
          .not.toMatch(/(?:^|[^0-9])1\s*(?:tab|tablet|เม็ด)/u);
        expect(text).toContain("Take 1 tablet daily");
      }
      const imported = fromFhir(input, options);
      for (const text of [imported.shortText, imported.longText, imported.items[0].shortText, imported.items[0].longText]) {
        expect(text.match(/(?:^|[^\p{L}\p{N}.,+\-])2\s*(?:tablets?|tabs?|เม็ด)(?![\p{L}\p{N}])/gu)).toHaveLength(1);
        expect(text.split(/; (?:original directions|ข้อความเดิม):/u)[0])
          .not.toMatch(/(?:^|[^0-9])1\s*(?:tab|tablet|เม็ด)/u);
        expect(text).toContain("Take 1 tablet daily");
      }
      expect(imported.fhirNext.renderedInstruction).toBe("Take 1 tablet daily");
      expect(courseToR6(importCanonicalCourse(input)).renderedInstruction).toBe("Take 1 tablet daily");
      expect(input).toEqual(before);
    }
  );

  it("uses live rich R6 component values while retaining their authored text", () => {
    const input: FhirR6DosageInstruction = { renderedInstruction: "Infuse 1 mg at 4 mL/h", step: [{ component: [{
      text: "Infuse 1 mg at 4 mL/h", doseAndRate: [{ doseQuantity: { value: 2, unit: "mg" },
        rateQuantity: { value: 5, unit: "mL/h" } }],
    }] }] };
    const imported = fromFhir(input);
    for (const text of [formatSig(input, "short"), formatSig(input, "long"),
      imported.shortText, imported.longText, imported.items[0].shortText, imported.items[0].longText]) {
      expect(text).toMatch(/(?:^|[^0-9.])2\s*mg\b/u);
      expect(text).toMatch(/(?:^|[^0-9.])5\s*mL\/h\b/u);
      const current = text.split("; original directions:")[0];
      expect(current).not.toMatch(/(?:^|[^0-9.])1\s*mg\b/u);
      expect(current).not.toMatch(/(?:^|[^0-9.])4\s*mL\/h\b/u);
      expect(text).toContain("; original directions: Infuse 1 mg at 4 mL/h");
    }
    expect(imported.fhirNext.step![0].component[0].text).toBe("Infuse 1 mg at 4 mL/h");
  });

  it("still displays text-only R6 instructions without inventing an administration", () => {
    const input = { renderedInstruction: "Use as directed by the clinic" };
    expect(formatSig(input, "long")).toBe(input.renderedInstruction);
    expect(fromFhir(input).longText).toBe(input.renderedInstruction);
    expect(importCanonicalCourse(input).stages).toEqual([]);
  });

  it.each([undefined, "Apply as instructed."])("preserves text-only R6 components with header %s", header => {
    const input: FhirR6DosageInstruction = { ...(header ? { renderedInstruction: header } : {}),
      step: [{ component: [{ text: "Apply as instructed.", timing: { id: "timing-source-only" } }] }] };
    for (const realizationMode of [undefined, "roundtrip", "normalized"] as const) {
      expect(formatSig(input, "long", { realizationMode })).toBe("Apply as instructed.");
      const imported = fromFhir(input, { realizationMode });
      expect(imported.longText).toBe("Apply as instructed.");
      expect(imported.items[0].longText).toBe("Apply as instructed.");
      expect(imported.fhirNext).toEqual(input);
    }
  });

  it("honors a caller separator between generated R5 course stages", () => {
    const rows = [{ ...dailyTablet(1), sequence: 1 }, { ...dailyTablet(2), sequence: 2 }];
    for (const locale of ["en", "th"]) {
      const text = formatSigBatch(rows, "long", { locale, separator: "\n" });
      const stages = text.split("\n");
      expect(stages).toHaveLength(2);
      expect(stages[0]).toMatch(/1\s*(?:tab|tablet|เม็ด)/u);
      expect(stages[1]).toMatch(/2\s*(?:tab|tablet|เม็ด)/u);
    }
  });

  it.each([false, true])("does not begin a rate-range preview with a separator (dose=%s)", withDose => {
    const row: FhirDosage = { doseAndRate: [{
      ...(withDose ? { doseQuantity: { value: 2, unit: "mg" } } : {}),
      rateRange: { low: { value: 5, unit: "mL/h" }, high: { value: 10, unit: "mL/h" } },
    }] };
    const text = formatSig(row, "short");
    expect(text).not.toMatch(/^\s*[;,]/u);
    expect(text).toMatch(/(?<![\d.])5–10 mL\/h(?![\w/])/u);
    if (withDose) expect(text).toMatch(/2 mg; /u);
  });


});

describe("round 25 live rate and wire boundary regressions", () => {
  it.each([false, true])("uses a newly submitted rate-only R5 amount (original persisted=%s)", persisted => {
    const source = "Infuse at 5 mL/h";
    const fresh = parseSig(source).fhir[0];
    let row = persisted ? persist(fresh) : fresh;
    expect(formatSig(row, "long", { locale: "en", realizationMode: "roundtrip" })).toBe(source);
    expect(formatSig(row, "long", { locale: "en" })).toContain("Rate: 5 mL/h");
    row = persist(row);
    row.doseAndRate![0].rateQuantity!.value = 10;
    for (const text of [formatSig(row, "long", { locale: "en" }),
      formatSig(row, "long", { locale: "en", realizationMode: "roundtrip" }),
      fromFhirDosage(row, { locale: "en" }).longText]) {
      expect(text).toContain("Rate: 10 mL/h");
      expect(text).not.toContain("5 mL/h");
    }
    expect(row.text).toBe(source);
    expect(toDosageDetails([row]).step![0].component[0].doseAndRate![0].rateQuantity)
      .toMatchObject({ value: 10, unit: "mL/h" });
  });

  it.each([false, true])("uses an independently submitted R5 rate ratio (original persisted=%s)", persisted => {
    const source = "Infuse 120 mL over 2 hours";
    const fresh = parseSig(source).fhir[0];
    let row = persisted ? persist(fresh) : fresh;
    expect(formatSig(row, "long", { locale: "en", realizationMode: "roundtrip" })).toBe(source);
    expect(formatSig(row, "long", { locale: "en" })).toContain("Rate: 120 mL / 2 h");
    row = persist(row);
    row.doseAndRate![0].rateRatio!.denominator!.value = 4;
    for (const text of [formatSig(row, "long", { locale: "en" }),
      fromFhirDosage(row, { locale: "en" }).longText]) {
      expect(text).toContain("Rate: 120 mL / 4 h");
      expect(text).not.toContain("Rate: 120 mL / 2 h");
    }
    expect(row.doseAndRate![0].doseQuantity!.value).toBe(120);
    expect(row.text).toBe(source);
  });

  it("keeps a replaced rate range live without removing its original source", () => {
    const row = persist(parseSig("Infuse at 5 mL/h").fhir[0]);
    delete row.doseAndRate![0].rateQuantity;
    row.doseAndRate![0].rateRange = { low: { value: 10, unit: "mL/h" }, high: { value: 15, unit: "mL/h" } };
    for (const text of [formatSig(row, "long", { locale: "en" }),
      fromFhirDosage(row, { locale: "en" }).longText]) {
      expect(text).toMatch(/(?<![\d.])10–15 mL\/h(?![\w/])/u);
      expect(text).not.toContain("at 5 mL/h");
    }
    expect(row.text).toBe("Infuse at 5 mL/h");
  });

  it.each([false, true])("omits empty R6 step on a text-only instruction with safety=%s", safety => {
    const wire: FhirR6DosageInstruction = {
      id: "authored-directions", renderedInstruction: "Take as directed",
      extension: [{ url: "urn:test:authored", valueString: "retained" }],
      ...(safety ? { safety: { doseLimit: [{ scope: "lifetime", valueInteger: 8 }] } } : {}),
    };
    for (const output of [fromFhir(wire).fhirNext, fromFhir({ ...wire, step: [] }).fhirNext,
      courseToR6(courseFromR6(wire)), toDosageDetails(persist(toFhirR5Dosages(wire)))]) {
      expect(Object.prototype.hasOwnProperty.call(output, "step")).toBe(false);
      expect(output.renderedInstruction).toBe("Take as directed");
      expect(output.extension).toContainEqual({ url: "urn:test:authored", valueString: "retained" });
      if (safety) expect(output.safety?.doseLimit).toEqual([{ scope: "lifetime", valueInteger: 8 }]);
    }
  });

  it("accepts R5 Timing modifier metadata while retaining its R5 repeat boundary", () => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { modifierExtension: [{ url: "urn:test:timing-modifier", valueBoolean: true }],
        repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } } };
    expect(toFhirR5Dosages(toDosageDetails([row]))[0].timing?.modifierExtension)
      .toEqual([{ url: "urn:test:timing-modifier", valueBoolean: true }]);
    // @ts-expect-error R6 period offsets do not belong to an R5 Timing.repeat.
    const r6OnlyOffset: FhirDosage = { timing: { repeat: { startOffset: { value: 1, unit: "h" } } } };
    void r6OnlyOffset;
  });

  it.each([
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ])("intersects rate-only quantity caps independent of order %j", (...order) => {
    const amounts = [{ value: 1000, unit: "mg" }, { value: 0.5, unit: "g" }, { value: 0.75, unit: "g" }];
    const limits: FhirR6DoseLimit[] = [];
    for (const scope of ["administration", "lifetime"] as const)
      for (const index of order) limits.push({ scope, valueQuantity: amounts[index] });
    const wire: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ rateQuantity: { value: 5, unit: "mL/h" } }], safety: { doseLimit: limits },
    }] }] };
    for (const course of [courseFromR6(wire),
      courseFromR6(toDosageDetails(persist(toFhirR5Dosages(wire))))]) {
      const actual = numericAdministrationLimits(course.stages[0].administrations[0]);
      expect(actual.administration).toMatchObject({ value: 0.5, unit: "g" });
      expect(actual.lifetime).toMatchObject({ value: 0.5, unit: "g" });
      expect(actual.multiple).toBe(false);
    }
  });
});


describe("round33 adjacent range metadata", () => {
  it.each([
    { low: { value: 2 }, high: { value: 5, unit: "mg" } },
    { low: { value: 2 }, high: { value: 5, system: "http://unitsofmeasure.org", code: "mg" } },
    { low: { extension: [{ url: "urn:local:unmeasured", valueString: "not specified" }] },
      high: { value: 5, system: "http://unitsofmeasure.org", code: "mg" } }
  ])("retains the known endpoint unit when the other endpoint has none: %j", range => {
    const row: FhirDosage = { doseAndRate: [{ doseRange: range }] };
    const source = JSON.stringify(row);
    const parsed = fromFhirDosage(row);
    if (range.low.value !== undefined) {
      // A single shared unit cannot describe both independently authored
      // valued endpoints. The complete rich range remains the suggestion.
      expect(parsed.meta.canonical.clauses[0].dose).toBeUndefined();
      expect(parsed.meta.normalized.unit).toBeUndefined();
      for (const locale of ["en", "th"])
        expect(formatSig(row, "long", { locale, realizationMode: "normalized" })).toContain("2 – 5 mg");
    } else {
      expect(parsed.meta.canonical.clauses[0].dose?.unit).toBe("mg");
      expect(parsed.meta.normalized.unit).toBe("mg");
    }
    expect(importCanonicalCourse(row).stages[0].administrations[0].amounts![0].range).toEqual(range);
    const reopened = toDosageDetails(persist([row]));
    expect(reopened.step![0].component[0].doseAndRate![0].doseRange).toEqual(range);
    expect(toFhirR5Dosages(reopened)[0].doseAndRate![0].doseRange).toEqual(range);
    expect(JSON.stringify(row)).toBe(source);
  });
});

it("round37 updates a known equality display after a code-only edit and preserves unchanged equality", () => {
  const marker = { url: "http://ema.europa.eu/fhir/extension/comparator",
    valueCoding: { id: "authored-equality", system: "http://spor.ema.europa.eu/v1/lists/100000000008",
      code: "100000000049", display: "equal to" } };
  const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 2, unit: "tab", extension: [marker] } }] };
  expect(toDosageDetails([row]).step![0].component[0].doseAndRate![0].doseQuantity?.extension).toEqual([marker]);
  const edited = persist(row);
  edited.doseAndRate![0].doseQuantity!.extension![0].valueCoding!.code = "100000000052";
  const changed = toDosageDetails([edited]).step![0].component[0].doseAndRate![0].doseQuantity!;
  expect(changed).toMatchObject({ value: 2, unit: "tab" });
  expect(getQuantityComparator(changed)).toBe("<=");
  expect(changed.extension).toContainEqual({ ...marker,
    valueCoding: { ...marker.valueCoding, code: "100000000052", display: "less than or equal to" } });
  expect(changed.extension).toContainEqual({
    url: "urn:ezmedicationinput:StructureDefinition:quantity-operator-source",
    valueCoding: { ...marker.valueCoding, code: "100000000052" },
  });
});

// END PRESERVED round39_boundaries
}

describe("round57 interop annotation and historical ownership", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] };
  const boundary = (value: number) => ({ contextCode: { coding: [{
    system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start",
  }] }, offsetDuration: { value, unit: "d" } });
  const historicalMarker = (step: FhirR6DosageStep): FhirExtension => ({
    url: DOSAGE_DETAILS_R5_URL, extension: [{ url: "dosageDetails",
      extension: [encodeR6SourceMetadata("step", step, "step")] }],
  });

  const expressionInput = (slot: "dose" | "rate", identity: string) => {
    const expressions = ["first retained expression", identity === "same expression"
      ? "first retained expression" : "surviving retained expression"].map(expression => ({
      language: "text/cql", expression,
    }));
    const values = [5, identity === "distinct projection" ? 7 : 5];
    const components: FhirR6Dosage[] = expressions.map((expression, index) => ({
      ...(identity === "identified" ? { id: index ? "survivor" : "removed" } : {}),
      timing: { repeat: daily },
      doseAndRate: [slot === "dose"
        ? { doseExpression: expression, rateQuantity: { value: values[index], unit: "mL/h" } }
        : { doseQuantity: q(values[index]), rateExpression: expression }],
    }));
    const rows: FhirDosage[] = [{
      sequence: 1, ...(identity === "identified" ? { id: "survivor" } : {}),
      timing: { repeat: daily },
      doseAndRate: [slot === "dose" ? { rateQuantity: { value: values[1], unit: "mL/h" } }
        : { doseQuantity: q(values[1]) }],
      modifierExtension: [historicalMarker({ component: components })],
    }];
    return { rows, expressions, value: values[1] };
  };

  it.each([
    ["dose", "anonymous"], ["dose", "identified"], ["dose", "distinct projection"], ["dose", "same expression"],
    ["rate", "anonymous"], ["rate", "identified"], ["rate", "distinct projection"], ["rate", "same expression"],
  ] as const)("restores only the owned historical %s expression after deletion (%s)", (slot, identity) => {
    const { rows, expressions, value } = expressionInput(slot, identity), before = persist(rows);
    let wire = toDosageDetails(rows);
    for (let save = 0; save < 2; save++) {
      expect(wire.step![0].component).toHaveLength(1);
      const amount = wire.step![0].component[0].doseAndRate![0];
      expect(slot === "dose" ? amount.rateQuantity : amount.doseQuantity)
        .toEqual(slot === "dose" ? { value, unit: "mL/h" } : q(value));
      expect(slot === "dose" ? amount.doseExpression : amount.rateExpression)
        .toEqual(identity === "anonymous" ? undefined : expressions[1]);
      if (identity === "anonymous") for (const expression of expressions)
        expect(JSON.stringify(wire.extension)).toContain(expression.expression);
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
    }
    expect(rows).toEqual(before);
  });

  const safetyInput = (variant: string) => {
    const safety = { doseLimit: [{ scope: "administration" as const, valueQuantity: q(2) }],
      extension: [{ url: "urn:clinic:policy-code", valueCodeableConcept: {
        coding: [{ system: "urn:clinic:policy", code: "dose-policy",
          extension: [{ url: "urn:clinic:policy-note", valueString: "retain the policy coding annotation" }] }],
      } }],
    };
    const step: FhirR6DosageStep = { component: [{
      id: "policy-dose", doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily }, safety,
    }] };
    const rows: EzDosage[] = persist(toFhirR5Dosages({ step: [step] }));
    rows[0].modifierExtension = [
      ...(rows[0].modifierExtension ?? []).filter(item => item.url !== DOSAGE_DETAILS_R5_URL), historicalMarker(step),
    ];
    const current: NonNullable<EzDosage["safety"]> = persist(safety);
    if (variant.startsWith("version")) {
      current.extension![0].valueCodeableConcept!.coding![0].version = "2026-11";
      if (variant === "version and dose")
        current.extension![0].valueCodeableConcept!.coding![0]._version = { id: "current-policy-edition" };
    }
    if (variant !== "omitted") rows[0].safety = current;
    if (variant === "version and dose") rows[0].doseAndRate![0].doseQuantity!.value = 2;
    return { rows, safety, current };
  };

  it.each(["omitted", "unchanged", "version", "version and dose"] as const)(
    "keeps supplied historical safety Coding metadata (%s)", variant => {
      const { rows, safety, current } = safetyInput(variant), before = persist(rows);
      let wire = toDosageDetails(rows);
      for (let save = 0; save < 2; save++) {
        expect(wire.step![0].component[0].safety).toEqual(variant === "omitted" ? safety : current);
        expect(wire.step![0].component[0].doseAndRate![0].doseQuantity)
          .toEqual(q(variant === "version and dose" ? 2 : 1));
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      }
      expect(rows).toEqual(before);
    });

  const durationInput = (variant: string): FhirR6DosageInstruction => {
    const saved = toDosageDetails([
      { sequence: 1, id: "induction-dose", doseAndRate: [{ doseQuantity: q(1) }],
        timing: { repeat: { ...daily, boundsDuration: { value: 1, unit: "d" } } } },
      { sequence: 3, id: "maintenance-dose", doseAndRate: [{ doseQuantity: q(2) }],
        timing: { repeat: { ...daily, count: 1 } } },
    ], undefined, { step: [
      { sequence: 1, id: "induction" },
      { sequence: 2, id: "pause", end: boundary(3),
        extension: [{ url: "urn:clinic:pause", valueString: "retain the prescribed pause" }] },
      { sequence: 3, id: "maintenance" },
    ] });
    const input = persist(saved), duration = input.step![0].component[0].timing!.repeat!.boundsDuration!;
    if (variant === "annotation") duration._value = { id: "current-duration-note",
      extension: [{ url: "urn:clinic:duration-note", valueString: "one-day annotation only" }] };
    if (variant === "value") duration.value = 2;
    if (variant === "unit") duration.unit = "wk";
    if (variant === "qualifier") duration.comparator = ">";
    return input;
  };

  it.each(["unchanged", "annotation", "value", "unit", "qualifier"] as const)(
    "keeps the editable pause only for unchanged duration meaning (%s)", variant => {
      const input = durationInput(variant), before = persist(input), editable = fromDosageDetails(input);
      const unchanged = variant === "unchanged" || variant === "annotation";
      expect(editable.course.step!.map(step => step.id))
        .toEqual(["induction", ...(unchanged ? ["pause"] : []), "maintenance"]);
      const duration = input.step![0].component[0].timing!.repeat!.boundsDuration;
      expect(editable.dosages[0].timing!.repeat!.boundsDuration).toEqual(duration);
      const reopened = toDosageDetails(persist(editable.dosages), undefined, persist(editable.course));
      expect(fromDosageDetails(reopened).course.step!.map(step => step.id))
        .toEqual(["induction", ...(unchanged ? ["pause"] : []), "maintenance"]);
      expect(JSON.stringify(reopened)).toContain("retain the prescribed pause");
      expect(input).toEqual(before);
    });

  const cycleInput = (variant: string) => {
    const url = variant === "period annotation" ? "periodDays" : variant === "cycles annotation" ? "cycles" : "anchor";
    const child: FhirExtension & { _valueString?: FhirElement; _valueInteger?: FhirElement } = {
      url, id: "authored-cycle-child",
      ...(variant === "valued anchor" ? { valueString: "2026-01-01" } :
        url === "anchor" ? { _valueString: { id: "cycle-anchor",
          extension: [{ url: "urn:clinic:cycle-note", valueString: "retain the unvalued anchor" }] } } :
        { _valueInteger: { id: "cycle-integer-note" } }),
    };
    const marker: FhirExtension = { url: CYCLE_DAY_ELIGIBILITY_EXTENSION_URL, id: "authored-cycle-marker",
      extension: [{ url: "day", valueInteger: 1 }, child,
        { url: "reason", valueCode: "unresolved-cycle-eligibility" },
        { url: "source", valueString: "authored cycle constraint" },
        { url: "urn:clinic:cycle-unknown", valueString: "retain this child" }],
    };
    const rows: FhirDosage[] = [{ doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily },
      modifierExtension: [marker] }];
    return { rows, marker };
  };

  it.each(["anchor annotation", "period annotation", "cycles annotation", "valued anchor"] as const)(
    "preserves the complete cycle marker on an unchanged save (%s)", variant => {
      const { rows, marker } = cycleInput(variant), before = persist(rows);
      let wire = toDosageDetails(rows);
      for (let save = 0; save < 2; save++) {
        expect(wire.step![0].component[0].modifierExtension)
          .toContainEqual(marker);
        expect(toFhirR5Dosages(persist(wire))[0].modifierExtension).toContainEqual(marker);
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      }
      expect(rows).toEqual(before);
    });

  const sequenceInput = (variant: string) => {
    const original = { id: "original-sequence-note",
      extension: [{ url: "urn:clinic:sequence-note", valueString: "retain the authored ordering annotation" }] };
    const current = { id: "current-sequence-note",
      extension: [{ url: "urn:clinic:current-sequence-note", valueString: "replacement ordering annotation" }] };
    let rows: Array<FhirDosage & { _sequence?: FhirElement }> = [{
      sequence: 1, _sequence: original, doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily },
    }];
    if (variant !== "unchanged") {
      rows = persist(toFhirR5Dosages(toDosageDetails(rows)));
      if (variant === "replacement") rows[0]._sequence = current;
      else delete rows[0]._sequence;
    }
    return { rows, expected: variant === "removed" ? undefined : variant === "replacement" ? current : original };
  };

  it.each(["unchanged", "replacement", "removed"] as const)(
    "retains the current R5 sequence annotation as typed R6 source (%s)", variant => {
      const { rows, expected } = sequenceInput(variant), before = persist(rows);
      let wire = toDosageDetails(rows);
      for (let save = 0; save < 2; save++) {
        const component = wire.step![0].component[0];
        expect(component).not.toHaveProperty("sequence");
        expect(component).not.toHaveProperty("_sequence");
        const reopened = persist(toFhirR5Dosages(wire)) as Array<FhirDosage & { _sequence?: FhirElement }>;
        expect(reopened[0].sequence).toBe(1);
        expect(reopened[0]._sequence).toEqual(expected);
        expect(reopened[0].doseAndRate).toEqual([{ doseQuantity: q(1) }]);
        if (expected) expect(JSON.stringify(component.extension)).toContain(expected.id);
        wire = toDosageDetails(reopened);
      }
      expect(rows).toEqual(before);
    });

  const countInput = (variant: string): FhirR6DosageInstruction => ({ step: [{
    id: "annotated-phase", ...(variant === "numeric count" ? { count: 2 } : {}),
    _count: { id: "phase-count-note",
      extension: [{ url: "urn:clinic:count-note", valueString: "retain the phase count annotation" }] },
    component: [{ doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: { ...daily, count: 1 } } }],
  }] });

  it.each(["annotation only", "numeric count"] as const)(
    "exposes the typed step count companion without inventing a value (%s)", variant => {
      const input = countInput(variant), before = persist(input), editable = fromDosageDetails(input);
      const companion: FhirR6PrimitiveElement | undefined = editable.course.step![0]._count;
      expect(companion).toEqual(input.step![0]._count);
      expect(editable.course.step![0].count).toBe(variant === "numeric count" ? 2 : undefined);
      const wire = toDosageDetails(persist(editable.dosages), undefined, persist(editable.course));
      expect(wire.step![0]._count).toEqual(input.step![0]._count);
      expect(wire.step![0].count).toBe(variant === "numeric count" ? 2 : undefined);
      expect(input).toEqual(before);
    });

  const instructionInput = (variant: string) => {
    const input: FhirR6DosageInstruction = { renderedInstruction: "Take one tablet daily",
      _renderedInstruction: { id: "original-instruction-note" },
      step: [{ component: [{ doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } }] }],
    };
    const editable = fromDosageDetails(persist(input));
    const original: FhirR6PrimitiveElement | undefined = editable.course._renderedInstruction;
    const current: EzCourseMetadata = { ...editable.course,
      renderedInstruction: variant === "replacement" ? "Current prescribed daily instruction" : input.renderedInstruction,
      _renderedInstruction: { id: "current-instruction-note",
        extension: [{ url: "urn:clinic:instruction-note", valueString: "retain current instruction metadata" }] },
    };
    return { input, editable, original, current };
  };

  it.each(["companion only", "replacement"] as const)(
    "accepts typed editable instruction primitive metadata (%s)", variant => {
      const { input, editable, original, current } = instructionInput(variant), before = persist(editable);
      expect(original).toEqual(input._renderedInstruction);
      const wire = toDosageDetails(editable.dosages, current.renderedInstruction, current);
      expect(wire.renderedInstruction).toBe(current.renderedInstruction);
      expect(wire._renderedInstruction).toEqual(current._renderedInstruction);
      expect(fromDosageDetails(persist(wire)).course._renderedInstruction).toEqual(current._renderedInstruction);
      expect(editable).toEqual(before);
    });

  const limitsInput = (variant: string) => {
    const limits: FhirR6DoseLimit[] = [
      { scope: "period", valueQuantity: q(4), period: { value: 1, unit: "d" }, text: "first authored daily maximum" },
      { scope: "period", valueQuantity: q(4), period: { value: 1, unit: "d" }, text: "second authored daily maximum" },
      { scope: "period", valueQuantity: { unit: "tab" }, period: { value: 1, unit: "wk" },
        text: "authored partial weekly maximum" },
    ];
    const rows = persist(toFhirR5Dosages(course({ timing: { repeat: daily }, safety: { doseLimit: limits } })));
    if (variant === "dose edit") rows[0].doseAndRate![0].doseQuantity!.value = 2;
    if (variant === "partial change") rows[0].maxDosePerPeriod![2].numerator!.value = 6;
    if (variant === "partial deletion") rows[0].maxDosePerPeriod!.pop();
    return { rows, limits };
  };

  it.each(["unchanged", "dose edit", "partial change", "partial deletion"] as const)(
    "keeps authored duplicate limit text only for an unchanged complete R5 projection (%s)", variant => {
      const { rows, limits } = limitsInput(variant), before = persist(rows);
      let wire = toDosageDetails(rows);
      for (let save = 0; save < 2; save++) {
        const actual = wire.step![0].component[0].safety!.doseLimit!;
        expect(actual.filter(limit => limit.period?.unit === "d").map(limit => limit.valueQuantity)).toEqual([q(4), q(4)]);
        if (variant === "unchanged" || variant === "dose edit") expect(actual).toEqual(limits);
        else {
          expect(actual.filter(limit => limit.period?.unit === "wk"))
            .toEqual(variant === "partial deletion" ? [] : [{ ...limits[2], valueQuantity: q(6) }]);
          for (const limit of limits) expect(JSON.stringify(wire)).toContain(limit.text!);
        }
        expect(wire.step![0].component[0].doseAndRate![0].doseQuantity).toEqual(q(variant === "dose edit" ? 2 : 1));
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      }
      expect(rows).toEqual(before);
    });

  it("preserves an unknown sequence companion supplied on a fresh R6 component", () => {
    const primitive = { id: "future-R6-source-field", extension: [{
      url: "urn:clinic:future-sequence-annotation", valueString: "keep the supplied unknown R6 metadata",
    }] };
    const input = persist({ step: [{ component: [{
      _sequence: primitive, doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily },
      extension: [{ url: "urn:clinic:unrelated-source", valueString: "keep the unrelated R6 field" }],
    }] }] });
    const before = persist(input);
    let wire = projectCanonicalCourse(importCanonicalCourse(input)).fhirNext;
    for (let save = 0; save < 2; save++) {
      expect(wire.step![0].component[0]).toMatchObject({ _sequence: primitive });
      expect(wire.step![0].component[0].extension).toContainEqual({
        url: "urn:clinic:unrelated-source", valueString: "keep the unrelated R6 field",
      });
      expect(wire.step![0].component[0].doseAndRate).toEqual([{ doseQuantity: q(1) }]);
      wire = projectCanonicalCourse(importCanonicalCourse(persist(wire))).fhirNext;
    }
    expect(input).toEqual(before);
  });
});


describe("round59 interop live wire ownership", () => {
  const note: FhirExtension = { url: "urn:clinic:round59-note", valueString: "keep the authored annotation" };
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] };
  const options = { orderedAt: "2026-11-22T00:00:00Z", from: "2026-11-22T00:00:00Z", timeZone: "UTC", limit: 6 };
  const allExtensions = (value: unknown): FhirExtension[] => {
    if (Array.isArray(value)) return value.reduce<FhirExtension[]>((all, item) => all.concat(allExtensions(item)), []);
    if (!value || typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    return (typeof record.url === "string" ? [value as FhirExtension] : [])
      .concat(...Object.keys(record).map(key => allExtensions(record[key])));
  };
  const sequenceInput = (sequence: number, moved: boolean): FhirR6DosageInstruction => {
    const rows: FhirDosage[] = [
      { id: "anchor", sequence, doseAndRate: [{ doseQuantity: q(1) }],
        timing: { repeat: { ...daily, boundsDuration: { value: 1, unit: "d" } } } },
      { id: "movable", sequence, _sequence: { id: "sequence-note", extension: [note] },
        doseAndRate: [{ doseQuantity: q(3) }],
        timing: { repeat: { ...daily, boundsDuration: { value: 1, unit: "d" } } }, extension: [note] },
      { id: "later", sequence: 2, doseAndRate: [{ doseQuantity: q(2) }],
        timing: { repeat: { ...daily, boundsDuration: { value: 1, unit: "d" } } } },
    ];
    const fresh = persist(toDosageDetails(rows));
    if (moved) {
      const index = fresh.step![0].component.findIndex(item => item.id === "movable");
      fresh.step![1].component.push(...fresh.step![0].component.splice(index, 1));
    }
    return fresh;
  };
  it.each([[0, false], [0, true], [-2, false], [-2, true]] as const)(
    "keeps the current phase while retaining the original R5 sequence %s (moved %s)", (sequence, moved) => {
      const input = sequenceInput(sequence, moved), before = persist(input);
      const original = { url: DOSAGE_RETAINED_R5_SEQUENCE_URL, valueDecimal: sequence,
        _valueDecimal: { id: "sequence-note", extension: [note] } };
      let wire = input;
      for (let save = 0; save < 2; save++) {
        const rows = toFhirR5Dosages(wire), current = rows.find(row => row.id === "movable")!;
        expect(current.sequence).toBe(moved ? 2 : sequence);
        expect(current.doseAndRate).toEqual([{ doseQuantity: q(3) }]);
        expect(current.extension).toContainEqual(note);
        expect(allExtensions(rows)).toContainEqual(original);
        wire = toDosageDetails(persist(rows));
        expect(wire.step![moved ? 1 : 0].component.map(item => item.id)).toContain("movable");
        expect(wire.step![moved ? 0 : 1].component.map(item => item.id)).not.toContain("movable");
        expect(nextDueDoses(wire, options)).toEqual(moved ? [
          "2026-11-22T09:00:00+00:00", "2026-11-23T09:00:00+00:00", "2026-11-23T09:00:00+00:00",
        ] : ["2026-11-22T09:00:00+00:00", "2026-11-22T09:00:00+00:00", "2026-11-23T09:00:00+00:00"]);
        expect(calculateTotalUnits({ dosage: wire, ...options,
          durationValue: 2, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(6);
      }
      expect(input).toEqual(before);
    });

  const cycleInput = (variant: string): FhirDosage[] => [{ id: "cycle-dose",
    doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily }, modifierExtension: [{
      id: "cycle-rule", url: CYCLE_DAY_ELIGIBILITY_EXTENSION_URL, extension: [
        { url: "day", valueInteger: 1 }, { url: "periodDays", valueInteger: 7 },
        { id: "source-note", url: "source", ...(variant === "authored text"
          ? { valueString: "day one of each seven-day cycle", _valueString: { extension: [note] } }
          : { extension: [note] }) },
        ...(variant === "new count" ? [{ url: "cycles", valueInteger: 3 }] : []),
      ],
    }] }];
  it.each(["annotation only", "authored text", "new count"] as const)(
    "does not turn a cycle source decoder default into authored text (%s)", variant => {
      const input = cycleInput(variant), before = persist(input), marker = input[0].modifierExtension![0];
      let rows = projectCanonicalCourse(importCanonicalCourse(input)).fhir;
      for (let save = 0; save < 2; save++) {
        expect(rows[0].modifierExtension).toContainEqual(marker);
        expect(getCycleDayConstraint(rows[0])).toMatchObject({ days: [1], periodDays: 7,
          sourceText: variant === "authored text" ? "day one of each seven-day cycle" : "" });
        expect(getCycleDayConstraint(rows[0])?.cycles).toBe(variant === "new count" ? 3 : undefined);
        rows = toFhirR5Dosages(persist(toDosageDetails(persist(rows))));
      }
      expect(input).toEqual(before);
    });
  it("writes a real cycle-source replacement and cycle count while retaining annotations", () => {
    const previous = cycleInput("annotation only")[0].modifierExtension![0], before = persist(previous);
    const source = previous.extension!.find(item => item.url === "source")!;
    const result = cycleDayConstraintExtension({ days: [1], periodDays: 7, cycles: 3,
      reason: "unresolved-cycle-eligibility", sourceText: "day one; three cycles" }, previous);
    expect(result.extension).toContainEqual({ id: "source-note", url: "source", valueString: "day one; three cycles" });
    expect(result.extension).toContainEqual({ url: "cycles", valueInteger: 3 });
    expect(result.extension).toContainEqual({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [source] });
    expect(previous).toEqual(before);
  });

  const maximumInput = (variant: string) => {
    const ratio: FhirRatio = variant === "original pending period" ? {
      id: "pending-window", numerator: q(4), denominator: { unit: "d", _value: { id: "pending-period", extension: [{
        url: "urn:clinic:period-note", valueString: "period remains unentered",
      }] } },
    } : variant === "original annotated site" ? {
      numerator: { _value: { id: "authored-maximum" } }, denominator: { value: 1, unit: "d" },
    } : { id: "partial-limit", extension: [note],
      ...(variant === "denominator only" ? {} : { numerator: { id: "amount", unit: "tab", extension: [note],
        ...(["missing amount", "both missing"].indexOf(variant) >= 0 ? {} : { value: 4 }) } }),
      ...(variant === "numerator only" ? {} : { denominator: { id: "period", unit: "d", extension: [note],
        ...(["missing period", "both missing"].indexOf(variant) >= 0 ? {} : { value: 1 }) } }),
    };
    const site: NonNullable<FhirR6Dosage["site"]> | undefined = variant === "original annotated site" ? { reference: {
      reference: "BodyStructure/right", _reference: { id: "authored-reference" },
      type: "BodyStructure", _type: { id: "authored-type" },
      display: "Right eye", _display: { id: "authored-display" },
    } } : undefined;
    const rows: FhirDosage[] = site ? persist(toFhirR5Dosages(course({ id: "partial-dose", site,
      timing: { repeat: daily }, extension: [note] }))) : [{ id: "partial-dose", doseAndRate: [{ doseQuantity: q(1) }],
      timing: { repeat: daily }, extension: [note] }];
    rows[0].maxDosePerPeriod = [ratio];
    return { ratio, rows, site };
  };
  it.each(["missing amount", "missing period", "both missing", "complete", "numerator only", "denominator only", "original pending period", "original annotated site"] as const)(
    "keeps the authored period maximum editable only when both endpoints exist (%s)", variant => {
      const { ratio, rows: input, site } = maximumInput(variant), before = persist(input);
      let wire = toDosageDetails(input);
      for (let save = 0; save < 2; save++) {
        const limits = wire.step![0].component[0].safety?.doseLimit;
        if (site) expect(wire.step![0].component[0].site).toEqual(site);
        if (!ratio.numerator || !ratio.denominator) expect(limits).toBeUndefined();
        else expect(limits).toEqual([{ id: ratio.id, ...(ratio.extension ? { extension: ratio.extension } : {}),
          scope: "period", valueQuantity: ratio.numerator, period: ratio.denominator }]);
        const rows = toFhirR5Dosages(persist(wire));
        if (!ratio.numerator || !ratio.denominator) {
          expect(rows[0].maxDosePerPeriod).toBeUndefined();
          const retained = rows[0].extension!.find(item => item.url === R5_SOURCE_ONLY_MAXIMUM_URL)!;
          expect(readRetainedField(retained)).toEqual(ratio);
        } else expect(rows[0].maxDosePerPeriod).toEqual([ratio]);
        expect(rows[0].extension).toContainEqual(note);
        expect(calculateTotalUnits({ dosage: wire, ...options,
          durationValue: 2, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(2);
        wire = toDosageDetails(persist(rows));
      }
      expect(input).toEqual(before);
    });

  const clockInput = (variant: string): FhirDosage[] => [{ id: "clock-dose",
    doseAndRate: [{ doseQuantity: q(1) }], extension: [note], timing: { repeat: {
      frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
      ...(variant === "clock metadata alone" ? {} : { when: [EventTiming["Before Breakfast"]] }),
      timeOfDay: variant === "mixed slots" ? [null, "09:00:00"] : variant === "valued clock" ? ["09:00:00"] : [null],
      _timeOfDay: [{ id: "clock-annotation", extension: [note] }],
    } } }];
  it.each(["metadata only", "mixed slots", "valued clock", "clock metadata alone"] as const)(
    "preserves positional clock annotations without core clocks beside event anchors (%s)", variant => {
      const input = clockInput(variant), before = persist(input), authored = input[0].timing!.repeat!;
      let wire = toDosageDetails(input);
      for (let save = 0; save < 2; save++) {
        const rows = toFhirR5Dosages(persist(wire)), repeat = rows[0].timing!.repeat!;
        if (variant === "clock metadata alone") {
          expect(repeat.timeOfDay).toEqual([null]);
          expect(repeat._timeOfDay).toEqual(authored._timeOfDay);
          expect(repeat.when).toBeUndefined();
        } else {
          expect(repeat.when).toEqual([EventTiming["Before Breakfast"]]);
          expect(repeat.timeOfDay).toBeUndefined();
          expect(repeat._timeOfDay).toBeUndefined();
          expect(repeat.extension!.filter(item => item.url === TIMING_ADDITIONAL_CLOCK_EXTENSION_URL))
            .toEqual(authored.timeOfDay!.map((value, index) => ({ url: TIMING_ADDITIONAL_CLOCK_EXTENSION_URL,
              ...(value ? { valueTime: value } : {}),
              ...(authored._timeOfDay?.[index] ? { _valueTime: authored._timeOfDay[index] } : {}) })));
        }
        expect(rows[0].extension).toContainEqual(note);
        wire = toDosageDetails(persist(rows));
      }
      expect(input).toEqual(before);
    });

  const exclusionInput = (clear: boolean): EzDosage[] => {
    const parsed = parseSig("1 tab daily except 2026-11-23; maximum 2 tablets per day");
    const rows: EzDosage[] = persist(toFhirR5Dosages(parsed.fhir));
    if (clear) rows[0].excludedDates = [];
    return rows;
  };
  it.each([false, true])("lets a fresh explicit exclusion clear own the saved capped preview (clear %s)", clear => {
    const input = exclusionInput(clear), before = persist(input), originalText = input[0].text;
    const maximum = persist(input[0].maxDosePerPeriod);
    expect(dosageMatchesSavedProjection(input[0])).toBe(!clear);
    expect(getDosageExcludedDates(input[0])).toEqual(clear ? [] : ["2026-11-23"]);
    for (const source of [input[0], input, toDosageDetails(persist(input))]) {
      const text = formatSig(source, "long", { locale: "en", realizationMode: "roundtrip" });
      if (clear) expect(text).not.toContain("2026-11-23");
      else expect(text).toContain("2026-11-23");
    }
    let wire = toDosageDetails(persist(input));
    for (let save = 0; save < 2; save++) {
      const rows = toFhirR5Dosages(persist(wire));
      expect(getDosageExcludedDates(rows[0])).toEqual(clear ? [] : ["2026-11-23"]);
      expect(rows[0].maxDosePerPeriod).toEqual(maximum);
      expect(JSON.stringify(wire)).toContain(originalText!);
      expect(calculateTotalUnits({ dosage: wire, ...options,
        durationValue: 2, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(clear ? 2 : 1);
      wire = toDosageDetails(persist(rows));
    }
    expect(input).toEqual(before);
  });
  it("keeps an empty exclusion field equivalent when no valued date modifier is suppressed", () => {
    const parsed = parseSig("1 tab daily; maximum 2 tablets per day");
    const unchanged = persist(toFhirR5Dosages(parsed.fhir));
    const empty: EzDosage[] = persist(unchanged);
    empty[0].excludedDates = [];
    expect(dosageMatchesSavedProjection(empty[0])).toBe(true);
    expect(formatSig(empty[0], "long", { locale: "en", realizationMode: "roundtrip" }))
      .toBe(unchanged[0].text);
  });
});


describe("round60 interoperability ownership", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] };
  const note = { url: "urn:clinic:round60-note", valueString: "Preserve the complete authored annotation" };
  const boundary = (value: number) => ({
    contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] },
    offsetDuration: { value, unit: "d" },
  });
  const originalRange = {
    id: "authored-rate-range", extension: [note],
    low: { value: 5, unit: "mL/h", extension: [{
      url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000053" },
    }] },
    high: { value: 10, unit: "mL/h", _value: { id: "authored-rate-high" } },
  };
  const retiredSources = (wire: FhirR6DosageInstruction): FhirR6Extension[] => {
    const sources: FhirR6Extension[] = [];
    for (const item of wire.extension ?? [])
      if (item.url === DOSAGE_RECONCILIATION_SOURCE_URL) sources.push(...(item.extension ?? []));
    return sources;
  };
  const retiredAmounts = (wire: FhirR6DosageInstruction) => {
    const amounts: NonNullable<FhirR6Dosage["doseAndRate"]> = [];
    for (const item of retiredSources(wire))
      if (item.url === DOSAGE_DETAILS_R5_URL) amounts.push(...(decodeR5RetainedFields(item).component?.doseAndRate ?? []));
    return amounts;
  };

  it.each(["unchanged", "replace", "remove", "remove rate entry"] as const)(
    "keeps the independent dose and complete inactive rate Range after %s", edit => {
      const source: FhirR6DosageInstruction = { step: [{ component: [{
        timing: { repeat: daily },
        doseAndRate: edit === "remove rate entry"
          ? [{ id: "dose", doseQuantity: { value: 100, unit: "mL" } },
            { id: "rate", rateRange: persist(originalRange) }]
          : [{ id: "amount", doseQuantity: { value: 100, unit: "mL" }, rateRange: persist(originalRange) }],
      }] }] };
      const sourceBefore = persist(source);
      let rows = persist(toFhirR5Dosages(source));
      if (edit === "remove rate entry") rows[0].doseAndRate = [rows[0].doseAndRate![0]];
      else if (edit !== "unchanged") {
        delete rows[0].doseAndRate![0].rateRange;
        if (edit === "replace") rows[0].doseAndRate![0].rateQuantity = { value: 8, unit: "mL/h" };
      }
      for (let save = 0; save < 2; save++) {
        const before = persist(rows), actual = toDosageDetails(rows);
        const amounts = actual.step![0].component[0].doseAndRate!;
        expect(amounts[0].doseQuantity).toEqual({ value: 100, unit: "mL" });
        if (edit === "unchanged") expect(amounts[0].rateRange).toEqual(originalRange);
        else {
          expect(amounts.some(item => item.rateRange)).toBe(false);
          expect(amounts[0].rateQuantity).toEqual(edit === "replace" ? { value: 8, unit: "mL/h" } : undefined);
          expect(retiredAmounts(actual).map(item => item.rateRange)).toContainEqual(originalRange);
        }
        expect(rows).toEqual(before);
        rows = persist(toFhirR5Dosages(actual));
      }
      expect(source).toEqual(sourceBefore);
    });

  it.each(["annotation", "dose", "timing"] as const)(
    "distinguishes an annotated empty-course carrier from an active %s row", edit => {
      const source: FhirR6DosageInstruction = {
        id: "round60-empty-course", renderedInstruction: "Clinician source-only instruction", extension: [note],
      };
      const annotation = { id: "source-sequence", extension: [note] };
      let rows = persist(toFhirR5Dosages(source));
      rows[0]._sequence = annotation;
      if (edit === "dose") rows[0].doseAndRate = [{ doseQuantity: q(1) }];
      if (edit === "timing") rows[0].timing = { repeat: daily };
      for (let save = 0; save < 2; save++) {
        const before = persist(rows), actual = toDosageDetails(rows);
        expect(actual.extension).toContainEqual(note);
        if (edit === "annotation") {
          expect(actual.step).toBeUndefined();
          expect(actual.renderedInstruction).toBe(source.renderedInstruction);
          const sources = retiredSources(actual).filter(item => item.url === "r5SourceCarrier");
          expect(sources.map(readRetainedField))
            .toContainEqual({ _sequence: annotation });
        } else {
          expect(actual.step).toHaveLength(1);
          const member = actual.step![0].component[0];
          expect(member.extension).toContainEqual({
            url: DOSAGE_RETAINED_R5_SEQUENCE_URL, ...(save ? { valueDecimal: 1 } : {}), _valueDecimal: annotation,
          });
          if (edit === "dose") expect(member.doseAndRate).toEqual([{ doseQuantity: q(1) }]);
          else expect(member.timing).toEqual({ repeat: daily });
        }
        expect(rows).toEqual(before);
        rows = persist(toFhirR5Dosages(actual));
      }
    });

  it.each(["before", "after"] as const)(
    "retains an annotated source carrier %s a separate live dose row", position => {
      const annotation = { id: "source-sequence", extension: [note, {
        url: "urn:clinic:sequence-detail", extension: [{ url: "reviewer", valueString: "prescriber" }],
      }] };
      const liveAnnotation = { id: "live-sequence", extension: [note] };
      for (const persisted of [false, true]) {
        const source: FhirR6DosageInstruction = {
          id: "mixed-empty-course", renderedInstruction: "Clinician source-only instruction", extension: [note],
        };
        const carrier: FhirDosage = { ...toFhirR5Dosages(source)[0], _sequence: annotation };
        const live: FhirDosage = {
          sequence: 1, _sequence: liveAnnotation,
          doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: daily },
        };
        let rows = position === "before" ? [carrier, live] : [live, carrier];
        if (persisted) rows = persist(rows);
        for (let save = 0; save < 2; save++) {
          const before = structuredClone(rows), actual = toDosageDetails(rows);
          for (const wire of [actual, r6Save(actual)]) {
            expect(wire.extension).toContainEqual(note);
            expect(wire.step).toHaveLength(1);
            expect(wire.step![0].component).toHaveLength(1);
            const member = wire.step![0].component[0];
            expect(member.doseAndRate).toEqual([{ doseQuantity: q(2) }]);
            expect(member.timing).toEqual({ repeat: daily });
            expect(member.extension).toContainEqual({
              url: DOSAGE_RETAINED_R5_SEQUENCE_URL, valueDecimal: 1, _valueDecimal: liveAnnotation,
            });
            expect(retiredSources(wire).filter(item => item.url === "r5SourceCarrier").map(readRetainedField))
              .toContainEqual({ _sequence: annotation });
          }
          expect(rows).toEqual(before);
          rows = persist(toFhirR5Dosages(actual));
        }
      }
    });

  it.each(["unchanged", "annotation", "phase end"] as const)(
    "keeps an implicit pause only with its unchanged member completion (%s)", edit => {
      const source: FhirR6DosageInstruction = { step: [
        { id: "induction", component: [{ id: "initial", doseAndRate: [{ doseQuantity: q(1) }],
          timing: { repeat: daily }, modifierExtension: [encodeR6SourceMetadata(
            PARALLEL_COMPONENT_PHASE_ORIGIN_URL, { end: boundary(1) }, "step")] }] },
        { id: "pause", end: boundary(2), component: [] },
        { id: "resume", component: [{ id: "later", doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: daily } }] },
      ] };
      const baseline = persist(r6Save(source));
      let wire = persist(baseline);
      if (edit === "phase end") wire.step![0].component[0].modifierExtension = [
        encodeR6SourceMetadata(PARALLEL_COMPONENT_PHASE_ORIGIN_URL, { end: boundary(2) }, "step")];
      if (edit === "annotation") wire.step![0].component[0].modifierExtension![0].id = "authored-phase";
      for (let save = 0; save < 2; save++) {
        const before = persist(wire), actual = r6Save(wire);
        expect(fromDosageDetails(actual).course.step?.map(step => step.id)).toEqual(edit === "phase end"
          ? ["induction", "resume"] : ["induction", "pause", "resume"]);
        expect(importCanonicalCourse(actual).stages[0].administrations[0].phaseEnd?.displacement?.value)
          .toBe(edit === "phase end" ? 2 : 1);
        expect(nextDueDoses(actual, { orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-01T00:00:00Z",
          timeZone: "UTC", limit: 3 })).toEqual(edit === "phase end"
          ? ["2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00", "2026-01-03T08:00:00+00:00"]
          : ["2026-01-01T08:00:00+00:00", "2026-01-03T08:00:00+00:00", "2026-01-04T08:00:00+00:00"]);
        if (edit === "phase end") {
          const retired = retiredSources(actual).find(item => item.url === R6_DRAFT_STEPS_SOURCE_URL)!;
          const savedDraft = decodeR6SourceMetadata(retired, "drafts")!;
          expect(savedDraft.drafts).toEqual([{ index: 1, step: { id: "pause", end: boundary(2) } }]);
          expect(savedDraft.synthesizedStarts).toEqual([1]);
          expect(savedDraft.projected).toEqual(baseline.step);
        }
        expect(wire).toEqual(before);
        wire = toDosageDetails(persist(toFhirR5Dosages(actual)));
      }
    });

  it.each([0, undefined, 1] as const)(
    "preserves stated frequency minimum %s beside independently authored clocks", minimum => {
      const clause = canonicalFromFhir({
        doseAndRate: [{ doseQuantity: q(1) }],
        timing: { repeat: {
          ...(minimum === 0 ? { extension: [{ url: TIMING_FREQUENCY_MIN_EXTENSION_URL, valueInteger: 0 }] }
            : minimum !== undefined ? { frequency: minimum } : {}),
          frequencyMax: 2, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00", "20:00:00"],
        } },
      });
      const before = persist(clause), row = canonicalToFhir(clause);
      expect(row.timing!.repeat!.frequency).toBe(minimum === 0 ? undefined : minimum ?? 2);
      expect(canonicalFromFhir(row).schedule?.frequency).toBe(minimum ?? 2);
      expect(row.timing!.repeat!.timeOfDay).toEqual(["08:00:00", "20:00:00"]);
      let wire = toDosageDetails(persist([row]));
      for (let save = 0; save < 2; save++) {
        const recurrence = importCanonicalCourse(wire).stages[0].administrations[0].schedule!.recurrence!;
        expect(recurrence.frequency).toBe(minimum ?? 2);
        expect(recurrence.frequencyMax).toBe(2);
        expect(recurrence.clocks).toEqual(["08:00:00", "20:00:00"]);
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      }
      expect(persist(clause)).toEqual(before);
    });

  it("keeps PRN clock opportunities optional beside an upper frequency", () => {
    const clause = canonicalFromFhir({
      asNeeded: true, doseAndRate: [{ doseQuantity: q(1) }],
      timing: { repeat: { frequencyMax: 2, period: 1, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["08:00:00", "20:00:00"] } },
    });
    const before = persist(clause), row = canonicalToFhir(clause);
    expect(row.asNeeded).toBe(true);
    expect(row.timing!.repeat!.frequency).toBeUndefined();
    expect(row.timing!.repeat!.frequencyMax).toBe(2);
    expect(row.timing!.repeat!.timeOfDay).toEqual(["08:00:00", "20:00:00"]);
    const wire = toDosageDetails(persist([row]));
    for (const input of [wire, persist(toFhirR5Dosages(wire))]) {
      const member = importCanonicalCourse(input).stages[0].administrations[0];
      expect(member.asNeeded).toBe(true);
      expect(member.schedule!.recurrence!.frequency).toBeUndefined();
      expect(member.schedule!.recurrence!.frequencyMax).toBe(2);
      expect(member.schedule!.recurrence!.clocks).toEqual(["08:00:00", "20:00:00"]);
    }
    expect(persist(clause)).toEqual(before);
  });

  it.each(["id", "translation", "dose", "dose and id"] as const)(
    "separates current narrative annotations from clinical edits (%s)", edit => {
      const wording = "Take one tablet daily";
      const translation = { url: "http://hl7.org/fhir/StructureDefinition/translation", extension: [
        { url: "lang", valueCode: "th" }, { url: "content", valueString: "รับประทานหนึ่งเม็ดทุกวัน" },
      ] };
      const source: FhirR6DosageInstruction = { renderedInstruction: wording, step: [{ component: [{
        text: wording, _text: { extension: [translation, note] },
        doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily },
      }] }] };
      let rows = persist(toFhirR5Dosages(source));
      if (edit.includes("id")) rows[0]._text!.id = "current-text-id";
      if (edit === "translation") rows[0]._text!.extension![0].extension![1].valueString = "ข้อความแปลฉบับปัจจุบัน";
      if (edit.startsWith("dose")) rows[0].doseAndRate![0].doseQuantity!.value = 2;
      const currentCompanion = persist(rows[0]._text!);
      for (let save = 0; save < 2; save++) {
        const before = persist(rows), actual = toDosageDetails(rows), member = actual.step![0].component[0];
        expect(member.doseAndRate).toEqual([{ doseQuantity: q(edit.startsWith("dose") ? 2 : 1) }]);
        if (edit.startsWith("dose")) {
          expect(member.text).toBeUndefined();
          expect(member._text).toEqual({ ...(edit.includes("id") ? { id: "current-text-id" } : {}), extension: [note] });
          const sources = retiredSources(actual).filter(item => item.url === DOSAGE_DETAILS_R5_URL);
          expect(sources.map(item => decodeR5RetainedFields(item).component))
            .toContainEqual({ text: wording, _text: currentCompanion });
        } else {
          expect(member.text).toBe(wording);
          expect(member._text).toEqual(currentCompanion);
          expect(actual.renderedInstruction).toBe(wording);
        }
        expect(rows).toEqual(before);
        rows = persist(toFhirR5Dosages(actual));
      }
    });

  it.each([false, true])("reads the saved untagged narrative fingerprint without rewriting its meaning (dose edit=%s)", changed => {
    const wording = "Take one tablet daily";
    const companion = { extension: [{
      url: "http://hl7.org/fhir/StructureDefinition/translation", extension: [
        { url: "lang", valueCode: "th" }, { url: "content", valueString: "รับประทานหนึ่งเม็ดทุกวัน" },
      ],
    }] };
    // Literal persisted output captured from accepted 0c57, before clinical-v2 agreement.
    const legacy: FhirDosage = {
      text: wording, _text: companion, doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily }, sequence: 1,
      extension: [{ url: DOSAGE_RENDERED_INSTRUCTION_R5_URL, extension: [
        { url: "instruction", valueString: wording }, { url: "sourceAgreement", valueBoolean: false },
        { url: "textFingerprint", valueString: "1dae8fd876985d78" },
        { url: "row", extension: [
          { url: "projectionFingerprint", valueString: "b6532ed6b1e44f91" },
          { url: "textFingerprint", valueString: "1dae8fd876985d78" },
        ] },
      ] }],
    };
    expect(dosageProjectionFingerprint(legacy)).toBe("b6532ed6b1e44f91");
    const submitted = persist(legacy);
    if (changed) submitted.doseAndRate![0].doseQuantity!.value = 2;
    const before = persist(submitted), actual = toDosageDetails([submitted]);
    const member = actual.step![0].component[0];
    expect(member.doseAndRate).toEqual([{ doseQuantity: q(changed ? 2 : 1) }]);
    expect(member.text).toBe(changed ? undefined : wording);
    expect(member._text).toEqual(changed ? undefined : companion);
    if (changed) expect(retiredSources(actual).filter(item => item.url === DOSAGE_DETAILS_R5_URL)
      .map(item => decodeR5RetainedFields(item).component)).toContainEqual({ text: wording, _text: companion });
    expect(submitted).toEqual(before);
  });

  it("types and preserves nested R6 extension quantities without allowing approximate R5 quantities", () => {
    const opaque: FhirR6DosageInstruction = { extension: [{ url: "urn:clinic:r6-quantity", extension: [
      { url: "duration", valueQuantity: { value: 30, unit: "min", comparator: "~", _value: { id: "duration-value" } } },
    ] }], step: [{ component: [{ doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } }] }] };
    const invalidR5: FhirExtension = {
      url: "urn:clinic:r5-quantity",
      // @ts-expect-error R5 general Quantity has no approximate comparator.
      valueQuantity: { value: 30, unit: "min", comparator: "~" },
    };
    void invalidR5;
    const before = persist(opaque), actual = r6Save(opaque);
    expect(actual.extension).toEqual(opaque.extension);
    expect(opaque).toEqual(before);
  });
});


describe("round61 supported interchange ownership", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] };
  const note = { url: "urn:clinic:round61-note", valueString: "Keep complete authored metadata" };
  const boundary = (value: number) => ({
    contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] },
    offsetDuration: { value, unit: "d" },
  });
  const retired = (wire: FhirR6DosageInstruction): FhirR6Extension[] => {
    const sources: FhirR6Extension[] = [];
    for (const marker of wire.extension ?? [])
      if (marker.url === DOSAGE_RECONCILIATION_SOURCE_URL) sources.push(...(marker.extension ?? []));
    return sources;
  };
  const qualifier = { url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
    valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000053" } };

  it.each(["scalar origin", "typed start"] as const)(
    "keeps current %s authority over a dependent pause", kind => {
      for (const edit of ["unchanged", "dose", "annotation", "origin"] as const) {
        const origin = kind === "scalar origin"
          ? { url: PARALLEL_COMPONENT_PHASE_ORIGIN_URL, valueQuantity: { value: 0, unit: "d" } }
          : encodeR6SourceMetadata(PARALLEL_COMPONENT_PHASE_ORIGIN_URL, { start: boundary(0) }, "step");
        const source: FhirR6DosageInstruction = { step: [
          { id: "induction", component: [{ id: "initial", doseAndRate: [{ doseQuantity: q(1) }],
            timing: { repeat: { ...daily, boundsDuration: { value: 1, unit: "d" } } }, modifierExtension: [origin] }] },
          { id: "pause", end: boundary(2), extension: [note], component: [] },
          { id: "maintenance", component: [{ id: "later", doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: daily } }] },
        ] };
        let wire = persist(r6Save(source));
        const originalDraft = persist(wire.extension!.find(marker => marker.url === R6_DRAFT_STEPS_SOURCE_URL)!);
        const member = wire.step![0].component[0], marker = member.modifierExtension![0];
        if (edit === "dose") member.doseAndRate![0].doseQuantity!.value = 3;
        if (edit === "annotation") marker.id = "authored-member-origin";
        if (edit === "origin") {
          if (kind === "scalar origin") marker.valueQuantity!.value = 1;
          else member.modifierExtension = [encodeR6SourceMetadata(
            PARALLEL_COMPONENT_PHASE_ORIGIN_URL, { start: boundary(1) }, "step")];
        }
        for (let save = 0; save < 2; save++) {
          const before = persist(wire), actual = r6Save(wire);
          const due = nextDueDoses(actual, { orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-01T00:00:00Z",
            timeZone: "UTC", limit: 3 });
          expect(due).toEqual(edit === "origin"
            ? ["2026-01-02T08:00:00+00:00", "2026-01-03T08:00:00+00:00", "2026-01-04T08:00:00+00:00"]
            : ["2026-01-01T08:00:00+00:00", "2026-01-03T08:00:00+00:00", "2026-01-04T08:00:00+00:00"]);
          expect(fromDosageDetails(actual).course.step?.map(step => step.id)).toEqual(edit === "origin"
            ? ["induction", "maintenance"] : ["induction", "pause", "maintenance"]);
          expect(actual.step![0].component[0].doseAndRate![0].doseQuantity).toEqual(q(edit === "dose" ? 3 : 1));
          if (edit === "origin") expect(retired(actual)).toContainEqual(originalDraft);
          else expect(fromDosageDetails(actual).course.step?.find(step => step.id === "pause")?.extension).toEqual([note]);
          expect(wire).toEqual(before);
          wire = toDosageDetails(persist(toFhirR5Dosages(actual)));
        }
      }
    });

  it.each(["unchanged", "replace", "remove"] as const)(
    "retains the qualified Ratio source after a %s edit", edit => {
      const ratio: FhirRatio = {
        id: "original-ratio", extension: [note],
        numerator: { id: "carrier", value: 100, unit: "mL", _value: { id: "authored-carrier" } },
        denominator: { id: "duration", value: 2, unit: "h", extension: [note, qualifier] },
      };
      const source: FhirR6DosageInstruction = { step: [{ component: [{
        doseAndRate: [{ id: "dose", doseQuantity: { value: 100, unit: "mL" } }, { id: "rate", rateRatio: ratio }],
      }] }] };
      let rows = persist(toFhirR5Dosages(source));
      if (edit === "replace") rows[0].doseAndRate![1] = { id: "rate", rateQuantity: { value: 8, unit: "mL/h" } };
      if (edit === "remove") rows[0].doseAndRate = [rows[0].doseAndRate![0]];
      for (let save = 0; save < 2; save++) {
        const before = persist(rows), actual = toDosageDetails(rows), amounts = actual.step![0].component[0].doseAndRate!;
        expect(amounts[0].doseQuantity).toEqual({ value: 100, unit: "mL" });
        if (edit === "unchanged") expect(amounts[1].rateRatio).toEqual(ratio);
        else {
          expect(amounts.some(amount => amount.rateRatio)).toBe(false);
          expect(amounts[1]?.rateQuantity).toEqual(edit === "replace" ? { value: 8, unit: "mL/h" } : undefined);
          const ratios: Array<NonNullable<FhirR6Dosage["doseAndRate"]>[number]["rateRatio"]> = [];
          for (const marker of retired(actual))
            if (marker.url === DOSAGE_DETAILS_R5_URL)
              for (const entry of decodeR5RetainedFields(marker).component?.doseAndRate ?? []) ratios.push(entry.rateRatio);
          expect(ratios).toContainEqual(ratio);
        }
        expect(rows).toEqual(before);
        rows = persist(toFhirR5Dosages(actual));
      }
    });

  it.each(["groupId", "branchId", "selectionBehavior"] as const)(
    "adds a valued %s without losing its annotation-only source", field => {
      const child: FhirExtension = { id: "authored-choice-field", url: field, extension: [note] };
      const original: FhirExtension = { id: "choice-source", url: DOSAGE_ALTERNATIVE_CHOICE_URL, extension: [
        field === "groupId" ? child : { url: "groupId", valueString: "regimen" },
        field === "branchId" ? child : { url: "branchId", valueString: "first" },
        field === "selectionBehavior" ? child : { url: "selectionBehavior", valueCode: "exactly-one" },
      ] };
      const row: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }], modifierExtension: [persist(original)] };
      setDosageAlternativeChoice(row, { groupId: "regimen", branchId: "second", selectionBehavior: "exactly-one" });
      const active = row.modifierExtension![0].extension!.find(item => item.url === field)!;
      expect(active.extension).toBeUndefined();
      expect(field === "selectionBehavior" ? active.valueCode : active.valueString)
        .toBe(field === "selectionBehavior" ? "exactly-one" : field === "groupId" ? "regimen" : "second");
      expect(active.id).toBe(child.id);
      expect(row.extension?.find(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL)?.extension).toContainEqual(original);
      const reopened = toDosageDetails(persist(toFhirR5Dosages([row])));
      expect(reopened.step![0].component[0].doseAndRate![0].doseQuantity).toEqual(q(1));
      expect(JSON.stringify(reopened)).toContain(note.valueString);
    });

  it.each(["local", "UCUM", "uncoded"] as const)(
    "infers a self-carrier duration only from recognized %s units", kind => {
      const ratio: FhirRatio = { numerator: { value: 100, unit: "mL" },
        denominator: { value: 2, unit: kind === "local" ? "half-hour blocks" : "h",
          ...(kind === "uncoded" ? {} : { system: kind === "local" ? "urn:clinic:time-block" : "http://unitsofmeasure.org", code: "h" }),
          extension: [note, qualifier] } };
      let wire: FhirR6DosageInstruction = { step: [{ component: [{
        doseAndRate: [{ doseQuantity: { value: 100, unit: "mL" }, rateRatio: ratio }],
      }] }] };
      for (let save = 0; save < 2; save++) {
        const before = persist(wire), native = importCanonicalCourse(wire), member = native.stages[0].administrations[0];
        expect(member.schedule?.recurrence?.occurrenceDuration).toBe(kind === "local" ? undefined : 2);
        expect(member.schedule?.recurrence?.occurrenceDurationUnit).toBe(kind === "local" ? undefined : FhirPeriodUnit.Hour);
        const actual = r6Save(wire);
        expect(actual.step![0].component[0].doseAndRate![0].rateRatio).toEqual(ratio);
        expect(actual.step![0].component[0].doseAndRate![0].doseQuantity).toEqual({ value: 100, unit: "mL" });
        expect(wire).toEqual(before);
        wire = toDosageDetails(persist(toFhirR5Dosages(actual)));
      }
    });

  it("keeps a sequence companion and lifted safety on their R5 member", () => {
    const annotation = { id: "authored-sequence", extension: [note] };
    const safety = { doseLimit: [{ scope: "administration" as const, valueQuantity: { value: 2, unit: "drop" } }] };
    const row: EzDosage = { _sequence: annotation, safety };
    const before = persist(row), native = importCanonicalCourse(row);
    expect(native.stages).toHaveLength(1);
    expect(native.stages[0].administrations).toHaveLength(1);
    expect(native.safety?.limits).toBeUndefined();
    const wire = projectCanonicalCourse(native).fhirNext;
    expect(wire.step![0].component[0].extension).toContainEqual({
      url: DOSAGE_RETAINED_R5_SEQUENCE_URL, _valueDecimal: annotation,
    });
    const reopened = toDosageDetails(persist(toFhirR5Dosages(wire)));
    expect(reopened.step![0].component[0].extension).toContainEqual({
      url: DOSAGE_RETAINED_R5_SEQUENCE_URL, valueDecimal: 1, _valueDecimal: annotation,
    });
    expect(reopened.step![0].component[0].safety).toEqual(safety);
    expect(importCanonicalCourse({ safety }).stages).toHaveLength(0);
    expect(courseFromR6({ safety }, true).stages).toHaveLength(0);
    expect(row).toEqual(before);
  });

  it.each([false, true])("preserves opaque target Coding fields with translations=%s", translated => {
    const metadata = { clinic: "eye service", flags: ["review"] };
    const target = { code: "129004000", clinicMetadata: metadata,
      ...(translated ? { i18n: { th: "ตา" } } : {}) };
    const actual = cloneBodySiteSpatialRelation({ relationText: "around", targetCoding: target })!;
    expect(actual.targetCoding).toEqual(target);
    expect(actual.targetCoding).not.toBe(target);
    expect((actual.targetCoding as typeof target).clinicMetadata).toBe(metadata);
    if (translated) expect(actual.targetCoding!.i18n).not.toBe(target.i18n);
  });

  it.each([false, true])("preserves unfamiliar site-wrapper fields with an ID=%s", identified => {
    const site = { concept: { text: "left eye" }, clinicNote: "verify at follow-up", ...(identified ? { id: "site-wrapper" } : {}) };
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }], site,
    }] }] };
    let rows = persist(toFhirR5Dosages(source));
    for (let save = 0; save < 2; save++) {
      const before = persist(rows), actual = toDosageDetails(rows);
      expect(actual.step![0].component[0].site).toEqual(site);
      expect(actual.step![0].component[0].doseAndRate![0].doseQuantity).toEqual({ value: 1, unit: "drop" });
      expect(rows).toEqual(before);
      rows = persist(toFhirR5Dosages(actual));
    }
    const plain: FhirR6DosageInstruction = { step: [{ component: [{ site: { concept: { text: "left eye" } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }] }] }] };
    expect(toFhirR5Dosages(plain)[0].modifierExtension?.some(marker => marker.url === DOSAGE_DETAILS_R5_URL) ?? false).toBe(false);
  });

  it("accepts native R6 Quantity qualifiers on component extension slots", () => {
    const extension: FhirR6Extension = { url: "urn:clinic:quantity", valueQuantity: { value: 5, unit: "mg", comparator: "~" } };
    const nativeNestedValues: FhirR6Extension[] = [
      { url: "urn:clinic:concept", valueCodeableConcept: { extension: [extension] } },
      { url: "urn:clinic:coding", valueCoding: { code: "dose", _code: { extension: [extension] } } },
      { url: "urn:clinic:range", valueRange: { low: { value: 1, extension: [extension] } } },
      { url: "urn:clinic:expression", valueExpression: { expression: "%weight", extension: [extension] } }
    ];
    void nativeNestedValues;
    const component: FhirR6Dosage = {
      extension: [extension], modifierExtension: [{ ...extension, url: "urn:clinic:modifier-quantity" }],
      doseAndRate: [{ doseQuantity: q(1) }],
    };
    // @ts-expect-error R5 Quantity does not accept the native R6 approximate comparator.
    const r5Only: FhirExtension = { url: "urn:clinic:quantity", valueQuantity: { value: 5, comparator: "~" } };
    void r5Only;
    const actual = r6Save({ step: [{ component: [component] }] });
    expect(actual.step![0].component[0].extension).toEqual(component.extension);
    expect(actual.step![0].component[0].modifierExtension).toEqual(component.modifierExtension);
    expect(actual.step![0].component[0].doseAndRate![0].doseQuantity).toEqual(q(1));
  });
});


describe("round62 reviewed interchange ownership", () => {
  const note: FhirExtension = { url: "urn:clinic:annotation", valueString: "retain-independent-note" };
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] };
  const member = (id: string, value: number) => ({ id, doseAndRate: [{ doseQuantity: q(value) }],
    timing: { repeat: { ...daily } } });

  it.each([false, true])("keeps a retained sequence companion with its original phase (moved=%s)", moved => {
    const annotation = { id: "sequence-owner", extension: [note] };
    const source: FhirDosage[] = [{ sequence: 0, _sequence: annotation, doseAndRate: [{ doseQuantity: q(1) }] }];
    const wire = persist(toDosageDetails(source));
    if (moved) wire.step!.unshift({ component: [member("new-first", 3)] });
    const before = persist(wire);
    let rows = persist(toFhirR5Dosages(wire));
    for (let save = 0; save < 2; save++) {
      const row = rows.find(item => item.doseAndRate?.[0].doseQuantity?.value === 1)!;
      expect(row.sequence).toBe(moved ? 2 : 0);
      expect(row._sequence).toEqual(moved ? undefined : annotation);
      const retained = { url: DOSAGE_RETAINED_R5_SEQUENCE_URL, valueDecimal: 0, _valueDecimal: annotation };
      if (moved && save > 0) {
        expect(row.extension!.find(item => item.url === DOSAGE_RETAINED_R5_SEQUENCE_URL)).toBeUndefined();
        expect(row.extension!.find(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL)!.extension).toContainEqual(retained);
      } else expect(row.extension!.find(item => item.url === DOSAGE_RETAINED_R5_SEQUENCE_URL)).toEqual(retained);
      expect(row.doseAndRate).toEqual([{ doseQuantity: q(1) }]);
      rows = persist(toFhirR5Dosages(toDosageDetails(rows)));
    }
    expect(wire).toEqual(before);
    expect(source[0]._sequence).toEqual(annotation);
  });

  it.each([
    { text: "left ear canal", code: "89644007", expected: "left ear canal" },
    { text: "right ear canal", code: "25577004", expected: "right ear canal" },
    { text: "left ear canal", code: "25577004", expected: "right ear" },
  ])("keeps compatible authored canal detail for $text and code $code", ({ text, code, expected }) => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 2, unit: "drop" } }],
      site: { text, _text: { id: "site-label", extension: [note] },
        coding: [{ system: "http://snomed.info/sct", code, _code: { extension: [note] } }] } };
    const before = persist(row);
    for (const input of [row, persist(row), persist(toDosageDetails([row]))]) {
      expect(formatSig(input, "short", { locale: "en" })).toBe("2 drop in the " + expected);
      expect(formatSig(input, "long", { locale: "en" })).toBe("Use 2 drops in the " + expected + ".");
    }
    const saved = toFhirR5Dosages(persist(toDosageDetails([row])))[0];
    expect(saved.site).toEqual(before.site);
    expect(saved.doseAndRate).toEqual(before.doseAndRate);
    expect(row).toEqual(before);
  });

  it.each(["fresh", "persisted"] as const)("checks detached clocked source replay through %s rows and saves", kind => {
    const parsed = parseSig("Swallow 1 tablet slowly with water at 08:00 and swallow 2 tablets slowly with water at 20:00");
    expect(parsed.fhir).toHaveLength(2);
    const row = kind === "fresh" ? structuredClone(parsed.fhir[1]) : persist(parsed.fhir[1]);
    const original = persist(row);
    const options = { locale: "en", realizationMode: "roundtrip" as const };
    expect(dosageMatchesSavedProjection(row)).toBe(true);
    expect(formatSig(row, "long", options)).toBe("swallow 2 tablets slowly with water at 20:00");
    const unchangedSaved = persist(toFhirR5Dosages([row]))[0];
    expect(formatSig(unchangedSaved, "long", options)).toBe("swallow 2 tablets slowly with water at 20:00");
    let current = persist(row);
    current.timing!.repeat!.timeOfDay = ["22:00:00"];
    for (let save = 0; save < 2; save++) {
      const before = persist(current);
      expect(dosageMatchesSavedProjection(current)).toBe(false);
      if (save > 0) expect(getDosageSourceTextAgreement(current, false)).toBe(false);
      for (const locale of ["en", "th"] as const) {
        const localized = { ...options, locale };
        const imported = fromFhirDosage(current, localized);
        for (const preview of [formatSig(current, "long", localized), imported.longText]) {
          expect(preview.match(locale === "en" ? /\b2 tablets\b/gu : /\b2 เม็ด/gu)).toHaveLength(1);
          if (locale === "th") expect(preview).not.toContain("tablets");
          expect(preview).toMatch(/22:00|10:00 pm/u);
          expect(preview).not.toMatch(/20:00|8:00 pm/u);
          expect(preview).toContain("slowly");
          expect(preview).toContain(locale === "en" ? "water" : "น้ำ");
        }
        expect(imported.fhir).toEqual(before);
      }
      expect(current.timing!.repeat!.timeOfDay).toEqual(["22:00:00"]);
      expect(current.doseAndRate![0].doseQuantity!.value).toBe(2);
      expect(current).toEqual(before);
      expect(JSON.stringify(current)).toContain("swallow 2 tablets slowly with water at 20:00");
      current = persist(toFhirR5Dosages([current]))[0];
    }
    expect(row).toEqual(original);
  });

  // Complete detached second row exported by parseSig at 3699b99, before
  // clocked rows carried their own clinical projection fingerprint.
  const historicalClockRow: FhirDosage = {
    "extension": [
      {
        "url": "urn:ezmedicationinput:StructureDefinition:medication-instruction-graph",
        "extension": [
          {"url": "sourceText", "valueString": "swallow 2 tablets slowly with water at 20:00"},
          {"url": "sourceLocale", "valueCode": "en"},
          {"url": "primaryAdministrationStart", "valueInteger": 0},
          {"url": "primaryAdministrationEnd", "valueInteger": 7},
          {
            "url": "action",
            "extension": [
              {"url": "sequenceIndex", "valueInteger": 0},
              {"url": "force", "valueCode": "sequence"},
              {
                "url": "relationCoding",
                "valueCoding": {"system": "http://snomed.info/sct", "code": "421463005", "display": "With - dosing instruction fragment"}
              },
              {"url": "predicateLemma", "valueString": "swallow"},
              {"url": "predicateDisplay", "valueString": "Swallow"},
              {"url": "semanticClass", "valueString": "ingest"},
              {
                "url": "predicateTranslation",
                "extension": [{"url": "locale", "valueCode": "th"}, {"url": "text", "valueString": "กลืน"}]
              },
              {
                "url": "predicateCoding",
                "valueCoding": {"system": "http://snomed.info/sct", "code": "738995006", "display": "Swallow"}
              },
              {
                "url": "predicateCoding",
                "valueCoding": {
                  "system": "http://snomed.info/sct",
                  "code": "421521009",
                  "display": "Swallow - dosing instruction imperative"
                }
              },
              {"url": "spanStart", "valueInteger": 0},
              {"url": "spanEnd", "valueInteger": 44},
              {"url": "sourceText", "valueString": "swallow 2 tablets slowly with water at 20:00"},
              {
                "url": "argument",
                "extension": [
                  {"url": "role", "valueCode": "object"},
                  {"url": "text", "valueString": "2 tablets slowly"},
                  {"url": "normalized", "valueString": "2 tablets slowly"}
                ]
              },
              {
                "url": "argument",
                "extension": [
                  {"url": "role", "valueCode": "substance"},
                  {
                    "url": "relationCoding",
                    "valueCoding": {"system": "http://snomed.info/sct", "code": "421463005", "display": "With - dosing instruction fragment"}
                  },
                  {"url": "text", "valueString": "water"},
                  {"url": "normalized", "valueString": "water"},
                  {"url": "conceptId", "valueString": "water"},
                  {
                    "url": "coding",
                    "valueCoding": {"system": "http://snomed.info/sct", "code": "11713004", "display": "Water"}
                  },
                  {
                    "url": "argumentCoding",
                    "valueCoding": {"system": "http://snomed.info/sct", "code": "11713004", "display": "Water"}
                  },
                  {
                    "url": "translation",
                    "extension": [{"url": "locale", "valueCode": "en"}, {"url": "text", "valueString": "water"}]
                  },
                  {
                    "url": "translation",
                    "extension": [{"url": "locale", "valueCode": "th"}, {"url": "text", "valueString": "น้ำ"}]
                  }
                ]
              },
              {
                "url": "argument",
                "extension": [
                  {"url": "role", "valueCode": "time"},
                  {
                    "url": "relationCoding",
                    "valueCoding": {"system": "http://snomed.info/sct", "code": "420862001", "display": "On"}
                  },
                  {"url": "text", "valueString": "20:00"},
                  {"url": "normalized", "valueString": "20:00:00"},
                  {"url": "spanStart", "valueInteger": 39},
                  {"url": "spanEnd", "valueInteger": 44}
                ]
              },
              {
                "url": "argument",
                "extension": [
                  {"url": "role", "valueCode": "amount"},
                  {"url": "text", "valueString": "2 tablets"},
                  {"url": "normalized", "valueString": "tab"},
                  {"url": "spanStart", "valueInteger": 8},
                  {"url": "spanEnd", "valueInteger": 17},
                  {
                    "url": "quantity",
                    "extension": [{"url": "value", "valueDecimal": 2}, {"url": "unit", "valueString": "tab"}]
                  }
                ]
              }
            ]
          },
          {
            "url": "coverage",
            "extension": [
              {"url": "understoodCharacters", "valueInteger": 44},
              {"url": "opaqueCharacters", "valueInteger": 0},
              {"url": "ratio", "valueDecimal": 1},
              {"url": "complete", "valueBoolean": true}
            ]
          }
        ]
      },
      {
        "url": "urn:ezmedicationinput:StructureDefinition:medication-rendered-instruction",
        "extension": [
          {"url": "sourceAgreement", "valueBoolean": true},
          {"url": "textFingerprint", "valueString": "2c1b7585d11b2d37"},
          {"url": "sourceHasStructuredClocks", "valueBoolean": true},
          {"url": "sourceHasStructuredEvents", "valueBoolean": false},
          {"url": "sourceHasStructuredSite", "valueBoolean": false}
        ]
      }
    ],
    "route": {"text": "by mouth", "coding": [{"system": "http://snomed.info/sct", "code": "26643006", "display": "Oral route"}]},
    "method": {
      "text": "Swallow",
      "_text": {
        "extension": [
          {
            "url": "http://hl7.org/fhir/StructureDefinition/translation",
            "extension": [{"url": "lang", "valueCode": "th"}, {"url": "content", "valueString": "กลืน"}]
          }
        ]
      },
      "coding": [
        {
          "system": "http://snomed.info/sct",
          "code": "738995006",
          "display": "Swallow",
          "_display": {
            "extension": [
              {
                "url": "http://hl7.org/fhir/StructureDefinition/translation",
                "extension": [{"url": "lang", "valueCode": "th"}, {"url": "content", "valueString": "รับประทาน"}]
              }
            ]
          }
        }
      ]
    },
    "timing": {"repeat": {"timeOfDay": ["20:00:00"]}},
    "doseAndRate": [{"doseQuantity": {"value": 2, "unit": "tab", "system": "http://standardterms.edqm.eu", "code": "15054000"}}],
    "text": "Swallow 2 tablets slowly on 20:00:00 with water at 8:00 pm."
  };

  it.each(["20:00:00", "22:00:00"])("uses current %s clocks from a historical detached R5 row", clock => {
    const submitted = persist(historicalClockRow);
    const clockAnnotation = { id: "current-clock", extension: [{ url: "https://example.test/clock-note", valueString: "retain clock note" }] };
    const rowAnnotation = { url: "https://example.test/row-note", valueString: "retain row note" };
    submitted.timing!.repeat!.timeOfDay = [clock];
    submitted.timing!.repeat!._timeOfDay = [clockAnnotation];
    submitted.extension!.push(rowAnnotation);
    const original = persist(submitted);
    const originalGraph = original.extension![0];
    const expectedClock = clock === "20:00:00" ? /20:00|8:00 pm/u : /22:00|10:00 pm/u;
    const otherClock = clock === "20:00:00" ? /22:00|10:00 pm/u : /20:00|8:00 pm/u;
    let current = submitted;
    for (let save = 0; save < 3; save++) {
      const before = persist(current);
      expect(dosageMatchesSavedProjection(current)).toBe(false);
      if (save > 0) expect(getDosageSourceTextAgreement(current, false)).toBe(false);
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        const options = { locale: "en", realizationMode };
        const imported = fromFhirDosage(current, options);
        for (const preview of [formatSig(current, "long", options), imported.longText]) {
          const active = preview.split("; original directions:")[0];
          expect(active).toMatch(/\b2 tablets\b/u);
          expect(active).toMatch(expectedClock);
          expect(active).not.toMatch(otherClock);
          expect(active).toContain("slowly");
          expect(active).toContain("water");
        }
        expect(imported.fhir).toEqual(before);
      }
      expect(current.timing!.repeat!.timeOfDay).toEqual([clock]);
      expect(current.timing!.repeat!._timeOfDay).toEqual([clockAnnotation]);
      expect(current.doseAndRate).toEqual([{
        doseQuantity: { value: 2, unit: "tab", system: "http://standardterms.edqm.eu", code: "15054000" }
      }]);
      expect(current.extension).toContainEqual(originalGraph);
      expect(current.extension).toContainEqual(rowAnnotation);
      expect(current).toEqual(before);
      current = save === 0
        ? persist(toFhirR5Dosages([current]))[0]
        : persist(toFhirR5Dosages(persist(toDosageDetails([current]))))[0];
    }
    expect(submitted).toEqual(original);
  });

  it("keeps an independent numeric member origin after its predecessor is removed", () => {
    const source: FhirR6DosageInstruction = { step: [
      { id: "loading", component: [{ ...member("first", 1), timing: { repeat: { ...daily, count: 1 } } }] },
      { id: "independent", component: [{ ...member("later", 2), timing: { repeat: { ...daily, count: 2 } },
        modifierExtension: [{ url: PARALLEL_COMPONENT_PHASE_ORIGIN_URL, valueQuantity: { value: 7, unit: "d" } }] }] }
    ] };
    let rows = persist(toFhirR5Dosages(source).slice(1));
    const options = { orderedAt: "2026-11-21T00:00:00Z", from: "2026-11-21T00:00:00Z", timeZone: "UTC", limit: 3 };
    for (let save = 0; save < 2; save++) {
      const before = persist(rows), native = importCanonicalCourse(rows);
      expect(native.contextIssue).toBeUndefined();
      const active = native.stages.map(stage => stage.administrations).reduce((all, rows) => all.concat(rows), []);
      expect(active).toHaveLength(1);
      expect(active[0].phaseOrigin).toEqual({ value: 7, unit: "d" });
      expect(active[0].amounts![0].quantity).toEqual(q(2));
      expect(nextDueDoses(rows, options)).toEqual(["2026-11-28T08:00:00+00:00", "2026-11-29T08:00:00+00:00"]);
      expect(calculateTotalUnits({ ...options, dosage: rows, durationValue: 14,
        durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(4);
      expect(rows).toEqual(before);
      rows = persist(toFhirR5Dosages(toDosageDetails(rows)));
    }
  });

  it("starts an independent zero-origin member after an empty retained predecessor", () => {
    const source: FhirR6DosageInstruction = { step: [
      { id: "loading", component: [{ ...member("first", 1), timing: { repeat: { ...daily, count: 1 } } }] },
      { id: "independent", component: [{ ...member("later", 2), timing: { repeat: { ...daily, count: 2 } },
        modifierExtension: [{ url: PARALLEL_COMPONENT_PHASE_ORIGIN_URL, valueQuantity: { value: 0, unit: "d" } }] }] }
    ] };
    let rows = persist(toFhirR5Dosages(source).slice(1));
    const options = { orderedAt: "2026-11-21T00:00:00Z", from: "2026-11-21T00:00:00Z", timeZone: "UTC", limit: 3 };
    for (let save = 0; save < 2; save++) {
      const native = importCanonicalCourse(rows);
      expect(native.contextIssue).toBeUndefined();
      expect(native.stages.map(stage => stage.administrations.length)).toEqual([0, 1]);
      expect(native.stages[1].administrations[0].phaseOrigin).toEqual({ value: 0, unit: "d" });
      expect(native.stages[1].administrations[0].amounts![0].quantity).toEqual(q(2));
      for (const input of [native, rows, persist(toDosageDetails(rows))]) {
        const before = persist(input);
        expect(nextDueDoses(input, options)).toEqual(["2026-11-21T08:00:00+00:00", "2026-11-22T08:00:00+00:00"]);
        expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 14,
          durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(4);
        expect(input).toEqual(before);
      }
      rows = persist(toFhirR5Dosages(toDosageDetails(rows)));
    }
  });

  it.each([0, 7])("executes an independent %sd origin after two retained empty stages", offset => {
    const independent = { ...member("independent-member", 2), timing: { repeat: { ...daily, count: 2 } },
      extension: [note],
      modifierExtension: [{ url: PARALLEL_COMPONENT_PHASE_ORIGIN_URL, valueQuantity: { value: offset, unit: "d" } }] };
    const source: FhirR6DosageInstruction = { step: [
      { id: "previous-first", component: [{ ...member("previous-first-member", 1), timing: { repeat: { ...daily, count: 1 } } }] },
      { id: "previous-second", component: [{ ...member("previous-second-member", 1), timing: { repeat: { ...daily, count: 1 } } }] },
      { id: "independent", component: [independent] }
    ] };
    let rows = persist(toFhirR5Dosages(source).slice(2));
    const options = { orderedAt: "2026-11-21T00:00:00Z", from: "2026-11-21T00:00:00Z", timeZone: "UTC", limit: 3 };
    const expected = offset === 0
      ? ["2026-11-21T08:00:00+00:00", "2026-11-22T08:00:00+00:00"]
      : ["2026-11-28T08:00:00+00:00", "2026-11-29T08:00:00+00:00"];
    for (let save = 0; save < 2; save++) {
      const native = importCanonicalCourse(rows);
      expect(native.contextIssue).toBeUndefined();
      expect(native.stages.map(stage => stage.administrations.length)).toEqual([0, 0, 1]);
      expect(rows[0].extension).toContainEqual(note);
      expect(native.stages[2].administrations[0].phaseOrigin).toEqual({ value: offset, unit: "d" });
      expect(native.stages[2].administrations[0].amounts![0].quantity).toEqual(q(2));
      for (const input of [native, rows, persist(toDosageDetails(rows)), [persist(independent)]]) {
        const before = persist(input);
        expect(nextDueDoses(input, options)).toEqual(expected);
        expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 14,
          durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(4);
        expect(input).toEqual(before);
      }
      rows = persist(toFhirR5Dosages(toDosageDetails(rows)));
    }
  });

  it("accepts native Ratio and Timing values in R6 extensions while R5 remains strict", () => {
    const ratio: FhirR6Extension = { url: "urn:clinic:ratio",
      valueRatio: { numerator: { value: 2, unit: "mg", comparator: "~" }, denominator: { value: 1, unit: "mL" } } };
    const timing: FhirR6Extension = { url: "urn:clinic:timing",
      valueTiming: { repeat: { ...daily, startOffset: { value: 2, unit: "h" }, endOffset: { value: 4, unit: "h" } } } };
    // @ts-expect-error R5 Extension Ratio numerator does not accept the R6 approximate comparator.
    const strictRatio: FhirExtension = { url: "urn:clinic:ratio", valueRatio: { numerator: { value: 2, comparator: "~" } } };
    // @ts-expect-error R5 Timing repeat does not expose native R6 period offsets.
    const strictTiming: FhirExtension = { url: "urn:clinic:timing", valueTiming: { repeat: { startOffset: { value: 2, unit: "h" } } } };
    void strictRatio; void strictTiming;
    const nativeSite: FhirR6Dosage = { site: { extension: [{ url: "urn:clinic:site-quantity", valueQuantity: { value: 2, comparator: "~" } }] } };
    // @ts-expect-error R5 site extensions retain strict R5 Quantity comparators.
    const strictSite: FhirDosage = { site: { extension: [{ url: "urn:clinic:site-quantity", valueQuantity: { value: 2, comparator: "~" } }] } };
    void nativeSite; void strictSite;
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: q(1) }], extension: [ratio, timing]
    }] }] };
    const before = persist(source), actual = projectCanonicalCourse(importCanonicalCourse(source)).fhirNext;
    expect(actual.step![0].component[0].extension).toEqual([ratio, timing]);
    expect(actual.step![0].component[0].doseAndRate).toEqual([{ doseQuantity: q(1) }]);
    expect(source).toEqual(before);
  });

  it.each(["~", undefined] as const)("projects a native concentration annotation with comparator %s to strict R5", comparator => {
    const annotation: FhirR6Extension = { id: "concentration-annotation", url: "urn:clinic:concentration", valueRatio: {
      id: "concentration", extension: [{ url: "urn:clinic:ratio-note", valueString: "authored concentration" }],
      numerator: { id: "concentration-mass", value: 2, unit: "mg", ...(comparator ? { comparator } : {}) },
      denominator: { id: "concentration-volume", value: 1, unit: "mL" },
    } };
    const source: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: [{
      doseQuantity: { value: 1, unit: "mL", extension: [annotation] },
    }] }] }] };
    const before = persist(source), rows = toFhirR5Dosages(source);
    const projected = rows[0].doseAndRate![0].doseQuantity!.extension!.find(item => item.url === annotation.url)!;
    expect(projected.id).toBe(annotation.id);
    expect(projected.valueRatio).toMatchObject({ id: "concentration", extension: annotation.valueRatio!.extension,
      numerator: { id: "concentration-mass", value: 2, unit: "mg" }, denominator: annotation.valueRatio!.denominator });
    expect(projected.valueRatio!.numerator!.comparator).toBeUndefined();
    expect(getQuantityComparator(projected.valueRatio!.numerator)).toBe(comparator);
    if (!comparator) expect(projected).toEqual(annotation);
    expect(toDosageDetails(rows).step![0].component[0].doseAndRate![0].doseQuantity!.extension).toEqual([annotation]);
    expect(source).toEqual(before);
  });

  const quantityNode = (graph: FhirExtension): FhirExtension => {
    for (const action of graph.extension ?? [])
      for (const argument of action.extension ?? []) {
        const quantity = argument.url === "argument" && argument.extension?.find(field => field.url === "quantity");
        if (quantity) return quantity;
      }
    throw new Error("Complete measurement graph has no quantity");
  };

  it.each(["value", "low", "high", "unit"] as const)("retains recognized graph quantity %s annotations beside the current value", field => {
    const graph = parseSig("Measure 100 mL of water").meta.canonical.clauses[0].instructionGraph!;
    const wire = buildInstructionGraphExtension(graph)!;
    const amount = quantityNode(wire);
    if (field === "low" || field === "high") {
      amount.extension = amount.extension!.filter(child => child.url !== "value");
      amount.extension.unshift({ url: "low", valueDecimal: 100 }, { url: "high", valueDecimal: 200 });
    }
    const child = amount.extension!.find(part => part.url === field)!;
    const metadata = { id: field + "-primitive", extension: [note] };
    child.id = field + "-owner";
    Object.assign(child, field === "unit" ? { _valueString: metadata } : { _valueDecimal: metadata });
    amount.extension!.push({ url: "urn:clinic:quantity-note", valueString: "retain-quantity-note" });
    const before = persist(wire), parsed = parseInstructionGraphExtension([wire])!;
    const rebuilt = buildInstructionGraphExtension(parsed)!;
    expect(quantityNode(rebuilt).extension).toContainEqual(child);
    expect(quantityNode(rebuilt).extension).toContainEqual({ url: "urn:clinic:quantity-note", valueString: "retain-quantity-note" });
    const edited = structuredClone(parsed);
    const quantity = edited.actions.map(action => action.args).reduce((all, args) => all.concat(args), [])
      .find(argument => argument.quantity)!.quantity!;
    if (field === "value") quantity.value = 200;
    if (field === "low") quantity.range!.low = 150;
    if (field === "high") quantity.range!.high = 300;
    if (field === "unit") { quantity.value = 0.1; quantity.unit = "L"; }
    const current = buildInstructionGraphExtension(edited)!;
    const expected = { ...child, ...(field === "unit" ? { valueString: "L" }
      : { valueDecimal: field === "value" ? 200 : field === "low" ? 150 : 300 }) };
    expect(quantityNode(current).extension).toContainEqual(expected);
    const reopened = parseInstructionGraphExtension([current])!;
    const actual = reopened.actions.map(action => action.args).reduce((all, args) => all.concat(args), [])
      .find(argument => argument.quantity)!.quantity!;
    if (field === "value") expect(actual.value).toBe(200);
    if (field === "low") expect(actual.range).toEqual({ low: 150, high: 200 });
    if (field === "high") expect(actual.range).toEqual({ low: 100, high: 300 });
    if (field === "unit") expect(actual).toMatchObject({ value: 0.1, unit: "L" });
    expect(wire).toEqual(before);
  });
});


describe("round64 preserved R5 list and replacement ownership", () => {
  it("does not revive an expression-only dose after the saved slot is replaced by a rate", () => {
    const source = course({ doseAndRate: [{ doseExpression: expression("authoredDose") }] });
    const rows = persist(toFhirR5Dosages(source));
    expect(rows[0].doseAndRate![0].extension?.some(item => item.url === R5_EXPRESSION_SLOT_SOURCE_URL)).toBe(true);
    expect(toDosageDetails(rows).step![0].component[0].doseAndRate![0].doseExpression).toEqual(expression("authoredDose"));
    const replacement: FhirDosage = { ...rows[0], doseAndRate: [{ rateQuantity: { value: 5, unit: "mL/h" } }] };
    const reopened = toDosageDetails([replacement]);
    expect(reopened.step![0].component[0].doseAndRate![0].doseExpression).toBeUndefined();
    expect(reopened.step![0].component[0].doseAndRate![0].rateQuantity).toEqual({ value: 5, unit: "mL/h" });
    expect(JSON.stringify(reopened)).toContain("%authoredDose");
    const withRate = persist(toFhirR5Dosages(course({ doseAndRate: [{
      doseExpression: expression("independentDose"), rateQuantity: { value: 5, unit: "mL/h" }
    }] })));
    const changedRate: FhirDosage = { ...withRate[0], doseAndRate: [{ ...withRate[0].doseAndRate![0], rateQuantity: { value: 7, unit: "mL/h" } }] };
    expect(toDosageDetails([changedRate]).step![0].component[0].doseAndRate![0].doseExpression).toEqual(expression("independentDose"));
  });

  it("keeps annotation-only period maxima in their authored array positions", () => {
    const first = { id: "first", numerator: q(4), denominator: { value: 1, unit: "d" } };
    const note = { id: "annotation-only", extension: [{ url: "urn:example:maximum-note", valueString: "source only" }] };
    const last = { id: "last", numerator: q(2), denominator: { value: 8, unit: "h" } };
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }], maxDosePerPeriod: [first, note, last] };
    const reopened = toDosageDetails(persist([row]));
    expect(toFhirR5Dosages(reopened)[0].maxDosePerPeriod).toEqual([first, note, last]);
  });

  it.each([false, true])("keeps an unchanged step modifier wrapper before unrelated extensions (annotated %s)", annotated => {
    const wrapper = { ...(annotated ? { id: "authored-wrapper" } : {}), url: "urn:ezmedicationinput:StructureDefinition:r5-step-modifier-extensions",
      extension: [{ url: "urn:example:step-modifier", valueString: "retain" }] };
    const unrelated = { url: "urn:example:step-note", valueString: "after wrapper" };
    const source: FhirR6DosageInstruction = { step: [{ extension: [wrapper, unrelated], component: [{ doseAndRate: [{ doseQuantity: q(1) }] }] }] };
    const reopened = toDosageDetails(persist(toFhirR5Dosages(source)));
    expect(reopened.step![0].extension).toEqual([wrapper, unrelated]);
  });
});


describe("round66 interchange review corrections", () => {
  const contextCode = { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] };
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] };

  it.each([false, true])("retains current source-carrier text beside a live dose (annotated=%s)", annotated => {
    const source: FhirR6DosageInstruction = { renderedInstruction: "Call clinic for dose" };
    const carrier = persist(toFhirR5Dosages(source)[0]);
    carrier.text = "Confirm dose with clinic before use";
    if (annotated) carrier._text = { id: "current-source-text" };
    let rows: FhirDosage[] = [carrier, { doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: daily } }];
    for (let save = 0; save < 2; save++) {
      const before = persist(rows), wire = toDosageDetails(rows);
      expect(wire.step).toHaveLength(1);
      expect(wire.step![0].component).toHaveLength(1);
      expect(wire.step![0].component[0].doseAndRate).toEqual([{ doseQuantity: q(2) }]);
      expect(wire.step![0].component[0].text).toBeUndefined();
      const sources: unknown[] = [];
      for (const marker of wire.extension ?? []) if (marker.url === DOSAGE_RECONCILIATION_SOURCE_URL)
        for (const item of marker.extension ?? []) if (item.url === "r5SourceCarrier") sources.push(readRetainedField(item));
      expect(sources).toContainEqual({ text: carrier.text, ...(annotated ? { _text: carrier._text } : {}) });
      expect(rows).toEqual(before);
      rows = persist(toFhirR5Dosages(wire));
    }
  });

  it.each(["condition", "annotation"] as const)("retires only a completion-changing condition's outgoing pause (%s)", edit => {
    const source: FhirR6DosageInstruction = { step: [
      { id: "induction", component: [{ id: "initial", doseAndRate: [{ doseQuantity: q(1) }],
        timing: { repeat: { ...daily, count: 2 } }, condition: [conditionToR6({ kind: "measurement",
          name: "glucose", operation: "gt", value: 85, unit: "mg/dL", text: "Glucose above threshold" })] }] },
      { id: "pause", end: { contextCode, offsetDuration: { value: 2, unit: "d" } }, component: [] },
      { id: "maintenance", start: { contextCode, offsetDuration: { value: 3, unit: "d" } }, component: [{
        id: "later", doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: daily } }] },
    ] };
    let wire = persist(r6Save(source));
    const condition = wire.step![0].component[0].condition![0];
    if (edit === "condition") condition.valueQuantity!.value = 95;
    else condition.extension = [{ url: "urn:clinic:condition-note", valueString: "reviewed" }];
    for (let save = 0; save < 2; save++) {
      const before = persist(wire);
      expect(fromDosageDetails(wire).course.step?.map(step => step.id)).toEqual(edit === "condition"
        ? ["induction", "maintenance"] : ["induction", "pause", "maintenance"]);
      expect(nextDueDoses(wire, { orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-01T00:00:00Z",
        timeZone: "UTC", limit: 4, evaluateCondition: (condition, at) => condition.kind !== "measurement" ||
          (at.startsWith("2026-01-02") ? 90 : 100) > condition.value })).toEqual([
        "2026-01-01T09:00:00+00:00", edit === "condition" ? "2026-01-03T09:00:00+00:00" : "2026-01-02T09:00:00+00:00",
        "2026-01-04T09:00:00+00:00", "2026-01-05T09:00:00+00:00",
      ]);
      expect(wire).toEqual(before);
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
    }
  });

  it.each(["left nostril", "left naris", "right nostril", "right naris"])(
    "keeps authored %s specificity with a generic Naris code", text => {
      const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "spray" } }],
        site: { text, coding: [{ system: "http://snomed.info/sct", code: "1797002", display: "Naris" }] } };
      const before = persist(row);
      for (const input of [row, toDosageDetails([row])]) expect(formatSig(input, "long")).toContain(text);
      expect(row).toEqual(before);
      const changed = persist(row);
      changed.site!.coding![0] = { system: "http://snomed.info/sct", code: "723609004", display: "Structure of right anterior naris" };
      expect(formatSig(changed, "long")).toContain("right");
      expect(changed.site!.text).toBe(text);
    });

  it("accepts native approximate Quantity extensions on R6 dosage conditions", () => {
    const extension: FhirR6Extension = { url: "urn:clinic:threshold", valueQuantity: { value: 90, comparator: "~", unit: "mg/dL" } };
    const condition: FhirR6DosageCondition = { code: { text: "glucose" }, extension: [extension],
      valueQuantity: { value: 90, comparator: "~", unit: "mg/dL" } };
    // @ts-expect-error R5 Element extensions retain strict R5 Quantity comparators.
    const strict: FhirElement = { extension: [{ url: "urn:clinic:threshold", valueQuantity: { value: 90, comparator: "~" } }] };
    void strict;
    const source = course({ condition: [condition] });
    expect(r6Save(source).step![0].component[0].condition).toEqual([condition]);
    expect(toDosageDetails(persist(toFhirR5Dosages(source))).step![0].component[0].condition).toEqual([condition]);
  });

  it("retains complete spatial target Coding through the public parse-clone-build path", () => {
    const url = "urn:ezmedicationinput:body-site-spatial-relation";
    const target = { id: "authored-knee", system: "http://snomed.info/sct", code: "82169009", display: "Left knee",
      version: "20260131", _display: { extension: [{ url: "urn:clinic:display-note", valueString: "retain" }] },
      extension: [{ url: "urn:clinic:coding-note", valueBoolean: true }], clinicMetadata: { service: "wound care" } };
    const source: FhirExtension = { url, extension: [
      { url: "relationText", valueString: "below" },
      { url: "target", valueCodeableConcept: { text: "left knee", coding: [target] } },
    ] };
    const before = persist(source);
    const parsed = parseBodySiteSpatialRelationExtension({ extension: [source] })!;
    expect(parsed.targetCoding).toEqual(target);
    const cloned = cloneBodySiteSpatialRelation(parsed)!;
    expect(buildBodySiteSpatialRelationExtension(cloned)).toEqual(source);
    expect(buildBodySiteSpatialRelationExtension({ relationText: "below", targetText: "left knee", targetCoding: target })).toEqual(source);
    const { system: _system, ...unqualified } = target;
    expect(buildBodySiteSpatialRelationExtension({ relationText: "below", targetCoding: unqualified })!.extension![1]
      .valueCodeableConcept!.coding).toEqual([target]);
    expect(buildBodySiteSpatialRelationExtension({ relationText: "below", targetCoding: { code: "82169009" } })!.extension![1]
      .valueCodeableConcept!.coding).toEqual([{ system: "http://snomed.info/sct", code: "82169009" }]);
    expect(source).toEqual(before);
  });
});


describe("round68 current interchange ownership", () => {
  const boundary = (value: number) => ({ contextCode: { coding: [
    { system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" },
  ] }, offsetDuration: { value, unit: "d" } });
  const member = () => ({ id: "dose", doseAndRate: [{ doseQuantity: q(1) }],
    timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } } });

  it.each(["boundary id", "quantity annotation", "boundary value"] as const)(
    "restores an opening pause only with an unchanged clinical start (%s)", edit => {
      let wire = persist(r6Save({ step: [
        { id: "pause", end: boundary(2), component: [] }, { id: "receiver", component: [member()] },
      ] }));
      if (edit === "boundary id") wire.step![0].start!.id = "submitted-start";
      else if (edit === "quantity annotation") wire.step![0].start!.offsetDuration!._value = { id: "submitted-offset" };
      else wire.step![0].start!.offsetDuration!.value = 3;
      const submittedStart = persist(wire.step![0].start);
      for (let save = 0; save < 2; save++) {
        const before = persist(wire), view = fromDosageDetails(wire);
        expect(view.course.step?.map(step => step.id)).toEqual(edit === "boundary value" ? ["receiver"] : ["pause", "receiver"]);
        const receiver = view.course.step!.find(step => step.id === "receiver")!;
        if (edit === "boundary value") expect(receiver.start).toEqual(submittedStart);
        else {
          expect(receiver.start).toBeUndefined();
          const starts: unknown[] = [];
          for (const marker of receiver.extension ?? []) if (marker.url === DOSAGE_RECONCILIATION_SOURCE_URL)
            for (const child of marker.extension ?? []) starts.push(decodeR6SourceMetadata(child, "step")?.start);
          expect(starts).toContainEqual(submittedStart);
        }
        expect(wire).toEqual(before);
        wire = toDosageDetails(persist(view.dosages), undefined, persist(view.course));
      }
    });

  it.each([false, true])("keeps an explicitly changed header response at course scope (%s)", changed => {
    const courseSafety: FhirR6DosageSafety = { doseLimit: [{ id: "course-limit", scope: "period",
      valueQuantity: q(10), period: { value: 1, unit: "d" } }], ifExceeded: "course response" };
    const stepSafety: FhirR6DosageSafety = { doseLimit: [{ id: "phase-limit", scope: "administration", valueQuantity: q(2) }],
      ifExceeded: "phase response" };
    let wire = persist(r6Save({ safety: courseSafety, step: [{ id: "phase", safety: stepSafety, component: [member()] }] }));
    if (changed) wire.safety!.ifExceeded = "phase response";
    for (let save = 0; save < 2; save++) {
      const before = persist(wire), view = fromDosageDetails(wire);
      expect(view.course.safety).toEqual({ ...courseSafety, ifExceeded: changed ? "phase response" : "course response" });
      expect(view.course.step![0].safety).toEqual(stepSafety);
      expect(wire).toEqual(before);
      wire = toDosageDetails(persist(view.dosages), undefined, persist(view.course));
    }
  });

  it("accepts and retains native R6 annotations on a site Reference", () => {
    const extension: FhirR6Extension = { url: "urn:clinic:site-size", valueQuantity: { value: 2, comparator: "~", unit: "cm2" } };
    const input: FhirR6Dosage = { ...member(), site: { reference: { reference: "BodyStructure/left-arm", display: "left arm",
      extension: [extension] } } };
    // @ts-expect-error R5 Reference extensions retain strict R5 Quantity comparators.
    const strict: FhirReference = { extension: [extension] };
    void strict;
    const source = course(input), before = persist(source);
    const wire = r6Save(source);
    expect(wire.step![0].component[0].site).toEqual(input.site);
    expect(toDosageDetails(persist(toFhirR5Dosages(wire))).step![0].component[0].site).toEqual(input.site);
    expect(source).toEqual(before);
  });

  it.each(["low", "high"] as const)("shows a unitless %s course-length bound in both public R5 previews", endpoint => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: {
      frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, boundsRange: { [endpoint]: { value: 3 } },
    } } };
    const before = persist(row);
    for (const text of [formatSig(row, "long", { locale: "en" }), fromFhirDosage(row, { locale: "en" }).longText]) {
      expect(text).toContain(endpoint === "high" ? "up to 3" : "at least 3");
      expect(text).not.toMatch(/3 (?:days?|weeks?|months?|hours?)/u);
    }
    expect(toDosageDetails([row]).step![0].component[0].timing!.repeat!.boundsRange).toEqual({ [endpoint]: { value: 3 } });
    expect(row).toEqual(before);
  });

  it("archives a cleared annotated cycle count without restoring it", () => {
    const slot: FhirExtension & { _valueInteger?: FhirElement } = { id: "authored-cycles", url: "cycles", valueInteger: 3,
      _valueInteger: { extension: [{ url: "urn:clinic:count-note", valueString: "retain" }] } };
    const unknown = { url: "urn:clinic:cycle-note", valueString: "independent" };
    const previous: FhirExtension = { url: CYCLE_DAY_ELIGIBILITY_EXTENSION_URL, extension: [
      { url: "day", valueInteger: 1 }, { url: "periodDays", valueInteger: 7 }, slot, unknown,
    ] };
    const before = persist(previous);
    const marker = cycleDayConstraintExtension({ days: [1], periodDays: 7, reason: "unresolved-cycle-eligibility", sourceText: "" }, previous);
    expect(marker.extension!.filter(child => child.url === "cycles")).toEqual([]);
    expect(marker.extension).toContainEqual({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [slot] });
    expect(marker.extension).toContainEqual(unknown);
    let rows: FhirDosage[] = [{ ...member(), modifierExtension: [marker] }];
    for (let save = 0; save < 2; save++) {
      expect(getCycleDayConstraint(rows[0])?.cycles).toBeUndefined();
      const wire = toDosageDetails(persist(rows));
      expect(wire.step![0].component[0].modifierExtension).toContainEqual(marker);
      rows = persist(toFhirR5Dosages(wire));
    }
    expect(previous).toEqual(before);
  });

  it.each([false, true])("keeps an annotation-only clock bridge beside its event anchor (valued=%s)", valued => {
    const when = { id: "event-annotation", extension: [{ url: "urn:clinic:event", valueString: "retain event" }] };
    const bridge = { url: TIMING_ADDITIONAL_CLOCK_EXTENSION_URL, _valueTime: {
      id: "clock-annotation", extension: [{ url: "urn:clinic:clock", valueString: "retain clock" }],
    } };
    const source = course({ ...member(), timing: { repeat: {
      ...(valued ? { when: [EventTiming.Morning] } : {}), _when: [when], extension: [bridge],
    } } });
    const before = persist(source);
    let wire = r6Save(source);
    for (let save = 0; save < 2; save++) {
      const repeat = wire.step![0].component[0].timing!.repeat!;
      expect(repeat.timeOfDay).toBeUndefined();
      expect(repeat._timeOfDay).toBeUndefined();
      expect(repeat._when).toEqual([when]);
      expect(repeat.extension).toContainEqual(bridge);
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
    }
    expect(source).toEqual(before);
  });
});


describe("round68 live R5 expression carrier", () => {
  it.each(["doseExpression", "rateExpression"] as const)("reads the current %s owner through fresh saves", field => {
    const original = { language: "text/fhirpath", expression: "%patient.weight" };
    const replacement = { language: "text/fhirpath", expression: "%patient.weight * 2" };
    const lifted = { language: "text/fhirpath", expression: "%patient.weight * 3" };
    const note: FhirExtension = { url: "urn:clinic:slot-note", valueString: "keep current slot annotation" };
    for (const edit of ["unchanged", "replace", "remove", "lifted"] as const) {
      const source = course({ doseAndRate: [field === "doseExpression" ? { doseExpression: original } : { rateExpression: original }] });
      let rows: EzDosage[] = persist(toFhirR5Dosages(source));
      const entry = rows[0].doseAndRate![0];
      const slot = entry.extension!.find(item => item.url === R5_EXPRESSION_SLOT_SOURCE_URL)!;
      slot.id = "current-expression-slot";
      slot.extension!.push({ url: "urn:clinic:expression-note", valueString: "retain carrier metadata" });
      (entry.extension ??= []).push(note);
      if (edit === "replace" || edit === "lifted") slot.extension!.find(item => item.url === field)!.valueExpression = replacement;
      if (edit === "remove") entry.extension = entry.extension!.filter(item => item.url !== R5_EXPRESSION_SLOT_SOURCE_URL);
      if (edit === "lifted") entry[field] = lifted;
      const expected = edit === "unchanged" ? original : edit === "replace" ? replacement : edit === "lifted" ? lifted : undefined;
      for (let save = 0; save < 2; save++) {
        const before = persist(rows), wire = toDosageDetails(rows);
        const actual = wire.step![0].component[0].doseAndRate![0];
        expect(actual[field], edit + " save " + save).toEqual(expected);
        expect(actual.extension).toContainEqual(note);
        if (edit !== "remove") expect(actual.extension?.reduce<FhirR6Extension[]>((all, item) =>
          all.concat(item.url === DOSAGE_RECONCILIATION_SOURCE_URL ? item.extension ?? [] : [item]), []
        )).toContainEqual(slot);
        expect(rows).toEqual(before);
        rows = persist(toFhirR5Dosages(wire));
      }
    }
  });
});

describe("round72 reviewed interchange source families", () => {
  function expectSelectedWarningRow(row: NonNullable<FhirDosage["additionalInstruction"] | FhirR6Dosage["additionalInstruction"]>[number],
    text: string, action: AdviceFrame): void {
    const { extension, ...fields } = row;
    expect(fields).toEqual({ text });
    expect(extension).toHaveLength(1);
    expect(extension![0].url).toBe(MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL);
    const selected = parseInstructionGraphExtension(extension)!;
    expect(selected.actions).toEqual([action]);
    expect(selected.relations ?? []).toEqual([]);
    expect(selected.coverage?.complete).not.toBe(true);
  }

  const note: FhirExtension = { url: "urn:clinic:source-note", valueString: "retain the supplied annotation" };
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] };
  const boundary = { contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] },
    offsetDuration: { value: 3, unit: "d" } };

  it.each(["annotation", "endpoint"] as const)("reconciles a duration range after a fresh %s edit", edit => {
    const source = r6Save({ step: [
      { id: "induction", component: [{ id: "initial", doseAndRate: [{ doseQuantity: q(1) }],
        timing: { repeat: { ...daily, boundsRange: { low: { value: 1, unit: "d" }, high: { value: 1, unit: "d" } } } } }] },
      { id: "pause", end: boundary, component: [], extension: [note] },
      { id: "maintenance", component: [{ id: "later", doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: daily } }] },
    ] });
    const input = persist(source), range = input.step![0].component[0].timing!.repeat!.boundsRange!;
    range.low!.id = "range-low";
    range.low!._value = { id: "range-value", extension: [note] };
    if (edit === "endpoint") range.high!.value = 2;
    const before = persist(input), editable = fromDosageDetails(input);
    const ids = ["induction", ...(edit === "annotation" ? ["pause"] : []), "maintenance"];
    expect(editable.course.step!.map(step => step.id)).toEqual(ids);
    const reopened = toDosageDetails(persist(editable.dosages), undefined, persist(editable.course));
    expect(reopened.step![0].component[0].timing!.repeat!.boundsRange).toEqual(range);
    expect(fromDosageDetails(reopened).course.step!.map(step => step.id)).toEqual(ids);
    expect(input).toEqual(before);
  });

  it("accepts native Reference Quantity annotations on a boundary without loosening R5", () => {
    const annotation: FhirR6Extension = { url: "urn:clinic:reference-note", valueQuantity: { value: 2, comparator: "~" } };
    const start: FhirR6RelativeTime = { contextReference: { reference: "Observation/anchor", extension: [annotation] } };
    const ordinary: FhirR6RelativeTime = { contextReference: { reference: "Observation/ordinary" } };
    // @ts-expect-error The R5 Reference annotation still uses the R5 Quantity comparator set.
    const r5: FhirReference = { extension: [annotation] };
    void r5; void ordinary;
    const source: FhirR6DosageInstruction = { step: [{ start, component: [{ doseAndRate: [{ doseQuantity: q(1) }] }] }] };
    const before = persist(source), projected = projectCanonicalCourse(importCanonicalCourse(source));
    expect(projected.fhirNext.step![0].start!.contextReference).toEqual(start.contextReference);
    expect(toDosageDetails(persist(projected.fhir)).step![0].start!.contextReference).toEqual(start.contextReference);
    expect(source).toEqual(before);
  });

  it.each([false, true])("projects a relation-free typed warning once beside independently supplied advice (supplied %s)", represented => {
    const graph = parseSig("Take 1 tablet daily; do not crush").meta.canonical.clauses[0].instructionGraph!;
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily },
      extension: [buildInstructionGraphExtension(graph)!],
      ...(represented ? { additionalInstruction: [{ id: "current-advice", text: "Do not crush.", extension: [note] }] } : {}) };
    const before = persist(row), projected = projectCanonicalCourse(importCanonicalCourse([row]));
    const expectedGraph = parseInstructionGraphExtension(row.extension)!;
    expect(expectedGraph.actions).toHaveLength(1);
    expect(expectedGraph.actions[0]).toMatchObject({ polarity: AdvicePolarity.Negate, predicate: { lemma: "crush" } });
    expect(expectedGraph.relations?.length ?? 0).toBe(0);
    for (const output of [projected.fhir[0], projected.fhirNext.step![0].component[0]]) {
      // Unframed supplied text remains independent; identical wording is not a typed ownership proof.
      expect(output.additionalInstruction).toHaveLength(represented ? 2 : 1);
      expectSelectedWarningRow(output.additionalInstruction![represented ? 1 : 0], "Do not crush", expectedGraph.actions[0]);
      if (represented) expect(output.additionalInstruction![0]).toEqual(row.additionalInstruction![0]);
      expect(output.doseAndRate).toEqual(row.doseAndRate);
      expect(output.timing).toEqual(row.timing);
      expect(parseInstructionGraphExtension(output.extension)).toEqual(expectedGraph);
    }
    expect(row).toEqual(before);
  });

  it.each([
    ["Take 1 tablet daily; do not crush", "Do not crush"],
    ["รับประทาน 1 เม็ด วันละครั้ง ห้ามบด", "ห้ามบด"],
  ])("preserves the exact selected standalone warning across fresh saves: %s", (source, warning) => {
    const parsed = parseSig(source);
    const before = persist(parsed.fhir);
    expect(parsed.fhir[0].additionalInstruction).toHaveLength(1);
    const selected = parseInstructionGraphExtension(parsed.fhir[0].additionalInstruction![0].extension)!;
    expect(selected.actions).toHaveLength(1);
    expect(selected.actions[0]).toMatchObject({ polarity: AdvicePolarity.Negate, predicate: { lemma: "crush" } });
    expect(selected.coverage?.complete).not.toBe(true);
    let rows = persist(parsed.fhir);
    for (let save = 0; save < 3; save++) {
      const inputBefore = persist(rows);
      const projected = projectCanonicalCourse(importCanonicalCourse(rows));
      for (const output of [projected.fhir[0], projected.fhirNext.step![0].component[0]]) {
        expect(output.additionalInstruction).toEqual(parsed.fhir[0].additionalInstruction);
        expect(output.additionalInstruction![0].text).toBe(warning);
        expect(parseInstructionGraphExtension(output.additionalInstruction![0].extension)!.actions).toEqual(selected.actions);
        expect(output.doseAndRate?.[0].doseQuantity?.value).toBe(1);
        expect(output.timing?.repeat).toMatchObject({ frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day });
        expect(parseInstructionGraphExtension(output.extension)?.actions[0].polarity).toBe(AdvicePolarity.Negate);
      }
      expect(rows).toEqual(inputBefore);
      rows = persist(projected.fhir);
    }
    expect(parsed.fhir).toEqual(before);
  });

  it.each(["418954008", "418914006"])("retains conditional coded advice beside an unconditional Drive warning: %s", code => {
    const graph: CanonicalInstructionGraph = { sourceText: "", actions: [{
      force: AdviceForce.Warning, polarity: AdvicePolarity.Negate,
      predicate: { lemma: "drive", semanticClass: "activity", display: "Drive" },
      args: [], span: { start: 0, end: 12 }, sourceText: ""
    }] };
    const advice = { id: "conditional-driving-warning", extension: [note],
      coding: [{ system: "http://snomed.info/sct", code }] };
    const codedEnglish = "May cause drowsiness; if affected, do not drive or operate machinery" +
      (code === "418914006" ? "; avoid alcohol." : ".");
    const codedThai = "อาจทำให้ง่วงซึม; ห้ามขับขี่ยานพาหนะหรือทำงานกับเครื่องจักรหากมีอาการ" +
      (code === "418914006" ? "; หลีกเลี่ยงเครื่องดื่มแอลกอฮอล์." : ".");
    const frames = buildAdditionalInstructionFramesFromCoding("http://snomed.info/sct", code)!;
    expect(frames.find(frame => frame.predicate.lemma === "cause")).toMatchObject({ modality: AdviceModality.May });
    expect(frames.find(frame => frame.predicate.lemma === "drive")).toMatchObject({
      polarity: AdvicePolarity.Negate, relation: AdviceRelation.If,
      args: [{ role: AdviceArgumentRole.Free, text: "affected", normalized: "affected" }]
    });
    for (const scheduled of [false, true]) {
      const row: FhirDosage = { additionalInstruction: [advice],
        extension: [buildInstructionGraphExtension(graph)!],
        ...(scheduled ? {
          doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
          timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
        } : {}),
      };
      for (const input of [persist([row]), persist({ step: [{ component: [row] }] })]) {
        const before = persist(input), native = importCanonicalCourse(input);
        const options = { locale: "en", realizationMode: "normalized" as const };
        for (const text of [formatSig(input, "long", options), formatCanonicalCourse(native, "long", options)]) {
          expect(text.split(codedEnglish)).toHaveLength(2);
          expect(text.split("Do not drive.")).toHaveLength(2);
          if (scheduled) {
            expect(text).toContain("1 tablet");
            expect(text).toContain("once daily");
          }
        }
        for (const text of [
          formatSig(input, "long", { ...options, locale: "th" }),
          formatCanonicalCourse(native, "long", { ...options, locale: "th" }),
        ]) {
          expect(text.split(codedThai)).toHaveLength(2);
          expect(text.split("ห้ามDrive.")).toHaveLength(2);
          if (scheduled) {
            expect(text).toContain("1 เม็ด");
            expect(text).toContain("วันละครั้ง");
          }
        }
        const projected = projectCanonicalCourse(native);
        for (const output of [projected.fhir[0], projected.fhirNext.step![0].component[0]]) {
          expect(output.additionalInstruction).toHaveLength(2);
          expect(output.additionalInstruction![0]).toEqual(advice);
          expectSelectedWarningRow(output.additionalInstruction![1], "Do not drive",
            parseInstructionGraphExtension(row.extension)!.actions[0]);
          expect(output.doseAndRate).toEqual(row.doseAndRate);
          expect(output.timing?.repeat).toEqual(row.timing?.repeat);
          expect(parseInstructionGraphExtension(output.extension)).toEqual(parseInstructionGraphExtension(row.extension));
        }
        expect(input).toEqual(before);
      }
    }
  });

  it("retains next-day drowsiness, conditional machinery advice, and separate alcohol advice beside a bedtime dose", () => {
    const advice = { id: "next-day-warning", extension: [note],
      coding: [{ system: "http://snomed.info/sct", code: "418071006" }] };
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        when: [EventTiming["Before Sleep"]] } }, additionalInstruction: [advice] };
    const frames = buildAdditionalInstructionFramesFromCoding("http://snomed.info/sct", "418071006")!;
    expect(frames.find(frame => frame.predicate.lemma === "cause")?.args)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ role: AdviceArgumentRole.Object, conceptId: "drowsiness" }),
        expect.objectContaining({ role: AdviceArgumentRole.Time, conceptId: "next_day" }),
      ]));
    expect(frames.find(frame => frame.predicate.lemma === "drive")).toMatchObject({
      polarity: AdvicePolarity.Negate, relation: AdviceRelation.If,
      args: [{ role: AdviceArgumentRole.Free, text: "affected", normalized: "affected" }],
    });
    expect(frames.find(frame => frame.predicate.lemma === "avoid")?.args)
      .toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Substance, conceptId: "alcohol" }));
    const english = "Causes drowsiness which may continue the next day; if affected, do not drive or operate machinery; avoid alcohol.";
    const thai = "ทำให้ง่วงซึมซึ่งอาจต่อเนื่องถึงวันถัดมา; ห้ามขับขี่ยานพาหนะหรือทำงานกับเครื่องจักรหากมีอาการ; หลีกเลี่ยงเครื่องดื่มแอลกอฮอล์.";
    for (const input of [persist([row]), persist({ step: [{ component: [row] }] })]) {
      const before = persist(input), native = importCanonicalCourse(input), nativeBefore = persist(native);
      const administration = native.stages[0].administrations[0];
      expect(administration.amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(administration.schedule?.recurrence).toMatchObject({
        frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, anchors: [EventTiming["Before Sleep"]],
      });
      expect(administration.predicate).toBeUndefined();
      for (const value of [native, input]) {
        const en = formatSig(value, "long", { locale: "en", realizationMode: "normalized" });
        const th = formatSig(value, "long", { locale: "th", realizationMode: "normalized" });
        expect(en.split(english)).toHaveLength(2);
        expect(en).toContain("1 tablet once daily at bedtime");
        expect(th.split(thai)).toHaveLength(2);
        expect(th).toContain("1 เม็ด วันละครั้ง ก่อนนอน");
      }
      const projected = projectCanonicalCourse(native);
      for (const output of [projected.fhir[0], projected.fhirNext.step![0].component[0]]) {
        expect(output.additionalInstruction).toEqual([advice]);
        expect(output.doseAndRate).toEqual(row.doseAndRate);
        expect(output.timing?.repeat).toEqual(row.timing?.repeat);
      }
      expect(native).toEqual(nativeBefore);
      expect(input).toEqual(before);
    }
  });

  it.each(["text", "display"] as const)("keeps supplied advice %s ahead of a known-code label", labelOwner => {
    const suppliedText = "Clinic warning: do not drive if affected";
    const suppliedDisplay = "Clinic display: avoid driving if affected";
    const advice = {
      id: "authored-warning", extension: [note],
      ...(labelOwner === "text" ? { text: suppliedText } : {}),
      coding: [{ system: "http://snomed.info/sct", code: "418954008", display: suppliedDisplay }],
    };
    const row: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
      additionalInstruction: [advice],
    };
    for (const input of [persist([row]), persist({ step: [{ component: [row] }] })]) {
      const before = persist(input);
      const text = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(text).toContain(labelOwner === "text" ? suppliedText : suppliedDisplay);
      expect(text).not.toContain("May cause drowsiness");
      if (labelOwner === "text") expect(text).not.toContain(suppliedDisplay);
      expect(text).toContain("1 tablet");
      expect(text).toContain("once daily");
      const projected = projectCanonicalCourse(importCanonicalCourse(input));
      for (const output of [projected.fhir[0], projected.fhirNext.step![0].component[0]]) {
        expect(output.additionalInstruction).toEqual([advice]);
        expect(output.doseAndRate).toEqual(row.doseAndRate);
        expect(output.timing?.repeat).toEqual(row.timing?.repeat);
      }
      expect(input).toEqual(before);
    }
  });

  it.each([false, true])("keeps complete typed warning qualifiers beside generic annotated coding (qualified %s)", qualified => {
    const text = qualified ? "Do not shake after adding water" : "Do not shake";
    const graph: CanonicalInstructionGraph = { sourceText: text, sourceLocale: "en", actions: [{
      force: AdviceForce.Warning, polarity: AdvicePolarity.Negate,
      predicate: { lemma: "shake", semanticClass: "prepare" },
      args: qualified ? [{ role: AdviceArgumentRole.Activity, relation: AdviceRelation.After,
        text: "adding water", normalized: "adding water" }] : [],
      span: { start: 0, end: text.length }, sourceText: text,
    }] };
    const advice = { id: "handling-warning", text: "Do not shake", extension: [note],
      coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-EntityHandling", code: "PSA" }] };
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 5, unit: "mL" } }],
      additionalInstruction: [advice], extension: [buildInstructionGraphExtension(graph)!] };
    const before = persist(row), projected = projectCanonicalCourse(importCanonicalCourse([row]));
    for (const output of [projected.fhir[0], projected.fhirNext.step![0].component[0]]) {
      expect(output.additionalInstruction).toHaveLength(qualified ? 2 : 1);
      expect(output.additionalInstruction![0]).toEqual(advice);
      if (qualified) expectSelectedWarningRow(output.additionalInstruction![1], text,
        parseInstructionGraphExtension(row.extension)!.actions[0]);
      expect(output.doseAndRate).toEqual(row.doseAndRate);
      expect(parseInstructionGraphExtension(output.extension)).toEqual(parseInstructionGraphExtension(row.extension));
    }
    const direct = canonicalToFhir(canonicalFromFhir(row));
    expect(direct.additionalInstruction?.map(value => value.text)).toEqual(qualified ? ["Do not shake", text] : [text]);
    expect(row).toEqual(before);
  });

  it.each(["en", "th"] as const)("shows replacement directions once beside current timing in %s", locale => {
    const source: FhirDosage = { text: "Swallow 1 tablet whole", timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } } };
    const row = persist(toFhirR5Dosages(toDosageDetails([source]))[0]);
    row.text = "Swallow 1 tablet with water";
    row.timing!.repeat!.frequency = 2;
    const before = persist(row), options = { locale, realizationMode: "roundtrip" as const };
    const imported = fromFhirDosage(row, options);
    for (const text of [formatSig(row, "short", options), formatSig(row, "long", options), imported.shortText, imported.longText]) {
      expect(text.split(row.text).length - 1).toBe(1);
      expect(text).toMatch(locale === "en" ? /twice daily|2 times|2x\/d/iu : /วันละ ?2/u);
    }
    expect(row).toEqual(before);
  });

  it("retains configured action Coding annotations before graph serialization", () => {
    const coding = { system: "https://example.org/clinic/actions", version: "2026", code: "coat-lightly", display: "Coat lightly",
      id: "clinic-action", userSelected: false, _code: { id: "authored-action-code", extension: [note] },
      extension: [note], clinicSource: { revision: "authored" } };
    const options = { instructionActionMap: { "coat lightly": { code: "coat-lightly", display: "Coat lightly",
      semanticClass: "procedure", procedural: true, coding } } };
    const before = persist(options), parsed = parseSig("coat lightly", options);
    const graph = parsed.meta.canonical.clauses[0].instructionGraph!;
    expect(graph.actions[0].predicate.codings).toContainEqual(coding);
    const restored = parseInstructionGraphExtension([buildInstructionGraphExtension(graph)!])!;
    expect(restored.actions[0].predicate.codings).toContainEqual(expect.objectContaining({
      id: coding.id, userSelected: false, _code: coding._code, extension: [note],
    }));
    expect(options).toEqual(before);
  });
});

describe("round74 shared source owners", () => {
  const note: FhirExtension = { url: "urn:clinic:source-note", valueString: "keep the source annotation" };
  const options: ParseOptions = { instructionActionMap: { disperse: {
    code: "disperse", display: "Disperse", semanticClass: "prepare", procedural: true, acceptsAmount: true, definesDose: true,
    argumentParser: "amount-material-destination", realizer: "amount-material-destination",
  } } };

  it("keeps primary owner annotations through the public graph codec", () => {
    const graph = parseSig("Disperse 2 tablets in 100 mL water, then swallow slowly with water at 10:00", options)
      .meta.canonical.clauses[0].instructionGraph!;
    const marker = buildInstructionGraphExtension(graph)!;
    const ownership = marker.extension!.find(item => item.url === "primaryOwnership")!;
    ownership.id = "authored-owner"; ownership.extension!.push(note);
    const resolved = ownership.extension!.find(item => item.url === "resolved")!;
    Object.assign(resolved, { id: "resolved-owner", _valueBoolean: { id: "resolved-value", extension: [note] } });
    const doseOwner = ownership.extension!.find(item => item.url === "doseActionIndex")!;
    doseOwner.id = "amount-owner";
    const before = persist(marker);
    let current = marker;
    for (let save = 0; save < 2; save++) {
      const decoded = parseInstructionGraphExtension([persist(current)])!;
      expect(decoded.primaryOwnership).toMatchObject({ administrationActionIndex: 1, dose: { actionIndex: 0, argumentIndex: 0 } });
      current = buildInstructionGraphExtension(decoded)!;
      const retained = current.extension!.filter(item => item.url === "primaryOwnership");
      expect(retained).toHaveLength(1);
      expect(retained[0].id).toBe("authored-owner");
      expect(retained[0].extension).toContainEqual(note);
      expect(retained[0].extension).toContainEqual(resolved);
      expect(retained[0].extension).toContainEqual(doseOwner);
    }
    expect(marker).toEqual(before);
  });



  it("merges current same-locale translations for graph Coding and PRN projection", () => {
    const oldThai = { id: "authored-translation", url: FHIR_TRANSLATION_EXTENSION_URL, extension: [
      { url: "lang", valueCode: "th" }, { id: "translation-content", url: "content", valueString: "เดิม" }, note,
    ] };
    const german = { url: FHIR_TRANSLATION_EXTENSION_URL, extension: [
      { url: "lang", valueCode: "de" }, { url: "content", valueString: "Beibehalten" },
    ] };
    const coding = { system: "https://example.org/clinic/actions", code: "coat-lightly", display: "Coat lightly",
      _display: { id: "display-owner", extension: [oldThai, german, note] }, i18n: { th: "ปัจจุบัน", fr: "Actuel" } };
    const parsed = parseSig("coat lightly", { instructionActionMap: { "coat lightly": {
      code: "coat-lightly", display: "Coat lightly", semanticClass: "procedure", procedural: true, coding,
    } } });
    const marker = buildInstructionGraphExtension(parsed.meta.canonical.clauses[0].instructionGraph!)!;
    const graphCoding = marker.extension!.find(item => item.url === "action")!.extension!
      .find(item => item.url === "predicateCoding")!.valueCoding!;
    const clause = persist(parseSig("Take 1 tablet as needed for pain").meta.canonical.clauses[0]);
    clause.prn = { enabled: true, reasons: [{ text: "pain", coding }] };
    const projected = canonicalToFhir(clause, undefined, { includeTranslationExtensions: true });
    const prnCoding = projected.asNeededFor![0].coding![0];
    for (const output of [graphCoding, prnCoding]) {
      expect(getPrimitiveTranslation(output._display, "th")).toBe("ปัจจุบัน");
      expect(getPrimitiveTranslations(output._display)).toMatchObject({ th: "ปัจจุบัน", de: "Beibehalten", fr: "Actuel" });
      expect(output._display!.id).toBe("display-owner");
      expect(output._display!.extension).toContainEqual(note);
      const thai = output._display!.extension!.filter(item =>
        item.url === FHIR_TRANSLATION_EXTENSION_URL && item.extension?.some(child => child.url === "lang" && child.valueCode === "th"));
      expect(thai).toHaveLength(1);
      expect(thai[0].id).toBe("authored-translation");
      expect(thai[0].extension).toContainEqual({ id: "translation-content", url: "content", valueString: "ปัจจุบัน" });
      expect(thai[0].extension).toContainEqual(note);
    }
    expect(coding._display.extension[0]).toEqual(oldThai);
  });

  it("retains independent historical header annotations when compact header fields win", () => {
    const historicalNote = { id: "historical-note", url: "urn:clinic:historical-header", valueString: "historical header annotation",
      _valueString: { id: "historical-value", extension: [note] } };
    const currentNote = { url: "urn:clinic:current-header", valueString: "current header annotation" };
    const header = encodeR5RetainedFields({ course: { id: "historical-header", extension: [historicalNote] } })
      .find(item => item.url === "course")!.extension!;
    const historical: FhirDosage = { sequence: 1, doseAndRate: [{ doseQuantity: q(1) }], modifierExtension: [{
      url: DOSAGE_DETAILS_R5_URL, extension: [{ url: "dosageDetails", extension: [
        ...header, encodeR6SourceMetadata("step", { component: [{ doseAndRate: [{ doseQuantity: q(1) }] }] }, "step"),
      ] }],
    }] };
    const compact = toFhirR5Dosages({ id: "current-header", extension: [currentNote],
      step: [{ component: [{ doseAndRate: [{ doseQuantity: q(2) }] }] }] })[0];
    let rows = persist([historical, compact]);
    const before = persist(rows);
    for (let save = 0; save < 2; save++) {
      const output = toDosageDetails(rows);
      expect(output.id).toBe("current-header");
      expect(output.extension).toContainEqual(currentNote);
      expect(JSON.stringify(output)).toContain(JSON.stringify(historicalNote));
      expect(output.step![0].component.map(member => member.doseAndRate![0].doseQuantity!.value)).toEqual([1, 2]);
      if (!save) expect(rows).toEqual(before);
      rows = persist(toFhirR5Dosages(output));
    }
  });

  it.each(["weekday", "anchor", "event"] as const)("reads a fresh wire %s edit through both supported interchange forms", kind => {
    const timing: FhirR6Timing = kind === "event"
      ? { event: ["2026-01-01T09:00:00Z"], _event: [{ id: "event-value", extension: [note] }] }
      : { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        ...(kind === "weekday" ? { dayOfWeek: [FhirDayOfWeek.Monday], _dayOfWeek: [{ id: "weekday-value", extension: [note] }] }
          : { when: [EventTiming.Morning], _when: [{ id: "anchor-value", extension: [note] }] }) } };
    const source = r6Save(course({ timing }));
    for (const input of [persist(source), persist(toFhirR5Dosages(source))]) {
      const member = Array.isArray(input) ? input[0] : input.step![0].component[0];
      if (kind === "weekday") member.timing!.repeat!.dayOfWeek = [FhirDayOfWeek.Tuesday];
      else if (kind === "anchor") member.timing!.repeat!.when = [EventTiming.Evening];
      else member.timing!.event = ["2026-01-02T09:00:00Z"];
      const before = persist(input), output = projectCanonicalCourse(importCanonicalCourse(input));
      for (const current of [output.fhir[0], output.fhirNext.step![0].component[0]]) {
        if (kind === "weekday") expect(current.timing!.repeat!.dayOfWeek).toEqual([FhirDayOfWeek.Tuesday]);
        else if (kind === "anchor") expect(current.timing!.repeat!.when).toEqual([EventTiming.Evening]);
        else expect(current.timing!.event).toEqual(["2026-01-02T09:00:00Z"]);
        expect(JSON.stringify(current)).toContain(note.valueString);
      }
      expect(input).toEqual(before);
    }
  });

  it.each(["range", "qualified", "scalar"] as const)("projects a source-less typed %s administration duration", kind => {
    const source: CanonicalCourse = { kind: "course", stages: [{ administrations: [{ kind: "administration",
      amounts: [{ quantity: { value: 1, unit: "tab" } }], schedule: { recurrence: {
        frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        ...(kind === "range" ? { occurrenceDurationRange: { low: { value: 20, unit: "min" }, high: { value: 30, unit: "min" } } }
          : { occurrenceDuration: 20, occurrenceDurationUnit: FhirPeriodUnit.Minute, ...(kind === "qualified" ? { occurrenceDurationComparator: ">=" as const } : {}) }),
      } },
    }] }] };
    const before = persist(source), projected = projectCanonicalCourse(source);
    for (const output of [projected.fhir[0], projected.fhirNext.step![0].component[0]]) {
      const repeat = output.timing!.repeat!, marker = repeat.extension?.find(item => item.url === TIMING_ADMINISTRATION_DURATION_EXTENSION_URL);
      if (kind === "scalar") {
        expect(repeat).toMatchObject({ duration: 20, durationUnit: "min" });
        expect(marker).toBeUndefined();
      } else {
        expect(repeat.duration).toBeUndefined();
        if (kind === "range") expect(marker?.valueRange).toMatchObject({ low: { value: 20, unit: "min" }, high: { value: 30, unit: "min" } });
        else expect(marker?.valueQuantity).toMatchObject({ value: 20, code: "min", comparator: ">=" });
      }
    }
    expect(source).toEqual(before);
  });
});
}
}


describe("relative meal course-end ownership", () => {
  it.each(["before breakfast", "after dinner", "before meal morning", "ก่อนอาหารเช้า"])("keeps until %s the next day as an end complement", meal => {
    const source = "Take 1 tablet every 6 hours until " + meal + " the next day";
    const tokens = tokenize(source), next = tokens.findIndex(token => token.lower === "next");
    // The complete end daughter owns NEXT even before chart selection.
    expect(nextDayOnsetAt(tokens, next, tokens.length)).toBeUndefined();
    expect(nextDayOnsetAt(tokens, next - 1, tokens.length)).toBeUndefined();
    const parsed = parsePublicSig(source), before = JSON.stringify(parsed);
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)), JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const course = importCanonicalCourse(input), administration = course.stages[0].administrations[0];
      expect(administration.amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(administration.schedule?.recurrence).toMatchObject({ period: 6, periodUnit: "h" });
      expect(administration.schedule?.recurrence?.anchors).toBeUndefined();
      expect(administration.onsetDays).toBeUndefined();
      expect(administration.onsetReference).toBeUndefined();
      expect(administration.phaseEnd).toMatchObject({ anchor: "unresolved", description: "until " + meal + " the next day" });
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toContain("until " + meal + " the next day");
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it("retains next-day onset for a meal dose with no end governor", () => {
    const source = "Take 1 tablet once before breakfast the next day", parsed = parsePublicSig(source);
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)), JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const stage = importCanonicalCourse(input).stages[0], administration = stage.administrations[0];
      expect(stage.start).toMatchObject({ anchor: "treatment-day-start", displacement: { value: 1, unit: "d" } });
      expect(administration.schedule?.recurrence).toMatchObject({ count: 1, anchors: [EventTiming["Before Breakfast"]] });
      expect(administration.phaseEnd).toBeUndefined();
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });
});
