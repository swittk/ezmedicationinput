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
  id?: string;
  url: string;
  extension?: FhirExtension[];
  valueCode?: string;
  valueString?: string;
  valueDate?: string;
  valueBoolean?: boolean;
  valueInteger?: number;
  valueDecimal?: number;
  valueQuantity?: FhirQuantity;
  valueCoding?: FhirCoding;
  valueCodeableConcept?: FhirCodeableConcept;
  valueUri?: string;
  valueCanonical?: string;
  valueDateTime?: string;
  valueTime?: string;
  valuePositiveInt?: number;
  valueUnsignedInt?: number;
  valueRange?: FhirRange;
  valueRatio?: FhirRatio;
  valueExpression?: FhirExpression;
  valueReference?: NonNullable<FhirCodeableReference["reference"]>;
  valueCodeableReference?: FhirCodeableReference;
  valueTiming?: FhirTiming;
}

export interface FhirElement {
  id?: string;
  extension?: FhirExtension[];
}

export interface FhirBackboneElement extends FhirElement {
  modifierExtension?: FhirExtension[];
}

/** FHIR primitive metadata can carry both Element.id and extensions. */
export type FhirPrimitiveElement = FhirElement;

export interface FhirQuantity extends FhirElement {
  value?: number;
  /** FHIR R5 Quantity comparator. 'ad' was added in R5. */
  comparator?: "<" | "<=" | ">=" | ">" | "ad";
  unit?: string;
  system?: string;
  code?: string;
  /** Primitive Element metadata is valid on every FHIR Quantity specialization. */
  _value?: FhirPrimitiveElement;
  _unit?: FhirPrimitiveElement;
  _system?: FhirPrimitiveElement;
  _code?: FhirPrimitiveElement;
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

/** FHIR SimpleQuantity: Quantity with the comparator constrained to absent. */
export type FhirSimpleQuantity = Omit<FhirQuantity, "comparator"> & {
  comparator?: never;
};

/** FHIR R6 also supports the approximate (~) comparator in general Quantity. */
export type FhirR6Quantity = Omit<FhirQuantity, "comparator"> & {
  comparator?: FhirQuantity["comparator"] | "~";
};

export interface FhirRange extends FhirElement {
  low?: FhirSimpleQuantity;
  high?: FhirSimpleQuantity;
}

export interface FhirRatio extends FhirElement {
  numerator?: FhirQuantity;
  denominator?: FhirSimpleQuantity;
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
  /** Duration of each administration occurrence. */
  duration?: number;
  durationMax?: number;
  durationUnit?: FhirPeriodUnit;
  period?: number;
  periodMax?: number;
  periodUnit?: FhirPeriodUnit;
  dayOfWeek?: FhirDayOfWeek[];
  timeOfDay?: string[];
  when?: EventTiming[];
  /** Exact event offset in minutes. */
  offset?: number;
}

export interface FhirTiming extends FhirElement {
  event?: string[];
  /** Primitive metadata corresponding positionally to event. */
  _event?: FhirPrimitiveElement[];
  repeat?: FhirTimingRepeat;
  code?: FhirCodeableConcept;
}

/** FHIR Expression: enough structure to preserve external R6 dose/rate expressions. */
export interface FhirExpression extends FhirElement {
  description?: string;
  name?: string;
  /** FHIR R5/R6 Expression.language is optional (0..1). */
  language?: string;
  expression?: string;
  reference?: string;
}

export interface FhirDoseAndRate extends FhirBackboneElement {
  type?: FhirCodeableConcept;
  doseRange?: FhirRange;
  doseQuantity?: FhirSimpleQuantity;
  rateRatio?: FhirRatio;
  rateRange?: FhirRange;
  rateQuantity?: FhirSimpleQuantity;
}

/** R6 additions to the R5 DoseAndRate child object. */
export interface EzDoseAndRate extends FhirDoseAndRate {
  doseExpression?: FhirExpression;
  rateExpression?: FhirExpression;
}

/**
 * The meaning of a condition is independent of its wording.
 * all/any/not are explicit: FHIR R6 condition[] alone is OR, not AND.
 * Free-text predicates remain representable but need a caller evaluator.
 */
export type MedicationCondition =
  | { kind: "measurement"; name: string; operation: "gt" | "ge" | "lt" | "le" | "eq" | "ne"; value: number; unit?: string; text: string }
  | { kind: "state"; name: string; text: string; expected: boolean }
  | { kind: "text"; text: string }
  | { kind: "not"; condition: MedicationCondition }
  | { kind: "all" | "any"; conditions: MedicationCondition[] };

/** FHIR R6 draft DosageCondition compatible subset. */
export interface FhirR6DosageCondition extends FhirBackboneElement {
  code: FhirCodeableConcept;
  details?: FhirCodeableConcept;
  operation?: "eq" | "ne" | "in" | "nin" | "gt" | "lt" | "ge" | "le" | "sa" | "eb" | "ap";
  valueBoolean?: boolean;
  valueQuantity?: FhirR6Quantity;
  valueString?: string;
  text?: string;
}

/** FHIR R6 DosageSafety.doseLimit.value[x] is a required choice. */
export type FhirR6DoseLimit = FhirBackboneElement & {
  scope: "dosage" | "period" | "administration" | "lifetime";
  period?: FhirQuantity;
  text?: string;
} & (
  | { valueQuantity: FhirR6Quantity; valueInteger?: never; valueExpression?: never }
  | { valueInteger: number; valueQuantity?: never; valueExpression?: never }
  | { valueExpression: FhirExpression; valueQuantity?: never; valueInteger?: never }
);

export interface FhirR6DosageSafety extends FhirBackboneElement {
  doseLimit?: FhirR6DoseLimit[];
  ifExceeded?: string;
}

/** FHIR R6 CodeableReference allows either a concept or resource reference. */
export interface FhirCodeableReference {
  concept?: FhirCodeableConcept;
  reference?: { reference?: string; type?: string; display?: string };
}

/** FHIR R6 draft Dosage: no R5 sequence/legacy maxima/PRN alias. */
export interface FhirR6Dosage extends Omit<FhirDosage,
  "sequence" | "site" | "maxDosePerPeriod" | "maxDosePerAdministration" |
  "maxDosePerLifetime" | "doseAndRate"> {
  condition?: FhirR6DosageCondition[];
  site?: FhirCodeableReference;
  doseAndRate?: EzDoseAndRate[];
  safety?: FhirR6DosageSafety;
}

export interface FhirR6RelativeTime extends FhirBackboneElement {
  contextReference?: { reference?: string };
  contextDefinition?: string;
  contextPath?: string;
  contextCode?: FhirCodeableConcept;
  offsetDuration?: FhirQuantity;
  offsetRange?: FhirRange;
  text?: string;
}

export interface FhirR6DosageStep extends FhirBackboneElement {
  start?: FhirR6RelativeTime;
  end?: FhirR6RelativeTime;
  count?: number;
  component: FhirR6Dosage[];
  safety?: FhirR6DosageSafety;
}

/** R6's step/component course representation. */
export interface FhirR6DosageDetails extends FhirBackboneElement {
  renderedInstruction?: string;
  repeatCycle?: FhirQuantity;
  step: FhirR6DosageStep[];
  safety?: FhirR6DosageSafety;
}

export interface FhirDosage extends FhirBackboneElement {
  /** FHIR R5 ordering: equal sequences are concurrent, increasing sequences are sequential. */
  sequence?: number;
  text?: string;
  patientInstruction?: string;
  timing?: FhirTiming;
  route?: FhirCodeableConcept;
  site?: FhirCodeableConcept;
  method?: FhirCodeableConcept;
  additionalInstruction?: FhirCodeableConcept[];
  /** FHIR R5 spelling. */
  asNeeded?: boolean;
  asNeededFor?: FhirCodeableConcept[];
  doseAndRate?: FhirDoseAndRate[];
  maxDosePerPeriod?: FhirRatio[];
  maxDosePerAdministration?: FhirSimpleQuantity;
  maxDosePerLifetime?: FhirSimpleQuantity;
}

/**
 * EZMED's primary dose object. Retains the useful FHIR R5 Dosage shape and
 * lifts a small number of actual R6 features into optional typed fields.
 * This is NOT strict FHIR R5 JSON: call toFhirR5Dosages() for wire export.
 */
export interface EzDosage extends Omit<FhirDosage, "doseAndRate"> {
  doseAndRate?: EzDoseAndRate[];
  /** FHIR R6 Dosage.condition, including compound conditions when needed. */
  condition?: FhirR6DosageCondition[];
  /** FHIR R6 Dosage.safety, alongside the R5 maximum fields. */
  safety?: FhirR6DosageSafety;
  /** FHIR R6 Dosage.site.reference, while site remains R5 CodeableConcept. */
  siteReference?: FhirCodeableReference["reference"];
  /** EZMED-specific dates omitted from a repeating schedule; not an HL7 core field. */
  excludedDates?: string[];
}

/**
 * Small amount of course-level metadata that does not logically belong to an
 * individual dosage. Each step row addresses the usual R5 Dosage.sequence.
 * The fields under step come directly from FHIR R6 DosageDetails.step.
 */
export interface EzCourseStep extends FhirBackboneElement {
  /** R5 global sequence corresponding to this R6 step. */
  sequence: number;
  start?: FhirR6RelativeTime;
  end?: FhirR6RelativeTime;
  count?: number;
  safety?: FhirR6DosageSafety;
}

export interface EzCourseMetadata extends FhirBackboneElement {
  renderedInstruction?: string;
  repeatCycle?: FhirQuantity;
  safety?: FhirR6DosageSafety;
  step?: EzCourseStep[];
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

export type BodySiteRestrictionPredicateForm =
  | "state"
  | "existential"
  | "raw";

/**
 * A source-backed predicate that narrows an administration site. It is not a
 * diagnosis or a regimen-wide execution condition.
 */
export interface BodySiteRestrictionPredicate {
  text: string;
  lemma?: string;
  form: BodySiteRestrictionPredicateForm;
  /** Predicate payload after a declarative introducer such as "there is". */
  focusText?: string;
  range?: TextRange;
}

/** A restrictive relative clause attached locally to a body-site sign. */
export interface BodySiteRestriction {
  relation: "where";
  sourceText: string;
  range?: TextRange;
  markerRange?: TextRange;
  predicate: BodySiteRestrictionPredicate;
}

export interface BodySiteDefinition {
  coding?: BodySiteCode;
  text?: string;
  spatialRelation?: BodySiteSpatialRelation;
  routeHint?: RouteCode;
  /** Only applies when a typed locative places medication INSIDE this site;
   * external skin administration retains the product/administration route. */
  internalRouteHint?: RouteCode;
  administrationTargetCount?: number;
  /** Optional surface used when the dose applies independently to each target. */
  perTargetText?: string;
  /** Locale-specific per-target surface, e.g. Thai `รูจมูกข้างละ`. */
  perTargetI18n?: Record<string, string>;
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
  /** Independent typed relation from this action to its argument.
   * Permits material WITH and event BEFORE to coexist on one action. */
  relation?: AdviceRelation;
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
  /** Shared directive scope may differ from this action's own source wording. */
  polaritySource?: "shared";
  modality?: AdviceModality;
  predicate: {
    lemma: string;
    semanticClass?: string;
    display?: string;
    i18n?: Record<string, string>;
    /** Persisted realization profile so caller-owned actions remain deterministic after parse/FHIR round-trip. */
    realizer?: MedicationInstructionActionRealizer;
    realizerConfig?: MedicationInstructionActionRealizerConfig;
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
  | "amount-material-destination"
  | "amount-duration"
  | "object-duration"
  | "object-time"
  | "mix-substance"
  | "result"
  | "site"
  | "site-relation"
  | "duration"
  | "bare-duration"
  | "preposed-duration"
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
  | "amount-material-destination"
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

export interface MedicationInstructionActionLocaleRealizerConfig {
  fallbackObject?: string;
  suppressActivityConcepts?: string[];
  suppressSiteConcepts?: string[];
  implicitMedicationObject?: boolean;
  directSiteObject?: boolean;
  /** Realize the dose as a direct amount instead of adding a locale-default per-dose prefix. */
  directDose?: boolean;
  /** Route-specific phrase overrides keyed by canonical RouteCode value. */
  routePhrases?: Record<string, string>;
  /** Prefix for the duration of each administration occurrence. */
  administrationDurationPrefix?: string;
}

export interface MedicationInstructionActionRealizerConfig {
  /** Locale-specific realization behavior keyed by BCP-47-ish language tag. */
  locales?: Record<string, MedicationInstructionActionLocaleRealizerConfig>;
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
  /** Surface forms licensed only when immediately sequence-scoped (e.g. `then off`). */
  sequenceAliases?: string[];
  /** Locale-specific parser lexemes. Display translation belongs in `i18n`; parsing aliases are explicit. */
  localeAliases?: Record<string, string[]>;
  /** Discontinuous surface forms such as Thai `เอา X ออก` (remove X). */
  separableAliases?: Array<{ lead: string; particle: string }>;
  /** Whether this is a procedural action rather than ordinary administration advice. */
  procedural?: boolean;
  /** Declarative argument grammar family used by the instruction graph. */
  argumentParser?: MedicationInstructionActionArgumentParser;
  /** Declarative realization family used by English/Thai graph generation. */
  realizer?: MedicationInstructionActionRealizer;
  argumentParserConfig?: {
    /** Semantic effect of an affirmative conditional action on its medication-dose complement.
     * The selected-dose form requires an explicit medication object or a typed dose-slot target;
     * it never treats a bare avoidance verb, food object, or negation as withholding. */
    medicationConditionEffect?: "withhold" | "withhold-selected-dose";
    primaryConcepts?: string[];
    secondaryConcepts?: string[];
    implicitMatchedConcept?: string;
    implicitMatchedRole?: AdviceArgumentRole;
  };
  realizerConfig?: MedicationInstructionActionRealizerConfig;
  continuationLicenses?: Array<{
    candidateAction: string;
    previousConcepts?: string[];
    previousKinds?: Array<"NUMBER" | "NUMBER_RANGE">;
    nextConcepts?: string[];
  }>;
  continuationAfterRelations?: string[];
  /** Surface introducers that make a parsed duration describe each administration occurrence. */
  administrationDurationIntroducers?: string[];
  /** Preferred relation semantic classes used to resolve lexically ambiguous relation surfaces. */
  preferredRelationSemanticClasses?: string[];
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
  /** A registered compound noun may entail a second independently typed
   * argument, e.g. a temporal material "before first use" also supplies
   * its explicit first-use event. Not a free-form text rewrite. */
  impliedArgument?: {
    role: AdviceArgumentRole;
    conceptId: string;
    relation: AdviceRelation;
  };
  display: string;
  i18n?: Record<string, string>;
  aliases?: string[];
  /** Locale-specific parser lexemes; display translations are not implicitly grammar-active. */
  localeAliases?: Record<string, string[]>;
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

export type MedicationDateOrder = "DMY" | "MDY";

export interface MedicationDatePlausibleWindow {
  /** Maximum inferred-year distance into the past. Defaults to 5 years. */
  pastYears?: number;
  /** Maximum inferred-year distance into the future. Defaults to 10 years. */
  futureYears?: number;
}

export interface MedicationDatePolicy {
  /** Enabled calendar resolver ids, in preference order. Defaults by detected locale. */
  calendars?: string[];
  /**
   * Numeric date field order. Defaults to DMY for every locale.
   * MDY is accepted only when explicitly requested by the caller.
   */
  dateOrder?: MedicationDateOrder;
  /** ISO date used to resolve two-digit years. Defaults to the current date. */
  referenceDate?: string;
  /** Plausibility window applied only to inferred two-digit years. */
  plausibleWindow?: MedicationDatePlausibleWindow;
  /** How to handle multiple valid calendar interpretations. Defaults to prefer-first. */
  ambiguity?: "prefer-first" | "reject";
}

export interface MedicationDateResolverContext {
  locale: string;
  referenceDate: string;
}

export interface MedicationDateResolverResult {
  /** Gregorian year used in the normalized ISO date. */
  isoYear: number;
  /** Full year in the resolver's source calendar. */
  calendarYear: number;
  /** Whether a two-digit source year was expanded. */
  inferredYear: boolean;
}

export interface MedicationDateResolver {
  /** Stable resolver/calendar id, e.g. gregory or buddhist. */
  id: string;
  resolveYear(
    sourceYear: number,
    sourceYearDigits: number,
    context: MedicationDateResolverContext
  ): MedicationDateResolverResult | undefined;
  /**
   * Optional reverse mapping used when the source omitted a year and the
   * parser inferred an ISO year from the reference date.
   */
  calendarYearFromIsoYear?(isoYear: number): number | undefined;
}

export interface ParseOptions extends FormatOptions {
  /**
   * Optional medication context that assists with default unit inference.
   * May be omitted or explicitly set to null when no contextual clues exist.
   */
  context?: MedicationContext | null;
  /**
   * Advanced date interpretation overrides. Ordinary callers can omit this:
   * locale-relevant calendar resolvers are enabled automatically.
   */
  datePolicy?: MedicationDatePolicy;
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
   * Enables inferring with-meal timings. `true` and `"cadence"` preserve the
   * legacy behavior: explicit meal abbreviations (AC/PC/C) and cadence-only
   * instructions may expand into breakfast/lunch/dinner/(bedtime). `"explicit"`
   * expands only explicit generic meal timing and never invents meal anchors
   * from cadence alone. Works with `context.mealRelation` when cadence expansion
   * is enabled.
   */
  smartMealExpansion?: boolean | "explicit" | "cadence";
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
  restrictions?: BodySiteRestriction[];
  administrationTargetCount?: number;
  source?: "abbreviation" | "text" | "selection" | "resolver";
  inferred?: boolean;
  evidence?: CanonicalEvidence[];
  range?: TextRange;
}

export type AdministrationTargetCoordinationKind =
  | "conjunction"
  | "disjunction"
  | "mixed";

/**
 * A grammatical coordination of administration sites. Each target is an
 * independently typed site atom; the relation is retained before the singular
 * FHIR Dosage.site projection chooses whether conjunction fan-out is needed.
 */
export interface CanonicalAdministrationTargetGroup {
  coordination: AdministrationTargetCoordinationKind;
  sourceText: string;
  range?: TextRange;
  targets: CanonicalSiteExpr[];
}

export interface CanonicalMethodExpr {
  text?: string;
  _text?: FhirPrimitiveElement;
  coding?: FhirCoding;
  evidence?: CanonicalEvidence[];
}

export interface CanonicalOccurrenceCapExpr {
  max: number;
  period: number;
  periodUnit: FhirPeriodUnit;
}

/** Explicit maximum medication quantity within a recurring period. */
export interface CanonicalDosePeriodMaximumExpr {
  amount: number;
  unit: string;
  period: number;
  periodUnit: FhirPeriodUnit;
}

export interface CanonicalActivityTimingExpr {
  relation: "before" | "after";
  activity: {
    text: string;
    i18n?: Record<string, string>;
    coding?: FhirCoding;
  };
  /** Exact offset from the activity in minutes. */
  offset?: number;
  /** Minimum offset from the activity in minutes. */
  offsetMin?: number;
  /** Maximum offset from the activity in minutes. */
  offsetMax?: number;
}

/** Caller-resolved daily administration window. Unlike a WHEN anchor, this
 * bounds recurring opportunities rather than defining one administration.
 * Both endpoints are clinical EventTiming codes, never inferred clock times.
 */
export interface CanonicalEventWindowExpr {
  start: EventTiming;
  end: EventTiming;
}

export interface CanonicalCalendarEventExpr {
  /** Gregorian ISO calendar date used for date-only FHIR Timing.event values and display. */
  isoDate: string;
  /** Original timestamp-valued FHIR Timing.event value, retained losslessly when present. */
  fhirDateTime?: string;
  /** Resolver/calendar that interpreted the source year. */
  calendar: string;
  /** Full source-calendar year after any two-digit expansion. */
  calendarYear: number;
  month: number;
  day: number;
  /** Exact source fragment representing this event or inherited day. */
  sourceText: string;
  /** True when a two-digit source year was expanded using the reference date. */
  inferredYear?: boolean;
}

export interface CanonicalScheduleExpr {
  /** Typed whole-course interval for a recurring active/rest construction. */
  repeatCycle?: FhirQuantity;
  /** Explicit finite number of whole-course repetitions; absent means unbounded. */
  repeatCount?: number;
  /** Explicit local-clock interval window; not a list of endpoint doses. */
  clockWindow?: { start: string; end: string; endInclusive: boolean };
  /** Weekday occurrence in each month; -1 denotes the last occurrence. */
  weekdayOrdinal?: -1 | 1 | 2 | 3 | 4 | 5;
  /** Source-anaphoric timing (e.g. "at the same times") awaiting a licensed
   * previous regimen daughter. Resolved within HPSG/regimen, never by FHIR. */
  timingReference?: "previous" | "previous-weekday-complement";
  /** Source-relative phase onset, in elapsed days from treatment start. */
  treatmentStartOffsetDays?: number;
  /** Elapsed delay from each opportunity in this explicitly retained base schedule. */
  administrationOffsetMinutes?: number;
  timingCode?: string;
  count?: number;
  countMax?: number;
  duration?: number;
  durationMax?: number;
  durationUnit?: FhirPeriodUnit;
  /** Earliest calendar date/time on which this schedule becomes active. */
  boundsStart?: string;
  /** Latest inclusive calendar date/time on which this schedule remains active. */
  boundsEnd?: string;
  /** Duration of each administration occurrence, distinct from regimen bounds duration. */
  administrationDuration?: number;
  administrationDurationMax?: number;
  administrationDurationUnit?: FhirPeriodUnit;
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
  /** Typed recurring window, distinct from an instantaneous WHEN event. */
  eventWindow?: CanonicalEventWindowExpr;
  /** Explicit calendar occurrences, projected to FHIR Timing.event. */
  calendarEvents?: CanonicalCalendarEventExpr[];
  activityTiming?: CanonicalActivityTimingExpr[];
  occurrenceCap?: CanonicalOccurrenceCapExpr;
  /** Quantity cap, distinct from occurrenceCap's maximum administration count. */
  maxDosePerPeriod?: CanonicalDosePeriodMaximumExpr[];
  evidence?: CanonicalEvidence[];
}

/** Schedule fields explicitly contributed by typed grammar evidence. */
export type CanonicalScheduleSemanticField = Exclude<keyof CanonicalScheduleExpr, "evidence">;

export interface CanonicalPrnReasonExpr {
  text?: string;
  i18n?: Record<string, string>;
  coding?: FhirCoding;
  spatialRelation?: BodySiteSpatialRelation;
  /** Clinical trigger phase qualifying this PRN reason, e.g. symptom onset. */
  triggerPhase?: "onset";
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

/** Lexical grammatical role carried from the originating typed sign.
 * Production names remain diagnostic labels, never semantic dispatch keys. */
export type CanonicalLexicalCategory = "dose" | "method" | "prn" | "connector" | "instruction" | "workflow";

export interface CanonicalEvidence {
  rule: string;
  /** Role of the actual lexical sign, independent of the grammar-rule label. */
  lexicalCategory?: CanonicalLexicalCategory;
  spans: CanonicalSourceSpan[];
  /** Exact schedule semantics owned by this evidence, independent of rule names. */
  scheduleFields?: CanonicalScheduleSemanticField[];
  score?: number;
  note?: string;
}

/**
 * Clinical adjuncts are grammatical facts on a typed administration clause.
 * Local surface recognizers produce them; HPSG constructions determine their
 * scope; FHIR only projects the resulting semantics. Raw/source data is kept.
 */
export interface CanonicalClinicalAdjuncts {
  /** Finite medication-free interval selected by a typed withholding head. */
  treatmentPause?: { durationDays: number; range: TextRange };
  condition?: MedicationCondition;
  /** Source-typed calendar membership, distinct from unrelated clinical guards. */
  calendarDayCondition?: MedicationCondition;
  /** Typed nominal reference of a conditional administration instruction.
   * Resolved across related regimen daughters before any FHIR lowering. */
  conditionTarget?: {
    when?: EventTiming[];
    /** Explicit existing clock slots selected by the nominal dose object. */
    timeOfDay?: string[];
    /** Lexical daypart membership over already stated clocks; creates no times. */
    clockRange?: { startHour: number; endHour: number };
    quantifier?: "all" | "both";
  };
  excludedDates?: string[];
  excludedWeekdays?: FhirDayOfWeek[];
  /** Local source spans for lint ownership, not inherited donor spans. */
  localRanges?: TextRange[];
  evidence?: CanonicalEvidence[];
}

export interface CanonicalSigClause {
  kind: "administration";
  /** Source-backed phase operation; resolved by the typed regimen graph. */
  regimenAdjustment?: "replace" | "add" | "replace-target";
  rawText: string;
  span?: TextRange;
  raw: CanonicalSourceSpan;
  dose?: CanonicalDoseExpr;
  route?: CanonicalRouteExpr;
  site?: CanonicalSiteExpr;
  administrationTargetGroup?: CanonicalAdministrationTargetGroup;
  method?: CanonicalMethodExpr;
  /** Only the executable schedule. Undefined when scheduling is unresolved. */
  schedule?: CanonicalScheduleExpr;
  /**
   * Recognized but NON-EXECUTABLE schedule features retained for review/UI.
   * An unresolved medication can still have trustworthy dose, route, site,
   * clocks and bounds. Never schedule or calculate supply from this field;
   * execution requires a resolved schedule and the dosage safety checks.
   */
  provisionalSchedule?: CanonicalScheduleExpr;
  prn?: CanonicalPrnExpr;
  clinicalAdjuncts?: CanonicalClinicalAdjuncts;
  /** Closed HPSG condition ownership, projected into instruction-graph relations. */
  instructionScopes?: Array<{ kind: AdviceRelation; span: TextRange; target: TextRange }>;
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
  /** Typed site-local predicates retained for editable normalized suggestions. */
  restrictions?: BodySiteRestriction[];
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
  /** Per-clause parser diagnostics and intermediate R5-compatible dosage shapes. */
  items: ParseResult[];
  /** Primary output: COMPLETE flat R5-like dosage array with additive R6 fields. */
  fhir: EzDosage[];
  /** Strict R6 snapshot projection of the same prescription. */
  fhirNext: FhirR6DosageDetails;
  /** Optional R6 step/course metadata not owned by a single dose. */
  course?: EzCourseMetadata;
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
export type MedicationConditionEvaluator = (condition: MedicationCondition, at: string) => boolean | undefined;

export interface NextDueDoseOptions {
  from: Date | string;
  /** Explicit course-local selection for exactly-one alternative groups.
   * Keys are getDosageAlternativeChoice(...).groupId; values are branchId.
   * Omit only for ordinary courses without mutually exclusive alternatives.
   * Parsing and editing never require a selection; execution and supply do.
   */
  alternativeChoices?: Readonly<Record<string, string>>;
  /** Evaluate structured conditional instructions at each candidate occurrence. Required for conditional scheduling. */
  evaluateCondition?: MedicationConditionEvaluator;
  orderedAt?: Date | string;
  limit?: number;
  priorCount?: number;
  /** Actual prior administration timestamps used for per-period occurrence caps. */
  priorDoseTimes?: Array<Date | string>;
  timeZone?: string;
  eventClock?: EventClockMap;
  mealOffsets?: MealOffsetMap;
  frequencyDefaults?: FrequencyFallbackTimes;
  config?: NextDueDoseConfig;
}

/** Due times calculated with each ordered medication-instruction phase respected. */
export interface RegimenDueTimes {
  dosageIndex: number;
  sequence: number;
  phaseStart: string;
  timestamps: string[];
}

export interface TotalUnitsResult {
  totalUnits: number;
  /** Unit of totalUnits, when known. */
  unit?: string;
  /** PRN and unresolved clinical observations yield the maximum planned supply, not actual consumption. */
  quantityKind?: "scheduled" | "maximum";
  /** Human-readable basis/assumptions suitable for displaying alongside a calculated quantity. */
  explanation?: string;
  totalContainers?: number;
  totalContainerQuantity?: FhirQuantity;
  totalApproximateQuantity?: EstimatedQuantity;
  totalApproximateIngredientQuantity?: EstimatedQuantity;
}

export interface TotalUnitsOptions extends NextDueDoseOptions {
  dosage: FhirDosage | readonly EzDosage[] | FhirR6DosageDetails | ParseBatchResult;
  /** Required to resolve per-kg administered doses into an actual quantity. */
  patientWeightKg?: number;
  durationValue: number;
  durationUnit: FhirPeriodUnit;
  roundToMultiple?: number;
  context?: MedicationContext;
}
