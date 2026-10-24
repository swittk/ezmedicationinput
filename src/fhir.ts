import {
  setDosageCondition, setDosageExcludedDates, setDosageExcludedWeekdays
} from "./dosage-course";
import type { HpsgClinicalQuantityFeature } from "./hpsg/signature";
import {
  buildAdditionalInstructionFramesFromCoding,
  findAdditionalInstructionDefinitionByCoding
} from "./advice";
import {
  buildBodySiteAdministrationTargetCountExtension,
  getBodySiteAdministrationTargetCount
} from "./body-site-target";
import {
  buildBodySiteSpatialRelationExtensions,
  parseBodySiteSpatialRelationExtension
} from "./body-site-spatial";
import {
  buildBodySiteTopographicalModifierCoding,
  getBodySiteText
} from "./body-site-lookup";
import {
  buildTranslationPrimitiveElement,
  cloneExtensions,
  clonePrimitiveElement,
  getPrimitiveTranslations,
  mergeI18nRecords,
  mergeTranslationPrimitiveElement
} from "./fhir-translations";
import { formatCanonicalClause } from "./format";
import { buildInstructionGraphExtension, parseInstructionGraphExtension } from "./instruction-graph-fhir";
import { ParserState } from "./parser-state";
import { joinCanonicalPrnReasonTexts } from "./prn";
import { parseSnomedFindingSitePostcoordinationCode } from "./snomed-postcoordination";
import {
  ROUTE_BY_SNOMED,
  ROUTE_SNOMED,
  ROUTE_TEXT,
  findPrnReasonDefinitionByCoding
} from "./maps";
import {
  AdvicePolarity,
  CanonicalActivityTimingExpr,
  CanonicalCalendarEventExpr,
  CanonicalDosePeriodMaximumExpr,
  CanonicalOccurrenceCapExpr,
  CanonicalDoseRange,
  CanonicalSigClause,
  BodySiteRestriction,
  BodySiteSpatialRelation,
  EventTiming,
  FhirCodeableConcept,
  FhirDosage,
  FhirExtension,
  FhirPeriodUnit,
  FhirPrimitiveElement,
  FhirQuantity,
  FhirSimpleQuantity,
  FhirRange,
  FhirTimingRepeat,
  RouteCode,
  SNOMEDCTRouteCodes
} from "./types";
import { objectValues } from "./utils/object";
import { arrayIncludes } from "./utils/array";

export const TIMING_FREQUENCY_MIN_EXTENSION_URL = "https://solublelabs.com/fhir/StructureDefinition/medication-timing-frequency-min";
/** Modifier: each retained base-schedule opportunity occurs this many minutes later. */
export const ADMINISTRATION_OFFSET_EXTENSION_URL = "https://solublelabs.com/fhir/StructureDefinition/medication-administration-offset";

export function getAdministrationOffsetMinutes(dosage: FhirDosage): number | undefined {
  const quantity = dosage.modifierExtension?.find(extension =>
    extension.url === ADMINISTRATION_OFFSET_EXTENSION_URL)?.valueQuantity;
  return quantity?.value !== undefined && Number.isFinite(quantity.value) &&
    (quantity.code ?? quantity.unit) === "min" && !quantity.comparator ? quantity.value : undefined;
}

export const TIMING_OFFSET_MIN_EXTENSION_URL = "https://solublelabs.com/fhir/StructureDefinition/medication-timing-offset-min";
export const TIMING_OFFSET_MAX_EXTENSION_URL = "https://solublelabs.com/fhir/StructureDefinition/medication-timing-offset-max";
export const TIMING_OFFSET_EXACT_EXTENSION_URL = "https://solublelabs.com/fhir/StructureDefinition/medication-timing-offset-exact";
export const TIMING_ACTIVITY_WINDOW_EXTENSION_URL = "https://solublelabs.com/fhir/StructureDefinition/medication-timing-activity-window";
export const TIMING_OCCURRENCE_CAP_EXTENSION_URL = "https://solublelabs.com/fhir/StructureDefinition/medication-timing-occurrence-cap";
export const TIMING_EVENT_CALENDAR_SOURCE_EXTENSION_URL = "https://solublelabs.com/fhir/StructureDefinition/medication-timing-event-calendar-source";
export const PRN_TRIGGER_PHASE_EXTENSION_URL = "https://solublelabs.com/fhir/StructureDefinition/medication-prn-trigger-phase";
export const BODY_SITE_RESTRICTION_EXTENSION_URL = "https://solublelabs.com/fhir/StructureDefinition/medication-body-site-restriction";

export const INFUSION_CARRIER_MATERIAL_EXTENSION_URL =
  "https://github.com/swittk/ezmedicationinput/fhir/StructureDefinition/medication-infusion-carrier-material";

/** Draft FHIR R5 extension definition, produced from the same typed child
 * contract as the live encoder. Carrier material is a descriptive vehicle
 * role, not a verified drug code or a modified administration choice.
 * External HL7 conformance validation remains a separate release check.
 */
export function buildInfusionCarrierMaterialStructureDefinition() {
  const slice = (name: string, code: "string" | "integer", min: number) => [
    { id: "Extension.extension:" + name, path: "Extension.extension",
      sliceName: name, min, max: "1", type: [{ code: "Extension" }] },
    { id: "Extension.extension:" + name + ".extension",
      path: "Extension.extension.extension", max: "0" },
    { id: "Extension.extension:" + name + ".url",
      path: "Extension.extension.url", fixedUri: name },
    { id: "Extension.extension:" + name + ".value[x]",
      path: "Extension.extension.value[x]", min: 1, max: "1",
      type: [{ code }] }
  ];
  return {
    resourceType: "StructureDefinition" as const,
    id: "medication-infusion-carrier-material",
    url: INFUSION_CARRIER_MATERIAL_EXTENSION_URL,
    name: "MedicationInfusionCarrierMaterial",
    title: "Source-backed infusion carrier material",
    status: "draft" as const,
    description: "Uncoded original vehicle-noun phrase tied to a separately typed carrier volume and infusion duration; does not identify the administered active substance.",
    kind: "complex-type" as const,
    abstract: false,
    type: "Extension",
    baseDefinition: "http://hl7.org/fhir/StructureDefinition/Extension",
    derivation: "constraint" as const,
    context: [{ type: "element" as const, expression: "Dosage" }],
    differential: { element: [
      { id: "Extension", path: "Extension", isModifier: false },
      { id: "Extension.extension", path: "Extension.extension",
        slicing: { discriminator: [{ type: "value", path: "url" }],
          ordered: false, rules: "closed" } },
      ...slice("material", "string", 1),
      ...slice("start", "integer", 0),
      ...slice("end", "integer", 0),
      { id: "Extension.url", path: "Extension.url",
        fixedUri: INFUSION_CARRIER_MATERIAL_EXTENSION_URL },
      { id: "Extension.value[x]", path: "Extension.value[x]", max: "0" }
    ] }
  };
}

/** Preserve a clinically named vehicle without claiming it has a verified
 * terminology identity. This describes the volume-owned material and never
 * changes dose/rate scheduling or converts a vehicle into the active drug.
 */
function infusionCarrierMaterialExtension(
  material: NonNullable<HpsgClinicalQuantityFeature["carrierMaterial"]>
): FhirExtension {
  return {
    url: INFUSION_CARRIER_MATERIAL_EXTENSION_URL,
    extension: [
      { url: "material", valueString: material.text },
      ...(material.range ? [
        { url: "start", valueInteger: material.range.start },
        { url: "end", valueInteger: material.range.end }
      ] : [])
    ]
  };
}

/** Typed FHIR extraction: retain only supplied extension children, never
 * guess a vehicle from original SIG text or volume/mass alone.
 */
function infusionCarrierMaterialFromFhir(
  dosage: FhirDosage
): HpsgClinicalQuantityFeature["carrierMaterial"] {
  const extension = dosage.extension?.find(part =>
    part.url === INFUSION_CARRIER_MATERIAL_EXTENSION_URL);
  const child = (url: string) => extension?.extension?.find(part => part.url === url);
  const text = child("material")?.valueString;
  if (!text?.trim()) return undefined;
  const start = child("start")?.valueInteger;
  const end = child("end")?.valueInteger;
  return {
    text,
    ...(start !== undefined && end !== undefined &&
        Number.isInteger(start) && Number.isInteger(end) &&
        start >= 0 && end >= start ? { range: { start, end } } : {})
  };
}

/** Reconstitute dimensional R5 meaning only where the role and amount were
 * explicitly supplied. Other external rateRatio dosages remain untouched.
 */
function clinicalCarrierQuantityFromFhir(
  dosage: FhirDosage
): HpsgClinicalQuantityFeature | undefined {
  const material = infusionCarrierMaterialFromFhir(dosage);
  const measure = dosage.doseAndRate?.[0];
  const active = measure?.doseQuantity;
  const carrier = measure?.rateRatio?.numerator;
  const duration = measure?.rateRatio?.denominator;
  const doseUnit = active?.code ?? active?.unit;
  const volumeUnit = carrier?.code ?? carrier?.unit;
  const durationUnit = duration?.code ?? duration?.unit;
  if (!material ||
      typeof active?.value !== "number" || !Number.isFinite(active.value) ||
      typeof carrier?.value !== "number" || !Number.isFinite(carrier.value) ||
      typeof duration?.value !== "number" || !Number.isFinite(duration.value) ||
      active.value <= 0 || carrier.value <= 0 || duration.value <= 0 ||
      !doseUnit || !volumeUnit ||
      !/^(?:mL|L)$/u.test(volumeUnit) ||
      (durationUnit !== "h" && durationUnit !== "min")) return undefined;
  const periodUnit = durationUnit === "h" ? FhirPeriodUnit.Hour : FhirPeriodUnit.Minute;
  return {
    representation: "dose-with-rate-ratio",
    status: "resolved",
    numerator: { value: carrier.value, unit: volumeUnit, dimension: "volume" },
    denominators: [{ value: duration.value, unit: periodUnit, dimension: "time" }],
    projectedDose: { value: active.value, unit: doseUnit },
    rateNumerator: { value: carrier.value, unit: volumeUnit },
    administrationDuration: { value: duration.value, unit: periodUnit },
    carrierMaterial: material
  };
}

/** Make an implicit multi-clock cadence explicit without overriding a stated frequency.
 * @param repeat Editable FHIR timing currently being lowered.
 */
function normalizeClockFrequency(repeat: FhirTimingRepeat): void {
  if (repeat.frequency !== undefined || !repeat.period || !repeat.periodUnit || (repeat.timeOfDay?.length ?? 0) < 2) return;
  const clocks = new Set(repeat.timeOfDay).size;
  if (repeat.periodUnit === 'd') {
    repeat.frequency = clocks;
    return;
  }
  const weekdays = new Set(repeat.dayOfWeek ?? []).size;
  if (repeat.periodUnit === 'wk' && repeat.period === 1 && weekdays > 0) {
    repeat.frequency = clocks * weekdays;
  }
}

const SNOMED_SYSTEM = "http://snomed.info/sct";
const UCUM_SYSTEM = "http://unitsofmeasure.org";
const FHIR_GTS_TIMING_SYSTEM = "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation";
// R5 preferred TimingAbbreviation expansion, not arbitrary local Q12H/Q24H.
const FHIR_GTS_TIMING_CODES = new Set([
  "BID", "TID", "QID", "AM", "PM", "QD", "QOD",
  "Q1H", "Q2H", "Q3H", "Q4H", "Q6H", "Q8H",
  "BED", "WK", "MO"
]);

function prnTriggerPhaseExtension(phase: "onset" | undefined) {
  return phase ? { url: PRN_TRIGGER_PHASE_EXTENSION_URL, valueCode: phase } : undefined;
}

function parsePrnTriggerPhase(concept: FhirCodeableConcept | undefined): "onset" | undefined {
  const value = concept?.extension?.find(
    (candidate) => candidate.url === PRN_TRIGGER_PHASE_EXTENSION_URL
  )?.valueCode;
  return value === "onset" ? "onset" : undefined;
}

function restrictionRangeExtension(
  prefix: string,
  range: { start: number; end: number } | undefined
): FhirExtension[] {
  return range
    ? [
        { url: `${prefix}Start`, valueInteger: range.start },
        { url: `${prefix}End`, valueInteger: range.end }
      ]
    : [];
}

function buildBodySiteRestrictionExtensions(
  restrictions: BodySiteRestriction[] | undefined
): FhirExtension[] {
  if (!restrictions?.length) return [];
  return restrictions.map((restriction) => ({
    url: BODY_SITE_RESTRICTION_EXTENSION_URL,
    extension: [
      { url: "relation", valueCode: restriction.relation },
      { url: "sourceText", valueString: restriction.sourceText },
      { url: "predicateText", valueString: restriction.predicate.text },
      { url: "predicateForm", valueCode: restriction.predicate.form },
      ...(restriction.predicate.lemma
        ? [{ url: "predicateLemma", valueString: restriction.predicate.lemma }]
        : []),
      ...(restriction.predicate.focusText
        ? [{ url: "predicateFocusText", valueString: restriction.predicate.focusText }]
        : []),
      ...restrictionRangeExtension("source", restriction.range),
      ...restrictionRangeExtension("marker", restriction.markerRange),
      ...restrictionRangeExtension("predicate", restriction.predicate.range)
    ]
  }));
}

function restrictionExtensionChild(
  extension: FhirExtension,
  url: string
): FhirExtension | undefined {
  return extension.extension?.find((candidate) => candidate.url === url);
}

function restrictionRangeFromExtension(
  extension: FhirExtension,
  prefix: string
): { start: number; end: number } | undefined {
  const start = restrictionExtensionChild(extension, `${prefix}Start`)?.valueInteger;
  const end = restrictionExtensionChild(extension, `${prefix}End`)?.valueInteger;
  return Number.isInteger(start) && Number.isInteger(end) && (end as number) >= (start as number)
    ? { start: start as number, end: end as number }
    : undefined;
}

function parseBodySiteRestrictionExtensions(
  concept: FhirCodeableConcept | undefined
): BodySiteRestriction[] | undefined {
  if (!concept?.extension?.length) return undefined;
  const result: BodySiteRestriction[] = [];
  for (const extension of concept.extension) {
    if (extension.url !== BODY_SITE_RESTRICTION_EXTENSION_URL) continue;
    const relation = restrictionExtensionChild(extension, "relation")?.valueCode;
    const predicateText = restrictionExtensionChild(extension, "predicateText")?.valueString?.trim();
    if (relation !== "where" || !predicateText) continue;
    const rawForm = restrictionExtensionChild(extension, "predicateForm")?.valueCode;
    const form = rawForm === "state" || rawForm === "existential" || rawForm === "raw"
      ? rawForm
      : "raw";
    result.push({
      relation,
      sourceText: restrictionExtensionChild(extension, "sourceText")?.valueString?.trim() ??
        `where ${predicateText}`,
      range: restrictionRangeFromExtension(extension, "source"),
      markerRange: restrictionRangeFromExtension(extension, "marker"),
      predicate: {
        text: predicateText,
        lemma: restrictionExtensionChild(extension, "predicateLemma")?.valueString?.trim() || undefined,
        form,
        focusText: restrictionExtensionChild(extension, "predicateFocusText")?.valueString?.trim() || undefined,
        range: restrictionRangeFromExtension(extension, "predicate")
      }
    });
  }
  return result.length ? result : undefined;
}

function timingOffsetExtensionValue(
  repeat: FhirTimingRepeat | undefined,
  url: string
): number | undefined {
  const extension = repeat?.extension?.find((candidate) => candidate.url === url);
  const value = extension?.valueInteger ?? extension?.valueDecimal;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function timingOffsetExtension(url: string, minutes: number) {
  return Number.isInteger(minutes)
    ? { url, valueInteger: minutes }
    : { url, valueDecimal: minutes };
}

export function getExactTimingOffsetMinutes(
  repeat: FhirTimingRepeat | undefined
): number | undefined {
  if (repeat?.offset !== undefined) return repeat.offset;
  return timingOffsetExtensionValue(repeat, TIMING_OFFSET_EXACT_EXTENSION_URL);
}

function activityTimingOffsetChild(url: string, value: number | undefined) {
  if (value === undefined) return undefined;
  return {
    url,
    valueQuantity: {
      value,
      unit: "minutes",
      system: UCUM_SYSTEM,
      code: "min"
    }
  };
}

function buildActivityTimingExtension(
  item: CanonicalActivityTimingExpr,
  options?: FhirProjectionOptions
) {
  const children = [
    { url: "relation", valueCode: item.relation },
    {
      url: "activity",
      valueCodeableConcept: {
        text: item.activity.text,
        coding: item.activity.coding?.code ? [{ ...item.activity.coding }] : undefined,
        _text: options?.includeTranslationExtensions
          ? buildTranslationPrimitiveElement(item.activity.i18n)
          : undefined
      }
    },
    activityTimingOffsetChild("offset", item.offset),
    activityTimingOffsetChild("offsetMin", item.offsetMin),
    activityTimingOffsetChild("offsetMax", item.offsetMax)
  ].filter((child): child is NonNullable<typeof child> => Boolean(child));
  return { url: TIMING_ACTIVITY_WINDOW_EXTENSION_URL, extension: children };
}

function activityTimingQuantityMinutes(extension: NonNullable<FhirTimingRepeat["extension"]>[number] | undefined): number | undefined {
  const value = extension?.valueQuantity?.value;
  const unit = extension?.valueQuantity?.code ?? extension?.valueQuantity?.unit;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  if (!unit || unit === "min" || /^minutes?$/i.test(unit)) return value;
  if (unit === "h" || /^hours?$/i.test(unit)) return value * 60;
  if (unit === "d" || /^days?$/i.test(unit)) return value * 1440;
  return undefined;
}

function buildOccurrenceCapExtension(cap: CanonicalOccurrenceCapExpr) {
  return {
    url: TIMING_OCCURRENCE_CAP_EXTENSION_URL,
    extension: [
      { url: "max", valueInteger: cap.max },
      {
        url: "period",
        valueQuantity: {
          value: cap.period,
          unit: cap.periodUnit,
          system: UCUM_SYSTEM,
          code: cap.periodUnit
        }
      }
    ]
  };
}

export function getTimingOccurrenceCap(
  repeat: FhirTimingRepeat | undefined
): CanonicalOccurrenceCapExpr | undefined {
  const extension = repeat?.extension?.find(
    (candidate) => candidate.url === TIMING_OCCURRENCE_CAP_EXTENSION_URL
  );
  const child = (url: string) => extension?.extension?.find((candidate) => candidate.url === url);
  const max = child("max")?.valueInteger;
  const periodQuantity = child("period")?.valueQuantity;
  const period = periodQuantity?.value;
  const periodUnit = periodQuantity?.code ?? periodQuantity?.unit;
  if (
    typeof max !== "number" || !Number.isInteger(max) || max < 1 ||
    typeof period !== "number" || !Number.isFinite(period) || period <= 0 ||
    !periodUnit
  ) return undefined;
  const mappedUnit = periodUnit as FhirPeriodUnit;
  if (["s", "min", "h", "d", "wk", "mo", "a"].indexOf(mappedUnit) < 0) return undefined;
  return { max, period, periodUnit: mappedUnit };
}

function canonicalDosePeriodMaximums(
  dosage: FhirDosage
): CanonicalDosePeriodMaximumExpr[] | undefined {
  const result: CanonicalDosePeriodMaximumExpr[] = [];
  for (const ratio of dosage.maxDosePerPeriod ?? []) {
    const amount = ratio.numerator?.value;
    const unit = ratio.numerator?.unit ?? ratio.numerator?.code;
    const period = ratio.denominator?.value;
    const rawPeriodUnit = ratio.denominator?.code ?? ratio.denominator?.unit;
    if (amount === undefined || !Number.isFinite(amount) || amount <= 0 || !unit ||
        period === undefined || !Number.isFinite(period) || period <= 0 ||
        !rawPeriodUnit ||
        ["s", "min", "h", "d", "wk", "mo", "a"].indexOf(rawPeriodUnit) < 0) continue;
    result.push({
      amount,
      unit,
      period,
      periodUnit: rawPeriodUnit as FhirPeriodUnit
    });
  }
  return result.length ? result : undefined;
}

function parseActivityTimingExtensions(repeat: FhirTimingRepeat | undefined): CanonicalActivityTimingExpr[] | undefined {
  const result: CanonicalActivityTimingExpr[] = [];
  for (const extension of repeat?.extension ?? []) {
    if (extension.url !== TIMING_ACTIVITY_WINDOW_EXTENSION_URL) continue;
    const child = (url: string) => extension.extension?.find((candidate) => candidate.url === url);
    const relation = child("relation")?.valueCode;
    const activityConcept = child("activity")?.valueCodeableConcept;
    const text = activityConcept?.text ?? activityConcept?.coding?.[0]?.display;
    if ((relation !== "before" && relation !== "after") || !text) continue;
    const coding = activityConcept?.coding?.find((candidate) => Boolean(candidate.code));
    const i18n = getPrimitiveTranslations(activityConcept?._text) ?? {};
    result.push({
      relation,
      activity: {
        text,
        i18n: Object.keys(i18n).length ? i18n : undefined,
        coding: coding ? { ...coding } : undefined
      },
      offset: activityTimingQuantityMinutes(child("offset")),
      offsetMin: activityTimingQuantityMinutes(child("offsetMin")),
      offsetMax: activityTimingQuantityMinutes(child("offsetMax"))
    });
  }
  return result.length ? result : undefined;
}
type CodeableConceptCoding = NonNullable<FhirCodeableConcept["coding"]>[number];

export interface FhirProjectionOptions {
  /** Typed regimen-graph sequence; serialized without inferring phase meaning. */
  sequence?: number;
  /**
   * Defaults to true. When true, structured spatial body-site phrases such as
   * "top of head" can emit a SNOMED topographical modifier expression in
   * Dosage.site.coding while preserving the spatial-relation extension.
   */
  bodySitePostcoordination?: boolean;
  /**
   * Emits FHIR primitive translation extensions on coded concepts when
   * translation metadata is available.
   */
  includeTranslationExtensions?: boolean;
}

function createEmptyCanonicalClause(rawText: string): CanonicalSigClause {
  return {
    kind: "administration",
    rawText,
    raw: {
      start: 0,
      end: rawText.length,
      text: rawText
    },
    leftovers: [],
    evidence: [],
    confidence: 1
  };
}

function selectFirstCodingWithCode(
  concept: FhirCodeableConcept | undefined
): CodeableConceptCoding | undefined {
  if (!concept?.coding?.length) {
    return undefined;
  }
  for (const coding of concept.coding) {
    if (coding.code) {
      return coding;
    }
  }
  return undefined;
}

function selectPreferredSiteCoding(site: FhirCodeableConcept | undefined): CodeableConceptCoding | undefined {
  if (!site?.coding?.length) {
    return undefined;
  }
  for (const coding of site.coding) {
    if (coding.system === SNOMED_SYSTEM && coding.code) {
      return coding;
    }
  }
  return selectFirstCodingWithCode(site);
}

type CanonicalSite = NonNullable<CanonicalSigClause["site"]>;

function selectCanonicalSiteCoding(
  site: CanonicalSite | undefined,
  options?: FhirProjectionOptions
): CanonicalSite["coding"] | undefined {
  if (options?.bodySitePostcoordination === false) {
    return site?.coding;
  }
  const postcoordinated = buildBodySiteTopographicalModifierCoding(
    site?.spatialRelation,
    site?.text,
    { postcoordination: true }
  );
  return options?.bodySitePostcoordination === true
    ? postcoordinated ?? site?.coding
    : site?.coding ?? postcoordinated;
}

function buildSiteCodingArray(
  siteCoding: CanonicalSite["coding"] | undefined,
  options?: FhirProjectionOptions
): CodeableConceptCoding[] | undefined {
  if (!siteCoding?.code) {
    return undefined;
  }
  const displayElement = options?.includeTranslationExtensions
    ? buildTranslationPrimitiveElement(siteCoding.i18n)
    : undefined;
  return [
    {
      system: siteCoding.system ?? SNOMED_SYSTEM,
      code: siteCoding.code,
      display: siteCoding.display,
      ...(displayElement ? { _display: displayElement } : {})
    }
  ];
}

function getFallbackSiteText(site: FhirCodeableConcept | undefined): string | undefined {
  if (site?.text) {
    return site.text;
  }
  const siteCoding = selectPreferredSiteCoding(site);
  return siteCoding?.code
    ? getBodySiteText({
      system: siteCoding.system,
      code: siteCoding.code,
      display: siteCoding.display
    })
    : undefined;
}

function codeableConceptTranslationI18n(
  concept: FhirCodeableConcept | undefined,
  coding: CodeableConceptCoding | undefined,
  fallback?: Record<string, string>
): {
  text?: Record<string, string>;
  display?: Record<string, string>;
} {
  return {
    text: mergeI18nRecords(
      fallback,
      getPrimitiveTranslations(concept?._text)
    ),
    display: mergeI18nRecords(
      coding?.i18n,
      getPrimitiveTranslations(coding?._display)
    )
  };
}

function lowerFirst(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.charAt(0).toLowerCase() + trimmed.slice(1) : undefined;
}

function getSpatialPrnReasonSiteText(
  spatialRelation: BodySiteSpatialRelation | undefined
): string | undefined {
  const sourceText = lowerFirst(spatialRelation?.sourceText);
  if (sourceText) {
    return sourceText;
  }
  const targetText =
    lowerFirst(spatialRelation?.targetText) ??
    (spatialRelation?.targetCoding ? getBodySiteText(spatialRelation.targetCoding) : undefined);
  if (!targetText) {
    return undefined;
  }
  const relationText = lowerFirst(spatialRelation?.relationText);
  if (!relationText) {
    return `at ${targetText}`;
  }
  switch (relationText) {
    case "at":
    case "in":
    case "inside":
    case "into":
    case "on":
    case "to":
    case "above":
    case "below":
    case "beneath":
    case "under":
    case "behind":
    case "around":
    case "near":
    case "between":
    case "outside":
      return `${relationText} ${targetText}`;
    case "top":
    case "back":
    case "front":
    case "left side":
    case "right side":
    case "both sides":
      return `${relationText} of ${targetText}`;
    default:
      return relationText.endsWith(" of")
        ? `${relationText} ${targetText}`
        : `${relationText} of ${targetText}`;
  }
}

function getFallbackPrnReasonText(concept: FhirCodeableConcept | undefined): string | undefined {
  if (concept?.text) {
    return concept.text;
  }
  const coding = selectFirstCodingWithCode(concept);
  const spatialRelation = parseBodySiteSpatialRelationExtension(concept);
  const spatialSiteText = getSpatialPrnReasonSiteText(spatialRelation);
  const display = lowerFirst(coding?.display);
  if (display && !spatialSiteText) {
    return display;
  }
  const parsed = parseSnomedFindingSitePostcoordinationCode(coding?.code);
  const focus =
    parsed && (coding?.system ?? SNOMED_SYSTEM) === SNOMED_SYSTEM
      ? findPrnReasonDefinitionByCoding(SNOMED_SYSTEM, parsed.focusCode)
      : undefined;
  const focusText = lowerFirst(focus?.text ?? focus?.coding?.display) ?? display;
  if (focusText && spatialSiteText) {
    return spatialSiteText.toLowerCase().startsWith(`${focusText.toLowerCase()} `)
      ? spatialSiteText
      : `${focusText} ${spatialSiteText}`;
  }
  if (display) {
    return display;
  }
  if (!parsed || (coding?.system ?? SNOMED_SYSTEM) !== SNOMED_SYSTEM) {
    return undefined;
  }
  const siteText = getBodySiteText({
    system: SNOMED_SYSTEM,
    code: parsed.siteCode
  });
  return focusText && siteText ? `${focusText} at ${siteText}` : focusText;
}

function buildFhirDoseRange(range: CanonicalDoseRange, unit: string | undefined): FhirRange | undefined {
  const fhirRange: FhirRange = {};

  if (range.low !== undefined) {
    fhirRange.low = {
      value: range.low,
      unit
    };
  }
  if (range.high !== undefined) {
    fhirRange.high = {
      value: range.high,
      unit
    };
  }

  if (!fhirRange.low && !fhirRange.high) {
    return undefined;
  }

  return fhirRange;
}

function describeDurationUnit(unit: FhirPeriodUnit, value: number | undefined): string {
  const plural = value !== 1;
  switch (unit) {
    case FhirPeriodUnit.Second:
      return plural ? "seconds" : "second";
    case FhirPeriodUnit.Minute:
      return plural ? "minutes" : "minute";
    case FhirPeriodUnit.Hour:
      return plural ? "hours" : "hour";
    case FhirPeriodUnit.Day:
      return plural ? "days" : "day";
    case FhirPeriodUnit.Week:
      return plural ? "weeks" : "week";
    case FhirPeriodUnit.Month:
      return plural ? "months" : "month";
    case FhirPeriodUnit.Year:
      return plural ? "years" : "year";
    default:
      return unit;
  }
}

function extensionChild(
  extension: { extension?: Array<{ url: string; valueCode?: string; valueString?: string; valueBoolean?: boolean; valueInteger?: number }> },
  url: string
) {
  return extension.extension?.find((candidate) => candidate.url === url);
}

function calendarEventPrimitive(event: CanonicalCalendarEventExpr): FhirPrimitiveElement {
  return {
    extension: [{
      url: TIMING_EVENT_CALENDAR_SOURCE_EXTENSION_URL,
      extension: [
        { url: "calendar", valueCode: event.calendar },
        { url: "calendarYear", valueInteger: event.calendarYear },
        { url: "month", valueInteger: event.month },
        { url: "day", valueInteger: event.day },
        { url: "sourceText", valueString: event.sourceText },
        ...(event.inferredYear ? [{ url: "inferredYear", valueBoolean: true }] : [])
      ]
    }]
  };
}

function calendarEventFromFhir(
  value: string,
  primitive?: FhirPrimitiveElement
): CanonicalCalendarEventExpr | undefined {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/u);
  if (!match) return undefined;
  const isoYear = Number(match[1]);
  const isoMonth = Number(match[2]);
  const isoDay = Number(match[3]);
  if (!Number.isFinite(isoYear) || !Number.isFinite(isoMonth) || !Number.isFinite(isoDay)) return undefined;
  const date = new Date(Date.UTC(isoYear, isoMonth - 1, isoDay));
  if (
    date.getUTCFullYear() !== isoYear ||
    date.getUTCMonth() !== isoMonth - 1 ||
    date.getUTCDate() !== isoDay
  ) return undefined;

  const metadata = primitive?.extension?.find(
    (candidate) => candidate.url === TIMING_EVENT_CALENDAR_SOURCE_EXTENSION_URL
  );
  const calendar = extensionChild(metadata ?? {}, "calendar")?.valueCode;
  const calendarYear = extensionChild(metadata ?? {}, "calendarYear")?.valueInteger;
  const month = extensionChild(metadata ?? {}, "month")?.valueInteger;
  const day = extensionChild(metadata ?? {}, "day")?.valueInteger;
  const sourceText = extensionChild(metadata ?? {}, "sourceText")?.valueString;
  const inferredYear = extensionChild(metadata ?? {}, "inferredYear")?.valueBoolean;

  const isoDate = `${match[1]}-${match[2]}-${match[3]}`;
  return {
    isoDate,
    ...(value === isoDate ? {} : { fhirDateTime: value }),
    calendar: calendar || "gregory",
    calendarYear: calendarYear ?? isoYear,
    month: month ?? isoMonth,
    day: day ?? isoDay,
    sourceText: sourceText ?? value,
    inferredYear: inferredYear || undefined
  };
}

function buildFhirDurationQuantity(value: number, unit: FhirPeriodUnit): FhirSimpleQuantity {
  return {
    value,
    unit: describeDurationUnit(unit, value),
    system: UCUM_SYSTEM,
    code: unit
  };
}

function buildFhirBoundsRange(
  low: number,
  high: number,
  unit: FhirPeriodUnit
): FhirRange {
  return {
    low: buildFhirDurationQuantity(low, unit),
    high: buildFhirDurationQuantity(high, unit)
  };
}

function parseFhirDurationUnit(quantity: FhirQuantity | undefined): FhirPeriodUnit | undefined {
  const candidate = quantity?.code?.trim().toLowerCase() ?? quantity?.unit?.trim().toLowerCase();
  switch (candidate) {
    case "s":
    case "sec":
    case "second":
    case "seconds":
      return FhirPeriodUnit.Second;
    case "min":
    case "mins":
    case "minute":
    case "minutes":
      return FhirPeriodUnit.Minute;
    case "h":
    case "hr":
    case "hrs":
    case "hour":
    case "hours":
      return FhirPeriodUnit.Hour;
    case "d":
    case "day":
    case "days":
      return FhirPeriodUnit.Day;
    case "wk":
    case "wks":
    case "week":
    case "weeks":
      return FhirPeriodUnit.Week;
    case "mo":
    case "month":
    case "months":
      return FhirPeriodUnit.Month;
    case "a":
    case "yr":
    case "yrs":
    case "year":
    case "years":
      return FhirPeriodUnit.Year;
    default:
      return undefined;
  }
}

function extractCanonicalTimingBounds(
  repeat: FhirTimingRepeat | undefined
): { duration?: number; durationMax?: number; durationUnit?: FhirPeriodUnit; warning?: string } {
  if (!repeat) {
    return {};
  }

  if (repeat.boundsDuration?.value !== undefined) {
    const durationUnit = parseFhirDurationUnit(repeat.boundsDuration);
    if (!durationUnit) {
      return {};
    }
    return {
      duration: repeat.boundsDuration.value,
      durationUnit
    };
  }

  if (!repeat.boundsRange) {
    return {};
  }

  const low = repeat.boundsRange.low;
  const high = repeat.boundsRange.high;
  const lowUnit = parseFhirDurationUnit(low);
  const highUnit = parseFhirDurationUnit(high);
  const durationUnit = lowUnit ?? highUnit;
  if (!durationUnit) {
    return {};
  }

  let warning: string | undefined;
  if (lowUnit && highUnit && lowUnit !== highUnit) {
    warning = `FHIR timing boundsRange low/high units differ (${lowUnit} vs ${highUnit}); preserved numeric bounds using ${durationUnit}.`;
  }

  return {
    duration: low?.value,
    durationMax: high?.value,
    durationUnit,
    warning
  };
}

function extractCanonicalDoseRange(
  range: FhirRange
): { range?: CanonicalDoseRange; unit?: string; warning?: string } {
  const canonicalRange: CanonicalDoseRange = {};
  const lowUnit = range.low?.unit;
  const highUnit = range.high?.unit;

  if (range.low?.value !== undefined) {
    canonicalRange.low = range.low.value;
  }
  if (range.high?.value !== undefined) {
    canonicalRange.high = range.high.value;
  }

  if (canonicalRange.low === undefined && canonicalRange.high === undefined) {
    return {};
  }

  const unit = lowUnit ?? highUnit;
  let warning: string | undefined;
  if (lowUnit && highUnit && lowUnit !== highUnit) {
    warning = `FHIR doseRange low/high units differ (${lowUnit} vs ${highUnit}); preserved numeric bounds using ${unit}.`;
  }

  return {
    range: canonicalRange,
    unit,
    warning
  };
}

function appendWarning(warnings: string[] | undefined, warning: string | undefined): string[] | undefined {
  if (!warning) {
    return warnings;
  }
  if (!warnings) {
    return [warning];
  }
  warnings.push(warning);
  return warnings;
}

export function canonicalToFhir(
  clause: CanonicalSigClause,
  textOverride?: string,
  options?: FhirProjectionOptions
): FhirDosage {
  const dosage: FhirDosage = options?.sequence !== undefined
    ? { sequence: options.sequence }
    : {};
  const instructionGraphExtension = buildInstructionGraphExtension(clause.instructionGraph);
  if (instructionGraphExtension) {
    dosage.extension = [instructionGraphExtension];
  }
  const repeat: FhirTimingRepeat = {};
  let hasRepeat = false;
  const schedule = clause.schedule;
  if (schedule?.administrationOffsetMinutes !== undefined) {
    dosage.modifierExtension = [{
      url: ADMINISTRATION_OFFSET_EXTENSION_URL,
      valueQuantity: { value: schedule.administrationOffsetMinutes, unit: "min", code: "min", system: "http://unitsofmeasure.org" }
    }];
  }

  if (schedule?.calendarEvents?.length) {
    dosage.timing = {
      ...(dosage.timing ?? {}),
      event: schedule.calendarEvents.map((event) => event.fhirDateTime ?? event.isoDate),
      _event: schedule.calendarEvents.map(calendarEventPrimitive)
    };
  }
  if (schedule?.boundsStart || schedule?.boundsEnd) {
    repeat.boundsPeriod = {
      ...(schedule.boundsStart ? { start: schedule.boundsStart } : {}),
      ...(schedule.boundsEnd ? { end: schedule.boundsEnd } : {})
    };
    hasRepeat = true;
  }

  if (schedule?.frequency !== undefined && schedule.frequency > 0) {
    repeat.frequency = schedule.frequency;
    hasRepeat = true;
  } else if (schedule?.frequency === 0) {
    repeat.extension = [
      ...(repeat.extension ?? []),
      { url: TIMING_FREQUENCY_MIN_EXTENSION_URL, valueInteger: 0 }
    ];
    hasRepeat = true;
  }
  if (schedule?.count !== undefined) {
    repeat.count = schedule.count;
    hasRepeat = true;
  }
  if (schedule?.countMax !== undefined) {
    repeat.count = repeat.count ?? 1;
    repeat.countMax = schedule.countMax;
    hasRepeat = true;
  }
  if (schedule?.administrationDuration !== undefined && schedule.administrationDurationUnit) {
    repeat.duration = schedule.administrationDuration;
    repeat.durationUnit = schedule.administrationDurationUnit;
    if (schedule.administrationDurationMax !== undefined) {
      repeat.durationMax = schedule.administrationDurationMax;
    }
    hasRepeat = true;
  }
  // An anchored canonical schedule retains its source duration alongside the
  // derived inclusive calendar end. FHIR Timing allows only one bounds[x], so
  // boundsPeriod is the lossless executable projection while canonical keeps
  // both typed facts for editing and provenance.
  if (schedule?.duration !== undefined && schedule.durationUnit &&
      !schedule.boundsStart && !schedule.boundsEnd) {
    if (schedule.durationMax !== undefined && schedule.durationMax !== schedule.duration) {
      repeat.boundsRange = buildFhirBoundsRange(
        schedule.duration,
        schedule.durationMax,
        schedule.durationUnit
      );
    } else {
      repeat.boundsDuration = buildFhirDurationQuantity(schedule.duration, schedule.durationUnit);
    }
    hasRepeat = true;
  }
  if (schedule?.frequencyMax !== undefined) {
    repeat.frequencyMax = schedule.frequencyMax;
    hasRepeat = true;
  }
  if (schedule?.period !== undefined && schedule.periodUnit) {
    repeat.period = schedule.period;
    repeat.periodUnit = schedule.periodUnit;
    hasRepeat = true;
  }
  if (schedule?.periodMax !== undefined) {
    repeat.periodMax = schedule.periodMax;
    hasRepeat = true;
  }
  if (schedule?.offset !== undefined) {
    if (Number.isInteger(schedule.offset)) {
      repeat.offset = schedule.offset;
    } else {
      repeat.extension = [
        ...(repeat.extension ?? []),
        timingOffsetExtension(TIMING_OFFSET_EXACT_EXTENSION_URL, schedule.offset)
      ];
    }
    hasRepeat = true;
  }
  if (schedule?.offsetMin !== undefined) {
    repeat.extension = [
      ...(repeat.extension ?? []),
      timingOffsetExtension(TIMING_OFFSET_MIN_EXTENSION_URL, schedule.offsetMin)
    ];
    hasRepeat = true;
  }
  if (schedule?.offsetMax !== undefined) {
    repeat.extension = [
      ...(repeat.extension ?? []),
      timingOffsetExtension(TIMING_OFFSET_MAX_EXTENSION_URL, schedule.offsetMax)
    ];
    hasRepeat = true;
  }
  if (schedule?.dayOfWeek?.length) {
    repeat.dayOfWeek = [...schedule.dayOfWeek];
    hasRepeat = true;
  }
  if (schedule?.when?.length) {
    repeat.when = [...schedule.when];
    hasRepeat = true;
  }
  if (schedule?.timeOfDay?.length) {
    repeat.timeOfDay = [...schedule.timeOfDay];
    hasRepeat = true;
  }
  if (schedule?.activityTiming?.length) {
    repeat.extension = [
      ...(repeat.extension ?? []),
      ...schedule.activityTiming.map((item) => buildActivityTimingExtension(item, options))
    ];
    hasRepeat = true;
  }
  if (schedule?.occurrenceCap) {
    repeat.extension = [
      ...(repeat.extension ?? []),
      buildOccurrenceCapExtension(schedule.occurrenceCap)
    ];
    hasRepeat = true;
  }

  if (schedule?.maxDosePerPeriod?.length) {
    dosage.maxDosePerPeriod = schedule.maxDosePerPeriod.map((maximum) => ({
      numerator: { value: maximum.amount, unit: maximum.unit },
      denominator: {
        value: maximum.period,
        unit: maximum.periodUnit,
        system: UCUM_SYSTEM,
        code: maximum.periodUnit
      }
    }));
  }

  normalizeClockFrequency(repeat);
  if (hasRepeat) {
    dosage.timing = {
      ...(dosage.timing ?? {}),
      repeat
    };
  }

  if (schedule?.timingCode) {
    dosage.timing = dosage.timing ?? {};
    const normalizedCode = schedule.timingCode.toUpperCase();
    // A CodeableConcept.text preserves supported local wording without
    // falsely attaching an HL7 standard identity to non-standard codes.
    dosage.timing.code = FHIR_GTS_TIMING_CODES.has(normalizedCode)
      ? { coding: [{ system: FHIR_GTS_TIMING_SYSTEM, code: normalizedCode }],
          text: schedule.timingCode }
      : { text: schedule.timingCode };
  }

  if (clause.dose?.range) {
    const doseRange = buildFhirDoseRange(clause.dose.range, clause.dose.unit);
    if (doseRange) {
      dosage.doseAndRate = [
        {
          doseRange
        }
      ];
    }
  } else if (clause.dose?.value !== undefined) {
    dosage.doseAndRate = [
      {
        doseQuantity: {
          value: clause.dose.value,
          unit: clause.dose.unit
        }
      }
    ];
  }

  // HPSG produces the dimensional meaning; FHIR simply lowers that typed
  // value. Safety checks must never reparse and overwrite clinical dosage.
  if (clause.clinicalQuantity)
    projectHpsgClinicalQuantityToFhir(dosage, clause.clinicalQuantity);

  if (clause.route?.code || clause.route?.text) {
    const routeCode = clause.route?.code;
    const coding = routeCode ? ROUTE_SNOMED[routeCode] : undefined;
    const text = clause.route?.text ?? (routeCode ? ROUTE_TEXT[routeCode] : undefined);

    if (coding) {
      dosage.route = {
        text,
        coding: [
          {
            system: SNOMED_SYSTEM,
            code: coding.code,
            display: coding.display
          }
        ]
      };
    } else if (text) {
      dosage.route = { text };
    }
  }

  if (clause.site?.text || clause.site?.coding?.code || clause.site?.spatialRelation ||
      clause.site?.restrictions?.length) {
    const siteCoding = selectCanonicalSiteCoding(clause.site, options);
    const siteTextElement = options?.includeTranslationExtensions
      ? buildTranslationPrimitiveElement(clause.site.i18n ?? siteCoding?.i18n)
      : undefined;
    const siteTargetCount =
      clause.site?.administrationTargetCount ??
      getBodySiteAdministrationTargetCount(clause.site);
    const inferredSiteTargetCount = getBodySiteAdministrationTargetCount({
      text: clause.site?.text,
      coding: siteCoding
        ? {
          code: siteCoding.code,
          display: siteCoding.display,
          system: siteCoding.system,
          i18n: siteCoding.i18n
        }
        : undefined
    });
    const siteTargetCountExtension =
      siteTargetCount !== undefined && siteTargetCount !== inferredSiteTargetCount
        ? buildBodySiteAdministrationTargetCountExtension(siteTargetCount)
        : undefined;
    const siteExtensions = [
      ...(buildBodySiteSpatialRelationExtensions(clause.site?.spatialRelation) ?? []),
      ...buildBodySiteRestrictionExtensions(clause.site?.restrictions),
      ...(siteTargetCountExtension ? [siteTargetCountExtension] : [])
    ];
    dosage.site = {
      text: clause.site?.text,
      ...(siteTextElement ? { _text: siteTextElement } : {}),
      coding: buildSiteCodingArray(siteCoding, options),
      extension: siteExtensions.length ? siteExtensions : undefined
    };
  }

  if (clause.method?.text || clause.method?._text || clause.method?.coding?.code) {
    dosage.method = {
      text: clause.method?.text,
      _text: clonePrimitiveElement(clause.method?._text),
      coding: clause.method?.coding?.code
        ? [
          {
            system: clause.method.coding.system ?? SNOMED_SYSTEM,
            code: clause.method.coding.code,
            display: clause.method.coding.display,
            _display: clonePrimitiveElement(clause.method.coding._display) ??
              buildTranslationPrimitiveElement(clause.method.coding.i18n)
          }
        ]
        : undefined
    };
  }

  const additionalInstructions: Array<{
    text: string;
    i18n?: Record<string, string>;
    coding?: { system?: string; code?: string; display?: string };
  }> = [];
  for (const instruction of clause.additionalInstructions ?? []) {
    const text = instruction.text?.trim();
    if (!text) continue;
    additionalInstructions.push({ text, i18n: instruction.i18n, coding: instruction.coding });
  }
  for (const action of clause.instructionGraph?.actions ?? []) {
    if (action.polarity !== AdvicePolarity.Negate) continue;
    const text = action.sourceText.trim();
    if (!text) continue;
    const normalized = text.toLowerCase().replace(/[\s,;:.()]+/g, " ").trim();
    const alreadyRepresented = additionalInstructions.some((instruction) => {
      const candidate = instruction.text.toLowerCase().replace(/[\s,;:.()]+/g, " ").trim();
      return candidate === normalized || candidate.includes(normalized) || normalized.includes(candidate);
    });
    if (!alreadyRepresented) additionalInstructions.push({ text, coding: undefined });
  }
  if (additionalInstructions.length) {
    dosage.additionalInstruction = [];
    for (const instruction of additionalInstructions) {
      const textElement = options?.includeTranslationExtensions
        ? buildTranslationPrimitiveElement(instruction.i18n)
        : undefined;
      dosage.additionalInstruction.push({
        text: instruction.text,
        ...(textElement ? { _text: textElement } : {}),
        coding: instruction.coding?.code
          ? [
            {
              system: instruction.coding.system ?? SNOMED_SYSTEM,
              code: instruction.coding.code,
              display: instruction.coding.display
            }
          ]
          : undefined
      });
    }
  }

  if (clause.prn?.enabled) {
    dosage.asNeeded = true;
    const reasons = clause.prn.reasons?.length ? clause.prn.reasons : clause.prn.reason ? [clause.prn.reason] : [];
    if (reasons.length) {
      dosage.asNeededFor = [];
      for (const reason of reasons) {
        const concept: FhirCodeableConcept = {};
        if (reason.text) {
          concept.text = reason.text;
        }
        const reasonTextElement = options?.includeTranslationExtensions
          ? buildTranslationPrimitiveElement(reason.i18n ?? reason.coding?.i18n)
          : undefined;
        if (reasonTextElement) {
          concept._text = reasonTextElement;
        }
        if (reason.coding?.code) {
          const displayElement =
            options?.includeTranslationExtensions
              ? mergeTranslationPrimitiveElement(
                reason.coding._display,
                reason.coding.i18n
              )
              : clonePrimitiveElement(reason.coding._display);
          concept.coding = [
            {
              system: reason.coding.system ?? SNOMED_SYSTEM,
              code: reason.coding.code,
              display: reason.coding.display,
              ...(displayElement ? { _display: displayElement } : {}),
              extension: cloneExtensions(reason.coding.extension)
            }
          ];
        }
        const triggerExtension = prnTriggerPhaseExtension(reason.triggerPhase);
        const reasonExtensions = [
          ...(buildBodySiteSpatialRelationExtensions(reason.spatialRelation) ?? []),
          ...(triggerExtension ? [triggerExtension] : [])
        ];
        concept.extension = reasonExtensions.length ? reasonExtensions : undefined;
        dosage.asNeededFor.push(concept);
      }
    }
  }

  // The HPSG clinical scope is already resolved in CanonicalSigClause.
  // FHIR projects it exactly once; it must never decide which daughter
  // receives an administration condition or calendar exclusion.
  const adjunct = clause.clinicalAdjuncts;
  if (adjunct?.condition) setDosageCondition(dosage, adjunct.condition);
  if (adjunct?.excludedDates?.length) {
    setDosageExcludedDates(dosage, adjunct.excludedDates);
  }
  if (adjunct?.excludedWeekdays?.length) {
    setDosageExcludedWeekdays(dosage, adjunct.excludedWeekdays);
  }

  const longText = textOverride ?? formatCanonicalClause(clause, "long");
  if (longText) {
    dosage.text = longText;
  }
  if (clause.patientInstruction) {
    dosage.patientInstruction = clause.patientInstruction;
  }

  return dosage;
}

export function toFhir(state: ParserState): FhirDosage {
  const clauses = state.clauses;
  const clause = clauses[0] ?? createEmptyCanonicalClause(state.input);
  return canonicalToFhir(clause);
}

/** Recover local FHIR Timing.code.text only when it is a recognizable
 * abbreviation, not arbitrary prose. Coding identities always take priority.
 */
const TIMING_ABBREVIATION_TEXT = /^(?:C|BID|TID|QID|QD|QOD|AM|PM|BED|WK|MO|Q\d+(?:MIN|H|HR|D|WK|W|MO|Y))$/iu;
function timingCodeFromFhir(dosage: FhirDosage): string | undefined {
  const coding = dosage.timing?.code?.coding?.find(value => value.code)?.code;
  if (coding) return coding;
  const raw = dosage.timing?.code?.text?.trim();
  return raw && TIMING_ABBREVIATION_TEXT.test(raw) ? raw.toUpperCase() : undefined;
}

export function canonicalFromFhir(dosage: FhirDosage): CanonicalSigClause {
  const rawText = dosage.text ?? "";
  const clause = createEmptyCanonicalClause(rawText);
  clause.instructionGraph = parseInstructionGraphExtension(dosage.extension);
  let routeCode: RouteCode | undefined;

  const routeCoding = dosage.route?.coding?.find((code) => code.system === SNOMED_SYSTEM);
  if (routeCoding?.code) {
    routeCode = ROUTE_BY_SNOMED[routeCoding.code as SNOMEDCTRouteCodes];
  }
  if (routeCode || dosage.route?.text) {
    clause.route = {
      code: routeCode,
      text: dosage.route?.text ?? (routeCode ? ROUTE_TEXT[routeCode] : undefined)
    };
  }

  const siteCoding = selectPreferredSiteCoding(dosage.site);
  const siteSpatialRelation = parseBodySiteSpatialRelationExtension(dosage.site);
  const siteRestrictions = parseBodySiteRestrictionExtensions(dosage.site);
  const siteText = getFallbackSiteText(dosage.site);
  const siteI18n = codeableConceptTranslationI18n(dosage.site, siteCoding);
  const siteAdministrationTargetCount = getBodySiteAdministrationTargetCount(dosage.site);
  if (
    siteText ||
    siteCoding?.code ||
    siteSpatialRelation ||
    siteRestrictions?.length ||
    siteAdministrationTargetCount !== undefined
  ) {
    clause.site = {
      text: siteText,
      i18n: siteI18n.text,
      spatialRelation: siteSpatialRelation,
      restrictions: siteRestrictions,
      administrationTargetCount: siteAdministrationTargetCount,
      coding: siteCoding?.code
        ? {
          code: siteCoding.code,
          display: siteCoding.display,
          system: siteCoding.system,
          i18n: siteI18n.display
        }
        : undefined,
      source: "text"
    };
  }

  const methodCoding = selectFirstCodingWithCode(dosage.method);
  if (dosage.method?.text || dosage.method?._text || methodCoding?.code) {
    clause.method = {
      text: dosage.method?.text,
      _text: clonePrimitiveElement(dosage.method?._text),
      coding: methodCoding?.code
        ? {
          code: methodCoding.code,
          display: methodCoding.display,
          system: methodCoding.system,
          _display: clonePrimitiveElement(methodCoding._display),
          i18n: getPrimitiveTranslations(methodCoding._display)
        }
        : undefined
    };
  }

  const repeat = dosage.timing?.repeat;
  const timingCode = timingCodeFromFhir(dosage);
  const frequencyMinExtension = repeat?.extension?.find(
    (extension) => extension.url === TIMING_FREQUENCY_MIN_EXTENSION_URL
  )?.valueInteger;
  const offsetExactExtension = timingOffsetExtensionValue(
    repeat,
    TIMING_OFFSET_EXACT_EXTENSION_URL
  );
  const offsetMinExtension = timingOffsetExtensionValue(repeat, TIMING_OFFSET_MIN_EXTENSION_URL);
  const offsetMaxExtension = timingOffsetExtensionValue(repeat, TIMING_OFFSET_MAX_EXTENSION_URL);
  const timingBounds = extractCanonicalTimingBounds(repeat);
  const activityTiming = parseActivityTimingExtensions(repeat);
  const occurrenceCap = getTimingOccurrenceCap(repeat);
  const maxDosePerPeriod = canonicalDosePeriodMaximums(dosage);
  if (
    timingCode ||
    repeat?.count !== undefined ||
    repeat?.countMax !== undefined ||
    activityTiming?.length ||
    occurrenceCap !== undefined ||
    maxDosePerPeriod?.length ||
    repeat?.boundsDuration ||
    repeat?.boundsPeriod?.start ||
    repeat?.boundsPeriod?.end ||
    repeat?.boundsRange ||
    repeat?.duration !== undefined ||
    repeat?.durationMax !== undefined ||
    repeat?.durationUnit !== undefined ||
    repeat?.frequency !== undefined ||
    frequencyMinExtension !== undefined ||
    repeat?.frequencyMax !== undefined ||
    repeat?.period !== undefined ||
    repeat?.periodMax !== undefined ||
    repeat?.periodUnit ||
    repeat?.offset !== undefined ||
    offsetExactExtension !== undefined ||
    offsetMinExtension !== undefined ||
    offsetMaxExtension !== undefined ||
    repeat?.dayOfWeek?.length ||
    repeat?.when?.length ||
    repeat?.timeOfDay?.length ||
    dosage.timing?.event?.length
  ) {
    clause.schedule = {
      administrationOffsetMinutes: getAdministrationOffsetMinutes(dosage),
      timingCode,
      count: repeat?.count,
      countMax: repeat?.countMax,
      duration: timingBounds.duration,
      durationMax: timingBounds.durationMax,
      durationUnit: timingBounds.durationUnit,
      boundsStart: repeat?.boundsPeriod?.start,
      boundsEnd: repeat?.boundsPeriod?.end,
      administrationDuration: repeat?.duration,
      administrationDurationMax: repeat?.durationMax,
      administrationDurationUnit: repeat?.durationUnit,
      frequency: repeat?.frequency ?? frequencyMinExtension,
      frequencyMax: repeat?.frequencyMax,
      period: repeat?.period,
      periodMax: repeat?.periodMax,
      periodUnit: repeat?.periodUnit,
      offset: repeat?.offset ?? offsetExactExtension,
      offsetMin: offsetMinExtension,
      offsetMax: offsetMaxExtension,
      activityTiming,
      occurrenceCap,
      maxDosePerPeriod,
      dayOfWeek: repeat?.dayOfWeek ? [...repeat.dayOfWeek] : undefined,
      when: repeat?.when ? [...repeat.when] : undefined,
      timeOfDay: repeat?.timeOfDay ? [...repeat.timeOfDay] : undefined,
      calendarEvents: dosage.timing?.event
        ?.map((value, index) => calendarEventFromFhir(value, dosage.timing?._event?.[index]))
        .filter((event): event is CanonicalCalendarEventExpr => Boolean(event))
    };
    clause.warnings = appendWarning(clause.warnings, timingBounds.warning);
  }

  const doseAndRate = dosage.doseAndRate?.[0];
  if (doseAndRate?.doseRange) {
    const extracted = extractCanonicalDoseRange(doseAndRate.doseRange);
    if (extracted.range) {
      clause.dose = {
        range: extracted.range,
        unit: extracted.unit
      };
      clause.warnings = appendWarning(clause.warnings, extracted.warning);
    }
  } else if (doseAndRate?.doseQuantity?.value !== undefined) {
    clause.dose = {
      value: doseAndRate.doseQuantity.value,
      unit: doseAndRate.doseQuantity.unit
    };
  }

  const carrierQuantity = clinicalCarrierQuantityFromFhir(dosage);
  if (carrierQuantity) clause.clinicalQuantity = carrierQuantity;

  const prnReasons = dosage.asNeededFor?.length
    ? dosage.asNeededFor.map((concept) => {
      const coding = concept.coding?.find((code) => Boolean(code.code));
      const defaultDef = coding?.code
        ? findPrnReasonDefinitionByCoding(coding.system ?? SNOMED_SYSTEM, coding.code)
        : undefined;
      const i18n = codeableConceptTranslationI18n(concept, coding, defaultDef?.i18n);
      return {
        text: getFallbackPrnReasonText(concept),
        i18n: i18n.text,
        spatialRelation: parseBodySiteSpatialRelationExtension(concept),
        triggerPhase: parsePrnTriggerPhase(concept),
        coding: coding?.code
          ? {
            code: coding.code,
            display: coding.display,
            system: coding.system,
            extension: cloneExtensions(coding.extension),
            _display: clonePrimitiveElement(coding._display),
            i18n: i18n.display
          }
          : undefined
      };
    })
    : undefined;
  const primaryReason = prnReasons?.[0];
  const asNeeded = dosage.asNeeded ??
    (dosage as FhirDosage & { asNeededBoolean?: boolean }).asNeededBoolean;
  if (asNeeded || primaryReason?.text || primaryReason?.coding?.code) {
    clause.prn = {
      enabled: Boolean(asNeeded || primaryReason?.text || primaryReason?.coding?.code),
      reason:
        prnReasons?.length === 1
          ? primaryReason
          : prnReasons?.length
            ? { text: joinCanonicalPrnReasonTexts(prnReasons) }
            : undefined,
      reasons: prnReasons?.length ? prnReasons : undefined
    };
  }

  if (dosage.additionalInstruction?.length) {
    clause.additionalInstructions = [];
    for (const instruction of dosage.additionalInstruction) {
      const coding = instruction.coding?.find((code) => Boolean(code.code));
      clause.additionalInstructions.push({
        text: instruction.text,
        i18n: codeableConceptTranslationI18n(instruction, coding).text,
        coding: coding?.code
          ? {
            code: coding.code,
            display: coding.display,
            system: coding.system
          }
          : undefined,
        frames: coding?.code
          ? buildAdditionalInstructionFramesFromCoding(
            coding.system ?? SNOMED_SYSTEM,
            coding.code,
            instruction.text ?? coding.display ?? "",
            clause.raw
          )
          : undefined
      });
    }
  }

  if (dosage.patientInstruction) {
    clause.patientInstruction = dosage.patientInstruction;
  }

  return clause;
}

export function parserStateFromFhir(dosage: FhirDosage): ParserState {
  const state = new ParserState(dosage.text ?? "", []);
  const timingBounds = extractCanonicalTimingBounds(dosage.timing?.repeat);
  state.timeOfDay = dosage.timing?.repeat?.timeOfDay
    ? [...dosage.timing.repeat.timeOfDay]
    : [];
  if (dosage.timing?.event?.length) {
    state.primaryClause.schedule = {
      ...(state.primaryClause.schedule ?? {}),
      calendarEvents: dosage.timing.event
        .map((value, index) => calendarEventFromFhir(value, dosage.timing?._event?.[index]))
        .filter((event): event is CanonicalCalendarEventExpr => Boolean(event))
    };
  }
  state.timingCode = timingCodeFromFhir(dosage);
  state.count = dosage.timing?.repeat?.count;
  state.countMax = dosage.timing?.repeat?.countMax;
  state.duration = timingBounds.duration;
  state.durationMax = timingBounds.durationMax;
  state.durationUnit = timingBounds.durationUnit;
  if (dosage.timing?.repeat?.boundsPeriod?.start || dosage.timing?.repeat?.boundsPeriod?.end) {
    state.primaryClause.schedule = {
      ...(state.primaryClause.schedule ?? {}),
      boundsStart: dosage.timing.repeat.boundsPeriod.start,
      boundsEnd: dosage.timing.repeat.boundsPeriod.end
    };
  }
  if (dosage.timing?.repeat?.duration !== undefined && dosage.timing.repeat.durationUnit) {
    state.primaryClause.schedule = {
      ...(state.primaryClause.schedule ?? {}),
      administrationDuration: dosage.timing.repeat.duration,
      administrationDurationMax: dosage.timing.repeat.durationMax,
      administrationDurationUnit: dosage.timing.repeat.durationUnit
    };
  }
  state.frequency = dosage.timing?.repeat?.frequency;
  state.frequencyMax = dosage.timing?.repeat?.frequencyMax;
  state.period = dosage.timing?.repeat?.period;
  state.periodMax = dosage.timing?.repeat?.periodMax;
  state.periodUnit = dosage.timing?.repeat?.periodUnit;
  state.offset = getExactTimingOffsetMinutes(dosage.timing?.repeat);
  state.offsetMin = timingOffsetExtensionValue(dosage.timing?.repeat, TIMING_OFFSET_MIN_EXTENSION_URL);
  state.offsetMax = timingOffsetExtensionValue(dosage.timing?.repeat, TIMING_OFFSET_MAX_EXTENSION_URL);
  state.activityTiming = parseActivityTimingExtensions(dosage.timing?.repeat);
  state.occurrenceCap = getTimingOccurrenceCap(dosage.timing?.repeat);
  state.maxDosePerPeriod = canonicalDosePeriodMaximums(dosage);
  state.routeText = dosage.route?.text;
  const siteCoding = selectPreferredSiteCoding(dosage.site);
  state.siteText = getFallbackSiteText(dosage.site);
  state.siteSpatialRelation = parseBodySiteSpatialRelationExtension(dosage.site);
  state.siteAdministrationTargetCount = getBodySiteAdministrationTargetCount(dosage.site);
  state.methodText = dosage.method?.text;
  state.methodTextElement = clonePrimitiveElement(dosage.method?._text);
  state.patientInstruction = dosage.patientInstruction;
  state.asNeeded = dosage.asNeeded ??
    (dosage as FhirDosage & { asNeededBoolean?: boolean }).asNeededBoolean;
  if (dosage.asNeededFor?.length) {
    const prnReasons = dosage.asNeededFor.map((concept) => {
      const coding = selectFirstCodingWithCode(concept);
      const defaultDef = coding?.code
        ? findPrnReasonDefinitionByCoding(coding.system ?? SNOMED_SYSTEM, coding.code)
        : undefined;
      const i18n = codeableConceptTranslationI18n(concept, coding, defaultDef?.i18n);
      return {
        text: getFallbackPrnReasonText(concept),
        i18n: i18n.text,
        spatialRelation: parseBodySiteSpatialRelationExtension(concept),
        triggerPhase: parsePrnTriggerPhase(concept),
        coding: coding?.code
          ? {
            code: coding.code,
            display: coding.display,
            system: coding.system,
            extension: cloneExtensions(coding.extension),
            _display: clonePrimitiveElement(coding._display),
            i18n: i18n.display
          }
          : undefined
      };
    });
    state.asNeededReasons = prnReasons;
    state.asNeededReason = joinCanonicalPrnReasonTexts(prnReasons);
    state.asNeededReasonTriggerPhase = prnReasons[0]?.triggerPhase;
  }

  if (dosage.timing?.repeat?.dayOfWeek) {
    state.dayOfWeek.push(...dosage.timing.repeat.dayOfWeek);
  }
  if (dosage.timing?.repeat?.when) {
    const whenValues = dosage.timing.repeat.when.filter((value): value is EventTiming =>
      arrayIncludes(
        objectValues(EventTiming) as EventTiming[],
        value as EventTiming
      )
    );
    state.when.push(...whenValues);
  }

  const routeCoding = dosage.route?.coding?.find((code) => code.system === SNOMED_SYSTEM);
  if (routeCoding?.code) {
    // Translate SNOMED codings back into the simplified enum for round-trip fidelity.
    const mapped = ROUTE_BY_SNOMED[routeCoding.code as SNOMEDCTRouteCodes];
    if (mapped) {
      state.routeCode = mapped;
      state.routeText = ROUTE_TEXT[mapped];
    }
  }

  if (siteCoding?.code) {
    const siteI18n = codeableConceptTranslationI18n(dosage.site, siteCoding);
    state.siteCoding = {
      code: siteCoding.code,
      display: siteCoding.display,
      system: siteCoding.system,
      i18n: siteI18n.display
    };
    if (siteI18n.text) {
      state.primaryClause.site = {
        ...state.primaryClause.site,
        i18n: siteI18n.text
      };
    }
    state.siteSource = "text";
  } else if (dosage.site?.text) {
    state.siteSource = "text";
  }

  const methodCoding = selectFirstCodingWithCode(dosage.method);
  if (methodCoding?.code) {
    state.methodCoding = {
      code: methodCoding.code,
      display: methodCoding.display,
      system: methodCoding.system,
      _display: clonePrimitiveElement(methodCoding._display),
      i18n: getPrimitiveTranslations(methodCoding._display)
    };
  }

  if (dosage.asNeededFor?.length === 1) {
    const reasonCoding = selectFirstCodingWithCode(dosage.asNeededFor[0]);
    if (reasonCoding?.code) {
      const defaultDef = findPrnReasonDefinitionByCoding(
        reasonCoding.system ?? SNOMED_SYSTEM,
        reasonCoding.code
      );
      const i18n = codeableConceptTranslationI18n(
        dosage.asNeededFor[0],
        reasonCoding,
        defaultDef?.i18n
      );
      state.asNeededReasonCoding = {
        code: reasonCoding.code,
        display: reasonCoding.display,
        system: reasonCoding.system,
        extension: cloneExtensions(reasonCoding.extension),
        _display: clonePrimitiveElement(reasonCoding._display),
        i18n: i18n.display
      };
      if (i18n.text && state.primaryClause.prn?.reason) {
        state.primaryClause.prn.reason = {
          ...state.primaryClause.prn.reason,
          i18n: i18n.text
        };
      }
    }
  }

  if (dosage.additionalInstruction?.length) {
    state.additionalInstructions = dosage.additionalInstruction.map((concept) => {
      const coding = selectFirstCodingWithCode(concept);
      const defaultDef = coding?.code
        ? findAdditionalInstructionDefinitionByCoding(
          coding.system ?? SNOMED_SYSTEM,
          coding.code
        )
        : undefined;

      return {
        text: concept.text,
        coding: coding?.code
          ? {
            code: coding.code,
            display: coding.display,
            system: coding.system,
            i18n: defaultDef?.i18n
          }
          : undefined,
        frames: coding?.code
          ? buildAdditionalInstructionFramesFromCoding(
            coding.system ?? SNOMED_SYSTEM,
            coding.code,
            concept.text ?? coding.display ?? "",
            { start: 0, end: (concept.text ?? coding.display ?? "").length }
          )
          : undefined
      };
    });
  }

  if (timingBounds.warning) {
    const nextWarnings = appendWarning(state.warnings, timingBounds.warning);
    if (nextWarnings) {
      state.warnings = nextWarnings;
    }
  }


  const doseAndRate = dosage.doseAndRate?.[0];
  if (doseAndRate?.doseRange) {
    const extracted = extractCanonicalDoseRange(doseAndRate.doseRange);
    if (extracted.range) {
      state.primaryClause.dose = {
        range: extracted.range,
        unit: extracted.unit
      };
      state.warnings = appendWarning(state.warnings, extracted.warning) ?? state.warnings;
    }
  } else if (doseAndRate?.doseQuantity) {
    const dose = doseAndRate.doseQuantity;
    if (dose.value !== undefined) {
      state.dose = dose.value;
    }
    if (dose.unit) {
      state.unit = dose.unit;
    }
  }

  const carrierQuantity = clinicalCarrierQuantityFromFhir(dosage);
  if (carrierQuantity) state.primaryClause.clinicalQuantity = carrierQuantity;

  return state;
}

/**
 * Lower a resolved, typed HPSG quantity without consulting source text. This
 * remains part of the ordinary canonical-to-FHIR lowering, not a second parser.
 * @param dosage FHIR output currently being assembled.
 * @param quantity Resolved typed clinical quantity.
 */
function projectHpsgClinicalQuantityToFhir(
  dosage: FhirDosage,
  quantity: HpsgClinicalQuantityFeature
): void {
  if (quantity.status !== "resolved") {
    // Preserve a recognized daily total even when no per-administration split
    // was stated. It is a rate, not an invented dose, and remains editable.
    if (quantity.dailyTotal && quantity.denominators.some(term => term.dimension === "time")) {
      const unit = [quantity.numerator.unit, ...quantity.denominators.map(term => term.unit)].join("/");
      dosage.doseAndRate = [{
        rateQuantity: {
          value: quantity.numerator.value,
          unit,
          system: "http://unitsofmeasure.org",
          code: unit
        }
      }];
    }
    return;
  }
  if (quantity.representation === "dose") {
    const dose = dosage.doseAndRate?.[0]?.doseQuantity;
    if (dose && quantity.projectedDose) {
      dose.system = "http://unitsofmeasure.org";
      dose.code = quantity.projectedDose.unit;
    }
    return;
  }
  if (quantity.representation === "rate-quantity") {
    const unit = [quantity.numerator.unit, ...quantity.denominators.map((term) => term.unit)].join("/");
    dosage.doseAndRate = [{
      ...(quantity.projectedDose ? {
        doseQuantity: { ...quantity.projectedDose, system: "http://unitsofmeasure.org", code: quantity.projectedDose.unit }
      } : {}),
      rateQuantity: {
        value: quantity.numerator.value / quantity.denominators.reduce((scale, term) => scale * term.value, 1),
        unit,
        system: "http://unitsofmeasure.org",
        code: unit
      }
    }];
    return;
  }
  const duration = quantity.administrationDuration;
  const dose = quantity.projectedDose;
  if (!duration || !dose) return;
  const doseQuantity = {
    value: dose.value,
    unit: dose.unit,
    system: "http://unitsofmeasure.org",
    code: dose.unit
  };
  const rate = quantity.rateNumerator ?? dose;
  const rateNumerator = {
    value: rate.value,
    unit: rate.unit,
    system: "http://unitsofmeasure.org",
    code: rate.unit
  };
  dosage.doseAndRate = [{
    doseQuantity,
    rateRatio: {
      numerator: rateNumerator,
      denominator: {
        value: duration.value,
        unit: duration.unit,
        system: "http://unitsofmeasure.org",
        code: duration.unit
      }
    }
  }];
  if (quantity.carrierMaterial?.text) {
    dosage.extension = [
      ...(dosage.extension ?? []).filter(part =>
        part.url !== INFUSION_CARRIER_MATERIAL_EXTENSION_URL),
      infusionCarrierMaterialExtension(quantity.carrierMaterial)
    ];
  }
}
