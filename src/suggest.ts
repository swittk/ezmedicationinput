import { inferUnitFromContext } from "./context";
import { listSupportedBodySiteText } from "./body-site-lookup";
import { listMedicationInstructionActions } from "./instruction-action-terminology";
import { listMedicationLocaleLexemes } from "./lexer/locale";
import { findUnparsedTokenGroups, parseClauseState } from "./parser";
import {
  DEFAULT_PRN_REASON_DEFINITIONS,
  DEFAULT_ROUTE_SYNONYMS,
  DEFAULT_UNIT_BY_ROUTE,
  DEFAULT_UNIT_SYNONYMS,
  EVENT_TIMING_TOKENS,
  HOUSEHOLD_VOLUME_UNITS,
  ROUTE_TEXT,
  TIMING_ABBREVIATIONS,
} from "./maps";
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

function buildPrnReasons(options?: SuggestSigOptions): string[] {
  const reasons = new Set<string>();
  const thai = options?.locale?.toLowerCase().startsWith("th") === true;

  const add = (reason: string | undefined) => {
    if (!reason) return;
    const normalized = normalizeSpacing(reason.toLowerCase());
    if (!normalized || (thai ? !THAI_SCRIPT.test(normalized) : THAI_SCRIPT.test(normalized))) return;
    reasons.add(normalized);
  };

  // Explicit caller vocabulary ranks first.
  for (const reason of options?.prnReasons ?? []) add(reason);

  const custom = options?.prnReasonMap;
  if (custom) {
    for (const surface in custom) {
      if (!Object.prototype.hasOwnProperty.call(custom, surface)) continue;
      const definition = custom[surface];
      add(thai ? definition.conditionI18n?.th ?? definition.i18n?.th : definition.text ?? surface);
      add(surface);
      for (const alias of definition.aliases ?? []) add(alias);
    }
  }

  // Canonical parser-terminology labels rank ahead of their many aliases.
  for (const surface in DEFAULT_PRN_REASON_DEFINITIONS) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_PRN_REASON_DEFINITIONS, surface)) continue;
    const definition = DEFAULT_PRN_REASON_DEFINITIONS[surface];
    add(thai ? definition.conditionI18n?.th ?? definition.i18n?.th : definition.text ?? surface);
  }
  for (const surface in DEFAULT_PRN_REASON_DEFINITIONS) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_PRN_REASON_DEFINITIONS, surface)) continue;
    add(surface);
  }

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

const THAI_SCRIPT = /[\u0E00-\u0E7F]/u;

function suggestionLocale(input: string, options?: SuggestSigOptions): "th" | "en" {
  return options?.locale?.toLowerCase().startsWith("th") || THAI_SCRIPT.test(input) ? "th" : "en";
}

function directThaiPrnReasonSuggestions(
  input: string,
  options: SuggestSigOptions | undefined,
  limit: number,
): string[] | undefined {
  if (suggestionLocale(input, options) !== "th") return undefined;
  const normalized = normalizeSpacing(input);
  const markerIndex = normalized.lastIndexOf("เมื่อ");
  if (markerIndex < 0) return undefined;
  const before = normalized.slice(0, markerIndex + "เมื่อ".length);
  let tail = normalized.slice(markerIndex + "เมื่อ".length);
  let symptomLead = "";
  if (tail.startsWith("มีอาการ")) {
    symptomLead = "มีอาการ";
    tail = tail.slice(symptomLead.length);
  }
  const partial = tail.toLowerCase();
  const suggestions: string[] = [];
  const seen = new Set<string>();
  for (const reason of buildPrnReasons({ ...options, locale: "th" })) {
    let surface = reason;
    if (symptomLead && surface.startsWith(symptomLead)) {
      surface = surface.slice(symptomLead.length);
    }
    if (partial && !surface.toLowerCase().startsWith(partial)) continue;
    const candidate = `${before}${symptomLead}${surface}`;
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push(candidate);
    if (suggestions.length >= limit) break;
  }
  return suggestions.length ? suggestions : undefined;
}

function localeLexemeByCanonical(locale: string, canonical: string, preferred?: string): string | undefined {
  const matches = listMedicationLocaleLexemes(locale).filter((lexeme) => lexeme.canonical === canonical);
  if (preferred) {
    const exact = matches.find((lexeme) => lexeme.surface === preferred);
    if (exact) return exact.surface;
  }
  return matches.sort((left, right) => left.surface.length - right.surface.length)[0]?.surface;
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
  const match = normalized.match(/^(\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)\s+([^\s]+)$/i);
  if (!match) return undefined;
  const dose = match[1];
  const fragment = match[2].toLowerCase();
  if (/^(?:po|prn|q\d|qd|od|bid|tid|qid)$/i.test(fragment)) return undefined;
  const pairs = buildUnitRoutePairs(inferUnitFromContext(options?.context ?? undefined), options);
  const suggestions: string[] = [];
  const seen = new Set<string>();
  const add = (surface: string, unit: string, route: string): boolean => {
    if (!surface.toLowerCase().startsWith(fragment)) return false;
    const candidate = `${dose} ${surface} ${route} qd`;
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

  for (const pair of pairs) {
    for (const variant of getUnitVariants(pair.unit)) {
      if (!variant.lower.startsWith(fragment)) continue;
      if (add(variant.value, pair.unit, pair.route)) return suggestions;
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
  const match = normalized.match(/^(.*(?:\bto|\bat|\bon|\bin|\binto|ที่|บริเวณ))\s*([^\s]*)$/iu);
  if (!match) return undefined;
  const lead = normalizeSpacing(match[1]);
  const partial = (match[2] ?? "").toLowerCase();
  const thai = suggestionLocale(input, options) === "th";
  const vocabulary = listSupportedBodySiteText({
    siteCodeMap: options?.siteCodeMap,
    bodySiteContext: options?.context?.bodySiteContext
  });
  const suggestions: string[] = [];
  const seen = new Set<string>();
  for (const surface of vocabulary) {
    const clean = normalizeSpacing(surface);
    if (!clean || (thai ? !THAI_SCRIPT.test(clean) : THAI_SCRIPT.test(clean))) continue;
    const lower = clean.toLowerCase();
    if (partial && !lower.startsWith(partial)) continue;
    const candidate = `${lead} ${clean}`;
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push(candidate);
    if (suggestions.length >= limit) break;
  }
  return suggestions.length ? suggestions : undefined;
}

function directRouteSuggestions(
  input: string,
  options: SuggestSigOptions | undefined,
  limit: number,
): string[] | undefined {
  const normalized = normalizeSpacing(input);
  const match = normalized.match(/^(.*\s)([^\s]+)$/);
  if (!match) return undefined;
  const base = normalizeSpacing(match[1]);
  const partial = match[2].toLowerCase();
  if (!base || !partial || THAI_SCRIPT.test(partial)) return undefined;
  const surfaces: string[] = [];
  const seenSurface = new Set<string>();
  const addSurface = (surface: string) => {
    const clean = normalizeSpacing(surface);
    const lower = clean.toLowerCase();
    if (!clean || seenSurface.has(lower)) return;
    seenSurface.add(lower);
    surfaces.push(clean);
  };
  for (const preferred of ["po", "oph", "inh", "in", "topical", "transdermal", "pr", "pv"]) {
    if (DEFAULT_ROUTE_SYNONYMS[preferred] || options?.routeMap?.[preferred]) addSurface(preferred);
  }
  const custom = options?.routeMap;
  if (custom) {
    for (const surface in custom) {
      if (Object.prototype.hasOwnProperty.call(custom, surface)) addSurface(surface);
    }
  }
  for (const surface in DEFAULT_ROUTE_SYNONYMS) {
    if (Object.prototype.hasOwnProperty.call(DEFAULT_ROUTE_SYNONYMS, surface)) addSurface(surface);
  }
  const suggestions: string[] = [];
  for (const surface of surfaces) {
    if (!surface.toLowerCase().startsWith(partial)) continue;
    suggestions.push(`${base} ${surface}`);
    if (suggestions.length >= limit) break;
  }
  return suggestions.length ? suggestions : undefined;
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
  const locale = options?.locale?.toLowerCase().startsWith("th") ? "th" : "en";
  const contextUnit = inferUnitFromContext(options?.context ?? undefined);
  const pairs = buildUnitRoutePairs(contextUnit, options);
  if (locale === "th") {
    const unit = pairs[0]?.unit ?? "tab";
    const take = listMedicationInstructionActions()
      .find((definition) => definition.code === "take")?.i18n?.th ??
      localeLexemeByCanonical("th", "take") ?? "รับประทาน";
    const unitSurface = localeLexemeByCanonical("th", unit) ?? unit;
    const onceDaily = localeLexemeByCanonical("th", "daily", "วันละครั้ง") ?? "วันละครั้ง";
    const daily = localeLexemeByCanonical("th", "daily", "วันละ") ?? "วันละ";
    const times = localeLexemeByCanonical("th", "times", "ครั้ง") ?? "ครั้ง";
    const firstReason = buildPrnReasons({ ...options, locale: "th" })[0];
    const suggestions = [
      `${take} 1 ${unitSurface} ${onceDaily}`,
      `${take} 1 ${unitSurface} ${daily} 2 ${times}`,
      firstReason ? `${take} 1 ${unitSurface} เมื่อ${firstReason}` : undefined
    ].filter((value): value is string => Boolean(value));
    return suggestions.slice(0, limit);
  }

  const suggestions: string[] = [];
  const seen = new Set<string>();
  for (const pair of pairs.slice(0, 4)) {
    for (const dose of ["1", "2"]) {
      for (const code of FREQUENCY_CODES.slice(0, 4)) {
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
  for (const lexeme of listMedicationLocaleLexemes(locale)) {
    const surface = normalizeSpacing(lexeme.surface);
    const lower = surface.toLowerCase();
    if (!lower.startsWith(normalized) || seen.has(lower)) continue;
    seen.add(lower);
    suggestions.push(surface);
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
    if (!clean || (locale === "th" ? !THAI_SCRIPT.test(clean) : THAI_SCRIPT.test(clean))) return;
    const key = clean.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(clean);
    }
  };
  for (const definition of listMedicationInstructionActions()) {
    push(locale === "th" ? definition.i18n?.th : definition.display.toLowerCase());
    for (const alias of definition.aliases ?? []) push(alias);
  }
  const customActions = options?.instructionActionMap;
  if (customActions) {
    for (const surface in customActions) {
      if (!Object.prototype.hasOwnProperty.call(customActions, surface)) continue;
      const definition = customActions[surface];
      push(surface);
      push(locale === "th" ? definition.i18n?.th : definition.display);
      for (const alias of definition.aliases ?? []) push(alias);
    }
  }
  const lower = normalized.toLowerCase();
  const matches = candidates.filter((candidate) => candidate.toLowerCase().startsWith(lower));
  return matches.length ? matches.slice(0, limit) : undefined;
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
  const suggestions = [normalized];
  if (hasMethod && !clause.schedule && suggestions.length < limit) {
    suggestions.push(`${normalized} ${suggestionLocale(input, options) === "th" ? "วันละครั้ง" : "once daily"}`);
  }
  return suggestions.slice(0, limit);
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

  const directThaiPrn = directThaiPrnReasonSuggestions(input, options, limit);
  if (directThaiPrn?.length) {
    return directThaiPrn;
  }
  const directPrn = directPrnReasonSuggestions(input, options, limit);
  if (directPrn?.length) {
    return directPrn;
  }
  const directTime = directTimeSuggestions(input, limit);
  if (directTime?.length) {
    return directTime;
  }
  const directUnit = directUnitSuggestions(input, options, limit);
  if (directUnit?.length) {
    return directUnit;
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
    return directSite;
  }
  const directRoute = directRouteSuggestions(input, options, limit);
  if (directRoute?.length) {
    return directRoute;
  }
  const directTiming = directTimingSuggestions(input, options, limit);
  if (directTiming?.length) {
    return directTiming;
  }

  const semantic = semanticFastPath(input, options, limit);
  if (semantic?.length) {
    return semantic;
  }
  const actions = actionPrefixSuggestions(input, options, limit);
  if (actions?.length) {
    return actions;
  }
  const localeLexemes = localeLexemePrefixSuggestions(input, options, limit);
  if (localeLexemes?.length) {
    return localeLexemes;
  }

  return [];
}
