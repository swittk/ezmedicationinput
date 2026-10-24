import {
  parseInstructionActions, isSupplementalHydrationInstruction
} from "../instruction-graph";
import { AdviceArgumentRole, AdvicePolarity, EventTiming, type AdviceFrame } from "../types";
import { EVENT_TIMING_TOKENS } from "../maps";
import { resolveMedicationInstructionAction } from "../instruction-action-terminology";
import { relationHasGrammarFeature, relationHasSemanticClass, resolveActionRelationSurface } from "../relation-terminology";
import type { HpsgClauseContext } from "./rule-context";

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
  if (enclosing.polarity === AdvicePolarity.Negate) return "procedure";
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
