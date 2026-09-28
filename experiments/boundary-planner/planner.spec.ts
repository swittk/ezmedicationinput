import { describe, expect, it } from 'vitest';
import { planBoundaries } from './planner';
import { OwnershipIndex } from './structures';
import { expandAdministrationTargets, expandLintAdministrationTargets, recognizeAdministrationTargetGroups } from './targets';
import { recognizeCycles } from './cycles';
import { normalizeCandidateModulePath } from './integration.mjs';
import { formatSig, parseSig } from '../../src/index';
import { arbitrate } from './grammar';
import { EvidenceContext } from './evidence';
import { lexInput } from '../../src/lexer/lex';
import { annotateLexTokens } from '../../src/lexer/meaning';
import { ORIGINAL_CORPUS as CORPUS, historicalCases } from './corpus';
import type { BoundarySite, StructuralClaim } from './types';

describe('experimental boundary planner structural contracts', () => {
  it.each(CORPUS.filter(c => c.partition !== 'challenge'))('preserves source/ownership/trace invariants: $id', c => {
    const plan = planBoundaries(c.input, c.options, { trace: true });
    let end = 0;
    const owners = new OwnershipIndex(plan.claims);
    for (const segment of plan.segments) {
      expect(segment.start).toBeGreaterThanOrEqual(end);
      expect(segment.end).toBeGreaterThan(segment.start);
      expect(segment.text).toBe(c.input.slice(segment.start, segment.end));
      end = segment.end;
    }
    for (const decision of plan.decisions) {
      expect(decision.selected.rule.length).toBeGreaterThan(0);
      expect(decision.conflict).toBe(false);
      if (decision.selected.action === 'split') expect(owners.owner(decision.site.start)).toBeUndefined();
      else if (owners.owner(decision.site.start)) expect(decision.selected.rule).toBe('structure.no-external-split');
    }
    expect(planBoundaries(c.input, c.options, { trace: true })).toEqual(plan);
    expect(planBoundaries(c.input, c.options, { cache: false }).segments).toEqual(plan.segments);
  });

  it('explains the original Thai failure without inspecting separator language in the arbiter', () => {
    const c = historicalCases[0];
    const plan = planBoundaries(c.input, c.options, { trace: true });
    const coordination = plan.decisions.find(d => d.site.surface.trim() === 'และ');
    expect(coordination?.selected.rule).toBe('structure.no-external-split');
    expect(coordination?.selected.evidence.some(e => e.feature === 'owner.producer' && e.value === 'findMedicationDateListSpans')).toBe(true);
    expect(plan.decisions.find(d => d.site.kind === 'sequence')?.selected.rule).toBe('regimen.sequence');
    expect(plan.segments).toHaveLength(2);
    const unowned = planBoundaries(c.input, c.options, { ownership: false, trace: true });
    expect(unowned.decisions.some(d => d.selected.rule === 'structure.no-external-split')).toBe(false);
    // Other grammatical constraints may independently keep a boundary. Ablation measures
    // that interaction; it must not require deliberately wrong output to prove ownership.
    expect(unowned.metrics.claimedCandidates).toBe(0);
  });

  it('claims clocks and weekdays without making their tokens opaque to HPSG', () => {
    const plan = planBoundaries('take 1 tab at 08:00 and 20:00 every Monday and Thursday', undefined, { trace: true });
    expect(plan.claims.map(c => c.kind)).toContain('clock-list');
    expect(plan.claims.map(c => c.kind)).toContain('weekday-list');
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0].text).toContain('08:00 and 20:00');
  });

  it('ownership works on nested/overlapping spans, not just disjoint date lists', () => {
    let seed = 173;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    const claims: StructuralClaim[] = Array.from({ length: 100 }, (_, i): StructuralClaim => {
      const start = random() % 150, end = start + 1 + random() % 50;
      return { id: String(i), start, end, kind: 'calendar-date-list', policy: 'no-external-split', producer: 'test', resolved: true };
    }).sort((a, b) => a.start - b.start || b.end - a.end);
    const index = new OwnershipIndex(claims);
    for (let at = 0; at < 200; at++) {
      const expected = claims.filter(c => c.start < at && at < c.end);
      expect(Boolean(index.owner(at))).toBe(expected.length > 0);
      const owner = index.owner(at);
      if (owner) expect(owner.end - owner.start).toBe(Math.max(...expected.map(c => c.end - c.start)));
    }
  });

  it('does not resolve a genuine equal-priority conflict by rule ordering', () => {
    const site: BoundarySite = { start: 10, end: 13, kind: 'coordination', tokenIndex: 2, lastTokenIndex: 2, rightIndex: 3, surface: 'and' };
    const decision = arbitrate(site, [
      { action: 'keep', rule: 'test.keep', priority: 700, evidence: [] },
      { action: 'split', rule: 'test.split', priority: 700, relation: 'coordination', evidence: [] }
    ]);
    expect(decision.conflict).toBe(true);
    expect(decision.selected.rule).toBe('boundary.unresolved-conflict');
    expect(decision.selected.action).toBe('keep');
  });

  it('uses target ownership to split a changed-target phase but keeps an internal target list', () => {
    const input = 'Apply to right arm on 21/09/2026 and right arm and right leg on 22/09/2026 onwards daily';
    const options = { locale: 'en-GB', datePolicy: { referenceDate: '2026-09-20' } };
    const plan = planBoundaries(input, options, { trace: true });
    expect(plan.segments.map(segment => segment.text)).toEqual([
      'Apply to right arm on 21/09/2026',
      'right arm and right leg on 22/09/2026 onwards daily'
    ]);
    const first = plan.decisions.filter(decision => decision.site.surface.trim() === 'and');
    expect(first).toHaveLength(2);
    expect(first[0].selected.rule).toBe('regimen.target-phase-transition');
    expect(first[0].selected.action).toBe('split');
    expect(first[0].selected.relation).toBe('sequence');
    expect(first[1].selected.rule).toBe('structure.no-external-split');
    expect(plan.claims.some(claim => claim.kind === 'target-list' &&
      input.slice(claim.start, claim.end) === 'right arm and right leg')).toBe(true);
  });

  it('distinguishes simultaneous target conjunction from alternative target choice', () => {
    const andGroups = recognizeAdministrationTargetGroups('Apply to right arm and right leg daily');
    expect(andGroups).toHaveLength(1);
    expect(andGroups[0].coordination).toBe('conjunction');
    const orGroups = recognizeAdministrationTargetGroups('Apply to right arm or right leg daily');
    expect(orGroups).toHaveLength(1);
    expect(orGroups[0].coordination).toBe('disjunction');
  });

  it('does not decompose a pre-coordinated coded site such as both eyes', () => {
    expect(recognizeAdministrationTargetGroups('Instill 1 drop into both eyes daily')).toEqual([]);
    const plan = planBoundaries('Instill 1 drop into both eyes daily', undefined, { trace: true });
    expect(plan.segments).toHaveLength(1);
  });

  it('normalizes Vite module ids across Windows separator styles before matching source files', () => {
    const windowsPath = { resolve: (value: string) => value.replace(/\//gu, '\\') };
    const forward = normalizeCandidateModulePath('C:/repo/src/index.ts?shadow=1', windowsPath);
    const backward = normalizeCandidateModulePath('C:\\repo\\src\\index.ts?shadow=1', windowsPath);
    expect(forward).toBe('C:/repo/src/index.ts');
    expect(backward).toBe(forward);
  });


  it('never emits a relation whose segment endpoint does not exist', () => {
    const leading = planBoundaries('/ take 1 tab daily', undefined, { trace: true });
    expect(leading.segments.map(segment => segment.text)).toEqual(['take 1 tab daily']);
    expect(leading.relations).toEqual([]);

    for (const input of [
      '/ take 1 tab daily',
      'take 1 tab daily then take 2 tab daily',
      'take 1 tab daily then then take 2 tab daily'
    ]) {
      const plan = planBoundaries(input, undefined, { trace: true });
      for (const relation of plan.relations) {
        expect(relation.from).toBeGreaterThanOrEqual(0);
        expect(relation.to).toBeGreaterThanOrEqual(0);
        expect(relation.from).toBeLessThan(plan.segments.length);
        expect(relation.to).toBeLessThan(plan.segments.length);
      }
    }
  });

  it('preserves lint issues when alternative administration targets are deliberately not expanded', () => {
    const input = 'Apply to right arm or right leg daily from 22/09/2026 onwards';
    const options = { locale: 'en-GB' as const, datePolicy: { referenceDate: '2026-09-20' } };
    const result = parseSig(input, options);
    const issue = {
      message: 'synthetic unresolved target evidence',
      text: 'right leg',
      tokens: ['right', 'leg']
    };
    const entry = { result, issues: [issue] };
    const unchanged = expandLintAdministrationTargets([entry], options, formatSig);
    expect(unchanged).toHaveLength(1);
    expect(unchanged[0]).toBe(entry);
    expect(unchanged[0].issues).toEqual([issue]);
  });

  it('removes target-owned lint issues only when conjunction lowering actually expands the result', () => {
    const input = 'Apply to right arm and right leg daily from 22/09/2026 onwards';
    const options = { locale: 'en-GB' as const, datePolicy: { referenceDate: '2026-09-20' } };
    const result = parseSig(input, options);
    const issue = {
      message: 'synthetic target issue',
      text: 'right leg',
      tokens: ['right', 'leg']
    };
    const expanded = expandLintAdministrationTargets([{ result, issues: [issue] }], options, formatSig);
    expect(expanded).toHaveLength(2);
    expect(expanded.every(entry => entry.issues.length === 0)).toBe(true);
    expect(expanded.map(entry => entry.result.fhir.site?.text)).toEqual(['right arm', 'right leg']);
  });

  it('preserves the first specific finite-cycle validation error', () => {
    const invalidDay = recognizeCycles(
      'take 1 tab at 08:00 on days 0,8 every 28 days for 2 cycles',
      { locale: 'en-GB', datePolicy: { referenceDate: '2026-09-20' } }
    );
    expect(invalidDay).toHaveLength(1);
    expect(invalidDay[0].error).toBe('invalid-cycle-day-range');

    const missingLength = recognizeCycles(
      'take 1 tab at 08:00 on days 1,8 starting 22/09/2026 for 2 cycles',
      { locale: 'en-GB', datePolicy: { referenceDate: '2026-09-20' } }
    );
    expect(missingLength).toHaveLength(1);
    expect(missingLength[0].error).toBe('missing-cycle-length');
  });

  it('deduplicates alternative-target warnings across repeated non-expanding passes', () => {
    const input = 'Apply to right arm or right leg daily from 22/09/2026 onwards';
    const options = { locale: 'en-GB' as const, datePolicy: { referenceDate: '2026-09-20' } };
    const result = parseSig(input, options);
    const warning = 'Alternative administration targets retained as text; not expanded into simultaneous Dosage items.';
    const first = expandAdministrationTargets([result], options, formatSig);
    const second = expandAdministrationTargets(first, options, formatSig);
    expect(second).toHaveLength(1);
    expect(second[0]).toBe(result);
    expect(second[0].warnings.filter(value => value === warning)).toHaveLength(1);
    for (const clause of second[0].meta.canonical.clauses) {
      expect((clause.warnings ?? []).filter(value => value === warning)).toHaveLength(1);
    }
  });

  it('caches only inside an input/options scope and never infers numeric MDY from locale', () => {
    const input = 'take 1 tab on 5/10/2026';
    const metrics = { lexicalPasses: 0, dateScans: 0, actionScans: 0, clauseProbes: 0, probeCacheHits: 0, probedTokens: 0, candidates: 0, claimedCandidates: 0 };
    const tokens = annotateLexTokens(lexInput(input));
    const options = { locale: 'en-US' };
    const context = new EvidenceContext(input, tokens, options, metrics, true);
    expect(context.probe(0, input.length).clause.schedule?.calendarEvents?.[0].isoDate).toBe('2026-10-05');
    context.probe(0, input.length);
    expect(metrics.clauseProbes).toBe(1);
    expect(metrics.probeCacheHits).toBe(1);
    const mdy = new EvidenceContext(input, tokens, { datePolicy: { dateOrder: 'MDY' } }, { ...metrics }, true);
    expect(mdy.probe(0, input.length).clause.schedule?.calendarEvents?.[0].isoDate).toBe('2026-05-10');
    expect(context.probe(0, input.length).clause.schedule?.calendarEvents?.[0].isoDate).toBe('2026-10-05');
  });
});
