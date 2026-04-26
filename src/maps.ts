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
        routeHint: RouteCode["Ophthalmic route"]
      }
    },
    {
      names: ["left eye", "ตาซ้าย"],
      definition: {
        coding: { code: "1290031003", display: "Structure of left eye proper" },
        text: "left eye",
        routeHint: RouteCode["Ophthalmic route"]
      }
    },
    {
      names: ["right eye", "ตาขวา"],
      definition: {
        coding: { code: "1290032005", display: "Structure of right eye proper" },
        text: "right eye",
        routeHint: RouteCode["Ophthalmic route"]
      }
    },
    {
      names: ["both eyes", "bilateral eyes", "ตาทั้งสองข้าง", "ตาสองข้าง"],
      definition: {
        coding: { code: "40638003", display: "Structure of both eyes" },
        text: "both eyes",
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
      names: ["ears", "both ears", "bilateral ears", "inside ears", "หูทั้งสองข้าง", "หูสองข้าง"],
      definition: {
        coding: { code: "34338003", display: "Both ears" },
        text: "both ears",
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
      names: ["ear canals", "both ear canals", "inside ear canals", "both external auditory canals"],
      definition: {
        coding: { code: "181178004", display: "Entire external auditory canal" },
        text: "both ear canals",
        routeHint: RouteCode["Otic route"]
      }
    },
    {
      names: ["left ear", "หูซ้าย"],
      definition: {
        coding: { code: "89644007", display: "Left ear" },
        text: "left ear",
        routeHint: RouteCode["Otic route"]
      }
    },
    {
      names: ["right ear", "หูขวา"],
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
      names: ["nostril", "nostrils"],
      definition: { coding: { code: "1797002", display: "Naris" }, routeHint: RouteCode["Nasal route"] }
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
      names: ["nares", "anterior nares"],
      definition: { coding: { code: "244506005", display: "Anterior nares" }, routeHint: RouteCode["Nasal route"] }
    },
    {
      names: ["nose"],
      definition: { coding: { code: "181195007", display: "Entire nose" }, routeHint: RouteCode["Nasal route"] }
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
      names: ["palm", "palm of hand", "palm of the hand"],
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
      names: ["affected area", "affected areas", "affected site", "บริเวณที่เป็น"],
      definition: { text: "affected area", routeHint: RouteCode["Topical route"] }
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
      names: ["vagina", "vaginal"],
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
      names: ["rectum", "rectal"],
      definition: { coding: { code: "34402009", display: "Rectum" }, text: "rectum", routeHint: RouteCode["Per rectum"] }
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
      names: ["skin"],
      definition: { coding: { code: "181469002", display: "Entire skin" }, routeHint: RouteCode["Topical route"] }
    },
    {
      names: ["hair"],
      definition: {
        coding: { code: "386045008", display: "Hair structure (body structure)" },
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
  stat: EventTiming.Immediate
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
  return normalizeLoosePhraseKey(value);
}

export function normalizeAdditionalInstructionKey(value: string): string {
  return normalizeLoosePhraseKey(value);
}

const DEFAULT_PRN_REASON_SOURCE: Array<{
  names: string[];
  definition: PrnReasonDefinition;
}> = [
  {
    names: ["pain", "ache", "aches", "pains"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "22253000", display: "Pain" },
      text: "Pain",
      aliases: ["เจ็บ", "ปวด"],
      i18n: { th: "ปวด" }
    }
  },
  {
    names: ["headache", "head pain"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "25064002", display: "Headache" },
      text: "Headache",
      aliases: ["ปวดหัว", "ปวดศีรษะ"],
      i18n: { th: "ปวดศีรษะ" }
    }
  },
  {
    names: ["migraine", "migraine headache"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "37796009", display: "Migraine" },
      text: "Migraine",
      aliases: ["ไมเกรน", "ปวดหัวไมเกรน"],
      i18n: { th: "ไมเกรน" }
    }
  },
  {
    names: ["back pain", "backache", "pain in back"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "161891005", display: "Backache" },
      text: "Back pain",
      aliases: ["ปวดหลัง"],
      i18n: { th: "ปวดหลัง" }
    }
  },
  {
    names: ["low back pain", "lower back pain", "lumbar pain"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "279039007", display: "Low back pain" },
      text: "Low back pain",
      aliases: ["ปวดหลังส่วนล่าง", "ปวดเอว"],
      i18n: { th: "ปวดหลังส่วนล่าง" }
    }
  },
  {
    names: ["joint pain", "arthralgia", "painful joint"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "57676002", display: "Pain of joint" },
      text: "Joint pain",
      aliases: ["ปวดข้อ"],
      i18n: { th: "ปวดข้อ" }
    }
  },
  {
    names: ["muscle pain", "myalgia"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "68962001", display: "Muscle pain" },
      text: "Muscle pain",
      aliases: ["ปวดกล้ามเนื้อ", "เมื่อยกล้ามเนื้อ"],
      i18n: { th: "ปวดกล้ามเนื้อ" }
    }
  },
  {
    names: ["ear pain", "earache", "otalgia"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "301354004", display: "Pain of ear" },
      text: "Ear pain",
      aliases: ["ปวดหู"],
      i18n: { th: "ปวดหู" }
    }
  },
  {
    names: ["sore throat", "throat pain"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "267102003", display: "Sore throat" },
      text: "Sore throat",
      aliases: ["เจ็บคอ", "คอเจ็บ"],
      i18n: { th: "เจ็บคอ" }
    }
  },
  {
    names: ["chest pain"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "29857009", display: "Chest pain" },
      text: "Chest pain",
      aliases: ["เจ็บหน้าอก"],
      i18n: { th: "เจ็บหน้าอก" }
    }
  },
  {
    names: ["pelvic pain", "pelvic and perineal pain"],
    definition: {
      coding: {
        system: SNOMED_SYSTEM,
        code: "274671002",
        display: "Pelvic and perineal pain"
      },
      text: "Pelvic pain",
      aliases: ["ปวดเชิงกราน", "ปวดท้องน้อย"],
      i18n: { th: "ปวดเชิงกราน" }
    }
  },
  {
    names: ["dysmenorrhea", "menstrual cramps", "period cramps", "period pain"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "266599000", display: "Dysmenorrhea" },
      text: "Menstrual cramps",
      aliases: ["ปวดประจำเดือน", "ปวดเมนส์"],
      i18n: { th: "ปวดประจำเดือน" }
    }
  },
  {
    names: ["cramp", "cramps", "cramping"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "55300003", display: "Cramp" },
      text: "Cramp",
      aliases: ["ตะคริว"],
      i18n: { th: "ตะคริว" }
    }
  },
  {
    names: ["spasm", "spasms", "muscle spasm"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "45352006", display: "Spasm" },
      text: "Spasm",
      aliases: ["เกร็ง", "กล้ามเนื้อเกร็ง"],
      i18n: { th: "ตะคริวหรือเกร็ง" }
    }
  },
  {
    names: ["nausea", "queasiness", "queasy"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "422587007", display: "Nausea" },
      text: "Nausea",
      aliases: ["คลื่นไส้"],
      i18n: { th: "คลื่นไส้" }
    }
  },
  {
    names: ["vomiting", "emesis", "throw up", "throwing up"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "422400008", display: "Vomiting" },
      text: "Vomiting",
      aliases: ["อาเจียน"],
      i18n: { th: "อาเจียน" }
    }
  },
  {
    names: ["n/v", "nausea and vomiting", "vomiting and nausea"],
    definition: {
      coding: {
        system: SNOMED_SYSTEM,
        code: "16932000",
        display: "Nausea and vomiting"
      },
      text: "Nausea and vomiting",
      aliases: ["คลื่นไส้อาเจียน", "คลื่นไส้และอาเจียน"],
      i18n: { th: "คลื่นไส้และอาเจียน" }
    }
  },
  {
    names: ["diarrhea", "diarrhoea", "loose stool", "loose stools"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "62315008", display: "Diarrhea" },
      text: "Diarrhea",
      aliases: ["ท้องเสีย", "ถ่ายเหลว"],
      i18n: { th: "ท้องเสีย" }
    }
  },
  {
    names: ["constipation"],
    definition: {
      coding: {
        system: SNOMED_SYSTEM,
        code: "14760008",
        display: "Constipation"
      },
      text: "Constipation",
      aliases: ["ท้องผูก", "ถ่ายไม่ออก"],
      i18n: { th: "ท้องผูก" }
    }
  },
  {
    names: ["heartburn"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "16331000", display: "Heartburn" },
      text: "Heartburn",
      aliases: ["แสบร้อนกลางอก"],
      i18n: { th: "แสบร้อนกลางอก" }
    }
  },
  {
    names: [
      "abdominal pain",
      "abdomen pain",
      "abdomen ache",
      "pain in abdomen",
      "stomach pain",
      "stomachache"
    ],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "21522001", display: "Abdominal pain" },
      text: "Abdominal pain",
      aliases: ["ปวดท้อง"],
      i18n: { th: "ปวดท้อง" }
    }
  },
  {
    names: ["abdominal bloating", "bloating", "bloated"],
    definition: {
      coding: {
        system: SNOMED_SYSTEM,
        code: "116289008",
        display: "Abdominal bloating"
      },
      text: "Bloating",
      aliases: ["ท้องอืด"],
      i18n: { th: "ท้องอืด" }
    }
  },
  {
    names: ["flatulence", "gas", "gassy"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "249504006", display: "Flatulence" },
      text: "Gas",
      aliases: ["มีแก๊สในท้อง", "ลมในท้อง"],
      i18n: { th: "มีแก๊สในท้อง" }
    }
  },
  {
    names: ["eye itch", "itchy eye", "itchy eyes", "eye itching", "itching eye", "itching eyes", "itching of eye", "itching of eyes"],
    definition: {
      coding: {
        system: SNOMED_SYSTEM,
        code: "74776002",
        display: "Itching of eye"
      },
      text: "Eye itching",
      aliases: ["คันตา", "ตาคัน"],
      i18n: { th: "คันตา" }
    }
  },
  {
    names: ["lesion itch", "itchy lesion", "itching lesion", "lesion itching", "itching of lesion", "itching of skin lesion", "skin lesion itch"],
    definition: {
      coding: {
        system: SNOMED_SYSTEM,
        code: "445329008",
        display: "Itching of lesion of skin"
      },
      text: "Lesion itching",
      aliases: ["คันรอยโรค", "คันที่รอยโรค"],
      i18n: { th: "คันที่รอยโรค" }
    }
  },
  {
    names: [
      "itch",
      "itching",
      "itchiness",
      "itchy",
      "wound itch",
      "wound itchiness",
      "itchy wound",
      "wound itching",
      "itching wound",
      "itching of wound",
      "itchiness of wound"
    ],
    definition: {
      coding: {
        system: SNOMED_SYSTEM,
        code: "418363000",
        display: "Itching of skin"
      },
      text: "Itching",
      aliases: ["คัน", "คันแผล", "แผลคัน"],
      i18n: { th: "คัน" }
    }
  },
  {
    names: ["cough", "coughing"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "49727002", display: "Cough" },
      text: "Cough",
      aliases: ["ไอ"],
      i18n: { th: "ไอ" }
    }
  },
  {
    names: ["fever", "temperature", "pyrexia"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "386661006", display: "Fever" },
      text: "Fever",
      aliases: ["ไข้", "มีไข้", "เป็นไข้", "ตัวร้อน"],
      i18n: { th: "ไข้" }
    }
  },
  {
    names: ["nasal congestion", "congestion", "stuffy nose", "blocked nose"],
    definition: {
      coding: {
        system: SNOMED_SYSTEM,
        code: "68235000",
        display: "Nasal congestion"
      },
      text: "Nasal congestion",
      aliases: ["คัดจมูก"],
      i18n: { th: "คัดจมูก" }
    }
  },
  {
    names: ["nasal discharge", "rhinorrhea", "rhinorrhoea", "runny nose", "discharge from nose"],
    definition: {
      coding: {
        system: SNOMED_SYSTEM,
        code: "64531003",
        display: "Nasal discharge"
      },
      text: "Runny nose",
      aliases: ["น้ำมูกไหล"],
      i18n: { th: "น้ำมูกไหล" }
    }
  },
  {
    names: ["dyspnea", "dyspnoea", "shortness of breath", "sob", "breathlessness", "breathless"],
    definition: {
      coding: {
        system: SNOMED_SYSTEM,
        code: "267036007",
        display: "Dyspnea"
      },
      text: "Shortness of breath",
      aliases: ["เหนื่อย", "หายใจลำบาก", "หอบ"],
      i18n: { th: "เหนื่อยหรือหายใจลำบาก" }
    }
  },
  {
    names: ["wheezing", "wheeze", "wheezy"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "56018004", display: "Wheezing" },
      text: "Wheeze",
      aliases: ["หายใจมีเสียงหวีด"],
      i18n: { th: "หายใจมีเสียงหวีด" }
    }
  },
  {
    names: ["sneezing", "sneeze", "sneezes"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "76067001", display: "Sneezing" },
      text: "Sneezing",
      aliases: ["จาม"],
      i18n: { th: "จาม" }
    }
  },
  {
    names: ["allergic rhinitis", "allergy symptoms", "hay fever", "hayfever"],
    definition: {
      coding: {
        system: SNOMED_SYSTEM,
        code: "61582004",
        display: "Allergic rhinitis"
      },
      text: "Allergic rhinitis",
      aliases: ["ภูมิแพ้จมูก", "ภูมิแพ้"],
      i18n: { th: "ภูมิแพ้จมูก" }
    }
  },
  {
    names: [
      "acne",
      "acne vulgaris",
      "pimple",
      "pimples",
      "breakout",
      "breakouts",
      "acne breakout",
      "acne breakouts"
    ],
    definition: {
      coding: {
        system: SNOMED_SYSTEM,
        code: "88616000",
        display: "Acne vulgaris"
      },
      text: "Acne",
      aliases: ["สิว"],
      i18n: { th: "สิว" }
    }
  },
  {
    names: ["eczema", "eczema flare", "eczematous rash"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "43116000", display: "Eczema" },
      text: "Eczema",
      aliases: ["เอ็กซีมา", "ผื่นแพ้"],
      i18n: { th: "ผื่นแพ้" }
    }
  },
  {
    names: ["atopic dermatitis", "atopic eczema"],
    definition: {
      coding: {
        system: SNOMED_SYSTEM,
        code: "24079001",
        display: "Atopic dermatitis"
      },
      text: "Atopic dermatitis",
      aliases: ["ผื่นภูมิแพ้", "ภูมิแพ้ผิวหนัง", "แพ้ผิว", "ผิวแพ้"],
      i18n: { th: "ผื่นภูมิแพ้" }
    }
  },
  {
    names: ["psoriasis", "psoriatic rash"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "9014002", display: "Psoriasis" },
      text: "Psoriasis",
      aliases: ["สะเก็ดเงิน"],
      i18n: { th: "สะเก็ดเงิน" }
    }
  },
  {
    names: ["hives", "urticaria"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "126485001", display: "Urticaria" },
      text: "Hives",
      aliases: ["ลมพิษ", "ลมพิด"],
      i18n: { th: "ลมพิษ" }
    }
  },
  {
    names: ["rash", "skin rash", "skin eruption", "eruption of skin"],
    definition: {
      coding: {
        system: SNOMED_SYSTEM,
        code: "271807003",
        display: "Eruption of skin"
      },
      text: "Rash",
      aliases: ["ผื่น"],
      i18n: { th: "ผื่น" }
    }
  },
  {
    names: ["burning sensation", "burning", "burning pain"],
    definition: {
      coding: {
        system: SNOMED_SYSTEM,
        code: "90673000",
        display: "Burning sensation"
      },
      text: "Burning sensation",
      aliases: ["แสบร้อน", "แสบ"],
      i18n: { th: "แสบร้อน" }
    }
  },
  {
    names: ["irritation", "irritated"],
    definition: {
      coding: {
        system: SNOMED_SYSTEM,
        code: "257553007",
        display: "Irritation"
      },
      text: "Irritation",
      aliases: ["ระคายเคือง"],
      i18n: { th: "ระคายเคือง" }
    }
  },
  {
    names: ["dry eye", "dry eyes"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "162290004", display: "Dry eyes" },
      text: "Dry eyes",
      aliases: ["ตาแห้ง"],
      i18n: { th: "ตาแห้ง" }
    }
  },
  {
    names: ["red eye", "red eyes"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "703630003", display: "Red eye" },
      text: "Red eye",
      aliases: ["ตาแดง"],
      i18n: { th: "ตาแดง" }
    }
  },
  {
    names: ["eye pain", "pain in eye", "ocular pain"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "41652007", display: "Pain in eye" },
      text: "Eye pain",
      aliases: ["ปวดตา", "เจ็บตา"],
      i18n: { th: "ปวดตา" }
    }
  },
  {
    names: [
      "cold sore",
      "cold sores",
      "herpes labialis",
      "fever blister",
      "fever blisters"
    ],
    definition: {
      coding: {
        system: SNOMED_SYSTEM,
        code: "1475003",
        display: "Herpes labialis"
      },
      text: "Cold sores",
      aliases: ["เริมที่ปาก", "แผลเริมที่ปาก"],
      i18n: { th: "เริมที่ปาก" }
    }
  },
  {
    names: [
      "mouth ulcer",
      "mouth ulcers",
      "oral ulcer",
      "oral ulcers",
      "mouth sore",
      "mouth sores",
      "canker sore",
      "canker sores",
      "aphthous ulcer",
      "aphthous ulcers"
    ],
    definition: {
      coding: {
        system: SNOMED_SYSTEM,
        code: "26284000",
        display: "Ulcer of mouth"
      },
      text: "Mouth ulcer",
      aliases: ["แผลในปาก", "ร้อนใน"],
      i18n: { th: "แผลในปาก" }
    }
  },
  {
    names: ["dry skin", "xeroderma"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "52475004", display: "Xeroderma" },
      text: "Dry skin",
      aliases: ["ผิวแห้ง"],
      i18n: { th: "ผิวแห้ง" }
    }
  },
  {
    names: ["dandruff", "scalp dandruff"],
    definition: {
      coding: {
        system: SNOMED_SYSTEM,
        code: "400201008",
        display: "Pityriasis capitis"
      },
      text: "Dandruff",
      aliases: ["รังแค"],
      i18n: { th: "รังแค" }
    }
  },
  {
    names: ["scalp itch", "scalp itchiness", "scalp itching", "itchiness of scalp", "itching of scalp", "itchy scalp"],
    definition: {
      coding: {
        system: SNOMED_SYSTEM,
        code: "275921007",
        display: "Scalp itchy"
      },
      text: "Scalp itching",
      aliases: ["คันหนังศีรษะ"],
      i18n: { th: "คันหนังศีรษะ" }
    }
  },
  {
    names: ["dysuria", "burning urination", "burning when urinating"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "49650001", display: "Dysuria" },
      text: "Dysuria",
      aliases: ["แสบขัด", "ปัสสาวะแสบขัด", "แสบเวลาปัสสาวะ"],
      i18n: { th: "แสบขัดเวลาปัสสาวะ" }
    }
  },
  {
    names: ["frequency of urination", "urinary frequency", "frequent urination"],
    definition: {
      coding: {
        system: SNOMED_SYSTEM,
        code: "364198000",
        display: "Frequency of urination"
      },
      text: "Urinary frequency",
      aliases: ["ปัสสาวะบ่อย"],
      i18n: { th: "ปัสสาวะบ่อย" }
    }
  },
  {
    names: ["urgent desire to urinate", "urinary urgency", "urgency to urinate", "urgency to pass urine", "urgency of micturition"],
    definition: {
      coding: {
        system: SNOMED_SYSTEM,
        code: "75088002",
        display: "Urgent desire to urinate"
      },
      text: "Urinary urgency",
      aliases: ["ปวดปัสสาวะรีบ", "ปวดปัสสาวะกะทันหัน"],
      i18n: { th: "ปวดปัสสาวะรีบ" }
    }
  },
  {
    names: ["hemorrhoids", "haemorrhoids", "hemorrhoid", "haemorrhoid", "piles"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "70153002", display: "Hemorrhoids" },
      text: "Hemorrhoids",
      aliases: ["ริดสีดวง", "ริดสีดวงทวาร"],
      i18n: { th: "ริดสีดวง" }
    }
  },
  {
    names: ["vaginal discharge", "discharge from vagina"],
    definition: {
      coding: {
        system: SNOMED_SYSTEM,
        code: "271939006",
        display: "Vaginal discharge"
      },
      text: "Vaginal discharge",
      aliases: ["ตกขาว"],
      i18n: { th: "ตกขาว" }
    }
  },
  {
    names: ["vaginal irritation", "irritation of vagina"],
    definition: {
      coding: {
        system: SNOMED_SYSTEM,
        code: "161816004",
        display: "Vaginal irritation"
      },
      text: "Vaginal irritation",
      aliases: ["ระคายเคืองช่องคลอด"],
      i18n: { th: "ระคายเคืองช่องคลอด" }
    }
  },
  {
    names: ["pruritus of vagina", "itching of vagina", "vaginal itching", "vaginal itch"],
    definition: {
      coding: {
        system: SNOMED_SYSTEM,
        code: "34363003",
        display: "Pruritus of vagina"
      },
      text: "Vaginal itching",
      aliases: ["คันช่องคลอด"],
      i18n: { th: "คันช่องคลอด" }
    }
  },
  {
    names: ["vaginal dryness", "dry vagina"],
    definition: {
      coding: {
        system: SNOMED_SYSTEM,
        code: "31908003",
        display: "Vaginal dryness"
      },
      text: "Vaginal dryness",
      aliases: ["ช่องคลอดแห้ง"],
      i18n: { th: "ช่องคลอดแห้ง" }
    }
  },
  {
    names: ["anxiety", "nervousness", "feeling anxious"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "48694002", display: "Anxiety" },
      text: "Anxiety",
      aliases: ["วิตกกังวล", "กังวล"],
      i18n: { th: "วิตกกังวล" }
    }
  },
  {
    names: ["panic attack", "panic", "panic episode"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "225624000", display: "Panic attack" },
      text: "Panic attack",
      aliases: ["อาการแพนิค", "แพนิค", "ตื่นตระหนก"],
      i18n: { th: "อาการแพนิค" }
    }
  },
  {
    names: ["agitation", "agitated", "feeling agitated", "unable to keep still"],
    definition: {
      coding: {
        system: SNOMED_SYSTEM,
        code: "24199005",
        display: "Feeling agitated"
      },
      text: "Agitation",
      aliases: ["กระสับกระส่าย", "อยู่ไม่นิ่ง"],
      i18n: { th: "กระสับกระส่าย" }
    }
  },
  {
    names: ["sleep", "sleeping", "insomnia", "sleep issues", "unable to sleep"],
    definition: {
      coding: {
        system: SNOMED_SYSTEM,
        code: "193462001",
        display: "Insomnia"
      },
      text: "Sleep",
      aliases: ["นอนหลับ", "นอนไม่หลับ"],
      i18n: { th: "นอนหลับ" }
    }
  },
  {
    names: ["sleepiness", "sleepy", "drowsiness", "drowsy", "somnolence"],
    definition: {
      coding: {
        system: SNOMED_SYSTEM,
        code: "79519003",
        display: "Drowsiness"
      },
      text: "Sleepiness",
      aliases: ["ง่วงนอน", "ง่วง"],
      i18n: { th: "ง่วงนอน" }
    }
  },
  {
    names: ["dizziness", "giddiness"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "404640003", display: "Dizziness" },
      text: "Dizziness",
      aliases: ["เวียนหัว", "เวียนศีรษะ"],
      i18n: { th: "เวียนศีรษะ" }
    }
  },
  {
    names: ["vertigo"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "399153001", display: "Vertigo" },
      text: "Vertigo",
      aliases: ["บ้านหมุน"],
      i18n: { th: "บ้านหมุน" }
    }
  },
  {
    names: ["hallucinations", "hallucination"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "7011001", display: "Hallucinations" },
      text: "Hallucinations",
      aliases: ["ประสาทหลอน", "หูแว่ว", "เห็นภาพหลอน"],
      i18n: { th: "ประสาทหลอน" }
    }
  },
  {
    names: ["mania", "manic"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "231494001", display: "Mania" },
      text: "Mania",
      aliases: ["แมเนีย", "อารมณ์คึกผิดปกติ"],
      i18n: { th: "แมเนีย" }
    }
  },
  {
    names: ["depressed mood", "feeling depressed", "depressed"],
    definition: {
      coding: {
        system: SNOMED_SYSTEM,
        code: "366979004",
        display: "Depressed mood"
      },
      text: "Depressed mood",
      aliases: ["อารมณ์ซึมเศร้า", "ซึมเศร้า"],
      i18n: { th: "อารมณ์ซึมเศร้า" }
    }
  },
  {
    names: ["poor concentration", "difficulty concentrating", "unable to concentrate", "cannot concentrate", "can't focus"],
    definition: {
      coding: {
        system: SNOMED_SYSTEM,
        code: "26329005",
        display: "Poor concentration"
      },
      text: "Poor concentration",
      aliases: ["สมาธิไม่ดี", "ขาดสมาธิ", "ไม่มีสมาธิ"],
      i18n: { th: "สมาธิไม่ดี" }
    }
  },
  {
    names: ["motion sickness", "travel sickness", "car sickness", "sea sickness", "seasickness"],
    definition: {
      coding: {
        system: SNOMED_SYSTEM,
        code: "37031009",
        display: "Motion sickness"
      },
      text: "Motion sickness",
      aliases: ["เมารถ", "เมาเรือ", "เมาเครื่องบิน"],
      i18n: { th: "เมารถหรือเมาเรือ" }
    }
  },
  {
    names: ["dry mouth", "xerostomia"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "162014002", display: "Dry mouth" },
      text: "Dry mouth",
      aliases: ["ปากแห้ง"],
      i18n: { th: "ปากแห้ง" }
    }
  },
  {
    names: ["palpitations", "palpitation"],
    definition: {
      coding: { system: SNOMED_SYSTEM, code: "80313002", display: "Palpitations" },
      text: "Palpitations",
      aliases: ["ใจสั่น"],
      i18n: { th: "ใจสั่น" }
    }
  }
];

export interface PrnReasonDictionaryEntry {
  canonical: string;
  definition: PrnReasonDefinition;
  terms: string[];
}

export const DEFAULT_PRN_REASON_ENTRIES: PrnReasonDictionaryEntry[] =
  DEFAULT_PRN_REASON_SOURCE.map((source) => {
    const canonicalTerm =
      source.definition.text ?? source.definition.coding?.display ?? source.names[0];
    const terms: string[] = [];
    const seen = new Set<string>();

    const pushTerm = (value: string | undefined): void => {
      if (!value) {
        return;
      }
      const key = normalizePrnReasonKey(value);
      if (!key || seen.has(key)) {
        return;
      }
      seen.add(key);
      terms.push(value);
    };

    for (const name of source.names) {
      pushTerm(name);
    }
    if (source.definition.aliases) {
      for (const alias of source.definition.aliases) {
        pushTerm(alias);
      }
    }
    if (source.definition.i18n) {
      for (const locale in source.definition.i18n) {
        const translation = source.definition.i18n[locale];
        pushTerm(translation);
      }
    }

    return {
      canonical: normalizePrnReasonKey(canonicalTerm ?? ""),
      definition: source.definition,
      terms
    };
  });

export const DEFAULT_PRN_REASON_DEFINITIONS = objectFromEntries(
  DEFAULT_PRN_REASON_ENTRIES.reduce<Array<[string, PrnReasonDefinition]>>((entries, entry) => {
    for (const term of entry.terms) {
      const key = normalizePrnReasonKey(term);
      if (!key) {
        continue;
      }
      entries.push([key, entry.definition]);
    }
    return entries;
  }, [])
) as Record<string, PrnReasonDefinition>;

/**
 * Finds a default PRN reason definition by its SNOMED coding.
 */
export function findPrnReasonDefinitionByCoding(
  system: string,
  code: string
): PrnReasonDefinition | undefined {
  return DEFAULT_PRN_REASON_SOURCE.find(
    (source) =>
      source.definition.coding?.system === system && source.definition.coding?.code === code
  )?.definition;
}
