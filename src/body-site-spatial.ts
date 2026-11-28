import {
  BodySiteCode,
  BodySiteSpatialRelation,
  FhirCodeableConcept,
  FhirR6CodeableConcept,
  FhirR6Coding,
  FhirR6Extension,
  FhirCoding,
  FhirExtension
} from "./types";
import { cloneStructuredValue } from "./stable-structure";
import { mergeTranslationPrimitiveElement } from "./fhir-translations";
import { quantityAnnotationExtensions, quantityPrimitiveForR5 } from "./fhir-quantity-operator";

const SNOMED_SYSTEM = "http://snomed.info/sct";

export const BODY_SITE_SPATIAL_RELATION_EXTENSION_URL =
  "urn:ezmedicationinput:body-site-spatial-relation";

const RELATION_URL = "relation";
const RELATION_TEXT_URL = "relationText";
const TARGET_URL = "target";
const TARGET_TEXT_URL = "targetText";
const SOURCE_TEXT_URL = "sourceText";

/** Copy additional authored fields without recursively detaching opaque
 * metadata. Standard FHIR annotations retain their existing clone contract. */
function copyAdditionalCodingField(target: FhirR6Coding, source: FhirR6Coding, key: string): void {
  const fields = target as Record<string, unknown>;
  const value = (source as Record<string, unknown>)[key];
  switch (key) {
    case "extension":
    case "_system":
    case "_version":
    case "_code":
    case "_display":
    case "_userSelected":
    case "i18n":
      fields[key] = cloneStructuredValue(value);
      break;
    case "__proto__":
      Object.defineProperty(fields, key, { value, enumerable: true, configurable: true, writable: true });
      break;
    default:
      fields[key] = value;
  }
}

/** Shared immutable-by-contract Coding fields for ordinary projection and
 * import. Only the explicitly named clone API detaches nested metadata. */
function sharedCodingFields(
  coding: Pick<FhirCoding, "code" | "system" | "display" | "i18n"> | undefined
): FhirCoding | undefined {
  // Output values are immutable by caller contract. Keep existing coding
  // identity (including source annotations) rather than allocating a second
  // coding shell solely to protect a caller from mutating its result.
  return coding;
}

/** Convert known Quantity annotations at the R5 Coding boundary. Plain
 * codings and unrelated supplied fields retain their existing identities. */
function spatialCodingForR5(coding: FhirR6Coding | undefined): FhirCoding | undefined {
  if (!coding || !coding.extension?.length && !coding._system && !coding._version &&
      !coding._code && !coding._display && !coding._userSelected) return coding as FhirCoding | undefined;
  const extension = coding.extension?.length
    ? quantityAnnotationExtensions(coding.extension, "r5") as FhirExtension[] : coding.extension;
  let result = extension === coding.extension ? coding : { ...coding, extension };
  for (const field of ["_system", "_version", "_code", "_display", "_userSelected"] as const) {
    const primitive = quantityPrimitiveForR5(coding[field]);
    if (primitive === coding[field]) continue;
    if (result === coding) result = { ...coding };
    result[field] = primitive;
  }
  return result as FhirCoding;
}

/** Preserve the complete supplied concept while projecting its known annotations. */
function spatialConceptForR5(concept: FhirR6CodeableConcept): FhirCodeableConcept {
  let coding: FhirR6Coding[] | undefined;
  for (let index = 0; index < (concept.coding?.length ?? 0); index++) {
    const current = spatialCodingForR5(concept.coding![index])!;
    if (current !== concept.coding![index]) coding ??= concept.coding!.slice(0, index);
    coding?.push(current);
  }
  const extension = concept.extension ? quantityAnnotationExtensions(concept.extension, "r5") : undefined;
  const text = quantityPrimitiveForR5(concept._text);
  return (!coding && extension === concept.extension && text === concept._text ? concept : {
    ...concept,
    ...(coding ? { coding } : {}),
    ...(extension !== concept.extension ? { extension } : {}),
    ...(text !== concept._text ? { _text: text } : {})
  }) as FhirCodeableConcept;
}

function bodySiteCodingToFhir(coding: BodySiteCode | undefined): FhirCoding | undefined {
  if (!coding?.code) {
    return undefined;
  }
  const source: FhirCoding = coding;
  const defaultSystem = source.system === undefined && source._system === undefined;
  if (!coding.i18n) return defaultSystem ? { ...coding, system: SNOMED_SYSTEM } : coding;
  const { i18n, ...wire } = source;
  if (defaultSystem) wire.system = SNOMED_SYSTEM;
  wire._display = mergeTranslationPrimitiveElement(wire._display, i18n);
  return wire;
}

/** Top-level and nested sites share the existing anatomical Coding preference. */
export function selectPreferredSiteCoding<TCoding extends FhirR6Coding>(
  site: { coding?: TCoding[] } | undefined
): TCoding | undefined {
  let first: TCoding | undefined;
  for (const coding of site?.coding ?? []) {
    if (!coding.code) continue;
    if (coding.system === SNOMED_SYSTEM) return coding;
    first ??= coding;
  }
  return first;
}

export function cloneBodySiteSpatialRelation(
  relation: BodySiteSpatialRelation | undefined
): BodySiteSpatialRelation | undefined {
  if (!relation) {
    return undefined;
  }
  const coding = relation.relationCoding;
  const target = relation.targetCoding;
  // Allocate the ordinary relation and Coding shells together. Additional
  // supplied Coding fields are copied into that shell in the same traversal;
  // only standard child annotations need detachment.
  const cloned: BodySiteSpatialRelation = {
    relationText: relation.relationText,
    relationCoding: coding
      ? { system: coding.system, code: coding.code, display: coding.display }
      : undefined,
    targetText: relation.targetText,
    targetCoding: target ? { ...target } : undefined,
    sourceText: relation.sourceText
  };
  if (target && cloned.targetCoding) {
    for (const key in target) {
      if (key !== "system" && key !== "code" && key !== "display")
        copyAdditionalCodingField(cloned.targetCoding, target, key);
    }
  }
  if (cloned.relationCoding) {
    for (const key in coding) {
      if (key !== "system" && key !== "code" && key !== "display") {
        copyAdditionalCodingField(cloned.relationCoding, coding!, key);
      }
    }
  }
  if (relation.targetConcept) {
    const concept = relation.targetConcept;
    const targetConcept = { ...concept };
    if (concept.coding) {
      targetConcept.coding = [];
      for (const source of concept.coding) {
        const current = { ...source };
        for (const key in source)
          if (key !== "system" && key !== "code" && key !== "display")
            copyAdditionalCodingField(current, source, key);
        targetConcept.coding.push(current);
      }
    }
    if (concept.extension) targetConcept.extension = cloneStructuredValue(concept.extension);
    if (concept._text) targetConcept._text = cloneStructuredValue(concept._text);
    cloned.targetConcept = targetConcept;
  }
  if (relation.targetSource) {
    cloned.targetSource = { ...relation.targetSource, valueCodeableConcept: cloned.targetConcept };
    if (relation.targetSource.extension)
      cloned.targetSource.extension = cloneStructuredValue(relation.targetSource.extension);
  }
  return cloned;
}

export function buildBodySiteSpatialRelationExtension(
  relation: BodySiteSpatialRelation | undefined
): FhirExtension | undefined {
  if (!relation) {
    return undefined;
  }
  const children: FhirExtension[] = [];
  const relationCoding = spatialCodingForR5(sharedCodingFields(relation.relationCoding));
  if (relationCoding) {
    children.push({ url: RELATION_URL, valueCoding: relationCoding });
  }
  if (relation.relationText) {
    children.push({ url: RELATION_TEXT_URL, valueString: relation.relationText });
  }
  if (relation.targetConcept) {
    children.push({ ...relation.targetSource, url: TARGET_URL,
      valueCodeableConcept: spatialConceptForR5(relation.targetConcept),
      ...(relation.targetSource?.extension ? {
        extension: quantityAnnotationExtensions(relation.targetSource.extension, "r5")
      } : {}) } as FhirExtension);
    if (relation.targetConcept.text === undefined && relation.targetText !== undefined)
      children.push({ url: TARGET_TEXT_URL, valueString: relation.targetText });
  } else {
    const targetCoding = spatialCodingForR5(bodySiteCodingToFhir(relation.targetCoding));
    if (relation.targetText || targetCoding?.code) {
      const target: FhirCodeableConcept = {};
      if (relation.targetText) target.text = relation.targetText;
      if (targetCoding?.code) target.coding = [targetCoding];
      children.push({ url: TARGET_URL, valueCodeableConcept: target });
    }
  }
  if (relation.sourceText) {
    children.push({ url: SOURCE_TEXT_URL, valueString: relation.sourceText });
  }
  if (!children.length) {
    return undefined;
  }
  return {
    url: BODY_SITE_SPATIAL_RELATION_EXTENSION_URL,
    extension: children
  };
}

export function buildBodySiteSpatialRelationExtensions(
  relation: BodySiteSpatialRelation | undefined
): FhirExtension[] | undefined {
  const extension = buildBodySiteSpatialRelationExtension(relation);
  return extension ? [extension] : undefined;
}

export function parseBodySiteSpatialRelationExtension(
  concept: FhirR6CodeableConcept | undefined
): BodySiteSpatialRelation | undefined {
  const extension = concept?.extension?.find(
    (candidate) => candidate.url === BODY_SITE_SPATIAL_RELATION_EXTENSION_URL
  );
  if (!extension?.extension?.length) {
    return undefined;
  }
  // Decode each field once. The first occurrence owns its field even if
  // that occurrence's value is absent, matching the original import contract.
  let relationNode:FhirR6Extension|undefined,relationTextNode:FhirR6Extension|undefined,
    targetNode:FhirR6Extension|undefined,targetTextNode:FhirR6Extension|undefined,
    sourceNode:FhirR6Extension|undefined;
  for(const node of extension.extension)switch(node.url){
    case RELATION_URL:if(!relationNode)relationNode=node;break;
    case RELATION_TEXT_URL:if(!relationTextNode)relationTextNode=node;break;
    case TARGET_URL:if(!targetNode)targetNode=node;break;
    case TARGET_TEXT_URL:if(!targetTextNode)targetTextNode=node;break;
    case SOURCE_TEXT_URL:if(!sourceNode)sourceNode=node;break;
  }
  const relationCoding=sharedCodingFields(relationNode?.valueCoding);
  const relationText=relationTextNode?.valueString??relationCoding?.display??"";
  const targetConcept=targetNode?.valueCodeableConcept;
  const targetCoding=selectPreferredSiteCoding(targetConcept);
  const targetText=targetConcept?.text??targetTextNode?.valueString;
  const sourceText=sourceNode?.valueString;
  let targetSource: FhirR6Extension | undefined;
  if (targetConcept && targetNode) for (const key in targetNode) {
    if (key !== "url" && key !== "valueCodeableConcept") {
      targetSource = targetNode;
      break;
    }
  }
  const retainedTarget = targetConcept && (targetSource || (targetConcept.coding?.length ?? 0) > 1 ||
    !targetCoding && targetConcept.coding?.length ||
    targetCoding && targetCoding.system === undefined && targetCoding._system === undefined ||
    Object.keys(targetConcept).some(key => key !== "coding" && key !== "text")) ? targetConcept : undefined;
  if (!relationText && !relationCoding && !targetText && !targetCoding?.code && !sourceText && !retainedTarget) {
    return undefined;
  }
  return {
    relationText,
    relationCoding,
    targetText,
    targetCoding: targetCoding?.code
      ? { ...targetCoding, code: targetCoding.code }
      : undefined,
    ...(retainedTarget ? { targetConcept: retainedTarget } : {}),
    ...(targetSource ? { targetSource } : {}),
    sourceText
  };
}
