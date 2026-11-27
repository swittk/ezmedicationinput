import { resolveMedicationInstructionActionForMethod, selectMedicationInstructionMethodCoding } from "../instruction-action-terminology";
/** Compile the EXISTING scoped HPSG clause/regimen into the native clinical
 * course. No FHIR serialization or reconstruction occurs in this module.
 * Source grammar is interpreted once; numerical execution consumes only
 * these normalized facts and preserves syntax as read-only evidence. */
import type { CanonicalSigClause, CanonicalCalendarEventExpr, CanonicalPrnReasonExpr, ParseOptions } from "../types";
import type {
  CanonicalAdministration,
  CanonicalAmount,
  CanonicalMeasure,
  CanonicalRange,
  CanonicalRecurrence,
  CanonicalCourse,
  CanonicalStage,
  CanonicalBoundary,
} from "./course";
import { hasAmountRole, administrationHasAmountFacts, administrationHasDatedStart, administrationHasDatedClockStart } from "./course";
import type { CanonicalParallelRegimen, RegimenPosition } from "../regimen/parallel-course";
import { bodySiteTextConflictsWithCoding, getBodySiteAdministrationTargetCount } from "../body-site-target";
import { getBodySiteText } from "../body-site-lookup";
import {
  ROUTE_BY_SNOMED, ROUTE_SNOMED, getDoseQuantityUnit,
  DEFAULT_PRN_REASON_DEFINITIONS, findPrnReasonDefinitionByCoding, normalizePrnReasonKey
} from "../maps";
import { SNOMED_SYSTEM } from "../snomed";
import { standardTimingCodingFromSig, preferredPreviewTimingCoding as preferredTimingCoding, isPreviewTimingCoding, timingCodeMeaning } from "../timing-summary";
import type { RouteCode } from "../types";
import { getQuantityDurationUnit } from "../unit-lexicon";
import { additionalInstructionFallbackText } from "../advice";

const quantity = (
  value: number | undefined,
  unit?: string,
  comparator?: CanonicalMeasure["comparator"]
): CanonicalMeasure | undefined =>
  value === undefined ? undefined : { value, unit, ...(comparator ? { comparator } : {}) };

/** A single authored time denominator is shared by native and FHIR rate projection. */
export function clinicalQuantityTimeDenominator(
  quantity: NonNullable<CanonicalSigClause["clinicalQuantity"]>
) {
  return quantity.denominators.length === 1 && quantity.denominators[0].dimension === "time"
    ? quantity.denominators[0] : undefined;
}

/** Choose the native rate shape once, preserving an authored numeric time
 * denominator. Protocol adapters only encode this clinical amount. */
export function rateFromClinicalQuantity(
  quantity: NonNullable<CanonicalSigClause["clinicalQuantity"]>
) {
  const period = clinicalQuantityTimeDenominator(quantity);
  if (period && period.value !== 1) return {
    rateRatio: {
      numerator: { value: quantity.numerator.value, unit: quantity.numerator.unit,
        ...(quantity.numerator.comparator ? { comparator: quantity.numerator.comparator } : {}) },
      denominator: { value: period.value, unit: period.unit }
    }
  };
  return { rate: {
    value: quantity.numerator.value / quantity.denominators.reduce((scale, part) => scale * part.value, 1),
    unit: [quantity.numerator.unit, ...quantity.denominators.map(part => part.unit)].join("/"),
    ...(quantity.numerator.comparator ? { comparator: quantity.numerator.comparator } : {})
  } };
}

/** Dimensional quantity has already been resolved by HPSG. Retain a daily
 * total as a rate when no per-administration split was actually stated. */
function amounts(clause: CanonicalSigClause): CanonicalAmount[] | undefined {
  const dose = clause.dose;
  let result: CanonicalAmount | undefined = dose?.range
    ? { range: { low: quantity(dose.range.low, dose.unit), high: quantity(dose.range.high, dose.unit) } }
    : dose?.value !== undefined
    ? { quantity: quantity(dose.value, dose.unit, dose.comparator) }
    : undefined;
  const q = clause.clinicalQuantity;
  if (!q) return result ? [result] : undefined;
  if (q.status !== "resolved") {
    if (q.dailyTotal && q.denominators.some((d) => d.dimension === "time"))
      return [
        {
          rate: quantity(
            q.numerator.value,
            [q.numerator.unit, ...q.denominators.map((d) => d.unit)].join("/"),
            q.numerator.comparator
          ),
        },
      ];
    return result ? [result] : undefined;
  }
  if (q.representation === "dose") return result ? [result] : undefined;
  const projected = q.projectedDose;
  const unchanged =
    result?.quantity &&
    projected &&
    result.quantity.value === projected.value &&
    result.quantity.unit === projected.unit;
  const resolved = unchanged
    ? result!.quantity
    : projected
    ? quantity(projected.value, projected.unit, projected.comparator)
    : undefined;
  if (q.representation === "rate-quantity")
    return [
      {
        ...(resolved ? { quantity: resolved } : result?.range ? { range: result.range } : {}),
        ...rateFromClinicalQuantity(q),
      },
    ];
  const duration = q.administrationDuration ?? clinicalQuantityTimeDenominator(q);
  const numerator = q.rateNumerator ?? projected;
  if (!duration || !numerator || (!projected && !result?.range)) return result ? [result] : undefined;
  return [
    {
      ...(projected ? { quantity: {
        ...resolved,
        ...(projected.system ? { system: projected.system } : {}),
        ...(projected.code ? { code: projected.code } : {}),
      } } : { range: result!.range }),
      rateRatio: {
        numerator: {
          ...quantity(numerator.value, numerator.unit, numerator.comparator),
          ...(numerator.system ? { system: numerator.system } : {}),
          ...(numerator.code ? { code: numerator.code } : {}),
        },
        denominator: quantity(duration.value, duration.unit, duration.comparator),
      },
    },
  ];
}
export function administrationFromClause(
  clause: CanonicalSigClause,
  text?: string,
  stageOrdinal?: number
): CanonicalAdministration {
  const s = clause.schedule;
  // This selected HPSG constituent owns a relative course ending but has no
  // resolved clock. Keep it as the existing unresolved boundary, so numerical
  // execution cannot turn the retained ending words into an unbounded course.
  const relativeEnd = clause.clinicalAdjuncts?.evidence?.find(
    item => item.rule === "hpsg.lex.instruction.relativeCourseEnd");
  let recurrence: CanonicalRecurrence | undefined;
  if (s) {
    const ranged = s.durationIsRange === true ||
      s.durationMax !== undefined && (s.durationMax !== s.duration || s.durationMaxComparator !== undefined ||
        s.durationMaxUnit !== undefined && s.durationMaxUnit !== s.durationUnit);
    recurrence = {
      count: s.count,
      countMax: s.countMax,
      ...(s.sharedCount ? { sharedCount: s.sharedCount } : undefined),
      frequency: s.frequency,
      frequencyMax: s.frequencyMax,
      period: s.period,
      periodMax: s.periodMax,
      periodUnit: s.periodUnit,
      occurrenceDuration: s.administrationDuration,
      occurrenceDurationMax: s.administrationDurationMax,
      occurrenceDurationUnit: s.administrationDurationUnit,
      occurrenceDurationComparator: s.administrationDurationComparator,
      occurrenceDurationRange: s.administrationDurationRange,
      ...(ranged
        ? {
            courseLengthRange: {
              low: quantity(s.duration, s.durationUnit, s.durationComparator),
              high: quantity(s.durationMax, s.durationMaxUnit ?? s.durationUnit, s.durationMaxComparator),
            },
          }
        : { courseLength: quantity(s.duration, s.durationUnit, s.durationComparator) }),
      calendarWindow:
        s.boundsStart || s.boundsEnd
          ? {
              ...(s.boundsStart ? { start: s.boundsStart } : {}),
              ...(s.boundsEnd ? { end: s.boundsEnd } : {}),
            }
          : undefined,
      clocks: s.timeOfDay,
      anchors: s.when,
      dayOfWeek: s.dayOfWeek,
      offset: s.offset,
      offsetMin: s.offsetMin,
      offsetMax: s.offsetMax,
      monthDays: s.dayOfMonth,
      weekdayOrdinal: s.weekdayOrdinal,
      activityTiming: s.activityTiming,
      clockWindow: s.clockWindow,
      eventWindow: s.eventWindow,
      occurrenceCap: s.occurrenceCap,
    };
    if (
      recurrence.frequency === undefined &&
      recurrence.period &&
      recurrence.periodUnit &&
      (recurrence.clocks?.length ?? 0) > 1 &&
      !recurrence.anchors?.length
    ) {
      const clocks = new Set(recurrence.clocks).size;
      if (recurrence.periodUnit === "d") recurrence.frequency = clocks;
      else if (recurrence.periodUnit === "wk" && recurrence.period === 1 && s.dayOfWeek?.length)
        recurrence.frequency = clocks * new Set(s.dayOfWeek).size;
    }
  }
  // An anchored length constrains the absolute window without replacing it.
  const anchoredLength =
    recurrence?.calendarWindow && (recurrence.courseLength || recurrence.courseLengthRange)
      ? { quantity: recurrence.courseLength, range: recurrence.courseLengthRange }
      : undefined;
  if (anchoredLength) {
    recurrence!.courseLength = undefined;
    recurrence!.courseLengthRange = undefined;
  }
  const timingCoding = standardTimingCodingFromSig(s?.timingCode);
  const target = clause.site
    ? {
        text: clause.site.text,
        ...(clause.site.coding ? { coding: [clause.site.coding] } : {}),
      }
    : undefined;
  const administration: CanonicalAdministration = {
    kind: "administration",
    stageOrdinal,
    onsetDays: s?.treatmentStartOffsetDays,
    onsetReference: s?.phaseStartReference,
    phaseEnd: relativeEnd ? { anchor: "unresolved",
      description: relativeEnd.spans.map(span => span.text).join(" ") } : undefined,
    syntax: clause,
    text,
    patientInstruction: clause.patientInstruction,
    additionalInstructions: clause.additionalInstructions?.map((instruction) => ({
      ...(instruction.text !== undefined ? { text: instruction.text } : {}),
      ...(instruction.coding ? { coding: [{
        ...instruction.coding,
        system: instruction.coding.system ?? "http://snomed.info/sct",
      }] } : {}),
    })),
    amounts: amounts(clause),
    schedule: s
      ? {
          recurrence,
          ...(s.timingCode ? { code: timingCoding
            ? { text: s.timingText ?? s.timingCode, coding: [timingCoding] }
            : { text: s.timingText ?? s.timingCode } } : {}),
          ...(s.calendarEvents?.length
            ? {
                explicitEvents: s.calendarEvents.map((event) => event.fhirDateTime ?? event.isoDate),
              }
            : {}),
        }
      : undefined,
    target,
    targetCount: clause.site?.administrationTargetCount ?? getBodySiteAdministrationTargetCount(clause.site),
    route: clause.route
      ? { text: clause.route.text, ...(clause.route.code ? { coding: [{ code: clause.route.code }] } : {}) }
      : undefined,
    method: clause.method
      ? { text: clause.method.text, ...(clause.method.coding ? { coding: [clause.method.coding] } : {}) }
      : undefined,
    asNeeded: clause.prn?.enabled,
    predicate: clause.clinicalAdjuncts?.condition,
    calendarPredicate: clause.clinicalAdjuncts?.calendarDayCondition,
    excludedDates: clause.clinicalAdjuncts?.excludedDates,
    excludedWeekdays: clause.clinicalAdjuncts?.excludedWeekdays,
    delayMinutes: s?.administrationOffsetMinutes,
    cycleDays: s?.cycleDayConstraint,
    anchoredLength,
    ...(s?.maxDosePerPeriod?.length ? { safety: { maximaDeclared: true } } : {}),
    limits: s?.maxDosePerPeriod?.map((limit) => ({
      scope: "period",
      amount: quantity(limit.amount, limit.unit, limit.amountComparator),
      period: quantity(limit.period, limit.periodUnit, limit.periodComparator),
    })),
  };
  if (text !== undefined && clause.instructionGraph?.actions.length && !administrationHasAmountFacts(administration))
    administration.provenance = { format: "syntax", data: {}, sourceTextAgreed: true };
  return administration;
}
/** Calendar tracks use explicit dates; not offsets from treatment start. */
export function precedingCalendarDay(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    return undefined;
  }
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/** Dates without times are inclusive local calendar days, never UTC timestamps. */
export function orderedCalendarBounds(earlier: string, later: string): boolean {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/u;
  if (dateOnly.test(earlier) && dateOnly.test(later)) return earlier < later;
  if (dateOnly.test(earlier) || dateOnly.test(later)) return false;
  const left = Date.parse(earlier);
  const right = Date.parse(later);
  return Number.isFinite(left) && Number.isFinite(right) && left < right;
}

export function clinicalBoundary(
  position: RegimenPosition | { value: number; unit: string }
): CanonicalBoundary {
  return {
    anchor: "treatment-start",
    displacement: {
      value: position.value,
      unit: position.unit,
      code: position.unit,
      system: "http://unitsofmeasure.org",
    },
  };
}
function boundaryForOnset(a: CanonicalAdministration): CanonicalBoundary {
  const boundary: CanonicalBoundary = { anchor: a.onsetReference! };
  if (a.onsetDays !== undefined)
    boundary.displacement = clinicalBoundary({ value: a.onsetDays, unit: "d" }).displacement;
  return boundary;
}
/** Transfer a track-owned calendar cut without replacing authored duration. */
function applyParallelCalendarEnd(a: CanonicalAdministration, end: string | undefined): void {
  if (!end) return;
  const recurrence = (a.schedule ??= {}).recurrence ??= {};
  (recurrence.calendarWindow ??= {}).end = end;
  if (recurrence.courseLength || recurrence.courseLengthRange) {
    a.anchoredLength = { quantity: recurrence.courseLength, range: recurrence.courseLengthRange };
    recurrence.courseLength = undefined;
    recurrence.courseLengthRange = undefined;
  }
}

export function courseFromParallel(
  regimen: Extract<CanonicalParallelRegimen, { kind: "resolved" }>,
  clauseTexts: readonly (string | undefined)[],
  instruction: string
): CanonicalCourse {
  const stages: CanonicalStage[] = [];
  for (const stage of regimen.stages) {
    const administrations: CanonicalAdministration[] = [];
    for (const item of stage.components) {
      const a = administrationFromClause(item.clause, clauseTexts[item.member], stage.sequence);
      // Preserve the authored clause in syntax; the track owns only this
      // earlier execution cut, just as in an unresolved parallel course.
      applyParallelCalendarEnd(a, item.effectiveBoundsEnd);
      a.sourceMember = item.member;
      if (item.phaseOrigin) a.phaseOrigin = clinicalBoundary(item.phaseOrigin).displacement;
      administrations.push(a);
    }
    stages.push({
      administrations,
      ...(stage.sequence > 1 ? { start: clinicalBoundary(stage.start) } : {}),
      ...(stage.end ? { end: clinicalBoundary(stage.end) } : {}),
    });
  }
  return { kind: "course", instruction, stages };
}

/** Preserve independent member origins when global stage cuts are unresolved.
 * Each member retains its own course length; an uncertain transition never
 * supplies the origin or end of another track. */
export function courseFromPartialParallel(
  regimen: Extract<CanonicalParallelRegimen, { kind: "unresolved" }>,
  clauseTexts: readonly (string | undefined)[],
  instruction: string
): CanonicalCourse {
  const administrations: CanonicalAdministration[] = [];
  for (const track of regimen.tracks ?? []) {
    let priorStart = administrations.length, priorEnd = priorStart;
    for (let index = 0; index < track.phases.length; index++) {
      const phase = track.phases[index];
      const phaseStart = administrations.length;
      let predecessors: number[] | undefined;
      let calendarPredecessors: number[] | undefined;
      let finitePredecessors: boolean | undefined;
      let datedReplacement = false;
      for (const item of phase.members) {
        let dependsOnPrevious = false;
        const a = administrationFromClause(item.clause, clauseTexts[item.member], 1);
        a.sourceMember = item.member;
        // An inferred successor cut cannot replace the clause's authored end.
        if (!a.phaseEnd && phase.phaseEnd) a.phaseEnd = phase.phaseEnd;
        // Keep the authored clause in syntax; only this owned execution window
        // receives the calendar end inferred within its independent track.
        applyParallelCalendarEnd(a, item.effectiveBoundsEnd);
        if (a.onsetReference === "treatment-day-start") a.phaseStart = boundaryForOnset(a);
        else if (a.onsetReference === "previous-phase-next-day" && index > 0) {
          a.phaseStart = boundaryForOnset(a);
          dependsOnPrevious = true;
        } else if (a.onsetDays !== undefined)
          a.phaseOrigin = clinicalBoundary({ value: a.onsetDays, unit: "d" }).displacement;
        else if (phase.kind === "relative" && phase.start) {
          if (phase.startReference)
            a.phaseStart = { anchor: phase.startReference, displacement: clinicalBoundary(phase.start).displacement };
          else a.phaseOrigin = clinicalBoundary(phase.start).displacement;
        } else if (!a.schedule?.explicitEvents?.length &&
            (phase.kind === "relative" || index > 0 && !item.clause.schedule?.boundsStart)) {
          // An implicit cut after a declared finite phase belongs to that
          // track's actual completion, never to an unrelated parallel member.
          // Execution retains ownership of the actual count/date arithmetic.
          if (index > 0 && finitePredecessors === undefined) {
            finitePredecessors = priorEnd > priorStart;
            for (let parent = priorStart; finitePredecessors && parent < priorEnd; parent++) {
              const previous = administrations[parent], repeat = previous.schedule?.recurrence;
              const count = repeat?.count ?? repeat?.sharedCount?.count;
              const countMax = repeat?.countMax ?? repeat?.sharedCount?.countMax;
              finitePredecessors = Boolean(previous.phaseEnd || repeat?.calendarWindow?.end ||
                previous.schedule?.explicitEvents?.length ||
                repeat?.courseLength?.value !== undefined &&
                  !repeat.courseLength.comparator ||
                previous.anchoredLength?.quantity?.value !== undefined &&
                  !previous.anchoredLength.quantity.comparator ||
                count !== undefined &&
                  (countMax === undefined || countMax === count) ||
                count === undefined && repeat?.anchors?.length === 1 && repeat.anchors[0] === "IMD" &&
                  !repeat.clocks?.length && repeat.frequency === undefined && repeat.frequencyMax === undefined &&
                  repeat.period === undefined && repeat.periodMax === undefined && repeat.periodUnit === undefined &&
                  (countMax === undefined || countMax === 1));
            }
          }
          if (finitePredecessors) dependsOnPrevious = true;
          else a.phaseStart = { anchor: "unresolved" };
        }
        // A dated replacement still belongs to this track even when its
        // predecessor began earlier. Execution owns the successor's local
        // calendar or clock boundary; the compiler retains only the selected relation.
        if (index > 0 && priorEnd > priorStart && administrationHasDatedStart(a)) {
          dependsOnPrevious = true;
          datedReplacement = true;
        }
        if (!dependsOnPrevious && index > 0 && a.schedule?.explicitEvents?.length) {
          // Retain only the calendar replacement edges already selected by
          // normalization; an unrelated explicit event creates no dependency.
          if (!calendarPredecessors) {
            calendarPredecessors = [];
            for (let parent = priorStart; parent < priorEnd; parent++) {
              if (track.phases[index - 1].members[parent - priorStart].boundsEndBasis !== "next-phase-start") continue;
              const previous = administrations[parent];
              previous.phasePredecessors ??= [];
              calendarPredecessors.push(previous.sourceMember!);
            }
          }
          if (calendarPredecessors.length) {
            a.phasePredecessors = calendarPredecessors;
            datedReplacement = true;
          }
        }
        if (dependsOnPrevious) {
          if (!predecessors) {
            predecessors = [];
            for (let parent = priorStart; parent < priorEnd; parent++) {
              const previous = administrations[parent];
              previous.phasePredecessors ??= [];
              predecessors.push(previous.sourceMember!);
            }
          }
          a.phasePredecessors = predecessors;
        }
        administrations.push(a);
      }
      // Undated members of this selected replacement share its predecessor
      // dependency. Their own clocks remain local to the resolved phase floor.
      const replacementPredecessors = predecessors ?? calendarPredecessors;
      if (datedReplacement && replacementPredecessors) for (let member = phaseStart; member < administrations.length; member++) {
        const a = administrations[member];
        if (a.phaseStart?.anchor === "unresolved") {
          a.phaseStart = undefined;
          a.phasePredecessors = replacementPredecessors;
        }
      }
      priorStart = phaseStart;
      priorEnd = administrations.length;
    }
  }
  return { kind: "course", instruction, stages: [{ administrations }] };
}

/** An unchanged source date keeps its calendar/provenance. Edited native
 * ISO dates supply their own date parts; a source calendar must not reinterpret
 * a replacement date. This is a structural display view, not a date parser. */
function calendarEventsForAdministration(a: CanonicalAdministration): CanonicalCalendarEventExpr[] | undefined {
  const current = a.schedule?.explicitEvents;
  if (!current?.length) return undefined;
  const source = a.syntax?.schedule?.calendarEvents;
  let unchanged = source?.length === current.length;
  if (unchanged) {
    for (let index = 0; index < current.length; index++)
      if ((source![index].fhirDateTime ?? source![index].isoDate) !== current[index]) {
        unchanged = false;
        break;
      }
  }
  if (unchanged) return source;
  const originals = new Map<string, { events: CanonicalCalendarEventExpr[]; next: number }>();
  for (const event of source ?? []) {
    const key = event.fhirDateTime ?? event.isoDate;
    let bucket = originals.get(key);
    if (!bucket) originals.set(key, (bucket = { events: [], next: 0 }));
    bucket.events.push(event);
  }
  const events: CanonicalCalendarEventExpr[] = [];
  for (const value of current) {
    const saved = originals.get(value);
    if (saved && saved.next < saved.events.length) {
      events.push(saved.events[saved.next++]);
      continue;
    }
    // A reduced-precision date has no authored day. Leave it in native
    // explicitEvents for raw realization instead of inventing date parts.
    if (!/^\d{4}-\d{2}-\d{2}(?:$|T)/u.test(value)) continue;
    const isoDate = value.slice(0, 10);
    events.push({
      isoDate,
      ...(value === isoDate ? {} : { fhirDateTime: value }),
      calendar: "gregory",
      calendarYear: Number(value.slice(0, 4)),
      month: Number(value.slice(5, 7)),
      day: Number(value.slice(8, 10)),
      sourceText: value,
    });
  }
  return events.length ? events : undefined;
}

/** Grammar annotations belong to the instruction they describe. An edited
 * native text/code receives a new view, while an untouched instruction keeps
 * its localization and typed source evidence. */
function additionalInstructionsForAdministration(a: CanonicalAdministration): CanonicalSigClause["additionalInstructions"] {
  if (!a.additionalInstructions) return undefined;
  const source = a.syntax?.additionalInstructions;
  const matches = (instruction: NonNullable<CanonicalSigClause["additionalInstructions"]>[number],
    original: NonNullable<typeof source>[number] | undefined) => {
    const code = instruction.coding;
    return original && original.text === instruction.text && code?.code === original.coding?.code &&
      (code?.system ?? "http://snomed.info/sct") === (original.coding?.system ?? "http://snomed.info/sct") &&
      code?.display === original.coding?.display && code?.version === original.coding?.version;
  };
  return a.additionalInstructions.map((instruction, index) => {
    const coding = instruction.coding?.find((entry) => entry.code);
    const text = additionalInstructionFallbackText(instruction, coding);
    const view = { text, coding };
    const original = source?.[index];
    if (matches(view, original)) return original!;
    // Reordering/removing an earlier instruction must not attach its source
    // language evidence to another instruction. Compare typed identities only
    // after the ordinary same-order path has failed.
    for (const item of source ?? []) if (matches(view, item)) return item;
    return view;
  });
}

/** Correct only a recognized label that contradicts the live symptom code.
 * Qualified or opaque authored reasons retain their extra clinical detail. */
function prnReasonForDisplay(reason: CanonicalPrnReasonExpr | undefined): CanonicalPrnReasonExpr | undefined {
  const coding = reason?.coding;
  const label = reason?.text ?? coding?.display;
  if (!reason || !coding?.code || !label) return reason;
  const previous = DEFAULT_PRN_REASON_DEFINITIONS[normalizePrnReasonKey(label)]?.coding;
  const system = coding.system ?? SNOMED_SYSTEM;
  if (!previous?.code || previous.code === coding.code && (previous.system ?? SNOMED_SYSTEM) === system)
    return reason;
  const current = findPrnReasonDefinitionByCoding(system, coding.code);
  const text = current?.text ?? current?.coding?.display;
  if (!current || !text) return reason;
  return Object.assign({}, reason, {
    text, i18n: current.i18n,
    coding: Object.assign({}, coding, {
      display: current.coding?.display ?? text,
      i18n: current.coding?.i18n ?? current.i18n
    })
  });
}

/** The grammar's compact dose range has one shared unit and no endpoint
 * operators. Rich native ranges must retain each independently authored
 * endpoint instead of compressing them into a misleading scalar-unit view. */
export function doseRangeNeedsEndpointPreview(range: CanonicalRange): boolean {
  const low = range.low, high = range.high;
  if (low?.comparator || high?.comparator) return true;
  if (low?.value === undefined || high?.value === undefined) return false;
  const lowUnit = low.unit || getDoseQuantityUnit(low);
  const highUnit = high.unit || getDoseQuantityUnit(high);
  return lowUnit !== highUnit;
}

/** Project native live facts back into the existing grammar realization view.
 * This is NOT a parser and reads no wire object: grammar evidence and source
 * spans remain unchanged; edited dose/schedule/guard values are authoritative.
 */
export function clauseForAdministration(a: CanonicalAdministration, options?: ParseOptions): CanonicalSigClause {
  const rawText=a.syntax?.rawText??a.text??"";
  const base=a.syntax;
  // ES6 object spread is emitted as per-property defineProperty helper loops.
  // A straight shallow copy plus assignments keeps this hot rendering view
  // cheap without caching stale data or copying its source graph recursively.
  const result:CanonicalSigClause=base?Object.assign({},base):{
    kind:"administration",rawText,raw:{text:rawText,start:0,end:rawText.length,tokenIndices:[]},
    leftovers:[],evidence:[],confidence:1
  };
  if (a.provenance?.sourceTextVerified !== undefined)
    result.sourceProjectionVerified = a.provenance.sourceTextVerified;
  if (a.provenance?.sourceHasStructuredClocks !== undefined)
    result.sourceHasStructuredClocks = a.provenance.sourceHasStructuredClocks;
  if (a.provenance?.sourceHasStructuredEvents !== undefined)
    result.sourceHasStructuredEvents = a.provenance.sourceHasStructuredEvents;
  if (a.provenance?.sourceHasStructuredSite !== undefined)
    result.sourceHasStructuredSite = a.provenance.sourceHasStructuredSite;
  const r=a.schedule?.recurrence;
  const length=r?.courseLength??a.anchoredLength?.quantity;
  const range=r?.courseLengthRange??a.anchoredLength?.range;
  // The compact dose has no role or multiple-amount representation. Native
  // amounts remain complete; presentation labels these independent entries.
  const value=a.amounts?.length===1 && !hasAmountRole(a.amounts[0].role) ? a.amounts[0] : undefined;
  if(value?.quantity){
    const unitIdentity = a.target || a.siteReference || value.quantity.unit == null
      ? getDoseQuantityUnit(value.quantity) || undefined : undefined;
    result.dose={value:value.quantity.value,unit:value.quantity.unit ?? unitIdentity,unitIdentity};
    if (base?.dose?.defaulted) {
      result.dose.defaulted = true;
      result.dose.defaultedUnit = base.dose.defaultedUnit;
    }
    if(value.quantity.comparator)result.dose.comparator=value.quantity.comparator;
  }else if(value?.range && !doseRangeNeedsEndpointPreview(value.range))result.dose={range:{low:value.range.low?.value,high:value.range.high?.value},
    unit: getDoseQuantityUnit(value.range.low?.value !== undefined ? value.range.low : value.range.high) ||
      getDoseQuantityUnit(value.range.high?.value !== undefined ? value.range.high : value.range.low) || undefined};
  else result.dose=undefined;
  if(a.schedule){
    const schedule:NonNullable<CanonicalSigClause["schedule"]>=base?.schedule?Object.assign({},base.schedule):{};
    schedule.count=r?.count;schedule.countMax=r?.countMax;
    if(r?.sharedCount)schedule.sharedCount=r.sharedCount;
    else if(schedule.sharedCount)delete schedule.sharedCount;
    schedule.frequency=r?.frequency;schedule.frequencyMax=r?.frequencyMax;
    schedule.period=r?.period;schedule.periodMax=r?.periodMax;schedule.periodUnit=r?.periodUnit;
    schedule.administrationDuration=r?.occurrenceDuration;schedule.administrationDurationMax=r?.occurrenceDurationMax;
    schedule.administrationDurationUnit=r?.occurrenceDurationUnit;
    schedule.administrationDurationComparator=r?.occurrenceDurationComparator;
    schedule.administrationDurationRange=r?.occurrenceDurationRange;
    schedule.duration=length?.value??range?.low?.value;schedule.durationMax=range?.high?.value;
    schedule.durationIsRange=range ? true : undefined;
    const duration = length ?? (range?.low?.value !== undefined ? range.low : range?.high);
    schedule.durationUnit=getQuantityDurationUnit(duration);
    schedule.durationMaxUnit=getQuantityDurationUnit(range?.high);
    schedule.durationUnitLabel=duration?.unit ?? (!schedule.durationUnit ? duration?.code : undefined);
    schedule.durationMaxUnitLabel=range?.high?.unit ?? (!schedule.durationMaxUnit ? range?.high?.code : undefined);
    schedule.durationComparator=length?.comparator??range?.low?.comparator;
    schedule.durationMaxComparator=range?.high?.comparator;
    schedule.boundsStart=r?.calendarWindow?.start;schedule.boundsEnd=r?.calendarWindow?.end;
    if (a.schedule.explicitEvents?.length || base?.schedule?.calendarEvents)
      schedule.calendarEvents=calendarEventsForAdministration(a);
    schedule.timeOfDay=r?.clocks;schedule.when=r?.anchors;schedule.dayOfWeek=r?.dayOfWeek;
    schedule.dayOfMonth=r?.monthDays;schedule.weekdayOrdinal=r?.weekdayOrdinal as typeof schedule.weekdayOrdinal;
    schedule.activityTiming=r?.activityTiming;schedule.eventWindow=r?.eventWindow;schedule.clockWindow=r?.clockWindow;
    schedule.occurrenceCap=r?.occurrenceCap;schedule.offset=r?.offset;schedule.offsetMin=r?.offsetMin;schedule.offsetMax=r?.offsetMax;
    schedule.administrationOffsetMinutes=a.delayMinutes;schedule.cycleDayConstraint=a.cycleDays;
    let limits:NonNullable<typeof schedule.maxDosePerPeriod>|undefined;
    for(const limit of a.limits??[]){
      if(limit.scope!=="period"||!limit.amount||!limit.period)continue;
      (limits??=[]).push({amount:limit.amount.value!,unit:limit.amount.unit??limit.amount.code??"",
        amountComparator:limit.amount.comparator,period:limit.period.value!,
        periodUnit:(limit.period.code??limit.period.unit) as NonNullable<typeof schedule.periodUnit>,periodComparator:limit.period.comparator});
    }
    schedule.maxDosePerPeriod=limits;
    const coding = preferredTimingCoding(a.schedule);
    const literalTimingText = coding !== undefined && !isPreviewTimingCoding(coding);
    schedule.timingCode = literalTimingText ? undefined : timingCodeMeaning(coding) ?? a.schedule.code?.text;
    schedule.timingText = coding
      ? a.schedule.code?.text ?? (literalTimingText ? coding.display ?? coding.code : undefined)
      : undefined;
    schedule.timingTextIsLiteral = literalTimingText ? true : undefined;
    result.schedule=schedule;
  }else result.schedule=undefined;
  result.clinicalAdjuncts=Object.assign({},base?.clinicalAdjuncts,{condition:a.predicate,
    calendarDayCondition:a.calendarPredicate,excludedDates:a.excludedDates,excludedWeekdays:a.excludedWeekdays});
  result.patientInstruction=a.patientInstruction;
  if (a.additionalInstructions || base?.additionalInstructions)
    result.additionalInstructions=additionalInstructionsForAdministration(a);
  result.prn=a.asNeeded===false?undefined:a.asNeeded?Object.assign({},base?.prn,{enabled:true}):base?.prn;
  if (result.prn && a.provenance?.sourceTextVerified === false) {
    const prn = result.prn;
    let reasons = prn.reasons;
    for (let index = 0; index < (prn.reasons?.length ?? 0); index++) {
      const original = prn.reasons![index], current = prnReasonForDisplay(original)!;
      if (current === original) continue;
      if (reasons === prn.reasons) reasons = prn.reasons!.slice();
      reasons![index] = current;
    }
    const reason = prn.reason === prn.reasons?.[0] ? reasons?.[0] : prnReasonForDisplay(prn.reason);
    if (reason !== prn.reason || reasons !== prn.reasons)
      result.prn = Object.assign({}, prn, { reason, reasons });
  }
  let routeCode:RouteCode|undefined;
  for(const coding of a.route?.coding??[]){
    if(!coding.code || coding.system && coding.system!=="http://snomed.info/sct")continue;
    routeCode=ROUTE_BY_SNOMED[coding.code as keyof typeof ROUTE_BY_SNOMED]??
      (!coding.system && Object.prototype.hasOwnProperty.call(ROUTE_SNOMED,coding.code)
        ?coding.code as RouteCode:undefined);
    if(routeCode)break;
  }
  if(a.route){
    const routeText = a.route.text ?? (!routeCode
      ? a.route.coding?.find(coding => coding.display)?.display : undefined);
    const same=routeCode===base?.route?.code&&routeText===base?.route?.text;
    result.route=Object.assign({},same?base?.route:undefined,{code:routeCode,text:routeText});
  }else result.route=undefined;
  let targetCode:NonNullable<NonNullable<typeof a.target>["coding"]>[number]|undefined;
  // Match the interchange decoder's site priority while retaining the full
  // concept on the administration: a local translation is not the preferred
  // clinical site when the same concept also supplies a SNOMED coding.
  for(const code of a.target?.coding??[])if(code.code){
    targetCode??=code;
    if(code.system===SNOMED_SYSTEM){targetCode=code;break;}
  }
  if(a.target){
    const changedCode=base?.site?.coding?.code!==targetCode?.code ||
      (base?.site?.coding?.system??SNOMED_SYSTEM)!==(targetCode?.system??SNOMED_SYSTEM);
    // A failed whole-row source proof does not invalidate a live site's
    // qualified text. Only an exact known contradictory label licenses
    // replacing it; a coarse code keeps the authored lateralized anatomy.
    const staleText = a.provenance?.sourceTextVerified === false && a.target.text &&
      bodySiteTextConflictsWithCoding(a.target.text, targetCode);
    const text=targetCode?.code && (!a.target.text || staleText)
      ? getBodySiteText(targetCode) ?? a.target.text ?? targetCode.display ?? a.siteReference?.display
      : a.target.text ?? a.siteReference?.display;
    // A decoded restriction belongs to the live site, independently of
    // whether its optional text was supplied or derived from that code.
    result.site=Object.assign({},changedCode?undefined:base?.site,{text,administrationTargetCount:a.targetCount});
    if(targetCode?.code)result.site.coding=Object.assign({},targetCode,{code:targetCode.code});
  }else if(a.siteReference?.display)result.site={text:a.siteReference.display,administrationTargetCount:a.targetCount};
  else result.site=undefined;
  const methodCode=selectMedicationInstructionMethodCoding(a.method?.coding, options);
  if(a.method){
    const liveMethod={text:a.method.text,coding:methodCode};
    const text=resolveMedicationInstructionActionForMethod(liveMethod, options)?.display ??
      a.method.text ?? methodCode?.display;
    const same=text===base?.method?.text&&methodCode?.code===base?.method?.coding?.code;
    result.method=Object.assign({},same?base?.method:undefined,{text});
    if(methodCode)result.method.coding=methodCode;
  }else result.method=undefined;
  return result;
}

/** Compose the already-scoped administrations into a single clinical course.
 * Stable stage order belongs here, not to R5 sequences or R6 conversion.
 * Relative phase starts, shared delays and shared ends are lowered from
 * existing typed facts once; independent component timing is not overwritten. */
export function courseFromAdministrations(
  members: readonly CanonicalAdministration[],
  instruction: string,
  cycleInterval?: CanonicalMeasure,
  repeatCount?: number
): CanonicalCourse {
  const byStage = new Map<number, CanonicalAdministration[]>();
  for (const member of members) {
    const key = member.stageOrdinal ?? 1;
    let group = byStage.get(key);
    if (!group) byStage.set(key, (group = []));
    group.push(member);
  }
  const stages: CanonicalStage[] = [];
  for (const key of [...byStage.keys()].sort((a, b) => a - b)) {
    let administrations = byStage.get(key)!;
    const first = administrations[0];
    let start: CanonicalBoundary | undefined;
    const minutes = first.delayMinutes;
    if (
      key === 1 &&
      minutes !== undefined &&
      minutes > 0 &&
      Number.isFinite(minutes) &&
      administrations.every(
        (a) =>
          a.delayMinutes === minutes &&
          // An independently stated origin owns the member delay. Promoting
          // it here would consume it before the contextual boundary replaces it.
          a.onsetDays === undefined && !a.onsetReference &&
          // Even an end-only calendar window keeps its own recurrence origin.
          // Leave the elapsed delay on that member so its grid moves with it.
          !a.schedule?.recurrence?.calendarWindow &&
          !a.schedule?.recurrence?.clocks?.length &&
          !a.schedule?.recurrence?.anchors?.length
      )
    ) {
      // A delay stated in minutes/hours is elapsed time, including full 24h
      // multiples. Calendar-relative onsetDays has its separate path below.
      const unit = minutes % 60 === 0 ? "h" : Number.isInteger(minutes) ? "min" : "s";
      const value = unit === "h" ? minutes / 60 : unit === "min" ? minutes : minutes * 60;
      // Subsecond precision stays on the member delay rather than becoming
      // a fractional boundary in a unit that requires integral offsets.
      if (Number.isInteger(value)) start = clinicalBoundary({ unit, value });
    }
    const onset = first.onsetDays;
    const relative =
      onset !== undefined &&
      onset > 0 &&
      Number.isFinite(onset) &&
      administrations.every((a) => a.onsetDays === onset && !a.onsetReference);
    if (relative) start = clinicalBoundary({ unit: "d", value: onset! });
    else if (start) administrations = administrations.map((a) => ({ ...a, delayMinutes: undefined }));
    const reference = first.onsetReference;
    if (reference && administrations.every(a => a.onsetReference === reference && a.onsetDays === onset))
      start = boundaryForOnset(first);
    else if (administrations.some(a => a.onsetReference || !relative && a.onsetDays !== undefined))
      // A non-shared relation remains a member boundary; do not erase it or
      // silently apply one member's contextual origin to its companions.
      administrations = administrations.map(a => a.onsetReference
        ? { ...a, phaseStart: boundaryForOnset(a) }
        : a.onsetDays !== undefined && a.onsetDays >= 0 && Number.isFinite(a.onsetDays)
          ? { ...a, phaseOrigin: { value: a.onsetDays, unit: "d" } } : a);
    const length = first.schedule?.recurrence?.courseLength;
    const end =
      key === 1 &&
      !start &&
      administrations.length > 1 &&
      length?.value !== undefined &&
      length.value > 0 &&
      Number.isInteger(length.value) &&
      !length.comparator &&
      administrations.every((a) => {
        const r = a.schedule?.recurrence,
          own = r?.courseLength;
        return (
          own?.value === length.value &&
          own?.unit === length.unit &&
          own?.code === length.code &&
          !own?.comparator &&
          (a.delayMinutes ?? 0) === 0 &&
          !a.phaseOrigin && !a.phaseStart &&
          !r?.calendarWindow?.start &&
          !r?.calendarWindow?.end
        );
      })
        ? clinicalBoundary({ value: length.value, unit: length.code ?? length.unit! })
        : undefined;
    // These stage ordinals already encode the selected sequential relation.
    // A dated replacement closes only the preceding stage's recurrences;
    // authored event lists and the original duration retain their owners.
    const previous = stages[stages.length - 1];
    if (previous) {
      let nextStart: string | undefined;
      for (const administration of administrations) {
        const timing = administration.schedule;
        const candidate = timing?.recurrence?.calendarWindow?.start;
        if (candidate && (nextStart === undefined || candidate < nextStart)) nextStart = candidate;
        if (!candidate) for (const event of timing?.explicitEvents ?? [])
          if (nextStart === undefined || event < nextStart) nextStart = event;
      }
      const clockBoundary = administrations.some(administrationHasDatedClockStart) &&
        administrations.every(a => !a.schedule?.recurrence?.calendarWindow?.start && !a.schedule?.explicitEvents?.length ||
          administrationHasDatedClockStart(a));
      const cutoff = nextStart && !clockBoundary ? precedingCalendarDay(nextStart) : undefined;
      if (cutoff) previous.administrations = previous.administrations.map(administration => {
        const timing = administration.schedule, recurrence = timing?.recurrence;
        const window = recurrence?.calendarWindow;
        if (!recurrence || timing?.explicitEvents?.length ||
            window?.end && !orderedCalendarBounds(cutoff, window.end) ||
            window?.start && orderedCalendarBounds(cutoff, window.start)) return administration;
        return { ...administration,
          anchoredLength: administration.anchoredLength ?? (recurrence.courseLength || recurrence.courseLengthRange
            ? { quantity: recurrence.courseLength, range: recurrence.courseLengthRange } : undefined),
          schedule: { ...timing, recurrence: { ...recurrence, calendarWindow: { ...window, end: cutoff },
            courseLength: undefined, courseLengthRange: undefined } } };
      });
    }
    stages.push({
      administrations,
      ...(start ? { start } : {}),
      ...(end ? { end } : {}),
    });
  }
  return { kind: "course", instruction, stages,
    ...(cycleInterval ? { cycleInterval } : {}),
    ...(repeatCount !== undefined ? { cycleCount: repeatCount } : {}) };
}
