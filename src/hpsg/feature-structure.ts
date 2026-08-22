import type { HpsgSynsem, HpsgType } from "./signature";
import {
  HPSG_TYPE_SYSTEM,
  featureAtom,
  featureNode,
  unifyFeatureStructures,
  validateFeatureStructure,
  type HpsgFeatureNode
} from "./type-system";

// Typed feature graphs are immutable once constructed. The domain parser has a
// small finite set of structural SYNSEM shapes, so cache them instead of
// repeatedly allocating and re-validating equivalent AVMs for chart derivations.
const SYNSEM_CACHE = new Map<string, HpsgFeatureNode>();
const SIGN_CACHE = new Map<string, HpsgFeatureNode>();
const COMBINE_CACHE = new WeakMap<HpsgFeatureNode, WeakMap<HpsgFeatureNode, Map<string, HpsgFeatureNode | null>>>();

function synsemShapeKey(synsem: HpsgSynsem): string {
  return [
    synsem.head.method ? "M" : "",
    synsem.head.route ? "R" : "",
    synsem.head.dose ? "D" : "",
    synsem.head.schedule ? "T" : "",
    synsem.valence.site ? "S" : "",
    synsem.valence.prn ? "P" : "",
    synsem.valence.instructions?.length ? "I" : "",
    synsem.valence.patientInstruction ? "U" : "",
    synsem.cont.clauseKind ?? ""
  ].join("|");
}

function optionalFeature(present: boolean, type: string): HpsgFeatureNode | undefined {
  return present ? featureNode(type) : undefined;
}

export function synsemFeatureStructure(synsem: HpsgSynsem): HpsgFeatureNode {
  const cacheKey = synsemShapeKey(synsem);
  const cached = SYNSEM_CACHE.get(cacheKey);
  if (cached) return cached;
  const headFeatures: Record<string, HpsgFeatureNode> = {};
  const method = optionalFeature(Boolean(synsem.head.method), "method-feature");
  const route = optionalFeature(Boolean(synsem.head.route), "route-feature");
  const dose = optionalFeature(Boolean(synsem.head.dose), "dose-feature");
  const schedule = optionalFeature(Boolean(synsem.head.schedule), "schedule-feature");
  if (method) headFeatures.METHOD = method;
  if (route) headFeatures.ROUTE = route;
  if (dose) headFeatures.DOSE = dose;
  if (schedule) headFeatures.SCHEDULE = schedule;

  const valenceFeatures: Record<string, HpsgFeatureNode> = {};
  const site = optionalFeature(Boolean(synsem.valence.site), "site-feature");
  const prn = optionalFeature(Boolean(synsem.valence.prn), "prn-feature");
  const instructions = optionalFeature(Boolean(synsem.valence.instructions?.length), "instruction-feature");
  const patientInstruction = optionalFeature(Boolean(synsem.valence.patientInstruction), "patient-instruction-feature");
  if (site) valenceFeatures.SITE = site;
  if (prn) valenceFeatures.PRN = prn;
  if (instructions) valenceFeatures.INSTRUCTIONS = instructions;
  if (patientInstruction) valenceFeatures.PATIENT_INSTRUCTION = patientInstruction;

  const contentFeatures: Record<string, ReturnType<typeof featureAtom>> = {};
  if (synsem.cont.clauseKind) {
    contentFeatures.CLAUSE_KIND = featureAtom(synsem.cont.clauseKind);
  }

  const result = featureNode("synsem", {
    HEAD: featureNode("head", headFeatures),
    VALENCE: featureNode("valence", valenceFeatures),
    CONT: featureNode("content", contentFeatures)
  });
  SYNSEM_CACHE.set(cacheKey, result);
  return result;
}

export function signFeatureStructure(type: HpsgType, synsem: HpsgSynsem): HpsgFeatureNode {
  const cacheKey = `${type}|${synsemShapeKey(synsem)}`;
  const cached = SIGN_CACHE.get(cacheKey);
  if (cached) return cached;
  const sign = featureNode(type, { SYNSEM: synsemFeatureStructure(synsem) });
  const issues = validateFeatureStructure(sign, HPSG_TYPE_SYSTEM);
  if (issues.length) {
    throw new Error(`Invalid HPSG feature structure: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
  }
  SIGN_CACHE.set(cacheKey, sign);
  return sign;
}

export function combineSignFeatureStructures(
  left: HpsgFeatureNode,
  right: HpsgFeatureNode,
  motherType: HpsgType
): HpsgFeatureNode | undefined {
  let byRight = COMBINE_CACHE.get(left);
  if (!byRight) {
    byRight = new WeakMap();
    COMBINE_CACHE.set(left, byRight);
  }
  let byType = byRight.get(right);
  if (!byType) {
    byType = new Map();
    byRight.set(right, byType);
  }
  if (byType.has(motherType)) return byType.get(motherType) ?? undefined;
  const leftSynsem = left.features.SYNSEM;
  const rightSynsem = right.features.SYNSEM;
  if (!leftSynsem || !rightSynsem) {
    byType.set(motherType, null);
    return undefined;
  }
  const unified = unifyFeatureStructures(leftSynsem, rightSynsem, HPSG_TYPE_SYSTEM);
  if (!unified.value || unified.value.kind !== "node") {
    byType.set(motherType, null);
    return undefined;
  }
  const mother = featureNode(motherType, { SYNSEM: unified.value });
  if (validateFeatureStructure(mother, HPSG_TYPE_SYSTEM).length) {
    byType.set(motherType, null);
    return undefined;
  }
  byType.set(motherType, mother);
  return mother;
}
