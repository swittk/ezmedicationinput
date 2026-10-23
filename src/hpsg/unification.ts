import { stableStructureKey } from "../stable-structure";
import {
  HpsgDoseFeature,
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
import { BodySiteSpatialRelation, FhirCoding, PrnReasonLookupRequest, RouteCode } from "../types";

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
  return {
    attachmentClass: attachmentClass(left.attachmentClass),
    text: sourceText,
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
  return stableStructureKey(left) === stableStructureKey(right) ? left : undefined;
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
  if (!sameOptionalScalar(left.value, right.value)) {
    return undefined;
  }
  if (!sameOptionalScalar(left.unit, right.unit)) {
    return undefined;
  }
  if (
    left.range &&
    right.range &&
    (left.range.low !== right.range.low || left.range.high !== right.range.high)
  ) {
    return undefined;
  }
  return {
    attachmentClass: mergedClass,
    value: mergeOptionalScalar(left.value, right.value),
    range: mergeOptionalScalar(left.range, right.range),
    unit: mergeOptionalScalar(left.unit, right.unit)
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
  const seen = new Set<string>();
  for (const item of [...(left ?? []), ...(right ?? [])]) {
    const key = stableStructureKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
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
    !sameOptionalScalar(left.timingCode, right.timingCode) ||
    !sameOptionalScalar(left.count, right.count) ||
    !sameOptionalScalar(left.countMax, right.countMax) ||
    !sameOptionalScalar(left.duration, right.duration) ||
    !sameOptionalScalar(left.durationMax, right.durationMax) ||
    !sameOptionalScalar(left.durationUnit, right.durationUnit) ||
    !sameOptionalScalar(left.boundsStart, right.boundsStart) ||
    !sameOptionalScalar(left.boundsEnd, right.boundsEnd) ||
    !sameOptionalScalar(left.frequency, right.frequency) ||
    !sameOptionalScalar(left.frequencyMax, right.frequencyMax) ||
    !sameOptionalScalar(left.period, right.period) ||
    !sameOptionalScalar(left.periodMax, right.periodMax) ||
    !sameOptionalScalar(left.periodUnit, right.periodUnit) ||
    !sameOptionalScalar(left.offset, right.offset) ||
    !sameOptionalScalar(left.offsetMin, right.offsetMin) ||
    !sameOptionalScalar(left.offsetMax, right.offsetMax) ||
    !sameOptionalScalar(left.repeatCount, right.repeatCount) ||
    (!sameRepeatCycle(left.repeatCycle, right.repeatCycle) && Boolean(left.repeatCycle && right.repeatCycle)) ||
    (!sameOccurrenceCap(left.occurrenceCap, right.occurrenceCap) && Boolean(left.occurrenceCap && right.occurrenceCap))
  ) {
    return undefined;
  }
  return {
    attachmentClass: mergedClass,
    sourceRanges: appendUniqueStructured(left.sourceRanges, right.sourceRanges),
    timingCode: mergeOptionalScalar(left.timingCode, right.timingCode),
    count: mergeOptionalScalar(left.count, right.count),
    countMax: mergeOptionalScalar(left.countMax, right.countMax),
    duration: mergeOptionalScalar(left.duration, right.duration),
    durationMax: mergeOptionalScalar(left.durationMax, right.durationMax),
    durationUnit: mergeOptionalScalar(left.durationUnit, right.durationUnit),
    boundsStart: mergeOptionalScalar(left.boundsStart, right.boundsStart),
    boundsEnd: mergeOptionalScalar(left.boundsEnd, right.boundsEnd),
    frequency: mergeOptionalScalar(left.frequency, right.frequency),
    frequencyMax: mergeOptionalScalar(left.frequencyMax, right.frequencyMax),
    period: mergeOptionalScalar(left.period, right.period),
    periodMax: mergeOptionalScalar(left.periodMax, right.periodMax),
    periodUnit: mergeOptionalScalar(left.periodUnit, right.periodUnit),
    offset: mergeOptionalScalar(left.offset, right.offset),
    offsetMin: mergeOptionalScalar(left.offsetMin, right.offsetMin),
    offsetMax: mergeOptionalScalar(left.offsetMax, right.offsetMax),
    repeatCycle: left.repeatCycle ?? right.repeatCycle,
    repeatCount: mergeOptionalScalar(left.repeatCount, right.repeatCount),
    when: appendUnique(left.when, right.when),
    dayOfWeek: appendUnique(left.dayOfWeek, right.dayOfWeek),
    timeOfDay: appendUnique(left.timeOfDay, right.timeOfDay),
    calendarEvents: appendUniqueStructured(left.calendarEvents, right.calendarEvents),
    activityTiming: appendUniqueStructured(left.activityTiming, right.activityTiming),
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
      stableStructureKey(left.condition) !== stableStructureKey(right.condition)) {
    return undefined;
  }
  return {
    condition: left.condition ?? right.condition,
    excludedDates: appendUnique(left.excludedDates, right.excludedDates),
    excludedWeekdays: appendUnique(left.excludedWeekdays, right.excludedWeekdays),
    includedWeekdays: appendUnique(left.includedWeekdays, right.includedWeekdays),
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

function normalizedInstruction(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[\s,;:.()]+/g, " ").trim();
}

function scopedInstruction(
  condition: HpsgConditionFeature,
  target: HpsgSynsem
): HpsgInstructionFeature[] | undefined {
  if (!condition.safety) return target.valence.instructions;
  const full = normalizedInstruction(condition.fullText);
  const targetInstructions = (target.valence.instructions ?? []).filter((instruction) => {
    const candidate = normalizedInstruction(instruction.text);
    return !candidate || !full.includes(candidate);
  });
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
  const dose = mergeDose(left.head.dose, right.head.dose);
  if (dose === undefined && left.head.dose && right.head.dose) {
    return undefined;
  }
  const schedule = mergeSchedule(left.head.schedule, right.head.schedule);
  if (schedule === undefined && left.head.schedule && right.head.schedule) {
    return undefined;
  }
  const site = mergeSite(left.valence.site, right.valence.site, context);
  if (site === undefined && left.valence.site && right.valence.site) {
    return undefined;
  }
  const prn = mergePrn(left.valence.prn, right.valence.prn);
  if (prn === undefined && left.valence.prn && right.valence.prn) {
    return undefined;
  }
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
      siteRestriction: {
        relation: marker.relation,
        sourceText: context.sourceText?.(range.start, range.end) ??
          `${marker.relation} ${predicate.text}`,
        range,
        markerRange: { ...marker.range },
        predicate: { ...predicate, range: { ...predicate.range } }
      }
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

function refinedDailyCadenceSynsem(
  cadenceSign: HpsgSign,
  explicitSign: HpsgSign
): HpsgSynsem | undefined {
  const cadence = cadenceSign.synsem.head.schedule;
  const explicit = explicitSign.synsem.head.schedule;
  if (!cadence || !explicit || !hasDailyFrequencyDefaultEvidence(cadenceSign)) return undefined;
  if (cadence.frequency !== 1 || explicit.frequency === undefined || explicit.frequency === 1) return undefined;
  if (!schedulePeriodMatches(cadence, explicit)) return undefined;
  return {
    ...cadenceSign.synsem,
    head: {
      ...cadenceSign.synsem.head,
      schedule: { ...cadence, frequency: undefined, timingCode: undefined }
    }
  };
}

function scheduleRefinementSynsems(
  left: HpsgSign,
  right: HpsgSign
): { left: HpsgSynsem; right: HpsgSynsem; refined: boolean } {
  const refinedLeft = refinedDailyCadenceSynsem(left, right);
  if (refinedLeft) return { left: refinedLeft, right: right.synsem, refined: true };
  const refinedRight = refinedDailyCadenceSynsem(right, left);
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
  const refinement = scheduleRefinementSynsems(left, right);
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
      {
        rule,
        tokenIndices
      }
    ],
    score: left.score + right.score +
      (selectedConstruction.motherType === "site-coordination-phrase" ? 6 : 1)
  };
}
