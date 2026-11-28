import { parseAdditionalInstructions } from "../src/advice";
import { CALENDAR_WEEKDAY_LEXEMES } from "../src/hpsg/lexical-classes";
import { siteLexicalRule } from "../src/hpsg/rules/site-rules";
import { AdviceArgumentRole, AdviceForce, AdviceModality, AdvicePolarity, AdviceRelation, AdviceFrame, EventTiming, FhirDayOfWeek, RouteCode } from "../src/types";
import { parseSigSegments as parseHpsgSegments } from "../src/hpsg/segmenter";
import { describe, expect, it } from 'vitest';
import {
  calculateTotalUnits, evaluateMedicationCondition, getDosageCondition, getDosageExcludedDates, getDosageExcludedWeekdays,
  formatSig, importCanonicalCourse, projectCanonicalCourse, lintSig, nextDueDoses, toDosageDetails, toFhirR5Dosages, getMedicationInstructionAction, parseSig as parsePublicSig
} from '../src/index';
import { canonicalToFhir } from '../src/fhir';
import { parseInstructionGraphExtension } from "../src/instruction-graph-fhir";
import { courseToR5 } from '../src/adapters/canonical-course';
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
import { unifySynsem } from "../src/hpsg/unification";
import type { BoundaryPlan, HpsgClinicalAdjunctFeature, HpsgInstructionFeature } from '../src/hpsg/signature';
import { parseMedicationGuard, selectHpsgCoordinationScopeConstruction } from '../src/hpsg/constructions';
import type { CoordinationScopeFacts } from '../src/hpsg/signature';
import { parseSig, parseSigAsync } from './helpers/r5-parser';
import { getMedicationLexerLocalePack, registerMedicationLexerLocalePack } from "../src/lexer/locale";

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

  it.each([
    ["Take 1 tablet if SBP > 160", "738990001"],
    ["Swallow 1 tablet if SBP > 160", "738995006"],
    ["Chew 1 tablet if SBP > 160", "738992009"],
    ["If SBP > 160, swallow 1 tablet", "738995006"],
    ["If SBP > 160, chew 1 tablet", "738992009"],
    ["If SBP > 160 swallow 1 tablet", "738995006"],
    ["If SBP > 160 chew 1 tablet", "738992009"],
    ["If SBP > 160, swallow 1 tablet then call clinic", "738995006"],
    ["กลืน 1 เม็ด ถ้า SBP > 160", "738995006"],
    ["เคี้ยว 1 เม็ด ถ้า SBP > 160", "738992009"],
    ["ถ้า SBP > 160, กลืน 1 เม็ด", "738995006"],
    ["ถ้า SBP > 160, เคี้ยว 1 เม็ด", "738992009"],
    ["ถ้า SBP > 160 ให้กลืน 1 เม็ด", "738995006"],
    ["ถ้า SBP > 160 ให้เคี้ยว 1 เม็ด", "738992009"]
  ] as const)("keeps an admitted guard on its registered administration: %s", (input, methodCode) => {
    const condition = { kind: "measurement", name: "sbp", operation: "gt", value: 160 };
    expect(parseMedicationGuard(input)?.condition).toMatchObject(condition);
    const sign = parseClauseSign(input);
    expect(sign?.synsem.head.dose).toMatchObject({ value: 1, unit: "tab" });
    expect(sign?.synsem.cont.clinicalAdjunct?.condition).toMatchObject(condition);
    const parsed = parsePublicSig(input);
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    expect(parsed.meta.canonical.clauses[0].dose).toEqual({ value: 1, unit: "tab" });
    expect(parsed.meta.canonical.clauses[0].clinicalAdjuncts?.condition).toMatchObject(condition);
    expect(parsed.meta.canonical.clauses[0].method?.coding).toMatchObject({
      system: "http://snomed.info/sct", code: methodCode
    });
    expect(parsed.fhir).toHaveLength(1);
    const converted = toFhirR5Dosages(parsed.fhirNext);
    expect(converted).toHaveLength(1);
    for (const row of [parsed.fhir[0], converted[0]]) {
      expect(row.doseAndRate?.[0].doseQuantity).toMatchObject({ value: 1, unit: "tab" });
      expect(getDosageCondition(row)).toMatchObject(condition);
      expect(row.method?.coding).toContainEqual(expect.objectContaining({
        system: "http://snomed.info/sct", code: methodCode
      }));
      expect(row.asNeeded).not.toBe(true);
    }
    expect(parsed.fhirNext.step[0].component[0].condition?.[0]).toMatchObject({
      operation: "gt", valueQuantity: { value: 160 }
    });
    expect(parsed.fhirNext.step[0].component[0].method?.coding).toContainEqual(expect.objectContaining({
      system: "http://snomed.info/sct", code: methodCode
    }));
    expect(parsed.input).toBe(input);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });

  it.each(["swallow", "chew"])("keeps a fronted guard and no-dose alternative with %s", method => {
    const input = `Only if SBP > 160, ${method} 1 tab BID, otherwise hold then call clinic`;
    const parsed = parsePublicSig(input);
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    expect(parsed.meta.canonical.clauses[0].clinicalAdjuncts?.condition).toMatchObject({
      kind: "measurement", name: "sbp", operation: "gt", value: 160
    });
    for (const row of [parsed.fhir[0], ...toFhirR5Dosages(parsed.fhirNext)]) {
      expect(row.doseAndRate?.[0].doseQuantity).toMatchObject({ value: 1, unit: "tab" });
      expect(row.timing?.repeat).toMatchObject({ frequency: 2, period: 1, periodUnit: "d" });
      expect(getDosageCondition(row)).toMatchObject({ kind: "measurement", name: "sbp", value: 160 });
      expect(row.asNeeded).not.toBe(true);
    }
    for (const view of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
      const normalized = formatSig(view, "long", { locale: "en", realizationMode: "normalized" });
      expect(normalized).toContain("Otherwise hold then call clinic.");
      expect(normalized.match(/call clinic/giu)).toHaveLength(1);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });

  it.each([
    "If SBP > 160 chew 1 tablet daily for 2 days",
    "If SBP > 160, chew 1 tablet daily for 2 days",
    "If SBP > 160 swallow 1 tablet daily for 2 days",
    "If SBP > 160, swallow 1 tablet daily for 2 days",
    "If SBP > 160 take 1 tablet daily for 2 days",
    "If SBP > 160, take 1 tablet daily for 2 days",
    "ถ้า SBP > 160 ให้เคี้ยว 1 เม็ด ทุกวัน เป็นเวลา 2 วัน",
    "ถ้า SBP > 160, ให้เคี้ยว 1 เม็ด ทุกวัน เป็นเวลา 2 วัน",
    "ถ้า SBP > 160 ให้กลืน 1 เม็ด ทุกวัน เป็นเวลา 2 วัน",
    "ถ้า SBP > 160, ให้กลืน 1 เม็ด ทุกวัน เป็นเวลา 2 วัน",
    "ถ้า SBP > 160 ให้รับประทาน 1 เม็ด ทุกวัน เป็นเวลา 2 วัน",
    "ถ้า SBP > 160, ให้รับประทาน 1 เม็ด ทุกวัน เป็นเวลา 2 วัน"
  ])("executes a fronted threshold only when its evaluator permits it: %s", input => {
    const condition = { kind: "measurement", name: "sbp", operation: "gt", value: 160 };
    expect(parseMedicationGuard(input)?.condition).toMatchObject(condition);
    const parsed = parsePublicSig(input);
    const options = { from: "2026-11-02T00:00:00+07:00", orderedAt: "2026-11-02T00:00:00+07:00",
      timeZone: "Asia/Bangkok", limit: 3 };
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
    for (const dosage of [parsed.meta.canonical.course!, parsed.fhirNext, parsed.fhir, toDosageDetails(parsed.fhir)]) {
      let rejectingCalls = 0, acceptingCalls = 0;
      expect(nextDueDoses(dosage, { ...options, evaluateCondition: predicate => {
        expect(predicate).toMatchObject(condition);
        rejectingCalls++;
        return false;
      } })).toEqual([]);
      expect(rejectingCalls).toBeGreaterThan(0);
      expect(nextDueDoses(dosage, { ...options, evaluateCondition: predicate => {
        expect(predicate).toMatchObject(condition);
        acceptingCalls++;
        return true;
      } })).toEqual(["2026-11-02T09:00:00+07:00", "2026-11-03T09:00:00+07:00"]);
      expect(acceptingCalls).toBeGreaterThan(0);
    }
  });

  it.each([
    ["able to swallow", ","], ["able to swallow", ""],
    ["you can swallow", ","], ["you can swallow", ""],
    ["you can swallow 1 tablet", ","],
    ["you can drink water", ","], ["you can drink water", ":"]
  ])("keeps the complete antecedent %s with separator %s", (antecedent, separator) => {
    const input = `Only if ${antecedent}${separator} take 1 tablet daily`;
    const condition = { kind: "state", name: antecedent, expected: true };
    expect(parseMedicationGuard(input)?.condition).toMatchObject(condition);
    const parsed = parsePublicSig(input);
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    expect(parsed.meta.canonical.clauses[0].clinicalAdjuncts?.condition).toMatchObject(condition);
    expect(parsed.fhir[0].doseAndRate?.[0].doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(getDosageCondition(parsed.fhir[0])).toMatchObject(condition);
    for (const view of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
      const members = importCanonicalCourse(view).stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(1);
      expect(members[0].amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(members[0].predicate).toMatchObject(condition);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });

  it.each([
    ["Only if you can drink water, take 1 tablet daily for 2 days", []],
    ["Only if you can drink water: take 1 tablet daily for 2 days; call the clinic", ["call"]],
    ["Take 1 tablet daily for 2 days only if you can drink water", []],
    ["Take 1 tablet daily for 2 days only if you can drink water; call the clinic", ["call"]],
    ["Only if you can drink water, take 1 tablet daily for 2 days; drink 100 mL water", ["drink"]]
  ] as const)("keeps an antecedent activity inside its clinical condition: %s", (source, outsideActions) => {
    const parsed = parsePublicSig(source), before = JSON.stringify(parsed);
    const clause = parsed.meta.canonical.clauses[0];
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    expect((clause.instructionGraph?.actions ?? []).map(action => action.predicate.lemma)).toEqual(outsideActions);
    expect(clause.instructionScopes).toHaveLength(1);
    const scope = clause.instructionScopes![0];
    expect(source.slice(scope.span.start, scope.span.end).trim()).toMatch(/^Only if you can drink water[,:]?$|^only if you can drink water$/);
    expect(source.slice(scope.target.start, scope.target.end).toLowerCase()).toContain("take 1 tablet");
    for (const view of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
      const member = importCanonicalCourse(view).stages[0].administrations[0];
      expect(member.amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(member.predicate).toMatchObject({ kind: "state", name: "you can drink water", expected: true });
      expect(member.schedule?.recurrence).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
      const en = formatSig(view, "long", { locale: "en", realizationMode: "normalized" });
      const th = formatSig(view, "long", { locale: "th", realizationMode: "normalized" });
      expect(en).not.toMatch(/^Drink water|then drink water/i);
      expect(th).not.toContain("จากนั้นดื่มน้ำ");
      expect(en).toContain("only if you can drink water");
      expect(th).toContain("you can drink water");
      if (outsideActions[0] === "call") expect(en).toContain("Call the clinic.");
      if (outsideActions[0] === "drink") expect(en).toMatch(/Drink 100 m[Ll] water\./);
      const query = { from: "2026-12-01T00:00:00Z", orderedAt: "2026-12-01T00:00:00Z", timeZone: "UTC", limit: 3 };
      expect(nextDueDoses(view, { ...query, evaluateCondition: () => true })).toEqual([
        "2026-12-01T09:00:00+00:00", "2026-12-02T09:00:00+00:00"
      ]);
      let rejected = 0;
      expect(nextDueDoses(view, { ...query, evaluateCondition: () => { rejected++; return false; } })).toEqual([]);
      expect(rejected).toBeGreaterThan(0);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it.each([
    ["If dizzy, do not chew 1 tablet", "Swallow 1 tablet daily", "dizzy"],
    ["ถ้าเวียนศีรษะ ห้ามเคี้ยว 1 เม็ด", "กลืน 1 เม็ด ทุกวัน", "เวียนศีรษะ"]
  ])("keeps quantified negative advice separate from positive PRN: %s", (advice, standing, symptom) => {
    const adviceOnly = parsePublicSig(advice);
    expect(adviceOnly.meta.canonical.clauses).toHaveLength(1);
    expect(adviceOnly.fhir).toHaveLength(1);
    expect(adviceOnly.meta.canonical.clauses.every(clause => !clause.dose && !clause.prn?.enabled)).toBe(true);
    expect(adviceOnly.fhir.every(row => !row.doseAndRate && !row.asNeeded)).toBe(true);
    for (const view of [adviceOnly.meta.canonical.course!, JSON.parse(JSON.stringify(adviceOnly.fhir)),
      JSON.parse(JSON.stringify(adviceOnly.fhirNext))]) {
      const members = importCanonicalCourse(view).stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(1);
      expect(members[0].amounts).toBeUndefined();
      expect(members[0].asNeeded).not.toBe(true);
      const graph = members[0].syntax?.instructionGraph;
      expect(graph?.actions).toHaveLength(1);
      expect(graph!.actions[0]).toMatchObject({ predicate: { lemma: "chew" }, polarity: "negate" });
      expect(graph!.actions[0].args).toContainEqual(expect.objectContaining({
        role: AdviceArgumentRole.Amount, quantity: expect.objectContaining({ value: 1, unit: "tab" })
      }));
      expect(graph!.relations).toContainEqual(expect.objectContaining({
        kind: "if", toActionIndex: 0, text: expect.stringContaining(symptom)
      }));
    }
    expect(adviceOnly.input).toBe(advice);
    expect(adviceOnly.fhirNext.renderedInstruction).toBe(advice);
    const input = `${standing}; ${advice}`, parsed = parsePublicSig(input);
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    for (const row of [parsed.fhir[0], ...toFhirR5Dosages(parsed.fhirNext)]) {
      expect(row.doseAndRate?.[0].doseQuantity).toMatchObject({ value: 1, unit: "tab" });
      expect(row.timing?.repeat).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
      expect(row.asNeeded).not.toBe(true);
      expect(getDosageCondition(row)).toBeUndefined();
    }
    const graph = parsed.meta.canonical.clauses[0].instructionGraph!;
    const actionIndex = graph.actions.findIndex(action => action.predicate.lemma === "chew");
    expect(actionIndex).toBeGreaterThanOrEqual(0);
    expect(graph.actions[actionIndex]).toMatchObject({ polarity: "negate" });
    expect(graph.relations).toContainEqual(expect.objectContaining({
      kind: "if", toActionIndex: actionIndex, text: expect.stringContaining(symptom)
    }));
    for (const dosage of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
      let evaluations = 0;
      expect(calculateTotalUnits({ dosage, from: "2027-01-01T00:00:00Z", orderedAt: "2027-01-01T00:00:00Z",
        timeZone: "UTC", durationValue: 2, durationUnit: "d", evaluateCondition: () => {
          evaluations++; return false;
        } })).toMatchObject({ totalUnits: 2, unit: "tab" });
      expect(evaluations).toBe(0);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });

  it.each([
    "the extra dose", "the additional dose", "1 extra tablet",
    "an extra 1 tablet", "an additional 1 tablet", "an extra half tablet"
  ])("keeps a supplemental prohibition independent from the standing dose: %s", target => {
    const input = `Swallow 1 tablet daily for 7 days; If dizzy, do not chew ${target}.`;
    const parsed = parsePublicSig(input);
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    const graph = parsed.meta.canonical.clauses[0].instructionGraph!;
    const actionIndex = graph.actions.findIndex(action => action.predicate.lemma === "chew");
    expect(actionIndex).toBeGreaterThanOrEqual(0);
    expect(graph.actions[actionIndex]).toMatchObject({ polarity: "negate",
      args: expect.arrayContaining([expect.objectContaining({ text: target })]) });
    expect(graph.relations).toContainEqual(expect.objectContaining({
      kind: "if", toActionIndex: actionIndex, text: "If dizzy,"
    }));
    for (const dosage of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext])
      expect(formatSig(dosage, "long", { locale: "en", realizationMode: "normalized" }))
        .toContain(`If dizzy, do not chew ${target}.`);
    expect(parsed.meta.canonical.clauses[0].clinicalAdjuncts?.condition).toBeUndefined();
    for (const row of [parsed.fhir[0], ...toFhirR5Dosages(parsed.fhirNext)]) {
      expect(row.doseAndRate?.[0].doseQuantity).toMatchObject({ value: 1, unit: "tab" });
      expect(getDosageCondition(row)).toBeUndefined();
      expect(row.asNeeded).not.toBe(true);
    }
    let evaluatorCalls = 0;
    expect(nextDueDoses(parsed.fhirNext, {
      from: "2026-11-02T00:00:00+07:00", orderedAt: "2026-11-02T00:00:00+07:00",
      timeZone: "Asia/Bangkok", limit: 8,
      evaluateCondition: () => { evaluatorCalls++; return false; }
    })).toHaveLength(7);
    expect(evaluatorCalls).toBe(0);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });

  it.each([
    "If dizzy, chew 1 tablet", "If dizzy, do chew 1 tablet",
    "ถ้าเวียนศีรษะ ให้เคี้ยว 1 เม็ด", "ถ้าเวียนศีรษะ, ให้เคี้ยว 1 เม็ด",
    "ถ้าเวียนศีรษะ ให้กลืน 1 เม็ด", "ถ้าเวียนศีรษะ, ให้กลืน 1 เม็ด",
    "ถ้าเวียนศีรษะ ให้รับประทาน 1 เม็ด"
  ])(
    "retains an ordinary symptom PRN on a positive quantified administration: %s", input => {
      const parsed = parsePublicSig(input), clause = parsed.meta.canonical.clauses[0];
      expect(clause.dose).toEqual({ value: 1, unit: "tab" });
      expect(clause.prn?.enabled).toBe(true);
      expect(clause.clinicalAdjuncts?.condition).toBeUndefined();
      expect(parsed.fhirNext.renderedInstruction).toBe(input);
    }
  );

  it.each(["", " at 08:00", " at 8 AM"])(
    "keeps a procedure's condition separate from medication PRN: %s", clock => {
      for (const standing of ["", "Take 1 tablet daily; "]) {
        const input = `${standing}Mix with water${clock} if instructed`;
        const parsed = parsePublicSig(input), clause = parsed.meta.canonical.clauses[0];
        expect(parsed.meta.canonical.clauses).toHaveLength(1);
        expect(clause.prn?.enabled).not.toBe(true);
        expect(clause.clinicalAdjuncts?.condition).toBeUndefined();
        expect(clause.schedule?.timeOfDay).toBeUndefined();
        const graph = clause.instructionGraph!;
        expect(graph.sourceText).toBe(input);
        expect(graph.relations).toContainEqual(expect.objectContaining({
          kind: "if", toActionIndex: 0, text: "if instructed"
        }));
        for (const row of [parsed.fhir[0], ...toFhirR5Dosages(parsed.fhirNext)]) {
          expect(row.asNeeded).not.toBe(true);
          expect(getDosageCondition(row)).toBeUndefined();
          expect(row.timing?.repeat?.timeOfDay).toBeUndefined();
          if (standing) {
            expect(row.doseAndRate?.[0].doseQuantity).toMatchObject({ value: 1, unit: "tab" });
            expect(row.timing?.repeat).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
          } else {
            expect(row.doseAndRate).toBeUndefined();
          }
        }
        expect(parsed.fhirNext.renderedInstruction).toBe(input);
      }
    }
  );

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
    const expected = [
      { site: 'left eye', dose: 1, unit: 'drop' },
      { site: 'right eye', dose: 2, unit: 'drop' },
      ...(input.includes('both eyes') ? [{ site: 'both eyes', dose: 1, unit: 'drop' }] : [])
    ];
    expect(parsed.items.map(item => ({
      site: item.fhir.site?.text,
      dose: item.fhir.doseAndRate?.[0].doseQuantity?.value,
      unit: item.fhir.doseAndRate?.[0].doseQuantity?.unit
    }))).toEqual(expected);
    for (const item of parsed.items) {
      expect(item.meta.canonical.clauses[0].schedule?.count).toBeUndefined();
      expect(item.meta.canonical.clauses[0].schedule).toMatchObject({ countMax: 3, period: 5, periodUnit: 'min'
      });
      expect(item.fhir.timing?.repeat?.count).toBeUndefined();
      expect(item.fhir.timing?.repeat?._count).toEqual({ extension: [{
        url: 'http://hl7.org/fhir/StructureDefinition/data-absent-reason', valueCode: 'unknown'
      }] });
      expect(item.fhir.timing?.repeat).toMatchObject({ countMax: 3, period: 5, periodUnit: 'min'
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
      expect(fhir.timing?.repeat?.count).toBeUndefined();
      expect(fhir.timing?.repeat?._count).toEqual({ extension: [{
        url: 'http://hl7.org/fhir/StructureDefinition/data-absent-reason', valueCode: 'unknown'
      }] });
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


describe("round65 selected procedural comma ownership", () => {
  it("keeps a built-in procedural predecessor despite a custom code collision", () => {
    const source = "Rinse the skin, apply 1 g to the rash";
    const options = { instructionActionMap: { flush: { code: "rinse", procedural: false, display: "Flush" } } };
    for (const supplied of [undefined, options])
      expect(parseHpsgSegments(source, supplied)).toEqual([{ text: source, start: 0, end: source.length }]);
  });
  it("keeps an internal wait-argument comma despite a custom code collision", () => {
    const source = "Take 1 tablet on empty stomach with water; wait 30 minutes before food, drink, or other meds";
    const options = { instructionActionMap: { delay: { code: "wait", procedural: false, display: "Delay" } } };
    for (const supplied of [undefined, options]) {
      const plan = createBoundaryPlan(source, supplied);
      expect(plan.claims.some(claim => claim.kind === "procedural-argument")).toBe(true);
      expect(plan.segments).toEqual([{ text: source, start: 0, end: source.length }]);
      const parsed = parseSig(source, supplied);
      expect(parsed.meta.canonical.clauses).toHaveLength(1);
      const actions = parsed.meta.canonical.clauses[0].instructionGraph?.actions;
      expect(actions?.some(action => action.predicate.lemma === "drink")).toBe(false);
      const wait = actions?.find(action => action.predicate.lemma === "wait");
      expect(wait?.args).toContainEqual(expect.objectContaining({ role: "duration", quantity: { value: 30, unit: "min" } }));
      expect(parsed.longText).toMatch(/wait 30 minutes before food, drink or other medicines/iu);
    }
  });
});


describe("round68 selected withholding and successor route ownership", () => {
  it("does not inherit an injection method onto an oral successor when its predecessor omitted the route", () => {
    const parsed = parsePublicSig("Inject 5 mg daily for 2 days, then 10 mg PO from day 3");
    expect(parsed.meta.canonical.clauses).toHaveLength(2);
    expect(parsed.meta.canonical.clauses[0].method?.text).toBe("Inject");
    expect(parsed.meta.canonical.clauses[0].route).toBeUndefined();
    const successor = parsed.meta.canonical.clauses[1];
    expect(successor.dose).toEqual({ value: 10, unit: "mg" });
    expect(successor.route?.code).toBe("26643006");
    expect(successor.method).toBeUndefined();
    for (const rows of [parsed.fhir, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(rows[1].route?.coding?.[0].code).toBe("26643006");
      expect(rows[1].method).toBeUndefined();
    }
  });

  it.each([false, true])("retains the selected Hold pause despite a distinct configured code collision (%s)", configured => {
    const options = configured ? { instructionActionMap: { "custom-mix": {
      ...getMedicationInstructionAction("mix")!, code: "hold", display: "Custom mix", aliases: []
    } } } : undefined;
    const parsed = parsePublicSig("Take 1 tablet daily for 3 days, then hold for 2 days, then resume 1 tablet daily", options);
    expect(parsed.meta.canonical.clauses[1].schedule?.treatmentStartOffsetDays).toBe(5);
    const query = { orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-01T00:00:00Z", timeZone: "UTC", limit: 5 };
    for (const input of [parsed.meta.canonical.course, JSON.parse(JSON.stringify(parsed.fhir)), JSON.parse(JSON.stringify(parsed.fhirNext))])
      expect(nextDueDoses(input, query)).toEqual([
        "2026-12-01T09:00:00+00:00", "2026-12-02T09:00:00+00:00", "2026-12-03T09:00:00+00:00",
        "2026-12-06T09:00:00+00:00", "2026-12-07T09:00:00+00:00"
      ]);
  });

  it.each(["PO", "IV", ""])("inherits an injection method only with a compatible successor route: %s", route => {
    const parsed = parsePublicSig("Inject 5 mg IV daily for 2 days, then 10 mg " + route + " from day 3");
    expect(parsed.meta.canonical.clauses).toHaveLength(2);
    const successor = parsed.meta.canonical.clauses[1];
    expect(successor.dose).toEqual({ value: 10, unit: "mg" });
    expect(successor.route?.code).toBe(route === "PO" ? "26643006" : "47625008");
    expect(successor.schedule).toMatchObject({ treatmentStartOffsetDays: 2, frequency: 1, period: 1, periodUnit: "d" });
    if (route === "PO") expect(successor.method).toBeUndefined();
    else expect(successor.method?.text).toBe("Inject");
    for (const rows of [parsed.fhir, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(rows[1].route?.coding?.[0].code).toBe(route === "PO" ? "26643006" : "47625008");
      if (route === "PO") expect(rows[1].method).toBeUndefined();
      else expect(rows[1].method?.coding?.[0].code).toBe("740685003");
    }
  });
});


describe("round69 prepared dose phase ownership", () => {
  it.each([
    ["Dissolve 1 tablet in 30 mL water, then drink daily", [1]],
    ["Dissolve 1 tablet in 30 mL water, then drink daily for 3 days, then take 2 tablets daily", [1, 2]]
  ] as const)("preserves an ordinary workflow or separately dosed administration: %s", (source, doses) => {
    const parsed = parsePublicSig(source, { context: { dosageForm: "effervescent tablet" } });
    expect(parsed.meta.canonical.clauses.map(clause => clause.dose?.value)).toEqual(doses);
    expect(parsed.meta.canonical.clauses.every(clause => clause.schedule?.frequency === 1)).toBe(true);
    expect(parsed.meta.canonical.clauses[0].instructionGraph?.actions.filter(action => action.predicate.lemma === "dissolve"))
      .toHaveLength(1);
  });

  it.each([
    "Dissolve 1 tablet in 30 mL water, then drink daily for 3 days, then dissolve 2 tablets in 60 mL water, then drink daily",
    "Dissolve 1 tablet in 30 mL water, then drink daily for 3 days; then dissolve 2 tablets in 60 mL water, then drink daily",
    "ละลาย1เม็ดในน้ำ30มล. แล้วดื่มวันละครั้งนาน3วัน จากนั้นละลาย2เม็ดในน้ำ60มล. แล้วดื่มวันละครั้ง"
  ])("keeps each prepared dose with its following administration: %s", source => {
    const parsed = parsePublicSig(source, { context: { dosageForm: "effervescent tablet" } });
    const clauses = parsed.meta.canonical.clauses;
    expect(clauses).toHaveLength(2);
    expect(clauses.map(clause => clause.dose)).toEqual([{ value: 1, unit: "tab" }, { value: 2, unit: "tab" }]);
    expect(clauses.map(clause => clause.method?.text)).toEqual(["Drink", "Drink"]);
    expect(clauses.map(clause => clause.schedule?.duration)).toEqual([3, undefined]);
    for (let index = 0; index < clauses.length; index++) {
      const clause = clauses[index];
      expect(clause.schedule).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
      const graph = clause.instructionGraph!, owner = graph.primaryOwnership!.dose!;
      expect(graph.actions[owner.actionIndex].args[owner.argumentIndex].quantity)
        .toEqual({ value: index + 1, unit: "tab" });
      expect(graph.actions[owner.actionIndex].args.find(arg => arg.role === "substance")?.quantity)
        .toEqual({ value: index === 0 ? 30 : 60, unit: "mL" });
    }
    expect(parsed.meta.canonical.course?.instruction).toBe(source);
    const original = JSON.stringify([parsed.fhir, parsed.fhirNext]);
    const rows: typeof parsed.fhir = JSON.parse(JSON.stringify(parsed.fhir));
    const r6: typeof parsed.fhirNext = JSON.parse(JSON.stringify(parsed.fhirNext));
    expect(rows).toHaveLength(2);
    expect(r6.step).toHaveLength(2);
    for (let index = 0; index < 2; index++) {
      rows[index].doseAndRate![0].doseQuantity!.value = index + 3;
      r6.step![index].component[0].doseAndRate![0].doseQuantity!.value = index + 3;
    }
    for (const input of [rows, r6]) {
      const before = JSON.stringify(input);
      for (const locale of ["en", "th"] as const) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        expect(text.match(locale === "en" ? /3 tablets/gu : /3 เม็ด/gu)).toHaveLength(1);
        expect(text.match(locale === "en" ? /4 tablets/gu : /4 เม็ด/gu)).toHaveLength(1);
        expect(text).not.toMatch(locale === "en" ? /[12] tablets?/u : /[12] เม็ด/u);
        expect(text.match(locale === "en" ? /30 mL/gu : /30 มิลลิลิตร/gu)).toHaveLength(1);
        expect(text.match(locale === "en" ? /60 mL/gu : /60 มิลลิลิตร/gu)).toHaveLength(1);
        const firstPreparation = text.search(locale === "en"
          ? /dissolve 3 tablets in 30 mL water/iu : /ละลาย\s*3 เม็ดในน้ำ 30 มิลลิลิตร/u);
        const secondPreparation = text.search(locale === "en"
          ? /dissolve 4 tablets in 60 mL water/iu : /ละลาย\s*4 เม็ดในน้ำ 60 มิลลิลิตร/u);
        expect(firstPreparation, text).toBeGreaterThanOrEqual(0);
        expect(secondPreparation).toBeGreaterThan(firstPreparation);
        expect(text.match(locale === "en" ? /drink/giu : /ดื่ม/gu)).toHaveLength(2);
        expect(text.match(locale === "en" ? /once daily/gu : /วันละครั้ง/gu)).toHaveLength(2);
      }
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(JSON.stringify([parsed.fhir, parsed.fhirNext])).toBe(original);
  });
});


describe("round70 fronted treatment-day onset", () => {
  it.each([",", ""])("keeps day 11 on its successor across an optional comma (%s)", comma => {
    const source = "Take 1 tablet daily at 08:00 for 7 days, then from day 11" + comma + " take 2 tablets";
    const parsed = parsePublicSig(source), clauses = parsed.meta.canonical.clauses;
    expect(clauses).toHaveLength(2);
    expect(clauses.map(clause => clause.dose)).toEqual([{ value: 1, unit: "tab" }, { value: 2, unit: "tab" }]);
    expect(clauses[0].schedule).toMatchObject({ duration: 7, durationUnit: "d", frequency: 1,
      period: 1, periodUnit: "d", timeOfDay: ["08:00:00"] });
    expect(clauses[0].schedule?.treatmentStartOffsetDays).toBeUndefined();
    expect(clauses[1].schedule).toMatchObject({ treatmentStartOffsetDays: 10, phaseStartReference: "treatment-day-start",
      frequency: 1, period: 1, periodUnit: "d", timeOfDay: ["08:00:00"] });
    expect(clauses[1].schedule?.duration).toBeUndefined();
    const query = { orderedAt: "2026-12-01T08:00:00Z", from: "2026-12-01T08:00:00Z", timeZone: "UTC", limit: 9 };
    const due = ["2026-12-01T08:00:00+00:00", "2026-12-02T08:00:00+00:00", "2026-12-03T08:00:00+00:00",
      "2026-12-04T08:00:00+00:00", "2026-12-05T08:00:00+00:00", "2026-12-06T08:00:00+00:00",
      "2026-12-07T08:00:00+00:00", "2026-12-11T08:00:00+00:00", "2026-12-12T08:00:00+00:00"];
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) expect(nextDueDoses(input, query)).toEqual(due);
  });
});


describe("round71 prepared successor without an authored cadence", () => {
  it.each([
    "Dissolve 1 tablet in 30 mL water, then drink daily for 3 days, then dissolve 2 tablets in 60 mL water, then drink",
    "ละลาย1เม็ดในน้ำ30มล. แล้วดื่มวันละครั้งนาน3วัน จากนั้นละลาย2เม็ดในน้ำ60มล. แล้วดื่ม"
  ])("keeps both prepared dose owners without inventing successor timing: %s", source => {
    const parsed = parsePublicSig(source, { context: { dosageForm: "effervescent tablet" } });
    const clauses = parsed.meta.canonical.clauses;
    expect(clauses).toHaveLength(2);
    expect(clauses.map(clause => clause.dose)).toEqual([{ value: 1, unit: "tab" }, { value: 2, unit: "tab" }]);
    expect(clauses.map(clause => clause.method?.text)).toEqual(["Drink", "Drink"]);
    expect(clauses[0].schedule).toMatchObject({ frequency: 1, period: 1, periodUnit: "d", duration: 3, durationUnit: "d" });
    expect(clauses[1].schedule).toBeUndefined();
    expect(parsed.meta.canonical.course?.instruction).toBe(source);
    const rows: typeof parsed.fhir = JSON.parse(JSON.stringify(parsed.fhir));
    const r6: typeof parsed.fhirNext = JSON.parse(JSON.stringify(parsed.fhirNext));
    expect(rows).toHaveLength(2);
    expect(r6.step).toHaveLength(2);
    expect(rows.map(row => row.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([1, 2]);
    expect(r6.step!.map(step => step.component[0].doseAndRate?.[0]?.doseQuantity?.value)).toEqual([1, 2]);
    expect(rows[1].timing?.repeat).toBeUndefined();
    expect(r6.step![1].component[0].timing?.repeat).toBeUndefined();
    for (const input of [parsed.meta.canonical.course!, rows, r6]) {
      const before = JSON.stringify(input);
      for (const locale of ["en", "th"] as const) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        expect(text.match(locale === "en" ? /\b1 tablet\b/gu : /(?:^|[^0-9.,+-])1 เม็ด/gu)).toHaveLength(1);
        expect(text.match(locale === "en" ? /\b2 tablets\b/gu : /(?:^|[^0-9.,+-])2 เม็ด/gu)).toHaveLength(1);
        expect(text.match(locale === "en" ? /\b30 mL\b/gu : /(?:^|[^0-9.,+-])30 มิลลิลิตร/gu)).toHaveLength(1);
        expect(text.match(locale === "en" ? /\b60 mL\b/gu : /(?:^|[^0-9.,+-])60 มิลลิลิตร/gu)).toHaveLength(1);
        expect(text).toMatch(locale === "en"
          ? /dissolve 1 tablet in 30 mL water/iu : /ละลาย\s*1 เม็ดในน้ำ 30 มิลลิลิตร/u);
        expect(text).toMatch(locale === "en"
          ? /dissolve 2 tablets in 60 mL water/iu : /ละลาย\s*2 เม็ดในน้ำ 60 มิลลิลิตร/u);
        expect(text.match(locale === "en" ? /drink/giu : /ดื่ม/gu)).toHaveLength(2);
        const cadence = locale === "en" ? "once daily" : "วันละครั้ง";
        const firstDose = text.indexOf(locale === "en" ? "1 tablet" : "1 เม็ด");
        const secondDose = text.indexOf(locale === "en" ? "2 tablets" : "2 เม็ด");
        expect(text.slice(firstDose, secondDose)).toContain(cadence);
        expect(text.slice(secondDose)).not.toContain(cadence);
        expect(text.split(cadence)).toHaveLength(2);
      }
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it("matches the ordinary untimed successor and preserves a single preparation workflow", () => {
    const plain = parsePublicSig("Take 1 tablet daily for 3 days, then take 2 tablets");
    expect(plain.meta.canonical.clauses.map(clause => clause.dose?.value)).toEqual([1, 2]);
    expect(plain.meta.canonical.clauses[1].schedule).toBeUndefined();
    const single = parsePublicSig("Dissolve 1 tablet in 30 mL water, then drink", {
      context: { dosageForm: "effervescent tablet" }
    });
    expect(single.meta.canonical.clauses).toHaveLength(1);
    expect(single.meta.canonical.clauses[0].dose).toEqual({ value: 1, unit: "tab" });
    expect(single.meta.canonical.clauses[0].method?.text).toBe("Drink");
    expect(single.meta.canonical.clauses[0].schedule).toBeUndefined();
  });
});


describe("round74 selected administration scope", () => {
  it("keeps bedtime when an unrelated safety surface matches the selected head code", () => {
    const options = { instructionActionMap: {
      swallow: { ...getMedicationInstructionAction("swallow")!, code: "clinic-ingest" },
      "clinic-ingest": { code: "clinic-defer", display: "Defer", semanticClass: "procedure",
        procedural: true, safetyScopeTarget: true }
    } };
    const source = "Swallow 1 tablet whole before bedtime", parsed = parsePublicSig(source, options);
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.dose).toEqual({ value: 1, unit: "tab" });
    expect(clause.method?.text).toBe("Swallow");
    expect(clause.schedule?.when).toEqual(["HS"]);
    for (const input of [parsed.fhir, parsed.fhirNext, JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)))]) {
      const en = formatSig(input, "long", { ...options, locale: "en", realizationMode: "normalized" });
      const th = formatSig(input, "long", { ...options, locale: "th", realizationMode: "normalized" });
      expect(en).toMatch(/Swallow 1 tablet whole before sleep/u);
      expect(th).toContain("ก่อนนอน");
      expect(th).toContain("ทั้งเม็ด");
    }
  });
});


describe("round76 shared recurrence antecedents", () => {
  it.each([false, true])("copies a timing-reference cadence only when every predecessor agrees (same=%s)", same => {
    const source = "Take 1 tablet daily and 2 tablets " + (same ? "daily" : "every other day") +
      " for 7 days, then 3 tablets at the same time";
    const parsed = parsePublicSig(source);
    const successor = parsed.meta.canonical.clauses[2];
    expect(successor.dose).toMatchObject({ value: 3, unit: "tab" });
    expect(successor.schedule?.timingReference).toBe("previous");
    expect(successor.schedule?.frequency).toBe(same ? 1 : undefined);
    expect(successor.schedule?.period).toBe(same ? 1 : undefined);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    const query = { orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-08T00:00:00Z", timeZone: "UTC", limit: 2 };
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext)), JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)))]) {
      const before = JSON.stringify(input);
      const course = importCanonicalCourse(input);
      const current = course.stages[course.stages.length - 1].administrations[0];
      expect(current.amounts[0].quantity).toMatchObject({ value: 3, unit: "tab" });
      expect(current.schedule?.recurrence?.frequency).toBe(same ? 1 : undefined);
      expect(current.schedule?.recurrence?.period).toBe(same ? 1 : undefined);
      expect(nextDueDoses(input, query)).toEqual(same
        ? ["2026-12-08T09:00:00+00:00", "2026-12-09T09:00:00+00:00"] : []);
      expect(JSON.stringify(input)).toBe(before);
    }
  });
});


describe("round76 timing-reference clock compatibility", () => {
  it.each([
    { frequency: 3, words: "three times daily", afterwards: "", clocks: ["08:00", "20:00"] },
    { frequency: 3, words: "three times daily", afterwards: " afterwards", clocks: ["08:00", "20:00"] },
    { frequency: 2, words: "twice daily", afterwards: " afterwards", clocks: ["07:30", "21:30"] },
  ])("keeps current cadence authoritative before inheriting clock anchors ($frequency/$afterwards)", ({ frequency, words, afterwards, clocks }) => {
    const source = "Take 1 tablet at " + clocks.join(" and ") + " for 3 days, then 2 tablets " + words + " at the same times" + afterwards;
    const parsed = parsePublicSig(source);
    const schedule = parsed.meta.canonical.clauses[1].schedule!;
    expect(schedule.frequency).toBe(frequency);
    expect(schedule.timeOfDay).toEqual(frequency === 2 ? clocks.map(clock => clock + ":00") : undefined);
    expect(schedule.timingReference).toBe(frequency === 2 ? undefined : "previous");
    if (afterwards) expect(schedule.evidence?.some(item => item.rule === "hpsg.lex.schedule.trailing-phase-relation" &&
      item.scheduleFields === undefined)).toBe(true);
    const config: NextDueDoseConfig = { frequencyDefaults: {
      byCode: { BID: ["09:00", "17:00"], TID: ["07:00", "13:00", "19:00"] },
    } };
    const query = { orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-04T00:00:00Z", timeZone: "UTC", limit: frequency, config };
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext)), JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)))]) {
      const before = JSON.stringify(input);
      expect(importCanonicalCourse(input).stages[1].administrations[0].schedule?.recurrence?.clocks)
        .toEqual(frequency === 2 ? clocks.map(clock => clock + ":00") : undefined);
      expect(nextDueDoses(input, query)).toEqual((frequency === 2 ? clocks : ["07:00", "13:00", "19:00"])
        .map(clock => "2026-12-04T" + clock + ":00+00:00"));
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 1, durationUnit: "d" }).totalUnits).toBe(frequency * 2);
      expect(JSON.stringify(input)).toBe(before);
    }
  });
});


describe("negative meal accompaniment ownership", () => {
  it.each([
    ["Swallow 1 tablet without food", "Swallow 1 tablet without food."],
    ["Swallow 1 tablet with water without food", "Swallow 1 tablet with water. Take without food."]
  ])("keeps the negative meal instruction in %s", (source, expected) => {
    const parsed = parsePublicSig(source);
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.dose).toEqual({ value: 1, unit: "tab" });
    expect(clause.raw?.text).toBe(source);
    expect(clause.schedule?.when).toBeUndefined();
    for (const rows of [parsed.fhir, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(rows).toHaveLength(1);
      expect(rows[0].doseAndRate?.[0].doseQuantity).toMatchObject({ value: 1, unit: "tab" });
      expect(rows[0].timing?.repeat?.when).toBeUndefined();
    }
    for (const input of [parsed.fhir, parsed.fhirNext]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toBe(expected);
      const thai = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(thai).toMatch(/โดยไม่มี\s*อาหาร/u);
      expect(thai).not.toMatch(/Without food|\bfood\b/u);
      expect(thai).not.toContain("พร้อมอาหาร");
      if (source.includes("with water")) expect(thai).toContain("น้ำ");
    }
  });

  it("retains positive meal timing and independent empty-stomach and fasting advice", () => {
    const meal = parsePublicSig("Swallow 1 tablet with food");
    expect(meal.fhir[0].timing?.repeat?.when).toEqual(["C"]);
    expect(formatSig(meal.fhirNext, "long", { locale: "en", realizationMode: "normalized" }))
      .toBe("Swallow 1 tablet with meals.");
    const empty = parsePublicSig("Take 1 tablet on an empty stomach with water");
    expect(empty.fhir[0].timing?.repeat?.when).toBeUndefined();
    expect(formatSig(empty.fhirNext, "long", { locale: "en", realizationMode: "normalized" }))
      .toBe("Take 1 tablet orally. On an empty stomach. Take with water.");
    const fasting = parsePublicSig("Take 1 tablet daily while fasting");
    expect(fasting.fhir[0].timing?.repeat).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
    expect(formatSig(fasting.fhirNext, "long", { locale: "en", realizationMode: "normalized" }))
      .toBe("Take 1 tablet orally once daily. While fasting.");
  });
});


describe("prefix guard constituent ownership", () => {
  it.each([
    ["Only if dizzy take 1 tablet, with food", { kind: "state", name: "dizzy", expected: true }],
    ["Only if dizzy, take 1 tablet with food", { kind: "state", name: "dizzy", expected: true }],
    ["If glucose > 180 and dizzy take 1 tablet, with food", { kind: "all", conditions: [
      { kind: "measurement", name: "glucose", operation: "gt", value: 180 },
      { kind: "state", name: "dizzy", expected: true }] }],
    ["If glucose > 180 and dizzy, take 1 tablet with food", { kind: "all", conditions: [
      { kind: "measurement", name: "glucose", operation: "gt", value: 180 },
      { kind: "state", name: "dizzy", expected: true }] }],
    ["เฉพาะเมื่อเวียนศีรษะ ให้รับประทาน 1 เม็ด, พร้อมอาหาร", { kind: "state", name: "เวียนศีรษะ", expected: true }],
    ["เฉพาะเมื่อเวียนศีรษะ, ให้รับประทาน 1 เม็ด พร้อมอาหาร", { kind: "state", name: "เวียนศีรษะ", expected: true }]
  ])("keeps the administration out of the admitted predicate: %s", (input, condition) => {
    const source = input as string, parsed = parsePublicSig(source), before = JSON.stringify(parsed);
    expect(parseMedicationGuard(source)?.condition).toMatchObject(condition);
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    expect(parsed.meta.canonical.clauses[0].dose).toEqual({ value: 1, unit: "tab" });
    for (const course of [parsed.meta.canonical.course!, importCanonicalCourse(parsed.fhir),
        importCanonicalCourse(parsed.fhirNext)]) {
      expect(course.stages[0].administrations).toHaveLength(1);
      expect(course.stages[0].administrations[0].predicate).toMatchObject(condition);
      expect(course.stages[0].administrations[0].amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(course.stages[0].administrations[0].asNeeded).not.toBe(true);
    }
    expect(parsed.input).toBe(source);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it.each([
    ["Take 1 tablet daily; If dizzy, hold the dose", 1, "tab"],
    ["Take 1 tablet daily; If dizzy, do not take 1 tablet", 1, "tab"],
    ["Apply 1 patch daily; If dizzy, do not apply 1 patch", 1, "patch"],
    ["Instill 1 drop daily; If dizzy, do not instill 1 drop", 1, "drop"]
  ] as const)("keeps a true administration prohibition executable: %s", (source, value, unit) => {
    const parsed = parsePublicSig(source);
    for (const course of [parsed.meta.canonical.course!, importCanonicalCourse(parsed.fhir),
        importCanonicalCourse(parsed.fhirNext)]) {
      const administrations = course.stages.flatMap(stage => stage.administrations);
      expect(administrations).toHaveLength(1);
      const administration = administrations[0];
      const predicate = { kind: "not", condition: { kind: "state", name: "dizzy", expected: true } };
      expect(administration.amounts?.[0].quantity).toMatchObject({ value, unit });
      expect(administration.predicate).toMatchObject(predicate);
      const query = { from: "2026-12-01T00:00:00Z", orderedAt: "2026-12-01T00:00:00Z",
        timeZone: "UTC", limit: 1 };
      let rejected = 0;
      // The patient is dizzy on the first day only. An unguarded duplicate
      // would incorrectly preserve that day's fixed 09:00 administration.
      expect(nextDueDoses(course, { ...query, evaluateCondition: (condition, at) => {
        expect(condition).toMatchObject(predicate);
        if (at.startsWith("2026-12-01")) { rejected++; return false; }
        return true;
      } })).toEqual(["2026-12-02T09:00:00+00:00"]);
      expect(rejected).toBeGreaterThan(0);
      expect(nextDueDoses(course, { ...query, evaluateCondition: () => true }))
        .toEqual(["2026-12-01T09:00:00+00:00"]);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });
});


describe("site and clock complement ownership", () => {
  it.each([
    ["Wash on the face at 08:00", "face", 12, 16, "89545001", "08:00:00"],
    ["Wash on the face at 8.30", "face", 12, 16, "89545001", "08:30:00"],
    ["Wash on the face at 8 AM", "face", 12, 16, "89545001", "08:00:00"],
    ["Wash the face at 08:00", "face", 9, 13, "89545001", "08:00:00"],
    ["Wash at 08:00 on the face", "face", 21, 25, "89545001", "08:00:00"],
    ["Apply 1 mL to the face at 08:00", "face", 18, 22, "89545001", "08:00:00"],
    ["Wash into the vagina at 08:00", "vagina", 14, 20, "76784001", "08:00:00"],
    ["ล้างบนใบหน้า เวลา 08:00", "face", 6, 12, "89545001", "08:00:00"]
  ] as const)("keeps the clock lead outside the coded Site in %s", (source, text, start, end, code, clock) => {
    const parsed = parsePublicSig(source);
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.site).toMatchObject({ text, range: { start, end },
      coding: { system: "http://snomed.info/sct", code } });
    expect(source.slice(start, end)).toBe(source.startsWith("ล้าง") ? "ใบหน้า" : text);
    expect(clause.schedule?.timeOfDay).toEqual([clock]);
    expect(clause.schedule?.frequency).toBeUndefined();
    if (source.startsWith("Apply")) expect(clause.dose).toEqual({ value: 1, unit: "mL" });
    if (text === "vagina") expect(clause.route?.code).toBe("16857009");
    for (const input of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
      const before = JSON.stringify(input), course = importCanonicalCourse(input);
      expect(course.stages).toHaveLength(1);
      expect(course.stages[0].administrations).toHaveLength(1);
      const administration = course.stages[0].administrations[0];
      expect(administration.target).toMatchObject({ text,
        coding: [expect.objectContaining({ system: "http://snomed.info/sct", code })] });
      expect(administration.schedule?.recurrence?.clocks).toEqual([clock]);
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).not.toMatch(/\bat at\b/u);
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(clause.raw?.text).toBe(source);
    expect(parsed.input).toBe(source);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it("retains the anatomical relation before an independent clock", () => {
    const source = "Wash around the eye at 08:00", parsed = parsePublicSig(source);
    expect(parsed.meta.canonical.clauses[0].site).toMatchObject({ text: "around eye",
      range: { start: 5, end: 19 }, spatialRelation: { relationText: "around", targetText: "eye",
        targetCoding: { system: "http://snomed.info/sct", code: "81745001" } } });
    expect(parsed.meta.canonical.clauses[0].schedule?.timeOfDay).toEqual(["08:00:00"]);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it("preserves an event complement and the independently negated inward action", () => {
    const event = parsePublicSig("Wash on the face before breakfast");
    expect(event.meta.canonical.clauses[0].site).toMatchObject({ text: "face",
      range: { start: 12, end: 16 }, coding: { code: "89545001" } });
    expect(event.meta.canonical.clauses[0].schedule?.when).toEqual(["ACM"]);
    const source = "Do not wash into vagina", negative = parsePublicSig(source);
    expect(negative.meta.canonical.clauses[0].instructionGraph?.actions[0]).toMatchObject({
      polarity: "negate", relation: "into", args: [expect.objectContaining({ role: "site", normalized: "vagina" })]
    });
    expect(negative.meta.canonical.clauses[0].schedule).toBeUndefined();
    expect(negative.fhirNext.renderedInstruction).toBe(source);
  });
});


describe("condition and successor timing ownership", () => {
  it.each(["take 1", "take 1 daily"])("retains a fronted measurement guard for the context-owned dose: %s", consequent => {
    const source = "If systolic BP is above 140 " + consequent;
    const parsed = parsePublicSig(source, { context: { dosageForm: "tablet" } });
    const saved = JSON.stringify(parsed);
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const before = JSON.stringify(input);
      const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(1);
      expect(members[0].amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(members[0].predicate).toMatchObject({ kind: "measurement", name: "systolic bp", operation: "gt", value: 140 });
      expect(members[0].predicate).toMatchObject({ text: "systolic BP is above 140" });
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(saved);
  });

  it("keeps a quantified activity inside the antecedent of a context-owned dose", () => {
    const source = "Only if you can take 1 tablet, take 1";
    const parsed = parsePublicSig(source, { context: { dosageForm: "tablet" } });
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(1);
      expect(members[0].amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(members[0].predicate).toMatchObject({ kind: "state", name: "you can take 1 tablet", text: "you can take 1 tablet" });
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it.each([undefined, { dosageForm: "tablet" }])("keeps an unquantified conditional prohibition as advice (%j)", context => {
    const source = "If dizzy, do not drive", parsed = parsePublicSig(source, { context });
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
      expect(members.every(member => !member.amounts?.length && !member.predicate)).toBe(true);
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toMatch(/(?:if dizzy,\s+do not drive|do not drive if dizzy)/iu);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it.each([false, true])("keeps the history count on its own conjunct beside an independent maximum (%s)", capped => {
    const history = "you have vomited no more than twice";
    const source = "Take 1 tablet only if your temperature is above 38 C and " + history +
      (capped ? ", maximum 2 doses per day" : "");
    const parsed = parsePublicSig(source), saved = JSON.stringify(parsed);
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const before = JSON.stringify(input);
      const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(1);
      expect(members[0].amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(members[0].predicate).toMatchObject({ kind: "all", conditions: [
        { kind: "measurement", name: "your temperature", operation: "gt", value: 38, unit: "C" },
        { kind: "state", name: history, expected: true, text: history }
      ] });
      expect(members[0].schedule?.recurrence?.countMax).toBeUndefined();
      expect(members[0].schedule?.recurrence?.courseLength).toBeUndefined();
      expect(members[0].schedule?.recurrence?.occurrenceCap).toEqual(capped ? { max: 2, period: 1, periodUnit: "d" } : undefined);
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toContain(history);
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(saved);
  });

  it.each([
    { partial: "If systolic BP is below 90,", predicate: {
      kind: "measurement", name: "systolic bp", operation: "lt", value: 90 } },
    { partial: "Only if SBP > 160 and heart rate < 90,", predicate: { kind: "all", conditions: [
      { kind: "measurement", name: "sbp", operation: "gt", value: 160 },
      { kind: "measurement", name: "heart rate", operation: "lt", value: 90 }
    ] } }
  ])("keeps an open guard useful before its consequent: $partial", ({ partial, predicate }) => {
    expect(parseMedicationGuard(partial)?.condition).toMatchObject(predicate);
    const incomplete = parsePublicSig(partial);
    expect(incomplete.fhirNext.renderedInstruction).toBe(partial);
    expect(incomplete.meta.canonical.clauses.every(clause => !clause.dose)).toBe(true);
    const source = partial + " take 1 tablet", complete = parsePublicSig(source);
    for (const input of [complete.meta.canonical.course!, complete.fhir, complete.fhirNext]) {
      const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(1);
      expect(members[0].amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(members[0].predicate).toMatchObject(predicate);
    }
    expect(complete.fhirNext.renderedInstruction).toBe(source);
  });

  it.each([
    "you have taken at most 2 doses in the past 24 hours",
    "you have vomited no more than twice in 24 hours",
    "you have taken no more than 2 doses in 24 hours",
    "you have taken no more than 2 tablets in 24 hours",
    "you have taken no more than 2 tablets within 24 hours"
  ])("retains a complete medication-history predicate without inventing treatment bounds: %s", condition => {
    const source = "Take 1 tablet only if " + condition;
    const parsed = parsePublicSig(source), before = JSON.stringify(parsed);
    for (const input of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
      const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(1);
      const member = members[0];
      expect(member.amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(member.predicate).toMatchObject({ kind: "state", name: condition, text: condition });
      expect(member.schedule?.recurrence?.countMax).toBeUndefined();
      expect(member.schedule?.recurrence?.courseLength).toBeUndefined();
      expect(member.schedule?.recurrence?.occurrenceCap).toBeUndefined();
      expect(member.limits).toBeUndefined();
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it.each([false, true])("keeps medication history separate from an independent treatment maximum (%s)", capped => {
    const condition = "you have taken no more than 2 tablets within 24 hours";
    const source = "Take 1 tablet every 6 hours only if " + condition +
      (capped ? ", maximum 2 tablets per day." : ".");
    const parsed = parsePublicSig(source), before = JSON.stringify(parsed);
    const expected = { kind: "state", name: condition, text: condition };
    const query = { from: "2026-12-01T00:00:00Z", orderedAt: "2026-12-01T00:00:00Z", timeZone: "UTC", limit: 4 };
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const saved = JSON.stringify(input), members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(1);
      const member = members[0];
      expect(member.amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(member.predicate).toMatchObject(expected);
      expect(member.schedule?.recurrence).toMatchObject({ period: 6, periodUnit: "h" });
      expect(member.schedule?.recurrence?.occurrenceCap).toBeUndefined();
      expect(member.schedule?.recurrence?.countMax).toBeUndefined();
      expect(member.schedule?.recurrence?.courseLength).toBeUndefined();
      if (capped) {
        expect(member.limits).toHaveLength(1);
        expect(member.limits?.[0]).toMatchObject({ scope: "period", amount: { value: 2, unit: "tab" },
          period: { value: 1, unit: "d" } });
      } else expect(member.limits).toBeUndefined();
      expect(nextDueDoses(input, { ...query, evaluateCondition: condition => {
        expect(condition).toMatchObject(expected); return true;
      } })).toEqual(capped ? [
        "2026-12-01T00:00:00+00:00", "2026-12-01T06:00:00+00:00",
        "2026-12-02T00:00:00+00:00", "2026-12-02T06:00:00+00:00"
      ] : ["2026-12-01T00:00:00+00:00", "2026-12-01T06:00:00+00:00",
        "2026-12-01T12:00:00+00:00", "2026-12-01T18:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 1, durationUnit: "d",
        evaluateCondition: () => true }).totalUnits).toBe(capped ? 2 : 4);
      let calls = 0;
      const reject = (condition: unknown) => { expect(condition).toMatchObject(expected); calls++; return false; };
      expect(nextDueDoses(input, { ...query, evaluateCondition: reject })).toEqual([]);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 1, durationUnit: "d",
        evaluateCondition: reject }).totalUnits).toBe(0);
      expect(calls).toBeGreaterThan(0);
      for (const locale of ["en", "th"] as const) {
        expect(formatSig(input, "long", { locale, realizationMode: "normalized" })).toContain(condition);
      }
      expect(JSON.stringify(input)).toBe(saved);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it.each([
    { suffix: "call the clinic if you have vomited no more than once in 24 hours.",
      condition: "if you have vomited no more than once in 24 hours", kind: "if" },
    { suffix: "when you have vomited no more than once in 24 hours, call the clinic.",
      condition: "when you have vomited no more than once in 24 hours", kind: "when" },
    { suffix: "call the clinic if you have taken no more than 1 tablet in 24 hours.",
      condition: "if you have taken no more than 1 tablet in 24 hours", kind: "if" }
  ])("keeps counseling history out of the medication ceiling: $suffix", ({ suffix, condition, kind }) => {
    const source = "When SBP > 160, take 1 tablet every 6 hours for 2 days, maximum 2 tablets/day; " + suffix;
    const parsed = parsePublicSig(source), before = JSON.stringify(parsed);
    const predicate = { kind: "measurement", name: "sbp", operation: "gt", value: 160 };
    const graph = parsed.meta.canonical.clauses[0].instructionGraph!;
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    expect(graph.actions.map(action => action.predicate.lemma)).toEqual(["call"]);
    expect(graph.relations).toContainEqual(expect.objectContaining({ kind, toActionIndex: 0,
      text: expect.stringContaining(condition) }));
    const query = { from: "2026-12-01T00:00:00Z", orderedAt: "2026-12-01T00:00:00Z", timeZone: "UTC", limit: 6 };
    for (const input of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
      const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(1);
      const member = members[0], recurrence = member.schedule?.recurrence;
      expect(member.amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(member.predicate).toMatchObject(predicate);
      expect(recurrence).toMatchObject({ period: 6, periodUnit: "h", courseLength: { value: 2 } });
      expect(recurrence?.courseLength?.code ?? recurrence?.courseLength?.unit).toBe("d");
      expect(recurrence?.occurrenceCap).toBeUndefined();
      expect(recurrence?.countMax).toBeUndefined();
      expect(member.asNeeded).not.toBe(true);
      expect(member.limits).toHaveLength(1);
      expect(member.limits?.[0]).toMatchObject({ scope: "period", amount: { value: 2, unit: "tab" },
        period: { value: 1, unit: "d" } });
      expect(nextDueDoses(input, { ...query, evaluateCondition: () => true })).toEqual([
        "2026-12-01T00:00:00+00:00", "2026-12-01T06:00:00+00:00",
        "2026-12-02T00:00:00+00:00", "2026-12-02T06:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 2, durationUnit: "d",
        evaluateCondition: () => true }).totalUnits).toBe(4);
      let rejectedCalls = 0;
      const reject = (condition: unknown) => {
        expect(condition).toMatchObject(predicate); rejectedCalls++; return false;
      };
      expect(nextDueDoses(input, { ...query, evaluateCondition: reject })).toEqual([]);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 2, durationUnit: "d",
        evaluateCondition: reject }).totalUnits).toBe(0);
      expect(rejectedCalls).toBeGreaterThan(0);
      for (const locale of ["en", "th"] as const) {
        const preview = formatSig(input, "long", { locale, realizationMode: "normalized" });
        expect(preview).toContain("SBP > 160");
        expect(preview.toLowerCase()).toContain(condition);
        expect(preview).toContain("2 tab / 1 d");
      }
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it("retains a separated occurrence cap beside the complete predicate", () => {
    const source = "Take 1 tablet only if you have taken at most 2 doses, maximum 4 doses per day";
    const parsed = parsePublicSig(source);
    for (const input of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
      const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(1);
      expect(members[0].predicate).toMatchObject({ kind: "state", name: "you have taken at most 2 doses" });
      expect(members[0].schedule?.recurrence).toMatchObject({ occurrenceCap: { max: 4, period: 1, periodUnit: "d" } });
      expect(members[0].schedule?.recurrence?.countMax).toBeUndefined();
      expect(members[0].amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it.each(["take 1 tablet and call the clinic.", "take 1 tablet daily for 2 days and call the clinic."])(
    "keeps the prefix blood-pressure guard on the dose before counseling: %s", directive => {
    const source = "If systolic BP is above 140, " + directive, parsed = parsePublicSig(source);
    const predicate = { kind: "measurement", name: "systolic bp", operation: "gt", value: 140 };
    const before = JSON.stringify(parsed);
    for (const input of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
      const course = importCanonicalCourse(input), members = course.stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(1);
      expect(members[0].amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(members[0].predicate).toMatchObject(predicate);
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }).toLowerCase())
        .toContain("call the clinic");
      if (directive.includes("daily")) {
        const query = { from: "2026-12-01T00:00:00Z", orderedAt: "2026-12-01T00:00:00Z", timeZone: "UTC", limit: 3 };
        let calls = 0;
        expect(nextDueDoses(input, { ...query, evaluateCondition: condition => {
          expect(condition).toMatchObject(predicate); calls++; return false;
        } })).toEqual([]);
        expect(calls).toBeGreaterThan(0);
        expect(nextDueDoses(input, { ...query, evaluateCondition: () => true })).toEqual([
          "2026-12-01T09:00:00+00:00", "2026-12-02T09:00:00+00:00"
        ]);
      }
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it("keeps independent conditional counseling beside a prefix medication guard", () => {
    const source = "If systolic BP is above 140, take 1 tablet at 08:00 daily for 2 days; call the clinic if dizzy.";
    const parsed = parsePublicSig(source), before = JSON.stringify(parsed);
    const predicate = { kind: "measurement", name: "systolic bp", operation: "gt", value: 140 };
    const graph = parsed.meta.canonical.clauses[0].instructionGraph!;
    expect(graph.actions.map(action => action.predicate.lemma)).toEqual(["call"]);
    expect(graph.relations).toContainEqual(expect.objectContaining({ kind: "if", toActionIndex: 0, text: "if dizzy" }));
    const query = { from: "2026-12-01T00:00:00Z", orderedAt: "2026-12-01T00:00:00Z", timeZone: "UTC", limit: 3 };
    for (const input of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
      const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(1);
      expect(members[0].amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(members[0].predicate).toMatchObject(predicate);
      expect(members[0].schedule?.recurrence).toMatchObject({ frequency: 1, period: 1, periodUnit: "d", clocks: ["08:00:00"] });
      expect(nextDueDoses(input, { ...query, evaluateCondition: condition => {
        expect(condition).toMatchObject(predicate);
        return false;
      } })).toEqual([]);
      expect(nextDueDoses(input, { ...query, evaluateCondition: () => true })).toEqual([
        "2026-12-01T08:00:00+00:00", "2026-12-02T08:00:00+00:00"
      ]);
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toContain("only if systolic bp > 140. Call the clinic if dizzy.");
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it.each([
    ["if it is a dialysis day, hold the morning dose", false, "if"],
    ["hold the morning dose if it is a dialysis day", false, "if"],
    ["if it is a dialysis day, hold the morning dose; call the clinic", true, "if"],
    ["when it is a dialysis day, hold the morning dose; call the clinic", true, "when"]
  ] as const)("keeps predicate activities inside the withholding antecedent: %s", (advice, independentCall, relation) => {
    const source = `Take 1 tablet at 08:00 daily for 2 days; ${advice}.`;
    const parsed = parsePublicSig(source), before = JSON.stringify(parsed);
    const predicate = { kind: "not", condition: { kind: "text", text: "it is a dialysis day" } };
    const clause = parsed.meta.canonical.clauses[0], graph = clause.instructionGraph!;
    expect(graph.actions.map(action => action.predicate.lemma)).toEqual(independentCall ? ["hold", "call"] : ["hold"]);
    expect(graph.relations).toContainEqual(expect.objectContaining({
      kind: relation, toActionIndex: 0, text: expect.stringContaining(`${relation} it is a dialysis day`)
    }));
    expect(clause.clinicalAdjuncts?.calendarDayCondition).toEqual(predicate);
    expect(clause.prn?.enabled).not.toBe(true);
    expect(graph.sourceText).toBe(source);
    const query = { from: "2026-12-01T00:00:00Z", orderedAt: "2026-12-01T00:00:00Z", timeZone: "UTC", limit: 3 };
    for (const input of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
      const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(1);
      expect(members[0].amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(members[0].predicate).toEqual(predicate);
      expect(members[0].calendarPredicate).toEqual(predicate);
      expect(members[0].schedule?.recurrence).toMatchObject({ frequency: 1, period: 1, periodUnit: "d", clocks: ["08:00:00"] });
      expect(nextDueDoses(input, { ...query, evaluateCondition: (condition, at) => {
        expect(condition).toEqual(predicate);
        return !at.startsWith("2026-12-01");
      } })).toEqual(["2026-12-02T08:00:00+00:00"]);
      expect(nextDueDoses(input, { ...query, evaluateCondition: () => true })).toEqual([
        "2026-12-01T08:00:00+00:00", "2026-12-02T08:00:00+00:00"
      ]);
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .not.toContain("dialysis day; then");
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it.each(["When", "If"])("keeps a registered conditional day predicate on the positive dose: %s", marker => {
    const source = `${marker} it is a dialysis day, take 1 tablet at 08:00 daily for 2 days; call the clinic.`;
    const parsed = parsePublicSig(source), before = JSON.stringify(parsed);
    const predicate = { kind: "text", text: "it is a dialysis day" };
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.instructionGraph?.actions.map(action => action.predicate.lemma)).toEqual(["call"]);
    expect(clause.clinicalAdjuncts?.condition).toEqual(predicate);
    expect(clause.clinicalAdjuncts?.calendarDayCondition).toEqual(predicate);
    expect(clause.prn?.enabled).not.toBe(true);
    const query = { from: "2026-12-01T00:00:00Z", orderedAt: "2026-12-01T00:00:00Z", timeZone: "UTC", limit: 3 };
    for (const input of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
      const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(1);
      expect(members[0].amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(members[0].predicate).toEqual(predicate);
      expect(members[0].calendarPredicate).toEqual(predicate);
      expect(members[0].schedule?.recurrence).toMatchObject({
        frequency: 1, period: 1, periodUnit: "d", clocks: ["08:00:00"],
        courseLength: input === parsed.meta.canonical.course
          ? { value: 2, unit: "d" }
          : { value: 2, unit: "days", system: "http://unitsofmeasure.org", code: "d" }
      });
      expect(nextDueDoses(input, { ...query, evaluateCondition: () => true })).toEqual([
        "2026-12-01T08:00:00+00:00", "2026-12-02T08:00:00+00:00"
      ]);
      let rejected = 0;
      expect(nextDueDoses(input, { ...query, evaluateCondition: condition => {
        expect(condition).toEqual(predicate); rejected += 1; return false;
      } })).toEqual([]);
      expect(rejected).toBeGreaterThan(0);
      expect(nextDueDoses(input, { ...query, evaluateCondition: (_condition, at) =>
        at.startsWith("2026-12-02") })).toEqual(["2026-12-02T08:00:00+00:00"]);
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe("Take 1 tablet orally once daily at 8:00 am for 2 days only if it is a dialysis day. Call the clinic.");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
        .toBe("รับประทานครั้งละ 1 เม็ด วันละครั้ง เวลา 08:00 เป็นเวลา 2 วัน เฉพาะเมื่อ it is a dialysis day. Call the clinic.");
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it.each([
    ["When", "prefix"], ["If", "prefix"], ["When", "postfix"], ["If", "postfix"]
  ] as const)("keeps a selected quantitative guard without an antecedent activity: %s %s", (marker, position) => {
    const source = position === "prefix"
      ? `${marker} SBP > 160, take 1 tablet at 08:00 daily for 2 days.`
      : `Take 1 tablet at 08:00 daily for 2 days ${marker.toLowerCase()} SBP > 160.`;
    const parsed = parsePublicSig(source), before = JSON.stringify(parsed);
    const predicate = { kind: "measurement", name: "sbp", operation: "gt", value: 160 };
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.instructionGraph?.actions ?? []).toEqual([]);
    expect(clause.instructionScopes).toBeUndefined();
    expect(clause.clinicalAdjuncts?.condition).toMatchObject(predicate);
    expect(clause.prn?.enabled).not.toBe(true);
    const query = { from: "2026-12-01T00:00:00Z", orderedAt: "2026-12-01T00:00:00Z", timeZone: "UTC", limit: 3 };
    for (const input of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
      const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(1);
      expect(members[0].amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(members[0].predicate).toMatchObject(predicate);
      expect(members[0].calendarPredicate).toBeUndefined();
      expect(members[0].schedule?.recurrence).toMatchObject({
        frequency: 1, period: 1, periodUnit: "d", clocks: ["08:00:00"],
        courseLength: input === parsed.meta.canonical.course
          ? { value: 2, unit: "d" }
          : { value: 2, unit: "days", system: "http://unitsofmeasure.org", code: "d" }
      });
      expect(nextDueDoses(input, { ...query, evaluateCondition: () => true })).toEqual([
        "2026-12-01T08:00:00+00:00", "2026-12-02T08:00:00+00:00"
      ]);
      let rejected = 0;
      expect(nextDueDoses(input, { ...query, evaluateCondition: condition => {
        expect(condition).toMatchObject(predicate); rejected += 1; return false;
      } })).toEqual([]);
      expect(rejected).toBeGreaterThan(0);
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe("Take 1 tablet orally once daily at 8:00 am for 2 days only if SBP > 160.");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
        .toBe("รับประทานครั้งละ 1 เม็ด วันละครั้ง เวลา 08:00 เป็นเวลา 2 วัน เฉพาะเมื่อ SBP > 160.");
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it("keeps a quantitative WHEN guard independent of matching later IF counseling", () => {
    const source = "When SBP > 160, take 1 tablet at 08:00 daily for 2 days; call the clinic if SBP > 160.";
    const parsed = parsePublicSig(source), before = JSON.stringify(parsed);
    const predicate = { kind: "measurement", name: "sbp", operation: "gt", value: 160 };
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.clinicalAdjuncts?.condition).toMatchObject(predicate);
    expect(clause.clinicalAdjuncts?.localRanges).toEqual([{ start: 0, end: source.indexOf(",") }]);
    expect(clause.prn?.enabled).not.toBe(true);
    expect(clause.instructionGraph?.actions.map(action => action.predicate.lemma)).toEqual(["call"]);
    expect(clause.instructionGraph?.relations).toContainEqual(expect.objectContaining({
      kind: "if", toActionIndex: 0, text: "if SBP > 160"
    }));
    const query = { from: "2026-12-01T00:00:00Z", orderedAt: "2026-12-01T00:00:00Z", timeZone: "UTC", limit: 3 };
    for (const input of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
      const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(1);
      expect(members[0].amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(members[0].predicate).toMatchObject(predicate);
      expect(members[0].schedule?.recurrence).toMatchObject({ frequency: 1, period: 1, periodUnit: "d", clocks: ["08:00:00"] });
      expect(nextDueDoses(input, { ...query, evaluateCondition: () => true })).toEqual([
        "2026-12-01T08:00:00+00:00", "2026-12-02T08:00:00+00:00"
      ]);
      let rejected = 0;
      expect(nextDueDoses(input, { ...query, evaluateCondition: condition => {
        expect(condition).toMatchObject(predicate); rejected += 1; return false;
      } })).toEqual([]);
      expect(rejected).toBeGreaterThan(0);
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe("Take 1 tablet orally once daily at 8:00 am for 2 days only if SBP > 160. Call the clinic if SBP > 160.");
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it("separates fallback condition words in Thai while preserving independent counseling and its medication guard", () => {
    const source = "Call the clinic if SBP > 160; when SBP > 160, take 1 tablet every 6 hours for 2 days, no more than 2 doses/day.";
    const parsed = parsePublicSig(source), before = structuredClone(parsed);
    const expected = [
      "2026-12-01T18:00:00+00:00", "2026-12-02T00:00:00+00:00", "2026-12-02T06:00:00+00:00",
      "2026-12-03T00:00:00+00:00", "2026-12-03T06:00:00+00:00"
    ];
    const query = { from: "2026-12-01T18:00:00Z", orderedAt: "2026-12-01T18:00:00Z", timeZone: "UTC", limit: 8 };
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const saved = structuredClone(input);
      const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(1);
      const member = members[0];
      expect(member.amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(member.predicate).toMatchObject({ kind: "measurement", name: "sbp", operation: "gt", value: 160 });
      expect(member.schedule?.recurrence).toMatchObject({ period: 6, periodUnit: "h",
        courseLength: { value: 2 }, occurrenceCap: { max: 2, period: 1, periodUnit: "d" } });
      expect(member.asNeeded).not.toBe(true);
      expect(member.limits).toBeUndefined();
      const graph = member.syntax?.instructionGraph;
      expect(graph?.actions.map(action => action.predicate.lemma)).toEqual(["call"]);
      expect(graph?.relations).toContainEqual(expect.objectContaining({ kind: "if", toActionIndex: 0, text: "if SBP > 160" }));
      expect(nextDueDoses(input, { ...query, evaluateCondition: () => true })).toEqual(expected);
      expect(nextDueDoses(input, { ...query, evaluateCondition: () => false })).toEqual([]);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 2, durationUnit: "d",
        evaluateCondition: () => true }).totalUnits).toBe(5);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 2, durationUnit: "d",
        evaluateCondition: () => false }).totalUnits).toBe(0);
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
        .toBe("Call the clinic if SBP > 160. รับประทานครั้งละ 1 เม็ด ทุก 6 ชั่วโมง เป็นเวลา 2 วัน ไม่เกิน 2 ครั้งต่อวัน เฉพาะเมื่อ SBP > 160.");
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe("Call the clinic if SBP > 160. Take 1 tablet orally every 6 hours for 2 days maximum 2 doses per day only if SBP > 160.");
      expect(input).toEqual(saved);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(parsed).toEqual(before);
  });

  it.each([
    ["Call the clinic if dizzy.", "Call the clinicถ้าเวียนศีรษะ."],
    ["Call the clinic if อาการ persists.", "Call the clinic if อาการ persists."]
  ])("preserves the realized condition boundary beside opaque fallback words: %s", (source, expected) => {
    const parsed = parsePublicSig(source);
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const saved = structuredClone(input);
      const course = importCanonicalCourse(input);
      expect(course.stages.flatMap(stage => stage.administrations).every(member => member.predicate === undefined)).toBe(true);
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" })).toBe(expected);
      expect(input).toEqual(saved);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it("keeps Hold unless ability as a positive permission beside independent counseling", () => {
    const source = "Take 1 tablet at 08:00 daily for 2 days; hold the morning dose unless you are able to swallow; call the clinic.";
    const parsed = parsePublicSig(source), before = JSON.stringify(parsed);
    const predicate = { kind: "state", name: "you are able to swallow", expected: true, text: "you are able to swallow" };
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    expect(parsed.meta.canonical.clauses[0].instructionGraph?.actions.map(action => action.predicate.lemma))
      .toEqual(["hold", "call"]);
    const query = { from: "2026-12-01T00:00:00Z", orderedAt: "2026-12-01T00:00:00Z", timeZone: "UTC", limit: 3 };
    for (const input of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
      const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(1);
      expect(members[0].amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(members[0].predicate).toEqual(predicate);
      expect(members[0].calendarPredicate).toBeUndefined();
      expect(members[0].schedule?.recurrence).toMatchObject({
        frequency: 1, period: 1, periodUnit: "d", clocks: ["08:00:00"],
        courseLength: input === parsed.meta.canonical.course
          ? { value: 2, unit: "d" }
          : { value: 2, unit: "days", system: "http://unitsofmeasure.org", code: "d" }
      });
      expect(nextDueDoses(input, { ...query, evaluateCondition: () => true })).toEqual([
        "2026-12-01T08:00:00+00:00", "2026-12-02T08:00:00+00:00"
      ]);
      let rejected = 0;
      expect(nextDueDoses(input, { ...query, evaluateCondition: condition => {
        expect(condition).toEqual(predicate); rejected += 1; return false;
      } })).toEqual([]);
      expect(rejected).toBeGreaterThan(0);
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toContain("Hold the morning dose unless you are able to swallow; call the clinic.");
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it("keeps an authored six-hour successor independent of a preceding daily clock", () => {
    const source = "Take 1 tablet daily at 08:00 for 7 days, then take 2 tablets every 6 hours";
    const parsed = parsePublicSig(source), before = JSON.stringify(parsed);
    const query = { from: "2026-12-08T00:00:00Z", orderedAt: "2026-12-01T00:00:00Z", timeZone: "UTC", limit: 4 };
    for (const input of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
      const course = importCanonicalCourse(input);
      expect(course.stages).toHaveLength(2);
      expect(course.stages[0].administrations[0].schedule?.recurrence?.clocks).toEqual(["08:00:00"]);
      const successor = course.stages[1].administrations[0];
      expect(successor.amounts?.[0].quantity).toMatchObject({ value: 2, unit: "tab" });
      expect(successor.schedule?.recurrence).toMatchObject({ period: 6, periodUnit: "h" });
      expect(successor.schedule?.recurrence?.clocks).toBeUndefined();
      expect(nextDueDoses(input, query)).toEqual(["2026-12-08T00:00:00+00:00", "2026-12-08T06:00:00+00:00",
        "2026-12-08T12:00:00+00:00", "2026-12-08T18:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage: input, ...query, from: query.orderedAt, durationValue: 8, durationUnit: "d" }))
        .toMatchObject({ totalUnits: 15, unit: "tab" });
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it.each([["daily", "08:00:00"], ["every 6 hours at 10:00", "10:00:00"]] as const)(
    "preserves compatible inheritance and the successor's own clock: %s", (cadence, clock) => {
    const source = "Take 1 tablet daily at 08:00 for 7 days, then take 2 tablets " + cadence;
    const parsed = parsePublicSig(source);
    for (const input of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
      expect(importCanonicalCourse(input).stages[1].administrations[0].schedule?.recurrence?.clocks).toEqual([clock]);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it("retains the next-morning onset of one before-breakfast administration", () => {
    const source = "Take 1 tablet once before breakfast the next morning", parsed = parsePublicSig(source);
    const query = { from: "2026-12-01T00:00:00Z", orderedAt: "2026-12-01T00:00:00Z",
      timeZone: "UTC", limit: 3, eventClock: { ACM: "07:30", MORN: "11:00" } };
    for (const input of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
      const course = importCanonicalCourse(input), member = course.stages[0].administrations[0];
      expect(course.stages[0].start).toMatchObject({ anchor: "treatment-day-start", displacement: { value: 1 } });
      expect(member.amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(member.schedule?.recurrence?.count).toBe(1);
      expect(member.schedule?.recurrence?.anchors).toContain("ACM");
      expect(member.phaseEnd).toBeUndefined();
      expect(nextDueDoses(input, query)).toEqual(["2026-12-02T07:30:00+00:00"]);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 3, durationUnit: "d" }))
        .toMatchObject({ totalUnits: 1, unit: "tab" });
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it("keeps an explicit next-morning course end unresolved without inventing an onset", () => {
    const source = "Take 1 tablet every 6 hours until breakfast the next morning", parsed = parsePublicSig(source);
    for (const input of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
      const course = importCanonicalCourse(input), member = course.stages[0].administrations[0];
      expect(course.stages[0].start).toBeUndefined();
      expect(member.onsetDays).toBeUndefined();
      expect(member.phaseEnd).toMatchObject({ anchor: "unresolved", description: "until breakfast the next morning" });
      expect(member.schedule?.recurrence).toMatchObject({ period: 6, periodUnit: "h" });
      expect(member.schedule?.recurrence?.anchors).toBeUndefined();
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it("keeps a separated occurrence cap beside a glucose threshold", () => {
    const source = "Take 1 tablet only if glucose is above 70, max twice in 24 hours";
    const parsed = parsePublicSig(source);
    for (const input of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
      const member = importCanonicalCourse(input).stages[0].administrations[0];
      expect(member.amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(member.predicate).toMatchObject({ kind: "measurement", name: "glucose", operation: "gt", value: 70 });
      expect(member.schedule?.recurrence?.occurrenceCap).toEqual({ max: 2, period: 24, periodUnit: "h" });
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it.each(["20mg/24h", "20 mg/24h", "20mg per 24 hours"])(
    "keeps a complete quantity cap separate from its PRN dose: %s", cap => {
    const source = "Take 5 mg as needed, max " + cap, parsed = parsePublicSig(source);
    const before = JSON.stringify(parsed);
    for (const input of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
      const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(1);
      expect(members[0].amounts?.[0].quantity).toMatchObject({ value: 5, unit: "mg" });
      expect(members[0].asNeeded).toBe(true);
      expect(members[0].limits).toMatchObject([{ scope: "period", amount: { value: 20, unit: "mg" }, period: { value: 24, unit: "h" } }]);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it("keeps a different quantified prohibition independent of the standing dose", () => {
    const source = "Take 1 tablet daily for 2 days; do not take 2 tablets if you miss a dose";
    const parsed = parsePublicSig(source), before = JSON.stringify(parsed);
    const query = { from: "2026-12-01T00:00:00Z", orderedAt: "2026-12-01T00:00:00Z", timeZone: "UTC", limit: 3 };
    for (const input of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
      const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(1);
      const member = members[0];
      expect(member.amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(member.predicate).toBeUndefined();
      expect(member.schedule?.recurrence).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
      let evaluated = 0;
      expect(nextDueDoses(input, { ...query, evaluateCondition: () => { evaluated++; return false; } })).toEqual([
        "2026-12-01T09:00:00+00:00", "2026-12-02T09:00:00+00:00"
      ]);
      expect(evaluated).toBe(0);
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toContain("Do not take 2 tablets if you miss a dose.");
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it.each(["rolling", "consecutive"])("executes the typed elapsed occurrence window: %s", window => {
    const limit = `maximum 2 doses per ${window} 24 hours`;
    const source = "Take 1 tablet every 6 hours for 2 days, " + limit;
    const parsed = parsePublicSig(source), before = JSON.stringify(parsed);
    const query = { from: "2026-12-01T18:00:00Z", orderedAt: "2026-12-01T18:00:00Z", timeZone: "UTC", limit: 5 };
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const inputBefore = JSON.stringify(input);
      const member = importCanonicalCourse(input).stages[0].administrations[0];
      expect(member.amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(member.schedule?.recurrence).toMatchObject({ period: 6, periodUnit: "h", courseLength: { value: 2 } });
      const duration = member.schedule?.recurrence?.courseLength;
      expect(duration?.code ?? duration?.unit).toBe("d");
      expect(member.schedule?.recurrence?.occurrenceCap).toEqual({ max: 2, period: 24, periodUnit: "h" });
      expect(member.schedule?.recurrence?.countMax).toBeUndefined();
      expect(nextDueDoses(input, query)).toEqual([
        "2026-12-01T18:00:00+00:00", "2026-12-02T00:00:00+00:00",
        "2026-12-02T18:00:00+00:00", "2026-12-03T00:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 2, durationUnit: "d" }))
        .toMatchObject({ totalUnits: 4, unit: "tab" });
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }).toLowerCase())
        .toContain("maximum 2 doses per 24 hours");
      expect(JSON.stringify(input)).toBe(inputBefore);
    }
    expect(parsed.input).toBe(source);
    expect(parsed.meta.canonical.clauses[0].rawText).toBe(source);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it("retains an elapsed occurrence ceiling without replacing it by civil buckets", () => {
    const source = "Take 1 tablet every 4 hours as needed for pain, maximum 1 dose within 6 hours";
    const parsed = parsePublicSig(source), before = JSON.stringify(parsed);
    const civil = parsePublicSig("Take 1 tablet every 4 hours as needed for pain, maximum 1 dose daily");
    const query = { from: "2026-12-01T00:00:00Z", orderedAt: "2026-12-01T00:00:00Z", timeZone: "UTC",
      limit: 4, evaluateCondition: () => true };
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const inputBefore = JSON.stringify(input);
      const member = importCanonicalCourse(input).stages[0].administrations[0];
      expect(member.amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(member.asNeeded).toBe(true);
      expect(member.schedule?.recurrence).toMatchObject({ period: 4, periodUnit: "h" });
      expect(member.schedule?.recurrence?.occurrenceCap).toEqual({ max: 1, period: 6, periodUnit: "h" });
      expect(member.schedule?.recurrence?.countMax).toBeUndefined();
      expect(member.schedule?.recurrence?.courseLength).toBeUndefined();
      expect(nextDueDoses(input, query)).toEqual([
        "2026-12-01T00:00:00+00:00", "2026-12-01T08:00:00+00:00",
        "2026-12-01T16:00:00+00:00", "2026-12-02T00:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 1, durationUnit: "d" }))
        .toMatchObject({ totalUnits: 3, unit: "tab", quantityKind: "maximum" });
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }).toLowerCase())
        .toContain("per 6 hours");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
        .toContain("ไม่เกิน 1 ครั้งต่อ6 ชั่วโมง");
      expect(JSON.stringify(input)).toBe(inputBefore);
    }
    for (const input of [civil.meta.canonical.course!, civil.fhir, civil.fhirNext]) {
      expect(importCanonicalCourse(input).stages[0].administrations[0].schedule?.recurrence?.occurrenceCap)
        .toEqual({ max: 1, period: 1, periodUnit: "d" });
      expect(nextDueDoses(input, { ...query, limit: 2 })).toEqual([
        "2026-12-01T00:00:00+00:00", "2026-12-02T00:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 1, durationUnit: "d" }))
        .toMatchObject({ totalUnits: 1, unit: "tab", quantityKind: "maximum" });
    }
    expect(parsed.input).toBe(source);
    expect(parsed.meta.canonical.clauses[0].rawText).toBe(source);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it("keeps a supported elapsed quantity ceiling on the same period constituent", () => {
    const source = "Take 1 tablet every 4 hours for 2 days, maximum 1 tablet within 6 hours";
    const parsed = parsePublicSig(source), before = JSON.stringify(parsed);
    const query = { from: "2026-12-01T00:00:00Z", orderedAt: "2026-12-01T00:00:00Z", timeZone: "UTC", limit: 8 };
    for (const input of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
      const member = importCanonicalCourse(input).stages[0].administrations[0];
      expect(member.amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(member.limits).toHaveLength(1);
      expect(member.limits?.[0]).toMatchObject({ scope: "period", amount: { value: 1, unit: "tab" },
        period: { value: 6, unit: "h" } });
      expect(member.schedule?.recurrence?.occurrenceCap).toBeUndefined();
      expect(nextDueDoses(input, query)).toEqual([
        "2026-12-01T00:00:00+00:00", "2026-12-01T08:00:00+00:00", "2026-12-01T16:00:00+00:00",
        "2026-12-02T00:00:00+00:00", "2026-12-02T08:00:00+00:00", "2026-12-02T16:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 2, durationUnit: "d" }).totalUnits).toBe(6);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it("keeps the civil occurrence cap executable", () => {
    const source = "Take 1 tablet every 6 hours for 2 days, maximum 2 doses per day";
    const parsed = parsePublicSig(source);
    const query = { from: "2026-12-01T00:00:00Z", orderedAt: "2026-12-01T00:00:00Z", timeZone: "UTC", limit: 5 };
    for (const input of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
      expect(importCanonicalCourse(input).stages[0].administrations[0].schedule?.recurrence?.occurrenceCap)
        .toEqual({ max: 2, period: 1, periodUnit: "d" });
      expect(nextDueDoses(input, query)).toEqual(["2026-12-01T00:00:00+00:00", "2026-12-01T06:00:00+00:00",
        "2026-12-02T00:00:00+00:00", "2026-12-02T06:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 2, durationUnit: "d" }))
        .toMatchObject({ totalUnits: 4, unit: "tab" });
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it("uses the explicit clock as the early-morning administration", () => {
    const source = "Take 1 tablet early morning at 06:30 for 2 days", parsed = parsePublicSig(source);
    const query = { from: "2026-12-01T00:00:00Z", orderedAt: "2026-12-01T00:00:00Z", timeZone: "UTC", limit: 5,
      eventClock: { "MORN.early": "05:00" } };
    for (const input of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
      const member = importCanonicalCourse(input).stages[0].administrations[0];
      expect(member.amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(member.schedule?.recurrence?.clocks).toEqual(["06:30:00"]);
      expect(member.schedule?.recurrence?.anchors).toBeUndefined();
      expect(nextDueDoses(input, query)).toEqual(["2026-12-01T06:30:00+00:00", "2026-12-02T06:30:00+00:00"]);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it("keeps the qualified early-morning predecessor finite before NEXT", () => {
    const source = "Take 1 tablet early morning at 06:30, then take 2 tablets at 07:00 the next morning";
    const parsed = parsePublicSig(source);
    const query = { from: "2026-12-01T00:00:00Z", orderedAt: "2026-12-01T00:00:00Z", timeZone: "UTC", limit: 5,
      eventClock: { "MORN.early": "05:00", MORN: "09:00" } };
    for (const input of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
      const course = importCanonicalCourse(input);
      expect(course.stages).toHaveLength(2);
      expect(course.stages[0].administrations[0].amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(course.stages[1].administrations[0].amounts?.[0].quantity).toMatchObject({ value: 2, unit: "tab" });
      expect(nextDueDoses(input, query)).toEqual(["2026-12-01T06:30:00+00:00", "2026-12-02T07:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 3, durationUnit: "d" }))
        .toMatchObject({ totalUnits: 3, unit: "tab" });
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });
});


describe("sequential temporal ownership", () => {
  const query = {
    orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-01T00:00:00Z",
    timeZone: "UTC", limit: 8
  };

  it.each([
    ["in 2 hours 200 mL", true],
    ["after 2 hours 200 mL", true],
    ["200 mL in 2 hours", false]
  ] as const)("keeps a leading interval separate from inherited infusion run time: %s", (tail, delayed) => {
    const source = "Infuse 100 mL over 30 minutes, then " + tail;
    const parsed = parsePublicSig(source);
    const before = JSON.stringify(parsed);
    expect(parsed.meta.canonical.clauses[1].schedule?.administrationOffsetMinutes).toBe(delayed ? 120 : undefined);
    expect(parsed.meta.canonical.clauses[1].schedule?.administrationDuration).toBe(delayed ? undefined : 120);
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const stages = importCanonicalCourse(input).stages;
      expect(stages).toHaveLength(2);
      const first = stages[0].administrations[0];
      const second = stages[1].administrations[0];
      expect(first.amounts?.[0].quantity).toMatchObject({ value: 100, unit: "mL" });
      expect(first.schedule?.recurrence).toMatchObject({ occurrenceDuration: 30, occurrenceDurationUnit: "min" });
      expect(second.amounts?.[0].quantity).toMatchObject({ value: 200, unit: "mL" });
      expect(second.delayMinutes).toBe(delayed ? 120 : undefined);
      expect(second.schedule?.recurrence?.occurrenceDuration).toBe(delayed ? undefined : 120);
      expect(nextDueDoses(input, query)).toEqual([
        "2026-12-01T00:00:00+00:00",
        delayed ? "2026-12-01T02:30:00+00:00" : "2026-12-01T00:30:00+00:00"
      ]);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it.each([
    ["daily at the same time for 2 days", true],
    ["from day 32 for 1 month", false]
  ] as const)("keeps cadence selectors separate from a donated clock: %s", (tail, localDaily) => {
    const source = "Take 1 tablet at 09:00 on days 1 and 15 of each month for 1 month, then take 2 tablets " + tail;
    const parsed = parsePublicSig(source);
    const before = JSON.stringify(parsed);
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const stages = importCanonicalCourse(input).stages;
      expect(stages).toHaveLength(2);
      expect(stages[0].administrations[0].amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      const second = stages[1].administrations[0];
      expect(second.amounts?.[0].quantity).toMatchObject({ value: 2, unit: "tab" });
      const recurrence = second.schedule?.recurrence;
      expect(recurrence?.clocks).toEqual(["09:00:00"]);
      expect(recurrence?.monthDays).toEqual(localDaily ? undefined : [1, 15]);
      if (localDaily) expect(recurrence).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
      expect(nextDueDoses(input, query)).toEqual([
        "2026-12-01T09:00:00+00:00", "2026-12-15T09:00:00+00:00",
        "2027-01-01T09:00:00+00:00",
        localDaily ? "2027-01-02T09:00:00+00:00" : "2027-01-15T09:00:00+00:00"
      ]);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it.each([
    ["daily", true],
    ["daily at the same time", true],
    ["at 08:00 daily", false]
  ] as const)("keeps an inherited meal event and its offset together: %s", (tail, inherited) => {
    const source = "Take 1 tablet daily 30 minutes before dinner for 2 days, then take 2 tablets " + tail + " for 2 days";
    const parsed = parsePublicSig(source);
    const before = JSON.stringify(parsed);
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const stages = importCanonicalCourse(input).stages;
      expect(stages).toHaveLength(2);
      const second = stages[1].administrations[0];
      expect(second.amounts?.[0].quantity).toMatchObject({ value: 2, unit: "tab" });
      const recurrence = second.schedule?.recurrence;
      expect(recurrence).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
      expect(recurrence?.anchors).toEqual(inherited ? ["ACV"] : undefined);
      expect(recurrence?.offset).toBe(inherited ? 30 : undefined);
      expect(recurrence?.clocks).toEqual(inherited ? undefined : ["08:00:00"]);
      expect(nextDueDoses(input, { ...query, eventClock: { CV: "18:00" } })).toEqual([
        "2026-12-01T17:30:00+00:00", "2026-12-02T17:30:00+00:00",
        inherited ? "2026-12-03T17:30:00+00:00" : "2026-12-03T08:00:00+00:00",
        inherited ? "2026-12-04T17:30:00+00:00" : "2026-12-04T08:00:00+00:00"
      ]);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });
});


describe("quantified withholding target ownership", () => {
  const query = { from: "2026-12-07T00:00:00Z", orderedAt: "2026-12-07T00:00:00Z", timeZone: "UTC", limit: 10 };
  const standing = "Take 5 mL at 08:00 and 10 mL at 20:00 daily for 2 days";
  const allTimes = ["2026-12-07T08:00:00+00:00", "2026-12-07T20:00:00+00:00",
    "2026-12-08T08:00:00+00:00", "2026-12-08T20:00:00+00:00"];

  it.each([
    [". If dizzy, do not take 5 mL, and do not take 10 mL.", [true, true], false],
    [". If dizzy, do not take 5 mL.", [true, false], false],
    ["; if dizzy, do not take 5 mL.", [true, false], false],
    [". If dizzy, do not take 5 mL, and do not take 15 mL.", [true, false], false],
    [". If dizzy, do not take 5 mL at 20:00, and do not take 10 mL at 08:00.", [false, false], false],
    [". If dizzy, do not take the 5-mL evening dose, and do not take the 10-mL morning dose.", [false, false], false],
    [". If it is a dialysis day, do not take 5 mL.", [true, false], true]
  ] as const)("keeps each prohibited amount paired with its own timing: %s", (tail, guarded, calendar) => {
    const source = standing + tail, parsed = parsePublicSig(source), before = JSON.stringify(parsed);
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(2);
      for (let index = 0; index < members.length; index++) {
        const member = members[index];
        expect(member.amounts?.[0].quantity).toMatchObject({ value: index ? 10 : 5, unit: "mL" });
        expect(member.schedule?.recurrence?.clocks).toEqual([index ? "20:00:00" : "08:00:00"]);
        const courseLength = member.schedule?.recurrence?.courseLength;
        expect(courseLength?.value).toBe(2);
        expect(courseLength?.code ?? courseLength?.unit).toBe("d");
        if (guarded[index]) expect(member.predicate).toMatchObject({ kind: "not", condition: calendar
          ? { kind: "text", text: "it is a dialysis day" }
          : { kind: "state", name: "dizzy", expected: true } });
        else expect(member.predicate).toBeUndefined();
        expect(member.calendarPredicate).toEqual(calendar && guarded[index] ? member.predicate : undefined);
      }
      expect(nextDueDoses(input, { ...query, evaluateCondition: () => true })).toEqual(allTimes);
      const remaining = allTimes.filter((_, index) => !guarded[index % 2]);
      expect(nextDueDoses(input, { ...query, evaluateCondition: () => false })).toEqual(remaining);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 2, durationUnit: "d",
        evaluateCondition: () => false })).toMatchObject({ totalUnits: (guarded[0] ? 0 : 10) + (guarded[1] ? 0 : 20), unit: "mL" });
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 2, durationUnit: "d",
        evaluateCondition: () => true })).toMatchObject({ totalUnits: 30, unit: "mL" });
      // Crossed targets must not erase a standing course bound after day two.
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 7, durationUnit: "d",
        evaluateCondition: () => true })).toMatchObject({ totalUnits: 30, unit: "mL" });
      const graph = members.flatMap(member => member.syntax?.instructionGraph ? [member.syntax.instructionGraph] : []).pop();
      expect(graph).toBeDefined();
      for (let action = 0; action < (graph?.actions.length ?? 0); action++) {
        if (graph!.actions[action].polarity !== "negate") continue;
        expect(graph!.relations?.some(relation => relation.kind === "if" && relation.toActionIndex === action)).toBe(true);
      }
      const english = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      if (tail.startsWith(";")) {
        for (const member of members) {
          const inheritedGraph = member.syntax?.instructionGraph;
          expect(inheritedGraph?.actions).toHaveLength(1);
          expect(inheritedGraph?.actions[0]).toMatchObject({
            polarity: "negate", predicate: { lemma: "take" }
          });
          expect(inheritedGraph?.relations).toContainEqual(expect.objectContaining({
            kind: "if", toActionIndex: 0, text: "if dizzy,"
          }));
          // The selected quantity owns the noun once; no duplicate opaque Object.
          expect(inheritedGraph?.actions[0].args).toEqual([expect.objectContaining({
            role: "amount", quantity: { value: 5, unit: "mL" }
          })]);
          expect(inheritedGraph?.primaryOwnership?.administrationActionIndex).toBeUndefined();
        }
        const thai = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
        expect(thai.match(/ถ้าเวียนศีรษะห้ามรับประทาน 5 มิลลิลิตร/gu)).toHaveLength(2);
        expect(thai).not.toContain("ห้ามรับประทาน 5 mL และ 5 mL");
        const first = { kind: "course" as const, stages: [{ administrations: [members[0]] }] };
        for (const locale of ["en", "th"]) for (const realizationMode of ["roundtrip", "normalized"] as const) {
          const single = formatSig(first, "long", { locale, realizationMode });
          expect(single).toContain(locale === "en" ? "If dizzy, do not take 5 mL" : "ถ้าเวียนศีรษะห้ามรับประทาน 5 มิลลิลิตร");
          expect(single).not.toMatch(/10 (?:mL|มิลลิลิตร)/u);
        }
      }
      if (tail.includes(", and")) {
        expect(english).toMatch(/If dizzy, do not take[^;]+; If dizzy, do not take/u);
        expect(english).not.toContain("then do not take");
      }
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it("keeps a shared conditional warning without replaying a sibling's dose", () => {
    const source = "5 mL at 08:00 and 10 mL at 20:00 daily for 2 days; if dizzy, do not take 5 mL.";
    const parsed = parsePublicSig(source), before = JSON.stringify(parsed);
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const members = importCanonicalCourse(input).stages[0].administrations;
      expect(members.map(member => member.amounts?.[0].quantity?.value)).toEqual([5, 10]);
      expect(nextDueDoses(input, { ...query, evaluateCondition: () => false })).toEqual([
        "2026-12-07T20:00:00+00:00", "2026-12-08T20:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 7, durationUnit: "d",
        evaluateCondition: () => false })).toMatchObject({ totalUnits: 20, unit: "mL" });
      const first = { kind: "course" as const, stages: [{ administrations: [members[0]] }] };
      for (const locale of ["en", "th"]) for (const realizationMode of ["roundtrip", "normalized"] as const) {
        const rendered = formatSig(first, "long", { locale, realizationMode });
        expect(rendered).toContain(locale === "en" ? "If dizzy, do not take 5 mL" : "ถ้าเวียนศีรษะห้ามรับประทาน 5 มิลลิลิตร");
        expect(rendered).not.toMatch(/10 (?:mL|มิลลิลิตร)/u);
      }
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it.each([
    [2, false, false, [7, 8, 9, 10, 11, 12, 13]],
    [1, false, false, [8, 9, 10, 11, 12, 13]],
    [2, true, false, [7, 8, 9, 10, 11, 12]],
    [2, false, true, [7, 8, 9, 10, 11, 12, 13]]
  ] as const)("retains the calendar on its quantified warning (%s, independent exclusion %s, guard %s)",
    (amount, excludedSunday, guarded, days) => {
      const source = "Take 1 tablet every morning for 7 days" +
        (excludedSunday ? " except Sunday" : guarded ? " if SBP > 160" : "") +
        ". On Mondays, do not take the " + amount + "-tablet morning dose.";
      const parsed = parsePublicSig(source), before = JSON.stringify(parsed);
      for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
        JSON.parse(JSON.stringify(parsed.fhirNext))]) {
        const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
        expect(members).toHaveLength(1);
        const member = members[0];
        expect(member.amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
        expect(member.predicate?.kind).toBe(guarded ? "measurement" : undefined);
        const expected = days.map(day => `2026-12-${String(day).padStart(2, "0")}T08:00:00+00:00`);
        expect(nextDueDoses(input, { ...query, evaluateCondition: () => true })).toEqual(expected);
        expect(nextDueDoses(input, { ...query, evaluateCondition: () => false })).toEqual(guarded ? [] : expected);
        expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 7, durationUnit: "d",
          evaluateCondition: () => true })).toMatchObject({ totalUnits: days.length, unit: "tab" });
        const warning = member.syntax?.instructionGraph?.actions.find(action => action.polarity === "negate");
        expect(warning?.args.some(argument => argument.role === "amount" && argument.quantity?.value === amount &&
          argument.quantity.unit === "tab")).toBe(true);
        expect(warning?.args.some(argument => argument.role === "time" && argument.relation === "on" &&
          argument.text === "Mondays")).toBe(true);
        const english = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
        expect(english).toContain("On Mondays, do not take the " + amount + "-tablet morning dose");
        if (amount === 2 && !excludedSunday) expect(english).not.toContain("except Monday");
      }
      expect(parsed.fhirNext.renderedInstruction).toBe(source);
      expect(JSON.stringify(parsed)).toBe(before);
    });
});


describe("registered withholding calendar and maximum constituents", () => {
  it("uses canonical weekday and attached-amount lexemes without rewriting source", () => {
    const original = getMedicationLexerLocalePack("en");
    let weekdayHits = 0, amountHits = 0;
    registerMedicationLexerLocalePack({
      locale: "en",
      apply: (tokens, input) => (original?.apply(tokens, input) ?? tokens).map((token, index) => {
        if (token.lower === "zonaday") {
          weekdayHits++;
          return { ...token, index, canonical: "monday" };
        }
        if (token.lower === "cliniccap") {
          amountHits++;
          return { ...token, index, canonical: ".5ml" };
        }
        return { ...token, index };
      })
    });
    try {
      const query = { from: "2026-12-07T00:00:00Z", orderedAt: "2026-12-07T00:00:00Z", timeZone: "UTC", limit: 10 };
      const sources = [
        "Take 1 tablet daily on zonaday for 7 days",
        "Take 1 tablet every morning for 7 days. On zonaday, do not take the 1-tablet morning dose.",
        "Take 1 tablet every morning for 7 days. Do not take the 1-tablet morning dose on zonaday.",
        "Take 1 tablet every morning for 7 days. Do not take the 2-tablet morning dose on zonaday."
      ];
      for (let index = 0; index < sources.length; index++) {
        const source = sources[index], parsed = parsePublicSig(source), before = JSON.stringify(parsed);
        const expected = index === 0 ? ["2026-12-07T09:00:00+00:00"] :
          (index === 3 ? [7, 8, 9, 10, 11, 12, 13] : [8, 9, 10, 11, 12, 13])
            .map(day => `2026-12-${String(day).padStart(2, "0")}T08:00:00+00:00`);
        for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
          JSON.parse(JSON.stringify(parsed.fhirNext))]) {
          const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
          expect(members).toHaveLength(1);
          expect(members[0].amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
          expect(nextDueDoses(input, query)).toEqual(expected);
          expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 7, durationUnit: "d" }))
            .toMatchObject({ totalUnits: expected.length, unit: "tab" });
          if (index) {
            const warning = members[0].syntax?.instructionGraph?.actions.find(action => action.polarity === "negate");
            expect(warning?.args).toEqual(expect.arrayContaining([
              expect.objectContaining({ role: "time", relation: "on", text: "zonaday" })
            ]));
            const english = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
            expect(english).toContain("zonaday");
            if (index === 3) {
              expect(english).toContain("Do not take the 2-tablet morning dose on zonaday");
              expect(english).not.toContain("dose in the morning");
            }
          }
        }
        expect(parsed.fhirNext.renderedInstruction).toBe(source);
        expect(JSON.stringify(parsed)).toBe(before);
      }
      const source = "Take 0.25 mL every 6 hours, max cliniccap per day";
      const parsed = parsePublicSig(source), before = JSON.stringify(parsed);
      for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
        JSON.parse(JSON.stringify(parsed.fhirNext))]) {
        const member = importCanonicalCourse(input).stages[0].administrations[0];
        expect(member.amounts?.[0].quantity).toMatchObject({ value: 0.25, unit: "mL" });
        expect(member.limits).toEqual(expect.arrayContaining([expect.objectContaining({
          scope: "period", amount: expect.objectContaining({ value: 0.5, unit: "mL" }),
          period: expect.objectContaining({ value: 1 })
        })]));
        expect(member.limits?.[0].period?.code ?? member.limits?.[0].period?.unit).toBe("d");
        expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 1, durationUnit: "d" }))
          .toMatchObject({ totalUnits: 0.5, unit: "mL" });
      }
      expect(parsed.fhirNext.renderedInstruction).toBe(source);
      expect(JSON.stringify(parsed)).toBe(before);
      expect(weekdayHits).toBeGreaterThan(0);
      expect(amountHits).toBeGreaterThan(0);
    } finally {
      registerMedicationLexerLocalePack(original ?? {
        locale: "en", apply: tokens => tokens.map((token, index) => ({ ...token, index }))
      });
    }
  });
});


describe("withholding target identity", () => {
  it.each([
    ["Skip the drops in the left eye on Mondays. Skip the drops in the right eye on Fridays.", ["fri"], ["mon"]],
    ["Skip the drops in the right eye on Fridays. Skip the drops in the left eye on Mondays.", ["fri"], ["mon"]],
    ["Skip the drops in the left eye on Mondays. Skip the drops in the left eye on Fridays.", [], ["mon", "fri"]],
    ["Skip the drops in the left eye on Mondays. Skip the drops in the left eye on Mondays.", [], ["mon"]]
  ] as const)("composes independent site weekday targets without crossing them: %s", (advice, rightDays, leftDays) => {
    const source = "Instill 1 drop in the right eye at 08:00 and 1 drop in the left eye at 20:00 daily for 7 days. " + advice;
    const parsed = parsePublicSig(source), before = JSON.stringify(parsed);
    const query = { from: "2026-11-23T00:00:00Z", orderedAt: "2026-11-23T00:00:00Z", timeZone: "UTC", limit: 20 };
    const all = [
      "2026-11-23T08:00:00+00:00", "2026-11-23T20:00:00+00:00",
      "2026-11-24T08:00:00+00:00", "2026-11-24T20:00:00+00:00",
      "2026-11-25T08:00:00+00:00", "2026-11-25T20:00:00+00:00",
      "2026-11-26T08:00:00+00:00", "2026-11-26T20:00:00+00:00",
      "2026-11-27T08:00:00+00:00", "2026-11-27T20:00:00+00:00",
      "2026-11-28T08:00:00+00:00", "2026-11-28T20:00:00+00:00",
      "2026-11-29T08:00:00+00:00", "2026-11-29T20:00:00+00:00"
    ];
    // Monday evening is always withheld; Friday belongs only to its named eye.
    const omitted = [all[1], ...(rightDays.length ? [all[8]] : leftDays.length === 2 ? [all[9]] : [])];
    const expected = all.filter(at => omitted.indexOf(at) === -1);
    const currentSign = parseClauseSign(parsed.meta.canonical.clauses[1].rawText);
    const target = currentSign?.synsem.cont.clinicalAdjunct?.conditionTarget;
    if (advice.endsWith("Mondays. Skip the drops in the left eye on Mondays.")) {
      expect(target?.members).toBeUndefined();
      expect(target?.excludedWeekdays).toEqual(["mon"]);
    } else {
      expect(target?.members).toHaveLength(2);
      expect(target?.members?.every(member => !member.members)).toBe(true);
    }
    const previews = {
      en: formatSig(parsed.meta.canonical.course!, "long", { locale: "en", realizationMode: "normalized" }),
      th: formatSig(parsed.meta.canonical.course!, "long", { locale: "th", realizationMode: "normalized" })
    };
    expect(previews.en.match(/withhold\b/gi)).toHaveLength(2);
    expect(previews.th.match(/Skip the drops/g)).toHaveLength(2);
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const inputBefore = JSON.stringify(input);
      for (const locale of ["en", "th"] as const) {
        expect(formatSig(input, "long", { locale, realizationMode: "normalized" })).toBe(previews[locale]);
      }
      const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(2);
      expect(members.map(member => member.target?.coding?.[0]?.code)).toEqual(["1290032005", "1290031003"]);
      expect(members.map(member => member.amounts?.[0].quantity)).toMatchObject([
        { value: 1, unit: "drop" }, { value: 1, unit: "drop" }
      ]);
      expect(members.map(member => member.schedule?.recurrence?.clocks)).toEqual([["08:00:00"], ["20:00:00"]]);
      expect(members[0].excludedWeekdays ?? []).toEqual(rightDays);
      expect((members[1].excludedWeekdays ?? []).slice().sort()).toEqual([...leftDays].sort());
      expect(members.some(member => member.predicate)).toBe(false);
      expect(nextDueDoses(input, query)).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 7, durationUnit: "d" }))
        .toMatchObject({ totalUnits: expected.length, unit: "drop" });
      const actions = members.flatMap(member => member.syntax?.instructionGraph?.actions ?? [])
        .filter(action => action.predicate.lemma === "withhold-administration");
      expect(actions).toHaveLength(2);
      expect(actions.map(action => action.sourceText + ".").join(" ")).toBe(advice);
      for (const action of actions) {
        expect(action.args.some(argument => argument.role === "site" && argument.coding?.code)).toBe(true);
        expect(action.args.some(argument => argument.role === "time" && argument.relation === "on")).toBe(true);
      }
      expect(JSON.stringify(input)).toBe(inputBefore);
    }
    expect(parsed.input).toBe(source);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it.each([". Skip", ", then skip"])("keeps mixed calendar holds and coded advice once in source order: %s", connector => {
    const source = "Instill 1 drop in the right eye at 08:00 and 1 drop in the left eye at 20:00 daily for 7 days. " +
      "Skip the drops in the left eye on Mondays" + connector +
      " the drops in the right eye on Fridays. May cause drowsiness.";
    const parsed = parsePublicSig(source), before = JSON.stringify(parsed);
    const query = { from: "2026-11-23T00:00:00Z", orderedAt: "2026-11-23T00:00:00Z", timeZone: "UTC", limit: 20 };
    const expected = [
      "2026-11-23T08:00:00+00:00",
      "2026-11-24T08:00:00+00:00", "2026-11-24T20:00:00+00:00",
      "2026-11-25T08:00:00+00:00", "2026-11-25T20:00:00+00:00",
      "2026-11-26T08:00:00+00:00", "2026-11-26T20:00:00+00:00",
      "2026-11-27T20:00:00+00:00",
      "2026-11-28T08:00:00+00:00", "2026-11-28T20:00:00+00:00",
      "2026-11-29T08:00:00+00:00", "2026-11-29T20:00:00+00:00"
    ];
    for (const [index, input] of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))].entries()) {
      const inputBefore = JSON.stringify(input), course = importCanonicalCourse(input);
      expect(nextDueDoses(input, query)).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 7, durationUnit: "d" }))
        .toMatchObject({ totalUnits: 12, unit: "drop" });
      const member = course.stages.flatMap(stage => stage.administrations)
        .find(value => value.syntax?.additionalInstructions?.length)!;
      expect(member.patientInstruction).toBe(source.slice(source.indexOf("Skip"), -1));
      expect(member.syntax?.instructionGraph?.relations).toContainEqual(expect.objectContaining({
        kind: "then", fromActionIndex: 0, toActionIndex: 1,
        text: connector === ". Skip" ? "." : ", then"
      }));
      for (const locale of ["en", "th"] as const) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" }).toLowerCase();
        const left = locale === "en" ? "withhold the drops in the left eye on monday" : "skip the drops in the left eye on mondays";
        const right = locale === "en" ? "withhold the drops in the right eye on friday" : "skip the drops in the right eye on fridays";
        const cause = locale === "en" ? "may cause drowsiness" : "อาจทำให้ง่วงซึม";
        expect(text.split(left)).toHaveLength(2);
        expect(text.split(right)).toHaveLength(2);
        expect(text.split(cause)).toHaveLength(2);
        expect(text.indexOf(left)).toBeLessThan(text.indexOf(right));
        expect(text.indexOf(right)).toBeLessThan(text.indexOf(cause));
      }
      if (index < 2) {
        expect(formatSig(input, "long", { locale: "en", realizationMode: "roundtrip" })).toBe(source);
      }
      expect(member.syntax?.instructionGraph?.sourceText).toContain(source.slice(source.indexOf("Skip")));
      const projected = projectCanonicalCourse(course);
      expect(projected.fhir.find(row => row.additionalInstruction?.length === 3)?.patientInstruction)
        .toBe(source.slice(source.indexOf("Skip"), -1));
      expect(projected.fhirNext.renderedInstruction).toBe(source);
      expect(projected.fhir.flatMap(row => row.additionalInstruction ?? []).map(row => row.text))
        .toEqual(["Skip the drops in the left eye on Mondays", connector === ". Skip" ? "Skip the drops in the right eye on Fridays" : "skip the drops in the right eye on Fridays", "May cause drowsiness"]);
      expect(JSON.stringify(input)).toBe(inputBefore);
    }
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it.each(["Do not drive.", "Do not drive if dizzy."])(
    "combines direct holds with the actually rendered graph warning: %s", warning => {
      const source = "Instill 1 drop in the right eye at 08:00 and 1 drop in the left eye at 20:00 daily for 7 days. " +
        "Skip the drops in the left eye on Mondays. Skip the drops in the right eye on Fridays. " + warning;
      const parsed = parsePublicSig(source), before = JSON.stringify(parsed);
      const query = { from: "2026-11-23T00:00:00Z", orderedAt: "2026-11-23T00:00:00Z", timeZone: "UTC", limit: 20 };
      const expected = [
        "2026-11-23T08:00:00+00:00",
        "2026-11-24T08:00:00+00:00", "2026-11-24T20:00:00+00:00",
        "2026-11-25T08:00:00+00:00", "2026-11-25T20:00:00+00:00",
        "2026-11-26T08:00:00+00:00", "2026-11-26T20:00:00+00:00",
        "2026-11-27T20:00:00+00:00",
        "2026-11-28T08:00:00+00:00", "2026-11-28T20:00:00+00:00",
        "2026-11-29T08:00:00+00:00", "2026-11-29T20:00:00+00:00"
      ];
      const patientInstruction = "Skip the drops in the left eye on Mondays. " +
        "Skip the drops in the right eye on Fridays. " + warning.slice(0, -1);
      for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
        JSON.parse(JSON.stringify(parsed.fhirNext))]) {
        const inputBefore = JSON.stringify(input), course = importCanonicalCourse(input);
        expect(nextDueDoses(input, query)).toEqual(expected);
        expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 7, durationUnit: "d" }))
          .toMatchObject({ totalUnits: 12, unit: "drop" });
        const member = course.stages.flatMap(stage => stage.administrations)
          .find(value => value.syntax?.additionalInstructions?.length)!;
        expect(member.patientInstruction).toBe(patientInstruction);
        expect(member.syntax?.instructionGraph?.actions[2]).toMatchObject({
          predicate: { lemma: "drive" }, polarity: "negate"
        });
        if (warning === "Do not drive if dizzy.") {
          expect(member.syntax?.instructionGraph?.relations).toContainEqual(expect.objectContaining({
            kind: "if", toActionIndex: 2, text: "if dizzy"
          }));
        }
        for (const locale of ["en", "th"] as const) {
          const text = formatSig(input, "long", { locale, realizationMode: "normalized" }).toLowerCase();
          const left = locale === "en" ? "withhold the drops in the left eye on monday" : "skip the drops in the left eye on mondays";
          const right = locale === "en" ? "withhold the drops in the right eye on friday" : "skip the drops in the right eye on fridays";
          const prohibition = locale === "en" ? "do not drive" : "ห้าม";
          expect(text.split(left)).toHaveLength(2);
          expect(text.split(right)).toHaveLength(2);
          expect(text.split(prohibition)).toHaveLength(2);
          expect(text.indexOf(left)).toBeLessThan(text.indexOf(right));
          expect(text.indexOf(right)).toBeLessThan(text.indexOf(prohibition));
          if (warning === "Do not drive if dizzy.") {
            expect(text).toContain(locale === "en" ? "do not drive if dizzy" : "ถ้าเวียนศีรษะ");
          }
        }
        const projected = projectCanonicalCourse(course);
        expect(projected.fhir.find(row => row.site?.coding?.some(coding =>
          coding.system === "http://snomed.info/sct" && coding.code === "1290031003"
        ))?.patientInstruction).toBe(patientInstruction);
        expect(projected.fhirNext.renderedInstruction).toBe(source);
        expect(JSON.stringify(input)).toBe(inputBefore);
      }
      expect(JSON.stringify(parsed)).toBe(before);
    }
  );

  it("retains both identical authored holds beside an independent coded warning", () => {
    const source = "Instill 1 drop in the right eye at 08:00 and 1 drop in the left eye at 20:00 daily for 7 days. " +
      "Skip the drops in the left eye on Mondays. Skip the drops in the left eye on Mondays. May cause drowsiness.";
    const parsed = parsePublicSig(source), before = JSON.stringify(parsed);
    const query = { from: "2026-11-23T00:00:00Z", orderedAt: "2026-11-23T00:00:00Z", timeZone: "UTC", limit: 20 };
    const expected = [
      "2026-11-23T08:00:00+00:00",
      "2026-11-24T08:00:00+00:00", "2026-11-24T20:00:00+00:00",
      "2026-11-25T08:00:00+00:00", "2026-11-25T20:00:00+00:00",
      "2026-11-26T08:00:00+00:00", "2026-11-26T20:00:00+00:00",
      "2026-11-27T08:00:00+00:00", "2026-11-27T20:00:00+00:00",
      "2026-11-28T08:00:00+00:00", "2026-11-28T20:00:00+00:00",
      "2026-11-29T08:00:00+00:00", "2026-11-29T20:00:00+00:00"
    ];
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const inputBefore = JSON.stringify(input), course = importCanonicalCourse(input);
      expect(nextDueDoses(input, query)).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 7, durationUnit: "d" }))
        .toMatchObject({ totalUnits: 13, unit: "drop" });
      const member = course.stages.flatMap(stage => stage.administrations)
        .find(value => value.syntax?.additionalInstructions?.length)!;
      const holds = member.syntax!.additionalInstructions!.flatMap(row => row.frames ?? [])
        .filter(frame => frame.predicate.lemma === "withhold-administration");
      expect(holds).toHaveLength(2);
      expect(holds[0].span.end).toBeLessThan(holds[1].span.start);
      expect(member.patientInstruction).toBe(source.slice(source.indexOf("Skip"), -1));
      for (const locale of ["en", "th"] as const) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" }).toLowerCase();
        const hold = locale === "en" ? "withhold the drops in the left eye on monday" : "skip the drops in the left eye on mondays";
        const cause = locale === "en" ? "may cause drowsiness" : "อาจทำให้ง่วงซึม";
        expect(text.split(hold)).toHaveLength(3);
        expect(text.split(cause)).toHaveLength(2);
        expect(text.lastIndexOf(hold)).toBeLessThan(text.indexOf(cause));
      }
      const projected = projectCanonicalCourse(course);
      expect(projected.fhir.flatMap(row => row.additionalInstruction ?? []).map(row => row.text))
        .toEqual(["Skip the drops in the left eye on Mondays", "Skip the drops in the left eye on Mondays", "May cause drowsiness"]);
      expect(projected.fhirNext.renderedInstruction).toBe(source);
      expect(JSON.stringify(input)).toBe(inputBefore);
    }
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it("retains complete current row occurrences and nested annotations through both wire forms", () => {
    const source = "Instill 1 drop in the right eye at 08:00 and 1 drop in the left eye at 20:00 daily for 7 days. " +
      "Skip the drops in the left eye on Mondays. Skip the drops in the left eye on Mondays.";
    const parsed = parsePublicSig(source);
    const graphUrl = "urn:ezmedicationinput:StructureDefinition:medication-instruction-graph";
    const rowNote = { url: "https://example.org/row-note", valueString: "current advice" };
    const coverageNote = { url: "https://example.org/coverage-note", valueString: "current coverage" };
    const textElement = { id: "owned-text", extension: [
      { url: "https://example.org/text-note", valueString: "text annotation" }
    ] };
    const labelCoding = [{ system: "urn:clinic:labels", display: "Selected calendar instruction",
      id: "label-id", _display: { id: "label-display" }, extension: [
        { url: "https://example.org/code-note", valueString: "nonsemantic coding annotation" }
      ] }];
    for (const input of [JSON.parse(JSON.stringify(parsed.fhir)), JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const rows = Array.isArray(input) ? input : input.step.flatMap((step: any) => step.component ?? []);
      const selectedRows = rows.flatMap((row: any) => row.additionalInstruction ?? []);
      expect(selectedRows).toHaveLength(2);
      const advice = selectedRows.find((row: any) =>
        parseInstructionGraphExtension(row.extension)?.actions[0].sequenceIndex === 0);
      expect(parseInstructionGraphExtension(advice.extension)?.actions[0]).toMatchObject({
        sequenceIndex: 0, span: { start: 50, end: 91 }
      });
      advice.id = "owned-row";
      advice._text = textElement;
      advice.coding = labelCoding;
      advice.extension.push(rowNote);
      const carrier = advice.extension.find((field: any) => field.url === graphUrl);
      expect(carrier.extension.map((field: any) => field.url)).toEqual(["action", "coverage"]);
      const coverage = carrier.extension.find((field: any) => field.url === "coverage");
      coverage.id = "owned-coverage";
      coverage.extension.push(coverageNote);
      coverage.extension.find((field: any) => field.url === "complete").id = "complete-annotation";
      const before = JSON.stringify(input);
      const projected = projectCanonicalCourse(importCanonicalCourse(input));
      for (const current of [projected.fhir, projected.fhirNext]) {
        const normalized = formatSig(current, "long", { locale: "en", realizationMode: "normalized" });
        expect(normalized.match(/withhold\b/gi)).toHaveLength(2);
        const rebuilt = projectCanonicalCourse(importCanonicalCourse(JSON.parse(JSON.stringify(current))));
        const rebuiltRows = rebuilt.fhir.flatMap(row => row.additionalInstruction ?? []);
        expect(rebuiltRows).toHaveLength(2);
        const occurrence0 = rebuiltRows.find(row =>
          parseInstructionGraphExtension(row.extension)?.actions[0].sequenceIndex === 0)!;
        const occurrence1 = rebuiltRows.find(row =>
          parseInstructionGraphExtension(row.extension)?.actions[0].sequenceIndex === 1)!;
        expect(parseInstructionGraphExtension(occurrence0.extension)?.actions[0]).toMatchObject({
          sequenceIndex: 0, span: { start: 50, end: 91 }
        });
        expect(parseInstructionGraphExtension(occurrence1.extension)?.actions[0]).toMatchObject({
          sequenceIndex: 1, span: { start: 93, end: 134 }
        });
        expect(rebuiltRows.map(row => row.text)).toEqual([
          "Skip the drops in the left eye on Mondays", "Skip the drops in the left eye on Mondays"
        ]);
        expect(occurrence0).toMatchObject({ id: "owned-row", _text: textElement, coding: labelCoding });
        expect(occurrence0.extension).toContainEqual(rowNote);
        const retained = occurrence0.extension?.find(field => field.url === graphUrl)?.extension
          ?.find(field => field.url === "coverage");
        expect(retained?.id).toBe("owned-coverage");
        expect(retained?.extension).toContainEqual(coverageNote);
        expect(retained?.extension?.find(field => field.url === "complete"))
          .toMatchObject({ id: "complete-annotation", valueBoolean: true });
        expect(occurrence1.id).toBeUndefined();
        expect(occurrence1._text).toBeUndefined();
        expect(occurrence1.coding).toBeUndefined();
        expect(occurrence1.extension).not.toContainEqual(rowNote);
        const independent = occurrence1.extension?.find(field => field.url === graphUrl)?.extension
          ?.find(field => field.url === "coverage");
        expect(independent?.id).toBeUndefined();
        expect(independent?.extension).not.toContainEqual(coverageNote);
        expect(independent?.extension?.find(field => field.url === "complete")?.id).toBeUndefined();
        expect(formatSig(rebuilt.fhirNext, "long", { locale: "th", realizationMode: "normalized" }))
          .toBe(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }));
      }
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it("flattens calendar target leaves while retaining scalar, duplicate and predicate boundaries", () => {
    const left: HpsgClinicalAdjunctFeature = {
      conditionTarget: { site: { text: "left eye" }, excludedWeekdays: [FhirDayOfWeek.Monday] },
      localRanges: [{ start: 0, end: 10 }],
      evidence: [{ rule: "calendar-target", kind: "calendar-exclusion", ranges: [{ start: 0, end: 10 }] }]
    };
    const right: HpsgClinicalAdjunctFeature = {
      conditionTarget: { site: { text: "right eye" }, excludedWeekdays: [FhirDayOfWeek.Friday] },
      localRanges: [{ start: 20, end: 30 }],
      evidence: [{ rule: "calendar-target", kind: "calendar-exclusion", ranges: [{ start: 20, end: 30 }] }]
    };
    const merge = (a: HpsgClinicalAdjunctFeature, b: HpsgClinicalAdjunctFeature) => unifySynsem(
      { head: {}, valence: {}, cont: { clinicalAdjunct: a } },
      { head: {}, valence: {}, cont: { clinicalAdjunct: b } },
      { normalizeSiteText: text => text, isCompatibleRouteRefinement: (a, b) => a === b }
    )?.cont.clinicalAdjunct;
    expect(merge(left, left)).toEqual(left);
    const composite = merge(left, right)!;
    expect(composite.conditionTarget).toEqual({ members: [left.conditionTarget, right.conditionTarget] });
    expect(merge(composite, left)).toEqual(composite);
    const nested = { ...left, conditionTarget: { members: [left.conditionTarget!, { members: [right.conditionTarget!] }] } };
    expect(merge(nested, right)?.conditionTarget).toEqual(composite.conditionTarget);
    const predicate = { kind: "state" as const, name: "dizzy", expected: true };
    expect(merge(left, { ...right, condition: predicate,
      conditionTarget: { site: right.conditionTarget!.site } })).toBeUndefined();
    expect(merge({ ...left, condition: predicate },
      { ...right, condition: { ...predicate, name: "nauseated" } })).toBeUndefined();
  });

  it.each([
    "Skip the drops in the left eye on Mondays.",
    "On Mondays skip the drops in the left eye."
  ])("binds a site-only weekday withholding target: %s", advice => {
    const source = "Instill 1 drop in the right eye at 08:00 and 1 drop in the left eye at 20:00 daily for 7 days. " + advice;
    const parsed = parsePublicSig(source), before = JSON.stringify(parsed);
    const query = { from: "2026-11-23T00:00:00Z", orderedAt: "2026-11-23T00:00:00Z", timeZone: "UTC", limit: 20 };
    const expected = [
      "2026-11-23T08:00:00+00:00",
      "2026-11-24T08:00:00+00:00", "2026-11-24T20:00:00+00:00",
      "2026-11-25T08:00:00+00:00", "2026-11-25T20:00:00+00:00",
      "2026-11-26T08:00:00+00:00", "2026-11-26T20:00:00+00:00",
      "2026-11-27T08:00:00+00:00", "2026-11-27T20:00:00+00:00",
      "2026-11-28T08:00:00+00:00", "2026-11-28T20:00:00+00:00",
      "2026-11-29T08:00:00+00:00", "2026-11-29T20:00:00+00:00"
    ];
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const inputBefore = JSON.stringify(input);
      const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(2);
      expect(members.map(member => member.target?.coding?.[0]?.code)).toEqual(["1290032005", "1290031003"]);
      expect(members.map(member => member.amounts?.[0].quantity)).toMatchObject([
        { value: 1, unit: "drop" }, { value: 1, unit: "drop" }
      ]);
      expect(members.map(member => member.schedule?.recurrence?.clocks)).toEqual([["08:00:00"], ["20:00:00"]]);
      expect(members[0].excludedWeekdays).toBeUndefined();
      expect(members[1].excludedWeekdays).toEqual(["mon"]);
      const warnings = members.flatMap(member => member.syntax?.instructionGraph?.actions ?? [])
        .filter(action => action.predicate.lemma === "withhold-administration");
      expect(warnings).toHaveLength(1);
      expect(warnings[0].args).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "site", coding: expect.objectContaining({ code: "1290031003" }) }),
        expect.objectContaining({ role: "time", relation: "on", text: expect.stringContaining("Mondays") })
      ]));
      expect(warnings[0].sourceText).toBe(advice.slice(0, -1));
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(en.match(/\b(?:skip|withhold)\b/gi)).toHaveLength(1);
      expect(en).toMatch(/(?:Skip the drops in the left eye on Mondays|On Mondays skip the drops in the left eye|Withhold the drops in the left eye on Monday)\.$/);
      expect(th.split(advice).length - 1).toBe(1);
      expect(nextDueDoses(input, query)).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 7, durationUnit: "d" }))
        .toMatchObject({ totalUnits: 13, unit: "drop" });
      expect(JSON.stringify(input)).toBe(inputBefore);
    }
    expect(parsed.input).toBe(source);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  const query = { from: "2026-12-01T00:00:00Z", orderedAt: "2026-12-01T00:00:00Z", timeZone: "UTC", limit: 8 };
  it.each([
    ["in the left eye", ["20:00:00"], 2],
    ["", ["08:00:00", "20:00:00"], 0]
  ] as const)("keeps a named site on its own conditional target: %s", (site, guardedClocks, expectedTotal) => {
    const source = "Instill 1 drop in the right eye at 08:00 and 1 drop in the left eye at 20:00 daily for 2 days. " +
      `If dizzy, do not instill 1 drop${site ? " " + site : ""}.`;
    const parsed = parsePublicSig(source), before = JSON.stringify(parsed);
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(2);
      expect(members.map(member => member.amounts?.[0].quantity)).toMatchObject([
        { value: 1, unit: "drop" }, { value: 1, unit: "drop" }
      ]);
      expect(members.map(member => member.target?.coding?.[0]?.code)).toEqual(["1290032005", "1290031003"]);
      expect(members.filter(member => member.predicate).flatMap(member => member.schedule?.recurrence?.clocks ?? []))
        .toEqual(guardedClocks);
      expect(nextDueDoses(input, { ...query, evaluateCondition: () => false })).toEqual(expectedTotal ?
        ["2026-12-01T08:00:00+00:00", "2026-12-02T08:00:00+00:00"] : []);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 2, durationUnit: "d", evaluateCondition: () => false }))
        .toMatchObject({ totalUnits: expectedTotal, unit: "drop" });
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 2, durationUnit: "d", evaluateCondition: () => true }))
        .toMatchObject({ totalUnits: 4, unit: "drop" });
      const warning = members.flatMap(member => member.syntax?.instructionGraph?.actions ?? [])
        .find(action => action.polarity === "negate");
      if (site) expect(warning?.args).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "site", coding: expect.objectContaining({ code: "1290031003" }) })
      ]));
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it.each([
    ["about ", "5-mL", true], ["", "5-mL", true],
    ["about ", "15-mL", false], ["about ", "5-mg", false]
  ] as const)("matches an unqualified target without replacing the standing dose: %s / %s", (qualifier, target, matches) => {
    const source = `Take ${qualifier}5 mL at 08:00 and 10 mL at 20:00 daily for 2 days. If dizzy, do not take the ${target} morning dose.`;
    const parsed = parsePublicSig(source), before = JSON.stringify(parsed);
    const all = ["2026-12-01T08:00:00+00:00", "2026-12-01T20:00:00+00:00",
      "2026-12-02T08:00:00+00:00", "2026-12-02T20:00:00+00:00"];
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(2);
      expect(members[0].amounts?.[0].quantity).toMatchObject({ value: 5, unit: "mL" });
      expect(members[0].amounts?.[0].quantity?.comparator).toBe(qualifier ? "~" : undefined);
      expect(members[1].amounts?.[0].quantity).toMatchObject({ value: 10, unit: "mL" });
      expect(members.filter(member => member.predicate).flatMap(member => member.schedule?.recurrence?.clocks ?? []))
        .toEqual(matches ? ["08:00:00"] : []);
      expect(nextDueDoses(input, { ...query, evaluateCondition: () => false })).toEqual(matches ? [all[1], all[3]] : all);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 2, durationUnit: "d", evaluateCondition: () => false }))
        .toMatchObject({ totalUnits: matches ? 20 : 30, unit: "mL" });
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 2, durationUnit: "d", evaluateCondition: () => true }))
        .toMatchObject({ totalUnits: 30, unit: "mL" });
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });
});

describe("registered weekday and hard-delimiter vocabulary", () => {
  it.each([
    ["Mond", ["mon"], ["03", "04", "05", "06", "07", "08"]],
    ["weekdays", ["mon", "tue", "wed", "thu", "fri"], ["07", "08"]],
    ["weekends", ["sat", "sun"], ["02", "03", "04", "05", "06"]]
  ] as const)("keeps registered %s calendar vocabulary consistent with execution", (weekday, excluded, days) => {
    const source = "Take 1 tablet daily for 7 days except " + weekday, parsed = parsePublicSig(source);
    const query = { orderedAt: "2026-11-02T00:00:00Z", from: "2026-11-02T00:00:00Z", timeZone: "UTC" };
    expect(parsed.meta.canonical.clauses[0].clinicalAdjuncts?.excludedWeekdays).toEqual(excluded);
    for (const dosage of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const before = JSON.stringify(dosage);
      expect(nextDueDoses(dosage, { ...query, limit: 8 })
        .map(at => at.slice(0, 10))).toEqual(days.map(day => "2026-11-" + day));
      expect(calculateTotalUnits({ dosage, ...query, durationValue: 7, durationUnit: "d" }).totalUnits).toBe(days.length);
      expect(JSON.stringify(dosage)).toBe(before);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it("keeps short Thai weekday aliases contextual while complete calendar nouns remain licensed", () => {
    const clause = parseClauseState("กิน 1 เม็ด ทุกวันจ").primaryClause;
    expect(clause.dose).toEqual({ value: 1, unit: "tab" });
    expect(clause.schedule?.dayOfWeek).toEqual(["mon"]);
    expect(matchCalendarExclusion("except จ")).toBeUndefined();
    expect(matchCalendarExclusion("except อ")).toBeUndefined();
    expect(matchCalendarExclusion("except workdays")).toBeUndefined();
    expect(matchCalendarExclusion("ยกเว้นวันหยุด")).toBeUndefined();
    expect(matchCalendarExclusion("except วันจันทร์")?.excluded).toEqual(["mon"]);
    expect(matchCalendarExclusion("เว้นวันอังคาร")?.excluded).toEqual(["tue"]);
  });

  it("keeps the word thus outside registered weekday vocabulary", () => {
    const thursday = CALENDAR_WEEKDAY_LEXEMES.find(entry => entry.day === "thu")!;
    expect(thursday.patterns.some(pattern => new RegExp(pattern.source, "iu").test("thus"))).toBe(false);
  });

  it.each(["Thu", "Thur", "Thurs", "Thursday", "Thursdays"])("keeps the Thursday exclusion for %s", weekday => {
    const source = "Take 1 tablet daily except " + weekday, parsed = parsePublicSig(source);
    const query = { orderedAt: "2026-11-02T00:00:00Z", from: "2026-11-02T00:00:00Z", timeZone: "UTC" };
    expect(parsed.meta.canonical.clauses[0].clinicalAdjuncts?.excludedWeekdays).toEqual(["thu"]);
    for (const dosage of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const before = JSON.stringify(dosage);
      expect(nextDueDoses(dosage, { ...query, limit: 8 }).map(at => at.slice(0, 10))).toEqual([
        "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10"
      ]);
      expect(calculateTotalUnits({ dosage, ...query, durationValue: 7, durationUnit: "d" }).totalUnits).toBe(6);
      expect(JSON.stringify(dosage)).toBe(before);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it("keeps the complete double-slash boundary between independent eyes", () => {
    const source = "Instill 1 drop OD qAM // Instill 1 drop OS qHS";
    const tokens = tokenize(source), delimiter = tokens.filter(token => token.original.includes("/"));
    expect(delimiter).toHaveLength(1);
    expect(delimiter[0]).toMatchObject({ original: "//", sourceStart: source.indexOf("//"), sourceEnd: source.indexOf("//") + 2 });
    const parsed = parsePublicSig(source);
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const before = JSON.stringify(input), members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
      expect(members.map(member => ({ eye: member.target?.coding?.[0]?.code, dose: member.amounts?.[0]?.quantity,
        anchors: member.schedule?.recurrence?.anchors }))).toMatchObject([
        { eye: "1290032005", dose: { value: 1, unit: "drop" }, anchors: ["MORN"] },
        { eye: "1290031003", dose: { value: 1, unit: "drop" }, anchors: ["HS"] }
      ]);
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    const daily = parsePublicSig("Take 5 mg/day");
    expect(daily.meta.canonical.clauses[0]).toMatchObject({ dose: { value: 5, unit: "mg" },
      schedule: { frequency: 1, period: 1, periodUnit: "d" } });
  });
});

describe("HPSG inherited phase origins and complete anchor groups", () => {
  it("retains the civil treatment-day origin through a finite hold and resume", () => {
    const source = "From day 3, take 1 tablet at 08:00 daily for 5 days, then hold for 2 days, then resume 1 tablet at 08:00 daily";
    const parsed = parsePublicSig(source), before = JSON.stringify(parsed);
    const query = { from: "2026-12-01T12:00:00Z", orderedAt: "2026-12-01T12:00:00Z", timeZone: "UTC", limit: 8 };
    const expected = [3, 4, 5, 6, 7, 10, 11, 12].map(day => `2026-12-${String(day).padStart(2, "0")}T08:00:00+00:00`);
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const course = importCanonicalCourse(input);
      expect(course.stages).toHaveLength(2);
      expect(course.stages.map(stage => stage.start)).toEqual([
        expect.objectContaining({ anchor: "treatment-day-start", displacement: expect.objectContaining({ value: 2, unit: "d" }) }),
        expect.objectContaining({ anchor: "treatment-day-start", displacement: expect.objectContaining({ value: 9, unit: "d" }) })
      ]);
      expect(nextDueDoses(input, query)).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 11, durationUnit: "d" }))
        .toMatchObject({ totalUnits: 8, unit: "tab" });
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it.each([["BID", 2, 10], ["daily", 1, 6]] as const)(
    "inherits a complete event and offset only when compatible with the successor cadence: %s",
    (cadence, frequency, total) => {
      const source = `Take 1 tablet daily 30 minutes before dinner for 2 days, then take 2 tablets ${cadence} at the same time`;
      const parsed = parsePublicSig(source), before = JSON.stringify(parsed);
      const expected = ["2026-12-01T18:00:00+00:00", "2026-12-02T18:00:00+00:00",
        ...(frequency === 2
          ? ["2026-12-03T08:00:00+00:00", "2026-12-03T20:00:00+00:00",
            "2026-12-04T08:00:00+00:00", "2026-12-04T20:00:00+00:00"]
          : ["2026-12-03T18:00:00+00:00", "2026-12-04T18:00:00+00:00"])];
      const query = { from: "2026-12-01T00:00:00Z", orderedAt: "2026-12-01T00:00:00Z",
        timeZone: "UTC", eventClock: { CV: "18:30" }, limit: expected.length };
      for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
        JSON.parse(JSON.stringify(parsed.fhirNext))]) {
        const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
        expect(members).toHaveLength(2);
        expect(members.map(member => member.amounts?.[0].quantity?.value)).toEqual([1, 2]);
        expect(members[0].schedule?.recurrence).toMatchObject({ anchors: ["ACV"], offset: 30 });
        const next = members[1].schedule?.recurrence;
        expect(next).toMatchObject({ frequency, period: 1, periodUnit: "d" });
        expect(next?.anchors).toEqual(frequency === 1 ? ["ACV"] : undefined);
        expect(next?.offset).toBe(frequency === 1 ? 30 : undefined);
        expect(nextDueDoses(input, query)).toEqual(expected);
        expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 4, durationUnit: "d" }))
          .toMatchObject({ totalUnits: total, unit: "tab" });
      }
      expect(parsed.fhirNext.renderedInstruction).toBe(source);
      expect(JSON.stringify(parsed)).toBe(before);
    });
});

describe("bilateral withholding target multiplicity", () => {
  it.each([
    ["in both eyes", "at 08:00", 2],
    ["in both eyes", "at 08:00 and 20:00", 4],
    ["OU", "at 08:00 and 20:00", 4],
    ["OU", "at 08:00 and 20:00", 4, "in both eyes"]
  ] as const)("retains the named bilateral target: %s %s", (site, clocks, administrations, target = site) => {
    const source = `Instill 1 drop ${site} daily ${clocks} for 2 days. If itchy, do not instill 1 drop ${target}.`;
    const parsed = parsePublicSig(source), original = JSON.stringify(parsed);
    const options = { orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-01T00:00:00Z", timeZone: "UTC", limit: 8 };
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const before = JSON.stringify(input), member = importCanonicalCourse(input).stages[0].administrations[0];
      expect(member.target?.coding?.[0]?.code).toBe("40638003");
      expect(member.targetCount).toBe(2);
      const namedSites = member.syntax?.instructionGraph?.actions.filter(action => action.polarity === "negate")
        .flatMap(action => action.args.filter(argument => argument.role === "site")) ?? [];
      for (const argument of namedSites) expect(argument.administrationTargetCount).toBe(2);
      if (target === "in both eyes") expect(namedSites).toHaveLength(1);
      expect(member.amounts?.[0].quantity).toMatchObject({ value: 1, unit: "drop" });
      expect(nextDueDoses(input, { ...options, evaluateCondition: () => false })).toEqual([]);
      expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 2, durationUnit: "d", evaluateCondition: () => false }))
        .toMatchObject({ totalUnits: 0, unit: "drop" });
      expect(nextDueDoses(input, { ...options, evaluateCondition: () => true })).toHaveLength(administrations);
      expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 2, durationUnit: "d", evaluateCondition: () => true }))
        .toMatchObject({ totalUnits: administrations * 2, unit: "drop" });
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(original);
  });
});

describe("registered route and anchored site ownership", () => {
  it.each(["", " OPH", " CLINICEYE"])("keeps a route alias outside the left-eye constituent: %s", suffix => {
    const phrase = "in the left eye" + suffix;
    const tokens = tokenize(phrase);
    const options = { routeMap: { cliniceye: RouteCode["Ophthalmic route"] } };
    const context: HpsgClauseContext = {
      state: new ParserState(phrase, tokens), tokens, limit: tokens.length, options,
      dateSpans: [], clinicalCache: {}, deps: {} as HpsgClauseContext["deps"]
    };
    const site = siteLexicalRule().match(context, 0).find(sign => sign.type === "site-sign")!;
    expect(site.synsem.valence.site).toMatchObject({ text: "left eye", coding: { code: "1290031003" } });
    if (suffix) expect(site.tokens.some(token => token.original === suffix.trim())).toBe(false);
    const source = "Instill 1 drop " + phrase + " daily", parsed = parseSig(source, options);
    for (const row of [parsed.fhir, ...toFhirR5Dosages(toDosageDetails([parsed.fhir]))]) {
      expect(row.site?.coding?.[0]?.code).toBe("1290031003");
      expect(row.route?.coding?.[0]?.code).toBe(RouteCode["Ophthalmic route"]);
      expect(row.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "drop" });
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });
});

describe("shared bounds of a selectively partitioned administration", () => {
  const query = { orderedAt: "2026-11-23T00:00:00Z", from: "2026-11-23T00:00:00Z", timeZone: "UTC", limit: 5 };
  const warning = " On Mondays, do not take the 1-tablet morning dose";
  const ordinary = "Take 1 tablet at 08:00 and 20:00 for 4 doses.";
  const selected = ["2026-11-23T20:00:00+00:00", "2026-11-24T08:00:00+00:00",
    "2026-11-24T20:00:00+00:00", "2026-11-25T08:00:00+00:00"];
  const civil = ["2026-11-23T20:00:00+00:00", "2026-11-24T08:00:00+00:00",
    "2026-11-25T08:00:00+00:00", "2026-11-26T08:00:00+00:00"];
  const rolling = ["2026-11-23T20:00:00+00:00", "2026-11-24T20:00:00+00:00",
    "2026-11-25T20:00:00+00:00", "2026-11-26T20:00:00+00:00"];

  it.each([
    ["ordinary four", ordinary, false, 4, undefined, [
      "2026-11-23T08:00:00+00:00", "2026-11-23T20:00:00+00:00",
      "2026-11-24T08:00:00+00:00", "2026-11-24T20:00:00+00:00"]],
    ["shared four", ordinary + warning, true, 4, undefined, selected],
    ["shared upper four", "Take 1 tablet at 08:00 and 20:00 up to 4 doses." + warning,
      true, undefined, 4, selected],
    ["shared four and civil occurrence cap",
      "Take 1 tablet at 08:00 and 20:00 for 4 doses, maximum 1 dose per day." + warning,
      true, 4, undefined, civil],
    ["shared four and rolling quantity cap",
      "Take 1 tablet at 08:00 and 20:00 for 4 doses, maximum 1 tablet per day." + warning,
      true, 4, undefined, rolling],
    ["shared civil occurrence cap without finite count",
      "Take 1 tablet at 08:00 and 20:00, maximum 1 dose per day." + warning,
      true, undefined, undefined, [...civil, "2026-11-27T08:00:00+00:00"]]
  ] as const)("preserves the accepted occurrence owner: %s", (name, source, shared, count, countMax, expected) => {
    const parsed = parsePublicSig(source), original = JSON.stringify(parsed);
    if (shared) expect(parsed.meta.canonical.clauses.every(clause => clause.sourceProjectionVerified === false)).toBe(true);
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const before = JSON.stringify(input);
      const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(shared ? 2 : 1);
      expect(members.every(member => member.amounts?.[0].quantity?.value === 1)).toBe(true);
      if (shared) {
        const groups = members.map(member => member.schedule?.recurrence?.sharedCount);
        expect(groups.every(group => Boolean(group?.groupId))).toBe(true);
        expect(new Set(groups.map(group => group?.groupId)).size).toBe(1);
        for (const member of members) {
          expect(member.schedule?.recurrence?.count).toBeUndefined();
          expect(member.schedule?.recurrence?.countMax).toBeUndefined();
          expect(member.schedule?.recurrence?.sharedCount?.count).toBe(count);
          expect(member.schedule?.recurrence?.sharedCount?.countMax).toBe(countMax);
        }
        const morning = members.find(member => member.schedule?.recurrence?.clocks?.[0] === "08:00:00")!;
        const evening = members.find(member => member.schedule?.recurrence?.clocks?.[0] === "20:00:00")!;
        expect(morning.excludedWeekdays).toEqual(["mon"]);
        expect(evening.excludedWeekdays).toBeUndefined();
      } else {
        expect(members[0].schedule?.recurrence?.count).toBe(4);
        expect(members[0].schedule?.recurrence?.sharedCount).toBeUndefined();
      }
      expect(nextDueDoses(input, query)).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 7, durationUnit: "d" }))
        .toMatchObject({ totalUnits: count === undefined && countMax === undefined ? 7 : 4, unit: "tab" });
      if (name === "ordinary four" || name === "shared four") {
        const late = { ...query, from: "2026-11-24T00:00:00Z" };
        expect(nextDueDoses(input, late)).toEqual(expected.filter(time => time >= late.from));
        expect(calculateTotalUnits({ dosage: input, ...late, durationValue: 7, durationUnit: "d" }))
          .toMatchObject({ totalUnits: shared ? 3 : 2, unit: "tab" });
      }
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(original);
  });

  it("retains an independent count and current shared-timing annotations through fresh wire inputs", () => {
    const url = "urn:ezmedicationinput:StructureDefinition:medication-timing-shared-count";
    const marker = (index: number) => ({ url, id: `quota-${index}`, extension: [
      { url: "groupId", valueString: "daily-pair", id: `group-${index}` },
      { url: "count", valueInteger: 4, _valueInteger: { id: `total-${index}`,
        extension: [{ url: "https://example.org/total-note", valueString: "authored" }] } },
      { url: "https://example.org/quota-note", valueString: `retained-${index}` }
    ] });
    const rows = JSON.parse(JSON.stringify([
      ...[["20:00:00", undefined], ["08:00:00", ["tue", "wed", "thu", "fri", "sat", "sun"]]].map(([clock, dayOfWeek], index) => ({
        sequence: 1, id: `row-${index}`,
        extension: [{ url: "https://example.org/row-note", valueString: `current-${index}` }],
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: "d",
          timeOfDay: [clock], dayOfWeek, extension: [marker(index)] } }
      })),
      { sequence: 1, id: "independent", doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }],
        timing: { repeat: { count: 1, timeOfDay: ["12:00:00"] } } }
    ]));
    const original = JSON.stringify(rows);
    for (const input of [importCanonicalCourse(rows), rows, JSON.parse(JSON.stringify(toDosageDetails(rows)))]) {
      const before = JSON.stringify(input), course = importCanonicalCourse(input);
      const members = course.stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(3);
      for (const member of members.slice(0, 2)) {
        expect(member.schedule?.recurrence?.sharedCount).toEqual({ groupId: "daily-pair", count: 4 });
        expect(member.schedule?.recurrence?.count).toBeUndefined();
      }
      expect(members[2].schedule?.recurrence?.count).toBe(1);
      expect(members[2].schedule?.recurrence?.sharedCount).toBeUndefined();
      expect(nextDueDoses(input, query)).toEqual(["2026-11-23T12:00:00+00:00", ...selected]);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 7, durationUnit: "d" }))
        .toMatchObject({ totalUnits: 6, unit: "tab" });
      const projected = courseToR5(course);
      for (let index = 0; index < 2; index++) {
        expect(projected[index].timing?.repeat?.extension?.find(extension => extension.url === url)).toEqual(marker(index));
        expect(projected[index].extension).toContainEqual({
          url: "https://example.org/row-note", valueString: `current-${index}`
        });
      }
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(JSON.stringify(rows)).toBe(original);
  });
});


describe("advice-owned continuation and procedural conditions", () => {
  const query = { from: "2026-12-01T00:00:00Z", orderedAt: "2026-12-01T00:00:00Z",
    timeZone: "UTC", limit: 2, eventClock: { [EventTiming["Before Sleep"]]: "22:00" } };

  it("keeps a next-day warning and its affected-driving condition off the standing bedtime dose", () => {
    const source = "Take 1 tablet once daily at bedtime. Causes drowsiness which may continue the next day. If affected do not drive or operate machinery. Avoid alcohol.";
    const parsed = parseSig(source), before = JSON.stringify(parsed);
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.schedule).toMatchObject({ frequency: 1, period: 1, periodUnit: "d", when: [EventTiming["Before Sleep"]] });
    expect(clause.prn).toBeUndefined();
    expect(clause.schedule?.treatmentStartOffsetDays).toBeUndefined();
    expect(clause.additionalInstructions?.map(instruction => instruction.coding?.code)).not.toContain("418954008");
    expect(clause.additionalInstructions?.map(instruction => instruction.coding?.code)).not.toContain("418914006");
    const continuation = clause.instructionGraph?.actions.find(frame => frame.predicate.lemma === "cause");
    expect(continuation?.predicate.semanticClass).toBe("effect");
    expect(continuation?.force).toBe("warning");
    expect(continuation?.sourceText).toBe("Causes drowsiness which may continue the next day");
    expect(source.slice(continuation!.span.start, continuation!.span.end)).toBe(continuation!.sourceText);
    const graph = clause.instructionGraph!;
    const drive = graph.actions.findIndex(action => action.predicate.lemma === "drive");
    expect(drive).toBeGreaterThanOrEqual(0);
    expect(graph.actions[drive].polarity).toBe("negate");
    expect(graph.relations).toContainEqual(expect.objectContaining({ kind: "if", toActionIndex: drive, text: "If affected" }));
    expect(graph.actions[drive].sourceText).toContain("do not drive or operate machinery");
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)), JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const original = JSON.stringify(input);
      const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(1);
      expect(members[0].amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(members[0].asNeeded).not.toBe(true);
      expect(members[0].predicate).toBeUndefined();
      expect(nextDueDoses(input, query)).toEqual(["2026-12-01T22:00:00+00:00", "2026-12-02T22:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 2, durationUnit: "d" }).totalUnits).toBe(2);
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(en).toContain("next day");
      expect(en).toMatch(/if affected.*do not drive or operate machinery/i);
      expect(en.match(/do not drive/gi)).toHaveLength(1);
      expect(en).toMatch(/avoid alcohol/i);
      for (const row of projectCanonicalCourse(importCanonicalCourse(input)).fhir) {
        expect(row.additionalInstruction?.filter(instruction =>
          instruction.text === "Causes drowsiness which may continue the next day")).toHaveLength(1);
      }
      expect(en).not.toMatch(/from day 2|as needed|no doses on/i);
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(th).toContain("1");
      expect(th).toContain("affected");
      expect(th.match(/ขับรถ/gu)).toHaveLength(1);
      expect(JSON.stringify(input)).toBe(original);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it("uses the canonical prefixed warning head without qualifying an unconditional driving prohibition", () => {
    const source = "Take 1 tablet at bedtime. May cause drowsiness; do not drive.";
    const parsed = parseSig(source), before = JSON.stringify(parsed);
    const clause = parsed.meta.canonical.clauses[0];
    const cause = clause.additionalInstructions?.flatMap(instruction => instruction.frames ?? [])
      .find(frame => frame.predicate.lemma === "cause");
    expect(cause).toMatchObject({ force: "warning", modality: "may",
      predicate: { lemma: "cause", semanticClass: "effect", realizer: "default" } });
    expect(cause?.sourceText).toBe("May cause drowsiness");
    expect(clause.instructionGraph?.actions.find(frame => frame.predicate.lemma === "drive")?.polarity).toBe("negate");
    expect(clause.additionalInstructions?.some(instruction => ["418954008", "418914006"].indexOf(instruction.coding?.code ?? "") >= 0)).not.toBe(true);
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)), JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const member = importCanonicalCourse(input).stages[0].administrations[0];
      expect(member.amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(member.asNeeded).not.toBe(true);
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(en).toMatch(/may cause drowsiness/i);
      expect(en).toMatch(/do not drive/i);
      expect(en).not.toContain("if affected");
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it("keeps positive driving history inside its medication guard", () => {
    const source = "Only if you have finished driving, take 1 tablet at bedtime";
    const parsed = parseSig(source), before = JSON.stringify(parsed);
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.instructionGraph?.actions.some(action => action.predicate.lemma === "drive")).not.toBe(true);
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)), JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const member = importCanonicalCourse(input).stages[0].administrations[0];
      expect(member.predicate).toMatchObject({ kind: "state", name: "you have finished driving", expected: true });
      expect(member.amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(en).toContain("only if you have finished driving");
      expect(en).not.toMatch(/then drive|do not drive/i);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it("keeps a covering condition on the complete material-bearing procedure", () => {
    const source = "Apply ointment then cover with occlusive dressing if instructed";
    const parsed = parseSig(source), before = JSON.stringify(parsed);
    const clause = parsed.meta.canonical.clauses[0], graph = clause.instructionGraph!;
    expect(clause.prn).toBeUndefined();
    const cover = graph.actions.findIndex(action => action.predicate.lemma === "cover");
    expect(cover).toBeGreaterThanOrEqual(0);
    expect(graph.actions[cover].args).toContainEqual(expect.objectContaining({ role: "material", text: "occlusive dressing" }));
    expect(graph.actions[cover].sourceText).toBe("cover with occlusive dressing");
    expect(graph.relations).toContainEqual(expect.objectContaining({ kind: "if", toActionIndex: cover, text: "if instructed" }));
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)), JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const original = JSON.stringify(input), member = importCanonicalCourse(input).stages[0].administrations[0];
      expect(member.asNeeded).not.toBe(true);
      expect(member.predicate).toBeUndefined();
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(en).toMatch(/cover with (?:an )?occlusive dressing if instructed/i);
      expect(en.match(/if instructed/gi)).toHaveLength(1);
      expect(en).not.toContain("as needed");
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(th.match(/instructed/g)).toHaveLength(1);
      expect(JSON.stringify(input)).toBe(original);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it("keeps a modal covering condition in the standard advice row", () => {
    const source = "Apply ointment then may cover with occlusive dressing if instructed";
    const parsed = parseSig(source), before = JSON.stringify(parsed);
    const clause = parsed.meta.canonical.clauses[0], graph = clause.instructionGraph!;
    const cover = graph.actions.findIndex(action => action.predicate.lemma === "cover");
    expect(graph.actions[cover].modality).toBe("may");
    expect(graph.actions[cover].polarity).not.toBe("negate");
    expect(graph.relations).toContainEqual(expect.objectContaining({ kind: "if", toActionIndex: cover, text: "if instructed" }));
    expect(clause.prn).toBeUndefined();
    expect(clause.additionalInstructions).toContainEqual(expect.objectContaining({
      text: "may cover with occlusive dressing if instructed",
      frames: [expect.objectContaining({ modality: "may", predicate: expect.objectContaining({ lemma: "cover" }) })]
    }));
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)), JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const original = JSON.stringify(input), member = importCanonicalCourse(input).stages[0].administrations[0];
      expect(member.asNeeded).not.toBe(true);
      expect(member.predicate).toBeUndefined();
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(en).toMatch(/may cover with (?:an )?occlusive dressing if instructed/i);
      expect(en.match(/if instructed/gi)).toHaveLength(1);
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }).match(/instructed/g)).toHaveLength(1);
      for (const row of projectCanonicalCourse(importCanonicalCourse(input)).fhir) {
        expect(row.additionalInstruction?.map(instruction => instruction.text)).toContain("may cover with occlusive dressing if instructed");
        expect(row.additionalInstruction?.some(instruction => instruction.coding?.some(coding => coding.code === "OCD"))).not.toBe(true);
      }
      expect(JSON.stringify(input)).toBe(original);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it.each([
    ["Take 1 tablet once daily at bedtime.", "2026-12-01T22:00:00+00:00"],
    ["Take 1 tablet once daily at bedtime. Do not drive if drowsy.", "2026-12-01T22:00:00+00:00"],
    ["Take 1 tablet once daily at bedtime starting the next day.", "2026-12-02T22:00:00+00:00"]
  ])("preserves the existing dose-onset owner for %s", (source, first) => {
    const parsed = parseSig(source);
    expect(parsed.meta.canonical.clauses[0].prn).toBeUndefined();
    expect(nextDueDoses(parsed.meta.canonical.course!, { ...query, limit: 1 })).toEqual([first]);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });
});


describe("complete withholding weekday arguments", () => {
  it.each([
    ["Mondays and Wednesdays", [7, 9], false],
    ["Mondays and Wednesdays", [7, 9], true],
    ["Monday and Wednesday", [7, 9], false],
    ["Mon-Wed", [7, 8, 9], false],
    ["Monday", [7], false],
    ["Monday", [7], true]
  ] as const)("withholds only the selected morning doses on %s", (days, excluded, preposed) => {
    const withholding = preposed ? `On ${days}, hold the morning dose.` : `Hold the morning dose on ${days}.`;
    const source = `Take 1 tablet at 08:00 and 20:00 for 7 days. ${withholding}`;
    const parsed = parsePublicSig(source), before = JSON.stringify(parsed);
    const expected: string[] = [];
    for (let day = 7; day <= 13; day++) {
      const date = `2026-12-${String(day).padStart(2, "0")}`;
      if (!(excluded as readonly number[]).includes(day)) expected.push(`${date}T08:00:00+00:00`);
      expected.push(`${date}T20:00:00+00:00`);
    }
    const query = { orderedAt: "2026-12-07T00:00:00Z", from: "2026-12-07T00:00:00Z", timeZone: "UTC", limit: 20 };
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const current = JSON.stringify(input);
      expect(nextDueDoses(input, query)).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 7, durationUnit: "d" }))
        .toMatchObject({ totalUnits: expected.length, unit: "tab" });
      const members = importCanonicalCourse(input).stages[0].administrations;
      expect(members).toHaveLength(2);
      const morning = members.find(member => member.schedule?.recurrence?.clocks?.includes("08:00:00"));
      const hold = morning?.syntax?.instructionGraph?.actions.find(action => action.predicate.lemma === "hold");
      expect(hold?.args).toEqual(expect.arrayContaining([expect.objectContaining({ role: "time", text: days })]));
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }).toLowerCase()).toContain(days.toLowerCase());
      expect(JSON.stringify(input)).toBe(current);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });
});


describe("clinical guard complement ownership", () => {
  it.each([" ", ", "])("keeps the tolerated activity inside the guard before a quantified consequent: %j", separator => {
    const source = `Only if you tolerate drinking water${separator}take 1 tablet`;
    const parsed = parsePublicSig(source);
    const condition = "you tolerate drinking water";
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const before = JSON.stringify(input);
      const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(1);
      expect(members[0].amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(members[0].predicate).toMatchObject({ kind: "state", name: condition, expected: true, text: condition });
      expect(members[0].asNeeded).not.toBe(true);
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe("Take 1 tablet orally only if you tolerate drinking water.");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
        .toBe("รับประทานครั้งละ 1 เม็ด เฉพาะเมื่อ you tolerate drinking water.");
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(parsed.fhir[0].text).toBe(source);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it.each([false, true])("retains a history frequency and only a separately stated medication maximum: %j", withMaximum => {
    const condition = "you are using your rescue inhaler no more than twice a day";
    const source = `Take 1 tablet only if ${condition}${withMaximum ? ", maximum 4 doses per day" : ""}`;
    const parsed = parsePublicSig(source);
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const before = JSON.stringify(input);
      const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(1);
      expect(members[0].amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(members[0].predicate).toMatchObject({ kind: "state", name: condition, expected: true, text: condition });
      expect(members[0].asNeeded).not.toBe(true);
      expect(members[0].limits).toBeUndefined();
      if (withMaximum) {
        expect(members[0].schedule?.recurrence?.occurrenceCap).toEqual({ max: 4, period: 1, periodUnit: "d" });
      } else {
        expect(members[0].schedule?.recurrence?.occurrenceCap).toBeUndefined();
        expect(members[0].schedule?.recurrence?.frequency).toBeUndefined();
      }
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(en).toContain(`only if ${condition}`);
      expect(th).toContain(`เฉพาะเมื่อ ${condition}`);
      if (!withMaximum) expect(en).toBe(`Take 1 tablet orally only if ${condition}.`);
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(parsed.fhir[0].text).toBe(source);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });


});

describe("selected instruction refinement at HPSG unification", () => {
  it.each([
    { text: "not crush or chew", heads: ["crush", "chew"], spans: [{ start: 24, end: 33 }, { start: 37, end: 41 }] },
    { text: "not chew or crush", heads: ["chew", "crush"], spans: [{ start: 24, end: 32 }, { start: 36, end: 41 }] }
  ])("retains each coordinated lexical action occurrence: $text", ({ text, heads, spans }) => {
    const rows = parseAdditionalInstructions(text, { start: 24, end: 24 + text.length });
    expect(rows).toHaveLength(1);
    expect(rows[0].frames.map(frame => frame.predicate.lemma)).toEqual(heads);
    expect(rows[0].frames.map(frame => frame.span)).toEqual(spans);
    for (const frame of rows[0].frames) {
      expect(frame.force).toBe(AdviceForce.Warning);
      expect(frame.polarity).toBe(AdvicePolarity.Negate);
      expect(frame.args).toEqual([]);
      expect(frame.sourceText).toBe(text.slice(frame.span.start - 24, frame.span.end - 24));
    }
  });

  it("retains shared complements and polarity when coordinated heads receive source spans", () => {
    const source = "do not crush or chew tablets";
    const frames = parseAdditionalInstructions(source, { start: 0, end: source.length })[0].frames;
    expect(frames).toHaveLength(2);
    expect(frames.map(frame => frame.polarity)).toEqual([AdvicePolarity.Negate, AdvicePolarity.Negate]);
    expect(frames.map(frame => frame.args)).toEqual([
      [{ role: AdviceArgumentRole.Object, text: "tablets", normalized: "tablet",
        conceptId: "medication-tablet", i18n: { en: "tablet", th: "ยาเม็ด" } }],
      [{ role: AdviceArgumentRole.Object, text: "tablets", normalized: "tablet",
        conceptId: "medication-tablet", i18n: { en: "tablet", th: "ยาเม็ด" } }]
    ]);
    expect(frames.map(frame => frame.span)).toEqual([
      { start: 0, end: source.length }, { start: source.indexOf("chew"), end: source.length }
    ]);
  });

  const standing = "Take 5 mL at 08:00 and 10 mL at 20:00 daily for 2 days. ";
  const merge = (left: HpsgInstructionFeature, right: HpsgInstructionFeature) => unifySynsem(
    { head: {}, valence: { instructions: [left] }, cont: {} },
    { head: {}, valence: { instructions: [right] }, cont: {} },
    { normalizeSiteText: text => text, isCompatibleRouteRefinement: (a, b) => a === b }
  )?.valence.instructions;

  it.each([
    "If dizzy, do not take 5 mL, and do not take 10 mL.",
    "If dizzy, do not take 5 mL at 20:00, and do not take 10 mL at 08:00."
  ])("selects the complete quantified withholding instruction before graph construction: %s", tail => {
    const source = standing + tail;
    const instructions = parseClauseSign(source)?.synsem.valence.instructions;
    expect(instructions).toHaveLength(1);
    expect(instructions![0].text).toBe(tail.slice(0, -1));
    expect(instructions![0].frames).toHaveLength(2);
    expect(instructions![0].frames!.map(frame => frame.args.find(arg => arg.quantity)?.quantity))
      .toEqual([{ value: 5, unit: "mL" }, { value: 10, unit: "mL" }]);
    expect(instructions![0].frames!.map(frame => source.slice(frame.span.start, frame.span.end)))
      .toEqual(tail.includes("20:00")
        ? ["do not take 5 mL at 20:00", "do not take 10 mL at 08:00"]
        : ["do not take 5 mL", "do not take 10 mL"]);
  });

  it("keeps the richer selected valence in either merge order without merging distinct or coded occurrences", () => {
    const source = standing + "If dizzy, do not take 5 mL at 20:00, and do not take 10 mL at 08:00.";
    const rich = parseClauseSign(source)!.synsem.valence.instructions![0];
    const action = rich.frames![1];
    const amount = action.args.find(arg => arg.role === AdviceArgumentRole.Amount)!;
    const weak = parseAdditionalInstructions("and do not take 10 mL", {
      start: action.span.start - 4, end: amount.span!.end
    })[0];
    expect(weak.frames![0].span).toEqual({ start: action.span.start, end: amount.span!.end });
    expect(source.slice(weak.frames![0].span.start, weak.frames![0].span.end))
      .toBe(weak.frames![0].sourceText);
    const before = JSON.stringify([rich, weak]);
    expect(merge(rich, weak)).toEqual([rich]);
    expect(merge(weak, rich)).toEqual([rich]);
    const separate = { ...weak, frames: weak.frames!.map(frame => ({ ...frame,
      span: { start: source.length + 1, end: source.length + 22 } })) };
    expect(merge(rich, separate)).toEqual([rich, separate]);
    const coded = { ...weak, coding: { system: "http://snomed.info/sct", code: "418693002" } };
    expect(merge(rich, coded)).toEqual([rich, coded]);
    expect(merge(coded, rich)).toEqual([coded, rich]);
    expect(JSON.stringify([rich, weak])).toBe(before);
  });

  it("retains explicit argument, qualifier and same-role order differences", () => {
    const frame: AdviceFrame = {
      force: AdviceForce.Warning, polarity: AdvicePolarity.Negate,
      predicate: { lemma: "take", semanticClass: "administration" },
      args: [{ role: AdviceArgumentRole.Object, text: "water", normalized: "water" }],
      span: { start: 0, end: 20 }, sourceText: "Do not take water"
    };
    const left = { text: "Do not take water", frames: [frame] };
    const nominal = { text: "Do not take milk", frames: [{ ...frame,
      args: [{ role: AdviceArgumentRole.Object, text: "milk", normalized: "milk" }] }] };
    expect(merge(left, nominal)).toEqual([left, nominal]);
    const crossing = { ...left, frames: [{ ...frame, span: { start: 10, end: 30 } }] };
    expect(merge(left, crossing)).toEqual([left, crossing]);
    expect(merge(crossing, left)).toEqual([crossing, left]);
    const typed = { ...frame, args: [
      { role: AdviceArgumentRole.Amount, text: "5 mL", quantity: { value: 5, unit: "mL" } },
      { role: AdviceArgumentRole.Amount, text: "10 mL", quantity: { value: 10, unit: "mL" } }
    ] };
    const selected = { text: "selected amounts", frames: [typed] };
    const reordered = { text: "reordered amounts", frames: [{ ...typed, args: [...typed.args].reverse() }] };
    expect(merge(selected, reordered)).toEqual([selected, reordered]);
    const morning = { text: "Do not take at 08:00", frames: [{ ...frame, args: [{
      role: AdviceArgumentRole.Time, relation: AdviceRelation.On, text: "08:00", normalized: "08:00:00"
    }] }] };
    const evening = { text: "Do not take at 20:00", frames: [{ ...frame, args: [{
      role: AdviceArgumentRole.Time, relation: AdviceRelation.On, text: "20:00", normalized: "20:00:00"
    }] }] };
    expect(merge(morning, evening)).toEqual([morning, evening]);
    expect(merge(evening, morning)).toEqual([evening, morning]);
    const modal = { ...left, text: "May not take water", frames: [{ ...frame, modality: AdviceModality.May }] };
    const different = { ...left, text: "Should not take water", frames: [{ ...frame, modality: AdviceModality.Should }] };
    expect(merge(modal, different)).toEqual([modal, different]);
  });
});


describe("both dose-opportunity withholding targets", () => {
  const query = { from: "2026-12-01T00:00:00Z", orderedAt: "2026-12-01T00:00:00Z", timeZone: "UTC", limit: 10 };
  it.each([false, true])("binds two selected clocks within one state; extra midday slot %s", midday => {
    const source = "Take 1 tablet at " + (midday ? "08:00, 14:00 and 20:00" : "08:00 and 20:00") +
      " daily for 2 days. Hold both the 08:00 and 20:00 doses if dizzy.";
    const parsed = parsePublicSig(source), before = JSON.stringify(parsed);
    expect(parsed.warnings).not.toContain("Unresolved medication-condition target: confirm which administration the instruction refers to.");
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)), JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const inputBefore = JSON.stringify(input);
      const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
      const held = members.find(member => member.schedule?.recurrence?.clocks?.includes("08:00:00"))!;
      expect(held.schedule?.recurrence?.clocks).toEqual(["08:00:00", "20:00:00"]);
      expect(held.predicate).toMatchObject({ kind: "not", condition: { kind: "state", name: "dizzy", expected: true } });
      const unaffected = members.find(member => member.schedule?.recurrence?.clocks?.includes("14:00:00"));
      expect(unaffected?.predicate).toBeUndefined();
      expect(members).toHaveLength(midday ? 2 : 1);
      for (const dizzy of [false, true]) {
        const options = { ...query, evaluateCondition: (condition: Parameters<typeof evaluateMedicationCondition>[0]) =>
          evaluateMedicationCondition(condition, { dizzy, nausea: !dizzy }) };
        const expected = ["2026-12-01", "2026-12-02"].flatMap(date =>
          (dizzy ? midday ? ["14:00"] : [] : midday ? ["08:00", "14:00", "20:00"] : ["08:00", "20:00"])
            .map(clock => date + "T" + clock + ":00+00:00"));
        expect(nextDueDoses(input, options)).toEqual(expected);
        expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 2, durationUnit: "d" }))
          .toMatchObject({ totalUnits: expected.length, unit: "tab" });
      }
      expect(JSON.stringify(input)).toBe(inputBefore);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });
});


describe("current guard and postfix action ownership", () => {
  const fresh = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

  it("keeps a complete measurement guard on a unitless numeric administration", () => {
    const source = "If SBP > 160 take 1 PO", parsed = parsePublicSig(source);
    const saved = JSON.stringify(parsed);
    for (const input of [parsed.meta.canonical.course!, fresh(parsed.fhir), fresh(parsed.fhirNext)]) {
      const before = JSON.stringify(input);
      const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(1);
      expect(members[0].amounts).toHaveLength(1);
      expect(members[0].amounts![0].quantity).toEqual({ value: 1 });
      expect(members[0].predicate).toEqual({ kind: "measurement", name: "sbp", operation: "gt", value: 160, text: "SBP > 160" });
      expect(members[0].route?.coding?.[0].code).toBe(RouteCode["Oral route"]);
      expect(members[0].asNeeded).not.toBe(true);
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe("Take 1 orally only if SBP > 160.");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
        .toBe("รับประทานครั้งละ 1 เฉพาะเมื่อ SBP > 160.");
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(parsed.fhir[0].text).toBe(source);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(saved);
  });

  it.each([false, true])("keeps a retrospective per-day threshold inside its predicate (separate maximum=%s)", capped => {
    const history = "you took no more than 2 tablets per day last week";
    const source = `Take 1 tablet daily only if ${history}${capped ? ", maximum 4 tablets per day" : ""}`;
    const parsed = parsePublicSig(source), saved = JSON.stringify(parsed);
    for (const input of [parsed.meta.canonical.course!, fresh(parsed.fhir), fresh(parsed.fhirNext)]) {
      const before = JSON.stringify(input);
      const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(1);
      expect(members[0].amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(members[0].predicate).toMatchObject({ kind: "state", name: history, expected: true, text: history });
      expect(members[0].schedule?.recurrence).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
      if (capped) {
        expect(members[0].limits).toHaveLength(1);
        expect(members[0].limits![0]).toMatchObject({ scope: "period",
          amount: { value: 4, unit: "tab" }, period: { value: 1, unit: "d" } });
      } else expect(members[0].limits).toBeUndefined();
      for (const locale of ["en", "th"] as const) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        expect(text).toContain(history);
        expect(text.split(history)).toHaveLength(2);
      }
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(parsed.fhir[0].text).toBe(source);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(saved);
  });

  it.each(["symptomMap", "prnReasonMap"] as const)("uses the existing %s provider to complete a selected state before its limit", map => {
    const source = "Take 1 tablet daily only if breakthrough no more than 4 tablets per day";
    const parsed = parsePublicSig(source, { [map]: {
      "breakthrough symptom": { text: "Breakthrough symptom", aliases: ["breakthrough"] }
    } });
    const saved = JSON.stringify(parsed);
    for (const input of [parsed.meta.canonical.course!, fresh(parsed.fhir), fresh(parsed.fhirNext)]) {
      const before = JSON.stringify(input), member = importCanonicalCourse(input).stages[0].administrations[0];
      expect(member.predicate).toMatchObject({ kind: "state", name: "breakthrough", expected: true });
      expect(member.asNeeded).not.toBe(true);
      expect(member.amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(member.schedule?.recurrence).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
      expect(member.limits).toHaveLength(1);
      expect(member.limits![0]).toMatchObject({ scope: "period", amount: { value: 4, unit: "tab" },
        period: { value: 1, unit: "d" } });
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toContain("only if breakthrough");
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(saved);
  });

  it.each([", and ", "; "])("keeps each postfix condition with its own action across %j", join => {
    const source = "Take 1 tablet daily. Do not drive if dizzy" + join + "call the clinic if symptoms persist.";
    const parsed = parsePublicSig(source), saved = JSON.stringify(parsed);
    for (const input of [parsed.meta.canonical.course!, fresh(parsed.fhir), fresh(parsed.fhirNext)]) {
      const before = JSON.stringify(input);
      const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(1);
      const member = members[0], graph = member.syntax?.instructionGraph;
      expect(member.amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(member.schedule?.recurrence).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
      expect(member.predicate).toBeUndefined();
      expect(graph?.actions).toHaveLength(2);
      expect(graph?.actions[0]).toMatchObject({ predicate: { lemma: "drive" }, polarity: AdvicePolarity.Negate });
      expect(graph?.actions[1].predicate.lemma).toBe("call");
      expect(graph?.actions[1].polarity).not.toBe(AdvicePolarity.Negate);
      expect(graph?.relations?.filter(relation => relation.kind === AdviceRelation.If)).toEqual([
        expect.objectContaining({ toActionIndex: 0, text: "if dizzy" }),
        expect.objectContaining({ toActionIndex: 1, text: "if symptoms persist" })
      ]);
      for (const relation of graph!.relations!.filter(relation => relation.kind === AdviceRelation.If))
        expect(source.slice(relation.span!.start, relation.span!.end)).toBe(relation.text);
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(en.toLowerCase()).toContain("do not drive if dizzy");
      expect(en.toLowerCase()).toContain("call the clinic if symptoms persist");
      expect(en.toLowerCase().match(/drive/gu)).toHaveLength(1);
      expect(en.toLowerCase().match(/call/gu)).toHaveLength(1);
      expect(en.toLowerCase()).not.toContain("do not call");
      expect(th).toContain("เวียนศีรษะ");
      expect(th).toContain("if symptoms persist");
      expect(th).not.toContain("ห้ามติดต่อ");
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(parsed.meta.canonical.clauses[0].rawText).toBe(source);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(saved);
  });

  it.each(["INR=.9", "INR==.9", "INR=0.9."])("retains the complete equality measurement %s", comparison => {
    const source = "Take 1 tablet only if " + comparison, parsed = parsePublicSig(source);
    const saved = JSON.stringify(parsed);
    for (const input of [parsed.meta.canonical.course!, fresh(parsed.fhir), fresh(parsed.fhirNext)]) {
      const before = JSON.stringify(input);
      const members = importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(1);
      expect(members[0].amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(members[0].predicate).toMatchObject({ kind: "measurement", name: "inr", operation: "eq", value: 0.9 });
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe("Take 1 tablet orally only if inr = 0.9.");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
        .toBe("รับประทานครั้งละ 1 เม็ด เฉพาะเมื่อ inr = 0.9.");
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(parsed.fhir[0].text).toBe(source);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(saved);
  });
});
