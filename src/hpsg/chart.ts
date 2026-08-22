import { Token } from "../parser-state";
import {
  HpsgGrammar,
  HpsgPhraseRule,
  HpsgSign,
  HpsgType
} from "./signature";
import { HPSG_TYPE_SYSTEM } from "./type-system";

export interface HpsgChartContext {
  tokens: Token[];
}

export interface HpsgChartOptions {
  limit?: number;
  maxIterations?: number;
}

export interface HpsgChartParseResult {
  signs: HpsgSign[];
  best?: HpsgSign;
}

function tokenSpanLength(sign: HpsgSign): number {
  return Math.max(0, sign.span.end - sign.span.start);
}

function countSynsemFeatures(sign: HpsgSign): number {
  let count = 0;
  const { head, valence, cont } = sign.synsem;
  if (head.method) count += 1;
  if (head.route) count += 1;
  if (head.dose) count += 1;
  if (head.schedule) count += 1;
  if (valence.site) count += 1;
  if (valence.prn) count += 1;
  if (valence.instructions?.length) count += 1;
  if (valence.patientInstruction) count += 1;
  if (cont.clauseKind) count += 1;
  return count;
}

function isBetterSign(candidate: HpsgSign, best: HpsgSign | undefined): boolean {
  if (!best) {
    return true;
  }
  if (candidate.consumedTokenIndices.length !== best.consumedTokenIndices.length) {
    return candidate.consumedTokenIndices.length > best.consumedTokenIndices.length;
  }
  const candidateSpan = tokenSpanLength(candidate);
  const bestSpan = tokenSpanLength(best);
  if (candidateSpan !== bestSpan) {
    return candidateSpan > bestSpan;
  }
  const candidateFeatures = countSynsemFeatures(candidate);
  const bestFeatures = countSynsemFeatures(best);
  if (candidateFeatures !== bestFeatures) {
    return candidateFeatures > bestFeatures;
  }
  if (candidate.score !== best.score) {
    return candidate.score > best.score;
  }
  return candidate.evidence.length < best.evidence.length;
}

function typeMatches(actual: HpsgType, expected: HpsgType | undefined): boolean {
  return expected === undefined || HPSG_TYPE_SYSTEM.isSubtype(actual, expected);
}

const CHART_KEY_CACHE = new WeakMap<HpsgSign, string>();

function chartKey(sign: HpsgSign): string {
  const cached = CHART_KEY_CACHE.get(sign);
  if (cached !== undefined) {
    return cached;
  }
  const packedType = HPSG_TYPE_SYSTEM.isSubtype(sign.type, "phrase-sign")
    ? "phrase-sign"
    : sign.type;
  const key = [
    packedType,
    sign.span.start,
    sign.span.end,
    JSON.stringify(sign.synsem)
  ].join("|");
  CHART_KEY_CACHE.set(sign, key);
  return key;
}

function canCombine(rule: HpsgPhraseRule<HpsgChartContext>, left: HpsgSign, right: HpsgSign): boolean {
  return typeMatches(left.type, rule.left) && typeMatches(right.type, rule.right);
}

function isBetterDerivation(candidate: HpsgSign, existing: HpsgSign): boolean {
  if (candidate.consumedTokenIndices.length !== existing.consumedTokenIndices.length) {
    return candidate.consumedTokenIndices.length > existing.consumedTokenIndices.length;
  }
  if (candidate.score !== existing.score) {
    return candidate.score > existing.score;
  }
  if (candidate.evidence.length !== existing.evidence.length) {
    return candidate.evidence.length < existing.evidence.length;
  }
  const candidateSpecific = candidate.type !== "clause-sign" && candidate.type !== "phrase-sign";
  const existingSpecific = existing.type !== "clause-sign" && existing.type !== "phrase-sign";
  return candidateSpecific && !existingSpecific;
}

function pushUnique(signs: HpsgSign[], seen: Map<string, HpsgSign>, sign: HpsgSign): boolean {
  const key = chartKey(sign);
  const existing = seen.get(key);
  if (existing) {
    if (!isBetterDerivation(sign, existing)) {
      return false;
    }
    const index = signs.indexOf(existing);
    if (index >= 0) {
      signs[index] = sign;
    }
    seen.set(key, sign);
    return true;
  }
  seen.set(key, sign);
  signs.push(sign);
  return true;
}

export function parseHpsgChart<TContext extends HpsgChartContext>(
  context: TContext,
  grammar: HpsgGrammar<TContext>,
  options: HpsgChartOptions = {}
): HpsgChartParseResult {
  const limit = options.limit ?? context.tokens.length;
  // maxIterations historically bounded whole-chart rescans. In the agenda
  // implementation it bounds processed agenda items, scaled so normal parses
  // retain substantially more headroom than the old rescan loop.
  const maxAgendaItems = options.maxIterations !== undefined
    ? Math.max(options.maxIterations, limit * 8)
    : Math.max(192, limit * limit * 4);
  const signs: HpsgSign[] = [];
  const seen = new Map<string, HpsgSign>();
  const agenda: HpsgSign[] = [];
  let agendaCursor = 0;
  const byStart = new Map<number, HpsgSign[]>();
  const byEnd = new Map<number, HpsgSign[]>();

  const addToIndex = (index: Map<number, HpsgSign[]>, key: number, sign: HpsgSign) => {
    const bucket = index.get(key);
    if (bucket) {
      bucket.push(sign);
    } else {
      index.set(key, [sign]);
    }
  };

  const enqueue = (sign: HpsgSign): boolean => {
    if (sign.span.end > limit || sign.span.start < 0 || sign.span.end <= sign.span.start) {
      return false;
    }
    if (!pushUnique(signs, seen, sign)) {
      return false;
    }
    agenda.push(sign);
    addToIndex(byStart, sign.span.start, sign);
    addToIndex(byEnd, sign.span.end, sign);
    return true;
  };

  for (let index = 0; index < limit; index += 1) {
    for (const rule of grammar.lexicalRules) {
      for (const sign of rule.match(context, index)) {
        enqueue(sign);
      }
    }
  }

  const combinePair = (left: HpsgSign, right: HpsgSign) => {
    if (left.span.end !== right.span.start) {
      return;
    }
    for (const rule of grammar.phraseRules) {
      if (!canCombine(rule, left, right)) {
        continue;
      }
      const combined = rule.combine(context, left, right);
      if (combined) {
        enqueue(combined);
      }
    }
  };

  let processedAgendaItems = 0;
  while (agendaCursor < agenda.length && processedAgendaItems < maxAgendaItems) {
    const current = agenda[agendaCursor];
    agendaCursor += 1;
    processedAgendaItems += 1;

    // A better derivation may replace an equivalent sign while an older copy
    // is still queued. Skip stale copies; their structural combinations are
    // represented by the current best derivation for the same chart key.
    if (seen.get(chartKey(current)) !== current) {
      continue;
    }

    const leftNeighbors = (byEnd.get(current.span.start) ?? []).slice();
    for (const left of leftNeighbors) {
      if (seen.get(chartKey(left)) === left) {
        combinePair(left, current);
      }
    }

    const rightNeighbors = (byStart.get(current.span.end) ?? []).slice();
    for (const right of rightNeighbors) {
      if (seen.get(chartKey(right)) === right) {
        combinePair(current, right);
      }
    }
  }

  let best: HpsgSign | undefined;
  for (const sign of signs) {
    if (seen.get(chartKey(sign)) !== sign) {
      continue;
    }
    if (isBetterSign(sign, best)) {
      best = sign;
    }
  }

  return { signs, best };
}
