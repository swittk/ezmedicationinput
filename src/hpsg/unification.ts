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
  HpsgSynsem
} from "./signature";
import { FhirCoding, RouteCode } from "../types";

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

function sameCoding(left: FhirCoding | undefined, right: FhirCoding | undefined): boolean {
  if (!left?.code || !right?.code) {
    return left?.code === right?.code;
  }
  return (
    left.code === right.code &&
    (left.system ?? "http://snomed.info/sct") ===
      (right.system ?? "http://snomed.info/sct")
  );
}

function sameSpatialRelation(
  left: HpsgSiteFeature["spatialRelation"] | undefined,
  right: HpsgSiteFeature["spatialRelation"] | undefined
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeMethod(
  left: HpsgMethodFeature | undefined,
  right: HpsgMethodFeature | undefined
): HpsgMethodFeature | undefined {
  if (!left) return right;
  if (!right) return left;
  if (left.verb !== right.verb) {
    return undefined;
  }
  return {
    verb: left.verb,
    text: mergeOptionalScalar(left.text, right.text),
    textElement: mergeOptionalScalar(left.textElement, right.textElement),
    coding: mergeOptionalScalar(left.coding, right.coding)
  };
}

function mergeRoute(
  left: HpsgRouteFeature | undefined,
  right: HpsgRouteFeature | undefined,
  context: HpsgUnificationContext
): HpsgRouteFeature | undefined {
  if (!left) return right;
  if (!right) return left;
  if (left.code === right.code) {
    return {
      code: left.code,
      text: mergeOptionalScalar(left.text, right.text)
    };
  }
  if (context.isCompatibleRouteRefinement(left.code, right.code)) {
    return { code: right.code, text: right.text };
  }
  if (context.isCompatibleRouteRefinement(right.code, left.code)) {
    return { code: left.code, text: left.text };
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
    text: mergeOptionalScalar(left.text, right.text),
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
    if (!result.some((candidate) => candidate.text === reason.text)) {
      result.push(reason);
    }
  }
  return result.length ? result : undefined;
}

function mergePrnLookupRequests(
  left: HpsgPrnFeature["lookupRequests"] | undefined,
  right: HpsgPrnFeature["lookupRequests"] | undefined
): HpsgPrnFeature["lookupRequests"] | undefined {
  const result: NonNullable<HpsgPrnFeature["lookupRequests"]> = [];
  for (const request of [...(left ?? []), ...(right ?? [])]) {
    const key = `${request.range?.start ?? ""}:${request.range?.end ?? ""}:${request.text}`;
    if (
      !result.some((candidate) =>
        `${candidate.range?.start ?? ""}:${candidate.range?.end ?? ""}:${candidate.text}` === key
      )
    ) {
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
        candidate.coding?.code === instruction.coding?.code
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

function mergeSchedule(
  left: HpsgScheduleFeature | undefined,
  right: HpsgScheduleFeature | undefined
): HpsgScheduleFeature | undefined {
  if (!left) return right;
  if (!right) return left;
  if (
    !sameOptionalScalar(left.timingCode, right.timingCode) ||
    !sameOptionalScalar(left.count, right.count) ||
    !sameOptionalScalar(left.duration, right.duration) ||
    !sameOptionalScalar(left.durationMax, right.durationMax) ||
    !sameOptionalScalar(left.durationUnit, right.durationUnit) ||
    !sameOptionalScalar(left.frequency, right.frequency) ||
    !sameOptionalScalar(left.frequencyMax, right.frequencyMax) ||
    !sameOptionalScalar(left.period, right.period) ||
    !sameOptionalScalar(left.periodMax, right.periodMax) ||
    !sameOptionalScalar(left.periodUnit, right.periodUnit)
  ) {
    return undefined;
  }
  return {
    timingCode: mergeOptionalScalar(left.timingCode, right.timingCode),
    count: mergeOptionalScalar(left.count, right.count),
    duration: mergeOptionalScalar(left.duration, right.duration),
    durationMax: mergeOptionalScalar(left.durationMax, right.durationMax),
    durationUnit: mergeOptionalScalar(left.durationUnit, right.durationUnit),
    frequency: mergeOptionalScalar(left.frequency, right.frequency),
    frequencyMax: mergeOptionalScalar(left.frequencyMax, right.frequencyMax),
    period: mergeOptionalScalar(left.period, right.period),
    periodMax: mergeOptionalScalar(left.periodMax, right.periodMax),
    periodUnit: mergeOptionalScalar(left.periodUnit, right.periodUnit),
    when: appendUnique(left.when, right.when),
    dayOfWeek: appendUnique(left.dayOfWeek, right.dayOfWeek),
    timeOfDay: appendUnique(left.timeOfDay, right.timeOfDay)
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
      clauseKind: left.cont.clauseKind ?? right.cont.clauseKind
    }
  };
}

export function combineSigns(
  left: HpsgSign,
  right: HpsgSign,
  context: HpsgUnificationContext,
  rule: string
): HpsgSign | undefined {
  const synsem = unifySynsem(left.synsem, right.synsem, context);
  if (!synsem) {
    return undefined;
  }
  return {
    type: "clause-sign",
    span: {
      start: Math.min(left.span.start, right.span.start),
      end: Math.max(left.span.end, right.span.end)
    },
    tokens: [...left.tokens, ...right.tokens],
    synsem,
    consumedTokenIndices: Array.from(
      new Set([...left.consumedTokenIndices, ...right.consumedTokenIndices])
    ),
    siteTokenIndices: appendUnique(left.siteTokenIndices, right.siteTokenIndices),
    warnings: appendUnique(left.warnings, right.warnings),
    evidence: [
      ...left.evidence,
      ...right.evidence,
      {
        rule,
        tokenIndices: Array.from(
          new Set([...left.consumedTokenIndices, ...right.consumedTokenIndices])
        )
      }
    ],
    score: left.score + right.score + 1
  };
}
