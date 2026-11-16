/** Compile the EXISTING scoped HPSG clause/regimen into the native clinical
 * course. No FHIR serialization or reconstruction occurs in this module.
 * Source grammar is interpreted once; numerical execution consumes only
 * these normalized facts and preserves syntax as read-only evidence. */
import type { CanonicalSigClause } from "../types";
import type {
  CanonicalAdministration,
  CanonicalAmount,
  CanonicalMeasure,
  CanonicalRecurrence,
  CanonicalCourse,
  CanonicalStage,
  CanonicalBoundary,
} from "./course";
import type { CanonicalParallelRegimen, RegimenPosition } from "../regimen/parallel-course";
import { getBodySiteAdministrationTargetCount } from "../body-site-target";
import { ROUTE_BY_SNOMED, ROUTE_SNOMED } from "../maps";
import type { RouteCode } from "../types";

const quantity = (
  value: number | undefined,
  unit?: string,
  comparator?: CanonicalMeasure["comparator"]
): CanonicalMeasure | undefined =>
  value === undefined ? undefined : { value, unit, ...(comparator ? { comparator } : {}) };

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
        ...(resolved ? { quantity: resolved } : {}),
        rate: quantity(
          q.numerator.value / q.denominators.reduce((scale, part) => scale * part.value, 1),
          [q.numerator.unit, ...q.denominators.map((part) => part.unit)].join("/"),
          q.numerator.comparator
        ),
      },
    ];
  const duration = q.administrationDuration;
  if (!duration || !projected) return result ? [result] : undefined;
  const numerator = q.rateNumerator ?? projected;
  return [
    {
      quantity: {
        ...resolved,
        ...(projected.system ? { system: projected.system } : {}),
        ...(projected.code ? { code: projected.code } : {}),
      },
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
  let recurrence: CanonicalRecurrence | undefined;
  if (s) {
    const ranged =
      s.durationMax !== undefined && (s.durationMax !== s.duration || s.durationMaxComparator !== undefined);
    recurrence = {
      count: s.count ?? (s.countMax !== undefined ? 1 : undefined),
      countMax: s.countMax,
      frequency: s.frequency,
      frequencyMax: s.frequencyMax,
      period: s.period,
      periodMax: s.periodMax,
      periodUnit: s.periodUnit,
      occurrenceDuration: s.administrationDuration,
      occurrenceDurationMax: s.administrationDurationMax,
      occurrenceDurationUnit: s.administrationDurationUnit,
      ...(ranged
        ? {
            courseLengthRange: {
              low: quantity(s.duration, s.durationUnit, s.durationComparator),
              high: quantity(s.durationMax, s.durationUnit, s.durationMaxComparator),
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
  const target = clause.site
    ? {
        text: clause.site.text,
        ...(clause.site.coding ? { coding: [clause.site.coding] } : {}),
      }
    : undefined;
  return {
    kind: "administration",
    stageOrdinal,
    onsetDays: s?.treatmentStartOffsetDays,
    syntax: clause,
    text,
    patientInstruction: clause.patientInstruction,
    amounts: amounts(clause),
    schedule: s
      ? {
          recurrence,
          ...(s.timingCode ? { code: { text: s.timingCode } } : {}),
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

/** Project native live facts back into the existing grammar realization view.
 * This is NOT a parser and reads no wire object: grammar evidence and source
 * spans remain unchanged; edited dose/schedule/guard values are authoritative.
 */
export function clauseForAdministration(a: CanonicalAdministration): CanonicalSigClause {
  const rawText = a.syntax?.rawText ?? a.text ?? "";
  const base = a.syntax ?? {
    kind: "administration" as const,
    rawText,
    raw: { text: rawText, start: 0, end: rawText.length, tokenIndices: [] },
    leftovers: [],
    evidence: [],
    confidence: 1,
  };
  const r = a.schedule?.recurrence,
    length = r?.courseLength ?? a.anchoredLength?.quantity;
  const lengthRange = r?.courseLengthRange ?? a.anchoredLength?.range;
  const dose = a.amounts?.[0];
  const unit = (length?.code ??
    length?.unit ??
    lengthRange?.low?.code ??
    lengthRange?.low?.unit ??
    lengthRange?.high?.code ??
    lengthRange?.high?.unit) as NonNullable<CanonicalSigClause["schedule"]>["durationUnit"];
  const schedule: CanonicalSigClause["schedule"] = a.schedule
    ? {
        ...base.schedule,
        count: r?.count,
        countMax: r?.countMax,
        frequency: r?.frequency,
        frequencyMax: r?.frequencyMax,
        period: r?.period,
        periodMax: r?.periodMax,
        periodUnit: r?.periodUnit,
        administrationDuration: r?.occurrenceDuration,
        administrationDurationMax: r?.occurrenceDurationMax,
        administrationDurationUnit: r?.occurrenceDurationUnit,
        duration: length?.value ?? lengthRange?.low?.value,
        durationMax: lengthRange?.high?.value,
        durationUnit: unit,
        durationComparator: length?.comparator ?? lengthRange?.low?.comparator,
        durationMaxComparator: lengthRange?.high?.comparator,
        boundsStart: r?.calendarWindow?.start,
        boundsEnd: r?.calendarWindow?.end,
        timeOfDay: r?.clocks,
        when: r?.anchors,
        dayOfWeek: r?.dayOfWeek,
        dayOfMonth: r?.monthDays,
        weekdayOrdinal: r?.weekdayOrdinal as -1 | 1 | 2 | 3 | 4 | 5 | undefined,
        activityTiming: r?.activityTiming,
        eventWindow: r?.eventWindow,
        clockWindow: r?.clockWindow,
        occurrenceCap: r?.occurrenceCap,
        offset: r?.offset,
        offsetMin: r?.offsetMin,
        offsetMax: r?.offsetMax,
        administrationOffsetMinutes: a.delayMinutes,
        cycleDayConstraint: a.cycleDays,
        maxDosePerPeriod: a.limits
          ?.filter((limit) => limit.scope === "period" && limit.amount && limit.period)
          .map((limit) => ({
            amount: limit.amount?.value!,
            unit: limit.amount?.unit ?? limit.amount?.code ?? "",
            amountComparator: limit.amount?.comparator,
            period: limit.period?.value!,
            periodUnit: (limit.period?.code ?? limit.period?.unit) as NonNullable<
              CanonicalSigClause["schedule"]
            >["periodUnit"] &
              string,
            periodComparator: limit.period?.comparator,
          })),
        timingCode: a.schedule.code?.coding?.[0]?.code ?? a.schedule.code?.text ?? base.schedule?.timingCode,
      }
    : undefined;
  const routeIdentity = a.route?.coding?.find((value) => value.code)?.code;
  const routeCode = routeIdentity
    ? ROUTE_BY_SNOMED[routeIdentity as keyof typeof ROUTE_BY_SNOMED] ??
      (Object.prototype.hasOwnProperty.call(ROUTE_SNOMED, routeIdentity)
        ? (routeIdentity as RouteCode)
        : undefined)
    : undefined;
  const targetCode = a.target?.coding?.find((value) => value.code);
  const sameTarget = a.target?.text === base.site?.text && targetCode?.code === base.site?.coding?.code;
  const methodCode = a.method?.coding?.find((value) => value.code);
  const sameMethod = a.method?.text === base.method?.text && methodCode?.code === base.method?.coding?.code;
  return {
    ...base,
    dose: dose?.quantity
      ? {
          value: dose.quantity.value,
          unit: dose.quantity.unit,
          ...(dose.quantity.comparator ? { comparator: dose.quantity.comparator } : {}),
        }
      : dose?.range
      ? {
          range: { low: dose.range.low?.value, high: dose.range.high?.value },
          unit: dose.range.low?.unit ?? dose.range.high?.unit,
        }
      : undefined,
    schedule,
    clinicalAdjuncts: {
      ...base.clinicalAdjuncts,
      condition: a.predicate,
      calendarDayCondition: a.calendarPredicate,
      excludedDates: a.excludedDates,
      excludedWeekdays: a.excludedWeekdays,
    },
    patientInstruction: a.patientInstruction,
    prn: a.asNeeded ? { ...base.prn, enabled: true } : undefined,
    // Vocabulary/translation annotations stay attached to source concepts.
    // Only live native concept values override that evidence.
    site: a.target
      ? {
          ...(sameTarget ? base.site : {}),
          text: a.target.text,
          ...(targetCode?.code ? { coding: { ...targetCode, code: targetCode.code } } : {}),
          administrationTargetCount: a.targetCount,
        }
      : undefined,
    route: a.route
      ? {
          ...(routeCode === base.route?.code && a.route.text === base.route?.text ? base.route : {}),
          code: routeCode,
          text: a.route.text,
        }
      : undefined,
    method: a.method
      ? {
          ...(sameMethod ? base.method : {}),
          text: a.method.text,
          ...(methodCode ? { coding: methodCode } : {}),
        }
      : undefined,
  };
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
      minutes !== undefined &&
      minutes > 0 &&
      Number.isFinite(minutes) &&
      administrations.every(
        (a) =>
          a.delayMinutes === minutes &&
          !a.schedule?.recurrence?.clocks?.length &&
          !a.schedule?.recurrence?.anchors?.length
      )
    ) {
      const unit = minutes % 1440 === 0 ? "d" : minutes % 60 === 0 ? "h" : "min";
      start = clinicalBoundary({
        unit,
        value: unit === "d" ? minutes / 1440 : unit === "h" ? minutes / 60 : minutes,
      });
    }
    const onset = first.onsetDays;
    const relative =
      key >= 2 &&
      onset !== undefined &&
      onset > 0 &&
      Number.isFinite(onset) &&
      administrations.every((a) => a.onsetDays === onset);
    if (relative) start = clinicalBoundary({ unit: "d", value: onset! });
    else if (start) administrations = administrations.map((a) => ({ ...a, delayMinutes: undefined }));
    const length = first.schedule?.recurrence?.courseLength;
    const end =
      key === 1 &&
      administrations.length > 1 &&
      length?.value !== undefined &&
      length.value > 0 &&
      Number.isFinite(length.value) &&
      administrations.every((a) => {
        const r = a.schedule?.recurrence,
          own = r?.courseLength;
        return (
          own?.value === length.value &&
          own?.unit === length.unit &&
          !r?.calendarWindow?.start &&
          !r?.calendarWindow?.end
        );
      })
        ? clinicalBoundary({ value: length.value, unit: length.code ?? length.unit! })
        : undefined;
    stages.push({
      administrations,
      ...(start ? { start } : {}),
      ...(end ? { end } : {}),
      ...(key === 1 && cycleInterval && repeatCount !== undefined ? { count: repeatCount } : {}),
    });
  }
  return { kind: "course", instruction, stages, ...(cycleInterval ? { cycleInterval } : {}) };
}
