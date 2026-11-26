import { THAI_DAY_NAMES, joinLocalizedList } from "./locales/course/types";
import type { CourseLanguage } from "./locales/course/types";
import { ENGLISH_COURSE } from "./locales/course/en";
import { THAI_COURSE } from "./locales/course/th";
export type { CourseLanguage } from "./locales/course/types";
import { localizedValue, quantityComparatorText } from "./localization";
import {
  hasDailyRecurrenceAcrossClocks, formatDoseEnglish, timingCodeMatchesRecurrence,
  timingEventPreviewSchedule, independentTimingText, doseUnitUsesTargetScope,
  formatDurationShort as formatDurationShortThai, alternateDayEvent, standaloneOccurrenceCount,
  describeDuration, describeAdministrationDuration, type DurationWording,
  appendLongAdministrationTiming,
  richGraphAdministrationTail,
  instructionGraphMatchesDose,
  normalizeInstructionText,
  collectGraphInstructionOwnership,
  instructionGraphAdviceSourceTexts,
  instructionGraphAdministrationFlow,
  instructionGraphActionHasSequenceSuccessor,
  instructionGraphCanStandAlone,
  isEmptyStomachInstruction,
  stripTrailingZero
} from "./format";
import { findAdditionalInstructionDefinitionByCoding, parseAdditionalInstructions, realizeAdviceFramesText } from "./advice";
import { TH_POSITIVE_MODALITY_PREFIX } from "./instruction-action-locale-adapter";
import { resolveBodySitePhrase, realizeBodySiteRestriction, type BodySiteQualifierFeatures } from "./body-site-grammar";
import { getPrimitiveTranslation } from "./fhir-translations";
import {
  getUniqueAdviceRelationByGrammarFeature,
  getBodySiteRelationRealization,
  localizeAdviceRelation,
  relationHasGrammarFeature,
  relationHasSemanticClass,
  resolveActionRelationSurface
} from "./relation-terminology";
import { canonicalClauseHasAdministrationSemantics } from "./ir";
import {
  medicationInstructionActionLocaleRealizerConfig,
  getMedicationInstructionAction,
  resolveMedicationInstructionAction
} from "./instruction-action-terminology";
import { getMedicationInstructionConcept, resolveMedicationInstructionConcept } from "./instruction-concept-terminology";
import {
  collectLocalizedWhenPhrases,
  combineLocalizedFrequencyAndEvents,
  type LocalizedTimingGrammar
} from "./localized-timing";
import {
  DEFAULT_BODY_SITE_SNOMED_SOURCE,
  findPrnReasonDefinitionByCoding,
  normalizeBodySiteKey,
  WORD_FREQUENCIES
} from "./maps";
import { getLocalizedCanonicalPrnReasonText, getPreferredCanonicalPrnReasonText } from "./prn";
import { resolveSymptomDefinition } from "./symptom-terminology";
import {
  ACTION_COORDINATION_CONNECTORS,
  ACTION_COORDINATION_CONNECTOR_I18N,
  ADMINISTRATION_WINDOW_INSTRUCTIONS,
  BODY_SITE_ATTRIBUTIVE_MODIFIER_I18N,
  BODY_SITE_ATTRIBUTIVE_MODIFIERS,
  BODY_SITE_BARE_NOMINAL_PREFIX_I18N,
  BODY_SITE_BARE_NOMINAL_PREFIXES,
} from "./hpsg/lexical-classes";
import {
  instructionGraphPrimaryAdministrationModality,
  instructionGraphRichPrimaryAction,
  realizeRichPrimaryWithCanonicalDose,
  instructionGraphSourceConflictsWithDose,
  instructionGraphPreparationOwnsDose,
  instructionGraphRoundTripPrimaryAction,
  instructionGraphFullyOwnsAdvice,
  instructionGraphRepresentsText,
  instructionGraphSingleActionRepresentsText,
  realizeInstructionAction,
  realizeInstructionGraph,
  attachInstructionGraphPrimaryConditions,
  type InstructionGraphPrimaryCondition
} from "./instruction-graph";
import {
  AdviceArgumentRole,
  type AdviceFrame,
  AdviceForce,
  AdvicePolarity,
  AdviceRelation,
  BodySiteSpatialRelation,
  BodySiteDefinition,
  CanonicalDoseExpr,
  CanonicalPrnReasonExpr,
  CanonicalScheduleExpr,
  CanonicalSigClause,
  type MedicationInstructionActionDefinition,
  type MedicationCondition,
  EventTiming,
  FhirPeriodUnit,
  RouteCode
} from "./types";
import {
  getMealTimingGroup,
  intervalTimingPreviewDescriptor,
  timingPreviewDescriptor,
  isCompactIntervalTimingCode,
  inferDailyOccurrenceCount,
  type MealTimingGroup,
  type TimingSummaryOptions
} from "./timing-summary";

function medicationConditionBody(condition: MedicationCondition, words: CourseLanguage): string {
  switch (condition.kind) {
    case "measurement": {
      // Live typed predicate values own the generated instruction. Its
      // authored text remains source data and may describe an older value.
      const operator = { gt: ">", ge: ">=", lt: "<", le: "<=", eq: "=", ne: "!=" }[condition.operation];
      return (
        words.measurementName(condition.name) + " " + operator + " " + condition.value + (condition.unit ? " " + condition.unit : "")
      );
    }
    case "state": {
      return condition.expected ? condition.name : words.notPrefix + condition.name;
    }
    case "text":
      return condition.text;
    case "not":
      return words.notPrefix + "(" + medicationConditionBody(condition.condition, words) + ")";
    case "all":
    case "any": {
      let result = "";
      const separator = condition.kind === "all" ? words.allSeparator : words.anySeparator;
      for (const value of condition.conditions) {
        const body = medicationConditionBody(value, words);
        // Preserve Boolean grouping. Only the outer NOT licenses 'unless'.
        const grouped = (value.kind === "all" || value.kind === "any") && value.kind !== condition.kind;
        if (result) result += separator;
        result += grouped ? "(" + body + ")" : body;
      }
      return result;
    }
  }
}
/** Compose the existing typed guard with its selected administration text. */
export function appendClinicalConditionText(text: string, condition: MedicationCondition, words: CourseLanguage): string {
  const negated = condition.kind === "not";
  const body = medicationConditionBody(negated ? condition.condition : condition, words);
  const trimmed = text.trim().replace(/[.!?]+$/u, "");
  return (trimmed ? trimmed + " " : "") + (negated ? words.unless : words.onlyIf) + " " + body + ".";
}

/** Custom callbacks retain the existing outer guard fallback. */
export function canFormatConditionInPrimary(localization?: SigLocalization): boolean {
  return !localization?.formatLong || isBuiltinSigFormatter(localization.formatLong);
}

export interface SigFormatContext {
  readonly style: "short" | "long";
  readonly clause: CanonicalSigClause;
  readonly defaultText: string;
  readonly course?: CourseLanguage;
  readonly groupMealTimingsByRelation: boolean;
  readonly includeTimesPerDaySummary: boolean;
  readonly realizationMode: "normalized" | "roundtrip";
  readonly sitePlacement: "natural" | "trailing";
  readonly instructionActionMap?: TimingSummaryOptions["instructionActionMap"];
  readonly resolvedMethod?: MedicationInstructionActionDefinition;
  formatDefault(style: "short" | "long"): string;
}

export interface SigShortContext extends SigFormatContext {
  readonly style: "short";
}

export interface SigLongContext extends SigFormatContext {
  readonly style: "long";
}

/** Dose amount scope is independent of whether the compact clause has one
 * scalar dose. Native multi/role-bearing amounts retain this target scope. */
export interface SigDoseScope {
  targetCount: number;
  site?: BodySiteDefinition;
}

export interface SigLocalization {
  readonly locale: string;
  /** Optional language-pack facet for whole-course text. Clinical facts stay
   * in canonical code; adding a language never edits the course algorithm. */
  readonly course?: CourseLanguage;
  formatDose?(dose: CanonicalDoseExpr | string, style: "short" | "long", scope?: SigDoseScope): string | undefined;
  formatShort?(context: SigShortContext): string;
  formatLong?(context: SigLongContext): string;
}

export interface SigLocalizationConfig
  extends Partial<Omit<SigLocalization, "locale">> {
  locale?: string;
  inherit?: string;
}

const THAI_ADMINISTRATION_WINDOW_TRANSLATIONS = new Map(
  ADMINISTRATION_WINDOW_INSTRUCTIONS
    .filter((entry) => entry.i18n?.th)
    .map((entry) => [entry.text.toLowerCase().trim(), entry.i18n!.th!] as const)
);

type SigFormatter = NonNullable<SigLocalization["formatShort"] | SigLocalization["formatLong"]>;
const BUILTIN_SIG_FORMATTERS = new WeakSet<SigFormatter>();

/** Bundled formatters own the built-in clinical condition placement. */
export function isBuiltinSigFormatter(formatter: SigFormatter): boolean {
  return BUILTIN_SIG_FORMATTERS.has(formatter);
}

function registerBuiltinSigLocalization(localization: SigLocalization): void {
  if (localization.formatShort) BUILTIN_SIG_FORMATTERS.add(localization.formatShort);
  if (localization.formatLong) BUILTIN_SIG_FORMATTERS.add(localization.formatLong);
  registerSigLocalization(localization);
}

const REGISTERED_LOCALIZATIONS = new Map<string, SigLocalization>();
// An inherited regional view is valid while BOTH its exact registration and
// base registration still have the same identity. No invalidation walk or
// generation increment is required for an ordinary locale registration.
const RESOLVED_REGIONAL_LOCALIZATIONS = new Map<string, {
  exact: SigLocalization;
  base: SigLocalization;
  localization: SigLocalization;
}>();

export function registerSigLocalization(localization: SigLocalization): void {
  REGISTERED_LOCALIZATIONS.set(localization.locale.toLowerCase(), localization);
}

export function getRegisteredSigLocalizations(): SigLocalization[] {
  return Array.from(REGISTERED_LOCALIZATIONS.values());
}

/** Each regional facet overrides only its matching base-language facet.
 * Complete registrations keep their allocation-free common path; partial
 * regional compositions are refreshed lazily after explicit registration. */
function registeredLocalization(key: string | undefined): SigLocalization | undefined {
  if (!key) return undefined;
  const exact = REGISTERED_LOCALIZATIONS.get(key);
  if (exact?.formatShort && exact.formatLong && exact.course && exact.formatDose) return exact;
  const separator = key.indexOf("-");
  if (separator < 0) return exact;
  const base = REGISTERED_LOCALIZATIONS.get(key.slice(0, separator));
  if (!exact || !base) return exact ?? base;
  const cached = RESOLVED_REGIONAL_LOCALIZATIONS.get(key);
  if (cached?.exact === exact && cached.base === base) return cached.localization;
  const resolved: SigLocalization = {
    locale: exact.locale,
    formatDose: exact.formatDose ?? base.formatDose,
    formatShort: exact.formatShort ?? base.formatShort,
    formatLong: exact.formatLong ?? base.formatLong,
    course: exact.course ?? base.course,
  };
  RESOLVED_REGIONAL_LOCALIZATIONS.set(key, {
    exact,
    base,
    localization: resolved,
  });
  return resolved;
}

export function resolveSigLocalization(
  locale?: string,
  config?: SigLocalizationConfig
): SigLocalization | undefined {
  const normalizedLocale = config?.locale ?? locale;
  const targetKey = normalizedLocale?.toLowerCase();
  const base = registeredLocalization(targetKey);
  const inherited = config?.inherit
    ? registeredLocalization(config.inherit.toLowerCase())
    : undefined;
  // Registered localizations are immutable-by-contract. Returning the
  // established object needs no repeat allocation on every clause render.
  if (!config) return base;


  const resolvedLocale =
    config?.locale ??
    config?.inherit ??
    base?.locale ??
    inherited?.locale ??
    targetKey ??
    "custom";

  const result: SigLocalization = {
    locale: resolvedLocale,
    ...(config?.course ?? inherited?.course ?? base?.course
      ? {course:config?.course ?? inherited?.course ?? base?.course} : {})
  };

  result.formatDose = config.formatDose ?? inherited?.formatDose ?? base?.formatDose;
  result.formatShort = config.formatShort ?? inherited?.formatShort ?? base?.formatShort;
  result.formatLong = config.formatLong ?? inherited?.formatLong ?? base?.formatLong;

  if (!result.formatDose && !result.formatShort && !result.formatLong && !result.course) {
    return base ?? inherited ?? result;
  }

  return result;
}

registerBuiltinSigLocalization({
  locale: "en",
  course: ENGLISH_COURSE,
  formatDose: formatDoseEnglish,
  formatShort: ({ defaultText }) => defaultText,
  formatLong: ({ defaultText }) => defaultText
});

/** Resolve the course facet once at a public formatting boundary. Reuse the
 * existing registry and inheritance contract; no new pack registry or parser. */
export function resolveCourseLanguage(locale?: string, config?: SigLocalizationConfig,
  resolved?: SigLocalization): CourseLanguage {
  if (resolved?.course) return resolved.course;
  if (config?.course) return config.course;
  // Per-call inheritance overrides a registered base exactly as clause
  // callbacks do. The output locale tag is a label, not an inheritance veto.
  const inherited=config?.inherit?registeredLocalization(config.inherit.toLowerCase())?.course:undefined;
  if(inherited)return inherited;
  const key = (config?.locale ?? locale ?? "en").toLowerCase();
  return registeredLocalization(key)?.course ?? ENGLISH_COURSE;
}

export type SigTranslation = SigLocalization;
export type SigTranslationConfig = SigLocalizationConfig;

export const registerSigTranslation = registerSigLocalization;
export const getRegisteredSigTranslations = getRegisteredSigLocalizations;

export function resolveSigTranslation(
  locale?: string,
  config?: SigTranslationConfig
): SigTranslation | undefined {
  return resolveSigLocalization(locale, config);
}

function createThaiLocalization(): SigLocalization {
  return {
    locale: "th",
    course: THAI_COURSE,
    formatDose: (dose, style, scope) => {
      const amount = typeof dose === "string" ? dose : scope ? formatDoseThaiPerTarget(dose)
        : style === "short" ? formatDoseThaiShort(dose) : formatDoseThaiLong(dose);
      return amount && scope ? (scope.site?.perTargetI18n?.th ?? "แต่ละจุด") + " " + amount : amount;
    },
    formatShort: ({ clause, course, resolvedMethod }) => formatShortThai(clause, course, resolvedMethod),
    formatLong: ({
      clause,
      course,
      groupMealTimingsByRelation,
      includeTimesPerDaySummary,
      realizationMode,
      sitePlacement,
      instructionActionMap,
      resolvedMethod
    }) =>
      formatLongThai(clause, {
        groupMealTimingsByRelation,
        includeTimesPerDaySummary,
        realizationMode,
        sitePlacement,
        instructionActionMap
      }, course, resolvedMethod)
  };
}

registerBuiltinSigLocalization(createThaiLocalization());

// Thai formatting helpers
const ROUTE_SHORT: Partial<Record<RouteCode, string>> = {
  [RouteCode["Oral route"]]: "PO",
  [RouteCode["Sublingual route"]]: "SL",
  [RouteCode["Buccal route"]]: "BUC",
  [RouteCode["Respiratory tract route (qualifier value)"]]: "INH",
  [RouteCode["Nasal route"]]: "IN",
  [RouteCode["Topical route"]]: "TOP",
  [RouteCode["Transdermal route"]]: "TD",
  [RouteCode["Subcutaneous route"]]: "SC",
  [RouteCode["Intramuscular route"]]: "IM",
  [RouteCode["Intravenous route"]]: "IV",
  [RouteCode["Per rectum"]]: "PR",
  [RouteCode["Per vagina"]]: "PV",
  [RouteCode["Ophthalmic route"]]: "OPH",
  [RouteCode["Otic route"]]: "OT",
  [RouteCode["Intravitreal route (qualifier value)"]]: "IVT"
};

const WHEN_TEXT_THAI: Partial<Record<EventTiming, string>> = {
  [EventTiming["Before Sleep"]]: "ก่อนนอน",
  [EventTiming["Before Meal"]]: "ก่อนอาหาร",
  [EventTiming["Before Breakfast"]]: "ก่อนอาหารเช้า",
  [EventTiming["Before Lunch"]]: "ก่อนอาหารกลางวัน",
  [EventTiming["Before Dinner"]]: "ก่อนอาหารเย็น",
  [EventTiming["After Meal"]]: "หลังอาหาร",
  [EventTiming["After Breakfast"]]: "หลังอาหารเช้า",
  [EventTiming["After Lunch"]]: "หลังอาหารกลางวัน",
  [EventTiming["After Dinner"]]: "หลังอาหารเย็น",
  [EventTiming.Meal]: "พร้อมอาหาร",
  [EventTiming.Breakfast]: "พร้อมอาหารเช้า",
  [EventTiming.Lunch]: "พร้อมอาหารกลางวัน",
  [EventTiming.Dinner]: "พร้อมอาหารเย็น",
  [EventTiming.Morning]: "ตอนเช้า",
  [EventTiming["Early Morning"]]: "เช้าตรู่",
  [EventTiming["Late Morning"]]: "สาย",
  [EventTiming.Noon]: "ตอนเที่ยง",
  [EventTiming.Afternoon]: "ตอนบ่าย",
  [EventTiming["Early Afternoon"]]: "บ่ายต้น",
  [EventTiming["Late Afternoon"]]: "บ่ายแก่",
  [EventTiming.Evening]: "ตอนเย็น",
  [EventTiming["Early Evening"]]: "หัวค่ำ",
  [EventTiming["Late Evening"]]: "ดึก",
  [EventTiming.Night]: "ตอนกลางคืน",
  [EventTiming.Wake]: "หลังตื่นนอน",
  [EventTiming["After Sleep"]]: "หลังจากนอน",
  [EventTiming.Immediate]: "ทันที"
};

export const DAY_NAMES_THAI: Record<string, string> = THAI_DAY_NAMES;

const TH_TIMES_PER_DAY: Record<number, string> = {
  1: "วันละครั้ง",
  2: "วันละ 2 ครั้ง",
  3: "วันละ 3 ครั้ง",
  4: "วันละ 4 ครั้ง"
};

const SLOWLY_QUALIFIER_CODE = "419443000";

export const THAI_SITE_TRANSLATIONS: Record<string, string> = {
  eye: "ตา",
  eyes: "ตา",
  "right eye": "ตาขวา",
  "left eye": "ตาซ้าย",
  "both eyes": "ตาทั้งสองข้าง",
  "bilateral eyes": "ตาทั้งสองข้าง",
  "right ear": "หูขวา",
  "left ear": "หูซ้าย",
  "both ears": "หูทั้งสองข้าง",
  "bilateral ears": "หูทั้งสองข้าง",
  ear: "หู",
  ears: "หูทั้งสองข้าง",
  "ear canal": "ช่องหู",
  "both ear canals": "ช่องหูทั้งสองข้าง",
  "left ear canal": "ช่องหูซ้าย",
  "right ear canal": "ช่องหูขวา",
  nostril: "รูจมูก",
  nostrils: "รูจมูกทั้งสองข้าง",
  "right nostril": "รูจมูกขวา",
  "left nostril": "รูจมูกซ้าย",
  "both nostrils": "รูจมูกทั้งสองข้าง",
  "left naris": "รูจมูกซ้าย",
  "right naris": "รูจมูกขวา",
  nares: "รูจมูกทั้งสองข้าง",
  "anterior nares": "รูจมูกด้านหน้า",
  nose: "จมูก",
  mouth: "ปาก",
  tongue: "ลิ้น",
  tongues: "ลิ้น",
  "right arm": "แขนขวา",
  "left arm": "แขนซ้าย",
  "both arms": "แขนทั้งสองข้าง",
  arm: "แขน",
  "upper arm": "ต้นแขน",
  "left upper arm": "ต้นแขนซ้าย",
  "right upper arm": "ต้นแขนขวา",
  "bilateral arms": "แขนทั้งสองข้าง",
  shoulder: "ไหล่",
  shoulders: "ไหล่ทั้งสองข้าง",
  "left shoulder": "ไหล่ซ้าย",
  "right shoulder": "ไหล่ขวา",
  elbow: "ข้อศอก",
  "left elbow": "ข้อศอกซ้าย",
  "right elbow": "ข้อศอกขวา",
  "right leg": "ขาขวา",
  "left leg": "ขาซ้าย",
  "both legs": "ขาทั้งสองข้าง",
  leg: "ขา",
  "lower leg": "ขาส่วนล่าง",
  "left lower leg": "ขาส่วนล่างซ้าย",
  "right lower leg": "ขาส่วนล่างขวา",
  "bilateral legs": "ขาทั้งสองข้าง",
  knee: "เข่า",
  "left knee": "เข่าซ้าย",
  "right knee": "เข่าขวา",
  "both knees": "เข่าทั้งสองข้าง",
  "bilateral knees": "เข่าทั้งสองข้าง",
  wrist: "ข้อมือ",
  "left wrist": "ข้อมือซ้าย",
  "right wrist": "ข้อมือขวา",
  ankle: "ข้อเท้า",
  "left ankle": "ข้อเท้าซ้าย",
  "right ankle": "ข้อเท้าขวา",
  "both ankles": "ข้อเท้าทั้งสองข้าง",
  "bilateral ankles": "ข้อเท้าทั้งสองข้าง",
  hip: "สะโพก",
  "left hip": "สะโพกซ้าย",
  "right hip": "สะโพกขวา",
  "right hand": "มือขวา",
  "left hand": "มือซ้าย",
  "both hands": "มือทั้งสองข้าง",
  hand: "มือ",
  hands: "มือทั้งสองข้าง",
  finger: "นิ้วมือ",
  fingers: "นิ้วมือ",
  thumb: "นิ้วโป้ง",
  "left thumb": "นิ้วโป้งซ้าย",
  "right thumb": "นิ้วโป้งขวา",
  "both thumbs": "นิ้วโป้งทั้งสองข้าง",
  "index finger": "นิ้วชี้",
  "left index finger": "นิ้วชี้ซ้าย",
  "right index finger": "นิ้วชี้ขวา",
  "both index fingers": "นิ้วชี้ทั้งสองข้าง",
  "middle finger": "นิ้วกลาง",
  "left middle finger": "นิ้วกลางซ้าย",
  "right middle finger": "นิ้วกลางขวา",
  "both middle fingers": "นิ้วกลางทั้งสองข้าง",
  "ring finger": "นิ้วนาง",
  "left ring finger": "นิ้วนางซ้าย",
  "right ring finger": "นิ้วนางขวา",
  "both ring fingers": "นิ้วนางทั้งสองข้าง",
  "little finger": "นิ้วก้อย",
  "left little finger": "นิ้วก้อยซ้าย",
  "right little finger": "นิ้วก้อยขวา",
  "both little fingers": "นิ้วก้อยทั้งสองข้าง",
  toe: "นิ้วเท้า",
  toes: "นิ้วเท้า",
  "great toe": "นิ้วโป้งเท้า",
  "big toe": "นิ้วโป้งเท้า",
  "left great toe": "นิ้วโป้งเท้าซ้าย",
  "right great toe": "นิ้วโป้งเท้าขวา",
  "both great toes": "นิ้วโป้งเท้าทั้งสองข้าง",
  "second toe": "นิ้วชี้เท้า",
  "left second toe": "นิ้วชี้เท้าซ้าย",
  "right second toe": "นิ้วชี้เท้าขวา",
  "both second toes": "นิ้วชี้เท้าทั้งสองข้าง",
  "third toe": "นิ้วกลางเท้า",
  "left third toe": "นิ้วกลางเท้าซ้าย",
  "right third toe": "นิ้วกลางเท้าขวา",
  "both third toes": "นิ้วกลางเท้าทั้งสองข้าง",
  "fourth toe": "นิ้วนางเท้า",
  "left fourth toe": "นิ้วนางเท้าซ้าย",
  "right fourth toe": "นิ้วนางเท้าขวา",
  "both fourth toes": "นิ้วนางเท้าทั้งสองข้าง",
  "fifth toe": "นิ้วก้อยเท้า",
  "left fifth toe": "นิ้วก้อยเท้าซ้าย",
  "right fifth toe": "นิ้วก้อยเท้าขวา",
  "both fifth toes": "นิ้วก้อยเท้าทั้งสองข้าง",
  "little toe": "นิ้วก้อยเท้า",
  "between fingers": "ระหว่างนิ้วมือ",
  "between toes": "ระหว่างนิ้วเท้า",
  "back of hand": "หลังมือ",
  "both backs of hands": "หลังมือทั้งสองข้าง",
  palm: "ฝ่ามือ",
  "both palms": "ฝ่ามือทั้งสองข้าง",
  "right foot": "เท้าขวา",
  "left foot": "เท้าซ้าย",
  "both feet": "เท้าทั้งสองข้าง",
  foot: "เท้า",
  feet: "เท้า",
  "back of foot": "หลังเท้า",
  "both backs of feet": "หลังเท้าทั้งสองข้าง",
  "sole of foot": "ฝ่าเท้า",
  "both soles": "ฝ่าเท้าทั้งสองข้าง",
  heel: "ส้นเท้า",
  "left heel": "ส้นเท้าซ้าย",
  "right heel": "ส้นเท้าขวา",
  "both heels": "ส้นเท้าทั้งสองข้าง",
  abdomen: "ท้อง",
  abdominal: "ท้อง",
  belly: "ท้อง",
  flank: "สีข้าง",
  "left flank": "สีข้างซ้าย",
  "right flank": "สีข้างขวา",
  "affected area": "บริเวณที่เป็น",
  "affected site": "บริเวณที่เป็น",
  "บริเวณที่เป็น": "บริเวณที่เป็น",
  head: "ศีรษะ",
  "back of head": "ด้านหลังศีรษะ",
  "left head": "ศีรษะซ้าย",
  "left side of head": "ศีรษะซ้าย",
  "right head": "ศีรษะขวา",
  "right side of head": "ศีรษะขวา",
  back: "แผ่นหลัง",
  chest: "ทรวงอก",
  "chest wall": "ผนังทรวงอก",
  breast: "เต้านม",
  "left breast": "เต้านมซ้าย",
  "right breast": "เต้านมขวา",
  "both breasts": "เต้านมทั้งสองข้าง",
  "bilateral breasts": "เต้านมทั้งสองข้าง",
  axilla: "รักแร้",
  axillae: "รักแร้ทั้งสองข้าง",
  armpit: "รักแร้",
  armpits: "รักแร้ทั้งสองข้าง",
  groin: "ขาหนีบ",
  testis: "อัณฑะ",
  testicle: "อัณฑะ",
  testicles: "อัณฑะ",
  "left testis": "อัณฑะซ้าย",
  "left testicle": "อัณฑะซ้าย",
  "right testis": "อัณฑะขวา",
  "right testicle": "อัณฑะขวา",
  scalp: "หนังศีรษะ",
  face: "ใบหน้า",
  cheek: "แก้ม",
  cheeks: "แก้มทั้งสองข้าง",
  forehead: "หน้าผาก",
  temple: "ขมับ",
  "temple region": "ขมับ",
  "temporal region": "ขมับ",
  temples: "ขมับทั้งสองข้าง",
  "left temple": "ขมับซ้าย",
  "left temple region": "ขมับซ้าย",
  "left temporal region": "ขมับซ้าย",
  "right temple": "ขมับขวา",
  "right temple region": "ขมับขวา",
  "right temporal region": "ขมับขวา",
  "both temples": "ขมับทั้งสองข้าง",
  "bilateral temples": "ขมับทั้งสองข้าง",
  chin: "คาง",
  neck: "คอ",
  eyelid: "เปลือกตา",
  eyelids: "เปลือกตา",
  lip: "ริมฝีปาก",
  lips: "ริมฝีปาก",
  forearm: "ปลายแขน",
  "left forearm": "ปลายแขนซ้าย",
  "right forearm": "ปลายแขนขวา",
  thigh: "ต้นขา",
  thighs: "ต้นขาทั้งสองข้าง",
  "left thigh": "ต้นขาซ้าย",
  "right thigh": "ต้นขาขวา",
  gum: "เหงือก",
  gums: "เหงือก",
  tooth: "ฟัน",
  teeth: "ฟัน",
  buttock: "สะโพก",
  buttocks: "สะโพกทั้งสองข้าง",
  gluteal: "สะโพก",
  glute: "สะโพก",
  butt: "สะโพก",
  ass: "สะโพก",
  "left buttock": "สะโพกซ้าย",
  "left gluteal": "สะโพกซ้าย",
  "left butt": "สะโพกซ้าย",
  "left ass": "สะโพกซ้าย",
  "right buttock": "สะโพกขวา",
  "right gluteal": "สะโพกขวา",
  "right butt": "สะโพกขวา",
  "right ass": "สะโพกขวา",
  muscle: "กล้ามเนื้อ",
  muscles: "กล้ามเนื้อทั้งหมด",
  vein: "หลอดเลือดดำ",
  veins: "หลอดเลือดดำทั้งหมด",
  vagina: "ช่องคลอด",
  vaginal: "บริเวณช่องคลอด",
  penis: "อวัยวะเพศชาย",
  penile: "บริเวณอวัยวะเพศชาย",
  rectum: "ไส้ตรง",
  rectal: "บริเวณทวารหนัก",
  anus: "ทวารหนัก",
  perineum: "ฝีเย็บ",
  skin: "ผิวหนัง",
  hair: "เส้นผม"
};

const THAI_SITE_DEFINITION_TRANSLATIONS: Record<string, string> = (() => {
  const translations: Record<string, string> = {};
  for (const { names, definition } of DEFAULT_BODY_SITE_SNOMED_SOURCE) {
    const translated = definition.i18n?.th?.trim();
    if (!translated) continue;
    for (const name of names) {
      const normalized = normalizeBodySiteKey(name);
      if (normalized && !translations[normalized]) translations[normalized] = translated;
    }
    const canonical = normalizeBodySiteKey(definition.text ?? "");
    if (canonical && !translations[canonical]) translations[canonical] = translated;
  }
  return translations;
})();

const THAI_SITE_CODE_TRANSLATIONS: Record<string, string> = (() => {
  const translations: Record<string, string> = {};

  for (const { names, definition } of DEFAULT_BODY_SITE_SNOMED_SOURCE) {
    const code = definition.coding?.code;
    if (!code || translations[code]) {
      continue;
    }

    const definitionTranslation = definition.i18n?.th?.trim();
    if (definitionTranslation) {
      translations[code] = definitionTranslation;
      continue;
    }

    for (const name of names) {
      const translated = THAI_SITE_TRANSLATIONS[normalizeBodySiteKey(name)];
      if (translated) {
        translations[code] = translated;
        break;
      }
    }
  }

  return translations;
})();

interface ThaiRouteGrammar {
  verb: string;
  routePhrase?: string | ((context: { hasSite: boolean; clause: CanonicalSigClause }) => string | undefined);
  sitePreposition?: string;
}

const DEFAULT_THAI_ROUTE_GRAMMAR: ThaiRouteGrammar = { verb: "ใช้" };

const THAI_ROUTE_GRAMMAR: Partial<Record<RouteCode, ThaiRouteGrammar>> = {
  [RouteCode["Oral route"]]: { verb: "รับประทาน", routePhrase: "ทางปาก" },
  [RouteCode["Sublingual route"]]: { verb: "อมใต้ลิ้น", routePhrase: "ใต้ลิ้น" },
  [RouteCode["Buccal route"]]: { verb: "อมกระพุ้งแก้ม", routePhrase: "ที่กระพุ้งแก้ม" },
  [RouteCode["Respiratory tract route (qualifier value)"]]: {
    verb: "สูด",
    sitePreposition: "ที่"
  },
  [RouteCode["Nasal route"]]: {
    verb: "พ่น",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "ทางจมูก"),
    sitePreposition: "ที่"
  },
  [RouteCode["Topical route"]]: {
    verb: "ทา",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "บริเวณผิวหนัง"),
    sitePreposition: "บริเวณ"
  },
  [RouteCode["Transdermal route"]]: {
    verb: "ติด",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "แบบแผ่นแปะผิวหนัง"),
    sitePreposition: "บริเวณ"
  },
  [RouteCode["Subcutaneous route"]]: {
    verb: "ฉีด",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "เข้าใต้ผิวหนัง"),
    sitePreposition: "ที่"
  },
  [RouteCode["Intramuscular route"]]: {
    verb: "ฉีด",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "เข้ากล้ามเนื้อ"),
    sitePreposition: "ที่"
  },
  [RouteCode["Intravenous route"]]: {
    verb: "ฉีด",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "เข้าหลอดเลือดดำ"),
    sitePreposition: "ที่"
  },
  [RouteCode["Per rectum"]]: {
    verb: "สอด",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "ทางทวารหนัก"),
    sitePreposition: "ที่"
  },
  [RouteCode["Per vagina"]]: {
    verb: "สอด",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "ทางช่องคลอด"),
    sitePreposition: "ที่"
  },
  [RouteCode["Ophthalmic route"]]: {
    verb: "หยอด",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "ที่ดวงตา"),
    sitePreposition: "ที่"
  },
  [RouteCode["Otic route"]]: {
    verb: "หยอด",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "ที่หู"),
    sitePreposition: "ที่"
  },
  [RouteCode["Intravitreal route (qualifier value)"]]: {
    verb: "ฉีด",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "เข้าดวงตา"),
    sitePreposition: "ที่"
  }
};

const THAI_METHOD_TEXT_VERBS: Record<string, string> = {
  Apply: "ทา",
  "Apply sunscreen": "ทากันแดด",
  Dab: "แต้ม",
  Drink: "รับประทาน",
  Insert: "สอด",
  Instill: "หยอด",
  Massage: "นวด",
  Reapply: "ทาซ้ำ",
  "Reapply sunscreen": "ทากันแดดซ้ำ",
  Rub: "ถู",
  Spray: "พ่น",
  Shampoo: "สระผม",
  Swallow: "รับประทาน",
  Take: "รับประทาน",
  "Use shampoo": "สระผม",
  Wash: "ล้าง"
};

const THAI_IMPLIED_OBJECT_VERBS = new Set([
  "ทา",
  "ทาซ้ำ",
  "แต้ม",
  "ถู",
  "นวด",
  "พ่น",
  "หยอด",
  "สอด",
  "ล้าง",
  "สระ",
  "สระผม"
]);

const THAI_SUPPRESSIBLE_ROUTE_VERBS = new Set([
  "ทา",
  "ทากันแดด",
  "ทาซ้ำ",
  "ทากันแดดซ้ำ",
  "แต้ม",
  "ถู",
  "นวด",
  "ล้าง",
  "สระ",
  "สระผม"
]);

const THAI_SITE_FIRST_VERBS = new Set([
  "ทา",
  "ทากันแดด",
  "ทาซ้ำ",
  "ทากันแดดซ้ำ",
  "แต้ม",
  "ถู",
  "นวด",
  "ล้าง",
  "สระ",
  "สระผม",
  "พ่น"
]);

const THAI_EARLY_SITE_ROUTES = new Set<RouteCode>([
  RouteCode["Ophthalmic route"],
  RouteCode["Otic route"],
  RouteCode["Intravitreal route (qualifier value)"]
]);

function resolveThaiMethodVerb(
  clause: CanonicalSigClause,
  grammar: ThaiRouteGrammar,
  resolvedMethod?: MedicationInstructionActionDefinition
): string {
  // An explicitly configured method may override wording. Resolving a
  // built-in through an empty map does not erase an authored translation.
  if (resolvedMethod && resolvedMethod !== getMedicationInstructionAction(resolvedMethod.code))
    return localizedValue(resolvedMethod.i18n, "th") ?? resolvedMethod.display;
  const translatedText = getPrimitiveTranslation(clause.method?._text, "th");
  if (translatedText) {
    return translatedText;
  }

  if (resolvedMethod) return localizedValue(resolvedMethod.i18n, "th") ?? resolvedMethod.display;
  const methodText = clause.method?.text?.trim();
  if (methodText) {
    const overridden = THAI_METHOD_TEXT_VERBS[methodText];
    if (overridden) {
      return overridden;
    }
    const localizedAction = resolveMedicationInstructionAction(methodText)?.i18n?.th?.trim();
    if (localizedAction) {
      return localizedAction;
    }
  }

  const translatedDisplay =
    clause.method?.coding?.i18n?.th ??
    getPrimitiveTranslation(clause.method?.coding?._display, "th");
  if (translatedDisplay) {
    return translatedDisplay;
  }

  return grammar.verb;
}

function joinThaiVerbAndBody(
  verb: string,
  body: string,
  separatePhrase = false
): string {
  const trimmedBody = body.trim();
  if (!trimmedBody) return verb;
  // Thai normally joins a verbal head to a Thai complement, but an Arabic/Latin
  // token needs a visible boundary. A declared verbal qualifier (e.g. บางๆ)
  // also closes its phrase before the following site/dose phrase.
  const separator = separatePhrase || /^[0-9A-Za-z]/u.test(trimmedBody) ? " " : "";
  return `${verb}${separator}${trimmedBody}`;
}


function shouldUseGenericMedicationObjectThai(
  clause: CanonicalSigClause,
  verb: string,
  explicitDosePart: string | undefined
): boolean {
  if (explicitDosePart) {
    return false;
  }
  if (THAI_IMPLIED_OBJECT_VERBS.has(verb)) {
    return false;
  }
  if (medicationInstructionActionLocaleRealizerConfig(
    resolveMedicationInstructionAction(verb)?.realizerConfig,
    "th"
  )?.implicitMedicationObject) {
    return false;
  }
  const primaryStart = clause.instructionGraph?.primaryAdministrationSpan?.start;
  if (primaryStart !== undefined && clause.instructionGraph?.actions.some((action) =>
    action.span.end <= primaryStart && action.args.some((arg) =>
      arg.role === AdviceArgumentRole.Theme && arg.conceptId === "product"
    )
  )) {
    return false;
  }
  switch (clause.route?.code) {
    case RouteCode["Topical route"]:
    case RouteCode["Transdermal route"]:
    case RouteCode["Nasal route"]:
    case RouteCode["Ophthalmic route"]:
    case RouteCode["Otic route"]:
    case RouteCode["Per rectum"]:
    case RouteCode["Per vagina"]:
      return false;
    default:
      return true;
  }
}

function shouldSuppressRoutePhraseThai(
  clause: CanonicalSigClause,
  verb: string,
  hasSite: boolean,
  explicitDosePart: string | undefined
): boolean {
  if (
    (clause.route?.code === RouteCode["Sublingual route"] && verb === "อมใต้ลิ้น") ||
    (clause.route?.code === RouteCode["Buccal route"] && verb === "อมกระพุ้งแก้ม")
  ) {
    return true;
  }
  if (hasSite || explicitDosePart) {
    return false;
  }
  if (!THAI_SUPPRESSIBLE_ROUTE_VERBS.has(verb)) {
    return false;
  }
  switch (clause.route?.code) {
    case RouteCode["Topical route"]:
    case RouteCode["Transdermal route"]:
      return true;
    default:
      return false;
  }
}

function scheduleOf(clause: CanonicalSigClause): CanonicalScheduleExpr {
  return clause.schedule ?? {};
}

function resolveRouteGrammarThai(clause: CanonicalSigClause): ThaiRouteGrammar {
  const routeCode = clause.route?.code;
  if (routeCode && THAI_ROUTE_GRAMMAR[routeCode]) {
    return THAI_ROUTE_GRAMMAR[routeCode] ?? DEFAULT_THAI_ROUTE_GRAMMAR;
  }
  const grammar = grammarFromRouteTextThai(clause.route?.text);
  if (grammar) {
    return grammar;
  }
  if (clause.dose?.unit?.trim().toLowerCase() === "puff") {
    return (
      THAI_ROUTE_GRAMMAR[RouteCode["Respiratory tract route (qualifier value)"]] ??
      DEFAULT_THAI_ROUTE_GRAMMAR
    );
  }
  return DEFAULT_THAI_ROUTE_GRAMMAR;
}

function grammarFromRouteTextThai(text: string | undefined): ThaiRouteGrammar | undefined {
  if (!text) {
    return undefined;
  }
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized.includes("mouth") || normalized.includes("oral")) {
    return THAI_ROUTE_GRAMMAR[RouteCode["Oral route"]];
  }
  if (normalized.includes("ophthalm")) {
    return THAI_ROUTE_GRAMMAR[RouteCode["Ophthalmic route"]];
  }
  if (normalized.includes("intravitreal")) {
    return THAI_ROUTE_GRAMMAR[RouteCode["Intravitreal route (qualifier value)"]];
  }
  if (normalized.includes("topical")) {
    return THAI_ROUTE_GRAMMAR[RouteCode["Topical route"]];
  }
  if (normalized.includes("transdermal")) {
    return THAI_ROUTE_GRAMMAR[RouteCode["Transdermal route"]];
  }
  if (normalized.includes("subcutaneous") || normalized === "sc" || normalized === "sq") {
    return THAI_ROUTE_GRAMMAR[RouteCode["Subcutaneous route"]];
  }
  if (normalized.includes("intramuscular") || normalized === "im") {
    return THAI_ROUTE_GRAMMAR[RouteCode["Intramuscular route"]];
  }
  if (normalized.includes("intravenous") || normalized === "iv") {
    return THAI_ROUTE_GRAMMAR[RouteCode["Intravenous route"]];
  }
  if (normalized.includes("rectal") || normalized.includes("rectum")) {
    return THAI_ROUTE_GRAMMAR[RouteCode["Per rectum"]];
  }
  if (normalized.includes("vagin")) {
    return THAI_ROUTE_GRAMMAR[RouteCode["Per vagina"]];
  }
  if (normalized.includes("nasal")) {
    return THAI_ROUTE_GRAMMAR[RouteCode["Nasal route"]];
  }
  if (normalized.includes("inhal")) {
    return THAI_ROUTE_GRAMMAR[RouteCode["Respiratory tract route (qualifier value)"]];
  }
  return undefined;
}

function formatDoseThaiShort(dose: CanonicalDoseExpr | undefined): string | undefined {
  if (!dose) {
    return undefined;
  }
  if (dose.range) {
    if (dose.range.low !== undefined && dose.range.high !== undefined) {
      const base = `${stripTrailingZero(dose.range.low)}-${stripTrailingZero(dose.range.high)}`;
      if (dose.unit) {
        return `${base} ${formatUnitThai(dose.unit, dose.range.high, "short")}`;
      }
      return base;
    }
    if (dose.range.low !== undefined) {
      const base = `>=${stripTrailingZero(dose.range.low)}`;
      if (dose.unit) {
        return `${base} ${formatUnitThai(dose.unit, dose.range.low, "short")}`;
      }
      return base;
    }
    if (dose.range.high !== undefined) {
      const base = `<=${stripTrailingZero(dose.range.high)}`;
      if (dose.unit) {
        return `${base} ${formatUnitThai(dose.unit, dose.range.high, "short")}`;
      }
      return base;
    }
  }
  if (dose.value !== undefined) {
    const quantity = quantityComparatorText(dose.comparator, "th") + stripTrailingZero(dose.value);
    if (dose.unit) {
      return `${quantity} ${formatUnitThai(dose.unit, dose.value, "short")}`;
    }
    return quantity;
  }
  return undefined;
}

function formatDoseThaiLong(dose: CanonicalDoseExpr | undefined): string | undefined {
  if (!dose) {
    return undefined;
  }
  if (dose.range) {
    if (dose.range.low !== undefined && dose.range.high !== undefined) {
      if (dose.unit) {
        return `ครั้งละ ${stripTrailingZero(dose.range.low)} ถึง ${stripTrailingZero(dose.range.high)} ${formatUnitThai(
          dose.unit,
          dose.range.high,
          "long"
        )}`;
      }
      return `ครั้งละ ${stripTrailingZero(dose.range.low)} ถึง ${stripTrailingZero(dose.range.high)}`;
    }
    if (dose.range.low !== undefined) {
      if (dose.unit) {
        return `ครั้งละ อย่างน้อย ${stripTrailingZero(dose.range.low)} ${formatUnitThai(
          dose.unit,
          dose.range.low,
          "long"
        )}`;
      }
      return `ครั้งละ อย่างน้อย ${stripTrailingZero(dose.range.low)}`;
    }
    if (dose.range.high !== undefined) {
      if (dose.unit) {
        return `ครั้งละ ไม่เกิน ${stripTrailingZero(dose.range.high)} ${formatUnitThai(
          dose.unit,
          dose.range.high,
          "long"
        )}`;
      }
      return `ครั้งละ ไม่เกิน ${stripTrailingZero(dose.range.high)}`;
    }
  }
  if (dose.value !== undefined) {
    const quantity = quantityComparatorText(dose.comparator, "th") + stripTrailingZero(dose.value);
    if (dose.unit) {
      return `ครั้งละ ${quantity} ${formatUnitThai(dose.unit, dose.value, "long")}`;
    }
    return `ครั้งละ ${quantity}`;
  }
  return undefined;
}

function formatDoseThaiPerTarget(dose: CanonicalDoseExpr | undefined): string | undefined {
  if (!dose) return undefined;
  if (dose.range) {
    if (dose.range.low !== undefined && dose.range.high !== undefined) {
      const amount = `${stripTrailingZero(dose.range.low)} ถึง ${stripTrailingZero(dose.range.high)}`;
      return dose.unit ? `${amount} ${formatUnitThai(dose.unit, dose.range.high, "long")}` : amount;
    }
    if (dose.range.low !== undefined) {
      const amount = `อย่างน้อย ${stripTrailingZero(dose.range.low)}`;
      return dose.unit ? `${amount} ${formatUnitThai(dose.unit, dose.range.low, "long")}` : amount;
    }
    if (dose.range.high !== undefined) {
      const amount = `ไม่เกิน ${stripTrailingZero(dose.range.high)}`;
      return dose.unit ? `${amount} ${formatUnitThai(dose.unit, dose.range.high, "long")}` : amount;
    }
  }
  if (dose.value !== undefined) {
    const quantity = quantityComparatorText(dose.comparator, "th") + stripTrailingZero(dose.value);
    return dose.unit
      ? `${quantity} ${dose.unit.toLowerCase() === "spray" ? "ครั้ง" : formatUnitThai(dose.unit, dose.value, "long")}`
      : quantity;
  }
  return undefined;
}

function perTargetSiteThai(clause: CanonicalSigClause): string | undefined {
  if (!doseUnitUsesTargetScope(clause.dose?.unitIdentity ?? clause.dose?.unit)) return undefined;
  const text = clause.site?.text?.trim() || clause.site?.coding?.display?.trim();
  if (!text) return undefined;
  return resolveBodySitePhrase(text)?.definition?.perTargetI18n?.th;
}

function formatUnitThai(unit: string, _value: number, style: "short" | "long"): string {
  const lower = unit.toLowerCase();
  const mapping: Record<string, { short: string; long: string }> = {
    tab: { short: "เม็ด", long: "เม็ด" },
    tablet: { short: "เม็ด", long: "เม็ด" },
    cap: { short: "แคปซูล", long: "แคปซูล" },
    capsule: { short: "แคปซูล", long: "แคปซูล" },
    "cm ribbon": { short: "ซม.", long: "ซม." },
    "cm strip": { short: "ซม.", long: "ซม." },
    "cm line": { short: "ซม.", long: "ซม." },
    "inch ribbon": { short: "นิ้ว", long: "นิ้ว" },
    "inch strip": { short: "นิ้ว", long: "นิ้ว" },
    "inch line": { short: "นิ้ว", long: "นิ้ว" },
    ml: { short: "มล.", long: "มิลลิลิตร" },
    milliliter: { short: "มล.", long: "มิลลิลิตร" },
    milliliters: { short: "มล.", long: "มิลลิลิตร" },
    mg: { short: "มก.", long: "มิลลิกรัม" },
    mcg: { short: "ไมโครกรัม", long: "ไมโครกรัม" },
    ug: { short: "ไมโครกรัม", long: "ไมโครกรัม" },
    u: { short: "ยูนิต", long: "ยูนิต" },
    puff: { short: "พัฟ", long: "พัฟ" },
    puffs: { short: "พัฟ", long: "พัฟ" },
    spray: { short: "พ่น", long: "พ่น" },
    sprays: { short: "พ่น", long: "พ่น" },
    drop: { short: "หยด", long: "หยด" },
    drops: { short: "หยด", long: "หยด" },
    pump: { short: "ปั๊ม", long: "ปั๊ม" },
    pumps: { short: "ปั๊ม", long: "ปั๊ม" },
    actuation: { short: "ครั้ง", long: "ครั้ง" },
    ftu: { short: "FTU", long: "FTU" },
    patch: { short: "แผ่น", long: "แผ่นแปะ" },
    patches: { short: "แผ่น", long: "แผ่นแปะ" },
    ring: { short: "วง", long: "วง" },
    implant: { short: "ชิ้น", long: "ชิ้น" },
    dose: { short: "ครั้ง", long: "ครั้ง" },
    applicatorful: { short: "แอปพลิเคเตอร์", long: "แอปพลิเคเตอร์" },
    capful: { short: "ฝา", long: "ฝา" },
    scoop: { short: "ช้อนตวง", long: "ช้อนตวง" },
    "pea-sized amount": { short: "ขนาดเท่าเม็ดถั่ว", long: "ขนาดเท่าเม็ดถั่ว" },
    palm: { short: "ฝ่ามือ", long: "ฝ่ามือ" },
    handprint: { short: "หนึ่งฝ่ามือ", long: "หนึ่งฝ่ามือ" },
    "shot glass": { short: "แก้วช็อต", long: "แก้วช็อต" },
    "finger length": { short: "ความยาวนิ้ว", long: "ความยาวนิ้ว" },
    click: { short: "คลิก", long: "คลิก" },
    vial: { short: "ขวด", long: "ขวด" },
    ampule: { short: "แอมพูล", long: "แอมพูล" },
    packet: { short: "ซอง", long: "ซอง" },
    sachet: { short: "ซอง", long: "ซอง" },
    "stick-pack": { short: "ซองแท่ง", long: "ซองแท่ง" },
    suppository: { short: "ยาเหน็บ", long: "ยาเหน็บ" },
    suppositories: { short: "ยาเหน็บ", long: "ยาเหน็บ" }
  };
  const entry = mapping[lower];
  return entry ? entry[style] : unit;
}

function describeAlternateEventCadenceThai(schedule: CanonicalScheduleExpr | undefined): string | undefined {
  const event = alternateDayEvent(schedule);
  if (event === EventTiming.Night) return "วันเว้นคืน";
  if (event === EventTiming.Morning) return "เช้าเว้นเช้า";
  return undefined;
}

function describeFrequencyThai(schedule: CanonicalScheduleExpr | undefined, words: CourseLanguage): string | undefined {
  if (hasDailyRecurrenceAcrossClocks(schedule)) return "ทุกวัน";
  const frequency = schedule?.frequency;
  const frequencyMax = schedule?.frequencyMax;
  const period = schedule?.period;
  const periodMax = schedule?.periodMax;
  const periodUnit = schedule?.periodUnit;
  const timingCode = schedule?.timingCode;
  const rangedPeriod = periodMax !== undefined && periodMax !== period;
  const countPrefix = frequency !== undefined &&
    (rangedPeriod || frequency !== 1 || frequencyMax !== undefined && frequencyMax !== frequency)
    ? frequencyMax !== undefined && frequencyMax !== frequency
      ? `${stripTrailingZero(frequency)} ถึง ${stripTrailingZero(frequencyMax)} ครั้ง `
      : `${stripTrailingZero(frequency)} ครั้ง `
    : frequencyMax !== undefined && frequency === undefined
      ? `ไม่เกิน ${stripTrailingZero(frequencyMax)} ครั้ง ` : "";

  if (period === undefined && periodMax !== undefined && periodUnit) {
    const unit = words.timeUnit(periodUnit, periodMax) ?? periodUnit;
    return `${countPrefix}ทุกไม่เกิน ${stripTrailingZero(periodMax)} ${unit}`;
  }
  if (
    frequency !== undefined &&
    frequencyMax !== undefined &&
    periodUnit === FhirPeriodUnit.Day &&
    (!period || period === 1) && !rangedPeriod
  ) {
    if (frequency === 1 && frequencyMax === 1) {
      return "วันละครั้ง";
    }
    if (frequency === 1 && frequencyMax === 2) {
      return "วันละ 1 ถึง 2 ครั้ง";
    }
    return `วันละ ${stripTrailingZero(frequency)} ถึง ${stripTrailingZero(frequencyMax)} ครั้ง`;
  }
  if (frequency === undefined && frequencyMax !== undefined &&
      periodUnit === FhirPeriodUnit.Day && (!period || period === 1) && !rangedPeriod) {
    return `วันละไม่เกิน ${stripTrailingZero(frequencyMax)} ครั้ง`;
  }
  if (frequency && periodUnit === FhirPeriodUnit.Day && (!period || period === 1) && !rangedPeriod) {
    return TH_TIMES_PER_DAY[frequency] ?? `วันละ ${stripTrailingZero(frequency)} ครั้ง`;
  }
  if (periodUnit === FhirPeriodUnit.Second && period) {
    const unit = words.timeUnit(periodUnit, periodMax ?? period) ?? periodUnit;
    const interval = periodMax !== undefined && periodMax !== period
      ? `${stripTrailingZero(period)} ถึง ${stripTrailingZero(periodMax)}` : stripTrailingZero(period);
    return `${countPrefix}ทุก ${interval} ${unit}`;
  }
  if (periodUnit === FhirPeriodUnit.Minute && period) {
    if (periodMax && periodMax !== period) {
      return `${countPrefix}ทุก ${stripTrailingZero(period)} ถึง ${stripTrailingZero(periodMax)} นาที`;
    }
    return `${countPrefix}ทุก ${stripTrailingZero(period)} นาที`;
  }
  if (periodUnit === FhirPeriodUnit.Hour && period) {
    if (periodMax && periodMax !== period) {
      return `${countPrefix}ทุก ${stripTrailingZero(period)} ถึง ${stripTrailingZero(periodMax)} ชั่วโมง`;
    }
    return `${countPrefix}ทุก ${stripTrailingZero(period)} ชั่วโมง`;
  }
  if (periodUnit === FhirPeriodUnit.Day && period && (period !== 1 || rangedPeriod)) {
    if (!countPrefix && period === 2 && (!periodMax || periodMax === 2)) {
      return "วันเว้นวัน";
    }
    if (periodMax && periodMax !== period) {
      return `${countPrefix}ทุก ${stripTrailingZero(period)} ถึง ${stripTrailingZero(periodMax)} วัน`;
    }
    return `${countPrefix}ทุก ${stripTrailingZero(period)} วัน`;
  }
  if (periodUnit === FhirPeriodUnit.Week && period) {
    if (frequency === undefined && frequencyMax !== undefined &&
        period === 1 && (!periodMax || periodMax === 1)) return `สัปดาห์ละไม่เกิน ${stripTrailingZero(frequencyMax)} ครั้ง`;
    if (
      period === 1 && (!periodMax || periodMax === 1) &&
      frequency !== undefined && frequencyMax !== undefined && frequencyMax !== frequency
    ) {
      return `สัปดาห์ละ ${stripTrailingZero(frequency)} ถึง ${stripTrailingZero(frequencyMax)} ครั้ง`;
    }
    if (schedule?.dayOfWeek?.length && period === 1 && (!periodMax || periodMax === 1)) {
      if (frequency !== undefined) {
        return `สัปดาห์ละ ${stripTrailingZero(frequency)} ครั้ง`;
      }
      return schedule.dayOfWeek.length === 1 ? "สัปดาห์ละครั้ง" : undefined;
    }
    if (period === 1 && (!periodMax || periodMax === 1)) {
      return frequency !== undefined && frequency !== 1
        ? `สัปดาห์ละ ${stripTrailingZero(frequency)} ครั้ง`
        : "สัปดาห์ละครั้ง";
    }
    if (periodMax && periodMax !== period) {
      return `${countPrefix}ทุก ${stripTrailingZero(period)} ถึง ${stripTrailingZero(periodMax)} สัปดาห์`;
    }
    return `${countPrefix}ทุก ${stripTrailingZero(period)} สัปดาห์`;
  }
  if (periodUnit === FhirPeriodUnit.Month && period) {
    if (frequency === undefined && frequencyMax !== undefined &&
        period === 1 && (!periodMax || periodMax === 1)) return `เดือนละไม่เกิน ${stripTrailingZero(frequencyMax)} ครั้ง`;
    if (period === 1 && (!periodMax || periodMax === 1)) {
      if (frequency !== undefined && frequencyMax !== undefined && frequencyMax !== frequency) {
        return `เดือนละ ${stripTrailingZero(frequency)} ถึง ${stripTrailingZero(frequencyMax)} ครั้ง`;
      }
      if (frequency === undefined && (schedule?.dayOfMonth?.length ?? 0) > 1) return undefined;
      return frequency !== undefined && frequency !== 1
        ? `เดือนละ ${stripTrailingZero(frequency)} ครั้ง`
        : "เดือนละครั้ง";
    }
    if (periodMax && periodMax !== period) {
      return `${countPrefix}ทุก ${stripTrailingZero(period)} ถึง ${stripTrailingZero(periodMax)} เดือน`;
    }
    return `${countPrefix}ทุก ${stripTrailingZero(period)} เดือน`;
  }
  if (periodUnit === FhirPeriodUnit.Year && period) {
    if (frequency === undefined && frequencyMax !== undefined &&
        period === 1 && (!periodMax || periodMax === 1)) return `ปีละไม่เกิน ${stripTrailingZero(frequencyMax)} ครั้ง`;
    if (period === 1 && (!periodMax || periodMax === 1)) {
      if (frequency !== undefined && frequencyMax !== undefined && frequencyMax !== frequency) {
        return `ปีละ ${stripTrailingZero(frequency)} ถึง ${stripTrailingZero(frequencyMax)} ครั้ง`;
      }
      return frequency !== undefined && frequency !== 1
        ? `ปีละ ${stripTrailingZero(frequency)} ครั้ง`
        : "ปีละครั้ง";
    }
    if (periodMax && periodMax !== period) {
      return `${countPrefix}ทุก ${stripTrailingZero(period)} ถึง ${stripTrailingZero(periodMax)} ปี`;
    }
    return `${countPrefix}ทุก ${stripTrailingZero(period)} ปี`;
  }
  if (timingCode && timingCodeMatchesRecurrence(schedule!)) {
    const map: Record<string, string> = {
      BID: "วันละ 2 ครั้ง",
      TID: "วันละ 3 ครั้ง",
      QID: "วันละ 4 ครั้ง",
      QD: "วันละครั้ง",
      QOD: "วันเว้นวัน",
      WK: "สัปดาห์ละครั้ง",
      MO: "เดือนละครั้ง"
    };
    const value = map[timingCode.toUpperCase()];
    if (value) {
      return value;
    }
    const interval = intervalTimingPreviewDescriptor(timingCode);
    if (interval)
      return `${countPrefix}ทุก ${stripTrailingZero(interval.period)} ${words.timeUnit(interval.periodUnit, interval.period) ?? interval.periodUnit}`;
  }
  if (frequency === undefined && frequencyMax === undefined && period === 1 &&
      periodUnit === FhirPeriodUnit.Day && !rangedPeriod) return "ทุกวัน";
  if (periodUnit === undefined && period === undefined && frequencyMax !== undefined) {
    if (frequency === undefined) return `ไม่เกิน ${stripTrailingZero(frequencyMax)} ครั้ง`;
    if (frequency !== frequencyMax)
      return `${stripTrailingZero(frequency)} ถึง ${stripTrailingZero(frequencyMax)} ครั้ง`;
  }
  if (frequency && periodUnit === undefined && period === undefined) {
    if (frequency === 1) {
      const label = schedule?.timingText ?? timingCode;
      const recurringLabel = label && (isCompactIntervalTimingCode(label) ||
        timingPreviewDescriptor(label)?.periodUnit || WORD_FREQUENCIES[label.toLowerCase()]);
      return recurringLabel ? "1 ครั้ง" : "ครั้งเดียว";
    }
    return `${stripTrailingZero(frequency)} ครั้ง`;
  }
  return undefined;
}

function describeFrequencyCountThai(count: number | undefined): string | undefined {
  if (!count || count <= 0) {
    return undefined;
  }
  return TH_TIMES_PER_DAY[count] ?? `วันละ ${stripTrailingZero(count)} ครั้ง`;
}

function describeStandaloneOccurrenceCountThai(schedule: CanonicalScheduleExpr | undefined): string | undefined {
  const count = standaloneOccurrenceCount(schedule);
  return count === undefined ? undefined : `จำนวน ${stripTrailingZero(count)} ครั้ง`;
}

function joinMealNamesThai(parts: string[]): string {
  if (!parts.length) {
    return "";
  }
  if (parts.length === 1) {
    return parts[0];
  }
  if (parts.length === 2) {
    return `${parts[0]} และ${parts[1]}`;
  }
  let text = parts[0];
  for (let i = 1; i < parts.length - 1; i += 1) {
    text += ` ${parts[i]}`;
  }
  return `${text} และ${parts[parts.length - 1]}`;
}

function summarizeMealTimingGroupThai(group: MealTimingGroup): string {
  const relationText = {
    before: "ก่อนอาหาร",
    after: "หลังอาหาร",
    with: "พร้อมอาหาร"
  } as const;
  const mealText = {
    breakfast: "เช้า",
    lunch: "กลางวัน",
    dinner: "เย็น"
  } as const;
  const meals: string[] = [];
  for (const meal of group.meals) {
    meals.push(mealText[meal]);
  }
  return `${relationText[group.relation]}${joinMealNamesThai(meals)}`;
}

function describeEventWindowThai(schedule: CanonicalScheduleExpr | undefined, words: CourseLanguage): string | undefined {
  const window = schedule?.eventWindow;
  return window ? words.eventWindow(WHEN_TEXT_THAI[window.start] ?? window.start, WHEN_TEXT_THAI[window.end] ?? window.end) : undefined;
}

function formatEventOffsetQuantityThai(minutes: number, maximum?: number): string {
  if (maximum !== undefined && maximum !== minutes)
    return `${stripTrailingZero(minutes)}–${stripTrailingZero(maximum)} นาที`;
  const seconds = Number((minutes * 60).toFixed(9));
  if (minutes < 1 && Number.isInteger(seconds)) {
    return `${stripTrailingZero(seconds)} วินาที`;
  }
  if (minutes >= 24 * 60 && minutes % (24 * 60) === 0) {
    return `${stripTrailingZero(minutes / (24 * 60))} วัน`;
  }
  if (minutes >= 60 && minutes % 60 === 0) {
    return `${stripTrailingZero(minutes / 60)} ชั่วโมง`;
  }
  return `${stripTrailingZero(minutes)} นาที`;
}

function formatActivityTimingThai(schedule: CanonicalScheduleExpr | undefined): string[] {
  const result: string[] = [];
  for (const timing of schedule?.activityTiming ?? []) {
    const definition = timing.activity.coding?.code
      ? getMedicationInstructionConcept(timing.activity.coding.code, timing.activity.coding.system)
      : resolveMedicationInstructionConcept(timing.activity.text);
    const activity = timing.activity.i18n?.th ?? definition?.i18n?.th ?? timing.activity.text;
    const relation = timing.relation === "before" ? "ก่อน" : "หลัง";
    if (timing.offsetMin !== undefined && timing.offsetMax !== undefined) {
      result.push(`${relation}${activity} ${formatEventOffsetQuantityThai(timing.offsetMin, timing.offsetMax)}`);
      continue;
    }
    const value = timing.offsetMin ?? timing.offsetMax ?? timing.offset;
    if (value === undefined) {
      result.push(`${relation}${activity}`);
      continue;
    }
    if (value === 0 && timing.offset !== undefined) {
      result.push(`${relation}${activity}ทันที`);
      continue;
    }
    const quantity = formatEventOffsetQuantityThai(value);
    const bound = timing.offsetMin !== undefined ? "อย่างน้อย "
      : timing.offsetMax !== undefined ? "ไม่เกิน " : "";
    result.push(`${relation}${activity}${bound ? `${bound}${quantity}` : ` ${quantity}`}`);
  }
  return result;
}

function formatEventOffsetThai(
  eventText: string,
  schedule: CanonicalScheduleExpr
): string {
  if (schedule.offsetMin !== undefined && schedule.offsetMax !== undefined)
    return `${eventText} ${formatEventOffsetQuantityThai(schedule.offsetMin, schedule.offsetMax)}`;
  const value = schedule.offsetMin ?? schedule.offsetMax ?? schedule.offset;
  if (value === undefined) return eventText;
  if (value === 0 && schedule.offset !== undefined) return `${eventText}ทันที`;
  const quantity = formatEventOffsetQuantityThai(value);
  if (schedule.offsetMin !== undefined) return `${eventText}อย่างน้อย ${quantity}`;
  if (schedule.offsetMax !== undefined) return `${eventText}ไม่เกิน ${quantity}`;
  return `${eventText} ${quantity}`;
}

const TH_TIMING_GRAMMAR: LocalizedTimingGrammar = {
  whenText: WHEN_TEXT_THAI,
  joinList: joinWithAndThai,
  summarizeMealTimingGroup: summarizeMealTimingGroupThai,
  formatEventOffset: formatEventOffsetThai,
  bedtimeJoinStyle: (dailyCount) => {
    if (dailyCount === 1) {
      return "adjacent";
    }
    if (dailyCount === 2 || dailyCount === 3 || dailyCount === 4) {
      return "conjunction";
    }
    return "separate";
  }
};

function collectWhenPhrasesThai(
  schedule: CanonicalScheduleExpr | undefined,
  options?: TimingSummaryOptions
): string[] {
  return collectLocalizedWhenPhrases(timingEventPreviewSchedule(schedule), TH_TIMING_GRAMMAR, options);
}

export function joinWithAndThai(parts: string[]): string {
  return joinLocalizedList(parts, "และ");
}

function combineFrequencyAndEventsThai(
  schedule: CanonicalScheduleExpr | undefined,
  frequency: string | undefined,
  events: string[],
  options?: TimingSummaryOptions
): { frequency?: string; event?: string } {
  return combineLocalizedFrequencyAndEvents(
    schedule,
    frequency,
    events,
    TH_TIMING_GRAMMAR,
    options
  );
}

function isOralRouteThai(clause: CanonicalSigClause): boolean {
  if (clause.route?.code === RouteCode["Oral route"]) {
    return true;
  }
  const text = clause.route?.text?.trim().toLowerCase();
  if (!text) {
    return false;
  }
  return text === "po" || text === "oral" || text.includes("mouth") || text.includes("per os");
}

function buildRoutePhraseThai(
  clause: CanonicalSigClause,
  grammar: ThaiRouteGrammar,
  hasSite: boolean
): string | undefined {
  if (grammar.verb === "รับประทาน" && isOralRouteThai(clause)) {
    return undefined;
  }
  if (typeof grammar.routePhrase === "function") {
    return grammar.routePhrase({ hasSite, clause });
  }
  if (typeof grammar.routePhrase === "string") {
    return grammar.routePhrase;
  }
  const text = clause.route?.text?.trim();
  if (!text) {
    return undefined;
  }
  const normalized = text.toLowerCase();
  if (normalized.startsWith("by ") || normalized.startsWith("per ") || normalized.startsWith("via ")) {
    return text;
  }
  if (normalized === "oral") {
    return "ทางปาก";
  }
  if (normalized === "intravenous") {
    return "เข้าหลอดเลือดดำ";
  }
  if (normalized === "intramuscular") {
    return "เข้ากล้ามเนื้อ";
  }
  if (normalized === "subcutaneous") {
    return "เข้าใต้ผิวหนัง";
  }
  if (normalized === "topical") {
    return "บริเวณผิวหนัง";
  }
  if (normalized === "transdermal") {
    return "แบบแผ่นแปะผิวหนัง";
  }
  if (normalized === "intranasal" || normalized === "nasal") {
    return "ทางจมูก";
  }
  if (normalized.includes("inhal")) {
    return undefined;
  }
  return text;
}

function appendSiteRestrictionsThai(
  clause: CanonicalSigClause,
  sitePhrase: string
): string {
  const restrictions = clause.site?.restrictions;
  if (!restrictions?.length) return sitePhrase;
  let result = sitePhrase;
  for (const restriction of restrictions) {
    const local = realizeBodySiteRestriction(restriction, "th");
    const current = restriction.predicate.text.trim();
    // The import boundary retires stale inferred predicates to the raw form.
    // Its current wording still owns display when no Thai realization exists.
    const retained = local ? undefined : current && restriction.predicate.form === "raw"
      ? realizeBodySiteRestriction({ ...restriction, sourceText: "" }, "en")
      : restriction.sourceText.trim() || (current
        ? realizeBodySiteRestriction({ ...restriction, sourceText: "" }, "en") : undefined);
    const phrase = local ?? (retained ? ` (${retained})` : undefined);
    if (phrase && !result.includes(phrase)) result += phrase;
  }
  return result;
}

function formatSiteThai(clause: CanonicalSigClause, grammar: ThaiRouteGrammar, words: CourseLanguage): string | undefined {
  const text = clause.site?.text?.trim() || clause.site?.coding?.display?.trim();
  const lower = text?.toLowerCase();
  const codingCode = clause.site?.coding?.code;
  const routeText = clause.route?.text?.trim().toLowerCase();
  const isRectalRoute =
    clause.route?.code === RouteCode["Per rectum"] ||
    routeText === "rectum" ||
    routeText === "rectal";
  const isVaginalRoute =
    clause.route?.code === RouteCode["Per vagina"] ||
    routeText === "vagina" ||
    routeText === "vaginal";
  const isRectumSite =
    codingCode === "34402009" || lower === "rectum" || lower === "rectal";
  const isVaginaSite =
    codingCode === "76784001" || lower === "vagina" || lower === "vaginal";
  if (
    isRectalRoute &&
    isRectumSite
  ) {
    return undefined;
  }
  if (
    isVaginalRoute &&
    isVaginaSite
  ) {
    return undefined;
  }
  const resolvedSite = text ? resolveBodySitePhrase(text, undefined, {
    allowTerminalModifierInheritance: true
  }) : undefined;
  const structuralTranslation =
    clause.site?.spatialRelation ||
    resolvedSite?.features.qualifier ||
    bodySiteHasAttributiveModifiers(text, resolvedSite?.resolutionCanonical)
      ? (text
        ? translateSiteThai(text, codingCode, clause.site?.spatialRelation)
        : translateSpatialSiteThai(undefined, clause.site?.spatialRelation))
      : undefined;
  const translated = perTargetSiteThai(clause) ?? structuralTranslation ??
    clause.site?.i18n?.th ?? clause.site?.coding?.i18n?.th ?? (text
      ? translateSiteThai(text, codingCode, clause.site?.spatialRelation)
      : translateSpatialSiteThai(undefined, clause.site?.spatialRelation)) ?? codingCode;
  if (!translated) {
    return undefined;
  }
  const count = clause.site?.administrationTargetCount;
  const scoped = count !== undefined && count > 1 && count !== resolvedSite?.definition?.administrationTargetCount
    ? translated + " (" + words.applicationSites(count) + ")" : translated;
  const translatedSite = appendSiteRestrictionsThai(clause, scoped);
  if (clause.route?.code === RouteCode["Nasal route"]) {
    return `เข้า${translatedSite}`;
  }
  const spatialRelation = clause.site?.spatialRelation;
  const spatialRealization = spatialRelation?.relationText
    ? getBodySiteRelationRealization(spatialRelation.relationText, "th")
    : undefined;
  const spatialTargetThai = spatialRelation
    ? translateSpatialTargetThai(spatialRelation)
    : undefined;
  if (
    spatialRealization &&
    (spatialRealization.omitOuterSitePreposition || spatialTargetThai?.startsWith("บริเวณ"))
  ) {
    return translatedSite;
  }
  const preposition = grammar.sitePreposition ?? "ที่";
  if (translatedSite.startsWith(preposition)) {
    return translatedSite;
  }
  const separator = /^[\u0E00-\u0E7F]/.test(translatedSite) ? "" : " ";
  return `${preposition}${separator}${translatedSite}`.trim();
}

const THAI_SPATIAL_TARGET_TRANSLATION_OVERRIDES: Record<string, string> = {
  abdomen: "ท้อง",
  abdominal: "ท้อง",
  belly: "ท้อง"
};

function translateSpatialTargetThai(
  relation: BodySiteSpatialRelation
): string | undefined {
  const normalizedTarget = normalizeBodySiteKey(relation.targetText ?? "");
  const override = THAI_SPATIAL_TARGET_TRANSLATION_OVERRIDES[normalizedTarget];
  return override ?? translateSiteThai(
    relation.targetText,
    relation.targetCoding?.code
  );
}

function translateSpatialSiteThai(
  site: string | undefined,
  relation?: BodySiteSpatialRelation
): string | undefined {
  const siteSpatialRelation = site ? resolveBodySitePhrase(site)?.spatialRelation : undefined;
  const spatialRelation = relation ?? siteSpatialRelation;
  if (!spatialRelation?.relationText) {
    return undefined;
  }
  if (site && (!relation?.relationText || siteSpatialRelation?.relationText)) {
    const curated = THAI_SITE_TRANSLATIONS[normalizeBodySiteKey(site)];
    if (curated) {
      return curated;
    }
  }
  const realization = getBodySiteRelationRealization(spatialRelation.relationText, "th");
  if (!realization) {
    return undefined;
  }
  const target = translateSpatialTargetThai(spatialRelation);
  if (!target) {
    return undefined;
  }
  return realization.strategy === "suffix"
    ? `${target}${realization.surface}`
    : `${realization.surface}${target}`;
}

function appendBodySiteQualifierThai(
  base: string,
  qualifier: BodySiteQualifierFeatures | undefined
): string {
  if (!qualifier) return base;
  const realization = getBodySiteRelationRealization(qualifier.relation, "th");
  if (!realization) return base;
  const relation = realization.surface;
  if (qualifier.kind === "symptom") {
    return `${base}${relation}${qualifier.i18n?.th ?? qualifier.text}`;
  }
  const target = translateSiteThai(qualifier.targetText, qualifier.targetCoding?.code) ?? qualifier.targetText;
  return `${base}${relation}${target}`;
}

function bodySiteHasAttributiveModifiers(
  site: string | undefined,
  resolutionCanonical: string | undefined
): boolean {
  const normalized = normalizeBodySiteKey(site ?? "");
  const base = normalizeBodySiteKey(resolutionCanonical ?? "");
  if (!normalized || !base || normalized === base || !normalized.endsWith(` ${base}`)) return false;
  const prefix = normalized.slice(0, normalized.length - base.length).trim();
  const modifierWords = prefix.split(/\s+/u).filter(Boolean);
  return modifierWords.length > 0 && modifierWords.every((word) => BODY_SITE_ATTRIBUTIVE_MODIFIERS.has(word));
}

function applyBodySiteBareNominalPrefixesThai(
  site: string,
  translatedBase: string,
  resolutionCanonical: string | undefined
): string {
  const normalized = normalizeBodySiteKey(site);
  const base = normalizeBodySiteKey(resolutionCanonical ?? "");
  if (!normalized || !base || normalized === base || !normalized.endsWith(` ${base}`)) {
    return translatedBase;
  }
  const prefix = normalized.slice(0, normalized.length - base.length).trim();
  if (!prefix) return translatedBase;
  const words = prefix.split(/\s+/u).filter(Boolean);
  if (!words.length || !words.every((word) => BODY_SITE_BARE_NOMINAL_PREFIXES.has(word))) {
    return translatedBase;
  }
  const translated = words.map((word) => BODY_SITE_BARE_NOMINAL_PREFIX_I18N[word]?.th);
  if (translated.some((value) => !value)) return translatedBase;
  return `${(translated as string[]).join("")}${translatedBase}`;
}

function applyBodySiteAttributiveModifiersThai(
  site: string,
  translatedBase: string,
  resolutionCanonical: string | undefined
): string {
  const normalized = normalizeBodySiteKey(site);
  const base = normalizeBodySiteKey(resolutionCanonical ?? "");
  if (!normalized || !base || normalized === base || !normalized.endsWith(` ${base}`)) {
    return translatedBase;
  }
  const prefix = normalized.slice(0, normalized.length - base.length).trim();
  if (!prefix) return translatedBase;
  const modifierWords = prefix.split(/\s+/u).filter(Boolean);
  if (!modifierWords.length || !modifierWords.every((word) => BODY_SITE_ATTRIBUTIVE_MODIFIERS.has(word))) {
    return translatedBase;
  }
  const translatedModifiers = modifierWords.map((word) =>
    BODY_SITE_ATTRIBUTIVE_MODIFIER_I18N[word]?.th
  );
  if (translatedModifiers.some((value) => !value)) return translatedBase;
  return `${translatedBase}${joinWithAndThai(translatedModifiers as string[])}`;
}

function translateSiteThai(
  site: string | undefined,
  code?: string,
  spatialRelation?: BodySiteSpatialRelation
): string | undefined {
  if (!site) {
    if (code) {
      return THAI_SITE_CODE_TRANSLATIONS[code];
    }
    return undefined;
  }
  const normalized = normalizeBodySiteKey(site);
  if (!normalized) {
    return site;
  }
  const resolvedPhrase = resolveBodySitePhrase(site, undefined, {
    allowTerminalModifierInheritance: true
  });
  const qualifier = resolvedPhrase?.features.qualifier;
  const qualified = (value: string): string => appendBodySiteQualifierThai(value, qualifier);
  const spatial = translateSpatialSiteThai(site, spatialRelation);
  if (spatial) {
    return qualified(spatial);
  }
  if (code) {
    const translatedByCode = THAI_SITE_CODE_TRANSLATIONS[code];
    if (translatedByCode) {
      return qualified(applyBodySiteAttributiveModifiersThai(
        site, translatedByCode, resolvedPhrase?.resolutionCanonical
      ));
    }
  }
  const resolvedDefinitionTranslation = resolvedPhrase?.definition?.i18n?.th;
  if (resolvedDefinitionTranslation) {
    const inherited = applyBodySiteBareNominalPrefixesThai(
      site,
      applyBodySiteAttributiveModifiersThai(site, resolvedDefinitionTranslation, resolvedPhrase?.resolutionCanonical),
      resolvedPhrase?.resolutionCanonical
    );
    return qualified(inherited);
  }
  const definitionTranslation = THAI_SITE_DEFINITION_TRANSLATIONS[normalized];
  if (definitionTranslation) {
    return qualified(applyBodySiteAttributiveModifiersThai(
      site, definitionTranslation, resolvedPhrase?.resolutionCanonical
    ));
  }
  const direct = THAI_SITE_TRANSLATIONS[normalized];
  if (direct) {
    return qualified(applyBodySiteAttributiveModifiersThai(
      site, direct, resolvedPhrase?.resolutionCanonical
    ));
  }
  return qualified(site);
}

function formatIsoCalendarDateThai(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(.+))?$/u);
  if (!match) return value;
  const buddhistYear = Number(match[1]) + 543;
  const date = `${Number(match[3])}/${Number(match[2])}/${buddhistYear}`;
  return match[4] ? `${date} เวลา ${match[4]}` : date;
}

function describeCalendarBoundsThai(
  schedule: CanonicalScheduleExpr | undefined
): string | undefined {
  const start = formatIsoCalendarDateThai(schedule?.boundsStart);
  const end = formatIsoCalendarDateThai(schedule?.boundsEnd);
  if (start && end) return `ตั้งแต่วันที่ ${start} ถึงวันที่ ${end}`;
  if (start) return `ตั้งแต่วันที่ ${start}`;
  if (end) return `ถึงวันที่ ${end}`;
  return undefined;
}

function describeCalendarEventsThai(
  schedule: CanonicalScheduleExpr | undefined
): string | undefined {
  const events = schedule?.calendarEvents;
  if (!events?.length) return undefined;
  const parts: string[] = [];
  for (const event of events) {
    const date = formatIsoCalendarDateThai(event.isoDate);
    const formatted = event.fhirDateTime
      ? `${date} เวลา ${event.fhirDateTime.slice(11)}` : date;
    if (formatted) parts.push(formatted);
  }
  if (!parts.length) return undefined;
  if (parts.length === 1) return `วันที่ ${parts[0]}`;
  if (parts.length === 2) return `วันที่ ${parts[0]} และ ${parts[1]}`;
  return `วันที่ ${parts.slice(0, -1).join(", ")} และ ${parts[parts.length - 1]}`;
}

/** Describe typed calendar month days in Thai.
 * @param schedule Calendar-day membership from grammar or a structured import.
 * @returns A Thai monthly day phrase when a selection is present.
 */
function describeDayOfMonthThai(schedule: CanonicalScheduleExpr | undefined): string | undefined {
  const days = schedule?.dayOfMonth ?? [];
  if (!days.length) return undefined;
  const sorted = [...days].sort((a, b) => a - b);
  const contiguous = sorted.every((day, index) => !index || day === sorted[index - 1] + 1);
  return contiguous && sorted.length > 1
    ? `วันที่ ${sorted[0]}–${sorted[sorted.length - 1]} ของทุกเดือน`
    : `วันที่ ${sorted.join(" และ ")} ของทุกเดือน`;
}

function describeDayOfWeekThai(schedule: CanonicalScheduleExpr | undefined): string | undefined {
  const dayOfWeek = schedule?.dayOfWeek ?? [];
  if (!dayOfWeek.length) {
    return undefined;
  }
  const days: string[] = [];
  for (const day of dayOfWeek) {
    const text = DAY_NAMES_THAI[day];
    if (text) {
      days.push(text);
    }
  }
  if (days.length && schedule?.weekdayOrdinal !== undefined) {
    return schedule.weekdayOrdinal === -1 ? `ใน${joinWithAndThai(days)}สุดท้ายของทุกเดือน` :
      `ใน${joinWithAndThai(days)}ครั้งที่ ${schedule.weekdayOrdinal} ของแต่ละเดือน`;
  }
  return days.length ? `ใน${joinWithAndThai(days)}` : undefined;
}

function describeOccurrenceCapThai(schedule: CanonicalScheduleExpr | undefined): string | undefined {
  const cap = schedule?.occurrenceCap;
  if (!cap) return undefined;
  const unit = cap.periodUnit === FhirPeriodUnit.Day ? "วัน"
    : cap.periodUnit === FhirPeriodUnit.Week ? "สัปดาห์"
      : cap.periodUnit === FhirPeriodUnit.Hour ? "ชั่วโมง"
        : cap.periodUnit === FhirPeriodUnit.Month ? "เดือน"
          : cap.periodUnit === FhirPeriodUnit.Year ? "ปี"
            : cap.periodUnit === FhirPeriodUnit.Minute ? "นาที" : cap.periodUnit;
  const period = cap.period === 1 ? unit : `${stripTrailingZero(cap.period)} ${unit}`;
  return `ไม่เกิน ${stripTrailingZero(cap.max)} ครั้งต่อ${period}`;
}

function describeDurationThai(schedule: CanonicalScheduleExpr | undefined, words: CourseLanguage): string | undefined {
  return describeDuration(schedule, words, THAI_DURATION_WORDING);
}

const THAI_DURATION_WORDING: DurationWording = {
  locale: "th", coursePrefix: "เป็นเวลา", administrationPrefix: "โดยให้ยานาน",
  administrationShortPrefix: "นาน", range: " ถึง ", upper: "ไม่เกิน ", lower: "อย่างน้อย ",
  administrationUnit: (unit, value, maximum, short, words) => short
    ? unit === FhirPeriodUnit.Minute ? "นาที" : unit === FhirPeriodUnit.Hour ? "ชั่วโมง"
      : unit === FhirPeriodUnit.Second ? "วินาที" : unit === FhirPeriodUnit.Day ? "วัน" : unit
    : words.timeUnit(unit, value ?? maximum) ?? unit
};

function describeAdministrationDurationThai(
  schedule: CanonicalScheduleExpr | undefined,
  prefix = "โดยให้ยานาน",
  short = false,
  words: CourseLanguage = THAI_COURSE
): string | undefined {
  return describeAdministrationDuration(schedule, short, words, THAI_DURATION_WORDING, prefix);
}

function findPrnReasonDefinitionByPossiblyPostcoordinatedCoding(
  system: string,
  code: string
) {
  const direct = findPrnReasonDefinitionByCoding(system, code);
  if (direct) {
    return direct;
  }
  const normalizedSystem = system.trim().toLowerCase();
  if (!normalizedSystem.includes("snomed.info/sct")) {
    return undefined;
  }
  return findPrnReasonDefinitionByCoding(system, code.split(":")[0] ?? code);
}

function translatePrnReasonThai(reason: CanonicalPrnReasonExpr): string | undefined {
  // A Thai source reason is already a surface proposition (e.g. "มีไข้",
  // "ปวด", "มีอาการปวด"). Preserve it instead of replacing it with a
  // nominal terminology label such as "ไข้". Coded terminology is used when
  // we actually need to translate a non-Thai/no-source reason into Thai.
  const sourceText = reason.text?.trim();
  const sourceIsThai = Boolean(sourceText && /[\u0E00-\u0E7F]/u.test(sourceText));
  const reasonTranslation = reason.i18n?.th?.trim();
  const translated = reasonTranslation || reason.coding?.i18n?.th?.trim();
  let text = sourceIsThai ? sourceText : translated ?? reason.coding?.display ?? sourceText;
  const coding = reason.coding;
  if (coding?.code) {
    const definition = findPrnReasonDefinitionByPossiblyPostcoordinatedCoding(
      coding.system ?? "http://snomed.info/sct",
      coding.code
    );
    if (sourceIsThai) {
      const normalizeSurface = (value: string | undefined) =>
        value?.trim().toLowerCase().replace(/\s+/g, " ");
      const normalizedSource = normalizeSurface(sourceText);
      const terminologySurfaces = [
        definition?.i18n?.th,
        definition?.conditionI18n?.th,
        ...(definition?.aliases ?? [])
      ].map(normalizeSurface).filter((value): value is string => Boolean(value));
      const sourceIsRegisteredSurface = Boolean(
        normalizedSource && terminologySurfaces.indexOf(normalizedSource) !== -1
      );
      if (sourceIsRegisteredSurface) {
        text = definition?.conditionI18n?.th ?? text;
      }
    } else if (!translated || translated === definition?.i18n?.th?.trim() ||
        translated === definition?.conditionI18n?.th?.trim()) {
      // Parser-produced translations may live on the reason or its coding.
      // Only a registered noun/condition label takes the condition form
      // ("ไข้" -> "มีไข้", "ไมเกรน" -> "มีอาการไมเกรน"); different authored
      // wording remains intact in ordinary, coordinated and onset contexts.
      text = definition?.conditionI18n?.th ?? definition?.i18n?.th ?? text;
    } else if (definition?.coding && sourceText) {
      const oldLabel = resolveSymptomDefinition(translated);
      // An exact registered label can survive a wire edit of the indication.
      // Retire it in the preview only when the current source and code agree;
      // unknown or more specific authored wording remains intact.
      if (oldLabel?.coding && oldLabel.coding.code !== definition.coding.code) {
        const currentSource = resolveSymptomDefinition(sourceText);
        if (currentSource?.coding?.code === definition.coding.code &&
            currentSource?.coding?.system === definition.coding.system)
          text = definition.conditionI18n?.th ?? definition.i18n?.th ?? text;
      }
    }
  }
  const spatial = translateSpatialSiteThai(undefined, reason.spatialRelation);
  if (text && spatial) {
    return `${text}${spatial}`;
  }
  return text;
}

function joinPrnReasonsThai(reasons: readonly CanonicalPrnReasonExpr[]): string | undefined {
  const phrases = reasons
    .map((reason) => translatePrnReasonThai(reason)?.trim())
    .filter((reason): reason is string => Boolean(reason));
  return phrases.length ? phrases.join("หรือ") : undefined;
}

function formatAsNeededThai(
  clause: CanonicalSigClause,
  embeddedAfterVerb = false
): string | undefined {
  if (!clause.prn?.enabled) {
    return undefined;
  }
  const onsetReason = clause.prn.reasons?.find((candidate) => candidate.triggerPhase === "onset") ??
    (clause.prn.reason?.triggerPhase === "onset" ? clause.prn.reason : undefined);
  if (onsetReason) {
    const onsetText = translatePrnReasonThai(onsetReason);
    return onsetText ? `เมื่อเริ่ม${onsetText}` : undefined;
  }
  const joined = clause.prn.reasons?.length
    ? joinPrnReasonsThai(clause.prn.reasons)
    : undefined;
  const reason = joined ?? translatePrnReasonThai(clause.prn.reason ?? {});
  // Thai condition morphology has two realization contexts. With preceding
  // administration material, make the PRN clause explicit ("... ใช้เมื่อปวด").
  // If the administration verb itself is immediately followed by the condition,
  // omit the redundant ใช้ ("ทาเมื่อคัน", "ใช้เมื่อปวด").
  const lead = embeddedAfterVerb ? "เมื่อ" : "ใช้เมื่อ";
  return reason ? `${lead}${reason}` : `${lead}จำเป็น`;
}

function formatShortThai(clause: CanonicalSigClause, words: CourseLanguage = THAI_COURSE,
  resolvedMethod?: MedicationInstructionActionDefinition): string {
  const schedule = scheduleOf(clause);
  const parts: string[] = [];
  const dose = formatDoseThaiShort(clause.dose);
  if (dose) {
    parts.push(dose);
  }
  if (clause.route?.code) {
    const short = ROUTE_SHORT[clause.route.code];
    if (short) {
      parts.push(short);
    } else if (clause.route.text) {
      parts.push(clause.route.text);
    }
  } else if (clause.route?.text) {
    parts.push(clause.route.text);
  }
  if (clause.site) {
    const site = formatSiteThai(clause, resolveRouteGrammarThai(clause), words);
    if (site) parts.push(site);
  }
  const timing = describeFrequencyThai(schedule, words);
  const codeText = independentTimingText(schedule.timingCode, schedule);
  const timingText = schedule.timingTextIsLiteral ? schedule.timingText
    : schedule.timingText === undefined ? codeText : independentTimingText(schedule.timingText, schedule);
  if (timing) {
    parts.push(timing);
  } else if (schedule.timingCode && !codeText && timingCodeMatchesRecurrence(schedule)) {
    parts.push(schedule.timingCode);
  } else if (schedule.period && schedule.periodUnit &&
      !(schedule.periodUnit === FhirPeriodUnit.Month && schedule.frequency === undefined &&
        (schedule.dayOfMonth?.length ?? 0) > 1)) {
    const base = stripTrailingZero(schedule.period);
    const qualifier =
      schedule.periodMax && schedule.periodMax !== schedule.period
        ? `${base}-${stripTrailingZero(schedule.periodMax)}`
        : base;
    parts.push(`Q${qualifier}${schedule.periodUnit.toUpperCase()}`);
  }
  if (timingText) parts.push(timingText);
  const events = collectWhenPhrasesThai(schedule);
  if (events.length) {
    parts.push(events.join(" "));
  }
  if (schedule.activityTiming?.length) parts.push(...formatActivityTimingThai(schedule));
  const eventWindow = describeEventWindowThai(schedule, words);
  if (eventWindow) parts.push(eventWindow);
  if (schedule.timeOfDay?.length) {
    const times: string[] = [];
    for (const time of schedule.timeOfDay) {
      times.push(time.slice(0, 5));
    }
    parts.push(times.join(","));
  }
  if (schedule.dayOfMonth?.length) {
    parts.push(describeDayOfMonthThai(schedule)!);
  }
  if (schedule.dayOfWeek?.length) {
    const days: string[] = [];
    for (const day of schedule.dayOfWeek) {
      days.push(DAY_NAMES_THAI[day]?.replace(/^วัน/, "") ?? day);
    }
    const ordinal = schedule.weekdayOrdinal;
    parts.push(days.join(",") + (ordinal === undefined ? "" : ordinal === -1 ? "สุดท้าย" : `ครั้งที่${ordinal}`));
  }
  if (schedule.calendarEvents?.length) {
    parts.push(`@${schedule.calendarEvents.map((event) => event.fhirDateTime ?? event.isoDate).join(",")}`);
  }
  if (schedule.boundsStart) {
    parts.push(`ตั้งแต่${schedule.boundsStart}`);
  }
  if (schedule.boundsEnd) {
    parts.push(`ถึง${schedule.boundsEnd}`);
  }
  if (schedule.countMax !== undefined) {
    parts.push(schedule.count === undefined ? `x<=${stripTrailingZero(schedule.countMax)}`
      : `x${stripTrailingZero(schedule.count)}-${stripTrailingZero(schedule.countMax)}`);
  } else if (schedule.count !== undefined) {
    parts.push(`x${stripTrailingZero(schedule.count)}`);
  }
  if (schedule.administrationDurationRange) {
    const duration = describeAdministrationDurationThai(schedule, undefined, true, words);
    if (duration) parts.push(duration);
  } else if ((schedule.administrationDuration !== undefined || schedule.administrationDurationMax !== undefined) &&
      schedule.administrationDurationUnit) {
    const max = schedule.administrationDurationMax;
    const lower = schedule.administrationDuration === undefined
      ? "<=" + stripTrailingZero(max!)
      : (schedule.administrationDurationComparator ?? "") + stripTrailingZero(schedule.administrationDuration);
    const duration = schedule.administrationDuration !== undefined && max !== undefined && max !== schedule.administrationDuration
      ? `${lower}-${stripTrailingZero(max)}`
      : lower;
    parts.push(`นาน${duration}${schedule.administrationDurationUnit}`);
  }
  const durationShort = formatDurationShortThai(schedule);
  if (durationShort) {
    parts.push(durationShort);
  }
  const asNeeded = formatAsNeededThai(clause);
  if (asNeeded) {
    parts.push(asNeeded);
  }
  if (!parts.length && clause.method)
    parts.push(resolveThaiMethodVerb(clause, resolveRouteGrammarThai(clause), resolvedMethod));
  return parts.filter(Boolean).join(" ");
}

function makeThaiRoundTripSurface(text: string): string {
  return text
    .replace(/ครั้งละ\s*/gu, " ")
    .replace(/ตอนเช้า/gu, "เช้า")
    .replace(/ตอนเที่ยง/gu, "เที่ยง")
    .replace(/ตอนกลางวัน/gu, "กลางวัน")
    .replace(/ตอนบ่าย/gu, "บ่าย")
    .replace(/ตอนเย็น/gu, "เย็น")
    .replace(/ตอนกลางคืน/gu, "กลางคืน")
    .replace(/([0-9]+(?:\.[0-9]+)?)\s+ถึง\s+([0-9]+(?:\.[0-9]+)?)/gu, "$1-$2")
        .replace(/\s+/gu, " ")
    .trim();
}

function applyThaiAdministrationModality(verb: string, clause: CanonicalSigClause): string {
  const modality = instructionGraphPrimaryAdministrationModality(clause);
  const prefix = modality ? TH_POSITIVE_MODALITY_PREFIX[modality] : undefined;
  return prefix ? `${prefix}${verb}` : verb;
}

function thaiIntegratedAdministrationQualifier(
  instruction: NonNullable<CanonicalSigClause["additionalInstructions"]>[number]
): string | undefined {
  const coding = instruction.coding;
  if (!coding?.code) return undefined;
  const definition = findAdditionalInstructionDefinitionByCoding(
    coding.system ?? "http://snomed.info/sct",
    coding.code
  );
  const declaredSuffix = definition?.verbSuffixI18n?.th?.trim();
  if (declaredSuffix) return declaredSuffix;
  const concept = getMedicationInstructionConcept(coding.code, coding.system);
  const typedStyle = concept && (
    concept.role === AdviceArgumentRole.Manner || concept.role === AdviceArgumentRole.Amount
  ) && instruction.frames?.some((frame) => frame.predicate.semanticClass === "administration");
  return typedStyle ? concept?.i18n?.th?.trim() || undefined : undefined;
}


function formatLongThai(
  clause: CanonicalSigClause,
  options?: TimingSummaryOptions,
  words: CourseLanguage = THAI_COURSE,
  resolvedMethod?: MedicationInstructionActionDefinition
): string {
  if (
    options?.realizationMode === "roundtrip" &&
    clause.instructionGraph?.sourceLocale?.toLowerCase().startsWith("th") &&
    clause.instructionGraph.sourceText.trim() && !instructionGraphSourceConflictsWithDose(clause, options) &&
    (!clause.clinicalAdjuncts?.condition || clause.sourceProjectionVerified !== false)
  ) {
    return clause.instructionGraph.sourceText.trim();
  }
  const hasCanonicalAdministration = canonicalClauseHasAdministrationSemantics(clause);
  const schedule = scheduleOf(clause);
  const grammar = resolveRouteGrammarThai(clause);
  const methodDefinition = resolvedMethod ?? resolveMedicationInstructionAction(clause.method?.text ?? "");
  const methodLocaleConfig = medicationInstructionActionLocaleRealizerConfig(
    methodDefinition?.realizerConfig,
    "th"
  );
  const baseVerb = resolveThaiMethodVerb(clause, grammar, resolvedMethod);
  const integratedQualifiers = new Map<
    NonNullable<CanonicalSigClause["additionalInstructions"]>[number],
    string
  >();
  if (options?.realizationMode !== "roundtrip") {
    for (const instruction of clause.additionalInstructions ?? []) {
      const qualifier = thaiIntegratedAdministrationQualifier(instruction);
      if (qualifier) integratedQualifiers.set(instruction, qualifier);
    }
  }
  const modalVerb = applyThaiAdministrationModality(baseVerb, clause);
  const qualifierSuffix = Array.from(integratedQualifiers.values()).join("");
  const verb = `${modalVerb}${qualifierSuffix}`;
  const distributedPerTarget = options?.realizationMode !== "roundtrip" && Boolean(perTargetSiteThai(clause));
  const preparationSuppliesDose = instructionGraphPreparationOwnsDose(clause, options);
  const explicitDosePart = preparationSuppliesDose ? undefined : distributedPerTarget || methodLocaleConfig?.directDose
    ? formatDoseThaiPerTarget(clause.dose)
    : formatDoseThaiLong(clause.dose);
  const sitePart = formatSiteThai(clause, grammar, words);
  const usesGenericMedicationObject = shouldUseGenericMedicationObjectThai(
    clause,
    baseVerb,
    explicitDosePart
  );
  const dosePart = usesGenericMedicationObject ? explicitDosePart ?? "ยา" : explicitDosePart;
  const configuredRoutePhrase = clause.route?.code
    ? methodLocaleConfig?.routePhrases?.[clause.route.code]
    : undefined;
  const routePart = shouldSuppressRoutePhraseThai(
    clause,
    baseVerb,
    Boolean(sitePart),
    explicitDosePart
  )
    ? undefined
    : configuredRoutePhrase ?? buildRoutePhraseThai(clause, grammar, Boolean(sitePart));
  const standaloneOccurrenceCount = describeStandaloneOccurrenceCountThai(schedule);
  const alternateEventCadence = options?.realizationMode !== "roundtrip"
    ? describeAlternateEventCadenceThai(schedule)
    : undefined;
  const frequencyPart =
    alternateEventCadence ??
    describeFrequencyThai(schedule, words) ??
    standaloneOccurrenceCount ??
    describeFrequencyCountThai(inferDailyOccurrenceCount(schedule, options));
  const eventParts = alternateEventCadence ? [] : collectWhenPhrasesThai(schedule, options);
  const timingText = schedule.timingTextIsLiteral ? schedule.timingText
    : independentTimingText(schedule.timingText ?? schedule.timingCode, schedule);
  if (timingText) eventParts.push(timingText);
  const eventWindowPart = describeEventWindowThai(schedule, words);
  let clockPart: string | undefined;
  if (schedule.timeOfDay?.length) {
    const timeStrings: string[] = [];
    for (const time of schedule.timeOfDay) {
      const parts = time.split(":");
      const hours = Number(parts[0]);
      const minutes = Number(parts[1]);
      if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
        continue;
      }
      const displayMinutes = minutes < 10 ? `0${minutes}` : `${minutes}`;
      const displayHours = hours < 10 ? `0${hours}` : `${hours}`;
      timeStrings.push(`${displayHours}:${displayMinutes}`);
    }
    if (timeStrings.length) {
      clockPart = `เวลา ${timeStrings.join(", ")}`;
      eventParts.push(clockPart);
    }
  }
  const timing = combineFrequencyAndEventsThai(schedule, frequencyPart, eventParts, options);
  const dayPart = describeDayOfWeekThai(schedule);
  const monthDayPart = describeDayOfMonthThai(schedule);
  const calendarEventPart = describeCalendarEventsThai(schedule);
  const calendarBoundsPart = describeCalendarBoundsThai(schedule);
  const countPart = schedule.countMax !== undefined && !standaloneOccurrenceCount
    ? schedule.count === undefined
      ? `ไม่เกิน ${stripTrailingZero(schedule.countMax)} ครั้ง`
      : schedule.count === schedule.countMax
        ? schedule.count === 1 ? "ครั้งเดียว" : `จำนวน ${stripTrailingZero(schedule.count)} ครั้ง`
        : `จำนวน ${stripTrailingZero(schedule.count)}-${stripTrailingZero(schedule.countMax)} ครั้ง`
    : schedule.count !== undefined && !standaloneOccurrenceCount
      ? schedule.count === 1
        ? "ครั้งเดียว"
        : `จำนวน ${stripTrailingZero(schedule.count)} ครั้ง`
      : undefined;
  const administrationDurationPart = describeAdministrationDurationThai(
    schedule,
    methodLocaleConfig?.administrationDurationPrefix,
    false,
    words
  );
  const durationPart = describeDurationThai(schedule, words);
  const occurrenceCapPart = describeOccurrenceCapThai(schedule);

  const timingParts = {
    frequency: timing.frequency, event: timing.event, eventWindow: eventWindowPart,
    activities: formatActivityTimingThai(schedule), calendarEvents: calendarEventPart,
    dayOfWeek: dayPart, dayOfMonth: monthDayPart, calendarBounds: calendarBoundsPart,
    count: countPart, administrationDuration: administrationDurationPart,
    duration: durationPart, occurrenceCap: occurrenceCapPart
  };

  const segments: string[] = [];
  const routePrefersEarlySite = Boolean(
    clause.route?.code && THAI_EARLY_SITE_ROUTES.has(clause.route.code) &&
    (
      baseVerb === "หยอด" ||
      clause.route.code === RouteCode["Intravitreal route (qualifier value)"]
    )
  );
  const siteFirst = Boolean(sitePart) && options?.sitePlacement !== "trailing" && (
    routePrefersEarlySite || (
      THAI_SITE_FIRST_VERBS.has(baseVerb) &&
      (explicitDosePart === undefined || distributedPerTarget) &&
      routePart === undefined
    )
  );
  const placedSitePart = siteFirst && routePrefersEarlySite
    ? sitePart?.replace(/^ที่/u, "")
    : sitePart;
  if (siteFirst && placedSitePart) {
    segments.push(placedSitePart);
  }
  if (dosePart) {
    segments.push(dosePart);
  }
  if (routePart) {
    segments.push(routePart);
  }
  appendLongAdministrationTiming(segments, timingParts);
  const prnCanAttachToVerb = segments.length === 0;
  const prnCanAttachToGenericObject = Boolean(
    usesGenericMedicationObject && !explicitDosePart &&
    segments.length === 1 && segments[0] === dosePart
  );
  const asNeeded = formatAsNeededThai(
    clause,
    prnCanAttachToVerb || prnCanAttachToGenericObject
  );
  if (asNeeded) {
    if (prnCanAttachToGenericObject) segments[0] = `${segments[0]}${asNeeded}`;
    else segments.push(asNeeded);
  }
  if (!siteFirst && sitePart) {
    segments.push(sitePart);
  }
  const body = segments.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const richPrimaryGraphAction = options?.realizationMode === "roundtrip"
    ? instructionGraphRoundTripPrimaryAction(clause) ?? instructionGraphRichPrimaryAction(clause)
    : instructionGraphRichPrimaryAction(clause);
  const richPrimaryCoverage = richPrimaryGraphAction && clause.schedule?.when?.length === 1
    ? { singleScheduledEvent: false } : undefined;
  const richPrimaryGraphText = richPrimaryGraphAction
    ? realizeRichPrimaryWithCanonicalDose(richPrimaryGraphAction, clause, "th", options, richPrimaryCoverage)
    : undefined;
  const richPrimaryCoversSingleEvent = richPrimaryCoverage?.singleScheduledEvent === true;
  const richPrimaryDefinition = richPrimaryGraphAction
    ? getMedicationInstructionAction(richPrimaryGraphAction.predicate.lemma, options)
    : undefined;
  const richPrimaryEncodesRoute = Boolean(
    clause.route?.code && richPrimaryDefinition && (
      richPrimaryDefinition.verbRouteHint === clause.route.code ||
      richPrimaryDefinition.methodRouteOverride === clause.route.code
    )
  );
  const richRoutePart = routePart ?? (
    richPrimaryGraphText && clause.route?.code && !richPrimaryEncodesRoute
      ? buildRoutePhraseThai(clause, grammar, Boolean(sitePart))
      : undefined
  );
  const graphRegimenTail = richPrimaryGraphText && richPrimaryGraphAction
    ? richGraphAdministrationTail(clause, richPrimaryGraphAction, words, timingParts, {
        route: richRoutePart, frequencyWithoutEvent: frequencyPart,
        independentTiming: timingText, clock: clockPart, asNeeded: asNeeded, site: sitePart,
        coversSingleEvent: richPrimaryCoversSingleEvent
      })
    : [];
  const richGraphAdministrationText = richPrimaryGraphText
    ? [richPrimaryGraphText, ...graphRegimenTail].filter(Boolean).join(" ").replace(/\s+/g, " ").trim()
    : undefined;
  const roundTrip = options?.realizationMode === "roundtrip";
  const positionedGraph = Boolean(clause.instructionGraph?.primaryAdministrationSpan);
  const { codedWarningSources, graphOwnedAdditional } =
    collectGraphInstructionOwnership(clause, hasCanonicalAdministration);
  const directAdditional = (clause.additionalInstructions ?? []).filter((instruction) =>
    graphOwnedAdditional.indexOf(instruction) === -1 &&
    !integratedQualifiers.has(instruction)
  );
  const additionalSemanticSourceTexts = instructionGraphAdviceSourceTexts(clause, directAdditional);
  const graphRealizationOmissions = [...additionalSemanticSourceTexts, ...codedWarningSources];
  const primaryConditions: InstructionGraphPrimaryCondition[] | undefined =
    positionedGraph && clause.instructionGraph?.relations?.length ? [] : undefined;
  const graphRealizationOptions = {
    primaryConditions,
    includeWarnings: true,
    omitCanonicalAdministration: clause,
    instructionActionMap: options?.instructionActionMap,
    preferSourceText: roundTrip,
    roundtripSafe: roundTrip,
    omitSourceTexts: graphRealizationOmissions,
    omitRenderedAction: richPrimaryGraphAction
  } as const;
  const preGraphInstruction = positionedGraph && clause.instructionGraph
    ? realizeInstructionGraph(clause.instructionGraph, "th", {
        ...graphRealizationOptions,
        position: "pre"
      })
    : undefined;
  const postGraphInstruction = positionedGraph && clause.instructionGraph
    ? realizeInstructionGraph(clause.instructionGraph, "th", {
        ...graphRealizationOptions,
        position: "post"
      })
    : undefined;
  const wholeGraphInstruction = !positionedGraph && clause.instructionGraph
    ? realizeInstructionGraph(clause.instructionGraph, "th", graphRealizationOptions)
    : undefined;

  const directInstruction = formatAdditionalInstructionsThai({
    ...clause,
    additionalInstructions: directAdditional
  });
  const { preFlowsIntoAdministration, postFlowsFromAdministration } =
    instructionGraphAdministrationFlow(clause, roundTrip, preGraphInstruction, postGraphInstruction);
  const leadingInstructionText = preFlowsIntoAdministration
    ? undefined
    : formatPatientInstructionSentence(preGraphInstruction);
  const graphInstruction = postGraphInstruction ?? wholeGraphInstruction;
  const graphContinuesWithThen = instructionGraphActionHasSequenceSuccessor(clause, richPrimaryGraphAction);
  const sequenceRelation = getUniqueAdviceRelationByGrammarFeature("defaultSequenceRelation");
  if (!sequenceRelation) throw new Error("Missing declarative default sequence relation");
  const sequenceSurface = localizeAdviceRelation(sequenceRelation, "th") ?? sequenceRelation;
  const rawGraphInstructionText = postFlowsFromAdministration
    ? undefined
    : formatPatientInstructionSentence(graphInstruction);
  const graphInstructionText = rawGraphInstructionText && graphContinuesWithThen
    ? `${sequenceSurface}${rawGraphInstructionText}`
    : rawGraphInstructionText;
  const patientSource = clause.patientInstruction?.trim();
  const patientSourceRepresented = Boolean(
    // Complete direct advice already owns these exact graph action sources.
    // Do not re-emit the shorter patient fragment after its full instruction.
    patientSource && directInstruction && additionalSemanticSourceTexts.some((source) =>
      source.toLowerCase() === patientSource.toLowerCase()
    )
  ) || Boolean(
    clause.patientInstruction &&
    clause.instructionGraph &&
    (preGraphInstruction || graphInstruction || richPrimaryGraphText) &&
    (
      instructionGraphRepresentsText(clause.instructionGraph, clause.patientInstruction) ||
      clause.instructionGraph.coverage?.complete === true
    )
  ) || Boolean(
    clause.patientInstruction && clause.instructionGraph &&
    !hasCanonicalAdministration &&
    instructionGraphFullyOwnsAdvice(clause.instructionGraph, {
      text: clause.patientInstruction, frames: []
    })
  );
  const fallbackPatientInstruction = formatPatientInstructionSentence(
    patientSourceRepresented ? undefined : clause.patientInstruction
  );
  const trailingInstructionText = [
    directInstruction,
    graphInstructionText,
    fallbackPatientInstruction
  ].filter(Boolean).join(" ").trim() || undefined;

  if (!hasCanonicalAdministration) {
    const wholeGraph = clause.instructionGraph
      ? realizeInstructionGraph(clause.instructionGraph, "th", {
          includeWarnings: true,
          omitCanonicalAdministration: clause,
          preferSourceText: roundTrip,
          roundtripSafe: roundTrip
        })
      : undefined;
    const wholeGraphText = formatPatientInstructionSentence(wholeGraph);
    const parts: string[] = [];
    for (const value of [
      leadingInstructionText, wholeGraphText, directInstruction, graphInstructionText, fallbackPatientInstruction
    ]) {
      if (!value) continue;
      const normalized = normalizeInstructionText(value);
      if (parts.some((existing) => {
        const candidate = normalizeInstructionText(existing);
        return candidate === normalized || candidate.includes(normalized) || normalized.includes(candidate);
      })) continue;
      parts.push(value);
    }
    if (clause.clinicalAdjuncts?.condition)
      parts.unshift(appendClinicalConditionText(verb, clause.clinicalAdjuncts.condition, words));
    return parts.join(" ").trim() || `${verb}.`;
  }

  const graphRepresentsDose = instructionGraphMatchesDose(clause);
  const graphCanStandAlone = instructionGraphCanStandAlone(
    clause, timingText, graphRepresentsDose, richPrimaryGraphAction,
    wholeGraphInstruction, primaryConditions
  );
  if (graphCanStandAlone) {
    const text = [directInstruction, graphInstructionText, fallbackPatientInstruction]
      .filter(Boolean).join(" ").trim();
    return clause.clinicalAdjuncts?.condition
      ? appendClinicalConditionText(text, clause.clinicalAdjuncts.condition, words) : text;
  }

  let administrationText = richGraphAdministrationText ??
    joinThaiVerbAndBody(verb, body, Boolean(qualifierSuffix));
  if (clause.clinicalAdjuncts?.condition)
    administrationText = appendClinicalConditionText(administrationText, clause.clinicalAdjuncts.condition, words)
      .replace(/[.!?]+$/u, "");
  // Independent graph conditions remain alongside the structured guard.
  if (primaryConditions?.length)
    administrationText = attachInstructionGraphPrimaryConditions(administrationText, primaryConditions, "th");
  if (preFlowsIntoAdministration && preGraphInstruction) {
    administrationText = `${preGraphInstruction} ${sequenceSurface}${administrationText}`;
  }
  if (postFlowsFromAdministration && postGraphInstruction) {
    administrationText = `${administrationText} ${sequenceSurface}${postGraphInstruction}`;
  }
  const baseSentence = /[.!?]$/u.test(administrationText)
    ? administrationText
    : `${administrationText}.`;
  const rendered = [leadingInstructionText, baseSentence, trailingInstructionText]
    .filter(Boolean).join(" ").trim();
  return roundTrip ? makeThaiRoundTripSurface(rendered) : rendered;
}

function translateCoordinatedActivityWindowThai(text: string): string | undefined {
  const parts = text.trim().toLowerCase().replace(/[.,;:!?]+$/u, "").split(/\s+/u).filter(Boolean);
  if (parts.length < 4) return undefined;
  const relation = resolveActionRelationSurface(parts[0]);
  if (!relation) return undefined;
  const connectorIndex = parts.findIndex((part, index) => index > 1 && ACTION_COORDINATION_CONNECTORS.has(part));
  if (connectorIndex < 0 || connectorIndex >= parts.length - 1) return undefined;
  const leftSurface = parts.slice(1, connectorIndex).join(" ");
  const rightSurface = parts.slice(connectorIndex + 1).join(" ");
  const left = resolveMedicationInstructionConcept(leftSurface);
  const right = resolveMedicationInstructionConcept(rightSurface);
  if (left?.role !== AdviceArgumentRole.Activity || right?.role !== AdviceArgumentRole.Activity) return undefined;
  const leftTh = left.i18n?.th;
  const rightTh = right.i18n?.th;
  const relationTh = localizeAdviceRelation(relation, "th");
  const connectorTh = ACTION_COORDINATION_CONNECTOR_I18N[parts[connectorIndex]]?.th;
  if (!leftTh || !rightTh || !relationTh || !connectorTh) return undefined;
  return `${relationTh}${leftTh}${connectorTh}${rightTh}`;
}

function realizeAdviceFramesThai(frames: AdviceFrame[]): string | undefined {
  let localizedFrames: AdviceFrame[] | undefined;
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
    const frame = frames[frameIndex];
    let localizedFrame: AdviceFrame | undefined;
    for (let index = 0; index < frame.args.length; index++) {
      const argument = frame.args[index];
      if (!argument.conceptId || argument.i18n?.th) continue;
      const shared = resolveMedicationInstructionConcept(argument.text);
      // An exact shared nominal can supply a missing locale facet. A contained
      // noun must not erase an opaque qualification such as "cool water".
      if (shared?.code !== argument.conceptId || shared.role !== argument.role || !shared.i18n?.th) continue;
      localizedFrames ??= frames.slice();
      localizedFrame ??= { ...frame, args: frame.args.slice() };
      localizedFrame.args[index] = { ...argument, i18n: { ...shared.i18n, ...(argument.i18n ?? {}) } };
      localizedFrames[frameIndex] = localizedFrame;
    }
  }
  return realizeAdviceFramesText(localizedFrames ?? frames, "th");
}

function reconstructAdditionalInstructionThai(text: string): string | undefined {
  const parsed = parseAdditionalInstructions(text, { start: 0, end: text.length }, {
    defaultPredicate: "take",
    defaultForce: AdviceForce.Instruction,
    allowFreeTextFallback: false
  });
  for (const instruction of parsed) {
    if (!instruction.frames?.length) continue;
    const realized = realizeAdviceFramesThai(instruction.frames);
    if (realized && /[\u0E00-\u0E7F]/u.test(realized)) return realized;
  }
  return undefined;
}

function formatAdditionalInstructionsThai(clause: CanonicalSigClause): string | undefined {
  const instructions = clause.additionalInstructions ?? [];
  if (!instructions.length) {
    return undefined;
  }
  const phrases: string[] = [];
  const grammar = resolveRouteGrammarThai(clause);
  const verb = resolveThaiMethodVerb(clause, grammar);
  for (const instruction of instructions) {
    if (instruction.coding?.code === SLOWLY_QUALIFIER_CODE) {
      const contextual = verb ? `${verb}ช้าๆ` : "ช้าๆ";
      phrases.push(contextual);
      continue;
    }
    if (isEmptyStomachInstruction(instruction)) {
      phrases.push("ขณะท้องว่าง");
      continue;
    }
    let text = instruction.i18n?.th ??
      (instruction.frames?.length ? realizeAdviceFramesThai(instruction.frames) : undefined) ??
      (instruction.text ? THAI_ADMINISTRATION_WINDOW_TRANSLATIONS.get(instruction.text.toLowerCase().trim()) : undefined) ??
      (instruction.text ? translateCoordinatedActivityWindowThai(instruction.text) : undefined) ??
      (instruction.text ? reconstructAdditionalInstructionThai(instruction.text) : undefined) ??
      instruction.text ?? instruction.coding?.display;
    if (!instruction.i18n?.th && instruction.coding?.code) {
      const concept = getMedicationInstructionConcept(instruction.coding.code, instruction.coding.system);
      const definition = findAdditionalInstructionDefinitionByCoding(
        instruction.coding.system ?? "http://snomed.info/sct",
        instruction.coding.code
      );
      text = concept?.i18n?.th ?? definition?.i18n?.th ?? text;
    }
    if (!text) {
      continue;
    }
    const trimmed = text.trim();
    if (trimmed) {
      phrases.push(trimmed);
    }
  }
  if (!phrases.length) {
    return undefined;
  }
  return phrases.map((phrase) => (/[.!?]$/.test(phrase) ? phrase : `${phrase}.`)).join(" ").trim();
}

function formatPatientInstructionSentence(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }
  const sentence = /^[.!?]$/.test(trimmed.slice(-1)) ? trimmed : `${trimmed}.`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
