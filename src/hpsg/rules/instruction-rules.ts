import { EVENT_TIMING_TOKENS } from "../../maps";
import { parseAdditionalInstructions } from "../../advice";
import { resolveMedicationInstructionAction } from "../../instruction-action-terminology";
import { getProceduralFrames } from "../procedural-context";
import { LexKind } from "../../lexer/token-types";
import { Token } from "../../parser-state";
import { normalizeUnit } from "../../unit-lexicon";
import {
  AdviceArgumentRole,
  AdviceForce,
  AdviceFrame,
  AdvicePolarity,
  CanonicalAdditionalInstructionExpr
} from "../../types";
import { mapIntervalUnit } from "../timing-lexicon";
import {
  INSTRUCTION_LEADING_SEPARATORS,
  INSTRUCTION_START_WORDS,
  LIST_SEPARATORS,
  MEAL_RELATION_BY_TOKEN,
  SITE_ANCHORS,
  WORKFLOW_CONTINUATION_LICENSES,
  WORKFLOW_NOUNS,
  WORKFLOW_START_WORDS
} from "../lexical-classes";
import {
  METHOD_ACTION_BY_VERB,
  METHOD_CODING_BY_ACTION,
  cloneMethodCoding
} from "../method-lexicon";
import {
  HpsgClauseContext,
  joinTokenText,
  lexicalRule,
  normalizeTokenLower,
  rangeFromTokens,
  tokensAvailable
} from "../rule-context";
import { HpsgLexicalRule, lexicalSign } from "../signature";
import { isScheduleLead } from "./timing-rules";

const INSTRUCTION_PREDICATES = ["take", "apply", "use"] as const;

function isExplicitDoseLead(context: HpsgClauseContext, index: number): boolean {
  const token = context.tokens.slice(index, index + 1)[0];
  const unitToken = context.tokens[index + 1];
  if (
    !token ||
    !unitToken ||
    context.state.consumed.has(token.index) ||
    context.state.consumed.has(unitToken.index)
  ) {
    return false;
  }
  if (token.kind !== LexKind.Number && token.kind !== LexKind.NumberRange) {
    return false;
  }
  return Boolean(normalizeUnit(normalizeTokenLower(unitToken), context.options));
}

function startsScheduledAdministration(context: HpsgClauseContext, index: number): boolean {
  const token = context.tokens.slice(index, index + 1)[0];
  if (!token || context.state.consumed.has(token.index)) {
    return false;
  }
  return Boolean(
    METHOD_ACTION_BY_VERB[normalizeTokenLower(token)] &&
    isScheduleLead(context, index + 1)
  );
}

const HPSG_PRIMARY_METHOD_ACTIONS = new Set(["shampoo", "reapply", "swallow", "chew"]);

function proceduralFrames(context: HpsgClauseContext): AdviceFrame[] {
  return getProceduralFrames(context).filter((frame) => {
    const definition = resolveMedicationInstructionAction(frame.predicate.lemma, context.options);
    if (
      !definition?.procedural ||
      HPSG_PRIMARY_METHOD_ACTIONS.has(frame.predicate.lemma) ||
      WORKFLOW_START_WORDS.has(frame.predicate.lemma)
    ) {
      return false;
    }
    return !frame.args.some((arg) =>
      !arg.conceptId &&
      !arg.coding?.code &&
      !arg.quantity &&
      /(?:\band\b|\bor\b|และ|หรือ)/iu.test(arg.text)
    );
  });
}

function frameTokens(context: HpsgClauseContext, frame: AdviceFrame): Token[] {
  return context.tokens.filter((token) =>
    token.sourceStart >= frame.span.start && token.sourceEnd <= frame.span.end
  );
}

function frameDose(
  context: HpsgClauseContext,
  frame: AdviceFrame
): { value?: number; range?: { low?: number; high?: number }; unit?: string } | undefined {
  const definition = resolveMedicationInstructionAction(frame.predicate.lemma, context.options);
  if (!definition?.definesDose) return undefined;
  const amount = frame.args.find((arg) => arg.role === AdviceArgumentRole.Amount && arg.quantity);
  if (!amount?.quantity) return undefined;
  return {
    value: amount.quantity.value,
    range: amount.quantity.range ? { ...amount.quantity.range } : undefined,
    unit: amount.quantity.unit
  };
}

const CONDITIONAL_ADVICE_LEADS = new Set([
  "if", "unless", "when", "while", "during", "should-not", "should", "must", "avoid", "do", "don't", "dont", "consult", "seek"
]);
const CONDITIONAL_RELATIONS = new Set(["if", "unless", "when", "while", "during"]);

function frameIsConditionalSafetyAdvice(frame: AdviceFrame): boolean {
  if (frame.polarity === AdvicePolarity.Negate) return true;
  if (frame.predicate.lemma === "consult") return true;
  return frame.predicate.semanticClass === "medical_advice";
}

export function conditionalAdviceLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.conditionalAdvice", (context, start) => {
    const first = tokensAvailable(context, start, 1)?.[0];
    if (!first || !CONDITIONAL_ADVICE_LEADS.has(normalizeTokenLower(first))) return [];

    const tokens: Token[] = [];
    for (let cursor = start; cursor < context.limit; cursor += 1) {
      const token = context.tokens[cursor];
      if (!token || context.state.consumed.has(token.index)) break;
      tokens.push(token);
    }
    if (!tokens.length || !tokens.some((token) => CONDITIONAL_RELATIONS.has(normalizeTokenLower(token)))) {
      return [];
    }
    const range = rangeFromTokens(tokens);
    if (!range) return [];
    const text = context.state.input.slice(range.start, range.end).trim();
    if (!text) return [];
    const frames = getProceduralFrames(context).filter((frame) =>
      frame.span.start >= range.start && frame.span.end <= range.end
    );
    if (!frames.some(frameIsConditionalSafetyAdvice)) return [];

    return [
      lexicalSign({
        type: "conditional-sign",
        rule: "hpsg.lex.conditionalAdvice",
        tokens,
        synsem: {
          head: {},
          valence: {
            instructions: [{ text, frames }]
          },
          cont: { clauseKind: "administration" }
        },
        score: 32 + tokens.length + frames.length * 3
      })
    ];
  });
}

export function proceduralActionLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.patientInstruction.procedure", (context, start) => {
    const startToken = context.tokens[start];
    if (!startToken || context.state.consumed.has(startToken.index)) return [];
    const signs = [];
    for (const frame of proceduralFrames(context)) {
      if (frame.span.start !== startToken.sourceStart) continue;
      const tokens = frameTokens(context, frame);
      if (!tokens.length || tokens.some((token) => context.state.consumed.has(token.index))) continue;
      const text = context.state.input.slice(frame.span.start, frame.span.end).trim();
      if (!text) continue;
      signs.push(
        lexicalSign({
          type: "instruction-sign",
          rule: "hpsg.lex.patientInstruction.procedure",
          tokens,
          synsem: {
            head: { dose: frameDose(context, frame) },
            valence: frame.polarity === AdvicePolarity.Negate
              ? { instructions: [{ text, frames: [frame] }] }
              : { patientInstruction: { text } },
            cont: { clauseKind: "administration" }
          },
          score: 18 + tokens.length + frame.args.length * 2
        })
      );
    }
    return signs;
  });
}

export function workflowLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.patientInstruction.workflow", (context, start) => {
    let cursor = start;
    const consumed: Token[] = [];
    while (cursor < context.limit) {
      const token = context.tokens[cursor];
      const lower = token ? normalizeTokenLower(token) : "";
      if (!token || context.state.consumed.has(token.index) || !LIST_SEPARATORS.has(lower)) {
        break;
      }
      consumed.push(token);
      cursor += 1;
    }

    const first = context.tokens[cursor];
    if (!first || context.state.consumed.has(first.index)) {
      return [];
    }
    const firstLower = normalizeTokenLower(first);
    if (!WORKFLOW_START_WORDS.has(firstLower)) {
      return [];
    }
    const second = context.tokens[cursor + 1];
    const secondLower = second ? normalizeTokenLower(second) : "";
    if (firstLower === MEAL_RELATION_BY_TOKEN.get("with") && !WORKFLOW_CONTINUATION_LICENSES.has(`${firstLower} ${secondLower}`)) {
      return [];
    }
    if (isScheduleLead(context, cursor)) {
      return [];
    }

    const bodyTokens: Token[] = [];
    for (; cursor < context.limit; cursor += 1) {
      const token = context.tokens[cursor];
      if (!token || context.state.consumed.has(token.index)) {
        break;
      }
      const lower = normalizeTokenLower(token);
      const previousLower = bodyTokens.length ? normalizeTokenLower(bodyTokens[bodyTokens.length - 1]) : "";
      const nextLower = context.tokens[cursor + 1] ? normalizeTokenLower(context.tokens[cursor + 1]) : "";
      const actionDefinition = resolveMedicationInstructionAction(lower, context.options);
      if (
        bodyTokens.length &&
        actionDefinition &&
        !actionDefinition.procedural &&
        METHOD_ACTION_BY_VERB[lower] &&
        previousLower !== "before" &&
        previousLower !== "after" &&
        previousLower !== "with"
      ) {
        break;
      }
      if (
        bodyTokens.length &&
        (isExplicitDoseLead(context, cursor) || startsScheduledAdministration(context, cursor)) &&
        previousLower !== "before" &&
        previousLower !== "after" &&
        previousLower !== "with"
      ) {
        break;
      }
      if (
        bodyTokens.length &&
        (isInstructionSeparator(token) || INSTRUCTION_START_WORDS.has(lower)) &&
        !WORKFLOW_CONTINUATION_LICENSES.has(`${previousLower} ${lower}`)
      ) {
        break;
      }
      if (
        bodyTokens.length &&
        isScheduleLead(context, cursor) &&
        !([LexKind.Number, LexKind.NumberRange].indexOf(bodyTokens[bodyTokens.length - 1]?.kind as LexKind) >= 0 && mapIntervalUnit(lower)) &&
        !WORKFLOW_CONTINUATION_LICENSES.has(`${previousLower} ${lower}`) &&
        !(
          previousLower &&
          WORKFLOW_CONTINUATION_LICENSES.has(`${previousLower} *event`) &&
          EVENT_TIMING_TOKENS[lower]
        ) &&
        !WORKFLOW_CONTINUATION_LICENSES.has(`${lower} ${nextLower}`)
      ) {
        break;
      }
      if (LIST_SEPARATORS.has(lower) && bodyTokens.length && !WORKFLOW_NOUNS.has(normalizeTokenLower(context.tokens[cursor + 1] ?? token))) {
        break;
      }
      bodyTokens.push(token);
    }
    if (!bodyTokens.length) {
      return [];
    }
    const range = rangeFromTokens(bodyTokens);
    const text = range
      ? context.state.input.slice(range.start, range.end).trim()
      : joinTokenText(bodyTokens);
    if (!text) {
      return [];
    }
    const firstWorkflowFrame = getProceduralFrames(context).find((frame) =>
      frame.span.start === first.sourceStart && frame.polarity !== AdvicePolarity.Negate
    );
    const hasPriorPositiveAction = getProceduralFrames(context).some((frame) =>
      frame.span.start < first.sourceStart && frame.polarity !== AdvicePolarity.Negate
    );
    const headAction = !hasPriorPositiveAction
      ? (firstWorkflowFrame
          ? METHOD_ACTION_BY_VERB[firstWorkflowFrame.predicate.lemma]
          : METHOD_ACTION_BY_VERB[firstLower])
      : undefined;
    const headSite = !hasPriorPositiveAction
      ? firstWorkflowFrame?.args.find((arg) =>
          arg.role === AdviceArgumentRole.Site && Boolean(arg.coding?.code || arg.conceptId)
        )
      : undefined;
    return [
      lexicalSign({
        type: "instruction-sign",
        rule: "hpsg.lex.patientInstruction.workflow",
        tokens: [...consumed, ...bodyTokens],
        synsem: {
          head: {
            method: headAction
              ? {
                  verb: firstWorkflowFrame?.predicate.lemma ?? firstLower,
                  coding: cloneMethodCoding(METHOD_CODING_BY_ACTION[headAction])
                }
              : undefined
          },
          valence: {
            patientInstruction: { text },
            site: headSite
              ? {
                  text: headSite.normalized ?? headSite.text,
                  coding: headSite.coding,
                  source: "text"
                }
              : undefined
          },
          cont: { clauseKind: "administration" }
        },
        score: 12 + bodyTokens.length
      })
    ];
  });
}

function isInstructionSeparator(token: Token | undefined): boolean {
  return Boolean(token && INSTRUCTION_LEADING_SEPARATORS.has(token.original.trim().toLowerCase()));
}

function instructionStartIsLicensed(
  context: HpsgClauseContext,
  start: number,
  hasLeadingSeparator: boolean
): boolean {
  if (hasLeadingSeparator) {
    return true;
  }
  const token = context.tokens[start];
  const lower = token ? normalizeTokenLower(token) : "";
  if (INSTRUCTION_START_WORDS.has(lower)) {
    return true;
  }
  const previous = context.tokens[start - 1];
  return Boolean(previous && METHOD_ACTION_BY_VERB[normalizeTokenLower(previous)]);
}

function parseInstructionCandidates(
  text: string,
  range: { start: number; end: number }
): CanonicalAdditionalInstructionExpr[] {
  let best: CanonicalAdditionalInstructionExpr[] = [];
  let bestScore = -1;
  for (const predicate of INSTRUCTION_PREDICATES) {
    const parsed = parseAdditionalInstructions(text, range, {
      defaultPredicate: predicate,
      defaultForce: AdviceForce.Instruction,
      allowFreeTextFallback: true
    });
    const instructions = parsed.map((instruction) => ({
      text: instruction.text,
      coding: instruction.coding,
      frames: instruction.frames
    }));
    const score = instructions.reduce((sum, instruction) =>
      sum + (instruction.coding?.code ? 4 : 0) + (instruction.frames?.length ? 2 : 0) + (instruction.text ? 1 : 0),
      0
    );
    if (score > bestScore) {
      best = instructions;
      bestScore = score;
    }
  }
  return best;
}

function bodyParsesAsStyleInstruction(
  context: HpsgClauseContext,
  bodyTokens: Token[]
): boolean {
  const range = rangeFromTokens(bodyTokens);
  const text = range
    ? context.state.input.slice(range.start, range.end).replace(/\s+/g, " ").trim()
    : joinTokenText(bodyTokens);
  if (!range || !text) {
    return false;
  }
  return parseInstructionCandidates(text, range).some((instruction) =>
    instruction.frames?.some((frame) =>
      !frame.relation &&
      frame.predicate.semanticClass === "administration" &&
      frame.args.length > 0 &&
      frame.args.every((arg) =>
        arg.role === AdviceArgumentRole.Amount || arg.role === AdviceArgumentRole.Free
      )
    )
  );
}

const FREE_TEXT_DIRECTIVE_STARTS = new Set([
  "avoid",
  "do",
  "don't",
  "dont",
  "must",
  "mustn't",
  "mustnt",
  "no",
  "not",
  "should",
  "without"
]);

export function instructionLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.instruction", (context, start) => {
    const first = context.tokens[start];
    if (!first || context.state.consumed.has(first.index)) {
      return [];
    }

    let cursor = start;
    const consumed: Token[] = [];
    while (cursor < context.limit && isInstructionSeparator(context.tokens[cursor])) {
      const separator = context.tokens[cursor];
      if (!separator || context.state.consumed.has(separator.index)) {
        return [];
      }
      consumed.push(separator);
      cursor += 1;
    }
    const sequenceLead = context.tokens[cursor];
    if (
      consumed.length > 0 &&
      sequenceLead &&
      normalizeTokenLower(sequenceLead) === "then"
    ) {
      const next = context.tokens[cursor + 1];
      const nextLower = next ? normalizeTokenLower(next) : "";
      const nextAction = resolveMedicationInstructionAction(nextLower, context.options);
      if (nextAction?.procedural) {
        return [];
      }
      if (nextAction && !nextAction.procedural && METHOD_ACTION_BY_VERB[nextLower]) {
        cursor += 1;
      }
    }
    if (!instructionStartIsLicensed(context, cursor, consumed.length > 0)) {
      return [];
    }
    const firstBodyToken = context.tokens[cursor];
    const firstBodyLower = firstBodyToken ? normalizeTokenLower(firstBodyToken) : "";
    const firstBodyAction = resolveMedicationInstructionAction(firstBodyLower, context.options);
    if (
      !consumed.length &&
      firstBodyAction &&
      !firstBodyAction.procedural &&
      METHOD_ACTION_BY_VERB[firstBodyLower] &&
      isScheduleLead(context, cursor + 1)
    ) {
      return [];
    }
    if (consumed.length && firstBodyAction && !firstBodyAction.procedural && METHOD_ACTION_BY_VERB[firstBodyLower]) {
      const priorPrimaryMethod = context.tokens.slice(0, cursor).some((candidate) => {
        const priorLower = normalizeTokenLower(candidate);
        const method = METHOD_ACTION_BY_VERB[priorLower];
        const definition = resolveMedicationInstructionAction(priorLower, context.options);
        return Boolean(method && definition && !definition.procedural);
      });
      if (!priorPrimaryMethod) return [];
    }

    const bodyTokens: Token[] = [];
    for (; cursor < context.limit; cursor += 1) {
      const token = context.tokens[cursor];
      if (!token || context.state.consumed.has(token.index)) {
        break;
      }
      if (isInstructionSeparator(token) && bodyTokens.length) {
        break;
      }
      if (!bodyTokens.length && isScheduleLead(context, cursor)) {
        return [];
      }
      if (bodyTokens.length && isScheduleLead(context, cursor)) {
        break;
      }
      if (
        bodyTokens.length &&
        SITE_ANCHORS.has(normalizeTokenLower(token)) &&
        bodyParsesAsStyleInstruction(context, bodyTokens)
      ) {
        break;
      }
      bodyTokens.push(token);
    }
    if (!bodyTokens.length) {
      return [];
    }
    const range = rangeFromTokens(bodyTokens);
    const text = range
      ? context.state.input.slice(range.start, range.end).replace(/\s+/g, " ").trim()
      : joinTokenText(bodyTokens);
    if (!range || !text) {
      return [];
    }
    const instructions = parseInstructionCandidates(text, range);
    if (!instructions.length) {
      return [];
    }
    const hasStructuredInstruction = instructions.some((instruction) =>
      instruction.coding?.code || instruction.frames?.length
    );
    const explicitFreeTextDirective = FREE_TEXT_DIRECTIVE_STARTS.has(
      normalizeTokenLower(bodyTokens[0])
    );
    if (!hasStructuredInstruction && !consumed.length && !explicitFreeTextDirective) {
      return [];
    }
    return [
      lexicalSign({
        type: "instruction-sign",
        rule: "hpsg.lex.instruction",
        tokens: [...consumed, ...bodyTokens],
        synsem: {
          head: {},
          valence: { instructions },
          cont: { clauseKind: "administration" }
        },
        score: 8 + instructions.length
      })
    ];
  });
}
