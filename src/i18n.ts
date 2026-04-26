import { findAdditionalInstructionDefinitionByCoding } from "./advice";
import { resolveBodySitePhrase } from "./body-site-grammar";
import { getPrimitiveTranslation } from "./fhir-translations";
import {
  DEFAULT_BODY_SITE_SNOMED_SOURCE,
  findPrnReasonDefinitionByCoding,
  normalizeBodySiteKey
} from "./maps";
import { getPreferredCanonicalPrnReasonText } from "./prn";
import {
  AdviceArgumentRole,
  AdviceRelation,
  BodySiteSpatialRelation,
  CanonicalDoseExpr,
  CanonicalPrnReasonExpr,
  CanonicalScheduleExpr,
  CanonicalSigClause,
  EventTiming,
  FhirPeriodUnit,
  RouteCode
} from "./types";
import {
  getMealTimingGroup,
  inferDailyOccurrenceCount,
  type MealTimingGroup,
  type TimingSummaryOptions
} from "./timing-summary";

export interface SigFormatContext {
  readonly style: "short" | "long";
  readonly clause: CanonicalSigClause;
  readonly defaultText: string;
  readonly groupMealTimingsByRelation: boolean;
  readonly includeTimesPerDaySummary: boolean;
  formatDefault(style: "short" | "long"): string;
}

export interface SigShortContext extends SigFormatContext {
  readonly style: "short";
}

export interface SigLongContext extends SigFormatContext {
  readonly style: "long";
}

export interface SigLocalization {
  readonly locale: string;
  formatShort?(context: SigShortContext): string;
  formatLong?(context: SigLongContext): string;
}

export interface SigLocalizationConfig
  extends Partial<Omit<SigLocalization, "locale">> {
  locale?: string;
  inherit?: string;
}

const REGISTERED_LOCALIZATIONS = new Map<string, SigLocalization>();

export function registerSigLocalization(localization: SigLocalization): void {
  REGISTERED_LOCALIZATIONS.set(localization.locale.toLowerCase(), localization);
}

export function getRegisteredSigLocalizations(): SigLocalization[] {
  return Array.from(REGISTERED_LOCALIZATIONS.values());
}

export function resolveSigLocalization(
  locale?: string,
  config?: SigLocalizationConfig
): SigLocalization | undefined {
  const normalizedLocale = config?.locale ?? locale;
  const targetKey = normalizedLocale?.toLowerCase();
  const base = targetKey ? REGISTERED_LOCALIZATIONS.get(targetKey) : undefined;
  const inherited = config?.inherit
    ? REGISTERED_LOCALIZATIONS.get(config.inherit.toLowerCase())
    : undefined;

  if (!base && !inherited && !config) {
    return undefined;
  }

  const resolvedLocale =
    config?.locale ??
    config?.inherit ??
    base?.locale ??
    inherited?.locale ??
    targetKey ??
    "custom";

  const result: SigLocalization = {
    locale: resolvedLocale
  };

  if (base?.formatShort) {
    result.formatShort = base.formatShort;
  }
  if (base?.formatLong) {
    result.formatLong = base.formatLong;
  }

  if (inherited?.formatShort) {
    result.formatShort = inherited.formatShort;
  }
  if (inherited?.formatLong) {
    result.formatLong = inherited.formatLong;
  }

  if (config?.formatShort !== undefined) {
    result.formatShort = config.formatShort;
  }
  if (config?.formatLong !== undefined) {
    result.formatLong = config.formatLong;
  }

  if (!result.formatShort && !result.formatLong) {
    return base ?? inherited ?? result;
  }

  return result;
}

registerSigLocalization({
  locale: "en",
  formatShort: ({ defaultText }) => defaultText,
  formatLong: ({ defaultText }) => defaultText
});

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
    formatShort: ({ clause }) => formatShortThai(clause),
    formatLong: ({
      clause,
      groupMealTimingsByRelation,
      includeTimesPerDaySummary
    }) =>
      formatLongThai(clause, {
        groupMealTimingsByRelation,
        includeTimesPerDaySummary
      })
  };
}

registerSigLocalization(createThaiLocalization());

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

const DAY_NAMES_THAI: Record<string, string> = {
  mon: "วันจันทร์",
  tue: "วันอังคาร",
  wed: "วันพุธ",
  thu: "วันพฤหัสบดี",
  fri: "วันศุกร์",
  sat: "วันเสาร์",
  sun: "วันอาทิตย์"
};

const TH_TIMES_PER_DAY: Record<number, string> = {
  1: "วันละครั้ง",
  2: "วันละ 2 ครั้ง",
  3: "วันละ 3 ครั้ง",
  4: "วันละ 4 ครั้ง"
};

const SLOWLY_QUALIFIER_CODE = "419443000";
const EMPTY_STOMACH_QUALIFIER_CODE = "717154004";

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

const THAI_SITE_CODE_TRANSLATIONS: Record<string, string> = (() => {
  const translations: Record<string, string> = {};

  for (const { names, definition } of DEFAULT_BODY_SITE_SNOMED_SOURCE) {
    const code = definition.coding?.code;
    if (!code || translations[code]) {
      continue;
    }

    let translated: string | undefined;
    for (const name of names) {
      const candidate = THAI_SITE_TRANSLATIONS[normalizeBodySiteKey(name)];
      if (candidate) {
        translated = candidate;
        break;
      }
    }

    if (translated) {
      translations[code] = translated;
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
  Shampoo: "สระ",
  Swallow: "รับประทาน",
  Take: "รับประทาน",
  "Use shampoo": "สระ",
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
  "สระ"
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
  "สระ"
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
  "พ่น"
]);

function resolveThaiMethodVerb(
  clause: CanonicalSigClause,
  grammar: ThaiRouteGrammar
): string {
  const translatedText = getPrimitiveTranslation(clause.method?._text, "th");
  if (translatedText) {
    return translatedText;
  }

  const methodText = clause.method?.text?.trim();
  if (methodText) {
    const overridden = THAI_METHOD_TEXT_VERBS[methodText];
    if (overridden) {
      return overridden;
    }
  }

  const translatedDisplay = getPrimitiveTranslation(
    clause.method?.coding?._display,
    "th"
  );
  if (translatedDisplay) {
    return translatedDisplay;
  }

  return grammar.verb;
}

function joinThaiVerbAndBody(verb: string, body: string): string {
  const trimmedBody = body.trim();
  if (!trimmedBody) {
    return verb;
  }
  switch (verb) {
    case "พ่น":
      if (trimmedBody.startsWith("เข้า")) {
        return `${verb}${trimmedBody}`;
      }
      break;
    case "ทาซ้ำ":
    case "ทากันแดดซ้ำ":
    case "สระ":
      if (
        trimmedBody.startsWith("ทุก") ||
        trimmedBody.startsWith("วัน") ||
        trimmedBody.startsWith("ก่อน") ||
        trimmedBody.startsWith("หลัง")
      ) {
        return `${verb}${trimmedBody}`;
      }
      break;
    default:
      break;
  }
  return `${verb} ${trimmedBody}`;
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
    if (dose.unit) {
      return `${stripTrailingZero(dose.value)} ${formatUnitThai(dose.unit, dose.value, "short")}`;
    }
    return stripTrailingZero(dose.value);
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
    if (dose.unit) {
      return `ครั้งละ ${stripTrailingZero(dose.value)} ${formatUnitThai(dose.unit, dose.value, "long")}`;
    }
    return `ครั้งละ ${stripTrailingZero(dose.value)}`;
  }
  return undefined;
}

function formatUnitThai(unit: string, _value: number, style: "short" | "long"): string {
  const lower = unit.toLowerCase();
  const mapping: Record<string, { short: string; long: string }> = {
    tab: { short: "เม็ด", long: "เม็ด" },
    tablet: { short: "เม็ด", long: "เม็ด" },
    cap: { short: "แคปซูล", long: "แคปซูล" },
    capsule: { short: "แคปซูล", long: "แคปซูล" },
    ml: { short: "มล.", long: "มิลลิลิตร" },
    milliliter: { short: "มล.", long: "มิลลิลิตร" },
    milliliters: { short: "มล.", long: "มิลลิลิตร" },
    mg: { short: "มก.", long: "มิลลิกรัม" },
    mcg: { short: "ไมโครกรัม", long: "ไมโครกรัม" },
    ug: { short: "ไมโครกรัม", long: "ไมโครกรัม" },
    puff: { short: "พัฟ", long: "พัฟ" },
    puffs: { short: "พัฟ", long: "พัฟ" },
    spray: { short: "พ่น", long: "พ่น" },
    sprays: { short: "พ่น", long: "พ่น" },
    drop: { short: "หยด", long: "หยด" },
    drops: { short: "หยด", long: "หยด" },
    patch: { short: "แผ่น", long: "แผ่นแปะ" },
    patches: { short: "แผ่น", long: "แผ่นแปะ" },
    suppository: { short: "ยาเหน็บ", long: "ยาเหน็บ" },
    suppositories: { short: "ยาเหน็บ", long: "ยาเหน็บ" }
  };
  const entry = mapping[lower];
  return entry ? entry[style] : unit;
}

function describeFrequencyThai(schedule: CanonicalScheduleExpr | undefined): string | undefined {
  const frequency = schedule?.frequency;
  const frequencyMax = schedule?.frequencyMax;
  const period = schedule?.period;
  const periodMax = schedule?.periodMax;
  const periodUnit = schedule?.periodUnit;
  const timingCode = schedule?.timingCode;

  if (
    frequency !== undefined &&
    frequencyMax !== undefined &&
    periodUnit === FhirPeriodUnit.Day &&
    (!period || period === 1)
  ) {
    if (frequency === 1 && frequencyMax === 1) {
      return "วันละครั้ง";
    }
    if (frequency === 1 && frequencyMax === 2) {
      return "วันละ 1 ถึง 2 ครั้ง";
    }
    return `วันละ ${stripTrailingZero(frequency)} ถึง ${stripTrailingZero(frequencyMax)} ครั้ง`;
  }
  if (frequency && periodUnit === FhirPeriodUnit.Day && (!period || period === 1)) {
    return TH_TIMES_PER_DAY[frequency] ?? `วันละ ${stripTrailingZero(frequency)} ครั้ง`;
  }
  if (periodUnit === FhirPeriodUnit.Minute && period) {
    if (periodMax && periodMax !== period) {
      return `ทุก ${stripTrailingZero(period)} ถึง ${stripTrailingZero(periodMax)} นาที`;
    }
    return `ทุก ${stripTrailingZero(period)} นาที`;
  }
  if (periodUnit === FhirPeriodUnit.Hour && period) {
    if (periodMax && periodMax !== period) {
      return `ทุก ${stripTrailingZero(period)} ถึง ${stripTrailingZero(periodMax)} ชั่วโมง`;
    }
    return `ทุก ${stripTrailingZero(period)} ชั่วโมง`;
  }
  if (periodUnit === FhirPeriodUnit.Day && period && period !== 1) {
    if (period === 2 && (!periodMax || periodMax === 2)) {
      return "วันเว้นวัน";
    }
    if (periodMax && periodMax !== period) {
      return `ทุก ${stripTrailingZero(period)} ถึง ${stripTrailingZero(periodMax)} วัน`;
    }
    return `ทุก ${stripTrailingZero(period)} วัน`;
  }
  if (periodUnit === FhirPeriodUnit.Week && period) {
    if (schedule?.dayOfWeek?.length && period === 1 && (!periodMax || periodMax === 1)) {
      return undefined;
    }
    if (period === 1 && (!periodMax || periodMax === 1)) {
      return "สัปดาห์ละครั้ง";
    }
    if (periodMax && periodMax !== period) {
      return `ทุก ${stripTrailingZero(period)} ถึง ${stripTrailingZero(periodMax)} สัปดาห์`;
    }
    return `ทุก ${stripTrailingZero(period)} สัปดาห์`;
  }
  if (periodUnit === FhirPeriodUnit.Month && period) {
    if (period === 1 && (!periodMax || periodMax === 1)) {
      return "เดือนละครั้ง";
    }
    if (periodMax && periodMax !== period) {
      return `ทุก ${stripTrailingZero(period)} ถึง ${stripTrailingZero(periodMax)} เดือน`;
    }
    return `ทุก ${stripTrailingZero(period)} เดือน`;
  }
  if (periodUnit === FhirPeriodUnit.Year && period) {
    if (period === 1 && (!periodMax || periodMax === 1)) {
      return "ปีละครั้ง";
    }
    if (periodMax && periodMax !== period) {
      return `ทุก ${stripTrailingZero(period)} ถึง ${stripTrailingZero(periodMax)} ปี`;
    }
    return `ทุก ${stripTrailingZero(period)} ปี`;
  }
  if (timingCode) {
    const map: Record<string, string> = {
      BID: "วันละ 2 ครั้ง",
      TID: "วันละ 3 ครั้ง",
      QID: "วันละ 4 ครั้ง",
      QD: "วันละครั้ง",
      QOD: "วันเว้นวัน",
      Q6H: "ทุก 6 ชั่วโมง",
      Q8H: "ทุก 8 ชั่วโมง",
      WK: "สัปดาห์ละครั้ง",
      MO: "เดือนละครั้ง"
    };
    const value = map[timingCode.toUpperCase()];
    if (value) {
      return value;
    }
  }
  if (frequency && periodUnit === undefined && period === undefined) {
    if (frequency === 1) {
      return "ครั้งเดียว";
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

function describeStandaloneOccurrenceCountThai(
  schedule: CanonicalScheduleExpr | undefined
): string | undefined {
  const count = schedule?.count;
  if (!count || count <= 0) {
    return undefined;
  }
  if (
    schedule?.frequency !== undefined ||
    schedule?.frequencyMax !== undefined ||
    schedule?.period !== undefined ||
    schedule?.periodMax !== undefined ||
    schedule?.periodUnit !== undefined ||
    schedule?.dayOfWeek?.length ||
    schedule?.when?.length ||
    schedule?.timeOfDay?.length ||
    schedule?.duration !== undefined ||
    schedule?.durationMax !== undefined ||
    schedule?.durationUnit !== undefined ||
    schedule?.timingCode
  ) {
    return undefined;
  }
  return `${stripTrailingZero(count)} ครั้ง`;
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

function collectWhenPhrasesThai(
  schedule: CanonicalScheduleExpr | undefined,
  options?: TimingSummaryOptions
): string[] {
  const when = schedule?.when ?? [];
  if (!when.length) {
    return [];
  }
  const unique: EventTiming[] = [];
  const seen = new Set<EventTiming>();
  let hasSpecificAfter = false;
  let hasSpecificBefore = false;
  let hasSpecificWith = false;

  for (const code of when) {
    if (!seen.has(code)) {
      seen.add(code);
      unique.push(code);
      if (
        code === EventTiming["After Breakfast"] ||
        code === EventTiming["After Lunch"] ||
        code === EventTiming["After Dinner"]
      ) {
        hasSpecificAfter = true;
      }
      if (
        code === EventTiming["Before Breakfast"] ||
        code === EventTiming["Before Lunch"] ||
        code === EventTiming["Before Dinner"]
      ) {
        hasSpecificBefore = true;
      }
      if (code === EventTiming.Breakfast || code === EventTiming.Lunch || code === EventTiming.Dinner) {
        hasSpecificWith = true;
      }
    }
  }

  const filtered: EventTiming[] = [];
  for (const code of unique) {
    if (code === EventTiming["After Meal"] && hasSpecificAfter) {
      continue;
    }
    if (code === EventTiming["Before Meal"] && hasSpecificBefore) {
      continue;
    }
    if (code === EventTiming.Meal && hasSpecificWith) {
      continue;
    }
    filtered.push(code);
  }

  const mealGroup = getMealTimingGroup(filtered, options);
  if (!mealGroup) {
    const phrases: string[] = [];
    for (const code of filtered) {
      const text = WHEN_TEXT_THAI[code];
      if (text) {
        phrases.push(text);
      }
    }
    return phrases;
  }

  const groupedCodes = new Set<EventTiming>(mealGroup.codes);
  const phrases: string[] = [];
  let insertedGroup = false;
  for (const code of filtered) {
    if (groupedCodes.has(code)) {
      if (!insertedGroup) {
        phrases.push(summarizeMealTimingGroupThai(mealGroup));
        insertedGroup = true;
      }
      continue;
    }
    const text = WHEN_TEXT_THAI[code];
    if (text) {
      phrases.push(text);
    }
  }
  return phrases;
}

function joinWithAndThai(parts: string[]): string {
  if (!parts.length) {
    return "";
  }
  if (parts.length === 1) {
    return parts[0];
  }
  if (parts.length === 2) {
    return `${parts[0]} และ ${parts[1]}`;
  }
  return `${parts.slice(0, -1).join(", ")} และ ${parts[parts.length - 1]}`;
}

function combineFrequencyAndEventsThai(
  frequency: string | undefined,
  events: string[]
): { frequency?: string; event?: string } {
  if (!frequency) {
    if (!events.length) {
      return {};
    }
    return { event: joinWithAndThai(events) };
  }
  if (!events.length) {
    return { frequency };
  }
  if (events.length === 1 && events[0] === "ก่อนนอน" && frequency.includes("วันละ")) {
    return { frequency: `${frequency} และ ${events[0]}` };
  }
  return { frequency, event: joinWithAndThai(events) };
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

function formatSiteThai(clause: CanonicalSigClause, grammar: ThaiRouteGrammar): string | undefined {
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
  const translated = text
    ? translateSiteThai(text, codingCode, clause.site?.spatialRelation)
    : translateSpatialSiteThai(undefined, clause.site?.spatialRelation);
  if (!translated) {
    return undefined;
  }
  if (clause.route?.code === RouteCode["Nasal route"]) {
    return `เข้า${translated}`;
  }
  const preposition = grammar.sitePreposition ?? "ที่";
  const separator = /^[\u0E00-\u0E7F]/.test(translated) ? "" : " ";
  return `${preposition}${separator}${translated}`.trim();
}

const THAI_SPATIAL_RELATION_PREFIXES: Record<string, string> = {
  above: "เหนือ",
  around: "รอบ",
  back: "ด้านหลัง",
  behind: "ด้านหลัง",
  below: "ใต้",
  beneath: "ใต้",
  center: "กลาง",
  centre: "กลาง",
  external: "ด้านนอก",
  front: "ด้านหน้า",
  inside: "ใน",
  between: "ระหว่าง",
  "left side": "ด้านซ้ายของ",
  lower: "ส่วนล่างของ",
  middle: "กลาง",
  near: "ใกล้",
  outside: "ด้านนอก",
  "right side": "ด้านขวาของ",
  side: "ด้านข้าง",
  "both sides": "ทั้งสองด้านของ",
  "bilateral sides": "ทั้งสองด้านของ",
  top: "ด้านบนของ",
  under: "ใต้",
  upper: "ส่วนบนของ"
};

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
  const spatialRelation = relation ?? (site ? resolveBodySitePhrase(site)?.spatialRelation : undefined);
  if (!spatialRelation?.relationText) {
    return undefined;
  }
  const prefix = THAI_SPATIAL_RELATION_PREFIXES[spatialRelation.relationText];
  if (!prefix) {
    return undefined;
  }
  const target = translateSpatialTargetThai(spatialRelation);
  if (!target) {
    return undefined;
  }
  switch (spatialRelation.relationText) {
    case "left side":
      return `${target}ด้านซ้าย`;
    case "right side":
      return `${target}ด้านขวา`;
    case "both sides":
    case "bilateral sides":
      return `${target}ทั้งสองข้าง`;
    default:
      break;
  }
  return `${prefix}${target}`;
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
  const direct = THAI_SITE_TRANSLATIONS[normalized];
  if (direct) {
    return direct;
  }
  const spatial = translateSpatialSiteThai(site, spatialRelation);
  if (spatial) {
    return spatial;
  }
  if (code) {
    const translatedByCode = THAI_SITE_CODE_TRANSLATIONS[code];
    if (translatedByCode) {
      return translatedByCode;
    }
  }
  return site;
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
  return days.length ? `ใน${joinWithAndThai(days)}` : undefined;
}

function formatDurationShortThai(schedule: CanonicalScheduleExpr): string | undefined {
  if (schedule.duration === undefined || !schedule.durationUnit) {
    return undefined;
  }
  const base = stripTrailingZero(schedule.duration);
  const qualifier =
    schedule.durationMax !== undefined && schedule.durationMax !== schedule.duration
      ? `${base}-${stripTrailingZero(schedule.durationMax)}`
      : base;
  return `x${qualifier}${schedule.durationUnit}`;
}

function describeDurationThai(schedule: CanonicalScheduleExpr | undefined): string | undefined {
  if (!schedule || schedule.duration === undefined || !schedule.durationUnit) {
    return undefined;
  }
  const unit = schedule.durationUnit;
  const label = (): string => {
    switch (unit) {
      case FhirPeriodUnit.Minute:
        return "นาที";
      case FhirPeriodUnit.Hour:
        return "ชั่วโมง";
      case FhirPeriodUnit.Day:
        return "วัน";
      case FhirPeriodUnit.Week:
        return "สัปดาห์";
      case FhirPeriodUnit.Month:
        return "เดือน";
      case FhirPeriodUnit.Year:
        return "ปี";
      default:
        return unit;
    }
  };
  if (schedule.durationMax !== undefined && schedule.durationMax !== schedule.duration) {
    return `เป็นเวลา ${stripTrailingZero(schedule.duration)} ถึง ${stripTrailingZero(schedule.durationMax)} ${label()}`;
  }
  return `เป็นเวลา ${stripTrailingZero(schedule.duration)} ${label()}`;
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
  let text = reason.text ?? reason.coding?.display;
  const coding = reason.coding;
  if (coding?.code) {
    const definition = findPrnReasonDefinitionByPossiblyPostcoordinatedCoding(
      coding.system ?? "http://snomed.info/sct",
      coding.code
    );
    text = definition?.i18n?.th ?? text;
  }
  const spatial = translateSpatialSiteThai(undefined, reason.spatialRelation);
  if (text && spatial) {
    return `${text}${spatial}`;
  }
  return text;
}

function formatAsNeededThai(clause: CanonicalSigClause): string | undefined {
  if (!clause.prn?.enabled) {
    return undefined;
  }
  if (clause.prn.reasons?.length) {
    const translatedReasons: typeof clause.prn.reasons = [];
    for (const reason of clause.prn.reasons) {
      const text = translatePrnReasonThai(reason);
      translatedReasons.push({ text, coding: reason.coding });
    }
    const joined = getPreferredCanonicalPrnReasonText(undefined, translatedReasons, "หรือ");
    if (joined) {
      return `ใช้เมื่อจำเป็นสำหรับ ${joined}`;
    }
  }
  let translation: string | undefined;
  const coding = clause.prn.reason?.coding;
  if (coding?.code) {
    const definition = findPrnReasonDefinitionByPossiblyPostcoordinatedCoding(
      coding.system ?? "http://snomed.info/sct",
      coding.code
    );
    translation = definition?.i18n?.th;
  }
  const reason =
    translatePrnReasonThai(clause.prn.reason ?? {}) ??
    translation ??
    getPreferredCanonicalPrnReasonText(clause.prn.reason, clause.prn.reasons, "หรือ") ??
    coding?.display;
  if (reason) {
    return `ใช้เมื่อจำเป็นสำหรับ ${reason}`;
  }
  return "ใช้เมื่อจำเป็น";
}

function formatShortThai(clause: CanonicalSigClause): string {
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
  const timing = describeFrequencyThai(schedule);
  if (timing) {
    parts.push(timing);
  } else if (schedule.timingCode) {
    parts.push(schedule.timingCode);
  } else if (schedule.period && schedule.periodUnit) {
    const base = stripTrailingZero(schedule.period);
    const qualifier =
      schedule.periodMax && schedule.periodMax !== schedule.period
        ? `${base}-${stripTrailingZero(schedule.periodMax)}`
        : base;
    parts.push(`Q${qualifier}${schedule.periodUnit.toUpperCase()}`);
  }
  const events = collectWhenPhrasesThai(schedule);
  if (events.length) {
    parts.push(events.join(" "));
  }
  if (schedule.timeOfDay?.length) {
    const times: string[] = [];
    for (const time of schedule.timeOfDay) {
      times.push(time.slice(0, 5));
    }
    parts.push(times.join(","));
  }
  if (schedule.dayOfWeek?.length) {
    const days: string[] = [];
    for (const day of schedule.dayOfWeek) {
      days.push(DAY_NAMES_THAI[day]?.replace(/^วัน/, "") ?? day);
    }
    parts.push(days.join(","));
  }
  if (schedule.count !== undefined) {
    parts.push(`x${stripTrailingZero(schedule.count)}`);
  }
  const durationShort = formatDurationShortThai(schedule);
  if (durationShort) {
    parts.push(durationShort);
  }
  const asNeeded = formatAsNeededThai(clause);
  if (asNeeded) {
    parts.push(asNeeded);
  }
  return parts.filter(Boolean).join(" ");
}

function formatLongThai(
  clause: CanonicalSigClause,
  options?: TimingSummaryOptions
): string {
  const schedule = scheduleOf(clause);
  const grammar = resolveRouteGrammarThai(clause);
  const verb = resolveThaiMethodVerb(clause, grammar);
  const explicitDosePart = formatDoseThaiLong(clause.dose);
  const sitePart = formatSiteThai(clause, grammar);
  const dosePart = shouldUseGenericMedicationObjectThai(
    clause,
    verb,
    explicitDosePart
  )
    ? explicitDosePart ?? "ยา"
    : explicitDosePart;
  const routePart = shouldSuppressRoutePhraseThai(
    clause,
    verb,
    Boolean(sitePart),
    explicitDosePart
  )
    ? undefined
    : buildRoutePhraseThai(clause, grammar, Boolean(sitePart));
  const standaloneOccurrenceCount = describeStandaloneOccurrenceCountThai(schedule);
  const frequencyPart =
    describeFrequencyThai(schedule) ??
    standaloneOccurrenceCount ??
    describeFrequencyCountThai(inferDailyOccurrenceCount(schedule, options));
  const eventParts = collectWhenPhrasesThai(schedule, options);
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
      eventParts.push(`เวลา ${timeStrings.join(", ")}`);
    }
  }
  const timing = combineFrequencyAndEventsThai(frequencyPart, eventParts);
  const dayPart = describeDayOfWeekThai(schedule);
  const countPart =
    schedule.count !== undefined && !standaloneOccurrenceCount
      ? `จำนวน ${stripTrailingZero(schedule.count)} ครั้ง`
      : undefined;
  const durationPart = describeDurationThai(schedule);
  const asNeeded = formatAsNeededThai(clause);

  const segments: string[] = [];
  if (dosePart) {
    segments.push(dosePart);
  }
  if (routePart) {
    segments.push(routePart);
  }
  const siteFirst =
    Boolean(sitePart) &&
    THAI_SITE_FIRST_VERBS.has(verb) &&
    explicitDosePart === undefined &&
    routePart === undefined;
  if (siteFirst && sitePart) {
    segments.push(sitePart);
  }
  if (timing.frequency) {
    segments.push(timing.frequency);
  }
  if (timing.event) {
    segments.push(timing.event);
  }
  if (dayPart) {
    segments.push(dayPart);
  }
  if (countPart) {
    segments.push(countPart);
  }
  if (durationPart) {
    segments.push(durationPart);
  }
  if (asNeeded) {
    segments.push(asNeeded);
  }
  if (!siteFirst && sitePart) {
    segments.push(sitePart);
  }
  const body = segments.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const instructionPhrases: string[] = [];
  const instructionText = formatAdditionalInstructionsThai(clause);
  if (instructionText) {
    instructionPhrases.push(instructionText);
  }
  const patientInstruction = formatPatientInstructionSentence(
    clause.patientInstruction
  );
  if (patientInstruction) {
    instructionPhrases.push(patientInstruction);
  }
  const trailingInstructionText = instructionPhrases.join(" ").trim() || undefined;
  const baseSentence = `${joinThaiVerbAndBody(verb, body)}.`;
  if (!body) {
    return trailingInstructionText ? `${baseSentence} ${trailingInstructionText}` : baseSentence;
  }
  return trailingInstructionText ? `${baseSentence} ${trailingInstructionText}` : baseSentence;
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
    if (
      instruction.coding?.code === EMPTY_STOMACH_QUALIFIER_CODE ||
      instruction.frames?.some(
        (frame) =>
          frame.relation === AdviceRelation.On &&
          frame.args.some(
            (arg) =>
              arg.role === AdviceArgumentRole.MealState &&
              arg.conceptId === "empty_stomach"
          )
      )
    ) {
      phrases.push("ขณะท้องว่าง");
      continue;
    }
    let text = instruction.text ?? instruction.coding?.display;
    if (instruction.coding?.code) {
      const definition = findAdditionalInstructionDefinitionByCoding(
        instruction.coding.system ?? "http://snomed.info/sct",
        instruction.coding.code
      );
      text = definition?.i18n?.th ?? text;
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

function stripTrailingZero(value: number): string {
  const text = value.toString();
  if (text.includes(".")) {
    return text.replace(/\.0+$/, "").replace(/0+$/, "");
  }
  return text;
}
