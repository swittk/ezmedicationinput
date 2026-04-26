import { EVENT_TIMING_TOKENS } from "../../maps";
import { parseAdditionalInstructions } from "../../advice";
import { LexKind } from "../../lexer/token-types";
import { Token } from "../../parser-state";
import { AdviceForce, CanonicalAdditionalInstructionExpr } from "../../types";
import { mapIntervalUnit } from "../timing-lexicon";
import {
  INSTRUCTION_LEADING_SEPARATORS,
  INSTRUCTION_START_WORDS,
  LIST_SEPARATORS,
  MEAL_RELATION_BY_TOKEN,
  WORKFLOW_CONTINUATION_LICENSES,
  WORKFLOW_NOUNS,
  WORKFLOW_START_WORDS
} from "../lexical-classes";
import { METHOD_ACTION_BY_VERB } from "../method-lexicon";
import {
  HpsgClauseContext,
  joinTokenText,
  lexicalRule,
  normalizeTokenLower,
  rangeFromTokens
} from "../rule-context";
import { HpsgLexicalRule, lexicalSign } from "../signature";
import { isScheduleLead } from "./timing-rules";

const INSTRUCTION_PREDICATES = ["take", "apply", "use"] as const;

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
      if (bodyTokens.length && isInstructionSeparator(token)) {
        break;
      }
      if (
        bodyTokens.length &&
        isScheduleLead(context, cursor) &&
        !(bodyTokens[bodyTokens.length - 1]?.kind === LexKind.Number && mapIntervalUnit(lower)) &&
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
    const text = joinTokenText(bodyTokens);
    if (!text) {
      return [];
    }
    return [
      lexicalSign({
        type: "instruction-sign",
        rule: "hpsg.lex.patientInstruction.workflow",
        tokens: [...consumed, ...bodyTokens],
        synsem: {
          head: {},
          valence: { patientInstruction: { text } },
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
    if (!instructionStartIsLicensed(context, cursor, consumed.length > 0)) {
      return [];
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
    if (!hasStructuredInstruction && !consumed.length) {
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
