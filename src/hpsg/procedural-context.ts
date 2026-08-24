import { parseInstructionActions } from "../instruction-graph";
import { AdviceArgumentRole, AdvicePolarity, type AdviceFrame } from "../types";
import { resolveMedicationInstructionAction } from "../instruction-action-terminology";
import { relationHasGrammarFeature } from "../relation-terminology";
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
  const enclosing = getProceduralFrames(context)
    .filter((frame) => frame.span.start <= start && end <= frame.span.end)
    .sort((left, right) =>
      (left.span.end - left.span.start) - (right.span.end - right.span.start)
    )[0];
  if (!enclosing) return "administration";
  if (enclosing.polarity === AdvicePolarity.Negate) return "procedure";
  const definition = resolveMedicationInstructionAction(enclosing.predicate.lemma, context.options);
  if (definition?.semanticClass === "administration_pattern") return "administration";
  if (definition && !definition.procedural) return "administration";

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
