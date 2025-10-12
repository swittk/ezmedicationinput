import { ParsedSigInternal } from "./internal-types";
import { EventTiming, FhirPeriodUnit, RouteCode } from "./types";

export interface SigFormatContext {
  readonly style: "short" | "long";
  readonly internal: ParsedSigInternal;
  readonly defaultText: string;
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
    formatShort: ({ internal }) => formatShortThai(internal),
    formatLong: ({ internal }) => formatLongThai(internal)
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
  "right leg": "ขาขวา",
  "left leg": "ขาซ้าย",
  "both legs": "ขาทั้งสองข้าง",
  leg: "ขา",
  "lower leg": "ขาส่วนล่าง",
  "left lower leg": "ขาส่วนล่างซ้าย",
  "right lower leg": "ขาส่วนล่างขวา",
  "bilateral legs": "ขาทั้งสองข้าง",
  "right hand": "มือขวา",
  "left hand": "มือซ้าย",
  "both hands": "มือทั้งสองข้าง",
  hand: "มือ",
  hands: "มือทั้งสองข้าง",
  "right foot": "เท้าขวา",
  "left foot": "เท้าซ้าย",
  "both feet": "เท้าทั้งสองข้าง",
  foot: "เท้า",
  feet: "เท้า",
  abdomen: "ช่องท้อง",
  abdominal: "ช่องท้อง",
  belly: "ท้อง",
  back: "แผ่นหลัง",
  scalp: "หนังศีรษะ",
  face: "ใบหน้า",
  cheek: "แก้ม",
  cheeks: "แก้มทั้งสองข้าง",
  forehead: "หน้าผาก",
  chin: "คาง",
  neck: "คอ",
  forearm: "ปลายแขน",
  "left forearm": "ปลายแขนซ้าย",
  "right forearm": "ปลายแขนขวา",
  shoulder: "ไหล่",
  shoulders: "ไหล่ทั้งสองข้าง",
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
  "left buttock": "สะโพกซ้าย",
  "left gluteal": "สะโพกซ้าย",
  "right buttock": "สะโพกขวา",
  "right gluteal": "สะโพกขวา",
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

interface ThaiRouteGrammar {
  verb: string;
  routePhrase?: string | ((context: { hasSite: boolean; internal: ParsedSigInternal }) => string | undefined);
  sitePreposition?: string;
}

const DEFAULT_THAI_ROUTE_GRAMMAR: ThaiRouteGrammar = { verb: "ใช้" };

const THAI_ROUTE_GRAMMAR: Partial<Record<RouteCode, ThaiRouteGrammar>> = {
  [RouteCode["Oral route"]]: { verb: "รับประทาน", routePhrase: "ทางปาก" },
  [RouteCode["Sublingual route"]]: { verb: "อมใต้ลิ้น", routePhrase: "ใต้ลิ้น" },
  [RouteCode["Buccal route"]]: { verb: "อมกระพุ้งแก้ม", routePhrase: "ที่กระพุ้งแก้ม" },
  [RouteCode["Respiratory tract route (qualifier value)"]]: {
    verb: "สูด",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "โดยการสูดดม"),
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

function resolveRouteGrammarThai(internal: ParsedSigInternal): ThaiRouteGrammar {
  if (internal.routeCode && THAI_ROUTE_GRAMMAR[internal.routeCode]) {
    return THAI_ROUTE_GRAMMAR[internal.routeCode] ?? DEFAULT_THAI_ROUTE_GRAMMAR;
  }
  const grammar = grammarFromRouteTextThai(internal.routeText);
  return grammar ?? DEFAULT_THAI_ROUTE_GRAMMAR;
}

function grammarFromRouteTextThai(text: string | undefined): ThaiRouteGrammar | undefined {
  if (!text) return undefined;
  const normalized = text.trim().toLowerCase();
  if (!normalized) return undefined;
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
  if (normalized.includes("nasal")) {
    return THAI_ROUTE_GRAMMAR[RouteCode["Nasal route"]];
  }
  if (normalized.includes("inhal")) {
    return THAI_ROUTE_GRAMMAR[RouteCode["Respiratory tract route (qualifier value)"]];
  }
  return undefined;
}

function formatDoseThaiShort(internal: ParsedSigInternal): string | undefined {
  if (internal.doseRange) {
    const { low, high } = internal.doseRange;
    const base = `${stripTrailingZero(low)}-${stripTrailingZero(high)}`;
    if (internal.unit) {
      return `${base} ${formatUnitThai(internal.unit, high, "short")}`;
    }
    return base;
  }
  if (internal.dose !== undefined) {
    const amount = stripTrailingZero(internal.dose);
    if (internal.unit) {
      return `${amount} ${formatUnitThai(internal.unit, internal.dose, "short")}`;
    }
    return amount;
  }
  return undefined;
}

function formatDoseThaiLong(internal: ParsedSigInternal): string | undefined {
  if (internal.doseRange) {
    const { low, high } = internal.doseRange;
    if (internal.unit) {
      const unit = formatUnitThai(internal.unit, high, "long");
      return `ครั้งละ ${stripTrailingZero(low)} ถึง ${stripTrailingZero(high)} ${unit}`;
    }
    return `ครั้งละ ${stripTrailingZero(low)} ถึง ${stripTrailingZero(high)}`;
  }
  if (internal.dose !== undefined) {
    if (internal.unit) {
      const unit = formatUnitThai(internal.unit, internal.dose, "long");
      return `ครั้งละ ${stripTrailingZero(internal.dose)} ${unit}`;
    }
    return `ครั้งละ ${stripTrailingZero(internal.dose)}`;
  }
  return undefined;
}

function formatUnitThai(unit: string, value: number, style: "short" | "long"): string {
  const lower = unit.toLowerCase();
  const quantity = Math.abs(value);
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
  if (entry) {
    return style === "short" ? entry.short : entry.long;
  }
  return unit;
}

function describeFrequencyThai(internal: ParsedSigInternal): string | undefined {
  const { frequency, frequencyMax, period, periodMax, periodUnit, timingCode } = internal;
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
    if (frequency === 1) return "วันละครั้ง";
    if (frequency === 2) return "วันละ 2 ครั้ง";
    if (frequency === 3) return "วันละ 3 ครั้ง";
    if (frequency === 4) return "วันละ 4 ครั้ง";
    return `วันละ ${stripTrailingZero(frequency)} ครั้ง`;
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
    if (frequency === 1) return "ครั้งเดียว";
    return `${stripTrailingZero(frequency)} ครั้ง`;
  }
  return undefined;
}

function collectWhenPhrasesThai(internal: ParsedSigInternal): string[] {
  if (!internal.when.length) {
    return [];
  }
  const unique: EventTiming[] = [];
  const seen = new Set<EventTiming>();
  for (const code of internal.when) {
    if (!seen.has(code)) {
      seen.add(code);
      unique.push(code);
    }
  }
  const hasSpecificAfter = unique.some(
    (code) =>
      code === EventTiming["After Breakfast"] ||
      code === EventTiming["After Lunch"] ||
      code === EventTiming["After Dinner"]
  );
  const hasSpecificBefore = unique.some(
    (code) =>
      code === EventTiming["Before Breakfast"] ||
      code === EventTiming["Before Lunch"] ||
      code === EventTiming["Before Dinner"]
  );
  const hasSpecificWith = unique.some(
    (code) =>
      code === EventTiming.Breakfast ||
      code === EventTiming.Lunch ||
      code === EventTiming.Dinner
  );
  return unique
    .filter((code) => {
      if (code === EventTiming["After Meal"] && hasSpecificAfter) {
        return false;
      }
      if (code === EventTiming["Before Meal"] && hasSpecificBefore) {
        return false;
      }
      if (code === EventTiming.Meal && hasSpecificWith) {
        return false;
      }
      return true;
    })
    .map((code) => WHEN_TEXT_THAI[code] ?? undefined)
    .filter((text): text is string => Boolean(text));
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
  if (events.length === 1 && events[0] === "ก่อนนอน") {
    if (frequency.includes("วันละ")) {
      return { frequency: `${frequency} และ ${events[0]}` };
    }
  }
  return { frequency, event: joinWithAndThai(events) };
}

function buildRoutePhraseThai(
  internal: ParsedSigInternal,
  grammar: ThaiRouteGrammar,
  hasSite: boolean
): string | undefined {
  if (typeof grammar.routePhrase === "function") {
    return grammar.routePhrase({ hasSite, internal });
  }
  if (typeof grammar.routePhrase === "string") {
    return grammar.routePhrase;
  }
  const text = internal.routeText?.trim();
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
    return "โดยการสูดดม";
  }
  return text;
}

function formatSiteThai(internal: ParsedSigInternal, grammar: ThaiRouteGrammar): string | undefined {
  const text = internal.siteText?.trim();
  if (!text) {
    return undefined;
  }
  const translated = translateSiteThai(text);
  const preposition = grammar.sitePreposition ?? "ที่";
  const separator = /^[\u0E00-\u0E7F]/.test(translated) ? "" : " ";
  return `${preposition}${separator}${translated}`.trim();
}

function translateSiteThai(site: string): string {
  const normalized = site.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) {
    return site;
  }
  return THAI_SITE_TRANSLATIONS[normalized] ?? site;
}

function describeDayOfWeekThai(internal: ParsedSigInternal): string | undefined {
  if (!internal.dayOfWeek.length) {
    return undefined;
  }
  const days = internal.dayOfWeek
    .map((d) => DAY_NAMES_THAI[d] ?? undefined)
    .filter((d): d is string => Boolean(d));
  if (!days.length) {
    return undefined;
  }
  return `ใน${joinWithAndThai(days)}`;
}

function formatAsNeededThai(internal: ParsedSigInternal): string | undefined {
  if (!internal.asNeeded) {
    return undefined;
  }
  if (internal.asNeededReason) {
    return `ใช้เมื่อจำเป็นสำหรับ ${internal.asNeededReason}`;
  }
  return "ใช้เมื่อจำเป็น";
}

function formatShortThai(internal: ParsedSigInternal): string {
  const parts: string[] = [];
  const dose = formatDoseThaiShort(internal);
  if (dose) {
    parts.push(dose);
  }
  if (internal.routeCode) {
    const short = ROUTE_SHORT[internal.routeCode];
    if (short) {
      parts.push(short);
    } else if (internal.routeText) {
      parts.push(internal.routeText);
    }
  } else if (internal.routeText) {
    parts.push(internal.routeText);
  }
  const timing = describeFrequencyThai(internal);
  if (timing) {
    parts.push(timing);
  } else if (internal.timingCode) {
    parts.push(internal.timingCode);
  } else if (internal.period && internal.periodUnit) {
    const base = stripTrailingZero(internal.period);
    const qualifier =
      internal.periodMax && internal.periodMax !== internal.period
        ? `${base}-${stripTrailingZero(internal.periodMax)}`
        : base;
    parts.push(`Q${qualifier}${internal.periodUnit.toUpperCase()}`);
  }
  if (internal.when.length) {
    const events = collectWhenPhrasesThai(internal);
    if (events.length) {
      parts.push(events.join(" "));
    }
  }
  if (internal.dayOfWeek.length) {
    const days = internal.dayOfWeek
      .map((d) => DAY_NAMES_THAI[d]?.replace(/^วัน/, "") ?? d)
      .join(",");
    parts.push(days);
  }
  if (internal.count !== undefined) {
    parts.push(`x${stripTrailingZero(internal.count)}`);
  }
  const asNeeded = formatAsNeededThai(internal);
  if (asNeeded) {
    parts.push(asNeeded);
  }
  return parts.filter(Boolean).join(" ");
}

function formatLongThai(internal: ParsedSigInternal): string {
  const grammar = resolveRouteGrammarThai(internal);
  const dosePart = formatDoseThaiLong(internal) ?? "ยา";
  const sitePart = formatSiteThai(internal, grammar);
  const routePart = buildRoutePhraseThai(internal, grammar, Boolean(sitePart));
  const frequencyPart = describeFrequencyThai(internal);
  const eventParts = collectWhenPhrasesThai(internal);
  const timing = combineFrequencyAndEventsThai(frequencyPart, eventParts);
  const dayPart = describeDayOfWeekThai(internal);
  const countPart =
    internal.count !== undefined
      ? `จำนวน ${stripTrailingZero(internal.count)} ครั้ง`
      : undefined;
  const asNeeded = formatAsNeededThai(internal);

  const segments: string[] = [dosePart];
  if (routePart) {
    segments.push(routePart);
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
  if (asNeeded) {
    segments.push(asNeeded);
  }
  if (sitePart) {
    segments.push(sitePart);
  }

  const body = segments.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  if (!body) {
    return `${grammar.verb}.`;
  }
  return `${grammar.verb} ${body}.`;
}

function stripTrailingZero(value: number): string {
  const text = value.toString();
  if (text.includes(".")) {
    return text.replace(/\.0+$/, "").replace(/0+$/, "");
  }
  return text;
}
