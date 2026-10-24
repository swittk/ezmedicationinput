import { lexInput } from '../lexer/lex';
import { matchCalendarExclusion } from '../hpsg/rules/condition-rules';
import { parseMedicationGuard } from '../medication-condition';
import { findMedicationDateListSpans } from '../date-interpretation';
import {
  annotateLexTokens,
  getDayOfWeekMeaning,
  hasEventTimingMeaning,
  hasSiteMeaningCandidate,
  hasTimingAbbreviationMeaning
} from '../lexer/meaning';
import { LexKind } from '../lexer/token-types';
import { EVENT_TIMING_TOKENS } from '../maps';
import { parseClockToken } from '../hpsg/rule-context';
import { normalizeUnit } from '../unit-lexicon';
import { ACTION_COORDINATION_CONNECTORS, ACTION_SEQUENCE_MARKERS, CLAUSE_LEAD_WORDS,
  DOSE_FRACTION_WORDS, DOSE_NUMBER_WORDS, HARD_SEGMENT_BOUNDARY_TOKENS,
  LATERAL_MODIFIER_WORDS, SITE_ANCHORS, SITE_MULTIPLICITY_WORDS,
  coordinationConnectorKind } from '../hpsg/lexical-classes';
import { AdviceForce, EventTiming, type ParseOptions, type AdviceFrame } from '../types';
import type { ParserState, Token } from '../parser-state';
import { buildCustomSiteHints, parseClauseState, findUnparsedTokenGroups } from '../parser';
import type { HpsgSigSegment } from '../hpsg/segmenter';
import type { BoundaryPlan, BoundarySite, PlannerOptions, PlannerMetrics, PlanningInput, Proposal, ProbeSummary, Range, StructuralClaim } from './types';
import { parseInstructionActions } from '../instruction-graph';
import { resolveMedicationInstructionAction } from '../instruction-action-terminology';
import { parseAdditionalInstructions } from '../advice';
import { grammaticalProposals, arbitrate } from './grammar';
import { recognizeCycles } from './cycles';
import type { RejectedConstruction } from './grammar';

/** Use the existing locale normalizer; grammar never maintains Thai connector spellings. */
function lexeme(token: Token | undefined): string {
  return token ? (token.canonical ?? token.lower).replace(/^[.,;:]+|[.,;:]+$/g, '') : '';
}

/** Recognize typed clock atoms, including a numeral followed by a shared meridiem token. */
function clockEnd(tokens: Token[], index: number): number | undefined {
  const parsed = parseClockToken(tokens[index], tokens[index + 1]);
  return parsed ? index + parsed.tokens.length : undefined;
}

function listConnector(token: Token | undefined): boolean {
  return Boolean(token && (token.original === ',' || ACTION_COORDINATION_CONNECTORS.has(lexeme(token))));
}

/** Claims prevent only external segmentation; all internal tokens still reach clause HPSG. */
function recognizeStructures(context: PlanningInput): StructuralClaim[] {
  const { input, options, tokens } = context;
  const claims: StructuralClaim[] = [];
  const add = (kind: StructuralClaim['kind'], start: number, end: number, producer: string, resolved = true) => {
    if (end > start) claims.push({ id: `${kind}:${start}:${end}`, kind, start, end, producer, resolved, policy: 'no-external-split' });
  };
  for (const span of context.dateSpans ?? findMedicationDateListSpans(input, options)) {
    // A structural proposal is not authority to swallow a typed dose. Numeric date
    // regexes can overrun `until 30/9 and 1/2 tab`; let the quantity/unit constituent
    // bound the proposal before it becomes an ownership claim. No separator-language exception.
    let end = span.end;
    for (let i = 0; i + 1 < tokens.length; i++) {
      const t = tokens[i];
      if (t.sourceStart <= span.start || t.sourceStart >= end) continue;
      if ((t.kind !== LexKind.Number && t.kind !== LexKind.NumberRange) || !normalizeUnit(lexeme(tokens[i + 1]), options)) continue;
      const previous = tokens[i - 1];
      end = previous && listConnector(previous) ? previous.sourceStart : t.sourceStart;
      break;
    }
    add('calendar-date-list', span.start, end, 'findMedicationDateListSpans', !span.unresolved);
  }
  for (const cycle of recognizeCycles(input, options)) add('cycle-schedule', cycle.start, cycle.end, 'hpsg.lex.schedule.finiteCycle', !cycle.error);
  // List constructions compose typed atoms and canonical coordinators, not medication phrases.
  for (const kind of ['clock-list', 'weekday-list'] as const) {
    const atomEnd = (index: number): number | undefined => kind === 'clock-list'
      ? clockEnd(tokens, index)
      : getDayOfWeekMeaning(tokens[index])?.length ? index + 1 : undefined;
    for (let start = 0; start < tokens.length; start++) {
      let end = atomEnd(start);
      if (end === undefined) continue;
      let members = 1;
      while (listConnector(tokens[end])) {
        let next = end + 1;
        if (tokens[end]?.original === ',' && ACTION_COORDINATION_CONNECTORS.has(lexeme(tokens[next]))) next++;
        const after = atomEnd(next);
        if (after === undefined) break;
        members++; end = after;
      }
      if (members > 1) {
        add(kind, tokens[start].sourceStart, tokens[end - 1].sourceEnd, `structure.${kind}.coordination`);
        start = end - 1;
      }
    }
  }
  for (const token of tokens) {
    if (token.kind === LexKind.NumberRange ||
        token.kind === LexKind.Number && (token.sourceText ?? token.original).includes('/')) {
      add('numeric-quantity', token.sourceStart, token.sourceEnd, 'lexInput.numeric-span');
    }
  }
  const parens: number[] = [];
  for (let i = 0; i < input.length; i++) {
    if (input[i] === '(') parens.push(i);
    else if (input[i] === ')' && parens.length) {
      const start = parens.pop()!;
      if (!parens.length) add('parenthesized', start, i + 1, 'structure.balanced-parentheses');
    }
  }
  // Match the existing unmatched-parenthesis scope without swallowing text before the opener.
  if (parens.length) add('parenthesized', parens[0], input.length, 'structure.open-parenthesis', false);
  return claims.sort((a, b) => a.start - b.start || b.end - a.end || a.id.localeCompare(b.id));
}

/** Immutable interval index with prefix maxima: queries work for overlapping and nested claims. */
class OwnershipIndex {
  private readonly maxEnd: number[] = [];
  constructor(readonly claims: StructuralClaim[]) {
    let max = -1;
    for (const claim of claims) { max = Math.max(max, claim.end); this.maxEnd.push(max); }
  }
  owner(offset: number): StructuralClaim | undefined {
    let lo = 0, hi = this.claims.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.claims[mid].start < offset) lo = mid + 1; else hi = mid; }
    let best: StructuralClaim | undefined;
    for (let i = lo - 1; i >= 0 && this.maxEnd[i] > offset; i--) {
      const claim = this.claims[i];
      if (claim.end > offset && (!best || claim.end - claim.start > best.end - best.start)) best = claim;
    }
    return best;
  }
}


function connectorKind(token: Token | undefined): 'coordination' | 'sequence' | undefined {
  const text = lexeme(token);
  return ACTION_SEQUENCE_MARKERS.has(text) ? 'sequence' : ACTION_COORDINATION_CONNECTORS.has(text) ? 'coordination' : undefined;
}
function isHard(token: Token): boolean {
  return HARD_SEGMENT_BOUNDARY_TOKENS.has(token.original.trim().toLowerCase()) || token.original === '\n' || token.original === '\r';
}
function explicitDoseAt(tokens: Token[], i: number, options?: ParseOptions): boolean {
  const token = tokens[i];
  const lower = lexeme(token);
  return Boolean(token && (
    token.kind === LexKind.Number || token.kind === LexKind.NumberRange ||
    DOSE_NUMBER_WORDS.has(lower) || DOSE_FRACTION_WORDS.has(lower)
  ) &&
    tokens[i + 1] && normalizeUnit(lexeme(tokens[i + 1]), options));
}

/** Lexical seams are candidates, never decisions. Owned structures can veto every seam kind. */
function candidateSites(input: string, tokens: Token[], options?: ParseOptions): BoundarySite[] {
  const sites: BoundarySite[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    let kind = connectorKind(token);
    if (token.original === ',' && connectorKind(tokens[i + 1])) {
      const end = tokens[i + 1].sourceEnd;
      sites.push({ start: token.sourceStart, end, tokenIndex: i, lastTokenIndex: i + 1, rightIndex: i + 2,
        kind: connectorKind(tokens[i + 1])!, surface: input.slice(token.sourceStart, end) });
      i++; continue;
    }
    const punctuation = token.original === '.' || token.original === ';' || token.original === '!' || token.original === '?';
    const slash = token.original === '/' && !(tokens[i - 1]?.kind === LexKind.Number && tokens[i + 1]?.kind === LexKind.Number);
    const adjacent = i > 0 && explicitDoseAt(tokens, i, options);
    const boundaryKind = kind ?? (token.original === ',' ? 'comma' : isHard(token) ? 'hard' : slash ? 'slash' :
      punctuation ? 'punctuation' : adjacent ? 'adjacent-dose' : undefined);
    if (!boundaryKind) continue;
    const end = boundaryKind === 'adjacent-dose' ? token.sourceStart : token.sourceEnd;
    sites.push({ start: token.sourceStart, end, tokenIndex: i, lastTokenIndex: i,
      rightIndex: boundaryKind === 'adjacent-dose' ? i : i + 1, kind: boundaryKind, surface: input.slice(token.sourceStart, end) });
  }
  return sites;
}

/** Cheap lexical gate for the ordinary non-site connector path. This does not
 * decide site meaning: it only determines whether the production clause chart
 * can plausibly contribute a typed site-coordination constituent. */
function hasSiteCoordinationCue(
  tokens: Token[], start: number, end: number, customSiteHints?: Set<string>
): boolean {
  return tokens.some(token => token.sourceStart >= start && token.sourceEnd <= end && (
    hasSiteMeaningCandidate(token) ||
    customSiteHints?.has(lexeme(token)) ||
    SITE_ANCHORS.has(lexeme(token)) ||
    LATERAL_MODIFIER_WORDS.has(lexeme(token)) ||
    SITE_MULTIPLICITY_WORDS.has(lexeme(token))
  ));
}

/** Per-input cache: no global results, no mutation of parser state, no cross-option reuse. */
class EvidenceContext {
  private readonly cache = new Map<string, ProbeSummary>();
  /** Reuse completed HPSG probes when their entire input is the final segment.
   * The caller may take a state only once, after boundary planning finishes. */
  private readonly parsedStates = new Map<string, ParserState>();
  private readonly actionCache = new Map<string, AdviceFrame[]>();
  private allActions?: AdviceFrame[];
  constructor(readonly input: string, readonly tokens: Token[], readonly options: ParseOptions | undefined,
    readonly metrics: PlannerMetrics, readonly cacheEnabled: boolean,
    private readonly customSiteHints?: Set<string>) {}

  probe(start: number, end: number): ProbeSummary {
    while (start < end && /\s/u.test(this.input[start])) start++;
    while (end > start && /[\s,;]/u.test(this.input[end - 1])) end--;
    const key = `${start}:${end}`;
    const cached = this.cacheEnabled ? this.cache.get(key) : undefined;
    if (cached) { this.metrics.probeCacheHits++; return cached; }
    const state = parseClauseState(
      this.input.slice(start, end), this.options, this.customSiteHints
    );
    if (this.cacheEnabled) this.parsedStates.set(key, state);
    this.metrics.clauseProbes++; this.metrics.probedTokens += state.tokens.length;
    const c = state.primaryClause, s = c.schedule;
    const directTarget = c.site?.text?.trim().toLowerCase().replace(/\s+/gu, ' ') ||
      (c.site?.coding?.code ? 'code:' + c.site.coding.code : undefined);
    const probeSource = this.input.slice(start, end);
    const leftoverGroups = findUnparsedTokenGroups(state);
    // The HPSG probe runs before the calendar-bound resolver. Valid date
    // ranges can appear as leftover lexical tokens at this point, even
    // though the finished dosage has real boundsPeriod fields. They count
    // as complete ONLY when the shared calendar parser owns every token.
    const bounds = leftoverGroups.length && /[\/-]/u.test(probeSource)
      ? findMedicationDateListSpans(probeSource, this.options).filter(span =>
          !span.unresolved && span.relation !== 'event')
      : [];
    const complete = leftoverGroups.every(group => group.tokens.every(token =>
      bounds.some(span => token.sourceStart >= span.start && token.sourceEnd <= span.end)));
    const targets = c.administrationTargetGroup?.targets.map(target =>
      target.coding?.code
        ? `code:${target.coding.code}`
        : target.text?.trim().toLowerCase().replace(/\s+/gu, ' ')
    ).filter((value): value is string => Boolean(value)) ??
      (directTarget ? [directTarget] : []);
    // Boundary ownership follows the selected production analysis, not every
    // competing chart hypothesis. The composed sign already retains its typed
    // site coordination, so no extra chart-wide scan is needed per probe.
    const coordination = c.administrationTargetGroup;
    const siteCoordinations: ProbeSummary['siteCoordinations'] = coordination?.range ? [{
      type: 'site-coordination-phrase',
      coordination: coordination.coordination,
      start: coordination.range.start + start,
      end: coordination.range.end + start
    }] : [];
    const summary: ProbeSummary = {
      start, end, clause: c,
      complete,
      hasHead: Boolean(c.method?.coding?.code || c.method?.text || c.dose?.value !== undefined || c.dose?.range ||
        c.clinicalQuantity || c.site?.coding?.code || c.site?.text || c.patientInstruction || c.additionalInstructions?.length),
      // A dimensional rate is an administration quantity, not a scalar dose.
      hasDose: Boolean(c.dose || c.clinicalQuantity),
      method: Boolean(c.method?.coding?.code || c.method?.text),
      hasSchedule: Boolean(s && (s.frequency !== undefined || s.frequencyMax !== undefined || s.period !== undefined ||
        s.periodMax !== undefined || s.duration !== undefined || s.durationMax !== undefined || s.boundsStart !== undefined ||
        s.boundsEnd !== undefined || s.count !== undefined || s.timingCode || s.dayOfWeek?.length || s.when?.length ||
        s.timeOfDay?.length || s.calendarEvents?.length)),
      hasRecurringCadence: Boolean(s && (s.timingCode || s.frequency !== undefined || s.period !== undefined || s.dayOfWeek?.length)),
      hasDates: Boolean(s?.calendarEvents?.length), hasClocks: Boolean(s?.timeOfDay?.length),
      clocks: [...(s?.timeOfDay ?? [])].sort(),
      hasOffset: Boolean(s && (s.offset !== undefined || s.offsetMin !== undefined || s.offsetMax !== undefined ||
        s.activityTiming?.some(t => t.offset !== undefined || t.offsetMin !== undefined || t.offsetMax !== undefined))),
      prn: c.prn?.enabled === true,
      targets,
      hasTargets: targets.length > 0,
      siteCoordinations,
      // Conditions are typed action/clinical-adjunct relations, never
      // inferred from HPSG lexical production names.
      conditionStarts: [
        ...(c.instructionGraph?.relations ?? []).filter(relation =>
          (relation.kind === 'if' || relation.kind === 'unless') &&
          relation.span !== undefined
        ).map(relation => relation.span!.start + start),
        ...(c.clinicalAdjuncts?.condition
          ? (c.clinicalAdjuncts.localRanges ?? []).map(range => range.start + start)
          : [])
      ]
    };
    if (this.cacheEnabled) this.cache.set(key, summary);
    return summary;
  }

  takeParsedState(start: number, end: number, text: string): ParserState | undefined {
    const key = start + ":" + end;
    const state = this.parsedStates.get(key);
    if (!state || state.input !== text) return undefined;
    this.parsedStates.delete(key);
    return state;
  }

  actions(start: number, end: number): AdviceFrame[] {
    const key = `${start}:${end}`;
    const cached = this.cacheEnabled ? this.actionCache.get(key) : undefined;
    if (cached) return cached;
    this.metrics.actionScans++;
    const source = this.input.slice(start, end);
    const leadingWhitespace = /^\s*/u.exec(source)?.[0].length ?? 0;
    const value = parseInstructionActions(source.trim(), start + leadingWhitespace, this.options);
    if (this.cacheEnabled) this.actionCache.set(key, value);
    return value;
  }

  /** A procedural relation is established by action frames and terminology, not connector spelling. */
  proceduralBridge(range: Range): boolean {
    if (!this.allActions) this.allActions = this.actions(0, this.input.length);
    let left: AdviceFrame | undefined, right: AdviceFrame | undefined;
    for (const action of this.allActions) {
      if (action.span.start < range.start && action.span.end <= range.end + 1) {
        if (!left || action.span.end > left.span.end) left = action;
      } else if (action.span.start >= range.end && (!right || action.span.start < right.span.start)) right = action;
    }
    return Boolean(left && right && resolveMedicationInstructionAction(left.predicate.lemma, this.options)?.procedural &&
      Math.max(0, range.start - left.span.end) <= 2 && Math.max(0, right.span.start - range.end) <= 2);
  }

  instructionContinuation(index: number, end: number): boolean {
    const lead = this.tokens[index], first = this.tokens[index + 1];
    if (!lead || !first || !CLAUSE_LEAD_WORDS.has(lexeme(lead))) return false;
    const start = first.sourceStart;
    return parseAdditionalInstructions(this.input.slice(start, end).replace(/\s+/g, ' ').trim(), { start, end }, {
      defaultPredicate: lexeme(lead), defaultForce: AdviceForce.Instruction, allowFreeTextFallback: false
    }).some(i => i.coding?.code || i.frames.length);
  }
}


const contexts = new WeakMap<BoundaryPlan, EvidenceContext>();

/** Reuse exact completed HPSG probes, but never a partial probe. Carry-forward
 * is applied to the returned state by the same production consumer as a fresh
 * parse, so it does not invalidate an exact segment result. */
export function takeBoundaryParsedState(
  plan: BoundaryPlan, start: number, end: number, text: string
) {
  return contexts.get(plan)?.takeParsedState(start, end, text);
}

/** Production boundary grammar: lexical candidates are arbitrated using typed
 * constituent ownership before final clause parsing.
 * @param input Original clinician instruction.
 * @param options Terminology and interpretation context.
 * @param experiment Optional diagnostic switches used by the comparison harness.
 */
export function planBoundaries(input: string, options?: ParseOptions, experiment: PlannerOptions = {}): BoundaryPlan {
  const tokens = annotateLexTokens(lexInput(input));
  const metrics = { lexicalPasses: 1, dateScans: 1, actionScans: 0, clauseProbes: 0,
    siteCoordinationProbes: 0, probeCacheHits: 0,
    probedTokens: 0, candidates: 0, claimedCandidates: 0 };
  const sites = candidateSites(input, tokens, options);
  const dateSpans = findMedicationDateListSpans(input, options);
  const customSiteHints = buildCustomSiteHints(options?.siteCodeMap);
  const evidence = new EvidenceContext(
    input, tokens, options, metrics, experiment.cache !== false, customSiteHints
  );
  const claims = recognizeStructures({ input, options, tokens, dateSpans });
  // The same typed guard constituent used by the HPSG clinical-adjunct
  // lexical rule owns its internal Boolean connectives. Reprobing AND/OR
  // inside that range as possible medication boundaries duplicates a full
  // chart and risks turning one condition into multiple administrations.
  // Skip the recognizer entirely for ordinary inputs with no such boundary.
  const clinicalGuard = sites.some(site => site.kind === 'coordination')
    ? parseMedicationGuard(input) : undefined;
  if (clinicalGuard && sites.some(site => site.kind === 'coordination' &&
      clinicalGuard.start < site.start && site.end < clinicalGuard.end)) {
    claims.push({
      id: `clinical-condition:${clinicalGuard.start}:${clinicalGuard.end}`,
      kind: 'clinical-condition',
      start: clinicalGuard.start, end: clinicalGuard.end,
      producer: 'lexical.conditional-attachment',
      resolved: true, policy: 'no-external-split'
    });
  }
  // A selected HPSG relative-event sign owns its internal coordination.
  // Without the claim below, the independent regimen planner can split a
  // valid "immediately after breakfast AND dinner" timing constituent into
  // separate prescriptions. Reuse the SAME selected clause sign as evidence
  // instead of maintaining a duplicate surface-language timing parser.
  // Ordinary SIGs have no such event seam and perform no extra chart work.
  for (const site of sites) {
    if (site.kind !== 'coordination' ||
        coordinationConnectorKind(lexeme(tokens[site.tokenIndex])) !== 'conjunction' ||
        !hasEventTimingMeaning(tokens[site.tokenIndex - 1])) continue;
    let rightEndIndex = site.rightIndex;
    if (!hasEventTimingMeaning(tokens[rightEndIndex])) continue;
    if (EVENT_TIMING_TOKENS[lexeme(tokens[rightEndIndex])] === EventTiming.Immediate) {
      rightEndIndex += 2;
      if (!hasEventTimingMeaning(tokens[rightEndIndex])) continue;
    }
    const rightEnd = tokens[rightEndIndex]?.sourceEnd;
    if (rightEnd === undefined) continue;
    let immediateStart: number | undefined;
    for (let index = site.tokenIndex - 2; index >= 0; index -= 1) {
      if (EVENT_TIMING_TOKENS[lexeme(tokens[index])] === EventTiming.Immediate) {
        immediateStart = tokens[index].sourceStart;
        break;
      }
      if (tokens[index].original === ';' || tokens[index].original === '.') break;
    }
    if (immediateStart === undefined) continue;
    const offsetStart = immediateStart;
    const probe = evidence.probe(offsetStart, rightEnd);
    const ownsConnector = probe.clause.schedule?.offset === 0 &&
      (probe.clause.schedule.when?.length ?? 0) >= 2 &&
      probe.clause.evidence.some(item =>
        item.rule === 'hpsg.lex.schedule.eventOffset.immediate' &&
        item.spans.some(span =>
          offsetStart + span.start <= site.start &&
          offsetStart + span.end >= site.end
        ));
    if (!ownsConnector) continue;
    claims.push({
      id: `event-timing-list:${offsetStart}:${rightEnd}`,
      kind: 'event-timing-list', start: offsetStart, end: rightEnd,
      producer: 'hpsg.lex.schedule.eventOffset.immediate',
      resolved: true, policy: 'no-external-split'
    });
  }
  // Procedural argument structures are already composed into typed action
  // frames. A comma inside one such action (e.g. "before food, drink, ...")
  // is a nominal/list boundary, NOT permission to create another medication.
  // Only inspect cases actually containing an ambiguous comma, and reuse the
  // existing per-input action scan/cache. This preserves full-source spans.
  if (sites.some(site => site.kind === 'comma')) {
    const actionFrames = evidence.actions(0, input.length);
    for (const site of sites) {
      if (site.kind !== 'comma' ||
          explicitDoseAt(tokens, site.rightIndex, options)) continue;
      const internal = actionFrames.some(frame =>
        frame.span.start < site.start && site.end < frame.span.end &&
        frame.args.some(arg => {
          if (arg.role === 'amount' || arg.role === 'duration' ||
              !arg.text.includes(',')) return false;
          // Prefer exact typed argument provenance when available. Some
          // composed multiword nominal arguments retain source as text until
          // projected, but never grant the WHOLE action an ownership claim.
          return !arg.span ||
            arg.span.start <= site.start && arg.span.end >= site.end;
        })
      );
      if (!internal) continue;
      // Ownership is local to the licensed internal comma, NOT the frame's
      // entire lexical span. A frame with an overbroad tail argument must
      // never swallow an earlier independently licensed medication OR seam.
      claims.push({
        id: 'procedural-argument:' + site.start + ':' + site.end,
        kind: 'procedural-argument',
        start: Math.max(0, site.start - 1),
        end: site.end + 1,
        producer: 'typed.action.valence',
        resolved: true,
        policy: 'no-external-split'
      });
    }
  }
  // Site ownership comes from the selected production clause sign. Probe the
  // natural clause window around a plausible site connector, then retain that
  // exact cached ParserState for boundary evidence and final clause parsing.
  // Adjacent-dose seams are not clause boundaries and therefore do not narrow
  // these windows.
  const clauseBoundarySites = sites.filter(site => site.kind !== 'adjacent-dose');
  const administrationConnectors = new Set<number>();
  for (let index = 0; index < clauseBoundarySites.length; index += 1) {
    const site = clauseBoundarySites[index];
    if (site.kind !== 'coordination' && site.kind !== 'comma') continue;
    if (administrationConnectors.has(site.start)) continue;
    if (clinicalGuard && clinicalGuard.start < site.start && site.end < clinicalGuard.end) continue;
    const windowStart = clauseBoundarySites[index - 1]?.end ?? 0;
    const windowEnd = clauseBoundarySites[index + 1]?.start ?? input.length;
    if (!hasSiteCoordinationCue(tokens, windowStart, windowEnd, customSiteHints)) continue;
    metrics.siteCoordinationProbes++;
    const summary = evidence.probe(windowStart, windowEnd);
    const coordination = summary.siteCoordinations.find(candidate =>
      candidate.start < site.start && candidate.end > site.end
    );
    if (!coordination || coordination.start >= site.start || coordination.end <= site.end) continue;
    const key = `${coordination.start}:${coordination.end}`;
    if (claims.some(claim => claim.kind === 'target-list' &&
        claim.start === coordination.start && claim.end === coordination.end)) continue;
    claims.push({
      id: `target-list:${key}`,
      kind: 'target-list',
      start: coordination.start,
      end: coordination.end,
      producer: coordination.type,
      resolved: true,
      policy: 'no-external-split'
    });
    // A complete administration ending at the next connector establishes that
    // seam at clause level. Do not build an overlapping production chart just
    // to ask whether that same connector is also internal to a SITE-NP.
    if (summary.hasHead && summary.hasSchedule) {
      const following = clauseBoundarySites[index + 1];
      if (following) administrationConnectors.add(following.start);
    }
  }
  // Existing lexical recognizers can claim an indivisible calendar exclusion
  // or fronted conditional scope BEFORE HPSG boundary arbitration. Unlike the
  // former candidate-adapter rewrite, this never merges already-decided
  // segments or discards their relation provenance.
  if (/\b(?:except|excluding)\b|ยกเว้น|เว้น(?=วัน)/iu.test(input)) {
    const exclusion = matchCalendarExclusion(input, options);
    if (exclusion) claims.push({
      id: `clinical-calendar-exclusion:${exclusion.start}:${exclusion.end}`,
      kind: 'calendar-exclusion',
      start: exclusion.start, end: exclusion.end,
      producer: 'lexical.calendar-exclusion',
      resolved: true, policy: 'no-external-split'
    });
  }
  if (/^\s*(?:only\s+if|unless|เฉพาะ(?:เมื่อ|หาก)|เว้นแต่|ยกเว้นกรณี)/iu.test(input)) {
    const guard = clinicalGuard ?? parseMedicationGuard(input);
    const firstNonspace = input.search(/\S/u);
    if (guard?.start === firstNonspace && guard.end < input.length) {
      const comma = tokens.find(token =>
        token.original === ',' && token.sourceStart >= guard.end &&
        /^\s*$/u.test(input.slice(guard.end, token.sourceStart))
      );
      if (comma) {
        const closing = guard.otherwise &&
          input.slice(comma.sourceEnd, guard.otherwise.start).indexOf(';') < 0
          ? guard.otherwise.end : comma.sourceEnd;
        claims.push({
          id: `fronted-conditional-clause:${guard.start}:${closing}`,
          kind: 'fronted-conditional-clause',
          start: guard.start, end: closing,
          producer: 'lexical.conditional-attachment',
          resolved: true, policy: 'no-external-split'
        });
      }
    }
  }
  claims.sort((a, b) => a.start - b.start || b.end - a.end || a.id.localeCompare(b.id));
  const owners = new OwnershipIndex(experiment.ownership === false ? [] : claims);
  const plan: BoundaryPlan = { experimental: true, segments: [], claims, decisions: [], relations: [], metrics };
  contexts.set(plan, evidence);
  let start = 0, inheritedAdministration = false;

  const segment = (end: number, inheritTrailingDurationFromNext = false): boolean => {
    let a = start, b = end;
    while (a < b && /\s/u.test(input[a])) a++;
    while (b > a && /\s/u.test(input[b - 1])) b--;
    if (b <= a) return false;
    plan.segments.push({ text: input.slice(a, b), start: a, end: b,
      inheritTrailingDurationFromNext: inheritTrailingDurationFromNext || undefined });
    return true;
  };
  const probeEnd = (rightIndex: number, broad = false) => {
    const rightStart = tokens[rightIndex]?.sourceStart ?? input.length;
    for (const site of sites) {
      if (site.start <= rightStart || site.kind === 'adjacent-dose') continue;
      if (broad && (site.kind === 'coordination' || site.kind === 'sequence' || site.kind === 'punctuation')) continue;
      if (!owners.owner(site.start)) return site.start;
    }
    return input.length;
  };
  const hasUnit = (a: number, b: number) => tokens.some((t, i) => i >= a && t.sourceStart < b && Boolean(normalizeUnit(lexeme(t), options)));
  const keep = (rule: string, priority: number, feature: string, value: string | boolean): Proposal =>
    ({ action: 'keep', rule, priority, evidence: [{ feature, value }] });

  /** A juxtaposed independent administration is first visible at its numeric
   * dose candidate, but a leading SITE-NP belongs to that right daughter. Find
   * the nearest bounded typed seam for which both daughters are already
   * complete dosed schedules with distinct administration targets. Ordinary
   * one-dose inputs never enter this path. */
  const adjacentAdministrationHead = (
    candidate: BoundarySite,
    hasPriorDose: boolean
  ): { site: BoundarySite; left: ProbeSummary; right: ProbeSummary; end: number } | undefined => {
    if (candidate.kind !== 'adjacent-dose' || !hasPriorDose) return undefined;
    const end = probeEnd(candidate.rightIndex);
    for (let distance = 1; distance <= 4; distance += 1) {
      const tokenIndex = candidate.tokenIndex - distance;
      const head = tokens[tokenIndex];
      if (!head || head.sourceStart <= start || /[.,;:!?]/u.test(head.original) ||
          connectorKind(head)) break;
      const seam = head.sourceStart;
      if (owners.owner(seam)) continue;
      const left = evidence.probe(start, seam);
      if (!left.complete || !left.hasDose || !left.hasSchedule || !left.hasTargets) continue;
      const right = evidence.probe(seam, end);
      const targetsDiffer = left.targets.length !== right.targets.length ||
        left.targets.some(target => right.targets.indexOf(target) < 0);
      if (!right.complete || !right.hasDose || !right.hasSchedule || !right.hasTargets ||
          !targetsDiffer) continue;
      return {
        site: {
          ...candidate,
          start: seam,
          end: seam,
          tokenIndex,
          lastTokenIndex: tokenIndex,
          rightIndex: tokenIndex,
          surface: ''
        },
        left,
        right,
        end
      };
    }
    return undefined;
  };

  let seenDoseCandidate = false;
  let doseScanStart = start;
  let doseScanIndex = 0;
  for (const candidateSite of sites) {
    if (doseScanStart !== start) {
      doseScanStart = start;
      seenDoseCandidate = false;
      while (doseScanIndex < tokens.length && tokens[doseScanIndex].sourceStart < start) doseScanIndex++;
    }
    while (doseScanIndex < candidateSite.tokenIndex) {
      if (tokens[doseScanIndex].sourceStart >= start && explicitDoseAt(tokens, doseScanIndex, options)) {
        seenDoseCandidate = true;
      }
      doseScanIndex++;
    }
    const hadPriorDoseCandidate = seenDoseCandidate;
    const adjacentHead = candidateSite.start >= start
      ? adjacentAdministrationHead(candidateSite, hadPriorDoseCandidate)
      : undefined;
    if (candidateSite.kind === 'adjacent-dose') seenDoseCandidate = true;
    const site = adjacentHead?.site ?? candidateSite;
    if (site.start < start) continue;
    metrics.candidates++;
    const proposals: Proposal[] = [];
    const rejected: RejectedConstruction[] | undefined = experiment.trace ? [] : undefined;
    const owner = owners.owner(site.start);
    if (owner) {
      metrics.claimedCandidates++;
      proposals.push({ action: 'keep', rule: 'structure.no-external-split', priority: 1000, evidence: [
        { feature: 'owner.id', value: owner.id, range: { start: owner.start, end: owner.end } },
        { feature: 'owner.producer', value: owner.producer }, { feature: 'owner.resolved', value: owner.resolved }
      ] });
    } else if (site.kind === 'punctuation') {
      // A sentence/semicolon mark is an independent instruction boundary ONLY when the
      // succeeding constituent is a complete, independently dosed
      // administration. Keep punctuation inside a procedure or one dosage.
      const rightStart = tokens[site.rightIndex]?.sourceStart ?? input.length;
      if ((site.surface === ';' || site.surface === '.') && rightStart < input.length) {
        const rightEnd = probeEnd(site.rightIndex);
        // A separately dosed administration must have both dose and timing
        // evidence. Pure procedure/precaution continuations may mention
        // quantities ("re-prime with 2 sprays") without a repeat schedule;
        // probing their entire HPSG clauses adds cost but cannot introduce a
        // new dosage stage. Use typed lexical evidence first.
        const rightHasTiming = tokens.some((token, index) =>
          index >= site.rightIndex && token.sourceStart < rightEnd &&
          (hasEventTimingMeaning(token) ||
            hasTimingAbbreviationMeaning(token) ||
            token.kind === LexKind.TimeLike ||
            /^(?:daily|nightly|weekly|monthly|once|twice|thrice)$/iu.test(lexeme(token)))
        );
        if (rightHasTiming && hasUnit(site.rightIndex, rightEnd)) {
          const right = evidence.probe(rightStart, rightEnd);
          if (right.complete && right.hasHead && right.hasDose && right.hasSchedule) {
            // Preparation is not a preceding medication administration:
            // "Shake bottle. Take 5 mL BID" remains one dosed instruction.
            // Reuse the bounded typed clause probe only after a complete RHS
            // is established; ordinary one-dose input never incurs this work.
            const left = evidence.probe(start, site.start);
            const establishedLeft =
              left.hasDose && (left.method || left.hasTargets) ||
              left.hasSchedule && (left.method || left.hasDose || inheritedAdministration);
            if (establishedLeft) {
              proposals.push({ action: 'split', rule: 'regimen.separate-administration',
                priority: 720, relation: 'independent',
                evidence: [
                  { feature: 'left.established-administration', value: true },
                  { feature: 'right.complete-dosed-administration', value: true }
                ] });
            }
          }
        }
      }
      proposals.push(keep('boundary.punctuation-is-not-a-regimen', 0, 'punctuation', site.surface));
    } else if (site.kind === 'hard' || site.kind === 'slash') {
      const right = tokens[site.rightIndex];
      if (site.kind === 'hard' || right && (right.kind === LexKind.Number || CLAUSE_LEAD_WORDS.has(lexeme(right)))) {
        proposals.push({ action: 'split', rule: 'boundary.explicit-delimiter', priority: 200, relation: 'independent',
          evidence: [{ feature: 'delimiter', value: site.surface }] });
      }
    } else {
      const end = adjacentHead?.end ?? probeEnd(site.rightIndex);
      const rightStart = tokens[site.rightIndex]?.sourceStart ?? input.length;
      const rightUnit = hasUnit(site.rightIndex, end);
      const priorTiming = tokens.some(t => t.sourceStart >= start && t.sourceEnd <= site.start &&
        (hasEventTimingMeaning(t) || hasTimingAbbreviationMeaning(t) || t.kind === LexKind.TimeLike));
      const canProbe = site.kind !== 'adjacent-dose' || Boolean(adjacentHead) ||
        hadPriorDoseCandidate && priorTiming;
      const procedural = site.kind === 'comma' && evidence.proceduralBridge(site);
      if (procedural) proposals.push(keep('regimen.procedural-coordination', 900, 'actionFrames.bridge', true));

      if (!procedural && canProbe && rightStart < end) {
        const targetCue = (from: number, to: number) => {
          const ownedTarget = claims.some(claim => claim.kind === 'target-list' &&
            claim.start < to && claim.end > from);
          if (ownedTarget) return true;
          const inRange = tokens.filter(token => token.sourceStart >= from && token.sourceEnd <= to);
          if (inRange.some(token => SITE_ANCHORS.has(lexeme(token)))) return true;
          const firstMeaningful = inRange.find(token => !/[.,;:!?]/u.test(token.original));
          const firstLexeme = lexeme(firstMeaningful);
          return LATERAL_MODIFIER_WORDS.has(firstLexeme) || SITE_MULTIPLICITY_WORDS.has(firstLexeme);
        };
        // Lazy typed evidence lets each construction reject on cheap facts before running HPSG.
        // No negative vocabulary guess can suppress a licensed grammatical construction.
        let leftValue: ProbeSummary | undefined = adjacentHead?.left;
        let rightValue: ProbeSummary | undefined = adjacentHead?.right;
        let actionValue: AdviceFrame[] | undefined;
        const rightActions = () => actionValue ?? (actionValue = evidence.actions(rightStart, end));
        proposals.push(...grammaticalProposals({
          site,
          connectorKind: site.kind === 'coordination' ? coordinationConnectorKind(site.surface) : 'unknown',
          inheritedAdministration, explicitRightUnit: rightUnit,
          leftDateSpan: claims.some(c => c.kind === 'calendar-date-list' && c.start >= start && c.end <= site.start),
          rightDateSpan: claims.some(c => c.kind === 'calendar-date-list' && c.start >= rightStart && c.end <= end),
          leftTargetCue: targetCue(start, site.start),
          rightTargetCue: targetCue(rightStart, end),
          get left() { return leftValue ?? (leftValue = evidence.probe(start, site.start)); },
          get right() { return rightValue ?? (rightValue = evidence.probe(rightStart, end)); },
          get rightHasProcedure() {
            // A registered administration head (inhale, nebulize, take, etc.)
            // is an ACTION too, but is NOT a nondose procedure. Marking any
            // action as procedural suppressed legitimate independently dosed
            // "inhale 2 puffs OR nebulize 2.5 mg" alternatives.
            return rightActions().some((frame) => {
              const definition = resolveMedicationInstructionAction(frame.predicate.lemma, options);
              return definition?.procedural === true && definition.definesDose !== true;
            });
          },
          get rightAfterFirstAdministration() { return rightActions().some(a =>
            a.args.some(arg => arg.conceptId === 'after-first-administration')); }
        }, rejected));
      }

      if (site.kind === 'comma' && !procedural) {
        const right = tokens[site.rightIndex];
        const following = tokens[site.rightIndex + 1];
        if (clockEnd(tokens, site.rightIndex) !== undefined) {
          proposals.push(keep('structure.clock-continuation', 500, 'right.type', 'clock'));
        } else if (right?.kind === LexKind.Number || right?.kind === LexKind.NumberRange) {
          proposals.push({ action: 'split', rule: 'regimen.comma-numeric-head', priority: 300, relation: 'independent',
            evidence: [{ feature: 'right.lexicalType', value: right.kind }] });
        } else if (LATERAL_MODIFIER_WORDS.has(lexeme(right)) && following?.kind !== LexKind.Number) {
          proposals.push(keep('structure.site-continuation', 500, 'right.type', 'lateral-modifier'));
        } else if (right && CLAUSE_LEAD_WORDS.has(lexeme(right))) {
          const broadEnd = probeEnd(site.rightIndex, true);
          if (evidence.instructionContinuation(site.rightIndex, broadEnd)) {
            proposals.push(keep('regimen.instruction-continuation', 500, 'right.type', 'instruction'));
          } else {
            const prefix = evidence.probe(start, site.start), full = evidence.probe(start, broadEnd);
            const fronted = !prefix.hasHead && (prefix.prn || prefix.hasSchedule) ||
              full.conditionStarts.some(offset => offset < site.start);
            if (full.complete && full.hasHead && fronted) {
              proposals.push(keep('regimen.fronted-adjunct', 850, 'whole.completeWithFrontedAdjunct', true));
            } else proposals.push({ action: 'split', rule: 'regimen.comma-administration-head', priority: 250, relation: 'independent',
              evidence: [{ feature: 'right.headLexeme', value: lexeme(right) }] });
          }
        }
      }
    }
    const decision = arbitrate(site, proposals);
    if (experiment.trace) { decision.rejectedRules = rejected; plan.decisions.push(decision); }
    if (decision.selected.action === 'split') {
      const hasPredecessor = segment(
        site.start,
        decision.selected.inheritFollowingDuration === true
      );
      if (hasPredecessor) {
        plan.relations.push({ from: plan.segments.length - 1, to: plan.segments.length,
          kind: decision.selected.relation ?? 'independent', rule: decision.selected.rule,
          semanticLicense: decision.selected.semanticLicense,
          connectorKind: site.kind === 'coordination' ? coordinationConnectorKind(site.surface) : 'unknown',
          range: { start: site.start, end: site.end } });
      }
      start = site.end;
      inheritedAdministration = hasPredecessor && decision.selected.relation !== 'independent';
    }
  }
  segment(input.length);
  plan.relations = plan.relations.filter(relation =>
    relation.from >= 0 && relation.from < plan.segments.length &&
    relation.to >= 0 && relation.to < plan.segments.length
  );
  return plan;
}

/** Return the segment view of the production boundary plan. */
export function parseSigSegments(input: string, options?: ParseOptions): HpsgSigSegment[] {
  return planBoundaries(input, options).segments;
}

/** The public parse pipelines use the production planner directly. */
export { planBoundaries as createBoundaryPlan };
