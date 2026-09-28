import { findMedicationDateListSpans } from '../../src/date-interpretation';
import { buildInstructionGraphExtension, MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL } from '../../src/instruction-graph-fhir';
import type { ParseOptions, ParseResult } from '../../src/types';
import { quarantineSchedule } from './admissibility';

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

/** Non-event calendar bounds own their entire source span. */
export function normalizeTemporalBoundArtifacts(
  item: ParseResult,
  source: string,
  options?: ParseOptions
): boolean {
  const ranges = findMedicationDateListSpans(source, options)
    .filter(span => !span.unresolved && span.relation !== 'event')
    .map(span => ({ start: span.start, end: span.end }));
  return removeInstructionArtifactsOwnedByTemporalRanges(item, ranges);
}

/**
 * "Up to DATE" has inconsistent inclusive/exclusive usage. Preserve it visibly
 * instead of choosing an end bound and executing a guessed schedule.
 */
export function quarantineAmbiguousTemporalBounds(
  item: ParseResult,
  source: string,
  options?: ParseOptions
): boolean {
  for (const span of findMedicationDateListSpans(source, options)) {
    if (span.unresolved || span.relation !== 'event') continue;
    const prefix = source.slice(Math.max(0, span.start - 16), span.start);
    if (/\bup\s+to\s*$/iu.test(prefix)) {
      quarantineSchedule(item, source, 'ambiguous-up-to-date-bound');
      return true;
    }
  }
  return false;
}
