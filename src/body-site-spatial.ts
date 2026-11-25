import {
  BodySiteCode,
  BodySiteSpatialRelation,
  FhirCodeableConcept,
  FhirCoding,
  FhirExtension
} from "./types";
import { cloneStructuredValue } from "./stable-structure";
import { mergeTranslationPrimitiveElement } from "./fhir-translations";

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
function copyAdditionalCodingField(target: FhirCoding, source: FhirCoding, key: string): void {
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
function sharedCodingFields(coding:FhirCoding|undefined):FhirCoding|undefined {
  // Output values are immutable by caller contract. Keep existing coding
  // identity (including source annotations) rather than allocating a second
  // coding shell solely to protect a caller from mutating its result.
  return coding?.code ? coding : undefined;
}

function bodySiteCodingToFhir(coding: BodySiteCode | undefined): FhirCoding | undefined {
  if (!coding?.code) {
    return undefined;
  }
  if (!coding.i18n) return coding.system !== undefined ? coding : { ...coding, system: SNOMED_SYSTEM };
  const { i18n, ...wire } = coding as FhirCoding;
  return { ...wire, system: coding.system ?? SNOMED_SYSTEM,
    _display: mergeTranslationPrimitiveElement(wire._display, i18n) };
}

function firstCodingWithCode(concept: FhirCodeableConcept | undefined): FhirCoding | undefined {
  return concept?.coding?.find((coding) => Boolean(coding.code));
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
  return cloned;
}

export function buildBodySiteSpatialRelationExtension(
  relation: BodySiteSpatialRelation | undefined
): FhirExtension | undefined {
  if (!relation) {
    return undefined;
  }
  const children: FhirExtension[] = [];
  const relationCoding = sharedCodingFields(relation.relationCoding);
  if (relationCoding?.code) {
    children.push({ url: RELATION_URL, valueCoding: relationCoding });
  }
  if (relation.relationText) {
    children.push({ url: RELATION_TEXT_URL, valueString: relation.relationText });
  }
  const targetCoding = bodySiteCodingToFhir(relation.targetCoding);
  if (relation.targetText || targetCoding?.code) {
    const target: FhirCodeableConcept = {};
    if (relation.targetText) {
      target.text = relation.targetText;
    }
    if (targetCoding?.code) {
      target.coding = [targetCoding];
    }
    children.push({ url: TARGET_URL, valueCodeableConcept: target });
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
  concept: FhirCodeableConcept | undefined
): BodySiteSpatialRelation | undefined {
  const extension = concept?.extension?.find(
    (candidate) => candidate.url === BODY_SITE_SPATIAL_RELATION_EXTENSION_URL
  );
  if (!extension?.extension?.length) {
    return undefined;
  }
  // Decode each field once. The first occurrence owns its field even if
  // that occurrence's value is absent, matching the original import contract.
  let relationNode:FhirExtension|undefined,relationTextNode:FhirExtension|undefined,
    targetNode:FhirExtension|undefined,targetTextNode:FhirExtension|undefined,
    sourceNode:FhirExtension|undefined;
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
  const targetCoding=firstCodingWithCode(targetConcept);
  const targetText=targetConcept?.text??targetTextNode?.valueString;
  const sourceText=sourceNode?.valueString;
  if (!relationText && !relationCoding?.code && !targetText && !targetCoding?.code && !sourceText) {
    return undefined;
  }
  return {
    relationText,
    relationCoding,
    targetText,
    targetCoding: targetCoding?.code
      ? { ...targetCoding, code: targetCoding.code }
      : undefined,
    sourceText
  };
}
