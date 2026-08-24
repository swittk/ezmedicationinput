import {
  HpsgDoseFeature,
  HpsgMethodFeature,
  HpsgRouteFeature,
  HpsgScheduleFeature,
  HpsgSign,
  HpsgSiteFeature,
  HpsgPrnFeature,
  HpsgPatientInstructionFeature,
  HpsgInstructionFeature,
  HpsgConditionFeature,
  HpsgScopedAdministrationFeature,
  HpsgSynsem
} from "./signature";
import { combineSignFeatureStructures } from "./feature-structure";
import { selectHpsgConstruction } from "./constructions";
import { BodySiteSpatialRelation, FhirCoding, PrnReasonLookupRequest, RouteCode } from "../types";

export interface HpsgUnificationContext {
  normalizeSiteText(text: string): string;
  isCompatibleRouteRefinement(current: RouteCode | undefined, next: RouteCode): boolean;
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
    lookupRequest: mergeOptionalScalar(left.lookupRequest, right.lookupRequest)
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
    const key = JSON.stringify(item);
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
    !sameOptionalScalar(left.frequency, right.frequency) ||
    !sameOptionalScalar(left.frequencyMax, right.frequencyMax) ||
    !sameOptionalScalar(left.period, right.period) ||
    !sameOptionalScalar(left.periodMax, right.periodMax) ||
    !sameOptionalScalar(left.periodUnit, right.periodUnit) ||
    !sameOptionalScalar(left.offset, right.offset) ||
    !sameOptionalScalar(left.offsetMin, right.offsetMin) ||
    !sameOptionalScalar(left.offsetMax, right.offsetMax) ||
    (!sameOccurrenceCap(left.occurrenceCap, right.occurrenceCap) && Boolean(left.occurrenceCap && right.occurrenceCap))
  ) {
    return undefined;
  }
  return {
    attachmentClass: mergedClass,
    timingCode: mergeOptionalScalar(left.timingCode, right.timingCode),
    count: mergeOptionalScalar(left.count, right.count),
    countMax: mergeOptionalScalar(left.countMax, right.countMax),
    duration: mergeOptionalScalar(left.duration, right.duration),
    durationMax: mergeOptionalScalar(left.durationMax, right.durationMax),
    durationUnit: mergeOptionalScalar(left.durationUnit, right.durationUnit),
    frequency: mergeOptionalScalar(left.frequency, right.frequency),
    frequencyMax: mergeOptionalScalar(left.frequencyMax, right.frequencyMax),
    period: mergeOptionalScalar(left.period, right.period),
    periodMax: mergeOptionalScalar(left.periodMax, right.periodMax),
    periodUnit: mergeOptionalScalar(left.periodUnit, right.periodUnit),
    offset: mergeOptionalScalar(left.offset, right.offset),
    offsetMin: mergeOptionalScalar(left.offsetMin, right.offsetMin),
    offsetMax: mergeOptionalScalar(left.offsetMax, right.offsetMax),
    when: appendUnique(left.when, right.when),
    dayOfWeek: appendUnique(left.dayOfWeek, right.dayOfWeek),
    timeOfDay: appendUnique(left.timeOfDay, right.timeOfDay),
    activityTiming: appendUniqueStructured(left.activityTiming, right.activityTiming),
    occurrenceCap: left.occurrenceCap ?? right.occurrenceCap
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
  return {
    head: {},
    valence: {
      instructions: scopedInstruction(condition, target),
      patientInstruction: condition.safety ? target.valence.patientInstruction : { text: condition.fullText }
    },
    cont: {
      clauseKind: conditionSign.synsem.cont.clauseKind ?? target.cont.clauseKind,
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

  return {
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
      scopedAdministrations: mergeScopedAdministrations(
        left.cont.scopedAdministrations,
        right.cont.scopedAdministrations
      ),
      scopeClosed: left.cont.scopeClosed || right.cont.scopeClosed ? true : undefined
    },
    nonlocal: {
      scopeRequirements: mergeScopeRequirements(
        left.nonlocal?.scopeRequirements,
        right.nonlocal?.scopeRequirements
      )
    }
  };
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
  const condition = selectedConstruction.construction.headSide === "left" ? right : left;
  const synsem = selectedConstruction.construction.operation === "scope"
    ? scopeSynsem(condition, target)
    : unifySynsem(left.synsem, right.synsem, context);
  if (!synsem) return undefined;
  const fs = combineSignFeatureStructures(
    left.fs,
    right.fs,
    selectedConstruction.motherType,
    selectedConstruction.construction.headSide,
    selectedConstruction.construction.operation === "scope" ? synsem : undefined
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
    score: left.score + right.score + 1
  };
}
