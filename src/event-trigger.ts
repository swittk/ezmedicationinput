import {
  AdviceFrame,
  AdviceRelation,
  CanonicalAdditionalInstructionExpr,
  CanonicalEventTrigger,
  CanonicalEventTriggerOccurrencePolicy,
  CanonicalEventTriggerRelation,
  CanonicalEventTriggerResolutionStatus,
  FhirExtension,
  FhirPeriodUnit,
  FhirQuantity,
  FhirTiming
} from "./types";

export const EVENT_RELATIVE_TRIGGER_EXTENSION_URL =
  "https://swittk.github.io/ezmedicationinput/fhir/StructureDefinition/event-relative-trigger";

const TRIGGER_TEXT_EXTENSION_URL = "triggerText";
const RELATIONSHIP_EXTENSION_URL = "relationship";
const OFFSET_DURATION_EXTENSION_URL = "offsetDuration";
const OCCURRENCE_POLICY_EXTENSION_URL = "occurrencePolicy";
const RESOLUTION_STATUS_EXTENSION_URL = "resolutionStatus";
const SOURCE_TEXT_EXTENSION_URL = "sourceText";

const DEFAULT_OCCURRENCE_POLICY: CanonicalEventTriggerOccurrencePolicy = "next-occurrence";
const DEFAULT_RESOLUTION_STATUS: CanonicalEventTriggerResolutionStatus = "unresolved";

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

function isOccurrencePolicy(
  value: string | undefined
): value is CanonicalEventTriggerOccurrencePolicy {
  switch (value) {
    case "next-occurrence":
    case "current-occurrence":
      return true;
    default:
      return false;
  }
}

function isResolutionStatus(
  value: string | undefined
): value is CanonicalEventTriggerResolutionStatus {
  switch (value) {
    case "unresolved":
    case "resolved":
      return true;
    default:
      return false;
  }
}

function normalizeTriggerKey(trigger: CanonicalEventTrigger): string {
  return `${trigger.relation}|${trigger.anchorText.trim().toLowerCase()}`;
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
    sourceText: trigger.sourceText,
    offset: cloneOffset(trigger.offset),
    occurrencePolicy: trigger.occurrencePolicy,
    resolutionStatus: trigger.resolutionStatus
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

function buildOffsetDuration(
  offset: CanonicalEventTrigger["offset"] | undefined
): FhirQuantity | undefined {
  if (offset?.value === undefined || !offset.unit) {
    return undefined;
  }
  switch (offset.unit) {
    case FhirPeriodUnit.Second:
      return {
        value: offset.value,
        unit: offset.value === 1 ? "second" : "seconds",
        system: "http://unitsofmeasure.org",
        code: offset.unit
      };
    case FhirPeriodUnit.Minute:
      return {
        value: offset.value,
        unit: offset.value === 1 ? "minute" : "minutes",
        system: "http://unitsofmeasure.org",
        code: offset.unit
      };
    case FhirPeriodUnit.Hour:
      return {
        value: offset.value,
        unit: offset.value === 1 ? "hour" : "hours",
        system: "http://unitsofmeasure.org",
        code: offset.unit
      };
    case FhirPeriodUnit.Day:
      return {
        value: offset.value,
        unit: offset.value === 1 ? "day" : "days",
        system: "http://unitsofmeasure.org",
        code: offset.unit
      };
    case FhirPeriodUnit.Week:
      return {
        value: offset.value,
        unit: offset.value === 1 ? "week" : "weeks",
        system: "http://unitsofmeasure.org",
        code: offset.unit
      };
    case FhirPeriodUnit.Month:
      return {
        value: offset.value,
        unit: offset.value === 1 ? "month" : "months",
        system: "http://unitsofmeasure.org",
        code: offset.unit
      };
    case FhirPeriodUnit.Year:
      return {
        value: offset.value,
        unit: offset.value === 1 ? "year" : "years",
        system: "http://unitsofmeasure.org",
        code: offset.unit
      };
    default:
      return undefined;
  }
}

export function buildEventTriggerFromAdviceFrame(
  frame: AdviceFrame
): CanonicalEventTrigger | undefined {
  if (!isEventTriggerRelation(frame.relation)) {
    return undefined;
  }

  let anchorText: string | undefined;
  for (const arg of frame.args) {
    const trimmed = arg.text.trim();
    if (trimmed) {
      anchorText = trimmed;
      break;
    }
  }
  if (!anchorText) {
    return undefined;
  }

  return {
    relation: frame.relation,
    anchorText,
    sourceText: frame.sourceText.trim() || undefined,
    offset: {
      value: 0,
      unit: FhirPeriodUnit.Second
    },
    occurrencePolicy: DEFAULT_OCCURRENCE_POLICY,
    resolutionStatus: DEFAULT_RESOLUTION_STATUS
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

function buildSingleEventTriggerExtension(
  trigger: CanonicalEventTrigger
): FhirExtension {
  const nested: FhirExtension[] = [
    {
      url: TRIGGER_TEXT_EXTENSION_URL,
      valueString: trigger.anchorText
    },
    {
      url: RELATIONSHIP_EXTENSION_URL,
      valueCode: trigger.relation
    },
    {
      url: OCCURRENCE_POLICY_EXTENSION_URL,
      valueCode: trigger.occurrencePolicy ?? DEFAULT_OCCURRENCE_POLICY
    },
    {
      url: RESOLUTION_STATUS_EXTENSION_URL,
      valueCode: trigger.resolutionStatus ?? DEFAULT_RESOLUTION_STATUS
    }
  ];

  const offsetDuration = buildOffsetDuration(trigger.offset);
  if (offsetDuration) {
    nested.push({
      url: OFFSET_DURATION_EXTENSION_URL,
      valueDuration: offsetDuration
    });
  }
  if (trigger.sourceText) {
    nested.push({
      url: SOURCE_TEXT_EXTENSION_URL,
      valueString: trigger.sourceText
    });
  }

  return {
    url: EVENT_RELATIVE_TRIGGER_EXTENSION_URL,
    extension: nested
  };
}

export function buildEventTriggerExtensions(
  triggers: CanonicalEventTrigger[] | undefined
): FhirExtension[] | undefined {
  if (!triggers?.length) {
    return undefined;
  }
  const extensions: FhirExtension[] = [];
  const seen = new Set<string>();
  for (const trigger of triggers) {
    const key = normalizeTriggerKey(trigger);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    extensions.push(buildSingleEventTriggerExtension(trigger));
  }
  return extensions.length ? extensions : undefined;
}

export function parseEventTriggerExtensions(
  timing: FhirTiming | undefined
): CanonicalEventTrigger[] | undefined {
  const extensions = timing?.extension;
  if (!extensions?.length) {
    return undefined;
  }

  const triggers: CanonicalEventTrigger[] = [];
  const seen = new Set<string>();

  for (const extension of extensions) {
    if (extension.url !== EVENT_RELATIVE_TRIGGER_EXTENSION_URL) {
      continue;
    }

    let anchorText: string | undefined;
    let relation: CanonicalEventTriggerRelation | undefined;
    let sourceText: string | undefined;
    let occurrencePolicy: CanonicalEventTriggerOccurrencePolicy | undefined;
    let resolutionStatus: CanonicalEventTriggerResolutionStatus | undefined;
    let offset: CanonicalEventTrigger["offset"] | undefined;

    for (const nested of extension.extension ?? []) {
      switch (nested.url) {
        case TRIGGER_TEXT_EXTENSION_URL:
          anchorText = nested.valueString?.trim() || undefined;
          break;
        case RELATIONSHIP_EXTENSION_URL:
          if (isEventTriggerRelation(nested.valueCode)) {
            relation = nested.valueCode;
          }
          break;
        case OCCURRENCE_POLICY_EXTENSION_URL:
          if (isOccurrencePolicy(nested.valueCode)) {
            occurrencePolicy = nested.valueCode;
          }
          break;
        case RESOLUTION_STATUS_EXTENSION_URL:
          if (isResolutionStatus(nested.valueCode)) {
            resolutionStatus = nested.valueCode;
          }
          break;
        case SOURCE_TEXT_EXTENSION_URL:
          sourceText = nested.valueString?.trim() || undefined;
          break;
        case OFFSET_DURATION_EXTENSION_URL: {
          const unit = parseDurationUnit(nested.valueDuration);
          const value = nested.valueDuration?.value;
          if (value !== undefined && unit) {
            offset = { value, unit };
          }
          break;
        }
        default:
          break;
      }
    }

    if (!anchorText || !relation) {
      continue;
    }

    const trigger: CanonicalEventTrigger = {
      relation,
      anchorText,
      sourceText,
      offset,
      occurrencePolicy: occurrencePolicy ?? DEFAULT_OCCURRENCE_POLICY,
      resolutionStatus: resolutionStatus ?? DEFAULT_RESOLUTION_STATUS
    };
    const key = normalizeTriggerKey(trigger);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    triggers.push(trigger);
  }

  return triggers.length ? triggers : undefined;
}

export function hasUnresolvedEventTriggerExtension(
  timing: FhirTiming | undefined
): boolean {
  const triggers = parseEventTriggerExtensions(timing);
  if (!triggers?.length) {
    return false;
  }
  for (const trigger of triggers) {
    if ((trigger.resolutionStatus ?? DEFAULT_RESOLUTION_STATUS) !== "resolved") {
      return true;
    }
  }
  return false;
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
