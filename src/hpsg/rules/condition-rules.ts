import { AdvicePolarity, AdviceRelation } from "../../types";
import { medicationInstructionActionIsSafetyScopeTarget, resolveMedicationInstructionAction } from "../../instruction-action-terminology";
import { getProceduralFrames } from "../procedural-context";
import { MAXIMUM_COUNT_LEAD_SEQUENCES } from "../lexical-classes";
import { hasSymptomOnsetPrnAt } from "./prn-rules";
import { HpsgClauseContext, lexicalRule, normalizeTokenLower } from "../rule-context";
import { HpsgConditionFeature, HpsgLexicalRule, lexicalSign } from "../signature";

const RELATION_BY_LEAD: Readonly<Record<string, AdviceRelation>> = {
  if: AdviceRelation.If,
  unless: AdviceRelation.Unless,
  when: AdviceRelation.When,
  while: AdviceRelation.While
};

function isScopeTarget(context: HpsgClauseContext, frame: ReturnType<typeof getProceduralFrames>[number]): boolean {
  const definition = resolveMedicationInstructionAction(frame.predicate.lemma, context.options);
  return Boolean(
    frame.polarity === AdvicePolarity.Negate ||
    definition?.procedural ||
    medicationInstructionActionIsSafetyScopeTarget(frame.predicate.lemma, context.options)
  );
}

function hasStrongBoundary(text: string): boolean {
  return /[.!?;]/u.test(text);
}

function explicitlySequences(text: string): boolean {
  const normalized = text.toLowerCase();
  return /(?:\bthen\b|\band\b|แล้ว|จากนั้น|และ|,)/u.test(normalized);
}

function prefixProgram(
  context: HpsgClauseContext,
  firstTargetIndex: number,
  frames: ReturnType<typeof getProceduralFrames>
): typeof frames {
  const result = [frames[firstTargetIndex]];
  let previous = frames[firstTargetIndex];
  for (let index = firstTargetIndex + 1; index < frames.length; index += 1) {
    const next = frames[index];
    const gap = context.state.input.slice(previous.span.end, next.span.start);
    if (hasStrongBoundary(gap)) break;
    const linked = explicitlySequences(gap);
    if (!linked) break;
    result.push(next);
    previous = next;
  }
  return result;
}

function conditionTokens(
  context: HpsgClauseContext,
  startSource: number,
  endSource: number
) {
  return context.tokens.filter((token) =>
    token.sourceStart >= startSource && token.sourceEnd <= endSource && !context.state.consumed.has(token.index)
  );
}

function startsMaximumCountLead(context: HpsgClauseContext, start: number): boolean {
  return MAXIMUM_COUNT_LEAD_SEQUENCES.some((parts) => {
    const available = context.tokens.slice(start, start + parts.length);
    return available.length === parts.length && available.every(
      (token, offset) => !context.state.consumed.has(token.index) && normalizeTokenLower(token) === parts[offset]
    );
  });
}

function postfixConditionEnd(context: HpsgClauseContext, start: number): number {
  const first = context.tokens[start];
  if (!first) return 0;
  let end = context.state.input.length;
  for (let index = start + 1; index < context.limit; index += 1) {
    const current = context.tokens.slice(index, index + 1)[0];
    if (!current) break;
    if (/^[.;!?]$/u.test(current.original.trim()) || startsMaximumCountLead(context, index)) {
      end = current.sourceStart;
      break;
    }
  }
  return end;
}

export function conditionLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.condition", (context, start) => {
    const lead = context.tokens[start];
    if (!lead || context.state.consumed.has(lead.index)) return [];
    const relation = RELATION_BY_LEAD[normalizeTokenLower(lead)];
    if (!relation) return [];
    if (relation === AdviceRelation.When && hasSymptomOnsetPrnAt(context, start)) return [];

    const frames = getProceduralFrames(context).slice().sort((a, b) =>
      a.span.start - b.span.start || a.span.end - b.span.end
    );

    const nextIndex = frames.findIndex((frame) =>
      frame.span.start >= lead.sourceEnd && isScopeTarget(context, frame)
    );
    if (nextIndex >= 0) {
      const program = prefixProgram(context, nextIndex, frames);
      const targetStart = program[0].span.start;
      const targetEnd = program[program.length - 1].span.end;
      const tokens = conditionTokens(context, lead.sourceStart, targetStart);
      if (!tokens.length) return [];
      const conditionEnd = Math.max(...tokens.map((token) => token.sourceEnd));
      const text = context.state.input.slice(lead.sourceStart, conditionEnd).trim();
      const fullText = context.state.input.slice(lead.sourceStart, targetEnd).trim();
      const safety = program.some((frame) => isScopeTarget(context, frame) && (
        frame.polarity === AdvicePolarity.Negate ||
        medicationInstructionActionIsSafetyScopeTarget(frame.predicate.lemma, context.options)
      ));
      return [lexicalSign({
        type: "conditional-sign",
        rule: "hpsg.lex.condition",
        tokens,
        synsem: {
          head: {},
          valence: {},
          cont: {
            clauseKind: "administration",
            condition: {
              relation,
              text,
              fullText,
              sourceStart: lead.sourceStart,
              sourceEnd: conditionEnd,
              targetStart,
              targetEnd,
              safety,
              frames: program
            }
          }
        },
        score: 34 + tokens.length + program.length * 3
      })];
    }

    const previous = frames
      .filter((frame) => frame.span.end <= lead.sourceStart && isScopeTarget(context, frame))
      .sort((a, b) => b.span.end - a.span.end)[0];
    if (!previous) return [];
    const gap = context.state.input.slice(previous.span.end, lead.sourceStart);
    if (hasStrongBoundary(gap) || (gap.trim() && !explicitlySequences(gap))) return [];
    const conditionEnd = postfixConditionEnd(context, start);
    const tokens = conditionTokens(context, lead.sourceStart, conditionEnd);
    if (!tokens.length) return [];
    const sourceEnd = Math.max(...tokens.map((token) => token.sourceEnd));
    const text = context.state.input.slice(lead.sourceStart, sourceEnd).trim();
    const fullText = context.state.input.slice(previous.span.start, sourceEnd).trim();
    const safety = previous.polarity === AdvicePolarity.Negate ||
      medicationInstructionActionIsSafetyScopeTarget(previous.predicate.lemma, context.options);
    return [lexicalSign({
      type: "conditional-sign",
      rule: "hpsg.lex.condition",
      tokens,
      synsem: {
        head: {},
        valence: {},
        cont: {
          clauseKind: "administration",
          condition: {
            relation,
            text,
            fullText,
            sourceStart: lead.sourceStart,
            sourceEnd,
            targetStart: previous.span.start,
            targetEnd: previous.span.end,
            safety,
            frames: [previous]
          }
        }
      },
      score: 34 + tokens.length
    })];
  });
}


const CONDITION_FEATURE_CACHE = new WeakMap<HpsgClauseContext, HpsgConditionFeature[]>();

export function getConditionFeatures(context: HpsgClauseContext): HpsgConditionFeature[] {
  const cached = CONDITION_FEATURE_CACHE.get(context);
  if (cached) return cached;
  const result: HpsgConditionFeature[] = [];
  const rule = conditionLexicalRule();
  for (let index = 0; index < context.limit; index += 1) {
    for (const sign of rule.match(context, index)) {
      const condition = sign.synsem.cont.condition;
      if (condition && !result.some((candidate) =>
        candidate.sourceStart === condition.sourceStart && candidate.sourceEnd === condition.sourceEnd
      )) result.push(condition);
    }
  }
  CONDITION_FEATURE_CACHE.set(context, result);
  return result;
}
