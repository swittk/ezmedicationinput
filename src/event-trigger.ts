import {
  AdviceFrame,
  AdviceRelation,
  CanonicalAdditionalInstructionExpr,
  CanonicalEventTrigger,
  CanonicalEventTriggerRelation,
  FhirCodeableConcept,
  FhirDosage,
  FhirExtension,
  FhirPeriodUnit,
  FhirQuantity
} from "./types";
import { getAdviceConceptCoding } from "./advice";

export const DOSAGE_CONDITIONS_EXTENSION_URL =
  "http://hl7.org/fhir/StructureDefinition/dosage-conditions";

const WHEN_TRIGGER_SLICE_URL = "whenTrigger";
const TRIGGER_EXTENSION_URL = "trigger";
const OFFSET_EXTENSION_URL = "offset";
export const DOSAGE_CONDITION_RELATIONSHIP_EXTENSION_URL =
  "urn:ezmedicationinput:dosage-condition-relationship";
export const DOSAGE_CONDITION_TRIGGER_CODE_EXTENSION_URL =
  "urn:ezmedicationinput:dosage-condition-triggerCode";
export const DOSAGE_CONDITION_SOURCE_TEXT_EXTENSION_URL =
  "urn:ezmedicationinput:dosage-condition-sourceText";

function isEventTriggerRelation(
  relation: string | undefined
): relation is CanonicalEventTriggerRelation {
  switch (relation) {
    case AdviceRelation.Before:
    case AdviceRelation.After:
    case AdviceRelation.During:
    case AdviceRelation.On:
    case AdviceRelation.Until:
      return true;
    default:
      return false;
  }
}

function normalizeTriggerKey(trigger: CanonicalEventTrigger): string {
  return `${trigger.relation}|${trigger.anchorText.trim().toLowerCase()}`;
}

function normalizeAnchorText(anchorText: string): string {
  return anchorText.replace(/^(each|every)\s+/i, "").trim();
}

function cloneOffset(
  offset: CanonicalEventTrigger["offset"] | undefined
): CanonicalEventTrigger["offset"] | undefined {
  if (offset?.value === undefined || !offset.unit) {
    return undefined;
  }
  return {
    value: offset.value,
    unit: offset.unit
  };
}

function cloneTrigger(trigger: CanonicalEventTrigger): CanonicalEventTrigger {
  return {
    relation: trigger.relation,
    anchorText: trigger.anchorText,
    triggerCode: cloneCodeableConcept(trigger.triggerCode),
    triggerReference: trigger.triggerReference
      ? {
        reference: trigger.triggerReference.reference,
        type: trigger.triggerReference.type,
        display: trigger.triggerReference.display
      }
      : undefined,
    sourceText: trigger.sourceText,
    offset: cloneOffset(trigger.offset),
    occurrencePolicy: trigger.occurrencePolicy,
    resolutionStatus: trigger.resolutionStatus
  };
}

function cloneCodeableConcept(
  concept: FhirCodeableConcept | undefined
): FhirCodeableConcept | undefined {
  if (!concept?.text && !concept?._text && !concept?.coding?.length) {
    return undefined;
  }
  return {
    text: concept.text,
    _text: concept._text ? { extension: concept._text.extension?.map((extension) => ({ ...extension })) } : undefined,
    coding: concept.coding?.map((coding) => ({
      system: coding.system,
      code: coding.code,
      display: coding.display,
      _display: coding._display ? { extension: coding._display.extension?.map((extension) => ({ ...extension })) } : undefined,
      i18n: coding.i18n ? { ...coding.i18n } : undefined
    }))
  };
}

function parseDurationUnit(quantity: FhirQuantity | undefined): FhirPeriodUnit | undefined {
  const candidate = quantity?.code?.trim().toLowerCase() ?? quantity?.unit?.trim().toLowerCase();
  switch (candidate) {
    case "s":
    case "sec":
    case "second":
    case "seconds":
      return FhirPeriodUnit.Second;
    case "min":
    case "mins":
    case "minute":
    case "minutes":
      return FhirPeriodUnit.Minute;
    case "h":
    case "hr":
    case "hrs":
    case "hour":
    case "hours":
      return FhirPeriodUnit.Hour;
    case "d":
    case "day":
    case "days":
      return FhirPeriodUnit.Day;
    case "wk":
    case "wks":
    case "week":
    case "weeks":
      return FhirPeriodUnit.Week;
    case "mo":
    case "month":
    case "months":
      return FhirPeriodUnit.Month;
    case "a":
    case "yr":
    case "yrs":
    case "year":
    case "years":
      return FhirPeriodUnit.Year;
    default:
      return undefined;
  }
}

function describeDurationUnit(unit: FhirPeriodUnit, value: number): string {
  const plural = Math.abs(value) !== 1;
  switch (unit) {
    case FhirPeriodUnit.Second:
      return plural ? "seconds" : "second";
    case FhirPeriodUnit.Minute:
      return plural ? "minutes" : "minute";
    case FhirPeriodUnit.Hour:
      return plural ? "hours" : "hour";
    case FhirPeriodUnit.Day:
      return plural ? "days" : "day";
    case FhirPeriodUnit.Week:
      return plural ? "weeks" : "week";
    case FhirPeriodUnit.Month:
      return plural ? "months" : "month";
    case FhirPeriodUnit.Year:
      return plural ? "years" : "year";
    default:
      return unit;
  }
}

function buildOffsetDuration(
  trigger: CanonicalEventTrigger
): FhirQuantity | undefined {
  const offset = trigger.offset;
  if (offset?.value === undefined || !offset.unit) {
    return {
      value: 0,
      unit: "seconds",
      system: "http://unitsofmeasure.org",
      code: FhirPeriodUnit.Second
    };
  }

  const signedValue =
    trigger.relation === AdviceRelation.Before && offset.value > 0
      ? -offset.value
      : offset.value;

  return {
    value: signedValue,
    unit: describeDurationUnit(offset.unit, signedValue),
    system: "http://unitsofmeasure.org",
    code: offset.unit
  };
}

function buildSingleWhenTriggerExtension(
  trigger: CanonicalEventTrigger
): FhirExtension {
  const nested: FhirExtension[] = [];

  if (trigger.triggerReference?.reference || trigger.triggerReference?.display) {
    nested.push({
      url: TRIGGER_EXTENSION_URL,
      valueReference: {
        reference: trigger.triggerReference.reference,
        type: trigger.triggerReference.type,
        display: trigger.triggerReference.display ?? trigger.anchorText
      }
    });
  } else {
    nested.push({
      url: TRIGGER_EXTENSION_URL,
      valueString: trigger.anchorText
    });
  }

  const offsetDuration = buildOffsetDuration(trigger);
  if (offsetDuration) {
    nested.push({
      url: OFFSET_EXTENSION_URL,
      valueDuration: offsetDuration
    });
  }
    nested.push({
      url: DOSAGE_CONDITION_RELATIONSHIP_EXTENSION_URL,
      valueCode: trigger.relation
    });
  if (trigger.triggerCode) {
    nested.push({
      url: DOSAGE_CONDITION_TRIGGER_CODE_EXTENSION_URL,
      valueCodeableConcept: cloneCodeableConcept(trigger.triggerCode)
    });
  }
  if (trigger.sourceText) {
    nested.push({
      url: DOSAGE_CONDITION_SOURCE_TEXT_EXTENSION_URL,
      valueString: trigger.sourceText
    });
  }

  return {
    url: WHEN_TRIGGER_SLICE_URL,
    extension: nested
  };
}

function inferRelationFromInstructionText(
  anchorText: string,
  patientInstruction: string | undefined
): CanonicalEventTriggerRelation {
  const lowerInstruction = patientInstruction?.trim().toLowerCase();
  const lowerAnchor = anchorText.trim().toLowerCase();
  if (lowerInstruction) {
    if (lowerInstruction.includes(`before ${lowerAnchor}`)) {
      return AdviceRelation.Before;
    }
    if (lowerInstruction.includes(`during ${lowerAnchor}`)) {
      return AdviceRelation.During;
    }
    if (lowerInstruction.includes(`on ${lowerAnchor}`)) {
      return AdviceRelation.On;
    }
    if (lowerInstruction.includes(`until ${lowerAnchor}`)) {
      return AdviceRelation.Until;
    }
  }
  return AdviceRelation.After;
}

export function buildEventTriggerFromAdviceFrame(
  frame: AdviceFrame
): CanonicalEventTrigger | undefined {
  if (!isEventTriggerRelation(frame.relation)) {
    return undefined;
  }

  let anchorText: string | undefined;
  let conceptId: string | undefined;
  for (const arg of frame.args) {
    const trimmed = arg.text.trim();
    if (trimmed) {
      anchorText = trimmed;
      conceptId = arg.conceptId;
      break;
    }
  }
  if (!anchorText) {
    return undefined;
  }
  anchorText = normalizeAnchorText(anchorText);
  if (!anchorText) {
    return undefined;
  }

  return {
    relation: frame.relation,
    anchorText,
    triggerCode: conceptId
      ? (() => {
        const coding = getAdviceConceptCoding(conceptId);
        if (!coding) {
          return undefined;
        }
        return {
          text: coding.display ?? anchorText,
          coding: [coding]
        };
      })()
      : undefined,
    triggerReference: undefined,
    sourceText: frame.sourceText.trim() || undefined,
    offset: {
      value: 0,
      unit: FhirPeriodUnit.Second
    },
    occurrencePolicy: "next-occurrence",
    resolutionStatus: "unresolved"
  };
}

export function collectEventTriggersFromAdditionalInstructions(
  instructions: CanonicalAdditionalInstructionExpr[] | undefined
): CanonicalEventTrigger[] | undefined {
  if (!instructions?.length) {
    return undefined;
  }

  const collected: CanonicalEventTrigger[] = [];
  const seen = new Set<string>();

  for (const instruction of instructions) {
    const frames = instruction.frames;
    if (!frames?.length) {
      continue;
    }
    for (const frame of frames) {
      const trigger = buildEventTriggerFromAdviceFrame(frame);
      if (!trigger) {
        continue;
      }
      const key = normalizeTriggerKey(trigger);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      collected.push(trigger);
    }
  }

  return collected.length ? collected : undefined;
}

export function buildEventTriggerInstructionText(
  trigger: CanonicalEventTrigger
): string {
  return `Use ${trigger.relation} ${trigger.anchorText}`.replace(/\s+/g, " ").trim();
}

export function buildEventTriggerInstructionTextList(
  triggers: CanonicalEventTrigger[] | undefined
): string | undefined {
  if (!triggers?.length) {
    return undefined;
  }
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const trigger of triggers) {
    const text = buildEventTriggerInstructionText(trigger);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) {
      continue;
    }
    seen.add(key);
    parts.push(text);
  }
  if (!parts.length) {
    return undefined;
  }
  return parts.join("; ");
}

export function buildDosageConditionExtensions(
  triggers: CanonicalEventTrigger[] | undefined
): FhirExtension[] | undefined {
  if (!triggers?.length) {
    return undefined;
  }

  const nested: FhirExtension[] = [];
  const seen = new Set<string>();
  for (const trigger of triggers) {
    const key = normalizeTriggerKey(trigger);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    nested.push(buildSingleWhenTriggerExtension(trigger));
  }

  if (!nested.length) {
    return undefined;
  }

  return [
    {
      url: DOSAGE_CONDITIONS_EXTENSION_URL,
      extension: nested
    }
  ];
}

export function parseDosageConditionExtensions(
  dosage: Pick<FhirDosage, "extension" | "patientInstruction">
): CanonicalEventTrigger[] | undefined {
  const extensions = dosage.extension;
  if (!extensions?.length) {
    return undefined;
  }

  const triggers: CanonicalEventTrigger[] = [];
  const seen = new Set<string>();

  for (const extension of extensions) {
    if (extension.url !== DOSAGE_CONDITIONS_EXTENSION_URL) {
      continue;
    }
    for (const nested of extension.extension ?? []) {
      if (nested.url !== WHEN_TRIGGER_SLICE_URL) {
        continue;
      }

      let anchorText: string | undefined;
      let triggerCode: FhirCodeableConcept | undefined;
      let triggerReference:
        | {
          reference?: string;
          type?: string;
          display?: string;
        }
        | undefined;
      let offset: CanonicalEventTrigger["offset"] | undefined;
      let relation: CanonicalEventTriggerRelation | undefined;
      let sourceText: string | undefined;

      for (const part of nested.extension ?? []) {
        switch (part.url) {
          case TRIGGER_EXTENSION_URL:
            anchorText =
              part.valueString?.trim() ||
              part.valueReference?.display?.trim() ||
              part.valueReference?.reference?.trim() ||
              undefined;
            if (part.valueReference) {
              triggerReference = {
                reference: part.valueReference.reference,
                type: part.valueReference.type,
                display: part.valueReference.display
              };
            }
            break;
          case OFFSET_EXTENSION_URL: {
            const unit = parseDurationUnit(part.valueDuration);
            const value = part.valueDuration?.value;
            if (value !== undefined && unit) {
              offset = { value, unit };
            }
            break;
          }
          case DOSAGE_CONDITION_RELATIONSHIP_EXTENSION_URL:
            if (isEventTriggerRelation(part.valueCode)) {
              relation = part.valueCode;
            }
            break;
          case DOSAGE_CONDITION_TRIGGER_CODE_EXTENSION_URL:
            triggerCode = cloneCodeableConcept(part.valueCodeableConcept);
            break;
          case DOSAGE_CONDITION_SOURCE_TEXT_EXTENSION_URL:
            sourceText = part.valueString?.trim() || undefined;
            break;
          default:
            break;
        }
      }

      if (!anchorText) {
        continue;
      }

      let resolvedRelation = relation ?? inferRelationFromInstructionText(anchorText, dosage.patientInstruction);
      if (offset?.value !== undefined && offset.value < 0) {
        if (!relation) {
          resolvedRelation = AdviceRelation.Before;
        }
        offset = {
          value: Math.abs(offset.value),
          unit: offset.unit
        };
      } else if (!offset) {
        offset = {
          value: 0,
          unit: FhirPeriodUnit.Second
        };
      }

      const trigger: CanonicalEventTrigger = {
        relation: resolvedRelation,
        anchorText,
        triggerCode,
        triggerReference,
        sourceText,
        offset,
        occurrencePolicy: "next-occurrence",
        resolutionStatus: "unresolved"
      };
      const key = normalizeTriggerKey(trigger);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      triggers.push(trigger);
    }
  }

  return triggers.length ? triggers : undefined;
}

export function hasUnresolvedDosageConditionExtension(
  dosage: Pick<FhirDosage, "extension" | "patientInstruction">
): boolean {
  const triggers = parseDosageConditionExtensions(dosage);
  return Boolean(triggers?.length);
}

export function cloneEventTriggers(
  triggers: CanonicalEventTrigger[] | undefined
): CanonicalEventTrigger[] | undefined {
  if (!triggers?.length) {
    return undefined;
  }
  const cloned: CanonicalEventTrigger[] = [];
  for (const trigger of triggers) {
    cloned.push(cloneTrigger(trigger));
  }
  return cloned;
}

export function cloneDosageExtensions(
  extensions: FhirExtension[] | undefined
): FhirExtension[] | undefined {
  if (!extensions?.length) {
    return undefined;
  }
  const cloned: FhirExtension[] = [];
  for (const extension of extensions) {
    cloned.push({
      url: extension.url,
      extension: cloneDosageExtensions(extension.extension),
      valueCode: extension.valueCode,
      valueString: extension.valueString,
      valueDuration: extension.valueDuration
        ? {
          value: extension.valueDuration.value,
          unit: extension.valueDuration.unit,
          system: extension.valueDuration.system,
          code: extension.valueDuration.code
        }
        : undefined,
      valueCodeableConcept: cloneCodeableConcept(extension.valueCodeableConcept),
      valueReference: extension.valueReference
        ? {
          reference: extension.valueReference.reference,
          type: extension.valueReference.type,
          display: extension.valueReference.display
        }
        : undefined
    });
  }
  return cloned;
}
