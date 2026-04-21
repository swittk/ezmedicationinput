import { formatCanonicalClause } from "./format";
import { buildCanonicalSigClauses } from "./ir";
import { ParsedSigInternal } from "./internal-types";
import {
  ROUTE_BY_SNOMED,
  ROUTE_SNOMED,
  ROUTE_TEXT,
  findAdditionalInstructionDefinitionByCoding,
  findPrnReasonDefinitionByCoding
} from "./maps";
import {
  CanonicalSigClause,
  EventTiming,
  FhirCodeableConcept,
  FhirDosage,
  FhirTimingRepeat,
  RouteCode,
  SNOMEDCTRouteCodes
} from "./types";
import { objectValues } from "./utils/object";
import { arrayIncludes } from "./utils/array";

const SNOMED_SYSTEM = "http://snomed.info/sct";

function createEmptyCanonicalClause(rawText: string): CanonicalSigClause {
  return {
    kind: "administration",
    rawText,
    raw: {
      start: 0,
      end: rawText.length,
      text: rawText
    },
    leftovers: [],
    evidence: [],
    confidence: 1
  };
}

export function canonicalToFhir(
  clause: CanonicalSigClause,
  textOverride?: string
): FhirDosage {
  const dosage: FhirDosage = {};
  const repeat: FhirTimingRepeat = {};
  let hasRepeat = false;
  const schedule = clause.schedule;

  if (schedule?.frequency !== undefined) {
    repeat.frequency = schedule.frequency;
    hasRepeat = true;
  }
  if (schedule?.count !== undefined) {
    repeat.count = schedule.count;
    hasRepeat = true;
  }
  if (schedule?.frequencyMax !== undefined) {
    repeat.frequencyMax = schedule.frequencyMax;
    hasRepeat = true;
  }
  if (schedule?.period !== undefined && schedule.periodUnit) {
    repeat.period = schedule.period;
    repeat.periodUnit = schedule.periodUnit;
    hasRepeat = true;
  }
  if (schedule?.periodMax !== undefined) {
    repeat.periodMax = schedule.periodMax;
    hasRepeat = true;
  }
  if (schedule?.dayOfWeek?.length) {
    repeat.dayOfWeek = [...schedule.dayOfWeek];
    hasRepeat = true;
  }
  if (schedule?.when?.length) {
    repeat.when = [...schedule.when];
    hasRepeat = true;
  }
  if (schedule?.timeOfDay?.length) {
    repeat.timeOfDay = [...schedule.timeOfDay];
    hasRepeat = true;
  }

  if (hasRepeat) {
    dosage.timing = { repeat };
  } else {
    dosage.timing = {};
  }

  if (schedule?.timingCode) {
    dosage.timing = dosage.timing ?? {};
    dosage.timing.code = {
      coding: [{ code: schedule.timingCode }],
      text: schedule.timingCode
    };
  }

  if (clause.dose?.range) {
    dosage.doseAndRate = [
      {
        doseRange: {
          low: { value: clause.dose.range.low, unit: clause.dose.unit },
          high: { value: clause.dose.range.high, unit: clause.dose.unit }
        }
      }
    ];
  } else if (clause.dose?.value !== undefined) {
    dosage.doseAndRate = [
      {
        doseQuantity: {
          value: clause.dose.value,
          unit: clause.dose.unit
        }
      }
    ];
  }

  if (clause.route?.code || clause.route?.text) {
    const routeCode = clause.route?.code;
    const coding = routeCode ? ROUTE_SNOMED[routeCode] : undefined;
    const text = clause.route?.text ?? (routeCode ? ROUTE_TEXT[routeCode] : undefined);

    if (coding) {
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

  if (clause.site?.text || clause.site?.coding?.code) {
    const coding = clause.site?.coding?.code
      ? [
        {
          system: clause.site.coding.system ?? SNOMED_SYSTEM,
          code: clause.site.coding.code,
          display: clause.site.coding.display
        }
      ]
      : undefined;
    dosage.site = {
      text: clause.site?.text,
      coding
    };
  }

  if (clause.additionalInstructions?.length) {
    dosage.additionalInstruction = [];
    for (const instruction of clause.additionalInstructions) {
      dosage.additionalInstruction.push({
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
      });
    }
  }

  if (clause.prn?.enabled) {
    dosage.asNeededBoolean = true;
    if (clause.prn.reason?.text || clause.prn.reason?.coding?.code) {
      const concept: FhirCodeableConcept = {};
      if (clause.prn.reason?.text) {
        concept.text = clause.prn.reason.text;
      }
      if (clause.prn.reason?.coding?.code) {
        concept.coding = [
          {
            system: clause.prn.reason.coding.system ?? SNOMED_SYSTEM,
            code: clause.prn.reason.coding.code,
            display: clause.prn.reason.coding.display
          }
        ];
      }
      dosage.asNeededFor = [concept];
    }
  }

  const longText = textOverride ?? formatCanonicalClause(clause, "long");
  if (longText) {
    dosage.text = longText;
  }

  return dosage;
}

export function toFhir(internal: ParsedSigInternal): FhirDosage {
  const clauses = buildCanonicalSigClauses(internal);
  const clause = clauses[0] ?? createEmptyCanonicalClause(internal.input);
  return canonicalToFhir(clause);
}

export function canonicalFromFhir(dosage: FhirDosage): CanonicalSigClause {
  const rawText = dosage.text ?? "";
  const clause = createEmptyCanonicalClause(rawText);
  let routeCode: RouteCode | undefined;

  const routeCoding = dosage.route?.coding?.find((code) => code.system === SNOMED_SYSTEM);
  if (routeCoding?.code) {
    routeCode = ROUTE_BY_SNOMED[routeCoding.code as SNOMEDCTRouteCodes];
  }
  if (routeCode || dosage.route?.text) {
    clause.route = {
      code: routeCode,
      text: dosage.route?.text ?? (routeCode ? ROUTE_TEXT[routeCode] : undefined)
    };
  }

  const siteCoding = dosage.site?.coding?.find((code) => code.system === SNOMED_SYSTEM);
  if (dosage.site?.text || siteCoding?.code) {
    clause.site = {
      text: dosage.site?.text,
      coding: siteCoding?.code
        ? {
          code: siteCoding.code,
          display: siteCoding.display,
          system: siteCoding.system
        }
        : undefined,
      source: "text"
    };
  }

  const repeat = dosage.timing?.repeat;
  if (
    dosage.timing?.code?.coding?.[0]?.code ||
    repeat?.count !== undefined ||
    repeat?.frequency !== undefined ||
    repeat?.frequencyMax !== undefined ||
    repeat?.period !== undefined ||
    repeat?.periodMax !== undefined ||
    repeat?.periodUnit ||
    repeat?.dayOfWeek?.length ||
    repeat?.when?.length ||
    repeat?.timeOfDay?.length
  ) {
    clause.schedule = {
      timingCode: dosage.timing?.code?.coding?.[0]?.code,
      count: repeat?.count,
      frequency: repeat?.frequency,
      frequencyMax: repeat?.frequencyMax,
      period: repeat?.period,
      periodMax: repeat?.periodMax,
      periodUnit: repeat?.periodUnit,
      dayOfWeek: repeat?.dayOfWeek ? [...repeat.dayOfWeek] : undefined,
      when: repeat?.when ? [...repeat.when] : undefined,
      timeOfDay: repeat?.timeOfDay ? [...repeat.timeOfDay] : undefined
    };
  }

  const doseAndRate = dosage.doseAndRate?.[0];
  if (doseAndRate?.doseRange) {
    const low = doseAndRate.doseRange.low?.value;
    const high = doseAndRate.doseRange.high?.value;
    if (low !== undefined && high !== undefined) {
      clause.dose = {
        range: { low, high },
        unit: doseAndRate.doseRange.low?.unit ?? doseAndRate.doseRange.high?.unit
      };
    }
  } else if (doseAndRate?.doseQuantity?.value !== undefined) {
    clause.dose = {
      value: doseAndRate.doseQuantity.value,
      unit: doseAndRate.doseQuantity.unit
    };
  }

  const reasonCoding = dosage.asNeededFor?.[0]?.coding?.find((code) => Boolean(code.code));
  if (dosage.asNeededBoolean || dosage.asNeededFor?.[0]?.text || reasonCoding?.code) {
    clause.prn = {
      enabled: Boolean(dosage.asNeededBoolean || dosage.asNeededFor?.[0]?.text || reasonCoding?.code),
      reason:
        dosage.asNeededFor?.[0]?.text || reasonCoding?.code
          ? {
            text: dosage.asNeededFor?.[0]?.text,
            coding: reasonCoding?.code
              ? {
                code: reasonCoding.code,
                display: reasonCoding.display,
                system: reasonCoding.system
              }
              : undefined
          }
          : undefined
    };
  }

  if (dosage.additionalInstruction?.length) {
    clause.additionalInstructions = [];
    for (const instruction of dosage.additionalInstruction) {
      const coding = instruction.coding?.find((code) => Boolean(code.code));
      clause.additionalInstructions.push({
        text: instruction.text,
        coding: coding?.code
          ? {
            code: coding.code,
            display: coding.display,
            system: coding.system
          }
          : undefined
      });
    }
  }

  return clause;
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
    timeOfDay: dosage.timing?.repeat?.timeOfDay
      ? [...dosage.timing.repeat.timeOfDay]
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
    const defaultDef = findPrnReasonDefinitionByCoding(
      reasonCoding.system ?? SNOMED_SYSTEM,
      reasonCoding.code
    );
    internal.asNeededReasonCoding = {
      code: reasonCoding.code,
      display: reasonCoding.display,
      system: reasonCoding.system,
      i18n: defaultDef?.i18n
    };
  }

  if (dosage.additionalInstruction?.length) {
    internal.additionalInstructions = dosage.additionalInstruction.map((concept) => {
      const coding = concept.coding?.[0];
      const defaultDef = coding?.code
        ? findAdditionalInstructionDefinitionByCoding(
          coding.system ?? SNOMED_SYSTEM,
          coding.code
        )
        : undefined;

      return {
        text: concept.text,
        coding: coding?.code
          ? {
            code: coding.code,
            display: coding.display,
            system: coding.system,
            i18n: defaultDef?.i18n
          }
          : undefined
      };
    });
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
