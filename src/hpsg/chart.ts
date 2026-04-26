import { Token } from "../parser-state";
import {
  HpsgGrammar,
  HpsgPhraseRule,
  HpsgSign,
  HpsgType
} from "./signature";

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
  return expected === undefined || actual === expected || actual === "clause-sign";
}

function chartKey(sign: HpsgSign): string {
  return [
    sign.type,
    sign.span.start,
    sign.span.end,
    sign.consumedTokenIndices.slice().sort((left, right) => left - right).join(","),
    JSON.stringify(sign.synsem)
  ].join("|");
}

function canCombine(rule: HpsgPhraseRule<HpsgChartContext>, left: HpsgSign, right: HpsgSign): boolean {
  return typeMatches(left.type, rule.left) && typeMatches(right.type, rule.right);
}

function isBetterDerivation(candidate: HpsgSign, existing: HpsgSign): boolean {
  if (candidate.score !== existing.score) {
    return candidate.score > existing.score;
  }
  return candidate.evidence.length < existing.evidence.length;
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
  const maxIterations = options.maxIterations ?? Math.max(16, limit * limit * 2);
  const signs: HpsgSign[] = [];
  const seen = new Map<string, HpsgSign>();

  for (let index = 0; index < limit; index += 1) {
    for (const rule of grammar.lexicalRules) {
      for (const sign of rule.match(context, index)) {
        if (sign.span.end <= limit) {
          pushUnique(signs, seen, sign);
        }
      }
    }
  }

  let changed = true;
  let iteration = 0;
  while (changed && iteration < maxIterations) {
    changed = false;
    iteration += 1;
    const snapshot = signs.slice();
    for (const left of snapshot) {
      for (const right of snapshot) {
        if (left.span.end !== right.span.start) {
          continue;
        }
        for (const rule of grammar.phraseRules) {
          if (!canCombine(rule, left, right)) {
            continue;
          }
          const combined = rule.combine(context, left, right);
          if (combined && combined.span.end <= limit) {
            changed = pushUnique(signs, seen, combined) || changed;
          }
        }
      }
    }
  }

  let best: HpsgSign | undefined;
  for (const sign of signs) {
    if (isBetterSign(sign, best)) {
      best = sign;
    }
  }

  return { signs, best };
}
