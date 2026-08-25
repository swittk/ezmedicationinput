import { baseLanguageTag } from "./localization";
import { RouteCode } from "./types";

export type SuggestLocaleLexemeResolver = (canonical: string, preferred?: string) => string | undefined;

export interface SuggestLocaleUnitRoutePair {
  unit: string;
  route: string;
}

export interface SuggestLocaleAdapter {
  locale: string;
  acceptsSurface(surface: string): boolean;
  unitSuggestionUsesLocaleLexemes: boolean;
  includeEyeAbbreviations: boolean;
  preferRawSiteMapSurfaces: boolean;
  compactRelationSuggestions: boolean;
  routeSuggestionsEnabled: boolean;
  tailLexemeSuggestionsEnabled: boolean;
  matchBodySiteInput(input: string): { lead: string; partial: string } | undefined;
  joinBodySite(lead: string, surface: string): string;
  directPrnCompletion(input: string, reasons: string[], limit: number): string[] | undefined;
  buildUnitCandidate(prefix: string, dose: string, surface: string, route: string): string;
  unitSurface(unit: string, lexeme: SuggestLocaleLexemeResolver): string;
  defaultDirections(
    pairs: SuggestLocaleUnitRoutePair[],
    limit: number,
    lexeme: SuggestLocaleLexemeResolver,
    prnReasons: () => string[]
  ): string[];
  trajectoryScheduleSuffixes(routeCode: RouteCode | undefined, lexeme: SuggestLocaleLexemeResolver): string[];
  preferredPrnReasons(topical: boolean): string[];
  appendAffectedArea(base: string, directSiteObject: boolean): string;
  appendPrn(base: string, reason: string): string;
}

const ADAPTERS = new Map<string, SuggestLocaleAdapter>();

export function registerSuggestLocaleAdapter(adapter: SuggestLocaleAdapter): void {
  ADAPTERS.set(baseLanguageTag(adapter.locale) ?? adapter.locale.toLowerCase(), adapter);
}

export function getSuggestLocaleAdapter(locale: string): SuggestLocaleAdapter {
  const key = baseLanguageTag(locale) ?? locale.toLowerCase();
  return ADAPTERS.get(key) ?? ADAPTERS.get("generic")!;
}

const ASCII_ONLY = /^[\u0000-\u007F]*$/u;
const THAI_SCRIPT = /[\u0E00-\u0E7F]/u;

const GENERIC_ADAPTER: SuggestLocaleAdapter = {
  locale: "generic",
  acceptsSurface: () => true,
  unitSuggestionUsesLocaleLexemes: true,
  includeEyeAbbreviations: false,
  preferRawSiteMapSurfaces: false,
  compactRelationSuggestions: false,
  routeSuggestionsEnabled: false,
  tailLexemeSuggestionsEnabled: false,
  matchBodySiteInput(input) {
    const match = input.match(/^(.*?(?:\binto\b|\bto\b|\bat\b|\bon\b|\bin\b))\s*(.*)$/iu);
    return match ? { lead: match[1].trim(), partial: (match[2] ?? "").trim() } : undefined;
  },
  joinBodySite: (lead, surface) => `${lead} ${surface}`.trim(),
  directPrnCompletion: () => undefined,
  buildUnitCandidate: (prefix, dose, surface) => `${prefix}${dose} ${surface}`,
  unitSurface: (unit, lexeme) => lexeme(unit) ?? unit,
  defaultDirections: () => [],
  trajectoryScheduleSuffixes: () => [],
  preferredPrnReasons: () => [],
  appendAffectedArea: (base) => base,
  appendPrn: (base) => base
};

const EN_ADAPTER: SuggestLocaleAdapter = {
  ...GENERIC_ADAPTER,
  locale: "en",
  acceptsSurface: (surface) => ASCII_ONLY.test(surface),
  unitSuggestionUsesLocaleLexemes: false,
  includeEyeAbbreviations: true,
  routeSuggestionsEnabled: true,
  joinBodySite: (lead, surface) => `${lead} ${surface}`.trim(),
  buildUnitCandidate: (prefix, dose, surface, route) => `${prefix}${dose} ${surface} ${route} qd`,
  unitSurface: (unit) => unit,
  defaultDirections(pairs, limit) {
    const suggestions: string[] = [];
    const seen = new Set<string>();
    for (const pair of pairs.slice(0, 4)) {
      for (const dose of ["1", "2"]) {
        for (const code of ["qd", "bid", "tid", "qid"]) {
          const candidate = `${dose} ${pair.unit} ${pair.route} ${code}`;
          const key = candidate.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          suggestions.push(candidate);
          if (suggestions.length >= limit) return suggestions;
        }
      }
    }
    return suggestions;
  },
  trajectoryScheduleSuffixes(routeCode) {
    const all = ["once daily", "twice daily", "before meals", "after meals", "at bedtime"];
    return routeCode !== RouteCode["Oral route"] ? [all[0], all[1], all[4]] : all;
  },
  preferredPrnReasons: (topical) => topical ? ["itching", "itch"] : ["pain"],
  appendAffectedArea: (base, directSiteObject) => `${base}${directSiteObject ? "" : " to"} affected area`,
  appendPrn: (base, reason) => `${base} as needed for ${reason}`
};

const TH_ADAPTER: SuggestLocaleAdapter = {
  ...GENERIC_ADAPTER,
  locale: "th",
  acceptsSurface: (surface) => THAI_SCRIPT.test(surface),
  unitSuggestionUsesLocaleLexemes: true,
  preferRawSiteMapSurfaces: true,
  compactRelationSuggestions: true,
  tailLexemeSuggestionsEnabled: true,
  matchBodySiteInput(input) {
    const match = input.match(/^(.*?(?:ที่|บริเวณ))\s*(.*)$/u);
    if (match) return { lead: match[1].trim(), partial: (match[2] ?? "").trim() };
    return GENERIC_ADAPTER.matchBodySiteInput(input);
  },
  joinBodySite: (lead, surface) => `${lead}${surface}`,
  directPrnCompletion(input, reasons, limit) {
    const normalized = input.trim().replace(/\s+/gu, " ");
    const marker = "เมื่อ";
    const symptomLeadText = "มีอาการ";
    const markerIndex = normalized.lastIndexOf(marker);
    if (markerIndex < 0) return undefined;
    const before = normalized.slice(0, markerIndex + marker.length);
    let tail = normalized.slice(markerIndex + marker.length);
    let symptomLead = "";
    if (tail.startsWith(symptomLeadText)) {
      symptomLead = symptomLeadText;
      tail = tail.slice(symptomLeadText.length);
    }
    const partial = tail.toLowerCase();
    const suggestions: string[] = [];
    const seen = new Set<string>();
    for (const reason of reasons) {
      let surface = reason;
      if (symptomLead && surface.startsWith(symptomLead)) surface = surface.slice(symptomLead.length);
      if (partial && !surface.toLowerCase().startsWith(partial)) continue;
      const candidate = `${before}${symptomLead}${surface}`;
      const key = candidate.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      suggestions.push(candidate);
      if (suggestions.length >= limit) break;
    }
    return suggestions.length ? suggestions : undefined;
  },
  buildUnitCandidate: (prefix, dose, surface) => `${prefix}${dose} ${surface}`,
  unitSurface: (unit, lexeme) => lexeme(unit) ?? unit,
  defaultDirections(pairs, limit, lexeme, prnReasons) {
    const unit = pairs[0]?.unit ?? "tab";
    const take = lexeme("take", "รับประทาน") ?? "รับประทาน";
    const unitSurface = lexeme(unit) ?? unit;
    const onceDaily = lexeme("daily", "วันละครั้ง") ?? "วันละครั้ง";
    const daily = lexeme("daily", "วันละ") ?? "วันละ";
    const times = lexeme("times", "ครั้ง") ?? "ครั้ง";
    const firstReason = prnReasons()[0];
    return [
      `${take} 1 ${unitSurface} ${onceDaily}`,
      `${take} 1 ${unitSurface} ${daily} 2 ${times}`,
      firstReason ? `${take} 1 ${unitSurface} เมื่อ${firstReason}` : undefined
    ].filter((value): value is string => Boolean(value)).slice(0, limit);
  },
  trajectoryScheduleSuffixes(routeCode, lexeme) {
    const onceDaily = lexeme("daily", "วันละครั้ง") ?? "วันละครั้ง";
    const daily = lexeme("daily", "วันละ") ?? "วันละ";
    const times = lexeme("times", "ครั้ง") ?? "ครั้ง";
    const before = lexeme("before", "ก่อน") ?? "ก่อน";
    const after = lexeme("after", "หลัง") ?? "หลัง";
    const meal = lexeme("meal", "อาหาร") ?? "อาหาร";
    const sleep = lexeme("sleep", "นอน") ?? "นอน";
    const all = [onceDaily, `${daily} 2 ${times}`, `${before}${meal}`, `${after}${meal}`, `${before}${sleep}`];
    return routeCode !== RouteCode["Oral route"] ? [all[0], all[1], all[4]] : all;
  },
  preferredPrnReasons: (topical) => topical ? ["คัน"] : ["ปวด"],
  appendAffectedArea: (base) => `${base}บริเวณที่มีอาการ`,
  appendPrn(base, reason) {
    const symptom = reason.startsWith("มีอาการ") ? reason : `มีอาการ${reason}`;
    return `${base}เมื่อ${symptom}`;
  }
};

registerSuggestLocaleAdapter(GENERIC_ADAPTER);
registerSuggestLocaleAdapter(EN_ADAPTER);
registerSuggestLocaleAdapter(TH_ADAPTER);
