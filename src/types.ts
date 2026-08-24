import type { SigTranslationConfig } from "./i18n";

export interface FhirCoding {
  system?: string;
  code?: string;
  display?: string;
  extension?: FhirExtension[];
  _display?: FhirPrimitiveElement;
  i18n?: Record<string, string>;
}

export interface FhirCodeableConcept {
  coding?: FhirCoding[];
  text?: string;
  extension?: FhirExtension[];
  _text?: FhirPrimitiveElement;
}

export interface FhirExtension {
  url: string;
  extension?: FhirExtension[];
  valueCode?: string;
  valueString?: string;
  valueBoolean?: boolean;
  valueInteger?: number;
  valueDecimal?: number;
  valueQuantity?: FhirQuantity;
  valueCoding?: FhirCoding;
  valueCodeableConcept?: FhirCodeableConcept;
}

export interface FhirElement {
  id?: string;
  extension?: FhirExtension[];
}

export interface FhirBackboneElement extends FhirElement {
  modifierExtension?: FhirExtension[];
}

export interface FhirPrimitiveElement {
  extension?: FhirExtension[];
}

export interface FhirQuantity {
  value?: number;
  unit?: string;
  system?: string;
  code?: string;
}

export type DoseUnitKind =
  | "metric"
  | "biologic_unit"
  | "counted_presentation"
  | "device_actuation"
  | "infusion_rate"
  | "product_specific_amount"
  | "length_of_product"
  | "body_area_proxy"
  | "qualitative_amount";

export type DoseUnitApproximationConfidence =
  | "exact"
  | "approximate"
  | "product_specific";

export interface DoseUnitApproximation {
  value: number;
  unit: string;
  confidence: DoseUnitApproximationConfidence;
  basis: string;
  source?: string;
}

export interface DoseUnitTerminologyEntry {
  unit: string;
  kind: DoseUnitKind;
  aliases?: string[];
  /**
   * Defaults to true. Use false for terminology entries such as infusion-rate
   * units that should be exposed to consumers but must not be accepted as a
   * doseQuantity unit until rateQuantity parsing is implemented.
   */
  parseAsDose?: boolean;
  approximateQuantity?: DoseUnitApproximation;
}

export interface DoseUnitSemantics {
  unit: string;
  kind: DoseUnitKind;
  parseAsDose?: boolean;
  approximateQuantity?: DoseUnitApproximation;
}

export interface EstimatedQuantity extends FhirQuantity {
  confidence?: DoseUnitApproximationConfidence;
  basis?: string;
  source?: string;
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

export interface FhirPeriod {
  start?: string;
  end?: string;
}

export interface FhirTimingRepeat extends FhirElement {
  count?: number;
  countMax?: number;
  boundsDuration?: FhirQuantity;
  boundsPeriod?: FhirPeriod;
  boundsRange?: FhirRange;
  frequency?: number;
  frequencyMax?: number;
  period?: number;
  periodMax?: number;
  periodUnit?: FhirPeriodUnit;
  dayOfWeek?: FhirDayOfWeek[];
  timeOfDay?: string[];
  when?: EventTiming[];
  /** Exact event offset in minutes. */
  offset?: number;
}

export interface FhirTiming {
  event?: string[];
  repeat?: FhirTimingRepeat;
  code?: FhirCodeableConcept;
}

export interface FhirDoseAndRate extends FhirBackboneElement {
  type?: FhirCodeableConcept;
  doseRange?: FhirRange;
  doseQuantity?: FhirQuantity;
  rateRatio?: FhirRatio;
  rateRange?: FhirRange;
  rateQuantity?: FhirQuantity;
}

export interface FhirDosage extends FhirBackboneElement {
  text?: string;
  patientInstruction?: string;
  timing?: FhirTiming;
  route?: FhirCodeableConcept;
  site?: FhirCodeableConcept;
  method?: FhirCodeableConcept;
  additionalInstruction?: FhirCodeableConcept[];
  asNeededBoolean?: boolean;
  asNeededFor?: FhirCodeableConcept[];
  doseAndRate?: FhirDoseAndRate[];
}

export type RouteCode = SNOMEDCTRouteCodes;
export const RouteCode = SNOMEDCTRouteCodes;

export interface MedicationContext {
  dosageForm?: string;
  /**
   * Optional anatomical context used to disambiguate shorthand body-site
   * phrases, e.g. Thai "ระหว่างนิ้ว" can mean fingers by default but toes
   * when the active context is foot/feet/toes.
   */
  bodySiteContext?: string;
  /** "Simple" strength string; might be the only way strength is provided
   * for discrete units this is the amount of medication for unit e.g. "500 mg" (1 tablet), or for mixed tablets might be like "400 mg + 80 mg"
   * for things like creams or fluids or syrupsit might be "2%", 5 g/100g, 100mg/ 100 g, 262 mg/15 mL, 200 mg/2 mL, 1 mg/dL, or "400 mg/5mL + 80 mg/5mL"
   * In the "x + y" case, the strengthQuantity/strengthRatio will be the sum of the two ingredients.
   */
  strength?: string;
  strengthQuantity?: FhirQuantity;
  strengthRatio?: FhirRatio;
  strengthCodeableConcept?: FhirCodeableConcept;
  /**
   * Canonical presentation/package unit for fractional package instructions
   * such as "1/2 bottle". When the parsed dose unit matches this value,
   * containerValue/containerUnit describe the inner amount held by one package.
   */
  packageUnit?: string;
  /**
   * Optional per-unit approximation overrides keyed by normalized dose unit
   * (for example FTU, drop, pump, applicatorful). These are used only for
   * estimated amount reporting; they do not rewrite the parsed dose unit.
   */
  unitApproximationMap?: Record<string, DoseUnitApproximation>;
  containerValue?: number;
  containerUnit?: string;
  defaultUnit?: string;
  mealRelation?:
  | (typeof EventTiming)["Before Meal"]
  | (typeof EventTiming)["After Meal"]
  | (typeof EventTiming)["Meal"];
}

export interface FormatOptions {
  locale?: "en" | "th" | string;
  /**
   * `normalized` favors compact natural wording. `roundtrip` stays human-readable
   * but emits explicit attachment/route cues so parse -> realize -> parse can
   * preserve canonical semantics. Defaults to `normalized`.
   */
  realizationMode?: "normalized" | "roundtrip";
  i18n?: SigTranslationConfig;
  /**
   * Collapses repeated meal relation phrases into a grouped phrase when all
   * meal anchors share the same relation (for example, "after breakfast,
   * lunch and dinner" instead of repeating "after" for each meal).
   */
  groupMealTimingsByRelation?: boolean;
  /**
   * Adds a per-day frequency summary when it can be derived safely from the
   * schedule (for example, "three times daily" or "วันละ 3 ครั้ง").
   */
  includeTimesPerDaySummary?: boolean;
  /** Thai long-text site placement. `natural` uses route-sensitive Thai word order; `trailing` preserves the legacy trailing site phrase. */
  sitePlacement?: "natural" | "trailing";
}

export interface FormatBatchOptions extends FormatOptions {
  /**
   * String inserted between formatted clauses. Defaults to ", " so output can
   * be fed back into `parseSig` as a multi-clause instruction.
   */
  separator?: string;
}

export interface BodySiteCode {
  code: string;
  display?: string;
  system?: string;
  i18n?: Record<string, string>;
}

export interface BodySiteSpatialRelation {
  relationText: string;
  relationCoding?: FhirCoding;
  targetText?: string;
  targetCoding?: BodySiteCode;
  sourceText?: string;
}

export interface BodySiteDefinition {
  coding?: BodySiteCode;
  text?: string;
  spatialRelation?: BodySiteSpatialRelation;
  routeHint?: RouteCode;
  administrationTargetCount?: number;
  /** Optional translations for different locales (e.g., { "th": "ตา" }) */
  i18n?: Record<string, string>;
  /**
   * Optional phrases that should resolve to the same coding as this entry.
   * Aliases are normalized with the same logic as map keys so callers can
   * provide punctuation-heavy variants such as "first bicuspid, left".
   */
  aliases?: readonly string[];
}

export interface CodeableConceptDefinition {
  coding?: FhirCoding;
  text?: string;
  aliases?: readonly string[];
  /** Optional translations for different locales (e.g., { "th": "ปวด" }) */
  i18n?: Record<string, string>;
}

export interface SymptomDefinition extends CodeableConceptDefinition {
  /** Locale-specific surface proposition used after a conditional such as Thai `เมื่อ`. */
  conditionI18n?: Record<string, string>;
}

/** Backward-compatible PRN view of the shared symptom terminology. */
export interface PrnReasonDefinition extends SymptomDefinition {}

export interface AdditionalInstructionDefinition
  extends CodeableConceptDefinition {
  /** Locale-specific suffix appended directly to the administration verb. */
  verbSuffixI18n?: Record<string, string>;
}

export enum AdvicePolarity {
  Affirm = "affirm",
  Negate = "negate"
}

export enum AdviceForce {
  Instruction = "instruction",
  Warning = "warning",
  Caution = "caution",
  Sequence = "sequence"
}

export enum AdviceModality {
  May = "may",
  Can = "can",
  Might = "might",
  Could = "could",
  Should = "should",
  Must = "must"
}

export enum AdviceRelation {
  With = "with",
  Without = "without",
  Before = "before",
  After = "after",
  During = "during",
  Between = "between",
  Then = "then",
  Until = "until",
  For = "for",
  In = "in",
  Into = "into",
  On = "on",
  To = "to",
  If = "if",
  Unless = "unless",
  When = "when",
  While = "while"
}

export enum AdviceArgumentRole {
  Theme = "theme",
  Object = "object",
  Substance = "substance",
  MealState = "meal_state",
  Activity = "activity",
  Material = "material",
  Site = "site",
  Destination = "destination",
  Result = "result",
  Container = "container",
  Manner = "manner",
  Amount = "amount",
  Duration = "duration",
  Time = "time",
  Free = "free"
}

export interface AdviceArgument {
  role: AdviceArgumentRole;
  text: string;
  normalized?: string;
  conceptId?: string;
  coding?: FhirCoding;
  codings?: FhirCoding[];
  i18n?: Record<string, string>;
  quantity?: {
    value?: number;
    range?: CanonicalDoseRange;
    unit?: string;
  };
  span?: TextRange;
}

export interface AdviceFrame {
  force: AdviceForce;
  polarity?: AdvicePolarity;
  modality?: AdviceModality;
  predicate: {
    lemma: string;
    semanticClass?: string;
    display?: string;
    i18n?: Record<string, string>;
    /** Persisted realization profile so caller-owned actions remain deterministic after parse/FHIR round-trip. */
    realizer?: MedicationInstructionActionRealizer;
    realizerConfig?: {
      thaiFallbackObject?: string;
      thaiSuppressActivityConcepts?: string[];
    };
    /** Internal/custom action coding followed by any trustworthy external mappings. */
    codings?: FhirCoding[];
  };
  relation?: AdviceRelation;
  args: AdviceArgument[];
  span: TextRange;
  sourceText: string;
  sequenceIndex?: number;
  origin?: "grammar" | "semantic-resolver";
  confidence?: number;
  coding?: FhirCoding;
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
  /**
   * Parsed spatial relation when the site phrase is relation + body site
   * (for example, "below ear" or "top of hand"). Terminology callbacks can
   * use this to code either the full site phrase or the relation target.
   */
  spatialRelation?: BodySiteSpatialRelation;
}

export interface SiteCodeResolution extends BodySiteDefinition { }

export interface SiteCodeSuggestion {
  coding: BodySiteCode;
  text?: string;
}

export interface SiteCodeSuggestionsResult {
  suggestions: SiteCodeSuggestion[];
}

/**
 * PRN reason lookup context. For located reasons such as "pain at hand",
 * `headCanonical` is the symptom head ("pain"), `locativeSiteCanonical` is the
 * parsed site key when known ("hand"), `locativeSiteCoding` is preferred for
 * coded SNOMED/FHIR output when present, and `locativeSiteSpatialRelation`
 * carries modifiers such as "below ear" that refine the locative site.
 */
export interface PrnReasonLookupRequest {
  originalText: string;
  text: string;
  normalized: string;
  canonical: string;
  headCanonical?: string;
  locativeSiteCanonical?: string;
  locativeSiteCoding?: FhirCoding;
  locativeSiteSpatialRelation?: BodySiteSpatialRelation;
  isProbe: boolean;
  inputText: string;
  sourceText?: string;
  range?: TextRange;
}

export interface PrnReasonSelection {
  canonical?: string;
  text?: string;
  range?: TextRange;
  resolution: PrnReasonDefinition;
}

export interface PrnReasonSuggestion {
  coding?: FhirCoding;
  text?: string;
}

export interface PrnReasonSuggestionsResult {
  suggestions: PrnReasonSuggestion[];
}

export type PrnReasonResolver = (
  request: PrnReasonLookupRequest
) =>
  | PrnReasonDefinition
  | null
  | undefined
  | Promise<PrnReasonDefinition | null | undefined>;

export type PrnReasonSuggestionResolver = (
  request: PrnReasonLookupRequest
) =>
  | PrnReasonSuggestionsResult
  | PrnReasonSuggestion[]
  | PrnReasonSuggestion
  | null
  | undefined
  | Promise<
    | PrnReasonSuggestionsResult
    | PrnReasonSuggestion[]
    | PrnReasonSuggestion
    | null
    | undefined
  >;

/**
 * Allows callers to override the parser's automatic site resolution for a
 * specific match. Matches can be scoped by the normalized phrase, the original
 * sanitized text, or the exact character range that was detected.
 */
export interface SiteCodeSelection {
  /** Canonical key (punctuation stripped, lower-case) that should trigger this selection. */
  canonical?: string;
  /**
   * Human-friendly site text used to match the extracted phrase. It is
   * normalized with the same logic as canonical keys.
   */
  text?: string;
  /** Exact range of the detected phrase within the input string. */
  range?: TextRange;
  /** Desired coded definition to apply when the selection matches. */
  resolution: SiteCodeResolution;
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

export interface SmartMealExpansionScope {
  /**
   * Optional allowlist of routes that may use smart meal expansion. When
   * provided, non-matching routes are excluded unless a dosage form matches
   * `includeDosageForms`.
   */
  includeRoutes?: RouteCode[];
  /**
   * Optional denylist of routes that must not use smart meal expansion.
   * Exclusions take precedence over includes.
   */
  excludeRoutes?: RouteCode[];
  /**
   * Optional allowlist of dosage forms that may use smart meal expansion.
   * Values are matched case-insensitively after dosage-form normalization.
   */
  includeDosageForms?: string[];
  /**
   * Optional denylist of dosage forms that must not use smart meal expansion.
   * Values are matched case-insensitively after dosage-form normalization.
   * Exclusions take precedence over includes.
   */
  excludeDosageForms?: string[];
}

export type MedicationInstructionActionArgumentParser =
  | "default"
  | "container-activity"
  | "theme-destination-amount"
  | "object-amount-material"
  | "amount-duration"
  | "object-duration"
  | "object-time"
  | "mix-substance"
  | "result"
  | "site"
  | "site-relation"
  | "duration"
  | "bare-duration"
  | "duration-activity"
  | "activity";

export type MedicationInstructionActionRealizer =
  | "default"
  | "source-faithful"
  | "container-activity"
  | "theme-destination-amount"
  | "mix-substance"
  | "result"
  | "site-relation"
  | "object-amount-material"
  | "prime"
  | "amount-duration"
  | "object-duration"
  | "object-time"
  | "separable-object-relation"
  | "relation-duration"
  | "leave-duration"
  | "duration"
  | "duration-activity"
  | "activity";

export interface MedicationInstructionActionContextualCodingRule {
  whenArgument: {
    role?: AdviceArgumentRole;
    conceptId?: string;
    codingCode?: string;
    normalized?: string;
  };
  coding: FhirCoding;
}

export interface MedicationInstructionActionDefinition {
  /** Stable semantic action code. */
  code: string;
  semanticClass: string;
  display: string;
  /** Alternate human-readable labels keyed by BCP-47-ish language tag. */
  i18n?: Record<string, string>;
  /** Unambiguous parser-safe labels used only for semantic round-trip realization. */
  roundtripI18n?: Record<string, string>;
  /** Surface forms that should resolve to this action. */
  aliases?: string[];
  /** Discontinuous surface forms such as Thai `เอา X ออก` (remove X). */
  separableAliases?: Array<{ lead: string; particle: string }>;
  /** Whether this is a procedural action rather than ordinary administration advice. */
  procedural?: boolean;
  /** Declarative argument grammar family used by the instruction graph. */
  argumentParser?: MedicationInstructionActionArgumentParser;
  /** Declarative realization family used by English/Thai graph generation. */
  realizer?: MedicationInstructionActionRealizer;
  argumentParserConfig?: {
    primaryConcepts?: string[];
    secondaryConcepts?: string[];
    implicitMatchedConcept?: string;
    implicitMatchedRole?: AdviceArgumentRole;
  };
  realizerConfig?: {
    thaiFallbackObject?: string;
    thaiSuppressActivityConcepts?: string[];
    /** Thai can omit an otherwise generic medication object for this action (e.g. รับประทานหลังอาหาร). */
    thaiImplicitMedicationObject?: boolean;
    /** English realizes the anatomical site as the verb's direct object instead of `to/at <site>`. */
    englishDirectSiteObject?: boolean;
  };
  continuationLicenses?: Array<{
    candidateAction: string;
    previousConcepts?: string[];
    previousKinds?: Array<"NUMBER" | "NUMBER_RANGE">;
    nextConcepts?: string[];
  }>;
  continuationAfterRelations?: string[];
  /** Exact coding for FHIR Dosage.method when this action can head administration. */
  administrationMethod?: FhirCoding;
  /** Route candidate licensed by the action surface itself (e.g. take -> oral). */
  verbRouteHint?: RouteCode;
  /** Exact route that overrides the ordinary verb route candidate for the method head. */
  methodRouteOverride?: RouteCode;
  /** Do not project the action's verb route hint from the method head. */
  suppressMethodRouteHint?: boolean;
  /** Marks surfaces that establish topical/application context for site grammar. */
  applicationVerb?: boolean;
  /** Extra exact codings licensed by a typed semantic argument. */
  contextualCodings?: MedicationInstructionActionContextualCodingRule[];
  /** A method-capable procedural action that may serve as the primary administration head. */
  primaryAdministrationHead?: boolean;
  /** Semantically light verb that yields to an immediately following stronger administration head. */
  supportVerb?: boolean;
  /** Positive action whose condition belongs to safety/instruction scope, not PRN administration scope. */
  safetyScopeTarget?: boolean;
  acceptsAmount?: boolean;
  /** Whether an amount argument on this action defines the medication dose. */
  definesDose?: boolean;
  /** Optional primary coding when an institution owns the action terminology. */
  coding?: FhirCoding;
  /** Exact external terminology mappings; never fuzzy/approximate mappings. */
  externalCodings?: FhirCoding[];
}

export interface MedicationInstructionActionInput
  extends Partial<MedicationInstructionActionDefinition> {
  semanticClass?: string;
}

export interface MedicationInstructionConceptDefinition {
  code: string;
  role: AdviceArgumentRole;
  display: string;
  i18n?: Record<string, string>;
  aliases?: string[];
  coding?: FhirCoding;
  externalCodings?: FhirCoding[];
}

export interface MedicationInstructionConceptInput
  extends Partial<MedicationInstructionConceptDefinition> {
  role?: AdviceArgumentRole;
}

export interface InstructionSemanticArgumentProposal {
  /** Typed argument role the resolver believes this phrase fills. */
  role: AdviceArgumentRole;
  /** Range relative to the opaque source span supplied in the resolver request. */
  range: TextRange;
  /** Registered instruction concept or body-site surface/code. */
  concept?: string;
  /** Explicit quantity, still validated against the parser's unit terminology. */
  quantity?: {
    value?: number;
    low?: number;
    high?: number;
    unit?: string;
  };
}

export interface InstructionSemanticActionProposal {
  /** Registered instruction action surface/code. */
  action: string;
  /** Range relative to the opaque source span supplied in the resolver request. */
  range: TextRange;
  polarity?: AdvicePolarity;
  /** Resolver confidence only; it never bypasses deterministic validation. */
  confidence?: number;
  args?: InstructionSemanticArgumentProposal[];
}

export interface InstructionSemanticResolution {
  actions: InstructionSemanticActionProposal[];
}

export interface InstructionSemanticResolverRequest {
  inputText: string;
  sourceText: string;
  /** Absolute range of sourceText within inputText. */
  range: TextRange;
  locale?: string;
  context?: MedicationContext | null;
  /** Read-only semantic context produced before learned enrichment. */
  existingGraph: CanonicalInstructionGraph;
}

export type InstructionSemanticResolver = (
  request: InstructionSemanticResolverRequest
) =>
  | InstructionSemanticResolution
  | null
  | undefined
  | Promise<InstructionSemanticResolution | null | undefined>;

export interface ParseOptions extends FormatOptions {
  /**
   * Optional medication context that assists with default unit inference.
   * May be omitted or explicitly set to null when no contextual clues exist.
   */
  context?: MedicationContext | null;
  routeMap?: Record<string, RouteCode>;
  unitMap?: Record<string, string>;
  /**
   * Institution/application procedural vocabulary. Map keys are accepted
   * surface forms; definitions may use any coding system and may add aliases.
   * Unknown text still remains opaque rather than being guessed.
   */
  instructionActionMap?: Record<string, MedicationInstructionActionInput>;
  /**
   * Institution/application argument vocabulary for substances, containers,
   * results, activities, etc. Body sites still use the richer siteCodeMap.
   */
  instructionConceptMap?: Record<string, MedicationInstructionConceptInput>;
  /**
   * Optional learned/remote semantic proposal providers. They are used only by
   * parseSigAsync(), and only against spans the deterministic parser left opaque.
   * Proposals are validated against registered action/concept/site/unit vocabularies
   * before they can enter the canonical graph.
   */
  instructionSemanticResolvers?: InstructionSemanticResolver | InstructionSemanticResolver[];
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
   * When enabled the parser will assume a single discrete unit (e.g., one
   * tablet/capsule) when no explicit dose is provided and the inferred unit is
   * countable.
   */
  assumeSingleDiscreteDose?: boolean;
  /**
   * Enables inferring with-meal timings when explicit meal language is present
   * or implied by cadence alone. Generic meal abbreviations (AC/PC/C) and
   * cadence-only instructions expand into specific breakfast/lunch/dinner (and
   * bedtime) EventTiming entries. Works in conjunction with
   * `context.mealRelation` when provided.
   */
  smartMealExpansion?: boolean;
  /**
   * Optional route/dosage-form policy overrides for smart meal expansion.
   * When omitted, the parser uses its built-in default heuristic.
   * Exclusions take precedence over includes.
   */
  smartMealExpansionScope?: SmartMealExpansionScope;
  /**
   * Enables parsing meal dash shorthand like `1-0-1` / `1-0-0-1` into
   * multiple dosage clauses aligned to breakfast/lunch/dinner/(bedtime).
   * Optional trailing `ac` / `pc` maps meal anchors to before/after meal
   * variants.
   */
  enableMealDashSyntax?: boolean;
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
   * Defaults to true. When true, parsed spatial body-site phrases without a
   * direct pre-coordinated site code may emit SNOMED topographical modifier
   * postcoordination in FHIR Dosage.site.coding while preserving the structured
   * spatial-relation extension.
   */
  bodySitePostcoordination?: boolean;
  /**
   * Explicit selections that override automatic site resolution for matching
   * phrases. Useful when custom dictionaries provide multiple options but a UI
   * workflow needs to pin a particular coding for a given match or range.
   */
  siteCodeSelections?: SiteCodeSelection | SiteCodeSelection[];
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
  /**
   * Optional application/institution symptom vocabulary shared by conditions,
   * PRN indications, HPSG symptom recognition, and suggestion surfaces.
   */
  symptomMap?: Record<string, SymptomDefinition>;
  /**
   * Backward-compatible PRN-specific symptom overrides. When both maps define
   * the same surface, this narrower PRN map takes precedence.
   */
  prnReasonMap?: Record<string, PrnReasonDefinition>;
  /**
   * Explicit selections that override automatic PRN reason resolution.
   */
  prnReasonSelections?: PrnReasonSelection | PrnReasonSelection[];
  /**
   * Callback(s) that can translate PRN reason text into a coded concept.
   */
  prnReasonResolvers?: PrnReasonResolver | PrnReasonResolver[];
  /**
   * Callback(s) that provide PRN reason suggestions when automatic resolution
   * fails or a `{reason}` placeholder explicitly requests lookup.
   */
  prnReasonSuggestionResolvers?:
  | PrnReasonSuggestionResolver
  | PrnReasonSuggestionResolver[];
}

export interface CanonicalDoseRange {
  low?: number;
  high?: number;
}

export interface CanonicalDoseExpr {
  value?: number;
  range?: CanonicalDoseRange;
  unit?: string;
  evidence?: CanonicalEvidence[];
}

export interface CanonicalRouteExpr {
  code?: RouteCode;
  text?: string;
  inferred?: boolean;
  evidence?: CanonicalEvidence[];
}

export interface CanonicalSiteExpr {
  text?: string;
  i18n?: Record<string, string>;
  coding?: BodySiteCode;
  spatialRelation?: BodySiteSpatialRelation;
  administrationTargetCount?: number;
  source?: "abbreviation" | "text" | "selection" | "resolver";
  inferred?: boolean;
  evidence?: CanonicalEvidence[];
}

export interface CanonicalMethodExpr {
  text?: string;
  _text?: FhirPrimitiveElement;
  coding?: FhirCoding;
  evidence?: CanonicalEvidence[];
}

export interface CanonicalScheduleExpr {
  timingCode?: string;
  count?: number;
  countMax?: number;
  duration?: number;
  durationMax?: number;
  durationUnit?: FhirPeriodUnit;
  frequency?: number;
  frequencyMax?: number;
  period?: number;
  periodMax?: number;
  periodUnit?: FhirPeriodUnit;
  /** Exact event offset in minutes, matching FHIR Timing.repeat.offset. */
  offset?: number;
  /** Minimum event offset in minutes when the source says “at least”. */
  offsetMin?: number;
  /** Maximum event offset in minutes when the source says “at most”. */
  offsetMax?: number;
  dayOfWeek?: FhirDayOfWeek[];
  when?: EventTiming[];
  timeOfDay?: string[];
  evidence?: CanonicalEvidence[];
}

export interface CanonicalPrnReasonExpr {
  text?: string;
  i18n?: Record<string, string>;
  coding?: FhirCoding;
  spatialRelation?: BodySiteSpatialRelation;
}

export interface CanonicalPrnExpr {
  enabled: boolean;
  reason?: CanonicalPrnReasonExpr;
  reasons?: CanonicalPrnReasonExpr[];
  evidence?: CanonicalEvidence[];
}

export interface CanonicalAdditionalInstructionExpr {
  text?: string;
  i18n?: Record<string, string>;
  coding?: FhirCoding;
  frames?: AdviceFrame[];
  evidence?: CanonicalEvidence[];
}

export interface CanonicalInstructionRelation {
  kind: AdviceRelation;
  fromActionIndex?: number;
  toActionIndex: number;
  text?: string;
  span?: TextRange;
}

export interface CanonicalInstructionCoverage {
  understoodCharacters: number;
  opaqueCharacters: number;
  ratio: number;
  complete: boolean;
}

export interface CanonicalInstructionGraph {
  /** Ordered, language-neutral procedural/administration actions. */
  actions: AdviceFrame[];
  /** Explicit temporal/conditional relationships between actions or source clauses. */
  relations?: CanonicalInstructionRelation[];
  /** Source span of the canonical primary administration head, when known. */
  primaryAdministrationSpan?: TextRange;
  /** Source fragments the parser deliberately did not assign semantics to. */
  opaqueSpans?: CanonicalSourceSpan[];
  coverage?: CanonicalInstructionCoverage;
  /** Exact original source represented by this graph. */
  sourceText: string;
  /** Source language when it can be determined without guessing. */
  sourceLocale?: string;
}

export interface CanonicalSourceSpan extends TextRange {
  text: string;
  tokenIndices?: number[];
}

export interface CanonicalEvidence {
  rule: string;
  spans: CanonicalSourceSpan[];
  score?: number;
  note?: string;
}

export interface CanonicalSigClause {
  kind: "administration";
  rawText: string;
  span?: TextRange;
  raw: CanonicalSourceSpan;
  dose?: CanonicalDoseExpr;
  route?: CanonicalRouteExpr;
  site?: CanonicalSiteExpr;
  method?: CanonicalMethodExpr;
  schedule?: CanonicalScheduleExpr;
  prn?: CanonicalPrnExpr;
  patientInstruction?: string;
  instructionGraph?: CanonicalInstructionGraph;
  additionalInstructions?: CanonicalAdditionalInstructionExpr[];
  leftovers: CanonicalSourceSpan[];
  evidence: CanonicalEvidence[];
  confidence: number;
  warnings?: string[];
}

export interface ParseResult {
  fhir: FhirDosage;
  shortText: string;
  longText: string;
  warnings: string[];
  meta: {
    consumedTokens: string[];
    leftoverText?: string;
    normalized: ParseNormalizedMeta;
    canonical: {
      clauses: CanonicalSigClause[];
    };
    siteLookups?: Array<{
      request: SiteCodeLookupRequest;
      suggestions: SiteCodeSuggestion[];
    }>;
    prnReasonLookups?: Array<{
      request: PrnReasonLookupRequest;
      suggestions: PrnReasonSuggestion[];
    }>;
  };
}

export interface ParseNormalizedMeta {
  route?: RouteCode;
  unit?: string;
  unitKind?: DoseUnitKind;
  unitSemantics?: DoseUnitSemantics;
  site?: BodySiteDetail;
  method?: { text?: string; coding?: FhirCoding };
  patientInstruction?: string;
  instructionGraph?: CanonicalInstructionGraph;
  prnReason?: ConceptSiteDetail;
  prnReasons?: ConceptSiteDetail[];
  additionalInstructions?: Array<{ text?: string; coding?: FhirCoding }>;
}

export interface BodySiteDetail {
  text?: string;
  coding?: BodySiteCode;
  spatialRelation?: BodySiteSpatialRelation;
  administrationTargetCount?: number;
}

export interface ConceptSiteDetail {
  text?: string;
  coding?: FhirCoding;
  spatialRelation?: BodySiteSpatialRelation;
}

export interface ParseBatchSegmentMeta {
  index: number;
  text: string;
  range: TextRange;
}

export interface ParseBatchResult {
  input: string;
  count: number;
  items: ParseResult[];
  /**
   * Top-level compatibility field mirroring the first parsed item so existing
   * single-sig integrations can migrate incrementally.
   */
  fhir: FhirDosage;
  /**
   * Top-level compatibility field mirroring the first parsed item so existing
   * single-sig integrations can migrate incrementally.
   */
  shortText: string;
  /**
   * Top-level compatibility field mirroring the first parsed item so existing
   * single-sig integrations can migrate incrementally.
   */
  longText: string;
  warnings: string[];
  meta: {
    consumedTokens: string[];
    leftoverText?: string;
    normalized: ParseNormalizedMeta;
    canonical: {
      clauses: CanonicalSigClause[];
    };
    siteLookups?: Array<{
      request: SiteCodeLookupRequest;
      suggestions: SiteCodeSuggestion[];
    }>;
    prnReasonLookups?: Array<{
      request: PrnReasonLookupRequest;
      suggestions: PrnReasonSuggestion[];
    }>;
    segments: ParseBatchSegmentMeta[];
  };
}

export interface LintIssue {
  /** Human-readable description of why the segment could not be parsed. */
  message: string;
  /** Original substring that triggered the issue. */
  text: string;
  /** Tokens contributing to the unparsed segment. */
  tokens: string[];
  /** Location of {@link text} relative to the caller's original input. */
  range?: TextRange;
}

export interface LintResult {
  /** Standard parse output including FHIR representation and metadata. */
  result: ParseResult;
  /** Segments of the input that could not be interpreted. */
  issues: LintIssue[];
}

export interface LintBatchResult {
  input: string;
  count: number;
  items: LintResult[];
  /**
   * Top-level compatibility fields mirroring the first parsed item so existing
   * consumers of `lintSig` can migrate incrementally.
   */
  result: ParseResult;
  issues: LintIssue[];
  meta: {
    segments: ParseBatchSegmentMeta[];
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

export interface TotalUnitsResult {
  totalUnits: number;
  totalContainers?: number;
  totalContainerQuantity?: FhirQuantity;
  totalApproximateQuantity?: EstimatedQuantity;
  totalApproximateIngredientQuantity?: EstimatedQuantity;
}

export interface TotalUnitsOptions extends NextDueDoseOptions {
  dosage: FhirDosage | FhirDosage[];
  durationValue: number;
  durationUnit: FhirPeriodUnit;
  roundToMultiple?: number;
  context?: MedicationContext;
}
