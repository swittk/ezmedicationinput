import { describe, expect, it } from 'vitest';
import {
  calculateTotalUnits, getDosageCondition, getDosageExcludedWeekdays,
  lintSig, nextDueDoses
} from '../src/index';
import { canonicalToFhir } from '../src/fhir';
import { parseClauseState } from '../src/parser';
import { applyCoordinatedCadenceScopes } from '../src/regimen/coordination-scope';
import { createBoundaryPlan } from '../src/regimen/candidate-adapter';
import type { BoundaryPlan } from '../src/regimen/types';
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
      connectorKind: 'conjunction',
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
    leftHasSchedule: false,
    rightHasSchedule: true,
    leftHasCadence: false,
    rightHasCadence: true,
    leftHasPrn: false,
    rightHasPrn: false,
    leftHasFrontedSchedule: false,
    leftHasFrontedPrn: false,
    rightHasTrailingSchedule: true,
    rightHasTrailingPrn: false,
    rightHasTrailingSafetyGuard: false,
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

  it('classifies disjunction as an alternative dosage construction', () => {
    const selected = selectHpsgCoordinationScopeConstruction(scopeFacts({
      relation: {
        ...scopeFacts().relation,
        kind: 'alternative',
        connectorKind: 'disjunction',
        rule: 'regimen.disjunctive-dosage-choice'
      }
    }));
    expect(selected?.semantic.construction.id)
      .toBe('hpsg.cx.coordination.disjunctive-dosage-choice');
    expect(selected?.construction).toMatchObject({
      kind: 'coordination',
      leftType: 'administration-clause',
      rightType: 'administration-clause'
    });
    expect(selected?.construction.headSide).toBeUndefined();
  });

  it('selects the typed adjunct daughter as the coordination head', () => {
    const selected = selectHpsgCoordinationScopeConstruction(scopeFacts({
      leftHasSchedule: true,
      rightHasSchedule: false,
      leftHasCadence: true,
      rightHasCadence: false,
      leftHasFrontedSchedule: true,
      rightHasTrailingSchedule: false
    }));
    expect(selected?.semantic.construction.operation).toBe('share-leading-adjuncts');
    expect(selected?.construction.headSide).toBe('left');
  });

  it.each([
    ['instill 1 drop in left eye or 2 drops in right eye twice daily', [2, 2], [undefined, undefined]],
    ['instill 1 drop in left eye once daily or 2 drops in right eye twice daily', [1, 2], [undefined, undefined]],
    ['instill 1 drop in left eye at 08:00 or 2 drops in right eye at 20:00', [undefined, undefined], [['08:00:00'], ['20:00:00']]],
    ['หยอดตาซ้าย 1 หยด วันละครั้ง หรือ ตาขวา 2 หยด วันละ 2 ครั้ง', [1, 2], [undefined, undefined]],
    ['หยอดตาซ้าย 1 หยด เวลา 08:00 หรือ ตาขวา 2 หยด เวลา 20:00', [undefined, undefined], [['08:00:00'], ['20:00:00']]]
  ] as const)('keeps both editable disjunctive dosage suggestions: %s', async (
    input, expectedFrequencies, expectedTimes
  ) => {
    const plan = createBoundaryPlan(input);
    expect(plan.relations).toContainEqual(expect.objectContaining({
      kind: 'alternative',
      connectorKind: 'disjunction',
      rule: 'regimen.disjunctive-dosage-choice'
    }));
    const sync = parseSig(input);
    const asyncParsed = await parseSigAsync(input);
    const linted = lintSig(input);
    for (const items of [
      sync.items,
      asyncParsed.items,
      linted.items.map(entry => entry.result)
    ]) {
      expect(items).toHaveLength(2);
      expect(items.map(item => item.fhir.site?.text)).toEqual(['left eye', 'right eye']);
      expect(items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value))
        .toEqual([1, 2]);
      expect(items.map(item => item.meta.canonical.clauses[0].schedule?.frequency))
        .toEqual(expectedFrequencies);
      expect(items.map(item => item.fhir.timing?.repeat?.frequency))
        .toEqual(expectedFrequencies);
      expect(items.map(item => item.fhir.timing?.repeat?.timeOfDay))
        .toEqual(expectedTimes);
      expect(items.every(item => item.warnings.length === 0)).toBe(true);
    }
    expect(linted.issues).toEqual([]);
  });

  it.each([
    ['instill 1 drop in left eye and 2 drops in right eye twice daily only if BP > 160',
      [2, 2], 'condition', 'gt', 160],
    ['instill 1 drop in left eye once daily and 2 drops in right eye twice daily unless BP < 100',
      [1, 2], 'condition', 'lt', 100],
    ['instill 1 drop in left eye and 2 drops in right eye twice daily except Sunday',
      [undefined, 2], 'exclusion', undefined, undefined],
    ['instill 1 drop in left eye and 2 drops in right eye and 1 drop in both eyes twice daily only if BP > 160',
      [2, 2, 2], 'condition', 'gt', 160],
    ['instill 1 drop in left eye and 2 drops in right eye and 1 drop in both eyes twice daily except Sunday',
      [undefined, undefined, 2], 'exclusion', undefined, undefined]
  ] as const)('keeps locally parsed cadence and an editable trailing guard/exclusion: %s', async (
    input, expectedFrequencies, guardKind, operation, value
  ) => {
    const sync = parseSig(input);
    const asyncParsed = await parseSigAsync(input);
    const linted = lintSig(input);
    const expectedItems = input.includes('and 1 drop in both eyes') ? 3 : 2;
    for (const result of [sync, asyncParsed]) {
      expect(result.items).toHaveLength(expectedItems);
      expect(result.items.map(item => item.fhir.site?.text)).toEqual(
        expectedItems === 3
          ? ['left eye', 'right eye', 'both eyes']
          : ['left eye', 'right eye']
      );
      expect(result.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value))
        .toEqual(expectedItems === 3 ? [1, 2, 1] : [1, 2]);
      expect(result.items.map(item => item.fhir.timing?.repeat?.frequency))
        .toEqual(expectedFrequencies);
      const guarded = result.items.at(-1)!;
      if (guardKind === 'condition') {
        const condition = getDosageCondition(guarded.fhir);
        if (input.includes('unless')) {
          expect(condition).toMatchObject({
            kind: 'not',
            condition: { kind: 'measurement', name: 'bp', operation, value }
          });
        } else {
          expect(condition).toMatchObject({
            kind: 'measurement', name: 'bp', operation, value
          });
        }
        expect(guarded.fhir.text).toMatch(/(?:only if|unless) BP/u);
      } else {
        expect(getDosageExcludedWeekdays(guarded.fhir)).toEqual(['sun']);
        expect(guarded.fhir.timing?.repeat?.dayOfWeek)
          .toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
        expect(guarded.fhir.text).toContain('except Sunday');
      }
      expect(result.items.every(item => item.warnings.length === 0)).toBe(true);
    }
    expect(linted.issues).toEqual([]);
  });

  it.each([
    ['exact', '30 minutes before breakfast', 'offset', 30, 2],
    ['minimum', 'at least 30 minutes before breakfast', 'offsetMin', 30, 2],
    ['maximum', 'at most 30 minutes before breakfast', 'offsetMax', 30, 2],
    ['exact three-way', '30 minutes before breakfast', 'offset', 30, 3],
    ['minimum three-way', 'at least 30 minutes before breakfast', 'offsetMin', 30, 3],
    ['maximum three-way', 'at most 30 minutes before breakfast', 'offsetMax', 30, 3]
  ] as const)('keeps the event anchor and %s offset atomic', (
    _label, phrase, field, value, daughterCount
  ) => {
    const daughters = daughterCount === 2
      ? 'instill 1 drop in left eye and 2 drops in right eye'
      : 'instill 1 drop in left eye and 2 drops in right eye and 1 drop in both eyes';
    const parsed = parseSig(`${daughters} ${phrase}`);
    expect(parsed.items).toHaveLength(daughterCount);
    for (const item of parsed.items) {
      const schedule = item.meta.canonical.clauses[0].schedule!;
      expect(schedule.when).toEqual(['ACM']);
      expect(schedule[field]).toBe(value);
      if (field === 'offset') {
        expect(item.fhir.timing?.repeat?.offset).toBe(value);
      } else {
        expect(item.fhir.timing?.repeat?.extension).toContainEqual(
          expect.objectContaining({
            url: expect.stringContaining(field === 'offsetMin' ? 'offset-min' : 'offset-max'),
            valueInteger: value
          })
        );
      }
      expect(item.longText.toLowerCase()).toContain(phrase);
    }
    if (field === 'offset') {
      for (const item of parsed.items) {
        expect(nextDueDoses(item.fhir, {
          from: '2026-10-22T00:00:00+07:00',
          orderedAt: '2026-10-22T00:00:00+07:00',
          timeZone: 'Asia/Bangkok',
          eventClock: { CM: '08:00' },
          limit: 1
        })).toEqual(['2026-10-22T07:30:00+07:00']);
      }
    }
  });

  it.each([
    'instill 1 drop in left eye and 2 drops in right eye every 5 minutes up to 3 doses',
    'instill 1 drop in left eye and 2 drops in right eye and 1 drop in both eyes every 5 minutes up to 3 doses'
  ])('keeps recurrence and its total cap atomic: %s', input => {
    const parsed = parseSig(input);
    for (const item of parsed.items) {
      expect(item.meta.canonical.clauses[0].schedule).toMatchObject({
        count: 1, countMax: 3, period: 5, periodUnit: 'min'
      });
      expect(item.fhir.timing?.repeat).toMatchObject({
        count: 1, countMax: 3, period: 5, periodUnit: 'min'
      });
      expect(item.longText).toContain('for up to 3 doses');
      expect(nextDueDoses(item.fhir, {
        from: '2026-10-22T00:00:00Z',
        orderedAt: '2026-10-22T00:00:00Z',
        timeZone: 'UTC', limit: 8, priorCount: 0
      })).toHaveLength(3);
    }
  });

  it.each([
    'instill 1 drop in left eye and 2 drops in right eye every 4 hours max 3 doses daily',
    'instill 1 drop in left eye and 2 drops in right eye and 1 drop in both eyes every 4 hours max 3 doses daily'
  ])('keeps recurrence and its per-period cap atomic: %s', input => {
    const parsed = parseSig(input);
    for (const item of parsed.items) {
      expect(item.meta.canonical.clauses[0].schedule).toMatchObject({
        period: 4,
        periodUnit: 'h',
        occurrenceCap: { max: 3, period: 1, periodUnit: 'd' }
      });
      expect(item.fhir.timing?.repeat?.extension).toContainEqual(
        expect.objectContaining({ url: expect.stringContaining('timing-occurrence-cap') })
      );
      expect(item.longText).toContain('maximum 3 doses per day');
      expect(nextDueDoses(item.fhir, {
        from: '2026-10-22T00:00:00Z',
        orderedAt: '2026-10-22T00:00:00Z',
        timeZone: 'UTC', limit: 4
      })).toEqual([
        '2026-10-22T00:00:00+00:00',
        '2026-10-22T04:00:00+00:00',
        '2026-10-22T08:00:00+00:00',
        '2026-10-23T00:00:00+00:00'
      ]);
    }
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

  it.each([
    ['duration', 'instill 1 drop in left eye for 3 days', 'boundsDuration', 3],
    ['calendar start', 'instill 1 drop in left eye starting 2026-11-01', 'boundsPeriod', '2026-11-01'],
    ['total count', 'instill 1 drop in left eye at most three times', 'count', 3]
  ])('retains left %s when a licensed coordination inherits the right cadence', (
    _kind, leftText, boundedField, expected
  ) => {
    const rightText = '2 drops in right eye twice daily';
    const source = leftText + ' and ' + rightText;
    const rightStart = leftText.length + 5;
    const left = parseClauseState(leftText, { datePolicy: { referenceDate: '2026-10-22' } });
    const right = parseClauseState(rightText);
    const priorSchedule = left.primaryClause.schedule;
    const localEvidence = {
      rule: 'hpsg.lex.schedule.left-bound',
      spans: [{ start: 0, end: leftText.length, text: leftText }]
    };
    priorSchedule!.evidence = [localEvidence];
    const plan = {
      segments: [
        { text: leftText, start: 0, end: leftText.length },
        { text: rightText, start: rightStart, end: source.length }
      ],
      relations: [{
        from: 0, to: 1, kind: 'coordination', connectorKind: 'conjunction',
        rule: 'regimen.dose-continuation',
        range: { start: leftText.length + 1, end: rightStart - 1 }
      }]
    } as BoundaryPlan;
    const applied = applyCoordinatedCadenceScopes([
      { state: left, start: 0, end: leftText.length },
      { state: right, start: rightStart, end: source.length }
    ], plan, source);
    expect(applied.map(item => item.rule)).toEqual([
      'hpsg.cx.coordination.trailing-shared-cadence'
    ]);

    const scoped = left.primaryClause.schedule!;
    expect(scoped).toMatchObject({ timingCode: 'BID', frequency: 2, period: 1, periodUnit: 'd' });
    expect(scoped.evidence).toContainEqual(localEvidence);
    expect(scoped.evidence!.some(item =>
      item.rule === 'hpsg.cx.coordination.trailing-shared-cadence'
    )).toBe(true);
    expect(right.primaryClause.schedule).toMatchObject({ frequency: 2, periodUnit: 'd' });
    expect(priorSchedule).not.toBe(scoped);

    const fhir = canonicalToFhir(left.primaryClause);
    expect(fhir.timing?.repeat?.frequency).toBe(2);
    if (boundedField === 'boundsDuration') {
      expect(fhir.timing?.repeat?.boundsDuration?.value).toBe(expected);
      expect(calculateTotalUnits({
        dosage: fhir,
        from: '2026-10-22T08:00:00+07:00',
        orderedAt: '2026-10-22T08:00:00+07:00',
        timeZone: 'Asia/Bangkok',
        durationValue: 14,
        durationUnit: 'd'
      }).totalUnits).toBe(6);
    } else if (boundedField === 'boundsPeriod') {
      expect(fhir.timing?.repeat?.boundsPeriod?.start).toBe(expected);
      expect(nextDueDoses(fhir, {
        from: '2026-10-22T08:00:00+07:00',
        orderedAt: '2026-10-22T08:00:00+07:00',
        timeZone: 'Asia/Bangkok', limit: 4
      }).every(instant => instant >= '2026-11-01')).toBe(true);
    } else {
      expect(fhir.timing?.repeat?.count).toBe(1);
      expect(fhir.timing?.repeat?.countMax).toBe(expected);
    }
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

  it('keeps independently recognized alternative cadences in editable suggestions', () => {
    const input = 'instill 1 drop in left eye once daily or 2 drops in right eye twice daily';
    const parsed = parseSig(input);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.meta.canonical.clauses[0].schedule?.frequency))
      .toEqual([1, 2]);
    expect(parsed.items.map(item => item.fhir.site?.text)).toEqual(['left eye', 'right eye']);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value))
      .toEqual([1, 2]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.frequency)).toEqual([1, 2]);
    expect(parsed.items.map(item => item.longText)).toEqual([
      'Instill 1 drop once daily in the left eye.',
      'Instill 2 drops twice daily in the right eye.'
    ]);
    expect(parsed.items.every(item => item.warnings.length === 0)).toBe(true);
  });

  it('scopes trailing course bounds over the coordination phrase while retaining local bounds', () => {
    const duration = parseSig(
      'instill 1 drop in left eye and 2 drops in right eye and 1 drop in both eyes twice daily for 3 days'
    );
    expect(duration.items).toHaveLength(3);
    for (const item of duration.items) {
      expect(item.meta.canonical.clauses[0].schedule).toMatchObject({
        frequency: 2, duration: 3, durationUnit: 'd'
      });
      expect(item.fhir.timing?.repeat?.boundsDuration?.value).toBe(3);
      expect(item.longText).toContain('for 3 days');
    }

    const end = parseSig(
      'instill 1 drop in left eye and 2 drops in right eye twice daily until 2026-10-24'
    );
    expect(end.items.map(item => item.meta.canonical.clauses[0].schedule?.boundsEnd))
      .toEqual(['2026-10-24', '2026-10-24']);
    expect(end.items.map(item => item.fhir.timing?.repeat?.boundsPeriod?.end))
      .toEqual(['2026-10-24', '2026-10-24']);

    const local = parseSig(
      'instill 1 drop in left eye for 5 days and 2 drops in right eye twice daily for 3 days'
    );
    expect(local.items[0].meta.canonical.clauses[0].schedule).toMatchObject({
      frequency: 2, duration: 5, durationUnit: 'd'
    });
    expect(local.items[1].meta.canonical.clauses[0].schedule).toMatchObject({
      frequency: 2, duration: 3, durationUnit: 'd'
    });
  });

  it.each([
    ['instill 1 drop in left eye and 2 drops in right eye twice daily as needed for eye irritation', 'eye irritation'],
    ['หยอดตาซ้าย 1 หยด และ ตาขวา 2 หยด วันละ 2 ครั้ง เมื่อมีอาการระคายเคือง', 'มีอาการระคายเคือง']
  ])('scopes a trailing exact PRN adjunct without recoding it: %s', (input, reason) => {
    const parsed = parseSig(input);
    expect(parsed.items).toHaveLength(2);
    for (const item of parsed.items) {
      expect(item.meta.canonical.clauses[0].prn).toMatchObject({
        enabled: true,
        reason: { text: reason }
      });
      expect(item.fhir.asNeeded).toBe(true);
      expect(item.fhir.asNeededFor?.[0]?.text).toBe(reason);
    }
    expect(parsed.items[0].meta.canonical.clauses[0].prn?.reason?.coding?.code)
      .toBe(parsed.items[1].meta.canonical.clauses[0].prn?.reason?.coding?.code);
  });

  it('scopes licensed leading schedule and PRN adjuncts left-to-right', () => {
    const cadence = parseSig(
      'twice daily instill 1 drop in left eye and 2 drops in right eye and 1 drop in both eyes'
    );
    expect(cadence.items.map(item => item.fhir.timing?.repeat?.frequency)).toEqual([2, 2, 2]);
    expect(cadence.items.slice(1).every(item =>
      item.meta.canonical.clauses[0].evidence.some(evidence =>
        evidence.rule === 'hpsg.cx.coordination.leading-shared-adjuncts'
      )
    )).toBe(true);

    const duration = parseSig(
      'for 3 days instill 1 drop in left eye and 2 drops in right eye'
    );
    expect(duration.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.value))
      .toEqual([3, 3]);

    const prn = parseSig(
      'as needed for eye irritation instill 1 drop in left eye and 2 drops in right eye'
    );
    expect(prn.items.map(item => item.fhir.asNeeded)).toEqual([true, true]);
    expect(prn.items.map(item => item.fhir.asNeededFor?.[0]?.text))
      .toEqual(['eye irritation', 'eye irritation']);
  });

  it('uses the public planner path when a local left bound inherits right cadence', () => {
    const duration = parseSig(
      'instill 1 drop in left eye for 3 days and 2 drops in right eye twice daily'
    );
    expect(duration.items[0].meta.canonical.clauses[0].schedule).toMatchObject({
      duration: 3, durationUnit: 'd', frequency: 2, period: 1, periodUnit: 'd'
    });
    expect(duration.items[0].fhir.timing?.repeat).toMatchObject({
      frequency: 2,
      boundsDuration: { value: 3, code: 'd' }
    });
    expect(duration.items[1].meta.canonical.clauses[0].schedule?.duration).toBeUndefined();

    const start = parseSig(
      'instill 1 drop in left eye starting 2026-11-01 and 2 drops in right eye twice daily',
      { datePolicy: { referenceDate: '2026-10-22' } }
    );
    expect(start.items[0].meta.canonical.clauses[0].schedule).toMatchObject({
      boundsStart: '2026-11-01', frequency: 2, period: 1, periodUnit: 'd'
    });
    expect(start.items[0].fhir.timing?.repeat?.boundsPeriod?.start).toBe('2026-11-01');

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

  it('keeps the supported local cadence when an additional cadence is unresolved', () => {
    const parsed = parseSig(
      'instill 1 drop in left eye and 2 drops in right eye twice daily q8h'
    );
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.site?.text)).toEqual(['left eye', 'right eye']);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value))
      .toEqual([1, 2]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.frequency))
      .toEqual([undefined, 2]);
    expect(parsed.items[1].meta.leftoverText).toContain('q8h');
    expect(parsed.items[1].warnings).toContainEqual(
      expect.stringContaining('unresolved-timing-conflict')
    );
    expect(parsed.items[0].meta.canonical.clauses[0].evidence.some(item =>
      item.rule === 'hpsg.cx.coordination.trailing-shared-cadence'
    )).toBe(false);
  });
});
