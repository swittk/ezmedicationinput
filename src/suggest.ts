import { inferUnitFromContext } from "./context";
import { ParseOptions } from "./types";

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

const DEFAULT_LIMIT = 10;

const DEFAULT_UNIT_ROUTE_ORDER: UnitRoutePair[] = [
  { unit: "tab", route: "po" },
  { unit: "cap", route: "po" },
  { unit: "mL", route: "po" },
  { unit: "mg", route: "po" },
  { unit: "puff", route: "inh" },
  { unit: "spray", route: "in" },
  { unit: "drop", route: "oph" },
  { unit: "suppository", route: "pr" },
  { unit: "patch", route: "transdermal" },
  { unit: "g", route: "topical" }
];

const DEFAULT_ROUTE_BY_UNIT: Record<string, string> = {
  tab: "po",
  tabs: "po",
  tablet: "po",
  cap: "po",
  capsule: "po",
  ml: "po",
  mg: "po",
  puff: "inh",
  puffs: "inh",
  spray: "in",
  sprays: "in",
  drop: "oph",
  drops: "oph",
  suppository: "pr",
  suppositories: "pr",
  patch: "transdermal",
  patches: "transdermal",
  g: "topical"
};

const FREQUENCY_CODES = ["qd", "bid", "tid", "qid"] as const;
const INTERVAL_CODES = ["q4h", "q6h", "q8h"] as const;
const WHEN_TOKENS = ["ac", "pc", "hs", "am", "pm"] as const;
const CORE_WHEN_TOKENS = ["pc", "ac", "hs"] as const;
const FREQUENCY_NUMBERS = [1, 2, 3, 4] as const;
const FREQ_TOKEN_BY_NUMBER: Record<number, string> = {
  1: "qd",
  2: "bid",
  3: "tid",
  4: "qid",
};
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

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeSpacing(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ");
}

function buildUnitRoutePairs(contextUnit: string | undefined): UnitRoutePair[] {
  const pairs: UnitRoutePair[] = [];
  const seen = new Set<string>();
  const addPair = (unit: string | undefined, route: string | undefined) => {
    if (!unit) {
      return;
    }
    const cleanUnit = unit.trim();
    if (!cleanUnit) {
      return;
    }
    const normalizedUnit = cleanUnit.toLowerCase();
    const resolvedRoute = route ?? DEFAULT_ROUTE_BY_UNIT[normalizedUnit] ?? "po";
    const key = `${normalizedUnit}::${resolvedRoute.toLowerCase()}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    pairs.push({ unit: cleanUnit, route: resolvedRoute });
  };

  if (contextUnit) {
    const normalized = normalizeKey(contextUnit);
    addPair(contextUnit, DEFAULT_ROUTE_BY_UNIT[normalized]);
  }

  for (const pair of DEFAULT_UNIT_ROUTE_ORDER) {
    addPair(pair.unit, pair.route);
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

function generateCandidateSignatures(
  pairs: UnitRoutePair[],
  doseValues: readonly string[],
  prnReasons: readonly string[],
): string[] {
  const suggestions: string[] = [];
  const seen = new Set<string>();

  const push = (value: string) => {
    const normalized = normalizeSpacing(value);
    if (!normalized) {
      return;
    }
    const key = normalizeKey(normalized);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    suggestions.push(normalized);
  };

  for (const pair of pairs) {
    for (const code of FREQUENCY_CODES) {
      for (const dose of doseValues) {
        push(`${dose} ${pair.unit} ${pair.route} ${code}`);
      }
      push(`${pair.route} ${code}`);
    }

    for (const interval of INTERVAL_CODES) {
      for (const dose of doseValues) {
        push(`${dose} ${pair.unit} ${pair.route} ${interval}`);
        for (const reason of prnReasons) {
          push(`${dose} ${pair.unit} ${pair.route} ${interval} prn ${reason}`);
        }
      }
      push(`${pair.route} ${interval}`);
    }

    for (const freq of FREQUENCY_NUMBERS) {
      const freqToken = FREQ_TOKEN_BY_NUMBER[freq];
      push(`1x${freq} ${pair.route} ${freqToken}`);
      for (const when of CORE_WHEN_TOKENS) {
        push(`1x${freq} ${pair.route} ${when}`);
      }
    }

    for (const when of WHEN_TOKENS) {
      for (const dose of doseValues) {
        push(`${dose} ${pair.unit} ${pair.route} ${when}`);
      }
      push(`${pair.route} ${when}`);
    }

    for (const reason of prnReasons) {
      push(`1 ${pair.unit} ${pair.route} prn ${reason}`);
    }
  }

  return suggestions;
}

function matchesPrefix(candidate: string, prefix: string, prefixCompact: string): boolean {
  if (!prefix) {
    return true;
  }
  const normalizedCandidate = candidate.toLowerCase();
  if (normalizedCandidate.startsWith(prefix)) {
    return true;
  }
  const compactCandidate = normalizedCandidate.replace(/\s+/g, "");
  return compactCandidate.startsWith(prefixCompact);
}

export function suggestSig(input: string, options?: SuggestSigOptions): string[] {
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const prefix = normalizeSpacing(input.toLowerCase());
  const prefixCompact = prefix.replace(/\s+/g, "");

  const contextUnit = inferUnitFromContext(options?.context ?? undefined);
  const pairs = buildUnitRoutePairs(contextUnit);
  const doseValues = buildDoseValues(input);
  const prnReasons = buildPrnReasons(options?.prnReasons);
  const candidates = generateCandidateSignatures(pairs, doseValues, prnReasons);

  const results: string[] = [];
  for (const candidate of candidates) {
    if (matchesPrefix(candidate, prefix, prefixCompact)) {
      results.push(candidate);
    }
    if (results.length >= limit) {
      break;
    }
  }

  return results;
}
