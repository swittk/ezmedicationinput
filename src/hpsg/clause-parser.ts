import { parseHpsgChart } from "./chart";
import { projectHpsgSignToState } from "./projection";
import { HpsgGrammar, HpsgPhraseRule, HpsgSign } from "./signature";
import { combineSigns } from "./unification";
import {
  compactIntervalRule,
  countAndDurationRule,
  countFrequencyRule,
  dayRangeLexicalRule,
  eventTimingPhraseRule,
  multiplicativeDoseFrequencyRule,
  separatedIntervalRule,
  timeOfDayRule,
  timingLexicalRule
} from "./rules/timing-rules";
import { prnLexicalRule } from "./rules/prn-rules";
import { instructionLexicalRule, workflowLexicalRule } from "./rules/instruction-rules";
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
      countFrequencyRule(),
      eventTimingPhraseRule(),
      dayRangeLexicalRule(),
      timingLexicalRule(),
      countAndDurationRule(),
      timeOfDayRule(),
      prnLexicalRule(),
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

export function parseHpsgClause(context: HpsgClauseContext): HpsgSign | undefined {
  const result = parseHpsgChart(context, buildGrammar(context), {
    limit: context.limit
  });
  if (!hasUsefulAnalysis(result.best)) {
    return undefined;
  }
  if (context.project) {
    projectHpsgSignToState(result.best, context.state, context.tokens, context.deps);
  }
  return result.best;
}
