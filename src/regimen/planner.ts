import { lexInput } from '../lexer/lex';
import { matchCalendarExclusion } from '../hpsg/rules/condition-rules';
import { parseMedicationGuard } from '../medication-condition';
import { findMedicationDateListSpans } from '../date-interpretation';
import {
  annotateLexTokens,
  hasEventTimingMeaning,
  hasSiteMeaningCandidate,
  hasTimingAbbreviationMeaning
} from '../lexer/meaning';
import { LexKind } from '../lexer/token-types';
import { normalizeUnit } from '../unit-lexicon';
import { ACTION_COORDINATION_CONNECTORS, ACTION_SEQUENCE_MARKERS, CLAUSE_LEAD_WORDS,
  HARD_SEGMENT_BOUNDARY_TOKENS, LATERAL_MODIFIER_WORDS, SITE_ANCHORS, SITE_MULTIPLICITY_WORDS,
  coordinationConnectorKind } from '../hpsg/lexical-classes';
import type { ParseOptions, AdviceFrame } from '../types';
import type { Token } from '../parser-state';
import { buildCustomSiteHints } from '../parser';
import type { HpsgSigSegment } from '../hpsg/segmenter';
import type { BoundaryPlan, BoundarySite, PlannerOptions, Proposal, ProbeSummary } from './types';
import { EvidenceContext } from './evidence';
import { recognizeStructures, OwnershipIndex, clockEnd, lexeme } from './structures';
import { grammaticalProposals, arbitrate } from './grammar';
import type { RejectedConstruction } from './grammar';

function connectorKind(token: Token | undefined): 'coordination' | 'sequence' | undefined {
  const text = lexeme(token);
  return ACTION_SEQUENCE_MARKERS.has(text) ? 'sequence' : ACTION_COORDINATION_CONNECTORS.has(text) ? 'coordination' : undefined;
}
function isHard(token: Token): boolean {
  return HARD_SEGMENT_BOUNDARY_TOKENS.has(token.original.trim().toLowerCase()) || token.original === '\n' || token.original === '\r';
}
function explicitDoseAt(tokens: Token[], i: number, options?: ParseOptions): boolean {
  const token = tokens[i];
  return Boolean(token && (token.kind === LexKind.Number || token.kind === LexKind.NumberRange) &&
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
    const guard = parseMedicationGuard(input);
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

  for (const site of sites) {
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
      // A semicolon is an independent instruction boundary ONLY when the
      // succeeding constituent is a complete, independently dosed
      // administration. Keep punctuation inside a procedure or one dosage.
      const rightStart = tokens[site.rightIndex]?.sourceStart ?? input.length;
      if (site.surface === ';' && rightStart < input.length) {
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
          proposals.push({ action: 'split', rule: 'regimen.separate-administration',
            priority: 720, relation: 'independent',
            evidence: [{ feature: 'right.complete-dosed-administration', value: true }] });
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
      const end = probeEnd(site.rightIndex);
      const rightStart = tokens[site.rightIndex]?.sourceStart ?? input.length;
      const rightUnit = hasUnit(site.rightIndex, end);
      const priorTiming = tokens.some(t => t.sourceStart >= start && t.sourceEnd <= site.start &&
        (hasEventTimingMeaning(t) || t.kind === LexKind.TimeLike));
      const canProbe = site.kind !== 'adjacent-dose' || priorTiming;
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
        let leftValue: ProbeSummary | undefined, rightValue: ProbeSummary | undefined;
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
          get rightHasProcedure() { return rightActions().length > 0; },
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
