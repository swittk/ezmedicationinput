/** Compile the EXISTING scoped HPSG clause/regimen into the native clinical
 * course. No FHIR serialization or reconstruction occurs in this module.
 * Source grammar is interpreted once; numerical execution consumes only
 * these normalized facts and preserves syntax as read-only evidence. */
import type { CanonicalSigClause, CanonicalCalendarEventExpr } from "../types";
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
import type { CanonicalParallelRegimen, RegimenPosition } from "../regimen/parallel-course";
import { getBodySiteAdministrationTargetCount } from "../body-site-target";
import { ROUTE_BY_SNOMED, ROUTE_SNOMED, getDoseQuantityUnit } from "../maps";
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
  let byText: Map<string | undefined, NonNullable<typeof source>[number]> | undefined;
  const matches = (instruction: NonNullable<typeof a.additionalInstructions>[number],
    original: NonNullable<typeof source>[number] | undefined) => {
    const code = instruction.coding?.find((entry) => entry.code);
    return original && original.text === instruction.text && code?.code === original.coding?.code &&
      (code?.system ?? "http://snomed.info/sct") === (original.coding?.system ?? "http://snomed.info/sct") &&
      code?.display === original.coding?.display && code?.version === original.coding?.version;
  };
  return a.additionalInstructions?.map((instruction, index) => {
    const original = source?.[index];
    if (matches(instruction, original)) return original!;
    // Reordering/removing an earlier instruction must not attach its source
    // language evidence to another instruction. Build this lookup only after
    // the ordinary same-order path has failed.
    if (source?.length && !byText) {
      byText = new Map();
      for (const item of source) byText.set(item.text, item);
    }
    const reordered = byText?.get(instruction.text);
    if (matches(instruction, reordered)) return reordered!;
    return { text: instruction.text, coding: instruction.coding?.find((entry) => entry.code) };
  });
}

/** The grammar's compact dose range has one shared unit and no endpoint
 * operators. Rich native ranges must retain each independently authored
 * endpoint instead of compressing them into a misleading scalar-unit view. */
export function doseRangeNeedsEndpointPreview(range: CanonicalRange): boolean {
  const low = range.low, high = range.high;
  return Boolean(low?.comparator || high?.comparator ||
    (low?.value !== undefined && high?.value !== undefined &&
      (low.unit ?? getDoseQuantityUnit(low)) !== (high.unit ?? getDoseQuantityUnit(high))));
}

/** Project native live facts back into the existing grammar realization view.
 * This is NOT a parser and reads no wire object: grammar evidence and source
 * spans remain unchanged; edited dose/schedule/guard values are authoritative.
 */
export function clauseForAdministration(a: CanonicalAdministration): CanonicalSigClause {
  const rawText=a.syntax?.rawText??a.text??"";
  const base=a.syntax;
  // ES6 object spread is emitted as per-property defineProperty helper loops.
  // A straight shallow copy plus assignments keeps this hot rendering view
  // cheap without caching stale data or copying its source graph recursively.
  const result:CanonicalSigClause=base?Object.assign({},base):{
    kind:"administration",rawText,raw:{text:rawText,start:0,end:rawText.length,tokenIndices:[]},
    leftovers:[],evidence:[],confidence:1
  };
  const r=a.schedule?.recurrence;
  const length=r?.courseLength??a.anchoredLength?.quantity;
  const range=r?.courseLengthRange??a.anchoredLength?.range;
  const value=a.amounts?.[0];
  if(value?.quantity){
    result.dose={value:value.quantity.value,unit:value.quantity.unit ?? (getDoseQuantityUnit(value.quantity) || undefined)};
    if(value.quantity.comparator)result.dose.comparator=value.quantity.comparator;
  }else if(value?.range && !doseRangeNeedsEndpointPreview(value.range))result.dose={range:{low:value.range.low?.value,high:value.range.high?.value},
    unit:value.range.low?.unit??value.range.high?.unit??
      (getDoseQuantityUnit(value.range.low) || getDoseQuantityUnit(value.range.high) || undefined)};
  else result.dose=undefined;
  if(a.schedule){
    const schedule:NonNullable<CanonicalSigClause["schedule"]>=base?.schedule?Object.assign({},base.schedule):{};
    schedule.count=r?.count;schedule.countMax=r?.countMax;
    schedule.frequency=r?.frequency;schedule.frequencyMax=r?.frequencyMax;
    schedule.period=r?.period;schedule.periodMax=r?.periodMax;schedule.periodUnit=r?.periodUnit;
    schedule.administrationDuration=r?.occurrenceDuration;schedule.administrationDurationMax=r?.occurrenceDurationMax;
    schedule.administrationDurationUnit=r?.occurrenceDurationUnit;
    schedule.duration=length?.value??range?.low?.value;schedule.durationMax=range?.high?.value;
    schedule.durationUnit=(length?.code??length?.unit??range?.low?.code??range?.low?.unit??range?.high?.code??range?.high?.unit) as typeof schedule.durationUnit;
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
    schedule.timingCode=a.schedule.code?.coding?.[0]?.code??a.schedule.code?.text;
    result.schedule=schedule;
  }else result.schedule=undefined;
  result.clinicalAdjuncts=Object.assign({},base?.clinicalAdjuncts,{condition:a.predicate,
    calendarDayCondition:a.calendarPredicate,excludedDates:a.excludedDates,excludedWeekdays:a.excludedWeekdays});
  result.patientInstruction=a.patientInstruction;
  if (a.additionalInstructions || base?.additionalInstructions)
    result.additionalInstructions=additionalInstructionsForAdministration(a);
  result.prn=a.asNeeded?Object.assign({},base?.prn,{enabled:true}):undefined;
  let routeCode:RouteCode|undefined;
  for(const coding of a.route?.coding??[]){
    if(!coding.code || coding.system && coding.system!=="http://snomed.info/sct")continue;
    routeCode=ROUTE_BY_SNOMED[coding.code as keyof typeof ROUTE_BY_SNOMED]??
      (!coding.system && Object.prototype.hasOwnProperty.call(ROUTE_SNOMED,coding.code)
        ?coding.code as RouteCode:undefined);
    if(routeCode)break;
  }
  if(a.route){
    const same=routeCode===base?.route?.code&&a.route.text===base?.route?.text;
    result.route=Object.assign({},same?base?.route:undefined,{code:routeCode,text:a.route.text});
  }else result.route=undefined;
  let targetCode:NonNullable<NonNullable<typeof a.target>["coding"]>[number]|undefined;
  for(const code of a.target?.coding??[])if(code.code){targetCode=code;break;}
  if(a.target){
    const same=a.target.text===base?.site?.text&&targetCode?.code===base?.site?.coding?.code;
    result.site=Object.assign({},same?base?.site:undefined,{text:a.target.text,administrationTargetCount:a.targetCount});
    if(targetCode?.code)result.site.coding=Object.assign({},targetCode,{code:targetCode.code});
  }else result.site=undefined;
  let methodCode:NonNullable<NonNullable<typeof a.method>["coding"]>[number]|undefined;
  for(const code of a.method?.coding??[])if(code.code){methodCode=code;break;}
  if(a.method){
    const same=a.method.text===base?.method?.text&&methodCode?.code===base?.method?.coding?.code;
    result.method=Object.assign({},same?base?.method:undefined,{text:a.method.text});
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
      !start &&
      administrations.length > 1 &&
      length?.value !== undefined &&
      length.value > 0 &&
      Number.isFinite(length.value) &&
      !length.comparator &&
      administrations.every((a) => {
        const r = a.schedule?.recurrence,
          own = r?.courseLength;
        return (
          own?.value === length.value &&
          own?.unit === length.unit &&
          own?.code === length.code &&
          !own?.comparator &&
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
    });
  }
  return { kind: "course", instruction, stages,
    ...(cycleInterval ? { cycleInterval } : {}),
    ...(repeatCount !== undefined ? { cycleCount: repeatCount } : {}) };
}
