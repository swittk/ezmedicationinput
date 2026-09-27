import { lexInput } from '../../src/lexer/lex';
import { annotateLexTokens, hasEventTimingMeaning } from '../../src/lexer/meaning';
import { LexKind } from '../../src/lexer/token-types';
import { normalizeUnit } from '../../src/unit-lexicon';
import { ACTION_COORDINATION_CONNECTORS, ACTION_SEQUENCE_MARKERS, CLAUSE_LEAD_WORDS,
  HARD_SEGMENT_BOUNDARY_TOKENS, LATERAL_MODIFIER_WORDS } from '../../src/hpsg/lexical-classes';
import type { ParseOptions, AdviceFrame } from '../../src/types';
import type { Token } from '../../src/parser-state';
import type { HpsgSigSegment } from '../../src/hpsg/segmenter';
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

/** Experimental boundary grammar; deliberately not exported by the package or used by production. */
export function planBoundaries(input: string, options?: ParseOptions, experiment: PlannerOptions = {}): BoundaryPlan {
  const tokens = annotateLexTokens(lexInput(input));
  const metrics = { lexicalPasses: 1, dateScans: 1, actionScans: 0, clauseProbes: 0, probeCacheHits: 0,
    probedTokens: 0, candidates: 0, claimedCandidates: 0 };
  const claims = recognizeStructures({ input, options, tokens });
  const owners = new OwnershipIndex(experiment.ownership === false ? [] : claims);
  const sites = candidateSites(input, tokens, options);
  const evidence = new EvidenceContext(input, tokens, options, metrics, experiment.cache !== false);
  const plan: BoundaryPlan = { experimental: true, segments: [], claims, decisions: [], metrics };
  let start = 0, inheritedAdministration = false;

  const segment = (end: number, inheritTrailingDurationFromNext = false) => {
    let a = start, b = end;
    while (a < b && /\s/u.test(input[a])) a++;
    while (b > a && /\s/u.test(input[b - 1])) b--;
    if (b > a) plan.segments.push({ text: input.slice(a, b), start: a, end: b,
      inheritTrailingDurationFromNext: inheritTrailingDurationFromNext || undefined });
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
        // Lazy typed evidence lets each construction reject on cheap facts before running HPSG.
        // No negative vocabulary guess can suppress a licensed grammatical construction.
        let leftValue: ProbeSummary | undefined, rightValue: ProbeSummary | undefined;
        let actionValue: AdviceFrame[] | undefined;
        const rightActions = () => actionValue ?? (actionValue = evidence.actions(rightStart, end));
        proposals.push(...grammaticalProposals({
          site, inheritedAdministration, explicitRightUnit: rightUnit,
          leftDateSpan: claims.some(c => c.kind === 'calendar-date-list' && c.start >= start && c.end <= site.start),
          rightDateSpan: claims.some(c => c.kind === 'calendar-date-list' && c.start >= rightStart && c.end <= end),
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
      segment(site.start, decision.selected.relation === 'shared-duration');
      start = site.end;
      inheritedAdministration = decision.selected.relation !== 'independent';
    }
  }
  segment(input.length);
  return plan;
}

/** Adapter used ONLY by the experiment's module substitution, never production. */
export function parseSigSegments(input: string, options?: ParseOptions): HpsgSigSegment[] {
  return planBoundaries(input, options).segments;
}
