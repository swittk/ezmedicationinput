import type { HpsgClauseContext } from "./rule-context";
import { normalizeTokenLower } from "./rule-context";
import { getProceduralFrames } from "./procedural-context";
import { resolveMedicationInstructionAction } from "../instruction-action-terminology";

const LEADING_CONDITIONALS = new Set(["if", "unless", "when"]);

export interface ConditionalProgramContext {
  leadStart: number;
  firstActionStart: number;
}

export function getLeadingConditionalProgram(
  context: HpsgClauseContext
): ConditionalProgramContext | undefined {
  let firstToken = context.tokens[0];
  let index = 0;
  while (firstToken && /^[.;,()]+$/.test(firstToken.original)) {
    index += 1;
    firstToken = context.tokens[index];
  }
  if (!firstToken || !LEADING_CONDITIONALS.has(normalizeTokenLower(firstToken))) return undefined;
  const frames = getProceduralFrames(context)
    .filter((frame) => frame.span.start >= firstToken.sourceEnd)
    .slice()
    .sort((left, right) => left.span.start - right.span.start);
  if (!frames.length) return undefined;
  const firstDefinition = resolveMedicationInstructionAction(frames[0].predicate.lemma, context.options);
  if (!firstDefinition?.procedural) return undefined;
  return { leadStart: firstToken.sourceStart, firstActionStart: frames[0].span.start };
}

export function sourceRangeIsInsideLeadingConditionalProgram(
  context: HpsgClauseContext,
  start: number,
  end: number
): boolean {
  const program = getLeadingConditionalProgram(context);
  return Boolean(program && start >= program.firstActionStart && end >= start);
}
