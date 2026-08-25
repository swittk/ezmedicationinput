import { inferUnitFromContext } from "./context";
import { baseLanguageTag, localizedConfig, localizedValue } from "./localization";
import { inferMedicationLocale } from "./locale-detection";
import { getSuggestLocaleAdapter } from "./suggest-locale-adapter";
import { listSupportedBodySiteText } from "./body-site-lookup";
import { listMedicationInstructionActions, medicationInstructionActionLocaleRealizerConfig } from "./instruction-action-terminology";
import { listMedicationLocaleLexemes, medicationLexerLocalePackRevision } from "./lexer/locale";
import {
  EYE_SITE_ABBREVIATIONS,
  FOOD_EVENT_ALIASES,
  FREQUENCY_ADVERB_UNITS_DATA,
  MEAL_TIMING_BY_RELATION,
  SLEEP_EVENT_ALIASES,
  WAKE_EVENT_ALIASES,
  WORKFLOW_ACTION_RELATION_LEADS
} from "./hpsg/lexical-classes";
import { normalizeUnit } from "./unit-lexicon";
import { findUnparsedTokenGroups, parseClauseState } from "./parser";
import {
  DAY_OF_WEEK_TOKENS,
  DEFAULT_BODY_SITE_SNOMED,
  DEFAULT_ROUTE_SYNONYMS,
  DEFAULT_UNIT_BY_ROUTE,
  DEFAULT_UNIT_SYNONYMS,
  EVENT_TIMING_TOKENS,
  HOUSEHOLD_VOLUME_UNITS,
  ROUTE_TEXT,
  TIMING_ABBREVIATIONS,
} from "./maps";
import { DEFAULT_SYMPTOM_DEFINITIONS } from "./symptom-terminology";
import { ParseOptions, RouteCode } from "./types";

export interface SuggestSigOptions extends ParseOptions {
  /**
   * Maximum number of suggestions to return. Defaults to 10 when not supplied.
   */
  limit?: number;
  /**
   * Optional custom PRN reasons to use when generating suggestions.
   */
  prnReasons?: readonly string[];
}

interface UnitRoutePair {
  unit: string;
  route: string;
}

interface UnitVariant {
  value: string;
  lower: string;
}

interface UnitRoutePreference {
  unit: string;
  routeCode: RouteCode;
  routeToken?: string;
}

const DEFAULT_LIMIT = 10;

const SUGGESTION_LEXEME_CACHE = new Map<string, {
  revision: number;
  lexemes: ReturnType<typeof listMedicationLocaleLexemes>;
}>();
function suggestionLexemes(locale: string) {
  const key = baseLanguageTag(locale) ?? locale.toLowerCase();
  const revision = medicationLexerLocalePackRevision();
  const cached = SUGGESTION_LEXEME_CACHE.get(key);
  if (cached?.revision === revision) return cached.lexemes;
  const lexemes = listMedicationLocaleLexemes(locale);
  SUGGESTION_LEXEME_CACHE.set(key, { revision, lexemes });
  return lexemes;
}
const DEFAULT_SUGGESTION_ACTIONS = listMedicationInstructionActions();
const DEFAULT_SUGGESTION_ACTION_SURFACES: Array<{
  surface: string;
  definition: (typeof DEFAULT_SUGGESTION_ACTIONS)[number];
}> = [];
for (const definition of DEFAULT_SUGGESTION_ACTIONS) {
  const localeAliases = Object.keys(definition.localeAliases ?? {})
    .reduce<string[]>((all, locale) => all.concat(definition.localeAliases?.[locale] ?? []), []);
  for (const surface of [definition.display, ...(definition.aliases ?? []), ...localeAliases]) {
    if (surface) DEFAULT_SUGGESTION_ACTION_SURFACES.push({ surface, definition });
  }
}
DEFAULT_SUGGESTION_ACTION_SURFACES.sort((left, right) => right.surface.length - left.surface.length);
let defaultSupportedBodySiteTextCache: string[] | undefined;
function defaultSupportedBodySiteText(): string[] {
  if (!defaultSupportedBodySiteTextCache) {
    defaultSupportedBodySiteTextCache = listSupportedBodySiteText();
  }
  return defaultSupportedBodySiteTextCache;
}

const HOUSEHOLD_VOLUME_UNIT_SET = new Set(
  HOUSEHOLD_VOLUME_UNITS.map((unit) => unit.trim().toLowerCase()),
);

const ROUTE_TOKEN_BY_CODE: Partial<Record<RouteCode, string>> = {
  [RouteCode["Oral route"]]: "po",
  [RouteCode["Respiratory tract route (qualifier value)"]]: "inh",
  [RouteCode["Nasal route"]]: "in",
  [RouteCode["Ophthalmic route"]]: "oph",
  [RouteCode["Per rectum"]]: "pr",
  [RouteCode["Transdermal route"]]: "transdermal",
  [RouteCode["Topical route"]]: "topical",
};

const DEFAULT_UNIT_ROUTE_ORDER: UnitRoutePreference[] = [
  { unit: "tab", routeCode: RouteCode["Oral route"] },
  { unit: "cap", routeCode: RouteCode["Oral route"] },
  { unit: "tsp", routeCode: RouteCode["Oral route"] },
  { unit: "tbsp", routeCode: RouteCode["Oral route"] },
  { unit: "mL", routeCode: RouteCode["Oral route"] },
  { unit: "L", routeCode: RouteCode["Oral route"] },
  { unit: "mcL", routeCode: RouteCode["Oral route"] },
  { unit: "nL", routeCode: RouteCode["Oral route"] },
  { unit: "mg", routeCode: RouteCode["Oral route"] },
  { unit: "mcg", routeCode: RouteCode["Oral route"] },
  { unit: "ng", routeCode: RouteCode["Oral route"] },
  { unit: "g", routeCode: RouteCode["Topical route"] },
  { unit: "kg", routeCode: RouteCode["Topical route"] },
  { unit: "puff", routeCode: RouteCode["Respiratory tract route (qualifier value)"] },
  { unit: "spray", routeCode: RouteCode["Nasal route"] },
  { unit: "drop", routeCode: RouteCode["Ophthalmic route"] },
  { unit: "suppository", routeCode: RouteCode["Per rectum"] },
  { unit: "patch", routeCode: RouteCode["Transdermal route"] },
];

const ROUTE_TOKEN_BY_UNIT = (() => {
  const map = new Map<string, string>();

  const assign = (unit: string | undefined, token: string | undefined) => {
    if (!unit || !token) {
      return;
    }
    const normalizedUnit = normalizeKey(unit);
    if (!normalizedUnit || map.has(normalizedUnit)) {
      return;
    }
    map.set(normalizedUnit, normalizeSpacing(token));
  };

  for (const routeCodeKey in DEFAULT_UNIT_BY_ROUTE) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_UNIT_BY_ROUTE, routeCodeKey)) {
      continue;
    }
    const routeCode = routeCodeKey as RouteCode;
    const unit = DEFAULT_UNIT_BY_ROUTE[routeCode];
    if (!unit) {
      continue;
    }
    const token = ROUTE_TOKEN_BY_CODE[routeCode] ?? ROUTE_TEXT[routeCode];
    assign(unit, token);
  }

  for (const preference of DEFAULT_UNIT_ROUTE_ORDER) {
    const token =
      preference.routeToken ??
      ROUTE_TOKEN_BY_CODE[preference.routeCode] ??
      ROUTE_TEXT[preference.routeCode];
    assign(preference.unit, token);
  }

  return map;
})();

const BASE_INTERVAL_CODES = Object.keys(TIMING_ABBREVIATIONS)
  .filter((token) => /^q\d+h$/.test(token))
  .sort((a, b) => Number.parseInt(a.slice(1, -1), 10) - Number.parseInt(b.slice(1, -1), 10));

const DEFAULT_INTERVAL_RANGES = ["q2-4h", "q4-6h", "q6-8h", "q8-12h"] as const;

const BASE_WHEN_TOKEN_CANDIDATES = [
  "ac",
  "pc",
  "hs",
  "am",
  "pm",
  "morn",
  "morning",
  "noon",
  "afternoon",
  "evening",
  "night",
  "bedtime",
  "wake",
  "waking",
  "breakfast",
  "lunch",
  "dinner",
  "stat",
];

const WHEN_TOKENS = BASE_WHEN_TOKEN_CANDIDATES.filter(
  (token) => EVENT_TIMING_TOKENS[token] !== undefined,
);

const FREQUENCY_CODES = ["qd", "od", "bid", "tid", "qid"].filter(
  (token) => TIMING_ABBREVIATIONS[token] !== undefined,
);

const FREQ_TOKEN_BY_NUMBER: Record<number, string> = {};
for (const [frequency, token] of [
  [1, "qd"],
  [2, "bid"],
  [3, "tid"],
  [4, "qid"],
] as const) {
  if (TIMING_ABBREVIATIONS[token]) {
    FREQ_TOKEN_BY_NUMBER[frequency] = token;
  }
}

const FREQUENCY_NUMBERS = Object.keys(FREQ_TOKEN_BY_NUMBER)
  .map((value) => Number.parseInt(value, 10))
  .sort((a, b) => a - b);

const UNIT_LOOKUP = (() => {
  const canonicalByKey = new Map<string, string>();
  const variantsByCanonical = new Map<string, Set<string>>();

  const registerVariant = (canonical: string, variant: string) => {
    const normalizedCanonical = normalizeKey(canonical);
    if (!normalizedCanonical) {
      return;
    }
    let variants = variantsByCanonical.get(normalizedCanonical);
    if (!variants) {
      variants = new Set();
      variantsByCanonical.set(normalizedCanonical, variants);
    }
    variants.add(normalizeSpacing(canonical));
    variants.add(normalizeSpacing(variant));
  };

  for (const token in DEFAULT_UNIT_SYNONYMS) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_UNIT_SYNONYMS, token)) {
      continue;
    }
    const canonicalValue = DEFAULT_UNIT_SYNONYMS[token];
    const canonical = normalizeSpacing(canonicalValue);
    registerVariant(canonical, canonical);
    registerVariant(canonical, token);
    canonicalByKey.set(normalizeKey(token), canonical);
    canonicalByKey.set(normalizeKey(canonical), canonical);
  }

  return { canonicalByKey, variantsByCanonical };
})();

function resolveCanonicalUnit(unit: string | undefined): string | undefined {
  if (!unit) {
    return undefined;
  }
  const normalized = normalizeKey(unit);
  if (!normalized) {
    return undefined;
  }
  return UNIT_LOOKUP.canonicalByKey.get(normalized) ?? normalizeSpacing(unit);
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeSpacing(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ");
}

const UNIT_VARIANT_CACHE = new Map<string, UnitVariant[]>();

function getUnitVariants(unit: string): UnitVariant[] {
  const canonical = resolveCanonicalUnit(unit) ?? normalizeSpacing(unit);
  const normalizedCanonical = normalizeKey(canonical);
  const cached = UNIT_VARIANT_CACHE.get(normalizedCanonical);
  if (cached) {
    return cached;
  }

  const variants = new Map<string, UnitVariant>();

  const push = (candidate: string | undefined) => {
    if (!candidate) {
      return;
    }
    const normalizedCandidate = normalizeSpacing(candidate);
    if (!normalizedCandidate) {
      return;
    }
    const lower = normalizedCandidate.toLowerCase();
    if (variants.has(lower)) {
      return;
    }
    variants.set(lower, { value: normalizedCandidate, lower });
  };

  push(canonical);
  push(unit);

  const canonicalVariants = UNIT_LOOKUP.variantsByCanonical.get(normalizedCanonical);
  if (canonicalVariants) {
    for (const candidate of canonicalVariants) {
      push(candidate);
    }
  }

  const result = [...variants.values()];
  UNIT_VARIANT_CACHE.set(normalizedCanonical, result);
  return result;
}

function buildUnitRoutePairs(
  contextUnit: string | undefined,
  options?: SuggestSigOptions,
): UnitRoutePair[] {
  const pairs: UnitRoutePair[] = [];
  const seen = new Set<string>();

  const addPair = (unit: string | undefined, routeOverride?: string | undefined) => {
    const canonicalUnit = resolveCanonicalUnit(unit);
    if (!canonicalUnit) {
      return;
    }

    const normalizedUnit = normalizeKey(canonicalUnit);
    if (
      options?.allowHouseholdVolumeUnits === false &&
      HOUSEHOLD_VOLUME_UNIT_SET.has(normalizedUnit)
    ) {
      return;
    }
    const resolvedRoute =
      routeOverride ?? ROUTE_TOKEN_BY_UNIT.get(normalizedUnit) ?? "po";
    const cleanRoute = normalizeSpacing(resolvedRoute);
    if (!cleanRoute) {
      return;
    }

    const routeLower = cleanRoute.toLowerCase();
    const key = `${normalizedUnit}::${routeLower}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    pairs.push({ unit: canonicalUnit, route: cleanRoute });
  };

  addPair(contextUnit);

  for (const preference of DEFAULT_UNIT_ROUTE_ORDER) {
    const routeToken =
      preference.routeToken ??
      ROUTE_TOKEN_BY_CODE[preference.routeCode] ??
      ROUTE_TEXT[preference.routeCode];
    addPair(preference.unit, routeToken);
  }

  return pairs;
}

const DEFAULT_PRN_REASON_CACHE = new WeakMap<object, Map<string, string[]>>();

function defaultPrnReasonsForLocale(locale: string): string[] {
  const adapter = getSuggestLocaleAdapter(locale);
  let byLocale = DEFAULT_PRN_REASON_CACHE.get(adapter);
  if (!byLocale) {
    byLocale = new Map<string, string[]>();
    DEFAULT_PRN_REASON_CACHE.set(adapter, byLocale);
  }
  const localeKey = baseLanguageTag(locale) ?? locale.toLowerCase();
  const cached = byLocale.get(localeKey);
  if (cached) return cached;
  const reasons = new Set<string>();
  const add = (reason: string | undefined) => {
    if (!reason) return;
    const normalized = normalizeSpacing(reason.toLowerCase());
    if (normalized && adapter.acceptsSurface(normalized)) reasons.add(normalized);
  };
  for (const surface in DEFAULT_SYMPTOM_DEFINITIONS) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_SYMPTOM_DEFINITIONS, surface)) continue;
    const definition = DEFAULT_SYMPTOM_DEFINITIONS[surface];
    add(localizedValue(definition.i18n, locale) ?? definition.text ??
      localizedValue(definition.conditionI18n, locale) ?? surface);
  }
  for (const surface in DEFAULT_SYMPTOM_DEFINITIONS) {
    if (Object.prototype.hasOwnProperty.call(DEFAULT_SYMPTOM_DEFINITIONS, surface)) add(surface);
  }
  const result = [...reasons];
  byLocale.set(localeKey, result);
  return result;
}

function buildPrnReasons(options?: SuggestSigOptions): string[] {
  const reasons = new Set<string>();
  const locale = baseLanguageTag(options?.locale) ?? "en";
  const adapter = getSuggestLocaleAdapter(locale);
  const add = (reason: string | undefined) => {
    if (!reason) return;
    const normalized = normalizeSpacing(reason.toLowerCase());
    if (normalized && adapter.acceptsSurface(normalized)) reasons.add(normalized);
  };

  // Explicit caller vocabulary ranks first.
  for (const reason of options?.prnReasons ?? []) add(reason);
  for (const custom of [options?.prnReasonMap, options?.symptomMap]) {
    if (!custom) continue;
    for (const surface in custom) {
      if (!Object.prototype.hasOwnProperty.call(custom, surface)) continue;
      const definition = custom[surface];
      add(localizedValue(definition.i18n, locale) ?? definition.text ??
        localizedValue(definition.conditionI18n, locale) ?? surface);
      add(surface);
      for (const alias of definition.aliases ?? []) add(alias);
    }
  }
  for (const reason of defaultPrnReasonsForLocale(locale)) reasons.add(reason);
  return [...reasons];
}

function buildMealDashCoreVariants(prefixCore: string): string[] {
  if (!prefixCore.includes("-") || prefixCore.includes("--")) {
    return [];
  }
  const slots = prefixCore.split("-");
  if (slots.length < 2 || slots.length > 4) {
    return [];
  }
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(slots[0] ?? "")) {
    return [];
  }
  for (let i = 1; i < slots.length; i += 1) {
    const slot = slots[i];
    if (slot.length === 0) {
      continue;
    }
    if (!/^[0-9]+(?:\.[0-9]+)?$/.test(slot)) {
      return [];
    }
  }

  const variants: string[] = [];
  const seen = new Set<string>();
  const addVariant = (value: string) => {
    if (!seen.has(value)) {
      seen.add(value);
      variants.push(value);
    }
  };
  const first = slots[0];

  const fillBase = (targetLength: 3 | 4): string[] => {
    const values = new Array<string>(targetLength).fill("0");
    values[0] = first;
    for (let i = 1; i < targetLength; i += 1) {
      if (i < slots.length && slots[i] !== "") {
        values[i] = slots[i];
      }
    }
    return values;
  };

  const base3 = fillBase(3);
  const missingThird = slots.length < 3 || slots[2] === "";
  if (missingThird && (slots.length === 1 || slots[1] === "" || slots[1] === "0")) {
    const mirror = [...base3];
    mirror[2] = first;
    addVariant(mirror.join("-"));
  }
  addVariant(base3.join("-"));

  const base4 = fillBase(4);
  const missingFourth = slots.length < 4 || slots[3] === "";
  if (
    missingFourth &&
    (
      slots.length === 1 ||
      slots[1] === "" ||
      (slots[1] === "0" && (slots.length < 3 || slots[2] === "" || slots[2] === "0"))
    )
  ) {
    const mirror = [...base4];
    mirror[3] = first;
    addVariant(mirror.join("-"));
  }
  addVariant(base4.join("-"));

  return variants;
}

function suggestMealDashSyntax(
  prefix: string,
  limit: number,
): string[] | undefined {
  if (!prefix.includes("-")) {
    return undefined;
  }
  const match = prefix.match(/^(\d+(?:-\d*){0,3})(?:\s+(ac|pc))?$/);
  if (!match) {
    return undefined;
  }
  const core = match[1];
  const relation = match[2];
  const coreVariants = buildMealDashCoreVariants(core);
  if (coreVariants.length === 0) {
    return undefined;
  }

  const suffixes = relation ? [` ${relation}`] : ["", " ac", " pc"];
  const candidates: string[] = [];
  for (const variant of coreVariants) {
    for (const suffix of suffixes) {
      candidates.push(`${variant}${suffix}`);
    }
  }

  return candidates.slice(0, limit);
}

function suggestCompactOralMealTiming(
  prefix: string,
  limit: number,
): string[] | undefined {
  const match = prefix.match(
    /^(\d+(?:\.\d+)?)\s*(?:po\s*(c|ac|pc)|po(c|ac|pc))$/,
  );
  if (!match) {
    return undefined;
  }

  const dose = normalizeSpacing(match[1]);
  const timing = (match[2] ?? match[3] ?? "").toLowerCase();
  const orderedTimings =
    timing === "c"
      ? ["c", "ac", "pc"]
      : timing === "ac"
        ? ["ac", "c", "pc"]
        : timing === "pc"
          ? ["pc", "c", "ac"]
          : ["c", "ac", "pc"];
  const candidates = orderedTimings.map((token) => `${dose} po ${token}`);
  return candidates.slice(0, limit);
}

const NON_ASCII_SCRIPT = /[^\u0000-\u007F]/u;

function suggestionLocale(input: string, options?: SuggestSigOptions): string {
  const explicit = baseLanguageTag(options?.locale);
  return explicit ?? inferMedicationLocale(input, "en");
}


function directLocalePrnReasonSuggestions(
  input: string,
  options: SuggestSigOptions | undefined,
  limit: number,
): string[] | undefined {
  const locale = suggestionLocale(input, options);
  const adapter = getSuggestLocaleAdapter(locale);
  return adapter.directPrnCompletion(
    normalizeSpacing(input),
    buildPrnReasons({ ...options, locale }),
    limit
  );
}

function localeLexemeByCanonical(locale: string, canonical: string, preferred?: string): string | undefined {
  const lexemes = suggestionLexemes(locale);
  const canonicalKey = normalizeKey(canonical);
  const matches = lexemes.filter((lexeme) => normalizeKey(lexeme.canonical) === canonicalKey);
  if (preferred) {
    const exact = matches.find((lexeme) => lexeme.surface === preferred);
    if (exact) return exact.surface;
  }
  return matches.sort((left, right) => left.surface.length - right.surface.length)[0]?.surface;
}

function parserAcceptsSuggestion(
  candidate: string,
  options?: SuggestSigOptions
): ReturnType<typeof parseClauseState> | undefined {
  const state = parseClauseState(candidate, options);
  return !state.primaryClause.leftovers?.length && findUnparsedTokenGroups(state).length === 0
    ? state
    : undefined;
}

function directPrnReasonSuggestions(
  input: string,
  options: SuggestSigOptions | undefined,
  limit: number,
): string[] | undefined {
  const normalized = normalizeSpacing(input);
  const match = normalized.match(/^(.*?\b(?:prn|as needed(?: for)?))(?:\s+([^\s]+))?$/i);
  if (!match) return undefined;
  const partial = (match[2] ?? "").toLowerCase();
  const reasons = buildPrnReasons(options)
    .filter((reason) => reason.startsWith(partial));
  if (!reasons.length) return undefined;
  return reasons.slice(0, limit).map((reason) => `${match[1]} ${reason}`);
}

function directUnitSuggestions(
  input: string,
  options: SuggestSigOptions | undefined,
  limit: number,
): string[] | undefined {
  const normalized = normalizeSpacing(input);
  const match = normalized.match(/^(.*?)(\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)\s+([^\s]+)$/i);
  if (!match) return undefined;
  const leading = normalizeSpacing(match[1] ?? "");
  const dose = match[2];
  const fragment = match[3].toLowerCase();
  if (/^(?:po|prn|q\d|qd|od|bid|tid|qid)$/i.test(fragment)) return undefined;
  const locale = suggestionLocale(input, options);
  const localeAdapter = getSuggestLocaleAdapter(locale);
  const pairs = buildUnitRoutePairs(inferUnitFromContext(options?.context ?? undefined), options);
  const suggestions: string[] = [];
  const seen = new Set<string>();
  const add = (surface: string, unit: string, route: string): boolean => {
    if (!surface.toLowerCase().startsWith(fragment)) return false;
    const prefix = leading ? `${leading} ` : "";
    const candidate = localeAdapter.buildUnitCandidate(prefix, dose, surface, route);
    const key = candidate.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    suggestions.push(candidate);
    return suggestions.length >= limit;
  };

  const customUnits = options?.unitMap;
  if (customUnits) {
    for (const surface in customUnits) {
      if (!Object.prototype.hasOwnProperty.call(customUnits, surface)) continue;
      const unit = customUnits[surface];
      if (!unit) continue;
      const pair = buildUnitRoutePairs(unit, options)[0];
      if (pair && add(surface, unit, pair.route)) return suggestions;
    }
  }

  if (localeAdapter.unitSuggestionUsesLocaleLexemes) {
    for (const lexeme of suggestionLexemes(locale)) {
      const unit = normalizeUnit(lexeme.canonical, options);
      if (!unit) continue;
      const pair = buildUnitRoutePairs(unit, options)[0] ?? { unit, route: "po" };
      if (add(lexeme.surface, unit, pair.route)) return suggestions;
    }
  } else {
    for (const pair of pairs) {
      for (const variant of getUnitVariants(pair.unit)) {
        if (add(variant.value, pair.unit, pair.route)) return suggestions;
      }
    }
  }
  return suggestions.length ? suggestions : undefined;
}

function directMultiplicativeSuggestions(input: string, limit: number): string[] | undefined {
  const match = normalizeSpacing(input).match(/^(\d+(?:\.\d+)?)x(\d*)$/i);
  if (!match) return undefined;
  const dose = match[1];
  const partial = match[2];
  const suggestions: string[] = [];
  for (const frequency of FREQUENCY_NUMBERS) {
    if (partial && !String(frequency).startsWith(partial)) continue;
    const code = FREQ_TOKEN_BY_NUMBER[frequency];
    if (code) suggestions.push(`${dose}x${frequency} po ${code}`);
    suggestions.push(`${dose}x${frequency} po pc`);
    suggestions.push(`${dose}x${frequency} po ac`);
    if (suggestions.length >= limit) break;
  }
  return suggestions.slice(0, limit);
}

function directBodySiteSuggestions(
  input: string,
  options: SuggestSigOptions | undefined,
  limit: number,
): string[] | undefined {
  const normalized = normalizeSpacing(input);
  const locale = suggestionLocale(input, options);
  const localeAdapter = getSuggestLocaleAdapter(locale);
  const match = localeAdapter.matchBodySiteInput(normalized);
  if (!match) return undefined;
  const lead = normalizeSpacing(match.lead);
  const partial = normalizeSpacing(match.partial).toLowerCase();
  const suggestions: string[] = [];
  const seen = new Set<string>();
  const add = (surface: string): boolean => {
    const clean = normalizeSpacing(surface);
    if (!clean || !localeAdapter.acceptsSurface(clean)) return false;
    const lower = clean.toLowerCase();
    if (partial && !lower.startsWith(partial)) return false;
    const candidate = localeAdapter.joinBodySite(lead, clean);
    const key = candidate.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    suggestions.push(candidate);
    return suggestions.length >= limit;
  };

  if (localeAdapter.includeEyeAbbreviations) {
    for (const abbreviation of EYE_SITE_ABBREVIATIONS) {
      if (add(abbreviation)) return suggestions;
    }
  }
  if (localeAdapter.preferRawSiteMapSurfaces) {
    for (const surface in DEFAULT_BODY_SITE_SNOMED) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_BODY_SITE_SNOMED, surface) && add(surface)) return suggestions;
    }
  }
  const localeCustomSites = options?.siteCodeMap;
  if (localeCustomSites && localeAdapter.preferRawSiteMapSurfaces) {
    for (const surface in localeCustomSites) {
      if (!Object.prototype.hasOwnProperty.call(localeCustomSites, surface)) continue;
      const definition = localeCustomSites[surface];
      if (add(surface) || (localizedValue(definition.i18n, locale) && add(localizedValue(definition.i18n, locale)!))) {
        return suggestions;
      }
      for (const alias of definition.aliases ?? []) if (add(alias)) return suggestions;
    }
  }

  for (const surface of defaultSupportedBodySiteText()) {
    if (add(surface)) return suggestions;
  }
  const customSites = options?.siteCodeMap;
  if (customSites && !localeAdapter.preferRawSiteMapSurfaces) {
    for (const surface in customSites) {
      if (!Object.prototype.hasOwnProperty.call(customSites, surface)) continue;
      const definition = customSites[surface];
      const localized = localizedValue(definition.i18n, locale);
      if (add(surface) || (definition.text && add(definition.text)) || (localized && add(localized))) {
        return suggestions;
      }
      for (const alias of definition.aliases ?? []) {
        if (add(alias)) return suggestions;
      }
    }
  }
  return suggestions.length ? suggestions : undefined;
}

function directRouteSuggestions(
  input: string,
  options: SuggestSigOptions | undefined,
  limit: number,
): string[] | undefined {
  const localeAdapter = getSuggestLocaleAdapter(suggestionLocale(input, options));
  if (!localeAdapter.routeSuggestionsEnabled) return undefined;
  const normalized = normalizeSpacing(input);
  const match = normalized.match(/^(.*\s)([^\s]+)$/);
  if (!match) return undefined;
  const base = normalizeSpacing(match[1]);
  const partial = match[2].toLowerCase();
  if (!base || !partial) return undefined;

  const baseState = parseClauseState(base, options);
  if (baseState.primaryClause.route?.code) return undefined;

  type RouteCandidate = { surface: string; code: RouteCode; rank: number };
  const byCode = new Map<RouteCode, RouteCandidate>();
  const add = (surface: string, code: RouteCode | undefined, rank: number) => {
    if (!code) return;
    const clean = normalizeSpacing(surface);
    const lower = clean.toLowerCase();
    if (!clean || !localeAdapter.acceptsSurface(clean) || !lower.startsWith(partial)) return;
    const existing = byCode.get(code);
    if (!existing || rank < existing.rank || (rank === existing.rank && clean.length < existing.surface.length)) {
      byCode.set(code, { surface: clean, code, rank });
    }
  };

  const custom = options?.routeMap;
  if (custom) {
    for (const surface in custom) {
      if (Object.prototype.hasOwnProperty.call(custom, surface)) add(surface, custom[surface], 0);
    }
  }
  for (const preferred of ["po", "oph", "inh", "in", "topical", "transdermal", "pr", "pv"]) {
    add(preferred, options?.routeMap?.[preferred] ?? DEFAULT_ROUTE_SYNONYMS[preferred]?.code, 1);
  }
  for (const surface in DEFAULT_ROUTE_SYNONYMS) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_ROUTE_SYNONYMS, surface)) continue;
    add(surface, DEFAULT_ROUTE_SYNONYMS[surface]?.code, 2);
  }

  const doseUnit = baseState.primaryClause.dose?.unit;
  const defaultRouteToken = doseUnit ? ROUTE_TOKEN_BY_UNIT.get(normalizeKey(doseUnit)) : undefined;
  const defaultRouteCode = defaultRouteToken
    ? DEFAULT_ROUTE_SYNONYMS[defaultRouteToken]?.code
    : undefined;
  const candidates = [...byCode.values()].sort((left, right) => {
    const leftPreferred = left.code === defaultRouteCode ? 0 : 1;
    const rightPreferred = right.code === defaultRouteCode ? 0 : 1;
    return leftPreferred - rightPreferred ||
      left.rank - right.rank ||
      left.surface.length - right.surface.length ||
      left.surface.localeCompare(right.surface);
  });
  const suggestions = candidates
    .slice(0, limit)
    .map((candidate) => `${base} ${candidate.surface}`);
  return suggestions.length ? suggestions : undefined;
}

function naturalEventCompletionSurfaces(): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const add = (surface: string) => {
    const clean = normalizeSpacing(surface);
    const key = clean.toLowerCase();
    if (clean && !seen.has(key)) {
      seen.add(key);
      result.push(clean);
    }
  };
  for (const surface of FOOD_EVENT_ALIASES) add(surface);
  for (const surface of SLEEP_EVENT_ALIASES) add(surface);
  for (const surface of WAKE_EVENT_ALIASES) add(surface);
  for (const surface of WHEN_TOKENS) {
    if (surface.length > 2) add(surface);
  }
  return result;
}

function relationAcceptsEventSurface(relation: string, event: string): boolean {
  const timing = EVENT_TIMING_TOKENS[event];
  const mealMap = MEAL_TIMING_BY_RELATION.get(relation as "before" | "after" | "with");
  if (timing && mealMap?.has(timing)) return true;
  if (relation === "before" && SLEEP_EVENT_ALIASES.has(event)) return true;
  if (relation === "after" && WAKE_EVENT_ALIASES.has(event)) return true;
  return false;
}

function directEnglishRelationSuggestions(
  input: string,
  options: SuggestSigOptions | undefined,
  limit: number,
): string[] | undefined {
  if (suggestionLocale(input, options) !== "en") return undefined;
  const normalized = normalizeSpacing(input);
  const words = normalized.split(" ");
  if (!words.length) return undefined;
  const relations = [...WORKFLOW_ACTION_RELATION_LEADS].filter((surface) => surface.length > 2);
  const events = naturalEventCompletionSurfaces();
  const suggestions: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string) => {
    const key = candidate.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    suggestions.push(candidate);
  };

  if (words.length >= 2 && relations.indexOf(words[words.length - 2].toLowerCase()) !== -1) {
    const relation = words[words.length - 2].toLowerCase();
    const partial = words[words.length - 1].toLowerCase();
    const base = words.slice(0, -2).join(" ");
    for (const event of events) {
      if (!event.toLowerCase().startsWith(partial) || !relationAcceptsEventSurface(relation, event)) continue;
      add(`${base} ${relation} ${event}`.trim());
      if (suggestions.length >= limit) return suggestions;
    }
    return suggestions.length ? suggestions : undefined;
  }

  const partialRelation = words[words.length - 1].toLowerCase();
  if (partialRelation.length < 3) return undefined;
  const base = words.slice(0, -1).join(" ");
  for (const relation of relations) {
    if (!relation.startsWith(partialRelation)) continue;
    for (const event of events) {
      if (!relationAcceptsEventSurface(relation, event)) continue;
      add(`${base} ${relation} ${event}`.trim());
      if (suggestions.length >= limit) return suggestions;
    }
  }
  return suggestions.length ? suggestions : undefined;
}

function directCompactRelationSuggestions(
  input: string,
  options: SuggestSigOptions | undefined,
  limit: number,
): string[] | undefined {
  const locale = suggestionLocale(input, options);
  const localeAdapter = getSuggestLocaleAdapter(locale);
  if (!localeAdapter.compactRelationSuggestions) return undefined;
  const normalized = normalizeSpacing(input);
  const lexemes = suggestionLexemes(locale);
  const relations = lexemes
    .filter((lexeme) => WORKFLOW_ACTION_RELATION_LEADS.has(lexeme.canonical))
    .sort((left, right) => right.surface.length - left.surface.length);
  const eventLexemes = lexemes.filter((lexeme) => EVENT_TIMING_TOKENS[lexeme.canonical] !== undefined);
  for (const relation of relations) {
    const index = normalized.lastIndexOf(relation.surface);
    if (index < 0) continue;
    const relationEnd = index + relation.surface.length;
    const tail = normalized.slice(relationEnd);
    if (/\s/u.test(tail)) continue;
    const prefix = normalized.slice(0, relationEnd);
    const suggestions: string[] = [];
    const seen = new Set<string>();
    for (const event of eventLexemes) {
      if (tail && !event.surface.startsWith(tail)) continue;
      const candidate = `${prefix}${event.surface}`;
      const key = candidate.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      suggestions.push(candidate);
      if (suggestions.length >= limit) break;
    }
    if (suggestions.length) return suggestions;
  }
  return undefined;
}

function directTimingSuggestions(
  input: string,
  options: SuggestSigOptions | undefined,
  limit: number,
): string[] | undefined {
  const normalized = normalizeSpacing(input);
  const match = normalized.match(/^(.*\s)([^\s]+)$/);
  if (!match) return undefined;
  const base = normalizeSpacing(match[1]);
  const partial = match[2].toLowerCase();
  if (!base || !partial) return undefined;
  const candidates = [
    ...FREQUENCY_CODES,
    ...BASE_INTERVAL_CODES,
    ...DEFAULT_INTERVAL_RANGES,
    ...WHEN_TOKENS,
    ...Object.keys(options?.freqMap ?? {}),
    ...Object.keys(options?.whenMap ?? {})
  ];
  const suggestions: string[] = [];
  const seen = new Set<string>();
  for (const token of candidates) {
    const clean = normalizeSpacing(token);
    const lower = clean.toLowerCase();
    if (!lower.startsWith(partial) || seen.has(lower)) continue;
    seen.add(lower);
    suggestions.push(`${base} ${clean}`);
    if (suggestions.length >= limit) break;
  }
  return suggestions.length ? suggestions : undefined;
}

function defaultDirectionSuggestions(
  options: SuggestSigOptions | undefined,
  limit: number,
): string[] {
  const locale = baseLanguageTag(options?.locale) ?? "en";
  const adapter = getSuggestLocaleAdapter(locale);
  const contextUnit = inferUnitFromContext(options?.context ?? undefined);
  const pairs = buildUnitRoutePairs(contextUnit, options);
  return adapter.defaultDirections(
    pairs,
    limit,
    (canonical, preferred) => localeLexemeByCanonical(locale, canonical, preferred),
    () => buildPrnReasons({ ...options, locale })
  );
}

function directTimeSuggestions(input: string, limit: number): string[] | undefined {
  const normalized = normalizeSpacing(input);
  const match = normalized.match(/^(.*?)(?:at|@)\s*(\d{1,2})(?::(\d{0,2}))?$/i);
  if (!match) return undefined;
  const leading = normalizeSpacing(match[1] ?? "");
  const hour = Number.parseInt(match[2], 10);
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return [];
  const rawMinute = match[3];
  const minute = rawMinute === undefined || rawMinute === ""
    ? "00"
    : rawMinute.length === 1
      ? `${rawMinute}0`
      : rawMinute;
  if (Number.parseInt(minute, 10) > 59) return [];
  const lead = leading ? `${leading} ` : "";
  if (hour >= 1 && hour <= 12) {
    return [`${lead}at ${hour}:${minute} am`, `${lead}at ${hour}:${minute} pm`].slice(0, limit);
  }
  return [`${lead}at ${hour < 10 ? `0${hour}` : String(hour)}:${minute}`].slice(0, limit);
}

function localeLexemePrefixSuggestions(
  input: string,
  options: SuggestSigOptions | undefined,
  limit: number,
): string[] | undefined {
  const locale = suggestionLocale(input, options);
  const normalized = normalizeSpacing(input).toLowerCase();
  if (!normalized) return undefined;
  const suggestions: string[] = [];
  const seen = new Set<string>();
  for (const lexeme of suggestionLexemes(locale)) {
    const surface = normalizeSpacing(lexeme.surface);
    const lower = surface.toLowerCase();
    if (!lower.startsWith(normalized) || seen.has(lower)) continue;
    seen.add(lower);
    suggestions.push(surface);
    if (suggestions.length >= limit) break;
  }
  return suggestions.length ? suggestions : undefined;
}

function localeLexemeTailSuggestions(
  input: string,
  options: SuggestSigOptions | undefined,
  limit: number,
): string[] | undefined {
  const locale = suggestionLocale(input, options);
  const localeAdapter = getSuggestLocaleAdapter(locale);
  if (!localeAdapter.tailLexemeSuggestionsEnabled) return undefined;
  const normalized = normalizeSpacing(input);
  const split = normalized.lastIndexOf(" ");
  if (split < 0) return undefined;
  const base = normalized.slice(0, split).trim();
  const partial = normalized.slice(split + 1).toLowerCase();
  if (!base || !partial) return undefined;

  type TailCandidate = { surface: string; candidate: string; score: number; semanticKey: string; trusted: boolean };
  const grouped = new Map<string, TailCandidate>();
  for (const lexeme of suggestionLexemes(locale)) {
    const surface = normalizeSpacing(lexeme.surface);
    if (!surface.toLowerCase().startsWith(partial)) continue;
    const days = DAY_OF_WEEK_TOKENS[surface] ?? DAY_OF_WEEK_TOKENS[lexeme.canonical];
    const event = EVENT_TIMING_TOKENS[lexeme.canonical] ?? EVENT_TIMING_TOKENS[surface];
    const cadence = FREQUENCY_ADVERB_UNITS_DATA.has(lexeme.canonical);
    const semanticKey = days?.length
      ? `day:${[...days].sort().join(",")}`
      : event
        ? `event:${event}`
        : cadence
          ? `cadence:${lexeme.canonical}`
          : `lexeme:${lexeme.canonical}`;
    const score = cadence || event ? 3 : days?.length ? 2 : 0;
    const entry: TailCandidate = {
      surface,
      candidate: `${base} ${surface}`,
      score,
      semanticKey,
      trusted: Boolean(cadence || event || days?.length)
    };
    const existing = grouped.get(semanticKey);
    if (!existing || surface.length > existing.surface.length) {
      grouped.set(semanticKey, entry);
    }
  }

  const ranked = [...grouped.values()].sort((left, right) =>
    right.score - left.score || left.candidate.length - right.candidate.length
  );
  const hasSemanticCompletions = ranked.some((entry) => entry.score > 0);
  const suggestions: string[] = [];
  for (const entry of ranked) {
    if (hasSemanticCompletions && entry.score === 0) continue;
    if (!entry.trusted && !parserAcceptsSuggestion(entry.candidate, options)) continue;
    suggestions.push(entry.candidate);
    if (suggestions.length >= limit) break;
  }
  return suggestions.length ? suggestions : undefined;
}

function actionPrefixSuggestions(
  input: string,
  options: SuggestSigOptions | undefined,
  limit: number,
): string[] | undefined {
  const normalized = normalizeSpacing(input);
  if (!normalized) return undefined;
  const locale = suggestionLocale(input, options);
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | undefined) => {
    const clean = normalizeSpacing(value ?? "");
    if (!clean || !getSuggestLocaleAdapter(locale).acceptsSurface(clean)) return;
    const key = clean.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(clean);
    }
  };
  for (const definition of DEFAULT_SUGGESTION_ACTIONS) {
    if (definition.argumentParser === "preposed-duration") continue;
    if (locale === "en") push(definition.display.toLowerCase());
    for (const alias of localizedConfig(definition.localeAliases, locale) ?? []) push(alias);
    for (const alias of definition.aliases ?? []) push(alias);
  }
  const customActions = options?.instructionActionMap;
  if (customActions) {
    for (const surface in customActions) {
      if (!Object.prototype.hasOwnProperty.call(customActions, surface)) continue;
      const definition = customActions[surface];
      if (definition.argumentParser === "preposed-duration") continue;
      push(surface);
      if (locale === "en") push(definition.display);
      for (const alias of localizedConfig(definition.localeAliases, locale) ?? []) push(alias);
      for (const alias of definition.aliases ?? []) push(alias);
    }
  }
  const lower = normalized.toLowerCase();
  const matches = candidates.filter((candidate) => candidate.toLowerCase().startsWith(lower));
  return matches.length ? matches.slice(0, limit) : undefined;
}

function actionSurfaceMatchesInput(surface: string, normalizedInput: string): boolean {
  const candidate = normalizeSpacing(surface).toLowerCase();
  if (!candidate) return false;
  return normalizedInput === candidate || normalizedInput.startsWith(`${candidate} `) ||
    (NON_ASCII_SCRIPT.test(candidate) && normalizedInput.startsWith(candidate));
}

function suggestionActionDefinitionForClause(
  input: string,
  clause: ReturnType<typeof parseClauseState>["primaryClause"],
  options?: SuggestSigOptions,
) {
  const normalized = normalizeSpacing(input).toLowerCase();

  // Surface identity is stronger than Dosage.method coding: several distinct
  // actions can legitimately project the same administration method code.
  const customActions = options?.instructionActionMap;
  if (customActions) {
    for (const surface in customActions) {
      if (!Object.prototype.hasOwnProperty.call(customActions, surface)) continue;
      const definition = customActions[surface];
      const locale = suggestionLocale(input, options);
      const surfaces = [
        surface,
        definition.display,
        localizedValue(definition.i18n, locale),
        ...(localizedConfig(definition.localeAliases, locale) ?? []),
        ...(definition.aliases ?? [])
      ].filter((value): value is string => Boolean(value))
        .sort((left, right) => right.length - left.length);
      if (surfaces.some((candidate) => actionSurfaceMatchesInput(candidate, normalized))) return definition;
    }
  }

  const defaultBySurface = DEFAULT_SUGGESTION_ACTION_SURFACES.find(({ surface }) =>
    actionSurfaceMatchesInput(surface, normalized)
  )?.definition;
  if (defaultBySurface) return defaultBySurface;

  const methodCode = clause.method?.coding?.code;
  if (!methodCode) return undefined;
  return DEFAULT_SUGGESTION_ACTIONS.find(
    (definition) => definition.administrationMethod?.code === methodCode,
  );
}

function trajectoryUnitForRoute(
  routeCode: RouteCode | undefined,
  options: SuggestSigOptions | undefined,
): string | undefined {
  const contextUnit = inferUnitFromContext(options?.context ?? undefined);
  const pairs = buildUnitRoutePairs(contextUnit, options);
  if (routeCode) {
    const matched = pairs.find((pair) =>
      (options?.routeMap?.[pair.route] ?? DEFAULT_ROUTE_SYNONYMS[pair.route]?.code) === routeCode
    );
    if (matched) return matched.unit;
  }
  return contextUnit ?? pairs[0]?.unit;
}

function trajectoryScheduleSuffixes(
  locale: string,
  routeCode?: RouteCode
): string[] {
  const adapter = getSuggestLocaleAdapter(locale);
  return adapter.trajectoryScheduleSuffixes(
    routeCode,
    (canonical, preferred) => localeLexemeByCanonical(locale, canonical, preferred)
  );
}

function representativePrnReason(
  options: SuggestSigOptions | undefined,
  locale: string,
  topical: boolean,
): string | undefined {
  const reasons = buildPrnReasons({ ...options, locale });
  for (const wanted of getSuggestLocaleAdapter(locale).preferredPrnReasons(topical)) {
    const match = reasons.find((reason) => normalizeKey(reason) === normalizeKey(wanted));
    if (match) return match;
  }
  return reasons[0];
}

function hasCustomTrajectoryVocabulary(options: SuggestSigOptions | undefined): boolean {
  return Boolean(options && (
    options.context || options.unitMap || options.routeMap || options.siteCodeMap ||
    options.freqMap || options.whenMap || options.prnReasonMap || options.symptomMap ||
    options.instructionActionMap || options.instructionConceptMap || options.prnReasons?.length
  ));
}

function mergeSuggestionLists(primary: string[], extra: string[], limit: number): string[] {
  const result = primary.slice(0, limit);
  const seen = new Set(result.map((value) => normalizeSpacing(value).toLowerCase()));
  for (const candidate of extra) {
    if (result.length >= limit) break;
    const key = normalizeSpacing(candidate).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function semanticTrajectorySuggestions(
  input: string,
  options: SuggestSigOptions | undefined,
  limit: number,
  parsedState?: ReturnType<typeof parseClauseState>,
): string[] {
  const normalized = normalizeSpacing(input);
  const state = parsedState ?? parseClauseState(normalized, options);
  const clause = state.primaryClause;
  if (clause.leftovers?.length || findUnparsedTokenGroups(state).length) return [];
  const hasMethod = Boolean(clause.method?.text || clause.method?.coding?.code);
  const hasAdministrationAnchor = hasMethod || Boolean(clause.dose && clause.route?.code);
  if (!hasAdministrationAnchor) return [];

  const locale = suggestionLocale(input, options);
  const localeAdapter = getSuggestLocaleAdapter(locale);
  const routeCode = clause.route?.code;
  const topical = routeCode === RouteCode["Topical route"];
  const actionDefinition = suggestionActionDefinitionForClause(normalized, clause, options);
  const supportsDose = actionDefinition?.definesDose === true || actionDefinition?.acceptsAmount === true;
  const actionOnly = (clause.evidence ?? []).length > 0 &&
    (clause.evidence ?? []).every((evidence) => evidence.rule === "hpsg.lex.method");

  const suggestions: string[] = [];
  const seen = new Set<string>();
  const push = (candidate: string | undefined) => {
    const clean = normalizeSpacing(candidate ?? "");
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    // Default trajectories are assembled from parser-owned grammar/vocabulary and
    // stay on the cheap path. Caller-supplied vocabulary can change what is legal,
    // so validate those assembled candidates against the same configured parser.
    if (hasCustomTrajectoryVocabulary(options) && !parserAcceptsSuggestion(clean, options)) return;
    seen.add(key);
    suggestions.push(clean);
  };

  push(normalized);

  if (topical && !clause.site) {
    const directSite = medicationInstructionActionLocaleRealizerConfig(
      actionDefinition?.realizerConfig,
      locale
    )?.directSiteObject === true;
    push(localeAdapter.appendAffectedArea(normalized, directSite));
  }

  let doseCandidate: string | undefined;
  if (supportsDose && !clause.dose) {
    const contextUnit = inferUnitFromContext(options?.context ?? undefined);
    const unit = routeCode || contextUnit ? trajectoryUnitForRoute(routeCode, options) : undefined;
    if (unit) {
      const unitSurface = localeAdapter.unitSurface(
        unit,
        (canonical, preferred) => localeLexemeByCanonical(locale, canonical, preferred)
      );
      doseCandidate = `${normalized} 1 ${unitSurface}`;
      push(doseCandidate);
      if (!clause.schedule) {
        push(`${doseCandidate} ${trajectoryScheduleSuffixes(locale, routeCode)[0]}`);
      }
    }
  }

  // Once the clinician has started a nontrivial dose construction (for example
  // a locale-specific incomplete dose construction), finish that slot before unrelated timing branches.
  if (supportsDose && !clause.dose && !actionOnly) {
    return suggestions.slice(0, limit);
  }

  if (!clause.schedule) {
    for (const suffix of trajectoryScheduleSuffixes(locale, routeCode)) {
      push(`${normalized} ${suffix}`);
      if (suggestions.length >= limit) break;
    }
  }

  if (!clause.prn?.enabled && suggestions.length < limit &&
    (routeCode === RouteCode["Oral route"] || topical)) {
    const reason = representativePrnReason(options, locale, topical);
    if (reason) {
      push(localeAdapter.appendPrn(normalized, reason));
    }
  }

  return suggestions.slice(0, limit);
}

function continueExactSemanticSuggestion(
  direct: string[],
  input: string,
  options: SuggestSigOptions | undefined,
  limit: number,
): string[] {
  const normalized = normalizeSpacing(input);
  if (!direct.some((candidate) => normalizeSpacing(candidate).toLowerCase() === normalized.toLowerCase())) {
    return direct.slice(0, limit);
  }
  const state = parseClauseState(normalized, options);
  if (state.primaryClause.leftovers?.length || findUnparsedTokenGroups(state).length) {
    return direct.slice(0, limit);
  }
  const trajectories = semanticTrajectorySuggestions(normalized, options, limit, state);
  return trajectories.length > 1
    ? mergeSuggestionLists(direct, trajectories, limit)
    : direct.slice(0, limit);
}

function enrichDirectSuggestions(
  direct: string[],
  options: SuggestSigOptions | undefined,
  limit: number,
): string[] {
  if (direct.length >= limit || direct.length > 3) return direct.slice(0, limit);
  const suggestions = [...direct];
  const seen = new Set(direct.map((value) => normalizeSpacing(value).toLowerCase()));
  for (const base of direct.slice(0, 2)) {
    for (const candidate of semanticTrajectorySuggestions(base, options, limit)) {
      const key = normalizeSpacing(candidate).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      suggestions.push(candidate);
      if (suggestions.length >= limit) return suggestions;
    }
  }
  return suggestions;
}

function semanticFastPath(
  input: string,
  options: SuggestSigOptions | undefined,
  limit: number,
): string[] | undefined {
  const state = parseClauseState(input, options);
  const clause = state.primaryClause;
  if (clause.leftovers?.length || findUnparsedTokenGroups(state).length) return undefined;
  const hasMethod = Boolean(clause.method?.text || clause.method?.coding?.code);
  const richAdministration = Boolean(
    clause.dose && clause.route?.code && (clause.schedule || clause.prn?.enabled || clause.site)
  );
  if (!hasMethod && !richAdministration) return undefined;
  const normalized = normalizeSpacing(input);
  const locale = suggestionLocale(input, options);

  if (hasMethod && clause.dose?.value !== undefined && !clause.dose.unit) {
    const inferredUnit =
      (clause.route?.code ? DEFAULT_UNIT_BY_ROUTE[clause.route.code] : undefined) ??
      inferUnitFromContext(options?.context ?? undefined);
    if (inferredUnit) {
      const unitSurface = getSuggestLocaleAdapter(locale).unitSurface(
        inferredUnit,
        (canonical, preferred) => localeLexemeByCanonical(locale, canonical, preferred)
      );
      const completed = `${normalized} ${unitSurface}`;
      const completedState = parserAcceptsSuggestion(completed, options);
      if (completedState) {
        const trajectories = semanticTrajectorySuggestions(completed, options, limit, completedState);
        return trajectories.length ? trajectories : [completed];
      }
    }
  }

  const trajectories = semanticTrajectorySuggestions(normalized, options, limit, state);
  return trajectories.length ? trajectories : undefined;
}

export function suggestSig(input: string, options?: SuggestSigOptions): string[] {
  const limit = options?.limit ?? DEFAULT_LIMIT;
  if (limit <= 0) {
    return [];
  }
  const prefix = normalizeSpacing(input.toLowerCase());
  if (!prefix) {
    return defaultDirectionSuggestions(options, limit);
  }

  const directLocalePrn = directLocalePrnReasonSuggestions(input, options, limit);
  if (directLocalePrn?.length) {
    return continueExactSemanticSuggestion(directLocalePrn, input, options, limit);
  }
  const directPrn = directPrnReasonSuggestions(input, options, limit);
  if (directPrn?.length) {
    return continueExactSemanticSuggestion(directPrn, input, options, limit);
  }
  const directTime = directTimeSuggestions(input, limit);
  if (directTime?.length) {
    return continueExactSemanticSuggestion(directTime, input, options, limit);
  }
  const inputTokens = normalizeSpacing(input).split(" ");
  const lastToken = inputTokens[inputTokens.length - 1];
  if (lastToken && normalizeUnit(lastToken, options)) {
    const state = parseClauseState(input, options);
    if (!state.primaryClause.leftovers?.length && findUnparsedTokenGroups(state).length === 0) {
      const trajectories = semanticTrajectorySuggestions(input, options, limit, state);
      if (trajectories.length > 1) return trajectories;
    }
  }
  const directUnit = directUnitSuggestions(input, options, limit);
  if (directUnit?.length) {
    return enrichDirectSuggestions(directUnit, options, limit);
  }
  const directMultiplicative = directMultiplicativeSuggestions(input, limit);
  if (directMultiplicative?.length) {
    return directMultiplicative;
  }
  const compactOralSuggestions = suggestCompactOralMealTiming(prefix, limit);
  if (compactOralSuggestions?.length) {
    return compactOralSuggestions;
  }
  if (options?.enableMealDashSyntax) {
    const mealDashSuggestions = suggestMealDashSyntax(prefix, limit);
    if (mealDashSuggestions?.length) {
      return mealDashSuggestions;
    }
  }

  const directSite = directBodySiteSuggestions(input, options, limit);
  if (directSite?.length) {
    return continueExactSemanticSuggestion(directSite, input, options, limit);
  }
  const directRoute = directRouteSuggestions(input, options, limit);
  if (directRoute?.length) {
    return continueExactSemanticSuggestion(directRoute, input, options, limit);
  }
  const directCompactRelation = directCompactRelationSuggestions(input, options, limit);
  if (directCompactRelation?.length) {
    return continueExactSemanticSuggestion(directCompactRelation, input, options, limit);
  }
  const directEnglishRelation = directEnglishRelationSuggestions(input, options, limit);
  if (directEnglishRelation?.length) {
    return continueExactSemanticSuggestion(directEnglishRelation, input, options, limit);
  }
  const directTiming = directTimingSuggestions(input, options, limit);
  if (directTiming?.length) {
    return continueExactSemanticSuggestion(directTiming, input, options, limit);
  }

  const semantic = semanticFastPath(input, options, limit);
  if (semantic?.length) {
    return semantic;
  }
  const localeTail = localeLexemeTailSuggestions(input, options, limit);
  if (localeTail?.length) {
    return enrichDirectSuggestions(localeTail, options, limit);
  }
  const actions = actionPrefixSuggestions(input, options, limit);
  if (actions?.length) {
    return enrichDirectSuggestions(actions, options, limit);
  }
  const localeLexemes = localeLexemePrefixSuggestions(input, options, limit);
  if (localeLexemes?.length) {
    return enrichDirectSuggestions(localeLexemes, options, limit);
  }

  return [];
}
