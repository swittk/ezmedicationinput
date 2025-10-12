import { inferUnitFromContext } from "./context";
import {
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
  routeLower: string;
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

const WHEN_COMBINATIONS = [
  "am",
  "morning",
  "morn",
  "noon",
  "afternoon",
  "pm",
  "evening",
  "night",
  "hs",
  "bedtime",
].filter((token) => EVENT_TIMING_TOKENS[token] !== undefined);

const CORE_WHEN_TOKENS = ["pc", "ac", "hs"].filter(
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

const DEFAULT_PRN_REASONS = [
  "pain",
  "nausea",
  "itching",
  "anxiety",
  "sleep",
  "cough",
  "fever",
  "spasm",
  "constipation",
  "dyspnea",
];
const DEFAULT_DOSE_COUNTS = ["1", "2"];
const OPTIONAL_MATCH_TOKENS = new Set([
  "to",
  "into",
  "in",
  "on",
  "onto",
  "per",
  "for",
  "the",
  "od",
  "os",
  "ou",
]);

const ROUTE_TOKEN_FRAGMENTS = new Set<string>();
for (const phrase of Object.keys(DEFAULT_ROUTE_SYNONYMS)) {
  for (const fragment of phrase.split(/\s+/)) {
    const normalized = fragment.trim();
    if (normalized) {
      ROUTE_TOKEN_FRAGMENTS.add(normalized);
    }
  }
}

const SKIPPABLE_CANDIDATE_TOKENS = new Set<string>([
  ...Array.from(OPTIONAL_MATCH_TOKENS),
  ...Array.from(ROUTE_TOKEN_FRAGMENTS),
]);

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

function removeWhitespaceCharacters(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 32) {
      const result: string[] = [];
      for (let inner = 0; inner < value.length; inner += 1) {
        const currentCode = value.charCodeAt(inner);
        if (currentCode > 32) {
          result.push(value.charAt(inner));
        }
      }
      return result.join("");
    }
  }
  return value;
}

function removeDashes(value: string): string {
  if (value.indexOf("-") === -1) {
    return value;
  }
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index);
    if (char !== "-") {
      result.push(char);
    }
  }
  return result.join("");
}

function getUnitVariants(unit: string): UnitVariant[] {
  const canonical = resolveCanonicalUnit(unit) ?? normalizeSpacing(unit);
  const normalizedCanonical = normalizeKey(canonical);
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

  return [...variants.values()];
}

function buildIntervalTokens(input: string): string[] {
  const intervals = new Set<string>();

  const add = (token: string | undefined) => {
    if (!token) {
      return;
    }
    const normalized = token.trim().toLowerCase();
    if (!normalized) {
      return;
    }
    intervals.add(normalized);
  };

  for (const token of BASE_INTERVAL_CODES) {
    add(token);
  }
  for (const token of DEFAULT_INTERVAL_RANGES) {
    add(token);
  }

  const normalizedInput = input.toLowerCase();
  const rawTokens = normalizedInput.split(/[^a-z0-9-]+/g);
  for (const rawToken of rawTokens) {
    if (!rawToken) {
      continue;
    }
    const match = rawToken.match(/^q(\d{1,2})(?:-(\d{1,2}))?(h?)$/);
    if (!match) {
      continue;
    }
    const first = Number.parseInt(match[1], 10);
    const second = match[2] ? Number.parseInt(match[2], 10) : undefined;
    if (Number.isNaN(first) || first <= 0 || first > 48) {
      continue;
    }
    if (second !== undefined) {
      if (Number.isNaN(second) || second < first || second > 48) {
        continue;
      }
    }
    const normalized = `q${first}${second ? `-${second}` : ""}h`;
    add(normalized);
  }

  return [...intervals];
}

function buildWhenSequences(): string[][] {
  const sequences: string[][] = [];
  for (const token of WHEN_TOKENS) {
    sequences.push([token]);
  }

  for (let i = 0; i < WHEN_COMBINATIONS.length; i++) {
    const first = WHEN_COMBINATIONS[i];
    for (let j = i + 1; j < WHEN_COMBINATIONS.length; j++) {
      const second = WHEN_COMBINATIONS[j];
      sequences.push([first, second]);
    }
  }

  return sequences;
}

const PRECOMPUTED_WHEN_SEQUENCES = buildWhenSequences();

function tokenizeLowercaseForMatching(value: string): string[] {
  return value
    .split(/\s+/)
    .map((token) => token.replace(/^[^a-z0-9-]+|[^a-z0-9-]+$/g, ""))
    .filter((token) => token.length > 0)
    .filter((token) => !OPTIONAL_MATCH_TOKENS.has(token));
}

function tokenizeForMatching(value: string): string[] {
  return tokenizeLowercaseForMatching(value.toLowerCase());
}

function canonicalizeLowercaseForMatching(value: string): string {
  return tokenizeLowercaseForMatching(value).join(" ");
}

function canonicalizeForMatching(value: string): string {
  return canonicalizeLowercaseForMatching(value.toLowerCase());
}

function tokensMatch(
  prefixTokens: readonly string[],
  candidateTokens: readonly string[],
): boolean {
  if (prefixTokens.length === 0) {
    return true;
  }

  let prefixIndex = 0;
  for (const candidateToken of candidateTokens) {
    if (prefixIndex >= prefixTokens.length) {
      return true;
    }
    const prefixToken = prefixTokens[prefixIndex];
    if (candidateToken.startsWith(prefixToken)) {
      prefixIndex += 1;
      if (prefixIndex >= prefixTokens.length) {
        return true;
      }
      continue;
    }
    if (!SKIPPABLE_CANDIDATE_TOKENS.has(candidateToken)) {
      return false;
    }
  }

  return prefixIndex >= prefixTokens.length;
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
    pairs.push({ unit: canonicalUnit, route: cleanRoute, routeLower });
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

function buildPrnReasons(customReasons: readonly string[] | undefined): string[] {
  const reasons = new Set<string>();

  const add = (reason: string | undefined) => {
    if (!reason) {
      return;
    }
    const normalized = normalizeSpacing(reason.toLowerCase());
    if (!normalized) {
      return;
    }
    reasons.add(normalized);
  };

  if (customReasons) {
    for (const reason of customReasons) {
      add(reason);
    }
  }

  for (const reason of DEFAULT_PRN_REASONS) {
    add(reason);
  }

  return [...reasons];
}

function extractDoseValuesFromInput(input: string): string[] {
  const matches = input.match(/\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?/g);
  if (!matches) {
    return [];
  }

  const values = new Set<string>();
  for (const match of matches) {
    if (!match) {
      continue;
    }
    values.add(match);
  }

  return [...values];
}

function buildDoseValues(input: string): string[] {
  const dynamicValues = extractDoseValuesFromInput(input);
  const values = new Set<string>();
  for (const value of dynamicValues) {
    values.add(value);
  }
  for (const value of DEFAULT_DOSE_COUNTS) {
    values.add(value);
  }
  return [...values];
}

type CandidateMatcher = (candidate: string, candidateLower: string) => boolean;

interface CandidateFingerprint {
  compact?: string;
  noDashes?: string;
  tokens?: string[];
  canonical?: string;
  canonicalCompact?: string;
  canonicalNoDashes?: string;
  tokensNoDashes?: string[];
}

const CANDIDATE_FINGERPRINT_CACHE = new Map<string, CandidateFingerprint>();

function getCandidateFingerprint(candidateLower: string): CandidateFingerprint {
  let fingerprint = CANDIDATE_FINGERPRINT_CACHE.get(candidateLower);
  if (!fingerprint) {
    fingerprint = {};
    CANDIDATE_FINGERPRINT_CACHE.set(candidateLower, fingerprint);
  }
  return fingerprint;
}

interface PrefixMatchContext {
  raw: string;
  compact: string;
  noDashes: string;
  canonical: string;
  canonicalCompact: string;
  canonicalNoDashes: string;
  tokens: readonly string[];
  tokensNoDashes: readonly string[];
  hasCanonical: boolean;
  hasTokens: boolean;
  requiresCompact: boolean;
  requiresNoDashes: boolean;
  requiresCanonicalCompact: boolean;
  requiresCanonicalNoDashes: boolean;
  requiresTokenNoDashes: boolean;
}

function generateCandidateDirections(
  pairs: UnitRoutePair[],
  doseValues: readonly string[],
  prnReasons: readonly string[],
  intervalTokens: readonly string[],
  whenSequences: readonly string[][],
  limit: number,
  matcher: CandidateMatcher,
): string[] {
  const suggestions: string[] = [];
  const seen = new Set<string>();
  const doseVariantMap = new Map<string, UnitVariant>();
  for (const dose of doseValues) {
    const normalized = normalizeSpacing(dose);
    if (!normalized) {
      continue;
    }
    const lower = normalized.toLowerCase();
    if (!doseVariantMap.has(lower)) {
      doseVariantMap.set(lower, { value: normalized, lower });
    }
  }
  const doseVariants = [...doseVariantMap.values()];

  const push = (value: string, lower: string): boolean => {
    if (!lower) {
      return false;
    }
    if (seen.has(lower)) {
      return false;
    }
    if (!matcher(value, lower)) {
      return false;
    }
    seen.add(lower);
    suggestions.push(value);
    return suggestions.length >= limit;
  };

  for (const pair of pairs) {
    const unitVariants = getUnitVariants(pair.unit);
    const route = pair.route;
    const routeLower = pair.routeLower;

    for (const code of FREQUENCY_CODES) {
      const codeSuffix = ` ${code}`;
      for (const unitVariant of unitVariants) {
        const unitRoute = `${unitVariant.value} ${route}`;
        const unitRouteLower = `${unitVariant.lower} ${routeLower}`;
        for (const doseVariant of doseVariants) {
          const candidate = `${doseVariant.value} ${unitRoute}${codeSuffix}`;
          const candidateLower = `${doseVariant.lower} ${unitRouteLower}${codeSuffix}`;
          if (push(candidate, candidateLower)) {
            return suggestions;
          }
        }
      }
      const candidate = `${route}${codeSuffix}`;
      const candidateLower = `${routeLower}${codeSuffix}`;
      if (push(candidate, candidateLower)) {
        return suggestions;
      }
    }

    for (const interval of intervalTokens) {
      const intervalSuffix = ` ${interval}`;
      for (const unitVariant of unitVariants) {
        const unitRoute = `${unitVariant.value} ${route}`;
        const unitRouteLower = `${unitVariant.lower} ${routeLower}`;
        for (const doseVariant of doseVariants) {
          const base = `${doseVariant.value} ${unitRoute}`;
          const baseLower = `${doseVariant.lower} ${unitRouteLower}`;
          const intervalCandidate = `${base}${intervalSuffix}`;
          const intervalCandidateLower = `${baseLower}${intervalSuffix}`;
          if (push(intervalCandidate, intervalCandidateLower)) {
            return suggestions;
          }
          for (const reason of prnReasons) {
            const reasonSuffix = `${intervalSuffix} prn ${reason}`;
            const reasonCandidate = `${base}${reasonSuffix}`;
            const reasonCandidateLower = `${baseLower}${reasonSuffix}`;
            if (push(reasonCandidate, reasonCandidateLower)) {
              return suggestions;
            }
          }
        }
      }
      const candidate = `${route}${intervalSuffix}`;
      const candidateLower = `${routeLower}${intervalSuffix}`;
      if (push(candidate, candidateLower)) {
        return suggestions;
      }
    }

    for (const freq of FREQUENCY_NUMBERS) {
      const freqToken = FREQ_TOKEN_BY_NUMBER[freq];
      if (!freqToken) {
        continue;
      }
      const base = `1x${freq} ${route}`;
      const baseLower = `1x${freq} ${routeLower}`;
      const freqCandidate = `${base} ${freqToken}`;
      const freqCandidateLower = `${baseLower} ${freqToken}`;
      if (push(freqCandidate, freqCandidateLower)) {
        return suggestions;
      }
      for (const when of CORE_WHEN_TOKENS) {
        const whenCandidate = `${base} ${when}`;
        const whenCandidateLower = `${baseLower} ${when}`;
        if (push(whenCandidate, whenCandidateLower)) {
          return suggestions;
        }
      }
    }

    for (const whenSequence of whenSequences) {
      const suffix = ` ${whenSequence.join(" ")}`;
      for (const unitVariant of unitVariants) {
        const unitRoute = `${unitVariant.value} ${route}`;
        const unitRouteLower = `${unitVariant.lower} ${routeLower}`;
        for (const doseVariant of doseVariants) {
          const base = `${doseVariant.value} ${unitRoute}`;
          const baseLower = `${doseVariant.lower} ${unitRouteLower}`;
          const candidate = `${base}${suffix}`;
          const candidateLower = `${baseLower}${suffix}`;
          if (push(candidate, candidateLower)) {
            return suggestions;
          }
        }
      }
      const candidate = `${route}${suffix}`;
      const candidateLower = `${routeLower}${suffix}`;
      if (push(candidate, candidateLower)) {
        return suggestions;
      }
    }

    for (const reason of prnReasons) {
      const reasonSuffix = ` prn ${reason}`;
      for (const unitVariant of unitVariants) {
        const unitRoute = `${unitVariant.value} ${route}`;
        const unitRouteLower = `${unitVariant.lower} ${routeLower}`;
        for (const doseVariant of doseVariants) {
          const base = `${doseVariant.value} ${unitRoute}`;
          const baseLower = `${doseVariant.lower} ${unitRouteLower}`;
          const candidate = `${base}${reasonSuffix}`;
          const candidateLower = `${baseLower}${reasonSuffix}`;
          if (push(candidate, candidateLower)) {
            return suggestions;
          }
        }
      }
      const candidate = `${route}${reasonSuffix}`;
      const candidateLower = `${routeLower}${reasonSuffix}`;
      if (push(candidate, candidateLower)) {
        return suggestions;
      }
    }
  }

  return suggestions;
}

function matchesPrefix(
  _candidate: string,
  candidateLower: string,
  context: PrefixMatchContext,
): boolean {
  if (!context.raw) {
    return true;
  }
  if (!context.hasCanonical && !context.hasTokens) {
    return true;
  }
  if (candidateLower.startsWith(context.raw)) {
    return true;
  }

  const fingerprint = getCandidateFingerprint(candidateLower);

  if (context.requiresCompact) {
    const compactCandidate =
      fingerprint.compact ??
      (fingerprint.compact = removeWhitespaceCharacters(candidateLower));
    if (compactCandidate.startsWith(context.compact)) {
      return true;
    }
  }
  if (context.requiresNoDashes) {
    const candidateNoDashes =
      fingerprint.noDashes ?? (fingerprint.noDashes = removeDashes(candidateLower));
    if (candidateNoDashes.startsWith(context.noDashes)) {
      return true;
    }
  }

  const getCandidateTokens = () => {
    if (!fingerprint.tokens) {
      fingerprint.tokens = tokenizeLowercaseForMatching(candidateLower);
    }
    return fingerprint.tokens;
  };

  if (context.hasCanonical) {
    const canonicalCandidate =
      fingerprint.canonical ?? (fingerprint.canonical = getCandidateTokens().join(" "));
    if (canonicalCandidate.startsWith(context.canonical)) {
      return true;
    }
    if (context.requiresCanonicalCompact) {
      const canonicalCompact =
        fingerprint.canonicalCompact ??
        (fingerprint.canonicalCompact = removeWhitespaceCharacters(canonicalCandidate));
      if (canonicalCompact.startsWith(context.canonicalCompact)) {
        return true;
      }
    }
    if (context.requiresCanonicalNoDashes) {
      const canonicalNoDashes =
        fingerprint.canonicalNoDashes ??
        (fingerprint.canonicalNoDashes = removeDashes(canonicalCandidate));
      if (canonicalNoDashes.startsWith(context.canonicalNoDashes)) {
        return true;
      }
    }
  }
  if (context.hasTokens) {
    const resolvedTokens = getCandidateTokens();
    if (tokensMatch(context.tokens, resolvedTokens)) {
      return true;
    }
    if (context.requiresTokenNoDashes) {
      const candidateTokensNoDashes =
        fingerprint.tokensNoDashes ??
        (fingerprint.tokensNoDashes = resolvedTokens.map((token) => removeDashes(token)));
      if (tokensMatch(context.tokensNoDashes, candidateTokensNoDashes)) {
        return true;
      }
    }
  } else if (context.requiresTokenNoDashes) {
    return true;
  }
  return false;
}

export function suggestSig(input: string, options?: SuggestSigOptions): string[] {
  const limit = options?.limit ?? DEFAULT_LIMIT;
  if (limit <= 0) {
    return [];
  }
  const prefix = normalizeSpacing(input.toLowerCase());
  const prefixCompact = prefix.replace(/\s+/g, "");
  const prefixNoDashes = prefix.replace(/-/g, "");
  const prefixTokens = tokenizeLowercaseForMatching(prefix);
  const prefixCanonical = prefixTokens.join(" ");
  const prefixCanonicalCompact = prefixCanonical.replace(/\s+/g, "");
  const prefixCanonicalNoDashes = prefixCanonical.replace(/-/g, "");
  const prefixTokensNoDashes = prefixTokens.map((token) => token.replace(/-/g, ""));
  const prefixContext: PrefixMatchContext = {
    raw: prefix,
    compact: prefixCompact,
    noDashes: prefixNoDashes,
    canonical: prefixCanonical,
    canonicalCompact: prefixCanonicalCompact,
    canonicalNoDashes: prefixCanonicalNoDashes,
    tokens: prefixTokens,
    tokensNoDashes: prefixTokensNoDashes,
    hasCanonical: prefixCanonical.length > 0,
    hasTokens: prefixTokens.length > 0,
    requiresCompact: prefixCompact !== prefix,
    requiresNoDashes: prefixNoDashes !== prefix,
    requiresCanonicalCompact: prefixCanonicalCompact !== prefixCanonical,
    requiresCanonicalNoDashes: prefixCanonicalNoDashes !== prefixCanonical,
    requiresTokenNoDashes: prefixTokens.some(
      (token, index) => token !== prefixTokensNoDashes[index],
    ),
  };

  const contextUnit = inferUnitFromContext(options?.context ?? undefined);
  const pairs = buildUnitRoutePairs(contextUnit, options);
  const doseValues = buildDoseValues(input);
  const prnReasons = buildPrnReasons(options?.prnReasons);
  const intervalTokens = buildIntervalTokens(input);
  const whenSequences = PRECOMPUTED_WHEN_SEQUENCES;
  const matcher: CandidateMatcher = (candidate, candidateLower) =>
    matchesPrefix(candidate, candidateLower, prefixContext);
  return generateCandidateDirections(
    pairs,
    doseValues,
    prnReasons,
    intervalTokens,
    whenSequences,
    limit,
    matcher,
  );
}
