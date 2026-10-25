import { parseHpsgChart } from "./chart";
import { projectHpsgSignToState } from "./projection";
import { HpsgGrammar, HpsgLexicalRule, HpsgPhraseRule, HpsgSign } from "./signature";
import { combineSignFeatureStructures, signFeatureStructure } from "./feature-structure";
import { combineSigns } from "./unification";
import {
  compactIntervalRule,
  cycleScheduleRule,
  openEndedScheduleRule,
  cadenceFirstFrequencyRule,
  calendarDateListRule,
  cadenceFirstImplicitSingleDoseRule,
  countAndDurationRule,
  countFrequencyRule,
  dayRangeLexicalRule,
  eventOffsetRule,
  alternateEventCadenceRule,
  quantityFirstActivityTimingRule,
  quantityFirstEventOffsetRule,
  eventTimingPhraseRule,
  maximumDosePerPeriodRule,
  multiplicativeDoseFrequencyRule,
  separatedFrequencyRangeRule,
  separatedIntervalRule,
  singleOccurrencePhraseRule,
  timeOfDayRule,
  timingLexicalRule
} from "./rules/timing-rules";
import { prnLexicalRule, symptomAdjustmentLexicalRule, symptomOnsetPrnRule } from "./rules/prn-rules";
import {
  instructionLexicalRule,
  proceduralActionLexicalRule,
  workflowLexicalRule
} from "./rules/instruction-rules";
import {
  calendarExclusionLexicalRule,
  weekdayComplementReferenceLexicalRule,
  containsCalendarExclusionCue,
  conditionLexicalRule,
  getConditionFeatures,
  medicationGuardLexicalRule
} from "./rules/condition-rules";
import { sourceRangeAttachmentClass } from "./procedural-context";
import { bareSiteLexicalRule, siteLexicalRule } from "./rules/site-rules";
import {
  connectorLexicalRule,
  directiveMarkerLexicalRule,
  phaseAdjustmentLexicalRule,
  doseLexicalRule,
  perTargetCountDoseRule,
  fillerLexicalRule,
  methodLexicalRule,
  productLexicalRule,
  routeLexicalRule
} from "./rules/core-rules";
import { HpsgClauseContext } from "./rule-context";
import { CALENDAR_COMPLEMENT_DAY_MODIFIERS } from "./lexical-classes";
import { clinicalQuantityLexicalRule } from "./rules/clinical-quantity-rules";

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
        // Lexical constructions may already contain a typed phrase. Rebind
        // its SYNSEM while retaining its daughters; rebuilding it as a bare
        // word would erase the grammatical derivation and headed constraints.
        const left = sign.fs.features.LEFT_DTR;
        const right = sign.fs.features.RIGHT_DTR;
        const fs = left?.kind === "node" && right?.kind === "node"
          ? combineSignFeatureStructures(left, right, sign.type,
            sign.construction?.headSide, synsem)!
          : signFeatureStructure(sign.type, synsem);
        return { ...sign, synsem, fs };
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
  // Only install clinical-adjunct constructions when lexical surface cues
  // occur. Ordinary BID/eye/route SIGs pay no extra sign/chart cost.
  const source = context.state.input;
  const hasMedicationGuardLead =
    /\b(?:only\s+if|unless|if)\b|เฉพาะ(?:เมื่อ|หาก)|เว้นแต่|ยกเว้น\s*กรณี|หาก|ถ้า|เมื่อ/iu.test(source);
  const hasCalendarExclusion = containsCalendarExclusionCue(source);
  const hasWeekdayComplement = context.tokens.some(token =>
    CALENDAR_COMPLEMENT_DAY_MODIFIERS.has(token.canonical ?? token.lower));
  return {
    lexicalRules: [
      conditionLexicalRule(),
      ...(hasMedicationGuardLead ? [medicationGuardLexicalRule()] : []),
      ...(hasCalendarExclusion ? [calendarExclusionLexicalRule()] : []),
      ...[
      ...(hasWeekdayComplement ? [weekdayComplementReferenceLexicalRule()] : []),
      directiveMarkerLexicalRule(),
      phaseAdjustmentLexicalRule(),
      methodLexicalRule(),
      routeLexicalRule(),
      productLexicalRule(),
      clinicalQuantityLexicalRule(),
      maximumDosePerPeriodRule(),
      multiplicativeDoseFrequencyRule(),
      perTargetCountDoseRule(),
      doseLexicalRule(),
      cycleScheduleRule(),
      calendarDateListRule(),
      openEndedScheduleRule(),
      compactIntervalRule(),
      separatedIntervalRule(),
      cadenceFirstImplicitSingleDoseRule(),
      cadenceFirstFrequencyRule(),
      separatedFrequencyRangeRule(),
      singleOccurrencePhraseRule(),
      countFrequencyRule(),
      alternateEventCadenceRule(),
      quantityFirstActivityTimingRule(),
      quantityFirstEventOffsetRule(),
      eventOffsetRule(),
      eventTimingPhraseRule(),
      dayRangeLexicalRule(),
      timingLexicalRule(),
      countAndDurationRule(),
      timeOfDayRule(),
      symptomAdjustmentLexicalRule(),
      symptomOnsetPrnRule(),
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

function hasClinicalAdjunctAnalysis(sign: HpsgSign): boolean {
  return Boolean(sign.synsem.cont.clinicalAdjunct);
}

function semanticFeatureCount(sign: HpsgSign): number {
  const { head, valence } = sign.synsem;
  let count = 0;
  if (head.method) count += 1;
  if (head.route) count += 1;
  if (head.dose) count += 1;
  if (head.schedule) count += 1;
  if (valence.site) count += valence.site.coordination ? 3 : 1;
  if (valence.prn) count += 1;
  if (valence.instructions?.length) count += 1;
  if (valence.patientInstruction) count += 1;
  if (sign.synsem.cont.clinicalAdjunct) count += 1;
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
    .filter((sign) => sign !== best && !sign.synsem.nonlocal?.scopeRequirements?.length &&
      (hasUsefulAnalysis(sign) || hasClinicalAdjunctAnalysis(sign)))
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
  const best = result.best;
  // A long clinical adjunct can be the largest chart constituent while an
  // opaque connector separates its administration head. Complete the same
  // semantic cover before deciding whether a usable medication was found.
  if (!best || best.synsem.nonlocal?.scopeRequirements?.length ||
      (!hasUsefulAnalysis(best) && !hasClinicalAdjunctAnalysis(best))) return undefined;
  const cover = buildCompatibleSemanticCover(context, result.signs, best);
  if (!hasUsefulAnalysis(cover)) return undefined;
  if (context.project) {
    projectHpsgSignToState(cover, context.state, context.tokens, context.deps);
  }
  return cover;
}
