import { resolveBodySitePhrase } from "./body-site-grammar";
import {
  medicationInstructionActionCodings,
  resolveMedicationInstructionAction
} from "./instruction-action-terminology";
import {
  medicationInstructionConceptCodings,
  resolveMedicationInstructionConcept
} from "./instruction-concept-terminology";
import { refreshInstructionGraphDerivedState } from "./instruction-graph";
import { ParserState } from "./parser-state";
import {
  AdviceArgument,
  AdviceArgumentRole,
  AdviceForce,
  AdviceFrame,
  AdvicePolarity,
  CanonicalInstructionGraph,
  CanonicalSourceSpan,
  InstructionSemanticActionProposal,
  InstructionSemanticArgumentProposal,
  InstructionSemanticResolution,
  InstructionSemanticResolver,
  InstructionSemanticResolverRequest,
  ParseOptions,
  TextRange
} from "./types";
import { normalizeUnit } from "./unit-lexicon";

function toArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function isPromise<T>(value: unknown): value is Promise<T> {
  return !!value && typeof (value as { then?: unknown }).then === "function";
}

function cloneGraph(graph: CanonicalInstructionGraph): CanonicalInstructionGraph {
  return JSON.parse(JSON.stringify(graph)) as CanonicalInstructionGraph;
}

function validRelativeRange(range: TextRange, sourceLength: number): boolean {
  return Number.isInteger(range.start) &&
    Number.isInteger(range.end) &&
    range.start >= 0 &&
    range.end > range.start &&
    range.end <= sourceLength;
}

function absoluteRange(relative: TextRange, base: CanonicalSourceSpan): TextRange {
  return {
    start: base.start + relative.start,
    end: base.start + relative.end
  };
}

function rangeContains(outer: TextRange, inner: TextRange): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}

function finiteOptional(value: number | undefined): boolean {
  return value === undefined || Number.isFinite(value);
}

function validatedQuantity(
  proposal: InstructionSemanticArgumentProposal,
  options?: ParseOptions
): AdviceArgument["quantity"] | undefined | false {
  const quantity = proposal.quantity;
  if (!quantity) return undefined;
  if (!finiteOptional(quantity.value) || !finiteOptional(quantity.low) || !finiteOptional(quantity.high)) {
    return false;
  }
  if (
    quantity.value === undefined &&
    quantity.low === undefined &&
    quantity.high === undefined
  ) {
    return false;
  }
  if (
    quantity.low !== undefined &&
    quantity.high !== undefined &&
    quantity.high < quantity.low
  ) {
    return false;
  }
  const unit = quantity.unit ? normalizeUnit(quantity.unit, options) : undefined;
  if (quantity.unit && !unit) return false;
  return {
    value: quantity.value,
    range: quantity.low !== undefined || quantity.high !== undefined
      ? { low: quantity.low, high: quantity.high }
      : undefined,
    unit
  };
}

function buildBodySiteArgument(
  proposal: InstructionSemanticArgumentProposal,
  sourceText: string,
  absolute: TextRange,
  options?: ParseOptions
): AdviceArgument | undefined {
  const probe = proposal.concept ?? sourceText;
  const resolved = resolveBodySitePhrase(probe, options?.siteCodeMap, {
    bodySiteContext: options?.context?.bodySiteContext
  });
  if (!resolved || (!resolved.coding && !resolved.definition)) return undefined;
  return {
    role: proposal.role,
    text: sourceText,
    normalized: resolved.canonical,
    conceptId: resolved.canonical,
    coding: resolved.coding,
    codings: resolved.coding ? [resolved.coding] : undefined,
    i18n: {
      en: resolved.englishObjectText,
      ...(resolved.definition?.i18n ?? {}),
      ...(/[\u0E00-\u0E7F]/.test(sourceText) ? { th: sourceText } : {})
    },
    span: absolute
  };
}

function buildConceptArgument(
  proposal: InstructionSemanticArgumentProposal,
  sourceText: string,
  absolute: TextRange,
  options?: ParseOptions
): AdviceArgument | undefined {
  if (!proposal.concept) return undefined;
  const definition = resolveMedicationInstructionConcept(proposal.concept, options);
  if (!definition) return undefined;
  const codings = medicationInstructionConceptCodings(definition);
  const preferred = definition.coding
    ? codings[0]
    : definition.externalCodings?.length
      ? codings[1]
      : codings[0];
  return {
    role: proposal.role,
    text: sourceText,
    normalized: definition.display,
    conceptId: definition.code,
    coding: preferred,
    codings,
    i18n: { en: definition.display, ...(definition.i18n ?? {}) },
    span: absolute
  };
}

function validateArgumentProposal(
  proposal: InstructionSemanticArgumentProposal,
  opaque: CanonicalSourceSpan,
  actionRelativeRange: TextRange,
  options?: ParseOptions
): AdviceArgument | undefined {
  if (!validRelativeRange(proposal.range, opaque.text.length)) return undefined;
  if (!rangeContains(actionRelativeRange, proposal.range)) return undefined;
  const absolute = absoluteRange(proposal.range, opaque);
  const sourceText = opaque.text.slice(proposal.range.start, proposal.range.end);
  if (!sourceText.trim()) return undefined;

  const quantity = validatedQuantity(proposal, options);
  if (quantity === false) return undefined;
  if (quantity) {
    return {
      role: proposal.role,
      text: sourceText,
      normalized: quantity.unit,
      quantity,
      span: absolute
    };
  }

  if (proposal.role === AdviceArgumentRole.Site || proposal.role === AdviceArgumentRole.Destination) {
    return buildBodySiteArgument(proposal, sourceText, absolute, options);
  }
  const concept = buildConceptArgument(proposal, sourceText, absolute, options);
  if (concept) return concept;
  if (!proposal.concept && proposal.role === AdviceArgumentRole.Free) {
    return {
      role: AdviceArgumentRole.Free,
      text: sourceText,
      normalized: sourceText.trim().toLowerCase(),
      span: absolute
    };
  }
  return undefined;
}


function validateActionProposal(
  proposal: InstructionSemanticActionProposal,
  opaque: CanonicalSourceSpan,
  options?: ParseOptions
): AdviceFrame | undefined {
  if (!validRelativeRange(proposal.range, opaque.text.length)) return undefined;
  const definition = resolveMedicationInstructionAction(proposal.action, options);
  if (!definition?.procedural) return undefined;
  if (
    proposal.confidence !== undefined &&
    (!Number.isFinite(proposal.confidence) || proposal.confidence < 0 || proposal.confidence > 1)
  ) {
    return undefined;
  }

  const args: AdviceArgument[] = [];
  for (const argProposal of proposal.args ?? []) {
    const argument = validateArgumentProposal(argProposal, opaque, proposal.range, options);
    if (!argument) return undefined;
    args.push(argument);
  }

  const absolute = absoluteRange(proposal.range, opaque);
  const sourceText = opaque.text.slice(proposal.range.start, proposal.range.end);
  return {
    force: proposal.polarity === AdvicePolarity.Negate
      ? AdviceForce.Warning
      : AdviceForce.Sequence,
    polarity: proposal.polarity,
    predicate: {
      lemma: definition.code,
      semanticClass: definition.semanticClass,
      display: definition.display,
      i18n: definition.i18n ? { ...definition.i18n } : undefined,
      codings: medicationInstructionActionCodings(definition)
    },
    args,
    span: absolute,
    sourceText,
    origin: "semantic-resolver",
    confidence: proposal.confidence
  };
}

function actionsOverlap(left: AdviceFrame, right: AdviceFrame): boolean {
  return left.span.start < right.span.end && right.span.start < left.span.end;
}

function validatedResolutionActions(
  resolution: InstructionSemanticResolution,
  opaque: CanonicalSourceSpan,
  graph: CanonicalInstructionGraph,
  options?: ParseOptions
): AdviceFrame[] {
  const accepted: AdviceFrame[] = [];
  for (const proposal of resolution.actions ?? []) {
    const frame = validateActionProposal(proposal, opaque, options);
    if (!frame) continue;
    if (graph.actions.some((existing) => actionsOverlap(existing, frame))) continue;
    if (accepted.some((existing) => actionsOverlap(existing, frame))) continue;
    accepted.push(frame);
  }
  accepted.sort((left, right) => left.span.start - right.span.start || left.span.end - right.span.end);
  return accepted;
}

function trimResidual(
  input: string,
  start: number,
  end: number
): CanonicalSourceSpan | undefined {
  while (start < end && /[\s,;:.()]/.test(input[start] ?? "")) start += 1;
  while (end > start && /[\s,;:.()]/.test(input[end - 1] ?? "")) end -= 1;
  if (end <= start) return undefined;
  const text = input.slice(start, end);
  const normalized = text.trim().toLowerCase();
  if (
    normalized === "and" ||
    normalized === "then" ||
    normalized === "and then" ||
    normalized === "แล้ว" ||
    normalized === "แล้วจึง" ||
    normalized === "จากนั้น" ||
    normalized === "ต่อมา"
  ) {
    return undefined;
  }
  return { start, end, text };
}

function subtractResolvedActionsFromOpaque(
  input: string,
  opaque: CanonicalSourceSpan,
  actions: AdviceFrame[]
): CanonicalSourceSpan[] {
  const residual: CanonicalSourceSpan[] = [];
  let cursor = opaque.start;
  for (const action of actions) {
    if (action.span.start > cursor) {
      const span = trimResidual(input, cursor, action.span.start);
      if (span) residual.push(span);
    }
    cursor = Math.max(cursor, action.span.end);
  }
  if (cursor < opaque.end) {
    const span = trimResidual(input, cursor, opaque.end);
    if (span) residual.push(span);
  }
  return residual;
}

function applyValidatedActions(
  graph: CanonicalInstructionGraph,
  opaque: CanonicalSourceSpan,
  actions: AdviceFrame[]
): void {
  if (!actions.length) return;
  graph.actions.push(...actions);
  const remaining: CanonicalSourceSpan[] = [];
  for (const existing of graph.opaqueSpans ?? []) {
    if (existing.start === opaque.start && existing.end === opaque.end) {
      remaining.push(...subtractResolvedActionsFromOpaque(graph.sourceText, existing, actions));
    } else {
      remaining.push(existing);
    }
  }
  graph.opaqueSpans = remaining.length ? remaining : undefined;
  refreshInstructionGraphDerivedState(graph);
}

function requestForOpaque(
  internal: ParserState,
  graph: CanonicalInstructionGraph,
  opaque: CanonicalSourceSpan,
  options?: ParseOptions
): InstructionSemanticResolverRequest {
  return {
    inputText: internal.input,
    sourceText: opaque.text,
    range: { start: opaque.start, end: opaque.end },
    locale: options?.locale,
    context: options?.context,
    existingGraph: cloneGraph(graph)
  };
}

function addResolverWarning(internal: ParserState): void {
  const warning = "Instruction semantic resolver failed; opaque clinician text was preserved.";
  if (internal.warnings.indexOf(warning) === -1) internal.warnings.push(warning);
}

function applyResolutionIfValid(
  internal: ParserState,
  graph: CanonicalInstructionGraph,
  opaque: CanonicalSourceSpan,
  resolution: InstructionSemanticResolution | null | undefined,
  options?: ParseOptions
): boolean {
  if (!resolution) return false;
  const actions = validatedResolutionActions(resolution, opaque, graph, options);
  if (!actions.length) return false;
  applyValidatedActions(graph, opaque, actions);
  internal.primaryClause.instructionGraph = graph;
  return true;
}

export function applyInstructionSemanticResolvers(
  internal: ParserState,
  options?: ParseOptions
): void {
  const resolvers = toArray(options?.instructionSemanticResolvers);
  const graph = internal.primaryClause.instructionGraph;
  if (!resolvers.length || !graph?.opaqueSpans?.length) return;
  const opaqueSnapshot = graph.opaqueSpans.map((span) => ({ ...span }));

  for (const opaque of opaqueSnapshot) {
    for (const resolver of resolvers) {
      try {
        const result = resolver(requestForOpaque(internal, graph, opaque, options));
        if (isPromise(result)) {
          throw new Error(
            "Instruction semantic resolver returned a Promise; use parseSigAsync for asynchronous semantic resolution."
          );
        }
        if (applyResolutionIfValid(internal, graph, opaque, result, options)) break;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("use parseSigAsync")
        ) {
          throw error;
        }
        addResolverWarning(internal);
      }
    }
  }
}

export async function applyInstructionSemanticResolversAsync(
  internal: ParserState,
  options?: ParseOptions
): Promise<void> {
  const resolvers = toArray(options?.instructionSemanticResolvers);
  const graph = internal.primaryClause.instructionGraph;
  if (!resolvers.length || !graph?.opaqueSpans?.length) return;
  const opaqueSnapshot = graph.opaqueSpans.map((span) => ({ ...span }));

  for (const opaque of opaqueSnapshot) {
    for (const resolver of resolvers) {
      try {
        const result = await resolver(requestForOpaque(internal, graph, opaque, options));
        if (applyResolutionIfValid(internal, graph, opaque, result, options)) break;
      } catch {
        addResolverWarning(internal);
      }
    }
  }
}
