import {
  BodySiteDefinition,
  EventTiming,
  FhirDayOfWeek,
  FhirPeriodUnit,
  PrnReasonDefinition,
  RouteCode,
  SNOMEDCTRouteCodes
} from "./types";
import {
  SNOMED_CT_BILATERAL_QUALIFIER_CODE,
  SNOMED_CT_BILATERAL_QUALIFIER_DISPLAY,
  SNOMED_CT_LEFT_QUALIFIER_CODE,
  SNOMED_CT_LEFT_QUALIFIER_DISPLAY,
  SNOMED_CT_RIGHT_QUALIFIER_CODE,
  SNOMED_CT_RIGHT_QUALIFIER_DISPLAY,
  SNOMED_SYSTEM
} from "./snomed";
import { buildSnomedBodySiteLateralityPostcoordinationCode } from "./snomed-postcoordination";
import {
  DEFAULT_SYMPTOM_DEFINITIONS,
  DEFAULT_SYMPTOM_ENTRIES,
  findSymptomDefinitionByCoding,
  normalizeSymptomKey,
  type SymptomDictionaryEntry
} from "./symptom-terminology";
import { objectEntries, objectFromEntries } from "./utils/object";
import { normalizeLoosePhraseKey } from "./utils/text";

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

  const assignWithAdverb = (key: string | undefined, code: RouteCode) => {
    assign(key, code);
    if (!key) return;
    const normalized = key.trim().toLowerCase();
    if (!normalized) {
      return;
    }
    if (!/^[a-z]+$/.test(normalized)) {
      return;
    }
    if (normalized.length < 4 || normalized.endsWith("ly") || normalized.endsWith("eal")) {
      return;
    }
    let adverb: string | undefined;
    if (normalized.endsWith("ic")) {
      adverb = normalized.replace(/ic$/, "ically");
    } else {
      adverb = `${normalized}ly`;
    }
    assign(adverb, code);
  };

  const registerVariants = (value: string | undefined, code: RouteCode) => {
    if (!value) return;
    assignWithAdverb(value, code);
    const withoutParens = value
      .replace(/[()]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    assignWithAdverb(withoutParens, code);
    const withoutCommas = value
      .replace(/,/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    assignWithAdverb(withoutCommas, code);
    const withoutPunctuation = value
      .replace(/[().,-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    assignWithAdverb(withoutPunctuation, code);
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
  registerVariants("ใต้ผิวหนัง", RouteCode["Subcutaneous route"]);
  registerVariants("เข้าใต้ผิวหนัง", RouteCode["Subcutaneous route"]);
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
  registerVariants("supp", RouteCode["Per rectum"]);
  registerVariants("suppo", RouteCode["Per rectum"]);
  registerVariants("suppository", RouteCode["Per rectum"]);
  registerVariants("suppositories", RouteCode["Per rectum"]);
  registerVariants("ทางทวารหนัก", RouteCode["Per rectum"]);
  registerVariants("pv", RouteCode["Per vagina"]);
  registerVariants("vaginal", RouteCode["Per vagina"]);
  registerVariants("ทางช่องคลอด", RouteCode["Per vagina"]);
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

/**
 * Normalizes body-site phrases into lookup keys by trimming, lower-casing, and
 * collapsing whitespace. Custom site maps should normalize their keys with the
 * same logic to ensure consistent lookups.
 */
export function normalizeBodySiteKey(value: string): string {
  return normalizeLoosePhraseKey(value);
}

type BodySiteSnomedSourceEntry = {
  names: string[];
  definition: BodySiteDefinition;
};

interface LateralizableBodySiteDefinition {
  text: string;
  pluralText: string;
  code: string;
  display: string;
  englishNames: string[];
  pluralEnglishNames: string[];
  thaiNames: string[];
  routeHint?: RouteCode;
}

const BODY_SITE_LATERALITIES = [
  {
    textPrefix: "left",
    englishPrefix: "left",
    thaiSuffixes: ["ซ้าย"],
    code: SNOMED_CT_LEFT_QUALIFIER_CODE,
    display: SNOMED_CT_LEFT_QUALIFIER_DISPLAY
  },
  {
    textPrefix: "right",
    englishPrefix: "right",
    thaiSuffixes: ["ขวา"],
    code: SNOMED_CT_RIGHT_QUALIFIER_CODE,
    display: SNOMED_CT_RIGHT_QUALIFIER_DISPLAY
  },
  {
    textPrefix: "both",
    englishPrefix: "both",
    thaiSuffixes: ["ทั้งสองข้าง", "สองข้าง"],
    code: SNOMED_CT_BILATERAL_QUALIFIER_CODE,
    display: SNOMED_CT_BILATERAL_QUALIFIER_DISPLAY
  }
] as const;

const LATERALIZABLE_DIGIT_BODY_SITES: LateralizableBodySiteDefinition[] = [
  {
    text: "thumb",
    pluralText: "thumbs",
    code: "76505004",
    display: "Thumb",
    englishNames: ["thumb"],
    pluralEnglishNames: ["thumbs"],
    thaiNames: ["นิ้วโป้ง", "นิ้วโป้งมือ", "นิ้วหัวแม่มือ", "หัวแม่มือ"]
  },
  {
    text: "index finger",
    pluralText: "index fingers",
    code: "83738005",
    display: "Index finger",
    englishNames: ["index finger"],
    pluralEnglishNames: ["index fingers"],
    thaiNames: ["นิ้วชี้", "นิ้วชี้มือ"]
  },
  {
    text: "middle finger",
    pluralText: "middle fingers",
    code: "65531009",
    display: "Middle finger",
    englishNames: ["middle finger"],
    pluralEnglishNames: ["middle fingers"],
    thaiNames: ["นิ้วกลาง", "นิ้วกลางมือ"]
  },
  {
    text: "ring finger",
    pluralText: "ring fingers",
    code: "82002001",
    display: "Ring finger",
    englishNames: ["ring finger"],
    pluralEnglishNames: ["ring fingers"],
    thaiNames: ["นิ้วนาง", "นิ้วนางมือ"]
  },
  {
    text: "little finger",
    pluralText: "little fingers",
    code: "12406000",
    display: "Little finger",
    englishNames: ["little finger", "pinky", "pinkie"],
    pluralEnglishNames: ["little fingers", "pinkies"],
    thaiNames: ["นิ้วก้อย", "นิ้วก้อยมือ"]
  },
  {
    text: "great toe",
    pluralText: "great toes",
    code: "78883009",
    display: "Great toe",
    englishNames: ["great toe", "big toe"],
    pluralEnglishNames: ["great toes", "big toes"],
    thaiNames: ["นิ้วโป้งเท้า", "นิ้วหัวแม่เท้า", "หัวแม่เท้า"]
  },
  {
    text: "second toe",
    pluralText: "second toes",
    code: "55078004",
    display: "Second toe",
    englishNames: ["second toe", "2nd toe"],
    pluralEnglishNames: ["second toes", "2nd toes"],
    thaiNames: ["นิ้วชี้เท้า"]
  },
  {
    text: "third toe",
    pluralText: "third toes",
    code: "78132007",
    display: "Third toe",
    englishNames: ["third toe", "3rd toe"],
    pluralEnglishNames: ["third toes", "3rd toes"],
    thaiNames: ["นิ้วกลางเท้า"]
  },
  {
    text: "fourth toe",
    pluralText: "fourth toes",
    code: "80349001",
    display: "Fourth toe",
    englishNames: ["fourth toe", "4th toe"],
    pluralEnglishNames: ["fourth toes", "4th toes"],
    thaiNames: ["นิ้วนางเท้า"]
  },
  {
    text: "fifth toe",
    pluralText: "fifth toes",
    code: "39915008",
    display: "Fifth toe",
    englishNames: ["fifth toe", "5th toe", "little toe"],
    pluralEnglishNames: ["fifth toes", "5th toes", "little toes"],
    thaiNames: ["นิ้วก้อยเท้า"]
  }
];

function buildLateralizedDigitBodySiteEntries(): BodySiteSnomedSourceEntry[] {
  const entries: BodySiteSnomedSourceEntry[] = [];
  for (const site of LATERALIZABLE_DIGIT_BODY_SITES) {
    for (const laterality of BODY_SITE_LATERALITIES) {
      const isBilateral = laterality.textPrefix === "both";
      const text = `${laterality.textPrefix} ${isBilateral ? site.pluralText : site.text}`;
      const englishNames = isBilateral ? site.pluralEnglishNames : site.englishNames;
      const names = englishNames.map((name) => `${laterality.englishPrefix} ${name}`);
      for (const name of site.thaiNames) {
        for (const suffix of laterality.thaiSuffixes) {
          names.push(`${name}${suffix}`);
        }
      }
      entries.push({
        names,
        definition: {
          coding: {
            system: SNOMED_SYSTEM,
            code: buildSnomedBodySiteLateralityPostcoordinationCode(
              site.code,
              laterality.code
            ),
            display: text
          },
          text,
          routeHint: site.routeHint ?? RouteCode["Topical route"]
        }
      });
    }
  }
  return entries;
}

export const DEFAULT_BODY_SITE_SNOMED_SOURCE: BodySiteSnomedSourceEntry[] = [
    {
      names: ["eye", "eyes", "ตา"],
      definition: {
        coding: { code: "81745001", display: "Eye" },
        text: "eye",
        i18n: { th: "ตา" },
        routeHint: RouteCode["Ophthalmic route"]
      }
    },
    {
      names: ["left eye", "ตาซ้าย", "ตาข้างซ้าย"],
      definition: {
        coding: { code: "1290031003", display: "Structure of left eye proper" },
        text: "left eye",
        i18n: { th: "ตาซ้าย" },
        routeHint: RouteCode["Ophthalmic route"]
      }
    },
    {
      names: ["right eye", "ตาขวา", "ตาข้างขวา"],
      definition: {
        coding: { code: "1290032005", display: "Structure of right eye proper" },
        text: "right eye",
        i18n: { th: "ตาขวา" },
        routeHint: RouteCode["Ophthalmic route"]
      }
    },
    {
      names: ["both eyes", "bilateral eyes", "each eye", "ตาทั้งสองข้าง", "ตาสองข้าง", "สองตา"],
      definition: {
        coding: { code: "40638003", display: "Structure of both eyes" },
        text: "both eyes",
        administrationTargetCount: 2,
        i18n: { th: "ตาทั้งสองข้าง" },
        routeHint: RouteCode["Ophthalmic route"]
      }
    },
    {
      names: ["ear", "inside ear", "หู"],
      definition: {
        coding: { code: "117590005", display: "Ear-related structure" },
        text: "ear",
        routeHint: RouteCode["Otic route"]
      }
    },
    {
      names: [
        "ears",
        "both ears",
        "bilateral ears",
        "each ear",
        "inside ears",
        "หูทั้งสองข้าง",
        "หูสองข้าง"
      ],
      definition: {
        coding: { code: "34338003", display: "Both ears" },
        text: "both ears",
        administrationTargetCount: 2,
        routeHint: RouteCode["Otic route"]
      }
    },
    {
      names: [
        "ear canal",
        "inside ear canal",
        "external auditory canal",
        "external ear canal"
      ],
      definition: {
        coding: { code: "181178004", display: "Entire external auditory canal" },
        text: "ear canal",
        routeHint: RouteCode["Otic route"]
      }
    },
    {
      names: [
        "ear canals",
        "both ear canals",
        "each ear canal",
        "inside ear canals",
        "both external auditory canals",
        "each external auditory canal"
      ],
      definition: {
        coding: { code: "181178004", display: "Entire external auditory canal" },
        text: "both ear canals",
        administrationTargetCount: 2,
        routeHint: RouteCode["Otic route"]
      }
    },
    {
      names: ["left ear", "หูซ้าย", "หูข้างซ้าย"],
      definition: {
        coding: { code: "89644007", display: "Left ear" },
        text: "left ear",
        routeHint: RouteCode["Otic route"]
      }
    },
    {
      names: ["right ear", "หูขวา", "หูข้างขวา"],
      definition: {
        coding: { code: "25577004", display: "Right ear" },
        text: "right ear",
        routeHint: RouteCode["Otic route"]
      }
    },
    {
      names: ["left ear canal", "left external auditory canal"],
      definition: {
        coding: { code: "368588007", display: "Entire left external auditory canal" },
        text: "left ear canal",
        routeHint: RouteCode["Otic route"]
      }
    },
    {
      names: ["right ear canal", "right external auditory canal"],
      definition: {
        coding: { code: "368566007", display: "Entire right external auditory canal" },
        text: "right ear canal",
        routeHint: RouteCode["Otic route"]
      }
    },
    {
      names: ["nostril"],
      definition: {
        coding: { code: "1797002", display: "Naris" },
        text: "nostril",
        routeHint: RouteCode["Nasal route"]
      }
    },
    {
      names: ["left nostril", "left naris"],
      definition: {
        coding: { code: "723608007", display: "Structure of left anterior naris" },
        routeHint: RouteCode["Nasal route"]
      }
    },
    {
      names: ["right nostril", "right naris"],
      definition: {
        coding: { code: "723609004", display: "Structure of right anterior naris" },
        routeHint: RouteCode["Nasal route"]
      }
    },
    {
      names: [
        "nostrils",
        "both nostrils",
        "bilateral nostrils",
        "each nostril",
        "nares",
        "anterior nares",
        "รูจมูกทั้งสองข้าง",
        "จมูกข้างละ",
        "รูจมูกข้างละ"
      ],
      definition: {
        coding: { code: "244506005", display: "Anterior nares" },
        text: "both nostrils",
        administrationTargetCount: 2,
        i18n: { th: "รูจมูกทั้งสองข้าง" },
        routeHint: RouteCode["Nasal route"]
      }
    },
    {
      names: ["nose", "จมูก"],
      definition: {
        coding: { code: "181195007", display: "Entire nose" },
        i18n: { th: "จมูก" },
        routeHint: RouteCode["Nasal route"]
      }
    },
    {
      names: ["mouth"],
      definition: { coding: { code: "123851003", display: "Mouth region" }, routeHint: RouteCode["Oral route"] }
    },
    {
      names: ["tongue", "tongues"],
      definition: { coding: { code: "21974007", display: "Tongue" }, routeHint: RouteCode["Sublingual route"] }
    },
    {
      names: ["lip", "lips"],
      definition: { coding: { code: "48477009", display: "Lip structure" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["cheek", "cheeks"],
      definition: {
        coding: { code: "60819002", display: "Buccal region of face" },
        routeHint: RouteCode["Buccal route"]
      }
    },
    {
      names: ["gum", "gums"],
      definition: {
        coding: {
          code: "362116001",
          display: "Entire gum and supporting structure of tooth"
        },
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["tooth"],
      definition: { coding: { code: "38199008", display: "Tooth" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["teeth"],
      definition: { coding: { code: "1162715001", display: "All teeth" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["arm", "upper arm", "แขน"],
      definition: {
        coding: { code: "302538001", display: "Entire upper arm" },
        text: "arm",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["left arm", "left upper arm", "แขนซ้าย"],
      definition: {
        coding: { code: "368208006", display: "Left upper arm structure" },
        text: "left arm",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["right arm", "right upper arm", "แขนขวา"],
      definition: {
        coding: { code: "368209003", display: "Right upper arm" },
        text: "right arm",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["both arms", "bilateral arms"],
      definition: { coding: { code: "69273007", display: "Both arms" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["shoulder", "shoulders"],
      definition: { coding: { code: "16982005", display: "Shoulder region structure" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["left shoulder"],
      definition: { coding: { code: "91775009", display: "Left shoulder" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["right shoulder"],
      definition: { coding: { code: "91774008", display: "Right shoulder" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["forearm"],
      definition: { coding: { code: "14975008", display: "Forearm" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["left forearm"],
      definition: { coding: { code: "66480008", display: "Left forearm" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["right forearm"],
      definition: { coding: { code: "64262003", display: "Right forearm" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["elbow"],
      definition: { coding: { code: "127949000", display: "Elbow region structure" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["left elbow"],
      definition: { coding: { code: "368148009", display: "Left elbow" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["right elbow"],
      definition: { coding: { code: "368149001", display: "Right elbow" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["leg", "lower leg", "ขา"],
      definition: {
        coding: { code: "362793004", display: "Entire lower leg, from knee to ankle" },
        text: "leg",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["left leg", "left lower leg", "ขาซ้าย"],
      definition: {
        coding: { code: "213384005", display: "Entire left lower leg" },
        text: "left leg",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["right leg", "right lower leg", "ขาขวา"],
      definition: {
        coding: { code: "213289002", display: "Entire right lower leg" },
        text: "right leg",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["both legs", "bilateral legs"],
      definition: { coding: { code: "40927001", display: "Both legs" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["thigh"],
      definition: { coding: { code: "68367000", display: "Thigh" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["left thigh"],
      definition: { coding: { code: "61396006", display: "Left thigh" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["right thigh"],
      definition: { coding: { code: "11207009", display: "Right thigh" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["knee"],
      definition: { coding: { code: "72696002", display: "Knee region structure" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["left knee"],
      definition: { coding: { code: "82169009", display: "Left knee" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["right knee"],
      definition: { coding: { code: "6757004", display: "Right knee" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["both knees", "bilateral knees"],
      definition: { coding: { code: "36701003", display: "Both knees" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["wrist"],
      definition: { coding: { code: "8205005", display: "Wrist region structure" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["left wrist"],
      definition: { coding: { code: "5951000", display: "Structure of left wrist" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["right wrist"],
      definition: { coding: { code: "9736006", display: "Structure of right wrist" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["ankle"],
      definition: { coding: { code: "344001", display: "Ankle region structure" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["left ankle"],
      definition: { coding: { code: "51636004", display: "Structure of left ankle" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["right ankle"],
      definition: { coding: { code: "6685009", display: "Structure of right ankle" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["both ankles", "bilateral ankles"],
      definition: { coding: { code: "69948000", display: "Both ankles" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["hip"],
      definition: { coding: { code: "29836001", display: "Hip region structure" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["left hip"],
      definition: { coding: { code: "287679003", display: "Left hip" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["right hip"],
      definition: { coding: { code: "287579007", display: "Right hip" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["hand", "hands", "มือ"],
      definition: {
        coding: { code: "85562004", display: "Hand" },
        text: "hand",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["left hand", "มือซ้าย"],
      definition: {
        coding: { code: "85151006", display: "Left hand" },
        text: "left hand",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["right hand", "มือขวา"],
      definition: {
        coding: { code: "78791008", display: "Right hand" },
        text: "right hand",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["finger", "fingers"],
      definition: {
        coding: { code: "7569003", display: "Finger structure" },
        text: "fingers",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["นิ้วมือ"],
      definition: {
        coding: { code: "7569003", display: "Finger structure" },
        text: "fingers",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["between fingers", "ระหว่างนิ้ว", "ระหว่างนิ้วมือ"],
      definition: {
        text: "between fingers",
        spatialRelation: {
          relationText: "between",
          targetText: "fingers",
          targetCoding: {
            system: SNOMED_SYSTEM,
            code: "7569003",
            display: "Finger structure"
          },
          sourceText: "between fingers"
        },
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["thumb", "นิ้วโป้ง", "นิ้วโป้งมือ", "นิ้วหัวแม่มือ", "หัวแม่มือ"],
      definition: {
        coding: { code: "76505004", display: "Thumb" },
        text: "thumb",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["index finger", "นิ้วชี้", "นิ้วชี้มือ"],
      definition: {
        coding: { code: "83738005", display: "Index finger" },
        text: "index finger",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["middle finger", "นิ้วกลาง", "นิ้วกลางมือ"],
      definition: {
        coding: { code: "65531009", display: "Middle finger" },
        text: "middle finger",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["ring finger", "นิ้วนาง", "นิ้วนางมือ"],
      definition: {
        coding: { code: "82002001", display: "Ring finger" },
        text: "ring finger",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["little finger", "pinky", "pinkie", "นิ้วก้อย", "นิ้วก้อยมือ"],
      definition: {
        coding: { code: "12406000", display: "Little finger" },
        text: "little finger",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["toe", "toes"],
      definition: {
        coding: { code: "29707007", display: "Toe structure" },
        text: "toes",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["นิ้วเท้า"],
      definition: {
        coding: { code: "29707007", display: "Toe structure" },
        text: "toes",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["between toes", "ระหว่างนิ้วเท้า"],
      definition: {
        text: "between toes",
        spatialRelation: {
          relationText: "between",
          targetText: "toes",
          targetCoding: {
            system: SNOMED_SYSTEM,
            code: "29707007",
            display: "Toe structure"
          },
          sourceText: "between toes"
        },
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["great toe", "big toe", "นิ้วโป้งเท้า", "นิ้วหัวแม่เท้า", "หัวแม่เท้า"],
      definition: {
        coding: { code: "78883009", display: "Great toe" },
        text: "great toe",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["second toe", "2nd toe", "นิ้วชี้เท้า"],
      definition: {
        coding: { code: "55078004", display: "Second toe" },
        text: "second toe",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["third toe", "3rd toe", "นิ้วกลางเท้า"],
      definition: {
        coding: { code: "78132007", display: "Third toe" },
        text: "third toe",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["fourth toe", "4th toe", "นิ้วนางเท้า"],
      definition: {
        coding: { code: "80349001", display: "Fourth toe" },
        text: "fourth toe",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["fifth toe", "5th toe", "little toe", "นิ้วก้อยเท้า"],
      definition: {
        coding: { code: "39915008", display: "Fifth toe" },
        text: "fifth toe",
        routeHint: RouteCode["Topical route"]
      }
    },
    ...buildLateralizedDigitBodySiteEntries(),
    {
      names: ["back of hand", "dorsum of hand"],
      definition: {
        coding: { code: "731077003", display: "Entire dorsum of hand" },
        text: "back of hand",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["backs of hands", "both backs of hands", "both dorsa of hands"],
      definition: {
        coding: { code: "731077003", display: "Entire dorsum of hand" },
        text: "both backs of hands",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["palm", "palm of hand", "palm of the hand", "ฝ่ามือ"],
      definition: {
        coding: { code: "731973001", display: "Entire palm (region)" },
        text: "palm",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["palms", "both palms"],
      definition: {
        coding: { code: "731973001", display: "Entire palm (region)" },
        text: "both palms",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["foot", "feet", "เท้า"],
      definition: {
        coding: { code: "56459004", display: "Foot" },
        text: "foot",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["left foot", "เท้าซ้าย"],
      definition: {
        coding: { code: "22335008", display: "Left foot" },
        text: "left foot",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["right foot", "เท้าขวา"],
      definition: {
        coding: { code: "7769000", display: "Right foot" },
        text: "right foot",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["abdomen", "abdominal", "belly"],
      definition: {
        coding: { code: "302553009", display: "Entire abdomen" },
        text: "abdomen",
        routeHint: RouteCode["Subcutaneous route"]
      }
    },
    {
      names: ["head", "หัว", "ศีรษะ"],
      definition: {
        coding: { code: "69536005", display: "Head structure" },
        text: "head",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["top of head"],
      definition: { text: "top of head", routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["back of head"],
      definition: {
        coding: { code: "182322006", display: "Entire back of head" },
        text: "back of head",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["sole", "sole of foot", "sole of the foot"],
      definition: {
        coding: { code: "731075006", display: "Entire sole of foot" },
        text: "sole of foot",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["soles", "both soles", "sole of feet", "soles of feet"],
      definition: {
        coding: { code: "731075006", display: "Entire sole of foot" },
        text: "both soles",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["heel"],
      definition: {
        coding: { code: "362804005", display: "Entire heel" },
        text: "heel",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["heels", "both heels"],
      definition: {
        coding: { code: "362804005", display: "Entire heel" },
        text: "both heels",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["left heel"],
      definition: {
        coding: { code: "723606006", display: "Structure of left heel" },
        text: "left heel",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["right heel"],
      definition: {
        coding: { code: "723607002", display: "Structure of right heel" },
        text: "right heel",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["back of foot", "dorsum of foot"],
      definition: {
        coding: { code: "731036002", display: "Entire dorsum of foot" },
        text: "back of foot",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["backs of feet", "both backs of feet", "both dorsa of feet"],
      definition: {
        coding: { code: "731036002", display: "Entire dorsum of foot" },
        text: "both backs of feet",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: [
        "affected area", "affected areas", "affected site",
        "painful area", "painful spot", "painful site", "area that hurts", "area that is painful", "where it hurts",
        "บริเวณที่เป็น", "บริเวณที่มีอาการปวด", "ตรงที่ปวด", "ที่ปวด"
      ],
      definition: { text: "affected area", routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["lesion", "skin lesion", "รอยโรค"],
      definition: {
        coding: { code: "95324001", display: "Skin lesion" },
        text: "lesion",
        routeHint: RouteCode["Topical route"],
        i18n: { th: "รอยโรค" }
      }
    },
    {
      names: ["lesions", "skin lesions"],
      definition: {
        coding: { code: "95324001", display: "Skin lesion" },
        text: "lesions",
        routeHint: RouteCode["Topical route"],
        i18n: { th: "รอยโรค" }
      }
    },
    {
      names: ["left head", "left side of head"],
      definition: { coding: { code: "64237003", display: "Structure of left half of head" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["right head", "right side of head"],
      definition: { coding: { code: "29624005", display: "Structure of right half of head" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["back"],
      definition: { coding: { code: "77568009", display: "Back" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["chest"],
      definition: { coding: { code: "51185008", display: "Thoracic structure" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["chest wall"],
      definition: { coding: { code: "78904004", display: "Chest wall structure" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["breast"],
      definition: { coding: { code: "76752008", display: "Breast structure" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["left breast"],
      definition: { coding: { code: "80248007", display: "Left breast" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["right breast"],
      definition: { coding: { code: "73056007", display: "Right breast" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["both breasts", "bilateral breasts"],
      definition: { coding: { code: "63762007", display: "Both breasts" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["axilla", "axillae", "armpit", "armpits"],
      definition: { coding: { code: "34797008", display: "Axilla structure" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["axillary hair", "armpit hair", "armpit hairs", "underarm hair", "underarm hairs"],
      definition: {
        coding: { code: "75703003", display: "Structure of hair of axilla" },
        text: "axillary hair",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["groin"],
      definition: { coding: { code: "26893007", display: "Inguinal region structure" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["scalp", "หนังศีรษะ", "ที่หนังศีรษะ"],
      definition: {
        coding: { code: "41695006", display: "Scalp" },
        text: "scalp",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["flank"],
      definition: {
        coding: { code: "58602004", display: "Flank" },
        text: "flank",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["left flank"],
      definition: {
        coding: { code: "58602004", display: "Flank" },
        text: "left flank",
        spatialRelation: {
          relationText: "left side",
          relationCoding: {
            system: SNOMED_SYSTEM,
            code: "49370004",
            display: "Lateral"
          },
          targetText: "flank",
          targetCoding: {
            system: SNOMED_SYSTEM,
            code: "58602004",
            display: "Flank"
          },
          sourceText: "left flank"
        },
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["right flank"],
      definition: {
        coding: { code: "58602004", display: "Flank" },
        text: "right flank",
        spatialRelation: {
          relationText: "right side",
          relationCoding: {
            system: SNOMED_SYSTEM,
            code: "49370004",
            display: "Lateral"
          },
          targetText: "flank",
          targetCoding: {
            system: SNOMED_SYSTEM,
            code: "58602004",
            display: "Flank"
          },
          sourceText: "right flank"
        },
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["face"],
      definition: { coding: { code: "89545001", display: "Face" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["eyebrow", "brow"],
      definition: {
        coding: { code: "392262008", display: "Eyebrow structure" },
        text: "eyebrow",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["eyebrows", "brows"],
      definition: {
        coding: { code: "392262008", display: "Eyebrow structure" },
        text: "eyebrows",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["left eyebrow", "left brow"],
      definition: {
        coding: { code: "722011002", display: "Structure of eyebrow of left eye region" },
        text: "left eyebrow",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["right eyebrow", "right brow"],
      definition: {
        coding: { code: "722012009", display: "Structure of eyebrow of right eye region" },
        text: "right eyebrow",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: [
        "both eyebrows",
        "bilateral eyebrows",
        "each eyebrow",
        "left and right eyebrow",
        "left and right eyebrows",
        "right and left eyebrow",
        "right and left eyebrows",
        "left right eyebrow",
        "left right eyebrows"
      ],
      definition: {
        coding: {
          code: buildSnomedBodySiteLateralityPostcoordinationCode(
            "392262008",
            SNOMED_CT_BILATERAL_QUALIFIER_CODE
          ),
          display: "both eyebrows"
        },
        text: "both eyebrows",
        administrationTargetCount: 2,
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["eyebrow hair", "eyebrow hairs", "brow hair", "brow hairs"],
      definition: {
        coding: { code: "392261001", display: "Hair structure of eyebrow" },
        text: "eyebrow hair",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["eyelid", "eyelids"],
      definition: { coding: { code: "80243003", display: "Eyelid" }, routeHint: RouteCode["Ophthalmic route"] }
    },
    {
      names: ["forehead"],
      definition: { coding: { code: "52795006", display: "Forehead" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["temple", "temple region", "temporal region"],
      definition: { coding: { code: "450721000", display: "Temple region structure" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["temples", "both temples", "bilateral temples"],
      definition: {
        coding: { code: "362620003", display: "Entire temporal region" },
        text: "both temples",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["left temple", "left temple region", "left temporal region"],
      definition: { coding: { code: "1373280005", display: "Left temple region" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["right temple", "right temple region", "right temporal region"],
      definition: { coding: { code: "1373281009", display: "Right temple region" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["chin"],
      definition: {
        coding: {
          code: "897081006",
          display: "Skin and/or subcutaneous tissue of chin"
        },
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["neck", "คอ"],
      definition: {
        coding: { code: "45048000", display: "Neck" },
        text: "neck",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["buttock", "buttocks", "gluteal", "glute", "butt", "ass"],
      definition: { coding: { code: "46862004", display: "Buttock" }, routeHint: RouteCode["Intramuscular route"] }
    },
    {
      names: ["left buttock", "left gluteal", "left butt", "left ass"],
      definition: { coding: { code: "723979003", display: "Structure of left buttock" }, routeHint: RouteCode["Intramuscular route"] }
    },
    {
      names: ["right buttock", "right gluteal", "right butt", "right ass"],
      definition: { coding: { code: "723980000", display: "Structure of right buttock" }, routeHint: RouteCode["Intramuscular route"] }
    },
    {
      names: ["muscle", "muscles"],
      definition: {
        coding: {
          code: "362876008",
          display: "All skeletal and smooth muscles of the body"
        },
        routeHint: RouteCode["Intramuscular route"]
      }
    },
    {
      names: ["vein", "veins"],
      definition: { coding: { code: "181367001", display: "Entire vein" }, routeHint: RouteCode["Intravenous route"] }
    },
    {
      names: [
        "external genitalia",
        "external genitals",
        "external genital area",
        "external genital region",
        "genitals",
        "genitalia",
        "genital area",
        "genital region",
        "อวัยวะเพศภายนอก",
        "บริเวณอวัยวะเพศภายนอก",
        "ภายนอกบริเวณอวัยวะเพศ"
      ],
      definition: {
        coding: { code: "362207005", display: "Entire external genitalia" },
        text: "external genitalia",
        i18n: { th: "บริเวณอวัยวะเพศภายนอก" },
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["vulva", "vulval", "vulvar", "vulval area", "vulvar area", "vulval region", "vulvar region"],
      definition: {
        coding: { code: "45292006", display: "Vulval structure" },
        text: "vulva",
        i18n: { th: "อวัยวะเพศหญิงภายนอก" },
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["vagina", "vaginal", "ช่องคลอด", "บริเวณช่องคลอด"],
      definition: { coding: { code: "76784001", display: "Vagina" }, text: "vagina", routeHint: RouteCode["Per vagina"] }
    },
    {
      names: ["penis", "penile"],
      definition: {
        coding: { code: "18911002", display: "Penis structure" },
        text: "penis",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["testis", "testicle", "testicles", "อัณฑะ", "ลูกอัณฑะ"],
      definition: {
        coding: { code: "40689003", display: "Testis" },
        text: "testis",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["left testis", "left testicle", "อัณฑะซ้าย", "ลูกอัณฑะซ้าย"],
      definition: {
        coding: { code: "63239009", display: "Left testis" },
        text: "left testis",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["right testis", "right testicle", "อัณฑะขวา", "ลูกอัณฑะขวา"],
      definition: {
        coding: { code: "15598003", display: "Right testis" },
        text: "right testis",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["rectum", "rectal", "ทวารหนัก"],
      definition: {
        coding: { code: "34402009", display: "Rectum" },
        text: "rectum",
        i18n: { th: "ทวารหนัก" },
        routeHint: RouteCode["Per rectum"]
      }
    },
    {
      names: ["anus"],
      definition: { coding: { code: "181262009", display: "Entire anus" }, routeHint: RouteCode["Per rectum"] }
    },
    {
      names: ["perineum"],
      definition: { coding: { code: "243990009", display: "Entire perineum" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["mustache", "moustache", "mustache hair", "moustache hair"],
      definition: {
        coding: { code: "256925006", display: "Structure of hair of mustache" },
        text: "mustache",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["beard", "beard hair", "facial hair"],
      definition: {
        coding: { code: "367576007", display: "Structure of beard hair" },
        text: "beard",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["pubic hair"],
      definition: {
        coding: { code: "75776007", display: "Structure of hair of pubis" },
        text: "pubic hair",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["skin", "ผิวหนัง", "ผิว"],
      definition: {
        coding: { code: "181469002", display: "Entire skin" },
        i18n: { th: "ผิวหนัง" },
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["hair"],
      definition: {
        coding: { code: "386045008", display: "Hair structure (body structure)" },
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["joint"],
      definition: {
        coding: { code: "39352004", display: "Joint structure" },
        text: "joint",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["joints"],
      definition: {
        coding: { code: "81087007", display: "Joints" },
        text: "joints",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["finger joint", "finger joints"],
      definition: {
        coding: { code: "125682004", display: "Finger joint structure" },
        text: "finger joints",
        routeHint: RouteCode["Topical route"]
      }
    },
    {
      names: ["knuckle", "knuckles"],
      definition: {
        coding: { code: "70420003", display: "Metacarpophalangeal joint structure" },
        text: "knuckles",
        routeHint: RouteCode["Topical route"]
      }
    }
  ];

export const DEFAULT_BODY_SITE_SNOMED = objectFromEntries(
  DEFAULT_BODY_SITE_SNOMED_SOURCE.reduce<Array<[
    string,
    BodySiteDefinition
  ]>>((entries, source) => {
    const { names, definition } = source;
    for (const name of names) {
      const key = normalizeBodySiteKey(name);
      if (!key) {
        continue;
      }
      entries.push([key, definition]);
    }
    return entries;
  }, [])
) as Record<string, BodySiteDefinition>;

export const DEFAULT_BODY_SITE_HINTS = (() => {
  const hints = new Set<string>();
  const addPhrase = (phrase: string | undefined) => {
    const normalized = normalizeBodySiteKey(phrase ?? "");
    if (!normalized) {
      return;
    }
    for (const part of normalized.split(" ")) {
      if (part) {
        hints.add(part);
      }
    }
  };

  for (const [key, definition] of objectEntries(DEFAULT_BODY_SITE_SNOMED)) {
    addPhrase(key);
    if (definition.aliases) {
      for (const alias of definition.aliases) {
        addPhrase(alias);
      }
    }
  }

  return hints;
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
  u: "U",
  unit: "U",
  units: "U",
  iu: "IU",
  "i.u": "IU",
  "i.u.": "IU",
  ius: "IU",
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
  pump: "pump",
  pumps: "pump",
  squeeze: "squeeze",
  squeezes: "squeeze",
  applicatorful: "applicatorful",
  applicatorfuls: "applicatorful",
  capful: "capful",
  capfuls: "capful",
  scoop: "scoop",
  scoops: "scoop",
  tube: "tube",
  tubes: "tube",
  bottle: "bottle",
  bottles: "bottle",
  container: "container",
  containers: "container",
  jar: "jar",
  jars: "jar",
  packet: "packet",
  packets: "packet",
  sachet: "sachet",
  sachets: "sachet",
  application: "application",
  applications: "application",
  ribbon: "ribbon",
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

export interface ProductFormHint {
  routeHint?: RouteCode;
}

export const PRODUCT_FORM_HINTS: Record<string, ProductFormHint> = {
  patch: { routeHint: RouteCode["Transdermal route"] },
  cream: { routeHint: RouteCode["Topical route"] },
  ointment: { routeHint: RouteCode["Topical route"] },
  gel: { routeHint: RouteCode["Topical route"] },
  lotion: { routeHint: RouteCode["Topical route"] },
  serum: { routeHint: RouteCode["Topical route"] },
  toner: { routeHint: RouteCode["Topical route"] },
  moisturizer: { routeHint: RouteCode["Topical route"] },
  shampoo: { routeHint: RouteCode["Topical route"] },
  sunscreen: { routeHint: RouteCode["Topical route"] },
  deodorant: { routeHint: RouteCode["Topical route"] },
  cleanser: { routeHint: RouteCode["Topical route"] },
  "face wash": { routeHint: RouteCode["Topical route"] },
  "body wash": { routeHint: RouteCode["Topical route"] },
  "body lotion": { routeHint: RouteCode["Topical route"] },
  "lip balm": { routeHint: RouteCode["Topical route"] },
  "spot treatment": { routeHint: RouteCode["Topical route"] },
  "makeup remover": { routeHint: RouteCode["Topical route"] },
  balm: { routeHint: RouteCode["Topical route"] },
  foam: { routeHint: RouteCode["Topical route"] }
};

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
  qhs: {
    code: "QHS",
    frequency: 1,
    period: 1,
    periodUnit: FhirPeriodUnit.Day,
    when: [EventTiming["Before Sleep"]]
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
  pm: { code: "PM", when: [EventTiming.Evening] },
  qam: { code: "QAM", when: [EventTiming.Morning] },
  qpm: { code: "QPM", when: [EventTiming.Evening] },
  bld: {
    code: "BLD",
    when: [EventTiming.Meal],
    discouraged: "BLD"
  },
  "b-l-d": {
    code: "BLD",
    when: [EventTiming.Meal],
    discouraged: "BLD"
  }
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
  c: EventTiming.Meal,
  "with meals": EventTiming.Meal,
  "with meal": EventTiming.Meal,
  "with food": EventTiming.Meal,
  cc: EventTiming.Meal,
  "@m": EventTiming.Meal,
  "@meal": EventTiming.Meal,
  "@meals": EventTiming.Meal,
  cm: EventTiming.Breakfast,
  breakfast: EventTiming.Breakfast,
  bfast: EventTiming.Breakfast,
  brkfst: EventTiming.Breakfast,
  meal: EventTiming.Meal,
  meals: EventTiming.Meal,
  food: EventTiming.Meal,
  brk: EventTiming.Breakfast,
  cd: EventTiming.Lunch,
  lunch: EventTiming.Lunch,
  lunchtime: EventTiming.Lunch,
  cv: EventTiming.Dinner,
  dinner: EventTiming.Dinner,
  dinnertime: EventTiming.Dinner,
  supper: EventTiming.Dinner,
  suppertime: EventTiming.Dinner,
  am: EventTiming.Morning,
  morning: EventTiming.Morning,
  morn: EventTiming.Morning,
  noon: EventTiming.Noon,
  midday: EventTiming.Noon,
  "mid-day": EventTiming.Noon,
  afternoon: EventTiming.Afternoon,
  aft: EventTiming.Afternoon,
  pm: EventTiming.Evening,
  qam: EventTiming.Morning,
  qpm: EventTiming.Evening,
  evening: EventTiming.Evening,
  night: EventTiming.Night,
  nightly: EventTiming.Night,
  hs: EventTiming["Before Sleep"],
  bedtime: EventTiming["Before Sleep"],
  bed: EventTiming["Before Sleep"],
  sleep: EventTiming["Before Sleep"],
  wake: EventTiming.Wake,
  waking: EventTiming.Wake,
  stat: EventTiming.Immediate,
  immediate: EventTiming.Immediate
};

const MEAL_KEYWORD_ENTRIES: Array<
  [string, { pc: EventTiming; ac: EventTiming }]
> = [];

function registerMealKeywords(
  keys: readonly string[],
  meal: { pc: EventTiming; ac: EventTiming }
) {
  for (const key of keys) {
    MEAL_KEYWORD_ENTRIES.push([key, meal]);
  }
}

registerMealKeywords(
  ["breakfast", "bfast", "brkfst", "brk"],
  {
    pc: EventTiming["After Breakfast"],
    ac: EventTiming["Before Breakfast"]
  }
);

registerMealKeywords(["lunch", "lunchtime"], {
  pc: EventTiming["After Lunch"],
  ac: EventTiming["Before Lunch"]
});

registerMealKeywords(["dinner", "dinnertime", "supper", "suppertime"], {
  pc: EventTiming["After Dinner"],
  ac: EventTiming["Before Dinner"]
});

registerMealKeywords(["meal", "meals", "food"], {
  pc: EventTiming["After Meal"],
  ac: EventTiming["Before Meal"]
});

export const MEAL_KEYWORDS = objectFromEntries(
  MEAL_KEYWORD_ENTRIES
) as Record<string, { pc: EventTiming; ac: EventTiming }>;

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
  mond: FhirDayOfWeek.Monday,
  tuesday: FhirDayOfWeek.Tuesday,
  tue: FhirDayOfWeek.Tuesday,
  tues: FhirDayOfWeek.Tuesday,
  wednesday: FhirDayOfWeek.Wednesday,
  wed: FhirDayOfWeek.Wednesday,
  weds: FhirDayOfWeek.Wednesday,
  thursday: FhirDayOfWeek.Thursday,
  thu: FhirDayOfWeek.Thursday,
  thur: FhirDayOfWeek.Thursday,
  thurs: FhirDayOfWeek.Thursday,
  friday: FhirDayOfWeek.Friday,
  fri: FhirDayOfWeek.Friday,
  saturday: FhirDayOfWeek.Saturday,
  sat: FhirDayOfWeek.Saturday,
  sunday: FhirDayOfWeek.Sunday,
  sun: FhirDayOfWeek.Sunday,
  จ: FhirDayOfWeek.Monday,
  จัน: FhirDayOfWeek.Monday,
  จันทร์: FhirDayOfWeek.Monday,
  อ: FhirDayOfWeek.Tuesday,
  อัง: FhirDayOfWeek.Tuesday,
  อังคาร: FhirDayOfWeek.Tuesday,
  พ: FhirDayOfWeek.Wednesday,
  พุธ: FhirDayOfWeek.Wednesday,
  พฤ: FhirDayOfWeek.Thursday,
  พฤหัส: FhirDayOfWeek.Thursday,
  พฤหัสบดี: FhirDayOfWeek.Thursday,
  ศ: FhirDayOfWeek.Friday,
  ศุก: FhirDayOfWeek.Friday,
  ศุกร์: FhirDayOfWeek.Friday,
  ส: FhirDayOfWeek.Saturday,
  เสา: FhirDayOfWeek.Saturday,
  เสาร์: FhirDayOfWeek.Saturday,
  อา: FhirDayOfWeek.Sunday,
  อาท: FhirDayOfWeek.Sunday,
  อาทิตย์: FhirDayOfWeek.Sunday
};

export const WORD_FREQUENCIES: Record<string, { frequency: number; periodUnit: FhirPeriodUnit }> = {
  daily: { frequency: 1, periodUnit: FhirPeriodUnit.Day },
  "once daily": { frequency: 1, periodUnit: FhirPeriodUnit.Day },
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
  ensure(RouteCode["Per rectum"], "suppository");

  return resolved;
})();

export function normalizePrnReasonKey(value: string): string {
  return normalizeSymptomKey(value);
}

export function normalizeAdditionalInstructionKey(value: string): string {
  return normalizeLoosePhraseKey(value);
}

export type PrnReasonDictionaryEntry = SymptomDictionaryEntry;

export const DEFAULT_PRN_REASON_ENTRIES: PrnReasonDictionaryEntry[] = DEFAULT_SYMPTOM_ENTRIES;

export const DEFAULT_PRN_REASON_DEFINITIONS =
  DEFAULT_SYMPTOM_DEFINITIONS as Record<string, PrnReasonDefinition>;

export function findPrnReasonDefinitionByCoding(
  system: string,
  code: string
): PrnReasonDefinition | undefined {
  return findSymptomDefinitionByCoding(system, code) as PrnReasonDefinition | undefined;
}
