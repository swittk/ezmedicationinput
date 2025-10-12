import {
  EventTiming,
  FhirDayOfWeek,
  FhirPeriodUnit,
  RouteCode,
  SNOMEDCTRouteCodes
} from "./types";
import { objectEntries, objectFromEntries } from "./utils/object";

type RouteSnomedEntry = [
  RouteCode,
  { code: SNOMEDCTRouteCodes; display: string }
];

const ROUTE_TEXT_OVERRIDES: Partial<Record<RouteCode, string>> = {
  [RouteCode["Oral route"]]: "by mouth",
  [RouteCode["Sublingual route"]]: "sublingual",
  [RouteCode["Buccal route"]]: "buccal",
  [RouteCode["Respiratory tract route (qualifier value)"]]: "inhalation",
  [RouteCode["Nasal route"]]: "intranasal",
  [RouteCode["Topical route"]]: "topical",
  [RouteCode["Transdermal route"]]: "transdermal",
  [RouteCode["Subcutaneous route"]]: "subcutaneous",
  [RouteCode["Intramuscular route"]]: "intramuscular",
  [RouteCode["Intravenous route"]]: "intravenous",
  [RouteCode["Per rectum"]]: "rectal",
  [RouteCode["Per vagina"]]: "vaginal",
  [RouteCode["Ophthalmic route"]]: "ophthalmic",
  [RouteCode["Intravitreal route (qualifier value)"]]: "intravitreal"
};

function defaultRouteText(display: string): string {
  const cleaned = display.replace(/\s*\(qualifier value\)/gi, "");
  const withoutSuffix = cleaned.replace(/\b(route|use)\b/gi, "");
  return withoutSuffix.replace(/\s+/g, " ").trim().toLowerCase();
}

const ROUTE_SNOMED_ENTRIES: RouteSnomedEntry[] = objectEntries(
  SNOMEDCTRouteCodes
).map(([display, code]) => {
  const routeCode = code as RouteCode;
  return [
    routeCode,
    { code: code as SNOMEDCTRouteCodes, display }
  ];
});

/**
 * SNOMED CT codings aligned with every known RouteCode. Keeping the structure
 * data-driven ensures any additions to the enumeration are surfaced
 * automatically throughout the library.
 */
export const ROUTE_SNOMED = objectFromEntries(
  ROUTE_SNOMED_ENTRIES
) as Record<RouteCode, { code: SNOMEDCTRouteCodes; display: string }>;

export const ROUTE_TEXT = objectFromEntries(
  ROUTE_SNOMED_ENTRIES.map(([routeCode, meta]) => [
    routeCode,
    ROUTE_TEXT_OVERRIDES[routeCode] ?? defaultRouteText(meta.display)
  ])
) as Record<RouteCode, string>;

/**
 * Inverse lookup so that SNOMED codes flowing in from FHIR can be mapped back
 * into our internal RouteCode abstraction during round-tripping.
 */
export const ROUTE_BY_SNOMED = objectFromEntries(
  ROUTE_SNOMED_ENTRIES.map(([routeCode, meta]) => [meta.code, routeCode])
) as Record<SNOMEDCTRouteCodes, RouteCode>;

export interface RouteSynonym {
  code: RouteCode;
  text: string;
}

export const DEFAULT_ROUTE_SYNONYMS: Record<string, RouteSynonym> = (() => {
  const map: Record<string, RouteSynonym> = {};
  const assign = (key: string | undefined, code: RouteCode) => {
    if (!key) return;
    const normalized = key.trim().toLowerCase();
    if (!normalized || map[normalized]) {
      return;
    }
    map[normalized] = { code, text: ROUTE_TEXT[code] };
  };

  const registerVariants = (value: string | undefined, code: RouteCode) => {
    if (!value) return;
    assign(value, code);
    const withoutParens = value
      .replace(/[()]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    assign(withoutParens, code);
    const withoutCommas = value
      .replace(/,/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    assign(withoutCommas, code);
    const withoutPunctuation = value
      .replace(/[().,-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    assign(withoutPunctuation, code);
  };

  registerVariants("po", RouteCode["Oral route"]);
  registerVariants("oral", RouteCode["Oral route"]);
  registerVariants("by mouth", RouteCode["Oral route"]);
  registerVariants("per os", RouteCode["Oral route"]);
  registerVariants("sl", RouteCode["Sublingual route"]);
  registerVariants("s.l.", RouteCode["Sublingual route"]);
  registerVariants("sublingual", RouteCode["Sublingual route"]);
  registerVariants("buccal", RouteCode["Buccal route"]);
  registerVariants("inh", RouteCode["Respiratory tract route (qualifier value)"]);
  registerVariants("inhalation", RouteCode["Respiratory tract route (qualifier value)"]);
  registerVariants("inhaled", RouteCode["Respiratory tract route (qualifier value)"]);
  registerVariants("iv", RouteCode["Intravenous route"]);
  registerVariants("ivp", RouteCode["Intravenous route"]);
  registerVariants("ivpb", RouteCode["Intravenous route"]);
  registerVariants("iv push", RouteCode["Intravenous route"]);
  registerVariants("iv bolus", RouteCode["Intravenous route"]);
  registerVariants("iv drip", RouteCode["Intravenous route"]);
  registerVariants("intravenous", RouteCode["Intravenous route"]);
  registerVariants("im", RouteCode["Intramuscular route"]);
  registerVariants("im injection", RouteCode["Intramuscular route"]);
  registerVariants("intramuscular", RouteCode["Intramuscular route"]);
  registerVariants("sc", RouteCode["Subcutaneous route"]);
  registerVariants("sq", RouteCode["Subcutaneous route"]);
  registerVariants("subq", RouteCode["Subcutaneous route"]);
  registerVariants("subcut", RouteCode["Subcutaneous route"]);
  registerVariants("subcutaneous", RouteCode["Subcutaneous route"]);
  registerVariants("in", RouteCode["Nasal route"]);
  registerVariants("intranasal", RouteCode["Nasal route"]);
  registerVariants("nasal", RouteCode["Nasal route"]);
  registerVariants("top", RouteCode["Topical route"]);
  registerVariants("topical", RouteCode["Topical route"]);
  registerVariants("td", RouteCode["Transdermal route"]);
  registerVariants("patch", RouteCode["Transdermal route"]);
  registerVariants("transdermal", RouteCode["Transdermal route"]);
  registerVariants("pr", RouteCode["Per rectum"]);
  registerVariants("rectal", RouteCode["Per rectum"]);
  registerVariants("pv", RouteCode["Per vagina"]);
  registerVariants("vaginal", RouteCode["Per vagina"]);
  registerVariants("oph", RouteCode["Ophthalmic route"]);
  registerVariants("ophth", RouteCode["Ophthalmic route"]);
  registerVariants("ophthalmic", RouteCode["Ophthalmic route"]);
  registerVariants("ocular", RouteCode["Ophthalmic route"]);
  registerVariants("intravitreal", RouteCode["Intravitreal route (qualifier value)"]);
  registerVariants("intravitreal injection", RouteCode["Intravitreal route (qualifier value)"]);
  registerVariants("ivt", RouteCode["Intravitreal route (qualifier value)"]);

  for (const [routeCode, meta] of ROUTE_SNOMED_ENTRIES) {
    const display = meta.display.toLowerCase();
    registerVariants(display, routeCode);
    const withoutQualifier = display.replace(/\s*\(qualifier value\)/g, "").trim();
    registerVariants(withoutQualifier, routeCode);
    const withoutSuffix = withoutQualifier
      .replace(/\b(route|use)\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
    registerVariants(withoutSuffix, routeCode);
    const withoutPer = withoutSuffix.replace(/^per\s+/, "").trim();
    registerVariants(withoutPer, routeCode);
  }

  return map;
})();

type UnitSynonymMap = Record<string, string>;

interface UnitPrefixDefinition {
  canonical: string;
  abbreviations: readonly string[];
  names: readonly { singular: string; plural: string }[];
}

interface UnitBaseDefinition {
  canonical: string;
  abbreviations: readonly string[];
  names: readonly { singular: string; plural: string }[];
}

const UNIT_PREFIXES: readonly UnitPrefixDefinition[] = [
  { canonical: "", abbreviations: [""], names: [{ singular: "", plural: "" }] },
  {
    canonical: "m",
    abbreviations: ["m"],
    names: [{ singular: "milli", plural: "milli" }],
  },
  {
    canonical: "mc",
    abbreviations: ["mc", "µ", "μ", "u"],
    names: [{ singular: "micro", plural: "micro" }],
  },
  {
    canonical: "n",
    abbreviations: ["n"],
    names: [{ singular: "nano", plural: "nano" }],
  },
  {
    canonical: "k",
    abbreviations: ["k"],
    names: [{ singular: "kilo", plural: "kilo" }],
  },
];

const METRIC_UNIT_BASES: readonly UnitBaseDefinition[] = [
  {
    canonical: "g",
    abbreviations: ["g"],
    names: [
      { singular: "gram", plural: "grams" },
      { singular: "gramme", plural: "grammes" },
    ],
  },
  {
    canonical: "L",
    abbreviations: ["l"],
    names: [
      { singular: "liter", plural: "liters" },
      { singular: "litre", plural: "litres" },
    ],
  },
];

function assignUnitSynonym(map: UnitSynonymMap, key: string, canonical: string) {
  const normalized = key.trim().toLowerCase();
  if (!normalized || map[normalized]) {
    return;
  }
  map[normalized] = canonical;
}

function addMetricUnitSynonyms(map: UnitSynonymMap) {
  for (const prefix of UNIT_PREFIXES) {
    for (const base of METRIC_UNIT_BASES) {
      const canonical = `${prefix.canonical}${base.canonical}`;

      for (const prefixAbbrev of prefix.abbreviations) {
        for (const baseAbbrev of base.abbreviations) {
          if (!baseAbbrev) {
            continue;
          }
          const token = `${prefixAbbrev}${baseAbbrev}`;
          assignUnitSynonym(map, token, canonical);
          assignUnitSynonym(map, `${token}s`, canonical);
          if (token.endsWith(".")) {
            assignUnitSynonym(map, token.replace(/\.+$/, ""), canonical);
          }
        }
      }

      for (const prefixName of prefix.names) {
        for (const baseName of base.names) {
          const singular = `${prefixName.singular}${baseName.singular}`;
          const plural = `${prefixName.singular}${baseName.plural}`;
          const hyphenSingular = prefixName.singular
            ? `${prefixName.singular}-${baseName.singular}`
            : baseName.singular;
          const hyphenPlural = prefixName.singular
            ? `${prefixName.singular}-${baseName.plural}`
            : baseName.plural;

          assignUnitSynonym(map, singular, canonical);
          assignUnitSynonym(map, plural, canonical);
          assignUnitSynonym(map, hyphenSingular, canonical);
          assignUnitSynonym(map, hyphenPlural, canonical);
        }
      }
    }
  }
}

export const HOUSEHOLD_VOLUME_UNITS = ["tsp", "tbsp"] as const;

const STATIC_UNIT_SYNONYMS: UnitSynonymMap = {
  tab: "tab",
  tabs: "tab",
  tablet: "tab",
  tablets: "tab",
  cap: "cap",
  caps: "cap",
  capsule: "cap",
  capsules: "cap",
  puff: "puff",
  puffs: "puff",
  spray: "spray",
  sprays: "spray",
  drop: "drop",
  drops: "drop",
  patch: "patch",
  patches: "patch",
  supp: "suppository",
  suppository: "suppository",
  suppositories: "suppository",
  tsp: "tsp",
  "tsp.": "tsp",
  tsps: "tsp",
  "tsps.": "tsp",
  teaspoon: "tsp",
  teaspoons: "tsp",
  tbsp: "tbsp",
  "tbsp.": "tbsp",
  tbs: "tbsp",
  "tbs.": "tbsp",
  tablespoon: "tbsp",
  tablespoons: "tbsp",
};

export const DEFAULT_UNIT_SYNONYMS: Record<string, string> = (() => {
  const map: UnitSynonymMap = { ...STATIC_UNIT_SYNONYMS };
  addMetricUnitSynonyms(map);
  return map;
})();

export interface FrequencyDescriptor {
  code?: string;
  frequency?: number;
  frequencyMax?: number;
  period?: number;
  periodMax?: number;
  periodUnit?: FhirPeriodUnit;
  discouraged?: string;
  when?: EventTiming[];
}

export const TIMING_ABBREVIATIONS: Record<string, FrequencyDescriptor> = {
  qd: {
    code: "QD",
    frequency: 1,
    period: 1,
    periodUnit: FhirPeriodUnit.Day,
    discouraged: "QD"
  },
  qod: {
    code: "QOD",
    period: 2,
    periodUnit: FhirPeriodUnit.Day,
    discouraged: "QOD"
  },
  od: {
    code: "QD",
    frequency: 1,
    period: 1,
    periodUnit: FhirPeriodUnit.Day
  },
  ad: {
    period: 2,
    periodUnit: FhirPeriodUnit.Day,
    discouraged: "AD"
  },
  bid: {
    code: "BID",
    frequency: 2,
    period: 1,
    periodUnit: FhirPeriodUnit.Day
  },
  tid: {
    code: "TID",
    frequency: 3,
    period: 1,
    periodUnit: FhirPeriodUnit.Day
  },
  qid: {
    code: "QID",
    frequency: 4,
    period: 1,
    periodUnit: FhirPeriodUnit.Day
  },
  q1h: { code: "Q1H", period: 1, periodUnit: FhirPeriodUnit.Hour },
  q2h: { code: "Q2H", period: 2, periodUnit: FhirPeriodUnit.Hour },
  q3h: { code: "Q3H", period: 3, periodUnit: FhirPeriodUnit.Hour },
  q4h: { code: "Q4H", period: 4, periodUnit: FhirPeriodUnit.Hour },
  q6h: { code: "Q6H", period: 6, periodUnit: FhirPeriodUnit.Hour },
  q8h: { code: "Q8H", period: 8, periodUnit: FhirPeriodUnit.Hour },
  q12h: { code: "Q12H", period: 12, periodUnit: FhirPeriodUnit.Hour },
  q24h: { code: "Q24H", period: 24, periodUnit: FhirPeriodUnit.Hour },
  q1d: {
    code: "QD",
    frequency: 1,
    period: 1,
    periodUnit: FhirPeriodUnit.Day
  },
  q2d: { code: "Q2D", period: 2, periodUnit: FhirPeriodUnit.Day },
  q3d: { code: "Q3D", period: 3, periodUnit: FhirPeriodUnit.Day },
  q1wk: { code: "WK", period: 1, periodUnit: FhirPeriodUnit.Week },
  q1w: { code: "WK", period: 1, periodUnit: FhirPeriodUnit.Week },
  q2wk: { code: "Q2WK", period: 2, periodUnit: FhirPeriodUnit.Week },
  q1mo: { code: "MO", period: 1, periodUnit: FhirPeriodUnit.Month },
  q2mo: { code: "Q2MO", period: 2, periodUnit: FhirPeriodUnit.Month },
  wk: { code: "WK", period: 1, periodUnit: FhirPeriodUnit.Week },
  weekly: { code: "WK", period: 1, periodUnit: FhirPeriodUnit.Week },
  mo: { code: "MO", period: 1, periodUnit: FhirPeriodUnit.Month },
  monthly: { code: "MO", period: 1, periodUnit: FhirPeriodUnit.Month },
  am: { code: "AM", when: [EventTiming.Morning] },
  pm: { code: "PM", when: [EventTiming.Evening] }
};

export const EVENT_TIMING_TOKENS: Record<string, EventTiming> = {
  ac: EventTiming["Before Meal"],
  acm: EventTiming["Before Breakfast"],
  acl: EventTiming["Before Lunch"],
  acd: EventTiming["Before Lunch"],
  acv: EventTiming["Before Dinner"],
  pc: EventTiming["After Meal"],
  pcm: EventTiming["After Breakfast"],
  pcl: EventTiming["After Lunch"],
  pcd: EventTiming["After Lunch"],
  pcv: EventTiming["After Dinner"],
  wm: EventTiming.Meal,
  "with meals": EventTiming.Meal,
  "@m": EventTiming.Meal,
  "@meal": EventTiming.Meal,
  "@meals": EventTiming.Meal,
  cm: EventTiming.Breakfast,
  cd: EventTiming.Lunch,
  cv: EventTiming.Dinner,
  am: EventTiming.Morning,
  morning: EventTiming.Morning,
  morn: EventTiming.Morning,
  noon: EventTiming.Noon,
  pm: EventTiming.Evening,
  evening: EventTiming.Evening,
  night: EventTiming.Night,
  hs: EventTiming["Before Sleep"],
  bedtime: EventTiming["Before Sleep"],
  wake: EventTiming.Wake,
  waking: EventTiming.Wake,
  stat: EventTiming.Immediate
};

export const MEAL_KEYWORDS: Record<
  string,
  { pc: EventTiming; ac: EventTiming }
> = {
  breakfast: { pc: EventTiming["After Breakfast"], ac: EventTiming["Before Breakfast"] },
  lunch: { pc: EventTiming["After Lunch"], ac: EventTiming["Before Lunch"] },
  dinner: { pc: EventTiming["After Dinner"], ac: EventTiming["Before Dinner"] },
  supper: { pc: EventTiming["After Dinner"], ac: EventTiming["Before Dinner"] }
};

export const DISCOURAGED_TOKENS: Record<string, string> = {
  qd: "QD",
  qod: "QOD",
  od: "OD",
  bld: "BLD",
  "b-l-d": "BLD",
  ad: "AD"
};

export const DAY_OF_WEEK_TOKENS: Record<string, FhirDayOfWeek> = {
  monday: FhirDayOfWeek.Monday,
  mon: FhirDayOfWeek.Monday,
  tuesday: FhirDayOfWeek.Tuesday,
  tue: FhirDayOfWeek.Tuesday,
  wednesday: FhirDayOfWeek.Wednesday,
  wed: FhirDayOfWeek.Wednesday,
  thursday: FhirDayOfWeek.Thursday,
  thu: FhirDayOfWeek.Thursday,
  friday: FhirDayOfWeek.Friday,
  fri: FhirDayOfWeek.Friday,
  saturday: FhirDayOfWeek.Saturday,
  sat: FhirDayOfWeek.Saturday,
  sunday: FhirDayOfWeek.Sunday,
  sun: FhirDayOfWeek.Sunday
};

export const WORD_FREQUENCIES: Record<string, { frequency: number; periodUnit: FhirPeriodUnit }> = {
  daily: { frequency: 1, periodUnit: FhirPeriodUnit.Day },
  "once daily": { frequency: 1, periodUnit: FhirPeriodUnit.Day },
  once: { frequency: 1, periodUnit: FhirPeriodUnit.Day },
  twice: { frequency: 2, periodUnit: FhirPeriodUnit.Day },
  "twice daily": { frequency: 2, periodUnit: FhirPeriodUnit.Day },
  "three times": { frequency: 3, periodUnit: FhirPeriodUnit.Day },
  "three times daily": { frequency: 3, periodUnit: FhirPeriodUnit.Day }
};

export const KNOWN_DOSAGE_FORMS_TO_DOSE: Record<string, string> = {
  "nasal spray, suspension": "nasal spray",
  "implantation chain": "implantation chain",
  capsule: "capsule",
  "capsule, soft": "capsule",
  "oral solution": "solution",
  "oral suspension": "suspension",
  "inhalation powder": "inhalation",
  "nasal spray, solution": "nasal spray",
  "pressurised inhalation, suspension": "inhalation",
  "pressurised inhalation, solution": "inhalation",
  "rectal foam": "rectal foam",
  "sublingual spray, solution": "sublingual spray",
  "inhalation vapour, solution": "inhalation vapour",
  "inhalation powder, pre-dispensed": "inhalation powder",
  "solution for injection": "injection",
  "inhalation solution": "inhalation",
  cream: "cream",
  "cutaneous powder": "cutaneous powder",
  "powder for solution for injection": "powder for solution for injection",
  gel: "gel",
  "granules for oral solution": "granules for oral solution",
  "powder for oral solution": "powder for oral solution",
  "oral paste": "oral paste",
  "cutaneous stick": "cutaneous stick",
  "prolonged-release granules": "prolonged-release granules",
  "oromucosal gel": "oromucosal gel",
  "oral powder": "oral powder",
  ointment: "ointment",
  "cutaneous paste": "cutaneous paste",
  "powder for oral suspension": "powder for oral suspension",
  "vaginal gel": "vaginal gel",
  "nasal drops, powder for solution": "nasal drops, powder for solution",
  "oral gel": "oral gel",
  "eye gel": "eye gel",
  "impregnated dressing": "impregnated dressing",
  "vaginal cream": "vaginal cream",
  "ear powder": "ear powder",
  "cutaneous emulsion": "cutaneous emulsion",
  "cutaneous liquid": "cutaneous liquid",
  "cutaneous solution": "cutaneous solution",
  "effervescent powder": "effervescent powder",
  "bath additive": "bath additive",
  "nasal spray, powder for solution": "nasal spray, powder for solution",
  "powder for cutaneous solution": "powder for cutaneous solution",
  "dental gel": "dental gel",
  "nasal gel": "nasal gel",
  "powder for oral/rectal suspension": "powder for oral/rectal suspension",
  "gingival gel": "gingival gel",
  "powder for solution for infusion": "powder for solution for infusion",
  "gastro-resistant granules": "gastro-resistant granules",
  "eye ointment": "eye ointment",
  "oromucosal spray, solution": "oromucosal spray, solution",
  granules: "granules",
  collodion: "collodion",
  "powder for rectal solution": "powder for rectal solution",
  "eye drops, solution": "eye drops, solution",
  // additional helpers
  "eye drops": "eye drops, solution",
  "eye drop": "eye drops, solution",
  "oromucosal paste": "oromucosal paste",
  "dental paste": "dental paste",
  "solution for peritoneal dialysis": "solution for peritoneal dialysis",
  paste: "paste",
  "effervescent granules": "effervescent granules",
  shampoo: "shampoo",
  "solution for infusion": "solution for infusion",
  syrup: "syrup",
  "oral liquid": "oral liquid",
  "oral drops, solution": "oral drops, solution",
  "emulsion for infusion": "emulsion for infusion",
  "irrigation solution": "irrigation solution",
  "solution for injection/infusion": "solution for injection/infusion",
  "solution for haemodialysis/haemofiltration":
    "solution for haemodialysis/haemofiltration",
  "solution for organ preservation": "solution for organ preservation",
  "gargle/mouthwash": "gargle/mouthwash",
  "concentrate for solution for injection/infusion":
    "concentrate for solution for injection/infusion",
  "concentrate for cutaneous solution": "concentrate for cutaneous solution",
  "cutaneous spray, solution": "cutaneous spray, solution",
  "concentrate for dip solution": "concentrate for dip solution",
  "oral emulsion": "oral emulsion",
  "concentrate for oral solution": "concentrate for oral solution",
  "concentrate for haemodialysis solution":
    "concentrate for haemodialysis solution",
  "suspension for injection": "suspension for injection",
  "powder and solvent for solution for injection":
    "powder and solvent for solution for injection",
  "powder and suspension for suspension for injection":
    "powder and suspension for suspension for injection",
  "powder for suspension for injection": "powder for suspension for injection",
  "transdermal patch": "transdermal patch",
  "powder and solvent for suspension for injection":
    "powder and solvent for suspension for injection",
  "endotracheopulmonary instillation, powder for solution":
    "endotracheopulmonary instillation, powder for solution",
  "intrauterine delivery system": "intrauterine delivery system",
  implant: "implant",
  "powder for solution for injection/infusion":
    "powder for solution for injection/infusion",
  "concentrate for solution for injection":
    "concentrate for solution for injection",
  "eye drops, emulsion": "eye drops, emulsion",
  "concentrate for dispersion for injection":
    "concentrate for dispersion for injection",
  "concentrate for solution for infusion":
    "concentrate for solution for infusion",
  "concentrate and solvent for solution for infusion":
    "concentrate and solvent for solution for infusion",
  "concentrate and solvent for suspension for injection":
    "concentrate and solvent for suspension for injection",
  "gel for injection": "gel for injection",
  "prolonged-release suspension for injection":
    "prolonged-release suspension for injection",
  "rectal solution": "rectal solution",
  "emulsion for injection": "emulsion for injection",
  "oromucosal solution": "oromucosal solution",
  "powder and solvent for solution for infusion":
    "powder and solvent for solution for infusion",
  "emulsion for injection/infusion": "emulsion for injection/infusion",
  "solution for cardioplegia": "solution for cardioplegia",
  "endotracheopulmonary instillation, suspension":
    "endotracheopulmonary instillation, suspension",
  "ear drops, solution": "ear drops, solution",
  "eye drops, suspension": "eye drops, suspension",
  "nasal drops, solution": "nasal drops, solution",
  "suspension and solution for spray": "suspension and solution for spray",
  "solution for sealant": "solution for sealant",
  "inhalation vapour, liquid": "inhalation vapour, liquid",
  "ear drops, suspension": "ear drops, suspension",
  "dental suspension": "dental suspension",
  "nebuliser solution": "nebuliser solution",
  "concentrate for gargle": "concentrate for gargle",
  "ear/eye drops, solution": "ear/eye drops, solution",
  "ear wash, solution": "ear wash, solution",
  "oromucosal drops": "oromucosal drops",
  "powder for syrup": "powder for syrup",
  "cutaneous suspension": "cutaneous suspension",
  "eye lotion": "eye lotion",
  "rectal suspension": "rectal suspension",
  "intestinal gel": "intestinal gel",
  "dental solution": "dental solution",
  "gingival solution": "gingival solution",
  "oral drops, suspension": "oral drops, suspension",
  "eye drops, tablet and solvent for solution":
    "eye drops, tablet and solvent for solution",
  "nebuliser suspension": "nebuliser suspension",
  "dispersion for injection": "dispersion for injection",
  "powder and solvent for oral solution":
    "powder and solvent for oral solution",
  solution: "solution",
  "powder and solvent for oral suspension":
    "powder and solvent for oral suspension",
  "suspension and effervescent granules for oral suspension":
    "suspension and effervescent granules for oral suspension",
  "oral drops, emulsion": "oral drops, emulsion",
  "oral drops, liquid": "oral drops, liquid",
  "oral/rectal suspension": "oral/rectal suspension",
  "intravesical solution": "intravesical solution",
  "granules for oral suspension": "granules for oral suspension",
  "granules for syrup": "granules for syrup",
  tablet: "tablet",
  "film-coated tablet": "film-coated tablet",
  "coated tablet": "coated tablet",
  "chewable tablet": "chewable tablet",
  "capsule, hard": "capsule, hard",
  "gastro-resistant tablet": "gastro-resistant tablet",
  "gastro-resistant granules for oral suspension":
    "gastro-resistant granules for oral suspension",
  "orodispersible tablet": "orodispersible tablet",
  "gastro-resistant capsule, hard": "gastro-resistant capsule, hard",
  "prolonged-release capsule, hard": "prolonged-release capsule, hard",
  "prolonged-release tablet": "prolonged-release tablet",
  suppository: "suppository",
  lozenge: "lozenge",
  "modified-release tablet": "modified-release tablet",
  "dispersible tablet": "dispersible tablet",
  injection: "injection",
  "powder for concentrate for solution for infusion":
    "powder for concentrate for solution for infusion",
  "powder and solvent for solution for injection/infusion":
    "powder and solvent for solution for injection/infusion",
  "powder and solvent for prolonged-release suspension for injection":
    "powder and solvent for prolonged-release suspension for injection",
  "powder and solvent for concentrate for solution for infusion":
    "powder and solvent for concentrate for solution for infusion",
  "sublingual tablet": "sublingual tablet",
  "effervescent tablet": "effervescent tablet",
  "vaginal tablet": "vaginal tablet",
  "inhalation powder, hard capsule": "inhalation powder, hard capsule",
  pessary: "pessary",
  "vaginal capsule, hard": "vaginal capsule, hard",
  pastille: "pastille",
  "medicated chewing-gum": "medicated chewing-gum",
  "vaginal delivery system": "vaginal delivery system",
  "medicated plaster": "medicated plaster",
  "intravitreal implant in applicator": "intravitreal implant in applicator",
  "vaginal capsule, soft": "vaginal capsule, soft",
  "lyophilisate and solvent for solution for injection":
    "lyophilisate and solvent for solution for injection",
  "powder for concentrate for dispersion for infusion":
    "powder for concentrate for dispersion for infusion",
  "powder for suspension for infusion": "powder for suspension for infusion",
  "cutaneous patch": "cutaneous patch",
  "modified-release capsule, hard": "modified-release capsule, hard",
  "oral lyophilisate": "oral lyophilisate",
  "powders for solution for injection": "powders for solution for injection",
  "capsule, hard-capsule, soft-tablet": "capsule, hard-capsule, soft-tablet",
  "capsule, hard-tablet": "capsule, hard-tablet"
};

/**
 * Map of normalized dosage-form labels to their associated SNOMED route code.
 * The keys intentionally mirror KNOWN_DOSAGE_FORMS_TO_DOSE to keep lookups simple.
 */
export const KNOWN_TMT_DOSAGE_FORM_TO_SNOMED_ROUTE: Record<
  string,
  SNOMEDCTRouteCodes
> = {
  "nasal spray, suspension": SNOMEDCTRouteCodes["Nasal route"],
  "implantation chain": SNOMEDCTRouteCodes["Intralesional use"],
  capsule: SNOMEDCTRouteCodes["Oral route"],
  "capsule, soft": SNOMEDCTRouteCodes["Oral route"],
  "oral solution": SNOMEDCTRouteCodes["Oral route"],
  "oral suspension": SNOMEDCTRouteCodes["Oral route"],
  "inhalation powder": SNOMEDCTRouteCodes["Respiratory tract route (qualifier value)"],
  "nasal spray, solution": SNOMEDCTRouteCodes["Nasal route"],
  "pressurised inhalation, suspension": SNOMEDCTRouteCodes["Respiratory tract route (qualifier value)"],
  "pressurised inhalation, solution": SNOMEDCTRouteCodes["Respiratory tract route (qualifier value)"],
  "rectal foam": SNOMEDCTRouteCodes["Per rectum"],
  "sublingual spray, solution": SNOMEDCTRouteCodes["Sublingual route"],
  "inhalation vapour, solution": SNOMEDCTRouteCodes["Respiratory tract route (qualifier value)"],
  "inhalation powder, pre-dispensed": SNOMEDCTRouteCodes["Respiratory tract route (qualifier value)"],
  "solution for injection": SNOMEDCTRouteCodes["Intravenous route"],
  "inhalation solution": SNOMEDCTRouteCodes["Respiratory tract route (qualifier value)"],
  cream: SNOMEDCTRouteCodes["Topical route"],
  "cutaneous powder": SNOMEDCTRouteCodes["Topical route"],
  "powder for solution for injection": SNOMEDCTRouteCodes["Intravenous route"],
  gel: SNOMEDCTRouteCodes["Topical route"],
  "granules for oral solution": SNOMEDCTRouteCodes["Oral route"],
  "powder for oral solution": SNOMEDCTRouteCodes["Oral route"],
  "oral paste": SNOMEDCTRouteCodes["Oromucosal use"],
  "cutaneous stick": SNOMEDCTRouteCodes["Transdermal route"],
  "prolonged-release granules": SNOMEDCTRouteCodes["Oral route"],
  "oromucosal gel": SNOMEDCTRouteCodes["Oromucosal use"],
  "oral powder": SNOMEDCTRouteCodes["Oral route"],
  ointment: SNOMEDCTRouteCodes["Topical route"],
  "cutaneous paste": SNOMEDCTRouteCodes["Topical route"],
  "powder for oral suspension": SNOMEDCTRouteCodes["Oral route"],
  "vaginal gel": SNOMEDCTRouteCodes["Per vagina"],
  "nasal drops, powder for solution": SNOMEDCTRouteCodes["Nasal route"],
  "oral gel": SNOMEDCTRouteCodes["Oromucosal use"],
  "eye gel": SNOMEDCTRouteCodes["Ocular route (qualifier value)"],
  "impregnated dressing": SNOMEDCTRouteCodes["Topical route"],
  "vaginal cream": SNOMEDCTRouteCodes["Per vagina"],
  "ear powder": SNOMEDCTRouteCodes["Otic route"],
  "cutaneous emulsion": SNOMEDCTRouteCodes["Topical route"],
  "cutaneous liquid": SNOMEDCTRouteCodes["Topical route"],
  "cutaneous solution": SNOMEDCTRouteCodes["Cutaneous route (qualifier value)"],
  "effervescent powder": SNOMEDCTRouteCodes["Oral route"],
  "bath additive": SNOMEDCTRouteCodes["Topical route"],
  "nasal spray, powder for solution": SNOMEDCTRouteCodes["Nasal route"],
  "powder for cutaneous solution": SNOMEDCTRouteCodes["Topical route"],
  "dental gel": SNOMEDCTRouteCodes["Gingival use"],
  "nasal gel": SNOMEDCTRouteCodes["Nasal route"],
  "powder for oral/rectal suspension": SNOMEDCTRouteCodes["Oral route"],
  "gingival gel": SNOMEDCTRouteCodes["Gingival use"],
  "powder for solution for infusion": SNOMEDCTRouteCodes["Intravenous route"],
  "gastro-resistant granules": SNOMEDCTRouteCodes["Oral route"],
  "eye ointment": SNOMEDCTRouteCodes["Ocular route (qualifier value)"],
  "oromucosal spray, solution": SNOMEDCTRouteCodes["Oropharyngeal route (qualifier value)"],
  granules: SNOMEDCTRouteCodes["Oral route"],
  collodion: SNOMEDCTRouteCodes["Oral route"],
  "powder for rectal solution": SNOMEDCTRouteCodes["Per rectum"],
  "eye drops, solution": SNOMEDCTRouteCodes["Ocular route (qualifier value)"],
  "eye drops": SNOMEDCTRouteCodes["Ocular route (qualifier value)"],
  "eye drop": SNOMEDCTRouteCodes["Ocular route (qualifier value)"],
  "oromucosal paste": SNOMEDCTRouteCodes["Oromucosal use"],
  "dental paste": SNOMEDCTRouteCodes["Dental use"],
  "solution for peritoneal dialysis": SNOMEDCTRouteCodes["Intradialytic route"],
  paste: SNOMEDCTRouteCodes["Topical route"],
  "effervescent granules": SNOMEDCTRouteCodes["Oral route"],
  shampoo: SNOMEDCTRouteCodes["Topical route"],
  "solution for infusion": SNOMEDCTRouteCodes["Intravenous route"],
  syrup: SNOMEDCTRouteCodes["Oral route"],
  "oral liquid": SNOMEDCTRouteCodes["Oral route"],
  "oral drops, solution": SNOMEDCTRouteCodes["Oral route"],
  "emulsion for infusion": SNOMEDCTRouteCodes["Intravenous route"],
  "irrigation solution": SNOMEDCTRouteCodes["Topical route"],
  "solution for injection/infusion": SNOMEDCTRouteCodes["Intravenous route"],
  "solution for haemodialysis/haemofiltration": SNOMEDCTRouteCodes["Intradialytic route"],
  "solution for organ preservation": SNOMEDCTRouteCodes["Extracorporeal route (qualifier value)"],
  "gargle/mouthwash": SNOMEDCTRouteCodes["Oromucosal use"],
  "concentrate for solution for injection/infusion": SNOMEDCTRouteCodes["Intravenous route"],
  "concentrate for cutaneous solution": SNOMEDCTRouteCodes["Cutaneous route (qualifier value)"],
  "cutaneous spray, solution": SNOMEDCTRouteCodes["Cutaneous route (qualifier value)"],
  "concentrate for dip solution": SNOMEDCTRouteCodes["Topical route"],
  "oral emulsion": SNOMEDCTRouteCodes["Oral route"],
  "concentrate for oral solution": SNOMEDCTRouteCodes["Oral route"],
  "concentrate for haemodialysis solution": SNOMEDCTRouteCodes["Intradialytic route"],
  "suspension for injection": SNOMEDCTRouteCodes["Intravenous route"],
  "powder and solvent for solution for injection": SNOMEDCTRouteCodes["Intravenous route"],
  "powder and suspension for suspension for injection": SNOMEDCTRouteCodes["Intravenous route"],
  "powder for suspension for injection": SNOMEDCTRouteCodes["Intravenous route"],
  "transdermal patch": SNOMEDCTRouteCodes["Transdermal route"],
  "powder and solvent for suspension for injection": SNOMEDCTRouteCodes["Intravenous route"],
  "endotracheopulmonary instillation, powder for solution": SNOMEDCTRouteCodes["Endotracheopulmonary use"],
  "intrauterine delivery system": SNOMEDCTRouteCodes["Intrauterine route"],
  implant: SNOMEDCTRouteCodes["Intradermal use"],
  "powder for solution for injection/infusion": SNOMEDCTRouteCodes["Intravenous route"],
  "concentrate for solution for injection": SNOMEDCTRouteCodes["Intravenous route"],
  "eye drops, emulsion": SNOMEDCTRouteCodes["Ocular route (qualifier value)"],
  "concentrate for dispersion for injection": SNOMEDCTRouteCodes["Intravenous route"],
  "concentrate for solution for infusion": SNOMEDCTRouteCodes["Intravenous route"],
  "concentrate and solvent for solution for infusion": SNOMEDCTRouteCodes["Intravenous route"],
  "concentrate and solvent for suspension for injection": SNOMEDCTRouteCodes["Intravenous route"],
  "gel for injection": SNOMEDCTRouteCodes["Intramuscular route"],
  "prolonged-release suspension for injection": SNOMEDCTRouteCodes["Intramuscular route"],
  "rectal solution": SNOMEDCTRouteCodes["Per rectum"],
  "emulsion for injection": SNOMEDCTRouteCodes["Intramuscular route"],
  "oromucosal solution": SNOMEDCTRouteCodes["Oromucosal use"],
  "powder and solvent for solution for infusion": SNOMEDCTRouteCodes["Intravenous route"],
  "emulsion for injection/infusion": SNOMEDCTRouteCodes["Intravenous route"],
  "solution for cardioplegia": SNOMEDCTRouteCodes["Intravenous route"],
  "endotracheopulmonary instillation, suspension": SNOMEDCTRouteCodes["Endotracheopulmonary use"],
  "ear drops, solution": SNOMEDCTRouteCodes["Otic route"],
  "eye drops, suspension": SNOMEDCTRouteCodes["Ocular route (qualifier value)"],
  "nasal drops, solution": SNOMEDCTRouteCodes["Nasal route"],
  "suspension and solution for spray": SNOMEDCTRouteCodes["Respiratory tract route (qualifier value)"],
  "solution for sealant": SNOMEDCTRouteCodes["Topical route"],
  "inhalation vapour, liquid": SNOMEDCTRouteCodes["Respiratory tract route (qualifier value)"],
  "ear drops, suspension": SNOMEDCTRouteCodes["Otic route"],
  "dental suspension": SNOMEDCTRouteCodes["Dental use"],
  "nebuliser solution": SNOMEDCTRouteCodes["Respiratory tract route (qualifier value)"],
  "concentrate for gargle": SNOMEDCTRouteCodes["Oropharyngeal route (qualifier value)"],
  "ear/eye drops, solution": SNOMEDCTRouteCodes["Ocular route (qualifier value)"],
  "ear wash, solution": SNOMEDCTRouteCodes["Otic route"],
  "oromucosal drops": SNOMEDCTRouteCodes["Oromucosal use"],
  "powder for syrup": SNOMEDCTRouteCodes["Oral route"],
  "cutaneous suspension": SNOMEDCTRouteCodes["Cutaneous route (qualifier value)"],
  "eye lotion": SNOMEDCTRouteCodes["Ocular route (qualifier value)"],
  "rectal suspension": SNOMEDCTRouteCodes["Per rectum"],
  "intestinal gel": SNOMEDCTRouteCodes["Intestinal route (qualifier value)"],
  "dental solution": SNOMEDCTRouteCodes["Dental use"],
  "gingival solution": SNOMEDCTRouteCodes["Gingival use"],
  "oral drops, suspension": SNOMEDCTRouteCodes["Oral route"],
  "eye drops, tablet and solvent for solution": SNOMEDCTRouteCodes["Ocular route (qualifier value)"],
  "nebuliser suspension": SNOMEDCTRouteCodes["Respiratory tract route (qualifier value)"],
  "dispersion for injection": SNOMEDCTRouteCodes["Intravenous route"],
  "powder and solvent for oral solution": SNOMEDCTRouteCodes["Oral route"],
  solution: SNOMEDCTRouteCodes["Oral route"],
  "powder and solvent for oral suspension": SNOMEDCTRouteCodes["Oral route"],
  "suspension and effervescent granules for oral suspension": SNOMEDCTRouteCodes["Oral route"],
  "oral drops, emulsion": SNOMEDCTRouteCodes["Oral route"],
  "oral drops, liquid": SNOMEDCTRouteCodes["Oral route"],
  "oral/rectal suspension": SNOMEDCTRouteCodes["Oral route"],
  "intravesical solution": SNOMEDCTRouteCodes["Intralesional use"],
  "granules for oral suspension": SNOMEDCTRouteCodes["Oral route"],
  "granules for syrup": SNOMEDCTRouteCodes["Oral route"],
  tablet: SNOMEDCTRouteCodes["Oral route"],
  "film-coated tablet": SNOMEDCTRouteCodes["Oral route"],
  "coated tablet": SNOMEDCTRouteCodes["Oral route"],
  "chewable tablet": SNOMEDCTRouteCodes["Oral route"],
  "capsule, hard": SNOMEDCTRouteCodes["Oral route"],
  "gastro-resistant tablet": SNOMEDCTRouteCodes["Oral route"],
  "gastro-resistant granules for oral suspension": SNOMEDCTRouteCodes["Oral route"],
  "orodispersible tablet": SNOMEDCTRouteCodes["Oral route"],
  "gastro-resistant capsule, hard": SNOMEDCTRouteCodes["Oral route"],
  "prolonged-release capsule, hard": SNOMEDCTRouteCodes["Oral route"],
  "prolonged-release tablet": SNOMEDCTRouteCodes["Oral route"],
  suppository: SNOMEDCTRouteCodes["Per rectum"],
  lozenge: SNOMEDCTRouteCodes["Oropharyngeal route (qualifier value)"],
  "modified-release tablet": SNOMEDCTRouteCodes["Oral route"],
  "dispersible tablet": SNOMEDCTRouteCodes["Oral route"],
  injection: SNOMEDCTRouteCodes["Intravenous route"],
  "powder for concentrate for solution for infusion": SNOMEDCTRouteCodes["Intravenous route"],
  "powder and solvent for solution for injection/infusion": SNOMEDCTRouteCodes["Intravenous route"],
  "powder and solvent for prolonged-release suspension for injection": SNOMEDCTRouteCodes["Intravenous route"],
  "powder and solvent for concentrate for solution for infusion": SNOMEDCTRouteCodes["Intravenous route"],
  "sublingual tablet": SNOMEDCTRouteCodes["Sublingual route"],
  "effervescent tablet": SNOMEDCTRouteCodes["Oral route"],
  "vaginal tablet": SNOMEDCTRouteCodes["Per vagina"],
  "inhalation powder, hard capsule": SNOMEDCTRouteCodes["Respiratory tract route (qualifier value)"],
  pessary: SNOMEDCTRouteCodes["Per vagina"],
  "vaginal capsule, hard": SNOMEDCTRouteCodes["Per vagina"],
  pastille: SNOMEDCTRouteCodes["Oral route"],
  "medicated chewing-gum": SNOMEDCTRouteCodes["Oral route"],
  "vaginal delivery system": SNOMEDCTRouteCodes["Per vagina"],
  "medicated plaster": SNOMEDCTRouteCodes["Transdermal route"],
  "intravitreal implant in applicator": SNOMEDCTRouteCodes["Intravitreal route (qualifier value)"],
  "vaginal capsule, soft": SNOMEDCTRouteCodes["Per vagina"],
  "lyophilisate and solvent for solution for injection": SNOMEDCTRouteCodes["Intravenous route"],
  "powder for concentrate for dispersion for infusion": SNOMEDCTRouteCodes["Intravenous route"],
  "powder for suspension for infusion": SNOMEDCTRouteCodes["Intravenous route"],
  "cutaneous patch": SNOMEDCTRouteCodes["Cutaneous route (qualifier value)"],
  "modified-release capsule, hard": SNOMEDCTRouteCodes["Oral route"],
  "oral lyophilisate": SNOMEDCTRouteCodes["Oral route"],
  "powders for solution for injection": SNOMEDCTRouteCodes["Intravenous route"],
  "capsule, hard-capsule, soft-tablet": SNOMEDCTRouteCodes["Oral route"],
  "capsule, hard-tablet": SNOMEDCTRouteCodes["Oral route"]
};

export const DEFAULT_UNIT_BY_NORMALIZED_FORM: Record<string, string> = {
  tab: "tab",
  tabs: "tab",
  tablet: "tab",
  "film-coated tablet": "tab",
  "coated tablet": "tab",
  "chewable tablet": "tab",
  "dispersible tablet": "tab",
  "gastro-resistant tablet": "tab",
  "modified-release tablet": "tab",
  "orodispersible tablet": "tab",
  capsule: "cap",
  caps: "cap",
  "capsule, soft": "cap",
  "capsule, hard": "cap",
  "gastro-resistant capsule, hard": "cap",
  "prolonged-release capsule, hard": "cap",
  "modified-release capsule, hard": "cap",
  "inhalation powder, hard capsule": "cap",
  solution: "mL",
  "oral solution": "mL",
  "solution for injection": "mL",
  "solution for infusion": "mL",
  suspension: "mL",
  "oral suspension": "mL",
  "powder for oral suspension": "mL",
  syrup: "mL",
  "oral liquid": "mL",
  "oral drops, solution": "mL",
  "oral drops, suspension": "mL",
  "oral drops, emulsion": "mL",
  "oral drops, liquid": "mL",
  "oral emulsion": "mL",
  "granules for oral solution": "mL",
  "granules for oral suspension": "mL",
  "nasal spray": "spray",
  "nasal spray, suspension": "spray",
  "nasal spray, solution": "spray",
  "nasal spray, powder for solution": "spray",
  "sublingual spray": "spray",
  "sublingual spray, solution": "spray",
  spray: "spray",
  "cutaneous spray, solution": "spray",
  inhalation: "puff",
  "inhalation powder": "puff",
  "pressurised inhalation, suspension": "puff",
  "pressurised inhalation, solution": "puff",
  "inhalation solution": "puff",
  "inhalation vapour": "puff",
  "inhalation vapour, solution": "puff",
  "inhalation vapour, liquid": "puff",
  "nebuliser solution": "puff",
  "nebuliser suspension": "puff",
  ointment: "g",
  cream: "g",
  gel: "g",
  paste: "g",
  "oral paste": "g",
  suppository: "suppository",
  suppositories: "suppository",
  "rectal foam": "suppository",
  "rectal solution": "suppository",
  "rectal suspension": "suppository",
  patch: "patch",
  "transdermal patch": "patch",
  "cutaneous patch": "patch",
  "medicated plaster": "patch",
  "cutaneous stick": "stick",
  drop: "drop",
  drops: "drop",
  "eye drops, solution": "drop",
  "eye drops, suspension": "drop",
  "ear drops, solution": "drop",
  "ear drops, suspension": "drop",
  "ear/eye drops, solution": "drop",
  lozenge: "lozenge",
  pastille: "lozenge",
  pessary: "pessary",
  injection: "mL",
  implant: "implant",
  "implantation chain": "implant",
  "intrauterine delivery system": "implant",
  "intravitreal implant in applicator": "implant",
  "medicated chewing-gum": "piece"
};

const ROUTE_UNIT_FALLBACK_WHITELIST = new Set([
  "drop",
  "puff",
  "spray",
  "patch",
  "suppository",
  "implant",
  "piece",
  "stick",
  "pessary",
  "lozenge"
]);

export const DEFAULT_UNIT_BY_ROUTE: Partial<Record<RouteCode, string>> = (() => {
  const unitCandidates = new Map<RouteCode, Set<string>>();

  for (const [form, snomed] of objectEntries(KNOWN_TMT_DOSAGE_FORM_TO_SNOMED_ROUTE)) {
    const routeCode = ROUTE_BY_SNOMED[snomed];
    if (!routeCode) {
      continue;
    }
    const unit = DEFAULT_UNIT_BY_NORMALIZED_FORM[form];
    if (!unit) {
      continue;
    }
    let unitsForRoute = unitCandidates.get(routeCode);
    if (!unitsForRoute) {
      unitsForRoute = new Set();
      unitCandidates.set(routeCode, unitsForRoute);
    }
    unitsForRoute.add(unit);
  }

  const resolved: Partial<Record<RouteCode, string>> = {};
  for (const [route, units] of unitCandidates) {
    if (units.size !== 1) {
      continue;
    }
    const [unit] = Array.from(units);
    if (unit && ROUTE_UNIT_FALLBACK_WHITELIST.has(unit)) {
      resolved[route] = unit;
    }
  }

  const ensure = (route: RouteCode, unit: string) => {
    if (ROUTE_UNIT_FALLBACK_WHITELIST.has(unit)) {
      resolved[route] = unit;
    }
  };

  ensure(RouteCode["Ophthalmic route"], "drop");
  ensure(RouteCode["Ocular route (qualifier value)"], "drop");
  ensure(RouteCode["Otic route"], "drop");
  ensure(RouteCode["Respiratory tract route (qualifier value)"], "puff");
  ensure(RouteCode["Transdermal route"], "patch");

  return resolved;
})();
