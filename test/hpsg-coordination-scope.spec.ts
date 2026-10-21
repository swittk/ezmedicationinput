import { describe, expect, it } from 'vitest';
import { lintSig } from '../src/index';
import { selectHpsgCoordinationScopeConstruction } from '../src/hpsg/constructions';
import type { CoordinationScopeFacts } from '../src/regimen/types';
import { parseSig, parseSigAsync } from './helpers/r5-parser';

const source = 'instill 1 drop in left eye and 2 drops in right eye twice daily';

function scopeFacts(overrides: Partial<CoordinationScopeFacts> = {}): CoordinationScopeFacts {
  return {
    relation: {
      from: 0,
      to: 1,
      kind: 'coordination',
      rule: 'regimen.dose-continuation',
      range: { start: 32, end: 35 }
    },
    adjacent: true,
    leftComplete: true,
    rightComplete: true,
    leftExplicitDose: true,
    rightExplicitDose: true,
    leftExplicitHead: true,
    leftAdministrationContext: true,
    rightExplicitHead: false,
    leftHasSite: true,
    rightHasSite: true,
    targetsDistinct: true,
    leftHasCadence: false,
    rightHasCadence: true,
    rightHasCadenceConflict: false,
    ...overrides
  };
}

function expectBid(items: ReturnType<typeof parseSig>['items']): void {
  expect(items).toHaveLength(2);
  expect(items.map(item => item.fhir.site?.text)).toEqual(['left eye', 'right eye']);
  expect(items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([1, 2]);
  for (const item of items) {
    expect(item.fhir.timing?.repeat).toMatchObject({
      frequency: 2,
      period: 1,
      periodUnit: 'd'
    });
  }
}

describe('HPSG coordination cadence scope', () => {
  it('licenses only a complete, headed-left/head-elliptic-right dose coordination', () => {
    const selected = selectHpsgCoordinationScopeConstruction(scopeFacts());
    expect(selected).toMatchObject({
      motherType: 'coordination-phrase',
      construction: {
        kind: 'coordination',
        operation: 'scope',
        headSide: 'right',
        leftType: 'administration-clause',
        rightType: 'administration-clause'
      },
      semantic: {
        construction: {
          id: 'hpsg.cx.coordination.trailing-shared-cadence',
          operation: 'share-trailing-cadence'
        }
      }
    });

    expect(selectHpsgCoordinationScopeConstruction(scopeFacts({
      relation: { ...scopeFacts().relation, kind: 'sequence' }
    }))).toBeUndefined();
    expect(selectHpsgCoordinationScopeConstruction(scopeFacts({ rightExplicitHead: true }))).toBeUndefined();
    expect(selectHpsgCoordinationScopeConstruction(scopeFacts({ leftHasCadence: true }))).toBeUndefined();
    expect(selectHpsgCoordinationScopeConstruction(scopeFacts({ rightComplete: false }))).toBeUndefined();
    expect(selectHpsgCoordinationScopeConstruction(scopeFacts({ rightHasCadenceConflict: true }))).toBeUndefined();
  });

  it('scopes a sole trailing cadence before FHIR lowering with source and construction evidence', () => {
    const parsed = parseSig(source);
    expectBid(parsed.items);

    const firstClause = parsed.items[0].meta.canonical.clauses[0];
    expect(firstClause.schedule).toMatchObject({ frequency: 2, period: 1, periodUnit: 'd' });
    const construction = firstClause.evidence.find(item =>
      item.rule === 'hpsg.cx.coordination.trailing-shared-cadence'
    );
    expect(construction?.spans).toEqual([expect.objectContaining({ text: 'and' })]);
    expect(firstClause.evidence.some(item =>
      item.rule.startsWith('hpsg.lex.schedule.') &&
      item.spans.some(span => span.text.toLowerCase().includes('twice daily'))
    )).toBe(true);
  });

  it('distributes a final cadence right-to-left across an omitted-head coordination chain', () => {
    const parsed = parseSig(
      'apply 1 g to left arm and 2 g to right arm and 3 g to left leg twice daily'
    );
    expect(parsed.items).toHaveLength(3);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([1, 2, 3]);
    expect(parsed.items.map(item => item.fhir.site?.text)).toEqual(['left arm', 'right arm', 'left leg']);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.frequency)).toEqual([2, 2, 2]);
    expect(parsed.items.slice(0, 2).every(item =>
      item.meta.canonical.clauses[0].evidence.some(evidence =>
        evidence.rule === 'hpsg.cx.coordination.trailing-shared-cadence'
      )
    )).toBe(true);
  });

  it('keeps sync, async, and lint lowering in parity from the scoped canonical schedule', async () => {
    const [sync, asyncResult] = await Promise.all([
      Promise.resolve(parseSig(source)),
      parseSigAsync(source)
    ]);
    const linted = lintSig(source);

    expectBid(sync.items);
    expectBid(asyncResult.items);
    expectBid(linted.items.map(item => item.result));
    expect(asyncResult.items.map(item => item.fhir.timing)).toEqual(
      sync.items.map(item => item.fhir.timing)
    );
    expect(linted.items.map(item => item.result.fhir.timing)).toEqual(
      sync.items.map(item => item.fhir.timing)
    );
  });

  it('retains resolved custom site coding across carried clauses in sync, async, and lint', async () => {
    const input = 'apply 1 g at 09:00 to moob and 2 g at 20:00';
    const options = {
      siteCodeMap: {
        moob: {
          text: 'Moob (custom)',
          coding: {
            system: 'http://example.org/custom-sites',
            code: 'MOOB',
            display: 'Moob surface'
          }
        }
      }
    };
    const sync = parseSig(input, options);
    const asyncParsed = await parseSigAsync(input, options);
    const linted = lintSig(input, options);
    for (const results of [
      sync.items.map(item => item.fhir),
      asyncParsed.items.map(item => item.fhir),
      linted.items.map(item => item.result.fhir)
    ]) {
      expect(results).toHaveLength(2);
      expect(results.map(dosage => dosage.site?.text))
        .toEqual(['Moob (custom)', 'Moob (custom)']);
      expect(results.map(dosage => dosage.site?.coding?.[0]?.code))
        .toEqual(['MOOB', 'MOOB']);
    }
  });

  it('supports Thai coordination without using connector text as the semantic decision', () => {
    const parsed = parseSig('หยอดตาซ้าย 1 หยด และ ตาขวา 2 หยด วันละ 2 ครั้ง', { locale: 'th' });
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([1, 2]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.frequency)).toEqual([2, 2]);
    expect(parsed.items[0].meta.canonical.clauses[0].evidence.some(item =>
      item.rule === 'hpsg.cx.coordination.trailing-shared-cadence'
    )).toBe(true);
  });

  it.each([
    ['sequence', 'instill 1 drop in left eye then 2 drops in right eye twice daily'],
    ['independent punctuation', 'instill 1 drop in left eye; instill 2 drops in right eye twice daily'],
    ['independently headed and-clause', 'instill 1 drop in left eye and instill 2 drops in right eye twice daily'],
    ['partial right parse', 'instill 1 drop in left eye and 2 drops in right eye twice daily frobnicate']
  ])('does not extend cadence over %s', (_label, input) => {
    const parsed = parseSig(input);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0].fhir.timing).toBeUndefined();
    expect(parsed.items[0].meta.canonical.clauses[0].evidence.some(item =>
      item.rule === 'hpsg.cx.coordination.trailing-shared-cadence'
    )).toBe(false);
  });

  it('preserves an explicit left cadence instead of overriding it', () => {
    const parsed = parseSig(
      'instill 1 drop in left eye once daily and 2 drops in right eye twice daily'
    );
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.frequency)).toEqual([1, 2]);
  });

  it('rejects a conflicting cadence donor before either daughter is lowered', () => {
    const parsed = parseSig(
      'instill 1 drop in left eye and 2 drops in right eye twice daily q8h'
    );
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.every(item => item.fhir.timing === undefined)).toBe(true);
    expect(parsed.items[0].meta.canonical.clauses[0].evidence.some(item =>
      item.rule === 'hpsg.cx.coordination.trailing-shared-cadence'
    )).toBe(false);
  });
});
