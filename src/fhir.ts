import { formatInternal } from "./format";
import { ParsedSigInternal } from "./internal-types";
import { ROUTE_BY_SNOMED, ROUTE_SNOMED, ROUTE_TEXT } from "./maps";
import {
  EventTiming,
  FhirCodeableConcept,
  FhirDosage,
  FhirTimingRepeat,
  SNOMEDCTRouteCodes
} from "./types";
import { objectValues } from "./utils/object";
import { arrayIncludes } from "./utils/array";

const SNOMED_SYSTEM = "http://snomed.info/sct";

export function toFhir(internal: ParsedSigInternal): FhirDosage {
  const dosage: FhirDosage = {};
  const repeat: FhirTimingRepeat = {};
  let hasRepeat = false;

  if (internal.frequency !== undefined) {
    repeat.frequency = internal.frequency;
    hasRepeat = true;
  }
  if (internal.count !== undefined) {
    repeat.count = internal.count;
    hasRepeat = true;
  }
  if (internal.frequencyMax !== undefined) {
    repeat.frequencyMax = internal.frequencyMax;
    hasRepeat = true;
  }
  if (internal.period !== undefined && internal.periodUnit) {
    repeat.period = internal.period;
    repeat.periodUnit = internal.periodUnit;
    hasRepeat = true;
  }
  if (internal.periodMax !== undefined) {
    repeat.periodMax = internal.periodMax;
    hasRepeat = true;
  }
  if (internal.dayOfWeek.length) {
    repeat.dayOfWeek = [...internal.dayOfWeek];
    hasRepeat = true;
  }
  if (internal.when.length) {
    repeat.when = [...internal.when];
    hasRepeat = true;
  }

  if (hasRepeat) {
    dosage.timing = { repeat };
  } else {
    dosage.timing = {};
  }

  if (internal.timingCode) {
    dosage.timing = dosage.timing ?? {};
    dosage.timing.code = {
      coding: [{ code: internal.timingCode }],
      text: internal.timingCode
    };
  }

  if (internal.doseRange) {
    dosage.doseAndRate = [
      {
        doseRange: {
          low:
            internal.doseRange.low !== undefined
              ? { value: internal.doseRange.low, unit: internal.unit }
              : undefined,
          high:
            internal.doseRange.high !== undefined
              ? { value: internal.doseRange.high, unit: internal.unit }
              : undefined
        }
      }
    ];
  } else if (internal.dose !== undefined) {
    dosage.doseAndRate = [
      {
        doseQuantity: {
          value: internal.dose,
          unit: internal.unit
        }
      }
    ];
  }

  // Emit SNOMED-coded routes whenever we have parsed or inferred route data.
  if (internal.routeCode || internal.routeText) {
    const coding = internal.routeCode ? ROUTE_SNOMED[internal.routeCode] : undefined;
    const text =
      internal.routeText ??
      (internal.routeCode ? ROUTE_TEXT[internal.routeCode] : undefined);

    if (coding) {
      // Provide both text and coding so human-readable and coded systems align.
      dosage.route = {
        text,
        coding: [
          {
            system: SNOMED_SYSTEM,
            code: coding.code,
            display: coding.display
          }
        ]
      };
    } else if (text) {
      dosage.route = { text };
    }
  }

  if (internal.siteText || internal.siteCoding?.code) {
    const coding = internal.siteCoding?.code
      ? [
          {
            system: internal.siteCoding.system ?? SNOMED_SYSTEM,
            code: internal.siteCoding.code,
            display: internal.siteCoding.display
          }
        ]
      : undefined;
    dosage.site = {
      text: internal.siteText,
      coding
    };
  }

  if (internal.additionalInstructions?.length) {
    dosage.additionalInstruction = internal.additionalInstructions.map((instruction) => ({
      text: instruction.text,
      coding: instruction.coding?.code
        ? [
            {
              system: instruction.coding.system ?? SNOMED_SYSTEM,
              code: instruction.coding.code,
              display: instruction.coding.display
            }
          ]
        : undefined
    }));
  }

  if (internal.asNeeded) {
    dosage.asNeededBoolean = true;
    if (internal.asNeededReason || internal.asNeededReasonCoding?.code) {
      const concept: FhirCodeableConcept = {};
      if (internal.asNeededReason) {
        concept.text = internal.asNeededReason;
      }
      if (internal.asNeededReasonCoding?.code) {
        concept.coding = [
          {
            system: internal.asNeededReasonCoding.system ?? SNOMED_SYSTEM,
            code: internal.asNeededReasonCoding.code,
            display: internal.asNeededReasonCoding.display
          }
        ];
      }
      dosage.asNeededFor = [concept];
    }
  }

  const longText = formatInternal(internal, "long");
  if (longText) {
    dosage.text = longText;
  }

  return dosage;
}

export function internalFromFhir(dosage: FhirDosage): ParsedSigInternal {
  const internal: ParsedSigInternal = {
    input: dosage.text ?? "",
    tokens: [],
    consumed: new Set(),
    dayOfWeek: dosage.timing?.repeat?.dayOfWeek
      ? [...dosage.timing.repeat.dayOfWeek]
      : [],
    when: dosage.timing?.repeat?.when
      ? dosage.timing.repeat.when.filter((value): value is EventTiming =>
          arrayIncludes(
            objectValues(EventTiming) as EventTiming[],
            value as EventTiming
          )
        )
      : [],
    warnings: [],
    timingCode: dosage.timing?.code?.coding?.[0]?.code,
    count: dosage.timing?.repeat?.count,
    frequency: dosage.timing?.repeat?.frequency,
    frequencyMax: dosage.timing?.repeat?.frequencyMax,
    period: dosage.timing?.repeat?.period,
    periodMax: dosage.timing?.repeat?.periodMax,
    periodUnit: dosage.timing?.repeat?.periodUnit,
    routeText: dosage.route?.text,
    siteText: dosage.site?.text,
    asNeeded: dosage.asNeededBoolean,
    asNeededReason: dosage.asNeededFor?.[0]?.text,
    siteTokenIndices: new Set(),
    siteLookups: [],
    prnReasonLookups: [],
    additionalInstructions: []
  };

  const routeCoding = dosage.route?.coding?.find((code) => code.system === SNOMED_SYSTEM);
  if (routeCoding?.code) {
    // Translate SNOMED codings back into the simplified enum for round-trip fidelity.
    const mapped = ROUTE_BY_SNOMED[routeCoding.code as SNOMEDCTRouteCodes];
    if (mapped) {
      internal.routeCode = mapped;
      internal.routeText = ROUTE_TEXT[mapped];
    }
  }

  const siteCoding = dosage.site?.coding?.find((code) => code.system === SNOMED_SYSTEM);
  if (siteCoding?.code) {
    internal.siteCoding = {
      code: siteCoding.code,
      display: siteCoding.display,
      system: siteCoding.system
    };
  }

  const reasonCoding = dosage.asNeededFor?.[0]?.coding?.[0];
  if (reasonCoding?.code) {
    internal.asNeededReasonCoding = {
      code: reasonCoding.code,
      display: reasonCoding.display,
      system: reasonCoding.system
    };
  }

  if (dosage.additionalInstruction?.length) {
    internal.additionalInstructions = dosage.additionalInstruction.map((concept) => ({
      text: concept.text,
      coding: concept.coding?.[0]
        ? {
            code: concept.coding[0].code,
            display: concept.coding[0].display,
            system: concept.coding[0].system
          }
        : undefined
    }));
  }


  const doseAndRate = dosage.doseAndRate?.[0];
  if (doseAndRate?.doseRange) {
    const { low, high } = doseAndRate.doseRange;
    if (low?.value !== undefined && high?.value !== undefined) {
      internal.doseRange = { low: low.value, high: high.value };
    }
    internal.unit = low?.unit ?? high?.unit ?? internal.unit;
  } else if (doseAndRate?.doseQuantity) {
    const dose = doseAndRate.doseQuantity;
    if (dose.value !== undefined) {
      internal.dose = dose.value;
    }
    if (dose.unit) {
      internal.unit = dose.unit;
    }
  }

  return internal;
}
