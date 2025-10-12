import type { SigTranslationConfig } from "./i18n";

export interface FhirCoding {
  system?: string;
  code?: string;
  display?: string;
}

export interface FhirCodeableConcept {
  coding?: FhirCoding[];
  text?: string;
}

export interface FhirQuantity {
  value?: number;
  unit?: string;
}

export interface FhirRange {
  low?: FhirQuantity;
  high?: FhirQuantity;
}

export interface FhirRatio {
  numerator?: FhirQuantity;
  denominator?: FhirQuantity;
}

/**
 * Follows https://build.fhir.org/valueset-event-timing.html
 * Real-world event relating to the schedule.
 */
export enum EventTiming {
  "Before Sleep" = "HS",
  Wake = "WAKE",
  Meal = "C",
  Breakfast = "CM",
  Lunch = "CD",
  Dinner = "CV",
  "Before Meal" = "AC",
  "Before Breakfast" = "ACM",
  "Before Lunch" = "ACD",
  "Before Dinner" = "ACV",
  "After Meal" = "PC",
  "After Breakfast" = "PCM",
  "After Lunch" = "PCD",
  "After Dinner" = "PCV",
  Morning = "MORN",
  "Early Morning" = "MORN.early",
  "Late Morning" = "MORN.late",
  Noon = "NOON",
  Afternoon = "AFT",
  "Early Afternoon" = "AFT.early",
  "Late Afternoon" = "AFT.late",
  Evening = "EVE",
  "Early Evening" = "EVE.early",
  "Late Evening" = "EVE.late",
  Night = "NIGHT",
  "After Sleep" = "PHS",
  Immediate = "IMD"
}

/**
 * SNOMED CT route codes aligned with the official "route of administration values" value set.
 * Keeping the enumeration exhaustive ensures downstream consumers can rely on strong typing.
 */
export enum SNOMEDCTRouteCodes {
  "Topical route" = "6064005",
  "Otic route" = "10547007",
  "Intra-articular route" = "12130007",
  "Per vagina" = "16857009",
  "Oral route" = "26643006",
  "Subcutaneous route" = "34206005",
  "Per rectum" = "37161004",
  "Intraluminal route" = "37737002",
  "Sublingual route" = "37839007",
  "Intraperitoneal route" = "38239002",
  "Transdermal route" = "45890007",
  "Nasal route" = "46713006",
  "Intravenous route" = "47625008",
  "Buccal route" = "54471007",
  "Ophthalmic route" = "54485002",
  "Intra-arterial route" = "58100008",
  "Intramedullary route" = "60213007",
  "Intrauterine route" = "62226000",
  "Intrathecal route" = "72607000",
  "Intramuscular route" = "78421000",
  "Urethral route" = "90028008",
  "Gastrostomy route" = "127490009",
  "Jejunostomy route" = "127491008",
  "Nasogastric route" = "127492001",
  "Dental use" = "372449004",
  "Endocervical use" = "372450004",
  "Endosinusial use" = "372451000",
  "Endotracheopulmonary use" = "372452007",
  "Extra-amniotic use" = "372453002",
  "Gastroenteral use" = "372454008",
  "Gingival use" = "372457001",
  "Intraamniotic use" = "372458006",
  "Intrabursal use" = "372459003",
  "Intracardiac use" = "372460008",
  "Intracavernous use" = "372461007",
  "Intracervical route (qualifier value)" = "372462000",
  "Intracoronary use" = "372463005",
  "Intradermal use" = "372464004",
  "Intradiscal use" = "372465003",
  "Intralesional use" = "372466002",
  "Intralymphatic use" = "372467006",
  "Intraocular use" = "372468001",
  "Intrapleural use" = "372469009",
  "Intrasternal use" = "372470005",
  "Intravesical use" = "372471009",
  "Ocular route (qualifier value)" = "372472002",
  "Oromucosal use" = "372473007",
  "Periarticular use" = "372474001",
  "Perineural use" = "372475000",
  "Subconjunctival use" = "372476004",
  "Transmucosal route (qualifier value)" = "404815008",
  "Intratracheal route (qualifier value)" = "404818005",
  "Intrabiliary route (qualifier value)" = "404819002",
  "Epidural route (qualifier value)" = "404820008",
  "Suborbital route (qualifier value)" = "416174007",
  "Caudal route (qualifier value)" = "417070009",
  "Intraosseous route (qualifier value)" = "417255000",
  "Intrathoracic route (qualifier value)" = "417950001",
  "Enteral route (qualifier value)" = "417985001",
  "Intraductal route (qualifier value)" = "417989007",
  "Intratympanic route (qualifier value)" = "418091004",
  "Intravenous central route (qualifier value)" = "418114005",
  "Intramyometrial route (qualifier value)" = "418133000",
  "Gastro-intestinal stoma route (qualifier value)" = "418136008",
  "Colostomy route (qualifier value)" = "418162004",
  "Periurethral route (qualifier value)" = "418204005",
  "Intracoronal route (qualifier value)" = "418287000",
  "Retrobulbar route (qualifier value)" = "418321004",
  "Intracartilaginous route (qualifier value)" = "418331006",
  "Intravitreal route (qualifier value)" = "418401004",
  "Intraspinal route (qualifier value)" = "418418000",
  "Orogastric route (qualifier value)" = "418441008",
  "Transurethral route (qualifier value)" = "418511008",
  "Intratendinous route (qualifier value)" = "418586008",
  "Intracorneal route (qualifier value)" = "418608002",
  "Oropharyngeal route (qualifier value)" = "418664002",
  "Peribulbar route (qualifier value)" = "418722009",
  "Nasojejunal route (qualifier value)" = "418730005",
  "Fistula route (qualifier value)" = "418743005",
  "Surgical drain route (qualifier value)" = "418813001",
  "Intracameral route (qualifier value)" = "418821007",
  "Paracervical route (qualifier value)" = "418851001",
  "Intrasynovial route (qualifier value)" = "418877009",
  "Intraduodenal route (qualifier value)" = "418887008",
  "Intracisternal route (qualifier value)" = "418892005",
  "Intratesticular route (qualifier value)" = "418947002",
  "Intracranial route (qualifier value)" = "418987007",
  "Tumour cavity route" = "419021003",
  "Paravertebral route (qualifier value)" = "419165009",
  "Intrasinal route (qualifier value)" = "419231003",
  "Transcervical route (qualifier value)" = "419243002",
  "Subtendinous route (qualifier value)" = "419320008",
  "Intraabdominal route (qualifier value)" = "419396008",
  "Subgingival route (qualifier value)" = "419601003",
  "Intraovarian route (qualifier value)" = "419631009",
  "Ureteral route (qualifier value)" = "419684008",
  "Peritendinous route (qualifier value)" = "419762003",
  "Intrabronchial route (qualifier value)" = "419778001",
  "Intraprostatic route (qualifier value)" = "419810008",
  "Submucosal route (qualifier value)" = "419874009",
  "Surgical cavity route (qualifier value)" = "419894000",
  "Ileostomy route (qualifier value)" = "419954003",
  "Intravenous peripheral route (qualifier value)" = "419993007",
  "Periosteal route (qualifier value)" = "420047004",
  "Esophagostomy route" = "420163009",
  "Urostomy route (qualifier value)" = "420168000",
  "Laryngeal route (qualifier value)" = "420185003",
  "Intrapulmonary route (qualifier value)" = "420201002",
  "Mucous fistula route (qualifier value)" = "420204005",
  "Nasoduodenal route (qualifier value)" = "420218003",
  "Body cavity route" = "420254004",
  "A route that begins within a non-pathologic hollow cavity, such as that of the abdominal cavity or uterus." = "420254004",
  "Intraventricular route - cardiac (qualifier value)" = "420287000",
  "Intracerebroventricular route (qualifier value)" = "420719007",
  "Percutaneous route (qualifier value)" = "428191002",
  "Interstitial route (qualifier value)" = "429817007",
  "Intraesophageal route (qualifier value)" = "445752009",
  "Intragingival route (qualifier value)" = "445754005",
  "Intravascular route (qualifier value)" = "445755006",
  "Intradural route (qualifier value)" = "445756007",
  "Intragastric route (qualifier value)" = "445768003",
  "Intrapericardial route (qualifier value)" = "445771006",
  "Intralingual route (qualifier value)" = "445913005",
  "Intrahepatic route (qualifier value)" = "445941009",
  "Conjunctival route (qualifier value)" = "446105004",
  "Intraepicardial route (qualifier value)" = "446407004",
  "Transendocardial route (qualifier value)" = "446435000",
  "Transplacental route (qualifier value)" = "446442000",
  "Intracerebral route (qualifier value)" = "446540005",
  "Intraileal route (qualifier value)" = "447026006",
  "Periodontal route (qualifier value)" = "447052000",
  "Peridural route (qualifier value)" = "447080003",
  "Lower respiratory tract route (qualifier value)" = "447081004",
  "Intramammary route (qualifier value)" = "447121004",
  "Intratumor route (qualifier value)" = "447122006",
  "Transtympanic route (qualifier value)" = "447227007",
  "Transtracheal route (qualifier value)" = "447229005",
  "Respiratory tract route (qualifier value)" = "447694001",
  "Digestive tract route (qualifier value)" = "447964005",
  "Intraepidermal route (qualifier value)" = "448077001",
  "Intrajejunal route (qualifier value)" = "448491004",
  "Intracolonic route (qualifier value)" = "448492006",
  "Cutaneous route (qualifier value)" = "448598008",
  "Arteriovenous fistula route (qualifier value)" = "697971008",
  "Intraneural route (qualifier value)" = "711360002",
  "Intramural route (qualifier value)" = "711378007",
  "Extracorporeal route (qualifier value)" = "714743009",
  "Infiltration route (qualifier value)" = "718329006",
  "Epilesional route (qualifier value)" = "764723001",
  "Extracorporeal hemodialysis route (qualifier value)" = "766790006",
  "Intradialytic route" = "876824003",
  "Intracatheter instillation route (qualifier value)" = "1078280005",
  "Suprachoroidal route" = "1254769004",
  "Intracorporus cavernosum route (qualifier value)" = "1259221004",
  "Sublesional route (qualifier value)" = "1611000175109",
  "Intestinal route (qualifier value)" = "58731000052100",
  "Intraglandular route (qualifier value)" = "58751000052109",
  "Intracholangiopancreatic route" = "58761000052107",
  "Intraportal route" = "58771000052103",
  "Peritumoral route (qualifier value)" = "58811000052103",
  "Posterior juxtascleral route (qualifier value)" = "58821000052106",
  "Subretinal route (qualifier value)" = "58831000052108",
  "Sublabial use" = "66621000052103"
}

export enum FhirPeriodUnit {
  Second = "s",
  Minute = "min",
  Hour = "h",
  Day = "d",
  Week = "wk",
  Month = "mo",
  Year = "a"
}

export enum FhirDayOfWeek {
  Monday = "mon",
  Tuesday = "tue",
  Wednesday = "wed",
  Thursday = "thu",
  Friday = "fri",
  Saturday = "sat",
  Sunday = "sun"
}

export interface FhirTimingRepeat {
  count?: number;
  frequency?: number;
  frequencyMax?: number;
  period?: number;
  periodMax?: number;
  periodUnit?: FhirPeriodUnit;
  dayOfWeek?: FhirDayOfWeek[];
  timeOfDay?: string[];
  when?: EventTiming[];
  offset?: number;
}

export interface FhirTiming {
  event?: string[];
  repeat?: FhirTimingRepeat;
  code?: FhirCodeableConcept;
}

export interface FhirDoseAndRate {
  type?: FhirCodeableConcept;
  doseRange?: FhirRange;
  doseQuantity?: FhirQuantity;
  rateRatio?: FhirRatio;
  rateRange?: FhirRange;
  rateQuantity?: FhirQuantity;
}

export interface FhirDosage {
  text?: string;
  timing?: FhirTiming;
  route?: FhirCodeableConcept;
  site?: FhirCodeableConcept;
  asNeededBoolean?: boolean;
  asNeededFor?: FhirCodeableConcept[];
  doseAndRate?: FhirDoseAndRate[];
}

export type RouteCode = SNOMEDCTRouteCodes;
export const RouteCode = SNOMEDCTRouteCodes;

export interface MedicationContext {
  dosageForm?: string;
  strengthQuantity?: FhirQuantity;
  strengthRatio?: FhirRatio;
  strengthCodeableConcept?: FhirCodeableConcept;
  containerValue?: number;
  containerUnit?: string;
  defaultUnit?: string;
}

export interface FormatOptions {
  locale?: "en" | "th" | string;
  i18n?: SigTranslationConfig;
}

export interface BodySiteCode {
  code: string;
  display?: string;
  system?: string;
}

export interface BodySiteDefinition {
  coding: BodySiteCode;
  text?: string;
}

export interface TextRange {
  /** Inclusive start index of the matched substring within the original input. */
  start: number;
  /** Exclusive end index of the matched substring within the original input. */
  end: number;
}

export interface SiteCodeLookupRequest {
  /** Original site text preserved for debugging or auditing. */
  originalText: string;
  /**
   * Sanitized site text used for human-readable output. Connectors and braces
   * are stripped but casing is preserved.
   */
  text: string;
  /** Lower-case variant of the text for case-insensitive lookups. */
  normalized: string;
  /** Canonical key generated by trimming and collapsing whitespace. */
  canonical: string;
  /** Indicates the text was wrapped in `{}` to request interactive lookup. */
  isProbe: boolean;
  /** Full original input string provided to the parser. */
  inputText: string;
  /**
   * Substring captured directly from the original input, preserving spacing and
   * casing. Undefined when a reliable slice cannot be determined.
   */
  sourceText?: string;
  /** Location of {@link sourceText} relative to the original input. */
  range?: TextRange;
}

export interface SiteCodeResolution extends BodySiteDefinition {}

export interface SiteCodeSuggestion {
  coding: BodySiteCode;
  text?: string;
}

export interface SiteCodeSuggestionsResult {
  suggestions: SiteCodeSuggestion[];
}

/**
 * Site code resolvers can perform deterministic lookups or remote queries with
 * access to the original sig text and extracted site range.
 */
export type SiteCodeResolver = (
  request: SiteCodeLookupRequest
) =>
  | SiteCodeResolution
  | null
  | undefined
  | Promise<SiteCodeResolution | null | undefined>;

/**
 * Suggestion providers receive the same context as resolvers, including the
 * caller's full input and the character range of the detected site phrase.
 */
export type SiteCodeSuggestionResolver = (
  request: SiteCodeLookupRequest
) =>
  | SiteCodeSuggestionsResult
  | SiteCodeSuggestion[]
  | SiteCodeSuggestion
  | null
  | undefined
  | Promise<SiteCodeSuggestionsResult | SiteCodeSuggestion[] | SiteCodeSuggestion | null | undefined>;

export interface ParseOptions extends FormatOptions {
  /**
   * Optional medication context that assists with default unit inference.
   * May be omitted or explicitly set to null when no contextual clues exist.
   */
  context?: MedicationContext | null;
  routeMap?: Record<string, RouteCode>;
  unitMap?: Record<string, string>;
  freqMap?: Record<
    string,
    {
      timesPerDay?: number;
      intervalHours?: number;
      intervalDays?: number;
      intervalWeeks?: number;
    }
  >;
  whenMap?: Record<string, EventTiming>;
  /**
   * Allows supplying institution-specific event clock anchors so parsed
   * EventTiming arrays can be ordered chronologically for that locale.
   */
  eventClock?: EventClockMap;
  allowDiscouraged?: boolean;
  /**
   * When enabled the parser will expand generic meal timing tokens (AC/PC/C)
   * into specific breakfast/lunch/dinner (and bedtime) EventTiming entries
   * based on the detected daily frequency.
   */
  smartMealExpansion?: boolean;
  /**
   * Controls which meal pair is assumed for twice-daily meal expansions.
   * Defaults to "breakfast+dinner" to mirror common clinical practice.
   */
  twoPerDayPair?: "breakfast+dinner" | "breakfast+lunch";
  /**
   * Allows disabling recognition of household volume units such as teaspoon
   * and tablespoon when set to false. Defaults to true.
   */
  allowHouseholdVolumeUnits?: boolean;
  /**
   * Allows mapping normalized site phrases (e.g., "left arm") to
   * institution-specific codings. Keys are normalized with the same logic as
   * the default site dictionary (trimmed, lower-cased, collapsing whitespace).
   */
  siteCodeMap?: Record<string, BodySiteDefinition>;
  /**
   * Callback(s) that can translate detected site text into a coded body site.
   * Return a promise when using asynchronous terminology services.
   */
  siteCodeResolvers?: SiteCodeResolver | SiteCodeResolver[];
  /**
   * Callback(s) that surface possible coded body sites for interactive flows
   * when the parser cannot confidently resolve a site, or the input explicitly
   * requested a lookup via `{site}` placeholders.
   */
  siteCodeSuggestionResolvers?: SiteCodeSuggestionResolver | SiteCodeSuggestionResolver[];
}

export interface ParseResult {
  fhir: FhirDosage;
  shortText: string;
  longText: string;
  warnings: string[];
  meta: {
    consumedTokens: string[];
    leftoverText?: string;
    normalized: {
      route?: RouteCode;
      unit?: string;
      site?: { text?: string; coding?: BodySiteCode };
    };
    siteLookups?: Array<{
      request: SiteCodeLookupRequest;
      suggestions: SiteCodeSuggestion[];
    }>;
  };
}

/**
 * Maps EventTiming codes (or other institution-specific timing strings) to
 * 24-hour clock representations such as "08:00".
 */
export type EventClockMap = Record<string, string>;

/**
 * Meal timing offsets (in minutes) applied to broader AC/PC EventTiming codes.
 */
export type MealOffsetMap = Record<string, number>;

/**
 * Frequency fallback definitions used when no explicit EventTiming or interval
 * exists. Keys can be timing codes (e.g., "BID") or custom frequency tokens
 * such as "freq:2/d".
 */
export interface FrequencyFallbackTimes {
  byCode?: Record<string, string[]>;
  byFrequency?: Record<string, string[]>;
}

/**
 * Shared configuration required to generate next-due dose timestamps.
 */
export interface NextDueDoseConfig {
  timeZone?: string;
  eventClock?: EventClockMap;
  mealOffsets?: MealOffsetMap;
  frequencyDefaults?: FrequencyFallbackTimes;
}

/**
 * Options bag for next-due dose generation.
 */
export interface NextDueDoseOptions {
  from: Date | string;
  orderedAt?: Date | string;
  limit?: number;
  priorCount?: number;
  timeZone?: string;
  eventClock?: EventClockMap;
  mealOffsets?: MealOffsetMap;
  frequencyDefaults?: FrequencyFallbackTimes;
  config?: NextDueDoseConfig;
}
