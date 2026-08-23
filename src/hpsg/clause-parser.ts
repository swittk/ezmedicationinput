import { parseHpsgChart } from "./chart";
import { projectHpsgSignToState } from "./projection";
import { HpsgGrammar, HpsgLexicalRule, HpsgPhraseRule, HpsgSign } from "./signature";
import { signFeatureStructure } from "./feature-structure";
import { combineSigns } from "./unification";
import {
  compactIntervalRule,
  cadenceFirstFrequencyRule,
  cadenceFirstImplicitSingleDoseRule,
  countAndDurationRule,
  countFrequencyRule,
  dayRangeLexicalRule,
  eventOffsetRule,
  eventTimingPhraseRule,
  multiplicativeDoseFrequencyRule,
  separatedFrequencyRangeRule,
  separatedIntervalRule,
  timeOfDayRule,
  timingLexicalRule
} from "./rules/timing-rules";
import { prnLexicalRule, symptomAdjustmentLexicalRule } from "./rules/prn-rules";
import {
  instructionLexicalRule,
  proceduralActionLexicalRule,
  workflowLexicalRule
} from "./rules/instruction-rules";
import { conditionLexicalRule, getConditionFeatures } from "./rules/condition-rules";
import { sourceRangeAttachmentClass } from "./procedural-context";
import { bareSiteLexicalRule, siteLexicalRule } from "./rules/site-rules";
import {
  connectorLexicalRule,
  directiveMarkerLexicalRule,
  doseLexicalRule,
  fillerLexicalRule,
  methodLexicalRule,
  productLexicalRule,
  routeLexicalRule
} from "./rules/core-rules";
import { HpsgClauseContext } from "./rule-context";

function withScopeRequirements(
  rule: HpsgLexicalRule<HpsgClauseContext>
): HpsgLexicalRule<HpsgClauseContext> {
  return {
    id: rule.id,
    type: rule.type,
    match(context, start) {
      const conditions = getConditionFeatures(context);
      return rule.match(context, start).map((sign) => {
        if (!sign.tokens.length || sign.type === "conditional-sign") return sign;
        const sourceStart = Math.min(...sign.tokens.map((item) => item.sourceStart));
        const sourceEnd = Math.max(...sign.tokens.map((item) => item.sourceEnd));
        const requirements = conditions.filter((condition) =>
          sourceStart >= condition.targetStart && sourceEnd <= condition.targetEnd
        );
        const existing = sign.synsem.nonlocal?.scopeRequirements ?? [];
        const merged = [...existing];
        for (const requirement of requirements) {
          if (!merged.some((candidate) =>
            candidate.sourceStart === requirement.sourceStart &&
            candidate.sourceEnd === requirement.sourceEnd &&
            candidate.targetStart === requirement.targetStart &&
            candidate.targetEnd === requirement.targetEnd
          )) merged.push(requirement);
        }
        const attachmentClass = sourceRangeAttachmentClass(context, sourceStart, sourceEnd);
        const synsem = {
          ...sign.synsem,
          head: {
            ...sign.synsem.head,
            route: sign.synsem.head.route ? { ...sign.synsem.head.route, attachmentClass } : undefined,
            dose: sign.synsem.head.dose ? { ...sign.synsem.head.dose, attachmentClass } : undefined,
            schedule: sign.synsem.head.schedule ? { ...sign.synsem.head.schedule, attachmentClass } : undefined
          },
          valence: {
            ...sign.synsem.valence,
            site: sign.synsem.valence.site ? { ...sign.synsem.valence.site, attachmentClass } : undefined
          },
          nonlocal: { ...sign.synsem.nonlocal, scopeRequirements: merged }
        };
        return { ...sign, synsem, fs: signFeatureStructure(sign.type, synsem) };
      });
    }
  };
}

function buildGrammar(context: HpsgClauseContext): HpsgGrammar<HpsgClauseContext> {
  const combineRule: HpsgPhraseRule<HpsgClauseContext> = {
    id: "hpsg.phrase.unify-adjacent",
    combine: (_context, left, right) =>
      combineSigns(left, right, context.deps, "hpsg.phrase.unify-adjacent")
  };
  return {
    lexicalRules: [
      conditionLexicalRule(),
      ...[
      directiveMarkerLexicalRule(),
      methodLexicalRule(),
      routeLexicalRule(),
      productLexicalRule(),
      multiplicativeDoseFrequencyRule(),
      doseLexicalRule(),
      compactIntervalRule(),
      separatedIntervalRule(),
      cadenceFirstImplicitSingleDoseRule(),
      cadenceFirstFrequencyRule(),
      separatedFrequencyRangeRule(),
      countFrequencyRule(),
      eventOffsetRule(),
      eventTimingPhraseRule(),
      dayRangeLexicalRule(),
      timingLexicalRule(),
      countAndDurationRule(),
      timeOfDayRule(),
      symptomAdjustmentLexicalRule(),
      prnLexicalRule(),
      proceduralActionLexicalRule(),
      workflowLexicalRule(),
      instructionLexicalRule(),
      siteLexicalRule(),
      bareSiteLexicalRule(),
      fillerLexicalRule(),
      connectorLexicalRule()
      ].map(withScopeRequirements)
    ],
    phraseRules: [combineRule]
  };
}

function hasUsefulAnalysis(sign: HpsgSign | undefined): sign is HpsgSign {
  if (!sign || sign.synsem.nonlocal?.scopeRequirements?.length) {
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
