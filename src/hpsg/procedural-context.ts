import {
  parseInstructionActions, isSupplementalHydrationInstruction
} from "../instruction-graph";
import { AdviceArgumentRole, AdvicePolarity, EventTiming, type AdviceFrame } from "../types";
import { EVENT_TIMING_TOKENS } from "../maps";
import { resolveMedicationInstructionAction } from "../instruction-action-terminology";
import { ACTION_SEQUENCE_RELATION_SURFACES, relationHasGrammarFeature, relationHasSemanticClass, resolveActionRelationSurface } from "../relation-terminology";
import { medicationGuardForContext, normalizeTokenLower, parseClockToken, type HpsgClauseContext } from "./rule-context";
import { LexKind } from "../lexer/token-types";
import { MEAL_TIMING_BY_RELATION } from "./lexical-classes";
import { explicitDoseLexicalEnd } from "./rules/core-rules";

const PROCEDURAL_FRAME_CACHE = new WeakMap<object, AdviceFrame[]>();

/**
 * Parse procedural semantics once per ParserState and share the result across
 * HPSG lexical constructions. Keeping this cache at the HPSG context layer
 * avoids each rule family independently running the instruction parser.
 */
export function getProceduralFrames(context: HpsgClauseContext): AdviceFrame[] {
  const cached = PROCEDURAL_FRAME_CACHE.get(context.state);
  if (cached) return cached;
  const frames = parseInstructionActions(context.state.input, 0, context.options);
  PROCEDURAL_FRAME_CACHE.set(context.state, frames);
  return frames;
}


/** Existing action-sequence relation shared by condition closure and lexical ownership. */
export function instructionActionsAreSequenced(
  context: HpsgClauseContext, startSource: number, endSource: number
): boolean {
  if (context.state.input.slice(startSource, endSource).includes(",")) return true;
  return context.tokens.some(token => startSource <= token.sourceStart &&
    token.sourceEnd <= endSource && ACTION_SEQUENCE_RELATION_SURFACES.has(normalizeTokenLower(token)));
}

/** Compose the consecutive action daughters selected by one fronted condition. */
export function proceduralInstructionProgram(
  context: HpsgClauseContext, firstTargetIndex: number, frames: AdviceFrame[]
): AdviceFrame[] {
  const result = [frames[firstTargetIndex]];
  let previous = frames[firstTargetIndex];
  for (let index = firstTargetIndex + 1; index < frames.length; index += 1) {
    const next = frames[index];
    const gap = context.state.input.slice(previous.span.end, next.span.start);
    if (/[.!?;]/u.test(gap) ||
        !instructionActionsAreSequenced(context, previous.span.end, next.span.start)) break;
    result.push(next);
    previous = next;
  }
  return result;
}

const CONDITIONAL_ADVICE_CACHE = new WeakMap<object, Map<number, AdviceFrame[]>>();

/** One source ownership map shared by PRN, timing and conditional-advice
 * constructions. A complete new dose remains an administration. An undosed
 * action consequent (contact a clinician, take with food) owns its condition
 * and temporal complements rather than changing the standing dose to PRN.
 * @param context Existing token stream and cached action daughters.
 */
function conditionalAdviceOwners(context: HpsgClauseContext): Map<number, AdviceFrame[]> {
  const cached = CONDITIONAL_ADVICE_CACHE.get(context.state);
  if (cached) return cached;
  const owners = new Map<number, AdviceFrame[]>();
  CONDITIONAL_ADVICE_CACHE.set(context.state, owners);
  let frames: AdviceFrame[] | undefined;
  for (const token of context.tokens) {
    const relation = resolveActionRelationSurface(token.canonical ?? token.lower);
    if (!relationHasGrammarFeature(relation, "conditionalTail")) continue;
    frames ??= getProceduralFrames(context);
    const frame = frames.find(candidate => candidate.span.start >= token.sourceEnd &&
      !context.tokens.some(boundary => boundary.sourceStart >= token.sourceEnd &&
        boundary.sourceEnd <= candidate.span.start && /^[;.!?]$/u.test(boundary.original)));
    if (!frame) continue;
    // A registered action word inside the typed predicate is not its consequent.
    const guard = medicationGuardForContext(context);
    if (guard && guard.start === token.sourceStart && frame.span.start < guard.end) continue;
    const definition = resolveMedicationInstructionAction(frame.predicate.lemma, context.options);
    const procedural = definition?.procedural && !definition.primaryAdministrationHead;
    const undosedAction = definition && frame.args.length > 0 && !frame.args.some(argument =>
      argument.role === AdviceArgumentRole.Amount || argument.role === AdviceArgumentRole.Site);
    if (undosedAction && !procedural) {
      // A dose nominal can precede its verb in a fronted conditional. It is
      // still an administration daughter, not part of the condition/advice.
      const headIndex = context.tokens.findIndex(candidate => candidate.sourceStart >= frame.span.start);
      let clauseStart = 0;
      for (const boundary of context.tokens) {
        if (boundary.sourceEnd > frame.span.start) break;
        // A delimited antecedent owns its own nominals ("if you miss a dose,").
        // Only an amount after that delimiter can be a fronted argument of
        // the following administration head.
        if (/^[,;.!?]$/u.test(boundary.original)) clauseStart = boundary.sourceEnd;
      }
      const hasFrontedDose = context.tokens.some((candidate, index) => {
        if (candidate.sourceStart < clauseStart || index >= headIndex) return false;
        const end = explicitDoseLexicalEnd(context.tokens, index, context.options, headIndex);
        if (end === undefined) return false;
        // A preceding complete administration owns its own amount; it does
        // not turn a later undosed counseling action into a fresh dose.
        return !frames!.some(previous => previous !== frame &&
          previous.span.start <= candidate.sourceStart &&
          previous.span.end >= context.tokens[end - 1].sourceEnd &&
          previous.args.some(argument => argument.role === AdviceArgumentRole.Amount));
      });
      if (hasFrontedDose) continue;
    }
    if (procedural || undosedAction) {
      owners.set(token.index, proceduralInstructionProgram(context, frames.indexOf(frame), frames));
    }
  }
  return owners;
}

/** Return the conditional's existing action owner, if it is advice rather
 * than a newly quantified administration. */
export function conditionalAdviceOwnerAt(context: HpsgClauseContext, index: number): AdviceFrame | undefined {
  const token = context.tokens[index];
  if (!token || !relationHasGrammarFeature(
      resolveActionRelationSurface(token.canonical ?? token.lower), "conditionalTail")) return undefined;
  return conditionalAdviceOwners(context).get(index)?.[0];
}

/** Whether this existing action daughter is governed as conditional advice. */
export function isConditionalAdviceFrame(context: HpsgClauseContext, frame: AdviceFrame): boolean {
  if (frame.args.some(argument => argument.role === AdviceArgumentRole.Amount ||
      argument.role === AdviceArgumentRole.Site)) return false;
  for (const program of conditionalAdviceOwners(context).values()) if (program.indexOf(frame) >= 0) return true;
  return false;
}

/** Resolve attachment for an already recognized temporal activity nominal.
 * A fronted adjunct lies outside its following procedure's own action span. */
export function followingProcedureOwnsTemporalAdjunct(
  context: HpsgClauseContext,
  start: number,
  end: number
): boolean {
  const frames = getProceduralFrames(context);
  if (frames.some(frame => frame.span.start <= start && end <= frame.span.end)) return false;
  const following = frames.find(frame => frame.span.start >= end &&
    /^[\s,:]*$/u.test(context.state.input.slice(end, frame.span.start)));
  return Boolean(following &&
    sourceRangeAttachmentClass(context, following.span.start, following.span.end) === "procedure");
}

/** A later unquantified meal directive describes the existing fixed doses.
 * Separate quantified administrations and directives with their own clocks
 * remain executable administration daughters, not counseling.
 * @param context Source-local HPSG clause and its existing clock lexemes.
 * @param frame The already recognized administration action daughter.
 * @param frames Shared source action frames used to exclude procedural clocks.
 */
function isFixedClockMealCounsel(
  context: HpsgClauseContext, frame: AdviceFrame, frames: readonly AdviceFrame[]
): boolean {
  if (frame.predicate.semanticClass !== "administration" ||
      frame.args.some(arg => arg.role === AdviceArgumentRole.Amount || arg.role === AdviceArgumentRole.Site)) return false;
  let hasMealAdjunct = false;
  for (const [relation, events] of MEAL_TIMING_BY_RELATION) {
    if (frame.relation !== relation) continue;
    for (const event of events.keys()) {
      if (frame.args.some(arg => arg.role === AdviceArgumentRole.Time && arg.normalized === event)) {
        hasMealAdjunct = true;
        break;
      }
    }
  }
  if (!hasMealAdjunct) return false;
  const isClock = (index: number) => context.tokens[index].kind === LexKind.TimeLike &&
    parseClockToken(context.tokens[index]) !== undefined;
  if (context.tokens.some((token, index) => token.sourceStart >= frame.span.start &&
      token.sourceEnd <= frame.span.end && isClock(index))) return false;
  let boundary = -1;
  for (const token of context.tokens) {
    if (token.sourceEnd > frame.span.start) break;
    if (/^[;.!?]$/u.test(token.original)) boundary = token.sourceStart;
  }
  if (boundary < 0) return false;
  return context.tokens.some((token, index) => token.sourceEnd <= boundary && isClock(index) &&
    !frames.some(owner => {
      if (owner.span.start > token.sourceStart || owner.span.end < token.sourceEnd) return false;
      const definition = resolveMedicationInstructionAction(owner.predicate.lemma, context.options);
      return definition?.procedural && !definition.primaryAdministrationHead;
    }));
}

export type HpsgAttachmentClass = "administration" | "procedure";

export function sourceRangeAttachmentClass(
  context: HpsgClauseContext,
  start: number,
  end: number
): HpsgAttachmentClass {
  const frames = getProceduralFrames(context);
  const enclosing = frames
    .filter((frame) => frame.span.start <= start && end <= frame.span.end)
    .sort((left, right) =>
      (left.span.end - left.span.start) - (right.span.end - right.span.start)
    )[0];
  if (!enclosing) {
    // A bare cadence such as "daily" scopes the medication, even when a
    // preceding auxiliary covering step is locally procedural. Only an
    // exact immediate EVENT lexical daughter can attach across a short gap
    // without an explicit source action range.
    const standaloneEvent = context.tokens.some(token =>
      token.sourceStart <= start && end <= token.sourceEnd &&
      EVENT_TIMING_TOKENS[token.canonical ?? token.lower] === EventTiming.Immediate
    );
    if (!standaloneEvent) return "administration";
    // A temporal adverb may be the next daughter of a scoped procedural
    // predicate even when the action frame's own source span ends at its verb.
    // The closest preceding HPSG action owns it when no other clause or
    // unrelated text intervenes. "Take 1 tab immediately" remains a regimen
    // event, while "do not lie down immediately" modifies the prohibition.
    let nearest: AdviceFrame | undefined;
    for (const frame of frames) {
      if (frame.span.end > start || frame.span.start >= start ||
          context.state.input.slice(frame.span.end, start).trim()) continue;
      if (!nearest || frame.span.end > nearest.span.end) nearest = frame;
    }
    if (nearest) {
      const definition = resolveMedicationInstructionAction(
        nearest.predicate.lemma, context.options
      );
      if (nearest.polarity === AdvicePolarity.Negate ||
          (definition?.procedural && !definition.primaryAdministrationHead)) {
        return "procedure";
      }
    }
    return "administration";
  }
  if (enclosing.polarity === AdvicePolarity.Negate || isConditionalAdviceFrame(context, enclosing) ||
      isFixedClockMealCounsel(context, enclosing, frames)) return "procedure";
  const definition = resolveMedicationInstructionAction(enclosing.predicate.lemma, context.options);
  if (definition?.semanticClass === "administration_pattern") return "administration";
  if (definition && !definition.procedural &&
      !isSupplementalHydrationInstruction(enclosing)) return "administration";

  const relationCanAttachLocally = relationHasGrammarFeature(enclosing.relation, "activityFallback");
  const priorAdministrationCandidate = relationCanAttachLocally && getProceduralFrames(context).some((frame) => {
    if (frame === enclosing || frame.span.start >= enclosing.span.start || frame.polarity === AdvicePolarity.Negate) {
      return false;
    }
    const priorDefinition = resolveMedicationInstructionAction(frame.predicate.lemma, context.options);
    return Boolean(
      priorDefinition && (
        !priorDefinition.procedural ||
        priorDefinition.primaryAdministrationHead ||
        frame.args.some((arg) => arg.role === AdviceArgumentRole.Site)
      )
    );
  });
  if (priorAdministrationCandidate) return "procedure";

  const localActivityRelation = relationCanAttachLocally &&
    enclosing.args.some((arg) => arg.role === AdviceArgumentRole.Activity);
  if (localActivityRelation) return "procedure";

  if (definition?.primaryAdministrationHead && definition.semanticClass === "cleanse") {
    const priorFrames = getProceduralFrames(context)
      .filter((frame) => frame.span.end <= enclosing.span.start && frame.polarity !== AdvicePolarity.Negate)
      .sort((left, right) => left.span.end - right.span.end);
    const retention = priorFrames.slice().reverse().find((frame) =>
      resolveMedicationInstructionAction(frame.predicate.lemma, context.options)?.semanticClass === "retain"
    );
    if (retention) {
      const administrationBeforeRetention = priorFrames.some((frame) => {
        if (frame.span.end > retention.span.start) return false;
        const priorDefinition = resolveMedicationInstructionAction(frame.predicate.lemma, context.options);
        return Boolean(priorDefinition && (
          !priorDefinition.procedural || priorDefinition.primaryAdministrationHead
        ));
      });
      if (administrationBeforeRetention) return "procedure";
    }
  }

  if (definition?.primaryAdministrationHead) return "administration";
  return enclosing.args.some((arg) => arg.role === AdviceArgumentRole.Site)
    ? "administration"
    : "procedure";
}


/** A temporal linker between two complete action events is not an opaque condition. */
export function actionEventRelationAt(context: HpsgClauseContext, index: number) {
  const token = context.tokens[index];
  if (!token) return undefined;
  const relation = resolveActionRelationSurface(token.lower);
  if (!relation || !relationHasSemanticClass(relation, "temporal")) return undefined;
  const frames = getProceduralFrames(context);
  const left = frames.find(frame => frame.span.end <= token.sourceStart &&
    !context.state.input.slice(frame.span.end, token.sourceStart).trim());
  const right = frames.find(frame => frame.span.start >= token.sourceEnd &&
    !context.state.input.slice(token.sourceEnd, frame.span.start).trim());
  if (!left || !right || !right.args.some(arg => arg.role === AdviceArgumentRole.Amount && arg.quantity)) return undefined;
  return relation;
}
