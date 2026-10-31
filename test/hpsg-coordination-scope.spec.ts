import { describe, expect, it } from 'vitest';
import {
  calculateTotalUnits, getDosageCondition, getDosageExcludedDates, getDosageExcludedWeekdays,
  lintSig, nextDueDoses, toDosageDetails, toFhirR5Dosages
} from '../src/index';
import { canonicalToFhir } from '../src/fhir';
import { shiftCanonicalSigClauses } from '../src/ir';
import { ParserState } from '../src/parser-state';
import { calendarExclusionLexicalRule, matchCalendarExclusion } from '../src/hpsg/rules/condition-rules';
import type { HpsgClauseContext } from '../src/hpsg/rule-context';
import {
  parseClauseSign,
  parseClauseState, tokenize
} from '../src/parser';
import { applyCoordinatedCadenceScopes } from '../src/regimen/coordination-scope';
import { createBoundaryPlan, takeBoundaryParsedState } from '../src/regimen/planner';
import type { BoundaryPlan } from '../src/hpsg/signature';
import { selectHpsgCoordinationScopeConstruction } from '../src/hpsg/constructions';
import type { CoordinationScopeFacts } from '../src/hpsg/signature';
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
      semanticLicense: 'dose-continuation',
      range: { start: 32, end: 35 }
    },
    adjacent: true,
    leftComplete: true,
    rightComplete: true,
    leftExplicitDose: true,
    rightExplicitDose: true,
    leftExplicitHead: true,
    leftHasMethod: true,
    leftAdministrationContext: true,
    rightExplicitHead: false,
    leftHasSite: true,
    rightHasSite: true,
    targetsDistinct: true,
    leftHasSchedule: false,
    rightHasSchedule: true,
    leftHasCadence: false,
    rightHasCadence: true,
    leftHasCourseDuration: false,
    rightHasCourseDuration: false,
    leftHasPrn: false,
    rightHasPrn: false,
    leftHasFrontedSchedule: false,
    leftHasFrontedPrn: false,
    rightHasTrailingSchedule: true,
    rightHasTrailingCourseDuration: false,
    rightHasTrailingPrn: false,
    rightHasTrailingSafetyGuard: false,
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
  it("rebases a method's independent source evidence along with the clause evidence", () => {
    const state = parseClauseState("Take 1 tablet BID");
    const method = state.primaryClause.method;
    expect(method?.text).toBeTruthy();
    method!.evidence = [{
      rule: "hpsg.lex.method", spans: [{ start: 0, end: 4, text: "Take" }]
    }];
    shiftCanonicalSigClauses([state.primaryClause], 31, new WeakSet<object>());
    expect(method!.evidence?.[0].spans[0]).toMatchObject({
      start: 31, end: 35, text: "Take"
    });
  });

  it("inherits coordinated sites without fabricating source spans in a later dosing segment", async () => {
    const source = "Apply 1 g to scalp and forehead BID, then 2 g BID";
    const groupText = "scalp and forehead";
    const donorStart = source.indexOf(groupText);
    for (const parsed of [parseSig(source), await parseSigAsync(source)]) {
      expect(parsed.items).toHaveLength(4);
      expect(parsed.items.map(item => item.fhir.site?.text))
        .toEqual(["scalp", "forehead", "scalp", "forehead"]);
      expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value))
        .toEqual([1, 1, 2, 2]);
      const donor = parsed.items[0].meta.canonical.clauses[0].administrationTargetGroup!;
      const carried = parsed.items[2].meta.canonical.clauses[0].administrationTargetGroup!;
      expect(donor.range).toEqual({ start: donorStart, end: donorStart + groupText.length });
      expect(donor.targets.map(target => source.slice(target.range!.start, target.range!.end)))
        .toEqual(["scalp", "forehead"]);
      expect(carried.sourceText).toBe(groupText);
      expect(carried.range).toBeUndefined();
      expect(carried.targets.map(target => target.range)).toEqual([undefined, undefined]);
      expect(carried.targets.every(target => target.evidence === undefined)).toBe(true);
      expect(carried.targets.map(target => target.coding?.code))
        .toEqual(donor.targets.map(target => target.coding?.code));
      expect(carried).not.toBe(donor);
      expect(carried.targets[0]).not.toBe(donor.targets[0]);
      expect(parsed.items[2].meta.canonical.clauses[0].rawText).toBe("2 g BID");
    }
  });

  it('builds typed administration-target atoms before canonical and FHIR projection', () => {
    const input = 'apply to scalp and forehead bid';
    const sign = parseClauseSign(input);
    expect(sign?.synsem.valence.site?.coordination).toMatchObject({
      coordination: 'conjunction',
      sourceText: 'scalp and forehead',
      range: { start: input.indexOf('scalp'), end: input.indexOf('forehead') + 8 },
      targets: [
        { text: 'scalp', coding: { code: '41695006' } },
        { text: 'forehead', coding: { code: '52795006' } }
      ]
    });

    const state = parseClauseState(input);
    expect(state.primaryClause.administrationTargetGroup).toMatchObject({
      coordination: 'conjunction',
      sourceText: 'scalp and forehead'
    });
    expect(state.primaryClause.leftovers).toEqual([]);

    const parsed = parseSig(input);
    expect(parsed.items.map(item => item.fhir.site?.text)).toEqual(['scalp', 'forehead']);
    expect(parsed.items.every(item =>
      item.meta.canonical.clauses[0].rawText === input &&
      item.meta.canonical.clauses[0].administrationTargetGroup?.targets.length === 2
    )).toBe(true);
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(lintSig(input).issues).toEqual([]);
  });

  it('owns repeated Thai bilateral target lists before timing-anchor coordination', async () => {
    const input =
      'หยอดตาขวาและตาซ้าย ครั้งละ 1 หยด เวลา 08:00 และ ' +
      'หยอดตาขวาและตาซ้าย ครั้งละ 1 หยด เวลา 20:00';
    const boundary = createBoundaryPlan(input);
    expect(boundary.claims.filter(claim => claim.kind === 'target-list')).toHaveLength(2);
    expect(boundary.segments).toHaveLength(2);
    expect(boundary.relations.map(relation => relation.kind)).toEqual(['coordination']);

    const check = (result: ReturnType<typeof parseSig>) => {
      expect(result.items).toHaveLength(2);
      expect(result.items.map(item => item.fhir.site?.text))
        .toEqual(['right eye', 'left eye']);
      expect(result.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value))
        .toEqual([1, 1]);
      expect(result.items.map(item => item.fhir.timing?.repeat?.timeOfDay))
        .toEqual([['08:00:00', '20:00:00'], ['08:00:00', '20:00:00']]);
      expect(result.meta.leftoverText).toBeUndefined();
    };
    check(parseSig(input, { locale: 'th' }));
    check(await parseSigAsync(input, { locale: 'th' }));
    expect(lintSig(input, { locale: 'th' }).issues).toEqual([]);
  });

  it.each([
    {
      left: 'moob',
      right: 'goob',
      leftText: 'Moob',
      rightText: 'Goob',
      leftCode: 'MOOB',
      rightCode: 'GOOB'
    },
    {
      left: 'upper moob',
      right: 'lower goob',
      leftText: 'Upper Moob',
      rightText: 'Lower Goob',
      leftCode: 'UPPER-MOOB',
      rightCode: 'LOWER-GOOB'
    }
  ])('owns repeated custom SITE-NP coordination at both clocks: $left and $right', async ({
    left, right, leftText, rightText, leftCode, rightCode
  }) => {
    const input =
      `apply to ${left} and ${right} 1 g at 08:00 and ` +
      `apply to ${left} and ${right} 1 g at 20:00`;
    const options = {
      siteCodeMap: {
        [left]: {
          text: leftText,
          coding: {
            system: 'http://example.org/custom-sites',
            code: leftCode,
            display: leftText
          }
        },
        [right]: {
          text: rightText,
          coding: {
            system: 'http://example.org/custom-sites',
            code: rightCode,
            display: rightText
          }
        }
      }
    };
    const groupText = `${left} and ${right}`;
    const firstStart = input.indexOf(groupText);
    const secondStart = input.lastIndexOf(groupText);
    const expectedRanges = [firstStart, secondStart].map(start => ({
      start,
      end: start + groupText.length
    }));

    for (const clock of ['08:00', '20:00']) {
      const clause = `apply to ${groupText} 1 g at ${clock}`;
      const sign = parseClauseSign(clause, options);
      expect(sign?.synsem.valence.site?.coordination).toMatchObject({
        coordination: 'conjunction',
        sourceText: groupText,
        range: {
          start: clause.indexOf(groupText),
          end: clause.indexOf(groupText) + groupText.length
        },
        targets: [
          { coding: { code: leftCode } },
          { coding: { code: rightCode } }
        ]
      });
    }

    const boundary = createBoundaryPlan(input, options);
    expect(boundary.claims.filter(claim => claim.kind === 'target-list')).toEqual(
      expectedRanges.map(range => expect.objectContaining({
        ...range,
        producer: 'site-coordination-phrase'
      }))
    );
    expect(boundary.segments.map(segment => segment.text)).toEqual([
      `apply to ${groupText} 1 g at 08:00`,
      `apply to ${groupText} 1 g at 20:00`
    ]);
    expect(boundary.relations).toContainEqual(expect.objectContaining({
      kind: 'coordination',
      connectorKind: 'conjunction'
    }));
    expect(boundary.metrics.clauseProbes).toBe(2);
    expect(boundary.metrics.siteCoordinationProbes).toBe(2);
    expect(boundary.metrics.probeCacheHits).toBeGreaterThanOrEqual(2);
    for (const segment of boundary.segments) {
      expect(takeBoundaryParsedState(
        boundary, segment.start, segment.end, segment.text
      )?.primaryClause.administrationTargetGroup).toMatchObject({
        coordination: 'conjunction',
        sourceText: groupText
      });
    }

    const sync = parseSig(input, options);
    const asyncParsed = await parseSigAsync(input, options);
    const linted = lintSig(input, options);
    for (const items of [
      sync.items,
      asyncParsed.items,
      linted.items.map(entry => entry.result)
    ]) {
      expect(items).toHaveLength(2);
      expect(items.map(item => item.fhir.site?.coding?.[0]?.code))
        .toEqual([leftCode, rightCode]);
      expect(items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity))
        .toMatchObject([{ value: 1, unit: 'g' }, { value: 1, unit: 'g' }]);
      expect(items.map(item => item.fhir.timing?.repeat?.timeOfDay))
        .toEqual([
          ['08:00:00', '20:00:00'],
          ['08:00:00', '20:00:00']
        ]);
      expect(items.every(item =>
        item.meta.canonical.clauses[0].rawText === input &&
        item.meta.canonical.clauses[0].administrationTargetGroup?.sourceText === groupText
      )).toBe(true);
    }
    expect(sync.meta.leftoverText).toBeUndefined();
    expect(asyncParsed.meta.leftoverText).toBeUndefined();
    expect(linted.issues).toEqual([]);
  });

  it.each([
    'take 1 tab PO BID and drink water',
    'take 1 tab PO BID, drink water'
  ])('does not activate site coordination analysis for a non-site seam: %s', input => {
    for (const options of [undefined, {
      siteCodeMap: {
        'upper moob': { text: 'Upper Moob' }
      }
    }]) {
      const boundary = createBoundaryPlan(input, options);
      expect(boundary.claims.filter(claim => claim.kind === 'target-list')).toEqual([]);
      expect(boundary.metrics.siteCoordinationProbes).toBe(0);
    }
  });

  it('does not swallow a second explicit eye dose into a site-only conjunction', () => {
    const text = 'instill 1 drop OD and 2 drops OS BID';
    const boundary = createBoundaryPlan(text);
    expect(boundary.claims.filter(claim => claim.kind === 'target-list')).toHaveLength(0);
    const parsed = parseSig(text);
    expect(parsed.items.map(item => item.fhir.site?.text))
      .toEqual(['right eye', 'left eye']);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value))
      .toEqual([1, 2]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.frequency))
      .toEqual([2, 2]);
  });

  it('keeps disjunctive sites typed without inventing simultaneous administrations', () => {
    const input = 'apply to scalp or forehead bid';
    const sign = parseClauseSign(input);
    expect(sign?.synsem.valence.site?.coordination?.coordination).toBe('disjunction');
    expect(sign?.synsem.valence.site?.coordination?.targets.map(target => target.text))
      .toEqual(['scalp', 'forehead']);

    const parsed = parseSig(input);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].fhir.site?.text).toBe('scalp or forehead');
    expect(parsed.items[0].meta.canonical.clauses[0].administrationTargetGroup)
      .toMatchObject({ coordination: 'disjunction', sourceText: 'scalp or forehead' });
  });

  it('resolves OD plus OS as targets while retaining OU as one bilateral atom', () => {
    const coordinated = parseSig('instill 1 drop OD and OS QID');
    expect(coordinated.items.map(item => item.fhir.site?.text))
      .toEqual(['right eye', 'left eye']);
    expect(coordinated.items.map(item => item.meta.canonical.clauses[0].dose))
      .toEqual([{ value: 1, unit: 'drop' }, { value: 1, unit: 'drop' }]);
    expect(coordinated.items.map(item => item.meta.canonical.clauses[0].site?.text))
      .toEqual(['right eye', 'left eye']);
    expect(coordinated.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity))
      .toMatchObject([{ value: 1, unit: 'drop' }, { value: 1, unit: 'drop' }]);
    expect(coordinated.items.map(item => item.fhir.timing?.repeat?.frequency))
      .toEqual([4, 4]);
    expect(coordinated.meta.leftoverText).toBeUndefined();

    const bilateralSign = parseClauseSign('instill 1 drop OU QID');
    expect(bilateralSign?.synsem.valence.site?.coordination).toBeUndefined();
    expect(bilateralSign?.synsem.valence.site).toMatchObject({
      text: 'both eyes',
      administrationTargetCount: 2,
      coding: { code: '40638003' }
    });
    const bilateral = parseSig('instill 1 drop OU QID');
    expect(bilateral.items).toHaveLength(1);
    expect(bilateral.meta.normalized.site?.administrationTargetCount).toBe(2);
  });

  it('coordinates Thai site atoms and shares the adjacent cadence', () => {
    const input = 'หยอด 1 หยด ตาขวา และ ตาซ้าย วันละ 4 ครั้ง';
    const sign = parseClauseSign(input, { locale: 'th' });
    expect(sign?.synsem.valence.site?.coordination).toMatchObject({
      coordination: 'conjunction',
      sourceText: 'ตาขวา และ ตาซ้าย'
    });
    const parsed = parseSig(input, { locale: 'th' });
    expect(parsed.items.map(item => item.fhir.site?.text)).toEqual(['right eye', 'left eye']);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.frequency)).toEqual([4, 4]);
    expect(parsed.meta.leftoverText).toBeUndefined();
  });

  it('keeps target and clock coordination as separate typed constructions', () => {
    const input = 'apply to scalp and forehead at 08:00 and 20:00';
    const parsed = parseSig(input);
    expect(parsed.items.map(item => item.fhir.site?.text)).toEqual(['scalp', 'forehead']);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.timeOfDay))
      .toEqual([['08:00:00', '20:00:00'], ['08:00:00', '20:00:00']]);
    expect(parsed.meta.leftoverText).toBeUndefined();
  });

  it('retains named bilateral anatomy as one pre-coordinated target', () => {
    const parsed = parseSig('apply 1 g to left and right eyebrows bid');
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].fhir.site?.text).toBe('both eyebrows');
    expect(parsed.meta.normalized.site?.administrationTargetCount).toBe(2);
    expect(parsed.items[0].meta.canonical.clauses[0].administrationTargetGroup)
      .toBeUndefined();
  });

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
    expect(selectHpsgCoordinationScopeConstruction(scopeFacts({ leftHasCadence: true })))
      .toMatchObject({
        semantic: {
          construction: {
            id: 'hpsg.cx.coordination.dosed-head-ellipsis',
            operation: 'inherit-administration-head'
          }
        }
      });
    expect(selectHpsgCoordinationScopeConstruction(scopeFacts({ rightComplete: false }))).toBeUndefined();
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

  it("keeps the administration head on the left when the right daughter supplies a shared course", () => {
    const headed = selectHpsgCoordinationScopeConstruction(scopeFacts({
      leftHasSchedule: true,
      leftHasCadence: true,
      rightHasCourseDuration: true,
      rightHasTrailingCourseDuration: true
    }));
    expect(headed?.semantic.construction.operation)
      .toBe("inherit-administration-head-and-share-trailing-course-duration");
    expect(headed?.construction.headSide).toBe("left");

    const event = selectHpsgCoordinationScopeConstruction(scopeFacts({
      relation: {
        ...scopeFacts().relation, semanticLicense: "event-timing-ellipsis",
        rule: "regimen.event-timing-ellipsis"
      },
      leftHasSchedule: true,
      leftHasCadence: true,
      rightExplicitDose: false,
      rightHasCourseDuration: true,
      rightHasTrailingCourseDuration: true
    }));
    expect(event?.semantic.construction.operation)
      .toBe("inherit-event-timing-and-share-trailing-course-duration");
    expect(event?.construction.headSide).toBe("left");
  });

  it('licenses shared course scope only from a terminal typed course daughter', () => {
    const shared = selectHpsgCoordinationScopeConstruction(scopeFacts({
      leftHasSchedule: true,
      leftHasCadence: true,
      rightHasCourseDuration: true,
      rightHasTrailingCourseDuration: true
    }));
    expect(shared?.semantic.construction).toMatchObject({
      id: 'hpsg.cx.coordination.dosed-head-ellipsis-with-trailing-course-duration',
      operation: 'inherit-administration-head-and-share-trailing-course-duration'
    });

    const localLeftCourse = selectHpsgCoordinationScopeConstruction(scopeFacts({
      leftHasSchedule: true,
      leftHasCadence: true,
      leftHasCourseDuration: true,
      rightHasCourseDuration: true,
      rightHasTrailingCourseDuration: true
    }));
    expect(localLeftCourse?.semantic.construction.operation)
      .toBe('inherit-administration-head');

    const independent = selectHpsgCoordinationScopeConstruction(scopeFacts({
      relation: { ...scopeFacts().relation, kind: 'independent' },
      leftHasSchedule: true,
      leftHasCadence: true,
      rightHasCourseDuration: true,
      rightHasTrailingCourseDuration: true
    }));
    expect(independent).toBeUndefined();
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
      [2, 2], 'exclusion', undefined, undefined],
    ['instill 1 drop in left eye and 2 drops in right eye and 1 drop in both eyes twice daily only if BP > 160',
      [2, 2, 2], 'condition', 'gt', 160],
    ['instill 1 drop in left eye and 2 drops in right eye and 1 drop in both eyes twice daily except Sunday',
      [2, 2, 2], 'exclusion', undefined, undefined]
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
      if (guardKind === 'condition') {
        const guardedItems = input.includes('unless')
          ? [result.items.at(-1)!]
          : result.items;
        for (const item of guardedItems) {
          const condition = getDosageCondition(item.fhir);
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
          expect(item.fhir.asNeeded).toBeUndefined();
          expect(item.fhir.text).toMatch(/(?:only if|unless) BP/u);
        }
        if (input.includes('unless')) {
          expect(getDosageCondition(result.items[0].fhir)).toBeUndefined();
        }
      } else {
        for (const item of result.items) {
          expect(getDosageExcludedWeekdays(item.fhir)).toEqual(['sun']);
          expect(item.fhir.timing?.repeat?.dayOfWeek)
            .toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
        }
      }
      expect(result.items.every(item => item.warnings.length === 0)).toBe(true);
    }
    expect(linted.issues).toEqual([]);
  });

  it("types shared guards and exclusions before projecting FHIR", () => {
    for (const [input, kind] of [
      ["instill 1 drop in left eye and 2 drops in right eye twice daily only if BP > 160", "condition"],
      ["instill 1 drop in left eye and 2 drops in right eye twice daily except Sunday", "weekday"],
      ["instill 1 drop in left eye and 2 drops in right eye twice daily except 2026-11-01", "date"]
    ] as const) {
      const parsed = parseSig(input);
      expect(parsed.items).toHaveLength(2);
      const [left, right] = parsed.items;
      const leftClause = left.meta.canonical.clauses[0];
      const rightClause = right.meta.canonical.clauses[0];
      const inherited = leftClause.clinicalAdjuncts;
      const local = rightClause.clinicalAdjuncts;
      expect(inherited?.localRanges).toBeUndefined();
      expect(local?.localRanges?.length).toBeGreaterThan(0);
      expect(inherited?.evidence?.some(e =>
        e.rule.startsWith("hpsg.cx.coordination."))).toBe(true);
      if (kind === "condition") {
        expect(inherited?.condition).toEqual(local?.condition);
        expect(getDosageCondition(left.fhir)).toEqual(inherited?.condition);
        expect(getDosageCondition(right.fhir)).toEqual(local?.condition);
      } else if (kind === "weekday") {
        expect(inherited?.excludedWeekdays).toEqual(["sun"]);
        expect(getDosageExcludedWeekdays(left.fhir)).toEqual(
          inherited?.excludedWeekdays
        );
        expect(leftClause.schedule?.dayOfWeek).toEqual(
          rightClause.schedule?.dayOfWeek
        );
      } else {
        expect(inherited?.excludedDates).toEqual(["2026-11-01"]);
        expect(getDosageExcludedDates(left.fhir)).toEqual(
          inherited?.excludedDates
        );
      }
    }
  });

  it("shares a trailing explicit-date exclusion across coordinated doses", async () => {
    const input =
      "instill 1 drop in left eye and 2 drops in right eye twice daily except 2026-11-01";
    const sync = parseSig(input);
    const asyncParsed = await parseSigAsync(input);
    for (const result of [sync, asyncParsed]) {
      expect(result.items.map(item => item.fhir.site?.text))
        .toEqual(["left eye", "right eye"]);
      expect(result.items.map(item => item.fhir.timing?.repeat?.frequency))
        .toEqual([2, 2]);
      for (const item of result.items) {
        expect(getDosageExcludedDates(item.fhir)).toEqual(["2026-11-01"]);
        expect(item.fhir.timing?.event).toBeUndefined();
        expect(item.fhir.text).toContain("except 2026-11-01");
      }
      expect(result.items.every(item => item.warnings.length === 0)).toBe(true);
    }
    expect(lintSig(input).issues).toEqual([]);
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
        semanticLicense: 'dose-continuation',
        range: { start: leftText.length + 1, end: rightStart - 1 }
      }]
    } as BoundaryPlan;
    const applied = applyCoordinatedCadenceScopes([
      { state: left, start: 0, end: leftText.length },
      { state: right, start: rightStart, end: source.length }
    ], plan, source);
    expect(applied.map(item => item.rule)).toEqual([
      'hpsg.cx.coordination.trailing-shared-cadence',
      'hpsg.cx.coordination.dosed-head-ellipsis'
    ]);

    const scoped = left.primaryClause.schedule!;
    expect(scoped).toMatchObject({ timingCode: 'BID', frequency: 2, period: 1, periodUnit: 'd' });
    expect(scoped.evidence).toContainEqual(localEvidence);
    expect(scoped.evidence!.some(item =>
      item.rule === 'hpsg.cx.coordination.trailing-shared-cadence'
    )).toBe(true);
    expect(right.primaryClause.schedule).toMatchObject({ frequency: 2, periodUnit: 'd' });
    expect(right.primaryClause.method?.text).toBe('Instill');
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
    {
      input: 'หยอดตาขวา 1 หยดวันละ 4 ครั้ง 7 วัน ตาซ้าย 1 หยดวันละ 2 ครั้ง',
      rule: 'regimen.adjacent-independent-administrations',
      segments: [
        'หยอดตาขวา 1 หยดวันละ 4 ครั้ง 7 วัน',
        'ตาซ้าย 1 หยดวันละ 2 ครั้ง'
      ]
    },
    {
      input: 'OD 1 drop QID x7d OS 1 drop BID',
      rule: 'regimen.adjacent-independent-administrations',
      segments: ['OD 1 drop QID x7d', 'OS 1 drop BID']
    },
    {
      input: 'OD one drop QID x7d OS one drop BID',
      rule: 'regimen.adjacent-independent-administrations',
      segments: ['OD one drop QID x7d', 'OS one drop BID']
    },
    {
      input: 'หยอดตาขวา 1 หยดวันละ 4 ครั้ง 7 วัน. ตาซ้าย 1 หยดวันละ 2 ครั้ง',
      rule: 'regimen.separate-administration',
      segments: [
        'หยอดตาขวา 1 หยดวันละ 4 ครั้ง 7 วัน',
        'ตาซ้าย 1 หยดวันละ 2 ครั้ง'
      ]
    }
  ])('licenses an independent boundary between complete dosage heads: $input', ({ input, rule, segments }) => {
    const plan = createBoundaryPlan(input);
    expect(plan.segments.map(segment => segment.text)).toEqual(segments);
    expect(plan.relations).toEqual([
      expect.objectContaining({
        kind: 'independent',
        rule
      })
    ]);
  });

  it('does not treat a coordinated SITE-NP followed by one dose as two dosage heads', () => {
    const input = 'OD and OS 1 drop BID';
    const plan = createBoundaryPlan(input);
    expect(plan.segments.map(segment => segment.text)).toEqual([input]);
    expect(plan.relations).toEqual([]);
    expect(plan.claims).toContainEqual(expect.objectContaining({ kind: 'target-list' }));
  });

  it('receives a compact sentence period without splitting the decimal dose', () => {
    const input = 'OD 0.5 drop BID.OS 1 drop QID';
    const plan = createBoundaryPlan(input);
    expect(plan.segments.map(segment => segment.text)).toEqual([
      'OD 0.5 drop BID',
      'OS 1 drop QID'
    ]);
    expect(plan.relations).toEqual([
      expect.objectContaining({ kind: 'independent', rule: 'regimen.separate-administration' })
    ]);
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

  it('shares cadence and duration with an implicit typed eye-dose administration', () => {
    const input = '1 drop in left eye and 2 drops in right eye twice daily x7d';
    const parsed = parseSig(input);
    expectBid(parsed.items);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.value))
      .toEqual([7, 7]);
    expect(parsed.items.map(item => item.meta.canonical.clauses[0].schedule?.duration))
      .toEqual([7, 7]);
    expect(parsed.meta.leftoverText).toBeUndefined();
  });

  it.each([
    '1 drop OD BID and 2 drops OS QID, continue for 14 days',
    'Instill 1 drop right eye BID and 2 drops left eye QID; continue for14days',
    '1 drop OD BID and 2 drops OS QID for14days'
  ])('scopes the typed terminal course over both coordinated eye doses: %s', input => {
    const parsed = parseSig(input);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.site?.text))
      .toEqual(['right eye', 'left eye']);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value))
      .toEqual([1, 2]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.frequency))
      .toEqual([2, 4]);
    expect(parsed.items.map(item => item.meta.canonical.clauses[0].schedule?.duration))
      .toEqual([14, 14]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration))
      .toEqual([
        expect.objectContaining({ value: 14, code: 'd' }),
        expect.objectContaining({ value: 14, code: 'd' })
      ]);

    const strictR5 = toFhirR5Dosages(parsed.fhirNext);
    expect(strictR5.map(item => item.timing?.repeat?.boundsDuration))
      .toEqual([
        expect.objectContaining({ value: 14, code: 'd' }),
        expect.objectContaining({ value: 14, code: 'd' })
      ]);
    const restoredR6 = toDosageDetails(strictR5);
    expect(restoredR6.step).toHaveLength(1);
    expect(restoredR6.step[0].component).toHaveLength(2);
    expect(restoredR6.step[0].end?.offsetDuration)
      .toMatchObject({ value: 14, code: 'd' });
    expect(parsed.input).toBe(input);
  });

  it('consumes typed continue-treatment duration valence without depending on its surface verb', () => {
    const input = '1 drop OD BID and 2 drops OS QID, persist for 14 days';
    const parsed = parseSig(input, {
      instructionActionMap: {
        persist: {
          code: 'continue-treatment',
          semanticClass: 'course',
          display: 'Continue treatment',
          procedural: true,
          argumentParser: 'duration',
          realizer: 'duration'
        }
      }
    });
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.value))
      .toEqual([14, 14]);
    expect(parsed.items.map(item => item.meta.canonical.clauses[0].schedule?.duration))
      .toEqual([14, 14]);
    expect(parsed.items[1].meta.canonical.clauses[0].instructionGraph?.actions[0])
      .toMatchObject({
        predicate: { lemma: 'continue-treatment', semanticClass: 'course' },
        args: [{ role: 'duration', quantity: { value: 14, unit: 'd' } }]
      });
    expect(parsed.items[0].meta.canonical.clauses[0].evidence.some(item =>
      item.rule === 'hpsg.cx.coordination.trailing-shared-course-duration'
    )).toBe(true);
  });

  it('keeps explicit eye-specific courses local instead of spreading the terminal course', () => {
    const parsed = parseSig(
      '1 drop OD BID for 7 days and 2 drops OS QID for 14 days'
    );
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.site?.text))
      .toEqual(['right eye', 'left eye']);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.value))
      .toEqual([7, 14]);
    expect(parsed.fhirNext.step[0].end).toBeUndefined();
  });

  it.each([
    '1 drop OD BID; 2 drops OS QID for 14 days',
    '1 drop OD BID; 2 drops OS QID, continue for 14 days'
  ])('keeps a terminal eye course on its semicolon-independent regimen: %s', input => {
    const parsed = parseSig(input);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.site?.text))
      .toEqual(['right eye', 'left eye']);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.value))
      .toEqual([undefined, 14]);
    expect(parsed.fhirNext.step[0].end).toBeUndefined();
    expect(parsed.items[0].meta.canonical.clauses[0].evidence.some(item =>
      item.rule.includes('shared-course-duration')
    )).toBe(false);
  });

  it.each([
    {
      input: 'Take 1 tab qAM and 2 tabs qPM for 7 days',
      doses: [1, 2],
      whens: ['MORN', 'EVE'],
      duration: 7,
      unit: 'd'
    },
    {
      input: 'Take 0.5 tablet each morning and 1.5 tablets each evening for 14 days',
      doses: [0.5, 1.5],
      whens: ['MORN', 'EVE'],
      duration: 14,
      unit: 'd'
    },
    {
      input: 'รับประทาน ครึ่งเม็ดเช้า และ 1 เม็ดเย็น 2 สัปดาห์',
      doses: [0.5, 1],
      whens: ['MORN', 'EVE'],
      duration: 2,
      unit: 'wk'
    }
  ])('scopes one terminal course over distinct coordinated daily doses: $input', ({
    input, doses, whens, duration, unit
  }) => {
    const parsed = parseSig(input);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value))
      .toEqual(doses);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.when?.[0]))
      .toEqual(whens);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration))
      .toEqual([
        expect.objectContaining({ value: duration, code: unit }),
        expect.objectContaining({ value: duration, code: unit })
      ]);
    expect(parsed.items.map(item => item.meta.canonical.clauses[0].schedule?.duration))
      .toEqual([duration, duration]);
    expect(parsed.items[0].meta.canonical.clauses[0].evidence.some(item =>
      item.rule === 'hpsg.cx.coordination.dosed-head-ellipsis-with-trailing-course-duration'
    )).toBe(true);
    expect(parsed.fhirNext.step).toHaveLength(1);
    expect(parsed.fhirNext.step[0].component).toHaveLength(2);
    expect(parsed.fhirNext.step[0].end?.offsetDuration).toMatchObject({
      value: duration,
      code: unit
    });
    expect(parsed.input).toBe(input);
  });

  it('keeps explicitly distinct coordinated course durations local to each slot', () => {
    const parsed = parseSig(
      'Take 1 tab qAM for 3 days and 2 tabs qPM for 7 days'
    );
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.value))
      .toEqual([3, 7]);
    expect(parsed.items.map(item => item.meta.canonical.clauses[0].schedule?.duration))
      .toEqual([3, 7]);
    expect(parsed.items[0].meta.canonical.clauses[0].evidence.some(item =>
      item.rule.includes('shared-course-duration')
    )).toBe(false);
  });

  it('does not spread a terminal duration across an independent regimen boundary', () => {
    const parsed = parseSig('Take 1 tab qAM; Take 2 tabs qPM for 7 days');
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration?.value))
      .toEqual([undefined, 7]);
    expect(parsed.items[0].meta.canonical.clauses[0].evidence.some(item =>
      item.rule.includes('shared-course-duration')
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
    expect(parsed.items[0].meta.canonical.clauses[0].evidence.some(item =>
      item.rule === 'hpsg.cx.coordination.trailing-shared-cadence'
    )).toBe(false);
  });
});

describe("Thai QOD cadence and excluded-day lexical separation", () => {
  it("matches each genuine exclusion relative to its own HPSG source lead", () => {
    const input = "Take 1 tablet daily except Sunday; Take 1 tablet BID except Wednesday";
    const first = input.indexOf("except");
    const second = input.lastIndexOf("except");
    expect(matchCalendarExclusion(input, undefined, undefined, undefined, first))
      .toMatchObject({ start: first, excluded: ["sun"] });
    expect(matchCalendarExclusion(input, undefined, undefined, undefined, second))
      .toMatchObject({ start: second, excluded: ["wed"] });
  });

  it.each([
    ["Take 1 tablet except Sunday BID", ["sun"], "BID", "except Sunday"],
    ["Take 1 tablet except public holidays twice daily", undefined, "BID", "except public holidays"]
  ] as const)("preserves a following timing phrase separately from the exclusion: %s", (
    input, excluded, timing, source
  ) => {
    const parsed = parseSig(input);
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.schedule).toMatchObject({ timingCode: timing, frequency: 2, period: 1, periodUnit: "d" });
    if (excluded) expect(getDosageExcludedWeekdays(parsed.fhir)).toEqual([...excluded]);
    else expect(clause.clinicalAdjuncts?.evidence?.some(entry =>
      entry.rule === "hpsg.lex.clinical.calendar-exclusion.unresolved"
    )).toBe(true);
    const ranges = clause.clinicalAdjuncts?.localRanges ?? [];
    expect(ranges.map(range => input.slice(range.start, range.end))).toContain(source);
    expect(parsed.meta.canonical.clauses[0]?.dose).toMatchObject({ value: 1, unit: "tab" });
  });

  it("retains an exact date exclusion with a standalone M/W/F weekday cadence", () => {
    const input = "Take 1 tablet M/W/F except 2026-11-04";
    const parsed = parseSig(input);
    expect(parsed.items).toHaveLength(1);
    const dosage = parsed.fhir;
    expect(parsed.meta.canonical.clauses[0].dose).toMatchObject({ value: 1, unit: "tab" });
    expect(parsed.meta.canonical.clauses[0].schedule?.dayOfWeek).toEqual(["mon", "wed", "fri"]);
    expect(getDosageExcludedDates(dosage)).toEqual(["2026-11-04"]);
    expect(getDosageExcludedDates(toFhirR5Dosages(parsed.fhirNext)[0]))
      .toEqual(["2026-11-04"]);
    const opts = {
      from: "2026-11-01T00:00:00+07:00",
      orderedAt: "2026-11-01T00:00:00+07:00",
      timeZone: "Asia/Bangkok", limit: 5
    };
    const due = nextDueDoses(dosage, opts);
    expect(due.map(time => time.slice(0, 10))).toEqual([
      "2026-11-02", "2026-11-06", "2026-11-09", "2026-11-11", "2026-11-13"
    ]);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });

  it("does not consume an after-exclusion BID cadence as unresolved holiday text", () => {
    const input = "Take 1 tablet except holidays BID";
    const parsed = parseSig(input);
    const schedule = parsed.meta.canonical.clauses[0].schedule;
    expect(schedule).toMatchObject({ timingCode: "BID", frequency: 2, period: 1, periodUnit: "d" });
    const unresolved = parsed.meta.canonical.clauses[0].clinicalAdjuncts;
    expect(unresolved?.evidence?.some(entry =>
      entry.rule === "hpsg.lex.clinical.calendar-exclusion.unresolved"
    )).toBe(true);
    expect(unresolved?.localRanges).toContainEqual({
      start: input.indexOf("except"), end: input.indexOf("BID") - 1
    });
    expect(parsed.meta.leftoverText).toContain("holidays");
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
    expect(parsed.fhir.timing?.repeat?.frequency).toBe(2);
  });

  it("does not offer an unresolved calendar exclusion for bare วันเว้นวัน", () => {
    const source = "รับประทาน 1 เม็ด วันเว้นวัน";
    const tokens = tokenize(source);
    const qodIndex = tokens.findIndex(token =>
      token.original.includes("วันเว้นวัน"));
    expect(qodIndex).toBeGreaterThanOrEqual(0);
    const context: HpsgClauseContext = {
      state: new ParserState(source, tokens), tokens, limit: tokens.length,
      dateSpans: [], clinicalCache: {}, deps: {} as HpsgClauseContext["deps"]
    };
    expect(calendarExclusionLexicalRule().match(context, qodIndex)).toEqual([]);
    const parsed = parseSig(source);
    expect(parsed.meta.canonical.clauses[0].schedule).toMatchObject({
      period: 2, periodUnit: "d", timingCode: "QOD"
    });
    expect(parsed.meta.canonical.clauses[0].clinicalAdjuncts).toBeUndefined();
  });

  it.each([
    ["รับประทาน 1 เม็ด วันเว้นวัน ยกเว้นวันหยุด", undefined, true],
    ["รับประทาน 1 เม็ด วันเว้นวัน ยกเว้นวันอาทิตย์", ["sun"], false],
    ["Take 1 tablet every other day except Sundays", ["sun"], false]
  ] as const)("preserves QOD while independently recognizing a real exclusion: %s", (
    source, excluded, unresolved
  ) => {
    const parsed = parseSig(source);
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.dose).toMatchObject({ value: 1, unit: "tab" });
    expect(clause.schedule).toMatchObject({ period: 2, periodUnit: "d" });
    expect(parsed.fhir.timing?.repeat).toMatchObject({ period: 2, periodUnit: "d" });
    expect(toFhirR5Dosages(parsed.fhirNext)[0].timing?.repeat)
      .toMatchObject({ period: 2, periodUnit: "d" });
    if (excluded) {
      expect(getDosageExcludedWeekdays(parsed.fhir)).toEqual([...excluded]);
      expect(clause.clinicalAdjuncts?.excludedWeekdays).toEqual([...excluded]);
    }
    if (unresolved) {
      expect(clause.clinicalAdjuncts?.evidence?.some(evidence =>
        evidence.rule === "hpsg.lex.clinical.calendar-exclusion.unresolved"
      )).toBe(true);
      expect(clause.clinicalAdjuncts?.localRanges).toContainEqual(
        expect.objectContaining({ start: source.indexOf("ยกเว้น") })
      );
    }
    expect(parsed.fhir.text).toContain(source.slice(-10).trim());
  });
});
