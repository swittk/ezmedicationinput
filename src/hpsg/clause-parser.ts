import { parseHpsgChart } from "./chart";
import { projectHpsgSignToState } from "./projection";
import { HpsgGrammar, HpsgPhraseRule, HpsgSign } from "./signature";
import { combineSigns } from "./unification";
import {
  compactIntervalRule,
  cadenceFirstFrequencyRule,
  countAndDurationRule,
  countFrequencyRule,
  dayRangeLexicalRule,
  eventTimingPhraseRule,
  multiplicativeDoseFrequencyRule,
  separatedFrequencyRangeRule,
  separatedIntervalRule,
  timeOfDayRule,
  timingLexicalRule
} from "./rules/timing-rules";
import { prnLexicalRule, symptomAdjustmentLexicalRule } from "./rules/prn-rules";
import {
  conditionalAdviceLexicalRule,
  instructionLexicalRule,
  proceduralActionLexicalRule,
  workflowLexicalRule
} from "./rules/instruction-rules";
import { bareSiteLexicalRule, siteLexicalRule } from "./rules/site-rules";
import {
  connectorLexicalRule,
  doseLexicalRule,
  fillerLexicalRule,
  methodLexicalRule,
  productLexicalRule,
  routeLexicalRule
} from "./rules/core-rules";
import { HpsgClauseContext } from "./rule-context";

function buildGrammar(context: HpsgClauseContext): HpsgGrammar<HpsgClauseContext> {
  const combineRule: HpsgPhraseRule<HpsgClauseContext> = {
    id: "hpsg.phrase.unify-adjacent",
    combine: (_context, left, right) =>
      combineSigns(left, right, context.deps, "hpsg.phrase.unify-adjacent")
  };
  return {
    lexicalRules: [
      methodLexicalRule(),
      routeLexicalRule(),
      productLexicalRule(),
      multiplicativeDoseFrequencyRule(),
      doseLexicalRule(),
      compactIntervalRule(),
      separatedIntervalRule(),
      cadenceFirstFrequencyRule(),
      separatedFrequencyRangeRule(),
      countFrequencyRule(),
      eventTimingPhraseRule(),
      dayRangeLexicalRule(),
      timingLexicalRule(),
      countAndDurationRule(),
      timeOfDayRule(),
      conditionalAdviceLexicalRule(),
      symptomAdjustmentLexicalRule(),
      prnLexicalRule(),
      proceduralActionLexicalRule(),
      workflowLexicalRule(),
      instructionLexicalRule(),
      siteLexicalRule(),
      bareSiteLexicalRule(),
      fillerLexicalRule(),
      connectorLexicalRule()
    ],
    phraseRules: [combineRule]
  };
}

function hasUsefulAnalysis(sign: HpsgSign | undefined): sign is HpsgSign {
  if (!sign) {
    return false;
  }
  const { head, valence } = sign.synsem;
  return Boolean(
    head.method ||
    head.route ||
    head.dose ||
    head.schedule ||
    valence.site ||
    valence.prn ||
    valence.instructions?.length ||
    valence.patientInstruction
  );
}

function semanticFeatureCount(sign: HpsgSign): number {
  const { head, valence } = sign.synsem;
  let count = 0;
  if (head.method) count += 1;
  if (head.route) count += 1;
  if (head.dose) count += 1;
  if (head.schedule) count += 1;
  if (valence.site) count += 1;
  if (valence.prn) count += 1;
  if (valence.instructions?.length) count += 1;
  if (valence.patientInstruction) count += 1;
  return count;
}

function signsOverlapTokens(left: HpsgSign, right: HpsgSign): boolean {
  const leftTokens = new Set(left.consumedTokenIndices);
  return right.consumedTokenIndices.some((index) => leftTokens.has(index));
}

function buildCompatibleSemanticCover(
  context: HpsgClauseContext,
  signs: HpsgSign[],
  best: HpsgSign
): HpsgSign {
  let cover = best;
  const candidates = signs
    .filter((sign) => sign !== best && hasUsefulAnalysis(sign))
    .sort((left, right) => {
      const semanticDelta = semanticFeatureCount(right) - semanticFeatureCount(left);
      if (semanticDelta) return semanticDelta;
      const coverageDelta = right.consumedTokenIndices.length - left.consumedTokenIndices.length;
      if (coverageDelta) return coverageDelta;
      return right.score - left.score;
    });

  for (const candidate of candidates) {
    if (signsOverlapTokens(cover, candidate)) continue;
    const combined = combineSigns(cover, candidate, context.deps, "hpsg.cover.unify-gap");
    if (combined) cover = combined;
  }
  return cover;
}

export function parseHpsgClause(context: HpsgClauseContext): HpsgSign | undefined {
  const result = parseHpsgChart(context, buildGrammar(context), {
    limit: context.limit
  });
  if (!hasUsefulAnalysis(result.best)) {
    return undefined;
  }
  const cover = buildCompatibleSemanticCover(context, result.signs, result.best);
  if (context.project) {
    projectHpsgSignToState(cover, context.state, context.tokens, context.deps);
  }
  return cover;
}
