import { formBodySiteRestriction } from "../body-site-grammar";
import { EVENT_TIMING_TOKENS } from "../maps";
import { composeLocalizedRecords } from "../localization";
import { joinLocalizedTokens } from "../locale-realization";
import { ACTION_COORDINATION_CONNECTOR_I18N, CLOCK_LEAD_TOKENS, DOSE_TARGET_DAYPART_CLOCK_RANGES, FIXED_CLOCK_DAYPART_QUALIFICATION_RULE, MEAL_TIMING_BY_RELATION, mealInstructionWording, isNextDayScheduleRule, coordinationConnectorKind } from "./lexical-classes";
import { equalStructuredValues, hashStructuredValue } from "../stable-structure";
import { getUnitCategory } from "../utils/units";
import {
  HpsgDoseFeature,
  HpsgClinicalQuantityDimension,
  HpsgAdministrationTargetFeature,
  HpsgMethodFeature,
  HpsgRouteFeature,
  HpsgScheduleFeature,
  HpsgSign,
  HpsgSiteFeature,
  HpsgPrnFeature,
  HpsgPatientInstructionFeature,
  HpsgInstructionFeature,
  HpsgConditionFeature,
  HpsgClinicalAdjunctFeature,
  HpsgScopedAdministrationFeature,
  HpsgSynsem
} from "./signature";
import { combineSignFeatureStructures } from "./feature-structure";
import { selectHpsgConstruction } from "./constructions";
import { BodySiteSpatialRelation, EventTiming, FhirCoding, FhirPeriodUnit, PrnReasonLookupRequest, RouteCode } from "../types";

export interface HpsgUnificationContext {
  normalizeSiteText(text: string): string;
  isCompatibleRouteRefinement(current: RouteCode | undefined, next: RouteCode): boolean;
  sourceText?(start: number, end: number): string;
}

function sameOptionalScalar<T>(left: T | undefined, right: T | undefined): boolean {
  return left === undefined || right === undefined || left === right;
}

function mergeOptionalScalar<T>(left: T | undefined, right: T | undefined): T | undefined {
  return left !== undefined ? left : right;
}

function mergeI18nRecords(
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!left && !right) {
    return undefined;
  }
  return {
    ...(left ?? {}),
    ...(right ?? {})
  };
}

function sameCoding(left: FhirCoding | undefined, right: FhirCoding | undefined): boolean {
  if (!left?.code || !right?.code) {
    return left?.code === right?.code;
  }
  const leftVersion = (left as FhirCoding & { version?: string }).version;
  const rightVersion = (right as FhirCoding & { version?: string }).version;
  return (
    left.code === right.code &&
    (left.system ?? "http://snomed.info/sct") ===
      (right.system ?? "http://snomed.info/sct") &&
    leftVersion === rightVersion
  );
}

function sameOptionalText(left: string | undefined, right: string | undefined): boolean {
  return (left ?? "") === (right ?? "");
}

function sameSpatialRelation(
  left: BodySiteSpatialRelation | undefined,
  right: BodySiteSpatialRelation | undefined
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return (
    left.relationText === right.relationText &&
    sameCoding(left.relationCoding, right.relationCoding) &&
    sameOptionalText(left.targetText, right.targetText) &&
    sameCoding(left.targetCoding, right.targetCoding) &&
    sameOptionalText(left.sourceText, right.sourceText)
  );
}

function mergeMethod(
  left: HpsgMethodFeature | undefined,
  right: HpsgMethodFeature | undefined
): HpsgMethodFeature | undefined {
  if (!left) return right;
  if (!right) return left;
  const leftClass = left.headClass ?? "administration";
  const rightClass = right.headClass ?? "administration";
  if (leftClass !== rightClass) return leftClass === "administration" ? left : right;
  if (left.verb !== right.verb) return undefined;
  const preferred = (right.text?.length ?? 0) > (left.text?.length ?? 0) ? right : left;
  const other = preferred === left ? right : left;
  return {
    verb: left.verb,
    headClass: leftClass,
    text: preferred.text ?? other.text,
    textElement: preferred.textElement ?? other.textElement,
    coding: preferred.coding ?? other.coding
  };
}

type AttachmentClass = "administration" | "procedure";

function attachmentClass(value: AttachmentClass | undefined): AttachmentClass {
  return value ?? "administration";
}

function preferredAttachment<T extends { attachmentClass?: AttachmentClass }>(left: T, right: T): T | undefined {
  const leftClass = attachmentClass(left.attachmentClass);
  const rightClass = attachmentClass(right.attachmentClass);
  if (leftClass === rightClass) return undefined;
  return leftClass === "administration" ? left : right;
}

function mergeRoute(
  left: HpsgRouteFeature | undefined,
  right: HpsgRouteFeature | undefined,
  context: HpsgUnificationContext
): HpsgRouteFeature | undefined {
  if (!left) return right;
  if (!right) return left;
  const preferred = preferredAttachment(left, right);
  if (preferred) return preferred;
  const mergedClass = attachmentClass(left.attachmentClass);
  if (left.code === right.code) {
    return {
      code: left.code,
      attachmentClass: mergedClass,
      text: mergeOptionalScalar(left.text, right.text)
    };
  }
  if (context.isCompatibleRouteRefinement(left.code, right.code)) {
    return { code: right.code, attachmentClass: mergedClass, text: right.text };
  }
  if (context.isCompatibleRouteRefinement(right.code, left.code)) {
    return { code: left.code, attachmentClass: mergedClass, text: left.text };
  }
  return undefined;
}

function mergeSite(
  left: HpsgSiteFeature | undefined,
  right: HpsgSiteFeature | undefined,
  context: HpsgUnificationContext
): HpsgSiteFeature | undefined {
  if (!left) return right;
  if (!right) return left;
  const preferred = preferredAttachment(left, right);
  if (preferred) return preferred;
  const mergedClass = attachmentClass(left.attachmentClass);
  if (
    left.text &&
    right.text &&
    context.normalizeSiteText(left.text) !== context.normalizeSiteText(right.text)
  ) {
    return undefined;
  }
  if (left.coding && right.coding && !sameCoding(left.coding, right.coding)) {
    return undefined;
  }
  if (
    left.spatialRelation &&
    right.spatialRelation &&
    !sameSpatialRelation(left.spatialRelation, right.spatialRelation)
  ) {
    return undefined;
  }
  return {
    attachmentClass: mergedClass,
    text: mergeOptionalScalar(left.text, right.text),
    i18n: mergeI18nRecords(left.i18n, right.i18n),
    source: mergeOptionalScalar(left.source, right.source),
    coding: mergeOptionalScalar(left.coding, right.coding),
    spatialRelation: mergeOptionalScalar(left.spatialRelation, right.spatialRelation),
    restrictions: appendUniqueStructured(left.restrictions, right.restrictions),
    lookupRequest: mergeOptionalScalar(left.lookupRequest, right.lookupRequest),
    administrationTargetCount: mergeOptionalScalar(
      left.administrationTargetCount,
      right.administrationTargetCount
    ),
    range: left.range ?? right.range,
    coordination: left.coordination ?? right.coordination
  };
}

function atomicSite(site: HpsgSiteFeature): HpsgAdministrationTargetFeature {
  const { coordination: _coordination, ...target } = site;
  return target;
}

function siteTargets(site: HpsgSiteFeature): HpsgAdministrationTargetFeature[] {
  return site.coordination?.targets.map((target) => ({ ...target })) ?? [atomicSite(site)];
}

function coordinatedSite(
  left: HpsgSiteFeature,
  right: HpsgSiteFeature,
  marker: "conjunction" | "disjunction",
  context: HpsgUnificationContext
): HpsgSiteFeature | undefined {
  const preferred = preferredAttachment(left, right);
  if (preferred) return undefined;
  const leftRange = left.coordination?.range ?? left.range;
  const rightRange = right.coordination?.range ?? right.range;
  if (!leftRange || !rightRange) return undefined;
  const range = {
    start: Math.min(leftRange.start, rightRange.start),
    end: Math.max(leftRange.end, rightRange.end)
  };
  const prior = left.coordination?.coordination ?? right.coordination?.coordination;
  const coordination = prior && prior !== marker ? "mixed" : prior ?? marker;
  const targets: HpsgAdministrationTargetFeature[] = [];
  for (const target of [...siteTargets(left), ...siteTargets(right)]) {
    const duplicate = targets.some((candidate) =>
      candidate.range?.start === target.range?.start &&
      candidate.range?.end === target.range?.end &&
      candidate.text === target.text &&
      sameCoding(candidate.coding, target.coding)
    );
    if (!duplicate) targets.push({ ...target });
  }
  const sourceText = context.sourceText?.(range.start, range.end) ??
    targets.map((target) => target.text).filter(Boolean).join(
      marker === "disjunction" ? " or " : " and "
    );
  const connectorKey = marker === "disjunction" ? "or" : "and";
  const connector = { en: connectorKey, ...ACTION_COORDINATION_CONNECTOR_I18N[connectorKey] };
  const memberDisplay = (site: HpsgSiteFeature): Record<string, string> => {
    const display: Record<string, string> = { en: site.text ?? "", ...(site.i18n ?? {}) };
    for (const locale of Object.keys(connector)) {
      // An untranslated custom site keeps its own name inside the localized
      // coordination instead of forcing the whole phrase back to its source.
      if (!display[locale]) display[locale] = site.text ?? "";
    }
    return display;
  };
  const i18n = composeLocalizedRecords(
    [memberDisplay(left), connector, memberDisplay(right)],
    (members, locale) => joinLocalizedTokens(locale, members)
  );
  return {
    attachmentClass: attachmentClass(left.attachmentClass),
    text: i18n?.en ?? sourceText,
    i18n,
    source: "text",
    range,
    coordination: { coordination, sourceText, range, targets }
  };
}

function mergePrn(
  left: HpsgPrnFeature | undefined,
  right: HpsgPrnFeature | undefined
): HpsgPrnFeature | undefined {
  if (!left) return right;
  if (!right) return left;

  const reasons = mergePrnReasons(left.reasons, right.reasons);
  const lookupRequests = mergePrnLookupRequests(left.lookupRequests, right.lookupRequests);
  const mergedReasonText = mergeCoordinatedText(left.reasonText, right.reasonText);
  if (!sameOptionalScalar(left.triggerPhase, right.triggerPhase)) return undefined;
  if (!reasons?.length && !sameOptionalScalar(left.reasonText, right.reasonText)) {
    return undefined;
  }
  return {
    enabled: true,
    reasonText: mergedReasonText,
    triggerPhase: mergeOptionalScalar(left.triggerPhase, right.triggerPhase),
    lookupRequest: mergeOptionalScalar(left.lookupRequest, right.lookupRequest),
    reasons,
    lookupRequests
  };
}

function mergeCoordinatedText(
  left: string | undefined,
  right: string | undefined
): string | undefined {
  if (!left) return right;
  if (!right) return left;
  if (left === right) return left;
  return `${left} or ${right}`;
}

function mergePrnReasons(
  left: HpsgPrnFeature["reasons"] | undefined,
  right: HpsgPrnFeature["reasons"] | undefined
): HpsgPrnFeature["reasons"] | undefined {
  const result: NonNullable<HpsgPrnFeature["reasons"]> = [];
  for (const reason of [...(left ?? []), ...(right ?? [])]) {
    if (!result.some((candidate) =>
      candidate.text === reason.text &&
      candidate.triggerPhase === reason.triggerPhase &&
      samePrnLookupRequest(candidate.lookupRequest, reason.lookupRequest)
    )) {
      result.push(reason);
    }
  }
  return result.length ? result : undefined;
}

function samePrnLookupRequest(
  left: PrnReasonLookupRequest | undefined,
  right: PrnReasonLookupRequest | undefined
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return (
    left.originalText === right.originalText &&
    left.text === right.text &&
    left.normalized === right.normalized &&
    left.canonical === right.canonical &&
    sameOptionalText(left.headCanonical, right.headCanonical) &&
    sameOptionalText(left.locativeSiteCanonical, right.locativeSiteCanonical) &&
    sameCoding(left.locativeSiteCoding, right.locativeSiteCoding) &&
    sameSpatialRelation(left.locativeSiteSpatialRelation, right.locativeSiteSpatialRelation) &&
    left.isProbe === right.isProbe &&
    left.inputText === right.inputText &&
    sameOptionalText(left.sourceText, right.sourceText) &&
    (left.range?.start ?? -1) === (right.range?.start ?? -1) &&
    (left.range?.end ?? -1) === (right.range?.end ?? -1)
  );
}

function mergePrnLookupRequests(
  left: HpsgPrnFeature["lookupRequests"] | undefined,
  right: HpsgPrnFeature["lookupRequests"] | undefined
): HpsgPrnFeature["lookupRequests"] | undefined {
  const result: NonNullable<HpsgPrnFeature["lookupRequests"]> = [];
  for (const request of [...(left ?? []), ...(right ?? [])]) {
    if (!result.some((candidate) => samePrnLookupRequest(candidate, request))) {
      result.push(request);
    }
  }
  return result.length ? result : undefined;
}

function mergeInstructions(
  left: HpsgInstructionFeature[] | undefined,
  right: HpsgInstructionFeature[] | undefined
): HpsgInstructionFeature[] | undefined {
  const result: HpsgInstructionFeature[] = [];
  for (const instruction of [...(left ?? []), ...(right ?? [])]) {
    if (
      !result.some((candidate) =>
        candidate.text === instruction.text &&
        sameCoding(candidate.coding, instruction.coding)
      )
    ) {
      result.push(instruction);
    }
  }
  return result.length ? result : undefined;
}

function mergePatientInstruction(
  left: HpsgPatientInstructionFeature | undefined,
  right: HpsgPatientInstructionFeature | undefined
): HpsgPatientInstructionFeature | undefined {
  if (!left) return right;
  if (!right) return left;
  if (left.text === right.text) return left;
  return { text: `${left.text}; ${right.text}` };
}

function mergeCoordinationMarker(
  left: HpsgSynsem["cont"]["coordinationMarker"],
  right: HpsgSynsem["cont"]["coordinationMarker"]
): HpsgSynsem["cont"]["coordinationMarker"] | undefined {
  if (!left) return right;
  if (!right) return left;
  return left.coordination === right.coordination ? left : undefined;
}

function mergeStructuredFeature<T>(left: T | undefined, right: T | undefined): T | undefined {
  if (!left) return right;
  if (!right) return left;
  return equalStructuredValues(left, right) ? left : undefined;
}

function mergeDose(
  left: HpsgDoseFeature | undefined,
  right: HpsgDoseFeature | undefined
): HpsgDoseFeature | undefined {
  if (!left) return right;
  if (!right) return left;
  const preferred = preferredAttachment(left, right);
  if (preferred) return preferred;
  const mergedClass = attachmentClass(left.attachmentClass);
  if (!sameOptionalScalar(left.value, right.value) ||
      !sameOptionalScalar(left.divisionCount, right.divisionCount)) {
    return undefined;
  }
  if (!sameOptionalScalar(left.unit, right.unit) ||
      !sameOptionalScalar(left.comparator, right.comparator)) {
    return undefined;
  }
  if (
    left.range &&
    right.range &&
    (left.range.low !== right.range.low || left.range.high !== right.range.high)
  ) {
    return undefined;
  }
  let clinicalQuantity = mergeStructuredFeature(left.clinicalQuantity, right.clinicalQuantity);
  if (!clinicalQuantity && left.clinicalQuantity && right.clinicalQuantity) return undefined;
  let value = mergeOptionalScalar(left.value, right.value);
  let unit = mergeOptionalScalar(left.unit, right.unit);
  let range = mergeOptionalScalar(left.range, right.range);
  const divisionCount = mergeOptionalScalar(left.divisionCount, right.divisionCount);
  if (clinicalQuantity && divisionCount !== undefined && clinicalQuantity.dividedDoseCount !== divisionCount &&
      clinicalQuantity.status !== "unsupported" &&
      clinicalQuantity.denominators.some(term => term.dimension === "time")) {
    // An explicit division turns a standalone weight/time total into doses
    // over its authored period. A separately authored amount keeps an
    // independent infusion rate unchanged, whichever daughter arrives first.
    const dividedWeightTotal = clinicalQuantity.representation === "rate-quantity" &&
      clinicalQuantity.requiresPatientWeight && !clinicalQuantity.projectedDose && value === undefined &&
      range === undefined &&
      !clinicalQuantity.administrationDuration;
    const independentRate = clinicalQuantity.representation === "rate-quantity" && !dividedWeightTotal;
    const rangedActiveDose = range !== undefined && (independentRate ||
      clinicalQuantity.representation === "dose-with-rate-ratio");
    const activeDose = clinicalQuantity.projectedDose ??
      (independentRate || rangedActiveDose
        ? value !== undefined && unit ? {
            value, unit, comparator: mergeOptionalScalar(left.comparator, right.comparator)
          } : undefined
        : clinicalQuantity.numerator);
    if (activeDose) {
      let doseUnit = activeDose.unit;
      // A separate authored dose already owns its unit; patient-mass
      // denominators on an independent infusion rate cannot qualify it.
      if (!clinicalQuantity.projectedDose && !independentRate) {
        for (const term of clinicalQuantity.denominators)
          if (term.dimension !== "time") doseUnit += "/" + term.unit;
      }
      value = activeDose.value / divisionCount;
      unit = doseUnit;
      clinicalQuantity = {
        ...clinicalQuantity, status: "resolved", reviewReason: undefined,
        ...(dividedWeightTotal ? { representation: "dose" as const } : {}),
        // A carrier preparation also divides its separate administered volume.
        // Its original total stays in numerator; an independent fixed flow-rate
        // numerator stays unchanged.
        ...(clinicalQuantity.rateNumerator ? { rateNumerator: {
          ...clinicalQuantity.rateNumerator, value: clinicalQuantity.rateNumerator.value / divisionCount
        } } : {}),
        dividedDoseCount: divisionCount, projectedDose: {
          value, unit, ...(activeDose.comparator
            ? { comparator: activeDose.comparator } : {})
        }
      };
    } else if (rangedActiveDose && range && unit) {
      // Divide the authored active range. A carrier preparation also divides
      // its separate volume; an independent flow rate keeps its numerator.
      range = {
        low: range.low === undefined ? undefined : range.low / divisionCount,
        high: range.high === undefined ? undefined : range.high / divisionCount,
      };
      clinicalQuantity = { ...clinicalQuantity, dividedDoseCount: divisionCount,
        ...(clinicalQuantity.rateNumerator ? { rateNumerator: {
          ...clinicalQuantity.rateNumerator, value: clinicalQuantity.rateNumerator.value / divisionCount
        } } : {}) };
    }
  } else if (clinicalQuantity?.representation === "rate-quantity" && value !== undefined && unit) {
    // Independently supplied volume and rate are compatible arguments of one
    // administration. Neither may erase the other during feature unification.
    const comparator = mergeOptionalScalar(left.comparator, right.comparator);
    clinicalQuantity = { ...clinicalQuantity, projectedDose: {
      value, unit, ...(comparator ? { comparator } : {})
    } };
  }
  return {
    attachmentClass: mergedClass,
    value,
    range,
    unit,
    comparator: mergeOptionalScalar(left.comparator, right.comparator),
    clinicalQuantity,
    divisionCount
  };
}

function appendUnique<T>(left: T[] | undefined, right: T[] | undefined): T[] | undefined {
  const result: T[] = [];
  for (const item of left ?? []) {
    if (result.indexOf(item) === -1) {
      result.push(item);
    }
  }
  for (const item of right ?? []) {
    if (result.indexOf(item) === -1) {
      result.push(item);
    }
  }
  return result.length ? result : undefined;
}

function appendUniqueStructured<T>(left: T[] | undefined, right: T[] | undefined): T[] | undefined {
  const result: T[] = [];
  const seen = new Map<number, T[]>();
  for (const items of [left, right]) {
    for (const item of items ?? []) {
      const hash = hashStructuredValue(item);
      const bucket = seen.get(hash);
      if (bucket?.some(candidate => equalStructuredValues(candidate, item))) continue;
      if (bucket) bucket.push(item);
      else seen.set(hash, [item]);
      result.push(item);
    }
  }
  return result.length ? result : undefined;
}

function sameOccurrenceCap(
  left: HpsgScheduleFeature["occurrenceCap"],
  right: HpsgScheduleFeature["occurrenceCap"]
): boolean {
  if (!left || !right) return left === right;
  return left.max === right.max && left.period === right.period && left.periodUnit === right.periodUnit;
}

function sameRepeatCycle(
  left: HpsgScheduleFeature["repeatCycle"],
  right: HpsgScheduleFeature["repeatCycle"]
): boolean {
  if (!left || !right) return left === right;
  return left.value === right.value && left.comparator === right.comparator &&
    left.unit === right.unit && left.system === right.system && left.code === right.code;
}

function sameEventWindow(
  left: HpsgScheduleFeature["eventWindow"], right: HpsgScheduleFeature["eventWindow"]
): boolean {
  return !left || !right || left.start === right.start && left.end === right.end;
}

function mergeSchedule(
  left: HpsgScheduleFeature | undefined,
  right: HpsgScheduleFeature | undefined
): HpsgScheduleFeature | undefined {
  if (!left) return right;
  if (!right) return left;
  const preferred = preferredAttachment(left, right);
  if (preferred) return preferred;
  const mergedClass = attachmentClass(left.attachmentClass);
  if (
    (left.cycleDayConstraint && right.cycleDayConstraint &&
      !equalStructuredValues(left.cycleDayConstraint, right.cycleDayConstraint)) ||
    !sameOptionalScalar(left.timingCode, right.timingCode) ||
    !sameOptionalScalar(left.timingReference, right.timingReference) ||
    !sameOptionalScalar(left.treatmentStartOffsetDays, right.treatmentStartOffsetDays) ||
    !sameOptionalScalar(left.phaseStartReference, right.phaseStartReference) ||
    !sameOptionalScalar(left.count, right.count) ||
    !sameOptionalScalar(left.countMax, right.countMax) ||
    !sameOptionalScalar(left.duration, right.duration) ||
    !sameOptionalScalar(left.durationMax, right.durationMax) ||
    !sameOptionalScalar(left.durationUnit, right.durationUnit) ||
    !sameOptionalScalar(left.administrationOffsetMinutes, right.administrationOffsetMinutes) ||
    !sameOptionalScalar(left.boundsStart, right.boundsStart) ||
    !sameOptionalScalar(left.boundsEnd, right.boundsEnd) ||
    !sameOptionalScalar(left.frequency, right.frequency) ||
    !sameOptionalScalar(left.frequencyMax, right.frequencyMax) ||
    !sameOptionalScalar(left.period, right.period) ||
    !sameOptionalScalar(left.periodMax, right.periodMax) ||
    !sameOptionalScalar(left.periodUnit, right.periodUnit) ||
    (left.clockWindow && right.clockWindow && (
      left.clockWindow.start !== right.clockWindow.start || left.clockWindow.end !== right.clockWindow.end ||
      left.clockWindow.endInclusive !== right.clockWindow.endInclusive)) ||
    !sameOptionalScalar(left.weekdayOrdinal, right.weekdayOrdinal) ||
    !sameOptionalScalar(left.offset, right.offset) ||
    !sameOptionalScalar(left.offsetMin, right.offsetMin) ||
    !sameOptionalScalar(left.offsetMax, right.offsetMax) ||
    !sameOptionalScalar(left.repeatCount, right.repeatCount) ||
    (!sameRepeatCycle(left.repeatCycle, right.repeatCycle) && Boolean(left.repeatCycle && right.repeatCycle)) ||
    !sameEventWindow(left.eventWindow, right.eventWindow) ||
    (!sameOccurrenceCap(left.occurrenceCap, right.occurrenceCap) && Boolean(left.occurrenceCap && right.occurrenceCap))
  ) {
    return undefined;
  }
  return {
    attachmentClass: mergedClass,
    cycleDayConstraint: left.cycleDayConstraint ?? right.cycleDayConstraint,
    sourceRanges: appendUniqueStructured(left.sourceRanges, right.sourceRanges),
    timingCode: mergeOptionalScalar(left.timingCode, right.timingCode),
    timingReference: mergeOptionalScalar(left.timingReference, right.timingReference),
    treatmentStartOffsetDays: mergeOptionalScalar(left.treatmentStartOffsetDays, right.treatmentStartOffsetDays),
    phaseStartReference: mergeOptionalScalar(left.phaseStartReference, right.phaseStartReference),
    count: mergeOptionalScalar(left.count, right.count),
    countMax: mergeOptionalScalar(left.countMax, right.countMax),
    duration: mergeOptionalScalar(left.duration, right.duration),
    durationMax: mergeOptionalScalar(left.durationMax, right.durationMax),
    durationUnit: mergeOptionalScalar(left.durationUnit, right.durationUnit),
    administrationOffsetMinutes: mergeOptionalScalar(
      left.administrationOffsetMinutes, right.administrationOffsetMinutes
    ),
    boundsStart: mergeOptionalScalar(left.boundsStart, right.boundsStart),
    boundsEnd: mergeOptionalScalar(left.boundsEnd, right.boundsEnd),
    frequency: mergeOptionalScalar(left.frequency, right.frequency),
    frequencyMax: mergeOptionalScalar(left.frequencyMax, right.frequencyMax),
    period: mergeOptionalScalar(left.period, right.period),
    periodMax: mergeOptionalScalar(left.periodMax, right.periodMax),
    periodUnit: mergeOptionalScalar(left.periodUnit, right.periodUnit),
    clockWindow: left.clockWindow ?? right.clockWindow,
    weekdayOrdinal: mergeOptionalScalar(left.weekdayOrdinal, right.weekdayOrdinal),
    offset: mergeOptionalScalar(left.offset, right.offset),
    offsetMin: mergeOptionalScalar(left.offsetMin, right.offsetMin),
    offsetMax: mergeOptionalScalar(left.offsetMax, right.offsetMax),
    repeatCycle: left.repeatCycle ?? right.repeatCycle,
    repeatCount: mergeOptionalScalar(left.repeatCount, right.repeatCount),
    when: appendUnique(left.when, right.when),
    dayOfWeek: appendUnique(left.dayOfWeek, right.dayOfWeek),
    dayOfMonth: appendUnique(left.dayOfMonth, right.dayOfMonth),
    timeOfDay: appendUnique(left.timeOfDay, right.timeOfDay),
    calendarEvents: appendUniqueStructured(left.calendarEvents, right.calendarEvents),
    activityTiming: appendUniqueStructured(left.activityTiming, right.activityTiming),
    eventWindow: left.eventWindow ?? right.eventWindow,
    occurrenceCap: left.occurrenceCap ?? right.occurrenceCap,
    maxDosePerPeriod: appendUniqueStructured(left.maxDosePerPeriod, right.maxDosePerPeriod)
  };
}

function sameCondition(left: HpsgConditionFeature | undefined, right: HpsgConditionFeature | undefined): boolean {
  if (!left || !right) return left === right;
  return left.relation === right.relation &&
    left.sourceStart === right.sourceStart && left.sourceEnd === right.sourceEnd &&
    left.targetStart === right.targetStart && left.targetEnd === right.targetEnd;
}

function mergeCondition(
  left: HpsgConditionFeature | undefined,
  right: HpsgConditionFeature | undefined
): HpsgConditionFeature | undefined {
  if (!left) return right;
  if (!right) return left;
  return sameCondition(left, right) ? left : undefined;
}

function mergeClinicalAdjunct(
  left: HpsgClinicalAdjunctFeature | undefined,
  right: HpsgClinicalAdjunctFeature | undefined
): HpsgClinicalAdjunctFeature | undefined {
  if (!left) return right;
  if (!right) return left;
  if (left.condition && right.condition &&
      !equalStructuredValues(left.condition, right.condition)) {
    return undefined;
  }
  if (left.conditionTarget && right.conditionTarget &&
      !equalStructuredValues(left.conditionTarget, right.conditionTarget)) return undefined;
  if (left.calendarDayCondition && right.calendarDayCondition &&
      !equalStructuredValues(left.calendarDayCondition, right.calendarDayCondition)) return undefined;
  if (left.treatmentPause && right.treatmentPause &&
      !equalStructuredValues(left.treatmentPause, right.treatmentPause)) return undefined;
  return {
    treatmentPause: left.treatmentPause ?? right.treatmentPause,
    condition: left.condition ?? right.condition,
    calendarDayCondition: left.calendarDayCondition ?? right.calendarDayCondition,
    conditionTarget: left.conditionTarget ?? right.conditionTarget,
    excludedDates: appendUnique(left.excludedDates, right.excludedDates),
    excludedWeekdays: appendUnique(left.excludedWeekdays, right.excludedWeekdays),
    unresolved: left.unresolved || right.unresolved ? true : undefined,
    localRanges: appendUniqueStructured(left.localRanges, right.localRanges) ?? [],
    evidence: appendUniqueStructured(left.evidence, right.evidence) ?? []
  };
}

function mergeScopedAdministrations(
  left: HpsgScopedAdministrationFeature[] | undefined,
  right: HpsgScopedAdministrationFeature[] | undefined
): HpsgScopedAdministrationFeature[] | undefined {
  const result: HpsgScopedAdministrationFeature[] = [];
  for (const value of [...(left ?? []), ...(right ?? [])]) {
    if (!result.some((candidate) => sameCondition(candidate.condition, value.condition))) result.push(value);
  }
  return result.length ? result : undefined;
}

function mergeScopeRequirements(
  left: HpsgConditionFeature[] | undefined,
  right: HpsgConditionFeature[] | undefined
): HpsgConditionFeature[] | undefined {
  const result: HpsgConditionFeature[] = [];
  for (const value of [...(left ?? []), ...(right ?? [])]) {
    if (!result.some((candidate) => sameCondition(candidate, value))) result.push(value);
  }
  return result.length ? result : undefined;
}

function scopedInstruction(
  condition: HpsgConditionFeature,
  target: HpsgSynsem
): HpsgInstructionFeature[] | undefined {
  if (!condition.safety) return target.valence.instructions;
  // The selected condition owns these action daughters regardless of their
  // surface normalization. Keep unrelated or unframed instructions separate.
  const targetInstructions = (target.valence.instructions ?? []).filter((instruction) =>
    !instruction.frames?.length || !instruction.frames.every(frame =>
      condition.frames.some(selected =>
        selected.predicate.lemma === frame.predicate.lemma &&
        selected.polarity === frame.polarity &&
        selected.span.start <= frame.span.start && frame.span.end <= selected.span.end
      )
    )
  );
  return mergeInstructions(
    [{ text: condition.fullText, frames: condition.frames }],
    targetInstructions
  );
}

function scopeSynsem(conditionSign: HpsgSign, targetSign: HpsgSign): HpsgSynsem | undefined {
  const condition = conditionSign.synsem.cont.condition;
  if (!condition) return undefined;
  const target = targetSign.synsem;
  const targetRequirements = target.nonlocal?.scopeRequirements ?? [];
  if (!targetRequirements.some((requirement) => sameCondition(requirement, condition))) return undefined;
  const remainingRequirements = targetRequirements.filter((requirement) => !sameCondition(requirement, condition));
  const scoped: HpsgScopedAdministrationFeature = {
    condition,
    head: { ...target.head },
    site: target.valence.site,
    prn: target.valence.prn,
    instructions: target.valence.instructions,
    patientInstruction: target.valence.patientInstruction
  };
  const existingScopes = mergeScopedAdministrations(
    conditionSign.synsem.cont.scopedAdministrations,
    target.cont.scopedAdministrations
  );
  const scopes = mergeScopedAdministrations(existingScopes, [scoped]);
  const clinicalAdjunct = mergeClinicalAdjunct(
    conditionSign.synsem.cont.clinicalAdjunct,
    target.cont.clinicalAdjunct
  );
  if (clinicalAdjunct === undefined &&
      conditionSign.synsem.cont.clinicalAdjunct && target.cont.clinicalAdjunct) {
    return undefined;
  }
  return {
    head: {},
    valence: {
      instructions: scopedInstruction(condition, target),
      patientInstruction: condition.safety ? target.valence.patientInstruction : { text: condition.fullText }
    },
    cont: {
      clauseKind: conditionSign.synsem.cont.clauseKind ?? target.cont.clauseKind,
      clinicalAdjunct,
      scopedAdministrations: scopes,
      scopeClosed: true
    },
    nonlocal: {
      scopeRequirements: mergeScopeRequirements(
        conditionSign.synsem.nonlocal?.scopeRequirements,
        remainingRequirements
      )
    }
  };
}

export function unifySynsem(
  left: HpsgSynsem,
  right: HpsgSynsem,
  context: HpsgUnificationContext
): HpsgSynsem | undefined {
  const method = mergeMethod(left.head.method, right.head.method);
  if (method === undefined && left.head.method && right.head.method) {
    return undefined;
  }
  const route = mergeRoute(left.head.route, right.head.route, context);
  if (route === undefined && left.head.route && right.head.route) {
    return undefined;
  }
  let dose = mergeDose(left.head.dose, right.head.dose);
  if (dose === undefined && left.head.dose && right.head.dose) {
    return undefined;
  }
  let schedule = mergeSchedule(left.head.schedule, right.head.schedule);
  if (schedule === undefined && left.head.schedule && right.head.schedule) return undefined;
  // A stated daily total divided into N doses is not N repetitions of the
  // undivided scalar. The division complement licenses a typed period total,
  // and the resulting schedule represents the individual administrations.
  // Ordinary "30 mg daily" has no division complement and stays untouched.
  // A resolved weight-based dose (mg/kg) also needs this explicit daily-total
  // projection when "daily" is separate from the unit, not written as "/day".
  // Preserve its patient-mass denominator and weight requirement; only append
  // the source-backed daily period. Rates with an existing time denominator
  // must never be divided here a second time.
  const quantity = dose?.clinicalQuantity;
  if (dose?.divisionCount !== undefined &&
      (!quantity || (quantity.representation === "dose" && quantity.status === "resolved" &&
        !quantity.denominators.some(term => term.dimension === "time"))) &&
      dose.value !== undefined && dose.unit &&
      schedule?.frequency === 1 && schedule.period === 1 && schedule.periodUnit === "d") {
    const category = getUnitCategory(dose.unit);
    const dimension: HpsgClinicalQuantityDimension = category === "other"
      ? (dose.unit === "[iU]" ? "biologic-activity" : "administration-unit")
      : category;
    const projectedDose = { value: dose.value / dose.divisionCount, unit: dose.unit,
      ...(dose.comparator ? { comparator: dose.comparator } : {}) };
    dose = { ...dose, value: projectedDose.value, clinicalQuantity: {
      ...quantity,
      representation: "dose", status: "resolved",
      numerator: quantity?.numerator ?? { value: dose.value, unit: dose.unit, dimension,
        ...(dose.comparator ? { comparator: dose.comparator } : {}) },
      denominators: [...(quantity?.denominators ?? []), { value: 1, unit: "d", dimension: "time" }],
      dailyTotal: true, dividedDoseCount: dose.divisionCount, projectedDose
    } };
    schedule = { ...schedule, frequency: dose.divisionCount, timingCode: undefined };
  }
  // A divided total supplies its authored period. An independent rate
  // denominator belongs to the infusion and cannot create a recurrence.
  if (dose?.clinicalQuantity && dose.clinicalQuantity.dividedDoseCount !== undefined &&
      (dose.clinicalQuantity.dailyTotal || dose.clinicalQuantity.representation === "dose" &&
        dose.clinicalQuantity.requiresPatientWeight)) {
    const period = dose.clinicalQuantity.denominators.find(term => term.dimension === "time");
    if (period) {
      const dividedSchedule = {
        frequency: dose.clinicalQuantity.dividedDoseCount,
        period: period.value,
        periodUnit: period.unit as HpsgScheduleFeature["periodUnit"]
      };
      const combined = mergeSchedule(schedule, dividedSchedule);
      if (!combined && schedule) return undefined;
      schedule = combined;
    }
  }
  const site = mergeSite(left.valence.site, right.valence.site, context);
  if (site === undefined && left.valence.site && right.valence.site) {
    return undefined;
  }
  const prn = mergePrn(left.valence.prn, right.valence.prn);
  if (prn === undefined && left.valence.prn && right.valence.prn) {
    return undefined;
  }
  if (!sameOptionalScalar(left.cont.regimenAdjustment, right.cont.regimenAdjustment)) return undefined;
  const regimenAdjustment = mergeOptionalScalar(left.cont.regimenAdjustment, right.cont.regimenAdjustment);
  const condition = mergeCondition(left.cont.condition, right.cont.condition);
  if (condition === undefined && left.cont.condition && right.cont.condition) return undefined;
  const clinicalAdjunct = mergeClinicalAdjunct(
    left.cont.clinicalAdjunct,
    right.cont.clinicalAdjunct
  );
  if (clinicalAdjunct === undefined &&
      left.cont.clinicalAdjunct && right.cont.clinicalAdjunct) return undefined;
  const coordinationMarker = mergeCoordinationMarker(
    left.cont.coordinationMarker,
    right.cont.coordinationMarker
  );
  if (coordinationMarker === undefined &&
      left.cont.coordinationMarker && right.cont.coordinationMarker) return undefined;
  const siteRelativeMarker = left.cont.siteRelativeMarker || right.cont.siteRelativeMarker
    ? mergeStructuredFeature(left.cont.siteRelativeMarker, right.cont.siteRelativeMarker)
    : undefined;
  if (siteRelativeMarker === undefined &&
      left.cont.siteRelativeMarker && right.cont.siteRelativeMarker) return undefined;
  const sitePredicate = left.cont.sitePredicate || right.cont.sitePredicate
    ? mergeStructuredFeature(left.cont.sitePredicate, right.cont.sitePredicate)
    : undefined;
  if (sitePredicate === undefined && left.cont.sitePredicate && right.cont.sitePredicate) {
    return undefined;
  }
  const siteRestriction = left.cont.siteRestriction || right.cont.siteRestriction
    ? mergeStructuredFeature(left.cont.siteRestriction, right.cont.siteRestriction)
    : undefined;
  if (siteRestriction === undefined &&
      left.cont.siteRestriction && right.cont.siteRestriction) return undefined;

  const result: HpsgSynsem = {
    head: {
      method,
      route,
      dose,
      schedule
    },
    valence: {
      site,
      prn,
      instructions: mergeInstructions(left.valence.instructions, right.valence.instructions),
      patientInstruction: mergePatientInstruction(
        left.valence.patientInstruction,
        right.valence.patientInstruction
      )
    },
    cont: {
      clauseKind: left.cont.clauseKind ?? right.cont.clauseKind,
      regimenAdjustment,
      condition,
      clinicalAdjunct,
      scopedAdministrations: mergeScopedAdministrations(
        left.cont.scopedAdministrations,
        right.cont.scopedAdministrations
      ),
      scopeClosed: left.cont.scopeClosed || right.cont.scopeClosed ? true : undefined,
      coordinationMarker
    },
    nonlocal: {
      scopeRequirements: mergeScopeRequirements(
        left.nonlocal?.scopeRequirements,
        right.nonlocal?.scopeRequirements
      )
    }
  };
  // Keep absent optional features absent. Otherwise every ordinary chart key
  // and semantic comparison pays to walk three unused site-relative fields.
  // This changes representation cost, never which licensed signs can combine.
  if (siteRelativeMarker) result.cont.siteRelativeMarker = siteRelativeMarker;
  if (sitePredicate) result.cont.sitePredicate = sitePredicate;
  if (siteRestriction) result.cont.siteRestriction = siteRestriction;
  return result;
}

function withoutSiteRelativeContent(synsem: HpsgSynsem): HpsgSynsem {
  return {
    ...synsem,
    cont: {
      ...synsem.cont,
      siteRelativeMarker: undefined,
      sitePredicate: undefined,
      siteRestriction: undefined
    }
  };
}

function siteRelativeSynsem(
  markerSign: HpsgSign,
  predicateSign: HpsgSign,
  context: HpsgUnificationContext
): HpsgSynsem | undefined {
  const marker = markerSign.synsem.cont.siteRelativeMarker;
  const predicate = predicateSign.synsem.cont.sitePredicate;
  if (!marker || !predicate) return undefined;
  const base = unifySynsem(
    withoutSiteRelativeContent(markerSign.synsem),
    withoutSiteRelativeContent(predicateSign.synsem),
    context
  );
  if (!base) return undefined;
  const range = {
    start: Math.min(marker.range.start, predicate.range.start),
    end: Math.max(marker.range.end, predicate.range.end)
  };
  return {
    ...base,
    cont: {
      ...base.cont,
      siteRestriction: formBodySiteRestriction(predicate, marker.range,
        context.sourceText?.(range.start, range.end))
    }
  };
}

function restrictedSiteSynsem(
  headSign: HpsgSign,
  relativeSign: HpsgSign,
  context: HpsgUnificationContext
): HpsgSynsem | undefined {
  const restriction = relativeSign.synsem.cont.siteRestriction;
  const headSite = headSign.synsem.valence.site;
  if (!restriction || !headSite) return undefined;
  const base = unifySynsem(
    headSign.synsem,
    withoutSiteRelativeContent(relativeSign.synsem),
    context
  );
  if (!base?.valence.site) return undefined;
  return {
    ...base,
    valence: {
      ...base.valence,
      site: {
        ...base.valence.site,
        restrictions: appendUniqueStructured(
          base.valence.site.restrictions,
          [restriction]
        )
      }
    }
  };
}

function siteCoordinationSynsem(
  left: HpsgSynsem,
  right: HpsgSynsem,
  context: HpsgUnificationContext
): HpsgSynsem | undefined {
  const leftSite = left.valence.site;
  const rightSite = right.valence.site;
  const marker = left.cont.coordinationMarker ?? right.cont.coordinationMarker;
  if (!leftSite || !rightSite || !marker) return undefined;
  const withoutSites = (synsem: HpsgSynsem): HpsgSynsem => ({
    ...synsem,
    valence: { ...synsem.valence, site: undefined },
    cont: { ...synsem.cont, coordinationMarker: undefined }
  });
  const base = unifySynsem(withoutSites(left), withoutSites(right), context);
  const site = coordinatedSite(leftSite, rightSite, marker.coordination, context);
  if (!base || !site) return undefined;
  return {
    ...base,
    valence: { ...base.valence, site },
    cont: { ...base.cont, coordinationMarker: undefined }
  };
}

function hasDailyFrequencyDefaultEvidence(sign: HpsgSign): boolean {
  return sign.evidence.some((item) => item.scheduleDefault === "daily-frequency");
}

function schedulePeriodMatches(left: HpsgScheduleFeature, right: HpsgScheduleFeature): boolean {
  return left.period !== undefined && right.period !== undefined &&
    left.period === right.period && left.periodUnit !== undefined &&
    left.periodUnit === right.periodUnit;
}

function hasIndependentCadenceEvidence(sign: HpsgSign): boolean {
  return sign.evidence.some(item => item.scheduleDefault !== "weekday-recurrence" &&
    item.scheduleFields?.some(field => field === "frequency" || field === "frequencyMax" ||
      field === "period" || field === "periodMax" || field === "periodUnit" || field === "timingCode"));
}

function refinedDefaultCadenceSynsem(
  cadenceSign: HpsgSign,
  explicitSign: HpsgSign
): HpsgSynsem | undefined {
  const cadence = cadenceSign.synsem.head.schedule;
  const explicit = explicitSign.synsem.head.schedule;
  if (!cadence || !explicit || cadence.frequency !== 1) return undefined;
  if (cadence.period === 1 && cadence.periodUnit === FhirPeriodUnit.Week && cadence.dayOfWeek?.length &&
      explicit.period !== undefined && explicit.periodUnit !== undefined &&
      (explicit.frequency !== 1 || !schedulePeriodMatches(cadence, explicit)) &&
      cadenceSign.evidence.some(item => item.scheduleDefault === "weekday-recurrence") &&
      !hasIndependentCadenceEvidence(cadenceSign) && hasIndependentCadenceEvidence(explicitSign)) {
    // The weekday remains a restriction; only its inferred weekly cadence yields.
    // Once an authored cadence owns this sign, later cadence conflicts stay conflicts.
    return {
      ...cadenceSign.synsem,
      head: {
        ...cadenceSign.synsem.head,
        schedule: {
          ...cadence,
          frequency: undefined,
          period: undefined,
          periodUnit: undefined
        }
      }
    };
  }
  if (explicit.frequency === undefined || explicit.frequency === 1 || !hasDailyFrequencyDefaultEvidence(cadenceSign) ||
      !schedulePeriodMatches(cadence, explicit)) return undefined;
  return {
    ...cadenceSign.synsem,
    head: {
      ...cadenceSign.synsem.head,
      schedule: { ...cadence, frequency: undefined, timingCode: undefined }
    }
  };
}

/** A meal relation or matching daypart qualifies the same fixed-clock administrations.
 * Explicit coordination or separate quantified heads retain their event union.
 * @param clockSign Daughter supplying exact clock anchors.
 * @param mealSign Daughter supplying a recognized meal or daypart modifier.
 * @param context Existing source ranges, used only for adjacency/coordination.
 */
function fixedClockEventAdjunctSynsem(
  clockSign: HpsgSign, mealSign: HpsgSign, context: HpsgUnificationContext,
  mealSynsem: HpsgSynsem = mealSign.synsem
): { synsem: HpsgSynsem; qualifiedDaypartTokens?: number[] } | undefined {
  const clock = clockSign.synsem.head.schedule;
  const meal = mealSynsem.head.schedule;
  if (!clock?.timeOfDay?.length || !meal?.when?.length ||
      !context.sourceText ||
      (clockSign.synsem.head.dose && mealSynsem.head.dose)) return undefined;
  const isMeal = (event: NonNullable<HpsgScheduleFeature["when"]>[number]) => {
    for (const values of MEAL_TIMING_BY_RELATION.values()) {
      for (const value of values.values()) if (value === event) return true;
    }
    return false;
  };
  const mealQualification = meal.when.every(isMeal);
  let qualifiedDayparts: Set<EventTiming> | undefined;
  if (meal.offset === undefined && meal.offsetMin === undefined && meal.offsetMax === undefined) {
    for (const event of meal.when) {
      const range = DOSE_TARGET_DAYPART_CLOCK_RANGES.get(event);
      // A matching clock owns only its daypart qualifier. Other coordinated
      // events, such as bedtime, retain their independent occurrences.
      if (range && clock.timeOfDay.some(value => {
        const hour = Number(value.slice(0, 2));
        return hour >= range.startHour && hour < range.endHour;
      })) (qualifiedDayparts ??= new Set()).add(event);
    }
  }
  const daypartQualification = Boolean(qualifiedDayparts?.size);
  // A composed daypart daughter may already contain an independent clock.
  // Its local qualifier can still attach across this constituent boundary.
  // Meal counsel retains its existing clock-free daughter requirement.
  if (!daypartQualification && (!mealQualification || meal.timeOfDay?.length)) return undefined;
  const tokensFor = (sign: HpsgSign, field: "when" | "timeOfDay") => {
    const indices = new Set<number>();
    let qualifyingIndices: Set<number> | undefined;
    // When the complete typed event daughter qualifies, its evidence owns
    // the whole phrase, including registered multiword daypart expressions.
    if (field === "when" && qualifiedDayparts &&
        meal.when!.some(event => !qualifiedDayparts!.has(event))) {
      qualifyingIndices = new Set();
      for (const token of sign.tokens)
        if (qualifiedDayparts.has(EVENT_TIMING_TOKENS[token.canonical ?? token.lower]))
          qualifyingIndices.add(token.index);
    }
    for (const item of sign.evidence) {
      // A refined NEXT daypart still owns its onset tokens, not the
      // remaining meal modifier or a coordinator between them.
      if (item.scheduleFields?.indexOf(field) === -1 || !item.scheduleFields ||
          field === "when" && mealSynsem !== mealSign.synsem && isNextDayScheduleRule(item.rule)) continue;
      if (qualifyingIndices && !item.tokenIndices.some(index => qualifyingIndices!.has(index))) continue;
      for (const index of item.tokenIndices) indices.add(index);
    }
    return sign.tokens.filter(token => indices.has(token.index));
  };
  const clocks = tokensFor(clockSign, "timeOfDay"), meals = tokensFor(mealSign, "when");
  if (!clocks.length || !meals.length) return undefined;
  // The clock-list constituent can own its introductory comma. That
  // punctuation must not hide the following coordinator at its outer edge.
  const clockEdges = clocks.filter(token => token.original !== ",");
  const mealEdges = meals.filter(token => token.original !== ",");
  if (!clockEdges.length || !mealEdges.length) return undefined;
  const firstClock = clockEdges.reduce((a, b) => a.sourceStart < b.sourceStart ? a : b);
  const lastClock = clockEdges.reduce((a, b) => a.sourceEnd > b.sourceEnd ? a : b);
  const firstMeal = mealEdges.reduce((a, b) => a.sourceStart < b.sourceStart ? a : b);
  const lastMeal = mealEdges.reduce((a, b) => a.sourceEnd > b.sourceEnd ? a : b);
  const linked = (token: typeof firstClock) =>
    coordinationConnectorKind(token.canonical ?? token.lower) !== "unknown";
  if (lastClock.sourceEnd <= firstMeal.sourceStart && (linked(lastClock) || linked(firstMeal)) ||
      lastMeal.sourceEnd <= firstClock.sourceStart && (linked(lastMeal) || linked(firstClock))) return undefined;
  const clockStart = Math.min(...clocks.map(token => token.sourceStart));
  const clockEnd = Math.max(...clocks.map(token => token.sourceEnd));
  const mealStart = Math.min(...meals.map(token => token.sourceStart));
  const mealEnd = Math.max(...meals.map(token => token.sourceEnd));
  const bridgeStart = clockEnd <= mealStart ? clockEnd : mealEnd;
  const bridgeEnd = clockEnd <= mealStart ? mealStart : clockStart;
  if (bridgeStart > bridgeEnd) return undefined;
  const gap = context.sourceText(bridgeStart, bridgeEnd);
  if (!/^[\s,;]*$/u.test(gap)) {
    // Other schedule daughters can intervene without introducing another
    // administration: the duration in "at 07:00 for 7 days before meals".
    // Their existing typed evidence must own every non-separator token.
    const allowed = new Set<number>();
    const fields = ["boundsDuration", "duration", "durationMax", "durationUnit", "frequency", "frequencyMax", "period", "periodMax", "periodUnit", "count", "countMax"];
    for (const sign of [clockSign, mealSign]) {
      for (const evidence of sign.evidence) {
        if (!evidence.scheduleFields?.length ||
            !(mealSynsem !== mealSign.synsem && isNextDayScheduleRule(evidence.rule)) &&
            !evidence.scheduleFields.every(field => fields.indexOf(field) >= 0)) continue;
        for (const index of evidence.tokenIndices) allowed.add(index);
      }
    }
    const bridge = [...clockSign.tokens, ...mealSign.tokens].filter(token =>
      token.sourceStart >= bridgeStart && token.sourceEnd <= bridgeEnd);
    if (!bridge.length || bridge.some(token =>
      coordinationConnectorKind(token.canonical ?? token.lower) !== "unknown" ||
      (!/^[,;:]$/u.test(token.original) &&
        !CLOCK_LEAD_TOKENS.has(token.canonical ?? token.lower) && !allowed.has(token.index)))) return undefined;
  }
  const text = context.sourceText(mealStart, mealEnd).trim();
  if (!text) return undefined;
  // The typed qualifier modifies the existing clock, adding no separate
  // administration position. Retain its source evidence on this construction.
  if (daypartQualification) {
    const when = meal.when.filter(event => !qualifiedDayparts!.has(event));
    return { synsem: { ...mealSynsem, head: { ...mealSynsem.head,
      schedule: { ...meal, when: when.length ? when : undefined } } },
      qualifiedDaypartTokens: meals.map(token => token.index) };
  }
  const instruction: HpsgInstructionFeature =
    meal.offset === undefined && meal.offsetMin === undefined && meal.offsetMax === undefined
      ? mealInstructionWording(meal.when, text) : { text };
  instruction.evidence = [{ rule: "hpsg.cx.schedule.fixed-clock-meal-qualification",
    spans: [{ start: mealStart, end: mealEnd, text }] }];
  return { synsem: {
    ...mealSynsem,
    head: { ...mealSynsem.head, schedule: {
      ...meal, when: undefined, offset: undefined, offsetMin: undefined, offsetMax: undefined
    } },
    valence: { ...mealSynsem.valence,
      instructions: mergeInstructions(mealSynsem.valence.instructions, [instruction]) }
  } };
}

/** An exact clock refines the daypart of NEXT within one administration.
 * Its lexical evidence identifies only that inferred anchor; independently
 * coordinated events retain their own occurrence. */
function nextDayClockAdjunctSynsem(
  clockSign: HpsgSign, onsetSign: HpsgSign, context: HpsgUnificationContext
): HpsgSynsem | undefined {
  const clock = clockSign.synsem.head.schedule, onset = onsetSign.synsem.head.schedule;
  if (!clock?.timeOfDay?.length || !onset?.when?.length ||
      onset.phaseStartReference !== "treatment-day-start") return undefined;
  const nextDay = onsetSign.evidence.find(item => isNextDayScheduleRule(item.rule));
  if (!nextDay) return undefined;
  const onsetIndices = new Set(nextDay.tokenIndices), clockIndices = new Set<number>();
  for (const evidence of clockSign.evidence)
    if ((evidence.scheduleFields?.indexOf("timeOfDay") ?? -1) >= 0)
      for (const index of evidence.tokenIndices) clockIndices.add(index);
  let onsetStart = Infinity, onsetEnd = -Infinity, clockStart = Infinity, clockEnd = -Infinity;
  let daypart: EventTiming | undefined;
  for (const token of onsetSign.tokens) {
    if (!onsetIndices.has(token.index)) continue;
    onsetStart = Math.min(onsetStart, token.sourceStart);
    onsetEnd = Math.max(onsetEnd, token.sourceEnd);
    daypart ??= EVENT_TIMING_TOKENS[token.canonical ?? token.lower];
  }
  for (const token of clockSign.tokens) {
    // A clock-list daughter can own a trailing connector. It belongs to the
    // bridge, not the last clock, so it cannot hide explicit event coordination.
    if (!clockIndices.has(token.index) ||
        coordinationConnectorKind(token.canonical ?? token.lower) !== "unknown") continue;
    clockStart = Math.min(clockStart, token.sourceStart);
    clockEnd = Math.max(clockEnd, token.sourceEnd);
  }
  if (!daypart || clockStart === Infinity) return undefined;
  const bridgeStart = onsetEnd <= clockStart ? onsetEnd : clockEnd;
  const bridgeEnd = onsetEnd <= clockStart ? clockStart : onsetStart;
  if (bridgeStart > bridgeEnd) return undefined;
  // A coordinator can still be an uncombined daughter. Its declared lexical
  // surface in this owned bridge retains both events in either word order.
  if (context.sourceText &&
      coordinationConnectorKind(context.sourceText(bridgeStart, bridgeEnd)) !== "unknown") return undefined;
  for (const sign of [clockSign, onsetSign])
    for (const token of sign.tokens)
      if (token.sourceStart >= bridgeStart && token.sourceEnd <= bridgeEnd &&
          coordinationConnectorKind(token.canonical ?? token.lower) !== "unknown") return undefined;
  const when = onset.when.filter(event => event !== daypart);
  return { ...onsetSign.synsem, head: { ...onsetSign.synsem.head,
    schedule: { ...onset, when: when.length ? when : undefined } } };
}

function scheduleRefinementSynsems(
  left: HpsgSign,
  right: HpsgSign,
  context: HpsgUnificationContext
): { left: HpsgSynsem; right: HpsgSynsem; refined: boolean; qualifiedDaypartTokens?: number[] } {
  const nextDayRight = nextDayClockAdjunctSynsem(left, right, context);
  if (nextDayRight) {
    const qualified = fixedClockEventAdjunctSynsem(left, right, context, nextDayRight);
    return { left: left.synsem, right: qualified?.synsem ?? nextDayRight, refined: true,
      qualifiedDaypartTokens: qualified?.qualifiedDaypartTokens };
  }
  const nextDayLeft = nextDayClockAdjunctSynsem(right, left, context);
  if (nextDayLeft) {
    const qualified = fixedClockEventAdjunctSynsem(right, left, context, nextDayLeft);
    return { left: qualified?.synsem ?? nextDayLeft, right: right.synsem, refined: true,
      qualifiedDaypartTokens: qualified?.qualifiedDaypartTokens };
  }
  const qualifiedRight = fixedClockEventAdjunctSynsem(left, right, context);
  if (qualifiedRight) return { left: left.synsem, right: qualifiedRight.synsem, refined: true,
    qualifiedDaypartTokens: qualifiedRight.qualifiedDaypartTokens };
  const qualifiedLeft = fixedClockEventAdjunctSynsem(right, left, context);
  if (qualifiedLeft) return { left: qualifiedLeft.synsem, right: right.synsem, refined: true,
    qualifiedDaypartTokens: qualifiedLeft.qualifiedDaypartTokens };
  const refinedLeft = refinedDefaultCadenceSynsem(left, right);
  if (refinedLeft) return { left: refinedLeft, right: right.synsem, refined: true };
  const refinedRight = refinedDefaultCadenceSynsem(right, left);
  if (refinedRight) return { left: left.synsem, right: refinedRight, refined: true };
  return { left: left.synsem, right: right.synsem, refined: false };
}

export function combineSigns(
  left: HpsgSign,
  right: HpsgSign,
  context: HpsgUnificationContext,
  rule: string
): HpsgSign | undefined {
  const selectedConstruction = selectHpsgConstruction(left, right);
  if (!selectedConstruction) return undefined;
  const target = selectedConstruction.construction.headSide === "left" ? left : right;
  const nonHead = selectedConstruction.construction.headSide === "left" ? right : left;
  const refinement = scheduleRefinementSynsems(left, right, context);
  const synsem = selectedConstruction.construction.operation === "scope"
    ? scopeSynsem(nonHead, target)
    : selectedConstruction.construction.operation === "form-site-relative"
      ? siteRelativeSynsem(left, right, context)
    : selectedConstruction.construction.operation === "restrict-site"
      ? restrictedSiteSynsem(target, nonHead, context)
    : selectedConstruction.motherType === "site-coordination-phrase"
      ? siteCoordinationSynsem(refinement.left, refinement.right, context)
    : unifySynsem(refinement.left, refinement.right, context);
  if (!synsem) return undefined;
  const fs = combineSignFeatureStructures(
    left.fs,
    right.fs,
    selectedConstruction.motherType,
    selectedConstruction.construction.headSide,
    selectedConstruction.construction.operation === "scope" ||
      selectedConstruction.construction.operation === "form-site-relative" ||
      selectedConstruction.construction.operation === "restrict-site" ||
      selectedConstruction.motherType === "site-coordination-phrase" ||
      refinement.refined
      ? synsem
      : undefined
  );
  if (!fs) {
    return undefined;
  }
  const tokenIndices = Array.from(
    new Set([...left.consumedTokenIndices, ...right.consumedTokenIndices])
  );
  return {
    type: selectedConstruction.motherType,
    span: {
      start: Math.min(left.span.start, right.span.start),
      end: Math.max(left.span.end, right.span.end)
    },
    tokens: [...left.tokens, ...right.tokens],
    synsem,
    fs,
    construction: selectedConstruction.construction,
    consumedTokenIndices: tokenIndices,
    siteTokenIndices: appendUnique(left.siteTokenIndices, right.siteTokenIndices),
    warnings: appendUnique(left.warnings, right.warnings),
    evidence: [
      ...left.evidence,
      ...right.evidence,
      ...(refinement.qualifiedDaypartTokens ? [{ rule: FIXED_CLOCK_DAYPART_QUALIFICATION_RULE,
        tokenIndices: refinement.qualifiedDaypartTokens }] : []),
      {
        rule,
        tokenIndices
      }
    ],
    score: left.score + right.score +
      (selectedConstruction.motherType === "site-coordination-phrase" ? 6 : 1)
  };
}
