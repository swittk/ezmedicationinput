import { findMedicationDateListSpans, type MedicationDateListMatch } from '../date-interpretation';
import { buildInstructionGraphExtension, MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL } from '../instruction-graph-fhir';
import type { ParseOptions, ParseResult } from '../types';

export interface RelativeTemporalRange { start: number; end: number }

function overlaps(leftStart: number, leftEnd: number, right: RelativeTemporalRange): boolean {
  return leftStart < right.end && leftEnd > right.start;
}

function unionLength(ranges: Array<{ start: number; end: number }>): number {
  if (!ranges.length) return 0;
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  let total = 0;
  let start = sorted[0].start;
  let end = sorted[0].end;
  for (const range of sorted.slice(1)) {
    if (range.start <= end) {
      end = Math.max(end, range.end);
    } else {
      total += Math.max(0, end - start);
      start = range.start;
      end = range.end;
    }
  }
  return total + Math.max(0, end - start);
}

/**
 * Timing-owned source ranges cannot simultaneously survive as procedural actions.
 * Ranges are segment-relative; canonical graph spans are rebased to the full input.
 */
export function removeInstructionArtifactsOwnedByTemporalRanges(
  item: ParseResult,
  ranges: readonly RelativeTemporalRange[]
): boolean {
  const clause = item.meta.canonical.clauses[0];
  if (!clause || !ranges.length) return false;
  const base = clause.raw.start;
  const absolute = ranges.map(range => ({ start: base + range.start, end: base + range.end }));
  const graph = clause.instructionGraph;
  let changed = false;

  if (graph) {
    const actions = graph.actions.filter(action => !absolute.some(range => overlaps(action.span.start, action.span.end, range)));
    const opaque = (graph.opaqueSpans ?? []).filter(span => !absolute.some(range => overlaps(span.start, span.end, range)));
    changed = actions.length !== graph.actions.length || opaque.length !== (graph.opaqueSpans ?? []).length;
    graph.actions = actions;
    graph.opaqueSpans = opaque;

    if (graph.coverage) {
      const understood = unionLength([
        ...graph.actions.map(action => action.span),
        ...(graph.relations ?? []).map(relation => relation.span).filter((span): span is { start: number; end: number } => !!span)
      ]);
      const opaqueCharacters = unionLength(graph.opaqueSpans ?? []);
      graph.coverage.understoodCharacters = understood;
      graph.coverage.opaqueCharacters = opaqueCharacters;
      graph.coverage.complete = opaqueCharacters === 0;
      graph.coverage.ratio = graph.sourceText.length ? Math.min(1, understood / graph.sourceText.length) : 1;
    }
    if (!graph.actions.length && !graph.relations?.length && !graph.opaqueSpans?.length) {
      delete clause.instructionGraph;
    }
  }

  if (clause.patientInstruction) {
    const normalizedInstruction = clause.patientInstruction.replace(/\s+/gu, '');
    const owned = ranges.some(range =>
      normalizedInstruction === clause.rawText.slice(range.start, range.end).replace(/\s+/gu, '')
    );
    if (owned) {
      delete clause.patientInstruction;
      changed = true;
    }
  }

  if (changed) {
    const retained = (item.fhir.extension ?? []).filter(extension => extension.url !== MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL);
    const graphExtension = buildInstructionGraphExtension(clause.instructionGraph);
    item.fhir.extension = graphExtension ? [...retained, graphExtension] : retained.length ? retained : undefined;
    if (item.fhir.patientInstruction && clause.patientInstruction === undefined) delete item.fhir.patientInstruction;
  }
  return changed;
}

function inclusiveUpToRange(source: string, span: MedicationDateListMatch): RelativeTemporalRange | undefined {
  if (span.unresolved || span.relation !== 'event' || span.events.length !== 1) return undefined;
  const windowStart = Math.max(0, span.start - 32);
  const prefix = source.slice(windowStart, span.start);
  const lead = prefix.match(/\bup\s+to\s*$/iu);
  if (!lead || lead.index === undefined) return undefined;
  return { start: windowStart + lead.index, end: span.end };
}

/** Move only the event owned by `up to DATE` to an inclusive end bound. */
function normalizeInclusiveUpToBound(item: ParseResult, span: MedicationDateListMatch): boolean {
  const clause = item.meta.canonical.clauses[0];
  const schedule = clause?.schedule;
  const event = span.events[0];
  if (!schedule || !event || (schedule.boundsEnd && schedule.boundsEnd !== event.isoDate)) return false;

  const calendarEvents = schedule.calendarEvents ?? [];
  let eventIndex = calendarEvents.findIndex(candidate =>
    candidate.isoDate === event.isoDate && candidate.sourceText === event.sourceText
  );
  if (eventIndex < 0) {
    const matchingDates = calendarEvents
      .map((candidate, index) => candidate.isoDate === event.isoDate ? index : -1)
      .filter(index => index >= 0);
    if (matchingDates.length !== 1) return false;
    eventIndex = matchingDates[0];
  }

  schedule.boundsEnd = event.isoDate;
  schedule.calendarEvents = calendarEvents.filter((_, index) => index !== eventIndex);
  if (!schedule.calendarEvents.length) delete schedule.calendarEvents;

  const timing = item.fhir.timing;
  if (timing) {
    const fhirEvents = timing.event ?? [];
    let fhirIndex = eventIndex < fhirEvents.length && fhirEvents[eventIndex].slice(0, 10) === event.isoDate
      ? eventIndex
      : -1;
    if (fhirIndex < 0) {
      const matchingDates = fhirEvents
        .map((value, index) => value.slice(0, 10) === event.isoDate ? index : -1)
        .filter(index => index >= 0);
      if (matchingDates.length === 1) fhirIndex = matchingDates[0];
    }
    if (fhirIndex >= 0) {
      timing.event = fhirEvents.filter((_, index) => index !== fhirIndex);
      if (!timing.event.length) delete timing.event;
      if (timing._event) {
        timing._event = timing._event.filter((_, index) => index !== fhirIndex);
        if (!timing._event.length) delete timing._event;
      }
    }
    timing.repeat = {
      ...(timing.repeat ?? {}),
      boundsPeriod: {
        ...(timing.repeat?.boundsPeriod ?? {}),
        end: event.isoDate
      }
    };
  }
  return true;
}

/** Resolved calendar bounds own their source spans; `up to DATE` is inclusive. */
export function normalizeTemporalBoundArtifacts(
  item: ParseResult,
  source: string,
  options?: ParseOptions
): boolean {
  const clause = item.meta.canonical.clauses[0];
  // Ownership pruning only changes procedural instructions/graphs.
  // A simple timing-only clause has nothing to prune, so avoid reparsing its
  // entire date grammar unless there is an inclusive "up to" bound to normalize.
  const hasUpTo = /\bup\s+to\b/iu.test(source);
  if (!clause?.instructionGraph && !clause?.patientInstruction && !hasUpTo) return false;
  const spans = findMedicationDateListSpans(source, options);
  if (!spans.length) return false;

  const ranges: RelativeTemporalRange[] = spans
    .filter(span => !span.unresolved && span.relation !== 'event')
    .map(span => ({ start: span.start, end: span.end }));
  let changed = false;
  for (const span of spans) {
    const range = inclusiveUpToRange(source, span);
    if (!range || !normalizeInclusiveUpToBound(item, span)) continue;
    ranges.push(range);
    changed = true;
  }
  return removeInstructionArtifactsOwnedByTemporalRanges(item, ranges) || changed;
}
