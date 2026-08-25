import { lexInput } from "../lexer/lex";
import { annotateLexTokens } from "../lexer/meaning";
import { Token } from "../parser-state";
import { findUnparsedTokenGroups, parseClauseState } from "../parser";
import { parseAdditionalInstructions } from "../advice";
import { parseInstructionActions } from "../instruction-graph";
import { resolveMedicationInstructionAction } from "../instruction-action-terminology";
import { normalizeUnit } from "../unit-lexicon";
import { AdviceForce, AdviceFrame, ParseOptions } from "../types";
import {
  ACTION_COORDINATION_CONNECTORS,
  ACTION_SEQUENCE_MARKERS,
  CLAUSE_LEAD_WORDS,
  HARD_SEGMENT_BOUNDARY_TOKENS,
  LATERAL_MODIFIER_WORDS,
  MERIDIEM_TOKENS
} from "./lexical-classes";

export interface HpsgSigSegment {
  text: string;
  start: number;
  end: number;
}

function isBoundaryToken(token: Token): boolean {
  const text = token.original.trim().toLowerCase();
  return HARD_SEGMENT_BOUNDARY_TOKENS.has(text) || text === "\n" || text === "\r";
}

function parsesAsInstructionContinuation(input: string, tokens: Token[], index: number): boolean {
  const lead = tokens[index + 1];
  const firstInstructionToken = tokens[index + 2];
  if (!lead || !firstInstructionToken || !CLAUSE_LEAD_WORDS.has(lead.lower.replace(/[.,;:]/g, ""))) {
    return false;
  }
  const start = firstInstructionToken.sourceStart;
  let end = input.length;
  for (let cursor = index + 2; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor];
    if (cursor > index + 2 && token.original === ",") {
      end = token.sourceStart;
      break;
    }
  }
  const text = input.slice(start, end).replace(/\s+/g, " ").trim();
  if (!text) {
    return false;
  }
  const instructions = parseAdditionalInstructions(text, { start, end }, {
    defaultPredicate: lead.lower.replace(/[.,;:]/g, "") || "take",
    defaultForce: AdviceForce.Instruction,
    allowFreeTextFallback: false
  });
  return instructions.some((instruction) => instruction.coding?.code || instruction.frames.length);
}

function commaJoinsProceduralSequence(
  token: Token,
  actions: AdviceFrame[],
  options?: ParseOptions
): boolean {
  let previous: AdviceFrame | undefined;
  let next: AdviceFrame | undefined;
  for (const action of actions) {
    if (
      action.span.start < token.sourceStart &&
      action.span.end <= token.sourceEnd + 1
    ) {
      if (!previous || action.span.end > previous.span.end) previous = action;
      continue;
    }
    if (action.span.start >= token.sourceEnd) {
      if (!next || action.span.start < next.span.start) next = action;
    }
  }
  if (!previous || !next) return false;
  const previousDefinition = resolveMedicationInstructionAction(previous.predicate.lemma, options);
  if (!previousDefinition?.procedural) return false;
  const gapBefore = Math.max(0, token.sourceStart - previous.span.end);
  const gapAfter = Math.max(0, next.span.start - token.sourceEnd);
  return gapBefore <= 2 && gapAfter <= 2;
}

function hasMeaningfulSchedule(state: ReturnType<typeof parseClauseState>): boolean {
  const schedule = state.primaryClause.schedule;
  return Boolean(schedule && (
    schedule.frequency !== undefined ||
    schedule.frequencyMax !== undefined ||
    schedule.period !== undefined ||
    schedule.periodMax !== undefined ||
    schedule.duration !== undefined ||
    schedule.durationMax !== undefined ||
    schedule.count !== undefined ||
    schedule.timingCode ||
    schedule.dayOfWeek?.length ||
    schedule.when?.length ||
    schedule.timeOfDay?.length
  ));
}

function hasAdministrationHead(state: ReturnType<typeof parseClauseState>): boolean {
  const clause = state.primaryClause;
  return Boolean(
    clause.method?.coding?.code || clause.method?.text ||
    clause.dose?.value !== undefined || clause.dose?.range ||
    clause.site?.coding?.code || clause.site?.text ||
    clause.patientInstruction || clause.additionalInstructions?.length
  );
}

function nextSegmentationProbeEnd(
  input: string,
  tokens: Token[],
  commaIndex: number
): number {
  for (let cursor = commaIndex + 1; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor];
    if (!token) continue;
    if (cursor > commaIndex + 1 && (
      token.original === "," ||
      isBoundaryToken(token) ||
      isSlashClauseBoundary(tokens, cursor)
    )) return token.sourceStart;
  }
  return input.length;
}

/**
 * A comma before a clause-leading head is not a clause boundary when the
 * material before it is a licensed fronted adjunct/condition and HPSG can
 * compose that material with the following administration as one complete
 * clause. This keeps segmentation from defeating the grammar's symmetric
 * head-adjunct/conditional linearization.
 */
function commaContinuesFrontedHpsgClause(
  input: string,
  tokens: Token[],
  index: number,
  segmentStart: number,
  options?: ParseOptions
): boolean {
  const comma = tokens[index];
  if (!comma || comma.original !== ",") return false;
  const prefixText = input.slice(segmentStart, comma.sourceStart).trim();
  if (!prefixText) return false;

  const probeEnd = nextSegmentationProbeEnd(input, tokens, index);
  const fullText = input.slice(segmentStart, probeEnd).trim();
  if (!fullText) return false;

  const prefix = parseClauseState(prefixText, options);
  const prefixClause = prefix.primaryClause;
  const frontedAdjunct = !hasAdministrationHead(prefix) && (
    prefixClause.prn?.enabled === true || hasMeaningfulSchedule(prefix)
  );

  const full = parseClauseState(fullText, options);
  if (findUnparsedTokenGroups(full).length || !hasAdministrationHead(full)) return false;
  const commaOffset = comma.sourceStart - segmentStart;
  const frontedCondition = full.primaryClause.evidence.some((item) =>
    item.rule === "hpsg.lex.condition" &&
    item.spans.some((span) => span.start < commaOffset)
  );
  return frontedAdjunct || frontedCondition;
}

function isCommaClauseBoundary(
  input: string,
  tokens: Token[],
  index: number,
  actions: AdviceFrame[],
  options?: ParseOptions,
  segmentStart = 0
): boolean {
  const token = tokens[index];
  if (!token || token.original !== ",") {
    return false;
  }
  if (commaJoinsProceduralSequence(token, actions, options)) {
    return false;
  }
  const next = tokens[index + 1];
  if (!next) {
    return false;
  }
  const lower = next.lower.replace(/[.,;:]/g, "");
  const rawLower = next.lower.replace(/^\.+|\.+$/g, "");
  const following = tokens[index + 2]?.lower.replace(/^\.+|\.+$/g, "");
  if (
    /^[0-9]{1,2}[:.][0-9]{2}$/.test(rawLower) ||
    (/^[0-9]{1,2}$/.test(rawLower) && Boolean(following && MERIDIEM_TOKENS.has(following)))
  ) {
    return false;
  }
  if (/^\d/.test(lower)) {
    return true;
  }
  if (LATERAL_MODIFIER_WORDS.has(lower) && (!following || !/^\d/.test(following))) {
    return false;
  }
  if (!CLAUSE_LEAD_WORDS.has(lower)) {
    return false;
  }
  if (parsesAsInstructionContinuation(input, tokens, index)) {
    return false;
  }
  if (commaContinuesFrontedHpsgClause(input, tokens, index, segmentStart, options)) {
    return false;
  }
  return true;
}

function nextContinuationProbeEnd(
  input: string,
  tokens: Token[],
  startIndex: number
): number {
  for (let index = startIndex; index < tokens.length; index += 1) {
    const current = tokens[index];
    if (!current) continue;
    const lower = normalizeSegmentLexeme(current);
    if (
      current.original === "," || current.original === ";" ||
      current.original === "." || current.original === "!" || current.original === "?" ||
      isBoundaryToken(current) || isSlashClauseBoundary(tokens, index) ||
      (index > startIndex && (ACTION_SEQUENCE_MARKERS.has(lower) || ACTION_COORDINATION_CONNECTORS.has(lower)))
    ) return current.sourceStart;
  }
  return input.length;
}

function normalizeSegmentLexeme(item: Token): string {
  return (item.canonical ?? item.lower).replace(/^[.,;:]+|[.,;:]+$/g, "");
}

/**
 * Split omitted-head administration continuations such as
 * `take 1 tab at 12:00, then 2 tabs at 16:00, and 1.5 tabs before sleep`.
 * The continuation must contain a typed dose and either structured timing or
 * its own explicit administration head, so ordinary `wash and rinse` prose is
 * not segmented here.
 */
function scheduleOnlyAdministrationContinuation(
  input: string,
  tokens: Token[],
  connectorIndex: number,
  segmentStart: number,
  options?: ParseOptions,
  inheritedAdministrationHead = false
): boolean {
  const connector = tokens[connectorIndex];
  const first = tokens[connectorIndex + 1];
  if (!connector || !first) return false;
  const connectorLower = normalizeSegmentLexeme(connector);
  if (!ACTION_SEQUENCE_MARKERS.has(connectorLower) && !ACTION_COORDINATION_CONNECTORS.has(connectorLower)) {
    return false;
  }
  const probeEnd = nextContinuationProbeEnd(input, tokens, connectorIndex + 1);
  const continuationText = input.slice(first.sourceStart, probeEnd).trim();
  if (!continuationText) return false;
  if (parseInstructionActions(continuationText, 0, options).length) return false;
  const continuation = parseClauseState(continuationText, options);
  if (findUnparsedTokenGroups(continuation).length || !hasMeaningfulSchedule(continuation)) return false;
  if (hasAdministrationHead(continuation)) return false;

  const prefixText = input.slice(segmentStart, connector.sourceStart).replace(/[,;]\s*$/u, "").trim();
  if (!prefixText) return false;
  const prefix = parseClauseState(prefixText, options);
  if (!hasAdministrationHead(prefix)) {
    if (!inheritedAdministrationHead) return false;
    if (findUnparsedTokenGroups(prefix).length || !hasMeaningfulSchedule(prefix)) return false;
  }
  if (connectorLower === "then") return true;
  const prefixSchedule = prefix.primaryClause.schedule;
  return Boolean(
    prefixSchedule?.offset !== undefined || prefixSchedule?.offsetMin !== undefined ||
    prefixSchedule?.offsetMax !== undefined ||
    prefixSchedule?.activityTiming?.some((timing) =>
      timing.offset !== undefined || timing.offsetMin !== undefined || timing.offsetMax !== undefined
    )
  );
}

function doseBearingAdministrationContinuation(
  input: string,
  tokens: Token[],
  connectorIndex: number,
  segmentStart: number,
  options?: ParseOptions
): boolean {
  const connector = tokens[connectorIndex];
  const first = tokens[connectorIndex + 1];
  if (!connector || !first) return false;
  const connectorLower = normalizeSegmentLexeme(connector);
  if (!ACTION_SEQUENCE_MARKERS.has(connectorLower) && !ACTION_COORDINATION_CONNECTORS.has(connectorLower)) {
    return false;
  }
  const probeEnd = nextContinuationProbeEnd(input, tokens, connectorIndex + 1);
  const continuationText = input.slice(first.sourceStart, probeEnd).trim();
  if (!continuationText) return false;

  // Cheap lexical rejection before invoking the full parser. Most sequence/
  // coordination markers belong to procedural prose, not a heterogeneous
  // administration continuation. Requiring an explicit unit here avoids
  // reparsing the prefix for every ordinary `and` / `then`.
  let hasExplicitDoseUnit = false;
  for (let index = connectorIndex + 1; index < tokens.length; index += 1) {
    const item = tokens[index];
    if (!item || item.sourceStart >= probeEnd) break;
    if (normalizeUnit(item.canonical ?? item.lower, options)) {
      hasExplicitDoseUnit = true;
      break;
    }
  }
  if (!hasExplicitDoseUnit) return false;

  const prefixText = input.slice(segmentStart, connector.sourceStart).replace(/[,;]\s*$/u, "").trim();
  if (!prefixText) return false;
  const prefix = parseClauseState(prefixText, options);
  if (!prefix.primaryClause.dose) return false;
  const continuationActions = parseInstructionActions(continuationText, 0, options);
  if (continuationActions.some((action) => action.args.some((arg) =>
    arg.conceptId === "after-first-administration"
  ))) return false;
  const continuation = parseClauseState(continuationText, options);
  const clause = continuation.primaryClause;
  if (!clause.dose) return false;
  return hasMeaningfulSchedule(continuation) || Boolean(clause.method?.text || clause.method?.coding?.code);
}

function isSlashClauseBoundary(tokens: Token[], index: number): boolean {
  const token = tokens[index];
  if (!token || token.original !== "/") {
    return false;
  }
  const next = tokens[index + 1];
  if (!next) {
    return false;
  }
  const previous = tokens[index - 1];
  const previousLower = previous?.lower.replace(/[.,;:]/g, "") ?? "";
  const lower = next.lower.replace(/[.,;:]/g, "");
  if (/^\d+(?:\.\d+)?$/.test(previousLower) && /^\d+(?:\.\d+)?$/.test(lower)) {
    return false;
  }
  return /^\d/.test(lower) || CLAUSE_LEAD_WORDS.has(lower);
}

function pushSegment(
  segments: HpsgSigSegment[],
  input: string,
  start: number,
  end: number
): void {
  let trimmedStart = start;
  let trimmedEnd = end;
  while (trimmedStart < trimmedEnd && /\s/.test(input[trimmedStart] ?? "")) {
    trimmedStart += 1;
  }
  while (trimmedEnd > trimmedStart && /\s/.test(input[trimmedEnd - 1] ?? "")) {
    trimmedEnd -= 1;
  }
  if (trimmedEnd <= trimmedStart) {
    return;
  }
  segments.push({
    text: input.slice(trimmedStart, trimmedEnd),
    start: trimmedStart,
    end: trimmedEnd
  });
}

export function parseSigSegments(input: string, options?: ParseOptions): HpsgSigSegment[] {
  const tokens = annotateLexTokens(lexInput(input));
  const proceduralActions = parseInstructionActions(input, 0, options);
  const segments: HpsgSigSegment[] = [];
  let start = 0;
  let inheritedAdministrationContinuation = false;
  let parenDepth = 0;
  let scannedOffset = 0;

  const scanParens = (end: number) => {
    for (; scannedOffset < end; scannedOffset += 1) {
      const char = input[scannedOffset];
      if (char === "(") {
        parenDepth += 1;
      } else if (char === ")") {
        parenDepth = Math.max(0, parenDepth - 1);
      }
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    scanParens(token.sourceStart);
    if (token.original === "(") {
      parenDepth += 1;
      scannedOffset = token.sourceEnd;
      continue;
    }
    if (token.original === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      scannedOffset = token.sourceEnd;
      continue;
    }
    if (parenDepth > 0) {
      scannedOffset = token.sourceEnd;
      continue;
    }
    const nextToken = tokens[index + 1];
    if (token.original === "," && nextToken) {
      const scheduleContinuation = scheduleOnlyAdministrationContinuation(
        input, tokens, index + 1, start, options, inheritedAdministrationContinuation
      );
      const doseContinuation = !scheduleContinuation &&
        doseBearingAdministrationContinuation(input, tokens, index + 1, start, options);
      if (scheduleContinuation || doseContinuation) {
        pushSegment(segments, input, start, token.sourceStart);
        start = nextToken.sourceEnd;
        inheritedAdministrationContinuation = true;
        index += 1;
        scannedOffset = nextToken.sourceEnd;
        continue;
      }
    } else {
      const scheduleContinuation = scheduleOnlyAdministrationContinuation(
        input, tokens, index, start, options, inheritedAdministrationContinuation
      );
      const doseContinuation = !scheduleContinuation &&
        doseBearingAdministrationContinuation(input, tokens, index, start, options);
      if (scheduleContinuation || doseContinuation) {
        pushSegment(segments, input, start, token.sourceStart);
        start = token.sourceEnd;
        inheritedAdministrationContinuation = true;
        scannedOffset = token.sourceEnd;
        continue;
      }
    }

    const isBoundary =
      isBoundaryToken(token) ||
      isCommaClauseBoundary(input, tokens, index, proceduralActions, options, start) ||
      isSlashClauseBoundary(tokens, index);
    if (!isBoundary) {
      scannedOffset = token.sourceEnd;
      continue;
    }
    pushSegment(segments, input, start, token.sourceStart);
    start = token.sourceEnd;
    inheritedAdministrationContinuation = false;
    scannedOffset = token.sourceEnd;
  }

  pushSegment(segments, input, start, input.length);
  if (segments.length) {
    return segments;
  }

  const text = input.trim();
  if (!text) {
    return [];
  }
  const startIndex = input.indexOf(text);
  return [{ text, start: startIndex, end: startIndex + text.length }];
}
